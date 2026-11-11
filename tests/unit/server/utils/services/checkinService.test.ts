import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runGenerateDailyCheckin,
  getCheckinHistoryContext,
  triggerDailyCheckinIfNeeded
} from '../../../../../server/utils/services/checkin-service'
import { dailyCheckinRepository } from '../../../../../server/utils/repositories/dailyCheckinRepository'
import { hasTaskHandler, getTaskHandler } from '../../../../../server/utils/task-registry'
import * as dispatcher from '../../../../../server/utils/task-dispatcher'

vi.mock('../../../../../server/utils/repositories/dailyCheckinRepository', () => ({
  dailyCheckinRepository: {
    getByDate: vi.fn(),
    getHistory: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn()
  }
}))

vi.mock('../../../../../server/utils/repositories/auditLogRepository', () => ({
  auditLogRepository: {
    log: vi.fn().mockResolvedValue({})
  }
}))

vi.mock('../../../../../server/utils/date', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
  getUserLocalDate: vi.fn().mockReturnValue(new Date('2026-03-15T00:00:00Z')),
  formatDateUTC: vi.fn((date) =>
    date instanceof Date ? date.toISOString().split('T')[0] : '2026-03-15'
  ),
  formatUserDate: vi.fn(() => '2026-03-15'),
  calculateAge: vi.fn().mockReturnValue(30)
}))

vi.mock('../../../../../server/utils/task-dispatcher', () => ({
  dispatchTask: vi.fn().mockResolvedValue({ id: 'task_123' })
}))

describe('Daily Check-in Service', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('registers generate-daily-checkin task handler automatically', () => {
    expect(hasTaskHandler('generate-daily-checkin')).toBe(true)
    expect(getTaskHandler('generate-daily-checkin')).toBe(runGenerateDailyCheckin)
  })

  it('returns false when check-in already exists for today in triggerDailyCheckinIfNeeded', async () => {
    vi.mocked(dailyCheckinRepository.getByDate).mockResolvedValueOnce({ id: 'c1' } as any)

    const result = await triggerDailyCheckinIfNeeded('u123')

    expect(result).toEqual({ triggered: false, reason: 'Daily check-in already exists for today' })
    expect(dispatcher.dispatchTask).not.toHaveBeenCalled()
  })

  it('dispatches generate-daily-checkin task when check-in is missing in triggerDailyCheckinIfNeeded', async () => {
    vi.mocked(dailyCheckinRepository.getByDate).mockResolvedValueOnce(null)

    const result = await triggerDailyCheckinIfNeeded('u123')

    expect(result).toEqual({ triggered: true })
    expect(dispatcher.dispatchTask).toHaveBeenCalledWith(
      'generate-daily-checkin',
      expect.objectContaining({ userId: 'u123', source: 'auto' }),
      expect.objectContaining({ concurrencyKey: 'u123' })
    )
  })

  it('formats past check-in history context properly', async () => {
    vi.mocked(dailyCheckinRepository.getHistory).mockResolvedValueOnce([
      {
        date: new Date('2026-03-14T00:00:00Z'),
        userNotes: 'Feeling fresh today',
        questions: [{ text: 'Any muscle soreness?', answer: 'No' }]
      }
    ] as any)

    const historyStr = await getCheckinHistoryContext(
      'u123',
      new Date('2026-03-08T00:00:00Z'),
      new Date('2026-03-14T00:00:00Z'),
      'UTC'
    )

    expect(historyStr).toContain('[2026-03-14]')
    expect(historyStr).toContain('* Q: "Any muscle soreness?"')
    expect(historyStr).toContain('A: No')
    expect(historyStr).toContain('User Notes: "Feeling fresh today"')
  })
})

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    plannedWorkout: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn() },
    report: { findFirst: vi.fn() },
    goal: { findMany: vi.fn().mockResolvedValue([]) },
    trainingPlan: { findFirst: vi.fn() },
    event: { findMany: vi.fn().mockResolvedValue([]) },
    calendarNote: { findMany: vi.fn().mockResolvedValue([]) },
    athleteJourneyEvent: { findMany: vi.fn().mockResolvedValue([]) },
    dailyCheckin: { findUnique: vi.fn().mockResolvedValue({ id: 'checkin' }) },
    workoutStreamV2: { findMany: vi.fn().mockResolvedValue([]) },
    workoutStream: { findMany: vi.fn().mockResolvedValue([]) }
  }
}))
vi.mock('../../../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: { getForUser: vi.fn().mockResolvedValue([]) }
}))
vi.mock('../../../../../server/utils/repositories/wellnessRepository', () => ({
  wellnessRepository: { getByDate: vi.fn() }
}))
vi.mock('../../../../../server/utils/ai-user-settings', () => ({
  getUserAiSettings: vi.fn().mockResolvedValue({})
}))
vi.mock('../../../../../server/utils/training-stress', () => ({
  getCurrentFitnessSummary: vi.fn().mockResolvedValue({ ctl: 0, atl: 0 }),
  calculateProjectedPMC: vi.fn().mockReturnValue([])
}))
vi.mock('../../../../../server/utils/gemini', () => ({
  generateStructuredAnalysis: vi.fn().mockResolvedValue({ questions: [] }),
  buildWorkoutSummary: vi.fn()
}))

