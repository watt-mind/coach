import { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { toPrismaInputJsonValue } from '../prisma-json'

export type NormalizedStream = {
  id: string
  workoutId: string
  time: number[] | null
  distance: number[] | null
  velocity: number[] | null
  heartrate: number[] | null
  cadence: number[] | null
  watts: number[] | null
  altitude: number[] | null
  latlng: [number, number][] | null
  grade: number[] | null
  moving: boolean[] | null
  temp: number[] | null
  torque: number[] | null
  leftRightBalance: number[] | null
  hrv: number[] | null
  respiration: number[] | null
  targetPower: number[] | null
  avgPacePerKm: number | null
  paceVariability: number | null
  lapSplits: unknown
  paceZones: unknown
  pacingStrategy: unknown
  surges: unknown
  hrZoneTimes: unknown
  powerZoneTimes: unknown
  extrasMeta: unknown
  createdAt: Date
  updatedAt: Date
}

function normalizeV2(stream: any): NormalizedStream {
  const { lat, lng, ...rest } = stream
  const latlng: [number, number][] | null =
    Array.isArray(lat) && lat.length > 0
      ? (lat as number[]).map((latVal: number, i: number) => [latVal, (lng as number[])[i] ?? 0])
      : null
  return { ...rest, latlng }
}

function hasUsableStreamData(stream: NormalizedStream | null): stream is NormalizedStream {
  if (!stream) return false
  if (Array.isArray(stream.time) && stream.time.length > 0) return true
  if (Array.isArray(stream.heartrate) && stream.heartrate.length > 0) return true
  if (Array.isArray(stream.watts) && stream.watts.length > 0) return true
  if (Array.isArray(stream.velocity) && stream.velocity.length > 0) return true
  if (Array.isArray(stream.latlng) && stream.latlng.length > 0) return true
  if (stream.hrZoneTimes != null) return true
  if (stream.powerZoneTimes != null) return true
  return false
}

function toNormalizedFromV1(stream: any): NormalizedStream {
  return stream as NormalizedStream
}

/** Prisma Int[] columns reject null elements; preserve series length by coercing gaps to 0. */
export function sanitizeIntStreamArray(values: readonly unknown[] | null | undefined): number[] {
  if (!values?.length) return []
  return values.map((value) => {
    if (value == null || !Number.isFinite(Number(value))) return 0
    return Math.trunc(Number(value))
  })
}

/**
 * Prisma Float[] columns reject nulls and mixed integer/float elements in one array.
 * Coerce nulls to 0 and ensure whole numbers are encoded as floats for client validation.
 */
export function sanitizeFloatStreamArray(values: readonly unknown[] | null | undefined): number[] {
  if (!values?.length) return []
  return values.map((value) => {
    if (value == null || !Number.isFinite(Number(value))) return 0
    const n = Number(value)
    return Number.isInteger(n) ? n + 1e-9 : n
  })
}

/** @deprecated Use sanitizeIntStreamArray or sanitizeFloatStreamArray */
export function sanitizeNumericStreamArray(values: number[] | null | undefined): number[] {
  return sanitizeIntStreamArray(values)
}

export function sanitizeBooleanStreamArray(values: boolean[] | null | undefined): boolean[] {
  if (!values?.length) return []
  return values.map((value) => value === true)
}

/** Intervals stream payloads can include null lat/lng pairs; skip invalid points instead of throwing. */
export function splitLatlngPoints(latlng: readonly unknown[] | null | undefined): {
  lat: number[]
  lng: number[]
} {
  if (!latlng?.length) return { lat: [], lng: [] }

  const lat: number[] = []
  const lng: number[] = []

  for (const point of latlng) {
    if (!Array.isArray(point) || point.length < 2) continue

    const latVal = point[0]
    const lngVal = point[1]
    if (latVal == null || lngVal == null) continue
    if (!Number.isFinite(Number(latVal)) || !Number.isFinite(Number(lngVal))) continue

    lat.push(Number(latVal))
    lng.push(Number(lngVal))
  }

  return { lat, lng }
}

/**
 * Every array column written to WorkoutStreamV2, mapped to the sanitizer that
 * makes it safe for Prisma to read back (CW-453 write-path guard).
 *
 * Building the upsert payload by iterating this table instead of listing the
 * columns inline keeps "which columns are series" defined exactly once -- the
 * same list the invariant check below walks, so a column can't be sanitized on
 * write and then skipped by the guard (or vice versa).
 */
const V2_ARRAY_WRITE_SANITIZERS: Record<string, (values: any) => Array<number | boolean>> = {
  lat: sanitizeFloatStreamArray,
  lng: sanitizeFloatStreamArray,
  time: sanitizeIntStreamArray,
  distance: sanitizeFloatStreamArray,
  velocity: sanitizeFloatStreamArray,
  heartrate: sanitizeIntStreamArray,
  cadence: sanitizeIntStreamArray,
  watts: sanitizeIntStreamArray,
  altitude: sanitizeFloatStreamArray,
  grade: sanitizeFloatStreamArray,
  moving: sanitizeBooleanStreamArray,
  temp: sanitizeIntStreamArray,
  torque: sanitizeIntStreamArray,
  leftRightBalance: sanitizeIntStreamArray,
  hrv: sanitizeFloatStreamArray,
  respiration: sanitizeFloatStreamArray,
  targetPower: sanitizeIntStreamArray
}

const BOOLEAN_WRITE_COLUMNS: ReadonlySet<string> = new Set(['moving'])

function isUnwritableStreamElement(value: unknown): boolean {
  return value == null || (typeof value === 'number' && !Number.isFinite(value))
}

/**
 * Last line of defence before `upsert()`: no numeric/boolean series may contain
 * a NULL (or non-finite) element, because Postgres accepts it happily and the
 * Prisma client then cannot read the row back at all (CW-453).
 *
 * The sanitizers above already guarantee this, so a repair here means one of
 * them regressed or a series bypassed them -- which is logged loudly rather
 * than corrected in silence. Only the known series columns are inspected: JSON
 * metadata such as `lapSplits` may legitimately contain nulls and is untouched.
 */
export function enforceNoNullStreamElements(
  writeData: Record<string, unknown>,
  workoutId: string
): void {
  for (const column of Object.keys(V2_ARRAY_WRITE_SANITIZERS)) {
    const values = writeData[column]
    if (!Array.isArray(values)) continue
    const index = values.findIndex(isUnwritableStreamElement)
    if (index === -1) continue

    console.error('[workoutStreamRepository] blocked NULL element in stream write', {
      operation: 'upsert',
      workoutId,
      column,
      index
    })
    const fallback: number | boolean = BOOLEAN_WRITE_COLUMNS.has(column) ? false : 0
    writeData[column] = values.map((value) => (isUnwritableStreamElement(value) ? fallback : value))
  }
}

export async function attachStreamToWorkout<T extends { id: string }>(
  workout: T
): Promise<T & { streams: NormalizedStream | null }> {
  const streams = await workoutStreamRepository.findByWorkoutId(workout.id)
  return { ...workout, streams }
}

export async function attachStreamsToWorkouts<T extends { id: string }>(
  workouts: T[],
  options?: FindManyByWorkoutIdsOptions
): Promise<Array<T & { streams: NormalizedStream | null }>> {
  const streamMap = await workoutStreamRepository.findManyByWorkoutIds(
    workouts.map((w) => w.id),
    options
  )
  return workouts.map((workout) => ({
    ...workout,
    streams: streamMap.get(workout.id) ?? null
  }))
}

/**
 * Optional, non-mandatory NormalizedStream fields that a caller of
 * findManyByWorkoutIds/attachStreamsToWorkouts can opt into fetching on top of
 * the mandatory baseline (see REQUIRED_V2_SELECT/REQUIRED_V1_SELECT below).
 */
export type WorkoutStreamOptionalField =
  | 'distance'
  | 'cadence'
  | 'altitude'
  | 'grade'
  | 'moving'
  | 'temp'
  | 'torque'
  | 'leftRightBalance'
  | 'hrv'
  | 'respiration'
  | 'targetPower'
  | 'avgPacePerKm'
  | 'paceVariability'
  | 'lapSplits'
  | 'paceZones'
  | 'pacingStrategy'
  | 'surges'
  | 'extrasMeta'

export interface FindManyByWorkoutIdsOptions {
  /**
   * Extra columns to fetch beyond the mandatory baseline. When omitted
   * (undefined), every column is fetched -- this is the original/default
   * behavior and should be kept for callers that need full-fidelity stream
   * data (e.g. the GDPR/migration data export in data-management/collector.ts).
   *
   * When provided with at least one field, the mandatory baseline
   * (REQUIRED_V2_SELECT/REQUIRED_V1_SELECT) plus whatever is listed here is
   * fetched, which is dramatically cheaper for hot paths that read a handful
   * of scalar fields off potentially hundreds of workouts' streams at once.
   *
   * An **empty array** means "presence only": the caller never reads a stream
   * field and only tests whether a workout has usable stream data at all. That
   * takes a separate, much cheaper code path -- see
   * findStreamPresenceByWorkoutIds() -- which transfers no series data
   * whatsoever. Streams returned that way have every series/metadata field set
   * to null; only id/workoutId/createdAt/updatedAt are populated. Do not pass
   * `fields: []` if you intend to read anything off the returned stream.
   */
  fields?: readonly WorkoutStreamOptionalField[]

  /**
   * Fetch exactly the mandatory baseline (REQUIRED_V2_SELECT/REQUIRED_V1_SELECT)
   * and nothing else.
   *
   * `fields` alone cannot express this: `undefined` means "every column" and
   * `[]` is already taken by the presence-only path, so a caller that reads
   * only baseline series -- `time`/`heartrate`/`watts`/`velocity`/`latlng` and
   * the two zone-time blobs -- previously had to either haul every column or
   * name a throwaway optional field to get a lean select. Several CW-379 call
   * sites (weekly zone aggregation, FTP/LTHR autodetection, the team
   * power-duration preset) are exactly that shape, over hundreds of workouts.
   *
   * Takes precedence over `fields`, and never routes to the presence path --
   * the returned streams carry real series data.
   */
  baselineOnly?: boolean
}

/**
 * Columns always fetched from WorkoutStreamV2 once a caller opts into a lean
 * `fields` selection. `time`/`heartrate`/`watts`/`velocity`/`lat`/`lng`/
 * `hrZoneTimes`/`powerZoneTimes` are required because hasUsableStreamData()
 * inspects them to decide whether a V2 row counts as "usable" stream data
 * (falling back to the legacy V1 table otherwise) -- dropping any of them
 * would silently change that determination for every caller, not just the
 * one requesting a lean select. `id`/`workoutId`/`createdAt`/`updatedAt` are
 * cheap identity/bookkeeping columns kept for parity with NormalizedStream.
 */
const REQUIRED_V2_SELECT = {
  id: true,
  workoutId: true,
  createdAt: true,
  updatedAt: true,
  time: true,
  heartrate: true,
  watts: true,
  velocity: true,
  lat: true,
  lng: true,
  hrZoneTimes: true,
  powerZoneTimes: true
} as const

/** Same rationale as REQUIRED_V2_SELECT, but for the legacy V1 fallback table (single `latlng` Json column instead of split lat/lng arrays). */
const REQUIRED_V1_SELECT = {
  id: true,
  workoutId: true,
  createdAt: true,
  updatedAt: true,
  time: true,
  heartrate: true,
  watts: true,
  velocity: true,
  latlng: true,
  hrZoneTimes: true,
  powerZoneTimes: true
} as const

function buildV2Select(
  fields: readonly WorkoutStreamOptionalField[] | undefined
): Record<string, true> | undefined {
  if (fields === undefined) return undefined
  const select: Record<string, true> = { ...REQUIRED_V2_SELECT }
  for (const field of fields) select[field] = true
  return select
}

function buildV1Select(
  fields: readonly WorkoutStreamOptionalField[] | undefined
): Record<string, true> | undefined {
  if (fields === undefined) return undefined
  const select: Record<string, true> = { ...REQUIRED_V1_SELECT }
  for (const field of fields) select[field] = true
  return select
}

/**
 * CW-453: Postgres permits NULL *elements* inside `integer[]` / `double
 * precision[]`, the Prisma client does not. Reading such a row throws
 * `Expected an integer in column 'cadence[593]', got object: null` and used to
 * be swallowed by a bare `.catch()`, so ~24% of production streams rendered as
 * "no stream data at all".
 *
 * The columns below drive a raw-SQL fallback read that repairs those rows on
 * the way out with `array_replace(col, NULL, 0)`.
 *
 * **NULL element -> 0, never dropped.** Every series in a WorkoutStreamV2 row
 * is index-aligned with `time`; `array_remove()` would shorten one series and
 * silently shift every later sample against the clock, corrupting the chart
 * rather than patching it. Coercing to 0 keeps the alignment and follows the
 * same rule the write path applies (see sanitizeIntStreamArray/
 * sanitizeFloatStreamArray). For `moving`, the boolean analogue is `false`.
 *
 * The repair writes an exact `0`, whereas sanitizeFloatStreamArray writes
 * `1e-9` for whole numbers on Float[] columns -- so a repaired float sample is
 * not bit-identical to a freshly written one. Both read back as 0 for every
 * consumer; the difference is only worth knowing when comparing rows directly.
 */
const V2_INT_ARRAY_COLUMNS = [
  'time',
  'heartrate',
  'cadence',
  'watts',
  'temp',
  'torque',
  'leftRightBalance',
  'targetPower'
] as const

const V2_FLOAT_ARRAY_COLUMNS = [
  'distance',
  'velocity',
  'altitude',
  'lat',
  'lng',
  'grade',
  'hrv',
  'respiration'
] as const

const V2_BOOLEAN_ARRAY_COLUMNS = ['moving'] as const

/** Columns with no array elements to repair -- selected verbatim. */
const V2_PLAIN_COLUMNS = [
  'id',
  'workoutId',
  'avgPacePerKm',
  'paceVariability',
  'lapSplits',
  'paceZones',
  'pacingStrategy',
  'surges',
  'hrZoneTimes',
  'powerZoneTimes',
  'extrasMeta',
  'createdAt',
  'updatedAt'
] as const

const V2_INT_ARRAY_COLUMN_SET: ReadonlySet<string> = new Set(V2_INT_ARRAY_COLUMNS)
const V2_FLOAT_ARRAY_COLUMN_SET: ReadonlySet<string> = new Set(V2_FLOAT_ARRAY_COLUMNS)
const V2_BOOLEAN_ARRAY_COLUMN_SET: ReadonlySet<string> = new Set(V2_BOOLEAN_ARRAY_COLUMNS)

const ALL_V2_COLUMNS: readonly string[] = [
  ...V2_PLAIN_COLUMNS,
  ...V2_INT_ARRAY_COLUMNS,
  ...V2_FLOAT_ARRAY_COLUMNS,
  ...V2_BOOLEAN_ARRAY_COLUMNS
]

const V2_COLUMN_SET: ReadonlySet<string> = new Set(ALL_V2_COLUMNS)

/**
 * Select expression for one WorkoutStreamV2 column in the repair read.
 *
 * `column` is only ever interpolated raw after being checked against
 * V2_COLUMN_SET, so no caller-controlled string can reach the SQL text.
 */
function v2RepairColumnSql(column: string): Prisma.Sql {
  if (!V2_COLUMN_SET.has(column)) {
    throw new Error(`[workoutStreamRepository] unknown WorkoutStreamV2 column: ${column}`)
  }
  const ref = Prisma.raw(`"${column}"`)
  if (V2_INT_ARRAY_COLUMN_SET.has(column)) {
    return Prisma.sql`array_replace(${ref}, NULL::integer, 0) AS ${ref}`
  }
  if (V2_FLOAT_ARRAY_COLUMN_SET.has(column)) {
    return Prisma.sql`array_replace(${ref}, NULL::double precision, 0::double precision) AS ${ref}`
  }
  if (V2_BOOLEAN_ARRAY_COLUMN_SET.has(column)) {
    return Prisma.sql`array_replace(${ref}, NULL::boolean, false) AS ${ref}`
  }
  return Prisma.sql`${ref}`
}

/** `Expected an integer in column 'cadence[593]', got object: null` -> `cadence[593]`. */
export function extractDecodeColumn(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  return /column '([^']+)'/.exec(message)?.[1] ?? null
}

