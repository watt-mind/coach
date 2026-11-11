import './init'
import { logger, task } from '@trigger.dev/sdk/v3'
import { prisma } from '../server/utils/db'

// Twice the 300-second task duration, allowing conservative recovery after interruption.
export const SYNC_CLAIM_LEASE_MS = 10 * 60 * 1000

/**
 * Process Sync Queue - Retry failed Intervals.icu syncs
 *
 * This task processes pending sync operations.
 * It retries failed syncs to Intervals.icu for planned workouts and availability.
 *
 * Max attempts: 3 per operation
 * After 3 failures, the item is marked as FAILED and removed from retry queue.
 */
export const processSyncQueueTask = task({
  id: 'process-sync-queue',
  maxDuration: 300, // 5 minutes max
  run: async (payload: any) => {
    logger.log('Starting sync queue processing')

    try {
      // Fetch all pending sync operations
      // SyncQueue is a system utility table, not a core domain model like Workout/Nutrition.
      // Direct prisma access here is acceptable as it's not subject to business logic like duplicates.
      const pendingItems = await prisma.syncQueue.findMany({
        where: {
          OR: [
            { status: 'PENDING', attempts: { lt: 3 } },
            {
              status: 'PROCESSING',
              OR: [
                { lastAttempt: null },
                { lastAttempt: { lt: new Date(Date.now() - SYNC_CLAIM_LEASE_MS) } }
              ]
            }
          ]
        },
        orderBy: {
          createdAt: 'asc' // Oldest first
        },
        take: 50 // Process max 50 items per run
      })

      logger.log(`Found ${pendingItems.length} pending sync operations`)

      if (pendingItems.length === 0) {
        return {
          success: true,
          processed: 0,
          succeeded: 0,
          failed: 0,
          message: 'No pending items to process'
        }
      }

      let succeeded = 0
      let failed = 0

      // Process each item
      for (const item of pendingItems) {
        const abandoned = item.status === 'PROCESSING'
        const attempts = item.attempts + (abandoned ? 1 : 0)
        const claimTimestamp = new Date()
        // Include the observed timestamp and budget: only one recovery contender can win.
        const claimed = await prisma.syncQueue.updateMany({
          where: {
            id: item.id,
            status: abandoned ? 'PROCESSING' : 'PENDING',
            lastAttempt: item.lastAttempt,
            attempts: item.attempts
          },
          data:
            attempts >= 3
              ? { status: 'FAILED', attempts, error: 'Sync claim expired after maximum attempts' }
              : { status: 'PROCESSING', attempts, lastAttempt: claimTimestamp }
        })

        if (claimed.count === 0) {
          logger.log(`Skipping sync item ${item.id} - already claimed by another worker`)
          continue
        }

        if (attempts >= 3) {
          failed++
          continue
        }

        try {
          const { processSyncQueueItem } = await import('../server/utils/intervals-sync')
          // The helper owns completion/retry writes, including SUPERSEDED and permanent failures.
          const success = await processSyncQueueItem({
            ...item,
            status: 'PROCESSING',
            attempts,
            lastAttempt: claimTimestamp
          })
          if (success) succeeded++
          else failed++
        } catch (error) {
          await prisma.syncQueue.updateMany({
            where: { id: item.id, status: 'PROCESSING', lastAttempt: claimTimestamp, attempts },
            data: {
              attempts: attempts + 1,
              status: attempts + 1 >= 3 ? 'FAILED' : 'PENDING',
              error: error instanceof Error ? error.message : String(error)
            }
          })
          failed++
        }
      }

      logger.log('Sync queue processing complete', {
        total: pendingItems.length,
        succeeded,
        failed
      })

      return {
        success: true,
        processed: pendingItems.length,
        succeeded,
        failed
      }
    } catch (error) {
      logger.error('Error processing sync queue', { error })
      throw error
    }
  }
})
