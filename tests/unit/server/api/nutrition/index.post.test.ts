import { getUserTimezone } from '../../../../../server/utils/date'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAuth } from '../../../../../server/utils/auth-guard'
import {
  CONCURRENT_UPDATE_CONFLICT,
  nutritionRepository
} from '../../../../../server/utils/repositories/nutritionRepository'
import { getUserNutritionSettings } from '../../../../../server/utils/nutrition/settings'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', () => {})
vi.stubGlobal('createError', (error: any) => error)

let body: any = {}
vi.stubGlobal('readBody', async (event: any) => event.body ?? body)

// Auto-imported in the Nuxt server runtime. The tests run in UTC, so UTC parts are the local parts.
vi.stubGlobal('formatUserTime', (date: Date) => `${date.getUTCHours()}:${date.getUTCMinutes()}`)

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: vi.fn()
}))

vi.mock('../../../../../server/utils/repositories/nutritionRepository', () => ({
  CONCURRENT_UPDATE_CONFLICT: Symbol('conflict'),
  nutritionRepository: { getByDate: vi.fn(), saveWithVersionCheck: vi.fn() }
}))

vi.mock('../../../../../server/utils/nutrition/settings', () => ({
  getUserNutritionSettings: vi.fn()
}))

vi.mock('../../../../../server/utils/services/metabolicService', () => ({
  metabolicService: { calculateFuelingPlanForDate: vi.fn() }
}))

vi.mock('../../../../../server/utils/services/nutritionPlanService', () => ({
  nutritionPlanService: { reconcileLoggedMealsForDate: vi.fn() }
}))

vi.mock('../../../../../server/utils/date', () => ({
  getUserTimezone: vi.fn(async () => 'UTC'),
  getStartOfLocalDateUTC: vi.fn(),
  formatUserTime: vi.fn(() => '12:00')
}))

/** Buckets the endpoint assigned each item to, read off the upsert payload. */
async function bucketsFor(mealPattern: any[], items: any[]) {
  vi.mocked(getUserNutritionSettings).mockResolvedValue({ mealPattern } as any)
  body = { date: '2026-07-21', items }

  const handler = (await import('../../../../../server/api/nutrition/index.post')).default
  await handler({ context: {} } as any)

  const payload = vi.mocked(nutritionRepository.saveWithVersionCheck).mock.calls[0]?.[3] as any
  const result: Record<string, string[]> = {}
  for (const bucket of ['breakfast', 'lunch', 'dinner', 'snacks']) {
    result[bucket] = (payload?.[bucket] || []).map((item: any) => item.name)
  }
  return result
}

const item = (name: string, hhmm: string) => ({
  name,
  calories: 100,
  carbs: 20,
  logged_at: `2026-07-21T${hhmm}:00.000Z`
})