/**
 * Stream reads are best-effort by design -- a workout still renders without its
 * series -- but they must never fail *silently*: a swallowed decode error is
 * exactly how CW-453 stayed invisible for 90k rows. Every remaining `.catch()`
 * in this file routes here.
 */
function logStreamReadFailure(
  operation: string,
  table: 'WorkoutStreamV2' | 'WorkoutStream',
  workoutIds: readonly string[],
  error: unknown
): void {
  console.error('[workoutStreamRepository] stream read failed', {
    operation,
    table,
    column: extractDecodeColumn(error),
    workoutIdCount: workoutIds.length,
    // Bounded so a 200-id chunk can't blow up a log line; the column plus a
    // handful of ids is enough to locate the offending rows.
    workoutIds: workoutIds.slice(0, 10),
    error: error instanceof Error ? error.message : String(error)
  })
}

/**
 * Raw read of WorkoutStreamV2 that repairs NULL array elements in Postgres, so
 * the result can't trip the Prisma client's array decoder (CW-453).
 *
 * Only used as a fallback: the typed client path stays the hot path for the
 * ~76% of rows that are clean, and this pays the extra round trip only for
 * batches that actually contain a damaged row.
 */
async function readV2WithNullRepair(
  workoutIds: readonly string[],
  columns: readonly string[]
): Promise<any[]> {
  if (workoutIds.length === 0) return []
  const selection = Prisma.join(
    columns.map((column) => v2RepairColumnSql(column)),
    ', '
  )
  return prisma.$queryRaw<any[]>(
    Prisma.sql`
      SELECT ${selection}
      FROM "WorkoutStreamV2"
      WHERE "workoutId" IN (${Prisma.join(workoutIds as string[])})
    `
  )
}

