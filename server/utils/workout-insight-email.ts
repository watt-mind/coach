import { workoutStreamRepository } from './repositories/workoutStreamRepository'
import { prisma } from './db'
import { queueEmail } from './email-service'
import { formatUserDate, getStartOfDaysAgoUTC } from './date'
import { sportSettingsRepository } from './repositories/sportSettingsRepository'
import { buildWorkoutStreamInsights } from './workout-email-stream-insights'
import { isWorkoutEligibleForAutomaticInsights } from './automatic-workout-insights'

const WORKOUT_RECEIVED_LOOKBACK_HOURS = 24
const WORKOUT_RECEIVED_MIN_DURATION_SEC = 10 * 60
const WORKOUT_RECEIVED_COOLDOWN_MINUTES = 15
const COPY_VARIANT_LOOKBACK = 20
const WORKOUT_RECEIVED_ACTIVE_STATUSES = [
  'QUEUED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'OPENED',
  'CLICKED'
] as const
const verboseWorkoutInsightEmailLogs = process.env.CW_VERBOSE_WORKOUT_EMAIL_LOGS === '1'

const COPY_SLOTS = ['heroTitle', 'introLine', 'ctaLabel', 'nextStepMessage', 'subject'] as const
type CopySlot = (typeof COPY_SLOTS)[number]

type WorkoutReceivedCopyVariantIds = Record<CopySlot, string>
type CopyVariant = {
  id: string
  text: string
}

type TriggerType = 'on-workout-received' | 'on-analysis-ready' | 'on-adherence-ready'

type QueueWorkoutInsightEmailOptions = {
  workoutId: string
  triggerType: TriggerType
  analysisSummary?: string
  recommendationHighlights?: string[]
  adherenceSummary?: string
  adherenceScore?: number
  overallScore?: number
}

function logWorkoutInsightSkip(context: Record<string, unknown>) {
  if (verboseWorkoutInsightEmailLogs) {
    console.info('[WorkoutInsightEmail] Skipped', context)
  }
}

function roundDateDownToFiveMinutes(date: Date) {
  const bucketMs = 5 * 60 * 1000
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs)
}

function roundDistanceKmToTenth(distanceKm?: number) {
  if (typeof distanceKm !== 'number' || distanceKm <= 0) return null
  return Math.round(distanceKm * 10) / 10
}

export function buildWorkoutReceivedActivityFingerprint(input: {
  userId: string
  workoutType?: string | null
  workoutDate: Date
  durationSec: number
  distanceKm?: number
}) {
  const normalizedWorkoutType = (input.workoutType || 'unknown').trim().toLowerCase()
  const roundedStart = roundDateDownToFiveMinutes(input.workoutDate).toISOString()
  const roundedDurationMinutes = Math.max(1, Math.round(input.durationSec / 60))
  const roundedDistance = roundDistanceKmToTenth(input.distanceKm)

  return [
    input.userId,
    normalizedWorkoutType,
    roundedStart,
    `dur:${roundedDurationMinutes}`,
    `dist:${roundedDistance === null ? 'na' : roundedDistance}`
  ].join('|')
}

export function evaluateWorkoutReceivedEligibility(input: {
  durationSec: number
  workoutDate: Date
  now?: Date
}) {
  if (input.durationSec < WORKOUT_RECEIVED_MIN_DURATION_SEC) {
    return { eligible: false as const, reason: 'duration_below_10_minutes' as const }
  }

  const now = input.now || new Date()
  const oldestAllowedDate = new Date(
    now.getTime() - WORKOUT_RECEIVED_LOOKBACK_HOURS * 60 * 60 * 1000
  )
  if (input.workoutDate < oldestAllowedDate) {
    return { eligible: false as const, reason: 'workout_older_than_24_hours' as const }
  }

  return { eligible: true as const }
}

function inferSportCategory(workoutType?: string | null): 'run' | 'ride' | 'other' {
  if (!workoutType) return 'other'
  const normalized = workoutType.toLowerCase()
  if (normalized.includes('run') || normalized.includes('jog') || normalized.includes('trail'))
    return 'run'
  if (
    normalized.includes('ride') ||
    normalized.includes('cycle') ||
    normalized.includes('bike') ||
    normalized.includes('cycling')
  )
    return 'ride'
  return 'other'
}

