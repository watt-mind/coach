import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../../../server/utils/db'
import {
  normalizeIntervalsWorkout,
  normalizeIntervalsPlannedWorkout,
  fetchIntervalsActivity,
  fetchIntervalsWorkouts,
  fetchIntervalsActivityStreams
} from '../../../../../server/utils/intervals'
import { workoutRepository } from '../../../../../server/utils/repositories/workoutRepository'
import { sportSettingsRepository } from '../../../../../server/utils/repositories/sportSettingsRepository'
import { workoutStreamRepository } from '../../../../../server/utils/repositories/workoutStreamRepository'
import { DEFAULT_HR_ZONES, DEFAULT_POWER_ZONES } from '../../../../../server/utils/training-metrics'
import { deduplicateWorkoutsTask } from '../../../../../trigger/deduplicate-workouts'
import { triggerWorkoutDeduplicationIfEnabled } from '../../../../../server/utils/trigger-workout-deduplication'
import { IntervalsService } from '../../../../../server/utils/services/intervalsService'

import { enqueueIntervalsStreamSync } from '../../../../../server/utils/intervals-stream-queue'

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
  fetchIntervalsAthlete: vi.fn(),
  hasInvalidIntervalsElevationMetadata: vi.fn().mockReturnValue(false),
  computeElevationGainFromAltitudeStream: vi.fn().mockReturnValue(null)
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
    getForActivityType: vi.fn().mockResolvedValue({ paceZones: [{ min: 0, max: 1 }] }),
    getDefault: vi.fn().mockResolvedValue(null)
  }
}))

