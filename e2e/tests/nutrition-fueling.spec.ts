import { differenceInCalendarDays, startOfWeek } from 'date-fns'
import { test, expect } from '../fixtures/test-fixtures.ts'
import { E2E_ATHLETE_EMAIL } from '../seed.ts'
import { createE2ePrisma } from '../helpers/db.ts'
import type { Page } from '@playwright/test'

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/coach_wattz_e2e'

const ATHLETE_WEIGHT_KG = 80

/**
 * End-to-end coverage for the day-level fueling engine.
 *
 * These exercise the behaviours that unit tests cannot: that a real request produces windows with
 * stable keys, that locking a meal writes one row per window, and that the weekly plan renders the
 * result in clock order.
 */
test.describe('Nutrition fueling plan', () => {
  test.describe.configure({ mode: 'serial' })

  let prisma: ReturnType<typeof createE2ePrisma>['prisma']
  let cleanupPool: ReturnType<typeof createE2ePrisma>['pool']
  let athleteId: string

  /** Monday of the current week, so the weekly-plan UI shows the days we seed. */
  function getWeekStart() {
    return startOfWeek(new Date(), { weekStartsOn: 1 })
  }

  const dayOffset = (offset: number) => {
    const date = new Date(getWeekStart().getTime() + offset * 86400000)
    // The API queries UTC calendar days while the calendar renders local date parts.
    // Noon keeps the fixture on the same day in both representations.
    date.setHours(12, 0, 0, 0)
    return date
  }
  const dateKey = (date: Date) =>
    [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-')

  // Keep this suite away from the current and next day. Other parallel E2E specs create
  // workouts there, which would otherwise change the number of generated fueling windows.
  // A fixed offset (e.g. "Monday + 6") lands on a different weekday depending on which day the
  // suite actually runs, so it can silently collide with "today" - pick offsets fresh each run,
  // excluding whichever two of the week's seven days are today/tomorrow.
  const todayOffset = ((differenceInCalendarDays(new Date(), getWeekStart()) % 7) + 7) % 7
  const excludedOffsets = new Set([todayOffset, (todayOffset + 1) % 7])
  const [stackedOffset, splitOffset, restOffset] = [0, 1, 2, 3, 4, 5, 6].filter(
    (offset) => !excludedOffsets.has(offset)
  )

  const STACKED_DAY = () => dayOffset(stackedOffset) // two sessions back to back
  const SPLIT_DAY = () => dayOffset(splitOffset) // morning and evening sessions
  const REST_DAY = () => dayOffset(restOffset) // no training at all

  async function clearDay(date: Date) {
    const key = dateKey(date)
    await prisma.plannedWorkout.deleteMany({ where: { userId: athleteId, date } })
    await prisma.workout.deleteMany({
      where: {
        userId: athleteId,
        date: { gte: new Date(`${key}T00:00:00.000Z`), lte: new Date(`${key}T23:59:59.999Z`) }
      }
    })
    await prisma.nutrition.deleteMany({ where: { userId: athleteId, date } })
  }

  async function seedPlanned(
    date: Date,
    workouts: Array<{
      id: string
      title: string
      type: string
      durationSec: number
      startTime: string
      workIntensity: number
      tss?: number
    }>
  ) {
    for (const workout of workouts) {
      await prisma.plannedWorkout.upsert({
        where: { id: workout.id },
        update: { ...workout, userId: athleteId, date, externalId: workout.id, completed: false },
        create: { ...workout, userId: athleteId, date, externalId: workout.id, completed: false }
      })
    }
  }

  /** Forces a fresh plan for the date and returns the persisted day. */
  async function buildPlan(page: Page, date: Date) {
    const key = dateKey(date)
    const generated = await page.request.post('/api/nutrition/generate-plan', {
      data: { date: `${key}T00:00:00.000Z` }
    })
    expect(generated.ok(), await generated.text()).toBeTruthy()

    const day = await page.request.get(`/api/nutrition/${key}`)
    expect(day.ok(), await day.text()).toBeTruthy()
    return day.json()
  }

  const windowsOf = (plan: any) => (plan?.fuelingPlan?.windows ?? []) as any[]
  const keysOf = (plan: any) => windowsOf(plan).map((w) => w.windowKey)
  const ofType = (plan: any, type: string) => windowsOf(plan).filter((w) => w.type === type)

  test.beforeAll(async () => {
    const db = createE2ePrisma(DATABASE_URL)
    prisma = db.prisma
    cleanupPool = db.pool

    const athlete = await prisma.user.findUnique({ where: { email: E2E_ATHLETE_EMAIL } })
    expect(athlete).toBeTruthy()
    athleteId = athlete!.id

    // Pin the inputs the engine reads so the assertions are about behaviour, not defaults.
    await prisma.user.update({
      where: { id: athleteId },
      data: { weight: ATHLETE_WEIGHT_KG, ftp: 250, timezone: 'UTC' }
    })

    await prisma.userNutritionSettings.upsert({
      where: { userId: athleteId },
      update: {
        preWorkoutWindow: 90,
        postWorkoutWindow: 60,
        currentCarbMax: 90,
        mealPattern: [
          { name: 'Breakfast', time: '07:00' },
          { name: 'Lunch', time: '12:00' },
          { name: 'Dinner', time: '19:00' }
        ]
      },
      create: {
        userId: athleteId,
        preWorkoutWindow: 90,
        postWorkoutWindow: 60,
        currentCarbMax: 90,
        mealPattern: [
          { name: 'Breakfast', time: '07:00' },
          { name: 'Lunch', time: '12:00' },
          { name: 'Dinner', time: '19:00' }
        ]
      }
    })

    // The draft planner picks from this catalog; INTRA templates are what used to be missing.
    const templates = [
      {
        title: 'E2E Pre Oats',
        windowType: 'PRE',
        absorptionType: 'BALANCED',
        baseMacros: { carbs: 60, protein: 8, fat: 5, kcal: 320 },
        keyIngredient: 'Oats',
        ingredients: [{ item: 'Oats', quantity: 60, unit: 'g', isScalable: true }],
        prepMinutes: 5
      },
      {
        title: 'E2E Intra Drink Mix',
        windowType: 'INTRA',
        absorptionType: 'RAPID',
        baseMacros: { carbs: 60, protein: 0, fat: 0, kcal: 240 },
        keyIngredient: 'Carb Powder',
        ingredients: [{ item: 'Carb Powder', quantity: 65, unit: 'g', isScalable: true }],
        prepMinutes: 2
      },
      {
        title: 'E2E Post Rice Bowl',
        windowType: 'POST',
        absorptionType: 'BALANCED',
        baseMacros: { carbs: 65, protein: 40, fat: 9, kcal: 500 },
        keyIngredient: 'Rice',
        ingredients: [{ item: 'Rice', quantity: 85, unit: 'g', isScalable: true }],
        prepMinutes: 20
      },
      {
        title: 'E2E Base Pasta',
        windowType: 'BASE',
        absorptionType: 'BALANCED',
        baseMacros: { carbs: 80, protein: 35, fat: 12, kcal: 580 },
        keyIngredient: 'Pasta',
        ingredients: [{ item: 'Pasta', quantity: 100, unit: 'g', isScalable: true }],
        prepMinutes: 20
      }
    ]

    for (const template of templates) {
      const existing = await prisma.mealOptionCatalog.findFirst({
        where: { title: template.title }
      })
      const data = { ...template, dietaryBuckets: [], constraintTags: [], source: 'SYSTEM' }
      if (existing) {
        await prisma.mealOptionCatalog.update({ where: { id: existing.id }, data })
      } else {
        await prisma.mealOptionCatalog.create({ data })
      }
    }

    for (const date of [STACKED_DAY(), SPLIT_DAY(), REST_DAY()]) {
      await clearDay(date)
    }

    await prisma.nutritionPlanMeal.deleteMany({
      where: { plan: { userId: athleteId } }
    })
    await prisma.nutritionPlan.deleteMany({ where: { userId: athleteId } })

    await seedPlanned(STACKED_DAY(), [
      {
        id: 'e2e-fuel-stacked-a',
        title: 'E2E Treadmill Warmup',
        type: 'Run',
        durationSec: 1800,
        startTime: '08:00',
        workIntensity: 0.65,
        tss: 24
      },
      {
        id: 'e2e-fuel-stacked-b',
        title: 'E2E Full-Body Strength',
        type: 'WeightTraining',
        durationSec: 3600,
        startTime: '08:40',
        workIntensity: 0.8,
        tss: 42
      },
      {
        // 31 TSS in 8 minutes implies IF ~1.5, which used to promote the whole day to state 3.
        id: 'e2e-fuel-stacked-c',
        title: 'E2E Strength Finisher',
        type: 'WeightTraining',
        durationSec: 480,
        startTime: '09:45',
        workIntensity: 1.5,
        tss: 31
      }
    ])

    await seedPlanned(SPLIT_DAY(), [
      {
        id: 'e2e-fuel-split-am',
        title: 'E2E Morning Endurance Ride',
        type: 'Ride',
        durationSec: 5400,
        startTime: '06:30',
        workIntensity: 0.7,
        tss: 58
      },
      {
        id: 'e2e-fuel-split-pm',
        title: 'E2E Evening Intervals',
        type: 'Ride',
        durationSec: 4500,
        startTime: '17:00',
        workIntensity: 0.92,
        tss: 95
      }
    ])
  })

  test.afterAll(async () => {
    await prisma.$disconnect()
    await cleanupPool.end()
  })

  test('back-to-back sessions share a single pre and post window', async ({ authedPage }) => {
    const plan = await buildPlan(authedPage, STACKED_DAY())

    expect(ofType(plan, 'PRE_WORKOUT')).toHaveLength(1)
    expect(ofType(plan, 'POST_WORKOUT')).toHaveLength(1)

    // The pre window must cover the whole block, not just the first session.
    const pre = ofType(plan, 'PRE_WORKOUT')[0]
    expect(pre.workoutTitle).toContain('E2E Treadmill Warmup')
    expect(pre.workoutTitle).toContain('E2E Full-Body Strength')
  })

  test('separate sessions get their own windows with unique keys', async ({ authedPage }) => {
    const plan = await buildPlan(authedPage, SPLIT_DAY())

    expect(ofType(plan, 'PRE_WORKOUT')).toHaveLength(2)
    expect(ofType(plan, 'POST_WORKOUT')).toHaveLength(2)

    const keys = keysOf(plan)
    expect(keys).toContain('PRE_WORKOUT#1')
    expect(keys).toContain('PRE_WORKOUT#2')
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('windows are chronological and every one carries a calorie target', async ({
    authedPage
  }) => {
    const plan = await buildPlan(authedPage, SPLIT_DAY())
    const windows = windowsOf(plan)

    expect(windows.length).toBeGreaterThan(0)

    const times = windows.map((w) => new Date(w.startTime).getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))

    for (const window of windows) {
      expect(window.targetKcal, `${window.windowKey} has no kcal`).toBeGreaterThan(0)
      expect(window.targetKcal).toBe(
        window.targetCarbs * 4 + window.targetProtein * 4 + window.targetFat * 9
      )
    }
  })

  test('a rest day gets baseline windows instead of none at all', async ({ authedPage }) => {
    const plan = await buildPlan(authedPage, REST_DAY())
    const windows = windowsOf(plan)

    expect(windows.length).toBeGreaterThan(0)
    expect(windows.every((w) => w.type === 'DAILY_BASE')).toBeTruthy()
    expect(keysOf(plan)).toContain('DAILY_BASE:breakfast')
    expect(plan.fuelingPlan.dailyTotals.fuelState).toBe(1)
  })

  test('one implausibly short session does not drive the day to state 3', async ({
    authedPage
  }) => {
    const plan = await buildPlan(authedPage, STACKED_DAY())
    expect(plan.fuelingPlan.dailyTotals.fuelState).toBeLessThan(3)
  })

  test('window macros reconcile against the daily targets', async ({ authedPage }) => {
    const plan = await buildPlan(authedPage, SPLIT_DAY())
    const windows = windowsOf(plan)
    const totals = plan.fuelingPlan.dailyTotals

    const sum = (key: string) => windows.reduce((acc, w) => acc + Number(w[key] || 0), 0)

    expect(sum('targetCarbs')).toBe(totals.carbs)
    expect(sum('targetProtein')).toBe(totals.protein)
    expect(sum('targetFat')).toBe(totals.fat)

    // No single sitting may exceed 2 g/kg of carbohydrate.
    for (const window of windows.filter((w) => w.type !== 'INTRA_WORKOUT')) {
      expect(window.targetCarbs).toBeLessThanOrEqual(ATHLETE_WEIGHT_KG * 2 + 1)
    }
  })

  test('locking a meal binds to one window and leaves its sibling unplanned', async ({
    authedPage
  }) => {
    await buildPlan(authedPage, SPLIT_DAY())
    const key = dateKey(SPLIT_DAY())

    const locked = await authedPage.request.post('/api/nutrition/plan/meal', {
      data: {
        date: key,
        windowType: 'PRE_WORKOUT',
        windowKey: 'PRE_WORKOUT#2',
        meal: { title: 'E2E Evening Pre Meal', totals: { carbs: 60, protein: 20, kcal: 400 } }
      }
    })
    expect(locked.ok(), await locked.text()).toBeTruthy()

    const meals = await prisma.nutritionPlanMeal.findMany({
      where: { plan: { userId: athleteId }, date: new Date(`${key}T00:00:00.000Z`) }
    })

    const preMeals = meals.filter((m) => m.windowType.startsWith('PRE_WORKOUT'))
    expect(preMeals).toHaveLength(1)
    expect(preMeals[0]!.windowType).toBe('PRE_WORKOUT#2')

    // The plan the UI reads must show only the second window as planned.
    const planResponse = await authedPage.request.get(`/api/nutrition/plan?start=${key}&end=${key}`)
    expect(planResponse.ok()).toBeTruthy()
    const planPayload = await planResponse.json()
    const returned = (planPayload?.plan?.meals ?? planPayload?.meals ?? []) as any[]
    expect(returned.filter((m) => m.windowType === 'PRE_WORKOUT#1')).toHaveLength(0)
  })

  test('draft generation fills every window from the catalog, including intra', async ({
    authedPage
  }) => {
    const start = dateKey(STACKED_DAY())
    const end = dateKey(SPLIT_DAY())

    const generated = await authedPage.request.post('/api/nutrition/plan/generate', {
      data: { startDate: start, endDate: end }
    })
    expect(generated.ok(), await generated.text()).toBeTruthy()

    const meals = await prisma.nutritionPlanMeal.findMany({
      where: {
        plan: { userId: athleteId },
        date: { gte: new Date(`${start}T00:00:00.000Z`), lte: new Date(`${end}T00:00:00.000Z`) }
      }
    })

    const windowTypes = meals.map((m) => m.windowType)

    // Baseline slots and intra windows both used to be unreachable for the draft planner.
    expect(windowTypes.some((t) => t.startsWith('DAILY_BASE:'))).toBeTruthy()
    expect(windowTypes.some((t) => t.startsWith('INTRA_WORKOUT'))).toBeTruthy()

    // Two pre windows on the split day must not collapse onto one row.
    const splitPre = meals.filter(
      (m) => m.date.toISOString().slice(0, 10) === end && m.windowType.startsWith('PRE_WORKOUT')
    )
    expect(splitPre.length).toBe(2)
  })

  test('reports training hours even when a session needs no intra window', async ({
    authedPage
  }) => {
    // The stacked day is a run plus two gym blocks: none of them earns an intra-workout window,
    // so the Fluid Balance breakdown cannot recover training time by summing windows.
    const plan = await buildPlan(authedPage, STACKED_DAY())
    const totals = plan.fuelingPlan.dailyTotals

    expect(ofType(plan, 'INTRA_WORKOUT')).toHaveLength(0)
    expect(totals.trainingHours).toBeGreaterThan(0)
    expect(totals.trainingHours).toBeCloseTo((1800 + 3600 + 480) / 3600, 2)
    // Sweat loss from those sessions still has to reach the day's fluid target.
    expect(totals.fluid).toBeGreaterThan(2000)
  })

  test('a shared pre window belongs to every session in its block', async ({ authedPage }) => {
    const plan = await buildPlan(authedPage, STACKED_DAY())
    const pre = ofType(plan, 'PRE_WORKOUT')[0]
    const post = ofType(plan, 'POST_WORKOUT')[0]

    // The planned-workout page filters a day's windows down to one session; without the full id
    // list every session but the first loses the shared pre window.
    for (const window of [pre, post]) {
      expect(window.plannedWorkoutIds).toContain('e2e-fuel-stacked-a')
      expect(window.plannedWorkoutIds).toContain('e2e-fuel-stacked-b')
      expect(window.plannedWorkoutIds).toContain('e2e-fuel-stacked-c')
    }
  })

  test('a session inside a merged block shows both its pre and post windows', async ({
    authedPage
  }) => {
    await buildPlan(authedPage, STACKED_DAY())

    // This asserts the rendered outcome, not the day-plan filter beneath it: the page prefers the
    // per-workout fueling endpoint and only falls back to filtering the day's windows by session
    // id, so the filter itself is covered by the plannedWorkoutIds assertions above.
    await authedPage.goto('/workouts/planned/e2e-fuel-stacked-a', {
      waitUntil: 'domcontentloaded'
    })

    await expect(authedPage.getByText('Pre-Workout Target')).toBeVisible({ timeout: 20000 })
    await expect(authedPage.getByText('Post-Workout Recovery')).toBeVisible({ timeout: 20000 })
  })

  test('calendar shows a fuel state for a day with no intra-workout window', async ({
    authedPage
  }) => {
    const plan = await buildPlan(authedPage, STACKED_DAY())
    expect(ofType(plan, 'INTRA_WORKOUT')).toHaveLength(0)

    await authedPage.goto('/activities', { waitUntil: 'domcontentloaded' })

    const cell = authedPage.locator(
      `[data-testid="calendar-day-cell"][data-date="${dateKey(STACKED_DAY())}"]`
    )
    await expect(cell).toBeVisible({ timeout: 20000 })

    // The dot used to be parsed out of the intra window's description, so a gym day showed none.
    await expect(cell).not.toHaveAttribute('data-fuel-state', '', { timeout: 20000 })
    await expect(cell.locator('[title^="Fuel State"]')).toBeVisible()
  })

  test('never reports absorbing more carbohydrate than was logged', async ({ authedPage }) => {
    // The glycogen tank is driven by how much of each meal has been absorbed so far. The midpoint
    // approximation this replaced peaked well above the meal size a few hours in, then decayed
    // back toward zero, so the tank read high all afternoon and collapsed in the evening.
    const today = new Date()
    const todayKey = today.toISOString().slice(0, 10)
    const dayStart = new Date(`${todayKey}T00:00:00.000Z`)
    const loggedCarbs = 60
    const loggedAt = new Date(today.getTime() - 3 * 60 * 60 * 1000)

    await prisma.nutrition.deleteMany({ where: { userId: athleteId, date: dayStart } })
    await prisma.nutrition.create({
      data: {
        userId: athleteId,
        date: dayStart,
        carbs: loggedCarbs,
        calories: loggedCarbs * 4,
        protein: 0,
        fat: 0,
        carbsGoal: 300,
        caloriesGoal: 2400,
        breakfast: [
          {
            id: 'e2e-absorption-meal',
            name: 'E2E Porridge',
            carbs: loggedCarbs,
            protein: 0,
            fat: 0,
            calories: loggedCarbs * 4,
            logged_at: loggedAt.toISOString()
          }
        ] as any
      }
    })

    const response = await authedPage.request.get(`/api/nutrition/${todayKey}`)
    expect(response.ok(), await response.text()).toBeTruthy()
    const day = await response.json()

    const absorbed = Number(day?.breakdown?.replenishment?.actualCarbs)
    expect(Number.isFinite(absorbed)).toBeTruthy()
    expect(absorbed).toBeGreaterThan(0)
    expect(absorbed).toBeLessThanOrEqual(loggedCarbs)

    await prisma.nutrition.deleteMany({ where: { userId: athleteId, date: dayStart } })
  })

  test('projects a hard future day using its own carb target, not the lowest fuel state', async ({
    authedPage
  }) => {
    // A day with no saved nutrition row used to be projected at fuelState1Min, so the energy
    // horizon showed a glycogen crash on sessions the plan actually fuels.
    // Beyond the seeded week, so both days are unambiguously in the future. Today's projection
    // suppresses synthetic meals for hours that have already passed, which would mask the effect.
    const hardDay = dayOffset(8)
    const easyDay = dayOffset(9)
    await clearDay(hardDay)
    await clearDay(easyDay)

    await seedPlanned(hardDay, [
      {
        id: 'e2e-fuel-horizon-hard',
        title: 'E2E Long Endurance Ride',
        type: 'Ride',
        durationSec: 5 * 3600,
        startTime: '08:00',
        workIntensity: 0.75,
        tss: 250
      }
    ])

    // Neither day has a persisted plan, so both are projected.
    const response = await authedPage.request.get(
      `/api/nutrition/metabolic-wave?startDate=${dateKey(hardDay)}&endDate=${dateKey(easyDay)}`
    )
    expect(response.ok(), await response.text()).toBeTruthy()
    const wave = await response.json()

    const pointsFor = (date: Date) =>
      (wave.points ?? []).filter((p: any) => p.dateKey === dateKey(date))

    const projectedIntake = (date: Date) =>
      pointsFor(date)
        .filter((p: any) => p.eventType === 'meal')
        .reduce((sum: number, p: any) => sum + Number(p.eventCarbs || 0), 0)

    expect(pointsFor(hardDay).length).toBeGreaterThan(0)
    expect(pointsFor(easyDay).length).toBeGreaterThan(0)

    // Compared against a rest day rather than a fixed number, so the assertion tracks the athlete's
    // own settings. Pinned to the state 1 floor, a five hour ride projected barely more than a day
    // off; driven by the day's real target it projects substantially more.
    const hardIntake = projectedIntake(hardDay)
    const restIntake = projectedIntake(easyDay)

    expect(restIntake).toBeGreaterThan(0)
    expect(hardIntake).toBeGreaterThan(restIntake * 1.4)

    await clearDay(hardDay)
    await clearDay(easyDay)
  })

  test('weekly plan renders windows in clock order with times and calories', async ({
    authedPage
  }) => {
    await buildPlan(authedPage, SPLIT_DAY())

    // The weekly tab renders the draft snapshot, so the day needs one before it shows anything.
    const draft = await authedPage.request.post('/api/nutrition/plan/generate', {
      data: { startDate: dateKey(SPLIT_DAY()), endDate: dateKey(SPLIT_DAY()) }
    })
    expect(draft.ok(), await draft.text()).toBeTruthy()

    await authedPage.goto('/nutrition', { waitUntil: 'domcontentloaded' })

    // The tabs are client-rendered; clicking before hydration silently does nothing.
    const planTab = authedPage.getByRole('tab', { name: /weekly plan/i })
    await expect(planTab).toBeVisible({ timeout: 20000 })
    await expect(async () => {
      await planTab.click()
      await expect(planTab).toHaveAttribute('aria-selected', 'true', { timeout: 2000 })
    }).toPass({ timeout: 20000 })

    const dayRow = authedPage.locator(
      `[data-testid="plan-day-row"][data-date="${dateKey(SPLIT_DAY())}"]`
    )
    await expect(dayRow).toBeVisible({ timeout: 20000 })
    // Rows render before the plan request settles; opening the drawer first would show an empty day.
    await expect(dayRow).toHaveAttribute('data-loaded', 'true', { timeout: 20000 })
    await dayRow.click()

    const windowRows = authedPage.locator('[data-testid="plan-window-row"]')
    await expect(windowRows.first()).toBeVisible({ timeout: 15000 })

    const count = await windowRows.count()
    expect(count).toBeGreaterThan(1)

    const starts: number[] = []
    for (let i = 0; i < count; i++) {
      const row = windowRows.nth(i)
      const kcal = Number(await row.getAttribute('data-window-kcal'))
      const start = await row.getAttribute('data-window-start')

      // "0 KCAL" on every card was the visible symptom of windows carrying no calorie target.
      expect(kcal, `window ${i} rendered without calories`).toBeGreaterThan(0)
      expect(start).toBeTruthy()
      starts.push(new Date(start!).getTime())

      await expect(row.locator('[data-testid="plan-window-time"]')).toBeVisible()
    }

    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })
})