function buildQuickTake(options: {
  sportCategory: 'run' | 'ride' | 'other'
  tss?: number
  averageCadence?: number
  averageHr?: number
  averageWatts?: number
  maxHr?: number
  ftp?: number
  lthr?: number
  userMaxHr?: number
}) {
  const {
    sportCategory,
    tss,
    averageCadence,
    averageHr,
    averageWatts,
    maxHr,
    ftp,
    lthr,
    userMaxHr
  } = options

  let quickTakeLabel = 'Session logged'
  let quickTakeBody =
    'Nice work getting this session in. Consistency is what drives long-term gains.'

  if (typeof tss === 'number' && tss >= 100) {
    quickTakeLabel = 'Big Engine'
    quickTakeBody =
      'This was a high-load session that can move fitness forward. Prioritize recovery to absorb it.'
  } else if (typeof tss === 'number' && tss >= 60) {
    quickTakeLabel = 'Productive'
    quickTakeBody =
      'This load is in a productive range and supports fitness gains without excessive strain.'
  } else if (typeof tss === 'number' && tss > 0) {
    quickTakeLabel = 'Supportive'
    quickTakeBody = 'This was a supportive session that reinforces aerobic base and momentum.'
  }

  if (
    sportCategory === 'run' &&
    typeof averageCadence === 'number' &&
    averageCadence >= 165 &&
    averageCadence <= 185
  ) {
    quickTakeBody +=
      ' Your run cadence was in an efficient range, which supports smooth turnover and economy.'
  }

  if (sportCategory === 'ride' && typeof averageCadence === 'number' && averageCadence >= 85) {
    quickTakeBody +=
      ' Your ride cadence stayed in a sustainable range, helping steady aerobic output.'
  }

  // Efficiency signal: High relative power for low relative HR
  const relPower =
    typeof averageWatts === 'number' && typeof ftp === 'number' && ftp > 0
      ? averageWatts / ftp
      : null
  const relHr =
    typeof averageHr === 'number' && typeof lthr === 'number' && lthr > 0 ? averageHr / lthr : null

  const efficiencyMessage =
    relPower && relHr && relPower >= 0.7 && relHr <= 0.85
      ? sportCategory === 'ride'
        ? 'Efficiency signal: you held strong bike power while keeping heart rate controlled.'
        : sportCategory === 'run'
          ? 'Efficiency signal: you sustained strong run power with controlled heart rate.'
          : 'Efficiency signal: you produced strong power while keeping heart rate controlled.'
      : undefined

  // Intensity signal: Touching high % of max HR or LTHR
  const maxRelHr =
    typeof maxHr === 'number' && typeof userMaxHr === 'number' && userMaxHr > 0
      ? maxHr / userMaxHr
      : null
  const maxRelLthr =
    typeof maxHr === 'number' && typeof lthr === 'number' && lthr > 0 ? maxHr / lthr : null

  const recoveryMessage =
    (maxRelHr && maxRelHr >= 0.95) || (maxRelLthr && maxRelLthr >= 1.05)
      ? sportCategory === 'run'
        ? 'Intensity signal: you touched the top end on this run. Prioritize recovery tonight.'
        : sportCategory === 'ride'
          ? 'Intensity signal: you pushed near your ceiling on the bike. Prioritize recovery tonight.'
          : 'Intensity signal: you touched your top end today. Prioritize recovery tonight.'
      : undefined

  const cadenceUnit = sportCategory === 'ride' ? 'rpm' : 'spm'

  return { quickTakeLabel, quickTakeBody, efficiencyMessage, recoveryMessage, cadenceUnit }
}

const METERS_PER_MILE = 1609.344

export function formatEmailDistance(
  distanceMeters?: number | null,
  distanceUnits?: string | null
): { value: number; unitLabel: string; label: string } | null {
  if (!distanceMeters || distanceMeters <= 0) return null

  const isMiles = distanceUnits === 'Miles'
  const value = isMiles
    ? Math.round((distanceMeters / METERS_PER_MILE) * 10) / 10
    : Math.round((distanceMeters / 1000) * 10) / 10
  const unitLabel = isMiles ? 'mi' : 'km'

  return { value, unitLabel, label: `${value.toFixed(1)} ${unitLabel}` }
}

function getFirstName(name?: string | null) {
  if (!name) return 'Athlete'
  return name.trim().split(/\s+/)[0] || 'Athlete'
}

export function normalizeSubjectSpacing(subject: string) {
  if (!subject) return subject

  let normalized = ''
  for (let i = 0; i < subject.length; i += 1) {
    const current = subject[i] as string
    const next = subject[i + 1]

    normalized += current

    if (!next) continue
    if (!/[,.!?;:]/.test(current)) continue
    if (next === ' ') continue

    // Keep numeric punctuation untouched (e.g., 66.7, 1,000).
    const beforeToken = subject.slice(0, i).match(/([A-Za-z0-9]+)$/)?.[1] || ''
    const afterToken = subject.slice(i + 1).match(/^([A-Za-z0-9]+)/)?.[1] || ''
    const isNumericPunctuation =
      (current === '.' || current === ',') && /^\d+$/.test(beforeToken) && /^\d+$/.test(afterToken)
    if (isNumericPunctuation) continue

    normalized += ' '
  }

  return normalized.replace(/\s{2,}/g, ' ').trim()
}

function hashString(input: string) {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 2147483647
  }
  return Math.abs(hash)
}

function pickVariant<T>(key: string, variants: T[]) {
  if (!variants.length) {
    throw new Error('pickVariant requires at least one variant')
  }
  return variants[hashString(key) % variants.length] as T
}

