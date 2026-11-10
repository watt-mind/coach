import { z } from 'zod'
import { config } from '@vue-email/compiler'
import { resolve } from 'path'
import fs from 'fs'
import {
  authorizeInternalApiRequest,
  describeInternalAuthFailure
} from '../../utils/internal-api-token'

/**
 * Internal API to render Vue email templates to HTML/Text.
 */
export default defineEventHandler(async (event) => {
  const incomingToken = getRequestHeader(event, 'x-internal-api-token')
  const auth = authorizeInternalApiRequest(incomingToken)

  if (!auth.ok) {
    // Log enough to tell "no token on this side" from "the two sides disagree".
    // Every field of `diagnostics` is a fixed enum, a boolean, or the
    // environment name — nothing derived from either token's value, so this
    // cannot leak the secret into a log scrape.
    console.error(
      `[InternalRender] 401 Unauthorized — ${describeInternalAuthFailure(auth.reason)}.`,
      auth.diagnostics
    )

    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      // Surfaced to the caller (and therefore into the worker's Sentry event) so
      // the failure is diagnosable from the worker side too. The reason is a
      // fixed enum and carries no token material.
      //
      // Withheld from callers that presented no token at all. This route has no
      // middleware or route rule in front of it, so it is reachable anonymously,
      // and nitro's production error handler does emit `error.data` for a
      // non-fatal 401 — so an unauthenticated caller would otherwise learn
      // whether this service has INTERNAL_API_TOKEN configured. That grants no
      // access (a missing token rejects everything) but it is free to withhold.
      // The worker always sends a token, so it still gets its reason.
      ...(auth.diagnostics.callerTokenPresent ? { data: { reason: auth.reason } } : {})
    })
  }

  const body = await readBody(event)

  const templateKey = body?.templateKey
  const props = body?.props || {}

  if (!templateKey || typeof templateKey !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request: templateKey is required'
    })
  }

  const rootDir = process.cwd()
  const emailDir = resolve(rootDir, 'app/emails')
  const templateFileName = `${templateKey}.vue`
  const fullPath = resolve(emailDir, templateFileName)

  if (!fs.existsSync(fullPath)) {
    throw createError({
      statusCode: 404,
      statusMessage: `Template file not found at ${fullPath}`
    })
  }

  try {
    const vueEmail = config(emailDir, { verbose: false })

    // Attempt rendering
    const result = await vueEmail.render(templateFileName, { props })

    return {
      html: result.html,
      text: result.text
    }
  } catch (err: any) {
    console.error(`[InternalRender] Error rendering ${templateKey}:`, err)
    throw createError({
      statusCode: 500,
      statusMessage: `Rendering failed: ${err.message}`
    })
  }
})