/**
 * Read a chunk of WorkoutStreamV2 rows, degrading instead of returning nothing:
 *
 * 1. typed Prisma client (fast path, unchanged for clean rows);
 * 2. on a decode error, the raw repair read for the whole chunk;
 * 3. if that *also* hits a decode error, one typed read per id, so the batch
 *    loses only the rows that genuinely cannot be decoded rather than all.
 *
 * **Every escalation is gated on the error actually being a decode failure.**
 * Tiers 2 and 3 exist to repair NULL array elements and nothing else, so an
 * infrastructure error (pool timeout, statement timeout, connection reset)
 * degrades immediately to the pre-CW-453 behaviour of returning nothing.
 * Without that gate a single unhealthy database would fan a 200-id chunk out
 * into 200 concurrent `findUnique` calls -- and `findManyByWorkoutIds` runs its
 * chunks through `Promise.all`, so a 1000-id read would answer a database that
 * just reported itself unhealthy with ~1000 simultaneous pool acquisitions.
 */
async function readV2Chunk(
  workoutIds: readonly string[],
  select: Record<string, true> | undefined,
  operation: string
): Promise<any[]> {
  if (workoutIds.length === 0) return []
  const findManyArgs = {
    where: { workoutId: { in: workoutIds as string[] } },
    ...(select ? { select } : {})
  }

  try {
    return await (prisma as any).workoutStreamV2.findMany(findManyArgs)
  } catch (error) {
    logStreamReadFailure(operation, 'WorkoutStreamV2', workoutIds, error)
    // Not a decode failure -> there is nothing for the repair read to fix, and
    // retrying a struggling database harder is the last thing it needs.
    if (extractDecodeColumn(error) === null) return []
  }

  const columns = select ? Object.keys(select) : ALL_V2_COLUMNS
  try {
    return await readV2WithNullRepair(workoutIds, columns)
  } catch (error) {
    logStreamReadFailure(`${operation}:null-repair`, 'WorkoutStreamV2', workoutIds, error)
    // Same gate: per-row isolation only earns its N queries when the failure is
    // a decode error that a subset of the rows may not share.
    if (extractDecodeColumn(error) === null) return []
  }

  const rows = await Promise.all(
    workoutIds.map(async (workoutId) => {
      try {
        return await (prisma as any).workoutStreamV2.findUnique({
          where: { workoutId },
          ...(select ? { select } : {})
        })
      } catch (error) {
        logStreamReadFailure(`${operation}:per-row`, 'WorkoutStreamV2', [workoutId], error)
        return null
      }
    })
  )
  return rows.filter((row) => row != null)
}