function pickCopyVariant(options: {
  key: string
  slot: CopySlot
  variants: CopyVariant[]
  recentVariantIds?: Partial<Record<CopySlot, Set<string>>>
}) {
  const { key, slot, variants, recentVariantIds } = options
  const recentlyUsed = recentVariantIds?.[slot] || new Set<string>()
  const available = variants.filter((variant) => !recentlyUsed.has(variant.id))
  const pool = available.length > 0 ? available : variants
  return pickVariant(key, pool)
}

function parseRecentCopyVariantIds(rows: Array<{ metadata: unknown }>) {
  const recentBySlot: Partial<Record<CopySlot, Set<string>>> = {}
  for (const slot of COPY_SLOTS) {
    recentBySlot[slot] = new Set<string>()
  }

  for (const row of rows) {
    const metadata = row.metadata as Record<string, unknown> | null
    const ids = metadata?.copyVariantIds as Partial<Record<CopySlot, unknown>> | undefined
    if (!ids || typeof ids !== 'object') continue

    for (const slot of COPY_SLOTS) {
      const value = ids[slot]
      if (typeof value === 'string' && value) {
        recentBySlot[slot]?.add(value)
      }
    }
  }

  return recentBySlot
}

function buildLoadContext(tss7d?: number, weeklyTssBaseline28d?: number) {
  if (
    typeof tss7d !== 'number' ||
    typeof weeklyTssBaseline28d !== 'number' ||
    weeklyTssBaseline28d <= 0
  ) {
    return {
      loadContextLabel: 'Load Context',
      loadContextBody:
        'Keep stacking consistent sessions to establish your personal load baseline.',
      loadDeltaPct: undefined as number | undefined
    }
  }

  const loadDeltaPct = Math.round(((tss7d - weeklyTssBaseline28d) / weeklyTssBaseline28d) * 100)

  if (loadDeltaPct >= 20) {
    return {
      loadContextLabel: 'Aggressive Load Week',
      loadContextBody:
        'Your recent load is well above your 4-week baseline. Great for adaptation when recovery is handled well.',
      loadDeltaPct
    }
  }

  if (loadDeltaPct >= 6) {
    return {
      loadContextLabel: 'Progressive Week',
      loadContextBody:
        'You are training above your recent baseline in a productive range that supports progression.',
      loadDeltaPct
    }
  }

  if (loadDeltaPct >= -10) {
    return {
      loadContextLabel: 'Balanced Week',
      loadContextBody:
        'Your recent load is close to baseline, which is strong for maintaining momentum and consistency.',
      loadDeltaPct
    }
  }

  return {
    loadContextLabel: 'Recovery-Leaning Week',
    loadContextBody:
      'Your recent load is below baseline, which can help consolidate gains before the next build.',
    loadDeltaPct
  }
}

function buildSportLens(options: {
  sportCategory: 'run' | 'ride' | 'other'
  averageCadence?: number
  averageHr?: number
  averageWatts?: number
  sportFtp?: number
  sportLthr?: number
  sportMaxHr?: number
}) {
  const {
    sportCategory,
    averageCadence,
    averageHr,
    averageWatts,
    sportFtp,
    sportLthr,
    sportMaxHr
  } = options

  if (sportCategory === 'ride') {
    if (typeof averageWatts === 'number' && typeof sportFtp === 'number' && sportFtp > 0) {
      const ftpPct = Math.round((averageWatts / sportFtp) * 100)
      if (ftpPct < 75) {
        return {
          sportLensLabel: 'Ride Lens',
          sportLensBody: `Average power sat around ${ftpPct}% of FTP, indicating mostly endurance-zone work.`
        }
      }
      if (ftpPct <= 89) {
        return {
          sportLensLabel: 'Ride Lens',
          sportLensBody: `Average power sat around ${ftpPct}% of FTP, a strong tempo-oriented stimulus.`
        }
      }
      if (ftpPct <= 105) {
        return {
          sportLensLabel: 'Ride Lens',
          sportLensBody: `Average power sat around ${ftpPct}% of FTP, right in threshold-development territory.`
        }
      }
      return {
        sportLensLabel: 'Ride Lens',
        sportLensBody: `Average power sat around ${ftpPct}% of FTP, signaling a high-intensity effort.`
      }
    }

    if (typeof averageCadence === 'number') {
      if (averageCadence >= 90) {
        return {
          sportLensLabel: 'Ride Lens',
          sportLensBody:
            'Cadence was high and fluid, which is often helpful for aerobic sustainability and leg freshness.'
        }
      }
      if (averageCadence <= 75) {
        return {
          sportLensLabel: 'Ride Lens',
          sportLensBody:
            'Cadence trended lower, which can build muscular endurance, especially on climbs or torque-focused work.'
        }
      }
    }
  }

  if (sportCategory === 'run') {
    if (typeof averageHr === 'number' && typeof sportLthr === 'number' && sportLthr > 0) {
      const lthrPct = Math.round((averageHr / sportLthr) * 100)
      if (lthrPct < 85) {
        return {
          sportLensLabel: 'Run Lens',
          sportLensBody: `Average HR was about ${lthrPct}% of LTHR, aligning with aerobic-base development.`
        }
      }
      if (lthrPct <= 95) {
        return {
          sportLensLabel: 'Run Lens',
          sportLensBody: `Average HR was about ${lthrPct}% of LTHR, a steady effort that builds durable race fitness.`
        }
      }
      return {
        sportLensLabel: 'Run Lens',
        sportLensBody: `Average HR was about ${lthrPct}% of LTHR, indicating threshold-oriented stress.`
      }
    }

    if (typeof averageCadence === 'number') {
      if (averageCadence >= 165 && averageCadence <= 185) {
        return {
          sportLensLabel: 'Run Lens',
          sportLensBody:
            'Cadence landed in a generally efficient range, which supports smoother turnover and economy.'
        }
      }
      if (averageCadence < 160) {
        return {
          sportLensLabel: 'Run Lens',
          sportLensBody:
            'Cadence was on the lower side; adding gentle turnover drills can help improve running economy.'
        }
      }
    }
  }

  if (typeof averageHr === 'number' && typeof sportMaxHr === 'number' && sportMaxHr > 0) {
    const maxHrPct = Math.round((averageHr / sportMaxHr) * 100)
    return {
      sportLensLabel: 'Session Lens',
      sportLensBody: `Average HR was about ${maxHrPct}% of max HR, giving useful context for session intensity.`
    }
  }

  return {
    sportLensLabel: 'Session Lens',
    sportLensBody:
      'This session adds another meaningful data point to your trendline and helps sharpen your training signal.'
  }
}

