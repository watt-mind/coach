import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../trigger/init', () => ({}))

vi.mock('../../../trigger/queues', () => ({
  userReportsQueue: { name: 'user-reports' }
}))

const { userFindUnique, trendFindMany, workoutFindMany } = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  trendFindMany: vi.fn(),
  workoutFindMany: vi.fn()
}))

vi.mock('../../../server/utils/db', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    scoreTrendExplanation: { findMany: trendFindMany },
    workout: { findMany: workoutFindMany }
  }
}))

const { generateStructuredAnalysis, buildWorkoutSummary } = vi.hoisted(() => ({
  generateStructuredAnalysis: vi.fn(),
  buildWorkoutSummary: vi.fn()
}))

vi.mock('../../../server/utils/gemini', () => ({
  generateStructuredAnalysis,
  buildWorkoutSummary
}))

vi.mock('../../../server/utils/date', () => ({
  getUserTimezone: vi.fn().mockResolvedValue('UTC'),
  getStartOfDaysAgoUTC: vi.fn().mockReturnValue(new Date('2026-08-01T00:00:00.000Z'))
}))

vi.mock('../../../server/utils/services/checkin-service', () => ({
  getCheckinHistoryContext: vi.fn().mockResolvedValue(null)
}))

const { getActive, createMany, update, updateMany } = vi.hoisted(() => ({
  getActive: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn()
}))

vi.mock('../../../server/utils/repositories/recommendationRepository', () => ({
  recommendationRepository: { getActive, createMany, update, updateMany }
}))

vi.mock('../../../server/utils/repositories/nutritionRepository', () => ({
  nutritionRepository: { getForUser: vi.fn().mockResolvedValue([]) }
}))

vi.mock('../../../server/utils/ai-user-settings', () => ({
  getUserAiSettings: vi.fn().mockResolvedValue({
    aiModelPreference: 'gemini-2.5-flash',
    aiPersona: 'Supportive'
  })
}))

vi.mock('../../../server/utils/goal-context', () => ({
  filterGoalsForContext: vi.fn().mockReturnValue([])
}))

vi.mock('../../../server/utils/quotas/engine', () => ({
  checkQuota: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../../../server/utils/task-registry', () => ({
  registerTaskHandler: vi.fn()
}))

vi.mock('@trigger.dev/sdk/v3', async () => {
  const actual = await vi.importActual('@trigger.dev/sdk/v3')
  return {
    ...actual,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    task: vi.fn().mockImplementation((config) => ({ run: config.run, id: config.id }))
  }
})

const USER_ID = 'user-1'
const REC_ID = 'rec-1'

/**
 * Builds the single active recommendation the AI response asks to update,
 * with the given (possibly malformed) `history` Json column value.
 */
function activeRecommendation(history: unknown) {
  return {
    id: REC_ID,
    userId: USER_ID,
    title: 'Old title',
    description: 'Old description',
    priority: 'medium',
    category: 'Cycling',
    metric: 'ftp',
    sourceType: 'workout',
    period: 7,
    status: 'ACTIVE',
    isPinned: false,
    generatedAt: new Date('2026-08-10T00:00:00.000Z'),
    history
  }
}

/**
 * Runs the task with a single `updated_recommendations` entry against an
 * existing recommendation holding `history`, and returns the `history` value
 * the repository was asked to persist.
 */
async function runUpdateWithHistory(history: unknown) {
  userFindUnique.mockResolvedValue({
    name: 'Athlete',
    language: 'English',
    distanceUnits: 'km',
    goals: []
  })
  trendFindMany.mockResolvedValue([])
  workoutFindMany.mockResolvedValue([])
  buildWorkoutSummary.mockReturnValue('None')
  getActive.mockResolvedValue([activeRecommendation(history)])

  generateStructuredAnalysis.mockResolvedValue({
    // No new recommendations keeps the deduplication sweep (a second LLM call)
    // out of this test — we only care about the update path.
    new_recommendations: [],
    updated_recommendations: [
      {
        id: REC_ID,
        new_title: 'New title',
        new_description: 'New description',
        new_priority: 'high',
        reason_for_update: 'Data changed'
      }
    ],
    completed_recommendation_ids: [],
    dismissed_recommendation_ids: []
  })

  const { runGenerateRecommendations } = await import('../../../trigger/generate-recommendations')

  const result = await runGenerateRecommendations({ userId: USER_ID })

  expect(result).toMatchObject({ success: true, updated: 1 })
  expect(update).toHaveBeenCalledTimes(1)

  const [id, userId, data] = update.mock.calls[0]!
  expect(id).toBe(REC_ID)
  expect(userId).toBe(USER_ID)
  return data
}

const APPENDED_ENTRY = {
  title: 'Old title',
  description: 'Old description',
  reason: 'Data changed'
}

describe('runGenerateRecommendations — history column handling (CW-369)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('starts a fresh history when the stored value is null', async () => {
    const history = (await runUpdateWithHistory(null)).history

    expect(Array.isArray(history)).toBe(true)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject(APPENDED_ENTRY)
  })

  it('appends to an existing array history without disturbing earlier entries', async () => {
    const previous = {
      date: '2026-08-01T00:00:00.000Z',
      title: 'Older title',
      description: 'Older description',
      reason: 'Previous update'
    }

    const history = (await runUpdateWithHistory([previous])).history

    expect(Array.isArray(history)).toBe(true)
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual(previous)
    expect(history[1]).toMatchObject(APPENDED_ENTRY)
  })

  // CW-369 review finding: a non-array `history` is NOT corruption. It is a
  // second schema written by `thresholdDetectionService` for ACTIVE
  // `sourceType: 'workout'` recommendations:
  //   { oldValue, newValue, workoutId, sportName, workoutDate }
  // `athleteMetricsService` reads `Number(history?.newValue)` from it to promote
  // a detected FTP/LTHR/MAX_HR/THRESHOLD_PACE into the athlete's profile.
  // Overwriting it with our array yields NaN, so the value is silently never
  // promoted while the recommendation is still marked COMPLETED. So the
  // requirement is to LEAVE IT ALONE, not to replace it with a fresh array.
  const THRESHOLD_HISTORY = {
    oldValue: 250,
    newValue: 268,
    workoutId: 'workout-1',
    sportName: 'Ride',
    workoutDate: '2026-08-01T00:00:00.000Z'
  }

  it('never writes history when the stored value is a threshold-detection object', async () => {
    const data = await runUpdateWithHistory(THRESHOLD_HISTORY)

    // The key must be absent entirely — writing `undefined` or `[]` would both
    // destroy the threshold payload just as surely as writing our array.
    expect(Object.hasOwn(data, 'history')).toBe(false)
    // The rest of the update still applies.
    expect(data.title).toBeDefined()
    expect(data.priority).toBeDefined()
  })

  it('never writes history when the stored value is an empty object', async () => {
    const data = await runUpdateWithHistory({})

    expect(Object.hasOwn(data, 'history')).toBe(false)
  })

  it('never writes history when the stored value is a JSON string', async () => {
    // Strings are iterable, so the original spread silently exploded the string
    // into one history entry per character rather than throwing.
    const data = await runUpdateWithHistory('[{"reason":"legacy"}]')

    expect(Object.hasOwn(data, 'history')).toBe(false)
  })

  it('never writes history when the stored value is a number', async () => {
    const data = await runUpdateWithHistory(42)

    expect(Object.hasOwn(data, 'history')).toBe(false)
  })
})
