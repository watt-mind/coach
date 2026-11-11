import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  prismaWellnessFindUnique,
  prismaWellnessUpdate,
  prismaUserFindUnique,
  historyMock,
  checkQuotaMock,
  generateStructuredAnalysisMock
} = vi.hoisted(() => ({
  prismaWellnessFindUnique: vi.fn(),
  prismaWellnessUpdate: vi.fn(),
  prismaUserFindUnique: vi.fn(),
  historyMock: vi.fn().mockResolvedValue([]),
  checkQuotaMock: vi.fn(),
  generateStructuredAnalysisMock: vi.fn()
}))

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    wellness: {
      findUnique: prismaWellnessFindUnique,
      update: prismaWellnessUpdate
    },
    user: {
      findUnique: prismaUserFindUnique
    },
    goal: { findMany: vi.fn().mockResolvedValue([]) },
    plannedWorkout: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null)
    },
    trainingAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    weeklyTrainingPlan: { findFirst: vi.fn().mockResolvedValue(null) },
    integration: { findUnique: vi.fn().mockResolvedValue(null) },
    calendarNote: { findMany: vi.fn().mockResolvedValue([]) },
    athleteJourneyEvent: { findMany: vi.fn().mockResolvedValue([]) }
  }
}))

vi.mock('../../../../../server/utils/quotas/engine', () => ({
  checkQuota: checkQuotaMock
}))

vi.mock('../../../../../server/utils/ai-user-settings', () => ({
  getUserAiSettings: vi.fn().mockResolvedValue({
    aiPersona: 'Supportive',
    aiModelPreference: 'gemini-2.0-flash-exp'
  })
}))

vi.mock('../../../../../server/utils/date', async () => {
  const actual = await vi.importActual<typeof import('../../../../../server/utils/date')>(
    '../../../../../server/utils/date'
  )

  return {
    ...actual,
    getUserTimezone: vi.fn().mockResolvedValue('UTC'),
    getUserLocalDate: vi.fn(() => new Date('2026-03-10T00:00:00.000Z'))
  }
})

vi.mock('../../../../../server/utils/repositories/wellnessRepository', () => ({
  wellnessRepository: {
    getForUser: historyMock
  }
}))

vi.mock('../../../../../server/utils/repositories/sportSettingsRepository', () => ({
  sportSettingsRepository: {
    getByUserId: vi.fn().mockResolvedValue([])
  }
}))

vi.mock('../../../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: {
    getForUser: vi.fn().mockResolvedValue([])
  }
}))

vi.mock('../../../../../server/utils/repositories/nutritionRepository', () => ({
  nutritionRepository: {
    getForUser: vi.fn().mockResolvedValue([])
  }
}))

vi.mock('../../../../../server/utils/training-metrics', () => ({
  generateTrainingContext: vi.fn().mockResolvedValue({}),
  formatTrainingContextForPrompt: vi.fn().mockReturnValue('Mocked Training Context')
}))

vi.mock('../../../../../server/utils/services/wellnessEventService', () => ({
  getWellnessEventOverlaysForUser: vi.fn().mockResolvedValue([]),
  getActiveWellnessEventsForDate: vi.fn(() => []),
  formatWellnessEventsForPrompt: vi.fn(() => '')
}))

vi.mock('../../../../../server/utils/services/checkin-service', () => ({
  triggerDailyCheckinIfNeeded: vi.fn()
}))

vi.mock('../../../../../server/utils/gemini', () => ({
  generateStructuredAnalysis: generateStructuredAnalysisMock
}))

vi.mock('../../../../../trigger/init', () => ({}))

vi.mock('../../../../../trigger/queues', () => ({
  userReportsQueue: {}
}))

vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  },
  task: vi.fn((config) => config)
}))

