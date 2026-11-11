import { attachStreamToWorkout } from '../../../utils/repositories/workoutStreamRepository'

defineRouteMeta({
  openAPI: {
    tags: ['Public'],
    summary: 'Get public workout',
    description: 'Returns details of a publicly shared workout via token.',
    inputSchema: [
      {
        name: 'token',
        in: 'path',
        required: true,
        schema: { type: 'string' }
      }
    ],
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                date: { type: 'string', format: 'date-time' },
                user: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', nullable: true },
                    image: { type: 'string', nullable: true }
                  }
                }
              }
            }
          }
        }
      },
      404: { description: 'Workout not found or link invalid' }
    }
  }
})

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')

  if (!token) {
    throw createError({
      statusCode: 400,
      message: 'Share token is required'
    })
  }

  const shareToken = await prisma.shareToken.findUnique({
    where: { token }
  })

  if (!shareToken || shareToken.resourceType !== 'WORKOUT') {
    throw createError({
      statusCode: 404,
      message: 'Workout not found or link is invalid'
    })
  }

  if (shareToken.expiresAt && new Date() > new Date(shareToken.expiresAt)) {
    throw createError({
      statusCode: 404,
      message: 'Share link has expired'
    })
  }

  const workoutRecord = await prisma.workout.findUnique({
    where: {
      id: shareToken.resourceId
    },
    include: {
      oauthApp: {
        select: {
          name: true,
          sourceName: true
        }
      },
      user: {
        select: {
          name: true,
          image: true
        }
      },
      planAdherence: true,
      plannedWorkout: true
    }
  })

  if (!workoutRecord) {
    throw createError({
      statusCode: 404,
      message: 'Workout not found or link is invalid'
    })
  }

  const workout = await attachStreamToWorkout(workoutRecord)

  const { userId, externalId, plannedWorkout, ...safeWorkout } = workout
  return {
    ...safeWorkout,
    // Public PlanAdherence needs only these fields. New model fields stay private.
    plannedWorkout: plannedWorkout
      ? {
          id: plannedWorkout.id,
          title: plannedWorkout.title,
          type: plannedWorkout.type,
          durationSec: plannedWorkout.durationSec
        }
      : null
  }
})
