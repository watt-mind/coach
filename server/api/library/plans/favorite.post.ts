import { getServerSession } from '../../../utils/session'
import { prisma } from '../../../utils/db'
import { z } from 'zod/v3'
import { getLibraryAccessContext, getReadableLibraryOwnerIds } from '../../../utils/library-access'

const favoriteSchema = z.object({
  planId: z.string(),
  isFavorite: z.boolean()
})

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  if (!session?.user?.id) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  const userId = session.user.id
  const validation = favoriteSchema.safeParse(await readBody(event))
  if (!validation.success) {
    throw createError({ statusCode: 400, message: validation.error.message })
  }

  const { planId, isFavorite } = validation.data

  if (!isFavorite) {
    await prisma.favoriteTrainingPlan.deleteMany({
      where: { userId, planId }
    })
    return { success: true }
  }

  // Favorite membership must never grant read access: only create the favorite
  // when the plan is currently readable (own template per coaching scope,
  // PUBLIC template, or TEAM template with an ACTIVE membership).
  const context = getLibraryAccessContext(session.user)
  const ownerIds = getReadableLibraryOwnerIds(context, 'all')
  const memberships = await prisma.teamMember.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { teamId: true }
  })
  const teamIds = memberships.map((membership) => membership.teamId)

  const readablePlan = await prisma.trainingPlan.findFirst({
    where: {
      id: planId,
      isTemplate: true,
      OR: [
        { userId: { in: ownerIds } },
        { visibility: 'PUBLIC' },
        { visibility: 'TEAM', teamId: { in: teamIds } }
      ]
    },
    select: { id: true }
  })

  if (!readablePlan) {
    throw createError({ statusCode: 404, message: 'Plan not found.' })
  }

  await prisma.favoriteTrainingPlan.upsert({
    where: {
      userId_planId: { userId, planId }
    },
    create: { userId, planId },
    update: {}
  })

  return { success: true }
})
