// @vitest-environment nuxt

import { clearNuxtState } from '#app'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useQuotaPaywall } from '../../../../app/composables/useQuotaPaywall'

const { mockShowUpgradeModal, mockNavigateTo } = vi.hoisted(() => ({
  mockShowUpgradeModal: vi.fn(),
  mockNavigateTo: vi.fn().mockResolvedValue(undefined)
}))

mockNuxtImport('navigateTo', () => mockNavigateTo)
mockNuxtImport('useRoute', () => () => ({ fullPath: '/dashboard?view=today' }))

mockNuxtImport('useUpgradeModal', () => () => ({ show: mockShowUpgradeModal }))
mockNuxtImport('useUserStore', () => () => ({ user: { subscriptionTier: 'FREE' } }))

describe('useQuotaPaywall Composable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearNuxtState('profileQuotaSummary')
    clearNuxtState('profileQuotaSummaryFetchedAt')
    vi.stubGlobal('$fetch', vi.fn())
  })

  it('correctly detects quota exhaustion status', () => {
    const { isQuotaExhausted } = useQuotaPaywall()

    const activeQuota = {
      operation: 'ai_chat_message',
      limit: 10,
      used: 5,
      remaining: 5,
      resetsAt: new Date(Date.now() + 3600000).toISOString(),
      allowed: true
    }

    const exhaustedQuota = {
      operation: 'ai_chat_message',
      limit: 10,
      used: 10,
      remaining: 0,
      resetsAt: new Date(Date.now() + 3600000).toISOString(),
      allowed: false
    }

    expect(isQuotaExhausted(activeQuota as any)).toBe(false)
    expect(isQuotaExhausted(exhaustedQuota as any)).toBe(true)
  })

  it('determines showQuotaMeter based on subscription tier', () => {
    const { shouldShowQuotaMeterForUser } = useQuotaPaywall()
    expect(shouldShowQuotaMeterForUser()).toBe(true)
  })

  it('triggers upgrade modal via showQuotaPaywall', async () => {
    const { showQuotaPaywall } = useQuotaPaywall()

    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        tier: 'FREE',
        effectiveTier: 'FREE',
        quotas: []
      })
    )

    await showQuotaPaywall({
      featureTitle: 'AI Chat Advisor'
    })

    expect(mockShowUpgradeModal).toHaveBeenCalledWith(
      expect.objectContaining({
        featureTitle: 'AI Chat Advisor',
        title: 'Upgrade Your Plan'
      })
    )
  })
  it('contains concurrent network failures, keeps quota unknown, and retries successfully', async () => {
    const paywall = useQuotaPaywall()
    const onAllowed = vi.fn()
    const fetch = vi.fn().mockRejectedValue(new TypeError('Load failed'))
    vi.stubGlobal('$fetch', fetch)

    await expect(
      Promise.all([paywall.ensureQuotasLoaded(), paywall.ensureQuotasLoaded()])
    ).resolves.toEqual([null, null])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(paywall.quotaSummary.value).toBeNull()
    expect(paywall.getQuotaForOperation('ai_chat_message')).toBeNull()
    await paywall.handleLockedAction({
      operation: 'ai_chat_message',
      featureTitle: 'Chat',
      onAllowed
    })
    expect(onAllowed).not.toHaveBeenCalled()
    expect(mockShowUpgradeModal).not.toHaveBeenCalled()
    expect(mockNavigateTo).not.toHaveBeenCalled()

    const summary = {
      tier: 'FREE',
      effectiveTier: 'FREE',
      quotas: [
        {
          operation: 'ai_chat_message',
          limit: 10,
          remaining: 5,
          allowed: true
        }
      ]
    }
    fetch.mockResolvedValue(summary)
    await paywall.handleLockedAction({
      operation: 'ai_chat_message',
      featureTitle: 'Chat',
      onAllowed
    })
    expect(paywall.quotaSummary.value).toEqual(summary)
    expect(onAllowed).toHaveBeenCalledOnce()
  })

  it.each([{ statusCode: 401 }, { response: { status: 401 } }])(
    'redirects unauthorized fetch failures through the login flow: %j',
    async (error) => {
      vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(error))
      const paywall = useQuotaPaywall()
      await expect(paywall.getOperationQuota('ai_chat_message')).resolves.toBeNull()
      expect(paywall.quotaSummary.value).toBeNull()
      expect(mockNavigateTo).toHaveBeenCalledWith('/login?callbackUrl=%2Fdashboard%3Fview%3Dtoday')
      expect(mockShowUpgradeModal).not.toHaveBeenCalled()
    }
  )

  it('invalidates a previously exhausted snapshot after refresh failure', async () => {
    const fetch = vi.fn().mockResolvedValue({
      tier: 'FREE',
      effectiveTier: 'FREE',
      quotas: [
        {
          operation: 'ai_chat_message',
          limit: 10,
          remaining: 0,
          allowed: false
        }
      ]
    })
    vi.stubGlobal('$fetch', fetch)
    const paywall = useQuotaPaywall()
    await paywall.ensureQuotasLoaded()
    expect(paywall.isQuotaExhausted(paywall.getQuotaForOperation('ai_chat_message'))).toBe(true)
    fetch.mockRejectedValue(new Error('offline'))
    await expect(paywall.ensureQuotasLoaded({ force: true })).resolves.toBeNull()
    expect(paywall.getQuotaForOperation('ai_chat_message')).toBeNull()
    expect(paywall.quotaSummary.value).toBeNull()
  })
})
