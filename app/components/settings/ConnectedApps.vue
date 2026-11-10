<template>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <!-- Intervals.icu -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img
            src="/images/logos/intervals.png"
            alt="Intervals.icu Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">Intervals.icu</h3>
          <p class="text-sm text-muted">Power data and training calendar</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!intervalsConnected" class="flex flex-col items-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('intervals')
                signIn('intervals')
              }
            "
          >
            Connect
          </UButton>
          <UButton
            color="neutral"
            variant="link"
            size="xs"
            :padded="false"
            @click="
              () => {
                trackIntegrationConnectStart('intervals')
                navigateTo('/connect-intervals')
              }
            "
          >
            Connect manually (API Key)
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('intervals')"
            @click="
              () => {
                void $emit('sync', 'intervals')
              }
            "
          >
            Sync Now
          </UButton>

          <UDropdownMenu :items="intervalsActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- WHOOP -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img
            src="/images/logos/whoop_square.svg"
            alt="WHOOP Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">WHOOP</h3>
          <p class="text-sm text-muted">Recovery, sleep, and strain data</p>
        </div>
      </div>

      <div class="flex flex-col gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto">
        <div class="flex items-center justify-end gap-2">
          <div v-if="!whoopConnected">
            <UTooltip
              :text="isWhoopDisabled ? 'WHOOP integration is temporarily unavailable' : ''"
              :popper="{ placement: 'top' }"
            >
              <UButton
                color="neutral"
                variant="outline"
                :disabled="isWhoopDisabled"
                @click="
                  () => {
                    if (isWhoopDisabled) return
                    trackIntegrationConnectStart('whoop')
                    navigateTo('/connect-whoop')
                  }
                "
              >
                {{ isWhoopDisabled ? 'Temporarily unavailable' : 'Connect' }}
              </UButton>
            </UTooltip>
          </div>
          <div v-else class="flex items-center gap-2">
            <UButton
              color="success"
              variant="solid"
              size="sm"
              class="font-bold"
              icon="i-heroicons-arrow-path"
              :loading="syncingProviders.has('whoop')"
              @click="
                () => {
                  void $emit('sync', 'whoop')
                }
              "
            >
              Sync Now
            </UButton>
            <UDropdownMenu :items="whoopActions">
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-heroicons-ellipsis-vertical"
              />
            </UDropdownMenu>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Oura -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img src="/images/logos/oura.svg" alt="Oura Logo" class="w-full h-full object-cover" />
        </div>
        <div>
          <h3 class="font-semibold">Oura</h3>
          <p class="text-sm text-muted">Readiness, sleep, and activity data</p>
        </div>
      </div>

      <div class="flex flex-col gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto">
        <div class="flex items-center justify-end gap-2">
          <div v-if="!ouraConnected">
            <UButton
              color="neutral"
              variant="outline"
              @click="
                () => {
                  trackIntegrationConnectStart('oura')
                  navigateTo('/connect-oura')
                }
              "
            >
              Connect
            </UButton>
          </div>
          <div v-else class="flex items-center gap-2">
            <UButton
              color="success"
              variant="solid"
              size="sm"
              class="font-bold"
              icon="i-heroicons-arrow-path"
              :loading="syncingProviders.has('oura')"
              @click="
                () => {
                  void $emit('sync', 'oura')
                }
              "
            >
              Sync Now
            </UButton>
            <UDropdownMenu :items="ouraActions">
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-heroicons-ellipsis-vertical"
              />
            </UDropdownMenu>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Withings -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img
            src="/images/logos/withings.png"
            alt="Withings Logo"
            class="w-8 h-8 object-contain"
          />
        </div>
        <div>
          <h3 class="font-semibold">Withings</h3>
          <p class="text-sm text-muted">Weight, body composition, and health metrics</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!withingsConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('withings')
                navigateTo('/connect-withings')
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('withings')"
            @click="
              () => {
                void $emit('sync', 'withings')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="withingsActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Yazio -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img
            src="/images/logos/yazio_square.webp"
            alt="Yazio Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">Yazio</h3>
          <p class="text-sm text-muted">Nutrition tracking and meal planning</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!yazioConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('yazio')
                navigateTo('/connect-yazio')
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('yazio')"
            @click="
              () => {
                void $emit('sync', 'yazio')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="yazioActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Fitbit -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img
            src="/images/logos/fitbit_square.png"
            alt="Fitbit Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">Fitbit</h3>
          <p class="text-sm text-muted">Nutrition history and food logs</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!fitbitConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('fitbit')
                navigateTo('/connect-fitbit')
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('fitbit')"
            @click="
              () => {
                void $emit('sync', 'fitbit')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="fitbitActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Hevy -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img src="/images/logos/hevy-icon.png" alt="Hevy Logo" class="w-8 h-8 object-contain" />
        </div>
        <div>
          <h3 class="font-semibold">Hevy</h3>
          <p class="text-sm text-muted">Strength training and workout logging</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!hevyConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('hevy')
                navigateTo('/connect-hevy')
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('hevy')"
            @click="
              () => {
                void $emit('sync', 'hevy')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="hevyActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Liftosaur -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div class="w-12 h-12 flex items-center justify-center shrink-0 overflow-hidden rounded-lg">
          <img
            src="/images/logos/liftosaur.svg"
            alt="Liftosaur Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">Liftosaur</h3>
          <p class="text-sm text-muted">Strength workouts and body measurements</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!liftosaurConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('liftosaur')
                navigateTo('/connect-liftosaur')
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('liftosaur')"
            @click="
              () => {
                void $emit('sync', 'liftosaur')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="liftosaurActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Garmin -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div class="w-12 h-12 flex items-center justify-center shrink-0 overflow-hidden">
          <img
            src="/images/logos/Garmin_Connect_app_1024x1024.png"
            alt="Garmin Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">Garmin</h3>
          <p class="text-sm text-muted">
            Direct sync for activities and health metrics, plus manual workout send from planned
            workout details
          </p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!garminConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('garmin')
                navigateTo('/api/integrations/garmin/authorize', { external: true })
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('garmin')"
            @click="
              () => {
                void $emit('sync', 'garmin')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="garminActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Wahoo -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img
            src="/images/logos/wahoo_logo_square.jpeg"
            alt="Wahoo Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">Wahoo</h3>
          <p class="text-sm text-muted">Activities and planned workouts sync</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!wahooConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('wahoo')
                navigateTo('/api/integrations/wahoo/authorize', { external: true })
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('wahoo')"
            @click="
              () => {
                void $emit('sync', 'wahoo')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="wahooActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Polar -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img
            src="/images/logos/polar_logo_square.png"
            alt="Polar Logo"
            class="w-8 h-8 object-contain"
          />
        </div>
        <div>
          <h3 class="font-semibold">Polar</h3>
          <p class="text-sm text-muted">Activities, sleep, and nightly recharge</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!polarConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('polar')
                navigateTo('/api/integrations/polar/authorize', { external: true })
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('polar')"
            @click="
              () => {
                void $emit('sync', 'polar')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="polarActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Strava -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <img
            src="/images/logos/strava.svg"
            alt="Strava Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">Strava</h3>
          <p class="text-sm text-muted">Activities and performance tracking</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!stravaConnected">
          <UTooltip
            :text="isStravaDisabled ? 'Strava integration is temporarily unavailable' : ''"
            :popper="{ placement: 'top' }"
          >
            <UButton
              color="neutral"
              variant="outline"
              :disabled="isStravaDisabled"
              @click="
                () => {
                  if (isStravaDisabled) return
                  trackIntegrationConnectStart('strava')
                  signIn('strava')
                }
              "
            >
              {{ isStravaDisabled ? 'Temporarily unavailable' : 'Connect' }}
            </UButton>
          </UTooltip>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('strava')"
            @click="
              () => {
                void $emit('sync', 'strava')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="stravaActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- ROUVY -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div class="w-12 h-12 flex items-center justify-center shrink-0 overflow-hidden">
          <img
            src="/images/logos/rouvy-symbol-rgb.svg"
            alt="ROUVY Logo"
            class="w-full h-full object-contain"
          />
        </div>
        <div>
          <h3 class="font-semibold">ROUVY</h3>
          <p class="text-sm text-muted">Indoor cycling activities and workouts</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!rouvyConnected">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                trackIntegrationConnectStart('rouvy')
                navigateTo('/api/integrations/rouvy/authorize', { external: true })
              }
            "
          >
            Connect
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-arrow-path"
            :loading="syncingProviders.has('rouvy')"
            @click="
              () => {
                void $emit('sync', 'rouvy')
              }
            "
          >
            Sync Now
          </UButton>
          <UDropdownMenu :items="rouvyActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <!-- Ultrahuman -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div class="w-12 h-12 flex items-center justify-center shrink-0 overflow-hidden">
          <img
            src="/images/logos/ultrahuman_logo.png"
            alt="Ultrahuman Logo"
            class="w-full h-full object-cover"
          />
        </div>
        <div>
          <h3 class="font-semibold">Ultrahuman</h3>
          <p class="text-sm text-muted">Metabolic health, sleep, and recovery data</p>
        </div>
      </div>

      <div class="flex flex-col gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto">
        <div class="flex items-center justify-end gap-2">
          <div v-if="!ultrahumanConnected">
            <UButton
              color="neutral"
              variant="outline"
              @click="
                () => {
                  trackIntegrationConnectStart('ultrahuman')
                  navigateTo('/api/integrations/ultrahuman/authorize', { external: true })
                }
              "
            >
              Connect
            </UButton>
          </div>
          <div v-else class="flex items-center gap-2">
            <UButton
              color="success"
              variant="solid"
              size="sm"
              class="font-bold"
              icon="i-heroicons-arrow-path"
              :loading="syncingProviders.has('ultrahuman')"
              @click="
                () => {
                  void $emit('sync', 'ultrahuman')
                }
              "
            >
              Sync Now
            </UButton>
            <UDropdownMenu :items="ultrahumanActions">
              <UButton
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-heroicons-ellipsis-vertical"
              />
            </UDropdownMenu>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Telegram -->
    <UCard :ui="{ body: 'flex flex-col h-full justify-between gap-4' }">
      <div class="flex items-start gap-4">
        <div
          class="w-12 h-12 bg-white rounded-lg flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-gray-200 dark:ring-gray-700"
        >
          <UIcon name="i-simple-icons-telegram" class="w-8 h-8 text-[#26A5E4]" />
        </div>
        <div>
          <h3 class="font-semibold">Telegram</h3>
          <p class="text-sm text-muted">Chat with your AI Coach on the go</p>
        </div>
      </div>

      <div
        class="flex items-center justify-end gap-2 pt-4 border-t border-gray-100 dark:border-gray-800 mt-auto"
      >
        <div v-if="!telegramConnected">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-heroicons-paper-airplane"
            @click="
              () => {
                trackIntegrationConnectStart('telegram')
                $emit('connect-telegram')
              }
            "
          >
            Connect Bot
          </UButton>
        </div>
        <div v-else class="flex items-center gap-2">
          <UButton
            color="success"
            variant="solid"
            size="sm"
            class="font-bold"
            icon="i-heroicons-check-circle"
          >
            Connected
          </UButton>

          <UDropdownMenu :items="telegramActions">
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-heroicons-ellipsis-vertical"
            />
          </UDropdownMenu>
        </div>
      </div>
    </UCard>

    <UModal
      v-model:open="advancedSyncModalOpen"
      :title="`${advancedSyncProviderName} Advanced Sync`"
      description="Select the historical range for data synchronization."
    >
      <template #body>
        <div class="space-y-4">
          <p>
            Select how many days of historical data you would like to sync from
            {{ advancedSyncProviderName }}.
          </p>
          <USelectMenu
            v-model="selectedDays"
            :items="[
              { label: 'Last 30 Days', value: 30 },
              { label: 'Last 90 Days', value: 90 },
              { label: 'Last 180 Days', value: 180 },
              { label: 'Last 365 Days', value: 365 },
              { label: 'All Time (10 Years)', value: 3650 }
            ]"
            value-key="value"
            label-key="label"
            placeholder="Select duration"
          />
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                advancedSyncModalOpen = false
              }
            "
          >
            Cancel
          </UButton>
          <UButton
            color="primary"
            :disabled="!selectedDays"
            @click="
              () => {
                $emit('sync', advancedSyncProvider, selectedDays)
                advancedSyncModalOpen = false
              }
            "
          >
            Sync
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="ultrahumanAdvancedSyncModalOpen"
      title="Ultrahuman Advanced Sync"
      description="Select the historical range for data synchronization."
    >
      <template #body>
        <div class="space-y-4">
          <p>Select how many days of historical data you would like to sync from Ultrahuman.</p>
          <USelectMenu
            v-model="selectedDays"
            :items="[
              { label: 'Last 30 Days', value: 30 },
              { label: 'Last 90 Days', value: 90 },
              { label: 'Last 180 Days', value: 180 },
              { label: 'Last 365 Days', value: 365 }
            ]"
            value-key="value"
            label-key="label"
            placeholder="Select duration"
          />
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            @click="
              () => {
                ultrahumanAdvancedSyncModalOpen = false
              }
            "
          >
            Cancel
          </UButton>
          <UButton
            color="primary"
            :disabled="!selectedDays"
            @click="
              () => {
                $emit('sync', 'ultrahuman', selectedDays)
                ultrahumanAdvancedSyncModalOpen = false
              }
            "
          >
            Sync
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="intervalsSettingsModalOpen"
      title="Intervals.icu Settings"
      description="Configure data mapping and synchronization preferences for Intervals.icu."
    >
      <template #body>
        <div class="space-y-6 sm:min-w-[400px]">
          <UFormField
            label="Readiness Score Scale"
            description="How should we interpret the 'readiness' value from Intervals.icu?"
          >
            <USelectMenu
              :model-value="getProviderSettings('intervals')?.readinessScale || 'STANDARD'"
              :items="[
                { label: 'Standard (0-100)', value: 'STANDARD' },
                { label: '10-Point Scale (1-10)', value: 'TEN_POINT' },
                { label: 'Polar Scale (1-6)', value: 'POLAR' },
                { label: 'HRV4Training (Absolute)', value: 'HRV4TRAINING' }
              ]"
              class="w-full"
              @update:model-value="
                (item: any) =>
                  $emit('updateSetting', 'intervals', 'settings', {
                    ...getProviderSettings('intervals'),
                    readinessScale: item.value
                  })
              "
            />
          </UFormField>

          <UFormField
            label="Sleep Score Scale"
            description="How should we interpret the 'sleep score' value from Intervals.icu?"
          >
            <USelectMenu
              :model-value="getProviderSettings('intervals')?.sleepScoreScale || 'STANDARD'"
              :items="[
                { label: 'Standard (0-100)', value: 'STANDARD' },
                { label: '10-Point Scale (1-10)', value: 'TEN_POINT' },
                { label: 'Polar Scale (1-6)', value: 'POLAR' }
              ]"
              class="w-full"
              @update:model-value="
                (item: any) =>
                  $emit('updateSetting', 'intervals', 'settings', {
                    ...getProviderSettings('intervals'),
                    sleepScoreScale: item.value
                  })
              "
            />
          </UFormField>

          <UFormField
            label="Planned Workouts Sync"
            description="Enable bidirectional synchronization of planned workouts with Intervals.icu."
          >
            <UCheckbox
              :model-value="getProviderSettings('intervals')?.importPlannedWorkouts !== false"
              label="Enable Sync"
              @update:model-value="
                (checked: any) =>
                  $emit('updateSetting', 'intervals', 'settings', {
                    ...getProviderSettings('intervals'),
                    importPlannedWorkouts: !!checked
                  })
              "
            />
          </UFormField>

          <UFormField
            label="Activities"
            description="Import completed activities from Intervals.icu."
          >
            <UCheckbox
              :model-value="intervalsIngestWorkouts"
              label="Ingest Activities"
              @update:model-value="
                (checked: any) => $emit('updateSetting', 'intervals', 'ingestWorkouts', !!checked)
              "
            />
          </UFormField>

          <UFormField
            label="Wellness"
            description="Import readiness, sleep, weight, and other wellness metrics from Intervals.icu."
          >
            <UCheckbox
              :model-value="isProviderSettingEnabled('intervals', 'ingestWellness')"
              label="Ingest Wellness Data"
              @update:model-value="
                (checked: any) => updateProviderSetting('intervals', 'ingestWellness', !!checked)
              "
            />
          </UFormField>

          <UFormField
            label="Configure Sports Auto-sync"
            description="When you manually sync Intervals.icu, automatically refresh sport-specific thresholds and zones (Configure Sports Auto-detect)."
          >
            <UCheckbox
              :model-value="
                getProviderSettings('intervals')?.autoSyncSportSettingsOnManualSync === true
              "
              label="Auto-sync sport settings on manual sync"
              @update:model-value="
                (checked: any) =>
                  $emit('updateSetting', 'intervals', 'settings', {
                    ...getProviderSettings('intervals'),
                    autoSyncSportSettingsOnManualSync: !!checked
                  })
              "
            />
          </UFormField>

          <p class="text-xs text-muted">
            Note: Changing these settings only affects future data syncs. Existing records in the
            database will not be updated automatically.
          </p>
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end">
          <UButton
            color="neutral"
            variant="soft"
            @click="
              () => {
                intervalsSettingsModalOpen = false
              }
            "
          >
            Close
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="providerSettingsModalOpen"
      :title="selectedProviderSettings?.title"
      :description="selectedProviderSettings?.description"
    >
      <template #body>
        <div v-if="selectedProviderSettings" class="space-y-6 sm:min-w-[400px]">
          <UFormField
            v-for="option in selectedProviderOptions"
            :key="`${selectedProviderKey}-${option.key}`"
            :label="option.title"
            :description="option.description"
          >
            <template v-if="option.type === 'select'">
              <USelectMenu
                :model-value="getProviderOptionValue(selectedProviderKey, option)"
                :items="option.options || []"
                class="w-full"
                value-key="value"
                @update:model-value="
                  (value: any) =>
                    updateProviderOption(selectedProviderKey, option, value?.value ?? value)
                "
              />
            </template>
            <template v-else-if="option.type === 'switch'">
              <USwitch
                :model-value="getProviderOptionValue(selectedProviderKey, option)"
                :label="option.label"
                @update:model-value="
                  (checked: any) => updateProviderOption(selectedProviderKey, option, !!checked)
                "
              />
            </template>
            <template v-else>
              <UCheckbox
                :model-value="getProviderOptionValue(selectedProviderKey, option)"
                :label="option.label"
                @update:model-value="
                  (checked: any) => updateProviderOption(selectedProviderKey, option, !!checked)
                "
              />
            </template>
          </UFormField>

          <p class="text-xs text-muted">
            Changes apply to future syncs and webhooks. Existing imported records stay unchanged.
          </p>
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end">
          <UButton
            color="neutral"
            variant="soft"
            @click="
              () => {
                providerSettingsModalOpen = false
              }
            "
          >
            Close
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
  type ProviderSettingOption =
    | {
        key: string
        title: string
        description: string
        label: string
        target: 'root'
        type?: 'switch' | 'select'
        options?: { label: string; value: any }[]
      }
    | {
        key: string
        title: string
        description: string
        label: string
        target: 'settings'
        type?: 'switch' | 'select'
        options?: { label: string; value: any }[]
      }

  type ProviderSettingsDefinition = {
    provider: string
    title: string
    description: string
    options: ProviderSettingOption[]
  }

  const props = defineProps<{
    intervalsConnected: boolean
    intervalsIngestWorkouts: boolean
    whoopConnected: boolean
    whoopIngestWorkouts: boolean
    ouraConnected: boolean
    ouraIngestWorkouts: boolean
    withingsConnected: boolean
    withingsIngestWorkouts: boolean
    yazioConnected: boolean
    fitbitConnected: boolean
    stravaConnected: boolean
    stravaIngestWorkouts: boolean
    rouvyConnected: boolean
    hevyConnected: boolean
    hevyIngestWorkouts: boolean
    liftosaurConnected: boolean
    liftosaurIngestWorkouts: boolean
    polarConnected: boolean
    polarIngestWorkouts: boolean
    garminConnected: boolean
    garminIngestWorkouts: boolean
    ultrahumanConnected: boolean
    ultrahumanIngestWorkouts: boolean
    telegramConnected: boolean
    syncingProviders: Set<string>
    integrationSettings: Record<string, any>
    wahooConnected: boolean
    wahooIngestWorkouts: boolean
  }>()

  const { signIn } = useAuth()
  const { trackIntegrationConnectStart } = useAnalytics()
  const advancedSyncModalOpen = ref(false)
  const advancedSyncProvider = ref<'intervals' | 'liftosaur'>('intervals')
  const advancedSyncProviderName = computed(() =>
    advancedSyncProvider.value === 'liftosaur' ? 'Liftosaur' : 'Intervals.icu'
  )
  const ultrahumanAdvancedSyncModalOpen = ref(false)
  const intervalsSettingsModalOpen = ref(false)
  const providerSettingsModalOpen = ref(false)
  const selectedProvider = ref<string | null>(null)
  const selectedDays = ref<number | undefined>()
  const emit = defineEmits<{
    disconnect: [provider: string]
    sync: [provider: string, days?: number]
    'sync-profile': [provider: string]
    'connect-telegram': []
    updateSetting: [provider: string, setting: string, value: any]
  }>()

  const providerSettingsDefinitions: Record<string, ProviderSettingsDefinition> = {
    whoop: {
      provider: 'whoop',
      title: 'WHOOP Settings',
      description: 'Choose which WHOOP data Coach Watts should import.',
      options: [
        {
          key: 'ingestWorkouts',
          title: 'Activities',
          description: 'Import completed workouts from WHOOP.',
          label: 'Ingest Activities',
          target: 'root'
        },
        {
          key: 'ingestWellness',
          title: 'Wellness',
          description: 'Import recovery and sleep metrics from WHOOP.',
          label: 'Ingest Wellness Data',
          target: 'settings'
        }
      ]
    },
    oura: {
      provider: 'oura',
      title: 'Oura Settings',
      description: 'Choose which Oura data Coach Watts should import.',
      options: [
        {
          key: 'ingestWorkouts',
          title: 'Activities',
          description: 'Import completed workouts from Oura.',
          label: 'Ingest Activities',
          target: 'root'
        },
        {
          key: 'ingestWellness',
          title: 'Wellness',
          description: 'Import sleep, readiness, activity, and other wellness metrics from Oura.',
          label: 'Ingest Wellness Data',
          target: 'settings'
        }
      ]
    },
    withings: {
      provider: 'withings',
      title: 'Withings Settings',
      description: 'Choose which Withings data Coach Watts should import.',
      options: [
        {
          key: 'ingestWorkouts',
          title: 'Activities',
          description: 'Import workouts and activity sessions from Withings.',
          label: 'Ingest Activities',
          target: 'root'
        },
        {
          key: 'ingestWellness',
          title: 'Wellness',
          description: 'Import body metrics, weight, and sleep data from Withings.',
          label: 'Ingest Wellness Data',
          target: 'settings'
        }
      ]
    },
    yazio: {
      provider: 'yazio',
      title: 'YAZIO Settings',
      description: 'Choose which YAZIO data Coach Watts should import.',
      options: [
        {
          key: 'ingestNutrition',
          title: 'Nutrition',
          description: 'Import daily nutrition logs and meal data from YAZIO.',
          label: 'Ingest Nutrition Data',
          target: 'settings'
        }
      ]
    },
    fitbit: {
      provider: 'fitbit',
      title: 'Fitbit Settings',
      description: 'Choose which Fitbit data Coach Watts should import.',
      options: [
        {
          key: 'ingestNutrition',
          title: 'Nutrition',
          description: 'Import food logs, water, and nutrition summaries from Fitbit.',
          label: 'Ingest Nutrition Data',
          target: 'settings'
        }
      ]
    },
    strava: {
      provider: 'strava',
      title: 'Strava Settings',
      description: 'Choose which Strava data Coach Watts should import.',
      options: [
        {
          key: 'ingestWorkouts',
          title: 'Activities',
          description: 'Import completed activities from Strava.',
          label: 'Ingest Activities',
          target: 'root'
        }
      ]
    },
    hevy: {
      provider: 'hevy',
      title: 'Hevy Settings',
      description: 'Choose which Hevy data Coach Watts should import.',
      options: [
        {
          key: 'ingestWorkouts',
          title: 'Activities',
          description: 'Import completed strength workouts from Hevy.',
          label: 'Ingest Activities',
          target: 'root'
        }
      ]
    },
    liftosaur: {
      provider: 'liftosaur',
      title: 'Liftosaur Settings',
      description: 'Choose which Liftosaur data Coach Watts should import.',
      options: [
        {
          key: 'ingestWorkouts',
          title: 'Completed workouts',
          description: 'Import completed strength workouts from Liftosaur.',
          label: 'Ingest Workouts',
          target: 'root'
        },
        {
          key: 'ingestMeasurements',
          title: 'Body measurements',
          description: 'Import bodyweight and body-fat measurements from Liftosaur.',
          label: 'Ingest Measurements',
          target: 'settings'
        }
      ]
    },
    polar: {
      provider: 'polar',
      title: 'Polar Settings',
      description: 'Choose which Polar data Coach Watts should import.',
      options: [
        {
          key: 'ingestWorkouts',
          title: 'Activities',
          description: 'Import completed workouts from Polar.',
          label: 'Ingest Activities',
          target: 'root'
        },
        {
          key: 'ingestWellness',
          title: 'Wellness',
          description: 'Import sleep and nightly recharge data from Polar.',
          label: 'Ingest Wellness Data',
          target: 'settings'
        }
      ]
    },
    garmin: {
      provider: 'garmin',
      title: 'Garmin Settings',
      description: 'Choose which Garmin data Coach Watts should import.',
      options: [
        {
          key: 'ingestWorkouts',
          title: 'Activities',
          description: 'Import completed activities from Garmin.',
          label: 'Ingest Activities',
          target: 'root'
        },
        {
          key: 'ingestWellness',
          title: 'Wellness',
          description: 'Import sleep, HRV, body metrics, and daily wellness data from Garmin.',
          label: 'Ingest Wellness Data',
          target: 'settings'
        }
      ]
    },
    ultrahuman: {
      provider: 'ultrahuman',
      title: 'Ultrahuman Settings',
      description: 'Choose which Ultrahuman data Coach Watts should import.',
      options: [
        {
          key: 'ingestWellness',
          title: 'Wellness',
          description: 'Import sleep, recovery, biometrics, and activity indexes from Ultrahuman.',
          label: 'Ingest Wellness Data',
          target: 'settings'
        },
        {
          key: 'autoSync',
          title: 'Daily Auto-Sync',
          description: 'Automatically sync your data in the background.',
          label: 'Enabled',
          target: 'settings',
          type: 'switch'
        },
        {
          key: 'preferredSyncTime',
          title: 'Preferred Sync Time',
          description: 'When should we perform the daily background sync?',
          label: 'Select Time',
          target: 'settings',
          type: 'select',
          options: Array.from({ length: 24 }, (_, i) => ({
            label: `${i.toString().padStart(2, '0')}:00`,
            value: `${i.toString().padStart(2, '0')}:00`
          }))
        }
      ]
    }
  }

  const selectedProviderSettings = computed(() =>
    selectedProvider.value ? providerSettingsDefinitions[selectedProvider.value] || null : null
  )
  const selectedProviderKey = computed(() => selectedProviderSettings.value?.provider || '')
  const selectedProviderOptions = computed(() => selectedProviderSettings.value?.options || [])

  function openProviderSettings(provider: string) {
    selectedProvider.value = provider
    providerSettingsModalOpen.value = true
  }

  function getProviderSettings(provider: string) {
    return props.integrationSettings?.[provider] || {}
  }

  function isProviderSettingEnabled(provider: string, key: 'ingestWellness' | 'ingestNutrition') {
    return getProviderSettings(provider)?.[key] !== false
  }

  function updateProviderSetting(
    provider: string,
    key: 'ingestWellness' | 'ingestNutrition',
    value: boolean
  ) {
    emit('updateSetting', provider, 'settings', {
      ...getProviderSettings(provider),
      [key]: value
    })
  }

  function getProviderOptionValue(provider: string, option: ProviderSettingOption) {
    if (option.target === 'root') {
      switch (provider) {
        case 'whoop':
          return props.whoopIngestWorkouts
        case 'oura':
          return props.ouraIngestWorkouts
        case 'withings':
          return props.withingsIngestWorkouts
        case 'polar':
          return props.polarIngestWorkouts
        case 'garmin':
          return props.garminIngestWorkouts
        case 'ultrahuman':
          return props.ultrahumanIngestWorkouts
        case 'hevy':
          return props.hevyIngestWorkouts
        case 'liftosaur':
          return props.liftosaurIngestWorkouts
        case 'strava':
          return props.stravaIngestWorkouts
        default:
          return true
      }
    }

    const settings = getProviderSettings(provider)
    const value = settings?.[option.key]

    if (value === undefined || value === null) {
      // Defaults for Ultrahuman
      if (provider === 'ultrahuman') {
        if (option.key === 'autoSync') return true
        if (option.key === 'preferredSyncTime') return '08:00'
        if (option.key === 'ingestWellness') return true
      }
      return false
    }

    return value
  }

  function updateProviderOption(provider: string, option: ProviderSettingOption, value: any) {
    if (option.target === 'root') {
      emit('updateSetting', provider, option.key, value)
    } else {
      emit('updateSetting', provider, 'settings', {
        ...getProviderSettings(provider),
        [option.key]: value
      })
    }
  }

  const intervalsActions = computed(() => [
    [
      {
        label: 'Sync Profile',
        icon: 'i-heroicons-user',
        onSelect: () => emit('sync-profile', 'intervals')
      },
      {
        label: 'Advanced Sync',
        icon: 'i-heroicons-arrow-path-rounded-square',
        onSelect: () => {
          advancedSyncProvider.value = 'intervals'
          advancedSyncModalOpen.value = true
        }
      },
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => {
          intervalsSettingsModalOpen.value = true
        }
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'intervals')
      }
    ]
  ])

  const wahooActions = computed(() => [
    [
      {
        label: 'Ingest Workouts',
        type: 'checkbox' as const,
        checked: props.wahooIngestWorkouts,
        onUpdateChecked: (checked: boolean) =>
          emit('updateSetting', 'wahoo', 'ingestWorkouts', checked)
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'wahoo')
      }
    ]
  ])

  const whoopActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('whoop')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'whoop')
      }
    ]
  ])

  const ouraActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('oura')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'oura')
      }
    ]
  ])

  const withingsActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('withings')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'withings')
      }
    ]
  ])

  const yazioActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('yazio')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'yazio')
      }
    ]
  ])

  const fitbitActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('fitbit')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'fitbit')
      }
    ]
  ])

  const hevyActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('hevy')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'hevy')
      }
    ]
  ])

  const liftosaurActions = computed(() => [
    [
      {
        label: 'Advanced Sync',
        icon: 'i-heroicons-arrow-path-rounded-square',
        onSelect: () => {
          advancedSyncProvider.value = 'liftosaur'
          advancedSyncModalOpen.value = true
        }
      },
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('liftosaur')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'liftosaur')
      }
    ]
  ])

  const stravaActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('strava')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'strava')
      }
    ]
  ])

  const rouvyActions = computed(() => [
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'rouvy')
      }
    ]
  ])

  const polarActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('polar')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'polar')
      }
    ]
  ])

  const garminActions = computed(() => [
    [
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('garmin')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'garmin')
      }
    ]
  ])

  const ultrahumanActions = computed(() => [
    [
      {
        label: 'Advanced Sync',
        icon: 'i-heroicons-arrow-path-rounded-square',
        onSelect: () => {
          ultrahumanAdvancedSyncModalOpen.value = true
        }
      },
      {
        label: 'Settings',
        icon: 'i-heroicons-cog-6-tooth',
        onSelect: () => openProviderSettings('ultrahuman')
      }
    ],
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'ultrahuman')
      }
    ]
  ])

  const telegramActions = computed(() => [
    [
      {
        label: 'Disconnect',
        icon: 'i-heroicons-trash',
        color: 'error' as const,
        onSelect: () => emit('disconnect', 'telegram')
      }
    ]
  ])

  const isStravaDisabled = computed(() => {
    const config = useRuntimeConfig()
    return config.public.stravaEnabled === false
  })

  const isWhoopDisabled = computed(() => {
    const hostname = import.meta.client ? window.location.hostname : useRequestURL().hostname
    return hostname === 'coachwatts.com' || hostname === 'www.coachwatts.com'
  })
</script>
