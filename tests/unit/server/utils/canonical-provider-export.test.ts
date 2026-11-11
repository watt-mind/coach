import { FitWriter } from '@markw65/fit-file-writer'
import { describe, expect, it, vi } from 'vitest'

import {
  serializeCanonicalForProvider,
  serializeCanonicalDownload
} from '../../../../server/utils/canonical-workout-serializer'

vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message)
  ;(error as any).statusCode = err.statusCode
  ;(error as any).data = err.data
  return error
})

describe('canonical provider export adapter', () => {
  const structure = {
    schemaVersion: 1,
    source: 'AI_GENERATION',
    targetUnits: { pace: 'm/s', duration: 'seconds', distance: 'meters' },
    zoneProfileSnapshot: {
      pace: { unit: 'm/s', ranges: [{ min: 2.2, max: 2.4, name: 'Z2' }] }
    },
    steps: [
      {
        duration: 3600,
        power: { value: 0.7, units: '%' }
      }
    ]
  }

  it('routes ride power workouts to intervals and zwo through one adapter', () => {
    const intervals = serializeCanonicalForProvider({
      destination: 'intervals',
      title: 'Endurance',
      description: 'Steady',
      type: 'Ride',
      ftp: 250,
      structure
    })
    const zwo = serializeCanonicalForProvider({
      destination: 'zwo',
      title: 'Endurance',
      description: 'Steady',
      type: 'Ride',
      ftp: 250,
      structure
    })

    expect(typeof intervals).toBe('string')
    expect(intervals).toContain('70%')
    expect(typeof zwo).toBe('string')
    expect(zwo).toContain('<workout')
  })

  it('rejects unsupported destination/target combinations', () => {
    expect(() =>
      serializeCanonicalForProvider({
        destination: 'zwo',
        title: 'Run',
        description: 'Tempo',
        type: 'Run',
        structure: {
          ...structure,
          steps: [
            {
              duration: 1800,
              pace: {
                metric: 'pace',
                kind: 'zone',
                zone: 3,
                rangeMps: { min: 3.1, max: 3.3 },
                units: 'm/s'
              }
            }
          ]
        }
      })
    ).toThrow(/pace targets are rejected/)
  })
})

describe('canonical absolute power downloads', () => {
  it.each(['w', 'watts'])('uses frozen FTP and preserves %s scalar and ramp inputs', (units) => {
    const structure = {
      steps: [
        { type: 'Active', durationSeconds: 60, power: { value: 200, units } },
        { type: 'Active', durationSeconds: 60, power: { value: 0.8, units: '%' } },
        {
          type: 'Warmup',
          durationSeconds: 60,
          power: { range: { start: 100, end: 200 }, ramp: true, units }
        }
      ]
    }
    const options = {
      title: 'Frozen',
      description: '',
      structure,
      workout: { lastGenerationSettingsSnapshot: { thresholds: { ftp: 250 } }, user: { ftp: 400 } },
      liveUserFtp: 400
    }
    const original = structuredClone(options)
    const zwo = serializeCanonicalDownload({ ...options, format: 'zwo' }) as string
    expect(zwo).toContain('Power="0.8"')
    expect(zwo).toContain('PowerLow="0.4" PowerHigh="0.8"')
    expect(serializeCanonicalDownload({ ...options, format: 'mrc' })).toContain(
      '0.00\t80\r\n1.00\t80'
    )
    expect(serializeCanonicalDownload({ ...options, format: 'erg' })).toContain(
      '0.00\t200\r\n1.00\t200'
    )
    const writer = vi.spyOn(FitWriter.prototype, 'writeMessage')
    try {
      expect(serializeCanonicalDownload({ ...options, format: 'fit' })).toBeInstanceOf(Uint8Array)
      const steps = writer.mock.calls.filter(([name]) => name === 'workout_step')
      expect(steps.map(([, data]) => data)).toMatchObject([
        { custom_target_value_low: 190, custom_target_value_high: 210 },
        { custom_target_value_low: 190, custom_target_value_high: 210 },
        { custom_target_value_low: 100, custom_target_value_high: 200 }
      ])
    } finally {
      writer.mockRestore()
    }
    expect(serializeCanonicalDownload({ ...options, format: 'mrc' })).toContain(
      '2.00\t40\r\n3.00\t80'
    )
    expect(serializeCanonicalDownload({ ...options, format: 'erg' })).toContain(
      '2.00\t100\r\n3.00\t200'
    )
    expect(options).toEqual(original)
  })
})
