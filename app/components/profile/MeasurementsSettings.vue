<template>
  <div class="space-y-6">
    <UCard :ui="profileSettingsCardUi">
      <template #header>
        <div>
          <h3 class="text-lg font-medium leading-6 text-gray-900 dark:text-white">
            {{ t('measurements_title') }}
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {{ t('measurements_description') }}
          </p>
        </div>
      </template>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UFormField :label="t('measurements_form_measurement')">
          <USelectMenu
            v-model="selectedMetric"
            :items="metricOptions"
            value-key="value"
            label-key="label"
            class="w-full"
          />
        </UFormField>

        <UFormField v-if="selectedMetric === 'custom'" :label="t('measurements_form_custom_name')">
          <UInput
            v-model="customName"
            :placeholder="t('measurements_form_custom_name_placeholder')"
            class="w-full"
          />
        </UFormField>

        <UFormField
          v-if="selectedMetric === 'custom'"
          :label="t('measurements_form_measurement_type')"
        >
          <USelectMenu
            v-model="customUnitKind"
            :items="customUnitOptions"
            value-key="value"
            label-key="label"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('measurements_form_value')">
          <div
            v-if="selectedMetricCategory === 'height' && prefersImperialHeight"
            class="grid grid-cols-2 gap-3"
          >
            <UInput
              v-model.number="heightFt"
              type="number"
              step="1"
              :placeholder="selectedHeightPlaceholder.ft"
              class="w-full"
            >
              <template #trailing>
                <span class="text-gray-500 dark:text-gray-400 text-xs">ft</span>
              </template>
            </UInput>
            <UInput
              v-model.number="heightIn"
              type="number"
              step="1"
              :placeholder="selectedHeightPlaceholder.in"
              class="w-full"
            >
              <template #trailing>
                <span class="text-gray-500 dark:text-gray-400 text-xs">in</span>
              </template>
            </UInput>
          </div>
          <UInput
            v-else
            v-model.number="value"
            type="number"
            step="0.1"
            :placeholder="selectedValuePlaceholder"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('measurements_form_unit')">
          <UInput
            :model-value="selectedUnitLabel"
            disabled
            class="w-full bg-gray-50 dark:bg-gray-800"
          />
        </UFormField>

        <UFormField :label="t('measurements_form_recorded_at')">
          <UInput v-model="recordedAt" type="datetime-local" class="w-full" />
        </UFormField>

        <UFormField :label="t('measurements_form_notes')">
          <UInput
            v-model="notes"
            :placeholder="t('measurements_form_notes_placeholder')"
            class="w-full"
          />
        </UFormField>
      </div>

      <div class="pt-4 flex justify-end">
        <UButton
          :loading="saving"
          color="primary"
          @click="
            () => {
              void saveMeasurement()
            }
          "
        >
          {{ t('measurements_button_add') }}
        </UButton>
      </div>
    </UCard>

    <UCard :ui="profileSettingsCardUi">
      <template #header>
        <h3 class="text-lg font-medium leading-6 text-gray-900 dark:text-white">
          {{ t('measurements_latest_title') }}
        </h3>
      </template>

      <div v-if="latestEntries.length > 0" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div
          v-for="entry in latestEntries"
          :key="entry.id"
          class="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-gray-900 dark:text-white">
                {{ formatMetricName(entry) }}
              </p>
              <p class="text-lg font-semibold text-gray-900 dark:text-white">
                {{ formatValue(entry) }}
              </p>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {{ formatDateTime(entry.recordedAt) }}
              </p>
            </div>
            <UBadge
              variant="soft"
              :color="entry.source === 'manual_measurement' ? 'primary' : 'neutral'"
            >
              {{ formatSource(entry.source) }}
            </UBadge>
          </div>

          <div v-if="getMetricSourceOptions(entry.metricKey).length > 1" class="pt-3">
            <UFormField
              :label="t('measurements_form_preferred_source')"
              :description="t('measurements_form_preferred_source_desc')"
            >
              <USelectMenu
                :model-value="getSelectedSource(entry.metricKey)"
                :items="getMetricSourceOptions(entry.metricKey)"
                value-key="value"
                label-key="label"
                class="w-full"
                @update:model-value="
                  (value) => updatePreferredSource(entry.metricKey, String(value))
                "
              />
            </UFormField>
          </div>
        </div>
      </div>
      <p v-else class="text-sm text-gray-500 dark:text-gray-400">
        {{ t('measurements_empty_latest') }}
      </p>
    </UCard>

    <UCard :ui="profileSettingsCardUi">
      <template #header>
        <h3 class="text-lg font-medium leading-6 text-gray-900 dark:text-white">
          {{ t('measurements_history_title') }}
        </h3>
      </template>

      <div v-if="entries.length > 0" class="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <UFormField :label="t('measurements_form_measurement')">
          <USelectMenu
            v-model="historyMetricFilter"
            :items="historyMetricFilterOptions"
            value-key="value"
            label-key="label"
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('measurements_form_source')">
          <USelectMenu
            v-model="historySourceFilter"
            :items="historySourceFilterOptions"
            value-key="value"
            label-key="label"
            class="w-full"
          />
        </UFormField>
      </div>

      <div v-if="filteredEntries.length > 0" class="overflow-x-auto">
        <UTable
          :data="filteredEntries"
          :columns="historyColumns"
          :ui="{
            root: 'w-full',
            base: 'w-full table-auto',
            th: 'text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider px-4 py-3',
            td: 'text-sm text-gray-900 dark:text-gray-100 px-4 py-3 align-top',
            tbody: 'divide-y divide-gray-200 dark:divide-gray-800'
          }"
        >
          <template #metricKey-cell="{ row }">
            <span class="font-medium text-gray-900 dark:text-white">
              {{ formatMetricName(row.original) }}
            </span>
          </template>

          <template #value-cell="{ row }">
            <div class="group flex items-center gap-2">
              <span>{{ formatValue(row.original) }}</span>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-heroicons-pencil-square"
                class="text-gray-400 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
                :loading="editingId === row.original.id"
                @click="
                  () => {
                    void openEditModal(row.original)
                  }
                "
              />
            </div>
          </template>

          <template #recordedAt-cell="{ row }">
            {{ formatDateTime(row.original.recordedAt) }}
          </template>

          <template #source-cell="{ row }">
            <UBadge
              variant="soft"
              :color="row.original.source === 'manual_measurement' ? 'primary' : 'neutral'"
            >
              {{ formatSource(row.original.source) }}
            </UBadge>
          </template>

          <template #notes-cell="{ row }">
            <div class="group flex items-start gap-2">
              <span class="text-xs text-gray-500 dark:text-gray-400">
                {{ row.original.notes || '-' }}
              </span>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-heroicons-pencil-square"
                class="text-gray-400 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
                :loading="editingId === row.original.id"
                @click="
                  () => {
                    void openEditModal(row.original)
                  }
                "
              />
            </div>
          </template>

          <template #actions-cell="{ row }">
            <div class="group flex justify-end">
              <UButton
                color="error"
                variant="ghost"
                size="xs"
                icon="i-heroicons-trash"
                class="opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
                :loading="deletingId === row.original.id"
                @click="
                  () => {
                    void deleteMeasurement(row.original)
                  }
                "
              >
                {{ t('measurements_button_delete') }}
              </UButton>
            </div>
          </template>
        </UTable>

        <div v-if="hasMoreEntries" class="flex justify-center pt-4">
          <UButton
            color="neutral"
            variant="soft"
            :loading="loadingMore"
            @click="
              () => {
                void loadMoreMeasurements()
              }
            "
          >
            {{ tr('measurements_button_load_more', 'Load Older Entries') }}
          </UButton>
        </div>
      </div>
      <p v-if="entries.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
        {{ t('measurements_empty_history') }}
      </p>
      <p v-else-if="filteredEntries.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
        {{ t('measurements_empty_filtered') }}
      </p>
    </UCard>

    <UModal
      v-model:open="showEditModal"
      :title="t('measurements_modal_edit_title')"
      :description="t('measurements_modal_edit_desc')"
    >
      <template #body>
        <div class="space-y-4">
          <div>
            <p class="text-sm font-medium text-gray-900 dark:text-white">
              {{ editingEntry ? formatMetricName(editingEntry) : '' }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ editingEntry ? formatDateTime(editingEntry.recordedAt) : '' }}
            </p>
          </div>

          <UFormField :label="t('measurements_form_value')">
            <div
              v-if="editingEntry?.metricKey === 'height' && prefersImperialHeight"
              class="grid grid-cols-2 gap-3"
            >
              <UInput v-model.number="editHeightFt" type="number" step="1" class="w-full">
                <template #trailing>
                  <span class="text-gray-500 dark:text-gray-400 text-xs">ft</span>
                </template>
              </UInput>
              <UInput v-model.number="editHeightIn" type="number" step="1" class="w-full">
                <template #trailing>
                  <span class="text-gray-500 dark:text-gray-400 text-xs">in</span>
                </template>
              </UInput>
            </div>
            <UInput v-else v-model.number="editValue" type="number" step="0.1" class="w-full">
              <template #trailing>
                <span class="text-gray-500 dark:text-gray-400 text-xs">
                  {{
                    editingEntry
                      ? getDisplayUnitLabel(editingEntry.metricKey, editingEntry.unit)
                      : ''
                  }}
                </span>
              </template>
            </UInput>
          </UFormField>

          <UFormField :label="t('measurements_form_notes')">
            <UTextarea
              v-model="editNotes"
              :rows="3"
              autoresize
              :placeholder="t('measurements_form_notes_placeholder')"
              class="w-full"
            />
          </UFormField>
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            @click="
              () => {
                showEditModal = false
              }
            "
            >{{ t('measurements_button_cancel') }}</UButton
          >
          <UButton
            color="primary"
            :loading="savingEdit"
            @click="
              () => {
                void saveEdit()
              }
            "
            >{{ t('measurements_button_save') }}</UButton
          >
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
  import { useTranslate } from '@tolgee/vue'
  import { profileSettingsCardUi } from '~/utils/mobile-surface-ui'
  import { cmToFtIn, ftInToCm, LBS_TO_KG } from '~/utils/metrics'

  const { t } = useTranslate('profile')
  const tr = (key: string, fallback: string, params?: Record<string, any>) => {
    if (typeof t.value !== 'function') return fallback
    const translated = t.value(key, params)
    return translated === key ? fallback : translated
  }

  const toast = useToast()
  const { formatDateUTC } = useFormat()
  const userStore = useUserStore()
  const PAGE_SIZE = 250

  const metricOptions = computed(() => [
    { label: tr('measurements_metric_weight', 'Weight'), value: 'weight', unit: 'kg' },
    { label: tr('measurements_metric_height', 'Height'), value: 'height', unit: 'cm' },
    { label: tr('measurements_metric_body_fat', 'Body Fat %'), value: 'body_fat_pct', unit: 'pct' },
    { label: tr('measurements_metric_neck', 'Neck'), value: 'neck', unit: 'cm' },
    { label: tr('measurements_metric_shoulders', 'Shoulders'), value: 'shoulders', unit: 'cm' },
    { label: tr('measurements_metric_waist', 'Waist'), value: 'waist', unit: 'cm' },
    { label: tr('measurements_metric_abdomen', 'Abdomen'), value: 'abdomen', unit: 'cm' },
    { label: tr('measurements_metric_hips', 'Hips'), value: 'hips', unit: 'cm' },
    { label: tr('measurements_metric_glutes', 'Glutes'), value: 'glutes', unit: 'cm' },
    { label: tr('measurements_metric_chest', 'Chest'), value: 'chest', unit: 'cm' },
    { label: tr('measurements_metric_underbust', 'Underbust'), value: 'underbust', unit: 'cm' },
    { label: tr('measurements_metric_left_arm', 'Left Arm'), value: 'left_arm', unit: 'cm' },
    { label: tr('measurements_metric_right_arm', 'Right Arm'), value: 'right_arm', unit: 'cm' },
    {
      label: tr('measurements_metric_left_forearm', 'Left Forearm'),
      value: 'left_forearm',
      unit: 'cm'
    },
    {
      label: tr('measurements_metric_right_forearm', 'Right Forearm'),
      value: 'right_forearm',
      unit: 'cm'
    },
    { label: tr('measurements_metric_left_wrist', 'Left Wrist'), value: 'left_wrist', unit: 'cm' },
    {
      label: tr('measurements_metric_right_wrist', 'Right Wrist'),
      value: 'right_wrist',
      unit: 'cm'
    },
    { label: tr('measurements_metric_left_thigh', 'Left Thigh'), value: 'left_thigh', unit: 'cm' },
    {
      label: tr('measurements_metric_right_thigh', 'Right Thigh'),
      value: 'right_thigh',
      unit: 'cm'
    },
    { label: tr('measurements_metric_left_calf', 'Left Calf'), value: 'left_calf', unit: 'cm' },
    { label: tr('measurements_metric_right_calf', 'Right Calf'), value: 'right_calf', unit: 'cm' },
    { label: tr('measurements_metric_left_ankle', 'Left Ankle'), value: 'left_ankle', unit: 'cm' },
    {
      label: tr('measurements_metric_right_ankle', 'Right Ankle'),
      value: 'right_ankle',
      unit: 'cm'
    },
    { label: tr('measurements_metric_inseam', 'Inseam'), value: 'inseam', unit: 'cm' },
    {
      label: tr('measurements_metric_muscle_mass', 'Muscle Mass'),
      value: 'muscle_mass_kg',
      unit: 'kg'
    },
    { label: tr('measurements_metric_bone_mass', 'Bone Mass'), value: 'bone_mass_kg', unit: 'kg' },
    { label: tr('measurements_metric_custom', 'Custom'), value: 'custom', unit: 'cm' }
  ])
  const customUnitOptions = computed(() => [
    { label: tr('measurements_unit_type_length', 'Length'), value: 'cm' },
    { label: tr('measurements_unit_type_mass', 'Mass'), value: 'kg' },
    { label: tr('measurements_unit_type_percentage', 'Percentage'), value: 'pct' }
  ])

  const selectedMetric = ref('waist')
  const customName = ref('')
  const value = ref<number | null>(null)
  const customUnitKind = ref<'cm' | 'kg' | 'pct'>('cm')
  const notes = ref('')
  const historyMetricFilter = ref('all')
  const historySourceFilter = ref('all')
  const saving = ref(false)
  const deletingId = ref<string | null>(null)
  const editingId = ref<string | null>(null)
  const savingEdit = ref(false)
  const showEditModal = ref(false)
  const editingEntry = ref<any | null>(null)
  const editValue = ref<number | null>(null)
  const editNotes = ref('')
  const heightFt = ref<number | null>(null)
  const heightIn = ref<number | null>(null)
  const editHeightFt = ref<number | null>(null)
  const editHeightIn = ref<number | null>(null)
  const recordedAt = ref(toDateTimeLocalInput(new Date()))
  const defaultMetricOption = { label: 'Weight', value: 'weight', unit: 'kg' as const }
  const entries = ref<any[]>([])
  const latestMetricEntries = ref<Record<string, any>>({})
  const latestMetricSourceEntries = ref<Record<string, Record<string, any>>>({})
  const hasMoreEntries = ref(false)
  const loadingMore = ref(false)
  const nextCursor = ref<{ recordedAt: string; id: string } | null>(null)
  const preferredSources = computed(
    () => userStore.user?.dashboardSettings?.bodyMetrics?.preferredSources || {}
  )
  const latestEntries = computed(() => {
    const resolved: any[] = []
    for (const [metricKey, latestEntry] of Object.entries(latestMetricEntries.value)) {
      const preferred = preferredSources.value?.[metricKey]
      const picked =
        (preferred ? latestMetricSourceEntries.value[metricKey]?.[preferred] : null) || latestEntry

      if (picked) resolved.push(picked)
    }

    return resolved.sort(
      (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime()
    )
  })
  const filteredEntries = computed(() =>
    entries.value.filter((entry) => {
      const matchesMetric =
        historyMetricFilter.value === 'all' || entry.metricKey === historyMetricFilter.value
      const matchesSource =
        historySourceFilter.value === 'all' ||
        normalizeSourceKey(entry.source) === historySourceFilter.value

      return matchesMetric && matchesSource
    })
  )
  const historyColumns = computed(() => [
    { accessorKey: 'metricKey', header: t.value('measurements_form_measurement') },
    { accessorKey: 'value', header: t.value('measurements_form_value') },
    { accessorKey: 'recordedAt', header: t.value('measurements_col_date') },
    { accessorKey: 'source', header: t.value('measurements_form_source') },
    { accessorKey: 'notes', header: t.value('measurements_form_notes') },
    { accessorKey: 'actions', header: '' }
  ])
  const selectedMetricConfig = computed(
    () =>
      metricOptions.value.find((option) => option.value === selectedMetric.value) ||
      metricOptions.value[0] ||
      defaultMetricOption
  )
  const prefersPounds = computed(() => userStore.profile?.weightUnits === 'Pounds')
  const prefersImperialHeight = computed(() => userStore.profile?.heightUnits === 'ft/in')
  const selectedMetricCategory = computed(() => getMetricCategory(selectedMetric.value))
  const selectedUnit = computed(() =>
    selectedMetric.value === 'custom' ? customUnitKind.value : selectedMetricConfig.value.unit
  )
  const selectedUnitLabel = computed(() => {
    return getDisplayUnitLabel(selectedMetric.value, selectedUnit.value)
  })
  const selectedMetricKey = computed(() => buildMetricKey())
  const selectedLatestEntry = computed(() => {
    if (selectedMetric.value === 'custom' && !customName.value.trim()) return null
    return latestMetricEntries.value[selectedMetricKey.value] || null
  })
  const selectedValuePlaceholder = computed(() => {
    if (!selectedLatestEntry.value) return ''
    if (selectedLatestEntry.value.metricKey === 'height' && prefersImperialHeight.value) return ''

    return String(
      toDisplayValue(
        selectedLatestEntry.value.value,
        selectedLatestEntry.value.metricKey,
        selectedLatestEntry.value.unit
      )
    )
  })
  const selectedHeightPlaceholder = computed(() => {
    if (!selectedLatestEntry.value || selectedLatestEntry.value.metricKey !== 'height') {
      return { ft: '', in: '' }
    }

    const { ft, in: inches } = cmToFtIn(selectedLatestEntry.value.value)
    return {
      ft: String(ft),
      in: String(inches)
    }
  })
  const historyMetricFilterOptions = computed(() => {
    const options = [{ label: t.value('measurements_filter_all_measurements'), value: 'all' }]
    for (const [metricKey, entry] of Object.entries(latestMetricEntries.value)) {
      options.push({
        label: formatMetricName(entry),
        value: metricKey
      })
    }

    return options
  })
  const historySourceFilterOptions = computed(() => {
    const options = [{ label: t.value('measurements_filter_all_sources'), value: 'all' }]
    const seen = new Set<string>()

    for (const sourceMap of Object.values(latestMetricSourceEntries.value)) {
      for (const entry of Object.values(sourceMap || {})) {
        const sourceKey = normalizeSourceKey(entry.source)
        if (seen.has(sourceKey)) continue
        seen.add(sourceKey)
        options.push({
          label: formatSource(entry.source),
          value: sourceKey
        })
      }
    }

    return options
  })

  async function loadMeasurements(options: { reset?: boolean } = {}) {
    const reset = options.reset ?? false
    const query: Record<string, string | number> = {
      limit: PAGE_SIZE
    }

    if (!reset && nextCursor.value) {
      query.cursorRecordedAt = nextCursor.value.recordedAt
      query.cursorId = nextCursor.value.id
    }

    const response = (await ($fetch as any)('/api/body-measurements', {
      query
    })) as {
      items?: any[]
      latestByMetric?: Record<string, any>
      latestByMetricSource?: Record<string, Record<string, any>>
      pageInfo?: {
        hasMore?: boolean
        nextCursor?: { recordedAt: string; id: string } | null
      }
    }

    latestMetricEntries.value = response.latestByMetric || {}
    latestMetricSourceEntries.value = response.latestByMetricSource || {}
    entries.value = reset ? response.items || [] : [...entries.value, ...(response.items || [])]
    hasMoreEntries.value = Boolean(response.pageInfo?.hasMore)
    nextCursor.value = response.pageInfo?.nextCursor || null
  }

  async function refreshMeasurements() {
    await loadMeasurements({ reset: true })
  }

  async function loadMoreMeasurements() {
    if (!hasMoreEntries.value || loadingMore.value) return

    loadingMore.value = true
    try {
      await loadMeasurements()
    } finally {
      loadingMore.value = false
    }
  }

  try {
    await refreshMeasurements()
  } catch (error: any) {
    console.error('Failed to load body measurements', error)
    toast.add({
      title: tr('measurements_toast_load_failed_title', 'Load Failed'),
      description:
        error.data?.statusMessage ||
        error.message ||
        tr('measurements_toast_load_failed_desc', 'Could not load measurement history.'),
      color: 'error'
    })
  }

  function formatMetricName(entry: any) {
    const knownMetric = metricOptions.value.find((option) => option.value === entry.metricKey)
    if (knownMetric) return knownMetric.label
    return entry.displayName || entry.metricKey.replace(/^custom:/, '').replace(/_/g, ' ')
  }

  function normalizeSourceKey(source: string) {
    if (source === 'profile_manual' || source === 'profile_locked') return 'profile'
    if (source === 'manual_measurement' || source === 'manual' || source === 'manual_edit')
      return 'manual'
    if (source.startsWith('oauth:')) return 'oauth'
    return source
  }

  function formatSource(source: string) {
    const normalized = normalizeSourceKey(source)
    if (normalized === 'profile') return t.value('measurements_source_profile')
    if (normalized === 'manual') return t.value('measurements_source_manual')
    if (normalized === 'oauth') return t.value('measurements_source_connected')

    return source
      .split(/[:_]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }

  function formatDate(value: string) {
    return formatDateUTC(value, 'yyyy-MM-dd')
  }

  function formatDateTime(value: string) {
    return formatDateUTC(value, 'yyyy-MM-dd HH:mm')
  }

  function formatValue(entry: any) {
    if (entry.metricKey === 'height' && prefersImperialHeight.value) {
      const { ft, in: inches } = cmToFtIn(entry.value)
      return `${ft} ft ${inches} in`
    }

    const displayValue = toDisplayValue(entry.value, entry.metricKey, entry.unit)
    const label = getDisplayUnitLabel(entry.metricKey, entry.unit)
    if (label === '%') return `${displayValue}%`
    return `${displayValue} ${label}`
  }

  function getMetricCategory(metricKey: string, canonicalUnit?: string) {
    if ((metricKey === 'custom' || metricKey.startsWith('custom:')) && canonicalUnit) {
      if (canonicalUnit === 'pct') return 'percent'
      if (canonicalUnit === 'kg') return 'mass'
      return 'length'
    }
    if (metricKey === 'height') return 'height'
    if (metricKey === 'body_fat_pct') return 'percent'
    if (['weight', 'muscle_mass_kg', 'bone_mass_kg'].includes(metricKey)) return 'mass'
    return 'length'
  }

  function getDisplayUnitLabel(metricKey: string, canonicalUnit: string) {
    const category = metricKey
      ? getMetricCategory(metricKey, canonicalUnit)
      : canonicalUnit === 'pct'
        ? 'percent'
        : canonicalUnit === 'kg'
          ? 'mass'
          : 'length'

    if (category === 'percent') return '%'
    if (category === 'mass') return prefersPounds.value ? 'lbs' : 'kg'
    if (category === 'height') return prefersImperialHeight.value ? 'ft/in' : 'cm'
    return prefersImperialHeight.value ? 'in' : 'cm'
  }

  function toDisplayValue(value: number, metricKey: string, canonicalUnit: string) {
    const category = metricKey
      ? getMetricCategory(metricKey, canonicalUnit)
      : canonicalUnit === 'pct'
        ? 'percent'
        : canonicalUnit === 'kg'
          ? 'mass'
          : 'length'
    if (category === 'mass' && prefersPounds.value) {
      return Number((value / LBS_TO_KG).toFixed(1))
    }
    if (category === 'length' && prefersImperialHeight.value) {
      return Number((value / 2.54).toFixed(1))
    }
    return Number(value.toFixed(1))
  }

  function fromDisplayValue(displayValue: number, metricKey: string, canonicalUnit: string) {
    const category = metricKey
      ? getMetricCategory(metricKey, canonicalUnit)
      : canonicalUnit === 'pct'
        ? 'percent'
        : canonicalUnit === 'kg'
          ? 'mass'
          : 'length'
    if (category === 'mass' && prefersPounds.value) {
      return Number((displayValue * LBS_TO_KG).toFixed(2))
    }
    if (category === 'length' && prefersImperialHeight.value) {
      return Number((displayValue * 2.54).toFixed(2))
    }
    return displayValue
  }

  function toDateTimeLocalInput(date: Date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    return local.toISOString().slice(0, 16)
  }

  function buildMetricKey() {
    if (selectedMetric.value !== 'custom') return selectedMetric.value

    const slug = customName.value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')

    return slug ? `custom:${slug}` : 'custom'
  }

  function getMetricSourceOptions(metricKey: string) {
    const sources = new Map<string, { label: string; value: string }>()
    const latestEntry = latestMetricEntries.value[metricKey]
    sources.set('auto', {
      label: latestEntry
        ? `${tr('measurements_source_auto_latest', 'Auto (latest)')} (${formatValue(latestEntry)})`
        : tr('measurements_source_auto_latest', 'Auto (latest)'),
      value: 'auto'
    })

    for (const [sourceKey, entry] of Object.entries(
      latestMetricSourceEntries.value[metricKey] || {}
    )) {
      if (sourceKey === 'auto' || sources.has(sourceKey)) continue
      sources.set(sourceKey, {
        label: `${formatSource(entry.source)} (${formatValue(entry)})`,
        value: sourceKey
      })
    }

    return [...sources.values()]
  }

  function getSelectedSource(metricKey: string) {
    return preferredSources.value?.[metricKey] || 'auto'
  }

  async function updatePreferredSource(metricKey: string, value: string) {
    const currentDashboardSettings = userStore.user?.dashboardSettings || {}
    const currentBodyMetrics = currentDashboardSettings.bodyMetrics || {}
    const currentPreferredSources = { ...(currentBodyMetrics.preferredSources || {}) }

    let nextPreferredSources = currentPreferredSources
    if (value === 'auto') {
      const { [metricKey]: _removed, ...rest } = currentPreferredSources
      nextPreferredSources = rest
    } else {
      nextPreferredSources = {
        ...currentPreferredSources,
        [metricKey]: value
      }
    }

    await userStore.updateDashboardSettings({
      bodyMetrics: {
        ...currentBodyMetrics,
        preferredSources: nextPreferredSources
      }
    })
  }

  async function saveMeasurement() {
    const imperialHeight = selectedMetricCategory.value === 'height' && prefersImperialHeight.value
    const feet =
      heightFt.value == null || String(heightFt.value).trim() === '' ? 0 : Number(heightFt.value)
    const inches =
      heightIn.value == null || String(heightIn.value).trim() === '' ? 0 : Number(heightIn.value)
    if (
      (imperialHeight &&
        (!Number.isFinite(feet) ||
          !Number.isFinite(inches) ||
          feet < 0 ||
          inches < 0 ||
          feet * 12 + inches <= 0)) ||
      (selectedMetricCategory.value === 'height' && !prefersImperialHeight.value && !value.value) ||
      (selectedMetricCategory.value !== 'height' && !value.value)
    ) {
      toast.add({
        title: t.value('measurements_toast_missing_value_title'),
        description: t.value('measurements_toast_missing_value_desc'),
        color: 'error'
      })
      return
    }

    if (selectedMetric.value === 'custom' && !customName.value.trim()) {
      toast.add({
        title: t.value('measurements_toast_missing_name_title'),
        description: t.value('measurements_toast_missing_name_desc'),
        color: 'error'
      })
      return
    }

    saving.value = true
    try {
      const canonicalValue =
        selectedMetricCategory.value === 'height' && prefersImperialHeight.value
          ? ftInToCm(heightFt.value || 0, heightIn.value || 0)
          : fromDisplayValue(value.value || 0, buildMetricKey(), selectedUnit.value)

      await $fetch<any, string & {}>('/api/body-measurements', {
        method: 'POST',
        body: {
          recordedAt: new Date(recordedAt.value).toISOString(),
          metricKey: buildMetricKey(),
          displayName: selectedMetric.value === 'custom' ? customName.value.trim() : null,
          value: canonicalValue,
          unit: selectedUnit.value,
          notes: notes.value || null
        }
      })

      value.value = null
      notes.value = ''
      customName.value = ''
      customUnitKind.value = 'cm'
      heightFt.value = null
      heightIn.value = null
      recordedAt.value = toDateTimeLocalInput(new Date())
      await refreshMeasurements()

      toast.add({
        title: t.value('measurements_toast_added_title'),
        description: t.value('measurements_toast_added_desc'),
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: t.value('measurements_toast_save_failed_title'),
        description:
          error.data?.statusMessage ||
          error.message ||
          t.value('measurements_toast_save_failed_desc'),
        color: 'error'
      })
    } finally {
      saving.value = false
    }
  }

  async function deleteMeasurement(entry: any) {
    deletingId.value = entry.id
    try {
      await $fetch<any, string & {}>(`/api/body-measurements/${entry.id}`, {
        method: 'PATCH',
        body: {
          isDeleted: true
        }
      })

      await refreshMeasurements()
      toast.add({
        title: t.value('measurements_toast_deleted_title'),
        description: t.value('measurements_toast_deleted_desc'),
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: t.value('measurements_toast_delete_failed_title'),
        description:
          error.data?.statusMessage ||
          error.message ||
          t.value('measurements_toast_delete_failed_desc'),
        color: 'error'
      })
    } finally {
      deletingId.value = null
    }
  }

  function openEditModal(entry: any) {
    editingId.value = entry.id
    editingEntry.value = entry
    editNotes.value = entry.notes || ''
    if (entry.metricKey === 'height' && prefersImperialHeight.value) {
      const { ft, in: inches } = cmToFtIn(entry.value)
      editHeightFt.value = ft
      editHeightIn.value = inches
      editValue.value = null
    } else {
      editValue.value = toDisplayValue(entry.value, entry.metricKey, entry.unit)
      editHeightFt.value = null
      editHeightIn.value = null
    }
    showEditModal.value = true
  }

  async function saveEdit() {
    if (
      !editingEntry.value ||
      (editingEntry.value.metricKey === 'height'
        ? prefersImperialHeight.value
          ? editHeightFt.value == null && editHeightIn.value == null
          : editValue.value == null
        : editValue.value == null)
    ) {
      toast.add({
        title: t.value('measurements_toast_missing_value_title'),
        description: t.value('measurements_toast_missing_edit_value_desc'),
        color: 'error'
      })
      return
    }

    savingEdit.value = true
    try {
      const nextValue =
        editingEntry.value.metricKey === 'height' && prefersImperialHeight.value
          ? ftInToCm(editHeightFt.value || 0, editHeightIn.value || 0)
          : fromDisplayValue(
              editValue.value || 0,
              editingEntry.value.metricKey,
              editingEntry.value.unit
            )
      await $fetch<any, string & {}>(`/api/body-measurements/${editingEntry.value.id}`, {
        method: 'PATCH',
        body: {
          value: nextValue,
          notes: editNotes.value.trim() || null
        }
      })

      await refreshMeasurements()
      showEditModal.value = false
      toast.add({
        title: t.value('measurements_toast_updated_title'),
        description: t.value('measurements_toast_updated_desc'),
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: t.value('measurements_toast_update_failed_title'),
        description:
          error.data?.statusMessage ||
          error.message ||
          t.value('measurements_toast_update_failed_desc'),
        color: 'error'
      })
    } finally {
      savingEdit.value = false
      editingId.value = null
    }
  }
</script>
