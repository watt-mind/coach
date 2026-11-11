/**
 * Shared workout-analysis payload/prompt builders.
 *
 * This module is the single source of truth for the AI workout-analysis prompt.
 * Both entry points -- the Trigger.dev task (`trigger/analyze-workout.ts`) and the
 * Redis-worker service (`server/utils/services/workoutAnalysisService.ts`) -- import
 * from here. Historically each file carried its own copy of these builders, which
 * drifted apart (CW-392).
 */
import { formatUserDate } from '../date'
import {
  formatPromptWeight,
  formatPromptHeight,
  formatPromptDistance,
  formatPromptElevation,
  formatPromptTemperature,
  formatPromptPace
} from '../ai-prompt-format'
import {
  buildAnalysisRequestMetricRules,
  buildMetricPriorityPromptBlock,
  resolveMetricPriorityContext,
  shouldCondenseHeartRateSection
} from '../../../trigger/utils/workout-metric-priority'
import { formatStructuredPlanForPrompt } from '../../../trigger/utils/planned-workout-targets'
import {
  buildIntervalGroupSummaries,
  deriveMetricUsabilitySignals,
  formatCadenceWithUnit,
  getActualIntervalsForAnalysis,
  getActualIntervalsSourceForAnalysis,
  isRunningCadenceFamily,
  toCanonicalCadence,
  type IntervalGroupSummary,
  type WorkoutAnalysisFactsV2
} from '../workout-analysis-facts'
import { summarizePowerFromWatts } from '../power-metrics'
import type { JourneyEventCategory } from '@prisma/client'

export interface WorkoutAnalysisPromptUserProfile {
  age?: number | null
  sex?: string | null
  weight?: number | null
  weightUnits?: string | null
  height?: number | null
  heightUnits?: string | null
  language?: string | null
  temperatureUnits?: string | null
  distanceUnits?: string | null
}

export interface WorkoutAnalysisPromptRecentContext {
  symptoms?: Array<{
    timestamp: Date
    category: JourneyEventCategory | string
    severity: number
    description?: string | null
  }>
}

/**
 * The section-status vocabulary the prompt instructs the model to emit -- see the
 * repeated "Assign status: excellent/good/moderate/needs_improvement/poor" lines in
 * {@link getAnalysisSectionsGuidance}.
 *
 * This is also the vocabulary every UI status->colour mapper understands
 * (`app/pages/workouts/[id]/index.vue`, `app/components/ScoreDetailModal.vue`,
 * `app/pages/report/[id].vue`, `app/pages/share/workouts/[token].vue`). Until CW-403
 * the Redis-worker service handed Gemini a *different* enum
 * (`fair`/`needs_attention`/`info`), which those mappers fall through to `neutral`,
 * so problem sections rendered grey instead of red. Keep this list, the schema enum
 * below, and the prompt text in lockstep; `workout-analysis-prompt.test.ts` fails if
 * they drift.
 */
export const ANALYSIS_SECTION_STATUSES = [
  'excellent',
  'good',
  'moderate',
  'needs_improvement',
  'poor'
] as const

export type AnalysisSectionStatus = (typeof ANALYSIS_SECTION_STATUSES)[number]

/**
 * Inclusive bounds of the performance-score scale. The prompt asks for
 * "**Performance Scores** (1-10 scale for tracking progress over time)" and the DB
 * columns (`overallScore`, `technicalScore`, ...) already hold 1-10 values, so this
 * is the scale the schema must declare too. Do not change without a data migration.
 */
export const ANALYSIS_SCORE_MIN = 1
export const ANALYSIS_SCORE_MAX = 10

/**
 * Shape of the structured analysis Gemini returns for {@link analysisSchema}.
 *
 * `status` is typed as a plain `string` on purpose: analyses stored before CW-403 can
 * contain the retired `fair`/`needs_attention`/`info` values, and the renderers must
 * keep accepting them.
 */
export interface StructuredAnalysis {
  type: string
  title: string
  date?: string
  executive_summary: string
  sections?: Array<{
    title: string
    status: string
    status_label?: string
    analysis_points: string[]
  }>
  recommendations?: Array<{
    title: string
    description: string
    priority?: string
  }>
  strengths?: string[]
  weaknesses?: string[]
  scores?: {
    overall: number
    overall_explanation: string
    technical: number
    technical_explanation: string
    effort: number
    effort_explanation: string
    pacing: number
    pacing_explanation: string
    execution: number
    execution_explanation: string
  }
  metrics_summary?: {
    avg_power?: number
    ftp?: number
    intensity?: number
    duration_minutes?: number
    tss?: number
  }
}

/**
 * The single response schema handed to `generateStructuredAnalysis` by BOTH workout
 * analysis entry points -- the Redis-worker service
 * (`server/utils/services/workoutAnalysisService.ts`, the one that runs in production)
 * and the Trigger.dev task (`trigger/analyze-workout.ts`).
 *
 * It lives next to the prompt that describes it so the two cannot drift (CW-403).
 * Gemini enforces the schema, so anything declared here overrides what the prompt
 * text asks for.
 */
export const analysisSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      description: 'Type of analysis: workout, weekly_report, planning, etc.',
      enum: ['workout', 'weekly_report', 'planning', 'comparison']
    },
    title: {
      type: 'string',
      description: 'Title of the analysis'
    },
    date: {
      type: 'string',
      description: 'Date or date range of the analysis'
    },
    executive_summary: {
      type: 'string',
      description: '2-3 sentence high-level summary of key findings'
    },
    sections: {
      type: 'array',
      description: 'Analysis sections with status and points',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Section title (e.g., Pacing Strategy, Power Application)'
          },
          status: {
            type: 'string',
            description: 'Overall assessment',
            enum: [...ANALYSIS_SECTION_STATUSES]
          },
          status_label: {
            type: 'string',
            description: 'Display label for status'
          },
          analysis_points: {
            type: 'array',
            description: 'Detailed analysis points for this section',
            items: {
              type: 'string'
            }
          }
        },
        required: ['title', 'status', 'analysis_points']
      }
    },
    recommendations: {
      type: 'array',
      description: 'Actionable recommendations',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Recommendation title'
          },
          description: {
            type: 'string',
            description: 'Detailed recommendation'
          },
          priority: {
            type: 'string',
            description: 'Priority level',
            enum: ['high', 'medium', 'low']
          }
        },
        required: ['title', 'description']
      }
    },
    strengths: {
      type: 'array',
      description: 'Key strengths identified',
      items: {
        type: 'string'
      }
    },
    weaknesses: {
      type: 'array',
      description: 'Areas needing improvement',
      items: {
        type: 'string'
      }
    },
    scores: {
      type: 'object',
      description:
        'Performance scores on 1-10 scale for tracking over time, with detailed explanations',
      properties: {
        overall: {
          type: 'number',
          description: 'Overall workout quality (1-10)',
          minimum: ANALYSIS_SCORE_MIN,
          maximum: ANALYSIS_SCORE_MAX
        },
        overall_explanation: {
          type: 'string',
          description:
            'Detailed explanation of overall quality: key factors contributing to score, what went well, what could improve, and 2-3 specific actionable improvements'
        },
        technical: {
          type: 'number',
          description: 'Technical execution score - form, technique, efficiency (1-10)',
          minimum: ANALYSIS_SCORE_MIN,
          maximum: ANALYSIS_SCORE_MAX
        },
        technical_explanation: {
          type: 'string',
          description:
            'Technical analysis: power application smoothness, cadence consistency, form observations, and specific technique improvements needed'
        },
        effort: {
          type: 'number',
          description: 'Effort appropriateness relative to plan and goals (1-10)',
          minimum: ANALYSIS_SCORE_MIN,
          maximum: ANALYSIS_SCORE_MAX
        },
        effort_explanation: {
          type: 'string',
          description:
            'Effort management analysis: whether intensity matched goals, HR/power relationship, and recommendations for effort control'
        },
        pacing: {
          type: 'number',
          description: 'Pacing strategy and execution quality (1-10)',
          minimum: ANALYSIS_SCORE_MIN,
          maximum: ANALYSIS_SCORE_MAX
        },
        pacing_explanation: {
          type: 'string',
          description:
            'Pacing strategy analysis: consistency throughout workout, whether pacing was appropriate, and specific pacing improvements'
        },
        execution: {
          type: 'number',
          description: 'How well the workout plan was executed (1-10)',
          minimum: ANALYSIS_SCORE_MIN,
          maximum: ANALYSIS_SCORE_MAX
        },
        execution_explanation: {
          type: 'string',
          description:
            'Execution quality analysis: adherence to workout structure, target achievement, and recommendations for better execution'
        }
      },
      required: [
        'overall',
        'overall_explanation',
        'technical',
        'technical_explanation',
        'effort',
        'effort_explanation',
        'pacing',
        'pacing_explanation',
        'execution',
        'execution_explanation'
      ]
    },
    metrics_summary: {
      type: 'object',
      description: 'Key metrics at a glance',
      properties: {
        avg_power: { type: 'number' },
        ftp: { type: 'number' },
        intensity: { type: 'number' },
        duration_minutes: { type: 'number' },
        tss: { type: 'number' }
      }
    }
  },
  required: ['type', 'title', 'executive_summary', 'sections', 'scores']
}

