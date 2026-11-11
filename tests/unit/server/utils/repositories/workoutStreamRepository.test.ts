import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  sanitizeBooleanStreamArray,
  sanitizeFloatStreamArray,
  sanitizeIntStreamArray,
  splitLatlngPoints,
  workoutStreamRepository
} from '../../../../../server/utils/repositories/workoutStreamRepository'
import { prisma } from '../../../../../server/utils/db'

const workoutStreamV2 = {
  upsert: vi.fn(),
  findMany: vi.fn()
}

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    workoutStream: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn()
    },
    $queryRaw: vi.fn(),
    get workoutStreamV2() {
      return workoutStreamV2
    }
  }
}))

/** Flattened SQL text of the Nth prisma.$queryRaw call. */
function rawSqlOf(callIndex: number): string {
  const arg = vi.mocked(prisma.$queryRaw).mock.calls[callIndex]![0] as unknown as { sql: string }
  return arg.sql
}

/** Bind parameters of the Nth prisma.$queryRaw call. */
function rawValuesOf(callIndex: number): unknown[] {
  const arg = vi.mocked(prisma.$queryRaw).mock.calls[callIndex]![0] as unknown as {
    values: unknown[]
  }
  return arg.values
}

describe('workoutStreamRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workoutStreamV2.upsert.mockResolvedValue({ id: 'stream-1' })
  })

  describe('sanitizeIntStreamArray', () => {
    it('coerces null gaps to 0 while preserving array length', () => {
      expect(sanitizeIntStreamArray([null, null, 88, 90] as unknown as number[])).toEqual([
        0, 0, 88, 90
      ])
    })

    it('truncates float values for Int[] columns', () => {
      expect(sanitizeIntStreamArray([118.9, null] as unknown as number[])).toEqual([118, 0])
    })
  })

  describe('sanitizeFloatStreamArray', () => {
    it('coerces null gaps to 0 while preserving array length', () => {
      expect(sanitizeFloatStreamArray([null, null, 12.5, 90] as unknown as number[])).toEqual([
        0,
        0,
        12.5,
        90 + 1e-9
      ])
    })

    it('promotes whole numbers so Prisma accepts Float[] arrays', () => {
      const result = sanitizeFloatStreamArray([null, 100, 200.5] as unknown as number[])
      expect(result[0]).toBe(0)
      expect(result[1]).toBe(100 + 1e-9)
      expect(result[2]).toBe(200.5)
    })
  })

  describe('sanitizeBooleanStreamArray', () => {
    it('coerces null gaps to false', () => {
      expect(sanitizeBooleanStreamArray([null, true, false] as unknown as boolean[])).toEqual([
        false,
        true,
        false
      ])
    })
  })

  describe('splitLatlngPoints', () => {
    it('skips null lat/lng pairs from Intervals stream payloads', () => {
      expect(
        splitLatlngPoints([[48.85, 2.35], null, [48.86, 2.36], [48.87], 'invalid'] as unknown[])
      ).toEqual({
        lat: [48.85, 48.86],
        lng: [2.35, 2.36]
      })
    })
  })

  describe('upsert', () => {
    it('preserves omitted series while retaining create defaults', async () => {
      await workoutStreamRepository.upsert('workout-1', { hrZoneTimes: [1, 2], latlng: undefined })
      const { create, update } = workoutStreamV2.upsert.mock.calls.at(-1)![0]
      expect(update).toEqual({ hrZoneTimes: [1, 2], updatedAt: expect.any(Date) })
      expect(create).toMatchObject({ time: [], watts: [], lat: [], lng: [] })
    })

    it('writes supplied empty and sanitized series including coordinates', async () => {
      await workoutStreamRepository.upsert('workout-1', {
        time: [],
        cadence: [null, 88] as unknown as number[],
        latlng: [[48.85, 2.35], null] as unknown as [number, number][]
      })
      const { update } = workoutStreamV2.upsert.mock.calls.at(-1)![0]
      expect(update).toEqual({
        time: [],
        cadence: [0, 88],
        lat: [48.85],
        lng: [2.35],
        updatedAt: expect.any(Date)
      })
    })

    it('sanitizes nullable cadence values before writing to WorkoutStreamV2', async () => {
      await workoutStreamRepository.upsert('workout-1', {
        cadence: [null, null, 88, 90] as unknown as number[]
      })

      expect(workoutStreamV2.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            cadence: [0, 0, 88, 90]
          }),
          update: expect.objectContaining({
            cadence: [0, 0, 88, 90]
          })
        })
      )
    })

    it('sanitizes nullable distance values for Float[] columns', async () => {
      await workoutStreamRepository.upsert('workout-1', {
        distance: [null, null, 100, 200.5] as unknown as number[]
      })

      expect(workoutStreamV2.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            distance: [0, 0, 100 + 1e-9, 200.5]
          })
        })
      )
    })

    it('skips null lat/lng pairs when persisting GPS streams', async () => {
      await workoutStreamRepository.upsert('workout-1', {
        latlng: [[48.85, 2.35], null, [48.86, 2.36]] as unknown as [number, number][]
      })

      expect(workoutStreamV2.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            lat: [48.85, 48.86],
            lng: [2.35, 2.36]
          })
        })
      )
    })
  })

  describe('findManyByWorkoutIds', () => {
    beforeEach(() => {
      workoutStreamV2.findMany.mockResolvedValue([])
      vi.mocked(prisma.workoutStream.findMany).mockResolvedValue([] as any)
    })

    it('fetches every column when no `fields` option is given (default/full behavior)', async () => {
      workoutStreamV2.findMany.mockResolvedValue([
        { workoutId: 'workout-1', time: [0, 1], watts: [100, 110], lat: [], lng: [] }
      ])

      await workoutStreamRepository.findManyByWorkoutIds(['workout-1'])

      expect(workoutStreamV2.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workoutId: { in: ['workout-1'] } }
        })
      )
      // No `select` key at all -- Prisma returns every column.
      const call = workoutStreamV2.findMany.mock.calls[0]![0]
      expect(call.select).toBeUndefined()
    })

    it('passes an explicit `select` limited to the mandatory baseline plus requested fields', async () => {
      workoutStreamV2.findMany.mockResolvedValue([
        {
          workoutId: 'workout-1',
          time: [0, 1],
          heartrate: [90, 95],
          watts: [100, 110],
          velocity: [1, 2],
          lat: [],
          lng: [],
          hrZoneTimes: null,
          powerZoneTimes: null,
          distance: [0, 10]
        }
      ])

      await workoutStreamRepository.findManyByWorkoutIds(['workout-1'], { fields: ['distance'] })

      expect(workoutStreamV2.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workoutId: { in: ['workout-1'] } },
          select: expect.objectContaining({
            // mandatory baseline required by hasUsableStreamData()
            time: true,
            heartrate: true,
            watts: true,
            velocity: true,
            lat: true,
            lng: true,
            hrZoneTimes: true,
            powerZoneTimes: true,
            // explicitly requested extra field
            distance: true
          })
        })
      )

      // Fields never requested (and not part of the mandatory baseline)
      // must not be present in the select at all.
      const call = workoutStreamV2.findMany.mock.calls[0]![0]
      expect(call.select.cadence).toBeUndefined()
      expect(call.select.lapSplits).toBeUndefined()
      expect(call.select.extrasMeta).toBeUndefined()
    })

    it('splits a large IN(...) clause into chunks of at most 200 IDs', async () => {
      const workoutIds = Array.from({ length: 450 }, (_, i) => `workout-${i}`)

      await workoutStreamRepository.findManyByWorkoutIds(workoutIds)

      expect(workoutStreamV2.findMany).toHaveBeenCalledTimes(3)
      const callSizes = workoutStreamV2.findMany.mock.calls.map(
        (call: any[]) => call[0].where.workoutId.in.length
      )
      expect(callSizes).toEqual([200, 200, 50])
    })

    it('falls back to the legacy V1 table (with the same lean select) for workouts missing a V2 row', async () => {
      workoutStreamV2.findMany.mockResolvedValue([])
      vi.mocked(prisma.workoutStream.findMany).mockResolvedValue([
        { workoutId: 'workout-legacy', time: [0, 1], watts: [120], latlng: [] }
      ] as any)

      const streams = await workoutStreamRepository.findManyByWorkoutIds(['workout-legacy'], {
        fields: ['distance']
      })

      expect(prisma.workoutStream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workoutId: { in: ['workout-legacy'] } },
          select: expect.objectContaining({
            time: true,
            heartrate: true,
            watts: true,
            velocity: true,
            latlng: true,
            hrZoneTimes: true,
            powerZoneTimes: true,
            distance: true
          })
        })
      )
      expect(streams.get('workout-legacy')).toBeTruthy()
    })
  })

  // CW-296: `fields: []` means "does this workout have usable streams at all?".
  // Callers: trigger/deduplicate-workouts.ts and intervalsService.deleteActivity,
  // both of which only test `workout.streams` for truthiness.
  describe('findManyByWorkoutIds (presence-only, `fields: []`)', () => {
    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any)
    })

    it('never selects a series column: it probes usability in SQL instead', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        {
          id: 'stream-1',
          workoutId: 'workout-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          hasData: true
        }
      ] as any)

      const streams = await workoutStreamRepository.findManyByWorkoutIds(['workout-1'], {
        fields: []
      })

      // The wide findMany that produced the Sentry slow query is gone.
      expect(workoutStreamV2.findMany).not.toHaveBeenCalled()
      expect(prisma.workoutStream.findMany).not.toHaveBeenCalled()

      const sql = rawSqlOf(0)
      expect(sql).toContain('"WorkoutStreamV2"')
      expect(sql).toContain('array_length("time", 1)')
      expect(sql).toContain('AS "hasData"')
      expect(rawValuesOf(0)).toEqual(['workout-1'])

      const stream = streams.get('workout-1')
      expect(stream).toBeTruthy()
      expect(stream!.workoutId).toBe('workout-1')
      // Presence-only streams carry no payload by design.
      expect(stream!.time).toBeNull()
      expect(stream!.watts).toBeNull()
      expect(stream!.latlng).toBeNull()
      expect(stream!.hrZoneTimes).toBeNull()
    })

    it('omits workouts whose V2 row exists but holds no usable data', async () => {
      vi.mocked(prisma.$queryRaw)
        .mockResolvedValueOnce([
          {
            id: 'stream-empty',
            workoutId: 'workout-empty',
            createdAt: new Date(),
            updatedAt: new Date(),
            hasData: false
          }
        ] as any)
        .mockResolvedValueOnce([] as any)

      const streams = await workoutStreamRepository.findManyByWorkoutIds(['workout-empty'], {
        fields: []
      })

      expect(streams.size).toBe(0)
    })

    it('falls back to the legacy V1 table for workouts with no usable V2 row', async () => {
      vi.mocked(prisma.$queryRaw)
        .mockResolvedValueOnce([] as any)
        .mockResolvedValueOnce([
          {
            id: 'v1-stream',
            workoutId: 'workout-legacy',
            createdAt: new Date(),
            updatedAt: new Date(),
            hasData: true
          }
        ] as any)

      const streams = await workoutStreamRepository.findManyByWorkoutIds(['workout-legacy'], {
        fields: []
      })

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
      const v1Sql = rawSqlOf(1)
      expect(v1Sql).toContain('"WorkoutStream"')
      expect(v1Sql).toContain(`jsonb_typeof("time") = 'array'`)
      expect(rawValuesOf(1)).toEqual(['workout-legacy'])
      expect(streams.get('workout-legacy')).toBeTruthy()
    })

    it('skips the V1 probe entirely when every workout has usable V2 data', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        {
          id: 'stream-1',
          workoutId: 'workout-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          hasData: true
        }
      ] as any)

      await workoutStreamRepository.findManyByWorkoutIds(['workout-1'], { fields: [] })

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    })

    it('chunks the presence probe at 200 IDs per query', async () => {
      const workoutIds = Array.from({ length: 450 }, (_, i) => `workout-${i}`)

      await workoutStreamRepository.findManyByWorkoutIds(workoutIds, { fields: [] })

      // 3 V2 probes; every ID is unresolved so 3 more V1 probes follow.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(6)
      expect(rawValuesOf(0)).toHaveLength(200)
      expect(rawValuesOf(1)).toHaveLength(200)
      expect(rawValuesOf(2)).toHaveLength(50)
    })

    it('returns an empty map without querying for an empty ID list', async () => {
      const streams = await workoutStreamRepository.findManyByWorkoutIds([], { fields: [] })

      expect(streams.size).toBe(0)
      expect(prisma.$queryRaw).not.toHaveBeenCalled()
    })
  })

  describe('findWattsByWorkoutIds', () => {
    beforeEach(() => {
      workoutStreamV2.findMany.mockResolvedValue([])
      vi.mocked(prisma.workoutStream.findMany).mockResolvedValue([] as any)
    })

    it('returns an empty map without querying when given no IDs', async () => {
      const watts = await workoutStreamRepository.findWattsByWorkoutIds([])

      expect(watts.size).toBe(0)
      expect(workoutStreamV2.findMany).not.toHaveBeenCalled()
      expect(prisma.workoutStream.findMany).not.toHaveBeenCalled()
    })

    it('reads watts from WorkoutStreamV2 and selects only the watts column', async () => {
      workoutStreamV2.findMany.mockResolvedValue([
        { workoutId: 'workout-1', watts: [100, 110, 120] }
      ])

      const watts = await workoutStreamRepository.findWattsByWorkoutIds(['workout-1'])

      expect(workoutStreamV2.findMany).toHaveBeenCalledWith({
        where: { workoutId: { in: ['workout-1'] } },
        select: { workoutId: true, watts: true }
      })
      expect(watts.get('workout-1')).toEqual([100, 110, 120])
      // V2 covered every ID, so the legacy table is never touched.
      expect(prisma.workoutStream.findMany).not.toHaveBeenCalled()
    })

    it('falls back to the legacy V1 table for workouts with no usable V2 watts', async () => {
      workoutStreamV2.findMany.mockResolvedValue([
        { workoutId: 'workout-v2', watts: [200] },
        // Present in V2 but with no power series -- must still fall back.
        { workoutId: 'workout-empty-v2', watts: [] }
      ])
      vi.mocked(prisma.workoutStream.findMany).mockResolvedValue([
        { workoutId: 'workout-empty-v2', watts: [150] },
        { workoutId: 'workout-v1-only', watts: [175] }
      ] as any)

      const watts = await workoutStreamRepository.findWattsByWorkoutIds([
        'workout-v2',
        'workout-empty-v2',
        'workout-v1-only'
      ])

      expect(prisma.workoutStream.findMany).toHaveBeenCalledWith({
        where: { workoutId: { in: ['workout-empty-v2', 'workout-v1-only'] } },
        select: { workoutId: true, watts: true }
      })
      expect(watts.get('workout-v2')).toEqual([200])
      expect(watts.get('workout-empty-v2')).toEqual([150])
      expect(watts.get('workout-v1-only')).toEqual([175])
    })

    it('omits workouts that have no power data in either table', async () => {
      workoutStreamV2.findMany.mockResolvedValue([{ workoutId: 'workout-hr-only', watts: [] }])
      vi.mocked(prisma.workoutStream.findMany).mockResolvedValue([
        { workoutId: 'workout-hr-only', watts: null }
      ] as any)

      const watts = await workoutStreamRepository.findWattsByWorkoutIds([
        'workout-hr-only',
        'workout-no-streams'
      ])

      expect(watts.size).toBe(0)
    })

    it('splits a large IN(...) clause into chunks of at most 200 IDs', async () => {
      const workoutIds = Array.from({ length: 450 }, (_, i) => `workout-${i}`)

      await workoutStreamRepository.findWattsByWorkoutIds(workoutIds)

      expect(workoutStreamV2.findMany).toHaveBeenCalledTimes(3)
      const callSizes = workoutStreamV2.findMany.mock.calls.map(
        (call: any[]) => call[0].where.workoutId.in.length
      )
      expect(callSizes).toEqual([200, 200, 50])
    })
  })
})
