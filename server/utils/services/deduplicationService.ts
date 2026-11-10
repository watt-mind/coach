import { prisma } from '../db'
import { workoutRepository } from '../repositories/workoutRepository'
import { logger } from '@trigger.dev/sdk/v3'
import { findMatchingPlannedWorkoutForWorkout } from '../planned-workout-linking'

export interface DuplicateGroup {
  workouts: Array<any> // Full workout objects
  bestWorkoutId: string
  toDelete: string[]
}

export interface MergeDuplicateGroupResult {
  deletedCount: number
  keptCount: number
  /** True when the group was abandoned because it no longer describes the database. */
  skipped?: boolean
}

/**
 * Prisma raises `P2025` ("An operation failed because it depends on one or more
 * records that were required but not found") when a `where`-targeted row no
 * longer exists. Matched by `code` rather than `instanceof` because the concrete
 * error class differs between the query engines and is re-wrapped by the driver
 * adapter — same duck-typing the rest of the codebase uses (see
 * `server/api/auth/[...].ts`, `server/api/webhooks/revenuecat.post.ts`,
 * `trigger/ingest-intervals.ts`).
 */
function isRecordNotFoundError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2025'
}

export const deduplicationService = {
  /**
   * Identifies duplicate groups from a list of workouts.
   */
  findDuplicateGroups(workouts: any[]): DuplicateGroup[] {
    const groups: DuplicateGroup[] = []
    const processed = new Set<string>()

    for (let i = 0; i < workouts.length; i++) {
      if (processed.has(workouts[i].id)) continue

      const workout = workouts[i]
      const duplicates = [workout]
      processed.add(workout.id)

      for (let j = i + 1; j < workouts.length; j++) {
        if (processed.has(workouts[j].id)) continue

        const other = workouts[j]

        if (this.areDuplicates(workout, other)) {
          duplicates.push(other)
          processed.add(other.id)
        }
      }

      if (duplicates.length > 1) {
        // Calculate scores for all duplicates
        const scoredWorkouts = duplicates.map((w) => {
          // Create a copy with the calculated score
          return {
            ...w,
            completenessScore: this.calculateCompletenessScore(w)
          }
        })

        scoredWorkouts.sort((a, b) => b.completenessScore - a.completenessScore)

        const bestWorkout = scoredWorkouts[0]
        const toDelete = scoredWorkouts.slice(1).map((w) => w.id)

        // Filter out groups where all 'toDelete' are ALREADY duplicates of 'bestWorkout'
        // This prevents re-surfacing resolved groups in the UI
        const alreadyResolved = scoredWorkouts
          .slice(1)
          .every((w) => w.isDuplicate && w.duplicateOf === bestWorkout.id)

        if (!alreadyResolved) {
          groups.push({
            workouts: scoredWorkouts,
            bestWorkoutId: bestWorkout.id,
            toDelete
          })
        }
      }
    }

    return groups
  },

  /**
   * Helper to check if two activity types are similar across integrations and localized strings.
   */
  areTypesSimilar(t1?: string | null, t2?: string | null): boolean {
    if (!t1 || !t2) return true

    const type1 = t1.toLowerCase().trim()
    const type2 = t2.toLowerCase().trim()

    if (type1 === type2) return true
    if (type1.includes(type2) || type2.includes(type1)) return true

    const genericTypes = ['other', 'workout', 'uncategorized', 'activity', 'fitness']
    if (genericTypes.includes(type1) || genericTypes.includes(type2)) return true

    const isCategory = (type: string, keywords: string[]) => keywords.some((k) => type.includes(k))

    const cyclingKeywords = ['ride', 'bike', 'cycling', 'cycl', 'velo', 'вело']
    const runningKeywords = ['run', 'running', 'treadmill', 'бег']
    const walkingKeywords = ['walk', 'walking', 'hike', 'hiking', 'ходьба']
    const gymKeywords = [
      'gym',
      'weight',
      'strength',
      'fitness',
      'calisthenic',
      'crossfit',
      'bodyweight',
      'workout',
      'силовая',
      'зал'
    ]
    const swimmingKeywords = ['swim', 'swimming', 'pool', 'плавание']
    const rowingKeywords = ['row', 'rowing', 'kayak', 'canoe', 'paddle', 'гребля']
    const skiingKeywords = ['ski', 'snowboard', 'лыжи']

    if (isCategory(type1, cyclingKeywords) && isCategory(type2, cyclingKeywords)) return true
    if (isCategory(type1, runningKeywords) && isCategory(type2, runningKeywords)) return true
    if (isCategory(type1, walkingKeywords) && isCategory(type2, walkingKeywords)) return true
    if (isCategory(type1, gymKeywords) && isCategory(type2, gymKeywords)) return true
    if (isCategory(type1, swimmingKeywords) && isCategory(type2, swimmingKeywords)) return true
    if (isCategory(type1, rowingKeywords) && isCategory(type2, rowingKeywords)) return true
    if (isCategory(type1, skiingKeywords) && isCategory(type2, skiingKeywords)) return true

    return false
  },

  /**
   * Comparison logic to determine if two workouts are duplicates.
   */
  areDuplicates(w1: any, w2: any): boolean {
    // DEBUG: Check for specific problematic pair
    const debugIds = [
      '7f85cbdc-b95e-4d8a-83bc-b97898ca3376',
      '8f679573-1e60-420d-97e3-8a6c0ab88321'
    ]
    const isDebugPair = debugIds.includes(w1.id) && debugIds.includes(w2.id)

    const timeDiff = Math.abs(new Date(w1.date).getTime() - new Date(w2.date).getTime())

    if (isDebugPair) {
      logger.log(`DEBUG COMPARISON: ${w1.title} (${w1.source}) vs ${w2.title} (${w2.source})`, {
        timeDiff,
        w1Date: w1.date,
        w2Date: w2.date,
        w1Dur: w1.durationSec,
        w2Dur: w2.durationSec,
        w1Type: w1.type,
        w2Type: w2.type
      })
    }

    // With corrected UTC timestamps, workouts should be very close in time.
    // Keep the default window tight and only allow a small timezone-shift fallback
    // when comparing different providers.
    let maxTimeDiff = 30 * 60 * 1000
    const sameSource = w1.source === w2.source

    const diffInHours = timeDiff / (60 * 60 * 1000)
    const diffHoursRemainder = Math.abs(diffInHours - Math.round(diffInHours))

    // Timezone fallback:
    // - only across different providers
    // - only for small whole-hour offsets
    // This avoids collapsing separate same-day workouts from the same source.
    const isTimezoneShiftCandidate =
      !sameSource && diffInHours >= 1 && diffInHours <= 3 && diffHoursRemainder < 5 / 60

    if (isTimezoneShiftCandidate) {
      maxTimeDiff = timeDiff + 1000 // Allow it to pass

      if (isDebugPair) {
        logger.log(
          `Detected potential timezone shift between workouts (${diffInHours.toFixed(2)}h)`,
          {
            w1: { id: w1.id, date: w1.date, source: w1.source },
            w2: { id: w2.id, date: w2.date, source: w2.source }
          }
        )
      }
    }

    if (timeDiff > maxTimeDiff) {
      // Only log if they are somewhat close (e.g. within 2 hours) to avoid log spam for unrelated workouts
      if (timeDiff < 2 * 60 * 60 * 1000) {
        // Reduced log spam
      }
      return false
    }

    const durationDiff = Math.abs(w1.durationSec - w2.durationSec)

    // Dynamic duration tolerance based on activity type and closeness of start time
    // For activities like Skiing/Hiking where moving time vs elapsed time varies greatly, be more lenient
    const isPauseHeavy =
      w1.type?.includes('Ski') ||
      w1.type?.includes('Snowboard') ||
      w1.type?.includes('Hike') ||
      w2.type?.includes('Ski') ||
      w2.type?.includes('Snowboard') ||
      w2.type?.includes('Hike')

    let maxDurationDiff = 5 * 60 // Default 5 mins
    const tenPercent = Math.max(w1.durationSec, w2.durationSec) * 0.1
    maxDurationDiff = Math.max(maxDurationDiff, tenPercent)

    // If start times are very close (< 10 mins), relax duration check significantly
    // This handles cases where one device records "moving time" and another "elapsed time"
    if (timeDiff < 10 * 60 * 1000) {
      if (isPauseHeavy) {
        // For skiing, etc., allow up to 90% difference or 60 mins
        maxDurationDiff = Math.max(60 * 60, Math.max(w1.durationSec, w2.durationSec) * 0.9)
      } else {
        // For others, allow 50% difference or 30 mins
        maxDurationDiff = Math.max(30 * 60, Math.max(w1.durationSec, w2.durationSec) * 0.5)
      }
    }

    if (durationDiff > maxDurationDiff) {
      if (isDebugPair) {
        logger.log(`Duration diff too large: ${durationDiff}s (max: ${maxDurationDiff}s)`, {
          w1: { title: w1.title, duration: w1.durationSec, type: w1.type },
          w2: { title: w2.title, duration: w2.durationSec, type: w2.type }
        })
      }
      return false
    }

    const titleSimilar =
      w1.title &&
      w2.title &&
      (w1.title.toLowerCase().includes(w2.title.toLowerCase()) ||
        w2.title.toLowerCase().includes(w1.title.toLowerCase()))

    const strictDurationMatch =
      durationDiff <= Math.max(3 * 60, Math.max(w1.durationSec, w2.durationSec) * 0.05)

    const typeSimilar = this.areTypesSimilar(w1.type, w2.type)

    // For timezone-shift candidates, require stronger evidence than type alone.
    const isDuplicate = isTimezoneShiftCandidate
      ? Boolean(titleSimilar || (typeSimilar && strictDurationMatch))
      : Boolean(titleSimilar || typeSimilar || strictDurationMatch)

    if (isDuplicate && isDebugPair) {
      logger.log(`Detected duplicate workouts:`, {
        w1: { title: w1.title, type: w1.type, source: w1.source, date: w1.date },
        w2: { title: w2.title, type: w2.type, source: w2.source, date: w2.date },
        titleSimilar,
        typeSimilar,
        strictDurationMatch,
        isTimezoneShiftCandidate
      })
    }

    return isDuplicate
  },

  /**
   * Calculates a completeness score to determine the "Best" version of a workout.
   */
  calculateCompletenessScore(workout: any): number {
    let score = 0

    // Prefer manual input or specific sources if reliable
    // But generally trust device data more for metrics
    if (workout.source === 'hevy' || workout.source === 'liftosaur') {
      score += 25 // High trust for strength providers with structured exercises
    } else if (workout.source === 'intervals') {
      score += 15 // Increased trust for Intervals.icu as it often aggregates well
    } else if (workout.source === 'garmin') {
      score += 15 // High trust for Garmin as it's the primary recording device
    } else if (workout.source === 'strava') {
      score += 10
    } else if (workout.source === 'whoop') {
      score += 10 // Whoop is a high quality source
    } else if (workout.source === 'withings') {
      score += 5
    }

    // Check for structured exercises (strong signal for Hevy/Strength)
    if (workout.exercises && workout.exercises.length > 0) {
      score += 50 // Massive boost for actual exercise data
    }

    const isCycling =
      workout.type?.toLowerCase().includes('ride') ||
      workout.type?.toLowerCase().includes('bike') ||
      workout.type?.toLowerCase().includes('cycl') ||
      workout.type?.toLowerCase().includes('вело')
    const isGym =
      workout.type?.toLowerCase().includes('gym') ||
      workout.type?.toLowerCase().includes('strength') ||
      workout.type?.toLowerCase().includes('weight') ||
      workout.type?.toLowerCase().includes('fitness') ||
      workout.type?.toLowerCase().includes('силов')
    const isSwim =
      workout.type?.toLowerCase().includes('swim') || workout.type?.toLowerCase().includes('плав')

    if (isCycling) {
      if (workout.averageWatts && workout.averageWatts > 0) {
        score += 40 // Power is king for cycling
        if (workout.source === 'intervals') score += 10
      }
      if (workout.normalizedPower && workout.normalizedPower > 0) score += 10
      if (workout.tss && workout.tss > 0) score += 10
    }

    if (isGym && workout.source === 'strava') {
      score += 20
    }

    // HR Data is valuable for all types
    if (workout.averageHr && workout.averageHr > 0) score += 20
    if (workout.maxHr && workout.maxHr > 0) score += 5

    const dist = workout.distanceMeters ?? workout.distance
    if (dist && dist > 0) score += 5

    if (workout.elevationGain && workout.elevationGain > 0) score += 5

    // High value for having streams (time-series data)
    if (workout.streams && (Array.isArray(workout.streams) ? workout.streams.length > 0 : true)) {
      score += 50
    }

    if (workout.trainingLoad && workout.trainingLoad > 0) score += 10
    if (workout.intensity && workout.intensity > 0) score += 5

    if (workout.calories && workout.calories > 0) score += 3

    if (workout.averageSpeed && workout.averageSpeed > 0) score += 3
    if (workout.maxSpeed && workout.maxSpeed > 0) score += 2
    if (workout.averageCadence && workout.averageCadence > 0) score += 5

    // Description might contain user notes
    if (
      (workout.description && workout.description.length > 5) ||
      (workout.notes && workout.notes.length > 5)
    ) {
      score += 5
    }

    return score
  },

  /**
   * Find a potential planned workout link for a given workout
   */
  async findProposedLink(workout: any): Promise<any | null> {
    return findMatchingPlannedWorkoutForWorkout(workout)
  },

  /**
   * Executes the merge logic for a duplicate group.
   *
   * The group is computed *before* this call (see `findDuplicateGroups`, invoked
   * once per run from `trigger/deduplicate-workouts.ts`), so by the time the
   * merge transaction runs, any workout it names may already have been deleted —
   * by the user, or by a concurrent dedup/ingest path working the same workouts.
   * That is an expected concurrent-modification outcome, not a failure: the
   * group is skipped so the rest of the batch still merges, and the next run
   * recomputes the group from live rows without the deleted workout.
   */
  async mergeDuplicateGroup(group: DuplicateGroup): Promise<MergeDuplicateGroupResult> {
    if (group.toDelete.length === 0) return { deletedCount: 0, keptCount: 1 }

    const duplicatesToDelete = await prisma.workout.findMany({
      where: { id: { in: group.toDelete } },
      select: { id: true, plannedWorkoutId: true, streams: { select: { id: true } } }
    })

    // Collect planned workout IDs from duplicates
    const plannedWorkoutIds = duplicatesToDelete
      .filter((w) => w.plannedWorkoutId)
      .map((w) => w.plannedWorkoutId)

    // Get the best workout
    const bestWorkout = group.workouts.find((w) => w.id === group.bestWorkoutId)

    if (!bestWorkout) return { deletedCount: 0, keptCount: 0 }

    // MERGE LOGIC: Copy missing data from duplicates to best workout
    const updates: any = {}

    // List of fields to check for merging
    const mergeFields = [
      'tss',
      'trainingLoad',
      'intensity',
      'kilojoules',
      'trimp',
      'averageWatts',
      'maxWatts',
      'normalizedPower',
      'weightedAvgWatts',
      'averageHr',
      'maxHr',
      'averageCadence',
      'maxCadence',
      'averageSpeed',
      'maxSpeed',
      'distanceMeters',
      'elevationGain',
      'calories',
      'rpe',
      'feel',
      'description', // If best has no description, take it from duplicate
      'deviceName'
    ]

    const duplicatesList = group.workouts.filter((w) => w.id !== group.bestWorkoutId)

    for (const field of mergeFields) {
      // If best workout is missing this field (null, undefined, or 0 for numbers)
      if (
        bestWorkout[field] === null ||
        bestWorkout[field] === undefined ||
        bestWorkout[field] === 0 ||
        bestWorkout[field] === ''
      ) {
        // Find a duplicate that has this field
        const donor = duplicatesList.find(
          (w) => w[field] !== null && w[field] !== undefined && w[field] !== 0 && w[field] !== ''
        )
        if (donor) {
          updates[field] = donor[field]
          logger.log(
            `Merging field ${field} from duplicate ${donor.id} to primary ${bestWorkout.id}`
          )
        }
      }
    }

    // Special handling for plannedWorkoutId
    let plannedWorkoutToUpdateId: string | null = null
    if (!bestWorkout.plannedWorkoutId) {
      if (plannedWorkoutIds.length > 0) {
        logger.log(`Transferring planned workout link from duplicate to best workout`, {
          bestWorkoutId: group.bestWorkoutId,
          plannedWorkoutId: plannedWorkoutIds[0]
        })
        updates.plannedWorkoutId = plannedWorkoutIds[0]
        plannedWorkoutToUpdateId = plannedWorkoutIds[0] as string
      } else {
        // Use shared logic to find matching planned workout
        const matchingPlanned = await this.findProposedLink(bestWorkout)

        if (matchingPlanned) {
          logger.log(`Found matching unlinked planned workout for ${bestWorkout.id}`, {
            plannedWorkoutId: matchingPlanned.id,
            title: matchingPlanned.title
          })
          updates.plannedWorkoutId = matchingPlanned.id
          plannedWorkoutToUpdateId = matchingPlanned.id
        }
      }
    }

    // Execute all database updates in a transaction.
    //
    // No write below uses a nested relation `connect`; they set plain scalar
    // columns (`completed`/`completionStatus`, `workoutId`, `completenessScore`
    // and the merged metric fields, `isDuplicate`/`duplicateOf`) on rows selected
    // by a unique `where` — by `id`, or by the unique `workoutId` on
    // `WorkoutStream`. The one `updateMany` reports a `count` instead of raising
    // when it matches nothing. That is what keeps the `P2025` catch below narrow:
    // with no `connect`, "required record not found" can only mean the row named
    // in the `where` is gone, i.e. the group we were handed is stale.
    //
    // Ordering matters. Steps 2-4 write `bestWorkout.id` into a foreign key, so
    // if the primary workout has been deleted concurrently they fail with a
    // foreign-key violation (`P2003`) — which this catch deliberately does not
    // swallow — rather than the `P2025` that identifies the stale group. Worse,
    // the "does the primary already have streams/exercises?" guards in steps 3
    // and 4 *open* those transfer paths when the primary is gone, because its own
    // `WorkoutStream`/`WorkoutExercise` rows cascade away with it. Step 1
    // therefore runs first and makes the primary's existence a precondition
    // enforced by the `P2025` catch, before anything depends on it. This is free
    // inside an atomic block: `completenessScore` is derived from the in-memory
    // `{ ...bestWorkout, ...updates }` and reads nothing the later steps write.
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Update primary workout with merged fields and completeness score.
        //    Kept first so a deleted primary surfaces as P2025 here — see above.
        updates.completenessScore = this.calculateCompletenessScore({ ...bestWorkout, ...updates })
        await tx.workout.update({
          where: { id: group.bestWorkoutId },
          data: updates
        })

        // 2. Update planned workout status if linked
        if (plannedWorkoutToUpdateId) {
          await tx.plannedWorkout.update({
            where: { id: plannedWorkoutToUpdateId },
            data: {
              completed: true,
              completionStatus: 'COMPLETED'
            }
          })
        }

        // 3. Stream Transfer Logic
        // Check if bestWorkout already has streams in DB to avoid collision
        const existingBestStream = await tx.workoutStream.findUnique({
          where: { workoutId: bestWorkout.id },
          select: { id: true }
        })

        if (!existingBestStream) {
          // Find a donor that has streams
          const donorWithStreams = duplicatesToDelete.find((w) => w.streams)
          if (donorWithStreams) {
            logger.log(
              `Transferring streams from duplicate ${donorWithStreams.id} to best workout ${bestWorkout.id}`
            )
            await tx.workoutStream.update({
              where: { workoutId: donorWithStreams.id },
              data: { workoutId: bestWorkout.id }
            })
          }
        }

        // 4. Exercise Transfer Logic
        // Move exercise records if primary has none
        const existingBestExercises = await tx.workoutExercise.count({
          where: { workoutId: bestWorkout.id }
        })

        if (existingBestExercises === 0) {
          const donorWithExercises = duplicatesList.find(
            (w) => w.exercises && w.exercises.length > 0
          )
          if (donorWithExercises) {
            logger.log(
              `Transferring exercises from duplicate ${donorWithExercises.id} to best workout ${bestWorkout.id}`
            )
            await tx.workoutExercise.updateMany({
              where: { workoutId: donorWithExercises.id },
              data: { workoutId: bestWorkout.id }
            })
          }
        }

        // 5. Mark duplicates with both boolean and explicit link
        for (const id of group.toDelete) {
          await tx.workout.update({
            where: { id },
            data: {
              isDuplicate: true,
              duplicateOf: group.bestWorkoutId
            }
          })
        }
      })
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        // A record named by this group was deleted between group computation and
        // now: the primary workout, one of the duplicates, or the planned workout
        // being linked (`Workout.plannedWorkout` is optional and nullable, so its
        // target can disappear on its own). The transaction rolled back in full,
        // so there is nothing half-merged to repair: skip the group and let the
        // caller carry on with the rest of the batch. Retrying here would fail
        // identically — the group itself is stale — so recovery is left to the
        // next run, which recomputes groups from live rows.
        logger.warn(
          'Skipping duplicate group: a record it names was deleted while the merge was running',
          {
            bestWorkoutId: group.bestWorkoutId,
            duplicateIds: group.toDelete,
            plannedWorkoutId: plannedWorkoutToUpdateId
          }
        )
        return { deletedCount: 0, keptCount: 0, skipped: true }
      }

      throw error
    }

    // Update local bestWorkout object for consistency if needed by caller
    Object.assign(bestWorkout, updates)

    return {
      deletedCount: group.toDelete.length,
      keptCount: 1
    }
  }
}
