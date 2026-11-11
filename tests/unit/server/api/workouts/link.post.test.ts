import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getServerSession } from '../../../../../server/utils/session'
import { prisma } from '../../../../../server/utils/db'
import { getUserTimezone } from '../../../../../server/utils/date'
import { isNutritionTrackingEnabled } from '../../../../../server/utils/nutrition/feature'
import { metabolicService } from '../../../../../server/utils/services/metabolicService'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('defineRouteMeta', () => {})
vi.stubGlobal('getRouterParam', (_event: any, key: string) => _event.context.params[key])
vi.stubGlobal('readBody', async (event: any) => event.body)
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message)
  ;(error as any).statusCode = err.statusCode
  return error
})

vi.mock('../../../../../server/utils/session', () => ({
  getServerSession: vi.fn()
}))

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    workout: {
      findFirst: vi.fn()
    },
    plannedWorkout: {
      findFirst: vi.fn()
    },
    $transaction: vi.fn()
  }
}))

vi.mock('../../../../../server/utils/date', () => ({
  formatDateUTC: vi.fn((date: Date) => date.toISOString().split('T')[0]),
  formatUserDate: vi.fn((date: Date, _timezone: string) => date.toISOString().split('T')[0]),
  getUserTimezone: vi.fn()
}))

vi.mock('../../../../../server/utils/nutrition/feature', () => ({
  isNutritionTrackingEnabled: vi.fn()
}))

