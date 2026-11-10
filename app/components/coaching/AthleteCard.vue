<template>
  <UCard
    class="flex flex-col h-full transition-all overflow-hidden group"
    :class="{
      'hover:ring-2 hover:ring-primary-500 cursor-pointer': canInteract,
      'opacity-80 grayscale-[0.5]': !canInteract
    }"
    :ui="mobileListCardUi"
    @click="
      () => {
        canInteract ? $emit('view', athlete) : null
      }
    "
  >
    <template #header>
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-3 min-w-0">
          <UAvatar
            :src="athlete.image"
            :alt="athlete.name"
            size="lg"
            class="ring-2 ring-gray-100 dark:ring-gray-800"
          />
          <div class="min-w-0">
            <h4
              class="font-bold text-gray-900 dark:text-white truncate transition-colors"
              :class="{ 'group-hover:text-primary-600': canInteract }"
            >
              {{ athlete.name }}
            </h4>
            <p v-if="!athlete.isMasked" class="text-xs text-neutral-500 truncate">
              {{ athlete.email }}
            </p>
            <p
              v-else
              class="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mt-0.5"
            >
              Teammate
            </p>
          </div>
        </div>

        <div v-if="!athlete.isMasked" class="flex flex-col items-end gap-1">
          <UBadge
            v-if="athlete.recommendations?.length"
            :color="getRecommendationColor(athlete.recommendations[0].recommendation)"
            size="xs"
            variant="subtle"
            class="font-bold uppercase tracking-wider"
          >
            {{ getRecommendationLabel(athlete.recommendations[0].recommendation) }}
          </UBadge>
          <p v-if="athlete.profileLastUpdated" class="text-[10px] text-neutral-400 font-medium">
            {{ formatRelativeTime(athlete.profileLastUpdated) }}
          </p>
        </div>
        <div v-else>
          <UIcon name="i-heroicons-lock-closed" class="w-4 h-4 text-neutral-300" />
        </div>
      </div>
    </template>

    <div class="space-y-4">
      <!-- 1. Primary Metrics Grid -->
      <div class="grid grid-cols-3 gap-2">
        <div
          class="bg-neutral-50 dark:bg-neutral-800/50 p-2 rounded-lg text-center border border-gray-100 dark:border-gray-800"
        >
          <p class="text-[10px] text-neutral-500 uppercase font-bold mb-0.5">Fitness</p>
          <p
            v-if="!athlete.isMasked"
            class="text-lg font-black text-blue-600 dark:text-blue-400 leading-tight"
          >
            {{ currentCTL !== undefined && currentCTL !== null ? Math.round(currentCTL) : '--' }}
          </p>
          <p v-else class="text-lg font-black text-neutral-300 leading-tight">--</p>
          <p class="text-[9px] text-neutral-400">CTL</p>
        </div>
        <div
          class="bg-neutral-50 dark:bg-neutral-800/50 p-2 rounded-lg text-center border border-gray-100 dark:border-gray-800"
        >
          <p class="text-[10px] text-neutral-500 uppercase font-bold mb-0.5">Form</p>
          <p
            v-if="!athlete.isMasked"
            class="text-lg font-black leading-tight"
            :class="getTSBColor(currentTSB)"
          >
            {{ currentTSB !== null ? Math.round(currentTSB) : '--' }}
          </p>
          <p v-else class="text-lg font-black text-neutral-300 leading-tight">--</p>
          <p class="text-[9px] text-neutral-400">TSB</p>
        </div>
        <div
          class="bg-neutral-50 dark:bg-neutral-800/50 p-2 rounded-lg text-center border border-gray-100 dark:border-gray-800"
        >
          <p class="text-[10px] text-neutral-500 uppercase font-bold mb-0.5">7d Comp.</p>
          <p
            v-if="canInteract"
            class="text-lg font-black leading-tight"
            :class="
              adherence7d !== null && adherence7d !== undefined
                ? adherence7d >= 80
                  ? 'text-green-600'
                  : 'text-orange-500'
                : 'text-neutral-400'
            "
          >
            {{ adherence7d != null ? `${adherence7d}%` : '--' }}
          </p>
          <p v-else class="text-lg font-black text-neutral-300 leading-tight">--%</p>
          <p class="text-[9px] text-neutral-400">
            {{ athlete.stats?.completedCount ?? 0 }}/{{ athlete.stats?.plannedCount ?? 0 }}
          </p>
        </div>
      </div>

      <!-- 2. Sparkline (Fitness Trend) -->
      <div v-if="!athlete.isMasked" class="h-16 w-full px-1 relative">
        <LineChart v-if="chartData" :data="chartData" :options="chartOptions" />
        <div
          v-else
          class="h-full flex items-center justify-center text-[10px] text-neutral-400 italic"
        >
          Insufficient trend data
        </div>
        <!-- Alert Pulse -->
        <div
          v-if="isOvertrained || isSlacking"
          class="absolute top-0 right-0 w-2 h-2 rounded-full bg-red-500 animate-ping"
          :title="isOvertrained ? 'High Fatigue Alert' : 'Low Compliance Alert'"
        />
      </div>
      <div
        v-else
        class="h-16 w-full bg-neutral-50 dark:bg-neutral-900/50 rounded-lg border border-dashed border-neutral-200 dark:border-neutral-800 flex items-center justify-center"
      >
        <UIcon name="i-heroicons-eye-slash" class="w-5 h-5 text-neutral-200" />
      </div>

      <!-- 3. Training Preview -->
      <div class="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-800">
        <div class="flex items-center justify-between text-xs">
          <span class="font-bold text-neutral-400 uppercase tracking-tighter">Next Session</span>
          <span v-if="nextWorkout && !athlete.isMasked" class="text-neutral-500 font-medium">{{
            formatDate(nextWorkout.date)
          }}</span>
        </div>

        <div
          v-if="nextWorkout && !athlete.isMasked"
          class="flex items-center gap-2 bg-neutral-50 dark:bg-neutral-800/30 p-2 rounded border border-dashed border-gray-200 dark:border-gray-700"
        >
          <UIcon
            :name="getWorkoutIcon(nextWorkout.type)"
            class="w-4 h-4 text-primary-500 shrink-0"
          />
          <span class="text-xs font-bold truncate text-gray-700 dark:text-gray-300">
            {{ nextWorkout.title }}
          </span>
          <UBadge
            v-if="nextWorkout.tss"
            size="xs"
            color="neutral"
            variant="soft"
            class="ml-auto text-[9px]"
          >
            {{ Math.round(nextWorkout.tss) }} TSS
          </UBadge>
        </div>
        <div
          v-else-if="athlete.isMasked"
          class="text-[11px] text-neutral-400 italic py-1 flex items-center gap-1"
        >
          <UIcon name="i-heroicons-lock-closed" class="w-3 h-3" />
          Private Profile
        </div>
        <div v-else class="text-[11px] text-neutral-400 italic py-1">
          No upcoming workouts planned.
        </div>

        <!-- Next Major Event -->
        <div
          v-if="nextEvent && !athlete.isMasked"
          class="flex items-center gap-2 mt-2 px-1 text-orange-600 dark:text-orange-400"
        >
          <UIcon name="i-heroicons-flag" class="w-3.5 h-3.5" />
          <span class="text-[11px] font-black uppercase tracking-tight">
            {{ daysToEvent }} DAYS TO {{ nextEvent.title }}
          </span>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex gap-2">
        <UButton
          class="flex-1 font-bold"
          :label="
            athlete.isMasked
              ? 'Private Profile'
              : athlete.canViewDetails === false
                ? 'Not Your Athlete'
                : 'Analyze Athlete'
          "
          :icon="
            athlete.isMasked || athlete.canViewDetails === false
              ? 'i-heroicons-lock-closed'
              : 'i-heroicons-chart-bar'
          "
          :variant="canInteract ? 'soft' : 'ghost'"
          :color="canInteract ? 'primary' : 'neutral'"
          size="sm"
          :disabled="!canInteract"
          @click.stop="
            () => {
              if (canInteract) $emit('view', athlete)
            }
          "
        />
        <UTooltip v-if="canInteract" text="Ask AI about athlete">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-heroicons-chat-bubble-left-right"
            size="sm"
            @click.stop="$emit('message', athlete)"
          />
        </UTooltip>
        <UTooltip v-if="canInteract" :text="actAsLabel">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-heroicons-eye"
            size="sm"
            :label="t('athlete_card_act_as')"
            :aria-label="actAsLabel"
            :title="actAsLabel"
            @click.stop="$emit('act-as', athlete)"
          />
        </UTooltip>
      </div>
      <p
        v-if="athlete.canViewDetails === false && !athlete.isMasked"
        class="mt-2 text-[10px] text-neutral-400 text-center leading-snug"
      >
        Connect with their invite code to coach this athlete
      </p>
    </template>
  </UCard>
