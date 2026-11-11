import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workoutRepository } from '../../../../../server/utils/repositories/workoutRepository'
import { prisma } from '../../../../../server/utils/db'

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: vi.fn().mockResolvedValue({ id: 'user', ftp: 280 })
}))
vi.mock('h3', () => ({
  defineEventHandler: (handler: unknown) => handler,
  getQuery: () => ({ months: '12' }),
  createError: vi.fn()
}))
vi.mock('../../../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: { getForUser: vi.fn() }
}))
vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    workoutStreamV2: { findMany: vi.fn() },
    workoutStream: { findMany: vi.fn() }
  }
}))

describe('FTP stream storage compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('defineRouteMeta', vi.fn())
  })

  it.each(['v2', 'v1', 'absent'])('estimates and validates with %s streams', async (storage) => {
    const workout = { id: 'ride', date: new Date(), durationSec: 7200, averageWatts: 180 }
    vi.mocked(workoutRepository.getForUser)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([workout] as any)
      .mockResolvedValueOnce([workout] as any)
    const rows = [{ workoutId: 'ride', watts: Array(1200).fill(320) }]
    vi.mocked(prisma.workoutStreamV2.findMany).mockResolvedValue(
      storage === 'v2' ? (rows as any) : []
    )
    vi.mocked(prisma.workoutStream.findMany).mockResolvedValue(
      storage === 'v1' ? (rows as any) : []
    )
    const handler = (await import('../../../../../server/api/performance/ftp-evolution.get'))
      .default
    const result = await handler({} as any)
    expect(result.estimatedData[0]?.estimatedFtp).toBe(storage === 'absent' ? 180 : 304)
    expect(result.freshness.state).toBe(storage === 'absent' ? 'unknown' : 'fresh')
    expect(workoutRepository.getForUser).toHaveBeenNthCalledWith(
      2,
      'user',
      expect.objectContaining({
        includeDuplicates: false,
        orderBy: { date: 'asc' }
      })
    )
    for (const [, options] of vi.mocked(workoutRepository.getForUser).mock.calls) {
      expect(options).not.toHaveProperty('include.streams')
    }
  })
})
