import { addDays, endOfDay, format, startOfWeek } from 'date-fns'
import { prisma } from '../db'
import { getUserTimezone, parseDateTimeInTimezone } from '../date'
import { dailyBaseWindowKey } from '../../../shared/window-keys'
import { nutritionRepository } from '../repositories/nutritionRepository'
import { bodyMetricResolver } from './bodyMetricResolver'
import { metabolicService } from './metabolicService'
import { mealRecommendationService } from './mealRecommendationService'

type WindowAssignment = {
  windowType: string
  /** Stable per-day identity, e.g. `PRE_WORKOUT#2`. Falls back to the window type when absent. */
  windowKey?: string
  slotName?: string
  label?: string
  targetCarbs?: number
  targetProtein?: number
  targetKcal?: number
}

type PlanMealAction = 'complete' | 'skip' | 'unlock' | 'replace'

function toFiniteNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toDayStartUtc(date: Date | string) {
  const dateKey = typeof date === 'string' ? date.slice(0, 10) : format(date, 'yyyy-MM-dd')
  const parsed = new Date(`${dateKey}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date for lockMeal: ${String(date)}`)
  }
  return parsed
}

function toDayEndUtc(date: Date | string) {
  const start = toDayStartUtc(date)
  return new Date(`${format(start, 'yyyy-MM-dd')}T23:59:59.999Z`)
}

function toDateKey(value: unknown) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  const parsed = new Date(value as any)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toISOString().slice(0, 10)
}

function normalizeIngredientName(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function toUpperList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean)
}

