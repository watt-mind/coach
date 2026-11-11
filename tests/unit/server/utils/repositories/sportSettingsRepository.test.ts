import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sportSettingsRepository } from '../../../../../server/utils/repositories/sportSettingsRepository'
import { prisma } from '../../../../../server/utils/db'

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    sportSettings: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      findFirst: vi.fn()
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn()
    }
  }
}))

describe('sportSettingsRepository', () => {
  const userId = 'user-123'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getByUserId', () => {
    it('should return existing settings and not create default if it exists', async () => {
      const mockSettings = [{ isDefault: true, id: 's-1', ftp: 250 }]
      vi.mocked(prisma.sportSettings.findMany).mockResolvedValue(mockSettings as any)

      const result = await sportSettingsRepository.getByUserId(userId)

      expect(result[0]).toMatchObject({
        isDefault: true,
        id: 's-1',
        ftp: 250,
        loadPreference: 'HR_PACE_POWER'
      })
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('should lazy-create default profile if missing', async () => {
      vi.mocked(prisma.sportSettings.findMany).mockResolvedValue([] as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        ftp: 200,
        lthr: 160,
        maxHr: 180,
        restingHr: 50
      } as any)
      // createDefault upserts on the external id so concurrent callers cannot race a duplicate.
      vi.mocked(prisma.sportSettings.upsert).mockResolvedValue({
        isDefault: true,
        id: 'new-def',
        ftp: 200
      } as any)

      const result = await sportSettingsRepository.getByUserId(userId)

      expect(prisma.sportSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            userId,
            isDefault: true,
            ftp: 200,
            loadPreference: 'HR_PACE_POWER'
          })
        })
      )
      expect(result[0].isDefault).toBe(true)
    })
  })

  describe('upsertSettings', () => {
    it.each([false, true])(
      'rejects a foreign setting (default=%s) without any writes',
      async (isDefault) => {
        vi.mocked(prisma.sportSettings.findUnique).mockResolvedValue({
          id: 'foreign-setting',
          userId: 'other-athlete',
          isDefault
        } as any)
        await expect(
          sportSettingsRepository.upsertSettings(userId, [
            {
              id: 'foreign-setting',
              ftp: 1,
              source: 'manual',
              externalId: 'fallback'
            }
          ])
        ).rejects.toMatchObject({ statusCode: 404 })
        expect(prisma.sportSettings.update).not.toHaveBeenCalled()
        expect(prisma.sportSettings.upsert).not.toHaveBeenCalled()
        expect(prisma.sportSettings.create).not.toHaveBeenCalled()
        expect(prisma.user.update).not.toHaveBeenCalled()
      }
    )

    it('scopes owned ID updates to the authenticated owner', async () => {
      vi.mocked(prisma.sportSettings.findUnique).mockResolvedValue({
        id: 'owned-setting',
        userId,
        isDefault: false
      } as any)
      vi.mocked(prisma.sportSettings.update).mockResolvedValue({
        id: 'owned-setting',
        userId,
        isDefault: false,
        ftp: 280
      } as any)
      const result = await sportSettingsRepository.upsertSettings(userId, [
        { id: 'owned-setting', ftp: 280 }
      ])
      expect(prisma.sportSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'owned-setting', userId }
        })
      )
      expect(result[0]).toMatchObject({ id: 'owned-setting', ftp: 280 })
    })

    it('preserves fallback creation when the supplied ID does not exist', async () => {
      vi.mocked(prisma.sportSettings.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.sportSettings.create).mockResolvedValue({
        id: 'missing-setting',
        userId,
        isDefault: false
      } as any)
      await sportSettingsRepository.upsertSettings(userId, [
        { id: 'missing-setting', types: ['Run'] }
      ])
      expect(prisma.sportSettings.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ id: 'missing-setting', userId, types: ['Run'] })
        })
      )
    })

    it('preserves the owner-scoped external ID upsert', async () => {
      vi.mocked(prisma.sportSettings.upsert).mockResolvedValue({
        id: 'imported-setting',
        userId,
        isDefault: false
      } as any)
      await sportSettingsRepository.upsertSettings(userId, [
        { source: 'intervals', externalId: 'ride', ftp: 270 }
      ])
      expect(prisma.sportSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_source_externalId: { userId, source: 'intervals', externalId: 'ride' } },
          create: expect.objectContaining({ userId, source: 'intervals', externalId: 'ride' })
        })
      )
    })

    it('should sync Default profile updates back to legacy User fields', async () => {
      const settingsPayload = [
        {
          id: 's-default',
          isDefault: true,
          ftp: 300,
          lthr: 170,
          maxHr: 190,
          restingHr: 55
        }
      ]

      vi.mocked(prisma.sportSettings.findUnique).mockResolvedValue({
        id: 's-default',
        userId,
        isDefault: true
      } as any)
      vi.mocked(prisma.sportSettings.update).mockResolvedValue({
        id: 's-default',
        isDefault: true,
        ftp: 300,
        lthr: 170,
        maxHr: 190,
        restingHr: 55
      } as any)

      await sportSettingsRepository.upsertSettings(userId, settingsPayload)

      // Verify sport settings update
      expect(prisma.sportSettings.update).toHaveBeenCalled()

      // Verify sync back to user
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: {
          ftp: 300,
          lthr: 170,
          maxHr: 190,
          restingHr: 55
        }
      })
    })

    it('should NOT sync back to User if setting is not Default', async () => {
      const settingsPayload = [
        {
          id: 's-run',
          isDefault: false,
          types: ['Run'],
          ftp: 280
        }
      ]

      vi.mocked(prisma.sportSettings.findUnique).mockResolvedValue({
        id: 's-run',
        userId,
        isDefault: false
      } as any)
      vi.mocked(prisma.sportSettings.update).mockResolvedValue({
        id: 's-run',
        isDefault: false,
        ftp: 280
      } as any)

      await sportSettingsRepository.upsertSettings(userId, settingsPayload)

      expect(prisma.sportSettings.update).toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it('preserves explicit value target style in normalized responses', async () => {
      const settingsPayload = [
        {
          id: 's-ride',
          isDefault: false,
          types: ['Ride'],
          targetPolicy: {
            primaryMetric: 'power',
            defaultTargetStyle: 'value',
            preferRangesForSteady: true
          }
        }
      ]

      vi.mocked(prisma.sportSettings.findUnique).mockResolvedValue({
        id: 's-ride',
        userId,
        isDefault: false
      } as any)
      vi.mocked(prisma.sportSettings.update).mockResolvedValue({
        id: 's-ride',
        isDefault: false,
        types: ['Ride'],
        loadPreference: 'POWER_HR_PACE',
        targetPolicy: {
          primaryMetric: 'power',
          defaultTargetStyle: 'value',
          preferRangesForSteady: true
        }
      } as any)

      const result = await sportSettingsRepository.upsertSettings(userId, settingsPayload)

      expect(result[0]?.targetPolicy).toMatchObject({
        primaryMetric: 'power',
        defaultTargetStyle: 'value',
        preferRangesForSteady: true
      })
      expect(result[0]?.loadPreference).toBe('POWER_HR_PACE')
    })
  })
})
