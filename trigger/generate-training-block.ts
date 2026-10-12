import './init'
import { logger, task } from '@trigger.dev/sdk/v3'
import { generateStructuredAnalysis } from '../server/utils/gemini'
import { formatPromptHeight } from '../server/utils/ai-prompt-format'
import { prisma } from '../server/utils/db'
import { userReportsQueue } from './queues'
import {
  getUserTimezone,
  getStartOfDaysAgoUTC,
  getStartOfDayUTC,
  formatUserDate,
  getUserLocalDate,
  formatDateUTC,
  calculateAge
} from '../server/utils/date'
import { getCurrentFitnessSummary } from '../server/utils/training-stress'
import { getUserAiSettings } from '../server/utils/ai-user-settings'
import { TRAINING_BLOCK_TYPES, TRAINING_BLOCK_FOCUSES } from '../app/utils/training-constants'
import { availabilityRepository } from '../server/utils/repositories/availabilityRepository'
import { enqueuePlannedWorkoutStructureGeneration } from '../server/utils/planned-workout-structure-trigger'
import { autoUploadPlannedWorkoutToIntervalsIfEnabled } from '../server/utils/intervals-sync'
import { registerTaskHandler } from '../server/utils/task-registry'
import { normalizeGeneratedWorkoutType } from '../server/utils/plans/workout-type'
import {
  validateGeneratedBlockWeeks,
  clampGeneratedBlockWeeks,
  formatViolationsFeedback,
  type WeekVolumeTarget
} from '../server/utils/plans/block-volume'

const trainingBlockSchema = {
  type: 'object',
  properties: {
    weeks: {
      type: 'array',
      description: 'List of training weeks in this block',
      items: {
        type: 'object',
        properties: {
          weekNumber: { type: 'integer', description: '1-based index within the block' },
          focus_key: {
            type: 'string',
            description: 'Standardized key (e.g. AEROBIC_ENDURANCE, RECOVERY, VO2_MAX)'
          },
          focus_label: {
            type: 'string',
            description: 'User-facing label (e.g. "Aerobic Endurance & Skills")'
          },
          explanation: {
            type: 'string',
            description: 'Reasoning for this week structure and focus'
          },
          volumeTargetMinutes: { type: 'integer' },
          workouts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                dayOfWeek: { type: 'integer', description: '0=Sunday, 1=Monday, ..., 6=Saturday' },
                title: { type: 'string', description: "Workout title (e.g. '3x10m Sweet Spot')" },
                description: {
                  type: 'string',
                  description: 'Brief description of the workout goal'
                },
                type: {
                  type: 'string',
                  description:
                    'Type of workout. DO NOT use generic terms like "Active Recovery" - map recovery sessions to a light "Ride"/"Run" or "Rest". "Gym" means strength training.',
                  enum: ['Ride', 'Run', 'Swim', 'Gym', 'Rest']
                },
                durationMinutes: { type: 'integer' },
                tssEstimate: { type: 'integer' },
                intensity: {
                  type: 'string',
                  enum: ['recovery', 'easy', 'moderate', 'hard', 'very_hard'],
                  description: 'Overall intensity level'
                }
              },
              required: ['dayOfWeek', 'title', 'type', 'durationMinutes', 'intensity']
            }
          }
        },
        required: ['weekNumber', 'workouts']
      }
    }
  },
  required: ['weeks']
}

