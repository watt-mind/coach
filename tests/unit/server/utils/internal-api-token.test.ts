import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  assertInternalApiTokenConfigured,
  authorizeInternalApiRequest,
  describeInternalAuthFailure,
  getInternalApiToken,
  getInternalApiTokenStatus,
  parseInternalAuthFailureReason
} from '../../../../server/utils/internal-api-token'

const makeLogger = () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn()
})

/** Every string any of these helpers can emit, for leak assertions. */
const collectLoggedText = (logger: ReturnType<typeof makeLogger>) =>
  JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, logger.info.mock.calls])

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getInternalApiToken', () => {
  it('returns the configured env token', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'super-secret-token')
    vi.stubEnv('NODE_ENV', 'production')

    expect(getInternalApiToken()).toBe('super-secret-token')
  })

  it('falls back to the dev token only in development', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '')
    vi.stubEnv('NODE_ENV', 'development')

    expect(getInternalApiToken()).toBe('dev-internal-token')
  })

  it('returns null in production when the env var is absent', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '')
    vi.stubEnv('NODE_ENV', 'production')

    expect(getInternalApiToken()).toBeNull()
  })
})

describe('getInternalApiTokenStatus', () => {
  it('reports an env-sourced token', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'env-token')
    vi.stubEnv('NODE_ENV', 'production')

    expect(getInternalApiTokenStatus()).toEqual({
      configured: true,
      source: 'env',
      hasSurroundingWhitespace: false
    })
  })

  it('reports the development fallback distinctly from a real token', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '')
    vi.stubEnv('NODE_ENV', 'development')

    expect(getInternalApiTokenStatus().source).toBe('dev-fallback')
  })

  it('reports a missing token', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '')
    vi.stubEnv('NODE_ENV', 'production')

    expect(getInternalApiTokenStatus()).toEqual({
      configured: false,
      source: 'missing',
      hasSurroundingWhitespace: false
    })
  })

  it('flags a token that picked up a trailing newline', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'pasted-badly\n')
    vi.stubEnv('NODE_ENV', 'production')

    expect(getInternalApiTokenStatus().hasSurroundingWhitespace).toBe(true)
  })

  it('never exposes the token value or its length', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'a-secret-of-known-length')
    vi.stubEnv('NODE_ENV', 'production')

    const serialised = JSON.stringify(getInternalApiTokenStatus())

    expect(serialised).not.toContain('a-secret-of-known-length')
    expect(serialised).not.toContain(String('a-secret-of-known-length'.length))
  })
})

describe('authorizeInternalApiRequest', () => {
  it('accepts a matching token', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'matching-token')
    vi.stubEnv('NODE_ENV', 'production')

    expect(authorizeInternalApiRequest('matching-token')).toEqual({ ok: true })
  })

  it('distinguishes a missing token on the receiver', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '')
    vi.stubEnv('NODE_ENV', 'production')

    const result = authorizeInternalApiRequest('caller-token')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('receiver_token_missing')
    expect(result.diagnostics.receiverTokenPresent).toBe(false)
    expect(result.diagnostics.callerTokenPresent).toBe(true)
    expect(result.diagnostics.receiverTokenSource).toBe('missing')
  })

  it('distinguishes a caller that sent no header', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'receiver-token')
    vi.stubEnv('NODE_ENV', 'production')

    const result = authorizeInternalApiRequest(undefined)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('caller_token_missing')
    expect(result.diagnostics.callerTokenPresent).toBe(false)
    expect(result.diagnostics.receiverTokenPresent).toBe(true)
  })

  it('distinguishes two services holding different tokens', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'receiver-token')
    vi.stubEnv('NODE_ENV', 'production')

    const result = authorizeInternalApiRequest('worker-token')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('token_mismatch')
    expect(result.diagnostics.receiverTokenPresent).toBe(true)
    expect(result.diagnostics.callerTokenPresent).toBe(true)
  })

  it('flags same-length-different-value tokens as a mismatch', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'aaaaaaaa')
    vi.stubEnv('NODE_ENV', 'production')

    const result = authorizeInternalApiRequest('bbbbbbbb')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('token_mismatch')
  })

  it('surfaces a whitespace-mangled caller token as the likely cause', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'good-token')
    vi.stubEnv('NODE_ENV', 'production')

    const result = authorizeInternalApiRequest('good-token\n')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('token_mismatch')
    expect(result.diagnostics.callerTokenHasSurroundingWhitespace).toBe(true)
    expect(result.diagnostics.receiverTokenHasSurroundingWhitespace).toBe(false)
  })

  it('never puts a token value, hash, or length in the diagnostics', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'receiver-secret-value')
    vi.stubEnv('NODE_ENV', 'production')

    const result = authorizeInternalApiRequest('caller-secret-value')

    expect(result.ok).toBe(false)
    if (result.ok) return
    const serialised = JSON.stringify(result.diagnostics)
    expect(serialised).not.toContain('receiver-secret-value')
    expect(serialised).not.toContain('caller-secret-value')
    expect(serialised).not.toContain(String('receiver-secret-value'.length))

    // Pin the diagnostics SHAPE exhaustively, not just the absence of the two
    // literal secrets above. The earlier `typeof value is boolean|string` loop
    // was too weak to catch the regression this test exists to prevent: the
    // first revision of this change logged a salted, truncated SHA-256
    // "fingerprint" of the token, which CodeQL rejected as a high-severity leak
    // — and a hex digest is a string, so it would have sailed through that loop
    // and through the `not.toContain` assertions too. Asserting the exact key
    // set means any new or repurposed field fails here instead of relying on
    // CodeQL as the only backstop.
    expect(Object.keys(result.diagnostics).sort()).toEqual([
      'callerTokenHasSurroundingWhitespace',
      'callerTokenPresent',
      'nodeEnv',
      'reason',
      'receiverTokenHasSurroundingWhitespace',
      'receiverTokenPresent',
      'receiverTokenSource'
    ])

    // And pin the free-form-string fields to their enums, so a field cannot be
    // quietly repurposed to carry token-derived material while keeping its name.
    expect(['receiver_token_missing', 'caller_token_missing', 'token_mismatch']).toContain(
      result.diagnostics.reason
    )
    expect(['env', 'dev-fallback', 'missing']).toContain(result.diagnostics.receiverTokenSource)
    expect(typeof result.diagnostics.nodeEnv).toBe('string')
    for (const key of [
      'receiverTokenPresent',
      'callerTokenPresent',
      'receiverTokenHasSurroundingWhitespace',
      'callerTokenHasSurroundingWhitespace'
    ] as const) {
      expect(typeof result.diagnostics[key]).toBe('boolean')
    }
  })
})

