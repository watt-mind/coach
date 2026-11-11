import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '../../../../../server/utils/db'
import { wellnessRepository } from '../../../../../server/utils/repositories/wellnessRepository'

import { requireAuth } from '../../../../../server/utils/auth-guard'

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

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    dailyMetric: {
      findMany: vi.fn()
    }
  }
}))

vi.mock('../../../../../server/utils/repositories/wellnessRepository', () => ({
  wellnessRepository: {
    getForUser: vi.fn()
  }
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/wellness/trend.get')
  return mod.default
}

describe('GET /api/wellness/trend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as any)
    vi.mocked(prisma.dailyMetric.findMany).mockResolvedValue([] as any)
  })

  it('converts sleepSecs to hours when wellness sleepHours is null', async () => {
    const handler = await getHandler()

    vi.mocked(wellnessRepository.getForUser).mockResolvedValue([
      {
        date: new Date('2026-03-11T00:00:00Z'),
        hrv: null,
        restingHr: null,
        sleepHours: null,
        sleepSecs: 27000,
        sleepScore: 82,
        sleepQuality: null,
        recoveryScore: null,
        readiness: null
      }
    ] as any)

    const result = await handler({
      query: {
        startDate: '2026-03-05',
        endDate: '2026-03-11'
      }
    } as any)

    expect(wellnessRepository.getForUser).toHaveBeenCalledWith('user-1', {
      startDate: new Date('2026-03-05'),
      endDate: new Date('2026-03-11'),
      orderBy: { date: 'asc' }
    })
    expect(result).toEqual([
      expect.objectContaining({
        date: '2026-03-11',
        hoursSlept: 7.5,
        sleepScore: 82
      })
    ])
  })
  it.each([
    [85, 72, 85],
    [null, 72, 72],
    [0, 72, 0],
    [null, 0, 0],
    [null, null, null],
    [null, undefined, undefined]
  ])(
    'uses score sources only (wellness %s, daily %s → %s)',
    async (sleepScore, dailyScore, expected) => {
      const handler = await getHandler()
      vi.mocked(wellnessRepository.getForUser).mockResolvedValue([
        {
          date: new Date('2026-03-11T00:00:00Z'),
          sleepScore,
          sleepQuality: 10,
          sleepHours: null,
          sleepSecs: null
        }
      ] as any)
      vi.mocked(prisma.dailyMetric.findMany).mockResolvedValue(
        dailyScore === undefined
          ? []
          : ([{ date: new Date('2026-03-11T00:00:00Z'), sleepScore: dailyScore }] as any)
      )

      const result = await handler({
        query: { startDate: '2026-03-05', endDate: '2026-03-11' }
      } as any)

      expect(result).toHaveLength(1)
      expect(result[0].sleepScore).toBe(expected)
      const serialized = JSON.parse(JSON.stringify(result))[0]
      if (expected === undefined) {
        expect(serialized).not.toHaveProperty('sleepScore')
      } else {
        expect(serialized.sleepScore).toBe(expected)
      }
    }
  )

  it('retains daily-only rows, date ordering and nullish field merges', async () => {
    const handler = await getHandler()
    vi.mocked(prisma.dailyMetric.findMany).mockResolvedValue([
      {
        date: new Date('2026-03-11T00:00:00Z'),
        hrv: 40,
        restingHr: 60,
        hoursSlept: 8,
        sleepScore: 70,
        recoveryScore: 75
      },
      {
        date: new Date('2026-03-05T00:00:00Z'),
        hrv: 45,
        restingHr: 55,
        hoursSlept: 7,
        sleepScore: 80,
        recoveryScore: 85
      }
    ] as any)
    vi.mocked(wellnessRepository.getForUser).mockResolvedValue([
      {
        date: new Date('2026-03-11T00:00:00Z'),
        hrv: 50,
        restingHr: null,
        sleepHours: 0,
        sleepSecs: 28800,
        sleepScore: null,
        sleepQuality: null,
        recoveryScore: 0,
        readiness: 90
      }
    ] as any)

    const result = await handler({
      query: { startDate: '2026-03-05', endDate: '2026-03-11' }
    } as any)

    expect(result).toEqual([
      {
        date: '2026-03-05',
        hrv: 45,
        restingHr: 55,
        hoursSlept: 7,
        sleepScore: 80,
        recoveryScore: 85
      },
      {
        date: '2026-03-11',
        hrv: 50,
        restingHr: 60,
        hoursSlept: 0,
        sleepScore: 70,
        recoveryScore: 0,
        readiness: 90
      }
    ])
  })
})
