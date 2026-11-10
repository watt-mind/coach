import './init'
import { logger, task } from '@trigger.dev/sdk/v3'
import { v4 as uuidv4 } from 'uuid'
import { prisma } from '../server/utils/db'
import { generateStructuredAnalysis, buildWorkoutSummary } from '../server/utils/gemini'
import { getUserTimezone, getStartOfDaysAgoUTC } from '../server/utils/date'
import { getCheckinHistoryContext } from '../server/utils/services/checkin-service'
import { recommendationRepository } from '../server/utils/repositories/recommendationRepository'
import { nutritionRepository } from '../server/utils/repositories/nutritionRepository'
import { getUserAiSettings } from '../server/utils/ai-user-settings'
import { userReportsQueue } from './queues'
import { filterGoalsForContext } from '../server/utils/goal-context'
import { checkQuota } from '../server/utils/quotas/engine'
import { registerTaskHandler } from '../server/utils/task-registry'

interface RecommendationHistoryItem {
  date: string
  title: string
  description: string
  reason: string
}

interface RecommendationsResponse {
  new_recommendations: Array<{
    title: string
    description: string
    priority: 'high' | 'medium' | 'low'
    sourceType: 'nutrition' | 'workout'
    category: string
    metric: string
    period: number
  }>
  updated_recommendations: Array<{
    id: string
    new_title: string
    new_description: string
    new_priority: 'high' | 'medium' | 'low'
    reason_for_update: string
  }>
  completed_recommendation_ids: string[]
  dismissed_recommendation_ids: string[]
}

type GenerateRecommendationsPayload = { userId: string }

