import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkoutConverter } from '../../../../server/utils/workout-converter'

const { messages } = vi.hoisted(() => ({ messages: [] as Array<{ name: string; data: any }> }))
vi.mock('@markw65/fit-file-writer', () => ({
  FitWriter: class {
    writeMessage(name: string, data: any) {
      messages.push({ name, data })
    }
    finish() {
      return new DataView(new ArrayBuffer(0))
    }
  }
}))

describe('download power units', () => {
  beforeEach(() => {
    messages.length = 0
  })

  for (const units of ['w', 'watts', '%', undefined]) {
    for (const mode of ['scalar', 'range', 'ramp']) {
      const range = mode !== 'scalar'
      const ramp = mode === 'ramp'
      it(`exports ${units ?? 'legacy'} ${mode} at equivalent intensity`, () => {
        const absolute = units === 'w' || units === 'watts'
        const power = range
          ? { range: { start: absolute ? 100 : 0.4, end: absolute ? 200 : 0.8 }, ramp, units }
          : { value: absolute ? 200 : 0.8, units }
        const workout = {
          title: 'Power',
          description: '',
          ftp: 250,
          steps: [{ type: 'Active' as const, durationSeconds: 60, power }]
        }
        const original = structuredClone(workout)
        const zwo = WorkoutConverter.toZWO(workout)
        expect(zwo).toContain(range ? 'PowerLow="0.4" PowerHigh="0.8"' : 'Power="0.8"')
        expect(WorkoutConverter.toMRC(workout)).toContain(`0.00\t${range ? 40 : 80}\r\n1.00\t80`)
        expect(WorkoutConverter.toERG(workout)).toContain(`0.00\t${range ? 100 : 200}\r\n1.00\t200`)
        WorkoutConverter.toFIT(workout)
        expect(messages.find((m) => m.name === 'workout_step')?.data).toMatchObject({
          custom_target_value_low: range ? 100 : 190,
          custom_target_value_high: range ? 200 : 210
        })
        expect(workout).toEqual(original)
      })
    }
  }

  it.each(['w', 'watts', '%', undefined])('keeps zero rest targets at zero (%s)', (units) => {
    const workout = {
      title: 'Rest',
      description: '',
      steps: [{ type: 'Rest' as const, durationSeconds: 60, power: { value: 0, units } }]
    }
    expect(WorkoutConverter.toZWO(workout)).toContain('Power="0"')
    expect(WorkoutConverter.toMRC(workout)).toContain('0.00\t0\r\n1.00\t0')
    expect(WorkoutConverter.toERG(workout)).toContain('0.00\t0\r\n1.00\t0')
    WorkoutConverter.toFIT(workout)
    expect(messages.find((m) => m.name === 'workout_step')?.data).toMatchObject({
      custom_target_value_low: 0,
      custom_target_value_high: 0
    })
  })

  it('uses supplied FTP for fractions while keeping absolute watts independent of FTP', () => {
    const workout = {
      title: 'FTP',
      description: '',
      ftp: 400,
      steps: [
        { type: 'Active' as const, durationSeconds: 60, power: { value: 200, units: 'watts' } }
      ]
    }
    expect(WorkoutConverter.toZWO(workout)).toContain('Power="0.5"')
    expect(WorkoutConverter.toMRC(workout)).toContain('0.00\t50')
    expect(WorkoutConverter.toERG(workout)).toContain('0.00\t200')
    WorkoutConverter.toFIT(workout)
    expect(messages.find((m) => m.name === 'workout_step')?.data).toMatchObject({
      custom_target_value_low: 190,
      custom_target_value_high: 210
    })
  })

  it('uses the existing 250W fallback when FTP is absent', () => {
    const workout = {
      title: 'Fallback',
      description: '',
      steps: [{ type: 'Active' as const, durationSeconds: 60, power: { value: 200, units: 'w' } }]
    }
    expect(WorkoutConverter.toZWO(workout)).toContain('Power="0.8"')
    expect(WorkoutConverter.toMRC(workout)).toContain('0.00\t80')
    expect(WorkoutConverter.toERG(workout)).toContain('0.00\t200')
  })
})
