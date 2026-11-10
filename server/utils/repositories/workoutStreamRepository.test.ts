import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../db'
import {
  enforceNoNullStreamElements,
  extractDecodeColumn,
  workoutStreamRepository
} from './workoutStreamRepository'

vi.mock('../db', () => ({
  prisma: {
    workoutStreamV2: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn()
    },
    workoutStream: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn()
    },
    $queryRaw: vi.fn()
  }
}))

const db = prisma as unknown as {
  workoutStreamV2: {
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    upsert: ReturnType<typeof vi.fn>
  }
  workoutStream: {
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  $queryRaw: ReturnType<typeof vi.fn>
}

/**
 * The exact shape of the Prisma client failure this ticket is about: Postgres
 * allows a NULL element inside an `integer[]`, the client's decoder does not.
 */
function decodeError(column: string): Error {
  return new Error(`Expected an integer in column '${column}', got object: null`)
}

/** A WorkoutStreamV2 row as the DB returns it once NULL elements are repaired. */
function repairedRow(workoutId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `stream-${workoutId}`,
    workoutId,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    time: [0, 1, 2],
    heartrate: [120, 121, 122],
    watts: [200, 0, 210],
    velocity: [5.1, 5.2, 5.3],
    cadence: [90, 0, 91],
    lat: [47.5, 47.5, 47.5],
    lng: [19.0, 19.0, 19.0],
    hrZoneTimes: null,
    powerZoneTimes: null,
    ...overrides
  }
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  // V1 is empty in production; individual tests override where it matters.
  db.workoutStream.findUnique.mockResolvedValue(null)
  db.workoutStream.findMany.mockResolvedValue([])
})

afterEach(() => {
  consoleErrorSpy.mockRestore()
})

describe('extractDecodeColumn', () => {
  it('pulls the offending column out of a Prisma decode error', () => {
    expect(extractDecodeColumn(decodeError('cadence[593]'))).toBe('cadence[593]')
  })

  it('returns null for an error that names no column', () => {
    expect(extractDecodeColumn(new Error('connection reset'))).toBeNull()
  })
})

describe('findByWorkoutId', () => {
  it('returns usable stream data for a row whose arrays contain NULL elements', async () => {
    db.workoutStreamV2.findMany.mockRejectedValue(decodeError('cadence[593]'))
    db.$queryRaw.mockResolvedValue([repairedRow('workout-1')])

    const stream = await workoutStreamRepository.findByWorkoutId('workout-1')

    expect(stream).not.toBeNull()
    expect(stream?.workoutId).toBe('workout-1')
    // NULL elements are coerced to 0 rather than dropped, so every series stays
    // index-aligned with `time`.
    expect(stream?.cadence).toEqual([90, 0, 91])
    expect(stream?.time).toEqual([0, 1, 2])
    expect(stream?.latlng).toEqual([
      [47.5, 19.0],
      [47.5, 19.0],
      [47.5, 19.0]
    ])
    // The undecodable row must not fall through to the (production-empty) V1 table.
    expect(db.workoutStream.findUnique).not.toHaveBeenCalled()
  })

  it('logs the workout id and the offending column instead of swallowing the error', async () => {
    db.workoutStreamV2.findMany.mockRejectedValue(decodeError('cadence[593]'))
    db.$queryRaw.mockResolvedValue([repairedRow('workout-1')])

    await workoutStreamRepository.findByWorkoutId('workout-1')

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[workoutStreamRepository] stream read failed',
      expect.objectContaining({
        operation: 'findByWorkoutId',
        table: 'WorkoutStreamV2',
        column: 'cadence[593]',
        workoutIds: ['workout-1']
      })
    )
  })

  it('logs when the legacy V1 fallback read fails', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([])
    db.workoutStream.findUnique.mockRejectedValue(new Error('connection reset'))

    await expect(workoutStreamRepository.findByWorkoutId('workout-1')).resolves.toBeNull()

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[workoutStreamRepository] stream read failed',
      expect.objectContaining({ operation: 'findByWorkoutId', table: 'WorkoutStream' })
    )
  })
})

