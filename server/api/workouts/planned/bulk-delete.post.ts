import { z } from 'zod/v3'
import type { Prisma } from '@prisma/client'
import { getServerSession } from '../../../utils/session'
import { prisma } from '../../../utils/db'

const bodySchema = z.object({
  startDate: z.string().date(), // YYYY-MM-DD
  endDate: z.string().date(), // YYYY-MM-DD
  source: z.enum(['all', 'intervals', 'coach-wattz']).optional().default('all'),
  keyword: z.string().optional(), // Optional title filter
  preview: z.boolean().default(false)
})

type BulkDeleteSource = z.infer<typeof bodySchema>['source']

/**
 * Intervals.icu planned-workout IDs are strictly numeric. Local Coach Wattz
 * workouts use non-numeric IDs (ai-gen-*, ai_gen_*, adhoc-*, UUIDs and other
 * template IDs). Workouts generated locally and later synced adopt the numeric
 * Intervals ID, so the current externalId value is the source of truth.
 * Mirrors the orphan guard in intervalsService and future.delete.ts.
 */
export function isIntervalsPlannedExternalId(externalId: string): boolean {
  return /^\d+$/.test(externalId)
}

function buildTitleFilter(keyword: string | undefined) {
  return keyword ? { contains: keyword, mode: 'insensitive' as const } : undefined
}

export function buildPlannedWorkoutBaseWhere(
  userId: string,
  start: Date,
  end: Date,
  keyword?: string
): Prisma.PlannedWorkoutWhereInput {
  const where: Prisma.PlannedWorkoutWhereInput = {
    userId,
    date: {
      gte: start,
      lte: end
    }
  }
  const title = buildTitleFilter(keyword)
  if (title) {
    where.title = title
  }
  return where
}

export function buildBulkDeleteEventWhere(
  userId: string,
  start: Date,
  end: Date,
  source: BulkDeleteSource,
  keyword?: string
): Prisma.EventWhereInput {
  const where: Prisma.EventWhereInput = {
    userId,
    date: {
      gte: start,
      lte: end
    }
  }
  if (source === 'intervals') {
    where.source = 'intervals'
  } else if (source === 'coach-wattz') {
    where.source = { not: 'intervals' }
  }
  const title = buildTitleFilter(keyword)
  if (title) {
    where.title = title
  }
  return where
}

export function buildBulkDeleteNoteWhere(
  userId: string,
  start: Date,
  end: Date,
  source: BulkDeleteSource,
  keyword?: string
): Prisma.CalendarNoteWhereInput {
  const where: Prisma.CalendarNoteWhereInput = {
    userId,
    startDate: {
      gte: start,
      lte: end
    }
  }
  if (source === 'intervals') {
    where.source = 'intervals'
  } else if (source === 'coach-wattz') {
    where.source = { not: 'intervals' }
  }
  const title = buildTitleFilter(keyword)
  if (title) {
    where.title = title
  }
  return where
}

/**
 * PlannedWorkout.externalId is a required String, so Prisma has no valid
 * nullable filter for it. Source selection is applied in code against the
 * shared numeric-ID convention: numeric IDs belong to Intervals, non-numeric
 * IDs belong to Coach Wattz. `all` needs no selection step.
 */
export function selectPlannedWorkoutIdsForSource(
  rows: Array<{ id: string; externalId: string }>,
  source: BulkDeleteSource
): string[] {
  if (source === 'all') {
    return rows.map((row) => row.id)
  }
  const wantIntervals = source === 'intervals'
  return rows
    .filter((row) => isIntervalsPlannedExternalId(row.externalId) === wantIntervals)
    .map((row) => row.id)
}

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  if (!session || !session.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const body = await readValidatedBody(event, (b) => bodySchema.parse(b))
  const userId = (session.user as any).id

  // Construct Date Objects (UTC Midnight)
  const start = new Date(body.startDate)
  const end = new Date(body.endDate)
  // Set end date to end of day
  end.setHours(23, 59, 59, 999)

  // Build Filters (typed Prisma inputs — no nullable-externalId or any-cast filters)
  const plannedWorkoutWhere = buildPlannedWorkoutBaseWhere(userId, start, end, body.keyword)
  const eventWhere = buildBulkDeleteEventWhere(userId, start, end, body.source, body.keyword)
  const noteWhere = buildBulkDeleteNoteWhere(userId, start, end, body.source, body.keyword)

  const loadPlannedIdsForSource = async (): Promise<string[]> => {
    if (body.source === 'all') {
      return []
    }
    const candidates = await prisma.plannedWorkout.findMany({
      where: plannedWorkoutWhere,
      select: { id: true, externalId: true }
    })
    return selectPlannedWorkoutIdsForSource(candidates, body.source)
  }

  // Preview Mode: Just Count (same selection rules as deletion)
  if (body.preview) {
    if (body.source === 'all') {
      const [plannedWorkouts, events, notes] = await Promise.all([
        prisma.plannedWorkout.count({ where: plannedWorkoutWhere }),
        prisma.event.count({ where: eventWhere }),
        prisma.calendarNote.count({ where: noteWhere })
      ])

      return {
        success: true,
        preview: true,
        counts: {
          plannedWorkouts,
          events,
          notes,
          total: plannedWorkouts + events + notes
        }
      }
    }

    const [plannedIds, events, notes] = await Promise.all([
      loadPlannedIdsForSource(),
      prisma.event.count({ where: eventWhere }),
      prisma.calendarNote.count({ where: noteWhere })
    ])

    return {
      success: true,
      preview: true,
      counts: {
        plannedWorkouts: plannedIds.length,
        events,
        notes,
        total: plannedIds.length + events + notes
      }
    }
  }

  // Execute Deletions in Transaction (same selection rules as preview)
  try {
    const plannedDeleteWhere: Prisma.PlannedWorkoutWhereInput =
      body.source === 'all'
        ? plannedWorkoutWhere
        : { userId, id: { in: await loadPlannedIdsForSource() } }

    const [deletedWorkouts, deletedEvents, deletedNotes] = await prisma.$transaction([
      prisma.plannedWorkout.deleteMany({ where: plannedDeleteWhere }),
      prisma.event.deleteMany({ where: eventWhere }),
      prisma.calendarNote.deleteMany({ where: noteWhere })
    ])

    return {
      success: true,
      preview: false,
      deleted: {
        plannedWorkouts: deletedWorkouts.count,
        events: deletedEvents.count,
        notes: deletedNotes.count,
        total: deletedWorkouts.count + deletedEvents.count + deletedNotes.count
      }
    }
  } catch (error) {
    console.error('Bulk delete failed:', error)
    throw createError({ statusCode: 500, statusMessage: 'Failed to delete items' })
  }
})