/**
 * Max number of workout IDs per `IN (...)` clause. A Sentry-reported slow
 * query captured 623 workout IDs in a single IN clause; batching keeps each
 * round trip's result set (and the DB's work per query) bounded regardless
 * of how many workouts a caller asks for at once.
 */
const WORKOUT_ID_CHUNK_SIZE = 200

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (items.length <= size) return [items as T[]]
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size) as T[])
  }
  return chunks
}

/** Row returned by the presence probe: identity columns plus the usability flag. */
type StreamPresenceRow = {
  id: string
  workoutId: string
  createdAt: Date
  updatedAt: Date
  hasData: boolean | null
}

/**
 * SQL equivalent of hasUsableStreamData() for WorkoutStreamV2, evaluated in
 * Postgres so the series themselves never cross the wire. `lat` stands in for
 * `latlng` (normalizeV2 derives latlng from lat/lng). Each disjunct is written
 * so it can only be TRUE/FALSE per column -- the outer COALESCE then turns the
 * all-NULL case (row exists, every probed column NULL) into FALSE.
 */
const V2_HAS_DATA_SQL = Prisma.sql`COALESCE(
  COALESCE(array_length("time", 1), 0) > 0
  OR COALESCE(array_length("heartrate", 1), 0) > 0
  OR COALESCE(array_length("watts", 1), 0) > 0
  OR COALESCE(array_length("velocity", 1), 0) > 0
  OR COALESCE(array_length("lat", 1), 0) > 0
  OR ("hrZoneTimes" IS NOT NULL AND jsonb_typeof("hrZoneTimes") <> 'null')
  OR ("powerZoneTimes" IS NOT NULL AND jsonb_typeof("powerZoneTimes") <> 'null'),
  false
)`

