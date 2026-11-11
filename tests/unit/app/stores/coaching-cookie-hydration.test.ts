// @vitest-environment nuxt

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCoachingStore, ACT_AS_COOKIE_NAME } from '../../../../app/stores/coaching'

const COOKIE = ACT_AS_COOKIE_NAME

function setCookie(userId: string | null) {
  if (userId) {
    document.cookie = `${COOKIE}=${encodeURIComponent(userId)}; path=/; SameSite=Lax`
  } else {
    document.cookie = `${COOKIE}=; path=/; max-age=0; SameSite=Lax`
  }
}

function getCookieRaw(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`))
  if (!match) return null
  const raw = match[1]
  return raw ? raw : null
}

function setLegacyStorage(userId: string | null, userName: string | null) {
  if (userId == null) {
    localStorage.removeItem('coaching_act_as_id')
  } else {
    localStorage.setItem('coaching_act_as_id', userId)
  }
  if (userName == null) {
    localStorage.removeItem('coaching_act_as_name')
  } else {
    localStorage.setItem('coaching_act_as_name', userName)
  }
}

/** Fresh Pinia + store, mirroring a first load (SSR payload applied beforehand when given). */
function createFreshStore(ssrPayload?: Record<string, unknown> | null) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (ssrPayload !== undefined) {
    // Simulate the serialized SSR Pinia payload the client hydrates from.
    // `null` simulates the historical pre-fix payload that always carried nulls.
    pinia.state.value.coaching = ssrPayload as never
  }
  return useCoachingStore()
}

describe('useCoachingStore cookie hydration (CW-644)', () => {
  let assignSpy: ReturnType<typeof vi.fn>
  let reloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    setCookie(null)

    assignSpy = vi.fn()
    reloadSpy = vi.fn()
    vi.stubGlobal('location', {
      ...window.location,
      assign: assignSpy,
      reload: reloadSpy
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    setCookie(null)
  })

  it('no cookie produces no identity on init (SSR and client agree)', () => {
    const store = createFreshStore()

    expect(store.actingAsUserId).toBeNull()
    expect(store.actingAsUserName).toBeNull()
    expect(store.isCoachingMode).toBe(false)
  })

  it('a valid cookie alone initializes identity without localStorage (SSR-safe source)', () => {
    setCookie('athlete-123')

    const store = createFreshStore()

    expect(store.actingAsUserId).toBe('athlete-123')
    expect(store.isCoachingMode).toBe(true)
    // No cached name exists, so the safe fallback accompanies the ID.
    expect(store.actingAsUserName).toBe('athlete-123')
  })

  it('cookie wins over absent localStorage and does not rewrite the cookie from storage', () => {
    setCookie('athlete-123')
    // storage empty

    const store = createFreshStore()

    expect(store.actingAsUserId).toBe('athlete-123')
    expect(getCookieRaw()).toBe('athlete-123')
  })

  it('matching cached storage supplies the display name for the same ID', () => {
    setCookie('athlete-123')
    setLegacyStorage('athlete-123', 'Ada Athlete')

    const store = createFreshStore()

    expect(store.actingAsUserId).toBe('athlete-123')
    expect(store.actingAsUserName).toBe('Ada Athlete')
    expect(store.isCoachingMode).toBe(true)
  })

  it('conflicting localStorage does not override a different cookie, and the wrong name is never displayed', () => {
    setCookie('athlete-123')
    setLegacyStorage('athlete-999', 'Mallory Other')

    const store = createFreshStore()

    expect(store.actingAsUserId).toBe('athlete-123')
    expect(store.isCoachingMode).toBe(true)
    expect(store.actingAsUserName).not.toBe('Mallory Other')
    expect(store.actingAsUserName).toBe('athlete-123')
    // The cookie itself is untouched by stale storage.
    expect(getCookieRaw()).toBe('athlete-123')
  })

  it('a stale cached ID alone cannot start impersonation when the cookie is absent', () => {
    setCookie(null)
    setLegacyStorage('athlete-123', 'Ada Athlete')

    const store = createFreshStore()

    expect(store.actingAsUserId).toBeNull()
    expect(store.actingAsUserName).toBeNull()
    expect(store.isCoachingMode).toBe(false)
    // Stale keys are cleared so they cannot linger into a later load.
    expect(localStorage.getItem('coaching_act_as_id')).toBeNull()
    expect(localStorage.getItem('coaching_act_as_name')).toBeNull()
    expect(getCookieRaw()).toBeNull()
  })

  it('init never recreates an absent cookie from stale storage', () => {
    setCookie(null)
    setLegacyStorage('athlete-123', 'Ada Athlete')

    createFreshStore()

    expect(document.cookie).not.toContain(`${COOKIE}=athlete-123`)
  })

  it('serialized SSR payload with the cookie identity hydrates without wiping first-load identity', () => {
    setCookie('athlete-123')
    setLegacyStorage('athlete-123', 'Ada Athlete')

    // SSR saw the same cookie, so its payload carries the identity.
    const ssrPayload = {
      actingAsUserId: 'athlete-123',
      actingAsUserName: 'athlete-123',
      pendingActAs: null
    }
    const store = createFreshStore(ssrPayload)

    expect(store.actingAsUserId).toBe('athlete-123')
    expect(store.isCoachingMode).toBe(true)
  })

  it('serialized payload hydrates with conflicting storage present without adopting the stale ID', () => {
    setCookie('athlete-123')
    setLegacyStorage('athlete-999', 'Mallory Other')

    const ssrPayload = {
      actingAsUserId: 'athlete-123',
      actingAsUserName: 'athlete-123',
      pendingActAs: null
    }
    const store = createFreshStore(ssrPayload)

    expect(store.actingAsUserId).toBe('athlete-123')
    expect(store.actingAsUserName).not.toBe('Mallory Other')
    expect(store.isCoachingMode).toBe(true)
  })

  it('absent historical payload with no cookie stays signed out (no false impersonation)', () => {
    setCookie(null)
    localStorage.clear()

    const store = createFreshStore(undefined)

    expect(store.actingAsUserId).toBeNull()
    expect(store.isCoachingMode).toBe(false)
  })

  it('confirmation is still required; cancel never switches identity or writes persistence', () => {
    setCookie(null)
    const store = createFreshStore()

    store.startActingAs('athlete-123', 'Ada Athlete')

    expect(store.actingAsUserId).toBeNull()
    expect(store.isCoachingMode).toBe(false)
    expect(getCookieRaw()).toBeNull()

    store.cancelActingAs()

    expect(store.actingAsUserId).toBeNull()
    expect(store.pendingActAs).toBeNull()
    expect(localStorage.getItem('coaching_act_as_id')).toBeNull()
    expect(getCookieRaw()).toBeNull()
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it('confirm persists the cookie and legacy storage, then hard-navigates', () => {
    setCookie(null)
    const store = createFreshStore()

    store.startActingAs('athlete-123', 'Ada Athlete')
    store.confirmActingAs()

    expect(store.actingAsUserId).toBe('athlete-123')
    expect(store.actingAsUserName).toBe('Ada Athlete')
    expect(store.isCoachingMode).toBe(true)
    expect(getCookieRaw()).toBe('athlete-123')
    expect(localStorage.getItem('coaching_act_as_id')).toBe('athlete-123')
    expect(localStorage.getItem('coaching_act_as_name')).toBe('Ada Athlete')
    expect(assignSpy).toHaveBeenCalledWith('/dashboard')
  })

  it('exit clears the cookie and legacy storage and restores coach identity', () => {
    setCookie('athlete-123')
    setLegacyStorage('athlete-123', 'Ada Athlete')
    const store = createFreshStore()
    expect(store.isCoachingMode).toBe(true)
    assignSpy.mockClear()

    store.stopActingAs()

    expect(store.actingAsUserId).toBeNull()
    expect(store.actingAsUserName).toBeNull()
    expect(store.isCoachingMode).toBe(false)
    expect(localStorage.getItem('coaching_act_as_id')).toBeNull()
    expect(localStorage.getItem('coaching_act_as_name')).toBeNull()
    expect(document.cookie).not.toContain(`${COOKIE}=athlete-123`)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })
})
