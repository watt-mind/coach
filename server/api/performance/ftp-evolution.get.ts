import { workoutStreamRepository } from '../../utils/repositories/workoutStreamRepository'
import { defineEventHandler, getQuery, createError } from 'h3'
import { requireAuth } from '../../utils/auth-guard'
import { workoutRepository } from '../../utils/repositories/workoutRepository'
import { getUserTimezone, getStartOfYearUTC } from '../../utils/date'
import { parseTagQueryParam } from '../../utils/workout-tags'

const FTP_FRESHNESS_THRESHOLDS = {
  fresh: 30,
  aging: 90
}

const FTP_VALIDATION_PCT = 0.97

type FtpFreshnessState = 'fresh' | 'aging' | 'stale' | 'unknown'

function buildSportTypeWhere(sport?: string) {
  if (!sport) return undefined

  const cyclingTypes = ['Ride', 'VirtualRide', 'MountainBikeRide', 'GravelRide', 'EBikeRide']
  const runningTypes = ['Run', 'VirtualRun', 'TrailRun']

  if (cyclingTypes.includes(sport)) {
    return { in: cyclingTypes }
  }

  if (runningTypes.includes(sport)) {
    return { in: runningTypes }
  }

  return sport
}

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

function getFreshnessState(daysSince: number | null): FtpFreshnessState {
  if (daysSince === null) return 'unknown'
  if (daysSince <= FTP_FRESHNESS_THRESHOLDS.fresh) return 'fresh'
  if (daysSince <= FTP_FRESHNESS_THRESHOLDS.aging) return 'aging'
  return 'stale'
}

function getMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7)
}

function getMonthLabel(date: Date): string {
  return date.toLocaleString('en-US', { month: 'short', year: 'numeric' })
}

