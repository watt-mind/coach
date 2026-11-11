// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { computed } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import MeasurementsSettings from '../../../../../app/components/profile/MeasurementsSettings.vue'

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('@tolgee/vue', () => ({
  useTranslate: () => ({ t: computed(() => (key: string) => key) })
}))
mockNuxtImport('useToast', () => () => ({ add: toast }))
mockNuxtImport('useFormat', () => () => ({ formatDateUTC: vi.fn() }))
mockNuxtImport('useUserStore', () => () => ({ profile: { heightUnits: 'ft/in' }, user: {} }))

afterEach(() => {
  vi.unstubAllGlobals()
  toast.mockReset()
})

it.each([
  [null, null, null],
  [0, 0, null],
  [5, null, 152],
  [5, 10, 178]
])('validates imperial height %s ft %s in', async (feet, inches, expected) => {
  const fetch = vi.fn().mockResolvedValue({ items: [] })
  Object.assign(fetch, { raw: vi.fn().mockResolvedValue({ _data: null }) })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = await mountSuspended(MeasurementsSettings, { shallow: true })
  const vm = wrapper.vm as any
  vm.selectedMetric = 'height'
  vm.heightFt = feet
  vm.heightIn = inches
  await vm.saveMeasurement()
  const post = fetch.mock.calls.find((call: any[]) => call[1]?.method === 'POST')
  if (expected === null) {
    expect(post).toBeUndefined()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'error' }))
  } else {
    expect(post?.[1].body.value).toBeCloseTo(expected)
  }
  wrapper.unmount()
})
