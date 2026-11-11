import { generateText, type ModelMessage } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { resolveApprovalToolNamesForSelection } from '../../../../server/utils/chat/skills'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nutritionTools } from '../../../../server/utils/ai-tools/nutrition'
import { nutritionRepository } from '../../../../server/utils/repositories/nutritionRepository'
import { plannedWorkoutRepository } from '../../../../server/utils/repositories/plannedWorkoutRepository'
import { metabolicService } from '../../../../server/utils/services/metabolicService'
import { mealRecommendationService } from '../../../../server/utils/services/mealRecommendationService'
import { nutritionPlanService } from '../../../../server/utils/services/nutritionPlanService'
import { getUserNutritionSettings } from '../../../../server/utils/nutrition/settings'
import { extractFluidIntakeMl } from '../../../../server/utils/nutrition/hydration'

vi.mock('../../../../server/utils/db', () => ({
  prisma: {
    auditLog: {
      create: vi.fn().mockResolvedValue(null)
    },
    user: {
      findUnique: vi.fn()
    }
  }
}))

vi.mock('../../../../server/utils/repositories/nutritionRepository', () => ({
  nutritionRepository: {
    getByDate: vi.fn(),
    getForUser: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  }
}))

vi.mock('../../../../server/utils/repositories/plannedWorkoutRepository', () => ({
  plannedWorkoutRepository: {
    list: vi.fn()
  }
}))

vi.mock('../../../../server/utils/services/metabolicService', () => ({
  metabolicService: {
    calculateFuelingPlanForDate: vi.fn(),
    getMetabolicStateForDate: vi.fn(),
    getDailyTimeline: vi.fn(),
    getWaveRange: vi.fn()
  }
}))

vi.mock('../../../../server/utils/services/mealRecommendationService', () => ({
  mealRecommendationService: {
    getRecommendations: vi.fn()
  }
}))

vi.mock('../../../../server/utils/services/nutritionPlanService', () => ({
  nutritionPlanService: {
    lockMeal: vi.fn()
  }
}))

vi.mock('../../../../server/utils/nutrition/settings', () => ({
  getUserNutritionSettings: vi.fn()
}))

