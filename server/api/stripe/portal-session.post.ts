import { z } from 'zod/v3'
import { getServerSession } from '../../utils/session'
import { prisma } from '../../utils/db'
import { stripe } from '../../utils/stripe'
import { ensureStripeCustomerForUser } from '../../utils/stripe-customer'
import { isLifetimeSubscriber, stripeBillingResetData } from '../../utils/lifetime-subscription'
import { requireStripeRedirectUrl } from '../../utils/stripe-redirect-url'

const portalSessionSchema = z.object({
  returnUrl: z.string().optional()
})

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  if (!session?.user?.id) {
    throw createError({
      statusCode: 401,
      message: 'Unauthorized'
    })
  }
  if (session.user.isCoaching) {
    throw createError({
      statusCode: 403,
      message: 'Billing portal access is not available while acting as an athlete'
    })
  }
  const userId = session.user.id

  // Validate request body
  const body = await readBody(event)
  const { returnUrl } = portalSessionSchema.parse(body)

  // Get user with Stripe customer ID
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      stripeCustomerId: true,
      subscriptionStatus: true
    }
  })

  if (!user) {
    throw createError({
      statusCode: 404,
      message: 'User not found'
    })
  }

  if (isLifetimeSubscriber(user)) {
    throw createError({
      statusCode: 409,
      message: 'Lifetime access is managed by Coach Watts, not the Stripe billing portal.'
    })
  }

  let customerId: string

  try {
    ;({ customerId } = await ensureStripeCustomerForUser(user, { createIfMissing: false }))
  } catch (error: any) {
    if (error?.statusCode === 404) {
      throw createError({
        statusCode: 400,
        message: 'No Stripe customer found. Please subscribe first.'
      })
    }

    throw error
  }

  let config: any
  try {
    config = useRuntimeConfig()
  } catch {
    config = {}
  }
  const baseUrl = config?.public?.siteUrl || 'http://localhost:3099'
  const return_url = requireStripeRedirectUrl(returnUrl, baseUrl, '/settings/billing')

  let portalSession
  try {
    portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url
    })
  } catch (error: any) {
    if (error?.type !== 'StripeInvalidRequestError' && error?.code !== 'resource_missing') {
      throw error
    }

    await prisma.user.update({
      where: { id: userId },
      data: stripeBillingResetData(isLifetimeSubscriber(user))
    })

    throw createError({
      statusCode: 409,
      message:
        'Billing profile not found in the current Stripe account. Please choose a plan again to start a fresh checkout.'
    })
  }

  return {
    url: portalSession.url
  }
})
