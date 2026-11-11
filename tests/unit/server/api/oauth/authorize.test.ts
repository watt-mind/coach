import { beforeEach, describe, expect, it, vi } from 'vitest'

// Runs in the plain node environment (was *.nuxt.test.ts, which booted a full
// Nuxt app per file for ~17s while every Nuxt global is stubbed anyway). The
// handler's auto-imported useRuntimeConfig resolves to #app/nuxt here, so route
// it to the global stub below.
vi.mock('#app/nuxt', () => ({
  useRuntimeConfig: () => (globalThis as any).useRuntimeConfig()
}))

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', vi.fn())
vi.stubGlobal('readBody', (event: any) => event.body)
vi.stubGlobal('getQuery', () => ({}))
vi.stubGlobal(
  'sendRedirect',
  vi.fn((event: any, location: string, statusCode: number) => ({
    event,
    location,
    statusCode
  }))
)
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message || err.statusMessage)
  // @ts-expect-error test helper property
  error.statusCode = err.statusCode
  return error
})
vi.stubGlobal('useRuntimeConfig', () => ({
  public: { siteUrl: 'https://app.coachwatts.com' }
}))

const findUnique = vi.fn()
const createAuthCode = vi.fn()
const getEffectiveUserId = vi.fn()

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    oAuthApp: {
      findUnique
    }
  }
}))

vi.mock('../../../../../server/utils/repositories/oauthRepository', () => ({
  oauthRepository: {
    createAuthCode
  }
}))

vi.mock('../../../../../server/utils/coaching', () => ({
  getEffectiveUserId
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/oauth/authorize.post')
  return mod.default
}

describe('POST /api/oauth/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findUnique.mockResolvedValue({
      id: 'app-1',
      clientId: 'client-1',
      redirectUris: ['https://example.com/callback']
    })
    createAuthCode.mockResolvedValue({ code: 'auth-code-123' })
    getEffectiveUserId.mockResolvedValue('user-1')
  })

  it('redirects approved requests with code and state using 303', async () => {
    const handler = await getHandler()
    const event = {
      body: {
        client_id: 'client-1',
        redirect_uri: 'https://example.com/callback',
        scope: 'profile:read workout:read',
        state: 'state-123',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        action: 'approve'
      }
    }

    const result = await handler(event)

    expect(getEffectiveUserId).toHaveBeenCalledWith(event)
    expect(findUnique).toHaveBeenCalledWith({ where: { clientId: 'client-1' } })
    expect(createAuthCode).toHaveBeenCalledWith({
      appId: 'app-1',
      userId: 'user-1',
      redirectUri: 'https://example.com/callback',
      scopes: ['profile:read', 'workout:read'],
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256'
    })
    expect(result).toMatchObject({
      location: 'https://example.com/callback?code=auth-code-123&state=state-123',
      statusCode: 303
    })
  })

  it('redirects denied requests with oauth error fields using 303', async () => {
    const handler = await getHandler()
    const event = {
      body: {
        client_id: 'client-1',
        redirect_uri: 'https://example.com/callback',
        state: 'state-123',
        action: 'deny'
      }
    }

    const result = await handler(event)

    expect(createAuthCode).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      location:
        'https://example.com/callback?error=access_denied&error_description=The+user+denied+the+request.&state=state-123',
      statusCode: 303
    })
  })

  it('rejects deactivated users with 403 before issuing consent', async () => {
    getEffectiveUserId.mockRejectedValue(
      Object.assign(new Error('Account deactivated'), { statusCode: 403 })
    )
    const handler = await getHandler()

    await expect(
      handler({
        body: {
          client_id: 'client-1',
          redirect_uri: 'https://example.com/callback',
          action: 'approve'
        }
      })
    ).rejects.toMatchObject({
      message: 'Account deactivated',
      statusCode: 403
    })

    expect(findUnique).not.toHaveBeenCalled()
    expect(createAuthCode).not.toHaveBeenCalled()
  })

  it('throws 400 when required fields are missing', async () => {
    const handler = await getHandler()

    await expect(
      handler({ body: { client_id: 'client-1', action: 'approve' } })
    ).rejects.toMatchObject({
      message: 'Missing required fields.',
      statusCode: 400
    })
  })

  it('throws 400 for unknown client_id', async () => {
    const handler = await getHandler()
    findUnique.mockResolvedValue(null)

    await expect(
      handler({
        body: {
          client_id: 'missing-client',
          redirect_uri: 'https://example.com/callback',
          action: 'approve'
        }
      })
    ).rejects.toMatchObject({ message: 'Invalid client_id.', statusCode: 400 })
  })

  it('throws 400 for an unregistered redirect_uri', async () => {
    const handler = await getHandler()

    await expect(
      handler({
        body: {
          client_id: 'client-1',
          redirect_uri: 'https://malicious.example/callback',
          action: 'approve'
        }
      })
    ).rejects.toMatchObject({
      message:
        'The redirect_uri provided does not match any registered redirect URIs for this application.',
      statusCode: 400
    })
  })

  it('accepts urlencoded string bodies from native form posts', async () => {
    const handler = await getHandler()
    const event = {
      body: new URLSearchParams({
        client_id: 'client-1',
        redirect_uri: 'https://example.com/callback',
        state: 'state-123',
        action: 'deny'
      }).toString()
    }

    const result = await handler(event)

    expect(result).toMatchObject({
      location:
        'https://example.com/callback?error=access_denied&error_description=The+user+denied+the+request.&state=state-123',
      statusCode: 303
    })
  })

  it('accepts required fields from query when body parsing is empty', async () => {
    const handler = await getHandler()
    vi.stubGlobal('getQuery', () => ({
      client_id: 'client-1',
      redirect_uri: 'https://example.com/callback',
      state: 'state-123',
      action: 'deny'
    }))

    const result = await handler({ body: {} })

    expect(result).toMatchObject({
      location:
        'https://example.com/callback?error=access_denied&error_description=The+user+denied+the+request.&state=state-123',
      statusCode: 303
    })
  })
})
