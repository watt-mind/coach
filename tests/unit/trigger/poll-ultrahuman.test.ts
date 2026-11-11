import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollUltrahumanTask } from '../../../trigger/poll-ultrahuman'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  dispatch: vi.fn()
}))
vi.mock('@trigger.dev/sdk/v3', () => ({ task: (config: unknown) => config }))
vi.mock('../../../server/utils/db', () => ({
  prisma: { integration: { findMany: mocks.findMany }, user: { findUnique: mocks.findUnique } }
}))
vi.mock('../../../server/utils/task-dispatcher', () => ({ dispatchTask: mocks.dispatch }))

// SDK registration is mocked to expose the real handler without services.
const run = (
  pollUltrahumanTask as unknown as {
    run: (payload: { timestamp: string }) => Promise<void>
  }
).run
const integration = (settings: Record<string, unknown> = {}, userId = 'athlete') => ({
  id: `integration-${userId}`,
  userId,
  settings
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.findMany.mockResolvedValue([integration()])
  mocks.findUnique.mockResolvedValue({ timezone: 'UTC' })
  mocks.dispatch.mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('Ultrahuman hourly polling', () => {
  it('does not dispatch at local 13:05 without a preference', async () => {
    await run({ timestamp: '2026-11-11T13:05:00Z' })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it.each(Array.from({ length: 24 }, (_, hour) => hour))(
    'fallback at UTC hour %i',
    async (hour) => {
      await run({ timestamp: `2026-11-11T${String(hour).padStart(2, '0')}:05:00Z` })
      expect(mocks.dispatch).toHaveBeenCalledTimes(hour % 6 === 0 ? 1 : 0)
    }
  )

  it.each(['13:00', '13:59'])('matches preferred %s by hour', async (preferredSyncTime) => {
    mocks.findMany.mockResolvedValue([integration({ preferredSyncTime })])
    await run({ timestamp: '2026-11-11T13:05:00Z' })
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch for a different preferred hour', async () => {
    mocks.findMany.mockResolvedValue([integration({ preferredSyncTime: '14:05' })])
    await run({ timestamp: '2026-11-11T13:05:00Z' })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('dispatches once when fallback and preference overlap', async () => {
    mocks.findMany.mockResolvedValue([integration({ preferredSyncTime: '12:45' })])
    await run({ timestamp: '2026-11-11T12:05:00Z' })
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })

  it('still uses fallback when preference does not match', async () => {
    mocks.findMany.mockResolvedValue([integration({ preferredSyncTime: '13:00' })])
    await run({ timestamp: '2026-11-11T12:05:00Z' })
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })

  it('disabled sync overrides both triggers', async () => {
    mocks.findMany.mockResolvedValue([integration({ autoSync: false, preferredSyncTime: '12:00' })])
    await run({ timestamp: '2026-11-11T12:05:00Z' })
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    ['Asia/Kolkata', '2026-11-11T07:35:00Z', undefined, false, '2026-11-11'],
    ['Asia/Kolkata', '2026-11-11T07:35:00Z', '13:59', true, '2026-11-11'],
    ['Asia/Tokyo', '2026-12-31T15:05:00Z', undefined, true, '2027-01-01'],
    ['America/Los_Angeles', '2027-01-01T02:05:00Z', undefined, true, '2026-12-31'],
    ['America/New_York', '2026-03-08T06:05:00Z', '01:59', true, '2026-03-08'],
    ['America/New_York', '2026-03-08T07:05:00Z', '02:00', false, '2026-03-08'],
    ['America/New_York', '2026-03-08T07:05:00Z', '03:59', true, '2026-03-08'],
    ['America/New_York', '2026-11-01T05:05:00Z', '01:59', true, '2026-11-01'],
    ['America/New_York', '2026-11-01T06:05:00Z', '01:59', true, '2026-11-01']
  ])(
    'uses local hour and calendar range: %s %s preference %s',
    async (timezone, timestamp, preferredSyncTime, expected, date) => {
      mocks.findUnique.mockResolvedValue({ timezone })
      mocks.findMany.mockResolvedValue([integration({ preferredSyncTime })])
      await run({ timestamp })
      expect(mocks.dispatch).toHaveBeenCalledTimes(expected ? 1 : 0)
      if (expected) {
        const yesterday = new Date(`${date}T00:00:00Z`)
        yesterday.setUTCDate(yesterday.getUTCDate() - 1)
        expect(mocks.dispatch).toHaveBeenCalledWith(
          'ingest-ultrahuman',
          {
            userId: 'athlete',
            startDate: yesterday.toISOString(),
            endDate: `${date}T00:00:00.000Z`
          },
          { concurrencyKey: 'athlete', tags: ['user:athlete', 'auto-poll'] }
        )
      }
    }
  )

  it('isolates a failed dispatch and continues with the next integration', async () => {
    mocks.findMany.mockResolvedValue([integration({}, 'first'), integration({}, 'second')])
    mocks.dispatch.mockRejectedValueOnce(new Error('queue unavailable'))
    await run({ timestamp: '2026-11-11T12:05:00Z' })
    expect(mocks.dispatch).toHaveBeenCalledTimes(2)
    expect(mocks.dispatch.mock.calls[1]?.[1].userId).toBe('second')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('integration-first'),
      expect.any(Error)
    )
  })
})
