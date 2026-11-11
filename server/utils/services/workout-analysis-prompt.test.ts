import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_SCORE_MAX,
  ANALYSIS_SCORE_MIN,
  ANALYSIS_SECTION_STATUSES,
  analysisSchema,
  buildAnalysisFactsPromptBlock,
  buildAnalysisGuardrailInstructions,
  buildWorkoutAnalysisData,
  buildWorkoutAnalysisPrompt,
  clampAnalysisScore,
  getAnalysisSectionsGuidance,
  getWorkoutTypeGuidance,
  normalizeRunningCadence,
  resolveSplitPacingVerdictApplicability
} from './workout-analysis-prompt'
import * as analyzeWorkoutTrigger from '../../../trigger/analyze-workout'
import {
  buildWorkoutAnalysisFactsV2,
  getActualIntervalsForAnalysis,
  getActualIntervalsSourceForAnalysis
} from '../workout-analysis-facts'

/**
 * CW-392 regression coverage.
 *
 * These builders used to exist twice -- once in `trigger/analyze-workout.ts` and once
 * in `server/utils/services/workoutAnalysisService.ts` -- and had already drifted apart.
 * This suite pins the emitted prompt for a representative workout so a future edit to
 * the shared module can't silently change what the model sees, and asserts that the
 * Trigger.dev entry point resolves to the exact same function objects.
 */

const RIDE_WORKOUT = {
  id: 'workout-fixture-1',
  date: new Date('2026-03-15T10:00:00Z'),
  title: 'Sweet Spot Intervals',
  description: '3x12 min sweet spot',
  notes: 'Legs felt strong throughout',
  type: 'Ride',
  durationSec: 5400,
  distanceMeters: 48000,
  elevationGain: 620,
  averageWatts: 231,
  maxWatts: 812,
  normalizedPower: 248,
  weightedAvgWatts: 250,
  ftp: 275,
  averageHr: 148,
  maxHr: 176,
  averageCadence: 88,
  maxCadence: 121,
  // m/s, as every sync writer stores it (48000 m / 5400 s = 8.889 m/s).
  averageSpeed: 8.9,
  tss: 96,
  trainingLoad: 101,
  intensity: 0.9,
  kilojoules: 1240,
  variabilityIndex: 1.07,
  powerHrRatio: 1.56,
  efficiencyFactor: 1.68,
  decoupling: 4.2,
  ctl: 71,
  atl: 84,
  rpe: 7,
  feel: 4,
  avgTemp: 21,
  trainer: false,
  lrBalance: 51.4,
  rawJson: {
    icu_intervals: [
      {
        type: 'WORK',
        label: 'Block 1',
        moving_time: 720,
        elapsed_time: 730,
        distance: 6400,
        average_watts: 255,
        max_watts: 402,
        weighted_average_watts: 258,
        intensity: 0.93,
        average_heartrate: 155,
        max_heartrate: 168,
        average_cadence: 90,
        max_cadence: 104,
        average_speed: 9.1,
        w5s_variability: 1.04
      },
      {
        type: 'RECOVERY',
        label: 'Rest 1',
        moving_time: 300,
        elapsed_time: 305,
        distance: 2000,
        average_watts: 120,
        intensity: 0.44,
        average_heartrate: 128,
        average_cadence: 78,
        average_speed: 6.6
      }
    ]
  }
}

const USER_PROFILE = {
  age: 35,
  sex: 'male',
  weight: 72,
  weightUnits: 'Kilograms',
  height: 180,
  heightUnits: 'Centimeters',
  language: 'English',
  temperatureUnits: 'Celsius',
  distanceUnits: 'Kilometers'
}

describe('normalizeRunningCadence', () => {
  it('doubles per-foot cadence exports for running workouts only', () => {
    expect(normalizeRunningCadence(87, true)).toBe(174)
    expect(normalizeRunningCadence(174, true)).toBe(174)
    expect(normalizeRunningCadence(88, false)).toBe(88)
  })

  it('passes through nullish and zero cadence untouched', () => {
    expect(normalizeRunningCadence(null, true)).toBeNull()
    expect(normalizeRunningCadence(undefined, true)).toBeUndefined()
    expect(normalizeRunningCadence(0, true)).toBe(0)
  })
})

describe('buildWorkoutAnalysisData', () => {
  it('normalises a raw workout row into the AI payload shape', () => {
    const data = buildWorkoutAnalysisData(RIDE_WORKOUT)

    expect(data.duration_m).toBe(90)
    expect(data.avg_power).toBe(231)
    expect(data.normalized_power).toBe(248)
    expect(data.avg_cadence).toBe(88)
    expect(data.avg_speed_ms).toBe(8.9)
    // Provider lap labels are re-derived rather than trusted (CW-376).
    expect(data.intervals).toHaveLength(2)
    expect(data.intervals[0].type).toBe('WORK')
    expect(data.intervals[1].type).toBe('RECOVERY')
  })

  it('doubles per-foot cadence for running workouts', () => {
    const data = buildWorkoutAnalysisData({
      type: 'TrailRun',
      durationSec: 3600,
      averageCadence: 87,
      maxCadence: 95
    })

    expect(data.avg_cadence).toBe(174)
    expect(data.max_cadence).toBe(190)
  })

  it('passes the stored m/s average speed through untouched (CW-382)', () => {
    // Every sync writer persists `averageSpeed` in m/s. The payload used to divide it by
    // 3.6 as if it were km/h, so a 3.0 m/s run (5:33/km) reached the model as 0.83 m/s.
    const data = buildWorkoutAnalysisData({
      type: 'Run',
      durationSec: 3333,
      distanceMeters: 10000,
      averageSpeed: 3.0
    })

    expect(data.avg_speed_ms).toBe(3.0)
  })
})

describe('getWorkoutTypeGuidance / getAnalysisSectionsGuidance', () => {
  it('selects sport-specific guidance', () => {
    expect(getWorkoutTypeGuidance('Ride', true, false)).toContain('This is a cycling workout')
    expect(getWorkoutTypeGuidance('Run', true, false)).toContain('This is a running workout')
    expect(getWorkoutTypeGuidance('Strength', false, true)).toContain(
      'strength training aspects like volume'
    )

    expect(getAnalysisSectionsGuidance('Run', true, false)).toContain('**Running Form**')
    expect(getAnalysisSectionsGuidance('Ride', true, false)).toContain('**Pedaling Efficiency**')
    expect(getAnalysisSectionsGuidance('Strength', false, true)).toContain('**Training Volume**')
  })
})

describe('buildAnalysisFactsPromptBlock / buildAnalysisGuardrailInstructions', () => {
  it('returns nothing when no v2 facts are supplied', () => {
    expect(buildAnalysisFactsPromptBlock(undefined)).toBe('')
  })

  it('emits the v2 facts contract and matching guardrails for a stochastic ski session', () => {
    const speed = [
      ...Array.from({ length: 150 }, () => 0),
      ...Array.from({ length: 220 }, () => 3.2),
      ...Array.from({ length: 60 }, () => 0),
      ...Array.from({ length: 180 }, () => 5.8),
      ...Array.from({ length: 80 }, () => 0.4),
      ...Array.from({ length: 200 }, () => 4.9),
      ...Array.from({ length: 90 }, () => 0)
    ]

    const facts = buildWorkoutAnalysisFactsV2({
      workout: {
        type: 'NordicSki',
        durationSec: speed.length * 5,
        averageHr: 152,
        maxHr: 181,
        averageSpeed: 12.24,
        intensity: 0.84,
        streams: {
          velocity: speed,
          heartrate: Array.from({ length: speed.length }, (_, i) => (i % 180 < 90 ? 168 : 132))
        }
      }
    } as any)

    const block = buildAnalysisFactsPromptBlock(facts)
    expect(block).toContain('## Calculated Workout Facts v2')
    expect(block).toContain('### Guardrails')
    expect(block).toContain('- Session Steadiness: stochastic')
    expect(block).toContain('Treat these facts as authoritative guardrails')

    const guardrails = buildAnalysisGuardrailInstructions('NordicSki', facts)
    expect(guardrails).toContain(
      'Do not criticize the athlete for lacking a constant pace or uniform effort'
    )
    expect(guardrails).toContain(
      'avoid cycling-specific gear advice such as recommending a power meter'
    )
    // Baseline rules are always present, even without facts.
    expect(buildAnalysisGuardrailInstructions('Ride', undefined)).toContain(
      'Do not use ATL, CTL, or TSB alone as proof of technique breakdown'
    )

    // The soft guardrail above asks the model to disregard non-constant pace;
    // the same session must also stop being handed the hard split verdict that
    // contradicts it (CW-389).
    expect(resolveSplitPacingVerdictApplicability(facts).applicable).toBe(false)
  })
})

