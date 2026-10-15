import { prisma } from '../db'
import { getResend } from '../email'
import { registerTaskHandler } from '../task-registry'
import { generateUnsubscribeToken } from '../unsubscribe-token'
import { EMAIL_TEMPLATE_REGISTRY, getEmailTemplateDefinition } from '../email-template-registry'
import {
  describeInternalAuthFailure,
  getInternalApiToken,
  parseInternalAuthFailureReason
} from '../internal-api-token'
import { resolveEmailSubject } from '../email-i18n'
import type { EmailAudience, EmailDeliveryStatus } from '@prisma/client'

/**
 * Statuses that mean Resend already accepted/processed the send. A delivery
 * in one of these states must never be re-dispatched, even if the caller
 * retries (e.g. via a Trigger.dev retry hitting the same idempotency key).
 */
const ALREADY_DISPATCHED_STATUSES: EmailDeliveryStatus[] = [
  'SENT',
  'DELIVERED',
  'OPENED',
  'CLICKED',
  'BOUNCED',
  'COMPLAINED',
  'UNSUBSCRIBED',
  'SUPPRESSED'
]

/**
 * Resend error codes that indicate a permanent, non-retryable failure
 * (bad input, auth/config problems, malformed request). Retrying these would
 * just fail again in the same way, wasting Trigger.dev attempts.
 * See https://resend.com/docs/api-reference/errors
 */
const NON_RETRYABLE_RESEND_ERROR_CODES = new Set<string>([
  'validation_error',
  'invalid_from_address',
  'invalid_access',
  'invalid_parameter',
  'invalid_region',
  'missing_required_field',
  'missing_api_key',
  'restricted_api_key',
  'invalid_api_key',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
  'not_found',
  'method_not_allowed',
  'security_error'
])

/**
 * Thrown when Resend rejects a send. Carries enough information to decide
 * whether the failure is worth retrying (transient: network blips, rate
 * limits, provider 5xx) or not (permanent: invalid recipient, malformed
 * content, bad config).
 */
export class EmailDispatchError extends Error {
  readonly retryable: boolean
  readonly code?: string
  readonly statusCode?: number | null

  constructor(
    message: string,
    options: { retryable: boolean; code?: string; statusCode?: number | null }
  ) {
    super(message)
    this.name = 'EmailDispatchError'
    this.retryable = options.retryable
    this.code = options.code
    this.statusCode = options.statusCode
  }
}

function classifyResendError(error: {
  message: string
  statusCode?: number | null
  name?: string
}): EmailDispatchError {
  const code = error.name
  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : null
  const nonRetryableByCode = code ? NON_RETRYABLE_RESEND_ERROR_CODES.has(code) : false
  // 4xx (excluding 429 rate limiting) is a permanent client error; 5xx and
  // 429 are transient and worth retrying.
  const nonRetryableByStatus =
    statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 429
  return new EmailDispatchError(error.message, {
    retryable: !nonRetryableByCode && !nonRetryableByStatus,
    code,
    statusCode
  })
}

/**
 * Extracts the list of column names involved in a P2002 unique-constraint
 * violation. The shape of `PrismaClientKnownRequestError.meta` differs
 * depending on which query engine produced the error:
 * - Classic engine: `error.meta.target` is the field list directly.
 * - Driver adapter engine (this app uses `@prisma/adapter-pg`, see
 *   server/utils/db.ts): `meta.target` does not exist. Prisma instead
 *   constructs the error as `new PrismaClientKnownRequestError(message, code,
 *   { driverAdapterError: originalError })`, so the field list is nested at
 *   `meta.driverAdapterError.cause.constraint.fields` (verified against
 *   @prisma/client 7.8.0's runtime: `Ge()`/`Tn()` in runtime/client.js).
 * Check both shapes defensively in case any code path in this app ever
 * produces a classic-engine-shaped error.
 */
function getUniqueConstraintFields(dbError: any): string[] | undefined {
  return dbError?.meta?.target ?? dbError?.meta?.driverAdapterError?.cause?.constraint?.fields
}