/**
 * Normalise a model-supplied performance score to the 1-10 integer scale the
 * `*Score` workout columns hold.
 *
 * The `> 10` branch is a safety net for historic responses produced while one entry
 * point still declared a 0-100 schema; it is kept so a stray 0-100 score is folded
 * back onto the stored scale instead of being clamped flat to 10.
 *
 * Named `clampAnalysisScore` rather than `clampScore` because everything under
 * `server/utils` is Nitro auto-imported and `clampScore` is already used as a local
 * (0-100) helper elsewhere in the server tree.
 */
export function clampAnalysisScore(val?: number | null): number | null {
  if (typeof val !== 'number' || Number.isNaN(val)) return null
  const num = val > ANALYSIS_SCORE_MAX ? val / 10 : val
  return Math.min(ANALYSIS_SCORE_MAX, Math.max(ANALYSIS_SCORE_MIN, Math.round(num)))
}

/**
 * Running exports sometimes report "per-foot" cadence (< 120). Convert those into
 * total steps per minute so the model never reads a 85 spm run as a form problem.
 *
 * Thin alias for the shared {@link toCanonicalCadence}, which is the single
 * implementation of the cadence convention (CW-387). Kept as a named export
 * because `trigger/analyze-workout.ts` re-exports it.
 */
export function normalizeRunningCadence(
  cadence: number | null | undefined,
  isRunningWorkout: boolean
): number | null | undefined {
  return toCanonicalCadence(cadence, isRunningWorkout)
}

/**
 * Everything `buildWorkoutAnalysisData` needs beyond the workout row itself to
 * segment the session the same way the v2 facts do.
 *
 * Both are optional so the payload builder still works from a bare workout row
 * (scripts, older tests), but the two production entry points
 * (`trigger/analyze-workout.ts`, `services/workoutAnalysisService.ts`) must pass
 * them: without the athlete's real references the arbitration between provider
 * laps and engine detection can resolve differently here than it does inside
 * `buildWorkoutAnalysisFactsV2`, which is exactly the split this payload exists
 * to close (CW-391, and CW-384 on why zeroed refs are a bug in their own right).
 */
export interface WorkoutAnalysisDataOptions {
  plannedWorkout?: any
  sportSettings?: any
}

/**
 * Resolve the athlete's reference values for interval arbitration.
 *
 * Deliberately identical to the `refs` literal in `buildWorkoutAnalysisFactsV2`
 * (`server/utils/workout-analysis-facts.ts`): profile-level sport settings
 * first, `workout.ftp` only as the documented FTP fallback, and the session's
 * own max HR never used as a stand-in for the athlete's ceiling. The facts
 * module does not export its resolver, so this mirror carries the invariant --
 * if that literal changes, this one has to change with it or the prompt and the
 * facts can once again disagree about which segmentation won.
 */
function resolveIntervalArbitrationRefs(workout: any, sportSettings: any) {
  return {
    ftp: Number(sportSettings?.ftp || workout?.ftp || 0),
    lthr: Number(sportSettings?.lthr || 0),
    maxHr: Number(sportSettings?.maxHr || 0),
    thresholdPace: Number(sportSettings?.thresholdPace || 0),
    hrZones: sportSettings?.hrZones || [],
    powerZones: sportSettings?.powerZones || [],
    paceZones: sportSettings?.paceZones || []
  }
}

export function buildWorkoutAnalysisData(workout: any, options: WorkoutAnalysisDataOptions = {}) {
  const workoutType = String(workout.type || '')
  const isRunningWorkout = isRunningCadenceFamily(workoutType)
  // The ONLY place session and interval cadence gets converted to the canonical
  // convention. Everything downstream of this payload -- including the
  // "## Interval Breakdown" rows -- must only label, never re-scale.
  const normalizeCadence = (cadence: number | null | undefined) =>
    normalizeRunningCadence(cadence, isRunningWorkout)

  const data: any = {
    id: workout.id,
    date: workout.date,
    title: workout.title,
    description: workout.description,
    notes: workout.notes,
    type: workout.type,
    duration_m: Math.round(workout.durationSec / 60),
    duration_s: workout.durationSec,
    distance_m: workout.distanceMeters,
    elevation_gain: workout.elevationGain
  }
  const streamPowerSummary = summarizePowerFromWatts(workout.streams?.watts)
  const powerZoneTimes = Array.isArray(workout.streams?.powerZoneTimes)
    ? (workout.streams.powerZoneTimes as number[]).filter((value) => typeof value === 'number')
    : []

  // Power metrics
  if (workout.averageWatts) data.avg_power = workout.averageWatts
  else if (streamPowerSummary?.averageWatts) data.avg_power = streamPowerSummary.averageWatts
  if (workout.maxWatts) data.max_power = workout.maxWatts
  else if (streamPowerSummary?.maxWatts) data.max_power = streamPowerSummary.maxWatts
  if (workout.normalizedPower) data.normalized_power = workout.normalizedPower
  else if (streamPowerSummary?.normalizedPower)
    data.normalized_power = streamPowerSummary.normalizedPower
  if (workout.weightedAvgWatts) data.weighted_avg_power = workout.weightedAvgWatts
  if (workout.ftp) data.ftp = workout.ftp
  if (Array.isArray(workout.streams?.watts) && workout.streams.watts.length > 0) {
    data.has_power_stream = true
  }
  if (powerZoneTimes.length > 0 && powerZoneTimes.some((value) => value > 0)) {
    data.power_zone_times = powerZoneTimes
  }

  // Heart rate
  if (workout.averageHr) data.avg_hr = workout.averageHr
  if (workout.maxHr) data.max_hr = workout.maxHr

  // Cadence
  if (workout.averageCadence) {
    // For running-like workout types (Run, VirtualRun, TrailRun...), convert
    // "per-foot" cadence exports (<120) into total steps per minute.
    data.avg_cadence = normalizeCadence(workout.averageCadence)
  }
  if (workout.maxCadence) {
    data.max_cadence = normalizeCadence(workout.maxCadence)
  }

  // Speed
  // `workout.averageSpeed` is stored in m/s by every sync writer (Intervals.icu, Strava,
  // Polar, Rouvy, FIT, Garmin, Wahoo), so it is passed through untouched. This used to be
  // divided by 3.6 as if it were km/h, which told the model the athlete moved 3.6x slower
  // than they did -- badly corrupting pace commentary for runs (CW-382).
  if (workout.averageSpeed) data.avg_speed_ms = workout.averageSpeed

  // Training metrics
  if (workout.tss) data.tss = workout.tss
  if (workout.trainingLoad) data.training_load = workout.trainingLoad
  if (workout.intensity) data.intensity = workout.intensity
  if (workout.kilojoules) data.kilojoules = workout.kilojoules

  // Performance metrics
  if (workout.variabilityIndex) data.variability_index = workout.variabilityIndex
  if (workout.powerHrRatio) data.power_hr_ratio = workout.powerHrRatio
  if (workout.efficiencyFactor) data.efficiency_factor = workout.efficiencyFactor
  if (workout.decoupling !== null && workout.decoupling !== undefined)
    data.decoupling = workout.decoupling
  if (workout.polarizationIndex) data.polarization_index = workout.polarizationIndex

  // Extended Advanced Metrics (Pass through for AI)
  if (workout.fatigueSensitivity) data.fatigue_sensitivity = workout.fatigueSensitivity
  if (workout.powerStability) data.power_stability = workout.powerStability
  if (workout.paceStability) data.pace_stability = workout.paceStability
  if (workout.recoveryTrend) data.recovery_trend = workout.recoveryTrend

  // Training status
  if (workout.ctl) data.ctl = workout.ctl
  if (workout.atl) data.atl = workout.atl

  // Subjective
  if (workout.rpe) data.rpe = workout.rpe
  if (workout.sessionRpe) data.session_rpe = workout.sessionRpe
  if (workout.feel) data.feel = workout.feel

  // Environment
  if (workout.avgTemp !== null && workout.avgTemp !== undefined) data.avg_temp = workout.avgTemp
  if (workout.trainer !== null && workout.trainer !== undefined) data.trainer = workout.trainer

  // L/R Balance
  if (workout.lrBalance !== null && workout.lrBalance !== undefined)
    data.lr_balance = workout.lrBalance

  // Exercises (for Strength/Hevy workouts)
  if (workout.exercises && workout.exercises.length > 0) {
    data.exercises = workout.exercises.map((we: any) => ({
      name: we.exercise.title,
      type: we.exercise.type,
      muscle_group: we.exercise.primaryMuscle,
      notes: we.notes,
      sets: we.sets.map((s: any) => ({
        type: s.type,
        weight: s.weight,
        reps: s.reps,
        rpe: s.rpe,
        distance: s.distanceMeters,
        duration: s.durationSec
      }))
    }))
  }

  // Interval segmentation.
  //
  // ONE segmentation per prompt. This used to read `rawJson.icu_intervals`
  // directly, so the "## Interval Breakdown" table could enumerate a different
  // set of reps than the "## Calculated Workout Facts v2" block printed above
  // it -- the hit rates, `firstVsLastIntervalDeltaPct` and every rep-scoped
  // CW-393 signal are computed over the arbitrated set, while the table the
  // model actually quotes was the provider laps. When the two disagreed the
  // model did silent arithmetic across mismatched rows and no claim could be
  // traced back to a segmentation (CW-391).
  //
  // `getActualIntervalsForAnalysis` is the single arbitration point
  // (`extractActualIntervals`): provider laps with re-derived labels (CW-376)
  // when they describe the session better, engine detection when they do not.
  const plannedWorkout = options.plannedWorkout ?? workout?.plannedWorkout
  const arbitrationRefs = resolveIntervalArbitrationRefs(workout, options.sportSettings)
  const actualIntervals = getActualIntervalsForAnalysis(workout, plannedWorkout, arbitrationRefs)
  if (actualIntervals.length > 0) {
    data.interval_segmentation_source = getActualIntervalsSourceForAnalysis(
      workout,
      plannedWorkout,
      arbitrationRefs
    )
    data.intervals = actualIntervals.map((interval) => ({
      type: interval.type,
      classification: interval.classification,
      duration_s: interval.durationSeconds,
      avg_power: interval.avgPower,
      // Already an intensity FACTOR: `mapIntervalsToActual` runs the shared
      // CW-385 heuristic (`toIntervalIntensityFactor`) over the provider's
      // percentage, and engine-detected segments carry no intensity at all. The
      // renderer may only label it (CW-388).
      intensity: interval.intensity,
      avg_hr: interval.avgHr,
      avg_cadence: normalizeCadence(interval.avgCadence),
      avg_speed_ms: interval.avgSpeed,
      confidence: interval.confidence,
      ambiguity_note: interval.ambiguityNote,
      // Stream offsets, so a claim about "your fourth rep" can be reconciled
      // against the chart afterwards. Null for sources that carry none.
      start_index: interval.startIndex,
      end_index: interval.endIndex
    }))

    // Work-only and recovery-only aggregates over the SAME arbitrated set
    // (CW-381).
    //
    // Without these the payload jumps straight from per-lap rows to session
    // means, and the model reaches for the session mean when it wants an
    // interval number: a 4x4min threshold run was told 162 spm was "somewhat
    // low for threshold work" when 162 was the whole-session mean (warmup,
    // recovery jogs and cooldown included) and the four reps themselves ran
    // 177 spm.
    //
    // Grouped by the RESOLVED interval type, never by `lap_splits` -- those are
    // automatic per-distance splits that cut across reps and recoveries
    // (CW-389). Cadence is normalised here and only here, exactly like the
    // session and per-interval values above.
    const intervalGroups = buildIntervalGroupSummaries(actualIntervals)
    const toSummaryPayload = (summary: IntervalGroupSummary | null) =>
      summary
        ? {
            rep_count: summary.repCount,
            total_duration_s: Math.round(summary.totalDurationSeconds),
            avg_duration_s: Math.round(summary.avgDurationSeconds),
            avg_power: summary.avgPower,
            avg_hr: summary.avgHr,
            avg_cadence: normalizeCadence(summary.avgCadence),
            avg_speed_ms: summary.avgSpeed,
            avg_pace_s_per_km: summary.avgPaceSecondsPerKm
          }
        : null

    const workSummary = toSummaryPayload(intervalGroups.work)
    const recoverySummary = toSummaryPayload(intervalGroups.recovery)
    if (workSummary) data.work_interval_summary = workSummary
    if (recoverySummary) data.recovery_interval_summary = recoverySummary
  }

  // Extract pacing splits from rawJson if available
  if (workout.rawJson && typeof workout.rawJson === 'object') {
    const raw = workout.rawJson as any

    // Strava splits (lap pacing data)
    const splits = raw.splits_metric || raw.splits_standard
    if (splits && Array.isArray(splits) && splits.length > 0) {
      data.lap_splits = splits.map((split: any, index: number) => {
        const time = split.moving_time || split.elapsed_time
        const paceMinPerKm = split.distance > 0 ? time / 60 / (split.distance / 1000) : 0
        const paceMin = Math.floor(paceMinPerKm)
        const paceSec = Math.round((paceMinPerKm - paceMin) * 60)

        return {
          lap: index + 1,
          distance_m: split.distance,
          time_s: time,
          pace_min_per_km: `${paceMin}:${paceSec.toString().padStart(2, '0')}`,
          avg_speed_ms: split.average_speed,
          avg_hr: split.average_heartrate
        }
      })

      // Calculate pacing consistency
      const paces = data.lap_splits.map((s: any) => s.time_s / (s.distance_m / 1000))
      if (paces.length > 1) {
        const avgPace = paces.reduce((sum: number, p: number) => sum + p, 0) / paces.length
        const variance =
          paces.reduce((sum: number, p: number) => sum + Math.pow(p - avgPace, 2), 0) / paces.length
        data.pace_variability_seconds = Math.sqrt(variance)
      }
    }
  }

  return data
}

