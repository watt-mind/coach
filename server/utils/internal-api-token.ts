import { timingSafeEqual } from 'node:crypto'

/**
 * Shared resolver + diagnostics for `INTERNAL_API_TOKEN`, the shared secret the
 * worker uses to call the web service's `/api/internal/*` routes.
 *
 * The web and worker containers run the *same image* but get their environment
 * from *separate* service definitions, so it is entirely possible for one of
 * them to resolve a token and the other to resolve `null` (or a different
 * value). When that happens every internal call 401s and outbound email stops,
 * with the only symptom being a background task error (CW-290).
 *
 * **Nothing derived from the token value ever reaches a log sink.** Not the
 * value, not a hash of it, not its length. Everything below is either a fixed
 * enum, a boolean, or a service name — so an operator gets an unambiguous
 * diagnosis while a log scrape gets nothing to attack. (An earlier revision
 * logged a truncated hash "fingerprint" for cross-service comparison; CodeQL
 * correctly pointed out that it taints every log sink the resulting error
 * reaches, so it is gone. Comparing the two services' tokens is instead handled
 * by CW-635, which exposes status on an authenticated health endpoint.)
 */

const DEV_FALLBACK_TOKEN = 'dev-internal-token'

export type InternalApiTokenSource = 'env' | 'dev-fallback' | 'missing'

export interface InternalApiTokenStatus {
  /** True when a token was resolved by any means (env var or dev fallback). */
  configured: boolean
  source: InternalApiTokenSource
  /**
   * True when the resolved value has leading or trailing whitespace — the
   * signature of an env var that picked up a stray newline when it was pasted
   * into a deploy UI, which is otherwise invisible and produces a mismatch that
   * looks impossible ("but I copied the same value!").
   */
  hasSurroundingWhitespace: boolean
}

export type InternalAuthFailureReason =
  /** The receiving service has no `INTERNAL_API_TOKEN` at all. */
  | 'receiver_token_missing'
  /** The caller sent no `x-internal-api-token` header. */
  | 'caller_token_missing'
  /** Both sides have a token, but they are not the same value. */
  | 'token_mismatch'

/**
 * Safe-to-log description of a rejected internal request. Every field is a
 * fixed enum, a boolean, or an environment name — none of it is derived from
 * either token's value.
 */
export interface InternalAuthDiagnostics {
  reason: InternalAuthFailureReason
  receiverTokenPresent: boolean
  callerTokenPresent: boolean
  receiverTokenSource: InternalApiTokenSource
  /** See `InternalApiTokenStatus.hasSurroundingWhitespace`. */
  receiverTokenHasSurroundingWhitespace: boolean
  callerTokenHasSurroundingWhitespace: boolean
  nodeEnv: string
}

export type InternalAuthResult =
  | { ok: true }
  | { ok: false; reason: InternalAuthFailureReason; diagnostics: InternalAuthDiagnostics }

/**
 * Resolve the shared internal API token.
 *
 * Returns `null` in every environment except `development`, where a well-known
 * fallback keeps local dev working without a configured secret.
 */
export function getInternalApiToken(): string | null {
  return (
    process.env.INTERNAL_API_TOKEN ||
    (process.env.NODE_ENV === 'development' ? DEV_FALLBACK_TOKEN : null)
  )
}

/**
 * Whether a value carries leading/trailing whitespace.
 *
 * The result is a comparison outcome, not a projection of the value, so it is
 * safe to log and carries no information about the secret beyond "somebody
 * pasted it badly".
 */
function hasSurroundingWhitespace(value: string | null | undefined): boolean {
  if (!value) return false
  return value !== value.trim()
}

/** Describe how (and whether) this process resolved the internal API token. */
export function getInternalApiTokenStatus(): InternalApiTokenStatus {
  const fromEnv = process.env.INTERNAL_API_TOKEN
  const token = getInternalApiToken()

  const source: InternalApiTokenSource = fromEnv ? 'env' : token ? 'dev-fallback' : 'missing'

  return {
    configured: token !== null,
    source,
    hasSurroundingWhitespace: hasSurroundingWhitespace(token)
  }
}

/**
 * Constant-time comparison of two secrets.
 *
 * Length is compared first because `timingSafeEqual` throws on differing
 * lengths. That leaks only the length relationship, which is the standard
 * trade-off for this construction — and strictly less than the previous
 * implementation, which hashed both sides to equalise them.
 */
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Authorize an inbound internal API request.
 *
 * On failure the result carries a `reason` that distinguishes the three
 * genuinely different operational faults — the receiver has no token, the
 * caller sent none, or the two disagree. That is what turns a bare 401 into an
 * actionable instruction about which service to fix.
 */
export function authorizeInternalApiRequest(
  incomingToken: string | null | undefined
): InternalAuthResult {
  const receiverToken = getInternalApiToken()
  const status = getInternalApiTokenStatus()

  const fail = (reason: InternalAuthFailureReason): InternalAuthResult => ({
    ok: false,
    reason,
    diagnostics: {
      reason,
      receiverTokenPresent: status.configured,
      callerTokenPresent: Boolean(incomingToken),
      receiverTokenSource: status.source,
      receiverTokenHasSurroundingWhitespace: status.hasSurroundingWhitespace,
      callerTokenHasSurroundingWhitespace: hasSurroundingWhitespace(incomingToken),
      nodeEnv: process.env.NODE_ENV || 'development'
    }
  })

  if (!receiverToken) return fail('receiver_token_missing')
  if (!incomingToken) return fail('caller_token_missing')
  if (!tokensMatch(incomingToken, receiverToken)) return fail('token_mismatch')

  return { ok: true }
}

