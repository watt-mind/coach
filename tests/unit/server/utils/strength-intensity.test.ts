import { describe, expect, it } from 'vitest'
import {
  applyStrengthIntensityTargets,
  buildStrengthIntensityReferences,
  estimateE1rmRange,
  formatStrengthIntensityReferences
} from '../../../../server/utils/strength-intensity'

describe('strength intensity references', () => {
  it('returns the Epley, Brzycki, and Wathan spread for valid 1-8 rep sets', () => {
    expect(estimateE1rmRange(100, 5)).toEqual({
      minKg: 112.5,
      maxKg: 116.67
    })
    expect(estimateE1rmRange(100, 9)).toBeNull()
    expect(estimateE1rmRange(0, 5)).toBeNull()
  })

  it('normalizes pounds, keeps the strongest estimate, and uses latest RPE for progression', () => {
    const references = buildStrengthIntensityReferences([
      {
        exerciseName: 'Back Squat',
        reps: 5,
        weight: 220.462,
        weightUnit: 'lb',
        rpe: 8,
        performedAt: new Date('2026-08-01')
      },
      {
        exerciseName: 'Back Squat',
        reps: 5,
        weight: 95,
        weightUnit: 'kg',
        rpe: 7,
        performedAt: new Date('2026-08-20')
      }
    ])

    expect(references).toEqual([
      expect.objectContaining({
        exerciseName: 'Back Squat',
        e1rmKg: { minKg: 112.5, maxKg: 116.67 },
        sampleCount: 2,
        latestRpe: 7,
        estimatedRir: 3,
        progressionAdjustment: 0.025
      })
    ])
  })

  it('uses the last ordered set RPE deterministically within the latest workout', () => {
    const references = buildStrengthIntensityReferences([
      {
        exerciseName: 'Back Squat',
        reps: 5,
        weight: 95,
        weightUnit: 'kg',
        rpe: 7,
        performedAt: new Date('2026-08-20'),
        setOrder: 2
      },
      {
        exerciseName: 'Back Squat',
        reps: 5,
        weight: 100,
        weightUnit: 'kg',
        rpe: 10,
        performedAt: new Date('2026-08-20'),
        setOrder: 0
      }
    ])

    expect(references[0]).toMatchObject({
      latestRpe: 7,
      estimatedRir: 3,
      progressionAdjustment: 0.025
    })
  })

  it('fills blank matching set loads with a conservative RIR-adjusted target', () => {
    const structure = {
      blocks: [
        {
          steps: [
            {
              name: 'Back Squat',
              loadMode: 'weight_kg',
              setRows: [
                { value: '5', loadValue: '' },
                { value: '5', loadValue: '90' }
              ]
            }
          ]
        }
      ]
    }
    const references = buildStrengthIntensityReferences([
      {
        exerciseName: 'Back Squat',
        reps: 5,
        weight: 100,
        weightUnit: 'kg',
        rpe: 7,
        performedAt: new Date('2026-08-20')
      }
    ])

    applyStrengthIntensityTargets(structure, references, 'Kilograms')

    expect(structure.blocks[0]!.steps[0]).toMatchObject({
      loadMode: 'weight_kg',
      setRows: [
        { value: '5', loadValue: '100' },
        { value: '5', loadValue: '90' }
      ]
    })
  })

  it('rounds targets in the preferred pounds unit', () => {
    const structure = {
      blocks: [
        {
          steps: [
            {
              name: 'Deadlift',
              loadMode: 'none',
              setRows: [{ value: '3', loadValue: '' }]
            }
          ]
        }
      ]
    }
    const references = buildStrengthIntensityReferences([
      { exerciseName: 'Deadlift', reps: 3, weight: 180, weightUnit: 'kg', rpe: 8 }
    ])

    applyStrengthIntensityTargets(structure, references, 'Pounds')

    expect(structure.blocks[0]!.steps[0]).toMatchObject({
      loadMode: 'weight_lb',
      setRows: [{ value: '3', loadValue: '380' }]
    })
  })

  it('uses an existing concrete step unit when filling a partially prescribed exercise', () => {
    const structure = {
      blocks: [
        {
          steps: [
            {
              name: 'Back Squat',
              loadMode: 'weight_lb',
              setRows: [
                { value: '5', loadValue: '100' },
                { value: '5', loadValue: '' }
              ]
            }
          ]
        }
      ]
    }
    const references = buildStrengthIntensityReferences([
      { exerciseName: 'Back Squat', reps: 5, weight: 100, weightUnit: 'kg', rpe: 8 }
    ])

    applyStrengthIntensityTargets(structure, references, 'Kilograms')

    expect(structure.blocks[0]!.steps[0]).toMatchObject({
      loadMode: 'weight_lb',
      setRows: [
        { value: '5', loadValue: '100' },
        { value: '5', loadValue: '215' }
      ]
    })
  })

  it('does not relabel partially populated rows whose existing load unit is ambiguous', () => {
    const structure = {
      blocks: [
        {
          steps: [
            {
              name: 'Back Squat',
              loadMode: 'none',
              setRows: [
                { value: '5', loadValue: '100' },
                { value: '5', loadValue: '' }
              ]
            }
          ]
        }
      ]
    }
    const references = buildStrengthIntensityReferences([
      { exerciseName: 'Back Squat', reps: 5, weight: 100, weightUnit: 'kg', rpe: 8 }
    ])

    applyStrengthIntensityTargets(structure, references, 'Kilograms')

    expect(structure.blocks[0]!.steps[0]).toMatchObject({
      loadMode: 'none',
      setRows: [
        { value: '5', loadValue: '100' },
        { value: '5', loadValue: '' }
      ]
    })
  })

  it('does not fabricate a load when no exercise history matches', () => {
    const structure = {
      blocks: [
        {
          steps: [
            {
              name: 'Front Squat',
              loadMode: 'none',
              setRows: [{ value: '5', loadValue: '' }]
            }
          ]
        }
      ]
    }

    applyStrengthIntensityTargets(structure, [], 'Kilograms')

    expect(structure.blocks[0]!.steps[0]).toMatchObject({
      loadMode: 'none',
      setRows: [{ value: '5', loadValue: '' }]
    })
  })

  it('formats the history as generator context and omits an empty section', () => {
    const references = buildStrengthIntensityReferences([
      { exerciseName: 'Back Squat', reps: 5, weight: 100, weightUnit: 'kg', rpe: 8 }
    ])

    expect(formatStrengthIntensityReferences(references)).toContain(
      'Back Squat: e1RM 112.5-116.7 kg; latest RPE 8 (estimated RIR 2)'
    )
    expect(formatStrengthIntensityReferences([])).toBe('')
  })
})
