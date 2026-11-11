import { describe, expect, it, vi } from 'vitest'
import {
  buildWorkoutReceivedActivityFingerprint,
  buildInterestingCopy,
  evaluateWorkoutReceivedEligibility,
  normalizeSubjectSpacing,
  formatEmailDistance
} from '../../../../server/utils/workout-insight-email'

describe('workout insight email subject formatting', () => {
  it('adds missing spacing after punctuation around interpolated values', () => {
    const subject = 'Great shift, Anderd93.66.7 km in the books.'
    expect(normalizeSubjectSpacing(subject)).toBe('Great shift, Anderd93. 66.7 km in the books.')
  })

  it('preserves numeric punctuation for distances and thousands', () => {
    const subject = 'Great shift, Alex. 66.7 km logged with 1,000 kJ.'
    expect(normalizeSubjectSpacing(subject)).toBe(
      'Great shift, Alex. 66.7 km logged with 1,000 kJ.'
    )
  })
})

describe('workout received copy variant rotation', () => {
  it('avoids recently used variant ids per slot when alternatives exist', () => {
    const recentVariantIds = {
      heroTitle: new Set(['hero_distance_1']),
      introLine: new Set(['intro_2']),
      ctaLabel: new Set(['cta_3']),
      nextStepMessage: new Set(['next_1']),
      subject: new Set(['subject_distance_2'])
    }

    const copy = buildInterestingCopy({
      workoutId: 'workout-1',
      sportCategory: 'run',
      workoutTitle: 'Morning Run',
      firstName: 'Alex',
      distanceLabel: '10.0 km',
      recentVariantIds
    })

    expect(copy.copyVariantIds.heroTitle).not.toBe('hero_distance_1')
    expect(copy.copyVariantIds.introLine).not.toBe('intro_2')
    expect(copy.copyVariantIds.ctaLabel).not.toBe('cta_3')
    expect(copy.copyVariantIds.nextStepMessage).not.toBe('next_1')
    expect(copy.copyVariantIds.subject).not.toBe('subject_distance_2')
  })

  it('falls back to full pool when all variants for a slot were recently used', () => {
    const recentVariantIds = {
      heroTitle: new Set(['hero_distance_1', 'hero_distance_2', 'hero_distance_3']),
      introLine: new Set<string>(),
      ctaLabel: new Set<string>(),
      nextStepMessage: new Set<string>(),
      subject: new Set<string>()
    }

    const copy = buildInterestingCopy({
      workoutId: 'workout-2',
      sportCategory: 'run',
      workoutTitle: 'Evening Run',
      firstName: 'Taylor',
      distanceLabel: '6.0 km',
      recentVariantIds
    })

    expect(['hero_distance_1', 'hero_distance_2', 'hero_distance_3']).toContain(
      copy.copyVariantIds.heroTitle
    )
  })
})

describe('workout received dedupe fingerprint', () => {
  it('produces the same fingerprint for equivalent activities across sources', () => {
    const first = buildWorkoutReceivedActivityFingerprint({
      userId: 'user-1',
      workoutType: 'Run',
      workoutDate: new Date('2026-02-27T10:02:30.000Z'),
      durationSec: 1825,
      distanceKm: 10.04
    })
    const second = buildWorkoutReceivedActivityFingerprint({
      userId: 'user-1',
      workoutType: 'run',
      workoutDate: new Date('2026-02-27T10:04:59.000Z'),
      durationSec: 1799,
      distanceKm: 10.0
    })

    expect(first).toBe(second)
  })
})

describe('workout received email distance formatting', () => {
  it('formats distance in kilometers when the athlete prefers Kilometers', () => {
    expect(formatEmailDistance(10040, 'Kilometers')).toEqual({
      value: 10,
      unitLabel: 'km',
      label: '10.0 km'
    })
  })

  it('formats distance in kilometers when distanceUnits is not provided', () => {
    expect(formatEmailDistance(10040)).toEqual({
      value: 10,
      unitLabel: 'km',
      label: '10.0 km'
    })
  })

  it('formats distance in miles when the athlete prefers Miles', () => {
    expect(formatEmailDistance(10040, 'Miles')).toEqual({
      value: 6.2,
      unitLabel: 'mi',
      label: '6.2 mi'
    })
  })

  it('returns null when there is no distance to display', () => {
    expect(formatEmailDistance(undefined, 'Miles')).toBeNull()
    expect(formatEmailDistance(0, 'Kilometers')).toBeNull()
  })
})