/**
 * Get workout type-specific guidance for the AI
 */
export function getWorkoutTypeGuidance(
  workoutType: string,
  isCardio: boolean,
  isStrength: boolean
): string {
  if (isStrength) {
    return `Focus your analysis on strength training aspects like volume, intensity, rest periods, and exercise selection. 
Metrics like cadence, power output, and aerobic efficiency are NOT RELEVANT for this workout type - DO NOT analyze them.
Instead, analyze heart rate in the context of training intensity zones for resistance training.`
  }

  if (isCardio) {
    if (workoutType.toLowerCase().includes('run')) {
      return `This is a running workout. Focus on running-specific metrics like pace, cadence (steps per minute), and heart rate zones.
Power metrics may not be available and that's normal for running workouts.`
    }
    if (workoutType.toLowerCase().includes('ride') || workoutType.toLowerCase().includes('bike')) {
      return `This is a cycling workout. Analyze power metrics, pacing, cadence (RPM), and pedaling efficiency where available.`
    }
    return `This is a cardio workout. Focus on pacing, effort distribution, and aerobic efficiency.
Analyze available metrics like heart rate, pace/speed, and any power data if present.`
  }

  return `Analyze this workout based on the available metrics. Focus on what's most relevant for this activity type.`
}

/**
 * Get workout type-specific analysis section guidance
 */
export function getAnalysisSectionsGuidance(
  workoutType: string,
  isCardio: boolean,
  isStrength: boolean
): string {
  if (isStrength) {
    return `Provide a structured analysis with these sections:

1. **Executive Summary**: Write 2-3 friendly, encouraging sentences highlighting the most important findings. Keep it conversational and positive.

2. **Training Volume**: Analyze workout duration, estimated sets/reps if available from description, and overall training load
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item, not paragraphs)
   - Each point should be 1-2 sentences maximum

3. **Intensity Management**: Evaluate effort level based on heart rate zones and RPE if available
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum

4. **Recovery & Pacing**: Assess rest periods and workout structure based on duration and heart rate patterns
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum

5. **Workout Execution**: Evaluate overall session quality and adherence to training principles
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum`
  }

  if (isCardio && workoutType.toLowerCase().includes('run')) {
    return `Provide a structured analysis with these sections:

1. **Executive Summary**: Write 2-3 friendly, encouraging sentences highlighting the most important findings. Keep it conversational and positive.

2. **Pacing Strategy**: Analyze pace consistency, effort distribution, and pacing discipline
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item, not paragraphs)
   - Each point should be 1-2 sentences maximum

3. **Running Form**: Evaluate cadence patterns (steps per minute) and stride efficiency
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum

4. **Effort Management**: Assess heart rate zones and perceived exertion
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum

5. **Workout Execution**: Evaluate target achievement and interval quality if applicable
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum`
  }

  // Default to cycling/bike-focused sections
  return `Provide a structured analysis with these sections:

1. **Executive Summary**: Write 2-3 friendly, encouraging sentences highlighting the most important findings. Keep it conversational and positive.

2. **Pacing Strategy**: Analyze power variability (VI), surging behavior, and pacing discipline
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item, not paragraphs)
   - Each point should be 1-2 sentences maximum

3. **Pedaling Efficiency**: Evaluate cadence patterns, L/R balance, and technique
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum

4. **Power Application**: Assess consistency, fade patterns, and zone adherence
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum

5. **Workout Execution**: Evaluate target achievement and interval quality
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 3-5 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum

6. **Efficiency & Fatigue**: Analyze endurance fade, power stability, and heart rate recovery trends.
   - Assign status: excellent/good/moderate/needs_improvement/poor
   - Provide 2-4 separate, concise bullet points (each as a separate array item)
   - Each point should be 1-2 sentences maximum`
}

function getFactValueByPath(facts: any, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, facts)
}

function formatPromptFactValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (Array.isArray(value)) return value.length > 0 ? value.join('; ') : null
  if (typeof value === 'string') return value.length > 0 ? value : null
  return String(value)
}

/**
 * Say which segmentation the whole prompt is built on, in human terms.
 *
 * `getActualIntervalsSourceForAnalysis` returns the arbitration verdict as
 * `'raw' | 'detected' | 'none'`, which means nothing to the model. Naming it in
 * the prompt is what lets an AI claim about "your fourth rep" be reconciled
 * against the chart afterwards (CW-391). `'none'` renders as `null` -- with no
 * segments there is no source to report and the interval section is omitted
 * entirely.
 */
export function describeIntervalSegmentationSource(
  source: 'raw' | 'detected' | 'none' | null | undefined
): string | null {
  if (source === 'raw') return 'provider laps (labels re-derived)'
  if (source === 'detected') return 'engine detection over the recorded streams'
  return null
}

export interface AnalysisFactsPromptBlockOptions {
  /** Arbitration verdict from `getActualIntervalsSourceForAnalysis`. */
  intervalSegmentationSource?: 'raw' | 'detected' | 'none' | null
}