/**
 * Same probe for the legacy V1 table, whose series are JSONB arrays rather
 * than Postgres arrays. `jsonb_typeof(col) = 'array'` mirrors the
 * Array.isArray() guard in hasUsableStreamData(), and comparing against
 * '[]'::jsonb mirrors its `.length > 0` check without calling
 * jsonb_array_length() on a value that might not be an array.
 */
const V1_HAS_DATA_SQL = Prisma.sql`COALESCE(
  (jsonb_typeof("time") = 'array' AND "time" <> '[]'::jsonb)
  OR (jsonb_typeof("heartrate") = 'array' AND "heartrate" <> '[]'::jsonb)
  OR (jsonb_typeof("watts") = 'array' AND "watts" <> '[]'::jsonb)
  OR (jsonb_typeof("velocity") = 'array' AND "velocity" <> '[]'::jsonb)
  OR (jsonb_typeof("latlng") = 'array' AND "latlng" <> '[]'::jsonb)
  OR ("hrZoneTimes" IS NOT NULL AND jsonb_typeof("hrZoneTimes") <> 'null')
  OR ("powerZoneTimes" IS NOT NULL AND jsonb_typeof("powerZoneTimes") <> 'null'),
  false
)`

/**
 * A NormalizedStream carrying no payload -- every series, JSON blob and scalar
 * is null. Returned by the presence-only path so `streams` stays a truthy
 * object for consumers that merely test existence, without fetching megabytes
 * of per-second arrays to produce a boolean.
 */
function toPresenceStream(row: StreamPresenceRow): NormalizedStream {
  return {
    id: row.id,
    workoutId: row.workoutId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    time: null,
    distance: null,
    velocity: null,
    heartrate: null,
    cadence: null,
    watts: null,
    altitude: null,
    latlng: null,
    grade: null,
    moving: null,
    temp: null,
    torque: null,
    leftRightBalance: null,
    hrv: null,
    respiration: null,
    targetPower: null,
    avgPacePerKm: null,
    paceVariability: null,
    lapSplits: null,
    paceZones: null,
    pacingStrategy: null,
    surges: null,
    hrZoneTimes: null,
    powerZoneTimes: null,
    extrasMeta: null
  }
}

