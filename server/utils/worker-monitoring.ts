import { prisma } from './db'
import { getRedisConnection, pingQueue, streamsQueue, webhookQueue } from './queue'

export type WorkerHealthStatus = 'ok' | 'degraded' | 'critical'

export type WorkerMonitoringAlert = {
  level: 'warning' | 'critical'
  message: string
}

export const WORKER_MONITORING_THRESHOLDS = {
  redisMemoryPercentDegraded: 80,
  redisMemoryPercentCritical: 95,
  webhookWaitingDegraded: 10_000,
  webhookWaitingCritical: 50_000,
  webhookCompletedDegraded: 10_000,
  webhookCompletedCritical: 50_000,
  webhookFailedDegraded: 100,
  webhookWorkersMinimum: 1,
  sqlPendingDegraded: 5_000,
  sqlProcessedStaleMinutes: 10
} as const

type QueueCounts = {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
  paused: number
}

type RedisMemoryStats = {
  status: string
  usedMemoryBytes: number | null
  maxMemoryBytes: number | null
  usedMemoryPercent: number | null
  usedMemoryHuman: string | null
  maxMemoryHuman: string | null
}

export type WorkerMonitoringSnapshot = {
  status: WorkerHealthStatus
  timestamp: string
  environment: string
  redis: RedisMemoryStats
  queues: {
    webhook: QueueCounts & { workers: number; isPaused: boolean }
    ping: QueueCounts & { workers: number; isPaused: boolean }
    // CW-379 note: `streams` here (and in getWorkerMonitoringSnapshot below) is
    // the BullMQ `streamsQueue` -- job counts for the stream-ingest worker. It
    // has nothing to do with the Workout `streams` relation or the V1/V2 stream
    // tables, so there is nothing to migrate onto workoutStreamRepository.
    streams: QueueCounts & { workers: number; isPaused: boolean }
  }
  webhooks: {
    pending: number
    processedLast10Min: number
    lastActivityAt: string | null
  }
  chatRecovery: ChatRecoveryMonitoringSnapshot
  alerts: WorkerMonitoringAlert[]
}

export type ChatRecoveryMonitoringSnapshot = {
  windowHours: number
  totalTurns: number
  heartbeatTimeouts: number
  heartbeatTimeoutRate: number
  recoveryExhaustions: number
  recoveryExhaustionRate: number
  byDeployment: Record<
    string,
    {
      heartbeatTimeouts: number
      recoveryExhaustions: number
    }
  >
}

export function summarizeChatRecoveryEvents(
  totalTurns: number,
  events: Array<{ data: unknown }>,
  windowHours = 24
): ChatRecoveryMonitoringSnapshot {
  let heartbeatTimeouts = 0
  let recoveryExhaustions = 0
  const byDeployment: ChatRecoveryMonitoringSnapshot['byDeployment'] = {}

  for (const event of events) {
    const data =
      event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? (event.data as Record<string, any>)
        : {}
    const isHeartbeatTimeout =
      data.recoveryReason === 'heartbeat_timeout' || data.reason === 'heartbeat_timeout'
    if (!isHeartbeatTimeout) continue

    heartbeatTimeouts += 1
    const deploymentId = String(data.deploymentId || 'unknown')
    const deployment = (byDeployment[deploymentId] ||= {
      heartbeatTimeouts: 0,
      recoveryExhaustions: 0
    })
    deployment.heartbeatTimeouts += 1

    if (data.reason === 'recovery_attempts_exhausted') {
      recoveryExhaustions += 1
      deployment.recoveryExhaustions += 1
    }
  }

  const rate = (count: number) =>
    totalTurns > 0 ? Math.round((count / totalTurns) * 10_000) / 100 : 0

  return {
    windowHours,
    totalTurns,
    heartbeatTimeouts,
    heartbeatTimeoutRate: rate(heartbeatTimeouts),
    recoveryExhaustions,
    recoveryExhaustionRate: rate(recoveryExhaustions),
    byDeployment
  }
}

function parseInfoValue(info: string, key: string): string | null {
  const match = info.match(new RegExp(`^${key}:(.+)$`, 'm'))
  return match?.[1]?.trim() ?? null
}

