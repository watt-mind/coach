import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nutritionPlanService } from '../../../../../server/utils/services/nutritionPlanService'
import { metabolicService } from '../../../../../server/utils/services/metabolicService'
import { prisma } from '../../../../../server/utils/db'
import { getUserTimezone } from '../../../../../server/utils/date'
import { slugifySlot } from '../../../../../server/utils/nutrition-domain/day-plan'
import { buildDayFuelingPlan } from '../../../../../server/utils/nutrition-domain'
import { getUserNutritionSettings } from '../../../../../server/utils/nutrition/settings'
import { bodyMetricResolver } from '../../../../../server/utils/services/bodyMetricResolver'
import { nutritionRepository } from '../../../../../server/utils/repositories/nutritionRepository'

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    nutritionPlan: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn()
    },
    nutritionPlanMeal: {
      upsert: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn()
    },
    nutrition: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    userNutritionSettings: {
      findUnique: vi.fn()
    },
    user: {
      findUnique: vi.fn()
    },
    // CW-83: calculateFuelingPlanForDate/calculateFuelingPlansForRange query these two directly.
    workout: {
      findMany: vi.fn()
    },
    plannedWorkout: {
      findMany: vi.fn()
    },
    // Queried by remediationService.getActiveFuelingOverride (real module, not mocked below).
    athleteJourneyEvent: {
      findMany: vi.fn()
    }
  }
}))

vi.mock('../../../../../server/utils/date', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../server/utils/date')>()
  return {
    // CW-83 tests exercise the real metabolicService, which needs the real date helpers
    // (formatDateUTC, buildZonedDateTimeFromUtcDate, ...) to bucket days correctly - only
    // getUserTimezone itself stays mockable, as it always has been in this file.
    ...actual,
    getUserTimezone: vi.fn()
  }
})

vi.mock('../../../../../server/utils/nutrition/settings', () => ({
  getUserNutritionSettings: vi.fn()
}))

vi.mock('../../../../../server/utils/services/bodyMetricResolver', () => ({
  bodyMetricResolver: {
    resolveEffectiveWeight: vi.fn()
  }
}))

vi.mock('../../../../../server/utils/repositories/nutritionRepository', () => ({
  nutritionRepository: {
    getByDate: vi.fn(),
    getForUser: vi.fn(),
    upsert: vi.fn()
  }
}))

// The barrel is left real (pure functions, no side-effecting imports) except buildDayFuelingPlan,
// which is wrapped in a spy that still calls through to the real implementation. This lets the
// CW-83 tests below assert exactly how many times the day builder - and therefore the dominant
// fuel-state determination it computes internally - runs, while every other test in this file
// keeps exercising the real fueling-plan math untouched.
vi.mock('../../../../../server/utils/nutrition-domain', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../../server/utils/nutrition-domain')>()
  return {
    ...actual,
    buildDayFuelingPlan: vi.fn((...args: Parameters<typeof actual.buildDayFuelingPlan>) =>
      actual.buildDayFuelingPlan(...args)
    )
  }
})

vi.mock('../../../../../server/utils/services/metabolicService', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../../server/utils/services/metabolicService')>()
  return {
    metabolicService: {
      ...actual.metabolicService,
      getNutritionDay: vi.fn(),
      getMealTargetContext: vi.fn()
    }
  }
})

