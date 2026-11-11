import type { PricingTier } from '~/utils/pricing'
import type { QuotaStatus } from '~/types/quotas'
import type { SubscriptionTier } from '@prisma/client'
import {
  buildQuotaFeatureDescription,
  buildQuotaUpgradeBullets,
  hasQuotaResetPassed,
  resolveRecommendedUpgradeTier,
  type QuotaPaywallOperation
} from '~~/shared/quota-paywall'
import { useNow } from '@vueuse/core'

interface QuotaSummaryResponse {
  tier: SubscriptionTier
  effectiveTier: SubscriptionTier
  isTrialActive: boolean
  showQuotaMeter: boolean
  trialEndsAt: Date | string | null
  quotas: QuotaStatus[]
}

const QUOTA_CACHE_TTL_MS = 30_000

/** Warn from this many uses left; above it the countdown stays hidden. */
const LOW_ALLOWANCE_THRESHOLD = 2

export interface QuotaPaywallOptions {
  operation?: QuotaPaywallOperation
  title?: string
  featureTitle: string
  featureDescription?: string
  recommendedTier?: PricingTier
  bullets?: string[]
  reason?: string
  quota?: QuotaStatus | null
  quotaResetLabel?: string
}

export function useQuotaPaywall() {
  const upgradeModal = useUpgradeModal()
  const userStore = useUserStore()
  const route = useRoute()
  const quotasState = useState<QuotaSummaryResponse | null>('profileQuotaSummary', () => null)
  const quotasFetchedAt = useState<number>('profileQuotaSummaryFetchedAt', () => 0)
  let refreshPromise: Promise<QuotaSummaryResponse | null> | null = null

  const quotaSummary = computed(() => quotasState.value)

  function snapshotNeedsRefresh(now = new Date()) {
    if (!quotasState.value) return true
    if (Date.now() - quotasFetchedAt.value >= QUOTA_CACHE_TTL_MS) return true
    return quotasState.value.quotas.some((quota) => hasQuotaResetPassed(quota.resetsAt, now))
  }

  async function ensureQuotasLoaded(options: { force?: boolean } = {}) {
    if (!options.force && !snapshotNeedsRefresh()) return quotasState.value!
    if (refreshPromise) return refreshPromise

    // Share the handled result, so concurrent callers never inherit a rejection.
    refreshPromise = (async () => {
      try {
        const summary = await (($fetch as any)(
          '/api/profile/quotas'
        ) as Promise<QuotaSummaryResponse>)
        quotasState.value = summary
        quotasFetchedAt.value = Date.now()
        return summary
      } catch (error) {
        quotasState.value = null
        quotasFetchedAt.value = 0
        const failure = error as {
          statusCode?: number
          status?: number
          response?: { status: number }
        }
        if ((failure?.statusCode ?? failure?.status ?? failure?.response?.status) === 401) {
          // Match the auth middleware's unauthenticated redirect.
          try {
            await navigateTo(`/login?callbackUrl=${encodeURIComponent(route.fullPath)}`)
          } catch {
            // A failed navigation must not turn an expected auth failure into a rejection.
          }
        }
        return null
      }
    })()
    try {
      return await refreshPromise
    } finally {
      refreshPromise = null
    }
  }

  function getQuotaForOperation(
    operation: string,
    quotas?: QuotaStatus[] | null
  ): QuotaStatus | null {
    const list = quotas || quotasState.value?.quotas
    if (!Array.isArray(list)) return null
    return list.find((entry) => entry.operation === operation) || null
  }

  function buildPaywallOptions(input: QuotaPaywallOptions) {
    const subscriptionTier = (userStore.user?.subscriptionTier || 'FREE') as SubscriptionTier
    const quota = input.quota ?? (input.operation ? getQuotaForOperation(input.operation) : null)
    const effectiveTier = quotasState.value?.effectiveTier || subscriptionTier
    const quotaNextTier = quota?.nextTier?.toLowerCase() as PricingTier | undefined
    const recommendedTier =
      input.recommendedTier ?? quotaNextTier ?? resolveRecommendedUpgradeTier(effectiveTier)
    const nextTierName = recommendedTier
      ? recommendedTier === 'pro'
        ? 'Pro'
        : 'Supporter'
      : undefined

    return {
      title: input.title || 'Upgrade Your Plan',
      featureTitle: input.featureTitle,
      featureDescription:
        input.featureDescription ||
        buildQuotaFeatureDescription({
          featureLabel: input.featureTitle,
          quota,
          nextTierName
        }),
      recommendedTier,
      bullets:
        input.bullets ||
        (input.operation
          ? buildQuotaUpgradeBullets(
              input.operation,
              quota?.nextTier || (recommendedTier === 'pro' ? 'PRO' : 'SUPPORTER'),
              quota?.nextTierLimit,
              quota?.window
            )
          : []),
      reason: input.reason || 'quota_exceeded',
      quotaResetLabel: input.quotaResetLabel,
      operation: input.operation
    }
  }

  async function showQuotaPaywall(input: QuotaPaywallOptions) {
    let resolvedInput = input
    if (input.operation) {
      await ensureQuotasLoaded({ force: true })
      resolvedInput = {
        ...input,
        quota: getQuotaForOperation(input.operation) ?? input.quota
      }
    }
    upgradeModal.show(buildPaywallOptions(resolvedInput))
  }

  async function getOperationQuota(operation: string) {
    await ensureQuotasLoaded({ force: true })
    return getQuotaForOperation(operation)
  }

  function isQuotaExhausted(quota: QuotaStatus | null | undefined, now: Date = new Date()) {
    if (!quota) return false
    if (hasQuotaResetPassed(quota.resetsAt, now)) return false
    return quota.remaining <= 0 || !quota.allowed
  }

  /** The usage meter is a FREE-tier affordance; limits themselves are not. */
  function shouldShowQuotaMeterForUser() {
    return userStore.user?.subscriptionTier === 'FREE'
  }

  async function handleLockedAction(params: {
    operation: QuotaPaywallOperation
    featureTitle: string
    onAllowed: () => void | Promise<void>
  }) {
    // Paid tiers have limits too — skipping the check here sent Supporter and
    // Pro athletes into a raw server error instead of the paywall.
    const summary = await ensureQuotasLoaded()
    if (!summary) return
    const quota = getQuotaForOperation(params.operation)
    if (!quota) return
    if (isQuotaExhausted(quota)) {
      await showQuotaPaywall({
        operation: params.operation,
        featureTitle: params.featureTitle,
        reason: 'locked_affordance',
        quota
      })
      return
    }

    await params.onAllowed()
  }

  function useOperationLockState(operation: QuotaPaywallOperation) {
    const now = useNow({ interval: 30_000 })
    const locked = computed(() => isQuotaExhausted(getQuotaForOperation(operation), now.value))

    const lockedTierLabel = computed(() => {
      const quota = getQuotaForOperation(operation)
      if (quota?.nextTier === 'PRO') return 'Pro'
      if (quota?.nextTier === 'SUPPORTER') return 'Supporter'

      const subscriptionTier =
        quotasState.value?.effectiveTier ||
        ((userStore.user?.subscriptionTier || 'FREE') as SubscriptionTier)
      const recommendedTier = resolveRecommendedUpgradeTier(subscriptionTier)
      return recommendedTier === 'pro' ? 'Pro' : recommendedTier === 'supporter' ? 'Supporter' : ''
    })

    const remaining = computed(() => {
      const quota = getQuotaForOperation(operation)
      if (!quota || !Number.isFinite(quota.limit)) return null
      if (hasQuotaResetPassed(quota.resetsAt, now.value)) return quota.limit
      return Math.max(0, quota.remaining)
    })

    /**
     * Short warning for the trigger control, so an athlete is never surprised
     * mid-task. Silent until the allowance is nearly gone — a countdown on every
     * button would just be noise.
     */
    const remainingLabel = computed(() => {
      const left = remaining.value
      if (left === null || left > LOW_ALLOWANCE_THRESHOLD || locked.value) return null
      if (left === 0) return 'None left'
      return left === 1 ? '1 left' : `${left} left`
    })

    onMounted(() => {
      void ensureQuotasLoaded()
    })

    return { locked, lockedTierLabel, remaining, remainingLabel }
  }

  return {
    quotaSummary,
    ensureQuotasLoaded,
    getOperationQuota,
    getQuotaForOperation,
    isQuotaExhausted,
    shouldShowQuotaMeterForUser,
    showQuotaPaywall,
    buildPaywallOptions,
    handleLockedAction,
    useOperationLockState
  }
}
