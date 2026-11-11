import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getServerSession } from '../../../../../server/utils/session'
import { prisma } from '../../../../../server/utils/db'
import { stripe } from '../../../../../server/utils/stripe'
import { ensureStripeCustomerForUser } from '../../../../../server/utils/stripe-customer'
import { isLifetimeSubscriber } from '../../../../../server/utils/lifetime-subscription'

/** Matches handler fallback + tests/unit/setup.ts default. */
const SITE = 'http://localhost:3099'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', () => {})
vi.stubGlobal('readBody', async (event: any) => event.body)
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message)
  ;(error as any).statusCode = err.statusCode
  return error
})

vi.mock('../../../../../server/utils/session', () => ({
  getServerSession: vi.fn()
}))

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn()
    }
  }
}))

vi.mock('../../../../../server/utils/stripe', () => ({
  stripe: {
    billingPortal: {
      sessions: {
        create: vi.fn()
      }
    }
  }
}))

vi.mock('../../../../../server/utils/stripe-customer', () => ({
  ensureStripeCustomerForUser: vi.fn()
}))

vi.mock('../../../../../server/utils/lifetime-subscription', () => ({
  isLifetimeSubscriber: vi.fn(),
  stripeBillingResetData: vi.fn(() => ({}))
}))

const getHandler = async () =>
  (await import('../../../../../server/api/stripe/portal-session.post')).default

describe('POST /api/stripe/portal-session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user-1' } } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'user-1',
      email: 'a@example.com',
      name: 'Athlete',
      stripeCustomerId: 'cus_1',
      subscriptionStatus: 'active'
    } as any)
    vi.mocked(isLifetimeSubscriber).mockReturnValue(false)
    vi.mocked(ensureStripeCustomerForUser).mockResolvedValue({ customerId: 'cus_1' } as any)
    vi.mocked(stripe.billingPortal.sessions.create).mockResolvedValue({
      url: 'https://billing.stripe.com/session/test'
    } as any)
  })

  it('rejects coaching act-as before reading the body or accessing billing state', async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: 'athlete-1', isCoaching: true, isAdmin: false, originalUserId: 'coach-1' }
    } as any)
    const readBody = vi.fn()
    vi.stubGlobal('readBody', readBody)

    try {
      const handler = await getHandler()
      await expect(handler({ body: {} } as any)).rejects.toMatchObject({ statusCode: 403 })
      expect(readBody).not.toHaveBeenCalled()
      expect(prisma.user.findUnique).not.toHaveBeenCalled()
      expect(prisma.user.update).not.toHaveBeenCalled()
      expect(ensureStripeCustomerForUser).not.toHaveBeenCalled()
      expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
    } finally {
      vi.stubGlobal('readBody', async (event: any) => event.body)
    }
  })

  it('rejects requests without an authenticated session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)
    const handler = await getHandler()
    await expect(handler({ body: {} } as any)).rejects.toMatchObject({ statusCode: 401 })
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
    expect(ensureStripeCustomerForUser).not.toHaveBeenCalled()
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })

  it('rejects cross-origin returnUrl with 400 and never calls Stripe', async () => {
    const handler = await getHandler()

    await expect(
      handler({
        body: { returnUrl: 'https://evil.example/phish' }
      } as any)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/same-origin|Invalid redirect/i)
    })

    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })

  it('rejects protocol-relative returnUrl with 400', async () => {
    const handler = await getHandler()

    await expect(
      handler({
        body: { returnUrl: '//evil.example/phish' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 400 })

    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
  })

  it('uses the default same-origin return URL when omitted', async () => {
    const handler = await getHandler()

    await handler({ body: {} } as any)

    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: `${SITE}/settings/billing`
    })
  })

  it('accepts a same-origin absolute returnUrl', async () => {
    const handler = await getHandler()

    await handler({
      body: { returnUrl: `${SITE}/settings/billing?from=portal` }
    } as any)

    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: `${SITE}/settings/billing?from=portal`
    })
  })
})
