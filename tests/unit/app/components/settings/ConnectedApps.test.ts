// @vitest-environment nuxt

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import ConnectedApps from '../../../../../app/components/settings/ConnectedApps.vue'

mockNuxtImport('useAuth', () => () => ({ signIn: vi.fn() }))
mockNuxtImport('useAnalytics', () => () => ({ trackIntegrationConnectStart: vi.fn() }))

const BASE_PROPS = {
  intervalsConnected: false,
  intervalsIngestWorkouts: false,
  whoopConnected: false,
  whoopIngestWorkouts: false,
  ouraConnected: false,
  ouraIngestWorkouts: false,
  withingsConnected: false,
  withingsIngestWorkouts: false,
  yazioConnected: false,
  fitbitConnected: false,
  stravaConnected: false,
  stravaIngestWorkouts: false,
  rouvyConnected: false,
  hevyConnected: false,
  hevyIngestWorkouts: false,
  liftosaurConnected: false,
  liftosaurIngestWorkouts: false,
  polarConnected: false,
  polarIngestWorkouts: false,
  garminConnected: false,
  garminIngestWorkouts: false,
  ultrahumanConnected: true,
  ultrahumanIngestWorkouts: true,
  telegramConnected: false,
  syncingProviders: new Set<string>(),
  integrationSettings: {
    ultrahuman: { ingestWellness: true, autoSync: true, preferredSyncTime: '08:00' }
  },
  wahooConnected: false,
  wahooIngestWorkouts: false
}

const STUBS = {
  UModal: {
    template: '<div><slot name="body" /><slot name="footer" /></div>'
  },
  UFormField: {
    template: '<div><slot /></div>'
  },
  // Mirrors the real USelectMenu contract used here: with `value-key="value"`
  // it emits the scalar option value (e.g. '09:00'), not the option object.
  USelectMenu: {
    name: 'USelectMenu',
    props: ['modelValue', 'items', 'valueKey'],
    emits: ['update:model-value'],
    template: '<div class="select-stub" />'
  },
  USwitch: {
    name: 'USwitch',
    props: ['modelValue', 'label'],
    emits: ['update:model-value'],
    template: '<div class="switch-stub" />'
  },
  UCheckbox: {
    name: 'UCheckbox',
    props: ['modelValue', 'label'],
    emits: ['update:model-value'],
    template: '<div class="checkbox-stub" />'
  },
  UCard: { template: '<div><slot /></div>' },
  UButton: { template: '<button><slot /></button>' },
  UDropdownMenu: { props: ['items'], template: '<div><slot /></div>' },
  UTooltip: { template: '<div><slot /></div>' },
  UIcon: { template: '<span />' }
}

async function mountUltrahumanSettings() {
  const wrapper = await mountSuspended(ConnectedApps, {
    props: { ...BASE_PROPS },
    global: {
      renderStubDefaultSlot: true,
      stubs: STUBS
    }
  })
  await flushPromises()

  // Open the Ultrahuman provider-settings modal (internal state, same as the
  // dropdown "Settings" action which calls openProviderSettings('ultrahuman')).
  ;(wrapper.vm as any).selectedProvider = 'ultrahuman'
  ;(wrapper.vm as any).providerSettingsModalOpen = true
  await nextTick()
  await flushPromises()

  return wrapper
}

describe('ConnectedApps ultrahuman preferred sync time (CW-681)', () => {
  it('persists the scalar select value instead of undefined', async () => {
    const wrapper = await mountUltrahumanSettings()

    const selects = wrapper.findAllComponents({ name: 'USelectMenu' })
    // Several modals render a USelectMenu (advanced-sync day pickers); the
    // provider-settings one is bound to the persisted preferred sync time.
    const select = selects.find((s) => s.props('modelValue') === '08:00')
    expect(select?.exists()).toBe(true)

    // USelectMenu with value-key="value" emits the scalar '09:00'.
    select!.vm.$emit('update:model-value', '09:00')
    await nextTick()

    expect(wrapper.emitted('updateSetting')).toEqual([
      [
        'ultrahuman',
        'settings',
        { ingestWellness: true, autoSync: true, preferredSyncTime: '09:00' }
      ]
    ])
  })

  it('keeps switch boolean behavior intact', async () => {
    const wrapper = await mountUltrahumanSettings()

    const syncSwitch = wrapper.findComponent({ name: 'USwitch' })
    expect(syncSwitch.exists()).toBe(true)
    expect(syncSwitch.props('modelValue')).toBe(true)

    syncSwitch.vm.$emit('update:model-value', false)
    await nextTick()

    expect(wrapper.emitted('updateSetting')).toEqual([
      [
        'ultrahuman',
        'settings',
        { ingestWellness: true, autoSync: false, preferredSyncTime: '08:00' }
      ]
    ])
  })
})
