import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../../../server/utils/db'
import {
  normalizeIntervalsPlannedWorkout,
  fetchIntervalsPlannedWorkouts,
  normalizeIntervalsCalendarNote
} from '../../../../../server/utils/intervals'
import { IntervalsService } from '../../../../../server/utils/services/intervalsService'

import { calendarNoteRepository } from '../../../../../server/utils/repositories/calendarNoteRepository'
import { eventRepository } from '../../../../../server/utils/repositories/eventRepository'
import { persistIntervalsPlannedWorkoutImport } from '../../../../../server/utils/canonical-planned-workout-write'

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    integration: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    plannedWorkout: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn()
    },
    calendarNote: { findMany: vi.fn() },
    event: { findMany: vi.fn(), deleteMany: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    workout: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn()
    },
    workoutStream: { upsert: vi.fn() }
  }
}))

vi.mock('../../../../../server/utils/intervals', () => ({
  fetchIntervalsAthleteProfile: vi.fn(),
  fetchIntervalsWorkouts: vi.fn(),
  fetchIntervalsActivity: vi.fn(),
  fetchIntervalsWellness: vi.fn(),
  fetchIntervalsPlannedWorkouts: vi.fn(),
  normalizeIntervalsWorkout: vi.fn((activity: any, userId: string) => ({
    userId,
    externalId: String(activity.id),
    source: 'intervals',
    date: new Date(activity.start_date || activity.start_date_local || '2026-01-01T00:00:00Z'),
    title: activity.name || 'Workout',
    type: activity.type || 'Other',
    durationSec: activity.moving_time || 0
  })),
  normalizeIntervalsWellness: vi.fn(),
  normalizeIntervalsPlannedWorkout: vi.fn(),
  normalizeIntervalsCalendarNote: vi.fn(),
  fetchIntervalsActivityStreams: vi.fn(),
  fetchIntervalsAthlete: vi.fn()
}))

vi.mock('../../../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: {
    upsert: vi.fn(),
    getByExternalId: vi.fn(),
    update: vi.fn()
  }
}))

vi.mock('../../../../../server/utils/repositories/sportSettingsRepository', () => ({
  sportSettingsRepository: {
    getForActivityType: vi.fn().mockResolvedValue({ paceZones: [{ min: 0, max: 1 }] })
  }
}))

vi.mock('../../../../../server/utils/repositories/calendarNoteRepository', () => ({
  calendarNoteRepository: {
    upsert: vi.fn(),
    deleteExternal: vi.fn()
  }
}))

vi.mock('../../../../../server/utils/normalize-tss', () => ({
  normalizeTSS: vi.fn().mockResolvedValue({ tss: null })
}))

vi.mock('../../../../../server/utils/calculate-workout-stress', () => ({
  calculateWorkoutStress: vi.fn()
}))

vi.mock('../../../../../server/utils/date', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
  getEndOfDayUTC: vi.fn((_: string, d: Date) => d),
  getStartOfDayUTC: vi.fn(
    (_: string, d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  )
}))

vi.mock('../../../../../server/utils/services/wellness-analysis', () => ({
  triggerReadinessCheckIfNeeded: vi.fn()
}))

vi.mock('../../../../../server/utils/trigger-workout-deduplication', () => ({
  triggerWorkoutDeduplicationIfEnabled: vi.fn().mockResolvedValue(true)
}))

