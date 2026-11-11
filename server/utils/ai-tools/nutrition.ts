import { tool } from 'ai'
import { z } from 'zod/v3'
import { prisma } from '../db'
import { nutritionRepository } from '../repositories/nutritionRepository'
import { plannedWorkoutRepository } from '../repositories/plannedWorkoutRepository'
import {
  getStartOfDayUTC,
  getEndOfDayUTC,
  formatUserDate,
  formatUserTime,
  formatDateUTC,
  getUserLocalDate,
  getStartOfLocalDateUTC,
  getEndOfLocalDateUTC,
  parseDateTimeInTimezone,
  parseCalendarDate,
  buildInvalidCalendarDateResult
} from '../../utils/date'
import { getProfileForItem } from '../nutrition-domain/absorption'
import { getUserNutritionSettings } from '../../utils/nutrition/settings'
import { metabolicService } from '../services/metabolicService'
import { getIntraWorkoutFluidTargetByNowMl } from '../nutrition/hydration'
import { mealRecommendationService } from '../services/mealRecommendationService'
import { nutritionPlanService } from '../services/nutritionPlanService'
import type { AiSettings } from '../ai-user-settings'
import { normalizeFluidFields, recalculateNutritionTotals } from '../nutrition/totals'
import { pickMealScheduledTime, pickSlotScheduledTime } from '../nutrition/meal-pattern'
import {
  nutritionDatabaseService,
  calculatePortionNutrients
} from '../services/nutritionDatabaseService'

const parseToolDateInput = (field: string, value: string, input: Record<string, unknown>) => {
  const parsed = parseCalendarDate(value)
  if (!parsed) {
    return { error: buildInvalidCalendarDateResult(field, value, input) }
  }
  return { date: parsed }
}

const parseOptionalToolDateInput = (
  field: string,
  value: string | undefined,
  input: Record<string, unknown>,
  timezone: string
) => {
  if (!value) {
    return { date: getUserLocalDate(timezone) }
  }

  return parseToolDateInput(field, value, input)
}

const formatMealItems = (items: any, timezone: string) => {
  if (!Array.isArray(items)) return []
  return items.map((item: any) => ({
    ...item,
    logged_at_local: (() => {
      const parsed = parseDateTimeInTimezone(item.logged_at || item.date, timezone)
      return parsed ? formatUserTime(parsed, timezone) : null
    })()
  }))
}

