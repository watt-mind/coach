import type { PlannedWorkout, Workout } from '@prisma/client'
import { prisma } from './db'
import { formatUserDate, getUserTimezone } from './date'
import { publishActivityEvent } from './activity-realtime'

type WorkoutForPlannedLink = Pick<
  Workout,
  'id' | 'userId' | 'date' | 'type' | 'durationSec' | 'plannedWorkoutId'
>

type PlannedWorkoutMatch = Pick<
  PlannedWorkout,
  'id' | 'title' | 'type' | 'durationSec' | 'date' | 'completed' | 'completionStatus'
>

function workoutTypeMatchesPlan(workoutType: string, planType: string) {
  if (planType === workoutType) return true
  if (workoutType.includes('ride') && planType.includes('ride')) return true
  if (workoutType.includes('run') && planType.includes('run')) return true
  return false
}

export async function findMatchingPlannedWorkoutForWorkout(
  workout: WorkoutForPlannedLink
): Promise<PlannedWorkoutMatch | null> {
  const timezone = await getUserTimezone(workout.userId)
  const workoutDateKey = formatUserDate(workout.date, timezone, 'yyyy-MM-dd')
  const plannedDate = new Date(`${workoutDateKey}T00:00:00Z`)

  const candidates = await prisma.plannedWorkout.findMany({
    where: {
      userId: workout.userId,
      date: plannedDate,
      completed: false
    },
    select: {
      id: true,
      title: true,
      type: true,
      durationSec: true,
      date: true,
      completed: true,
      completionStatus: true
    }
  })

  if (candidates.length === 0) {
    return null
  }

  const workoutType = (workout.type || '').toLowerCase()

  if (candidates.length === 1) {
    const soleCandidate = candidates[0]
    if (
      soleCandidate &&
      workoutTypeMatchesPlan(workoutType, (soleCandidate.type || '').toLowerCase())
    ) {
      return soleCandidate
    }

    console.log(
      `Single planned workout found for ${workout.date.toISOString()} but type '${workout.type}' does not match planned type '${soleCandidate?.type}'. Skipping auto-link.`
    )
    return null
  }

  const typeMatches = candidates.filter((plannedWorkout) =>
    workoutTypeMatchesPlan(workoutType, (plannedWorkout.type || '').toLowerCase())
  )

  const firstTypeMatch = typeMatches[0]
  if (typeMatches.length === 1 && firstTypeMatch) {
    return firstTypeMatch
  }

  if (typeMatches.length > 1) {
    const [bestMatch] = typeMatches
      .map((plannedWorkout) => ({
        plannedWorkout,
        diff: Math.abs((plannedWorkout.durationSec || 0) - (workout.durationSec || 0))
      }))
      .sort((a, b) => a.diff - b.diff)

    if (bestMatch) {
      console.log(
        `Multiple matching planned workouts found. Selected best duration match: ${bestMatch.plannedWorkout.title} (Diff: ${bestMatch.diff}s)`
      )
      return bestMatch.plannedWorkout
    }
  }

  console.log(
    `Multiple planned workouts found for ${workout.date.toISOString()} but none matched type '${workout.type}'. Skipping auto-link.`
  )
  return null
}

export async function linkWorkoutToMatchingPlannedWorkout(workout: WorkoutForPlannedLink) {
  if (workout.plannedWorkoutId) {
    return { linked: false, reason: 'already_linked' as const }
  }

  const plannedWorkout = await findMatchingPlannedWorkoutForWorkout(workout)
  if (!plannedWorkout) {
    return { linked: false, reason: 'no_match' as const }
  }

  const linked = await prisma.$transaction(async (tx) => {
    const currentWorkout = await tx.workout.findFirst({
      where: {
        id: workout.id,
        userId: workout.userId
      },
      select: {
        plannedWorkoutId: true
      }
    })

    if (!currentWorkout || currentWorkout.plannedWorkoutId) {
      return false
    }

    const plannedUpdate = await tx.plannedWorkout.updateMany({
      where: {
        id: plannedWorkout.id,
        userId: workout.userId,
        completed: false
      },
      data: {
        completed: true,
        completionStatus: 'COMPLETED'
      }
    })

    if (plannedUpdate.count !== 1) {
      return false
    }

    const workoutUpdate = await tx.workout.updateMany({
      where: {
        id: workout.id,
        userId: workout.userId,
        plannedWorkoutId: null
      },
      data: {
        plannedWorkoutId: plannedWorkout.id
      }
    })

    if (workoutUpdate.count !== 1) {
      throw new Error(
        `Failed to link workout ${workout.id} to planned workout ${plannedWorkout.id}`
      )
    }

    return true
  })

  if (!linked) {
    return { linked: false, reason: 'stale_match' as const, plannedWorkoutId: plannedWorkout.id }
  }

  await Promise.all([
    publishActivityEvent(workout.userId, {
      scope: 'calendar',
      entityType: 'workout',
      entityId: workout.id,
      reason: 'updated'
    }),
    publishActivityEvent(workout.userId, {
      scope: 'calendar',
      entityType: 'planned_workout',
      entityId: plannedWorkout.id,
      reason: 'updated'
    })
  ])

  return { linked: true as const, plannedWorkoutId: plannedWorkout.id }
}
