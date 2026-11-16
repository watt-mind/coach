import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isTransientUltrahumanRefreshStatus,
  refreshUltrahumanToken
} from '../../../../server/utils/ultrahuman'
import {
  IntegrationAuthError,
  IntegrationProviderError
} from '../../../../server/utils/integration-errors'

const { prismaIntegrationUpdate } = vi.hoisted(() => ({
  prismaIntegrationUpdate: vi.fn()
}))

vi.mock('../../../../server/utils/db', () => ({
  prisma: {
    integration: {
      update: prismaIntegrationUpdate
    }
  }
}))

function tokenRefreshResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => ({
      access_token: 'new-access-token',
      expires_in: 3600,
      refresh_token: 'new-refresh-token',
      scope: 'sleep',
      token_type: 'Bearer'
    }),
    ...overrides
  }
}

function errorResponse(status: number, statusText: string, retryAfter: string | null = null) {
  return {
    ok: false,
    status,
    statusText,
    headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) },
    text: async () => `upstream error ${status}`,
    json: async () => ({})
  }
}

const integration = {
  id: 'integration-ultrahuman-1',
  accessToken: 'expired-token',
  refreshToken: 'valid-refresh-token',
  expiresAt: new Date(Date.now() - 1000)
} as any

beforeEach(() => {
  prismaIntegrationUpdate.mockReset()
  prismaIntegrationUpdate.mockImplementation(async (args: any) => ({
    ...integration,
    ...args.data
  }))
  vi.restoreAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  process.env.ULTRAHUMAN_CLIENT_ID = 'test-client-id'
  process.env.ULTRAHUMAN_CLIENT_SECRET = 'test-client-secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isTransientUltrahumanRefreshStatus', () => {
  it('classifies 5xx as transient and 4xx as permanent', () => {
    expect(isTransientUltrahumanRefreshStatus(500)).toBe(true)
    expect(isTransientUltrahumanRefreshStatus(503)).toBe(true)
    expect(isTransientUltrahumanRefreshStatus(400)).toBe(false)
    expect(isTransientUltrahumanRefreshStatus(401)).toBe(false)
    expect(isTransientUltrahumanRefreshStatus(429)).toBe(false)
  })
})

describe('refreshUltrahumanToken transient 5xx', () => {
  it('recovers when a 503 is followed by success and surfaces no error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, 'Service Unavailable'))
      .mockResolvedValueOnce(tokenRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshUltrahumanToken(integration, { baseDelayMs: 0 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token'
    })
    // Token rotation persisted; the integration is never marked FAILED.
    expect(prismaIntegrationUpdate).toHaveBeenCalledTimes(1)
    expect(prismaIntegrationUpdate).toHaveBeenCalledWith({
      where: { id: integration.id },
      data: {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: expect.any(Date)
      }
    })
  })

  it('marks the integration FAILED and throws retryable IntegrationProviderError once the retry budget is exhausted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(503, 'Service Unavailable'))
    vi.stubGlobal('fetch', fetchMock)

    const error = await refreshUltrahumanToken(integration, { baseDelayMs: 0 }).catch((e) => e)

    expect(error).toBeInstanceOf(IntegrationProviderError)
    expect(error).toMatchObject({
      name: 'IntegrationProviderError',
      provider: 'ultrahuman',
      integrationId: integration.id,
      statusCode: 503,
      retryable: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // Degraded-signal: FAILED with a user-visible reason, not a silent throw.
    expect(prismaIntegrationUpdate).toHaveBeenCalledWith({
      where: { id: integration.id },
      data: {
        syncStatus: 'FAILED',
        errorMessage: expect.stringContaining('temporarily unavailable')
      }
    })
  })

  it('recovers when a network failure is followed by success', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(tokenRefreshResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await refreshUltrahumanToken(integration, { baseDelayMs: 0 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ accessToken: 'new-access-token' })
  })

  it('still fails fast with IntegrationAuthError on 401 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401, 'Unauthorized'))
    vi.stubGlobal('fetch', fetchMock)

    const error = await refreshUltrahumanToken(integration, { baseDelayMs: 0 }).catch((e) => e)

    expect(error).toBeInstanceOf(IntegrationAuthError)
    expect(error).toMatchObject({ retryable: false, statusCode: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
