import { createError } from 'h3'
import { prisma as globalPrisma } from '../db'
import { toPrismaInputJsonValue } from '../prisma-json'
import { normalizeTargetPolicy, toLegacyLoadPreference } from '../workout-target-policy'
import { normalizeTargetFormatPolicy } from '../workout-target-format-policy'

function resolveTargetPolicyAndLoadPreference(setting: any) {
  const targetPolicy = normalizeTargetPolicy(setting?.targetPolicy, setting?.loadPreference)
  const loadPreference = toLegacyLoadPreference(targetPolicy.fallbackOrder)
  const targetFormatPolicy = normalizeTargetFormatPolicy(setting?.targetFormatPolicy)
  return { targetPolicy, loadPreference, targetFormatPolicy }
}

function normalizePersistedSetting(setting: any) {
  if (!setting) return setting
  const { targetPolicy, loadPreference, targetFormatPolicy } =
    resolveTargetPolicyAndLoadPreference(setting)

  // Intervals.icu has historically returned running pace-zone bounds in
  // metres/minute, while Coach Watts stores and consumes pace as m/s. Keep
  // the persisted database value untouched, but normalize the repository
  // representation so every caller receives one canonical unit.
  const thresholdPace = Number(setting.thresholdPace || 0)
  const paceZones = Array.isArray(setting.paceZones) ? setting.paceZones : []
  const paceZoneValues = paceZones.flatMap((zone: any) => [Number(zone?.min), Number(zone?.max)])
  const maxPaceZoneValue = Math.max(
    ...paceZoneValues.filter((value: number) => Number.isFinite(value)),
    0
  )
  const paceZonesAreMetersPerMinute = thresholdPace > 0 && maxPaceZoneValue > thresholdPace * 20
  const normalizedThresholdPace =
    paceZonesAreMetersPerMinute && Number.isFinite(thresholdPace) && thresholdPace > 0
      ? thresholdPace / 60
      : setting.thresholdPace

  return {
    ...setting,
    thresholdPace: normalizedThresholdPace,
    paceZones: paceZonesAreMetersPerMinute
      ? paceZones.map((zone: any) => ({
          ...zone,
          min: Number.isFinite(Number(zone?.min)) ? Number(zone.min) / 60 : zone?.min,
          max: Number.isFinite(Number(zone?.max)) ? Number(zone.max) / 60 : zone?.max
        }))
      : setting.paceZones,
    targetPolicy,
    loadPreference,
    targetFormatPolicy
  }
}

