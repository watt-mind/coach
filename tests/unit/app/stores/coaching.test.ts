// @vitest-environment nuxt

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCoachingStore } from '../../../../app/stores/coaching'

describe('useCoachingStore Pinia Store', () => {
  let assignSpy: ReturnType<typeof vi.fn>
  let reloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    localStorage.clear()
    document.cookie = 'coach_wattz_act_as_user=; path=/; max-age=0; SameSite=Lax'

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
  })

  /** Enter act-as the way the UI does: request, then confirm. */
  function enterActingAs(store: ReturnType<typeof useCoachingStore>) {
    store.startActingAs('athlete-123', 'Ada Athlete')
    store.confirmActingAs()
  }

  it('initializes with empty act-as state', () => {
    const store = useCoachingStore()
    expect(store.actingAsUserId).toBeNull()
    expect(store.actingAsUserName).toBeNull()
    expect(store.isCoachingMode).toBe(false)
    expect(store.pendingActAs).toBeNull()
    expect(store.hasPendingActAsRequest).toBe(false)
  })

  it('startActingAs only stages a request — a single click never switches identity', () => {
    const store = useCoachingStore()
    store.startActingAs('athlete-123', 'Ada Athlete')

    expect(store.pendingActAs).toEqual({ userId: 'athlete-123', userName: 'Ada Athlete' })
    expect(store.hasPendingActAsRequest).toBe(true)
    // Nothing committed yet
    expect(store.actingAsUserId).toBeNull()
    expect(store.isCoachingMode).toBe(false)
    expect(localStorage.getItem('coaching_act_as_id')).toBeNull()
    expect(document.cookie).not.toContain('coach_wattz_act_as_user=athlete-123')
    expect(assignSpy).not.toHaveBeenCalled()
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('cancelActingAs discards the request and leaves the coach identity untouched', () => {
    const store = useCoachingStore()
    store.startActingAs('athlete-123', 'Ada Athlete')

    store.cancelActingAs()

    expect(store.pendingActAs).toBeNull()
    expect(store.hasPendingActAsRequest).toBe(false)
    expect(store.actingAsUserId).toBeNull()
    expect(store.isCoachingMode).toBe(false)
    expect(localStorage.getItem('coaching_act_as_id')).toBeNull()
    expect(assignSpy).not.toHaveBeenCalled()
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('confirmActingAs persists identity and hard-navigates to dashboard', () => {
    const store = useCoachingStore()
    enterActingAs(store)

    expect(store.pendingActAs).toBeNull()
    expect(store.actingAsUserId).toBe('athlete-123')
    expect(store.actingAsUserName).toBe('Ada Athlete')
    expect(store.isCoachingMode).toBe(true)
    expect(localStorage.getItem('coaching_act_as_id')).toBe('athlete-123')
    expect(localStorage.getItem('coaching_act_as_name')).toBe('Ada Athlete')
    expect(document.cookie).toContain('coach_wattz_act_as_user=athlete-123')
    expect(assignSpy).toHaveBeenCalledWith('/dashboard')
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('confirmActingAs is a no-op when nothing is pending', () => {
    const store = useCoachingStore()

    store.confirmActingAs()

    expect(store.actingAsUserId).toBeNull()
    expect(store.isCoachingMode).toBe(false)
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it('stopActingAs clears identity and reloads to restore coach session', () => {
    const store = useCoachingStore()
    enterActingAs(store)
    assignSpy.mockClear()

    store.stopActingAs()

    expect(store.actingAsUserId).toBeNull()
    expect(store.actingAsUserName).toBeNull()
    expect(store.isCoachingMode).toBe(false)
    expect(localStorage.getItem('coaching_act_as_id')).toBeNull()
    expect(localStorage.getItem('coaching_act_as_name')).toBeNull()
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it('stopActingAs expires the act-as cookie so the server stops impersonating', () => {
    const store = useCoachingStore()
    enterActingAs(store)

    store.stopActingAs()

    expect(document.cookie).not.toContain('coach_wattz_act_as_user=athlete-123')
  })

  it('clearActingAs clears persistence without navigating', () => {
    const store = useCoachingStore()
    enterActingAs(store)
    assignSpy.mockClear()

    store.clearActingAs()

    expect(store.actingAsUserId).toBeNull()
    expect(localStorage.getItem('coaching_act_as_id')).toBeNull()
    expect(localStorage.getItem('coaching_act_as_name')).toBeNull()
    expect(assignSpy).not.toHaveBeenCalled()
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('clearActingAs also discards a pending request', () => {
    const store = useCoachingStore()
    store.startActingAs('athlete-123', 'Ada Athlete')

    store.clearActingAs()

    expect(store.pendingActAs).toBeNull()
    expect(store.hasPendingActAsRequest).toBe(false)
  })
})