function parseHumanMemory(value: string | null): number | null {
  if (!value) return null

  const match = value.trim().match(/^([\d.]+)([KMGTP]?i?B)$/i)
  if (!match) return null

  const amount = Number(match[1])
  const unit = match[2]?.toUpperCase() ?? 'B'
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1_000,
    KIB: 1024,
    MB: 1_000_000,
    MIB: 1024 ** 2,
    GB: 1_000_000_000,
    GIB: 1024 ** 3,
    TB: 1_000_000_000_000,
    TIB: 1024 ** 4,
    PB: 1_000_000_000_000_000,
    PIB: 1024 ** 5
  }

  const multiplier = multipliers[unit]
  if (!multiplier || Number.isNaN(amount)) return null

  return Math.round(amount * multiplier)
}

async function getRedisMemoryStats(): Promise<RedisMemoryStats> {
  const connection = getRedisConnection()

  try {
    const info = await connection.info('memory')
    const status = connection.status
    const usedMemoryBytes = Number(parseInfoValue(info, 'used_memory'))
    const maxMemoryBytes = parseHumanMemory(parseInfoValue(info, 'maxmemory_human'))

    const usedMemoryPercent =
      maxMemoryBytes && Number.isFinite(usedMemoryBytes) && maxMemoryBytes > 0
        ? Math.round((usedMemoryBytes / maxMemoryBytes) * 1000) / 10
        : null

    return {
      status,
      usedMemoryBytes: Number.isFinite(usedMemoryBytes) ? usedMemoryBytes : null,
      maxMemoryBytes,
      usedMemoryPercent,
      usedMemoryHuman: parseInfoValue(info, 'used_memory_human'),
      maxMemoryHuman: parseInfoValue(info, 'maxmemory_human')
    }
  } catch (error) {
    return {
      status: 'error',
      usedMemoryBytes: null,
      maxMemoryBytes: null,
      usedMemoryPercent: null,
      usedMemoryHuman: null,
      maxMemoryHuman: null
    }
  }
}

async function getQueueSnapshot(queue: typeof webhookQueue, name: 'webhook' | 'ping' | 'streams') {
  const [counts, workers, isPaused] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
    queue.getWorkers(),
    queue.isPaused()
  ])

  return {
    name,
    counts: {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0
    },
    workers: workers.length,
    isPaused
  }
}

function evaluateWorkerHealth(input: {
  redis: RedisMemoryStats
  webhook: Awaited<ReturnType<typeof getQueueSnapshot>>
  webhooks: {
    pending: number
    processedLast10Min: number
    lastActivityAt: string | null
  }
}): { status: WorkerHealthStatus; alerts: WorkerMonitoringAlert[] } {
  const alerts: WorkerMonitoringAlert[] = []
  let status: WorkerHealthStatus = 'ok'

  const setStatus = (next: WorkerHealthStatus) => {
    if (next === 'critical') {
      status = 'critical'
      return
    }
    if (next === 'degraded' && status === 'ok') {
      status = 'degraded'
    }
  }

  if (input.redis.status !== 'ready') {
    alerts.push({ level: 'critical', message: `Redis connection status is ${input.redis.status}` })
    setStatus('critical')
  }

  const memoryPercent = input.redis.usedMemoryPercent
  if (memoryPercent !== null) {
    if (memoryPercent >= WORKER_MONITORING_THRESHOLDS.redisMemoryPercentCritical) {
      alerts.push({
        level: 'critical',
        message: `Redis memory at ${memoryPercent}% of max`
      })
      setStatus('critical')
    } else if (memoryPercent >= WORKER_MONITORING_THRESHOLDS.redisMemoryPercentDegraded) {
      alerts.push({
        level: 'warning',
        message: `Redis memory at ${memoryPercent}% of max`
      })
      setStatus('degraded')
    }
  }

  const webhookCounts = input.webhook.counts

  if (input.webhook.isPaused) {
    alerts.push({ level: 'critical', message: 'Webhook queue is paused' })
    setStatus('critical')
  }

  if (input.webhook.workers < WORKER_MONITORING_THRESHOLDS.webhookWorkersMinimum) {
    alerts.push({
      level: 'critical',
      message: `No active webhook workers (found ${input.webhook.workers})`
    })
    setStatus('critical')
  }

  if (webhookCounts.waiting >= WORKER_MONITORING_THRESHOLDS.webhookWaitingCritical) {
    alerts.push({
      level: 'critical',
      message: `Webhook queue waiting backlog is ${webhookCounts.waiting}`
    })
    setStatus('critical')
  } else if (webhookCounts.waiting >= WORKER_MONITORING_THRESHOLDS.webhookWaitingDegraded) {
    alerts.push({
      level: 'warning',
      message: `Webhook queue waiting backlog is ${webhookCounts.waiting}`
    })
    setStatus('degraded')
  }

  if (webhookCounts.completed >= WORKER_MONITORING_THRESHOLDS.webhookCompletedCritical) {
    alerts.push({
      level: 'critical',
      message: `Webhook queue completed jobs retained in Redis: ${webhookCounts.completed}`
    })
    setStatus('critical')
  } else if (webhookCounts.completed >= WORKER_MONITORING_THRESHOLDS.webhookCompletedDegraded) {
    alerts.push({
      level: 'warning',
      message: `Webhook queue completed jobs retained in Redis: ${webhookCounts.completed}`
    })
    setStatus('degraded')
  }

  if (webhookCounts.failed >= WORKER_MONITORING_THRESHOLDS.webhookFailedDegraded) {
    alerts.push({
      level: 'warning',
      message: `Webhook queue failed jobs: ${webhookCounts.failed}`
    })
    setStatus('degraded')
  }

  if (input.webhooks.pending >= WORKER_MONITORING_THRESHOLDS.sqlPendingDegraded) {
    alerts.push({
      level: 'warning',
      message: `SQL webhook backlog pending: ${input.webhooks.pending}`
    })
    setStatus('degraded')
  }

  const staleCutoffMs = WORKER_MONITORING_THRESHOLDS.sqlProcessedStaleMinutes * 60_000
  const lastActivityMs = input.webhooks.lastActivityAt
    ? new Date(input.webhooks.lastActivityAt).getTime()
    : null

  if (
    webhookCounts.waiting > 0 &&
    input.webhooks.processedLast10Min === 0 &&
    lastActivityMs !== null &&
    Date.now() - lastActivityMs > staleCutoffMs
  ) {
    alerts.push({
      level: 'critical',
      message: `No webhook activity in the last ${WORKER_MONITORING_THRESHOLDS.sqlProcessedStaleMinutes} minutes`
    })
    setStatus('critical')
  }

  return { status, alerts }
}

