import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getServerSession } from '../../../../../../server/utils/session'
import { prisma } from '../../../../../../server/utils/db'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('readBody', async (event: any) => event.body)
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
      findFirst: vi.fn()
    },
    teamMember: {
      findMany: vi.fn()
    },
    favoriteTrainingPlan: {
      upsert: vi.fn(),
      deleteMany: vi.fn()
    }
  }
}))

const getHandler = async () => {
  const mod = await import('../../../../../../server/api/library/plans/favorite.post')
  return mod.default
}

const callHandler = async (handler: any, body: any, user: any) => {
  vi.mocked(getServerSession).mockResolvedValue(user ? ({ user } as any) : null)
  return handler({ body } as any)
}

describe('POST /api/library/plans/favorite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([])
  })

  it('returns 401 without a session', async () => {
    const handler = await getHandler()
    await expect(
      callHandler(handler, { planId: 'plan-1', isFavorite: true }, null)
    ).rejects.toMatchObject({
      statusCode: 401
    })
    expect(prisma.favoriteTrainingPlan.upsert).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid body', async () => {
    const handler = await getHandler()
    await expect(
      callHandler(handler, { planId: 123, isFavorite: 'yes' }, { id: 'user-b' })
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prisma.favoriteTrainingPlan.upsert).not.toHaveBeenCalled()
  })

  it('denies favoriting an unrelated private template and creates no favorite', async () => {
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue(null)
    const handler = await getHandler()

    await expect(
      callHandler(handler, { planId: 'plan-private-a', isFavorite: true }, { id: 'user-b' })
    ).rejects.toMatchObject({ statusCode: 404 })

    // Authorization happens in the query predicate, not by filtering rows after the fact.
    expect(prisma.trainingPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'plan-private-a',
          isTemplate: true,
          OR: [
            { userId: { in: ['user-b'] } },
            { visibility: 'PUBLIC' },
            { visibility: 'TEAM', teamId: { in: [] } }
          ]
        })
      })
    )
    expect(prisma.favoriteTrainingPlan.upsert).not.toHaveBeenCalled()
  })

  it('denies favoriting a nonexistent plan without creating a favorite', async () => {
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue(null)
    const handler = await getHandler()

    await expect(
      callHandler(handler, { planId: 'plan-missing', isFavorite: true }, { id: 'user-b' })
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.favoriteTrainingPlan.upsert).not.toHaveBeenCalled()
  })

  it('denies favoriting a non-template plan', async () => {
    // findFirst constrains isTemplate:true, so a non-template row never matches.
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue(null)
    const handler = await getHandler()

    await expect(
      callHandler(handler, { planId: 'plan-not-template', isFavorite: true }, { id: 'user-b' })
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.trainingPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isTemplate: true })
      })
    )
    expect(prisma.favoriteTrainingPlan.upsert).not.toHaveBeenCalled()
  })

  it('allows favoriting an own template', async () => {
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue({ id: 'plan-own' } as any)
    const handler = await getHandler()

    const result = await callHandler(
      handler,
      { planId: 'plan-own', isFavorite: true },
      { id: 'user-b' }
    )

    expect(result).toEqual({ success: true })
    expect(prisma.favoriteTrainingPlan.upsert).toHaveBeenCalledWith({
      where: { userId_planId: { userId: 'user-b', planId: 'plan-own' } },
      create: { userId: 'user-b', planId: 'plan-own' },
      update: {}
    })
  })

  it('allows favoriting a PUBLIC template', async () => {
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue({ id: 'plan-public' } as any)
    const handler = await getHandler()

    const result = await callHandler(
      handler,
      { planId: 'plan-public', isFavorite: true },
      { id: 'user-b' }
    )

    expect(result).toEqual({ success: true })
    expect(prisma.trainingPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ visibility: 'PUBLIC' }])
        })
      })
    )
    expect(prisma.favoriteTrainingPlan.upsert).toHaveBeenCalled()
  })

  it('allows favoriting a TEAM template for ACTIVE members only', async () => {
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([{ teamId: 'team-1' }] as any)
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue({ id: 'plan-team' } as any)
    const handler = await getHandler()

    const result = await callHandler(
      handler,
      { planId: 'plan-team', isFavorite: true },
      { id: 'user-b' }
    )

    expect(result).toEqual({ success: true })
    expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-b', status: 'ACTIVE' },
      select: { teamId: true }
    })
    expect(prisma.trainingPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ visibility: 'TEAM', teamId: { in: ['team-1'] } }])
        })
      })
    )
    expect(prisma.favoriteTrainingPlan.upsert).toHaveBeenCalled()
  })

  it('denies a TEAM template after membership ends', async () => {
    // Membership query only returns ACTIVE rows; a lapsed member resolves to [].
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([])
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue(null)
    const handler = await getHandler()

    await expect(
      callHandler(handler, { planId: 'plan-team', isFavorite: true }, { id: 'user-b' })
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.favoriteTrainingPlan.upsert).not.toHaveBeenCalled()
  })

  it('allows favoriting a coach template in coaching scope', async () => {
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue({ id: 'plan-coach' } as any)
    const handler = await getHandler()

    const result = await callHandler(
      handler,
      { planId: 'plan-coach', isFavorite: true },
      { id: 'athlete-1', originalUserId: 'coach-1', isCoaching: true }
    )

    expect(result).toEqual({ success: true })
    // Both coaching identities are legitimate owners via the access helper.
    expect(prisma.trainingPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ userId: { in: ['coach-1', 'athlete-1'] } }])
        })
      })
    )
    expect(prisma.favoriteTrainingPlan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_planId: { userId: 'athlete-1', planId: 'plan-coach' } }
      })
    )
  })

  it('does not grant access merely because originalUserId is present', async () => {
    vi.mocked(prisma.trainingPlan.findFirst).mockResolvedValue(null)
    const handler = await getHandler()

    await expect(
      callHandler(
        handler,
        { planId: 'plan-coach-private', isFavorite: true },
        { id: 'athlete-1', originalUserId: 'coach-1' }
      )
    ).rejects.toMatchObject({ statusCode: 404 })

    // Without the coaching flag the helper exposes only the effective user.
    expect(prisma.trainingPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ userId: { in: ['athlete-1'] } }])
        })
      })
    )
    expect(prisma.favoriteTrainingPlan.upsert).not.toHaveBeenCalled()
  })

  it('unfavoriting is an idempotent delete scoped to the session user, even for stale favorites', async () => {
    vi.mocked(prisma.favoriteTrainingPlan.deleteMany).mockResolvedValue({ count: 0 } as any)
    const handler = await getHandler()

    const result = await callHandler(
      handler,
      { planId: 'plan-revoked', isFavorite: false },
      { id: 'user-b' }
    )

    expect(result).toEqual({ success: true })
    // No readability gate on removal: stale inaccessible favorites can be cleared.
    expect(prisma.trainingPlan.findFirst).not.toHaveBeenCalled()
    expect(prisma.favoriteTrainingPlan.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-b', planId: 'plan-revoked' }
    })
  })
})
