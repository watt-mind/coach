// @vitest-environment nuxt

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import DefaultLayout from '../../../app/layouts/default.vue'
import { useUserStore } from '../../../app/stores/user'

function makeTranslateStub() {
  const t = (key: string) => key
  ;(t as any).value = t
  return t
}

vi.mock('@tolgee/vue', () => ({
  useTranslate: () => ({ t: makeTranslateStub() }),
  useTolgee: () => ref({ getLanguage: () => 'en' })
}))

vi.mock('../../../app/components/navigation/useCoachingRole', () => ({
  useCoachingRole: () => ({
    isCoachForAnyone: computed(() => false),
    isPureAthlete: computed(() => false),
    showFullCoachingSuite: computed(() => true)
  })
}))

const toastAdd = vi.fn()
const trackNavClick = vi.fn()
const logoutMock = vi.fn()

mockNuxtImport('useToast', () => () => ({ add: toastAdd }))
mockNuxtImport('useTriggerMonitor', () => () => ({ isOpen: ref(false) }))
mockNuxtImport('useAnalytics', () => () => ({ trackNavClick }))
mockNuxtImport('useFormat', () => () => ({
  formatDate: vi.fn(() => ''),
  getUserLocalDate: () => new Date('2026-01-01T00:00:00.000Z')
}))
mockNuxtImport('useAppLogout', () => () => ({ logout: logoutMock, clearAuthOverrides: vi.fn() }))
mockNuxtImport('useAuth', () => () => ({
  data: ref(null),
  refresh: vi.fn(),
  signOut: vi.fn()
}))
mockNuxtImport('useRoute', () => () => ({ path: '/dashboard', query: {}, params: {} }))
mockNuxtImport('useFetch', () => () => ({ data: ref(null), refresh: vi.fn() }))
mockNuxtImport('useLazyFetch', () => () => ({ data: ref([]) }))
mockNuxtImport('useUserRuns', () => () => ({ refresh: vi.fn() }))
mockNuxtImport('useUserRunsState', () => () => ({
  runs: ref([]),
  onTaskCompleted: vi.fn(),
  onTaskFailed: vi.fn()
}))

// Render the impersonation exit affordance: the layout shows the desktop
// "Stop impersonating" button only when the impersonation cookie is present.
mockNuxtImport(
  'useCookie',
  () => (_key: string) =>
    ref({
      adminId: 'admin-1',
      adminEmail: 'admin@example.com',
      impersonatedUserId: 'athlete-1',
      impersonatedUserEmail: 'athlete@example.com'
    })
)

const fetchMock = vi.fn()
let navigatedHref: string | null = null

function stubLocation() {
  navigatedHref = null
  vi.stubGlobal('location', {
    ...window.location,
    assign: vi.fn(),
    reload: vi.fn(),
    replace: vi.fn()
  })
  // Capture full-document navigation via href assignment. jsdom/happy-dom
  // otherwise attempts a real navigation ("Not implemented") and the assertion
  // target is lost.
  try {
    let current = 'http://localhost/'
    Object.defineProperty(window, 'location', {
      configurable: true,
      enumerable: true,
      value: {
        ...window.location,
        get href() {
          return current
        },
        set href(v: string) {
          current = v
          navigatedHref = v
        },
        assign: vi.fn((v: string) => {
          navigatedHref = v
        }),
        reload: vi.fn(),
        replace: vi.fn((v: string) => {
          navigatedHref = v
        })
      }
    })
  } catch {
    // If the DOM forbids redefining location, fall back to observing the
    // stubbed global (coaching-store pattern).
  }
}

