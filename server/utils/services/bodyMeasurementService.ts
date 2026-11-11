import type { Prisma } from '@prisma/client'
import { prisma } from '../db'
import { LBS_TO_KG, roundToTwoDecimals } from '../number'

type BodyMeasurementInput = {
  userId: string
  recordedAt: Date
  metricKey: string
  value: number
  unit: string
  displayName?: string | null
  source: string
  sourceRefType?: string | null
  sourceRefId?: string | null
  notes?: string | null
}

type WellnessMeasurementInput = {
  id: string
  date: Date
  weight?: number | null
  bodyFat?: number | null
  rawJson?: unknown
}

const CM_PER_INCH = 2.54

function normalizeUnit(unit: string) {
  return unit.trim().toLowerCase()
}

function normalizeMetricUnit(value: number, unit: string) {
  const normalizedUnit = normalizeUnit(unit)

  if (['kg', 'kilogram', 'kilograms'].includes(normalizedUnit)) {
    return { value: roundToTwoDecimals(value), unit: 'kg' }
  }

  if (['lb', 'lbs', 'pound', 'pounds'].includes(normalizedUnit)) {
    return { value: roundToTwoDecimals(value * LBS_TO_KG), unit: 'kg' }
  }

  if (['cm', 'centimeter', 'centimeters'].includes(normalizedUnit)) {
    return { value: roundToTwoDecimals(value), unit: 'cm' }
  }

  if (['in', 'inch', 'inches'].includes(normalizedUnit)) {
    return { value: roundToTwoDecimals(value * CM_PER_INCH), unit: 'cm' }
  }

  if (['pct', '%', 'percent', 'percentage'].includes(normalizedUnit)) {
    return { value: roundToTwoDecimals(value), unit: 'pct' }
  }

  throw new Error(`Unsupported measurement unit: ${unit}`)
}

function buildReferenceWhere(input: BodyMeasurementInput) {
  if (!input.sourceRefType || !input.sourceRefId) return null

  return {
    userId: input.userId,
    metricKey: input.metricKey,
    source: input.source,
    sourceRefType: input.sourceRefType,
    sourceRefId: input.sourceRefId
  }
}

function extractRawNumber(
  rawJson: unknown,
  candidates: string[],
  nestedCandidates: Array<{ parent: string; keys: string[] }> = []
) {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) return null

  const raw = rawJson as Record<string, unknown>

  for (const key of candidates) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }

  for (const nested of nestedCandidates) {
    const parent = raw[nested.parent]
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) continue

    for (const key of nested.keys) {
      const value = (parent as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  }

  return null
}

export function extractWellnessBodyMeasurements(wellness: WellnessMeasurementInput) {
  const measurements: Array<{
    metricKey: string
    value: number
    unit: string
  }> = []

  if (wellness.weight != null) {
    measurements.push({
      metricKey: 'weight',
      value: wellness.weight,
      unit: 'kg'
    })
  }

  const bodyFat =
    wellness.bodyFat ??
    extractRawNumber(
      wellness.rawJson,
      ['bodyFat', 'BodyFat', 'fatRatio'],
      [{ parent: 'withings', keys: ['fatRatio'] }]
    )

  if (bodyFat != null) {
    measurements.push({
      metricKey: 'body_fat_pct',
      value: bodyFat,
      unit: 'pct'
    })
  }

  const muscleMass = extractRawNumber(
    wellness.rawJson,
    ['muscleMass', 'MuscleMass', 'muscle_mass', 'muscle_mass_kg', 'muscleMassKg'],
    [{ parent: 'withings', keys: ['muscleMass'] }]
  )

  if (muscleMass != null) {
    measurements.push({
      metricKey: 'muscle_mass_kg',
      value: muscleMass,
      unit: 'kg'
    })
  }

  const boneMass = extractRawNumber(
    wellness.rawJson,
    ['boneMass', 'BoneMass', 'bone_mass', 'bone_mass_kg', 'boneMassKg'],
    [{ parent: 'withings', keys: ['boneMass'] }]
  )

  if (boneMass != null) {
    measurements.push({
      metricKey: 'bone_mass_kg',
      value: boneMass,
      unit: 'kg'
    })
  }

  return measurements
}

export const bodyMeasurementService = {
  normalizeMetricUnit,

  async recordEntry(input: BodyMeasurementInput, client: Prisma.TransactionClient = prisma) {
    const normalized = normalizeMetricUnit(input.value, input.unit)
    const referenceWhere = buildReferenceWhere(input)

    if (referenceWhere) {
      const existing = await client.bodyMeasurementEntry.findFirst({
        where: referenceWhere
      })

      if (existing) {
        return client.bodyMeasurementEntry.update({
          where: { id: existing.id },
          data: {
            recordedAt: input.recordedAt,
            value: normalized.value,
            unit: normalized.unit,
            displayName: input.displayName ?? existing.displayName,
            notes: input.notes ?? existing.notes,
            isDeleted: false
          }
        })
      }
    }

    return client.bodyMeasurementEntry.create({
      data: {
        userId: input.userId,
        recordedAt: input.recordedAt,
        metricKey: input.metricKey,
        displayName: input.displayName ?? null,
        value: normalized.value,
        unit: normalized.unit,
        source: input.source,
        sourceRefType: input.sourceRefType ?? null,
        sourceRefId: input.sourceRefId ?? null,
        notes: input.notes ?? null
      }
    })
  },

  async recordProfileMetrics(
    userId: string,
    metrics: {
      weight?: number | null
      height?: number | null
    },
    recordedAt: Date = new Date()
  ) {
    const writes: Promise<unknown>[] = []

    if (metrics.weight != null) {
      writes.push(
        this.recordEntry({
          userId,
          recordedAt,
          metricKey: 'weight',
          value: metrics.weight,
          unit: 'kg',
          source: 'profile_manual'
        })
      )
    }

    if (metrics.height != null) {
      writes.push(
        this.recordEntry({
          userId,
          recordedAt,
          metricKey: 'height',
          value: metrics.height,
          unit: 'cm',
          source: 'profile_manual'
        })
      )
    }

    await Promise.all(writes)
  },

  async recordWellnessMetrics(
    userId: string,
    wellness: WellnessMeasurementInput,
    source: string,
    clearedMetricKeys: Array<'weight' | 'body_fat_pct'> = [],
    client: Prisma.TransactionClient = prisma
  ) {
    // PATCH clears retire the linked metric across its original and manual-edit sources.
    if (clearedMetricKeys.length > 0) {
      await client.bodyMeasurementEntry.updateMany({
        where: {
          userId,
          sourceRefType: 'wellness',
          sourceRefId: wellness.id,
          metricKey: { in: clearedMetricKeys },
          isDeleted: false
        },
        data: { isDeleted: true }
      })
    }
    const recordedAt = wellness.date
    const writes = extractWellnessBodyMeasurements(wellness)
      // An explicit clear wins over provider rawJson fallback for this operation.
      .filter((measurement) => !clearedMetricKeys.some((key) => key === measurement.metricKey))
      .map((measurement) =>
        this.recordEntry(
          {
            userId,
            recordedAt,
            metricKey: measurement.metricKey,
            value: measurement.value,
            unit: measurement.unit,
            source,
            sourceRefType: 'wellness',
            sourceRefId: wellness.id
          },
          client
        )
      )

    await Promise.all(writes)
  }
}
