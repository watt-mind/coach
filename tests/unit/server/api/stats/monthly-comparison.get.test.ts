import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAuth } from '../../../../../server/utils/auth-guard'
import { getEffectiveUserId } from '../../../../../server/utils/coaching'
import { getUserLocalDate, getUserTimezone } from '../../../../../server/utils/date'

const { workoutRepositoryMock, prismaMock } = vi.hoisted(() => ({
  workoutRepositoryMock: {
    getForUser: vi.fn()
  },
  prismaMock: {
    plannedWorkout: {
      findMany: vi.fn()
    }
  }
}))

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', () => {})
vi.stubGlobal('getQuery', (event: any) => event.query || {})
vi.stubGlobal('getHeader', (event: any, name: string) => event.headers?.[name])
vi.stubGlobal('getCookie', (event: any, name: string) => event.cookies?.[name])
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message)
  ;(error as any).statusCode = err.statusCode
  return error
})

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: vi.fn()
}))

vi.mock('../../../../../server/utils/coaching', () => ({
  getEffectiveUserId: vi.fn()
}))

vi.mock('../../../../../server/utils/date', async () => {
  const actual = await vi.importActual<typeof import('../../../../../server/utils/date')>(
    '../../../../../server/utils/date'
  )

  return {
    ...actual,
    getUserTimezone: vi.fn(),
    getUserLocalDate: vi.fn()
  }
})

vi.mock('../../../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: workoutRepositoryMock
}))

