import type { Integration } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../../server/utils/db'
import {
  fetchFitbitFoodGoals,
  fetchFitbitFoodLog,
  fetchFitbitWaterLog,
  fetchFitbitSleepLog
} from '../../../../server/utils/fitbit'

vi.mock('../../../../server/utils/db', () => ({
  prisma: { integration: { update: vi.fn() } }
}))

const now = new Date('2026-11-11T12:00:00Z')
const date = '2026-11-11'
const token = {
  access_token: 'test-access-new',
  refresh_token: 'test-refresh-new',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'nutrition sleep',
  user_id: 'test-fitbit-user'
}
const json = (body: unknown = {}, status = 200) => new Response(JSON.stringify(body), { status })

function integration(minutes = 60): Integration {
  return {
    id: 'test-integration',
    accessToken: 'test-access-old',
    refreshToken: 'test-refresh-old',
    expiresAt: new Date(now.getTime() + minutes * 60_000),
    scope: 'nutrition',
    externalUserId: 'test-old-user'
  } as Integration
}

async function sequentialCalls(shared: Integration) {
  await fetchFitbitFoodGoals(shared)
  await fetchFitbitFoodLog(shared, date)
  await fetchFitbitWaterLog(shared, date)
  await fetchFitbitSleepLog(shared, date)
}

describe('Fitbit credential propagation through endpoint helpers', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const update = vi.mocked(prisma.integration.update)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    vi.stubEnv('FITBIT_CLIENT_ID', 'test-client')
    vi.stubEnv('FITBIT_CLIENT_SECRET', 'test-secret')
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset().mockImplementation(async () => json())
    update.mockReset().mockImplementation(
      async ({ data }) =>
        ({
          ...integration(),
          ...data
        }) as Integration
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function expectBearerCalls(accessToken: string, start = 0) {
    for (const [, options] of fetchMock.mock.calls.slice(start)) {
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${accessToken}` })
    }
  }

  it.each([-1, 5])(
    'refreshes once at expiry/buffer (%i minutes) across a sequential sync',
    async (minutes) => {
      const shared = integration(minutes)
      fetchMock.mockResolvedValueOnce(json(token))
      await sequentialCalls(shared)
      expect(fetchMock).toHaveBeenCalledTimes(5)
      expect(update).toHaveBeenCalledExactlyOnceWith({
        where: { id: shared.id },
        data: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: new Date(now.getTime() + 3600_000),
          scope: token.scope,
          externalUserId: token.user_id
        }
      })
      expect(shared).toMatchObject(update.mock.calls[0]![0].data)
      expect(
        new URLSearchParams(fetchMock.mock.calls[0]![1]?.body as string).get('refresh_token')
      ).toBe('test-refresh-old')
      expectBearerCalls(token.access_token, 1)

      vi.setSystemTime(new Date(now.getTime() + 3600_000))
      fetchMock.mockResolvedValueOnce(json({ ...token, refresh_token: 'test-refresh-latest' }))
      await fetchFitbitFoodGoals(shared)
      expect(update).toHaveBeenCalledTimes(2)
      expect(
        new URLSearchParams(fetchMock.mock.calls[5]![1]?.body as string).get('refresh_token')
      ).toBe(token.refresh_token)
      expect(shared.refreshToken).toBe('test-refresh-latest')
    }
  )

  it('propagates a 401 refresh to later calls, including after an expiry refresh', async () => {
    const shared = integration(-1)
    fetchMock
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ ...token, access_token: 'test-access-latest' }))
    await sequentialCalls(shared)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(update).toHaveBeenCalledTimes(2)
    expect(
      new URLSearchParams(fetchMock.mock.calls[2]![1]?.body as string).get('refresh_token')
    ).toBe(token.refresh_token)
    expectBearerCalls('test-access-latest', 3)
    expect(shared.accessToken).toBe('test-access-latest')
  })

  it('refreshes a valid token on 401 and reuses it sequentially', async () => {
    const shared = integration()
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json(token))
    await sequentialCalls(shared)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(update).toHaveBeenCalledTimes(1)
    expectBearerCalls(token.access_token, 2)
  })

  it('reuses a token outside the five-minute buffer without refreshing', async () => {
    await sequentialCalls(integration(5 + 1 / 60))
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(update).not.toHaveBeenCalled()
    expectBearerCalls('test-access-old')
  })

  it('retains the single authentication retry when the retry also returns 401', async () => {
    const shared = integration()
    fetchMock
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({}, 401))
    await expect(fetchFitbitFoodGoals(shared)).rejects.toThrow('Fitbit API request failed: 401')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(update).toHaveBeenCalledTimes(1)
    expect(shared.accessToken).toBe(token.access_token)
  })

  it.each(['provider', 'network', 'malformed', 'persistence'])(
    'does not corrupt credentials after %s failure',
    async (failure) => {
      const shared = integration(-1)
      const original = { ...shared }
      if (failure === 'provider') fetchMock.mockResolvedValueOnce(json({}, 400))
      if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'))
      if (failure === 'malformed')
        fetchMock.mockResolvedValueOnce(json({ access_token: 'incomplete' }))
      if (failure === 'persistence') {
        fetchMock.mockResolvedValueOnce(json(token))
        update.mockRejectedValueOnce(new Error('database unavailable'))
      }
      await expect(fetchFitbitFoodGoals(shared)).rejects.toThrow()
      expect(shared).toEqual(original)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(update).toHaveBeenCalledTimes(failure === 'persistence' ? 1 : 0)
    }
  )

  it('does not retry the API after a failed 401 refresh', async () => {
    const shared = integration()
    const original = { ...shared }
    fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}, 400))
    await expect(fetchFitbitFoodGoals(shared)).rejects.toThrow('Failed to refresh Fitbit token')
    expect(shared).toEqual(original)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(update).not.toHaveBeenCalled()
  })
})
