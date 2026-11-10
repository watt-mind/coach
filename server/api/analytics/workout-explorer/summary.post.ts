import { z } from 'zod/v3'
import { requireAuth } from '../../../utils/auth-guard'
import { assertSingleWorkoutAccess, getAccessibleWorkout } from '../../../utils/analyticsScope'
import { prisma } from '../../../utils/db'
import { attachStreamToWorkout } from '../../../utils/repositories/workoutStreamRepository'
import { calculateSegmentSummary } from '../../../utils/analytics/segment-summary'
import { computeMMP } from '../../../utils/analytics/virtual-streams'
import {
  calculateAerobicDecoupling,
  calculateCoastingStats,
  calculateHeartRateRecovery,
  detectSurgesAndFades
} from '../../../utils/interval-detection'
import {
  allowedWorkoutExplorerSummaryMetrics,
  normalizeWorkoutMetricValue,
  workoutExplorerMetricLabels
} from '../../../utils/workoutExplorer'
import { sportSettingsRepository } from '../../../utils/repositories/sportSettingsRepository'

const schema = z.object({
  analysis: z.object({
    type: z.literal('single_workout'),
    mode: z.literal('summary'),
    workoutId: z.string().min(1)
  }),
  summaryType: z.enum(['metrics', 'zones', 'advanced']).optional(),
  metrics: z.array(z.object({ field: z.string() })).default([]),
  zoneType: z.enum(['power', 'hr']).optional(),
  advancedMode: z
    .enum([
      'half_split_power_hr',
      'surge_cost_profile',
      'coasting_breakdown',
      'session_signature_radar',
      'mmp_curve'
    ])
    .optional(),
  visualType: z.enum(['bar', 'line', 'combo', 'radar', 'scatter']).optional(),
  range: z
    .object({
      start: z.number(),
      end: z.number(),
      alignment: z.enum(['elapsed_time', 'distance', 'percent_complete']).default('elapsed_time')
    })
    .nullable()
    .optional()
})

function toNumberArray(stream: unknown): number[] {
  if (!Array.isArray(stream)) return []
  return stream.map((value) => {
    const numeric = Number(value)
    return Number.isNaN(numeric) ? 0 : numeric
  })
}

function getRangeIndices(
  alignmentStream: number[],
  range?: {
    start: number
    end: number
    alignment: 'elapsed_time' | 'distance' | 'percent_complete'
  } | null
) {
  if (!range || alignmentStream.length === 0) {
    return { startIdx: 0, endIdx: Math.max(0, alignmentStream.length - 1) }
  }

  let startIdx = 0
  let endIdx = alignmentStream.length - 1

  for (let i = 0; i < alignmentStream.length; i++) {
    if (alignmentStream[i]! >= range.start) {
      startIdx = i
      break
    }
  }

  for (let i = alignmentStream.length - 1; i >= 0; i--) {
    if (alignmentStream[i]! <= range.end) {
      endIdx = i
      break
    }
  }

  return { startIdx, endIdx }
}

function sliceStream(stream: number[], startIdx: number, endIdx: number) {
  return stream.slice(startIdx, endIdx + 1)
}

