<template>
  <UModal
    v-model:open="isOpen"
    title="Deduplicate Activities"
    :ui="{ content: 'sm:max-w-2xl' }"
    :prevent-close="isLoading"
    description="Identify and merge duplicate activity records."
  >
    <template #body>
      <div class="space-y-4">
        <!-- Idle / Initial State -->
        <div v-if="state === 'idle'" class="text-center py-4">
          <UIcon
            name="i-heroicons-document-duplicate"
            class="w-12 h-12 mx-auto text-gray-400 mb-2"
          />
          <p class="text-gray-600 dark:text-gray-300">
            Scan your activity history for duplicate workouts. We'll identify similar activities
            based on time, duration, and metadata, and let you review them before merging.
          </p>
        </div>

        <!-- Scanning / Processing State -->
        <div v-else-if="state === 'scanning' || state === 'processing'" class="text-center py-8">
          <UIcon
            name="i-heroicons-arrow-path"
            class="w-10 h-10 mx-auto animate-spin text-primary-500 mb-3"
          />
          <h3 class="font-bold text-gray-900 dark:text-gray-100 text-lg mb-1">
            {{ state === 'scanning' ? 'Scanning for Duplicates...' : 'Merging Activities...' }}
          </h3>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            This may take a moment. Please don't close this window.
          </p>
        </div>

        <!-- Review State -->
        <div v-else-if="state === 'review'" class="space-y-4">
          <div v-if="duplicateGroups.length === 0" class="text-center py-6">
            <UIcon name="i-heroicons-check-circle" class="w-12 h-12 mx-auto text-green-500 mb-2" />
            <p class="font-bold text-gray-900 dark:text-gray-100">No duplicates found!</p>
            <p class="text-sm text-gray-500">Your activity history looks clean.</p>
          </div>

          <div v-else class="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
            <div class="flex items-center justify-between">
              <p class="text-sm text-gray-600 dark:text-gray-300">
                Found <strong>{{ duplicateGroups.length }}</strong> sets of duplicate activities.
              </p>
              <div class="flex items-center gap-2">
                <UCheckbox v-model="allSelected" label="Select All" />
              </div>
            </div>

            <div
              v-for="(group, idx) in duplicateGroups"
              :key="idx"
              class="border dark:border-gray-800 rounded-lg p-3 bg-gray-50 dark:bg-gray-800/50 transition-colors"
              :class="{
                'ring-2 ring-primary-500/20 bg-primary-50/10': selectedGroups.has(
                  group.bestWorkout.id
                )
              }"
            >
              <div class="flex items-center justify-between mb-2">
                <div class="text-xs font-bold uppercase text-gray-500">
                  <span>Group {{ idx + 1 }}</span>
                  <span class="mx-1">•</span>
                  <span>{{ formatDateUTC(new Date(group.bestWorkout.date), 'MMM d, yyyy') }}</span>
                </div>
                <UCheckbox
                  :model-value="selectedGroups.has(group.bestWorkout.id)"
                  @update:model-value="toggleSelection(group.bestWorkout.id)"
                />
              </div>

              <!-- Best Workout -->
              <div
                class="mb-3"
                :class="{ 'opacity-50 grayscale': !selectedGroups.has(group.bestWorkout.id) }"
              >
                <div
                  class="text-xs text-green-600 dark:text-green-400 font-bold mb-1 flex items-center gap-1"
                >
                  <UIcon name="i-heroicons-star" class="w-3 h-3" />
                  Keeping (Best Version)
                </div>
                <div
                  class="bg-white dark:bg-gray-900 p-2 rounded border border-green-200 dark:border-green-900/30 shadow-sm flex items-center justify-between gap-4"
                >
                  <div class="flex items-center gap-2 flex-1 min-w-0">
                    <UIcon
                      :name="getWorkoutIcon(group.bestWorkout.type)"
                      class="w-4 h-4 shrink-0"
                      :class="getWorkoutColorClass(group.bestWorkout.type)"
                    />
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between gap-2 mb-0.5">
                        <div class="text-sm font-semibold truncate">
                          {{ group.bestWorkout.title }}
                        </div>
                        <UTooltip class="shrink-0">
                          <template #text>
                            <div class="p-1">
                              <div class="font-bold mb-1 text-xs">
                                Quality Score: {{ group.bestWorkout.completenessScore }}
                              </div>
                              <div class="grid grid-cols-2 gap-x-3 gap-y-1">
                                <div
                                  v-for="badge in getDataBadges(group.bestWorkout)"
                                  :key="badge.label"
                                  class="flex items-center gap-1 text-[10px]"
                                >
                                  <UIcon :name="badge.icon" class="w-3 h-3" :class="badge.color" />
                                  <span>{{ badge.label }}</span>
                                </div>
                              </div>
                            </div>
                          </template>
                          <div class="flex text-amber-400">
                            <UIcon
                              v-for="i in 5"
                              :key="i"
                              :name="
                                i <= getQualityStars(group.bestWorkout.completenessScore)
                                  ? 'i-heroicons-star-solid'
                                  : 'i-heroicons-star'
                              "
                              class="w-3 h-3"
                            />
                          </div>
                        </UTooltip>
                      </div>
                      <div class="text-xs text-gray-500 flex items-center justify-between w-full">
                        <div class="flex items-center gap-2 overflow-hidden">
                          <span class="truncate"
                            >{{ formatSource(group.bestWorkout) }} •
                            {{ formatDurationCompact(group.bestWorkout.durationSec) }}</span
                          >
                          <span
                            v-if="group.originalGroup.proposedLink"
                            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-[10px] text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-800 truncate max-w-[150px]"
                          >
                            <UIcon name="i-heroicons-link" class="w-3 h-3 shrink-0" />
                            <span class="truncate">{{
                              group.originalGroup.proposedLink.title
                            }}</span>
                          </span>
                        </div>
                        <div class="flex items-center gap-1 shrink-0 ml-2">
                          <UTooltip
                            v-for="badge in getDataBadges(group.bestWorkout)"
                            :key="badge.label"
                            :text="badge.label"
                          >
                            <UIcon
                              :name="badge.icon"
                              class="w-3.5 h-3.5 opacity-50 hover:opacity-100 transition-opacity"
                            />
                          </UTooltip>
                        </div>
                      </div>
                    </div>
                  </div>
                  <UBadge
                    color="success"
                    variant="subtle"
                    size="xs"
                    class="shrink-0 w-[75px] justify-center"
                    >Primary</UBadge
                  >
                </div>
              </div>

              <!-- Duplicates to Merge -->
              <div :class="{ 'opacity-50 grayscale': !selectedGroups.has(group.bestWorkout.id) }">
                <div
                  class="text-xs text-amber-600 dark:text-amber-400 font-bold mb-1 flex items-center gap-1"
                >
                  <UIcon name="i-heroicons-link" class="w-3 h-3" />
                  Merging & Linking
                </div>
                <div class="space-y-2">
                  <div
                    v-for="dup in group.others"
                    :key="dup.id"
                    class="bg-white dark:bg-gray-900 p-2 rounded border border-amber-200 dark:border-amber-900/30 opacity-75 flex items-center justify-between gap-4"
                  >
                    <div class="flex items-center gap-2 flex-1 min-w-0">
                      <UIcon
                        :name="getWorkoutIcon(dup.type)"
                        class="w-4 h-4 shrink-0"
                        :class="getWorkoutColorClass(dup.type)"
                      />
                      <div class="flex-1 min-w-0">
                        <div class="flex items-center justify-between gap-2 mb-0.5">
                          <div class="text-sm text-gray-700 dark:text-gray-300 truncate">
                            {{ dup.title }}
                          </div>
                          <UTooltip class="shrink-0">
                            <template #text>
                              <div class="p-1">
                                <div class="font-bold mb-1 text-xs">
                                  Quality Score: {{ dup.completenessScore }}
                                </div>
                                <div class="grid grid-cols-2 gap-x-3 gap-y-1">
                                  <div
                                    v-for="badge in getDataBadges(dup)"
                                    :key="badge.label"
                                    class="flex items-center gap-1 text-[10px]"
                                  >
                                    <UIcon :name="badge.icon" class="w-3 h-3" />
                                    <span>{{ badge.label }}</span>
                                  </div>
                                </div>
                              </div>
                            </template>
                            <div class="flex text-gray-300">
                              <UIcon
                                v-for="i in 5"
                                :key="i"
                                :name="
                                  i <= getQualityStars(dup.completenessScore)
                                    ? 'i-heroicons-star-solid'
                                    : 'i-heroicons-star'
                                "
                                class="w-3 h-3"
                              />
                            </div>
                          </UTooltip>
                        </div>
                        <div class="text-xs text-gray-500 flex items-center justify-between w-full">
                          <span
                            >{{ formatSource(dup) }} •
                            {{ formatDurationCompact(dup.durationSec) }}</span
                          >
                          <div class="flex items-center gap-1">
                            <UTooltip
                              v-for="badge in getDataBadges(dup)"
                              :key="badge.label"
                              :text="badge.label"
                            >
                              <UIcon
                                :name="badge.icon"
                                class="w-3.5 h-3.5 opacity-40 hover:opacity-100 transition-opacity"
                              />
                            </UTooltip>
                          </div>
                        </div>
                      </div>
                    </div>
                    <UBadge
                      color="warning"
                      variant="subtle"
                      size="xs"
                      class="shrink-0 w-[75px] justify-center"
                      >Duplicate</UBadge
                    >
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Success State -->
        <div v-else-if="state === 'success'" class="text-center py-6">
          <UIcon
            :name="
              resultStats.skipped > 0
                ? 'i-heroicons-exclamation-triangle'
                : 'i-heroicons-check-circle'
            "
            class="w-12 h-12 mx-auto mb-2"
            :class="resultStats.skipped > 0 ? 'text-amber-500' : 'text-green-500'"
          />
          <h3 class="font-bold text-gray-900 dark:text-gray-100 text-lg">
            {{
              resultStats.skipped > 0 ? 'Completed with Skipped Groups' : 'Deduplication Complete'
            }}
          </h3>
          <p class="text-gray-600 dark:text-gray-300 mt-2">
            Successfully merged <strong>{{ resultStats.kept }}</strong> activities and marked
            <strong>{{ resultStats.deleted }}</strong> as duplicates.
          </p>
          <p
            v-if="resultStats.skipped > 0"
            role="status"
            class="text-amber-600 dark:text-amber-400 mt-2"
          >
            {{ resultStats.skipped }} duplicate groups were skipped because records changed during
            merging. Scan again to review the current activities.
          </p>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-3 w-full">
        <!-- Idle Footer -->
        <template v-if="state === 'idle'">
          <UButton
            color="neutral"
            variant="ghost"
            @click="
              () => {
                isOpen = false
              }
            "
            >Cancel</UButton
          >
          <UButton
            color="primary"
            @click="
              () => {
                void startScan()
              }
            "
            >Scan for Duplicates</UButton
          >
        </template>

        <!-- Scanning/Processing Footer -->
        <template v-else-if="state === 'scanning' || state === 'processing'">
          <UButton color="neutral" variant="ghost" disabled>Processing...</UButton>
        </template>

        <!-- Review Footer -->
        <template v-else-if="state === 'review'">
          <UButton
            color="neutral"
            variant="ghost"
            @click="
              () => {
                isOpen = false
              }
            "
            >Cancel</UButton
          >
          <UButton
            v-if="duplicateGroups.length > 0"
            color="primary"
            :disabled="selectedGroups.size === 0"
            @click="
              () => {
                void confirmDeduplication()
              }
            "
          >
            Merge {{ selectedGroups.size }} Groups
          </UButton>
          <UButton
            v-else
            color="primary"
            @click="
              () => {
                isOpen = false
              }
            "
            >Done</UButton
          >
        </template>

        <!-- Success Footer -->
        <template v-else-if="state === 'success'">
          <UButton v-if="resultStats.skipped > 0" color="warning" @click="startScan"
            >Scan Again</UButton
          >
          <UButton
            color="primary"
            @click="
              () => {
                void finish()
              }
            "
            >Close</UButton
          >
        </template>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
  import { getWorkoutSourceLabel } from '~/utils/workout-source'

  import { useUserRuns } from '~/composables/useUserRuns'
  import { getWorkoutIcon, getWorkoutColorClass } from '~/utils/activity-types'

  const isOpen = defineModel<boolean>('open')
  const emit = defineEmits(['updated'])

  const { formatDateUTC } = useFormat()
  const { runs } = useUserRuns()

  type DedupeState = 'idle' | 'scanning' | 'review' | 'processing' | 'success'
  const state = ref<DedupeState>('idle')
  const duplicateGroups = ref<any[]>([])
  const resultStats = ref({ kept: 0, deleted: 0, skipped: 0 })
  const currentTaskId = ref<string | null>(null)
  const selectedGroups = ref<Set<string>>(new Set())

  // Computed property for loading state to prevent closing
  const isLoading = computed(() => state.value === 'scanning' || state.value === 'processing')

  const allSelected = computed({
    get: () =>
      duplicateGroups.value.length > 0 &&
      selectedGroups.value.size === duplicateGroups.value.length,
    set: (val) => {
      if (val) {
        selectedGroups.value = new Set(duplicateGroups.value.map((g) => g.bestWorkout.id))
      } else {
        selectedGroups.value = new Set()
      }
    }
  })

  function toggleSelection(id: string) {
    if (selectedGroups.value.has(id)) {
      selectedGroups.value.delete(id)
    } else {
      selectedGroups.value.add(id)
    }
    // Trigger reactivity for Set
    selectedGroups.value = new Set(selectedGroups.value)
  }

  // Watch for run completion
  watch(
    runs,
    (newRuns) => {
      if (!currentTaskId.value) return

      // Only monitor if we are in a waiting state
      if (state.value !== 'scanning' && state.value !== 'processing') return

      const run = newRuns.find((r) => r.id === currentTaskId.value)
      if (!run) return

      if (run.status === 'COMPLETED' && run.output) {
        if (state.value === 'scanning') {
          processScanResults(run.output)
        } else if (state.value === 'processing') {
          resultStats.value = {
            kept: run.output.workoutsKept || 0,
            deleted: run.output.workoutsDeleted || 0,
            skipped: run.output.groupsSkipped || 0
          }
          state.value = 'success'
          emit('updated')
        }
        currentTaskId.value = null // Stop watching this ID
      } else if (['FAILED', 'CRASHED', 'CANCELED', 'TIMED_OUT'].includes(run.status)) {
        handleError('Task failed or was canceled.')
        currentTaskId.value = null
      }
    },
    { deep: true }
  )

  function formatSource(workout: any) {
    return getWorkoutSourceLabel(workout) || 'Unknown'
  }

  function formatDurationCompact(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
  }

  async function startScan() {
    currentTaskId.value = null
    duplicateGroups.value = []
    selectedGroups.value = new Set()
    resultStats.value = { kept: 0, deleted: 0, skipped: 0 }
    state.value = 'scanning'
    try {
      const res = await ($fetch as any)('/api/workouts/deduplicate', {
        method: 'POST',
        body: { dryRun: true }
      })

      if (res.success && res.taskId) {
        currentTaskId.value = res.taskId
        // Watcher will handle the rest
      }
    } catch (err) {
      handleError('Failed to start deduplication scan.')
    }
  }

  function processScanResults(output: any) {
    // Output format from trigger: { success: true, dryRun: true, duplicateGroups: [...] }
    // Each group: { workouts: [], bestWorkoutId: string, toDelete: string[] }

    const groups = output.duplicateGroups || []

    // Transform for UI
    duplicateGroups.value = groups.map((g: any) => {
      const bestWorkout = g.workouts.find((w: any) => w.id === g.bestWorkoutId)
      const others = g.workouts.filter((w: any) => w.id !== g.bestWorkoutId)
      return {
        bestWorkout,
        others,
        originalGroup: g
      }
    })

    // Select all by default
    selectedGroups.value = new Set(duplicateGroups.value.map((g) => g.bestWorkout.id))

    state.value = 'review'
  }

  async function confirmDeduplication() {
    if (selectedGroups.value.size === 0) return

    state.value = 'processing'
    try {
      const res = await ($fetch as any)('/api/workouts/deduplicate', {
        method: 'POST',
        body: {
          dryRun: false,
          targetBestWorkoutIds: Array.from(selectedGroups.value)
        }
      })

      if (res.success && res.taskId) {
        currentTaskId.value = res.taskId
        // Watcher will handle the rest
      }
    } catch (err) {
      handleError('Failed to start deduplication process.')
    }
  }

  function handleError(msg: string) {
    state.value = 'idle' // Reset
    const toast = useToast()
    toast.add({
      title: 'Error',
      description: msg,
      color: 'error'
    })
  }

  function finish() {
    isOpen.value = false
    // Reset state after a delay so transition looks nice
    setTimeout(() => {
      state.value = 'idle'
      duplicateGroups.value = []
    }, 300)
  }

  function getDataBadges(workout: any) {
    const badges = []
    if (workout.averageHr > 0) badges.push({ icon: 'i-heroicons-heart', label: 'Heart Rate' })
    if (workout.averageWatts > 0) badges.push({ icon: 'i-heroicons-bolt', label: 'Power' })
    if (workout.distanceMeters > 0) badges.push({ icon: 'i-heroicons-map-pin', label: 'GPS' })
    if (workout.averageCadence > 0) badges.push({ icon: 'i-ph-sneaker-move', label: 'Cadence' })
    if (workout.streams)
      badges.push({
        icon: 'i-heroicons-chart-bar',
        label: 'Detailed Streams',
        color: 'text-green-500'
      })
    if (workout.exercises && workout.exercises.length > 0)
      badges.push({
        icon: 'i-heroicons-clipboard-document-list',
        label: 'Exercises',
        color: 'text-indigo-500'
      })
    if (workout.elevationGain > 0)
      badges.push({
        icon: 'i-heroicons-arrow-trending-up',
        label: 'Elevation',
        color: 'text-gray-500'
      })
    return badges
  }

  function getQualityStars(score: number) {
    // Normalize score (0-150+) to 1-5 stars
    // < 30: 1 star
    // 30-60: 2 stars
    // 60-90: 3 stars
    // 90-120: 4 stars
    // > 120: 5 stars
    if (!score) return 1
    if (score > 120) return 5
    if (score > 90) return 4
    if (score > 60) return 3
    if (score > 30) return 2
    return 1
  }
</script>
