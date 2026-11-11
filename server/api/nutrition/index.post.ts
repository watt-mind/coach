import { z } from 'zod/v3'
import { requireAuth } from '../../utils/auth-guard'
import {
  CONCURRENT_UPDATE_CONFLICT,
  nutritionRepository
} from '../../utils/repositories/nutritionRepository'
import { metabolicService } from '../../utils/services/metabolicService'
import { nutritionPlanService } from '../../utils/services/nutritionPlanService'
import { getUserNutritionSettings } from '../../utils/nutrition/settings'
import { getUserTimezone } from '../../utils/date'
import { recalculateNutritionTotals } from '../../utils/nutrition/totals'
import { pickMealScheduledTime } from '../../utils/nutrition/meal-pattern'

const foodItemSchema = z.object({
  name: z.string().optional(),
  calories: z.number().optional(),
  carbs: z.number().optional(),
  protein: z.number().optional(),
  fat: z.number().optional(),
  fiber: z.number().optional(),
  sugar: z.number().optional(),
  logged_at: z.string(), // Required: Exact time of consumption (ISO string)
  meal: z.enum(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK', 'OTHER']).optional(),
  absorptionType: z.enum(['RAPID', 'FAST', 'BALANCED', 'DENSE', 'HYPER_LOAD']).optional(),
  quantity: z.string().optional()
})

const nutritionUploadSchema = z.object({
  date: z.string(), // ISO date or YYYY-MM-DD
  items: z.array(foodItemSchema).optional(),
  // Totals can still be provided as overrides
  calories: z.number().int().optional(),
  carbs: z.number().optional(),
  protein: z.number().optional(),
  fat: z.number().optional(),
  waterMl: z.number().int().optional(),
  rawJson: z.any().optional()
})

defineRouteMeta({
  openAPI: {
    tags: ['Nutrition'],
    summary: 'Upload nutrition data',
    description: 'Logs or updates nutrition data using a flat list of items with timestamps.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/NutritionUpload'
          }
        }
      }
    },
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                data: { type: 'object' }
              }
            }
          }
        }
      },
      400: { description: 'Invalid data' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' }
    },
    $global: {
      components: {
        schemas: {
          FoodItem: {
            type: 'object',
            required: ['logged_at'],
            properties: {
              name: {
                type: 'string',
                description: 'Optional item name. Defaults to "Unknown item".'
              },
              calories: { type: 'number' },
              carbs: { type: 'number' },
              protein: { type: 'number' },
              fat: { type: 'number' },
              fiber: { type: 'number' },
              sugar: { type: 'number' },
              logged_at: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp' },
              absorptionType: {
                type: 'string',
                enum: ['RAPID', 'FAST', 'BALANCED', 'DENSE', 'HYPER_LOAD'],
                default: 'BALANCED'
              },
              quantity: { type: 'string' }
            }
          },
          NutritionUpload: {
            type: 'object',
            required: ['date'],
            properties: {
              date: { type: 'string', format: 'date', description: 'YYYY-MM-DD or ISO string' },
              items: { type: 'array', items: { $ref: '#/components/schemas/FoodItem' } },
              calories: { type: 'integer', description: 'Optional override for daily total' },
              carbs: { type: 'number', description: 'Optional override for daily total' },
              protein: { type: 'number', description: 'Optional override for daily total' },
              fat: { type: 'number', description: 'Optional override for daily total' },
              waterMl: { type: 'integer' },
              rawJson: {
                type: 'object',
                description: 'Raw developer data for historical reference'
              }
            }
          }
        }
      }
    }
  }
})