vi.mock('../../../../../server/utils/repositories/workoutStreamRepository', () => ({
  workoutStreamRepository: {
    upsert: vi.fn(),
    findByWorkoutId: vi.fn()
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

describe('IntervalsService ACTIVITY_UPDATED', () => {
  const userId = 'user-1'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(deduplicateWorkoutsTask.trigger).mockResolvedValue(undefined as any)
  })

  it('uses payload-first upsert when ACTIVITY_UPDATED includes full activity date', async () => {
    vi.mocked(prisma.plannedWorkout.findUnique).mockResolvedValue(null as any)
    vi.mocked(workoutRepository.upsert).mockResolvedValue({
      record: { id: 'w-rich' } as any,
      isNew: false
    })

    const syncSpy = vi.spyOn(IntervalsService, 'syncActivities').mockResolvedValue(0)
    const streamSpy = vi
      .spyOn(IntervalsService, 'syncActivityStream')
      .mockResolvedValue(null as any)

    const event = {
      activity: {
        id: 'i123',
        name: 'Tempo Run',
        type: 'Run',
        start_date: '2026-01-21T19:11:43Z',
        moving_time: 3600,
        stream_types: []
      }
    }

    const result = await IntervalsService.processWebhookEvent(userId, 'ACTIVITY_UPDATED', event)

    expect(result.handled).toBe(true)
    expect(normalizeIntervalsWorkout).toHaveBeenCalledWith(event.activity, userId)
    expect(workoutRepository.upsert).toHaveBeenCalledTimes(1)
    expect(syncSpy).not.toHaveBeenCalled()
    expect(streamSpy).not.toHaveBeenCalled()
    expect(deduplicateWorkoutsTask.trigger).not.toHaveBeenCalled()
    expect(triggerWorkoutDeduplicationIfEnabled).toHaveBeenCalledTimes(1)
    expect(triggerWorkoutDeduplicationIfEnabled).toHaveBeenCalledWith(userId)

    syncSpy.mockRestore()
    streamSpy.mockRestore()
  })

  it('does not sync activity streams inline on webhook when stream_types are present', async () => {
    vi.mocked(prisma.plannedWorkout.findUnique).mockResolvedValue(null as any)
    vi.mocked(workoutRepository.upsert).mockResolvedValue({
      record: { id: 'w-stream' } as any,
      isNew: true
    })

    const streamSpy = vi
      .spyOn(IntervalsService, 'syncActivityStream')
      .mockResolvedValue(null as any)

    await IntervalsService.processWebhookEvent(userId, 'ACTIVITY_UPLOADED', {
      activity: {
        id: 'i555',
        name: 'Long Ride',
        type: 'Ride',
        start_date: '2026-01-21T10:00:00Z',
        moving_time: 7200,
        stream_types: ['time', 'watts', 'heartrate']
      }
    })

    expect(workoutRepository.upsert).toHaveBeenCalledTimes(1)
    expect(streamSpy).not.toHaveBeenCalled()
    expect(enqueueIntervalsStreamSync).toHaveBeenCalledWith({
      userId,
      workoutId: 'w-stream',
      activityId: 'i555'
    })

    streamSpy.mockRestore()
  })

  it('applies delta update without sync when payload is thin but workout exists', async () => {
    vi.mocked(workoutRepository.getByExternalId).mockResolvedValue({
      id: 'w-thin',
      rawJson: { existing: true },
      tags: ['local-tag', 'icu:old']
    } as any)

    const syncSpy = vi.spyOn(IntervalsService, 'syncActivities').mockResolvedValue(0)

    const event = {
      activity: {
        id: 'i999',
        name: 'Indoor Cycling',
        description: 'Updated title only',
        tags: ['RECOVERY']
      }
    }

    await IntervalsService.processWebhookEvent(userId, 'ACTIVITY_UPDATED', event)

    expect(workoutRepository.upsert).not.toHaveBeenCalled()
    expect(workoutRepository.update).toHaveBeenCalledTimes(1)
    expect(workoutRepository.update).toHaveBeenCalledWith(
      'w-thin',
      expect.objectContaining({
        title: 'Indoor Cycling',
        description: 'Updated title only',
        tags: ['icu:recovery', 'local-tag'],
        rawJson: expect.objectContaining({
          existing: true,
          id: 'i999'
        })
      })
    )
    expect(syncSpy).not.toHaveBeenCalled()
    expect(deduplicateWorkoutsTask.trigger).not.toHaveBeenCalled()
    expect(triggerWorkoutDeduplicationIfEnabled).toHaveBeenCalledTimes(1)
    expect(triggerWorkoutDeduplicationIfEnabled).toHaveBeenCalledWith(userId)

    syncSpy.mockRestore()
  })

  it('skips full sync when payload is thin and workout does not exist locally', async () => {
    vi.mocked(workoutRepository.getByExternalId).mockResolvedValue(null)

    const syncSpy = vi.spyOn(IntervalsService, 'syncActivities').mockResolvedValue(0)

    const event = {
      activity: {
        id: 'i404',
        name: 'Partial payload'
      }
    }

    await IntervalsService.processWebhookEvent(userId, 'ACTIVITY_UPDATED', event)

    expect(workoutRepository.upsert).not.toHaveBeenCalled()
    expect(workoutRepository.update).not.toHaveBeenCalled()
    expect(syncSpy).not.toHaveBeenCalled()
    expect(deduplicateWorkoutsTask.trigger).not.toHaveBeenCalled()
    expect(triggerWorkoutDeduplicationIfEnabled).toHaveBeenCalledTimes(1)
    expect(triggerWorkoutDeduplicationIfEnabled).toHaveBeenCalledWith(userId)

    syncSpy.mockRestore()
  })
})

describe('IntervalsService syncActivities batch filtering', () => {
  const userId = 'user-1'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.workout.findMany).mockResolvedValue([])
    vi.mocked(prisma.integration.findUnique).mockResolvedValue(null as any)
    vi.mocked(fetchIntervalsActivity).mockImplementation(async (_integration, id) => ({
      id,
      start_date: '2026-04-27T17:41:56Z',
      name: 'Recovered Ride',
      type: 'Ride',
      moving_time: 3600,
      source: 'STRAVA'
    }))
    vi.mocked(workoutRepository.upsert).mockResolvedValue({
      record: { id: 'w-sync' } as any,
      isNew: true
    })
  })

  it('ingests mirrored Strava activities from Intervals when Strava is disconnected and the workout is missing locally', async () => {
    vi.mocked(fetchIntervalsWorkouts).mockResolvedValue([
      {
        id: '18280178712',
        start_date: '2026-04-27T17:41:56Z',
        name: 'Recovered Ride',
        type: 'Ride',
        moving_time: 3600,
        source: 'STRAVA',
        _note: 'STRAVA activities are not available via the API'
      } as any
    ])

    const inserted = await IntervalsService._syncActivitiesBatch(
      userId,
      { id: 'int-1' } as any,
      new Date('2026-04-27T00:00:00Z'),
      new Date('2026-04-27T23:59:59Z')
    )

    expect(inserted).toBe(1)
    expect(normalizeIntervalsWorkout).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '18280178712',
        source: 'STRAVA'
      }),
      userId
    )
    expect(workoutRepository.upsert).toHaveBeenCalledTimes(1)
  })

  it('skips mirrored Strava activities from Intervals when Strava is still connected', async () => {
    vi.mocked(fetchIntervalsWorkouts).mockResolvedValue([
      {
        id: '18280178712',
        start_date: '2026-04-27T17:41:56Z',
        name: 'Recovered Ride',
        type: 'Ride',
        moving_time: 3600,
        source: 'STRAVA',
        _note: 'STRAVA activities are not available via the API'
      } as any
    ])
    vi.mocked(prisma.integration.findUnique).mockResolvedValue({ id: 'strava-1' } as any)

    const inserted = await IntervalsService._syncActivitiesBatch(
      userId,
      { id: 'int-1' } as any,
      new Date('2026-04-27T00:00:00Z'),
      new Date('2026-04-27T23:59:59Z')
    )

    expect(inserted).toBe(0)
    expect(workoutRepository.upsert).not.toHaveBeenCalled()
  })

  it('skips mirrored Strava activities from Intervals when a local workout with the same external id already exists', async () => {
    vi.mocked(fetchIntervalsWorkouts).mockResolvedValue([
      {
        id: '18280178712',
        start_date: '2026-04-27T17:41:56Z',
        name: 'Recovered Ride',
        type: 'Ride',
        moving_time: 3600,
        source: 'STRAVA',
        _note: 'STRAVA activities are not available via the API'
      } as any
    ])
    vi.mocked(prisma.workout.findMany).mockResolvedValue([{ externalId: '18280178712' }] as any)

    const inserted = await IntervalsService._syncActivitiesBatch(
      userId,
      { id: 'int-1' } as any,
      new Date('2026-04-27T00:00:00Z'),
      new Date('2026-04-27T23:59:59Z')
    )

    expect(inserted).toBe(0)
    expect(workoutRepository.upsert).not.toHaveBeenCalled()
  })
})

