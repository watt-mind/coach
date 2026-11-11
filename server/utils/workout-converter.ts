import { create } from 'xmlbuilder2'
import { FitWriter } from '@markw65/fit-file-writer'
import { normalizeTargetPolicy } from './workout-target-policy'

interface WorkoutStep {
  type: 'Warmup' | 'Active' | 'Rest' | 'Cooldown'
  durationSeconds?: number
  duration?: number
  distance?: number
  power?: {
    value?: number
    range?: { start: number; end: number }
    ramp?: boolean
    units?: string
  }
  heartRate?: {
    value?: number
    range?: { start: number; end: number }
    ramp?: boolean
    units?: string
  }
  pace?: {
    value?: number
    range?: { start: number; end: number }
    ramp?: boolean
    units?: string
  }
  rpe?: number
  cadence?: number
  name?: string
  steps?: WorkoutStep[]
  reps?: number
}

interface WorkoutMessage {
  timestamp: number
  text: string
  duration?: number
}

interface WorkoutData {
  title: string
  description: string
  type?: string
  author?: string
  steps: WorkoutStep[]
  exercises?: any[]
  messages?: WorkoutMessage[]
  ftp?: number // Optional, for calculating absolute watts if needed
  sportSettings?: {
    loadPreference?: string | null
    targetPolicy?: any
    intervalsHrRangeTolerancePct?: number | null
    lthr?: number | null
    hrZones?: Array<{ name?: string; min?: number; max?: number }> | null
    thresholdPace?: number | null
    paceZones?: Array<{ name?: string; min?: number; max?: number }> | null
  }
  generationSettingsSnapshot?: {
    loadPreference?: string | null
    targetPolicy?: any
    thresholds?: {
      lthr?: number | null
      thresholdPace?: number | null
    } | null
    zones?: {
      heartRate?: Array<{ name?: string; min?: number; max?: number }> | null
      pace?: Array<{ name?: string; min?: number; max?: number }> | null
    } | null
  } | null
}

// Download formats express power either as FTP fractions or absolute watts.
// Keep relative targets (including legacy omitted units) in their existing representation.
function downloadPower(power: WorkoutStep['power'], ftp: number, absolute: boolean) {
  const target = power || { value: 0 }
  const inWatts = target.units === 'w' || target.units === 'watts'
  const convert = (value: number) =>
    absolute ? (inWatts ? value : value * ftp) : inWatts ? value / ftp : value
  return {
    ...target,
    value: convert(target.value ?? 0),
    range: target.range
      ? { start: convert(target.range.start ?? 0), end: convert(target.range.end ?? 0) }
      : undefined
  }
}

