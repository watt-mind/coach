import type { Integration } from '@prisma/client'
import { prisma } from './db'
import {
  updateIntervalsPlannedWorkout,
  createIntervalsPlannedWorkout,
  deleteIntervalsPlannedWorkout,
  updateIntervalsEvent,
  createIntervalsEvent,
  deleteIntervalsEvent,
  isIntervalsEventId
} from './intervals'
import { buildStructurePublishFields } from './planned-workout-structure-sync'
import { plannedWorkoutPublishRepository } from './repositories/plannedWorkoutPublishRepository'

function isIntervalsMissingEventError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Intervals API error: 404') || message.includes('Event not found')
}

function hydrateQueuedSyncPayload(payload: any) {
  if (!payload || typeof payload !== 'object') return payload

  const hydrated = { ...payload }
  if (typeof hydrated.date === 'string') {
    const parsed = new Date(hydrated.date)
    if (!Number.isNaN(parsed.getTime())) {
      hydrated.date = parsed
    }
  }

  return hydrated
}

async function resolvePlannedWorkoutStructureRevision(
  entityType: string,
  entityId: string,
  payload: any
): Promise<number | null> {
  if (entityType !== 'planned_workout') return null
  if (typeof payload?.structureRevision === 'number') return payload.structureRevision
  const current = await prisma.plannedWorkout.findUnique({
    where: { id: entityId },
    select: { structureRevision: true }
  })
  return current?.structureRevision ?? null
}

/**
 * Sync a planned workout to Intervals.icu with retry logic
 * Returns success status and any error messages
 */
export async function syncPlannedWorkoutToIntervals(
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  workoutData: any,
  userId: string
): Promise<{ success: boolean; synced: boolean; message?: string; error?: string; result?: any }> {
  try {
    // Get Intervals.icu integration
    const integration = await prisma.integration.findFirst({
      where: {
        userId,
        provider: 'intervals'
      }
    })

    if (!integration) {
      return {
        success: true,
        synced: false,
        message: 'No Intervals.icu integration found. Saved locally only.'
      }
    }

    // Attempt sync based on operation
    let result: any

    switch (operation) {
      case 'CREATE':
        if (isIntervalsEventId(workoutData.externalId)) {
          result = await updateIntervalsPlannedWorkout(
            integration,
            workoutData.externalId,
            workoutData
          )
        } else {
          result = await createIntervalsPlannedWorkout(integration, workoutData)
        }
        break
      case 'UPDATE':
        // If externalId is local (non-numeric), we can't update it on Intervals.
        if (!isIntervalsEventId(workoutData.externalId)) {
          return {
            success: true,
            synced: false,
            message: 'Skipped Intervals sync for local-only workout (non-numeric ID).'
          }
        }
        try {
          result = await updateIntervalsPlannedWorkout(
            integration,
            workoutData.externalId,
            workoutData
          )
        } catch (error) {
          if (!isIntervalsMissingEventError(error)) {
            throw error
          }

          result = await createIntervalsPlannedWorkout(integration, workoutData)
          if (workoutData.id && result?.id) {
            await prisma.plannedWorkout.update({
              where: { id: workoutData.id },
              data: {
                externalId: String(result.id),
                syncError: null
              }
            })
          }
        }
        break
      case 'DELETE':
        // If externalId is local (non-numeric), it doesn't exist on Intervals.
        if (!isIntervalsEventId(workoutData.externalId)) {
          return {
            success: true,
            synced: false,
            message: 'Local workout deleted locally. Skipped Intervals sync.'
          }
        }
        result = await deleteIntervalsPlannedWorkout(integration, workoutData.externalId)
        break
      default:
        throw new Error(`Unknown operation: ${operation}`)
    }

    if ((operation === 'CREATE' || operation === 'UPDATE') && workoutData.id && result?.id) {
      await plannedWorkoutPublishRepository.upsert(workoutData.id, 'intervals', {
        externalId: String(result.id),
        status: 'SYNCED',
        error: null,
        lastSyncedAt: new Date()
      })
    }

    return {
      success: true,
      synced: true,
      result,
      message: 'Synced to Intervals.icu successfully'
    }
  } catch (error: any) {
    console.error(`Failed to sync workout ${operation} to Intervals.icu:`, error.message)

    const structureRevision = await resolvePlannedWorkoutStructureRevision(
      'planned_workout',
      workoutData.id,
      workoutData
    )
    const payload = structureRevision === null ? workoutData : { ...workoutData, structureRevision }

    await queueSyncOperation({
      userId,
      entityType: 'planned_workout',
      entityId: workoutData.id,
      operation,
      payload,
      structureRevision,
      error: error.message
    })

    return {
      success: true,
      synced: false,
      message: 'Saved locally. Will sync to Intervals.icu automatically.',
      error: error.message
    }
  }
}

type PlannedWorkoutForAutoUpload = {
  id: string
  userId: string
  externalId: string
  date: Date
  startTime?: string | null
  title: string
  description?: string | null
  type?: string | null
  durationSec?: number | null
  tss?: number | null
  managedBy?: string | null
}