export function buildInterestingCopy(options: {
  workoutId: string
  sportCategory: 'run' | 'ride' | 'other'
  workoutTitle: string
  firstName: string
  distanceLabel?: string | null
  tss?: number
  loadDeltaPct?: number
  workoutsLast7Days?: number
  recentVariantIds?: Partial<Record<CopySlot, Set<string>>>
}) {
  const {
    workoutId,
    sportCategory,
    workoutTitle,
    firstName,
    distanceLabel,
    tss,
    loadDeltaPct,
    workoutsLast7Days,
    recentVariantIds
  } = options
  const key = `${workoutId}:${sportCategory}`

  let heroVariant = pickCopyVariant({
    key,
    slot: 'heroTitle',
    recentVariantIds,
    variants: [
      { id: 'hero_default_1', text: 'Workout synced and momentum building.' },
      { id: 'hero_default_2', text: 'Session logged. Progress in motion.' },
      { id: 'hero_default_3', text: 'Another strong brick in your training wall.' }
    ]
  })

  if (typeof workoutsLast7Days === 'number' && workoutsLast7Days >= 4) {
    heroVariant = pickCopyVariant({
      key: `${key}:hero-consistency`,
      slot: 'heroTitle',
      recentVariantIds,
      variants: [
        {
          id: 'hero_consistency_1',
          text: `${workoutsLast7Days} sessions in 7 days. Your momentum is building.`
        },
        {
          id: 'hero_consistency_2',
          text: 'Consistency unlocked. Another solid brick in the wall.'
        },
        { id: 'hero_consistency_3', text: 'Showing up is half the battle. Session captured.' }
      ]
    })
  } else if (typeof tss === 'number' && tss >= 100) {
    heroVariant = pickCopyVariant({
      key: `${key}:hero-load`,
      slot: 'heroTitle',
      recentVariantIds,
      variants: [
        { id: 'hero_load_1', text: `Big Engine session logged: ${Math.round(tss)} TSS.` },
        { id: 'hero_load_2', text: 'Solid effort. Productive stress mapped.' },
        { id: 'hero_load_3', text: 'Massive shift today. Recovery starts now.' }
      ]
    })
  } else if (distanceLabel) {
    heroVariant = pickCopyVariant({
      key: `${key}:hero-distance`,
      slot: 'heroTitle',
      recentVariantIds,
      variants: [
        { id: 'hero_distance_1', text: `Great shift. ${distanceLabel} in the books.` },
        { id: 'hero_distance_2', text: `Session secured. ${distanceLabel} completed.` },
        { id: 'hero_distance_3', text: `That's ${distanceLabel} added to your timeline.` }
      ]
    })
  } else if (typeof loadDeltaPct === 'number' && loadDeltaPct > 10) {
    heroVariant = pickCopyVariant({
      key: `${key}:hero-delta`,
      slot: 'heroTitle',
      recentVariantIds,
      variants: [
        {
          id: 'hero_delta_1',
          text: `Solid effort. Pushing ${loadDeltaPct}% above your recent baseline.`
        },
        { id: 'hero_delta_2', text: 'Progressive load secured. Pushing the baseline up.' },
        { id: 'hero_delta_3', text: 'Productive stimulus logged. Great shift.' }
      ]
    })
  }

  const introVariant = pickCopyVariant({
    key: `${key}:intro`,
    slot: 'introLine',
    recentVariantIds,
    variants: [
      {
        id: 'intro_1',
        text: `Solid work today. ${workoutTitle} is now on your timeline and ready to review.`
      },
      {
        id: 'intro_2',
        text: `Nice execution. ${workoutTitle} has been captured and added to your training history.`
      },
      {
        id: 'intro_3',
        text: `Strong session. ${workoutTitle} is in, and your trends just got sharper.`
      }
    ]
  })

  const ctaVariant = pickCopyVariant({
    key: `${key}:cta`,
    slot: 'ctaLabel',
    recentVariantIds,
    variants: [
      { id: 'cta_1', text: 'View Full Analysis & Splits' },
      { id: 'cta_2', text: 'Open Workout Details' },
      { id: 'cta_3', text: 'Review This Session' }
    ]
  })

  const nextVariant = pickCopyVariant({
    key: `${key}:next`,
    slot: 'nextStepMessage',
    recentVariantIds,
    variants: [
      { id: 'next_1', text: 'See how this session impacted your Fitness vs Fatigue trend.' },
      {
        id: 'next_2',
        text: 'Open your detail page to inspect execution patterns while the session is fresh.'
      },
      {
        id: 'next_3',
        text: 'Review your charts and timeline now to lock in learnings for the next workout.'
      }
    ]
  })

  const subjectVariant = distanceLabel
    ? pickCopyVariant({
        key: `${key}:subject-distance`,
        slot: 'subject',
        recentVariantIds,
        variants: [
          {
            id: 'subject_distance_1',
            text: `Great shift, ${firstName}. ${distanceLabel} in the books.`
          },
          {
            id: 'subject_distance_2',
            text: `${firstName}, ${distanceLabel} logged. Your trendline just moved.`
          },
          {
            id: 'subject_distance_3',
            text: `${distanceLabel} complete, ${firstName}. Session synced and ready.`
          }
        ]
      })
    : pickCopyVariant({
        key: `${key}:subject-title`,
        slot: 'subject',
        recentVariantIds,
        variants: [
          {
            id: 'subject_title_1',
            text: `Great shift, ${firstName}. ${workoutTitle} is in the books.`
          },
          {
            id: 'subject_title_2',
            text: `${firstName}, ${workoutTitle} is synced and ready to review.`
          },
          {
            id: 'subject_title_3',
            text: `${workoutTitle} logged, ${firstName}. Momentum stays on.`
          }
        ]
      })

  const subject = normalizeSubjectSpacing(subjectVariant.text)

  const previewLine = `${workoutTitle} is synced. Open for insights, load context, and sport-specific cues.`

  const copyVariantIds: WorkoutReceivedCopyVariantIds = {
    heroTitle: heroVariant.id,
    introLine: introVariant.id,
    ctaLabel: ctaVariant.id,
    nextStepMessage: nextVariant.id,
    subject: subjectVariant.id
  }

  return {
    heroTitle: heroVariant.text,
    introLine: introVariant.text,
    ctaLabel: ctaVariant.text,
    nextStepMessage: nextVariant.text,
    subject,
    previewLine,
    copyVariantIds
  }
}

