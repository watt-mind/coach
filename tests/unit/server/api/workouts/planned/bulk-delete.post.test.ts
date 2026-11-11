import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getServerSession } from '../../../../../../server/utils/session'
import { prisma } from '../../../../../../server/utils/db'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('eventHandler', (fn: any) => fn)
vi.stubGlobal('readValidatedBody', async (event: any, parse: (body: any) => any) =>
  parse(event.body)
)
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message || err.statusMessage)
  ;(error as any).statusCode = err.statusCode
  ;(error as any).statusMessage = err.statusMessage
  return error
})

vi.mock('../../../../../../server/utils/session', () => ({
  getServerSession: vi.fn()
}))

vi.mock('../../../../../../server/utils/db', () => ({
  prisma: {
    plannedWorkout: {
      count: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn()
    },
    event: {
      count: vi.fn(),
      deleteMany: vi.fn()
    },
    calendarNote: {
      count: vi.fn(),
      deleteMany: vi.fn()
    },
    $transaction: vi.fn()
  }
}))

type PlannedRow = {
  id: string
  userId: string
  externalId: string
  date: Date
  title: string
}

type EventRow = {
  id: string
  userId: string
  source: string | null
  date: Date
  title: string
}

type NoteRow = {
  id: string
  userId: string
  source: string
  startDate: Date
  title: string
}

const db: { planned: PlannedRow[]; events: EventRow[]; notes: NoteRow[] } = {
  planned: [],
  events: [],
  notes: []
}

const D = (iso: string) => new Date(iso)