describe('nutrition chat tools', () => {
  const userId = 'user-123'
  const timezone = 'America/Chicago'
  const aiSettings = { aiRequireToolApproval: false } as any

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getUserNutritionSettings).mockResolvedValue({
      mealPattern: null
    } as any)
    vi.mocked(plannedWorkoutRepository.list).mockResolvedValue([])
  })

  it('returns current meal items from the normalized target meal slot', async () => {
    const tools = nutritionTools(userId, timezone, aiSettings)
    const createdItem = {
      id: 'item-1',
      name: '[Sport] Banana',
      calories: 100,
      protein: 1,
      carbs: 25,
      fat: 0,
      logged_at: '2026-03-10T14:00:00.000Z'
    }

    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(null)
    vi.mocked(nutritionRepository.create).mockResolvedValue({
      id: 'nutrition-1',
      snacks: [createdItem]
    } as any)
    vi.mocked(nutritionRepository.update).mockResolvedValue({
      id: 'nutrition-1',
      calories: 100,
      protein: 1,
      carbs: 25,
      fat: 0,
      snacks: [createdItem]
    } as any)

    const result = await (tools.log_nutrition_meal.execute as any)({
      date: '2026-03-10',
      meal_type: 'Sport',
      items: [
        {
          name: 'Banana',
          calories: 100,
          protein: 1,
          carbs: 25,
          fat: 0
        }
      ]
    })

    expect(result.current_meal_items).toEqual([createdItem])
  })

  it('anchors a custom slot to its own scheduled time, not the snack slot', async () => {
    // A custom slot is stored under 'snacks', but the meal pattern knows exactly when it happens.
    // Resolving the time from the bucket instead put the item hours away, and the timestamp drives
    // both the timeline and the metabolic simulation.
    vi.mocked(getUserNutritionSettings).mockResolvedValue({
      mealPattern: [
        { name: 'Breakfast', time: '07:00' },
        { name: 'Elevenses', time: '10:30' },
        { name: 'Snack', time: '16:00' }
      ]
    } as any)

    const tools = nutritionTools(userId, timezone, aiSettings)
    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(null)
    vi.mocked(nutritionRepository.create).mockResolvedValue({ id: 'n1', snacks: [] } as any)
    vi.mocked(nutritionRepository.update).mockResolvedValue({ id: 'n1', snacks: [] } as any)

    await (tools.log_nutrition_meal.execute as any)({
      // A past date, so the time comes from the schedule rather than the clock.
      date: '2026-03-10',
      meal_type: 'Elevenses',
      items: [{ name: 'Scone', calories: 200, protein: 3, carbs: 30, fat: 8 }]
    })

    const created = vi.mocked(nutritionRepository.create).mock.calls[0]?.[0] as any
    const loggedAt = new Date(created.snacks[0].logged_at)

    // 10:30 America/Chicago on 2026-03-10 (CDT, UTC-5) is 15:30Z. The snack slot would be 21:00Z.
    expect(loggedAt.toISOString()).toBe('2026-03-10T15:30:00.000Z')
  })

  it('falls back to the bucket schedule when the slot is not in the pattern', async () => {
    vi.mocked(getUserNutritionSettings).mockResolvedValue({
      mealPattern: [
        { name: 'Breakfast', time: '07:00' },
        { name: 'Snack', time: '16:00' }
      ]
    } as any)

    const tools = nutritionTools(userId, timezone, aiSettings)
    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(null)
    vi.mocked(nutritionRepository.create).mockResolvedValue({ id: 'n1', snacks: [] } as any)
    vi.mocked(nutritionRepository.update).mockResolvedValue({ id: 'n1', snacks: [] } as any)

    await (tools.log_nutrition_meal.execute as any)({
      date: '2026-03-10',
      meal_type: 'Sport',
      items: [{ name: 'Gel', calories: 100, protein: 0, carbs: 25, fat: 0 }]
    })

    const created = vi.mocked(nutritionRepository.create).mock.calls[0]?.[0] as any

    // 16:00 America/Chicago (CDT) is 21:00Z.
    expect(new Date(created.snacks[0].logged_at).toISOString()).toBe('2026-03-10T21:00:00.000Z')
  })

  it('rejects invalid dates for fueling recommendation and planning tools', async () => {
    const tools = nutritionTools(userId, timezone, aiSettings)

    const fueling = await (tools.get_fueling_recommendations.execute as any)({
      date: '2026-02-31'
    })
    const recommendations = await (tools.get_meal_recommendations.execute as any)({
      date: '2026-02-31'
    })
    const lockedMeal = await (tools.lock_meal_to_plan.execute as any)({
      date: '2026-02-31',
      window_type: 'PRE_WORKOUT',
      meal: { id: 'meal-1' }
    })

    expect(fueling.error_code).toBe('INVALID_CALENDAR_DATE')
    expect(recommendations.error_code).toBe('INVALID_CALENDAR_DATE')
    expect(lockedMeal.error_code).toBe('INVALID_CALENDAR_DATE')
    expect(plannedWorkoutRepository.list).not.toHaveBeenCalled()
    expect(mealRecommendationService.getRecommendations).not.toHaveBeenCalled()
    expect(nutritionPlanService.lockMeal).not.toHaveBeenCalled()
  })

  it('formats naive local meal timestamps without adding a ghost hour', async () => {
    const tools = nutritionTools(userId, 'Europe/Brussels', aiSettings)

    vi.mocked(nutritionRepository.getForUser).mockResolvedValue([
      {
        id: 'nutrition-1',
        date: new Date('2026-03-24T00:00:00.000Z'),
        calories: 1257,
        protein: 68,
        carbs: 139,
        fat: 47,
        fiber: null,
        sugar: null,
        waterMl: 750,
        breakfast: [],
        lunch: [
          {
            id: 'item-1',
            product_name: 'Roerei',
            logged_at: '2026-03-24 12:15:56'
          }
        ],
        dinner: [],
        snacks: [],
        aiAnalysis: null
      }
    ] as any)

    const result = await (tools.get_nutrition_log.execute as any)({
      start_date: '2026-03-24',
      end_date: '2026-03-24'
    })

    expect(result.entries[0].meals.lunch[0].logged_at_local).toBe('12:15')
  })

  it('rejects invalid dates for daily fueling status before calling metabolism services', async () => {
    const tools = nutritionTools(userId, timezone, aiSettings)

    const result = await (tools.get_daily_fueling_status.execute as any)({
      date: '2026-02-31'
    })

    expect(result.error_code).toBe('INVALID_CALENDAR_DATE')
    expect(metabolicService.getMetabolicStateForDate).not.toHaveBeenCalled()
    expect(metabolicService.getDailyTimeline).not.toHaveBeenCalled()
  })

  it('returns fueling windows in local clock time for AI consumption', async () => {
    const tools = nutritionTools(userId, 'Europe/Brussels', aiSettings)

    vi.mocked(nutritionRepository.getByDate).mockResolvedValue({
      fuelingPlan: {
        windows: [
          {
            type: 'PRE_WORKOUT',
            startTime: '2026-03-24T13:00:00.000Z',
            endTime: '2026-03-24T15:00:00.000Z'
          },
          {
            type: 'INTRA_WORKOUT',
            startTime: '2026-03-24T15:00:00.000Z',
            endTime: '2026-03-24T16:30:00.000Z'
          }
        ]
      },
      caloriesGoal: 2721,
      carbsGoal: 367,
      proteinGoal: 126,
      fatGoal: 79
    } as any)

    const result = await (tools.get_fueling_recommendations.execute as any)({
      date: '2026-03-24'
    })

    expect(result.plan.windows).toEqual([
      expect.objectContaining({
        type: 'PRE_WORKOUT',
        startTime: '14:00',
        endTime: '16:00',
        startTimeUtc: '2026-03-24T13:00:00.000Z',
        endTimeUtc: '2026-03-24T15:00:00.000Z'
      }),
      expect.objectContaining({
        type: 'INTRA_WORKOUT',
        startTime: '16:00',
        endTime: '17:30',
        startTimeUtc: '2026-03-24T15:00:00.000Z',
        endTimeUtc: '2026-03-24T16:30:00.000Z'
      })
    ])
  })

  it('patches quantity and weight-style fields on logged items', async () => {
    const tools = nutritionTools(userId, timezone, aiSettings)
    const existingItem = {
      id: 'item-1',
      name: 'Sports Drink',
      quantity: '500 ml bottle',
      amount: 500,
      unit: 'ml',
      calories: 120,
      protein: 0,
      carbs: 30,
      fat: 0,
      water_ml: 500,
      logged_at: '2026-03-10T14:00:00.000Z'
    }

    vi.mocked(nutritionRepository.getByDate).mockResolvedValue({
      id: 'nutrition-1',
      snacks: [existingItem]
    } as any)

    vi.mocked(nutritionRepository.update)
      .mockResolvedValueOnce({
        id: 'nutrition-1',
        snacks: [
          {
            ...existingItem,
            quantity: '750 ml bottle',
            amount: 750,
            unit: 'ml',
            water_ml: 750,
            fluidMl: 750,
            hydrationContributionMl: 750
          }
        ]
      } as any)
      .mockResolvedValueOnce({
        id: 'nutrition-1',
        calories: 120,
        protein: 0,
        carbs: 30,
        fat: 0,
        waterMl: 750
      } as any)

    const result = await (tools.patch_nutrition_items.execute as any)({
      date: '2026-03-10',
      meal_type: 'snacks',
      updates: [
        {
          item_id: 'item-1',
          quantity: '750 ml bottle',
          amount: 750,
          unit: 'ml',
          water_ml: 750
        }
      ]
    })

    expect(nutritionRepository.update).toHaveBeenNthCalledWith(1, 'nutrition-1', {
      snacks: [
        expect.objectContaining({
          id: 'item-1',
          quantity: '750 ml bottle',
          amount: 750,
          unit: 'ml',
          water_ml: 750,
          fluidMl: 750,
          hydrationContributionMl: 750
        })
      ]
    })
    expect(result.totals.water_ml).toBe(750)
  })
})

