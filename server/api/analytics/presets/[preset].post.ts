import { z } from 'zod'
import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { getServerSession } from '../../../utils/session'
import {
  resolveAnalyticsScopeUserIds,
  type AnalyticsScopeInput
} from '../../../utils/analyticsScope'
import { prisma } from '../../../utils/db'
import {
  calculateHrZones,
  calculatePaceZones,
  calculatePowerZones,
  identifyZone
} from '../../../utils/zones'
import { sportSettingsRepository } from '../../../utils/repositories/sportSettingsRepository'
import { attachStreamsToWorkouts } from '../../../utils/repositories/workoutStreamRepository'

type PresetRoute =
  | 'compliance'
  | 'planned-vs-completed'
  | 'power-duration'
  | 'correlation'
  | 'team-heatmap'
  | 'team-comparison'

interface PresetRequestBody {
  scope?: AnalyticsScopeInput
  timeRange?: {
    startDate?: string
    endDate?: string
  }
  presetOptions?: Record<string, any>
}

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316']

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  const user = session?.user as any

  if (!user?.id) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const preset = getRouterParam(event, 'preset') as PresetRoute | undefined
  if (
    !preset ||
    ![
      'compliance',
      'planned-vs-completed',
      'power-duration',
      'correlation',
      'team-heatmap',
      'team-comparison'
    ].includes(preset)
  ) {
    throw createError({ statusCode: 404, statusMessage: 'Unknown analytics preset endpoint' })
  }

  const body = await readBody<PresetRequestBody>(event)
  const scope = body.scope || { target: 'self' }
  const { startDate, endDate } = resolveTimeRange(body.timeRange)
  const userIds = await resolveAnalyticsScopeUserIds(user.id, scope)

  if (userIds.length === 0) {
    return preset === 'team-heatmap' ? emptyHeatmap() : emptyChart()
  }

  switch (preset) {
    case 'compliance':
      return await buildComplianceChart(userIds, startDate, endDate, body.presetOptions || {})
    case 'planned-vs-completed':
      return await buildPlannedVsCompletedChart(
        userIds,
        startDate,
        endDate,
        body.presetOptions || {}
      )
    case 'power-duration':
      return await buildPowerDurationChart(userIds, startDate, endDate, body.presetOptions || {})
    case 'correlation':
      return await buildCorrelationChart(userIds, startDate, endDate, body.presetOptions || {})
    case 'team-heatmap':
      return await buildTeamHeatmap(userIds, startDate, endDate, body.presetOptions || {})
    case 'team-comparison':
      return await buildTeamComparisonChart(userIds, startDate, endDate, body.presetOptions || {})
  }
})

function emptyChart() {
  return { labels: [], datasets: [] }
}

function emptyHeatmap() {
  return {
    chartType: 'heatmap' as const,
    xLabels: [],
    yLabels: [],
    matrix: []
  }
}

function resolveTimeRange(timeRange?: PresetRequestBody['timeRange']) {
  const endDate = timeRange?.endDate ? new Date(timeRange.endDate) : new Date()
  const startDate = timeRange?.startDate
    ? new Date(timeRange.startDate)
    : new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000)

  return { startDate, endDate }
}

function toDayKey(date: Date | string) {
  return new Date(date).toISOString().split('T')[0] || ''
}

function startOfUtcWeek(date: Date | string) {
  const value = new Date(date)
  const day = value.getUTCDay()
  const diff = value.getUTCDate() - day + (day === 0 ? -6 : 1)
  value.setUTCDate(diff)
  value.setUTCHours(0, 0, 0, 0)
  return value
}

function toWeekKey(date: Date | string) {
  return toDayKey(startOfUtcWeek(date))
}