function average(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value))
  if (valid.length === 0) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event)
  const body = await readBody(event)
  const result = schema.safeParse(body)

  if (!result.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid workout explorer summary configuration',
      data: result.error.issues
    })
  }

  const { analysis, metrics, visualType, summaryType, zoneType, range, advancedMode } = result.data
  const workoutId = await assertSingleWorkoutAccess(user.id, analysis.workoutId)

  if (summaryType === 'zones') {
    if (!zoneType) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Zone summary requires a zone type'
      })
    }

    // Semantic zone colors: Z1 → Z7 (power) or Z1 → Z5 (HR)
    const POWER_ZONE_COLORS = [
      '#64748b', // Z1 – Active Recovery – slate
      '#3b82f6', // Z2 – Endurance – blue
      '#10b981', // Z3 – Tempo – emerald
      '#f59e0b', // Z4 – Threshold – amber
      '#f97316', // Z5 – VO2max – orange
      '#ef4444', // Z6 – Anaerobic – red
      '#a855f7' // Z7 – Neuromuscular – purple
    ]
    const HR_ZONE_COLORS = [
      '#64748b', // Z1 – Recovery – slate
      '#3b82f6', // Z2 – Aerobic base – blue
      '#10b981', // Z3 – Aerobic – emerald
      '#f59e0b', // Z4 – Threshold – amber
      '#ef4444' // Z5 – VO2max – red
    ]

    let zoneDistribution: any
    if (range) {
      const segment = await calculateSegmentSummary(user.id, workoutId, range)
      zoneDistribution =
        zoneType === 'hr' ? segment.zoneDistribution?.hr : segment.zoneDistribution?.power
    } else {
      const { calculateZoneDistribution } = await import('../../../utils/training-metrics')
      const distribution = await calculateZoneDistribution([workoutId], user.id, prisma)
      zoneDistribution = zoneType === 'hr' ? distribution.hr : distribution.power
    }

    if (!zoneDistribution || zoneDistribution.zones.length === 0) {
      return {
        labels: [],
        datasets: [],
        unsupportedReason: `No ${zoneType === 'hr' ? 'heart-rate' : 'power'} zone data was available for this workout.`
      }
    }

    const palette = zoneType === 'hr' ? HR_ZONE_COLORS : POWER_ZONE_COLORS
    const zoneColors = zoneDistribution.zones.map(
      (_: any, i: number) => palette[i] || palette[palette.length - 1]
    )

    return {
      labels: zoneDistribution.zones.map((zone: any) => zone.name),
      datasets: [
        {
          label: zoneType === 'hr' ? 'Heart Rate Zone Time' : 'Power Zone Time',
          type: visualType || 'bar',
          data: zoneDistribution.zones.map((zone: any) => Number(zone.percentage.toFixed(1))),
          backgroundColor: zoneColors.map((c: string) => `${c}cc`),
          borderColor: zoneColors,
          borderWidth: 1.5
        }
      ],
      annotations: []
    }
  }

  if (summaryType === 'advanced') {
    if (!advancedMode) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Advanced workout summary requires an advanced mode'
      })
    }

    // CW-379: `streams` reads the legacy V1 table only, so every advanced
    // summary mode degraded to "requires stream data" for V2-only workouts.
    const workoutRecord = await getAccessibleWorkout(user.id, analysis.workoutId, {
      select: {
        id: true,
        type: true,
        averageWatts: true,
        normalizedPower: true,
        averageHr: true,
        efficiencyFactor: true,
        powerHrRatio: true,
        variabilityIndex: true,
        decoupling: true,
        workAboveFtp: true
      }
    })

    const workout = workoutRecord ? await attachStreamToWorkout(workoutRecord) : null

    if (!workout || !workout.streams) {
      return {
        labels: [],
        datasets: [],
        unsupportedReason: 'Advanced summary requires stream data for this workout.'
      }
    }

    const time = toNumberArray(workout.streams.time)
    const distance = toNumberArray(workout.streams.distance)
    const watts = toNumberArray(workout.streams.watts)
    const heartrate = toNumberArray(workout.streams.heartrate)
    const cadence = toNumberArray(workout.streams.cadence)
    const velocity = toNumberArray(workout.streams.velocity)

    if (advancedMode === 'mmp_curve') {
      if (watts.length === 0 || time.length === 0) {
        return {
          labels: [],
          datasets: [],
          unsupportedReason: 'No power stream data available to compute the MMP curve.'
        }
      }

      const sportSettings = await sportSettingsRepository.getForActivityType(
        user.id,
        workout.type || 'Cycling'
      )
      const ftp = sportSettings?.ftp || null

      const mmpPoints = computeMMP(watts, time)
      if (mmpPoints.length === 0) {
        return {
          labels: [],
          datasets: [],
          unsupportedReason: 'Insufficient power data to compute the MMP curve.'
        }
      }

      const annotations: any[] = ftp
        ? [
            {
              type: 'line',
              scaleID: 'y',
              value: ftp,
              label: `FTP ${ftp}W`,
              borderColor: '#f59e0b',
              borderDash: [6, 4]
            }
          ]
        : []

      return {
        labels: [],
        datasets: [
          {
            label: 'Mean Maximal Power',
            type: 'scatter',
            data: mmpPoints,
            showLine: true,
            color: '#3b82f6',
            borderColor: '#3b82f6',
            pointRadius: 3,
            fill: 'origin'
          }
        ],
        annotations
      }
    }

    let alignmentStream: number[]
    if (range?.alignment === 'percent_complete') {
      const maxTime = time[time.length - 1] || 1
      alignmentStream = time.map((t) => (t / maxTime) * 100)
    } else {
      alignmentStream = range?.alignment === 'distance' ? distance : time
    }
    const { startIdx, endIdx } = getRangeIndices(alignmentStream, range)

    if (startIdx >= endIdx) {
      return {
        labels: [],
        datasets: [],
        unsupportedReason: 'The selected segment is too small to summarize.'
      }
    }

    const slicedTime = sliceStream(time, startIdx, endIdx)
    const slicedWatts = sliceStream(watts, startIdx, endIdx)
    const slicedHr = sliceStream(heartrate, startIdx, endIdx)
    const slicedCadence = sliceStream(cadence, startIdx, endIdx)
    const slicedVelocity = sliceStream(velocity, startIdx, endIdx)

    if (advancedMode === 'half_split_power_hr') {
      const midpoint = Math.floor(slicedTime.length / 2)
      if (midpoint < 1) {
        return {
          labels: [],
          datasets: [],
          unsupportedReason: 'This workout needs more stream data for a half-split durability view.'
        }
      }

      const firstPower = average(slicedWatts.slice(0, midpoint))
      const secondPower = average(slicedWatts.slice(midpoint))
      const firstHr = average(slicedHr.slice(0, midpoint))
      const secondHr = average(slicedHr.slice(midpoint))
      const splitDecoupling = calculateAerobicDecoupling(slicedTime, slicedWatts, slicedHr)

      return {
        labels: ['First Half', 'Second Half'],
        datasets: [
          {
            label: 'Avg Power',
            type: 'bar',
            data: [firstPower, secondPower]
          },
          {
            label: 'Avg HR',
            type: 'line',
            data: [firstHr, secondHr],
            yAxisID: 'y1'
          }
        ],
        annotations:
          splitDecoupling !== null
            ? [
                {
                  type: 'line',
                  scaleID: 'y',
                  value: Math.max(firstPower || 0, secondPower || 0),
                  label: `Decoupling ${Math.abs(splitDecoupling * 100).toFixed(1)}%`,
                  borderColor: '#f59e0b',
                  borderDash: [4, 4]
                }
              ]
            : []
      }
    }

    if (advancedMode === 'surge_cost_profile') {
      const sportSettings = await sportSettingsRepository.getForActivityType(
        user.id,
        workout.type || 'Cycling'
      )
      const ftp = sportSettings?.ftp || 200
      const surges = detectSurgesAndFades(slicedTime, slicedWatts, ftp).slice(0, 6)

      if (surges.length === 0) {
        return {
          labels: [],
          datasets: [],
          unsupportedReason: 'No sustained surge events were detected in this workout.'
        }
      }

      return {
        labels: surges.map((_, index) => `Surge ${index + 1}`),
        datasets: [
          {
            label: 'Surge Power',
            type: 'bar',
            data: surges.map((surge) => surge.avg_power)
          },
          {
            label: 'Recovery Cost',
            type: 'line',
            data: surges.map((surge) => surge.cost_avg_power)
          }
        ],
        annotations: []
      }
    }

    if (advancedMode === 'coasting_breakdown') {
      const coasting = calculateCoastingStats(
        slicedTime,
        slicedWatts,
        slicedCadence,
        slicedVelocity
      )
      const coastingPct = Number(coasting.percentTime.toFixed(1))
      const pedalingPct = Math.max(0, Number((100 - coastingPct).toFixed(1)))

      return {
        labels: ['Pedaling', 'Coasting'],
        datasets: [
          {
            label: '% of Time',
            type: 'bar',
            data: [pedalingPct, coastingPct]
          }
        ],
        annotations: [
          {
            type: 'line',
            scaleID: 'y',
            value: coastingPct,
            label: `${coasting.eventCount} micro-rest events`,
            borderColor: '#94a3b8',
            borderDash: [6, 6]
          }
        ]
      }
    }

    const hrRecovery = calculateHeartRateRecovery(slicedTime, slicedHr)
    const coasting = calculateCoastingStats(slicedTime, slicedWatts, slicedCadence, slicedVelocity)
    const durabilityScore = clampScore(
      100 - Math.max(0, (calculateAerobicDecoupling(slicedTime, slicedWatts, slicedHr) || 0) * 900)
    )
    const controlScore = clampScore(100 - Math.max(0, ((workout.variabilityIndex || 1) - 1) * 220))
    const efficiencyScore = clampScore(
      Math.max(
        0,
        ((workout.powerHrRatio ||
          workout.efficiencyFactor ||
          (workout.averageWatts || 0) / Math.max(1, workout.averageHr || 0)) -
          1.1) *
          90
      )
    )
    const punchScore = clampScore(
      (workout.workAboveFtp || 0) / 20 +
        ((workout.normalizedPower || 0) / Math.max(1, workout.averageWatts || 1) - 1) * 120
    )
    const recoveryScore = clampScore((hrRecovery?.drops || 0) * 2.5)
    const pedalingScore = clampScore(100 - coasting.percentTime * 2.4)

    return {
      labels: ['Control', 'Durability', 'Efficiency', 'Punch', 'Recovery', 'Pedaling'],
      datasets: [
        {
          label: 'Session Signature',
          type: 'line',
          data: [
            controlScore,
            durabilityScore,
            efficiencyScore,
            punchScore,
            recoveryScore,
            pedalingScore
          ]
        }
      ],
      annotations: []
    }
  }

  const metricFields = metrics.map((metric) => metric.field)
  if (metricFields.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Metric summary requires at least one metric'
    })
  }
  for (const field of metricFields) {
    if (!allowedWorkoutExplorerSummaryMetrics.has(field)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Unsupported workout explorer metric: ${field}`
      })
    }
  }

  const workout = range
    ? await calculateSegmentSummary(user.id, workoutId, range)
    : await getAccessibleWorkout(user.id, analysis.workoutId, {
        select: {
          id: true,
          trainingLoad: true,
          tss: true,
          kilojoules: true,
          calories: true,
          elevationGain: true,
          averageWatts: true,
          maxWatts: true,
          normalizedPower: true,
          averageHr: true,
          maxHr: true,
          averageCadence: true,
          averageSpeed: true,
          intensity: true,
          efficiencyFactor: true,
          decoupling: true,
          powerHrRatio: true,
          variabilityIndex: true,
          durationSec: true,
          elapsedTimeSec: true,
          distanceMeters: true,
          trimp: true,
          hrLoad: true,
          workAboveFtp: true
        }
      })

  if (!workout) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Workout not found'
    })
  }

  return {
    labels: ['Workout'],
    datasets: metricFields.map((field) => ({
      label: workoutExplorerMetricLabels[field] || field,
      type: visualType || 'bar',
      data: [normalizeWorkoutMetricValue(field, (workout as any)[field])]
    })),
    annotations: []
  }
})
