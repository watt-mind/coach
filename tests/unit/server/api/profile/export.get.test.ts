import { beforeEach, describe, expect, it, vi } from 'vitest'

const setHeadersMock = vi.fn()
const sendStreamMock = vi.fn((_event: any, stream: any) => stream)
const requireAuthMock = vi.fn()
const collectProfileMock = vi.fn()
const collectPlansMock = vi.fn()
const collectActivitiesMock = vi.fn()
const collectHealthMock = vi.fn()
const collectNutritionMock = vi.fn()
const collectAIMock = vi.fn()
const collectSystemMock = vi.fn()
const collectorConstructorMock = vi.fn()
const prismaMock = {}

vi.stubGlobal('defineEventHandler', (fn: any) => fn)
vi.stubGlobal('setHeaders', setHeadersMock)
vi.stubGlobal('sendStream', sendStreamMock)

vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: requireAuthMock
}))

vi.mock('../../../../../server/utils/db', () => ({
  prisma: prismaMock
}))

vi.mock('../../../../../server/utils/data-management/collector', () => {
  class UserUniverseCollector {
    constructor(
      prisma: unknown,
      private readonly userId: string
    ) {
      collectorConstructorMock(prisma, userId)
    }

    exportSections() {
      return [
        {
          key: 'metadata',
          collect: async () => ({
            userId: this.userId,
            exportedAt: new Date().toISOString(),
            version: '1.0.0'
          })
        },
        { key: 'profile', collect: collectProfileMock },
        { key: 'plans', collect: collectPlansMock },
        { key: 'activities', collect: collectActivitiesMock },
        { key: 'health', collect: collectHealthMock },
        { key: 'nutrition', collect: collectNutritionMock },
        { key: 'ai', collect: collectAIMock },
        { key: 'system', collect: collectSystemMock }
      ]
    }
  }

  return { UserUniverseCollector }
})

const getHandler = async () => {
  const mod = await import('../../../../../server/api/profile/export.get')
  return mod.default
}

async function readStream(stream: AsyncIterable<unknown>) {
  let output = ''

  for await (const chunk of stream) {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
  }

  return output
}

describe('GET /api/profile/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires session/API-key auth (rejects OAuth bearer tokens)', async () => {
    const handler = await getHandler()

    requireAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'athlete@example.com'
    })

    const event = {}
    await handler(event as any)

    expect(requireAuthMock).toHaveBeenCalledWith(event, undefined, { allowOAuth: false })
  })

  it('streams a JSON export bundle with download headers', async () => {
    const handler = await getHandler()

    requireAuthMock.mockResolvedValue({
      id: 'user-1',
      email: 'athlete@example.com'
    })
    collectProfileMock.mockResolvedValue({ email: 'athlete@example.com', name: 'Athlete' })
    collectPlansMock.mockResolvedValue({ goals: [{ id: 'goal-1' }] })
    collectActivitiesMock.mockResolvedValue({ workouts: [{ id: 'workout-1', title: 'Long Ride' }] })
    collectHealthMock.mockResolvedValue({ wellness: [{ id: 'wellness-1' }] })
    collectNutritionMock.mockResolvedValue({ nutritionPlans: [{ id: 'plan-1' }] })
    collectAIMock.mockResolvedValue({ rooms: [{ id: 'room-1', messages: [{ id: 'message-1' }] }] })
    collectSystemMock.mockResolvedValue({ integrations: [{ id: 'integration-1' }] })

    const event = {}
    const stream = await handler(event as any)
    const payload = JSON.parse(await readStream(stream))

    expect(collectorConstructorMock).toHaveBeenCalledWith(prismaMock, 'user-1')
    expect(sendStreamMock).toHaveBeenCalledWith(event, expect.anything())
    expect(setHeadersMock).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        'Content-Type': 'application/json',
        'Content-Disposition': expect.stringContaining('watts_export_athlete_example_com_'),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0'
      })
    )
    expect(payload).toMatchObject({
      metadata: {
        userId: 'user-1',
        version: '1.0.0'
      },
      profile: {
        email: 'athlete@example.com',
        name: 'Athlete'
      },
      plans: {
        goals: [{ id: 'goal-1' }]
      },
      activities: {
        workouts: [{ id: 'workout-1', title: 'Long Ride' }]
      },
      health: {
        wellness: [{ id: 'wellness-1' }]
      },
      nutrition: {
        nutritionPlans: [{ id: 'plan-1' }]
      },
      ai: {
        rooms: [{ id: 'room-1', messages: [{ id: 'message-1' }] }]
      },
      system: {
        integrations: [{ id: 'integration-1' }]
      }
    })
    expect(payload.metadata.exportedAt).toEqual(expect.any(String))
  })
})
