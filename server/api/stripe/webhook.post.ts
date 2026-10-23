import type Stripe from 'stripe'
import type { SubscriptionStatus } from '@prisma/client'
import { prisma } from '../../utils/db'
import { stripe } from '../../utils/stripe'
import { auditLogRepository } from '../../utils/repositories/auditLogRepository'
import { dispatchTask } from '../../utils/task-dispatcher'
import { getPriceProductId, resolveSubscriptionTier } from '../../utils/subscription-tier'
import { upsertProviderSubscription } from '../../utils/provider-subscriptions'
import { trackStripeInRevenueCat } from '../../utils/revenuecat'

/**
 * Map Stripe subscription status to internal status
 */
function mapStripeStatus(subscription: Stripe.Subscription): SubscriptionStatus {
  if (subscription.cancel_at_period_end) {
    return 'CANCELED'
  }

  switch (subscription.status) {
    case 'active':
    case 'trialing':
      return 'ACTIVE'
    case 'past_due':
    case 'incomplete':
      return 'PAST_DUE'
    case 'canceled':
    case 'unpaid':
      return 'CANCELED'
    default:
      return 'NONE'
  }
}

/**
 * Handle subscription created or updated
 */
async function handleSubscriptionChange(subscription: Stripe.Subscription, eventAt: Date) {
  const config = useRuntimeConfig()
  const customerId = subscription.customer as string
  const subscriptionId = subscription.id

  const firstItem = subscription.items.data[0]
  if (!firstItem?.price?.id) {
    console.error('No Stripe price found in subscription')
    return
  }
  const tier = await resolveSubscriptionTier(firstItem, config, stripe)

  const productId =
    getPriceProductId((firstItem.price.product as any) ?? null) || '(unknown-product)'
  console.log(`Resolved tier '${tier}' for price '${firstItem.price.id}' product '${productId}'`)

  const status = mapStripeStatus(subscription)
  const periodEnd = (subscription as any).current_period_end
    ? new Date((subscription as any).current_period_end * 1000)
    : null
  const startedAt = new Date(subscription.created * 1000)
  const matchingUsers = await prisma.user.findMany({ where: { stripeCustomerId: customerId } })
  const providerStatus =
    status === 'ACTIVE' ? 'ACTIVE' : status === 'CANCELED' ? 'CANCELED' : 'PAST_DUE'

  for (const user of matchingUsers) {
    const result = await upsertProviderSubscription({
      userId: user.id,
      provider: 'STRIPE',
      externalId: subscriptionId,
      productId,
      tier,
      status: providerStatus,
      rawStatus: subscription.status,
      entitlementEnd: periodEnd,
      autoRenew: !subscription.cancel_at_period_end,
      environment: subscription.livemode ? 'PRODUCTION' : 'SANDBOX',
      lastEventAt: eventAt
    })
    if (result.stale) {
      console.log(`Skipping stale Stripe subscription event for user ${user.id}`)
      continue
    }

    const shouldSetStartedAt = tier !== 'FREE' && status === 'ACTIVE' && !user.subscriptionStartedAt
    if (user.subscriptionStatus !== 'CONTRIBUTOR') {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          stripeSubscriptionId: subscriptionId,
          subscriptionTier: tier,
          subscriptionStatus: status,
          subscriptionPeriodEnd: periodEnd,
          ...(shouldSetStartedAt ? { subscriptionStartedAt: startedAt } : {})
        }
      })
    } else if (shouldSetStartedAt) {
      await prisma.user.update({
        where: { id: user.id },
        data: { subscriptionStartedAt: startedAt }
      })
    }

    if (shouldSetStartedAt) {
      try {
        await dispatchTask('send-email', {
          userId: user.id,
          templateKey: 'SubscriptionStarted',
          eventKey: `SUBSCRIPTION_STARTED_${tier}`,
          audience: 'TRANSACTIONAL',
          subject: `Welcome to Coach Watts ${tier}!`,
          props: {
            name: user.name || 'Athlete',
            tier,
            unsubscribeUrl: `${process.env.NUXT_PUBLIC_SITE_URL || 'https://coachwatts.com'}/profile/settings?tab=communication`
          }
        })
      } catch (error) {
        console.error('Failed to trigger subscription email', error)
      }
    }

    await trackStripeInRevenueCat(user.id, subscriptionId)
  }

  console.log(`Updated subscription for customer ${customerId}: ${tier} (${status})`)
}