vi.mock('../../../../../server/utils/db', () => ({
  prisma: prismaMock
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/stats/monthly-comparison.get')
  return mod.default
}

describe('GET /api/stats/monthly-comparison', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as any)
    vi.mocked(getEffectiveUserId).mockResolvedValue('user-1')
    vi.mocked(getUserTimezone).mockResolvedValue('America/New_York')
    vi.mocked(getUserLocalDate).mockReturnValue(new Date('2026-04-08T00:00:00Z'))
    vi.mocked(workoutRepositoryMock.getForUser).mockResolvedValue([] as any)
    vi.mocked(prismaMock.plannedWorkout.findMany).mockResolvedValue([] as any)
  })

  it('uses adjacent local months for labels and completed workout query bounds', async () => {
    const handler = await getHandler()

    const result = await handler({ query: { sport: 'all' } } as any)

    expect(result.currentMonth.name).toBe('April')
    expect(result.lastMonth.name).toBe('March')

    expect(workoutRepositoryMock.getForUser).toHaveBeenNthCalledWith(
      1,
      'user-1',
      expect.objectContaining({
        startDate: new Date('2026-04-01T04:00:00.000Z'),
        endDate: new Date('2026-05-01T03:59:59.999Z')
      })
    )

    expect(workoutRepositoryMock.getForUser).toHaveBeenNthCalledWith(
      2,
      'user-1',
      expect.objectContaining({
        startDate: new Date('2026-03-01T05:00:00.000Z'),
        endDate: new Date('2026-04-01T03:59:59.999Z')
      })
    )

    expect(prismaMock.plannedWorkout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          date: {
            gte: new Date('2026-04-01T00:00:00.000Z'),
            lte: new Date('2026-04-30T00:00:00.000Z')
          }
        })
      })
    )
  })
  it.each(
    ['America/Los_Angeles', 'UTC', 'Asia/Tokyo'].flatMap((timezone) =>
      [1, 11].map((day) => ({ timezone, day }))
    )
  )(
    'preserves calendar days and cumulative totals for $timezone November $day',
    async ({ timezone, day }) => {
      vi.mocked(getUserTimezone).mockResolvedValue(timezone)
      vi.mocked(getUserLocalDate).mockReturnValue(new Date(Date.UTC(2026, 10, day)))
      const metrics = { tss: 25, durationSec: 3600, distanceMeters: 10000 }
      prismaMock.plannedWorkout.findMany.mockResolvedValue([
        { date: new Date('2026-11-01T00:00:00Z'), ...metrics },
        { date: new Date('2026-11-11T00:00:00Z'), ...metrics }
      ])
      const localNoon = timezone === 'Asia/Tokyo' ? '03' : timezone === 'UTC' ? '12' : '20'
      workoutRepositoryMock.getForUser
        .mockResolvedValueOnce([
          {
            date: new Date(`2026-11-${String(day).padStart(2, '0')}T${localNoon}:00:00Z`),
            ...metrics,
            elevationGain: 120
          }
        ])
        .mockResolvedValueOnce([])
      const result = await (await getHandler())({ query: { sport: 'all' } } as any)
      expect(result.todayDay).toBe(day)
      expect(result.timezone).toBe(timezone)
      expect(result.currentMonth.days).toBe(30)
      expect(result.lastMonth.days).toBe(31)
      expect(result.currentMonth.plannedDaily[1].tss).toBe(25)
      expect(result.currentMonth.plannedDaily[11].tss).toBe(25)
      expect(result.currentMonth.plannedDaily[31].count).toBe(0)
      expect(result.currentMonth.plannedCumulative[10].tss).toBe(25)
      expect(result.currentMonth.plannedCumulative[11].tss).toBe(50)
      expect(result.currentMonth.cumulative[day]).toEqual({
        tss: 25,
        duration: 1,
        distance: 10,
        elevation: 120,
        count: 1
      })
      expect(result.currentMonth.cumulative[day + 1]).toBeNull()
    }
  )

  it.each([
    { timezone: 'America/Los_Angeles', date: '2026-11-02T07:59:59Z', day: 1 },
    { timezone: 'America/Los_Angeles', date: '2026-11-02T08:00:00Z', day: 2 },
    { timezone: 'America/Los_Angeles', date: '2026-11-01T08:30:00Z', day: 1 },
    { timezone: 'America/Los_Angeles', date: '2026-11-01T09:30:00Z', day: 1 },
    { timezone: 'Asia/Tokyo', date: '2026-11-01T15:00:00Z', day: 2 },
    { timezone: 'UTC', date: '2026-11-01T23:59:59Z', day: 1 }
  ])('buckets completed timestamp $date locally in $timezone', async ({ timezone, date, day }) => {
    vi.mocked(getUserTimezone).mockResolvedValue(timezone)
    vi.mocked(getUserLocalDate).mockReturnValue(new Date('2026-11-11T00:00:00Z'))
    workoutRepositoryMock.getForUser
      .mockResolvedValueOnce([{ date: new Date(date), tss: 30 }])
      .mockResolvedValueOnce([])
    const result = await (await getHandler())({ query: {} } as any)
    expect(result.currentMonth.daily[day].tss).toBe(30)
    expect(result.currentMonth.cumulative[11].tss).toBe(30)
  })

  it('keeps LA DST month bounds, calendar plan bounds and effective-user sport filters', async () => {
    vi.mocked(getEffectiveUserId).mockResolvedValue('athlete-2')
    vi.mocked(getUserTimezone).mockResolvedValue('America/Los_Angeles')
    vi.mocked(getUserLocalDate).mockReturnValue(new Date('2026-11-01T00:00:00Z'))
    await (
      await getHandler()
    )({ query: { sport: 'Ride' } } as any)
    expect(getUserTimezone).toHaveBeenCalledWith('athlete-2')
    expect(workoutRepositoryMock.getForUser).toHaveBeenNthCalledWith(
      1,
      'athlete-2',
      expect.objectContaining({
        startDate: new Date('2026-11-01T07:00:00Z'),
        endDate: new Date('2026-12-01T07:59:59.999Z'),
        includeDuplicates: false,
        where: { type: 'Ride' }
      })
    )
    expect(workoutRepositoryMock.getForUser).toHaveBeenNthCalledWith(
      2,
      'athlete-2',
      expect.objectContaining({
        startDate: new Date('2026-10-01T07:00:00Z'),
        endDate: new Date('2026-11-01T06:59:59.999Z')
      })
    )
    expect(prismaMock.plannedWorkout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'athlete-2',
          type: 'Ride',
          date: {
            gte: new Date('2026-11-01T00:00:00Z'),
            lte: new Date('2026-11-30T00:00:00Z')
          }
        }
      })
    )
  })
})