describe('nutritionPlanService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getUserTimezone).mockResolvedValue('America/Chicago')
  })

  describe('getPlanForRange', () => {
    it('merges meals from overlapping plans and keeps newest per date+windowType', async () => {
      const olderMeal = {
        id: 'meal-old',
        date: new Date('2026-02-15T00:00:00.000Z'),
        windowType: 'DAILY_BASE:breakfast',
        scheduledAt: new Date('2026-02-15T07:00:00.000Z'),
        updatedAt: new Date('2026-02-15T08:00:00.000Z'),
        mealJson: { title: 'Old Breakfast' }
      }
      const newerMeal = {
        id: 'meal-new',
        date: new Date('2026-02-15T00:00:00.000Z'),
        windowType: 'DAILY_BASE:breakfast',
        scheduledAt: new Date('2026-02-15T07:00:00.000Z'),
        updatedAt: new Date('2026-02-15T09:00:00.000Z'),
        mealJson: { title: 'New Breakfast' }
      }
      const secondMeal = {
        id: 'meal-lunch',
        date: new Date('2026-02-15T00:00:00.000Z'),
        windowType: 'DAILY_BASE:lunch',
        scheduledAt: new Date('2026-02-15T12:00:00.000Z'),
        updatedAt: new Date('2026-02-15T09:30:00.000Z'),
        mealJson: { title: 'Lunch' }
      }

      vi.mocked(prisma.nutritionPlan.findMany).mockResolvedValue([
        {
          id: 'plan-primary',
          updatedAt: new Date('2026-02-15T10:00:00.000Z'),
          meals: [newerMeal]
        },
        {
          id: 'plan-older',
          updatedAt: new Date('2026-02-14T10:00:00.000Z'),
          meals: [olderMeal, secondMeal]
        }
      ] as any)

      const result = await nutritionPlanService.getPlanForRange(
        'user-1',
        new Date('2026-02-09T00:00:00.000Z'),
        new Date('2026-02-15T23:59:59.999Z')
      )

      expect(prisma.nutritionPlan.findMany).toHaveBeenCalled()
      expect(result?.id).toBe('plan-primary')
      expect(result?.meals).toHaveLength(2)
      expect(result?.meals.find((m: any) => m.windowType === 'DAILY_BASE:breakfast')?.id).toBe(
        'meal-new'
      )
      expect(result?.meals.find((m: any) => m.windowType === 'DAILY_BASE:lunch')?.id).toBe(
        'meal-lunch'
      )
    })
  })

  describe('getGroceryList', () => {
    // Distinct windowTypes: getPlanForRange keeps one meal per date+windowType.
    const mealWith = (ingredients: any[], id = 'meal-1', windowType = 'DAILY_BASE:breakfast') => ({
      id,
      windowType,
      date: new Date('2026-02-15T00:00:00.000Z'),
      status: 'PLANNED',
      mealJson: { title: 'Porridge', ingredients }
    })

    function mockPlan(meals: any[]) {
      vi.mocked(prisma.nutritionPlan.findMany).mockResolvedValue([
        { id: 'plan-1', updatedAt: new Date('2026-02-15T10:00:00.000Z'), meals }
      ] as any)
    }

    it.each<[number, number, string | undefined, number]>([
      [25, 75, undefined, 100],
      [0, 0, undefined, 100],
      [25, 75, 'SKIPPED', 75],
      [25, 75, 'REPLACED', 75]
    ])(
      'aggregates persisted splits (%s:%s, excluded %s) exactly once',
      async (first, second, status, expected) => {
        vi.mocked(getUserTimezone).mockResolvedValue('UTC')
        vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({ id: 'plan-1' } as any)
        vi.mocked(prisma.nutrition.findUnique).mockResolvedValue(null)
        const rows: any[] = []
        vi.mocked(prisma.nutritionPlanMeal.upsert).mockImplementation((async (args: any) => {
          const row = JSON.parse(JSON.stringify({ id: `meal-${rows.length}`, ...args.create }))
          row.date = new Date(row.date)
          rows.push(row)
          return row
        }) as any)
        const ingredients = [{ item: 'Oats', quantity: 100, unit: 'g' }]
        const totals = { carbs: 61, protein: 13, kcal: 389, fat: 7 }
        await nutritionPlanService.lockMeal(
          'user-1',
          '2026-02-15',
          'PRE_WORKOUT',
          {
            title: 'Porridge',
            ingredients,
            totals
          },
          undefined,
          {
            windowAssignments: [
              { windowType: 'PRE_WORKOUT', windowKey: 'PRE_WORKOUT#1', targetCarbs: first },
              { windowType: 'PRE_WORKOUT', windowKey: 'PRE_WORKOUT#2', targetCarbs: second }
            ]
          }
        )
        expect(rows).toHaveLength(2)
        expect(rows.map((row) => row.mealJson.ingredients)).toEqual([ingredients, ingredients])
        expect(rows.map((row) => row.mealJson.allocation.ratio)).toEqual(
          first ? [0.25, 0.75] : [0.5, 0.5]
        )
        for (const [macro, total] of Object.entries(totals)) {
          expect(rows.reduce((sum, row) => sum + row.mealJson.totals[macro], 0)).toBe(total)
        }
        if (status) rows[0].status = status
        mockPlan(rows)
        const result = await nutritionPlanService.getGroceryList(
          'user-1',
          new Date('2026-02-15'),
          new Date('2026-02-15T23:59:59.999Z')
        )
        expect(result.items[0]?.quantity).toBe(expected)
        expect(result.totals).toEqual({ ingredients: 1, meals: status ? 1 : 2 })
        expect(result.items[0]?.sourceMeals).toEqual(
          Array.from({ length: status ? 1 : 2 }, () => ({ date: '2026-02-15', title: 'Porridge' }))
        )
        expect(rows.map((row) => row.mealJson.ingredients)).toEqual([ingredients, ingredients])
      }
    )

    it('keeps independently locked identical selections at full quantity', async () => {
      vi.mocked(getUserTimezone).mockResolvedValue('UTC')
      vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({ id: 'plan-1' } as any)
      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue(null)
      const rows: any[] = []
      vi.mocked(prisma.nutritionPlanMeal.upsert).mockImplementation((async (args: any) => {
        const row = { id: `meal-${rows.length}`, ...args.create }
        rows.push(row)
        return row
      }) as any)
      for (const windowKey of ['PRE_WORKOUT#1', 'PRE_WORKOUT#2']) {
        await nutritionPlanService.lockMeal(
          'user-1',
          '2026-02-15',
          'PRE_WORKOUT',
          {
            title: 'Porridge',
            ingredients: [{ item: 'Oats', quantity: 100, unit: 'g' }],
            totals: { carbs: 60 }
          },
          undefined,
          { windowKey }
        )
      }
      mockPlan(rows)
      const result = await nutritionPlanService.getGroceryList(
        'user-1',
        new Date('2026-02-15'),
        new Date('2026-02-15T23:59:59.999Z')
      )
      expect(result.items[0]?.quantity).toBe(200)
      expect(result.totals.meals).toBe(2)
    })

    it.each([undefined, null, NaN, Infinity, -1, 2, '0.5', 0, 0.25])(
      'handles persisted allocation ratio %s without poisoning quantities',
      async (ratio) => {
        const row = mealWith([{ item: ' Oats ', quantity: '100', unit: 'g' }])
        Object.assign(row.mealJson, { allocation: { ratio } })
        mockPlan([row])
        const result = await nutritionPlanService.getGroceryList(
          'user-1',
          new Date('2026-02-15'),
          new Date('2026-02-15T23:59:59.999Z')
        )
        expect(result.items[0]?.quantity).toBe(ratio === 0 ? 0 : ratio === 0.25 ? 25 : 100)
      }
    )

    it('sums quantities of the same ingredient and unit', async () => {
      mockPlan([
        mealWith([{ item: 'Oats', quantity: 80, unit: 'g' }], 'meal-1', 'DAILY_BASE:breakfast'),
        mealWith([{ item: 'Oats', quantity: 40, unit: 'g' }], 'meal-2', 'DAILY_BASE:lunch')
      ])

      const result = await nutritionPlanService.getGroceryList(
        'user-1',
        new Date('2026-02-15T00:00:00.000Z'),
        new Date('2026-02-15T23:59:59.999Z')
      )

      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.quantity).toBe(120)
    })

    it('does not let a non-numeric quantity poison the aggregated total', async () => {
      // mealJson is AI-generated, so 'two' is a quantity that really arrives. Number('two') is NaN,
      // and one NaN made every later += for that ingredient NaN too.
      mockPlan([
        mealWith([{ item: 'Oats', quantity: 80, unit: 'g' }], 'meal-1', 'DAILY_BASE:breakfast'),
        mealWith([{ item: 'Oats', quantity: 'two', unit: 'g' }], 'meal-2', 'DAILY_BASE:lunch'),
        mealWith([{ item: 'Oats', quantity: 40, unit: 'g' }], 'meal-3', 'DAILY_BASE:dinner')
      ])

      const result = await nutritionPlanService.getGroceryList(
        'user-1',
        new Date('2026-02-15T00:00:00.000Z'),
        new Date('2026-02-15T23:59:59.999Z')
      )

      expect(result.items[0]?.quantity).toBe(120)
      expect(Number.isNaN(result.items[0]?.quantity)).toBe(false)
    })

    it('treats a leading non-numeric quantity as zero rather than NaN', async () => {
      mockPlan([mealWith([{ item: 'Salt', quantity: 'a pinch', unit: '' }])])

      const result = await nutritionPlanService.getGroceryList(
        'user-1',
        new Date('2026-02-15T00:00:00.000Z'),
        new Date('2026-02-15T23:59:59.999Z')
      )

      expect(result.items[0]?.quantity).toBe(0)
    })
  })

  describe('lockMeal', () => {
    it('uses exact YYYY-MM-DD key and slot-specific DAILY_BASE window type', async () => {
      vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({
        id: 'plan-1'
      } as any)
      vi.mocked(prisma.nutritionPlanMeal.upsert).mockResolvedValue({
        id: 'plan-meal-1',
        planId: 'plan-1',
        date: new Date('2026-02-15T00:00:00.000Z'),
        windowType: 'DAILY_BASE:breakfast',
        scheduledAt: new Date('2026-02-15T00:00:00.000Z')
      } as any)
      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue(null)

      await nutritionPlanService.lockMeal(
        'user-1',
        '2026-02-15',
        'DAILY_BASE',
        { title: 'Breakfast Bowl', totals: { carbs: 80, protein: 35 } },
        'Breakfast'
      )

      expect(prisma.nutritionPlan.findFirst).toHaveBeenNthCalledWith(2, {
        where: {
          userId: 'user-1',
          startDate: { lte: new Date('2026-02-15T00:00:00.000Z') },
          endDate: { gte: new Date('2026-02-15T00:00:00.000Z') }
        },
        include: {
          meals: {
            where: { date: new Date('2026-02-15T00:00:00.000Z') },
            orderBy: { scheduledAt: 'asc' }
          }
        }
      })

      expect(prisma.nutritionPlanMeal.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            planId_date_windowType: {
              planId: 'plan-1',
              date: new Date('2026-02-15T00:00:00.000Z'),
              windowType: 'DAILY_BASE:breakfast'
            }
          },
          create: expect.objectContaining({
            date: new Date('2026-02-15T00:00:00.000Z'),
            windowType: 'DAILY_BASE:breakfast',
            scheduledAt: new Date('2026-02-15T00:00:00.000Z')
          })
        })
      )
    })

    it('throws for invalid date input', async () => {
      await expect(
        nutritionPlanService.lockMeal(
          'user-1',
          'not-a-date',
          'DAILY_BASE',
          { title: 'Invalid', totals: {} },
          'Breakfast'
        )
      ).rejects.toThrow('Invalid date for lockMeal')
    })

    it('normalizes flat meal fields into totals and uses name as title', async () => {
      vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({
        id: 'plan-1'
      } as any)
      vi.mocked(prisma.nutritionPlanMeal.upsert).mockResolvedValue({
        id: 'plan-meal-1',
        planId: 'plan-1',
        date: new Date('2026-02-14T00:00:00.000Z'),
        windowType: 'PRE_WORKOUT',
        scheduledAt: new Date('2026-02-14T00:00:00.000Z')
      } as any)
      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue(null)

      await nutritionPlanService.lockMeal('user-1', '2026-02-14', 'PRE_WORKOUT', {
        carbs: 70,
        name: 'Toast Crusher (2 Slices Toast with Honey/Jam)',
        fat: 2,
        calories: 320,
        protein: 5
      })

      expect(prisma.nutritionPlanMeal.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            mealJson: expect.objectContaining({
              title: 'Toast Crusher (2 Slices Toast with Honey/Jam)',
              totals: {
                carbs: 70,
                protein: 5,
                kcal: 320,
                fat: 2
              }
            })
          })
        })
      )
    })

    it('writes lockedMeal into fueling plan windows without scope errors', async () => {
      vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({
        id: 'plan-1'
      } as any)

      const persistedMeal = {
        id: 'plan-meal-1',
        planId: 'plan-1',
        date: new Date('2026-02-14T00:00:00.000Z'),
        windowType: 'PRE_WORKOUT',
        scheduledAt: new Date('2026-02-14T00:00:00.000Z'),
        mealJson: { title: 'Banana + Gel', totals: { carbs: 45 } }
      }
      vi.mocked(prisma.nutritionPlanMeal.upsert).mockResolvedValue(persistedMeal as any)

      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue({
        id: 'nutrition-1',
        fuelingPlan: {
          windows: [{ type: 'PRE_WORKOUT', label: 'Before workout', isLocked: false }]
        }
      } as any)

      await nutritionPlanService.lockMeal('user-1', '2026-02-14', 'PRE_WORKOUT', {
        title: 'Banana + Gel',
        totals: { carbs: 45 }
      })

      expect(prisma.nutrition.update).toHaveBeenCalledWith({
        where: { id: 'nutrition-1' },
        data: {
          fuelingPlan: {
            windows: [
              {
                type: 'PRE_WORKOUT',
                label: 'Before workout',
                isLocked: true,
                lockedMealId: 'plan-meal-1',
                lockedMeal: { title: 'Banana + Gel', totals: { carbs: 45 } }
              }
            ]
          }
        }
      })
    })
  })

  describe('window keys', () => {
    it('prefers an explicit window key over the bare type', () => {
      expect(
        nutritionPlanService.resolveWindowKey({ type: 'PRE_WORKOUT', windowKey: 'PRE_WORKOUT#2' })
      ).toBe('PRE_WORKOUT#2')
    })

    it('falls back to a slot-specific key for baseline windows', () => {
      expect(
        nutritionPlanService.resolveWindowKey({ type: 'DAILY_BASE', slotName: 'Breakfast' })
      ).toBe('DAILY_BASE:breakfast')
    })

    it('derives a legacy window key the same way the plan generator does', () => {
      // This slugifier and the generator's disagreed on trailing punctuation, so a meal locked
      // against a slot named 'Lunch!' stopped matching the window it belonged to.
      expect(nutritionPlanService.toDailyBaseWindowKey('Lunch!')).toBe(
        `DAILY_BASE:${slugifySlot('Lunch!')}`
      )
      expect(nutritionPlanService.toDailyBaseWindowKey('Post ride ')).toBe(
        `DAILY_BASE:${slugifySlot('Post ride ')}`
      )
      expect(nutritionPlanService.toDailyBaseWindowKey('☕️')).toBe(
        `DAILY_BASE:${slugifySlot('☕️')}`
      )
    })

    it('matches a meal to its own window and not to a sibling of the same type', () => {
      const first = { type: 'PRE_WORKOUT', windowKey: 'PRE_WORKOUT#1' }
      const second = { type: 'PRE_WORKOUT', windowKey: 'PRE_WORKOUT#2' }
      const meal = { windowType: 'PRE_WORKOUT#2' }

      expect(nutritionPlanService.matchPlanMealToWindow(meal, second)).toBe(true)
      expect(nutritionPlanService.matchPlanMealToWindow(meal, first)).toBe(false)
    })

    it('binds a legacy bare-type meal to the first window of that type only', () => {
      const legacyMeal = { windowType: 'PRE_WORKOUT' }

      expect(
        nutritionPlanService.matchPlanMealToWindow(legacyMeal, {
          type: 'PRE_WORKOUT',
          windowKey: 'PRE_WORKOUT#1'
        })
      ).toBe(true)
      expect(
        nutritionPlanService.matchPlanMealToWindow(legacyMeal, {
          type: 'PRE_WORKOUT',
          windowKey: 'PRE_WORKOUT#2'
        })
      ).toBe(false)
    })

    it('persists two same-type windows as two separate plan meals', async () => {
      vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({ id: 'plan-1' } as any)
      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.nutritionPlanMeal.upsert).mockImplementation((async (args: any) => ({
        id: `meal-${args.where.planId_date_windowType.windowType}`,
        planId: 'plan-1',
        date: new Date('2026-02-15T00:00:00.000Z'),
        windowType: args.where.planId_date_windowType.windowType,
        scheduledAt: new Date('2026-02-15T00:00:00.000Z')
      })) as any)

      await nutritionPlanService.lockMeal(
        'user-1',
        '2026-02-15',
        'PRE_WORKOUT',
        { title: 'Morning Oats', totals: { carbs: 60 } },
        undefined,
        { windowKey: 'PRE_WORKOUT#1' }
      )
      await nutritionPlanService.lockMeal(
        'user-1',
        '2026-02-15',
        'PRE_WORKOUT',
        { title: 'Evening Rice Cakes', totals: { carbs: 45 } },
        undefined,
        { windowKey: 'PRE_WORKOUT#2' }
      )

      const persistedWindowTypes = vi
        .mocked(prisma.nutritionPlanMeal.upsert)
        .mock.calls.map((call: any) => call[0].where.planId_date_windowType.windowType)

      // Before stable keys both locks collapsed onto a single PRE_WORKOUT row.
      expect(persistedWindowTypes).toEqual(['PRE_WORKOUT#1', 'PRE_WORKOUT#2'])
    })

    it('still writes a bare type when no window key is supplied', async () => {
      vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({ id: 'plan-1' } as any)
      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.nutritionPlanMeal.upsert).mockResolvedValue({
        id: 'plan-meal-1',
        planId: 'plan-1',
        date: new Date('2026-02-15T00:00:00.000Z'),
        windowType: 'POST_WORKOUT',
        scheduledAt: new Date('2026-02-15T00:00:00.000Z')
      } as any)

      await nutritionPlanService.lockMeal('user-1', '2026-02-15', 'POST_WORKOUT', {
        title: 'Recovery Shake',
        totals: { carbs: 50 }
      })

      expect(prisma.nutritionPlanMeal.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            planId_date_windowType: expect.objectContaining({ windowType: 'POST_WORKOUT' })
          })
        })
      )
    })
  })

  describe('reconciliation matching', () => {
    const snackWindow = {
      type: 'DAILY_BASE',
      windowKey: 'DAILY_BASE:snack',
      slotName: 'Snack',
      startTime: '2026-02-15T14:00:00.000Z',
      endTime: '2026-02-15T16:00:00.000Z'
    }

    it('matches an item logged under the plural snacks array to a snack slot', () => {
      // Logged items carry the Nutrition record's plural array name; slot slugs are singular.
      // The raw includes() check never matched, so snack plan meals stayed PLANNED forever.
      const planMeal = { windowType: 'DAILY_BASE:snack' }
      const item = {
        id: 'log-1',
        mealType: 'snacks',
        name: 'Apple',
        at: new Date('2026-02-15T15:00:00.000Z')
      }

      expect(
        nutritionPlanService.matchLoggedItemToPlanMeal(planMeal, [snackWindow], [item], new Set())
      ).toBe(item)
    })

    it('still rejects items outside the window or of an unrelated meal type', () => {
      const planMeal = { windowType: 'DAILY_BASE:snack' }
      const outsideWindow = {
        id: 'log-2',
        mealType: 'snacks',
        name: 'Apple',
        at: new Date('2026-02-15T18:00:00.000Z')
      }
      const wrongMealType = {
        id: 'log-3',
        mealType: 'dinner',
        name: 'Steak',
        at: new Date('2026-02-15T15:00:00.000Z')
      }

      expect(
        nutritionPlanService.matchLoggedItemToPlanMeal(
          planMeal,
          [snackWindow],
          [outsideWindow, wrongMealType],
          new Set()
        )
      ).toBeNull()
    })
  })

  describe('lockMeal target and schedule handling', () => {
    beforeEach(() => {
      vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({ id: 'plan-1' } as any)
      vi.mocked(prisma.nutritionPlan.findMany).mockResolvedValue([] as any)
      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.nutritionPlanMeal.upsert).mockResolvedValue({
        id: 'plan-meal-1',
        planId: 'plan-1',
        date: new Date('2026-02-15T00:00:00.000Z'),
        windowType: 'PRE_WORKOUT',
        scheduledAt: new Date('2026-02-15T00:00:00.000Z')
      } as any)
    })

    it('keeps the stored window target when a re-lock carries no explicit targets', async () => {
      // The replace action re-locks without targets; writing the meal's own totals as the
      // target made every target-vs-planned comparison self-referential.
      await nutritionPlanService.lockMeal('user-1', '2026-02-15', 'PRE_WORKOUT', {
        title: 'Rice Cakes',
        totals: { carbs: 50 }
      })

      const upsertArgs = vi.mocked(prisma.nutritionPlanMeal.upsert).mock.calls[0]?.[0] as any
      expect(upsertArgs.update.targetJson).toBeUndefined()
      expect(upsertArgs.create.targetJson).toEqual({ carbs: 50, protein: 0, kcal: 0 })
    })

    it('writes the explicit window target when the assignment carries one', async () => {
      await nutritionPlanService.lockMeal(
        'user-1',
        '2026-02-15',
        'PRE_WORKOUT',
        { title: 'Rice Cakes', totals: { carbs: 50 } },
        undefined,
        {
          windowAssignments: [
            {
              windowType: 'PRE_WORKOUT',
              windowKey: 'PRE_WORKOUT#1',
              targetCarbs: 90,
              targetProtein: 20,
              targetKcal: 450
            }
          ]
        }
      )

      const upsertArgs = vi.mocked(prisma.nutritionPlanMeal.upsert).mock.calls[0]?.[0] as any
      expect(upsertArgs.update.targetJson).toEqual({ carbs: 90, protein: 20, kcal: 450 })
    })

    it('schedules a locked meal at its window start time instead of midnight', async () => {
      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue({
        id: 'nutrition-1',
        fuelingPlan: {
          windows: [
            {
              type: 'PRE_WORKOUT',
              windowKey: 'PRE_WORKOUT#1',
              startTime: '2026-02-15T09:30:00.000Z'
            }
          ]
        }
      } as any)

      await nutritionPlanService.lockMeal(
        'user-1',
        '2026-02-15',
        'PRE_WORKOUT',
        { title: 'Morning Oats', totals: { carbs: 60 } },
        undefined,
        { windowKey: 'PRE_WORKOUT#1' }
      )

      const upsertArgs = vi.mocked(prisma.nutritionPlanMeal.upsert).mock.calls[0]?.[0] as any
      expect(upsertArgs.create.scheduledAt).toEqual(new Date('2026-02-15T09:30:00.000Z'))
      expect(upsertArgs.update.scheduledAt).toEqual(new Date('2026-02-15T09:30:00.000Z'))
    })
  })

  describe('generateDraftPlan', () => {
    it('persists the full plan week even when a sub-range is generated', async () => {
      // A caller-supplied endDate used to truncate the plan row, orphaning locked meals on the
      // cut-off days, and the regenerated summary wiped the untouched days' entries.
      const weekStart = new Date('2026-02-09T00:00:00.000Z')
      vi.mocked(prisma.nutritionPlan.findFirst).mockResolvedValue({
        id: 'plan-1',
        startDate: weekStart,
        summaryJson: {
          days: [{ date: '2026-02-12', fuelingPlan: { windows: [] }, targets: {} }]
        },
        meals: []
      } as any)
      vi.mocked(prisma.userNutritionSettings.findUnique).mockResolvedValue(null as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null as any)
      vi.mocked(bodyMetricResolver.resolveEffectiveWeight).mockResolvedValue({ value: 75 } as any)
      vi.mocked(metabolicService.getNutritionDay).mockResolvedValue({
        fuelingPlan: { windows: [] },
        targets: {}
      } as any)
      vi.mocked(metabolicService.getMealTargetContext).mockResolvedValue({} as any)

      await nutritionPlanService.generateDraftPlan(
        'user-1',
        new Date('2026-02-09T00:00:00.000Z'),
        new Date('2026-02-11T23:59:59.999Z')
      )

      const updateArgs = vi.mocked(prisma.nutritionPlan.update).mock.calls[0]?.[0] as any
      expect(updateArgs.data.endDate).toEqual(new Date('2026-02-15T23:59:59.999Z'))

      const summaryDates = updateArgs.data.summaryJson.days.map((day: any) => day.date)
      expect(summaryDates).toEqual(['2026-02-09', '2026-02-10', '2026-02-11', '2026-02-12'])
    })
  })
})