describe('IntervalsService CALENDAR_UPDATED', () => {
  const userId = 'user-1'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.integration.findUnique).mockResolvedValue({
      ingestWorkouts: true,
      settings: null
    } as any)
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([])
  })

  it('deletes planned workouts when deleted_events contains object payloads', async () => {
    const deleteSpy = vi
      .spyOn(IntervalsService, 'deletePlannedWorkouts')
      .mockResolvedValue(undefined as any)

    await IntervalsService.processWebhookEvent(userId, 'CALENDAR_UPDATED', {
      deleted_events: [{ id: 102317301 }, { id: '102184251' }],
      events: []
    })

    expect(deleteSpy).toHaveBeenCalledWith(userId, ['102317301', '102184251'])

    deleteSpy.mockRestore()
  })

  it('does not refresh Intervals sport settings during calendar webhook import', async () => {
    const syncProfileSpy = vi.spyOn(IntervalsService, 'syncProfile').mockResolvedValue({} as any)
    vi.mocked(prisma.plannedWorkout.findMany).mockResolvedValue([])
    vi.mocked(prisma.plannedWorkout.upsert).mockResolvedValue({ id: 'pw-1' } as any)
    vi.mocked(normalizeIntervalsPlannedWorkout).mockReturnValue({
      externalId: '12345',
      title: 'Endurance',
      date: new Date('2026-07-13T08:00:00Z'),
      type: 'Ride',
      userId
    } as any)

    await IntervalsService.processWebhookEvent(userId, 'CALENDAR_UPDATED', {
      events: [
        {
          id: 12345,
          name: 'Endurance',
          type: 'Ride',
          category: 'WORKOUT',
          start_date_local: '2026-07-13T08:00:00'
        }
      ]
    })

    expect(syncProfileSpy).not.toHaveBeenCalled()
    syncProfileSpy.mockRestore()
  })
})

