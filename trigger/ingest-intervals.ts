import './init'
import { logger, task } from '@trigger.dev/sdk/v3'
import { userIngestionQueue } from './queues'
import { prisma } from '../server/utils/db'
import { IntervalsService } from '../server/utils/services/intervalsService'
import { metabolicService } from '../server/utils/services/metabolicService'
import { getUserTimezone, getEndOfDayUTC, getUserLocalDate } from '../server/utils/date'
import { shouldIngestWellness } from '../server/utils/integration-settings'
import { isNutritionTrackingEnabled } from '../server/utils/nutrition/feature'
import type { IngestionResult } from './types'
import { yieldTaskHeartbeat } from '../server/utils/task-runtime'
import { registerTaskHandler } from '../server/utils/task-registry'

type IngestIntervalsPayload = {
  userId: string
  startDate: string
  endDate: string
  manualSync?: boolean
}

/**
 * Prisma raises `P2025` ("An operation failed because it depends on one or more
 * records that were required but not found") when a `where`-targeted row no
 * longer exists. Matched by `code` rather than `instanceof` because the concrete
 * error class differs between the query engines and is re-wrapped by the driver
 * adapter — same duck-typing the rest of the codebase uses (see
 * `server/api/auth/[...].ts`, `server/api/webhooks/revenuecat.post.ts`).
 */
function isRecordNotFoundError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2025'
}

/**
 * Result returned when the Intervals.icu integration row is gone.
 *
 * A user disconnecting the integration while a sync is in flight (or queued for
 * retry) is expected behaviour, not a failure: throwing here would re-run the
 * task up to `maxAttempts` more times and file an identical Sentry event on
 * every attempt. We deliberately return a normal result rather than raising a
 * framework-level "do not retry" signal — the self-hosted BullMQ worker does not
 * honour `AbortTaskRunError` (CW-602), whereas a plain resolved value is
 * terminal on every driver.
 */
function integrationDisconnectedResult(
  payload: Pick<IngestIntervalsPayload, 'userId' | 'startDate' | 'endDate'>
): IngestionResult {
  return {
    success: false,
    counts: {},
    message: 'Intervals.icu integration not found for user; it was disconnected. Skipping sync.',
    userId: payload.userId,
    startDate: payload.startDate,
    endDate: payload.endDate
  }
}

/**
 * Writes the terminal sync status back onto the integration row.
 *
 * Runs from a `finally` block, so it must not throw for the ordinary
 * disconnect race: a throw inside `finally` *replaces* whichever exception was
 * already propagating, which is how the original ingestion error got masked by
 * a `P2025`. Non-`P2025` failures are still surfaced when the sync itself
 * succeeded (nothing is being masked in that case).
 */
