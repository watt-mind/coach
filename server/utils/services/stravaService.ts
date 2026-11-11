import { prisma } from '../db'
import { deduplicationService } from './deduplicationService'
import { attachStreamsToWorkouts } from '../repositories/workoutStreamRepository'
import { shouldIngestActivities } from '../integration-settings'
import { dispatchTask } from '../task-dispatcher'
import { registerTaskHandler } from '../task-registry'
import {
  fetchStravaActivities,
  fetchStravaActivityDetails,
  normalizeStravaActivity
} from '../strava'
import { workoutRepository } from '../repositories/workoutRepository'
import { calculateWorkoutStress } from '../calculate-workout-stress'
import { ingestStravaStreamsForWorkout } from '../../../trigger/utils/strava-stream-ingestion'
import { linkWorkoutToMatchingPlannedWorkout } from '../planned-workout-linking'

function buildStravaStreamRepairTrigger(userId: string, workoutId: string, activityId: number) {
  return dispatchTask(
    'ingest-strava-streams',
    {
      userId,
      workoutId,
      activityId
    },
    {
      concurrencyKey: userId,
      tags: [`user:${userId}`]
    }
  )
}

export async function runIngestStrava(payload: {
  userId: string
  startDate: string
  endDate: string
}) {
  const { userId, startDate, endDate } = payload

  const stravaEnabled = process.env.NUXT_PUBLIC_STRAVA_ENABLED !== 'false'
  if (!stravaEnabled) {
    return {
      success: false,
      message: 'Strava integration is temporarily disabled',
      counts: {}
    }
  }

  const integration = await prisma.integration.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: 'strava'
      }
    }
  })

  if (!integration) {
    throw new Error('Strava integration not found for user')
  }

  await prisma.integration.update({
    where: { id: integration.id },
    data: { syncStatus: 'SYNCING' }
  })

  let syncSucceeded = false
  let syncErrorMessage: string | null = null

  try {
    const settings = (integration.settings as Record<string, any> | null) || {}
    if (!shouldIngestActivities('strava', integration.ingestWorkouts, settings)) {
      syncSucceeded = true
      return {
        success: true,
        counts: { workouts: 0 },
        userId,
        startDate,
        endDate
      }
    }

    const start = new Date(startDate)
    const end = new Date(endDate)

    const activities = await fetchStravaActivities(integration, start, end)

    const updatedIntegration = await prisma.integration.findUnique({
      where: { id: integration.id }
    })

    if (!updatedIntegration) {
      throw new Error('Integration not found after activities fetch')
    }

    let workoutsUpserted = 0
    let workoutsSkipped = 0
    let detailsFetched = 0
    const queuedRepairWorkoutIds = new Set<string>()

    // Drain the list so completed activity summaries are eligible for GC during long syncs.
    while (activities.length > 0) {
      const activity = activities.shift()!
      const activityDate = new Date(activity.start_date)
      const fiveMinutesBefore = new Date(activityDate.getTime() - 5 * 60 * 1000)
      const fiveMinutesAfter = new Date(activityDate.getTime() + 5 * 60 * 1000)

      const existingFromIntervals = await prisma.workout.findFirst({
        where: {
          userId,
          source: 'intervals',
          date: {
            gte: fiveMinutesBefore,
            lte: fiveMinutesAfter
          },
          durationSec: {
            gte: activity.moving_time - 30,
            lte: activity.moving_time + 30
          }
        }
      })

      if (existingFromIntervals) {
        workoutsSkipped++
        continue
      }

      const existingStrava = await workoutRepository.getByExternalId(
        userId,
        'strava',
        String(activity.id)
      )

      const stravaUpdatedAt = new Date(activity.updated_at || activity.start_date)
      if (
        existingStrava &&
        existingStrava.updatedAt &&
        existingStrava.updatedAt >= stravaUpdatedAt
      ) {
        workoutsSkipped++
        continue
      }

      const detailedActivity = await fetchStravaActivityDetails(updatedIntegration, activity.id)
      detailsFetched++

      const workout = normalizeStravaActivity(detailedActivity, userId)

      const { isNew, record: upsertedWorkout } = await workoutRepository.upsert(
        userId,
        'strava',
        workout.externalId,
        workout as any,
        workout as any
      )

      if (isNew) {
        workoutsUpserted++
      }

      try {
        await linkWorkoutToMatchingPlannedWorkout(upsertedWorkout)
      } catch {
        // ignore matching error
      }

      try {
        const streamIntegration =
          (await prisma.integration.findUnique({
            where: { id: updatedIntegration.id }
          })) || updatedIntegration

        await ingestStravaStreamsForWorkout({
          userId,
          workoutId: upsertedWorkout.id,
          activityId: activity.id,
          integration: streamIntegration
        })
      } catch {
        try {
          await calculateWorkoutStress(upsertedWorkout.id, userId)
        } catch {
          // ignore stress calculation error
        }

        await buildStravaStreamRepairTrigger(userId, upsertedWorkout.id, activity.id)
        queuedRepairWorkoutIds.add(upsertedWorkout.id)
      }

      if (detailsFetched % 5 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    const workoutsMissingStreams = await prisma.workout.findMany({
      where: {
        userId,
        source: 'strava',
        streams: null,
        streamsV2: null,
        id: { notIn: Array.from(queuedRepairWorkoutIds) }
      },
      orderBy: {
        date: 'desc'
      },
      take: 5
    })

    if (workoutsMissingStreams.length > 0) {
      for (const workout of workoutsMissingStreams) {
        const activityId = parseInt(workout.externalId)
        if (isNaN(activityId)) continue
        await buildStravaStreamRepairTrigger(userId, workout.id, activityId)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }

    syncSucceeded = true

    return {
      success: true,
      counts: { workouts: workoutsUpserted },
      skipped: workoutsSkipped,
      userId,
      startDate,
      endDate
    }
  } catch (error) {
    syncErrorMessage = error instanceof Error ? error.message : 'Unknown error'
    throw error
  } finally {
    await prisma.integration.update({
      where: { id: integration.id },
      data: {
        syncStatus: syncSucceeded ? 'SUCCESS' : 'FAILED',
        lastSyncAt: syncSucceeded ? new Date() : undefined,
        errorMessage: syncSucceeded ? null : syncErrorMessage
      }
    })
  }
}

/**
 * Process a webhook event from Strava.
 */
export async function processStravaWebhookEvent(userId: string, type: string, payload: any) {
  const { object_type, object_id, aspect_type, updates } = payload

  if (object_type === 'activity') {
    if (aspect_type === 'create' || aspect_type === 'update') {
      const integration = await prisma.integration.findFirst({
        where: {
          userId,
          provider: 'strava'
        },
        select: {
          ingestWorkouts: true,
          settings: true
        }
      })

      if (
        !shouldIngestActivities(
          'strava',
          integration?.ingestWorkouts,
          (integration?.settings as Record<string, any> | null) || {}
        )
      ) {
        return { handled: true, message: 'Strava activity ingestion disabled' }
      }

      await dispatchTask(
        'ingest-strava-activity',
        {
          userId,
          activityId: object_id,
          isUpdate: aspect_type === 'update'
        },
        {
          concurrencyKey: userId,
          tags: [`user:${userId}`]
        }
      )
      return { handled: true, message: `Triggered ingestion for activity ${object_id}` }
    } else if (aspect_type === 'delete') {
      return prisma.$transaction(async (tx) => {
        const workout = await tx.workout.findUnique({
          where: {
            userId_source_externalId: {
              userId,
              source: 'strava',
              externalId: object_id.toString()
            }
          }
        })

        if (!workout) {
          return { handled: true, message: `Workout ${object_id} not found in DB` }
        }

        if (!workout.isDuplicate) {
          const duplicates = await tx.workout.findMany({
            where: { userId, duplicateOf: workout.id },
            include: { exercises: true }
          })
          const hydrated = duplicates.length
            ? await attachStreamsToWorkouts(duplicates, { fields: [] })
            : []
          const ranked = hydrated
            .map((copy) => ({
              ...copy,
              score: deduplicationService.calculateCompletenessScore(copy)
            }))
            .sort((a, b) => b.score - a.score)
          const survivor = ranked[0]

          if (survivor) {
            await tx.workout.update({
              where: { id: survivor.id, userId },
              data: {
                isDuplicate: false,
                duplicateOf: null,
                plannedWorkoutId: survivor.plannedWorkoutId || workout.plannedWorkoutId
              }
            })
            await tx.workout.updateMany({
              where: {
                userId,
                id: { in: ranked.slice(1).map((copy) => copy.id) }
              },
              data: { isDuplicate: true, duplicateOf: survivor.id }
            })
          }
        }

        await tx.workout.delete({ where: { id: workout.id, userId } })
        return { handled: true, message: `Deleted workout ${workout.id}` }
      })
    }
  } else if (object_type === 'athlete') {
    if (updates && updates.authorized === 'false') {
      const integration = await prisma.integration.findFirst({
        where: {
          userId,
          provider: 'strava'
        }
      })

      if (integration) {
        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            syncStatus: 'FAILED',
            errorMessage: 'User revoked authorization on Strava'
          }
        })
        return { handled: true, message: `Marked integration for user ${userId} as revoked` }
      }
    }
  }

  return { handled: false, message: `Unhandled event type: ${object_type}:${aspect_type}` }
}

// Register task handler for Redis worker execution
registerTaskHandler('ingest-strava', runIngestStrava)