export default defineEventHandler(async (event) => {
  // 1. Check authentication
  const user = await requireAuth(event, ['nutrition:write'])

  // 2. Validate request body
  const body = await readBody(event)
  const result = nutritionUploadSchema.safeParse(body)

  if (!result.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid nutrition data',
      data: result.error.issues
    })
  }

  const { date, items = [], rawJson, ...totals } = result.data
  const userId = user.id

  // 3. Setup date and timezone
  const parsedDate = new Date(date)
  const targetDate = new Date(
    Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate())
  )
  const timezone = await getUserTimezone(userId)
  const settings = await getUserNutritionSettings(userId)

  // 4. Categorize items into DB buckets (breakfast, lunch, dinner, snacks)
  // We use the user's mealPattern to find the closest bucket for each item
  const mealGroups: any = { breakfast: [], lunch: [], dinner: [], snacks: [] }
  const pattern = (settings.mealPattern as Array<{ name: string; time: string }>) || []

  // Helper to map 24h time to minutes for comparison
  const timeToMinutes = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }

  // Define bucket boundaries based on user pattern.
  //
  // Resolved through pickMealScheduledTime rather than by matching the slot name literally: slot
  // names are free text the athlete writes in their own language, so a literal 'breakfast' lookup
  // fell back to a fixed 07:00 for anyone not using the English defaults, and their items were then
  // bucketed against times they never set. The shared helper tries the name, then known aliases,
  // then the slot's position in the pattern.
  const breakfastTime = timeToMinutes(pickMealScheduledTime('breakfast', pattern))
  const lunchTime = timeToMinutes(pickMealScheduledTime('lunch', pattern))
  const dinnerTime = timeToMinutes(pickMealScheduledTime('dinner', pattern))
  const snackTime = timeToMinutes(pickMealScheduledTime('snacks', pattern))

  // Source attribution
  const source = event.context.authType === 'oauth' ? `oauth:${event.context.oauthAppId}` : 'manual'

  for (const item of items) {
    const itemDate = new Date(item.logged_at)
    // Use formatUserTime to get HH and mm in user's timezone
    const localTimeStr = formatUserTime(itemDate, timezone, 'H:m')
    const [localH, localM] = localTimeStr.split(':').map(Number)
    const itemMinutes = (localH || 0) * 60 + (localM || 0)

    // Enrich item with source and ID
    const enrichedItem = {
      ...item,
      name: item.name?.trim() || 'Unknown item',
      id: crypto.randomUUID(),
      source,
      absorptionType: item.absorptionType || 'BALANCED'
    }

    // Assign to bucket based on explicit 'meal' field or proximity to user windows
    let bestBucket = 'snacks'
    if (item.meal) {
      const m = item.meal.toLowerCase()
      if (m === 'breakfast') bestBucket = 'breakfast'
      else if (m === 'lunch') bestBucket = 'lunch'
      else if (m === 'dinner') bestBucket = 'dinner'
      else if (m === 'snack' || m === 'other') bestBucket = 'snacks'
    } else {
      const diffs = [
        { key: 'breakfast', diff: Math.abs(itemMinutes - breakfastTime) },
        { key: 'lunch', diff: Math.abs(itemMinutes - lunchTime) },
        { key: 'dinner', diff: Math.abs(itemMinutes - dinnerTime) },
        { key: 'snacks', diff: Math.abs(itemMinutes - snackTime) }
      ]
      bestBucket = diffs.sort((a, b) => a.diff - b.diff)[0]!.key
    }

    mealGroups[bestBucket].push(enrichedItem)
  }

  // IDs and buckets are fixed above; each retry merges against a fresh committed day.
  let record
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await nutritionRepository.getByDate(userId, targetDate)

    // OAuth / companion clients often POST one item at a time. Append for oauth so
    // incremental quick-logs do not wipe prior same-source items. Session/API-key
    // uploads still replace-by-source within meals that include incoming items.
    // Buckets with no incoming items are left untouched (avoids clearing other meals).
    const mergeMeal = (mealKey: 'breakfast' | 'lunch' | 'dinner' | 'snacks') => {
      const existingItems = ((existing as any)?.[mealKey] as any[]) || []
      const incoming = (mealGroups[mealKey] as any[]) || []
      if (incoming.length === 0) {
        return existingItems
      }
      if (event.context.authType === 'oauth') {
        return [...existingItems, ...incoming]
      }
      const kept = existingItems.filter((item) => item?.source !== source)
      return [...kept, ...incoming]
    }

    const finalMeals: any = {
      breakfast: mergeMeal('breakfast'),
      lunch: mergeMeal('lunch'),
      dinner: mergeMeal('dinner'),
      snacks: mergeMeal('snacks')
    }

    const finalData: any = {
      ...finalMeals,
      rawJson: rawJson || (existing as any)?.rawJson || null,
      waterMl: totals.waterMl ?? (existing as any)?.waterMl ?? 0
    }

    const mergedTotals = recalculateNutritionTotals(finalData)

    // Use overrides if provided, otherwise use recalculated totals from the merged day.
    finalData.calories =
      totals.calories !== undefined ? totals.calories : Math.round(mergedTotals.calories)
    finalData.carbs = totals.carbs !== undefined ? totals.carbs : mergedTotals.carbs
    finalData.protein = totals.protein !== undefined ? totals.protein : mergedTotals.protein
    finalData.fat = totals.fat !== undefined ? totals.fat : mergedTotals.fat
    finalData.fiber = mergedTotals.fiber
    finalData.sugar = mergedTotals.sugar
    if (totals.waterMl === undefined) {
      finalData.waterMl = mergedTotals.waterMl
    }

    const saved = await nutritionRepository.saveWithVersionCheck(
      userId,
      targetDate,
      existing,
      finalData,
      source
    )
    if (saved !== CONCURRENT_UPDATE_CONFLICT) {
      record = saved
      break
    }
  }
  if (!record) {
    throw createError({
      statusCode: 409,
      message: 'This nutrition entry was updated elsewhere. Please retry the upload.'
    })
  }

  // 7. REACTIVE: Recalculate fueling plan
  try {
    await metabolicService.calculateFuelingPlanForDate(userId, targetDate, {
      persist: true
    })
    await nutritionPlanService.reconcileLoggedMealsForDate(userId, targetDate, timezone)
  } catch (err) {
    console.error('[NutritionUpload] Failed to trigger plan regeneration:', err)
  }

  return {
    success: true,
    data: record
  }
})
