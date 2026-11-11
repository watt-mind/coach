import { beforeEach, describe, expect, it, vi } from 'vitest'
import { processStravaWebhookEvent } from '../../../../../server/utils/services/stravaService'

const state = vi.hoisted(() => ({ rows: [] as any[], failAt: '', streams: new Set<string>() }))
vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    $transaction: vi.fn(async (callback: any) => {
      const rows = structuredClone(state.rows)
      const matches = (row: any, where: any): boolean =>
        Object.entries(where).every(([key, value]: [string, any]) =>
          key === 'userId_source_externalId'
            ? matches(row, value)
            : value && typeof value === 'object' && 'in' in value
              ? value.in.includes(row[key])
              : row[key] === value
        )
      const tx = {
        workout: {
          findUnique: vi.fn(async ({ where }: any) => rows.find((r) => matches(r, where))),
          findMany: vi.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
          update: vi.fn(async ({ where, data }: any) => {
            if (state.failAt === 'promotion') throw new Error('injected failure')
            Object.assign(
              rows.find((r) => matches(r, where)),
              data
            )
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            if (state.failAt === 'siblings') throw new Error('injected failure')
            rows.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, data))
          }),
          delete: vi.fn(async ({ where }: any) => {
            if (state.failAt === 'delete') throw new Error('injected failure')
            const index = rows.findIndex((r) => matches(r, where))
            if (index === -1) throw new Error('missing row')
            const [deleted] = rows.splice(index, 1)
            rows.filter((r) => r.duplicateOf === deleted.id).forEach((r) => (r.duplicateOf = null))
          })
        }
      }
      const result = await callback(tx)
      state.rows = rows
      return result
    })
  }
}))
vi.mock('../../../../../server/utils/repositories/workoutStreamRepository', () => ({
  attachStreamsToWorkouts: vi.fn(async (rows: any[]) =>
    rows.map((r) => ({ ...r, streams: state.streams.has(r.id) ? { time: [0, 1] } : null }))
  )
}))
vi.mock('../../../../../server/utils/task-registry', () => ({ registerTaskHandler: vi.fn() }))
vi.mock('../../../../../server/utils/task-dispatcher', () => ({ dispatchTask: vi.fn() }))
vi.mock('../../../../../server/utils/strava', () => ({}))
vi.mock('../../../../../server/utils/repositories/workoutRepository', () => ({
  workoutRepository: {}
}))
vi.mock('../../../../../server/utils/planned-workout-linking', () => ({}))
vi.mock('../../../../../server/utils/calculate-workout-stress', () => ({}))
vi.mock('../../../../../trigger/utils/strava-stream-ingestion', () => ({}))

const copy = (id: string, fields: Record<string, any> = {}) => ({
  id,
  userId: 'user',
  source: 'garmin',
  externalId: id,
  type: 'Ride',
  isDuplicate: true,
  duplicateOf: 'primary',
  plannedWorkoutId: null,
  exercises: [],
  ...fields
})
const remove = () =>
  processStravaWebhookEvent('user', 'activity', {
    object_type: 'activity',
    aspect_type: 'delete',
    object_id: 123
  })
const row = (id: string) => state.rows.find((r) => r.id === id)

describe('Strava activity deletion duplicate promotion', () => {
  beforeEach(() => {
    state.rows = [
      copy('primary', {
        source: 'strava',
        externalId: '123',
        isDuplicate: false,
        duplicateOf: null,
        plannedWorkoutId: 'plan'
      })
    ]
    state.failAt = ''
    state.streams.clear()
  })

  it('promotes a lone survivor into normal visible queries and transfers the planned link', async () => {
    state.rows.push(copy('survivor'))
    await remove()
    expect(state.rows.filter((r) => r.isDuplicate === false).map((r) => r.id)).toEqual(['survivor'])
    expect(row('survivor')).toMatchObject({ duplicateOf: null, plannedWorkoutId: 'plan' })
  })

  it('uses hydrated stream completeness to choose the best survivor and relinks siblings', async () => {
    state.rows.push(copy('metrics', { averageWatts: 200 }), copy('stream'), copy('sibling'))
    state.streams.add('stream')
    await remove()
    expect(row('stream')).toMatchObject({ isDuplicate: false, duplicateOf: null })
    for (const id of ['metrics', 'sibling']) {
      expect(row(id)).toMatchObject({ isDuplicate: true, duplicateOf: 'stream' })
    }
  })

  it('includes structured exercises in the existing ranking', async () => {
    state.rows.push(copy('plain'), copy('strength', { exercises: [{ id: 'exercise' }] }))
    await remove()
    expect(row('strength').isDuplicate).toBe(false)
  })

  it('preserves an existing survivor planned link', async () => {
    state.rows.push(copy('survivor', { plannedWorkoutId: 'existing-plan' }))
    await remove()
    expect(row('survivor').plannedWorkoutId).toBe('existing-plan')
  })

  it('deletes a sole copy and handles missing/replayed events', async () => {
    await remove()
    expect(state.rows).toEqual([])
    expect(await remove()).toMatchObject({ handled: true, message: 'Workout 123 not found in DB' })
  })

  it('deletes a noncanonical copy without changing its primary', async () => {
    Object.assign(row('primary'), { isDuplicate: true, duplicateOf: 'canonical' })
    state.rows.push(copy('canonical', { isDuplicate: false, duplicateOf: null }))
    const canonical = structuredClone(row('canonical'))
    await remove()
    expect(state.rows).toEqual([canonical])
  })

  it('isolates the deletion by user and source and survivor selection by user/group', async () => {
    state.rows.push(
      copy('other-user', { userId: 'other', source: 'strava', externalId: '123' }),
      copy('other-source', { externalId: '123', duplicateOf: null }),
      copy('other-group', { duplicateOf: 'elsewhere' }),
      copy('survivor')
    )
    const untouched = structuredClone(state.rows.slice(1, 4))
    await remove()
    expect(state.rows.filter((r) => r.id !== 'survivor')).toEqual(
      untouched.map((r) => (r.id === 'other-user' ? { ...r, duplicateOf: null } : r))
    )
    expect(row('survivor').isDuplicate).toBe(false)
  })

  it('does not delete a matching external ID belonging only to another user or source', async () => {
    state.rows = [
      copy('foreign', { userId: 'other', source: 'strava', externalId: '123' }),
      copy('provider', { externalId: '123' })
    ]
    const before = structuredClone(state.rows)
    await remove()
    expect(state.rows).toEqual(before)
  })

  it.each(['promotion', 'siblings', 'delete'])(
    'rolls back the whole group when %s fails',
    async (stage) => {
      state.rows.push(copy('survivor'), copy('sibling'))
      const before = structuredClone(state.rows)
      state.failAt = stage
      await expect(remove()).rejects.toThrow('injected failure')
      expect(state.rows).toEqual(before)
    }
  )
})
