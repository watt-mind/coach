import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { runGenerateTrainingBlock } from '../../../trigger/generate-training-block'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  upload: vi.fn(),
  structure: vi.fn(),
  prisma: {
    trainingBlock: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    report: { findFirst: vi.fn() },
    plannedWorkout: { findMany: vi.fn() },
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
    }
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
  autoUploadPlannedWorkoutToIntervalsIfEnabled: mocks.upload
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

type Workout = {
  id: string
  userId: string
  externalId: string
  trainingWeekId: string | null
  date: Date
  title: string
  type: string
  managedBy: string
  durationSec?: number
}

const workout = (dayOfWeek: number, title: string, type = 'Ride') => ({
  dayOfWeek,
  title,
  description: 'Steady endurance',
  type,
  durationMinutes: type === 'Rest' ? 0 : 60,
  tssEstimate: 40,
  intensity: 'easy'
})

describe('training block Intervals auto-upload (CW-751)', () => {
  let committed: Workout[]
  let pending: Workout[]
  let inTransaction: boolean
  let failCommit: boolean
  let anchor: Workout

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T08:00:00Z'))
    inTransaction = false
    failCommit = false
    pending = []
    anchor = {
      id: 'anchor-1',
      userId: 'user-1',
      externalId: '123456',
      trainingWeekId: 'old-week-1',
      date: new Date('2026-10-12T00:00:00Z'),
      title: 'Locked ride',
      type: 'Ride',
      managedBy: 'COACH_WATTS',
      durationSec: 3600
    }
    committed = [
      anchor,
      { ...anchor, id: 'user-owned', externalId: 'user-owned', managedBy: 'USER' },
      { ...anchor, id: 'other-block', externalId: 'ai-gen-other', trainingWeekId: 'other' },
      { ...anchor, id: 'other-user', userId: 'user-2', externalId: 'ai-gen-other-user' }
    ]
    mocks.prisma.trainingBlock.findUnique.mockResolvedValue({
      id: 'block-1',
      name: 'Base',
      type: 'BASE',
      primaryFocus: 'AEROBIC_ENDURANCE',
      durationWeeks: 2,
      startDate: new Date('2026-10-12T00:00:00Z'),
      weeks: [1, 2].map((weekNumber) => ({ weekNumber, volumeTargetMinutes: 300 })),
      plan: {
        recoveryRhythm: 4,
        goal: { title: 'Race', events: [] },
        blocks: [{ id: 'block-1', durationWeeks: 2 }]
      }
    })
    mocks.prisma.user.findUnique.mockResolvedValue({ language: 'English' })
    mocks.prisma.report.findFirst.mockResolvedValue(null)
    mocks.generate.mockResolvedValue({
      weeks: [
        { weekNumber: 1, workouts: [workout(1, 'Monday'), workout(2, 'Tuesday')] },
        { weekNumber: 2, workouts: [workout(1, 'Next Monday'), workout(3, 'Next Wednesday')] }
      ]
    })
    mocks.tx.trainingBlock.findUnique.mockResolvedValue({ id: 'block-1' })
    mocks.tx.trainingWeek.findMany.mockResolvedValue([{ id: 'old-week-1' }])
    mocks.tx.trainingWeek.create.mockImplementation(async ({ data }) => ({
      ...data,
      id: `new-week-${data.weekNumber}`
    }))
    mocks.tx.plannedWorkout.createMany.mockImplementation(async ({ data }) => {
      expect(inTransaction).toBe(true)
      pending.push(
        ...data.map((row: Workout, index: number) => ({
          ...row,
          id: `created-${pending.length + index}`
        }))
      )
      return { count: data.length }
    })
    mocks.tx.plannedWorkout.findMany.mockImplementation(async ({ where }) =>
      pending.filter(
        (row) => row.trainingWeekId === where.trainingWeekId && !where.type.notIn.includes(row.type)
      )
    )
    mocks.prisma.plannedWorkout.findMany.mockImplementation(async ({ where }) => {
      if (where.id) return [anchor]
      expect(inTransaction).toBe(false)
      return committed.filter(
        (row) => row.userId === where.userId && where.externalId.in.includes(row.externalId)
      )
    })
    mocks.prisma.$transaction.mockImplementation(async (callback) => {
      inTransaction = true
      try {
        await callback(mocks.tx)
        if (failCommit) throw new Error('Transaction rolled back')
        committed.push(...pending)
      } finally {
        inTransaction = false
      }
    })
    mocks.upload.mockImplementation(async (row: Workout) => {
      expect(inTransaction).toBe(false)
      expect(committed).toContainEqual(row)
      return { success: true, synced: true }
    })
    mocks.structure.mockResolvedValue({ status: 'queued' })
  })

  afterEach(() => vi.useRealTimers())

  it('uploads every generated week after commit without requesting workout structure', async () => {
    await runGenerateTrainingBlock({ userId: 'user-1', blockId: 'block-1' })

    expect(mocks.upload.mock.calls.map(([row]) => row.title)).toEqual([
      'Monday',
      'Tuesday',
      'Next Monday',
      'Next Wednesday'
    ])
    const externalIds = mocks.tx.plannedWorkout.createMany.mock.calls.flatMap(([{ data }]) =>
      data.map((row: Workout) => row.externalId)
    )
    expect(mocks.prisma.plannedWorkout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', externalId: { in: externalIds } } })
    )
    expect(mocks.structure).not.toHaveBeenCalled()
  })

  it('regeneration uploads new workouts only, excluding anchors and unrelated rows', async () => {
    await runGenerateTrainingBlock({
      userId: 'user-1',
      blockId: 'block-1',
      anchorWorkoutIds: [anchor.id]
    })

    expect(mocks.upload.mock.calls.map(([row]) => row.title)).toEqual([
      'Tuesday',
      'Next Monday',
      'Next Wednesday'
    ])
    expect(mocks.tx.plannedWorkout.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [anchor.id] } },
      data: { trainingWeekId: 'new-week-1' }
    })
    expect(mocks.upload.mock.calls.every(([row]) => row.id.startsWith('created-'))).toBe(true)
    expect(mocks.structure).not.toHaveBeenCalled()
  })

  it('keeps structure generation restricted to the requested week and non-rest workouts', async () => {
    mocks.generate.mockResolvedValue({
      weeks: [
        { weekNumber: 1, workouts: [workout(1, 'Ride'), workout(2, 'Rest', 'Rest')] },
        { weekNumber: 2, workouts: [workout(1, 'Next Monday')] }
      ]
    })
    await runGenerateTrainingBlock({
      userId: 'user-1',
      blockId: 'block-1',
      triggerStructureForWeekNumber: 1
    })

    expect(mocks.upload).toHaveBeenCalledTimes(3)
    expect(mocks.structure).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      plannedWorkoutId: pending.find((row) => row.title === 'Ride')?.id,
      source: 'block'
    })
  })

  it('never contacts the provider or queues structure when the transaction rolls back', async () => {
    failCommit = true
    await expect(
      runGenerateTrainingBlock({
        userId: 'user-1',
        blockId: 'block-1',
        triggerStructureForWeekNumber: 1
      })
    ).rejects.toThrow('Transaction rolled back')

    expect(mocks.tx.plannedWorkout.createMany).toHaveBeenCalledTimes(2)
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.structure).not.toHaveBeenCalled()
  })

  it('continues publishing and queuing structure after a recoverable provider failure', async () => {
    mocks.upload.mockResolvedValueOnce({
      attempted: true,
      synced: false,
      error: 'Provider unavailable; upload queued for retry'
    })
    const result = await runGenerateTrainingBlock({
      userId: 'user-1',
      blockId: 'block-1',
      triggerStructureForWeekNumber: 1
    })

    expect(result.success).toBe(true)
    expect(mocks.upload).toHaveBeenCalledTimes(4)
    expect(mocks.structure).toHaveBeenCalledTimes(2)
  })

  it('does not fail committed generation if one upload helper unexpectedly throws', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('Upload state unavailable'))
    const result = await runGenerateTrainingBlock({
      userId: 'user-1',
      blockId: 'block-1',
      triggerStructureForWeekNumber: 1
    })

    expect(result.success).toBe(true)
    expect(mocks.upload).toHaveBeenCalledTimes(4)
    expect(mocks.structure).toHaveBeenCalledTimes(2)
    expect(mocks.tx.plannedWorkout.createMany).toHaveBeenCalledTimes(2)
  })

  it('does not upload anything if the block was deleted during generation', async () => {
    mocks.tx.trainingBlock.findUnique.mockResolvedValue(null)
    await runGenerateTrainingBlock({ userId: 'user-1', blockId: 'block-1' })

    expect(mocks.tx.plannedWorkout.createMany).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(mocks.prisma.plannedWorkout.findMany).not.toHaveBeenCalled()
  })
})
