import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuth, generateWsToken } = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  generateWsToken: vi.fn()
}))
vi.mock('../../../../server/utils/auth-guard', () => ({ requireAuth }))
vi.mock('../../../../server/utils/ws-auth', () => ({ generateWsToken }))
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)

const handler = (await import('../../../../server/api/websocket-token.get')).default

describe('websocket token OAuth policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAuth.mockResolvedValue({ id: 'user-1' })
    generateWsToken.mockReturnValue('signed-token')
  })

  it.each([{ scopes: [] }, { scopes: ['profile:read'] }, { scopes: ['chat:read'] }])(
    'preserves OAuth scope restrictions %j',
    async ({ scopes }) => {
      const event = { context: { authType: 'oauth', oauthScopes: scopes } } as any
      await expect(handler(event)).resolves.toEqual({ token: 'signed-token' })
      expect(requireAuth).toHaveBeenCalledWith(event, undefined, { allowOAuth: true })
      expect(generateWsToken).toHaveBeenCalledWith('user-1', scopes)
    }
  )

  it('does not grant unrestricted access if OAuth scopes are absent', async () => {
    await handler({ context: { authType: 'oauth' } } as any)
    expect(generateWsToken).toHaveBeenCalledWith('user-1', [])
  })

  it.each(['session', 'api_key'])('preserves unrestricted %s mints', async (authType) => {
    await handler({ context: { authType } } as any)
    expect(generateWsToken).toHaveBeenCalledWith('user-1', null)
  })

  it('does not mint a token when authentication fails', async () => {
    requireAuth.mockRejectedValue({ statusCode: 401 })
    await expect(handler({ context: {} } as any)).rejects.toMatchObject({ statusCode: 401 })
    expect(generateWsToken).not.toHaveBeenCalled()
  })
})
