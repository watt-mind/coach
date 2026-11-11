import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAuth } from '../../../../../../server/utils/auth-guard'
import { dispatchTask } from '../../../../../../server/utils/task-dispatcher'
import { prisma } from '../../../../../../server/utils/db'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('createError', (error: any) => {
  const err = new Error(error.message) as any
  err.statusCode = error.statusCode
  return err
})

let body: any = {}
vi.stubGlobal('readBody', async () => body)

vi.mock('../../../../../../server/utils/auth-guard', () => ({ requireAuth: vi.fn() }))

vi.mock('../../../../../../server/utils/task-dispatcher', () => ({
  dispatchTask: vi.fn()
}))

const { findFirst, create, update, findSettings } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findSettings: vi.fn(),
  create: vi.fn(),
  update: vi.fn()
}))

vi.mock('../../../../../../server/utils/db', () => ({
  prisma: {
    nutritionRecommendation: { findFirst, create, update },
    userNutritionSettings: { findUnique: findSettings }
  }
}))

async function post(payload: Record<string, unknown>) {
  body = payload
  const handler = (await import('../../../../../../server/api/nutrition/recommendations/meal.post'))
    .default
  return handler({} as any)
}

describe('POST /api/nutrition/recommendations/meal', () => {
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as any)
    findFirst.mockResolvedValue(null)
    findSettings.mockResolvedValue(null)
    vi.mocked(dispatchTask).mockResolvedValue({ id: 'run-fresh' })
    create.mockResolvedValue({ id: 'rec-1' })
    update.mockResolvedValue({})
  })

  const payload = {
    date: '2026-07-31',
    windowType: 'PRE_WORKOUT',
    targetCarbs: 50,
    targetProtein: 20,
    targetKcal: 400
  }
  const constraints = {
    dietaryProfile: ['VEGETARIAN'],
    foodAllergies: [],
    foodIntolerances: ['LACTOSE'],
    lifestyleExclusions: ['ALCOHOL']
  }
  function cached(context: any = constraints) {
    findFirst.mockResolvedValue({
      id: 'rec-cached',
      runId: 'run-cached',
      contextJson: {
        requestedTargets: { carbs: 50, protein: 20, kcal: 400 },
        constraints: context
      },
      options: [{ title: 'Peanut snack' }]
    })
    findSettings.mockResolvedValue(constraints)
  }

  it('dispatches a fresh meal after saving a peanut allergy with unchanged targets', async () => {
    cached()
    findSettings.mockResolvedValue({ ...constraints, foodAllergies: ['PEANUT'] })
    expect(await post(payload)).toMatchObject({ cached: false, runId: 'run-fresh' })
    expect(dispatchTask).toHaveBeenCalledWith(
      'recommend-nutrition-meal',
      expect.objectContaining({ userId: 'user-1', recommendationId: 'rec-1' }),
      expect.anything()
    )
    expect(findSettings).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: {
        dietaryProfile: true,
        foodAllergies: true,
        foodIntolerances: true,
        lifestyleExclusions: true
      }
    })
  })

  it('reuses unchanged constraints without dispatching', async () => {
    cached()
    expect(await post(payload)).toMatchObject({ cached: true, recommendationId: 'rec-cached' })
    expect(dispatchTask).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('reuses normalized equivalent constraints regardless of order or duplicates', async () => {
    cached({ ...constraints, foodAllergies: ['PEANUT', 'SOY'] })
    findSettings.mockResolvedValue({
      ...constraints,
      foodAllergies: [' soy ', 'peanut', 'SOY', '']
    })
    expect(await post(payload)).toMatchObject({ cached: true })
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it.each(['dietaryProfile', 'foodIntolerances', 'lifestyleExclusions'])(
    'dispatches when %s changes',
    async (field) => {
      cached()
      findSettings.mockResolvedValue({ ...constraints, [field]: ['NEW_RESTRICTION'] })
      expect(await post(payload)).toMatchObject({ cached: false })
      expect(dispatchTask).toHaveBeenCalledOnce()
    }
  )

  it.each([
    undefined,
    null,
    {},
    { ...constraints, foodAllergies: null },
    { ...constraints, foodAllergies: [123] }
  ])('refreshes legacy/incomparable constraints %j', async (stored) => {
    cached(stored)
    // Explicitly remove the snapshot for the legacy record without context constraints.
    if (stored === undefined) {
      findFirst.mockResolvedValue({
        id: 'rec-cached',
        contextJson: {
          requestedTargets: { carbs: 50, protein: 20, kcal: 400 }
        }
      })
    }
    expect(await post(payload)).toMatchObject({ cached: false })
    expect(dispatchTask).toHaveBeenCalledOnce()
  })

  it('matches empty generator constraints when settings do not exist', async () => {
    cached({ dietaryProfile: [], foodAllergies: [], foodIntolerances: [], lifestyleExclusions: [] })
    findSettings.mockResolvedValue(null)
    expect(await post(payload)).toMatchObject({ cached: true })
  })

  it('still bypasses equivalent cache when forceLlm is set', async () => {
    cached()
    expect(await post({ ...payload, forceLlm: true })).toMatchObject({ cached: false })
    expect(findFirst).not.toHaveBeenCalled()
    expect(dispatchTask).toHaveBeenCalledOnce()
  })

  it('still refreshes when only macro targets change', async () => {
    cached()
    expect(await post({ ...payload, targetCarbs: 75 })).toMatchObject({ cached: false })
    expect(dispatchTask).toHaveBeenCalledOnce()
  })

  it('marks the recommendation FAILED instead of leaving it stuck in PROCESSING when enqueue throws', async () => {
    vi.mocked(dispatchTask).mockRejectedValue(new Error('Trigger service unavailable'))

    await expect(
      post({
        date: '2026-07-31',
        windowType: 'PRE_WORKOUT',
        targetCarbs: 50,
        targetProtein: 20,
        targetKcal: 400
      })
    ).rejects.toMatchObject({ statusCode: 500 })

    expect(update).toHaveBeenCalledWith({
      where: { id: 'rec-1' },
      data: {
        status: 'FAILED',
        contextJson: {
          requestedTargets: { carbs: 50, protein: 20, kcal: 400 },
          error: 'ENQUEUE_FAILED',
          errorMessage: 'Trigger service unavailable'
        }
      }
    })
  })

  it('stores the runId on the recommendation when enqueue succeeds', async () => {
    vi.mocked(dispatchTask).mockResolvedValue({ id: 'run-123' })

    const result: any = await post({
      date: '2026-07-31',
      windowType: 'PRE_WORKOUT',
      targetCarbs: 50,
      targetProtein: 20,
      targetKcal: 400
    })

    expect(result.success).toBe(true)
    expect(result.runId).toBe('run-123')
    expect(update).toHaveBeenCalledWith({
      where: { id: 'rec-1' },
      data: { runId: 'run-123' }
    })
  })
})
