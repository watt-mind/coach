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
    vi.resetAllMocks()
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
      workout: {
        findFirst: vi.fn(() => prisma.workout.findFirst({})),
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn()
      },
      plannedWorkout: {
        findFirst: vi.fn(() => prisma.plannedWorkout.findFirst({})),
        update: vi.fn().mockResolvedValue({})
      }
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
        findFirst: vi.fn(() => prisma.workout.findFirst({})),
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0)
      },
      plannedWorkout: {
        findFirst: vi.fn(() => prisma.plannedWorkout.findFirst({})),
        update: vi.fn().mockResolvedValue({})
      }
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
        findFirst: vi.fn(() => prisma.workout.findFirst({})),
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1)
      },
      plannedWorkout: {
        findFirst: vi.fn(() => prisma.plannedWorkout.findFirst({})),
        update: vi.fn().mockResolvedValue({})
      }
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

  it('keeps repeated links completed and refreshes nutrition', async () => {
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

    const tx = {
      workout: {
        findFirst: vi.fn(() => prisma.workout.findFirst({})),
        update: vi.fn(),
        count: vi.fn()
      },
      plannedWorkout: {
        findFirst: vi.fn(() => prisma.plannedWorkout.findFirst({})),
        update: vi.fn()
      }
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    vi.mocked(isNutritionTrackingEnabled).mockResolvedValue(true)
    const result = await handler({
      context: { params: { id: 'workout-1' } },
      body: { plannedWorkoutId: 'planned-1' }
    } as any)

    expect(result).toEqual({ success: true })
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable'
    })
    expect(tx.workout.count).not.toHaveBeenCalled()
    expect(tx.plannedWorkout.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'planned-1' },
      data: { completed: true, completionStatus: 'COMPLETED' }
    })
    expect(metabolicService.calculateFuelingPlanForDate).toHaveBeenCalledWith(
      'user-1',
      new Date(sameDay),
      { persist: true }
    )
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

    const persisted = { link: 'planned-old', oldCompleted: true, newCompleted: false }
    let staged = { ...persisted }
    const tx = {
      workout: {
        findFirst: vi.fn(() => prisma.workout.findFirst({})),
        update: vi.fn(async () => {
          staged.link = 'planned-new'
        }),
        count: vi.fn(async () => {
          expect(staged.link).toBe('planned-new')
          expect(staged.newCompleted).toBe(true)
          return 0
        })
      },
      plannedWorkout: {
        findFirst: vi.fn(() => prisma.plannedWorkout.findFirst({})),
        update: vi.fn(async ({ where }: any) => {
          if (where.id === 'planned-new') {
            staged.newCompleted = true
            return
          }
          staged.oldCompleted = false
          throw new Error('late reconciliation failure')
        })
      }
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      staged = { ...persisted }
      const result = await cb(tx)
      Object.assign(persisted, staged) // commit only after callback success
      return result
    })

    await expect(
      handler({
        context: { params: { id: 'workout-1' } },
        body: { plannedWorkoutId: 'planned-new' }
      } as any)
    ).rejects.toMatchObject({
      message: 'Failed to link workouts',
      statusCode: 500
    })

    expect(staged).toEqual({ link: 'planned-new', oldCompleted: false, newCompleted: true })
    expect(persisted).toEqual({ link: 'planned-old', oldCompleted: true, newCompleted: false })
    expect(tx.workout.update).toHaveBeenCalledTimes(1)
    expect(tx.workout.count).toHaveBeenCalledTimes(1)
    expect(tx.plannedWorkout.update).toHaveBeenCalledTimes(2)
    expect(isNutritionTrackingEnabled).not.toHaveBeenCalled()
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(metabolicService.calculateFuelingPlanForDate).not.toHaveBeenCalled()
  })
  it.each(['missing', 'foreign'])('rejects a %s target before mutation', async (kind) => {
    const handler = await getHandler()
    vi.mocked(prisma.workout.findFirst).mockResolvedValue({
      id: 'workout-1',
      userId: 'user-1',
      date: new Date(sameDay)
    } as any)
    const target = kind === 'foreign' ? { id: 'target', userId: 'user-2' } : null
    vi.mocked(prisma.plannedWorkout.findFirst).mockImplementation(async ({ where }: any) =>
      target?.id === where.id && target?.userId === where.userId ? (target as any) : null
    )
    await expect(
      handler({
        context: { params: { id: 'workout-1' } },
        body: { plannedWorkoutId: 'target' }
      } as any)
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.plannedWorkout.findFirst).toHaveBeenCalledWith({
      where: { id: 'target', userId: 'user-1' }
    })
    expect(prisma.workout.findFirst).toHaveBeenCalledWith({
      where: { id: 'workout-1', userId: 'user-1' }
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(isNutritionTrackingEnabled).not.toHaveBeenCalled()
  })

  it.each(['planned-old', 'planned-new'])(
    'uses the committed transaction link after stale preflight %s',
    async (snapshot) => {
      const handler = await getHandler()
      vi.mocked(prisma.workout.findFirst).mockResolvedValue({
        id: 'workout-1',
        userId: 'user-1',
        date: new Date(sameDay),
        plannedWorkoutId: snapshot
      } as any)
      const plan = { id: 'planned-new', userId: 'user-1', date: new Date(sameDay) }
      vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue(plan as any)
      // Transaction entry is the deterministic interleaving point: a competing
      // request has committed W -> C since preflight (including same-target preflight).
      const tx = {
        workout: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'workout-1',
            userId: 'user-1',
            date: new Date(sameDay),
            plannedWorkoutId: 'planned-C'
          }),
          update: vi.fn(),
          count: vi.fn().mockResolvedValue(0)
        },
        plannedWorkout: { findFirst: vi.fn().mockResolvedValue(plan), update: vi.fn() }
      }
      vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
      await expect(
        handler({
          context: { params: { id: 'workout-1' } },
          body: { plannedWorkoutId: 'planned-new' }
        } as any)
      ).resolves.toEqual({ success: true })
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable'
      })
      expect(tx.workout.findFirst).toHaveBeenCalledWith({
        where: { id: 'workout-1', userId: 'user-1' }
      })
      expect(tx.workout.count).toHaveBeenCalledWith({
        where: { plannedWorkoutId: 'planned-C', id: { not: 'workout-1' } }
      })
      expect(tx.plannedWorkout.update).toHaveBeenCalledWith({
        where: { id: 'planned-C' },
        data: { completed: false, completionStatus: 'PENDING' }
      })
      expect(tx.workout.update).toHaveBeenCalledWith({
        where: { id: 'workout-1' },
        data: { plannedWorkoutId: 'planned-new' }
      })
    }
  )
  it.each(['ownership', 'day'])('rejects changed transaction %s before writes', async (change) => {
    const handler = await getHandler()
    const workout = {
      id: 'workout-1',
      userId: 'user-1',
      date: new Date(sameDay),
      plannedWorkoutId: 'old'
    }
    const plan = { id: 'target', userId: 'user-1', date: new Date(sameDay) }
    vi.mocked(prisma.workout.findFirst).mockResolvedValue(workout as any)
    vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue(plan as any)
    const tx = {
      workout: { findFirst: vi.fn().mockResolvedValue(workout), update: vi.fn(), count: vi.fn() },
      plannedWorkout: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            change === 'ownership' ? null : { ...plan, date: new Date('2026-03-29T12:00:00Z') }
          ),
        update: vi.fn()
      }
    }
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => cb(tx))
    await expect(
      handler({
        context: { params: { id: 'workout-1' } },
        body: { plannedWorkoutId: 'target' }
      } as any)
    ).rejects.toMatchObject({ statusCode: change === 'ownership' ? 404 : 400 })
    expect(tx.plannedWorkout.findFirst).toHaveBeenCalledWith({
      where: { id: 'target', userId: 'user-1' }
    })
    expect(tx.workout.update).not.toHaveBeenCalled()
    expect(tx.plannedWorkout.update).not.toHaveBeenCalled()
    expect(isNutritionTrackingEnabled).not.toHaveBeenCalled()
  })

  it('keeps a committed link successful if nutrition refresh fails', async () => {
    const handler = await getHandler()
    const workout = {
      id: 'workout-1',
      userId: 'user-1',
      date: new Date(sameDay),
      plannedWorkoutId: null
    }
    const plan = { id: 'target', userId: 'user-1', date: new Date(sameDay) }
    vi.mocked(prisma.workout.findFirst).mockResolvedValue(workout as any)
    vi.mocked(prisma.plannedWorkout.findFirst).mockResolvedValue(plan as any)
    const tx = {
      workout: { findFirst: vi.fn().mockResolvedValue(workout), update: vi.fn() },
      plannedWorkout: { findFirst: vi.fn().mockResolvedValue(plan), update: vi.fn() }
    }
    let committed = false
    vi.mocked(prisma.$transaction).mockImplementation(async (cb: any) => {
      const result = await cb(tx)
      committed = true
      return result
    })
    vi.mocked(isNutritionTrackingEnabled).mockResolvedValue(true)
    vi.mocked(metabolicService.calculateFuelingPlanForDate).mockImplementation(async () => {
      expect(committed).toBe(true)
      throw new Error('refresh failed')
    })
    await expect(
      handler({
        context: { params: { id: 'workout-1' } },
        body: { plannedWorkoutId: 'target' }
      } as any)
    ).resolves.toEqual({ success: true })
    expect(tx.workout.update).toHaveBeenCalledTimes(1)
    expect(metabolicService.calculateFuelingPlanForDate).toHaveBeenCalledTimes(1)
  })
})