export const sportSettingsRepository = {
  /**
   * Get all sport settings for a user, ensuring a Default profile exists.
   */
  async getByUserId(userId: string, prismaOverride?: any) {
    const prisma = prismaOverride || globalPrisma
    const settings = await prisma.sportSettings.findMany({
      where: { userId },
      orderBy: { isDefault: 'desc' } // Default first
    })
    const normalizedSettings = settings.map(normalizePersistedSetting)

    // Lazy create Default if missing
    if (!normalizedSettings.some((s: any) => s.isDefault)) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          ftp: true,
          lthr: true,
          maxHr: true,
          restingHr: true
        }
      })

      if (user) {
        const defaultProfile = await this.createDefault(userId, user, prisma)
        normalizedSettings.unshift(defaultProfile)
      }
    }

    return normalizedSettings
  },

  /**
   * Get the default sport settings for a user.
   */
  async getDefault(userId: string, prismaOverride?: any) {
    const settings = await this.getByUserId(userId, prismaOverride)
    return settings.find((s: any) => s.isDefault) || null
  },

  /**
   * Create the default profile using user's basic settings.
   */
  async createDefault(userId: string, legacyProfile: any, prismaOverride?: any) {
    const prisma = prismaOverride || globalPrisma
    const { targetPolicy, loadPreference, targetFormatPolicy } =
      resolveTargetPolicyAndLoadPreference({
        // HR-first: works across sports and for athletes without a power meter.
        loadPreference: 'HR_PACE_POWER'
      })
    return await prisma.sportSettings
      .upsert({
        where: {
          userId_source_externalId: {
            userId,
            source: 'system',
            externalId: `default_${userId}`
          }
        },
        update: {
          ftp: legacyProfile.ftp,
          lthr: legacyProfile.lthr,
          maxHr: legacyProfile.maxHr,
          restingHr: legacyProfile.restingHr
        },
        create: {
          userId,
          name: 'Default',
          isDefault: true,
          types: [],
          source: 'system',
          externalId: `default_${userId}`,
          ftp: legacyProfile.ftp,
          lthr: legacyProfile.lthr,
          maxHr: legacyProfile.maxHr,
          restingHr: legacyProfile.restingHr,
          hrZones: [], // Clean slate
          powerZones: [], // Clean slate
          paceZones: [],
          warmupTime: 10,
          cooldownTime: 10,
          loadPreference,
          targetPolicy: toPrismaInputJsonValue(targetPolicy),
          targetFormatPolicy: toPrismaInputJsonValue(targetFormatPolicy)
        }
      })
      .then(normalizePersistedSetting)
  },

  /**
   * Get the applicable sport settings for a specific activity type.
   * Falls back to Default if no specific match found.
   */
  async getForActivityType(userId: string, activityType: string, prismaOverride?: any) {
    const allSettings = await this.getByUserId(userId, prismaOverride)

    // 1. Exact match in types array (Prioritize profiles with actual data)
    const specificMatches = allSettings.filter(
      (s: any) => !s.isDefault && s.types && s.types.includes(activityType)
    )
    if (specificMatches.length > 0) {
      // Prefer profile with FTP or LTHR data
      const withData = specificMatches.find((s: any) => s.ftp !== null || s.lthr !== null)
      return withData || specificMatches[0]
    }

    // 2. Partial match (e.g. "Ride" matches "VirtualRide")?
    const partialMatches = allSettings.filter(
      (s: any) => !s.isDefault && s.types && s.types.some((t: string) => activityType.includes(t))
    )
    if (partialMatches.length > 0) {
      const withData = partialMatches.find((s: any) => s.ftp !== null || s.lthr !== null)
      return withData || partialMatches[0]
    }

    // 3. Fallback to Default
    return allSettings.find((s: any) => s.isDefault)
  },

  /**
   * Upsert a list of settings (used by sync or manual update).
   * Ensures Default profile is preserved/updated correctly.
   */
  async upsertSettings(userId: string, settingsPayload: any[]) {
    const prisma = globalPrisma
    // We handle updates by iterating.
    // Identify by ID if present, or externalId+source.

    const results = []

    for (const setting of settingsPayload) {
      // Prevent unsetting isDefault on the default profile if payload tries to
      if (setting.isDefault === false && setting.externalId?.startsWith('default_')) {
        setting.isDefault = true
      }

      // Logic to find existing record
      if (setting.id) {
        const existing = await prisma.sportSettings.findUnique({ where: { id: setting.id } })
        if (existing) {
          if (existing.userId !== userId) {
            throw createError({ statusCode: 404, message: 'Sport settings not found' })
          }
          const { targetPolicy, loadPreference, targetFormatPolicy } =
            resolveTargetPolicyAndLoadPreference(setting)
          const updated = await prisma.sportSettings.update({
            where: { id: existing.id, userId },
            data: {
              name: setting.name,
              types: setting.types,
              ftp: setting.ftp,
              indoorFtp: setting.indoorFtp,
              wPrime: setting.wPrime,
              powerZones: setting.powerZones || undefined,
              eFtp: setting.eFtp,
              eWPrime: setting.eWPrime,
              pMax: setting.pMax,
              ePMax: setting.ePMax,
              powerSpikeThreshold: setting.powerSpikeThreshold,
              eftpMinDuration: setting.eftpMinDuration,
              lthr: setting.lthr,
              maxHr: setting.maxHr,
              hrZones: setting.hrZones || undefined,
              restingHr: setting.restingHr,
              hrLoadType: setting.hrLoadType,
              thresholdPace: setting.thresholdPace,
              paceZones: setting.paceZones || undefined,
              warmupTime: setting.warmupTime,
              cooldownTime: setting.cooldownTime,
              loadPreference,
              zoneConfiguration: setting.zoneConfiguration || undefined,
              targetPolicy: toPrismaInputJsonValue(targetPolicy),
              targetFormatPolicy: toPrismaInputJsonValue(targetFormatPolicy)
            }
          })

          // Sync back to User model if this is the Default profile
          if (updated.isDefault) {
            await prisma.user.update({
              where: { id: userId },
              data: {
                ftp: updated.ftp,
                lthr: updated.lthr,
                maxHr: updated.maxHr,
                restingHr: updated.restingHr
              }
            })
          }

          results.push(normalizePersistedSetting(updated))
          continue
        }
      }

      if (setting.externalId && setting.source) {
        const { targetPolicy, loadPreference, targetFormatPolicy } =
          resolveTargetPolicyAndLoadPreference(setting)
        // Use upsert to handle race conditions
        const upserted = await prisma.sportSettings.upsert({
          where: {
            userId_source_externalId: {
              userId,
              source: setting.source,
              externalId: setting.externalId
            }
          },
          update: {
            name: setting.name,
            types: setting.types,
            ftp: setting.ftp,
            indoorFtp: setting.indoorFtp,
            wPrime: setting.wPrime,
            powerZones: setting.powerZones || undefined,
            eFtp: setting.eFtp,
            eWPrime: setting.eWPrime,
            pMax: setting.pMax,
            ePMax: setting.ePMax,
            powerSpikeThreshold: setting.powerSpikeThreshold,
            eftpMinDuration: setting.eftpMinDuration,
            lthr: setting.lthr,
            maxHr: setting.maxHr,
            hrZones: setting.hrZones || undefined,
            restingHr: setting.restingHr,
            hrLoadType: setting.hrLoadType,
            thresholdPace: setting.thresholdPace,
            paceZones: setting.paceZones || undefined,
            warmupTime: setting.warmupTime,
            cooldownTime: setting.cooldownTime,
            loadPreference,
            zoneConfiguration: setting.zoneConfiguration || undefined,
            targetPolicy: toPrismaInputJsonValue(targetPolicy),
            targetFormatPolicy: toPrismaInputJsonValue(targetFormatPolicy)
          },
          create: {
            userId,
            ...setting,
            loadPreference,
            source: setting.source,
            externalId: setting.externalId,
            targetPolicy: toPrismaInputJsonValue(targetPolicy),
            targetFormatPolicy: toPrismaInputJsonValue(targetFormatPolicy)
          }
        })

        // Sync back to User model if this is the Default profile
        if (upserted.isDefault) {
          await prisma.user.update({
            where: { id: userId },
            data: {
              ftp: upserted.ftp,
              lthr: upserted.lthr,
              maxHr: upserted.maxHr,
              restingHr: upserted.restingHr
            }
          })
        }

        results.push(normalizePersistedSetting(upserted))
        continue
      }

      // Create new (Fallback)
      const { targetPolicy, loadPreference, targetFormatPolicy } =
        resolveTargetPolicyAndLoadPreference(setting)
      const created = await prisma.sportSettings.create({
        data: {
          userId,
          ...setting,
          loadPreference,
          targetPolicy: toPrismaInputJsonValue(targetPolicy),
          targetFormatPolicy: toPrismaInputJsonValue(targetFormatPolicy),
          source: setting.source || 'manual',
          externalId: setting.externalId || `manual_${Date.now()}`
        }
      })
      results.push(normalizePersistedSetting(created))
    }

    // Optional: Delete removed profiles?
    // Usually "update" replaces the list.
    // If we want full replacement behavior (except Default), we need to know IDs to keep.
    // For now, we assume this method is just upserting what is passed.

    return results
  }
}
