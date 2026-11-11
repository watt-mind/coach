<script setup lang="ts">
  import {
    WORKOUT_EXPLORER_CATEGORIES,
    WORKOUT_EXPLORER_PRESETS,
    findWorkoutExplorerPresetById,
    type WorkoutExplorerCategory,
    type WorkoutExplorerPreset,
    type WorkoutExplorerVisualType
  } from '~/utils/workout-explorer-presets'
  import { useAnalyticsBus } from '~/composables/useAnalyticsBus'
  import { formatElevation } from '~/utils/metrics'
  import { workoutExplorerMetricUnits } from '#shared/workout-explorer-metrics'

  type ExplorerSummaryChartType = 'bar' | 'line' | 'combo' | 'radar' | 'scatter'
  type ExplorerStreamField =
    | 'watts'
    | 'heartrate'
    | 'cadence'
    | 'velocity'
    | 'altitude'
    | 'grade'
    | 'torque'
    | 'vam'
    | 'w_balance'
    | 'power_hr_ratio'

  interface PinnedExplorerChart {
    id: string
    presetId: string
    summaryChartType: ExplorerSummaryChartType
    streamField: ExplorerStreamField
    streamAlignment: 'elapsed_time' | 'distance' | 'percent_complete'
    intervalField: 'avgPower' | 'avgHr' | 'duration' | 'distance'
  }

  definePageMeta({
    middleware: 'auth'
  })

  useHead({
    title: 'Workout Explorer | Coach Watts',
    meta: [
      {
        name: 'description',
        content:
          'Browse single-workout analysis charts, inspect one session, and pin it to dashboards.'
      }
    ]
  })

  const route = useRoute()
  const router = useRouter()
  const toast = useToast()
  const comparisonStore = useWorkoutComparisonStore()
  const userStore = useUserStore()

  const { data: dashboards, refresh: refreshDashboards } = await useFetch(
    '/api/analytics/dashboards'
  )

  const leftRailTab = ref<'workout' | 'library'>('workout')
  const workoutSearch = ref('')
  const librarySearch = ref('')
  const activeCategory = ref<'all' | WorkoutExplorerCategory>('all')
  const athleteFilter = ref('all')
  const workoutTypeFilter = ref('all')
  const workoutSourceFilter = ref('all')
  const startDateFilter = ref('')
  const endDateFilter = ref('')
  const showAdvanced = ref(false)
  const saving = ref(false)
  const pinnedCharts = ref<PinnedExplorerChart[]>([])

  const selectedWorkoutId = ref<string | null>(null)
  const selectedPreset = ref<WorkoutExplorerPreset>(
    findWorkoutExplorerPresetById((route.query.preset as string) || '') ||
      WORKOUT_EXPLORER_PRESETS[0]!
  )

  const summaryChartType = ref<ExplorerSummaryChartType>('bar')
  const streamField = ref<ExplorerStreamField>('watts')
  const streamAlignment = ref<'elapsed_time' | 'distance' | 'percent_complete'>('elapsed_time')
  const intervalField = ref<'avgPower' | 'avgHr' | 'duration' | 'distance'>('avgPower')

  const activeRange = ref<{
    start: number
    end: number
    alignment: 'elapsed_time' | 'distance' | 'percent_complete'
  } | null>(null)
  const { onZoom, onSelection } = useAnalyticsBus()

  const stopZoom = onZoom((event) => {
    if (event.workoutId === selectedWorkoutId.value) {
      activeRange.value = {
        start: event.startX,
        end: event.endX,
        alignment: streamAlignment.value
      }
    }
  })

  const stopSelection = onSelection((event) => {
    if (event.workoutId === selectedWorkoutId.value) {
      activeRange.value = {
        start: event.startX,
        end: event.endX,
        alignment: streamAlignment.value
      }
    }
  })

  onUnmounted(() => {
    stopZoom.off()
    stopSelection.off()
  })

  // Reset zoom when workout or critical view settings change
  watch([selectedWorkoutId, streamAlignment], () => {
    activeRange.value = null
  })

  // Also reset zoom when mode changes (e.g. from stream to density)
  watch(
    () => selectedPreset.value.mode,
    (newMode, oldMode) => {
      if (newMode !== oldMode) activeRange.value = null
    }
  )

  const streamFieldUnits: Record<string, string> = {
    watts: 'W',
    heartrate: 'bpm',
    cadence: 'rpm',
    // Display unit, not storage: the `velocity` stream is persisted in m/s
    // (see `metresPerSecondToKmh` in `shared/units.ts`) and converted to km/h
    // server-side before it reaches this chart, so the unit that goes with
    // the rendered value really is km/h (CW-382).
    velocity: 'km/h',
    altitude: 'm',
    grade: '%',
    torque: 'Nm',
    vam: 'm/h',
    w_balance: 'J',
    power_hr_ratio: ''
  }

  const streamAlignmentUnits: Record<string, string> = {
    elapsed_time: 'duration',
    distance: 'm',
    percent_complete: '%'
  }

  const intervalFieldUnits: Record<string, string> = {
    avgPower: 'W',
    avgHr: 'bpm',
    duration: 'duration',
    distance: 'm'
  }

  const streamFieldOptions = [
    { label: 'Power', value: 'watts' },
    { label: 'Heart Rate', value: 'heartrate' },
    { label: 'Cadence', value: 'cadence' },
    { label: 'Velocity', value: 'velocity' },
    { label: 'Altitude', value: 'altitude' },
    { label: 'Grade', value: 'grade' },
    { label: 'Torque', value: 'torque' },
    { label: 'VAM', value: 'vam' },
    { label: "W' Balance", value: 'w_balance' },
    { label: 'Efficiency Ratio', value: 'power_hr_ratio' }
  ] satisfies Array<{ label: string; value: ExplorerStreamField }>

  const streamFieldOptionMap = Object.fromEntries(
    streamFieldOptions.map((option) => [option.value, option.label])
  ) as Record<ExplorerStreamField, string>

  function applyPreset(preset: WorkoutExplorerPreset) {
    selectedPreset.value = preset

    if (preset.mode === 'summary' && preset.summary) {
      summaryChartType.value = preset.summary.chartType
    }

    if (preset.mode === 'stream' && preset.stream) {
      streamField.value = preset.stream.field || preset.stream.fields?.[0] || 'watts'
      streamAlignment.value = preset.stream.alignment
    }

    if (preset.mode === 'interval' && preset.interval) {
      intervalField.value = preset.interval.field
    }
  }

  watch(
    () => route.query.workoutId,
    (value) => {
      if (typeof value === 'string' && value.trim()) {
        selectedWorkoutId.value = value
      } else {
        selectedWorkoutId.value = null
      }
    },
    { immediate: true }
  )

  watch(
    () => route.query.mode,
    (value) => {
      if (typeof route.query.preset === 'string') return
      if (value !== 'summary' && value !== 'stream' && value !== 'interval' && value !== 'density')
        return

      const fallbackPreset =
        WORKOUT_EXPLORER_PRESETS.find((preset) => preset.mode === value) ||
        WORKOUT_EXPLORER_PRESETS[0]
      if (fallbackPreset) applyPreset(fallbackPreset)
    },
    { immediate: true }
  )

  watch(
    () => route.query.preset,
    (value) => {
      if (typeof value !== 'string') return
      const preset = findWorkoutExplorerPresetById(value)
      if (preset) applyPreset(preset)
    },
    { immediate: true }
  )

  watch(
    [selectedPreset, selectedWorkoutId],
    ([preset, workoutId]) => {
      const nextQuery = {
        ...route.query,
        preset: preset.id,
        mode: preset.mode,
        workoutId: workoutId || undefined
      }

      const currentWorkoutId =
        typeof route.query.workoutId === 'string' ? route.query.workoutId : undefined
      if (
        route.query.preset === nextQuery.preset &&
        route.query.mode === nextQuery.mode &&
        currentWorkoutId === nextQuery.workoutId
      ) {
        return
      }

      router.replace({ query: nextQuery })
    },
    { deep: false }
  )

  const workoutBrowserBody = computed(() => ({
    search: workoutSearch.value || undefined,
    athleteIds: athleteFilter.value !== 'all' ? [athleteFilter.value] : undefined,
    type: workoutTypeFilter.value !== 'all' ? workoutTypeFilter.value : undefined,
    source: workoutSourceFilter.value !== 'all' ? workoutSourceFilter.value : undefined,
    startDate: startDateFilter.value || undefined,
    endDate: endDateFilter.value || undefined,
    limit: 80
  }))

  const { data: browserData, pending: loadingBrowser } = await useFetch(
    '/api/analytics/workout-comparison/browse',
    {
      method: 'POST',
      body: workoutBrowserBody,
      watch: [workoutBrowserBody]
    }
  )

  const selectedWorkoutData = ref<any>(null)
  const loadingSelectedWorkout = ref(false)
  const selectedWorkoutError = ref<any>(null)
  const selectedWorkoutRequestId = ref(0)

  async function fetchSelectedWorkout() {
    if (import.meta.server) return

    if (!selectedWorkoutId.value) {
      selectedWorkoutData.value = null
      selectedWorkoutError.value = null
      return
    }

    const requestId = selectedWorkoutRequestId.value + 1
    selectedWorkoutRequestId.value = requestId
    loadingSelectedWorkout.value = true
    selectedWorkoutError.value = null
    selectedWorkoutData.value = null

    if (import.meta.dev) {
      console.debug('[WorkoutExplorer] workout:fetch:start', {
        requestId,
        workoutId: selectedWorkoutId.value
      })
    }

    try {
      const response = await $fetch<any, string & {}>('/api/analytics/workout-explorer/workout', {
        method: 'POST',
        body: {
          workoutId: selectedWorkoutId.value
        }
      })
      if (requestId !== selectedWorkoutRequestId.value) return
      selectedWorkoutData.value = response
      if (import.meta.dev) {
        console.debug('[WorkoutExplorer] workout:fetch:success', {
          requestId,
          workoutId: response?.id,
          title: response?.title
        })
      }
    } catch (error: any) {
      if (requestId !== selectedWorkoutRequestId.value) return
      selectedWorkoutData.value = null
      selectedWorkoutError.value = error
      if (import.meta.dev) {
        console.error('[WorkoutExplorer] workout:fetch:error', {
          requestId,
          workoutId: selectedWorkoutId.value,
          message: error?.data?.statusMessage || error?.message || error
        })
      }
    } finally {
      if (requestId === selectedWorkoutRequestId.value) {
        loadingSelectedWorkout.value = false
      }
    }
  }

  watch(selectedWorkoutId, fetchSelectedWorkout, { immediate: true })

  const athleteOptions = computed(() => {
    const athletes = (browserData.value as any)?.athletes || []

    return [
      { label: 'All athletes', value: 'all' },
      ...athletes.map((athlete: any) => ({
        label: athlete.name,
        value: athlete.id
      }))
    ]
  })

  const workoutTypeOptions = computed(() => {
    const workouts = ((browserData.value as any)?.workouts || []) as any[]
    const types = Array.from(new Set(workouts.map((workout) => workout.type).filter(Boolean)))

    return [
      { label: 'All workout types', value: 'all' },
      ...types.map((type) => ({
        label: type,
        value: type
      }))
    ]
  })

  const workoutSourceOptions = computed(() => {
    const workouts = ((browserData.value as any)?.workouts || []) as any[]
    const sources = Array.from(new Set(workouts.map((workout) => workout.source).filter(Boolean)))

    return [
      { label: 'All sources', value: 'all' },
      ...sources.map((source) => ({
        label: source,
        value: source
      }))
    ]
  })

  const browserWorkouts = computed(() => ((browserData.value as any)?.workouts || []) as any[])

  const filteredPresets = computed(() => {
    const search = librarySearch.value.trim().toLowerCase()

    return WORKOUT_EXPLORER_PRESETS.filter((preset) => {
      const matchesCategory =
        activeCategory.value === 'all' || preset.category === activeCategory.value
      if (!matchesCategory) return false
      if (!search) return true

      return [preset.name, preset.description, preset.category, preset.mode].some((value) =>
        String(value || '')
          .toLowerCase()
          .includes(search)
      )
    })
  })

  const groupedPresets = computed(() =>
    WORKOUT_EXPLORER_CATEGORIES.map((category) => ({
      ...category,
      presets: filteredPresets.value.filter((preset) => preset.category === category.value)
    })).filter((category) => category.presets.length > 0)
  )

  const selectedCategoryLabel = computed(
    () =>
      WORKOUT_EXPLORER_CATEGORIES.find((entry) => entry.value === selectedPreset.value.category)
        ?.label || 'Workout Analysis'
  )

  const selectedModeLabel = computed(() => {
    if (selectedPreset.value.mode === 'stream') return 'Streams'
    if (selectedPreset.value.mode === 'interval') return 'Intervals'
    if (selectedPreset.value.mode === 'density') return 'Density'
    return 'Summary'
  })

  const selectedWorkoutSourceLabel = computed(() => selectedPreset.value.sourceLabel)
  const selectedStreamFields = computed<ExplorerStreamField[]>(() => {
    if (selectedPreset.value.mode !== 'stream') return []
    const presetFields = selectedPreset.value.stream?.fields
    if (presetFields?.length) return presetFields
    return selectedPreset.value.stream?.field
      ? [selectedPreset.value.stream.field]
      : [streamField.value]
  })
  const supportsStreamFieldSelection = computed(
    () => selectedPreset.value.mode === 'stream' && selectedStreamFields.value.length === 1
  )
  const canToggleSummaryChartType = computed(
    () =>
      selectedPreset.value.mode === 'summary' &&
      selectedPreset.value.summary?.allowChartToggle !== false
  )

  const selectedWorkout = computed(() => {
    const workout = selectedWorkoutData.value as any
    if (!workout || (selectedWorkoutError.value as any)) return null
    return workout.id === selectedWorkoutId.value ? workout : null
  })

  const selectedWorkoutUnavailable = computed(
    () =>
      Boolean(selectedWorkoutId.value) && !loadingSelectedWorkout.value && !selectedWorkout.value
  )

  const { data: rangeSummary, pending: loadingRangeSummary } = await useFetch(
    '/api/analytics/workout-explorer/summary',
    {
      method: 'POST',
      body: computed(() => ({
        analysis: {
          type: 'single_workout',
          mode: 'summary',
          workoutId: selectedWorkoutId.value
        },
        metrics: [
          { field: 'averageWatts' },
          { field: 'maxWatts' },
          { field: 'normalizedPower' },
          { field: 'averageHr' },
          { field: 'maxHr' },
          { field: 'averageCadence' },
          { field: 'elevationGain' },
          { field: 'durationSec' },
          { field: 'distanceMeters' }
        ],
        range: activeRange.value
      })),
      watch: [selectedWorkoutId, activeRange]
    }
  )

  const workoutHeadlineStats = computed(() => {
    if (!selectedWorkout.value) return []

    const workout = selectedWorkout.value
    const rs = rangeSummary.value as any
    const isRange = Boolean(activeRange.value && rs?.datasets)

    // Map labels to values for easy access
    const rangeMap: Record<string, any> = {}
    if (isRange) {
      rs.datasets.forEach((ds: any) => {
        rangeMap[ds.label] = ds.data[0]
      })
    }

    const getVal = (field: string, label: string, unit: string) => {
      if (isRange && rangeMap[label] !== undefined) {
        return formatNumberWithUnit(rangeMap[label], unit)
      }
      return formatNumberWithUnit((workout as any)[field], unit)
    }

    return [
      {
        label: isRange ? 'Segment Time' : 'Elapsed',
        value:
          isRange && rangeMap['Duration'] !== undefined
            ? formatDuration(rangeMap['Duration'])
            : formatDuration(workout.elapsedTimeSec || workout.durationSec),
        icon: 'i-lucide-clock-3'
      },
      {
        label: isRange ? 'Segment Gain' : 'Elevation',
        value: getVal('elevationGain', 'Elevation Gain', 'm'),
        icon: 'i-lucide-mountain'
      },
      {
        label: isRange ? 'Segment Avg' : 'Avg Power',
        value: getVal('averageWatts', 'Average Power', 'W'),
        icon: 'i-lucide-zap'
      },
      {
        label: isRange ? 'Segment NP' : 'NP',
        value: getVal('normalizedPower', 'Normalized Power', 'W'),
        icon: 'i-lucide-rocket'
      },
      {
        label: isRange ? 'Segment HR' : 'Avg HR',
        value: getVal('averageHr', 'Average HR', 'bpm'),
        icon: 'i-lucide-heart-pulse'
      },
      {
        label: isRange ? 'Segment Cad' : 'Cadence',
        value: getVal('averageCadence', 'Average Cadence', 'rpm'),
        icon: 'i-lucide-gauge'
      }
    ].filter((item) => item.value !== '—')
  })

  function buildPreviewConfig(options: {
    preset: WorkoutExplorerPreset
    workoutId: string
    summaryChartType: ExplorerSummaryChartType
    streamField: ExplorerStreamField
    streamAlignment: 'elapsed_time' | 'distance' | 'percent_complete'
    intervalField: 'avgPower' | 'avgHr' | 'duration' | 'distance'
    instanceId?: string
    range?: {
      start: number
      end: number
      alignment: 'elapsed_time' | 'distance' | 'percent_complete'
    } | null
  }) {
    const base = {
      name: options.preset.name,
      explorerPresetId: options.preset.id,
      explorerPresetCategory: options.preset.category,
      scope: { target: 'self' as const },
      source: 'workouts' as const,
      timeRange: { type: 'rolling', value: '180d' },
      analysis: {
        type: 'single_workout' as const,
        mode: options.preset.mode,
        workoutId: options.workoutId
      },
      instanceId: options.instanceId,
      range: options.range
    }

    if (options.preset.mode === 'summary') {
      const metrics = (options.preset.summary?.metrics || []).map((field) => ({
        field,
        aggregation: 'avg' as const
      }))
      const isMmp = options.preset.summary?.advancedMode === 'mmp_curve'
      // MMP renders as scatter; other advanced/toggle presets use their own chart type
      const summaryVisualType = isMmp
        ? 'scatter'
        : options.preset.summary?.allowChartToggle
          ? options.summaryChartType
          : (options.preset.visualType as Extract<
              WorkoutExplorerVisualType,
              ExplorerSummaryChartType
            >)

      return {
        ...base,
        endpoint: '/api/analytics/workout-explorer/summary',
        visualType: summaryVisualType,
        grouping: 'daily' as const,
        units: {
          x: isMmp ? 'duration' : '',
          y: isMmp
            ? 'W'
            : options.preset.summary?.type === 'zones'
              ? '%'
              : options.preset.summary?.advancedMode === 'half_split_power_hr'
                ? 'W'
                : options.preset.summary?.advancedMode === 'coasting_breakdown'
                  ? '%'
                  : '',
          y1: options.preset.summary?.advancedMode === 'half_split_power_hr' ? 'bpm' : '',
          datasets:
            options.preset.summary?.type === 'advanced'
              ? []
              : metrics.map((metric) => workoutExplorerMetricUnits[metric.field] || '')
        },
        scales: isMmp ? { x: { type: 'logarithmic' as const } } : options.preset.scales,
        metrics,
        summaryType: options.preset.summary?.type || 'metrics',
        zoneType: options.preset.summary?.zoneType,
        advancedMode: options.preset.summary?.advancedMode,
        styling:
          options.preset.summary?.advancedMode === 'half_split_power_hr'
            ? { datasetTypes: ['bar', 'line'] }
            : undefined
      }
    }

    if (options.preset.mode === 'stream') {
      const streamFields = options.preset.stream?.fields?.length
        ? options.preset.stream.fields
        : [options.streamField]
      const primaryUnit = streamFieldUnits[streamFields[0]!] || ''
      const secondaryUnit = streamFields[1] ? streamFieldUnits[streamFields[1]] || '' : ''

      return {
        ...base,
        endpoint: '/api/analytics/workout-explorer/streams',
        visualType: options.preset.visualType,
        // Stream data always uses {x, y} objects — force linear x scale so Chart.js
        // positions points by value rather than index (was previously handled by scatter type)
        scales: { x: { type: 'linear' as const } },
        analysis: {
          ...base.analysis,
          field: streamFields[0],
          fields: streamFields,
          alignment: options.streamAlignment,
          range: options.range
        },
        units: {
          x: streamAlignmentUnits[options.streamAlignment] || '',
          y: primaryUnit,
          y1: options.preset.visualType === 'combo' ? secondaryUnit : '',
          datasets: streamFields.map((field) => streamFieldUnits[field] || '')
        },
        metrics: [],
        styling: options.preset.stream?.datasetTypes
          ? { datasetTypes: options.preset.stream.datasetTypes }
          : undefined
      }
    }

    if (options.preset.mode === 'density') {
      return {
        ...base,
        endpoint: '/api/analytics/workout-explorer/density',
        visualType: 'density-heatmap' as const,
        analysis: {
          ...base.analysis,
          xField: options.preset.density?.xField || 'cadence',
          yField: options.preset.density?.yField || 'watts',
          xBins: 40,
          yBins: 40,
          range: options.range
        },
        metrics: []
      }
    }

    return {
      ...base,
      endpoint: '/api/analytics/workout-explorer/intervals',
      visualType: 'line' as const,
      analysis: {
        ...base.analysis,
        field: options.intervalField
      },
      units: {
        y: intervalFieldUnits[options.intervalField] || '',
        datasets: [intervalFieldUnits[options.intervalField] || '']
      },
      metrics: []
    }
  }

  const previewConfig = computed(() => {
    if (!selectedWorkoutId.value) return null

    return buildPreviewConfig({
      preset: selectedPreset.value,
      workoutId: selectedWorkoutId.value,
      summaryChartType: summaryChartType.value,
      streamField: streamField.value,
      streamAlignment: streamAlignment.value,
      intervalField: intervalField.value,
      range: activeRange.value
    })
  })

  const pinnedChartConfigs = computed(() => {
    if (!selectedWorkoutId.value) return []

    return pinnedCharts.value
      .map((chart) => {
        const preset = findWorkoutExplorerPresetById(chart.presetId)
        if (!preset) return null

        return {
          chart,
          preset,
          config: buildPreviewConfig({
            preset,
            workoutId: selectedWorkoutId.value!,
            summaryChartType: chart.summaryChartType,
            streamField: chart.streamField,
            streamAlignment: chart.streamAlignment,
            intervalField: chart.intervalField,
            instanceId: chart.id,
            range: activeRange.value
          })
        }
      })
      .filter(Boolean) as Array<{
      chart: PinnedExplorerChart
      preset: WorkoutExplorerPreset
      config: any
    }>
  })

  function formatDateLabel(date: string | Date | null | undefined) {
    if (!date) return ''
    return new Date(date).toLocaleDateString()
  }

  function formatDuration(seconds: number | null | undefined) {
    if (!seconds) return '—'
    if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} h`
    return `${Math.round(seconds / 60)} min`
  }

  function formatDistance(meters: number | null | undefined) {
    if (!meters) return '—'
    return `${(meters / 1000).toFixed(1)} km`
  }

  function formatMeters(meters: number | null | undefined) {
    if (meters === null || meters === undefined) return '—'
    return formatElevation(meters, userStore.profile?.distanceUnits || 'Kilometers')
  }

  function formatLoad(value: number | null | undefined, suffix = 'load') {
    if (value === null || value === undefined) return '—'
    return `${Math.round(value)} ${suffix}`
  }

  function formatNumberWithUnit(value: number | null | undefined, unit = '') {
    if (value === null || value === undefined) return '—'
    const rounded =
      Math.abs(value) >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)
    return `${rounded}${unit ? ` ${unit}` : ''}`
  }

  function workoutTypeIcon(type: string | null | undefined) {
    const normalized = String(type || '')
      .toLowerCase()
      .trim()

    if (
      normalized.includes('ride') ||
      normalized.includes('bike') ||
      normalized.includes('cycling')
    ) {
      return 'i-lucide-bike'
    }

    if (normalized.includes('run')) return 'i-lucide-person-standing'
    if (normalized.includes('swim')) return 'i-lucide-waves'
    if (
      normalized.includes('strength') ||
      normalized.includes('gym') ||
      normalized.includes('lift')
    ) {
      return 'i-lucide-dumbbell'
    }

    if (normalized.includes('walk') || normalized.includes('hike')) return 'i-lucide-footprints'

    return 'i-lucide-activity'
  }

  function presetIcon(preset: WorkoutExplorerPreset) {
    if (preset.mode === 'stream') return 'i-lucide-activity'
    if (preset.mode === 'interval') return 'i-lucide-split'
    return preset.visualType === 'bar' ? 'i-lucide-bar-chart-3' : 'i-lucide-line-chart'
  }

  function selectWorkout(workout: any) {
    selectedWorkoutId.value = workout.id
  }

  function pinCurrentChartToExplorer() {
    if (!selectedWorkoutId.value) {
      toast.add({
        title: 'Select a workout first',
        description: 'Choose a workout before pinning explorer charts.',
        color: 'warning'
      })
      leftRailTab.value = 'workout'
      return
    }

    pinnedCharts.value.push({
      id: crypto.randomUUID(),
      presetId: selectedPreset.value.id,
      summaryChartType: summaryChartType.value,
      streamField: streamField.value,
      streamAlignment: streamAlignment.value,
      intervalField: intervalField.value
    })

    toast.add({
      title: 'Chart pinned to explorer',
      description: 'Stack more charts underneath to build a deeper read on this workout.',
      color: 'success'
    })
  }

  function removePinnedChart(chartId: string) {
    pinnedCharts.value = pinnedCharts.value.filter((chart) => chart.id !== chartId)
  }

  function movePinnedChart(chartId: string, direction: -1 | 1) {
    const currentIndex = pinnedCharts.value.findIndex((chart) => chart.id === chartId)
    if (currentIndex < 0) return

    const nextIndex = currentIndex + direction
    if (nextIndex < 0 || nextIndex >= pinnedCharts.value.length) return

    const nextCharts = [...pinnedCharts.value]
    const [chart] = nextCharts.splice(currentIndex, 1)
    if (!chart) return
    nextCharts.splice(nextIndex, 0, chart)
    pinnedCharts.value = nextCharts
  }

  function clearPinnedCharts() {
    pinnedCharts.value = []
  }

  function toggleComparison(workout: any) {
    comparisonStore.toggleWorkout({
      id: workout.id,
      title: workout.title,
      type: workout.type || null,
      date: workout.date || null,
      athleteName: workout.user?.name || workout.user?.email || 'Athlete'
    })
  }

  function resetWorkoutFilters() {
    athleteFilter.value = 'all'
    workoutTypeFilter.value = 'all'
    workoutSourceFilter.value = 'all'
    startDateFilter.value = ''
    endDateFilter.value = ''
    workoutSearch.value = ''
  }

  watch(selectedWorkoutError, (error) => {
    if (!error || !selectedWorkoutId.value) return
    toast.add({
      title: 'Workout unavailable',
      description: 'The selected workout could not be loaded. Choose another workout to continue.',
      color: 'warning'
    })
  })

  async function pinToDashboard() {
    if (!selectedWorkoutId.value || !previewConfig.value) {
      toast.add({ title: 'Select a workout to analyze', color: 'warning' })
      leftRailTab.value = 'workout'
      return
    }

    saving.value = true

    try {
      await refreshDashboards()

      let dashboard = dashboards.value?.[0] as any
      if (!dashboard) {
        dashboard = await $fetch<any, string & {}>('/api/analytics/dashboards', {
          method: 'POST',
          body: {
            name: 'Main Dashboard',
            layout: [],
            scope: { target: 'self' }
          }
        })
        await refreshDashboards()
      }

      const layout = [...((dashboard?.layout as any[]) || []).filter(Boolean)]
      layout.push({
        ...previewConfig.value,
        instanceId: crypto.randomUUID(),
        scopeMode: 'override',
        timeRangeMode: 'override'
      })

      await $fetch<any, string & {}>('/api/analytics/dashboards', {
        method: 'POST',
        body: {
          id: dashboard.id,
          name: dashboard.name,
          layout,
          scope: dashboard.scope || { target: 'self' }
        }
      })

      toast.add({ title: 'Workout analysis pinned to dashboard', color: 'success' })
    } catch (error) {
      console.error(error)
      toast.add({ title: 'Failed to pin workout analysis', color: 'error' })
    } finally {
      saving.value = false
    }
  }
</script>

<template>
  <UDashboardPanel id="analytics-workout-explorer">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #title>
          <CoachingNavbarLinks />
        </template>
        <template #right>
          <div class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-arrow-left"
              size="sm"
              class="font-bold"
              to="/analytics"
            >
              Back to Analytics
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-git-compare-arrows"
              size="sm"
              class="font-bold"
              to="/analytics/workout-comparison"
            >
              Comparison Mode
            </UButton>
            <UButton
              color="primary"
              variant="solid"
              icon="i-lucide-pin"
              size="sm"
              class="font-bold"
              :loading="saving"
              :disabled="!selectedWorkoutId"
              @click="
                () => {
                  void pinToDashboard()
                }
              "
            >
              Pin to Dashboard
            </UButton>
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex h-full min-h-0 overflow-hidden">
        <aside class="w-[25rem] shrink-0 border-r border-default bg-default/80">
          <div class="flex h-full flex-col gap-4 p-4">
            <div
              class="inline-flex w-full items-center rounded-2xl border border-default bg-muted/20 p-1"
            >
              <UButton
                size="sm"
                :color="leftRailTab === 'workout' ? 'primary' : 'neutral'"
                :variant="leftRailTab === 'workout' ? 'soft' : 'ghost'"
                class="flex-1"
                @click="
                  () => {
                    leftRailTab = 'workout'
                  }
                "
              >
                Workout
              </UButton>
              <UButton
                size="sm"
                :color="leftRailTab === 'library' ? 'primary' : 'neutral'"
                :variant="leftRailTab === 'library' ? 'soft' : 'ghost'"
                class="flex-1"
                @click="
                  () => {
                    leftRailTab = 'library'
                  }
                "
              >
                Library
              </UButton>
            </div>

            <template v-if="leftRailTab === 'workout'">
              <div class="space-y-3">
                <div class="text-[10px] font-black uppercase tracking-[0.24em] text-muted">
                  Workout browser
                </div>

                <UInput
                  v-model="workoutSearch"
                  icon="i-heroicons-magnifying-glass"
                  placeholder="Search workouts"
                  size="sm"
                />

                <div class="grid grid-cols-2 gap-2">
                  <USelect v-model="athleteFilter" :items="athleteOptions" size="sm" />
                  <USelect v-model="workoutTypeFilter" :items="workoutTypeOptions" size="sm" />
                </div>

                <div v-if="showAdvanced" class="grid grid-cols-2 gap-2">
                  <USelect v-model="workoutSourceFilter" :items="workoutSourceOptions" size="sm" />
                  <UInput v-model="startDateFilter" type="date" size="sm" />
                  <UInput v-model="endDateFilter" type="date" size="sm" />
                </div>

                <div class="flex items-center justify-between">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    @click="
                      () => {
                        showAdvanced = !showAdvanced
                      }
                    "
                  >
                    {{ showAdvanced ? 'Hide Filters' : 'More Filters' }}
                  </UButton>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    @click="
                      () => {
                        void resetWorkoutFilters()
                      }
                    "
                  >
                    Reset
                  </UButton>
                </div>
              </div>

              <div class="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                <div v-for="workout in browserWorkouts" :key="workout.id" class="relative group">
                  <button
                    class="w-full rounded-2xl border p-3 text-left transition hover:border-primary/50"
                    :class="
                      selectedWorkoutId === workout.id
                        ? 'border-primary/60 bg-primary/5'
                        : 'border-default/70 bg-default'
                    "
                    @click="
                      () => {
                        void selectWorkout(workout)
                      }
                    "
                  >
                    <div class="flex items-center gap-3">
                      <UAvatar :icon="workoutTypeIcon(workout.type)" size="md" />
                      <div class="min-w-0 flex-1">
                        <div class="truncate font-bold text-highlighted pr-8">
                          {{ workout.title }}
                        </div>
                        <div class="text-xs text-muted">
                          {{ workout.user?.name || workout.user?.email || 'Athlete' }} ·
                          {{ formatDateLabel(workout.date) }}
                        </div>
                        <div
                          class="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-muted"
                        >
                          <span>{{ workout.type || 'Workout' }}</span>
                          <span>{{ formatDuration(workout.durationSec) }}</span>
                          <span>{{ formatDistance(workout.distanceMeters) }}</span>
                          <span>{{ formatLoad(workout.trainingLoad || workout.tss) }}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                  <UButton
                    :color="comparisonStore.isSelected(workout.id) ? 'primary' : 'neutral'"
                    :variant="comparisonStore.isSelected(workout.id) ? 'solid' : 'ghost'"
                    size="xs"
                    icon="i-lucide-git-compare-arrows"
                    class="absolute right-3 top-3 opacity-0 group-hover:opacity-100 transition-opacity"
                    :class="{ 'opacity-100': comparisonStore.isSelected(workout.id) }"
                    @click.stop="toggleComparison(workout)"
                  />
                </div>

                <div v-if="loadingBrowser" class="space-y-2">
                  <USkeleton v-for="i in 4" :key="i" class="h-20 rounded-2xl" />
                </div>

                <div
                  v-else-if="browserWorkouts.length === 0"
                  class="rounded-2xl border border-dashed border-default/70 bg-default p-4 text-sm text-muted"
                >
                  No workouts match the current search.
                </div>
              </div>
            </template>

            <template v-else>
              <div class="space-y-3">
                <div class="text-[10px] font-black uppercase tracking-[0.24em] text-muted">
                  Workout analysis library
                </div>

                <UInput
                  v-model="librarySearch"
                  icon="i-heroicons-magnifying-glass"
                  placeholder="Search workout analysis charts"
                  size="sm"
                />

                <div class="flex flex-wrap gap-1.5">
                  <UButton
                    size="xs"
                    :color="activeCategory === 'all' ? 'primary' : 'neutral'"
                    :variant="activeCategory === 'all' ? 'soft' : 'outline'"
                    class="rounded-full"
                    @click="
                      () => {
                        activeCategory = 'all'
                      }
                    "
                  >
                    All
                  </UButton>
                  <UButton
                    v-for="category in WORKOUT_EXPLORER_CATEGORIES"
                    :key="category.value"
                    size="xs"
                    :color="activeCategory === category.value ? 'primary' : 'neutral'"
                    :variant="activeCategory === category.value ? 'soft' : 'outline'"
                    class="rounded-full"
                    @click="
                      () => {
                        activeCategory = category.value
                      }
                    "
                  >
                    {{ category.label }}
                  </UButton>
                </div>
              </div>

              <div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <div v-for="category in groupedPresets" :key="category.value" class="space-y-2">
                  <div class="text-[10px] font-black uppercase tracking-[0.24em] text-muted">
                    {{ category.label }}
                  </div>

                  <button
                    v-for="preset in category.presets"
                    :key="preset.id"
                    class="w-full rounded-2xl border p-3 text-left transition hover:border-primary/50"
                    :class="
                      selectedPreset.id === preset.id
                        ? 'border-primary/60 bg-primary/5'
                        : 'border-default/70 bg-default'
                    "
                    @click="
                      () => {
                        void applyPreset(preset)
                      }
                    "
                  >
                    <div class="flex items-start gap-3">
                      <div class="rounded-xl border border-default/70 bg-muted/20 p-2">
                        <UIcon :name="presetIcon(preset)" class="h-4 w-4 text-primary-500" />
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <div class="truncate font-bold text-highlighted">{{ preset.name }}</div>
                          <UBadge v-if="preset.flagship" size="xs" color="primary" variant="soft">
                            Featured
                          </UBadge>
                        </div>
                        <p class="mt-1 text-xs text-muted">{{ preset.description }}</p>
                      </div>
                    </div>
                  </button>
                </div>

                <div
                  v-if="groupedPresets.length === 0"
                  class="rounded-2xl border border-dashed border-default/70 bg-default p-4 text-sm text-muted"
                >
                  No workout analysis presets match the current search.
                </div>
              </div>
            </template>
          </div>
        </aside>

        <main class="min-w-0 flex-1 overflow-y-auto bg-muted/10">
          <div class="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
            <div class="rounded-3xl border border-default bg-default/90 p-6 shadow-sm">
              <div class="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                <div class="space-y-3">
                  <div class="flex items-center gap-2">
                    <UBadge color="primary" variant="soft" size="sm">Workout Explorer</UBadge>
                    <UBadge color="neutral" variant="outline" size="sm">{{
                      selectedCategoryLabel
                    }}</UBadge>
                    <UBadge color="neutral" variant="outline" size="sm">{{
                      selectedModeLabel
                    }}</UBadge>

                    <UButton
                      v-if="selectedWorkout"
                      :color="
                        comparisonStore.isSelected(selectedWorkoutId!) ? 'primary' : 'neutral'
                      "
                      variant="subtle"
                      size="xs"
                      icon="i-lucide-git-compare-arrows"
                      class="ml-auto font-bold"
                      @click="
                        () => {
                          void toggleComparison(selectedWorkout)
                        }
                      "
                    >
                      {{
                        comparisonStore.isSelected(selectedWorkoutId!)
                          ? 'In Comparison'
                          : 'Add to Compare'
                      }}
                    </UButton>
                  </div>

                  <div v-if="selectedWorkout" class="space-y-2">
                    <h1 class="text-2xl font-black tracking-tight text-highlighted">
                      {{ selectedWorkout.title }}
                    </h1>
                    <p class="text-sm text-muted">
                      {{ selectedWorkout.athleteName }} ·
                      {{ formatDateLabel(selectedWorkout.date) }}
                    </p>
                    <div
                      class="flex flex-wrap items-center gap-x-6 gap-y-2 text-[10px] font-black uppercase tracking-widest text-neutral-400"
                    >
                      <div class="flex items-center gap-1.5">
                        <UIcon :name="workoutTypeIcon(selectedWorkout.type)" class="h-3.5 w-3.5" />
                        Type:
                        <span class="text-neutral-600 dark:text-neutral-200">
                          {{ selectedWorkout.type || 'Workout' }}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <UIcon name="i-lucide-database" class="h-3.5 w-3.5" />
                        Source:
                        <span class="text-neutral-600 dark:text-neutral-200">
                          {{ selectedWorkout.source || 'Unknown' }}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <UIcon name="i-lucide-timer" class="h-3.5 w-3.5" />
                        Duration:
                        <span class="text-neutral-600 dark:text-neutral-200">
                          {{
                            formatDuration(
                              selectedWorkout.durationSec || selectedWorkout.elapsedTimeSec
                            )
                          }}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <UIcon name="i-lucide-route" class="h-3.5 w-3.5" />
                        Distance:
                        <span class="text-neutral-600 dark:text-neutral-200">
                          {{ formatDistance(selectedWorkout.distanceMeters) }}
                        </span>
                      </div>
                      <div
                        v-if="
                          selectedWorkout.elevationGain !== null &&
                          selectedWorkout.elevationGain !== undefined
                        "
                        class="flex items-center gap-1.5"
                      >
                        <UIcon name="i-lucide-mountain" class="h-3.5 w-3.5" />
                        Elevation:
                        <span class="text-neutral-600 dark:text-neutral-200">
                          {{ formatMeters(selectedWorkout.elevationGain) }}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <UIcon name="i-lucide-flame" class="h-3.5 w-3.5" />
                        Load:
                        <span class="text-neutral-600 dark:text-neutral-200">
                          {{ formatLoad(selectedWorkout.trainingLoad || selectedWorkout.tss) }}
                        </span>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <UIcon name="i-lucide-chart-column" class="h-3.5 w-3.5" />
                        View:
                        <span class="text-neutral-600 dark:text-neutral-200">
                          {{ selectedWorkoutSourceLabel }}
                        </span>
                      </div>
                    </div>
                    <div
                      v-if="workoutHeadlineStats.length"
                      class="grid gap-3 pt-2 sm:grid-cols-2 xl:grid-cols-3"
                    >
                      <div
                        v-for="stat in workoutHeadlineStats"
                        :key="stat.label"
                        class="rounded-2xl border border-default/70 bg-muted/20 p-3"
                      >
                        <div
                          class="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-muted"
                        >
                          <UIcon :name="stat.icon" class="h-3.5 w-3.5" />
                          {{ stat.label }}
                        </div>
                        <div class="mt-2 text-lg font-bold text-highlighted">
                          {{ stat.value }}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div v-else-if="selectedWorkoutUnavailable" class="space-y-2">
                    <h1 class="text-2xl font-black tracking-tight text-highlighted">
                      Workout Unavailable
                    </h1>
                    <p class="max-w-2xl text-sm text-muted">
                      The selected workout could not be loaded or is no longer accessible. Choose a
                      different workout from the browser to continue.
                    </p>
                  </div>

                  <div v-else class="space-y-2">
                    <h1 class="text-2xl font-black tracking-tight text-highlighted">
                      Choose a Workout to Explore
                    </h1>
                    <p class="max-w-2xl text-sm text-muted">
                      Pick a single workout from the browser, then use the preset library to inspect
                      its summary, zones, streams, terrain, and intervals.
                    </p>
                  </div>
                </div>

                <div class="max-w-sm rounded-2xl border border-default/70 bg-muted/20 p-4">
                  <div class="text-[10px] font-black uppercase tracking-[0.2em] text-muted">
                    Current Preset
                  </div>
                  <div class="mt-2 text-base font-bold text-highlighted">
                    {{ selectedPreset.name }}
                  </div>
                  <p class="mt-1 text-sm text-muted">{{ selectedPreset.description }}</p>
                  <p class="mt-3 text-xs text-muted">{{ selectedPreset.insightCopy }}</p>
                </div>
              </div>
            </div>

            <div
              v-if="selectedPreset.mode === 'summary' && canToggleSummaryChartType"
              class="flex flex-wrap items-center gap-2"
            >
              <UButton
                size="xs"
                :color="summaryChartType === 'bar' ? 'primary' : 'neutral'"
                :variant="summaryChartType === 'bar' ? 'soft' : 'outline'"
                @click="
                  () => {
                    summaryChartType = 'bar'
                  }
                "
              >
                Bar
              </UButton>
              <UButton
                size="xs"
                :color="summaryChartType === 'line' ? 'primary' : 'neutral'"
                :variant="summaryChartType === 'line' ? 'soft' : 'outline'"
                @click="
                  () => {
                    summaryChartType = 'line'
                  }
                "
              >
                Line
              </UButton>
            </div>

            <div
              v-else-if="selectedPreset.mode === 'stream'"
              class="flex flex-wrap items-center gap-2"
            >
              <USelect
                v-if="supportsStreamFieldSelection"
                v-model="streamField"
                :items="streamFieldOptions"
                size="sm"
                class="w-44"
              />
              <div v-else class="flex flex-wrap items-center gap-2">
                <UBadge
                  v-for="field in selectedStreamFields"
                  :key="field"
                  color="neutral"
                  variant="soft"
                  size="sm"
                >
                  {{ streamFieldOptionMap[field] }}
                </UBadge>
              </div>
              <USelect
                v-model="streamAlignment"
                :items="[
                  { label: 'Elapsed Time', value: 'elapsed_time' },
                  { label: 'Distance', value: 'distance' },
                  { label: 'Percent Complete', value: 'percent_complete' }
                ]"
                size="sm"
                class="w-44"
              />
              <div
                v-if="selectedPreset.visualType === 'combo'"
                class="text-[10px] font-bold uppercase tracking-[0.16em] text-muted"
              >
                Dual-axis linked view
              </div>
              <UButton
                v-if="activeRange"
                size="xs"
                color="neutral"
                variant="soft"
                icon="i-lucide-x"
                @click="
                  () => {
                    activeRange = null
                  }
                "
              >
                Clear Selection
              </UButton>
            </div>

            <div
              v-else-if="selectedPreset.mode === 'interval'"
              class="flex flex-wrap items-center gap-2"
            >
              <USelect
                v-model="intervalField"
                :items="[
                  { label: 'Average Power', value: 'avgPower' },
                  { label: 'Average Heart Rate', value: 'avgHr' },
                  { label: 'Duration', value: 'duration' },
                  { label: 'Distance', value: 'distance' }
                ]"
                size="sm"
                class="w-52"
              />
            </div>

            <UCard :ui="{ body: 'p-0 sm:p-0 overflow-hidden' }">
              <template #header>
                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-xs font-black uppercase tracking-widest text-neutral-500">
                      {{ selectedPreset.name }}
                    </div>
                    <div class="mt-1 text-sm text-muted">
                      {{ selectedPreset.sourceLabel }}
                    </div>
                  </div>
                  <UButton
                    size="sm"
                    color="primary"
                    variant="soft"
                    icon="i-lucide-plus"
                    :disabled="!selectedWorkoutId"
                    @click="
                      () => {
                        void pinCurrentChartToExplorer()
                      }
                    "
                  >
                    Pin to Explorer
                  </UButton>
                </div>
              </template>

              <div class="h-[360px]">
                <div
                  v-if="!selectedWorkoutId"
                  class="flex h-full items-center justify-center p-6 text-center text-sm text-muted"
                >
                  Select a workout from the browser to start exploring its charts.
                </div>
                <div
                  v-else-if="selectedWorkoutUnavailable"
                  class="flex h-full items-center justify-center p-6 text-center text-sm text-muted"
                >
                  This workout is unavailable. Choose another one from the browser to continue.
                </div>
                <AnalyticsBaseWidget
                  v-else-if="previewConfig"
                  :key="`${selectedPreset.id}-${selectedWorkoutId}-${previewConfig.visualType}`"
                  :config="previewConfig"
                />
              </div>
            </UCard>

            <UCard v-if="selectedWorkoutId" :ui="{ body: 'p-4 sm:p-4' }">
              <template #header>
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div class="text-xs font-black uppercase tracking-widest text-neutral-500">
                      Pinned Charts
                    </div>
                    <div class="mt-1 text-sm text-muted">
                      Stack supporting charts here to build a deeper read on this workout.
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <UBadge color="neutral" variant="outline" size="sm">
                      {{ pinnedChartConfigs.length }} pinned
                    </UBadge>
                    <UButton
                      v-if="pinnedChartConfigs.length"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      @click="
                        () => {
                          void clearPinnedCharts()
                        }
                      "
                    >
                      Clear
                    </UButton>
                  </div>
                </div>
              </template>

              <div v-if="pinnedChartConfigs.length" class="space-y-4">
                <UCard
                  v-for="(entry, index) in pinnedChartConfigs"
                  :key="entry.chart.id"
                  :ui="{ body: 'p-0 sm:p-0 overflow-hidden' }"
                >
                  <template #header>
                    <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <div class="text-sm font-bold text-highlighted">
                          {{ entry.preset.name }}
                        </div>
                        <div class="mt-1 text-xs text-muted">
                          {{ entry.preset.sourceLabel }} · {{ entry.preset.description }}
                        </div>
                      </div>
                      <div class="flex items-center gap-2">
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="outline"
                          icon="i-lucide-arrow-up"
                          :disabled="index === 0"
                          @click="
                            () => {
                              void movePinnedChart(entry.chart.id, -1)
                            }
                          "
                        >
                          Up
                        </UButton>
                        <UButton
                          size="xs"
                          color="neutral"
                          variant="outline"
                          icon="i-lucide-arrow-down"
                          :disabled="index === pinnedChartConfigs.length - 1"
                          @click="
                            () => {
                              void movePinnedChart(entry.chart.id, 1)
                            }
                          "
                        >
                          Down
                        </UButton>
                        <UButton
                          size="xs"
                          color="error"
                          variant="ghost"
                          icon="i-lucide-trash-2"
                          @click="
                            () => {
                              void removePinnedChart(entry.chart.id)
                            }
                          "
                        >
                          Remove
                        </UButton>
                      </div>
                    </div>
                  </template>

                  <div class="h-[320px]">
                    <AnalyticsBaseWidget
                      :key="`${entry.chart.id}-${entry.config.visualType}`"
                      :config="entry.config"
                    />
                  </div>
                </UCard>
              </div>

              <div
                v-else
                class="rounded-2xl border border-dashed border-default/70 bg-muted/10 p-6 text-sm text-muted"
              >
                Pin charts from the main preview to stack them here for deeper single-workout
                analysis.
              </div>
            </UCard>
          </div>
        </main>
      </div>
    </template>
  </UDashboardPanel>

  <ClientOnly>
    <WorkoutsWorkoutComparisonDock />
  </ClientOnly>
</template>