/**
 * Handle subscription deleted (complete cancellation)
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription, eventAt: Date) {
  const customerId = subscription.customer as string
  const users = await prisma.user.findMany({ where: { stripeCustomerId: customerId } })

  for (const user of users) {
    const result = await upsertProviderSubscription({
      userId: user.id,
      provider: 'STRIPE',
      externalId: subscription.id,
      productId:
        getPriceProductId((subscription.items.data[0]?.price.product as any) ?? null) ||
        '(unknown-product)',
      tier: user.subscriptionTier,
      status: 'EXPIRED',
      rawStatus: subscription.status,
      entitlementEnd: eventAt,
      autoRenew: false,
      environment: subscription.livemode ? 'PRODUCTION' : 'SANDBOX',
      lastEventAt: eventAt
    })
    if (result.stale) {
      console.log(`Skipping stale Stripe deletion event for user ${user.id}`)
      continue
    }

    if (user.subscriptionStatus === 'CONTRIBUTOR') continue

    await prisma.user.update({
      where: { id: user.id },
      data: {
        stripeSubscriptionId: null,
        subscriptionTier: 'FREE',
        subscriptionStatus: 'NONE',
        subscriptionPeriodEnd: null
      }
    })

    try {
      await dispatchTask('send-email', {
        userId: user.id,
        templateKey: 'SubscriptionCanceled',
        eventKey: `SUBSCRIPTION_CANCELED_${user.id}`,
        audience: 'TRANSACTIONAL',
        subject: 'Your Coach Watts subscription has been canceled',
        props: {
          name: user.name || 'Athlete',
          tier: user.subscriptionTier
        }
      })
    } catch (emailErr) {
      console.error('Failed to trigger subscription canceled email', emailErr)
    }
  }

  console.log(`Subscription deleted for customer ${customerId}, downgraded to FREE`)
}

/**
 * Handle checkout session completed (initial subscription)
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session, eventAt: Date) {
  const customerId = session.customer as string
  const subscriptionId = session.subscription as string

  if (!subscriptionId) {
    console.error('No subscription ID in checkout session')
    return
  }

  // Retrieve the full subscription object
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  await handleSubscriptionChange(subscription, eventAt)

  console.log(`Checkout completed for customer ${customerId}, subscription ${subscriptionId}`)
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const webhookSecret = config.stripeWebhookSecret

  if (!webhookSecret) {
    throw createError({
      statusCode: 500,
      message: 'STRIPE_WEBHOOK_SECRET is not configured'
    })
  }

  // Get the raw body as a Buffer (required for Stripe signature verification)
  const body = await readRawBody(event, false)
  if (!body) {
    throw createError({
      statusCode: 400,
      message: 'Missing request body'
    })
  }

  // Get the Stripe signature header
  const signature = getHeader(event, 'stripe-signature')
  if (!signature && process.env.E2E_MODE !== 'true') {
    throw createError({
      statusCode: 400,
      message: 'Missing stripe-signature header'
    })
  }

  let stripeEvent: Stripe.Event

  try {
    if (process.env.E2E_MODE === 'true' && (signature === 'e2e-signature' || !signature)) {
      stripeEvent = typeof body === 'string' ? JSON.parse(body) : JSON.parse(body.toString())
    } else {
      // Verify the webhook signature
      stripeEvent = stripe.webhooks.constructEvent(body, signature!, webhookSecret)
    }
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err)
    if (err?.stack) console.error(err.stack)
    throw createError({
      statusCode: 400,
      message: 'Webhook verification failed'
    })
  }

  // Log the event for debugging
  console.log(`Received Stripe webhook: ${stripeEvent.type}`)
  const eventAt = new Date(stripeEvent.created * 1000)

  // Handle the event
  try {
    // 1. Only process events for a linked Coach Watts customer. This Stripe
    // account also sends events for products that belong to other applications.
    const customerId = (stripeEvent.data.object as any).customer as string
    let userId: string | undefined

    if (customerId) {
      const user = await prisma.user.findUnique({
        where: { stripeCustomerId: customerId },
        select: { id: true }
      })
      userId = user?.id
    }

    if (!userId) {
      console.log(`Ignoring Stripe webhook without a Coach Watts customer: ${stripeEvent.type}`)
      return { received: true }
    }

    // 2. Log to AuditLog
    await auditLogRepository.log({
      userId,
      action: `STRIPE_WEBHOOK_${stripeEvent.type.toUpperCase().replace(/\./g, '_')}`,
      resourceType: 'SUBSCRIPTION',
      resourceId: (stripeEvent.data.object as any).id,
      metadata: {
        stripeEventType: stripeEvent.type,
        stripeEventId: stripeEvent.id,
        stripeEventCreated: stripeEvent.created
      }
    })

    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object as Stripe.Checkout.Session, eventAt)
        break

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionChange(stripeEvent.data.object as Stripe.Subscription, eventAt)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object as Stripe.Subscription, eventAt)
        break

      case 'invoice.payment_failed': {
        const failedInvoice = stripeEvent.data.object as Stripe.Invoice
        console.log(`Payment failed for customer ${failedInvoice.customer}`)
        if (failedInvoice.customer) {
          const user = await prisma.user.findUnique({
            where: { stripeCustomerId: failedInvoice.customer as string }
          })
          if (user) {
            const amountFormatted = failedInvoice.amount_due
              ? `${(failedInvoice.amount_due / 100).toFixed(2)} ${failedInvoice.currency?.toUpperCase() || ''}`
              : undefined
            try {
              await dispatchTask('send-email', {
                userId: user.id,
                templateKey: 'PaymentFailed',
                eventKey: `INVOICE_PAYMENT_FAILED_${failedInvoice.id}`,
                audience: 'TRANSACTIONAL',
                subject: 'Action Required: Payment failed for your Coach Watts subscription',
                props: {
                  name: user.name || 'Athlete',
                  tier: user.subscriptionTier,
                  amount: amountFormatted
                }
              })
            } catch (emailErr) {
              console.error('Failed to send payment failed email', emailErr)
            }
          }
        }
        break
      }

      case 'invoice.payment_succeeded': {
        const successInvoice = stripeEvent.data.object as Stripe.Invoice
        console.log(`Payment succeeded for customer ${successInvoice.customer}`)
        if (successInvoice.billing_reason === 'subscription_cycle' && successInvoice.customer) {
          const user = await prisma.user.findUnique({
            where: { stripeCustomerId: successInvoice.customer as string }
          })
          if (user) {
            const amountFormatted = successInvoice.amount_paid
              ? `${(successInvoice.amount_paid / 100).toFixed(2)} ${successInvoice.currency?.toUpperCase() || ''}`
              : undefined
            try {
              await dispatchTask('send-email', {
                userId: user.id,
                templateKey: 'PaymentSucceeded',
                eventKey: `INVOICE_PAYMENT_SUCCEEDED_${successInvoice.id}`,
                audience: 'TRANSACTIONAL',
                subject: 'Receipt for your Coach Watts subscription payment',
                props: {
                  name: user.name || 'Athlete',
                  tier: user.subscriptionTier,
                  amount: amountFormatted
                }
              })
            } catch (emailErr) {
              console.error('Failed to send payment succeeded email', emailErr)
            }
          }
        }
        break
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`)
    }

    return { received: true }
  } catch (error: any) {
    console.error('Error processing webhook:', error)
    if (error.stack) console.error(error.stack)
    throw createError({
      statusCode: 500,
      message: 'Webhook processing failed'
    })
  }
})