async function finalizeSyncStatus(
  integrationId: string,
  outcome: { syncSucceeded: boolean; syncErrorMessage: string | null }
): Promise<void> {
  const { syncSucceeded, syncErrorMessage } = outcome

  try {
    await prisma.integration.update({
      where: { id: integrationId },
      data: {
        syncStatus: syncSucceeded ? 'SUCCESS' : 'FAILED',
        lastSyncAt: syncSucceeded ? new Date() : undefined,
        errorMessage: syncSucceeded ? null : syncErrorMessage,
        ...(syncSucceeded ? { initialSyncCompleted: true } : {})
      }
    })
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      logger.log(
        'Intervals.icu integration was disconnected during sync; skipping sync-status update',
        { integrationId }
      )
      return
    }

    if (!syncSucceeded) {
      // An error from the try block is already propagating — never mask it.
      logger.error('Failed to record Intervals.icu sync failure status', {
        integrationId,
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    throw error
  }
}

export async function runIngestIntervals(
  payload: IngestIntervalsPayload
): Promise<IngestionResult> {
  const { userId, startDate, endDate, manualSync = false } = payload

  logger.log('Starting Intervals.icu ingestion', { userId, startDate, endDate })

  // Fetch integration
  const integration = await prisma.integration.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: 'intervals'
      }
    }
  })

  if (!integration) {
    logger.log('Intervals.icu integration not found for user; skipping ingestion', {
      userId,
      startDate,
      endDate
    })
    return integrationDisconnectedResult(payload)
  }

  // Update sync status. The row can be deleted between the fetch above and this
  // write if the user disconnects mid-flight — that is a clean skip, not a failure.
  try {
    await prisma.integration.update({
      where: { id: integration.id },
      data: { syncStatus: 'SYNCING' }
    })
  } catch (error) {
    if (isRecordNotFoundError(error)) {
      logger.log(
        'Intervals.icu integration was disconnected before the sync started; skipping ingestion',
        { userId, integrationId: integration.id }
      )
      return integrationDisconnectedResult(payload)
    }
    throw error
  }

  let syncSucceeded = false
  let syncErrorMessage: string | null = null

  try {
    const timezone = await getUserTimezone(userId)
    const start = new Date(startDate)
    const end = new Date(endDate)

    // Calculate 'now' to cap historical data fetching
    const now = new Date()
    // Cap at end of today in user's timezone to allow for timezone differences but prevent far future
    const historicalEndLocal = getEndOfDayUTC(timezone, now)

    const historicalEnd = end > historicalEndLocal ? historicalEndLocal : end

    const settings = (integration.settings as Record<string, any> | null) || {}
    const shouldAutoSyncSportSettings =
      manualSync && settings.autoSyncSportSettingsOnManualSync === true

    if (shouldAutoSyncSportSettings) {
      logger.log('Auto-syncing Intervals sport settings during manual sync', { userId })
      try {
        await IntervalsService.syncProfile(userId)
      } catch (error) {
        logger.warn(
          'Failed to auto-sync Intervals sport settings during manual sync; continuing ingestion',
          {
            userId,
            error: error instanceof Error ? error.message : String(error)
          }
        )
      }
    }

    await yieldTaskHeartbeat()

    // Fetch planned workouts (import all categories)
    logger.log('Syncing planned workouts...')
    const {
      plannedWorkouts: plannedWorkoutsUpserted,
      events: eventsUpserted,
      notes: notesUpserted
    } = await IntervalsService.syncPlannedWorkouts(userId, start, end)
    logger.log(
      `Upserted ${plannedWorkoutsUpserted} planned workouts, ${eventsUpserted} racing events, and ${notesUpserted} calendar notes`
    )

    await yieldTaskHeartbeat()

    // Fetch activities
    logger.log('Syncing activities...')
    const workoutsUpserted = await IntervalsService.syncActivities(userId, start, historicalEnd)
    logger.log(`Upserted ${workoutsUpserted} workouts`)

    await yieldTaskHeartbeat()

    let wellnessUpserted = 0
    if (shouldIngestWellness(settings)) {
      logger.log('Syncing wellness data...')
      wellnessUpserted = await IntervalsService.syncWellness(userId, start, historicalEnd)
      logger.log(`Upserted ${wellnessUpserted} wellness entries`)
    } else {
      logger.log('Wellness ingestion disabled for Intervals.icu, skipping')
    }

    syncSucceeded = true

    // REACTIVE: Trigger fueling plan update for today
    // This ensures that newly synced workouts/events are immediately reflected.
    try {
      if (await isNutritionTrackingEnabled(userId)) {
        const today = timezone ? getUserLocalDate(timezone) : new Date()
        await metabolicService.calculateFuelingPlanForDate(userId, today, { persist: true })
      }
    } catch (err) {
      logger.error('Failed to trigger fueling plan update', { err })
    }

    return {
      success: true,
      counts: {
        workouts: workoutsUpserted,
        wellness: wellnessUpserted,
        plannedWorkouts: plannedWorkoutsUpserted,
        events: eventsUpserted
      },
      userId,
      startDate,
      endDate
    }
  } catch (error) {
    logger.error('Error ingesting Intervals data', { error })

    syncErrorMessage = error instanceof Error ? error.message : 'Unknown error'

    throw error
  } finally {
    await finalizeSyncStatus(integration.id, { syncSucceeded, syncErrorMessage })
  }
}

registerTaskHandler('ingest-intervals', runIngestIntervals)

export const ingestIntervalsTask = task({
  id: 'ingest-intervals',
  maxDuration: 14400, // 4 hours
  queue: userIngestionQueue,
  run: runIngestIntervals
})
