import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  session: vi.fn(),
  user: vi.fn(),
  timezone: vi.fn(),
  workouts: vi.fn(),
  attach: vi.fn(),
  settings: vi.fn(),
  defaults: vi.fn()
}))
vi.mock('h3', async (original) => ({
  ...(await original<typeof import('h3')>()),
  getQuery: () => mocks.query
}))
vi.mock('../../../../../server/utils/db', () => ({
  prisma: { user: { findUnique: mocks.timezone } }
}))
vi.mock('../../../../../server/utils/session', () => ({ getServerSession: mocks.session }))
vi.mock('../../../../../server/utils/repositories/userRepository', () => ({
  userRepository: { getById: mocks.user }
}))
vi.mock('../../../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: { getForUser: mocks.workouts }
}))
vi.mock('../../../../../server/utils/repositories/workoutStreamRepository', () => ({
  attachStreamsToWorkouts: mocks.attach
}))
vi.mock('../../../../../server/utils/repositories/sportSettingsRepository', () => ({
  sportSettingsRepository: { getByUserId: mocks.settings, getDefault: mocks.defaults }
}))

const zones = [{ name: 'Easy', min: 0, max: 300 }]
const event = {} as H3Event
let handler: typeof import('../../../../../server/api/analytics/weekly-zones.get').default

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))
  vi.stubGlobal('defineRouteMeta', vi.fn())
  mocks.query = { weeks: '12' }
  mocks.session.mockResolvedValue({ user: { id: 'athlete' } })
  mocks.timezone.mockResolvedValue({ timezone: 'UTC' })
  mocks.user.mockResolvedValue({ ftp: 200, lthr: 160, maxHr: 190 })
  mocks.settings.mockResolvedValue([])
  mocks.defaults.mockResolvedValue({ powerZones: zones, hrZones: zones })
  mocks.workouts.mockResolvedValue([])
  mocks.attach.mockImplementation(async (records) =>
    records.map((record: { id: string }) => ({
      ...record,
      streams: {
        time: Array.from({ length: 361 }, (_, i) => i),
        watts: Array(361).fill(100),
        heartrate: Array(361).fill(120)
      }
    }))
  )
  handler = (await import('../../../../../server/api/analytics/weekly-zones.get')).default
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('weekly zones local-day upper bound', () => {
  const cases = [
    ['UTC', '2026-11-11T12:00:00Z', '2026-11-11T09:00:00Z', '2026-11-11T23:59:59.999Z'],
    ['Asia/Tokyo', '2026-11-10T23:00:00Z', '2026-11-11T00:00:00Z', '2026-11-11T14:59:59.999Z'],
    [
      'America/Los_Angeles',
      '2026-11-12T02:00:00Z',
      '2026-11-11T17:00:00Z',
      '2026-11-12T07:59:59.999Z'
    ],
    ['Europe/Berlin', '2026-03-29T00:00:00Z', '2026-03-29T07:00:00Z', '2026-03-29T21:59:59.999Z'],
    ['Europe/Berlin', '2026-10-25T00:00:00Z', '2026-10-25T08:00:00Z', '2026-10-25T22:59:59.999Z']
  ]
  for (const weeks of ['12', 'YTD']) {
    it.each(cases)(
      `${weeks}: includes today and last millisecond, excludes tomorrow in %s`,
      async (timezone, now, morning, end) => {
        vi.setSystemTime(new Date(now!))
        mocks.timezone.mockResolvedValue({ timezone })
        mocks.query = { weeks, sport: 'Ride', tags: 'tempo' }
        const records = [morning!, end!, new Date(new Date(end!).getTime() + 1).toISOString()].map(
          (date, i) => ({ id: String(i), date: new Date(date), type: 'Ride', tags: ['tempo'] })
        )
        mocks.workouts.mockImplementation(async (_user, options) =>
          records.filter(
            (w) =>
              w.date >= options.startDate &&
              w.date <= options.endDate &&
              w.type === options.where.type &&
              options.tags.every((tag: string) => w.tags.includes(tag))
          )
        )
        const response = await handler(event)
        expect(mocks.workouts).toHaveBeenCalledWith(
          'athlete',
          expect.objectContaining({
            endDate: new Date(end!),
            where: { type: 'Ride' },
            tags: ['tempo'],
            select: { id: true, date: true, ftp: true, type: true }
          })
        )
        expect(mocks.attach).toHaveBeenCalledWith(records.slice(0, 2), { baselineOnly: true })
        expect(response.zoneLabels).toEqual({ power: ['Easy'], hr: ['Easy'] })
        expect(response.weeks.reduce((sum, w) => sum + w.totalDuration, 0)).toBe(0.2)
        expect(response.weeks.reduce((sum, w) => sum + w.powerZones[0]!, 0)).toBe(0.2)
        expect(response.weeks.reduce((sum, w) => sum + w.hrZones[0]!, 0)).toBe(0.2)
      }
    )
  }
  it('rejects unauthenticated requests before reading workouts', async () => {
    mocks.session.mockResolvedValue(null)
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 401 })
    expect(mocks.workouts).not.toHaveBeenCalled()
  })
  it('preserves all-sport queries and missing-user errors', async () => {
    mocks.query = { sport: 'all' }
    await handler(event)
    expect(mocks.workouts).toHaveBeenCalledWith(
      'athlete',
      expect.objectContaining({ where: undefined })
    )
    mocks.user.mockResolvedValue(null)
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 404 })
  })
})