function buildDailyBuckets(startDate: Date, endDate: Date) {
  const buckets: string[] = []
  const cursor = new Date(startDate)
  cursor.setUTCHours(0, 0, 0, 0)

  while (cursor <= endDate) {
    buckets.push(toDayKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return buckets
}

function buildWeeklyBuckets(startDate: Date, endDate: Date) {
  const buckets: string[] = []
  const cursor = startOfUtcWeek(startDate)
  const finalKey = toWeekKey(endDate)

  while (true) {
    const key = toDayKey(cursor)
    buckets.push(key)
    if (key === finalKey) break
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }

  return buckets
}

function addToBucket(map: Map<string, number>, key: string, amount: number) {
  map.set(key, (map.get(key) || 0) + amount)
}

function round(value: number, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function resolveWorkoutValue(
  workout: { durationSec?: number | null; tss?: number | null },
  mode: 'volume' | 'load'
) {
  return mode === 'load' ? Number(workout.tss || 0) : Number(workout.durationSec || 0) / 3600
}

function normalizeWorkoutType(type?: string | null) {
  if (!type) return 'Unspecified'
  return type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')
}

function buildSingleSeriesChart(
  labels: string[],
  label: string,
  data: (number | null)[],
  color = CHART_COLORS[0]
) {
  return {
    labels,
    datasets: [{ label, data, color, type: 'bar' as const }]
  }
}

function addAverageDataset(
  labels: string[],
  datasets: Array<{ data: number[]; color?: string }>,
  label: string
) {
  if (!datasets.length) return null

  return {
    label,
    data: labels.map((_, index) =>
      round(
        datasets.reduce((sum, dataset) => sum + Number(dataset.data[index] || 0), 0) /
          datasets.length
      )
    ),
    color: '#f59e0b',
    type: 'line' as const
  }
}

async function buildComplianceChart(
  userIds: string[],
  startDate: Date,
  endDate: Date,
  presetOptions: Record<string, any>
) {
  const mode = presetOptions.mode as string

  if (mode === 'discipline-mix' || mode === 'workout-type-distribution') {
    const workouts = await prisma.workout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
        isDuplicate: false
      },
      select: {
        type: true,
        durationSec: true
      }
    })

    const totals = new Map<string, number>()
    for (const workout of workouts) {
      const key = normalizeWorkoutType(workout.type)
      const value = mode === 'discipline-mix' ? Number(workout.durationSec || 0) / 3600 : 1
      addToBucket(totals, key, value)
    }

    const labels = Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label]) => label)

    return {
      labels,
      datasets: [
        {
          label: mode === 'discipline-mix' ? 'Hours' : 'Sessions',
          data: labels.map((label) => round(totals.get(label) || 0)),
          color: CHART_COLORS[0],
          type: 'bar' as const
        }
      ]
    }
  }

  if (mode === 'session-density') {
    const buckets = buildWeeklyBuckets(startDate, endDate)
    const workouts = await prisma.workout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
        isDuplicate: false
      },
      select: { date: true }
    })

    const totals = new Map<string, number>()
    for (const workout of workouts) {
      addToBucket(totals, toWeekKey(workout.date), 1)
    }

    return buildSingleSeriesChart(
      buckets,
      'Completed Sessions',
      buckets.map((key) => totals.get(key) || 0)
    )
  }

  if (mode === 'training-consistency') {
    const buckets = buildWeeklyBuckets(startDate, endDate)
    const workouts = await prisma.workout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
        isDuplicate: false
      },
      select: { date: true }
    })

    const daysByBucket = new Map<string, Set<string>>()
    for (const bucket of buckets) {
      daysByBucket.set(bucket, new Set())
    }

    for (const workout of workouts) {
      daysByBucket.get(toWeekKey(workout.date))?.add(toDayKey(workout.date))
    }

    const counts = buckets.map((bucket) => daysByBucket.get(bucket)?.size || 0)
    const rolling = counts.map((_, index) => {
      const slice = counts.slice(Math.max(0, index - 3), index + 1)
      return round(slice.reduce((sum, value) => sum + value, 0) / slice.length)
    })

    return {
      labels: buckets,
      datasets: [
        {
          label: 'Training Days',
          data: counts,
          color: CHART_COLORS[0],
          type: 'bar' as const
        },
        {
          label: '4 Week Avg',
          data: rolling,
          color: CHART_COLORS[2],
          type: 'line' as const
        }
      ]
    }
  }

  if (mode === 'aerobic-decoupling') {
    const buckets = buildDailyBuckets(startDate, endDate)
    const workouts = await prisma.workout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
        isDuplicate: false,
        durationSec: { gte: 1800 } // At least 30 min for meaningful decoupling
      },
      select: { date: true, decoupling: true },
      orderBy: { date: 'asc' }
    })

    const byDay = new Map<string, number | null>()
    for (const item of workouts) {
      if (item.decoupling !== null) {
        byDay.set(toDayKey(item.date), Number(item.decoupling))
      }
    }

    return {
      labels: buckets,
      datasets: [
        {
          label: 'Aerobic Decoupling',
          data: buckets.map((key) => byDay.get(key) ?? null),
          color: CHART_COLORS[1],
          type: 'line' as const,
          spanGaps: true
        }
      ]
    }
  }

  if (mode === 'acwr') {
    const buckets = buildDailyBuckets(startDate, endDate)
    const historyStart = new Date(startDate.getTime() - 28 * 24 * 60 * 60 * 1000)
    const workoutHistoryBuckets = buildDailyBuckets(historyStart, endDate)
    const workouts = await prisma.workout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: historyStart, lte: endDate },
        isDuplicate: false
      },
      select: { userId: true, date: true, tss: true, trainingLoad: true },
      orderBy: { date: 'asc' }
    })

    const userLoadByDay = new Map<string, Map<string, number>>()
    for (const userId of userIds) {
      userLoadByDay.set(userId, new Map(workoutHistoryBuckets.map((bucket) => [bucket, 0])))
    }

    for (const item of workouts) {
      const dayKey = toDayKey(item.date)
      const current = userLoadByDay.get(item.userId)
      if (!current) continue
      const load = Number(item.trainingLoad ?? item.tss ?? 0)
      current.set(dayKey, Number(current.get(dayKey) || 0) + load)
    }

    const datasets = userIds.map((userId, idx) => {
      const history = workoutHistoryBuckets.map((day) => ({
        date: day,
        load: Number(userLoadByDay.get(userId)?.get(day) || 0)
      }))

      return {
        label: userIds.length > 1 ? `Athlete ${idx + 1}` : 'ACWR',
        data: buckets.map((day) => {
          const dayIdx = history.findIndex((h) => h.date === day)
          if (dayIdx < 0) return null

          // Acute: 7-day average
          const acuteSlice = history.slice(Math.max(0, dayIdx - 6), dayIdx + 1)
          const acute = acuteSlice.reduce((sum, h) => sum + h.load, 0) / 7

          // Chronic: 28-day average
          const chronicSlice = history.slice(Math.max(0, dayIdx - 27), dayIdx + 1)
          const chronic = chronicSlice.reduce((sum, h) => sum + h.load, 0) / 28

          if (chronic <= 0) return null
          return round(acute / chronic, 2)
        }),
        color: CHART_COLORS[idx % CHART_COLORS.length],
        type: 'line' as const,
        spanGaps: true
      }
    })

    return { labels: buckets, datasets }
  }

  if (mode === 'prior-block-vs-current-block') {
    const buckets = buildWeeklyBuckets(startDate, endDate)
    const spanMs = endDate.getTime() - startDate.getTime()
    const previousStartDate = new Date(startDate.getTime() - spanMs - 24 * 60 * 60 * 1000)
    const previousEndDate = new Date(startDate.getTime() - 24 * 60 * 60 * 1000)

    const [currentWorkouts, previousWorkouts] = await Promise.all([
      prisma.workout.findMany({
        where: {
          userId: { in: userIds },
          date: { gte: startDate, lte: endDate },
          isDuplicate: false
        },
        select: { date: true, tss: true }
      }),
      prisma.workout.findMany({
        where: {
          userId: { in: userIds },
          date: { gte: previousStartDate, lte: previousEndDate },
          isDuplicate: false
        },
        select: { date: true, tss: true }
      })
    ])

    const currentTotals = new Map<string, number>()
    const previousTotals = new Map<string, number>()

    for (const workout of currentWorkouts) {
      addToBucket(currentTotals, toWeekKey(workout.date), Number(workout.tss || 0))
    }

    const previousBuckets = buildWeeklyBuckets(previousStartDate, previousEndDate)
    previousBuckets.forEach((bucket, index) => {
      previousTotals.set(buckets[index] || bucket, 0)
    })

    for (const workout of previousWorkouts) {
      const previousIndex = previousBuckets.indexOf(toWeekKey(workout.date))
      const alignedBucket = buckets[previousIndex]
      if (!alignedBucket) continue
      addToBucket(previousTotals, alignedBucket, Number(workout.tss || 0))
    }

    return {
      labels: buckets,
      datasets: [
        {
          label: 'Current Block',
          data: buckets.map((bucket) => round(currentTotals.get(bucket) || 0)),
          color: CHART_COLORS[0],
          type: 'bar' as const
        },
        {
          label: 'Prior Block',
          data: buckets.map((bucket) => round(previousTotals.get(bucket) || 0)),
          color: CHART_COLORS[5],
          type: 'line' as const
        }
      ]
    }
  }

  const buckets = buildWeeklyBuckets(startDate, endDate)
  const planned = await prisma.plannedWorkout.findMany({
    where: {
      userId: { in: userIds },
      date: { gte: startDate, lte: endDate },
      category: 'WORKOUT'
    },
    select: {
      date: true,
      completed: true
    }
  })

  const totals = new Map<string, number>()
  const completed = new Map<string, number>()

  for (const workout of planned) {
    const key = toWeekKey(workout.date)
    addToBucket(totals, key, 1)
    if (workout.completed) addToBucket(completed, key, 1)
  }

  const completion = buckets.map((key) => {
    const total = totals.get(key) || 0
    if (total === 0) return 0
    return round(((completed.get(key) || 0) / total) * 100)
  })

  return {
    labels: buckets,
    datasets: [
      {
        label: 'Completion Rate',
        data: completion,
        color: CHART_COLORS[mode === 'adherence-trend' ? 0 : 2],
        type: mode === 'adherence-trend' ? ('line' as const) : ('bar' as const)
      }
    ]
  }
}

