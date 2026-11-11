import { prisma } from '../db'
import { generateStructuredAnalysis } from '../gemini'
import { wellnessRepository } from '../repositories/wellnessRepository'
import { getUserAiSettings } from '../ai-user-settings'
import { auditLogRepository } from '../repositories/auditLogRepository'
import { getUserLocalDate, getUserTimezone } from '../date'
import { triggerDailyCheckinIfNeeded } from './checkin-service'
import { checkQuota } from '../quotas/engine'
import { formatPromptTemperature, formatPromptWeight } from '../ai-prompt-format'
import {
  getMoodLabel,
  getStressLabel,
  getFatigueLabel,
  getSorenessLabel,
  getMotivationLabel,
  getHydrationLabel,
  getInjuryLabel,
  normalizeStressScore,
  getCanonicalWellnessStress
} from '../wellness'
import {
  formatWellnessEventsForPrompt,
  getActiveWellnessEventsForDate,
  getWellnessEventOverlaysForUser
} from './wellnessEventService'

// Define the schema for the AI analysis
const wellnessAnalysisSchema = {
  type: 'object',
  properties: {
    executive_summary: {
      type: 'string',
      description: "A concise summary of the athlete's overall wellness state."
    },
    status: {
      type: 'string',
      description: "The readiness status: 'READY', 'CAUTION', or 'REST'.",
      enum: ['READY', 'CAUTION', 'REST']
    },
    sections: {
      type: 'array',
      description: 'Detailed analysis broken down by category.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: "Section title (e.g., 'Sleep Analysis')" },
          content: { type: 'string', description: 'Detailed analysis content.' },
          type: {
            type: 'string',
            description: 'Category of the section.',
            enum: ['SLEEP', 'HRV', 'RECOVERY', 'SUBJECTIVE', 'TRENDS']
          }
        },
        required: ['title', 'content', 'type']
      }
    },
    recommendations: {
      type: 'array',
      description: 'Actionable advice for the athlete.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Recommendation title.' },
          description: { type: 'string', description: 'Detailed recommendation.' },
          type: {
            type: 'string',
            description: 'Type of recommendation.',
            enum: ['TRAINING', 'LIFESTYLE', 'NUTRITION']
          }
        },
        required: ['title', 'description', 'type']
      }
    }
  },
  required: ['executive_summary', 'status', 'sections', 'recommendations']
}

/**
 * Triggers a readiness check (recommend-today-activity) if enabled and not already done.
 * Useful for webhooks (Whoop, Oura, Intervals) to react to new wellness data.
 * NOTE: Auto-triggering of recommendation is currently disabled to save tokens.
 */
export async function triggerReadinessCheckIfNeeded(userId: string) {
  return { triggered: false, reason: 'Auto-triggering of recommendation is disabled' }
}

function getSleepHours(record: { sleepHours: number | null; sleepSecs: number | null }) {
  return record.sleepHours ?? (record.sleepSecs != null ? record.sleepSecs / 3600 : null)
}

