import { Prisma, type Workout } from '@prisma/client'
import { prisma } from '../db'

export interface AnalyticsQueryOptions {
  source: 'workouts' | 'wellness' | 'nutrition'
  visualType?: 'line' | 'bar' | 'combo' | 'stackedBar' | 'scatter' | 'horizontalBar' | 'heatmap'
  scope: {
    target: 'self' | 'athlete' | 'athletes' | 'athlete_group' | 'team'
    targetId?: string
    targetIds?: string[]
  }
  timeRange: {
    startDate: Date
    endDate: Date
  }
  grouping: 'daily' | 'weekly' | 'monthly'
  comparison?: {
    type: 'workouts'
    mode: 'summary' | 'stream' | 'interval'
    workoutIds: string[]
    alignment?: 'elapsed_time' | 'distance' | 'percent_complete' | 'lap_index'
    field?: string
  }
  xAxis?: {
    type: 'entity_label'
    sort?: 'selected_order' | 'chronological' | 'metric_desc'
    sortMetricField?: string
  }
  metrics: Array<{
    field: string
    aggregation: 'sum' | 'avg' | 'max' | 'min' | 'count'
  }>
  filters?: Array<{
    field: string
    operator: 'equals' | 'in' | 'gt' | 'lt'
    value: any
  }>
}

type ComparisonWorkout = Pick<
  Workout,
  | 'id'
  | 'userId'
  | 'date'
  | 'title'
  | 'type'
  | 'durationSec'
  | 'distanceMeters'
  | 'averageWatts'
  | 'normalizedPower'
  | 'averageHr'
  | 'tss'
  | 'intensity'
  | 'calories'
  | 'trainingLoad'
  | 'efficiencyFactor'
  | 'decoupling'
  | 'powerHrRatio'
  | 'elapsedTimeSec'
  | 'kilojoules'
  | 'variabilityIndex'
  | 'trimp'
  | 'hrLoad'
  | 'workAboveFtp'
  | 'customMetrics'
>

const standardFieldsBySource: Record<AnalyticsQueryOptions['source'], Set<string>> = {
  workouts: new Set([
    'durationSec',
    'tss',
    'averageWatts',
    'averageHr',
    'distanceMeters',
    'intensity',
    'calories',
    'normalizedPower',
    'trainingLoad',
    'efficiencyFactor',
    'decoupling',
    'powerHrRatio',
    'elapsedTimeSec',
    'kilojoules',
    'variabilityIndex',
    'trimp',
    'hrLoad',
    'workAboveFtp'
  ]),
  wellness: new Set([
    'hrv',
    'restingHr',
    'sleepHours',
    'sleepScore',
    'weight',
    'ctl',
    'atl',
    'tsb',
    'recoveryScore'
  ]),
  nutrition: new Set([
    'calories',
    'protein',
    'carbs',
    'fat',
    'fiber',
    'sugar',
    'caloriesGoal',
    'proteinGoal',
    'carbsGoal',
    'fatGoal',
    'waterMl',
    'overallScore',
    'macroBalanceScore',
    'qualityScore',
    'adherenceScore',
    'hydrationScore',
    'startingGlycogenPercentage',
    'startingFluidDeficit',
    'endingGlycogenPercentage',
    'endingFluidDeficit'
  ])
}

const comparisonMetricLabels: Record<string, string> = {
  tss: 'TSS',
  trainingLoad: 'Training Load',
  durationSec: 'Duration',
  elapsedTimeSec: 'Elapsed Time',
  distanceMeters: 'Distance',
  averageWatts: 'Average Power',
  normalizedPower: 'Normalized Power',
  averageHr: 'Average HR',
  calories: 'Calories',
  intensity: 'Intensity',
  kilojoules: 'Kilojoules',
  efficiencyFactor: 'Efficiency Factor',
  decoupling: 'Decoupling',
  powerHrRatio: 'Power / HR Ratio',
  variabilityIndex: 'Variability Index',
  trimp: 'TRIMP',
  hrLoad: 'HR Load',
  workAboveFtp: 'Work Above FTP'
}

function toDateKey(value: Date | string) {
  return new Date(value).toISOString().split('T')[0] || ''
}

function normalizeNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isNaN(number) ? null : number
}

