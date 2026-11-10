<script setup lang="ts">
  import { useTranslate, useTolgee } from '@tolgee/vue'
  import type { NavigationMenuItem } from '@nuxt/ui'
  import { useAppLogout } from '#imports'
  import { useCoachingRole } from '~/components/navigation/useCoachingRole'

  const { t } = useTranslate('common')
  const tolgee = useTolgee()
  const isTReady = ref(false)

  // Robust ready check
  watch(
    () => t.value,
    (val) => {
      if (typeof val === 'function') {
        isTReady.value = true
      }
    },
    { immediate: true }
  )

  provide('isTReady', isTReady)

  const config = useRuntimeConfig()
  const { data, refresh } = useAuth()
  const { logout } = useAppLogout()
  const user = computed(() => data.value?.user)
  const toast = useToast()
  const stoppingImpersonation = ref(false)

  // Background Task Monitor State
  const { isOpen: showTriggerMonitor } = useTriggerMonitor()

  const buildVersionDisplay = computed(
    () =>
      (config.public.buildVersion as string) ||
      `v${config.public.version}+${config.public.buildDate}.${config.public.commitHash}.${config.public.buildCodename}`
  )

  const sidebarVersionDisplay = computed(() => {
    return `v${config.public.version}+${config.public.buildCodename}`
  })

  const userStore = useUserStore()
  const { formatDate, getUserLocalDate } = useFormat()
  const nutritionEnabled = computed(
    () =>
      userStore.profile?.nutritionTrackingEnabled !== false &&
      userStore.user?.nutritionTrackingEnabled !== false
  )

  const { trackNavClick } = useAnalytics()

  // CW-103: role-aware Coaching nav — pure athletes (connected to a coach but
  // never coaching anyone themselves) see a simplified "My Coaches" entry
  // instead of the full coach roster/teams suite.
  const { showFullCoachingSuite } = useCoachingRole()

  function wrapNavItems(items: NavigationMenuItem[]): NavigationMenuItem[] {
    return items.map((item) => {
      const path =
        typeof item.to === 'string'
          ? item.to
          : item.to && typeof item.to === 'object' && 'path' in item.to
            ? String(item.to.path)
            : '/'
      const label = String(item.label || path)
      const originalOnSelect = item.onSelect

      return {
        ...item,
        onSelect: (event: Event) => {
          trackNavClick(path, label)
          originalOnSelect?.(event)
        },
        children: item.children ? wrapNavItems(item.children) : undefined
      }
    })
  }

  // Ensure user data (including subscription) is loaded
  await callOnce(async () => {
    if (data.value?.user) {
      await Promise.all([userStore.fetchUser(), userStore.fetchProfile()])
    }
  })

  onMounted(() => {
    if (!userStore.user) {
      userStore.fetchUser()
    }
    if (!userStore.profile) {
      userStore.fetchProfile()
    }
  })

  const impersonationMeta = useCookie<{
    adminId: string
    adminEmail: string
    impersonatedUserId: string
    impersonatedUserEmail: string
  }>('auth.impersonation_meta')

  const impersonatedEmail = computed(() => impersonationMeta.value?.impersonatedUserEmail)

  async function stopImpersonation() {
    stoppingImpersonation.value = true
    try {
      await ($fetch as any)('/api/admin/stop-impersonation', { method: 'POST' })
      toast.add({
        title: 'Impersonation stopped',
        description: 'Returning to admin account',
        color: 'success'
      })
      // Refresh session and redirect
      await refresh()
      await navigateTo('/admin/users')
    } catch (error) {
      console.error('Failed to stop impersonation:', error)
      toast.add({
        title: 'Error',
        description: 'Failed to stop impersonation',
        color: 'error'
      })
    } finally {
      stoppingImpersonation.value = false
    }
  }

  const route = useRoute()

  const open = ref(false)

  function navLabel(key: string, fallback: string) {
    if (typeof t.value !== 'function') return fallback
    const translated = t.value(key)
    return !translated || translated === key ? fallback : translated
  }

  // Navigation Items
  const links = computed<NavigationMenuItem[][]>(() => {
    // Force re-evaluation on language change or ready state
    const ready = isTReady.value && typeof t.value === 'function'
    const lang = tolgee.value.getLanguage()

    const primaryLinks: any[] = [
      {
        label: navLabel('navigation_dashboard', 'Dashboard'),
        icon: 'i-lucide-layout-dashboard',
        to: '/dashboard',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_morning_checkin', 'Morning Check-in'),
        icon: 'i-lucide-sunrise',
        to: {
          path: '/dashboard',
          query: { focus: 'checkin' }
        },
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_todays_wellness', "Today's Wellness"),
        icon: 'i-lucide-heart-pulse',
        to: {
          path: '/dashboard',
          query: { focus: 'wellness' }
        },
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_activities', 'Activities'),
        icon: 'i-lucide-calendar-days',
        to: '/activities',
        onSelect: () => {
          open.value = false
        }
      },
      ...(nutritionEnabled.value
        ? [
            {
              label: navLabel('navigation_nutrition', 'Nutrition'),
              icon: 'i-lucide-utensils',
              to: '/nutrition',
              onSelect: () => {
                open.value = false
              }
            }
          ]
        : []),
      {
        label: navLabel('navigation_performance', 'Performance'),
        icon: 'i-lucide-trending-up',
        to: '/performance',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_recommendations', 'Recommendations'),
        icon: 'i-lucide-sparkles',
        to: '/recommendations',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_training_plan', 'Training Plan'),
        icon: 'i-lucide-calendar',
        to: '/plan',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_workouts', 'Workouts'),
        icon: 'i-lucide-activity',
        to: '/workouts',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_fitness', 'Fitness'),
        icon: 'i-lucide-heart-pulse',
        to: '/fitness',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_goals', 'Goals'),
        icon: 'i-lucide-trophy',
        to: '/profile/goals',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_events', 'Events'),
        icon: 'i-lucide-flag',
        to: '/events',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_reports', 'Reports'),
        icon: 'i-lucide-file-text',
        to: '/reports',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: navLabel('navigation_chat', 'AI Chat'),
        icon: 'i-lucide-message-circle',
        to: '/chat',
        onSelect: () => {
          open.value = false
        }
      },
      {
        label: 'Library',
        icon: 'i-lucide-library',
        defaultOpen: route.path.includes('library') || route.path.includes('analytics/browse'),
        children: [
          {
            label: 'Workouts',
            icon: 'i-lucide-activity',
            to: '/library/workouts',
            onSelect: () => {
              open.value = false
            }
          },
          {
            label: 'Exercises',
            icon: 'i-lucide-dumbbell',
            to: '/library/exercises',
            onSelect: () => {
              open.value = false
            }
          },
          {
            label: 'Plans',
            icon: 'i-lucide-scroll-text',
            to: '/library/plans',
            onSelect: () => {
              open.value = false
            }
          },
          {
            label: 'Charts',
            icon: 'i-lucide-area-chart',
            to: '/analytics/browse',
            onSelect: () => {
              open.value = false
            }
          }
        ]
      },
      ...(showFullCoachingSuite.value
        ? [
            {
              label: 'Coaching',
              icon: 'i-lucide-users',
              defaultOpen: route.path.startsWith('/coaching'),
              children: [
                {
                  label: 'Overview',
                  icon: 'i-lucide-layout-dashboard',
                  to: '/coaching',
                  exact: true,
                  onSelect: () => {
                    open.value = false
                  }
                },
                {
                  label: 'Calendar',
                  icon: 'i-lucide-calendar-days',
                  to: '/coaching/calendar',
                  onSelect: () => {
                    open.value = false
                  }
                },
                {
                  label: 'Athletes',
                  icon: 'i-lucide-users-round',
                  to: '/coaching/athletes',
                  onSelect: () => {
                    open.value = false
                  }
                },
                {
                  label: 'Analytics',
                  icon: 'i-lucide-bar-chart-3',
                  to: '/analytics',
                  onSelect: () => {
                    open.value = false
                  }
                },
                {
                  label: 'My Coaches',
                  icon: 'i-lucide-building-2',
                  to: '/coaching/team',
                  onSelect: () => {
                    open.value = false
                  }
                }
              ]
            }
          ]
        : [
            {
              label: 'My Coaches',
              icon: 'i-lucide-users',
              to: '/coaching/team',
              onSelect: () => {
                open.value = false
              }
            }
          ]),
      {
        label: navLabel('navigation_help_center', 'Help Center'),
        icon: 'i-heroicons-question-mark-circle',
        to: '/help-center',
        onSelect: () => {
          open.value = false
        }
      }
    ]

    if ((user.value as any)?.isAdmin) {
      primaryLinks.push({
        label: navLabel('navigation_admin', 'Admin'),
        icon: 'i-lucide-shield-check',
        to: '/admin',
        onSelect: () => {
          open.value = false
        }
      })
    }

    primaryLinks.push({
      label: navLabel('navigation_settings_title', 'Settings'),
      icon: 'i-lucide-settings',
      defaultOpen: route.path.includes('settings'),
      children: [
        {
          label: navLabel('navigation_settings_profile', 'Profile'),
          icon: 'i-lucide-user',
          to: '/profile/settings',
          onSelect: () => {
            open.value = false
          }
        },
        {
          label: navLabel('navigation_settings_ai_coach', 'AI Coach'),
          icon: 'i-lucide-sparkles',
          to: '/settings/ai',
          onSelect: () => {
            open.value = false
          }
        },
        ...(config.public.stripePublishableKey
          ? [
              {
                label: navLabel('navigation_settings_billing', 'Billing'),
                icon: 'i-lucide-credit-card',
                to: '/settings/billing',
                onSelect: () => {
                  open.value = false
                }
              }
            ]
          : []),
        {
          label: navLabel('navigation_settings_apps', 'Apps'),
          icon: 'i-lucide-layout-grid',
          to: '/settings/apps',
          onSelect: () => {
            open.value = false
          }
        },
        {
          label: navLabel('navigation_settings_developer', 'Developer'),
          icon: 'i-lucide-code-2',
          to: '/settings/developer',
          onSelect: () => {
            open.value = false
          }
        },
        {
          label: navLabel('navigation_settings_danger_zone', 'Danger Zone'),
          icon: 'i-lucide-trash-2',
          to: '/settings/danger',
          onSelect: () => {
            open.value = false
          }
        }
      ]
    })

    return [wrapNavItems(primaryLinks)]
  })

  const mobileNavSections = computed(() => {
    const label = navLabel
    const closeSidebar = () => {
      open.value = false
    }
    const item = (entry: NavigationMenuItem): NavigationMenuItem => {
      const path =
        typeof entry.to === 'string'
          ? entry.to
          : entry.to && typeof entry.to === 'object' && 'path' in entry.to
            ? String(entry.to.path)
            : '/'
      const itemLabel = String(entry.label || path)
      const originalOnSelect = entry.onSelect

      return {
        ...entry,
        onSelect: (event: Event) => {
          trackNavClick(path, itemLabel)
          originalOnSelect?.(event)
          closeSidebar()
        },
        children: entry.children
          ? entry.children.map((child) => item(child as NavigationMenuItem))
          : undefined
      }
    }
    const sectionItems = (entries: NavigationMenuItem[]) => entries.map((entry) => item(entry))

    const sections: Array<{
      id: string
      label: string
      defaultOpen?: boolean
      items: NavigationMenuItem[]
    }> = [
      {
        id: 'primary',
        label: label('navigation_section_primary', 'Main'),
        defaultOpen: true,
        items: sectionItems([
          {
            label: label('navigation_dashboard', 'Dashboard'),
            icon: 'i-lucide-layout-dashboard',
            to: '/dashboard'
          },
          {
            label: label('navigation_activities', 'Activities'),
            icon: 'i-lucide-calendar-days',
            to: '/activities'
          },
          ...(nutritionEnabled.value
            ? [
                {
                  label: label('navigation_nutrition', 'Nutrition'),
                  icon: 'i-lucide-utensils',
                  to: '/nutrition'
                }
              ]
            : []),
          {
            label: label('navigation_training_plan', 'Training Plan'),
            icon: 'i-lucide-calendar',
            to: '/plan'
          },
          {
            label: label('navigation_workouts', 'Workouts'),
            icon: 'i-lucide-activity',
            to: '/workouts'
          },
          {
            label: label('navigation_chat', 'AI Chat'),
            icon: 'i-lucide-message-circle',
            to: '/chat'
          }
        ])
      },
      {
        id: 'today',
        label: label('navigation_section_today', 'Today'),
        defaultOpen: route.query.focus === 'checkin' || route.query.focus === 'wellness',
        items: sectionItems([
          {
            label: label('navigation_morning_checkin', 'Morning Check-in'),
            icon: 'i-lucide-sunrise',
            to: { path: '/dashboard', query: { focus: 'checkin' } }
          },
          {
            label: label('navigation_todays_wellness', "Today's Wellness"),
            icon: 'i-lucide-heart-pulse',
            to: { path: '/dashboard', query: { focus: 'wellness' } }
          }
        ])
      },
      {
        id: 'analysis',
        label: label('navigation_section_analysis', 'Analysis'),
        defaultOpen: [
          '/performance',
          '/fitness',
          '/reports',
          '/recommendations',
          '/profile/goals',
          '/events'
        ].some((path) => route.path.startsWith(path)),
        items: sectionItems([
          {
            label: label('navigation_performance', 'Performance'),
            icon: 'i-lucide-trending-up',
            to: '/performance'
          },
          {
            label: label('navigation_fitness', 'Fitness'),
            icon: 'i-lucide-heart-pulse',
            to: '/fitness'
          },
          {
            label: label('navigation_reports', 'Reports'),
            icon: 'i-lucide-file-text',
            to: '/reports'
          },
          {
            label: label('navigation_recommendations', 'Recommendations'),
            icon: 'i-lucide-sparkles',
            to: '/recommendations'
          },
          {
            label: label('navigation_goals', 'Goals'),
            icon: 'i-lucide-trophy',
            to: '/profile/goals'
          },
          {
            label: label('navigation_events', 'Events'),
            icon: 'i-lucide-flag',
            to: '/events'
          }
        ])
      },
      {
        id: 'library',
        label: label('navigation_library', 'Library'),
        defaultOpen: route.path.includes('library') || route.path.includes('analytics/browse'),
        items: sectionItems([
          {
            label: label('navigation_library', 'Library'),
            icon: 'i-lucide-library',
            defaultOpen: route.path.includes('library') || route.path.includes('analytics/browse'),
            children: [
              {
                label: 'Workouts',
                icon: 'i-lucide-activity',
                to: '/library/workouts'
              },
              {
                label: 'Exercises',
                icon: 'i-lucide-dumbbell',
                to: '/library/exercises'
              },
              {
                label: label('navigation_library_plans', 'Plans'),
                icon: 'i-lucide-scroll-text',
                to: '/library/plans'
              },
              {
                label: label('navigation_charts', 'Charts'),
                icon: 'i-lucide-area-chart',
                to: '/analytics/browse'
              }
            ]
          }
        ])
      },
      {
        id: 'coaching',
        label: label('navigation_coaching', 'Coaching'),
        defaultOpen: route.path.startsWith('/coaching') || route.path === '/analytics',
        items: sectionItems(
          showFullCoachingSuite.value
            ? [
                {
                  label: label('navigation_coaching', 'Coaching'),
                  icon: 'i-lucide-users',
                  defaultOpen: route.path.startsWith('/coaching') || route.path === '/analytics',
                  children: [
                    {
                      label: label('navigation_coaching_overview', 'Overview'),
                      icon: 'i-lucide-layout-dashboard',
                      to: '/coaching',
                      exact: true
                    },
                    {
                      label: label('navigation_coaching_calendar', 'Calendar'),
                      icon: 'i-lucide-calendar-days',
                      to: '/coaching/calendar'
                    },
                    {
                      label: label('navigation_coaching_athletes', 'Athletes'),
                      icon: 'i-lucide-users-round',
                      to: '/coaching/athletes'
                    },
                    {
                      label: label('navigation_analytics', 'Analytics'),
                      icon: 'i-lucide-bar-chart-3',
                      to: '/analytics'
                    },
                    {
                      label: label('navigation_coaching_team', 'My Coaches'),
                      icon: 'i-lucide-building-2',
                      to: '/coaching/team'
                    }
                  ]
                }
              ]
            : [
                {
                  label: label('navigation_coaching_team', 'My Coaches'),
                  icon: 'i-lucide-users',
                  to: '/coaching/team'
                }
              ]
        )
      },
      {
        id: 'account',
        label: label('navigation_section_account', 'Account'),
        defaultOpen:
          route.path.includes('settings') ||
          route.path.includes('help-center') ||
          route.path.startsWith('/admin'),
        items: sectionItems([
          {
            label: label('navigation_help_center', 'Help Center'),
            icon: 'i-heroicons-question-mark-circle',
            to: '/help-center'
          },
          ...((user.value as any)?.isAdmin
            ? [
                {
                  label: label('navigation_admin', 'Admin'),
                  icon: 'i-lucide-shield-check',
                  to: '/admin'
                }
              ]
            : []),
          {
            label: label('navigation_settings_title', 'Settings'),
            icon: 'i-lucide-settings',
            defaultOpen: route.path.includes('settings') || route.path.includes('profile/settings'),
            children: [
              {
                label: label('navigation_settings_profile', 'Profile'),
                icon: 'i-lucide-user',
                to: '/profile/settings'
              },
              {
                label: label('navigation_settings_ai_coach', 'AI Coach'),
                icon: 'i-lucide-sparkles',
                to: '/settings/ai'
              },
              ...(config.public.stripePublishableKey
                ? [
                    {
                      label: label('navigation_settings_billing', 'Billing'),
                      icon: 'i-lucide-credit-card',
                      to: '/settings/billing'
                    }
                  ]
                : []),
              {
                label: label('navigation_settings_apps', 'Apps'),
                icon: 'i-lucide-layout-grid',
                to: '/settings/apps'
              },
              {
                label: label('navigation_settings_developer', 'Developer'),
                icon: 'i-lucide-code-2',
                to: '/settings/developer'
              },
              {
                label: label('navigation_settings_danger_zone', 'Danger Zone'),
                icon: 'i-lucide-trash-2',
                to: '/settings/danger'
              }
            ]
          }
        ])
      }
    ]

    return sections
  })

  const mobileSidebarNavRef = ref<{ refresh: () => void } | null>(null)

  watch(open, (isOpen) => {
    if (!isOpen) return
    nextTick(() => mobileSidebarNavRef.value?.refresh())
  })

  // Command Palette Groups
  const groups = computed(() => {
    const ready = isTReady.value && typeof t.value === 'function'
    const lang = tolgee.value.getLanguage()
    const searchGroups: any[] = []

    // 1. Nutrition Group
    const { getUserLocalDate } = useFormat()
    const localToday = getUserLocalDate()
    const formatDateKey = (d: Date) => d.toISOString().split('T')[0]

    const todayStr = formatDateKey(localToday)
    const yesterdayStr = formatDateKey(new Date(localToday.getTime() - 86400000))
    const tomorrowStr = formatDateKey(new Date(localToday.getTime() + 86400000))

    if (nutritionEnabled.value) {
      searchGroups.push({
        id: 'nutrition',
        label: navLabel('navigation_nutrition', 'Nutrition'),
        items: [
          {
            id: 'nutrition-today',
            label: navLabel('navigation_search_nutrition_today', 'Today'),
            icon: 'i-lucide-utensils',
            to: `/nutrition/${todayStr}`,
            onSelect: () => (open.value = false)
          },
          {
            id: 'nutrition-tomorrow',
            label: navLabel('navigation_search_nutrition_tomorrow', 'Tomorrow'),
            icon: 'i-lucide-utensils',
            to: `/nutrition/${tomorrowStr}`,
            onSelect: () => (open.value = false)
          },
          {
            id: 'nutrition-yesterday',
            label: navLabel('navigation_search_nutrition_yesterday', 'Yesterday'),
            icon: 'i-lucide-utensils',
            to: `/nutrition/${yesterdayStr}`,
            onSelect: () => (open.value = false)
          }
        ]
      })
    }

    // 2. Upcoming Workouts (Filter out rest days)
    if (upcomingWorkouts.value?.workouts?.length) {
      const activeWorkouts = upcomingWorkouts.value.workouts
        .filter((w: any) => {
          const title = w.title?.toLowerCase() || ''
          return w.type !== 'REST' && !title.includes('rest day')
        })
        .slice(0, 3)

      if (activeWorkouts.length > 0) {
        searchGroups.push({
          id: 'upcoming-workouts',
          label: navLabel('navigation_search_upcoming_workouts', 'Upcoming Workouts'),
          items: activeWorkouts.map((w: any) => ({
            id: `planned-workout-${w.id}`,
            label: w.title,
            description: formatDate(w.date, 'PPPP'),
            icon: 'i-lucide-calendar-plus',
            to: `/workouts/planned/${w.id}`,
            onSelect: () => (open.value = false)
          }))
        })
      }
    }

    // 3. Recent Workouts
    if (recentWorkouts.value?.length) {
      searchGroups.push({
        id: 'recent-workouts',
        label: navLabel('navigation_search_recent_workouts', 'Recent Workouts'),
        items: (recentWorkouts.value as any[]).map((w: any) => ({
          id: `recent-workout-${w.id}`,
          label: w.title,
          description: formatDate(w.date, 'PPPP'),
          icon: 'i-lucide-history',
          to: `/workouts/${w.id}`,
          onSelect: () => (open.value = false)
        }))
      })
    }

    // 4. Morning Routine Group
    searchGroups.push({
      id: 'morning-routine',
      label: navLabel('navigation_search_morning_routine', 'Morning Routine'),
      items: [
        {
          id: 'morning-checkin',
          label: navLabel('navigation_morning_checkin', 'Morning Check-in'),
          icon: 'i-lucide-sunrise',
          to: {
            path: '/dashboard',
            query: { focus: 'checkin' }
          },
          onSelect: () => (open.value = false)
        },
        {
          id: 'todays-wellness',
          label: navLabel('navigation_todays_wellness', "Today's Wellness"),
          icon: 'i-lucide-heart-pulse',
          to: {
            path: '/dashboard',
            query: { focus: 'wellness' }
          },
          onSelect: () => (open.value = false)
        }
      ]
    })

    // 5. Navigation Group
    searchGroups.push({
      id: 'links',
      label: navLabel('navigation_search_go_to', 'Go to'),
      items: links.value.flat()
    })

    // 6. Settings Group (Deep Links)
    const settingsItems = [
      {
        label: navLabel('navigation_settings_profile_basic', 'Profile: Basic Settings'),
        icon: 'i-heroicons-user-circle',
        to: '/profile/settings?tab=basic',
        onSelect: () => (open.value = false)
      },
      {
        label: navLabel('navigation_settings_profile_sport', 'Profile: Sport Settings'),
        icon: 'i-heroicons-trophy',
        to: '/profile/settings?tab=sports',
        onSelect: () => (open.value = false)
      },
      {
        label: ready
          ? t.value('navigation_settings_profile_availability')
          : 'Profile: Availability',
        icon: 'i-lucide-calendar-clock',
        to: '/profile/settings?tab=availability',
        onSelect: () => (open.value = false)
      },
      ...(nutritionEnabled.value
        ? [
            {
              label: ready
                ? t.value('navigation_settings_profile_nutrition')
                : 'Profile: Nutrition',
              icon: 'i-heroicons-fire',
              to: '/profile/settings?tab=nutrition',
              onSelect: () => (open.value = false)
            }
          ]
        : []),
      {
        label: navLabel('navigation_settings_athlete_profile', 'Athlete Profile'),
        icon: 'i-lucide-user-2',
        to: '/profile/athlete',
        onSelect: () => (open.value = false)
      },
      ...(nutritionEnabled.value
        ? [
            {
              label: navLabel('navigation_search_nutrition_history', 'Nutrition: History'),
              icon: 'i-lucide-history',
              to: '/nutrition/history',
              onSelect: () => (open.value = false)
            }
          ]
        : []),
      {
        label: navLabel('navigation_settings_ai_coach_settings', 'AI Coach Settings'),
        icon: 'i-lucide-sparkles',
        to: '/settings/ai',
        onSelect: () => (open.value = false)
      },
      {
        label: ready
          ? t.value('navigation_settings_apps_connected')
          : 'Connected Apps (Strava, Garmin, Oura...)',
        icon: 'i-lucide-layout-grid',
        to: '/settings/apps',
        onSelect: () => (open.value = false)
      },
      {
        label: navLabel('navigation_settings_developer_settings', 'Developer Settings'),
        icon: 'i-lucide-code-2',
        to: '/settings/developer',
        onSelect: () => (open.value = false)
      },
      {
        label: navLabel('navigation_settings_release_notes', 'Release Notes'),
        icon: 'i-lucide-clipboard-list',
        to: '/settings/release-notes',
        onSelect: () => (open.value = false)
      },
      {
        label: navLabel('navigation_settings_changelog', 'Changelog'),
        icon: 'i-lucide-history',
        to: '/settings/changelog',
        onSelect: () => (open.value = false)
      },
      {
        label: navLabel('navigation_settings_privacy_policy', 'Privacy Policy'),
        icon: 'i-lucide-shield',
        to: '/privacy',
        onSelect: () => (open.value = false)
      }
    ]

    if (config.public.stripePublishableKey) {
      settingsItems.push({
        label: navLabel('navigation_settings_billing', 'Billing'),
        icon: 'i-lucide-credit-card',
        to: '/settings/billing',
        onSelect: () => (open.value = false)
      })
    }

    searchGroups.push({
      id: 'settings',
      label: navLabel('navigation_settings_title', 'Settings'),
      items: settingsItems
    })

    // 7. Admin Group (Only for Admins)
    if ((user.value as any)?.isAdmin) {
      searchGroups.push({
        id: 'admin',
        label: navLabel('navigation_admin', 'Admin'),
        items: [
          {
            label: navLabel('navigation_admin_nav_users', 'Users Management'),
            icon: 'i-lucide-users-2',
            to: '/admin/users',
            onSelect: () => (open.value = false)
          },
          {
            label: navLabel('navigation_admin_nav_subscriptions', 'Subscriptions'),
            icon: 'i-lucide-wallet',
            to: '/admin/subscriptions',
            onSelect: () => (open.value = false)
          },
          {
            label: navLabel('navigation_admin_nav_system_messages', 'System Messages'),
            icon: 'i-lucide-megaphone',
            to: '/admin/system-messages',
            onSelect: () => (open.value = false)
          },
          {
            label: navLabel('navigation_admin_nav_tickets', 'Tickets'),
            icon: 'i-lucide-bug',
            to: '/admin/issues',
            onSelect: () => (open.value = false)
          }
        ]
      })

      searchGroups.push({
        id: 'admin-stats',
        label: ready
          ? `${t.value('navigation_admin')}: ${t.value('navigation_admin_nav_statistics')}`
          : 'Admin: Statistics',
        items: [
          {
            label: navLabel('navigation_admin_nav_llm_overview', 'Overview Stats'),
            icon: 'i-lucide-bar-chart-3',
            to: '/admin/stats',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_stats_llm_performance')
              : 'LLM Performance & Costs',
            icon: 'i-lucide-brain-circuit',
            to: '/admin/stats/llm',
            onSelect: () => (open.value = false)
          },
          {
            label: navLabel('navigation_admin_nav_stats_user_analytics', 'User Analytics'),
            icon: 'i-lucide-trending-up',
            to: '/admin/stats/users',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_stats_developers')
              : 'Developer & API Stats',
            icon: 'i-lucide-code-2',
            to: '/admin/stats/developers',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_stats_webhook_performance')
              : 'Webhook Performance',
            icon: 'i-lucide-webhook',
            to: '/admin/stats/webhooks',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_stats_workout_sync')
              : 'Workout & Sync Stats',
            icon: 'i-lucide-activity',
            to: '/admin/stats/workouts',
            onSelect: () => (open.value = false)
          }
        ]
      })

      searchGroups.push({
        id: 'admin-monitoring',
        label: ready
          ? `${t.value('navigation_admin')}: ${t.value('navigation_admin_nav_monitoring_title')}`
          : 'Admin: Monitoring',
        items: [
          {
            label: ready
              ? t.value('navigation_admin_nav_monitoring_ai_logs_live')
              : 'AI Logs (Live)',
            icon: 'i-lucide-terminal',
            to: '/admin/ai/logs',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_monitoring_audit_security_logs')
              : 'Audit & Security Logs',
            icon: 'i-lucide-scroll-text',
            to: '/admin/audit-logs',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_monitoring_failed_requests')
              : 'Failed Requests',
            icon: 'i-lucide-alert-triangle',
            to: '/admin/ai/failed-requests',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_monitoring_trigger_queues')
              : 'Trigger.dev Queues',
            icon: 'i-lucide-layers',
            to: '/admin/queues',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_monitoring_native_webhooks')
              : 'Native Webhooks',
            icon: 'i-lucide-webhook',
            to: '/admin/webhooks',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_llm_global_settings')
              : 'Global LLM Settings',
            icon: 'i-lucide-settings-2',
            to: '/admin/llm/settings',
            onSelect: () => (open.value = false)
          }
        ]
      })

      searchGroups.push({
        id: 'admin-debug',
        label: ready
          ? `${t.value('navigation_admin')}: ${t.value('navigation_admin_nav_debug_title')}`
          : 'Admin: Debug Tools',
        items: [
          {
            label: ready
              ? t.value('navigation_admin_nav_debug_trigger_config')
              : 'Trigger.dev Config',
            icon: 'i-lucide-zap',
            to: '/admin/debug/trigger',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_debug_env_vars_config')
              : 'Env Vars & Config',
            icon: 'i-lucide-file-code',
            to: '/admin/debug/env',
            onSelect: () => (open.value = false)
          },
          {
            label: ready
              ? t.value('navigation_admin_nav_debug_database_explorer')
              : 'Database Explorer',
            icon: 'i-lucide-database',
            to: '/admin/debug/database',
            onSelect: () => (open.value = false)
          },
          {
            label: navLabel('navigation_admin_nav_debug_ping', 'Network Ping Tool'),
            icon: 'i-lucide-radio',
            to: '/admin/debug/ping',
            onSelect: () => (open.value = false)
          }
        ]
      })
    }

    return searchGroups
  })

  // Smart Item Data Fetching
  const { data: recentWorkouts } = await useFetch<any, Error, string & {}>('/api/workouts', {
    query: { limit: 3 },
    key: 'recent-workouts-search'
  })

  const { data: upcomingWorkouts } = await useFetch<any, Error, string & {}>(
    '/api/workouts/planned/upcoming',
    {
      key: 'upcoming-workouts-search'
    }
  )