describe('metabolicService.calculateFuelingPlansForRange batching (CW-83)', () => {
  const userId = 'user-83'

  const baseSettings = {
    bmr: 1600,
    activityLevel: 'ACTIVE',
    baseCaloriesMode: 'AUTO',
    nonExerciseBaseCalories: null,
    baseProteinPerKg: 1.6,
    baseFatPerKg: 1.0,
    currentCarbMax: 90,
    sodiumTarget: 750,
    sweatRate: null,
    preWorkoutWindow: 90,
    postWorkoutWindow: 60,
    fuelingSensitivity: 1.0,
    fuelState1Trigger: 0.7,
    fuelState1Min: 2.5,
    fuelState1Max: 4.0,
    fuelState2Trigger: 0.85,
    fuelState2Min: 4.5,
    fuelState2Max: 6.5,
    fuelState3Min: 7.0,
    fuelState3Max: 10.0,
    targetAdjustmentPercent: 0,
    mealPattern: null
  }

  // Two completed workouts on different days of a 5-day window, so the fixture proves per-day
  // grouping actually varies day to day rather than every day getting the same plan by accident.
  const allCompletedWorkouts = [
    {
      id: 'w-1',
      title: 'Morning Ride',
      durationSec: 3600,
      type: 'Ride',
      date: new Date('2026-03-01T08:00:00.000Z'),
      intensity: 0.9,
      calories: 600,
      kilojoules: 2500,
      plannedWorkoutId: null
    },
    {
      id: 'w-2',
      title: 'Long Endurance Ride',
      durationSec: 4 * 3600,
      type: 'Ride',
      date: new Date('2026-03-03T09:00:00.000Z'),
      intensity: 0.75,
      calories: 2400,
      kilojoules: 10000,
      plannedWorkoutId: null
    }
  ]

  const withinRange = (date: Date, gte?: Date, lte?: Date) =>
    (!gte || date.getTime() >= gte.getTime()) && (!lte || date.getTime() <= lte.getTime())

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(getUserTimezone).mockResolvedValue('UTC')
    vi.mocked(getUserNutritionSettings).mockResolvedValue(baseSettings as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      weight: 70,
      weightSourceMode: 'MANUAL',
      ftp: 250
    } as any)
    vi.mocked(bodyMetricResolver.resolveEffectiveWeight).mockResolvedValue({ value: 70 } as any)
    vi.mocked(prisma.athleteJourneyEvent.findMany).mockResolvedValue([])
    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(null)
    vi.mocked(nutritionRepository.getForUser).mockResolvedValue([])

    // Mimic real DB date-range filtering so a single-day query (the per-day loop) and a
    // multi-day query (the batched range) against this same fixture return the correct subset.
    vi.mocked(prisma.workout.findMany).mockImplementation((async (args: any) =>
      allCompletedWorkouts.filter((w) =>
        withinRange(w.date, args?.where?.date?.gte, args?.where?.date?.lte)
      )) as any)
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([])
  })

  it('produces identical per-day plans to looping calculateFuelingPlanForDate (no behavior regression)', async () => {
    const startDate = new Date('2026-03-01T00:00:00.000Z')
    const endDate = new Date('2026-03-03T00:00:00.000Z')

    const rangeResult = await metabolicService.calculateFuelingPlansForRange(
      userId,
      startDate,
      endDate,
      { persist: false }
    )

    expect(rangeResult.size).toBe(3)

    // Sanity check that the fixture actually exercises different code paths day to day, so the
    // equality assertions below are not vacuously comparing empty/identical plans: 03-01 has the
    // workout and gets workout windows, 03-02 is a rest day and gets baseline windows only.
    const workoutDay = rangeResult.get('2026-03-01')?.plan as any
    const restDay = rangeResult.get('2026-03-02')?.plan as any
    expect(workoutDay.windows.some((w: any) => w.type === 'INTRA_WORKOUT')).toBe(true)
    expect(restDay.windows.every((w: any) => w.type === 'DAILY_BASE')).toBe(true)

    for (let i = 0; i <= 2; i++) {
      const date = new Date(startDate)
      date.setUTCDate(startDate.getUTCDate() + i)
      const dateKey = date.toISOString().split('T')[0] as string

      const loopDay = await metabolicService.calculateFuelingPlanForDate(userId, date, {
        persist: false
      })

      expect(rangeResult.get(dateKey)).toEqual(loopDay)
    }
  })

  it('fetches shared per-user context and range data only once for a multi-day range, not once per day', async () => {
    const startDate = new Date('2026-03-01T00:00:00.000Z')
    const endDate = new Date('2026-03-05T00:00:00.000Z') // 5 days

    const result = await metabolicService.calculateFuelingPlansForRange(
      userId,
      startDate,
      endDate,
      { persist: false }
    )

    expect(result.size).toBe(5)
    expect(getUserNutritionSettings).toHaveBeenCalledTimes(1)
    expect(getUserTimezone).toHaveBeenCalledTimes(1)
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1)
    expect(bodyMetricResolver.resolveEffectiveWeight).toHaveBeenCalledTimes(1)
    expect(prisma.workout.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.plannedWorkout.findMany).toHaveBeenCalledTimes(1)
    expect(nutritionRepository.getForUser).toHaveBeenCalledTimes(1)
  })

  it('invokes the dominant fuel-state determination (buildDayFuelingPlan) exactly once per day, not twice', async () => {
    const startDate = new Date('2026-03-01T00:00:00.000Z')
    const endDate = new Date('2026-03-03T00:00:00.000Z') // 3 days

    await metabolicService.calculateFuelingPlansForRange(userId, startDate, endDate, {
      persist: false
    })

    expect(buildDayFuelingPlan).toHaveBeenCalledTimes(3)
  })

  it('calculateFuelingPlanForDate itself also invokes the day builder exactly once per call', async () => {
    const date = new Date('2026-03-01T00:00:00.000Z')

    await metabolicService.calculateFuelingPlanForDate(userId, date, { persist: false })

    expect(buildDayFuelingPlan).toHaveBeenCalledTimes(1)
  })
})

