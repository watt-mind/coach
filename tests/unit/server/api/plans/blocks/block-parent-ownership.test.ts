import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireAuth } from '../../../../../../server/utils/auth-guard'
import { prisma } from '../../../../../../server/utils/db'
import { shiftPlanDates } from '../../../../../../server/utils/plan-logic'
import { trainingBlockRepository } from '../../../../../../server/utils/repositories/trainingBlockRepository'
import { trainingWeekRepository } from '../../../../../../server/utils/repositories/trainingWeekRepository'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('getRouterParam', (event: any, name: string) => event.params?.[name])
vi.stubGlobal('readBody', async (event: any) => event.body)
vi.stubGlobal('createError', (err: any) => Object.assign(new Error(err.message), err))
vi.mock('../../../../../../server/utils/auth-guard', () => ({ requireAuth: vi.fn() }))
vi.mock('../../../../../../server/utils/db', () => ({
  prisma: { $transaction: vi.fn(), plannedWorkout: { deleteMany: vi.fn() } }
}))
vi.mock('../../../../../../server/utils/plan-logic', () => ({ shiftPlanDates: vi.fn() }))
vi.mock('../../../../../../server/utils/repositories/trainingBlockRepository', () => ({
  trainingBlockRepository: {
    getById: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('../../../../../../server/utils/repositories/trainingWeekRepository', () => ({
  trainingWeekRepository: { create: vi.fn(), deleteMany: vi.fn() }
}))

const handlers = {
  DELETE: async () =>
    (await import('../../../../../../server/api/plans/[id]/blocks/[blockId].delete')).default,
  PATCH: async () =>
    (await import('../../../../../../server/api/plans/[id]/blocks/[blockId].patch')).default
}
const ownedBlock = () => ({
  id: 'block-a',
  trainingPlanId: 'plan-a',
  plan: { userId: 'user-a' },
  durationWeeks: 2,
  order: 1,
  type: 'BASE',
  weeks: [
    { id: 'week-1', weekNumber: 1 },
    { id: 'week-2', weekNumber: 2 }
  ]
})
const request = (planId = 'plan-a', body = { durationWeeks: 1 }) =>
  ({ params: { id: planId, blockId: 'block-a' }, body }) as any

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ id: 'user-a' } as any)
  vi.mocked(trainingBlockRepository.getById).mockResolvedValue(ownedBlock() as any)
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma))
})

for (const verb of ['DELETE', 'PATCH'] as const) {
  describe(verb + ' block parent ownership', () => {
    for (const plan of [
      { id: 'plan-b', owner: 'user-b' },
      { id: 'other-plan-a', owner: 'user-a' }
    ]) {
      it(
        'rejects a mismatched route plan owned by ' + plan.owner + ' before all writes',
        async () => {
          const handler = await handlers[verb]()
          await expect(handler(request(plan.id))).rejects.toMatchObject({
            statusCode: 404,
            message: 'Block not found'
          })
          expect(prisma.$transaction).not.toHaveBeenCalled()
          expect(shiftPlanDates).not.toHaveBeenCalled()
          expect(prisma.plannedWorkout.deleteMany).not.toHaveBeenCalled()
          expect(trainingBlockRepository.delete).not.toHaveBeenCalled()
          expect(trainingBlockRepository.updateMany).not.toHaveBeenCalled()
          expect(trainingBlockRepository.update).not.toHaveBeenCalled()
          expect(trainingWeekRepository.create).not.toHaveBeenCalled()
          expect(trainingWeekRepository.deleteMany).not.toHaveBeenCalled()
        }
      )
    }

    for (const block of [null, { ...ownedBlock(), plan: { userId: 'user-b' } }]) {
      it('retains 404 for ' + (block ? 'foreign-owned' : 'missing') + ' blocks', async () => {
        vi.mocked(trainingBlockRepository.getById).mockResolvedValue(block as any)
        const handler = await handlers[verb]()
        await expect(handler(request())).rejects.toMatchObject({
          statusCode: 404,
          message: 'Block not found'
        })
        expect(prisma.$transaction).not.toHaveBeenCalled()
        expect(shiftPlanDates).not.toHaveBeenCalled()
      })
    }
  })
}

it('rejects metadata-only PATCH with a mismatched parent', async () => {
  const handler = await handlers.PATCH()
  await expect(handler(request('other-plan-a', { name: 'Renamed' } as any))).rejects.toMatchObject({
    statusCode: 404,
    message: 'Block not found'
  })
  expect(prisma.$transaction).not.toHaveBeenCalled()
  expect(trainingBlockRepository.update).not.toHaveBeenCalled()
})

it('deletes a matching owned block and shifts/reorders subsequent blocks of its plan', async () => {
  const handler = await handlers.DELETE()
  await expect(handler(request())).resolves.toEqual({ success: true })
  expect(requireAuth).toHaveBeenCalledWith(request(), ['plan:write'])
  expect(shiftPlanDates).toHaveBeenCalledExactlyOnceWith('plan-a', 1, -14)
  expect(trainingBlockRepository.updateMany).toHaveBeenCalledExactlyOnceWith(
    { trainingPlanId: 'plan-a', order: { gt: 1 } },
    { order: { decrement: 1 } },
    prisma
  )
  expect(trainingBlockRepository.delete).toHaveBeenCalledExactlyOnceWith('block-a', prisma)
  expect(prisma.plannedWorkout.deleteMany).toHaveBeenCalledExactlyOnceWith({
    where: { trainingWeekId: { in: ['week-1', 'week-2'] }, managedBy: { not: 'USER' } }
  })
})

it('shrinks a matching owned block and updates its schedule', async () => {
  const handler = await handlers.PATCH()
  await handler(request())
  expect(requireAuth).toHaveBeenCalledWith(request(), ['plan:write'])
  expect(shiftPlanDates).toHaveBeenCalledExactlyOnceWith('plan-a', 1, -7)
  expect(trainingWeekRepository.deleteMany).toHaveBeenCalledExactlyOnceWith(
    { id: { in: ['week-2'] } },
    prisma
  )
  expect(prisma.plannedWorkout.deleteMany).toHaveBeenCalledExactlyOnceWith({
    where: { trainingWeekId: { in: ['week-2'] }, managedBy: { not: 'USER' } }
  })
  expect(trainingBlockRepository.update).toHaveBeenCalledExactlyOnceWith(
    'block-a',
    expect.objectContaining({ durationWeeks: 1 }),
    prisma
  )
  expect(trainingBlockRepository.updateMany).not.toHaveBeenCalled()
})
