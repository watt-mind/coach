import type { H3Event } from 'h3'
import { Prisma } from '@prisma/client'
import { z } from 'zod/v3'
import { requireAuth } from './auth-guard'
import { prisma } from './db'
import { bodyMeasurementService } from './services/bodyMeasurementService'
import { normalizeWellnessFields } from './wellnessNormalization'

export const wellnessPatchSchema = z.object({
  date: z.string().optional(),
  hrv: z.number().nullable().optional(),
  hrvSdnn: z.number().nullable().optional(),
  restingHr: z.number().int().nullable().optional(),
  avgSleepingHr: z.number().int().nullable().optional(),
  sleepSecs: z.number().int().nullable().optional(),
  sleepHours: z.number().nullable().optional(),
  sleepDeepSecs: z.number().int().nullable().optional(),
  sleepRemSecs: z.number().int().nullable().optional(),
  sleepLightSecs: z.number().int().nullable().optional(),
  sleepAwakeSecs: z.number().int().nullable().optional(),
  sleepScore: z.number().int().nullable().optional(),
  sleepQuality: z.number().int().nullable().optional(),
  readiness: z.number().int().nullable().optional(),
  recoveryScore: z.number().int().nullable().optional(),
  soreness: z.number().int().nullable().optional(),
  fatigue: z.number().int().nullable().optional(),
  stress: z.number().int().nullable().optional(),
  mood: z.number().int().nullable().optional(),
  motivation: z.number().int().nullable().optional(),
  weight: z.number().nullable().optional(),
  spO2: z.number().nullable().optional(),
  ctl: z.number().nullable().optional(),
  atl: z.number().nullable().optional(),
  comments: z.string().max(1000).nullable().optional(),
  abdomen: z.number().nullable().optional(),
  bloodGlucose: z.number().nullable().optional(),
  bodyFat: z.number().nullable().optional(),
  diastolic: z.number().int().nullable().optional(),
  hydration: z.string().nullable().optional(),
  hydrationVolume: z.number().nullable().optional(),
  injury: z.string().nullable().optional(),
  lactate: z.number().nullable().optional(),
  menstrualPhase: z.string().nullable().optional(),
  respiration: z.number().nullable().optional(),
  skinTemp: z.number().nullable().optional(),
  restingCaloriesBurned: z.number().int().nullable().optional(),
  activeCaloriesBurned: z.number().int().nullable().optional(),
  totalCaloriesBurned: z.number().int().nullable().optional(),
  steps: z.number().int().nonnegative().nullable().optional(),
  distanceMeters: z.number().nonnegative().nullable().optional(),
  exerciseMinutes: z.number().int().nonnegative().nullable().optional(),
  floors: z.number().int().nonnegative().nullable().optional(),
  systolic: z.number().int().nullable().optional(),
  vo2max: z.number().nullable().optional(),
  tags: z.string().nullable().optional(),
  customMetrics: z.record(z.string(), z.any()).optional()
})

export async function handleWellnessPatch(event: H3Event) {
  const user = await requireAuth(event, ['health:write'])
  const param = getRouterParam(event, 'wellnessId') || getRouterParam(event, 'id')

  if (!param) {
    throw createError({
      statusCode: 400,
      message: 'Parameter is required'
    })
  }

  const normalizedBody = normalizeWellnessFields(await readBody(event))
  const result = wellnessPatchSchema.safeParse(normalizedBody)

  if (!result.success) {
    throw createError({
      statusCode: 400,
      message: 'Invalid wellness data',
      data: result.error.issues
    })
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param)
  let wellness: any

  if (isUuid) {
    wellness = await prisma.wellness.findUnique({
      where: { id: param }
    })
  } else {
    const date = new Date(param)
    if (Number.isNaN(date.getTime())) {
      throw createError({ statusCode: 400, message: 'Invalid date format' })
    }

    wellness = await prisma.wellness.findUnique({
      where: {
        userId_date: {
          userId: user.id,
          date
        }
      }
    })
  }

  if (!wellness || wellness.userId !== user.id) {
    throw createError({
      statusCode: 404,
      message: 'Wellness record not found'
    })
  }

  const body = result.data
  const incomingData: Record<string, any> = {}

  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && key !== 'date') {
      incomingData[key] = value
    }
  }

  if (body.date !== undefined) {
    const parsedDate = new Date(body.date)
    if (Number.isNaN(parsedDate.getTime())) {
      throw createError({
        statusCode: 400,
        message: 'Invalid date format'
      })
    }

    incomingData.date = new Date(
      Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate())
    )
  }

  const updateData: Record<string, any> = {}
  const changes: Record<string, { old: any; new: any }> = {}

  for (const [key, nextValue] of Object.entries(incomingData)) {
    const currentValue = (wellness as any)[key]

    const isSame =
      key === 'date'
        ? currentValue instanceof Date &&
          nextValue instanceof Date &&
          currentValue.toISOString().slice(0, 10) === nextValue.toISOString().slice(0, 10)
        : currentValue === nextValue

    if (!isSame) {
      updateData[key] = nextValue
      changes[key] = {
        old:
          key === 'date' && currentValue instanceof Date
            ? currentValue.toISOString()
            : currentValue,
        new: key === 'date' && nextValue instanceof Date ? nextValue.toISOString() : nextValue
      }
    }
  }

  const clearedMetricKeys: Array<'weight' | 'body_fat_pct'> = []
  if (body.weight === null) clearedMetricKeys.push('weight')
  if (body.bodyFat === null) clearedMetricKeys.push('body_fat_pct')

  const changedFields = Object.keys(changes)

  if (changedFields.length === 0) {
    if (clearedMetricKeys.length > 0) {
      await bodyMeasurementService.recordWellnessMetrics(
        user.id,
        { id: wellness.id, date: wellness.date },
        'manual_edit',
        clearedMetricKeys
      )
    }
    return { success: true, wellness }
  }

  const existingHistory = Array.isArray(wellness.history) ? wellness.history : []
  const historyEntry = {
    timestamp: new Date().toISOString(),
    source: 'manual_edit',
    changedFields,
    changes
  }

  try {
    const updated = await prisma.wellness.update({
      where: { id: wellness.id },
      data: {
        ...updateData,
        lastSource: 'manual_edit',
        history: [...existingHistory, historyEntry]
      }
    })

    await bodyMeasurementService.recordWellnessMetrics(
      user.id,
      {
        id: updated.id,
        date: updated.date,
        weight: updated.weight,
        bodyFat: updated.bodyFat,
        rawJson: updated.rawJson
      },
      'manual_edit',
      clearedMetricKeys
    )

    return {
      success: true,
      wellness: updated
    }
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes('userId') &&
      error.meta.target.includes('date')
    ) {
      throw createError({
        statusCode: 409,
        message: 'A wellness record already exists for that date.'
      })
    }

    console.error('Error updating wellness record:', error)
    throw createError({
      statusCode: 500,
      message: 'Failed to update wellness record'
    })
  }
}
