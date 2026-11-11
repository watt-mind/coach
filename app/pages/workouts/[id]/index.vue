<template>
  <UDashboardPanel id="workout-detail" :ui="{ body: 'p-0' }">
    <template #header>
      <UDashboardNavbar :title="workout ? `Workout: ${workout.title}` : t('details_title')">
        <template #leading>
          <UButton
            icon="i-heroicons-arrow-left"
            color="neutral"
            variant="ghost"
            class="hidden sm:flex"
            @click="
              () => {
                void goBack()
              }
            "
          >
            {{ t('back_to_data') }}
          </UButton>
          <UButton
            icon="i-heroicons-arrow-left"
            color="neutral"
            variant="ghost"
            class="sm:hidden"
            @click="
              () => {
                void goBack()
              }
            "
          />
        </template>

        <template #right>
          <div class="flex items-center gap-2">
            <div class="hidden sm:block">
              <ClientOnly>
                <DashboardTriggerMonitorButton />
              </ClientOnly>
            </div>
            <UButton
              icon="i-heroicons-adjustments-horizontal"
              color="neutral"
              variant="outline"
              size="sm"
              class="hidden sm:inline-flex"
              @click="
                () => {
                  isWorkoutSectionsModalOpen = true
                }
              "
            >
              <span>{{ t('controls_customize') }}</span>
            </UButton>
            <UButton
              icon="i-heroicons-share"
              color="neutral"
              variant="outline"
              size="sm"
              class="hidden sm:flex"
              @click="
                () => {
                  isShareModalOpen = true
                }
              "
            >
              <span>{{ t('controls_share') }}</span>
            </UButton>
            <UButton
              v-if="workout"
              :icon="
                isWorkoutInComparison(workout.id) ? 'i-lucide-check' : 'i-lucide-git-compare-arrows'
              "
              color="neutral"
              variant="outline"
              size="sm"
              class="hidden sm:inline-flex font-bold"
              @click="
                () => {
                  void toggleWorkoutComparison()
                }
              "
            >
              <span>{{
                isWorkoutInComparison(workout.id) ? 'In Comparison' : 'Add to Comparison'
              }}</span>
            </UButton>
            <UButton
              v-if="workout"
              icon="i-heroicons-bookmark"
              color="neutral"
              variant="outline"
              size="sm"
              class="hidden sm:inline-flex font-bold"
              :loading="savingToLibrary"
              @click="
                () => {
                  void saveToLibrary()
                }
              "
            >
              <span>Save to Library</span>
            </UButton>
            <UDropdownMenu
              :items="[
                [
                  {
                    label: 'Save to Library',
                    icon: 'i-heroicons-bookmark',
                    class: 'sm:hidden',
                    onSelect: () => saveToLibrary()
                  },
                  {
                    label: t('controls_customize'),
                    icon: 'i-heroicons-adjustments-horizontal',
                    class: 'sm:hidden',
                    onSelect: () => (isWorkoutSectionsModalOpen = true)
                  },
                  {
                    label:
                      workout && isWorkoutInComparison(workout.id)
                        ? 'Remove from Comparison'
                        : 'Add to Comparison',
                    icon:
                      workout && isWorkoutInComparison(workout.id)
                        ? 'i-lucide-check'
                        : 'i-lucide-git-compare-arrows',
                    onSelect: () => toggleWorkoutComparison()
                  },
                  {
                    label: t('controls_edit'),
                    icon: 'i-heroicons-pencil-square',
                    onSelect: () => (isEditModalOpen = true)
                  },
                  {
                    label: 'Debug Intervals',
                    icon: 'i-heroicons-cpu-chip',
                    onSelect: () => navigateTo(`/workouts/${route.params.id}/intervals`)
                  },
                  {
                    label: t('controls_share'),
                    icon: 'i-heroicons-share',
                    class: 'sm:hidden',
                    onSelect: () => (isShareModalOpen = true)
                  }
                ],
                [
                  {
                    label: t('controls_delete'),
                    icon: 'i-heroicons-trash',
                    color: 'error',
                    onSelect: () => (isDeleteModalOpen = true)
                  }
                ]
              ]"
            >
              <UButton
                icon="i-heroicons-ellipsis-horizontal"
                color="neutral"
                variant="outline"
                size="sm"
              />
            </UDropdownMenu>
            <UButton
              icon="i-heroicons-chat-bubble-left-right"
              color="primary"
              variant="solid"
              size="sm"
              class="font-bold"
              @click="
                () => {
                  void chatAboutWorkout()
                }
              "
            >
              <span class="hidden sm:inline">{{ t('controls_chat_about') }}</span>
              <span class="sm:hidden">{{ t('controls_chat') }}</span>
            </UButton>
          </div>
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar>
        <div
          class="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <UButton
            v-for="section in workoutNavSections"
            :key="section.key"
            variant="ghost"
            color="neutral"
            size="sm"
            class="shrink-0 whitespace-nowrap px-3 sm:px-4"
            :aria-label="section.label"
            @click="
              () => {
                void scrollToSection(section.anchorId)
              }
            "
          >
            <UIcon :name="section.icon" class="h-4 w-4 sm:mr-2" />
            <span class="hidden sm:inline">{{ section.label }}</span>
          </UButton>
        </div>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div
        class="max-w-5xl mx-auto w-full p-0 sm:p-6 pb-24 space-y-0 sm:space-y-8 overflow-x-hidden"
      >
        <!-- DESKTOP COMMAND CENTER HUD (hidden sm:block) -->
        <div v-if="workout && !loading" class="hidden sm:flex flex-col gap-6">
          <!-- TOP SECTION: TITLE, MAP & ACTIONS -->
          <div
            class="relative overflow-hidden rounded-3xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-white/5 p-8 flex flex-col gap-6 group/header shadow-sm dark:shadow-2xl"
          >
            <!-- GHOST BACKGROUND ROUTE -->
            <UiWorkoutRoutePreview
              v-if="workout.summaryPolyline"
              :polyline="workout.summaryPolyline"
              mode="background"
              class="opacity-[0.05] group-hover/header:opacity-[0.15] z-0 transition-opacity duration-700"
            />

            <!-- SCRIM -->
            <div
              class="absolute inset-0 bg-gradient-to-r from-white via-white/80 to-transparent dark:from-gray-900 dark:via-gray-900/80 dark:to-transparent z-[1] pointer-events-none"
            />

            <div class="relative z-10 flex items-start justify-between">
              <div class="flex flex-col gap-4 max-w-2xl">
                <!-- Date & Nav -->
                <div class="flex items-center gap-4">
                  <div class="flex flex-col">
                    <span
                      class="font-mono text-[10px] text-primary-500 uppercase tracking-[0.4em] font-black"
                    >
                      {{ formatDateWeekday(workout.date) }}
                    </span>
                    <span
                      class="font-mono text-xs text-zinc-500 uppercase tracking-widest font-black"
                    >
                      {{ formatDatePrimary(workout.date) }}
                    </span>
                    <span class="font-mono text-[11px] text-zinc-400 dark:text-zinc-500 font-bold">
                      {{ formatTimeOnly(workout.date) }}
                    </span>
                  </div>
                  <div class="h-8 w-px bg-gray-200 dark:bg-white/10" />
                  <div class="flex items-center gap-2">
                    <UButton
                      icon="i-heroicons-chevron-left"
                      color="neutral"
                      variant="subtle"
                      size="xs"
                      class="rounded-lg bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-200 dark:hover:bg-white/10"
                      @click="
                        () => {
                          void navigateDate(-1)
                        }
                      "
                    />
                    <UButton
                      icon="i-heroicons-chevron-right"
                      color="neutral"
                      variant="subtle"
                      size="xs"
                      class="rounded-lg bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 hover:bg-gray-200 dark:hover:bg-white/10"
                      @click="
                        () => {
                          void navigateDate(1)
                        }
                      "
                    />

                    <!-- Data Attribution (Desktop) -->
                    <div
                      class="ml-2 opacity-40 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-300 scale-90 origin-left"
                    >
                      <UiDataAttribution
                        v-if="
                          [
                            'strava',
                            'garmin',
                            'zwift',
                            'apple_health',
                            'whoop',
                            'intervals',
                            'withings',
                            'hevy',
                            'wahoo',
                            'rouvy',
                            'fit_file'
                          ].includes(workout.source)
                        "
                        :provider="workout.source"
                        :device-name="workout.deviceName"
                        :fallback-label="getWorkoutSourceLabel(workout, t)"
                        mode="minimal"
                      />
                    </div>
                  </div>
                </div>

                <!-- Title & Achievements -->
                <div class="flex flex-col gap-3">
                  <div class="flex items-center gap-6">
                    <h1
                      class="font-black uppercase tracking-tighter text-gray-900 dark:text-white leading-none drop-shadow-2xl transition-all duration-500"
                      :class="[
                        workout.title.length > 25 ? 'text-2xl lg:text-3xl' : 'text-3xl lg:text-5xl'
                      ]"
                    >
                      {{ workout.title }}
                    </h1>

                    <!-- Personal Best Badges -->
                    <div v-if="achievements.length > 0" class="flex items-center gap-2">
                      <template v-for="pb in achievements" :key="pb.type">
                        <UTooltip
                          :text="`${pb.label}: ${pb.displayValue}${pb.unit === 's' ? '' : pb.unit}`"
                        >
                          <div
                            class="flex items-center gap-1.5 bg-yellow-500/10 text-yellow-500 px-2.5 py-1 rounded-full border border-yellow-500/20 font-black text-[10px] tracking-widest uppercase animate-pulse-slow"
                          >
                            <UIcon name="i-heroicons-trophy" class="w-3 h-3" />
                            {{ pb.label }}
                          </div>
                        </UTooltip>
                      </template>
                    </div>
                  </div>

                  <!-- Meta Info & Tags Trigger -->
                  <div
                    class="flex items-center gap-4 font-mono text-[10px] text-zinc-500 uppercase tracking-[0.2em]"
                  >
                    <div class="flex items-center gap-2">
                      <UIcon
                        :name="getWorkoutIcon(workout.type)"
                        class="w-4 h-4"
                        :class="getWorkoutColorClass(workout.type)"
                      />
                      <span>{{ workout.type || 'Activity' }}</span>
                    </div>
                    <span class="opacity-30">•</span>
                    <div class="flex items-center gap-1">
                      <span class="i-heroicons-clock w-3.5 h-3.5 opacity-50" />
                      {{ formatDuration(workout.durationSec) }}
                    </div>

                    <!-- Device Name (Desktop) -->
                    <template v-if="workout.deviceName">
                      <span class="opacity-30">•</span>
                      <div class="flex items-center gap-1">
                        <UIcon name="i-heroicons-cpu-chip" class="w-3.5 h-3.5 opacity-50" />
                        <span class="truncate max-w-[150px]">{{ workout.deviceName }}</span>
                      </div>
                    </template>

                    <span class="opacity-30">•</span>
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      icon="i-heroicons-hashtag"
                      class="hover:text-primary-500 p-0 h-auto font-black"
                      @click="
                        () => {
                          showTagEditor = !showTagEditor
                        }
                      "
                    >
                      <span v-if="workout.tags?.length" class="ml-1"
                        >{{ workout.tags.length }} TAGS</span
                      >
                      <span v-else class="ml-1 text-[8px]">ADD TAGS</span>
                    </UButton>
                  </div>
                </div>
              </div>

              <!-- Action Stack -->
              <div class="flex items-center gap-4">
                <!-- Map Preview -->
                <NuxtLink
                  v-if="workout.summaryPolyline"
                  :to="`/workouts/${workout.id}/map`"
                  class="shrink-0 w-24 h-24 rounded-2xl bg-black border border-white/10 overflow-hidden relative group shadow-2xl hover:border-primary-500/50 transition-all duration-500"
                >
                  <UiWorkoutRoutePreview
                    :polyline="workout.summaryPolyline"
                    size="w-full h-full"
                    class="text-primary-500/40"
                  />
                  <div
                    class="absolute inset-0 bg-primary-500/5 group-hover:bg-primary-500/10 transition-colors"
                  />
                  <div
                    class="absolute bottom-0 left-0 right-0 py-1 bg-black/60 backdrop-blur-sm text-center"
                  >
                    <span class="text-[8px] font-black text-primary-400 uppercase tracking-widest"
                      >ANALYSIS</span
                    >
                  </div>
                </NuxtLink>

                <div class="flex flex-col gap-2">
                  <UButton
                    icon="i-heroicons-pencil-square"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    class="bg-white/5 border-white/5 hover:bg-white/10 font-bold"
                    @click="
                      () => {
                        isEditModalOpen = true
                      }
                    "
                  >
                    Edit
                  </UButton>
                  <UButton
                    icon="i-heroicons-share"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    class="bg-white/5 border-white/5 hover:bg-white/10 font-bold"
                    @click="
                      () => {
                        isShareModalOpen = true
                      }
                    "
                  >
                    Share
                  </UButton>
                  <UButton
                    icon="i-heroicons-trash"
                    color="error"
                    variant="subtle"
                    size="sm"
                    class="bg-red-500/5 border-red-500/10 hover:bg-red-500/10 font-bold"
                    @click="
                      () => {
                        isDeleteModalOpen = true
                      }
                    "
                  >
                    Delete
                  </UButton>
                </div>
              </div>
            </div>

            <!-- Tag Editor Panel (Desktop) -->
            <div
              v-if="showTagEditor"
              class="relative z-10 p-6 bg-white/[0.02] border border-white/5 rounded-2xl"
            >
              <div class="flex flex-col gap-4">
                <div class="flex items-start justify-between gap-6">
                  <div class="flex-1">
                    <div
                      class="text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-3"
                    >
                      Workout tags (Local)
                    </div>
                    <UInputTags
                      v-model="localTagDraft"
                      placeholder="Add local tags..."
                      color="neutral"
                      variant="outline"
                      size="md"
                    />
                  </div>
                  <div class="flex items-center gap-2 mt-7">
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      :disabled="!hasLocalTagChanges || savingTags"
                      @click="
                        () => {
                          void resetLocalTags()
                        }
                      "
                      >Reset</UButton
                    >
                    <UButton
                      color="primary"
                      variant="solid"
                      size="sm"
                      icon="i-heroicons-tag"
                      :loading="savingTags"
                      :disabled="!hasLocalTagChanges"
                      @click="
                        () => {
                          void saveLocalTags()
                        }
                      "
                      >Save</UButton
                    >
                  </div>
                </div>
                <div
                  v-if="intervalsSourceTags.length > 0"
                  class="flex flex-wrap items-center gap-2 pt-2 border-t border-white/5"
                >
                  <span class="text-[9px] font-black uppercase tracking-widest text-zinc-600"
                    >Intervals Sync:</span
                  >
                  <UBadge
                    v-for="tag in intervalsSourceTags"
                    :key="tag"
                    color="neutral"
                    variant="subtle"
                    size="xs"
                    class="font-black tracking-tight lowercase"
                    >#{{ tag }}</UBadge
                  >
                </div>
              </div>
            </div>

            <!-- Description (Desktop) -->
            <div
              v-if="workout.description"
              class="relative z-10 p-6 bg-white/[0.01] border-l-2 border-primary-500/20 rounded-r-2xl italic text-zinc-400 font-medium leading-relaxed whitespace-pre-wrap"
            >
              {{ workout.description }}
            </div>
          </div>

          <!-- HERO HUD ROW: UNIFIED COMMAND CENTER -->
          <div
            class="relative overflow-hidden rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-white/5 p-1 flex items-stretch group/hero shadow-lg dark:shadow-2xl"
          >
            <div
              class="absolute inset-0 ring-1 ring-inset ring-primary-500/10 opacity-0 group-hover/hero:opacity-100 transition-opacity duration-500 pointer-events-none"
            />

            <!-- Primary Group: Distance, Time, TSS -->
            <div class="flex flex-1 items-center justify-around py-6 px-4">
              <div v-if="workout.distanceMeters" class="flex-1 flex flex-col items-center gap-1">
                <span
                  class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-[0.3em]"
                  >Distance</span
                >
                <div class="flex items-baseline gap-1.5">
                  <span
                    class="text-4xl font-black text-black dark:text-white tracking-tighter drop-shadow-md"
                  >
                    {{ (workout.distanceMeters / 1000).toFixed(1) }}
                  </span>
                  <span
                    class="text-xs font-bold text-zinc-400 dark:text-zinc-600 uppercase opacity-50"
                    >km</span
                  >
                </div>
              </div>
              <div class="w-px h-12 bg-gray-100 dark:bg-white/5" />
              <div class="flex flex-col items-center gap-1">
                <span
                  class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-[0.3em]"
                  >Time</span
                >
                <span
                  class="text-4xl font-black text-black dark:text-white tracking-tighter drop-shadow-md"
                >
                  {{ formatDurationShort(workout.durationSec) }}
                </span>
              </div>
              <div class="w-px h-12 bg-gray-100 dark:bg-white/5" />
              <div
                v-if="workout.tss || workout.trainingLoad"
                class="flex flex-col items-center gap-1"
              >
                <span
                  class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-[0.3em]"
                  >TSS/Load</span
                >
                <span
                  class="text-4xl font-black tabular-nums tracking-tighter drop-shadow-md animate-pulse-slow"
                  :class="getIntensityColorClass(workout.intensity, 'text')"
                >
                  {{ Math.round(workout.tss || workout.trainingLoad) }}
                </span>
              </div>
            </div>

            <!-- SECONDARY GROUP DIVIDER -->
            <div class="w-px bg-gray-100 dark:bg-white/10 my-4" />

            <!-- Secondary Group: Power, HR, Gain -->
            <div
              class="flex flex-1 items-center justify-around py-6 px-4 bg-gray-50/50 dark:bg-white/[0.01]"
            >
              <div v-if="workout.averageWatts" class="flex flex-col items-center gap-1">
                <span
                  class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-[0.3em]"
                  >Power</span
                >
                <div class="flex items-baseline gap-1">
                  <span
                    class="text-2xl font-black text-purple-600 dark:text-purple-400 tabular-nums"
                    >{{ workout.averageWatts }}</span
                  >
                  <span
                    class="text-[10px] font-bold text-zinc-400 dark:text-zinc-600 uppercase opacity-50"
                    >W</span
                  >
                </div>
              </div>
              <div v-if="workout.normalizedPower" class="flex flex-col items-center gap-1">
                <span
                  class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-[0.3em]"
                  >NP</span
                >
                <div class="flex items-baseline gap-1">
                  <span
                    class="text-2xl font-black text-indigo-600 dark:text-indigo-400 tabular-nums"
                    >{{ workout.normalizedPower }}</span
                  >
                  <span
                    class="text-[10px] font-bold text-zinc-400 dark:text-zinc-600 uppercase opacity-50"
                    >W</span
                  >
                </div>
              </div>
              <div v-if="workout.averageHr" class="flex flex-col items-center gap-1">
                <span
                  class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-[0.3em]"
                  >Heart</span
                >
                <div class="flex items-baseline gap-1">
                  <span class="text-2xl font-black text-pink-600 dark:text-pink-400 tabular-nums">{{
                    workout.averageHr
                  }}</span>
                  <span
                    class="text-[10px] font-bold text-zinc-400 dark:text-zinc-600 uppercase opacity-50"
                    >BPM</span
                  >
                </div>
              </div>
              <div v-if="workout.elevationGain" class="flex flex-col items-center gap-1">
                <span
                  class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-[0.3em]"
                  >Gain</span
                >
                <div class="flex items-baseline gap-1">
                  <span class="text-2xl font-black text-black dark:text-white">{{
                    Math.round(
                      convertElevation(
                        workout.elevationGain,
                        userStore.profile?.distanceUnits || 'Kilometers'
                      )
                    )
                  }}</span>
                  <span
                    class="text-[10px] font-bold text-zinc-400 dark:text-zinc-600 uppercase opacity-50"
                    >{{
                      getElevationUnitLabel(userStore.profile?.distanceUnits || 'Kilometers')
                    }}</span
                  >
                </div>
              </div>
            </div>
          </div>

          <!-- PERFORMANCE & IMPACT SIDE-BY-SIDE -->
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
            <!-- Performance Summary -->
            <div
              class="bg-zinc-50 dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-white/5 p-6 flex flex-col shadow-lg dark:shadow-xl"
            >
              <h2
                class="mb-6 flex items-center gap-2 font-mono text-[10px] font-black uppercase tracking-[0.3em] text-zinc-600 dark:text-zinc-500"
              >
                <UIcon name="i-heroicons-chart-bar" class="w-4 h-4 text-primary-500" />
                Performance Metrics
              </h2>

              <div class="flex-1 min-h-[220px]">
                <PerformanceScoreChart
                  v-if="workout.overallScore || workout.technicalScore"
                  :scores="{
                    overall: workout.overallScore,
                    technical: workout.technicalScore,
                    effort: workout.effortScore,
                    pacing: workout.pacingScore,
                    execution: workout.executionScore
                  }"
                />
                <div
                  v-else
                  class="h-full flex flex-col items-center justify-center text-center opacity-40"
                >
                  <UIcon name="i-heroicons-sparkles" class="w-8 h-8 mb-2" />
                  <span class="text-[10px] font-black uppercase tracking-widest"
                    >No Score Data</span
                  >
                </div>
              </div>
            </div>

            <!-- System Impact Grid (Condensed 2x2) -->
            <div
              class="bg-zinc-50 dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-white/5 p-6 flex flex-col shadow-lg dark:shadow-xl"
            >
              <h2
                class="mb-6 flex items-center gap-2 font-mono text-[10px] font-black uppercase tracking-[0.3em] text-zinc-600 dark:text-zinc-500"
              >
                <UIcon name="i-heroicons-heart" class="w-4 h-4 text-orange-500" />
                {{ t('impact_calc_title') }}
              </h2>

              <div class="grid grid-cols-2 gap-4 flex-1">
                <!-- CTL -->
                <div
                  class="p-4 rounded-xl border border-[#00DC82]/10 bg-[#00DC82]/[0.02] flex flex-col justify-between cursor-pointer hover:bg-[#00DC82]/[0.05] transition-all group"
                  @click="
                    () => {
                      handleOpenMetric({
                        key: 'Fitness (CTL)',
                        value: workout.ctl ? Math.round(workout.ctl) : 0
                      })
                    }
                  "
                >
                  <div class="flex items-center gap-2 opacity-60">
                    <UIcon name="i-heroicons-heart" class="w-3 h-3 text-[#00DC82]" />
                    <UTooltip
                      :popper="{ placement: 'top' }"
                      :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                      arrow
                    >
                      <span
                        class="font-mono text-[8px] font-black uppercase tracking-widest border-b border-dashed border-zinc-700"
                        >Fitness (CTL)</span
                      >
                      <template #content>
                        <div class="text-left text-sm">{{ tt('fitness_ctl') }}</div>
                      </template>
                    </UTooltip>
                  </div>
                  <span class="text-3xl font-black text-black dark:text-white">{{
                    workout.ctl ? Math.round(workout.ctl) : '-'
                  }}</span>
                </div>
                <!-- ATL -->
                <div
                  class="p-4 rounded-xl border border-orange-500/10 bg-orange-500/[0.02] flex flex-col justify-between cursor-pointer hover:bg-orange-500/[0.05] transition-all group"
                  @click="
                    () => {
                      handleOpenMetric({
                        key: 'Fatigue (ATL)',
                        value: workout.atl ? Math.round(workout.atl) : 0
                      })
                    }
                  "
                >
                  <div class="flex items-center gap-2 opacity-60">
                    <UIcon name="i-heroicons-fire" class="w-3 h-3 text-orange-500" />
                    <UTooltip
                      :popper="{ placement: 'top' }"
                      :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                      arrow
                    >
                      <span
                        class="font-mono text-[8px] font-black uppercase tracking-widest border-b border-dashed border-zinc-700"
                        >Fatigue (ATL)</span
                      >
                      <template #content>
                        <div class="text-left text-sm">{{ tt('fatigue_atl') }}</div>
                      </template>
                    </UTooltip>
                  </div>
                  <span class="text-3xl font-black text-black dark:text-white">{{
                    workout.atl ? Math.round(workout.atl) : '-'
                  }}</span>
                </div>
                <!-- TSS -->
                <div
                  class="p-4 rounded-xl border border-[#00DC82]/10 bg-[#00DC82]/[0.02] flex flex-col justify-between cursor-pointer hover:bg-[#00DC82]/[0.05] transition-all group"
                  @click="
                    () => {
                      handleOpenMetric({
                        key: 'TSS (Load)',
                        value: Math.round(workout.tss || workout.trainingLoad || 0)
                      })
                    }
                  "
                >
                  <div class="flex items-center gap-2 opacity-60">
                    <UIcon name="i-heroicons-bolt" class="w-3 h-3 text-[#00DC82]" />
                    <UTooltip
                      :popper="{ placement: 'top' }"
                      :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                      arrow
                    >
                      <span
                        class="font-mono text-[8px] font-black uppercase tracking-widest border-b border-dashed border-zinc-700"
                        >Load (TSS)</span
                      >
                      <template #content>
                        <div class="text-left text-sm">{{ tt('tss_load') }}</div>
                      </template>
                    </UTooltip>
                  </div>
                  <span class="text-3xl font-black text-black dark:text-white">{{
                    Math.round(workout.tss || workout.trainingLoad || 0)
                  }}</span>
                </div>
                <!-- TSB -->
                <div
                  class="p-4 rounded-xl border border-blue-500/10 bg-blue-500/[0.02] flex flex-col justify-between cursor-pointer hover:bg-blue-500/[0.05] transition-all group"
                  @click="
                    () => {
                      handleOpenMetric({ key: 'Form (TSB)', value: calculateForm(workout) || 0 })
                    }
                  "
                >
                  <div class="flex items-center gap-2 opacity-60">
                    <UIcon name="i-heroicons-scale" class="w-3 h-3 text-blue-500" />
                    <UTooltip
                      :popper="{ placement: 'top' }"
                      :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                      arrow
                    >
                      <span
                        class="font-mono text-[8px] font-black uppercase tracking-widest border-b border-dashed border-zinc-700"
                        >Form (TSB)</span
                      >
                      <template #content>
                        <div class="text-left text-sm">{{ tt('form_tsb') }}</div>
                      </template>
                    </UTooltip>
                  </div>
                  <span class="text-3xl font-black text-blue-400 tabular-nums">
                    {{
                      calculateForm(workout) !== null
                        ? (calculateForm(workout)! > 0 ? '+' : '') + calculateForm(workout)
                        : '-'
                    }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- MOBILE HUD HEADER (sm:hidden) -->
        <div
          v-if="workout && !loading"
          class="sm:hidden flex flex-col bg-white dark:bg-gray-900 relative overflow-hidden"
        >
          <!-- GHOST BACKGROUND ROUTE FOR HUD -->
          <UiWorkoutRoutePreview
            v-if="workout.summaryPolyline"
            :polyline="workout.summaryPolyline"
            mode="background"
            class="opacity-[0.08] z-0"
          />

          <!-- HUD CONTENT -->
          <div class="relative z-10 px-5 pt-6 pb-8 flex flex-col gap-8">
            <!-- HUD TOP: Navigation, Title & Source -->
            <div class="flex flex-col gap-4">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <UButton
                    icon="i-heroicons-chevron-left"
                    color="neutral"
                    variant="subtle"
                    size="xs"
                    class="rounded-lg bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10"
                    @click="
                      () => {
                        void navigateDate(-1)
                      }
                    "
                  />
                  <div class="flex flex-col">
                    <span
                      class="font-mono text-[8px] text-primary-500 uppercase tracking-[0.3em] font-black"
                    >
                      {{ formatDateWeekday(workout.date) }}
                    </span>
                    <span
                      class="font-mono text-[10px] text-zinc-600 dark:text-zinc-500 uppercase tracking-widest font-black"
                    >
                      {{ formatDatePrimary(workout.date) }}
                    </span>
                  </div>
                  <UButton
                    icon="i-heroicons-chevron-right"
                    color="neutral"
                    variant="subtle"
                    size="xs"
                    class="rounded-lg bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10"
                    @click="
                      () => {
                        void navigateDate(1)
                      }
                    "
                  />
                </div>

                <div class="opacity-40 grayscale scale-75 origin-right">
                  <UiDataAttribution
                    v-if="
                      [
                        'strava',
                        'garmin',
                        'zwift',
                        'apple_health',
                        'whoop',
                        'intervals',
                        'withings',
                        'hevy',
                        'wahoo',
                        'rouvy',
                        'fit_file'
                      ].includes(workout.source)
                    "
                    :provider="workout.source"
                    :device-name="workout.deviceName"
                    :fallback-label="getWorkoutSourceLabel(workout, t)"
                    mode="minimal"
                  />
                </div>
              </div>

              <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0">
                  <h1
                    class="font-black uppercase tracking-tighter text-gray-900 dark:text-white leading-tight mb-1 transition-all duration-500"
                    :class="[
                      workout.title.length > 25 ? 'text-lg sm:text-xl' : 'text-2xl sm:text-3xl'
                    ]"
                  >
                    {{ workout.title }}
                  </h1>
                  <div
                    class="flex items-center gap-2 font-mono text-[9px] text-zinc-500 uppercase tracking-widest"
                  >
                    <UIcon
                      :name="getWorkoutIcon(workout.type)"
                      class="w-3.5 h-3.5"
                      :class="getWorkoutColorClass(workout.type)"
                    />
                    <span>{{ workout.type || 'Activity' }}</span>
                    <span v-if="workout.deviceName" class="opacity-30">•</span>
                    <span v-if="workout.deviceName" class="truncate">{{ workout.deviceName }}</span>
                  </div>

                  <!-- Achievements (Mobile) -->
                  <div v-if="achievements.length > 0" class="flex flex-wrap gap-1.5 mt-2">
                    <template v-for="pb in achievements" :key="pb.type">
                      <div
                        class="flex items-center gap-1 bg-yellow-500/10 text-yellow-500 px-2 py-0.5 rounded-full border border-yellow-500/20 font-black text-[8px] tracking-widest uppercase animate-pulse-slow"
                      >
                        <UIcon name="i-heroicons-trophy" class="w-2.5 h-2.5" />
                        {{ pb.label }}
                      </div>
                    </template>
                  </div>
                </div>

                <!-- FLOATING MAP PREVIEW -->
                <NuxtLink
                  v-if="workout.summaryPolyline"
                  :to="`/workouts/${workout.id}/map`"
                  class="shrink-0 w-20 h-20 rounded-xl bg-black border border-white/10 overflow-hidden relative group shadow-2xl"
                >
                  <UiWorkoutRoutePreview
                    :polyline="workout.summaryPolyline"
                    size="w-full h-full"
                    class="text-primary-500/40"
                  />
                  <div
                    class="absolute inset-0 bg-primary-500/5 group-hover:bg-primary-500/10 transition-colors"
                  />
                  <div
                    class="absolute bottom-0 left-0 right-0 py-1 px-1 bg-black/60 backdrop-blur-sm text-center"
                  >
                    <span class="text-[7px] font-black text-primary-400 uppercase tracking-widest"
                      >MAP</span
                    >
                  </div>
                </NuxtLink>
              </div>
            </div>

            <!-- HERO DATA ROW -->
            <div class="flex items-center justify-between py-2 border-y border-white/5">
              <div v-if="workout.distanceMeters" class="flex-1 flex flex-col items-center gap-1">
                <span
                  class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em]"
                  >Distance</span
                >
                <div class="flex items-baseline gap-1">
                  <span class="text-3xl font-black text-black dark:text-white tracking-tighter">
                    {{ (workout.distanceMeters / 1000).toFixed(1) }}
                  </span>
                  <span class="text-[9px] font-bold text-zinc-600 uppercase">km</span>
                </div>
              </div>

              <div class="w-px h-10 bg-white/5" />

              <div class="flex-1 flex flex-col items-center gap-1">
                <span
                  class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em]"
                  >Time</span
                >
                <span class="text-3xl font-black text-black dark:text-white tracking-tighter">
                  {{ formatDurationShort(workout.durationSec) }}
                </span>
              </div>

              <div class="w-px h-10 bg-white/5" />

              <div
                v-if="workout.tss || workout.trainingLoad"
                class="flex-1 flex flex-col items-center gap-1"
              >
                <span
                  class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em]"
                  >TSS</span
                >
                <span
                  class="text-3xl font-black tabular-nums tracking-tighter animate-pulse-slow"
                  :class="getIntensityColorClass(workout.intensity, 'text')"
                >
                  {{ Math.round(workout.tss || workout.trainingLoad) }}
                </span>
              </div>
            </div>

            <!-- SECONDARY METRIC GRID -->
            <div class="p-5 rounded-2xl bg-white/[0.02] border border-white/5 shadow-inner">
              <div class="grid grid-cols-3 gap-x-4 gap-y-8">
                <div v-if="workout.averageWatts" class="flex flex-col items-center">
                  <span
                    class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1"
                    >Power</span
                  >
                  <div class="flex items-baseline gap-0.5">
                    <span class="text-base font-black text-purple-400 tabular-nums">{{
                      workout.averageWatts
                    }}</span>
                    <span class="text-[8px] font-bold text-zinc-600 uppercase">W</span>
                  </div>
                </div>
                <div v-if="workout.normalizedPower" class="flex flex-col items-center">
                  <span
                    class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1"
                    >NP</span
                  >
                  <div class="flex items-baseline gap-0.5">
                    <span class="text-base font-black text-indigo-400 tabular-nums">{{
                      workout.normalizedPower
                    }}</span>
                    <span class="text-[8px] font-bold text-zinc-600 uppercase">W</span>
                  </div>
                </div>
                <div v-if="workout.averageHr" class="flex flex-col items-center">
                  <span
                    class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1"
                    >Heart</span
                  >
                  <div class="flex items-baseline gap-0.5">
                    <span class="text-base font-black text-pink-400 tabular-nums">{{
                      workout.averageHr
                    }}</span>
                    <span class="text-[8px] font-bold text-zinc-600 uppercase">BPM</span>
                  </div>
                </div>
                <div v-if="workout.elevationGain" class="flex flex-col items-center">
                  <span
                    class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1"
                    >Gain</span
                  >
                  <div class="flex items-baseline gap-0.5">
                    <span class="text-base font-black text-black dark:text-white">{{
                      workout.elevationGain
                    }}</span>
                    <span class="text-[8px] font-bold text-zinc-600 uppercase">m</span>
                  </div>
                </div>
                <div v-if="workout.averageCadence" class="flex flex-col items-center">
                  <span
                    class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1"
                    >RPM</span
                  >
                  <span class="text-base font-black text-black dark:text-white">{{
                    workout.averageCadence
                  }}</span>
                </div>
                <div v-if="workout.intensity" class="flex flex-col items-center">
                  <span
                    class="font-mono text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em] mb-1"
                    >IF</span
                  >
                  <span class="text-base font-black text-zinc-300 tabular-nums">{{
                    workout.intensity.toFixed(2)
                  }}</span>
                </div>
              </div>
            </div>

            <!-- Tags (Mobile) -->
            <div class="flex flex-col gap-3">
              <UButton
                color="neutral"
                variant="subtle"
                size="sm"
                icon="i-heroicons-hashtag"
                class="bg-white/5 border-white/10 font-bold uppercase tracking-widest text-[9px] py-2"
                @click="
                  () => {
                    showTagEditor = !showTagEditor
                  }
                "
              >
                {{
                  showTagEditor
                    ? 'Close Tag Editor'
                    : workout.tags?.length
                      ? `Manage ${workout.tags.length} Tags`
                      : 'Add Tags'
                }}
              </UButton>

              <div
                v-if="showTagEditor"
                class="p-4 bg-white/[0.02] border border-white/5 rounded-xl"
              >
                <UInputTags
                  v-model="localTagDraft"
                  placeholder="Add tags..."
                  color="neutral"
                  variant="outline"
                  size="sm"
                />
                <div class="flex items-center justify-end gap-2 mt-3">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    @click="
                      () => {
                        void resetLocalTags()
                      }
                    "
                    >Reset</UButton
                  >
                  <UButton
                    color="primary"
                    variant="solid"
                    size="xs"
                    :loading="savingTags"
                    @click="
                      () => {
                        void saveLocalTags()
                      }
                    "
                    >Save</UButton
                  >
                </div>
              </div>
            </div>

            <!-- Description (Mobile) -->
            <div
              v-if="workout.description"
              class="p-4 bg-white/[0.01] border-l-2 border-primary-500/20 rounded-r-xl italic text-zinc-400 text-xs leading-relaxed whitespace-pre-wrap"
            >
              {{ workout.description }}
            </div>

            <!-- Performance Metrics Chart (Mobile) -->
            <div class="flex flex-col gap-4">
              <h2
                class="flex items-center gap-2 font-mono text-[9px] font-black uppercase tracking-[0.3em] text-zinc-600 dark:text-zinc-500"
              >
                <UIcon name="i-heroicons-chart-bar" class="w-3.5 h-3.5 text-primary-500" />
                Performance Metrics
              </h2>
              <div
                class="p-4 rounded-2xl bg-zinc-50 dark:bg-gray-900 border border-zinc-200 dark:border-white/5 min-h-[200px] shadow-sm dark:shadow-none"
              >
                <PerformanceScoreChart
                  v-if="workout.overallScore || workout.technicalScore"
                  :scores="{
                    overall: workout.overallScore,
                    technical: workout.technicalScore,
                    effort: workout.effortScore,
                    pacing: workout.pacingScore,
                    execution: workout.executionScore
                  }"
                />
                <div
                  v-else
                  class="h-full flex flex-col items-center justify-center text-center opacity-40 py-8"
                >
                  <UIcon
                    name="i-heroicons-sparkles"
                    class="w-6 h-6 mb-2 text-zinc-400 dark:text-zinc-600"
                  />
                  <span
                    class="text-[8px] font-black uppercase tracking-widest text-black dark:text-white"
                    >No Score Data</span
                  >
                </div>
              </div>
            </div>

            <!-- System Impact Grid (Mobile 2x2) -->
            <div class="flex flex-col gap-4">
              <h2
                class="flex items-center gap-2 font-mono text-[9px] font-black uppercase tracking-[0.3em] text-zinc-600 dark:text-zinc-500"
              >
                <UIcon name="i-heroicons-heart" class="w-3.5 h-3.5 text-orange-500" />
                {{ t('impact_calc_title') }}
              </h2>
              <div class="grid grid-cols-2 gap-3">
                <!-- CTL -->
                <div
                  class="p-4 rounded-xl border border-[#00DC82]/10 bg-white dark:bg-[#00DC82]/[0.02] flex flex-col justify-between cursor-pointer active:bg-zinc-100 dark:active:bg-[#00DC82]/[0.05] transition-all shadow-sm dark:shadow-none"
                  @click="
                    () => {
                      handleOpenMetric({
                        key: 'Fitness (CTL)',
                        value: workout.ctl ? Math.round(workout.ctl) : 0
                      })
                    }
                  "
                >
                  <div class="flex items-center gap-2 opacity-60 mb-2">
                    <UIcon name="i-heroicons-heart" class="w-3 h-3 text-[#00DC82]" />
                    <span
                      class="font-mono text-[8px] font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-400"
                      >Fitness</span
                    >
                  </div>
                  <span class="text-2xl font-black text-black dark:text-white tabular-nums">{{
                    workout.ctl ? Math.round(workout.ctl) : '-'
                  }}</span>
                </div>
                <!-- ATL -->
                <div
                  class="p-4 rounded-xl border border-orange-500/10 bg-white dark:bg-orange-500/[0.02] flex flex-col justify-between cursor-pointer active:bg-zinc-100 dark:active:bg-orange-500/[0.05] transition-all shadow-sm dark:shadow-none"
                  @click="
                    () => {
                      handleOpenMetric({
                        key: 'Fatigue (ATL)',
                        value: workout.atl ? Math.round(workout.atl) : 0
                      })
                    }
                  "
                >
                  <div class="flex items-center gap-2 opacity-60 mb-2">
                    <UIcon name="i-heroicons-fire" class="w-3 h-3 text-orange-500" />
                    <span
                      class="font-mono text-[8px] font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-400"
                      >Fatigue</span
                    >
                  </div>
                  <span class="text-2xl font-black text-black dark:text-white tabular-nums">{{
                    workout.atl ? Math.round(workout.atl) : '-'
                  }}</span>
                </div>
                <!-- TSS -->
                <div
                  class="p-4 rounded-xl border border-[#00DC82]/10 bg-white dark:bg-[#00DC82]/[0.02] flex flex-col justify-between cursor-pointer active:bg-zinc-100 dark:active:bg-[#00DC82]/[0.05] transition-all shadow-sm dark:shadow-none"
                  @click="
                    () => {
                      handleOpenMetric({
                        key: 'TSS (Load)',
                        value: Math.round(workout.tss || workout.trainingLoad || 0)
                      })
                    }
                  "
                >
                  <div class="flex items-center gap-2 opacity-60 mb-2">
                    <UIcon name="i-heroicons-bolt" class="w-3 h-3 text-[#00DC82]" />
                    <span
                      class="font-mono text-[8px] font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-400"
                      >Load</span
                    >
                  </div>
                  <span class="text-2xl font-black text-black dark:text-white tabular-nums">{{
                    Math.round(workout.tss || workout.trainingLoad || 0)
                  }}</span>
                </div>
                <!-- TSB -->
                <div
                  class="p-4 rounded-xl border border-blue-500/10 bg-white dark:bg-blue-500/[0.02] flex flex-col justify-between cursor-pointer active:bg-zinc-100 dark:active:bg-blue-500/[0.05] transition-all shadow-sm dark:shadow-none"
                  @click="
                    () => {
                      handleOpenMetric({ key: 'Form (TSB)', value: calculateForm(workout) || 0 })
                    }
                  "
                >
                  <div class="flex items-center gap-2 opacity-60 mb-2">
                    <UIcon name="i-heroicons-scale" class="w-3 h-3 text-blue-500" />
                    <span
                      class="font-mono text-[8px] font-black uppercase tracking-widest text-zinc-600 dark:text-zinc-400"
                      >Form</span
                    >
                  </div>
                  <span class="text-2xl font-black text-blue-600 dark:text-blue-400 tabular-nums">
                    {{
                      calculateForm(workout) !== null
                        ? (calculateForm(workout)! > 0 ? '+' : '') + calculateForm(workout)
                        : '-'
                    }}
                  </span>
                </div>
              </div>

              <!-- Explanation Accordion (Mobile) -->
              <div class="mt-2">
                <UAccordion
                  :items="[{ label: t('impact_calc_title'), slot: 'explanation' }]"
                  :ui="{
                    trigger:
                      'text-black dark:text-white font-black uppercase tracking-widest text-[9px]',
                    root: 'bg-zinc-100 dark:bg-white/5 rounded-lg border border-zinc-200 dark:border-white/5 shadow-sm'
                  }"
                  variant="ghost"
                  size="xs"
                >
                  <template #explanation>
                    <div
                      class="px-4 pb-4 text-[11px] text-zinc-600 dark:text-zinc-400 space-y-3 pt-2 font-medium"
                    >
                      <p>
                        <strong class="text-zinc-900 dark:text-zinc-200">{{
                          t('impact_source_label')
                        }}</strong>
                        <span
                          v-if="workout.source === 'intervals'"
                          class="text-zinc-600 dark:text-zinc-400"
                        >
                          {{ t('impact_source_intervals', { link: 'Intervals.icu' }) }}
                        </span>
                        <span v-else class="text-zinc-600 dark:text-zinc-400">
                          {{ t('impact_source_local') }}
                        </span>
                      </p>
                      <ul
                        class="list-disc pl-5 space-y-1.5 leading-relaxed text-zinc-600 dark:text-zinc-400"
                      >
                        <li>{{ tt('tss_load') }}</li>
                        <li>{{ tt('fitness_ctl') }}</li>
                        <li>{{ tt('fatigue_atl') }}</li>
                        <li>{{ tt('form_tsb') }}</li>
                      </ul>
                    </div>
                  </template>
                </UAccordion>
              </div>
            </div>
          </div>
        </div>

        <!-- Loading State -->
        <div v-if="loading" class="p-4 sm:p-0 space-y-6">
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class="lg:col-span-2">
              <UCard :ui="{ root: 'rounded-none sm:rounded-xl shadow-none sm:shadow' }">
                <div class="space-y-4">
                  <USkeleton class="h-8 w-3/4" />
                  <div class="flex gap-3">
                    <USkeleton class="h-4 w-24" />
                    <USkeleton class="h-4 w-24" />
                    <USkeleton class="h-4 w-24" />
                  </div>
                  <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
                    <USkeleton v-for="i in 4" :key="i" class="h-16 w-full rounded-lg" />
                  </div>
                </div>
              </UCard>
            </div>
            <div class="lg:col-span-1">
              <UCard :ui="{ root: 'rounded-none sm:rounded-xl shadow-none sm:shadow' }">
                <USkeleton class="h-4 w-32 mb-4" />
                <div class="flex justify-center items-center h-48">
                  <USkeleton class="h-32 w-32 rounded-full" />
                </div>
              </UCard>
            </div>
          </div>
        </div>

        <div v-else-if="error" class="p-4 sm:p-0 text-center py-12">
          <UAlert
            icon="i-heroicons-exclamation-triangle"
            color="error"
            variant="soft"
            :title="t('error_data_title')"
            :description="error"
          />
        </div>

        <div v-else-if="workout" class="flex flex-col gap-4 sm:gap-8">
          <!-- Header Section: Workout Info (2/3) + Performance Scores (1/3) -->
          <div id="header" class="scroll-mt-20" />
          <div
            v-if="false"
            class="hidden sm:grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6"
            :style="sectionStyle('overview')"
          >
            <!-- Workout Info Card - 2/3 -->
            <div class="lg:col-span-2">
              <div
                class="bg-white dark:bg-gray-900 rounded-none sm:rounded-xl shadow-none sm:shadow p-4 sm:p-6 h-full border-x-0 sm:border-x border-y border-gray-100 dark:border-gray-800"
              >
                <!-- Navigation & Date -->
                <div
                  class="mb-6 flex flex-col gap-4 border-b border-gray-100 pb-4 dark:border-gray-800 sm:mb-8 sm:flex-row sm:items-center sm:justify-between sm:pb-6"
                >
                  <div class="flex w-full flex-wrap items-center gap-3 sm:gap-4">
                    <UButton
                      icon="i-heroicons-chevron-left"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                      class="rounded-lg"
                      @click="
                        () => {
                          void navigateDate(-1)
                        }
                      "
                    />
                    <div class="flex flex-col">
                      <div
                        class="text-[10px] font-black uppercase tracking-[0.2em] text-primary-500"
                      >
                        {{ formatDateWeekday(workout.date) }}
                      </div>
                      <div
                        class="text-xs font-black uppercase tracking-tight text-gray-900 dark:text-white sm:text-sm"
                      >
                        {{ formatDatePrimary(workout.date) }}
                      </div>
                    </div>
                    <UButton
                      icon="i-heroicons-chevron-right"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                      class="rounded-lg"
                      @click="
                        () => {
                          void navigateDate(1)
                        }
                      "
                    />

                    <!-- Map Analysis shortcut -->
                    <UButton
                      :to="`/workouts/${workout.id}/map`"
                      icon="i-heroicons-map"
                      color="primary"
                      variant="subtle"
                      size="sm"
                      class="order-3 w-full justify-center font-bold sm:order-none sm:ml-2 sm:w-auto"
                    >
                      {{ t('map_analysis') }}
                    </UButton>

                    <div class="ml-auto flex flex-wrap items-center justify-end gap-2 sm:items-end">
                      <template v-if="workout.deviceName">
                        <UiDataAttribution
                          v-if="
                            detectProvider(workout.deviceName) &&
                            detectProvider(workout.deviceName) !== workout.source
                          "
                          :provider="detectProvider(workout.deviceName) || ''"
                          :device-name="workout.deviceName"
                        />
                        <span
                          v-else-if="
                            !detectProvider(workout.deviceName) &&
                            workout.source !== 'garmin' &&
                            workout.source !== 'zwift'
                          "
                          class="px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200"
                        >
                          {{ workout.deviceName }}
                        </span>
                      </template>

                      <UiDataAttribution
                        v-if="
                          [
                            'strava',
                            'garmin',
                            'zwift',
                            'apple_health',
                            'whoop',
                            'intervals',
                            'withings',
                            'hevy'
                          ].includes(workout.source)
                        "
                        :provider="workout.source"
                        :device-name="workout.deviceName"
                      />
                      <span
                        v-else
                        :class="getSourceBadgeClass(workout.source)"
                        class="font-black uppercase tracking-widest text-[9px]"
                      >
                        {{ getWorkoutSourceLabel(workout) }}
                      </span>
                    </div>
                  </div>
                </div>

                <div class="mb-4 flex items-start justify-between sm:mb-6">
                  <div class="flex-1">
                    <h1
                      class="mb-2 text-xl font-black uppercase tracking-tight text-gray-900 dark:text-white sm:text-2xl"
                    >
                      {{ workout.title }}
                    </h1>
                    <div
                      class="flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-widest text-gray-600 dark:text-gray-400 sm:gap-3"
                    >
                      <div class="flex items-center gap-1">
                        <span class="i-heroicons-clock w-3.5 h-3.5" />
                        {{ formatDuration(workout.durationSec) }}
                      </div>
                      <div v-if="workout.type" class="flex items-center gap-1">
                        <span class="i-heroicons-tag w-3.5 h-3.5" />
                        {{ workout.type }}
                        <UButton
                          color="neutral"
                          variant="ghost"
                          size="xs"
                          icon="i-heroicons-hashtag"
                          class="ml-1"
                          :ui="{ base: 'px-1.5' }"
                          @click="
                            () => {
                              showTagEditor = !showTagEditor
                            }
                          "
                        >
                          <span v-if="workout.tags?.length" class="text-[9px] font-black">
                            {{ workout.tags.length }}
                          </span>
                        </UButton>
                      </div>

                      <!-- Personal Best Badges -->
                      <div v-if="achievements.length > 0" class="flex items-center gap-1.5 ml-2">
                        <template v-for="pb in achievements" :key="pb.type">
                          <UTooltip
                            :text="`${pb.label}: ${pb.displayValue}${pb.unit === 's' ? '' : pb.unit}`"
                          >
                            <div
                              class="flex items-center gap-0.5 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 px-1.5 py-0.5 rounded-full border border-yellow-500/20 lowercase font-black text-[10px] tracking-tight"
                            >
                              <UIcon name="i-heroicons-trophy" class="w-2.5 h-2.5" />
                              {{ pb.label }}
                            </div>
                          </UTooltip>
                        </template>
                      </div>
                    </div>

                    <div v-if="showTagEditor" class="mt-5 space-y-3">
                      <div
                        class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"
                      >
                        <div class="min-w-0 flex-1">
                          <div
                            class="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2"
                          >
                            Workout tags
                          </div>
                          <UInputTags
                            v-model="localTagDraft"
                            placeholder="Add local tags"
                            color="neutral"
                            variant="outline"
                            size="sm"
                          />
                          <p
                            class="mt-2 text-[10px] font-bold uppercase tracking-widest text-gray-400"
                          >
                            Local tags can be edited here. Intervals tags stay read-only.
                          </p>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <UButton
                            color="neutral"
                            variant="ghost"
                            size="sm"
                            :disabled="!hasLocalTagChanges || savingTags"
                            @click="
                              () => {
                                void resetLocalTags()
                              }
                            "
                          >
                            Reset
                          </UButton>
                          <UButton
                            color="primary"
                            variant="solid"
                            size="sm"
                            icon="i-heroicons-tag"
                            :loading="savingTags"
                            :disabled="!hasLocalTagChanges"
                            @click="
                              () => {
                                void saveLocalTags()
                              }
                            "
                          >
                            Save Tags
                          </UButton>
                        </div>
                      </div>

                      <div
                        v-if="intervalsSourceTags.length > 0"
                        class="flex flex-wrap items-center gap-2"
                      >
                        <span
                          class="text-[10px] font-black uppercase tracking-widest text-gray-400"
                        >
                          Intervals
                        </span>
                        <UBadge
                          v-for="tag in intervalsSourceTags"
                          :key="tag"
                          color="neutral"
                          variant="subtle"
                          size="sm"
                          class="font-black tracking-tight lowercase"
                        >
                          {{ tag }}
                        </UBadge>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Key Stats Grid -->
                <div
                  class="mt-4 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-4 sm:gap-4"
                >
                  <div
                    v-if="workout.trainingLoad"
                    class="group cursor-pointer rounded-xl border border-blue-100 bg-blue-50 p-3.5 transition-all hover:border-blue-500/50 active:scale-[0.98] dark:border-blue-800/50 dark:bg-blue-900/20 sm:p-4"
                    @click="
                      () => {
                        handleOpenMetric({
                          key: t('metrics_tss'),
                          value: Math.round(workout.trainingLoad),
                          unit: ''
                        })
                      }
                    "
                  >
                    <div class="flex items-center justify-between mb-1">
                      <UTooltip
                        :popper="{ placement: 'top' }"
                        :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                        arrow
                      >
                        <div
                          class="text-[10px] font-black uppercase tracking-widest text-blue-600 dark:text-blue-400 border-b border-dashed border-blue-300 dark:border-blue-700 inline-block cursor-help"
                        >
                          {{ t('metrics_tss') }}
                        </div>
                        <template #content>
                          <div class="text-left text-sm">{{ tt('training_load') }}</div>
                        </template>
                      </UTooltip>
                      <UIcon
                        name="i-heroicons-magnifying-glass-circle"
                        class="w-4 h-4 text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                    <div
                      class="text-xl font-black tracking-tight text-blue-900 dark:text-blue-100 sm:text-2xl"
                    >
                      {{ Math.round(workout.trainingLoad) }}
                    </div>
                  </div>
                  <div
                    v-if="workout.averageHr"
                    class="group cursor-pointer rounded-xl border border-pink-100 bg-pink-50 p-3.5 transition-all hover:border-pink-500/50 active:scale-[0.98] dark:border-pink-800/50 dark:bg-pink-900/20 sm:p-4"
                    @click="
                      () => {
                        handleOpenMetric({
                          key: t('metrics_avg_hr'),
                          value: workout.averageHr,
                          unit: 'BPM'
                        })
                      }
                    "
                  >
                    <div class="flex items-center justify-between mb-1">
                      <UTooltip
                        :popper="{ placement: 'top' }"
                        :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                        arrow
                      >
                        <div
                          class="text-[10px] font-black uppercase tracking-widest text-pink-600 dark:text-pink-400 mb-1 border-b border-dashed border-pink-300 dark:border-pink-700 inline-block cursor-help"
                        >
                          {{ t('metrics_avg_hr') }}
                        </div>
                        <template #content>
                          <div class="text-left text-sm">{{ tt('avg_hr') }}</div>
                        </template>
                      </UTooltip>
                      <UIcon
                        name="i-heroicons-magnifying-glass-circle"
                        class="w-4 h-4 text-pink-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                    <div
                      class="text-xl font-black tracking-tight text-pink-900 dark:text-pink-100 sm:text-2xl"
                    >
                      {{ workout.averageHr }}
                      <span class="text-xs font-bold text-pink-500 uppercase">BPM</span>
                    </div>
                  </div>
                  <div
                    v-if="workout.averageWatts"
                    class="group cursor-pointer rounded-xl border border-purple-100 bg-purple-50 p-3.5 transition-all hover:border-purple-500/50 active:scale-[0.98] dark:border-purple-800/50 dark:bg-purple-900/20 sm:p-4"
                    @click="
                      () => {
                        handleOpenMetric({
                          key: t('metrics_avg_power'),
                          value: workout.averageWatts,
                          unit: 'W'
                        })
                      }
                    "
                  >
                    <div class="flex items-center justify-between mb-1">
                      <UTooltip
                        :popper="{ placement: 'top' }"
                        :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                        arrow
                      >
                        <div
                          class="text-[10px] font-black uppercase tracking-widest text-purple-600 dark:text-purple-400 mb-1 border-b border-dashed border-purple-300 dark:border-purple-700 inline-block cursor-help"
                        >
                          {{ t('metrics_avg_power') }}
                        </div>
                        <template #content>
                          <div class="text-left text-sm">{{ tt('avg_power') }}</div>
                        </template>
                      </UTooltip>
                      <UIcon
                        name="i-heroicons-magnifying-glass-circle"
                        class="w-4 h-4 text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                    <div
                      class="text-xl font-black tracking-tight text-purple-900 dark:text-purple-100 sm:text-2xl"
                    >
                      {{ workout.averageWatts
                      }}<span class="text-xs font-bold text-purple-500 uppercase">W</span>
                    </div>
                  </div>
                  <div
                    v-if="workout.normalizedPower"
                    class="group cursor-pointer rounded-xl border border-indigo-100 bg-indigo-50 p-3.5 transition-all hover:border-indigo-500/50 active:scale-[0.98] dark:border-indigo-800/50 dark:bg-indigo-900/20 sm:p-4"
                    @click="
                      () => {
                        handleOpenMetric({
                          key: t('metrics_np'),
                          value: workout.normalizedPower,
                          unit: 'W'
                        })
                      }
                    "
                  >
                    <div class="flex items-center justify-between mb-1">
                      <UTooltip
                        :popper="{ placement: 'top' }"
                        :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                        arrow
                      >
                        <div
                          class="text-[10px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-400 mb-1 border-b border-dashed border-indigo-300 dark:border-indigo-700 inline-block cursor-help"
                        >
                          {{ t('metrics_np') }}
                        </div>
                        <template #content>
                          <div class="text-left text-sm">{{ tt('norm_power') }}</div>
                        </template>
                      </UTooltip>
                      <UIcon
                        name="i-heroicons-magnifying-glass-circle"
                        class="w-4 h-4 text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      />
                    </div>
                    <div
                      class="text-xl font-black tracking-tight text-indigo-900 dark:text-indigo-100 sm:text-2xl"
                    >
                      {{ workout.normalizedPower
                      }}<span class="text-xs font-bold text-indigo-500 uppercase">W</span>
                    </div>
                  </div>
                </div>

                <div
                  v-if="workout.description"
                  class="mt-6 p-4 bg-gray-50 dark:bg-gray-950 rounded-xl border border-gray-100 dark:border-gray-800"
                >
                  <p
                    class="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed font-medium"
                  >
                    {{ workout.description }}
                  </p>
                </div>
              </div>
            </div>

            <!-- Performance Scores Card - 1/3 -->
            <div id="scores" class="scroll-mt-20 lg:col-span-1">
              <div
                v-if="
                  workout.overallScore ||
                  workout.technicalScore ||
                  workout.effortScore ||
                  workout.pacingScore ||
                  workout.executionScore
                "
                class="bg-white dark:bg-gray-900 rounded-none sm:rounded-xl shadow-none sm:shadow p-4 sm:p-6 border-x-0 sm:border-x border-y border-gray-100 dark:border-gray-800 h-full"
              >
                <h2
                  class="mb-4 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-gray-400 sm:mb-6"
                >
                  <UIcon name="i-heroicons-star" class="w-4 h-4 text-amber-500" />
                  {{ t('performance_summary_header') }}
                </h2>
                <div class="h-[180px] sm:h-[200px]">
                  <PerformanceScoreChart
                    :scores="{
                      overall: workout.overallScore,
                      technical: workout.technicalScore,
                      effort: workout.effortScore,
                      pacing: workout.pacingScore,
                      execution: workout.executionScore
                    }"
                  />
                </div>
              </div>
              <!-- Placeholder for when analysis is missing -->
              <div
                v-else
                class="bg-white dark:bg-gray-900 rounded-none sm:rounded-xl shadow-none sm:shadow p-4 sm:p-6 border-x-0 sm:border-x border-y border-gray-100 dark:border-gray-800 h-full flex flex-col items-center justify-center text-center"
              >
                <div
                  class="w-12 h-12 bg-gray-50 dark:bg-gray-800 rounded-full flex items-center justify-center mb-4"
                >
                  <UIcon name="i-heroicons-sparkles" class="w-6 h-6 text-gray-400" />
                </div>
                <h2 class="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">
                  {{ t('analysis_required_title') }}
                </h2>
                <p
                  class="text-[10px] text-gray-500 font-bold uppercase tracking-widest leading-relaxed max-w-[140px]"
                >
                  {{ t('analysis_required_desc') }}
                </p>
                <UButton
                  color="neutral"
                  variant="subtle"
                  size="xs"
                  class="mt-6 font-black uppercase tracking-widest text-[9px]"
                  @click="
                    () => {
                      void scrollToSection('analysis')
                    }
                  "
                >
                  {{ t('analysis_required_button') }}
                </UButton>
              </div>
            </div>
          </div>

          <!-- Refactored Threshold Detection Banner -->
          <template v-if="detectedThresholds.length > 0">
            <div
              v-for="detection in detectedThresholds"
              :key="detection.type"
              class="relative overflow-hidden bg-neutral-50 dark:bg-[#1A1A1A] border border-neutral-200 dark:border-gray-800 rounded-2xl p-6 sm:p-8 shadow-xl dark:shadow-2xl transition-all duration-300 group"
            >
              <!-- Decorative Accent -->
              <div class="absolute top-0 left-0 w-1 h-full bg-primary-500" />

              <div class="flex flex-col lg:flex-row lg:items-center gap-8 lg:gap-12">
                <!-- Left: Content & Context -->
                <div class="flex-1 space-y-4">
                  <div class="flex items-center gap-3">
                    <div
                      class="w-8 h-8 rounded-lg bg-primary-500/10 flex items-center justify-center border border-primary-500/20"
                    >
                      <UIcon name="i-heroicons-sparkles" class="w-5 h-5 text-primary-500" />
                    </div>
                    <h3
                      class="text-lg font-black text-neutral-900 dark:text-white uppercase tracking-tight italic"
                    >
                      {{ t('level_up_detected', { sport: detection.sportName }) }}
                    </h3>
                  </div>

                  <div class="space-y-2">
                    <p class="text-neutral-600 dark:text-gray-300 leading-relaxed">
                      {{ t('level_up_desc', { label: detection.label }) }}
                    </p>
                    <div class="flex items-center gap-2">
                      <p class="text-xs text-neutral-500 dark:text-gray-500 font-medium">
                        {{
                          t('level_up_peak_effort', {
                            value: detection.peakValue,
                            unit: detection.unit
                          })
                        }}
                      </p>
                      <UBadge
                        v-if="detection.isEstimated"
                        color="neutral"
                        variant="subtle"
                        size="xs"
                        class="uppercase text-[8px] font-bold"
                        :label="t('level_up_estimated')"
                      />
                    </div>
                  </div>

                  <div class="space-y-3 pt-2">
                    <div class="flex flex-wrap items-center gap-4">
                      <UButton
                        size="md"
                        color="primary"
                        variant="solid"
                        class="font-black px-6 shadow-lg shadow-primary-500/20"
                        :label="t('level_up_update_now')"
                        @click="
                          () => {
                            void openThresholdUpdate(detection)
                          }
                        "
                      />
                      <UButton
                        size="md"
                        color="neutral"
                        variant="ghost"
                        class="text-neutral-500 hover:text-neutral-900 dark:text-gray-400 dark:hover:text-white font-bold"
                        :label="t('level_up_later')"
                        @click="
                          () => {
                            void dismissedThresholds.push(detection.type)
                          }
                        "
                      />
                    </div>
                    <p class="text-[9px] text-neutral-400 dark:text-gray-500 italic leading-tight">
                      {{ t('level_up_sync_note') }}
                    </p>
                  </div>
                </div>

                <!-- Right: High-Contrast Visualization -->
                <div class="flex items-center justify-center lg:justify-end shrink-0">
                  <div
                    class="flex items-center gap-4 sm:gap-8 bg-neutral-100 dark:bg-black/40 p-6 rounded-2xl border border-neutral-200 dark:border-white/5"
                  >
                    <!-- Old Value -->
                    <div class="text-center">
                      <div
                        class="text-[10px] font-black text-neutral-400 dark:text-gray-500 uppercase tracking-widest mb-1"
                      >
                        {{ t('level_up_old') }}
                      </div>
                      <div
                        class="text-2xl font-bold text-neutral-400 dark:text-gray-400 line-through decoration-neutral-300 dark:decoration-gray-600"
                      >
                        {{ detection.oldValue
                        }}<span class="text-xs ml-0.5">{{ detection.unit.trim() }}</span>
                      </div>
                    </div>

                    <!-- Arrow and Percentage -->
                    <div class="flex flex-col items-center gap-1">
                      <div
                        v-if="detection.percent > 0"
                        class="text-[10px] font-black text-primary-500 bg-primary-500/10 px-2 py-0.5 rounded-full"
                      >
                        +{{ detection.percent }}%
                      </div>
                      <UIcon
                        name="i-heroicons-arrow-long-right"
                        class="w-8 h-8 text-neutral-300 dark:text-gray-600"
                      />
                    </div>

                    <!-- New Value -->
                    <div class="text-center relative">
                      <div
                        class="text-[10px] font-black text-primary-500 uppercase tracking-widest mb-1"
                      >
                        {{ t('level_up_new') }}
                      </div>
                      <div
                        class="text-4xl font-black text-neutral-900 dark:text-white flex items-baseline gap-1"
                      >
                        {{ detection.newValue }}
                        <span
                          class="text-sm font-bold text-neutral-400 dark:text-gray-500 uppercase"
                          >{{ detection.unit.trim() }}</span
                        >
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- Exercises Section -->
          <div
            v-if="isSectionEnabled('exercises')"
            id="exercises"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('exercises')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('sections_exercises') }}
            </h2>
            <WorkoutsExerciseList :exercises="workout.exercises" />
          </div>

          <!-- Fueling HUD (Nutrition Debrief) -->
          <div
            v-if="isSectionEnabled('nutrition')"
            id="nutrition"
            class="scroll-mt-20 bg-zinc-50 dark:bg-gray-900 rounded-none sm:rounded-3xl shadow-sm dark:shadow-2xl p-6 sm:p-10 border-x-0 sm:border-x border-y border-zinc-200 dark:border-white/5 relative overflow-hidden flex flex-col gap-8"
            :style="sectionStyle('nutrition')"
          >
            <!-- GHOST DECORATION (Dark Only) -->
            <div
              class="hidden dark:block absolute top-0 right-0 w-64 h-64 bg-orange-500/5 blur-[100px] pointer-events-none -mr-32 -mt-32"
            />

            <div class="flex items-center justify-between relative z-10">
              <div class="flex items-center gap-4">
                <div
                  class="w-12 h-12 rounded-2xl flex items-center justify-center bg-orange-500/10 border border-orange-500/20 shadow-inner"
                >
                  <UIcon name="i-heroicons-beaker" class="w-6 h-6 text-orange-500" />
                </div>
                <div class="flex flex-col">
                  <h2
                    class="text-xl sm:text-2xl font-black uppercase tracking-tighter text-black dark:text-white"
                  >
                    {{ t('nutrition_header') }}
                  </h2>
                  <span
                    class="font-mono text-[10px] text-zinc-600 dark:text-zinc-500 uppercase tracking-widest"
                    >Metabolic & Intake Balance</span
                  >
                </div>
              </div>

              <div v-if="workout.plannedWorkout?.tss" class="text-right flex flex-col items-end">
                <span
                  class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-widest mb-1"
                  >{{ t('nutrition_energy_delta') }}</span
                >
                <div
                  class="text-xl font-black tabular-nums tracking-tighter"
                  :class="kJDelta >= 10 ? 'text-red-500' : 'text-[#00DC82]'"
                >
                  {{ t('nutrition_vs_plan', { delta: (kJDelta > 0 ? '+' : '') + kJDelta }) }}
                </div>
              </div>
            </div>

            <!-- MAIN HUD CONTENT -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center relative z-10">
              <!-- MACRO GRID -->
              <div v-if="nutritionEstimate" class="grid grid-cols-2 gap-3 sm:gap-4">
                <div
                  v-for="item in nutritionEstimate"
                  :key="item.label"
                  class="relative group/tile overflow-hidden p-4 rounded-2xl bg-white dark:bg-white/[0.02] border border-zinc-200 dark:border-white/5 shadow-sm dark:shadow-inner transition-all hover:bg-zinc-100 dark:hover:bg-white/[0.04]"
                >
                  <!-- 1px Gradient Border Overlay -->
                  <div
                    class="absolute inset-0 pointer-events-none opacity-0 group-hover/tile:opacity-100 transition-opacity border border-primary-500/30 rounded-2xl"
                  />

                  <div class="flex flex-col relative z-10">
                    <div class="flex items-center gap-2 mb-2">
                      <UIcon :name="item.icon" class="w-3.5 h-3.5" :class="item.iconClass" />
                      <span
                        class="font-mono text-[8px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-widest"
                        >{{ item.label }}</span
                      >
                    </div>
                    <div class="flex items-baseline gap-1">
                      <span
                        class="text-2xl font-black text-black dark:text-white tracking-tighter"
                        >{{ item.value.split(' ')[0] }}</span
                      >
                      <span
                        class="text-[10px] font-bold text-zinc-600 dark:text-zinc-500 uppercase opacity-60"
                        >{{ item.value.split(' ')[1] }}</span
                      >
                    </div>
                  </div>
                </div>
              </div>

              <!-- ENERGY DELTA BAR -->
              <div class="flex flex-col gap-6">
                <div class="flex flex-col gap-2">
                  <div class="flex justify-between items-end">
                    <span
                      class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-widest"
                      >{{ t('nutrition_actual_energy') }} /
                      {{ t('nutrition_planned_energy') }}</span
                    >
                    <span
                      class="font-mono text-[9px] font-bold text-zinc-600 dark:text-zinc-400 tabular-nums"
                    >
                      {{ workout.kilojoules || 0 }} / {{ plannedKJ || 0 }} kJ
                    </span>
                  </div>

                  <div
                    class="relative h-4 w-full bg-zinc-200 dark:bg-white/5 rounded-full overflow-hidden border border-zinc-300 dark:border-white/5"
                  >
                    <!-- Progress Bar -->
                    <div
                      class="absolute inset-y-0 left-0 bg-gradient-to-r from-orange-600 to-orange-400 transition-all duration-1000 shadow-[0_0_15px_rgba(251,146,60,0.3)]"
                      :style="{
                        width:
                          Math.min(((workout.kilojoules || 0) / (plannedKJ || 1)) * 100, 100) + '%'
                      }"
                    >
                      <!-- Glowing Leading Edge -->
                      <div class="absolute right-0 top-0 bottom-0 w-1 bg-white/40 blur-[2px]" />
                    </div>

                    <!-- Demand Marker (Plan) -->
                    <div
                      class="absolute inset-y-0 border-l border-zinc-400 dark:border-white/20 z-20"
                      style="left: 100%"
                    />
                  </div>

                  <div
                    class="flex justify-between text-[8px] font-black text-zinc-500 dark:text-zinc-600 uppercase tracking-widest px-1"
                  >
                    <span>Deficit</span>
                    <span>Surplus</span>
                  </div>
                </div>

                <!-- STOMACH FEEL HUD -->
                <div
                  class="p-5 rounded-2xl bg-white dark:bg-white/[0.02] border border-zinc-200 dark:border-white/5 flex flex-col gap-4 shadow-sm dark:shadow-inner"
                >
                  <span
                    class="font-mono text-[9px] font-black text-zinc-600 dark:text-zinc-500 uppercase tracking-widest text-center"
                    >{{ t('nutrition_digestion_header') }}</span
                  >
                  <div class="flex items-center justify-center gap-3">
                    <button
                      v-for="i in 5"
                      :key="i"
                      class="w-10 h-10 rounded-xl flex items-center justify-center font-black text-lg transition-all duration-300 relative group/pill shadow-sm"
                      :class="[
                        stomachFeel === i
                          ? 'bg-[#00DC82] text-black scale-110 shadow-[0_0_20px_rgba(0,220,130,0.4)] z-20'
                          : 'bg-zinc-100 dark:bg-white/5 text-zinc-600 dark:text-zinc-500 hover:bg-zinc-200 dark:hover:bg-white/10'
                      ]"
                      @click="
                        () => {
                          void updateStomachFeel(i)
                        }
                      "
                    >
                      {{ i }}
                    </button>
                  </div>
                  <div class="flex justify-between px-2">
                    <span
                      class="text-[8px] font-black text-zinc-400 dark:text-zinc-600 uppercase tracking-[0.2em] opacity-60"
                      >{{ t('nutrition_digestion_poor') }}</span
                    >
                    <span
                      class="text-[8px] font-black text-zinc-400 dark:text-zinc-600 uppercase tracking-[0.2em] opacity-60"
                      >{{ t('nutrition_digestion_great') }}</span
                    >
                  </div>
                </div>
              </div>
            </div>

            <!-- Recovery Correction Banner (Compact HUD Style) -->
            <div
              v-if="kJDelta >= 10"
              class="p-4 bg-red-500/5 rounded-2xl border border-red-500/10 flex items-start gap-4 relative z-10"
            >
              <UIcon
                name="i-heroicons-exclamation-triangle"
                class="w-6 h-6 text-red-500 shrink-0"
              />
              <div class="flex flex-col">
                <h3
                  class="font-black text-red-600 dark:text-red-400 text-xs uppercase tracking-widest mb-1"
                >
                  {{ t('nutrition_adjustment_title') }}
                </h3>
                <p class="text-[11px] text-zinc-600 dark:text-zinc-400 font-medium leading-relaxed">
                  {{ t('nutrition_adjustment_desc', { delta: kJDelta, carbs: recoveryCarbBump }) }}
                </p>
              </div>
            </div>
          </div>

          <!-- AI Analysis Section -->
          <div
            v-if="shouldRenderSection('analysis')"
            id="analysis"
            class="scroll-mt-20 space-y-0 sm:space-y-8"
            :style="sectionStyle('analysis')"
          >
            <h2
              class="hidden sm:block text-base font-black uppercase tracking-[0.25em] text-zinc-500 px-5 sm:px-0 mb-4 sm:mb-0"
            >
              {{ t('analysis_header') }}
            </h2>

            <!-- Plan Adherence HUD -->
            <div v-if="workout.plannedWorkout" class="px-0 sm:px-0">
              <PlanAdherence
                :adherence="workout.planAdherence"
                :regenerating="analyzingAdherence"
                :unlinking="unlinkingPlannedWorkout"
                :planned-workout="workout.plannedWorkout"
                @regenerate="analyzeAdherence"
                @unlink="unlinkPlannedWorkout"
              />
            </div>

            <!-- DETAILED INSIGHT HUD -->
            <div
              class="bg-zinc-50 dark:bg-gray-900 rounded-none sm:rounded-3xl shadow-sm dark:shadow-2xl p-6 sm:p-10 border-x-0 sm:border-x border-y border-zinc-200 dark:border-white/5 relative overflow-hidden"
            >
              <div class="flex items-center justify-between mb-10 relative z-10">
                <div class="flex items-center gap-3">
                  <div
                    class="w-10 h-10 rounded-xl flex items-center justify-center bg-primary-500/10 border border-primary-500/20"
                  >
                    <UIcon name="i-heroicons-sparkles" class="w-5 h-5 text-primary-500" />
                  </div>
                  <h3
                    class="text-lg sm:text-xl font-black uppercase tracking-tighter text-black dark:text-white"
                  >
                    {{ t('analysis_detail_title') }}
                  </h3>
                </div>
                <div class="flex items-center gap-3">
                  <div
                    v-if="workout.aiAnalysisStatus === 'QUOTA_EXCEEDED' && !workout.aiAnalysis"
                    class="rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-left max-w-md"
                  >
                    <p class="text-xs font-semibold text-amber-900 dark:text-amber-100">
                      {{ t('analysis_quota_skipped_title') }}
                    </p>
                    <p class="text-[11px] text-amber-800/90 dark:text-amber-200 mt-1">
                      {{ t('analysis_quota_skipped_desc') }}
                    </p>
                    <div class="flex flex-wrap gap-2 mt-3">
                      <UButton
                        size="xs"
                        color="primary"
                        variant="solid"
                        @click="
                          () => {
                            void openWorkoutQuotaUpgrade()
                          }
                        "
                      >
                        {{ t('analysis_quota_skipped_upgrade') }}
                      </UButton>
                      <UButton
                        v-if="canAnalyzeNowAfterQuotaReset"
                        size="xs"
                        color="neutral"
                        variant="outline"
                        :loading="analyzingWorkout"
                        @click="
                          () => {
                            void analyzeWorkout()
                          }
                        "
                      >
                        {{ t('analysis_quota_skipped_retry') }}
                      </UButton>
                    </div>
                  </div>
                  <UButton
                    v-if="!workout.aiAnalysis"
                    icon="i-heroicons-sparkles"
                    color="primary"
                    variant="solid"
                    size="md"
                    class="font-black uppercase tracking-widest text-[11px] px-6"
                    :loading="analyzingWorkout"
                    :disabled="analyzingWorkout"
                    @click="
                      () => {
                        void analyzeWorkout()
                      }
                    "
                  >
                    {{ t('analysis_button_analyze') }}
                  </UButton>
                  <UButton
                    v-else
                    icon="i-heroicons-arrow-path"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    class="font-black uppercase tracking-widest text-[10px] bg-white dark:bg-white/5 border-zinc-200 dark:border-white/10"
                    :loading="analyzingWorkout"
                    :disabled="analyzingWorkout"
                    @click="
                      () => {
                        void analyzeWorkout()
                      }
                    "
                  >
                    {{ t('analysis_button_regenerate') }}
                  </UButton>
                  <UButton
                    v-if="canPublishSummaryToIntervals"
                    icon="i-heroicons-paper-airplane"
                    color="primary"
                    variant="outline"
                    size="sm"
                    class="font-black uppercase tracking-widest text-[10px] hidden sm:flex"
                    :loading="publishingSummary"
                    :disabled="publishingSummary || analyzingWorkout"
                    @click="
                      () => {
                        void publishSummaryToIntervals()
                      }
                    "
                  >
                    {{ t('analysis_button_publish') }}
                  </UButton>
                </div>
              </div>

              <!-- Structured Analysis HUD Layers -->
              <div v-if="workout.aiAnalysisJson" class="space-y-12 relative z-10">
                <!-- Coach's Briefing (Executive Summary) -->
                <div
                  class="bg-white dark:bg-white/[0.03] backdrop-blur-md rounded-2xl p-8 border border-zinc-200 dark:border-white/10 relative overflow-hidden group/briefing shadow-sm dark:shadow-none"
                >
                  <div
                    class="absolute top-0 left-0 w-1.5 h-full bg-primary-500 shadow-[0_0_15px_#00DC82]"
                  />
                  <h3
                    class="font-mono text-[9px] font-black uppercase tracking-[0.3em] text-zinc-600 dark:text-zinc-500 mb-5 flex items-center gap-2"
                  >
                    <UIcon
                      name="i-heroicons-light-bulb"
                      class="w-4 h-4 text-primary-500 animate-pulse"
                    />
                    Key Strategic Takeaway
                  </h3>
                  <p
                    class="text-lg text-zinc-800 dark:text-zinc-100 leading-relaxed font-medium drop-shadow-sm whitespace-pre-wrap"
                  >
                    {{ workout.aiAnalysisJson.executive_summary }}
                  </p>
                </div>

                <!-- Analysis Grid (HUD Cards) -->
                <div
                  v-if="workout.aiAnalysisJson.sections"
                  class="grid grid-cols-1 md:grid-cols-2 gap-6"
                >
                  <div
                    v-for="(section, index) in workout.aiAnalysisJson.sections"
                    :key="index"
                    class="overflow-hidden border border-zinc-200 dark:border-white/5 bg-white dark:bg-white/[0.01] rounded-2xl group/section hover:bg-zinc-50 dark:hover:bg-white/[0.03] transition-all duration-500 shadow-sm dark:shadow-none"
                  >
                    <div
                      class="px-6 py-4 border-b border-zinc-100 dark:border-white/5 flex items-center justify-between bg-zinc-50/50 dark:bg-white/[0.02]"
                    >
                      <h3
                        class="font-mono text-[9px] font-black uppercase tracking-[0.25em] text-zinc-500 dark:text-zinc-400"
                      >
                        {{ section.title }}
                      </h3>
                      <div
                        class="px-2 py-0.5 rounded border font-black uppercase tracking-widest text-[8px] transition-colors duration-500"
                        :class="getStatusPillClass(section.status)"
                      >
                        {{ section.status_label || section.status }}
                      </div>
                    </div>
                    <div class="px-6 py-6">
                      <ul class="space-y-4">
                        <li
                          v-for="(point, pIndex) in section.analysis_points"
                          :key="pIndex"
                          class="flex items-start gap-3 text-sm text-zinc-700 dark:text-zinc-300 font-medium leading-relaxed"
                        >
                          <span
                            class="i-heroicons-chevron-right w-4 h-4 mt-0.5 text-primary-500/50 flex-shrink-0"
                          />
                          <!-- eslint-disable-next-line vue/no-v-html -->
                          <span v-html="highlightTechnicalData(point)"></span>
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>

                <!-- Strategic Recommendations HUD -->
                <div
                  v-if="workout.aiAnalysisJson.recommendations?.length"
                  class="overflow-hidden border border-zinc-200 dark:border-white/5 bg-white dark:bg-white/[0.01] rounded-2xl shadow-sm dark:shadow-inner"
                >
                  <div
                    class="px-8 py-5 border-b border-zinc-100 dark:border-white/5 bg-zinc-50/50 dark:bg-white/[0.02]"
                  >
                    <h3
                      class="font-mono text-[9px] font-black uppercase tracking-[0.3em] text-zinc-500 dark:text-zinc-400 flex items-center gap-2"
                    >
                      <UIcon
                        name="i-heroicons-clipboard-document-list"
                        class="w-4 h-4 text-primary-500"
                      />
                      Command Corrections
                    </h3>
                  </div>
                  <div class="px-8 py-10 space-y-8">
                    <div
                      v-for="(rec, index) in workout.aiAnalysisJson.recommendations"
                      :key="index"
                      class="border-l-4 pl-6 py-1 relative group/rec"
                      :class="getPriorityBorderClass(rec.priority)"
                    >
                      <div class="flex items-center gap-3 mb-2">
                        <h4
                          class="text-base font-black text-black dark:text-white uppercase tracking-tight"
                        >
                          {{ rec.title }}
                        </h4>
                        <span
                          v-if="rec.priority"
                          :class="getPriorityBadgeClass(rec.priority)"
                          class="text-[8px] px-2 py-0.5 rounded-full font-black uppercase tracking-widest border border-zinc-200 dark:border-white/10 bg-zinc-100 dark:bg-white/5"
                        >
                          {{ rec.priority }}
                        </span>
                      </div>
                      <p
                        class="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed font-medium whitespace-pre-wrap"
                      >
                        {{ rec.description }}
                      </p>
                    </div>
                  </div>
                </div>

                <!-- Physical Response Matrix (Strengths & Weaknesses) -->
                <div
                  v-if="
                    workout.aiAnalysisJson.strengths?.length ||
                    workout.aiAnalysisJson.weaknesses?.length
                  "
                  class="grid grid-cols-1 md:grid-cols-2 gap-6"
                >
                  <div
                    v-if="workout.aiAnalysisJson.strengths?.length"
                    class="rounded-2xl p-8 border border-[#00DC82]/10 bg-white dark:bg-[#00DC82]/[0.02] relative overflow-hidden group/str shadow-sm dark:shadow-none"
                  >
                    <div
                      class="absolute top-0 right-0 p-4 opacity-5 group-hover/str:opacity-10 transition-opacity"
                    >
                      <UIcon name="i-heroicons-bolt" class="w-20 h-20 text-[#00DC82]" />
                    </div>
                    <h3
                      class="font-mono text-[9px] font-black uppercase tracking-[0.3em] text-[#00DC82] mb-6 flex items-center gap-2"
                    >
                      Performance Strengths
                    </h3>
                    <ul class="space-y-4">
                      <li
                        v-for="(strength, index) in workout.aiAnalysisJson.strengths"
                        :key="index"
                        class="flex items-start gap-3 text-xs font-bold text-zinc-700 dark:text-zinc-200"
                      >
                        <UIcon
                          name="i-heroicons-check-circle"
                          class="w-4 h-4 text-[#00DC82] shrink-0"
                        />
                        <span>{{ strength }}</span>
                      </li>
                    </ul>
                  </div>

                  <div
                    v-if="workout.aiAnalysisJson.weaknesses?.length"
                    class="rounded-2xl p-8 border border-orange-500/10 bg-white dark:bg-orange-500/[0.02] relative overflow-hidden group/weak shadow-sm dark:shadow-none"
                  >
                    <div
                      class="absolute top-0 right-0 p-4 opacity-5 group-hover/weak:opacity-10 transition-opacity"
                    >
                      <UIcon name="i-heroicons-fire" class="w-20 h-20 text-orange-500" />
                    </div>
                    <h3
                      class="font-mono text-[9px] font-black uppercase tracking-[0.3em] text-orange-600 dark:text-orange-400 mb-6 flex items-center gap-2"
                    >
                      Technical Limitors
                    </h3>
                    <ul class="space-y-4">
                      <li
                        v-for="(weakness, index) in workout.aiAnalysisJson.weaknesses"
                        :key="index"
                        class="flex items-start gap-3 text-xs font-bold text-zinc-700 dark:text-zinc-200"
                      >
                        <UIcon
                          name="i-heroicons-arrow-trending-up"
                          class="w-4 h-4 text-orange-500 shrink-0"
                        />
                        <span>{{ weakness }}</span>
                      </li>
                    </ul>
                  </div>
                </div>

                <!-- Telemetry Validation -->
                <div
                  v-if="workout.aiAnalyzedAt"
                  class="flex justify-between items-center pt-8 border-t border-zinc-100 dark:border-white/5"
                >
                  <div
                    class="font-mono text-[9px] font-black text-zinc-400 dark:text-zinc-600 uppercase tracking-[0.2em]"
                  >
                    Intelligence Sync Completed • {{ formatDate(workout.aiAnalyzedAt) }}
                  </div>
                </div>
              </div>

              <!-- Legacy Fallback -->
              <div v-else-if="workout.aiAnalysis" class="space-y-6 relative z-10">
                <div class="prose prose-sm dark:prose-invert max-w-none px-2">
                  <!-- eslint-disable vue/no-v-html -- markdown-rendered analysis -->
                  <div
                    class="text-zinc-300 font-medium leading-relaxed"
                    v-html="renderedAnalysis"
                  />
                  <!-- eslint-enable vue/no-v-html -->
                </div>
                <div
                  v-if="workout.aiAnalyzedAt"
                  class="flex justify-between items-center pt-8 border-t border-white/5"
                >
                  <div
                    class="font-mono text-[9px] font-black text-zinc-600 uppercase tracking-[0.2em]"
                  >
                    Legacy Audit Sync • {{ formatDate(workout.aiAnalyzedAt) }}
                  </div>
                </div>
              </div>

              <!-- PENDING STATES -->
              <div v-else-if="!analyzingWorkout" class="text-center py-24 relative z-10">
                <div
                  class="w-20 h-20 bg-white/5 rounded-3xl flex items-center justify-center mx-auto mb-8 border border-white/10 group-hover:border-primary-500/30 transition-colors"
                >
                  <UIcon
                    name="i-heroicons-bolt"
                    class="w-10 h-10 text-zinc-600 opacity-40 group-hover:text-primary-500 transition-colors"
                  />
                </div>
                <p class="text-sm font-black uppercase tracking-[0.3em] text-white mb-2">
                  Intelligence Audit Pending
                </p>
                <p class="text-xs text-zinc-500 max-w-sm mx-auto leading-relaxed">
                  Run deep multi-channel analysis to identify technical limitors and metabolic
                  breakthroughs.
                </p>
                <UButton
                  size="lg"
                  color="primary"
                  variant="solid"
                  class="mt-10 font-black uppercase tracking-[0.2em] text-[11px] px-10 py-4 shadow-[0_0_30px_rgba(0,220,130,0.2)] rounded-xl"
                  @click="
                    () => {
                      void analyzeWorkout()
                    }
                  "
                >
                  {{ t('analysis_button_analyze') }}
                </UButton>
              </div>

              <div v-else class="text-center py-24 relative z-10">
                <div class="relative w-20 h-20 mx-auto mb-8">
                  <div
                    class="absolute inset-0 rounded-full border-2 border-primary-500/20 animate-ping"
                  />
                  <div
                    class="absolute inset-0 rounded-full border-t-2 border-primary-500 animate-spin"
                  />
                  <UIcon
                    name="i-heroicons-cpu-chip"
                    class="absolute inset-0 m-auto w-8 h-8 text-primary-500 animate-pulse"
                  />
                </div>
                <p class="text-sm text-white font-black uppercase tracking-[0.3em] animate-pulse">
                  {{ t('analysis_analyzing') }}
                </p>
                <p class="text-[10px] font-mono text-zinc-500 uppercase mt-2 tracking-widest">
                  Cross-referencing metabolic zones
                </p>
              </div>
            </div>
          </div>

          <!-- Power Curve Section -->
          <div
            v-if="shouldRenderSection('power-curve')"
            id="power-curve"
            class="scroll-mt-20 space-y-6"
            :style="sectionStyle('power-curve')"
          >
            <h2
              class="text-base font-black uppercase tracking-[0.25em] text-zinc-600 dark:text-zinc-500 px-5 sm:px-0"
            >
              {{ t('sections_power_curve') }}
            </h2>
            <div
              class="bg-zinc-50 dark:bg-gray-900 rounded-none sm:rounded-3xl shadow-sm dark:shadow-2xl p-6 sm:p-10 border-x-0 sm:border-x border-y border-zinc-200 dark:border-white/5 relative overflow-hidden"
            >
              <PowerCurveChart :workout-id="workout.id" />
            </div>
          </div>

          <!-- Interval Analysis Section -->
          <div
            v-if="shouldRenderSection('intervals')"
            id="intervals"
            class="scroll-mt-20 space-y-6"
            :style="sectionStyle('intervals')"
          >
            <h2
              class="text-base font-black uppercase tracking-[0.25em] text-zinc-600 dark:text-zinc-500 px-5 sm:px-0 flex items-center justify-between w-full"
            >
              <span>{{ t('sections_intervals') }}</span>
              <UButton
                icon="i-heroicons-cpu-chip"
                size="xs"
                variant="ghost"
                color="neutral"
                class="font-black uppercase tracking-widest text-[9px]"
                :to="`/workouts/${workout.id}/intervals`"
              >
                {{ t('interval_audit') }}
              </UButton>
            </h2>
            <div
              class="bg-zinc-50 dark:bg-gray-900 rounded-none sm:rounded-3xl shadow-sm dark:shadow-2xl p-0 border-x-0 sm:border-x border-y border-zinc-200 dark:border-white/5 relative overflow-hidden"
            >
              <IntervalsAnalysis
                :workout-id="workout.id"
                class="!bg-transparent !border-none !shadow-none !p-6 sm:!p-10"
              />
            </div>
          </div>

          <!-- Advanced Analytics Section -->
          <div
            v-if="shouldRenderSection('advanced')"
            id="advanced"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('advanced')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('sections_advanced') }}
            </h2>
            <AdvancedWorkoutMetrics :workout-id="workout.id" @open-metric="handleOpenMetric" />
          </div>

          <!-- Route Map Section -->
          <div
            v-if="shouldRenderSection('map')"
            id="map"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('map')"
          >
            <h2
              class="text-base font-black uppercase tracking-widest text-gray-400 px-4 sm:px-0 flex items-center justify-between w-full"
            >
              <span>{{ t('sections_map') }}</span>
              <UButton
                icon="i-heroicons-arrows-pointing-out"
                size="xs"
                variant="ghost"
                color="neutral"
                class="font-black uppercase tracking-widest text-[9px]"
                :to="`/workouts/${workout.id}/map`"
              >
                {{ t('map_analysis') }}
              </UButton>
            </h2>
            <UiWorkoutMap
              :coordinates="workout.streams.latlng"
              :streams="workout.streams"
              :workout-id="workout.id"
              :interactive="true"
              :provider="workout.source"
              :provider-label="getWorkoutSourceLabel(workout, t)"
              :device-name="workout.deviceName"
            />
          </div>

          <!-- Pacing Analysis -->
          <div
            v-if="shouldRenderSection('pacing')"
            id="pacing"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('pacing')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('sections_pacing') }}
            </h2>
            <PacingAnalysis
              :workout-id="workout.id"
              :activity-type="workout.type"
              @open-metric="handleOpenMetric"
            />
          </div>

          <!-- Timeline -->
          <div
            v-if="shouldRenderSection('timeline')"
            id="timeline"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('timeline')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('sections_timeline') }}
            </h2>
            <WorkoutTimeline :workout-id="workout.id" />
          </div>

          <!-- Zones -->
          <div
            v-if="shouldRenderSection('zones')"
            id="zones"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('zones')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('sections_zones') }}
            </h2>
            <ZoneChart
              :workout-id="workout.id"
              :activity-type="workout.type"
              :stream-data="workout.streams"
            />
          </div>

          <!-- Efficiency -->
          <div
            v-if="shouldRenderSection('efficiency')"
            id="efficiency"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('efficiency')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('sections_efficiency') }}
            </h2>
            <EfficiencyMetricsCard
              :metrics="{
                variabilityIndex: workout.variabilityIndex,
                efficiencyFactor: workout.efficiencyFactor,
                decoupling: workout.decoupling,
                powerHrRatio: workout.powerHrRatio,
                polarizationIndex: workout.polarizationIndex,
                lrBalance: workout.lrBalance
              }"
              @open-metric="handleOpenMetric"
            />
          </div>

          <!-- Personal Notes -->
          <div
            v-if="isSectionEnabled('notes')"
            id="notes"
            class="scroll-mt-20 px-0 sm:px-0"
            :style="sectionStyle('notes')"
          >
            <NotesEditor
              v-model="workout.notes"
              :notes-updated-at="workout.notesUpdatedAt"
              :api-endpoint="`/api/workouts/${workout.id}/notes`"
              class="rounded-none sm:rounded-xl border-x-0 sm:border-x border-y shadow-none sm:shadow"
              @update:notes-updated-at="workout.notesUpdatedAt = $event"
            />
          </div>

          <!-- Detailed Metrics Section -->
          <div
            v-if="shouldRenderSection('metrics')"
            id="metrics"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('metrics')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('sections_metrics') }}
            </h2>
            <div
              class="bg-white dark:bg-gray-900 rounded-none sm:rounded-xl shadow-none sm:shadow p-6 border-x-0 sm:border-x border-y border-gray-100 dark:border-gray-800 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3"
            >
              <div
                v-for="metric in availableMetrics"
                :key="metric.key"
                class="flex justify-between py-2.5 border-b border-gray-100 dark:border-gray-800 group cursor-pointer hover:bg-gray-50/50 dark:hover:bg-gray-800/50 px-2 -mx-2 transition-colors"
                @click="
                  () => {
                    void handleOpenMetric({ key: metric.label, value: metric.value })
                  }
                "
              >
                <div class="flex items-center gap-2">
                  <UTooltip
                    v-if="metricTooltips[metric.label]"
                    :popper="{ placement: 'top' }"
                    :ui="{ content: 'w-[300px] h-auto whitespace-normal' }"
                    arrow
                  >
                    <span
                      class="text-[10px] font-black uppercase tracking-widest text-gray-500 border-b border-dashed border-gray-300 dark:border-gray-700 cursor-help group-hover:text-primary-500 group-hover:border-primary-300 transition-colors"
                      >{{ metric.label }}</span
                    >
                    <template #content>
                      <div class="text-left text-sm">{{ metricTooltips[metric.label] }}</div>
                    </template>
                  </UTooltip>
                  <span
                    v-else
                    class="text-[10px] font-black uppercase tracking-widest text-gray-500 group-hover:text-primary-500 transition-colors"
                  >
                    {{ metric.label }}
                  </span>
                  <UBadge
                    v-if="metric.source === 'fit'"
                    color="neutral"
                    variant="soft"
                    size="xs"
                    class="uppercase tracking-widest font-black text-[8px]"
                  >
                    FIT
                  </UBadge>
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-sm font-black text-black dark:text-white">{{
                    metric.value
                  }}</span>
                  <UIcon
                    name="i-heroicons-magnifying-glass-circle"
                    class="w-3.5 h-3.5 text-gray-400 opacity-0 group-hover:opacity-100"
                  />
                </div>
              </div>
            </div>

            <div
              v-if="hasAnalysisFactsPanel"
              class="bg-white dark:bg-gray-900 rounded-none sm:rounded-xl shadow-none sm:shadow p-6 border-x-0 sm:border-x border-y border-gray-100 dark:border-gray-800"
            >
              <div class="flex flex-col gap-5">
                <div class="flex items-center justify-between gap-4 flex-wrap">
                  <div class="flex items-center gap-2">
                    <UIcon name="i-heroicons-beaker" class="w-5 h-5 text-amber-500" />
                    <div class="flex flex-col">
                      <h3
                        class="text-sm font-black uppercase tracking-widest text-gray-900 dark:text-white"
                      >
                        Calculated Workout Facts
                      </h3>
                      <div
                        class="text-[10px] font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500"
                      >
                        Derived training interpretation signals for this workout
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <UBadge
                      color="primary"
                      variant="soft"
                      class="font-black uppercase tracking-widest text-[9px]"
                    >
                      Schema: {{ analysisFactsVersionLabel }}
                    </UBadge>
                    <UBadge
                      color="success"
                      variant="soft"
                      class="font-black uppercase tracking-widest text-[9px]"
                    >
                      Included: {{ includedPromptFactsCount }}
                    </UBadge>
                    <UBadge
                      color="neutral"
                      variant="soft"
                      class="font-black uppercase tracking-widest text-[9px]"
                    >
                      Ignored: {{ ignoredPromptFactsCount }}
                    </UBadge>
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      class="font-black uppercase tracking-widest text-[10px]"
                      :icon="
                        analysisFactsOpen ? 'i-heroicons-chevron-up' : 'i-heroicons-chevron-down'
                      "
                      :label="analysisFactsOpen ? 'Hide Facts' : 'Show Facts'"
                      @click="
                        () => {
                          analysisFactsOpen = !analysisFactsOpen
                        }
                      "
                    />
                  </div>
                </div>

                <div
                  v-if="!analysisFactsOpen"
                  class="rounded-xl bg-amber-50/70 dark:bg-amber-950/20 p-4 border border-amber-100 dark:border-amber-900/40"
                >
                  <div
                    class="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-400 mb-2"
                  >
                    Collapsed Summary
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <UBadge
                      v-for="badge in analysisFactsSummaryBadges"
                      :key="badge.key"
                      :color="getSummaryBadgeColor(badge.value)"
                      variant="soft"
                      class="font-black uppercase tracking-widest text-[9px]"
                    >
                      {{ badge.label }}: {{ formatFactValue(badge.value) }}
                    </UBadge>
                  </div>
                </div>

                <div v-else class="space-y-4">
                  <div class="flex flex-wrap gap-2 mb-1">
                    <UBadge
                      v-for="badge in analysisFactsSummaryBadges"
                      :key="badge.key"
                      :color="getSummaryBadgeColor(badge.value)"
                      variant="soft"
                      class="font-black uppercase tracking-widest text-[9px]"
                    >
                      {{ badge.label }}: {{ formatFactValue(badge.value) }}
                    </UBadge>
                  </div>

                  <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div
                      v-for="group in analysisFactsGroups"
                      :key="group.key"
                      class="rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden"
                    >
                      <div
                        class="px-4 py-3 bg-gray-50/70 dark:bg-gray-950/50 border-b border-gray-100 dark:border-gray-800"
                      >
                        <h4
                          class="text-[10px] font-black uppercase tracking-widest text-gray-900 dark:text-white"
                        >
                          {{ group.label }}
                        </h4>
                      </div>
                      <div class="px-4 py-3 space-y-2">
                        <div
                          v-for="entry in group.entries"
                          :key="entry.key"
                          class="flex items-start justify-between gap-4 text-xs"
                        >
                          <UTooltip
                            :text="analysisFactTooltips[entry.key] || entry.label"
                            :popper="{ placement: 'top' }"
                            :ui="{ content: 'w-[280px] h-auto whitespace-normal' }"
                            arrow
                          >
                            <div
                              class="font-black uppercase tracking-widest text-gray-400 border-b border-dashed border-gray-300 dark:border-gray-700 inline-block cursor-help"
                            >
                              {{ entry.label }}
                            </div>
                          </UTooltip>
                          <UTooltip
                            :text="getPromptDecisionReason(entry.path)"
                            :popper="{ placement: 'left' }"
                            :ui="{ content: 'w-[260px] h-auto whitespace-normal' }"
                            arrow
                          >
                            <div
                              class="text-right font-medium cursor-help"
                              :class="getPromptDecisionValueClass(entry.path)"
                            >
                              {{ formatFactValue(entry.value) }}
                            </div>
                          </UTooltip>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Data Streams Section -->
          <div
            v-if="shouldRenderSection('streams')"
            id="streams"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('streams')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('sections_streams') }}
            </h2>
            <div
              class="bg-white dark:bg-gray-900 rounded-none sm:rounded-xl shadow-none sm:shadow p-6 border-x-0 sm:border-x border-y border-gray-100 dark:border-gray-800 flex flex-wrap gap-2.5"
            >
              <UBadge
                v-for="stream in availableStreams"
                :key="stream.key"
                color="neutral"
                variant="subtle"
                size="sm"
                class="cursor-pointer hover:bg-primary-50 dark:hover:bg-primary-950 transition-colors uppercase font-black tracking-widest text-[9px] px-2.5 py-1"
                @click="
                  () => {
                    void openStreamModal({
                      ...stream,
                      label: stream.label || '',
                      color: stream.color || '#000000',
                      unit: stream.unit || ''
                    })
                  }
                "
              >
                {{ stream.label }}
              </UBadge>
              <UButton
                v-if="hasExtrasMeta"
                icon="i-heroicons-code-bracket-square"
                color="neutral"
                variant="soft"
                size="sm"
                class="uppercase font-black tracking-widest text-[9px] px-2.5 py-1"
                @click="
                  () => {
                    isExtrasMetaModalOpen = true
                  }
                "
              >
                {{ t('modal_extras_title') }}
              </UButton>
            </div>
          </div>

          <!-- Duplicate Workout Section -->
          <div
            v-if="shouldRenderSection('duplicates')"
            id="duplicates"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('duplicates')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('version_header') }}
            </h2>
            <div
              class="bg-white dark:bg-gray-900 rounded-none sm:rounded-xl shadow-none sm:shadow p-6 border-x-0 sm:border-x border-y border-gray-100 dark:border-gray-800"
            >
              <!-- Case 1: This is a duplicate -->
              <div
                v-if="workout.isDuplicate"
                class="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg border border-yellow-200 dark:border-yellow-800"
              >
                <div class="flex items-start gap-3">
                  <UIcon
                    name="i-heroicons-information-circle"
                    class="w-6 h-6 text-yellow-600 dark:text-yellow-400 flex-shrink-0"
                  />
                  <div>
                    <h3
                      class="font-bold text-yellow-900 dark:text-yellow-100 uppercase tracking-tight"
                    >
                      {{ t('version_duplicate_title') }}
                    </h3>
                    <p class="text-sm text-yellow-800 dark:text-yellow-200 mt-1">
                      {{ t('version_duplicate_desc') }}
                    </p>

                    <div v-if="workout.canonicalWorkout" class="mt-4">
                      <p
                        class="text-[10px] font-black uppercase text-gray-500 tracking-widest mb-2"
                      >
                        {{ t('version_original_ref') }}
                      </p>
                      <div
                        class="p-4 bg-gray-50 dark:bg-gray-950 rounded-xl border border-gray-100 dark:border-gray-800"
                      >
                        <div
                          class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4"
                        >
                          <NuxtLink
                            :to="`/workouts/${workout.canonicalWorkout.id}`"
                            class="block min-w-0 flex-1 hover:opacity-90 transition-opacity"
                          >
                            <div
                              class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4"
                            >
                              <div class="min-w-0 flex-1">
                                <div
                                  class="font-black text-gray-900 dark:text-white truncate uppercase tracking-tight"
                                >
                                  {{ workout.canonicalWorkout.title }}
                                </div>
                                <div
                                  class="text-[10px] text-gray-500 mt-1 font-bold uppercase tracking-widest"
                                >
                                  {{ formatDate(workout.canonicalWorkout.date) }}
                                </div>
                              </div>
                              <div
                                class="flex items-center justify-between sm:justify-end gap-4 shrink-0"
                              >
                                <div class="flex justify-end">
                                  <UiDataAttribution
                                    v-if="
                                      [
                                        'strava',
                                        'garmin',
                                        'zwift',
                                        'apple_health',
                                        'whoop',
                                        'intervals',
                                        'withings',
                                        'hevy'
                                      ].includes(workout.canonicalWorkout.source)
                                    "
                                    :provider="workout.canonicalWorkout.source"
                                    :device-name="workout.canonicalWorkout.deviceName"
                                    mode="minimal"
                                  />
                                  <span
                                    v-else
                                    :class="getSourceBadgeClass(workout.canonicalWorkout.source)"
                                    class="py-0 px-1.5 text-[10px]"
                                  >
                                    {{ getWorkoutSourceLabel(workout.canonicalWorkout, t) }}
                                  </span>
                                </div>
                                <UIcon
                                  name="i-heroicons-arrow-right"
                                  class="w-4 h-4 text-gray-400"
                                />
                              </div>
                            </div>
                          </NuxtLink>

                          <UButton
                            size="xs"
                            color="warning"
                            variant="soft"
                            icon="i-heroicons-link-slash"
                            class="font-bold shrink-0"
                            :loading="unlinkingDuplicateId === workout.id"
                            @click="
                              () => {
                                void openDuplicateUnlinkConfirm(
                                  workout.id,
                                  workout.canonicalWorkout.title
                                )
                              }
                            "
                          >
                            Unlink
                          </UButton>
                        </div>
                      </div>
                    </div>

                    <div class="mt-4 pt-4 border-t border-yellow-200 dark:border-yellow-800/50">
                      <UButton
                        size="xs"
                        color="warning"
                        variant="soft"
                        icon="i-heroicons-arrow-path-rounded-square"
                        class="font-bold"
                        :loading="promoting"
                        @click="
                          () => {
                            void promoteWorkout()
                          }
                        "
                      >
                        {{ t('version_promote_button') }}
                      </UButton>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Case 2: This is the original, but has duplicates -->
              <div v-else-if="workout.duplicates && workout.duplicates.length > 0">
                <div class="flex items-start gap-3 mb-4">
                  <UIcon
                    name="i-heroicons-document-duplicate"
                    class="w-6 h-6 text-blue-600 dark:text-blue-400 flex-shrink-0"
                  />
                  <div>
                    <h3 class="font-black text-gray-900 dark:text-white uppercase tracking-tight">
                      {{ t('version_linked_duplicates') }}
                    </h3>
                    <p class="text-sm text-gray-600 dark:text-gray-400 mt-1 font-medium">
                      {{ t('version_linked_desc') }}
                    </p>
                  </div>
                </div>

                <div class="space-y-2">
                  <div
                    v-for="dup in workout.duplicates"
                    :key="dup.id"
                    class="p-3 bg-gray-50 dark:bg-gray-900/50 rounded-xl border border-gray-100 dark:border-gray-800"
                  >
                    <div
                      class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4"
                    >
                      <NuxtLink
                        :to="`/workouts/${dup.id}`"
                        class="block min-w-0 flex-1 hover:opacity-90 transition-opacity"
                      >
                        <div
                          class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4"
                        >
                          <div class="min-w-0 flex-1">
                            <div
                              class="font-black text-gray-900 dark:text-white truncate uppercase tracking-tight"
                            >
                              {{ dup.title }}
                            </div>
                            <div
                              class="text-[10px] text-gray-500 mt-1 font-bold uppercase tracking-widest"
                            >
                              {{ formatDate(dup.date) }}
                            </div>
                          </div>
                          <div
                            class="flex items-center justify-between sm:justify-end gap-4 shrink-0"
                          >
                            <UBadge
                              color="warning"
                              variant="subtle"
                              size="xs"
                              class="font-bold uppercase tracking-widest"
                              >{{ t('sections_duplicates') }}</UBadge
                            >
                            <div class="flex justify-end">
                              <UiDataAttribution
                                v-if="
                                  [
                                    'strava',
                                    'garmin',
                                    'zwift',
                                    'apple_health',
                                    'whoop',
                                    'intervals',
                                    'withings',
                                    'hevy'
                                  ].includes(dup.source)
                                "
                                :provider="dup.source"
                                :device-name="dup.deviceName"
                                mode="minimal"
                              />
                              <span
                                v-else
                                :class="getSourceBadgeClass(dup.source)"
                                class="py-0 px-1.5 text-[10px]"
                              >
                                {{ getWorkoutSourceLabel(dup, t) }}
                              </span>
                            </div>
                            <UIcon name="i-heroicons-arrow-right" class="w-4 h-4 text-gray-400" />
                          </div>
                        </div>
                      </NuxtLink>

                      <UButton
                        size="xs"
                        color="warning"
                        variant="soft"
                        icon="i-heroicons-link-slash"
                        class="font-bold shrink-0"
                        :loading="unlinkingDuplicateId === dup.id"
                        @click="
                          () => {
                            void openDuplicateUnlinkConfirm(dup.id, dup.title)
                          }
                        "
                      >
                        Unlink
                      </UButton>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Linked Planned Workout -->
              <div
                v-if="workout.plannedWorkout"
                class="mt-6 pt-6 border-t border-gray-100 dark:border-gray-800"
              >
                <div class="flex items-start gap-3 mb-4">
                  <UIcon
                    name="i-heroicons-calendar"
                    class="w-6 h-6 text-primary-600 dark:text-primary-400 flex-shrink-0"
                  />
                  <div>
                    <h3 class="font-black text-gray-900 dark:text-white uppercase tracking-tight">
                      {{ t('version_prescribed_plan') }}
                    </h3>
                    <p class="text-sm text-gray-600 dark:text-gray-400 mt-1 font-medium">
                      {{ t('version_prescribed_desc') }}
                    </p>
                  </div>
                </div>

                <NuxtLink
                  :to="`/workouts/planned/${workout.plannedWorkout.id}`"
                  class="block p-4 bg-primary-50 dark:bg-primary-950/20 rounded-xl border border-primary-100 dark:border-primary-900/50 hover:border-primary-500 dark:hover:border-primary-500 transition-all shadow-sm"
                >
                  <div
                    class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4"
                  >
                    <div class="min-w-0 flex-1">
                      <div
                        class="font-black text-gray-900 dark:text-white uppercase tracking-tight"
                      >
                        {{ workout.plannedWorkout.title }}
                      </div>
                      <div
                        class="text-[10px] text-gray-500 mt-1 flex items-center gap-2 font-bold uppercase tracking-widest"
                      >
                        {{ formatDateUTC(workout.plannedWorkout.date) }}
                        <span
                          v-if="workout.plannedWorkout.type"
                          class="px-1.5 py-0 rounded bg-gray-100 dark:bg-gray-700 text-[10px] font-black uppercase tracking-widest"
                        >
                          {{ workout.plannedWorkout.type }}
                        </span>
                      </div>
                    </div>
                    <div class="flex items-center justify-between sm:justify-end gap-2 shrink-0">
                      <UBadge
                        color="primary"
                        variant="solid"
                        size="xs"
                        class="font-black uppercase tracking-widest"
                        >{{ t('legend_plan') }}</UBadge
                      >
                      <UIcon name="i-heroicons-arrow-right" class="w-4 h-4 text-gray-400" />
                    </div>
                  </div>
                </NuxtLink>
              </div>
            </div>
          </div>

          <div
            v-if="shouldRenderSection('raw-data')"
            id="raw-data"
            class="scroll-mt-20 space-y-4"
            :style="sectionStyle('raw-data')"
          >
            <h2 class="text-base font-black uppercase tracking-widest text-gray-400 px-5 sm:px-0">
              {{ t('raw_data_header') }}
            </h2>
            <JsonViewer
              title="Raw Data (JSON)"
              :data="workout.rawJson"
              filename="workout-raw.json"
            />
          </div>

          <div
            v-if="workout.llmUsageId"
            class="flex justify-end px-5 pt-8 pb-2 sm:px-0 border-t border-gray-100 dark:border-gray-800"
          >
            <AiFeedback
              :llm-usage-id="workout.llmUsageId"
              :initial-feedback="workout.feedback"
              :initial-feedback-text="workout.feedbackText"
            />
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <!-- Metric Detail Modal -->
  <WorkoutsMetricDetailModal
    v-if="activeMetric"
    v-model="isMetricModalOpen"
    :metric-key="activeMetric.key"
    :value="activeMetric.value"
    :unit="activeMetric.unit"
    :rating="activeMetric.rating"
    :rating-color="activeMetric.ratingColor"
    :workout-id="workout?.id"
    :streams="workout?.streams"
    :activity-type="workout?.type"
  />

  <WorkoutsWorkoutSectionsSettingsModal
    v-model:open="isWorkoutSectionsModalOpen"
    :sections="workoutSectionsModalOptions"
  />

  <!-- Promote Workout Confirmation Modal -->
  <UModal
    v-model:open="isPromoteModalOpen"
    :title="t('modal_promote_title')"
    :description="t('modal_promote_desc')"
  >
    <template #body>
      <div class="space-y-4">
        <div
          class="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg border border-yellow-200 dark:border-yellow-800"
        >
          <div class="flex items-start gap-3">
            <UIcon
              name="i-heroicons-exclamation-triangle"
              class="w-6 h-6 text-yellow-600 dark:text-yellow-400 flex-shrink-0"
            />
            <div>
              <h3 class="font-semibold text-yellow-900 dark:text-yellow-100">
                {{ t('modal_promote_sure') }}
              </h3>
              <p class="text-sm text-yellow-800 dark:text-yellow-200 mt-1">
                {{ t('modal_promote_action_desc') }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          :label="t('banner_exit')"
          color="neutral"
          variant="ghost"
          @click="
            () => {
              isPromoteModalOpen = false
            }
          "
        />
        <UButton
          :label="t('modal_promote_confirm')"
          color="warning"
          variant="solid"
          :loading="promoting"
          @click="
            () => {
              void confirmPromoteWorkout()
            }
          "
        />
      </div>
    </template>
  </UModal>

  <!-- Share Modal -->
  <UModal
    v-model:open="isShareModalOpen"
    :title="t('modal_share_title')"
    :description="t('modal_share_desc')"
  >
    <template #body>
      <ShareAccessPanel
        :link="shareLink"
        :loading="generatingShareLink"
        :expiry-value="shareExpiryValue"
        resource-label="workout"
        :share-title="
          workout?.title ? `Workout: ${workout.title}` : 'Workout shared from Coach Watts'
        "
        @update:expiry-value="shareExpiryValue = $event"
        @generate="generateShareLink"
        @copy="copyToClipboard"
      />
    </template>
    <template #footer>
      <UButton
        :label="t('banner_exit')"
        color="neutral"
        variant="ghost"
        @click="
          () => {
            isShareModalOpen = false
          }
        "
      />
    </template>
  </UModal>

  <!-- Stream Chart Modal -->
  <StreamChartModal
    v-if="selectedStream"
    v-model:open="isStreamModalOpen"
    :workout-id="workout?.id"
    :stream-key="selectedStream.key"
    :title="selectedStream.label"
    :color="selectedStream.color"
    :unit="selectedStream.unit"
    :activity-type="workout?.type"
  />

  <!-- Extras Meta Modal -->
  <UModal
    v-model:open="isExtrasMetaModalOpen"
    :title="t('modal_extras_title')"
    :description="t('modal_extras_desc')"
    :ui="{ content: 'max-w-5xl' }"
  >
    <template #body>
      <JsonViewer
        v-if="extrasMetaData"
        title="FIT extrasMeta"
        :data="extrasMetaData"
        :deep="2"
        :default-open="true"
        filename="fit-extras-meta.json"
      />
      <div v-else class="text-sm text-gray-500 py-4">{{ t('modal_extras_empty') }}</div>
    </template>
    <template #footer>
      <UButton
        :label="t('banner_exit')"
        color="neutral"
        variant="ghost"
        @click="
          () => {
            isExtrasMetaModalOpen = false
          }
        "
      />
    </template>
  </UModal>

  <!-- Edit Workout Modal -->
  <WorkoutsEditModal
    v-if="workout"
    v-model:open="isEditModalOpen"
    :workout="workout"
    @updated="fetchWorkout"
    @delete="onDeleteRequested"
  />

  <!-- Delete Confirmation Modal -->
  <UModal
    v-model:open="isDeleteModalOpen"
    :title="t('modal_delete_title')"
    :description="t('modal_delete_desc')"
  >
    <template #body>
      <div class="space-y-4">
        <div
          class="bg-red-50 dark:bg-red-900/20 p-4 rounded-lg border border-red-200 dark:border-red-800"
        >
          <div class="flex items-start gap-3">
            <UIcon
              name="i-heroicons-exclamation-triangle"
              class="w-6 h-6 text-red-600 dark:text-red-400 flex-shrink-0"
            />
            <div>
              <h3 class="font-semibold text-red-900 dark:text-red-100">
                {{ t('modal_delete_sure') }}
              </h3>
              <p class="text-sm text-red-800 dark:text-red-200 mt-1">
                {{ t('modal_delete_action_desc') }}
              </p>
            </div>
          </div>
        </div>

        <div
          v-if="shouldShowSyncSourceNote(workout)"
          class="bg-orange-50 dark:bg-orange-900/20 p-4 rounded-lg border border-orange-200 dark:border-orange-800"
        >
          <div class="flex items-start gap-3">
            <UIcon
              name="i-heroicons-arrow-path"
              class="w-6 h-6 text-orange-600 dark:text-orange-400 flex-shrink-0"
            />
            <div>
              <h3
                class="font-semibold text-orange-900 dark:text-orange-100 uppercase tracking-tight text-xs"
              >
                {{ t('modal_delete_sync_note_title') }}
              </h3>
              <p class="text-xs text-orange-800 dark:text-orange-200 mt-1">
                {{
                  t('modal_delete_sync_note_desc', {
                    source: getWorkoutSourceLabel(workout)
                  })
                }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          :label="t('banner_exit')"
          color="neutral"
          variant="ghost"
          @click="
            () => {
              isDeleteModalOpen = false
            }
          "
        />
        <UButton
          :label="t('controls_delete')"
          color="error"
          :loading="deleting"
          @click="
            () => {
              void deleteWorkout()
            }
          "
        />
      </div>
    </template>
  </UModal>

  <UModal
    v-model:open="isDuplicateUnlinkModalOpen"
    title="Unlink Duplicate Workout"
    :description="
      duplicateUnlinkTargetName
        ? `Remove the duplicate link for ${duplicateUnlinkTargetName}? Both workouts will remain in your history as separate activities.`
        : 'Remove this duplicate link? Both workouts will remain in your history as separate activities.'
    "
  >
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          @click="
            () => {
              isDuplicateUnlinkModalOpen = false
            }
          "
        >
          Cancel
        </UButton>
        <UButton
          color="warning"
          :loading="Boolean(unlinkingDuplicateId)"
          @click="
            () => {
              void unlinkDuplicateWorkout()
            }
          "
        >
          Unlink
        </UButton>
      </div>
    </template>
  </UModal>

  <WorkoutsWorkoutComparisonDock />
</template>

<script setup lang="ts">
  import { useNow } from '@vueuse/core'
  import { nextTick } from 'vue'
  import { useTranslate } from '@tolgee/vue'
  import { marked } from 'marked'
  import PlanAdherence from '~/components/workouts/PlanAdherence.vue'
  import StreamChartModal from '~/components/charts/streams/StreamChartModal.vue'
  import { getWorkoutSourceLabel } from '~/utils/workout-source'
  import { metricTooltips } from '~/utils/tooltips'
  import { getAnalysisStatusClass } from '~/utils/analysis-status'
  import {
    convertElevation,
    formatDistance as formatDist,
    formatElevation as formatElev,
    formatTemperature,
    getElevationUnitLabel,
    getVelocityUnitLabel,
    isRideWorkoutType
  } from '~/utils/metrics'

  const { t } = useTranslate('workout')
  const { t: tt } = useTranslate('workout-tooltips')

  const { formatDate: baseFormatDate, formatDateTime, formatDateUTC, formatTime } = useFormat()
  const { trackWorkoutViewDetail, trackWorkoutSectionView } = useAnalytics()
  const isPageActive = ref(true)

  type WorkoutSectionKey =
    | 'overview'
    | 'training-impact'
    | 'exercises'
    | 'nutrition'
    | 'analysis'
    | 'power-curve'
    | 'intervals'
    | 'advanced'
    | 'map'
    | 'pacing'
    | 'timeline'
    | 'zones'
    | 'efficiency'
    | 'notes'
    | 'metrics'
    | 'streams'
    | 'duplicates'
    | 'raw-data'

  interface WorkoutSectionSettings {
    [key: string]: {
      visible: boolean
      order: number
    }
  }

  definePageMeta({
    middleware: 'auth'
  })

  const route = useRoute()
  const router = useRouter()
  const toast = useToast()
  const config = useRuntimeConfig()
  const { showQuotaPaywall, getOperationQuota, isQuotaExhausted } = useQuotaPaywall()
  const workoutAnalysisQuota = ref<any>(null)
  const comparisonStore = useWorkoutComparisonStore()
  const userStore = useUserStore()
  const nutritionEnabled = computed(
    () =>
      userStore.profile?.nutritionTrackingEnabled !== false &&
      userStore.user?.nutritionTrackingEnabled !== false
  )

  const workout = ref<any>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  const deferredSectionsReady = ref(false)
  let deferredSectionsTimer: ReturnType<typeof setTimeout> | null = null
  const savingTags = ref(false)
  const showTagEditor = ref(false)
  const analysisFactsOpen = ref(false)
  const quotaClock = useNow({ interval: 30_000 })
  const canAnalyzeNowAfterQuotaReset = computed(() => {
    if (workout.value?.aiAnalysisStatus !== 'QUOTA_EXCEEDED') return false
    if (!workoutAnalysisQuota.value) return false
    return !isQuotaExhausted(workoutAnalysisQuota.value, quotaClock.value)
  })

  async function refreshWorkoutAnalysisQuota() {
    if (workout.value?.aiAnalysisStatus === 'QUOTA_EXCEEDED') {
      workoutAnalysisQuota.value = await getOperationQuota('workout_analysis')
    }
  }

  async function openWorkoutQuotaUpgrade() {
    await showQuotaPaywall({
      operation: 'workout_analysis',
      title: 'Unlock Workout Analysis',
      featureTitle: 'Workout Analysis',
      reason: 'quota_skipped_workout',
      quota: workoutAnalysisQuota.value
    })
  }

  watch(
    () => workout.value?.aiAnalysisStatus,
    () => {
      void refreshWorkoutAnalysisQuota()
    },
    { immediate: true }
  )
  const analyzingWorkout = ref(false)
  const analyzingAdherence = ref(false)
  const unlinkingPlannedWorkout = ref(false)
  const promoting = ref(false)
  const deleting = ref(false)
  const publishingSummary = ref(false)
  const savingToLibrary = ref(false)
  const unlinkingDuplicateId = ref<string | null>(null)

  const isPromoteModalOpen = ref(false)
  const isShareModalOpen = ref(false)
  const isExtrasMetaModalOpen = ref(false)
  const isWorkoutSectionsModalOpen = ref(false)
  const isDuplicateUnlinkModalOpen = ref(false)
  const shareExpiryValue = ref('never')
  const duplicateUnlinkTargetId = ref<string | null>(null)
  const duplicateUnlinkTargetName = ref('')

  const stomachFeel = ref<number | null>(null)

  function isWorkoutInComparison(workoutId?: string | null) {
    return workoutId ? comparisonStore.isSelected(workoutId) : false
  }

  function toggleWorkoutComparison() {
    if (!workout.value?.id) return

    comparisonStore.toggleWorkout({
      id: workout.value.id,
      title: workout.value.title || 'Workout',
      type: workout.value.type || null,
      date: workout.value.date || null,
      athleteName: userStore.profile?.name || userStore.user?.email || 'Athlete'
    })

    toast.add({
      title: comparisonStore.isSelected(workout.value.id)
        ? 'Workout added to comparison'
        : 'Workout removed from comparison',
      color: 'success'
    })
  }

  const { shareLink, generatingShareLink, generateShareLink } = useResourceShare(
    'WORKOUT',
    computed(() => workout.value?.id)
  )

  const copyToClipboard = () => {
    if (!shareLink.value) return
    if (import.meta.client) {
      navigator.clipboard.writeText(shareLink.value)
      toast.add({
        title: 'Copied',
        description: 'Link copied to clipboard.',
        color: 'success'
      })
    }
  }

  watch(isShareModalOpen, (newValue) => {
    if (newValue && !shareLink.value) {
      generateShareLink()
    }
  })

  const renderedAnalysis = computed(() => {
    if (!workout.value?.aiAnalysis) return ''
    return marked(workout.value.aiAnalysis)
  })

  const analysisFacts = computed(() => workout.value?.analysisFacts || null)
  const analysisFactsV2 = computed(() => workout.value?.analysisFactsV2 || null)
  const hasAnalysisFactsPanel = computed(() =>
    Boolean(analysisFactsV2.value || analysisFacts.value)
  )
  const analysisFactsVersionLabel = computed(() => (analysisFactsV2.value ? 'v2' : 'v1'))
  const analysisFactTooltips: Record<string, string> = {
    rpe: 'The athlete-reported intensity of the full session on the RPE scale.',
    sessionRpeLoad:
      'Session RPE multiplied by duration in minutes. This reflects total subjective toll, not a heart-rate zone.',
    subjectiveObjectiveGap:
      'How far the athlete’s subjective load diverges from objective load markers like TSS or training load.',
    musculoskeletalToll:
      'Estimated impact and tissue stress from the session, especially useful for running and strength work.',
    impactProfile:
      'Baseline mechanical impact expectation for the sport, used to contextualize subjective load.',
    analysisMode:
      'Which signal family should lead interpretation for this workout: power, pace, RPE, or a mixed view.',
    hrUsable:
      'Whether heart-rate telemetry is trustworthy enough to support physiological conclusions.',
    hrZeroRatio:
      'Share of HR samples that were literal zero values, which are treated as invalid telemetry.',
    hrMissingRatio:
      'Share of HR samples that were missing or invalid, indicating unreliable heart-rate coverage.',
    hrArtifactFlag:
      'True when the heart-rate stream shows enough placeholder or invalid data to treat it as artifact-prone.',
    powerSourceType:
      'Whether power is treated as direct measured mechanical power, estimated/modelled power, or unknown.',
    powerAbsoluteUsable:
      'Whether the absolute power number is reliable enough to use as a benchmark, not just a relative trend.',
    powerRelativeUsable:
      'Whether available power can still be used for within-athlete trend tracking even if absolute accuracy is uncertain.',
    lrBalanceUsable:
      'Whether left/right balance can be interpreted safely after checking source semantics and possible channel issues.',
    normalHrLagExpected:
      'Whether delayed HR response should be expected physiologically for this workout type and effort profile.',
    normalHrLagDetected:
      'Whether the workout shows a normal delayed HR rise after power or pace increases rather than a sensor problem.',
    steadyStateSegmentsAvailable:
      'Whether there is enough sustained steady work after warm-up to support durability-style physiology checks.',
    warmupExcludedMinutes:
      'Minutes excluded from decoupling logic so warm-up kinetics do not create false positives.',
    decouplingValid:
      'Whether decoupling should be interpreted at all for this session based on duration and telemetry quality.',
    decouplingEffective:
      'The effective post-warm-up decoupling value used for debugging. Negative values can indicate efficiency gain.',
    decouplingDirection:
      'Classifies the session as positive drift, stable, or efficiency gain after excluding the warm-up phase.',
    decouplingConfidence:
      'Confidence in the decoupling reading based on workout duration and signal quality.',
    sourceSemantics:
      'Describes what the L/R balance channels likely represent: true left/right legs, human-vs-motor, or unknown.',
    inversionSuspected:
      'True when the balance channels appear reversed and need correction before interpretation.',
    correctedLeftPct:
      'Left-side percentage after any sanity correction or inversion handling has been applied.',
    correctedRightPct:
      'Right-side percentage after any sanity correction or inversion handling has been applied.',
    interpretationMode:
      'Whether L/R balance is used normally, corrected first, or disabled entirely.',
    correctionReason: 'Short explanation for why L/R interpretation was corrected or disabled.',
    detected:
      'Whether ERG mode was detected from explicit metadata or a strong inferred trainer-control signature.',
    confidence:
      'Confidence level for the current diagnostic group, especially ERG and decoupling inference.',
    source:
      'Whether the ERG inference came from explicit metadata, heuristic inference, or remains unknown.',
    powerControlMode:
      'The likely trainer control mode: ERG, resistance/slope-style control, free ride, or unknown.',
    reasons: 'Short reasons explaining why the system inferred the current ERG status.',
    computedFrom: 'Inputs used to compute this fact payload for the current workout.',
    unavailableInputs: 'Inputs that were missing, so some facts may be downgraded or unavailable.',
    disabledInterpretations:
      'Interpretations intentionally suppressed because the available data is not trustworthy enough.',
    primaryArchetype: 'High-level workout intent classification used to drive the AI analysis.',
    executionEnvironment:
      'Execution environment determines whether pacing is athlete-driven, trainer-enforced, or treadmill-based.',
    primaryMetric:
      'The primary metric the AI should prioritize for interpreting execution quality.',
    sessionSteadiness:
      'Describes whether the session is steady, rolling, stochastic, or interval-based.',
    hrArtifactSeverity: 'How severe the HR telemetry artifacts are if present.',
    paceUsable: 'Whether pace should be trusted as a meaningful execution signal.',
    gpsConfidence: 'Confidence in pace/GPS interpretation, mainly for running-style sessions.',
    suppressions: 'Signals the AI is explicitly instructed not to interpret from this workout.',
    planLinked: 'Whether this workout was linked to a planned session.',
    adherenceAssessable:
      'Whether planned-vs-actual adherence can be scored defensibly with the available data.',
    adherenceReason: 'Explanation for why adherence is or is not assessable.',
    completionPct: 'Compact summary of how much of the planned session was completed.',
    durationVsPlanPct: 'Actual duration as a percentage of planned duration.',
    workIntervalHitRate:
      'Percentage of planned work intervals that landed near their intended target.',
    recoveryHitRate: 'Percentage of planned recovery intervals that matched the expected target.',
    targetOvershootPct:
      'Average amount the athlete overshot planned targets when they went too hard.',
    targetUndershootPct:
      'Average amount the athlete undershot planned targets when they went too easy.',
    structureMatched:
      'Whether the actual session structure resembled the planned work/recovery pattern.',
    executionClassification:
      'High-level classification of how the session was executed relative to the plan.',
    decouplingInterpretable: 'Whether classic decoupling is valid to discuss for this workout.',
    decouplingReason: 'Explanation for why classic decoupling was suppressed or allowed.',
    lateSessionFadePct:
      'Late-session change in the primary workload signal, used as a durability marker.',
    firstVsLastIntervalDeltaPct:
      'Change between the first and last hard interval, used as a repeatability signal.',
    recoveryTrendScore: 'Normalized score for short-term recovery behavior between efforts.',
    executionStabilityScore:
      'Normalized score for how consistently the athlete delivered the session.',
    repeatabilityScore: 'Normalized score for interval-to-interval repeatability.',
    dominantPowerZone: 'Power zone containing the largest share of the session.',
    dominantHrZone: 'Heart-rate zone containing the largest share of the session.',
    timeAboveThresholdPct: 'Share of the session spent above threshold-like intensity bins.',
    cadenceDriftPct: 'Change in cadence between early and late parts of the session.',
    cadenceStabilityScore: 'Normalized score for cadence consistency.',
    torqueProfile: 'Simple cadence-based characterization of pedaling style for cycling workouts.',
    pacingDriftPct: 'Change in running pace/speed between early and late parts of the session.',
    suppressedMetrics: 'Metrics intentionally hidden from AI interpretation for safety.',
    overallConfidence: 'Confidence level for the entire v2 fact payload.'
  }

  const analysisFactsGroups = computed(() => {
    if (analysisFactsV2.value) {
      return [
        {
          key: 'guardrails',
          label: 'Guardrails',
          entries: [
            {
              key: 'analysisMode',
              path: 'guardrails.analysisMode',
              label: 'Analysis Mode',
              value: analysisFactsV2.value.guardrails.analysisMode
            },
            {
              key: 'primaryArchetype',
              path: 'guardrails.archetype.primaryArchetype',
              label: 'Primary Archetype',
              value: analysisFactsV2.value.guardrails.archetype.primaryArchetype
            },
            {
              key: 'executionEnvironment',
              path: 'guardrails.archetype.executionEnvironment',
              label: 'Execution Environment',
              value: analysisFactsV2.value.guardrails.archetype.executionEnvironment
            },
            {
              key: 'primaryMetric',
              path: 'guardrails.archetype.primaryMetric',
              label: 'Primary Metric',
              value: analysisFactsV2.value.guardrails.archetype.primaryMetric
            },
            {
              key: 'sessionSteadiness',
              path: 'guardrails.archetype.sessionSteadiness',
              label: 'Session Steadiness',
              value: analysisFactsV2.value.guardrails.archetype.sessionSteadiness
            },
            {
              key: 'hrUsable',
              path: 'guardrails.telemetry.hrUsable',
              label: 'HR Usable',
              value: analysisFactsV2.value.guardrails.telemetry.hrUsable
            },
            {
              key: 'hrArtifactSeverity',
              path: 'guardrails.telemetry.hrArtifactSeverity',
              label: 'HR Artifact Severity',
              value: analysisFactsV2.value.guardrails.telemetry.hrArtifactSeverity
            },
            {
              key: 'powerSourceType',
              path: 'guardrails.telemetry.powerSourceType',
              label: 'Power Source Type',
              value: analysisFactsV2.value.guardrails.telemetry.powerSourceType
            },
            {
              key: 'paceUsable',
              path: 'guardrails.telemetry.paceUsable',
              label: 'Pace Usable',
              value: analysisFactsV2.value.guardrails.telemetry.paceUsable
            },
            {
              key: 'gpsConfidence',
              path: 'guardrails.telemetry.gpsConfidence',
              label: 'GPS Confidence',
              value: analysisFactsV2.value.guardrails.telemetry.gpsConfidence
            },
            {
              key: 'lrBalanceUsable',
              path: 'guardrails.telemetry.lrBalanceUsable',
              label: 'L/R Balance Usable',
              value: analysisFactsV2.value.guardrails.telemetry.lrBalanceUsable
            },
            {
              key: 'detected',
              path: 'guardrails.erg.detected',
              label: 'ERG Detected',
              value: analysisFactsV2.value.guardrails.erg.detected
            },
            {
              key: 'powerControlMode',
              path: 'guardrails.erg.powerControlMode',
              label: 'Power Control Mode',
              value: analysisFactsV2.value.guardrails.erg.powerControlMode
            },
            {
              key: 'suppressions',
              path: 'guardrails.suppressions',
              label: 'Suppressions',
              value: analysisFactsV2.value.guardrails.suppressions
            }
          ]
        },
        {
          key: 'adherence',
          label: 'Adherence',
          entries: [
            {
              key: 'planLinked',
              path: 'adherence.planLinked',
              label: 'Plan Linked',
              value: analysisFactsV2.value.adherence.planLinked
            },
            {
              key: 'adherenceAssessable',
              path: 'adherence.adherenceAssessable',
              label: 'Adherence Assessable',
              value: analysisFactsV2.value.adherence.adherenceAssessable
            },
            {
              key: 'adherenceReason',
              path: 'adherence.adherenceReason',
              label: 'Adherence Reason',
              value: analysisFactsV2.value.adherence.adherenceReason
            },
            {
              key: 'completionPct',
              path: 'adherence.completionPct',
              label: 'Completion %',
              value: analysisFactsV2.value.adherence.completionPct
            },
            {
              key: 'durationVsPlanPct',
              path: 'adherence.durationVsPlanPct',
              label: 'Duration vs Plan %',
              value: analysisFactsV2.value.adherence.durationVsPlanPct
            },
            {
              key: 'workIntervalHitRate',
              path: 'adherence.workIntervalHitRate',
              label: 'Work Interval Hit Rate',
              value: analysisFactsV2.value.adherence.workIntervalHitRate
            },
            {
              key: 'recoveryHitRate',
              path: 'adherence.recoveryHitRate',
              label: 'Recovery Hit Rate',
              value: analysisFactsV2.value.adherence.recoveryHitRate
            },
            {
              key: 'targetOvershootPct',
              path: 'adherence.targetOvershootPct',
              label: 'Target Overshoot %',
              value: analysisFactsV2.value.adherence.targetOvershootPct
            },
            {
              key: 'targetUndershootPct',
              path: 'adherence.targetUndershootPct',
              label: 'Target Undershoot %',
              value: analysisFactsV2.value.adherence.targetUndershootPct
            },
            {
              key: 'structureMatched',
              path: 'adherence.structureMatched',
              label: 'Structure Matched',
              value: analysisFactsV2.value.adherence.structureMatched
            },
            {
              key: 'executionClassification',
              path: 'adherence.executionClassification',
              label: 'Execution Classification',
              value: analysisFactsV2.value.adherence.executionClassification
            }
          ]
        },
        {
          key: 'performanceSignals',
          label: 'Performance Signals',
          entries: [
            {
              key: 'decouplingInterpretable',
              path: 'performanceSignals.decoupling.interpretable',
              label: 'Decoupling Interpretable',
              value: analysisFactsV2.value.performanceSignals.decoupling.interpretable
            },
            {
              key: 'decouplingReason',
              path: 'performanceSignals.decoupling.reason',
              label: 'Decoupling Reason',
              value: analysisFactsV2.value.performanceSignals.decoupling.reason
            },
            {
              key: 'decouplingEffective',
              path: 'performanceSignals.decoupling.effective',
              label: 'Decoupling Effective',
              value: analysisFactsV2.value.performanceSignals.decoupling.effective
            },
            {
              key: 'decouplingDirection',
              path: 'performanceSignals.decoupling.direction',
              label: 'Decoupling Direction',
              value: analysisFactsV2.value.performanceSignals.decoupling.direction
            },
            {
              key: 'lateSessionFadePct',
              path: 'performanceSignals.durability.lateSessionFadePct',
              label: 'Late Session Fade %',
              value: analysisFactsV2.value.performanceSignals.durability.lateSessionFadePct
            },
            {
              key: 'firstVsLastIntervalDeltaPct',
              path: 'performanceSignals.durability.firstVsLastIntervalDeltaPct',
              label: 'First vs Last Interval Delta %',
              value: analysisFactsV2.value.performanceSignals.durability.firstVsLastIntervalDeltaPct
            },
            {
              key: 'recoveryTrendScore',
              path: 'performanceSignals.durability.recoveryTrendScore',
              label: 'Recovery Trend Score',
              value: analysisFactsV2.value.performanceSignals.durability.recoveryTrendScore
            },
            {
              key: 'executionStabilityScore',
              path: 'performanceSignals.durability.executionStabilityScore',
              label: 'Execution Stability Score',
              value: analysisFactsV2.value.performanceSignals.durability.executionStabilityScore
            },
            {
              key: 'repeatabilityScore',
              path: 'performanceSignals.durability.repeatabilityScore',
              label: 'Repeatability Score',
              value: analysisFactsV2.value.performanceSignals.durability.repeatabilityScore
            },
            {
              key: 'dominantPowerZone',
              path: 'performanceSignals.zones.dominantPowerZone',
              label: 'Dominant Power Zone',
              value: analysisFactsV2.value.performanceSignals.zones.dominantPowerZone
            },
            {
              key: 'dominantHrZone',
              path: 'performanceSignals.zones.dominantHrZone',
              label: 'Dominant HR Zone',
              value: analysisFactsV2.value.performanceSignals.zones.dominantHrZone
            },
            {
              key: 'timeAboveThresholdPct',
              path: 'performanceSignals.zones.timeAboveThresholdPct',
              label: 'Time Above Threshold %',
              value: analysisFactsV2.value.performanceSignals.zones.timeAboveThresholdPct
            },
            {
              key: 'cadenceDriftPct',
              path: 'performanceSignals.sportSpecific.cadenceDriftPct',
              label: 'Cadence Drift %',
              value: analysisFactsV2.value.performanceSignals.sportSpecific.cadenceDriftPct
            },
            {
              key: 'cadenceStabilityScore',
              path: 'performanceSignals.sportSpecific.cadenceStabilityScore',
              label: 'Cadence Stability Score',
              value: analysisFactsV2.value.performanceSignals.sportSpecific.cadenceStabilityScore
            },
            {
              key: 'torqueProfile',
              path: 'performanceSignals.sportSpecific.torqueProfile',
              label: 'Torque Profile',
              value: analysisFactsV2.value.performanceSignals.sportSpecific.torqueProfile
            },
            {
              key: 'pacingDriftPct',
              path: 'performanceSignals.sportSpecific.pacingDriftPct',
              label: 'Pacing Drift %',
              value: analysisFactsV2.value.performanceSignals.sportSpecific.pacingDriftPct
            }
          ]
        },
        {
          key: 'confidence',
          label: 'Confidence',
          entries: [
            {
              key: 'overallConfidence',
              path: 'confidence.overall',
              label: 'Overall Confidence',
              value: analysisFactsV2.value.confidence.overall
            },
            {
              key: 'computedFrom',
              path: 'confidence.debugMeta.computedFrom',
              label: 'Computed From',
              value: analysisFactsV2.value.confidence.debugMeta.computedFrom
            },
            {
              key: 'unavailableInputs',
              path: 'confidence.debugMeta.unavailableInputs',
              label: 'Unavailable Inputs',
              value: analysisFactsV2.value.confidence.debugMeta.unavailableInputs
            },
            {
              key: 'suppressedMetrics',
              path: 'confidence.debugMeta.suppressedMetrics',
              label: 'Suppressed Metrics',
              value: analysisFactsV2.value.confidence.debugMeta.suppressedMetrics
            }
          ]
        }
      ]
    }

    if (!analysisFacts.value) return []

    return [
      {
        key: 'subjective',
        label: 'Subjective',
        entries: [
          {
            key: 'rpe',
            path: 'subjective.rpe',
            label: 'RPE',
            value: analysisFacts.value.subjective.rpe
          },
          {
            key: 'sessionRpeLoad',
            path: 'subjective.sessionRpeLoad',
            label: 'Session RPE Load',
            value: analysisFacts.value.subjective.sessionRpeLoad
          },
          {
            key: 'subjectiveObjectiveGap',
            path: 'subjective.subjectiveObjectiveGap',
            label: 'Subjective vs Objective Gap',
            value: analysisFacts.value.subjective.subjectiveObjectiveGap
          },
          {
            key: 'musculoskeletalToll',
            path: 'subjective.musculoskeletalToll',
            label: 'Musculoskeletal Toll',
            value: analysisFacts.value.subjective.musculoskeletalToll
          },
          {
            key: 'impactProfile',
            path: 'subjective.impactProfile',
            label: 'Impact Profile',
            value: analysisFacts.value.subjective.impactProfile
          }
        ]
      },
      {
        key: 'telemetry',
        label: 'Telemetry',
        entries: [
          {
            key: 'analysisMode',
            path: 'telemetry.analysisMode',
            label: 'Analysis Mode',
            value: analysisFacts.value.telemetry.analysisMode
          },
          {
            key: 'hrUsable',
            path: 'telemetry.hrUsable',
            label: 'HR Usable',
            value: analysisFacts.value.telemetry.hrUsable
          },
          {
            key: 'hrZeroRatio',
            path: 'telemetry.hrZeroRatio',
            label: 'HR Zero Ratio',
            value: analysisFacts.value.telemetry.hrZeroRatio
          },
          {
            key: 'hrMissingRatio',
            path: 'telemetry.hrMissingRatio',
            label: 'HR Missing Ratio',
            value: analysisFacts.value.telemetry.hrMissingRatio
          },
          {
            key: 'hrArtifactFlag',
            path: 'telemetry.hrArtifactFlag',
            label: 'HR Artifact Flag',
            value: analysisFacts.value.telemetry.hrArtifactFlag
          },
          {
            key: 'powerSourceType',
            path: 'telemetry.powerSourceType',
            label: 'Power Source Type',
            value: analysisFacts.value.telemetry.powerSourceType
          },
          {
            key: 'powerAbsoluteUsable',
            path: 'telemetry.powerAbsoluteUsable',
            label: 'Power Absolute Usable',
            value: analysisFacts.value.telemetry.powerAbsoluteUsable
          },
          {
            key: 'powerRelativeUsable',
            path: 'telemetry.powerRelativeUsable',
            label: 'Power Relative Usable',
            value: analysisFacts.value.telemetry.powerRelativeUsable
          },
          {
            key: 'lrBalanceUsable',
            path: 'telemetry.lrBalanceUsable',
            label: 'L/R Balance Usable',
            value: analysisFacts.value.telemetry.lrBalanceUsable
          }
        ]
      },
      {
        key: 'physiology',
        label: 'Physiology',
        entries: [
          {
            key: 'normalHrLagExpected',
            path: 'physiology.normalHrLagExpected',
            label: 'Normal HR Lag Expected',
            value: analysisFacts.value.physiology.normalHrLagExpected
          },
          {
            key: 'normalHrLagDetected',
            path: 'physiology.normalHrLagDetected',
            label: 'Normal HR Lag Detected',
            value: analysisFacts.value.physiology.normalHrLagDetected
          },
          {
            key: 'steadyStateSegmentsAvailable',
            path: 'physiology.steadyStateSegmentsAvailable',
            label: 'Steady-State Segments',
            value: analysisFacts.value.physiology.steadyStateSegmentsAvailable
          },
          {
            key: 'warmupExcludedMinutes',
            path: 'physiology.warmupExcludedMinutes',
            label: 'Warmup Excluded Minutes',
            value: analysisFacts.value.physiology.warmupExcludedMinutes
          },
          {
            key: 'decouplingValid',
            path: 'physiology.decouplingValid',
            label: 'Decoupling Valid',
            value: analysisFacts.value.physiology.decouplingValid
          },
          {
            key: 'decouplingEffective',
            path: 'physiology.decouplingEffective',
            label: 'Decoupling Effective',
            value: analysisFacts.value.physiology.decouplingEffective
          },
          {
            key: 'decouplingDirection',
            path: 'physiology.decouplingDirection',
            label: 'Decoupling Direction',
            value: analysisFacts.value.physiology.decouplingDirection
          },
          {
            key: 'decouplingConfidence',
            path: 'physiology.decouplingConfidence',
            label: 'Decoupling Confidence',
            value: analysisFacts.value.physiology.decouplingConfidence
          }
        ]
      },
      {
        key: 'lrBalance',
        label: 'L/R Balance',
        entries: [
          {
            key: 'sourceSemantics',
            path: 'lrBalance.sourceSemantics',
            label: 'Source Semantics',
            value: analysisFacts.value.lrBalance.sourceSemantics
          },
          {
            key: 'inversionSuspected',
            path: 'lrBalance.inversionSuspected',
            label: 'Inversion Suspected',
            value: analysisFacts.value.lrBalance.inversionSuspected
          },
          {
            key: 'correctedLeftPct',
            path: 'lrBalance.correctedLeftPct',
            label: 'Corrected Left %',
            value: analysisFacts.value.lrBalance.correctedLeftPct
          },
          {
            key: 'correctedRightPct',
            path: 'lrBalance.correctedRightPct',
            label: 'Corrected Right %',
            value: analysisFacts.value.lrBalance.correctedRightPct
          },
          {
            key: 'interpretationMode',
            path: 'lrBalance.interpretationMode',
            label: 'Interpretation Mode',
            value: analysisFacts.value.lrBalance.interpretationMode
          },
          {
            key: 'correctionReason',
            path: 'lrBalance.correctionReason',
            label: 'Correction Reason',
            value: analysisFacts.value.lrBalance.correctionReason
          }
        ]
      },
      {
        key: 'erg',
        label: 'ERG',
        entries: [
          {
            key: 'detected',
            path: 'erg.detected',
            label: 'Detected',
            value: analysisFacts.value.erg.detected
          },
          {
            key: 'confidence',
            path: 'erg.confidence',
            label: 'Confidence',
            value: analysisFacts.value.erg.confidence
          },
          {
            key: 'source',
            path: 'erg.source',
            label: 'Source',
            value: analysisFacts.value.erg.source
          },
          {
            key: 'powerControlMode',
            path: 'erg.powerControlMode',
            label: 'Power Control Mode',
            value: analysisFacts.value.erg.powerControlMode
          },
          {
            key: 'reasons',
            path: 'erg.reasons',
            label: 'Reasons',
            value: analysisFacts.value.erg.reasons
          }
        ]
      },
      {
        key: 'debugMeta',
        label: 'Debug Meta',
        entries: [
          {
            key: 'computedFrom',
            path: 'debugMeta.computedFrom',
            label: 'Computed From',
            value: analysisFacts.value.debugMeta.computedFrom
          },
          {
            key: 'unavailableInputs',
            path: 'debugMeta.unavailableInputs',
            label: 'Unavailable Inputs',
            value: analysisFacts.value.debugMeta.unavailableInputs
          },
          {
            key: 'disabledInterpretations',
            path: 'debugMeta.disabledInterpretations',
            label: 'Disabled Interpretations',
            value: analysisFacts.value.debugMeta.disabledInterpretations
          }
        ]
      }
    ]
  })

  function formatFactValue(value: unknown) {
    if (value === null || value === undefined || value === '') return 'Unavailable'
    if (typeof value === 'boolean') return value ? 'Yes' : 'No'
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'None'
    return String(value)
  }

  function getFactBadgeColor(value: boolean) {
    return value ? 'success' : 'warning'
  }

  function getSummaryBadgeColor(value: unknown) {
    return typeof value === 'boolean' ? getFactBadgeColor(value) : 'neutral'
  }

  const analysisFactsSummaryBadges = computed(() => {
    if (analysisFactsV2.value) {
      return [
        {
          key: 'hrUsable',
          label: 'HR Usable',
          value: analysisFactsV2.value.guardrails.telemetry.hrUsable
        },
        {
          key: 'primaryArchetype',
          label: 'Archetype',
          value: analysisFactsV2.value.guardrails.archetype.primaryArchetype
        },
        {
          key: 'executionClassification',
          label: 'Execution',
          value: analysisFactsV2.value.adherence.executionClassification
        },
        {
          key: 'decouplingInterpretable',
          label: 'Decoupling',
          value: analysisFactsV2.value.performanceSignals.decoupling.interpretable
        }
      ]
    }

    if (!analysisFacts.value) return []
    return [
      {
        key: 'hrUsable',
        label: 'HR Usable',
        value: analysisFacts.value.telemetry.hrUsable
      },
      {
        key: 'analysisMode',
        label: 'Analysis Mode',
        value: analysisFacts.value.telemetry.analysisMode
      },
      {
        key: 'lrMode',
        label: 'L/R Mode',
        value: analysisFacts.value.lrBalance.interpretationMode
      }
    ]
  })

  const promptDecisions = computed(
    () =>
      analysisFactsV2.value?.confidence?.debugMeta?.promptDecisions ||
      analysisFacts.value?.debugMeta?.promptDecisions ||
      {}
  )
  const includedPromptFactsCount = computed(
    () => Object.values(promptDecisions.value).filter((decision: any) => decision.include).length
  )
  const ignoredPromptFactsCount = computed(
    () => Object.values(promptDecisions.value).filter((decision: any) => !decision.include).length
  )

  function getPromptDecision(path: string) {
    return (
      promptDecisions.value[path] || { include: false, reason: 'No prompt decision available.' }
    )
  }

  function getPromptDecisionInclude(path: string) {
    return getPromptDecision(path).include
  }

  function getPromptDecisionReason(path: string) {
    return getPromptDecision(path).reason
  }

  function getPromptDecisionValueClass(path: string) {
    return getPromptDecisionInclude(path)
      ? 'text-emerald-700 dark:text-emerald-300'
      : 'text-gray-500 dark:text-gray-400'
  }

  const splitWorkoutTags = (tags: unknown) => {
    const values = Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === 'string')
      : []

    return {
      intervals: values.filter((tag) => tag.startsWith('icu:')),
      local: values.filter((tag) => !tag.startsWith('icu:'))
    }
  }

  const localTagDraft = ref<string[]>([])

  const intervalsSourceTags = computed(() => splitWorkoutTags(workout.value?.tags).intervals)
  const localWorkoutTags = computed(() => splitWorkoutTags(workout.value?.tags).local)
  const normalizedLocalTagDraft = computed(() =>
    Array.from(
      new Set(
        localTagDraft.value
          .map((tag) => tag.trim().replace(/\s+/g, ' ').toLowerCase())
          .filter((tag) => tag.length > 0 && !tag.startsWith('icu:'))
      )
    )
  )
  const hasLocalTagChanges = computed(() => {
    if (normalizedLocalTagDraft.value.length !== localWorkoutTags.value.length) return true

    return normalizedLocalTagDraft.value.some((tag, index) => tag !== localWorkoutTags.value[index])
  })

  const syncLocalTagDraft = () => {
    localTagDraft.value = [...localWorkoutTags.value]
  }

  const resetLocalTags = () => {
    syncLocalTagDraft()
  }

  watch(
    () => workout.value?.tags,
    () => {
      syncLocalTagDraft()
    },
    { immediate: true }
  )

  const isOnboarded = computed(() => {
    // 1. Check if ANY data (Workouts, Nutrition, or Wellness)
    if (
      userStore.dataSyncStatus?.workouts ||
      userStore.dataSyncStatus?.nutrition ||
      userStore.dataSyncStatus?.wellness
    )
      return true

    return false
  })

  const canPublishSummaryToIntervals = computed(() => {
    return (
      workout.value &&
      workout.value.source === 'intervals' &&
      (workout.value.aiAnalysis || workout.value.aiAnalysisJson)
    )
  })

  // Metric modal state
  const isMetricModalOpen = ref(false)
  const activeMetric = ref<{
    key: string
    value: string | number
    unit?: string
    rating?: string
    ratingColor?: 'success' | 'warning' | 'error' | 'neutral'
  } | null>(null)

  function handleOpenMetric(metric: any) {
    activeMetric.value = metric
    isMetricModalOpen.value = true
  }

  // Stream modal state
  const isStreamModalOpen = ref(false)
  const selectedStream = ref<{
    key: string
    label: string
    color: string
    unit: string
  } | null>(null)

  function openStreamModal(stream: any) {
    selectedStream.value = stream
    isStreamModalOpen.value = true
  }

  const dismissedThresholds = ref<string[]>([])

  const detectedThresholds = computed(() => {
    if (!workout.value || !workout.value.thresholdDetection) return []
    const uniqueThresholds: Record<string, any> = {}

    workout.value.thresholdDetection
      .filter((d: any) => !dismissedThresholds.value.includes(d.type))
      .forEach((detection: any) => {
        const sport = detection.sport || 'General'
        const label = detection.label || detection.type
        const unit = detection.unit || (detection.type === 'LTHR' ? 'bpm' : 'W')
        const key = `${sport}-${detection.type}`

        uniqueThresholds[key] = {
          ...detection,
          sportName: sport,
          label,
          unit,
          peakValue: detection.peakValue || detection.newValue
        }
      })
    return Object.values(uniqueThresholds)
  })

  // Personal Bests State
  const achievements = computed(() => {
    if (!workout.value || !workout.value.personalBests) return []
    return workout.value.personalBests
      .filter((pb: any) => pb && typeof pb.type === 'string' && pb.type.length > 0)
      .map((pb: any) => {
        const isPace = pb.unit === 's'
        let displayValue = pb.value.toString()
        if (isPace) {
          const mins = Math.floor(pb.value / 60)
          const secs = Math.floor(pb.value % 60)
          displayValue = `${mins}:${secs.toString().padStart(2, '0')}`
        }

        // Localize common PB types
        let label = pb.type.replace(/_/g, ' ').replace('RUN ', '').replace('POWER ', 'Peak ')
        const typeKey = `achievement_${pb.type.toLowerCase()}`
        if (typeof t.value === 'function' && t.value(typeKey) !== typeKey) {
          label = t.value(typeKey)
        }

        return {
          ...pb,
          displayValue,
          label
        }
      })
  })

  function openThresholdUpdate(detection: any) {
    activeDetection.value = detection
    isThresholdModalOpen.value = true
  }

  async function confirmThresholdUpdate() {
    if (!activeDetection.value) return

    const metricKey = activeDetection.value.type.toLowerCase()
    const success = await userStore.updateUserMetrics(
      {
        [metricKey]: activeDetection.value.newValue
      },
      workout.value?.type
    )

    if (success) {
      isThresholdModalOpen.value = false
      dismissedThresholds.value.push(activeDetection.value.type)
    }
  }

  const isEditModalOpen = ref(false)
  const isDeleteModalOpen = ref(false)

  const onDeleteRequested = () => {
    isEditModalOpen.value = false
    isDeleteModalOpen.value = true
  }

  const isThresholdModalOpen = ref(false)
  const activeDetection = ref<any>(null)

  const extrasMetaData = computed<Record<string, any> | null>(() => {
    const value = workout.value?.streams?.extrasMeta
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, any>
  })

  const fitSessionSummary = computed(() => {
    return extrasMetaData.value?.fitSession || null
  })

  // Available metrics computed property
  const availableMetrics = computed(() => {
    if (!workout.value) return []
    const metrics = []

    // Time & Distance
    if (workout.value.durationSec)
      metrics.push({
        key: 'duration',
        label: t.value('metrics_duration'),
        value: formatDuration(workout.value.durationSec)
      })
    if (workout.value.distance)
      metrics.push({
        key: 'distance',
        label: t.value('metrics_distance'),
        value: formatDistance(workout.value.distance)
      })

    // Intensity & Load
    if (workout.value.tss)
      metrics.push({
        key: 'tss',
        label: t.value('metrics_tss'),
        value: workout.value.tss.toFixed(1)
      })
    if (workout.value.intensity)
      metrics.push({
        key: 'intensity',
        label: 'Intensity (IF)',
        value: workout.value.intensity.toFixed(2)
      })
    if (workout.value.trainingLoad)
      metrics.push({
        key: 'load',
        label: 'Training Load',
        value: workout.value.trainingLoad.toFixed(0)
      })

    // Heart Rate
    if (workout.value.averageHr)
      metrics.push({
        key: 'avgHr',
        label: t.value('metrics_avg_hr'),
        value: `${workout.value.averageHr} bpm`
      })
    if (workout.value.maxHr)
      metrics.push({
        key: 'maxHr',
        label: t.value('metrics_max_hr'),
        value: `${workout.value.maxHr} bpm`
      })

    // Power
    if (workout.value.averageWatts)
      metrics.push({
        key: 'avgWatts',
        label: t.value('metrics_avg_power'),
        value: `${workout.value.averageWatts}W`
      })
    if (workout.value.maxWatts)
      metrics.push({
        key: 'maxWatts',
        label: t.value('metrics_max_power'),
        value: `${workout.value.maxWatts}W`
      })
    if (workout.value.normalizedPower)
      metrics.push({
        key: 'np',
        label: t.value('metrics_np'),
        value: `${workout.value.normalizedPower}W`
      })
    if (workout.value.variabilityIndex)
      metrics.push({
        key: 'vi',
        label: 'Variability Index (VI)',
        value: workout.value.variabilityIndex.toFixed(2)
      })
    if (workout.value.efficiencyFactor)
      metrics.push({
        key: 'ef',
        label: 'Efficiency Factor (EF)',
        value: workout.value.efficiencyFactor.toFixed(2)
      })

    // Others
    if (workout.value.averageCadence)
      metrics.push({
        key: 'cadence',
        label: t.value('metrics_avg_cadence'),
        value: `${workout.value.averageCadence} rpm`
      })
    if (workout.value.calories)
      metrics.push({
        key: 'calories',
        label: t.value('metrics_calories'),
        value: `${workout.value.calories} kcal`
      })
    if (workout.value.elevationGain)
      metrics.push({
        key: 'elevation',
        label: t.value('metrics_elevation'),
        value: formatElevation(workout.value.elevationGain)
      })
    if (workout.value.kilojoules)
      metrics.push({ key: 'kj', label: 'Work (kJ)', value: `${workout.value.kilojoules} kJ` })
    if (workout.value.strainScore)
      metrics.push({
        key: 'strain',
        label: 'Strain Score',
        value: workout.value.strainScore.toFixed(1)
      })
    if (workout.value.hrLoad)
      metrics.push({ key: 'hrLoad', label: 'HR Load', value: workout.value.hrLoad.toFixed(0) })
    if (workout.value.workAboveFtp)
      metrics.push({
        key: 'workAboveFtp',
        label: t.value('metrics_work') + ' > FTP',
        value: `${(workout.value.workAboveFtp / 1000).toFixed(1)} kJ`
      })
    if (workout.value.wBalDepletion)
      metrics.push({
        key: 'wBal',
        label: "W' Bal Depletion",
        value: `${(workout.value.wBalDepletion / 1000).toFixed(1)} kJ`
      })
    if (workout.value.wPrime)
      metrics.push({
        key: 'wPrime',
        label: "W'",
        value: `${(workout.value.wPrime / 1000).toFixed(1)} kJ`
      })
    if (workout.value.carbsUsed)
      metrics.push({
        key: 'carbs',
        label: t.value('metrics_carbs'),
        value: `${workout.value.carbsUsed} g`
      })

    // Training status
    if (workout.value.ctl)
      metrics.push({ key: 'ctl', label: 'CTL (Fitness)', value: workout.value.ctl.toFixed(1) })
    if (workout.value.atl)
      metrics.push({ key: 'atl', label: 'ATL (Fatigue)', value: workout.value.atl.toFixed(1) })
    if (workout.value.ftp)
      metrics.push({ key: 'ftp', label: 'FTP at Time', value: `${workout.value.ftp}W` })

    // Subjective metrics
    if (workout.value.rpe)
      metrics.push({ key: 'rpe', label: 'RPE', value: `${workout.value.rpe}/10` })
    if (workout.value.sessionRpe)
      metrics.push({ key: 'srpe', label: 'Session RPE', value: `${workout.value.sessionRpe}` })
    // Standardized feel scale is 1-5 (1=Weak, 5=Strong)
    if (workout.value.feel)
      metrics.push({ key: 'feel', label: 'Feel', value: `${workout.value.feel}/5` })
    if (workout.value.trimp)
      metrics.push({ key: 'trimp', label: 'TRIMP', value: `${workout.value.trimp}` })

    // Environment
    if (workout.value.avgTemp !== null && workout.value.avgTemp !== undefined)
      metrics.push({
        key: 'temp',
        label: t.value('metrics_temp'),
        value: formatTemperature(
          workout.value.avgTemp,
          userStore.profile?.temperatureUnits || 'Celsius'
        )
      })
    if (workout.value.trainer !== null && workout.value.trainer !== undefined)
      metrics.push({
        key: 'trainer',
        label: t.value('trainer_indoor'),
        value: workout.value.trainer ? t.value('trainer_yes') : t.value('trainer_no')
      })

    const sessionSummary = fitSessionSummary.value
    if (sessionSummary) {
      if (sessionSummary.totalElapsedTime !== null && sessionSummary.totalElapsedTime !== undefined)
        metrics.push({
          key: 'fitTotalElapsedTime',
          label: 'Elapsed Time',
          value: formatDuration(Math.round(sessionSummary.totalElapsedTime)),
          source: 'fit'
        })

      if (sessionSummary.totalTimerTime !== null && sessionSummary.totalTimerTime !== undefined)
        metrics.push({
          key: 'fitTotalTimerTime',
          label: 'Timer Time',
          value: formatDuration(Math.round(sessionSummary.totalTimerTime)),
          source: 'fit'
        })

      if (sessionSummary.totalDistance !== null && sessionSummary.totalDistance !== undefined)
        metrics.push({
          key: 'fitTotalDistance',
          label: t.value('metrics_distance'),
          value: formatDistance(sessionSummary.totalDistance),
          source: 'fit'
        })

      if (sessionSummary.totalAscent !== null && sessionSummary.totalAscent !== undefined)
        metrics.push({
          key: 'fitTotalAscent',
          label: 'Total Ascent',
          value: `${Math.round(sessionSummary.totalAscent)} m`,
          source: 'fit'
        })

      if (sessionSummary.totalDescent !== null && sessionSummary.totalDescent !== undefined)
        metrics.push({
          key: 'fitTotalDescent',
          label: 'Total Descent',
          value: `${Math.round(sessionSummary.totalDescent)} m`,
          source: 'fit'
        })

      if (sessionSummary.totalCalories !== null && sessionSummary.totalCalories !== undefined)
        metrics.push({
          key: 'fitTotalCalories',
          label: t.value('metrics_calories'),
          value: `${Math.round(sessionSummary.totalCalories)} kcal`,
          source: 'fit'
        })

      if (
        (workout.value.averageWatts === null || workout.value.averageWatts === undefined) &&
        sessionSummary.avgPower !== null &&
        sessionSummary.avgPower !== undefined
      )
        metrics.push({
          key: 'fitAvgPower',
          label: t.value('metrics_avg_power'),
          value: `${Math.round(sessionSummary.avgPower)}W`,
          source: 'fit'
        })

      if (
        (workout.value.maxWatts === null || workout.value.maxWatts === undefined) &&
        sessionSummary.maxPower !== null &&
        sessionSummary.maxPower !== undefined
      )
        metrics.push({
          key: 'fitMaxPower',
          label: t.value('metrics_max_power'),
          value: `${Math.round(sessionSummary.maxPower)}W`,
          source: 'fit'
        })

      if (
        (workout.value.maxHr === null || workout.value.maxHr === undefined) &&
        sessionSummary.maxHeartRate !== null &&
        sessionSummary.maxHeartRate !== undefined
      )
        metrics.push({
          key: 'fitMaxHr',
          label: t.value('metrics_max_hr'),
          value: `${Math.round(sessionSummary.maxHeartRate)} bpm`,
          source: 'fit'
        })

      if (
        sessionSummary.trainingStressScore !== null &&
        sessionSummary.trainingStressScore !== undefined
      )
        metrics.push({
          key: 'fitTss',
          label: t.value('metrics_tss'),
          value: Number(sessionSummary.trainingStressScore).toFixed(1),
          source: 'fit'
        })
    }

    return metrics
  })

  // Available streams computed property
  const availableStreams = computed(() => {
    if (!workout.value || !workout.value.streams) return []
    const streams = []
    const isRideWorkout = isRideWorkoutType(workout.value.type)
    const velocityLabel = isRideWorkout ? 'Speed' : 'Velocity'
    const velocityUnit = isRideWorkout
      ? getVelocityUnitLabel(userStore.profile?.distanceUnits || 'Kilometers')
      : 'm/s'

    // Define stream metadata
    const streamMetadata: Record<string, { label: string; color: string; unit: string }> = {
      time: { label: 'Time', color: '#9ca3af', unit: 's' },
      distance: {
        label: t.value('metrics_distance'),
        color: '#6b7280',
        unit: userStore.distanceUnitLabel
      },
      velocity: { label: velocityLabel, color: '#3b82f6', unit: velocityUnit },
      heartrate: { label: 'Heart Rate', color: '#ef4444', unit: 'bpm' },
      cadence: { label: 'Cadence', color: '#f59e0b', unit: 'rpm' },
      watts: { label: t.value('metrics_avg_power'), color: '#8b5cf6', unit: 'W' },
      altitude: {
        label: 'Altitude',
        color: '#10b981',
        unit: getElevationUnitLabel(userStore.profile?.distanceUnits || 'Kilometers')
      },
      latlng: { label: 'GPS', color: '#6366f1', unit: '' },
      grade: { label: 'Grade', color: '#14b8a6', unit: '%' },
      moving: { label: 'Moving', color: '#9ca3af', unit: '' },
      torque: { label: 'Torque', color: '#f97316', unit: 'N-m' },
      temp: {
        label: t.value('metrics_temp'),
        color: '#06b6d4',
        unit: userStore.temperatureUnitLabel
      },
      respiration: { label: 'Respiration', color: '#ec4899', unit: 'brpm' },
      hrv: { label: 'HRV', color: '#84cc16', unit: 'ms' },
      leftRightBalance: { label: 'L/R Balance', color: '#d946ef', unit: '%' },
      targetPower: { label: 'Target Power', color: '#10b981', unit: 'W' }
    }

    const streamKeys = Object.keys(streamMetadata)

    for (const key of streamKeys) {
      if (
        workout.value.streams[key] &&
        Array.isArray(workout.value.streams[key]) &&
        workout.value.streams[key].length > 0
      ) {
        streams.push({
          key,
          ...streamMetadata[key]
        })
      }
    }
    return streams
  })

  const hasExtrasMeta = computed(() => {
    return Boolean(extrasMetaData.value && Object.keys(extrasMetaData.value).length > 0)
  })

  const workoutSectionAvailability = computed<Record<WorkoutSectionKey, boolean>>(() => {
    const currentWorkout = workout.value

    return {
      overview: Boolean(currentWorkout),
      'training-impact': hasTrainingMetrics(currentWorkout),
      exercises: shouldShowExercises(currentWorkout),
      nutrition: Boolean(
        nutritionEnabled.value && (currentWorkout?.kilojoules || currentWorkout?.plannedWorkout)
      ),
      analysis: Boolean(currentWorkout),
      'power-curve': shouldShowDetailedPacing(currentWorkout),
      intervals: shouldShowIntervals(currentWorkout),
      advanced: shouldShowDetailedPacing(currentWorkout),
      map: shouldShowMap(currentWorkout),
      pacing: shouldShowDetailedPacing(currentWorkout),
      timeline: shouldShowDetailedPacing(currentWorkout),
      zones: shouldShowPacing(currentWorkout),
      efficiency: hasEfficiencyMetrics(currentWorkout),
      notes: Boolean(currentWorkout),
      metrics: availableMetrics.value.length > 0,
      streams: availableStreams.value.length > 0 || hasExtrasMeta.value,
      duplicates: Boolean(
        currentWorkout?.isDuplicate ||
        currentWorkout?.duplicates?.length ||
        currentWorkout?.plannedWorkout
      ),
      'raw-data': Boolean(currentWorkout?.rawJson)
    }
  })

  const workoutSectionSettings = computed<WorkoutSectionSettings>(() => {
    const saved =
      (userStore.user?.dashboardSettings?.workoutDetailSections as
        Partial<WorkoutSectionSettings> | undefined) || {}

    return workoutSectionCatalog.value.reduce((acc, section) => {
      const fallback = workoutSectionDefaults.value[section.key] || { visible: true, order: 99 }
      const sectionSettings = saved[section.key]
      acc[section.key] = {
        visible: sectionSettings?.visible ?? fallback.visible,
        order: typeof sectionSettings?.order === 'number' ? sectionSettings.order : fallback.order
      }
      return acc
    }, {} as WorkoutSectionSettings)
  })

  const workoutSectionsModalOptions = computed(() =>
    workoutSectionCatalog.value.map((section) => ({
      key: section.key,
      label: section.label,
      icon: section.icon,
      available: workoutSectionAvailability.value[section.key],
      defaultVisible: workoutSectionDefaults.value[section.key]?.visible ?? true
    }))
  )

  const workoutNavSections = computed(() =>
    workoutSectionCatalog.value
      .filter((section) => isSectionEnabled(section.key))
      .sort(
        (a, b) =>
          (workoutSectionSettings.value[a.key]?.order ?? 0) -
          (workoutSectionSettings.value[b.key]?.order ?? 0)
      )
  )

  const deferredSectionKeys = new Set<WorkoutSectionKey>([
    'analysis',
    'power-curve',
    'intervals',
    'advanced',
    'map',
    'pacing',
    'timeline',
    'zones',
    'efficiency',
    'metrics',
    'streams',
    'duplicates',
    'raw-data'
  ])

  function shouldRenderSection(sectionKey: WorkoutSectionKey) {
    return (
      isSectionEnabled(sectionKey) &&
      (deferredSectionsReady.value || !deferredSectionKeys.has(sectionKey))
    )
  }

  function scheduleDeferredSections() {
    if (!import.meta.client || deferredSectionsReady.value) return

    const renderDeferredSections = () => {
      deferredSectionsTimer = null
      deferredSectionsReady.value = true
    }

    // Keep the first summary paint light; nav clicks can still opt into these sections immediately.
    deferredSectionsTimer = setTimeout(renderDeferredSections, 1500)
  }

  function isSectionEnabled(sectionKey: WorkoutSectionKey) {
    return (
      (workoutSectionSettings.value[sectionKey]?.visible ?? true) &&
      workoutSectionAvailability.value[sectionKey]
    )
  }

  function sectionStyle(sectionKey: WorkoutSectionKey) {
    return {
      order: workoutSectionSettings.value[sectionKey]?.order ?? 0
    }
  }

  // Fetch workout data
  async function fetchWorkout() {
    if (!isPageActive.value) return
    loading.value = true
    error.value = null
    try {
      const id = route.params.id
      const result = await $fetch<any, string & {}>(`/api/workouts/${id}`)
      if (!isPageActive.value) return
      workout.value = result
    } catch (e: any) {
      if (!isPageActive.value) return
      error.value = e?.data?.message || e?.message || t.value('error_failed_to_load')
      console.error('Error fetching workout:', e)
    } finally {
      if (isPageActive.value) {
        loading.value = false
      }
    }
  }

  async function saveLocalTags() {
    if (!workout.value || savingTags.value || !hasLocalTagChanges.value) return

    savingTags.value = true
    try {
      const response = (await ($fetch as any)(`/api/workouts/${workout.value.id}`, {
        method: 'PATCH',
        body: {
          setLocalTags: normalizedLocalTagDraft.value
        }
      })) as { success: boolean; workout: any }

      workout.value = response.workout
      syncLocalTagDraft()

      toast.add({
        title: 'Tags updated',
        description: 'Workout tags have been saved.',
        color: 'success',
        icon: 'i-heroicons-check-circle'
      })
    } catch (e: any) {
      console.error('Error updating workout tags:', e)
      toast.add({
        title: 'Failed to update tags',
        description: e?.data?.message || e?.message || 'Could not save workout tags.',
        color: 'error',
        icon: 'i-heroicons-exclamation-circle'
      })
    } finally {
      savingTags.value = false
    }
  }

  // Background Task Monitoring
  const { refresh: refreshRuns } = useUserRuns()
  const { onTaskCompleted, onTaskFailed } = useUserRunsState()

  // Analyze workout function
  async function analyzeWorkout() {
    if (!workout.value) return

    analyzingWorkout.value = true
    try {
      const result = (await $fetch<any, string & {}>(`/api/workouts/${workout.value.id}/analyze`, {
        method: 'POST'
      })) as any

      // If already completed, update immediately
      if (result.status === 'COMPLETED' && 'analysis' in result && result.analysis) {
        workout.value.aiAnalysis = result.analysis
        workout.value.aiAnalyzedAt = result.analyzedAt
        workout.value.aiAnalysisStatus = 'COMPLETED'
        analyzingWorkout.value = false

        toast.add({
          title: t.value('analyzing_ready_title'),
          description: t.value('analyzing_ready_desc'),
          color: 'success',
          icon: 'i-heroicons-check-circle'
        })
        return
      }

      // Update status
      workout.value.aiAnalysisStatus = result.status
      refreshRuns()

      // Show processing message
      toast.add({
        title: t.value('analyzing_started_title'),
        description: t.value('analyzing_started_desc'),
        color: 'info',
        icon: 'i-heroicons-sparkles'
      })
    } catch (e: any) {
      console.error('Error triggering workout analysis:', e)
      analyzingWorkout.value = false

      if (e.data?.statusCode === 429 || e.status === 429) {
        await showQuotaPaywall({
          operation: 'workout_analysis',
          title: 'Crush Your Training Momentum',
          featureTitle: 'Workout Analysis',
          reason: 'quota_exceeded'
        })
        return
      }

      toast.add({
        title: t.value('analyzing_failed_title'),
        description: e?.data?.message || e?.message || 'Failed to start workout analysis',
        color: 'error',
        icon: 'i-heroicons-exclamation-circle'
      })
    }
  }

  // Analyze plan adherence
  async function analyzeAdherence() {
    if (!workout.value) return

    analyzingAdherence.value = true
    try {
      await $fetch<any, string & {}>(`/api/workouts/${workout.value.id}/analyze-adherence`, {
        method: 'POST'
      })
      refreshRuns()

      toast.add({
        title: t.value('analyzing_started_title'),
        description: t.value('analyzing_adherence_started'),
        color: 'info',
        icon: 'i-heroicons-sparkles'
      })
    } catch (e: any) {
      console.error('Error triggering adherence analysis:', e)
      analyzingAdherence.value = false

      if (e.data?.statusCode === 429 || e.status === 429) {
        await showQuotaPaywall({
          operation: 'workout_analysis',
          title: 'Usage Quota Reached',
          featureTitle: 'Plan Adherence Analysis',
          reason: 'quota_exceeded'
        })
        return
      }

      toast.add({
        title: t.value('analyzing_failed_title'),
        description: e?.data?.message || e?.message || 'Failed to start adherence analysis',
        color: 'error'
      })
    }
  }

  async function unlinkPlannedWorkout() {
    if (!workout.value?.id || unlinkingPlannedWorkout.value) return

    unlinkingPlannedWorkout.value = true
    try {
      await $fetch<any, string & {}>(`/api/workouts/${workout.value.id}/unlink`, {
        method: 'POST'
      })

      toast.add({
        title: 'Unlinked',
        description: 'Workout unlinked from plan',
        color: 'success',
        icon: 'i-heroicons-check-circle'
      })

      await fetchWorkout()
    } catch (e: any) {
      console.error('Error unlinking workout from plan:', e)
      toast.add({
        title: 'Failed to unlink',
        description: e?.data?.message || e?.message || 'Failed to unlink workout from plan',
        color: 'error',
        icon: 'i-heroicons-exclamation-circle'
      })
    } finally {
      unlinkingPlannedWorkout.value = false
    }
  }

  async function publishSummaryToIntervals() {
    if (!workout.value || !canPublishSummaryToIntervals.value || publishingSummary.value) return

    publishingSummary.value = true
    try {
      await $fetch<any, string & {}>(`/api/workouts/${workout.value.id}/publish-summary`, {
        method: 'POST'
      })

      toast.add({
        title: t.value('analysis_button_publish'),
        description: t.value('publish_summary_success'),
        color: 'success',
        icon: 'i-heroicons-check-circle'
      })

      await fetchWorkout()
    } catch (e: any) {
      console.error('Error publishing workout summary:', e)
      toast.add({
        title: 'Publish Failed',
        description: e?.data?.message || e?.message || 'Failed to publish workout summary',
        color: 'error',
        icon: 'i-heroicons-exclamation-circle'
      })
    } finally {
      publishingSummary.value = false
    }
  }

  // Listen for completion
  onTaskCompleted('analyze-workout', async () => {
    if (!isPageActive.value) return
    try {
      await fetchWorkout()
      if (!isPageActive.value) return
      analyzingWorkout.value = false
      toast.add({
        title: t.value('analyzing_ready_title'),
        description: 'AI workout analysis has been generated successfully',
        color: 'success',
        icon: 'i-heroicons-check-circle'
      })
    } catch (error) {
      console.error('[WorkoutDetail] analyze-workout completion handler failed:', error)
      if (isPageActive.value) {
        analyzingWorkout.value = false
      }
    }
  })

  onTaskCompleted('analyze-plan-adherence', async () => {
    if (!isPageActive.value) return
    try {
      await fetchWorkout()
      if (!isPageActive.value) return
      analyzingAdherence.value = false
      toast.add({
        title: 'Adherence Analysis Complete',
        color: 'success',
        icon: 'i-heroicons-check-circle'
      })
    } catch (error) {
      console.error('[WorkoutDetail] analyze-plan-adherence completion handler failed:', error)
      if (isPageActive.value) {
        analyzingAdherence.value = false
      }
    }
  })

  onTaskFailed('analyze-workout', async (run) => {
    if (!isPageActive.value) return
    analyzingWorkout.value = false
    toast.add({
      title: 'Analysis Failed',
      description: run.error?.message || 'AI workout analysis failed',
      color: 'error',
      icon: 'i-heroicons-exclamation-circle'
    })
  })

  onTaskFailed('analyze-plan-adherence', async (run) => {
    if (!isPageActive.value) return
    analyzingAdherence.value = false
    toast.add({
      title: 'Adherence Analysis Failed',
      description: run.error?.message || 'Plan adherence analysis failed',
      color: 'error',
      icon: 'i-heroicons-exclamation-circle'
    })
  })

  async function promoteWorkout() {
    if (!workout.value) return
    isPromoteModalOpen.value = true
  }

  function openDuplicateUnlinkConfirm(workoutId: string, workoutTitle?: string | null) {
    duplicateUnlinkTargetId.value = workoutId
    duplicateUnlinkTargetName.value = workoutTitle || ''
    isDuplicateUnlinkModalOpen.value = true
  }

  async function unlinkDuplicateWorkout() {
    if (!duplicateUnlinkTargetId.value) return

    unlinkingDuplicateId.value = duplicateUnlinkTargetId.value
    try {
      await $fetch<any, string & {}>(
        `/api/workouts/${duplicateUnlinkTargetId.value}/unlink-duplicate`,
        {
          method: 'POST'
        }
      )

      toast.add({
        title: 'Workout unlinked',
        description: 'The workouts are no longer linked as duplicates.',
        color: 'success',
        icon: 'i-heroicons-check-circle'
      })

      isDuplicateUnlinkModalOpen.value = false
      duplicateUnlinkTargetId.value = null
      duplicateUnlinkTargetName.value = ''
      await fetchWorkout()
    } catch (e: any) {
      console.error('Failed to unlink duplicate workout:', e)
      toast.add({
        title: 'Failed to unlink workout',
        description: e?.data?.message || e?.message || 'Could not remove the duplicate link.',
        color: 'error',
        icon: 'i-heroicons-exclamation-circle'
      })
    } finally {
      unlinkingDuplicateId.value = null
    }
  }

  async function confirmPromoteWorkout() {
    if (!workout.value) return

    promoting.value = true
    try {
      await $fetch<any, string & {}>(`/api/workouts/${workout.value.id}/promote`, {
        method: 'POST'
      })

      toast.add({
        title: 'Success',
        description: t.value('promote_success'),
        color: 'success'
      })

      // Refresh to reflect changes
      await fetchWorkout()
      isPromoteModalOpen.value = false
    } catch (e: any) {
      console.error('Failed to promote workout:', e)
      toast.add({
        title: 'Error',
        description: e.data?.message || 'Failed to promote workout',
        color: 'error'
      })
    } finally {
      promoting.value = false
    }
  }

  async function deleteWorkout() {
    if (!workout.value || deleting.value) return

    deleting.value = true
    try {
      await $fetch<any, string & {}>(`/api/workouts/${workout.value.id}`, {
        method: 'DELETE'
      })

      toast.add({
        title: t.value('delete_success_title'),
        description: t.value('delete_success_desc'),
        color: 'success'
      })

      // Navigate back to activities/history
      router.push('/activities')
    } catch (e: any) {
      console.error('Failed to delete workout:', e)
      toast.add({
        title: 'Error',
        description: e.data?.message || 'Failed to delete workout',
        color: 'error'
      })
    } finally {
      deleting.value = false
      isDeleteModalOpen.value = false
    }
  }

  // Utility functions
  function formatDate(date: string | Date) {
    return formatDateTime(date, 'EEEE, MMMM d, yyyy h:mm a')
  }

  function formatTimeOnly(date: string | Date) {
    return formatTime(date)
  }

  function formatDatePrimary(date: string | Date) {
    if (!date) return ''
    const d = new Date(date)
    return d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    })
  }

  function formatDateWeekday(date: string | Date) {
    if (!date) return ''
    const d = new Date(date)
    return d.toLocaleDateString('en-US', {
      weekday: 'long'
    })
  }

  function navigateDate(direction: number) {
    if (!workout.value) return
    const neighborId = direction > 0 ? workout.value.nextWorkoutId : workout.value.prevWorkoutId

    if (neighborId) {
      navigateTo(`/workouts/${neighborId}`)
    } else {
      // Fallback: if no neighbor, go to activities for that date range
      const baseDate = new Date(workout.value.date)
      const targetDate = new Date(baseDate)
      targetDate.setDate(baseDate.getDate() + direction)
      navigateTo({
        path: '/activities',
        query: { date: targetDate.toISOString().split('T')[0] }
      })
    }
  }

  function formatDuration(seconds: number) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`
    }
    if (minutes > 0) {
      return `${minutes}m ${secs}s`
    }
    return `${secs}s`
  }

  function formatDurationShort(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  function getIntensityColorClass(intensity: number | null, type: 'text' | 'bg' = 'text') {
    const val = intensity || 0
    if (val < 0.75) return type === 'text' ? 'text-[#00DC82]' : 'bg-[#00DC82]'
    if (val < 0.85) return type === 'text' ? 'text-yellow-500' : 'bg-yellow-500'
    if (val < 0.95) return type === 'text' ? 'text-orange-500' : 'bg-orange-500'
    return type === 'text' ? 'text-red-500' : 'bg-red-500'
  }

  function formatDistance(meters: number) {
    return formatDist(meters, userStore.profile?.distanceUnits || 'Kilometers')
  }

  function formatElevation(meters: number) {
    return formatElev(meters, userStore.profile?.distanceUnits || 'Kilometers')
  }

  function getSourceBadgeClass(source: string) {
    const baseClass = 'px-3 py-1 rounded-full text-xs font-semibold'
    if (source === 'intervals')
      return `${baseClass} bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200`
    if (source === 'whoop')
      return `${baseClass} bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200`
    if (source === 'strava')
      return `${baseClass} bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200`
    if (source === 'rouvy')
      return `${baseClass} bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200`
    if (source === 'garmin')
      return `${baseClass} bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200`
    return `${baseClass} bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200`
  }

  function shouldShowSyncSourceNote(workout: any) {
    if (!workout) return false
    if (workout.source === 'manual') return false
    if (workout.source === 'fit_file') return Boolean(workout.oauthAppId)
    return true
  }

  const getStatusPillClass = (status?: string | null) => getAnalysisStatusClass(status)

  function getPriorityBadgeClass(priority: string) {
    const baseClass = 'px-2 py-0.5 rounded text-xs font-medium'
    if (priority === 'high')
      return `${baseClass} bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200`
    if (priority === 'medium')
      return `${baseClass} bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200`
    if (priority === 'low')
      return `${baseClass} bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200`
    return `${baseClass} bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200`
  }

  function getPriorityBorderClass(priority: string) {
    if (priority === 'high') return 'border-red-500'
    if (priority === 'medium') return 'border-yellow-500'
    if (priority === 'low') return 'border-blue-500'
    return 'border-gray-300'
  }

  function getScoreCircleClass(score: number) {
    if (score >= 8) return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
    if (score >= 6) return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
    if (score >= 4) return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
    return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
  }

  function shouldShowExercises(workout: any) {
    if (!workout) return false
    return workout.exercises && workout.exercises.length > 0
  }

  function shouldShowPowerCurve(workout: any) {
    if (!workout) return false
    // Show power curve if workout has power data (watts stream)
    const supportedSources = ['strava', 'rouvy', 'intervals', 'fit_file']
    return (
      supportedSources.includes(workout.source) &&
      workout.streams &&
      (workout.averageWatts || workout.maxWatts)
    )
  }

  function shouldShowMap(workout: any) {
    if (!workout || !workout.streams) return false
    return (
      workout.streams.latlng &&
      Array.isArray(workout.streams.latlng) &&
      workout.streams.latlng.length > 0
    )
  }

  function shouldShowIntervals(workout: any) {
    if (!workout || !workout.streams) return false
    const supportedSources = ['strava', 'rouvy', 'intervals', 'fit_file']
    return (
      supportedSources.includes(workout.source) &&
      (workout.streams.watts || workout.streams.heartrate || workout.streams.velocity)
    )
  }

  function shouldShowPacing(workout: any) {
    if (!workout) return false
    // Show timeline/zones if workout has stream data (time-series HR, power, velocity, etc.)
    // OR if it has cached zone data in rawJson (fallback for Whoop, etc.)
    const supportedSources = ['strava', 'rouvy', 'intervals', 'fit_file', 'whoop']
    const hasRawZones = workout.rawJson?.score?.zone_durations?.length > 0
    const hasStreams =
      workout.streams &&
      (workout.streams.heartrate ||
        workout.streams.watts ||
        workout.streams.velocity ||
        workout.streams.hrZoneTimes ||
        workout.streams.powerZoneTimes)
    return (supportedSources.includes(workout.source) && hasStreams) || hasRawZones
  }

  function shouldShowDetailedPacing(workout: any) {
    if (!workout || !workout.streams) return false
    // Detailed pacing needs raw time-series data
    return workout.streams.heartrate || workout.streams.watts || workout.streams.velocity
  }

  function hasEfficiencyMetrics(workout: any) {
    if (!workout) return false
    return (
      workout.variabilityIndex !== null ||
      workout.efficiencyFactor !== null ||
      workout.decoupling !== null ||
      workout.powerHrRatio !== null ||
      workout.polarizationIndex !== null ||
      workout.lrBalance !== null
    )
  }

  function hasTrainingMetrics(workout: any) {
    if (!workout) return false
    return (
      (workout.tss !== null || workout.trainingLoad !== null) &&
      (workout.ctl !== null || workout.atl !== null)
    )
  }

  function calculateForm(workout: any) {
    if (!workout || workout.ctl === null || workout.atl === null) return null
    return Math.round(workout.ctl - workout.atl)
  }

  function getFormClass(form: number | null) {
    if (form === null)
      return 'bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-500'

    if (form >= 25)
      return 'bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 text-blue-900 dark:text-blue-100' // Transition
    if (form >= 5)
      return 'bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800 text-green-900 dark:text-green-100' // Fresh
    if (form >= -10)
      return 'bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white' // Grey zone / Neutral
    if (form >= -30)
      return 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-100 dark:border-yellow-800 text-yellow-900 dark:text-yellow-100' // Optimal Training
    return 'bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 text-red-900 dark:text-red-100' // High Risk
  }

  function highlightTechnicalData(text: string): string {
    if (!text) return ''
    // Regex to match numbers followed by units or specific technical terms
    // Matches: 0.980 VI, 66 rpm, -22 min, 250W, 180bpm, 10.5km, etc.
    const technicalRegex =
      /(\b-?\d+(?:\.\d+)?\s*(?:VI|EF|IF|rpm|min|sec|W|bpm|km|m|kJ|kg|%|TSS|CTL|ATL|TSB)\b)/gi
    return text.replace(
      technicalRegex,
      '<span class="text-[#00DC82] font-black tabular-nums">$1</span>'
    )
  }

  // Scroll to section
  function scrollToSection(sectionId: string) {
    trackWorkoutSectionView(sectionId)
    if (!deferredSectionsReady.value) {
      deferredSectionsReady.value = true
    }

    void nextTick(() => {
      const element = document.getElementById(sectionId)
      element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  async function saveToLibrary() {
    if (!workout.value) return

    savingToLibrary.value = true
    try {
      await $fetch<any, string & {}>('/api/library/workouts/save', {
        method: 'POST',
        body: {
          workoutId: workout.value.id,
          title: workout.value.title
        }
      })

      toast.add({
        title: 'Saved to Library',
        description: 'You can now reuse this session structure from your library.',
        color: 'success',
        actions: [
          {
            label: 'View Library',
            onClick: () => {
              navigateTo('/library/workouts')
            }
          }
        ]
      })
    } catch (error: any) {
      toast.add({
        title: 'Save Failed',
        description: error.data?.message || 'Failed to save to library',
        color: 'error'
      })
    } finally {
      savingToLibrary.value = false
    }
  }

  // Chat about workout
  function chatAboutWorkout() {
    if (!workout.value) return
    navigateTo({
      path: '/chat',
      query: { workoutId: workout.value.id }
    })
  }

  function detectProvider(name: string | undefined): string | undefined {
    if (!name) return undefined
    const lower = name.toLowerCase()
    if (lower.includes('zwift')) return 'zwift'
    if (lower.includes('rouvy')) return 'rouvy'
    if (lower.includes('garmin')) return 'garmin'
    if (lower.includes('apple')) return 'apple_health'
    return undefined
  }

  // Section Catalog Definition
  const workoutSectionCatalog = computed(
    (): Array<{
      key: WorkoutSectionKey
      label: string
      icon: string
      anchorId: string
    }> => {
      const isTReady = typeof t.value === 'function'
      return [
        {
          key: 'exercises',
          label: isTReady ? t.value('sections_exercises') : 'Exercises',
          icon: 'i-lucide-dumbbell',
          anchorId: 'exercises'
        },
        {
          key: 'nutrition',
          label: isTReady ? t.value('sections_nutrition') : 'Nutrition',
          icon: 'i-lucide-beaker',
          anchorId: 'nutrition'
        },
        {
          key: 'analysis',
          label: isTReady ? t.value('sections_analysis') : 'AI Analysis',
          icon: 'i-lucide-sparkles',
          anchorId: 'analysis'
        },
        {
          key: 'power-curve',
          label: isTReady ? t.value('sections_power_curve') : 'Power Curve',
          icon: 'i-lucide-zap',
          anchorId: 'power-curve'
        },
        {
          key: 'intervals',
          label: isTReady ? t.value('sections_intervals') : 'Intervals',
          icon: 'i-lucide-timer',
          anchorId: 'intervals'
        },
        {
          key: 'advanced',
          label: isTReady ? t.value('sections_advanced') : 'Advanced',
          icon: 'i-lucide-microscope',
          anchorId: 'advanced'
        },
        {
          key: 'map',
          label: isTReady ? t.value('sections_map') : 'Map',
          icon: 'i-lucide-map',
          anchorId: 'map'
        },
        {
          key: 'pacing',
          label: isTReady ? t.value('sections_pacing') : 'Pacing',
          icon: 'i-lucide-activity',
          anchorId: 'pacing'
        },
        {
          key: 'timeline',
          label: isTReady ? t.value('sections_timeline') : 'Timeline',
          icon: 'i-lucide-chart-line',
          anchorId: 'timeline'
        },
        {
          key: 'zones',
          label: isTReady ? t.value('sections_zones') : 'Zones',
          icon: 'i-lucide-layers',
          anchorId: 'zones'
        },
        {
          key: 'efficiency',
          label: isTReady ? t.value('sections_efficiency') : 'Efficiency',
          icon: 'i-lucide-gauge',
          anchorId: 'efficiency'
        },
        {
          key: 'notes',
          label: isTReady ? t.value('sections_notes') : 'Notes',
          icon: 'i-lucide-notebook-pen',
          anchorId: 'notes'
        },
        {
          key: 'metrics',
          label: isTReady ? t.value('sections_metrics') : 'Metrics',
          icon: 'i-lucide-bar-chart-3',
          anchorId: 'metrics'
        },
        {
          key: 'streams',
          label: isTReady ? t.value('sections_streams') : 'Streams',
          icon: 'i-lucide-radio',
          anchorId: 'streams'
        },
        {
          key: 'duplicates',
          label: isTReady ? t.value('sections_duplicates') : 'Versions',
          icon: 'i-lucide-copy',
          anchorId: 'duplicates'
        },
        {
          key: 'raw-data',
          label: isTReady ? t.value('sections_raw_data') : 'Raw Data',
          icon: 'i-lucide-code-xml',
          anchorId: 'raw-data'
        }
      ]
    }
  )

  const workoutSectionDefaults = computed(() =>
    workoutSectionCatalog.value.reduce((acc, section, index) => {
      acc[section.key] = { visible: true, order: index }
      return acc
    }, {} as WorkoutSectionSettings)
  )

  function goBack() {
    router.back()
  }

  const plannedKJ = computed(() => {
    if (!workout.value?.plannedWorkout) return null
    const pw = workout.value.plannedWorkout
    return Math.round((pw.tss || 100) * 8.5)
  })

  const kJDelta = computed(() => {
    if (!workout.value?.kilojoules || !plannedKJ.value) return 0
    return Math.round(((workout.value.kilojoules - plannedKJ.value) / plannedKJ.value) * 100)
  })

  const recoveryCarbBump = computed(() => {
    if (kJDelta.value < 10) return 0
    return Math.round((kJDelta.value / 15) * 40)
  })

  const nutritionEstimate = computed(() => {
    const caloriesFromWorkout = Number(workout.value?.calories || 0)
    const kilojoules = Number(workout.value?.kilojoules || 0)
    const estimatedCalories = Math.round(
      caloriesFromWorkout > 0 ? caloriesFromWorkout : kilojoules > 0 ? kilojoules / 4.184 : 0
    )

    if (estimatedCalories <= 0) return null

    const reportedCarbs = Number(workout.value?.carbsUsed || 0)
    const estimatedCarbs = Math.round(
      reportedCarbs > 0 ? reportedCarbs : (estimatedCalories * 0.6) / 4
    )
    const nonCarbCalories = Math.max(estimatedCalories - estimatedCarbs * 4, 0)
    const estimatedFat = Math.round((nonCarbCalories * 0.8) / 9)
    const estimatedProtein = Math.round((nonCarbCalories * 0.2) / 4)

    return [
      {
        label: 'Calories',
        value: `${estimatedCalories} kcal`,
        icon: 'i-tabler-flame',
        iconClass: 'text-orange-500'
      },
      {
        label: 'Carbs',
        value: `${estimatedCarbs} g`,
        icon: 'i-tabler-bread',
        iconClass: 'text-yellow-500'
      },
      {
        label: 'Fat',
        value: `${estimatedFat} g`,
        icon: 'i-tabler-droplet',
        iconClass: 'text-cyan-500'
      },
      {
        label: 'Protein',
        value: `${estimatedProtein} g`,
        icon: 'i-tabler-egg',
        iconClass: 'text-blue-500'
      }
    ]
  })

  async function updateStomachFeel(val: number) {
    stomachFeel.value = val
    try {
      await $fetch<any, string & {}>(`/api/workouts/${workout.value.id}/metadata`, {
        method: 'POST' as any,
        body: { stomachFeel: val }
      })
      toast.add({
        title: 'Feedback Saved',
        color: 'success'
      })
    } catch (e) {
      console.error('Failed to save stomach feel:', e)
    }
  }

  // Load data on mount
  onMounted(() => {
    trackWorkoutViewDetail('completed')
    fetchWorkout()

    if (route.query.share === 'true') {
      isShareModalOpen.value = true
    }
  })

  watch(loading, (isLoading) => {
    if (!isLoading) {
      scheduleDeferredSections()
    }
  })

  onBeforeUnmount(() => {
    isPageActive.value = false

    if (deferredSectionsTimer) {
      clearTimeout(deferredSectionsTimer)
      deferredSectionsTimer = null
    }
  })

  watch(
    () => route.params.id,
    (newId, oldId) => {
      if (!newId || newId === oldId) return
      if (deferredSectionsTimer) {
        clearTimeout(deferredSectionsTimer)
        deferredSectionsTimer = null
      }
      deferredSectionsReady.value = false
      fetchWorkout()
    }
  )

  useHead(() => ({
    title: workout.value?.title || 'Workout Details'
  }))
</script>

<style scoped>
  @keyframes pulse-slow {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
  }
  .animate-pulse-slow {
    animation: pulse-slow 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
</style>
