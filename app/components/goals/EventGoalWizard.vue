<template>
  <div class="space-y-6">
    <!-- Step 1: Goal Type Selection -->
    <div v-if="step === 1" class="space-y-6">
      <div class="flex items-center justify-between">
        <h3 class="text-xl font-semibold">What are you training for?</h3>
        <UButton
          icon="i-heroicons-x-mark"
          variant="ghost"
          color="neutral"
          size="sm"
          @click="
            () => {
              void emit('close')
            }
          "
        />
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <button
          v-for="type in goalTypes"
          :key="type.id"
          class="p-4 rounded-lg border-2 text-left transition-all hover:border-primary hover:bg-primary/5 dark:hover:bg-primary/10"
          :class="
            selectedType === type.id
              ? 'border-primary bg-primary/5 dark:bg-primary/10'
              : 'border-gray-200 dark:border-gray-800'
          "
          @click="
            () => {
              void selectType(type.id)
            }
          "
        >
          <div class="p-2 rounded-lg w-fit mb-3" :class="type.color">
            <UIcon :name="type.icon" class="w-6 h-6" />
          </div>
          <div class="font-semibold">{{ type.label }}</div>
          <div class="text-sm text-muted mt-1">{{ type.description }}</div>
        </button>
      </div>
    </div>

    <!-- Step 2: Select Event (Only for EVENT type) -->
    <div v-else-if="step === 2 && selectedType === 'EVENT'" class="space-y-6">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <UButton
            icon="i-heroicons-arrow-left"
            variant="ghost"
            size="sm"
            @click="
              () => {
                isEditMode ? (step = 3) : (step = 1)
              }
            "
          />
          <h3 class="text-xl font-semibold">Select your target event</h3>
        </div>
        <UButton
          icon="i-heroicons-x-mark"
          variant="ghost"
          color="neutral"
          size="sm"
          @click="
            () => {
              void emit('close')
            }
          "
        />
      </div>

      <div class="space-y-4">
        <div v-if="loadingEvents" class="flex justify-center py-12">
          <div class="text-center">
            <UIcon
              name="i-heroicons-arrow-path"
              class="w-8 h-8 animate-spin text-primary mx-auto mb-2"
            />
            <p class="text-sm text-muted">Loading your events...</p>
          </div>
        </div>

        <div
          v-else-if="userEvents.length === 0"
          class="text-center py-12 border-2 border-dashed border-gray-200 dark:border-gray-800 rounded-lg"
        >
          <UIcon
            name="i-heroicons-calendar"
            class="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3"
          />
          <h4 class="font-semibold text-lg mb-1">No events found</h4>
          <p class="text-muted text-sm mb-4">You need to add an event to your calendar first.</p>
          <UButton to="/events" color="primary" variant="soft" icon="i-heroicons-plus">
            Go to Events
          </UButton>
        </div>

        <div v-else class="space-y-3">
          <div class="flex justify-between items-center mb-2">
            <h4 class="text-sm font-medium text-muted uppercase tracking-wider">
              Your Upcoming Events
            </h4>
            <span v-if="form.eventIds.length > 0" class="text-xs text-primary font-bold"
              >{{ form.eventIds.length }} selected</span
            >
          </div>
          <div
            v-for="event in userEvents"
            :key="event.id"
            class="p-4 rounded-lg border cursor-pointer transition-all flex justify-between items-center group"
            :class="
              form.eventIds.includes(event.id)
                ? 'border-primary bg-primary/5 dark:bg-primary/10 ring-1 ring-primary'
                : 'border-gray-200 dark:border-gray-700 hover:border-primary/50'
            "
            @click="
              () => {
                void toggleUserEvent(event)
              }
            "
          >
            <div>
              <div
                class="font-medium text-lg"
                :class="form.eventIds.includes(event.id) ? 'text-primary' : ''"
              >
                {{ event.title }}
              </div>
              <div class="text-sm text-muted mt-1 flex items-center gap-2">
                <UIcon name="i-heroicons-calendar" class="w-4 h-4" />
                {{ formatDate(event.date) }}
                <span class="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
                {{ event.type }}
              </div>
            </div>
            <div
              class="w-6 h-6 rounded-full border flex items-center justify-center transition-colors"
              :class="
                form.eventIds.includes(event.id)
                  ? 'bg-primary border-primary text-white'
                  : 'border-gray-300 dark:border-gray-600 group-hover:border-primary'
              "
            >
              <UIcon
                v-if="form.eventIds.includes(event.id)"
                name="i-heroicons-check"
                class="w-4 h-4"
              />
            </div>
          </div>

          <div class="pt-6 flex justify-end">
            <UButton
              size="lg"
              color="primary"
              icon="i-heroicons-arrow-right"
              :disabled="form.eventIds.length === 0"
              @click="
                () => {
                  step = 3
                }
              "
            >
              {{
                isEditMode
                  ? 'Back to Config'
                  : `Continue with ${form.eventIds.length} Event${form.eventIds.length !== 1 ? 's' : ''}`
              }}
            </UButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 3: Configuration -->
    <div v-else-if="step === 3" class="space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <UButton
            icon="i-heroicons-arrow-left"
            variant="ghost"
            size="sm"
            @click="
              () => {
                isEditMode ? emit('close') : selectedType === 'EVENT' ? (step = 2) : (step = 1)
              }
            "
          />
          <h3 class="text-xl font-semibold">
            {{ isEditMode ? 'Edit Goal' : `Configure ${selectedTypeLabel}` }}
          </h3>
        </div>
        <UButton
          icon="i-heroicons-x-mark"
          variant="ghost"
          color="neutral"
          size="sm"
          @click="
            () => {
              void emit('close')
            }
          "
        />
      </div>

      <div class="space-y-6">
        <!-- Primary Information Group -->
        <div
          class="p-4 bg-gray-50/50 dark:bg-gray-800/20 rounded-xl border border-gray-100 dark:border-gray-800 space-y-6"
        >
          <UFormField>
            <template #label>
              <div class="flex items-center gap-2 text-base font-semibold">
                <UIcon name="i-heroicons-tag" class="w-5 h-5 text-primary" />
                Goal Title
              </div>
            </template>
            <UInput
              v-model="form.title"
              placeholder="e.g. Sub-4 Hour Marathon or Lose 5kg"
              size="xl"
              class="w-full"
            />
            <template #help>
              Make the goal title descriptive so the AI can better understand and support your
              objectives.
            </template>
          </UFormField>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <UFormField>
              <template #label>
                <div class="flex items-center gap-2 text-base font-semibold">
                  <UIcon name="i-heroicons-calendar" class="w-5 h-5 text-primary" />
                  Goal Deadline
                </div>
              </template>
              <UInput v-model="deadline" type="date" size="xl" class="w-full" />
            </UFormField>

            <UFormField>
              <template #label>
                <div class="flex items-center gap-2 text-base font-semibold">
                  <UIcon name="i-heroicons-flag" class="w-5 h-5 text-primary" />
                  Priority
                </div>
              </template>
              <USelect
                v-model="form.priority"
                :items="[
                  { label: '🔥 High Priority', value: 'HIGH' },
                  { label: '⚖️ Medium Priority', value: 'MEDIUM' },
                  { label: '🌱 Low Priority', value: 'LOW' }
                ]"
                size="xl"
                class="w-full"
              />
            </UFormField>
          </div>
        </div>

        <!-- Goal Type Specific Targets -->
        <div
          class="p-4 bg-primary/5 dark:bg-primary/10 rounded-xl border border-primary/10 space-y-6"
        >
          <div v-if="selectedType === 'EVENT'" class="space-y-6">
            <UFormField>
              <template #label>
                <div class="flex items-center gap-2 font-medium">
                  <UIcon name="i-heroicons-trophy" class="w-4 h-4 text-muted" />
                  Event Type
                </div>
              </template>
              <USelect v-model="form.eventType" :items="eventSubTypes" size="xl" class="w-full" />
            </UFormField>
          </div>

          <div v-else-if="selectedType === 'BODY_COMPOSITION'" class="space-y-6">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <UFormField>
                <template #label>
                  <div class="flex items-center gap-2 font-medium">
                    <UIcon name="i-heroicons-scale" class="w-4 h-4 text-muted" />
                    Start Weight (kg)
                  </div>
                </template>
                <UInputNumber
                  v-model="form.startValue"
                  size="xl"
                  placeholder="90.0"
                  class="w-full"
                />
              </UFormField>
              <UFormField>
                <template #label>
                  <div class="flex items-center gap-2 font-medium">
                    <UIcon name="i-heroicons-arrow-trending-down" class="w-4 h-4 text-muted" />
                    Target Weight (kg)
                  </div>
                </template>
                <UInputNumber
                  v-model="form.targetValue"
                  size="xl"
                  placeholder="85.0"
                  class="w-full"
                />
              </UFormField>
            </div>
          </div>

          <div v-else-if="selectedType === 'PERFORMANCE'" class="space-y-6">
            <UFormField>
              <template #label>
                <div class="flex items-center gap-2 font-medium">
                  <UIcon name="i-heroicons-chart-bar" class="w-4 h-4 text-muted" />
                  Metric to Improve
                </div>
              </template>
              <USelect
                v-model="form.metric"
                :items="[
                  'FTP (Watts)',
                  'VO2 Max',
                  '5k Pace (min/km)',
                  '10k Pace (min/km)',
                  'Max Heart Rate'
                ]"
                size="xl"
                class="w-full"
              />
            </UFormField>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <UFormField>
                <template #label>
                  <div class="flex items-center gap-2 font-medium">
                    <UIcon name="i-heroicons-arrow-right-circle" class="w-4 h-4 text-muted" />
                    Current Value
                  </div>
                </template>
                <UInputNumber
                  v-model="form.startValue"
                  size="xl"
                  placeholder="250"
                  class="w-full"
                />
              </UFormField>
              <UFormField>
                <template #label>
                  <div class="flex items-center gap-2 font-medium">
                    <UIcon name="i-heroicons-bolt" class="w-4 h-4 text-muted" />
                    Target Value
                  </div>
                </template>
                <UInputNumber
                  v-model="form.targetValue"
                  size="xl"
                  placeholder="275"
                  class="w-full"
                />
              </UFormField>
            </div>
          </div>

          <div v-else-if="selectedType === 'CONSISTENCY'" class="space-y-6">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <UFormField class="sm:col-span-2">
                <template #label>
                  <div class="flex items-center gap-2 font-medium">
                    <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 text-muted" />
                    Weekly Commitment
                  </div>
                </template>
                <UInputNumber
                  v-model="form.targetValue"
                  size="xl"
                  placeholder="10"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="Metric">
                <USelect
                  v-model="form.metric"
                  :items="['Hours', 'Workouts', 'TSS']"
                  size="xl"
                  class="w-full"
                />
              </UFormField>
            </div>
            <p class="text-xs text-muted italic flex items-center gap-1">
              <UIcon name="i-heroicons-information-circle" class="w-4 h-4" />
              This sets a target date for building this habit and maintaining this level.
            </p>
          </div>
        </div>

        <!-- Event Summary (Already selected in Step 2) -->
        <template v-if="selectedType === 'EVENT'">
          <div class="space-y-4">
            <div class="flex items-center justify-between px-1">
              <h4 class="text-sm font-medium text-gray-500 uppercase tracking-wider">
                Linked Events ({{ selectedEvents.length }})
              </h4>
              <UButton
                v-if="isEditMode"
                variant="ghost"
                color="primary"
                size="xs"
                icon="i-heroicons-pencil-square"
                @click="
                  () => {
                    step = 2
                  }
                "
              >
                Manage Events
              </UButton>
            </div>
            <div
              v-for="event in selectedEvents"
              :key="event.id"
              class="p-4 bg-gray-50 hover:bg-gray-100 dark:bg-gray-800/50 dark:hover:bg-gray-800/80 rounded-xl border border-gray-200 dark:border-gray-700 relative overflow-hidden cursor-pointer transition-colors group/event"
              @click="
                () => {
                  void openEventUrl(event.id)
                }
              "
            >
              <div class="absolute top-0 right-0 p-2 opacity-10">
                <UIcon name="i-heroicons-calendar" class="w-12 h-12" />
              </div>

              <div class="flex items-center justify-between mb-3 relative z-10">
                <div
                  class="font-bold text-gray-900 dark:text-white group-hover/event:text-primary transition-colors"
                >
                  {{ event.title }}
                </div>
                <UIcon
                  name="i-heroicons-arrow-top-right-on-square"
                  class="w-4 h-4 text-muted group-hover/event:text-primary transition-colors"
                />
              </div>

              <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 relative z-10">
                <div>
                  <span class="text-[10px] text-muted block uppercase font-bold">Date</span>
                  <span class="text-sm font-medium">{{ formatDate(event.date) }}</span>
                </div>
                <div>
                  <span class="text-[10px] text-muted block uppercase font-bold">Type</span>
                  <span class="text-sm font-medium">{{ event.type || 'N/A' }}</span>
                </div>
                <div>
                  <span class="text-[10px] text-muted block uppercase font-bold">Distance</span>
                  <span class="text-sm font-medium">{{ formatDistance(event) }}</span>
                </div>
                <div>
                  <span class="text-[10px] text-muted block uppercase font-bold">Elevation</span>
                  <span class="text-sm font-medium">{{
                    event.elevation ? `${event.elevation} m` : 'N/A'
                  }}</span>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- Description Group -->
        <div
          class="p-4 bg-gray-50/50 dark:bg-gray-800/20 rounded-xl border border-gray-100 dark:border-gray-800"
        >
          <UFormField>
            <template #label>
              <div class="flex items-center gap-2 text-base font-semibold">
                <UIcon name="i-heroicons-pencil-square" class="w-5 h-5 text-primary" />
                Notes & Motivation (Optional)
              </div>
            </template>
            <UTextarea
              v-model="form.description"
              placeholder="Add some details about why this goal is important, specific sub-goals, or motivation..."
              :rows="5"
              size="xl"
              class="w-full"
            />
          </UFormField>
        </div>

        <div class="pt-6 flex justify-end">
          <UButton
            size="xl"
            color="primary"
            :loading="saving"
            icon="i-heroicons-check"
            class="px-10 font-bold"
            @click="
              () => {
                void saveGoal()
              }
            "
          >
            {{ isEditMode ? 'Update Goal' : 'Create Goal' }}
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  const props = defineProps<{
    goal?: any
    hideApproach?: boolean
  }>()

  const emit = defineEmits(['close', 'created', 'updated'])
  const { formatDate, formatDateUTC, getUserLocalDate, getUserDateFromLocal, timezone } =
    useFormat()

  const isEditMode = computed(() => !!props.goal)
  const step = ref(1)
  const selectedType = ref('')
  const eventSource = ref('manual') // 'manual' or 'calendar'
  const userEvents = ref<any[]>([])
  const loadingEvents = ref(false)
  const saving = ref(false)

  const form = reactive({
    title: '',
    description: '',
    priority: 'MEDIUM',
    startValue: undefined as number | undefined,
    targetValue: undefined as number | undefined,
    targetDate: undefined as string | undefined,
    eventDate: undefined as string | undefined,
    eventType: 'Road Race',
    distance: undefined as number | undefined,
    elevation: undefined as number | undefined,
    expectedDuration: undefined as number | undefined,
    terrain: 'Rolling',
    phase: 'BASE',
    metric: '',
    eventId: undefined as string | undefined,
    eventIds: [] as string[],
    externalId: undefined as string | undefined,
    source: undefined as string | undefined
  })

  const goalTypes = [
    {
      id: 'EVENT',
      label: 'Event Preparation',
      description: 'Prepare for a specific race or event.',
      icon: 'i-heroicons-calendar',
      color: 'bg-purple-100 text-purple-600 dark:bg-purple-900/30'
    },
    {
      id: 'BODY_COMPOSITION',
      label: 'Body Composition',
      description: 'Lose weight, gain muscle, or maintain.',
      icon: 'i-heroicons-scale',
      color: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30'
    },
    {
      id: 'PERFORMANCE',
      label: 'Performance',
      description: 'Improve FTP, VO2 Max, or pace.',
      icon: 'i-heroicons-bolt',
      color: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30'
    },
    {
      id: 'CONSISTENCY',
      label: 'Consistency',
      description: 'Build habits like weekly hours or frequency.',
      icon: 'i-heroicons-arrow-path',
      color: 'bg-green-100 text-green-600 dark:bg-green-900/30'
    }
  ]

  const eventSubTypes = [
    'Road Race',
    'Criterium',
    'Time Trial',
    'Gran Fondo',
    'MTB (XC)',
    'MTB (Marathon)',
    'Gravel',
    'Cyclocross',
    'Social Ride',
    { label: 'Cyclotour (Toertocht)', value: 'Cyclotour' },
    'Running (5k)',
    'Running (10k)',
    'Half Marathon',
    'Marathon',
    'Ultra',
    'Triathlon (Sprint)',
    'Triathlon (Olympic)',
    'Triathlon (70.3)',
    'Triathlon (Full)'
  ]

  const priorityOptions = [
    {
      value: 'HIGH',
      label: 'High Priority',
      description: 'This goal takes precedence over others in your training plan.',
      icon: 'i-heroicons-arrow-up',
      color: 'text-red-500'
    },
    {
      value: 'MEDIUM',
      label: 'Medium Priority',
      description: 'Important, but balanced with other objectives.',
      icon: 'i-heroicons-minus',
      color: 'text-amber-500'
    },
    {
      value: 'LOW',
      label: 'Low Priority',
      description: 'Nice to have, but flexible if conflicts arise.',
      icon: 'i-heroicons-arrow-down',
      color: 'text-green-500'
    }
  ]

  const trainingPhases = [
    {
      id: 'BASE',
      label: 'Base',
      description: 'Build aerobic foundation and muscular endurance.',
      icon: 'i-heroicons-square-3-stack-3d'
    },
    {
      id: 'BUILD',
      label: 'Build',
      description: 'Raise FTP and improve specific race intensities.',
      icon: 'i-heroicons-chart-bar'
    },
    {
      id: 'SPECIALTY',
      label: 'Specialty / Peak',
      description: 'Maximum specificity and race simulation.',
      icon: 'i-heroicons-sparkles'
    },
    {
      id: 'TRANSITION',
      label: 'Transition',
      description: 'Unstructured maintenance and recovery.',
      icon: 'i-heroicons-sun'
    }
  ]

  const selectedTypeLabel = computed(
    () => goalTypes.find((t) => t.id === selectedType.value)?.label || ''
  )

  const selectedEvents = computed(() => {
    return userEvents.value.filter((e) => form.eventIds.includes(e.id))
  })

  function formatDistance(event: { distance?: number | null }) {
    const distance = event.distance ?? props.goal?.distance
    return distance == null ? 'N/A' : `${distance} km`
  }

  // Proxy to handle unified date input in Step 3
  // Decoupled from eventDate to avoid confusing side effects when editing goals
  const deadline = computed({
    get: () => form.targetDate,
    set: (val) => {
      form.targetDate = val
    }
  })

  const phaseRecommendation = computed(() => {
    if (!form.eventDate) return "We'll suggest a phase once you set an event date."

    const today = getUserLocalDate()
    const event = new Date(form.eventDate)
    const weeksToEvent = Math.ceil((event.getTime() - today.getTime()) / (1000 * 60 * 60 * 24 * 7))

    if (weeksToEvent > 12)
      return `You have ${weeksToEvent} weeks. We recommend starting with a **Base Phase**.`
    if (weeksToEvent > 4)
      return `You have ${weeksToEvent} weeks. We recommend moving into the **Build Phase**.`
    if (weeksToEvent > 0)
      return `Race is only ${weeksToEvent} weeks away! Time for **Specialty and Peak** work.`
    return 'The event date has already passed.'
  })

  async function fetchUserEvents() {
    eventSource.value = 'calendar'
    loadingEvents.value = true
    try {
      const data = (await ($fetch as any)('/api/events')) as any[]
      userEvents.value = data
    } catch (error) {
      console.error('Failed to fetch events', error)
    } finally {
      loadingEvents.value = false
    }
  }

  function toggleUserEvent(event: any) {
    const index = form.eventIds.indexOf(event.id)
    if (index === -1) {
      form.eventIds.push(event.id)
    } else {
      form.eventIds.splice(index, 1)
    }

    // Update form details based on the LAST selected event (as primary)
    if (form.eventIds.length > 0) {
      const lastId = form.eventIds[form.eventIds.length - 1]
      const primaryEvent = userEvents.value.find((e) => e.id === lastId)

      if (primaryEvent) {
        // If multiple, maybe generic title?
        if (form.eventIds.length > 1) {
          form.title = `${primaryEvent.title} and others`
        } else {
          form.title = primaryEvent.title
        }

        form.eventDate = new Date(primaryEvent.date).toISOString().split('T')[0]
        form.targetDate = form.eventDate // Initialize goal deadline with event date
        form.description = primaryEvent.description || ''
        form.eventId = primaryEvent.id // Keep for compat

        form.distance = primaryEvent.distance ?? undefined
        form.elevation = primaryEvent.elevation ?? undefined
        form.expectedDuration = primaryEvent.expectedDuration ?? undefined
        form.eventType = primaryEvent.type ?? 'Road Race'
        form.terrain = primaryEvent.terrain ?? 'Rolling'
      }
    } else {
      // Reset if empty
      form.eventId = undefined
      form.title = ''
    }
  }

  function selectType(id: string) {
    selectedType.value = id
    if (id === 'EVENT') {
      step.value = 2
      fetchUserEvents()
    } else {
      step.value = 3
    }
  }

  function openEventUrl(eventId: string) {
    window.open(`/events/${eventId}`, '_blank')
  }

  async function saveGoal() {
    saving.value = true

    // Construct AI Context
    let aiContext = `Type: ${selectedType.value}. Goal: ${form.title}. Phase Preference: ${form.phase}.`
    if (selectedType.value === 'EVENT') {
      aiContext += ` Race Type: ${form.eventType}. Distance: ${form.distance}km. Elevation: ${form.elevation}m. Terrain: ${form.terrain}. Expected Duration: ${form.expectedDuration}h.`
    }

    // Construct Payload
    const payload: any = {
      title: form.title,
      description: form.description,
      priority: form.priority,
      startValue: form.startValue,
      targetValue: form.targetValue,
      type: selectedType.value,
      aiContext,
      metric: form.metric,
      phase: form.phase,
      eventId: form.eventId,
      eventIds: form.eventIds,
      targetDate: form.targetDate
        ? getUserDateFromLocal(form.targetDate, '23:59:59').toISOString()
        : undefined
    }

    // Handle Event Specifics
    if (selectedType.value === 'EVENT') {
      // Only send event metadata during creation or if explicitly overriding
      // In edit mode, we only want to update the GOAL itself, not the linked EVENT
      if (!isEditMode.value) {
        if (form.eventDate) {
          payload.eventDate = getUserDateFromLocal(form.eventDate, '00:00:00').toISOString()
        }
        payload.eventType = form.eventType
        payload.distance = form.distance
        payload.elevation = form.elevation
        payload.duration = form.expectedDuration
        payload.terrain = form.terrain

        // If no existing event was selected, we can still create one via eventData
        if (!form.eventId && (form.externalId || form.eventDate)) {
          payload.eventData = {
            externalId: form.externalId,
            source: form.source,
            title: form.title,
            date: payload.eventDate || payload.targetDate,
            subType: form.eventType,
            distance: form.distance,
            elevation: form.elevation,
            expectedDuration: form.expectedDuration,
            terrain: form.terrain
          }
        }
      }
    }

    try {
      if (isEditMode.value) {
        await $fetch<any, string & {}>(`/api/goals/${props.goal.id}`, {
          method: 'PATCH',
          body: payload
        })
        emit('updated')
      } else {
        await $fetch<any, string & {}>('/api/goals', { method: 'POST', body: payload })
        emit('created')
      }
      emit('close')
    } catch (error) {
      console.error('Failed to save goal', error)
    } finally {
      saving.value = false
    }
  }

  watchEffect(() => {
    if (props.goal) {
      selectedType.value = props.goal.type
      form.title = props.goal.title || ''
      form.description = props.goal.description || ''
      form.priority = props.goal.priority || 'MEDIUM'
      form.startValue = props.goal.startValue
      form.targetValue = props.goal.targetValue
      // Use UTC format to get local date string YYYY-MM-DD from absolute date
      // This prevents timezone shifting for date-only fields
      form.targetDate = props.goal.targetDate
        ? formatDateUTC(props.goal.targetDate, 'yyyy-MM-dd')
        : undefined
      form.eventDate = props.goal.eventDate
        ? formatDateUTC(props.goal.eventDate, 'yyyy-MM-dd')
        : undefined
      form.eventType = props.goal.eventType || 'Road Race'
      form.distance = props.goal.distance
      form.elevation = props.goal.elevation
      form.expectedDuration = props.goal.duration
      form.terrain = props.goal.terrain || 'Rolling'
      form.phase = props.goal.phase || 'BASE'
      form.eventId = props.goal.eventId
      form.eventIds =
        props.goal.events?.map((e: any) => e.id) || (props.goal.eventId ? [props.goal.eventId] : []) // Note: events relation usually returns Event objects with id, not join table with eventId

      if (selectedType.value === 'EVENT') {
        fetchUserEvents()
      }
      step.value = 3
    }
  })
</script>
