// @vitest-environment nuxt

import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import CoachingBanner from '../../../../app/components/CoachingBanner.vue'
import { useCoachingStore } from '../../../../app/stores/coaching'

vi.mock('@tolgee/vue', () => ({
  useTranslate: () => ({ t: computed(() => (key: string) => key) })
}))

// UModal stays mounted and is driven by its `open` prop — the stub keeps the
// body/footer slots rendered so the confirm/cancel buttons are clickable even
// while closed, exactly like the real modal's DOM. UButton renders its `label`
// prop as text (CoachingBanner passes labels, not slots), and fallthrough
// `onClick` attrs keep the parent's @click handlers firing under test.
function stubs() {
  return {
    UModal: {
      name: 'UModal',
      props: ['open', 'title', 'description'],
      emits: ['update:open'],
      template:
        '<div data-testid="act-as-modal" :data-open="String(open)"><slot name="body" /><slot name="footer" /></div>'
    },
    UButton: {
      name: 'UButton',
      props: ['label', 'color', 'variant', 'size', 'ariaLabel'],
      template: '<button>{{ label }}</button>'
    },
    UIcon: { name: 'UIcon', template: '<span />' }
  }
}

async function mountBanner() {
  const wrapper = await mountSuspended(CoachingBanner, {
    global: {
      stubs: stubs()
    }
  })
  await flushPromises()
  await nextTick()
  return wrapper
}

// mountSuspended reuses the Nuxt app's Pinia across mounts within the file,
// so in-memory act-as state (and the localStorage the store persists) leaks
// from one test into the next — beforeEach's localStorage.clear() alone is
// not enough because the store setup body does not re-run. Reset both after
// every mount so each test starts from a clean coach identity.
async function mountFreshBanner() {
  const wrapper = await mountBanner()
  const store = useCoachingStore()
  store.actingAsUserId = null
  store.actingAsUserName = null
  store.pendingActAs = null
  localStorage.clear()
  document.cookie = 'coach_wattz_act_as_user=; path=/; max-age=0; SameSite=Lax'
  await nextTick()
  await flushPromises()
  return { wrapper, store }
}

function findButton(
  wrapper: ReturnType<typeof mountBanner> extends never ? never : any,
  label: string
) {
  const buttons = wrapper.findAll('button')
  const match = buttons.find((b: any) => b.text().includes(label))
  if (!match) {
    throw new Error(
      `button with label "${label}" not found (found: [${buttons.map((b: any) => JSON.stringify(b.text())).join(', ')}])`
    )
  }
  return match
}

describe('CoachingBanner act-as confirmation dialog (CW-641)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    document.cookie = 'coach_wattz_act_as_user=; path=/; max-age=0; SameSite=Lax'
    // confirmActingAs hard-navigates to /dashboard on commit — stub navigation
    // the same way the store tests do so committing identity stays observable
    // without leaving jsdom.
    vi.stubGlobal('location', {
      ...window.location,
      assign: vi.fn(),
      reload: vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('keeps the modal mounted but closed with no pending request, and opens it when a request is staged', async () => {
    const { wrapper, store } = await mountFreshBanner()

    expect(store.hasPendingActAsRequest).toBe(false)

    const modal = wrapper.findComponent({ name: 'UModal' })
    expect(modal.exists()).toBe(true)
    expect(modal.props('open')).toBe(false)

    store.startActingAs('athlete-1', 'Ada Athlete')
    await nextTick()
    await flushPromises()

    expect(store.hasPendingActAsRequest).toBe(true)
    // The component keeps UModal mounted and flips its `open` prop — it must
    // not conditionally destroy the dialog.
    expect(wrapper.findComponent({ name: 'UModal' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'UModal' }).props('open')).toBe(true)
  })

  it('confirm button invokes confirmActingAs (pinning the gate) and commits the staged identity', async () => {
    const { wrapper, store } = await mountFreshBanner()
    store.startActingAs('athlete-1', 'Ada Athlete')
    await nextTick()

    // Spying the store method (rather than only asserting the resulting
    // identity) is what pins the gate: rewiring the template to commit the
    // staged request directly — bypassing confirmActingAs — leaves this spy
    // uncalled and fails the test even though the render looks identical.
    const confirmSpy = vi.spyOn(store, 'confirmActingAs')

    await findButton(wrapper, 'act_as_confirm_submit').trigger('click')
    await nextTick()
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(store.pendingActAs).toBeNull()
    expect(store.hasPendingActAsRequest).toBe(false)
    expect(store.actingAsUserId).toBe('athlete-1')
    expect(store.actingAsUserName).toBe('Ada Athlete')
    expect(store.isCoachingMode).toBe(true)
  })

  it('cancel button invokes cancelActingAs and clears the pending request without committing identity', async () => {
    const { wrapper, store } = await mountFreshBanner()
    store.startActingAs('athlete-1', 'Ada Athlete')
    await nextTick()

    const cancelSpy = vi.spyOn(store, 'cancelActingAs')

    await findButton(wrapper, 'act_as_confirm_cancel').trigger('click')
    await nextTick()
    await flushPromises()

    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(store.pendingActAs).toBeNull()
    expect(store.hasPendingActAsRequest).toBe(false)
    expect(store.actingAsUserId).toBeNull()
    expect(store.isCoachingMode).toBe(false)
  })

  it('dismissing the modal (@update:open false) cancels the request; opening (true) does not', async () => {
    const { wrapper, store } = await mountFreshBanner()
    store.startActingAs('athlete-1', 'Ada Athlete')
    await nextTick()

    const cancelSpy = vi.spyOn(store, 'cancelActingAs')

    wrapper.findComponent({ name: 'UModal' }).vm.$emit('update:open', false)
    await nextTick()
    await flushPromises()

    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(store.pendingActAs).toBeNull()
    expect(store.hasPendingActAsRequest).toBe(false)
    expect(store.actingAsUserId).toBeNull()

    // Re-stage and emit the opening event — it must leave the request alone.
    store.startActingAs('athlete-2', 'Bo Athlete')
    await nextTick()
    cancelSpy.mockClear()

    wrapper.findComponent({ name: 'UModal' }).vm.$emit('update:open', true)
    await nextTick()
    await flushPromises()

    expect(cancelSpy).not.toHaveBeenCalled()
    expect(store.pendingActAs).toEqual({ userId: 'athlete-2', userName: 'Bo Athlete' })
    expect(store.hasPendingActAsRequest).toBe(true)
  })
})
