import { analyticsRepository } from './repositories/analyticsRepository'
import { coachingRepository } from './repositories/coachingRepository'
import { teamRepository } from './repositories/teamRepository'
import { prisma } from './db'
import type { Prisma, Workout } from '@prisma/client'

export interface AnalyticsScopeInput {
  target: 'self' | 'athlete' | 'athletes' | 'athlete_group' | 'team'
  targetId?: string
  targetIds?: string[]
}

async function hasAnalyticsAthleteAccess(userId: string, athleteId: string) {
  if (userId === athleteId) return true

  const isCoaching = await coachingRepository.checkRelationship(userId, athleteId)
  if (isCoaching) return true

  const teams = await teamRepository.getTeamsForUser(userId)
  for (const team of teams) {
    const athleteInTeam = await teamRepository.checkTeamAccess(team.teamId, athleteId)
    if (!athleteInTeam) continue

    const isStaff = await teamRepository.checkTeamAccess(team.teamId, userId, [
      'OWNER',
      'ADMIN',
      'COACH'
    ])
    if (isStaff) return true

    // Sharing a team only exposes athletes who explicitly allow teammate access.
    const athlete = await prisma.user.findUnique({
      where: { id: athleteId },
      select: { teamVisibility: true }
    })
    if (athlete?.teamVisibility === 'TEAMMATES') return true
  }

  return false
}

export async function assertAnalyticsScopeAccess(userId: string, scope: AnalyticsScopeInput) {
  if (scope.target === 'self') return

  if (scope.target === 'athlete' && scope.targetId) {
    const hasAccess = await hasAnalyticsAthleteAccess(userId, scope.targetId)
    if (hasAccess) return

    throw createError({ statusCode: 403, statusMessage: 'You do not have access to this athlete' })
  }

  if (scope.target === 'athletes' && scope.targetIds?.length) {
    for (const athleteId of scope.targetIds) {
      const hasAccess = await hasAnalyticsAthleteAccess(userId, athleteId)
      if (!hasAccess) {
        throw createError({
          statusCode: 403,
          statusMessage: 'You do not have access to one or more selected athletes'
        })
      }
    }

    return
  }

  if (scope.target === 'athlete_group' && scope.targetId) {
    const isOwner = await teamRepository.checkGroupOwnership(scope.targetId, userId)
    if (isOwner) return

    const group = await (prisma as any).athleteGroup.findUnique({ where: { id: scope.targetId } })
    if (group?.teamId) {
      const isStaff = await teamRepository.checkTeamAccess(group.teamId, userId, [
        'OWNER',
        'ADMIN',
        'COACH'
      ])
      if (isStaff) return
    }

    throw createError({ statusCode: 403, statusMessage: 'You do not have access to this group' })
  }

  if (scope.target === 'team' && scope.targetId) {
    const isStaff = await teamRepository.checkTeamAccess(scope.targetId, userId, [
      'OWNER',
      'ADMIN',
      'COACH'
    ])
    if (!isStaff) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Only team staff can query team-wide analytics'
      })
    }
  }
}

export async function resolveAnalyticsScopeUserIds(userId: string, scope: AnalyticsScopeInput) {
  await assertAnalyticsScopeAccess(userId, scope)
  return analyticsRepository.resolveTargetUserIds(userId, scope)
}

export async function assertWorkoutComparisonAccess(userId: string, workoutIds: string[]) {
  return assertWorkoutSelectionAccess(userId, workoutIds, 2)
}

export async function assertSingleWorkoutAccess(
  userId: string,
  workoutId: string
): Promise<string> {
  const [resolvedWorkoutId] = await assertWorkoutSelectionAccess(userId, [workoutId], 1)
  if (!resolvedWorkoutId) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Workout not found or access denied'
    })
  }
  return resolvedWorkoutId
}

export async function getAccessibleWorkout(
  userId: string,
  workoutId: string
): Promise<Workout | null>
export async function getAccessibleWorkout(
  userId: string,
  workoutId: string,
  options: { select: Prisma.WorkoutSelect }
): Promise<Prisma.WorkoutGetPayload<{ select: Prisma.WorkoutSelect }> | null>
export async function getAccessibleWorkout(
  userId: string,
  workoutId: string,
  options: { include: Prisma.WorkoutInclude }
): Promise<Prisma.WorkoutGetPayload<{ include: Prisma.WorkoutInclude }> | null>
export async function getAccessibleWorkout(
  userId: string,
  workoutId: string,
  options: {
    include?: Prisma.WorkoutInclude
    select?: Prisma.WorkoutSelect
  } = {}
) {
  const resolvedWorkoutId = await assertSingleWorkoutAccess(userId, workoutId)

  const workoutRef = await prisma.workout.findUnique({
    where: { id: resolvedWorkoutId },
    select: { id: true, userId: true }
  })

  if (!workoutRef) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Workout not found or access denied'
    })
  }

  if (options.select) {
    return prisma.workout.findFirst({
      where: {
        id: workoutRef.id,
        userId: workoutRef.userId
      },
      select: options.select
    })
  }

  return prisma.workout.findFirst({
    where: {
      id: workoutRef.id,
      userId: workoutRef.userId
    },
    include: options.include
  })
}

async function assertWorkoutSelectionAccess(
  userId: string,
  workoutIds: string[],
  minCount: number
) {
  const requestedIds = Array.from(new Set(workoutIds.filter(Boolean)))

  if (requestedIds.length < minCount) {
    throw createError({
      statusCode: 400,
      statusMessage:
        minCount === 1 ? 'Select a workout to analyze' : 'Select at least two workouts to compare'
    })
  }

  const workouts = await prisma.workout.findMany({
    where: { id: { in: requestedIds } },
    select: {
      id: true,
      userId: true,
      isDuplicate: true,
      duplicateOf: true
    }
  })

  if (workouts.length !== requestedIds.length) {
    throw createError({
      statusCode: 404,
      statusMessage: 'One or more workouts could not be found'
    })
  }

  for (const workout of workouts) {
    const hasAccess = await hasAnalyticsAthleteAccess(userId, workout.userId)
    if (!hasAccess) {
      throw createError({
        statusCode: 403,
        statusMessage: 'You do not have access to one or more selected workouts'
      })
    }
  }

  const canonicalIds = Array.from(
    new Set(
      workouts
        .filter((workout) => workout.isDuplicate && workout.duplicateOf)
        .map((workout) => workout.duplicateOf as string)
    )
  )

  return requestedIds.map((id) => {
    const workout = workouts.find((entry) => entry.id === id)
    if (workout?.isDuplicate && workout.duplicateOf && canonicalIds.includes(workout.duplicateOf)) {
      return workout.duplicateOf
    }

    return id
  })
}
