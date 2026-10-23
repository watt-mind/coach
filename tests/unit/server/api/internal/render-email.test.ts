import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock h3 globals
vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('readBody', (event: any) => event.body)
vi.stubGlobal('getRequestHeader', (event: any, key: string) => event.headers?.[key])
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.statusMessage)
  // @ts-expect-error: mocking internal h3 event
  error.statusCode = err.statusCode
  // @ts-expect-error: mocking internal h3 event
  error.data = err.data
  return error
})

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: vi.fn().mockResolvedValue({ id: 'user-1' })
}))

// Mock vue-email compiler
vi.mock('@vue-email/compiler', () => ({
  config: vi.fn().mockReturnValue({
    render: vi.fn().mockResolvedValue({ html: '<html></html>', text: 'plain text' })
  })
}))

// Mock path and fs
vi.mock('path', async () => {
  const actual = await vi.importActual('path')
  return { ...actual, resolve: vi.fn().mockImplementation((...args) => args.join('/')) }
})
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true)
  }
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/internal/render-email.post')
  return mod.default
}

describe('Internal Render API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.INTERNAL_API_TOKEN = 'internal-test-token'
  })

  it('should render a template successfully', async () => {
    const handler = await getHandler()
    const event = {
      headers: { 'x-internal-api-token': 'internal-test-token' },
      body: { templateKey: 'Welcome', props: { name: 'John' } }
    }

    const result = await handler(event)

    expect(result.html).toBe('<html></html>')
    expect(result.text).toBe('plain text')
  })

  it('should throw 400 if templateKey is missing', async () => {
    const handler = await getHandler()
    const event = { headers: { 'x-internal-api-token': 'internal-test-token' }, body: {} }

    await expect(handler(event)).rejects.toThrow('templateKey is required')
  })

  it('should reject unauthorized requests', async () => {
    const handler = await getHandler()
    const event = {
      headers: { 'x-internal-api-token': 'wrong-token' },
      body: { templateKey: 'Welcome', props: {} }
    }

    await expect(handler(event)).rejects.toThrow('Unauthorized')
  })

  describe('401 diagnostics (CW-290)', () => {
    const captureRejection = async (event: any) => {
      const handler = await getHandler()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      let thrown: any
      try {
        await handler(event)
      } catch (err) {
        thrown = err
      }

      const calls = errorSpy.mock.calls
      errorSpy.mockRestore()
      return { thrown, calls }
    }

    it('reports a mismatch when both sides hold different tokens', async () => {
      const { thrown, calls } = await captureRejection({
        headers: { 'x-internal-api-token': 'worker-side-token' },
        body: { templateKey: 'Welcome', props: {} }
      })

      expect(thrown.statusCode).toBe(401)
      expect(thrown.data).toEqual({ reason: 'token_mismatch' })

      const [message, diagnostics] = calls[0] as [string, any]
      expect(message).toContain('different INTERNAL_API_TOKEN values')
      expect(diagnostics.reason).toBe('token_mismatch')
      expect(diagnostics.receiverTokenPresent).toBe(true)
      expect(diagnostics.callerTokenPresent).toBe(true)
    })

    it('reports an absent token on the receiver', async () => {
      process.env.INTERNAL_API_TOKEN = ''
      const previousNodeEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'

      const { thrown, calls } = await captureRejection({
        headers: { 'x-internal-api-token': 'worker-side-token' },
        body: { templateKey: 'Welcome', props: {} }
      })

      process.env.NODE_ENV = previousNodeEnv

      expect(thrown.data).toEqual({ reason: 'receiver_token_missing' })
      const [message, diagnostics] = calls[0] as [string, any]
      expect(message).toContain('no INTERNAL_API_TOKEN configured')
      expect(diagnostics.receiverTokenPresent).toBe(false)
      expect(diagnostics.receiverTokenSource).toBe('missing')
    })

    it('withholds the reason from a caller that sent no token, but still logs it', async () => {
      // This route has no middleware or route rule in front of it, so it is
      // reachable anonymously, and nitro's production error handler emits
      // `error.data` for a non-fatal 401. Returning the reason to a caller that
      // presented no token at all would tell an unauthenticated stranger whether
      // this service has INTERNAL_API_TOKEN configured. It grants no access, but
      // it is free to withhold. The worker always sends a token, so it keeps its
      // reason (covered by the two cases above).
      const { thrown, calls } = await captureRejection({
        headers: {},
        body: { templateKey: 'Welcome', props: {} }
      })

      expect(thrown.statusCode).toBe(401)
      expect(thrown.data).toBeUndefined()

      // The operator-facing signal must survive on the server side.
      const [message, diagnostics] = calls[0] as [string, any]
      expect(message).toContain('401 Unauthorized')
      expect(diagnostics.reason).toBe('caller_token_missing')
      expect(diagnostics.callerTokenPresent).toBe(false)
    })

    it('never logs either token value', async () => {
      process.env.INTERNAL_API_TOKEN = 'receiver-plaintext-secret'

      const { calls } = await captureRejection({
        headers: { 'x-internal-api-token': 'caller-plaintext-secret' },
        body: { templateKey: 'Welcome', props: {} }
      })

      const logged = JSON.stringify(calls)
      expect(logged).not.toContain('receiver-plaintext-secret')
      expect(logged).not.toContain('caller-plaintext-secret')
    })
  })
})