/**
 * Presence-only bulk read (`findManyByWorkoutIds(ids, { fields: [] })`).
 *
 * The mandatory baseline exists solely so hasUsableStreamData() can decide
 * V2-vs-V1 in JS, which means six large array columns per workout even for
 * callers that never look at a series. The deduplication paths ask this
 * question for a user's entire workout history at once, which is the
 * CW-296 slow query (`IN ($1..$71)` over time/heartrate/watts/velocity/
 * lat/lng). Evaluating the same predicate in Postgres reduces each row to a
 * few dozen bytes while keeping the V2 -> V1 fallback semantics identical.
 *
 * It also sidesteps CW-453: no numeric array is decoded, so rows with NULL
 * elements can't fail Prisma's decoder and blank out a whole batch.
 */
async function findStreamPresenceByWorkoutIds(
  workoutIds: string[]
): Promise<Map<string, NormalizedStream>> {
  const result = new Map<string, NormalizedStream>()

  const v2Chunks = await Promise.all(
    chunkArray(workoutIds, WORKOUT_ID_CHUNK_SIZE).map((chunk) =>
      prisma
        .$queryRaw<StreamPresenceRow[]>(
          Prisma.sql`
            SELECT "id", "workoutId", "createdAt", "updatedAt", ${V2_HAS_DATA_SQL} AS "hasData"
            FROM "WorkoutStreamV2"
            WHERE "workoutId" IN (${Prisma.join(chunk)})
          `
        )
        .catch((error) => {
          logStreamReadFailure('findStreamPresenceByWorkoutIds', 'WorkoutStreamV2', chunk, error)
          return [] as StreamPresenceRow[]
        })
    )
  )

  const missingIds: string[] = []
  const coveredIds = new Set<string>()
  for (const row of v2Chunks.flat()) {
    coveredIds.add(row.workoutId)
    if (row.hasData) {
      result.set(row.workoutId, toPresenceStream(row))
    } else {
      missingIds.push(row.workoutId)
    }
  }
  for (const id of workoutIds) {
    if (!coveredIds.has(id)) missingIds.push(id)
  }

  if (missingIds.length === 0) return result

  const v1Chunks = await Promise.all(
    chunkArray(missingIds, WORKOUT_ID_CHUNK_SIZE).map((chunk) =>
      prisma
        .$queryRaw<StreamPresenceRow[]>(
          Prisma.sql`
            SELECT "id", "workoutId", "createdAt", "updatedAt", ${V1_HAS_DATA_SQL} AS "hasData"
            FROM "WorkoutStream"
            WHERE "workoutId" IN (${Prisma.join(chunk)})
          `
        )
        .catch((error) => {
          logStreamReadFailure('findStreamPresenceByWorkoutIds', 'WorkoutStream', chunk, error)
          return [] as StreamPresenceRow[]
        })
    )
  )

  for (const row of v1Chunks.flat()) {
    if (row.hasData) result.set(row.workoutId, toPresenceStream(row))
  }

  return result
}

