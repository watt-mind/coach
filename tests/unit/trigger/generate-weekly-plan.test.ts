import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runGenerateWeeklyPlan } from '../../../trigger/generate-weekly-plan'
import { prisma } from '../../../server/utils/db'

vi.mock('@trigger.dev/sdk/v3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@trigger.dev/sdk/v3')>()
  return {
    ...actual,
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() }
  }
})

vi.mock('../../../server/utils/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    userProfile: { findUnique: vi.fn(), findFirst: vi.fn() },
    plannedWorkout: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn()
    },
    trainingWeek: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    weeklyTrainingPlan: { findFirst: vi.fn(), create: vi.fn(), upsert: vi.fn(), update: vi.fn() },

    report: { findFirst: vi.fn() },
    goal: { findMany: vi.fn() },
    availabilitySchedule: { findMany: vi.fn() },
    trainingAvailability: { findMany: vi.fn(), findFirst: vi.fn() },
    workout: { findMany: vi.fn(), findFirst: vi.fn() },
    wellness: { findMany: vi.fn(), findFirst: vi.fn() },

    sportSettings: { findMany: vi.fn(), upsert: vi.fn() },
    integration: { findMany: vi.fn(), findUnique: vi.fn() }
  }
}))

vi.mock('../../../server/utils/repositories/availabilityRepository', () => ({
  availabilityRepository: {
    getFullSchedule: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue('')
  }
}))

vi.mock('../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: {
    getForUser: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue('')
  }
}))

vi.mock('../../../server/utils/repositories/wellnessRepository', () => ({
  wellnessRepository: {
    getForUser: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue('')
  }
}))

vi.mock('../../../server/utils/training-metrics', () => ({
  generateTrainingContext: vi
    .fn()
    .mockResolvedValue({ summaryText: '', loadTrend: { weeklyTSSAvg: 200 } })
}))

vi.mock('../../../server/utils/gemini', () => ({
  generateStructuredAnalysis: vi
    .fn()
    .mockResolvedValue({ days: [], weekSummary: 'Rest week', totalTSS: 100 })
}))

vi.mock('../../../server/utils/ai-user-settings', () => ({
  getUserAiSettings: vi.fn().mockResolvedValue({ defaultModel: 'flash' })
}))

vi.mock('../../../server/utils/quotas/engine', () => ({
  checkQuota: vi.fn().mockResolvedValue({ allowed: true })
}))