</script>

<template>
  <UDashboardGroup
    unit="rem"
    class="print:static print:inset-auto print:block print:overflow-visible"
  >
    <UDashboardSidebar
      id="default"
      :key="tolgee.getLanguage()"
      v-model:open="open"
      collapsible
      resizable
      class="bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 print:hidden"
      :ui="{ footer: 'lg:border-t lg:border-default', body: 'flex min-h-0 flex-col' }"
      :title="navLabel('navigation_sidebar_title', 'Navigation')"
      :description="navLabel('navigation_sidebar_description', 'Browse Coach Watts destinations')"
      :menu="{
        title: navLabel('navigation_sidebar_title', 'Navigation'),
        description: navLabel('navigation_sidebar_description', 'Browse Coach Watts destinations')
      }"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/dashboard"
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
        <UDashboardSearchButton
          :collapsed="collapsed"
          :aria-label="
            isTReady && t('navigation_search_title') !== 'navigation_search_title'
              ? t('navigation_search_title')
              : 'Search'
          "
          class="mb-4 shrink-0 bg-transparent ring-default"
        />

        <div class="hidden min-h-0 flex-1 lg:block">
          <UNavigationMenu
            :collapsed="collapsed"
            :items="links[0]"
            orientation="vertical"
            tooltip
          />
        </div>

        <LayoutMobileSidebarNav ref="mobileSidebarNavRef" :sections="mobileNavSections" />
      </template>

      <template #footer="{ collapsed }">
        <LayoutMobileSidebarFooter
          :user="user"
          :impersonated-email="impersonatedEmail"
          :stopping-impersonation="stoppingImpersonation"
          :sidebar-version-display="sidebarVersionDisplay"
          @logout="
            () => {
              void logout('/login')
            }
          "
          @stop-impersonation="
            () => {
              void stopImpersonation()
            }
          "
        />

        <div class="hidden w-full lg:block">
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

          <div v-if="!collapsed" class="p-4 flex items-center gap-3">
            <UAvatar v-if="user" :alt="user.email || ''" size="md" />
            <div class="flex-1 min-w-0 flex flex-col items-start gap-0.5">
              <UTooltip
                :text="impersonatedEmail || user?.email || ''"
                :popper="{ placement: 'right' }"
              >
                <p class="text-sm font-medium truncate text-gray-900 dark:text-white">
                  {{ user?.name || impersonatedEmail || user?.email }}
                </p>
              </UTooltip>
              <UButton
                v-if="impersonatedEmail"
                variant="link"
                color="warning"
                size="xs"
                :padded="false"
                class="p-0 h-auto font-normal text-yellow-600 hover:text-yellow-700 dark:text-yellow-400 dark:hover:text-yellow-300"
                :loading="stoppingImpersonation"
                @click="
                  () => {
                    void stopImpersonation()
                  }
                "
              >
                {{ isTReady ? t('navigation_admin_nav_stop_impersonating') : 'Stop impersonating' }}
              </UButton>
              <UButton
                v-else
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
                {{ isTReady ? t('navigation_admin_nav_sign_out') : 'Sign out' }}
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

    <UDashboardSearch
      :key="tolgee.getLanguage()"
      :groups="groups"
      :title="navLabel('navigation_search_title', 'Search')"
      :description="
        navLabel('navigation_search_description', 'Search pages, workouts, and shortcuts')
      "
    />

    <slot />

    <ClientOnly>
      <AiQuickCapture />
      <DashboardTriggerMonitor v-model="showTriggerMonitor" />
      <ImpersonationBanner />
      <!-- CoachingBanner is mounted once in app/app.vue (CW-541) -->
    </ClientOnly>
  </UDashboardGroup>
</template>
