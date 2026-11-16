import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runGenerateAdHocWorkout,
  generateAdHocWorkoutTask
} from '../../../trigger/generate-ad-hoc-workout'
import { executeRegisteredTask } from '../../../server/utils/task-registry'

const m = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  find: vi.fn(),
  create: vi.fn(),
  ai: vi.fn(),
  upload: vi.fn(),
  queue: vi.fn()
}))
vi.mock('../../../trigger/init', () => ({}))
vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: { log: vi.fn(), warn: vi.fn() },
  task: (definition: any) => definition
}))
vi.mock('../../../server/utils/db', () => ({
  prisma: {
    plannedWorkout: { findUnique: m.find, create: m.create },
    user: { findUnique: vi.fn(async () => ({})) },
    report: { findFirst: vi.fn(async () => null) },
    goal: { findMany: vi.fn(async () => []) }
  }
}))
vi.mock('../../../server/utils/gemini', () => ({
  generateStructuredAnalysis: m.ai,
  buildWorkoutSummary: vi.fn()
}))
vi.mock('../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: { getForUser: vi.fn(async () => []) }
}))
vi.mock('../../../server/utils/repositories/wellnessRepository', () => ({
  wellnessRepository: { getByDate: vi.fn(async () => null) }
}))
vi.mock('../../../server/utils/repositories/sportSettingsRepository', () => ({
  sportSettingsRepository: { getForActivityType: vi.fn(async () => null) }
}))
vi.mock('../../../server/utils/date', async (original) => ({
  ...(await original<any>()),
  getUserTimezone: vi.fn(async () => 'America/Los_Angeles')
}))
vi.mock('../../../server/utils/intervals-sync', () => ({
  autoUploadPlannedWorkoutToIntervalsIfEnabled: m.upload
}))
vi.mock('../../../server/utils/planned-workout-structure-trigger', () => ({
  enqueuePlannedWorkoutStructureGeneration: m.queue
}))

const payload = { userId: 'athlete', date: '2026-11-11T02:00:00Z' }
beforeEach(() => {
  vi.clearAllMocks()
  m.rows.clear()
  m.find.mockImplementation(async ({ where }) => m.rows.get(where.id) || null)
  m.create.mockImplementation(async ({ data }) => {
    data = { ...data, id: data.id || `local-${m.rows.size}` }
    if (m.rows.has(data.id)) throw new Error('unique constraint')
    const row = { ...data, startTime: null }
    m.rows.set(row.id, row)
    return row
  })
  m.ai.mockResolvedValue({
    title: 'Endurance',
    description: 'Easy',
    type: 'Ride',
    durationMinutes: 60,
    targetTss: 40,
    objective: 'Aerobic',
    executionCues: ['Relax'],
    reasoningText: 'Ready',
    intensity: 'Endurance'
  })
  m.upload.mockResolvedValue({ attempted: false, synced: false })
  m.queue.mockResolvedValue({ status: 'queued', runId: 'structure' })
})
describe('durable ad-hoc generation', () => {
  it.each(['integration lookup', 'post-provider database update'])(
    'reuses committed creation after %s rejection',
    async (boundary) => {
      m.upload.mockRejectedValueOnce(new Error(boundary))
      const first = await executeRegisteredTask('generate-ad-hoc-workout', payload, {
        runId: 'retry'
      })
      // Provider IDs may overwrite externalId; the immutable receipt still works.
      m.rows.get(first.plannedWorkoutId).externalId = '12345'
      const retry = await runGenerateAdHocWorkout(payload, { runId: 'retry' })
      expect(retry.plannedWorkoutId).toBe(first.plannedWorkoutId)
      expect(m.rows.size).toBe(1)
      expect(m.create).toHaveBeenCalledTimes(1)
      expect(m.ai).toHaveBeenCalledTimes(1)
      expect(m.upload).toHaveBeenCalledTimes(1)
    }
  )
  it('arbitrates concurrent attempts using the database identity', async () => {
    const results = await Promise.all(
      [1, 2].map(() => runGenerateAdHocWorkout(payload, { runId: 'concurrent' }))
    )
    expect(results[0].plannedWorkoutId).toBe(results[1].plannedWorkoutId)
    expect(m.rows.size).toBe(1)
    expect(m.upload).toHaveBeenCalledTimes(1)
  })
  it('keeps independent identical requests distinct, including direct calls', async () => {
    const results = await Promise.all([
      runGenerateAdHocWorkout(payload, { runId: 'one' }),
      runGenerateAdHocWorkout(payload, { runId: 'two' }),
      runGenerateAdHocWorkout(payload),
      runGenerateAdHocWorkout(payload)
    ])
    expect(new Set(results.map((r) => r.plannedWorkoutId)).size).toBe(4)
    expect(m.rows.size).toBe(4)
  })
  it.each([false, true])(
    'preserves generation and upload preferences (enabled=%s)',
    async (enabled) => {
      m.upload.mockResolvedValue({ attempted: enabled, synced: enabled })
      const result = await runGenerateAdHocWorkout(payload, { runId: 'success' })
      expect(result).toMatchObject({
        success: true,
        structure_generation: 'queued',
        run_id: 'structure'
      })
      expect(m.upload).toHaveBeenCalledTimes(1)
      expect([...m.rows.values()][0]).toMatchObject({
        date: new Date('2026-11-10T00:00:00Z'),
        managedBy: 'COACH_WATTS',
        syncStatus: 'LOCAL_ONLY'
      })
    }
  )
  it.each(['throw', 'failed'])(
    'returns structure failure without recreating (%s)',
    async (mode) => {
      if (mode === 'throw') m.queue.mockRejectedValueOnce(new Error('queue down'))
      else m.queue.mockResolvedValueOnce({ status: 'failed', error: 'queue down' })
      const first = await runGenerateAdHocWorkout(payload, { runId: 'queue' })
      expect(first).toMatchObject({
        success: true,
        structure_generation: 'failed',
        structure_error: 'queue down'
      })
      const retry = await runGenerateAdHocWorkout(payload, { runId: 'queue' })
      expect(retry.plannedWorkoutId).toBe(first.plannedWorkoutId)
      expect(m.create).toHaveBeenCalledTimes(1)
      expect(m.upload).toHaveBeenCalledTimes(1)
    }
  )
  it('propagates pre-create AI and database failures', async () => {
    m.ai.mockRejectedValueOnce(new Error('AI down'))
    await expect(runGenerateAdHocWorkout(payload, { runId: 'failure' })).rejects.toThrow('AI down')
    m.create.mockRejectedValueOnce(new Error('database down'))
    await expect(runGenerateAdHocWorkout(payload, { runId: 'failure' })).rejects.toThrow(
      'database down'
    )
    expect(m.rows.size).toBe(0)
    expect(m.upload).not.toHaveBeenCalled()
  })
  it('passes Trigger execution identity through its adapter', async () => {
    const run = (generateAdHocWorkoutTask as any).run
    const first = await run(payload, { ctx: { run: { id: 'trigger-run' } } })
    const retry = await run(payload, { ctx: { run: { id: 'trigger-run' } } })
    expect(retry.plannedWorkoutId).toBe(first.plannedWorkoutId)
    expect(m.rows.size).toBe(1)
  })
})