describe('cadence stability applicability rows (CW-532)', () => {
  // Same shape as the CW-427 threshold fixture: warmup, 3 x 4 min work reps at
  // a flat 92 rpm, recovery jogs, an endurance-buffer block, cooldown. With a
  // cadence stream the reps scope cleanly (applicable); without one the
  // signal is withheld with a reason — and the prompt must say why.
  const CADENCE_BLOCKS = [
    { seconds: 600, watts: 150, cadence: 85, intensity: 0.54 },
    { seconds: 240, watts: 271, cadence: 92, intensity: 0.97 },
    { seconds: 240, watts: 140, cadence: 80, intensity: 0.5 },
    { seconds: 240, watts: 274, cadence: 92, intensity: 0.98 },
    { seconds: 240, watts: 140, cadence: 80, intensity: 0.5 },
    { seconds: 240, watts: 276, cadence: 92, intensity: 0.99 },
    { seconds: 240, watts: 140, cadence: 80, intensity: 0.5 },
    { seconds: 900, watts: 223, cadence: 88, intensity: 0.8 },
    { seconds: 300, watts: 120, cadence: 70, intensity: 0.43 }
  ]

  const CADENCE_PLAN = {
    durationSec: 3240,
    structuredWorkout: {
      steps: [
        { type: 'Warmup', durationSeconds: 600, power: { value: 54, units: '%' } },
        { type: 'Interval', durationSeconds: 240, power: { value: 97, units: '%' } },
        { type: 'Rest', durationSeconds: 240, power: { value: 50, units: '%' } },
        { type: 'Interval', durationSeconds: 240, power: { value: 98, units: '%' } },
        { type: 'Rest', durationSeconds: 240, power: { value: 50, units: '%' } },
        { type: 'Interval', durationSeconds: 240, power: { value: 99, units: '%' } },
        { type: 'Rest', durationSeconds: 240, power: { value: 50, units: '%' } },
        { type: 'Interval', durationSeconds: 900, power: { value: 80, units: '%' } },
        { type: 'Cooldown', durationSeconds: 300, power: { value: 43, units: '%' } }
      ]
    }
  }

  function buildCadenceStabilityWorkout(withCadence: boolean) {
    const time: number[] = []
    const watts: number[] = []
    const cadence: number[] = []
    const heartrate: number[] = []
    const laps: any[] = []
    let cursor = 0
    for (const block of CADENCE_BLOCKS) {
      const start = cursor
      for (let index = 0; index < block.seconds; index++) {
        time.push(cursor)
        watts.push(block.watts + ((index % 5) - 2))
        cadence.push(block.cadence)
        heartrate.push(110 + Math.round(block.watts / 6))
        cursor++
      }
      laps.push({
        type: 'WORK',
        start_index: start,
        end_index: cursor - 1,
        moving_time: block.seconds,
        average_watts: block.watts,
        average_cadence: block.cadence,
        average_heartrate: 110 + Math.round(block.watts / 6),
        intensity: block.intensity
      })
    }
    const streams: Record<string, number[]> = { time, watts, heartrate }
    if (withCadence) streams.cadence = cadence
    return {
      id: 'workout-cw-532',
      title: '4x4 Threshold',
      type: 'Ride',
      durationSec: time.length,
      averageWatts: 193,
      averageHr: 145,
      intensity: 0.85,
      variabilityIndex: 1.14,
      trainer: false,
      rawJson: { icu_intervals: laps },
      streams
    }
  }

  it('renders the cadence-stability applicability reason when the reps carry no cadence', () => {
    const facts = buildWorkoutAnalysisFactsV2({
      workout: buildCadenceStabilityWorkout(false),
      plannedWorkout: CADENCE_PLAN,
      sportSettings: { ftp: 280 }
    } as any)

    expect(facts.guardrails.archetype.sessionSteadiness).toBe('intervalled')
    expect(facts.performanceSignals.applicability.cadenceStability.applicable).toBe(false)

    const block = buildAnalysisFactsPromptBlock(facts)
    expect(block).toContain('- Cadence Stability Applicable: No')
    expect(block).toContain(
      '- Cadence Stability Applicability Reason: Cadence stability is unavailable because cadence telemetry is missing or too sparse.'
    )
  })

  it('omits the cadence-stability rows when the signal is applicable', () => {
    const facts = buildWorkoutAnalysisFactsV2({
      workout: buildCadenceStabilityWorkout(true),
      plannedWorkout: CADENCE_PLAN,
      sportSettings: { ftp: 280 }
    } as any)

    expect(facts.performanceSignals.applicability.cadenceStability).toEqual({
      applicable: true,
      reason: null
    })

    const block = buildAnalysisFactsPromptBlock(facts)
    expect(block).not.toContain('Cadence Stability Applicable')
    // The score itself still renders — only the applicability rows are gated.
    expect(block).toContain('- Cadence Stability Score: 100')
  })
})

describe('resolveSplitPacingVerdictApplicability', () => {
  const withSteadiness = (sessionSteadiness: string, primaryArchetype = 'endurance') =>
    ({ guardrails: { archetype: { sessionSteadiness, primaryArchetype } } }) as any

  it('withholds the verdict for intervalled and stochastic sessions, with a reason', () => {
    for (const steadiness of ['intervalled', 'stochastic']) {
      const verdict = resolveSplitPacingVerdictApplicability(withSteadiness(steadiness))
      expect(verdict.applicable).toBe(false)
      expect(verdict.reason).toContain(`session steadiness is ${steadiness}`)
    }
  })

  it('allows the verdict for steady and rolling sessions', () => {
    for (const steadiness of ['steady', 'rolling']) {
      expect(resolveSplitPacingVerdictApplicability(withSteadiness(steadiness))).toEqual({
        applicable: true,
        reason: null
      })
    }
  })

  it('leaves the legacy no-facts path applicable so the prompt is unchanged', () => {
    expect(resolveSplitPacingVerdictApplicability(undefined)).toEqual({
      applicable: true,
      reason: null
    })
  })
})

