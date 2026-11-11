import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineRouteMeta', () => {})
vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('readBody', async () => ({}))

const requireAuthMock = vi.fn()
const createAppWebHandoffMock = vi.fn()
const sanitizeReturnToMock = vi.fn((value: unknown) => (typeof value === 'string' ? value : '/'))
const siteOriginForEventMock = vi.fn(() => 'https://app.example.com')

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: requireAuthMock
}))

vi.mock('../../../../../server/utils/app-web-handoff', () => ({
  createAppWebHandoff: (...args: unknown[]) => createAppWebHandoffMock(...args),
  sanitizeReturnTo: (...args: unknown[]) => sanitizeReturnToMock(...args),
  siteOriginForEvent: (...args: unknown[]) => siteOriginForEventMock(...args)
}))

const getHandler = async () =>
  (await import('../../../../../server/api/auth/app-web-handoff.post')).default

describe('POST /api/auth/app-web-handoff (CW-669)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mints a handoff URL for session/API-key auth', async () => {
    const handler = await getHandler()
    const event = {} as any

    requireAuthMock.mockResolvedValue({ id: 'user-1' })
    createAppWebHandoffMock.mockResolvedValue({ code: 'code-abc', expiresIn: 60 })

    const result = await handler(event)

    expect(requireAuthMock).toHaveBeenCalledWith(event, undefined, { allowOAuth: false })
    expect(createAppWebHandoffMock).toHaveBeenCalledWith('user-1')
    expect(result).toEqual({
      url: 'https://app.example.com/api/auth/app-web-handoff/consume?code=code-abc&returnTo=%2F',
      expiresIn: 60
    })
  })

  it('rejects OAuth bearer tokens (guard throws 403)', async () => {
    const handler = await getHandler()
    const forbidden = Object.assign(
      new Error('OAuth bearer tokens are not accepted on this endpoint'),
      { statusCode: 403 }
    )
    requireAuthMock.mockRejectedValue(forbidden)

    await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 })
    expect(requireAuthMock).toHaveBeenCalledWith(expect.anything(), undefined, {
      allowOAuth: false
    })
    expect(createAppWebHandoffMock).not.toHaveBeenCalled()
  })
})
