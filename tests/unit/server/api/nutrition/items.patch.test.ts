import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAuth } from '../../../../../server/utils/auth-guard'
import {
  CONCURRENT_UPDATE_CONFLICT,
  nutritionRepository
} from '../../../../../server/utils/repositories/nutritionRepository'

import { nutritionPlanService } from '../../../../../server/utils/services/nutritionPlanService'

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
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateWithVersionCheck: vi.fn()
    }
  }
})

vi.mock('../../../../../server/utils/services/metabolicService', () => ({
  metabolicService: { calculateFuelingPlanForDate: vi.fn().mockResolvedValue({ plan: {} }) }
}))

vi.mock('../../../../../server/utils/services/nutritionPlanService', () => ({
  nutritionPlanService: { reconcileLoggedMealsForDate: vi.fn() }
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/nutrition/[id]/items.patch')
  return mod.default
}

const baseNutrition = () => ({
  id: 'n1',
  date: new Date('2026-07-21T00:00:00Z'),
  updatedAt: new Date('2026-07-21T10:00:00Z'),
  breakfast: [{ id: 'item-1', name: 'Eggs', calories: 100, protein: 10, carbs: 1, fat: 5 }],
  lunch: [],
  dinner: [],
  snacks: []
})

describe('PATCH /api/nutrition/:id/items', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as any)
  })

  describe('cross-meal move (action: update)', () => {
    it('commits the source-meal removal and target-meal addition as a single atomic write', async () => {
      const nutrition = baseNutrition()
      vi.mocked(nutritionRepository.getById).mockResolvedValue(nutrition as any)
      vi.mocked(nutritionRepository.updateWithVersionCheck).mockResolvedValue({
        ...nutrition,
        breakfast: [],
        lunch: [{ id: 'item-1', name: 'Eggs', calories: 100, protein: 10, carbs: 1, fat: 5 }]
      } as any)

      const handler = await getHandler()
      await handler({
        params: { id: 'n1' },
        body: {
          action: 'update',
          mealType: 'lunch',
          item: { id: 'item-1', name: 'Eggs', calories: 100, protein: 10, carbs: 1, fat: 5 }
        }
      } as any)

      // The old, buggy implementation issued a separate write to clear the
      // source meal before writing the target meal. That plain `update` path
      // must never be used for this mutation any more.
      expect(nutritionRepository.update).not.toHaveBeenCalled()

      // Exactly one write should have happened, and it must contain BOTH the
      // source meal (now without the item) and the target meal (now with the
      // item) in the same payload — so a failure of this single call can
      // never leave the item in neither meal.
      expect(nutritionRepository.updateWithVersionCheck).toHaveBeenCalledTimes(1)
      const [, , data] = vi.mocked(nutritionRepository.updateWithVersionCheck).mock.calls[0]!
      expect(data.breakfast).toEqual([])
      expect(data.lunch).toEqual([expect.objectContaining({ id: 'item-1', name: 'Eggs' })])
    })

    it('never leaves the item lost when the single write fails', async () => {
      const nutrition = baseNutrition()
      vi.mocked(nutritionRepository.getById).mockResolvedValue(nutrition as any)
      vi.mocked(nutritionRepository.updateWithVersionCheck).mockRejectedValue(
        new Error('database unavailable')
      )

      const handler = await getHandler()
      await expect(
        handler({
          params: { id: 'n1' },
          body: {
            action: 'update',
            mealType: 'lunch',
            item: { id: 'item-1', name: 'Eggs', calories: 100, protein: 10, carbs: 1, fat: 5 }
          }
        } as any)
      ).rejects.toThrow('database unavailable')

      // Only the single atomic write was attempted (and it failed) — there is
      // no earlier "remove from source" write that could have already
      // succeeded while this one failed, which is exactly the lost-update bug
      // being fixed.
      expect(nutritionRepository.update).not.toHaveBeenCalled()
      expect(nutritionRepository.updateWithVersionCheck).toHaveBeenCalledTimes(1)
    })
  })

  it.each(['delete', 'update'] as const)(
    'reconciles after persisting a food %s',
    async (action) => {
      const nutrition = baseNutrition()
      vi.mocked(nutritionRepository.getById).mockResolvedValue(nutrition as any)
      vi.mocked(nutritionRepository.updateWithVersionCheck).mockResolvedValue(nutrition as any)
      const handler = await getHandler()
      await handler({
        params: { id: 'n1' },
        body:
          action === 'delete'
            ? { action, mealType: 'breakfast', itemId: 'item-1' }
            : {
                action,
                mealType: 'breakfast',
                item: {
                  ...nutrition.breakfast[0],
                  logged_at: '2026-07-21T15:00:00Z'
                }
              }
      } as any)
      const data = vi.mocked(nutritionRepository.updateWithVersionCheck).mock.calls[0]![2]
      expect(data.breakfast).toEqual(
        action === 'delete'
          ? []
          : [expect.objectContaining({ id: 'item-1', logged_at: '2026-07-21T15:00:00Z' })]
      )
      expect(nutritionPlanService.reconcileLoggedMealsForDate).toHaveBeenCalledWith(
        'user-1',
        nutrition.date
      )
      expect(
        vi.mocked(nutritionRepository.updateWithVersionCheck).mock.invocationCallOrder[0]
      ).toBeLessThan(
        vi.mocked(nutritionPlanService.reconcileLoggedMealsForDate).mock.invocationCallOrder[0]!
      )
    }
  )

  describe('optimistic concurrency', () => {
    it('returns a 409 conflict instead of silently overwriting a concurrent change', async () => {
      const nutrition = baseNutrition()
      vi.mocked(nutritionRepository.getById).mockResolvedValue(nutrition as any)
      vi.mocked(nutritionRepository.updateWithVersionCheck).mockResolvedValue(
        CONCURRENT_UPDATE_CONFLICT
      )

      const handler = await getHandler()
      await expect(
        handler({
          params: { id: 'n1' },
          body: {
            action: 'add',
            mealType: 'snacks',
            item: { name: 'Banana', calories: 90, protein: 1, carbs: 23, fat: 0 }
          }
        } as any)
      ).rejects.toMatchObject({ statusCode: 409 })

      // The version check was passed the `updatedAt` that was actually read,
      // proving the check is against the row's real state, not a stale value.
      expect(nutritionRepository.updateWithVersionCheck).toHaveBeenCalledWith(
        'n1',
        nutrition.updatedAt,
        expect.any(Object)
      )
    })
  })
})