export async function runGenerateTrainingBlock(payload: {
  userId: string
  blockId: string
  anchorWorkoutIds?: string[]
  triggerStructureForWeekNumber?: number
}) {
  const { userId, blockId, anchorWorkoutIds, triggerStructureForWeekNumber } = payload

  logger.log('Starting training block generation', {
    userId,
    blockId,
    anchorWorkoutIds,
    triggerStructureForWeekNumber
  })

  const timezone = await getUserTimezone(userId)
  const aiSettings = await getUserAiSettings(userId)
  const now = new Date()
  const localDate = formatUserDate(now, timezone)
  const userLocalToday = getUserLocalDate(timezone)

  // 1. Fetch Context
  const block = await prisma.trainingBlock.findUnique({
    where: { id: blockId },
    include: {
      plan: {
        include: {
          goal: {
            include: { events: true }
          },
          blocks: {
            orderBy: { order: 'asc' },
            select: {
              id: true,
              order: true,
              name: true,
              type: true,
              durationWeeks: true,
              primaryFocus: true
            }
          }
        }
      },
      weeks: {
        select: {
          weekNumber: true,
          volumeTargetMinutes: true,
          tssTarget: true,
          isRecovery: true
        },
        orderBy: { weekNumber: 'asc' }
      }
    }
  })

  if (!block) throw new Error('Block not found')
  const goal = block.plan.goal
  if (!goal) throw new Error('Training plan goal not found')

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ftp: true,
      weight: true,
      weightUnits: true,
      height: true,
      heightUnits: true,
      maxHr: true,
      aiPersona: true,
      dob: true,
      sex: true,
      language: true
    }
  })
  const availability = await availabilityRepository.getFullSchedule(userId)
  const availabilitySummary = availabilityRepository.formatForPrompt(availability)

  const userAge = calculateAge(user?.dob)
  logger.log('[GenerateBlock] Block fetched', {
    name: block.name,
    durationWeeks: block.durationWeeks,
    startDate: block.startDate
  })

  // Fetch Anchored Workouts
  const anchoredWorkouts = anchorWorkoutIds?.length
    ? await prisma.plannedWorkout.findMany({
        where: {
          id: { in: anchorWorkoutIds },
          userId
        },
        select: {
          id: true,
          date: true,
          title: true,
          type: true,
          durationSec: true,
          tss: true
        }
      })
    : []

  // Fetch latest athlete profile
  const athleteProfileReport = await prisma.report.findFirst({
    where: {
      userId,
      type: 'ATHLETE_PROFILE',
      status: 'COMPLETED'
    },
    orderBy: { createdAt: 'desc' },
    select: { analysisJson: true, createdAt: true }
  })

  let athleteProfileContext = ''
  if (athleteProfileReport?.analysisJson) {
    const profile = athleteProfileReport.analysisJson as any
    athleteProfileContext = `
DETAILED ATHLETE ANALYSIS (Generated ${formatUserDate(athleteProfileReport.createdAt, timezone)}):
Training Characteristics:
${profile.training_characteristics?.training_style || 'No data'}
Strengths: ${profile.training_characteristics?.strengths?.join(', ') || 'None listed'}
Areas for Development: ${profile.training_characteristics?.areas_for_development?.join(', ') || 'None listed'}

Recovery Profile: ${profile.recovery_profile?.recovery_pattern || 'Unknown'}
${profile.recovery_profile?.key_observations ? profile.recovery_profile.key_observations.map((o: string) => `- ${o}`).join('\n') : ''}

Recent Performance Trend: ${profile.recent_performance?.trend || 'Unknown'}

Planning Context:
${profile.planning_context?.current_focus ? `Current Focus: ${profile.planning_context.current_focus}` : ''}
${profile.planning_context?.limitations?.length ? `Limitations: ${profile.planning_context.limitations.join(', ')}` : ''}
${profile.planning_context?.opportunities?.length ? `Opportunities: ${profile.planning_context.opportunities.join(', ')}` : ''}
`
  }

  const currentFitness = await getCurrentFitnessSummary(userId, undefined, {
    adjustForTodayUncompletedPlannedTSS: true,
    timezone
  })

  // 2. Prepare Context Data
  // Map existing weeks to get volume targets before we delete them
  const volumeTargets = block.weeks
    .map((w) => `Week ${w.weekNumber}: ${w.volumeTargetMinutes} mins (TSS ~${w.tssTarget})`)
    .join('\n')

  // Calculate Global Week Context
  let globalWeekStart = 1
  for (const b of block.plan.blocks) {
    if (b.id === block.id) break
    globalWeekStart += b.durationWeeks
  }
  const globalWeekEnd = globalWeekStart + block.durationWeeks - 1
  const totalPlanWeeks = block.plan.blocks.reduce((sum, b) => sum + b.durationWeeks, 0)

  const planOverview = block.plan.blocks
    .map(
      (b) =>
        `${b.order}. ${b.name} (${b.type}): ${b.durationWeeks} weeks - Focus: ${b.primaryFocus}${b.id === block.id ? ' [CURRENT]' : ''}`
    )
    .join('\n')

  const weekSchedules: {
    weekNumber: number
    startDate: Date
    endDate: Date
    validDays: Date[]
  }[] = []
  // Force to UTC midnight to ensure calendar stability
  const rawCursor = new Date(block.startDate)
  let currentCursor = new Date(
    Date.UTC(rawCursor.getUTCFullYear(), rawCursor.getUTCMonth(), rawCursor.getUTCDate())
  )
  let calendarContext = ''

  for (let i = 0; i < block.durationWeeks; i++) {
    const weekStart = new Date(currentCursor)

    // Always use strict 7-day weeks to match initialization logic
    const weekEnd = new Date(weekStart)
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6)

    // Generate valid days
    const validDays = []
    const loopDate = new Date(weekStart)

    const todayStr = formatUserDate(userLocalToday, timezone)

    // Iterate through exactly 7 days
    for (let d = 0; d < 7; d++) {
      const dateStr = formatDateUTC(loopDate)
      if (dateStr >= todayStr) {
        validDays.push(new Date(loopDate))
      }
      loopDate.setUTCDate(loopDate.getUTCDate() + 1)
    }

    weekSchedules.push({
      weekNumber: i + 1,
      startDate: weekStart,
      endDate: weekEnd,
      validDays
    })

    // Format for Prompt
    const daysText = validDays
      .map((d) => {
        const dayName = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
        const dStr = formatDateUTC(d)
        return `${dayName} (${dStr})`
      })
      .join(', ')

    calendarContext += `Week ${i + 1} (${formatDateUTC(weekStart)} to ${formatDateUTC(weekEnd)}): ${daysText || 'All days in this week are in the past. Provide focus/explanation but NO workouts.'}\n`

    // Next week starts next day
    currentCursor = new Date(weekEnd)
    currentCursor.setUTCDate(currentCursor.getUTCDate() + 1)
  }

  logger.log('[GenerateBlock] Calendar schedules generated', { count: weekSchedules.length })

  // 3. Build Prompt
  const rhythmLabel =
    {
      2: '1:1 (Return to Play)',
      3: '2:1 (Masters/High-Stress)',
      4: '3:1 (Standard)',
      5: '4:1 (Professional)'
    }[block.plan.recoveryRhythm as 2 | 3 | 4 | 5] || '3:1 (Standard)'

  const eventsList =
    goal.events && goal.events.length > 0
      ? goal.events
          .map((e: any) => `- ${e.title}: ${formatDateUTC(e.date)} (${e.type || 'Race'})`)
          .join('\n')
      : `- Primary Event Date: ${formatUserDate(goal.eventDate || block.plan.targetDate || new Date(), timezone)}`

  const allowedTypes = (block.plan as any).activityTypes || ['Ride']
  const allowedTypesString = Array.isArray(allowedTypes) ? allowedTypes.join(', ') : 'Ride'

  const allowedBlockTypes = TRAINING_BLOCK_TYPES.map((t) => `- ${t.value}: ${t.description}`).join(
    '\n'
  )
  const allowedFocuses = TRAINING_BLOCK_FOCUSES.map((f) => `- ${f.value}: ${f.description}`).join(
    '\n'
  )

  const customInstructions = (block.plan as any).customInstructions || ''

  const prompt = `You are a **${aiSettings.aiPersona}** expert endurance coach designing a specific mesocycle (training block) for an athlete.
Adapt your tone and structure reasoning to match your **${aiSettings.aiPersona}** persona.
Preferred Language: ${user?.language || 'English'} (CRITICAL: ALL labels, explanations, reasoning, and workout descriptions MUST be written in this language)

CURRENT CONTEXT:
- Date: ${localDate}
- Timezone: ${timezone}

ATHLETE PROFILE:
- Age: ${userAge || 'Unknown'}
- Sex: ${user?.sex || 'Unknown'}
- Height: ${formatPromptHeight(user?.height, user?.heightUnits)}
- FTP: ${user?.ftp || 'Unknown'} W
- Weight: ${user?.weight || 'Unknown'} ${user?.weightUnits === 'Pounds' ? 'lbs' : 'kg'}
- Coach Persona: ${aiSettings.aiPersona}
- Allowed Workout Types: ${allowedTypesString} (ONLY schedule these types + Rest/Recovery)
${athleteProfileContext}

CURRENT FITNESS STATUS (Source of Truth):
- CTL (Fitness): ${currentFitness.ctl.toFixed(1)}
- ATL (Fatigue): ${currentFitness.atl.toFixed(1)}
- TSB (Form): ${currentFitness.tsb.toFixed(1)}
- Status: ${currentFitness.formStatus.description}

${
  customInstructions
    ? `ATHLETE CUSTOM INSTRUCTIONS & CONSTRAINTS (IMPORTANT):