describe('buildWorkoutAnalysisPrompt', () => {
  it('emits a stable prompt for a representative ride (pure-extraction snapshot)', () => {
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(RIDE_WORKOUT),
      'Europe/Budapest',
      'Supportive',
      {
        ftp: 275,
        lthr: 168,
        loadPreference: 'POWER',
        hrZones: [{ name: 'Z1', min: 90, max: 120 }],
        powerZones: [{ name: 'Z2', min: 150, max: 200 }]
      },
      USER_PROFILE,
      'Masters athlete, prefers metric units.',
      {
        title: 'SST 3x12',
        description: 'Sweet spot blocks',
        durationSec: 3600,
        tss: 78,
        workIntensity: 0.88
      },
      undefined,
      {
        symptoms: [
          {
            timestamp: new Date('2026-03-12T08:00:00Z'),
            category: 'ILLNESS',
            severity: 6,
            description: 'sore throat'
          }
        ]
      }
    )

    expect(prompt).toMatchSnapshot()
  })

  it('reports an average speed that agrees with the derived average pace (CW-382)', () => {
    // The two lines in the "Pace & Speed" block are derived independently: the pace from
    // distance_m / duration_s, the speed from the stored `averageSpeed` column. They only
    // agree once the bogus /3.6 conversion is gone.
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData({
        id: 'workout-fixture-run',
        date: new Date('2026-03-16T06:00:00Z'),
        title: 'Steady 10k',
        type: 'Run',
        durationSec: 3333,
        distanceMeters: 10000,
        averageSpeed: 3.0,
        averageHr: 152,
        maxHr: 171
      }),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'PACE' },
      USER_PROFILE
    )

    expect(prompt).toContain('## Pace & Speed (Primary Metric)')
    // 10000 m / 3333 s = 3.0 m/s = 333 s/km = 5:33/km.
    expect(prompt).toContain('- Average Pace: 5:33/km')
    expect(prompt).toContain('- Average Speed: 3.00 m/s')
  })

  it('does not call ride speed a primary pace section when no metric may lead (CW-397)', () => {
    const workout = {
      ...RIDE_WORKOUT,
      averageWatts: null,
      maxWatts: null,
      normalizedPower: null,
      weightedAvgWatts: null,
      averageHr: 150,
      maxHr: 170
    }
    const baseFacts = buildWorkoutAnalysisFactsV2({ workout })
    const facts = {
      ...baseFacts,
      guardrails: {
        ...baseFacts.guardrails,
        archetype: { ...baseFacts.guardrails.archetype, primaryMetric: 'mixed' as const },
        telemetry: {
          ...baseFacts.guardrails.telemetry,
          hrUsable: false,
          hrArtifactSeverity: 'high' as const,
          powerAbsoluteUsable: false,
          powerRelativeUsable: false,
          paceUsable: true
        }
      }
    }

    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(workout),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'PACE_HR_POWER' },
      USER_PROFILE,
      undefined,
      undefined,
      facts
    )

    expect(prompt).toContain('**Fallback Rule**: No preferred metric')
    expect(prompt).not.toContain('## Pace & Speed (Primary Metric)')
  })

  it('uses one cadence convention across the session line and the interval rows for a run (CW-387)', () => {
    // Same physical legs, three places in one prompt. Before CW-387 the session line
    // said "176 spm", the Interval Breakdown said "180 rpm" for an equally doubled
    // number, and the facts rows said "90rpm" for the undoubled one.
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData({
        id: 'workout-fixture-run-cadence',
        date: new Date('2026-03-17T06:00:00Z'),
        title: '3 x 1km Threshold',
        type: 'Run',
        durationSec: 3000,
        distanceMeters: 9000,
        averageSpeed: 3.0,
        averageHr: 158,
        maxHr: 176,
        // One-legged, exactly as Strava / Intervals.icu store run cadence.
        averageCadence: 88,
        maxCadence: 95,
        rawJson: {
          icu_intervals: [
            {
              type: 'WORK',
              label: 'Rep 1',
              moving_time: 240,
              distance: 1000,
              average_heartrate: 168,
              average_cadence: 90,
              average_speed: 4.1667,
              intensity: 101
            },
            {
              type: 'RECOVERY',
              label: 'Jog 1',
              moving_time: 120,
              distance: 400,
              average_heartrate: 138,
              average_cadence: 76,
              average_speed: 3.0,
              intensity: 68
            }
          ]
        }
      }),
      'Europe/Budapest',
      'Supportive',
      // HR-primary. Since CW-412 the session cadence line no longer depends on
      // the metric priority at all -- the pace-primary variant is pinned by the
      // test below.
      { loadPreference: 'HR' },
      USER_PROFILE
    )

    // Session level: doubled and labelled spm.
    expect(prompt).toContain('- Average Cadence: 176 spm')
    expect(prompt).toContain('- Max Cadence: 190 spm')
    // Interval Breakdown: same convention, same unit -- no hardcoded rpm.
    expect(prompt).toContain('## Interval Breakdown')
    expect(prompt).toContain('- Avg Cadence: 180 spm')
    expect(prompt).toContain('- Avg Cadence: 152 spm')
    // A run prompt must never mention rpm anywhere.
    expect(prompt).not.toContain('rpm')
    expect(prompt).not.toContain('RPM')
  })

  it('gives a pace-primary run a session cadence baseline for its interval rows (CW-412)', () => {
    // `shouldCondenseHeartRateSection` fires for a pace-primary run, and the
    // session-level cadence lines used to sit inside that branch. The Interval
    // Breakdown prints per-interval cadence unconditionally, so the exact case
    // where running cadence matters most handed the model per-rep numbers with
    // nothing session-wide to compare them against. Cadence now follows
    // `isCadenceRelevant` alone.
    //
    // `loadPreference: 'PACE'` rather than an omitted setting: the default
    // priority is HR > PACE > POWER, so a bare default is HR-primary and would
    // not condense at all. (That default contradicting the pace guardrail is
    // CW-397, out of scope here.)
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData({
        id: 'workout-fixture-run-pace-primary-cadence',
        date: new Date('2026-03-18T06:00:00Z'),
        title: '3 x 1km Threshold',
        type: 'Run',
        durationSec: 3000,
        distanceMeters: 9000,
        averageSpeed: 3.0,
        averageHr: 158,
        maxHr: 176,
        // One-legged, exactly as Strava / Intervals.icu store run cadence.
        averageCadence: 88,
        maxCadence: 95,
        rawJson: {
          icu_intervals: [
            {
              type: 'WORK',
              label: 'Rep 1',
              moving_time: 240,
              distance: 1000,
              average_heartrate: 168,
              average_cadence: 90,
              average_speed: 4.1667,
              intensity: 101
            },
            {
              type: 'RECOVERY',
              label: 'Jog 1',
              moving_time: 120,
              distance: 400,
              average_heartrate: 138,
              average_cadence: 76,
              average_speed: 3.0,
              intensity: 68
            }
          ]
        }
      }),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'PACE' },
      USER_PROFILE
    )

    // Pace really is primary here, i.e. the condensing branch is live.
    expect(prompt).toContain('## Pace & Speed (Primary Metric)')

    // Heart-rate condensing itself is untouched: condensed heading, same HR lines.
    expect(prompt).toContain('## Heart Rate (Secondary Corroboration) & Cadence')
    expect(prompt).not.toContain('## Heart Rate & Cadence')
    expect(prompt).toContain('- Average HR: 158 bpm')
    expect(prompt).toContain('- Max HR: 176 bpm')

    // The baseline the interval rows are read against -- this is what regressed.
    expect(prompt).toContain('- Average Cadence: 176 spm')
    expect(prompt).toContain('- Max Cadence: 190 spm')

    // ...and the per-interval rows it explains, in the same CW-387 convention.
    expect(prompt).toContain('## Interval Breakdown')
    expect(prompt).toContain('- Avg Cadence: 180 spm')
    expect(prompt).toContain('- Avg Cadence: 152 spm')
    expect(prompt).not.toContain('rpm')
    expect(prompt).not.toContain('RPM')
  })

  it('keeps rpm for a ride in both the session line and the interval rows (CW-387)', () => {
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(RIDE_WORKOUT),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'POWER' },
      USER_PROFILE
    )

    expect(prompt).toContain('- Average Cadence: 88 rpm')
    expect(prompt).toContain('- Avg Cadence: 90 rpm')
    expect(prompt).not.toContain('spm')
  })

  it('floors the minutes term of an interval duration instead of rounding it (CW-388)', () => {
    // The seconds term is a true remainder, so rounding the minutes counted it
    // twice: 150s rendered as "3m 30s" and 110s as "2m 50s".
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData({
        id: 'workout-fixture-duration',
        date: new Date('2026-03-18T06:00:00Z'),
        title: 'Short reps',
        type: 'Ride',
        durationSec: 1800,
        ftp: 275,
        rawJson: {
          icu_intervals: [
            { type: 'WORK', label: 'Rep 1', moving_time: 150, average_watts: 300 },
            { type: 'WORK', label: 'Rep 2', moving_time: 110, average_watts: 295 },
            { type: 'WORK', label: 'Rep 3', moving_time: 720, average_watts: 260 }
          ]
        }
      }),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'POWER' },
      USER_PROFILE
    )

    expect(prompt).toContain('- Duration: 2m 30s')
    expect(prompt).toContain('- Duration: 1m 50s')
    // A whole number of minutes is unaffected.
    expect(prompt).toContain('- Duration: 12m 0s')
    expect(prompt).not.toContain('- Duration: 3m 30s')
    expect(prompt).not.toContain('- Duration: 2m 50s')
  })

  it('puts interval intensity on the session Intensity Factor scale and labels it (CW-388)', () => {
    // Intervals.icu hands us `icu_intervals[].intensity` as a PERCENTAGE of
    // threshold, while the session line is a factor. Both must read as one scale.
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData({
        id: 'workout-fixture-intensity',
        date: new Date('2026-03-18T06:00:00Z'),
        title: 'Threshold blocks',
        type: 'Ride',
        durationSec: 3600,
        ftp: 275,
        averageWatts: 230,
        intensity: 0.83,
        rawJson: {
          icu_intervals: [
            // Percent scale, as the provider sends it.
            { type: 'WORK', label: 'Block 1', moving_time: 600, intensity: 101 },
            // Already on the factor scale -- must pass through, not be divided again.
            { type: 'WORK', label: 'Block 2', moving_time: 600, intensity: 0.93 }
          ]
        }
      }),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'POWER' },
      USER_PROFILE
    )

    expect(prompt).toContain('- Intensity Factor: 0.830')
    expect(prompt).toContain('- Intensity: 1.01 IF (101% of threshold)')
    expect(prompt).toContain('- Intensity: 0.93 IF (93% of threshold)')
    // The raw provider percentage must never reach the model unlabelled.
    expect(prompt).not.toContain('- Intensity: 101.00')
  })

  it('normalises interval intensity in the payload, not in the renderer (CW-388)', () => {
    const data = buildWorkoutAnalysisData({
      id: 'workout-fixture-intensity-payload',
      date: new Date('2026-03-18T06:00:00Z'),
      title: 'Threshold blocks',
      type: 'Ride',
      durationSec: 3600,
      rawJson: {
        icu_intervals: [
          { type: 'WORK', label: 'Block 1', moving_time: 600, intensity: 101 },
          { type: 'WORK', label: 'Block 2', moving_time: 600, intensity: 0.93 }
        ]
      }
    })

    expect(data.intervals[0].intensity).toBeCloseTo(1.01, 5)
    expect(data.intervals[1].intensity).toBeCloseTo(0.93, 5)
  })

  /**
   * CW-389 fixtures.
   *
   * Six automatic per-kilometre splits from one interval session: a warmup km,
   * three rep-ish kms, then a jog and a cooldown km. First half averages 278s/km
   * and second half 307s/km, so the unconditional verdict called it a
   * "Positive Split (slowed down)"; the SD across them is ~41s, which the grade
   * band called "Variable pacing". Both numbers describe the warmup and the
   * cooldown, not the athlete's execution.
   */
  const KM_SPLITS = [
    { distance: 1000, moving_time: 330, average_speed: 3.03, average_heartrate: 132 },
    { distance: 1000, moving_time: 250, average_speed: 4.0, average_heartrate: 165 },
    { distance: 1000, moving_time: 255, average_speed: 3.92, average_heartrate: 168 },
    { distance: 1000, moving_time: 262, average_speed: 3.82, average_heartrate: 170 },
    { distance: 1000, moving_time: 300, average_speed: 3.33, average_heartrate: 158 },
    { distance: 1000, moving_time: 360, average_speed: 2.78, average_heartrate: 138 }
  ]

  const INTERVAL_RUN = {
    id: 'workout-fixture-interval-splits',
    date: new Date('2026-03-19T06:00:00Z'),
    title: '4 x 1km Threshold',
    type: 'Run',
    durationSec: 1757,
    distanceMeters: 6000,
    averageSpeed: 3.42,
    averageHr: 155,
    maxHr: 182,
    variabilityIndex: 1.14,
    rawJson: {
      splits_metric: KM_SPLITS,
      icu_intervals: [
        { type: 'WORK', label: 'Rep 1', moving_time: 240, distance: 1000, average_speed: 4.17 },
        { type: 'RECOVERY', label: 'Jog 1', moving_time: 120, distance: 400, average_speed: 3.0 },
        { type: 'WORK', label: 'Rep 2', moving_time: 242, distance: 1000, average_speed: 4.13 },
        { type: 'RECOVERY', label: 'Jog 2', moving_time: 120, distance: 400, average_speed: 3.0 },
        { type: 'WORK', label: 'Rep 3', moving_time: 245, distance: 1000, average_speed: 4.08 },
        { type: 'RECOVERY', label: 'Jog 3', moving_time: 120, distance: 400, average_speed: 3.0 },
        { type: 'WORK', label: 'Rep 4', moving_time: 247, distance: 1000, average_speed: 4.05 }
      ]
    }
  }

  const STEADY_RUN = {
    id: 'workout-fixture-steady-splits',
    date: new Date('2026-03-19T06:00:00Z'),
    title: 'Steady Long Run',
    type: 'Run',
    durationSec: 3600,
    distanceMeters: 6000,
    averageSpeed: 3.42,
    averageHr: 148,
    maxHr: 162,
    variabilityIndex: 1.02,
    rawJson: { splits_metric: KM_SPLITS }
  }

  it('withholds the split-strategy verdict on an intervalled session (CW-389)', () => {
    const facts = buildWorkoutAnalysisFactsV2({ workout: INTERVAL_RUN } as any)
    expect(facts.guardrails.archetype.sessionSteadiness).toBe('intervalled')

    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(INTERVAL_RUN),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'PACE' },
      USER_PROFILE,
      null,
      undefined,
      facts
    )

    // The measurements survive: every split row, plus the raw dispersion.
    expect(prompt).toContain('## Distance Split Pacing')
    expect(prompt).toContain('**Split 1**')
    expect(prompt).toContain('**Split 6**')
    expect(prompt).toContain('**Split Pace Consistency**')

    // The derived verdicts do not.
    expect(prompt).not.toContain('**Split Strategy**')
    expect(prompt).not.toContain('Positive Split (slowed down)')
    expect(prompt).not.toContain('>20s = Variable pacing')
    expect(prompt).not.toContain('Lower is better (more consistent pacing)')

    // ...and the gap says why, because "do not infer meaning from omitted
    // facts" is a stated rule of the facts contract.
    expect(prompt).toContain('Split-strategy verdict omitted: session steadiness is intervalled')
    expect(prompt).toContain('Consistency grading omitted: session steadiness is intervalled')

    // These were never laps -- they are the provider's automatic distance splits.
    expect(prompt).not.toContain('## Lap Pacing Analysis')
    expect(prompt).not.toContain('**Lap 1**')
  })

  it('still emits both verdicts for a steady session (CW-389)', () => {
    const facts = buildWorkoutAnalysisFactsV2({ workout: STEADY_RUN } as any)
    expect(facts.guardrails.archetype.sessionSteadiness).toBe('steady')

    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(STEADY_RUN),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'PACE' },
      USER_PROFILE,
      null,
      undefined,
      facts
    )

    expect(prompt).toContain('**Split Strategy**: Positive Split (slowed down)')
    expect(prompt).toContain('>20s = Variable pacing')
    expect(prompt).not.toContain('Split-strategy verdict omitted')
  })

  it('leaves the no-facts legacy path exactly as it was (CW-389)', () => {
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(INTERVAL_RUN),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'PACE' },
      USER_PROFILE
    )

    expect(prompt).toContain('**Split Strategy**: Positive Split (slowed down)')
    expect(prompt).toContain('>20s = Variable pacing')
  })

  it('respects the athlete distanceUnits preference for strength set distances', () => {
    const workoutData = {
      date: new Date('2026-03-15T10:00:00Z'),
      title: 'Full Body Strength',
      type: 'Strength',
      duration_m: 45,
      duration_s: 2700,
      exercises: [
        {
          name: 'Sled Push',
          muscle_group: 'Legs',
          sets: [{ type: 'NORMAL', reps: 1, distance: 20 }]
        }
      ]
    }

    const imperial = buildWorkoutAnalysisPrompt(
      workoutData,
      'Europe/Budapest',
      'Supportive',
      undefined,
      {
        ...USER_PROFILE,
        distanceUnits: 'Miles'
      }
    )
    expect(imperial).toContain('66 ft')

    const metric = buildWorkoutAnalysisPrompt(
      workoutData,
      'Europe/Budapest',
      'Supportive',
      undefined,
      {
        ...USER_PROFILE,
        distanceUnits: 'Kilometers'
      }
    )
    expect(metric).toContain('20 m')
  })
})

