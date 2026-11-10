import { defineEventHandler, getQuery, createError } from 'h3'
import { workoutRepository } from '../../utils/repositories/workoutRepository'
import { workoutStreamRepository } from '../../utils/repositories/workoutStreamRepository'
import { getServerSession } from '../../utils/session'
import { subDays } from 'date-fns'
import { getUserTimezone, getStartOfYearUTC } from '../../utils/date'
import { parseTagQueryParam } from '../../utils/workout-tags'

const DURATIONS = [5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600]
const FRESHNESS_THRESHOLDS = {
  fresh: 30,
  aging: 90
}
const VALIDATION_PCT = 0.97

type FreshnessState = 'fresh' | 'aging' | 'stale' | 'unknown'

function calculateBestPowerForDuration(powerData: number[], durationSec: number): number {
  if (!Array.isArray(powerData) || powerData.length < durationSec) return 0

  let maxAvg = 0
  let rolling = 0

  for (let i = 0; i < powerData.length; i++) {
    rolling += powerData[i] || 0

    if (i >= durationSec) {
      rolling -= powerData[i - durationSec] || 0
    }

    if (i >= durationSec - 1) {
      const avg = rolling / durationSec
      if (avg > maxAvg) maxAvg = avg
    }
  }

  return Math.round(maxAvg)
}

function getDaysSince(date: Date | null, now: Date): number | null {
  if (!date) return null
  const msInDay = 24 * 60 * 60 * 1000
  return Math.floor((now.getTime() - date.getTime()) / msInDay)
}

function getFreshnessState(daysSince: number | null): FreshnessState {
  if (daysSince === null) return 'unknown'
  if (daysSince <= FRESHNESS_THRESHOLDS.fresh) return 'fresh'
  if (daysSince <= FRESHNESS_THRESHOLDS.aging) return 'aging'
  return 'stale'
}