export async function queueWorkoutInsightEmail(options: QueueWorkoutInsightEmailOptions) {
  const { workoutId, triggerType } = options
  const logContext = { workoutId, triggerType }

  if (process.env.CW_DISABLE_EMAILS === '1') {
    logWorkoutInsightSkip({
      ...logContext,
      reason: 'emails_disabled_by_environment'
    })
    return { queued: false, reason: 'emails_disabled_by_environment' }
  }

  const workoutRecord = await prisma.workout.findUnique({
    where: { id: workoutId },
    select: {
      id: true,
      userId: true,
      title: true,
      date: true,
      type: true,
      durationSec: true,
      elapsedTimeSec: true,
      distanceMeters: true,
      elevationGain: true,
      averageCadence: true,
      averageHr: true,
      maxHr: true,
      averageWatts: true,
      normalizedPower: true,
      tss: true,
      kilojoules: true,
      calories: true,
      overallScore: true,
      decoupling: true,
      wPrime: true,
      wBalDepletion: true
    }
  })

  if (!workoutRecord) {
    logWorkoutInsightSkip({ ...logContext, reason: 'workout_not_found' })
    return { queued: false, reason: 'workout_not_found' }
  }

  const streamMap = await workoutStreamRepository.findManyByWorkoutIds([workoutRecord.id], {
    fields: ['cadence', 'distance', 'grade', 'moving', 'surges']
  })
  const workout = { ...workoutRecord, streams: streamMap.get(workoutRecord.id) ?? null }

  const [user, pref] = await Promise.all([
    prisma.user.findUnique({
      where: { id: workout.userId },
      select: {
        id: true,
        name: true,
        timezone: true,
        aiAutoAnalyzeWorkouts: true,
        distanceUnits: true
      }
    }),
    prisma.emailPreference.findUnique({
      where: {
        userId_channel: {
          userId: workout.userId,
          channel: 'EMAIL'
        }
      }
    })
  ])

  if (!user) {
    logWorkoutInsightSkip({
      ...logContext,
      userId: workout.userId,
      reason: 'user_not_found'
    })
    return { queued: false, reason: 'user_not_found' }
  }

  if (pref?.globalUnsubscribe || pref?.workoutAnalysis === false) {
    logWorkoutInsightSkip({
      ...logContext,
      userId: workout.userId,
      hasPreferenceRow: Boolean(pref),
      globalUnsubscribe: Boolean(pref?.globalUnsubscribe),
      workoutAnalysisEnabled: pref?.workoutAnalysis ?? null,
      reason: 'email_preference_disabled'
    })
    return { queued: false, reason: 'email_preference_disabled' }
  }

  if (!isWorkoutEligibleForAutomaticInsights(workout.type)) {
    logWorkoutInsightSkip({
      ...logContext,
      userId: workout.userId,
      workoutType: workout.type,
      reason: 'unsupported_workout_type'
    })
    return { queued: false, reason: 'unsupported_workout_type' }
  }

  const timezone = user.timezone || 'UTC'
  const baseUrl = process.env.NUXT_PUBLIC_SITE_URL || 'https://coachwatts.com'
  const distanceKm =
    workout.distanceMeters && workout.distanceMeters > 0
      ? Math.round((workout.distanceMeters / 1000) * 10) / 10
      : undefined
  const workoutReceivedFingerprint = buildWorkoutReceivedActivityFingerprint({
    userId: workout.userId,
    workoutType: workout.type,
    workoutDate: workout.date,
    durationSec: workout.durationSec,
    distanceKm
  })
  const workoutReceivedIdempotencyKey = `workout-received:${workoutReceivedFingerprint}`
  const workoutAnalysisIdempotencyKey = `workout-analysis:${workout.id}`

  const consistencyWindowStart = getStartOfDaysAgoUTC(timezone, 6, workout.date)
  const tssWindowStart = getStartOfDaysAgoUTC(timezone, 27, workout.date)

  const [workoutsLast7Days, windowWorkouts, sportSettings, recentDeliveries] = await Promise.all([
    prisma.workout.count({
      where: {
        userId: workout.userId,
        isDuplicate: false,
        date: {
          gte: consistencyWindowStart,
          lte: workout.date
        }
      }
    }),
    prisma.workout.findMany({
      where: {
        userId: workout.userId,
        isDuplicate: false,
        date: {
          gte: tssWindowStart,
          lte: workout.date
        }
      },
      select: {
        date: true,
        tss: true
      }
    }),
    sportSettingsRepository.getForActivityType(workout.userId, workout.type || ''),
    prisma.emailDelivery.findMany({
      where: {
        userId: workout.userId,
        templateKey: 'WorkoutReceived'
      },
      orderBy: { createdAt: 'desc' },
      take: COPY_VARIANT_LOOKBACK,
      select: {
        metadata: true
      }
    })
  ])

  const consistencyMessage =
    workoutsLast7Days >= 3
      ? `That is ${workoutsLast7Days} sessions in the last 7 days. Strong consistency momentum.`
      : undefined

  const sportCategory = inferSportCategory(workout.type)
  const tss28d = windowWorkouts.reduce((sum, entry) => sum + (entry.tss || 0), 0)
  const start7d = getStartOfDaysAgoUTC(timezone, 6, workout.date)
  const tss7d = windowWorkouts.reduce((sum, entry) => {
    return entry.date >= start7d ? sum + (entry.tss || 0) : sum
  }, 0)
  const weeklyTssBaseline28d = tss28d > 0 ? Math.round((tss28d / 4) * 10) / 10 : undefined
  const { loadContextLabel, loadContextBody, loadDeltaPct } = buildLoadContext(
    tss7d > 0 ? Math.round(tss7d) : undefined,
    weeklyTssBaseline28d
  )
  const { quickTakeLabel, quickTakeBody, efficiencyMessage, recoveryMessage, cadenceUnit } =
    buildQuickTake({
      sportCategory,
      tss: workout.tss || undefined,
      averageCadence: workout.averageCadence || undefined,
      averageHr: workout.averageHr || undefined,
      averageWatts: workout.averageWatts || undefined,
      maxHr: workout.maxHr || undefined,
      ftp: sportSettings?.ftp || undefined,
      lthr: sportSettings?.lthr || undefined,
      userMaxHr: sportSettings?.maxHr || undefined
    })
  const { sportLensLabel, sportLensBody } = buildSportLens({
    sportCategory,
    averageCadence: workout.averageCadence || undefined,
    averageHr: workout.averageHr || undefined,
    averageWatts: workout.averageWatts || undefined,
    sportFtp: sportSettings?.ftp || undefined,
    sportLthr: sportSettings?.lthr || undefined,
    sportMaxHr: sportSettings?.maxHr || undefined
  })
  const streamInsights = buildWorkoutStreamInsights({
    durationSec: workout.durationSec,
    elapsedTimeSec: workout.elapsedTimeSec,
    decouplingPct: workout.decoupling,
    ftp: sportSettings?.ftp || undefined,
    wPrime: workout.wPrime || sportSettings?.wPrime || undefined,
    wBalDepletion: workout.wBalDepletion,
    streams: workout.streams
      ? {
          time: workout.streams.time,
          watts: workout.streams.watts,
          heartrate: workout.streams.heartrate,
          cadence: workout.streams.cadence,
          distance: workout.streams.distance,
          grade: workout.streams.grade,
          moving: workout.streams.moving,
          surges: workout.streams.surges
        }
      : undefined
  })
  const distanceDisplay = formatEmailDistance(workout.distanceMeters, user.distanceUnits)
  const distanceLabel = distanceDisplay?.label ?? null
  const firstName = getFirstName(user.name)
  const recentVariantIds = parseRecentCopyVariantIds(recentDeliveries)
  const { heroTitle, introLine, ctaLabel, nextStepMessage, subject, previewLine, copyVariantIds } =
    buildInterestingCopy({
      workoutId: workout.id,
      sportCategory,
      workoutTitle: workout.title || 'Workout',
      firstName,
      distanceLabel,
      tss: workout.tss || undefined,
      loadDeltaPct,
      workoutsLast7Days,
      recentVariantIds
    })

  const commonProps = {
    name: user.name || 'Athlete',
    workoutId: workout.id,
    workoutTitle: workout.title || 'Workout',
    workoutDate: formatUserDate(workout.date, timezone, 'EEEE, MMM d'),
    workoutType: workout.type || undefined,
    durationMinutes: workout.durationSec ? Math.round(workout.durationSec / 60) : undefined,
    distanceValue: distanceDisplay?.value,
    distanceUnitLabel: distanceDisplay?.unitLabel,
    elevationGain: workout.elevationGain || undefined,
    averageCadence: workout.averageCadence || undefined,
    averageHr: workout.averageHr || undefined,
    maxHr: workout.maxHr || undefined,
    averageWatts: workout.averageWatts || undefined,
    normalizedPower: workout.normalizedPower || undefined,
    tss: workout.tss || undefined,
    kilojoules: workout.kilojoules || undefined,
    calories: workout.calories || undefined,
    tss7d: tss7d > 0 ? Math.round(tss7d) : undefined,
    weeklyTssBaseline28d,
    loadContextLabel,
    loadContextBody,
    loadDeltaPct,
    workoutsLast7Days,
    consistencyMessage,
    heroTitle,
    introLine,
    previewLine,
    quickTakeLabel,
    quickTakeBody,
    efficiencyMessage,
    recoveryMessage,
    sportLensLabel,
    sportLensBody,
    cadenceUnit,
    ctaLabel,
    nextStepMessage,
    copyVariantIds,
    streamInsightBullets: streamInsights.bullets.length > 0 ? streamInsights.bullets : undefined,
    streamInsightWhatItMeans: streamInsights.whatItMeans,
    streamInsightNextSuggestion: streamInsights.nextWorkoutSuggestion,
    workoutUrl: `${baseUrl}/workouts/${workout.id}`,
    unsubscribeUrl: `${baseUrl}/profile/settings?tab=communication`,
    shareUrl: `${baseUrl}/workouts/${workout.id}?share=true`,
    chatUrl: `${baseUrl}/chat?workoutId=${workout.id}`
  }

  if (triggerType === 'on-workout-received') {
    if (user.aiAutoAnalyzeWorkouts) {
      logWorkoutInsightSkip({
        ...logContext,
        userId: workout.userId,
        aiAutoAnalyzeWorkouts: user.aiAutoAnalyzeWorkouts,
        reason: 'auto_ai_enabled_wait_for_enhanced_email'
      })
      return { queued: false, reason: 'auto_ai_enabled_wait_for_enhanced_email' }
    }

    const eligibility = evaluateWorkoutReceivedEligibility({
      durationSec: workout.durationSec,
      workoutDate: workout.date
    })
    if (!eligibility.eligible) {
      logWorkoutInsightSkip({
        ...logContext,
        userId: workout.userId,
        durationSec: workout.durationSec,
        workoutDate: workout.date.toISOString(),
        reason: eligibility.reason
      })
      return { queued: false, reason: eligibility.reason }
    }

    const cooldownWindowStart = new Date(Date.now() - WORKOUT_RECEIVED_COOLDOWN_MINUTES * 60 * 1000)
    const recentWorkoutReceived = await prisma.emailDelivery.findFirst({
      where: {
        userId: workout.userId,
        templateKey: 'WorkoutReceived',
        createdAt: { gte: cooldownWindowStart },
        status: { in: [...WORKOUT_RECEIVED_ACTIVE_STATUSES] }
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true }
    })
    if (recentWorkoutReceived) {
      logWorkoutInsightSkip({
        ...logContext,
        userId: workout.userId,
        reason: 'workout_received_cooldown_active',
        cooldownMinutes: WORKOUT_RECEIVED_COOLDOWN_MINUTES,
        recentDeliveryId: recentWorkoutReceived.id,
        recentCreatedAt: recentWorkoutReceived.createdAt.toISOString()
      })
      return { queued: false, reason: 'workout_received_cooldown_active' }
    }

    const duplicateActivityDelivery = await prisma.emailDelivery.findUnique({
      where: { idempotencyKey: workoutReceivedIdempotencyKey },
      select: { id: true, createdAt: true, status: true }
    })
    if (duplicateActivityDelivery) {
      logWorkoutInsightSkip({
        ...logContext,
        userId: workout.userId,
        reason: 'workout_received_activity_already_emailed',
        activityFingerprint: workoutReceivedFingerprint,
        duplicateDeliveryId: duplicateActivityDelivery.id,
        duplicateCreatedAt: duplicateActivityDelivery.createdAt.toISOString(),
        duplicateStatus: duplicateActivityDelivery.status
      })
      return { queued: false, reason: 'workout_received_activity_already_emailed' }
    }

    await queueEmail({
      userId: workout.userId,
      templateKey: 'WorkoutReceived',
      eventKey: `WORKOUT_RECEIVED_${workout.id}`,
      idempotencyKey: workoutReceivedIdempotencyKey,
      subject,
      props: {
        ...commonProps,
        activityFingerprint: workoutReceivedFingerprint
      }
    })

    return { queued: true, templateKey: 'WorkoutReceived' }
  }

  if (!user.aiAutoAnalyzeWorkouts) {
    logWorkoutInsightSkip({
      ...logContext,
      userId: workout.userId,
      aiAutoAnalyzeWorkouts: user.aiAutoAnalyzeWorkouts,
      reason: 'auto_ai_disabled'
    })
    return { queued: false, reason: 'auto_ai_disabled' }
  }

  await queueEmail({
    userId: workout.userId,
    templateKey: 'WorkoutAnalysisReady',
    eventKey: `WORKOUT_INSIGHTS_READY_${workout.id}`,
    idempotencyKey: workoutAnalysisIdempotencyKey,
    subject: `Excellent work: analysis ready for ${workout.title || 'your workout'}`,
    props: {
      ...commonProps,
      overallScore: options.overallScore ?? workout.overallScore ?? undefined,
      analysisSummary: options.analysisSummary,
      recommendationHighlights: options.recommendationHighlights,
      adherenceSummary: options.adherenceSummary,
      adherenceScore: options.adherenceScore
    }
  })

  return { queued: true, templateKey: 'WorkoutAnalysisReady' }
}

