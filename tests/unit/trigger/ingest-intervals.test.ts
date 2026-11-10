import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * CW-410 — the Intervals.icu ingestion task must survive the user disconnecting
 * the integration while a sync is in flight (or queued for retry).
 *
 * Two Sentry issues (COACH-WATTS-WEB-1A / -19) were the same event: attempt 1
 * got past the `findUnique`, ran the sync, then blew up in the `finally` block
 * with a Prisma `P2025` (masking the real error); the retry re-fetched, found
 * nothing, and threw a plain `Error` on every remaining attempt.
 */

const {
  integrationFindUnique,
  integrationUpdate,
  syncPlannedWorkouts,
  syncActivities,
  syncWellness,
  syncProfile,
  calculateFuelingPlanForDate,
  getUserTimezone,
  shouldIngestWellness,
  isNutritionTrackingEnabled,
  yieldTaskHeartbeat,
  registerTaskHandler,
  loggerError
} = vi.hoisted(() => ({
  integrationFindUnique: vi.fn(),
  integrationUpdate: vi.fn(),
  syncPlannedWorkouts: vi.fn(),
  syncActivities: vi.fn(),
  syncWellness: vi.fn(),
  syncProfile: vi.fn(),
  calculateFuelingPlanForDate: vi.fn(),
  getUserTimezone: vi.fn(),
  shouldIngestWellness: vi.fn(),
  isNutritionTrackingEnabled: vi.fn(),
  yieldTaskHeartbeat: vi.fn(),
  registerTaskHandler: vi.fn(),
  loggerError: vi.fn()
}))

vi.mock('../../../trigger/init', () => ({}))

vi.mock('../../../trigger/queues', () => ({
  userIngestionQueue: { name: 'user-ingestion' }
}))

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: vi.fn().mockImplementation((config: any) => ({ id: config.id, run: config.run })),
  logger: { log: vi.fn(), warn: vi.fn(), error: loggerError }
}))

vi.mock('../../../server/utils/db', () => ({
  prisma: {
    integration: {
      findUnique: integrationFindUnique,
      update: integrationUpdate
    }
  }
}))

vi.mock('../../../server/utils/services/intervalsService', () => ({
  IntervalsService: {
    syncPlannedWorkouts,
    syncActivities,
    syncWellness,
    syncProfile
  }
}))

vi.mock('../../../server/utils/services/metabolicService', () => ({
  metabolicService: { calculateFuelingPlanForDate }
}))

vi.mock('../../../server/utils/date', () => ({
  getUserTimezone,
  getEndOfDayUTC: vi.fn(() => new Date('2026-01-31T23:59:59.000Z')),
  getUserLocalDate: vi.fn(() => new Date('2026-01-15T00:00:00.000Z'))
}))

vi.mock('../../../server/utils/integration-settings', () => ({ shouldIngestWellness }))

vi.mock('../../../server/utils/nutrition/feature', () => ({ isNutritionTrackingEnabled }))

vi.mock('../../../server/utils/task-runtime', () => ({ yieldTaskHeartbeat }))

vi.mock('../../../server/utils/task-registry', () => ({ registerTaskHandler }))

const PAYLOAD = {
  userId: 'user-1',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-01-31T00:00:00.000Z'
}

const INTEGRATION = { id: 'integration-1', settings: {} }

/** Prisma's "record required but not found" — what a deleted row raises. */
function recordNotFoundError() {
  return Object.assign(
    new Error(
      'An operation failed because it depends on one or more records that were required but not found.'
    ),
    { code: 'P2025' }
  )
}

async function importTask() {
  return await import('../../../trigger/ingest-intervals')
}

describe('runIngestIntervals — integration disconnected mid-sync (CW-410)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    integrationFindUnique.mockResolvedValue(INTEGRATION)
    integrationUpdate.mockResolvedValue(INTEGRATION)
    syncPlannedWorkouts.mockResolvedValue({ plannedWorkouts: 1, events: 2, notes: 3 })
    syncActivities.mockResolvedValue(4)
    syncWellness.mockResolvedValue(5)
    getUserTimezone.mockResolvedValue('Europe/Budapest')
    shouldIngestWellness.mockReturnValue(false)
    isNutritionTrackingEnabled.mockResolvedValue(false)
    yieldTaskHeartbeat.mockResolvedValue(undefined)
  })

  it('exits cleanly without throwing when the integration no longer exists', async () => {
    integrationFindUnique.mockResolvedValue(null)

    const { runIngestIntervals } = await importTask()

    const result = await runIngestIntervals(PAYLOAD)

    expect(result).toMatchObject({
      success: false,
      counts: {},
      userId: PAYLOAD.userId
    })
    expect(result.message).toMatch(/not found/i)
    // Nothing was attempted against the missing row, and nothing was synced —
    // so nothing can throw and trigger the retry storm.
    expect(integrationUpdate).not.toHaveBeenCalled()
    expect(syncPlannedWorkouts).not.toHaveBeenCalled()
    expect(syncActivities).not.toHaveBeenCalled()
  })

  it('does not throw when the row is deleted between the fetch and the finally update', async () => {
    // The initial SYNCING write lands; the finalizing write finds the row gone.
    integrationUpdate
      .mockResolvedValueOnce(INTEGRATION)
      .mockRejectedValueOnce(recordNotFoundError())

    const { runIngestIntervals } = await importTask()

    const result = await runIngestIntervals(PAYLOAD)

    expect(result).toMatchObject({
      success: true,
      counts: { workouts: 4, plannedWorkouts: 1, events: 2 }
    })
    expect(integrationUpdate).toHaveBeenCalledTimes(2)
  })

  it('does not let a P2025 in the finally block mask the real ingestion error', async () => {
    const realError = new Error('Intervals.icu API returned 502')
    syncActivities.mockRejectedValue(realError)
    integrationUpdate
      .mockResolvedValueOnce(INTEGRATION)
      .mockRejectedValueOnce(recordNotFoundError())

    const { runIngestIntervals } = await importTask()

    // The original failure must be what propagates — not the P2025 from the
    // finally block, which is what Sentry was actually capturing.
    await expect(runIngestIntervals(PAYLOAD)).rejects.toThrow('Intervals.icu API returned 502')
  })

  it('skips the sync when the row is deleted before the SYNCING status write', async () => {
    integrationUpdate.mockRejectedValueOnce(recordNotFoundError())

    const { runIngestIntervals } = await importTask()

    const result = await runIngestIntervals(PAYLOAD)

    expect(result).toMatchObject({ success: false, counts: {} })
    expect(syncPlannedWorkouts).not.toHaveBeenCalled()
    expect(syncActivities).not.toHaveBeenCalled()
  })

  it('still surfaces a non-P2025 failure of the finalizing write when the sync succeeded', async () => {
    const dbDown = new Error('connection terminated unexpectedly')
    integrationUpdate.mockResolvedValueOnce(INTEGRATION).mockRejectedValueOnce(dbDown)

    const { runIngestIntervals } = await importTask()

    await expect(runIngestIntervals(PAYLOAD)).rejects.toThrow('connection terminated unexpectedly')
  })

  it('logs but does not mask the ingestion error when the finalizing write fails for another reason', async () => {
    const realError = new Error('Intervals.icu API returned 502')
    syncActivities.mockRejectedValue(realError)
    integrationUpdate
      .mockResolvedValueOnce(INTEGRATION)
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'))

    const { runIngestIntervals } = await importTask()

    await expect(runIngestIntervals(PAYLOAD)).rejects.toThrow('Intervals.icu API returned 502')
    expect(loggerError).toHaveBeenCalled()
  })
})