describe('shared-module wiring', () => {
  it('is the single implementation both analysis entry points use', async () => {
    // trigger/analyze-workout.ts re-exports the shared builders; identity equality proves
    // there is exactly one implementation left after the CW-392 dedup.
    expect(analyzeWorkoutTrigger.buildWorkoutAnalysisPrompt).toBe(buildWorkoutAnalysisPrompt)
    expect(analyzeWorkoutTrigger.buildWorkoutAnalysisData).toBe(buildWorkoutAnalysisData)
    expect(analyzeWorkoutTrigger.buildAnalysisFactsPromptBlock).toBe(buildAnalysisFactsPromptBlock)
    expect(analyzeWorkoutTrigger.buildAnalysisGuardrailInstructions).toBe(
      buildAnalysisGuardrailInstructions
    )
    expect(analyzeWorkoutTrigger.getWorkoutTypeGuidance).toBe(getWorkoutTypeGuidance)
    expect(analyzeWorkoutTrigger.getAnalysisSectionsGuidance).toBe(getAnalysisSectionsGuidance)
    expect(analyzeWorkoutTrigger.normalizeRunningCadence).toBe(normalizeRunningCadence)

    // The Redis-worker service imports the same module (it does not re-export the
    // builders, to avoid Nitro auto-import collisions), so assert the module graph
    // rather than symbol identity here.
    const serviceSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./workoutAnalysisService.ts', import.meta.url), 'utf-8')
    )
    expect(serviceSource).toContain("} from './workout-analysis-prompt'")
    expect(serviceSource).not.toContain('function buildWorkoutAnalysisPrompt')
    expect(serviceSource).not.toContain('function buildWorkoutAnalysisData')
  })
})

/**
 * CW-403 regression coverage.
 *
 * The response schema used to exist twice -- once in `trigger/analyze-workout.ts`
 * (1-10 scores, `excellent/good/moderate/needs_improvement/poor`) and once in
 * `server/utils/services/workoutAnalysisService.ts` (0-100 scores,
 * `excellent/good/fair/needs_attention/info`). Gemini enforces whichever schema it is
 * handed, so the service path -- the one that actually runs in production -- forced the
 * model off the vocabulary the prompt asks for, and every UI status->colour mapper fell
 * through to `neutral`: problem sections rendered grey instead of red.
 *
 * These tests read the vocabulary and the score scale back out of the *prompt string*
 * and compare them to the schema, so the two cannot drift apart again silently.
 */
describe('analysisSchema matches the prompt it is handed with', () => {
  const sectionStatusEnum = (analysisSchema.properties.sections as any).items.properties.status.enum
  const scoreProps = (analysisSchema.properties.scores as any).properties
  const scoreKeys = ['overall', 'technical', 'effort', 'pacing', 'execution'] as const

  /** Every distinct "Assign status: a/b/c" vocabulary the prompt instructs, across sports. */
  function statusVocabulariesInstructedByPrompt(): string[][] {
    const guidance = [
      getAnalysisSectionsGuidance('Strength', false, true),
      getAnalysisSectionsGuidance('Run', true, false),
      getAnalysisSectionsGuidance('Ride', true, false)
    ].join('\n')

    const matches = [...guidance.matchAll(/Assign status: ([a-z_/]+)/g)]
    expect(matches.length).toBeGreaterThan(0)
    return matches.map((m) => m[1]!.split('/'))
  }

  it('instructs exactly one status vocabulary across every sport variant', () => {
    const vocabularies = statusVocabulariesInstructedByPrompt()
    for (const vocabulary of vocabularies) {
      expect(vocabulary).toEqual(vocabularies[0])
    }
  })

  it('declares the section status enum the prompt asks for, and nothing else', () => {
    const [instructed] = statusVocabulariesInstructedByPrompt()

    expect(sectionStatusEnum).toEqual(instructed)
    expect(sectionStatusEnum).toEqual([...ANALYSIS_SECTION_STATUSES])
    // The retired vocabulary must never come back: the UI mappers do not understand it.
    expect(sectionStatusEnum).not.toContain('fair')
    expect(sectionStatusEnum).not.toContain('needs_attention')
    expect(sectionStatusEnum).not.toContain('info')
  })

  it('declares 1-10 score bounds, matching the scale the prompt states', () => {
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(RIDE_WORKOUT),
      'Europe/Budapest',
      'Supportive',
      undefined,
      USER_PROFILE
    )
    expect(prompt).toContain('**Performance Scores** (1-10 scale for tracking progress over time)')

    expect(ANALYSIS_SCORE_MIN).toBe(1)
    expect(ANALYSIS_SCORE_MAX).toBe(10)
    for (const key of scoreKeys) {
      expect(scoreProps[key].minimum).toBe(1)
      expect(scoreProps[key].maximum).toBe(10)
      expect(scoreProps[key].description).toContain('(1-10)')
    }
  })

  it('is the exact same object on both analysis entry points', () => {
    expect(analyzeWorkoutTrigger.analysisSchema).toBe(analysisSchema)
  })

  it('is not redefined by either entry point', async () => {
    const fs = await import('node:fs')
    const serviceSource = fs.readFileSync(
      new URL('./workoutAnalysisService.ts', import.meta.url),
      'utf-8'
    )
    const triggerSource = fs.readFileSync(
      new URL('../../../trigger/analyze-workout.ts', import.meta.url),
      'utf-8'
    )

    expect(serviceSource).not.toContain('const analysisSchema')
    expect(triggerSource).not.toContain('const analysisSchema')
    expect(serviceSource).not.toContain('interface StructuredAnalysis')
    expect(triggerSource).not.toContain('interface StructuredAnalysis')

    // ...and neither by any of the three report tasks, which carried their own
    // near-copies of the same shape until CW-425.
    for (const reportTask of [
      'generate-weekly-report.ts',
      'generate-custom-report.ts',
      'analyze-last-3-workouts.ts'
    ]) {
      const reportSource = fs.readFileSync(
        new URL(`../../../trigger/${reportTask}`, import.meta.url),
        'utf-8'
      )
      expect(reportSource, reportTask).not.toContain('const analysisSchema')
      expect(reportSource, reportTask).not.toContain('interface StructuredAnalysis')
    }

    // The service must import, never re-export: server/utils is Nitro auto-imported and
    // re-exporting produces "Duplicated imports" warnings (CW-392 NOTE, CW-404).
    expect(serviceSource).not.toMatch(/^export \{/m)
  })
})