async function buildPlannedVsCompletedChart(
  userIds: string[],
  startDate: Date,
  endDate: Date,
  presetOptions: Record<string, any>
) {
  const mode = (presetOptions.mode as 'volume' | 'load') || 'volume'
  const buckets = buildWeeklyBuckets(startDate, endDate)

  const [planned, workouts] = await Promise.all([
    prisma.plannedWorkout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
        category: 'WORKOUT'
      },
      select: {
        date: true,
        durationSec: true,
        tss: true
      }
    }),
    prisma.workout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
        isDuplicate: false
      },
      select: {
        date: true,
        durationSec: true,
        tss: true
      }
    })
  ])

  const plannedTotals = new Map<string, number>()
  const completedTotals = new Map<string, number>()

  for (const item of planned) {
    addToBucket(plannedTotals, toWeekKey(item.date), resolveWorkoutValue(item, mode))
  }

  for (const item of workouts) {
    addToBucket(completedTotals, toWeekKey(item.date), resolveWorkoutValue(item, mode))
  }

  return {
    labels: buckets,
    datasets: [
      {
        label: mode === 'load' ? 'Planned TSS' : 'Planned Hours',
        data: buckets.map((key) => round(plannedTotals.get(key) || 0)),
        color: CHART_COLORS[0],
        type: 'bar' as const
      },
      {
        label: mode === 'load' ? 'Completed TSS' : 'Completed Hours',
        data: buckets.map((key) => round(completedTotals.get(key) || 0)),
        color: CHART_COLORS[2],
        type: 'line' as const
      }
    ]
  }
}

