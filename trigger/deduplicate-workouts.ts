import './init'
import { logger, task } from '@trigger.dev/sdk/v3'
import { prisma } from '../server/utils/db'
import { workoutRepository } from '../server/utils/repositories/workoutRepository'
import { attachStreamsToWorkouts } from '../server/utils/repositories/workoutStreamRepository'
import { recalculateStressAfterDate } from '../server/utils/calculate-workout-stress'
import { userBackgroundQueue } from './queues'
import { deduplicationService } from '../server/utils/services/deduplicationService'
import { enqueueAutomaticWorkoutAnalysesForUser } from '../server/utils/workout-analysis-enqueue'

export const deduplicateWorkoutsTask = task({
  id: 'deduplicate-workouts',
  maxDuration: 300,
  queue: userBackgroundQueue,
  run: async (payload: { userId: string; dryRun?: boolean; targetBestWorkoutIds?: string[] }) => {
    const { userId, dryRun = false, targetBestWorkoutIds } = payload

    logger.log('Starting workout deduplication', {
      userId,
      dryRun,
      targetBestWorkoutIdsCount: targetBestWorkoutIds?.length,
      userIdType: typeof userId,
      payloadReceived: payload
    })

    try {
      // Resolve userId - it might be an email, so look up the actual user ID
      let actualUserId = userId

      // Check if userId looks like an email
      if (userId.includes('@')) {
        logger.log('userId appears to be an email, looking up user record')
        const user = await prisma.user.findUnique({
          where: { email: userId },
          select: { id: true }
        })

        if (!user) {
          logger.error('User not found with email', { email: userId })
          throw new Error(`User not found with email: ${userId}`)
        }

        actualUserId = user.id
        logger.log('Resolved user ID', { email: userId, actualUserId })
      }

      // Here we explicitly want ALL workouts, including potential duplicates, to analyze them.
      // So we use includeDuplicates: true
      // Include stream ID to check for existence
      const workoutRecords = await workoutRepository.getForUser(actualUserId, {
        includeDuplicates: true,
        orderBy: { date: 'desc' },
        include: {
          exercises: {
            select: { id: true }
          },
          oauthApp: {
            select: {
              name: true,
              sourceName: true
            }
          }
        }
      })

      // deduplicationService.findDuplicateGroups()/calculateCompletenessScore
      // only check whether `streams` is truthy (never read a specific field),
      // so no optional stream columns are needed here -- just the mandatory
      // baseline findManyByWorkoutIds always fetches to determine "usable"
      // streams. This is the CW-224 fix: this task can process a user's
      // entire workout history (hundreds of IDs) in one call.
      const workouts = await attachStreamsToWorkouts(workoutRecords, { fields: [] })

      logger.log(`Found ${workouts.length} workouts to analyze`, {
        userId: actualUserId,
        sampleWorkout: workouts[0]
          ? {
              id: workouts[0].id,
              title: workouts[0].title,
              source: workouts[0].source,
              date: workouts[0].date,
              plannedWorkoutId: workouts[0].plannedWorkoutId
            }
          : null
      })

      const duplicateGroups = deduplicationService.findDuplicateGroups(workouts)

      logger.log(`Identified ${duplicateGroups.length} duplicate groups`)

      if (dryRun) {
        logger.log('Dry run enabled - skipping updates and deletions')

        // Enrich groups with proposed link info
        const enrichedGroups = []
        for (const group of duplicateGroups) {
          const bestWorkout = group.workouts.find((w) => w.id === group.bestWorkoutId)
          let proposedLink = null

          // Check if best workout already has a link
          if (bestWorkout?.plannedWorkoutId) {
            // Already linked, no action needed unless we want to show it?
            // UI probably assumes no link if not provided.
          } else {
            // Check duplicates for link
            const duplicatesToDelete = group.toDelete // these are just IDs in the group structure? No, group.workouts has full objects.
            const duplicateWorkouts = group.workouts.filter((w) => group.toDelete.includes(w.id))

            const linkFromDuplicate = duplicateWorkouts.find((w) => w.plannedWorkoutId)

            if (linkFromDuplicate) {
              // We don't have the title easily unless we fetch it, but we have the ID
              // Let's fetch it for better UI
              const plan = await prisma.plannedWorkout.findUnique({
                where: { id: linkFromDuplicate.plannedWorkoutId },
                select: { id: true, title: true }
              })
              if (plan) proposedLink = plan
            } else {
              // Check for new link
              const plan = await deduplicationService.findProposedLink(bestWorkout)
              if (plan) {
                proposedLink = { id: plan.id, title: plan.title, isNew: true }
              }
            }
          }

          enrichedGroups.push({
            ...group,
            proposedLink
          })
        }

        return {
          success: true,
          dryRun: true,
          duplicateGroups: enrichedGroups,
          workoutsDeleted: 0,
          workoutsKept: 0,
          groupsSkipped: 0
        }
      }

      let deletedCount = 0
      let keptCount = 0
      let groupsSkipped = 0
      const processedPrimaryWorkoutIds = new Set<string>()

      for (const group of duplicateGroups) {
        // If specific targets are requested, skip groups that don't match
        if (targetBestWorkoutIds && !targetBestWorkoutIds.includes(group.bestWorkoutId)) {
          logger.log(`Skipping group with bestWorkoutId ${group.bestWorkoutId} (not in selection)`)
          continue
        }

        logger.log(`Processing duplicate group:`, {
          workoutCount: group.workouts.length,
          bestWorkoutId: group.bestWorkoutId,
          duplicatesToMark: group.toDelete,
          sources: group.workouts.map((w) => w.source)
        })

        const result = await deduplicationService.mergeDuplicateGroup(group)
        if (result.skipped) groupsSkipped += 1
        deletedCount += result.deletedCount
        keptCount += result.keptCount
        processedPrimaryWorkoutIds.add(group.bestWorkoutId)
      }

      logger.log('Deduplication complete', {
        totalDeleted: deletedCount,
        totalKept: keptCount
      })

      // If any duplicates were found and processed, recalculate stress scores
      if (duplicateGroups.length > 0 && deletedCount > 0) {
        // Find the earliest date among all workouts in all duplicate groups
        let earliestDate = new Date()
        for (const group of duplicateGroups) {
          for (const workout of group.workouts) {
            const workoutDate = new Date(workout.date)
            if (workoutDate < earliestDate) {
              earliestDate = workoutDate
            }
          }
        }

        logger.log(`Triggering training stress recalculation after ${earliestDate.toISOString()}`)
        await recalculateStressAfterDate(actualUserId, earliestDate)
      }

      const analysis = await enqueueAutomaticWorkoutAnalysesForUser(actualUserId)
      logger.log('🤖 [Auto-Analyze] Enqueue complete', analysis)

      return {
        success: true,
        duplicateGroups: duplicateGroups.length,
        workoutsDeleted: deletedCount,
        workoutsKept: keptCount,
        groupsSkipped
      }
    } catch (error) {
      logger.error('Error deduplicating workouts', { error })
      throw error
    }
  }
})