describe('reconcileLoggedMealsForDate stale automatic completion (CW-832)', () => {
  const date = '2026-02-15'
  const window = {
    type: 'DAILY_BASE',
    slotName: 'Breakfast',
    startTime: '2026-02-15T07:00:00Z',
    endTime: '2026-02-15T09:00:00Z'
  }
  let meals: any[]
  let nutrition: any

  beforeEach(() => {
    vi.clearAllMocks()
    meals = [
      {
        id: 'meal-1',
        windowType: 'DAILY_BASE:breakfast',
        status: 'DONE',
        actualNutritionItemId: 'food-1',
        mealJson: {
          title: 'Oats',
          ingredients: [{ item: 'Oats' }],
          isLogged: true,
          loggedAt: 'old'
        }
      }
    ]
    nutrition = {
      id: 'nutrition-1',
      breakfast: [],
      lunch: [],
      dinner: [],
      snacks: [],
      fuelingPlan: { windows: [window] }
    }
    vi.mocked(nutritionRepository.getByDate).mockImplementation(async () => nutrition)
    vi.mocked(prisma.nutritionPlan.findMany).mockImplementation(async () => [{ meals }] as any)
    vi.mocked(prisma.nutritionPlan.findFirst).mockImplementation(async () => ({ meals }) as any)
    vi.mocked(prisma.nutrition.findUnique).mockImplementation(async () => nutrition)
    vi.mocked(prisma.nutritionPlanMeal.update).mockImplementation((async ({ where, data }: any) => {
      const meal = meals.find((meal) => meal.id === where.id)
      Object.assign(meal, data)
      return meal
    }) as any)
  })

  const reconcile = () => nutritionPlanService.reconcileLoggedMealsForDate('user-1', date, 'UTC')

  it.each(['deleted', 'moved'])(
    'clears a %s automatic match and refreshes locks',
    async (action) => {
      if (action === 'moved')
        nutrition.breakfast = [{ id: 'food-1', logged_at: '2026-02-15T12:00:00Z' }]
      await reconcile()
      expect(meals[0]).toMatchObject({
        status: 'PLANNED',
        actualNutritionItemId: null,
        mealJson: {
          title: 'Oats',
          ingredients: [{ item: 'Oats' }],
          isLogged: false,
          loggedAt: null
        }
      })
      expect(prisma.nutrition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            fuelingPlan: {
              windows: [
                expect.objectContaining({
                  isLocked: true,
                  lockedMealId: 'meal-1',
                  lockedMeal: expect.objectContaining({ isLogged: false, loggedAt: null })
                })
              ]
            }
          }
        })
      )
      await reconcile()
      expect(prisma.nutritionPlanMeal.update).toHaveBeenCalledTimes(1)
    }
  )

  it('replaces stale linkage once, never uses one food for two meals, and remains idempotent', async () => {
    nutrition.breakfast = [{ id: 'replacement', logged_at: '2026-02-15T08:00:00Z' }]
    meals.push({ ...meals[0], id: 'meal-2' })
    await reconcile()
    expect(meals[0]).toMatchObject({ status: 'DONE', actualNutritionItemId: 'replacement' })
    expect(meals[1]).toMatchObject({ status: 'PLANNED', actualNutritionItemId: null })
    const snapshot = structuredClone(meals)
    await reconcile()
    expect(meals).toEqual(snapshot)
  })

  it('preserves skipped and manual completion even when intake matches', async () => {
    meals[0].status = 'SKIPPED'
    meals.push({
      id: 'manual',
      windowType: 'DAILY_BASE:breakfast',
      status: 'DONE',
      actualNutritionItemId: null,
      mealJson: { title: 'Manual', completedAt: 'explicit' }
    })
    nutrition.breakfast = [{ id: 'replacement', logged_at: '2026-02-15T08:00:00Z' }]
    const snapshot = structuredClone(meals)
    await reconcile()
    expect(meals).toEqual(snapshot)
    expect(prisma.nutritionPlanMeal.update).not.toHaveBeenCalled()
  })

  it('clears legacy logged markers without linkage and preserves explicit completion on linked meals', async () => {
    meals[0].actualNutritionItemId = null
    meals.push({
      ...structuredClone(meals[0]),
      id: 'explicit',
      actualNutritionItemId: 'deleted',
      mealJson: { ...meals[0].mealJson, completedAt: 'manual-completion' }
    })
    await reconcile()
    expect(meals[0]).toMatchObject({
      status: 'PLANNED',
      actualNutritionItemId: null,
      mealJson: { isLogged: false, loggedAt: null }
    })
    expect(meals[1]).toMatchObject({
      status: 'DONE',
      actualNutritionItemId: null,
      mealJson: { completedAt: 'manual-completion', isLogged: false, loggedAt: null }
    })
  })

  it('retains all state when no nutrition record exists', async () => {
    nutrition = null
    const snapshot = structuredClone(meals)
    expect(await reconcile()).toEqual([])
    expect(meals).toEqual(snapshot)
    expect(prisma.nutrition.update).not.toHaveBeenCalled()
  })
})
