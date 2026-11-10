<script setup lang="ts">
  import { useAppLogout } from '#imports'

  const { data } = useAuth()
  const { logout } = useAppLogout()
  const user = computed(() => data.value?.user)
  const route = useRoute()
  const config = useRuntimeConfig()

  const buildVersionDisplay = computed(
    () =>
      (config.public.buildVersion as string) ||
      `v${config.public.version}+${config.public.buildDate}.${config.public.commitHash}.${config.public.buildCodename}`
  )

  const sidebarVersionDisplay = computed(() => {
    return `v${config.public.version}+${config.public.buildCodename}`
  })

  const isOpen = ref(false)

  const links = computed(() => [
    {
      label: 'Admin Home',
      icon: 'i-lucide-layout-dashboard',
      to: '/admin',
      onSelect: () => {
        isOpen.value = false
      }
    },
    {
      label: 'Users Management',
      icon: 'i-lucide-users',
      to: '/admin/users',
      onSelect: () => {
        isOpen.value = false
      }
    },
    {
      label: 'Subscriptions',
      icon: 'i-heroicons-banknotes',
      to: '/admin/subscriptions',
      onSelect: () => {
        isOpen.value = false
      }
    },
    {
      label: 'Statistics',
      icon: 'i-lucide-bar-chart-3',
      to: '/admin/stats',
      defaultOpen: route.path.includes('stats') && !route.path.includes('llm'),
      onSelect: () => {
        isOpen.value = false
      },
      children: [
        {
          label: 'Users',
          icon: 'i-lucide-users',
          to: '/admin/stats/users',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Workouts',
          icon: 'i-lucide-activity',
          to: '/admin/stats/workouts',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Messaging',
          icon: 'i-lucide-message-circle',
          to: '/admin/stats/messaging',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Webhooks',
          icon: 'i-lucide-webhook',
          to: '/admin/stats/webhooks',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Developers',
          icon: 'i-lucide-code',
          to: '/admin/stats/developers',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Emails',
          icon: 'i-lucide-mail',
          to: '/admin/stats/email',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Tickets',
          icon: 'i-heroicons-ticket',
          to: '/admin/stats/tickets',
          onSelect: () => {
            isOpen.value = false
          }
        }
      ]
    },
    {
      label: 'LLM Intelligence',
      icon: 'i-lucide-brain',
      defaultOpen: route.path.includes('llm'),
      children: [
        {
          label: 'Overview',
          icon: 'i-lucide-layout-grid',
          to: '/admin/stats/llm',
          exact: true,
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Operations',
          icon: 'i-lucide-cpu',
          to: '/admin/stats/llm/operations',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'User Economics',
          icon: 'i-lucide-coins',
          to: '/admin/stats/llm/users',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Caching',
          icon: 'i-lucide-hard-drive',
          to: '/admin/stats/llm/caching',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Quotas',
          icon: 'i-lucide-gauge',
          to: '/admin/stats/llm/quotas',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'LLM Tuning',
          icon: 'i-lucide-sliders',
          to: '/admin/llm/settings',
          onSelect: () => {
            isOpen.value = false
          }
        }
      ]
    },
    {
      label: 'Logs',
      icon: 'i-lucide-scroll-text',
      defaultOpen: route.path.includes('logs') || route.path.includes('webhooks'),
      children: [
        {
          label: 'Audit Logs',
          icon: 'i-lucide-scroll-text',
          to: '/admin/audit-logs',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'AI Logs',
          icon: 'i-lucide-brain-circuit',
          to: '/admin/ai/logs',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'AI Failed Requests',
          icon: 'i-lucide-alert-octagon',
          to: '/admin/ai/failed-requests',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Webhook Logs',
          icon: 'i-lucide-webhook',
          to: '/admin/webhooks',
          onSelect: () => {
            isOpen.value = false
          }
        }
      ]
    },
    {
      label: 'Debug',
      icon: 'i-lucide-bug',
      defaultOpen: route.path.includes('debug'),
      children: [
        {
          label: 'Environment',
          icon: 'i-lucide-terminal',
          to: '/admin/debug/env',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Trigger.dev',
          icon: 'i-lucide-zap',
          to: '/admin/debug/trigger',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Network Ping',
          icon: 'i-heroicons-globe-alt',
          to: '/admin/debug/ping',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Database Health',
          icon: 'i-lucide-database',
          to: '/admin/debug/database',
          onSelect: () => {
            isOpen.value = false
          }
        },
        {
          label: 'Queues',
          icon: 'i-heroicons-queue-list',
          to: '/admin/queues',
          onSelect: () => {
            isOpen.value = false
          }
        }
      ]
    },
    {
      label: 'Emails',
      icon: 'i-heroicons-envelope',
      to: '/admin/emails',
      onSelect: () => {
        isOpen.value = false
      }
    },
    {
      label: 'System Messages',
      icon: 'i-heroicons-megaphone',
      to: '/admin/system-messages',
      onSelect: () => {
        isOpen.value = false
      }
    },
    {
      label: 'Tickets',
      icon: 'i-heroicons-ticket',
      to: '/admin/issues',
      onSelect: () => {
        isOpen.value = false
      }
    },
    {
      label: 'Back to Site',
      icon: 'i-lucide-arrow-left',
      to: '/dashboard',
      onSelect: () => {
        isOpen.value = false
      }
    }
  ])
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="admin"
      v-model:open="isOpen"
      collapsible
      resizable
      class="bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800"
      :ui="{ footer: 'lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/admin"
          class="flex items-center w-full overflow-hidden shrink-0"
          :class="collapsed ? 'p-1 justify-center' : 'p-4 justify-start lg:justify-center'"
        >
          <img
            v-if="!collapsed"
            src="/media/coach_watts_text_cropped.webp"
            alt="Coach Watts"
            width="702"
            height="135"
            loading="eager"
            decoding="async"
            class="h-8 lg:h-10 w-auto object-contain"
          />
          <img
            v-else
            src="/media/logo.webp"
            alt="Coach Watts"
            width="537"
            height="537"
            loading="eager"
            decoding="async"
            class="size-12 object-contain"
          />
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          orientation="vertical"
          :items="links"
          :collapsed="collapsed"
          class="px-2"
        />
      </template>

      <template #footer="{ collapsed }">
        <div class="w-full">
          <div v-if="!collapsed" class="px-4 pb-2">
            <div class="flex items-center justify-center gap-4 mb-4">
              <NuxtLink
                to="https://www.strava.com/clubs/2004142"
                target="_blank"
                class="hover:opacity-100 transition-opacity"
              >
                <img
                  src="/images/logos/strava_powered_by_black.png"
                  alt="Powered by Strava"
                  width="176"
                  height="60"
                  loading="lazy"
                  decoding="async"
                  class="h-6 w-auto opacity-75 hover:opacity-100 dark:hidden"
                />
                <img
                  src="/images/logos/strava_powered_by.png"
                  alt="Powered by Strava"
                  width="176"
                  height="60"
                  loading="lazy"
                  decoding="async"
                  class="h-6 w-auto opacity-75 hover:opacity-100 hidden dark:block"
                />
              </NuxtLink>
              <NuxtLink
                to="https://www.garmin.com"
                target="_blank"
                class="hover:opacity-100 transition-opacity"
              >
                <img
                  src="/images/logos/WorksWithGarmin-Black.svg"
                  alt="Works with Garmin"
                  width="221"
                  height="127"
                  loading="lazy"
                  decoding="async"
                  class="h-6 w-auto opacity-75 hover:opacity-100 dark:hidden"
                />
                <img
                  src="/images/logos/WorksWithGarmin-White.svg"
                  alt="Works with Garmin"
                  width="221"
                  height="127"
                  loading="lazy"
                  decoding="async"
                  class="h-6 w-auto opacity-75 hover:opacity-100 hidden dark:block"
                />
              </NuxtLink>
            </div>
            <USeparator class="mb-4" />
            <div class="flex items-center justify-center gap-2">
              <UButton
                to="https://discord.gg/dPYkzg49T9"
                target="_blank"
                color="neutral"
                variant="ghost"
                icon="i-simple-icons-discord"
                size="xs"
                class="flex-1 justify-center"
              >
                Discord
              </UButton>
              <USeparator orientation="vertical" class="h-4" />
              <UButton
                to="https://github.com/newpush/coach"
                target="_blank"
                color="neutral"
                variant="ghost"
                icon="i-simple-icons-github"
                size="xs"
                class="flex-1 justify-center"
              >
                GitHub
              </UButton>
            </div>
            <USeparator class="my-2" />
          </div>

          <div
            v-if="!collapsed"
            class="p-4 flex items-center gap-3"
            :class="{ 'justify-center': collapsed }"
          >
            <UAvatar v-if="user" :alt="user.email || ''" size="md" />
            <div class="flex-1 min-w-0 flex flex-col items-start gap-0.5">
              <p class="text-sm font-medium truncate text-gray-900 dark:text-white">
                {{ user?.name || user?.email }}
              </p>
              <UButton
                variant="link"
                color="neutral"
                size="xs"
                :padded="false"
                class="p-0 h-auto font-normal text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                @click="
                  () => {
                    void logout('/login')
                  }
                "
              >
                Sign out
              </UButton>
            </div>
            <ColorModeButton />
          </div>

          <div v-if="!collapsed" class="px-4 pb-0 flex justify-center">
            <UButton
              to="/settings/changelog"
              variant="link"
              color="neutral"
              size="xs"
              :padded="false"
              class="text-gray-400 dark:text-gray-400 font-normal hover:text-gray-600 dark:hover:text-gray-300 transition-colors text-[10px]"
            >
              {{ sidebarVersionDisplay }}
            </UButton>
          </div>

          <div v-if="collapsed" class="flex justify-center pb-0">
            <UTooltip :text="buildVersionDisplay" :popper="{ placement: 'right' }">
              <span class="text-[10px] text-gray-400 dark:text-gray-400 font-mono cursor-default">
                {{ config.public.version }}
              </span>
            </UTooltip>
          </div>
        </div>
      </template>
    </UDashboardSidebar>

    <slot />

    <ClientOnly>
      <ImpersonationBanner />
      <!-- CoachingBanner is mounted once in app/app.vue (CW-541) -->
    </ClientOnly>
  </UDashboardGroup>
</template>
