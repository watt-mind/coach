import type { Job, Queue } from 'bullmq'
import { Worker } from 'bullmq'
import IORedis from 'ioredis'
import chalk from 'chalk'
import http from 'http'
import v8 from 'node:v8'
import { WORKER_MAX_OLD_SPACE_SIZE_MB } from './ensure-heap'
import { IntervalsService } from '../../server/utils/services/intervalsService'
import { GarminService } from '../../server/utils/services/garminService'
import { WhoopService } from '../../server/utils/services/whoopService'
import { OuraService } from '../../server/utils/services/ouraService'
import { processStravaWebhookEvent } from '../../server/utils/services/stravaService'
import { ResendService } from '../../server/utils/services/resendService'
import { logWebhookRequest, updateWebhookStatus } from '../../server/utils/webhook-logger'
import { Prisma } from '@prisma/client'
import { prisma } from '../../server/utils/db'
import { webhookQueue, pingQueue, streamsQueue, mainTaskQueue } from '../../server/utils/queue'
import { executeRegisteredTask, getRegisteredTaskIds } from '../../server/utils/task-registry'
import {
  ensureTaskHandlersRegistered,
  getLoadedTaskDefinitions,
  type LoadedTaskDefinition
} from './task-handler-loader'
import { getRedisRetryDelay, isRedisConnectionError } from '../../server/utils/redis-connection'
import { formatErrorMessage } from '../../server/utils/log-format'
import { dispatchTask, formatTaskRunId, getTaskDriver } from '../../server/utils/task-dispatcher'
import { publishTaskRunUpdateEvent } from '../../server/utils/task-run-events'
import { Command } from 'commander'
import * as Sentry from '@sentry/node'

export async function registerScheduledTasks(
  queue: {
    getJobSchedulers: (
      start?: number,
      end?: number,
      asc?: boolean
    ) => Promise<Array<{ key: string }>>
    removeJobScheduler: (key: string) => Promise<unknown>
    upsertJobScheduler: (
      id: string,
      scheduler: { pattern: string; tz?: string },
      jobTemplate: {
        name: string
        data?: any
        opts?: any
      }
    ) => Promise<unknown>
  },
  taskDefinitions: LoadedTaskDefinition[]
): Promise<number> {
  const scheduledTasks = taskDefinitions.filter((task) => task.schedule?.cron)
  const desiredSchedulerIds = new Set(
    scheduledTasks.map((definition) => `task-schedule:${definition.id}`)
  )
  const existingSchedulers = await queue.getJobSchedulers(0, -1, true)
  await Promise.all(
    existingSchedulers
      .filter(
        (scheduler) =>
          scheduler.key.startsWith('task-schedule:') && !desiredSchedulerIds.has(scheduler.key)
      )
      .map((scheduler) => queue.removeJobScheduler(scheduler.key))
  )
  await Promise.all(
    scheduledTasks.map((definition) =>
      queue.upsertJobScheduler(
        `task-schedule:${definition.id}`,
        {
          pattern: definition.schedule!.cron,
          tz: definition.schedule?.timezone || 'UTC'
        },
        {
          name: definition.id,
          data: {
            schedule: {
              scheduleId: `task-schedule:${definition.id}`,
              timezone: definition.schedule?.timezone || 'UTC'
            },
            options: {
              queueName: definition.queue?.name,
              concurrencyLimit: definition.queue?.concurrencyLimit,
              maxDuration: definition.maxDuration,
              tags: ['system:schedule']
            }
          },
          opts: {
            attempts: definition.retry?.maxAttempts || 3,
            backoff: { type: 'exponential', delay: 1000 }
          }
        }
      )
    )
  )
  return scheduledTasks.length
}

export const WEBHOOK_POLL_BATCH_SIZE = 50

export type ClaimedWebhookLog = {
  id: string
  provider: string
  eventType: string | null
  payload: unknown
  headers: unknown
  query: unknown
  error: string | null
}

type WebhookClaimClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
  $executeRaw(query: Prisma.Sql): Promise<number>
}

/**
 * Atomically claim a batch of PENDING webhook logs.
 *
 * Selection and the transition to QUEUED happen in a single statement, so two
 * worker instances polling at the same time can never claim the same row:
 * `FOR UPDATE SKIP LOCKED` makes the loser of the race skip the locked rows
 * instead of waiting for them and re-reading a stale `PENDING` status.
 */
export async function claimPendingWebhookLogs(
  client: WebhookClaimClient,
  limit: number = WEBHOOK_POLL_BATCH_SIZE
): Promise<ClaimedWebhookLog[]> {
  const rows = await client.$queryRaw<ClaimedWebhookLog[]>(Prisma.sql`
    UPDATE "WebhookLog"
    SET "status" = 'QUEUED'
    WHERE "id" IN (
      SELECT "id"
      FROM "WebhookLog"
      WHERE "status" = 'PENDING'
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "provider", "eventType", "payload", "headers", "query", "error"
  `)
  return rows ?? []
}

/**
 * Number of consecutive claim-query failures before the poller escalates.
 *
 * The poller runs every 5s, so this is ~15s of a fully halted webhook pipeline
 * before we alert — long enough to ride out a single connection blip, short
 * enough that a genuinely broken claim query is not silent.
 */
export const WEBHOOK_CLAIM_ESCALATION_THRESHOLD = 3