describe('analyzeWellness quota enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaWellnessFindUnique.mockResolvedValue({
      id: 'wellness-1',
      date: new Date('2026-03-09T00:00:00.000Z'),
      hrv: 55,
      restingHr: 50,
      sleepHours: 7.5,
      recoveryScore: 80,
      readiness: 8,
      spO2: 98,
      weight: 70,
      rawJson: {}
    })
    prismaWellnessUpdate.mockResolvedValue({})
    checkQuotaMock.mockResolvedValue(undefined)
    generateStructuredAnalysisMock.mockResolvedValue({
      executive_summary: 'Ready',
      status: 'READY',
      sections: [],
      recommendations: []
    })
    prismaUserFindUnique.mockResolvedValue({
      name: 'Athlete',
      language: 'English',
      timezone: 'UTC',
      aiPersona: 'Supportive',
      nutritionTrackingEnabled: false
    })
  })

  it('marks wellness analysis as QUOTA_EXCEEDED when quota is exceeded', async () => {
    const { analyzeWellness } =
      await import('../../../../../server/utils/services/wellness-analysis')

    const quotaError = Object.assign(new Error('Quota exceeded for wellness_analysis'), {
      statusCode: 429
    })
    checkQuotaMock.mockRejectedValue(quotaError)

    const result = await analyzeWellness('wellness-1', 'user-1')

    expect(checkQuotaMock).toHaveBeenCalledWith('user-1', 'wellness_analysis')
    expect(prismaWellnessUpdate).toHaveBeenCalledWith({
      where: { id: 'wellness-1' },
      data: { aiAnalysisStatus: 'QUOTA_EXCEEDED' }
    })
    expect(result).toEqual({ success: false, reason: 'QUOTA_EXCEEDED' })
  })

  it.each([
    {
      weightUnits: 'Pounds',
      expectedWeight: '154.3 lbs',
      unexpectedWeight: '70.00lbs'
    },
    {
      weightUnits: 'Kilograms',
      expectedWeight: '70.0 kg',
      unexpectedWeight: '154.3 lbs'
    }
  ])(
    'formats stored kilograms as $weightUnits across every fixed AI prompt',
    async ({ weightUnits, expectedWeight, unexpectedWeight }) => {
      prismaUserFindUnique.mockResolvedValue({
        name: 'Athlete',
        language: 'English',
        timezone: 'UTC',
        aiPersona: 'Supportive',
        nutritionTrackingEnabled: false,
        weight: 70,
        weightUnits
      })

      const { buildAthleteContext } =
        await import('../../../../../server/utils/services/chatContextService')
      const { context } = await buildAthleteContext('user-1')

      const { buildDailyCoachUserInfo } = await import('../../../../../trigger/daily-coach')
      const { buildAnalysisPrompt: buildThreeDayNutritionPrompt } =
        await import('../../../../../trigger/analyze-last-3-nutrition')
      const { buildAnalysisPrompt: buildSevenDayNutritionPrompt } =
        await import('../../../../../trigger/analyze-last-7-nutrition')

      const prompts = [
        context,
        buildDailyCoachUserInfo({ weight: 70, weightUnits }),
        buildThreeDayNutritionPrompt([], { weight: 70, weightUnits }, 'UTC'),
        buildSevenDayNutritionPrompt([], { weight: 70, weightUnits }, 'UTC')
      ]

      for (const prompt of prompts) {
        expect(prompt).toContain(expectedWeight)
        expect(prompt).not.toContain(unexpectedWeight)
      }

      const { analyzeWellness } =
        await import('../../../../../server/utils/services/wellness-analysis')
      await analyzeWellness('wellness-1', 'user-1')

      const wellnessPrompt = generateStructuredAnalysisMock.mock.calls.at(-1)?.[0]
      expect(wellnessPrompt).toContain(`Weight ${expectedWeight}`)
      expect(wellnessPrompt).not.toContain(unexpectedWeight)
    }
  )
})