describe('clampAnalysisScore', () => {
  it('is the single implementation both entry points call', async () => {
    expect(analyzeWorkoutTrigger.clampAnalysisScore).toBe(clampAnalysisScore)

    const fs = await import('node:fs')
    const serviceSource = fs.readFileSync(
      new URL('./workoutAnalysisService.ts', import.meta.url),
      'utf-8'
    )
    const triggerSource = fs.readFileSync(
      new URL('../../../trigger/analyze-workout.ts', import.meta.url),
      'utf-8'
    )
    expect(serviceSource).not.toContain('const clampScore')
    expect(triggerSource).not.toContain('const clampScore')
  })

  it('keeps 1-10 scores on the stored scale', () => {
    expect(clampAnalysisScore(1)).toBe(1)
    expect(clampAnalysisScore(7.4)).toBe(7)
    expect(clampAnalysisScore(10)).toBe(10)
  })

  it('folds a stray 0-100 score back onto the stored 1-10 scale', () => {
    // Safety net for responses produced while one entry point still declared 0-100.
    expect(clampAnalysisScore(88)).toBe(9)
    expect(clampAnalysisScore(100)).toBe(10)
  })

  it('returns null for non-numeric input', () => {
    expect(clampAnalysisScore(null)).toBeNull()
    expect(clampAnalysisScore(undefined)).toBeNull()
    expect(clampAnalysisScore(Number.NaN)).toBeNull()
  })
})

/**
 * CW-391 regression coverage: ONE segmentation per prompt.
 *
 * `buildWorkoutAnalysisData` used to read `rawJson.icu_intervals` directly, so
 * the "## Interval Breakdown" table could enumerate a different set of reps
 * than the "## Calculated Workout Facts v2" block printed above it. The v2
 * hit rates, `firstVsLastIntervalDeltaPct` and the rep-scoped CW-393 signals
 * are all computed over the arbitrated set returned by
 * `getActualIntervalsForAnalysis`; the table the model quotes has to be the
 * same set or every cross-reference the model makes is arithmetic over
 * mismatched rows.
 */
describe('interval segmentation provenance (CW-391)', () => {
  const SEGMENTATION_SPORT_SETTINGS = { ftp: 250, loadPreference: 'POWER' }

  /**
   * A session where the provider laps and the engine disagree as loudly as
   * possible: the file arrived with ONE lap covering the whole ride, while the
   * power stream and the linked plan both describe 4 x 5 min at ~115% of FTP.
   */
  const DISAGREEING_WORKOUT = {
    id: 'workout-fixture-segmentation',
    date: new Date('2026-03-19T06:00:00Z'),
    title: '4x5 VO2',
    type: 'Ride',
    durationSec: 3600,
    ftp: 250,
    averageWatts: 190,
    streams: {
      time: Array.from({ length: 3600 }, (_, index) => index),
      watts: [
        ...Array.from({ length: 600 }, () => 150),
        ...Array.from({ length: 4 }, () => [
          ...Array.from({ length: 300 }, () => 285),
          ...Array.from({ length: 300 }, () => 120)
        ]).flat(),
        ...Array.from({ length: 600 }, () => 130)
      ]
    },
    rawJson: {
      icu_intervals: [
        { type: 'WORK', label: 'Whole ride', moving_time: 3600, average_watts: 190, intensity: 76 }
      ]
    }
  }

  const DISAGREEING_PLAN = {
    title: '4x5 VO2',
    durationSec: 3600,
    structuredWorkout: {
      steps: [
        { type: 'Warmup', durationSeconds: 600, power: { range: { start: 0.55, end: 0.62 } } },
        ...Array.from({ length: 4 }, () => [
          { type: 'Active', durationSeconds: 300, power: { range: { start: 1.1, end: 1.18 } } },
          { type: 'Rest', durationSeconds: 300, power: { range: { start: 0.45, end: 0.52 } } }
        ]).flat(),
        { type: 'Cooldown', durationSeconds: 600, power: { range: { start: 0.55, end: 0.45 } } }
      ]
    }
  }

  const buildDisagreeingPrompt = () => {
    const workoutData = buildWorkoutAnalysisData(DISAGREEING_WORKOUT, {
      plannedWorkout: DISAGREEING_PLAN,
      sportSettings: SEGMENTATION_SPORT_SETTINGS
    })
    const facts = buildWorkoutAnalysisFactsV2({
      workout: DISAGREEING_WORKOUT,
      sportSettings: SEGMENTATION_SPORT_SETTINGS,
      plannedWorkout: DISAGREEING_PLAN
    })
    const prompt = buildWorkoutAnalysisPrompt(
      workoutData,
      'Europe/Budapest',
      'Supportive',
      SEGMENTATION_SPORT_SETTINGS,
      USER_PROFILE,
      undefined,
      DISAGREEING_PLAN,
      facts
    )
    return { workoutData, facts, prompt }
  }

  it('is the fixture the whole ticket is about: laps and detection disagree', () => {
    // Guard the guard. If a future arbitration change makes the provider lap
    // win here, this suite stops testing anything and has to be re-fixtured.
    expect(
      getActualIntervalsSourceForAnalysis(
        DISAGREEING_WORKOUT,
        DISAGREEING_PLAN,
        SEGMENTATION_SPORT_SETTINGS as any
      )
    ).toBe('detected')
    expect(DISAGREEING_WORKOUT.rawJson.icu_intervals).toHaveLength(1)
  })

  it('renders the interval table from the arbitrated set, not the provider laps', () => {
    const { workoutData, prompt } = buildDisagreeingPrompt()
    const arbitrated = getActualIntervalsForAnalysis(
      DISAGREEING_WORKOUT,
      DISAGREEING_PLAN,
      SEGMENTATION_SPORT_SETTINGS as any
    )

    // Same rep COUNT as the facts are computed over -- and not the single lap.
    expect(arbitrated.length).toBeGreaterThan(1)
    expect(workoutData.intervals).toHaveLength(arbitrated.length)
    expect(prompt.match(/^### Interval \d+: /gm) || []).toHaveLength(arbitrated.length)

    // Same rep BOUNDARIES: durations and stream offsets, in order.
    expect(workoutData.intervals.map((i: any) => i.duration_s)).toEqual(
      arbitrated.map((i) => i.durationSeconds)
    )
    expect(workoutData.intervals.map((i: any) => i.start_index)).toEqual(
      arbitrated.map((i) => i.startIndex)
    )
    expect(workoutData.intervals.map((i: any) => i.end_index)).toEqual(
      arbitrated.map((i) => i.endIndex)
    )
    for (const interval of arbitrated) {
      const minutes = Math.floor(interval.durationSeconds / 60)
      const seconds = interval.durationSeconds % 60
      expect(prompt).toContain(`- Duration: ${minutes}m ${seconds}s`)
    }

    // The provider's lap label and its whole-ride row must not reach the model.
    expect(prompt).not.toContain('Whole ride')
    expect(prompt).not.toContain('- Duration: 60m 0s')
  })

  it('names the segmentation source in the facts block and above the table', () => {
    const { prompt } = buildDisagreeingPrompt()

    expect(prompt).toContain(
      '- Interval Segmentation Source: engine detection over the recorded streams'
    )
    expect(prompt).toContain(
      'Segmentation source: engine detection over the recorded streams. These are the same segments the Calculated Workout Facts v2 block above is computed over'
    )
  })

  it('reports provider laps as the source when they win the arbitration', () => {
    const data = buildWorkoutAnalysisData(RIDE_WORKOUT)
    expect(data.interval_segmentation_source).toBe('raw')

    const prompt = buildWorkoutAnalysisPrompt(
      data,
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'POWER' },
      USER_PROFILE
    )
    expect(prompt).toContain('Segmentation source: provider laps (labels re-derived)')
  })

  it('omits the section entirely when there are no laps and nothing detected', () => {
    const data = buildWorkoutAnalysisData({
      id: 'workout-fixture-no-intervals',
      date: new Date('2026-03-20T06:00:00Z'),
      title: 'Easy spin',
      type: 'Ride',
      durationSec: 1800,
      averageWatts: 140
    })

    expect(data.intervals).toBeUndefined()
    expect(data.interval_segmentation_source).toBeUndefined()

    const prompt = buildWorkoutAnalysisPrompt(
      data,
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'POWER' },
      USER_PROFILE
    )
    expect(prompt).not.toContain('## Interval Breakdown')
    expect(prompt).not.toContain('Segmentation source:')
  })

  it('prints a per-rep pace for a run and never for a ride', () => {
    const runPrompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData({
        id: 'workout-fixture-run-interval-pace',
        date: new Date('2026-03-21T06:00:00Z'),
        title: '3 x 1km',
        type: 'Run',
        durationSec: 3000,
        distanceMeters: 9000,
        averageSpeed: 3.0,
        rawJson: {
          icu_intervals: [
            { type: 'WORK', moving_time: 240, distance: 1000, average_speed: 4.1667 },
            { type: 'RECOVERY', moving_time: 120, distance: 400, average_speed: 3.3333 }
          ]
        }
      }),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'PACE' },
      USER_PROFILE
    )

    // 4.1667 m/s = 240 s/km = 4:00/km; 3.3333 m/s = 300 s/km = 5:00/km.
    expect(runPrompt).toContain('- Avg Pace: 4:00/km')
    expect(runPrompt).toContain('- Avg Pace: 5:00/km')

    const ridePrompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(RIDE_WORKOUT),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'POWER' },
      USER_PROFILE
    )
    expect(ridePrompt).not.toContain('- Avg Pace:')
  })
})

