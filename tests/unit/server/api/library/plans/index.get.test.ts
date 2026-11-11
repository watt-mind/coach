import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getServerSession } from '../../../../../../server/utils/session'
import { prisma } from '../../../../../../server/utils/db'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('getQuery', (event: any) => event.query || {})
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message)
  ;(error as any).statusCode = err.statusCode
  return error
})

vi.mock('../../../../../../server/utils/session', () => ({
  getServerSession: vi.fn()
}))

vi.mock('../../../../../../server/utils/db', () => ({
  prisma: {
    trainingPlan: {
      findMany: vi.fn()
    },
    teamMember: {
      findMany: vi.fn()
    }
  }
}))

const getHandler = async () => {
  const mod = await import('../../../../../../server/api/library/plans/index.get')
  return mod.default
}

const callHandler = async (handler: any, query: any, user: any) => {
  vi.mocked(getServerSession).mockResolvedValue(user ? ({ user } as any) : null)
  return handler({ query } as any)
}

describe('GET /api/library/plans?type=favorites', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([])
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([])
  })

  it('returns 401 without a session', async () => {
    const handler = await getHandler()
    await expect(callHandler(handler, { type: 'favorites' }, null)).rejects.toMatchObject({
      statusCode: 401
    })
    expect(prisma.trainingPlan.findMany).not.toHaveBeenCalled()
  })

  it('intersects favorite membership with readability instead of trusting membership', async () => {
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([] as any)
    const handler = await getHandler()

    await callHandler(handler, { type: 'favorites' }, { id: 'user-b' })

    // The exploit query was { isTemplate, favorites: some(user) }; the fix must
    // add a readability OR so membership alone never discloses scalars.
    expect(prisma.trainingPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isTemplate: true,
          AND: [
            { favorites: { some: { userId: 'user-b' } } },
            {
              OR: [
                { userId: { in: ['user-b'] } },
                { visibility: 'PUBLIC' },
                { visibility: 'TEAM', teamId: { in: [] } }
              ]
            }
          ]
        })
      })
    )
  })

  it('excludes revoked PUBLIC templates because readability is evaluated on every request', async () => {
    // A favorite created while PUBLIC must disappear once the plan is PRIVATE:
    // the query predicate (not post-hoc filtering) enforces this.
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([] as any)
    const handler = await getHandler()

    await callHandler(handler, { type: 'favorites' }, { id: 'user-b' })

    const where = vi.mocked(prisma.trainingPlan.findMany).mock.calls[0][0].where
    expect(where.isTemplate).toBe(true)
    const readability = where.AND[1].OR
    expect(readability).toContainEqual({ visibility: 'PUBLIC' })
    // A PRIVATE plan owned by someone else matches neither the owner leg nor
    // the PUBLIC leg, so its coachNotes/athleteNotes/customInstructions rows
    // are never returned.
    expect(readability).toContainEqual({ userId: { in: ['user-b'] } })
  })

  it('excludes TEAM favorites after ACTIVE membership ends', async () => {
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([])
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([] as any)
    const handler = await getHandler()

    await callHandler(handler, { type: 'favorites' }, { id: 'user-b' })

    expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-b', status: 'ACTIVE' },
      select: { teamId: true }
    })
    const where = vi.mocked(prisma.trainingPlan.findMany).mock.calls[0][0].where
    expect(where.AND[1].OR).toContainEqual({ visibility: 'TEAM', teamId: { in: [] } })
  })

  it('includes TEAM favorites for ACTIVE members', async () => {
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([{ teamId: 'team-1' }] as any)
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([
      {
        id: 'plan-team',
        userId: 'coach-9',
        visibility: 'TEAM',
        teamId: 'team-1',
        coachNotes: 'secret',
        favorites: [{ id: 'fav-1' }]
      }
    ] as any)
    const handler = await getHandler()

    const result = await callHandler(handler, { type: 'favorites' }, { id: 'user-b' })

    const where = vi.mocked(prisma.trainingPlan.findMany).mock.calls[0][0].where
    expect(where.AND[1].OR).toContainEqual({ visibility: 'TEAM', teamId: { in: ['team-1'] } })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'plan-team', isFavorite: true })
  })

  it('preserves athlete scope in coaching mode', async () => {
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([] as any)
    const handler = await getHandler()

    await callHandler(
      handler,
      { type: 'favorites', scope: 'athlete' },
      { id: 'athlete-1', originalUserId: 'coach-1', isCoaching: true }
    )

    const where = vi.mocked(prisma.trainingPlan.findMany).mock.calls[0][0].where
    expect(where.AND[0]).toEqual({ favorites: { some: { userId: 'athlete-1' } } })
    expect(where.AND[1].OR).toContainEqual({ userId: { in: ['athlete-1'] } })
  })

  it('preserves coach scope in coaching mode', async () => {
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([] as any)
    const handler = await getHandler()

    await callHandler(
      handler,
      { type: 'favorites', scope: 'coach' },
      { id: 'athlete-1', originalUserId: 'coach-1', isCoaching: true }
    )

    const where = vi.mocked(prisma.trainingPlan.findMany).mock.calls[0][0].where
    expect(where.AND[1].OR).toContainEqual({ userId: { in: ['coach-1'] } })
  })

  it('preserves all scope in coaching mode and annotates owner scopes', async () => {
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([
      { id: 'plan-coach', userId: 'coach-1', favorites: [{ id: 'fav-1' }] },
      { id: 'plan-athlete', userId: 'athlete-1', favorites: [{ id: 'fav-2' }] }
    ] as any)
    const handler = await getHandler()

    const result = await callHandler(
      handler,
      { type: 'favorites', scope: 'all' },
      { id: 'athlete-1', originalUserId: 'coach-1', isCoaching: true }
    )

    const where = vi.mocked(prisma.trainingPlan.findMany).mock.calls[0][0].where
    expect(where.AND[1].OR).toContainEqual({ userId: { in: ['coach-1', 'athlete-1'] } })
    expect(result.find((row: any) => row.id === 'plan-coach')).toMatchObject({
      ownerScope: 'coach',
      ownerUserId: 'coach-1',
      isFavorite: true
    })
    expect(result.find((row: any) => row.id === 'plan-athlete')).toMatchObject({
      ownerScope: 'athlete',
      ownerUserId: 'athlete-1',
      isFavorite: true
    })
  })

  it('does not grant access merely because originalUserId is present', async () => {
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([] as any)
    const handler = await getHandler()

    await callHandler(
      handler,
      { type: 'favorites' },
      { id: 'athlete-1', originalUserId: 'coach-1' }
    )

    const where = vi.mocked(prisma.trainingPlan.findMany).mock.calls[0][0].where
    expect(where.AND[0]).toEqual({ favorites: { some: { userId: 'athlete-1' } } })
    expect(where.AND[1].OR).toContainEqual({ userId: { in: ['athlete-1'] } })
  })

  it('leaves the default listing behavior unchanged', async () => {
    vi.mocked(prisma.trainingPlan.findMany).mockResolvedValue([
      { id: 'plan-own', userId: 'user-b', favorites: [] }
    ] as any)
    const handler = await getHandler()

    const result = await callHandler(handler, {}, { id: 'user-b' })

    expect(prisma.trainingPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isTemplate: true,
          userId: { in: ['user-b'] }
        })
      })
    )
    expect(result[0]).toMatchObject({
      id: 'plan-own',
      isFavorite: false,
      ownerScope: 'athlete',
      isEditable: true
    })
  })
})