export async function queueThresholdUpdateEmail(options: {
  userId: string
  workoutId: string
  metric: 'LTHR' | 'FTP' | 'MAX_HR' | 'THRESHOLD_PACE'
  oldValue: number
  newValue: number
  unit: string
  peakValue: number
  sportProfileName?: string
}) {
  const { userId, workoutId, metric, oldValue, newValue, unit, peakValue, sportProfileName } =
    options

  const [workout, user, pref] = await Promise.all([
    prisma.workout.findUnique({
      where: { id: workoutId },
      select: { title: true }
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true }
    }),
    prisma.emailPreference.findUnique({
      where: {
        userId_channel: {
          userId,
          channel: 'EMAIL'
        }
      }
    })
  ])

  if (!workout || !user) return { queued: false, reason: 'workout_or_user_not_found' }

  // Check preferences
  if (pref?.globalUnsubscribe || pref?.thresholdUpdates === false) {
    return { queued: false, reason: 'preference_disabled' }
  }

  const metricLabelMap = {
    LTHR: 'Lactate Threshold Heart Rate',
    FTP: 'Functional Threshold Power',
    MAX_HR: 'Peak Heart Rate',
    THRESHOLD_PACE: 'Threshold Pace'
  }

  const percentIncrease =
    oldValue > 0 ? Math.round(((newValue - oldValue) / oldValue) * 100) : undefined
  const baseUrl = process.env.NUXT_PUBLIC_SITE_URL || 'https://coachwatts.com'

  await queueEmail({
    userId,
    templateKey: 'ThresholdUpdateDetected',
    eventKey: `THRESHOLD_UPDATE_${metric}_${workoutId}`,
    idempotencyKey: `threshold-update:${metric}:${workoutId}`,
    subject: sportProfileName
      ? `Level Up! New ${sportProfileName} ${metric} Detected`
      : `Level Up! New ${metric} Detected`,
    props: {
      name: user.name || 'Athlete',
      workoutId,
      workoutTitle: workout.title || 'Workout',
      metricLabel: metricLabelMap[metric],
      sportProfileName,
      oldValue,
      newValue,
      unit,
      peakValue,
      percentIncrease,
      workoutUrl: `${baseUrl}/workouts/${workoutId}`,
      unsubscribeUrl: `${baseUrl}/profile/settings?tab=communication`
    }
  })

  return { queued: true, templateKey: 'ThresholdUpdateDetected' }
}