/**
 * A row of the facts block.
 *
 * `path` reads a value out of the facts object and is gated on that path's
 * `promptDecisions` entry. `value` carries an already-resolved string for facts
 * that are not part of `WorkoutAnalysisFactsV2` itself -- currently only the
 * interval-segmentation provenance, which is computed in the payload builder
 * because that is where the workout row (and therefore the streams) is in
 * scope. Such rows render whenever the value is non-null; there is no
 * `promptDecisions` entry to gate them on.
 */
type AnalysisFactItem = { label: string; path?: string; value?: string | null }

export function buildAnalysisFactsPromptBlock(
  analysisFacts?: WorkoutAnalysisFactsV2,
  options: AnalysisFactsPromptBlockOptions = {}
): string {
  if (!analysisFacts) return ''

  const promptDecisions = analysisFacts.confidence.debugMeta.promptDecisions || {}
  const groups: Array<{ title: string; items: AnalysisFactItem[] }> = [
    {
      title: 'Guardrails',
      items: [
        { path: 'guardrails.analysisMode', label: 'Analysis Mode' },
        { path: 'guardrails.archetype.primaryArchetype', label: 'Primary Archetype' },
        { path: 'guardrails.archetype.executionEnvironment', label: 'Execution Environment' },
        { path: 'guardrails.archetype.primaryMetric', label: 'Primary Metric' },
        { path: 'guardrails.archetype.sessionSteadiness', label: 'Session Steadiness' },
        { path: 'guardrails.telemetry.hrUsable', label: 'HR Usable' },
        { path: 'guardrails.telemetry.hrArtifactSeverity', label: 'HR Artifact Severity' },
        { path: 'guardrails.telemetry.powerSourceType', label: 'Power Source Type' },
        { path: 'guardrails.telemetry.powerAbsoluteUsable', label: 'Power Absolute Usable' },
        { path: 'guardrails.telemetry.powerRelativeUsable', label: 'Power Relative Usable' },
        { path: 'guardrails.telemetry.paceUsable', label: 'Pace Usable' },
        { path: 'guardrails.telemetry.gpsConfidence', label: 'GPS Confidence' },
        { path: 'guardrails.telemetry.lrBalanceUsable', label: 'L/R Balance Usable' },
        { path: 'guardrails.telemetry.lrInterpretationMode', label: 'L/R Interpretation Mode' },
        { path: 'guardrails.erg.detected', label: 'ERG Detected' },
        { path: 'guardrails.erg.powerControlMode', label: 'Power Control Mode' },
        { path: 'guardrails.suppressions', label: 'Suppressions' },
        {
          label: 'Interval Segmentation Source',
          value: describeIntervalSegmentationSource(options.intervalSegmentationSource)
        }
      ]
    },
    {
      title: 'Adherence',
      items: [
        { path: 'adherence.planLinked', label: 'Plan Linked' },
        { path: 'adherence.adherenceAssessable', label: 'Adherence Assessable' },
        { path: 'adherence.adherenceReason', label: 'Adherence Reason' },
        { path: 'adherence.completionPct', label: 'Completion %' },
        { path: 'adherence.durationVsPlanPct', label: 'Duration vs Plan %' },
        { path: 'adherence.workIntervalHitRate', label: 'Work Interval Hit Rate' },
        { path: 'adherence.recoveryHitRate', label: 'Recovery Hit Rate' },
        { path: 'adherence.targetOvershootPct', label: 'Target Overshoot %' },
        { path: 'adherence.targetUndershootPct', label: 'Target Undershoot %' },
        { path: 'adherence.structureMatched', label: 'Structure Matched' },
        { path: 'adherence.executionClassification', label: 'Execution Classification' }
      ]
    },
    {
      title: 'Performance Signals',
      items: [
        {
          path: 'performanceSignals.applicability.lateSessionFade.applicable',
          label: 'Late Session Fade Applicable'
        },
        {
          path: 'performanceSignals.applicability.lateSessionFade.reason',
          label: 'Late Session Fade Applicability Reason'
        },
        {
          path: 'performanceSignals.applicability.executionStability.applicable',
          label: 'Execution Stability Applicable'
        },
        {
          path: 'performanceSignals.applicability.executionStability.reason',
          label: 'Execution Stability Applicability Reason'
        },
        {
          path: 'performanceSignals.applicability.repeatability.applicable',
          label: 'Repeatability Applicable'
        },
        {
          path: 'performanceSignals.applicability.repeatability.reason',
          label: 'Repeatability Applicability Reason'
        },
        {
          path: 'performanceSignals.applicability.cadenceDrift.applicable',
          label: 'Cadence Drift Applicable'
        },
        {
          path: 'performanceSignals.applicability.cadenceDrift.reason',
          label: 'Cadence Drift Applicability Reason'
        },
        {
          path: 'performanceSignals.applicability.pacingDrift.applicable',
          label: 'Pacing Drift Applicable'
        },
        {
          path: 'performanceSignals.applicability.pacingDrift.reason',
          label: 'Pacing Drift Applicability Reason'
        },
        {
          path: 'performanceSignals.applicability.cadenceStability.applicable',
          label: 'Cadence Stability Applicable'
        },
        {
          path: 'performanceSignals.applicability.cadenceStability.reason',
          label: 'Cadence Stability Applicability Reason'
        },
        { path: 'performanceSignals.decoupling.interpretable', label: 'Decoupling Interpretable' },
        { path: 'performanceSignals.decoupling.reason', label: 'Decoupling Reason' },
        { path: 'performanceSignals.decoupling.effective', label: 'Decoupling Effective' },
        { path: 'performanceSignals.decoupling.direction', label: 'Decoupling Direction' },
        { path: 'performanceSignals.durability.lateSessionFadePct', label: 'Late Session Fade %' },
        {
          path: 'performanceSignals.durability.firstVsLastIntervalDeltaPct',
          label: 'First vs Last Interval Delta %'
        },
        {
          path: 'performanceSignals.durability.recoveryTrendScore',
          label: 'Recovery Trend Score'
        },
        {
          path: 'performanceSignals.durability.executionStabilityScore',
          label: 'Execution Stability Score'
        },
        {
          path: 'performanceSignals.durability.repeatabilityScore',
          label: 'Repeatability Score'
        },
        { path: 'performanceSignals.zones.dominantPowerZone', label: 'Dominant Power Zone' },
        { path: 'performanceSignals.zones.dominantHrZone', label: 'Dominant HR Zone' },
        {
          path: 'performanceSignals.zones.timeAboveThresholdPct',
          label: 'Time Above Threshold %'
        },
        {
          path: 'performanceSignals.sportSpecific.cadenceDriftPct',
          label: 'Cadence Drift %'
        },
        {
          path: 'performanceSignals.sportSpecific.cadenceStabilityScore',
          label: 'Cadence Stability Score'
        },
        { path: 'performanceSignals.sportSpecific.torqueProfile', label: 'Torque Profile' },
        {
          path: 'performanceSignals.sportSpecific.pacingDriftPct',
          label: 'Pacing Drift %'
        }
      ]
    },
    {
      title: 'Confidence',
      items: [
        { path: 'confidence.overall', label: 'Overall Confidence' },
        { path: 'confidence.debugMeta.suppressedMetrics', label: 'Suppressed Metrics' }
      ]
    }
  ]

  const sections = groups
    .map((group) => {
      const lines = group.items
        .map((item) => {
          if (item.path === undefined) {
            return item.value ? `- ${item.label}: ${item.value}` : null
          }
          if (!promptDecisions[item.path]?.include) return null
          const rawValue = getFactValueByPath(analysisFacts, item.path)
          const formatted = formatPromptFactValue(rawValue)
          return formatted ? `- ${item.label}: ${formatted}` : null
        })
        .filter((line): line is string => Boolean(line))

      if (lines.length === 0) return null
      return `### ${group.title}\n${lines.join('\n')}`
    })
    .filter((section): section is string => Boolean(section))

  if (sections.length === 0) return ''

  return `
## Calculated Workout Facts v2

Use the following computed workout facts as the primary interpretation contract for this analysis.

${sections.join('\n\n')}

Rules for these facts:
- Treat these facts as authoritative guardrails and adherence summaries.
- Do not infer meaning from omitted facts.
- If a fact says a metric is suppressed, unusable, or not interpretable, do not analyze it.
- Prefer these facts over generic coaching heuristics when they conflict.
`
}

export function buildAnalysisGuardrailInstructions(
  workoutType: string,
  analysisFacts?: WorkoutAnalysisFactsV2
): string {
  const rules: string[] = [
    'Do not recommend purchasing new hardware or equipment from a single-workout analysis unless there is an explicit, repeated measurement limitation clearly stated in the facts.',
    'Do not use ATL, CTL, or TSB alone as proof of technique breakdown; they are context only.'
  ]

  const sessionSteadiness = analysisFacts?.guardrails.archetype.sessionSteadiness
  if (sessionSteadiness === 'intervalled' || sessionSteadiness === 'stochastic') {
    rules.push(
      'Do not criticize the athlete for lacking a constant pace or uniform effort when the session is classified as intervalled or stochastic.'
    )
    rules.push(
      'Treat explosive bursts, stop-and-go pacing, and recovery valleys as potentially intentional execution patterns rather than automatic pacing mistakes.'
    )
  }

  if (analysisFacts && !analysisFacts.performanceSignals.decoupling.interpretable) {
    rules.push(
      'Do not derive fatigue, technical breakdown, or pacing decline narratives from decoupling or drift when the facts mark those interpretations as suppressed.'
    )
  }

  if (workoutType.toLowerCase().includes('ski')) {
    rules.push(
      'For Nordic/cross-country skiing, avoid cycling-specific gear advice such as recommending a power meter unless the user explicitly asks about equipment.'
    )
  }

  if (analysisFacts?.confidence.overall === 'medium') {
    rules.push(
      'Keep recommendations conservative and avoid strong causal claims; prefer tentative wording such as "may", "might", or "suggests".'
    )
  }

  if (analysisFacts?.confidence.overall === 'low') {
    rules.push(
      'Do not make high-priority recommendations or strong diagnosis-style claims when overall confidence is low.'
    )
  }

  const inapplicableSignals = Object.entries(analysisFacts?.performanceSignals.applicability || {})
    .filter(([, value]: any) => value && value.applicable === false)
    .map(([key]) => key)

  if (inapplicableSignals.length > 0) {
    rules.push(
      `Do not base recommendations on inapplicable signals for this workout: ${inapplicableSignals.join(', ')}.`
    )
  }

  return rules.map((rule) => `- ${rule}`).join('\n')
}