describe('generateWeeklyPlan task', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.userProfile.findFirst).mockResolvedValue(null as any)
    vi.mocked(prisma.weeklyTrainingPlan.findFirst).mockResolvedValue(null as any)
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null as any)
    vi.mocked(prisma.goal.findMany).mockResolvedValue([])
    vi.mocked(prisma.trainingAvailability.findMany).mockResolvedValue([])
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([])
    vi.mocked(prisma.workout.findMany).mockResolvedValue([])
    vi.mocked(prisma.wellness.findMany).mockResolvedValue([])
    vi.mocked(prisma.sportSettings.findMany).mockResolvedValue([])
  })

  it('handles missing user gracefully', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    await expect(
      runGenerateWeeklyPlan({
        userId: 'user-missing',
        startDate: new Date('2026-03-16T00:00:00Z'),
        daysToPlan: 7
      })
    ).rejects.toThrow('User not found')
  })

  describe('volume validation (CW-319)', () => {
    const user = { id: 'user-1', timezone: 'UTC', language: 'English' }
    const trainingWeek = {
      id: 'week-1',
      startDate: new Date('2026-03-16T00:00:00Z'),
      endDate: new Date('2026-03-22T00:00:00Z'),
      volumeTargetMinutes: 300,
      tssTarget: 250,
      weekNumber: 1,
      focus: 'Base',
      block: {
        name: 'Base 1',
        type: 'BASE',
        primaryFocus: 'AEROBIC_ENDURANCE',
        durationWeeks: 3,
        plan: { name: 'Plan', goal: null }
      }
    }

    const day = (date: string, durationMinutes: number, targetTSS = 50) => ({
      date,
      dayOfWeek: 1,
      workoutType: 'Ride',
      title: 'Ride',
      description: 'desc',
      durationMinutes,
      targetTSS,
      intensity: 'easy',
      reasoningText: 'because'
    })

    const overBudgetDays = [day('2026-03-16', 180), day('2026-03-17', 180), day('2026-03-18', 180)] // 540 min vs 300 target
    const compliantDays = [day('2026-03-16', 150), day('2026-03-18', 150)]

    beforeEach(async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(user as any)
      vi.mocked(prisma.sportSettings.upsert).mockResolvedValue({
        id: 'ss-1',
        userId: 'user-1',
        isDefault: true,
        types: [],
        name: 'Default'
      } as any)
      vi.mocked(prisma.trainingWeek.findUnique).mockResolvedValue(trainingWeek as any)
      vi.mocked(prisma.trainingWeek.findFirst).mockResolvedValue(null as any)
      vi.mocked(prisma.weeklyTrainingPlan.create).mockImplementation(
        async ({ data }: any) => ({ id: 'wtp-1', ...data }) as any
      )
      vi.mocked(prisma.plannedWorkout.updateMany).mockResolvedValue({ count: 0 } as any)
      vi.mocked(prisma.plannedWorkout.deleteMany).mockResolvedValue({ count: 0 } as any)
      vi.mocked(prisma.plannedWorkout.createMany).mockResolvedValue({ count: 2 } as any)
    })

    it.each([
      [
        'America/Los_Angeles',
        '2026-11-09',
        '2026-11-15',
        '2026-11-09T08:00:00.000Z',
        '2026-11-16T07:59:59.999Z'
      ],
      ['UTC', '2026-11-09', '2026-11-15', '2026-11-09T00:00:00.000Z', '2026-11-15T23:59:59.999Z'],
      [
        'Pacific/Kiritimati',
        '2026-11-09',
        '2026-11-15',
        '2026-11-08T10:00:00.000Z',
        '2026-11-15T09:59:59.999Z'
      ],
      [
        'America/Los_Angeles',
        '2026-03-02',
        '2026-03-08',
        '2026-03-02T08:00:00.000Z',
        '2026-03-09T06:59:59.999Z'
      ],
      [
        'America/Los_Angeles',
        '2026-10-26',
        '2026-11-01',
        '2026-10-26T07:00:00.000Z',
        '2026-11-02T07:59:59.999Z'
      ]
    ])(
      'preserves persisted calendar days in %s (%s)',
      async (timezone, start, end, utcStart, utcEnd) => {
        const { generateStructuredAnalysis } = await import('../../../server/utils/gemini')
        vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...user, timezone } as any)
        vi.mocked(prisma.trainingWeek.findUnique).mockResolvedValue({
          ...trainingWeek,
          startDate: new Date(start),
          endDate: new Date(end)
        } as any)
        const dates = Array.from({ length: 7 }, (_, i) =>
          new Date(new Date(start).getTime() + i * 86400000).toISOString().slice(0, 10)
        )
        const previous = new Date(new Date(start).getTime() - 86400000).toISOString().slice(0, 10)
        const next = new Date(new Date(end).getTime() + 86400000).toISOString().slice(0, 10)
        vi.mocked(generateStructuredAnalysis).mockResolvedValue({
          days: [previous, ...dates, next].map((date) => day(date, 30)),
          weekSummary: 'Calendar regression',
          totalTSS: 250
        } as any)
        const result = await runGenerateWeeklyPlan({
          userId: user.id,
          trainingWeekId: trainingWeek.id,
          anchorWorkoutIds: ['protected'],
          daysToPlan: 3
        })
        expect(result).toMatchObject({
          success: true,
          weekStart: utcStart,
          weekEnd: utcEnd,
          daysPlanned: 7
        })
        const prompt = vi.mocked(generateStructuredAnalysis).mock.calls[0]![0]
        expect(prompt).toContain('- Start: ' + start)
        expect(prompt).toContain('- End: ' + end)
        const writes = vi.mocked(prisma.plannedWorkout.createMany).mock.calls[0]![0]!.data as any[]
        expect(writes.map((w) => w.date.toISOString().slice(0, 10))).toEqual(dates)
        expect(writes.every((w) => w.trainingWeekId === trainingWeek.id)).toBe(true)
        expect(prisma.plannedWorkout.deleteMany).toHaveBeenCalledWith({
          where: {
            userId: user.id,
            OR: [
              { date: { gte: new Date(start), lte: new Date(end) } },
              { trainingWeekId: trainingWeek.id }
            ],
            completed: false,
            id: { notIn: ['protected'] },
            managedBy: { not: 'USER' }
          }
        })
      }
    )

    it.each([true, false])(
      'retains standalone boundaries and discovers a calendar week: %s',
      async (discover) => {
        const { generateStructuredAnalysis } = await import('../../../server/utils/gemini')
        vi.mocked(prisma.user.findUnique).mockResolvedValue({
          ...user,
          timezone: 'America/Los_Angeles'
        } as any)
        vi.mocked(prisma.trainingWeek.findFirst).mockResolvedValue(
          discover
            ? ({
                ...trainingWeek,
                startDate: new Date('2026-11-08'),
                endDate: new Date('2026-11-14')
              } as any)
            : null
        )
        vi.mocked(generateStructuredAnalysis).mockResolvedValue({
          days: [day('2026-11-08', 30), day('2026-11-14', 30)],
          weekSummary: 'Standalone',
          totalTSS: 100
        } as any)
        const result = await runGenerateWeeklyPlan({
          userId: user.id,
          startDate: '2026-11-10T12:00:00Z',
          daysToPlan: 7
        })
        expect(result).toMatchObject({
          weekStart: '2026-11-08T08:00:00.000Z',
          weekEnd: '2026-11-15T07:59:59.999Z',
          daysPlanned: 7
        })
        expect(prisma.trainingWeek.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              startDate: { lte: new Date('2026-11-08') },
              endDate: { gte: new Date('2026-11-14') }
            })
          })
        )
        const writes = vi.mocked(prisma.plannedWorkout.createMany).mock.calls[0]![0]!.data as any[]
        expect(prisma.plannedWorkout.deleteMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              OR: [{ date: { gte: new Date(result.weekStart), lte: new Date(result.weekEnd) } }],
              completed: false
            })
          })
        )
        expect(writes).toHaveLength(2)
        expect(
          writes.every((w) => w.trainingWeekId === (discover ? trainingWeek.id : undefined))
        ).toBe(true)
      }
    )

    it('retries once with corrective feedback when the generated week exceeds the volume budget', async () => {
      const { generateStructuredAnalysis } = await import('../../../server/utils/gemini')
      vi.mocked(generateStructuredAnalysis)
        .mockResolvedValueOnce({ days: overBudgetDays, weekSummary: 's', totalTSS: 150 } as any)
        .mockResolvedValueOnce({ days: compliantDays, weekSummary: 's', totalTSS: 100 } as any)

      const result = await runGenerateWeeklyPlan({
        userId: 'user-1',
        trainingWeekId: 'week-1',
        daysToPlan: 7
      })

      expect(result.success).toBe(true)
      expect(generateStructuredAnalysis).toHaveBeenCalledTimes(2)
      const retryPrompt = vi.mocked(generateStructuredAnalysis).mock.calls[1]![0] as string
      expect(retryPrompt).toContain('REJECTED')
      // The compliant retry result is the one persisted
      const createArg = vi.mocked(prisma.plannedWorkout.createMany).mock.calls[0]![0] as any
      expect(createArg.data).toHaveLength(2)
      expect(createArg.data[0].durationSec).toBe(150 * 60)
    })

    it('clamps deterministically when the retry is still over budget', async () => {
      const { generateStructuredAnalysis } = await import('../../../server/utils/gemini')
      vi.mocked(generateStructuredAnalysis).mockResolvedValue({
        days: overBudgetDays,
        weekSummary: 's',
        totalTSS: 150
      } as any)

      const result = await runGenerateWeeklyPlan({
        userId: 'user-1',
        trainingWeekId: 'week-1',
        daysToPlan: 7
      })

      expect(result.success).toBe(true)
      expect(generateStructuredAnalysis).toHaveBeenCalledTimes(2)
      const createArg = vi.mocked(prisma.plannedWorkout.createMany).mock.calls[0]![0] as any
      const totalMinutes = createArg.data.reduce(
        (sum: number, w: any) => sum + w.durationSec / 60,
        0
      )
      // 540 scheduled vs 300 target -> scaled to ~300 * 1.1
      expect(totalMinutes).toBeLessThanOrEqual(300 * 1.2)
      expect(totalMinutes).toBeGreaterThan(250)
    })
  })
})
