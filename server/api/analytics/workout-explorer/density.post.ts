import { z } from 'zod/v3'
import { requireAuth } from '../../../utils/auth-guard'
import { getAccessibleWorkout } from '../../../utils/analyticsScope'
import { attachStreamToWorkout } from '../../../utils/repositories/workoutStreamRepository'

const schema = z.object({
  analysis: z.object({
    type: z.literal('single_workout'),
    mode: z.literal('density'),
    workoutId: z.string().min(1),
    xField: z.enum(['cadence', 'heartrate', 'velocity', 'grade']).default('cadence'),
    yField: z.enum(['watts', 'torque']).default('watts'),
    xBins: z.number().int().min(5).max(100).default(40),
    yBins: z.number().int().min(5).max(100).default(40),
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

function toNumberArray(stream: unknown): number[] {
  if (!Array.isArray(stream)) return []
  return stream.map((value) => {
    const numeric = Number(value)
    return Number.isNaN(numeric) ? 0 : numeric
  })
}

/**
 * Format a bin edge label with appropriate precision for the field type.
 * Grade and velocity have fractional values; cadence/HR are integers.
 */
function formatBinLabel(value: number, field: string): string {
  if (field === 'grade' || field === 'velocity') {
    return value.toFixed(1)
  }
  return Math.round(value).toString()
}

/**
 * Whether a field allows zero and negative values (grade can be 0 or negative on downhills).
 */
function allowsNonPositive(field: string): boolean {
  return field === 'grade'
}

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event)
  const body = await readBody(event)
  const result = schema.safeParse(body)

  if (!result.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid density analysis configuration',
      data: result.error.issues
    })
  }

  const { analysis } = result.data
  // CW-379: `streams` is the legacy V1 relation only -- the density heatmap
  // 404'd for every athlete whose series are in WorkoutStreamV2.
  const workoutRecord = await getAccessibleWorkout(user.id, analysis.workoutId, {
    select: { id: true }
  })

  const workout = workoutRecord ? await attachStreamToWorkout(workoutRecord) : null

  if (!workout || !workout.streams) {
    throw createError({ statusCode: 404, statusMessage: 'Workout streams not found' })
  }

  const xRaw = toNumberArray(
    workout.streams[
      analysis.xField === 'cadence'
        ? 'cadence'
        : analysis.xField === 'heartrate'
          ? 'heartrate'
          : analysis.xField === 'grade'
            ? 'grade'
            : 'velocity'
    ]
  )
  const yRaw = toNumberArray(workout.streams.watts)
  const time = toNumberArray(workout.streams.time)
  const distance = toNumberArray(workout.streams.distance)

  if (xRaw.length === 0 || yRaw.length === 0) {
    return { matrix: [], xLabels: [], yLabels: [], chartType: 'heatmap' }
  }

  // Calculate Torque if needed
  let yValues = yRaw
  if (analysis.yField === 'torque') {
    const cadence = toNumberArray(workout.streams.cadence)
    yValues = yRaw.map((w, i) => {
      const c = cadence[i] || 0
      return c > 10 ? Number(((w * 60) / (2 * Math.PI * c)).toFixed(1)) : 0
    })
  }

  if (analysis.range) {
    const alignment =
      analysis.range.alignment === 'distance'
        ? distance
        : analysis.range.alignment === 'percent_complete'
          ? xRaw.map((_, i) => (i / (xRaw.length - 1)) * 100)
          : time

    if (alignment.length === xRaw.length) {
      const filteredIndices = alignment
        .map((value, index) => ({ value, index }))
        .filter(
          (entry) => entry.value >= analysis.range!.start && entry.value <= analysis.range!.end
        )
        .map((entry) => entry.index)

      const nextX: number[] = []
      const nextY: number[] = []
      filteredIndices.forEach((index) => {
        nextX.push(xRaw[index] ?? 0)
        nextY.push(yValues[index] ?? 0)
      })

      if (nextX.length > 0) {
        xRaw.splice(0, xRaw.length, ...nextX)
        yValues = nextY
      }
    }
  }

  const xAllowsNonPositive = allowsNonPositive(analysis.xField)

  // Find bounds — for grade, include zero and negative values
  const validXValues = xAllowsNonPositive
    ? xRaw.filter((v) => Number.isFinite(v))
    : xRaw.filter((v) => v > 0)
  const validYValues = yValues.filter((v) => v > 0)

  if (validXValues.length === 0 || validYValues.length === 0) {
    return { matrix: [], xLabels: [], yLabels: [], chartType: 'heatmap' }
  }

  const xMin = Math.min(...validXValues)
  const xMax = Math.max(...validXValues)
  const yMin = Math.min(...validYValues)
  const yMax = Math.max(...validYValues)

  const xStep = (xMax - xMin) / analysis.xBins || 1
  const yStep = (yMax - yMin) / analysis.yBins || 1

  // Build label arrays from bin indices — use decimal precision for fields that need it
  const xLabels: string[] = []
  const yLabels: string[] = []

  for (let i = 0; i < analysis.xBins; i++) {
    xLabels.push(formatBinLabel(xMin + i * xStep, analysis.xField))
  }
  for (let j = 0; j < analysis.yBins; j++) {
    yLabels.push(formatBinLabel(yMin + j * yStep, analysis.yField))
  }

  // Populate matrix — key by bin INDEX (not label string) to avoid label-collision bugs
  const matrixMap = new Map<string, number>()

  for (let i = 0; i < xRaw.length; i++) {
    const x = xRaw[i]!
    const y = yValues[i]!

    // Always require positive power (y); for grade allow zero/negative x
    if (y <= 0) continue
    if (!xAllowsNonPositive && x <= 0) continue

    const xBin = Math.min(analysis.xBins - 1, Math.max(0, Math.floor((x - xMin) / xStep)))
    const yBin = Math.min(analysis.yBins - 1, Math.max(0, Math.floor((y - yMin) / yStep)))

    // Key by index, not label — prevents collision when multiple bins share a rounded label
    const key = `${xBin}::${yBin}`
    matrixMap.set(key, (matrixMap.get(key) || 0) + 1)
  }

  // Convert index-keyed map to label-keyed matrix for the frontend
  const matrix = Array.from(matrixMap.entries()).map(([key, value]) => {
    const [xIdx, yIdx] = key.split('::').map(Number)
    return {
      x: xLabels[xIdx!] ?? String(xIdx),
      y: yLabels[yIdx!] ?? String(yIdx),
      value
    }
  })

  return {
    chartType: 'heatmap',
    xLabels,
    yLabels,
    matrix,
    meta: {
      xField: analysis.xField,
      yField: analysis.yField,
      xMin,
      xMax,
      yMin,
      yMax
    }
  }
})