describe('IntervalsService syncActivities deduplication', () => {
  const userId = 'user-1'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchIntervalsWorkouts).mockResolvedValue([])
    vi.mocked(prisma.integration.findUnique).mockImplementation(async (args: any) => {
      if (args?.where?.userId_provider?.provider === 'intervals') {
        return {
          id: 'int-1',
          ingestWorkouts: true
        } as any
      }
      return null
    })
  })

  it('triggers deduplication after activity sync even when no new workouts were ingested', async () => {
    await IntervalsService.syncActivities(
      userId,
      new Date('2026-07-10T00:00:00Z'),
      new Date('2026-07-10T23:59:59Z')
    )

    expect(triggerWorkoutDeduplicationIfEnabled).toHaveBeenCalledTimes(1)
    expect(triggerWorkoutDeduplicationIfEnabled).toHaveBeenCalledWith(userId)
  })

  it('does not trigger deduplication when ingestWorkouts is disabled', async () => {
    vi.mocked(prisma.integration.findUnique).mockResolvedValue({
      id: 'int-1',
      ingestWorkouts: false
    } as any)

    await IntervalsService.syncActivities(
      userId,
      new Date('2026-07-10T00:00:00Z'),
      new Date('2026-07-10T23:59:59Z')
    )

    expect(triggerWorkoutDeduplicationIfEnabled).not.toHaveBeenCalled()
  })
})

