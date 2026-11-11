import { prisma } from '../db'
import {
  fetchIntervalsAthleteProfile,
  fetchIntervalsWorkouts,
  fetchIntervalsActivity,
  fetchIntervalsWellness,
  fetchIntervalsPlannedWorkouts,
  normalizeIntervalsWorkout,
  normalizeIntervalsWellness,
  normalizeIntervalsPlannedWorkout,
  normalizeIntervalsCalendarNote,
  fetchIntervalsActivityStreams,
  fetchIntervalsAthlete,
  hasInvalidIntervalsElevationMetadata,
  computeElevationGainFromAltitudeStream
} from '../intervals'
import { workoutRepository } from '../repositories/workoutRepository'
import {
  attachStreamsToWorkouts,
  workoutStreamRepository
} from '../repositories/workoutStreamRepository'
import { wellnessRepository } from '../repositories/wellnessRepository'
import { eventRepository } from '../repositories/eventRepository'
import { calendarNoteRepository } from '../repositories/calendarNoteRepository'
import { sportSettingsRepository } from '../repositories/sportSettingsRepository'
import { athleteMetricsService } from '../athleteMetricsService'
import { normalizeTSS } from '../normalize-tss'
import { calculateWorkoutStress } from '../calculate-workout-stress'
import { getUserTimezone, getEndOfDayUTC } from '../date'
import { yieldTaskHeartbeat } from '../task-runtime'
import {
  calculateLapSplits,
  calculatePaceVariability,
  calculateAveragePace,
  analyzePacingStrategy,
  detectSurges
} from '../pacing'
import { getZoneIndex, DEFAULT_HR_ZONES, DEFAULT_POWER_ZONES } from '../training-metrics'
import { triggerReadinessCheckIfNeeded } from './wellness-analysis'
import { deduplicationService } from './deduplicationService'
import { triggerWorkoutDeduplicationIfEnabled } from '../trigger-workout-deduplication'
import { shouldIngestWellness } from '../integration-settings'
import { persistIntervalsPlannedWorkoutImport } from '../canonical-planned-workout-write'
import { enqueueIntervalsStreamSync } from '../intervals-stream-queue'
import { roundToTwoDecimals } from '../number'
import { summarizePowerFromWatts } from '../power-metrics'
import { bodyMeasurementService } from './bodyMeasurementService'
import { mergeWorkoutTags } from '../workout-tags'
import { createZoneProfileSnapshot } from '../../../shared/structured-workout-contract'
import { normalizeWorkoutSport } from '../../../shared/workout-support-matrix'

async function ensureSportSettingsForIntervalsImport(userId: string, workoutType: string) {
  const sport = normalizeWorkoutSport(workoutType)
  const profile = await sportSettingsRepository.getForActivityType(userId, workoutType)
  const hasPaceZones = Array.isArray(profile?.paceZones) && profile.paceZones.length > 0
  const hasPowerZones = Array.isArray(profile?.powerZones) && profile.powerZones.length > 0
  const needsPaceProfile = (sport === 'run' || sport === 'swim') && !hasPaceZones
  const needsPowerProfile = sport === 'ride' && !hasPowerZones
  if (!needsPaceProfile && !needsPowerProfile) return

  try {
    await IntervalsService.syncProfile(userId)
  } catch (error) {
    console.warn('[Intervals Import] Failed to refresh sport settings before import', {
      userId,
      workoutType,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function parseIntervalsActivityDate(activity: any): Date | null {
  const rawDate = activity?.start_date || activity?.start_date_local
  if (!rawDate) return null
  const parsed = new Date(rawDate)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function hasDateForActivityUpsert(activity: any): boolean {
  return !!parseIntervalsActivityDate(activity)
}

async function fetchDetailedIntervalsActivityIfNeeded(
  userId: string,
  activityId: string,
  fallbackActivity: any
) {
  const integration = await prisma.integration.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: 'intervals'
      }
    }
  })

  if (!integration) return fallbackActivity

  try {
    const detailedActivity = await fetchIntervalsActivity(integration, activityId)

    if (hasDateForActivityUpsert(detailedActivity)) {
      console.info(
        `[IntervalsService] Recovered sparse activity webhook payload via detailed fetch for activity ${activityId}`
      )
    } else {
      console.warn(
        `[IntervalsService] Detailed fetch still missing usable activity date for activity ${activityId}`
      )
    }

    return detailedActivity
  } catch (error) {
    console.warn(
      `[IntervalsService] Failed to fetch detailed activity ${activityId} for webhook fallback`,
      error
    )
    return fallbackActivity
  }
}

function toRoundedOrNull(value: any): number | null {
  return typeof value === 'number' ? Math.round(value) : null
}

function toNumberOrNull(value: any): number | null {
  return typeof value === 'number' ? value : null
}

function normalizeIntensityValue(activity: any): number | null {
  let val = activity?.icu_intensity ?? activity?.intensity
  if (typeof val !== 'number') return null
  if (val > 5) val = val / 100
  return Math.round(val * 10000) / 10000
}

function calculateChunkCount(startDate: Date, endDate: Date, chunkDays: number): number {
  const msPerDay = 24 * 60 * 60 * 1000
  const diffDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / msPerDay) + 1)
  return Math.max(1, Math.ceil(diffDays / chunkDays))
}

function parseIntervalsWellnessDate(recordId: unknown): Date | null {
  if (typeof recordId !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(recordId)) return null
  const rawDate = new Date(recordId)
  if (Number.isNaN(rawDate.getTime())) return null

  return new Date(Date.UTC(rawDate.getUTCFullYear(), rawDate.getUTCMonth(), rawDate.getUTCDate()))
}

async function buildIntervalsWellnessContext(userId: string) {
  const integration = await prisma.integration.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: 'intervals'
      }
    },
    select: { settings: true }
  })

  const intervalsSettings = (integration?.settings as Record<string, any> | null) || {}
  const readinessScale = intervalsSettings.readinessScale || 'STANDARD'
  const sleepScoreScale = intervalsSettings.sleepScoreScale || 'STANDARD'
  const timezone = await getUserTimezone(userId)
  const historicalEndLocal = getEndOfDayUTC(timezone, new Date())

  let baselineRawReadiness: number[] = []
  if (readinessScale === 'HRV4TRAINING') {
    const recentWellness = await wellnessRepository.getForUser(userId, {
      limit: 60,
      orderBy: { date: 'desc' }
    })
    baselineRawReadiness = recentWellness
      .map((w) => (w.rawJson as any)?.readiness)
      .filter((v) => typeof v === 'number')
  }

  return {
    readinessScale,
    sleepScoreScale,
    baselineRawReadiness,
    historicalEndLocal
  }
}

async function upsertIntervalsWellnessSnapshot(
  userId: string,
  wellness: any,
  context: {
    readinessScale: string
    sleepScoreScale: string
    baselineRawReadiness: number[]
    historicalEndLocal: Date
  }
) {
  const wellnessDate = parseIntervalsWellnessDate(wellness?.id)
  if (!wellnessDate || wellnessDate > context.historicalEndLocal) return false

  const normalizedWellness = normalizeIntervalsWellness(
    wellness,
    userId,
    wellnessDate,
    context.readinessScale,
    context.sleepScoreScale,
    {
      historicalRawReadiness: context.baselineRawReadiness
    }
  )

  if (normalizedWellness.weight) {
    normalizedWellness.weight = roundToTwoDecimals(normalizedWellness.weight)
  }

  if (context.readinessScale === 'HRV4TRAINING' && typeof wellness.readiness === 'number') {
    context.baselineRawReadiness.push(wellness.readiness)
    if (context.baselineRawReadiness.length > 60) {
      context.baselineRawReadiness.shift()
    }
  }

  const { record, isNew } = await wellnessRepository.upsert(
    userId,
    wellnessDate,
    normalizedWellness,
    normalizedWellness,
    'intervals',
    {
      clearFields: ['stress', 'fatigue', 'soreness', 'mood', 'motivation'],
      replaceRawJson: true
    }
  )

  await bodyMeasurementService.recordWellnessMetrics(
    userId,
    {
      id: record.id,
      date: record.date,
      weight: record.weight,
      bodyFat: record.bodyFat,
      rawJson: record.rawJson
    },
    'intervals'
  )

  const isRecent = new Date().getTime() - wellnessDate.getTime() < 7 * 24 * 60 * 60 * 1000
  if (isRecent && normalizedWellness.weight) {
    await athleteMetricsService.updateMetrics(
      userId,
      {
        weight: normalizedWellness.weight,
        date: wellnessDate
      },
      { weightUpdateSource: 'sync' }
    )
  }

  return isNew
}

