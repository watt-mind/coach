import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deduplicationService } from '../../../../../server/utils/services/deduplicationService'
import { prisma } from '../../../../../server/utils/db'
import { getUserTimezone } from '../../../../../server/utils/date'

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    plannedWorkout: {
      findMany: vi.fn()
    },
    workout: {
      findMany: vi.fn()
    },
    $transaction: vi.fn()
  }
}))

vi.mock('../../../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: {}
}))

vi.mock('../../../../../server/utils/date', () => ({
  formatUserDate: vi.fn((date: Date, _timezone: string, format: string) =>
    format === 'yyyy-MM-dd' ? date.toISOString().split('T')[0] : date.toISOString()
  ),
  getUserTimezone: vi.fn()
}))

vi.mock('@trigger.dev/sdk/v3', () => ({
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

describe('deduplicationService.areDuplicates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not mark same-source rides hours apart as duplicates', () => {
    const morningRide = {
      id: 'morning-ride',
      source: 'intervals',
      title: 'Velo cargo matinal',
      type: 'EBikeRide',
      date: new Date('2026-03-09T11:51:32Z'),
      durationSec: 1540
    }

    const eveningRide = {
      id: 'evening-ride',
      source: 'intervals',
      title: 'Velo cargo de fin de journee',
      type: 'EBikeRide',
      date: new Date('2026-03-09T20:55:20Z'),
      durationSec: 1434
    }

    expect(deduplicationService.areDuplicates(morningRide, eveningRide)).toBe(false)
  })

  it('allows a small cross-source timezone offset when titles or durations strongly match', () => {
    const stravaWorkout = {
      id: 'strava-ride',
      source: 'strava',
      title: 'Morning commute',
      type: 'Ride',
      date: new Date('2026-03-09T06:00:00Z'),
      durationSec: 3600
    }

    const withingsWorkout = {
      id: 'withings-ride',
      source: 'withings',
      title: 'Morning commute',
      type: 'EBikeRide',
      date: new Date('2026-03-09T08:00:00Z'),
      durationSec: 3660
    }

    expect(deduplicationService.areDuplicates(stravaWorkout, withingsWorkout)).toBe(true)
  })

  it('does not use type alone for cross-source timezone-shift matches', () => {
    const rideA = {
      id: 'ride-a',
      source: 'strava',
      title: 'Morning commute',
      type: 'Ride',
      date: new Date('2026-03-09T06:00:00Z'),
      durationSec: 3600
    }

    const rideB = {
      id: 'ride-b',
      source: 'withings',
      title: 'Evening social spin',
      type: 'Ride',
      date: new Date('2026-03-09T08:00:00Z'),
      durationSec: 5100
    }

    expect(deduplicationService.areDuplicates(rideA, rideB)).toBe(false)
  })

  it('correctly matches localized russian titles and activity types across integrations', () => {
    const intervalsWorkout = {
      id: 'intervals-1',
      source: 'intervals',
      title: 'Зальный велоспорт',
      type: 'VirtualRide',
      date: new Date('2026-03-09T10:00:00Z'),
      durationSec: 3600
    }

    const garminWorkout = {
      id: 'garmin-1',
      source: 'garmin',
      title: 'Зальный велоспорт',
      type: 'INDOOR_CYCLING',
      date: new Date('2026-03-09T10:02:00Z'),
      durationSec: 3580
    }

    expect(deduplicationService.areDuplicates(intervalsWorkout, garminWorkout)).toBe(true)
  })

  it('matches activities with strict duration match when start times are close even if titles differ', () => {
    const intervalsWorkout = {
      id: 'intervals-2',
      source: 'intervals',
      title: '20x3 (90%) и ускор',
      type: 'Ride',
      date: new Date('2026-03-10T14:30:00Z'),
      durationSec: 5400
    }

    const stravaWorkout = {
      id: 'strava-2',
      source: 'strava',
      title: 'Afternoon Ride',
      type: 'Cycling',
      date: new Date('2026-03-10T14:31:00Z'),
      durationSec: 5410
    }

    expect(deduplicationService.areDuplicates(intervalsWorkout, stravaWorkout)).toBe(true)
  })
})

describe('deduplicationService.areTypesSimilar', () => {
  it('identifies cycling type variations as similar', () => {
    expect(deduplicationService.areTypesSimilar('VirtualRide', 'INDOOR_CYCLING')).toBe(true)
    expect(deduplicationService.areTypesSimilar('Ride', 'Cycling')).toBe(true)
    expect(deduplicationService.areTypesSimilar('EBikeRide', 'Зальный велоспорт')).toBe(true)
  })

  it('identifies strength and gym variations as similar', () => {
    expect(deduplicationService.areTypesSimilar('Gym', 'WeightTraining')).toBe(true)
    expect(deduplicationService.areTypesSimilar('Strength', 'FITNESS_EQUIPMENT')).toBe(true)
  })

  it('does not match distinct activity types like Ride and Run', () => {
    expect(deduplicationService.areTypesSimilar('Ride', 'Run')).toBe(false)
  })
})

describe('deduplicationService.calculateCompletenessScore', () => {
  it('correctly scores cycling workouts with power, streams, and distanceMeters', () => {
    const workout = {
      source: 'intervals',
      type: 'Cycling',
      averageWatts: 220,
      normalizedPower: 240,
      tss: 75,
      averageHr: 150,
      distanceMeters: 45000,
      streams: [{ id: 's1' }],
      description: 'Solid workout session'
    }

    const score = deduplicationService.calculateCompletenessScore(workout)
    expect(score).toBeGreaterThan(150)
  })
})

describe('deduplicationService.findProposedLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getUserTimezone).mockResolvedValue('America/Chicago')
  })

  it('matches planned workouts using the athlete local day, not the workout timestamp', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      { id: 'planned-1', title: 'VO2 Max Mixer' }
    ] as any)

    const result = await deduplicationService.findProposedLink({
      userId: 'user-1',
      date: new Date('2026-03-29T11:35:10Z'),
      type: 'Ride',
      durationSec: 3600
    })

    expect(getUserTimezone).toHaveBeenCalledWith('user-1')
    expect(prisma.plannedWorkout.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        date: new Date('2026-03-29T00:00:00Z'),
        completed: false
      },
      select: {
        id: true,
        title: true,
        type: true,
        durationSec: true,
        date: true,
        completed: true,
        completionStatus: true
      }
    })
    expect(result).toEqual({ id: 'planned-1', title: 'VO2 Max Mixer' })
  })
})

