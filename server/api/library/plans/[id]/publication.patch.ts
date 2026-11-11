import { getServerSession } from '../../../../utils/session'
import { prisma } from '../../../../utils/db'
import {
  normalizePublicPlanSlug,
  planPublicationSchema,
  validatePublicationState
} from '../../../../utils/public-plans'

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  if (!session?.user?.id) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, message: 'Plan ID is required.' })
  }

  const body = await readValidatedBody(event, planPublicationSchema.parse)
  const userId = session.user.id

  const existingPlan = await prisma.trainingPlan.findFirst({
    where: { id, userId },
    include: {
      blocks: {
        select: {
          weeks: {
            select: {
              id: true
            }
          }
        }
      }
    }
  })

  if (!existingPlan) {
    throw createError({ statusCode: 404, message: 'Plan not found.' })
  }

  const visibility = body.visibility ?? existingPlan.visibility
  const teamId = body.teamId === undefined ? existingPlan.teamId : body.teamId

  if (visibility === 'TEAM') {
    if (!teamId?.trim()) {
      throw createError({ statusCode: 400, message: 'Team plans require a team ID.' })
    }

    const membership = await prisma.teamMember.findFirst({
      where: { userId, teamId, status: 'ACTIVE' }
    })
    if (!membership) {
      throw createError({ statusCode: 403, message: 'Active team membership is required.' })
    }
  }

  const availableWeekIds = new Set(
    existingPlan.blocks.flatMap((block) => block.weeks.map((week) => week.id))
  )
  const sampleWeekIds = (body.sampleWeekIds || []).filter((weekId) => availableWeekIds.has(weekId))
  const slug = normalizePublicPlanSlug(body.slug, body.slug ? undefined : existingPlan.name)

  validatePublicationState({
    visibility,
    accessState: body.accessState ?? existingPlan.accessState,
    slug: slug ?? existingPlan.slug,
    publicDescription: body.publicDescription ?? existingPlan.publicDescription,
    primarySport: body.primarySport ?? existingPlan.primarySport,
    skillLevel: body.skillLevel ?? existingPlan.skillLevel,
    sampleWeekIds
  })

  const updated = await prisma.$transaction(async (tx) => {
    const plan = await tx.trainingPlan.update({
      where: { id },
      data: {
        visibility: body.visibility,
        accessState: body.accessState,
        slug,
        primarySport: body.primarySport,
        sportSubtype: body.sportSubtype,
        skillLevel: body.skillLevel,
        planLanguage: body.planLanguage,
        daysPerWeek: body.daysPerWeek,
        weeklyVolumeBand: body.weeklyVolumeBand,
        goalLabel: body.goalLabel,
        equipmentTags: body.equipmentTags,
        publicHeadline: body.publicHeadline,
        publicDescription: body.publicDescription,
        methodology: body.methodology,
        whoItsFor: body.whoItsFor,
        faq: body.faq,
        extraContent: body.extraContent,
        isFeatured: body.isFeatured,
        teamId: body.teamId
      }
    })

    await tx.trainingPlanPublicSampleWeek.deleteMany({
      where: { planId: id }
    })

    if (sampleWeekIds.length > 0) {
      await tx.trainingPlanPublicSampleWeek.createMany({
        data: sampleWeekIds.map((weekId) => ({
          planId: id,
          weekId
        }))
      })
    }

    return plan
  })

  return { success: true, plan: updated, sampleWeekIds }
})