export const analyticsRepository = {
  async query(userId: string, options: AnalyticsQueryOptions) {
    if (options.comparison?.type === 'workouts') {
      if (options.comparison.mode !== 'summary') {
        throw createError({
          statusCode: 400,
          statusMessage: 'Stream and interval comparison use dedicated endpoints'
        })
      }

      return await this.queryWorkoutComparison(userId, options)
    }

    const userIds = await this.resolveTargetUserIds(userId, options.scope)

    if (userIds.length === 0) {
      return { labels: [], datasets: [] }
    }

    if (options.scope.target === 'athletes' && userIds.length > 1) {
      return await this.queryAthleteComparison(userId, userIds, options)
    }

    const results = (await this.executeAggregatedQuery(userId, userIds, options)) as any[]
    return this.formatChartData(results, options)
  },

  async resolveTargetUserIds(
    requestingUserId: string,
    scope: AnalyticsQueryOptions['scope']
  ): Promise<string[]> {
    if (scope.target === 'self') return [requestingUserId]

    if (scope.target === 'athlete' && scope.targetId) {
      return [scope.targetId]
    }

    if (scope.target === 'athletes' && scope.targetIds?.length) {
      return Array.from(new Set(scope.targetIds))
    }

    if (scope.target === 'athlete_group' && scope.targetId) {
      const group = await (prisma as any).athleteGroup.findUnique({
        where: { id: scope.targetId },
        include: { members: true }
      })
      const memberIds: string[] = group?.members.map((member: any) => member.athleteId) || []
      if (!group || group.teamId || memberIds.length === 0) return memberIds

      // Private membership can outlive a coaching relationship. Recheck on every read.
      const relationships = await prisma.coachingRelationship.findMany({
        where: {
          coachId: requestingUserId,
          athleteId: { in: memberIds },
          status: 'ACTIVE'
        },
        select: { athleteId: true }
      })
      const activeAthleteIds = new Set(relationships.map((relationship) => relationship.athleteId))
      return memberIds.filter((athleteId) => activeAthleteIds.has(athleteId))
    }

    if (scope.target === 'team' && scope.targetId) {
      const members = await (prisma as any).teamMember.findMany({
        where: { teamId: scope.targetId, role: 'ATHLETE' }
      })
      return members.map((member: any) => member.userId)
    }

    return []
  },

  async queryAthleteComparison(
    requestingUserId: string,
    userIds: string[],
    options: AnalyticsQueryOptions
  ) {
    const [users, seriesResults] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true }
      }),
      Promise.all(
        userIds.map(async (targetUserId) => ({
          userId: targetUserId,
          results: await this.executeAggregatedQuery(requestingUserId, [targetUserId], options)
        }))
      )
    ])

    const labels = Array.from(
      new Set(
        seriesResults.flatMap((entry) =>
          (entry.results as any[]).map((row: any) => toDateKey(row.bucket))
        )
      )
    ).sort()

    const namesById = new Map(
      users.map((user) => [user.id, user.name || user.email || 'Unknown athlete'])
    )

    const datasets = seriesResults.flatMap((entry) => {
      const valuesByLabel = new Map(
        (entry.results as any[]).map((row: any) => [toDateKey(row.bucket), row])
      )
      const athleteLabel = namesById.get(entry.userId) || 'Unknown athlete'

      return options.metrics.map((metric, metricIndex) => ({
        label:
          options.metrics.length === 1
            ? athleteLabel
            : `${athleteLabel} · ${this.getMetricLabel(metric.field, metric.aggregation)}`,
        data: labels.map(
          (label) => Number((valuesByLabel.get(label) as any)?.[`metric_${metricIndex}`]) || 0
        )
      }))
    })

    return { labels, datasets }
  },

  async queryWorkoutComparison(requestingUserId: string, options: AnalyticsQueryOptions) {
    const comparison = options.comparison
    if (!comparison || comparison.type !== 'workouts') {
      throw createError({ statusCode: 400, statusMessage: 'Missing workout comparison config' })
    }

    const workouts = await this.fetchComparisonWorkouts(requestingUserId, comparison.workoutIds)

    if (workouts.length === 0) {
      return { labels: [], datasets: [] }
    }

    const sortMode = options.xAxis?.sort || 'selected_order'
    const sorted = this.sortComparisonWorkouts(workouts, sortMode, options)

    if (options.visualType === 'scatter') {
      if (options.metrics.length < 2) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Scatter comparison requires two workout metrics'
        })
      }

      if (options.metrics.length > 2) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Scatter comparison supports exactly two workout metrics'
        })
      }

      const [xMetric, yMetric] = options.metrics
      if (!xMetric || !yMetric) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Scatter comparison requires exactly two workout metrics'
        })
      }

      return {
        labels: [],
        datasets: [
          {
            label: `${this.getMetricLabel(xMetric.field, xMetric.aggregation)} vs ${this.getMetricLabel(yMetric.field, yMetric.aggregation)}`,
            data: sorted
              .map((workout) => {
                const x = this.readWorkoutMetricValue(workout, xMetric.field)
                const y = this.readWorkoutMetricValue(workout, yMetric.field)
                if (x === null || y === null) return null

                return {
                  x,
                  y,
                  label: this.getComparisonWorkoutLabel(workout),
                  workoutId: workout.id
                }
              })
              .filter(Boolean)
          }
        ]
      }
    }

    const labels = sorted.map((workout) => this.getComparisonWorkoutLabel(workout))
    const datasets = options.metrics.map((metric) => ({
      label: this.getMetricLabel(metric.field, metric.aggregation),
      data: sorted.map((workout) => this.readWorkoutMetricValue(workout, metric.field))
    }))

    return { labels, datasets }
  },

  async fetchComparisonWorkouts(requestingUserId: string, workoutIds: string[]) {
    const customFields = await prisma.customFieldDefinition.findMany({
      where: {
        ownerId: requestingUserId,
        dataType: 'NUMBER',
        entityType: 'WORKOUT'
      },
      select: { fieldKey: true }
    })
    const allowedCustomFields = new Set(customFields.map((field) => field.fieldKey))

    const workouts = await prisma.workout.findMany({
      where: {
        id: { in: workoutIds }
      },
      select: {
        id: true,
        userId: true,
        date: true,
        title: true,
        type: true,
        durationSec: true,
        distanceMeters: true,
        averageWatts: true,
        normalizedPower: true,
        averageHr: true,
        tss: true,
        intensity: true,
        calories: true,
        trainingLoad: true,
        efficiencyFactor: true,
        decoupling: true,
        powerHrRatio: true,
        elapsedTimeSec: true,
        kilojoules: true,
        variabilityIndex: true,
        trimp: true,
        hrLoad: true,
        workAboveFtp: true,
        customMetrics: true,
        user: {
          select: {
            name: true,
            email: true
          }
        }
      }
    })

    const byId = new Map(workouts.map((workout) => [workout.id, workout]))

    return workoutIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((workout: any) => ({
        ...workout,
        _allowedCustomFields: allowedCustomFields
      }))
  },

  sortComparisonWorkouts(
    workouts: Array<ComparisonWorkout & { user?: { name: string | null; email: string | null } }>,
    sortMode: NonNullable<AnalyticsQueryOptions['xAxis']>['sort'],
    options: AnalyticsQueryOptions
  ) {
    if (sortMode === 'chronological') {
      return [...workouts].sort(
        (left, right) => new Date(left.date).getTime() - new Date(right.date).getTime()
      )
    }

    if (sortMode === 'metric_desc') {
      const sortField = options.xAxis?.sortMetricField || options.metrics[0]?.field
      if (!sortField) return workouts

      return [...workouts].sort((left, right) => {
        const leftValue = this.readWorkoutMetricValue(left, sortField) ?? Number.NEGATIVE_INFINITY
        const rightValue = this.readWorkoutMetricValue(right, sortField) ?? Number.NEGATIVE_INFINITY
        return rightValue - leftValue
      })
    }

    return workouts
  },

  readWorkoutMetricValue(
    workout: ComparisonWorkout & { _allowedCustomFields?: Set<string> },
    field: string
  ) {
    if (field.startsWith('custom.')) {
      const fieldKey = field.slice('custom.'.length)
      if (!workout._allowedCustomFields?.has(fieldKey)) {
        throw createError({
          statusCode: 400,
          statusMessage: `Unsupported custom metric: ${field}`
        })
      }

      const customMetrics = workout.customMetrics as Record<string, any> | null
      return normalizeNumber(customMetrics?.[fieldKey])
    }

    if (!standardFieldsBySource.workouts.has(field)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Unsupported workout comparison metric: ${field}`
      })
    }

    return normalizeNumber((workout as any)[field])
  },

  getComparisonWorkoutLabel(
    workout: ComparisonWorkout & { user?: { name: string | null; email: string | null } }
  ) {
    const athleteLabel = workout.user?.name || workout.user?.email || 'Athlete'
    const dateLabel = new Date(workout.date).toLocaleDateString('en-CA', {
      month: 'short',
      day: 'numeric'
    })
    return `${dateLabel} · ${workout.title} · ${athleteLabel}`
  },

  async executeAggregatedQuery(
    requestingUserId: string,
    userIds: string[],
    options: AnalyticsQueryOptions
  ) {
    const tableName =
      options.source === 'workouts'
        ? 'Workout'
        : options.source === 'wellness'
          ? 'Wellness'
          : 'Nutrition'
    const dateField = 'date'
    const interval =
      options.grouping === 'daily' ? 'day' : options.grouping === 'weekly' ? 'week' : 'month'

    const customFields = await prisma.customFieldDefinition.findMany({
      where: {
        ownerId: requestingUserId,
        dataType: 'NUMBER',
        entityType:
          options.source === 'workouts'
            ? 'WORKOUT'
            : options.source === 'wellness'
              ? 'WELLNESS'
              : 'NUTRITION'
      },
      select: { fieldKey: true }
    })
    const allowedCustomFields = new Set(customFields.map((field) => field.fieldKey))

    const metricClauses = options.metrics.map((metric, index) => {
      const aggregationMap: Record<
        AnalyticsQueryOptions['metrics'][number]['aggregation'],
        string
      > = {
        sum: 'SUM',
        avg: 'AVG',
        max: 'MAX',
        min: 'MIN',
        count: 'COUNT'
      }
      const aggregation = aggregationMap[metric.aggregation]
      let expression: Prisma.Sql

      if (metric.field.startsWith('custom.')) {
        const fieldKey = metric.field.slice('custom.'.length)
        if (!allowedCustomFields.has(fieldKey)) {
          throw createError({
            statusCode: 400,
            statusMessage: `Unsupported custom metric: ${metric.field}`
          })
        }

        expression = Prisma.sql`NULLIF("customMetrics"->>${fieldKey}, '')::double precision`
      } else {
        if (!standardFieldsBySource[options.source].has(metric.field)) {
          throw createError({
            statusCode: 400,
            statusMessage: `Unsupported metric field: ${metric.field}`
          })
        }

        expression = Prisma.raw(`"${metric.field}"`)
      }

      return Prisma.sql`${Prisma.raw(aggregation)}(${expression}) AS ${Prisma.raw(`metric_${index}`)}`
    })

    const dateFieldSql = Prisma.raw(`"${dateField}"`)
    const tableNameSql = Prisma.raw(`"${tableName}"`)
    const conditions: Prisma.Sql[] = [
      Prisma.sql`"userId" IN (${Prisma.join(userIds)})`,
      Prisma.sql`${dateFieldSql} >= ${options.timeRange.startDate}`,
      Prisma.sql`${dateFieldSql} <= ${options.timeRange.endDate}`
    ]

    if (options.source === 'workouts') {
      conditions.push(Prisma.sql`"isDuplicate" = false`)
    }

    const metricListSql = metricClauses.reduce<Prisma.Sql>(
      (acc, clause, index) => (index === 0 ? clause : Prisma.sql`${acc}, ${clause}`),
      Prisma.empty
    )
    const whereClauseSql = conditions.reduce<Prisma.Sql>(
      (acc, clause, index) => (index === 0 ? clause : Prisma.sql`${acc} AND ${clause}`),
      Prisma.empty
    )

    return await prisma.$queryRaw(
      Prisma.sql`
        SELECT
          date_trunc(${interval}, ${dateFieldSql}) AS bucket,
          ${metricListSql}
        FROM ${tableNameSql}
        WHERE ${whereClauseSql}
        GROUP BY 1
        ORDER BY 1 ASC
      `
    )
  },

  formatChartData(results: any[], options: AnalyticsQueryOptions) {
    const labels = results.map((result) => toDateKey(result.bucket))

    const datasets = options.metrics.map((metric, index) => ({
      label: this.getMetricLabel(metric.field, metric.aggregation),
      data: results.map((result) => Number(result[`metric_${index}`]) || 0)
    }))

    return { labels, datasets }
  },

  getMetricLabel(
    field: string,
    aggregation: AnalyticsQueryOptions['metrics'][number]['aggregation']
  ) {
    if (field.startsWith('custom.')) {
      return field.slice('custom.'.length)
    }

    return comparisonMetricLabels[field] || `${field} (${aggregation})`
  }
}