/**
 * CW-262 — duplicate groups are computed once per run, before any merge
 * transaction opens (`findDuplicateGroups` in `trigger/deduplicate-workouts.ts`).
 * A workout named by a group can therefore be deleted before its merge runs —
 * by the user, or by a concurrent dedup/ingest path — and Prisma answers the
 * `where`-targeted update with `P2025`, rolling the whole merge back
 * (Sentry `COACH-WATTS-WEB-H`).
 */
class PrismaRecordNotFoundError extends Error {
  code = 'P2025'

  constructor(subject: string) {
    super(
      'An operation failed because it depends on one or more records that were required but ' +
        `not found. No record was found for an update. (${subject})`
    )
    this.name = 'PrismaClientKnownRequestError'
  }
}

/**
 * `WorkoutStream.workoutId` and `WorkoutExercise.workoutId` are foreign keys to
 * `Workout.id`, so a transfer that points them at a deleted primary is rejected
 * by the constraint rather than by a missing target row — a different code, and
 * one the service must keep surfacing.
 */
class PrismaForeignKeyError extends Error {
  code = 'P2003'

  constructor(subject: string) {
    super(`Foreign key constraint violated on the constraint: \`${subject}\``)
    this.name = 'PrismaClientKnownRequestError'
  }
}

/**
 * Minimal stand-in for the interactive transaction client, backed by a set of
 * workout ids that still exist. Writes aimed at an id outside that set fail the
 * way Prisma does: `P2025` when the row being *updated* is gone, `P2003` when
 * the row being *referenced* is gone. Rollback is not modelled: the assertions
 * are about what the service does with the error, and the real transaction
 * discards every write in the block regardless.
 */
