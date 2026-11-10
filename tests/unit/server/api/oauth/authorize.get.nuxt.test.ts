import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', vi.fn())
vi.stubGlobal(
  'sendRedirect',
  vi.fn((event: any, location: string, statusCode?: number) => ({
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
  public: { siteUrl: 'https://coachwatts.com' }
}))

const findUnique = vi.fn()
const createAuthCode = vi.fn()
const getServerSession = vi.fn()
let queryState: Record<string, string> = {}

vi.stubGlobal('getQuery', () => queryState)

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    oAuthApp: {
      findUnique
    }
  }
}))

vi.mock('../../../../../server/utils/session', () => ({
  getServerSession
}))

vi.mock('../../../../../server/utils/repositories/oauthRepository', () => ({
  oauthRepository: {
    createAuthCode
  }
}))

const getHandler = async () => {
  vi.resetModules()
  const mod = await import('../../../../../server/api/oauth/authorize.get')
  return mod.default
}

describe('GET /api/oauth/authorize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryState = {
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'coachwatts://oauth/callback',
      scope: 'profile:read',
      state: 'state-123',
      code_challenge: 'challenge',
      code_challenge_method: 'S256'
    }
    findUnique.mockResolvedValue({
      id: 'app-1',
      clientId: 'client-1',
      redirectUris: ['coachwatts://oauth/callback'],
      isOfficial: false
    })
    createAuthCode.mockResolvedValue({ code: 'auth-code-123' })
    getServerSession.mockResolvedValue(null)
  })

  it('redirects non-official apps to the consent page', async () => {
    const handler = await getHandler()
    const result = await handler({})

    expect(createAuthCode).not.toHaveBeenCalled()
    expect(result.location).toContain('/oauth/authorize?')
    expect(result.location).toContain('client_id=client-1')
    expect(result.location).toContain('redirect_uri=coachwatts%3A%2F%2Foauth%2Fcallback')
  })

  it('issues a code for official apps when the user has a session', async () => {
    findUnique.mockResolvedValue({
      id: 'app-1',
      clientId: 'client-1',
      redirectUris: ['coachwatts://oauth/callback'],
      isOfficial: true
    })
    getServerSession.mockResolvedValue({ user: { id: 'user-1' } })

    const handler = await getHandler()
    const result = await handler({})

    expect(createAuthCode).toHaveBeenCalledWith({
      appId: 'app-1',
      userId: 'user-1',
      redirectUri: 'coachwatts://oauth/callback',
      scopes: ['profile:read'],
      resource: undefined,
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256'
    })
    expect(result.location).toBe('coachwatts://oauth/callback?code=auth-code-123&state=state-123')
  })

  it('shows account choices for official apps with a session when prompt=login', async () => {
    queryState.prompt = 'login'
    findUnique.mockResolvedValue({
      id: 'app-1',
      clientId: 'client-1',
      redirectUris: ['coachwatts://oauth/callback'],
      isOfficial: true
    })
    getServerSession.mockResolvedValue({ user: { id: 'user-1' } })

    const handler = await getHandler()
    const result = await handler({})

    expect(createAuthCode).not.toHaveBeenCalled()
    expect(result.location).toContain('/oauth/login?')
    const url = new URL(result.location)
    const callbackUrl = url.searchParams.get('callbackUrl')
    expect(callbackUrl).toContain('/api/oauth/authorize?')
    expect(callbackUrl).toContain('state=state-123')
    expect(callbackUrl).toContain('code_challenge=challenge')
    expect(callbackUrl).not.toContain('prompt=login')
  })

  it('redirects official apps without a session to oauth login', async () => {
    findUnique.mockResolvedValue({
      id: 'app-1',
      clientId: 'client-1',
      redirectUris: ['coachwatts://oauth/callback'],
      isOfficial: true
    })
    getServerSession.mockResolvedValue(null)

    const handler = await getHandler()
    const result = await handler({})

    expect(createAuthCode).not.toHaveBeenCalled()
    expect(result.location).toContain('/oauth/login?')
    const url = new URL(result.location)
    expect(url.searchParams.get('callbackUrl')).toContain('/api/oauth/authorize?')
    expect(url.searchParams.get('callbackUrl')).toContain('client_id=client-1')
  })

  it('forces the consent page when prompt=consent even for official apps', async () => {
    queryState.prompt = 'consent'
    findUnique.mockResolvedValue({
      id: 'app-1',
      clientId: 'client-1',
      redirectUris: ['coachwatts://oauth/callback'],
      isOfficial: true
    })
    getServerSession.mockResolvedValue({ user: { id: 'user-1' } })

    const handler = await getHandler()
    const result = await handler({})

    expect(createAuthCode).not.toHaveBeenCalled()
    expect(result.location).toContain('/oauth/authorize?')
    expect(result.location).toContain('prompt=consent')
  })

  it('returns hosted-login cancellation to the registered callback with state', async () => {
    queryState.action = 'deny'
    findUnique.mockResolvedValue({
      id: 'app-1',
      clientId: 'client-1',
      redirectUris: ['coachwatts://oauth/callback'],
      isOfficial: true
    })

    const handler = await getHandler()
    const result = await handler({})

    expect(getServerSession).not.toHaveBeenCalled()
    expect(result.location).toBe(
      'coachwatts://oauth/callback?error=access_denied&error_description=The+user+cancelled+sign-in.&state=state-123'
    )
  })

  it('refuses a hosted-login cancellation with an unregistered callback', async () => {
    queryState.action = 'deny'
    queryState.redirect_uri = 'https://attacker.example/callback'

    const handler = await getHandler()

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(sendRedirect).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('attacker.example'),
      expect.anything()
    )
  })
})