/**
 * Render an interval's duration as `<minutes>m <seconds>s`.
 *
 * The minutes term must FLOOR: the seconds term is a true remainder, so
 * rounding the minutes counts the remainder twice and invents up to a full
 * minute of work (150s used to render as "3m 30s" instead of "2m 30s", and the
 * model quoted the inflated number back to the athlete). Same convention as
 * `formatActualIntervalsForPrompt` in `workout-analysis-facts.ts` and as the
 * lap-split renderer below (CW-388).
 */
export function formatIntervalDuration(durationSeconds: number): string {
  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  return `${minutes}m ${seconds}s`
}

/**
 * Label an interval intensity that `buildWorkoutAnalysisData` has ALREADY put
 * on the intensity-factor scale (`toIntervalIntensityFactor`).
 *
 * The prompt used to print a bare `Intensity: 101.00` a few lines from
 * `Intensity Factor: 0.83` -- two scales for one concept, neither labelled. The
 * percentage in brackets is a restatement of the same number, not a second
 * scale, so the model can tie the row to the session line either way (CW-388).
 */
export function formatIntervalIntensity(intensityFactor: number): string {
  return `${intensityFactor.toFixed(2)} IF (${Math.round(intensityFactor * 100)}% of threshold)`
}

/**
 * Render one duration-weighted interval aggregate as prompt bullets (CW-381).
 *
 * Only metrics the group actually carried are printed: a missing value means
 * "these segments had no such measurement", and printing a fabricated `0W`
 * would hand the model a number to reason from. Values arrive already on the
 * canonical scales `buildWorkoutAnalysisData` established (cadence normalised,
 * speed in m/s, pace in seconds per kilometre); this renderer only labels them.
 */
export function formatIntervalGroupSummary(
  summary: any,
  options: {
    workoutType: string
    isCadenceRelevant: boolean
    paceCapable: boolean
    distanceUnits?: string | null
  }
): string {
  if (!summary) return ''

  let block = `- Segments: ${summary.rep_count}\n`
  block += `- Total Time: ${formatIntervalDuration(summary.total_duration_s)}\n`
  block += `- Average Segment Length: ${formatIntervalDuration(summary.avg_duration_s)}\n`
  if (summary.avg_power != null) {
    block += `- Average Power (duration-weighted): ${Math.round(summary.avg_power)}W\n`
  }
  if (summary.avg_hr != null) {
    block += `- Average HR (duration-weighted): ${Math.round(summary.avg_hr)} bpm\n`
  }
  if (options.isCadenceRelevant && summary.avg_cadence != null) {
    block += `- Average Cadence (duration-weighted): ${formatCadenceWithUnit(
      Math.round(summary.avg_cadence),
      options.workoutType
    )}\n`
  }
  if (options.paceCapable && summary.avg_pace_s_per_km != null) {
    block += `- Average Pace (duration-weighted): ${formatPromptPace(
      summary.avg_pace_s_per_km,
      options.distanceUnits
    )}\n`
  }
  return block
}

/**
 * Decide whether the derived pacing verdicts over `lap_splits` -- the
 * first-half/second-half "split strategy" call and the pace-variability grade
 * band -- mean anything for this session (CW-389).
 *
 * `lap_splits` are NOT laps. `buildWorkoutAnalysisData` fills them from
 * `raw.splits_metric || raw.splits_standard` (and the FIT/Rouvy path from
 * `calculateLapSplits(..., 1000)`), i.e. automatic per-kilometre or per-mile
 * splits. On an intervalled or stochastic session those splits straddle warmup,
 * work reps, recovery jogs and cooldown arbitrarily, so comparing the first half
 * against the second half compares "mostly warmup" against "mostly cooldown" and
 * reliably reports `Positive Split (slowed down)` for a workout that was simply
 * intervals. The prompt used to assert that verdict as fact several hundred
 * lines after `buildAnalysisGuardrailInstructions` had politely asked the model
 * to disregard non-constant pace on such sessions (CW-393) -- a soft request
 * losing to a hard assertion. The fix is to stop emitting the verdict.
 *
 * Gated on `guardrails.archetype.sessionSteadiness` rather than on an entry of
 * `performanceSignals.applicability`: the closest neighbour there,
 * `lateSessionFade`, also reports `applicable: false` whenever its own value
 * could not be computed, which says nothing about whether half-splits are
 * comparable. Session steadiness is the shape question this verdict actually
 * poses -- `primaryArchetype` is an intent label (an interval run still reads
 * `endurance` when no plan is linked) and does not answer it. The return shape
 * follows `SignalApplicability` so a withheld verdict carries the reason it was
 * withheld.
 *
 * Without v2 facts there is no session-shape evidence to gate on, so the legacy
 * path is left exactly as it was.
 */
export function resolveSplitPacingVerdictApplicability(analysisFacts?: WorkoutAnalysisFactsV2): {
  applicable: boolean
  reason: string | null
} {
  if (!analysisFacts) return { applicable: true, reason: null }

  const { sessionSteadiness } = analysisFacts.guardrails.archetype

  if (sessionSteadiness === 'intervalled' || sessionSteadiness === 'stochastic') {
    return {
      applicable: false,
      reason: `session steadiness is ${sessionSteadiness}, so automatic distance splits cut across warmup, work reps, recoveries and cooldown; their halves are not comparable`
    }
  }

  return { applicable: true, reason: null }
}