vi.mock('../../../../../trigger/deduplicate-workouts', () => ({
  deduplicateWorkoutsTask: {
    trigger: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('../../../../../trigger/queues', () => ({
  userIngestionQueue: {
    trigger: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('../../../../../server/utils/intervals-stream-queue', () => ({
  enqueueIntervalsStreamSync: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../../../../server/utils/canonical-planned-workout-write', () => ({
  persistIntervalsPlannedWorkoutImport: vi.fn()
}))
vi.mock('../../../../../server/utils/repositories/eventRepository', () => ({
  eventRepository: { upsertExternal: vi.fn() }
}))
vi.mock('../../../../../server/utils/task-runtime', () => ({
  yieldTaskHeartbeat: vi.fn()
}))

describe('calendar reconciliation with skipExisting', () => {
  const userId = 'user-1'
  const start = new Date('2026-01-01T00:00:00Z')
  const end = new Date('2026-01-31T23:59:59Z')

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(prisma.integration.findUnique).mockResolvedValue({ settings: {} } as any)
    vi.mocked(normalizeIntervalsCalendarNote).mockImplementation(
      (item: any) =>
        ({
          externalId: String(item.id)
        }) as any
    )
    vi.mocked(normalizeIntervalsPlannedWorkout).mockImplementation(
      (item: any) =>
        ({
          externalId: String(item.id),
          title: item.name
        }) as any
    )
  })

  it.each([
    { skipExisting: true, withNew: true },
    { skipExisting: true, withNew: false },
    { skipExisting: false, withNew: true },
    { skipExisting: false, withNew: false }
  ])(
    'preserves remote records and deletes only real orphans: %o',
    async ({ skipExisting, withNew }) => {
      const remote = [
        { id: 101, type: 'Other' },
        { id: 102, type: 'Other' },
        { id: 103, category: 'NOTE' },
        { id: 104, category: 'RACE_A', type: 'Other', start_date_local: '2026-01-10T09:00:00' },
        ...(withNew ? [{ id: 105, category: 'NOTE' }] : [])
      ]
      vi.mocked(fetchIntervalsPlannedWorkouts).mockResolvedValue(remote as any)

      // Return skip-existing matches separately from reconciliation candidates.
      vi.mocked(prisma.plannedWorkout.findMany).mockImplementation(async (args: any) => {
        if (args.where.externalId) {
          return ['101', '102']
            .filter((id) => args.where.externalId.in.includes(id))
            .map((externalId) => ({ externalId })) as any
        }
        return [
          { externalId: '101', completed: false },
          { externalId: '102', completed: false },
          { externalId: '201', completed: false },
          { externalId: '301', completed: true },
          { externalId: 'ai-local', completed: false },
          { externalId: null, completed: false }
        ] as any
      })
      vi.mocked(prisma.calendarNote.findMany).mockImplementation(
        async (args: any) =>
          (args.where.externalId
            ? [{ externalId: '103' }]
            : [{ externalId: '103' }, { externalId: '202' }, { externalId: 'local-note' }]) as any
      )
      vi.mocked(prisma.event.findMany).mockImplementation(
        async (args: any) =>
          (args.where.externalId
            ? [{ externalId: '104' }]
            : [{ externalId: '104' }, { externalId: '203' }, { externalId: 'local-race' }]) as any
      )

      const result = await IntervalsService.syncPlannedWorkouts(userId, start, end, {
        skipExisting
      })

      // Exercise the real deletePlannedWorkouts helper, including notes and events.
      const orphanIds = ['201', '202', '203']
      expect(prisma.plannedWorkout.deleteMany).toHaveBeenCalledWith({
        where: { userId, externalId: { in: orphanIds } }
      })
      expect(prisma.event.deleteMany).toHaveBeenCalledWith({
        where: { userId, source: 'intervals', externalId: { in: orphanIds } }
      })
      expect(calendarNoteRepository.deleteExternal).toHaveBeenCalledWith(
        userId,
        'intervals',
        orphanIds
      )
      expect(prisma.plannedWorkout.deleteMany).toHaveBeenCalledTimes(
        1 + (skipExisting ? 0 : 1) + Number(withNew)
      )
      expect(prisma.event.deleteMany).toHaveBeenCalledTimes(
        1 + (skipExisting ? 0 : 1) + Number(withNew)
      )
      expect(persistIntervalsPlannedWorkoutImport).toHaveBeenCalledTimes(skipExisting ? 0 : 3)
      expect(eventRepository.upsertExternal).toHaveBeenCalledTimes(skipExisting ? 0 : 1)
      expect(calendarNoteRepository.upsert).toHaveBeenCalledTimes(
        (skipExisting ? 0 : 1) + Number(withNew)
      )
      if (withNew) {
        expect(calendarNoteRepository.upsert).toHaveBeenCalledWith(userId, 'intervals', '105', {
          externalId: '105'
        })
      }
      expect(result).toEqual({
        plannedWorkouts: skipExisting ? 0 : 3,
        events: skipExisting ? 0 : 1,
        notes: (skipExisting ? 0 : 1) + Number(withNew)
      })
      expect(prisma.plannedWorkout.findMany).toHaveBeenCalledWith({
        where: {
          userId,
          date: { gte: start, lte: end },
          OR: [{ syncStatus: 'SYNCED' }, { syncStatus: null }]
        },
        select: { externalId: true, completed: true }
      })
      expect(prisma.calendarNote.findMany).toHaveBeenCalledWith({
        where: { userId, startDate: { gte: start, lte: end }, source: 'intervals' },
        select: { externalId: true }
      })
      expect(prisma.event.findMany).toHaveBeenCalledWith({
        where: { userId, date: { gte: start, lte: end }, source: 'intervals' },
        select: { externalId: true }
      })
    }
  )
})
