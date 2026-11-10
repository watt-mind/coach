import { prisma } from '../../utils/db'
import { requireAuth } from '../../utils/auth-guard'

defineRouteMeta({
  openAPI: {
    tags: ['Goals'],
    summary: 'Update goal',
    description: 'Updates a specific goal by ID.',
    inputSchema: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' }
      }
    ],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              currentValue: { type: 'number' },
              status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'ARCHIVED'] },
              targetDate: { type: 'string', format: 'date-time' },
              targetValue: { type: 'number' },
              aiContext: { type: 'string' },
              distance: { type: 'number' },
              elevation: { type: 'number' },
              duration: { type: 'number' },
              terrain: { type: 'string' },
              phase: { type: 'string' }
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
                success: { type: 'boolean' },
                goal: { type: 'object' }
              }
            }
          }
        }
      },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
      404: { description: 'Goal not found' }
    }
  }
})

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event, ['goal:write'])
  const userId = user.id
  const id = event.context.params?.id

  if (!id) {
    throw createError({
      statusCode: 400,
      message: 'Goal ID is required'
    })
  }

  // Verify the goal belongs to this user
  const existingGoal = await prisma.goal.findUnique({
    where: { id },
    include: { events: true }
  })

  if (!existingGoal) {
    throw createError({
      statusCode: 404,
      message: 'Goal not found'
    })
  }

  if (existingGoal.userId !== userId) {
    throw createError({
      statusCode: 403,
      message: 'Not authorized to edit this goal'
    })
  }

  const body = await readBody(event)

  // Handle Event updates
  const { eventData, eventId, eventIds } = body
  // Only editable API fields may become Prisma update data. Relations are handled below.
  const editableFields = [
    'type',
    'title',
    'description',
    'metric',
    'currentValue',
    'targetValue',
    'startValue',
    'targetDate',
    'eventDate',
    'eventType',
    'status',
    'priority',
    'aiContext',
    'distance',
    'duration',
    'elevation',
    'phase',
    'terrain'
  ] as const
  const data: any = {}
  for (const field of editableFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      data[field] = body[field]
    }
  }

  const requestedEventIds: string[] | null =
    eventIds && Array.isArray(eventIds) ? eventIds : eventId ? [eventId] : null

  if (requestedEventIds) {
    // Prevent IDOR: only the caller's events may be linked to their goal
    const uniqueEventIds = [...new Set(requestedEventIds)]
    if (uniqueEventIds.length > 0) {
      const ownedEvents = await prisma.event.findMany({
        where: {
          id: { in: uniqueEventIds },
          userId
        },
        select: { id: true }
      })

      if (ownedEvents.length !== uniqueEventIds.length) {
        throw createError({
          statusCode: 403,
          message: 'Not authorized to link one or more events'
        })
      }
    }

    data.events = {
      set: requestedEventIds.map((id) => ({ id }))
    }
  }

  if (eventData) {
    const { externalId, source, title, date, ...details } = eventData
    if (externalId && source) {
      const eventRecord = await prisma.event.upsert({
        where: {
          userId_source_externalId: {
            userId,
            source,
            externalId
          }
        },
        update: {
          title,
          date: new Date(date),
          type: details.type,
          subType: details.subType,
          distance: details.distance,
          elevation: details.elevation,
          expectedDuration: details.expectedDuration,
          terrain: details.terrain
        },
        create: {
          userId,
          externalId,
          source,
          title,
          date: new Date(date),
          type: details.type,
          subType: details.subType,
          distance: details.distance,
          elevation: details.elevation,
          expectedDuration: details.expectedDuration,
          terrain: details.terrain
        }
      })
      data.events = { connect: { id: eventRecord.id } }
    } else if (title && date) {
      // Determine which event to update
      const existingEvent = existingGoal.events[0]
      if (existingEvent) {
        await prisma.event.update({
          where: { id: existingEvent.id },
          data: {
            title,
            date: new Date(date),
            type: details.type,
            subType: details.subType,
            distance: details.distance,
            elevation: details.elevation,
            expectedDuration: details.expectedDuration,
            terrain: details.terrain
          }
        })
      } else {
        const eventRecord = await prisma.event.create({
          data: {
            userId,
            title,
            date: new Date(date),
            type: details.type,
            subType: details.subType,
            distance: details.distance,
            elevation: details.elevation,
            expectedDuration: details.expectedDuration,
            terrain: details.terrain
          }
        })
        data.events = { connect: { id: eventRecord.id } }
      }
    }
  }

  // Convert date strings to Date objects for Prisma
  if (data.targetDate && typeof data.targetDate === 'string') {
    data.targetDate = new Date(data.targetDate)
  }
  if (data.eventDate && typeof data.eventDate === 'string') {
    data.eventDate = new Date(data.eventDate)
  }
  data.updatedAt = new Date()

  try {
    const goal = await prisma.goal.update({
      where: { id },
      data
    })

    return {
      success: true,
      goal
    }
  } catch (error) {
    throw createError({
      statusCode: 500,
      message: `Failed to update goal: ${error instanceof Error ? error.message : 'Unknown error'}`
    })
  }
})