export async function analyzeWellness(wellnessId: string, userId: string) {
  // Fetch the wellness record
  const wellness = await prisma.wellness.findUnique({
    where: { id: wellnessId }
  })

  if (!wellness) {
    throw new Error('Wellness record not found')
  }

  try {
    const timezone = await getUserTimezone(userId)
    const today = getUserLocalDate(timezone)
    const canonicalStress = getCanonicalWellnessStress(wellness)
    const sleepHours = getSleepHours(wellness)

    // 1. Skip if future date
    if (wellness.date > today) {
      console.log(
        `[WellnessAnalysis] Skipping analysis for future date ${wellness.date.toISOString()} (today is ${today.toISOString()})`
      )
      await prisma.wellness.update({
        where: { id: wellnessId },
        data: { aiAnalysisStatus: 'NOT_STARTED' }
      })
      return { success: true, skipped: true, reason: 'FUTURE_DATE' }
    }

    // 2. Check for data presence (HRV, RHR, Sleep, or Readiness)
    const hasData =
      wellness.hrv !== null ||
      wellness.restingHr !== null ||
      sleepHours !== null ||
      wellness.recoveryScore !== null ||
      wellness.readiness !== null

    if (!hasData) {
      console.log(
        `[WellnessAnalysis] Skipping analysis for empty record on ${wellness.date.toISOString()}`
      )
      await prisma.wellness.update({
        where: { id: wellnessId },
        data: { aiAnalysisStatus: 'SKIPPED_EMPTY' }
      })
      return { success: true, skipped: true, reason: 'EMPTY_RECORD' }
    }

    // Fetch 30-day history for context
    const endDate = wellness.date
    const startDate = new Date(wellness.date)
    startDate.setDate(startDate.getDate() - 30)

    const eventContextStartDate = new Date(wellness.date)
    eventContextStartDate.setUTCDate(eventContextStartDate.getUTCDate() - 14)

    const [user, aiSettings, wellnessEvents] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { language: true, temperatureUnits: true, weightUnits: true }
      }),
      getUserAiSettings(userId),
      getWellnessEventOverlaysForUser(userId, {
        startDate: eventContextStartDate,
        endDate
      })
    ])

    try {
      await checkQuota(userId, 'wellness_analysis')
    } catch (quotaError: any) {
      if (quotaError.statusCode === 429) {
        console.log(`[WellnessAnalysis] Quota exceeded for user ${userId}`)
        await prisma.wellness.update({
          where: { id: wellnessId },
          data: { aiAnalysisStatus: 'QUOTA_EXCEEDED' }
        })
        return { success: false, reason: 'QUOTA_EXCEEDED' }
      }
      throw quotaError
    }

    const activeWellnessEvents = getActiveWellnessEventsForDate(wellnessEvents, wellness.date)
    const activeWellnessEventsContext =
      activeWellnessEvents.length > 0
        ? activeWellnessEvents
            .map((event) => `${event.label}${event.description ? ` (${event.description})` : ''}`)
            .join(', ')
        : 'None'
    const wellnessEventsContext = formatWellnessEventsForPrompt(
      wellnessEvents,
      timezone,
      'WELLNESS EVENT CONTEXT (Last 14 Days)'
    )

    const history = await wellnessRepository.getForUser(userId, {
      startDate,
      endDate,
      select: {
        date: true,
        hrv: true,
        hrvSdnn: true,
        restingHr: true,
        sleepHours: true,
        sleepSecs: true,
        sleepScore: true,
        recoveryScore: true,
        readiness: true,
        stress: true,
        fatigue: true,
        soreness: true
      },
      orderBy: { date: 'asc' }
    })

    const historySleepHours = history.map(getSleepHours).filter((hours) => hours != null)

    // Format recent history (last 5 days) for trend context
    const recentHistory = history
      .slice(-5)
      .map((h) => {
        const date = h.date.toISOString().split('T')[0]
        const parts = [`- ${date}:`]
        if (h.hrv) parts.push(`HRV(rMSSD):${Math.round(h.hrv)}`)
        if (h.hrvSdnn) parts.push(`HRV(SDNN):${Math.round(h.hrvSdnn)}`)
        if (h.restingHr) parts.push(`RHR:${h.restingHr}`)
        const hours = getSleepHours(h)
        if (hours != null) parts.push(`Sleep:${hours.toFixed(1)}h`)
        if (h.recoveryScore) parts.push(`Rec:${h.recoveryScore}%`)
        if (h.readiness) parts.push(`Ready:${h.readiness}`)
        return parts.join(' ')
      })
      .join('\n')

    // Construct the prompt
    const readinessLabel =
      (wellness.readiness || 0) > 10 ? `${wellness.readiness}%` : `${wellness.readiness}/10`

    // Extract detailed metrics from raw JSON (Whoop/Intervals source)
    const rawData = wellness.rawJson as any

    // 1. Sleep Metrics (Handle root level or nested structure)
    let sleepDetails = ''
    const sleepObj = rawData?.sleep?.score ? rawData.sleep : rawData?.sleep ? rawData.sleep : null

    if (sleepObj?.score) {
      const s = sleepObj.score
      const stages = s.stage_summary
      const toHours = (ms: number) => (ms / (1000 * 60 * 60)).toFixed(1)

      sleepDetails = `
    DETAILED SLEEP METRICS (Whoop):
    - Performance: ${s.sleep_performance_percentage}%
    - Efficiency: ${s.sleep_efficiency_percentage?.toFixed(1)}%
    - Consistency: ${s.sleep_consistency_percentage}%
    - Respiratory Rate: ${s.respiratory_rate?.toFixed(1)} rpm
    - Sleep Needed: ${toHours(s.sleep_needed?.baseline_milli)}h (Strain Demand: ${toHours(s.sleep_needed?.need_from_recent_strain_milli)}h, Sleep Debt: ${toHours(s.sleep_needed?.need_from_sleep_debt_milli)}h)
    - Stages:
      * Deep (SWS): ${toHours(stages.total_slow_wave_sleep_time_milli)}h
      * REM: ${toHours(stages.total_rem_sleep_time_milli)}h
      * Light: ${toHours(stages.total_light_sleep_time_milli)}h
      * Awake: ${toHours(stages.total_awake_time_milli)}h
      * Disturbances: ${stages.disturbance_count}`
    }

    // 2. Advanced Context (eFTP, Skin Temp, Ramp Rate)
    let advancedContext = ''
    if (rawData?.sportInfo?.[0]) {
      const sport = rawData.sportInfo[0]
      if (sport.eftp) advancedContext += `- Estimated FTP (eFTP): ${sport.eftp.toFixed(0)} W\n`
      if (sport.pMax) advancedContext += `- Max Power (pMax): ${sport.pMax.toFixed(0)} W\n`
      if (sport.wPrime)
        advancedContext += `- W' (Anaerobic Capacity): ${sport.wPrime.toFixed(0)} J\n`
    }
    if (rawData?.rampRate !== undefined && rawData?.rampRate !== null) {
      advancedContext += `- Ramp Rate: ${rawData.rampRate.toFixed(1)} (Training Load Trend)\n`
    }
    // Check both recovery.score and nested structure just in case
    const skinTemp = rawData?.recovery?.score?.skin_temp_celsius ?? rawData?.skinTemp
    if (skinTemp) {
      advancedContext += `- Skin Temp: ${formatPromptTemperature(skinTemp, user?.temperatureUnits)}\n`
    }

    const prompt = `

        Analyze this athlete's daily wellness data as an expert **${aiSettings.aiPersona}** coach.

        Adapt your tone and recommendations to match your **${aiSettings.aiPersona}** persona.

        Preferred Language: ${user?.language || 'English'} (CRITICAL: ALL analysis, summaries, and recommendations MUST be written in this language)

    

        CURRENT DAY (${wellness.date.toISOString().split('T')[0]}):

        - Recovery Score: ${wellness.recoveryScore}%

        - Resting HR: ${wellness.restingHr} bpm

        - HRV (rMSSD): ${wellness.hrv ? wellness.hrv + ' ms' : 'N/A'}

        - HRV (SDNN): ${wellness.hrvSdnn ? wellness.hrvSdnn + ' ms' : 'N/A'}

        - Sleep: ${sleepHours} hours (Score: ${wellness.sleepScore})

        - Readiness: ${readinessLabel}

        - Subjective:

          * Stress: ${canonicalStress ? normalizeStressScore(canonicalStress) + '/10' : 'N/A'} (${getStressLabel(canonicalStress)})

          * Fatigue: ${wellness.fatigue ? wellness.fatigue + '/10' : 'N/A'} (${getFatigueLabel(wellness.fatigue)})

                * Soreness: ${wellness.soreness ? wellness.soreness + '/10' : 'N/A'} (${getSorenessLabel(wellness.soreness)})

                * Mood: ${wellness.mood ? wellness.mood + '/10' : 'N/A'} (${getMoodLabel(wellness.mood)})

                * Motivation: ${wellness.motivation ? wellness.motivation + '/10' : 'N/A'} (${getMotivationLabel(wellness.motivation)})

                * Hydration: ${wellness.hydration || 'N/A'} (${getHydrationLabel(wellness.hydration)})

                * Injury: ${wellness.injury || 'None'} (${getInjuryLabel(wellness.injury)})

              - Vitals: SpO2 ${wellness.spO2}%, Weight ${formatPromptWeight(wellness.weight, user?.weightUnits)}

        ${sleepDetails}

        ACTIVE WELLNESS EVENTS TODAY:
        - ${activeWellnessEventsContext}
    
    ADVANCED CONTEXT:
    ${advancedContext}

    ${wellnessEventsContext}
    
    RECENT DAILY HISTORY (Last 5 Days):
    ${recentHistory}

    30-DAY AVERAGES:
    - Average HRV (rMSSD): ${Math.round(history.reduce((acc, curr) => acc + (curr.hrv || 0), 0) / (history.filter((h) => h.hrv).length || 1))} ms
    - Average RHR: ${Math.round(history.reduce((acc, curr) => acc + (curr.restingHr || 0), 0) / (history.filter((h) => h.restingHr).length || 1))} bpm
    - Average Sleep: ${(historySleepHours.reduce((acc, hours) => acc + hours, 0) / (historySleepHours.length || 1)).toFixed(1)} hours

    TASK:
    Provide a comprehensive analysis of the athlete's recovery status and readiness to train.
    1. Evaluate key metrics (HRV, Sleep, Recovery) against the 30-day context AND the recent 5-day trend.
    2. Identify any warning signs (e.g., high fatigue, low HRV trend, sudden drop in readiness).
    3. Provide actionable recommendations for today's training (e.g., push hard, active recovery, rest).
    4. Note any subjective factors (stress, soreness) that might impact performance.
    5. Treat any metric shown as "N/A" as missing data, not a low or high score.
    6. Do not infer, estimate, or invent subjective scores when they are missing. If stress is "N/A", say it was not reported today.
    7. If a wellness event such as sickness, injury, travel, alcohol, or another synced context marker overlaps this date, explicitly connect it to any abnormal HRV, RHR, sleep, or readiness changes instead of treating those changes as random.

    Output JSON format matching the schema.
  `

    // Generate analysis using Gemini
    const analysis = await generateStructuredAnalysis(
      prompt,
      wellnessAnalysisSchema,
      aiSettings.aiModelPreference,
      {
        userId,
        operation: 'wellness_analysis',
        entityType: 'Wellness',
        entityId: wellnessId
      }
    )

    // Save the result
    await prisma.wellness.update({
      where: { id: wellnessId },
      data: {
        aiAnalysisJson: analysis as any, // Cast to any for Prisma JSON compatibility
        aiAnalysisStatus: 'COMPLETED',
        aiAnalyzedAt: new Date()
      }
    })

    // Trigger daily check-in if needed (after wellness analysis so it has context)
    await triggerDailyCheckinIfNeeded(userId)

    return {
      success: true,
      wellnessId,
      analysis
    }
  } catch (error: any) {
    console.error('Wellness analysis failed:', error)

    await prisma.wellness.update({
      where: { id: wellnessId },
      data: { aiAnalysisStatus: 'FAILED' }
    })

    throw error
  }
}
