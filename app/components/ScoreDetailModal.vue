<template>
  <UModal
    v-model:open="isOpen"
    :title="title"
    :description="`Score: ${displayScore}/10 - ${scoreLabel}`"
    scrollable
    :ui="{
      footer: 'justify-end'
    }"
  >
    <template #body>
      <div class="space-y-8">
        <!-- Score Display Section -->
        <div
          class="flex items-center gap-6 p-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 ring-1 ring-inset ring-gray-200 dark:ring-gray-700"
        >
          <div class="flex-shrink-0 text-center">
            <div :class="['text-5xl font-bold font-sans tracking-tight', scoreColorClass]">
              {{ displayScore }}
            </div>
            <div class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mt-1">
              Out of 10
            </div>
          </div>

          <div class="flex-1 space-y-3">
            <div class="flex justify-between items-end">
              <p class="text-sm font-bold uppercase tracking-wider" :class="scoreColorClass">
                {{ scoreLabel }}
              </p>
            </div>
            <UProgress
              :model-value="score ? Math.min(100, Math.max(0, score * 10)) : 0"
              size="lg"
              :color="progressColor"
            />
          </div>
        </div>

        <!-- Structured Analysis -->
        <div v-if="analysisData" class="space-y-8">
          <!-- Executive Summary -->
          <div v-if="analysisData.executive_summary" class="space-y-3">
            <h4
              class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest"
            >
              Executive Summary
            </h4>
            <p class="text-sm text-gray-700 dark:text-gray-300 leading-relaxed font-medium">
              {{ analysisData.executive_summary }}
            </p>
          </div>

          <!-- Analysis Sections -->
          <div v-if="analysisData.sections && analysisData.sections.length > 0" class="space-y-4">
            <h4
              class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest"
            >
              Detailed Analysis
            </h4>
            <div class="grid gap-4">
              <div
                v-for="(section, idx) in analysisData.sections"
                :key="idx"
                class="p-4 rounded-lg border border-gray-200 dark:border-gray-700 space-y-3"
              >
                <div class="flex items-center justify-between">
                  <span class="font-bold text-gray-900 dark:text-white">{{ section.title }}</span>
                  <UBadge
                    color="neutral"
                    :class="getAnalysisStatusClass(section.status)"
                    variant="subtle"
                    size="xs"
                    class="font-bold"
                  >
                    {{ getStatusLabel(section.status) }}
                  </UBadge>
                </div>
                <ul class="space-y-2">
                  <li
                    v-for="(point, pIdx) in section.analysis_points"
                    :key="pIdx"
                    class="text-sm text-gray-600 dark:text-gray-400 flex items-start gap-2 leading-snug"
                  >
                    <UIcon
                      name="i-heroicons-chevron-right"
                      class="w-4 h-4 text-gray-400 dark:text-gray-500 mt-0.5 flex-shrink-0"
                    />
                    <span>{{ point }}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <!-- Recommendations -->
          <div
            v-if="analysisData.recommendations && analysisData.recommendations.length > 0"
            class="space-y-4"
          >
            <h4
              class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest"
            >
              Actionable Recommendations
            </h4>
            <div class="grid gap-3">
              <div
                v-for="(rec, idx) in analysisData.recommendations"
                :key="idx"
                class="flex items-start gap-4 p-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 ring-1 ring-inset ring-gray-200 dark:ring-gray-700"
              >
                <div
                  class="p-2 rounded-lg bg-white dark:bg-gray-900 shadow-sm ring-1 ring-gray-200 dark:ring-gray-800"
                >
                  <UIcon
                    :name="getPriorityIcon(rec.priority)"
                    :class="['w-6 h-6 flex-shrink-0', getPriorityColor(rec.priority)]"
                  />
                </div>
                <div class="flex-1 space-y-1">
                  <div class="font-bold text-gray-900 dark:text-white">{{ rec.title }}</div>
                  <div class="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                    {{ rec.description }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Fallback: Plain text explanation -->
        <div v-else-if="explanation" class="space-y-4">
          <h4 class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest">
            Analysis Details
          </h4>
          <div class="prose prose-sm dark:prose-invert max-w-none">
            <p
              class="text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-line font-medium"
            >
              {{ explanation }}
            </p>
          </div>
        </div>

        <!-- Improvement Actions (parsed from plain text explanation) -->
        <div v-if="!analysisData && improvementActions.length > 0" class="space-y-4">
          <h4 class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest">
            Key Takeaways
          </h4>
          <div class="grid gap-2">
            <div
              v-for="(action, index) in improvementActions"
              :key="index"
              class="flex items-start gap-3 p-3 rounded-lg bg-primary-50/50 dark:bg-primary-900/10 border border-primary-100 dark:border-primary-900/20"
            >
              <UIcon
                name="i-heroicons-check-badge"
                class="w-5 h-5 text-primary-600 dark:text-primary-400 flex-shrink-0"
              />
              <span class="text-sm text-gray-700 dark:text-gray-200 font-medium leading-tight">{{
                action
              }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #footer="{ close }">
      <UButton
        color="neutral"
        variant="outline"
        @click="
          () => {
            void close()
          }
        "
      >
        Close
      </UButton>
    </template>
  </UModal>
</template>

<script setup lang="ts">
  import { getAnalysisStatusClass } from '~/utils/analysis-status'

  interface AnalysisData {
    executive_summary?: string
    sections?: Array<{
      title: string
      status: string
      analysis_points: string[]
    }>
    recommendations?: Array<{
      title: string
      description: string
      priority: string
    }>
  }

  const props = defineProps<{
    modelValue: boolean
    title: string
    score?: number | null
    explanation?: string | null
    analysisData?: AnalysisData | null
    color?: 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'cyan'
  }>()

  const emit = defineEmits<{
    'update:modelValue': [value: boolean]
  }>()

  const isOpen = computed({
    get: () => props.modelValue,
    set: (value) => emit('update:modelValue', value)
  })

  const displayScore = computed(() => {
    if (props.score === null || props.score === undefined) return '--'
    return Number.isInteger(props.score) ? props.score.toString() : props.score.toFixed(1)
  })

  const scoreColorClass = computed(() => {
    if (!props.score) return 'text-gray-400'
    if (props.score >= 9) return 'text-green-600 dark:text-green-400'
    if (props.score >= 7) return 'text-blue-600 dark:text-blue-400'
    if (props.score >= 5) return 'text-yellow-600 dark:text-yellow-400'
    if (props.score >= 3) return 'text-orange-600 dark:text-orange-400'
    return 'text-red-600 dark:text-red-400'
  })

  const progressColor = computed(() => {
    if (!props.score) return 'neutral' as const
    if (props.score >= 9) return 'success' as const
    if (props.score >= 7) return 'primary' as const
    if (props.score >= 5) return 'warning' as const
    if (props.score >= 3) return 'warning' as const
    return 'error' as const
  })

  const scoreLabel = computed(() => {
    if (!props.score) return 'No data'
    if (props.score >= 9) return 'Exceptional'
    if (props.score >= 7) return 'Strong'
    if (props.score >= 5) return 'Adequate'
    if (props.score >= 3) return 'Needs Work'
    return 'Poor'
  })

  // Status helpers
  const getStatusLabel = (status: string) => {
    if (!status) return 'Unknown'
    return status
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  }

  // Priority helpers
  const getPriorityIcon = (priority: string) => {
    const map: Record<string, string> = {
      high: 'i-heroicons-exclamation-circle',
      medium: 'i-heroicons-information-circle',
      low: 'i-heroicons-light-bulb'
    }
    return map[priority] || 'i-heroicons-information-circle'
  }

  const getPriorityColor = (priority: string) => {
    const map: Record<string, string> = {
      high: 'text-red-600 dark:text-red-400',
      medium: 'text-amber-600 dark:text-amber-400',
      low: 'text-blue-600 dark:text-blue-400'
    }
    return map[priority] || 'text-gray-500'
  }

  // Parse improvement actions from plain text explanation (fallback)
  const improvementActions = computed(() => {
    if (props.analysisData || !props.explanation) return []

    const actions: string[] = []
    const lines = props.explanation.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      const match = trimmed.match(/^(?:\(\d+\)|\d+[.)]|[•\-*])\s*(.+)$/)
      if (match && match[1]) {
        actions.push(match[1].trim())
      }
    }

    return actions
  })
</script>
