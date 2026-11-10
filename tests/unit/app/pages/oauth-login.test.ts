// @vitest-environment nuxt

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OAuthLoginPage from '../../../../app/pages/oauth/login.vue'

const { navigateToMock, signInMock } = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  signInMock: vi.fn()
}))

const callbackUrl =
  '/api/oauth/authorize?response_type=code&client_id=mobile-client&redirect_uri=coachwatts%3A%2F%2Foauth%2Fcallback'

mockNuxtImport('navigateTo', () => navigateToMock)
mockNuxtImport('useAuth', () => () => ({
  status: ref('authenticated'),
  data: ref({
    user: {
      id: 'athlete-1',
      name: 'Test Athlete',
      email: 'athlete@example.test',
      image: null
    }
  }),
  signIn: signInMock
}))
mockNuxtImport('useRoute', () => () => ({ query: { callbackUrl } }))

const UButtonStub = defineComponent({
  name: 'UButton',
  props: {
    label: { type: String, default: '' }
  },
  emits: ['click'],
  template: '<button type="button" @click="$emit(\'click\')"><slot />{{ label }}</button>'
})

async function mountPage() {
  const wrapper = await mountSuspended(OAuthLoginPage, {
    shallow: true,
    global: {
      renderStubDefaultSlot: true,
      stubs: {
        UButton: UButtonStub,
        UCard: { template: '<div><slot /></div>' }
      }
    }
  })

  await flushPromises()
  await nextTick()

  return wrapper
}

describe('OAuth login existing-account continuation (CW-734)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({ name: 'Coach Watts Mobile', logoUrl: null })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('performs a full-document navigation back to the OAuth authorize endpoint', async () => {
    const wrapper = await mountPage()
    const continueButton = wrapper
      .findAllComponents(UButtonStub)
      .find((button) => button.props('label') === 'Continue with this account')

    expect(continueButton).toBeDefined()

    await continueButton!.trigger('click')

    expect(navigateToMock).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledWith(callbackUrl, { external: true })
    expect(signInMock).not.toHaveBeenCalled()
  })
})