async function upsertIntervalsFitnessSnapshot(
  userId: string,
  record: any,
  context: {
    historicalEndLocal: Date
  }
) {
  const wellnessDate = parseIntervalsWellnessDate(record?.id)
  if (!wellnessDate || wellnessDate > context.historicalEndLocal) return false

  const rawJsonPatch: Record<string, any> = {
    id: record.id
  }
  if (record.updated !== undefined) rawJsonPatch.updated = record.updated
  if (record.sportInfo !== undefined) rawJsonPatch.sportInfo = record.sportInfo
  if (record.atlLoad !== undefined) rawJsonPatch.atlLoad = record.atlLoad
  if (record.ctlLoad !== undefined) rawJsonPatch.ctlLoad = record.ctlLoad
  if (record.rampRate !== undefined) rawJsonPatch.rampRate = record.rampRate

  const patchData: Record<string, any> = {
    userId,
    date: wellnessDate,
    rawJson: rawJsonPatch
  }

  if (typeof record.ctl === 'number') patchData.ctl = record.ctl
  if (typeof record.atl === 'number') patchData.atl = record.atl

  const { isNew } = await wellnessRepository.upsert(
    userId,
    wellnessDate,
    patchData as any,
    patchData as any,
    'intervals'
  )

  return isNew
}

type IntervalsSyncOptions = {
  skipExisting?: boolean
}

function getIntervalsPlannedDescription(event: any): string {
  return typeof event?.description === 'string' ? event.description : ''
}

function hasHumangoSignature(event: any): boolean {
  const description = getIntervalsPlannedDescription(event)
  return /redirect\.humango\.ai|view on humango/i.test(description)
}

function getIntervalsPlannedStartTime(event: any): string | null {
  if (typeof event?.start_date_local !== 'string' || !event.start_date_local.includes('T'))
    return null
  const timePart = event.start_date_local.split('T')[1]
  if (!timePart || timePart.length < 5) return null
  return timePart.substring(0, 5)
}

function buildHumangoReconciliationLogPayload(params: {
  userId: string
  title: string
  date: string
  type: string | null
  startTime: string | null
  incomingExternalId: string
  incomingUid?: string | null
  matchedPlannedWorkoutId?: string
  previousExternalId?: string
  previousUid?: string | null
  reason: string
}) {
  return {
    scope: 'intervals.calendar_updated',
    action: 'humango_planned_workout_reconciliation',
    ...params
  }
}

function getIntervalsDeletedEventIds(deletedEvents: any[]): string[] {
  return deletedEvents
    .map((entry: any) => {
      if (entry == null) return null
      if (typeof entry === 'string' || typeof entry === 'number') {
        return String(entry)
      }
      if (typeof entry === 'object' && 'id' in entry && entry.id != null) {
        return String(entry.id)
      }
      return null
    })
    .filter((id: string | null): id is string => !!id)
}

function isIncompleteStravaIntervalsActivity(activity: any): boolean {
  return (
    activity?.source === 'STRAVA' &&
    typeof activity?._note === 'string' &&
    activity._note.includes('not available via the API')
  )
}

