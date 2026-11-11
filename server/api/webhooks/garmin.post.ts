import { z } from 'zod'
import { logWebhookRequest } from '../../utils/webhook-logger'

// CW-90: this endpoint is the primary, preferred Garmin data channel per
// partner guidance (Push/Ping over ad-hoc polling). trigger/ingest-garmin.ts
// and server/api/integrations/sync.post.ts cover the ad-hoc pull path, which
// is bounded and rate-limited to a recovery-only role — see
// docs/01-architecture/system-overview.md#garmin-push-first-policy.
defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Garmin Webhook',
    description:
      'Handles Garmin Push API notifications. Data is stored in SQL and processed asynchronously by the worker.',
    responses: {
      200: { description: 'OK' },
      503: { description: 'Durable storage unavailable' }
    }
  }
})

export default defineEventHandler(async (event) => {
  const payload = await readBody(event)
  const headers = getRequestHeaders(event)
  const query = getQuery(event)

  try {
    // Garmin Push API sends lists of records (activities, sleeps, etc.)
    // We log the entire payload to SQL with status PENDING for the worker poller to pick up.
    // The acknowledgement is only sent after durable insertion: the worker can
    // only claim persisted PENDING rows, so a failed insert must surface as a
    // 503 instead of a false success (CW-836).
    const logged = await logWebhookRequest({
      provider: 'garmin',
      eventType: 'PUSH',
      payload,
      headers,
      query,
      status: 'PENDING'
    })

    if (!logged) {
      console.error('[Garmin Webhook] Failed to log request: storage returned null')
      throw createError({
        statusCode: 503,
        statusMessage: 'Garmin delivery not persisted'
      })
    }

    return { success: true }
  } catch (error: any) {
    console.error('[Garmin Webhook] Failed to log request:', error)
    throw createError({
      statusCode: 503,
      statusMessage: 'Garmin delivery not persisted'
    })
  }
})
