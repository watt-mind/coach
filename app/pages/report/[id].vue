<template>
  <UDashboardPanel id="report-detail">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            icon="i-heroicons-arrow-left"
            color="neutral"
            variant="ghost"
            to="/reports"
            size="sm"
            :aria-label="tr('back_aria', 'Back to reports')"
          />
          <USeparator orientation="vertical" class="h-4" />
          <span class="text-sm sm:text-base font-semibold truncate max-w-[120px] sm:max-w-none">{{
            reportTitle || tr('default_title', 'Report')
          }}</span>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-0 sm:p-6 max-w-4xl mx-auto space-y-0 sm:space-y-6 pb-24">
        <div v-if="pending && !report" class="space-y-0 sm:space-y-6">
          <!-- Header Skeleton -->
          <div class="mb-6 px-4 sm:px-0">
            <div class="space-y-2 mb-4">
              <USkeleton class="h-8 w-64" />
              <div class="flex items-center gap-2">
                <USkeleton class="h-4 w-48" />
                <USkeleton class="h-4 w-24 rounded-md" />
              </div>
            </div>
          </div>

          <!-- Cards Skeleton -->
          <UCard v-for="i in 3" :key="i" :ui="mobileListCardUi">
            <template #header>
              <div class="flex items-center justify-between">
                <USkeleton class="h-6 w-48" />
                <USkeleton class="h-6 w-24 rounded-full" />
              </div>
            </template>
            <div class="space-y-3">
              <USkeleton v-for="j in 3" :key="j" class="h-4 w-full" />
            </div>
          </UCard>
        </div>

        <div v-else-if="report" class="space-y-0 sm:space-y-6">
          <!-- Header -->
          <div class="mb-6 px-4 sm:px-0">
            <div class="mb-4">
              <h2 class="text-xl sm:text-3xl font-bold">{{ reportTitle }}</h2>
              <!--
                Document metadata line: the date range the report covers, then the report's
                own lifecycle state (CW-442).

                Before this, the lifecycle state was a `UBadge` in the header's right-hand
                column: a `rounded-md` chip that rendered as the *sixth* `span[data-slot=base]`
                on the page, right-aligned in the same vertical run as the five analysis
                section grades below it. It differed from a grade only by being solid green
                instead of tinted, so it read as one -- and at 2.38:1 white-on-green it was
                also the loudest thing on the page.

                Four things now separate it from a grade: it sits inline in the metadata line
                under the title instead of in the grades' right-hand column; it is 11px
                uppercase against their 14px sentence case; it is icon-led where they carry no
                icon and ring-less where they carry a tinted `ring-inset`; and for COMPLETED --
                the only lifecycle state that ever shares the page with the grades -- it uses
                neutral zinc, so it is not on the severity ramp at all.
              -->
              <div
                class="mt-1 sm:mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-sm text-gray-600 dark:text-gray-400"
              >
                <span>{{ formatDateRange(report.dateRangeStart, report.dateRangeEnd) }}</span>
                <span aria-hidden="true" class="text-gray-400 dark:text-gray-600">&middot;</span>
                <span
                  class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide"
                  :class="statusChipClass"
                >
                  <UIcon :name="statusIcon" class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span class="sr-only">{{ tr('lifecycle_label', 'Report status') }}: </span>
                  {{ statusLabel }}
                </span>
              </div>
            </div>
          </div>

          <!-- Status Alert -->
          <UAlert
            v-if="report.status === 'PROCESSING'"
            color="info"
            icon="i-heroicons-arrow-path"
            :title="tr('generating_title', 'Generating Report')"
            :description="
              tr(
                'generating_desc',
                'Your AI coach is analyzing your training data. This may take a few moments...'
              )
            "
            class="mb-6 mx-4 sm:mx-0"
          />

          <UAlert
            v-else-if="report.status === 'FAILED'"
            color="error"
            icon="i-heroicons-exclamation-triangle"
            :title="tr('failed_title', 'Report Generation Failed')"
            :description="tr('failed_desc', 'Unable to generate report. Please try again.')"
            class="mb-6 mx-4 sm:mx-0"
          />

          <!-- Content - Structured JSON Display -->
          <div
            v-if="report.status === 'COMPLETED' && report.analysisJson"
            class="space-y-0 sm:space-y-6"
          >
            <!-- Quick Take / Executive Summary -->
            <UCard :ui="mobileListCardUi">
              <template #header>
                <h3 class="text-xl font-semibold">{{ tr('quick_take', 'Quick Take') }}</h3>
              </template>
              <p class="text-gray-700 dark:text-gray-300 leading-relaxed">
                {{ report.analysisJson.executive_summary }}
              </p>
            </UCard>

            <!-- Athlete Profile Sections -->
            <template v-if="report.analysisJson.type === 'athlete_profile'">
              <!-- Current Fitness -->
              <UCard v-if="report.analysisJson.current_fitness" :ui="mobileListCardUi">
                <template #header>
                  <div class="flex items-center justify-between">
                    <h3 class="text-xl font-semibold">
                      {{ tr('current_fitness', 'Current Fitness') }}
                    </h3>
                    <UBadge
                      color="neutral"
                      :class="getStatusBadgeClass(report.analysisJson.current_fitness.status)"
                      variant="subtle"
                      size="lg"
                    >
                      {{ report.analysisJson.current_fitness.status_label }}
                    </UBadge>
                  </div>
                </template>

                <div class="space-y-3">
                  <div
                    v-for="(point, idx) in report.analysisJson.current_fitness.key_points"
                    :key="idx"
                    class="flex gap-3"
                  >
                    <UIcon
                      name="i-heroicons-chevron-right"
                      class="w-5 h-5 text-primary mt-0.5 flex-shrink-0"
                    />
                    <p class="text-gray-700 dark:text-gray-300">{{ point }}</p>
                  </div>
                </div>
              </UCard>

              <!-- Training Characteristics -->
              <UCard v-if="report.analysisJson.training_characteristics" :ui="mobileListCardUi">
                <template #header>
                  <h3 class="text-xl font-semibold">
                    {{ tr('training_characteristics', 'Training Characteristics') }}
                  </h3>
                </template>

                <div class="space-y-4">
                  <div v-if="report.analysisJson.training_characteristics.training_style">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      {{ tr('training_style', 'Training Style') }}
                    </h4>
                    <p class="text-gray-700 dark:text-gray-300">
                      {{ report.analysisJson.training_characteristics.training_style }}
                    </p>
                  </div>

                  <div v-if="report.analysisJson.training_characteristics.strengths?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      {{ tr('strengths', 'Strengths') }}
                    </h4>
                    <div class="space-y-2">
                      <div
                        v-for="(strength, idx) in report.analysisJson.training_characteristics
                          .strengths"
                        :key="idx"
                        class="flex gap-3"
                      >
                        <UIcon
                          name="i-heroicons-check-circle"
                          class="w-5 h-5 text-green-500 mt-0.5 flex-shrink-0"
                        />
                        <p class="text-gray-700 dark:text-gray-300">{{ strength }}</p>
                      </div>
                    </div>
                  </div>

                  <div
                    v-if="
                      report.analysisJson.training_characteristics.areas_for_development?.length
                    "
                  >
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      {{ tr('areas_for_development', 'Areas for Development') }}
                    </h4>
                    <div class="space-y-2">
                      <div
                        v-for="(area, idx) in report.analysisJson.training_characteristics
                          .areas_for_development"
                        :key="idx"
                        class="flex gap-3"
                      >
                        <UIcon
                          name="i-heroicons-arrow-trending-up"
                          class="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0"
                        />
                        <p class="text-gray-700 dark:text-gray-300">{{ area }}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </UCard>

              <!-- Recovery Profile -->
              <UCard v-if="report.analysisJson.recovery_profile" :ui="mobileListCardUi">
                <template #header>
                  <h3 class="text-xl font-semibold">
                    {{ tr('recovery_profile', 'Recovery Profile') }}
                  </h3>
                </template>

                <div class="space-y-4">
                  <div v-if="report.analysisJson.recovery_profile.recovery_pattern">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      Recovery Pattern
                    </h4>
                    <p class="text-gray-700 dark:text-gray-300">
                      {{ report.analysisJson.recovery_profile.recovery_pattern }}
                    </p>
                  </div>

                  <div v-if="report.analysisJson.recovery_profile.hrv_trend">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">HRV Trend</h4>
                    <p class="text-gray-700 dark:text-gray-300">
                      {{ report.analysisJson.recovery_profile.hrv_trend }}
                    </p>
                  </div>

                  <div v-if="report.analysisJson.recovery_profile.sleep_quality">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">Sleep Quality</h4>
                    <p class="text-gray-700 dark:text-gray-300">
                      {{ report.analysisJson.recovery_profile.sleep_quality }}
                    </p>
                  </div>

                  <div v-if="report.analysisJson.recovery_profile.key_observations?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      Key Observations
                    </h4>
                    <div class="space-y-2">
                      <div
                        v-for="(obs, idx) in report.analysisJson.recovery_profile.key_observations"
                        :key="idx"
                        class="flex gap-3"
                      >
                        <UIcon
                          name="i-heroicons-chevron-right"
                          class="w-5 h-5 text-primary mt-0.5 flex-shrink-0"
                        />
                        <p class="text-gray-700 dark:text-gray-300">{{ obs }}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </UCard>

              <!-- Nutrition Profile -->
              <UCard v-if="report.analysisJson.nutrition_profile" :ui="mobileListCardUi">
                <template #header>
                  <h3 class="text-xl font-semibold">
                    {{ tr('nutrition_profile', 'Nutrition Profile') }}
                  </h3>
                </template>

                <div class="space-y-4">
                  <div v-if="report.analysisJson.nutrition_profile.nutrition_pattern">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      Nutrition Pattern
                    </h4>
                    <p class="text-gray-700 dark:text-gray-300">
                      {{ report.analysisJson.nutrition_profile.nutrition_pattern }}
                    </p>
                  </div>

                  <div v-if="report.analysisJson.nutrition_profile.caloric_balance">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      Caloric Balance
                    </h4>
                    <p class="text-gray-700 dark:text-gray-300">
                      {{ report.analysisJson.nutrition_profile.caloric_balance }}
                    </p>
                  </div>

                  <div v-if="report.analysisJson.nutrition_profile.macro_distribution">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      Macro Distribution
                    </h4>
                    <p class="text-gray-700 dark:text-gray-300">
                      {{ report.analysisJson.nutrition_profile.macro_distribution }}
                    </p>
                  </div>

                  <div v-if="report.analysisJson.nutrition_profile.key_observations?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      Key Observations
                    </h4>
                    <div class="space-y-2">
                      <div
                        v-for="(obs, idx) in report.analysisJson.nutrition_profile.key_observations"
                        :key="idx"
                        class="flex gap-3"
                      >
                        <UIcon
                          name="i-heroicons-chevron-right"
                          class="w-5 h-5 text-primary mt-0.5 flex-shrink-0"
                        />
                        <p class="text-gray-700 dark:text-gray-300">{{ obs }}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </UCard>

              <!-- Recent Performance -->
              <UCard v-if="report.analysisJson.recent_performance" :ui="mobileListCardUi">
                <template #header>
                  <div class="flex items-center justify-between">
                    <h3 class="text-xl font-semibold">
                      {{ tr('recent_performance', 'Recent Performance') }}
                    </h3>
                    <UBadge
                      :color="
                        getTrendBadgeColor(report.analysisJson.recent_performance.trend) as any
                      "
                      size="lg"
                    >
                      {{ report.analysisJson.recent_performance.trend }}
                    </UBadge>
                  </div>
                </template>

                <div class="space-y-4">
                  <div v-if="report.analysisJson.recent_performance.patterns?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">Patterns</h4>
                    <div class="space-y-2">
                      <div
                        v-for="(pattern, idx) in report.analysisJson.recent_performance.patterns"
                        :key="idx"
                        class="flex gap-3"
                      >
                        <UIcon
                          name="i-heroicons-chevron-right"
                          class="w-5 h-5 text-primary mt-0.5 flex-shrink-0"
                        />
                        <p class="text-gray-700 dark:text-gray-300">{{ pattern }}</p>
                      </div>
                    </div>
                  </div>

                  <div v-if="report.analysisJson.recent_performance.notable_workouts?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      Notable Workouts
                    </h4>
                    <div class="space-y-3">
                      <div
                        v-for="(workout, idx) in report.analysisJson.recent_performance
                          .notable_workouts"
                        :key="idx"
                        class="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                      >
                        <div class="flex items-center justify-between mb-1">
                          <span class="font-medium text-gray-900 dark:text-white">{{
                            workout.title
                          }}</span>
                          <span class="text-sm text-gray-600 dark:text-gray-400">{{
                            formatWorkoutDateTime(workout.date)
                          }}</span>
                        </div>
                        <p class="text-sm text-gray-700 dark:text-gray-300">
                          {{ workout.key_insight }}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </UCard>

              <!-- Planning Context -->
              <UCard v-if="report.analysisJson.planning_context" :ui="mobileListCardUi">
                <template #header>
                  <h3 class="text-xl font-semibold">
                    {{ tr('planning_context', 'Planning Context') }}
                  </h3>
                </template>

                <div class="space-y-4">
                  <div v-if="report.analysisJson.planning_context.current_focus">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">Current Focus</h4>
                    <p class="text-gray-700 dark:text-gray-300">
                      {{ report.analysisJson.planning_context.current_focus }}
                    </p>
                  </div>

                  <div v-if="report.analysisJson.planning_context.limitations?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">Limitations</h4>
                    <div class="space-y-2">
                      <div
                        v-for="(limitation, idx) in report.analysisJson.planning_context
                          .limitations"
                        :key="idx"
                        class="flex gap-3"
                      >
                        <UIcon
                          name="i-heroicons-exclamation-triangle"
                          class="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0"
                        />
                        <p class="text-gray-700 dark:text-gray-300">{{ limitation }}</p>
                      </div>
                    </div>
                  </div>

                  <div v-if="report.analysisJson.planning_context.opportunities?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">Opportunities</h4>
                    <div class="space-y-2">
                      <div
                        v-for="(opp, idx) in report.analysisJson.planning_context.opportunities"
                        :key="idx"
                        class="flex gap-3"
                      >
                        <UIcon
                          name="i-heroicons-light-bulb"
                          class="w-5 h-5 text-green-500 mt-0.5 flex-shrink-0"
                        />
                        <p class="text-gray-700 dark:text-gray-300">{{ opp }}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </UCard>

              <!-- Recommendations Summary (for athlete profile) -->
              <UCard v-if="report.analysisJson.recommendations_summary" :ui="mobileListCardUi">
                <template #header>
                  <h3 class="text-xl font-semibold flex items-center gap-2">
                    <UIcon name="i-heroicons-light-bulb" class="w-6 h-6" />
                    {{ tr('recommendations_summary', 'Recommendations Summary') }}
                  </h3>
                </template>

                <div class="space-y-4">
                  <div v-if="report.analysisJson.recommendations_summary.action_items?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-3">Action Items</h4>
                    <div class="space-y-3">
                      <div
                        v-for="(item, idx) in report.analysisJson.recommendations_summary
                          .action_items"
                        :key="idx"
                        class="border-l-4 pl-4"
                        :class="getPriorityBorderClass(item.priority)"
                      >
                        <div class="flex items-start justify-between gap-4 mb-1">
                          <p class="text-gray-900 dark:text-white">{{ item.action }}</p>
                          <UBadge :color="getPriorityBadgeColor(item.priority) as any">
                            {{ item.priority }}
                          </UBadge>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div v-if="report.analysisJson.recommendations_summary.recurring_themes?.length">
                    <h4 class="font-semibold text-gray-900 dark:text-white mb-2">
                      Recurring Themes
                    </h4>
                    <div class="space-y-2">
                      <div
                        v-for="(theme, idx) in report.analysisJson.recommendations_summary
                          .recurring_themes"
                        :key="idx"
                        class="flex gap-3"
                      >
                        <UIcon
                          name="i-heroicons-chevron-right"
                          class="w-5 h-5 text-primary mt-0.5 flex-shrink-0"
                        />
                        <p class="text-gray-700 dark:text-gray-300">{{ theme }}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </UCard>
            </template>

            <!-- Standard Report Sections (for non-athlete-profile reports) -->
            <template v-else>
              <UCard
                v-for="section in report.analysisJson.sections"
                :key="section.title"
                :ui="mobileListCardUi"
              >
                <template #header>
                  <div class="flex items-center justify-between">
                    <h3 class="text-xl font-semibold">{{ section.title }}</h3>
                    <UBadge
                      color="neutral"
                      :class="getStatusBadgeClass(section.status)"
                      variant="subtle"
                      size="lg"
                    >
                      {{ section.status_label }}
                    </UBadge>
                  </div>
                </template>

                <div class="space-y-3">
                  <div
                    v-for="(point, idx) in section.analysis_points"
                    :key="idx"
                    class="flex gap-3"
                  >
                    <UIcon
                      name="i-heroicons-chevron-right"
                      class="w-5 h-5 text-primary mt-0.5 flex-shrink-0"
                    />
                    <p class="text-gray-700 dark:text-gray-300">{{ point }}</p>
                  </div>
                </div>
              </UCard>
            </template>

            <!-- Recommendations -->
            <UCard v-if="report.analysisJson.recommendations?.length" :ui="mobileListCardUi">
              <template #header>
                <h3 class="text-xl font-semibold flex items-center gap-2">
                  <UIcon name="i-heroicons-light-bulb" class="w-6 h-6" />
                  {{ tr('recommendations', 'Recommendations') }}
                </h3>
              </template>

              <div class="space-y-4">
                <div
                  v-for="rec in report.analysisJson.recommendations"
                  :key="rec.title"
                  class="border-l-4 pl-4"
                  :class="getPriorityBorderClass(rec.priority)"
                >
                  <div class="flex items-start justify-between gap-4 mb-2">
                    <h4 class="font-semibold text-lg">{{ rec.title }}</h4>
                    <UBadge :color="getPriorityBadgeColor(rec.priority) as any">
                      {{ rec.priority }} priority
                    </UBadge>
                  </div>
                  <p class="text-gray-700 dark:text-gray-300">{{ rec.description }}</p>
                </div>
              </div>
            </UCard>

            <!-- Metrics Summary -->
            <UCard v-if="report.analysisJson.metrics_summary" :ui="mobileListCardUi">
              <template #header>
                <h3 class="text-xl font-semibold">
                  {{ tr('metrics_summary', 'Metrics Summary') }}
                </h3>
              </template>

              <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div
                  v-if="report.analysisJson.metrics_summary.total_duration_minutes"
                  class="text-center p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div class="text-2xl font-bold text-primary">
                    {{ Math.round(report.analysisJson.metrics_summary.total_duration_minutes) }}
                  </div>
                  <div class="text-sm text-gray-600 dark:text-gray-400 mt-1">Minutes</div>
                </div>

                <div
                  v-if="report.analysisJson.metrics_summary.total_tss"
                  class="text-center p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div class="text-2xl font-bold text-primary">
                    {{ Math.round(report.analysisJson.metrics_summary.total_tss) }}
                  </div>
                  <div class="text-sm text-gray-600 dark:text-gray-400 mt-1">Total TSS</div>
                </div>

                <div
                  v-if="report.analysisJson.metrics_summary.avg_power"
                  class="text-center p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div class="text-2xl font-bold text-primary">
                    {{ Math.round(report.analysisJson.metrics_summary.avg_power) }}W
                  </div>
                  <div class="text-sm text-gray-600 dark:text-gray-400 mt-1">Avg Power</div>
                </div>

                <div
                  v-if="report.analysisJson.metrics_summary.avg_heart_rate"
                  class="text-center p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div class="text-2xl font-bold text-primary">
                    {{ Math.round(report.analysisJson.metrics_summary.avg_heart_rate) }}
                  </div>
                  <div class="text-sm text-gray-600 dark:text-gray-400 mt-1">Avg HR</div>
                </div>

                <div
                  v-if="report.analysisJson.metrics_summary.total_distance_km"
                  class="text-center p-4 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div class="text-2xl font-bold text-primary">
                    {{
                      formatDistance(report.analysisJson.metrics_summary.total_distance_km * 1000)
                    }}
                  </div>
                  <div class="text-sm text-gray-600 dark:text-gray-400 mt-1">Distance</div>
                </div>
              </div>
            </UCard>
          </div>

          <!-- Content - Markdown Fallback -->
          <UCard
            v-else-if="report.status === 'COMPLETED' && report.markdown"
            class="prose prose-lg max-w-none"
            :ui="mobileListCardUi"
          >
            <MDC :value="report.markdown" :components="{}" />
          </UCard>

          <!-- Nutrition Analyzed -->
          <UCard
            v-if="report.nutrition && report.nutrition.length > 0"
            class="mt-6"
            :ui="mobileListCardUi"
          >
            <template #header>
              <h3 class="text-xl font-semibold flex items-center gap-2">
                <UIcon name="i-heroicons-cake" class="w-6 h-6" />
                {{
                  tr('nutrition_days_analyzed', 'Nutrition Days Analyzed ({count})', {
                    count: report.nutrition.length
                  })
                }}
              </h3>
            </template>

            <div class="space-y-3">
              <div
                v-for="rn in report.nutrition"
                :key="rn.id"
                class="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                @click="
                  () => {
                    void navigateTo(`/nutrition/${rn.nutrition.id}`)
                  }
                "
              >
                <div class="flex-1">
                  <div class="flex items-center gap-3 mb-2">
                    <span
                      class="px-2 py-1 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 text-xs font-medium rounded"
                    >
                      Nutrition
                    </span>
                    <span class="text-sm text-gray-600 dark:text-gray-400">
                      {{ formatDate(rn.nutrition.date) }}
                    </span>
                  </div>
                  <div
                    class="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400"
                  >
                    <span v-if="rn.nutrition.calories">
                      {{ rn.nutrition.calories }} cal
                      <span v-if="rn.nutrition.caloriesGoal" class="text-xs">
                        ({{
                          Math.round((rn.nutrition.calories / rn.nutrition.caloriesGoal) * 100)
                        }}%)
                      </span>
                    </span>
                    <span v-if="rn.nutrition.protein">
                      {{ rn.nutrition.protein }}g protein
                      <span v-if="rn.nutrition.proteinGoal" class="text-xs">
                        ({{ Math.round((rn.nutrition.protein / rn.nutrition.proteinGoal) * 100) }}%)
                      </span>
                    </span>
                    <span v-if="rn.nutrition.carbs"> {{ rn.nutrition.carbs }}g carbs </span>
                    <span v-if="rn.nutrition.fat"> {{ rn.nutrition.fat }}g fat </span>
                  </div>
                </div>
                <UIcon name="i-heroicons-chevron-right" class="w-5 h-5 text-gray-400" />
              </div>
            </div>
          </UCard>

          <!-- Workouts Analyzed -->
          <UCard
            v-if="report.workouts && report.workouts.length > 0"
            class="mt-6"
            :ui="mobileListCardUi"
          >
            <template #header>
              <h3 class="text-xl font-semibold flex items-center gap-2">
                <UIcon name="i-heroicons-list-bullet" class="w-6 h-6" />
                {{
                  tr('workouts_analyzed', 'Workouts Analyzed ({count})', {
                    count: report.workouts.length
                  })
                }}
              </h3>
            </template>

            <div class="space-y-3">
              <div
                v-for="rw in report.workouts"
                :key="rw.id"
                class="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                @click="
                  () => {
                    void navigateTo(`/workouts/${rw.workout.id}`)
                  }
                "
              >
                <div class="flex-1">
                  <div class="flex items-center gap-3 mb-2">
                    <span class="px-2 py-1 bg-primary/10 text-primary text-xs font-medium rounded">
                      {{ rw.workout.type }}
                    </span>
                    <span class="text-sm text-gray-600 dark:text-gray-400">
                      {{ formatWorkoutDateTime(rw.workout.date) }}
                    </span>
                  </div>
                  <h4 class="font-medium text-gray-900 dark:text-white">{{ rw.workout.title }}</h4>
                  <div class="flex gap-4 mt-2 text-sm text-gray-600 dark:text-gray-400">
                    <span v-if="rw.workout.durationSec">
                      {{ Math.round(rw.workout.durationSec / 60) }} min
                    </span>
                    <span v-if="rw.workout.averageWatts"> {{ rw.workout.averageWatts }}W avg </span>
                    <span v-if="rw.workout.tss"> {{ Math.round(rw.workout.tss) }} TSS </span>
                    <span v-if="rw.workout.distanceMeters">
                      {{ formatDistance(rw.workout.distanceMeters) }}
                    </span>
                  </div>
                </div>
                <UIcon name="i-heroicons-chevron-right" class="w-5 h-5 text-gray-400" />
              </div>
            </div>
          </UCard>

          <!-- Suggestions (for daily coach) -->
          <UCard v-if="report.suggestions" class="mt-6" :ui="mobileListCardUi">
            <template #header>
              <h3 class="text-xl font-semibold flex items-center gap-2">
                <UIcon name="i-heroicons-light-bulb" class="w-6 h-6" />
                {{ tr('coaching_suggestion', "Today's Coaching Suggestion") }}
              </h3>
            </template>

            <div class="space-y-4">
              <div>
                <p class="text-lg font-semibold mb-2">
                  {{ getActionText(report.suggestions.action) }}
                </p>
                <p class="text-gray-700 dark:text-gray-300">{{ report.suggestions.reason }}</p>
              </div>

              <div
                v-if="report.suggestions.modification"
                class="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg"
              >
                <p class="text-sm font-medium text-blue-900 dark:text-blue-200 mb-1">
                  Recommended Modification:
                </p>
                <p class="text-blue-800 dark:text-blue-300">
                  {{ report.suggestions.modification }}
                </p>
              </div>

              <div
                class="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400"
              >
                <span>Confidence: {{ (report.suggestions.confidence * 100).toFixed(0) }}%</span>
                <span>Model: {{ report.modelVersion }}</span>
              </div>
            </div>
          </UCard>

          <!-- Actions -->
          <div class="mt-6 flex justify-between items-center">
            <div class="flex gap-4">
              <UButton
                color="neutral"
                variant="outline"
                @click="
                  () => {
                    void handlePrint()
                  }
                "
              >
                <UIcon name="i-heroicons-printer" class="w-4 h-4 mr-2" />
                {{ tr('print_pdf', 'Print / Save as PDF') }}
              </UButton>

              <UButton
                v-if="report.status === 'COMPLETED'"
                color="neutral"
                variant="outline"
                disabled
              >
                <UIcon name="i-heroicons-share" class="w-4 h-4 mr-2" />
                {{ tr('share_coming_soon', 'Share (Coming Soon)') }}
              </UButton>
            </div>

            <AiFeedback
              v-if="report.llmUsageId"
              :llm-usage-id="report.llmUsageId"
              :initial-feedback="report.feedback"
              :initial-feedback-text="report.feedbackText"
            />
          </div>
        </div>

        <div v-else class="text-center py-20">
          <p class="text-gray-600 dark:text-gray-400">{{ tr('not_found', 'Report not found') }}</p>
          <UButton to="/reports" class="mt-4">{{
            tr('back_to_reports', 'Back to Reports')
          }}</UButton>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
  import { formatDistance as formatDist } from '~/utils/metrics'
  import { mobileListCardUi } from '~/utils/mobile-surface-ui'
  import { getAnalysisStatusClass } from '~/utils/analysis-status'

  const route = useRoute()
  const { formatDate: baseFormatDate, formatDateTime, formatShortDate } = useFormat()
  const userStore = useUserStore()
  const { tr } = useReportI18n()
  const reportId = route.params.id as string

  function formatDistance(meters: number): string {
    return formatDist(meters, userStore.profile?.distanceUnits || 'Kilometers')
  }

  function formatWorkoutDateTime(date: string | Date) {
    return formatDateTime(date, 'MMM d, yyyy h:mm a')
  }

  interface Report {
    id: string
    type: string
    status: string
    dateRangeStart: string
    dateRangeEnd: string
    analysisJson?: any
    markdown?: string
    nutrition?: any[]
    workouts?: any[]
    suggestions?: any
    modelVersion?: string
    llmUsageId?: string
    feedback?: string
    feedbackText?: string
  }

  const {
    data: report,
    pending,
    refresh: refreshReport
  } = (await useAsyncData<Report>(`report-${reportId}`, () =>
    ($fetch as any)(`/api/reports/${reportId}`)
  )) as any

  // Poll for updates if report is processing or pending
  let pollInterval: NodeJS.Timeout | null = null

  onMounted(() => {
    if (report.value?.status === 'PROCESSING' || report.value?.status === 'PENDING') {
      pollInterval = setInterval(async () => {
        await refreshReport()
        if (
          report.value &&
          report.value.status !== 'PROCESSING' &&
          report.value.status !== 'PENDING'
        ) {
          if (pollInterval) {
            clearInterval(pollInterval)
            pollInterval = null
          }
        }
      }, 3000) // Poll every 3 seconds
    }
  })

  onUnmounted(() => {
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
  })

  definePageMeta({
    middleware: 'auth'
  })

  const reportTitle = computed(() => {
    if (!report.value) return ''
    const titles: Record<string, string> = {
      WEEKLY_ANALYSIS: tr('type_weekly_analysis', 'Weekly Training Analysis'),
      LAST_3_WORKOUTS: tr('type_last_3_workouts', 'Last 3 Workouts Analysis'),
      LAST_3_NUTRITION: tr('type_last_3_nutrition', 'Last 3 Days Nutrition Analysis'),
      LAST_7_NUTRITION: tr('type_last_7_nutrition', 'Weekly Nutrition Analysis'),
      RACE_PREP: tr('type_race_prep', 'Race Preparation Report'),
      DAILY_SUGGESTION: tr('type_daily_suggestion', 'Daily Coaching Brief'),
      CUSTOM: tr('type_custom', 'Custom Report')
    }
    return titles[report.value.type] || tr('default_title', 'Report')
  })

  /**
   * The report's own lifecycle state (PENDING/PROCESSING/COMPLETED/FAILED).
   *
   * CW-442: this used to be a solid `UBadge` -- white on the base 500 token, which
   * measured 2.38:1 in light mode for the green COMPLETED case, below AA at any size.
   * It is now a tinted chip with an explicit light/dark text pair, the same mechanism
   * CW-424 used for the section grades (`getStatusBadgeClass` below). Nuxt UI's
   * `subtle` variant is *not* used: it resolves the label to the base 500 token in both
   * themes and only flips the backdrop, which is why it measured worse than the solid
   * badges it replaced when CW-424 tried it.
   *
   * COMPLETED deliberately leaves the severity ramp for neutral zinc. The analysis
   * grades only render once the report is COMPLETED, so COMPLETED is the one lifecycle
   * state that ever shares the page with them -- a green pill there competed with the
   * green `excellent`/`good` grades and read as a severity judgement about the report.
   * The states that never coexist with a grade keep their colour, because there the
   * colour is the whole signal.
   */
  const LIFECYCLE_CHIP_CLASSES: Readonly<Record<string, string>> = Object.freeze({
    PENDING: 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300',
    PROCESSING: 'bg-blue-50 text-blue-800 dark:bg-blue-400/10 dark:text-blue-300',
    COMPLETED: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-400/10 dark:text-zinc-300',
    FAILED: 'bg-red-50 text-red-800 dark:bg-red-400/10 dark:text-red-300'
  })

  const LIFECYCLE_CHIP_FALLBACK_CLASS =
    'bg-zinc-100 text-zinc-700 dark:bg-zinc-400/10 dark:text-zinc-300'

  const LIFECYCLE_ICONS: Readonly<Record<string, string>> = Object.freeze({
    PENDING: 'i-heroicons-clock',
    PROCESSING: 'i-heroicons-arrow-path',
    COMPLETED: 'i-heroicons-check-circle',
    FAILED: 'i-heroicons-exclamation-triangle'
  })

  const statusChipClass = computed(
    () => LIFECYCLE_CHIP_CLASSES[report.value?.status ?? ''] ?? LIFECYCLE_CHIP_FALLBACK_CLASS
  )

  const statusIcon = computed(
    () => LIFECYCLE_ICONS[report.value?.status ?? ''] ?? 'i-heroicons-document-text'
  )

  const statusLabel = computed(() => {
    const status = report.value?.status
    if (!status) return ''
    const labels: Record<string, string> = {
      PENDING: tr('lifecycle_pending', 'Pending'),
      PROCESSING: tr('lifecycle_processing', 'Processing'),
      COMPLETED: tr('lifecycle_completed', 'Completed'),
      FAILED: tr('lifecycle_failed', 'Failed')
    }
    return labels[status] ?? status
  })

  const getStatusBadgeClass = (status?: string | null) => getAnalysisStatusClass(status)

  const getPriorityBadgeColor = (priority: string) => {
    const colors: Record<string, string> = {
      high: 'error',
      medium: 'warning',
      low: 'success'
    }
    return colors[priority] || 'neutral'
  }

  const getPriorityBorderClass = (priority: string) => {
    const classes: Record<string, string> = {
      high: 'border-red-500',
      medium: 'border-yellow-500',
      low: 'border-green-500'
    }
    return classes[priority] || 'border-gray-300'
  }
  const getTrendBadgeColor = (trend: string) => {
    const colors: Record<string, string> = {
      improving: 'success',
      stable: 'info',
      declining: 'error',
      variable: 'warning'
    }
    return colors[trend] || 'neutral'
  }

  const formatDate = (date: string) => {
    return baseFormatDate(date)
  }

  const formatDateRange = (start: string, end: string) => {
    const startDate = baseFormatDate(start, 'MMM d')
    const endDate = baseFormatDate(end)
    return `${startDate} - ${endDate}`
  }

  const getActionText = (action: string) => {
    const texts: Record<string, string> = {
      proceed: tr('action_proceed', '✅ Proceed as Planned'),
      modify: tr('action_modify', '🔄 Modify Workout'),
      reduce_intensity: tr('action_reduce_intensity', '📉 Reduce Intensity'),
      rest: tr('action_rest', '🛌 Rest Day Recommended')
    }
    return texts[action] || action
  }

  const handlePrint = () => {
    window.print()
  }

  useHead(() => {
    const title = reportTitle.value || tr('default_title', 'Report')
    return {
      title,
      meta: [
        {
          name: 'description',
          content: tr(
            'meta_description',
            'Detailed training analysis and coaching insights for {title}.',
            {
              title
            }
          )
        }
      ]
    }
  })
</script>

<style scoped>
  /* Print styles */
  @media print {
    nav,
    .actions {
      display: none;
    }
  }
</style>
