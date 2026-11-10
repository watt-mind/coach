import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stripe } from '../../../../../server/utils/stripe'
import { prisma } from '../../../../../server/utils/db'
import { auditLogRepository } from '../../../../../server/utils/repositories/auditLogRepository'
import { resolveSubscriptionTier } from '../../../../../server/utils/subscription-tier'
import { upsertProviderSubscription } from '../../../../../server/utils/provider-subscriptions'
import { dispatchTask } from '../../../../../server/utils/task-dispatcher'
import { trackStripeInRevenueCat } from '../../../../../server/utils/revenuecat'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', () => {})
vi.stubGlobal('readRawBody', async (event: any) => event.__rawBody)
vi.stubGlobal('getHeader', (event: any, name: string) => event.__headers?.[name])
vi.stubGlobal('useRuntimeConfig', () => ({ stripeWebhookSecret: 'whsec_test_secret' }))
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message)
  ;(error as any).statusCode = err.statusCode
  return error
})

// `useRuntimeConfig` in webhook.post.ts is auto-imported from `#app/nuxt` at transform
// time (not resolved via the global stub above), so it must be mocked at the module level
// to avoid the real Nuxt composable throwing NUXT_E1001 outside of an app context.
vi.mock('#app/nuxt', () => ({
  useRuntimeConfig: () => ({ stripeWebhookSecret: 'whsec_test_secret' }),
  useNuxtApp: () => ({ $config: { stripeWebhookSecret: 'whsec_test_secret' } })
}))

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn()
    }
  }
}))

vi.mock('../../../../../server/utils/stripe', () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn()
    },
    subscriptions: {
      retrieve: vi.fn()
    }
  }
}))

vi.mock('../../../../../server/utils/repositories/auditLogRepository', () => ({
  auditLogRepository: {
    log: vi.fn()
  }
}))

vi.mock('../../../../../server/utils/task-dispatcher', () => ({
  dispatchTask: vi.fn()
}))

vi.mock('../../../../../server/utils/subscription-tier', () => ({
  getPriceProductId: vi.fn(() => 'prod_1'),
  resolveSubscriptionTier: vi.fn(async () => 'PRO')
}))

vi.mock('../../../../../server/utils/provider-subscriptions', () => ({
  upsertProviderSubscription: vi.fn(async () => ({ stale: false }))
}))

vi.mock('../../../../../server/utils/revenuecat', () => ({
  trackStripeInRevenueCat: vi.fn()
}))

const getHandler = async () =>
  (await import('../../../../../server/api/stripe/webhook.post')).default

const buildEvent = (rawBody: string, headers: Record<string, string> = {}) => ({
  __rawBody: rawBody,
  __headers: headers
})

describe('POST /api/stripe/webhook error sanitization', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user_coach' } as any)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('returns a sanitized message when signature verification fails, without leaking internal error details', async () => {
    const handler = await getHandler()

    const sensitiveMessage =
      'No signatures found matching the expected signature for payload. Are you passing the raw request body? secret=whsec_super_secret_value'
    vi.mocked(stripe.webhooks.constructEvent).mockImplementation(() => {
      throw new Error(sensitiveMessage)
    })

    const event = buildEvent('{"type":"checkout.session.completed"}', {
      'stripe-signature': 'bad-signature'
    })

    await expect(handler(event as any)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Webhook verification failed'
    })

    // Ensure the raw error message never leaks into the thrown error.
    await handler(event as any).catch((err: any) => {
      expect(err.message).not.toContain(sensitiveMessage)
      expect(err.message).not.toContain('whsec_super_secret_value')
    })

    // But it must still be logged server-side for debugging.
    const loggedSensitive = consoleErrorSpy.mock.calls.some((call) =>
      call.some((arg) =>
        arg instanceof Error
          ? arg.message.includes(sensitiveMessage)
          : typeof arg === 'string' && arg.includes(sensitiveMessage)
      )
    )
    expect(loggedSensitive).toBe(true)
  })

  it('returns a sanitized message when event processing fails, without leaking internal error details', async () => {
    const handler = await getHandler()

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: 'checkout.session.completed',
      id: 'evt_123',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'cs_123', customer: 'cus_123' } }
    } as any)

    const sensitiveMessage = 'relation "users" violates foreign key constraint on column secret_id'
    vi.mocked(auditLogRepository.log).mockRejectedValue(new Error(sensitiveMessage))

    const event = buildEvent('{"type":"checkout.session.completed"}', {
      'stripe-signature': 'good-signature'
    })

    await expect(handler(event as any)).rejects.toMatchObject({
      statusCode: 500,
      message: 'Webhook processing failed'
    })

    await handler(event as any).catch((err: any) => {
      expect(err.message).not.toContain(sensitiveMessage)
    })

    const loggedSensitive = consoleErrorSpy.mock.calls.some((call) =>
      call.some((arg) =>
        arg instanceof Error
          ? arg.message.includes(sensitiveMessage)
          : typeof arg === 'string' && arg.includes(sensitiveMessage)
      )
    )
    expect(loggedSensitive).toBe(true)
  })
})

