import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAuth } from '../../../../../server/utils/auth-guard'
import { prisma } from '../../../../../server/utils/db'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', () => {})
vi.stubGlobal('readBody', async (event: any) => event.body)
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message)
  ;(error as any).statusCode = err.statusCode
  return error
})

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: vi.fn()
}))

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    goal: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    event: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn()
    }
  }
}))

const getHandler = async () => (await import('../../../../../server/api/goals/[id].patch')).default

const ownedGoal = {
  id: 'goal-1',
  userId: 'attacker-1',
  events: []
}

describe('PATCH /api/goals/:id event IDOR', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'attacker-1' } as any)
    vi.mocked(prisma.goal.findUnique).mockResolvedValue(ownedGoal as any)
  })

  it('rejects foreign eventIds and never updates the goal', async () => {
    const handler = await getHandler()
    vi.mocked(prisma.event.findMany).mockResolvedValue([])

    await expect(
      handler({
        context: { params: { id: 'goal-1' } },
        body: { eventIds: ['victim-event-1'] }
      } as any)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not authorized to link one or more events'
    })

    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['victim-event-1'] },
        userId: 'attacker-1'
      },
      select: { id: true }
    })
    expect(prisma.goal.update).not.toHaveBeenCalled()
  })

  it('rejects when eventIds mixes owned and foreign ids', async () => {
    const handler = await getHandler()
    vi.mocked(prisma.event.findMany).mockResolvedValue([{ id: 'owned-event-1' }] as any)

    await expect(
      handler({
        context: { params: { id: 'goal-1' } },
        body: { eventIds: ['owned-event-1', 'victim-event-1'] }
      } as any)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not authorized to link one or more events'
    })

    expect(prisma.goal.update).not.toHaveBeenCalled()
  })

  it('rejects a foreign eventId and never updates the goal', async () => {
    const handler = await getHandler()
    vi.mocked(prisma.event.findMany).mockResolvedValue([])

    await expect(
      handler({
        context: { params: { id: 'goal-1' } },
        body: { eventId: 'victim-event-1' }
      } as any)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Not authorized to link one or more events'
    })

    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['victim-event-1'] },
        userId: 'attacker-1'
      },
      select: { id: true }
    })
    expect(prisma.goal.update).not.toHaveBeenCalled()
  })

  it('links owned eventIds after ownership verification', async () => {
    const handler = await getHandler()
    vi.mocked(prisma.event.findMany).mockResolvedValue([
      { id: 'owned-event-1' },
      { id: 'owned-event-2' }
    ] as any)
    vi.mocked(prisma.goal.update).mockResolvedValue({
      id: 'goal-1',
      userId: 'attacker-1'
    } as any)

    await expect(
      handler({
        context: { params: { id: 'goal-1' } },
        body: { eventIds: ['owned-event-1', 'owned-event-2'] }
      } as any)
    ).resolves.toMatchObject({
      success: true,
      goal: { id: 'goal-1' }
    })

    expect(prisma.goal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: expect.objectContaining({
        events: {
          set: [{ id: 'owned-event-1' }, { id: 'owned-event-2' }]
        }
      })
    })
  })
})

