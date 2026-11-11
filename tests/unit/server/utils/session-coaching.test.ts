import { beforeEach, describe, expect, it, vi } from 'vitest'

const { base, find, relationship } = vi.hoisted(() => ({
  base: vi.fn(),
  find: vi.fn(),
  relationship: vi.fn()
}))
vi.mock('#auth', () => ({ getServerSession: base }))
vi.mock('h3', () => ({
  getHeader: (e: any, n: string) => e.headers[n],
  getCookie: () => undefined,
  createError: (e: any) => Object.assign(new Error(), e)
}))
vi.mock('../../../../server/utils/db', () => ({ prisma: { user: { findUnique: find } } }))
vi.mock('../../../../server/utils/repositories/coachingRepository', () => ({
  coachingRepository: { checkRelationship: relationship }
}))
vi.mock('../../../../server/utils/repositories/oauthRepository', () => ({ oauthRepository: {} }))
vi.mock('../../../../server/utils/auth-api-key', () => ({ validateApiKey: vi.fn() }))
const { getServerSession } = await import('../../../../server/utils/session')
const { requireAdmin, requireAuth } = await import('../../../../server/utils/auth-guard')

describe('coaching admin isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    base.mockResolvedValue({
      user: { id: 'coach', email: 'coach@example.com', isAdmin: false },
      expires: ''
    })
    find.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.id === 'coach'
          ? { id: 'coach', deactivatedAt: null }
          : { id: 'athlete', email: 'athlete@example.com', isAdmin: true, deactivatedAt: null }
      )
    )
    relationship.mockResolvedValue(true)
  })
  it('denies admin through the real session and re-fetch while retaining identity', async () => {
    const event = { headers: { 'x-act-as-user': 'athlete' }, context: {} } as any
    const session = await getServerSession(event)
    expect(session?.user).toMatchObject({
      id: 'athlete',
      isAdmin: false,
      isCoaching: true,
      originalUserId: 'coach',
      originalUserEmail: 'coach@example.com'
    })
    await expect(requireAdmin(event)).rejects.toMatchObject({ statusCode: 403 })
    expect(await requireAuth(event)).toMatchObject({ id: 'athlete', isAdmin: false })
    expect(event.context.user.isAdmin).toBe(false)
  })
  it('retains ordinary admin access', async () => {
    base.mockResolvedValue({ user: { id: 'coach', isAdmin: true }, expires: '' })
    const event = { headers: {}, context: {} } as any
    await expect(requireAdmin(event)).resolves.toMatchObject({ user: { isAdmin: true } })
  })
})
