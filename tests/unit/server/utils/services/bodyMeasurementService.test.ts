import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../../../server/utils/db'
import {
  bodyMeasurementService,
  extractWellnessBodyMeasurements
} from '../../../../../server/utils/services/bodyMeasurementService'

describe('extractWellnessBodyMeasurements', () => {
  it('extracts standard wellness metrics from explicit columns', () => {
    const measurements = extractWellnessBodyMeasurements({
      id: 'wellness-1',
      date: new Date('2026-03-04T00:00:00Z'),
      weight: 68.4,
      bodyFat: 17.3
    })

    expect(measurements).toEqual([
      { metricKey: 'weight', value: 68.4, unit: 'kg' },
      { metricKey: 'body_fat_pct', value: 17.3, unit: 'pct' }
    ])
  })

  it('extracts Intervals-style muscle mass fields from rawJson', () => {
    const measurements = extractWellnessBodyMeasurements({
      id: 'wellness-2',
      date: new Date('2026-03-04T00:00:00Z'),
      rawJson: {
        MuscleMass: 33.4,
        bodyFat: 17
      }
    })

    expect(measurements).toContainEqual({
      metricKey: 'muscle_mass_kg',
      value: 33.4,
      unit: 'kg'
    })
    expect(measurements).toContainEqual({
      metricKey: 'body_fat_pct',
      value: 17,
      unit: 'pct'
    })
  })

  it('extracts Withings body composition metrics from nested rawJson', () => {
    const measurements = extractWellnessBodyMeasurements({
      id: 'wellness-3',
      date: new Date('2026-03-04T00:00:00Z'),
      rawJson: {
        withings: {
          fatRatio: 18.2,
          muscleMass: 54.7,
          boneMass: 3.1
        }
      }
    })

    expect(measurements).toEqual([
      { metricKey: 'body_fat_pct', value: 18.2, unit: 'pct' },
      { metricKey: 'muscle_mass_kg', value: 54.7, unit: 'kg' },
      { metricKey: 'bone_mass_kg', value: 3.1, unit: 'kg' }
    ])
  })
})

vi.mock('../../../../../server/utils/db', () => ({
  prisma: { bodyMeasurementEntry: { updateMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() } }
}))

describe('recordWellnessMetrics explicit clears', () => {
  beforeEach(() => vi.resetAllMocks())

  it('retires both linked metrics across sources and suppresses stale raw body fat while retaining muscle', async () => {
    await bodyMeasurementService.recordWellnessMetrics(
      'user-1',
      {
        id: 'wellness-1',
        date: new Date('2026-03-04'),
        weight: null,
        bodyFat: null,
        rawJson: { withings: { fatRatio: 18, muscleMass: 54 } }
      },
      'manual_edit',
      ['weight', 'body_fat_pct']
    )
    expect(prisma.bodyMeasurementEntry.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        sourceRefType: 'wellness',
        sourceRefId: 'wellness-1',
        metricKey: { in: ['weight', 'body_fat_pct'] },
        isDeleted: false
      },
      data: { isDeleted: true }
    })
    expect(prisma.bodyMeasurementEntry.create).toHaveBeenCalledTimes(1)
    expect(prisma.bodyMeasurementEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metricKey: 'muscle_mass_kg', value: 54 })
    })
  })

  it('preserves raw fallback for callers without explicit clear instructions', async () => {
    await bodyMeasurementService.recordWellnessMetrics(
      'user-1',
      {
        id: 'wellness-1',
        date: new Date('2026-03-04'),
        bodyFat: null,
        rawJson: { fatRatio: 18 }
      },
      'withings'
    )
    expect(prisma.bodyMeasurementEntry.updateMany).not.toHaveBeenCalled()
    expect(prisma.bodyMeasurementEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metricKey: 'body_fat_pct', value: 18 })
    })
  })
})
