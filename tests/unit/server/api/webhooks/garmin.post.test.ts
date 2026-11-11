import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', vi.fn())
vi.stubGlobal('readBody', async (event: any) => event?.body)
vi.stubGlobal('getRequestHeaders', (event: any) => event?.headers || {})
vi.stubGlobal('getQuery', (event: any) => event?.query || {})
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message || err.statusMessage)
  // @ts-expect-error test helper property
  error.statusCode = err.statusCode
  // @ts-expect-error test helper property
  error.statusMessage = err.statusMessage
  return error
})

const webhookLogCreate = vi.fn()
const mockLogWebhookRequest = vi.fn()

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    webhookLog: {
      create: (...args: unknown[]) => webhookLogCreate(...args)
    }
  }
}))

vi.mock('../../../../../server/utils/webhook-logger', () => ({
  logWebhookRequest: (...args: unknown[]) => mockLogWebhookRequest(...args)
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/webhooks/garmin.post')
  return mod.default
}

const getRealLogger = async () => {
  const mod = await vi.importActual<typeof import('../../../../../server/utils/webhook-logger')>(
    '../../../../../server/utils/webhook-logger'
  )
  return mod.logWebhookRequest
}

const buildEvent = (overrides: Record<string, any> = {}) => ({
  body: {
    activities: [{ activityId: 12345, activityName: 'Morning Run' }]
  },
  headers: { 'x-garmin-test': 'true' },
  query: { token: 'abc' },
  ...overrides
})

describe('POST /api/webhooks/garmin (CW-836)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLogWebhookRequest.mockImplementation(async (data: any) => ({ id: 'log-1', ...data }))
  })

  it('acknowledges only after a persisted PENDING Garmin PUSH row', async () => {
    const handler = await getHandler()

    const result = await handler(buildEvent() as any)

    expect(result).toEqual({ success: true })
    expect(mockLogWebhookRequest).toHaveBeenCalledTimes(1)
    expect(mockLogWebhookRequest.mock.calls[0]![0]).toMatchObject({
      provider: 'garmin',
      eventType: 'PUSH',
      status: 'PENDING',
      payload: { activities: [{ activityId: 12345, activityName: 'Morning Run' }] },
      headers: { 'x-garmin-test': 'true' },
      query: { token: 'abc' }
    })
  })

  it('returns 503 when the logger resolves null (no false success)', async () => {
    mockLogWebhookRequest.mockResolvedValue(null)
    const handler = await getHandler()

    await expect(handler(buildEvent() as any)).rejects.toMatchObject({ statusCode: 503 })

    // The durability gate must never acknowledge without a stored row.
    await expect(handler(buildEvent() as any)).rejects.not.toMatchObject({ success: true })
  })

  it('returns 503 without secrets when the logger rejects', async () => {
    mockLogWebhookRequest.mockRejectedValue(new Error('db down'))
    const handler = await getHandler()

    const failure: any = await handler(buildEvent() as any).catch((err: any) => err)

    expect(failure?.statusCode).toBe(503)
    const serialized = JSON.stringify(failure)
    expect(serialized).not.toContain('Morning Run')
    expect(serialized).not.toContain('x-garmin-test')
    expect(serialized).not.toContain('abc')
  })

  it('real logger maps a rejected DB insertion to null (handler 503 trigger)', async () => {
    const realLogWebhookRequest = await getRealLogger()
    webhookLogCreate.mockRejectedValueOnce(new Error('connection refused'))

    const stored = await realLogWebhookRequest({
      provider: 'garmin',
      eventType: 'PUSH',
      payload: { activities: [] },
      headers: {},
      query: {},
      status: 'PENDING'
    })

    expect(stored).toBeNull()
    expect(webhookLogCreate).toHaveBeenCalledTimes(1)
    expect(webhookLogCreate.mock.calls[0]![0]).toMatchObject({
      data: expect.objectContaining({ provider: 'garmin', status: 'PENDING' })
    })
  })

  it('real logger persists provider/status through to prisma on success', async () => {
    const realLogWebhookRequest = await getRealLogger()
    webhookLogCreate.mockImplementationOnce(async (args: any) => ({ id: 'log-1', ...args.data }))

    const stored: any = await realLogWebhookRequest({
      provider: 'garmin',
      eventType: 'PUSH',
      payload: { activities: [{ activityId: 1 }] },
      headers: { h: '1' },
      query: { q: '1' },
      status: 'PENDING'
    })

    expect(stored).toMatchObject({ id: 'log-1', provider: 'garmin', status: 'PENDING' })
  })
})