/**
 * Tracks consecutive failures of the webhook *claim* query specifically.
 *
 * A claim that fails permanently (a malformed statement, a dropped column, a
 * bind parameter Postgres will not accept) halts all webhook processing while
 * producing nothing louder than a `console.error` every 5 seconds — the poller's
 * only escalation path is `isRedisConnectionError`, which such a failure is not.
 * This distinguishes "transient blip" from "the claim query itself is broken"
 * and escalates once per failure streak.
 */
export function createWebhookClaimFailureTracker(options: {
  threshold?: number
  onEscalate: (error: unknown, consecutiveFailures: number) => void
}) {
  const threshold = options.threshold ?? WEBHOOK_CLAIM_ESCALATION_THRESHOLD
  let consecutiveFailures = 0
  let escalated = false

  return {
    /** A successful claim ends the streak and re-arms escalation. */
    recordSuccess(): void {
      consecutiveFailures = 0
      escalated = false
    },
    /** Returns the current streak length. Escalates once when it crosses the threshold. */
    recordFailure(error: unknown): number {
      consecutiveFailures++
      if (consecutiveFailures >= threshold && !escalated) {
        escalated = true
        options.onEscalate(error, consecutiveFailures)
      }
      return consecutiveFailures
    },
    get consecutiveFailures(): number {
      return consecutiveFailures
    },
    get hasEscalated(): boolean {
      return escalated
    }
  }
}

/**
 * Hand a claimed webhook log back to the poller when the BullMQ enqueue failed,
 * so the webhook is retried instead of being stranded in QUEUED with no job.
 * Guarded on `status = 'QUEUED'` so it can never resurrect a row that another
 * code path has already moved to a terminal status.
 */
export async function releaseClaimedWebhookLog(
  client: WebhookClaimClient,
  id: string
): Promise<void> {
  await client.$executeRaw(Prisma.sql`
    UPDATE "WebhookLog"
    SET "status" = 'PENDING'
    WHERE "id" = ${id} AND "status" = 'QUEUED'
  `)
}

/**
 * Map a claimed webhook log onto the BullMQ job name + payload the webhook
 * worker expects.
 */
export function buildWebhookJob(log: ClaimedWebhookLog): {
  queueJobName: string
  jobData: Record<string, unknown>
} {
  let queueJobName = `${log.provider}-webhook`
  let provider = log.provider
  let jobData: Record<string, unknown> = {
    provider,
    type: log.eventType,
    payload: log.payload,
    headers: log.headers,
    query: log.query,
    logId: log.id,
    // Oauth specific fields if any were stored in error or similar
    appName: log.eventType?.startsWith('oauth:') ? log.eventType.split(':')[1] : 'unknown',
    secretMatched: log.error === 'SECRET_MATCHED'
  }

  if (provider === 'intervals-bulk' || provider === 'intervals') {
    queueJobName = 'intervals-webhook-bulk'
    provider = 'intervals-bulk' // Force bulk handler for both
    jobData.provider = provider
  } else if (provider === 'oauth-generic') {
    queueJobName = 'oauth-webhook'
  } else if (provider === 'resend') {
    const payload = (log.payload || {}) as Record<string, any>
    jobData = {
      provider: 'resend',
      type: payload.type || log.eventType,
      data: payload.data,
      createdAt: payload.created_at,
      logId: log.id
    }
  }

  return { queueJobName, jobData }
}

/**
 * Enqueue an already-claimed batch of webhook logs.
 *
 * The claim flips the whole batch to QUEUED up front, so this function owns the
 * invariant that every row it was handed either ends up with a job or goes back
 * to PENDING. If an enqueue throws we abandon the batch (the caller treats it as
 * a poll-level failure and may restart the worker), which means every row we
 * have not enqueued yet must be released first — nothing re-picks a QUEUED row,
 * since the claim query selects only PENDING and there is no reaper for stale
 * QUEUED rows.
 */
export async function drainClaimedWebhookLogs(
  client: WebhookClaimClient,
  queue: Pick<Queue, 'add'>,
  claimedLogs: ClaimedWebhookLog[]
): Promise<void> {
  for (let i = 0; i < claimedLogs.length; i++) {
    const log = claimedLogs[i]!
    const { queueJobName, jobData } = buildWebhookJob(log)

    try {
      await queue.add(queueJobName, jobData)
    } catch (addErr) {
      for (const stranded of claimedLogs.slice(i)) {
        try {
          await releaseClaimedWebhookLog(client, stranded.id)
        } catch (releaseErr) {
          console.error(
            chalk.red(`[Poller] Failed to release webhook log ${stranded.id} back to PENDING:`),
            releaseErr
          )
        }
      }
      throw addErr
    }
  }
}