export async function autoUploadPlannedWorkoutToIntervalsIfEnabled(
  workout: PlannedWorkoutForAutoUpload
): Promise<{ attempted: boolean; synced: boolean; error?: string }> {
  const integration = await prisma.integration.findFirst({
    where: {
      userId: workout.userId,
      provider: 'intervals'
    },
    select: {
      id: true,
      settings: true
    }
  })

  if (!integration) {
    return { attempted: false, synced: false }
  }

  const settings = (integration.settings as Record<string, any> | null) || {}
  const importPlannedWorkouts = settings.importPlannedWorkouts !== false

  if (!importPlannedWorkouts) {
    return { attempted: false, synced: false }
  }

  const syncResult = await syncPlannedWorkoutToIntervals(
    'CREATE',
    {
      id: workout.id,
      externalId: workout.externalId,
      date: workout.date,
      startTime: workout.startTime || undefined,
      title: workout.title,
      description: workout.description || '',
      type: workout.type || 'Ride',
      durationSec: workout.durationSec || 3600,
      tss: workout.tss ?? undefined,
      managedBy: workout.managedBy || undefined
    },
    workout.userId
  )

  await prisma.plannedWorkout.update({
    where: { id: workout.id },
    data: {
      syncStatus: syncResult.synced ? 'SYNCED' : 'PENDING',
      lastSyncedAt: syncResult.synced ? new Date() : undefined,
      syncError: syncResult.error || null,
      ...(syncResult.synced &&
        syncResult.result?.id && {
          externalId: String(syncResult.result.id)
        })
    }
  })

  return {
    attempted: true,
    synced: syncResult.synced,
    error: syncResult.error
  }
}

/**
 * Sync a racing event to Intervals.icu with retry logic
 */
export async function syncEventToIntervals(
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  eventData: any,
  userId: string
): Promise<{ success: boolean; synced: boolean; message?: string; error?: string; result?: any }> {
  try {
    const integration = await prisma.integration.findFirst({
      where: { userId, provider: 'intervals' }
    })

    if (!integration) {
      return {
        success: true,
        synced: false,
        message: 'No Intervals.icu integration found. Saved locally only.'
      }
    }

    let result: any

    switch (operation) {
      case 'CREATE':
        result = await createIntervalsEvent(integration, eventData)
        break
      case 'UPDATE':
        if (!isIntervalsEventId(eventData.externalId)) {
          return {
            success: true,
            synced: false,
            message: 'Skipped sync for local-only event.'
          }
        }
        result = await updateIntervalsEvent(integration, eventData.externalId, eventData)
        break
      case 'DELETE':
        if (!isIntervalsEventId(eventData.externalId)) {
          return {
            success: true,
            synced: false,
            message: 'Local event deleted locally. Skipped sync.'
          }
        }
        result = await deleteIntervalsEvent(integration, eventData.externalId)
        break
    }

    return {
      success: true,
      synced: true,
      result,
      message: 'Synced to Intervals.icu successfully'
    }
  } catch (error: any) {
    console.error(`Failed to sync event ${operation} to Intervals.icu:`, error.message)

    await queueSyncOperation({
      userId,
      entityType: 'racing_event',
      entityId: eventData.id,
      operation,
      payload: eventData,
      error: error.message
    })

    return {
      success: true,
      synced: false,
      message: 'Saved locally. Will sync to Intervals.icu automatically.',
      error: error.message
    }
  }
}

/**
 * Queue a sync operation for later retry
 */
export async function queueSyncOperation(data: {
  userId: string
  entityType: string
  entityId: string
  operation: string
  payload: any
  structureRevision?: number | null
  error?: string
}): Promise<void> {
  try {
    await prisma.syncQueue.create({
      data: {
        userId: data.userId,
        entityType: data.entityType,
        entityId: data.entityId,
        operation: data.operation,
        structureRevision: data.structureRevision ?? data.payload?.structureRevision ?? null,
        payload: data.payload,
        status: 'PENDING',
        error: data.error,
        attempts: 0
      }
    })
    console.log(`Queued ${data.operation} operation for ${data.entityType} ${data.entityId}`)
  } catch (error) {
    console.error('Failed to queue sync operation:', error)
    throw error
  }
}

/**
 * Process a single sync queue item
 */
