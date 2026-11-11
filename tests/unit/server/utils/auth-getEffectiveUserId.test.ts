import { beforeEach, describe, expect, it, vi } from 'vitest'

const getServerSession = vi.fn()
const validateApiKey = vi.fn()
const getAccessToken = vi.fn()
const oAuthTokenUpdate = vi.fn().mockResolvedValue({})

vi.mock('../../../../server/utils/session', () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args)
}))

vi.mock('../../../../server/utils/auth-api-key', () => ({
  validateApiKey: (...args: unknown[]) => validateApiKey(...args)
}))

vi.mock('../../../../server/utils/repositories/oauthRepository', () => ({
  oauthRepository: {
    getAccessToken: (...args: unknown[]) => getAccessToken(...args)
  }
}))

vi.mock('../../../../server/utils/db', () => ({
  prisma: {
    oAuthToken: {
      update: (...args: unknown[]) => oAuthTokenUpdate(...args)
    }
  }
}))

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    createError: (err: { statusCode: number; message: string }) => {
      const error = new Error(err.message)
      ;(error as any).statusCode = err.statusCode
      return error
    },
    getHeader: (event: any, name: string) => {
      const headers = event?.node?.req?.headers || event?.headers || {}
      return headers[name.toLowerCase()] || headers[name]
    }
  }
})

describe('getEffectiveUserId deactivated account rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getServerSession.mockResolvedValue(null)
    validateApiKey.mockResolvedValue(null)
    getAccessToken.mockResolvedValue(null)
  })

  it('rejects a pre-existing OAuth bearer token for a deactivated user with 403', async () => {
    const { getEffectiveUserId } = await import('../../../../server/utils/coaching')

    getAccessToken.mockResolvedValue({
      id: 'token-1',
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1',
        deactivatedAt: new Date('2026-07-01T00:00:00.000Z')
      }
    })

    const event = {
      node: {
        req: {
          headers: { authorization: 'Bearer stale-access-token' },
          socket: { remoteAddress: '127.0.0.1' }
        }
      }
    }

    await expect(getEffectiveUserId(event as any)).rejects.toMatchObject({
      message: 'Account deactivated',
      statusCode: 403
    })
  })

  it('rejects an API key belonging to a deactivated user with 403', async () => {
    const { getEffectiveUserId } = await import('../../../../server/utils/coaching')

    validateApiKey.mockResolvedValue({
      id: 'user-1',
      deactivatedAt: new Date('2026-07-01T00:00:00.000Z')
    })

    await expect(getEffectiveUserId({} as any)).rejects.toMatchObject({
      message: 'Account deactivated',
      statusCode: 403
    })
  })

  it('rejects a session whose effective user is deactivated with 403', async () => {
    const { getEffectiveUserId } = await import('../../../../server/utils/coaching')

    getServerSession.mockResolvedValue({
      user: {
        id: 'athlete-1',
        deactivatedAt: new Date('2026-07-01T00:00:00.000Z')
      }
    })

    await expect(getEffectiveUserId({} as any)).rejects.toMatchObject({
      message: 'Account deactivated',
      statusCode: 403
    })
  })

  it('returns the user id for an active OAuth bearer token', async () => {
    const { getEffectiveUserId } = await import('../../../../server/utils/coaching')

    getAccessToken.mockResolvedValue({
      id: 'token-1',
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'user-1',
        deactivatedAt: null
      }
    })

    const event = {
      node: {
        req: {
          headers: { authorization: 'Bearer active-access-token' },
          socket: { remoteAddress: '127.0.0.1' }
        }
      }
    }

    await expect(getEffectiveUserId(event as any)).resolves.toBe('user-1')
  })
  const bearerEvent = () =>
    ({
      node: {
        req: {
          headers: { authorization: 'Bearer audience-token' },
          socket: { remoteAddress: '127.0.0.1' }
        }
      }
    }) as any
  const activeToken = {
    id: 'token-audience',
    user: { id: 'user-1', deactivatedAt: null },
    accessTokenExpiresAt: new Date(Date.now() + 60_000),
    scopes: ['workout:read']
  }

  it.each(['https://app.coachwatts.com/mcp', 'https://other.example/api', ' '])(
    'rejects bound audience %j before usage tracking',
    async (resource) => {
      const { getEffectiveUserId } = await import('../../../../server/utils/coaching')
      getAccessToken.mockResolvedValue({ ...activeToken, resource })
      await expect(getEffectiveUserId(bearerEvent())).rejects.toMatchObject({ statusCode: 401 })
      expect(oAuthTokenUpdate).not.toHaveBeenCalled()
    }
  )

  it.each([null, undefined, ''])('accepts legacy resource %j', async (resource) => {
    const { getEffectiveUserId } = await import('../../../../server/utils/coaching')
    getAccessToken.mockResolvedValue({ ...activeToken, resource })
    await expect(getEffectiveUserId(bearerEvent())).resolves.toBe('user-1')
    expect(oAuthTokenUpdate).toHaveBeenCalledTimes(1)
  })

  it.each([null, { ...activeToken, accessTokenExpiresAt: new Date(0) }])(
    'rejects missing or expired token %j without tracking usage',
    async (token) => {
      const { getEffectiveUserId } = await import('../../../../server/utils/coaching')
      getAccessToken.mockResolvedValue(token)
      await expect(getEffectiveUserId(bearerEvent())).rejects.toMatchObject({ statusCode: 401 })
      expect(oAuthTokenUpdate).not.toHaveBeenCalled()
    }
  )

  it.each(['session', 'api_key'])('prefers %s over a bound bearer', async (authType) => {
    const { getEffectiveUserId } = await import('../../../../server/utils/coaching')
    getAccessToken.mockResolvedValue({ ...activeToken, resource: 'https://app.coachwatts.com/mcp' })
    if (authType === 'session') getServerSession.mockResolvedValue({ user: { id: 'session-user' } })
    else validateApiKey.mockResolvedValue({ id: 'key-user' })
    await expect(getEffectiveUserId(bearerEvent())).resolves.toBe(
      authType === 'session' ? 'session-user' : 'key-user'
    )
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(oAuthTokenUpdate).not.toHaveBeenCalled()
  })
})
