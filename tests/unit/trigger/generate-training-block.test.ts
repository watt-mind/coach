import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGenerateTrainingBlock } from '../../../trigger/generate-training-block'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  processDelete: vi.fn(),
  structure: vi.fn(),
  prisma: {
    trainingBlock: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    report: { findFirst: vi.fn() },
    plannedWorkout: { findMany: vi.fn() },
    syncQueue: { updateMany: vi.fn() },
    $transaction: vi.fn()
  },
  tx: {
    trainingBlock: { findUnique: vi.fn() },
    trainingWeek: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    plannedWorkout: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn()
    },
    syncQueue: { create: vi.fn() }
  }
}))

vi.mock('../../../trigger/init', () => ({}))
vi.mock('../../../trigger/queues', () => ({ userReportsQueue: {} }))
vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  task: vi.fn((definition) => definition)
}))
vi.mock('../../../server/utils/task-registry', () => ({ registerTaskHandler: vi.fn() }))
vi.mock('../../../server/utils/db', () => ({ prisma: mocks.prisma }))
vi.mock('../../../server/utils/gemini', () => ({ generateStructuredAnalysis: mocks.generate }))
vi.mock('../../../server/utils/intervals-sync', () => ({
  processSyncQueueItem: mocks.processDelete
}))
vi.mock('../../../server/utils/intervals', () => ({
  isIntervalsEventId: (value: string | null) => /^\d+$/.test(value || '')
}))
vi.mock('../../../server/utils/planned-workout-structure-trigger', () => ({
  enqueuePlannedWorkoutStructureGeneration: mocks.structure
}))
vi.mock('../../../server/utils/ai-user-settings', () => ({
  getUserAiSettings: vi.fn().mockResolvedValue({ aiPersona: 'Coach', aiModelPreference: 'flash' })
}))
vi.mock('../../../server/utils/training-stress', () => ({
  getCurrentFitnessSummary: vi.fn().mockResolvedValue({
    ctl: 40,
    atl: 40,
    tsb: 0,
    formStatus: { description: 'Fresh' }
  })
}))
vi.mock('../../../server/utils/repositories/availabilityRepository', () => ({
  availabilityRepository: {
    getFullSchedule: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue('')
  }
}))
vi.mock('../../../server/utils/date', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/utils/date')>()),
  getUserTimezone: vi.fn().mockResolvedValue('UTC')
}))

type QueueItem = {
  id: string
  entityId: string
  operation: string
  status: string
  payload: { externalId: string }
  structureRevision: number | null
}

const oldWorkout = (id: string, externalId: string, extra = {}) => ({
  id,
  userId: 'user-1',
  externalId,
  managedBy: 'COACH_WATTS',
  trainingWeekId: 'old-week-1',
  publishTargets: [] as Array<{ provider: string; externalId: string }>,
  ...extra
})