vi.mock('../../../../../server/utils/services/metabolicService', () => ({
  metabolicService: {
    calculateFuelingPlanForDate: vi.fn()
  }
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/workouts/[id]/link.post')
  return mod.default
}

const sameDay = '2026-03-28T12:00:00Z'

describe('POST /api/workouts/[id]/link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user-1' } } as any)
    vi.mocked(getUserTimezone).mockResolvedValue('America/Chicago')
    vi.mocked(isNutritionTrackingEnabled).mockResolvedValue(false)
  })

  it('rejects linking workouts from different local days', async () => {
    const handler = await getHandler()

    vi.mocked(prisma.workout.findFirst).mockResolvedValue({
      id: 'workout-1',
      userId: 'user-1',
      date: new Date('2026-03-28T18:22:47Z')
    } as any)
    vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue({
      id: 'planned-1',
      userId: 'user-1',
      date: new Date('2026-03-29T00:00:00Z')
    } as any)

    await expect(
      handler({
        context: { params: { id: 'workout-1' } },
        body: { plannedWorkoutId: 'planned-1' }
      } as any)
    ).rejects.toMatchObject({
      message: 'Workout and planned workout must be on the same day to link.',
      statusCode: 400
    })

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(metabolicService.calculateFuelingPlanForDate).not.toHaveBeenCalled()
  })

  it('links an unlinked workout without touching any previous plan', async () => {
    const handler = await getHandler()

    vi.mocked(prisma.workout.findFirst).mockResolvedValue({
      id: 'workout-1',
      userId: 'user-1',
      date: new Date(sameDay),
      plannedWorkoutId: null
    } as any)
    vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue({
      id: 'planned-new',
      userId: 'user-1',
      date: new Date(sameDay)
    } as any)

    const tx = {
      workout: { update: vi.fn().mockResolvedValue({}), count: vi.fn() },
      plannedWorkout: { update: vi.fn().mockResolvedValue({}) }
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    const result = await handler({
      context: { params: { id: 'workout-1' } },
      body: { plannedWorkoutId: 'planned-new' }
    } as any)

    expect(result).toEqual({ success: true })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.workout.update).toHaveBeenCalledWith({
      where: { id: 'workout-1' },
      data: { plannedWorkoutId: 'planned-new' }
    })
    expect(tx.plannedWorkout.update).toHaveBeenCalledWith({
      where: { id: 'planned-new' },
      data: { completed: true, completionStatus: 'COMPLETED' }
    })
    expect(tx.plannedWorkout.update).toHaveBeenCalledTimes(1)
    expect(tx.workout.count).not.toHaveBeenCalled()
  })

  it('reconciles the previous plan inside the existing transaction when relinking', async () => {
    const handler = await getHandler()

    vi.mocked(prisma.workout.findFirst).mockResolvedValue({
      id: 'workout-1',
      userId: 'user-1',
      date: new Date(sameDay),
      plannedWorkoutId: 'planned-old'
    } as any)
    vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue({
      id: 'planned-new',
      userId: 'user-1',
      date: new Date(sameDay)
    } as any)

    const tx = {
      workout: {
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0)
      },
      plannedWorkout: { update: vi.fn().mockResolvedValue({}) }
    }
    let transactionCalls = 0
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      transactionCalls += 1
      return cb(tx)
    })

    const result = await handler({
      context: { params: { id: 'workout-1' } },
      body: { plannedWorkoutId: 'planned-new' }
    } as any)

    expect(result).toEqual({ success: true })
    expect(transactionCalls).toBe(1)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.workout.update).toHaveBeenCalledWith({
      where: { id: 'workout-1' },
      data: { plannedWorkoutId: 'planned-new' }
    })
    expect(tx.plannedWorkout.update).toHaveBeenCalledWith({
      where: { id: 'planned-new' },
      data: { completed: true, completionStatus: 'COMPLETED' }
    })
    expect(tx.workout.count).toHaveBeenCalledWith({
      where: { plannedWorkoutId: 'planned-old', id: { not: 'workout-1' } }
    })
    expect(tx.plannedWorkout.update).toHaveBeenCalledWith({
      where: { id: 'planned-old' },
      data: { completed: false, completionStatus: 'PENDING' }
    })
    expect(tx.plannedWorkout.update).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous plan completed when other workouts remain linked to it', async () => {
    const handler = await getHandler()

    vi.mocked(prisma.workout.findFirst).mockResolvedValue({
      id: 'workout-1',
      userId: 'user-1',
      date: new Date(sameDay),
      plannedWorkoutId: 'planned-old'
    } as any)
    vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue({
      id: 'planned-new',
      userId: 'user-1',
      date: new Date(sameDay)
    } as any)

    const tx = {
      workout: {
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1)
      },
      plannedWorkout: { update: vi.fn().mockResolvedValue({}) }
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))

    const result = await handler({
      context: { params: { id: 'workout-1' } },
      body: { plannedWorkoutId: 'planned-new' }
    } as any)

    expect(result).toEqual({ success: true })
    expect(tx.workout.count).toHaveBeenCalledWith({
      where: { plannedWorkoutId: 'planned-old', id: { not: 'workout-1' } }
    })
    expect(tx.plannedWorkout.update).toHaveBeenCalledTimes(1)
    expect(tx.plannedWorkout.update).toHaveBeenCalledWith({
      where: { id: 'planned-new' },
      data: { completed: true, completionStatus: 'COMPLETED' }
    })
  })

  it('treats a repeated link to the same plan as idempotent without a transaction', async () => {
    const handler = await getHandler()

    vi.mocked(prisma.workout.findFirst).mockResolvedValue({
      id: 'workout-1',
      userId: 'user-1',
      date: new Date(sameDay),
      plannedWorkoutId: 'planned-1'
    } as any)
    vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue({
      id: 'planned-1',
      userId: 'user-1',
      date: new Date(sameDay)
    } as any)

    const result = await handler({
      context: { params: { id: 'workout-1' } },
      body: { plannedWorkoutId: 'planned-1' }
    } as any)

    expect(result).toEqual({ success: true })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(metabolicService.calculateFuelingPlanForDate).not.toHaveBeenCalled()
  })

  it('rolls back atomically when the transaction fails', async () => {
    const handler = await getHandler()

    vi.mocked(prisma.workout.findFirst).mockResolvedValue({
      id: 'workout-1',
      userId: 'user-1',
      date: new Date(sameDay),
      plannedWorkoutId: 'planned-old'
    } as any)
    vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue({
      id: 'planned-new',
      userId: 'user-1',
      date: new Date(sameDay)
    } as any)

    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('tx failed'))

    await expect(
      handler({
        context: { params: { id: 'workout-1' } },
        body: { plannedWorkoutId: 'planned-new' }
      } as any)
    ).rejects.toMatchObject({
      message: 'Failed to link workouts',
      statusCode: 500
    })

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(metabolicService.calculateFuelingPlanForDate).not.toHaveBeenCalled()
  })
})