export async function runGenerateRecommendations(payload: GenerateRecommendationsPayload) {
  // ... (previous setup code remains the same) ...
  const { userId } = payload

  logger.log('='.repeat(60))
  logger.log('🚀 GENERATING RECOMMENDATIONS')
  logger.log('='.repeat(60))
  logger.log(`User ID: ${userId}`)

  try {
    await checkQuota(userId, 'unified_report_generation')
  } catch (quotaError: any) {
    if (quotaError.statusCode === 429) {
      logger.warn('Recommendation generation quota exceeded', { userId })
      return { success: false, reason: 'QUOTA_EXCEEDED' }
    }
    throw quotaError
  }

  const timezone = await getUserTimezone(userId)
  const aiSettings = await getUserAiSettings(userId)

  logger.log('Using AI settings', {
    model: aiSettings.aiModelPreference,
    persona: aiSettings.aiPersona
  })

  // 1. Fetch User Profile
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      language: true,
      distanceUnits: true,
      goals: {
        where: { status: 'ACTIVE' },
        select: {
          title: true,
          type: true,
          description: true,
          targetValue: true,
          metric: true,
          targetDate: true,
          events: {
            select: {
              title: true,
              date: true,
              distance: true,
              elevation: true,
              priority: true,
              type: true
            }
          }
        }
      }
    }
  })
  const activeGoals = filterGoalsForContext(user?.goals, timezone)

  // 2. Fetch Recent Score Explanations (Trends)
  const trends = await prisma.scoreTrendExplanation.findMany({
    where: {
      userId,
      expiresAt: { gt: new Date() }
    },
    select: {
      type: true,
      metric: true,
      period: true,
      score: true,
      analysisData: true
    }
  })

  // 3. Fetch Recent Daily Analyses
  const startDate = getStartOfDaysAgoUTC(timezone, 7)

  const recentWorkouts = await prisma.workout.findMany({
    where: {
      userId,
      date: { gte: startDate },
      aiAnalysis: { not: null }
    },
    select: {
      date: true,
      title: true,
      type: true,
      durationSec: true,
      tss: true,
      averageWatts: true,
      averageHr: true,
      rpe: true,
      feel: true,
      description: true,
      aiAnalysis: true,
      aiAnalysisJson: true,
      overallScore: true,
      streams: {
        select: {
          hrZoneTimes: true,
          powerZoneTimes: true
        }
      }
    },
    take: 5,
    orderBy: { date: 'desc' }
  })

  const recentNutrition = await nutritionRepository.getForUser(userId, {
    startDate,
    where: {
      aiAnalysis: { not: null }
    },
    select: {
      date: true,
      aiAnalysis: true,
      overallScore: true
    },
    limit: 5
  })

  // 5. Fetch Active Recommendations & Categories
  const activeRecommendations = await recommendationRepository.getActive(userId)

  const existingCategories = [
    ...new Set(activeRecommendations.map((r) => r.category).filter(Boolean))
  ]

  // Format Contexts
  const checkinHistory = await getCheckinHistoryContext(
    userId,
    getStartOfDaysAgoUTC(timezone, 14),
    new Date(),
    timezone
  )

  const checkinsContext = checkinHistory || 'None'

  if (checkinHistory) {
    logger.log('Check-ins Context for Recommendations Prompt', { checkinHistory })
  }

  const goalsContext =
    activeGoals
      .map((g) => {
        let details = `- GOAL: "${g.title}" (${g.type})`
        if (g.description) details += `\n  Context: ${g.description}`
        if (g.targetValue && g.metric) details += `\n  Target: ${g.targetValue} ${g.metric}`
        if (g.targetDate) details += `\n  Target Date: ${g.targetDate.toISOString().split('T')[0]}`

        if (g.events && g.events.length > 0) {
          details += `\n  LINKED EVENTS:`
          g.events.forEach((e) => {
            details += `\n    * ${e.title} (${e.date.toISOString().split('T')[0]}) [Priority: ${e.priority || 'C'}]`
            if (e.distance) details += `, Dist: ${e.distance}km`
            if (e.elevation) details += `, Elev: ${e.elevation}m`
            if (e.type) details += `, Type: ${e.type}`
          })
        }
        return details
      })
      .join('\n') || 'General Fitness / Maintenance (No specific goals active)'

  const existingRecsContext =
    activeRecommendations.length > 0
      ? activeRecommendations
          .map(
            (r) =>
              `- ID: "${r.id}" | [${r.priority}] ${r.title} (Generated: ${r.generatedAt.toISOString().split('T')[0]})\n  Current: ${r.description}\n  Category: ${r.category || 'General'}\n  Context: ${r.sourceType}/${r.metric}`
          )
          .join('\n')
      : 'None'

  // 5. Construct Prompt
  const prompt = `You are a **${aiSettings.aiPersona}** expert endurance sports coach. Synthesize the following data to generate or refine high-impact, actionable recommendations for the athlete.
Adapt your tone and feedback style to fully embody your **${aiSettings.aiPersona}** persona.
Preferred Language: ${user?.language || 'English'} (CRITICAL: ALL analysis, reasoning, and text responses MUST be written in this language)

ATHLETE PROFILE:
- Name: ${user?.name || 'Athlete'}

ACTIVE GOALS & EVENTS:
${goalsContext}

EXISTING ACTIVE RECOMMENDATIONS (Reference these by ID to update):
${existingRecsContext}

EXISTING CATEGORIES (Reuse if fitting, otherwise create new):
${existingCategories.length > 0 ? existingCategories.join(', ') : 'None yet (e.g. Cycling, Running, Recovery, Nutrition, Sleep, Strength)'}

RECENT TRENDS (Score Explanations):
${trends
  .map(
    (t) =>
      `- [${t.type.toUpperCase()} - ${t.metric} (${t.period}d)] Score: ${t.score?.toFixed(1)}/10. Summary: ${(t.analysisData as any).executive_summary}`
  )
  .join('\n')}

RECENT DAILY INSIGHTS (Last 7 Days):
Workouts:
${buildWorkoutSummary(recentWorkouts, undefined, user?.distanceUnits)}

Nutrition:
${recentNutrition.map((n) => `- ${n.date.toISOString().split('T')[0]}: Score: ${n.overallScore}`).join('\n')}

CHECK-IN FEEDBACK (Subjective Context):
${checkinsContext}

INSTRUCTIONS:
1. Review the EXISTING recommendations. Are they still relevant? Do they need to be updated based on new data?
   - **CRITICAL - UPDATE THRESHOLD**: DO NOT update a recommendation just to rephrase it.
   - **RECENT RECOMMENDATIONS**: If a recommendation is less than 3 days old, ONLY update it if there is a **SIGNIFICANT** change in the underlying data (e.g. a sudden drop in HRV, a missed key workout, a new injury flag).
   - If the advice is still valid but the athlete hasn't acted yet, **LEAVE IT ALONE**. Do not generate an update.
   - Only use 'updated_recommendations' if the *meaning* or *action* needs to change significantly.
   - If yes, use the 'updated_recommendations' array. Provide the ID and the new details.
   - If an existing recommendation has been addressed or is no longer relevant (e.g. issue fixed), mark it as **COMPLETED** or **DISMISSED**.
     - Use 'completed_recommendation_ids' for items successfully addressed.
     - Use 'dismissed_recommendation_ids' for items no longer relevant or incorrect.
2. Identify NEW critical areas for improvement based on Trends and Daily Insights.
   - If a new issue is detected, use the 'new_recommendations' array.
3. Formulate specific, actionable advice.
4. Assign priority (high/medium/low).
5. ASSIGN CATEGORY:
   - Assign a concise 'category' to each recommendation (e.g. "Cycling", "Running", "Recovery", "Nutrition", "Sleep", "Strength", "General Wellness").
   - Reuse existing categories if they fit perfectly.
   - Create a new category only if necessary.
   - Keep categories high-level (Sport or Domain).
6. LABEL FORMATTING (CRITICAL):
   - The 'metric' field must be a clean, human-readable label.
   - DO NOT include the source type in the label (e.g. "Run Volume", NOT "workout/Run Volume").
   - DO NOT use slashes or technical prefixes.
   - Examples of GOOD labels: "Weekly Distance", "Protein Intake", "Sleep Duration", "Zone 2 Time".
   - Examples of BAD labels: "workout/volume", "nutrition:protein", "workout / workout/Run Volume".

OUTPUT SCHEMA:
JSON object with 'new_recommendations', 'updated_recommendations', 'completed_recommendation_ids', and 'dismissed_recommendation_ids' arrays.`

  const schema = {
    type: 'object',
    properties: {
      new_recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            sourceType: { type: 'string', enum: ['nutrition', 'workout'] },
            category: { type: 'string' },
            metric: { type: 'string' },
            period: { type: 'number' }
          },
          required: [
            'title',
            'description',
            'priority',
            'sourceType',
            'category',
            'metric',
            'period'
          ]
        }
      },
      updated_recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            new_title: { type: 'string' },
            new_description: { type: 'string' },
            new_priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            reason_for_update: { type: 'string' }
          },
          required: ['id', 'new_title', 'new_description', 'new_priority', 'reason_for_update']
        }
      },
      completed_recommendation_ids: {
        type: 'array',
        items: { type: 'string' }
      },
      dismissed_recommendation_ids: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: [
      'new_recommendations',
      'updated_recommendations',
      'completed_recommendation_ids',
      'dismissed_recommendation_ids'
    ]
  }

  let usageId: string | undefined
  const response = await generateStructuredAnalysis<RecommendationsResponse>(
    prompt,
    schema,
    aiSettings.aiModelPreference,
    {
      userId,
      operation: 'generate_recommendations',
      entityType: 'RecommendationBatch',
      onUsageLogged: (id) => {
        usageId = id
      }
    }
  )

  const {
    new_recommendations,
    updated_recommendations,
    completed_recommendation_ids,
    dismissed_recommendation_ids
  } = response

  // 6. Process New Recommendations
  if (new_recommendations && new_recommendations.length > 0) {
    const recsWithIds = new_recommendations.map((rec) => ({
      id: uuidv4(),
      userId,
      sourceType: rec.sourceType,
      category: rec.category,
      metric: rec.metric,
      period: rec.period,
      title: rec.title,
      description: rec.description,
      priority: rec.priority,
      generatedAt: new Date(),
      llmUsageId: usageId,
      status: 'ACTIVE'
    }))

    await recommendationRepository.createMany(recsWithIds)
    logger.log(`✅ Created ${recsWithIds.length} new recommendations`)
  }

  // 7. Process Updated Recommendations
  if (updated_recommendations && updated_recommendations.length > 0) {
    for (const update of updated_recommendations) {
      const existing = activeRecommendations.find((r) => r.id === update.id)
      if (!existing) continue

      // Create history entry
      const historyItem: RecommendationHistoryItem = {
        date: new Date().toISOString(),
        title: existing.title,
        description: existing.description,
        reason: update.reason_for_update
      }

      // `history` is a Json column carrying TWO different schemas, which is the
      // whole hazard here:
      //
      //  - this path writes an append-only array of RecommendationHistoryItem
      //  - `thresholdDetectionService` writes a single OBJECT
      //    ({ oldValue, newValue, workoutId, sportName, workoutDate }) for
      //    ACTIVE `sourceType: 'workout'` recommendations
      //
      // `recommendationRepository.getActive()` applies no sourceType/metric
      // filter, so those threshold rows reach `existingRecsContext` and the LLM
      // can name their id in `updated_recommendations` — which is exactly how
      // the "not iterable" crash was reached.
      //
      // So a non-array value is NOT corruption to be discarded. Overwriting it
      // with our array would make `athleteMetricsService` read
      // `Number(history?.newValue)` as NaN, `applyThresholdRecommendation`
      // return false, and the athlete's detected FTP/LTHR/MAX_HR/THRESHOLD_PACE
      // never reach their profile — while the recommendation is still marked
      // COMPLETED. That trades a loud crash for silent, irreversible data loss
      // on the very rows that triggered it.
      //
      // Read defensively, and only WRITE `history` when the stored value is
      // something we can legitimately append to.
      const storedHistory = existing.history
      const historyIsAppendable = storedHistory == null || Array.isArray(storedHistory)
      const currentHistory: RecommendationHistoryItem[] = Array.isArray(storedHistory)
        ? (storedHistory as unknown as RecommendationHistoryItem[])
        : []

      if (!historyIsAppendable) {
        logger.warn('Skipping history append: stored history is not an array', {
          recommendationId: update.id,
          storedHistoryType: typeof storedHistory
        })
      }

      await recommendationRepository.update(update.id, userId, {
        title: update.new_title,
        description: update.new_description,
        priority: update.new_priority,
        ...(historyIsAppendable ? { history: [...currentHistory, historyItem] as any } : {}),
        generatedAt: new Date(),
        llmUsageId: usageId
      })
    }
    logger.log(`🔄 Updated ${updated_recommendations.length} existing recommendations`)
  }

  // 8. Process Completed & Dismissed
  const completedIds = completed_recommendation_ids || []
  if (completedIds.length > 0) {
    await recommendationRepository.updateMany(userId, completedIds, {
      status: 'COMPLETED',
      completedAt: new Date()
    })
    logger.log(`✅ Marked ${completedIds.length} as COMPLETED`)
  }

  const dismissedIds = dismissed_recommendation_ids || []
  if (dismissedIds.length > 0) {
    await recommendationRepository.updateMany(userId, dismissedIds, {
      status: 'DISMISSED',
      completedAt: new Date()
    })
    logger.log(`🚫 Marked ${dismissedIds.length} as DISMISSED`)
  }

  // 9. DEDUPLICATION STEP
  logger.log('🕵️ Running Deduplication Check')

  // Fetch fresh active recommendations (including newly created ones)
  const freshActiveRecs = await recommendationRepository.getActive(userId)
  const createdNewRecommendations = (new_recommendations?.length || 0) > 0

  if (freshActiveRecs.length > 1 && createdNewRecommendations) {
    const dedupPrompt = `You are a data cleaner. Review the following list of active recommendations and identify DUPLICATES or CONFLICTING items.

ACTIVE RECOMMENDATIONS:
${freshActiveRecs.map((r) => `- ID: "${r.id}" | ${r.title} (${r.description}) [Category: ${r.category}, Metric: ${r.metric}] ${r.isPinned ? '(PINNED/PROTECTED)' : ''}`).join('\n')}

INSTRUCTIONS:
1. Look for recommendations that give the SAME advice or address the SAME specific issue, even if worded differently.
2. If duplicates are found, select the BEST one to keep (most clear/actionable).
3. **CRITICAL**: If one of the duplicates is PINNED/PROTECTED, you MUST keep it. Never dismiss a pinned item.
4. Mark the other redundant items for dismissal.
5. If two recommendations contradict each other, prefer the pinned one if applicable, otherwise select the more specific or plausible one.

OUTPUT SCHEMA:
JSON object with 'ids_to_dismiss' array (string IDs). If no duplicates or only pinned items, return empty array.`

    const dedupSchema = {
      type: 'object',
      properties: {
        ids_to_dismiss: {
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['ids_to_dismiss']
    }

    const dedupResponse = await generateStructuredAnalysis<{ ids_to_dismiss: string[] }>(
      dedupPrompt,
      dedupSchema,
      aiSettings.aiModelPreference,
      {
        userId,
        operation: 'deduplicate_recommendations',
        entityType: 'RecommendationBatch'
      }
    )

    let { ids_to_dismiss } = dedupResponse

    // Safety: filter out any pinned items from dismissal, just in case AI missed instructions
    const pinnedIds = new Set(freshActiveRecs.filter((r) => r.isPinned).map((r) => r.id))
    ids_to_dismiss = ids_to_dismiss.filter((id) => !pinnedIds.has(id))

    if (ids_to_dismiss && ids_to_dismiss.length > 0) {
      await recommendationRepository.updateMany(userId, ids_to_dismiss, {
        status: 'DISMISSED',
        completedAt: new Date()
      })
      logger.log(`Sweep completed: Dismissed ${ids_to_dismiss.length} redundant recommendations`)
    } else {
      logger.log('✨ No redundant items found (or all kept due to focus)')
    }
  } else {
    logger.log('Skipping deduplication sweep (no new recommendations created this run)')
  }

  return {
    success: true,
    new: new_recommendations?.length || 0,
    updated: updated_recommendations?.length || 0,
    completed: completedIds.length,
    dismissed: dismissedIds.length,
    userId
  }
}

registerTaskHandler('generate-recommendations', runGenerateRecommendations)

export const generateRecommendationsTask = task({
  id: 'generate-recommendations',
  maxDuration: 300,
  queue: userReportsQueue,
  run: runGenerateRecommendations
})