describe('IntervalsService syncActivityStream activity-specific zones', () => {
  const userId = 'user-1'
  const workoutId = 'w-zone'
  const activityId = 'i-zone'

  const runHrZones = [
    { name: 'Z1', min: 0, max: 100 },
    { name: 'Z2', min: 101, max: 200 }
  ]
  const runPowerZones = [
    { name: 'Z1', min: 0, max: 150 },
    { name: 'Z2', min: 151, max: 500 }
  ]

  function mockStreamPersistence() {
    vi.mocked(workoutStreamRepository.upsert).mockResolvedValue({ id: 'ws-1' } as any)
    vi.mocked(workoutStreamRepository.findByWorkoutId).mockResolvedValue({ id: 'ws-1' } as any)
  }

  function mockStreams(heartrate: number[], watts: number[]) {
    vi.mocked(prisma.integration.findFirst).mockResolvedValue({ id: 'int-1' } as any)
    vi.mocked(fetchIntervalsActivityStreams).mockResolvedValue({
      time: { data: heartrate.map((_, i) => i) },
      heartrate: { data: heartrate },
      watts: { data: watts }
    } as any)
  }

  function mockStoredWorkoutType(type: string | null) {
    vi.mocked(prisma.workout.findUnique).mockImplementation(async (args: any) => {
      if (args?.select?.type) return { type } as any
      return {
        averageWatts: 200,
        maxWatts: 400,
        normalizedPower: 210,
        elevationGain: 0
      } as any
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockStreamPersistence()
  })

  it.each([true, false])(
    'uses the real resolver with a distinct default profile (specific=%s)',
    async (specific) => {
      mockStoredWorkoutType('Run')
      mockStreams([90, 150, 150], [100, 200, 200])
      const actual = await vi.importActual<
        typeof import('../../../../../server/utils/repositories/sportSettingsRepository')
      >('../../../../../server/utils/repositories/sportSettingsRepository')
      const defaultProfile = {
        isDefault: true,
        types: [],
        hrZones: [{ name: 'Default', min: 0, max: 500 }],
        powerZones: [{ name: 'Default', min: 0, max: 1000 }]
      }
      const profiles = [
        defaultProfile,
        ...(specific
          ? [
              {
                isDefault: false,
                types: ['Run'],
                ftp: 250,
                lthr: 170,
                hrZones: runHrZones,
                powerZones: runPowerZones
              }
            ]
          : [])
      ]
      const resolver = {
        ...actual.sportSettingsRepository,
        getByUserId: vi.fn().mockResolvedValue(profiles)
      }
      vi.mocked(sportSettingsRepository.getForActivityType).mockImplementation((user, type) =>
        resolver.getForActivityType(user, type)
      )
      vi.mocked(sportSettingsRepository.getDefault).mockResolvedValue(defaultProfile as any)
      await IntervalsService.syncActivityStream(userId, workoutId, activityId)
      expect(resolver.getByUserId).toHaveBeenCalledWith(userId, undefined)
      const payload = vi.mocked(workoutStreamRepository.upsert).mock.calls[0]?.[1] as any
      expect(payload.hrZoneTimes).toEqual(specific ? [1, 2] : [3])
      expect(payload.powerZoneTimes).toEqual(specific ? [1, 2] : [3])
    }
  )

  it.each(['both', 'hr', 'power'])(
    'uses built-in defaults for empty user arrays (%s)',
    async (empty) => {
      mockStoredWorkoutType('Run')
      mockStreams([130, 150], [100, 200])
      vi.mocked(sportSettingsRepository.getForActivityType).mockResolvedValue({
        hrZones: empty === 'power' ? runHrZones : [],
        powerZones: empty === 'hr' ? runPowerZones : []
      } as any)
      vi.mocked(prisma.user.findUnique).mockResolvedValue({ hrZones: [], powerZones: [] } as any)
      await IntervalsService.syncActivityStream(userId, workoutId, activityId)
      const payload = vi.mocked(workoutStreamRepository.upsert).mock.calls[0]?.[1] as any
      expect(payload.hrZoneTimes).toEqual(empty === 'power' ? [0, 2] : [0, 1, 1, 0, 0])
      expect(payload.powerZoneTimes).toEqual(empty === 'hr' ? [1, 1] : [1, 0, 1, 0, 0])
    }
  )

  it('uses activity-specific running zones instead of default zones', async () => {
    mockStoredWorkoutType('Run')
    mockStreams([90, 150, 150], [100, 200, 200])
    vi.mocked(sportSettingsRepository.getForActivityType).mockResolvedValue({
      hrZones: runHrZones,
      powerZones: runPowerZones
    } as any)

    await IntervalsService.syncActivityStream(userId, workoutId, activityId)

    expect(sportSettingsRepository.getForActivityType).toHaveBeenCalledWith(userId, 'Run')
    expect(workoutStreamRepository.upsert).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(workoutStreamRepository.upsert).mock.calls[0]?.[1] as any
    expect(payload.hrZoneTimes).toEqual([1, 2])
    expect(payload.powerZoneTimes).toEqual([1, 2])
  })

  it('falls back to user-level then built-in zones when no sport profile exists', async () => {
    mockStoredWorkoutType('Run')
    mockStreams([90, 150, 250], [100, 200])
    vi.mocked(sportSettingsRepository.getForActivityType).mockResolvedValue(null as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      hrZones: [
        { name: 'Z1', min: 0, max: 100 },
        { name: 'Z2', min: 101, max: 200 },
        { name: 'Z3', min: 201, max: 300 }
      ],
      powerZones: [
        { name: 'Z1', min: 0, max: 150 },
        { name: 'Z2', min: 151, max: 500 }
      ]
    } as any)

    await IntervalsService.syncActivityStream(userId, workoutId, activityId)

    const payload = vi.mocked(workoutStreamRepository.upsert).mock.calls[0]?.[1] as any
    expect(payload.hrZoneTimes).toEqual([1, 1, 1])
    expect(payload.powerZoneTimes).toEqual([1, 1])
  })

  it('falls back per-zone-array when the profile zones are missing or empty', async () => {
    mockStoredWorkoutType('Run')
    mockStreams([50, 150], [100, 200, 200])
    vi.mocked(sportSettingsRepository.getForActivityType).mockResolvedValue({
      hrZones: [],
      powerZones: runPowerZones
    } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      hrZones: [
        { name: 'Z1', min: 0, max: 100 },
        { name: 'Z2', min: 101, max: 500 }
      ],
      powerZones: []
    } as any)

    await IntervalsService.syncActivityStream(userId, workoutId, activityId)

    const payload = vi.mocked(workoutStreamRepository.upsert).mock.calls[0]?.[1] as any
    // Empty profile HR zones fall back to the user-level HR zones.
    expect(payload.hrZoneTimes).toEqual([1, 1])
    // Non-empty profile power zones are preserved (profile wins over empty user zones).
    expect(payload.powerZoneTimes).toEqual([1, 2])
  })

  it('falls back to built-in zones when profile and user zones are both missing', async () => {
    mockStoredWorkoutType('Run')
    mockStreams([130, 150], [100])
    vi.mocked(sportSettingsRepository.getForActivityType).mockResolvedValue(null as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as any)

    await IntervalsService.syncActivityStream(userId, workoutId, activityId)

    const payload = vi.mocked(workoutStreamRepository.upsert).mock.calls[0]?.[1] as any
    expect(payload.hrZoneTimes).toHaveLength(DEFAULT_HR_ZONES.length)
    expect(payload.powerZoneTimes).toHaveLength(DEFAULT_POWER_ZONES.length)
    // 130/150 land in DEFAULT Z2 (121-145 is Z2; 146-160 is Z3).
    expect(payload.hrZoneTimes).toEqual([0, 1, 1, 0, 0])
    expect(payload.powerZoneTimes).toEqual([1, 0, 0, 0, 0])
  })
})
