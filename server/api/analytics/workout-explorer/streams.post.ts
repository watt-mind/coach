import { z } from 'zod/v3'
import { requireAuth } from '../../../utils/auth-guard'
import { getAccessibleWorkout } from '../../../utils/analyticsScope'
import { attachStreamToWorkout } from '../../../utils/repositories/workoutStreamRepository'
import { lttb } from '../../../utils/analytics/lttb'
import { calculateVirtualStream, type VirtualField } from '../../../utils/analytics/virtual-streams'
import { sportSettingsRepository } from '../../../utils/repositories/sportSettingsRepository'
import { formatAlignmentLabel } from '../../../utils/analytics/format-alignment-label'
import { metresPerSecondToKmh } from '../../../../shared/units'

const schema = z.object({
  analysis: z.object({
    type: z.literal('single_workout'),
    mode: z.literal('stream'),
    workoutId: z.string().min(1),
    alignment: z.enum(['elapsed_time', 'distance', 'percent_complete']).default('elapsed_time'),
    field: z.string().default('watts'), // Can be raw field or virtual field
    fields: z.array(z.string()).max(4).optional(),
    limit: z.number().int().min(10).max(2000).default(1000),
    range: z
      .object({
        start: z.number(),
        end: z.number(),
        alignment: z.enum(['elapsed_time', 'distance', 'percent_complete']).default('elapsed_time')
      })
      .nullable()
      .optional()
  })
})

/** Semantic color for each stream field */
const STREAM_FIELD_COLORS: Record<string, string> = {
  watts: '#3b82f6',
  heartrate: '#ef4444',
  cadence: '#10b981',
  velocity: '#8b5cf6',
  altitude: '#64748b',
  grade: '#f59e0b',
  torque: '#06b6d4',
  vam: '#f97316',
  w_balance: '#a855f7',
  power_hr_ratio: '#ec4899'
}

/** Fields that look better with an area fill under the curve */
const FILL_FIELDS = new Set(['altitude', 'w_balance'])

function toNumberArray(stream: unknown): number[] {
  if (!Array.isArray(stream)) return []
  return stream.map((value) => {
    const numeric = Number(value)
    return Number.isNaN(numeric) ? 0 : numeric
  })
}

function formatFieldLabel(field: string) {
  return field
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Compute a simple rolling average over a numeric array.
 * windowSec is in seconds; sampleInterval is the average time per sample.
 */
function rollingAverage(values: number[], windowSize: number): number[] {
  const result: number[] = new Array(values.length).fill(null)
  let sum = 0

  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0
    if (i >= windowSize) sum -= values[i - windowSize] ?? 0
    const count = Math.min(i + 1, windowSize)
    result[i] = Math.round(sum / count)
  }

  return result
}

/**
 * Build lap-band box annotations from lapSplits for interval shading.
 * Returns alternating shaded bands for each lap.
 */