async function buildCorrelationChart(
  userIds: string[],
  startDate: Date,
  endDate: Date,
  presetOptions: Record<string, any>
) {
  const mode = presetOptions.mode as string

  if (mode === 'blood-pressure-trend') {
    const buckets = buildDailyBuckets(startDate, endDate)
    const wellness = await prisma.wellness.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate }
      },
      select: {
        date: true,
        systolic: true,
        diastolic: true
      },
      orderBy: { date: 'asc' }
    })

    const byDay = new Map<string, { systolic: number | null; diastolic: number | null }>()
    for (const item of wellness) {
      const key = toDayKey(item.date)
      byDay.set(key, {
        systolic: item.systolic,
        diastolic: item.diastolic
      })
    }

    return {
      labels: buckets,
      datasets: [
        {
          label: 'Systolic',
          data: buckets.map((key) => byDay.get(key)?.systolic || null),
          color: CHART_COLORS[0],
          type: 'line' as const
        },
        {
          label: 'Diastolic',
          data: buckets.map((key) => byDay.get(key)?.diastolic || null),
          color: CHART_COLORS[3],
          type: 'line' as const
        }
      ]
    }
  }

  if (mode === 'hrv-rhr-dual-axis') {
    const buckets = buildDailyBuckets(startDate, endDate)
    const wellness = await prisma.wellness.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate }
      },
      select: {
        date: true,
        hrv: true,
        restingHr: true
      },
      orderBy: { date: 'asc' }
    })

    const byDay = new Map<string, { hrv: number | null; restingHr: number | null }>()
    for (const item of wellness) {
      byDay.set(toDayKey(item.date), {
        hrv: item.hrv,
        restingHr: item.restingHr
      })
    }

    return {
      labels: buckets,
      datasets: [
        {
          label: 'HRV',
          data: buckets.map((key) => byDay.get(key)?.hrv ?? null),
          color: CHART_COLORS[4],
          type: 'line' as const
        },
        {
          label: 'Resting HR',
          data: buckets.map((key) => byDay.get(key)?.restingHr ?? null),
          color: CHART_COLORS[3],
          yAxisID: 'y1' as const,
          type: 'line' as const
        }
      ]
    }
  }

  if (mode === 'macro-accuracy-delta') {
    const buckets = buildDailyBuckets(startDate, endDate)
    const nutrition = await prisma.nutrition.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate }
      },
      select: {
        date: true,
        carbs: true,
        carbsGoal: true,
        protein: true,
        proteinGoal: true,
        fat: true,
        fatGoal: true
      },
      orderBy: { date: 'asc' }
    })

    const byDay = new Map<string, any>()
    for (const item of nutrition) {
      byDay.set(toDayKey(item.date), item)
    }

    return {
      labels: buckets,
      datasets: [
        {
          label: 'Carbs Delta',
          data: buckets.map((key) => {
            const d = byDay.get(key)
            return d ? round(Number(d.carbs || 0) - Number(d.carbsGoal || 0)) : null
          }),
          color: CHART_COLORS[0],
          type: 'bar' as const
        },
        {
          label: 'Protein Delta',
          data: buckets.map((key) => {
            const d = byDay.get(key)
            return d ? round(Number(d.protein || 0) - Number(d.proteinGoal || 0)) : null
          }),
          color: CHART_COLORS[1],
          type: 'bar' as const
        },
        {
          label: 'Fat Delta',
          data: buckets.map((key) => {
            const d = byDay.get(key)
            return d ? round(Number(d.fat || 0) - Number(d.fatGoal || 0)) : null
          }),
          color: CHART_COLORS[2],
          type: 'bar' as const
        }
      ]
    }
  }

  if (mode === 'hrv-recovery' || mode === 'sleep-recovery') {
    const wellness = await prisma.wellness.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate }
      },
      select: {
        date: true,
        hrv: true,
        sleepHours: true,
        recoveryScore: true
      },
      orderBy: { date: 'asc' }
    })

    return {
      labels: [],
      datasets: [
        {
          label: mode === 'hrv-recovery' ? 'HRV vs Recovery' : 'Sleep vs Recovery',
          data: wellness
            .filter((item) =>
              mode === 'hrv-recovery'
                ? item.hrv !== null && item.recoveryScore !== null
                : item.sleepHours !== null && item.recoveryScore !== null
            )
            .map((item) => ({
              x: mode === 'hrv-recovery' ? Number(item.hrv) : Number(item.sleepHours),
              y: Number(item.recoveryScore),
              date: item.date
            })),
          color: CHART_COLORS[0],
          type: 'line' as const,
          showLine: false
        }
      ]
    }
  }

  const [wellness, workouts] = await Promise.all([
    prisma.wellness.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate }
      },
      select: {
        date: true,
        readiness: true,
        recoveryScore: true
      }
    }),
    prisma.workout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
        isDuplicate: false
      },
      select: {
        date: true,
        tss: true,
        overallScore: true
      }
    })
  ])

  const wellnessByDay = new Map<
    string,
    { readiness: number | null; recoveryScore: number | null }
  >()
  for (const item of wellness) {
    wellnessByDay.set(toDayKey(item.date), {
      readiness: item.readiness,
      recoveryScore: item.recoveryScore
    })
  }

  return {
    labels: [],
    datasets: [
      {
        label: mode === 'readiness-performance' ? 'Readiness vs Performance' : 'Wellness vs Load',
        data: workouts
          .map((workout) => {
            const wellnessForDay = wellnessByDay.get(toDayKey(workout.date))
            const x =
              mode === 'readiness-performance'
                ? (wellnessForDay?.readiness ?? wellnessForDay?.recoveryScore ?? null)
                : (wellnessForDay?.recoveryScore ?? wellnessForDay?.readiness ?? null)
            const y =
              mode === 'readiness-performance'
                ? Number(workout.overallScore ?? workout.tss ?? 0)
                : Number(workout.tss ?? 0)

            if (x === null || y <= 0) return null
            return { x, y, date: workout.date }
          })
          .filter(Boolean),
        color: CHART_COLORS[2],
        type: 'line' as const,
        showLine: false
      }
    ]
  }
}

