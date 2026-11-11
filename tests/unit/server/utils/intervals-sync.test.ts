import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '../../../../server/utils/db'
import {
  createIntervalsPlannedWorkout,
  updateIntervalsPlannedWorkout,
  deleteIntervalsPlannedWorkout
} from '../../../../server/utils/intervals'

vi.mock('../../../../server/utils/db', () => ({
  prisma: {
    integration: {
      findFirst: vi.fn()
    },
    plannedWorkout: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    syncQueue: {
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    event: {
      update: vi.fn()
    }
  }
}))

vi.mock('../../../../server/utils/intervals', () => ({
  createIntervalsPlannedWorkout: vi.fn(),
  updateIntervalsPlannedWorkout: vi.fn(),
  deleteIntervalsPlannedWorkout: vi.fn(),
  updateIntervalsEvent: vi.fn(),
  createIntervalsEvent: vi.fn(),
  deleteIntervalsEvent: vi.fn(),
  isIntervalsEventId: vi.fn((value: string | null | undefined) => /^\d+$/.test(value || ''))
}))

vi.mock('../../../../server/utils/repositories/plannedWorkoutPublishRepository', () => ({
  plannedWorkoutPublishRepository: {
    upsert: vi.fn().mockResolvedValue(undefined)
  }
}))

describe('intervals-sync helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(deleteIntervalsPlannedWorkout).mockReset()
    vi.mocked(prisma.integration.findFirst).mockResolvedValue({
      id: 'integration-1',
      provider: 'intervals'
    } as any)
  })

  it('recreates the workout when an Intervals update returns 404', async () => {
    const { syncPlannedWorkoutToIntervals } =
      await import('../../../../server/utils/intervals-sync')

    vi.mocked(updateIntervalsPlannedWorkout).mockRejectedValue(
      new Error('Intervals API error: 404 {"status":404,"error":"Event not found"}')
    )
    vi.mocked(createIntervalsPlannedWorkout).mockResolvedValue({ id: '98765' } as any)

    const result = await syncPlannedWorkoutToIntervals(
      'UPDATE',
      {
        id: 'planned-1',
        externalId: '12345',
        date: new Date('2026-03-12T00:00:00Z'),
        title: 'Tempo Ride',
        type: 'Ride'
      },
      'user-1'
    )

    expect(createIntervalsPlannedWorkout).toHaveBeenCalled()
    expect(prisma.plannedWorkout.update).toHaveBeenCalledWith({
      where: { id: 'planned-1' },
      data: {
        externalId: '98765',
        syncError: null
      }
    })
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        synced: true,
        result: { id: '98765' }
      })
    )
  })

  it('hydrates queued planned workout dates before retry processing', async () => {
    const { processSyncQueueItem } = await import('../../../../server/utils/intervals-sync')

    vi.mocked(createIntervalsPlannedWorkout).mockResolvedValue({ id: '24680' } as any)

    const result = await processSyncQueueItem({
      id: 'queue-1',
      userId: 'user-1',
      entityType: 'planned_workout',
      entityId: 'planned-1',
      operation: 'CREATE',
      payload: {
        id: 'planned-1',
        externalId: 'local-1',
        date: '2026-03-12T00:00:00.000Z',
        title: 'Tempo Ride',
        type: 'Ride'
      },
      attempts: 0
    })

    expect(result).toBe(true)
    expect(createIntervalsPlannedWorkout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        date: expect.any(Date),
        title: 'Tempo Ride'
      })
    )
    expect(prisma.syncQueue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING', lastAttempt: null, attempts: 0, id: 'queue-1' },
        data: expect.objectContaining({
          status: 'COMPLETED'
        })
      })
    )
  })

  it('supersedes stale sync queue items when structure revision advanced', async () => {
    const { processSyncQueueItem } = await import('../../../../server/utils/intervals-sync')

    vi.mocked(prisma.plannedWorkout.findUnique).mockResolvedValue({
      structureRevision: 4
    } as any)

    const result = await processSyncQueueItem({
      id: 'queue-stale',
      userId: 'user-1',
      entityType: 'planned_workout',
      entityId: 'planned-1',
      operation: 'UPDATE',
      structureRevision: 3,
      payload: {
        id: 'planned-1',
        externalId: '12345',
        date: '2026-03-12T00:00:00.000Z',
        title: 'Tempo Ride',
        type: 'Ride',
        workout_doc: '- 10m 70%'
      },
      attempts: 0
    })

    expect(result).toBe(true)
    expect(updateIntervalsPlannedWorkout).not.toHaveBeenCalled()
    expect(prisma.syncQueue.updateMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', lastAttempt: null, attempts: 0, id: 'queue-stale' },
      data: expect.objectContaining({ status: 'SUPERSEDED' })
    })
    expect(prisma.plannedWorkout.updateMany).not.toHaveBeenCalled()
  })

  it('processes DELETE after the local workout is gone, regardless of old structure revision', async () => {
    const { processSyncQueueItem } = await import('../../../../server/utils/intervals-sync')
    vi.mocked(prisma.plannedWorkout.findUnique).mockResolvedValue(null)

    const result = await processSyncQueueItem({
      id: 'queue-delete',
      userId: 'user-1',
      entityType: 'planned_workout',
      entityId: 'deleted-workout',
      operation: 'DELETE',
      structureRevision: 3,
      payload: { externalId: '12345', structureRevision: 3 },
      attempts: 0
    })

    expect(result).toBe(true)
    expect(deleteIntervalsPlannedWorkout).toHaveBeenCalledWith(expect.anything(), '12345')
    expect(prisma.plannedWorkout.findUnique).not.toHaveBeenCalled()
    expect(prisma.plannedWorkout.updateMany).not.toHaveBeenCalled()
    expect(prisma.syncQueue.updateMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', lastAttempt: null, attempts: 0, id: 'queue-delete' },
      data: expect.objectContaining({ status: 'COMPLETED', attempts: 1 })
    })
  })

  it('completes queued DELETE idempotently when the provider already removed the event', async () => {
    const { processSyncQueueItem } = await import('../../../../server/utils/intervals-sync')
    vi.mocked(deleteIntervalsPlannedWorkout).mockRejectedValue(
      new Error('Intervals API error: 404 {"status":404,"error":"Event not found"}')
    )

    const result = await processSyncQueueItem({
      id: 'queue-deleted-remote',
      userId: 'user-1',
      entityType: 'planned_workout',
      entityId: 'deleted-workout',
      operation: 'DELETE',
      structureRevision: null,
      payload: { externalId: '12345' },
      attempts: 1
    })

    expect(result).toBe(true)
    expect(prisma.syncQueue.updateMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', lastAttempt: null, attempts: 1, id: 'queue-deleted-remote' },
      data: expect.objectContaining({ status: 'COMPLETED', attempts: 2 })
    })
    expect(prisma.plannedWorkout.findUnique).not.toHaveBeenCalled()
    expect(prisma.plannedWorkout.updateMany).not.toHaveBeenCalled()
  })

  it.each([0, 2])(
    'records DELETE failure at attempt %s without touching the local workout',
    async (attempts) => {
      const { processSyncQueueItem } = await import('../../../../server/utils/intervals-sync')
      vi.mocked(deleteIntervalsPlannedWorkout).mockRejectedValue(new Error('Provider unavailable'))

      const result = await processSyncQueueItem({
        id: 'queue-retry-delete',
        userId: 'user-1',
        entityType: 'planned_workout',
        entityId: 'deleted-workout',
        operation: 'DELETE',
        structureRevision: null,
        payload: { externalId: '12345' },
        attempts
      })

      expect(result).toBe(false)
      expect(prisma.syncQueue.updateMany).toHaveBeenCalledWith({
        where: {
          status: 'PENDING',
          lastAttempt: null,
          attempts,
          id: 'queue-retry-delete'
        },
        data: expect.objectContaining({
          status: attempts === 0 ? 'PENDING' : 'FAILED',
          attempts: attempts + 1,
          error: 'Provider unavailable'
        })
      })
      expect(prisma.plannedWorkout.findUnique).not.toHaveBeenCalled()
      expect(prisma.plannedWorkout.updateMany).not.toHaveBeenCalled()
    }
  )
  it.each(['success', 'failure', 'superseded', 'missing integration'])(
    'guards stale helper queue writes on %s',
    async (outcome) => {
      const { processSyncQueueItem } = await import('../../../../server/utils/intervals-sync')
      const lastAttempt = new Date('2026-11-11T00:00:00Z')
      vi.mocked(prisma.syncQueue.updateMany).mockResolvedValueOnce({ count: 0 })
      vi.mocked(prisma.plannedWorkout.findUnique).mockResolvedValue({ structureRevision: 4 } as any)
      if (outcome === 'missing integration')
        vi.mocked(prisma.integration.findFirst).mockResolvedValue(null)
      vi.mocked(deleteIntervalsPlannedWorkout).mockImplementation(async () => {
        if (outcome === 'failure') throw new Error('provider failure')
      })
      await processSyncQueueItem({
        id: 'stale-owner',
        userId: 'u',
        entityId: 'p',
        entityType: 'planned_workout',
        operation: outcome === 'superseded' ? 'UPDATE' : 'DELETE',
        structureRevision: 3,
        payload: { externalId: '123' },
        attempts: 2,
        status: 'PROCESSING',
        lastAttempt
      })
      expect(prisma.syncQueue.updateMany).toHaveBeenCalledTimes(1)
      expect(prisma.syncQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'stale-owner', status: 'PROCESSING', lastAttempt, attempts: 2 }
        })
      )
      expect(prisma.plannedWorkout.updateMany).not.toHaveBeenCalled()
    }
  )
})
