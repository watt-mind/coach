import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { syncQueueFindMany, syncQueueUpdateMany, syncQueueUpdate, processSyncQueueItem } =
  vi.hoisted(() => ({
    syncQueueFindMany: vi.fn(),
    syncQueueUpdateMany: vi.fn(),
    syncQueueUpdate: vi.fn(),
    processSyncQueueItem: vi.fn()
  }))

vi.mock('../../../server/utils/db', () => ({
  prisma: {
    syncQueue: {
      findMany: syncQueueFindMany,
      updateMany: syncQueueUpdateMany,
      update: syncQueueUpdate
    }
  }
}))

vi.mock('../../../server/utils/intervals-sync', () => ({
  processSyncQueueItem
}))

vi.mock('../../../trigger/init', () => ({}))

vi.mock('@trigger.dev/sdk/v3', async () => {
  const actual = await vi.importActual('@trigger.dev/sdk/v3')
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    task: vi.fn().mockImplementation((config) => ({
      run: config.run,
      id: config.id
    }))
  }
})

describe('processSyncQueueTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('atomically claims pending items before processing them', async () => {
    syncQueueFindMany.mockResolvedValue([
      {
        id: 'queue-1',
        entityType: 'plannedWorkout',
        entityId: 'planned-1',
        operation: 'UPDATE',
        attempts: 0
      }
    ])
    syncQueueUpdateMany.mockResolvedValue({ count: 1 })
    processSyncQueueItem.mockResolvedValue(true)
    syncQueueUpdate.mockResolvedValue({})

    const { processSyncQueueTask } = await import('../../../trigger/process-sync-queue')
    await processSyncQueueTask.run({})

    expect(syncQueueUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'queue-1',
        status: 'PENDING',
        lastAttempt: undefined,
        attempts: 0
      },
      data: {
        status: 'PROCESSING',
        attempts: 0,
        lastAttempt: expect.any(Date)
      }
    })
    expect(processSyncQueueItem).toHaveBeenCalled()
  })

  it('skips items that were already claimed by another worker', async () => {
    syncQueueFindMany.mockResolvedValue([
      {
        id: 'queue-1',
        entityType: 'plannedWorkout',
        entityId: 'planned-1',
        operation: 'UPDATE',
        attempts: 0
      }
    ])
    syncQueueUpdateMany.mockResolvedValue({ count: 0 })

    const { processSyncQueueTask } = await import('../../../trigger/process-sync-queue')
    await processSyncQueueTask.run({})

    expect(processSyncQueueItem).not.toHaveBeenCalled()
    expect(syncQueueUpdate).not.toHaveBeenCalled()
  })
  afterEach(() => vi.useRealTimers())

  // A tiny stateful DB double applies the query and CAS rather than always returning a winner.
  function queueDb(row: any) {
    syncQueueFindMany.mockImplementation(async ({ where }) => {
      const cutoff = where.OR[1].OR[1].lastAttempt.lt
      const eligible =
        row.status === 'PENDING'
          ? row.attempts < 3
          : row.status === 'PROCESSING' && (!row.lastAttempt || row.lastAttempt < cutoff)
      return eligible ? [{ ...row }] : []
    })
    syncQueueUpdateMany.mockImplementation(async ({ where, data }) => {
      const matches = Object.entries(where).every(([key, value]) =>
        value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value
      )
      if (!matches) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    })
  }

  it.each([new Date('2026-11-11T00:00:00Z'), null])(
    'recovers interrupted claims with timestamp %s and one winning concurrent worker',
    async (lastAttempt) => {
      vi.useFakeTimers().setSystemTime(new Date('2026-11-11T00:11:00Z'))
      const row = { id: 'interrupted', status: 'PROCESSING', attempts: 0, lastAttempt }
      queueDb(row)
      processSyncQueueItem.mockResolvedValue(true)
      const { processSyncQueueTask } = await import('../../../trigger/process-sync-queue')
      await Promise.all([processSyncQueueTask.run({}), processSyncQueueTask.run({})])
      expect(processSyncQueueItem).toHaveBeenCalledTimes(1)
      expect(processSyncQueueItem).toHaveBeenCalledWith(
        expect.objectContaining({
          attempts: 1,
          lastAttempt: new Date(),
          status: 'PROCESSING'
        })
      )
      expect(row.attempts).toBe(1)
    }
  )

  it('leaves fresh active claims untouched', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-11-11T00:11:00Z'))
    const row = { id: 'active', status: 'PROCESSING', attempts: 0, lastAttempt: new Date() }
    queueDb(row)
    const { processSyncQueueTask } = await import('../../../trigger/process-sync-queue')
    await processSyncQueueTask.run({})
    expect(syncQueueUpdateMany).not.toHaveBeenCalled()
    expect(processSyncQueueItem).not.toHaveBeenCalled()
  })

  it('bounds repeated interruptions and fails the third abandoned attempt', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-11-11T00:11:00Z'))
    const row = { id: 'interrupted', status: 'PROCESSING', attempts: 0, lastAttempt: null }
    queueDb(row)
    // Model termination after each claim: processing never persists its final status.
    processSyncQueueItem.mockResolvedValue(false)
    const { processSyncQueueTask } = await import('../../../trigger/process-sync-queue')
    for (let i = 0; i < 3; i++) {
      await processSyncQueueTask.run({})
      vi.advanceTimersByTime(11 * 60 * 1000)
    }
    expect(row).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        attempts: 3,
        error: 'Sync claim expired after maximum attempts'
      })
    )
    expect(processSyncQueueItem).toHaveBeenCalledTimes(2)
  })

  it('cannot finalize a replaced claim when the helper throws', async () => {
    const row = { id: 'old', status: 'PENDING', attempts: 0, lastAttempt: null as Date | null }
    queueDb(row)
    processSyncQueueItem.mockImplementation(async () => {
      row.lastAttempt = new Date(Date.now() + 1000)
      throw new Error('old owner')
    })
    const { processSyncQueueTask } = await import('../../../trigger/process-sync-queue')
    await processSyncQueueTask.run({})
    expect(row.status).toBe('PROCESSING')
    expect(row.attempts).toBe(0)
  })
})
