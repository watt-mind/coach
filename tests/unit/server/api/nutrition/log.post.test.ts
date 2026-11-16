import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAuth } from '../../../../../server/utils/auth-guard'
import {
  CONCURRENT_UPDATE_CONFLICT,
  nutritionRepository
} from '../../../../../server/utils/repositories/nutritionRepository'
import { generateStructuredAnalysis } from '../../../../../server/utils/gemini'
import { metabolicService } from '../../../../../server/utils/services/metabolicService'
import { nutritionPlanService } from '../../../../../server/utils/services/nutritionPlanService'
import { getUserNutritionSettings } from '../../../../../server/utils/nutrition/settings'
import { getUserTimezone } from '../../../../../server/utils/date'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('getRouterParam', (event: any, name: string) => event.params?.[name])
vi.stubGlobal('readBody', async (event: any) => event.body)
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message || err.statusMessage)
  ;(error as any).statusCode = err.statusCode
  return error
})

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: vi.fn()
}))

vi.mock('../../../../../server/utils/repositories/nutritionRepository', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../../server/utils/repositories/nutritionRepository')
    >()
  return {
    ...actual,
    nutritionRepository: {
      getByDate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateWithVersionCheck: vi.fn()
    }
  }
})

vi.mock('../../../../../server/utils/gemini', () => ({
  generateStructuredAnalysis: vi.fn()
}))

vi.mock('../../../../../server/utils/date', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../server/utils/date')>()
  return {
    ...actual,
    getUserTimezone: vi.fn(async () => 'UTC')
  }
})

vi.mock('../../../../../server/utils/nutrition/settings', () => ({
  getUserNutritionSettings: vi.fn()
}))

vi.mock('../../../../../server/utils/services/metabolicService', () => ({
  metabolicService: {
    calculateFuelingPlanForDate: vi.fn().mockResolvedValue({ plan: { windows: [] } })
  }
}))