function createTransactionDouble(liveWorkoutIds: string[]) {
  const live = new Set(liveWorkoutIds)

  const workoutUpdate = vi.fn(async ({ where }: any) => {
    if (!live.has(where.id)) throw new PrismaRecordNotFoundError(`workout ${where.id}`)
    return { id: where.id }
  })

  const tx = {
    plannedWorkout: { update: vi.fn(async () => ({})) },
    workoutStream: {
      // Null either way in these fixtures: the primary has no stream of its own,
      // and when the primary is deleted its stream row cascades away with it
      // (`onDelete: Cascade`). Both answers open the transfer path below.
      findUnique: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: any) => {
        if (!live.has(where.workoutId)) {
          throw new PrismaRecordNotFoundError(`stream of workout ${where.workoutId}`)
        }
        if (!live.has(data.workoutId)) {
          throw new PrismaForeignKeyError('WorkoutStream_workoutId_fkey')
        }
        return { workoutId: data.workoutId }
      })
    },
    workoutExercise: {
      // Zero either way, for the same cascade reason as the stream lookup.
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async ({ data }: any) => {
        if (!live.has(data.workoutId)) {
          throw new PrismaForeignKeyError('WorkoutExercise_workoutId_fkey')
        }
        return { count: 1 }
      })
    },
    workout: { update: workoutUpdate }
  }

  return { live, tx, workoutUpdate }
}

function installTransactionDouble(options: {
  liveWorkoutIds: string[]
  duplicateHasStreams?: boolean
}) {
  const double = createTransactionDouble(options.liveWorkoutIds)

  // `mergeDuplicateGroup` re-reads the duplicates just before the transaction;
  // rows deleted in the meantime are simply absent from the result.
  vi.mocked(prisma.workout.findMany).mockImplementation((async ({ where }: any) =>
    (where.id.in as string[])
      .filter((id) => double.live.has(id))
      .map((id) => ({
        id,
        plannedWorkoutId: null,
        streams: options.duplicateHasStreams ? { id: `stream-of-${id}` } : null
      }))) as any)

  vi.mocked(prisma.$transaction as any).mockImplementation(async (callback: any) =>
    callback(double.tx)
  )

  return double
}

function buildGroup(
  primaryId: string,
  duplicateId: string,
  duplicateOverrides: Record<string, unknown> = {}
) {
  return {
    workouts: [
      {
        id: primaryId,
        source: 'garmin',
        type: 'Ride',
        date: new Date('2026-03-09T10:00:00Z'),
        durationSec: 3600,
        // Pre-linked so the merge does not go looking for a planned workout.
        plannedWorkoutId: 'planned-existing'
      },
      {
        id: duplicateId,
        source: 'strava',
        type: 'Ride',
        date: new Date('2026-03-09T10:01:00Z'),
        durationSec: 3610,
        plannedWorkoutId: null,
        averageHr: 150,
        ...duplicateOverrides
      }
    ],
    bestWorkoutId: primaryId,
    toDelete: [duplicateId]
  }
}

