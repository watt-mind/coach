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

  it('normalizes an existing secret-bearing 503 rejection', async () => {
    mockLogWebhookRequest.mockRejectedValueOnce(
      Object.assign(new Error('secret-token'), {
        statusCode: 503,
        statusMessage: 'secret-token',
        data: { token: 'secret-token' }
      })
    )
    const handler = await getHandler()
    const failure = await handler(buildEvent() as any).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      statusCode: 503,
      statusMessage: 'Garmin delivery not persisted'
    })
    expect(String(failure)).not.toContain('secret-token')
    expect(JSON.stringify(failure)).not.toContain('secret-token')
  })

  it('returns generic 503 through the real logger when database insertion rejects', async () => {
    mockLogWebhookRequest.mockImplementation(await getRealLogger())
    webhookLogCreate.mockRejectedValueOnce(new Error('connection refused: secret-token'))
    const handler = await getHandler()
    const failure = await handler(buildEvent() as any).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      statusCode: 503,
      statusMessage: 'Garmin delivery not persisted'
    })
    expect(JSON.stringify(failure)).not.toContain('secret-token')
    expect(webhookLogCreate).toHaveBeenCalledTimes(1)
    expect(webhookLogCreate.mock.calls[0]![0]).toMatchObject({
      data: expect.objectContaining({ provider: 'garmin', status: 'PENDING' })
    })
  })

  it('waits for the real logger database insertion before acknowledging success', async () => {
    mockLogWebhookRequest.mockImplementation(await getRealLogger())
    let finish!: (row: any) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    webhookLogCreate.mockImplementationOnce(() => {
      entered()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const handler = await getHandler()
    let acknowledged = false
    const result = handler(buildEvent() as any).then((value: unknown) => {
      acknowledged = true
      return value
    })
    await started
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    finish({ id: 'log-1', provider: 'garmin', status: 'PENDING' })
    await expect(result).resolves.toEqual({ success: true })
    expect(webhookLogCreate).toHaveBeenCalledTimes(1)
  })
})