describe('workout received eligibility rules', () => {
  it('skips workouts shorter than 10 minutes', () => {
    const result = evaluateWorkoutReceivedEligibility({
      durationSec: 599,
      workoutDate: new Date('2026-02-27T09:55:00.000Z'),
      now: new Date('2026-02-27T10:00:00.000Z')
    })

    expect(result).toEqual({ eligible: false, reason: 'duration_below_10_minutes' })
  })

  it('skips workouts older than 24 hours', () => {
    const result = evaluateWorkoutReceivedEligibility({
      durationSec: 1200,
      workoutDate: new Date('2026-02-26T09:59:59.000Z'),
      now: new Date('2026-02-27T10:00:00.000Z')
    })

    expect(result).toEqual({ eligible: false, reason: 'workout_older_than_24_hours' })
  })

  it('allows workouts that pass duration and recency checks', () => {
    const result = evaluateWorkoutReceivedEligibility({
      durationSec: 600,
      workoutDate: new Date('2026-02-27T09:59:59.000Z'),
      now: new Date('2026-02-27T10:00:00.000Z')
    })

    expect(result).toEqual({ eligible: true })
  })
})

vi.mock('../../../../server/utils/db', () => ({
  prisma: {
    workout: {
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([])
    },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user', timezone: 'UTC' }) },
    emailPreference: { findUnique: vi.fn() },
    emailDelivery: { findMany: vi.fn().mockResolvedValue([]) },
    workoutStreamV2: { findMany: vi.fn() },
    workoutStream: { findMany: vi.fn() }
  }
}))
vi.mock('../../../../server/utils/repositories/sportSettingsRepository', () => ({
  sportSettingsRepository: { getForActivityType: vi.fn() }
}))
vi.mock('../../../../server/utils/workout-email-stream-insights', () => ({
  buildWorkoutStreamInsights: vi.fn(() => {
    throw new Error('chart projection reached')
  })
}))

describe('email chart stream projection', () => {
  it.each(['v2', 'v1', 'absent'])('passes %s streams to chart builder', async (storage) => {
    const { prisma } = await import('../../../../server/utils/db')
    const { queueWorkoutInsightEmail } =
      await import('../../../../server/utils/workout-insight-email')
    const { buildWorkoutStreamInsights } =
      await import('../../../../server/utils/workout-email-stream-insights')
    vi.mocked(prisma.workout.findUnique).mockResolvedValue({
      id: 'ride',
      userId: 'user',
      type: 'Ride',
      date: new Date(),
      durationSec: 3600
    } as any)
    const series = {
      time: [0, 1],
      watts: [200, 210],
      heartrate: [140, 141],
      cadence: [80, 81],
      distance: [0, 10],
      grade: [1, 2],
      moving: [true, true],
      surges: []
    }
    const rows = [{ id: 'stream', workoutId: 'ride', ...series }]
    vi.mocked(prisma.workoutStreamV2.findMany).mockResolvedValue(
      storage === 'v2' ? (rows as any) : []
    )
    vi.mocked(prisma.workoutStream.findMany).mockResolvedValue(
      storage === 'v1' ? (rows as any) : []
    )
    await expect(
      queueWorkoutInsightEmail({ workoutId: 'ride', triggerType: 'on-analysis-ready' })
    ).rejects.toThrow('chart projection reached')
    expect(buildWorkoutStreamInsights).toHaveBeenLastCalledWith(
      expect.objectContaining({
        streams: storage === 'absent' ? undefined : series
      })
    )
    expect(prisma.workoutStreamV2.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          time: true,
          watts: true,
          heartrate: true,
          cadence: true,
          distance: true,
          grade: true,
          moving: true,
          surges: true
        })
      })
    )
  })
})