defineRouteMeta({
  openAPI: {
    tags: ['Workouts'],
    summary: 'Get aggregate power curve',
    description: 'Returns the power curve (current period vs all-time) for the athlete.',
    inputSchema: [
      {
        name: 'days',
        in: 'query',
        schema: { type: ['integer', 'string'], default: 90 }
      },
      {
        name: 'sport',
        in: 'query',
        schema: { type: 'string' }
      },
      {
        name: 'tags',
        in: 'query',
        schema: { type: 'string' }
      }
    ],
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                current: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      duration: { type: 'integer' },
                      watts: { type: 'number' }
                    }
                  }
                },
                allTime: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      duration: { type: 'integer' },
                      watts: { type: 'number' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      401: { description: 'Unauthorized' }
    }
  }
})

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  const user = session?.user as any

  if (!user?.id) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized'
    })
  }

  const userId = user.id
  const query = getQuery(event)
  const now = new Date()

  const startDate =
    query.days === 'YTD'
      ? getStartOfYearUTC(await getUserTimezone(userId))
      : subDays(now, Number(query.days) || 90)
  const sport = query.sport === 'all' ? undefined : (query.sport as string)
  const tags = parseTagQueryParam(query.tags)

  const workoutSelect = { id: true, date: true }

  // 1. Fetch workouts for the selected period (Current Curve)
  const currentWorkouts = await workoutRepository.getForUser(userId, {
    startDate,
    endDate: now,
    tags,
    includeDuplicates: false,
    where: sport ? { type: sport } : undefined,
    select: workoutSelect
  })

  // 2. Fetch all-time bests (All-Time Curve)
  const allTimeStartDate = subDays(now, 730) // 2 years
  const allTimeWorkouts = await workoutRepository.getForUser(userId, {
    startDate: allTimeStartDate,
    endDate: now,
    tags,
    includeDuplicates: false,
    where: sport ? { type: sport } : undefined,
    select: workoutSelect
  })

  // Power streams live in WorkoutStreamV2 for anything ingested since the
  // stream migration, with the legacy WorkoutStream table as fallback. Reading
  // the `streams` relation directly would only ever see the legacy table and
  // return an empty curve for V2-only athletes. The two workout sets overlap
  // heavily, so resolve the union once instead of fetching streams twice.
  const wattsByWorkoutId = await workoutStreamRepository.findWattsByWorkoutIds([
    ...new Set([...currentWorkouts, ...allTimeWorkouts].map((workout: any) => workout.id))
  ])

  const processWorkoutsToCurve = (
    workouts: any[],
    allTimeBestByDuration?: Map<number, number>,
    fallbackLastValidatingByDuration?: Map<number, Date | null>
  ) => {
    const bestByDuration = new Map<number, { watts: number; date: Date | null }>()
    const effortsByDuration = new Map<number, Array<{ watts: number; date: Date }>>()

    DURATIONS.forEach((duration) => {
      bestByDuration.set(duration, { watts: 0, date: null })
      effortsByDuration.set(duration, [])
    })

    // Pass 1: collect every workout's best effort per duration, and the overall
    // best for this workout set.
    workouts.forEach((workout) => {
      const watts = wattsByWorkoutId.get(workout.id)
      if (!watts || watts.length === 0) return

      const workoutDate = new Date(workout.date)

      DURATIONS.forEach((duration) => {
        const best = calculateBestPowerForDuration(watts, duration)
        if (best <= 0) return

        const current = bestByDuration.get(duration)
        if (current && best > current.watts) {
          bestByDuration.set(duration, { watts: best, date: workoutDate })
        }

        effortsByDuration.get(duration)?.push({ watts: best, date: workoutDate })
      })
    })

    // Pass 2: validate against a *settled* reference best. The all-time curve is
    // built first, with no `allTimeBestByDuration`, so comparing each effort to a
    // running/own value would let every workout validate itself (CW-380) and
    // collapse `lastValidatingDate` to the date of the most recent ride with
    // power. Falling back to this set's own final best keeps the all-time curve's
    // freshness meaning "how long since a near-best effort", which is also what
    // makes it a sound fallback for the current curve.
    const lastValidatingByDuration = new Map<number, Date | null>()

    DURATIONS.forEach((duration) => {
      const referenceBest =
        allTimeBestByDuration?.get(duration) || bestByDuration.get(duration)?.watts || 0

      let lastValidating: Date | null = null

      if (referenceBest > 0) {
        const threshold = referenceBest * VALIDATION_PCT
        for (const effort of effortsByDuration.get(duration) || []) {
          if (effort.watts < threshold) continue
          if (!lastValidating || effort.date > lastValidating) lastValidating = effort.date
        }
      }

      lastValidatingByDuration.set(duration, lastValidating)
    })

    return DURATIONS.map((duration) => {
      const best = bestByDuration.get(duration)
      const lastValidatingDate =
        lastValidatingByDuration.get(duration) ||
        fallbackLastValidatingByDuration?.get(duration) ||
        null
      const daysSince = getDaysSince(lastValidatingDate, now)

      return {
        duration,
        watts: best?.watts || 0,
        bestDate: best?.date,
        lastValidatingDate,
        daysSince,
        freshnessState: getFreshnessState(daysSince)
      }
    }).filter((point) => point.watts > 0)
  }

  const allTimeCurve = processWorkoutsToCurve(allTimeWorkouts)
  const allTimeBestByDuration = new Map<number, number>(
    allTimeCurve.map((point) => [point.duration, point.watts])
  )
  const allTimeLastValidatingByDuration = new Map<number, Date | null>(
    allTimeCurve.map((point) => [point.duration, point.lastValidatingDate || null])
  )

  const currentCurve = processWorkoutsToCurve(
    currentWorkouts,
    allTimeBestByDuration,
    allTimeLastValidatingByDuration
  )

  return {
    current: currentCurve,
    allTime: allTimeCurve,
    freshness: {
      thresholdsDays: FRESHNESS_THRESHOLDS,
      validationPct: VALIDATION_PCT
    }
  }
})