describe('training block replacement Intervals cleanup (CW-754)', () => {
  let inTransaction: boolean
  let failCommit: boolean
  let pendingQueue: QueueItem[]
  let committedQueue: QueueItem[]
  let replacedRows: ReturnType<typeof oldWorkout>[]

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.processDelete.mockReset()
    mocks.prisma.syncQueue.updateMany.mockReset()
    mocks.tx.syncQueue.create.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T08:00:00Z'))
    inTransaction = false
    failCommit = false
    pendingQueue = []
    committedQueue = []
    replacedRows = [
      oldWorkout('legacy', '123'),
      oldWorkout('published', 'ai-gen-old', {
        publishTargets: [
          { provider: 'garmin', externalId: '999' },
          { provider: 'intervals', externalId: '456' }
        ]
      }),
      oldWorkout('anchor', '321'),
      oldWorkout('user-owned', '444', { managedBy: 'USER' }),
      oldWorkout('other-block', '555', { trainingWeekId: 'other-week' }),
      oldWorkout('local', 'ai-gen-local'),
      oldWorkout('third-party', '666', { managedBy: 'GARMIN' }),
      oldWorkout('garmin-only', 'ai-gen-garmin', {
        publishTargets: [{ provider: 'garmin', externalId: '777' }]
      })
    ]
    mocks.prisma.trainingBlock.findUnique.mockResolvedValue({
      id: 'block-1',
      name: 'Base',
      type: 'BASE',
      primaryFocus: 'AEROBIC_ENDURANCE',
      durationWeeks: 1,
      startDate: new Date('2026-10-12T00:00:00Z'),
      weeks: [{ weekNumber: 1, volumeTargetMinutes: 300 }],
      plan: {
        recoveryRhythm: 4,
        goal: { title: 'Race', events: [] },
        blocks: [{ id: 'block-1', durationWeeks: 1 }]
      }
    })
    mocks.prisma.user.findUnique.mockResolvedValue({ language: 'English' })
    mocks.prisma.report.findFirst.mockResolvedValue(null)
    mocks.prisma.plannedWorkout.findMany.mockResolvedValue([
      {
        id: 'anchor',
        date: new Date('2026-10-12T00:00:00Z'),
        title: 'Anchor',
        type: 'Ride'
      }
    ])
    mocks.generate.mockResolvedValue({
      weeks: [
        {
          weekNumber: 1,
          workouts: [
            {
              dayOfWeek: 2,
              title: 'New ride',
              type: 'Ride',
              durationMinutes: 60,
              intensity: 'easy'
            }
          ]
        }
      ]
    })
    mocks.tx.trainingBlock.findUnique.mockResolvedValue({ id: 'block-1' })
    mocks.tx.trainingWeek.findMany.mockResolvedValue([{ id: 'old-week-1' }])
    mocks.tx.trainingWeek.create.mockResolvedValue({ id: 'new-week-1' })
    mocks.tx.plannedWorkout.findMany.mockImplementation(async ({ where, select }) => {
      expect(inTransaction).toBe(true)
      if (typeof where.trainingWeekId === 'string') return [{ id: 'created-1' }]
      expect(where).toEqual(
        mocks.tx.plannedWorkout.deleteMany.mock.calls[0]?.[0].where || {
          trainingWeekId: { in: ['old-week-1'] },
          id: { notIn: ['anchor'] },
          managedBy: { not: 'USER' }
        }
      )
      expect(select.publishTargets.where).toEqual({ provider: 'intervals' })
      return replacedRows
        .filter(
          (row) =>
            where.trainingWeekId.in.includes(row.trainingWeekId) &&
            !where.id.notIn.includes(row.id) &&
            row.managedBy !== 'USER'
        )
        .map((row) => ({
          ...row,
          publishTargets: row.publishTargets.filter((target) => target.provider === 'intervals')
        }))
    })
    mocks.tx.syncQueue.create.mockImplementation(async ({ data }) => {
      expect(inTransaction).toBe(true)
      const item = { ...data, id: `delete-${pendingQueue.length}` }
      pendingQueue.push(item)
      return item
    })
    mocks.tx.plannedWorkout.deleteMany.mockImplementation(async () => {
      expect(inTransaction).toBe(true)
      return { count: 5 }
    })
    mocks.prisma.$transaction.mockImplementation(async (callback) => {
      inTransaction = true
      try {
        await callback(mocks.tx)
        if (failCommit) throw new Error('Transaction rolled back')
        committedQueue.push(...pendingQueue)
      } finally {
        inTransaction = false
      }
    })
    mocks.prisma.syncQueue.updateMany.mockImplementation(async ({ where, data }) => {
      expect(inTransaction).toBe(false)
      const item = committedQueue.find(
        (item) => item.id === where.id && item.status === where.status
      )
      if (!item) return { count: 0 }
      item.status = data.status
      return { count: 1 }
    })
    mocks.processDelete.mockImplementation(async (item) => {
      expect(inTransaction).toBe(false)
      expect(committedQueue).toContainEqual(item)
      expect(item.status).toBe('PENDING')
      item.status = 'COMPLETED'
      return true
    })
    mocks.structure.mockResolvedValue({ status: 'queued' })
  })

  afterEach(() => vi.useRealTimers())

  const regenerate = () =>
    runGenerateTrainingBlock({
      userId: 'user-1',
      blockId: 'block-1',
      anchorWorkoutIds: ['anchor'],
      triggerStructureForWeekNumber: 1
    })

  it('writes exact remote identities before local deletion and processes only committed outbox items', async () => {
    await regenerate()

    expect(mocks.tx.syncQueue.create.mock.calls.map(([{ data }]) => data)).toEqual([
      {
        userId: 'user-1',
        entityType: 'planned_workout',
        entityId: 'legacy',
        operation: 'DELETE',
        structureRevision: null,
        payload: { externalId: '123' },
        status: 'PENDING',
        attempts: 0
      },
      {
        userId: 'user-1',
        entityType: 'planned_workout',
        entityId: 'published',
        operation: 'DELETE',
        structureRevision: null,
        payload: { externalId: '456' },
        status: 'PENDING',
        attempts: 0
      }
    ])
    expect(mocks.tx.syncQueue.create.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.tx.plannedWorkout.deleteMany.mock.invocationCallOrder[0]!
    )
    expect(mocks.processDelete).toHaveBeenCalledTimes(2)
    expect(mocks.prisma.syncQueue.updateMany).not.toHaveBeenCalled()
    expect(committedQueue.every((item) => item.status === 'COMPLETED')).toBe(true)
    expect(mocks.structure).toHaveBeenCalledTimes(1)
  })

  it('does not call the provider or persist outbox rows after rollback', async () => {
    failCommit = true
    await expect(regenerate()).rejects.toThrow('Transaction rolled back')

    expect(mocks.tx.syncQueue.create).toHaveBeenCalledTimes(2)
    expect(committedQueue).toEqual([])
    expect(mocks.processDelete).not.toHaveBeenCalled()
    expect(mocks.prisma.syncQueue.updateMany).not.toHaveBeenCalled()
  })

  it('keeps provider failures retryable without failing committed generation or structure', async () => {
    mocks.processDelete.mockImplementation(async (item) => {
      item.status = 'PENDING'
      return false
    })
    const result = await regenerate()

    expect(result.success).toBe(true)
    expect(mocks.processDelete).toHaveBeenCalledTimes(2)
    expect(committedQueue.every((item) => item.status === 'PENDING')).toBe(true)
    expect(mocks.structure).toHaveBeenCalledTimes(1)
  })

  it('leaves deletion pending when processing throws and continues other deletions', async () => {
    mocks.processDelete.mockRejectedValueOnce(new Error('Retry processor unavailable'))
    const result = await regenerate()

    expect(result.success).toBe(true)
    expect(mocks.processDelete).toHaveBeenCalledTimes(2)
    expect(committedQueue.map((item) => item.status)).toEqual(['PENDING', 'COMPLETED'])
    expect(mocks.prisma.syncQueue.updateMany).not.toHaveBeenCalled()
    expect(mocks.structure).toHaveBeenCalledTimes(1)
  })

  it('cannot delete local rows if saving the deletion outbox fails', async () => {
    mocks.tx.syncQueue.create.mockRejectedValueOnce(new Error('Outbox unavailable'))
    await expect(regenerate()).rejects.toThrow('Outbox unavailable')

    expect(mocks.tx.plannedWorkout.deleteMany).not.toHaveBeenCalled()
    expect(committedQueue).toEqual([])
    expect(mocks.processDelete).not.toHaveBeenCalled()
  })
})