describe('describeInternalAuthFailure', () => {
  it('gives a distinct operator-facing sentence per reason', () => {
    const messages = [
      describeInternalAuthFailure('receiver_token_missing'),
      describeInternalAuthFailure('caller_token_missing'),
      describeInternalAuthFailure('token_mismatch')
    ]

    expect(new Set(messages).size).toBe(3)
    expect(messages.every((m) => m.length > 0)).toBe(true)
  })
})

describe('parseInternalAuthFailureReason', () => {
  it('recovers the reason from a nitro 401 error body', () => {
    const body = JSON.stringify({
      error: true,
      url: 'https://coachwatts.com/api/internal/render-email',
      statusCode: 401,
      statusMessage: 'Unauthorized',
      message: 'Unauthorized',
      data: { reason: 'token_mismatch' }
    })

    expect(parseInternalAuthFailureReason(body)).toBe('token_mismatch')
  })

  it('returns null for a body without a reason (e.g. a proxy 401)', () => {
    expect(parseInternalAuthFailureReason('<html>401</html>')).toBeNull()
    expect(parseInternalAuthFailureReason(JSON.stringify({ statusCode: 401 }))).toBeNull()
    expect(parseInternalAuthFailureReason('')).toBeNull()
    expect(parseInternalAuthFailureReason(null)).toBeNull()
  })

  it('rejects an unrecognised reason value', () => {
    const body = JSON.stringify({ data: { reason: 'something-else' } })

    expect(parseInternalAuthFailureReason(body)).toBeNull()
  })
})

describe('assertInternalApiTokenConfigured', () => {
  it('shouts loudly when no token is configured', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '')
    vi.stubEnv('NODE_ENV', 'production')
    const logger = makeLogger()

    const status = assertInternalApiTokenConfigured({ service: 'web', logger })

    expect(status.configured).toBe(false)
    expect(logger.error).toHaveBeenCalledTimes(1)
    const banner = String(logger.error.mock.calls[0]?.[0])
    expect(banner).toContain('INTERNAL_API_TOKEN IS NOT CONFIGURED')
    expect(banner).toContain('service=web')
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('does not throw, so a diagnostic can never stop a service booting', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '')
    vi.stubEnv('NODE_ENV', 'production')

    expect(() =>
      assertInternalApiTokenConfigured({ service: 'worker', logger: makeLogger() })
    ).not.toThrow()
  })

  it('errors on a token with surrounding whitespace', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', ' padded-token ')
    vi.stubEnv('NODE_ENV', 'production')
    const logger = makeLogger()

    assertInternalApiTokenConfigured({ service: 'worker', logger })

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(String(logger.error.mock.calls[0]?.[0])).toContain('whitespace')
  })

  it('warns when a service is on the dev fallback token', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', '')
    vi.stubEnv('NODE_ENV', 'development')
    const logger = makeLogger()

    assertInternalApiTokenConfigured({ service: 'web', logger })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('confirms a healthy boot without disclosing anything about the token', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'production-token')
    vi.stubEnv('NODE_ENV', 'production')
    const logger = makeLogger()

    assertInternalApiTokenConfigured({ service: 'worker', logger })

    expect(logger.error).not.toHaveBeenCalled()
    const line = String(logger.info.mock.calls[0]?.[0])
    expect(line).toContain('service=worker')
    expect(line).toContain('token configured')
  })

  it('never logs the token value, a hash of it, or its length', () => {
    const token = 'do-not-log-this-value'
    vi.stubEnv('INTERNAL_API_TOKEN', token)
    vi.stubEnv('NODE_ENV', 'production')
    const logger = makeLogger()

    assertInternalApiTokenConfigured({ service: 'web', logger })

    const logged = collectLoggedText(logger)
    expect(logged).not.toContain(token)
    expect(logged).not.toContain(String(token.length))
  })
})