async function buildPowerDurationChart(
  userIds: string[],
  startDate: Date,
  endDate: Date,
  presetOptions: Record<string, any>
) {
  const mode = presetOptions.mode as string
  // CW-379: `streams` is the legacy V1 relation. Selecting it here made every
  // team power-duration / weekly-zone preset render empty for athletes whose
  // streams only exist in WorkoutStreamV2. Fetch the workouts, then let the
  // repository attach streams from whichever generation holds them.
  const workoutRecords = await prisma.workout.findMany({
    where: {
      userId: { in: userIds },
      date: { gte: startDate, lte: endDate },
      isDuplicate: false
    },
    select: {
      id: true,
      userId: true,
      date: true,
      type: true,
      durationSec: true,
      ftp: true,
      averageWatts: true,
      averageHr: true,
      intensity: true,
      workAboveFtp: true
    },
    orderBy: { date: 'asc' }
  })

  // Only time/watts/heartrate/velocity are read below -- all in the
  // repository's mandatory baseline, so no optional columns are fetched for
  // what can be an entire roster's worth of workouts.
  const workouts = await attachStreamsToWorkouts(workoutRecords, { baselineOnly: true })

  const userProfiles = await loadUserProfiles(userIds)

  if (mode === 'weekly-power-zones' || mode === 'weekly-hr-zones' || mode === 'weekly-pace-zones') {
    const buckets = buildWeeklyBuckets(startDate, endDate)
    const type =
      mode === 'weekly-power-zones' ? 'power' : mode === 'weekly-hr-zones' ? 'hr' : 'pace'

    // Use one explicit boundary set for the entire response. Mixing each athlete's
    // profile while rendering one shared stack makes the same zone index mean
    // different intensities across the selected roster.
    const referenceProfile = userProfiles.get(userIds[0] || '')
    const zoneTemplate =
      type === 'power'
        ? calculatePowerZones(referenceProfile?.ftp || 200)
        : type === 'hr'
          ? calculateHrZones(referenceProfile?.lthr || null, referenceProfile?.maxHr || 190)
          : calculatePaceZones(referenceProfile?.thresholdPace || 4.5)
    const templateLabels = zoneTemplate.map((zone) => zone.name)

    const weeklyTotals = new Map<string, number[]>()
    for (const bucket of buckets) {
      weeklyTotals.set(bucket, new Array(templateLabels.length).fill(0))
    }

    for (const workout of workouts) {
      const bucket = weeklyTotals.get(toWeekKey(workout.date))
      if (!bucket) continue

      const time = (workout.streams?.time as number[] | undefined) || []
      const values =
        type === 'power'
          ? (workout.streams?.watts as number[] | undefined) || []
          : type === 'hr'
            ? (workout.streams?.heartrate as number[] | undefined) || []
            : (workout.streams?.velocity as number[] | undefined) || []

      if (time.length > 1 && values.length > 1) {
        for (let index = 1; index < time.length; index++) {
          const delta = Number(time[index] || 0) - Number(time[index - 1] || 0)
          const value = Number(values[index] || 0)
          if (delta <= 0 || delta > 10 || value <= 0) continue
          const zone = identifyZone(value, zoneTemplate)
          const zoneIndex = zoneTemplate.findIndex((entry) => entry.name === zone?.name)
          if (zoneIndex >= 0 && bucket[zoneIndex] !== undefined) {
            bucket[zoneIndex] += delta
          }
        }
      } else {
        const fallbackValue =
          type === 'power'
            ? Number(workout.averageWatts || 0)
            : type === 'hr'
              ? Number(workout.averageHr || 0)
              : 0
        if (!fallbackValue || !workout.durationSec) continue
        const zone = identifyZone(fallbackValue, zoneTemplate)
        const zoneIndex = zoneTemplate.findIndex((entry) => entry.name === zone?.name)
        if (zoneIndex >= 0 && bucket[zoneIndex] !== undefined) {
          bucket[zoneIndex] += workout.durationSec
        }
      }
    }

    return {
      labels: buckets,
      datasets: templateLabels.map((label, index) => ({
        label,
        data: buckets.map((bucket) => {
          const totalSeconds = weeklyTotals.get(bucket)?.[index] || 0
          if (presetOptions.output === 'percent') {
            const weekTotal = (weeklyTotals.get(bucket) || []).reduce((s, v) => s + v, 0)
            return weekTotal > 0 ? round((totalSeconds / weekTotal) * 100) : 0
          }
          return round(totalSeconds / 3600)
        }),
        color: CHART_COLORS[index % CHART_COLORS.length],
        type: 'bar' as const
      }))
    }
  }

  if (mode === 'time-above-threshold') {
    const buckets = buildWeeklyBuckets(startDate, endDate)
    const totals = new Map<string, number>()

    for (const workout of workouts) {
      let seconds = Number(workout.workAboveFtp || 0)

      if (!seconds) {
        const ftp = Number(workout.ftp || userProfiles.get(workout.userId)?.ftp || 0)
        const watts = (workout.streams?.watts as number[] | undefined) || []
        const time = (workout.streams?.time as number[] | undefined) || []

        if (ftp > 0 && time.length > 1 && watts.length > 1) {
          for (let index = 1; index < time.length; index++) {
            const delta = Number(time[index] || 0) - Number(time[index - 1] || 0)
            if (delta <= 0 || delta > 10) continue
            if (Number(watts[index] || 0) >= ftp) seconds += delta
          }
        } else if (Number(workout.intensity || 0) >= 1) {
          seconds += Number(workout.durationSec || 0)
        }
      }

      addToBucket(totals, toWeekKey(workout.date), seconds / 3600)
    }

    return buildSingleSeriesChart(
      buckets,
      'Hours Above Threshold',
      buckets.map((bucket) => round(totals.get(bucket) || 0)),
      CHART_COLORS[2]
    )
  }

  const targetDuration = Number(presetOptions.durationSec || 300)

  if (mode === 'power-duration-curve') {
    const durations = [5, 30, 60, 300, 1200]
    const bestByDuration = new Map<number, number>()

    for (const duration of durations) bestByDuration.set(duration, 0)

    for (const workout of workouts) {
      const watts = ((workout.streams?.watts as number[] | undefined) || []).map((value) =>
        Number(value || 0)
      )
      const time = ((workout.streams?.time as number[] | undefined) || []).map((value) =>
        Number(value || 0)
      )

      for (const duration of durations) {
        const best =
          watts.length > 1 && time.length > 1
            ? getBestAverageForDuration(time, watts, duration)
            : Number(workout.averageWatts || 0)

        if (best > (bestByDuration.get(duration) || 0)) {
          bestByDuration.set(duration, round(best))
        }
      }
    }

    return {
      labels: [],
      datasets: [
        {
          label: 'Best Power',
          data: durations.map((duration) => ({
            x: duration,
            y: bestByDuration.get(duration) || 0
          })),
          color: CHART_COLORS[0],
          type: 'line' as const,
          showLine: true
        }
      ]
    }
  }

  const buckets = buildWeeklyBuckets(startDate, endDate)
  const bestPerWeek = new Map<string, number>()

  for (const workout of workouts) {
    const watts = ((workout.streams?.watts as number[] | undefined) || []).map((value) =>
      Number(value || 0)
    )
    const time = ((workout.streams?.time as number[] | undefined) || []).map((value) =>
      Number(value || 0)
    )
    const best =
      watts.length > 1 && time.length > 1
        ? getBestAverageForDuration(time, watts, targetDuration)
        : Number(workout.averageWatts || 0)

    const key = toWeekKey(workout.date)
    bestPerWeek.set(key, Math.max(bestPerWeek.get(key) || 0, best))
  }

  return {
    labels: buckets,
    datasets: [
      {
        label: `Best ${Math.round(targetDuration / 60)} min Power`,
        data: buckets.map((bucket) => round(bestPerWeek.get(bucket) || 0)),
        color: CHART_COLORS[0],
        type: 'line' as const
      }
    ]
  }
}