export function buildWorkoutAnalysisPrompt(
  workoutData: any,

  timezone: string,

  persona: string = 'Supportive',

  sportSettings?: any,

  userProfile?: WorkoutAnalysisPromptUserProfile,

  aiContext?: string | null,

  plannedWorkout?: any,

  analysisFactsV2?: WorkoutAnalysisFactsV2,

  recentContext?: WorkoutAnalysisPromptRecentContext
): string {
  const formatMetric = (value: any, decimals = 1) => {
    return value !== undefined && value !== null ? Number(value).toFixed(decimals) : 'N/A'
  }

  const dateStr = formatUserDate(workoutData.date, timezone, 'yyyy-MM-dd')

  // Determine the workout type for context-aware analysis

  const workoutType = workoutData.type || 'Unknown'

  const isCardio = [
    'Ride',
    'Run',
    'Swim',
    'VirtualRide',
    'VirtualRun',
    'Ski',
    'NordicSki',
    'Row'
  ].some((t) => workoutType.toLowerCase().includes(t.toLowerCase()))

  const isStrength = ['Gym', 'WeightTraining', 'Strength', 'CrossFit'].some((t) =>
    workoutType.toLowerCase().includes(t.toLowerCase())
  )
  const isCadenceRelevant = ['run', 'ride', 'bike', 'cycle'].some((t) =>
    workoutType.toLowerCase().includes(t)
  )
  // The V2 facts get a vote here so the "## Metric Priority Rules" block cannot
  // name a primary metric the facts block in this same prompt reports as unusable
  // or absent (CW-397).
  const metricPriorityContext = resolveMetricPriorityContext(
    sportSettings?.loadPreference,
    workoutData,
    // `workoutType` because the facts carry no sport family, and whether pace may
    // lead is a question about the sport (CW-437 is about bikes specifically).
    deriveMetricUsabilitySignals(analysisFactsV2, workoutType)
  )
  const condensedHrSection = shouldCondenseHeartRateSection(metricPriorityContext)

  // Set appropriate coach persona and focus based on workout type

  let coachType = 'fitness coach'

  if (isCardio && workoutType.toLowerCase().includes('ride')) {
    coachType = 'cycling coach'
  } else if (isCardio && workoutType.toLowerCase().includes('run')) {
    coachType = 'running coach'
  } else if (isStrength) {
    coachType = 'strength and conditioning coach'
  }

  let zoneDefinitions = ''

  if (sportSettings) {
    zoneDefinitions += `\n## Defined Training Zones (Reference)\n`

    if (sportSettings.ftp) zoneDefinitions += `- **FTP**: ${sportSettings.ftp} W\n`

    if (sportSettings.lthr) zoneDefinitions += `- **LTHR**: ${sportSettings.lthr} bpm\n`

    if (sportSettings.loadPreference) {
      zoneDefinitions += `- **Preferred Load Metric**: ${sportSettings.loadPreference}\n`
      zoneDefinitions += `- **Metric Priority Order**: ${metricPriorityContext.priority.join(' > ')}\n`
    }

    if (sportSettings.hrZones && Array.isArray(sportSettings.hrZones)) {
      zoneDefinitions += '- **Heart Rate Zones**:\n'

      sportSettings.hrZones.forEach((z: any) => {
        zoneDefinitions += `  - ${z.name}: ${z.min}-${z.max} bpm\n`
      })
    }

    if (sportSettings.powerZones && Array.isArray(sportSettings.powerZones)) {
      zoneDefinitions += '- **Power Zones**:\n'

      sportSettings.powerZones.forEach((z: any) => {
        zoneDefinitions += `  - ${z.name}: ${z.min}-${z.max} W\n`
      })
    }
  }

  let prompt = `You are an expert ${coachType} analyzing a workout.

Your persona is: **${persona}**. Adapt your tone and feedback style accordingly.
Preferred Language: ${userProfile?.language || 'English'} (CRITICAL: ALL analysis, summaries, and text responses MUST be written in this language)



ATHLETE CONTEXT:

- Age: ${userProfile?.age || 'Unknown'}

- Sex: ${userProfile?.sex || 'Unknown'}

- Height: ${formatPromptHeight(userProfile?.height, userProfile?.heightUnits)}

${userProfile?.weight ? `- Weight: ${formatPromptWeight(userProfile.weight, userProfile.weightUnits)}` : ''}

${aiContext ? `\n## Global Athlete Context / About Me / Special Instructions\n${aiContext}\n` : ''}

${
  recentContext?.symptoms?.length
    ? `\n## Recent Symptoms & Recovery Context\n${recentContext.symptoms
        .map((event) => {
          const details = [
            `${formatUserDate(event.timestamp, timezone, 'yyyy-MM-dd')}`,
            `${String(event.category).toLowerCase()}`,
            `severity ${event.severity}/10`
          ]
          if (event.description) details.push(event.description)
          return `- ${details.join(' | ')}`
        })
        .join('\n')}
\nUse this symptom context when interpreting RPE, heart rate, and perceived difficulty. Do not frame illness-related elevation in RPE as poor execution unless the workout facts clearly support that conclusion.\n`
    : ''
}

${buildAnalysisFactsPromptBlock(analysisFactsV2, {
  intervalSegmentationSource: workoutData.interval_segmentation_source
})}



**IMPORTANT - Workout Type Context**: This is a **${workoutType}** workout. ${getWorkoutTypeGuidance(workoutType, isCardio, isStrength)}



## Workout Details

- **Date**: ${dateStr}

- **Title**: ${workoutData.title}

- **Type**: ${workoutType}

- **Duration**: ${workoutData.duration_m} minutes (${workoutData.duration_s}s)

`

  // Add Planned Workout Context

  if (plannedWorkout) {
    prompt += `

## Planned Workout Context (Adherence Check)

This workout was linked to a planned training session. Compare the actual execution against these targets:

- **Planned Title**: ${plannedWorkout.title}

- **Planned Description**: ${plannedWorkout.description || 'N/A'}

- **Planned Duration**: ${plannedWorkout.durationSec ? Math.round(plannedWorkout.durationSec / 60) + ' min' : 'N/A'}

- **Planned TSS**: ${plannedWorkout.tss || 'N/A'}

- **Planned Intensity**: ${plannedWorkout.workIntensity ? (plannedWorkout.workIntensity * 100).toFixed(0) + '%' : 'N/A'}

`

    // Extract detailed structured plan if available (from numeric target fields, not step title text)
    const formattedPlan = formatStructuredPlanForPrompt(plannedWorkout.structuredWorkout, {
      ftp: workoutData.ftp || sportSettings?.ftp || null
    })
    if (formattedPlan !== 'N/A') {
      prompt += `### Structured Plan (Target Intervals)\n`
      prompt += `${formattedPlan
        .split('\n')
        .map((line) => `- ${line}`)
        .join('\n')}\n`
      prompt += `\nUse this detailed plan structure to precisely evaluate if the athlete hit the specific interval targets (Power/Duration) listed above. Use these numeric targets as source of truth; step names can contain stale labels and must never override the structured values.\n`
    }

    prompt += `

When analyzing "Execution" and "Effort", specifically reference how well the athlete stuck to this plan. Did they go too hard? Too easy? Did they match the duration?

`
  }

  // Add zone definitions to context

  prompt += zoneDefinitions
  prompt += buildMetricPriorityPromptBlock(metricPriorityContext)

  if (workoutData.distance_m) {
    prompt += `- **Distance**: ${formatPromptDistance(workoutData.distance_m, userProfile?.distanceUnits)}\n`
  }

  if (workoutData.elevation_gain) {
    prompt += `- **Elevation Gain**: ${formatPromptElevation(workoutData.elevation_gain, userProfile?.distanceUnits)}\n`
  }

  if (
    metricPriorityContext.primaryMetric === 'PACE' &&
    metricPriorityContext.primaryMetricAvailable
  ) {
    prompt += '\n## Pace & Speed (Primary Metric)\n'
    const avgPaceSecPerKm =
      workoutData.distance_m && workoutData.duration_s
        ? workoutData.duration_s / (workoutData.distance_m / 1000)
        : null
    if (avgPaceSecPerKm) {
      prompt += `- Average Pace: ${formatPromptPace(avgPaceSecPerKm, userProfile?.distanceUnits)}\n`
    }
    if (workoutData.avg_speed_ms) {
      prompt += `- Average Speed: ${formatMetric(workoutData.avg_speed_ms, 2)} m/s\n`
    }
    if (workoutData.pace_variability_seconds) {
      prompt += `- Pace Variability: ${formatMetric(workoutData.pace_variability_seconds, 1)}s SD\n`
    }
    if (workoutData.pace_stability) {
      prompt += `- Pace Stability (CoV): ${formatMetric(workoutData.pace_stability.overallCoV, 1)}%\n`
    }
    if (workoutData.lap_splits?.length) {
      prompt += `- Lap Splits Available: ${workoutData.lap_splits.length}\n`
    }
  }

  // Only include power metrics for cardio workouts where they're relevant
  if (isCardio) {
    prompt += '\n## Power Metrics\n'
    if (
      workoutData.avg_power ||
      workoutData.max_power ||
      workoutData.normalized_power ||
      workoutData.weighted_avg_power ||
      workoutData.has_power_stream ||
      (Array.isArray(workoutData.power_zone_times) &&
        workoutData.power_zone_times.some((value: number) => value > 0))
    ) {
      if (workoutData.avg_power) prompt += `- Average Power: ${workoutData.avg_power}W\n`
      if (workoutData.max_power) prompt += `- Max Power: ${workoutData.max_power}W\n`
      if (workoutData.normalized_power)
        prompt += `- Normalized Power: ${workoutData.normalized_power}W\n`
      if (workoutData.weighted_avg_power)
        prompt += `- Weighted Avg Power: ${workoutData.weighted_avg_power}W\n`
      if (workoutData.ftp) prompt += `- FTP at time: ${workoutData.ftp}W\n`
      if (workoutData.intensity)
        prompt += `- Intensity Factor: ${formatMetric(workoutData.intensity, 3)}\n`
      if (workoutData.has_power_stream) prompt += '- Power Stream Samples: Available\n'
      if (
        Array.isArray(workoutData.power_zone_times) &&
        workoutData.power_zone_times.some((value: number) => value > 0)
      ) {
        prompt += '- Power Zone Distribution: Available from stream metadata\n'
      }
      if (
        !workoutData.avg_power &&
        !workoutData.max_power &&
        !workoutData.normalized_power &&
        !workoutData.weighted_avg_power &&
        (workoutData.has_power_stream ||
          (Array.isArray(workoutData.power_zone_times) &&
            workoutData.power_zone_times.some((value: number) => value > 0)))
      ) {
        prompt +=
          '- Note: Stored workout summary omitted power rollups, but power telemetry is present and should be treated as available primary evidence.\n'
      }
    } else {
      prompt += `- Average Power: N/A\n`
      prompt += `- Normalized Power: N/A\n`
      prompt += `- Note: Power data appears to be missing from the global summary.\n`
    }
  }

  // Heart rate is relevant for all workout types
  if (workoutData.avg_hr || workoutData.max_hr || workoutData.avg_cadence || isCardio) {
    prompt += condensedHrSection ? '\n## Heart Rate (Secondary Corroboration)' : '\n## Heart Rate'
    // Cadence label is only for cadence-relevant workouts
    if (isCadenceRelevant) {
      prompt += ' & Cadence'
    }
    prompt += '\n'

    if (workoutData.avg_hr) prompt += `- Average HR: ${workoutData.avg_hr} bpm\n`
    else if (isCardio) prompt += `- Average HR: N/A\n`

    if (workoutData.max_hr) prompt += `- Max HR: ${workoutData.max_hr} bpm\n`

    // Cadence is only relevant for cycling/running-like workouts. It is gated on
    // `isCadenceRelevant` alone and deliberately NOT on `condensedHrSection`
    // (CW-412): condensing exists to stop heart rate dominating the narrative
    // when pace leads, and cadence is not heart rate. Coupling the two meant a
    // pace-primary run -- the case where running cadence matters most -- got the
    // unconditional per-interval cadence rows in `## Interval Breakdown` with no
    // session baseline to compare them against.
    if (isCadenceRelevant) {
      if (workoutData.avg_cadence)
        prompt += `- Average Cadence: ${formatCadenceWithUnit(workoutData.avg_cadence, workoutType)}\n`
      else prompt += `- Average Cadence: N/A\n`

      if (workoutData.max_cadence)
        prompt += `- Max Cadence: ${formatCadenceWithUnit(workoutData.max_cadence, workoutType)}\n`
    }
  }

  // Performance indicators are primarily relevant for cardio workouts
  if (
    isCardio &&
    (workoutData.variability_index ||
      workoutData.efficiency_factor ||
      analysisFactsV2?.performanceSignals.decoupling.interpretable ||
      analysisFactsV2?.performanceSignals.decoupling.reason ||
      workoutData.power_hr_ratio ||
      (workoutData.lr_balance !== undefined && workoutData.lr_balance !== null))
  ) {
    prompt += '\n## Performance Indicators\n'
    if (workoutData.variability_index) {
      prompt += `- Variability Index (VI): ${formatMetric(workoutData.variability_index, 3)}\n`
    }
    if (workoutData.efficiency_factor) {
      prompt += `- Efficiency Factor (EF): ${formatMetric(workoutData.efficiency_factor, 2)} (Watts/HR - higher is better)\n`
    }
    if (analysisFactsV2?.performanceSignals.decoupling.interpretable) {
      if (analysisFactsV2.performanceSignals.decoupling.effective !== null) {
        prompt += `- Decoupling: ${formatMetric(analysisFactsV2.performanceSignals.decoupling.effective, 1)}%\n`
      }
    } else if (analysisFactsV2?.performanceSignals.decoupling.reason) {
      prompt += `- Decoupling Guardrail: ${analysisFactsV2.performanceSignals.decoupling.reason}\n`
    }
    if (workoutData.power_hr_ratio) {
      prompt += `- Power/HR Ratio: ${formatMetric(workoutData.power_hr_ratio, 2)}\n`
    }
    if (workoutData.lr_balance !== undefined && workoutData.lr_balance !== null) {
      const rightPct = workoutData.lr_balance
      const leftPct = 100 - rightPct
      const dominantSide = leftPct > rightPct ? 'Left' : rightPct > leftPct ? 'Right' : 'Neither'
      prompt += `- L/R Balance (Left%/Right%): ${formatMetric(leftPct, 1)}/${formatMetric(rightPct, 1)}\n`
      prompt += `  - Interpretation: first value is LEFT leg share, second is RIGHT leg share\n`
      prompt += `  - Dominant side in this workout: ${dominantSide}\n`
    }

    if (workoutData.fatigue_sensitivity) {
      prompt += `- Fatigue Sensitivity (Endurance Fade): ${formatMetric(workoutData.fatigue_sensitivity.decay, 1)}%\n`
    }

    if (workoutData.power_stability) {
      prompt += `- Power Stability (CoV): ${formatMetric(workoutData.power_stability.overallCoV, 1)}%\n`
    } else if (workoutData.pace_stability) {
      prompt += `- Pace Stability (CoV): ${formatMetric(workoutData.pace_stability.overallCoV, 1)}%\n`
    }

    if (workoutData.recovery_trend && workoutData.recovery_trend.length > 0) {
      const avgDrop =
        workoutData.recovery_trend.reduce((sum: number, r: any) => sum + (r.drop60s || 0), 0) /
        workoutData.recovery_trend.length
      prompt += `- Average HR Recovery (60s): ${formatMetric(avgDrop, 0)} bpm\n`
    }
  }

  prompt += '\n## Training Load\n'
  if (workoutData.tss) prompt += `- TSS: ${formatMetric(workoutData.tss, 0)}\n`
  if (workoutData.training_load)
    prompt += `- Training Load: ${formatMetric(workoutData.training_load, 1)}\n`
  if (workoutData.kilojoules)
    prompt += `- Kilojoules: ${formatMetric(workoutData.kilojoules, 1)} kJ\n`

  if (workoutData.ctl || workoutData.atl) {
    prompt += '\n## Fitness Status\n'
    if (workoutData.ctl) prompt += `- CTL (Fitness): ${formatMetric(workoutData.ctl, 1)}\n`
    if (workoutData.atl) prompt += `- ATL (Fatigue): ${formatMetric(workoutData.atl, 1)}\n`
    if (workoutData.ctl && workoutData.atl) {
      const tsb = workoutData.ctl - workoutData.atl
      prompt += `- TSB (Form): ${formatMetric(tsb, 1)}\n`
    }
  }

  if (workoutData.rpe || workoutData.feel) {
    prompt += '\n## Subjective Metrics\n'
    if (workoutData.rpe) prompt += `- RPE: ${workoutData.rpe}/10\n`
    // Feel is stored as 1-5, scale to 1-10 for AI
    // 1 (Weak) -> 2/10, 5 (Strong) -> 10/10
    if (workoutData.feel) prompt += `- Feel: ${workoutData.feel * 2}/10 (10=Strong, 2=Weak)\n`
  }

  if (workoutData.trainer !== undefined || workoutData.avg_temp !== undefined) {
    prompt += '\n## Environment\n'
    if (workoutData.trainer !== undefined)
      prompt += `- Indoor Trainer: ${workoutData.trainer ? 'Yes' : 'No'}\n`
    if (workoutData.avg_temp !== undefined)
      prompt += `- Avg Temperature: ${formatPromptTemperature(workoutData.avg_temp, userProfile?.temperatureUnits)}\n`
  }

  // Add Strength Exercises if available
  if (workoutData.exercises && workoutData.exercises.length > 0) {
    prompt += '\n## Strength Exercises\n'
    workoutData.exercises.forEach((ex: any, i: number) => {
      prompt += `### ${i + 1}. ${ex.name} (${ex.muscle_group || 'General'})\n`
      if (ex.notes) prompt += `Notes: ${ex.notes}\n`
      ex.sets.forEach((s: any, j: number) => {
        prompt += `- Set ${j + 1}: `
        if (s.type !== 'NORMAL') prompt += `[${s.type}] `

        let metricAdded = false
        if (s.weight) {
          prompt += `${formatPromptWeight(s.weight, userProfile?.weightUnits)} x ${s.reps}`
          metricAdded = true
        } else if (s.reps) {
          prompt += `${s.reps} reps`
          metricAdded = true
        }

        if (s.distance) {
          if (metricAdded) prompt += `, `
          // Strength-exercise set distances (sled push, farmer's carry, etc.) are short
          // distances, so use the same meters<->feet conversion as elevation rather than
          // km/mi (which would round to an unreadable "0.02 mi").
          prompt += formatPromptElevation(s.distance, userProfile?.distanceUnits)
          metricAdded = true
        }

        if (s.duration) {
          if (metricAdded) prompt += `, `
          prompt += `${s.duration}s`
        }

        if (s.rpe) prompt += ` @ RPE ${s.rpe}`
        prompt += '\n'
      })
      prompt += '\n'
    })
  }

  // Add distance-split pacing analysis if available.
  //
  // These rows are the provider's automatic per-distance splits, not laps the
  // athlete triggered and not the session's work intervals; the section used to
  // be headed "Lap Pacing Analysis", which invited the model to talk about
  // "laps" that never existed (CW-389).
  if (workoutData.lap_splits && workoutData.lap_splits.length > 0) {
    const splitVerdict = resolveSplitPacingVerdictApplicability(analysisFactsV2)

    prompt += '\n## Distance Split Pacing\n'
    prompt += `Automatic per-distance splits (1 km / 1 mi) recorded for this session. These are not laps and not the workout's work intervals:\n\n`

    workoutData.lap_splits.forEach((split: any) => {
      prompt += `**Split ${split.lap}**: `
      prompt += `${formatPromptDistance(split.distance_m, userProfile?.distanceUnits)} in ${Math.floor(split.time_s / 60)}:${(split.time_s % 60).toString().padStart(2, '0')} `

      const paceSecondsPerKm =
        split.distance_m > 0 ? split.time_s / (split.distance_m / 1000) : null
      prompt += `(${formatPromptPace(paceSecondsPerKm, userProfile?.distanceUnits)} pace)`
      if (split.avg_hr) prompt += `, HR ${Math.round(split.avg_hr)} bpm`
      if (split.avg_speed_ms) prompt += `, ${formatMetric(split.avg_speed_ms, 2)} m/s`
      prompt += '\n'
    })

    if (workoutData.pace_variability_seconds) {
      // The raw dispersion is a measurement and may stay; the grade band is a
      // verdict and only applies to a session that was meant to hold one pace.
      prompt += `\n**Split Pace Consistency**: ${formatMetric(workoutData.pace_variability_seconds, 1)} seconds standard deviation\n`
      if (splitVerdict.applicable) {
        prompt += `- Lower is better (more consistent pacing)\n`
        prompt += `- <10s = Excellent consistency, 10-20s = Good, >20s = Variable pacing\n`
      } else {
        prompt += `- Consistency grading omitted: ${splitVerdict.reason}. Do not read this number as a pacing grade.\n`
      }
    }

    // Add first/second half comparison
    if (workoutData.lap_splits.length >= 2 && splitVerdict.applicable) {
      const halfwayIndex = Math.floor(workoutData.lap_splits.length / 2)
      const firstHalf = workoutData.lap_splits.slice(0, halfwayIndex)
      const secondHalf = workoutData.lap_splits.slice(halfwayIndex)

      const firstHalfAvgPace =
        firstHalf.reduce((sum: number, s: any) => sum + s.time_s / (s.distance_m / 1000), 0) /
        firstHalf.length
      const secondHalfAvgPace =
        secondHalf.reduce((sum: number, s: any) => sum + s.time_s / (s.distance_m / 1000), 0) /
        secondHalf.length

      const splitDiff = secondHalfAvgPace - firstHalfAvgPace
      const splitType =
        splitDiff > 10
          ? 'Positive Split (slowed down)'
          : splitDiff < -10
            ? 'Negative Split (sped up)'
            : 'Even Split'

      prompt += `\n**Split Strategy**: ${splitType}\n`
      prompt += `- First half avg: ${formatPromptPace(firstHalfAvgPace, userProfile?.distanceUnits)}\n`
      prompt += `- Second half avg: ${formatPromptPace(secondHalfAvgPace, userProfile?.distanceUnits)}\n`
      prompt += `- Difference: ${Math.abs(splitDiff).toFixed(1)}s ${splitDiff > 0 ? 'slower' : 'faster'} in second half\n`
    } else if (workoutData.lap_splits.length >= 2) {
      // Stated rather than left as a silent gap: "do not infer meaning from
      // omitted facts" is already a rule in the v2 facts contract, so a missing
      // section has to say why it is missing.
      prompt += `\nSplit-strategy verdict omitted: ${splitVerdict.reason}.\n`
    }

    prompt += '\n'
  }

  // Work-only and recovery-only aggregates (CW-381).
  //
  // Printed BEFORE the per-interval table and before the model is asked for
  // anything, because these are the figures every interval-level claim has to
  // be built from. The sections above this one are all session-wide -- a
  // session mean over an intervalled workout is an average of warmup, reps,
  // recoveries and cooldown, so quoting it as "your threshold cadence" or
  // "your interval power" is not an approximation, it is a different number
  // about a different thing (the 162-vs-177 spm inversion this ticket exists
  // for).
  const workIntervalSummary = workoutData.work_interval_summary
  const recoveryIntervalSummary = workoutData.recovery_interval_summary
  if (workIntervalSummary || recoveryIntervalSummary) {
    const summaryOptions = {
      workoutType,
      isCadenceRelevant,
      paceCapable: isRunningCadenceFamily(workoutType),
      distanceUnits: userProfile?.distanceUnits
    }

    prompt += '\n## Work vs Recovery Aggregates\n'
    prompt +=
      'Duration-weighted averages over the resolved WORK and RECOVERY segments of the Interval Breakdown below (warmup and cooldown excluded). Any claim about interval, rep, or threshold execution MUST quote these figures, never the session averages above.\n'

    if (workIntervalSummary) {
      prompt += '\n### Work Intervals\n'
      prompt += formatIntervalGroupSummary(workIntervalSummary, summaryOptions)
    } else {
      prompt +=
        '\n### Work Intervals\n- None: this session has no segments resolved as work, so do not make rep-level or interval-level claims about it.\n'
    }

    if (recoveryIntervalSummary) {
      prompt += '\n### Recovery Between Work\n'
      prompt += formatIntervalGroupSummary(recoveryIntervalSummary, summaryOptions)
    } else {
      prompt +=
        '\n### Recovery Between Work\n- None: no recovery segments between work, so do not characterise recovery quality.\n'
    }
  }

  // Add interval analysis if available.
  //
  // These rows ARE the arbitrated segmentation -- the same `ActualInterval[]`
  // the v2 facts block above is computed over, resolved once in
  // `buildWorkoutAnalysisData` (CW-391). The renderer only labels; it never
  // re-derives boundaries and never re-scales a value.
  if (workoutData.intervals && workoutData.intervals.length > 0) {
    const segmentationSource = describeIntervalSegmentationSource(
      workoutData.interval_segmentation_source
    )
    // Pace is the leading metric for runs and noise for power-primary rides and
    // indoor/strength work. Gated on the exported running-family predicate
    // rather than on a second copy of the facts module's family table: narrower
    // than `formatActualIntervalsForPrompt`'s rule, but exact, and runs are the
    // family where a per-rep pace is what the athlete is actually judged on.
    const paceCapable = isRunningCadenceFamily(workoutType)

    prompt += '\n## Interval Breakdown\n'
    if (segmentationSource) {
      prompt += `Segmentation source: ${segmentationSource}. These are the same segments the Calculated Workout Facts v2 block above is computed over -- quote reps from this table only.\n`
    }
    workoutData.intervals.forEach((interval: any, index: number) => {
      // Headed by the RESOLVED type, not the provider's lap label: the label
      // only exists for provider laps, it is the untrusted field CW-376 stopped
      // believing, and it would have read "Rest 1" over a segment the engine
      // classified as work.
      prompt += `\n### Interval ${index + 1}: ${interval.type || 'Unnamed'}\n`
      if (interval.duration_s)
        prompt += `- Duration: ${formatIntervalDuration(interval.duration_s)}\n`
      if (interval.avg_power) prompt += `- Avg Power: ${Math.round(interval.avg_power)}W\n`
      if (interval.intensity)
        prompt += `- Intensity: ${formatIntervalIntensity(Number(interval.intensity))}\n`
      if (interval.avg_hr) prompt += `- Avg HR: ${Math.round(interval.avg_hr)} bpm\n`
      // Values are already canonical (buildWorkoutAnalysisData normalised them);
      // this only attaches the unit the workout family uses, so a run no longer
      // reads "177 rpm" (CW-387).
      if (interval.avg_cadence)
        prompt += `- Avg Cadence: ${formatCadenceWithUnit(interval.avg_cadence, workoutType)}\n`
      // `avg_speed_ms` is m/s; 1000 / (m/s) is seconds per km, which
      // `formatPromptPace` then puts in the athlete's distance units.
      if (paceCapable && interval.avg_speed_ms > 0)
        prompt += `- Avg Pace: ${formatPromptPace(1000 / interval.avg_speed_ms, userProfile?.distanceUnits)}\n`
      if (interval.confidence != null)
        prompt += `- Detection Confidence: ${Math.round(interval.confidence * 100)}%\n`
      if (interval.ambiguity_note) prompt += `- Note: ${interval.ambiguity_note}\n`
    })
  }

  if (workoutData.description) {
    prompt += `\n## Workout Description\n${workoutData.description}\n`
  }

  if (workoutData.notes) {
    prompt += `\n## Athlete Notes\n${workoutData.notes}\n`
  }

  // Add zone distribution if available
  if (workoutData.zone_distribution) {
    const zoneType = workoutData.zone_distribution.type === 'hr' ? 'Heart Rate' : 'Power'
    prompt += `\n## ${zoneType} Zone Distribution\n`
    prompt += `Time spent in each training zone:\n\n`

    for (const zone of workoutData.zone_distribution.zones) {
      if (zone.time_seconds > 0) {
        prompt += `**${zone.name}**: ${zone.time_minutes} minutes (${zone.percentage}% of workout)\n`
      }
    }

    prompt += `\nUse this distribution to assess training stimulus and whether the athlete worked in the intended zones for this workout type.\n`
  }

  prompt += `

## Analysis Request

You are a **${persona}** ${coachType} analyzing this workout. Adopt this persona fully in your analysis.

${getAnalysisSectionsGuidance(workoutType, isCardio, isStrength)}

6. **Recommendations**: Provide 2-4 specific, actionable recommendations with:
   - Clear, friendly title
   - Description (2-3 sentences) consistent with your persona
   - Priority level (high/medium/low)

7. **Strengths & Weaknesses**:
   - List 2-4 key strengths (short phrases or single sentences)
   - List 2-4 areas for improvement (short phrases or single sentences)

8. **Performance Scores** (1-10 scale for tracking progress over time):
   - **Overall**: Holistic assessment of workout quality (consider all factors)
   - **Technical**: Form, technique, efficiency (e.g., cadence, power smoothness, L/R balance)
   - **Effort**: Was the effort level appropriate for the workout goals? (RPE vs planned intensity)
   - **Pacing**: How well was pacing managed? (variability, surge control, discipline)
   - **Execution**: How well was the workout plan/structure executed? (interval targets, rest periods)
   
   Scoring Guidelines:
   - 9-10: Exceptional, elite-level performance
   - 7-8: Strong, solid execution with minor areas to improve
   - 5-6: Adequate, met basic requirements but room for improvement
   - 3-4: Needs work, several areas requiring attention
   - 1-2: Poor execution, significant issues to address

IMPORTANT:
- Each analysis_point must be a separate, concise item in the array
- Maintain your **${persona}** persona throughout
- Be specific with numbers
- Focus on actionable advice
- Tailor your analysis to the workout type (${workoutType}) - ignore metrics that don't apply
- Scores should be realistic and track progress over time - don't inflate scores
- Follow these guardrails strictly:
${buildAnalysisGuardrailInstructions(workoutType, analysisFactsV2)}
${buildAnalysisRequestMetricRules(metricPriorityContext)
  .map((rule) => `- ${rule}`)
  .join('\n')}`

  // Restated at the point of use, next to the other hard rules: the section
  // header alone lost to the session averages printed higher up, which is how
  // a session mean ended up being quoted as an interval metric (CW-381).
  if (workIntervalSummary || recoveryIntervalSummary) {
    prompt += `
- Every claim about interval, rep, or threshold execution must quote the figures from "## Work vs Recovery Aggregates" (or a specific row of "## Interval Breakdown"). The session averages under Power Metrics, Heart Rate & Cadence and Pace & Speed cover the whole file including warmup, recoveries and cooldown, so they must never be described as interval, rep or threshold values.
- When a work-only figure and the session average disagree, that gap is the shape of the session, not an error to reconcile; judge the intervals on the work-only figure.`
  }

  return prompt
}