describe('deduplicationService.mergeDuplicateGroup concurrent deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips the group when the primary workout is deleted before the merge transaction', async () => {
    const group = buildGroup('best-gone', 'duplicate-1')
    // Primary already deleted; the duplicate is still there.
    const { workoutUpdate } = installTransactionDouble({ liveWorkoutIds: ['duplicate-1'] })

    const result = await deduplicationService.mergeDuplicateGroup(group)

    expect(result).toEqual({ deletedCount: 0, keptCount: 0, skipped: true })
    expect(workoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'best-gone' } })
    )
    // Step 5 never runs, so the surviving duplicate is not flagged against a
    // primary that no longer exists.
    expect(workoutUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'duplicate-1' } })
    )
  })

  it('skips the group when a non-primary member is deleted before the merge transaction', async () => {
    const group = buildGroup('best-1', 'duplicate-gone')
    // Primary survives; the duplicate is gone, so it only fails at step 5.
    const { workoutUpdate } = installTransactionDouble({ liveWorkoutIds: ['best-1'] })

    const result = await deduplicationService.mergeDuplicateGroup(group)

    expect(result).toEqual({ deletedCount: 0, keptCount: 0, skipped: true })
    expect(workoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'duplicate-gone' } })
    )
  })

  it('keeps merging the remaining groups of the run after a stale group is skipped', async () => {
    const staleGroup = buildGroup('stale-best', 'stale-duplicate')
    const healthyGroup = buildGroup('healthy-best', 'healthy-duplicate')

    const { workoutUpdate } = installTransactionDouble({
      liveWorkoutIds: ['stale-duplicate', 'healthy-best', 'healthy-duplicate']
    })

    // Mirrors the per-group loop in `trigger/deduplicate-workouts.ts`: it has no
    // error handling of its own, so a throw from any group aborts the batch.
    const results = []
    for (const group of [staleGroup, healthyGroup]) {
      results.push(await deduplicationService.mergeDuplicateGroup(group))
    }

    expect(results[0]).toEqual({ deletedCount: 0, keptCount: 0, skipped: true })
    expect(results[1]).toEqual({ deletedCount: 1, keptCount: 1 })

    expect(workoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'healthy-best' },
        data: expect.objectContaining({ averageHr: 150 })
      })
    )
    expect(workoutUpdate).toHaveBeenCalledWith({
      where: { id: 'healthy-duplicate' },
      data: { isDuplicate: true, duplicateOf: 'healthy-best' }
    })
  })

  it('skips the group when the primary is deleted and a surviving duplicate has streams', async () => {
    const group = buildGroup('best-gone', 'duplicate-1')
    // The primary is gone, so its own stream row has cascaded away and the
    // "does the primary already have streams?" guard opens the transfer path.
    // Transferring the duplicate's stream would point an FK at a deleted
    // workout, which is a P2003 — not the P2025 that identifies a stale group.
    const { tx } = installTransactionDouble({
      liveWorkoutIds: ['duplicate-1'],
      duplicateHasStreams: true
    })

    const result = await deduplicationService.mergeDuplicateGroup(group)

    expect(result).toEqual({ deletedCount: 0, keptCount: 0, skipped: true })
    // The group is abandoned before the transfer is ever attempted.
    expect(tx.workoutStream.update).not.toHaveBeenCalled()
  })

  it('skips the group when the primary is deleted and a surviving duplicate has exercises', async () => {
    const group = buildGroup('best-gone', 'duplicate-1', {
      exercises: [{ id: 'exercise-1' }]
    })
    const { tx } = installTransactionDouble({ liveWorkoutIds: ['duplicate-1'] })

    const result = await deduplicationService.mergeDuplicateGroup(group)

    expect(result).toEqual({ deletedCount: 0, keptCount: 0, skipped: true })
    expect(tx.workoutExercise.updateMany).not.toHaveBeenCalled()
  })

  it('still surfaces database failures that are not a missing target row', async () => {
    const group = buildGroup('best-1', 'duplicate-1')
    const { tx } = installTransactionDouble({ liveWorkoutIds: ['best-1', 'duplicate-1'] })

    const constraintViolation = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002'
    })
    tx.workout.update.mockRejectedValueOnce(constraintViolation as never)

    await expect(deduplicationService.mergeDuplicateGroup(group)).rejects.toThrow(
      'Unique constraint failed'
    )
  })
})
