import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../../../server/utils/db'
import { getResend } from '../../../../../server/utils/email'
import { EmailDeliveryService } from '../../../../../server/utils/services/emailDeliveryService'

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    emailSuppression: { findFirst: vi.fn() },
    emailDelivery: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn()
    }
  }
}))
vi.mock('../../../../../server/utils/email', () => ({
  getResend: vi.fn(() => ({ emails: { send: vi.fn() } }))
}))

describe('dispatch consent revalidation', () => {
  let row: any
  let user: any
  let suppression: any
  const send = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    row = {
      id: 'delivery-1',
      userId: 'user-1',
      toEmail: 'destination@example.com',
      templateKey: 'WorkoutAnalysisReady',
      audience: 'ENGAGEMENT',
      status: 'QUEUED',
      htmlBody: '<p>Hello</p>',
      subject: 'Hello'
    }
    user = {
      id: 'user-1',
      email: 'current@example.com',
      emailStatus: 'VALID',
      emailPreferences: [{ channel: 'EMAIL', globalUnsubscribe: false, workoutAnalysis: true }]
    }
    suppression = null
    vi.mocked(prisma.emailDelivery.findUnique).mockImplementation(async () => ({ ...row }))
    vi.mocked(prisma.user.findUnique).mockImplementation(async () => user)
    vi.mocked(prisma.emailSuppression.findFirst).mockImplementation(async () => suppression)
    vi.mocked(prisma.emailDelivery.updateMany).mockImplementation(async ({ data }: any) => {
      Object.assign(row, data)
      return { count: 1 }
    })
    vi.mocked(prisma.emailDelivery.update).mockImplementation(async ({ data }: any) => {
      Object.assign(row, data)
      return { ...row }
    })
    send.mockResolvedValue({ data: { id: 'provider-1' }, error: null })
    vi.mocked(getResend).mockReturnValue({ emails: { send } } as any)
    vi.stubEnv('INTERNAL_API_TOKEN', 'test-token')
    vi.stubEnv('NUXT_AUTH_SECRET', 'test-secret')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ html: '<p>Hello</p>', text: 'Hello' })
      }))
    )
  })

  for (const status of ['QUEUED', 'FAILED']) {
    for (const gate of ['global', 'template', 'status', 'suppression']) {
      it(`suppresses ${status} after ${gate} changes following queueing`, async () => {
        vi.stubEnv('DISABLE_EMAILS', 'true')
        vi.mocked(prisma.emailDelivery.create).mockImplementation(async ({ data }: any) => {
          Object.assign(row, data)
          return { ...row }
        })
        const queued = await EmailDeliveryService.runSendEmail({
          userId: user.id,
          toEmail: row.toEmail,
          templateKey: row.templateKey,
          audience: row.audience,
          eventKey: 'test',
          subject: row.subject,
          props: { workoutTitle: 'Ride', workoutId: 'workout-1' }
        })
        expect(queued?.status).toBe('QUEUED')
        expect(send).not.toHaveBeenCalled()
        row.status = status
        if (gate === 'global') user.emailPreferences[0].globalUnsubscribe = true
        if (gate === 'template') user.emailPreferences[0].workoutAnalysis = false
        if (gate === 'status') user.emailStatus = 'BOUNCED'
        if (gate === 'suppression') suppression = { active: true }
        const result = await EmailDeliveryService.dispatch(row.id)
        expect(result.status).toBe('SUPPRESSED')
        expect(result.errorMessage).toBeTruthy()
        expect(result.errorMessage).not.toContain('@')
        expect(send).not.toHaveBeenCalled()
        expect(prisma.emailSuppression.findFirst).toHaveBeenLastCalledWith({
          where: { email: 'destination@example.com', active: true }
        })
      })
    }
  }

  it('looks up address-only recipients and checks their preferences', async () => {
    row.userId = null
    user.emailPreferences[0].globalUnsubscribe = true
    expect((await EmailDeliveryService.dispatch(row.id)).status).toBe('SUPPRESSED')
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: row.toEmail },
      include: { emailPreferences: true }
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('suppresses an address with no matching user', async () => {
    row.userId = null
    user = null
    suppression = { active: true }
    expect((await EmailDeliveryService.dispatch(row.id)).status).toBe('SUPPRESSED')
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['ENGAGEMENT', 'MARKETING', 'TRANSACTIONAL'])(
    'sends eligible %s with delivery idempotency',
    async (audience) => {
      row.audience = audience
      if (audience === 'TRANSACTIONAL') {
        user.emailStatus = 'BOUNCED'
        user.emailPreferences[0].globalUnsubscribe = true
        user.emailPreferences[0].workoutAnalysis = false
        suppression = { active: true }
      }
      expect((await EmailDeliveryService.dispatch(row.id)).status).toBe('SENT')
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: row.toEmail }), {
        idempotencyKey: row.id
      })
    }
  )

  it('does not send or suppress when another dispatcher wins the lock', async () => {
    vi.mocked(prisma.emailDelivery.updateMany).mockResolvedValue({ count: 0 })
    await expect(EmailDeliveryService.dispatch(row.id)).rejects.toThrow('already being sent')
    expect(prisma.emailDelivery.update).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['SENT', 'SUPPRESSED', 'SENDING'])('protects %s deliveries', async (status) => {
    row.status = status
    await expect(EmailDeliveryService.dispatch(row.id)).rejects.toThrow('not in a sendable state')
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    [429, true],
    [503, true],
    [422, false]
  ])('preserves retry classification for %s', async (statusCode, retryable) => {
    send.mockResolvedValue({ error: { message: 'Provider failed', statusCode } })
    await expect(EmailDeliveryService.dispatch(row.id)).rejects.toMatchObject({
      name: 'EmailDispatchError',
      retryable
    })
    expect(row.status).toBe('FAILED')
  })

  it('marks network errors failed for retry', async () => {
    send.mockRejectedValue(new Error('Network unavailable'))
    await expect(EmailDeliveryService.dispatch(row.id)).rejects.toThrow('Network unavailable')
    expect(row.status).toBe('FAILED')
  })
})