export async function processSyncQueueItem(queueItem: any): Promise<boolean> {
  try {
    const queuedStructureRevision =
      typeof queueItem.structureRevision === 'number' ? queueItem.structureRevision : null
    // Never replay an old structured-workout payload after a newer local edit.
    if (
      queueItem.entityType === 'planned_workout' &&
      queueItem.operation !== 'DELETE' &&
      queuedStructureRevision !== null
    ) {
      const current = await prisma.plannedWorkout.findUnique({
        where: { id: queueItem.entityId },
        select: { structureRevision: true }
      })
      if (!current || current.structureRevision !== queuedStructureRevision) {
        await prisma.syncQueue.update({
          where: { id: queueItem.id },
          data: { status: 'SUPERSEDED', completedAt: new Date(), error: null }
        })
        return true
      }
    }
    // Get integration
    const integration = await prisma.integration.findFirst({
      where: {
        userId: queueItem.userId,
        provider: 'intervals'
      }
    })

    if (!integration) {
      // Mark as failed permanently if no integration
      await prisma.syncQueue.update({
        where: { id: queueItem.id },
        data: {
          status: 'FAILED',
          error: 'No Intervals.icu integration found',
          attempts: queueItem.attempts + 1,
          lastAttempt: new Date()
        }
      })
      return false
    }

    // Attempt sync
    const payload = hydrateQueuedSyncPayload(queueItem.payload)

    if (queueItem.entityType === 'planned_workout') {
      switch (queueItem.operation) {
        case 'CREATE': {
          const created = await createIntervalsPlannedWorkout(integration, payload)
          if (created?.id) {
            payload.externalId = String(created.id)
            await prisma.plannedWorkout.update({
              where: { id: queueItem.entityId },
              data: {
                externalId: String(created.id),
                syncError: null
              }
            })
          }
          break
        }
        case 'UPDATE':
          if (isIntervalsEventId(payload.externalId)) {
            try {
              await updateIntervalsPlannedWorkout(integration, payload.externalId, payload)
            } catch (error) {
              if (!isIntervalsMissingEventError(error)) {
                throw error
              }

              const recreated = await createIntervalsPlannedWorkout(integration, payload)
              if (recreated?.id) {
                payload.externalId = String(recreated.id)
                await prisma.plannedWorkout.update({
                  where: { id: queueItem.entityId },
                  data: {
                    externalId: String(recreated.id),
                    syncError: null
                  }
                })
              }
            }
          }
          break
        case 'DELETE':
          if (isIntervalsEventId(payload.externalId)) {
            try {
              await deleteIntervalsPlannedWorkout(integration, payload.externalId)
            } catch (error) {
              if (!isIntervalsMissingEventError(error)) throw error
            }
          }
          break
      }
    } else if (queueItem.entityType === 'racing_event') {
      switch (queueItem.operation) {
        case 'CREATE':
          await createIntervalsEvent(integration, payload)
          break
        case 'UPDATE':
          if (isIntervalsEventId(payload.externalId)) {
            await updateIntervalsEvent(integration, payload.externalId, payload)
          }
          break
        case 'DELETE':
          if (isIntervalsEventId(payload.externalId)) {
            await deleteIntervalsEvent(integration, payload.externalId)
          }
          break
      }
    }

    // Mark as completed
    await prisma.syncQueue.update({
      where: { id: queueItem.id },
      data: {
        status: 'COMPLETED',
        error: null,
        completedAt: new Date(),
        attempts: queueItem.attempts + 1,
        lastAttempt: new Date()
      }
    })

    // Update entity sync status
    if (queueItem.entityType === 'planned_workout' && queueItem.operation !== 'DELETE') {
      const publishStructure =
        payload?.structuredWorkout ||
        (
          await prisma.plannedWorkout.findUnique({
            where: { id: queueItem.entityId },
            select: { structuredWorkout: true }
          })
        )?.structuredWorkout

      await prisma.plannedWorkout.updateMany({
        where:
          queuedStructureRevision === null
            ? { id: queueItem.entityId }
            : { id: queueItem.entityId, structureRevision: queuedStructureRevision },
        data: {
          syncStatus: 'SYNCED',
          lastSyncedAt: new Date(),
          syncError: null,
          ...(publishStructure && (payload?.structuredWorkout || payload?.workout_doc)
            ? buildStructurePublishFields(publishStructure)
            : {})
        }
      })
    } else if (queueItem.entityType === 'racing_event') {
      await prisma.event.update({
        where: { id: queueItem.entityId },
        data: {
          syncStatus: 'SYNCED',
          syncError: null
        }
      })
    }

    console.log(`Successfully synced ${queueItem.entityType} ${queueItem.entityId}`)
    return true
  } catch (error: any) {
    console.error(`Failed to process sync queue item ${queueItem.id}:`, error.message)

    // Update failure count
    const newAttempts = queueItem.attempts + 1
    const maxAttempts = 3

    await prisma.syncQueue.update({
      where: { id: queueItem.id },
      data: {
        status: newAttempts >= maxAttempts ? 'FAILED' : 'PENDING',
        error: error.message,
        attempts: newAttempts,
        lastAttempt: new Date()
      }
    })

    // Update entity with error if permanently failed
    if (newAttempts >= maxAttempts) {
      if (queueItem.entityType === 'planned_workout' && queueItem.operation !== 'DELETE') {
        await prisma.plannedWorkout.updateMany({
          where: { id: queueItem.entityId },
          data: {
            syncStatus: 'FAILED',
            syncError: `Failed after ${maxAttempts} attempts: ${error.message}`
          }
        })
      } else if (queueItem.entityType === 'racing_event') {
        await prisma.event.update({
          where: { id: queueItem.entityId },
          data: {
            syncStatus: 'FAILED',
            syncError: `Failed after ${maxAttempts} attempts: ${error.message}`
          }
        })
      }
    }

    return false
  }
}
