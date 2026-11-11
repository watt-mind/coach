import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findMatchingPlannedWorkoutForWorkout,
  linkWorkoutToMatchingPlannedWorkout
} from './planned-workout-linking'
import { prisma } from './db'
import { publishActivityEvent } from './activity-realtime'

vi.mock('./db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn()
    },
    plannedWorkout: {
      findMany: vi.fn()
    },
    $transaction: vi.fn()
  }
}))

vi.mock('./activity-realtime', () => ({
  publishActivityEvent: vi.fn()
}))

const workout = {
  id: 'workout-1',
  userId: 'user-1',
  date: new Date('2026-04-17T05:41:08.000Z'),
  type: 'Run',
  durationSec: 2602,
  plannedWorkoutId: null
}

describe('planned workout linking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ timezone: 'Europe/Budapest' } as any)
  })

  it('matches a Strava workout to the planned workout on the athlete local day', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-1',
        title: 'Konnyu futas',
        type: 'Run',
        durationSec: 2400,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const result = await findMatchingPlannedWorkoutForWorkout(workout as any)

    expect(result?.id).toBe('planned-1')
    expect(prisma.plannedWorkout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          date: new Date('2026-04-17T00:00:00.000Z'),
          completed: false
        })
      })
    )
  })

  it('links the workout and marks the planned workout completed in one transaction', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-1',
        title: 'Konnyu futas',
        type: 'Run',
        durationSec: 2400,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const tx = {
      workout: {
        findFirst: vi.fn().mockResolvedValue({ plannedWorkoutId: null }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      plannedWorkout: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => callback(tx))

    const result = await linkWorkoutToMatchingPlannedWorkout(workout as any)

    expect(result).toEqual({ linked: true, plannedWorkoutId: 'planned-1' })
    expect(tx.plannedWorkout.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'planned-1',
        userId: 'user-1',
        completed: false
      },
      data: {
        completed: true,
        completionStatus: 'COMPLETED'
      }
    })
    expect(tx.workout.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'workout-1',
        userId: 'user-1',
        plannedWorkoutId: null
      },
      data: {
        plannedWorkoutId: 'planned-1'
      }
    })
    expect(publishActivityEvent).toHaveBeenCalledTimes(2)
  })

  it('rejects a lone incompatible Run plan for a Ride workout', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-run',
        title: 'Morning run',
        type: 'Run',
        durationSec: 2400,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const rideWorkout = { ...workout, type: 'Ride' }
    const result = await findMatchingPlannedWorkoutForWorkout(rideWorkout as any)

    expect(result).toBeNull()
  })

  it('rejects a lone incompatible Ride plan for a Run workout', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-ride',
        title: 'Evening ride',
        type: 'Ride',
        durationSec: 3600,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const result = await findMatchingPlannedWorkoutForWorkout(workout as any)

    expect(result).toBeNull()
  })

  it('does not write or emit events when linking a lone incompatible candidate', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-run',
        title: 'Morning run',
        type: 'Run',
        durationSec: 2400,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const rideWorkout = { ...workout, type: 'Ride' }
    const result = await linkWorkoutToMatchingPlannedWorkout(rideWorkout as any)

    expect(result).toEqual({ linked: false, reason: 'no_match' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(publishActivityEvent).not.toHaveBeenCalled()
  })

  it('leaves the Run plan available after rejecting a Ride, then matches a subsequent Run', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-run',
        title: 'Morning run',
        type: 'Run',
        durationSec: 2400,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const rideWorkout = { ...workout, type: 'Ride' }
    expect(await findMatchingPlannedWorkoutForWorkout(rideWorkout as any)).toBeNull()

    const runResult = await findMatchingPlannedWorkoutForWorkout(workout as any)
    expect(runResult?.id).toBe('planned-run')
  })

  it('matches a lone candidate case-insensitively', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-1',
        title: 'Konnyu futas',
        type: 'RUN',
        durationSec: 2400,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const lowerRun = { ...workout, type: 'rUn' }
    const result = await findMatchingPlannedWorkoutForWorkout(lowerRun as any)

    expect(result?.id).toBe('planned-1')
  })

  it('matches lone ride/run subtype families', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-ride',
        title: 'Endurance ride',
        type: 'Ride',
        durationSec: 3600,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const virtualRide = { ...workout, type: 'VirtualRide' }
    expect((await findMatchingPlannedWorkoutForWorkout(virtualRide as any))?.id).toBe(
      'planned-ride'
    )

    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-run',
        title: 'Trail run',
        type: 'TrailRun',
        durationSec: 2400,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const runWorkout = { ...workout, type: 'Run' }
    expect((await findMatchingPlannedWorkoutForWorkout(runWorkout as any))?.id).toBe('planned-run')
  })

  it('keeps compatible-type filtering and closest-duration selection with multiple candidates', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-ride',
        title: 'Evening ride',
        type: 'Ride',
        durationSec: 2600,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      },
      {
        id: 'planned-run-near',
        title: 'Tempo run',
        type: 'Run',
        durationSec: 2500,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      },
      {
        id: 'planned-run-far',
        title: 'Long run',
        type: 'Run',
        durationSec: 5000,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const result = await findMatchingPlannedWorkoutForWorkout(workout as any)

    expect(result?.id).toBe('planned-run-near')
  })

  it('returns null when multiple candidates share no compatible sport', async () => {
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([
      {
        id: 'planned-ride-1',
        title: 'Evening ride',
        type: 'Ride',
        durationSec: 2600,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      },
      {
        id: 'planned-ride-2',
        title: 'Morning ride',
        type: 'VirtualRide',
        durationSec: 2600,
        date: new Date('2026-04-17T00:00:00.000Z'),
        completed: false,
        completionStatus: 'PENDING'
      }
    ] as any)

    const result = await findMatchingPlannedWorkoutForWorkout(workout as any)

    expect(result).toBeNull()
  })

  it('returns already_linked without querying when the workout is already linked', async () => {
    const alreadyLinked = { ...workout, plannedWorkoutId: 'planned-1' }
    const result = await linkWorkoutToMatchingPlannedWorkout(alreadyLinked as any)

    expect(result).toEqual({ linked: false, reason: 'already_linked' })
    expect(prisma.plannedWorkout.findMany).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(publishActivityEvent).not.toHaveBeenCalled()
  })
})