describe('findManyByWorkoutIds', () => {
  it('repairs the whole batch in SQL when one row cannot be decoded', async () => {
    db.workoutStreamV2.findMany.mockRejectedValue(decodeError('watts[12]'))
    db.$queryRaw.mockResolvedValue([
      repairedRow('good-1'),
      repairedRow('bad-1'),
      repairedRow('good-2')
    ])

    const streams = await workoutStreamRepository.findManyByWorkoutIds([
      'good-1',
      'bad-1',
      'good-2'
    ])

    expect([...streams.keys()].sort()).toEqual(['bad-1', 'good-1', 'good-2'])
    expect(streams.get('bad-1')?.watts).toEqual([200, 0, 210])
  })

  it('returns every row it can decode and omits only the undecodable one', async () => {
    // Both the typed read and the SQL repair hit a decode error (a column the
    // repair does not cover), which is the only thing that earns the per-row path.
    db.workoutStreamV2.findMany.mockRejectedValue(decodeError('cadence[593]'))
    db.$queryRaw.mockRejectedValue(decodeError('cadence[593]'))
    db.workoutStreamV2.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.workoutId === 'bad-1') throw decodeError('cadence[593]')
      return repairedRow(where.workoutId)
    })

    const streams = await workoutStreamRepository.findManyByWorkoutIds([
      'good-1',
      'bad-1',
      'good-2'
    ])

    expect([...streams.keys()].sort()).toEqual(['good-1', 'good-2'])
    expect(streams.has('bad-1')).toBe(false)
    expect(streams.get('good-1')?.time).toEqual([0, 1, 2])
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[workoutStreamRepository] stream read failed',
      expect.objectContaining({
        operation: 'findManyByWorkoutIds:per-row',
        workoutIds: ['bad-1']
      })
    )
  })

  it('does not escalate an infrastructure failure into a per-row fan-out', async () => {
    // A pool/statement timeout is not a decode error: there is nothing for the
    // repair read to fix, and answering an unhealthy database with one query
    // per id (200 per chunk, and chunks run concurrently) is the worst possible
    // response. It must degrade immediately, as it did before CW-453.
    db.workoutStreamV2.findMany.mockRejectedValue(
      new Error('Timed out fetching a new connection from the connection pool')
    )

    const streams = await workoutStreamRepository.findManyByWorkoutIds(['a', 'b', 'c'])

    expect(streams.size).toBe(0)
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(db.workoutStreamV2.findUnique).not.toHaveBeenCalled()
    // One log line for the chunk, not one per id.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('does not fan out per row when the repair read itself fails on infrastructure', async () => {
    db.workoutStreamV2.findMany.mockRejectedValue(decodeError('cadence[593]'))
    db.$queryRaw.mockRejectedValue(new Error('canceling statement due to statement timeout'))

    const streams = await workoutStreamRepository.findManyByWorkoutIds(['a', 'b', 'c'])

    expect(streams.size).toBe(0)
    expect(db.workoutStreamV2.findUnique).not.toHaveBeenCalled()
  })

  it('leaves the clean path untouched', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([repairedRow('good-1')])

    const streams = await workoutStreamRepository.findManyByWorkoutIds(['good-1'])

    expect(streams.get('good-1')?.watts).toEqual([200, 0, 210])
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })
})

