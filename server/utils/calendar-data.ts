import { prisma } from './db'
import {
  getUserLocalDate,
  getTimestampDateKey,
  getStartOfLocalDateUTC,
  getEndOfLocalDateUTC,
  formatDateUTC
} from './date'
import { nutritionRepository } from './repositories/nutritionRepository'
import { wellnessRepository } from './repositories/wellnessRepository'
import { calendarNoteRepository } from './repositories/calendarNoteRepository'
import { workoutRepository } from './repositories/workoutRepository'
import { workoutStreamRepository } from './repositories/workoutStreamRepository'
import { applyCanonicalNutritionTargets } from './nutrition/canonical-targets'
import { getUserNutritionSettings } from './nutrition/settings'
import { metabolicService } from './services/metabolicService'
import { bodyMetricResolver } from './services/bodyMetricResolver'
import { getCalendarNoteDisplayEndDate } from './calendar-notes'
import { getJsonObject } from './prisma-json'

export async function getCalendarDataForUser(
  userId: string,
  startDate: Date,
  endDate: Date,
  options: {
    includeNutrition?: boolean
    includeGoals?: boolean
    includeThresholds?: boolean
    includePersonalBests?: boolean
  } = {}
) {
  const includeNutrition = options.includeNutrition ?? true
  const includeGoals = options.includeGoals ?? true
  const includeThresholds = options.includeThresholds ?? true
  const includePersonalBests = options.includePersonalBests ?? true

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      timezone: true,
      weight: true,
      weightSourceMode: true,
      ftp: true,
      nutritionTrackingEnabled: true
    }
  })
  const timezone = user?.timezone ?? 'UTC'
  const nutritionEnabled = includeNutrition && (user?.nutritionTrackingEnabled ?? true)
  const today = getUserLocalDate(timezone)

  // Calendar grid dates are UTC calendar labels; interpret them as viewer-local days
  // so late-day workouts on the last visible grid date are not dropped from the fetch range.
  const calendarStart = new Date(
    Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
  )
  const calendarEnd = new Date(
    Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  )
  const rangeStart = getStartOfLocalDateUTC(timezone, formatDateUTC(calendarStart, 'yyyy-MM-dd'))
  const rangeEnd = getEndOfLocalDateUTC(timezone, formatDateUTC(calendarEnd, 'yyyy-MM-dd'))

  const nutritionByDate = new Map<string, any>()
  if (nutritionEnabled) {
    const nutrition = await nutritionRepository.getForUser(userId, {
      startDate: calendarStart,
      endDate: calendarEnd,
      orderBy: { date: 'asc' },
      select: {
        id: true,
        date: true,
        calories: true,
        protein: true,
        carbs: true,
        fat: true,
        caloriesGoal: true,
        proteinGoal: true,
        carbsGoal: true,
        fatGoal: true,
        fuelingPlan: true,
        overallScore: true,
        isManualLock: true,
        endingGlycogenPercentage: true,
        endingFluidDeficit: true,
        breakfast: true,
        lunch: true,
        dinner: true,
        snacks: true
      }
    })

    const metabolicStates = await metabolicService.getMetabolicStatesForRange(
      userId,
      calendarStart,
      calendarEnd
    )

    for (const n of nutrition) {
      if (!n) continue
      const dateKey = n.date.toISOString().split('T')[0] as string
      const state = metabolicStates.get(dateKey) || { startingGlycogen: 85, startingFluid: 0 }
      const fuelingPlan = getJsonObject(n.fuelingPlan)

      nutritionByDate.set(dateKey, {
        ...applyCanonicalNutritionTargets({
          ...n,
          fuelingPlan: fuelingPlan as {
            dailyTotals?: {
              calories?: number | null
              carbs?: number | null
              protein?: number | null
              fat?: number | null
            } | null
          } | null
        }),
        startingGlycogen: state.startingGlycogen,
        startingFluid: state.startingFluid
      })
    }
  }

  const wellness = await wellnessRepository.getForUser(userId, {
    startDate: calendarStart,
    endDate: calendarEnd,
    orderBy: { date: 'asc' }
  })

  const dailyMetrics = await prisma.dailyMetric.findMany({
    where: {
      userId,
      date: {
        gte: calendarStart,
        lte: calendarEnd
      }
    },
    orderBy: { date: 'asc' }
  })

  const wellnessByDate = new Map<string, any>()
  for (const d of dailyMetrics) {
    const dateKey = d.date.toISOString().split('T')[0] ?? ''
    wellnessByDate.set(dateKey, {
      hrv: d.hrv,
      restingHr: d.restingHr,
      sleepScore: d.sleepScore,
      hoursSlept: d.hoursSlept,
      recoveryScore: d.recoveryScore,
      weight: null
    })
  }
  for (const w of wellness) {
    const dateKey = w.date.toISOString().split('T')[0] ?? ''
    const existing = wellnessByDate.get(dateKey) || {}
    wellnessByDate.set(dateKey, {
      hrv: w.hrv ?? existing.hrv,
      restingHr: w.restingHr ?? existing.restingHr,
      sleepScore: w.sleepQuality ?? w.sleepScore ?? existing.sleepScore,
      hoursSlept: w.sleepHours ?? existing.hoursSlept,
      recoveryScore: w.recoveryScore ?? existing.recoveryScore,
      weight: w.weight ?? existing.weight
    })
  }

  const workouts = await workoutRepository.getForUser(userId, {
    startDate: rangeStart,
    endDate: rangeEnd,
    orderBy: { date: 'asc' },
    include: {
      plannedWorkout: true
    }
  })

  // CW-379: `streams: { select: { id: true } }` used to ride along on the query
  // above purely to drive the `hasStreams` flag below, but it only ever saw the
  // legacy V1 table -- so the calendar showed no stream indicator at all for
  // athletes whose series live in WorkoutStreamV2. The repository's presence
  // probe evaluates "has usable stream data" over both tables in SQL: Postgres
  // still reads the series to answer it, but only a boolean crosses the wire.
  const workoutsWithStreams = await workoutStreamRepository.findManyByWorkoutIds(
    workouts.map((w) => w.id),
    { fields: [] }
  )

  const plannedWorkouts = await prisma.plannedWorkout.findMany({
    where: {
      userId,
      date: {
        gte: rangeStart,
        lte: rangeEnd
      }
    },
    orderBy: { date: 'asc' }
  })

  if (nutritionEnabled) {
    const nutritionSettings = await getUserNutritionSettings(userId)
    const effectiveWeight = await bodyMetricResolver.resolveEffectiveWeight(userId, {
      weight: user?.weight,
      weightSourceMode: user?.weightSourceMode
    })
    const profile = {
      weight: effectiveWeight.value || 75,
      ftp: user?.ftp || 250,
      currentCarbMax: nutritionSettings.currentCarbMax,
      sodiumTarget: nutritionSettings.sodiumTarget,
      sweatRate: nutritionSettings.sweatRate ?? undefined,
      preWorkoutWindow: nutritionSettings.preWorkoutWindow,
      postWorkoutWindow: nutritionSettings.postWorkoutWindow,
      fuelingSensitivity: nutritionSettings.fuelingSensitivity,
      fuelState1Trigger: nutritionSettings.fuelState1Trigger,
      fuelState1Min: nutritionSettings.fuelState1Min,
      fuelState1Max: nutritionSettings.fuelState1Max,
      fuelState2Trigger: nutritionSettings.fuelState2Trigger,
      fuelState2Min: nutritionSettings.fuelState2Min,
      fuelState2Max: nutritionSettings.fuelState2Max,
      fuelState3Min: nutritionSettings.fuelState3Min,
      fuelState3Max: nutritionSettings.fuelState3Max,
      bmr: nutritionSettings.bmr ?? 1600,
      activityLevel: nutritionSettings.activityLevel || 'ACTIVE',
      baseCaloriesMode: (nutritionSettings.baseCaloriesMode === 'MANUAL_NON_EXERCISE'
        ? 'MANUAL_NON_EXERCISE'
        : 'AUTO') as 'AUTO' | 'MANUAL_NON_EXERCISE',
      nonExerciseBaseCalories: nutritionSettings.nonExerciseBaseCalories ?? undefined,
      targetAdjustmentPercent: nutritionSettings.targetAdjustmentPercent ?? 0,
      baseProteinPerKg: nutritionSettings.baseProteinPerKg,
      baseFatPerKg: nutritionSettings.baseFatPerKg
    }

    const plannedByDate = new Map<string, any[]>()
    for (const p of plannedWorkouts) {
      const dateKey = p.date.toISOString().split('T')[0] ?? ''
      if (!plannedByDate.has(dateKey)) plannedByDate.set(dateKey, [])
      plannedByDate.get(dateKey)!.push(p)
    }

    for (const [dateKey, dayWorkouts] of plannedByDate.entries()) {
      const existing = nutritionByDate.get(dateKey)
      if (!existing || (!existing.fuelingPlan && !existing.isManualLock)) {
        if (dayWorkouts.length > 0) {
          const date = new Date(`${dateKey}T00:00:00Z`)
          const planResult = await metabolicService.calculateFuelingPlanForDate(userId, date, {
            persist: false
          })
          const estimate = planResult.plan as any

          nutritionByDate.set(dateKey, {
            calories: existing?.calories ?? 0,
            protein: existing?.protein ?? 0,
            carbs: existing?.carbs ?? 0,
            fat: existing?.fat ?? 0,
            caloriesGoal: estimate.dailyTotals.calories,
            proteinGoal: estimate.dailyTotals.protein,
            carbsGoal: estimate.dailyTotals.carbs,
            fatGoal: estimate.dailyTotals.fat,
            fuelingPlan: estimate,
            isEstimate: !existing,
            isEstimateGoal: !!existing,
            overallScore: existing?.overallScore
          })
        }
      }
    }
  }

  const calendarNotes = await calendarNoteRepository.getForUser(userId, {
    startDate: rangeStart,
    endDate: rangeEnd,
    orderBy: { startDate: 'asc' }
  })

  const [goals, metricHistory, personalBests] = await Promise.all([
    includeGoals
      ? prisma.goal.findMany({
          where: {
            userId,
            OR: [
              { targetDate: { gte: calendarStart, lte: calendarEnd } },
              { eventDate: { gte: calendarStart, lte: calendarEnd } }
            ]
          },
          orderBy: { targetDate: 'asc' }
        })
      : Promise.resolve([]),
    includeThresholds
      ? prisma.metricHistory.findMany({
          where: {
            userId,
            date: { gte: rangeStart, lte: rangeEnd },
            type: { in: ['FTP', 'LTHR', 'MAX_HR', 'THRESHOLD_PACE', 'WEIGHT'] }
          },
          orderBy: { date: 'asc' }
        })
      : Promise.resolve([]),
    includePersonalBests
      ? prisma.personalBest.findMany({
          where: { userId, date: { gte: rangeStart, lte: rangeEnd } },
          orderBy: { date: 'asc' }
        })
      : Promise.resolve([])
  ])

  const completedPlannedIds = new Set(workouts.map((w) => w.plannedWorkoutId).filter(Boolean))
  const activitiesByDate = new Map<string, any[]>()

  for (const g of goals) {
    const goalDate = g.eventDate || g.targetDate
    if (!goalDate) continue
    const dateKey = goalDate.toISOString().split('T')[0] ?? ''
    if (!activitiesByDate.has(dateKey)) activitiesByDate.set(dateKey, [])
    const existing = activitiesByDate.get(dateKey)!
    if (existing.some((a: any) => a.id === g.id && a.source === 'goal')) continue
    existing.push({
      id: g.id,
      title: g.title,
      date: goalDate.toISOString(),
      type: 'Goal',
      source: 'goal',
      status: g.status === 'ACTIVE' ? 'active' : 'completed',
      priority: g.priority,
      metric: g.metric,
      targetValue: g.targetValue,
      description: g.description
    })
  }

  for (const m of metricHistory) {
    const dateKey = m.date.toISOString().split('T')[0] ?? ''
    if (!activitiesByDate.has(dateKey)) activitiesByDate.set(dateKey, [])
    const existing = activitiesByDate.get(dateKey)!
    if (
      existing.some(
        (a: any) =>
          a.source === 'threshold' &&
          (a.id === m.id || (a.metric === m.type && a.value === m.value))
      )
    ) {
      continue
    }

    const displayType = m.type
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
      .replace('Ftp', 'FTP')
      .replace('Lthr', 'LTHR')
      .replace('Hr', 'HR')

    let formattedValue = m.value.toString()
    let formattedOldValue = m.oldValue?.toString()
    let unit = ''
    if (m.type === 'THRESHOLD_PACE') {
      const formatPace = (s: number) => {
        const min = Math.floor(s / 60)
        const sec = Math.round(s % 60)
        return `${min}:${sec.toString().padStart(2, '0')}`
      }
      formattedValue = formatPace(m.value)
      if (m.oldValue) formattedOldValue = formatPace(m.oldValue)
      unit = '/km'
    } else if (m.type.includes('HR')) {
      unit = ' bpm'
    } else if (m.type === 'FTP') {
      unit = 'W'
    }

    const metricLabel = m.sportProfileName ? `${m.sportProfileName} ${displayType}` : displayType
    let title = `${metricLabel}: ${formattedValue}${unit}`
    if (m.oldValue !== null && formattedOldValue) {
      title = `${metricLabel}: ${formattedOldValue} → ${formattedValue}${unit}`
    }

    existing.push({
      id: m.id,
      title,
      date: m.date.toISOString(),
      type: 'Threshold',
      source: 'threshold',
      status: 'completed',
      metric: m.type,
      value: m.value,
      oldValue: m.oldValue,
      sportProfileName: m.sportProfileName || undefined,
      description: m.notes
    })
  }

  for (const pb of personalBests) {
    const dateKey = pb.date.toISOString().split('T')[0] ?? ''
    if (!activitiesByDate.has(dateKey)) activitiesByDate.set(dateKey, [])
    const existing = activitiesByDate.get(dateKey)!
    if (
      existing.some(
        (a: any) =>
          a.source === 'pb' && (a.id === pb.id || (a.metric === pb.type && a.value === pb.value))
      )
    ) {
      continue
    }

    let displayType = pb.type
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
    if (pb.type.startsWith('RUN_')) displayType = `${pb.type.replace('RUN_', '')} Run`
    else if (pb.type.startsWith('POWER_')) displayType = `${pb.type.replace('POWER_', '')} Power`

    let displayValue = `${pb.value}${pb.unit}`
    if (pb.type.startsWith('RUN_') && pb.unit.toLowerCase() === 's') {
      const min = Math.floor(pb.value / 60)
      const sec = Math.round(pb.value % 60)
      displayValue = `${min}:${sec.toString().padStart(2, '0')}`
    }

    existing.push({
      id: pb.id,
      title: `${displayType} (${displayValue})`,
      date: pb.date.toISOString(),
      type: 'PB',
      source: 'pb',
      status: 'completed',
      metric: pb.type,
      value: pb.value,
      unit: pb.unit,
      description: pb.notes
    })
  }

  for (const w of workouts) {
    const dateKey = getTimestampDateKey(w.date, timezone)
    if (!activitiesByDate.has(dateKey)) activitiesByDate.set(dateKey, [])
    activitiesByDate.get(dateKey)!.push({
      id: w.id,
      title: w.title,
      date: w.date.toISOString(),
      type: w.type || 'Activity',
      source: 'completed',
      status: 'completed',
      duration: w.durationSec,
      durationSec: w.durationSec,
      distance: w.distanceMeters,
      tss: w.tss,
      trainingLoad: w.trainingLoad,
      trimp: w.trimp,
      intensity: w.intensity,
      averageHr: w.averageHr,
      averageWatts: w.averageWatts,
      normalizedPower: w.normalizedPower,
      weightedAvgWatts: w.weightedAvgWatts,
      kilojoules: w.kilojoules,
      ctl: w.ctl,
      atl: w.atl,
      rpe: w.rpe,
      sessionRpe: w.sessionRpe,
      feel: w.feel,
      calories: w.calories,
      elapsedTime: w.elapsedTimeSec,
      deviceName: w.deviceName,
      commute: w.commute,
      isPrivate: w.isPrivate,
      gearId: w.gearId,
      hasStreams: workoutsWithStreams.has(w.id),
      plannedWorkoutId: w.plannedWorkoutId,
      linkedPlannedWorkout: (w as any).plannedWorkout
        ? {
            id: (w as any).plannedWorkout.id,
            title: (w as any).plannedWorkout.title,
            duration: (w as any).plannedWorkout.durationSec,
            durationSec: (w as any).plannedWorkout.durationSec,
            tss: (w as any).plannedWorkout.tss,
            type: (w as any).plannedWorkout.type
          }
        : null,
      originalId: w.id
    })
  }

  for (const p of plannedWorkouts) {
    if (completedPlannedIds.has(p.id)) continue
    let status = 'planned'
    if (p.completed) status = 'completed_plan'
    const workoutDate = new Date(p.date)
    workoutDate.setUTCHours(0, 0, 0, 0)
    const planDate = new Date(p.date)
    planDate.setUTCHours(0, 0, 0, 0)
    if (!p.completed && planDate < today) {
      status = p.type === 'Rest' ? 'completed_plan' : 'missed'
    }
    const dateKey = p.date.toISOString().split('T')[0] ?? ''
    if (!activitiesByDate.has(dateKey)) activitiesByDate.set(dateKey, [])
    activitiesByDate.get(dateKey)!.push({
      id: p.id,
      title: p.title,
      date: workoutDate.toISOString(),
      startTime: p.startTime,
      type: p.type || 'Workout',
      source: 'planned',
      status,
      duration: p.durationSec || 0,
      durationSec: p.durationSec || 0,
      distance: p.distanceMeters,
      tss: p.tss,
      intensity: p.workIntensity,
      plannedDuration: p.durationSec,
      plannedDistance: p.distanceMeters,
      plannedTss: p.tss,
      structuredWorkout: p.structuredWorkout
    })
  }

  for (const n of calendarNotes) {
    const displayEndDate = getCalendarNoteDisplayEndDate(n)
    const dateKey = n.startDate.toISOString().split('T')[0] ?? ''
    if (!activitiesByDate.has(dateKey)) activitiesByDate.set(dateKey, [])
    activitiesByDate.get(dateKey)!.push({
      id: n.id,
      title: n.title,
      date: n.startDate.toISOString(),
      endDate: n.endDate?.toISOString(),
      displayEndDate: displayEndDate?.toISOString() || null,
      isWeeklyNote: n.isWeeklyNote,
      type: n.type || 'Note',
      category: n.category,
      source: 'note',
      status: 'note',
      description: n.description
    })
  }

  const allDates = new Set([...wellnessByDate.keys(), ...nutritionByDate.keys()])
  for (const dateKey of allDates) {
    if (!activitiesByDate.has(dateKey)) {
      const date = new Date(dateKey)
      activitiesByDate.set(dateKey, [
        {
          id: dateKey,
          title: 'Wellness',
          date: date.toISOString(),
          type: 'wellness',
          source: 'wellness',
          status: 'completed'
        }
      ])
    }
  }

  const activities: any[] = []
  const daySummaries: Record<string, any> = {}
  for (const [dateKey, dateActivities] of activitiesByDate.entries()) {
    activities.push(...dateActivities)
    const planned = dateActivities.filter((a) => a.source === 'planned')
    const completed = dateActivities.filter((a) => a.source === 'completed')
    daySummaries[dateKey] = {
      readinessScore: wellnessByDate.get(dateKey)?.recoveryScore ?? null,
      readinessStatus:
        wellnessByDate.get(dateKey)?.recoveryScore >= 80
          ? 'high'
          : wellnessByDate.get(dateKey)?.recoveryScore >= 60
            ? 'moderate'
            : wellnessByDate.get(dateKey)?.recoveryScore != null
              ? 'low'
              : 'unknown',
      plannedCount: planned.length,
      completedCount: completed.length,
      plannedTss: planned.reduce((sum, item) => sum + Number(item.tss || item.plannedTss || 0), 0),
      completedTss: completed.reduce((sum, item) => sum + Number(item.tss || 0), 0)
    }
  }

  return {
    activities,
    nutritionByDate: Object.fromEntries(nutritionByDate),
    wellnessByDate: Object.fromEntries(wellnessByDate),
    daySummaries
  }
}