</template>

<script setup lang="ts">
  import { Line as LineChart } from 'vue-chartjs'
  import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Tooltip,
    Filler
  } from 'chart.js'
  import { formatDistanceToNow } from 'date-fns'
  import { useTranslate } from '@tolgee/vue'
  import { mobileListCardUi } from '~/utils/mobile-surface-ui'

  ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

  const props = defineProps<{
    athlete: any
  }>()

  defineEmits(['view', 'message', 'act-as'])

  const { t } = useTranslate('coaching')

  // Named for screen readers and on hover/long-press: the bare eye icon gave no
  // hint that it switches the whole app to the athlete's identity (CW-541).
  // Same fallback chain the three trigger sites use. `?? ''` produced the
  // accessible name "View the app as " — with a trailing space and no subject —
  // for an athlete with no name set, which is exactly the case a screen-reader
  // user cannot recover from.
  const actAsLabel = computed(() =>
    t.value('athlete_card_act_as_aria', {
      name: props.athlete?.name || props.athlete?.email || 'Athlete'
    })
  )

  const currentWellness = computed(() => props.athlete.wellness?.[0] || null)
  const canInteract = computed(
    () => !props.athlete.isMasked && props.athlete.canViewDetails !== false
  )
  const adherence7d = computed(() => props.athlete.stats?.adherence7d ?? null)
  const performanceSummary = computed(() => props.athlete.performanceSummary || null)
  const currentCTL = computed(
    () => performanceSummary.value?.currentCTL ?? currentWellness.value?.ctl ?? null
  )
  const currentTSB = computed(() => {
    if (
      performanceSummary.value?.currentTSB !== undefined &&
      performanceSummary.value?.currentTSB !== null
    ) {
      return performanceSummary.value.currentTSB
    }
    if (!currentWellness.value) return null
    if (currentWellness.value.ctl == null || currentWellness.value.atl == null) return null
    return currentWellness.value.ctl - currentWellness.value.atl
  })

  const nextWorkout = computed(() => props.athlete.plannedWorkouts?.[0] || null)
  const nextEvent = computed(() => props.athlete.events?.[0] || null)

  const daysToEvent = computed(() => {
    if (!nextEvent.value) return 0
    const diff = new Date(nextEvent.value.date).getTime() - new Date().getTime()
    return Math.ceil(diff / (1000 * 60 * 60 * 24))
  })

  // Alert Logic
  const isOvertrained = computed(() => currentTSB.value !== null && currentTSB.value < -25)
  const isSlacking = computed(() => {
    const adherence = props.athlete.stats?.adherence7d
    return adherence != null && adherence < 60
  })

  const getTSBColor = (tsb: number | null) => {
    if (tsb === null) return 'text-neutral-400'
    if (tsb > 5) return 'text-green-500'
    if (tsb < -20) return 'text-red-500'
    return 'text-gray-900 dark:text-white'
  }

  const getRecommendationColor = (rec: string) => {
    const colors: Record<string, any> = {
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

  const getWorkoutIcon = (type: string) => {
    if (type?.toLowerCase().includes('run')) return 'i-heroicons-bolt'
    if (type?.toLowerCase().includes('ride') || type?.toLowerCase().includes('bike'))
      return 'i-heroicons-command-line'
    if (type?.toLowerCase().includes('weight') || type?.toLowerCase().includes('gym'))
      return 'i-heroicons-square-3-stack-3d'
    return 'i-heroicons-activity-diet'
  }

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    })
  }

  const formatRelativeTime = (date: string) => {
    try {
      return formatDistanceToNow(new Date(date), { addSuffix: true })
    } catch (e) {
      return ''
    }
  }

  // Chart Logic
  const chartData = computed(() => {
    const history =
      props.athlete.stats?.wellnessHistory ||
      [...(props.athlete.wellness || [])].filter((entry: any) => entry.ctl != null).reverse()
    if (history.length < 2) return null

    return {
      labels: history.map((w: any) => w.date),
      datasets: [
        {
          label: 'Fitness',
          data: history.map((w: any) => w.ctl),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          fill: true
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
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        padding: 8,
        titleFont: { size: 10 },
        bodyFont: { size: 12, weight: 'bold' as const },
        callbacks: {
          label: (context: any) => `Fitness: ${Math.round(context.raw)} CTL`,
          title: (context: any) => {
            const date = new Date(context[0].label)
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          }
        }
      }
    },
    scales: {
      x: { display: false },
      y: { display: false }
    }
  }
</script>