describe('PATCH /api/goals/:id editable fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'attacker-1' } as any)
    vi.mocked(prisma.goal.findUnique).mockResolvedValue(ownedGoal as any)
    vi.mocked(prisma.goal.update).mockResolvedValue(ownedGoal as any)
  })

  it('ignores protected scalars, raw relations, and unknown fields', async () => {
    const handler = await getHandler()
    await handler({
      context: { params: { id: 'goal-1' } },
      body: {
        title: 'Updated goal',
        id: 'replacement-id',
        userId: 'victim-1',
        createdAt: '2000-01-01',
        updatedAt: '2000-01-01',
        user: { connect: { id: 'victim-1' } },
        events: { connect: [{ id: 'victim-event-1' }] },
        trainingPlans: { create: { userId: 'victim-1' } },
        unknownField: true
      }
    } as any)

    expect(prisma.goal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { title: 'Updated goal', updatedAt: expect.any(Date) }
    })
    expect(prisma.event.findMany).not.toHaveBeenCalled()
    expect(prisma.event.create).not.toHaveBeenCalled()
    expect(prisma.event.update).not.toHaveBeenCalled()
    expect(prisma.event.upsert).not.toHaveBeenCalled()
  })

  it('preserves every editable field and converts both dates', async () => {
    const handler = await getHandler()
    const edits = {
      type: 'EVENT',
      title: 'Race goal',
      description: '',
      metric: 'distance',
      currentValue: 0,
      targetValue: 0,
      startValue: 0,
      targetDate: '2027-01-01T00:00:00.000Z',
      eventDate: '2027-01-02T00:00:00.000Z',
      eventType: 'RACE',
      status: 'ACTIVE',
      priority: 'HIGH',
      aiContext: null,
      distance: 0,
      duration: 0,
      elevation: 0,
      phase: '',
      terrain: ''
    }
    await handler({ context: { params: { id: 'goal-1' } }, body: edits } as any)

    expect(prisma.goal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: {
        ...edits,
        targetDate: new Date(edits.targetDate),
        eventDate: new Date(edits.eventDate),
        updatedAt: expect.any(Date)
      }
    })
  })

  it('preserves explicit null dates without adding omitted fields', async () => {
    const handler = await getHandler()
    await handler({
      context: { params: { id: 'goal-1' } },
      body: { targetDate: null, eventDate: null, description: null }
    } as any)
    expect(prisma.goal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { targetDate: null, eventDate: null, description: null, updatedAt: expect.any(Date) }
    })
  })

  it('links a validated owned eventId despite a raw relation payload', async () => {
    const handler = await getHandler()
    vi.mocked(prisma.event.findMany).mockResolvedValue([{ id: 'owned-event-1' }] as any)
    await handler({
      context: { params: { id: 'goal-1' } },
      body: {
        eventId: 'owned-event-1',
        events: { connect: { id: 'victim-event-1' } }
      }
    } as any)
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['owned-event-1'] }, userId: 'attacker-1' },
      select: { id: true }
    })
    expect(prisma.goal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { events: { set: [{ id: 'owned-event-1' }] }, updatedAt: expect.any(Date) }
    })
  })

  it('allows clearing event links through eventIds', async () => {
    const handler = await getHandler()
    await handler({
      context: { params: { id: 'goal-1' } },
      body: { eventIds: [] }
    } as any)
    expect(prisma.event.findMany).not.toHaveBeenCalled()
    expect(prisma.goal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { events: { set: [] }, updatedAt: expect.any(Date) }
    })
  })

  it('retains eventData upserts scoped to the authenticated user', async () => {
    const handler = await getHandler()
    vi.mocked(prisma.event.upsert).mockResolvedValue({ id: 'owned-event-1' } as any)
    await handler({
      context: { params: { id: 'goal-1' } },
      body: {
        eventData: {
          externalId: 'race-1',
          source: 'MANUAL',
          title: 'Race',
          date: '2027-01-01T00:00:00.000Z',
          userId: 'victim-1'
        },
        events: { connect: { id: 'victim-event-1' } }
      }
    } as any)
    expect(prisma.event.upsert).toHaveBeenCalledWith({
      where: {
        userId_source_externalId: {
          userId: 'attacker-1',
          source: 'MANUAL',
          externalId: 'race-1'
        }
      },
      update: expect.objectContaining({ title: 'Race', date: new Date('2027-01-01') }),
      create: expect.objectContaining({ userId: 'attacker-1', title: 'Race' })
    })
    expect(prisma.goal.update).toHaveBeenCalledWith({
      where: { id: 'goal-1' },
      data: { events: { connect: { id: 'owned-event-1' } }, updatedAt: expect.any(Date) }
    })
  })
})