describe('findManyByWorkoutIds baselineOnly (CW-379)', () => {
  it('selects the mandatory baseline and no optional columns', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([repairedRow('good-1')])

    const streams = await workoutStreamRepository.findManyByWorkoutIds(['good-1'], {
      baselineOnly: true
    })

    const select = db.workoutStreamV2.findMany.mock.calls[0]?.[0].select
    expect(select).toBeDefined()
    // The baseline hasUsableStreamData() needs, and nothing beyond it.
    expect(Object.keys(select).sort()).toEqual(
      [
        'createdAt',
        'heartrate',
        'hrZoneTimes',
        'id',
        'lat',
        'lng',
        'powerZoneTimes',
        'time',
        'updatedAt',
        'velocity',
        'watts',
        'workoutId'
      ].sort()
    )
    expect(select.cadence).toBeUndefined()
    expect(select.lapSplits).toBeUndefined()

    // Real series come back -- this is not the presence-only path.
    expect(streams.get('good-1')?.watts).toEqual([200, 0, 210])
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })

  it('does not fall into the presence-only path that `fields: []` triggers', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([repairedRow('good-1')])

    await workoutStreamRepository.findManyByWorkoutIds(['good-1'], { baselineOnly: true })

    // The presence probe is raw SQL and never touches the typed client.
    expect(db.workoutStreamV2.findMany).toHaveBeenCalledTimes(1)
  })

  it('still falls back to the legacy V1 table when V2 has no usable data', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([])
    db.workoutStream.findMany.mockResolvedValue([
      {
        id: 'v1-1',
        workoutId: 'good-1',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        time: [0, 1, 2],
        heartrate: [130, 131, 132],
        watts: [180, 185, 190],
        velocity: null,
        latlng: null,
        hrZoneTimes: null,
        powerZoneTimes: null
      }
    ])

    const streams = await workoutStreamRepository.findManyByWorkoutIds(['good-1'], {
      baselineOnly: true
    })

    expect(streams.get('good-1')?.watts).toEqual([180, 185, 190])
    const v1Select = db.workoutStream.findMany.mock.calls[0]?.[0].select
    expect(v1Select.latlng).toBe(true)
    expect(v1Select.cadence).toBeUndefined()
  })

  it('takes precedence over an explicit `fields: []`', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([repairedRow('good-1')])

    const streams = await workoutStreamRepository.findManyByWorkoutIds(['good-1'], {
      baselineOnly: true,
      fields: []
    })

    expect(streams.get('good-1')?.time).toEqual([0, 1, 2])
    expect(db.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('findWattsByWorkoutIds', () => {
  it('recovers watts from a row with NULL elements', async () => {
    db.workoutStreamV2.findMany.mockRejectedValue(decodeError('watts[41]'))
    db.$queryRaw.mockResolvedValue([{ workoutId: 'workout-1', watts: [250, 0, 260] }])

    const watts = await workoutStreamRepository.findWattsByWorkoutIds(['workout-1'])

    expect(watts.get('workout-1')).toEqual([250, 0, 260])
  })
})

describe('findExtrasMetaByWorkoutIds (CW-379)', () => {
  const sessionSummary = { sessionSummary: { totalAscent: 320, totalCalories: 640 } }

  it('reads one column and never the baseline series', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([
      { workoutId: 'good-1', extrasMeta: sessionSummary }
    ])

    const extras = await workoutStreamRepository.findExtrasMetaByWorkoutIds(['good-1'])

    expect(extras.get('good-1')).toEqual(sessionSummary)
    // The whole point: no time/heartrate/watts/velocity/lat/lng for a JSON blob.
    expect(db.workoutStreamV2.findMany.mock.calls[0]?.[0].select).toEqual({
      workoutId: true,
      extrasMeta: true
    })
  })

  it('falls back to the legacy V1 table when V2 has no extras metadata', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([{ workoutId: 'good-1', extrasMeta: null }])
    db.workoutStream.findMany.mockResolvedValue([
      { workoutId: 'good-1', extrasMeta: sessionSummary }
    ])

    const extras = await workoutStreamRepository.findExtrasMetaByWorkoutIds(['good-1'])

    expect(extras.get('good-1')).toEqual(sessionSummary)
    expect(db.workoutStream.findMany.mock.calls[0]?.[0].select).toEqual({
      workoutId: true,
      extrasMeta: true
    })
  })

  it('omits workouts that have no extras metadata in either table', async () => {
    db.workoutStreamV2.findMany.mockResolvedValue([{ workoutId: 'good-1', extrasMeta: null }])

    const extras = await workoutStreamRepository.findExtrasMetaByWorkoutIds(['good-1', 'missing-1'])

    expect(extras.size).toBe(0)
  })

  it('recovers extras metadata from a row the typed client cannot decode', async () => {
    db.workoutStreamV2.findMany.mockRejectedValue(decodeError('cadence[593]'))
    db.$queryRaw.mockResolvedValue([{ workoutId: 'bad-1', extrasMeta: sessionSummary }])

    const extras = await workoutStreamRepository.findExtrasMetaByWorkoutIds(['bad-1'])

    expect(extras.get('bad-1')).toEqual(sessionSummary)
  })
})

