import { beforeEach, describe, expect, it, vi } from 'vitest'
import { oauthRepository } from '../../../../../server/utils/repositories/oauthRepository'

const db = vi.hoisted(() => ({ prisma: {} as any }))
vi.mock('../../../../../server/utils/db', () => db)

vi.mock('#app/composables/ssr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#app/composables/ssr')>()),
  setResponseStatus: (event: any, status: number) => {
    event.status = status
  }
}))

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', vi.fn())
vi.stubGlobal('readBody', (event: any) => event.body)
vi.stubGlobal('setResponseStatus', (event: any, status: number) => {
  event.status = status
})

// Models serialized database writes and transaction-local state: only successful
// callbacks commit. This is a persistence double, not a PostgreSQL integration test.
function persistence() {
  let state = { code: true, tokens: [] as any[], consent: null as any }
  let failWrite = false
  let reads = 0
  let releaseReads!: () => void
  const bothRead = new Promise<void>((resolve) => {
    releaseReads = resolve
  })
  let queue = Promise.resolve()
  const row = {
    code: 'code',
    appId: 'app',
    userId: 'user',
    scopes: ['profile:read', 'offline_access'],
    resource: 'https://app.coachwatts.com/mcp',
    redirectUri: 'http://localhost/cb',
    codeChallenge: 'verifier',
    codeChallengeMethod: 'plain',
    expiresAt: new Date(Date.now() + 60_000),
    app: { id: 'app', clientId: 'client', isPublicClient: true }
  }
  // Use S256 so MCP follows the normal successful validation path.
  const models = (get: () => typeof state) => ({
    oAuthAuthCode: {
      findUnique: async () => {
        const snapshot = get().code ? { ...row } : null
        if (++reads <= 2) {
          if (reads === 2) releaseReads()
          await bothRead
        }
        return snapshot
      },
      delete: async () => {
        if (!get().code) throw new Error('missing')
        get().code = false
      },
      deleteMany: async ({ where }: any) => {
        if (!get().code || row.expiresAt <= where.expiresAt.gt) return { count: 0 }
        get().code = false
        return { count: 1 }
      }
    },
    oAuthConsent: {
      upsert: async ({ create }: any) => {
        get().consent = create
      }
    },
    oAuthToken: {
      create: async ({ data }: any) => {
        if (failWrite) throw new Error('token write failed')
        get().tokens.push(data)
        return data
      }
    }
  })
  Object.assign(
    db.prisma,
    models(() => state),
    {
      $transaction: (callback: any) => {
        const result = queue.then(async () => {
          const tentative = structuredClone(state)
          const value = await callback(models(() => tentative))
          state = tentative
          return value
        })
        queue = result.then(
          () => undefined,
          () => undefined
        )
        return result
      }
    }
  )
  return {
    row,
    state: () => state,
    fail: (value: boolean) => {
      failWrite = value
    },
    releaseReads
  }
}

describe('authorization code persistence through the real repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('setResponseStatus', (event: any, status: number) => {
      event.status = status
    })
  })

  async function setup() {
    const store = persistence()
    const crypto = await import('node:crypto')
    store.row.codeChallenge = crypto.createHash('sha256').update('verifier').digest('base64url')
    store.row.codeChallengeMethod = 'S256'
    const { default: handler } = await import('../../../../../server/api/oauth/token.post')
    const event = (overrides = {}) => ({
      status: 200,
      body: {
        grant_type: 'authorization_code',
        code: 'code',
        client_id: 'client',
        redirect_uri: store.row.redirectUri,
        code_verifier: 'verifier',
        resource: store.row.resource,
        ...overrides
      }
    })
    return { store, handler, event }
  }

  it('allows only one concurrent exchange after both lookups, then rejects sequential replay', async () => {
    const { store, handler, event } = await setup()
    const events = [event(), event()]
    const results = await Promise.all(events.map((e) => handler(e)))
    expect(results.filter((r) => 'access_token' in r)).toHaveLength(1)
    expect(results.filter((r) => r.error === 'invalid_grant')).toHaveLength(1)
    expect(events.map((e) => e.status).sort()).toEqual([200, 400])
    expect(store.state().tokens).toHaveLength(1)
    expect(await handler(event())).toMatchObject({ error: 'invalid_grant' })
    expect(store.state().tokens).toHaveLength(1)
  })

  it('rolls back code and consent on token failure and permits a later retry', async () => {
    const { store, handler, event } = await setup()
    store.releaseReads()
    store.fail(true)
    await expect(handler(event())).rejects.toThrow('token write failed')
    expect(store.state()).toEqual({ code: true, tokens: [], consent: null })
    store.fail(false)
    expect(await handler(event())).toMatchObject({
      token_type: 'Bearer',
      refresh_token: expect.any(String)
    })
  })

  it.each([
    { client_id: 'wrong' },
    { redirect_uri: 'http://wrong/cb' },
    { code_verifier: 'wrong' },
    { resource: 'https://wrong.test/mcp' }
  ])('validates before consumption: %j', async (overrides) => {
    const { store, handler, event } = await setup()
    store.releaseReads()
    expect(await handler(event(overrides))).toHaveProperty('error')
    expect(store.state()).toEqual({ code: true, tokens: [], consent: null })
    expect(await handler(event())).toHaveProperty('access_token')
  })

  it('rejects expired codes without issuing tokens', async () => {
    const { store, handler, event } = await setup()
    store.releaseReads()
    store.row.expiresAt = new Date(0)
    expect(await handler(event())).toMatchObject({ error: 'invalid_grant' })
    expect(store.state().tokens).toEqual([])
    expect(store.state().consent).toBeNull()
  })

  it('rejects a code which expires between validation and atomic claim', async () => {
    const store = persistence()
    store.row.expiresAt = new Date(0)
    const result = await oauthRepository.redeemAuthCode('code', {
      appId: 'app',
      userId: 'user',
      scopes: ['profile:read']
    })
    expect(result).toBeNull()
    expect(store.state().tokens).toEqual([])
  })
})
