import { beforeEach, describe, expect, it, vi } from 'vitest'

const getServerSessionMock = vi.fn()
const validateApiKeyMock = vi.fn()
const getAccessTokenMock = vi.fn()
const prismaUserFindUniqueMock = vi.fn()
const oAuthTokenUpdateMock = vi.fn()

vi.mock('h3', () => ({
  getHeader: (event: any, name: string) => event.headers?.[String(name).toLowerCase()],
  createError: (err: { statusCode: number; message: string }) => {
    const error = new Error(err.message)
    ;(error as any).statusCode = err.statusCode
    return error
  }
}))

vi.mock('../../../../server/utils/session', () => ({
  getServerSession: (...args: unknown[]) => getServerSessionMock(...args)
}))

vi.mock('../../../../server/utils/auth-api-key', () => ({
  validateApiKey: (...args: unknown[]) => validateApiKeyMock(...args)
}))

vi.mock('../../../../server/utils/repositories/oauthRepository', () => ({
  oauthRepository: {
    getAccessToken: (...args: unknown[]) => getAccessTokenMock(...args),
    createApp: vi.fn(),
    regenerateSecret: vi.fn()
  }
}))

vi.mock('../../../../server/utils/db', () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => prismaUserFindUniqueMock(...args)
    },
    oAuthToken: {
      update: (...args: unknown[]) => oAuthTokenUpdateMock(...args)
    }
  }
}))

vi.mock('../../../../server/utils/coaching', () => ({ getEffectiveUserId: vi.fn() }))
vi.mock('../../../../server/utils/audit', () => ({ logAction: vi.fn() }))

const { requireAuth } = await import('../../../../server/utils/auth-guard')

const ACTIVE_USER = { id: 'user-1', email: 'athlete@example.com', deactivatedAt: null }
const OAUTH_TOKEN = {
  user: ACTIVE_USER,
  scopes: ['profile:read', 'profile:write', 'goal:read', 'goal:write', 'offline_access'],
  appId: 'app-1'
}

function oauthEvent() {
  return {
    headers: { authorization: 'Bearer token-123' },
    node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    context: {}
  } as any
}

function anonymousEvent() {
  return {
    headers: {},
    node: { req: { socket: { remoteAddress: '127.0.0.1' } } },
    context: {}
  } as any
}

describe('requireAuth OAuth policy (CW-669)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getServerSessionMock.mockResolvedValue(null)
    validateApiKeyMock.mockResolvedValue(null)
    getAccessTokenMock.mockResolvedValue(null)
    prismaUserFindUniqueMock.mockResolvedValue(ACTIVE_USER)
    oAuthTokenUpdateMock.mockResolvedValue({})
  })

  it('rejects a valid OAuth bearer token with 403 when allowOAuth is false', async () => {
    getAccessTokenMock.mockResolvedValue(OAUTH_TOKEN)

    await expect(requireAuth(oauthEvent(), undefined, { allowOAuth: false })).rejects.toMatchObject(
      {
        statusCode: 403
      }
    )
  })

  it('rejects OAuth even when the token satisfies the required scopes', async () => {
    getAccessTokenMock.mockResolvedValue(OAUTH_TOKEN)

    await expect(
      requireAuth(oauthEvent(), ['profile:read'], { allowOAuth: false })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('still accepts cookie sessions when allowOAuth is false', async () => {
    getServerSessionMock.mockResolvedValue({ user: { id: 'user-1' } })
    const event = anonymousEvent()

    const user = await requireAuth(event, undefined, { allowOAuth: false })

    expect(user).toMatchObject({ id: 'user-1' })
    expect(event.context.authType).toBe('session')
  })

  it('still accepts API keys when allowOAuth is false', async () => {
    validateApiKeyMock.mockResolvedValue(ACTIVE_USER)
    const event = anonymousEvent()

    const user = await requireAuth(event, undefined, { allowOAuth: false })

    expect(user).toMatchObject({ id: 'user-1' })
    expect(event.context.authType).toBe('api_key')
  })

  it.each([{ scopes: [] }, { scopes: ['profile:read'] }])(
    'rejects default internal auth with token scopes %j',
    async ({ scopes }) => {
      getAccessTokenMock.mockResolvedValue({ ...OAUTH_TOKEN, scopes })
      const event = oauthEvent()
      await expect(requireAuth(event)).rejects.toMatchObject({ statusCode: 403 })
      expect(event.context.authType).toBeUndefined()
    }
  )

  it('does not treat empty required scopes as OAuth permission', async () => {
    getAccessTokenMock.mockResolvedValue(OAUTH_TOKEN)
    await expect(requireAuth(oauthEvent(), [])).rejects.toMatchObject({ statusCode: 403 })
  })

  it('accepts OAuth with explicitly required matching scopes', async () => {
    getAccessTokenMock.mockResolvedValue(OAUTH_TOKEN)
    const event = oauthEvent()
    await expect(requireAuth(event, ['profile:read'])).resolves.toEqual(ACTIVE_USER)
    expect(event.context).toMatchObject({ authType: 'oauth', oauthScopes: OAUTH_TOKEN.scopes })
  })

  it('accepts deliberate OAuth opt-in without adding scopes', async () => {
    getAccessTokenMock.mockResolvedValue({ ...OAUTH_TOKEN, scopes: [] })
    const event = oauthEvent()
    await expect(requireAuth(event, undefined, { allowOAuth: true })).resolves.toEqual(ACTIVE_USER)
    expect(event.context.oauthScopes).toEqual([])
  })

  it.each(['session', 'api_key'])('preserves default %s authentication', async (authType) => {
    if (authType === 'session')
      getServerSessionMock.mockResolvedValue({ user: { id: ACTIVE_USER.id } })
    else validateApiKeyMock.mockResolvedValue(ACTIVE_USER)
    const event = anonymousEvent()
    await expect(requireAuth(event)).resolves.toEqual(ACTIVE_USER)
    expect(event.context.authType).toBe(authType)
  })

  it.each([undefined, { allowOAuth: true }])(
    'enforces required scopes with options %j',
    async (options) => {
      getAccessTokenMock.mockResolvedValue(OAUTH_TOKEN)

      await expect(requireAuth(oauthEvent(), ['chat:write'], options)).rejects.toMatchObject({
        statusCode: 403
      })
    }
  )

  it('returns 401 when no credentials are presented', async () => {
    await expect(requireAuth(anonymousEvent())).rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('developer credential endpoints use default guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getServerSessionMock.mockResolvedValue(null)
    validateApiKeyMock.mockResolvedValue(null)
    oAuthTokenUpdateMock.mockResolvedValue({})
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('defineRouteMeta', vi.fn())
  })

  it.each([{ scopes: [] }, { scopes: ['profile:read'] }])(
    'rejects token scopes %j before creating or rotating credentials',
    async ({ scopes }) => {
      getAccessTokenMock.mockResolvedValue({ ...OAUTH_TOKEN, scopes })
      const create = (await import('../../../../server/api/developer/apps/index.post')).default
      const rotate = (await import('../../../../server/api/developer/apps/[id]/secret.post'))
        .default
      const { oauthRepository } =
        await import('../../../../server/utils/repositories/oauthRepository')
      await expect(create(oauthEvent())).rejects.toMatchObject({ statusCode: 403 })
      await expect(rotate(oauthEvent())).rejects.toMatchObject({ statusCode: 403 })
      expect(oauthRepository.createApp).not.toHaveBeenCalled()
      expect(oauthRepository.regenerateSecret).not.toHaveBeenCalled()
    }
  )
})