/**
 * CW-425 regression coverage: the three report tasks.
 *
 * `trigger/generate-weekly-report.ts`, `trigger/generate-custom-report.ts` and
 * `trigger/analyze-last-3-workouts.ts` each carried their own inline
 * `const analysisSchema = { ... }`, restating the section-status vocabulary and
 * the score bounds as literals. They happened to agree with their prompts, but
 * nothing held them there -- which is precisely the state the workout schema was
 * in before CW-403 broke it.
 *
 * They now build from `buildReportAnalysisSchema`, so the enum and the bounds
 * come from `ANALYSIS_SECTION_STATUSES` / `ANALYSIS_SCORE_MIN|MAX`. A shared
 * schema that can still drift from its prompt has only moved the problem, so
 * these tests extend the CW-403 technique to each report: they read the status
 * vocabulary and the score scale back out of each task's own *prompt source*
 * and compare them to the schema that task actually hands Gemini.
 */
describe('report analysis schemas match the prompts they are handed with (CW-425)', () => {
  const REPORT_TASKS = [
    { file: 'generate-weekly-report.ts', schemaExport: 'weeklyReportAnalysisSchema' },
    { file: 'generate-custom-report.ts', schemaExport: 'customReportAnalysisSchema' },
    { file: 'analyze-last-3-workouts.ts', schemaExport: 'lastThreeWorkoutsAnalysisSchema' }
  ] as const

  async function loadReportTask(task: (typeof REPORT_TASKS)[number]) {
    const fs = await import('node:fs')
    const source = fs.readFileSync(
      new URL(`../../../trigger/${task.file}`, import.meta.url),
      'utf-8'
    )
    const mod: Record<string, any> = await import(`../../../trigger/${task.file.slice(0, -3)}`)
    return { source, schema: mod[task.schemaExport] as any }
  }

  /** Human label for a score key, as the prompts spell it ("training_load" -> "Training Load"). */
  function scoreLabel(key: string): string {
    return key
      .split('_')
      .map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`)
      .join(' ')
  }

  it('builds from the shared builder instead of an inline literal', async () => {
    for (const task of REPORT_TASKS) {
      const { source, schema } = await loadReportTask(task)

      expect(source, task.file).toContain('buildReportAnalysisSchema({')
      // No re-declared vocabulary or bounds: those may only reach the schema
      // through ANALYSIS_SECTION_STATUSES / ANALYSIS_SCORE_MIN|MAX.
      expect(source, task.file).not.toContain("'needs_improvement'")
      expect(source, task.file).not.toMatch(/^\s*minimum: \d+,$/m)
      expect(source, task.file).not.toMatch(/^\s*maximum: \d+$/m)

      expect(schema, task.file).toBeTruthy()
      expect(schema.type, task.file).toBe('object')
    }
  })

  it('hands that exact schema to generateStructuredAnalysis', async () => {
    for (const task of REPORT_TASKS) {
      const { source } = await loadReportTask(task)

      const call = source.match(/generateStructuredAnalysis(?:<[^>]*>)?\(([\s\S]{0,200})/)
      expect(call, task.file).not.toBeNull()
      expect(call![1], task.file).toContain(task.schemaExport)
    }
  })

  it('declares the shared section-status enum, and never the retired vocabulary', async () => {
    for (const task of REPORT_TASKS) {
      const { schema } = await loadReportTask(task)
      const statusEnum = schema.properties.sections.items.properties.status.enum

      expect(statusEnum, task.file).toEqual([...ANALYSIS_SECTION_STATUSES])
      // The CW-403 failure mode: an enum the UI status->colour mappers do not
      // understand, so problem sections render grey instead of red.
      expect(statusEnum, task.file).not.toContain('fair')
      expect(statusEnum, task.file).not.toContain('needs_attention')
      expect(statusEnum, task.file).not.toContain('info')
    }
  })

  it('declares the status vocabulary its own prompt instructs', async () => {
    let vocabulariesFound = 0

    for (const task of REPORT_TASKS) {
      const { source, schema } = await loadReportTask(task)
      const statusEnum = schema.properties.sections.items.properties.status.enum

      // e.g. "- Provide a status assessment (excellent/good/moderate/needs_improvement/poor)"
      for (const match of source.matchAll(/status assessment \(([a-z_/]+)\)/g)) {
        vocabulariesFound += 1
        expect(match[1]!.split('/'), task.file).toEqual(statusEnum)
      }
    }

    // If every prompt stops naming the vocabulary this guard quietly stops
    // guarding, so require that at least one still states it.
    expect(vocabulariesFound).toBeGreaterThan(0)
  })

  it('declares scores exactly when its own prompt asks for them', async () => {
    for (const task of REPORT_TASKS) {
      const { source, schema } = await loadReportTask(task)

      // A schema that declares scores the prompt never asks for makes Gemini
      // invent numbers with no basis; a prompt that asks for scores the schema
      // does not declare gets them silently dropped from the response.
      expect(Boolean(schema.properties.scores), task.file).toBe(
        source.includes('Performance Scores')
      )
      // ...and the top-level `required` may only demand scores that exist.
      if (schema.required.includes('scores')) {
        expect(schema.properties.scores, task.file).toBeTruthy()
      }
    }
  })

  it('declares the score scale its own prompt states', async () => {
    let scalesFound = 0

    for (const task of REPORT_TASKS) {
      const { source, schema } = await loadReportTask(task)

      // e.g. "**Performance Scores** (1-10 scale for tracking progress over time)"
      for (const match of source.matchAll(/Performance Scores\*{0,2} \((\d+)-(\d+) scale/g)) {
        scalesFound += 1
        expect(Number(match[1]), task.file).toBe(ANALYSIS_SCORE_MIN)
        expect(Number(match[2]), task.file).toBe(ANALYSIS_SCORE_MAX)
      }

      if (!schema.properties.scores) continue

      for (const [key, prop] of Object.entries<any>(schema.properties.scores.properties)) {
        if (key.endsWith('_explanation')) continue
        expect(prop.minimum, `${task.file}:${key}`).toBe(ANALYSIS_SCORE_MIN)
        expect(prop.maximum, `${task.file}:${key}`).toBe(ANALYSIS_SCORE_MAX)
        expect(prop.description, `${task.file}:${key}`).toContain(
          `(${ANALYSIS_SCORE_MIN}-${ANALYSIS_SCORE_MAX})`
        )
      }
      expect(schema.properties.scores.description, task.file).toContain(
        `${ANALYSIS_SCORE_MIN}-${ANALYSIS_SCORE_MAX} scale`
      )
    }

    expect(scalesFound).toBeGreaterThan(0)
  })

  it('names in the prompt every score dimension its schema declares', async () => {
    for (const task of REPORT_TASKS) {
      const { source, schema } = await loadReportTask(task)
      if (!schema.properties.scores) continue

      for (const key of Object.keys(schema.properties.scores.properties)) {
        if (key.endsWith('_explanation')) continue
        expect(source, `${task.file}:${key}`).toContain(scoreLabel(key))
      }
    }
  })

  it('keeps the per-report differences the tasks depend on', async () => {
    const byFile = new Map<string, any>()
    for (const task of REPORT_TASKS) {
      byFile.set(task.file, (await loadReportTask(task)).schema)
    }

    for (const [file, schema] of byFile) {
      // Reports render `status_label` directly (see each task's markdown
      // converter), so unlike the workout schema it must be required.
      expect(schema.properties.sections.items.required, file).toEqual([
        'title',
        'status',
        'status_label',
        'analysis_points'
      ])
      expect(schema.properties.recommendations.items.required, file).toEqual([
        'title',
        'priority',
        'description'
      ])
    }

    // Only the weekly report is invalid without scores.
    expect(byFile.get('generate-weekly-report.ts').required).toEqual([
      'type',
      'title',
      'executive_summary',
      'sections',
      'scores'
    ])
    // A nutrition-only custom report legitimately has none.
    expect(byFile.get('generate-custom-report.ts').required).toEqual([
      'type',
      'title',
      'executive_summary',
      'sections'
    ])
    expect(byFile.get('generate-custom-report.ts').properties.scores.required).toBeUndefined()
    // The three-workout comparison asks for no scores at all.
    expect(byFile.get('analyze-last-3-workouts.ts').properties.scores).toBeUndefined()

    // Nutrition metrics belong to the custom report only.
    expect(
      Object.keys(byFile.get('generate-custom-report.ts').properties.metrics_summary.properties)
    ).toContain('avg_protein_g')
    expect(
      Object.keys(byFile.get('generate-weekly-report.ts').properties.metrics_summary.properties)
    ).not.toContain('avg_protein_g')
  })
})

/**
 * CW-381: the payload carried per-lap rows and session means with nothing in
 * between, so the model reached for the session mean whenever it wanted an
 * interval number. A live 4x4min threshold run was told "your average cadence
 * of 162 spm is somewhat low for threshold work" -- 162 being the whole-session
 * mean, dragged down by warmup, recovery jogs and cooldown, while the four reps
 * averaged 177 spm. The advice was inverted, not merely imprecise.
 */
describe('work-only interval aggregates', () => {
  /** The reference session from the ticket, lapped the way Intervals.icu sends it. */
  const THRESHOLD_RUN_LAPS = [
    { seconds: 600, speed: 2.6, cadence: 76, hr: 130 },
    { seconds: 240, speed: 4.1, cadence: 89, hr: 168 },
    { seconds: 120, speed: 2.8, cadence: 78, hr: 140 },
    { seconds: 240, speed: 4.1, cadence: 88, hr: 172 },
    { seconds: 120, speed: 2.8, cadence: 78, hr: 142 },
    { seconds: 240, speed: 4.0, cadence: 89, hr: 174 },
    { seconds: 120, speed: 2.8, cadence: 77, hr: 143 },
    { seconds: 240, speed: 4.0, cadence: 88, hr: 175 },
    { seconds: 600, speed: 2.5, cadence: 74, hr: 128 }
  ]

  function buildThresholdRun(overrides: Record<string, unknown> = {}) {
    return {
      id: 'workout-fixture-cw381',
      date: new Date('2026-03-22T06:00:00Z'),
      title: '4 x 4min Threshold',
      type: 'Run',
      durationSec: 2520,
      distanceMeters: 8000,
      averageSpeed: 3.17,
      averageHr: 149,
      maxHr: 178,
      // One-legged, as every provider stores run cadence: 81 doubles to the
      // 162 spm the model quoted as if it were a threshold figure.
      averageCadence: 81,
      rawJson: {
        // Every lap labelled WORK, exactly as the provider sends it. The
        // aggregate must be built from the labels CW-376 re-derives, not these.
        icu_intervals: THRESHOLD_RUN_LAPS.map((lap) => ({
          type: 'WORK',
          moving_time: lap.seconds,
          average_speed: lap.speed,
          average_cadence: lap.cadence,
          average_heartrate: lap.hr
        }))
      },
      ...overrides
    }
  }

  it('puts a duration-weighted work-only aggregate in the payload', () => {
    const data = buildWorkoutAnalysisData(buildThresholdRun())

    // Four reps of 240s. Cadence is normalised here and only here: the weighted
    // one-legged mean is 88.5, i.e. the 177 spm the athlete actually ran, and
    // NOT the 162 spm session mean sitting in `avg_cadence`.
    expect(data.avg_cadence).toBe(162)
    expect(data.work_interval_summary).toMatchObject({
      rep_count: 4,
      total_duration_s: 960,
      avg_duration_s: 240,
      avg_cadence: 177
    })
    expect(Math.round(data.work_interval_summary.avg_hr)).toBe(172)

    // Recovery jogs only -- warmup and cooldown are not recoveries between reps.
    expect(data.recovery_interval_summary).toMatchObject({
      rep_count: 3,
      total_duration_s: 360
    })
    expect(Math.round(data.recovery_interval_summary.avg_cadence)).toBe(155)

    // Nothing an aggregate emits may be NaN, whatever the metric coverage.
    for (const summary of [data.work_interval_summary, data.recovery_interval_summary]) {
      for (const value of Object.values(summary)) {
        expect(Number.isNaN(value as number)).toBe(false)
      }
    }
  })

  it('prints the work-only figures in the prompt and forbids quoting the session means', () => {
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(buildThresholdRun()),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'PACE' },
      USER_PROFILE
    )

    expect(prompt).toContain('## Work vs Recovery Aggregates')
    expect(prompt).toContain('### Work Intervals')
    expect(prompt).toContain('- Segments: 4')
    expect(prompt).toContain('- Total Time: 16m 0s')
    expect(prompt).toContain('- Average Segment Length: 4m 0s')
    // The number the model should have quoted, in the same canonical unit as
    // the session line and the per-rep rows (CW-387).
    expect(prompt).toContain('- Average Cadence (duration-weighted): 177 spm')
    expect(prompt).toContain('- Average HR (duration-weighted): 172 bpm')
    // 4.05 m/s duration-weighted over the four reps is 247 s/km.
    expect(prompt).toContain('- Average Pace (duration-weighted): 4:07/km')

    // The session mean is still printed -- it is a true session fact -- but it
    // is now unmistakably the session's, not the reps'.
    expect(prompt).toContain('- Average Cadence: 162 spm')

    expect(prompt).toContain('### Recovery Between Work')
    expect(prompt).toContain('- Segments: 3')

    // The instruction, both at the section and next to the hard rules.
    expect(prompt).toContain(
      'Any claim about interval, rep, or threshold execution MUST quote these figures, never the session averages above.'
    )
    expect(prompt).toContain('must never be described as interval, rep or threshold values')
  })

  it('does not derive the aggregate from lap_splits (CW-389)', () => {
    // Automatic per-distance splits are present and deliberately disagree with
    // the laps: they cut across warmup, reps, recoveries and cooldown, so an
    // aggregate built from them would be another session-wide average wearing
    // an interval label.
    const data = buildWorkoutAnalysisData(
      buildThresholdRun({
        rawJson: {
          icu_intervals: THRESHOLD_RUN_LAPS.map((lap) => ({
            type: 'WORK',
            moving_time: lap.seconds,
            average_speed: lap.speed,
            average_cadence: lap.cadence,
            average_heartrate: lap.hr
          })),
          splits_metric: [
            { distance: 1000, moving_time: 315, average_speed: 3.17, average_heartrate: 150 },
            { distance: 1000, moving_time: 315, average_speed: 3.17, average_heartrate: 151 },
            { distance: 1000, moving_time: 315, average_speed: 3.17, average_heartrate: 152 }
          ]
        }
      })
    )

    expect(data.lap_splits).toHaveLength(3)
    // Three splits, four reps: the aggregate followed the resolved laps.
    expect(data.work_interval_summary.rep_count).toBe(4)
    expect(data.work_interval_summary.total_duration_s).toBe(960)
    expect(data.work_interval_summary.avg_cadence).toBe(177)
  })

  it('states the absence rather than printing a fabricated zero when a session has no reps', () => {
    // A steady ride: one lap, no recoveries. `resolveProviderIntervalTypes`
    // leaves a sub-3-lap session alone, so this is work-only by construction.
    const data = buildWorkoutAnalysisData({
      id: 'workout-fixture-cw381-steady',
      date: new Date('2026-03-23T06:00:00Z'),
      title: 'Endurance',
      type: 'Ride',
      durationSec: 3600,
      averageWatts: 180,
      averageCadence: 86,
      rawJson: {
        icu_intervals: [
          {
            type: 'WORK',
            moving_time: 3600,
            average_watts: 180,
            average_cadence: 86,
            average_heartrate: 132
          }
        ]
      }
    })

    expect(data.work_interval_summary).toMatchObject({ rep_count: 1, avg_power: 180 })
    expect(data.recovery_interval_summary).toBeUndefined()

    const prompt = buildWorkoutAnalysisPrompt(
      data,
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'POWER' },
      USER_PROFILE
    )

    expect(prompt).toContain('### Recovery Between Work')
    expect(prompt).toContain('- None: no recovery segments between work')
    expect(prompt).toContain('- Average Cadence (duration-weighted): 86 rpm')
    expect(prompt).not.toContain('spm')
  })

  it('omits the section entirely for a session with no resolved intervals', () => {
    const data = buildWorkoutAnalysisData({
      id: 'workout-fixture-cw381-no-intervals',
      date: new Date('2026-03-24T06:00:00Z'),
      title: 'Easy spin',
      type: 'Ride',
      durationSec: 1800,
      averageWatts: 140
    })

    expect(data.work_interval_summary).toBeUndefined()
    expect(data.recovery_interval_summary).toBeUndefined()

    const prompt = buildWorkoutAnalysisPrompt(
      data,
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'POWER' },
      USER_PROFILE
    )

    expect(prompt).not.toContain('## Work vs Recovery Aggregates')
  })
})

/**
 * CW-397. The sport profile is seeded `loadPreference: 'HR_PACE_POWER'` -- HR-first
 * on purpose, so it works for athletes without a power meter. The bug was never the
 * default: it was the prompt asserting `**Hard Rule**: Base most conclusions on HR
 * evidence` while the V2 facts block a few sections further down in the *same* prompt
 * reported `HR Usable: No`. "Hard Rule" phrasing wins that argument, so a power-meter
 * ride got an HR-led analysis.
 */
describe('metric priority agrees with the facts block (CW-397)', () => {
  // 10% dropouts: `getHrStats` marks the stream unusable, exactly as a chest strap
  // that kept losing contact would.
  const DROPOUT_HR_STREAM = Array.from({ length: 200 }, (_, index) => (index % 10 === 0 ? 0 : 148))

  // Verbatim what `sportSettingsRepository.createDefault()` seeds. Unchanged by
  // this ticket -- the fix is at prompt-assembly time.
  const DEFAULT_SPORT_SETTINGS = { ftp: 275, lthr: 168, loadPreference: 'HR_PACE_POWER' }

  const POWER_METER_RIDE = {
    id: 'workout-cw397-power-ride',
    date: new Date('2026-03-20T10:00:00Z'),
    title: 'Sweet Spot Intervals',
    type: 'Ride',
    durationSec: 5400,
    distanceMeters: 48000,
    averageSpeed: 8.9,
    averageWatts: 231,
    normalizedPower: 248,
    maxWatts: 640,
    ftp: 275,
    averageHr: 148,
    maxHr: 176,
    trainer: false,
    streams: { heartrate: DROPOUT_HR_STREAM }
  }

  const HR_ONLY_RUN = {
    id: 'workout-cw397-hr-run',
    date: new Date('2026-03-21T06:00:00Z'),
    title: 'Easy Endurance',
    type: 'Run',
    durationSec: 3300,
    distanceMeters: 10000,
    averageSpeed: 3.03,
    averageHr: 148,
    maxHr: 166,
    streams: { heartrate: Array.from({ length: 200 }, () => 148) }
  }

  it('leads a default-settings power ride with power once the facts disown HR', () => {
    const facts = buildWorkoutAnalysisFactsV2({
      workout: POWER_METER_RIDE,
      sportSettings: DEFAULT_SPORT_SETTINGS
    } as any)

    expect(facts.guardrails.telemetry.hrUsable).toBe(false)
    expect(facts.guardrails.archetype.primaryMetric).toBe('power')

    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(POWER_METER_RIDE),
      'Europe/Budapest',
      'Supportive',
      DEFAULT_SPORT_SETTINGS,
      USER_PROFILE,
      null,
      undefined,
      facts
    )

    // The facts block and the metric priority block now name the same metric.
    expect(prompt).toContain('- HR Usable: No')
    expect(prompt).toContain('- Primary Metric: power')
    expect(prompt).toContain('- **Primary Metric for this analysis**: POWER (available)')
    expect(prompt).toContain(
      '- **Hard Rule**: Base most conclusions on POWER evidence. Use other metrics mainly for corroboration.'
    )

    // And the contradiction is gone: nothing in the prompt orders the model to
    // base its conclusions on the metric the facts just disowned.
    expect(prompt).not.toContain('Base most conclusions on HR evidence')
    expect(prompt).toContain("**Demoted Metric**: HR is the athlete's preferred primary")
  })

  it('leaves an HR-only athlete on the HR-first default untouched', () => {
    // The case the seeded default exists to serve: no power meter, clean HR.
    // A regression here would be worse than the bug being fixed.
    const facts = buildWorkoutAnalysisFactsV2({
      workout: HR_ONLY_RUN,
      sportSettings: { loadPreference: 'HR_PACE_POWER', lthr: 160 }
    } as any)

    expect(facts.guardrails.telemetry.hrUsable).toBe(true)

    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(HR_ONLY_RUN),
      'Europe/Budapest',
      'Supportive',
      { loadPreference: 'HR_PACE_POWER', lthr: 160 },
      USER_PROFILE,
      null,
      undefined,
      facts
    )

    expect(prompt).toContain('- **Primary Metric for this analysis**: HR (available)')
    expect(prompt).toContain(
      '- **Hard Rule**: Base most conclusions on HR evidence. Use other metrics mainly for corroboration.'
    )
    expect(prompt).not.toContain('**Demoted Metric**')
  })

  it('leaves the no-facts legacy path exactly as it was', () => {
    // Without a facts block there is nothing to contradict, so raw availability
    // still decides and the HR-first default still leads.
    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(POWER_METER_RIDE),
      'Europe/Budapest',
      'Supportive',
      DEFAULT_SPORT_SETTINGS,
      USER_PROFILE
    )

    expect(prompt).toContain('- **Primary Metric for this analysis**: HR (available)')
    expect(prompt).not.toContain('**Demoted Metric**')
  })

  it('never hands an outdoor ride a pace-led hard rule when HR drops out (CW-437)', () => {
    // The most likely real trigger of the demotion path, and the case that made
    // the first cut of this fix a CW-437 regression: outdoor ride, no power
    // meter, dropout-riddled HR. Demoting HR leaves pace as the next metric the
    // session has data for -- but cycling speed moves with wind, gradient and
    // drafting, so the facts resolve this session to `mixed` and decline to name
    // a leading metric. The prompt must decline too.
    const OUTDOOR_RIDE_NO_POWER = {
      id: 'workout-cw397-outdoor-ride',
      date: new Date('2026-03-22T09:00:00Z'),
      title: 'Sunday Loop',
      type: 'Ride',
      durationSec: 5400,
      distanceMeters: 48000,
      averageSpeed: 8.9,
      averageHr: 150,
      maxHr: 172,
      trainer: false,
      streams: { heartrate: DROPOUT_HR_STREAM }
    }

    const facts = buildWorkoutAnalysisFactsV2({
      workout: OUTDOOR_RIDE_NO_POWER,
      sportSettings: DEFAULT_SPORT_SETTINGS
    } as any)

    expect(facts.guardrails.telemetry.hrUsable).toBe(false)
    expect(facts.guardrails.analysisMode).not.toBe('pace')

    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(OUTDOOR_RIDE_NO_POWER),
      'Europe/Budapest',
      'Supportive',
      DEFAULT_SPORT_SETTINGS,
      USER_PROFILE,
      null,
      undefined,
      facts
    )

    expect(prompt).not.toContain('Base most conclusions on PACE evidence')
    expect(prompt).not.toContain('Base most conclusions on HR evidence')
    expect(prompt).not.toContain('Do not make heart-rate zones the primary narrative')
    expect(prompt).toContain('**Fallback Rule**')
    // The pace-primary section header must not appear either.
    expect(prompt).not.toContain('## Pace & Speed (Primary Metric)')
  })

  it('leaves a pace-preference swim leading on pace (CW-437 is about bikes)', () => {
    // The over-correction guard. `analysisMode` is `mixed` for a swim -- as it is
    // for row, ski and walk -- so gating pace on `analysisMode === 'pace'` alone
    // silently demoted a first-class, user-selectable `PACE_*` preference onto HR
    // for four sports where pace IS the effort metric.
    const SWIM = {
      id: 'workout-cw397-swim',
      date: new Date('2026-03-23T07:00:00Z'),
      title: 'Endurance Swim',
      type: 'Swim',
      durationSec: 3600,
      distanceMeters: 3000,
      averageSpeed: 0.83,
      averageHr: 140,
      maxHr: 158,
      streams: { heartrate: Array.from({ length: 200 }, () => 140) }
    }
    const PACE_FIRST = { loadPreference: 'PACE_HR_POWER' }

    const facts = buildWorkoutAnalysisFactsV2({
      workout: SWIM,
      sportSettings: PACE_FIRST
    } as any)

    expect(facts.guardrails.analysisMode).not.toBe('pace')

    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(SWIM),
      'Europe/Budapest',
      'Supportive',
      PACE_FIRST,
      USER_PROFILE,
      null,
      undefined,
      facts
    )

    expect(prompt).toContain('- **Primary Metric for this analysis**: PACE (available)')
    expect(prompt).toContain('**Hard Rule**: Base most conclusions on PACE evidence')
    expect(prompt).not.toContain('**Demoted Metric**')
  })

  it('tells a pace-preference ride the truth about why pace stepped aside', () => {
    // Clean HR, real speed data. The facts block says `Pace Usable: Yes` in this
    // same prompt, so the demotion line must not claim the telemetry is bad --
    // that contradiction is the whole point of CW-397.
    const OUTDOOR_RIDE_CLEAN_HR = {
      id: 'workout-cw397-ride-pace-pref',
      date: new Date('2026-03-24T09:00:00Z'),
      title: 'Endurance Loop',
      type: 'Ride',
      durationSec: 5400,
      distanceMeters: 48000,
      averageSpeed: 8.9,
      averageHr: 145,
      maxHr: 168,
      trainer: false,
      streams: { heartrate: Array.from({ length: 200 }, () => 145) }
    }
    const PACE_FIRST = { loadPreference: 'PACE_HR_POWER' }

    const facts = buildWorkoutAnalysisFactsV2({
      workout: OUTDOOR_RIDE_CLEAN_HR,
      sportSettings: PACE_FIRST
    } as any)

    expect(facts.guardrails.telemetry.paceUsable).toBe(true)

    const prompt = buildWorkoutAnalysisPrompt(
      buildWorkoutAnalysisData(OUTDOOR_RIDE_CLEAN_HR),
      'Europe/Budapest',
      'Supportive',
      PACE_FIRST,
      USER_PROFILE,
      null,
      undefined,
      facts
    )

    // Both statements about pace appear in one document and agree.
    expect(prompt).toContain('- Pace Usable: Yes')
    expect(prompt).toContain(
      '- **Secondary Metric for corroboration**: PACE (present_but_not_leading)'
    )
    expect(prompt).toContain('speed is not a valid proxy for cycling effort')
    expect(prompt).not.toContain("PACE is the athlete's preferred primary, but this session's")
    expect(prompt).not.toContain('PACE (missing_or_not_set)')
    expect(prompt).toContain('**Hard Rule**: Base most conclusions on HR evidence')
  })
})