async function buildTeamHeatmap(
  userIds: string[],
  startDate: Date,
  endDate: Date,
  presetOptions: Record<string, any>
) {
  const mode = (presetOptions.mode as 'fatigue' | 'recovery') || 'fatigue'
  const [users, wellness] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true }
    }),
    prisma.wellness.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate }
      },
      select: {
        userId: true,
        date: true,
        tsb: true,
        recoveryScore: true
      }
    })
  ])

  const names = new Map(
    users.map((entry) => [entry.id, entry.name || entry.email || 'Unknown athlete'])
  )
  const xLabels = buildDailyBuckets(startDate, endDate)
  const yLabels = users
    .map((entry) => names.get(entry.id) || 'Unknown athlete')
    .sort((a, b) => a.localeCompare(b))

  const values = new Map<string, number | null>()
  for (const item of wellness) {
    const athlete = names.get(item.userId)
    if (!athlete) continue
    values.set(
      `${athlete}::${toDayKey(item.date)}`,
      mode === 'fatigue' ? round(Number(item.tsb || 0)) : Number(item.recoveryScore ?? null)
    )
  }

  const matrix = yLabels.flatMap((athlete) =>
    xLabels.map((day) => ({
      x: day,
      y: athlete,
      value: values.get(`${athlete}::${day}`) ?? null
    }))
  )

  return {
    chartType: 'heatmap' as const,
    xLabels,
    yLabels,
    matrix,
    valueLabel: mode === 'fatigue' ? 'TSB' : 'Recovery'
  }
}