describe('check-in stream context', () => {
  it.each(['v2', 'v1', 'absent'])('reads baseline zone context from %s', async (storage) => {
    vi.clearAllMocks()
    const { prisma } = await import('../../../../../server/utils/db')
    const { workoutRepository } =
      await import('../../../../../server/utils/repositories/workoutRepository')
    const { getUserAiSettings } = await import('../../../../../server/utils/ai-user-settings')
    const { getCurrentFitnessSummary, calculateProjectedPMC } =
      await import('../../../../../server/utils/training-stress')
    vi.mocked(getUserAiSettings).mockResolvedValue({} as any)
    vi.mocked(getCurrentFitnessSummary).mockResolvedValue({ ctl: 0, atl: 0 } as any)
    vi.mocked(calculateProjectedPMC).mockReturnValue([])
    for (const model of ['goal', 'event', 'calendarNote', 'athleteJourneyEvent'] as const) {
      vi.mocked(prisma[model].findMany).mockResolvedValue([])
    }
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([])
    vi.mocked(dailyCheckinRepository.getHistory).mockResolvedValue([])
    vi.mocked(workoutRepository.getForUser).mockResolvedValue([
      { id: 'ride', date: new Date() }
    ] as any)
    const rows = [{ workoutId: 'ride', hrZoneTimes: [100], powerZoneTimes: [200] }]
    vi.mocked(prisma.workoutStreamV2.findMany).mockResolvedValue(
      storage === 'v2' ? (rows as any) : []
    )
    vi.mocked(prisma.workoutStream.findMany).mockResolvedValue(
      storage === 'v1' ? (rows as any) : []
    )
    const { generateStructuredAnalysis } = await import('../../../../../server/utils/gemini')
    vi.mocked(generateStructuredAnalysis).mockResolvedValue({ questions: [] } as any)
    vi.mocked(prisma.dailyCheckin.findUnique).mockResolvedValue({ id: 'checkin' } as any)
    const result = await runGenerateDailyCheckin({
      userId: 'user',
      checkinId: 'checkin',
      source: 'auto',
      date: new Date('2026-03-15')
    })
    expect(result.success).toBe(true)
    expect(prisma.workoutStreamV2.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workoutId: { in: ['ride'] } },
        select: expect.objectContaining({ hrZoneTimes: true, powerZoneTimes: true })
      })
    )
    const query = vi.mocked(prisma.workoutStreamV2.findMany).mock.calls[0]?.[0] as any
    expect(query.select).not.toHaveProperty('cadence')
    if (storage !== 'v2') expect(prisma.workoutStream.findMany).toHaveBeenCalled()
  })
})
