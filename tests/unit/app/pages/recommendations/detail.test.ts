// @vitest-environment nuxt

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import RecommendationDetailPage from '../../../../../app/pages/recommendations/[id].vue'

// `useAsyncData` caches per key (`recommendation-${id}`) across mounts in this
// environment, so each test uses its own route id to get a fresh fetch.
const routeId = ref('rec-1')

mockNuxtImport('useRoute', () => () => ({ params: { id: routeId.value } }))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
mockNuxtImport('useFormat', () => () => ({
  formatDate: (d: unknown) => String(d ?? ''),
  formatShortDate: (d: unknown) => String(d ?? '')
}))

// Each test seeds this before mounting; the stubbed $fetch serves it as the
// `GET /api/recommendations/:id` response.
const recResponse = ref<any>(null)

function buildRec(overrides: Record<string, any> = {}) {
  return {
    id: routeId.value,
    title: 'Raise FTP with sweet-spot block',
    priority: 'high',
    sourceType: 'workout',
    metric: 'FTP',
    generatedAt: '2026-08-10T00:00:00.000Z',
    description: 'Threshold detected a new FTP value.',
    status: 'ACTIVE',
    isPinned: false,
    implementationGuide: null,
    llmUsageId: null,
    history: null,
    ...overrides
  }
}

async function mountPage() {
  const wrapper = await mountSuspended(RecommendationDetailPage as any, {
    shallow: true,
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        UDashboardPanel: {
          template: '<div><slot name="header" /><slot name="body" /><slot /></div>'
        },
        UDashboardNavbar: {
          template:
            '<div><slot name="title" /><slot name="leading" /><slot name="right" /><slot /></div>'
        },
        // GlossaryText takes its content via the `text` prop, not a slot, so
        // render the prop explicitly to keep timeline assertions meaningful.
        GlossaryText: {
          template: '<span>{{ text }}</span>',
          props: ['text']
        }
      }
    }
  })

  await flushPromises()
  await nextTick()
  await nextTick()

  return wrapper
}

describe('Recommendation detail history rendering (CW-648)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    recResponse.value = null
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/api/recommendations/${routeId.value}`) {
        return recResponse.value
      }
      throw new Error(`Unhandled fetch in test: ${url}`)
    })
    ;(fetchMock as any).raw = vi.fn().mockResolvedValue({ _data: null })
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the history-unavailable empty state for object-shaped threshold history without throwing', async () => {
    routeId.value = 'rec-object'
    recResponse.value = buildRec({
      history: {
        oldValue: 250,
        newValue: 262,
        workoutId: 'workout-1',
        sportName: 'Ride',
        workoutDate: '2026-08-09'
      }
    })

    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('Raise FTP with sweet-spot block')
    expect(wrapper.text()).toContain('Evolution History')
    expect(wrapper.text()).toContain('History unavailable for this recommendation.')
    expect(wrapper.text()).not.toContain('Previous Version')
  })

  it('renders array history newest first', async () => {
    routeId.value = 'rec-array'
    recResponse.value = buildRec({
      history: [
        {
          date: '2026-08-01T00:00:00.000Z',
          reason: 'Initial version',
          title: 'Older title',
          description: 'Older description'
        },
        {
          date: '2026-08-09T00:00:00.000Z',
          reason: 'Threshold update',
          title: 'Newer title',
          description: 'Newer description'
        }
      ]
    })

    const wrapper = await mountPage()

    const text = wrapper.text()
    expect(text).toContain('Evolution History')
    expect(text).toContain('Previous Version')
    expect(text).toContain('Older title')
    expect(text).toContain('Newer title')
    // Newest first: the stored array is reversed for display.
    expect(text.indexOf('Newer title')).toBeLessThan(text.indexOf('Older title'))
    expect(text).not.toContain('History unavailable for this recommendation.')
  })

  it('renders no timeline section for null history', async () => {
    routeId.value = 'rec-null'
    recResponse.value = buildRec({ history: null })

    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('Raise FTP with sweet-spot block')
    expect(wrapper.text()).not.toContain('Evolution History')
    expect(wrapper.text()).not.toContain('History unavailable for this recommendation.')
  })
})
