import { describe, it, expect, vi, beforeEach } from 'vitest'

import { prisma } from '../../../../../server/utils/db'
import { getResend } from '../../../../../server/utils/email'
import { getServerSession } from '../../../../../server/utils/session'

// Mock h3 globals BEFORE importing the handler
vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('getRouterParam', (event: any, param: string) => event.context.params[param])
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.statusMessage)
  // @ts-expect-error: mocking internal h3 event
  error.statusCode = err.statusCode
  return error
})

// Mock prisma
vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    emailSuppression: { findFirst: vi.fn() },
    emailDelivery: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    }
  }
}))

vi.mock('../../../../../server/utils/session', () => ({
  getServerSession: vi.fn()
}))

// Mock resend
vi.mock('../../../../../server/utils/email', () => ({
  getResend: vi.fn().mockReturnValue({
    emails: {
      send: vi.fn()
    }
  })
}))

// Use dynamic import to ensure globals are set
const getHandler = async () => {
  const mod = await import('../../../../../server/api/admin/emails/[id]/send.post')
  return mod.default
}

describe('Admin Send Email API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MAIL_FROM_ADDRESS = 'test@coachwatts.com'
  })

  it('should send a queued email successfully', async () => {
    const handler = await getHandler()
    const mockDelivery = {
      id: 'del-1',
      status: 'QUEUED',
      toEmail: 'test@example.com',
      subject: 'Test',
      htmlBody: '<html></html>'
    }

    vi.mocked(getServerSession).mockResolvedValue({ user: { isAdmin: true } } as any)
    vi.mocked(prisma.emailDelivery.findUnique).mockResolvedValue(mockDelivery as any)
    vi.mocked(prisma.emailDelivery.updateMany).mockResolvedValue({ count: 1 } as any)
    vi.mocked(prisma.emailDelivery.update).mockResolvedValue({
      ...mockDelivery,
      status: 'SENT'
    } as any)

    const mockResend = getResend()
    vi.mocked(mockResend!.emails.send).mockResolvedValue({
      data: { id: 'resend-1' },
      error: null
    } as any)

    const event = {
      context: { params: { id: 'del-1' } }
    }

    // @ts-expect-error: mocking internal h3 event
    const result = await handler(event)

    expect(result.success).toBe(true)
    expect(mockResend!.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'test@example.com',
        html: '<html></html>'
      }),
      expect.objectContaining({ idempotencyKey: 'del-1' })
    )
    expect(prisma.emailDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT' })
      })
    )
  })

  it('suppresses Send Now after a queued recipient unsubscribes', async () => {
    const handler = await getHandler()
    vi.mocked(getServerSession).mockResolvedValue({ user: { isAdmin: true } } as any)
    vi.mocked(prisma.emailDelivery.findUnique).mockResolvedValue({
      id: 'del-1',
      status: 'QUEUED',
      userId: 'user-1',
      audience: 'ENGAGEMENT',
      templateKey: 'WorkoutAnalysisReady',
      toEmail: 'test@example.com',
      htmlBody: '<html></html>'
    } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      emailStatus: 'VALID',
      emailPreferences: [{ channel: 'EMAIL', globalUnsubscribe: true }]
    } as any)
    vi.mocked(prisma.emailDelivery.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.emailDelivery.update).mockImplementation(
      async ({ data }: any) =>
        ({
          id: 'del-1',
          ...data
        }) as any
    )
    // @ts-expect-error: mocking internal h3 event
    const result = await handler({ context: { params: { id: 'del-1' } } })
    expect(result.success).toBe(false)
    expect(result.data.status).toBe('SUPPRESSED')
    expect(getResend()!.emails.send).not.toHaveBeenCalled()
  })

  it('should throw error if email is already sent', async () => {
    const handler = await getHandler()
    vi.mocked(getServerSession).mockResolvedValue({ user: { isAdmin: true } } as any)
    vi.mocked(prisma.emailDelivery.findUnique).mockResolvedValue({
      id: 'del-1',
      status: 'SENT'
    } as any)

    const event = { context: { params: { id: 'del-1' } } }

    // @ts-expect-error: mocking internal h3 event
    await expect(handler(event)).rejects.toThrow('not in a sendable state')
  })

  it('should return forbidden for non-admin users', async () => {
    const handler = await getHandler()
    vi.mocked(getServerSession).mockResolvedValue({ user: { isAdmin: false } } as any)

    const event = { context: { params: { id: 'del-1' } } }
    // @ts-expect-error: mocking internal h3 event
    await expect(handler(event)).rejects.toThrow('Forbidden')
  })
})
