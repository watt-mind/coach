import { beforeEach, expect, it, vi } from 'vitest'
import { deduplicateWorkoutsTask } from '../../../trigger/deduplicate-workouts'
const mocks = vi.hoisted(() => ({ groups: vi.fn(), merge: vi.fn() }))
vi.mock('../../../trigger/init', () => ({}))
vi.mock('../../../trigger/queues', () => ({ userBackgroundQueue: {} }))
vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: any) => config,
  logger: { log: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../server/utils/db', () => ({ prisma: {} }))
vi.mock('../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: { getForUser: async () => [] }
}))
vi.mock('../../../server/utils/repositories/workoutStreamRepository', () => ({
  attachStreamsToWorkouts: async (rows: any) => rows
}))
vi.mock('../../../server/utils/calculate-workout-stress', () => ({
  recalculateStressAfterDate: vi.fn()
}))
vi.mock('../../../server/utils/workout-analysis-enqueue', () => ({
  enqueueAutomaticWorkoutAnalysesForUser: vi.fn()
}))
vi.mock('../../../server/utils/services/deduplicationService', () => ({
  deduplicationService: {
    findDuplicateGroups: mocks.groups,
    mergeDuplicateGroup: mocks.merge,
    findProposedLink: vi.fn()
  }
}))
const groups = ['a', 'b', 'c'].map((id) => ({
  bestWorkoutId: id,
  workouts: [{ id, plannedWorkoutId: 'plan', date: '2026-01-01' }],
  toDelete: []
}))
const run = (payload = {}) => (deduplicateWorkoutsTask as any).run({ userId: 'user', ...payload })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.groups.mockReturnValue(groups)
})
it.each([true, false])('returns zero for empty groups (dryRun=%s)', async (dryRun) => {
  mocks.groups.mockReturnValue([])
  expect(await run({ dryRun })).toMatchObject({
    groupsSkipped: 0,
    workoutsDeleted: 0,
    workoutsKept: 0
  })
})
it('reports zero for a dry scan without merging', async () => {
  expect(await run({ dryRun: true })).toMatchObject({ groupsSkipped: 0 })
  expect(mocks.merge).not.toHaveBeenCalled()
})
it.each([0, 1, 3])('preserves totals and continues after %s skipped groups', async (skips) => {
  mocks.merge.mockImplementation(async () =>
    mocks.merge.mock.calls.length <= skips
      ? { skipped: true, deletedCount: 0, keptCount: 0 }
      : { deletedCount: 2, keptCount: 1 }
  )
  expect(await run()).toMatchObject({
    groupsSkipped: skips,
    workoutsDeleted: (3 - skips) * 2,
    workoutsKept: 3 - skips
  })
  expect(mocks.merge).toHaveBeenCalledTimes(3)
})
it('does not count excluded targets as skipped', async () => {
  mocks.merge.mockResolvedValue({ deletedCount: 2, keptCount: 1 })
  expect(await run({ targetBestWorkoutIds: ['b'] })).toMatchObject({
    groupsSkipped: 0,
    workoutsDeleted: 2,
    workoutsKept: 1
  })
  expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(groups[1])
})