defineRouteMeta({
  openAPI: {
    tags: ['Performance'],
    summary: 'Get FTP evolution',
    description: 'Returns the history of Functional Threshold Power changes.',
    inputSchema: [
      {
        name: 'months',
        in: 'query',
        schema: { type: ['integer', 'string'], default: 12 }
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
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      date: { type: 'string', format: 'date-time' },
                      month: { type: 'string' },
                      ftp: { type: 'integer' },
                      title: { type: 'string' }
                    }
                  }
                },
                summary: {
                  type: 'object',
                  properties: {
                    currentFTP: { type: 'integer', nullable: true },
                    startingFTP: { type: 'integer', nullable: true },
                    peakFTP: { type: 'integer', nullable: true },
                    improvement: { type: 'number', nullable: true },
                    dataPoints: { type: 'integer' }
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
  const user = await requireAuth(event, ['performance:read'])

  const query = getQuery(event)
  const userId = user.id
  const sport = query.sport === 'all' ? undefined : (query.sport as string)
  const tags = parseTagQueryParam(query.tags)
  const sportTypeWhere = buildSportTypeWhere(sport)

  // Calculate date range
  const endDate = new Date()
  let startDate = new Date()

  if (query.months === 'YTD') {
    const timezone = await getUserTimezone(userId)
    startDate = getStartOfYearUTC(timezone)
  } else if (query.months === '3650' || query.months === '730' || query.months === 'ALL') {
    startDate.setFullYear(startDate.getFullYear() - 10)
  } else {
    const months = parseInt(query.months as string) || 12
    startDate.setMonth(startDate.getMonth() - months)
  }

  // Get workouts with FTP data, ordered by date
  // This gives us "snapshots" of FTP changes over time
  const workouts = await workoutRepository.getForUser(user.id, {
    startDate,
    endDate,
    tags,
    where: {
      ftp: {
        not: null
      },
      type: sportTypeWhere
    },
    select: {
      id: true,
      date: true,
      title: true,
      type: true,
      ftp: true
    },
    orderBy: {
      date: 'asc'
    }
  })

  // Reconstruct history
  // We combine current FTP (most authoritative for "now") with historical snapshots

  const ftpByMonth = new Map<string, { date: Date; ftp: number; title: string }>()

  // 1. Process historical data points
  workouts.forEach((workout) => {
    if (!workout.ftp) return

    const monthKey = new Date(workout.date).toISOString().slice(0, 7) // YYYY-MM
    const existing = ftpByMonth.get(monthKey)

    // Keep the most recent FTP value for each month
    if (!existing || new Date(workout.date) > existing.date) {
      ftpByMonth.set(monthKey, {
        date: new Date(workout.date),
        ftp: workout.ftp,
        title: workout.title
      })
    }
  })

  // 2. Add "Current" state if not covered by recent workout
  // This handles the case where user manually updated FTP in settings but hasn't done a workout yet with it
  if (user.ftp) {
    const currentMonthKey = new Date().toISOString().slice(0, 7)
    const existing = ftpByMonth.get(currentMonthKey)

    // If the latest workout FTP is different from User Profile FTP, it means the profile was likely updated manually
    // So we treat the User Profile FTP as the latest data point
    if (!existing || existing.ftp !== user.ftp) {
      ftpByMonth.set(currentMonthKey, {
        date: new Date(),
        ftp: user.ftp,
        title: 'Current Setting'
      })
    }
  }

  // Convert to array and sort by date
  const ftpData = Array.from(ftpByMonth.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((item) => ({
      date: item.date,
      month: getMonthLabel(item.date),
      ftp: item.ftp,
      title: item.title
    }))

  // Calculate statistics
  // Current FTP is always the profile FTP (source of truth for "Now")
  const lastFtpEntry = ftpData.length > 0 ? ftpData[ftpData.length - 1] : null
  const currentFTP = user.ftp || (lastFtpEntry ? lastFtpEntry.ftp : null)

  // Starting FTP is the first data point in the period
  const firstFtpEntry = ftpData.length > 0 ? ftpData[0] : null
  const startingFTP = firstFtpEntry ? firstFtpEntry.ftp : null

  // Peak is max over the period
  const peakFTP = ftpData.length > 0 ? Math.max(...ftpData.map((d) => d.ftp)) : null

  const improvement =
    startingFTP && currentFTP ? ((currentFTP - startingFTP) / startingFTP) * 100 : null

  // Estimated FTP from workout efforts in the selected period
  const estimationWorkouts = (await workoutRepository.getForUser(user.id, {
    startDate,
    endDate,
    tags,
    includeDuplicates: false,
    where: sport ? { type: sportTypeWhere } : undefined,
    orderBy: {
      date: 'asc'
    }
  })) as any[]

  const estimatedByMonth = new Map<
    string,
    { date: Date; estimatedFtp: number; sourceWorkoutCount: number }
  >()

  const estimationWatts = await workoutStreamRepository.findWattsByWorkoutIds(
    estimationWorkouts.map((workout) => workout.id)
  )

  estimationWorkouts.forEach((workout) => {
    const watts = estimationWatts.get(workout.id)
    const fallbackPower = workout.normalizedPower || workout.averageWatts || 0
    const durationSec = workout.durationSec || 0

    const stream20m = Array.isArray(watts) ? calculateBestPowerForDuration(watts, 1200) : 0
    const stream30m = Array.isArray(watts) ? calculateBestPowerForDuration(watts, 1800) : 0
    const stream60m = Array.isArray(watts) ? calculateBestPowerForDuration(watts, 3600) : 0

    const best20m = Math.max(stream20m, durationSec >= 1200 ? fallbackPower : 0)
    const best30m = Math.max(stream30m, durationSec >= 1800 ? fallbackPower : 0)
    const best60m = Math.max(stream60m, durationSec >= 3600 ? fallbackPower : 0)

    if (best20m <= 0 && best30m <= 0 && best60m <= 0) return

    const estimatedFtp = Math.round(Math.max(best20m * 0.95, best30m * 0.93, best60m))
    const monthKey = getMonthKey(new Date(workout.date))
    const existing = estimatedByMonth.get(monthKey)

    if (!existing) {
      estimatedByMonth.set(monthKey, {
        date: new Date(workout.date),
        estimatedFtp,
        sourceWorkoutCount: 1
      })
      return
    }

    estimatedByMonth.set(monthKey, {
      date: new Date(workout.date) > existing.date ? new Date(workout.date) : existing.date,
      estimatedFtp: Math.max(existing.estimatedFtp, estimatedFtp),
      sourceWorkoutCount: existing.sourceWorkoutCount + 1
    })
  })

  const estimatedData = Array.from(estimatedByMonth.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((item) => ({
      date: item.date,
      month: getMonthLabel(item.date),
      estimatedFtp: item.estimatedFtp,
      sourceWorkoutCount: item.sourceWorkoutCount
    }))

  const configuredValues = ftpData.map((d) => d.ftp)
  const uniqueConfiguredValues = [...new Set(configuredValues)]
  const isConfiguredFlat = uniqueConfiguredValues.length <= 1 && ftpData.length > 1
  const lastConfiguredChangeDate =
    ftpData.length > 0
      ? ftpData.reduce((lastChange, point, index) => {
          if (index === 0) return point.date
          const prev = ftpData[index - 1]
          return prev && prev.ftp !== point.ftp ? point.date : lastChange
        }, ftpData[0]?.date || new Date())
      : null
  const daysSinceConfiguredChange = getDaysSince(lastConfiguredChangeDate, endDate)

  // Freshness context: look for efforts that can validate current FTP
  let ftpFreshness: {
    state: FtpFreshnessState
    daysSinceValidation: number | null
    lastValidatingEffortDate: Date | null
    message: string
    thresholdsDays: { fresh: number; aging: number }
    validationPct: number
  } = {
    state: 'unknown',
    daysSinceValidation: null,
    lastValidatingEffortDate: null,
    message: 'No power validation data available.',
    thresholdsDays: FTP_FRESHNESS_THRESHOLDS,
    validationPct: FTP_VALIDATION_PCT
  }

  if (currentFTP) {
    const ftpValidationLookbackStart = new Date()
    ftpValidationLookbackStart.setDate(ftpValidationLookbackStart.getDate() - 365)

    const powerWorkouts = (await workoutRepository.getForUser(user.id, {
      startDate: ftpValidationLookbackStart,
      endDate,
      tags,
      includeDuplicates: false,
      where: sport ? { type: sportTypeWhere } : undefined
    })) as any[]

    const validationWatts = await workoutStreamRepository.findWattsByWorkoutIds(
      powerWorkouts.map((workout) => workout.id)
    )

    let lastValidatingEffortDate: Date | null = null

    powerWorkouts.forEach((workout) => {
      const watts = validationWatts.get(workout.id)

      const fallbackPower = workout.normalizedPower || workout.averageWatts || 0
      const durationSec = workout.durationSec || 0

      const stream20m = Array.isArray(watts) ? calculateBestPowerForDuration(watts, 1200) : 0
      const stream30m = Array.isArray(watts) ? calculateBestPowerForDuration(watts, 1800) : 0
      const stream60m = Array.isArray(watts) ? calculateBestPowerForDuration(watts, 3600) : 0

      const best20m = Math.max(stream20m, durationSec >= 1200 ? fallbackPower : 0)
      const best30m = Math.max(stream30m, durationSec >= 1800 ? fallbackPower : 0)
      const best60m = Math.max(stream60m, durationSec >= 3600 ? fallbackPower : 0)

      if (best20m <= 0 && best30m <= 0 && best60m <= 0) return

      // Estimate FTP-equivalent effort from sustained durations
      const ftpEquivalent = Math.max(best20m * 0.95, best30m * 0.93, best60m)
      const threshold = currentFTP * FTP_VALIDATION_PCT

      if (ftpEquivalent >= threshold) {
        const workoutDate = new Date(workout.date)
        if (!lastValidatingEffortDate || workoutDate > lastValidatingEffortDate) {
          lastValidatingEffortDate = workoutDate
        }
      }
    })

    const daysSinceValidation = getDaysSince(lastValidatingEffortDate, endDate)
    const state = getFreshnessState(daysSinceValidation)

    let message = 'FTP estimate appears current based on recent sustained efforts.'
    if (state === 'aging') {
      message = 'FTP estimate is aging; consider a validating threshold effort soon.'
    } else if (state === 'stale') {
      message = 'FTP estimate may be stale (no validating effort in >90 days).'
    } else if (state === 'unknown') {
      message = 'No sustained power efforts found to validate FTP.'
    }

    ftpFreshness = {
      state,
      daysSinceValidation,
      lastValidatingEffortDate,
      message,
      thresholdsDays: FTP_FRESHNESS_THRESHOLDS,
      validationPct: FTP_VALIDATION_PCT
    }
  }

  return {
    data: ftpData,
    estimatedData,
    summary: {
      currentFTP,
      startingFTP,
      peakFTP,
      improvement: improvement ? Math.round(improvement * 10) / 10 : null,
      dataPoints: ftpData.length
    },
    context: {
      isConfiguredFlat,
      uniqueConfiguredValues: uniqueConfiguredValues.length,
      lastConfiguredChangeDate,
      daysSinceConfiguredChange,
      estimatedDataPoints: estimatedData.length
    },
    freshness: ftpFreshness
  }
})