function seed() {
  db.planned = [
    {
      id: 'pw-num-1',
      userId: 'user-1',
      externalId: '12345',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'pw-num-2',
      userId: 'user-1',
      externalId: '67890',
      date: D('2026-06-11T12:00:00Z'),
      title: 'Rest Day'
    },
    // Locally generated workout later assigned a numeric ID by sync counts as intervals.
    {
      id: 'pw-synced',
      userId: 'user-1',
      externalId: '99999',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Synced Local'
    },
    {
      id: 'pw-ai-1',
      userId: 'user-1',
      externalId: 'ai-gen-abc123',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'pw-adhoc-1',
      userId: 'user-1',
      externalId: 'adhoc-xyz',
      date: D('2026-06-12T12:00:00Z'),
      title: 'Zwift Race'
    },
    {
      id: 'pw-uuid-1',
      userId: 'user-1',
      externalId: '550e8400-e29b-41d4-a716-446655440000',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Morning Run'
    },
    {
      id: 'pw-out',
      userId: 'user-1',
      externalId: '11111',
      date: D('2026-07-01T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'pw-other',
      userId: 'user-2',
      externalId: '22222',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'pw-other-local',
      userId: 'user-2',
      externalId: 'ai-gen-other',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    }
  ]
  db.events = [
    {
      id: 'ev-int-1',
      userId: 'user-1',
      source: 'intervals',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'ev-local-1',
      userId: 'user-1',
      source: 'manual',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'ev-local-null',
      userId: 'user-1',
      source: null,
      date: D('2026-06-10T12:00:00Z'),
      title: 'Zwift Race'
    },
    {
      id: 'ev-out',
      userId: 'user-1',
      source: 'intervals',
      date: D('2026-07-01T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'ev-other',
      userId: 'user-2',
      source: 'intervals',
      date: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    }
  ]
  db.notes = [
    {
      id: 'note-int-1',
      userId: 'user-1',
      source: 'intervals',
      startDate: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'note-local-1',
      userId: 'user-1',
      source: 'coach-wattz',
      startDate: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'note-local-2',
      userId: 'user-1',
      source: 'manual',
      startDate: D('2026-06-12T12:00:00Z'),
      title: 'Zwift Race'
    },
    {
      id: 'note-out',
      userId: 'user-1',
      source: 'intervals',
      startDate: D('2026-07-01T12:00:00Z'),
      title: 'Morning Ride'
    },
    {
      id: 'note-other',
      userId: 'user-2',
      source: 'intervals',
      startDate: D('2026-06-10T12:00:00Z'),
      title: 'Morning Ride'
    }
  ]
}

function inRange(value: Date, gte?: Date, lte?: Date) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (gte && time < new Date(gte).getTime()) return false
  if (lte && time > new Date(lte).getTime()) return false
  return true
}

function matchTitle(title: string, filter: any) {
  if (filter === undefined) return true
  if (typeof filter === 'string') return title === filter
  if (filter?.contains !== undefined) {
    const haystack = filter.mode === 'insensitive' ? title.toLowerCase() : title
    const needle =
      filter.mode === 'insensitive'
        ? String(filter.contains).toLowerCase()
        : String(filter.contains)
    return haystack.includes(needle)
  }
  throw new Error(`Unsupported title filter: ${JSON.stringify(filter)}`)
}

function matchSource(source: string | null | undefined, filter: any) {
  if (filter === undefined) return true
  if (typeof filter === 'string') return source === filter
  if (filter && typeof filter === 'object' && 'not' in filter) {
    return source != null && source !== filter.not
  }
  throw new Error(`Unsupported source filter: ${JSON.stringify(filter)}`)
}

function assertNoInvalidExternalIdFilter(where: any, model: string) {
  // PlannedWorkout.externalId is a required String: Prisma has no valid
  // nullable filter for it. Fail loudly if the handler regresses to
  // externalId: null or externalId: { not: null }.
  if (!where || typeof where !== 'object') return
  const value = (where as any).externalId
  if (value === null || value === undefined) {
    if (value === null) {
      throw new Error(
        `Invalid ${model} filter: externalId null is not valid for a required String field`
      )
    }
    return
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'not' in value &&
    (value as any).not === null
  ) {
    throw new Error(
      `Invalid ${model} filter: externalId { not: null } is not valid for a required String field`
    )
  }
}

function matchPlanned(row: PlannedRow, where: any) {
  assertNoInvalidExternalIdFilter(where, 'plannedWorkout')
  if (where.userId !== undefined && row.userId !== where.userId) return false
  if (where.id !== undefined) {
    const idFilter = where.id
    if (typeof idFilter === 'string') {
      if (row.id !== idFilter) return false
    } else if (idFilter?.in) {
      if (!idFilter.in.includes(row.id)) return false
    } else {
      throw new Error(`Unsupported id filter: ${JSON.stringify(idFilter)}`)
    }
  }
  if (where.externalId !== undefined) {
    const ext = where.externalId
    if (typeof ext === 'string') {
      if (row.externalId !== ext) return false
    } else if (ext?.in) {
      if (!ext.in.includes(row.externalId)) return false
    } else {
      throw new Error(`Unsupported externalId filter: ${JSON.stringify(ext)}`)
    }
  }
  if (where.date && !inRange(row.date, where.date.gte, where.date.lte)) return false
  if (!matchTitle(row.title, where.title)) return false
  return true
}

function matchEvent(row: EventRow, where: any) {
  if (where.userId !== undefined && row.userId !== where.userId) return false
  if (where.date && !inRange(row.date, where.date.gte, where.date.lte)) return false
  if (!matchTitle(row.title, where.title)) return false
  if (!matchSource(row.source, where.source)) return false
  return true
}

function matchNote(row: NoteRow, where: any) {
  if (where.userId !== undefined && row.userId !== where.userId) return false
  if (where.startDate && !inRange(row.startDate, where.startDate.gte, where.startDate.lte))
    return false
  if (!matchTitle(row.title, where.title)) return false
  if (!matchSource(row.source, where.source)) return false
  return true
}

function project(rows: any[], select: any) {
  if (!select) return rows.map((row) => ({ ...row }))
  return rows.map((row) => {
    const out: any = {}
    for (const key of Object.keys(select)) {
      if (select[key]) out[key] = (row as any)[key]
    }
    return out
  })
}

const getHandler = async () =>
  (await import('../../../../../../server/api/workouts/planned/bulk-delete.post')).default

const rangeBody = (overrides: Record<string, any> = {}) => ({
  startDate: '2026-06-09',
  endDate: '2026-06-13',
  source: 'all',
  preview: true,
  ...overrides
})

describe('POST /api/workouts/planned/bulk-delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'user-1' } } as any)

    vi.mocked(prisma.plannedWorkout.findMany).mockImplementation(async ({ where, select }: any) =>
      project(
        db.planned.filter((row) => matchPlanned(row, where ?? {})),
        select
      )
    )
    vi.mocked(prisma.plannedWorkout.count).mockImplementation(
      async ({ where }: any) => db.planned.filter((row) => matchPlanned(row, where ?? {})).length
    )
    vi.mocked(prisma.plannedWorkout.deleteMany).mockImplementation(async ({ where }: any) => {
      const victims = db.planned.filter((row) => matchPlanned(row, where ?? {}))
      db.planned = db.planned.filter((row) => !victims.includes(row))
      return { count: victims.length }
    })
    vi.mocked(prisma.event.count).mockImplementation(
      async ({ where }: any) => db.events.filter((row) => matchEvent(row, where ?? {})).length
    )
    vi.mocked(prisma.event.deleteMany).mockImplementation(async ({ where }: any) => {
      const victims = db.events.filter((row) => matchEvent(row, where ?? {}))
      db.events = db.events.filter((row) => !victims.includes(row))
      return { count: victims.length }
    })
    vi.mocked(prisma.calendarNote.count).mockImplementation(
      async ({ where }: any) => db.notes.filter((row) => matchNote(row, where ?? {})).length
    )
    vi.mocked(prisma.calendarNote.deleteMany).mockImplementation(async ({ where }: any) => {
      const victims = db.notes.filter((row) => matchNote(row, where ?? {}))
      db.notes = db.notes.filter((row) => !victims.includes(row))
      return { count: victims.length }
    })
    vi.mocked(prisma.$transaction).mockImplementation(async (ops: any) => await Promise.all(ops))
  })

  it('rejects unauthenticated callers', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as any)
    const handler = await getHandler()
    await expect(handler({ body: rangeBody() } as any)).rejects.toMatchObject({
      statusCode: 401
    })
  })

  it('previews all sources with mixed fixtures and never deletes', async () => {
    const handler = await getHandler()
    const response = await handler({ body: rangeBody() } as any)

    expect(response).toMatchObject({
      success: true,
      preview: true,
      counts: { plannedWorkouts: 6, events: 3, notes: 3, total: 12 }
    })
    expect(prisma.plannedWorkout.deleteMany).not.toHaveBeenCalled()
    expect(prisma.event.deleteMany).not.toHaveBeenCalled()
    expect(prisma.calendarNote.deleteMany).not.toHaveBeenCalled()
    expect(db.planned).toHaveLength(9)
  })

  it('previews intervals with only numeric planned IDs and intervals events/notes', async () => {
    const handler = await getHandler()
    const response = await handler({ body: rangeBody({ source: 'intervals' }) } as any)

    // Numeric: 12345, 67890, 99999 (locally generated then synced). Out-of-range
    // 11111 and other-user 22222 are excluded by date/user scoping.
    expect(response).toMatchObject({
      success: true,
      preview: true,
      counts: { plannedWorkouts: 3, events: 1, notes: 1, total: 5 }
    })
    const findWhere = vi.mocked(prisma.plannedWorkout.findMany).mock.calls[0][0].where
    expect(findWhere).not.toHaveProperty('externalId')
  })

  it('previews coach-wattz with only non-numeric planned IDs and non-intervals events/notes', async () => {
    const handler = await getHandler()
    const response = await handler({ body: rangeBody({ source: 'coach-wattz' }) } as any)

    expect(response).toMatchObject({
      success: true,
      preview: true,
      counts: { plannedWorkouts: 3, events: 1, notes: 2, total: 6 }
    })
    const findWhere = vi.mocked(prisma.plannedWorkout.findMany).mock.calls[0][0].where
    expect(findWhere).not.toHaveProperty('externalId')
  })

  it('uses equivalent selection rules for preview and deletion', async () => {
    const handler = await getHandler()
    const preview = await handler({ body: rangeBody({ source: 'coach-wattz' }) } as any)

    seed()
    const deleted = await handler({
      body: rangeBody({ source: 'coach-wattz', preview: false })
    } as any)

    expect(deleted).toMatchObject({
      success: true,
      preview: false,
      deleted: preview.counts
        ? {
            plannedWorkouts: preview.counts.plannedWorkouts,
            events: preview.counts.events,
            notes: preview.counts.notes,
            total: preview.counts.total
          }
        : {}
    })
    expect(deleted.deleted).toMatchObject({
      plannedWorkouts: 3,
      events: 1,
      notes: 2,
      total: 6
    })
    // Survivors are exactly the out-of-scope records.
    expect(db.planned.map((row) => row.id).sort()).toEqual(
      ['pw-num-1', 'pw-num-2', 'pw-synced', 'pw-out', 'pw-other', 'pw-other-local'].sort()
    )
    expect(db.events.map((row) => row.id).sort()).toEqual(
      ['ev-int-1', 'ev-local-null', 'ev-out', 'ev-other'].sort()
    )
    expect(db.notes.map((row) => row.id).sort()).toEqual(
      ['note-int-1', 'note-out', 'note-other'].sort()
    )
  })

  it('deletes intervals selection without touching local or other-user records', async () => {
    const handler = await getHandler()
    const response = await handler({
      body: rangeBody({ source: 'intervals', preview: false })
    } as any)

    expect(response).toMatchObject({
      success: true,
      preview: false,
      deleted: { plannedWorkouts: 3, events: 1, notes: 1, total: 5 }
    })
    expect(db.planned.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        'pw-ai-1',
        'pw-adhoc-1',
        'pw-uuid-1',
        'pw-out',
        'pw-other',
        'pw-other-local'
      ])
    )
    expect(db.events.map((row) => row.id)).toEqual(
      expect.arrayContaining(['ev-local-1', 'ev-local-null', 'ev-out', 'ev-other'])
    )
    expect(db.notes.map((row) => row.id)).toEqual(
      expect.arrayContaining(['note-local-1', 'note-local-2', 'note-out', 'note-other'])
    )
  })

  it('returns zero counts for an empty selection and deletes nothing', async () => {
    const handler = await getHandler()
    const preview = await handler({
      body: rangeBody({ startDate: '2025-01-01', endDate: '2025-01-02' })
    } as any)
    expect(preview).toMatchObject({
      success: true,
      preview: true,
      counts: { plannedWorkouts: 0, events: 0, notes: 0, total: 0 }
    })

    const deleted = await handler({
      body: rangeBody({ startDate: '2025-01-01', endDate: '2025-01-02', preview: false })
    } as any)
    expect(deleted).toMatchObject({
      success: true,
      preview: false,
      deleted: { plannedWorkouts: 0, events: 0, notes: 0, total: 0 }
    })
    expect(db.planned).toHaveLength(9)
    expect(db.events).toHaveLength(5)
    expect(db.notes).toHaveLength(5)
  })

  it('restricts all three models by keyword', async () => {
    const handler = await getHandler()
    const response = await handler({ body: rangeBody({ keyword: 'Zwift' }) } as any)

    expect(response).toMatchObject({
      success: true,
      preview: true,
      counts: { plannedWorkouts: 1, events: 1, notes: 1, total: 3 }
    })
  })

  it('restricts all three models by date range', async () => {
    const handler = await getHandler()
    const response = await handler({
      body: rangeBody({ startDate: '2026-06-12', endDate: '2026-06-12' })
    } as any)

    expect(response).toMatchObject({
      success: true,
      preview: true,
      counts: { plannedWorkouts: 1, events: 0, notes: 1, total: 2 }
    })
  })

  it('never counts or deletes another user\u2019s records', async () => {
    const handler = await getHandler()
    const preview = await handler({ body: rangeBody() } as any)
    expect(preview.counts.total).toBe(12)

    const deleted = await handler({ body: rangeBody({ preview: false }) } as any)
    expect(deleted.deleted.total).toBe(12)
    // pw-out is outside the requested date range, so it survives alongside user-2 records.
    expect(db.planned.map((row) => row.id).sort()).toEqual(
      ['pw-out', 'pw-other', 'pw-other-local'].sort()
    )
    expect(db.events.map((row) => row.id).sort()).toEqual(['ev-out', 'ev-other'].sort())
    expect(db.notes.map((row) => row.id).sort()).toEqual(['note-out', 'note-other'].sort())
  })

  it('keeps the event/note source behavior for local selections', async () => {
    const handler = await getHandler()
    await handler({ body: rangeBody({ source: 'coach-wattz', preview: false }) } as any)

    const eventWheres = vi.mocked(prisma.event.deleteMany).mock.calls.map((call) => call[0].where)
    const noteWheres = vi
      .mocked(prisma.calendarNote.deleteMany)
      .mock.calls.map((call) => call[0].where)
    expect(eventWheres).toEqual(
      [
        {
          userId: 'user-1',
          date: expect.anything(),
          source: { not: 'intervals' },
          title: undefined
        }
      ].map((w) => expect.objectContaining({ source: { not: 'intervals' }, userId: 'user-1' }))
    )
    expect(noteWheres[0]).toMatchObject({ source: { not: 'intervals' }, userId: 'user-1' })
  })

  it('classifies planned external IDs by the numeric convention', async () => {
    const mod = await import('../../../../../../server/api/workouts/planned/bulk-delete.post')
    expect(mod.isIntervalsPlannedExternalId('12345')).toBe(true)
    expect(mod.isIntervalsPlannedExternalId('99999')).toBe(true)
    expect(mod.isIntervalsPlannedExternalId('ai-gen-abc123')).toBe(false)
    expect(mod.isIntervalsPlannedExternalId('ai_gen_abc')).toBe(false)
    expect(mod.isIntervalsPlannedExternalId('adhoc-xyz')).toBe(false)
    expect(mod.isIntervalsPlannedExternalId('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
    expect(
      mod.selectPlannedWorkoutIdsForSource(
        [
          { id: 'a', externalId: '123' },
          { id: 'b', externalId: 'ai-gen-x' }
        ],
        'all'
      )
    ).toEqual(['a', 'b'])
  })
})
