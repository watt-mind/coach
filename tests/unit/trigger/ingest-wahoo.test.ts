import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import crypto from 'node:crypto'
import { prisma } from '../../../server/utils/db'
import { dispatchTask } from '../../../server/utils/task-dispatcher'
import { workoutRepository } from '../../../server/utils/repositories/workoutRepository'
import { calculateWorkoutStress } from '../../../server/utils/calculate-workout-stress'

import { fetchAllWahooWorkouts, ingestWahooTask } from '../../../trigger/ingest-wahoo'
import { fetchWahooWorkouts, normalizeWahooWorkout } from '../../../server/utils/wahoo'

vi.mock('@trigger.dev/sdk/v3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@trigger.dev/sdk/v3')>()
  return {
    ...actual,
    task: vi.fn((config) => config),
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() }
  }
})

vi.mock('../../../server/utils/wahoo', () => ({
  fetchWahooWorkouts: vi.fn(),
  normalizeWahooWorkout: vi.fn()
}))

function makeWorkout(id: number) {
  return { id, starts: '2026-01-01T00:00:00Z', minutes: 30 } as any
}

describe('fetchAllWahooWorkouts pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('follows pagination across multiple pages until a short page is returned', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeWorkout(i))
    const page2 = Array.from({ length: 100 }, (_, i) => makeWorkout(100 + i))
    const page3 = Array.from({ length: 37 }, (_, i) => makeWorkout(200 + i))

    vi.mocked(fetchWahooWorkouts)
      .mockResolvedValueOnce({ workouts: page1, total: 237 })
      .mockResolvedValueOnce({ workouts: page2, total: 237 })
      .mockResolvedValueOnce({ workouts: page3, total: 237 })

    const result = await fetchAllWahooWorkouts({} as any)

    expect(result).toHaveLength(237)
    expect(fetchWahooWorkouts).toHaveBeenCalledTimes(3)
    expect(fetchWahooWorkouts).toHaveBeenNthCalledWith(1, {}, 1, 100)
    expect(fetchWahooWorkouts).toHaveBeenNthCalledWith(2, {}, 2, 100)
    expect(fetchWahooWorkouts).toHaveBeenNthCalledWith(3, {}, 3, 100)
  })

  it('stops as soon as the reported total has been collected', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeWorkout(i))
    const page2 = Array.from({ length: 100 }, (_, i) => makeWorkout(100 + i))

    vi.mocked(fetchWahooWorkouts)
      .mockResolvedValueOnce({ workouts: page1, total: 200 })
      .mockResolvedValueOnce({ workouts: page2, total: 200 })

    const result = await fetchAllWahooWorkouts({} as any)

    expect(result).toHaveLength(200)
    expect(fetchWahooWorkouts).toHaveBeenCalledTimes(2)
  })

  it('stops immediately when the first page is empty', async () => {
    vi.mocked(fetchWahooWorkouts).mockResolvedValueOnce({ workouts: [], total: 0 })

    const result = await fetchAllWahooWorkouts({} as any)

    expect(result).toHaveLength(0)
    expect(fetchWahooWorkouts).toHaveBeenCalledTimes(1)
  })

  it('honors the safety cap and does not loop forever if the API misbehaves', async () => {
    // Simulate a misbehaving API that always returns a full page and never
    // lets `total` be reached, so the only thing that can stop the loop is
    // the hard cap on page count.
    vi.mocked(fetchWahooWorkouts).mockImplementation(async (_integration, page = 1) => ({
      workouts: Array.from({ length: 100 }, (_, i) => makeWorkout((page as number) * 1000 + i)),
      total: Number.MAX_SAFE_INTEGER
    }))

    vi.useFakeTimers()
    try {
      const resultPromise = fetchAllWahooWorkouts({} as any)
      await vi.runAllTimersAsync()
      const result = await resultPromise

      // 50 pages * 100 per page, per the safety cap.
      expect(result).toHaveLength(5000)
      expect(fetchWahooWorkouts).toHaveBeenCalledTimes(50)
    } finally {
      vi.useRealTimers()
    }
  })
})

vi.mock('../../../trigger/init', () => ({}))
vi.mock('../../../server/utils/db', () => ({
  prisma: {
    integration: { findUnique: vi.fn(), update: vi.fn() },
    workout: { findFirst: vi.fn() },
    fitFile: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }
  }
}))
vi.mock('../../../server/utils/task-dispatcher', () => ({ dispatchTask: vi.fn() }))
vi.mock('../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: { upsert: vi.fn() }
}))
vi.mock('../../../server/utils/calculate-workout-stress', () => ({
  calculateWorkoutStress: vi.fn()
}))

