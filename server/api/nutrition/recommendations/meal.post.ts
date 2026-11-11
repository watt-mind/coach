import { requireAuth } from '../../../utils/auth-guard'
import { dispatchTask } from '../../../utils/task-dispatcher'
import { prisma } from '../../../utils/db'

/** A completed suggestion for the same window and targets is reused for this long. */
const RECOMMENDATION_REUSE_MS = 30 * 60 * 1000

function targetsMatch(contextJson: any, body: any) {
  const requested = contextJson?.requestedTargets
  if (!requested) return false

  const same = (a: unknown, b: unknown) => Number(a || 0) === Number(b || 0)
  return (
    same(requested.carbs, body.targetCarbs) &&
    same(requested.protein, body.targetProtein) &&
    same(requested.kcal, body.targetKcal)
  )
}

const constraintFields = [
  'dietaryProfile',
  'foodAllergies',
  'foodIntolerances',
  'lifestyleExclusions'
] as const

function constraintsMatch(contextJson: any, settings: any) {
  const stored = contextJson?.constraints
  // Missing or malformed snapshots cannot establish that the cached meal is still suitable.
  if (!stored) return false

  // Keep normalization aligned with mealRecommendationService.toUpperStringArray.
  const normalize = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          .map((entry) => entry.trim().toUpperCase())
      : []

  return constraintFields.every((field) => {
    if (
      !Array.isArray(stored[field]) ||
      stored[field].some((entry: unknown) => typeof entry !== 'string')
    ) {
      return false
    }
    const previous = new Set(normalize(stored[field]))
    const current = new Set(normalize(settings?.[field]))
    return previous.size === current.size && [...previous].every((entry) => current.has(entry))
  })
}

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event, ['nutrition:write'])
  const userId = user.id
  const body = await readBody(event)

  if (!body.date) {
    throw createError({ statusCode: 400, message: 'Date is required' })
  }

  const date = new Date(body.date)
  if (Number.isNaN(date.getTime())) {
    throw createError({ statusCode: 400, message: 'Invalid date' })
  }

  const requestedTargets = {
    carbs: Number(body.targetCarbs || 0),
    protein: Number(body.targetProtein || 0),
    kcal: Number(body.targetKcal || 0)
  }

  // Reuse only while targets and current dietary constraints still match.
  // Explicit regeneration (forceLlm) always bypasses the cache.
  if (!body.forceLlm) {
    const recent = await prisma.nutritionRecommendation.findFirst({
      where: {
        userId,
        date,
        scope: 'MEAL',
        windowType: body.windowType ?? null,
        status: 'COMPLETED',
        updatedAt: { gte: new Date(Date.now() - RECOMMENDATION_REUSE_MS) }
      },
      orderBy: { updatedAt: 'desc' }
    })

    const settings = recent
      ? await prisma.userNutritionSettings.findUnique({
          where: { userId },
          select: {
            dietaryProfile: true,
            foodAllergies: true,
            foodIntolerances: true,
            lifestyleExclusions: true
          }
        })
      : null

    if (
      recent &&
      targetsMatch(recent.contextJson, body) &&
      constraintsMatch(recent.contextJson, settings)
    ) {
      return {
        success: true,
        cached: true,
        runId: recent.runId,
        recommendationId: recent.id
      }
    }
  }

  const recommendation = await prisma.nutritionRecommendation.create({
    data: {
      userId,
      date,
      scope: 'MEAL',
      windowType: body.windowType,
      status: 'PROCESSING',
      contextJson: { requestedTargets }
    }
  })

  let handle: { id: string }
  try {
    handle = await dispatchTask(
      'recommend-nutrition-meal',
      {
        userId,
        date: body.date,
        windowType: body.windowType,
        forceLlm: body.forceLlm,
        targetCarbs: body.targetCarbs,
        targetProtein: body.targetProtein,
        targetKcal: body.targetKcal,
        recommendationId: recommendation.id
      },
      {
        concurrencyKey: userId,
        tags: [`user:${userId}`]
      }
    )
  } catch (error) {
    await prisma.nutritionRecommendation.update({
      where: { id: recommendation.id },
      data: {
        status: 'FAILED',
        contextJson: {
          requestedTargets,
          error: 'ENQUEUE_FAILED',
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      }
    })

    throw createError({ statusCode: 500, message: 'Failed to start meal recommendation' })
  }

  await prisma.nutritionRecommendation.update({
    where: { id: recommendation.id },
    data: { runId: handle.id }
  })

  return {
    success: true,
    cached: false,
    runId: handle.id,
    recommendationId: recommendation.id
  }
})
