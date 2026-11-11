import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coachingRepository } from '../../../../server/utils/repositories/coachingRepository'
import { teamRepository } from '../../../../server/utils/repositories/teamRepository'
import {
  assertAnalyticsScopeAccess,
  assertWorkoutComparisonAccess,
  getAccessibleWorkout
} from '../../../../server/utils/analyticsScope'

const { findMany, findUnique, findFirst, userFindUnique } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  userFindUnique: vi.fn()
}))

vi.mock('../../../../server/utils/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    workout: {
      findMany,
      findUnique,
      findFirst
    }
  }
}))

vi.mock('../../../../server/utils/repositories/coachingRepository', () => ({
  coachingRepository: {
    checkRelationship: vi.fn()
  }
}))

vi.mock('../../../../server/utils/repositories/teamRepository', () => ({
  teamRepository: {
    getTeamsForUser: vi.fn().mockResolvedValue([]),
    checkTeamAccess: vi.fn().mockResolvedValue(false),
    checkGroupOwnership: vi.fn().mockResolvedValue(false)
  }
}))

describe('analyticsScope.getAccessibleWorkout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-fetches the resolved workout with owner scope', async () => {
    const { getAccessibleWorkout } = await import('../../../../server/utils/analyticsScope')

    findMany.mockResolvedValue([
      {
        id: 'duplicate-workout',
        userId: 'athlete-1',
        isDuplicate: true,
        duplicateOf: 'canonical-workout'
      }
    ])
    findUnique.mockResolvedValue({
      id: 'canonical-workout',
      userId: 'athlete-1'
    })
    findFirst.mockResolvedValue({
      id: 'canonical-workout',
      userId: 'athlete-1',
      title: 'Scoped workout'
    })

    const result = await getAccessibleWorkout('athlete-1', 'duplicate-workout', {
      select: {
        id: true,
        userId: true,
        title: true
      }
    })

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'canonical-workout' },
      select: { id: true, userId: true }
    })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'canonical-workout',
        userId: 'athlete-1'
      },
      select: {
        id: true,
        userId: true,
        title: true
      }
    })
    expect(result).toEqual({
      id: 'canonical-workout',
      userId: 'athlete-1',
      title: 'Scoped workout'
    })
  })
})

describe('analytics athlete privacy across shared guards', () => {
  afterEach(() => vi.unstubAllGlobals())
  let memberships: Array<{ teamId: string; userId: string; role: string; status: string }>

  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('createError', (options: object) => Object.assign(new Error(), options))
    memberships = [
      { teamId: 'team', userId: 'viewer', role: 'ATHLETE', status: 'ACTIVE' },
      { teamId: 'team', userId: 'private', role: 'ATHLETE', status: 'ACTIVE' }
    ]
    vi.mocked(coachingRepository.checkRelationship).mockResolvedValue(false)
    vi.mocked(teamRepository.getTeamsForUser).mockImplementation(
      async (userId) =>
        memberships.filter((m) => m.userId === userId && m.status === 'ACTIVE') as any
    )
    vi.mocked(teamRepository.checkTeamAccess).mockImplementation(async (teamId, userId, roles) =>
      memberships.some(
        (m) =>
          m.teamId === teamId &&
          m.userId === userId &&
          m.status === 'ACTIVE' &&
          (!roles?.length || roles.includes(m.role as any))
      )
    )
    userFindUnique.mockResolvedValue({ teamVisibility: 'COACHES_ONLY' })
    findMany.mockResolvedValue([
      { id: 'w1', userId: 'private', isDuplicate: false, duplicateOf: null },
      { id: 'w2', userId: 'private', isDuplicate: false, duplicateOf: null }
    ])
    findUnique.mockResolvedValue({ id: 'w1', userId: 'private' })
    findFirst.mockResolvedValue({ id: 'w1', userId: 'private' })
  })

  const paths = [
    [
      'single athlete',
      (viewer: string) =>
        assertAnalyticsScopeAccess(viewer, { target: 'athlete', targetId: 'private' })
    ],
    [
      'multiple athletes',
      (viewer: string) =>
        assertAnalyticsScopeAccess(viewer, { target: 'athletes', targetIds: [viewer, 'private'] })
    ],
    ['workout explorer', (viewer: string) => getAccessibleWorkout(viewer, 'w1')],
    ['workout comparison', (viewer: string) => assertWorkoutComparisonAccess(viewer, ['w1', 'w2'])]
  ] as const

  for (const [name, access] of paths) {
    describe(name, () => {
      beforeEach(() => {
        if (name === 'workout explorer')
          findMany.mockResolvedValue([
            { id: 'w1', userId: 'private', isDuplicate: false, duplicateOf: null }
          ])
      })

      it('rejects an ordinary teammate of a coach-only athlete', async () => {
        await expect(access('viewer')).rejects.toMatchObject({ statusCode: 403 })
        expect(findFirst).not.toHaveBeenCalled()
      })

      it('preserves self access', async () => {
        await access('private')
      })

      it('preserves active direct-coach access', async () => {
        vi.mocked(coachingRepository.checkRelationship).mockResolvedValue(true)
        await access('viewer')
      })

      it.each(['OWNER', 'ADMIN', 'COACH'])('preserves current %s access', async (role) => {
        memberships[0]!.role = role
        await access('viewer')
      })

      it('preserves ordinary teammate access to a team-visible athlete', async () => {
        userFindUnique.mockResolvedValue({ teamVisibility: 'TEAMMATES' })
        await access('viewer')
      })

      it.each([0, 1])('rejects inactive membership %s even for staff', async (index) => {
        memberships[0]!.role = 'COACH'
        memberships[index]!.status = 'INACTIVE'
        await expect(access('viewer')).rejects.toMatchObject({ statusCode: 403 })
      })

      it('rejects a former coach with no active relationship', async () => {
        memberships = []
        await expect(access('viewer')).rejects.toMatchObject({ statusCode: 403 })
      })
    })
  }

  it('rejects missing or unset visibility for ordinary teammates', async () => {
    for (const user of [null, { teamVisibility: null }]) {
      userFindUnique.mockResolvedValue(user)
      await expect(
        assertAnalyticsScopeAccess('viewer', { target: 'athlete', targetId: 'private' })
      ).rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('preserves self scope', async () => {
    await assertAnalyticsScopeAccess('viewer', { target: 'self' })
    expect(coachingRepository.checkRelationship).not.toHaveBeenCalled()
  })
})
