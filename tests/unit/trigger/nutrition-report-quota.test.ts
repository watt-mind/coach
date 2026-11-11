import { beforeEach, describe, expect, it, vi } from 'vitest'

const { generateStructuredAnalysis } = vi.hoisted(() => ({
  generateStructuredAnalysis: vi.fn()
}))

const { reportUpdate, userFindUnique, txReportUpdate, reportNutritionCreateMany } = vi.hoisted(
  () => ({
    reportUpdate: vi.fn(),
    userFindUnique: vi.fn(),
    txReportUpdate: vi.fn(),
    reportNutritionCreateMany: vi.fn()
  })
)

const { nutritionGetForUser } = vi.hoisted(() => ({
  nutritionGetForUser: vi.fn()
}))

vi.mock('../../../trigger/init', () => ({}))

vi.mock('../../../server/utils/db', () => ({
  prisma: {
    report: { update: reportUpdate },
    user: { findUnique: userFindUnique },
    $transaction: vi.fn(async (callback: any) =>
      callback({
        report: { update: txReportUpdate },
        reportNutrition: { createMany: reportNutritionCreateMany }
      })
    )
  }
}))

vi.mock('../../../server/utils/repositories/nutritionRepository', () => ({
  nutritionRepository: {
    getForUser: nutritionGetForUser
  }
}))

vi.mock('../../../server/utils/date', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
  formatUserDate: vi.fn((date: unknown) => String(date)),
  formatDateUTC: vi.fn(() => '2026-03-08'),
  getStartOfDaysAgoUTC: vi.fn(() => new Date('2026-03-01T00:00:00.000Z'))
}))

vi.mock('../../../server/utils/gemini', () => ({
  generateStructuredAnalysis
}))

vi.mock('@trigger.dev/sdk/v3', async () => {
  const actual = await vi.importActual('@trigger.dev/sdk/v3')
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    task: vi.fn().mockImplementation((config: any) => ({
      run: config.run,
      id: config.id
    }))
  }
})

function nutritionDay(id: string, dateIso: string) {
  return {
    id,
    date: new Date(dateIso),
    calories: 2200,
    caloriesGoal: 2500,
    protein: 140,
    proteinGoal: 160,
    carbs: 260,
    carbsGoal: 300,
    fat: 70,
    fatGoal: 80,
    fiber: 28,
    waterMl: 2500
  }
}

const mockAnalysis = {
  type: 'nutrition_analysis',
  title: 'Nutrition Analysis',
  date: '2026-03-08',
  executive_summary: 'Fueling looks consistent with training demands.',
  sections: [
    {
      title: 'Caloric Balance',
      status: 'good',
      status_label: 'Good',
      analysis_points: ['Intake tracks close to goal.']
    }
  ],
  recommendations: [{ title: 'Add protein at breakfast', priority: 'high', description: '...' }]
}

describe('nutrition report quota tracking (CW-846)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userFindUnique.mockResolvedValue({
      ftp: 250,
      weight: 70,
      weightUnits: 'Kilograms',
      maxHr: 190,
      language: 'English'
    })
    generateStructuredAnalysis.mockResolvedValue(mockAnalysis)
  })

  it('tracks last-3 nutrition generation as unified_report_generation and completes the report', async () => {
    nutritionGetForUser.mockResolvedValue([
      nutritionDay('n-3', '2026-03-07T00:00:00.000Z'),
      nutritionDay('n-2', '2026-03-06T00:00:00.000Z'),
      nutritionDay('n-1', '2026-03-05T00:00:00.000Z')
    ])
    reportUpdate.mockResolvedValue({} as any)
    txReportUpdate.mockResolvedValue({} as any)
    reportNutritionCreateMany.mockResolvedValue({ count: 3 } as any)

    const { analyzeLast3NutritionTask } = await import('../../../trigger/analyze-last-3-nutrition')
    const result = await analyzeLast3NutritionTask.run({
      userId: 'user-1',
      reportId: 'report-3'
    })

    expect(generateStructuredAnalysis).toHaveBeenCalledTimes(1)
    const trackingContext = generateStructuredAnalysis.mock.calls[0][3]
    expect(trackingContext).toMatchObject({
      userId: 'user-1',
      operation: 'unified_report_generation',
      entityType: 'Nutrition'
    })
    expect(txReportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'report-3' },
        data: expect.objectContaining({ status: 'COMPLETED' })
      })
    )
    expect(reportNutritionCreateMany).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, reportId: 'report-3' })
  })

  it('tracks last-7 nutrition generation as unified_report_generation and completes the report', async () => {
    nutritionGetForUser.mockResolvedValue([
      nutritionDay('n-7', '2026-03-07T00:00:00.000Z'),
      nutritionDay('n-6', '2026-03-06T00:00:00.000Z'),
      nutritionDay('n-5', '2026-03-05T00:00:00.000Z'),
      nutritionDay('n-4', '2026-03-04T00:00:00.000Z'),
      nutritionDay('n-3', '2026-03-03T00:00:00.000Z'),
      nutritionDay('n-2', '2026-03-02T00:00:00.000Z'),
      nutritionDay('n-1', '2026-03-01T00:00:00.000Z')
    ])
    reportUpdate.mockResolvedValue({} as any)
    txReportUpdate.mockResolvedValue({} as any)
    reportNutritionCreateMany.mockResolvedValue({ count: 7 } as any)

    const { analyzeLast7NutritionTask } = await import('../../../trigger/analyze-last-7-nutrition')
    const result = await analyzeLast7NutritionTask.run({
      userId: 'user-1',
      reportId: 'report-7'
    })

    expect(generateStructuredAnalysis).toHaveBeenCalledTimes(1)
    const trackingContext = generateStructuredAnalysis.mock.calls[0][3]
    expect(trackingContext).toMatchObject({
      userId: 'user-1',
      operation: 'unified_report_generation',
      entityType: 'Nutrition'
    })
    expect(txReportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'report-7' },
        data: expect.objectContaining({ status: 'COMPLETED' })
      })
    )
    expect(reportNutritionCreateMany).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ success: true, reportId: 'report-7' })
  })

  it('keeps daily nutrition quota mapping separate from recurring report accounting', async () => {
    const { mapOperationToQuota } = await import('../../../server/utils/quotas/registry')
    expect(mapOperationToQuota('last_3_nutrition_analysis')).toBe('nutrition_analysis')
    expect(mapOperationToQuota('last_7_nutrition_analysis')).toBe('nutrition_analysis')
    expect(mapOperationToQuota('unified_report_generation')).toBe('unified_report_generation')
  })
})
