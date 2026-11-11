import { getServerSession } from '../../../utils/session'
import { prisma } from '../../../utils/db'
import { metabolicService } from '../../../utils/services/metabolicService'
import { isNutritionTrackingEnabled } from '../../../utils/nutrition/feature'
import { formatDateUTC, formatUserDate, getUserTimezone } from '../../../utils/date'

defineRouteMeta({
  openAPI: {
    tags: ['Workouts'],
    summary: 'Link workout to planned workout',
    description:
      'Links an existing completed workout to a planned workout, marking the planned workout as completed.',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['plannedWorkoutId'],
            properties: {
              plannedWorkoutId: { type: 'string' }
            }
          }
        }
      }
    },
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean' }
              }
            }
          }
        }
      },
      400: { description: 'Invalid input' },
      401: { description: 'Unauthorized' },
      404: { description: 'Workout or planned workout not found' }
    }
  }
})

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)

  if (!session?.user) {
    throw createError({
      statusCode: 401,
      message: 'Unauthorized'
    })
  }

  const userId = (session.user as any).id
  const workoutId = getRouterParam(event, 'id')
  if (!workoutId) {
    throw createError({ statusCode: 400, message: 'Workout ID is required' })
  }

  const body = await readBody(event)
  const { plannedWorkoutId } = body

  if (!plannedWorkoutId) {
    throw createError({
      statusCode: 400,
      message: 'Planned workout ID is required'
    })
  }

  // Verify ownership
  const [workout, plannedWorkout] = await Promise.all([
    prisma.workout.findFirst({
      where: {
        id: workoutId,
        userId
      }
    }),
    prisma.plannedWorkout.findFirst({
      where: {
        id: plannedWorkoutId,
        userId
      }
    })
  ])

  if (!workout || !plannedWorkout) {
    throw createError({
      statusCode: 404,
      message: 'Workout or planned workout not found'
    })
  }

  const timezone = await getUserTimezone(userId)
  const workoutDateKey = formatUserDate(workout.date, timezone, 'yyyy-MM-dd')
  const plannedDateKey = formatDateUTC(plannedWorkout.date, 'yyyy-MM-dd')

  if (workoutDateKey !== plannedDateKey) {
    throw createError({
      statusCode: 400,
      message: 'Workout and planned workout must be on the same day to link.'
    })
  }

  const previousPlannedWorkoutId = (workout as { plannedWorkoutId?: string | null })
    .plannedWorkoutId

  // Repeated link is idempotent — already linked to the requested plan.
  if (previousPlannedWorkoutId === plannedWorkoutId) {
    return { success: true }
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Link the workout to the planned workout
      await tx.workout.update({
        where: { id: workoutId },
        data: {
          plannedWorkoutId: plannedWorkoutId
        }
      })

      // Update planned workout status
      await tx.plannedWorkout.update({
        where: { id: plannedWorkoutId },
        data: {
          completed: true,
          completionStatus: 'COMPLETED'
        }
      })

      // Reconcile the previous plan when relinking: only reset it when no
      // other workout remains linked to it. Stays inside the same transaction
      // so a failed relink rolls back atomically.
      if (previousPlannedWorkoutId && previousPlannedWorkoutId !== plannedWorkoutId) {
        const otherLinkedWorkouts = await tx.workout.count({
          where: {
            plannedWorkoutId: previousPlannedWorkoutId,
            id: { not: workoutId }
          }
        })

        if (otherLinkedWorkouts === 0) {
          await tx.plannedWorkout.update({
            where: { id: previousPlannedWorkoutId },
            data: {
              completed: false,
              completionStatus: 'PENDING'
            }
          })
        }
      }
    })

    // REACTIVE: Trigger fueling plan update for the workout date
    try {
      if (await isNutritionTrackingEnabled(userId)) {
        await metabolicService.calculateFuelingPlanForDate(userId, workout.date, {
          persist: true
        })
      }
    } catch (err) {
      console.error('[WorkoutLink] Failed to trigger regeneration:', err)
    }

    return { success: true }
  } catch (error) {
    console.error('Error linking workouts:', error)
    throw createError({
      statusCode: 500,
      message: 'Failed to link workouts'
    })
  }
})