describe('POST /api/stripe/webhook customer ownership', () => {
  const customerId = 'cus_coach'
  const user = {
    id: 'user_coach',
    stripeCustomerId: customerId,
    subscriptionTier: 'PRO',
    subscriptionStatus: 'ACTIVE',
    subscriptionStartedAt: new Date('2026-01-01')
  }
  const subscription = {
    id: 'sub_coach',
    customer: customerId,
    status: 'active',
    created: 1780000000,
    current_period_end: 1790000000,
    livemode: true,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_coach', product: 'prod_coach' } }] }
  }

  async function deliver(type: string, object: Record<string, unknown>) {
    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      id: 'evt_ownership',
      type,
      created: 1785000000,
      data: { object }
    } as any)
    const handler = await getHandler()
    return handler(buildEvent('{}', { 'stripe-signature': 'valid-signature' }) as any)
  }

  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv('E2E_MODE', 'false')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.user.findMany).mockResolvedValue([])
    vi.mocked(resolveSubscriptionTier).mockRejectedValue(new Error('Unrelated product'))
    vi.mocked(upsertProviderSubscription).mockResolvedValue({ stale: false } as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it.each([
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'checkout.session.completed',
    'invoice.payment_failed',
    'invoice.payment_succeeded',
    'invoice.paid'
  ])('acknowledges unrelated %s without processing it', async (type) => {
    await expect(
      deliver(type, { ...subscription, customer: 'cus_unrelated', subscription: 'sub_other' })
    ).resolves.toEqual({ received: true })

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_unrelated' },
      select: { id: true }
    })
    expect(auditLogRepository.log).not.toHaveBeenCalled()
    expect(resolveSubscriptionTier).not.toHaveBeenCalled()
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled()
    expect(prisma.user.findMany).not.toHaveBeenCalled()
    expect(prisma.user.update).not.toHaveBeenCalled()
    expect(upsertProviderSubscription).not.toHaveBeenCalled()
    expect(dispatchTask).not.toHaveBeenCalled()
    expect(trackStripeInRevenueCat).not.toHaveBeenCalled()
  })

  it('acknowledges an event with no customer without querying or writing data', async () => {
    await expect(deliver('payout.paid', { id: 'po_unrelated' })).resolves.toEqual({
      received: true
    })
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(auditLogRepository.log).not.toHaveBeenCalled()
    expect(resolveSubscriptionTier).not.toHaveBeenCalled()
    expect(prisma.user.update).not.toHaveBeenCalled()
  })

  it('still verifies signatures before looking up ownership', async () => {
    const handler = await getHandler()
    vi.mocked(stripe.webhooks.constructEvent).mockImplementation(() => {
      throw new Error('Invalid signature')
    })

    await expect(
      handler(buildEvent('{}', { 'stripe-signature': 'invalid' }) as any)
    ).rejects.toMatchObject({ statusCode: 400, message: 'Webhook verification failed' })
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(auditLogRepository.log).not.toHaveBeenCalled()
  })

  it('returns 500 on ownership lookup failure so Stripe can retry', async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('Database unavailable'))

    await expect(deliver('customer.subscription.created', subscription)).rejects.toMatchObject({
      statusCode: 500,
      message: 'Webhook processing failed'
    })
    expect(resolveSubscriptionTier).not.toHaveBeenCalled()
    expect(upsertProviderSubscription).not.toHaveBeenCalled()
  })

  it('keeps unknown products for a Coach Watts customer retryable', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: user.id } as any)

    await expect(deliver('customer.subscription.updated', subscription)).rejects.toMatchObject({
      statusCode: 500,
      message: 'Webhook processing failed'
    })
    expect(resolveSubscriptionTier).toHaveBeenCalled()
    expect(upsertProviderSubscription).not.toHaveBeenCalled()
  })

  it.each([
    'customer.subscription.created',
    'customer.subscription.updated',
    'checkout.session.completed'
  ])('continues processing %s for a Coach Watts customer', async (type) => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: user.id } as any)
    vi.mocked(prisma.user.findMany).mockResolvedValue([user] as any)
    vi.mocked(resolveSubscriptionTier).mockResolvedValue('PRO')
    vi.mocked(stripe.subscriptions.retrieve).mockResolvedValue(subscription as any)

    await expect(
      deliver(type, { ...subscription, subscription: subscription.id })
    ).resolves.toEqual({ received: true })

    expect(auditLogRepository.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id })
    )
    expect(upsertProviderSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id, externalId: subscription.id, tier: 'PRO' })
    )
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: user.id },
        data: expect.objectContaining({ subscriptionTier: 'PRO', subscriptionStatus: 'ACTIVE' })
      })
    )
  })
})
