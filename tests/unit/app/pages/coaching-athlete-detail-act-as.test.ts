// @vitest-environment nuxt

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import AthleteDetailPage from '../../../../app/pages/coaching/athletes/[id]/index.vue'
import { useCoachingStore } from '../../../../app/stores/coaching'

// Untranslated-key passthrough: `useCoachingI18n().tr` falls back to the
// default string and interpolates `{name}` itself when Tolgee returns the key,
// so the expected labels below exercise the same fallback path production
// uses for missing translations.
const { translateMock, useTranslateMock } = vi.hoisted(() => ({
  translateMock: vi.fn((key: string) => key),
  useTranslateMock: vi.fn()
}))

function makeTranslateStub() {
  const t = translateMock
  ;(t as any).value = t
  return t
}

vi.mock('@tolgee/vue', () => ({
  useTranslate: (namespace: string) => {
    useTranslateMock(namespace)
    return { t: makeTranslateStub() }
  }
}))

let routeId = 'athlete-1'
let athletePayload: Record<string, any> | null = null

mockNuxtImport('useRoute', () => () => ({ params: { id: routeId }, query: {} }))
mockNuxtImport('useAuth', () => () => ({
  status: ref('authenticated'),
  data: ref({ user: { id: 'coach-1', onboardingCompleted: true } }),
  getSession: vi.fn().mockResolvedValue(null),
  refresh: vi.fn().mockResolvedValue(null)
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
mockNuxtImport('useFormat', () => () => ({
  formatDateUTC: (_date: unknown, formatStr?: string) => formatStr || ''
}))
mockNuxtImport('useCoachingMessageAthlete', () => () => ({ messageAthlete: vi.fn() }))

// Renders a real <button> (instead of a shallow stub element) so the test can
// read the bound aria-label/title attributes and click the trigger.
const UButtonStub = defineComponent({
  name: 'UButton',
  inheritAttrs: false,
  emits: ['click'],
  template: `<button type="button" v-bind="$attrs" @click="$emit('click')"><slot /></button>`
})

function buildAthleteResponse(overrides: Record<string, any> = {}) {
  return {
    id: routeId,
    name: 'Ada Athlete',
    email: 'ada@example.test',
    image: null,
    currentFitnessScore: null,
    profileLastUpdated: null,
    recommendations: [],
    wellness: [],
    plannedWorkouts: [],
    events: [],
    workouts: [],
    performanceSummary: null,
    readinessSummary: null,
    zones: null,
    zoneSummary: { ftp: null, lthr: null, maxHr: null },
    stats: { adherence7d: null, completedCount: 0, plannedCount: 0, overduePlannedCount: 0 },
    ...overrides
  }
}

// The page's header (including the act-as trigger) lives inside the `#right`
// slot of `UDashboardNavbar` within `UDashboardPanel`. Plain `shallow: true`
// stubbing drops named-slot content, so both get slot-preserving stubs while
// everything else stays shallow-stubbed.
async function mountPage() {
  const wrapper = await mountSuspended(AthleteDetailPage, {
    shallow: true,
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        UButton: UButtonStub,
        UDashboardPanel: {
          template: '<div><slot name="header" /><slot name="body" /><slot /></div>'
        },
        UDashboardNavbar: {
          template:
            '<div><slot name="title" /><slot name="leading" /><slot name="right" /><slot /></div>'
        }
      }
    }
  })

  await flushPromises()
  await nextTick()
  await nextTick()

  return wrapper
}

function findActAsButton(wrapper: Awaited<ReturnType<typeof mountPage>>) {
  const actAs = wrapper.findAll('button').find((button) => button.text().trim() === 'Act As')
  expect(actAs).toBeDefined()
  return actAs!
}

describe('Athlete detail act-as trigger accessible label (CW-642)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/coaching/athletes/')) {
        return athletePayload
      }
      throw new Error(`Unhandled fetch in test: ${url}`)
    })
    // @sidebase/nuxt-auth calls `$fetch.raw` during app init to load the
    // session; give the stub a harmless implementation so that unrelated
    // plugin doesn't pollute this page-level test.
    ;(fetchMock as any).raw = vi.fn().mockResolvedValue({ _data: null })
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    { scenario: 'name', name: 'Ada Athlete', email: 'ada@example.test', label: 'Ada Athlete' },
    { scenario: 'email only', name: null, email: 'ada@example.test', label: 'ada@example.test' },
    { scenario: 'neither value', name: null, email: null, label: 'Athlete' },
    { scenario: 'empty strings', name: '', email: '', label: 'Athlete' }
  ])(
    'labels and stages the selected athlete with $scenario',
    async ({ scenario, name, email, label }) => {
      routeId = `selected-athlete-${scenario.replaceAll(' ', '-')}`
      athletePayload = buildAthleteResponse({ name, email })

      const wrapper = await mountPage()
      const actAs = findActAsButton(wrapper)
      const store = useCoachingStore()
      store.cancelActingAs()

      expect(useTranslateMock).toHaveBeenCalledWith('coaching')
      expect(translateMock).toHaveBeenCalledWith('athlete_card_act_as_aria')
      expect(actAs.attributes('aria-label')).toBe(`View the app as ${label}`)
      expect(actAs.attributes('title')).toBe(`View the app as ${label}`)
      expect(store.pendingActAs).toBeNull()

      await actAs.trigger('click')

      expect(store.pendingActAs).toEqual({ userId: routeId, userName: label })
      expect(store.actingAsUserId).toBeNull()
      wrapper.unmount()
    }
  )
})