describe('Wahoo FIT ownership', () => {
  const bytes = Buffer.from('identical downloaded FIT bytes')
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  const foreignFile = {
    id: 'file-a',
    userId: 'user-a',
    hash,
    filename: 'original.fit',
    fileData: bytes,
    workoutId: 'workout-a'
  }
  let files: (typeof foreignFile)[]
  const workout = {
    ...makeWorkout(42),
    workout_summary: { file: { url: 'https://example.test/workout.fit' } }
  }
  const payload = { userId: 'user-b', startDate: '2026-01-01', endDate: '2026-01-02' }

  beforeEach(() => {
    vi.resetAllMocks()
    files = [{ ...foreignFile, fileData: Buffer.from(bytes) }]
    vi.mocked(prisma.integration.findUnique).mockResolvedValue({ id: 'integration-b' } as any)
    vi.mocked(prisma.workout.findFirst).mockResolvedValue(null)
    vi.mocked(fetchWahooWorkouts).mockResolvedValue({ workouts: [workout], total: 1 })
    // Model query filtering and persisted writes so a global hash lookup really
    // selects A's row and reproduces the ownership transfer.
    vi.mocked(prisma.fitFile.findFirst).mockImplementation(
      async ({ where }: any) =>
        (files.find((file) =>
          Object.entries(where).every(([key, value]) => file[key as keyof typeof file] === value)
        ) as any) ?? null
    )
    vi.mocked(prisma.fitFile.create).mockImplementation(async ({ data }: any) => {
      const file = { ...data, id: 'file-b', workoutId: null }
      files.push(file)
      return file
    })
    vi.mocked(prisma.fitFile.update).mockImplementation(async ({ where, data }: any) => {
      const file = files.find((file) => file.id === where.id)!
      Object.assign(file, data)
      return file as any
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer
      })
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  function expectDispatch() {
    expect(dispatchTask).toHaveBeenLastCalledWith(
      'ingest-fit-file',
      {
        userId: 'user-b',
        fitFileId: 'file-b',
        source: 'wahoo',
        externalId: '42',
        rawJson: workout
      },
      { concurrencyKey: 'user-b', tags: ['user:user-b'] }
    )
  }

  it('creates B’s own file for identical bytes without changing A’s linked file', async () => {
    const result = await ingestWahooTask.run(payload)

    expect(result.counts).toEqual({ workouts: 1, fitFiles: 1 })
    expect(files).toEqual([
      foreignFile,
      {
        id: 'file-b',
        userId: 'user-b',
        hash,
        filename: 'wahoo_42.fit',
        fileData: bytes,
        workoutId: null
      }
    ])
    expect(prisma.fitFile.update).not.toHaveBeenCalled()
    expectDispatch()
    expect(workoutRepository.upsert).not.toHaveBeenCalled()
  })

  it('reuses B’s file on retry even when A’s matching hash appears first', async () => {
    files.push({ ...foreignFile, id: 'file-b', userId: 'user-b', workoutId: 'workout-b' })
    await ingestWahooTask.run(payload)
    await ingestWahooTask.run(payload)

    expect(files).toHaveLength(2)
    expect(files[0]).toEqual(foreignFile)
    expect(files[1]).toMatchObject({
      id: 'file-b',
      userId: 'user-b',
      workoutId: 'workout-b',
      fileData: bytes
    })
    expect(prisma.fitFile.create).not.toHaveBeenCalled()
    expect(prisma.fitFile.update).toHaveBeenCalledWith({
      where: { id: 'file-b' },
      data: { userId: 'user-b', filename: 'wahoo_42.fit', fileData: bytes }
    })
    expect(dispatchTask).toHaveBeenCalledTimes(2)
    expectDispatch()
  })

  it('falls back to summary ingestion when the FIT download fails', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, statusText: 'Unavailable' } as Response)
    vi.mocked(normalizeWahooWorkout).mockReturnValue({ externalId: '42' } as any)
    vi.mocked(workoutRepository.upsert).mockResolvedValue({
      isNew: true,
      record: { id: 'summary-b' }
    } as any)

    const result = await ingestWahooTask.run(payload)

    expect(result.counts).toEqual({ workouts: 1, fitFiles: 0 })
    expect(files).toEqual([foreignFile])
    expect(prisma.fitFile.findFirst).not.toHaveBeenCalled()
    expect(dispatchTask).not.toHaveBeenCalled()
    expect(workoutRepository.upsert).toHaveBeenCalledWith(
      'user-b',
      'wahoo',
      '42',
      { externalId: '42' },
      { externalId: '42' }
    )
    expect(calculateWorkoutStress).toHaveBeenCalledWith('summary-b', 'user-b')
  })
})
