import { defineEventHandler, getQuery, createError } from 'h3'
import { prisma } from '../../utils/db'
import { userRepository } from '../../utils/repositories/userRepository'
import { workoutRepository } from '../../utils/repositories/workoutRepository'
import { attachStreamsToWorkouts } from '../../utils/repositories/workoutStreamRepository'
import { sportSettingsRepository } from '../../utils/repositories/sportSettingsRepository'
import { calculatePowerZones, calculateHrZones } from '../../utils/zones'
import { getServerSession } from '../../utils/session'
import { getUserTimezone, getStartOfYearUTC, getUserLocalDate } from '../../utils/date'
import { parseTagQueryParam } from '../../utils/workout-tags'

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Get weekly zone distribution',
    description: 'Returns time spent in power and heart rate zones aggregated weekly.',
    inputSchema: [
      {
        name: 'weeks',
        in: 'query',
        schema: { type: ['integer', 'string'], default: 12 }
      },
      {
        name: 'sport',
        in: 'query',
        schema: { type: 'string' }
      },
      {
        name: 'tags',
        in: 'query',
        schema: { type: 'string' }
      }
    ]
  }
})

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  if (!session) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  const userId = (session.user as any).id
  const timezone = await getUserTimezone(userId)

  const query = getQuery(event)
  const sport = query.sport === 'all' ? undefined : (query.sport as string)
  const tags = parseTagQueryParam(query.tags)
  const endDate = getUserLocalDate(timezone)
  let startDate: Date
  let numWeeks: number

  if (query.weeks === 'YTD') {
    startDate = getStartOfYearUTC(timezone)
    // Calculate weeks since start of year
    const diffTime = Math.abs(endDate.getTime() - startDate.getTime())
    numWeeks = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 7))
  } else {
    numWeeks = parseInt(query.weeks as string) || 12
    startDate = getUserLocalDate(timezone)
    startDate.setUTCDate(startDate.getUTCDate() - numWeeks * 7)
  }

  // 1. Get user and sport settings
  const user = await userRepository.getById(userId)
  if (!user) {
    throw createError({ statusCode: 404, message: 'User not found' })
  }

  const allSportSettings = await sportSettingsRepository.getByUserId(userId)
  const defaultSettings = await sportSettingsRepository.getDefault(userId)

  // A stacked weekly chart needs every bucket to use the same boundaries. Using each
  // workout's profile while labeling with the default profile combines incomparable
  // zones (for example, running and cycling Z3) into the same bar segment.
  const displaySettings = sport
    ? allSportSettings.find(
        (setting: any) => !setting.isDefault && setting.types?.includes(sport)
      ) || defaultSettings
    : defaultSettings
  const displayFtp = displaySettings?.ftp || user.ftp || 200
  const displayLthr = displaySettings?.lthr || user.lthr || 160
  const displayMaxHr = displaySettings?.maxHr || user.maxHr || 190
  const powerZones =
    (displaySettings?.powerZones as any[])?.length > 0
      ? (displaySettings.powerZones as any[])
      : calculatePowerZones(displayFtp)
  const hrZones =
    (displaySettings?.hrZones as any[])?.length > 0
      ? (displaySettings.hrZones as any[])
      : calculateHrZones(displayLthr, displayMaxHr)

  // 2. Get workouts with streams
  //
  // CW-379: the `streams` relation is the legacy V1 table only, and stream
  // writes have gone to WorkoutStreamV2 for a while now -- selecting it here
  // silently returned zero zone time for every V2-only athlete. The repository
  // reads V2 first and falls back to V1, so both generations aggregate.
  const workoutRecords = await workoutRepository.getForUser(userId, {
    startDate,
    endDate,
    tags,
    where: sport ? { type: sport } : undefined,
    select: {
      id: true,
      date: true,
      ftp: true,
      type: true // Needed for sport matching
    }
  })

  // Only time/watts/heartrate are read below, all of which are in the
  // repository's mandatory baseline -- no optional columns needed.
  const workouts = await attachStreamsToWorkouts(workoutRecords, { baselineOnly: true })

  // 3. Initialize buckets
  const weeklyData = new Map<
    string,
    {
      weekStart: string
      powerZones: number[]
      hrZones: number[]
      totalDuration: number
    }
  >()

  // Pre-fill weeks to ensure gaps are shown
  for (let i = 0; i <= numWeeks; i++) {
    const d = new Date(startDate)
    d.setUTCDate(d.getUTCDate() + i * 7)

    const start = getWeekStart(d)
    const key = start.toISOString().split('T')[0]
    if (key) {
      weeklyData.set(key, {
        weekStart: key,
        powerZones: new Array(powerZones.length).fill(0),
        hrZones: new Array(hrZones.length).fill(0),
        totalDuration: 0
      })
    }
  }

  // 4. Aggregate
  for (const workoutRaw of workouts) {
    const workout = workoutRaw as any
    if (!workout.streams) continue

    const weekStart = getWeekStart(workout.date)
    const key = weekStart.toISOString().split('T')[0]
    if (!key) continue

    const bucket = weeklyData.get(key)
    if (!bucket) continue

    const streams = workout.streams
    const time = (streams.time as number[]) || []
    const watts = (streams.watts as number[]) || []
    const hr = (streams.heartrate as number[]) || []

    for (let i = 0; i < time.length; i++) {
      const currentTime = time[i]
      if (currentTime === undefined || currentTime === null) continue

      const prevTime = i === 0 ? currentTime : time[i - 1]
      const delta = i === 0 ? 0 : currentTime - (prevTime || 0)
      if (delta <= 0 || delta > 10) continue // Skip pauses

      bucket.totalDuration += delta

      const w = watts[i]
      if (w !== undefined && w !== null) {
        const zIndex = powerZones.findIndex((z: any) => w >= z.min && w <= z.max)
        if (zIndex !== -1 && bucket.powerZones[zIndex] !== undefined) {
          bucket.powerZones[zIndex] += delta
        }
      }

      const h = hr[i]
      if (h !== undefined && h !== null) {
        const zIndex = hrZones.findIndex((z: any) => h >= z.min && h <= z.max)
        if (zIndex !== -1 && bucket.hrZones[zIndex] !== undefined) {
          bucket.hrZones[zIndex] += delta
        }
      }
    }
  }

  // 5. Finalize results
  const result = Array.from(weeklyData.values())
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((w) => ({
      ...w,
      powerZones: w.powerZones.map((s) => Math.round((s / 3600) * 10) / 10),
      hrZones: w.hrZones.map((s) => Math.round((s / 3600) * 10) / 10),
      totalDuration: Math.round((w.totalDuration / 3600) * 10) / 10
    }))

  return {
    weeks: result,
    zoneLabels: {
      power: powerZones.map((z: any) => z.name),
      hr: hrZones.map((z: any) => z.name)
    }
  }
})

function getWeekStart(d: Date) {
  const date = new Date(d)
  const day = date.getUTCDay()
  const diff = date.getUTCDate() - day + (day === 0 ? -6 : 1) // adjust when day is sunday
  date.setUTCDate(diff)
  // setHours(0,0,0,0) is redundant for getUserLocalDate() dates but harmless if already UTC midnight
  date.setUTCHours(0, 0, 0, 0)
  return date
}