async function buildTeamComparisonChart(
  userIds: string[],
  startDate: Date,
  endDate: Date,
  presetOptions: Record<string, any>
) {
  const mode = presetOptions.mode as string
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true }
  })
  const names = new Map(
    users.map((entry) => [entry.id, entry.name || entry.email || 'Unknown athlete'])
  )

  if (mode === 'compliance') {
    const planned = await prisma.plannedWorkout.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
        category: 'WORKOUT'
      },
      select: {
        userId: true,
        completed: true
      }
    })

    const totals = new Map<string, { total: number; completed: number }>()
    for (const userId of userIds) {
      totals.set(userId, { total: 0, completed: 0 })
    }

    for (const workout of planned) {
      const current = totals.get(workout.userId) || { total: 0, completed: 0 }
      current.total += 1
      if (workout.completed) current.completed += 1
      totals.set(workout.userId, current)
    }

    const rows = userIds
      .map((userId) => {
        const stats = totals.get(userId) || { total: 0, completed: 0 }
        return {
          name: names.get(userId) || 'Unknown athlete',
          value: stats.total === 0 ? 0 : round((stats.completed / stats.total) * 100)
        }
      })
      .sort((a, b) => b.value - a.value)

    const values = rows.map((row) => row.value)
    const teamAverage = values.length
      ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0

    return {
      labels: rows.map((row) => row.name),
      datasets: [
        {
          label: 'Adherence %',
          data: values,
          color: CHART_COLORS[1],
          type: 'bar' as const
        },
        {
          label: 'Team Average',
          data: rows.map(() => teamAverage),
          color: '#f59e0b',
          type: 'line' as const
        }
      ]
    }
  }

  const buckets = buildWeeklyBuckets(startDate, endDate)

  if (mode === 'ctl') {
    const wellness = await prisma.wellness.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate }
      },
      select: {
        userId: true,
        date: true,
        ctl: true
      }
    })

    const weeklyTotals = new Map<string, Map<string, { total: number; count: number }>>()
    for (const userId of userIds) {
      const userMap = new Map<string, { total: number; count: number }>()
      for (const bucket of buckets) userMap.set(bucket, { total: 0, count: 0 })
      weeklyTotals.set(userId, userMap)
    }

    for (const item of wellness) {
      const bucket = toWeekKey(item.date)
      const current = weeklyTotals.get(item.userId)?.get(bucket)
      if (!current || item.ctl === null) continue
      current.total += Number(item.ctl)
      current.count += 1
    }

    const datasets = userIds.map((userId, index) => ({
      label: names.get(userId) || `Athlete ${index + 1}`,
      data: buckets.map((bucket) => {
        const current = weeklyTotals.get(userId)?.get(bucket)
        if (!current || current.count === 0) return 0
        return round(current.total / current.count)
      }),
      color: CHART_COLORS[index % CHART_COLORS.length],
      type: 'line' as const
    }))

    const averageDataset = addAverageDataset(
      buckets,
      datasets as Array<{ data: number[]; color?: string }>,
      'Squad Average'
    )

    return {
      labels: buckets,
      datasets: averageDataset ? [...datasets, averageDataset] : datasets
    }
  }

  const workouts = await prisma.workout.findMany({
    where: {
      userId: { in: userIds },
      date: { gte: startDate, lte: endDate },
      isDuplicate: false
    },
    select: {
      userId: true,
      date: true,
      tss: true
    }
  })

  const weeklyTotals = new Map<string, Map<string, number>>()
  for (const userId of userIds) {
    const userMap = new Map<string, number>()
    for (const bucket of buckets) userMap.set(bucket, 0)
    weeklyTotals.set(userId, userMap)
  }

  for (const workout of workouts) {
    const current = weeklyTotals.get(workout.userId)
    if (!current) continue
    current.set(
      toWeekKey(workout.date),
      (current.get(toWeekKey(workout.date)) || 0) + Number(workout.tss || 0)
    )
  }

  const datasets = userIds.map((userId, index) => ({
    label: names.get(userId) || `Athlete ${index + 1}`,
    data: buckets.map((bucket) => round(weeklyTotals.get(userId)?.get(bucket) || 0)),
    color: CHART_COLORS[index % CHART_COLORS.length],
    type: 'line' as const
  }))

  const averageDataset = addAverageDataset(
    buckets,
    datasets as Array<{ data: number[]; color?: string }>,
    'Squad Average'
  )

  return {
    labels: buckets,
    datasets: averageDataset ? [...datasets, averageDataset] : datasets
  }
}