export async function collectWorkerMonitoringSnapshot(): Promise<WorkerMonitoringSnapshot> {
  const monitoringWindowStart = new Date(Date.now() - 24 * 60 * 60_000)
  const [
    redis,
    webhook,
    ping,
    streams,
    pending,
    processedLast10Min,
    lastActivity,
    totalChatTurns,
    chatRecoveryEvents
  ] = await Promise.all([
    getRedisMemoryStats(),
    getQueueSnapshot(webhookQueue, 'webhook'),
    getQueueSnapshot(pingQueue, 'ping'),
    getQueueSnapshot(streamsQueue, 'streams'),
    prisma.webhookLog.count({ where: { status: 'PENDING' } }),
    prisma.webhookLog.count({
      where: {
        processedAt: {
          gt: new Date(Date.now() - 10 * 60_000)
        }
      }
    }),
    prisma.webhookLog.findFirst({
      orderBy: [{ processedAt: 'desc' }, { createdAt: 'desc' }],
      select: { processedAt: true, createdAt: true }
    }),
    prisma.chatTurn.count({ where: { createdAt: { gte: monitoringWindowStart } } }),
    prisma.chatTurnEvent.findMany({
      where: {
        createdAt: { gte: monitoringWindowStart },
        type: {
          in: ['slow_response', 'turn_interrupted', 'turn_completed']
        }
      },
      select: { data: true }
    })
  ])

  const lastActivityAt = lastActivity?.processedAt || lastActivity?.createdAt || null
  const webhooks = {
    pending,
    processedLast10Min,
    lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null
  }

  const evaluation = evaluateWorkerHealth({
    redis,
    webhook,
    webhooks
  })
  const chatRecovery = summarizeChatRecoveryEvents(totalChatTurns, chatRecoveryEvents)

  return {
    status: evaluation.status,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    redis,
    queues: {
      webhook: {
        ...webhook.counts,
        workers: webhook.workers,
        isPaused: webhook.isPaused
      },
      ping: {
        ...ping.counts,
        workers: ping.workers,
        isPaused: ping.isPaused
      },
      streams: {
        ...streams.counts,
        workers: streams.workers,
        isPaused: streams.isPaused
      }
    },
    webhooks,
    chatRecovery,
    alerts: evaluation.alerts
  }
}

export function workerMonitoringHttpStatus(status: WorkerHealthStatus): number {
  return status === 'critical' ? 503 : 200
}