export const IntervalsService = {
  /**
   * Get athlete profile from Intervals.icu
   */
  async getAthlete(accessToken: string, athleteId: string) {
    return await fetchIntervalsAthlete(accessToken, athleteId)
  },

  /**
   * Get normalized athlete profile from Intervals.icu
   */
  async getAthleteProfile(integration: any) {
    return await fetchIntervalsAthleteProfile(integration)
  },

  /**
   * Sync athlete profile settings (Basic + Sports)
   */
  async syncProfile(userId: string) {
    const integration = await prisma.integration.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'intervals'
        }
      }
    })

    if (!integration) {
      throw new Error(`Intervals integration not found for user ${userId}`)
    }

    const profile = await fetchIntervalsAthleteProfile(integration)

    // Update Basic Settings via Service to sync goals/zones
    await athleteMetricsService.updateMetrics(userId, {
      weight: profile.weight,
      maxHr: profile.maxHR,
      lthr: profile.lthr,
      ftp: profile.ftp
    })

    // Update restingHr if available (not currently in updateMetrics)
    if (profile.restingHR) {
      await prisma.user.update({
        where: { id: userId },
        data: { restingHr: profile.restingHR }
      })
    }

    // Update Sport Settings using Repository
    if (profile.sportSettings && profile.sportSettings.length > 0) {
      await sportSettingsRepository.upsertSettings(userId, profile.sportSettings)
    }

    return profile
  },

  /**
   * Sync activities for a user within a given date range.
   * Chunks the range into 14-day batches to reduce long-running ingestion work.
   */
  async syncActivities(
    userId: string,
    startDate: Date,
    endDate: Date,
    options: IntervalsSyncOptions = {}
  ) {
    const integration = await prisma.integration.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'intervals'
        }
      }
    })

    if (!integration) {
      throw new Error(`Intervals integration not found for user ${userId}`)
    }

    if (!integration.ingestWorkouts) {
      console.log(
        `[Intervals Sync] ⏭️ Skipping activity sync for user ${userId} (ingestWorkouts disabled)`
      )
      return 0
    }

    // Calculate 'now' to cap historical data fetching
    const timezone = await getUserTimezone(userId)
    const now = new Date()
    const historicalEndLocal = getEndOfDayUTC(timezone, now)
    const historicalEnd = endDate > historicalEndLocal ? historicalEndLocal : endDate

    let totalUpsertedCount = 0
    let currentEnd = new Date(historicalEnd)
    const totalChunks = calculateChunkCount(startDate, historicalEnd, 14)
    let chunkIndex = 0

    // Process in 14-day chunks, going backwards from newest to oldest
    while (currentEnd >= startDate) {
      await yieldTaskHeartbeat()
      chunkIndex++

      const currentStart = new Date(currentEnd)
      currentStart.setDate(currentStart.getDate() - 14)
      const effectiveStart = currentStart < startDate ? startDate : currentStart

      console.log(
        `[Intervals Sync] Activity chunk ${chunkIndex}/${totalChunks}: ${effectiveStart.toISOString().split('T')[0]} to ${currentEnd.toISOString().split('T')[0]}`
      )

      const chunkUpserted = await IntervalsService._syncActivitiesBatch(
        userId,
        integration,
        effectiveStart,
        currentEnd,
        options
      )
      totalUpsertedCount += chunkUpserted
      console.log(
        `[Intervals Sync] Activity chunk ${chunkIndex}/${totalChunks} complete. New workouts: ${chunkUpserted}. Total new workouts: ${totalUpsertedCount}`
      )

      // Move to the day before currentStart
      currentEnd = new Date(effectiveStart)
      currentEnd.setDate(currentEnd.getDate() - 1)

      // Break if we processed the very first day
      if (effectiveStart <= startDate) break
    }

    await triggerWorkoutDeduplicationIfEnabled(userId)

    return totalUpsertedCount
  },

  /**
   * Internal helper to sync a batch of activities.
   */
  async _syncActivitiesBatch(
    userId: string,
    integration: any,
    startDate: Date,
    endDate: Date,
    options: IntervalsSyncOptions = {}
  ) {
    const allActivities = await fetchIntervalsWorkouts(integration, startDate, endDate)
    const incompleteStravaActivityIds = allActivities
      .filter((activity) => isIncompleteStravaIntervalsActivity(activity))
      .map((activity) => String(activity.id))

    const [activeStravaIntegration, existingMirroredStravaWorkouts] = await Promise.all([
      prisma.integration.findUnique({
        where: {
          userId_provider: {
            userId,
            provider: 'strava'
          }
        },
        select: { id: true }
      }),
      incompleteStravaActivityIds.length > 0
        ? prisma.workout.findMany({
            where: {
              userId,
              externalId: { in: incompleteStravaActivityIds }
            },
            select: { externalId: true }
          })
        : Promise.resolve([])
    ])
    const existingMirroredStravaWorkoutIds = new Set(
      existingMirroredStravaWorkouts.map((workout) => workout.externalId)
    )

    // Filter out Notes/Holidays. Keep mirrored Strava activities only when they are the
    // user's only remaining source for that workout after a reconnect/reset.
    const activities = allActivities.filter((activity) => {
      if (['Note', 'Holiday'].includes(activity.type)) {
        return false
      }

      if (isIncompleteStravaIntervalsActivity(activity)) {
        const activityId = String(activity.id)
        if (activeStravaIntegration) {
          return false
        }

        if (existingMirroredStravaWorkoutIds.has(activityId)) {
          return false
        }
      }
      return true
    })

    let pendingActivities = activities

    if (options.skipExisting && activities.length > 0) {
      const existingWorkouts = await prisma.workout.findMany({
        where: {
          userId,
          source: 'intervals',
          externalId: { in: activities.map((activity) => String(activity.id)) }
        },
        select: { externalId: true }
      })

      const existingIds = new Set(existingWorkouts.map((workout) => workout.externalId))
      pendingActivities = activities.filter((activity) => !existingIds.has(String(activity.id)))

      console.log(
        `[Intervals Sync] Skip-existing filtered ${existingWorkouts.length} workouts in ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`
      )
    }

    console.log(
      `[Intervals Sync] Retrieved ${allActivities.length} raw activities, ${pendingActivities.length} eligible after filtering for ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`
    )

    let upsertedCount = 0
    let activityIndex = 0

    for (const summaryActivity of pendingActivities) {
      await yieldTaskHeartbeat()
      activityIndex++
      console.log(
        `[Intervals Sync] Processing activity ${activityIndex}/${pendingActivities.length}: ${summaryActivity.id} | ${summaryActivity.name || 'Unnamed Activity'}`
      )

      // Fetch detailed activity data to get icu_intervals and other granular fields
      let activity = summaryActivity
      try {
        activity = await fetchIntervalsActivity(integration, summaryActivity.id)
      } catch (error) {
        console.warn(
          `[IntervalsService] Failed to fetch detailed activity ${summaryActivity.id}, using summary data. Error: ${error}`
        )
      }

      const workout = normalizeIntervalsWorkout(activity, userId)

      // Link to Planned Workout if paired in Intervals.icu
      if (activity.paired_event_id) {
        const pairedExternalId = String(activity.paired_event_id)
        const plannedWorkout = await prisma.plannedWorkout.findUnique({
          where: {
            userId_externalId: {
              userId,
              externalId: pairedExternalId
            }
          },
          select: { id: true }
        })

        if (plannedWorkout) {
          ;(workout as any).plannedWorkoutId = plannedWorkout.id

          // Mark the planned workout as completed
          await prisma.plannedWorkout.update({
            where: { id: plannedWorkout.id },
            data: {
              completed: true,
              completionStatus: 'COMPLETED'
            }
          })
        }
      }

      const { isNew: workoutIsNew, record: upsertedWorkout } = await workoutRepository.upsert(
        userId,
        'intervals',
        workout.externalId,
        workout,
        workout
      )
      if (workoutIsNew) {
        upsertedCount++
      }

      // Normalize TSS
      try {
        const tssResult = await normalizeTSS(upsertedWorkout.id, userId)
        if (tssResult.tss !== null) {
          await calculateWorkoutStress(upsertedWorkout.id, userId)
        }
      } catch (error) {
        console.error(
          `[IntervalsService] Failed to normalize TSS for workout ${upsertedWorkout.id}`,
          error
        )
      }

      // Sync stream data if available
      if (activity.stream_types && activity.stream_types.length > 0) {
        try {
          await IntervalsService.syncActivityStream(userId, upsertedWorkout.id, activity.id)
        } catch (error) {
          console.error(
            `[IntervalsService] Failed to sync stream for workout ${upsertedWorkout.id}`,
            error
          )
        }
      }
    }

    return upsertedCount
  },

  /**
   * Sync activity stream data including pacing metrics.
   */
  async syncActivityStream(userId: string, workoutId: string, activityId: string) {
    await yieldTaskHeartbeat()

    // Get Intervals integration
    const integration = await prisma.integration.findFirst({
      where: {
        userId: userId,
        provider: 'intervals'
      }
    })

    if (!integration) {
      throw new Error('Intervals.icu integration not found')
    }

    // Fetch streams from Intervals.icu API
    const streams = await fetchIntervalsActivityStreams(integration, activityId)
    await yieldTaskHeartbeat()

    // Check if we got any stream data
    if (
      !streams.time ||
      !streams.time.data ||
      (Array.isArray(streams.time.data) && streams.time.data.length === 0)
    ) {
      return null
    }

    const dataPoints = (streams.time.data as any[]).length

    // Extract data arrays
    const timeData = (streams.time?.data as number[]) || []
    const distanceData = (streams.distance?.data as number[]) || []
    const velocityData = (streams.velocity?.data as number[]) || []
    const heartrateData = (streams.heartrate?.data as number[]) || null
    const cadenceData = (streams.cadence?.data as number[]) || null
    const wattsData = (streams.watts?.data as number[]) || null
    const altitudeData = (streams.altitude?.data as number[]) || null
    const latlngData = (streams.latlng?.data as [number, number][]) || null
    const gradeData = (streams.grade?.data as number[]) || null
    const movingData = (streams.moving?.data as boolean[]) || null

    // New streams (2026-01-13)
    const torqueData = (streams.torque?.data as number[]) || null
    const tempData = (streams.temp?.data as number[]) || null
    const respirationData = (streams.respiration?.data as number[]) || null
    const hrvData = (streams.hrv?.data as number[]) || null
    const leftRightBalanceData = (streams.left_right_balance?.data as number[]) || null

    // Calculate Zones: resolve activity-specific settings for the stored workout type.
    // getForActivityType falls back to the default profile when no specific match
    // exists; per-zone missing/empty arrays still fall back to user-level then built-in.
    const storedWorkout = await prisma.workout.findUnique({
      where: { id: workoutId },
      select: { type: true }
    })
    const activityType =
      typeof storedWorkout?.type === 'string' && storedWorkout.type.length > 0
        ? storedWorkout.type
        : null
    const sportProfile = activityType
      ? await sportSettingsRepository.getForActivityType(userId, activityType)
      : await sportSettingsRepository.getDefault(userId)
    let hrZones: any[] = []
    let powerZones: any[] = []

    if (sportProfile) {
      hrZones = Array.isArray((sportProfile as any).hrZones)
        ? ((sportProfile as any).hrZones as any[])
        : []
      powerZones = Array.isArray((sportProfile as any).powerZones)
        ? ((sportProfile as any).powerZones as any[])
        : []
    }

    if (hrZones.length === 0 || powerZones.length === 0) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { hrZones: true, powerZones: true }
      })
      if (hrZones.length === 0) {
        hrZones =
          Array.isArray(user?.hrZones) && user.hrZones.length > 0
            ? (user.hrZones as any[])
            : DEFAULT_HR_ZONES
      }
      if (powerZones.length === 0) {
        powerZones =
          Array.isArray(user?.powerZones) && user.powerZones.length > 0
            ? (user.powerZones as any[])
            : DEFAULT_POWER_ZONES
      }
    }
    await yieldTaskHeartbeat()

    const hrZoneTimes: number[] | null =
      heartrateData && hrZones.length > 0 ? new Array(hrZones.length).fill(0) : null
    if (hrZoneTimes && heartrateData) {
      for (const hr of heartrateData) {
        if (hr !== null && hr !== undefined) {
          const zoneIndex = getZoneIndex(hr, hrZones)
          if (zoneIndex >= 0) {
            const current = hrZoneTimes[zoneIndex]
            if (current !== undefined) {
              hrZoneTimes[zoneIndex] = current + 1
            }
          }
        }
      }
    }
    await yieldTaskHeartbeat()

    const powerZoneTimes: number[] | null =
      wattsData && powerZones.length > 0 ? new Array(powerZones.length).fill(0) : null
    if (powerZoneTimes && wattsData) {
      for (const watts of wattsData) {
        if (watts !== null && watts !== undefined) {
          const zoneIndex = getZoneIndex(watts, powerZones)
          if (zoneIndex >= 0) {
            const current = powerZoneTimes[zoneIndex]
            if (current !== undefined) {
              powerZoneTimes[zoneIndex] = current + 1
            }
          }
        }
      }
    }
    await yieldTaskHeartbeat()

    // Calculate pacing metrics
    let lapSplits = null
    let paceVariability = null
    let avgPacePerKm = null
    let pacingStrategy = null
    let surges = null

    if (timeData.length > 0 && distanceData.length > 0) {
      // Calculate lap splits (1km intervals)
      lapSplits = calculateLapSplits(timeData, distanceData, 1000)

      // Calculate pace variability
      if (velocityData.length > 0) {
        paceVariability = calculatePaceVariability(velocityData)

        // Calculate average pace
        const lastTime = timeData[timeData.length - 1]
        const lastDist = distanceData[distanceData.length - 1]
        if (lastTime !== undefined && lastDist !== undefined) {
          avgPacePerKm = calculateAveragePace(lastTime, lastDist)
        }
      }

      // Analyze pacing strategy
      if (lapSplits && lapSplits.length >= 2) {
        pacingStrategy = analyzePacingStrategy(lapSplits)
      }

      // Detect surges
      if (velocityData.length > 20 && timeData.length > 20) {
        surges = detectSurges(velocityData, timeData)
      }
    }
    await yieldTaskHeartbeat()

    // Store in database
    await workoutStreamRepository.upsert(workoutId, {
      time: timeData,
      distance: distanceData,
      velocity: velocityData,
      heartrate: heartrateData,
      cadence: cadenceData,
      watts: wattsData,
      altitude: altitudeData,
      latlng: latlngData as [number, number][] | null,
      grade: gradeData,
      moving: movingData,
      torque: torqueData as number[] | null,
      temp: tempData as number[] | null,
      respiration: respirationData as number[] | null,
      hrv: hrvData as number[] | null,
      leftRightBalance: leftRightBalanceData as number[] | null,
      hrZoneTimes: hrZoneTimes as any,
      powerZoneTimes: powerZoneTimes as any,
      lapSplits: lapSplits as any,
      paceVariability,
      avgPacePerKm,
      pacingStrategy: pacingStrategy as any,
      surges: surges as any
    })
    const workoutStream = await workoutStreamRepository.findByWorkoutId(workoutId)
    if (!workoutStream) {
      throw new Error(`Failed to persist streams for workout ${workoutId}`)
    }
    await yieldTaskHeartbeat()

    // If Intervals summary omitted power metrics (common on some running activities),
    // backfill from the stored watts stream so downstream AI/context has usable values.
    const streamPowerSummary = summarizePowerFromWatts(wattsData)
    const streamElevationGain = computeElevationGainFromAltitudeStream(altitudeData)
    await yieldTaskHeartbeat()

    if (streamPowerSummary || streamElevationGain !== null) {
      const workout = await prisma.workout.findUnique({
        where: { id: workoutId },
        select: {
          averageWatts: true,
          maxWatts: true,
          normalizedPower: true,
          elevationGain: true
        }
      })

      if (workout) {
        const updateData: {
          averageWatts?: number
          maxWatts?: number
          normalizedPower?: number
          elevationGain?: number
        } = {}

        if (streamPowerSummary) {
          if (!workout.averageWatts || workout.averageWatts <= 0) {
            updateData.averageWatts = streamPowerSummary.averageWatts
          }

          if (!workout.maxWatts || workout.maxWatts <= 0) {
            updateData.maxWatts = streamPowerSummary.maxWatts
          }

          if (!workout.normalizedPower || workout.normalizedPower <= 0) {
            updateData.normalizedPower = streamPowerSummary.normalizedPower
          }
        }

        // Prefer stream-derived elevation when valid altitude samples exist.
        if (streamElevationGain !== null && workout.elevationGain !== streamElevationGain) {
          updateData.elevationGain = streamElevationGain
        }

        if (Object.keys(updateData).length > 0) {
          await prisma.workout.update({
            where: { id: workoutId },
            data: updateData
          })
          await yieldTaskHeartbeat()
        }
      }
    }

    return workoutStream
  },

  /**
   * Sync wellness data for a user within a given date range.
   * Chunks the range into yearly batches to handle large histories safely.
   */
  async syncWellness(
    userId: string,
    startDate: Date,
    endDate: Date,
    options: IntervalsSyncOptions = {}
  ) {
    const integration = await prisma.integration.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'intervals'
        }
      }
    })

    if (!integration) {
      throw new Error(`Intervals integration not found for user ${userId}`)
    }

    const timezone = await getUserTimezone(userId)
    const now = new Date()
    const historicalEndLocal = getEndOfDayUTC(timezone, now)
    const historicalEnd = endDate > historicalEndLocal ? historicalEndLocal : endDate

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { weightUnits: true }
    })

    const settings = integration.settings as any
    const readinessScale = settings?.readinessScale || 'STANDARD'
    const sleepScoreScale = settings?.sleepScoreScale || 'STANDARD'

    // Fetch initial historical data for normalization if using HRV4TRAINING
    let baselineRawReadiness: number[] = []
    if (readinessScale === 'HRV4TRAINING') {
      const recentWellness = await wellnessRepository.getForUser(userId, {
        limit: 60,
        orderBy: { date: 'desc' }
      })
      baselineRawReadiness = recentWellness
        .map((w) => (w.rawJson as any)?.readiness)
        .filter((v) => typeof v === 'number')
    }

    let totalUpsertedCount = 0
    let currentEnd = new Date(historicalEnd)
    const totalChunks = calculateChunkCount(startDate, historicalEnd, 365)
    let chunkIndex = 0

    // Process in 365-day chunks, going backwards from newest to oldest
    while (currentEnd >= startDate) {
      await yieldTaskHeartbeat()
      chunkIndex++

      const currentStart = new Date(currentEnd)
      currentStart.setDate(currentStart.getDate() - 365)
      const effectiveStart = currentStart < startDate ? startDate : currentStart

      console.log(
        `[Intervals Sync] Wellness chunk ${chunkIndex}/${totalChunks}: ${effectiveStart.toISOString().split('T')[0]} to ${currentEnd.toISOString().split('T')[0]}`
      )

      const wellnessData = await fetchIntervalsWellness(integration, effectiveStart, currentEnd)

      let chunkUpsertedCount = 0
      // Sort wellness data by date ascending to ensure baseline updates correctly during backfills
      let sortedWellness = [...wellnessData].sort((a, b) => a.id.localeCompare(b.id))

      if (options.skipExisting && sortedWellness.length > 0) {
        const chunkDates = sortedWellness.map((wellness) => {
          const rawDate = new Date(wellness.id)
          return new Date(
            Date.UTC(rawDate.getUTCFullYear(), rawDate.getUTCMonth(), rawDate.getUTCDate())
          )
        })

        const existingWellness = await prisma.wellness.findMany({
          where: {
            userId,
            date: { in: chunkDates }
          },
          select: { date: true }
        })

        const existingKeys = new Set(
          existingWellness.map((entry) => entry.date.toISOString().split('T')[0])
        )

        const beforeCount = sortedWellness.length
        sortedWellness = sortedWellness.filter((wellness) => !existingKeys.has(wellness.id))
        console.log(
          `[Intervals Sync] Skip-existing filtered ${beforeCount - sortedWellness.length} wellness entries in ${effectiveStart.toISOString().split('T')[0]} to ${currentEnd.toISOString().split('T')[0]}`
        )
      }

      for (const wellness of sortedWellness) {
        await yieldTaskHeartbeat()

        const isNew = await upsertIntervalsWellnessSnapshot(userId, wellness, {
          readinessScale,
          sleepScoreScale,
          baselineRawReadiness,
          historicalEndLocal
        })

        if (isNew) {
          chunkUpsertedCount++
        }
      }

      totalUpsertedCount += chunkUpsertedCount
      console.log(
        `[Intervals Sync] Wellness chunk ${chunkIndex}/${totalChunks} complete. New entries: ${chunkUpsertedCount}. Total new entries: ${totalUpsertedCount}`
      )

      // Move to the day before currentStart
      currentEnd = new Date(effectiveStart)
      currentEnd.setDate(currentEnd.getDate() - 1)

      // Break if we processed the very first day
      if (effectiveStart <= startDate) break
    }

    return totalUpsertedCount
  },

  async ingestWebhookWellnessRecords(
    userId: string,
    records: any[],
    options: {
      mode?: 'wellness' | 'fitness'
    } = {}
  ) {
    if (!Array.isArray(records) || records.length === 0) return 0

    const context = await buildIntervalsWellnessContext(userId)
    const sortedRecords = [...records].sort((a, b) =>
      String(a?.id || '').localeCompare(String(b?.id || ''))
    )

    let upsertedCount = 0
    for (const record of sortedRecords) {
      const isNew =
        options.mode === 'fitness'
          ? await upsertIntervalsFitnessSnapshot(userId, record, context)
          : await upsertIntervalsWellnessSnapshot(userId, record, context)

      if (isNew) upsertedCount++
    }

    return upsertedCount
  },

  /**
   * Sync planned workouts and events for a user within a given date range.
   */
  async syncPlannedWorkouts(
    userId: string,
    startDate: Date,
    endDate: Date,
    options: IntervalsSyncOptions = {}
  ) {
    const integration = await prisma.integration.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'intervals'
        }
      }
    })

    if (!integration) {
      throw new Error(`Intervals integration not found for user ${userId}`)
    }

    const settings = (integration.settings as any) || {}
    const importPlannedWorkouts = settings.importPlannedWorkouts !== false // Default to true

    if (!importPlannedWorkouts) {
      console.log(
        `[Intervals Sync] ⏭️ Skipping planned workout sync for user ${userId} (disabled in settings)`
      )
      return { plannedWorkouts: 0, events: 0, notes: 0 }
    }

    let plannedWorkouts = await fetchIntervalsPlannedWorkouts(integration, startDate, endDate)
    console.log(
      `[Intervals Sync] Retrieved ${plannedWorkouts.length} planned items for ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`
    )

    // Reconciliation must retain remote IDs even when their imports are skipped.
    const validExternalIds = new Set(plannedWorkouts.map((p) => String(p.id)))

    if (options.skipExisting && plannedWorkouts.length > 0) {
      const externalIds = plannedWorkouts.map((planned) => String(planned.id))
      const [existingPlanned, existingNotes, existingEvents] = await Promise.all([
        prisma.plannedWorkout.findMany({
          where: {
            userId,
            externalId: { in: externalIds }
          },
          select: { externalId: true }
        }),
        prisma.calendarNote.findMany({
          where: {
            userId,
            source: 'intervals',
            externalId: { in: externalIds }
          },
          select: { externalId: true }
        }),
        prisma.event.findMany({
          where: {
            userId,
            source: 'intervals',
            externalId: { in: externalIds }
          },
          select: { externalId: true }
        })
      ])

      const existingIds = new Set([
        ...existingPlanned.map((item) => item.externalId),
        ...existingNotes.map((item) => item.externalId),
        ...existingEvents.map((item) => item.externalId)
      ])

      const beforeCount = plannedWorkouts.length
      plannedWorkouts = plannedWorkouts.filter((planned) => !existingIds.has(String(planned.id)))
      console.log(
        `[Intervals Sync] Skip-existing filtered ${beforeCount - plannedWorkouts.length} planned items in ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`
      )
    }

    // SMART SYNC RECONCILIATION
    // Remove local items that no longer exist in Intervals (orphans)
    // This handles deletions/moves that missed webhooks

    // 1. Find potential orphans in PlannedWorkout
    // Only check items that are marked as SYNCED (or default)
    // Pending/Failed items are local-only or waiting for sync, so we keep them.
    const localWorkouts = await prisma.plannedWorkout.findMany({
      where: {
        userId,
        date: { gte: startDate, lte: endDate },
        OR: [{ syncStatus: 'SYNCED' }, { syncStatus: null }]
      },
      select: { externalId: true, completed: true }
    })

    // Create a set of completed workout IDs to prevent deletion
    const completedWorkoutIds = new Set(
      localWorkouts.filter((w) => w.completed).map((w) => w.externalId!)
    )

    // 2. Find potential orphans in CalendarNote
    const localNotes = await prisma.calendarNote.findMany({
      where: {
        userId,
        startDate: { gte: startDate, lte: endDate },
        source: 'intervals'
      },
      select: { externalId: true }
    })

    // 3. Find potential orphans in Event
    const localEvents = await prisma.event.findMany({
      where: {
        userId,
        date: { gte: startDate, lte: endDate },
        source: 'intervals'
      },
      select: { externalId: true }
    })

    // Collect all local IDs found in this window
    const allLocalIds = new Set([
      ...localWorkouts.map((w) => w.externalId!),
      ...localNotes.map((n) => n.externalId),
      ...localEvents.map((e) => e.externalId!)
    ])

    // Identify orphans (Local IDs NOT present in Remote Response)
    // SAFETY: Only consider numeric IDs as "Intervals IDs".
    // If an ID is non-numeric (e.g. "ai-gen-...", "adhoc-...", or UUID), it is a local workout
    // that hasn't been synced yet, so we MUST NOT delete it.
    const orphans = [...allLocalIds].filter((id) => {
      // If it exists in remote, keep it (not an orphan)
      if (validExternalIds.has(id)) return false

      // SAFETY: Do not delete completed workouts even if they are missing from remote
      // (Intervals often removes completed planned workouts from the calendar)
      if (completedWorkoutIds.has(id)) return false

      // If it's missing from remote, check if it's a local ID
      // Intervals.icu IDs are strictly numeric.
      const isIntervalsId = /^\d+$/.test(id)

      // If it looks like an Intervals ID but is missing, it's a ghost -> Delete (return true)
      // If it's non-numeric, it's local -> Keep (return false)
      return isIntervalsId
    })

    if (orphans.length > 0) {
      console.log(
        `[Intervals Sync] 🧹 Reconciliation: Deleting ${orphans.length} orphaned items (Ghosts) that no longer exist in Intervals.`
      )
      await IntervalsService.deletePlannedWorkouts(userId, orphans)
    }

    // Fetch existing workouts to preserve local structure (exercises) if remote is text-only
    const externalIds = plannedWorkouts.map((p) => String(p.id))
    const existingWorkouts = await prisma.plannedWorkout.findMany({
      where: {
        userId,
        externalId: { in: externalIds }
      },
      select: {
        id: true,
        externalId: true,
        durationSec: true,
        structuredWorkout: true,
        modifiedLocally: true,
        lastStructureEditedAt: true,
        lastStructurePublishedAt: true,
        structureHash: true
      }
    })
    const existingMap = new Map(existingWorkouts.map((w) => [w.externalId, w]))

    let plannedUpserted = 0
    let eventsUpserted = 0
    let notesUpserted = 0
    let plannedIndex = 0

    for (const planned of plannedWorkouts) {
      await yieldTaskHeartbeat()
      plannedIndex++
      console.log(
        `[Intervals Sync] Processing planned item ${plannedIndex}/${plannedWorkouts.length}: ${planned.id} | ${planned.name || 'Unnamed Item'}`
      )

      // Skip "Weekly" notes which are internal system notes
      if (planned.name === 'Weekly') {
        continue
      }

      const category = planned.category || ''
      const type = planned.type || ''

      // Handle Calendar Notes / Non-Activity Items (Notes, Targets, Holidays, etc.)
      if (
        [
          'NOTE',
          'TARGET',
          'HOLIDAY',
          'SICK',
          'INJURED',
          'SEASON_START',
          'FITNESS_DAYS',
          'SET_EFTP',
          'SET_FITNESS'
        ].includes(category) ||
        ['Note', 'Holiday'].includes(type)
      ) {
        const normalizedNote = normalizeIntervalsCalendarNote(planned, userId)

        await calendarNoteRepository.upsert(
          userId,
          'intervals',
          normalizedNote.externalId,
          normalizedNote
        )
        notesUpserted++

        // Ensure it doesn't exist as a PlannedWorkout or Event (if type changed)
        await prisma.plannedWorkout.deleteMany({
          where: { userId, externalId: normalizedNote.externalId }
        })
        await prisma.event.deleteMany({
          where: { userId, source: 'intervals', externalId: normalizedNote.externalId }
        })
        continue
      }

      const plannedSettings = await sportSettingsRepository.getForActivityType(
        userId,
        planned.type || ''
      )
      await ensureSportSettingsForIntervalsImport(userId, planned.type || '')
      const refreshedSettings = await sportSettingsRepository.getForActivityType(
        userId,
        planned.type || ''
      )
      const normalizedPlanned = normalizeIntervalsPlannedWorkout(
        planned,
        userId,
        createZoneProfileSnapshot(refreshedSettings || plannedSettings)
      )

      // Preserve local exercises/instructions if remote has no structure (Text-only sync)
      const existingRecord = existingMap.get(normalizedPlanned.externalId) as any
      const existingStruct = existingRecord?.structuredWorkout as any
      const newStruct = normalizedPlanned.structuredWorkout as any

      if (existingStruct?.exercises?.length > 0) {
        // If new structure is empty or has no exercises (Intervals never sends exercises structure)
        // We restore local exercises. Note: Intervals might send junk 'Rest' steps parsed from description, so we ignore steps check.
        if (!newStruct || !newStruct.exercises?.length) {
          if (!normalizedPlanned.structuredWorkout) {
            normalizedPlanned.structuredWorkout = {} as any
          }
          const target = normalizedPlanned.structuredWorkout as any

          target.exercises = existingStruct.exercises

          // Also preserve coach instructions if missing
          if (existingStruct.coachInstructions && !target.coachInstructions) {
            target.coachInstructions = existingStruct.coachInstructions
          }
        }
      }

      await persistIntervalsPlannedWorkoutImport(prisma, {
        userId,
        existingRecord,
        normalizedPlanned,
        sportSettings: refreshedSettings || plannedSettings,
        seenAt: new Date()
      })
      plannedUpserted++

      // Ensure it doesn't exist as a CalendarNote (if type changed)
      await calendarNoteRepository.deleteExternal(userId, 'intervals', [
        normalizedPlanned.externalId
      ])

      // Handle Racing Events (EVENT, RACE_A, RACE_B, RACE_C)
      if (['EVENT', 'RACE_A', 'RACE_B', 'RACE_C'].includes(planned.category || '')) {
        let startTime = null
        if (planned.start_date_local && planned.start_date_local.includes('T')) {
          const timePart = planned.start_date_local.split('T')[1]
          if (timePart && timePart.length >= 5) {
            startTime = timePart.substring(0, 5)
          }
        }

        // Map category back to priority
        let priority = null
        if (planned.category === 'RACE_A') priority = 'A'
        else if (planned.category === 'RACE_B') priority = 'B'
        else if (planned.category === 'RACE_C') priority = 'C'

        const eventData = {
          title: normalizedPlanned.title,
          description: planned.description || '',
          date: new Date(planned.start_date_local),
          startTime,
          type: planned.type || 'Other',
          priority,
          isVirtual: false,
          isPublic: false,
          distance: normalizedPlanned.distanceMeters
            ? Math.round(normalizedPlanned.distanceMeters / 1000)
            : null,
          expectedDuration: normalizedPlanned.durationSec
            ? parseFloat((normalizedPlanned.durationSec / 3600).toFixed(1))
            : null,
          location: planned.location || null,
          syncStatus: 'SYNCED'
        }

        await eventRepository.upsertExternal(userId, 'intervals', planned.id.toString(), eventData)
        eventsUpserted++
      }
    }

    return { plannedWorkouts: plannedUpserted, events: eventsUpserted, notes: notesUpserted }
  },

  /**
   * Handle activity deletion.
   * If the deleted workout was a canonical workout, promote one of its duplicates.
   */
  async deleteActivity(userId: string, activityId: string) {
    const workoutToDelete = await prisma.workout.findFirst({
      where: {
        userId,
        source: 'intervals',
        externalId: activityId
      },
      include: {
        duplicates: {
          include: {
            exercises: true
          }
        }
      }
    })

    if (!workoutToDelete) return

    // deduplicationService.calculateCompletenessScore only checks whether
    // `streams` is truthy (never reads a specific field), so we don't need
    // any of the optional stream columns here -- just the mandatory baseline
    // that findManyByWorkoutIds always fetches to determine "usable" streams.
    const duplicatesWithStreams = workoutToDelete.duplicates.length
      ? await attachStreamsToWorkouts(workoutToDelete.duplicates, { fields: [] })
      : []

    await prisma.$transaction(async (tx) => {
      // If the workout has duplicates, we need to promote one of them
      if (duplicatesWithStreams.length > 0) {
        // Calculate scores for all duplicates to find the best one to promote
        const scoredDuplicates = duplicatesWithStreams.map((d) => ({
          ...d,
          score: deduplicationService.calculateCompletenessScore(d)
        }))

        // Sort by score descending
        scoredDuplicates.sort((a, b) => b.score - a.score)

        const newPrimary = scoredDuplicates[0]
        const remainingDuplicates = scoredDuplicates.slice(1)

        if (newPrimary) {
          // 1. Promote the best duplicate
          await tx.workout.update({
            where: { id: newPrimary.id },
            data: {
              isDuplicate: false,
              duplicateOf: null,
              // If the old primary was linked to a planned workout, transfer the link
              plannedWorkoutId: newPrimary.plannedWorkoutId || workoutToDelete.plannedWorkoutId
            }
          })

          // 2. Update all OTHER duplicates to point to the new primary
          if (remainingDuplicates.length > 0) {
            await tx.workout.updateMany({
              where: {
                id: { in: remainingDuplicates.map((d) => d.id) }
              },
              data: {
                duplicateOf: newPrimary.id
              }
            })
          }
        }
      }

      // Finally, delete the workout
      await tx.workout.delete({
        where: { id: workoutToDelete.id }
      })
    })
  },

  /**
   * Handle planned workout/event deletion.
   */
  async deletePlannedWorkouts(userId: string, externalIds: string[]) {
    await prisma.plannedWorkout.deleteMany({
      where: {
        userId,
        externalId: { in: externalIds }
      }
    })

    await calendarNoteRepository.deleteExternal(userId, 'intervals', externalIds)

    await prisma.event.deleteMany({
      where: {
        userId,
        source: 'intervals',
        externalId: { in: externalIds }
      }
    })
  },

  /**
   * Process a single webhook event.
   */
  async processWebhookEvent(userId: string, type: string, intervalEvent: any) {
    const integration = await prisma.integration.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: 'intervals'
        }
      },
      select: {
        ingestWorkouts: true,
        settings: true
      }
    })
    const intervalsSettings = (integration?.settings as Record<string, any> | null) || {}
    const wellnessEnabled = shouldIngestWellness(intervalsSettings)

    switch (type) {
      case 'ACTIVITY_UPLOADED':
      case 'ACTIVITY_ANALYZED':
      case 'ACTIVITY_ACHIEVEMENTS':
      case 'ACTIVITY_UPDATED': {
        if (integration && !integration.ingestWorkouts) {
          break
        }

        let activity = intervalEvent.activity
        const activityId = activity?.id ? String(activity.id) : null

        if (!activity || !activityId) {
          // Delta-only worker mode: do not run range pulls on webhook events.
          console.warn(
            `[IntervalsService] ${type} payload missing activity details for user ${userId}; skipping without full sync`
          )
          break
        }

        if (!hasDateForActivityUpsert(activity)) {
          console.warn(
            `[IntervalsService] ${type} payload missing usable activity date for activity ${activityId}; attempting detailed fetch`
          )
          activity = await fetchDetailedIntervalsActivityIfNeeded(userId, activityId, activity)
        }

        const activityDate = parseIntervalsActivityDate(activity)

        // Fast path: payload contains enough data to upsert the workout directly.
        if (activityId && activity && hasDateForActivityUpsert(activity)) {
          const normalized = normalizeIntervalsWorkout(activity, userId)

          // Link to Planned Workout if paired in Intervals.icu
          if (activity.paired_event_id) {
            const pairedExternalId = String(activity.paired_event_id)
            const plannedWorkout = await prisma.plannedWorkout.findUnique({
              where: {
                userId_externalId: {
                  userId,
                  externalId: pairedExternalId
                }
              },
              select: { id: true }
            })

            if (plannedWorkout) {
              ;(normalized as any).plannedWorkoutId = plannedWorkout.id
              await prisma.plannedWorkout.update({
                where: { id: plannedWorkout.id },
                data: {
                  completed: true,
                  completionStatus: 'COMPLETED'
                }
              })
            }
          }

          const { record } = await workoutRepository.upsert(
            userId,
            'intervals',
            normalized.externalId,
            normalized,
            normalized
          )

          try {
            const tssResult = await normalizeTSS(record.id, userId)
            if (tssResult.tss !== null) {
              await calculateWorkoutStress(record.id, userId)
            }
          } catch (error) {
            console.error(
              `[IntervalsService] Failed to normalize TSS for workout ${record.id}`,
              error
            )
          }

          if (Array.isArray(activity.stream_types) && activity.stream_types.length > 0) {
            try {
              await enqueueIntervalsStreamSync({
                userId,
                workoutId: record.id,
                activityId
              })
            } catch (error) {
              console.error(
                `[IntervalsService] Failed to enqueue stream sync for workout ${record.id}`,
                error
              )
            }
          }
        } else if (activityId && activity) {
          console.warn(
            `[IntervalsService] ${type} activity ${activityId} still lacks a usable date after fallback; applying delta-only patch path`
          )
          // Delta path: apply only fields present in payload, avoiding full range sync.
          const existing = await workoutRepository.getByExternalId(userId, 'intervals', activityId)

          if (existing) {
            const deltaData: any = {}
            const patchDate = parseIntervalsActivityDate(activity)
            if (patchDate) deltaData.date = patchDate

            if (typeof activity.name === 'string') deltaData.title = activity.name
            if (activity.description !== undefined)
              deltaData.description = activity.description || null
            if (typeof activity.type === 'string') deltaData.type = activity.type

            const moving = toNumberOrNull(activity.moving_time)
            const elapsed = toNumberOrNull(activity.elapsed_time)
            const duration = toNumberOrNull(activity.duration)
            if (moving !== null || elapsed !== null || duration !== null) {
              deltaData.durationSec = Math.round(moving || elapsed || duration || 0)
            }

            if (toNumberOrNull(activity.distance) !== null)
              deltaData.distanceMeters = activity.distance
            if (toNumberOrNull(activity.total_elevation_gain) !== null) {
              deltaData.elevationGain = hasInvalidIntervalsElevationMetadata(activity)
                ? null
                : Math.round(activity.total_elevation_gain)
            }

            const avgWatts = activity.icu_average_watts ?? activity.average_watts
            if (toNumberOrNull(avgWatts) !== null)
              deltaData.averageWatts = toRoundedOrNull(avgWatts)

            const maxWatts =
              activity.max_watts ??
              activity.icu_pm_p_max ??
              activity.icu_rolling_p_max ??
              activity.p_max
            if (toNumberOrNull(maxWatts) !== null) deltaData.maxWatts = toRoundedOrNull(maxWatts)

            if (toNumberOrNull(activity.normalized_power) !== null) {
              deltaData.normalizedPower = toRoundedOrNull(activity.normalized_power)
            }
            if (toNumberOrNull(activity.icu_weighted_avg_watts) !== null) {
              deltaData.weightedAvgWatts = toRoundedOrNull(activity.icu_weighted_avg_watts)
            }

            if (toNumberOrNull(activity.average_heartrate) !== null) {
              deltaData.averageHr = toRoundedOrNull(activity.average_heartrate)
            }
            if (toNumberOrNull(activity.max_heartrate) !== null) {
              deltaData.maxHr = toRoundedOrNull(activity.max_heartrate)
            }

            if (toNumberOrNull(activity.average_cadence) !== null) {
              deltaData.averageCadence = toRoundedOrNull(activity.average_cadence)
            }
            if (toNumberOrNull(activity.max_cadence) !== null) {
              deltaData.maxCadence = toRoundedOrNull(activity.max_cadence)
            }

            if (toNumberOrNull(activity.average_speed) !== null) {
              deltaData.averageSpeed = activity.average_speed
            }

            if (toNumberOrNull(activity.tss) !== null) deltaData.tss = activity.tss
            if (toNumberOrNull(activity.icu_training_load) !== null) {
              deltaData.trainingLoad = activity.icu_training_load
            }
            if (toNumberOrNull(activity.icu_hrss) !== null) deltaData.hrLoad = activity.icu_hrss
            if (toNumberOrNull(activity.trimp) !== null)
              deltaData.trimp = toRoundedOrNull(activity.trimp)

            const intensity = normalizeIntensityValue(activity)
            if (intensity !== null) deltaData.intensity = intensity

            if (toNumberOrNull(activity.icu_joules) !== null) {
              deltaData.kilojoules = Math.round(activity.icu_joules / 1000)
            }

            if (toNumberOrNull(activity.icu_ctl) !== null) deltaData.ctl = activity.icu_ctl
            if (toNumberOrNull(activity.icu_atl) !== null) deltaData.atl = activity.icu_atl
            if (toNumberOrNull(activity.perceived_exertion) !== null) {
              deltaData.rpe = toRoundedOrNull(activity.perceived_exertion)
            } else if (toNumberOrNull(activity.icu_rpe) !== null) {
              deltaData.rpe = toRoundedOrNull(activity.icu_rpe)
            }
            if (toNumberOrNull(activity.session_rpe) !== null) {
              deltaData.sessionRpe = toRoundedOrNull(activity.session_rpe)
            }
            if (toNumberOrNull(activity.feel) !== null)
              deltaData.feel = 6 - Math.round(activity.feel)
            if (toNumberOrNull(activity.calories) !== null) {
              deltaData.calories = toRoundedOrNull(activity.calories)
            }
            if (toNumberOrNull(activity.elapsed_time) !== null) {
              deltaData.elapsedTimeSec = toRoundedOrNull(activity.elapsed_time)
            }

            deltaData.rawJson = {
              ...((existing.rawJson as any) || {}),
              ...(activity || {})
            }

            if (Object.prototype.hasOwnProperty.call(activity || {}, 'tags')) {
              deltaData.tags = mergeWorkoutTags((existing.tags as string[]) || [], {
                incomingIntervalsTags: activity.tags
              })
            }

            if (Object.keys(deltaData).length > 0) {
              await workoutRepository.update(existing.id, deltaData)
            }
          } else {
            // Delta-only worker mode: create a minimal local record when date exists.
            if (activityDate) {
              const normalized = normalizeIntervalsWorkout(
                {
                  ...activity,
                  id: activityId,
                  start_date: activity.start_date || activity.start_date_local,
                  start_date_local: activity.start_date_local || activity.start_date,
                  name: activity.name || 'Unnamed Activity',
                  type: activity.type || 'Other',
                  moving_time: Number(
                    activity.moving_time || activity.elapsed_time || activity.duration || 0
                  ),
                  elapsed_time: Number(
                    activity.elapsed_time || activity.moving_time || activity.duration || 0
                  ),
                  duration: Number(
                    activity.duration || activity.moving_time || activity.elapsed_time || 0
                  )
                } as any,
                userId
              )

              await workoutRepository.upsert(
                userId,
                'intervals',
                normalized.externalId,
                normalized,
                normalized
              )
            } else {
              console.warn(
                `[IntervalsService] ${type} has unknown activity date for ${activityId}; skipping without full sync`
              )
            }
          }
        }

        await triggerWorkoutDeduplicationIfEnabled(userId)
        break
      }

      case 'APP_SCOPE_CHANGED': {
        const deauthorized = Boolean(intervalEvent?.deauthorized)
        if (deauthorized) {
          await prisma.integration.updateMany({
            where: {
              userId,
              provider: 'intervals'
            },
            data: {
              syncStatus: 'FAILED',
              errorMessage: 'Intervals authorization changed/deauthorized. Reconnect integration.'
            }
          })
        }
        break
      }

      case 'WELLNESS_UPDATED':
        if (wellnessEnabled) {
          const records = Array.isArray(intervalEvent?.records) ? intervalEvent.records : []
          if (records.length > 0) {
            await IntervalsService.ingestWebhookWellnessRecords(userId, records, {
              mode: 'wellness'
            })
          }
          await triggerReadinessCheckIfNeeded(userId)
        }
        break

      case 'FITNESS_UPDATED': {
        if (wellnessEnabled) {
          const records = Array.isArray(intervalEvent?.records) ? intervalEvent.records : []
          if (records.length > 0) {
            await IntervalsService.ingestWebhookWellnessRecords(userId, records, {
              mode: 'fitness'
            })
          }
          await triggerReadinessCheckIfNeeded(userId)
        }
        break
      }

      case 'ACTIVITY_DELETED': {
        const deletedActivityId = intervalEvent.activity?.id || intervalEvent.id
        if (deletedActivityId) {
          await IntervalsService.deleteActivity(userId, deletedActivityId.toString())
        }
        break
      }

      case 'CALENDAR_UPDATED': {
        const importPlannedWorkouts = intervalsSettings.importPlannedWorkouts !== false
        const changedEvents = Array.isArray(intervalEvent.events) ? intervalEvent.events : []
        const deletedEvents = intervalEvent.deleted_events || []
        if (deletedEvents.length > 0) {
          const deletedIds = getIntervalsDeletedEventIds(deletedEvents)
          await IntervalsService.deletePlannedWorkouts(userId, deletedIds)
        }

        if (!importPlannedWorkouts) {
          if (changedEvents.length > 0) {
            console.log(
              `[Intervals Webhook] Skipping ${changedEvents.length} planned workout updates (import disabled)`
            )
          }
          break
        }

        if (changedEvents.length > 0) {
          const externalIds = changedEvents
            .map((e: any) => (e?.id != null ? String(e.id) : null))
            .filter((id: string | null): id is string => !!id)

          const existingWorkouts = await prisma.plannedWorkout.findMany({
            where: {
              userId,
              externalId: { in: externalIds }
            },
            select: {
              id: true,
              externalId: true,
              structuredWorkout: true,
              modifiedLocally: true,
              lastStructureEditedAt: true,
              lastStructurePublishedAt: true,
              structureHash: true
            }
          })
          const existingMap = new Map(existingWorkouts.map((w) => [w.externalId, w]))

          for (const planned of changedEvents) {
            if (!planned?.id) continue
            if (planned.name === 'Weekly') continue

            const category = planned.category || ''
            const workoutType = planned.type || ''

            if (
              [
                'NOTE',
                'TARGET',
                'HOLIDAY',
                'SICK',
                'INJURED',
                'SEASON_START',
                'FITNESS_DAYS',
                'SET_EFTP',
                'SET_FITNESS'
              ].includes(category) ||
              ['Note', 'Holiday'].includes(workoutType)
            ) {
              const normalizedNote = normalizeIntervalsCalendarNote(planned, userId)

              await calendarNoteRepository.upsert(
                userId,
                'intervals',
                normalizedNote.externalId,
                normalizedNote
              )

              await prisma.plannedWorkout.deleteMany({
                where: { userId, externalId: normalizedNote.externalId }
              })
              await prisma.event.deleteMany({
                where: { userId, source: 'intervals', externalId: normalizedNote.externalId }
              })
              continue
            }

            const plannedSettings = await sportSettingsRepository.getForActivityType(
              userId,
              planned.type || ''
            )
            const normalizedPlanned = normalizeIntervalsPlannedWorkout(
              planned,
              userId,
              createZoneProfileSnapshot(plannedSettings)
            )

            let existingRecord = existingMap.get(normalizedPlanned.externalId) as any
            if (!existingRecord && hasHumangoSignature(planned)) {
              const reconciliationCandidates = await prisma.plannedWorkout.findMany({
                where: {
                  userId,
                  date: normalizedPlanned.date,
                  title: normalizedPlanned.title,
                  type: normalizedPlanned.type,
                  startTime: normalizedPlanned.startTime
                },
                select: {
                  id: true,
                  externalId: true,
                  durationSec: true,
                  structuredWorkout: true,
                  modifiedLocally: true,
                  lastStructureEditedAt: true,
                  lastStructurePublishedAt: true,
                  structureHash: true,
                  rawJson: true
                }
              })

              const humangoCandidates = reconciliationCandidates.filter((candidate: any) =>
                hasHumangoSignature(candidate?.rawJson)
              )

              if (humangoCandidates.length === 1) {
                existingRecord = humangoCandidates[0]
                console.log(
                  `[Intervals Sync] ${JSON.stringify(
                    buildHumangoReconciliationLogPayload({
                      userId,
                      title: normalizedPlanned.title,
                      date: normalizedPlanned.date.toISOString(),
                      type: normalizedPlanned.type,
                      startTime:
                        normalizedPlanned.startTime || getIntervalsPlannedStartTime(planned),
                      incomingExternalId: normalizedPlanned.externalId,
                      incomingUid: planned?.uid ? String(planned.uid) : null,
                      matchedPlannedWorkoutId: existingRecord.id,
                      previousExternalId: existingRecord.externalId,
                      previousUid:
                        existingRecord?.rawJson &&
                        typeof existingRecord.rawJson === 'object' &&
                        'uid' in existingRecord.rawJson
                          ? String((existingRecord.rawJson as any).uid)
                          : null,
                      reason: 'matched_single_humango_candidate'
                    })
                  )}`
                )
              } else if (humangoCandidates.length > 1) {
                console.warn(
                  `[Intervals Sync] ${JSON.stringify(
                    buildHumangoReconciliationLogPayload({
                      userId,
                      title: normalizedPlanned.title,
                      date: normalizedPlanned.date.toISOString(),
                      type: normalizedPlanned.type,
                      startTime:
                        normalizedPlanned.startTime || getIntervalsPlannedStartTime(planned),
                      incomingExternalId: normalizedPlanned.externalId,
                      incomingUid: planned?.uid ? String(planned.uid) : null,
                      reason: `skipped_ambiguous_humango_candidates:${humangoCandidates.length}`
                    })
                  )}`
                )
              }
            }
            const existingStruct = existingRecord?.structuredWorkout as any
            const newStruct = normalizedPlanned.structuredWorkout as any

            // Preserve local parsed exercises when webhook payload has only text/steps.
            if (existingStruct?.exercises?.length > 0) {
              if (!newStruct || !newStruct.exercises?.length) {
                if (!normalizedPlanned.structuredWorkout) {
                  normalizedPlanned.structuredWorkout = {} as any
                }
                const target = normalizedPlanned.structuredWorkout as any
                target.exercises = existingStruct.exercises
                if (existingStruct.coachInstructions && !target.coachInstructions) {
                  target.coachInstructions = existingStruct.coachInstructions
                }
              }
            }

            await persistIntervalsPlannedWorkoutImport(prisma, {
              userId,
              existingRecord,
              normalizedPlanned,
              sportSettings: plannedSettings,
              seenAt: new Date()
            })

            await calendarNoteRepository.deleteExternal(userId, 'intervals', [
              normalizedPlanned.externalId
            ])

            if (['EVENT', 'RACE_A', 'RACE_B', 'RACE_C'].includes(category)) {
              let startTime = null
              if (planned.start_date_local && planned.start_date_local.includes('T')) {
                const timePart = planned.start_date_local.split('T')[1]
                if (timePart && timePart.length >= 5) {
                  startTime = timePart.substring(0, 5)
                }
              }

              let priority = null
              if (category === 'RACE_A') priority = 'A'
              else if (category === 'RACE_B') priority = 'B'
              else if (category === 'RACE_C') priority = 'C'

              const eventData = {
                title: normalizedPlanned.title,
                description: planned.description || '',
                date: new Date(planned.start_date_local),
                startTime,
                type: planned.type || 'Other',
                priority,
                isVirtual: false,
                isPublic: false,
                distance: normalizedPlanned.distanceMeters
                  ? Math.round(normalizedPlanned.distanceMeters / 1000)
                  : null,
                expectedDuration: normalizedPlanned.durationSec
                  ? parseFloat((normalizedPlanned.durationSec / 3600).toFixed(1))
                  : null,
                location: planned.location || null,
                syncStatus: 'SYNCED'
              }

              await eventRepository.upsertExternal(
                userId,
                'intervals',
                planned.id.toString(),
                eventData
              )
            }
          }
        }

        // Delta-only worker mode: no full calendar pulls from webhook events.
        break
      }

      default:
        console.log(`[IntervalsService] Unhandled webhook event type: ${type}`)
        return { handled: false, message: `Unhandled event type: ${type}` }
    }
    return { handled: true, message: `Processed ${type}` }
  }
}
