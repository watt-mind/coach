import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireAuth } from '../../../../../server/utils/auth-guard'
import { prisma } from '../../../../../server/utils/db'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', () => {})
vi.stubGlobal('createError', (options: any) =>
  Object.assign(new Error(options.statusMessage || options.message), options)
)
vi.mock('../../../../../server/utils/auth-guard', () => ({ requireAuth: vi.fn() }))
vi.mock('../../../../../server/utils/db', () => {
  const writes = () => ({ delete: vi.fn(), deleteMany: vi.fn(), update: vi.fn() })
  return {
    prisma: {
      goal: { findUnique: vi.fn(), ...writes() },
      trainingPlan: writes(),
      trainingBlock: writes(),
      trainingWeek: writes(),
      plannedWorkout: writes()
    }
  }
})

const getHandler = async () => (await import('../../../../../server/api/goals/[id].delete')).default
const event = { context: { params: { id: 'goal-1' } } } as any
const draft = { status: 'DRAFT', isTemplate: false }
const active = { status: 'ACTIVE', isTemplate: false }
const ownedGoal = { id: 'goal-1', userId: 'user-1', trainingPlans: [] }

function expectNoWrites() {
  for (const model of [
    prisma.goal,
    prisma.trainingPlan,
    prisma.trainingBlock,
    prisma.trainingWeek,
    prisma.plannedWorkout
  ]) {
    expect(model.delete).not.toHaveBeenCalled()
    expect(model.deleteMany).not.toHaveBeenCalled()
    expect(model.update).not.toHaveBeenCalled()
  }
}

describe('DELETE /api/goals/:id plan protection', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as any)
    vi.mocked(prisma.goal.findUnique).mockResolvedValue(ownedGoal as any)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it.each(['ACTIVE', 'COMPLETED', 'ABANDONED', 'ARCHIVED', 'PAUSED', 'FUTURE_STATUS'])(
    'rejects a non-template %s plan without writes',
    async (status) => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValue({
        ...ownedGoal,
        trainingPlans: [{ status, isTemplate: false }]
      } as any)
      const handler = await getHandler()
      await expect(handler(event)).rejects.toMatchObject({
        statusCode: 400,
        statusMessage: expect.stringContaining('abandoned or archived')
      })
      expectNoWrites()
    }
  )

  it('checks every linked plan, including a protected plan after eligible plans', async () => {
    vi.mocked(prisma.goal.findUnique).mockResolvedValue({
      ...ownedGoal,
      trainingPlans: [draft, { ...active, isTemplate: true }, active]
    } as any)
    await expect((await getHandler())(event)).rejects.toMatchObject({ statusCode: 400 })
    expectNoWrites()
  })

  it.each([
    { plans: [] },
    { plans: [draft] },
    { plans: [{ ...active, isTemplate: true }] },
    { plans: [draft, { status: 'COMPLETED', isTemplate: true }] }
  ])('allows eligible linked plans %j', async ({ plans }) => {
    vi.mocked(prisma.goal.findUnique).mockResolvedValue({
      ...ownedGoal,
      trainingPlans: plans
    } as any)
    await expect((await getHandler())(event)).resolves.toEqual({ success: true })
    expect(prisma.goal.delete).toHaveBeenCalledExactlyOnceWith({ where: { id: 'goal-1' } })
  })

  it('requires authentication and goal:write before reading data', async () => {
    vi.mocked(requireAuth).mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    )
    await expect((await getHandler())(event)).rejects.toMatchObject({ statusCode: 401 })
    expect(requireAuth).toHaveBeenCalledWith(event, ['goal:write'])
    expect(prisma.goal.findUnique).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it.each([null, { ...ownedGoal, userId: 'foreign-user', trainingPlans: [active] }])(
    'preserves nondisclosure and legacy ownership error translation for %j',
    async (goal) => {
      vi.mocked(prisma.goal.findUnique).mockResolvedValue(goal as any)
      await expect((await getHandler())(event)).rejects.toMatchObject({
        statusCode: 500,
        statusMessage: 'Failed to delete goal'
      })
      expectNoWrites()
    }
  )

  it('rejects a missing goal ID without reading or writing data', async () => {
    await expect((await getHandler())({ context: {} } as any)).rejects.toMatchObject({
      statusCode: 400
    })
    expect(prisma.goal.findUnique).not.toHaveBeenCalled()
    expectNoWrites()
  })

  it('keeps unexpected database errors generic', async () => {
    vi.mocked(prisma.goal.delete).mockRejectedValue(new Error('database detail'))
    await expect((await getHandler())(event)).rejects.toMatchObject({
      statusCode: 500,
      statusMessage: 'Failed to delete goal'
    })
  })
})