describe('upsert write guard', () => {
  it('never writes a NULL element into a numeric or boolean array', async () => {
    db.workoutStreamV2.upsert.mockResolvedValue({ id: 'stream-1' })

    await workoutStreamRepository.upsert('workout-1', {
      time: [0, null as any, 2],
      cadence: [90, null as any, 91],
      watts: [200, undefined as any, 210],
      altitude: [100.5, null as any, 101.5],
      moving: [true, null as any, false],
      latlng: [
        [47.5, 19.0],
        [null as any, 19.1],
        [47.6, 19.2]
      ]
    })

    const payload = db.workoutStreamV2.upsert.mock.calls[0]?.[0].update
    for (const column of ['time', 'cadence', 'watts', 'altitude', 'moving', 'lat', 'lng']) {
      expect(payload[column].some((value: unknown) => value == null)).toBe(false)
    }
    expect(payload.time).toEqual([0, 0, 2])
    expect(payload.cadence).toEqual([90, 0, 91])
    expect(payload.watts).toEqual([200, 0, 210])
    expect(payload.moving).toEqual([true, false, false])
    // The invalid GPS point is skipped, so lat/lng stay pairwise consistent.
    expect(payload.lat).toHaveLength(2)
    expect(payload.lng).toHaveLength(2)
  })

  it('logs loudly if a NULL element ever reaches the final guard', () => {
    const writeData: Record<string, unknown> = { cadence: [90, null, 91], lapSplits: [null] }

    enforceNoNullStreamElements(writeData, 'workout-1')

    expect(writeData.cadence).toEqual([90, 0, 91])
    // JSON metadata may legitimately contain nulls and must not be rewritten.
    expect(writeData.lapSplits).toEqual([null])
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[workoutStreamRepository] blocked NULL element in stream write',
      expect.objectContaining({ workoutId: 'workout-1', column: 'cadence', index: 1 })
    )
  })
})

/* ------------------------------------------------------------------------- *
 * CW-379 regression guard: no new raw `streams` relation reads under server/
 * ------------------------------------------------------------------------- */

/**
 * Blank out `//` and block comments so the scan below never trips over prose.
 *
 * Several of the CW-379 migrations quote the raw read they replaced (`this
 * used to be streams: { select: { id: true } }`), which is exactly the string
 * the detector looks for -- and a naive strip would also mangle `https://` in
 * a string literal. This walks the source instead, tracking string/template
 * state, and replaces comment bodies with spaces so offsets stay intact.
 */
function stripComments(source: string): string {
  const out: string[] = []
  let i = 0
  let quote: string | null = null

  while (i < source.length) {
    const char = source[i]!
    const next = source[i + 1]

    if (quote) {
      if (char === '\\') {
        out.push(char, source[i + 1] ?? '')
        i += 2
        continue
      }
      if (char === quote) quote = null
      out.push(char)
      i++
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out.push(char)
      i++
      continue
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out.push(' ')
        i++
      }
      continue
    }

    if (char === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out.push(source[i] === '\n' ? '\n' : ' ')
        i++
      }
      out.push(' ', ' ')
      i += 2
      continue
    }

    out.push(char)
    i++
  }

  return out.join('')
}

/**
 * A Prisma read of the **legacy V1** `streams` relation: `streams: true`, or
 * `streams: { select|include|omit|where ... }` inside an `include`/`select`
 * block.
 *
 * Deliberately narrow. It must not fire on the things that legitimately spell
 * `streams:` -- the correct existence filter `streams: { isNot: null }`, the
 * BullMQ queue snapshot in worker-monitoring.ts, plain property assignment
 * (`streams: workout.streams`, `streams: null`), or a type annotation.
 */
const RAW_STREAMS_RELATION_READ = /\bstreams\s*:\s*(?:true\b|\{\s*(?:select|include|omit|where)\b)/g

/**
 * The same bug with a different spelling: going at the legacy V1 table through
 * the Prisma client directly instead of the relation. There are none of these
 * under `server/` today outside the repository itself, but `prisma.workoutStream
 * .findMany({ where: { workoutId: ... } })` would reintroduce exactly the
 * V2-blind read the relation pattern above was doing.
 *
 * The repository is the one place that is *supposed* to touch both tables, so
 * it is exempt (see REPOSITORY_SOURCE below).
 */
const DIRECT_V1_CLIENT_READ = /\bprisma\s*(?:as\s+any\s*\)?\s*)?\.\s*workoutStream\s*\./g

/** The repository itself -- the intended owner of both tables' reads. */
const REPOSITORY_SOURCE = 'server/utils/repositories/workoutStreamRepository.ts'

/**
 * Files still reading the V1 relation directly, each with the reason it is not
 * fixed here. Every entry is a real bug of the CW-379 class (V2-only athletes
 * silently get no data) that falls **outside this ticket's Owned Paths** and is
 * filed separately -- not an approved exception.
 *
 * The test below asserts this list is exhaustive *and* that every entry still
 * violates, so fixing one forces its removal rather than letting the allowlist
 * rot into a permanent exemption.
 */