/** Human-readable, operator-facing explanation of a 401 reason. */
export function describeInternalAuthFailure(reason: InternalAuthFailureReason): string {
  switch (reason) {
    case 'receiver_token_missing':
      return 'the receiving service has no INTERNAL_API_TOKEN configured'
    case 'caller_token_missing':
      return 'the caller sent no x-internal-api-token header'
    case 'token_mismatch':
      return 'the caller and the receiving service resolved different INTERNAL_API_TOKEN values'
  }
}

const AUTH_FAILURE_REASONS: readonly InternalAuthFailureReason[] = [
  'receiver_token_missing',
  'caller_token_missing',
  'token_mismatch'
]

/**
 * Recover the failure reason from a 401 response body produced by an internal
 * API route, so the *calling* service can report the specific fault instead of
 * a bare "401". Returns `null` for any body that does not carry one (e.g. a 401
 * synthesised by a proxy in front of the app).
 */
export function parseInternalAuthFailureReason(
  responseBody: string | null | undefined
): InternalAuthFailureReason | null {
  if (!responseBody) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(responseBody)
  } catch {
    return null
  }

  const reason = (parsed as { data?: { reason?: unknown } })?.data?.reason
  return AUTH_FAILURE_REASONS.includes(reason as InternalAuthFailureReason)
    ? (reason as InternalAuthFailureReason)
    : null
}

export interface AssertInternalApiTokenOptions {
  /** Which side is booting, e.g. `'web'` or `'worker'`. Used in the log line. */
  service?: string
  /** Injectable for tests. */
  logger?: Pick<Console, 'error' | 'warn' | 'info'>
  /** Override the environment used to decide how loud to be. */
  nodeEnv?: string
}

/**
 * Boot-time assertion: shout about a missing `INTERNAL_API_TOKEN` now, rather
 * than discovering it on the first outbound email of the day.
 *
 * Deliberately does **not** throw. A hard crash here would turn an email outage
 * into a full site outage plus a container restart loop, which is strictly
 * worse. Instead it emits one loud, greppable `console.error` banner.
 */
export function assertInternalApiTokenConfigured(
  options: AssertInternalApiTokenOptions = {}
): InternalApiTokenStatus {
  const { service = 'unknown', logger = console } = options
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development'
  const status = getInternalApiTokenStatus()

  if (!status.configured) {
    logger.error(
      [
        '',
        '!!! ================================================================= !!!',
        `!!! INTERNAL_API_TOKEN IS NOT CONFIGURED (service=${service}, NODE_ENV=${nodeEnv})`,
        '!!! Every internal API call will be rejected with 401 and NO EMAIL',
        '!!! WILL BE DELIVERED. Set INTERNAL_API_TOKEN to the SAME value on the',
        '!!! web service and the worker service of this deployment.',
        '!!! ================================================================= !!!',
        ''
      ].join('\n')
    )
    return status
  }

  if (status.hasSurroundingWhitespace) {
    logger.error(
      `[InternalApiToken] service=${service} resolved a token with leading/trailing whitespace. ` +
        'It will not match the other service unless that one was pasted identically. ' +
        'Re-enter INTERNAL_API_TOKEN without surrounding quotes or a trailing newline.'
    )
    return status
  }

  if (status.source === 'dev-fallback') {
    logger.warn(
      `[InternalApiToken] service=${service} is using the built-in development fallback token. ` +
        'Set INTERNAL_API_TOKEN explicitly for any non-development deployment.'
    )
    return status
  }

  logger.info(
    `[InternalApiToken] service=${service} token configured (source=${status.source}, NODE_ENV=${nodeEnv}).`
  )

  return status
}

/**
 * Best-effort boot check.
 *
 * This module is imported by both the internal API route handlers (web) and by
 * `emailDeliveryService` (worker), so the check runs at the earliest point each
 * side touches internal-API auth. Skipped under test so the suite is not spammed.
 *
 * NOTE: for the web service this fires on first module load rather than on
 * process start; wiring `assertInternalApiTokenConfigured` into a nitro startup
 * plugin and/or `/api/health` would make it a true boot check, but those files
 * are outside CW-290's owned paths. Tracked as CW-635.
 */
function runBootCheck() {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return
  if (process.env.INTERNAL_API_BOOT_CHECK === 'false') return

  // Only ever label the service from an explicit env var. An earlier revision
  // inferred it from TRIGGER_API_URL/TRIGGER_SECRET_KEY, which is inverted in
  // practice: `getTaskDriver()` in server/utils/task-dispatcher.ts reads
  // TRIGGER_SECRET_KEY on the *web* service to pick its dispatch backend, so web
  // would announce itself as `worker`, while the BullMQ worker (gated on
  // REDIS_URL / CW_WORKER_HEALTH_PORT) may not set it at all and would announce
  // itself as `web`. The banner exists to tell an operator *which* service to
  // fix, and a confidently wrong label is worse than no label. Set
  // INTERNAL_API_SERVICE_NAME per Dokploy service to get a real name (CW-633).
  const service = process.env.INTERNAL_API_SERVICE_NAME || 'unknown'

  try {
    assertInternalApiTokenConfigured({ service })
  } catch {
    // A diagnostic must never be the reason a process fails to start.
  }
}

runBootCheck()