${customInstructions}
NOTE: These instructions take precedence over "Allowed Workout Types" or standard scheduling rules. If the athlete asks for a specific workout type not listed above, include it.
`
    : ''
}
TRAINING GOAL:
- Goal Title: ${goal.title}
- Events:
${eventsList}
- Strategy: ${block.plan.strategy}

TRAINING PLAN OVERVIEW (Macrocycle):
Total Duration: ${totalPlanWeeks} weeks
Training Rhythm: ${rhythmLabel}
${planOverview}

CURRENT BLOCK CONTEXT:
- Block Name: "${block.name}"
- Phase Type: ${block.type} (e.g. Base, Build, Peak)
- Primary Focus: ${block.primaryFocus}
- Duration: ${block.durationWeeks} weeks
- Global Timeline: Weeks ${globalWeekStart}-${globalWeekEnd} of ${totalPlanWeeks}
- Start Date: ${formatUserDate(block.startDate, timezone)}
- Progression Logic: ${block.progressionLogic || 'Standard linear progression'}
- Recovery Week: Week ${block.recoveryWeekIndex || block.plan.recoveryRhythm} is a recovery week.

VOLUME TARGETS (Baseline from Plan Wizard):
${volumeTargets}
*These are HARD weekly duration budgets chosen by the athlete. The sum of all workout durations in a week MUST be within ±10% of that week's target. Never exceed it, and reduce recovery weeks accordingly.*

WEEKLY SCHEDULE CONSTRAINTS (Explicit Dates):
${calendarContext}
*Strictly follow this schedule. Only generate workouts for the days listed above for each week. If a week has "No valid training days", generate an empty week or rest.*

TRAINING AVAILABILITY (when athlete can train):
${availabilitySummary || 'No availability set - assume flexible schedule'}
*Availability slots are windows when the athlete CAN train — they are NOT sessions to fill. Schedule only as many sessions as the weekly volume budget allows; most days should use at most one slot.*

LOCKED/ANCHOR WORKOUTS (DO NOT CHANGE OR REPLACE):
${
  anchoredWorkouts.length > 0
    ? anchoredWorkouts
        .map(
          (w) =>
            `- ${formatDateUTC(w.date)}: ${w.title} (${w.type}, ${Math.round((w.durationSec || 0) / 60)}min) - KEEP THIS.`
        )
        .join('\n')
    : 'None'
}

INSTRUCTIONS:
Generate a detailed daily training plan for each week in this block (${block.durationWeeks} weeks).
- **TRAINING RHYTHM**: The athlete is on a ${block.plan.recoveryRhythm === 3 ? '2:1' : '3:1'} rhythm. 
  - For LOADING weeks: Focus on progressive overload, increasing difficulty slightly each week.
  - For RECOVERY weeks: Focus on shedding fatigue with significantly reduced volume and low intensity.
- **LOAD PROGRESSION CAPS**:
  - Keep week-to-week load increases conservative unless athlete context strongly supports aggressive loading.
  - Prioritize sustainable progression over maximal overload.
- **WEEK NUMBERING**: You MUST use block-relative week numbers (1, 2, 3...) in your response, matching the numbering in the "WEEKLY SCHEDULE CONSTRAINTS" below.
- **RESPECT LOCKED WORKOUTS**: You MUST include the "LOCKED/ANCHOR WORKOUTS" in your plan on their specific days. Do not schedule conflicting workouts on those days unless it's a multi-session day. Account for their TSS.
- **RESPECT AVAILABILITY**: Do not schedule sessions on days marked as rest day or outside declared slots, unless athlete custom instructions explicitly override this.
- **B-RACE HANDLING**: If the block focus includes "_WITH_RACE", implement a "Mini-Taper" on the 2 days prior to the race date while maintaining the overall block goal.
- ONLY use the "Allowed Workout Types" listed above, UNLESS the athlete's custom instructions explicitly request otherwise (Custom Instructions take precedence).
- Ensure progressive overload from week 1 to ${block.durationWeeks - 1}.
- Ensure the recovery week (if applicable) has clearly reduced volume and intensity versus prior loading weeks.
- Quantify recovery intent in your rationale (what was reduced and why).
- For "Ride" workouts, provide realistic TSS estimates based on duration and intensity.
- Workout types: ${allowedTypesString}, Rest. DO NOT use generic types like "Active Recovery" - map recovery sessions to a light Ride/Run or Rest.
- Start each week on a Monday.
- Provide a summary for each week explaining the focus and volume.
- Explicitly connect each week focus to event demands and phase goals (base/build/peak/taper).
- Manage hard session spacing to avoid clustering high neuromuscular and metabolic stress on consecutive days.
- **Weekly Focus Details:**
  - focus_key: MUST be selected from the "ALLOWED FOCUS KEYS" list below.
  - focus_label: A friendly, descriptive title for the week.

ALLOWED FOCUS KEYS:
${allowedFocuses}

ALLOWED BLOCK TYPES:
${allowedBlockTypes}

OUTPUT FORMAT:
Return valid JSON matching the schema provided.`

  // 4. Generate with Gemini
  logger.log(`[GenerateBlock] Prompting Gemini (${aiSettings.aiModelPreference})...`, {
    blockId,
    userId
  })
  const generateWeeks = (promptText: string) =>
    generateStructuredAnalysis<any>(promptText, trainingBlockSchema, aiSettings.aiModelPreference, {
      userId,
      operation: 'generate_training_block',
      entityType: 'TrainingBlock',
      entityId: blockId
    })

  const result = await generateWeeks(prompt)

  // 5. Persist Results
  if (!result.weeks || result.weeks.length === 0) {
    throw new Error('AI returned no weeks for the block')
  }

  // 4.5 Validate the generated schedule against the wizard's weekly volume budgets.
  // One corrective retry; if the model still over-schedules, clamp deterministically
  // so a week can never persist at a multiple of the athlete's chosen volume. (CW-316)
  const weekTargets: WeekVolumeTarget[] = weekSchedules.map((schedule) => {
    const original = block.weeks.find((w) => w.weekNumber === schedule.weekNumber)
    return {
      weekNumber: schedule.weekNumber,
      volumeTargetMinutes: original?.volumeTargetMinutes ?? null,
      isRecovery: original?.isRecovery,
      allowedDaysOfWeek: schedule.validDays.map((d) => d.getUTCDay())
    }
  })

  let volumeViolations = validateGeneratedBlockWeeks(result.weeks, weekTargets)
  if (volumeViolations.length > 0) {
    logger.warn('[GenerateBlock] Generated weeks violate volume budgets, retrying with feedback', {
      blockId,
      violations: volumeViolations.map((v) => v.message)
    })

    const retry = await generateWeeks(`${prompt}\n\n${formatViolationsFeedback(volumeViolations)}`)
    if (retry.weeks && retry.weeks.length > 0) {
      result.weeks = retry.weeks
      volumeViolations = validateGeneratedBlockWeeks(result.weeks, weekTargets)
    }

    if (volumeViolations.length > 0) {
      const { weeks: clampedWeeks, adjustments } = clampGeneratedBlockWeeks(
        result.weeks,
        weekTargets
      )
      result.weeks = clampedWeeks
      logger.warn('[GenerateBlock] Retry still over budget - clamped weeks deterministically', {
        blockId,
        adjustments
      })
    }
  }

  logger.log('Persisting generated plan...', { weeksCount: result.weeks.length })

  const workoutIdsToStructure: string[] = []
  const createdExternalIds: string[] = []

  try {
    await prisma.$transaction(
      async (tx) => {
        // Verify block still exists (it might have been deleted while Gemini was thinking)
        const currentBlock = await tx.trainingBlock.findUnique({
          where: { id: blockId },
          select: { id: true }
        })

        if (!currentBlock) {
          logger.warn('[GenerateBlock] Block was deleted during generation, skipping persistence', {
            blockId
          })
          return
        }

        // Clear existing
        const existingWeeks = await tx.trainingWeek.findMany({
          where: { blockId },
          select: { id: true }
        })

        const weekIds = existingWeeks.map((w) => w.id)

        if (weekIds.length > 0) {
          await tx.plannedWorkout.updateMany({
            where: { id: { in: anchorWorkoutIds || [] }, trainingWeekId: { in: weekIds } },
            data: { trainingWeekId: null }
          })
          await tx.plannedWorkout.updateMany({
            where: {
              trainingWeekId: { in: weekIds },
              id: { notIn: anchorWorkoutIds || [] },
              managedBy: 'USER'
            },
            data: { trainingWeekId: null }
          })
          await tx.plannedWorkout.deleteMany({
            where: {
              trainingWeekId: { in: weekIds },
              id: { notIn: anchorWorkoutIds || [] },
              managedBy: { not: 'USER' }
            }
          })
          await tx.trainingWeek.deleteMany({ where: { blockId } })
        }

        // 5. Create New Weeks
        for (let i = 0; i < weekSchedules.length; i++) {
          const schedule = weekSchedules[i]
          if (!schedule) continue
          const globalWeekNumber = globalWeekStart + i

          // Find AI data for this specific week
          // Support: Block-relative (1-based), Global (1-based), or Fallback to array index
          const weekData =
            result.weeks.find((w: any) => Number(w.weekNumber) === schedule.weekNumber) ||
            result.weeks.find((w: any) => Number(w.weekNumber) === globalWeekNumber) ||
            result.weeks[i] // Last resort: assume same order

          // Validate Focus Key
          let focusKey = (weekData?.focus_key || '').toUpperCase()
          const isValidKey = TRAINING_BLOCK_FOCUSES.some((f) => f.value === focusKey)
          if (!isValidKey) focusKey = block.primaryFocus.split('_WITH_RACE')[0]

          const focusLabel = weekData?.focus_label || weekData?.focus_key || 'Training Week'

          // Wizard-defined targets are the source of truth; the AI's self-reported
          // volume target can silently diverge from what it actually scheduled. (CW-316)
          const originalWeek = block.weeks.find((w) => w.weekNumber === schedule.weekNumber)

          const createdWeek = await tx.trainingWeek.create({
            data: {
              blockId,
              weekNumber: schedule.weekNumber,
              startDate: schedule.startDate,
              endDate: schedule.endDate,
              focus: focusLabel,
              focusKey: focusKey,
              focusLabel: focusLabel,
              explanation: weekData?.explanation || 'Weekly progression.',
              volumeTargetMinutes:
                originalWeek?.volumeTargetMinutes || weekData?.volumeTargetMinutes || 0,
              tssTarget:
                weekData?.workouts?.reduce(
                  (acc: number, w: any) => acc + (w.tssEstimate || 0),
                  0
                ) || 0,
              isRecovery:
                originalWeek?.isRecovery ?? (focusKey === 'RECOVERY' || focusKey === 'TAPER')
            }
          })

          if (!weekData) {
            logger.warn('[GenerateBlock] No AI data found for week, created skeleton only', {
              weekNumber: schedule.weekNumber,
              globalWeekNumber
            })
            continue
          }

          if (anchorWorkoutIds?.length && anchoredWorkouts.length > 0) {
            const weekAnchors = anchoredWorkouts.filter((anchor) => {
              const anchorDateStr = formatDateUTC(anchor.date)
              return schedule.validDays.some((d) => formatDateUTC(d) === anchorDateStr)
            })
            if (weekAnchors.length > 0) {
              await tx.plannedWorkout.updateMany({
                where: { id: { in: weekAnchors.map((w) => w.id) } },
                data: { trainingWeekId: createdWeek.id }
              })
            }
          }

          if (weekData.workouts && Array.isArray(weekData.workouts)) {
            const workoutsToCreate = weekData.workouts
              .map((workout: any, index: number) => {
                const targetDate = schedule.validDays.find(
                  (d) => d.getUTCDay() === workout.dayOfWeek
                )
                if (!targetDate) return null

                if (anchorWorkoutIds?.length) {
                  const targetDateStr = formatDateUTC(targetDate)
                  const hasAnchor = anchoredWorkouts.some(
                    (anchor) => formatDateUTC(anchor.date) === targetDateStr
                  )
                  if (hasAnchor) return null
                }

                return {
                  userId,
                  trainingWeekId: createdWeek.id,
                  date: targetDate,
                  title: workout.title,
                  description: workout.description,
                  type: normalizeGeneratedWorkoutType(workout.type),
                  durationSec: (workout.durationMinutes || 0) * 60,
                  tss: workout.tssEstimate,
                  workIntensity: getIntensityScore(workout.intensity),
                  externalId: `ai-gen-${createdWeek.id}-${workout.dayOfWeek}-${index}-${Date.now()}`,
                  category: 'WORKOUT',
                  managedBy: 'COACH_WATTS',
                  syncStatus: 'LOCAL_ONLY'
                }
              })
              .filter((w: any) => w !== null)

            if (workoutsToCreate.length > 0) {
              await tx.plannedWorkout.createMany({ data: workoutsToCreate })
              createdExternalIds.push(...workoutsToCreate.map((workout) => workout.externalId))

              if (triggerStructureForWeekNumber === schedule.weekNumber) {
                const justCreated = await tx.plannedWorkout.findMany({
                  where: {
                    trainingWeekId: createdWeek.id,
                    managedBy: 'COACH_WATTS',
                    type: { notIn: ['Rest', 'Active Recovery'] }
                  },
                  select: { id: true }
                })
                workoutIdsToStructure.push(...justCreated.map((w) => w.id))
              }
            }
          }
        }
      },
      { timeout: 40000 }
    )

    // Publish only this generation's new rows, after the entire block is committed.
    // Structure generation is optional and must not gate calendar delivery.
    if (createdExternalIds.length > 0) {
      const createdWorkouts = await prisma.plannedWorkout
        .findMany({
          where: {
            userId,
            externalId: { in: createdExternalIds },
            type: { not: 'Rest' }
          },
          select: {
            id: true,
            userId: true,
            externalId: true,
            date: true,
            startTime: true,
            title: true,
            description: true,
            type: true,
            durationSec: true,
            tss: true,
            managedBy: true
          }
        })
        .catch((error: unknown) => {
          logger.warn(
            '[GenerateBlock] Failed to read committed workouts for Intervals auto-upload',
            {
              blockId,
              error: error instanceof Error ? error.message : String(error)
            }
          )
          return []
        })

      for (const workout of createdWorkouts) {
        try {
          await autoUploadPlannedWorkoutToIntervalsIfEnabled(workout)
        } catch (error) {
          // Provider failures normally enter the helper's retry queue. An unexpected
          // upload error must not cause a retry of already committed block generation.
          logger.warn('[GenerateBlock] Failed to auto-upload planned workout to Intervals', {
            blockId,
            workoutId: workout.id,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }

    const structureFailures: Array<{ workoutId: string; error: string }> = []
    if (workoutIdsToStructure.length > 0) {
      logger.log(
        `[GenerateBlock] Triggering structure generation for ${workoutIdsToStructure.length} workouts`,
        {
          userId,
          blockId
        }
      )
      for (const workoutId of workoutIdsToStructure) {
        const queued = await enqueuePlannedWorkoutStructureGeneration({
          userId,
          plannedWorkoutId: workoutId,
          source: 'block'
        })
        if (queued.status === 'failed') {
          structureFailures.push({ workoutId, error: queued.error })
        }
      }
      if (structureFailures.length > 0) {
        logger.warn('[GenerateBlock] Some structure generation jobs failed to enqueue', {
          blockId,
          failureCount: structureFailures.length,
          structureFailures
        })
      }
    }

    logger.log('[GenerateBlock] Transaction and sub-tasks queued successfully', { blockId })

    return {
      success: true,
      blockId,
      structure_failures: structureFailures.length > 0 ? structureFailures : undefined
    }
  } catch (dbErr: any) {
    logger.error('[GenerateBlock] DB Transaction Failed', {
      error: dbErr.message,
      stack: dbErr.stack,
      blockId
    })
    throw dbErr
  }
}

registerTaskHandler('generate-training-block', runGenerateTrainingBlock)

export const generateTrainingBlockTask = task({
  id: 'generate-training-block',
  queue: userReportsQueue,
  maxDuration: 600, // 10 minutes for complex block generation
  run: (payload: {
    userId: string
    blockId: string
    anchorWorkoutIds?: string[]
    triggerStructureForWeekNumber?: number
  }) => runGenerateTrainingBlock(payload)
})

function getIntensityScore(intensity: string): number {
  switch (intensity) {
    case 'recovery':
      return 0.3
    case 'easy':
      return 0.5
    case 'moderate':
      return 0.7
    case 'hard':
      return 0.85
    case 'very_hard':
      return 0.95
    default:
      return 0.5
  }
}