export const WorkoutConverter = {
  toZWO(workout: WorkoutData): string {
    const root = create({ version: '1.0', encoding: 'UTF-8' })
      .ele('workout_file')
      .ele('author')
      .txt(workout.author || 'Coach Wattz')
      .up()
      .ele('name')
      .txt(workout.title)
      .up()
      .ele('description')
      .txt(workout.description)
      .up()
      .ele('sportType')
      .txt('bike')
      .up()
      .ele('tags')
      .up()
      .ele('workout')

    workout.steps.forEach((step) => {
      // Safely access power
      const power = downloadPower(step.power, workout.ftp || 250, false)
      const duration = step.durationSeconds || step.duration || 0
      const isRamp = power.ramp === true

      // If we only have Heart Rate, ZWO is not the best format but we can try to approximate or just use 0 power
      // Zwift is primarily power-based.

      // ZWO uses percentage of FTP (0.0 - 1.0+)
      if (power.range) {
        const tagName = isRamp
          ? step.type === 'Warmup'
            ? 'Warmup'
            : step.type === 'Cooldown'
              ? 'Cooldown'
              : 'Ramp'
          : 'SteadyState'
        const el = root.ele(tagName)
        el.att('Duration', String(duration))
        el.att('PowerLow', String(power.range.start ?? 0))
        el.att('PowerHigh', String(power.range.end ?? 0))

        if (step.cadence) el.att('Cadence', String(step.cadence))
        if (step.name) el.att('Text', step.name)
        el.up()
      } else {
        // Steady State
        const el = root
          .ele('SteadyState')
          .att('Duration', String(duration))
          .att('Power', String(power.value || 0))

        if (step.cadence) el.att('Cadence', String(step.cadence))
        if (step.name) el.att('Text', step.name) // Zwift displays this on screen
        el.up()
      }
    })

    if (workout.messages) {
      workout.messages.forEach((msg) => {
        root
          .ele('textEvent')
          .att('timeoffset', String(msg.timestamp))
          .att('message', msg.text)
          .att('duration', String(msg.duration || 10))
          .up()
      })
    }

    return root.end({ prettyPrint: true })
  },

  toFIT(workout: WorkoutData): Uint8Array {
    const fitWriter = new FitWriter()

    // FIT Epoch: Dec 31, 1989 00:00:00 UTC
    const toFitTimestamp = (date: Date) => Math.round(date.getTime() / 1000) - 631065600

    // 1. File ID
    fitWriter.writeMessage('file_id', {
      type: 'workout',
      manufacturer: 'garmin',
      product: 0,
      serial_number: 0,
      time_created: toFitTimestamp(new Date()),
      number: 0,
      product_name: 'Coach Wattz'
    })

    // 2. Workout Message
    fitWriter.writeMessage('workout', {
      wkt_name: workout.title.substring(0, 15), // Max chars often limited
      sport: 'cycling',
      sub_sport: 'generic',
      num_valid_steps: workout.steps.length
    })

    // 3. Workout Steps
    workout.steps.forEach((step, index) => {
      // Safely access power
      const power = downloadPower(step.power, workout.ftp || 250, true)
      const isRamp = !!power.range

      // Target Value: Power
      // 1000 = 100% FTP?
      // According to FIT SDK, 'power' steps typically use:
      // target_type: 'power_3s' or 'power_10s' or 'power_30s' or 'power_lap'
      // BUT for workout steps, we define intensity target.
      // target_type: 0 (speed), 1 (heart_rate), 2 (open), 3 (cadence), 4 (power)

      let targetType: 'power' | 'heart_rate' | 'open' = 'power' // 4
      let customTargetValueLow = 0
      let customTargetValueHigh = 0

      // Check if HR based
      if (!power.value && !power.range && step.heartRate) {
        // targetType = 'heart_rate'; // 1

        // HR values are typically BPM in FIT files, or % max HR?
        // FIT SDK usually expects BPM for absolute values.
        // But we store % LTHR.
        // We'd need the user's LTHR to convert to BPM.
        // Or we use zone numbers (1-5).

        // For now, let's assume we can't easily export HR targets without knowing absolute BPM zones reliably here.
        // We'll skip complex HR export logic for FIT for now or use open targets.
        targetType = 'open' // 2
      } else {
        // Power has already been converted to absolute watts.
        if (isRamp && power.range) {
          customTargetValueLow = Math.round(power.range.start ?? 0)
          customTargetValueHigh = Math.round(power.range.end ?? 0)
        } else {
          // Steady: Low and High define the zone window.
          // Usually target - 5% to target + 5%
          const val = power.value || 0
          customTargetValueLow = val === 0 ? 0 : Math.round(val - 10)
          customTargetValueHigh = val === 0 ? 0 : Math.round(val + 10)
        }
      }

      fitWriter.writeMessage('workout_step', {
        message_index: { value: index },
        wkt_step_name: step.name ? step.name.substring(0, 15) : undefined,
        duration_type: 'time', // 0
        duration_value: (step.durationSeconds || step.duration || 0) * 1000, // ms
        target_type: targetType,
        // Let's use raw Watts.
        custom_target_value_low: customTargetValueLow,
        custom_target_value_high: customTargetValueHigh,

        intensity:
          step.type === 'Active'
            ? 'active'
            : step.type === 'Rest'
              ? 'rest'
              : step.type === 'Warmup'
                ? 'warmup'
                : 'cooldown'
      })
    })

    const result = fitWriter.finish()
    // Convert DataView to Uint8Array to satisfy response requirements
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
  },

  toMRC(workout: WorkoutData): string {
    const lines: string[] = []
    lines.push('[COURSE HEADER]')
    lines.push('VERSION = 2')
    lines.push('UNITS = ENGLISH')
    lines.push(`DESCRIPTION = ${workout.description.replace(/[\r\n]+/g, ' ')}`)
    lines.push(`FILE NAME = ${workout.title}`)
    lines.push('MINUTES PERCENT')
    lines.push('[END COURSE HEADER]')
    lines.push('[COURSE DATA]')

    let currentTime = 0

    workout.steps.forEach((step) => {
      const durationMins = (step.durationSeconds || step.duration || 0) / 60
      const endTime = currentTime + durationMins

      // Safely access power
      const power = downloadPower(step.power, workout.ftp || 250, false)

      // Calculate start and end power as percentage (0-100)
      let startPercent: number
      let endPercent: number

      if (power.range) {
        startPercent = (power.range.start ?? 0) * 100
        endPercent = (power.range.end ?? 0) * 100
      } else {
        startPercent = (power.value || 0) * 100
        endPercent = startPercent
      }

      // Add points
      // Format: Time(min) Value(%)
      lines.push(`${currentTime.toFixed(2)}	${startPercent.toFixed(0)}`)
      lines.push(`${endTime.toFixed(2)}	${endPercent.toFixed(0)}`)

      currentTime = endTime
    })

    lines.push('[END COURSE DATA]')
    return lines.join('\r\n')
  },

  toERG(workout: WorkoutData): string {
    const lines: string[] = []
    const ftp = workout.ftp || 250 // Fallback FTP

    lines.push('[COURSE HEADER]')
    lines.push('VERSION = 2')
    lines.push('UNITS = ENGLISH') // ERG standard often uses ENGLISH even for metric users, refers to formatting
    lines.push(`DESCRIPTION = ${workout.description.replace(/[\r\n]+/g, ' ')}`)
    lines.push(`FILE NAME = ${workout.title}`)
    lines.push(`FTP = ${ftp}`)
    lines.push('MINUTES WATTS')
    lines.push('[END COURSE HEADER]')
    lines.push('[COURSE DATA]')

    let currentTime = 0

    workout.steps.forEach((step) => {
      const durationMins = (step.durationSeconds || step.duration || 0) / 60
      const endTime = currentTime + durationMins

      // Safely access power
      const power = downloadPower(step.power, ftp, true)

      // Calculate start and end power in Watts
      let startWatts: number
      let endWatts: number

      if (power.range) {
        startWatts = power.range.start ?? 0
        endWatts = power.range.end ?? 0
      } else {
        startWatts = power.value || 0
        endWatts = startWatts
      }

      // Add points
      lines.push(`${currentTime.toFixed(2)}	${Math.round(startWatts)}`)
      lines.push(`${endTime.toFixed(2)}	${Math.round(endWatts)}`)

      currentTime = endTime
    })

    lines.push('[END COURSE DATA]')
    return lines.join('\r\n')
  },

  toIntervalsICU(workout: WorkoutData): string {
    const lines: string[] = []
    const hrZonesRaw =
      workout.generationSettingsSnapshot?.zones?.heartRate || workout.sportSettings?.hrZones || []
    const hrZones = (Array.isArray(hrZonesRaw) ? hrZonesRaw : [])
      .map((zone: any, index: number) => ({
        index: index + 1,
        min: Number(zone?.min),
        max: Number(zone?.max)
      }))
      .filter((zone) => Number.isFinite(zone.min) && Number.isFinite(zone.max))
    const lthrRef = Number(
      workout.generationSettingsSnapshot?.thresholds?.lthr || workout.sportSettings?.lthr || 0
    )
    const bpmToLthrPct = (bpm: number) => {
      if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(lthrRef) || lthrRef <= 0)
        return null
      return Math.round((bpm / lthrRef) * 100)
    }
    const zoneForBpm = (bpm: number) => {
      if (!Number.isFinite(bpm) || hrZones.length === 0) return null
      const exact = hrZones.find((zone) => bpm >= zone.min && bpm <= zone.max)
      if (exact) return exact.index

      // If BPM is outside explicit bounds, choose the closest zone by midpoint.
      const closest = hrZones.reduce(
        (best, zone) => {
          const midpoint = (zone.min + zone.max) / 2
          const distance = Math.abs(midpoint - bpm)
          if (!best || distance < best.distance) return { index: zone.index, distance }
          return best
        },
        null as { index: number; distance: number } | null
      )
      return closest?.index || null
    }
    const formatHrZoneFromBpm = (start: number, end?: number) => {
      if (end !== undefined) {
        // Keep export consistent with the UI "Zone" column: classify by midpoint.
        const midpointZone = zoneForBpm((start + end) / 2)
        if (midpointZone) return `Z${midpointZone} HR`
      } else {
        const singleZone = zoneForBpm(start)
        if (singleZone) return `Z${singleZone} HR`
      }

      // No zones available: fallback to %LTHR instead of BPM for Intervals text.
      const startPct = bpmToLthrPct(start)
      const endPct = end !== undefined ? bpmToLthrPct(end) : startPct
      if (startPct && endPct) {
        return startPct === endPct ? `${startPct}% LTHR` : `${startPct}-${endPct}% LTHR`
      }
      return 'HR'
    }
    const normalizeUnits = (units: unknown): string | undefined => {
      if (typeof units !== 'string') return undefined
      const v = units.trim().toLowerCase()
      return v || undefined
    }
    const normalizeTarget = (
      target: any
    ): {
      value?: number
      range?: { start: number; end: number }
      ramp?: boolean
      units?: string
    } | null => {
      if (target === null || target === undefined) return null

      if (Array.isArray(target)) {
        if (target.length >= 2) {
          return { range: { start: Number(target[0]) || 0, end: Number(target[1]) || 0 } }
        }
        if (target.length === 1) {
          return { value: Number(target[0]) || 0 }
        }
        return null
      }

      if (typeof target === 'number') {
        return { value: target }
      }

      if (typeof target === 'object') {
        if (target.range && typeof target.range === 'object') {
          return {
            range: {
              start: Number(target.range.start) || 0,
              end: Number(target.range.end) || 0
            },
            ramp: target.ramp === true,
            units: normalizeUnits(target.units ?? target.range.units)
          }
        }
        if (target.start !== undefined && target.end !== undefined) {
          return {
            range: {
              start: Number(target.start) || 0,
              end: Number(target.end) || 0
            },
            ramp: target.ramp === true,
            units: normalizeUnits(target.units)
          }
        }
        if (target.value !== undefined) {
          return { value: Number(target.value) || 0, units: normalizeUnits(target.units) }
        }
      }

      return null
    }
    const toDurationToken = (seconds: number) => {
      if (seconds <= 0) return ''
      if (seconds % 3600 === 0) return `${seconds / 3600}h`
      if (seconds >= 3600 && seconds % 60 === 0) {
        const hours = Math.floor(seconds / 3600)
        const minutes = (seconds % 3600) / 60
        return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
      }
      if (seconds % 60 === 0) return `${seconds / 60}m`
      return `${seconds}s`
    }
    const toDistanceToken = (meters?: number) => {
      if (!meters || meters <= 0) return ''
      if (meters % 1000 === 0) return `${meters / 1000}km`
      return `${meters}mtr`
    }
    const toValuePct = (value: number) => {
      if (!Number.isFinite(value)) return 0
      return value <= 3 ? Math.round(value * 100) : Math.round(value)
    }
    const toRangePct = (start: number, end: number) => ({
      start: toValuePct(start),
      end: toValuePct(end)
    })
    const paceZones =
      workout.generationSettingsSnapshot?.zones?.pace || workout.sportSettings?.paceZones || []
    const thresholdPace =
      Number(
        workout.generationSettingsSnapshot?.thresholds?.thresholdPace ||
          workout.sportSettings?.thresholdPace ||
          0
      ) || 0
    const getPaceZoneBoundsByIndex = (indexRaw: number) => {
      const index = Math.max(1, Math.round(indexRaw))
      const zone = Array.isArray(paceZones) ? paceZones[index - 1] : null
      if (zone && Number.isFinite(Number(zone.min)) && Number.isFinite(Number(zone.max))) {
        return { start: Number(zone.min), end: Number(zone.max) }
      }
      return null
    }
    const paceValueToMps = (value: number, units?: string) => {
      if (!Number.isFinite(value) || value <= 0) return null
      const normalizedUnits = String(units || '')
        .trim()
        .toLowerCase()
      if (normalizedUnits.includes('/')) {
        const secondsPerKm = value * 60
        return secondsPerKm > 0 ? 1000 / secondsPerKm : null
      }
      if (normalizedUnits === 'm/s') return value
      if (value > 1.5 && value < 8) return value
      if (thresholdPace > 0) {
        if (value > 3) return value / thresholdPace
        return value * thresholdPace
      }
      return null
    }
    const paceTargetToZoneLabel = (target: {
      value?: number
      range?: { start: number; end: number }
      units?: string
    }) => {
      const epsilon = 1e-6
      const units = String(target.units || '')
        .trim()
        .toLowerCase()
      if (units === 'pace_zone' || units === 'zone') {
        const zoneValue =
          typeof target.value === 'number'
            ? Math.round(target.value)
            : target.range
              ? Math.round((target.range.start + target.range.end) / 2)
              : null
        return zoneValue ? `Z${zoneValue} Pace` : null
      }

      if (units === 'm/s' && target.range && Array.isArray(paceZones) && paceZones.length > 0) {
        const directZoneIdx = paceZones.findIndex((zone: any) => {
          const min = Number(zone?.min)
          const max = Number(zone?.max)
          return (
            Number.isFinite(min) &&
            Number.isFinite(max) &&
            Math.abs(target.range!.start - min) <= epsilon &&
            Math.abs(target.range!.end - max) <= epsilon
          )
        })
        if (directZoneIdx >= 0) return `Z${directZoneIdx + 1} Pace`
      }

      const midpoint = target.range
        ? (target.range.start + target.range.end) / 2
        : typeof target.value === 'number'
          ? target.value
          : null
      if (midpoint === null) return null
      const speedMps = paceValueToMps(midpoint, target.units)
      if (speedMps === null || !Array.isArray(paceZones) || paceZones.length === 0) return null
      const zoneIdx = paceZones.findIndex((zone: any) => {
        const min = Number(zone?.min)
        const max = Number(zone?.max)
        return Number.isFinite(min) && Number.isFinite(max) && speedMps >= min && speedMps <= max
      })
      return zoneIdx >= 0 ? `Z${zoneIdx + 1} Pace` : null
    }
    const formatMetric = (
      target: {
        value?: number
        range?: { start: number; end: number }
        ramp?: boolean
        units?: string
      } | null,
      kind: 'power' | 'hr' | 'pace'
    ) => {
      if (!target) return ''
      const units = target.units?.toLowerCase()
      const isHrZoneUnit = units === 'hr_zone' || units === 'zone'
      const inferredPowerUnits = (() => {
        if (kind !== 'power' || units) return units
        const values: number[] = []
        if (typeof target.value === 'number') values.push(target.value)
        if (typeof target.range?.start === 'number') values.push(target.range.start)
        if (typeof target.range?.end === 'number') values.push(target.range.end)
        if (values.length === 0) return units
        const maxAbs = Math.max(...values.map((v) => Math.abs(v)))
        return maxAbs > 3 ? 'w' : units
      })()
      const hrLabel = units === 'hr' || units === 'maxhr' ? 'HR' : 'LTHR'

      const formatValue = (value: number) => {
        if (!Number.isFinite(value)) return ''
        if (kind === 'power') {
          if (inferredPowerUnits === 'power_zone') return `Z${Math.round(value)}`
          if (inferredPowerUnits === 'w' || inferredPowerUnits === 'watts')
            return `${Math.round(value)}w`
          if (inferredPowerUnits?.startsWith('z')) return inferredPowerUnits.toUpperCase()
          return `${toValuePct(value)}%`
        }
        if (kind === 'hr') {
          if (units === 'bpm') return formatHrZoneFromBpm(Math.round(value))
          if (isHrZoneUnit) return `Z${Math.max(1, Math.round(value))} HR`
          return `${toValuePct(value)}% ${hrLabel}`
        }
        if (kind === 'pace') {
          const zoneLabel = paceTargetToZoneLabel(target)
          if (zoneLabel) return zoneLabel
          const paceMps = paceValueToMps(value, target.units)
          if (String(units || '').includes('/')) return `${value}${units}`
          if (paceMps !== null && String(units || '') === 'm/s') return `${value.toFixed(2)} m/s`
        }
        if (units && units.includes('/')) return `${value}${units}`
        return `${toValuePct(value)}% Pace`
      }

      const formatRange = (start: number, end: number) => {
        if (kind === 'power') {
          if (inferredPowerUnits === 'power_zone') return `Z${Math.round(start)}-${Math.round(end)}`
          if (inferredPowerUnits === 'w' || inferredPowerUnits === 'watts')
            return `${Math.round(start)}-${Math.round(end)}w`
          if (inferredPowerUnits?.startsWith('z')) return inferredPowerUnits.toUpperCase()
          const pct = toRangePct(start, end)
          return target.ramp === true ? `ramp ${pct.start}-${pct.end}%` : `${pct.start}-${pct.end}%`
        }
        if (kind === 'hr') {
          if (units === 'bpm') return formatHrZoneFromBpm(Math.round(start), Math.round(end))
          if (isHrZoneUnit) {
            const midpoint = (start + end) / 2
            return `Z${Math.max(1, Math.round(midpoint))} HR`
          }
          const pct = toRangePct(start, end)
          return `${pct.start}-${pct.end}% ${hrLabel}`
        }
        if (kind === 'pace') {
          const zoneLabel = paceTargetToZoneLabel(target)
          if (zoneLabel) return zoneLabel
          if (units === 'pace_zone' || units === 'zone') {
            const startBounds = getPaceZoneBoundsByIndex(start)
            const endBounds = getPaceZoneBoundsByIndex(end)
            if (startBounds && endBounds) {
              return `${startBounds.start.toFixed(2)}-${endBounds.end.toFixed(2)} m/s`
            }
          }
          if (units === 'm/s') return `${start.toFixed(2)}-${end.toFixed(2)} m/s`
        }
        if (units && units.includes('/')) return `${start}-${end}${units}`
        const pct = toRangePct(start, end)
        return `${pct.start}-${pct.end}% Pace`
      }

      if (target.range) return formatRange(target.range.start ?? 0, target.range.end ?? 0)
      if (typeof target.value === 'number' && target.value > 0.01) return formatValue(target.value)
      return ''
    }

    // Handle Strength Exercises
    if (workout.exercises && workout.exercises.length > 0) {
      if (workout.description) {
        lines.push(workout.description.trim())
        lines.push('')
      }

      workout.exercises.forEach((ex) => {
        lines.push(`- **${ex.name}**`)
        let details = ''
        if (ex.sets) details += `${ex.sets} sets`
        if (ex.reps) details += ` x ${ex.reps} reps`
        if (ex.weight) details += ` @ ${ex.weight}`
        if (details) lines.push(`  - ${details}`)
        if (ex.rest) lines.push(`  - Rest: ${ex.rest}`)
        if (ex.notes) lines.push(`  - Note: ${ex.notes}`)
        lines.push('')
      })

      return lines.join('\n').trim()
    }

    const sportType = workout.type?.toLowerCase() || ''
    const isSwim = sportType.includes('swim')
    const isRun = !isSwim && sportType.includes('run')
    // HR-first matches the system Default profile for athletes without power meters.
    const fallbackLoadPreference = 'HR_PACE_POWER'
    const currentPolicySource = workout.sportSettings || null
    const snapshotPolicySource = workout.generationSettingsSnapshot || null
    const hasExplicitTargetPolicy = Boolean(
      currentPolicySource?.targetPolicy || snapshotPolicySource?.targetPolicy
    )
    const normalizedPolicy = normalizeTargetPolicy(
      currentPolicySource?.targetPolicy || snapshotPolicySource?.targetPolicy,
      currentPolicySource?.loadPreference ||
        snapshotPolicySource?.loadPreference ||
        fallbackLoadPreference
    )
    const metricPriority = normalizedPolicy.fallbackOrder.map((metric) => {
      if (metric === 'heartRate') return 'hr'
      if (metric === 'power') return 'power'
      if (metric === 'pace') return 'pace'
      return 'rpe'
    })
    const rawHrTolerancePct = Number(workout.sportSettings?.intervalsHrRangeTolerancePct || 0)
    const hrTolerancePct =
      rawHrTolerancePct > 1 ? rawHrTolerancePct / 100 : Math.max(0, rawHrTolerancePct)
    const normalizeHrTargetForExport = (
      target: { value?: number; range?: { start: number; end: number }; units?: string } | null
    ) => {
      if (!target) return null
      if (target.range) return target
      if (typeof target.value !== 'number') return target
      if (hrTolerancePct <= 0) return target

      const start = Math.max(0, target.value - hrTolerancePct)
      const end = target.value + hrTolerancePct
      return { range: { start, end }, units: target.units }
    }
    const deriveRunHeartRateTargetFromPower = (
      powerTarget: { value?: number; range?: { start: number; end: number }; units?: string } | null
    ) => {
      if (!isRun || !powerTarget) return null
      const normalizedUnits = String(powerTarget.units || '')
        .trim()
        .toLowerCase()
      const isRelativePower =
        normalizedUnits.includes('%') ||
        normalizedUnits === '' ||
        normalizedUnits === 'ftp' ||
        normalizedUnits === '%ftp'

      const normalizeRelativeValue = (value: number) => {
        if (!Number.isFinite(value) || value <= 0) return null
        if (value > 3) return value / 100
        return value
      }

      if (powerTarget.range) {
        const start = normalizeRelativeValue(powerTarget.range.start)
        const end = normalizeRelativeValue(powerTarget.range.end)
        if (!isRelativePower || start === null || end === null) return null
        return {
          range: { start, end },
          units: 'LTHR'
        }
      }

      if (typeof powerTarget.value === 'number') {
        const value = normalizeRelativeValue(powerTarget.value)
        if (!isRelativePower || value === null) return null
        return {
          value,
          units: 'LTHR'
        }
      }

      return null
    }
    const deriveRunPaceTargetFromPower = (
      powerTarget: { value?: number; range?: { start: number; end: number }; units?: string } | null
    ) => {
      if (!isRun || !powerTarget) return null
      const normalizedUnits = String(powerTarget.units || '')
        .trim()
        .toLowerCase()
      const isRelativePower =
        normalizedUnits.includes('%') ||
        normalizedUnits === '' ||
        normalizedUnits === 'ftp' ||
        normalizedUnits === '%ftp'

      const normalizeRelativeValue = (value: number) => {
        if (!Number.isFinite(value) || value <= 0) return null
        if (value > 3) return value / 100
        return value
      }

      if (powerTarget.range) {
        const start = normalizeRelativeValue(powerTarget.range.start)
        const end = normalizeRelativeValue(powerTarget.range.end)
        if (!isRelativePower || start === null || end === null) return null
        return {
          range: { start, end },
          units: 'Pace'
        }
      }

      if (typeof powerTarget.value === 'number') {
        const value = normalizeRelativeValue(powerTarget.value)
        if (!isRelativePower || value === null) return null
        return {
          value,
          units: 'Pace'
        }
      }

      return null
    }

    if (workout.description) {
      const cleanPreamble = workout.description
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('-'))
        .join('\n')

      if (cleanPreamble) {
        lines.push(cleanPreamble)
        lines.push('')
      }
    }

    let currentType = ''
    const preamble = workout.description?.toLowerCase() || ''

    const formatSteps = (
      steps: WorkoutStep[],
      indent = '',
      parentStep: WorkoutStep | null = null
    ) => {
      steps.forEach((step, index) => {
        if (indent === '') {
          const lastLine = lines.length > 0 ? lines[lines.length - 1] : ''
          if (typeof lastLine === 'string' && /^\s+-\s+/.test(lastLine)) {
            lines.push('')
          }
        }

        if (indent === '') {
          let header = ''
          if (index === 0 && step.type === 'Warmup') {
            header = 'Warmup'
          } else if (step.type === 'Cooldown' && currentType !== 'Cooldown') {
            header = '\nCooldown'
          } else if (step.type === 'Active' && currentType === 'Warmup') {
            header = '\nMain Set'
          }

          if (header) {
            const cleanHeader = header.trim().toLowerCase()
            const lastLineRaw = lines.length > 0 ? lines[lines.length - 1] : ''
            const lastLine = lastLineRaw ? lastLineRaw.trim().toLowerCase() : ''
            const isRedundant =
              preamble.startsWith(cleanHeader) ||
              preamble.includes(`\n${cleanHeader}`) ||
              lastLine === cleanHeader
            if (!isRedundant) lines.push(header)
          }
          currentType = step.type
        }

        if (step.steps && step.steps.length > 0) {
          const reps = Number(step.reps ?? (step as any).repeat ?? (step as any).intervals) || 1
          if (reps > 1) {
            const lastLine = lines.length > 0 ? lines[lines.length - 1] : null
            if (lastLine && typeof lastLine === 'string' && !lastLine.endsWith('\n')) lines.push('')
            lines.push(`${indent}${reps}x`)
            formatSteps(step.steps, indent + '  ', step)
          } else {
            formatSteps(step.steps, indent, step)
          }
          return
        }

        const normalizeTargetForExport = (
          target: {
            value?: number
            range?: { start: number; end: number }
            ramp?: boolean
            units?: string
          } | null,
          stepType: WorkoutStep['type']
        ) => {
          if (!target?.range) return target
          if (target.ramp === true) return target
          if (stepType !== 'Warmup' && stepType !== 'Cooldown') return target
          return {
            ...target,
            ramp: true
          }
        }
        const normalizeCooldownRampForExport = <
          T extends {
            value?: number
            range?: { start: number; end: number }
            ramp?: boolean
            units?: string
          } | null
        >(
          target: T,
          stepType: WorkoutStep['type']
        ): T => {
          if (stepType !== 'Cooldown' || !target?.range || target.ramp !== true) return target
          const start = Number(target.range.start)
          const end = Number(target.range.end)
          if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return target
          return {
            ...target,
            range: { start: end, end: start }
          }
        }

        const defaultTargetValue = (stepType: WorkoutStep['type'], metric: string) => {
          if (stepType === 'Warmup') return 0.6
          if (stepType === 'Rest') return 0.5
          if (stepType === 'Cooldown') return 0.55
          if (metric === 'pace') {
            const intent = String((step as any).intent || '').toLowerCase()
            if (intent === 'threshold') return 1
            if (intent === 'tempo') return 0.9
            if (intent === 'vo2') return 1.08
            if (intent === 'endurance') return 0.85
            if (intent === 'easy' || intent === 'recovery' || intent === 'drills') return 0.75
          }
          return 0.75
        }

        let power = normalizeCooldownRampForExport(
          normalizeTargetForExport(
            normalizeTarget(step.power) || normalizeTarget(parentStep?.power),
            step.type
          ),
          step.type
        )
        const rawHeartRate = normalizeTargetForExport(
          normalizeTarget(step.heartRate) || normalizeTarget(parentStep?.heartRate),
          step.type
        )
        let heartRate = normalizeCooldownRampForExport(
          normalizeHrTargetForExport(rawHeartRate || deriveRunHeartRateTargetFromPower(power)),
          step.type
        )
        const rawPace = normalizeTargetForExport(
          normalizeTarget(step.pace) || normalizeTarget(parentStep?.pace),
          step.type
        )
        let pace = normalizeCooldownRampForExport(
          rawPace || deriveRunPaceTargetFromPower(power),
          step.type
        )
        const primaryExportMetric = normalizedPolicy.primaryMetric
        const missingPrimaryTarget =
          (primaryExportMetric === 'power' && !power) ||
          (primaryExportMetric === 'heartRate' && !heartRate) ||
          (primaryExportMetric === 'pace' && !pace) ||
          (primaryExportMetric === 'rpe' && typeof step.rpe !== 'number')

        if (hasExplicitTargetPolicy && normalizedPolicy.strictPrimary && missingPrimaryTarget) {
          const value = defaultTargetValue(step.type, primaryExportMetric)
          if (primaryExportMetric === 'power') power = { value, units: '%' }
          if (primaryExportMetric === 'heartRate') heartRate = { value, units: 'LTHR' }
          if (primaryExportMetric === 'pace') pace = { value, units: 'Pace' }
        }
        const distanceStr = toDistanceToken(step.distance)
        const duration = step.durationSeconds || step.duration || 0
        const shouldIncludeDuration = !isSwim || !step.distance || step.type === 'Rest'
        const durationStr = duration > 0 && shouldIncludeDuration ? toDurationToken(duration) : ''

        const intensities: string[] = []
        const getPowerStr = () => formatMetric(power, 'power')
        const getHrStr = () => formatMetric(heartRate, 'hr')
        const getPaceStr = () => formatMetric(pace, 'pace')
        const getRpeStr = () =>
          typeof step.rpe === 'number' && Number.isFinite(step.rpe) ? `RPE ${step.rpe}` : ''
        const metrics = metricPriority
        const shouldExportSinglePrimaryMetric =
          normalizedPolicy.strictPrimary || !normalizedPolicy.allowMixedTargetsPerStep
        const prefersRunDualMetricExport =
          isRun && metricPriority[0] === 'hr' && metricPriority[1] === 'pace'
        const suppressPowerForRunDualMetric =
          prefersRunDualMetricExport && Boolean(heartRate || pace)
        const maxMetricsToExport = prefersRunDualMetricExport
          ? 2
          : shouldExportSinglePrimaryMetric
            ? 1
            : Number.POSITIVE_INFINITY

        for (const metric of metrics) {
          if (metric === 'hr') {
            const s = getHrStr()
            if (s) {
              intensities.push(s)
              if (intensities.length >= maxMetricsToExport) break
            }
          } else if (metric === 'power') {
            if (suppressPowerForRunDualMetric) continue
            const s = getPowerStr()
            if (s) {
              intensities.push(s)
              if (intensities.length >= maxMetricsToExport) break
            }
          } else if (metric === 'pace') {
            const s = getPaceStr()
            if (s) {
              intensities.push(s)
              if (intensities.length >= maxMetricsToExport) break
            }
          } else if (metric === 'rpe') {
            const s = getRpeStr()
            if (s) {
              intensities.push(s)
              if (intensities.length >= maxMetricsToExport) break
            }
          }
        }

        if (intensities.length === 0) {
          const fallback = getHrStr() || getPowerStr() || getPaceStr() || getRpeStr()
          if (fallback) {
            intensities.push(fallback)
          } else if (isRun && step.type !== 'Rest') {
            intensities.push('60% LTHR')
          } else if (step.type === 'Rest' && !isRun) {
            intensities.push('50%')
          }
        }

        const intensityStr = intensities.join(' ')
        let line = `${indent}-`
        let name = (step.name || (step.type === 'Rest' ? 'Rest' : '')).trim()

        if (name) {
          name = name
            .replace(/(\d+)\s*(minutes?|min)/gi, '$1m')
            .replace(/(\d+)\s*(seconds?|sec)/gi, '$1s')
        }

        if (isRun && name) {
          name = name
            .replace(/\s*\(\s*\d+(-\d+)?\s*w\s*\)/gi, '')
            .replace(/\s+/g, ' ')
            .trim()

          // Intervals.icu may infer bare "Z2" as power zone; annotate HR explicitly
          // when this run step is heart-rate targeted.
          if (heartRate) {
            name = name.replace(/\bZ([1-7])\b(?!\s*HR\b)/gi, 'Z$1 HR')
          }
        }

        const nameIncludesDistance =
          distanceStr &&
          (name.toLowerCase().includes(`${step.distance}m`) ||
            name.toLowerCase().includes(`${step.distance}mtr`) ||
            name.toLowerCase().includes(`${step.distance}mtrs`) ||
            name.toLowerCase().includes(`${Number(step.distance) / 1000}km`))

        if (isSwim && distanceStr && !nameIncludesDistance) {
          line += ` ${distanceStr}`
        }
        if (name) line += ` ${name}`
        if (!isSwim && distanceStr && !nameIncludesDistance) {
          line += ` ${distanceStr}`
        }

        if (durationStr) {
          const durationMinutes = duration > 0 && duration % 60 === 0 ? duration / 60 : null
          if (
            durationMinutes === null ||
            (!name.toLowerCase().includes(`${durationMinutes}m`) &&
              !name.toLowerCase().includes(`${durationMinutes} min`))
          ) {
            line += ` ${durationStr}`
          }
        }

        if (intensityStr) line += ` ${intensityStr}`
        if (step.cadence) line += ` ${step.cadence}rpm`
        lines.push(line.trimEnd())
      })
    }

    formatSteps(workout.steps)
    return lines.join('\n')
  },

  parseIntervalsGymDescription(description: string): any[] {
    const exercises: any[] = []
    if (!description) return exercises

    const lines = description.split('\n')
    let currentExercise: any = null

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // Exercise Name: "- **Name**"
      const nameMatch = trimmed.match(/^-\s+\*\*(.+)\*\*$/)
      if (nameMatch) {
        if (currentExercise) {
          exercises.push(currentExercise)
        }
        currentExercise = { name: nameMatch[1] }
        continue
      }

      if (!currentExercise) continue

      // Details line (Sets/Reps/Weight)
      // Matches: "  - 3 sets", "  - 3 sets x 10 reps", "  - 3 sets x 10 reps @ 50kg"
      // But avoid matching "  - Rest:" or "  - Note:"
      // Note: We check for '- ' or '  - ' prefix generically
      if (
        (trimmed.startsWith('- ') || trimmed.startsWith('  - ')) &&
        !trimmed.includes('Rest:') &&
        !trimmed.includes('Note:') &&
        !trimmed.includes('**')
      ) {
        // Remove bullet
        const text = trimmed.replace(/^[-\s]+/, '')

        const setsMatch = text.match(/^(\d+)\s+sets/)
        if (setsMatch) currentExercise.sets = parseInt(setsMatch[1]!, 10)

        const repsMatch = text.match(/x\s+(.+?)\s+reps/)
        if (repsMatch) currentExercise.reps = repsMatch[1]!

        const weightMatch = text.match(/@\s+(.+)$/)
        if (weightMatch) currentExercise.weight = weightMatch[1]!

        continue
      }

      // Rest
      // Matches: "  - Rest: 60s"
      if (trimmed.includes('Rest:')) {
        const restMatch = trimmed.match(/Rest:\s+(.+)$/)
        if (restMatch) {
          currentExercise.rest = restMatch[1]
        }
        continue
      }

      // Note
      // Matches: "  - Note: ..."
      if (trimmed.includes('Note:')) {
        const noteMatch = trimmed.match(/Note:\s+(.+)$/)
        if (noteMatch) {
          currentExercise.notes = noteMatch[1]
        }
        continue
      }
    }

    if (currentExercise) {
      exercises.push(currentExercise)
    }

    return exercises
  }
}