describe('analyzeWellness skin temperature formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkQuotaMock.mockResolvedValue({
      operation: 'wellness_analysis',
      allowed: true,
      used: 0,
      limit: Infinity,
      remaining: Infinity,
      window: 'none',
      resetsAt: null,
      enforcement: 'MEASURE'
    })
    prismaWellnessFindUnique.mockResolvedValue({
      id: 'wellness-1',
      date: new Date('2026-03-09T00:00:00.000Z'),
      hrv: 55,
      restingHr: 50,
      sleepHours: 7.5,
      recoveryScore: 80,
      readiness: 8,
      rawJson: { skinTemp: 33.5 }
    })
  })

  it('formats skin temperature in Fahrenheit for a Fahrenheit-preference athlete', async () => {
    prismaUserFindUnique.mockResolvedValue({
      language: 'English',
      temperatureUnits: 'Fahrenheit'
    })

    const { generateStructuredAnalysis } = await import('../../../../../server/utils/gemini')
    const { analyzeWellness } =
      await import('../../../../../server/utils/services/wellness-analysis')

    ;(generateStructuredAnalysis as any).mockResolvedValue({
      executive_summary: 'ok',
      status: 'READY',
      sections: [],
      recommendations: []
    })

    await analyzeWellness('wellness-1', 'user-1')

    expect(generateStructuredAnalysis).toHaveBeenCalled()
    const prompt = (generateStructuredAnalysis as any).mock.calls[0][0] as string
    // 33.5C -> 92.3F
    expect(prompt).toContain('Skin Temp: 92.3°F')
    expect(prompt).not.toContain('Skin Temp: 33.5°C')
  })

  it('formats skin temperature in Celsius for a metric-preference athlete (unaffected)', async () => {
    prismaUserFindUnique.mockResolvedValue({
      language: 'English',
      temperatureUnits: 'Celsius'
    })

    const { generateStructuredAnalysis } = await import('../../../../../server/utils/gemini')
    const { analyzeWellness } =
      await import('../../../../../server/utils/services/wellness-analysis')

    ;(generateStructuredAnalysis as any).mockResolvedValue({
      executive_summary: 'ok',
      status: 'READY',
      sections: [],
      recommendations: []
    })

    await analyzeWellness('wellness-1', 'user-1')

    const prompt = (generateStructuredAnalysis as any).mock.calls[0][0] as string
    expect(prompt).toContain('Skin Temp: 33.5°C')
  })
})