export const workoutStreamRepository = {
  async findByWorkoutId(workoutId: string): Promise<NormalizedStream | null> {
    // readV2Chunk() falls back to the NULL-repairing raw read, so a row with
    // NULL array elements yields usable series instead of dropping through to
    // the (production-empty) V1 table and returning null. CW-453.
    const [v2] = await readV2Chunk([workoutId], undefined, 'findByWorkoutId')
    if (v2) {
      const normalized = normalizeV2(v2)
      if (hasUsableStreamData(normalized)) return normalized
    }

    const v1 = await prisma.workoutStream.findUnique({ where: { workoutId } }).catch((error) => {
      logStreamReadFailure('findByWorkoutId', 'WorkoutStream', [workoutId], error)
      return null
    })
    if (!v1) return null
    const normalized = toNormalizedFromV1(v1)
    return hasUsableStreamData(normalized) ? normalized : null
  },

  async existsByWorkoutId(workoutId: string): Promise<boolean> {
    const stream = await this.findByWorkoutId(workoutId)
    return stream !== null
  },

  async findManyByWorkoutIds(
    workoutIds: string[],
    options?: FindManyByWorkoutIdsOptions
  ): Promise<Map<string, NormalizedStream>> {
    const result = new Map<string, NormalizedStream>()
    if (workoutIds.length === 0) return result

    // `baselineOnly` wins over `fields`: it means "the mandatory baseline and
    // nothing else", which is an empty optional-field list that must *not* be
    // read as the presence-only sentinel below.
    const baselineOnly = options?.baselineOnly === true
    const fields = baselineOnly ? [] : options?.fields

    // `fields: []` == "does this workout have usable streams at all?". Answer
    // it in SQL instead of hauling six per-second arrays per workout across
    // the wire (CW-296).
    if (!baselineOnly && fields !== undefined && fields.length === 0) {
      return findStreamPresenceByWorkoutIds(workoutIds)
    }

    const v2Select = buildV2Select(fields)

    const v2Chunks = await Promise.all(
      chunkArray(workoutIds, WORKOUT_ID_CHUNK_SIZE).map((chunk) =>
        readV2Chunk(chunk, v2Select, 'findManyByWorkoutIds')
      )
    )
    const v2Records: any[] = v2Chunks.flat()

    const missingIds: string[] = []
    for (const r of v2Records) {
      const normalized = normalizeV2(r)
      if (hasUsableStreamData(normalized)) {
        result.set(r.workoutId, normalized)
      } else {
        missingIds.push(r.workoutId)
      }
    }

    const coveredIds = new Set(v2Records.map((r: any) => r.workoutId))
    for (const id of workoutIds) {
      if (!coveredIds.has(id)) missingIds.push(id)
    }

    if (missingIds.length > 0) {
      const v1Select = buildV1Select(fields) as any
      const v1Chunks = await Promise.all(
        chunkArray(missingIds, WORKOUT_ID_CHUNK_SIZE).map((chunk) =>
          prisma.workoutStream
            .findMany({
              where: { workoutId: { in: chunk } },
              ...(v1Select ? { select: v1Select } : {})
            })
            .catch((error) => {
              logStreamReadFailure('findManyByWorkoutIds', 'WorkoutStream', chunk, error)
              return []
            })
        )
      )
      const v1Records = v1Chunks.flat()
      for (const r of v1Records) {
        const normalized = toNormalizedFromV1(r)
        if (hasUsableStreamData(normalized)) {
          result.set(r.workoutId, normalized)
        }
      }
    }

    return result
  },

  /**
   * Watts-only bulk read for aggregate power analytics.
   *
   * findManyByWorkoutIds() always fetches the REQUIRED_V2_SELECT baseline so
   * hasUsableStreamData() can decide V2-vs-V1, which means ~6 parallel series
   * per workout. Curve endpoints scan up to two years of workouts at once and
   * only ever look at `watts`, so the baseline is the dominant cost there.
   * This reads a single column and decides the V1 fallback from the presence
   * of a non-empty watts series, which is the only signal that matters here.
   *
   * Workouts with no power data are simply absent from the returned map.
   */
  async findWattsByWorkoutIds(workoutIds: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>()
    if (workoutIds.length === 0) return result

    const chunks = chunkArray(workoutIds, WORKOUT_ID_CHUNK_SIZE)

    const v2Chunks = await Promise.all(
      chunks.map((chunk) =>
        readV2Chunk(chunk, { workoutId: true, watts: true }, 'findWattsByWorkoutIds')
      )
    )

    for (const record of v2Chunks.flat() as Array<{ workoutId: string; watts: unknown }>) {
      if (Array.isArray(record.watts) && record.watts.length > 0) {
        result.set(record.workoutId, record.watts as number[])
      }
    }

    const missingIds = workoutIds.filter((id) => !result.has(id))
    if (missingIds.length === 0) return result

    const v1Chunks = await Promise.all(
      chunkArray(missingIds, WORKOUT_ID_CHUNK_SIZE).map((chunk) =>
        prisma.workoutStream
          .findMany({
            where: { workoutId: { in: chunk } },
            select: { workoutId: true, watts: true }
          })
          .catch((error) => {
            logStreamReadFailure('findWattsByWorkoutIds', 'WorkoutStream', chunk, error)
            return []
          })
      )
    )

    for (const record of v1Chunks.flat() as Array<{ workoutId: string; watts: unknown }>) {
      if (Array.isArray(record.watts) && record.watts.length > 0) {
        result.set(record.workoutId, record.watts as number[])
      }
    }

    return result
  },

  /**
   * `extrasMeta`-only bulk read, for the same reason findWattsByWorkoutIds()
   * exists.
   *
   * findManyByWorkoutIds() always fetches the REQUIRED_V2_SELECT baseline so
   * hasUsableStreamData() can decide V2-vs-V1, which means ~6 parallel series
   * per workout even when the caller wants a single JSON blob. The FIT
   * session-summary metric history asks for `extrasMeta` across up to 90
   * workouts at once and reads no series at all, so the baseline would be the
   * entire cost -- roughly two million decoded numbers per modal open for a
   * rider with 1 Hz hour-long files.
   *
   * This reads one JSON column and decides the V1 fallback from the presence
   * of a non-null `extrasMeta`, which is the only signal that matters here.
   * Workouts with no extras metadata are simply absent from the returned map.
   */
  async findExtrasMetaByWorkoutIds(workoutIds: string[]): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>()
    if (workoutIds.length === 0) return result

    const chunks = chunkArray(workoutIds, WORKOUT_ID_CHUNK_SIZE)

    const v2Chunks = await Promise.all(
      chunks.map((chunk) =>
        readV2Chunk(chunk, { workoutId: true, extrasMeta: true }, 'findExtrasMetaByWorkoutIds')
      )
    )

    for (const record of v2Chunks.flat() as Array<{ workoutId: string; extrasMeta: unknown }>) {
      if (record.extrasMeta != null) {
        result.set(record.workoutId, record.extrasMeta)
      }
    }

    const missingIds = workoutIds.filter((id) => !result.has(id))
    if (missingIds.length === 0) return result

    const v1Chunks = await Promise.all(
      chunkArray(missingIds, WORKOUT_ID_CHUNK_SIZE).map((chunk) =>
        prisma.workoutStream
          .findMany({
            where: { workoutId: { in: chunk } },
            select: { workoutId: true, extrasMeta: true }
          })
          .catch((error) => {
            logStreamReadFailure('findExtrasMetaByWorkoutIds', 'WorkoutStream', chunk, error)
            return []
          })
      )
    )

    for (const record of v1Chunks.flat() as Array<{ workoutId: string; extrasMeta: unknown }>) {
      if (record.extrasMeta != null) {
        result.set(record.workoutId, record.extrasMeta)
      }
    }

    return result
  },

  async updateMetadata(
    workoutId: string,
    data: { hrZoneTimes?: unknown; powerZoneTimes?: unknown }
  ): Promise<void> {
    // `select: { id: true }` decodes no arrays, so this can only fail for
    // infrastructure reasons -- but failing quietly here silently redirects the
    // metadata write to the legacy V1 row, so it must be logged.
    const v2 = await (prisma as any).workoutStreamV2
      .findUnique({ where: { workoutId }, select: { id: true } })
      .catch((error: unknown) => {
        logStreamReadFailure('updateMetadata', 'WorkoutStreamV2', [workoutId], error)
        return null
      })

    if (v2) {
      await (prisma as any).workoutStreamV2.update({
        where: { workoutId },
        data: { ...data, updatedAt: new Date() }
      })
      return
    }

    const v1 = await prisma.workoutStream.findUnique({
      where: { workoutId },
      select: { id: true }
    })
    if (v1) {
      const updateData: {
        updatedAt: Date
        hrZoneTimes?: ReturnType<typeof toPrismaInputJsonValue>
        powerZoneTimes?: ReturnType<typeof toPrismaInputJsonValue>
      } = { updatedAt: new Date() }
      if (data.hrZoneTimes !== undefined) {
        updateData.hrZoneTimes = toPrismaInputJsonValue(data.hrZoneTimes)
      }
      if (data.powerZoneTimes !== undefined) {
        updateData.powerZoneTimes = toPrismaInputJsonValue(data.powerZoneTimes)
      }
      await prisma.workoutStream.update({
        where: { workoutId },
        data: updateData
      })
    }
  },

  async upsert(
    workoutId: string,
    data: {
      time?: number[]
      distance?: number[]
      velocity?: number[]
      heartrate?: number[] | null
      cadence?: number[] | null
      watts?: number[] | null
      altitude?: number[] | null
      latlng?: [number, number][] | null
      grade?: number[] | null
      moving?: boolean[] | null
      temp?: number[] | null
      torque?: number[] | null
      leftRightBalance?: number[] | null
      hrv?: number[] | null
      respiration?: number[] | null
      targetPower?: number[] | null
      avgPacePerKm?: number | null
      paceVariability?: number | null
      lapSplits?: unknown
      paceZones?: unknown
      pacingStrategy?: unknown
      surges?: unknown
      hrZoneTimes?: unknown
      powerZoneTimes?: unknown
      extrasMeta?: unknown
    }
  ) {
    const {
      latlng,
      time,
      distance,
      velocity,
      heartrate,
      cadence,
      watts,
      altitude,
      grade,
      moving,
      temp,
      torque,
      leftRightBalance,
      hrv,
      respiration,
      targetPower,
      ...meta
    } = data
    const { lat, lng } = splitLatlngPoints(latlng)

    const rawSeries: Record<string, unknown> = {
      lat,
      lng,
      time,
      distance,
      velocity,
      heartrate,
      cadence,
      watts,
      altitude,
      grade,
      moving,
      temp,
      torque,
      leftRightBalance,
      hrv,
      respiration,
      targetPower
    }

    const writeData: any = { ...meta }
    for (const [column, sanitize] of Object.entries(V2_ARRAY_WRITE_SANITIZERS)) {
      writeData[column] = sanitize(rawSeries[column])
    }
    // CW-453: nothing may reach Postgres with a NULL element in a numeric or
    // boolean array -- that is what made 24% of stream rows unreadable.
    enforceNoNullStreamElements(writeData, workoutId)

    return (prisma as any).workoutStreamV2.upsert({
      where: { workoutId },
      create: {
        workout: { connect: { id: workoutId } },
        ...writeData
      },
      update: { ...writeData, updatedAt: new Date() }
    })
  }
}