function buildLapAnnotations(
  lapSplits: any[],
  alignment: 'elapsed_time' | 'distance' | 'percent_complete',
  totalTime: number,
  totalDistance: number
): Record<string, any> {
  if (!lapSplits.length) return {}

  // Compute cumulative start/end in the alignment axis
  const annotations: Record<string, any> = {}
  let cursor = 0

  for (let i = 0; i < lapSplits.length; i++) {
    const split = lapSplits[i]
    const duration =
      Number(split.time ?? split.duration ?? split.elapsedTime ?? split.elapsed_time ?? 0) || 0
    const distance = Number(split.distance ?? split.distanceMeters ?? 0) || 0

    const lapStart = cursor
    const lapEnd =
      cursor +
      (alignment === 'distance'
        ? distance
        : alignment === 'elapsed_time'
          ? duration
          : totalTime > 0
            ? (duration / totalTime) * 100
            : 0)

    cursor = lapEnd

    // Only shade every other lap for a zebra effect
    if (i % 2 === 0) continue

    annotations[`lap-band-${i}`] = {
      type: 'box',
      xMin: lapStart,
      xMax: lapEnd,
      backgroundColor: 'rgba(148, 163, 184, 0.06)',
      borderColor: 'rgba(148, 163, 184, 0)',
      borderWidth: 0
    }
  }

  return annotations
}

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event)
  const body = await readBody(event)
  const result = schema.safeParse(body)

  if (!result.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid workout explorer stream configuration',
      data: result.error.issues
    })
  }

  const { analysis } = result.data
  // 1. Fetch Workout and Streams
  // CW-379: `streams` selects the legacy V1 table only, so the whole workout
  // explorer 404'd with "Workout streams not found" for athletes whose series
  // live in WorkoutStreamV2. attachStreamToWorkout prefers V2 and falls back
  // to V1.
  const workoutRecord = await getAccessibleWorkout(user.id, analysis.workoutId, {
    select: {
      id: true,
      title: true,
      date: true,
      type: true,
      user: { select: { name: true, email: true } }
    }
  })

  const workout = workoutRecord ? await attachStreamToWorkout(workoutRecord) : null

  if (!workout || !workout.streams) {
    throw createError({ statusCode: 404, statusMessage: 'Workout streams not found' })
  }

  const rawStreams = {
    time: toNumberArray(workout.streams.time),
    distance: toNumberArray(workout.streams.distance),
    watts: toNumberArray(workout.streams.watts),
    heartrate: toNumberArray(workout.streams.heartrate),
    cadence: toNumberArray(workout.streams.cadence),
    velocity: toNumberArray(workout.streams.velocity),
    altitude: toNumberArray(workout.streams.altitude),
    grade: toNumberArray(workout.streams.grade)
  }

  const rawFields = ['watts', 'heartrate', 'cadence', 'velocity', 'altitude', 'grade']
  const requestedFields =
    Array.isArray(analysis.fields) && analysis.fields.length > 0
      ? analysis.fields
      : [analysis.field]

  // Always load sport settings when power or HR fields are requested (needed for FTP/LTHR annotations)
  const needsSportSettings =
    requestedFields.some((field) => !rawFields.includes(field)) ||
    requestedFields.includes('watts') ||
    requestedFields.includes('heartrate') ||
    requestedFields.includes('w_balance')
  const sportSettings = needsSportSettings
    ? await sportSettingsRepository.getForActivityType(user.id, workout.type || 'Cycling')
    : null
  const ftp = sportSettings?.ftp || null
  const lthr = sportSettings?.lthr || null
  const wPrime = sportSettings?.wPrime || 20000

  function resolveFieldValues(field: string) {
    if (rawFields.includes(field)) {
      let values = rawStreams[field as keyof typeof rawStreams] || []
      if (field === 'velocity') {
        // The velocity stream is persisted in m/s; the explorer charts km/h.
        values = values.map((v) => Number(metresPerSecondToKmh(v).toFixed(1)))
      }
      return values
    }

    return calculateVirtualStream(field as VirtualField, rawStreams, {
      ftp: ftp || 200,
      w_prime: wPrime
    })
  }

  const fieldSeries = requestedFields.map((field) => ({
    field,
    values: resolveFieldValues(field)
  }))
  const primarySeries = fieldSeries[0]
  const values = primarySeries?.values || []

  if (values.length === 0) {
    return {
      labels: [],
      datasets: [],
      unsupportedReason: `No ${analysis.field} data was available for this workout.`
    }
  }

  // 3. Resolve Alignment Axis
  let axis: number[] = []
  if (analysis.alignment === 'elapsed_time') {
    axis = rawStreams.time
  } else if (analysis.alignment === 'distance') {
    axis = rawStreams.distance
  } else {
    axis = values.map((_, i) => (i / (values.length - 1)) * 100)
  }

  interface Point {
    x: number
    y: number
    lat?: number
    lng?: number
  }

  const latlng = workout.streams.latlng as any[]
  const fullPrimaryPoints: Point[] = axis.map((x, i) => {
    const point: Point = { x, y: values[i] || 0 }
    const coord = Array.isArray(latlng) ? latlng[i] : null
    if (Array.isArray(coord) && coord.length >= 2) {
      point.lat = coord[0]
      point.lng = coord[1]
    }
    return point
  })
  const filteredPrimaryPoints = analysis.range
    ? fullPrimaryPoints.filter((p) => p.x >= analysis.range!.start && p.x <= analysis.range!.end)
    : fullPrimaryPoints
  const sampledPrimaryPoints = lttb(
    filteredPrimaryPoints,
    analysis.limit,
    (p) => p.x,
    (p) => p.y
  )
  const sampledXValues = sampledPrimaryPoints.map((point) => point.x)

  const athleteLabel = workout.user?.name || workout.user?.email || 'Athlete'
  const isSingleField = fieldSeries.length === 1
  const primaryField = primarySeries?.field || analysis.field

  // 4. Build datasets
  const datasets: any[] = fieldSeries
    .filter((series) => series.values.length > 0)
    .map((series) => {
      const points = sampledXValues.map((x) => {
        const originalIndex = axis.findIndex((axisValue) => axisValue === x)
        const point: Point = {
          x,
          y: series.values[originalIndex] || 0
        }

        const coord = Array.isArray(latlng) ? latlng[originalIndex] : null
        if (Array.isArray(coord) && coord.length >= 2) {
          point.lat = coord[0]
          point.lng = coord[1]
        }

        return point
      })

      const color = STREAM_FIELD_COLORS[series.field] || '#3b82f6'
      const shouldFill = isSingleField && FILL_FIELDS.has(series.field)

      return {
        label: `${formatFieldLabel(series.field)} · ${new Date(workout.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} · ${workout.title} · ${athleteLabel}`,
        data: points,
        type: 'line',
        showLine: true,
        pointRadius: 0,
        color,
        borderColor: color,
        fill: shouldFill ? 'origin' : false
      }
    })

  // 5. Rolling 30s average for single-field power or HR
  if (isSingleField && (primaryField === 'watts' || primaryField === 'heartrate')) {
    const rawFieldValues = primarySeries!.values
    const timeStream = rawStreams.time
    const avgSampleInterval =
      timeStream.length > 1
        ? (timeStream[timeStream.length - 1]! - timeStream[0]!) / (timeStream.length - 1)
        : 1
    const windowSize = Math.max(5, Math.round(30 / avgSampleInterval))
    const smoothed = rollingAverage(rawFieldValues, windowSize)

    // Sample the smoothed series at the same x positions
    const smoothedPoints = sampledXValues.map((x) => {
      const originalIndex = axis.findIndex((axisValue) => axisValue === x)
      return {
        x,
        y: smoothed[originalIndex] ?? 0
      }
    })

    const color = STREAM_FIELD_COLORS[primaryField] || '#3b82f6'
    datasets.push({
      label: `30s Avg · ${formatFieldLabel(primaryField)}`,
      data: smoothedPoints,
      type: 'line',
      showLine: true,
      pointRadius: 0,
      borderWidth: 2.5,
      color,
      borderColor: color,
      tension: 0.4,
      fill: false,
      opacity: 0.9
    })
  }

  // 6. Build reference line annotations (FTP, LTHR, W' zero)
  const annotations: any[] = []

  if (isSingleField) {
    if (primaryField === 'watts' && ftp) {
      annotations.push({
        type: 'line',
        scaleID: 'y',
        value: ftp,
        label: `FTP ${ftp}W`,
        borderColor: '#f59e0b',
        borderDash: [6, 4]
      })
    }

    if (primaryField === 'heartrate' && lthr) {
      annotations.push({
        type: 'line',
        scaleID: 'y',
        value: lthr,
        label: `LTHR ${lthr} bpm`,
        borderColor: '#ef4444',
        borderDash: [6, 4]
      })
    }

    if (primaryField === 'w_balance') {
      annotations.push({
        type: 'line',
        scaleID: 'y',
        value: 0,
        label: 'Depleted',
        borderColor: '#ef4444',
        borderDash: [4, 4]
      })
      if (wPrime) {
        annotations.push({
          type: 'line',
          scaleID: 'y',
          value: wPrime * 0.2,
          label: 'Danger zone',
          borderColor: '#f59e0b',
          borderDash: [4, 4]
        })
      }
    }
  }

  // 7. Lap band shading from lapSplits
  const lapSplits = Array.isArray(workout.streams.lapSplits) ? workout.streams.lapSplits : []
  const totalTime = rawStreams.time[rawStreams.time.length - 1] ?? 0
  const totalDistance = rawStreams.distance[rawStreams.distance.length - 1] ?? 0
  const lapAnnotations = buildLapAnnotations(
    lapSplits,
    analysis.alignment,
    totalTime,
    totalDistance
  )

  return {
    labels: sampledPrimaryPoints.map((p) =>
      formatAlignmentLabel(p.x, analysis.alignment, user.distanceUnits)
    ),
    datasets,
    annotations,
    lapAnnotations,
    // Metadata for frontend map/interaction
    meta: {
      field: analysis.field,
      fields: requestedFields,
      alignment: analysis.alignment,
      workoutId: analysis.workoutId,
      hasGPS: Array.isArray(latlng) && latlng.length > 0
    }
  }
})
