import { requireAuth } from '../../../../utils/auth-guard'
import { attachStreamsToWorkouts } from '../../../../utils/repositories/workoutStreamRepository'

const LOOKBACK_DAYS_DEFAULT = 56
const LOOKBACK_DAYS_MAX = 180
const FTP_TEST_DURATION_SEC = 20 * 60
const LTHR_TEST_DURATION_SEC = 20 * 60
const THRESHOLD_PACE_DURATION_SEC = 40 * 60

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => Number(v)).filter((v) => Number.isFinite(v))
}

function alignSeries(time: unknown, values: unknown): { time: number[]; values: number[] } {
  const t = toNumberArray(time)
  const v = toNumberArray(values)
  const len = Math.min(t.length, v.length)
  if (len < 2) return { time: [], values: [] }
  return {
    time: t.slice(0, len),
    values: v.slice(0, len)
  }
}

function findPeakAverage(
  time: number[],
  values: number[],
  durationSec: number
): { average: number; start: number; end: number } | null {
  if (time.length < 2 || values.length < 2) return null

  let startPtr = 0
  let windowSum = 0
  let windowCount = 0

  let bestAverage = -Infinity
  let bestStart = -1
  let bestEnd = -1

  for (let endPtr = 0; endPtr < values.length; endPtr++) {
    const endValue = values[endPtr]
    if (endValue === undefined) continue
    windowSum += endValue
    windowCount++

    while (startPtr < endPtr) {
      const endTime = time[endPtr]
      const startTime = time[startPtr]
      if (endTime === undefined || startTime === undefined) break
      if (endTime - startTime <= durationSec) break

      const startValue = values[startPtr]
      if (startValue !== undefined) {
        windowSum -= startValue
        windowCount--
      }
      startPtr++
    }

    const endTime = time[endPtr]
    const startTime = time[startPtr]
    if (
      endTime === undefined ||
      startTime === undefined ||
      windowCount <= 0 ||
      endTime - startTime < durationSec * 0.9
    ) {
      continue
    }

    const avg = windowSum / windowCount
    if (avg > bestAverage) {
      bestAverage = avg
      bestStart = startPtr
      bestEnd = endPtr
    }
  }

  if (!Number.isFinite(bestAverage) || bestStart < 0 || bestEnd < 0) return null
  return {
    average: bestAverage,
    start: time[bestStart] || 0,
    end: time[bestEnd] || durationSec
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function buildConfidence(options: {
  matchingWorkouts: number
  durationSec: number
  streamCoverage: number
}) {
  const { matchingWorkouts, durationSec, streamCoverage } = options
  let confidence = 0.5

  if (matchingWorkouts >= 8) confidence += 0.2
  else if (matchingWorkouts >= 4) confidence += 0.12
  else if (matchingWorkouts >= 2) confidence += 0.06

  if (durationSec >= 70 * 60) confidence += 0.1
  else if (durationSec >= 50 * 60) confidence += 0.06

  confidence += clamp(streamCoverage, 0, 1) * 0.15

  return Number(clamp(confidence, 0.5, 0.95).toFixed(2))
}

function paceMpsToSecPerKm(paceMps: number) {
  if (!paceMps || paceMps <= 0) return null
  return 1000 / paceMps
}

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event, ['profile:write'])

  const sportSettingId = getRouterParam(event, 'id')
  if (!sportSettingId) {
    throw createError({ statusCode: 400, statusMessage: 'Sport setting ID is required' })
  }

  const query = getQuery(event)
  const rawLookback = Number(query.lookbackDays)
  const lookbackDays = Number.isFinite(rawLookback)
    ? Math.round(clamp(rawLookback, 7, LOOKBACK_DAYS_MAX))
    : LOOKBACK_DAYS_DEFAULT

  const sportSetting = await prisma.sportSettings.findFirst({
    where: {
      id: sportSettingId,
      userId: user.id
    },
    select: {
      id: true,
      name: true,
      types: true,
      ftp: true,
      lthr: true,
      maxHr: true,
      thresholdPace: true,
      zoneConfiguration: true
    }
  })

  if (!sportSetting) {
    throw createError({ statusCode: 404, statusMessage: 'Sport profile not found' })
  }

  const fromDate = new Date()
  fromDate.setUTCDate(fromDate.getUTCDate() - lookbackDays)

  const workoutTypeFilter = Array.isArray(sportSetting.types) && sportSetting.types.length > 0
  const workoutRecords = await prisma.workout.findMany({
    where: {
      userId: user.id,
      isDuplicate: false,
      date: { gte: fromDate },
      ...(workoutTypeFilter ? { type: { in: sportSetting.types } } : {})
    },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      title: true,
      date: true,
      type: true,
      durationSec: true,
      maxHr: true
    },
    take: 200
  })

  // CW-379: selecting the `streams` relation only reads the legacy V1 table,
  // so FTP/LTHR/threshold-pace autodetection reported "no stream data found"
  // for every athlete whose series are in WorkoutStreamV2.
  // time/watts/heartrate/velocity are all in the repository's mandatory
  // baseline, so no optional columns are pulled across 200 workouts.
  const workouts = await attachStreamsToWorkouts(workoutRecords, { baselineOnly: true })

  const ftpCandidates: any[] = []
  const lthrCandidates: any[] = []
  const maxHrCandidates: any[] = []
  const paceCandidates: any[] = []

  let powerStreamCount = 0
  let hrStreamCount = 0
  let paceStreamCount = 0

  for (const workout of workouts) {
    if (!workout.streams) continue

    const powerSeries = alignSeries(workout.streams.time, workout.streams.watts)
    if (powerSeries.time.length > 0) {
      powerStreamCount++
      const peak20mPower = findPeakAverage(
        powerSeries.time,
        powerSeries.values,
        FTP_TEST_DURATION_SEC
      )
      if (peak20mPower) {
        ftpCandidates.push({
          estimate: Math.round(peak20mPower.average * 0.95),
          workout,
          peak: peak20mPower.average,
          durationSec: peak20mPower.end - peak20mPower.start
        })
      }
    }

    const hrSeries = alignSeries(workout.streams.time, workout.streams.heartrate)
    if (hrSeries.time.length > 0) {
      hrStreamCount++
      const peak20mHr = findPeakAverage(hrSeries.time, hrSeries.values, LTHR_TEST_DURATION_SEC)
      if (peak20mHr) {
        lthrCandidates.push({
          estimate: Math.round(peak20mHr.average * 0.95),
          workout,
          peak: peak20mHr.average,
          durationSec: peak20mHr.end - peak20mHr.start
        })
      }

      const workoutMaxHr = Math.round(Math.max(...hrSeries.values))
      if (Number.isFinite(workoutMaxHr) && workoutMaxHr > 0) {
        maxHrCandidates.push({
          estimate: workoutMaxHr,
          workout,
          peak: workoutMaxHr,
          durationSec: workout.durationSec
        })
      }
    } else if (workout.maxHr && workout.maxHr > 0) {
      maxHrCandidates.push({
        estimate: workout.maxHr,
        workout,
        peak: workout.maxHr,
        durationSec: workout.durationSec
      })
    }

    const isRunWorkout = (workout.type || '').toLowerCase().includes('run')
    if (!isRunWorkout) continue

    const paceSeries = alignSeries(workout.streams.time, workout.streams.velocity)
    if (paceSeries.time.length === 0) continue

    paceStreamCount++
    const peak40mPace = findPeakAverage(
      paceSeries.time,
      paceSeries.values,
      THRESHOLD_PACE_DURATION_SEC
    )
    if (!peak40mPace) continue

    paceCandidates.push({
      estimate: Number(peak40mPace.average.toFixed(3)),
      workout,
      peak: peak40mPace.average,
      durationSec: peak40mPace.end - peak40mPace.start
    })
  }

  const bestFtp = ftpCandidates.sort((a, b) => b.estimate - a.estimate)[0]
  const bestLthr = lthrCandidates.sort((a, b) => b.estimate - a.estimate)[0]
  const bestMaxHr = maxHrCandidates.sort((a, b) => b.estimate - a.estimate)[0]
  const bestPace = paceCandidates.sort((a, b) => b.estimate - a.estimate)[0]

  const detections = {
    ftp: {
      available: Boolean(bestFtp),
      detected: Boolean(bestFtp && (!sportSetting.ftp || bestFtp.estimate > sportSetting.ftp)),
      oldValue: sportSetting.ftp,
      newValue: bestFtp?.estimate || null,
      confidence: bestFtp
        ? buildConfidence({
            matchingWorkouts: workouts.length,
            durationSec: bestFtp.workout.durationSec,
            streamCoverage: workouts.length > 0 ? powerStreamCount / workouts.length : 0
          })
        : null,
      source: bestFtp
        ? {
            workoutId: bestFtp.workout.id,
            workoutTitle: bestFtp.workout.title,
            workoutDate: bestFtp.workout.date,
            peakAverage: Number(bestFtp.peak.toFixed(1)),
            peakDurationSec: Math.round(bestFtp.durationSec)
          }
        : null,
      reason: bestFtp ? null : 'No suitable 20-minute power efforts found in the lookback window.'
    },
    lthr: {
      available: Boolean(bestLthr),
      detected: Boolean(bestLthr && (!sportSetting.lthr || bestLthr.estimate > sportSetting.lthr)),
      oldValue: sportSetting.lthr,
      newValue: bestLthr?.estimate || null,
      confidence: bestLthr
        ? buildConfidence({
            matchingWorkouts: workouts.length,
            durationSec: bestLthr.workout.durationSec,
            streamCoverage: workouts.length > 0 ? hrStreamCount / workouts.length : 0
          })
        : null,
      source: bestLthr
        ? {
            workoutId: bestLthr.workout.id,
            workoutTitle: bestLthr.workout.title,
            workoutDate: bestLthr.workout.date,
            peakAverage: Number(bestLthr.peak.toFixed(1)),
            peakDurationSec: Math.round(bestLthr.durationSec)
          }
        : null,
      reason: bestLthr
        ? null
        : 'No suitable 20-minute heart-rate efforts found in the lookback window.'
    },
    maxHr: {
      available: Boolean(bestMaxHr),
      detected: Boolean(
        bestMaxHr && (!sportSetting.maxHr || bestMaxHr.estimate > (sportSetting.maxHr || 0))
      ),
      oldValue: sportSetting.maxHr,
      newValue: bestMaxHr?.estimate || null,
      confidence: bestMaxHr
        ? buildConfidence({
            matchingWorkouts: workouts.length,
            durationSec: bestMaxHr.workout.durationSec,
            streamCoverage: workouts.length > 0 ? hrStreamCount / workouts.length : 0.4
          })
        : null,
      source: bestMaxHr
        ? {
            workoutId: bestMaxHr.workout.id,
            workoutTitle: bestMaxHr.workout.title,
            workoutDate: bestMaxHr.workout.date,
            peakAverage: bestMaxHr.peak,
            peakDurationSec: Math.round(bestMaxHr.durationSec)
          }
        : null,
      reason: bestMaxHr ? null : 'No heart-rate data found in workouts for this sport profile.'
    },
    thresholdPace: (() => {
      if (!bestPace) {
        return {
          available: false,
          detected: false,
          oldValue: sportSetting.thresholdPace,
          newValue: null,
          confidence: null,
          source: null,
          reason: 'No suitable 40-minute run pace efforts found in the lookback window.'
        }
      }

      const oldPaceMps = sportSetting.thresholdPace || null
      const oldSecPerKm = oldPaceMps ? paceMpsToSecPerKm(oldPaceMps) : null
      const newSecPerKm = paceMpsToSecPerKm(bestPace.estimate)

      const improvedBySecPerKm =
        oldSecPerKm && newSecPerKm ? Number((oldSecPerKm - newSecPerKm).toFixed(1)) : null

      const detected = !oldPaceMps || (improvedBySecPerKm !== null && improvedBySecPerKm >= 2)

      return {
        available: true,
        detected,
        oldValue: oldPaceMps,
        newValue: bestPace.estimate,
        confidence: buildConfidence({
          matchingWorkouts: workouts.length,
          durationSec: bestPace.workout.durationSec,
          streamCoverage: workouts.length > 0 ? paceStreamCount / workouts.length : 0
        }),
        source: {
          workoutId: bestPace.workout.id,
          workoutTitle: bestPace.workout.title,
          workoutDate: bestPace.workout.date,
          peakAverage: Number(bestPace.peak.toFixed(3)),
          peakDurationSec: Math.round(bestPace.durationSec),
          improvedBySecPerKm
        },
        reason: null
      }
    })()
  }

  const detectedAny = Object.values(detections).some((d: any) => d.detected)

  return {
    success: true,
    sportSetting: {
      id: sportSetting.id,
      name: sportSetting.name,
      types: sportSetting.types,
      paceDisplayUnit: (sportSetting.zoneConfiguration as any)?.paceDisplayUnit || null
    },
    lookbackDays,
    workoutsAnalyzed: workouts.length,
    detectedAny,
    detections
  }
})
