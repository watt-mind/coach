import { getServerSession } from '../../../utils/session'
import { workoutStreamRepository } from '../../../utils/repositories/workoutStreamRepository'

function normalizeMetricKey(metricKey: string) {
  return metricKey.trim().toLowerCase()
}

function getSessionSummaryValue(workout: any, key: string): number | null {
  const sessionSummary = workout?.streams?.extrasMeta?.sessionSummary
  if (!sessionSummary || typeof sessionSummary !== 'object') return null

  if (key === 'elapsed time') return Number(sessionSummary.totalElapsedTime) || null
  if (key === 'timer time') return Number(sessionSummary.totalTimerTime) || null
  if (key === 'total distance') return Number(sessionSummary.totalDistance) || null
  if (key === 'total ascent') return Number(sessionSummary.totalAscent) || null
  if (key === 'total descent') return Number(sessionSummary.totalDescent) || null
  if (key === 'total calories') return Number(sessionSummary.totalCalories) || null
  if (key === 'training stress score') return Number(sessionSummary.trainingStressScore) || null
  return null
}

function extractMetricValue(workout: any, metricKey: string): number | null {
  const key = normalizeMetricKey(metricKey)

  if (key === 'average power' || key === 'avg power') return workout.averageWatts ?? null
  if (key === 'average speed' || key === 'avg speed') return workout.averageSpeed ?? null
  if (key === 'max power') return workout.maxWatts ?? null
  if (key === 'normalized power' || key === 'norm power') return workout.normalizedPower ?? null
  if (key === 'weighted avg power') return workout.weightedAvgWatts ?? null
  if (key === 'average cadence') return workout.averageCadence ?? null
  if (key === 'max cadence') return workout.maxCadence ?? null
  if (key === 'average hr' || key === 'avg hr') return workout.averageHr ?? null
  if (key === 'max hr') return workout.maxHr ?? null
  if (key === 'variability index') return workout.variabilityIndex ?? null
  if (key === 'power/hr ratio' || key === 'power hr ratio') return workout.powerHrRatio ?? null
  if (key === 'efficiency factor') return workout.efficiencyFactor ?? null
  if (key === 'decoupling') return workout.decoupling ?? null
  if (key === 'polarization index') return workout.polarizationIndex ?? null
  if (key === 'l/r balance') return workout.lrBalance ?? null
  if (key === 'strain score') return workout.strainScore ?? null
  if (key === 'hr load') return workout.hrLoad ?? null
  if (key === 'work > ftp') return workout.workAboveFtp ?? null
  if (key === "w' bal depletion") return workout.wBalDepletion ?? null
  if (key === "w'") return workout.wPrime ?? null
  if (key === 'carbs used') return workout.carbsUsed ?? null
  if (key === 'ctl (fitness)' || key === 'fitness (ctl)') return workout.ctl ?? null
  if (key === 'atl (fatigue)' || key === 'fatigue (atl)') return workout.atl ?? null
  if (key === 'ftp at time') return workout.ftp ?? null
  if (key === 'rpe') return workout.rpe ?? null
  if (key === 'session rpe') return workout.sessionRpe ?? null
  if (key === 'feel') return workout.feel ?? null
  if (key === 'trimp') return workout.trimp ?? null
  if (key === 'avg temperature') return workout.avgTemp ?? null
  if (key === 'training load' || key === 'tss (load)') return workout.trainingLoad ?? workout.tss

  const sessionSummaryValue = getSessionSummaryValue(workout, key)
  if (sessionSummaryValue !== null) return sessionSummaryValue

  return null
}

defineRouteMeta({
  openAPI: {
    tags: ['Workouts'],
    summary: 'Get metric history',
    description:
      'Returns previous workouts of the same activity type with extracted values for a specific metric.',
    inputSchema: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' }
      },
      {
        name: 'metricKey',
        in: 'query',
        required: true,
        schema: { type: 'string' }
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer' }
      }
    ],
    responses: {
      200: { description: 'Success' },
      401: { description: 'Unauthorized' },
      404: { description: 'Workout not found' }
    }
  }
})

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  const workoutId = getRouterParam(event, 'id')
  const query = getQuery(event)
  const metricKey = String(query.metricKey || '').trim()
  const limit = Math.max(3, Math.min(Number(query.limit || 12), 30))

  if (!workoutId) {
    throw createError({ statusCode: 400, message: 'Workout ID is required' })
  }

  if (!metricKey) {
    throw createError({ statusCode: 400, message: 'metricKey is required' })
  }

  const workout = await prisma.workout.findFirst({
    where: {
      id: workoutId,
      userId: (session.user as any).id
    },
    select: { id: true, userId: true, type: true, date: true }
  })

  if (!workout) {
    throw createError({ statusCode: 404, message: 'Workout not found' })
  }

  if (!workout.type) {
    return { metricKey, activityType: null, points: [] }
  }

  const candidateRecords = await prisma.workout.findMany({
    where: {
      userId: workout.userId,
      isDuplicate: false,
      type: workout.type,
      id: { not: workout.id },
      date: { lt: workout.date }
    },
    orderBy: { date: 'desc' },
    take: limit * 3
  })

  // CW-379: this used to `include: { streams: { select: { extrasMeta: true } } }`,
  // which reads the legacy V1 table only -- every FIT session-summary metric
  // (elapsed/timer time, total ascent/descent, calories, TSS) charted as an
  // empty history for athletes whose streams are in WorkoutStreamV2.
  //
  // The dedicated single-column read matters here: the only consumer is
  // getSessionSummaryValue(), which reads `streams.extrasMeta.sessionSummary`
  // and no series at all, while this query takes `limit * 3` rows (up to 90).
  // attachStreamsToWorkouts() would drag the mandatory V2 baseline -- six
  // parallel per-second series per workout -- across all of them for one JSON
  // blob. Same reasoning as findWattsByWorkoutIds().
  const extrasMetaByWorkoutId = await workoutStreamRepository.findExtrasMetaByWorkoutIds(
    candidateRecords.map((candidate) => candidate.id)
  )

  const candidates = candidateRecords.map((candidate) => {
    const extrasMeta = extrasMetaByWorkoutId.get(candidate.id)
    return { ...candidate, streams: extrasMeta == null ? null : { extrasMeta } }
  })

  const points = candidates
    .map((item) => {
      const value = extractMetricValue(item, metricKey)
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return null

      return {
        workoutId: item.id,
        date: item.date,
        title: item.title,
        value: Number(value)
      }
    })
    .filter((item): item is { workoutId: string; date: Date; title: string; value: number } =>
      Boolean(item)
    )
    .slice(0, limit)

  return {
    metricKey,
    activityType: workout.type,
    currentDate: workout.date,
    points
  }
})
