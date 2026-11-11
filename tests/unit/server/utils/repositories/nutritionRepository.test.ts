import { Prisma } from '@prisma/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CONCURRENT_UPDATE_CONFLICT,
  nutritionRepository
} from '../../../../../server/utils/repositories/nutritionRepository'
import { prisma } from '../../../../../server/utils/db'

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    nutrition: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn()
    }
  }
}))

describe('nutritionRepository', () => {
  const userId = 'user-123'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getPendingAnalysis', () => {
    it('includes QUOTA_EXCEEDED alongside the other pending statuses so rate-limited records are re-processed', async () => {
      vi.mocked(prisma.nutrition.findMany).mockResolvedValue([])

      await nutritionRepository.getPendingAnalysis(userId)

      expect(prisma.nutrition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId,
            OR: expect.arrayContaining([
              { aiAnalysisStatus: null },
              { aiAnalysisStatus: 'NOT_STARTED' },
              { aiAnalysisStatus: 'PENDING' },
              { aiAnalysisStatus: 'FAILED' },
              { aiAnalysisStatus: 'QUOTA_EXCEEDED' }
            ])
          })
        })
      )
    })

    it('scopes to an end date when provided', async () => {
      vi.mocked(prisma.nutrition.findMany).mockResolvedValue([])
      const endDate = new Date('2026-01-01')

      await nutritionRepository.getPendingAnalysis(userId, endDate)

      expect(prisma.nutrition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId,
            date: { lte: endDate }
          })
        })
      )
    })
  })
  describe('saveWithVersionCheck', () => {
    const date = new Date('2026-07-21')
    const snapshot = { id: 'n1', updatedAt: new Date('2026-07-21') }
    const data = { breakfast: [{ id: 'food', calories: 100 }], calories: 100 }
    const error = (code: string) =>
      new Prisma.PrismaClientKnownRequestError('race', { code, clientVersion: '7' })

    it('atomically guards user, day and version and advances the token', async () => {
      vi.mocked(prisma.nutrition.update).mockResolvedValue({ id: 'n1' } as any)
      expect(
        await nutritionRepository.saveWithVersionCheck(userId, date, snapshot, data, 'oauth:app')
      ).toEqual({ id: 'n1' })
      const args = vi.mocked(prisma.nutrition.update).mock.calls[0]![0]
      expect(args.where).toEqual({ id: 'n1', userId, date, updatedAt: snapshot.updatedAt })
      expect(args.data).toMatchObject({ ...data, sourcePrecedence: 'oauth:app' })
      expect((args.data.updatedAt as Date).getTime()).toBeGreaterThan(snapshot.updatedAt.getTime())
      expect(prisma.nutrition.upsert).not.toHaveBeenCalled()
    })

    it('creates only, leaving unique-key arbitration to the database', async () => {
      vi.mocked(prisma.nutrition.create).mockResolvedValue({ id: 'n1' } as any)
      await nutritionRepository.saveWithVersionCheck(userId, date, null, data, 'manual')
      expect(prisma.nutrition.create).toHaveBeenCalledWith({
        data: { ...data, userId, date, sourcePrecedence: 'manual' }
      })
      expect(prisma.nutrition.update).not.toHaveBeenCalled()
    })

    it('translates a stale update or concurrent creation into a conflict', async () => {
      vi.mocked(prisma.nutrition.update).mockRejectedValueOnce(error('P2025'))
      vi.mocked(prisma.nutrition.create).mockRejectedValueOnce(error('P2002'))
      expect(
        await nutritionRepository.saveWithVersionCheck(userId, date, snapshot, data, 'manual')
      ).toBe(CONCURRENT_UPDATE_CONFLICT)
      expect(
        await nutritionRepository.saveWithVersionCheck(userId, date, null, data, 'manual')
      ).toBe(CONCURRENT_UPDATE_CONFLICT)
    })

    it('propagates unrelated database errors', async () => {
      const failure = error('P1001')
      vi.mocked(prisma.nutrition.update).mockRejectedValueOnce(failure)
      await expect(
        nutritionRepository.saveWithVersionCheck(userId, date, snapshot, data, 'manual')
      ).rejects.toBe(failure)
    })

    it('keeps unguarded upsert semantics for unrelated callers', async () => {
      vi.mocked(prisma.nutrition.findUnique).mockResolvedValue(null)
      vi.mocked(prisma.nutrition.upsert).mockResolvedValue({ id: 'n1' } as any)
      const result = await nutritionRepository.upsert(
        userId,
        date,
        { userId, date, ...data },
        data,
        'provider'
      )
      expect(result).toEqual({ record: { id: 'n1' }, isNew: true })
      expect(prisma.nutrition.upsert).toHaveBeenCalledWith({
        where: { userId_date: { userId, date } },
        create: { userId, date, ...data, sourcePrecedence: 'provider' },
        update: { ...data, sourcePrecedence: 'provider' }
      })
    })
  })
})