export const startCommand = new Command('start')
  .description('Start the webhook worker')
  .action(async () => {
    await ensureTaskHandlersRegistered()
    const taskDefinitions = getLoadedTaskDefinitions()
    const registeredTaskIds = new Set(getRegisteredTaskIds())
    const missingTaskIds = taskDefinitions
      .map((task) => task.id)
      .filter((taskId) => !registeredTaskIds.has(taskId))
    if (missingTaskIds.length > 0) {
      throw new Error(`Redis task handlers missing at worker startup: ${missingTaskIds.join(', ')}`)
    }
    if (process.env.SENTRY_DSN) {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: 0.2
      })
      console.log(chalk.green('✔ Sentry error tracking initialized for worker'))
    }

    const connectionString = process.env.REDIS_URL || 'redis://localhost:6379'
    const healthPort = parseInt(process.env.CW_WORKER_HEALTH_PORT || '8081')
    const verboseWorkerLogs = process.env.CW_VERBOSE_WORKER_LOGS === '1'

    const heapLimitMb = Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024))
    console.log(chalk.blue.bold('Initializing Webhook Worker...'))
    console.log(
      chalk.gray(
        `V8 heap limit: ${heapLimitMb}MB (target ${WORKER_MAX_OLD_SPACE_SIZE_MB}MB via NODE_OPTIONS)`
      )
    )
    console.log(chalk.gray(`Using REDIS_URL connection string`))

    const connection = new IORedis(connectionString, {
      maxRetriesPerRequest: null, // Required by BullMQ
      retryStrategy: (times) => getRedisRetryDelay(times)
    })

    if (getTaskDriver() === 'redis') {
      const registeredCount = await registerScheduledTasks(mainTaskQueue, taskDefinitions)
      console.log(chalk.green(`✔ Registered ${registeredCount} Redis task schedules`))
    }

    const concurrency = parseInt(process.env.CW_WORKER_QUEUE_WEBHOOK_CONCURRENCY || '5')
    const streamConcurrency = parseInt(process.env.CW_WORKER_QUEUE_STREAM_CONCURRENCY || '2')
    let restartRequested = false
    const taskConcurrencyByKey = new Map<string, { active: number; waiters: Array<() => void> }>()
    const runWithConcurrencyKey = async <T>(
      key: string | undefined,
      limit: number,
      work: () => Promise<T>
    ) => {
      if (!key) return work()

      const state = taskConcurrencyByKey.get(key) || { active: 0, waiters: [] }
      taskConcurrencyByKey.set(key, state)
      if (state.active >= limit) {
        await new Promise<void>((resolve) => state.waiters.push(resolve))
      }
      state.active++
      try {
        return await work()
      } finally {
        state.active--
        state.waiters.shift()?.()
        if (state.active === 0 && state.waiters.length === 0) taskConcurrencyByKey.delete(key)
      }
    }

    const requestRestart = (reason: string, error?: unknown) => {
      if (restartRequested) return
      restartRequested = true

      console.error(chalk.red.bold(`[Worker] Restarting process: ${reason}`), error || '')
      setTimeout(() => process.exit(1), 100)
    }

    // --- Health Check Server ---
    const healthServer = http.createServer(async (req, res) => {
      if (req.url === '/api/health' && req.method === 'GET') {
        try {
          const [webhookCounts, pingCounts, streamCounts, mainTaskCounts] = await Promise.all([
            webhookQueue.getJobCounts(
              'waiting',
              'active',
              'completed',
              'failed',
              'delayed',
              'paused'
            ),
            pingQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
            streamsQueue.getJobCounts(
              'waiting',
              'active',
              'completed',
              'failed',
              'delayed',
              'paused'
            ),
            mainTaskQueue.getJobCounts(
              'waiting',
              'active',
              'completed',
              'failed',
              'delayed',
              'paused'
            )
          ])

          const status = {
            status: 'ok',
            worker: 'webhook-worker',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            redis: connection.status,
            queues: {
              webhook: webhookCounts,
              ping: pingCounts,
              streams: streamCounts,
              mainTasks: mainTaskCounts
            },
            config: {
              concurrency,
              streamConcurrency,
              healthPort
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(status))
        } catch (error: any) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', message: error.message }))
        }
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    healthServer.listen(healthPort, '0.0.0.0', () => {
      console.log(chalk.green(`✔ Health server listening on port ${healthPort} (0.0.0.0)`))
    })

    // Redis Connection Logging
    connection.on('connect', () => {
      const options = connection.options
      const host = options.host
      const port = options.port
      const family = options.family
      const db = options.db
      const hasPassword = !!options.password
      const tls = !!options.tls

      console.log(chalk.green(`✔ Redis connected`))
      console.log(chalk.gray(`  Host: ${host}`))
      console.log(chalk.gray(`  Port: ${port}`))
      console.log(chalk.gray(`  Family: IPv${family}`))
      console.log(chalk.gray(`  Database: ${db}`))
      console.log(chalk.gray(`  TLS: ${tls ? 'Yes' : 'No'}`))
      console.log(chalk.gray(`  Password: ${hasPassword ? 'Yes' : 'No'}`))
    })
    connection.on('ready', () => console.log(chalk.green.bold('✔ Redis ready to accept commands')))
    connection.on('error', (err) =>
      console.warn(chalk.yellow.bold('⚠ Redis connection warning:'), err.message)
    )
    connection.on('reconnecting', () => console.log(chalk.yellow('↻ Redis reconnecting...')))
    connection.on('end', () => {
      console.log(chalk.red('Redis connection ended'))
      requestRestart('redis connection ended')
    })

    // --- Webhook Worker ---
    const webhookWorker = new Worker(
      'webhookQueue',
      async (job: Job) => {
        const { provider, type, userId, event, logId } = job.data

        // Handle bulk ingest jobs from the async API endpoint
        if (provider === 'intervals-bulk') {
          const { payload, headers } = job.data
          const events = payload.events || []

          // Redis-first requests need a parent log. SQL fallback requests already
          // have one and must keep that identity through terminal dispatch.
          const parentLogId =
            logId ||
            (
              await logWebhookRequest({
                provider: 'intervals-bulk',
                eventType: events[0]?.type || 'UNKNOWN',
                payload,
                headers,
                status: 'PENDING'
              })
            )?.id

          let queuedCount = 0
          let orphanedCount = 0
          try {
            for (const intervalEvent of events) {
              const { athlete_id, type: eventType } = intervalEvent
              if (!athlete_id) continue

              const integration = await prisma.integration.findFirst({
                where: {
                  provider: 'intervals',
                  externalUserId: athlete_id.toString()
                }
              })

              if (!integration) {
                // Routine: the athlete deleted their account or unlinked Intervals.icu
                // and the provider is still sending events. Not a failure — keep it out
                // of the default log stream; the count is persisted on the parent log.
                orphanedCount++
                if (verboseWorkerLogs) {
                  console.debug(
                    chalk.gray(
                      `[BulkJob ${job.id}] Skipping orphaned event, no integration for athlete_id: ${athlete_id}`
                    )
                  )
                }
                continue
              }

              const childLog = await logWebhookRequest({
                provider: 'intervals',
                eventType: eventType || 'UNKNOWN',
                payload: intervalEvent,
                headers,
                status: 'PENDING'
              })

              await webhookQueue.add('intervals-webhook', {
                provider: 'intervals',
                type: eventType,
                userId: integration.userId,
                event: intervalEvent,
                logId: childLog?.id
              })
              queuedCount++
            }

            if (parentLogId) {
              await updateWebhookStatus(
                parentLogId,
                queuedCount > 0 ? 'PROCESSED' : 'IGNORED',
                orphanedCount > 0
                  ? `Dispatched ${queuedCount} child events (${orphanedCount} orphaned, no integration)`
                  : `Dispatched ${queuedCount} child events`
              )
            }
            return { queuedCount }
          } catch (error) {
            if (parentLogId) {
              await updateWebhookStatus(
                parentLogId,
                'FAILED',
                error instanceof Error ? error.message : String(error)
              )
            }
            throw error
          }
        }

        if (provider === 'oauth-generic') {
          const { appName, logId, secretMatched } = job.data
          console.log(
            chalk.cyan(`[OAuthJob ${job.id}]`) +
              ` Received push for ${chalk.bold(appName)} (LogID: ${logId}). Secret Matched: ${secretMatched ? chalk.green('YES') : chalk.red('NO')}`
          )

          if (logId) {
            await updateWebhookStatus(logId, 'PROCESSED', `Captured data for ${appName}`)
          }
          return { handled: true, appName }
        }

        if (provider === 'whoop') {
          const { type, payload, headers } = job.data
          let { userId, logId } = job.data

          // 1. Log if not already logged (e.g. from async endpoint)
          if (!logId) {
            const log = await logWebhookRequest({
              provider: 'whoop',
              eventType: payload?.type || 'UNKNOWN',
              payload,
              headers,
              status: 'PENDING'
            })
            logId = log?.id
          }

          console.log(
            chalk.cyan(`[WhoopJob ${job.id}]`) +
              ` Processing Whoop event ${type || payload?.type} (LogID: ${logId})`
          )

          // 2. Resolve User ID if missing
          if (!userId) {
            const externalUserId = payload?.user_id
            if (externalUserId) {
              const integration = await prisma.integration.findFirst({
                where: {
                  provider: 'whoop',
                  externalUserId: externalUserId.toString()
                }
              })
              userId = integration?.userId
            }
          }

          if (!userId) {
            console.warn(`[WhoopJob ${job.id}] No user found for whoop payload`)
            if (logId) await updateWebhookStatus(logId, 'IGNORED', 'User not found')
            return { handled: false, message: 'User not found' }
          }

          // 3. Process Event
          try {
            const eventType = type || payload?.type
            const result = await WhoopService.processWebhookEvent(userId, eventType, payload)

            console.log(chalk.green(`[WhoopJob ${job.id}] Completed: ${result.message}`))

            if (logId) {
              await updateWebhookStatus(logId, 'PROCESSED', result.message)
            }
            return result
          } catch (error: any) {
            console.error(chalk.red(`[WhoopJob ${job.id}] Failed:`), error)
            if (logId) {
              await updateWebhookStatus(logId, 'FAILED', error.message || 'Unknown error')
            }
            throw error
          }
        }

        if (provider === 'fitbit') {
          const { payload, logId } = job.data

          console.log(
            chalk.cyan(`[FitbitJob ${job.id}]`) +
              ` Processing Fitbit webhook payload with ${chalk.yellow(payload.length)} events`
          )

          let triggeredCount = 0

          for (const update of payload) {
            const { collectionType, date, ownerId } = update

            if (collectionType === 'userRevokedAccess') {
              console.log(chalk.yellow(`[FitbitJob ${job.id}] User revoked access: ${ownerId}`))
              continue
            }

            if (!date) {
              console.warn(
                chalk.yellow(
                  `[FitbitJob ${job.id}] Skipping update without date: ${collectionType}`
                )
              )
              continue
            }

            // Resolve User
            const integration = await prisma.integration.findFirst({
              where: {
                provider: 'fitbit',
                externalUserId: ownerId
              }
            })

            if (!integration) {
              console.warn(`[FitbitJob ${job.id}] No integration found for ownerId: ${ownerId}`)
              continue
            }

            try {
              await dispatchTask(
                'ingest-fitbit',
                {
                  userId: integration.userId,
                  startDate: date,
                  endDate: date
                },
                {
                  concurrencyKey: integration.userId,
                  tags: [`user:${integration.userId}`]
                }
              )
              triggeredCount++
              console.log(
                chalk.green(
                  `[FitbitJob ${job.id}] Triggered sync for user ${integration.userId} on ${date}`
                )
              )
            } catch (err) {
              console.error(chalk.red(`[FitbitJob ${job.id}] Failed to trigger sync:`), err)
            }
          }

          if (logId) {
            await updateWebhookStatus(logId, 'PROCESSED', `Triggered ${triggeredCount} syncs`)
          }

          return { triggeredCount }
        }

        if (provider === 'oura') {
          const { type, payload, headers } = job.data
          let { userId, logId } = job.data

          if (!logId) {
            const log = await logWebhookRequest({
              provider: 'oura',
              eventType: payload?.event_type || type || 'UNKNOWN',
              payload,
              headers,
              status: 'PENDING'
            })
            logId = log?.id
          }

          console.log(
            chalk.cyan(`[OuraJob ${job.id}]`) +
              ` Processing Oura event ${type || payload?.event_type} (LogID: ${logId})`
          )

          if (!userId) {
            const externalUserId = payload?.user_id
            if (externalUserId) {
              const integration = await prisma.integration.findFirst({
                where: {
                  provider: 'oura',
                  externalUserId: externalUserId.toString()
                }
              })
              userId = integration?.userId
            }
          }

          if (!userId) {
            console.warn(`[OuraJob ${job.id}] No user found for oura payload`)
            if (logId) await updateWebhookStatus(logId, 'IGNORED', 'User not found')
            return { handled: false, message: 'User not found' }
          }

          try {
            // OuraService.processWebhookEvent expects (userId, type, payload)
            const eventType = type || payload?.event_type
            const result = await OuraService.processWebhookEvent(userId, eventType, payload)

            console.log(chalk.green(`[OuraJob ${job.id}] Completed: ${result.message}`))
            if (logId) await updateWebhookStatus(logId, 'PROCESSED', result.message)
            return result
          } catch (error: any) {
            console.error(chalk.red(`[OuraJob ${job.id}] Failed:`), error)
            if (logId) await updateWebhookStatus(logId, 'FAILED', error.message || 'Unknown error')
            throw error
          }
        }

        if (provider === 'polar') {
          const { type, payload, headers, userId, logId } = job.data

          console.log(
            chalk.cyan(`[PolarJob ${job.id}]`) + ` Processing Polar event ${type} (LogID: ${logId})`
          )

          try {
            // Trigger ingest-polar task for the user
            // Polar webhook payload might contain specific data URLs, but we usually sync everything
            // Or we could be smarter. The payload has `url`?
            // "Webhook payload contains event type ... and possible url related to event."
            // But our ingestPolarTask calls syncUser which lists everything.
            // That's safer but maybe heavier.
            // For now, triggering full sync is fine.

            // Wait, we need to pass userId. It's in the job data.
            await dispatchTask(
              'ingest-polar',
              {
                userId
              },
              {
                concurrencyKey: userId,
                tags: [`user:${userId}`]
              }
            )

            console.log(chalk.green(`[PolarJob ${job.id}] Triggered sync for user ${userId}`))

            if (logId) {
              await updateWebhookStatus(logId, 'PROCESSED', 'Triggered sync')
            }
            return { handled: true }
          } catch (error: any) {
            console.error(chalk.red(`[PolarJob ${job.id}] Failed:`), error)
            if (logId) await updateWebhookStatus(logId, 'FAILED', error.message || 'Unknown error')
            throw error
          }
        }

        if (provider === 'strava') {
          const { type, payload, headers } = job.data
          let { userId, logId } = job.data

          if (!logId) {
            const log = await logWebhookRequest({
              provider: 'strava',
              eventType: payload?.object_type
                ? `${payload.object_type}:${payload.aspect_type}`
                : type || 'UNKNOWN',
              payload,
              headers,
              status: 'PENDING'
            })
            logId = log?.id
          }

          console.log(
            chalk.cyan(`[StravaJob ${job.id}]`) +
              ` Processing Strava event ${type || payload?.object_type + ':' + payload?.aspect_type} (LogID: ${logId})`
          )

          if (!userId) {
            const externalUserId = payload?.owner_id
            if (externalUserId) {
              const integration = await prisma.integration.findFirst({
                where: {
                  provider: 'strava',
                  externalUserId: externalUserId.toString()
                }
              })
              userId = integration?.userId
            }
          }

          if (!userId) {
            // Routine: Strava keeps delivering events for athletes who deleted their
            // account or revoked the connection. Not a failure — the IGNORED webhook
            // log below is the durable record, so keep it out of the default stream.
            if (verboseWorkerLogs) {
              console.debug(
                chalk.gray(`[StravaJob ${job.id}] Skipping orphaned event, no user for payload`)
              )
            }
            if (logId) await updateWebhookStatus(logId, 'IGNORED', 'User not found')
            return { handled: false, message: 'User not found' }
          }

          try {
            const eventType = type || `${payload.object_type}:${payload.aspect_type}`
            const result = await processStravaWebhookEvent(userId, eventType, payload)

            console.log(chalk.green(`[StravaJob ${job.id}] Completed: ${result.message}`))
            if (logId) await updateWebhookStatus(logId, 'PROCESSED', result.message)
            return result
          } catch (error: any) {
            console.error(chalk.red(`[StravaJob ${job.id}] Failed:`), error)
            if (logId) await updateWebhookStatus(logId, 'FAILED', error.message || 'Unknown error')
            throw error
          }
        }

        if (provider === 'resend') {
          const { type, data, createdAt, logId } = job.data

          if (verboseWorkerLogs) {
            console.log(
              chalk.cyan(`[ResendJob ${job.id}]`) +
                ` Processing Resend event ${type} (LogID: ${logId})`
            )
          }

          try {
            const result = await ResendService.processWebhookEvent(type, data, createdAt)

            if (verboseWorkerLogs) {
              console.log(chalk.green(`[ResendJob ${job.id}] Completed: ${result.message}`))
            }
            if (logId) await updateWebhookStatus(logId, 'PROCESSED', result.message)
            return result
          } catch (error: any) {
            console.error(chalk.red(`[ResendJob ${job.id}] Failed:`), error)
            if (logId) await updateWebhookStatus(logId, 'FAILED', error.message || 'Unknown error')
            throw error
          }
        }

        if (provider === 'garmin') {
          const { payload, headers, query } = job.data
          let { logId } = job.data

          // Log if not already logged (e.g. from async endpoint)
          if (!logId) {
            const log = await logWebhookRequest({
              provider: 'garmin',
              eventType: 'PUSH',
              payload,
              headers,
              query,
              status: 'PENDING'
            })
            logId = log?.id
          }

          console.log(
            chalk.cyan(`[GarminJob ${job.id}]`) + ` Processing Garmin event PUSH (LogID: ${logId})`
          )

          try {
            const result = await GarminService.processWebhookEvent(payload, { query, headers })

            console.log(chalk.green(`[GarminJob ${job.id}] Completed: ${result.message}`))
            if (logId) {
              await updateWebhookStatus(
                logId,
                result.handled ? 'PROCESSED' : 'IGNORED',
                result.message
              )
            }
            return result
          } catch (error: any) {
            console.error(chalk.red(`[GarminJob ${job.id}] Failed:`), error)
            if (logId) await updateWebhookStatus(logId, 'FAILED', error.message || 'Unknown error')
            throw error
          }
        }

        try {
          if (provider === 'intervals') {
            const result = await IntervalsService.processWebhookEvent(userId, type, event)

            if (logId) {
              await updateWebhookStatus(logId, 'PROCESSED')
            }
            return result
          } else {
            throw new Error(`Unknown provider: ${provider}`)
          }
        } catch (error: any) {
          console.error(chalk.red(`[WebhookJob ${job.id}] Failed:`), formatErrorMessage(error))
          if (logId) {
            await updateWebhookStatus(logId, 'FAILED', error.message || 'Unknown error')
          }
          throw error
        }
      },
      { connection, concurrency }
    )

    webhookWorker.on('ready', () => {
      console.log(chalk.green.bold('🚀 Webhook Worker listening on "webhookQueue"'))
      console.log(chalk.white(`   Concurrency: ${chalk.yellow(concurrency)}`))
    })

    webhookWorker.on('failed', (job, err) => {
      const message = err?.message || 'Unknown error'
      if (message === 'job stalled more than allowable limit') return
      console.log(chalk.red(`[WebhookJob ${job?.id}] has failed with: ${message}`))
    })

    webhookWorker.on('error', (err) => {
      console.error(chalk.red.bold('Webhook Worker error:'), err)
      if (isRedisConnectionError(err)) {
        requestRestart('webhook worker lost redis connectivity', err)
      }
    })

    // --- Webhook Log Poller ---
    // This loop checks for PENDING webhooks in SQL and moves them to BullMQ.
    //
    // A claim query that is broken rather than merely unlucky halts every
    // webhook in the system. Escalate it loudly instead of letting it scroll
    // past as a console.error once every 5 seconds.
    const claimFailures = createWebhookClaimFailureTracker({
      onEscalate: (error, consecutiveFailures) => {
        const detail = formatErrorMessage(error)
        console.error(
          chalk.red.bold(
            `[Poller] WEBHOOK INGESTION HALTED — the claim query has failed ${consecutiveFailures} consecutive times. ` +
              `No webhook has been queued since the streak began. This is not a transient error; ` +
              `the claim statement itself is likely broken. Last error: ${detail}`
          )
        )
        if (process.env.SENTRY_DSN) {
          Sentry.captureException(error, {
            level: 'fatal',
            tags: { worker: 'webhookPoller', failure: 'claim-query' },
            extra: { consecutiveFailures, batchSize: WEBHOOK_POLL_BATCH_SIZE }
          })
        }
      }
    })

    const pollWebhooks = async () => {
      // Claim the batch atomically: the rows come back already flipped to
      // QUEUED, so a second worker polling concurrently cannot pick them up.
      let claimedLogs: ClaimedWebhookLog[]
      try {
        claimedLogs = await claimPendingWebhookLogs(prisma, WEBHOOK_POLL_BATCH_SIZE)
        claimFailures.recordSuccess()
      } catch (err) {
        const streak = claimFailures.recordFailure(err)
        console.error(
          chalk.red(`[Poller] Claim query failed (consecutive failures: ${streak}):`),
          err
        )
        if (isRedisConnectionError(err)) {
          requestRestart('sql-to-queue poller lost redis connectivity', err)
        }
        return
      }

      if (claimedLogs.length === 0) return

      if (verboseWorkerLogs) {
        console.log(chalk.gray(`[Poller] Claimed ${claimedLogs.length} pending webhooks in SQL`))
      }

      try {
        await drainClaimedWebhookLogs(prisma, webhookQueue, claimedLogs)
      } catch (err) {
        // Drain failures are already self-healing: drainClaimedWebhookLogs hands
        // every un-enqueued row back to PENDING before rethrowing.
        console.error(chalk.red('[Poller] Error draining claimed webhooks:'), err)
        if (isRedisConnectionError(err)) {
          requestRestart('sql-to-queue poller lost redis connectivity', err)
        }
      }
    }

    const pollerInterval = setInterval(pollWebhooks, 5000) // Poll every 5 seconds
    const pingWorker = new Worker(
      'pingQueue',
      async (job: Job) => {
        const { provider } = job.data
        console.log(
          chalk.cyan(`[PingJob ${job.id}]`) +
            ` Processing ping...
`
        )

        if (provider === 'ping') {
          console.log(chalk.green(`[PingJob ${job.id}] PONG! Ping received successfully.`))
          return { handled: true, message: 'PONG' }
        }
        throw new Error(`Unknown provider for ping queue: ${provider}`)
      },
      { connection, concurrency: 1 }
    )

    pingWorker.on('ready', () => {
      console.log(chalk.green.bold('🚀 Ping Worker listening on "pingQueue"'))
    })

    pingWorker.on('failed', (job, err) => {
      console.log(chalk.red(`[PingJob ${job?.id}] has failed with: ${err?.message}`))
    })

    pingWorker.on('error', (err) => {
      console.error(chalk.red.bold('Ping Worker error:'), err)
      if (isRedisConnectionError(err)) {
        requestRestart('ping worker lost redis connectivity', err)
      }
    })

    const streamsWorker = new Worker(
      'streamsQueue',
      async (job: Job) => {
        const { userId, workoutId, activityId } = job.data

        if (!userId || !workoutId || !activityId) {
          throw new Error('Missing stream sync job payload')
        }

        console.log(
          chalk.cyan(`[StreamJob ${job.id}]`) +
            ` Syncing Intervals streams for activity ${activityId} (workout ${workoutId})`
        )

        const result = await IntervalsService.syncActivityStream(userId, workoutId, activityId)

        console.log(
          chalk.green(`[StreamJob ${job.id}] Completed stream sync for activity ${activityId}`)
        )

        return { workoutId, activityId, hasStreamData: result !== null }
      },
      { connection, concurrency: streamConcurrency }
    )

    streamsWorker.on('ready', () => {
      console.log(chalk.green.bold('🚀 Streams Worker listening on "streamsQueue"'))
      console.log(chalk.white(`   Concurrency: ${chalk.yellow(streamConcurrency)}`))
    })

    streamsWorker.on('failed', (job, err) => {
      const message = err?.message || 'Unknown error'
      if (message === 'job stalled more than allowable limit') return
      console.log(chalk.red(`[StreamJob ${job?.id}] has failed with: ${message}`))
    })

    streamsWorker.on('error', (err) => {
      console.error(chalk.red.bold('Streams Worker error:'), err)
      if (isRedisConnectionError(err)) {
        requestRestart('streams worker lost redis connectivity', err)
      }
    })

    const taskConcurrency = parseInt(process.env.CW_WORKER_QUEUE_TASK_CONCURRENCY || '3')
    const mainTaskWorker = new Worker(
      'mainTaskQueue',
      async (job: Job) => {
        const taskId = job.name
        const scheduled = job.data?.schedule
        const payload = scheduled
          ? {
              scheduleId: scheduled.scheduleId,
              type: 'DECLARATIVE',
              timestamp: new Date(job.timestamp),
              timezone: scheduled.timezone || 'UTC',
              upcoming: []
            }
          : job.data?.payload
        const options = job.data?.options || {}
        const tags = Array.isArray(options.tags) ? options.tags : []
        const userTag = tags.find(
          (tag: unknown) => typeof tag === 'string' && tag.startsWith('user:')
        )
        const userId = typeof userTag === 'string' ? userTag.slice('user:'.length) : null
        const runId = formatTaskRunId('redis', String(job.id))
        console.log(
          chalk.cyan(`[TaskJob ${job.id}]`) + ` Processing background task ${chalk.bold(taskId)}`
        )
        if (userId) {
          await publishTaskRunUpdateEvent(userId, taskId, runId, {
            status: 'EXECUTING',
            startedAt: new Date().toISOString(),
            tags
          }).catch((error) => console.warn('[TaskWorker] Failed to publish running event:', error))
        }

        try {
          const queueScope = options.queueName
            ? `${options.queueName}:${options.concurrencyKey || 'global'}`
            : options.concurrencyKey
          const concurrencyLimit = Math.max(1, Number(options.concurrencyLimit) || 5)
          const abortController = new AbortController()
          const maxDurationMs = Number(options.maxDuration) * 1000
          const durationTimer = Number.isFinite(maxDurationMs)
            ? setTimeout(() => abortController.abort(), maxDurationMs)
            : undefined
          const result = await runWithConcurrencyKey(queueScope, concurrencyLimit, () =>
            executeRegisteredTask(taskId, payload, {
              runId,
              signal: abortController.signal,
              attemptNumber: job.attemptsMade + 1,
              maxAttempts: typeof job.opts.attempts === 'number' ? job.opts.attempts : 1
            })
          ).finally(() => {
            if (durationTimer) clearTimeout(durationTimer)
          })
          const finishedAt = new Date().toISOString()
          console.log(chalk.green(`[TaskJob ${job.id}] Completed task ${chalk.bold(taskId)}`))
          if (userId) {
            await publishTaskRunUpdateEvent(userId, taskId, runId, {
              status: 'COMPLETED',
              startedAt: job.processedOn
                ? new Date(job.processedOn).toISOString()
                : new Date(job.timestamp).toISOString(),
              finishedAt,
              output: result,
              tags
            }).catch((error) =>
              console.warn('[TaskWorker] Failed to publish completion event:', error)
            )
          }
          return result
        } catch (error) {
          const configuredAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1
          const isFinalAttempt = job.attemptsMade + 1 >= configuredAttempts
          if (userId) {
            await publishTaskRunUpdateEvent(userId, taskId, runId, {
              status: isFinalAttempt ? 'FAILED' : 'REATTEMPTING',
              startedAt: job.processedOn
                ? new Date(job.processedOn).toISOString()
                : new Date(job.timestamp).toISOString(),
              ...(isFinalAttempt ? { finishedAt: new Date().toISOString() } : {}),
              error: { message: error instanceof Error ? error.message : String(error) },
              tags
            }).catch((publishError) =>
              console.warn('[TaskWorker] Failed to publish failure event:', publishError)
            )
          }
          throw error
        }
      },
      { connection, concurrency: taskConcurrency }
    )

    mainTaskWorker.on('ready', () => {
      console.log(chalk.green.bold('🚀 Main Task Worker listening on "mainTaskQueue"'))
      console.log(chalk.white(`   Concurrency: ${chalk.yellow(taskConcurrency)}`))
    })

    mainTaskWorker.on('failed', (job, err) => {
      const message = err?.message || 'Unknown error'
      if (message === 'job stalled more than allowable limit') return
      console.log(chalk.red(`[TaskJob ${job?.id}] has failed with: ${message}`))
      if (err && process.env.SENTRY_DSN) {
        Sentry.captureException(err, {
          tags: { worker: 'mainTaskWorker', taskId: job?.name },
          extra: { jobId: job?.id, attemptsMade: job?.attemptsMade }
        })
      }
    })

    mainTaskWorker.on('error', (err) => {
      console.error(chalk.red.bold('Main Task Worker error:'), err)
      if (isRedisConnectionError(err)) {
        requestRestart('main task worker lost redis connectivity', err)
      }
    })

    // Stats Reporter
    const statsInterval = setInterval(async () => {
      try {
        const counts = await webhookQueue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
          'delayed'
        )
        const pingCounts = await pingQueue.getJobCounts('waiting', 'active', 'completed', 'failed')
        const streamCounts = await streamsQueue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed'
        )
        const mainTaskCounts = await mainTaskQueue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed'
        )

        console.log(
          chalk.gray('[Stats] ') +
            chalk.bold('Webhook: ') +
            `W:${counts.waiting} A:${counts.active} C:${counts.completed} F:${counts.failed}` +
            chalk.gray(' | ') +
            chalk.bold('Ping: ') +
            `W:${pingCounts.waiting} A:${pingCounts.active} C:${pingCounts.completed} F:${pingCounts.failed}` +
            chalk.gray(' | ') +
            chalk.bold('Streams: ') +
            `W:${streamCounts.waiting} A:${streamCounts.active} C:${streamCounts.completed} F:${streamCounts.failed}` +
            chalk.gray(' | ') +
            chalk.bold('Tasks: ') +
            `W:${mainTaskCounts.waiting} A:${mainTaskCounts.active} C:${mainTaskCounts.completed} F:${mainTaskCounts.failed}`
        )
      } catch (err) {
        console.error(chalk.red('Failed to fetch queue stats:'), err)
        if (isRedisConnectionError(err)) {
          requestRestart('queue stats reporter lost redis connectivity', err)
        }
      }
    }, 30000) // Every 30 seconds

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(
        chalk.yellow(`
      Received ${signal}. Shutting down workers...
`)
      )
      clearInterval(statsInterval)
      clearInterval(pollerInterval)

      try {
        healthServer.close()
        console.log(chalk.gray('Health server closed.'))

        await Promise.all([
          webhookWorker.close(),
          pingWorker.close(),
          streamsWorker.close(),
          mainTaskWorker.close()
        ])
        console.log(chalk.gray('Workers closed.'))

        await Promise.all([
          webhookQueue.close(),
          pingQueue.close(),
          streamsQueue.close(),
          mainTaskQueue.close()
        ])
        console.log(chalk.gray('Queues closed.'))

        await connection.quit()
        console.log(chalk.gray('Redis connection closed.'))

        await prisma.$disconnect()
        console.log(chalk.gray('Prisma disconnected.'))

        process.exit(0)
      } catch (err) {
        console.error(chalk.red('Error during shutdown:'), err)
        process.exit(1)
      }
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  })
