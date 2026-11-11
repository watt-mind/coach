import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '../../../../../server/utils/db'
import { requireAuth } from '../../../../../server/utils/auth-guard'

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('getRouterParam', (event: any, name: string) => event.params?.[name])
vi.stubGlobal('readBody', async (event: any) => event.body)
vi.stubGlobal('createError', (err: any) => {
  const error = new Error(err.message || err.statusMessage)
  ;(error as any).statusCode = err.statusCode
  ;(error as any).statusMessage = err.statusMessage
  return error
})

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: vi.fn()
}))

vi.mock('../../../../../server/utils/db', () => ({
  prisma: {
    bodyMeasurementEntry: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    wellness: {
      findUnique: vi.fn(),
      update: vi.fn()
    }
  }
}))

const getHandler = async () => {
  const mod = await import('../../../../../server/api/wellness/[id].patch')
  return mod.default
}

describe('PATCH /api/wellness/:id', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({ id: 'user-1' } as any)
    vi.mocked(prisma.wellness.findUnique).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      date: new Date('2026-03-04T00:00:00Z'),
      userId: 'user-1'
    } as any)
    vi.mocked(prisma.wellness.update).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      date: new Date('2026-03-04T00:00:00Z'),
      userId: 'user-1'
    } as any)
  })

  it('accepts manual SpO2 updates without rejecting the request', async () => {
    const handler = await getHandler()

    await handler({
      params: { id: '11111111-1111-4111-8111-111111111111' },
      body: {
        spO2: 97.5,
        comments: null
      }
    } as any)

    expect(prisma.wellness.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: expect.objectContaining({
        spO2: 97.5,
        comments: null
      })
    })
  })

  it('normalizes fractional SpO2 payloads before saving', async () => {
    const handler = await getHandler()

    await handler({
      params: { id: '11111111-1111-4111-8111-111111111111' },
      body: {
        spO2: 0.976,
        customMetrics: {
          note: 'manual'
        }
      }
    } as any)

    expect(prisma.wellness.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: expect.objectContaining({
        spO2: 97.6,
        customMetrics: {
          note: 'manual'
        }
      })
    })
  })
  it.each(['manual', 'withings'])(
    'retires %s entries through the real PATCH writer and supports re-entry',
    async (source) => {
      const id = '11111111-1111-4111-8111-111111111111'
      let wellness: any = {
        id,
        userId: 'user-1',
        date: new Date('2026-03-04T00:00:00Z'),
        weight: 70,
        bodyFat: 18,
        rawJson: { withings: { fatRatio: 18 } }
      }
      const entries: any[] = []
      const matches = (entry: any, where: any) =>
        Object.entries(where).every(([key, value]: any) =>
          value && typeof value === 'object' && 'in' in value
            ? value.in.includes(entry[key])
            : entry[key] === value
        )
      vi.mocked(prisma.wellness.findUnique).mockImplementation(async () => wellness)
      vi.mocked(prisma.wellness.update).mockImplementation(
        async ({ data }: any) => (wellness = { ...wellness, ...data })
      )
      vi.mocked(prisma.bodyMeasurementEntry.findFirst).mockImplementation(
        async ({ where }: any) => entries.find((e) => matches(e, where)) || null
      )
      vi.mocked(prisma.bodyMeasurementEntry.create).mockImplementation(async ({ data }: any) => {
        const entry = { id: String(entries.length), isDeleted: false, ...data }
        entries.push(entry)
        return entry
      })
      vi.mocked(prisma.bodyMeasurementEntry.update).mockImplementation(
        async ({ where, data }: any) =>
          Object.assign(
            entries.find((e) => e.id === where.id),
            data
          )
      )
      vi.mocked(prisma.bodyMeasurementEntry.updateMany).mockImplementation(
        async ({ where, data }: any) => {
          const selected = entries.filter((e) => matches(e, where))
          selected.forEach((e) => Object.assign(e, data))
          return { count: selected.length }
        }
      )
      const { bodyMeasurementService } =
        await import('../../../../../server/utils/services/bodyMeasurementService')
      await bodyMeasurementService.recordWellnessMetrics('user-1', wellness, source)
      entries.push(
        ...[
          { userId: 'other', sourceRefId: id, metricKey: 'weight' },
          { userId: 'user-1', sourceRefId: 'other', metricKey: 'weight' },
          { userId: 'user-1', sourceRefId: id, metricKey: 'muscle_mass_kg' },
          { userId: 'user-1', sourceRefId: null, metricKey: 'weight' }
        ].map((e) => ({ ...e, sourceRefType: 'wellness', isDeleted: false }))
      )
      const handler = await getHandler()
      const patch = (body: any) => handler({ params: { id }, body } as any)
      await patch({ comments: 'omitted measurements' })
      expect(entries.slice(0, 2).every((e) => !e.isDeleted)).toBe(true)
      await patch({ weight: null, bodyFat: null })
      expect(
        entries
          .filter(
            (e) =>
              e.sourceRefId === id &&
              e.userId === 'user-1' &&
              ['weight', 'body_fat_pct'].includes(e.metricKey)
          )
          .every((e) => e.isDeleted)
      ).toBe(true)
      expect(entries.slice(2, 6).every((e) => !e.isDeleted)).toBe(true)
      await patch({ weight: null, bodyFat: null })
      await patch({ weight: 72, bodyFat: 19 })
      expect(entries.some((e) => !e.isDeleted && e.metricKey === 'weight' && e.value === 72)).toBe(
        true
      )
      expect(
        entries.some((e) => !e.isDeleted && e.metricKey === 'body_fat_pct' && e.value === 19)
      ).toBe(true)
    }
  )
  it.each([
    ['weight', 'weight', 'body_fat_pct'],
    ['bodyFat', 'body_fat_pct', 'weight']
  ])('clears only explicitly supplied %s', async (field, metric, retained) => {
    const id = '11111111-1111-4111-8111-111111111111'
    const record = { id, userId: 'user-1', date: new Date('2026-03-04'), weight: 70, bodyFat: 18 }
    vi.mocked(prisma.wellness.findUnique).mockResolvedValue(record as any)
    vi.mocked(prisma.wellness.update).mockResolvedValue({ ...record, [field!]: null } as any)
    const handler = await getHandler()
    await handler({ params: { id }, body: { [field!]: null } } as any)
    expect(prisma.bodyMeasurementEntry.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        sourceRefType: 'wellness',
        sourceRefId: id,
        metricKey: { in: [metric] },
        isDeleted: false
      },
      data: { isDeleted: true }
    })
    expect(prisma.bodyMeasurementEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ metricKey: retained })
    })
  })

  it('does not retire another user’s measurements', async () => {
    vi.mocked(prisma.wellness.findUnique).mockResolvedValue({ userId: 'other' } as any)
    const handler = await getHandler()
    await expect(
      handler({
        params: { id: '11111111-1111-4111-8111-111111111111' },
        body: { weight: null }
      } as any)
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.bodyMeasurementEntry.updateMany).not.toHaveBeenCalled()
  })
})
