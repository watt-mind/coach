<template>
  <UDashboardPanel id="coaching-dashboard">
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
            <ClientOnly>
              <DashboardTriggerMonitorButton />
            </ClientOnly>
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-0 sm:p-6 space-y-8">
        <!-- 1. Header & Utility Bar -->
        <div class="flex flex-col md:flex-row md:items-end justify-between gap-6 px-4 sm:px-0">
          <div>
            <h1 class="text-4xl font-black text-gray-900 dark:text-white uppercase tracking-tight">
              {{ tr('index_title', 'Strategic Overview') }}
            </h1>
            <p
              class="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-[0.2em] mt-1 italic"
            >
              {{ tr('index_subtitle', 'Performance Roster & Compliance Control') }}
            </p>
          </div>

          <!-- Quick Actions Utility Bar -->
          <div class="flex items-center gap-2 overflow-x-auto pb-2 md:pb-0 scrollbar-hide">
            <UButton
              color="primary"
              variant="solid"
              icon="i-lucide-user-plus"
              :label="tr('index_add_athlete', 'Add Athlete')"
              size="sm"
              class="font-bold whitespace-nowrap"
              to="/coaching/athletes"
            />
            <UButton
              color="neutral"
              variant="subtle"
              icon="i-lucide-library"
              :label="tr('index_workouts', 'Workouts')"
              size="sm"
              class="font-bold whitespace-nowrap"
              to="/library/workouts"
            />
            <UButton
              color="neutral"
              variant="subtle"
              icon="i-lucide-dumbbell"
              :label="tr('index_exercises', 'Exercises')"
              size="sm"
              class="font-bold whitespace-nowrap"
              to="/library/exercises"
            />
            <UButton
              color="neutral"
              variant="subtle"
              icon="i-lucide-scroll-text"
              :label="tr('index_plans', 'Plans')"
              size="sm"
              class="font-bold whitespace-nowrap"
              to="/library/plans"
            />
          </div>
        </div>

        <!-- CoachingBanner is mounted once in app/app.vue (CW-541) -->

        <!-- Loading State -->
        <div v-if="loading" class="grid grid-cols-1 lg:grid-cols-3 gap-0 lg:gap-8 px-0">
          <USkeleton class="lg:col-span-2 h-[400px] rounded-none sm:rounded-2xl" />
          <USkeleton class="h-[400px] rounded-none sm:rounded-2xl" />
        </div>

        <!-- Empty State -->
        <div
          v-else-if="overviewData.athletes.length === 0"
          class="py-24 text-center border-y sm:border-2 border-dashed border-gray-200 dark:border-gray-800 rounded-none sm:rounded-2xl px-4"
        >
          <div class="bg-neutral-100 dark:bg-neutral-800 p-6 rounded-full inline-block mb-4">
            <UIcon name="i-heroicons-users" class="w-12 h-12 text-neutral-400" />
          </div>
          <template v-if="pendingRequestCount > 0">
            <h3 class="text-xl font-bold">
              {{ tr('index_empty_pending_title', 'Pending coaching requests') }}
            </h3>
            <p class="text-neutral-500 max-w-sm mx-auto mb-6">
              {{
                tr(
                  'index_empty_pending_desc',
                  'You have athletes waiting for approval. Review them to start coaching.'
                )
              }}
            </p>
            <UButton
              color="primary"
              size="lg"
              to="/coaching/athletes"
              :label="tr('index_empty_pending_cta', 'Review pending requests')"
            />
          </template>
          <template v-else>
            <h3 class="text-xl font-bold">
              {{ tr('index_empty_title', 'Connect Your First Athlete') }}
            </h3>
            <p class="text-neutral-500 max-w-sm mx-auto mb-6">
              {{
                tr(
                  'index_empty_desc',
                  'Connecting athletes allows you to track their weekly compliance and live activity feed.'
                )
              }}
            </p>
            <UButton
              color="primary"
              size="lg"
              to="/coaching/athletes"
              :label="tr('index_empty_cta', 'Go to Athletes')"
            />
          </template>
        </div>

        <!-- 2. Main Strategic Grid -->
        <div v-else class="space-y-8">
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-0 lg:gap-8 items-start">
            <!-- Weekly Compliance (2/3) -->
            <div class="lg:col-span-2">
              <CoachingWeeklyCompliance
                :athletes="overviewData.athletes"
                :week-days="overviewData.weekDays"
              />
            </div>

            <!-- Recent Activity (1/3) -->
            <div class="h-full">
              <CoachingActivityFeed :feed="overviewData.feed" />
            </div>
          </div>

          <!-- 3. Full Roster Grid (Original Element) -->
          <div class="space-y-4">
            <div class="flex items-center justify-between px-4 sm:px-0">
              <h2 class="text-xl font-bold text-gray-900 dark:text-white uppercase tracking-tight">
                {{ tr('index_roster_title', 'Your Roster') }}
              </h2>
              <UButton
                variant="link"
                color="primary"
                to="/coaching/athletes"
                :label="tr('index_manage_roster', 'Manage Roster')"
                icon="i-heroicons-arrow-right"
                trailing
              />
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0 sm:gap-4">
              <UCard
                v-for="athlete in overviewData.athletes.slice(0, 8)"
                :key="athlete.id"
                class="hover:ring-2 hover:ring-primary-500 transition-all cursor-pointer group"
                :ui="mobileStatCardUi"
                @click="
                  () => {
                    void router.push(`/coaching/athletes/${athlete.id}`)
                  }
                "
              >
                <div class="flex items-center gap-3">
                  <UAvatar :src="athlete.image" :alt="athlete.name" size="md" />
                  <div class="flex-1 min-w-0">
                    <p
                      class="font-bold text-sm truncate group-hover:text-primary-600 transition-colors"
                    >
                      {{ athlete.name }}
                    </p>
                    <div class="flex gap-1 mt-1">
                      <div
                        v-for="(day, idx) in athlete.compliance.slice(-5)"
                        :key="idx"
                        class="w-1.5 h-1.5 rounded-full"
                        :class="getMiniStatusClass(day.status)"
                      />
                    </div>
                  </div>
                  <UIcon name="i-heroicons-chevron-right" class="w-4 h-4 text-gray-400" />
                </div>
              </UCard>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
  import { mobileStatCardUi } from '~/utils/mobile-surface-ui'

  const { tr } = useCoachingI18n()

  definePageMeta({
    middleware: 'auth'
  })

  useHead({
    title: computed(() => tr('index_meta_title', 'Coach Dashboard | Coaching')),
    meta: [
      {
        name: 'description',
        content: computed(() =>
          tr(
            'index_meta_description',
            'Strategic overview of your athletes performance and compliance.'
          )
        )
      }
    ]
  })

  const router = useRouter()
  const toast = useToast()
  const loading = ref(true)
  const pendingRequestCount = ref(0)
  const overviewData = ref<any>({
    athletes: [],
    feed: [],
    weekDays: []
  })

  async function fetchData() {
    loading.value = true
    try {
      const data = await $fetch<any, string & {}>('/api/coaching/overview')
      overviewData.value = data
      pendingRequestCount.value =
        typeof (data as any)?.pendingRequestCount === 'number'
          ? (data as any).pendingRequestCount
          : 0

      if (overviewData.value.athletes.length === 0 && pendingRequestCount.value === 0) {
        try {
          const requests = await $fetch<any, string & {}>('/api/coaching/athletes/requests')
          pendingRequestCount.value = Array.isArray(requests) ? requests.length : 0
        } catch {
          // Requests endpoint may be unavailable for some roles; keep overview CTA as-is.
        }
      }

      // CW-103: this "Overview" page is a coach dashboard. A user with no
      // coaching-as-coach relationships (no active athletes, no pending
      // requests to become someone's coach) who IS connected to at least one
      // coach of their own is a pure athlete — send them to their active
      // coaching connections instead of the coach-only "Connect Your First
      // Athlete" empty state. Brand-new users with no coaching relationships
      // at all (neither role) keep seeing the coach empty state so the
      // "Add Athlete" onboarding path stays reachable.
      if (overviewData.value.athletes.length === 0 && pendingRequestCount.value === 0) {
        try {
          const coaches = await $fetch<any, string & {}>('/api/coaching/coaches')
          const isPureAthlete = Array.isArray(coaches) && coaches.length > 0
          if (isPureAthlete) {
            await navigateTo('/coaching/team', { replace: true })
            return
          }
        } catch {
          // If we can't determine athlete-role, fall back to the existing
          // coach empty state rather than redirecting incorrectly.
        }
      }
    } catch (e) {
      console.error(e)
      toast.add({ title: 'Failed to load coaching overview', color: 'error' })
    } finally {
      loading.value = false
    }
  }

  function getMiniStatusClass(status: string) {
    if (status === 'completed' || status === 'unscheduled_completed') return 'bg-green-500'
    if (status === 'partially_completed') return 'bg-yellow-500'
    if (status === 'missed') return 'bg-orange-500'
    if (status === 'planned') return 'bg-blue-500'
    return 'bg-neutral-200 dark:bg-neutral-800'
  }

  onMounted(fetchData)
</script>
