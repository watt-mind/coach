import { describe, expect, it } from 'vitest'

import { assertRenderableStructure } from '../../../server/utils/structured-workout-validation'
import {
  buildCorrectiveStructureRetryPrompt,
  buildLegacyStructureInstructions,
  buildLegacyStructureJsonRules,
  buildSportSpecificInstructions,
  buildStructureAiCallOptions,
  filterZonesForWorkout,
  formatAiContextForStructureGen,
  isStrengthWorkoutType,
  looksLikeSteadyStateWorkout,
  resolveStructureContextProfile
} from '../../../trigger/utils/structure-generation-prompt'
import { strengthWorkoutStructureSchema } from '../../../trigger/utils/structure-generation-schemas'
import { formatCompactTargetingBlock } from '../../../trigger/utils/workout-targeting'
import { normalizeTargetFormatPolicy } from '../../../server/utils/workout-target-format-policy'
import { normalizeTargetPolicy } from '../../../server/utils/workout-target-policy'

describe('structure generation prompt helpers', () => {
  it('caps aiContext and skips when description is long enough', () => {
    const longContext = 'x'.repeat(800)
    expect(
      formatAiContextForStructureGen({ aiContext: longContext, profile: 'standard' })
    ).toContain('…')

    expect(
      formatAiContextForStructureGen({
        aiContext: 'Prefer cadence 85-90 on endurance rides.',
        workoutDescription: 'A'.repeat(150),
        profile: 'standard'
      })
    ).toBe('')

    expect(
      formatAiContextForStructureGen({
        aiContext: 'Prefer cadence 85-90.',
        profile: 'minimal'
      })
    ).toBe('')
  })

  it('builds a compact targeting block once', () => {
    const targetPolicy = normalizeTargetPolicy({
      primaryMetric: 'power',
      fallbackOrder: ['power', 'heartRate', 'rpe'],
      strictPrimary: false,
      allowMixedTargetsPerStep: false,
      defaultTargetStyle: 'value'
    })
    const targetFormatPolicy = normalizeTargetFormatPolicy(null)
    const block = formatCompactTargetingBlock(targetPolicy, targetFormatPolicy, 'POWER > HR > RPE')

    expect(block).toContain('primary=Power')
    expect(block).toContain('order=POWER > HR > RPE')
    expect(block).not.toContain('TARGET POLICY (source')
  })

  it('resolves context profiles from workout metadata', () => {
    expect(
      resolveStructureContextProfile({
        workout: { title: 'Zone 2 Endurance Ride', description: 'Easy aerobic session' }
      })
    ).toBe('minimal')

    expect(
      resolveStructureContextProfile({
        workout: { title: 'VO2 Intervals', description: '5x3min hard' }
      })
    ).toBe('standard')

    expect(
      resolveStructureContextProfile({
        workout: { title: 'Long Ride', description: 'Steady' },
        preserveExistingStructure: true
      })
    ).toBe('rich')

    expect(looksLikeSteadyStateWorkout({ title: 'Threshold repeats', description: '' })).toBe(false)
  })

  it('filters zones to workout-relevant bands', () => {
    const zones = [
      { name: 'Z1 Recovery', min: 100, max: 120 },
      { name: 'Z2 Endurance', min: 121, max: 150 },
      { name: 'Z3 Tempo', min: 151, max: 170 },
      { name: 'Z4 Threshold', min: 171, max: 185 }
    ]

    const filtered = filterZonesForWorkout(
      zones,
      { title: 'Zone 2 ride', description: 'Aerobic endurance' },
      3
    )

    expect(filtered.some((zone) => String(zone.name).includes('Z2'))).toBe(true)
    expect(filtered.length).toBeLessThanOrEqual(3)
  })

  it('builds lightweight corrective retry prompts with previous draft', () => {
    const prompt = buildCorrectiveStructureRetryPrompt({
      workout: { title: 'Z2 Ride', type: 'Ride', durationSec: 3600 },
      reason: 'duration undershoot too low',
      previousDraft: { steps: [{ type: 'Warmup', name: 'Easy', durationSeconds: 600 }] },
      generatorMode: 'draft_json_v1'
    })

    expect(prompt).toContain('FAILURE: duration undershoot too low')
    expect(prompt).toContain('PREVIOUS DRAFT')
    expect(prompt.length).toBeLessThan(2000)
  })

  it('disables thinking on first attempt and uses low thinking on retry', () => {
    const first = buildStructureAiCallOptions({
      attempt: 1,
      userId: 'user-1',
      operation: 'generate_structured_workout',
      entityType: 'PlannedWorkout',
      entityId: 'pw-1',
      timeoutMs: 45_000
    })
    const second = buildStructureAiCallOptions({
      attempt: 2,
      userId: 'user-1',
      operation: 'generate_structured_workout',
      entityType: 'PlannedWorkout',
      entityId: 'pw-1',
      timeoutMs: 45_000
    })

    expect(first.disableThinking).toBe(true)
    expect(first.thinkingLevelOverride).toBeUndefined()
    expect(second.disableThinking).toBeUndefined()
    expect(second.thinkingLevelOverride).toBe('low')
  })

  it('keeps the adjust flow retry thinking level while disabling thinking on attempt 1', () => {
    const base = {
      userId: 'user-1',
      operation: 'adjust_structured_workout',
      entityType: 'PlannedWorkout',
      entityId: 'pw-1',
      timeoutMs: 45_000,
      retryThinkingLevel: 'high' as const
    }
    const first = buildStructureAiCallOptions({ ...base, attempt: 1 })
    const second = buildStructureAiCallOptions({ ...base, attempt: 2 })

    expect(first).toEqual({
      userId: 'user-1',
      operation: 'adjust_structured_workout',
      entityType: 'PlannedWorkout',
      entityId: 'pw-1',
      maxRetries: 0,
      timeoutMs: 45_000,
      disableThinking: true
    })
    expect(second).toEqual({
      userId: 'user-1',
      operation: 'adjust_structured_workout',
      entityType: 'PlannedWorkout',
      entityId: 'pw-1',
      maxRetries: 0,
      timeoutMs: 45_000,
      thinkingLevelOverride: 'high'
    })
  })

  it('detects strength workout types', () => {
    expect(isStrengthWorkoutType('WeightTraining')).toBe(true)
    expect(isStrengthWorkoutType('Gym')).toBe(true)
    expect(isStrengthWorkoutType('Ride')).toBe(false)
  })

  it('builds strength legacy instructions for blocks and setRows', () => {
    const instructions = buildLegacyStructureInstructions({
      workoutType: 'WeightTraining',
      durationMinutes: 60,
      mode: 'generate',
      persona: 'direct'
    })
    const jsonRules = buildLegacyStructureJsonRules('WeightTraining')
    const sportRules = buildSportSpecificInstructions({
      workoutType: 'WeightTraining',
      targetFormatPolicy: normalizeTargetFormatPolicy(null),
      steadyTargetStyleRule: 'Prefer metric ranges'
    })

    expect(instructions).toContain("native strength 'blocks'")
    expect(instructions).toContain('setRows')
    expect(instructions).not.toContain('Warmup, Intervals, Rest, Cooldown')
    expect(jsonRules).toContain("'blocks'")
    expect(jsonRules).not.toContain('durationSeconds')
    expect(sportRules).toContain('setRows')
  })

  it('keeps endurance legacy instructions on interval-style steps', () => {
    const instructions = buildLegacyStructureInstructions({
      workoutType: 'Ride',
      durationMinutes: 90,
      mode: 'generate',
      persona: 'direct'
    })
    const jsonRules = buildLegacyStructureJsonRules('Ride')

    expect(instructions).toContain('Warmup, Intervals, Rest, Cooldown')
    expect(instructions).not.toContain("native strength 'blocks'")
    expect(jsonRules).toContain('durationSeconds')
  })

  it('requires blocks and omits top-level steps in the strength schema', () => {
    expect(strengthWorkoutStructureSchema.required).toEqual(
      expect.arrayContaining(['coachInstructions', 'blocks'])
    )
    expect(strengthWorkoutStructureSchema.properties).toHaveProperty('blocks')
    expect(strengthWorkoutStructureSchema.properties).not.toHaveProperty('steps')
    expect(strengthWorkoutStructureSchema.properties).not.toHaveProperty('exercises')
  })
})

describe('assertRenderableStructure', () => {
  it('rejects description-only payloads', () => {
    expect(
      assertRenderableStructure(
        { description: 'Easy ride', coachInstructions: 'Stay smooth', steps: [] },
        'Ride'
      ).valid
    ).toBe(false)
  })

  it('accepts steps, exercises, or strength blocks', () => {
    expect(
      assertRenderableStructure(
        { steps: [{ type: 'Warmup', name: 'Easy', durationSeconds: 600 }] },
        'Run'
      ).valid
    ).toBe(true)

    expect(
      assertRenderableStructure(
        {
          blocks: [
            {
              type: 'single_exercise',
              title: 'Squat',
              steps: [{ name: 'Back Squat', setRows: [{ value: 8 }] }]
            }
          ]
        },
        'WeightTraining'
      ).valid
    ).toBe(true)
  })
})