export const EmailDeliveryService = {
  /**
   * Dispatches a queued or failed email delivery record via Resend.
   * Handles status updates (SENDING -> SENT/FAILED) and locking.
   */
  async dispatch(deliveryId: string) {
    const delivery = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId }
    })

    if (!delivery) {
      throw new Error('Email delivery not found')
    }

    if (delivery.status !== 'QUEUED' && delivery.status !== 'FAILED') {
      throw new Error(`Email is not in a sendable state (status: ${delivery.status})`)
    }

    if (!delivery.htmlBody) {
      throw new Error('Email HTML body is missing. Cannot send.')
    }

    const resend = getResend()
    if (!resend) {
      throw new Error('Resend is not configured (RESEND_API_KEY missing)')
    }

    // 1. Lock and set to SENDING
    const lockResult = await prisma.emailDelivery.updateMany({
      where: {
        id: deliveryId,
        status: {
          in: ['QUEUED', 'FAILED']
        }
      },
      data: {
        status: 'SENDING',
        errorMessage: null
      }
    })

    if (lockResult.count === 0) {
      throw new Error('Email is already being sent or state changed')
    }

    try {
      const from =
        delivery.fromEmail || process.env.MAIL_FROM_ADDRESS || 'Coach Watts <onboarding@resend.dev>'

      const response = await resend.emails.send(
        {
          from,
          to: delivery.toEmail,
          subject: delivery.subject,
          html: delivery.htmlBody,
          text: delivery.textBody || undefined,
          replyTo: delivery.replyToEmail || undefined
        },
        // Keyed by our own delivery id: if this exact dispatch attempt is
        // retried (e.g. the response was lost after Resend already accepted
        // the email), Resend will not send a second copy.
        { idempotencyKey: deliveryId }
      )

      if (response.error) {
        throw classifyResendError(response.error)
      }

      // 2. Success
      return await prisma.emailDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SENT',
          providerMessageId: response.data?.id,
          sentAt: new Date(),
          errorMessage: null
        }
      })
    } catch (error: any) {
      console.error(`[EmailDeliveryService] Dispatch failed for ${deliveryId}:`, error)

      // 3. Mark as FAILED
      await prisma.emailDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          errorMessage: error.message
        }
      })

      throw error
    }
  },

  async runSendEmail(
    payload: {
      userId?: string
      toEmail?: string
      templateKey: string
      eventKey: string
      audience: EmailAudience
      subject: string
      props?: Record<string, any>
      idempotencyKey?: string
    },
    options?: { runId?: string }
  ) {
    const {
      userId,
      toEmail,
      templateKey,
      eventKey,
      audience,
      subject,
      props = {},
      idempotencyKey
    } = payload

    // When the caller doesn't supply its own dedup key, fall back to one
    // scoped to this specific trigger run. That keeps every retry of the
    // same run converging on the same EmailDelivery row (safe to resume /
    // safe to skip if already sent) without accidentally deduping two
    // distinct, legitimately-repeated business events (e.g. a user
    // resubscribing later) that happen to share the same eventKey.
    const dedupeKey =
      idempotencyKey || (options?.runId ? `trigger-run:${options.runId}` : undefined)

    const template = getEmailTemplateDefinition(templateKey)

    if (template && template.audience !== audience) {
      return
    }

    const user = userId
      ? await prisma.user.findUnique({
          where: { id: userId },
          include: { emailPreferences: true }
        })
      : toEmail
        ? await prisma.user.findUnique({
            where: { email: toEmail },
            include: { emailPreferences: true }
          })
        : null

    const recipientEmail = toEmail || user?.email
    if (!recipientEmail) return

    if (user && user.emailStatus !== 'VALID' && audience !== 'TRANSACTIONAL') return

    if (user) {
      const preference = user.emailPreferences.find((p) => p.channel === 'EMAIL')
      const globalUnsub = Boolean(preference?.globalUnsubscribe)
      if (globalUnsub && audience !== 'TRANSACTIONAL') return

      if (template?.preferenceKey && audience !== 'TRANSACTIONAL') {
        const isEnabled = preference ? Boolean((preference as any)[template.preferenceKey]) : true
        if (!isEnabled) return
      }

      if (template?.cooldownHours && template.cooldownHours > 0) {
        const throttleKeys = Object.values(EMAIL_TEMPLATE_REGISTRY)
          .filter((entry) => entry.throttleGroup && entry.throttleGroup === template.throttleGroup)
          .map((entry) => entry.templateKey)
        const throttleTemplateKeys = throttleKeys.length > 0 ? throttleKeys : [templateKey]
        const lookbackFrom = new Date(Date.now() - template.cooldownHours * 60 * 60 * 1000)
        const activeStatuses: EmailDeliveryStatus[] = [
          'QUEUED',
          'SENDING',
          'SENT',
          'DELIVERED',
          'OPENED',
          'CLICKED'
        ]

        const recentDelivery = await prisma.emailDelivery.findFirst({
          where: {
            userId: user.id,
            templateKey: { in: throttleTemplateKeys },
            createdAt: { gte: lookbackFrom },
            status: { in: activeStatuses }
          },
          orderBy: { createdAt: 'desc' }
        })

        if (recentDelivery) return
      }
    }

    const isSuppressed = await prisma.emailSuppression.findFirst({
      where: { email: recipientEmail, active: true }
    })

    if (isSuppressed && audience !== 'TRANSACTIONAL') return

    const baseUrl = process.env.NUXT_PUBLIC_SITE_URL || 'https://coachwatts.com'
    const unsubToken = user ? generateUnsubscribeToken(user.id) : ''
    const unsubscribeUrl = unsubToken
      ? `${baseUrl}/unsubscribe?token=${unsubToken}`
      : `${baseUrl}/profile/settings?tab=communication`
    const userLang = user?.uiLanguage || 'en'
    const finalSubject = resolveEmailSubject(templateKey, userLang, subject)

    let utmQuery = ''
    if (template) {
      const params = new URLSearchParams({
        utm_source: 'coachwatts_email',
        utm_medium: template.utmMedium,
        utm_campaign: template.utmCampaign
      })
      utmQuery = `?${params.toString()}`
    }

    const finalProps: Record<string, any> = {
      siteUrl: baseUrl,
      logoUrl: `${baseUrl}/icon.png`,
      lang: userLang,
      ...props,
      unsubscribeUrl,
      utmQuery
    }

    if (template) {
      const missingProps = template.requiredProps.filter((key: string) => finalProps[key] == null)
      if (missingProps.length > 0) return
    }

    const renderUrl = `${baseUrl}/api/internal/render-email`
    const internalApiToken = getInternalApiToken()
    if (!internalApiToken) {
      throw new Error(
        'INTERNAL_API_TOKEN is not configured on this service, so ' +
          `${renderUrl} cannot be called. Set INTERNAL_API_TOKEN to the same value ` +
          'on the web service and the worker service of this deployment.'
      )
    }

    const response = await fetch(renderUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-token': internalApiToken
      },
      body: JSON.stringify({ templateKey, props: finalProps })
    })

    if (!response.ok) {
      const errorText = await response.text()

      if (response.status === 401) {
        // CW-290: a 401 here is always an environment fault between two
        // services of the same app, never a logic bug. Name the specific fault
        // so the error says which service to fix. Nothing derived from the
        // token value goes into this message — it propagates into every log
        // sink that logs an email failure.
        const reason = parseInternalAuthFailureReason(errorText)
        const explanation = reason
          ? describeInternalAuthFailure(reason)
          : "the web service rejected this service's x-internal-api-token"

        throw new Error(
          `Render API rejected the internal API token (401 from ${renderUrl}): ${explanation}. ` +
            'INTERNAL_API_TOKEN must be set, and identical, on both the web service and the ' +
            'worker service of this deployment.'
        )
      }

      throw new Error(`Render API failed (${response.status}): ${errorText}`)
    }

    const result = (await response.json()) as any
    const htmlBody: string = result.html
    const textBody: string = result.text

    let delivery
    try {
      delivery = await prisma.emailDelivery.create({
        data: {
          userId: user?.id || null,
          toEmail: recipientEmail,
          templateKey,
          eventKey,
          audience,
          subject: finalSubject,
          htmlBody,
          textBody,
          status: 'QUEUED',
          idempotencyKey: dedupeKey,
          metadata: finalProps as any
        }
      })
    } catch (dbError: any) {
      if (
        dbError.code === 'P2002' &&
        getUniqueConstraintFields(dbError)?.includes('idempotencyKey')
      ) {
        const existing = dedupeKey
          ? await prisma.emailDelivery.findUnique({ where: { idempotencyKey: dedupeKey } })
          : null

        if (!existing) {
          // Unexpected: the unique constraint fired but we can't find the
          // row it collided with. Don't silently claim success here.
          throw dbError
        }

        if (ALREADY_DISPATCHED_STATUSES.includes(existing.status)) {
          // A previous attempt already got this email out (or further along
          // the lifecycle). Resending now would create a duplicate, so this
          // really is a no-op duplicate.
          return {
            success: true,
            deliveryId: existing.id,
            skipped: true,
            reason: 'Duplicate',
            status: existing.status
          }
        }

        // The earlier attempt for this run never actually succeeded
        // (QUEUED/SENDING/FAILED) - resume dispatch against that same row
        // instead of silently reporting success.
        delivery = existing
      } else {
        throw dbError
      }
    }

    const disableEmails = process.env.DISABLE_EMAILS === 'true'
    if (disableEmails) {
      return { success: true, deliveryId: delivery.id, status: 'QUEUED' }
    }

    try {
      const sent = await EmailDeliveryService.dispatch(delivery.id)
      return { success: true, deliveryId: sent.id, status: 'SENT' }
    } catch (dispatchError: any) {
      const retryable = dispatchError instanceof EmailDispatchError ? dispatchError.retryable : true

      if (!retryable) {
        // Permanent failure (invalid recipient, malformed content, bad
        // config) - retrying would just fail the same way again, so report
        // it without throwing (no Trigger.dev retry).
        return { success: false, deliveryId: delivery.id, error: dispatchError.message }
      }

      // Transient failure (network blip, rate limit, provider 5xx) - propagate
      // so Trigger.dev's retry (maxAttempts: 3 in trigger/send-email.ts) kicks
      // in instead of the failure being silently swallowed.
      throw dispatchError
    }
  }
}

registerTaskHandler('send-email', (payload, context) =>
  EmailDeliveryService.runSendEmail(payload, { runId: context?.runId })
)
