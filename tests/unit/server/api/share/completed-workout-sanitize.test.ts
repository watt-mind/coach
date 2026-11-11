import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  workout: vi.fn(),
  attach: vi.fn(),
  routerParam: vi.fn()
}))
vi.mock('../../../../../server/utils/repositories/workoutStreamRepository', () => ({
  attachStreamToWorkout: mocks.attach
}))
vi.stubGlobal('defineRouteMeta', vi.fn())
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('getRouterParam', mocks.routerParam)
vi.stubGlobal('createError', (error: object) => Object.assign(new Error(), error))
vi.stubGlobal('prisma', {
  shareToken: { findUnique: mocks.token },
  workout: { findUnique: mocks.workout }
})

const publicPlan = { id: 'plan-1', title: 'Easy Run', type: 'Run', durationSec: 3600 }
const privatePlan = {
  ...publicPlan,
  userId: 'owner',
  externalId: 'provider-id',
  rawJson: { secret: true },
  syncStatus: 'ERROR',
  syncError: 'private error',
  structureHash: 'internal-hash',
  pendingRemoteStructuredWorkout: { steps: [] },
  createdFromSettingsSnapshot: { ftp: 250 },
  lastGenerationContext: { prompt: 'private' },
  futurePrivateField: 'must stay private'
}
const record = {
  id: 'completed-1',
  title: 'Morning Run',
  userId: 'owner',
  externalId: 'completed-provider-id',
  plannedWorkout: privatePlan,
  planAdherence: { score: 95 },
  user: { name: 'Runner', image: null }
}
const getHandler = async () =>
  (await import('../../../../../server/api/share/workouts/[token].get')).default

// No session/authentication is supplied: this is the public token handler.
describe('public completed workout response (CW-822)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.routerParam.mockReturnValue('valid-token')
    mocks.token.mockResolvedValue({
      resourceType: 'WORKOUT',
      resourceId: record.id,
      expiresAt: null
    })
    mocks.workout.mockResolvedValue(record)
    mocks.attach.mockImplementation(async (workout) => ({ ...workout, streams: { watts: [100] } }))
  })

  it('allowlists the linked plan while preserving adherence, streams and top-level stripping', async () => {
    const result = await (await getHandler())({} as any)
    expect(result.plannedWorkout).toEqual(publicPlan)
    expect(result).not.toHaveProperty('userId')
    expect(result).not.toHaveProperty('externalId')
    expect(result.planAdherence).toEqual(record.planAdherence)
    expect(result.streams).toEqual({ watts: [100] })
    expect(result.user).toEqual(record.user)
    expect(mocks.token).toHaveBeenCalledWith({ where: { token: 'valid-token' } })
    expect(mocks.attach).toHaveBeenCalledWith(record)
  })

  it('preserves a null linked plan', async () => {
    mocks.workout.mockResolvedValue({ ...record, plannedWorkout: null })
    expect((await (await getHandler())({} as any)).plannedWorkout).toBeNull()
  })

  it('rejects a missing token before persistence access', async () => {
    mocks.routerParam.mockReturnValue(undefined)
    await expect((await getHandler())({} as any)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Share token is required'
    })
    expect(mocks.token).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid', null, 'Workout not found or link is invalid'],
    ['wrong resource', { resourceType: 'TRAINING_PLAN' }, 'Workout not found or link is invalid'],
    ['expired', { resourceType: 'WORKOUT', expiresAt: new Date(0) }, 'Share link has expired']
  ])('rejects %s tokens before workout access', async (_, token, message) => {
    mocks.token.mockResolvedValue(token)
    await expect((await getHandler())({} as any)).rejects.toMatchObject({
      statusCode: 404,
      message
    })
    expect(mocks.workout).not.toHaveBeenCalled()
    expect(mocks.attach).not.toHaveBeenCalled()
  })

  it('rejects a missing completed workout', async () => {
    mocks.workout.mockResolvedValue(null)
    await expect((await getHandler())({} as any)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Workout not found or link is invalid'
    })
    expect(mocks.attach).not.toHaveBeenCalled()
  })
})
