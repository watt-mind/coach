import { requireAuth } from '../../utils/auth-guard'
import { getEffectiveUserId } from '../../utils/coaching'
import {
  getUserTimezone,
  getUserLocalDate,
  formatUserDate,
  formatDateUTC,
  getStartOfLocalDateUTC,
  getEndOfLocalDateUTC
} from '../../utils/date'
import { workoutRepository } from '../../utils/repositories/workoutRepository'
import { prisma } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event, ['workout:read'])
  const userId = await getEffectiveUserId(event)
  const timezone = await getUserTimezone(userId)

  const query = getQuery(event)
  const sport = query.sport === 'all' ? undefined : (query.sport as string)

  // 1. Determine local dates
  const nowLocal = getUserLocalDate(timezone)
  const currentYear = nowLocal.getUTCFullYear()
  const currentMonth = nowLocal.getUTCMonth()

  const startOfCurrentMonth = new Date(Date.UTC(currentYear, currentMonth, 1))
  const endOfCurrentMonth = new Date(Date.UTC(currentYear, currentMonth + 1, 0))

  const startOfLastMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1))
  const endOfLastMonth = new Date(Date.UTC(currentYear, currentMonth, 0))

  const currentMonthDateKeyStart = formatDateUTC(startOfCurrentMonth, 'yyyy-MM-dd')
  const currentMonthDateKeyEnd = formatDateUTC(endOfCurrentMonth, 'yyyy-MM-dd')
  const lastMonthDateKeyStart = formatDateUTC(startOfLastMonth, 'yyyy-MM-dd')
  const lastMonthDateKeyEnd = formatDateUTC(endOfLastMonth, 'yyyy-MM-dd')

  const startOfCurrentMonthUtc = getStartOfLocalDateUTC(timezone, currentMonthDateKeyStart)
  const endOfCurrentMonthUtc = getEndOfLocalDateUTC(timezone, currentMonthDateKeyEnd)
  const startOfLastMonthUtc = getStartOfLocalDateUTC(timezone, lastMonthDateKeyStart)
  const endOfLastMonthUtc = getEndOfLocalDateUTC(timezone, lastMonthDateKeyEnd)

  // 2. Fetch completed and planned workouts
  const [currentWorkouts, lastWorkouts, plannedWorkouts] = await Promise.all([
    workoutRepository.getForUser(userId, {
      startDate: startOfCurrentMonthUtc,
      endDate: endOfCurrentMonthUtc,
      includeDuplicates: false,
      where: sport ? { type: sport } : undefined,
      select: {
        date: true,
        tss: true,
        durationSec: true,
        distanceMeters: true,
        elevationGain: true
      }
    }),
    workoutRepository.getForUser(userId, {
      startDate: startOfLastMonthUtc,
      endDate: endOfLastMonthUtc,
      includeDuplicates: false,
      where: sport ? { type: sport } : undefined,
      select: {
        date: true,
        tss: true,
        durationSec: true,
        distanceMeters: true,
        elevationGain: true
      }
    }),
    prisma.plannedWorkout.findMany({
      where: {
        userId,
        date: {
          gte: startOfCurrentMonth,
          lte: endOfCurrentMonth
        },
        type: sport ? sport : undefined
      },
      select: {
        date: true,
        tss: true,
        durationSec: true,
        distanceMeters: true
      }
    })
  ])

  // 3. Process data
  const daysInCurrentMonth = new Date(currentYear, currentMonth + 1, 0).getDate()
  const daysInLastMonth = new Date(currentYear, currentMonth, 0).getDate()

  const processWorkouts = (workouts: any[], isPlanned = false) => {
    const daily: Record<number, any> = {}
    for (let i = 1; i <= 31; i++) {
      daily[i] = { tss: 0, duration: 0, distance: 0, elevation: 0, count: 0 }
    }

    workouts.forEach((w) => {
      // Planned dates are calendar carriers; completed dates are timestamps.
      const localDay = parseInt(
        isPlanned ? formatDateUTC(w.date, 'd') : formatUserDate(w.date, timezone, 'd')
      )
      if (daily[localDay]) {
        daily[localDay].tss += w.tss || 0
        daily[localDay].duration += (w.durationSec || 0) / 3600
        daily[localDay].distance += (w.distanceMeters || 0) / 1000
        if (!isPlanned) {
          daily[localDay].elevation += w.elevationGain || 0
          daily[localDay].count += 1
        } else {
          daily[localDay].count += 1
        }
      }
    })
    return daily
  }

  const currentDaily = processWorkouts(currentWorkouts)
  const lastDaily = processWorkouts(lastWorkouts)
  const plannedDaily = processWorkouts(plannedWorkouts, true)

  const calculateCumulative = (daily: Record<number, any>, limitDay?: number) => {
    const cumulative: Record<number, any> = {}
    let runningTss = 0
    let runningDuration = 0
    let runningDistance = 0
    let runningElevation = 0
    let runningCount = 0

    for (let i = 1; i <= 31; i++) {
      if (limitDay && i > limitDay) {
        cumulative[i] = null
        continue
      }

      runningTss += daily[i].tss
      runningDuration += daily[i].duration
      runningDistance += daily[i].distance
      runningElevation += daily[i].elevation
      runningCount += daily[i].count

      cumulative[i] = {
        tss: runningTss,
        duration: runningDuration,
        distance: runningDistance,
        elevation: runningElevation,
        count: runningCount
      }
    }
    return cumulative
  }

  const todayDay = nowLocal.getUTCDate()

  return {
    currentMonth: {
      name: formatDateUTC(startOfCurrentMonth, 'MMMM'),
      days: daysInCurrentMonth,
      daily: currentDaily,
      plannedDaily: plannedDaily,
      cumulative: calculateCumulative(currentDaily, todayDay),
      plannedCumulative: calculateCumulative(plannedDaily) // Planned shows full month
    },
    lastMonth: {
      name: formatDateUTC(startOfLastMonth, 'MMMM'),
      days: daysInLastMonth,
      daily: lastDaily,
      cumulative: calculateCumulative(lastDaily)
    },
    todayDay,
    timezone
  }
})
