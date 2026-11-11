<template>
  <UDashboardPanel id="athlete-detail">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <div class="flex items-center gap-1">
            <UDashboardSidebarCollapse />
            <UButton
              icon="i-heroicons-arrow-left"
              color="neutral"
              variant="ghost"
              to="/coaching/athletes"
              class="mr-2"
            />
          </div>
        </template>
        <template #title>
          <CoachingNavbarLinks />
        </template>
        <template #right>
          <div class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-heroicons-eye"
              :aria-label="actAsDetailLabel"
              :title="actAsDetailLabel"
              @click="
                () => {
                  void actAsAthlete()
                }
              "
            >
              {{ tr('athlete_detail_act_as', 'Act As') }}
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-heroicons-chat-bubble-left-right"
              @click="
                () => {
                  void messageAthlete()
                }
              "
            >
              {{ tr('athlete_detail_message', 'Ask AI') }}
            </UButton>
            <UButton
              color="error"
              variant="ghost"
              icon="i-heroicons-user-minus"
              :loading="removingAthlete"
              @click="
                () => {
                  void confirmRemoveAthlete()
                }
              "
            >
              {{ tr('athlete_detail_remove', 'Remove Athlete') }}
            </UButton>
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="pending" class="p-6 space-y-6">
        <USkeleton class="h-32 w-full" />
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <USkeleton class="h-48 w-full" />
          <USkeleton class="h-48 w-full" />
          <USkeleton class="h-48 w-full" />
        </div>
      </div>

      <div v-else-if="error" class="p-6">
        <UAlert
          color="error"
          icon="i-heroicons-exclamation-triangle"
          :title="tr('athlete_detail_error_title', 'Error loading athlete')"
          :description="
            error.message || tr('athlete_detail_error_desc', 'Could not load athlete profile.')
          "
        />
      </div>

      <div v-else-if="athlete" class="p-0 sm:p-6 space-y-6">
        <div
          class="flex flex-col gap-4 px-4 sm:px-0 lg:flex-row lg:items-center lg:justify-between"
        >
          <div class="flex items-center gap-5">
            <UAvatar
              :src="athlete.image || undefined"
              :alt="athlete.name || undefined"
              size="3xl"
            />
            <div class="space-y-1">
              <h1 class="text-2xl font-bold">{{ athlete.name }}</h1>
              <p class="text-gray-500">{{ athlete.email }}</p>
              <div class="flex flex-wrap items-center gap-2">
                <UBadge
                  v-if="performanceSummary"
                  :color="getFormBadgeColor(performanceSummary.formColor)"
                  variant="subtle"
                  class="font-bold"
                >
                  {{ performanceSummary.formStatus }}
                </UBadge>
                <UBadge
                  v-if="readinessSummary?.score != null"
                  :color="getReadinessBadgeColor(readinessSummary?.score)"
                  variant="subtle"
                  class="font-bold"
                >
                  {{ readinessSummary?.status }} readiness
                </UBadge>
                <span
                  v-if="athlete.stats.overduePlannedCount"
                  class="text-xs text-orange-500 font-bold"
                >
                  {{ athlete.stats.overduePlannedCount }} overdue planned
                </span>
              </div>
            </div>
          </div>

          <div v-if="athlete.recommendations?.length" class="text-left lg:text-right">
            <UBadge
              :color="getRecommendationColor(athlete.recommendations[0].recommendation)"
              size="lg"
              variant="subtle"
              class="font-bold uppercase tracking-wider"
            >
              {{ getRecommendationLabel(athlete.recommendations[0].recommendation) }}
            </UBadge>
            <p class="text-[10px] text-neutral-400 mt-1 uppercase font-bold">Current status</p>
          </div>
        </div>

        <UTabs v-model="selectedTab" :items="tabItems" class="w-full">
          <template #content="{ item }">
            <div v-if="item.value === 'overview'" class="space-y-6 pt-4">
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-0 md:gap-4">
                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold text-xs text-gray-500 uppercase">Fitness (CTL)</h3>
                  </template>
                  <p class="text-3xl font-black text-blue-600">
                    {{ formatMetricNumber(currentCTL) }}
                  </p>
                </UCard>

                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold text-xs text-gray-500 uppercase">Fatigue (ATL)</h3>
                  </template>
                  <p class="text-3xl font-black text-rose-500">
                    {{ formatMetricNumber(currentATL) }}
                  </p>
                </UCard>

                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold text-xs text-gray-500 uppercase">Form (TSB)</h3>
                  </template>
                  <p class="text-3xl font-black" :class="getTSBColor(currentTSB)">
                    {{ formatSignedMetricNumber(currentTSB) }}
                  </p>
                  <p v-if="performanceSummary" class="mt-2 text-xs text-gray-500">
                    {{ performanceSummary.formDescription }}
                  </p>
                </UCard>

                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold text-xs text-gray-500 uppercase">Readiness</h3>
                  </template>
                  <p class="text-3xl font-black text-gray-900 dark:text-white">
                    {{
                      readinessSummary?.score != null
                        ? `${Math.round(readinessSummary.score)}%`
                        : '--'
                    }}
                  </p>
                  <p v-if="readinessSummary?.date" class="mt-2 text-xs text-gray-500">
                    {{ readinessSummary.status }} • {{ formatLongDate(readinessSummary.date) }}
                  </p>
                </UCard>

                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold text-xs text-gray-500 uppercase">7d Compliance</h3>
                  </template>
                  <p
                    class="text-3xl font-black"
                    :class="
                      athlete.stats.adherence7d != null
                        ? athlete.stats.adherence7d >= 80
                          ? 'text-green-600'
                          : 'text-orange-500'
                        : 'text-neutral-400'
                    "
                  >
                    {{ athlete.stats.adherence7d != null ? `${athlete.stats.adherence7d}%` : '--' }}
                  </p>
                  <p class="mt-2 text-xs text-gray-500">
                    {{ athlete.stats.completedCount }}/{{ athlete.stats.plannedCount }} sessions
                    completed
                  </p>
                </UCard>
              </div>

              <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <UCard class="xl:col-span-2" :ui="mobileListCardUi">
                  <template #header>
                    <div class="flex items-center justify-between gap-3">
                      <div>
                        <h3 class="font-bold">Fitness Trend</h3>
                        <p class="text-xs text-gray-500">
                          Thirty-day load trend from athlete wellness history.
                        </p>
                      </div>
                      <UBadge v-if="performanceSummary?.lastUpdated" color="neutral" variant="soft">
                        Updated {{ formatLongDate(performanceSummary.lastUpdated) }}
                      </UBadge>
                    </div>
                  </template>
                  <div class="h-72 w-full">
                    <LineChart v-if="chartData" :data="chartData" :options="chartOptions" />
                    <div
                      v-else
                      class="h-full flex items-center justify-center text-gray-500 italic"
                    >
                      Insufficient trend data to display chart.
                    </div>
                  </div>
                </UCard>

                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold">Recovery Snapshot</h3>
                  </template>

                  <div class="space-y-4">
                    <div class="grid grid-cols-2 gap-3">
                      <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                        <p class="text-[10px] uppercase font-bold text-gray-500">Sleep score</p>
                        <p class="text-xl font-black">
                          {{ readinessSummary?.sleepScore ?? '--' }}
                        </p>
                      </div>
                      <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                        <p class="text-[10px] uppercase font-bold text-gray-500">HRV</p>
                        <p class="text-xl font-black">
                          {{ readinessSummary?.hrv ?? '--' }}
                        </p>
                      </div>
                      <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                        <p class="text-[10px] uppercase font-bold text-gray-500">Resting HR</p>
                        <p class="text-xl font-black">
                          {{ readinessSummary?.restingHr ?? '--' }}
                        </p>
                      </div>
                      <div class="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                        <p class="text-[10px] uppercase font-bold text-gray-500">Weight</p>
                        <p class="text-xl font-black">
                          {{ readinessSummary?.weight ?? '--' }}
                        </p>
                      </div>
                    </div>

                    <div class="rounded-lg bg-neutral-50 dark:bg-neutral-900/50 p-3">
                      <p class="text-[10px] uppercase font-bold text-gray-500 mb-1">Coach take</p>
                      <p class="text-sm text-gray-700 dark:text-gray-300">
                        {{ recoverySummaryText }}
                      </p>
                    </div>
                  </div>
                </UCard>
              </div>

              <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <div class="flex items-center justify-between">
                      <div>
                        <h3 class="font-bold">Upcoming Training</h3>
                        <p class="text-xs text-gray-500">Planned sessions scheduled next.</p>
                      </div>
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        @click="
                          () => {
                            selectedTab = 'calendar'
                          }
                        "
                      >
                        View schedule
                      </UButton>
                    </div>
                  </template>

                  <div v-if="athlete.plannedWorkouts?.length" class="space-y-3">
                    <div
                      v-for="workout in athlete.plannedWorkouts"
                      :key="workout.id"
                      class="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 cursor-pointer hover:border-primary-500/50 transition-colors"
                      @click="
                        () => {
                          openPlannedWorkout(workout)
                        }
                      "
                    >
                      <div class="w-12 text-center shrink-0">
                        <p class="text-[10px] font-bold text-gray-400 uppercase">
                          {{ formatDayShort(workout.date) }}
                        </p>
                        <p class="text-sm font-black">{{ formatDateDay(workout.date) }}</p>
                      </div>
                      <div class="min-w-0 flex-1">
                        <p class="text-sm font-bold truncate">{{ workout.title }}</p>
                        <p class="text-xs text-gray-500">
                          {{ workout.type || 'Workout' }} •
                          {{ formatDurationMinutes(workout.durationSec) }} •
                          {{ formatTss(workout.tss) }}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div v-else class="text-center py-8 text-gray-500 italic">
                    No upcoming workouts planned.
                  </div>
                </UCard>

                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <div>
                      <h3 class="font-bold">Recent Completed Work</h3>
                      <p class="text-xs text-gray-500">
                        Most recent completed sessions from the athlete.
                      </p>
                    </div>
                  </template>

                  <div v-if="athlete.workouts?.length" class="space-y-3">
                    <div
                      v-for="workout in athlete.workouts"
                      :key="workout.id"
                      class="flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-800 cursor-pointer hover:border-primary-500/50 transition-colors"
                      @click="
                        () => {
                          void openCompletedWorkout(workout)
                        }
                      "
                    >
                      <div class="w-14 text-center shrink-0">
                        <p class="text-[10px] font-bold text-gray-400 uppercase">
                          {{ formatDayShort(workout.date) }}
                        </p>
                        <p class="text-sm font-black">{{ formatDateDay(workout.date) }}</p>
                      </div>
                      <div class="min-w-0 flex-1">
                        <p class="text-sm font-bold truncate">{{ workout.title }}</p>
                        <p class="text-xs text-gray-500">
                          {{ workout.type || 'Workout' }} •
                          {{ formatDurationMinutes(workout.durationSec) }} •
                          {{ formatTss(workout.tss) }}
                        </p>
                      </div>
                      <div class="text-right shrink-0">
                        <UBadge
                          :color="
                            workout.overallScore >= 7
                              ? 'success'
                              : workout.overallScore
                                ? 'warning'
                                : 'neutral'
                          "
                          variant="subtle"
                        >
                          {{ workout.overallScore ? `${workout.overallScore}/10` : 'No score' }}
                        </UBadge>
                      </div>
                    </div>
                  </div>

                  <div v-else class="text-center py-8 text-gray-500 italic">
                    No completed workouts available yet.
                  </div>
                </UCard>
              </div>
            </div>

            <div v-else-if="item.value === 'calendar'" class="space-y-6 pt-4">
              <div class="flex justify-end">
                <UButton
                  color="primary"
                  icon="i-heroicons-calendar-days"
                  :to="`/coaching/calendar?athlete=${athlete.id}`"
                >
                  Open Coach Calendar
                </UButton>
              </div>
              <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold">Schedule Pulse</h3>
                  </template>
                  <div class="space-y-3">
                    <div class="flex items-center justify-between text-sm">
                      <span class="text-gray-500">Planned last 7 days</span>
                      <span class="font-bold">{{ athlete.stats.plannedCount }}</span>
                    </div>
                    <div class="flex items-center justify-between text-sm">
                      <span class="text-gray-500">Completed last 7 days</span>
                      <span class="font-bold">{{ athlete.stats.completedCount }}</span>
                    </div>
                    <div class="flex items-center justify-between text-sm">
                      <span class="text-gray-500">Overdue planned</span>
                      <span class="font-bold">{{ athlete.stats.overduePlannedCount }}</span>
                    </div>
                  </div>
                </UCard>

                <UCard class="lg:col-span-2" :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold">Upcoming Events</h3>
                  </template>
                  <div v-if="athlete.events?.length" class="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div
                      v-for="event in athlete.events"
                      :key="event.id"
                      class="rounded-lg border border-orange-200 dark:border-orange-900/30 bg-orange-50 dark:bg-orange-950/20 p-4"
                    >
                      <p class="text-[10px] font-bold uppercase tracking-wider text-orange-500">
                        {{ getDaysUntil(event.date) }} days out
                      </p>
                      <p class="mt-2 font-bold">{{ event.title }}</p>
                      <p class="text-sm text-orange-700 dark:text-orange-300 mt-1">
                        {{ formatLongDate(event.date) }}
                      </p>
                    </div>
                  </div>
                  <div v-else class="text-center py-8 text-gray-500 italic">
                    No upcoming events.
                  </div>
                </UCard>
              </div>

              <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold">Upcoming Planned Sessions</h3>
                  </template>
                  <div v-if="athlete.plannedWorkouts?.length" class="space-y-3">
                    <div
                      v-for="workout in athlete.plannedWorkouts"
                      :key="workout.id"
                      class="rounded-lg border border-gray-200 dark:border-gray-800 p-4 cursor-pointer hover:border-primary-500/50 transition-colors"
                      @click="
                        () => {
                          openPlannedWorkout(workout)
                        }
                      "
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <p class="font-bold">{{ workout.title }}</p>
                          <p class="text-sm text-gray-500 mt-1">
                            {{ formatLongDate(workout.date) }} • {{ workout.type || 'Workout' }}
                          </p>
                        </div>
                        <UBadge color="neutral" variant="soft">
                          {{ formatTss(workout.tss) }}
                        </UBadge>
                      </div>
                    </div>
                  </div>
                  <div v-else class="text-center py-8 text-gray-500 italic">
                    No planned sessions queued.
                  </div>
                </UCard>

                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold">Recent Completed Sessions</h3>
                  </template>
                  <div v-if="athlete.workouts?.length" class="space-y-3">
                    <div
                      v-for="workout in athlete.workouts"
                      :key="workout.id"
                      class="rounded-lg border border-gray-200 dark:border-gray-800 p-4 cursor-pointer hover:border-primary-500/50 transition-colors"
                      @click="
                        () => {
                          void openCompletedWorkout(workout)
                        }
                      "
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <p class="font-bold">{{ workout.title }}</p>
                          <p class="text-sm text-gray-500 mt-1">
                            {{ formatLongDate(workout.date) }} • {{ workout.type || 'Workout' }}
                          </p>
                        </div>
                        <UBadge
                          :color="workout.plannedWorkoutId ? 'success' : 'neutral'"
                          variant="subtle"
                        >
                          {{ workout.plannedWorkoutId ? 'Matched' : 'Ad hoc' }}
                        </UBadge>
                      </div>
                    </div>
                  </div>
                  <div v-else class="text-center py-8 text-gray-500 italic">
                    No completed sessions recorded.
                  </div>
                </UCard>
              </div>
            </div>

            <div v-else-if="item.value === 'zones'" class="space-y-6 pt-4">
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold text-xs text-gray-500 uppercase">FTP</h3>
                  </template>
                  <p class="text-3xl font-black">{{ athlete.zoneSummary?.ftp ?? '--' }}</p>
                </UCard>
                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold text-xs text-gray-500 uppercase">LTHR</h3>
                  </template>
                  <p class="text-3xl font-black">{{ athlete.zoneSummary?.lthr ?? '--' }}</p>
                </UCard>
                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold text-xs text-gray-500 uppercase">Max HR</h3>
                  </template>
                  <p class="text-3xl font-black">{{ athlete.zoneSummary?.maxHr ?? '--' }}</p>
                </UCard>
              </div>

              <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold">Power Zones</h3>
                  </template>
                  <div v-if="athlete.zones?.power?.length" class="space-y-2">
                    <div
                      v-for="zone in athlete.zones.power"
                      :key="zone.name"
                      class="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2"
                    >
                      <span class="font-bold">{{ zone.name }}</span>
                      <span class="text-sm text-gray-500">{{ zone.min }}-{{ zone.max }} W</span>
                    </div>
                  </div>
                  <div v-else class="text-center py-8 text-gray-500 italic">
                    No power zones configured.
                  </div>
                </UCard>

                <UCard :ui="mobileListCardUi">
                  <template #header>
                    <h3 class="font-bold">Heart Rate Zones</h3>
                  </template>
                  <div v-if="athlete.zones?.hr?.length" class="space-y-2">
                    <div
                      v-for="zone in athlete.zones.hr"
                      :key="zone.name"
                      class="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2"
                    >
                      <span class="font-bold">{{ zone.name }}</span>
                      <span class="text-sm text-gray-500">{{ zone.min }}-{{ zone.max }} bpm</span>
                    </div>
                  </div>
                  <div v-else class="text-center py-8 text-gray-500 italic">
                    No heart rate zones configured.
                  </div>
                </UCard>
              </div>
            </div>

            <div v-else-if="item.value === 'nutrition'" class="space-y-6 pt-4">
              <CoachingAthleteNutritionSummary :athlete-id="athleteId" />
            </div>
          </template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>

  <UModal
    v-model:open="showWorkoutPreviewModal"
    title="Workout Overview"
    description="A quick coach-facing summary of the completed session."
  >
    <template #body>
      <div v-if="selectedWorkout" class="space-y-4 p-2">
        <div>
          <div class="text-lg font-black">{{ selectedWorkout.title }}</div>
          <div class="text-xs uppercase tracking-widest text-muted">
            {{ selectedWorkout.type || 'Workout' }} •
            {{ formatLongDate(selectedWorkout.date) }}
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-xl border border-default/70 p-3">
            <div class="text-[10px] font-black uppercase tracking-wider text-muted">Duration</div>
            <div class="mt-1 text-base font-black">
              {{ formatDurationMinutes(selectedWorkout.durationSec) }}
            </div>
          </div>
          <div class="rounded-xl border border-default/70 p-3">
            <div class="text-[10px] font-black uppercase tracking-wider text-muted">TSS</div>
            <div class="mt-1 text-base font-black">
              {{ Math.round(selectedWorkout.tss || 0) }}
            </div>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
  import { Line as LineChart } from 'vue-chartjs'
  import { mobileListCardUi } from '~/utils/mobile-surface-ui'
  import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    Filler
  } from 'chart.js'

  definePageMeta({
    middleware: 'auth'
  })

  ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    Filler
  )

  const { tr } = useCoachingI18n()
  const { formatDateUTC } = useFormat()
  const route = useRoute()
  const router = useRouter()
  const coachingStore = useCoachingStore()
  const { messageAthlete: openAthleteChat } = useCoachingMessageAthlete()
  const toast = useToast()
  const athleteId = route.params.id as string
  const removingAthlete = ref(false)

  interface AthleteProfile {
    id: string
    name: string | null
    email: string | null
    image: string | null
    currentFitnessScore: number | null
    profileLastUpdated: Date | string | null
    recommendations: any[]
    wellness: any[]
    plannedWorkouts: any[]
    events: any[]
    workouts: any[]
    performanceSummary: {
      currentCTL: number | null
      currentATL: number | null
      currentTSB: number | null
      formStatus: string
      formColor: string
      formDescription: string
      lastUpdated: Date | string | null
    }
    readinessSummary: {
      score: number | null
      status: string
      date: Date | string | null
      sleepScore: number | null
      hrv: number | null
      restingHr: number | null
      weight: number | null
    }
    zones: any
    zoneSummary: {
      ftp: number | null
      lthr: number | null
      maxHr: number | null
    }
    stats: {
      adherence7d: number | null
      completedCount: number
      plannedCount: number
      overduePlannedCount: number
    }
  }

  const {
    data: athlete,
    pending,
    error
  } = useAsyncData<AthleteProfile>(
    `athlete-${athleteId}`,
    () => ($fetch as any)(`/api/coaching/athletes/${athleteId}`),
    {
      lazy: true
    }
  ) as any

  const athleteName = computed(() => athlete.value?.name || 'Athlete Profile')

  // Accessible name for the act-as trigger, mirroring AthleteCard's actAsLabel
  // (CW-642). Reuses the same `athlete_card_act_as_aria` Tolgee key and the
  // same name || email || 'Athlete' fallback so a nameless athlete never
  // yields a dangling label.
  const actAsDetailLabel = computed(() =>
    tr('athlete_card_act_as_aria', 'View the app as {name}', {
      name: (athlete.value?.name || athlete.value?.email || 'Athlete') as string
    })
  )

  useHead({
    title: computed(() => `${athleteName.value} - Coaching`)
  })

  const selectedTab = ref('overview')
  const showWorkoutPreviewModal = ref(false)
  const selectedWorkout = ref<any | null>(null)
  const tabItems = [
    { value: 'overview', label: 'Overview', icon: 'i-heroicons-squares-2x2' },
    { value: 'calendar', label: 'Calendar', icon: 'i-heroicons-calendar' },
    { value: 'zones', label: 'Zones', icon: 'i-heroicons-adjustments-horizontal' },
    { value: 'nutrition', label: 'Nutrition', icon: 'i-heroicons-cake' }
  ]

  const performanceSummary = computed(() => athlete.value?.performanceSummary ?? null)
  const readinessSummary = computed(() => athlete.value?.readinessSummary ?? null)

  const currentCTL = computed(() => performanceSummary.value?.currentCTL ?? null)
  const currentATL = computed(() => performanceSummary.value?.currentATL ?? null)
  const currentTSB = computed(() => performanceSummary.value?.currentTSB ?? null)

  const recoverySummaryText = computed(() => {
    if (readinessSummary.value?.score == null) {
      return 'No recent readiness signal is available yet. Sync wellness data to unlock recovery context here.'
    }

    if ((readinessSummary.value.score ?? 0) >= 80) {
      return 'Recovery markers are strong. This athlete looks ready for quality work if the schedule demands it.'
    }

    if ((readinessSummary.value.score ?? 0) >= 60) {
      return 'Recovery is serviceable, but not perfect. Keep an eye on accumulated fatigue and session execution.'
    }

    return 'Recovery is under pressure. Consider dialing back intensity or prioritizing sleep and freshness before stacking load.'
  })

  const getTSBColor = (tsb: number | null) => {
    if (tsb === null) return 'text-gray-500'
    if (tsb > 5) return 'text-green-500'
    if (tsb < -25) return 'text-red-500'
    if (tsb < -10) return 'text-orange-500'
    return 'text-gray-900 dark:text-white'
  }

  const getFormBadgeColor = (color: string | null | undefined) => {
    if (color === 'green') return 'success'
    if (color === 'yellow') return 'warning'
    if (color === 'orange' || color === 'red') return 'error'
    if (color === 'blue') return 'primary'
    return 'neutral'
  }

  const getReadinessBadgeColor = (score: number | null | undefined) => {
    if (score === null || score === undefined) return 'neutral'
    if (score >= 80) return 'success'
    if (score >= 60) return 'primary'
    if (score >= 40) return 'warning'
    return 'error'
  }

  const getRecommendationColor = (rec: string) => {
    const colors: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
      proceed: 'success',
      modify: 'warning',
      reduce_intensity: 'warning',
      rest: 'error'
    }
    return colors[rec] || 'neutral'
  }

  const getRecommendationLabel = (rec: string) => {
    const labels: Record<string, string> = {
      proceed: 'Optimal',
      modify: 'Caution',
      reduce_intensity: 'Overreach',
      rest: 'Recover'
    }
    return labels[rec] || rec
  }

  function formatMetricNumber(value: number | null | undefined) {
    return value === null || value === undefined ? '--' : Math.round(value).toString()
  }

  function formatSignedMetricNumber(value: number | null | undefined) {
    if (value === null || value === undefined) return '--'
    const rounded = Math.round(value)
    return rounded > 0 ? `+${rounded}` : `${rounded}`
  }

  function formatDayShort(date: string) {
    return formatDateUTC(date, 'EEE')
  }

  function formatDateDay(date: string) {
    return formatDateUTC(date, 'd')
  }

  function formatLongDate(date: string | Date) {
    return formatDateUTC(date, 'MMMM d, yyyy')
  }

  function formatDurationMinutes(durationSec: number | null | undefined) {
    if (!durationSec) return '--'
    return `${Math.round(durationSec / 60)}m`
  }

  function formatTss(tss: number | null | undefined) {
    if (tss === null || tss === undefined) return '--'
    return `${Math.round(tss)} TSS`
  }

  function getDaysUntil(date: string) {
    const diff = new Date(date).getTime() - new Date().getTime()
    return Math.ceil(diff / (1000 * 60 * 60 * 24))
  }

  const chartData = computed(() => {
    const history = [...(athlete.value?.wellness || [])]
      .filter((entry: any) => entry.ctl !== null || entry.atl !== null)
      .reverse()

    if (history.length < 2) return null

    return {
      labels: history.map((entry: any) => formatDateUTC(entry.date, 'MMM d')),
      datasets: [
        {
          label: 'Fitness (CTL)',
          data: history.map((entry: any) => entry.ctl),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.1)',
          borderWidth: 3,
          pointRadius: 0,
          tension: 0.35,
          fill: true
        },
        {
          label: 'Fatigue (ATL)',
          data: history.map((entry: any) => entry.atl),
          borderColor: '#ef4444',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35,
          borderDash: [6, 4],
          fill: false
        }
      ]
    }
  })

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      intersect: false,
      mode: 'index' as const
    },
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: {
          boxWidth: 12,
          padding: 20,
          font: { size: 11, weight: 'bold' as const }
        }
      },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        padding: 12,
        titleFont: { size: 12 },
        bodyFont: { size: 13, weight: 'bold' as const }
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }
      },
      y: {
        beginAtZero: false,
        grid: { color: 'rgba(0, 0, 0, 0.05)' }
      }
    }
  }

  function messageAthlete() {
    if (!athlete.value) return
    openAthleteChat(athlete.value)
  }

  function actAsAthlete() {
    if (!athlete.value) return
    const name = athlete.value.name || athlete.value.email || 'Athlete'
    coachingStore.startActingAs(athlete.value.id, name)
  }

  async function confirmRemoveAthlete() {
    if (!athlete.value) return
    const name = athlete.value.name || athlete.value.email || 'this athlete'
    if (
      !confirm(`Remove ${name} from your coaching roster? They will no longer be connected to you.`)
    ) {
      return
    }

    removingAthlete.value = true
    try {
      await $fetch<any, string & {}>(`/api/coaching/athletes/${athleteId}`, { method: 'DELETE' })
      toast.add({ title: 'Athlete removed', color: 'success' })
      await router.push('/coaching/athletes')
    } catch (err: any) {
      toast.add({
        title: err.data?.message || 'Failed to remove athlete',
        color: 'error'
      })
    } finally {
      removingAthlete.value = false
    }
  }

  function openPlannedWorkout(_workout: { id: string }) {
    void router.push(`/coaching/calendar?athlete=${athleteId}`)
  }

  async function openCompletedWorkout(workout: { id: string }) {
    try {
      selectedWorkout.value = await $fetch<any, string & {}>(
        `/api/coaching/athletes/${athleteId}/workouts/${workout.id}`
      )
      showWorkoutPreviewModal.value = true
    } catch (error: any) {
      toast.add({
        title: 'Failed to load workout',
        description: error.data?.message || 'This workout may no longer be available.',
        color: 'error'
      })
    }
  }
</script>
