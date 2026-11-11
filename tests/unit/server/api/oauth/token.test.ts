import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', vi.fn())
vi.stubGlobal('readBody', (event: any) => event.body)
vi.stubGlobal('setResponseStatus', vi.fn())
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message || err.statusMessage)
  // @ts-expect-error test helper property
  error.statusCode = err.statusCode
  return error
})

const getAuthCode = vi.fn()
const deleteAuthCode = vi.fn()
const redeemAuthCode = vi.fn()
const verifyClient = vi.fn()
const rotateRefreshToken = vi.fn()

vi.mock('../../../../../server/utils/repositories/oauthRepository', () => ({
  oauthRepository: {
    getAuthCode,
    deleteAuthCode,
    redeemAuthCode,
    verifyClient,
    rotateRefreshToken
  }
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/oauth/token.post')
  return mod.default
}

describe('POST /api/oauth/token MCP resource binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires matching resource for MCP authorization codes', async () => {
    const handler = await getHandler()
    const crypto = await import('node:crypto')
    const codeVerifier = 'test-verifier-123456789012345678901234567890'
    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

    getAuthCode.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'user-1',
      redirectUri: 'http://127.0.0.1/cb',
      scopes: ['profile:read'],
      resource: 'https://app.coachwatts.com/mcp',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      app: { id: 'app-1', clientId: 'client-1', isPublicClient: true }
    })

    const result = await handler({
      body: {
        grant_type: 'authorization_code',
        code: 'code-1',
        client_id: 'client-1',
        code_verifier: codeVerifier,
        resource: 'https://app.coachwatts.com/api/mcp'
      }
    })

    expect(result).toMatchObject({
      error: 'invalid_target'
    })
    expect(redeemAuthCode).not.toHaveBeenCalled()
  })

  it('issues MCP tokens when resource matches', async () => {
    const handler = await getHandler()
    getAuthCode.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'user-1',
      redirectUri: 'http://127.0.0.1/cb',
      scopes: ['profile:read', 'offline_access'],
      resource: 'https://app.coachwatts.com/mcp',
      codeChallenge: 'abc',
      codeChallengeMethod: 'S256',
      app: { id: 'app-1', clientId: 'client-1', isPublicClient: true }
    })
    redeemAuthCode.mockResolvedValue({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      refreshTokenExpiresAt: new Date(Date.now() + 86400000),
      scopes: ['profile:read', 'offline_access'],
      resource: 'https://app.coachwatts.com/mcp'
    })

    const crypto = await import('node:crypto')
    const codeVerifier = 'verifier-value'
    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')

    getAuthCode.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      userId: 'user-1',
      redirectUri: 'http://127.0.0.1/cb',
      scopes: ['profile:read', 'offline_access'],
      resource: 'https://app.coachwatts.com/mcp',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      app: { id: 'app-1', clientId: 'client-1', isPublicClient: true }
    })

    const result = await handler({
      body: {
        grant_type: 'authorization_code',
        code: 'code-1',
        client_id: 'client-1',
        code_verifier: codeVerifier,
        resource: 'https://app.coachwatts.com/mcp'
      }
    })

    expect(redeemAuthCode).toHaveBeenCalledWith('code-1', {
      appId: 'app-1',
      userId: 'user-1',
      scopes: ['profile:read', 'offline_access'],
      resource: 'https://app.coachwatts.com/mcp',
      includeRefreshToken: true
    })
    expect(result).toMatchObject({
      access_token: 'access-1',
      resource: 'https://app.coachwatts.com/mcp'
    })
  })

  it.each([
    { isMcp: false, offlineAccess: false },
    { isMcp: false, offlineAccess: true },
    { isMcp: true, offlineAccess: false },
    { isMcp: true, offlineAccess: true }
  ])(
    'gates refresh tokens on offline_access (MCP: $isMcp, scope: $offlineAccess)',
    async ({ isMcp, offlineAccess }) => {
      const handler = await getHandler()
      const scopes = offlineAccess ? ['profile:read', 'offline_access'] : ['profile:read']
      const resource = isMcp ? 'https://app.coachwatts.com/mcp' : undefined
      const crypto = await import('node:crypto')
      const codeVerifier = 'verifier-value'
      const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      getAuthCode.mockResolvedValue({
        expiresAt: new Date(Date.now() + 60_000),
        userId: 'user-1',
        redirectUri: 'http://127.0.0.1/cb',
        scopes,
        resource,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        app: { id: 'app-1', clientId: 'client-1', isPublicClient: true }
      })
      // MCP token records can retain an expiry even when no refresh token was issued.
      redeemAuthCode.mockResolvedValue({
        accessToken: 'access-1',
        refreshToken: offlineAccess ? 'refresh-1' : null,
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
        scopes,
        resource
      })

      const result = await handler({
        body: {
          grant_type: 'authorization_code',
          code: 'code-1',
          client_id: 'client-1',
          code_verifier: codeVerifier,
          resource
        }
      })

      expect(redeemAuthCode).toHaveBeenCalledWith('code-1', {
        appId: 'app-1',
        userId: 'user-1',
        scopes,
        resource,
        includeRefreshToken: offlineAccess
      })
      expect(deleteAuthCode).not.toHaveBeenCalled()
      const serialized = JSON.parse(JSON.stringify(result))
      expect(serialized).toMatchObject({
        access_token: 'access-1',
        token_type: 'Bearer',
        scope: scopes.join(' ')
      })
      if (isMcp) expect(serialized.resource).toBe(resource)
      if (offlineAccess) {
        expect(serialized.refresh_token).toBe('refresh-1')
        expect(serialized.refresh_token_expires_in).toBeGreaterThan(86_390)
        expect(serialized.refresh_token_expires_in).toBeLessThanOrEqual(86_400)
      } else {
        expect(serialized).not.toHaveProperty('refresh_token')
        expect(serialized).not.toHaveProperty('refresh_token_expires_in')
      }
    }
  )

  it('passes resource through refresh grant', async () => {
    const handler = await getHandler()
    rotateRefreshToken.mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      refreshTokenExpiresAt: new Date(Date.now() + 86400000),
      scopes: ['profile:read'],
      resource: 'https://app.coachwatts.com/mcp'
    })

    const result = await handler({
      body: {
        grant_type: 'refresh_token',
        refresh_token: 'refresh-1',
        client_id: 'client-1',
        resource: 'https://app.coachwatts.com/mcp'
      }
    })

    expect(rotateRefreshToken).toHaveBeenCalledWith('refresh-1', {
      clientId: 'client-1',
      resource: 'https://app.coachwatts.com/mcp'
    })
    expect(result).toMatchObject({ access_token: 'access-2' })
  })
})