vi.mock('../../../../../server/utils/services/nutritionPlanService', () => ({
  nutritionPlanService: { reconcileLoggedMealsForDate: vi.fn() }
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/nutrition/[id]/log.post')
  return mod.default
}

describe('POST /api/nutrition/:id/log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as any)
    vi.mocked(getUserTimezone).mockResolvedValue('UTC')
    vi.mocked(getUserNutritionSettings).mockResolvedValue({ mealPattern: [] } as any)
    vi.mocked(generateStructuredAnalysis).mockResolvedValue({
      items: [
        {
          name: 'Banana',
          calories: 90,
          protein: 1,
          carbs: 23,
          fat: 0,
          logged_at: '2026-07-21T12:00:00.000Z',
          mealType: 'lunch'
        }
      ]
    } as any)
  })

  it('merges the meal-array change and recalculated totals into a single version-checked write', async () => {
    const existing = {
      id: 'n1',
      date: new Date('2026-07-21T00:00:00Z'),
      updatedAt: new Date('2026-07-21T10:00:00Z'),
      breakfast: [],
      lunch: [],
      dinner: [],
      snacks: []
    }
    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(existing as any)
    vi.mocked(nutritionRepository.updateWithVersionCheck).mockResolvedValue({
      ...existing,
      lunch: [{ id: 'x', name: 'Banana' }]
    } as any)

    const handler = await getHandler()
    await handler({
      params: { id: '2026-07-21' },
      body: { query: 'ate a banana', mealType: 'lunch' }
    } as any)

    expect(nutritionRepository.update).not.toHaveBeenCalled()
    expect(nutritionRepository.updateWithVersionCheck).toHaveBeenCalledTimes(1)
    const [id, updatedAt, data] = vi.mocked(nutritionRepository.updateWithVersionCheck).mock
      .calls[0]!
    expect(id).toBe('n1')
    expect(updatedAt).toBe(existing.updatedAt)
    expect(data.lunch).toHaveLength(1)
    expect(typeof data.calories).toBe('number')
  })

  it('returns a 409 conflict instead of silently dropping a concurrent log entry', async () => {
    const existing = {
      id: 'n1',
      date: new Date('2026-07-21T00:00:00Z'),
      updatedAt: new Date('2026-07-21T10:00:00Z'),
      breakfast: [],
      lunch: [],
      dinner: [],
      snacks: []
    }
    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(existing as any)
    vi.mocked(nutritionRepository.updateWithVersionCheck).mockResolvedValue(
      CONCURRENT_UPDATE_CONFLICT
    )

    const handler = await getHandler()
    await expect(
      handler({
        params: { id: '2026-07-21' },
        body: { query: 'ate a banana', mealType: 'lunch' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 409 })
  })
  describe.each(['create', 'update'] as const)('%s beverage logs', (mode) => {
    it.each([
      { name: 'Sports drink', calories: 160, protein: 0, carbs: 40, fat: 0 },
      { name: 'Recovery shake', calories: 260, protein: 20, carbs: 30, fat: 7 }
    ])(
      'preserves $name nutrition, metadata and fluid in stored and returned items',
      async (macros) => {
        const beverage = {
          ...macros,
          entryType: 'HYDRATION',
          mealType: 'lunch',
          waterMl: 500,
          fiber: 2,
          sugar: 25,
          absorptionType: 'RAPID',
          amount: 500,
          unit: 'ml',
          quantity: '1 bottle',
          logged_at: '12:00'
        }
        const food = {
          name: 'Banana',
          calories: 90,
          protein: 1,
          carbs: 23,
          fat: 0,
          mealType: 'snacks',
          logged_at: '12:00'
        }
        const existing = {
          id: 'n1',
          date: new Date('2026-07-21T00:00:00Z'),
          updatedAt: new Date('2026-07-21T10:00:00Z'),
          breakfast: [],
          lunch: [],
          dinner: [],
          snacks: [{ name: 'Water', entryType: 'HYDRATION', water_ml: 100, calories: 0 }]
        }
        vi.mocked(generateStructuredAnalysis).mockResolvedValue({ items: [food, beverage] })
        vi.mocked(nutritionRepository.getByDate).mockResolvedValue(
          mode === 'update' ? (existing as any) : null
        )
        vi.mocked(nutritionRepository.create).mockResolvedValue(existing as any)
        vi.mocked(nutritionRepository.updateWithVersionCheck).mockResolvedValue(existing as any)
        const result = await (
          await getHandler()
        )({
          params: { id: '2026-07-21' },
          body: { query: 'banana and 500 ml sports drink' }
        } as any)
        const data =
          mode === 'create'
            ? vi.mocked(nutritionRepository.create).mock.calls[0]![0]
            : vi.mocked(nutritionRepository.updateWithVersionCheck).mock.calls[0]![2]
        const expected = {
          ...beverage,
          mealType: undefined,
          logged_at: '2026-07-21T12:00:00.000Z',
          water_ml: 500,
          fluidMl: 500,
          hydrationContributionMl: 500,
          source: 'ai'
        }
        expect(data.snacks).toHaveLength(mode === 'create' ? 2 : 3)
        expect(data.snacks).toEqual(expect.arrayContaining([expect.objectContaining(expected)]))
        expect(data).toMatchObject({
          calories: macros.calories + 90,
          protein: macros.protein + 1,
          carbs: macros.carbs + 23,
          fat: macros.fat,
          fiber: 2,
          sugar: 25,
          waterMl: mode === 'create' ? 500 : 600
        })
        expect(result.itemsAdded).toHaveLength(2)
        expect(result.itemsAdded).toEqual(
          expect.arrayContaining([expect.objectContaining(expected)])
        )
        expect(result.hydration).toEqual([
          expect.objectContaining({ date: '2026-07-21', fluidMl: 500 })
        ])
        expect(nutritionRepository.update).not.toHaveBeenCalled()
        if (mode === 'update') {
          expect(nutritionRepository.create).not.toHaveBeenCalled()
          expect(nutritionRepository.updateWithVersionCheck).toHaveBeenCalledWith(
            'n1',
            existing.updatedAt,
            data
          )
        } else {
          expect(data).toMatchObject({ userId: 'user-1', date: existing.date })
          expect(nutritionRepository.updateWithVersionCheck).not.toHaveBeenCalled()
        }
        expect(metabolicService.calculateFuelingPlanForDate).toHaveBeenCalledWith(
          'user-1',
          existing.date,
          { persist: true }
        )
        expect(nutritionPlanService.reconcileLoggedMealsForDate).toHaveBeenCalledWith(
          'user-1',
          existing.date,
          'UTC'
        )
      }
    )
  })

  it.each([true, false])('keeps water zero-energy with AI hydration=%s', async (aiHydration) => {
    vi.mocked(generateStructuredAnalysis).mockResolvedValue({
      items: aiHydration
        ? [
            {
              name: 'Water',
              entryType: 'HYDRATION',
              waterMl: 500,
              calories: 0,
              protein: 0,
              carbs: 0,
              fat: 0
            }
          ]
        : []
    })
    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(null)
    vi.mocked(nutritionRepository.create).mockResolvedValue({ id: 'n1' } as any)
    const result = await (
      await getHandler()
    )({
      params: { id: '2026-07-21' },
      body: { query: '500 ml water' }
    } as any)
    const data = vi.mocked(nutritionRepository.create).mock.calls[0]![0]
    expect(data.snacks).toHaveLength(1)
    expect(data).toMatchObject({ calories: 0, protein: 0, carbs: 0, fat: 0, waterMl: 500 })
    expect(result.itemsAdded).toHaveLength(1)
    expect(result.itemsAdded[0]).toMatchObject({ calories: 0, water_ml: 500 })
    expect(result.hydration[0]).toMatchObject({ fluidMl: 500 })
  })

  it('returns 409 on a concurrent beverage create without reconciling', async () => {
    vi.mocked(generateStructuredAnalysis).mockResolvedValue({
      items: [
        {
          name: 'Sports drink',
          entryType: 'HYDRATION',
          waterMl: 500,
          calories: 160,
          protein: 0,
          carbs: 40,
          fat: 0
        }
      ]
    })
    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(null)
    vi.mocked(nutritionRepository.create).mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      (await getHandler())({
        params: { id: '2026-07-21' },
        body: { query: '500 ml sports drink' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(nutritionPlanService.reconcileLoggedMealsForDate).not.toHaveBeenCalled()
  })

  describe('daylight-saving local wall-clock (CW-792)', () => {
    const setupCreate = (timezone: string, mealPattern: unknown = []) => {
      vi.mocked(getUserTimezone).mockResolvedValue(timezone)
      vi.mocked(getUserNutritionSettings).mockResolvedValue({ mealPattern } as any)
      vi.mocked(nutritionRepository.getByDate).mockResolvedValue(null)
      vi.mocked(nutritionRepository.create).mockResolvedValue({ id: 'n1' } as any)
    }

    const loggedAtOf = (result: any) => result.itemsAdded[0].logged_at as string

    it.each([
      {
        name: 'spring forward',
        dateStr: '2026-03-08',
        expected: '2026-03-08T12:00:00.000Z'
      },
      {
        name: 'fall back',
        dateStr: '2026-11-01',
        expected: '2026-11-01T13:00:00.000Z'
      }
    ])('resolves explicit 08:00 on $name to $expected', async ({ dateStr, expected }) => {
      setupCreate('America/New_York')
      vi.mocked(generateStructuredAnalysis).mockResolvedValue({
        items: [
          {
            name: 'Oatmeal',
            calories: 150,
            protein: 5,
            carbs: 27,
            fat: 3,
            mealType: 'breakfast',
            logged_at: '08:00'
          }
        ]
      } as any)

      const handler = await getHandler()
      const result = await handler({
        params: { id: dateStr },
        body: { query: 'oatmeal at 8am', mealType: 'breakfast' }
      } as any)

      expect(loggedAtOf(result)).toBe(expected)
      const payload = vi.mocked(nutritionRepository.create).mock.calls[0]![0]
      expect(payload.date).toEqual(new Date(`${dateStr}T00:00:00Z`))
      expect(payload.breakfast[0]).toMatchObject({ logged_at: expected })
      expect(result.itemsAdded[0]).toMatchObject({ logged_at: expected })
    })

    it.each([
      {
        name: 'spring forward',
        dateStr: '2026-03-08',
        expected: '2026-03-08T12:00:00.000Z'
      },
      {
        name: 'fall back',
        dateStr: '2026-11-01',
        expected: '2026-11-01T13:00:00.000Z'
      }
    ])(
      'anchors missing time to the breakfast schedule on $name ($expected)',
      async ({ dateStr, expected }) => {
        setupCreate('America/New_York', [{ name: 'breakfast', time: '08:00' }])
        vi.mocked(generateStructuredAnalysis).mockResolvedValue({
          items: [
            {
              name: 'Oatmeal',
              calories: 150,
              protein: 5,
              carbs: 27,
              fat: 3,
              mealType: 'breakfast'
            }
          ]
        } as any)

        const handler = await getHandler()
        const result = await handler({
          params: { id: dateStr },
          body: { query: 'oatmeal', mealType: 'breakfast' }
        } as any)

        expect(loggedAtOf(result)).toBe(expected)
        const payload = vi.mocked(nutritionRepository.create).mock.calls[0]![0]
        expect(payload.date).toEqual(new Date(`${dateStr}T00:00:00Z`))
        expect(payload.breakfast[0]).toMatchObject({ logged_at: expected })
      }
    )

    it.each([
      {
        name: 'spring forward',
        dateStr: '2026-03-08',
        expected: '2026-03-08T12:00:00.000Z'
      },
      {
        name: 'fall back',
        dateStr: '2026-11-01',
        expected: '2026-11-01T13:00:00.000Z'
      }
    ])('resolves AI hydration 08:00 on $name to $expected', async ({ dateStr, expected }) => {
      setupCreate('America/New_York')
      vi.mocked(generateStructuredAnalysis).mockResolvedValue({
        items: [
          {
            name: 'Water',
            entryType: 'HYDRATION',
            waterMl: 500,
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
            logged_at: '08:00'
          }
        ]
      } as any)

      const handler = await getHandler()
      const result = await handler({
        params: { id: dateStr },
        body: { query: '500 ml water at 8am' }
      } as any)

      expect(loggedAtOf(result)).toBe(expected)
      const payload = vi.mocked(nutritionRepository.create).mock.calls[0]![0]
      expect(payload.date).toEqual(new Date(`${dateStr}T00:00:00Z`))
      expect(payload.snacks[0]).toMatchObject({ logged_at: expected, water_ml: 500 })
      expect(result.hydration).toEqual([expect.objectContaining({ date: dateStr, fluidMl: 500 })])
    })

    it('resolves 08:00 on an ordinary EDT date to 12:00Z', async () => {
      const dateStr = '2026-07-21'
      setupCreate('America/New_York')
      vi.mocked(generateStructuredAnalysis).mockResolvedValue({
        items: [
          {
            name: 'Oatmeal',
            calories: 150,
            protein: 5,
            carbs: 27,
            fat: 3,
            mealType: 'breakfast',
            logged_at: '08:00'
          }
        ]
      } as any)

      const handler = await getHandler()
      const result = await handler({
        params: { id: dateStr },
        body: { query: 'oatmeal at 8am', mealType: 'breakfast' }
      } as any)

      expect(loggedAtOf(result)).toBe('2026-07-21T12:00:00.000Z')
      const payload = vi.mocked(nutritionRepository.create).mock.calls[0]![0]
      expect(payload.date).toEqual(new Date('2026-07-21T00:00:00Z'))
    })

    it('resolves 12:00 UTC on an ordinary date to 12:00Z', async () => {
      const dateStr = '2026-07-21'
      setupCreate('UTC')
      vi.mocked(generateStructuredAnalysis).mockResolvedValue({
        items: [
          {
            name: 'Banana',
            calories: 90,
            protein: 1,
            carbs: 23,
            fat: 0,
            mealType: 'lunch',
            logged_at: '12:00'
          }
        ]
      } as any)

      const handler = await getHandler()
      const result = await handler({
        params: { id: dateStr },
        body: { query: 'banana at noon', mealType: 'lunch' }
      } as any)

      expect(loggedAtOf(result)).toBe('2026-07-21T12:00:00.000Z')
      const payload = vi.mocked(nutritionRepository.create).mock.calls[0]![0]
      expect(payload.date).toEqual(new Date('2026-07-21T00:00:00Z'))
    })

    it('passes absolute ISO timestamps through unchanged', async () => {
      const dateStr = '2026-03-08'
      setupCreate('America/New_York')
      vi.mocked(generateStructuredAnalysis).mockResolvedValue({
        items: [
          {
            name: 'Banana',
            calories: 90,
            protein: 1,
            carbs: 23,
            fat: 0,
            mealType: 'lunch',
            logged_at: '2026-03-08T12:00:00.000Z'
          }
        ]
      } as any)

      const handler = await getHandler()
      const result = await handler({
        params: { id: dateStr },
        body: { query: 'banana', mealType: 'lunch' }
      } as any)

      expect(loggedAtOf(result)).toBe('2026-03-08T12:00:00.000Z')
      const payload = vi.mocked(nutritionRepository.create).mock.calls[0]![0]
      expect(payload.date).toEqual(new Date('2026-03-08T00:00:00Z'))
    })
  })
})