async function mountLayout() {
  const wrapper = await mountSuspended(DefaultLayout, {
    shallow: true,
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        // UDashboardSidebar provides the footer slot scope (collapsed). Render
        // both default and footer slots so the real stopImpersonation bindings
        // (desktop button + mobile footer emit) stay mounted.
        UDashboardSidebar: {
          template:
            '<div><slot name="header" :collapsed="false" /><slot :collapsed="false" /><slot name="footer" :collapsed="false" /></div>'
        },
        UDashboardGroup: { template: '<div><slot /></div>' },
        UDashboardSearch: { template: '<div />' },
        UDashboardSearchButton: { template: '<button />' },
        UNavigationMenu: { template: '<div />' },
        UDropdownMenu: { template: '<div><slot /></div>' },
        UAvatar: { template: '<span />' },
        UTooltip: { template: '<div><slot /></div>' },
        USeparator: { template: '<hr />' },
        UIcon: { template: '<span />' },
        UButton: {
          template: '<button @click="$attrs.onClick"><slot />{{ $attrs.label }}</button>'
        },
        NuxtLink: { template: '<a><slot /></a>' },
        ClientOnly: { template: '<div><slot /></div>' }
      }
    }
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

function findStopButton(wrapper: any) {
  const buttons = wrapper.findAll('button')
  const match = buttons.find((b: any) => {
    const text = b.text()
    return text.includes('Stop impersonating') || text.includes('stop_impersonating')
  })
  if (!match) {
    throw new Error(
      `Stop impersonating button not found (found: [${buttons.map((b: any) => JSON.stringify(b.text())).join(', ')}])`
    )
  }
  return match
}

describe('default layout impersonation exit (CW-851)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    toastAdd.mockClear()
    stubLocation()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/stop-impersonation') return { success: true }
      if (url === '/api/user/me') return null
      if (url === '/api/profile/dashboard')
        return { profile: null, dataSyncStatus: null, missingFields: [] }
      return null
    })
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('POSTs stop-impersonation, clears impersonated caches and full-navigates on success', async () => {
    const wrapper = await mountLayout()
    const store = useUserStore()
    // Simulate populated impersonated caches from visiting the dashboard.
    store.user = {
      id: 'athlete-1',
      email: 'athlete@example.com',
      name: 'Ada Athlete'
    } as any
    store.profile = { weightUnits: 'Pounds', distanceUnits: 'Miles' } as any

    await findStopButton(wrapper).trigger('click')
    await flushPromises()
    await nextTick()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/stop-impersonation',
      expect.objectContaining({ method: 'POST' })
    )
    // Impersonated account caches must not survive the exit.
    expect(store.user).toBeNull()
    expect(store.profile).toBeNull()
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ color: 'success' }))
    // Full document navigation discards in-memory state (no client-side
    // navigateTo that would leave Pinia intact).
    expect(navigatedHref).toBe('/admin/users')
  })

  it('mobile footer exit uses the same stop path and full-navigates', async () => {
    const wrapper = await mountLayout()
    const store = useUserStore()
    store.user = { id: 'athlete-1', email: 'athlete@example.com' } as any
    store.profile = { weightUnits: 'Pounds' } as any

    const footer = wrapper.findComponent({ name: 'LayoutMobileSidebarFooter' })
    // With shallow mounting the footer is stubbed but still emits; fall back
    // to the desktop button when the stub is not queryable.
    if (footer.exists()) {
      footer.vm.$emit('stop-impersonation')
    } else {
      await findStopButton(wrapper).trigger('click')
    }
    await flushPromises()
    await nextTick()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/stop-impersonation',
      expect.objectContaining({ method: 'POST' })
    )
    expect(store.user).toBeNull()
    expect(store.profile).toBeNull()
    expect(navigatedHref).toBe('/admin/users')
  })

  it('failed exit stays on the page, surfaces the error and releases loading', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/admin/stop-impersonation') throw new Error('stop failed')
      return null
    })

    const wrapper = await mountLayout()
    const store = useUserStore()
    store.user = { id: 'athlete-1', email: 'athlete@example.com' } as any

    await findStopButton(wrapper).trigger('click')
    await flushPromises()
    await nextTick()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/stop-impersonation',
      expect.objectContaining({ method: 'POST' })
    )
    // Never navigate on failure.
    expect(navigatedHref).toBeNull()
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
    // Loading state is released so the control is usable again.
    const buttons = wrapper.findAll('button')
    const stillThere = buttons.some((b: any) => {
      const text = b.text()
      return text.includes('Stop impersonating') || text.includes('stop_impersonating')
    })
    expect(stillThere).toBe(true)
  })
})
