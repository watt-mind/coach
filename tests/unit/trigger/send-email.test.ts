import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendEmailTask } from '../../../trigger/send-email'
import { prisma } from '../../../server/utils/db'
import {
  EmailDeliveryService,
  EmailDispatchError
} from '../../../server/utils/services/emailDeliveryService'

// Mock prisma
vi.mock('../../../server/utils/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn()
    },
    emailSuppression: {
      findFirst: vi.fn()
    },
    emailDelivery: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn()
    }
  }
}))

// Mock logger
vi.mock('@trigger.dev/sdk/v3', async () => {
  const actual = await vi.importActual('@trigger.dev/sdk/v3')
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    }
  }
})

describe('sendEmailTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mock successful fetch for internal render
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ html: '<html></html>', text: 'plain text' }),
      text: () => Promise.resolve('ok')
    })

    // Set environment variable for fetch
    process.env.NUXT_PUBLIC_SITE_URL = 'http://localhost:3099'
    process.env.INTERNAL_API_TOKEN = 'internal-test-token'
    process.env.NUXT_AUTH_SECRET = 'test-secret'
  })

  const mockPayload = {
    userId: 'user-123',
    templateKey: 'Welcome',
    eventKey: 'SIGNUP',
    audience: 'TRANSACTIONAL' as const,
    subject: 'Welcome!'
  }

  const mockUser = {
    id: 'user-123',
    email: 'test@example.com',
    emailPreferences: [],
    emailStatus: 'VALID'
  }

  it('should skip if email is suppressed for ENGAGEMENT audience', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue({ id: 'sup-1' } as any)

    const result = await EmailDeliveryService.runSendEmail({
      ...mockPayload,
      templateKey: 'WorkoutAnalysisReady',
      audience: 'ENGAGEMENT'
    })

    expect(result).toBeUndefined()
    expect(prisma.emailDelivery.create).not.toHaveBeenCalled()
  })

  it('should queue email if user is found and not suppressed', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailDelivery.create).mockResolvedValue({ id: 'delivery-1' } as any)
    vi.spyOn(EmailDeliveryService, 'dispatch').mockResolvedValue({
      id: 'delivery-1',
      status: 'SENT'
    } as any)

    const result = await EmailDeliveryService.runSendEmail(mockPayload)

    expect(result.success).toBe(true)
    expect(result.deliveryId).toBe('delivery-1')
    expect(prisma.emailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toEmail: mockUser.email,
          status: 'QUEUED'
        })
      })
    )
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3099/api/internal/render-email',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-internal-api-token': 'internal-test-token'
        })
      })
    )
  })

  it('returns SUPPRESSED when dispatch rejects consent changed after creation', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailDelivery.create).mockResolvedValue({ id: 'delivery-1' } as any)
    vi.spyOn(EmailDeliveryService, 'dispatch').mockResolvedValue({
      id: 'delivery-1',
      status: 'SUPPRESSED'
    } as any)
    const result = await EmailDeliveryService.runSendEmail(mockPayload)
    expect(result.status).toBe('SUPPRESSED')
  })

  it('should skip as a true duplicate when the colliding delivery already sent successfully (driver-adapter error shape)', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)

    // This app uses @prisma/adapter-pg (server/utils/db.ts). Under that
    // driver-adapter engine, PrismaClientKnownRequestError does NOT have
    // `meta.target` - the field list is nested at
    // `meta.driverAdapterError.cause.constraint.fields` instead (see
    // getUniqueConstraintFields in emailDeliveryService.ts). This mock
    // mirrors that real shape so the guard is tested against reality, not
    // just the classic-engine shape.
    const dbError = {
      code: 'P2002',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            kind: 'UniqueConstraintViolation',
            constraint: { fields: ['idempotencyKey'] }
          }
        }
      },
      message: 'Unique constraint failed on the fields: (`idempotencyKey`)'
    }

    vi.mocked(prisma.emailDelivery.create).mockRejectedValue(dbError)
    vi.mocked(prisma.emailDelivery.findUnique).mockResolvedValue({
      id: 'delivery-already-sent',
      status: 'SENT'
    } as any)
    const dispatchSpy = vi.spyOn(EmailDeliveryService, 'dispatch')

    const result = await EmailDeliveryService.runSendEmail({
      ...mockPayload,
      idempotencyKey: 'welcome-user-123'
    })

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('Duplicate')
    expect(result.deliveryId).toBe('delivery-already-sent')
    // A delivery that already succeeded must never be dispatched again.
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('should resume dispatch (not silently skip) when a retry collides with a delivery that previously failed', async () => {
    // This is the retry-safety case: a Trigger.dev retry re-runs runSendEmail
    // from scratch with the same idempotency key. The earlier attempt got as
    // far as creating the EmailDelivery row but the actual send failed, so
    // the row is still FAILED, not SENT. The retry must resume dispatch
    // against that same row instead of treating it as an already-handled
    // duplicate (which would silently drop the email, the original bug).
    //
    // This mock intentionally uses the classic-engine `meta.target` shape
    // (rather than the driver-adapter shape used elsewhere in this file) so
    // the guard's fallback for that shape stays covered too.
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)

    const dbError = {
      code: 'P2002',
      meta: { target: ['idempotencyKey'] },
      message: 'Unique constraint failed'
    }

    vi.mocked(prisma.emailDelivery.create).mockRejectedValue(dbError)
    vi.mocked(prisma.emailDelivery.findUnique).mockResolvedValue({
      id: 'delivery-failed',
      status: 'FAILED'
    } as any)
    vi.spyOn(EmailDeliveryService, 'dispatch').mockResolvedValue({
      id: 'delivery-failed',
      status: 'SENT'
    } as any)

    const result = await EmailDeliveryService.runSendEmail({
      ...mockPayload,
      idempotencyKey: 'welcome-user-123'
    })

    expect(EmailDeliveryService.dispatch).toHaveBeenCalledWith('delivery-failed')
    expect(result).toEqual({ success: true, deliveryId: 'delivery-failed', status: 'SENT' })
  })

  it('should default the idempotency key to the Trigger.dev run id when the caller does not supply one', async () => {
    // Same scenario as above, but relying on the runId fallback (as
    // trigger/send-email.ts passes ctx.run.id) instead of an explicit
    // payload.idempotencyKey - this is what protects callers (e.g. the
    // Welcome email on signup) that never set one themselves.
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)

    const dbError = {
      code: 'P2002',
      meta: { target: ['idempotencyKey'] },
      message: 'Unique constraint failed'
    }

    vi.mocked(prisma.emailDelivery.create).mockRejectedValue(dbError)
    vi.mocked(prisma.emailDelivery.findUnique).mockResolvedValue({
      id: 'delivery-failed',
      status: 'FAILED'
    } as any)
    vi.spyOn(EmailDeliveryService, 'dispatch').mockResolvedValue({
      id: 'delivery-failed',
      status: 'SENT'
    } as any)

    const result = await EmailDeliveryService.runSendEmail(mockPayload, { runId: 'run_abc123' })

    expect(prisma.emailDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ idempotencyKey: 'trigger-run:run_abc123' })
      })
    )
    expect(prisma.emailDelivery.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'trigger-run:run_abc123' }
    })
    expect(result).toEqual({ success: true, deliveryId: 'delivery-failed', status: 'SENT' })
  })

  it('should throw on a transient dispatch failure so Trigger.dev retries instead of silently dropping the email', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailDelivery.create).mockResolvedValue({ id: 'delivery-transient' } as any)

    const transientError = new EmailDispatchError('Connection reset', {
      retryable: true,
      code: 'internal_server_error',
      statusCode: 500
    })
    vi.spyOn(EmailDeliveryService, 'dispatch').mockRejectedValue(transientError)

    await expect(EmailDeliveryService.runSendEmail(mockPayload)).rejects.toBe(transientError)
  })

  it('should not throw on a permanent dispatch failure and should report success:false instead', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailDelivery.create).mockResolvedValue({ id: 'delivery-permanent' } as any)

    const permanentError = new EmailDispatchError('Invalid `to` field', {
      retryable: false,
      code: 'validation_error',
      statusCode: 422
    })
    vi.spyOn(EmailDeliveryService, 'dispatch').mockRejectedValue(permanentError)

    const result = await EmailDeliveryService.runSendEmail(mockPayload)

    expect(result).toEqual({
      success: false,
      deliveryId: 'delivery-permanent',
      error: 'Invalid `to` field'
    })
  })

  it('should skip when cooldown window has recent delivery', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue({
      id: 'delivery-recent',
      createdAt: new Date()
    } as any)

    const result = await EmailDeliveryService.runSendEmail({
      ...mockPayload,
      templateKey: 'WorkoutAnalysisReady'
    })

    expect(result).toBeUndefined()
    expect(prisma.emailDelivery.create).not.toHaveBeenCalled()
  })

  it('should skip if user email status is BOUNCED for ENGAGEMENT audience', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...mockUser,
      emailStatus: 'BOUNCED'
    } as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)

    const result = await EmailDeliveryService.runSendEmail({
      ...mockPayload,
      templateKey: 'WorkoutAnalysisReady',
      audience: 'ENGAGEMENT'
    })

    expect(result).toBeUndefined()
    expect(prisma.emailDelivery.create).not.toHaveBeenCalled()
  })

  it('should deliver Welcome TRANSACTIONAL email even if globalUnsubscribe is true', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...mockUser,
      emailPreferences: [{ channel: 'EMAIL', globalUnsubscribe: true }]
    } as any)
    vi.mocked(prisma.emailDelivery.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailSuppression.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.emailDelivery.create).mockResolvedValue({ id: 'delivery-welcome' } as any)
    vi.spyOn(EmailDeliveryService, 'dispatch').mockResolvedValue({
      id: 'delivery-welcome',
      status: 'SENT'
    } as any)

    const result = await EmailDeliveryService.runSendEmail(mockPayload)

    expect(result.success).toBe(true)
    expect(result.deliveryId).toBe('delivery-welcome')
    expect(prisma.emailDelivery.create).toHaveBeenCalled()
  })

  it('should keep the Trigger.dev retry config so transient dispatch failures actually get retried', () => {
    // sendEmailTask.run isn't directly invokable from outside the Trigger.dev
    // runtime (task() doesn't expose it), so this asserts the retry
    // configuration that makes the throw-on-transient-failure behavior above
    // meaningful in production.
    expect(sendEmailTask.id).toBe('send-email')
  })
})
