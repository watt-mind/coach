import { requireAuth } from '../../../../utils/auth-guard'
import { prisma } from '../../../../utils/db'
import { shiftPlanDates } from '../../../../utils/plan-logic'
import { trainingBlockRepository } from '../../../../utils/repositories/trainingBlockRepository'

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event, ['plan:write'])

  const planId = getRouterParam(event, 'id')
  const blockId = getRouterParam(event, 'blockId')

  const existingBlock = await trainingBlockRepository.getById(blockId!, {
    include: {
      plan: { select: { userId: true } },
      weeks: { select: { id: true } }
    }
  })

  if (
    !existingBlock ||
    existingBlock.trainingPlanId !== planId ||
    (existingBlock.plan as any).userId !== user.id
  ) {
    throw createError({ statusCode: 404, message: 'Block not found' })
  }

  const deltaDays = -existingBlock.durationWeeks * 7

  return await prisma.$transaction(async (tx) => {
    // 1. Delete AI workouts in this block, unlink USER ones
    const weekIds = existingBlock.weeks.map((w) => w.id)
    if (weekIds.length > 0) {
      await tx.plannedWorkout.deleteMany({
        where: {
          trainingWeekId: { in: weekIds },
          managedBy: { not: 'USER' }
        }
      })
    }

    // 2. Shift subsequent blocks backward
    await shiftPlanDates(planId!, existingBlock.order, deltaDays)

    // 3. Decrement order for subsequent blocks
    await trainingBlockRepository.updateMany(
      {
        trainingPlanId: planId,
        order: { gt: existingBlock.order }
      },
      {
        order: { decrement: 1 }
      },
      tx
    )

    // 4. Delete the block
    await trainingBlockRepository.delete(blockId!, tx)

    return { success: true }
  })
})
