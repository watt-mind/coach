import type { Integration } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../../server/utils/db'
import { fetchStravaActivityStreams, StravaStreamsError } from '../../../../server/utils/strava'

vi.mock('../../../../server/utils/db', () => ({
  prisma: { integration: { updateMany: vi.fn() } }
}))

const integration = {
  id: 'integration-1',
  userId: 'user-1',
  accessToken: 'test-token',
  expiresAt: null
} as Integration

const fetchMock = vi.fn()
const streams = { time: { type: 'time', data: [0, 1] } }

function failure(status: number, body = '<html>' + 'x'.repeat(100_000)) {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

// Attach the rejection handler before advancing timers to avoid unhandled rejections.
function capture() {
  return fetchStravaActivityStreams(integration, 42).catch((error: unknown) => error)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  vi.mocked(prisma.integration.updateMany).mockReset().mockResolvedValue({ count: 1 })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Strava activity streams', () => {
  it('preserves successful data and request parameters', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(streams)))
    await expect(fetchStravaActivityStreams(integration, 42, ['time'])).resolves.toEqual(streams)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.strava.com/api/v3/activities/42/streams?keys=time&key_by_type=true',
      { headers: { Authorization: 'Bearer test-token' } }
    )
    expect(prisma.integration.updateMany).not.toHaveBeenCalled()
  })

  it('recovers from 503 with exponential backoff without recording a failure', async () => {
    fetchMock
      .mockResolvedValueOnce(failure(503))
      .mockResolvedValueOnce(failure(502))
      .mockResolvedValueOnce(new Response(JSON.stringify(streams)))
    const result = capture()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual(streams)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(prisma.integration.updateMany).not.toHaveBeenCalled()
  })

  it.each(['<html>' + 'secret'.repeat(100_000), '{"message":"different upstream content"}'])(
    'records exhausted 503 with bounded body-independent transient error (%#)',
    async (body) => {
      fetchMock.mockImplementation(() => Promise.resolve(failure(503, body)))
      const result = capture()
      await vi.runAllTimersAsync()
      const error = await result
      expect(error).toBeInstanceOf(StravaStreamsError)
      expect(error).toMatchObject({
        message: 'Strava Streams API error: 503',
        statusCode: 503,
        transient: true
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(prisma.integration.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: integration.id, userId: integration.userId, provider: 'strava' },
        data: {
          syncStatus: 'FAILED',
          errorMessage:
            'Strava Streams API error: 503; streams unavailable for activity 42 after 3 attempts. Please retry later.'
        }
      })
    }
  )

  it.each([400, 401, 403, 404, 429])(
    'fails fast for %i and preserves the 404 caller contract',
    async (status) => {
      fetchMock.mockResolvedValue(failure(status))
      const error = await capture()
      expect(error).toMatchObject({
        message: `Strava Streams API error: ${status}`,
        transient: false
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(prisma.integration.updateMany).not.toHaveBeenCalled()
    }
  )

  it('retries even when discarding the failed response body rejects', async () => {
    const response = failure(503)
    vi.spyOn(response.body!, 'cancel').mockRejectedValue(new Error('stream cleanup failed'))
    fetchMock
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(JSON.stringify(streams)))
    const result = capture()
    await vi.runAllTimersAsync()
    expect(await result).toEqual(streams)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves both provider and recording failures', async () => {
    const dbError = new Error('database unavailable')
    vi.mocked(prisma.integration.updateMany).mockRejectedValue(dbError)
    fetchMock.mockImplementation(() => Promise.resolve(failure(503)))
    const result = capture()
    await vi.runAllTimersAsync()
    const error = (await result) as AggregateError
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors[0]).toMatchObject({ statusCode: 503, transient: true })
    expect(error.errors[1]).toBe(dbError)
  })
})
