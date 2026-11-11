import { beforeEach, describe, expect, it, vi } from 'vitest'

import { analyzeWorkoutTask } from '../../../trigger/analyze-workout'

const { prisma, updateStatus } = vi.hoisted(() => ({
  prisma: {
    workout: { findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    emailPreference: { findUnique: vi.fn() },
    athleteJourneyEvent: { findMany: vi.fn() }
  },
  updateStatus: vi.fn()
}))

vi.mock('../../../trigger/init', () => ({}))
vi.mock('../../../trigger/queues', () => ({ userAnalysisQueue: {} }))
vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: any) => config,
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../../server/utils/db', () => ({ prisma }))
vi.mock('../../../server/utils/gemini', () => ({ generateStructuredAnalysis: vi.fn() }))
vi.mock('../../../server/utils/repositories/workoutStreamRepository', () => ({
  attachStreamToWorkout: async (workout: any) => workout
}))
vi.mock('../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: { updateStatus }
}))
vi.mock('../../../server/utils/repositories/sportSettingsRepository', () => ({
  sportSettingsRepository: {}
}))
vi.mock('../../../server/utils/date', () => ({
  getUserTimezone: async () => 'UTC',
  getUserLocalDate: () => new Date('2026-11-11T00:00:00Z'),
  formatUserDate: () => '2026-11-11',
  calculateAge: vi.fn()
}))
vi.mock('../../../server/utils/ai-user-settings', () => ({ getUserAiSettings: vi.fn() }))
vi.mock('../../../server/utils/quotas/engine', () => ({ checkQuota: vi.fn() }))
vi.mock('../../../server/utils/services/workout-summary-publish', () => ({
  publishWorkoutSummaryToIntervals: vi.fn()
}))
vi.mock('../../../server/utils/workout-insight-email', () => ({
  queueWorkoutInsightEmail: vi.fn()
}))
vi.mock('../../../server/utils/notifications', () => ({ createUserNotification: vi.fn() }))
vi.mock('../../../server/utils/services/thresholdDetectionService', () => ({
  thresholdDetectionService: {}
}))
vi.mock('../../../server/utils/services/pbDetectionService', () => ({ pbDetectionService: {} }))
vi.mock('../../../server/utils/workout-analysis-facts', () => ({
  buildWorkoutAnalysisFactsV2: vi.fn()
}))
vi.mock('../../../server/utils/services/workout-analysis-prompt', () => ({
  analysisSchema: {},
  buildAnalysisFactsPromptBlock: vi.fn(),
  buildAnalysisGuardrailInstructions: vi.fn(),
  buildWorkoutAnalysisData: vi.fn(),
  buildWorkoutAnalysisPrompt: vi.fn(),
  clampAnalysisScore: vi.fn(),
  getAnalysisSectionsGuidance: vi.fn(),
  getWorkoutTypeGuidance: vi.fn(),
  normalizeRunningCadence: vi.fn()
}))

describe('analysis status when automatic analysis is disabled after enqueue', () => {
  let status: string

  beforeEach(() => {
    vi.clearAllMocks()
    status = 'PENDING'
    prisma.workout.findUnique.mockResolvedValue({
      id: 'workout-1',
      userId: 'athlete-1',
      date: new Date('2026-11-11T09:00:00Z'),
      type: 'Ride',
      exercises: []
    })
    prisma.user.findUnique.mockResolvedValue({ aiAutoAnalyzeWorkouts: false })
    prisma.emailPreference.findUnique.mockResolvedValue(null)
    prisma.athleteJourneyEvent.findMany.mockResolvedValue([])
    prisma.workout.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.id !== 'workout-1' || where.aiAnalysisStatus !== status) return { count: 0 }
      status = data.aiAnalysisStatus
      return { count: 1 }
    })
  })

  it('releases the pending workout when its queued automatic job is skipped', async () => {
    const result = await analyzeWorkoutTask.run({ workoutId: 'workout-1', source: 'AUTOMATIC' })

    expect(result).toEqual({ success: true, skipped: true, reason: 'AUTO_ANALYZE_DISABLED' })
    expect(status).toBe('NOT_STARTED')
    expect(prisma.workout.updateMany).toHaveBeenCalledWith({
      where: { id: 'workout-1', aiAnalysisStatus: 'PENDING' },
      data: { aiAnalysisStatus: 'NOT_STARTED' }
    })
    expect(updateStatus).not.toHaveBeenCalled()
  })

  it.each(['PROCESSING', 'COMPLETED', 'FAILED'])(
    'preserves a concurrent %s status',
    async (next) => {
      status = next
      await analyzeWorkoutTask.run({ workoutId: 'workout-1', source: 'AUTOMATIC' })
      expect(status).toBe(next)
    }
  )

  it.each(['MANUAL', undefined] as const)('does not skip manual analysis (%s)', async (source) => {
    const result = await analyzeWorkoutTask.run({ workoutId: 'workout-1', source })

    expect(result).toEqual({ success: true, skipped: true, reason: 'EMPTY_SESSION' })
    expect(prisma.workout.updateMany).not.toHaveBeenCalled()
    expect(updateStatus).toHaveBeenCalledWith('workout-1', 'SKIPPED_EMPTY')
  })
})
