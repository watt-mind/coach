import { z } from 'zod/v3'
import { requireAuth } from '../../../utils/auth-guard'
import { assertWorkoutComparisonAccess } from '../../../utils/analyticsScope'
import { prisma } from '../../../utils/db'
import { attachStreamsToWorkouts } from '../../../utils/repositories/workoutStreamRepository'

const schema = z.object({
  comparison: z.object({
    type: z.literal('workouts'),
    mode: z.literal('interval'),
    workoutIds: z.array(z.string().min(1)).min(2),
    alignment: z.literal('lap_index').default('lap_index'),
    field: z.enum(['avgPower', 'avgHr', 'duration', 'distance']).default('avgPower')
  })
})

function toLapArray(lapSplits: unknown) {
  return Array.isArray(lapSplits) ? lapSplits : []
}

function getLapMetric(split: any, field: 'avgPower' | 'avgHr' | 'duration' | 'distance') {
  const candidates =
    field === 'avgPower'
      ? [split.avgPower, split.avg_power, split.averageWatts, split.average_watts]
      : field === 'avgHr'
        ? [split.avgHr, split.avg_hr, split.averageHr, split.average_heartrate]
        : field === 'duration'
          ? [split.duration, split.elapsedTime, split.elapsed_time, split.movingTime]
          : [split.distance, split.distanceMeters, split.distance_meters]

  for (const candidate of candidates) {
    const value = Number(candidate)
    if (!Number.isNaN(value)) return value
  }

  return null
}

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event)
  const body = await readBody(event)
  const result = schema.safeParse(body)

  if (!result.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid interval comparison configuration',
      data: result.error.issues
    })
  }

  const comparison = result.data.comparison
  const workoutIds = await assertWorkoutComparisonAccess(user.id, comparison.workoutIds)

  // CW-379: `streams` only covers the legacy V1 table, so lap comparison came
  // back "no comparable lap data" for V2-only workouts. `lapSplits` is an
  // optional column, so it has to be requested explicitly on top of the
  // repository's baseline.
  const workoutRecords = await prisma.workout.findMany({
    where: { id: { in: workoutIds } },
    select: {
      id: true,
      title: true,
      date: true,
      user: { select: { name: true, email: true } }
    }
  })

  const workouts = await attachStreamsToWorkouts(workoutRecords, { fields: ['lapSplits'] })

  const byId = new Map(workouts.map((workout) => [workout.id, workout]))
  const ordered = workoutIds.map((id) => byId.get(id)).filter(Boolean)

  const series = ordered
    .map((workout: any) => {
      const splits = toLapArray(workout.streams?.lapSplits)
      if (splits.length === 0) return null

      return {
        label: `${new Date(workout.date).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} · ${workout.title} · ${workout.user?.name || workout.user?.email || 'Athlete'}`,
        values: splits.map((split: any) => getLapMetric(split, comparison.field))
      }
    })
    .filter(Boolean)

  if (series.length === 0) {
    return {
      labels: [],
      datasets: [],
      unsupportedReason: 'No comparable lap or split data was available for the selected workouts.'
    }
  }

  const maxIntervals = series.reduce((max, current: any) => Math.max(max, current.values.length), 0)
  const labels = Array.from({ length: maxIntervals }, (_, index) => `Lap ${index + 1}`)

  return {
    labels,
    datasets: series.map((entry: any) => ({
      label: entry.label,
      data: labels.map((_, index) => entry.values[index] ?? null),
      type: 'line'
    }))
  }
})
