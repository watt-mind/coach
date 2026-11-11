import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getServerSession } from '../../../../../../server/utils/session'
import { prisma } from '../../../../../../server/utils/db'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('getRouterParam', (event: any) => event.params.id)
vi.stubGlobal('readValidatedBody', async (event: any, parse: any) => parse(event.body))
vi.stubGlobal('createError', (err: any) => Object.assign(new Error(err.message), err))
vi.mock('../../../../../../server/utils/session', () => ({ getServerSession: vi.fn() }))
vi.mock('../../../../../../server/utils/db', () => ({
  prisma: {
    trainingPlan: { findFirst: vi.fn(), update: vi.fn() },
    teamMember: { findFirst: vi.fn() },
    trainingPlanPublicSampleWeek: { deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn()
  }
}))
const handler = async (body: any) => {
  const { default: run } =
    await import('../../../../../../server/api/library/plans/[id]/publication.patch')
  return run({ params: { id: 'plan' }, body } as any)
}
const metadata = {
  slug: 'base-plan',
  publicDescription: 'A useful plan',
  primarySport: 'Ride',
  skillLevel: 'BEGINNER',
  accessState: 'FREE'
}
let plan: any
function noWrites() {
  expect(prisma.$transaction).not.toHaveBeenCalled()
  expect(prisma.trainingPlan.update).not.toHaveBeenCalled()
  expect(prisma.trainingPlanPublicSampleWeek.deleteMany).not.toHaveBeenCalled()
  expect(prisma.trainingPlanPublicSampleWeek.createMany).not.toHaveBeenCalled()
}
describe('plan publication team authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    plan = {
      id: 'plan',
      name: 'Base',
      userId: 'owner',
      visibility: 'PRIVATE',
      teamId: null,
      ...metadata,
      blocks: [{ weeks: [{ id: 'week' }] }]
    }
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'owner' } } as any)
    vi.mocked(prisma.trainingPlan.findFirst).mockImplementation(async () => plan)
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))
    vi.mocked(prisma.trainingPlan.update).mockResolvedValue(plan)
  })
  it.each(['missing', 'INACTIVE', 'different-team', 'unknown-team'])(
    'rejects %s membership before writes',
    async (membership) => {
      // Simulate the filtered database query, including memberships in other teams.
      vi.mocked(prisma.teamMember.findFirst).mockImplementation(async ({ where }: any) => {
        const member =
          membership === 'missing' || membership === 'unknown-team'
            ? null
            : {
                userId: 'owner',
                teamId: membership === 'different-team' ? 'other' : 'target',
                status: membership === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
              }
        return member &&
          Object.entries(where).every(([key, value]) => (member as any)[key] === value)
          ? (member as any)
          : null
      })
      await expect(
        handler({ ...metadata, visibility: 'TEAM', teamId: 'target', sampleWeekIds: ['week'] })
      ).rejects.toMatchObject({ statusCode: 403 })
      noWrites()
    }
  )
  it.each([undefined, null, '', '   '])('rejects empty effective target %s', async (teamId) => {
    await expect(handler({ visibility: 'TEAM', teamId })).rejects.toMatchObject({ statusCode: 400 })
    noWrites()
  })
  it.each([{ visibility: 'TEAM' }, { teamId: 'target' }, {}, { teamId: null }])(
    'validates partial TEAM patches %j',
    async (body) => {
      plan.visibility = body.visibility ? 'PRIVATE' : 'TEAM'
      plan.teamId = 'target'
      await expect(handler(body)).rejects.toMatchObject({
        statusCode: body.teamId === null ? 400 : 403
      })
      noWrites()
    }
  )
  it('allows ACTIVE owner membership without a staff role and preserves sample week filtering', async () => {
    vi.mocked(prisma.teamMember.findFirst).mockResolvedValue({ role: 'ATHLETE' } as any)
    const result = await handler({
      ...metadata,
      visibility: 'TEAM',
      teamId: 'target',
      sampleWeekIds: ['week', 'foreign']
    })
    expect(prisma.teamMember.findFirst).toHaveBeenCalledWith({
      where: { userId: 'owner', teamId: 'target', status: 'ACTIVE' }
    })
    expect(result.sampleWeekIds).toEqual(['week'])
    expect(prisma.trainingPlanPublicSampleWeek.createMany).toHaveBeenCalledWith({
      data: [{ planId: 'plan', weekId: 'week' }]
    })
  })
  it.each(['PRIVATE', 'PUBLIC'])('preserves %s publication', async (visibility) => {
    await expect(handler({ ...metadata, visibility })).resolves.toMatchObject({ success: true })
    expect(prisma.teamMember.findFirst).not.toHaveBeenCalled()
    expect(prisma.trainingPlanPublicSampleWeek.deleteMany).toHaveBeenCalled()
  })
  it('preserves required metadata validation', async () => {
    await expect(handler({ visibility: 'PUBLIC', publicDescription: '' })).rejects.toMatchObject({
      statusCode: 400
    })
    noWrites()
  })
  it('denies nonowners', async () => {
    plan = null
    await expect(handler({ visibility: 'TEAM', teamId: 'target' })).rejects.toMatchObject({
      statusCode: 404
    })
    expect(prisma.trainingPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plan', userId: 'owner' } })
    )
    noWrites()
  })
  it('denies unauthenticated callers', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null)
    await expect(handler({})).rejects.toMatchObject({ statusCode: 401 })
    noWrites()
  })
})