describe('analyzeWellness sleep duration', () => {
  const record = {
    id: 'wellness-1',
    date: new Date('2026-03-10T00:00:00.000Z'),
    hrv: null,
    restingHr: null,
    recoveryScore: null,
    readiness: null,
    sleepHours: null,
    sleepSecs: null,
    rawJson: null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    historyMock.mockResolvedValue([])
    prismaWellnessFindUnique.mockResolvedValue({ ...record })
    prismaWellnessUpdate.mockResolvedValue({})
    prismaUserFindUnique.mockResolvedValue({ language: 'English' })
    checkQuotaMock.mockResolvedValue(undefined)
    generateStructuredAnalysisMock.mockResolvedValue({
      executive_summary: 'Ready',
      status: 'READY',
      sections: [],
      recommendations: []
    })
  })

  it.each([
    { sleepHours: null, sleepSecs: 28800, expected: 8 },
    { sleepHours: 7.5, sleepSecs: null, expected: 7.5 },
    { sleepHours: 6, sleepSecs: 28800, expected: 6 },
    { sleepHours: 0, sleepSecs: 28800, expected: 0 },
    { sleepHours: null, sleepSecs: 0, expected: 0 }
  ])(
    'analyzes hours=$sleepHours seconds=$sleepSecs as $expected hours',
    async ({ sleepHours, sleepSecs, expected }) => {
      prismaWellnessFindUnique.mockResolvedValue({ ...record, sleepHours, sleepSecs })
      const { analyzeWellness } =
        await import('../../../../../server/utils/services/wellness-analysis')
      const result = await analyzeWellness('wellness-1', 'user-1')

      expect(result.success).toBe(true)
      expect(checkQuotaMock).toHaveBeenCalledWith('user-1', 'wellness_analysis')
      expect(generateStructuredAnalysisMock).toHaveBeenCalledTimes(1)
      expect(generateStructuredAnalysisMock.mock.calls[0][0]).toContain(
        `- Sleep: ${expected} hours`
      )
      expect(prismaWellnessUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ aiAnalysisStatus: 'COMPLETED' })
        })
      )
    }
  )

  it('projects seconds and uses hours-first durations in history and averages, including zero', async () => {
    prismaWellnessFindUnique.mockResolvedValue({ ...record, sleepSecs: 28800 })
    historyMock.mockResolvedValue([
      { ...record, date: new Date('2026-03-06'), sleepSecs: 28800 },
      { ...record, date: new Date('2026-03-07'), sleepHours: 6, sleepSecs: 36000 },
      { ...record, date: new Date('2026-03-08'), sleepHours: 0, sleepSecs: 36000 },
      { ...record, date: new Date('2026-03-09'), sleepHours: 7 },
      { ...record }
    ])
    const { analyzeWellness } =
      await import('../../../../../server/utils/services/wellness-analysis')
    await analyzeWellness('wellness-1', 'user-1')

    expect(historyMock).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        select: expect.objectContaining({ sleepHours: true, sleepSecs: true })
      })
    )
    const prompt = generateStructuredAnalysisMock.mock.calls[0][0]
    expect(prompt).toContain('- 2026-03-06: Sleep:8.0h')
    expect(prompt).toContain('- 2026-03-07: Sleep:6.0h')
    expect(prompt).toContain('- 2026-03-08: Sleep:0.0h')
    expect(prompt).toContain('- 2026-03-09: Sleep:7.0h')
    expect(prompt).not.toContain('- 2026-03-10: Sleep:')
    expect(prompt).toContain('Average Sleep: 5.3 hours')
  })

  it('keeps truly empty records skipped before quota or analysis', async () => {
    const { analyzeWellness } =
      await import('../../../../../server/utils/services/wellness-analysis')
    expect(await analyzeWellness('wellness-1', 'user-1')).toEqual({
      success: true,
      skipped: true,
      reason: 'EMPTY_RECORD'
    })
    expect(prismaWellnessUpdate).toHaveBeenCalledWith({
      where: { id: 'wellness-1' },
      data: { aiAnalysisStatus: 'SKIPPED_EMPTY' }
    })
    expect(checkQuotaMock).not.toHaveBeenCalled()
    expect(generateStructuredAnalysisMock).not.toHaveBeenCalled()
  })

  it('still skips future seconds-only records before quota or analysis', async () => {
    prismaWellnessFindUnique.mockResolvedValue({
      ...record,
      date: new Date('2026-03-11'),
      sleepSecs: 28800
    })
    const { analyzeWellness } =
      await import('../../../../../server/utils/services/wellness-analysis')
    expect(await analyzeWellness('wellness-1', 'user-1')).toEqual({
      success: true,
      skipped: true,
      reason: 'FUTURE_DATE'
    })
    expect(prismaWellnessUpdate).toHaveBeenCalledWith({
      where: { id: 'wellness-1' },
      data: { aiAnalysisStatus: 'NOT_STARTED' }
    })
    expect(checkQuotaMock).not.toHaveBeenCalled()
    expect(generateStructuredAnalysisMock).not.toHaveBeenCalled()
  })

  it('still enforces quota for seconds-only records', async () => {
    prismaWellnessFindUnique.mockResolvedValue({ ...record, sleepSecs: 28800 })
    checkQuotaMock.mockRejectedValue(
      Object.assign(new Error('Quota exceeded'), { statusCode: 429 })
    )
    const { analyzeWellness } =
      await import('../../../../../server/utils/services/wellness-analysis')
    expect(await analyzeWellness('wellness-1', 'user-1')).toEqual({
      success: false,
      reason: 'QUOTA_EXCEEDED'
    })
    expect(prismaWellnessUpdate).toHaveBeenCalledWith({
      where: { id: 'wellness-1' },
      data: { aiAnalysisStatus: 'QUOTA_EXCEEDED' }
    })
    expect(generateStructuredAnalysisMock).not.toHaveBeenCalled()
  })
})
