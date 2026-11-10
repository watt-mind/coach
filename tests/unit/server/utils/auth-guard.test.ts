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
    getAccessToken: (...args: unknown[]) => getAccessTokenMock(...args)
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

describe('requireAuth OAuth opt-out (CW-669)', () => {
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

  it('still accepts OAuth bearer tokens by default (backwards compatible)', async () => {
    getAccessTokenMock.mockResolvedValue(OAUTH_TOKEN)
    const event = oauthEvent()

    const user = await requireAuth(event)

    expect(user).toMatchObject({ id: 'user-1' })
    expect(event.context.authType).toBe('oauth')
  })

  it('still enforces required scopes for OAuth tokens by default', async () => {
    getAccessTokenMock.mockResolvedValue(OAUTH_TOKEN)

    await expect(requireAuth(oauthEvent(), ['chat:write'])).rejects.toMatchObject({
      statusCode: 403
    })
  })

  it('returns 401 when no credentials are presented', async () => {
    await expect(requireAuth(anonymousEvent())).rejects.toMatchObject({ statusCode: 401 })
  })
})
