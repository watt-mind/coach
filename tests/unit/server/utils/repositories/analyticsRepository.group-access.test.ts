import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  analyticsRepository,
  type AnalyticsQueryOptions
} from '../../../../../server/utils/repositories/analyticsRepository'

const db = vi.hoisted(() => ({
  athleteGroup: { findUnique: vi.fn() },
  coachingRelationship: { findMany: vi.fn() }
}))
vi.mock('../../../../../server/utils/db', () => ({ prisma: db }))

const scope = { target: 'athlete_group' as const, targetId: 'group' }
const sources = ['workouts', 'wellness', 'nutrition'] as const
const fields = { workouts: 'tss', wellness: 'hrv', nutrition: 'calories' }
function options(source: AnalyticsQueryOptions['source']): AnalyticsQueryOptions {
  return {
    source,
    scope,
    grouping: 'daily',
    timeRange: { startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') },
    metrics: [{ field: fields[source], aggregation: 'sum' }]
  }
}

describe('private group analytics access', () => {
  let relationships: Array<{ coachId: string; athleteId: string; status: string }>
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    relationships = [{ coachId: 'coach', athleteId: 'athlete', status: 'ACTIVE' }]
    db.athleteGroup.findUnique.mockResolvedValue({
      coachId: 'coach',
      teamId: null,
      members: [{ athleteId: 'athlete' }]
    })
    db.coachingRelationship.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        relationships
          .filter(
            (r) =>
              r.coachId === where.coachId &&
              r.status === where.status &&
              where.athleteId.in.includes(r.athleteId)
          )
          .map((r) => ({ athleteId: r.athleteId }))
      )
    )
  })

  it.each(sources)('stops querying %s after the only athlete disconnects', async (source) => {
    const aggregate = vi.spyOn(analyticsRepository, 'executeAggregatedQuery').mockResolvedValue([])
    await analyticsRepository.query('coach', options(source))
    expect(aggregate).toHaveBeenCalledWith('coach', ['athlete'], options(source))
    aggregate.mockClear()
    relationships = []
    expect(await analyticsRepository.query('coach', options(source))).toEqual({
      labels: [],
      datasets: []
    })
    expect(aggregate).not.toHaveBeenCalled()
  })

  it.each(sources)('excludes disconnected athletes and newly recorded %s data', async (source) => {
    db.athleteGroup.findUnique.mockResolvedValue({
      teamId: null,
      members: [
        { athleteId: 'athlete' },
        { athleteId: 'disconnected' },
        { athleteId: 'pending' },
        { athleteId: 'other-coach' }
      ]
    })
    relationships.push(
      { coachId: 'coach', athleteId: 'pending', status: 'PENDING' },
      { coachId: 'someone-else', athleteId: 'other-coach', status: 'ACTIVE' }
    )
    const records = [
      { userId: 'athlete', value: 10 },
      { userId: 'disconnected', value: 100 }
    ]
    const aggregate = vi
      .spyOn(analyticsRepository, 'executeAggregatedQuery')
      .mockImplementation(async (_coach, ids) => [
        {
          bucket: new Date('2026-11-01'),
          metric_0: records
            .filter((r) => ids.includes(r.userId))
            .reduce((sum, r) => sum + r.value, 0)
        }
      ])
    const before = await analyticsRepository.query('coach', options(source))
    records.push({ userId: 'disconnected', value: 1000 })
    expect(await analyticsRepository.query('coach', options(source))).toEqual(before)
    expect(before.datasets[0]?.data).toEqual([10])
    expect(aggregate).toHaveBeenLastCalledWith('coach', ['athlete'], options(source))
  })

  it('returns no data for missing and empty groups', async () => {
    const aggregate = vi.spyOn(analyticsRepository, 'executeAggregatedQuery').mockResolvedValue([])
    for (const group of [null, { teamId: null, members: [] }]) {
      db.athleteGroup.findUnique.mockResolvedValue(group)
      expect(await analyticsRepository.query('coach', options('wellness'))).toEqual({
        labels: [],
        datasets: []
      })
    }
    expect(aggregate).not.toHaveBeenCalled()
  })

  it('preserves team-group members without requiring direct coaching relationships', async () => {
    relationships = []
    db.athleteGroup.findUnique.mockResolvedValue({
      teamId: 'team',
      members: [{ athleteId: 'team-athlete' }]
    })
    expect(await analyticsRepository.resolveTargetUserIds('coach', scope)).toEqual(['team-athlete'])
    expect(db.coachingRelationship.findMany).not.toHaveBeenCalled()
  })
})
