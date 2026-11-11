import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '../../../../server/utils/db'
import { getActivePromotionalGrant } from '../../../../server/utils/partner-campaigns'
import { recordQuotaDenial } from '../../../../server/utils/quotas/engine'

vi.mock('../../../../server/utils/partner-campaigns', () => ({
  getActivePromotionalGrant: vi.fn()
}))

vi.mock('../../../../server/utils/db', () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    quotaDenial: { create: vi.fn() },
    $queryRaw: vi.fn()
  }
}))

vi.mock('../../../../server/utils/date', () => ({
  getUserTimezone: vi.fn(),
  getStartOfDayUTC: vi.fn(() => new Date('2026-03-08T00:00:00.000Z')),
  getEndOfDayUTC: vi.fn(() => new Date('2026-03-08T23:59:59.999Z'))
}))

describe('quota engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws an H3-style 429 error when a strict quota is exceeded', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      subscriptionTier: 'FREE',
      subscriptionStatus: 'NONE',
      subscriptionPeriodEnd: null,
      trialEndsAt: null,
      timezone: 'UTC'
    } as any)
    vi.mocked(getActivePromotionalGrant).mockResolvedValue(null)

    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        count: 3,
        firstUsedAt: new Date('2026-03-01T00:00:00.000Z')
      }
    ] as any)

    vi.mocked(prisma.quotaDenial.create).mockResolvedValue({} as any)

    const { checkQuota } = await import('../../../../server/utils/quotas/engine')

    await expect(checkQuota('user-123', 'wellness_analysis')).rejects.toMatchObject({
      statusCode: 429,
      statusMessage: 'Quota exceeded for wellness_analysis. Upgrade your plan for higher limits.',
      data: {
        operation: 'wellness_analysis',
        quotaExceeded: true
      },
      quotaExceeded: true
    })
  })

  it('records quota denial without throwing when persistence fails', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      subscriptionTier: 'FREE',
      subscriptionStatus: 'NONE',
      subscriptionPeriodEnd: null,
      trialEndsAt: null
    } as any)
    vi.mocked(getActivePromotionalGrant).mockResolvedValue(null)
    vi.mocked(prisma.quotaDenial.create).mockRejectedValue(new Error('db down'))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      recordQuotaDenial('user-123', 'daily_checkin', { used: 1, limit: 1 })
    ).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('maps trial users to SUPPORTER tier when recording denials', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      subscriptionTier: 'FREE',
      subscriptionStatus: 'NONE',
      subscriptionPeriodEnd: null,
      trialEndsAt: new Date('2099-01-01T00:00:00.000Z')
    } as any)
    vi.mocked(getActivePromotionalGrant).mockResolvedValue(null)
    vi.mocked(prisma.quotaDenial.create).mockResolvedValue({} as any)

    await recordQuotaDenial('user-123', 'daily_checkin', { used: 2, limit: 2 })

    expect(prisma.quotaDenial.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tier: 'SUPPORTER'
      })
    })
  })

  it('uses promotional PRO grants for quota tier resolution', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      subscriptionTier: 'FREE',
      subscriptionStatus: 'NONE',
      subscriptionPeriodEnd: null,
      trialEndsAt: null
    } as any)
    vi.mocked(getActivePromotionalGrant).mockResolvedValue({
      tier: 'PRO',
      endsAt: new Date('2099-01-01T00:00:00.000Z'),
      campaignSlug: 'skool4cyclists',
      partnerName: 'Jack Burke / SKOOL 4 Cyclists',
      campaignName: 'SKOOL 4 Cyclists PRO pilot'
    })
    vi.mocked(prisma.quotaDenial.create).mockResolvedValue({} as any)

    await recordQuotaDenial('user-123', 'daily_checkin', { used: 2, limit: 2 })

    expect(prisma.quotaDenial.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tier: 'PRO'
      })
    })
  })
})

describe('unified recurring report quota (CW-846)', () => {
  const freeUser = {
    subscriptionTier: 'FREE',
    subscriptionStatus: 'NONE',
    subscriptionPeriodEnd: null,
    trialEndsAt: null,
    timezone: 'UTC'
  } as any

  interface FakeUsageRow {
    userId: string
    operation: string
    success: boolean
    counted: boolean
    createdAt: Date
  }

  function mockUsageTable(rows: FakeUsageRow[]) {
    vi.mocked(prisma.$queryRaw).mockImplementation(async (strings: any, ...params: any[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings)
      // The engine must filter in SQL: exact operation, counted successes only.
      expect(sql).toContain('"operation"')
      expect(sql).toContain('"success"')
      expect(sql).toContain('"counted"')

      const [userId, operation, window] = params
      expect(userId).toBe('user-1')
      expect(operation).toBe('unified_report_generation')
      expect(window).toBe('30 days')

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const matching = rows.filter(
        (row) =>
          row.userId === userId &&
          row.operation === operation &&
          row.success === true &&
          row.counted === true &&
          row.createdAt >= cutoff
      )
      const firstUsedAt =
        matching.length > 0
          ? matching.map((row) => row.createdAt).sort((a, b) => a.getTime() - b.getTime())[0]
          : null
      return [{ count: matching.length, firstUsedAt }] as any
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.user.findUnique).mockResolvedValue(freeUser)
    vi.mocked(getActivePromotionalGrant).mockResolvedValue(null)
    vi.mocked(prisma.quotaDenial.create).mockResolvedValue({} as any)
  })

  it('denies the next recurring report at the FREE limit of 1 per 30 days', async () => {
    mockUsageTable([
      {
        userId: 'user-1',
        operation: 'unified_report_generation',
        success: true,
        counted: true,
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000)
      }
    ])

    const { checkQuota } = await import('../../../../server/utils/quotas/engine')

    await expect(checkQuota('user-1', 'unified_report_generation')).rejects.toMatchObject({
      statusCode: 429,
      quotaExceeded: true,
      data: {
        code: 'QUOTA_EXCEEDED',
        operation: 'unified_report_generation',
        limit: 1,
        used: 1,
        remaining: 0,
        window: '30 days',
        quotaExceeded: true
      }
    })
  })

  it('allows recurring reports below the limit', async () => {
    mockUsageTable([])

    const { checkQuota } = await import('../../../../server/utils/quotas/engine')

    const status = await checkQuota('user-1', 'unified_report_generation')
    expect(status).toMatchObject({
      allowed: true,
      used: 0,
      limit: 1,
      operation: 'unified_report_generation'
    })
  })

  it('does not consume allowance for failed, uncounted, out-of-window, or legacy-operation rows', async () => {
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    mockUsageTable([
      {
        userId: 'user-1',
        operation: 'unified_report_generation',
        success: false,
        counted: true,
        createdAt: recent
      },
      {
        userId: 'user-1',
        operation: 'unified_report_generation',
        success: true,
        counted: false,
        createdAt: recent
      },
      {
        userId: 'user-1',
        operation: 'unified_report_generation',
        success: true,
        counted: true,
        createdAt: old
      },
      {
        userId: 'user-1',
        operation: 'nutrition_analysis',
        success: true,
        counted: true,
        createdAt: recent
      }
    ])

    const { checkQuota } = await import('../../../../server/utils/quotas/engine')

    const status = await checkQuota('user-1', 'unified_report_generation')
    expect(status).toMatchObject({ allowed: true, used: 0, limit: 1 })
  })
})
