import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', vi.fn())
vi.stubGlobal('readBody', (event: any) => event.body)
vi.stubGlobal('setResponseStatus', (event: any, statusCode: number) => {
  event.statusCode = statusCode
})
vi.stubGlobal('createError', (details: any) => {
  return Object.assign(new Error(details.message), { statusCode: details.statusCode })
})
vi.stubGlobal('useRuntimeConfig', () => ({
  mcpDcrEnabled: true,
  mcpDcrOwnerUserId: 'owner-1',
  mcpDcrOwnerEmail: '',
  mcpDcrRateLimitPerHour: '10'
}))

const findOrCreateCursorMcpApp = vi.fn()
const registerPublicClient = vi.fn()
const resolveMcpDcrOwnerId = vi.fn()

vi.mock('../../../../../server/utils/repositories/oauthRepository', () => ({
  oauthRepository: {
    registerPublicClient
  }
}))

vi.mock('../../../../../server/utils/oauth/mcp-dcr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../server/utils/oauth/mcp-dcr')>()

  return {
    ...actual,
    findOrCreateCursorMcpApp,
    resolveMcpDcrOwnerId
  }
})

const getHandler = async () => {
  const mod = await import('../../../../../server/api/oauth/register.post')
  return mod.default
}

function registrationEvent(redirectUri: string) {
  return {
    node: {
      req: {
        headers: {},
        socket: { remoteAddress: '127.0.0.1' }
      }
    },
    body: {
      client_name: 'Security research test',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }
}

describe('POST /api/oauth/register', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveMcpDcrOwnerId.mockResolvedValue('owner-1')
    findOrCreateCursorMcpApp.mockResolvedValue({
      clientId: 'cursor-client',
      name: 'Cursor MCP',
      redirectUris: ['http://127.0.0.1:8765/callback'],
      createdAt: new Date('2026-08-28T00:00:00.000Z')
    })
    registerPublicClient.mockResolvedValue({
      clientId: 'attacker-client',
      name: 'Security research test',
      redirectUris: ['https://attacker.evil-test.example/cb'],
      createdAt: new Date('2026-08-28T00:00:00.000Z')
    })
  })

  it('rejects arbitrary HTTPS redirect URIs without creating a client', async () => {
    const handler = await getHandler()

    await expect(
      handler(registrationEvent('https://attacker.evil-test.example/cb') as any)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Unsupported dynamic client redirect URI'
    })

    expect(findOrCreateCursorMcpApp).not.toHaveBeenCalled()
    expect(registerPublicClient).not.toHaveBeenCalled()
  })

  it('keeps known Cursor loopback callbacks registration-compatible', async () => {
    const handler = await getHandler()
    const event = registrationEvent('http://127.0.0.1:8765/callback')

    const result = await handler(event as any)

    expect(findOrCreateCursorMcpApp).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      redirectUris: ['http://127.0.0.1:8765/callback']
    })
    expect(registerPublicClient).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      client_id: 'cursor-client',
      token_endpoint_auth_method: 'none'
    })
  })
})
