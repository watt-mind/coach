<template>
  <UDashboardPanel id="recommendation-detail">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UButton
            icon="i-heroicons-arrow-left"
            color="neutral"
            variant="ghost"
            to="/recommendations"
          />
        </template>
        <template #right>
          <div v-if="rec" class="flex items-center gap-2">
            <UButton
              icon="i-heroicons-chat-bubble-left-right"
              color="primary"
              variant="solid"
              size="sm"
              class="font-bold"
              @click="
                () => {
                  void chatAboutRecommendation()
                }
              "
            >
              <span class="hidden sm:inline">Chat about this</span>
              <span class="sm:hidden">Chat</span>
            </UButton>
            <UButton
              :icon="rec.isPinned ? 'i-heroicons-paper-clip-solid' : 'i-heroicons-paper-clip'"
              :color="rec.isPinned ? 'primary' : 'neutral'"
              variant="ghost"
              @click="
                () => {
                  void togglePin()
                }
              "
            />
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-0 sm:p-6 space-y-6 sm:space-y-10 pb-24">
        <div v-if="pending" class="flex justify-center py-12">
          <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-primary" />
        </div>

        <div v-else-if="rec" class="space-y-6 sm:space-y-8">
          <h1
            class="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white px-4 sm:px-0"
          >
            {{ rec.title }}
          </h1>

          <!-- Main Content Section -->
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-0 lg:gap-6">
            <!-- Left: Main Detail (2/3) -->
            <div class="lg:col-span-2 space-y-0 sm:space-y-6">
              <UCard :ui="{ ...mobileListCardUi, body: 'p-4 sm:p-6' }">
                <template #header>
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                      <UBadge :color="priorityColor" variant="subtle">
                        {{ rec.priority.toUpperCase() }}
                      </UBadge>
                      <UBadge color="neutral" variant="soft">
                        {{ rec.sourceType }} / {{ rec.metric }}
                      </UBadge>
                    </div>
                    <div class="text-xs text-muted">
                      <span class="hidden sm:inline">Generated</span>
                      {{ formatShortDate(rec.generatedAt) }}
                    </div>
                  </div>
                </template>

                <div class="prose dark:prose-invert max-w-none text-gray-700 dark:text-gray-300">
                  <p class="whitespace-pre-line text-base leading-relaxed">
                    <GlossaryText :text="rec.description" />
                  </p>
                </div>

                <template #footer>
                  <div class="flex flex-wrap items-center justify-between w-full gap-3">
                    <div
                      class="flex flex-wrap items-center gap-3 w-full sm:w-auto justify-center sm:justify-start"
                    >
                      <UButton
                        v-if="!rec.implementationGuide"
                        icon="i-heroicons-sparkles"
                        color="primary"
                        variant="soft"
                        :loading="generatingGuide"
                        @click="
                          () => {
                            void generateGuide()
                          }
                        "
                      >
                        Generate Action Plan
                      </UButton>
                      <AiFeedback v-if="rec.llmUsageId" :llm-usage-id="rec.llmUsageId" />
                    </div>

                    <div class="flex items-center justify-end gap-3 w-full sm:w-auto">
                      <UButton
                        v-if="rec.status === 'ACTIVE'"
                        color="neutral"
                        variant="ghost"
                        @click="
                          () => {
                            void updateStatus('DISMISSED')
                          }
                        "
                      >
                        Dismiss
                      </UButton>
                      <UButton
                        v-if="rec.status === 'ACTIVE'"
                        color="success"
                        variant="soft"
                        icon="i-heroicons-check"
                        class="font-bold"
                        @click="
                          () => {
                            void updateStatus('COMPLETED')
                          }
                        "
                      >
                        Mark Complete
                      </UButton>
                      <UBadge v-else color="neutral" variant="solid" class="font-bold">
                        {{ rec.status }}
                      </UBadge>
                    </div>
                  </div>
                </template>
              </UCard>

              <!-- Action Plan / Implementation Guide -->
              <div v-if="rec.implementationGuide" class="space-y-4">
                <h3
                  class="text-xl font-bold text-gray-900 dark:text-white px-4 sm:px-0 flex items-center gap-2"
                >
                  <UIcon
                    name="i-heroicons-clipboard-document-list"
                    class="w-6 h-6 text-primary-500"
                  />
                  Action Plan
                </h3>

                <div class="grid gap-0 sm:gap-6">
                  <!-- Strategy Summary -->
                  <UCard :ui="{ ...mobileListCardUi, body: 'p-4 sm:p-5' }">
                    <h4
                      class="font-bold text-gray-900 dark:text-white mb-2 flex items-center gap-2"
                    >
                      <UIcon name="i-heroicons-light-bulb" class="w-5 h-5 text-yellow-500" />
                      Strategy
                    </h4>
                    <p class="text-gray-700 dark:text-gray-300 leading-relaxed">
                      <GlossaryText :text="rec.implementationGuide.strategy_summary" />
                    </p>
                  </UCard>

                  <!-- Key Actions -->
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-0 md:gap-4">
                    <UCard :ui="{ ...mobileListCardUi, body: 'p-4 sm:p-5' }" class="h-full">
                      <h4
                        class="font-bold text-gray-900 dark:text-white mb-3 flex items-center gap-2"
                      >
                        <UIcon name="i-heroicons-play-circle" class="w-5 h-5 text-green-500" />
                        Key Actions
                      </h4>
                      <ul class="space-y-2">
                        <li
                          v-for="(action, i) in rec.implementationGuide.key_actions"
                          :key="i"
                          class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
                        >
                          <span class="font-bold text-primary-500">{{ Number(i) + 1 }}.</span>
                          <GlossaryText :text="action" />
                        </li>
                      </ul>
                    </UCard>

                    <UCard :ui="{ ...mobileListCardUi, body: 'p-4 sm:p-5' }" class="h-full">
                      <h4
                        class="font-bold text-gray-900 dark:text-white mb-3 flex items-center gap-2"
                      >
                        <UIcon name="i-heroicons-sparkles" class="w-5 h-5 text-purple-500" />
                        Pro Tips
                      </h4>
                      <ul class="space-y-2">
                        <li
                          v-for="(tip, i) in rec.implementationGuide.tips_and_tricks"
                          :key="i"
                          class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
                        >
                          <UIcon
                            name="i-heroicons-check-circle"
                            class="w-4 h-4 text-purple-400 mt-0.5 shrink-0"
                          />
                          <GlossaryText :text="tip" />
                        </li>
                      </ul>
                    </UCard>
                  </div>

                  <!-- Pitfalls & Metrics -->
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-0 md:gap-4">
                    <UCard
                      :ui="{ ...mobileListCardUi, body: 'p-4 sm:p-5' }"
                      class="bg-red-50/50 dark:bg-red-900/10 border-red-100 dark:border-red-900/30"
                    >
                      <h4
                        class="font-bold text-gray-900 dark:text-white mb-3 flex items-center gap-2"
                      >
                        <UIcon
                          name="i-heroicons-exclamation-triangle"
                          class="w-5 h-5 text-red-500"
                        />
                        Watch Out For
                      </h4>
                      <ul class="space-y-2">
                        <li
                          v-for="(pitfall, i) in rec.implementationGuide.common_pitfalls"
                          :key="i"
                          class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
                        >
                          <UIcon
                            name="i-heroicons-x-mark"
                            class="w-4 h-4 text-red-400 mt-0.5 shrink-0"
                          />
                          <GlossaryText :text="pitfall" />
                        </li>
                      </ul>
                    </UCard>

                    <UCard
                      :ui="{ ...mobileListCardUi, body: 'p-4 sm:p-5' }"
                      class="bg-green-50/50 dark:bg-green-900/10 border-green-100 dark:border-green-900/30"
                    >
                      <h4
                        class="font-bold text-gray-900 dark:text-white mb-3 flex items-center gap-2"
                      >
                        <UIcon name="i-heroicons-chart-bar" class="w-5 h-5 text-green-600" />
                        Success Indicators
                      </h4>
                      <ul class="space-y-2">
                        <li
                          v-for="(metric, i) in rec.implementationGuide.success_metrics"
                          :key="i"
                          class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
                        >
                          <UIcon
                            name="i-heroicons-arrow-trending-up"
                            class="w-4 h-4 text-green-500 mt-0.5 shrink-0"
                          />
                          <GlossaryText :text="metric" />
                        </li>
                      </ul>
                    </UCard>
                  </div>

                  <!-- AI Feedback -->
                  <div
                    v-if="rec.implementationGuide.llmUsageId"
                    class="flex justify-end px-1 pt-2 border-t border-gray-100 dark:border-gray-800"
                  >
                    <AiFeedback :llm-usage-id="rec.implementationGuide.llmUsageId" />
                  </div>
                </div>
              </div>

              <!-- Evolution History -->
              <div v-if="hasHistoryTimeline" class="space-y-4">
                <h3 class="text-xl font-bold text-gray-900 dark:text-white px-4 sm:px-0">
                  Evolution History
                </h3>
                <div
                  class="relative ml-4 pl-6 border-l-2 border-gray-200 dark:border-gray-700 space-y-8"
                >
                  <div v-for="(item, idx) in sortedHistory" :key="idx" class="relative">
                    <div
                      class="absolute -left-[29px] top-1.5 w-3.5 h-3.5 rounded-full border-2 border-white dark:border-gray-900 bg-gray-400"
                    ></div>

                    <div class="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-5 shadow-sm space-y-3">
                      <div class="flex items-center justify-between">
                        <span class="text-xs font-mono text-muted">
                          {{ formatDate(item.date) }}
                        </span>
                        <UBadge color="neutral" variant="outline" size="xs">
                          Previous Version
                        </UBadge>
                      </div>

                      <div
                        v-if="item.reason"
                        class="text-sm font-semibold text-primary-600 dark:text-primary-400 flex items-center gap-1.5"
                      >
                        <UIcon name="i-heroicons-sparkles" class="w-4 h-4" />
                        Update Reason: <GlossaryText :text="item.reason" />
                      </div>

                      <div>
                        <div class="font-bold text-gray-900 dark:text-white text-base">
                          {{ item.title }}
                        </div>
                        <div
                          class="text-sm text-gray-600 dark:text-gray-400 mt-2 whitespace-pre-wrap"
                        >
                          <GlossaryText :text="item.description" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div v-else-if="hasUnsupportedHistory" class="space-y-4">
                <h3 class="text-xl font-bold text-gray-900 dark:text-white px-4 sm:px-0">
                  Evolution History
                </h3>
                <p class="text-sm text-muted px-4 sm:px-0">
                  History unavailable for this recommendation.
                </p>
              </div>
            </div>

            <!-- Right: Meta Info (1/3) -->
            <div class="space-y-0 sm:space-y-6">
              <UCard :ui="{ ...mobileListCardUi, body: 'p-4 sm:p-6' }">
                <template #header>
                  <h3 class="font-bold">Meta Details</h3>
                </template>
                <div class="space-y-4">
                  <div>
                    <div class="text-xs font-bold text-muted uppercase tracking-widest mb-1">
                      Priority
                    </div>
                    <UBadge :color="priorityColor" variant="solid" class="font-bold">
                      {{ rec.priority.toUpperCase() }}
                    </UBadge>
                  </div>
                  <div>
                    <div class="text-xs font-bold text-muted uppercase tracking-widest mb-1">
                      Metric
                    </div>
                    <div class="font-medium text-sm">{{ rec.metric }}</div>
                  </div>
                  <div>
                    <div class="text-xs font-bold text-muted uppercase tracking-widest mb-1">
                      Source
                    </div>
                    <div class="font-medium text-sm">{{ rec.sourceType }}</div>
                  </div>
                  <div v-if="rec.period">
                    <div class="text-xs font-bold text-muted uppercase tracking-widest mb-1">
                      Period
                    </div>
                    <div class="font-medium text-sm">{{ rec.period }} Days</div>
                  </div>
                </div>
              </UCard>
            </div>
          </div>
        </div>

        <div v-else class="text-center py-20">
          <UIcon name="i-heroicons-exclamation-circle" class="w-12 h-12 mx-auto text-muted mb-4" />
          <h2 class="text-xl font-bold mb-2">Recommendation Not Found</h2>
          <p class="text-muted mb-6">The requested recommendation could not be found.</p>
          <UButton to="/recommendations"> Go Back </UButton>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
  import { mobileListCardUi } from '~/utils/mobile-surface-ui'
  const route = useRoute()
  const recId = route.params.id as string
  const toast = useToast()
  const { formatDate: format, formatShortDate: formatShort } = useFormat()

  const {
    data: rec,
    pending,
    refresh
  } = (await useAsyncData<any>(`recommendation-${recId}`, () =>
    ($fetch as any)(`/api/recommendations/${recId}`)
  )) as any

  const priorityColor = computed(() => {
    switch (rec.value?.priority) {
      case 'high':
        return 'error'
      case 'medium':
        return 'warning'
      case 'low':
        return 'primary'
      default:
        return 'neutral'
    }
  })

  // `history` is a Prisma Json column carrying two schemas: an append-only
  // array of history items, or a single threshold-detection object
  // ({ oldValue, newValue, ... }). Only the array renders as a timeline.
  const hasHistoryTimeline = computed(
    () => Array.isArray(rec.value?.history) && rec.value.history.length > 0
  )
  const hasUnsupportedHistory = computed(
    () => rec.value?.history != null && !Array.isArray(rec.value?.history)
  )

  const sortedHistory = computed(() => {
    if (!hasHistoryTimeline.value) return []
    // Sort descending by date (newest first)
    return [...rec.value.history].reverse()
  })

  const formatDate = (d: string) => format(d)
  const formatShortDate = (d: string) => formatShort(d)

  // Implementation Guide Logic
  const generatingGuide = ref(false)

  async function generateGuide() {
    generatingGuide.value = true
    try {
      await $fetch<any, string & {}>(`/api/recommendations/${recId}/guide`, {
        method: 'POST'
      })

      toast.add({
        title: 'Generating Action Plan',
        description: 'Coach is creating a detailed guide...',
        color: 'info',
        icon: 'i-heroicons-sparkles'
      })

      // Poll for result
      let attempts = 0
      const maxAttempts = 30 // 60s
      const poll = setInterval(async () => {
        attempts++
        try {
          // Silent background refresh
          const updatedRec = await ($fetch as any)(`/api/recommendations/${recId}`)
          if (rec.value) {
            rec.value = updatedRec
          }

          if (updatedRec?.implementationGuide) {
            clearInterval(poll)
            generatingGuide.value = false
            toast.add({ title: 'Action Plan Ready', color: 'success' })
          } else if (attempts >= maxAttempts) {
            clearInterval(poll)
            generatingGuide.value = false
            toast.add({
              title: 'Timeout',
              description: 'Taking longer than expected.',
              color: 'warning'
            })
          }
        } catch (e) {
          console.error('Polling error', e)
        }
      }, 2000)
    } catch (e) {
      generatingGuide.value = false
      toast.add({ title: 'Error', color: 'error' })
    }
  }

  function chatAboutRecommendation() {
    if (!rec.value) return
    navigateTo({
      path: '/chat',
      query: { recommendationId: rec.value.id }
    })
  }

  async function togglePin() {
    if (!rec.value) return
    const newState = !rec.value.isPinned
    const oldState = rec.value.isPinned

    try {
      // Optimistic update
      rec.value.isPinned = newState

      await $fetch<any, string & {}>(`/api/recommendations/${recId}`, {
        method: 'PATCH',
        body: { isPinned: newState }
      })

      toast.add({ title: newState ? 'Pinned' : 'Unpinned', color: 'success' })
    } catch (e) {
      // Revert on error
      rec.value.isPinned = oldState
      toast.add({ title: 'Error', color: 'error' })
    }
  }

  async function updateStatus(status: string) {
    if (!rec.value) return
    const oldStatus = rec.value.status

    try {
      // Optimistic update
      rec.value.status = status

      await $fetch<any, string & {}>(`/api/recommendations/${recId}`, {
        method: 'PATCH',
        body: { status }
      })

      toast.add({ title: 'Status updated', color: 'success' })
    } catch (e) {
      // Revert on error
      rec.value.status = oldStatus
      toast.add({ title: 'Error', color: 'error' })
    }
  }
</script>