async function loadUserProfiles(userIds: string[]) {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      ftp: true,
      lthr: true,
      maxHr: true
    }
  })

  const defaults = await Promise.all(
    userIds.map(
      async (userId) => [userId, await sportSettingsRepository.getDefault(userId)] as const
    )
  )

  const defaultMap = new Map(defaults)
  return new Map(
    users.map((user) => [
      user.id,
      {
        ftp: defaultMap.get(user.id)?.ftp || user.ftp || 200,
        lthr: defaultMap.get(user.id)?.lthr || user.lthr || null,
        maxHr: defaultMap.get(user.id)?.maxHr || user.maxHr || 190,
        thresholdPace: defaultMap.get(user.id)?.thresholdPace || 4.5
      }
    ])
  )
}

function getBestAverageForDuration(time: number[], values: number[], durationSec: number) {
  let best = 0
  let start = 0
  let rollingSum = 0

  for (let end = 0; end < time.length; end++) {
    rollingSum += values[end] || 0

    while (start < end && (time[end] || 0) - (time[start] || 0) >= durationSec) {
      const sampleCount = end - start + 1
      if (sampleCount > 0) {
        best = Math.max(best, rollingSum / sampleCount)
      }
      rollingSum -= values[start] || 0
      start += 1
    }
  }

  return best
}
