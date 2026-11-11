import { requireAuth } from '../../utils/auth-guard'
import { prisma } from '../../utils/db'
import { wellnessRepository } from '../../utils/repositories/wellnessRepository'

const toSleepHours = (
  sleepHours: number | null | undefined,
  sleepSecs: number | null | undefined
) => sleepHours ?? (sleepSecs != null ? Math.round((sleepSecs / 3600) * 10) / 10 : null)

defineRouteMeta({
  openAPI: {
    tags: ['Wellness'],
    summary: 'Get wellness trends',
    description: 'Returns daily wellness metrics for a specified date range.',
    inputSchema: [
      {
        name: 'startDate',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'date-time' }
      },
      {
        name: 'endDate',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'date-time' }
      }
    ],
    responses: {
      200: {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string' },
                  hrv: { type: 'number', nullable: true },
                  restingHr: { type: 'integer', nullable: true },
                  hoursSlept: { type: 'number', nullable: true },
                  sleepScore: { type: 'integer', nullable: true },
                  recoveryScore: { type: 'integer', nullable: true }
                }
              }
            }
          }
        }
      },
      400: { description: 'Invalid date range' },
      401: { description: 'Unauthorized' }
    }
  }
})

export default defineEventHandler(async (event) => {
  const user = await requireAuth(event, ['health:read'])

  const query = getQuery(event)
  const startDate = query.startDate ? new Date(query.startDate as string) : null
  const endDate = query.endDate ? new Date(query.endDate as string) : null

  if (!startDate || !endDate || isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw createError({
      statusCode: 400,
      message: 'Valid startDate and endDate parameters are required'
    })
  }

  const userId = user.id

  // Fetch wellness data for the date range
  const wellness = await wellnessRepository.getForUser(userId, {
    startDate,
    endDate,
    orderBy: { date: 'asc' }
  })

  // Fetch daily metrics for the date range
  const dailyMetrics = await prisma.dailyMetric.findMany({
    where: {
      userId,
      date: {
        gte: startDate,
        lte: endDate
      }
    },
    orderBy: { date: 'asc' }
  })

  // Merge data by date, preferring wellness over dailyMetrics
  const dataByDate = new Map()

  // Add daily metrics first
  for (const d of dailyMetrics) {
    const dateKey = d.date.toISOString().split('T')[0]
    dataByDate.set(dateKey, {
      date: dateKey,
      hrv: d.hrv,
      restingHr: d.restingHr,
      hoursSlept: d.hoursSlept,
      sleepScore: d.sleepScore,
      recoveryScore: d.recoveryScore
    })
  }

  // Override with wellness data where available
  for (const w of wellness) {
    const dateKey = w.date.toISOString().split('T')[0]
    const existing = dataByDate.get(dateKey) || { date: dateKey }
    dataByDate.set(dateKey, {
      date: dateKey,
      hrv: w.hrv ?? existing.hrv,
      restingHr: w.restingHr ?? existing.restingHr,
      hoursSlept: toSleepHours(w.sleepHours, w.sleepSecs) ?? existing.hoursSlept,
      sleepScore: w.sleepScore ?? existing.sleepScore,
      recoveryScore: w.recoveryScore ?? existing.recoveryScore,
      readiness: w.readiness ?? existing.readiness
    })
  }

  // Convert map to array and sort by date
  return Array.from(dataByDate.values()).sort((a, b) => a.date.localeCompare(b.date))
})