describe('POST /api/nutrition meal bucketing', () => {
  // Most of this suite stubs globals without restoring them; do not add to the pile.
  afterAll(() => {
    vi.unstubAllGlobals()
  })
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getUserTimezone).mockResolvedValue('UTC')
    vi.mocked(getUserNutritionSettings).mockResolvedValue({ mealPattern: [] } as any)
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as any)
    vi.mocked(nutritionRepository.getByDate).mockResolvedValue(null as any)
    vi.mocked(nutritionRepository.saveWithVersionCheck).mockResolvedValue({ id: 'n1' } as any)
  })

  it('buckets by the times an English meal pattern configures', async () => {
    const buckets = await bucketsFor(
      [
        { name: 'Breakfast', time: '06:00' },
        { name: 'Lunch', time: '11:00' },
        { name: 'Dinner', time: '21:00' },
        { name: 'Snack', time: '16:00' }
      ],
      [item('Porridge', '06:10'), item('Steak', '20:50')]
    )

    expect(buckets.breakfast).toEqual(['Porridge'])
    expect(buckets.dinner).toEqual(['Steak'])
  })

  it('uses the configured times for a pattern written in another language', async () => {
    // The literal 'breakfast' / 'lunch' name lookup this replaced matched nothing here and fell
    // back to a fixed 07:00 / 12:00 / 18:00 / 15:00. The times below are chosen so that those
    // defaults produce a *different* bucket, not merely a different boundary: the 10:15 item lands
    // in lunch and the 17:00 item in dinner once the athlete's own schedule is ignored.
    const buckets = await bucketsFor(
      [
        { name: 'Reggeli', time: '10:00' },
        { name: 'Ebéd', time: '14:00' },
        { name: 'Vacsora', time: '22:00' },
        { name: 'Uzsonna', time: '18:00' }
      ],
      [item('Zabkása', '10:15'), item('Pogácsa', '17:00')]
    )

    expect(buckets.breakfast).toEqual(['Zabkása'])
    expect(buckets.snacks).toEqual(['Pogácsa'])
  })

  it('still honours an explicit meal field over the time', async () => {
    const buckets = await bucketsFor(
      [{ name: 'Breakfast', time: '06:00' }],
      [{ ...item('Late snack', '06:05'), meal: 'DINNER' }]
    )

    expect(buckets.dinner).toEqual(['Late snack'])
    expect(buckets.breakfast).toEqual([])
  })
  const upload = async (name: string, authType = 'oauth', overrides = {}) => {
    const handler = (await import('../../../../../server/api/nutrition/index.post')).default
    return handler({
      context: { authType, oauthAppId: 'app' },
      body: {
        date: '2026-07-21',
        items: [{ ...item(name, '07:00'), meal: 'BREAKFAST' }],
        ...overrides
      }
    } as any)
  }

  for (const missing of [false, true]) {
    it(`retries concurrent ${missing ? 'creation' : 'existing-day additions'} from a fresh snapshot`, async () => {
      let stored: any = missing
        ? null
        : {
            id: 'n1',
            updatedAt: new Date(0),
            breakfast: [{ id: 'old', name: 'Prior', calories: 50, carbs: 10 }]
          }
      let reads = 0
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.mocked(nutritionRepository.getByDate).mockImplementation(async () => {
        const snapshot = structuredClone(stored)
        if (++reads <= 2) {
          if (reads === 2) release()
          await gate
        }
        return snapshot
      })
      vi.mocked(nutritionRepository.saveWithVersionCheck).mockImplementation(
        async (userId, date, snapshot, data, source) => {
          expect(userId).toBe('user-1')
          expect(date).toEqual(new Date('2026-07-21'))
          expect(source).toBe('oauth:app')
          if ((snapshot?.updatedAt.getTime() ?? -1) !== (stored?.updatedAt.getTime() ?? -1)) {
            return CONCURRENT_UPDATE_CONFLICT
          }
          stored = {
            ...data,
            id: 'n1',
            updatedAt: new Date((stored?.updatedAt.getTime() ?? 0) + 1)
          }
          return structuredClone(stored)
        }
      )
      const results = await Promise.all([upload('A'), upload('B')])
      expect(results.every((r) => r.success)).toBe(true)
      expect(stored.breakfast.map((i: any) => i.name).sort()).toEqual(
        missing ? ['A', 'B'] : ['A', 'B', 'Prior']
      )
      expect(new Set(stored.breakfast.map((i: any) => i.id)).size).toBe(missing ? 2 : 3)
      expect(stored.calories).toBe(missing ? 200 : 250)
      expect(stored.carbs).toBe(missing ? 40 : 50)
      expect(nutritionRepository.saveWithVersionCheck).toHaveBeenCalledTimes(3)
    })
  }

  it('rebuilds after a committed item edit and retains incoming IDs across retries', async () => {
    const original = { id: 'n1', updatedAt: new Date(0), breakfast: [{ id: 'old', calories: 50 }] }
    vi.mocked(nutritionRepository.getByDate)
      .mockResolvedValueOnce(original as any)
      .mockResolvedValue({
        ...original,
        updatedAt: new Date(1),
        breakfast: [{ id: 'old', calories: 75 }]
      } as any)
    vi.mocked(nutritionRepository.saveWithVersionCheck)
      .mockResolvedValueOnce(CONCURRENT_UPDATE_CONFLICT)
      .mockImplementation(async (_u, _d, _s, data) => data as any)
    const result = await upload('New')
    expect(result.data.calories).toBe(175)
    expect(result.data.breakfast[0]).toEqual({ id: 'old', calories: 75 })
    const calls = vi.mocked(nutritionRepository.saveWithVersionCheck).mock.calls
    expect((calls[0]![3].breakfast as any[])[1].id).toBe((calls[1]![3].breakfast as any[])[1].id)
  })

  it.each(['session', 'api-key'])(
    'preserves replace-by-source and untouched buckets for %s',
    async (authType) => {
      vi.mocked(nutritionRepository.getByDate).mockResolvedValue({
        id: 'n1',
        updatedAt: new Date(0),
        breakfast: [
          { id: 'manual', source: 'manual' },
          { id: 'other', source: 'oauth:other' }
        ],
        dinner: [{ id: 'dinner', source: 'manual' }],
        rawJson: { retained: true }
      } as any)
      vi.mocked(nutritionRepository.saveWithVersionCheck).mockImplementation(
        async (_u, _d, _s, data) => data as any
      )
      const result = await upload('Replacement', authType, {
        calories: 999,
        carbs: 88,
        protein: 77,
        fat: 66,
        waterMl: 123
      })
      expect(result.data.breakfast.map((i: any) => i.id)).toEqual(['other', expect.any(String)])
      expect(result.data.breakfast[1].source).toBe('manual')
      expect(result.data.dinner).toEqual([{ id: 'dinner', source: 'manual' }])
      expect(result.data).toMatchObject({
        calories: 999,
        carbs: 88,
        protein: 77,
        fat: 66,
        waterMl: 123,
        rawJson: { retained: true }
      })
    }
  )

  it('reconciles only after persistence completes', async () => {
    let release!: (value: any) => void
    let saving!: () => void
    const started = new Promise<void>((resolve) => {
      saving = resolve
    })
    vi.mocked(nutritionRepository.saveWithVersionCheck).mockImplementation(() => {
      saving()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const { metabolicService } =
      await import('../../../../../server/utils/services/metabolicService')
    const { nutritionPlanService } =
      await import('../../../../../server/utils/services/nutritionPlanService')
    const pending = upload('New')
    await started
    expect(metabolicService.calculateFuelingPlanForDate).not.toHaveBeenCalled()
    expect(nutritionPlanService.reconcileLoggedMealsForDate).not.toHaveBeenCalled()
    release({ id: 'saved' })
    await expect(pending).resolves.toMatchObject({ success: true, data: { id: 'saved' } })
    expect(nutritionPlanService.reconcileLoggedMealsForDate).toHaveBeenCalledWith(
      'user-1',
      new Date('2026-07-21'),
      'UTC'
    )
  })

  it('bounds conflicts and never reconciles failed persistence', async () => {
    vi.mocked(nutritionRepository.saveWithVersionCheck).mockResolvedValue(
      CONCURRENT_UPDATE_CONFLICT
    )
    await expect(upload('New')).rejects.toMatchObject({ statusCode: 409 })
    expect(nutritionRepository.getByDate).toHaveBeenCalledTimes(3)
    expect(nutritionRepository.saveWithVersionCheck).toHaveBeenCalledTimes(3)
    const { metabolicService } =
      await import('../../../../../server/utils/services/metabolicService')
    const { nutritionPlanService } =
      await import('../../../../../server/utils/services/nutritionPlanService')
    expect(metabolicService.calculateFuelingPlanForDate).not.toHaveBeenCalled()
    expect(nutritionPlanService.reconcileLoggedMealsForDate).not.toHaveBeenCalled()
  })

  it('rejects unauthorized requests before reading or saving a day', async () => {
    vi.mocked(requireAuth).mockRejectedValue({ statusCode: 401 })
    await expect(upload('New')).rejects.toMatchObject({ statusCode: 401 })
    expect(nutritionRepository.getByDate).not.toHaveBeenCalled()
    expect(nutritionRepository.saveWithVersionCheck).not.toHaveBeenCalled()
  })
})