describe('extractFluidIntakeMl container vs. explicit volume double-counting (CW-69)', () => {
  it('does not add a container estimate on top of an explicit volume for the same drink', () => {
    expect(extractFluidIntakeMl('a 500ml bottle of water')).toBe(500)
  })

  it('falls back to a container estimate when no explicit volume is given', () => {
    expect(extractFluidIntakeMl('a bottle of water')).toBe(500)
  })

  it('sums independent entries instead of suppressing the second one', () => {
    expect(extractFluidIntakeMl('500ml + a glass of water')).toBe(750)
  })
})

describe('meal-plan SDK approval boundary (CW-848)', () => {
  const input = {
    date: '2026-03-10',
    window_type: 'PRE_WORKOUT',
    meal: { id: 'meal-1', name: 'Oats', carbs: 60 }
  }
  const messages: ModelMessage[] = [{ role: 'user', content: 'Lock this meal to my plan' }]
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  }
  function model(callTool: boolean) {
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        content: callTool
          ? [
              {
                type: 'tool-call' as const,
                toolCallId: 'lock-1',
                toolName: 'lock_meal_to_plan',
                input: JSON.stringify(input)
              }
            ]
          : [{ type: 'text' as const, text: 'Done' }],
        finishReason: {
          unified: callTool ? ('tool-calls' as const) : ('stop' as const),
          raw: undefined
        },
        usage,
        warnings: []
      })
    })
  }
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(nutritionPlanService.lockMeal).mockResolvedValue({ id: 'planned-1' } as any)
  })

  it.each([true, false])('selects approval tools with approval setting %s', async (required) => {
    const tools = nutritionTools('user-123', 'America/Chicago', {
      aiRequireToolApproval: required
    } as any)
    const names = await resolveApprovalToolNamesForSelection(tools, {
      aiRequireToolApproval: required,
      useTools: true
    })
    expect(names.includes('lock_meal_to_plan')).toBe(required)
    expect(names).not.toContain('get_meal_recommendations')
    expect(tools.get_meal_recommendations.needsApproval).toBeUndefined()
  })

  it.each([true, false])(
    'holds pending writes and resumes approval=%s through the SDK',
    async (approved) => {
      const tools = nutritionTools('user-123', 'America/Chicago', {
        aiRequireToolApproval: true
      } as any)
      const pending = await generateText({ model: model(true), tools, messages })
      const request = pending.content.find((part) => part.type === 'tool-approval-request')
      expect(request).toBeDefined()
      expect(nutritionPlanService.lockMeal).not.toHaveBeenCalled()
      if (!request || request.type !== 'tool-approval-request')
        throw new Error('Missing approval request')
      const resumed = await generateText({
        model: model(false),
        tools,
        messages: [
          ...messages,
          ...pending.response.messages,
          {
            role: 'tool',
            content: [{ type: 'tool-approval-response', approvalId: request.approvalId, approved }]
          }
        ]
      })
      expect(nutritionPlanService.lockMeal).toHaveBeenCalledTimes(approved ? 1 : 0)
      if (approved) {
        expect(nutritionPlanService.lockMeal).toHaveBeenCalledWith(
          'user-123',
          new Date('2026-03-10T12:00:00.000Z'),
          input.window_type,
          input.meal
        )
      }
      expect(resumed.text).toBe('Done')
    }
  )

  it('executes without a prompt when approval is disabled', async () => {
    const tools = nutritionTools('user-123', 'America/Chicago', {
      aiRequireToolApproval: false
    } as any)
    const result = await generateText({ model: model(true), tools, messages })
    expect(result.content.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(nutritionPlanService.lockMeal).toHaveBeenCalledTimes(1)
    expect(nutritionPlanService.lockMeal).toHaveBeenCalledWith(
      'user-123',
      new Date('2026-03-10T12:00:00.000Z'),
      input.window_type,
      input.meal
    )
  })
})
