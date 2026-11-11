import { requireAuth } from '../../../utils/auth-guard'
import {
  CONCURRENT_UPDATE_CONFLICT,
  nutritionRepository
} from '../../../utils/repositories/nutritionRepository'
import { generateStructuredAnalysis } from '../../../utils/gemini'
import { z } from 'zod/v3'
import { getUserTimezone, buildZonedDateTimeFromUtcDate } from '../../../utils/date'
import { metabolicService } from '../../../utils/services/metabolicService'
import { nutritionPlanService } from '../../../utils/services/nutritionPlanService'
import { getUserNutritionSettings } from '../../../utils/nutrition/settings'
import {
  extractFluidIntakeMl,
  getIntraWorkoutFluidTargetByNowMl,
  MEAL_LINKED_WATER_ML
} from '../../../utils/nutrition/hydration'
import { normalizeFluidFields, recalculateNutritionTotals } from '../../../utils/nutrition/totals'
import { pickMealScheduledTime } from '../../../utils/nutrition/meal-pattern'

const LogSchema = z.object({
  query: z.string(),
  mealType: z.enum(['breakfast', 'lunch', 'dinner', 'snacks']).optional()
})

const FoodItemSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().describe('Clear name of the food item (e.g. "Oatmeal", "Blueberries")'),
      calories: z.number().describe('Estimated calories'),
      protein: z.number().describe('Grams of protein'),
      carbs: z.number().describe('Grams of carbohydrates'),
      fat: z.number().describe('Grams of fat'),
      fiber: z.number().optional().describe('Grams of fiber'),
      sugar: z.number().optional().describe('Grams of sugar'),
      absorptionType: z
        .enum(['RAPID', 'FAST', 'BALANCED', 'DENSE', 'HYPER_LOAD'])
        .optional()
        .describe('How fast the food is absorbed'),
      amount: z.number().optional().describe('Numeric quantity'),
      unit: z.string().optional().describe('Unit of measurement (e.g. "g", "ml", "cup")'),
      quantity: z
        .string()
        .optional()
        .describe('Human readable quantity (e.g. "1 bowl", "a handful")'),
      entryType: z
        .enum(['FOOD', 'HYDRATION'])
        .optional()
        .describe('Use HYDRATION for water/coffee/tea/electrolyte logs that are fluid-first'),
      waterMl: z
        .number()
        .optional()
        .describe('Fluid intake in ml for hydration logs (convert oz/L to ml)'),
      mealType: z
        .enum(['breakfast', 'lunch', 'dinner', 'snacks'])
        .optional()
        .describe('The meal category'),
      logged_at: z
        .string()
        .optional()
        .describe('Time of consumption in HH:mm format (24h) if mentioned')
    })
  )
})

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event, ['nutrition:write'])
  const userId = user.id
  const timezone = await getUserTimezone(userId)
  const settings = await getUserNutritionSettings(userId)
  const id = getRouterParam(event, 'id')
  const body = await readBody(event)
  const { query, mealType } = LogSchema.parse(body)

  let nutrition: any
  let dateStr: string | undefined = /^\d{4}-\d{2}-\d{2}$/.test(id!) ? id! : undefined
  if (dateStr) {
    const dateObj = new Date(`${id}T00:00:00Z`)
    nutrition = await nutritionRepository.getByDate(userId, dateObj)
  } else {
    nutrition = await nutritionRepository.getById(id!, userId)
    if (nutrition) {
      dateStr = nutrition.date.toISOString().split('T')[0]
    }
  }

  if (!nutrition) {
    // If not found, we still need a date to create one later
    if (!dateStr) throw createError({ statusCode: 404, message: 'Nutrition entry not found' })
  }
  if (!dateStr) {
    throw createError({ statusCode: 404, message: 'Nutrition entry not found' })
  }

  // Use AI to parse the query
  const prompt = `
    You are a nutrition expert. Analyze the following food log entry and extract individual food items with their estimated nutritional values.
    
    User Query: "${query}"
    Target Date: ${dateStr}
    Default Meal Type: ${mealType || 'unknown'}

    CRITICAL INSTRUCTIONS:
    1. For each food item, provide a clear 'name'.
    2. Estimate calories, protein, carbs, and fat based on standard nutritional data if not provided.
    3. Use the 'quantity' field for descriptions like "1 bowl" or "a handful".
    4. If the user mentions a specific time (e.g. "at 9:30", "around 10am"), extract it into 'logged_at' in HH:mm format (24h).
    5. If the user doesn't specify a meal type (breakfast, lunch, dinner, snacks), try to infer it from the query context (e.g. "morning" implies breakfast) or the time mentioned.
    6. Assign an 'absorptionType': 
       - 'RAPID' for pure sugar/liquids (gels, juice, honey, sports drink).
       - 'FAST' for simple carbs (white bread, ripe fruit, banana, candy).
       - 'BALANCED' for complex carbs (oats, pasta, rice, potato, bars).
       - 'DENSE' for items high in protein/fat/fiber (meat, nuts, avocado, whole grains).
       - 'HYPER_LOAD' for very large, high-calorie meals (pizza, Thanksgiving dinner, big pasta party).
    7. Detect hydration entries (water, coffee, tea, sports drink, bottles, oz/ml/L) and mark them as entryType='HYDRATION' with waterMl in milliliters.
    8. Keep hydration entries separate from food logs. Only return mealType for FOOD entries.
    9. Return a JSON object with an 'items' array matching the schema.
  `

  const result = await generateStructuredAnalysis<any>(prompt, FoodItemSchema, 'flash', {
    userId,
    operation: 'LOG_NUTRITION_AI'
  })

  const parsedItems = Array.isArray(result.items) ? result.items : []
  const inferredFluidMl = extractFluidIntakeMl(query)
  const hasAiHydrationItem = parsedItems.some((item: any) => item?.entryType === 'HYDRATION')
  if (parsedItems.length === 0 && inferredFluidMl <= 0) {
    return { success: false, message: 'Could not parse any food items from your query.' }
  }

  // Group items by target date
  const itemsByDate: Record<
    string,
    {
      items: any[]
      mealTypes: Set<string>
      hydrationMl: number
      hydrationLoggedAt: string | null
    }
  > = {}

  parsedItems.forEach((item: any) => {
    let targetDateStr = dateStr
    let normalizedLoggedAt = item.logged_at

    // If no time is provided, anchor to configured meal schedule.
    if (!normalizedLoggedAt) {
      const effectiveMealType = (item.mealType || mealType || 'snacks') as
        'breakfast' | 'lunch' | 'dinner' | 'snacks'
      normalizedLoggedAt = pickMealScheduledTime(effectiveMealType, settings.mealPattern)
    }

    if (normalizedLoggedAt.includes('T')) {
      targetDateStr = normalizedLoggedAt.split('T')[0]
    } else if (/^\d{2}:\d{2}/.test(normalizedLoggedAt)) {
      const timeMatch = normalizedLoggedAt.match(/^(\d{2}):(\d{2})/)
      if (timeMatch) {
        const h = parseInt(timeMatch[1]!)
        const m = parseInt(timeMatch[2]!)
        const hh = String(h).padStart(2, '0')
        const mm = String(m).padStart(2, '0')
        const baseDate = new Date(`${targetDateStr}T00:00:00Z`)
        const finalDate = buildZonedDateTimeFromUtcDate(baseDate, `${hh}:${mm}`, timezone)
        normalizedLoggedAt = finalDate.toISOString()
      }
    }

    if (!itemsByDate[targetDateStr]) {
      itemsByDate[targetDateStr] = {
        items: [],
        mealTypes: new Set<string>(),
        hydrationMl: 0,
        hydrationLoggedAt: null
      }
    }

    const isHydrationItem = item.entryType === 'HYDRATION'

    if (isHydrationItem) {
      const hydrationItem = normalizeFluidFields({
        ...item,
        mealType: undefined,
        id: crypto.randomUUID(),
        name: item.name || 'Water',
        water_ml: Math.round(Number(item.waterMl || 0)),
        entryType: 'HYDRATION',
        logged_at: typeof normalizedLoggedAt === 'string' ? normalizedLoggedAt : undefined,
        source: 'ai'
      })
      itemsByDate[targetDateStr]!.items.push(hydrationItem)
      itemsByDate[targetDateStr]!.mealTypes.add('snacks')
      const fluidMl = Math.round(Number(item.waterMl || hydrationItem.water_ml || 0))
      if (fluidMl > 0) {
        itemsByDate[targetDateStr]!.hydrationMl += fluidMl
        if (!itemsByDate[targetDateStr]!.hydrationLoggedAt && normalizedLoggedAt) {
          itemsByDate[targetDateStr]!.hydrationLoggedAt =
            typeof normalizedLoggedAt === 'string' ? normalizedLoggedAt : null
        }
      }
      return
    }

    // Ensure absorptionType is set
    const processedItem = normalizeFluidFields({
      ...item,
      logged_at: normalizedLoggedAt,
      absorptionType: item.absorptionType || 'BALANCED'
    })

    itemsByDate[targetDateStr]!.items.push(processedItem)
    itemsByDate[targetDateStr]!.mealTypes.add(item.mealType || mealType || 'snacks')
  })

  const addedItems: any[] = []
  const hydrationUpdates: any[] = []

  // Avoid double-counting hydration: if the AI already returned a HYDRATION item,
  // don't also add a regex-inferred "Water" item from the raw query.
  if (inferredFluidMl > 0 && !hasAiHydrationItem) {
    if (!itemsByDate[dateStr]) {
      itemsByDate[dateStr] = {
        items: [],
        mealTypes: new Set<string>(),
        hydrationMl: 0,
        hydrationLoggedAt: null
      }
    }

    // Add as a discrete item instead of just a scalar update
    itemsByDate[dateStr]!.items.push(
      normalizeFluidFields({
        id: crypto.randomUUID(),
        name: 'Water',
        water_ml: inferredFluidMl,
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        entryType: 'HYDRATION',
        logged_at: new Date().toISOString(),
        source: 'ai'
      })
    )
    itemsByDate[dateStr]!.mealTypes.add('snacks')
    itemsByDate[dateStr]!.hydrationMl += inferredFluidMl
    itemsByDate[dateStr]!.hydrationLoggedAt = new Date().toISOString()
  }

  // Process each date group
  for (const [targetDateStr, grouped] of Object.entries(itemsByDate)) {
    const targetDate = new Date(`${targetDateStr}T00:00:00Z`)
    const items = grouped.items

    // Get or create record for this date
    let targetNutrition = await nutritionRepository.getByDate(userId, targetDate)

    if (!targetNutrition) {
      const meals: any = { breakfast: [], lunch: [], dinner: [], snacks: [] }
      items.forEach((item: any) => {
        const targetMeal = item.mealType || mealType || 'snacks'
        meals[targetMeal].push({
          ...item,
          id: crypto.randomUUID(),
          source: 'ai'
        })
      })

      // Compute totals from the in-memory meal state up front so the new row
      // is created with correct totals in a single write (no separate
      // follow-up totals write that a concurrent request could race with).
      const totals = recalculateNutritionTotals(meals)

      try {
        targetNutrition = await nutritionRepository.create({
          userId,
          date: targetDate,
          ...meals,
          calories: totals.calories,
          protein: totals.protein,
          carbs: totals.carbs,
          fat: totals.fat,
          fiber: totals.fiber,
          sugar: totals.sugar,
          waterMl: totals.waterMl
        })
      } catch (err: any) {
        // Another request created the row for this date between our read and
        // this create (unique userId+date constraint violation).
        if (err?.code === 'P2002') {
          throw createError({
            statusCode: 409,
            message: `Nutrition entry for ${targetDateStr} was created elsewhere. Please retry.`
          })
        }
        throw err
      }
    } else {
      // Update existing. Merge the meal-array changes and the recalculated
      // totals into a single payload so the whole mutation lands in one
      // atomic, version-checked write instead of a separate meal write
      // followed by a separate totals write.
      const expectedUpdatedAt = targetNutrition.updatedAt
      const updates: any = {}
      items.forEach((item: any) => {
        const targetMeal = item.mealType || mealType || 'snacks'
        if (!updates[targetMeal]) {
          updates[targetMeal] = [
            ...((targetNutrition![targetMeal as keyof typeof targetNutrition] as any[]) || [])
          ]
        }
        updates[targetMeal].push({
          ...item,
          id: crypto.randomUUID(),
          source: 'ai'
        })
      })

      const mergedForTotals = { ...targetNutrition, ...updates }
      const totals = recalculateNutritionTotals(mergedForTotals)

      const result = await nutritionRepository.updateWithVersionCheck(
        targetNutrition.id,
        expectedUpdatedAt,
        {
          ...updates,
          calories: totals.calories,
          protein: totals.protein,
          carbs: totals.carbs,
          fat: totals.fat,
          fiber: totals.fiber,
          sugar: totals.sugar,
          waterMl: totals.waterMl
        }
      )

      if (result === CONCURRENT_UPDATE_CONFLICT) {
        throw createError({
          statusCode: 409,
          message: `Nutrition entry for ${targetDateStr} was updated elsewhere. Please retry.`
        })
      }

      targetNutrition = result
    }

    const addedFluidMl = Math.max(0, Math.round(grouped.hydrationMl))
    if (addedFluidMl > 0) {
      let intraWorkout: any = null
      const loggedAt = grouped.hydrationLoggedAt ? new Date(grouped.hydrationLoggedAt) : new Date()
      const planResult = await metabolicService.calculateFuelingPlanForDate(userId, targetDate, {
        persist: false
      })
      const intraWindow = (planResult.plan as any)?.windows?.find((window: any) => {
        if (window.type !== 'INTRA_WORKOUT') return false
        const start = new Date(window.startTime)
        const end = new Date(window.endTime)
        return loggedAt >= start && loggedAt <= end
      })

      if (intraWindow) {
        const start = new Date(intraWindow.startTime)
        const end = new Date(intraWindow.endTime)
        const elapsedHours = Math.max(
          0,
          Math.min(
            (loggedAt.getTime() - start.getTime()) / 3600000,
            (end.getTime() - start.getTime()) / 3600000
          )
        )
        const targetByNowMl = getIntraWorkoutFluidTargetByNowMl(intraWindow, elapsedHours)
        intraWorkout = {
          type: 'INTRA_WORKOUT',
          targetByNowMl,
          loggedMl: addedFluidMl,
          completionPercent:
            targetByNowMl > 0 ? Math.round((addedFluidMl / targetByNowMl) * 100) : 100
        }
      }

      hydrationUpdates.push({
        date: targetDateStr,
        fluidMl: addedFluidMl,
        inferredFluidMl: grouped.hydrationMl,
        intraWorkout
      })
    }

    // REACTIVE: Trigger fueling plan update for the log date
    try {
      await metabolicService.calculateFuelingPlanForDate(userId, targetDate, { persist: true })
      await nutritionPlanService.reconcileLoggedMealsForDate(userId, targetDate, timezone)
    } catch (err) {
      console.error('[NutritionLog] Failed to trigger regeneration:', err)
    }

    addedItems.push(...items)
  }

  return { success: true, itemsAdded: addedItems, hydration: hydrationUpdates }
})