export const nutritionPlanService = {
  toDailyBaseWindowKey(slotName?: string) {
    // Legacy windows carry no windowKey, so their key is re-derived here. It has to be derived the
    // same way the generator derives it - divergent slugifier copies silently unlinked stored
    // meals once already, so the canonical implementation lives in shared/window-keys.
    return dailyBaseWindowKey(slotName)
  },

  sanitizeMealTitle(value: unknown) {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return ''
    return raw.replace(/^(?:\s*(?:option\s*\d+|daily\s*base)\s*[:\-–]\s*)+/i, '').trim()
  },

  getWindowAssignmentKey(date: Date | string, windowType: string) {
    return `${toDateKey(date)}|${windowType}`
  },

  /**
   * Persistence key for a window.
   *
   * A day can hold several windows of the same type (two sessions produce two PRE_WORKOUT
   * windows), so the type alone cannot identify one. The day builder stamps each window with a
   * `windowKey`; anything older falls back to the bare type, which addresses the first window of
   * that type.
   */
  normalizeWindowType(windowType: string, slotName?: string, label?: string, windowKey?: string) {
    if (windowKey) return windowKey
    if (windowType !== 'DAILY_BASE') return windowType
    return this.toDailyBaseWindowKey(slotName || label)
  },

  resolveWindowKey(window: any) {
    if (!window) return ''
    if (window.windowKey) return String(window.windowKey)
    return this.normalizeWindowType(window.type, window.slotName, window.label)
  },

  getWeekStartUtc(date: Date | string) {
    const dayStartUtc = toDayStartUtc(date)
    const weekStart = startOfWeek(dayStartUtc, { weekStartsOn: 1 })
    return toDayStartUtc(weekStart)
  },

  getWeekEndUtc(date: Date | string) {
    return toDayEndUtc(addDays(this.getWeekStartUtc(date), 6))
  },

  async findPlanForDate(userId: string, date: Date | string) {
    const dayStartUtc = toDayStartUtc(date)
    return prisma.nutritionPlan.findFirst({
      where: {
        userId,
        startDate: { lte: dayStartUtc },
        endDate: { gte: dayStartUtc }
      },
      include: {
        meals: {
          where: { date: dayStartUtc },
          orderBy: { scheduledAt: 'asc' }
        }
      }
    })
  },

  async getOrCreateWeeklyPlan(userId: string, date: Date | string, status: string = 'DRAFT') {
    const weekStart = this.getWeekStartUtc(date)
    const weekEnd = this.getWeekEndUtc(date)

    const existing = await prisma.nutritionPlan.findFirst({
      where: {
        userId,
        startDate: weekStart
      },
      include: {
        meals: true
      }
    })

    if (existing) return existing

    try {
      return await prisma.nutritionPlan.create({
        data: {
          userId,
          startDate: weekStart,
          endDate: weekEnd,
          status
        },
        include: {
          meals: true
        }
      })
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const raced = await prisma.nutritionPlan.findFirst({
          where: {
            userId,
            startDate: weekStart
          },
          include: {
            meals: true
          }
        })
        if (raced) return raced
      }
      throw error
    }
  },

  getWindowSummaryForDay(daySummary: any, windowType: string) {
    const windows = Array.isArray(daySummary?.fuelingPlan?.windows)
      ? daySummary.fuelingPlan.windows
      : []
    return windows.find((window: any) => this.resolveWindowKey(window) === windowType)
  },

  buildTargetJson(window: any, fallbackTotals?: any) {
    return {
      carbs: Number(window?.targetCarbs ?? fallbackTotals?.carbs ?? 0),
      protein: Number(window?.targetProtein ?? fallbackTotals?.protein ?? 0),
      kcal: Number(window?.targetKcal ?? fallbackTotals?.kcal ?? 0)
    }
  },

  normalizeMealPayload(meal: any) {
    const normalizedTotals = {
      carbs: toFiniteNumber(meal?.totals?.carbs ?? meal?.carbs),
      protein: toFiniteNumber(meal?.totals?.protein ?? meal?.protein),
      kcal: toFiniteNumber(
        meal?.totals?.kcal ?? meal?.totals?.calories ?? meal?.kcal ?? meal?.calories
      ),
      fat: toFiniteNumber(meal?.totals?.fat ?? meal?.fat)
    }

    return {
      ...(meal || {}),
      title:
        this.sanitizeMealTitle(meal?.title) ||
        this.sanitizeMealTitle(meal?.name) ||
        meal?.title ||
        meal?.name ||
        'Meal',
      totals: normalizedTotals
    }
  },

  matchPlanMealToWindow(planMeal: any, window: any) {
    if (!planMeal || !window) return false

    const expectedWindowType = this.resolveWindowKey(window)
    if (planMeal.windowType === expectedWindowType) return true

    // Rows written before stable keys existed stored the bare type. Those can only have referred
    // to the first window of that type on the day, so match them there and nowhere else.
    return planMeal.windowType === window.type && expectedWindowType === `${window.type}#1`
  },

  isWindowMealActive(planMeal: any) {
    const status = String(planMeal?.status || 'PLANNED').toUpperCase()
    return status !== 'SKIPPED' && status !== 'REPLACED'
  },

  async syncNutritionLocksForDate(userId: string, date: Date | string) {
    const dayStartUtc = toDayStartUtc(date)
    const [nutrition, plan] = await Promise.all([
      prisma.nutrition.findUnique({
        where: { userId_date: { userId, date: dayStartUtc } }
      }),
      this.findPlanForDate(userId, dayStartUtc)
    ])

    if (!nutrition || !plan || !(nutrition.fuelingPlan as any)?.windows) return

    const fuelingPlan = {
      ...((nutrition!.fuelingPlan as any) || {}),
      windows: Array.isArray((nutrition!.fuelingPlan as any)?.windows)
        ? [...((nutrition!.fuelingPlan as any).windows as any[])].map((window) => ({ ...window }))
        : []
    }
    const windows = Array.isArray(fuelingPlan.windows) ? [...fuelingPlan.windows] : []

    fuelingPlan.windows = windows.map((window: any) => {
      const activeMeal = (plan.meals || []).find(
        (planMeal: any) =>
          this.isWindowMealActive(planMeal) && this.matchPlanMealToWindow(planMeal, window)
      )

      if (!activeMeal) {
        return {
          ...window,
          isLocked: false,
          lockedMealId: null,
          lockedMeal: null
        }
      }

      return {
        ...window,
        isLocked: true,
        lockedMealId: activeMeal.id,
        lockedMeal: activeMeal.mealJson || null
      }
    })

    await prisma.nutrition.update({
      where: { id: nutrition!.id },
      data: { fuelingPlan }
    })
  },

  async getPlanForRange(userId: string, startDate: Date, endDate: Date) {
    const overlappingPlans = await prisma.nutritionPlan.findMany({
      where: {
        userId,
        startDate: { lte: endDate },
        endDate: { gte: startDate }
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      include: {
        meals: {
          where: {
            date: {
              gte: startDate,
              lte: endDate
            }
          },
          orderBy: [{ date: 'asc' }, { scheduledAt: 'asc' }]
        }
      }
    })

    if (!overlappingPlans.length) return null

    const primary = overlappingPlans[0]
    if (!primary) return null

    const mergedMealsMap = new Map<string, any>()
    for (const plan of overlappingPlans) {
      for (const meal of plan.meals) {
        const key = `${toDateKey(meal.date)}|${meal.windowType}`
        const existing = mergedMealsMap.get(key)
        if (
          !existing ||
          new Date(meal.updatedAt).getTime() > new Date(existing.updatedAt).getTime()
        ) {
          mergedMealsMap.set(key, meal)
        }
      }
    }

    return {
      ...primary,
      meals: Array.from(mergedMealsMap.values()).sort(
        (a: any, b: any) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
      )
    }
  },

  async lockMeal(
    userId: string,
    date: Date | string,
    windowType: string,
    meal: any,
    slotName?: string,
    options?: {
      windowAssignments?: WindowAssignment[]
      windowKey?: string
    }
  ) {
    const timezone = await getUserTimezone(userId)
    const dayStartUtc = toDayStartUtc(date)
    const rawAssignments =
      Array.isArray(options?.windowAssignments) && options.windowAssignments.length > 0
        ? options.windowAssignments
        : [{ windowType, slotName, windowKey: options?.windowKey }]

    const normalizedAssignments = rawAssignments
      .map((assignment) => ({
        ...assignment,
        normalizedWindowType: this.normalizeWindowType(
          assignment.windowType,
          assignment.slotName,
          assignment.label,
          assignment.windowKey
        )
      }))
      .filter(
        (assignment, index, all) =>
          all.findIndex(
            (candidate) => candidate.normalizedWindowType === assignment.normalizedWindowType
          ) === index
      )

    const plan = await this.getOrCreateWeeklyPlan(userId, dayStartUtc, 'ACTIVE')
    const normalizedMeal = this.normalizeMealPayload(meal)

    const assignmentTargetTotalCarbs = normalizedAssignments.reduce(
      (sum, assignment) => sum + Number(assignment.targetCarbs || 0),
      0
    )
    const assignmentTargetTotalProtein = normalizedAssignments.reduce(
      (sum, assignment) => sum + Number(assignment.targetProtein || 0),
      0
    )
    const assignmentTargetTotalKcal = normalizedAssignments.reduce(
      (sum, assignment) => sum + Number(assignment.targetKcal || 0),
      0
    )

    const splitTotalsForAssignments = normalizedAssignments.map((assignment, index) => {
      const denominator =
        assignmentTargetTotalCarbs > 0
          ? assignmentTargetTotalCarbs
          : assignmentTargetTotalProtein > 0
            ? assignmentTargetTotalProtein
            : assignmentTargetTotalKcal > 0
              ? assignmentTargetTotalKcal
              : normalizedAssignments.length
      const numerator =
        assignmentTargetTotalCarbs > 0
          ? Number(assignment.targetCarbs || 0)
          : assignmentTargetTotalProtein > 0
            ? Number(assignment.targetProtein || 0)
            : assignmentTargetTotalKcal > 0
              ? Number(assignment.targetKcal || 0)
              : 1
      const ratio = denominator > 0 ? numerator / denominator : 1 / normalizedAssignments.length

      return {
        ...assignment,
        ratio,
        totals: {
          carbs:
            index === normalizedAssignments.length - 1
              ? null
              : Math.round(Number(normalizedMeal.totals.carbs || 0) * ratio),
          protein:
            index === normalizedAssignments.length - 1
              ? null
              : Math.round(Number(normalizedMeal.totals.protein || 0) * ratio),
          kcal:
            index === normalizedAssignments.length - 1
              ? null
              : Math.round(Number(normalizedMeal.totals.kcal || 0) * ratio),
          fat:
            index === normalizedAssignments.length - 1
              ? null
              : Math.round(Number(normalizedMeal.totals.fat || 0) * ratio)
        }
      }
    })

    const assignedSoFar = splitTotalsForAssignments
      .slice(0, Math.max(0, splitTotalsForAssignments.length - 1))
      .reduce(
        (sum, assignment) => ({
          carbs: sum.carbs + Number(assignment.totals.carbs || 0),
          protein: sum.protein + Number(assignment.totals.protein || 0),
          kcal: sum.kcal + Number(assignment.totals.kcal || 0),
          fat: sum.fat + Number(assignment.totals.fat || 0)
        }),
        { carbs: 0, protein: 0, kcal: 0, fat: 0 }
      )

    const lastAssignment = splitTotalsForAssignments[splitTotalsForAssignments.length - 1]
    if (lastAssignment) {
      lastAssignment.totals = {
        carbs: Math.max(
          0,
          Math.round(Number(normalizedMeal.totals.carbs || 0) - assignedSoFar.carbs)
        ),
        protein: Math.max(
          0,
          Math.round(Number(normalizedMeal.totals.protein || 0) - assignedSoFar.protein)
        ),
        kcal: Math.max(0, Math.round(Number(normalizedMeal.totals.kcal || 0) - assignedSoFar.kcal)),
        fat: Math.max(0, Math.round(Number(normalizedMeal.totals.fat || 0) - assignedSoFar.fat))
      }
    }

    const nutrition = await prisma.nutrition.findUnique({
      where: { userId_date: { userId, date: dayStartUtc } }
    })
    const dayWindows = Array.isArray((nutrition?.fuelingPlan as any)?.windows)
      ? ((nutrition!.fuelingPlan as any).windows as any[])
      : []

    const persistedPlanMeals: any[] = []

    for (const assignment of splitTotalsForAssignments) {
      const mealForAssignment = {
        ...normalizedMeal,
        totals: {
          ...normalizedMeal.totals,
          ...assignment.totals
        },
        allocation: {
          ratio: assignment.ratio,
          splitAcrossWindows: splitTotalsForAssignments.length > 1,
          normalizedWindowType: assignment.normalizedWindowType
        }
      }

      // Without this, a re-lock that carries no explicit targets (the replace action does not)
      // overwrote the window target with the meal's own totals, making every target-vs-planned
      // comparison for the window self-referential.
      const hasExplicitTarget =
        assignment.targetCarbs != null ||
        assignment.targetProtein != null ||
        assignment.targetKcal != null
      const targetJson = {
        carbs: Number(assignment.targetCarbs ?? assignment.totals.carbs ?? 0),
        protein: Number(assignment.targetProtein ?? assignment.totals.protein ?? 0),
        kcal: Number(assignment.targetKcal ?? assignment.totals.kcal ?? 0)
      }

      // The window's clock time, so a manually locked meal doesn't sort to midnight while
      // generated ones sit at their window start.
      const sourceWindow = dayWindows.find(
        (window: any) => this.resolveWindowKey(window) === assignment.normalizedWindowType
      )
      const windowStart = sourceWindow?.startTime ? new Date(sourceWindow.startTime) : null
      const scheduledAt =
        windowStart && !Number.isNaN(windowStart.getTime())
          ? windowStart
          : typeof date === 'string'
            ? dayStartUtc
            : date

      const planMeal = await prisma.nutritionPlanMeal.upsert({
        where: {
          planId_date_windowType: {
            planId: plan.id,
            date: dayStartUtc,
            windowType: assignment.normalizedWindowType
          }
        },
        create: {
          planId: plan.id,
          date: dayStartUtc,
          windowType: assignment.normalizedWindowType,
          scheduledAt,
          status: 'PLANNED',
          targetJson,
          mealJson: mealForAssignment
        },
        update: {
          mealJson: {
            ...mealForAssignment,
            replacedPreviousTitle: undefined
          },
          status: 'PLANNED',
          scheduledAt,
          ...(hasExplicitTarget ? { targetJson } : {}),
          actualNutritionItemId: null,
          updatedAt: new Date()
        }
      })
      persistedPlanMeals.push(planMeal)
    }

    if (nutrition) {
      const fuelingPlan = {
        ...((nutrition.fuelingPlan as any) || {}),
        windows: Array.isArray((nutrition.fuelingPlan as any)?.windows)
          ? [...((nutrition.fuelingPlan as any).windows as any[])].map((window) => ({ ...window }))
          : []
      }
      for (let i = 0; i < splitTotalsForAssignments.length; i++) {
        const assignment = splitTotalsForAssignments[i]
        if (!assignment) continue

        const lockedMeal = persistedPlanMeals[i]
        const windowIndex = fuelingPlan.windows.findIndex(
          (window: any) => this.resolveWindowKey(window) === assignment.normalizedWindowType
        )

        if (windowIndex === -1) continue
        fuelingPlan.windows[windowIndex] = {
          ...fuelingPlan.windows[windowIndex],
          isLocked: true,
          lockedMealId: lockedMeal.id,
          lockedMeal: (lockedMeal as any)?.mealJson || null
        }
      }

      await prisma.nutrition.update({
        where: { id: nutrition.id },
        data: { fuelingPlan }
      })
    }

    await this.syncNutritionLocksForDate(userId, dayStartUtc)
    await this.reconcileLoggedMealsForDate(userId, dayStartUtc, timezone)

    if (persistedPlanMeals.length === 1) {
      return persistedPlanMeals[0]
    }

    return {
      id: persistedPlanMeals[0]?.id || null,
      planId: plan.id,
      date: dayStartUtc,
      windowType: 'MULTI',
      status: 'PLANNED',
      meals: persistedPlanMeals
    }
  },

  async generateDraftPlan(userId: string, startDate: Date, endDate: Date) {
    // Days are enumerated at UTC midnights: eachDayOfInterval steps host-local midnights,
    // which drifts against the UTC date keys the meals are stored under whenever the server
    // does not run in UTC.
    const rangeStart = toDayStartUtc(startDate)
    const lastDay = toDayStartUtc(endDate)
    const days: Date[] = []
    // Bound the work: the UI asks for at most a week; anything past a month is a bad request.
    const maxDays = 31
    for (
      let day = rangeStart;
      day <= lastDay && days.length < maxDays;
      day = new Date(day.getTime() + 86_400_000)
    ) {
      days.push(day)
    }

    // Each day's meals belong to the plan whose Monday-Sunday week covers that day. A range
    // may cross a week boundary (a client ahead of UTC serializes its local Monday as the
    // previous UTC Sunday), and resolving one plan from the start date both dropped the later
    // days and hid meals locked into the next week's plan from the dedupe map, duplicating
    // them (CW-667).
    const plansByWeekStart = new Map<string, any>()
    const existingMeals = new Map<string, any>()
    const planForDay = async (day: Date) => {
      const weekKey = toDateKey(this.getWeekStartUtc(day))
      let weekPlan = plansByWeekStart.get(weekKey)
      if (!weekPlan) {
        weekPlan = await this.getOrCreateWeeklyPlan(userId, day, 'DRAFT')
        plansByWeekStart.set(weekKey, weekPlan)
        for (const meal of weekPlan.meals || []) {
          existingMeals.set(this.getWindowAssignmentKey(meal.date, meal.windowType), meal)
        }
      }
      return weekPlan
    }
    const [settings, user] = await Promise.all([
      prisma.userNutritionSettings.findUnique({
        where: { userId },
        select: {
          dietaryProfile: true,
          foodAllergies: true,
          foodIntolerances: true,
          lifestyleExclusions: true
        }
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          weight: true,
          weightSourceMode: true
        }
      })
    ])
    const effectiveWeight = await bodyMetricResolver.resolveEffectiveWeight(userId, {
      weight: user?.weight,
      weightSourceMode: user?.weightSourceMode
    })

    const recommendationContextBase = {
      constraints: {
        dietaryProfile: toUpperList(settings?.dietaryProfile),
        foodAllergies: toUpperList(settings?.foodAllergies),
        foodIntolerances: toUpperList(settings?.foodIntolerances),
        lifestyleExclusions: toUpperList(settings?.lifestyleExclusions)
      },
      athlete: {
        weightKg: effectiveWeight.value || 75
      }
    }

    const daySummaries: any[] = []

    for (const day of days) {
      const dateKey = toDateKey(day)
      const plan = await planForDay(day)
      const nutritionData = await metabolicService.getNutritionDay(userId, dateKey)
      const targetContext = await metabolicService.getMealTargetContext(userId, day)
      const windows = Array.isArray((nutritionData.fuelingPlan as any)?.windows)
        ? (nutritionData.fuelingPlan as any).windows
        : []

      // Windows already chosen for this day, so the same template is not proposed twice.
      const usedTemplateIds = new Set<string>()

      for (const window of windows) {
        const normalizedWindowType = this.resolveWindowKey(window)
        const key = this.getWindowAssignmentKey(day, normalizedWindowType)
        const existingMeal = existingMeals.get(key)

        if (existingMeal) {
          await prisma.nutritionPlanMeal.update({
            where: { id: existingMeal.id },
            data: {
              targetJson: this.buildTargetJson(window, existingMeal.mealJson?.totals),
              scheduledAt: new Date(window.startTime),
              updatedAt: new Date()
            }
          })
          continue
        }

        const catalogOptions = await mealRecommendationService.selectFromCatalog(
          {
            ...recommendationContextBase,
            targetContext
          },
          'MEAL',
          window.type,
          {
            carbs: Number(window.targetCarbs || 0),
            protein: Number(window.targetProtein || 0),
            kcal: Number(window.targetKcal || 0)
          }
        )

        // Prefer the best-scoring option this day has not already used. Rotation is per-day only;
        // the same meal can still recur across the week.
        const selectedOption =
          catalogOptions.find((option: any) => option?.id && !usedTemplateIds.has(option.id)) ||
          catalogOptions[0]
        if (!selectedOption) continue
        if (selectedOption.id) usedTemplateIds.add(selectedOption.id)

        await prisma.nutritionPlanMeal.upsert({
          where: {
            planId_date_windowType: {
              planId: plan.id,
              // `day` is already a UTC day start; re-deriving it through the local-tz
              // formatter would shift it a day west of UTC.
              date: day,
              windowType: normalizedWindowType
            }
          },
          create: {
            planId: plan.id,
            date: day,
            windowType: normalizedWindowType,
            scheduledAt: new Date(window.startTime),
            status: 'PLANNED',
            targetJson: this.buildTargetJson(window, selectedOption.totals),
            mealJson: {
              ...selectedOption,
              autoGenerated: true,
              generatedFrom: 'catalog'
            }
          },
          update: {
            scheduledAt: new Date(window.startTime),
            targetJson: this.buildTargetJson(window, selectedOption.totals),
            mealJson: {
              ...selectedOption,
              autoGenerated: true,
              generatedFrom: 'catalog'
            },
            status: 'PLANNED',
            actualNutritionItemId: null,
            updatedAt: new Date()
          }
        })
      }

      daySummaries.push({
        date: dateKey,
        fuelingPlan: nutritionData.fuelingPlan,
        targets: nutritionData.targets
      })
    }

    // A sub-range regeneration must not wipe the summary of the untouched days. Each plan
    // keeps only the summaries of days inside its own week.
    for (const weekPlan of plansByWeekStart.values()) {
      const weekStartKey = toDateKey(weekPlan.startDate)
      const weekEndKey = toDateKey(this.getWeekEndUtc(weekPlan.startDate))
      const weekSummaries = daySummaries.filter(
        (entry) => entry.date >= weekStartKey && entry.date <= weekEndKey
      )
      const existingSummaryDays = Array.isArray((weekPlan.summaryJson as any)?.days)
        ? ((weekPlan.summaryJson as any).days as any[])
        : []
      const mergedSummaryDays = [
        ...existingSummaryDays.filter(
          (day: any) => !weekSummaries.some((entry) => entry.date === day.date)
        ),
        ...weekSummaries
      ].sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))

      await prisma.nutritionPlan.update({
        where: { id: weekPlan.id },
        data: {
          status: 'DRAFT',
          endDate: this.getWeekEndUtc(weekPlan.startDate),
          summaryJson: {
            days: mergedSummaryDays,
            generatedAt: new Date().toISOString()
          } as any,
          updatedAt: new Date()
        }
      })
    }

    const firstPlan = await planForDay(days[0] || rangeStart)
    return prisma.nutritionPlan.findFirst({
      where: { id: firstPlan.id },
      include: {
        meals: {
          where: {
            date: { gte: rangeStart, lte: lastDay }
          },
          orderBy: [{ date: 'asc' }, { scheduledAt: 'asc' }]
        }
      }
    })
  },

  inferDailyBaseSlotFromMeal(planMeal: any) {
    const raw = String(planMeal?.windowType || '')
    if (!raw.startsWith('DAILY_BASE:')) return ''
    return raw.split(':')[1] || ''
  },

  buildLoggedItems(nutrition: any, timezone: string, date: Date) {
    const mealTypes = ['breakfast', 'lunch', 'dinner', 'snacks'] as const
    return mealTypes.flatMap((mealType) => {
      const items = Array.isArray(nutrition?.[mealType]) ? nutrition[mealType] : []
      return items.map((item: any) => ({
        ...item,
        mealType,
        at: parseDateTimeInTimezone(item.logged_at || item.date, timezone, date)
      }))
    })
  },

  matchLoggedItemToPlanMeal(
    planMeal: any,
    windows: any[],
    loggedItems: any[],
    usedIds: Set<string>
  ) {
    const relevantWindow = windows.find((window) => this.matchPlanMealToWindow(planMeal, window))
    if (!relevantWindow) return null

    const start = parseDateTimeInTimezone(relevantWindow.startTime, 'UTC')
    const end = parseDateTimeInTimezone(relevantWindow.endTime, 'UTC')
    if (!start || !end) return null

    const dailyBaseSlot = this.inferDailyBaseSlotFromMeal(planMeal)

    return (
      loggedItems.find((item: any) => {
        if (!item?.id || usedIds.has(item.id)) return false
        if (!(item.at instanceof Date) || Number.isNaN(item.at.getTime())) return false
        if (item.at < start || item.at > end) return false

        if (!dailyBaseSlot) return true

        // Logged items come from the plural Nutrition arrays ('snacks') while slot slugs are
        // singular ('snack'), so the raw includes() check never matched a logged snack.
        const normalizedMealType = String(item.mealType || '').toLowerCase()
        const singularMealType = normalizedMealType.replace(/s$/, '')
        if (dailyBaseSlot.includes(normalizedMealType)) return true
        if (singularMealType && dailyBaseSlot.includes(singularMealType)) return true

        const itemName = String(item.name || '')
          .trim()
          .toLowerCase()
        return itemName.startsWith(`[${dailyBaseSlot.replace(/-/g, ' ')}]`)
      }) || null
    )
  },

  async reconcileLoggedMealsForDate(userId: string, date: Date | string, timezone?: string) {
    const dayStartUtc = toDayStartUtc(date)
    const resolvedTimezone = timezone || (await getUserTimezone(userId))

    const [nutrition, plans] = await Promise.all([
      nutritionRepository.getByDate(userId, dayStartUtc),
      prisma.nutritionPlan.findMany({
        where: {
          userId,
          startDate: { lte: dayStartUtc },
          endDate: { gte: dayStartUtc }
        },
        include: {
          meals: {
            where: { date: dayStartUtc },
            orderBy: { scheduledAt: 'asc' }
          }
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
      })
    ])

    const primaryPlan = plans[0]
    if (!nutrition || !primaryPlan) return []

    const daySummary =
      primaryPlan?.summaryJson && Array.isArray((primaryPlan.summaryJson as any)?.days)
        ? (primaryPlan.summaryJson as any).days.find(
            (entry: any) => entry.date === toDateKey(dayStartUtc)
          )
        : null
    const liveWindows = Array.isArray((nutrition.fuelingPlan as any)?.windows)
      ? (nutrition.fuelingPlan as any).windows
      : []
    const windows =
      liveWindows.length > 0
        ? liveWindows
        : Array.isArray(daySummary?.fuelingPlan?.windows)
          ? daySummary.fuelingPlan.windows
          : []
    const loggedItems = this.buildLoggedItems(nutrition, resolvedTimezone, dayStartUtc)
    const usedIds = new Set<string>()
    const updates: any[] = []

    for (const meal of primaryPlan.meals || []) {
      if (String(meal.status || '').toUpperCase() === 'SKIPPED') continue

      const matched = this.matchLoggedItemToPlanMeal(meal, windows, loggedItems, usedIds)
      if (!matched) continue

      usedIds.add(matched.id)
      updates.push(
        prisma.nutritionPlanMeal.update({
          where: { id: meal.id },
          data: {
            status: 'DONE',
            actualNutritionItemId: matched.id,
            mealJson: {
              ...(meal.mealJson as any),
              isLogged: true,
              loggedAt: matched.logged_at || matched.date || null
            },
            updatedAt: new Date()
          }
        })
      )
    }

    if (updates.length === 0) return []

    const results = await Promise.all(updates)
    await this.syncNutritionLocksForDate(userId, dayStartUtc)
    return results
  },

  async updatePlanMealStatus(
    userId: string,
    mealId: string,
    action: PlanMealAction,
    payload?: { meal?: any }
  ) {
    const existing = await prisma.nutritionPlanMeal.findUnique({
      where: { id: mealId },
      include: {
        plan: true
      }
    })

    if (!existing || existing.plan.userId !== userId) {
      throw new Error('Planned meal not found')
    }

    if (action === 'unlock') {
      await prisma.nutritionPlanMeal.delete({
        where: { id: mealId }
      })
      await this.syncNutritionLocksForDate(userId, existing.date)
      return { success: true, action, mealId }
    }

    if (action === 'replace') {
      if (!payload?.meal) throw new Error('Meal is required for replace action')
      return this.lockMeal(userId, existing.date, existing.windowType, payload.meal)
    }

    const nextStatus = action === 'complete' ? 'DONE' : 'SKIPPED'
    const updated = await prisma.nutritionPlanMeal.update({
      where: { id: mealId },
      data: {
        status: nextStatus,
        mealJson: {
          ...(existing.mealJson as any),
          ...(action === 'complete'
            ? { completedAt: new Date().toISOString() }
            : { skippedAt: new Date().toISOString() })
        },
        updatedAt: new Date()
      }
    })

    await this.syncNutritionLocksForDate(userId, existing.date)
    return updated
  },

  async getGroceryList(userId: string, startDate: Date, endDate: Date) {
    const plan = await this.getPlanForRange(userId, startDate, endDate)
    if (!plan) {
      return {
        items: [],
        totals: { ingredients: 0, meals: 0 }
      }
    }

    const eligibleMeals = (plan.meals || []).filter((meal: any) => {
      const status = String(meal.status || '').toUpperCase()
      if (status === 'SKIPPED' || status === 'REPLACED') return false
      return Array.isArray(meal.mealJson?.ingredients) && meal.mealJson.ingredients.length > 0
    })

    const grouped = new Map<string, any>()

    for (const meal of eligibleMeals) {
      for (const ingredient of meal.mealJson.ingredients as any[]) {
        const name = normalizeIngredientName(ingredient?.item || ingredient?.name)
        const unit = String(ingredient?.unit || '').trim()
        if (!name) continue

        const key = `${name.toLowerCase()}|${unit.toLowerCase()}`
        // Ingredients come from AI-generated mealJson, so a quantity of 'two' is possible.
        // `Number(x || 0)` guards null but not that, and a single NaN propagates through every
        // later `+=` for the ingredient - the whole aggregated row renders as NaN.
        const quantity = toFiniteNumber(ingredient?.quantity)
        const existing = grouped.get(key)

        if (!existing) {
          grouped.set(key, {
            ingredient: name,
            quantity,
            unit,
            category: ingredient?.category || null,
            sourceMeals: [
              {
                date: toDateKey(meal.date),
                title: meal.mealJson?.title || 'Meal'
              }
            ]
          })
          continue
        }

        existing.quantity += quantity
        existing.sourceMeals.push({
          date: toDateKey(meal.date),
          title: meal.mealJson?.title || 'Meal'
        })
      }
    }

    const items = Array.from(grouped.values()).sort((a, b) =>
      String(a.ingredient).localeCompare(String(b.ingredient))
    )

    return {
      items,
      totals: {
        ingredients: items.length,
        meals: eligibleMeals.length
      }
    }
  }
}