const KNOWN_UNMIGRATED = new Map<string, string>([
  [
    'server/api/performance/ftp-evolution.get.ts',
    'Two `include: { streams: { select: { watts: true } } }` reads in the FTP estimation and validation queries. Outside CW-379 Owned Paths.'
  ],
  [
    'server/utils/services/deduplicationService.ts',
    'mergeDuplicateGroup() existence check `streams: { select: { id: true } }`; needs an OR filter over streams/streamsV2. Outside CW-379 Owned Paths.'
  ],
  [
    'server/utils/services/checkin-service.ts',
    'Daily check-in reads hrZoneTimes/powerZoneTimes off the V1 relation. Outside CW-379 Owned Paths.'
  ],
  [
    'server/utils/workout-insight-email.ts',
    'Insight email selects the full V1 series set for its charts. Outside CW-379 Owned Paths.'
  ]
])

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function collectServerSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      collectServerSources(full, found)
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    found.push(full)
  }
  return found
}

function matches(pattern: RegExp, source: string): boolean {
  pattern.lastIndex = 0
  const hit = pattern.test(source)
  pattern.lastIndex = 0
  return hit
}

function findRawStreamReads(): string[] {
  const offenders: string[] = []
  for (const file of collectServerSources(SERVER_DIR)) {
    const path = relative(REPO_ROOT, file)
    const source = stripComments(readFileSync(file, 'utf8'))

    if (matches(RAW_STREAMS_RELATION_READ, source)) {
      offenders.push(path)
      continue
    }
    if (path !== REPOSITORY_SOURCE && matches(DIRECT_V1_CLIENT_READ, source)) {
      offenders.push(path)
    }
  }
  return offenders.sort()
}

describe('no raw V1 `streams` relation reads under server/ (CW-379)', () => {
  it('detects the raw read shapes and ignores the legitimate ones', () => {
    const flagged = (source: string) =>
      matches(RAW_STREAMS_RELATION_READ, stripComments(source)) ||
      matches(DIRECT_V1_CLIENT_READ, stripComments(source))

    // Positive controls -- exactly the bug this ticket swept up.
    expect(flagged('select: { id: true, streams: { select: { watts: true } } }')).toBe(true)
    expect(flagged('include: {\n  streams: {\n    select: { lapSplits: true }\n  }\n}')).toBe(true)
    expect(flagged('include: { streams: true }')).toBe(true)
    expect(flagged('include: { streams: { omit: { latlng: true } } }')).toBe(true)
    expect(flagged('include: { streams: { where: { id: { not: null } } } }')).toBe(true)
    // Same bug, different spelling: the V1 table straight off the client.
    expect(flagged('await prisma.workoutStream.findMany({ where: { workoutId } })')).toBe(true)
    expect(flagged('(prisma as any).workoutStream.findUnique({ where: { workoutId } })')).toBe(true)

    // Negative controls -- these must never fail a build.
    expect(flagged('OR: [{ streams: { isNot: null } }, { streamsV2: { isNot: null } }]')).toBe(
      false
    )
    expect(flagged('return { ...workout, streams }')).toBe(false)
    expect(flagged('streams: workout.streams')).toBe(false)
    expect(flagged('streams: QueueCounts & { workers: number }')).toBe(false)
    expect(flagged('streamsV2: { select: { watts: true } }')).toBe(false)
    // V2 straight off the client is a different (non-V1-blind) concern.
    expect(flagged('(prisma as any).workoutStreamV2.findMany({})')).toBe(false)
    // A migration comment quoting the read it removed is prose, not a read.
    expect(flagged('// this used to be streams: { select: { id: true } }')).toBe(false)
    expect(flagged('/* streams: { include: { x: true } } */')).toBe(false)
  })

  it('flags no file outside the documented, separately-filed backlog', () => {
    const unexpected = findRawStreamReads().filter((file) => !KNOWN_UNMIGRATED.has(file))

    expect(
      unexpected,
      'Stream writes go to WorkoutStreamV2 only. Reading the `streams` relation -- or the ' +
        '`workoutStream` model off the Prisma client -- sees the legacy V1 table alone, so it ' +
        'silently returns nothing for V2-only athletes (CW-377/CW-379). Read through ' +
        'workoutStreamRepository / attachStreamToWorkout / attachStreamsToWorkouts, or for a pure ' +
        'existence check use `OR: [{ streams: { isNot: null } }, { streamsV2: { isNot: null } }]`.'
    ).toEqual([])
  })

  it('keeps the allowlist honest: no entry that no longer violates', () => {
    const offenders = new Set(findRawStreamReads())
    const stale = [...KNOWN_UNMIGRATED.keys()].filter((file) => !offenders.has(file))

    expect(
      stale,
      'These files no longer read the V1 relation -- drop them from KNOWN_UNMIGRATED.'
    ).toEqual([])
  })
})