export const nutritionTools = (userId: string, timezone: string, aiSettings: AiSettings) => ({
  get_nutrition_log: tool({
    description:
      'Get nutrition data for specific dates. Use this when the user asks about their eating, meals, macros, or calories. Returns detailed meal logs.',
    inputSchema: z.object({
      start_date: z.string().describe('Start date in ISO format (YYYY-MM-DD)'),
      end_date: z
        .string()
        .optional()
        .describe('End date in ISO format (YYYY-MM-DD). If not provided, defaults to start_date')
    }),
    execute: async ({ start_date, end_date }) => {
      const startParsed = parseToolDateInput('start_date', start_date, { start_date, end_date })
      if ('error' in startParsed) return startParsed.error

      const endParsed = end_date
        ? parseToolDateInput('end_date', end_date, { start_date, end_date })
        : null
      if (endParsed && 'error' in endParsed) return endParsed.error

      const start = startParsed.date
      const end = endParsed?.date || start

      const nutritionEntries = await nutritionRepository.getForUser(userId, {
        startDate: start,
        endDate: end,
        select: {
          id: true,
          date: true,
          calories: true,
          protein: true,
          carbs: true,
          fat: true,
          fiber: true,
          sugar: true,
          waterMl: true,
          breakfast: true,
          lunch: true,
          dinner: true,
          snacks: true,
          aiAnalysis: true
        }
      })

      if (nutritionEntries.length === 0) {
        return { message: 'No nutrition data found for the specified date range' }
      }

      return {
        count: nutritionEntries.length,
        date_range: {
          start: start_date,
          end: end_date || start_date
        },
        entries: nutritionEntries.map((entry) => ({
          id: entry.id,
          date: formatDateUTC(entry.date),
          macros: {
            calories: entry.calories,
            protein: entry.protein ? Math.round(entry.protein) : null,
            carbs: entry.carbs ? Math.round(entry.carbs) : null,
            fat: entry.fat ? Math.round(entry.fat) : null,
            fiber: entry.fiber ? Math.round(entry.fiber) : null,
            sugar: entry.sugar ? Math.round(entry.sugar) : null,
            water_ml: entry.waterMl
          },
          meals: {
            breakfast: formatMealItems(entry.breakfast, timezone),
            lunch: formatMealItems(entry.lunch, timezone),
            dinner: formatMealItems(entry.dinner, timezone),
            snacks: formatMealItems(entry.snacks, timezone)
          },
          ai_analysis: entry.aiAnalysis || null
        })),
        totals: {
          calories: nutritionEntries.reduce((sum, e) => sum + (e.calories || 0), 0),
          protein: nutritionEntries.reduce((sum, e) => sum + (e.protein || 0), 0),
          carbs: nutritionEntries.reduce((sum, e) => sum + (e.carbs || 0), 0),
          fat: nutritionEntries.reduce((sum, e) => sum + (e.fat || 0), 0),
          water_ml: nutritionEntries.reduce((sum, e) => sum + (e.waterMl || 0), 0)
        },
        averages: {
          // Average based only on days where something was actually logged, matching dashboard history
          calories: Math.round(
            nutritionEntries
              .filter((e) => (e.calories || 0) > 0)
              .reduce((sum, e) => sum + (e.calories || 0), 0) /
              (nutritionEntries.filter((e) => (e.calories || 0) > 0).length || 1)
          ),
          protein: Math.round(
            nutritionEntries
              .filter((e) => (e.protein || 0) > 0)
              .reduce((sum, e) => sum + (e.protein || 0), 0) /
              (nutritionEntries.filter((e) => (e.protein || 0) > 0).length || 1)
          ),
          carbs: Math.round(
            nutritionEntries
              .filter((e) => (e.carbs || 0) > 0)
              .reduce((sum, e) => sum + (e.carbs || 0), 0) /
              (nutritionEntries.filter((e) => (e.carbs || 0) > 0).length || 1)
          )
        }
      }
    }
  }),

  log_nutrition_meal: tool({
    description:
      'Log food and drink items to a specific meal (breakfast, lunch, dinner, snacks, or custom slots like "Sport"). Call this when the user says "I ate X", "Add X to my lunch", or when logging beverages consumed with a meal. If the user references a relative day like "yesterday" or "last night", first call `resolve_temporal_reference` and pass its `resolved_date` here. If the user says a meal is the same as a past meal or date (for example, "same as yesterday" or "same as 2026-03-01"), first call `get_nutrition_log` for that historical date and reuse the actual logged meal data instead of estimating from memory. If the portion differs, scale the retrieved calories and macros proportionally to the new amount. For "instant" or "just now" logging, you MUST first call `get_current_time` to get the current time, and pass the local time (HH:mm) as `logged_at`. The AI should estimate macros for the items only when no historical reference or exact nutrition data is available. Water and zero-calorie drinks MUST be logged with 0 calories and 0 macros.',
    inputSchema: z.object({
      date: z.string().describe('Date in ISO format (YYYY-MM-DD)'),
      meal_type: z
        .string()
        .describe(
          'The meal category (breakfast, lunch, dinner, snacks, or any custom slot name defined by the user)'
        ),
      items: z.array(
        z.object({
          name: z.string().describe('Name of the food item'),
          calories: z.number().describe('Calories'),
          protein: z.number().describe('Protein in grams'),
          carbs: z.number().describe('Carbs in grams'),
          fat: z.number().describe('Fat in grams'),
          fiber: z.number().optional().describe('Fiber in grams'),
          sugar: z.number().optional().describe('Sugar in grams'),
          absorption_type: z
            .enum(['RAPID', 'FAST', 'BALANCED', 'DENSE', 'HYPER_LOAD'])
            .optional()
            .describe('How fast the food is absorbed'),
          quantity: z.string().optional().describe('Quantity description (e.g. "1 cup", "100g")'),
          water_ml: z
            .number()
            .optional()
            .describe('Optional fluid volume in ml when item is a drink'),
          logged_at: z
            .string()
            .optional()
            .describe(
              'ISO timestamp or time string (e.g. "08:30") when the item was consumed. For "instant" or "just now" logging, obtain the current time using get_current_time and pass it here in HH:mm format.'
            )
        })
      )
    }),
    execute: async ({ date, meal_type, items }) => {
      const parsedDate = parseToolDateInput('date', date, { date, meal_type, items })
      if ('error' in parsedDate) return parsedDate.error

      const dateUtc = parsedDate.date
      const settings = await getUserNutritionSettings(userId)
      const todayStr = formatDateUTC(getUserLocalDate(timezone), 'yyyy-MM-dd')
      const isToday = date === todayStr

      // Dynamic Mapping: Map custom slots to 'snacks' but preserve intent in item names
      const standardTypes = ['breakfast', 'lunch', 'dinner', 'snacks']
      const targetMealType = standardTypes.includes(meal_type.toLowerCase())
        ? (meal_type.toLowerCase() as 'breakfast' | 'lunch' | 'dinner' | 'snacks')
        : 'snacks'

      const customSlotPrefix = !standardTypes.includes(meal_type.toLowerCase())
        ? `[${meal_type}] `
        : ''

      // Add IDs to items and normalize logged_at
      const itemsWithIds = items.map((item) => {
        let normalizedLoggedAt = item.logged_at

        // If no time is provided:
        // 1. If today, default to current local time (High fidelity)
        // 2. If past/future, anchor to configured meal schedule (Best guess)
        if (!normalizedLoggedAt) {
          if (isToday) {
            normalizedLoggedAt = formatUserTime(new Date(), timezone)
          } else {
            // A custom slot is stored under 'snacks', but its own scheduled time is in the meal
            // pattern - anchoring it to the snack slot instead put the item at the wrong time of
            // day, which the timeline and the metabolic simulation both read.
            normalizedLoggedAt =
              pickSlotScheduledTime(meal_type, settings.mealPattern) ||
              pickMealScheduledTime(targetMealType, settings.mealPattern)
          }
        }

        if (normalizedLoggedAt.includes('T')) {
          // If it's a full ISO string, ensure the date part matches the intended date
          const timePart = normalizedLoggedAt.split('T')[1]
          normalizedLoggedAt = `${date}T${timePart}`
        } else if (/^\d{2}:\d{2}/.test(normalizedLoggedAt)) {
          // If it's HH:mm, convert to full ISO string using user's timezone
          const timeMatch = normalizedLoggedAt.match(/^(\d{2}):(\d{2})/)
          if (timeMatch) {
            const h = parseInt(timeMatch[1]!)
            const m = parseInt(timeMatch[2]!)
            const baseDate = getStartOfLocalDateUTC(timezone, date)
            const finalDate = new Date(baseDate.getTime() + (h * 3600 + m * 60) * 1000)
            normalizedLoggedAt = finalDate.toISOString()
          }
        }

        return normalizeFluidFields({
          id: crypto.randomUUID(),
          ...item,
          name: `${customSlotPrefix}${item.name}`,
          absorptionType: item.absorption_type || 'BALANCED',
          logged_at: normalizedLoggedAt
        })
      })

      // Get existing record or create new
      let nutrition = await nutritionRepository.getByDate(userId, dateUtc)

      if (!nutrition) {
        nutrition = await nutritionRepository.create({
          userId,
          date: dateUtc,
          [targetMealType]: itemsWithIds
        })
      } else {
        // Append items to existing meal
        const currentItems = (nutrition[targetMealType] as any[]) || []
        const updatedItems = [...currentItems, ...itemsWithIds]

        nutrition = await nutritionRepository.update(nutrition.id, {
          [targetMealType]: updatedItems
        })
      }

      // Recalculate daily totals (includes explicit fluid from items)
      const totals = recalculateNutritionTotals(nutrition)

      // Update totals in DB
      const updatedNutrition = await nutritionRepository.update(nutrition.id, {
        calories: totals.calories,
        protein: totals.protein,
        carbs: totals.carbs,
        fat: totals.fat,
        fiber: totals.fiber,
        sugar: totals.sugar,
        waterMl: totals.waterMl
      })

      try {
        await prisma.auditLog.create({
          data: {
            userId,
            action: 'LOG_NUTRITION_MEAL',
            resourceType: 'Nutrition',
            resourceId: updatedNutrition.id,
            metadata: {
              date,
              meal_type,
              itemCount: items.length,
              calories: totals.calories
            }
          }
        })
      } catch (e) {
        console.error('[NutritionTool] Failed to create audit log:', e)
      }

      return {
        message: `Successfully logged ${items.length} item(s) to ${meal_type} for ${date}`,
        totals: {
          calories: updatedNutrition.calories,
          protein: Math.round(updatedNutrition.protein || 0),
          carbs: Math.round(updatedNutrition.carbs || 0),
          fat: Math.round(updatedNutrition.fat || 0)
        },
        current_meal_items: (updatedNutrition as any)[targetMealType]
      }
    }
  }),

  log_hydration_intake: tool({
    description:
      'Log hydration volume in ml/L/oz. Use mode="SET" to overwrite the daily total or mode="ADD" (default) to append. If the user references a relative day like "yesterday" or "last night", first call `resolve_temporal_reference` and pass its `resolved_date` here. DO NOT use this for drinks consumed as part of a meal (e.g. breakfast coffee); use log_nutrition_meal for those instead.',
    inputSchema: z.object({
      date: z.string().describe('Date in ISO format (YYYY-MM-DD)'),
      volume_ml: z.number().describe('Hydration volume in ml'),
      mode: z
        .enum(['ADD', 'SET'])
        .default('ADD')
        .describe('Whether to add to current total or set a new absolute total'),
      logged_at: z
        .string()
        .optional()
        .describe('ISO timestamp or time string (HH:mm) when the fluid was consumed')
    }),
    execute: async ({ date, volume_ml, mode, logged_at }) => {
      const parsedDate = parseToolDateInput('date', date, { date, volume_ml, mode, logged_at })
      if ('error' in parsedDate) return parsedDate.error

      const dateUtc = parsedDate.date
      let normalizedLoggedAt = logged_at

      if (!normalizedLoggedAt) {
        normalizedLoggedAt = formatUserTime(new Date(), timezone)
      }

      if (normalizedLoggedAt.includes('T')) {
        const timePart = normalizedLoggedAt.split('T')[1]
        normalizedLoggedAt = `${date}T${timePart}`
      } else if (/^\d{2}:\d{2}/.test(normalizedLoggedAt)) {
        const timeMatch = normalizedLoggedAt.match(/^(\d{2}):(\d{2})/)
        if (timeMatch) {
          const h = parseInt(timeMatch[1]!)
          const m = parseInt(timeMatch[2]!)
          const baseDate = getStartOfLocalDateUTC(timezone, date)
          const finalDate = new Date(baseDate.getTime() + (h * 3600 + m * 60) * 1000)
          normalizedLoggedAt = finalDate.toISOString()
        }
      }

      const loggedAtDate = new Date(normalizedLoggedAt)

      let nutrition = await nutritionRepository.getByDate(userId, dateUtc)
      if (!nutrition) {
        const hydrationItem = normalizeFluidFields({
          id: crypto.randomUUID(),
          name: 'Water',
          water_ml: Math.max(0, Math.round(volume_ml)),
          calories: 0,
          protein: 0,
          carbs: 0,
          fat: 0,
          entryType: 'HYDRATION',
          logged_at: normalizedLoggedAt,
          source: 'ai'
        })

        nutrition = await nutritionRepository.create({
          userId,
          date: dateUtc,
          waterMl: Math.max(0, Math.round(volume_ml)),
          snacks: [hydrationItem]
        })
      } else {
        if (mode === 'SET') {
          // Clear existing hydration items from all meals
          const meals = ['breakfast', 'lunch', 'dinner', 'snacks'] as const
          const updates: any = {}
          for (const m of meals) {
            const items = (nutrition[m] as any[]) || []
            const filtered = items.filter((i) => i.entryType !== 'HYDRATION')
            if (filtered.length !== items.length) {
              updates[m] = filtered
            }
          }

          const hydrationItem = normalizeFluidFields({
            id: crypto.randomUUID(),
            name: 'Water',
            water_ml: Math.max(0, Math.round(volume_ml)),
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
            entryType: 'HYDRATION',
            logged_at: normalizedLoggedAt,
            source: 'ai'
          })

          updates.snacks = [...(updates.snacks || nutrition.snacks || []), hydrationItem]
          updates.waterMl = Math.max(0, Math.round(volume_ml))

          nutrition = await nutritionRepository.update(nutrition.id, updates)
        } else {
          // ADD mode: just append a new item
          const hydrationItem = normalizeFluidFields({
            id: crypto.randomUUID(),
            name: 'Water',
            water_ml: Math.max(0, Math.round(volume_ml)),
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
            entryType: 'HYDRATION',
            logged_at: normalizedLoggedAt,
            source: 'ai'
          })

          const currentSnacks = (nutrition.snacks as any[]) || []
          nutrition = await nutritionRepository.update(nutrition.id, {
            snacks: [...currentSnacks, hydrationItem],
            waterMl: Math.max(0, (nutrition.waterMl || 0) + Math.round(volume_ml))
          })
        }
      }

      // Re-calculate to be sure
      const totals = recalculateNutritionTotals(nutrition)
      nutrition = await nutritionRepository.update(nutrition.id, {
        waterMl: totals.waterMl
      })

      const dayPlan = await metabolicService.calculateFuelingPlanForDate(userId, dateUtc, {
        persist: false
      })
      const windows = ((dayPlan.plan as any)?.windows || []) as any[]
      const intraWindow = windows.find((window) => {
        if (window.type !== 'INTRA_WORKOUT') return false
        const start = new Date(window.startTime)
        const end = new Date(window.endTime)
        return loggedAtDate >= start && loggedAtDate <= end
      })

      let intraStatus: any = null
      if (intraWindow) {
        const start = new Date(intraWindow.startTime)
        const end = new Date(intraWindow.endTime)
        const elapsedHours = Math.max(
          0,
          Math.min(
            (loggedAtDate.getTime() - start.getTime()) / 3600000,
            (end.getTime() - start.getTime()) / 3600000
          )
        )
        const targetByNowMl = getIntraWorkoutFluidTargetByNowMl(intraWindow, elapsedHours)
        intraStatus = {
          targetByNowMl,
          loggedMl: Math.round(volume_ml),
          completionPercent:
            targetByNowMl > 0 ? Math.round((Math.round(volume_ml) / targetByNowMl) * 100) : 100
        }
      }

      return {
        message:
          mode === 'SET'
            ? `Set total hydration to ${Math.round(volume_ml)}ml for ${date}.`
            : `Logged ${Math.round(volume_ml)}ml hydration for ${date}.`,
        total_water_ml: nutrition.waterMl || 0,
        intra_workout: intraStatus
      }
    }
  }),

  delete_hydration: tool({
    description: 'Delete all hydration logs for a specific date or a specific amount.',
    inputSchema: z.object({
      date: z.string().describe('Date in ISO format (YYYY-MM-DD)'),
      volume_ml: z
        .number()
        .optional()
        .describe(
          'Optional: Specific volume in ml to remove. If omitted, ALL hydration for the day is cleared.'
        )
    }),
    execute: async ({ date, volume_ml }) => {
      const parsedDate = parseToolDateInput('date', date, { date, volume_ml })
      if ('error' in parsedDate) return parsedDate.error

      const dateUtc = parsedDate.date
      let nutrition = await nutritionRepository.getByDate(userId, dateUtc)

      if (!nutrition) {
        return { message: 'No nutrition log found for this date.' }
      }

      const meals = ['breakfast', 'lunch', 'dinner', 'snacks'] as const
      const updates: any = {}
      let removedCount = 0
      let removedVolume = 0

      for (const m of meals) {
        const items = (nutrition[m] as any[]) || []
        let filtered: any[]

        if (volume_ml) {
          // Remove first match of specific volume
          let found = false
          filtered = items.filter((i) => {
            const normalized = normalizeFluidFields(i || {})
            const hydrationMl = normalized.hydrationContributionMl || 0
            if (!found && i.entryType === 'HYDRATION' && Math.abs(hydrationMl - volume_ml) < 1) {
              found = true
              removedCount++
              removedVolume += hydrationMl
              return false
            }
            return true
          })
        } else {
          // Remove all hydration
          filtered = items.filter((i) => {
            if (i.entryType === 'HYDRATION') {
              const normalized = normalizeFluidFields(i || {})
              removedCount++
              removedVolume += normalized.hydrationContributionMl || 0
              return false
            }
            return true
          })
        }

        if (filtered.length !== items.length) {
          updates[m] = filtered
        }
      }

      if (removedCount === 0 && (nutrition.waterMl || 0) > 0 && !volume_ml) {
        // Fallback: if no items but we have a total, just clear the total
        updates.waterMl = 0
        removedCount = 1
        removedVolume = nutrition.waterMl || 0
      }

      if (removedCount === 0) {
        return { message: 'No hydration entries found to delete.' }
      }

      nutrition = await nutritionRepository.update(nutrition.id, updates)
      const totals = recalculateNutritionTotals(nutrition)
      nutrition = await nutritionRepository.update(nutrition.id, {
        waterMl: totals.waterMl
      })

      return {
        message: volume_ml
          ? `Removed ${Math.round(removedVolume)}ml hydration entry.`
          : `Cleared all hydration for ${date}.`,
        total_water_ml: nutrition.waterMl
      }
    }
  }),

  delete_nutrition_item: tool({
    description:
      'Delete a specific food item from a meal or clear an entire meal. Use when user says "Remove the apple", "Delete item ID xyz", or "Clear breakfast".',
    inputSchema: z.object({
      date: z.string().describe('Date in ISO format (YYYY-MM-DD)'),
      meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snacks']).describe('The meal category'),
      item_name: z
        .string()
        .optional()
        .describe('Name of the item to remove. Matching is case-insensitive.'),
      item_id: z
        .string()
        .optional()
        .describe('Unique ID of the item to remove. Use this when you have the ID.')
    }),
    needsApproval: async () => aiSettings.aiRequireToolApproval,
    execute: async ({ date, meal_type, item_name, item_id }) => {
      const parsedDate = parseToolDateInput('date', date, {
        date,
        meal_type,
        item_name,
        item_id
      })
      if ('error' in parsedDate) return parsedDate.error

      const dateUtc = parsedDate.date

      let nutrition = await nutritionRepository.getByDate(userId, dateUtc)

      if (!nutrition) {
        return { message: 'No nutrition log found for this date.' }
      }

      const currentItems = (nutrition[meal_type] as any[]) || []
      let updatedItems: any[]
      let message: string

      if (item_id) {
        // Remove by ID
        const initialLength = currentItems.length
        updatedItems = currentItems.filter((item: any) => item.id !== item_id)
        if (initialLength === updatedItems.length) {
          return { message: `Could not find item with ID "${item_id}" in ${meal_type}.` }
        }
        message = `Removed item with ID "${item_id}" from ${meal_type}.`
      } else if (item_name) {
        // Remove specific item (filter out matches)
        const initialLength = currentItems.length
        updatedItems = currentItems.filter(
          (item: any) => item.name.toLowerCase() !== item_name.toLowerCase()
        )
        const removedCount = initialLength - updatedItems.length
        if (removedCount === 0) {
          return {
            message: `Could not find item "${item_name}" in ${meal_type}. Found: ${currentItems.map((i) => i.name).join(', ')}`
          }
        }
        message = `Removed "${item_name}" from ${meal_type}.`
      } else {
        // Clear entire meal
        updatedItems = []
        message = `Cleared all items from ${meal_type}.`
      }

      // Update meal items
      nutrition = await nutritionRepository.update(nutrition.id, {
        [meal_type]: updatedItems
      })

      // Recalculate totals (now includes waterMl)
      const totals = recalculateNutritionTotals(nutrition)

      // Update totals in DB
      const updatedNutrition = await nutritionRepository.update(nutrition.id, {
        calories: totals.calories,
        protein: totals.protein,
        carbs: totals.carbs,
        fat: totals.fat,
        fiber: totals.fiber,
        sugar: totals.sugar,
        waterMl: totals.waterMl
      })

      try {
        await prisma.auditLog.create({
          data: {
            userId,
            action: 'DELETE_NUTRITION_ITEM',
            resourceType: 'Nutrition',
            resourceId: updatedNutrition.id,
            metadata: {
              date,
              meal_type,
              item_name,
              item_id,
              calories: totals.calories
            }
          }
        })
      } catch (e) {
        console.error('[NutritionTool] Failed to create audit log:', e)
      }

      return {
        message,
        totals: {
          calories: updatedNutrition.calories,
          protein: Math.round(updatedNutrition.protein || 0),
          carbs: Math.round(updatedNutrition.carbs || 0),
          fat: Math.round(updatedNutrition.fat || 0),
          water_ml: updatedNutrition.waterMl
        },
        remaining_items: updatedItems
      }
    }
  }),

  patch_nutrition_items: tool({
    description:
      'Update specific properties (name, quantity, amount/unit, calories, macros, hydration, or time) of one or more existing food items. Use this for corrections instead of deleting and re-logging. You MUST provide the item_id for each update.',
    inputSchema: z.object({
      date: z.string().describe('Date in ISO format (YYYY-MM-DD)'),
      meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snacks']).describe('The meal category'),
      updates: z.array(
        z.object({
          item_id: z.string().describe('The unique ID of the item to update'),
          name: z.string().optional(),
          quantity: z
            .string()
            .optional()
            .describe('Updated quantity text such as "150g" or "2 cups"'),
          amount: z.number().optional().describe('Updated numeric amount such as 150'),
          unit: z.string().optional().describe('Updated unit such as "g", "ml", or "cup"'),
          calories: z.number().optional(),
          protein: z.number().optional(),
          carbs: z.number().optional(),
          fat: z.number().optional(),
          fiber: z.number().optional(),
          sugar: z.number().optional(),
          water_ml: z.number().optional().describe('Updated fluid volume in ml for drinks'),
          logged_at: z
            .string()
            .optional()
            .describe('New timestamp or time string (HH:mm) for the item')
        })
      )
    }),
    needsApproval: async () => aiSettings.aiRequireToolApproval,
    execute: async ({ date, meal_type, updates }) => {
      const parsedDate = parseToolDateInput('date', date, { date, meal_type, updates })
      if ('error' in parsedDate) return parsedDate.error

      const dateUtc = parsedDate.date
      let nutrition = await nutritionRepository.getByDate(userId, dateUtc)

      if (!nutrition) {
        return { message: 'No nutrition log found for this date.' }
      }

      const currentItems = (nutrition[meal_type] as any[]) || []
      const updatedItems = [...currentItems]
      let updatedCount = 0

      for (const update of updates) {
        const index = updatedItems.findIndex((i) => i.id === update.item_id)
        if (index === -1) continue

        const item = updatedItems[index]
        let normalizedLoggedAt = update.logged_at || item.logged_at

        if (normalizedLoggedAt && normalizedLoggedAt.includes('T')) {
          const timePart = normalizedLoggedAt.split('T')[1]
          normalizedLoggedAt = `${date}T${timePart}`
        } else if (normalizedLoggedAt && /^\d{2}:\d{2}/.test(normalizedLoggedAt)) {
          const timeMatch = normalizedLoggedAt.match(/^(\d{2}):(\d{2})/)
          if (timeMatch) {
            const h = parseInt(timeMatch[1]!)
            const m = parseInt(timeMatch[2]!)
            const baseDate = getStartOfLocalDateUTC(timezone, date)
            const finalDate = new Date(baseDate.getTime() + (h * 3600 + m * 60) * 1000)
            normalizedLoggedAt = finalDate.toISOString()
          }
        }

        updatedItems[index] = normalizeFluidFields({
          ...item,
          name: update.name || item.name,
          quantity: update.quantity !== undefined ? update.quantity : item.quantity,
          amount: update.amount !== undefined ? update.amount : item.amount,
          unit: update.unit !== undefined ? update.unit : item.unit,
          calories: update.calories !== undefined ? update.calories : item.calories,
          protein: update.protein !== undefined ? update.protein : item.protein,
          carbs: update.carbs !== undefined ? update.carbs : item.carbs,
          fat: update.fat !== undefined ? update.fat : item.fat,
          fiber: update.fiber !== undefined ? update.fiber : item.fiber,
          sugar: update.sugar !== undefined ? update.sugar : item.sugar,
          water_ml: update.water_ml !== undefined ? update.water_ml : item.water_ml,
          logged_at: normalizedLoggedAt
        })
        updatedCount++
      }

      if (updatedCount === 0) {
        return { message: 'No matching items found to update.' }
      }

      // Update DB
      nutrition = await nutritionRepository.update(nutrition.id, {
        [meal_type]: updatedItems
      })

      // Recalculate daily totals
      const totals = recalculateNutritionTotals(nutrition)

      const updatedNutrition = await nutritionRepository.update(nutrition.id, {
        calories: totals.calories,
        protein: totals.protein,
        carbs: totals.carbs,
        fat: totals.fat,
        fiber: totals.fiber,
        sugar: totals.sugar,
        waterMl: totals.waterMl
      })

      try {
        await prisma.auditLog.create({
          data: {
            userId,
            action: 'UPDATE_NUTRITION_ITEMS',
            resourceType: 'Nutrition',
            resourceId: updatedNutrition.id,
            metadata: {
              date,
              meal_type,
              updatedCount
            }
          }
        })
      } catch (e) {
        console.error('[NutritionTool] Failed to create audit log:', e)
      }

      return {
        message: `Successfully updated ${updatedCount} item(s) in ${meal_type}.`,
        totals: {
          calories: updatedNutrition.calories,
          protein: Math.round(updatedNutrition.protein || 0),
          carbs: Math.round(updatedNutrition.carbs || 0),
          fat: Math.round(updatedNutrition.fat || 0),
          water_ml: updatedNutrition.waterMl
        }
      }
    }
  }),

  get_fueling_recommendations: tool({
    description: 'Get the calculated fueling plan for a specific date.',
    inputSchema: z.object({
      date: z.string().optional().describe('Date in ISO format (YYYY-MM-DD). Defaults to today.')
    }),
    execute: async ({ date }) => {
      const parsedDate = parseOptionalToolDateInput('date', date, { date }, timezone)
      if ('error' in parsedDate) return parsedDate.error

      const dateUtc = parsedDate.date

      const nutrition = await nutritionRepository.getByDate(userId, dateUtc)

      if (!nutrition || !nutrition.fuelingPlan) {
        // Fallback: Check for planned workout to see if we *should* have one
        const workout = await plannedWorkoutRepository
          .list(userId, {
            startDate: dateUtc,
            endDate: dateUtc,
            limit: 1
          })
          .then((list) => list[0])

        if (workout) {
          return {
            status: 'PENDING_GENERATION',
            message:
              "A planned workout exists but the fueling plan hasn't been generated yet. It should be available shortly."
          }
        }

        return {
          status: 'NO_PLAN',
          message:
            'No structured fueling plan found. Ensures the user has a planned workout for this date.'
        }
      }

      return {
        status: 'FOUND',
        plan: {
          ...(nutrition.fuelingPlan as Record<string, any>),
          windows: Array.isArray((nutrition.fuelingPlan as any)?.windows)
            ? (nutrition.fuelingPlan as any).windows.map((window: any) => {
                const start = parseDateTimeInTimezone(window.startTime, timezone)
                const end = parseDateTimeInTimezone(window.endTime, timezone)

                return {
                  ...window,
                  startTime: start ? formatUserTime(start, timezone) : window.startTime,
                  endTime: end ? formatUserTime(end, timezone) : window.endTime,
                  startDate: start ? formatUserDate(start, timezone) : undefined,
                  endDate: end ? formatUserDate(end, timezone) : undefined,
                  startTimeUtc: window.startTime,
                  endTimeUtc: window.endTime
                }
              })
            : []
        },
        daily_targets: {
          calories: nutrition.caloriesGoal,
          carbs: nutrition.carbsGoal,
          protein: nutrition.proteinGoal,
          fat: nutrition.fatGoal
        }
      }
    }
  }),

  get_metabolic_strategy: tool({
    description:
      'Analyze the users metabolic strategy for the next 7 days, including fueling states (Performance, Steady, Eco), hydration debt, and key fueling challenges. Use this when the user asks about their upcoming week, how to prepare for a big race, or why they feel fatigued.',
    inputSchema: z.object({
      days_ahead: z.number().default(7).describe('Number of days to analyze (default 7, max 14)')
    }),
    execute: async ({ days_ahead }) => {
      const days = Math.min(14, Math.max(1, days_ahead))
      const today = getUserLocalDate(timezone)
      const settings = await getUserNutritionSettings(userId)
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { weight: true, ftp: true }
      })
      const weight = user?.weight || 75

      const strategy = []
      for (let i = 0; i < days; i++) {
        const date = new Date(today)
        date.setUTCDate(today.getUTCDate() + i)

        const dayPlan = await metabolicService.calculateFuelingPlanForDate(userId, date, {
          persist: false
        })
        const plan = dayPlan.plan as any
        const totals = plan.dailyTotals

        let state = 1
        if (totals.carbs / weight >= settings.fuelState3Min) state = 3
        else if (totals.carbs / weight >= settings.fuelState2Min) state = 2

        strategy.push({
          date: formatDateUTC(date),
          state: state === 3 ? 'Performance' : state === 2 ? 'Steady' : 'Eco',
          carbsTarget: Math.round(totals.carbs),
          isRest: !plan.windows.some((w: any) => w.type !== 'DAILY_BASE'),
          notes: plan.notes
        })
      }

      // Calculate persistent hydration debt
      const startDate = new Date(today)
      startDate.setUTCDate(today.getUTCDate() - 3)
      const { points } = await metabolicService.getWaveRange(userId, startDate, today)
      const lastPoint = points[points.length - 1]
      const hydrationDebt = lastPoint ? Math.max(0, lastPoint.fluidDeficit) : 0

      return {
        strategy,
        hydration_debt_ml: Math.round(hydrationDebt),
        user_weight_kg: weight,
        current_date: formatDateUTC(today),
        settings: {
          carb_max: settings.currentCarbMax,
          sweat_rate: settings.sweatRate
        }
      }
    }
  }),

  get_daily_fueling_status: tool({
    description:
      'Get detailed fueling status (fuel tank level, energy timeline metrics) for a specific date. Use this to answer questions like "How is my fueling today?", "Will I function well for my workout?", or "Do I have enough energy?".',
    inputSchema: z.object({
      date: z.string().optional().describe('Date in ISO format (YYYY-MM-DD). Defaults to today.')
    }),
    execute: async ({ date }) => {
      const parsedDate = parseOptionalToolDateInput('date', date, { date }, timezone)
      if ('error' in parsedDate) return parsedDate.error

      const dateUtc = parsedDate.date

      // Logic expects a Date object for 'currentTime' to calculate tank level "right now" vs end of day
      const queryDateStr = formatDateUTC(dateUtc, 'yyyy-MM-dd')
      const todayStr = formatDateUTC(getUserLocalDate(timezone), 'yyyy-MM-dd')
      const isToday = queryDateStr === todayStr

      // If today, use actual current time. If past/future, use 23:59:59 of that day.
      const now = new Date()
      let simTime = now
      if (!isToday) {
        simTime = getEndOfDayUTC(timezone, dateUtc)
      }

      // Use canonical chain + timeline path to keep AI tool output aligned with UI/API.
      const metabolicState = await metabolicService.getMetabolicStateForDate(userId, dateUtc)
      const timelineResult = await metabolicService.getDailyTimeline(
        userId,
        dateUtc,
        metabolicState.startingGlycogen,
        metabolicState.startingFluid,
        simTime
      )
      const glycogenState = timelineResult.liveStatus
      const energyTimeline = timelineResult.points
      const nutrition = timelineResult.dayNutrition

      // 4. Summarize
      const minLevel =
        energyTimeline.length > 0 ? Math.min(...energyTimeline.map((p) => p.level)) : 0
      const minPoint = energyTimeline.find((p) => p.level === minLevel)

      // Identify periods below 30% (Zone 3 / Red)
      const criticalPeriods = energyTimeline.filter((p) => p.level < 30)
      const criticalTimeRange =
        criticalPeriods.length > 0
          ? `${criticalPeriods[0]!.time} - ${criticalPeriods[criticalPeriods.length - 1]!.time}`
          : 'None'

      const workoutsOnDay = new Set(
        energyTimeline
          .filter((p) => p.eventType === 'workout' && p.event)
          .map((p) => p.event as string)
      ).size

      return {
        date: queryDateStr,
        is_today: isToday,
        fuel_tank: {
          level: glycogenState.percentage,
          status:
            glycogenState.state === 1
              ? 'Optimal'
              : glycogenState.state === 2
                ? 'Moderate'
                : 'Critical',
          advice: glycogenState.advice,
          breakdown: {
            baseline: glycogenState.breakdown.midnightBaseline,
            replenished: glycogenState.breakdown.replenishment.value,
            depleted_by_exercise: glycogenState.breakdown.depletion.reduce(
              (acc, curr) => acc + curr.value,
              0
            )
          }
        },
        energy_timeline: {
          minimum_level: minLevel,
          minimum_time: minPoint?.time,
          critical_drop_periods: criticalTimeRange,
          summary: `Energy drops to a minimum of ${minLevel}% at ${minPoint?.time}.`
        },
        nutrition_summary: {
          calories: {
            logged: Math.round(nutrition?.calories || 0),
            target: Math.round(nutrition?.caloriesGoal || 0)
          },
          carbs: {
            logged: Math.round(nutrition?.carbs || 0),
            target: Math.round(nutrition?.carbsGoal || 0)
          }
        },
        workouts_on_day: workoutsOnDay
      }
    }
  }),

  get_meal_recommendations: tool({
    description:
      'Get tailored meal recommendations for a specific window (PRE_WORKOUT, POST_WORKOUT, etc.) based on metabolic needs. Returns multiple options from the catalog or AI-generated.',
    inputSchema: z.object({
      date: z.string().describe('Date in ISO format (YYYY-MM-DD)'),
      window_type: z
        .enum(['PRE_WORKOUT', 'INTRA_WORKOUT', 'POST_WORKOUT', 'DAILY_BASE'])
        .optional()
        .describe('Specific window type to get recommendations for')
    }),
    execute: async ({ date, window_type }) => {
      const parsedDate = parseToolDateInput('date', date, { date, window_type })
      if ('error' in parsedDate) return parsedDate.error

      const targetDate = new Date(parsedDate.date)
      targetDate.setUTCHours(12, 0, 0, 0)
      const result = await mealRecommendationService.getRecommendations(userId, targetDate, {
        scope: 'MEAL',
        windowType: window_type
      })
      return result
    }
  }),

  lock_meal_to_plan: tool({
    needsApproval: async () => aiSettings.aiRequireToolApproval,
    description:
      "Lock a specific meal option into the user's nutrition plan for a metabolic window.",
    inputSchema: z.object({
      date: z.string().describe('Date in ISO format (YYYY-MM-DD)'),
      window_type: z.string().describe('The window type (e.g. PRE_WORKOUT)'),
      meal: z.any().describe('The meal object to lock (from get_meal_recommendations)')
    }),
    execute: async ({ date, window_type, meal }) => {
      const parsedDate = parseToolDateInput('date', date, { date, window_type, meal })
      if ('error' in parsedDate) return parsedDate.error

      const targetDate = new Date(parsedDate.date)
      targetDate.setUTCHours(12, 0, 0, 0)

      const result = await nutritionPlanService.lockMeal(userId, targetDate, window_type, meal)
      return { success: true, planMeal: result }
    }
  }),

  create_nutrition_plan: tool({
    description:
      'Generate or refresh the nutrition plan for a date range using catalog-first planned meals.',
    inputSchema: z.object({
      start_date: z.string().describe('Start date in ISO format (YYYY-MM-DD)'),
      end_date: z.string().describe('End date in ISO format (YYYY-MM-DD)')
    }),
    execute: async ({ start_date, end_date }) => {
      const startParsed = parseToolDateInput('start_date', start_date, { start_date, end_date })
      if ('error' in startParsed) return startParsed.error
      const endParsed = parseToolDateInput('end_date', end_date, { start_date, end_date })
      if ('error' in endParsed) return endParsed.error

      const result = await nutritionPlanService.generateDraftPlan(
        userId,
        startParsed.date,
        endParsed.date
      )
      return { success: true, plan: result }
    }
  }),

  show_nutrition_plan: tool({
    description:
      'Show the nutrition plan and selected meals for a date range, including target-only gaps.',
    inputSchema: z.object({
      start_date: z.string().describe('Start date in ISO format (YYYY-MM-DD)'),
      end_date: z.string().describe('End date in ISO format (YYYY-MM-DD)')
    }),
    execute: async ({ start_date, end_date }) => {
      const startParsed = parseToolDateInput('start_date', start_date, { start_date, end_date })
      if ('error' in startParsed) return startParsed.error
      const endParsed = parseToolDateInput('end_date', end_date, { start_date, end_date })
      if ('error' in endParsed) return endParsed.error

      const plan = await nutritionPlanService.getPlanForRange(
        userId,
        startParsed.date,
        endParsed.date
      )
      return { success: true, plan }
    }
  }),

  swap_planned_meal: tool({
    description:
      'Replace an existing planned meal with a new meal object while keeping the same window.',
    inputSchema: z.object({
      meal_id: z.string().describe('The NutritionPlanMeal id to replace'),
      meal: z.any().describe('The replacement meal object')
    }),
    execute: async ({ meal_id, meal }) => {
      const result = await nutritionPlanService.updatePlanMealStatus(userId, meal_id, 'replace', {
        meal
      })
      return { success: true, result }
    }
  }),

  complete_planned_meal: tool({
    description:
      'Mark a planned meal as done, skipped, or unlocked when the plan needs explicit execution state updates.',
    inputSchema: z.object({
      meal_id: z.string().describe('The NutritionPlanMeal id to update'),
      action: z.enum(['complete', 'skip', 'unlock']).describe('The state transition to apply')
    }),
    execute: async ({ meal_id, action }) => {
      const result = await nutritionPlanService.updatePlanMealStatus(userId, meal_id, action)
      return { success: true, result }
    }
  }),

  export_grocery_list: tool({
    description:
      'Return an aggregated grocery list from planned meals for the selected date range.',
    inputSchema: z.object({
      start_date: z.string().describe('Start date in ISO format (YYYY-MM-DD)'),
      end_date: z.string().describe('End date in ISO format (YYYY-MM-DD)')
    }),
    execute: async ({ start_date, end_date }) => {
      const startParsed = parseToolDateInput('start_date', start_date, { start_date, end_date })
      if ('error' in startParsed) return startParsed.error
      const endParsed = parseToolDateInput('end_date', end_date, { start_date, end_date })
      if ('error' in endParsed) return endParsed.error

      const grocery = await nutritionPlanService.getGroceryList(
        userId,
        startParsed.date,
        endParsed.date
      )
      return { success: true, grocery }
    }
  }),

  search_food_database: tool({
    description:
      'Search the branded and generic food database by keyword for nutritional values (per 100g and for default/custom portion sizes). Use this when looking up specific foods, ingredients, or brand items.',
    inputSchema: z.object({
      query: z.string().describe('Search query keyword (e.g., "Oats", "Nutella", "Greek Yogurt")'),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum number of items to return (default 10)'),
      serving_g: z
        .number()
        .optional()
        .describe('Optional portion size in grams to calculate exact macro totals')
    }),
    execute: async ({ query, limit, serving_g }) => {
      const items = await nutritionDatabaseService.searchFoodDatabase(query, limit)

      const processedItems = items.map((item) => {
        const portionGram = serving_g || item.serving_size_g || 100
        const calculated = calculatePortionNutrients(item, portionGram)

        return {
          name: item.name,
          brand: item.brand,
          barcode: item.barcode,
          categories: item.categories,
          serving_description: item.serving_description || `${portionGram}g`,
          nutrients_per_100g: item.nutrients_per_100g,
          calculated_portion: calculated,
          external_key: item.external_key
        }
      })

      return {
        success: true,
        query,
        count: processedItems.length,
        items: processedItems
      }
    }
  }),

  lookup_food_barcode: tool({
    description:
      'Look up a food product by UPC/EAN barcode to get exact nutritional content, serving sizes, and calculated portion values.',
    inputSchema: z.object({
      barcode: z.string().describe('UPC/EAN barcode digits'),
      serving_g: z
        .number()
        .optional()
        .describe('Optional portion size in grams to calculate exact macro totals')
    }),
    execute: async ({ barcode, serving_g }) => {
      const item = await nutritionDatabaseService.lookupFoodBarcode(barcode)

      if (!item) {
        return {
          success: false,
          error: `No food item found for barcode "${barcode}"`
        }
      }

      const portionGram = serving_g || item.serving_size_g || 100
      const calculated = calculatePortionNutrients(item, portionGram)

      return {
        success: true,
        item: {
          name: item.name,
          brand: item.brand,
          barcode: item.barcode,
          categories: item.categories,
          serving_description: item.serving_description || `${portionGram}g`,
          nutrients_per_100g: item.nutrients_per_100g,
          calculated_portion: calculated,
          ingredients_text: item.ingredients_text,
          external_key: item.external_key
        }
      }
    }
  })
})
