// @vitest-environment nuxt

import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from '../../../../app/stores/user'

mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
mockNuxtImport('useUserRuns', () => () => ({ refresh: vi.fn() }))
mockNuxtImport('useUserRunsState', () => () => ({ onTaskCompleted: vi.fn() }))

describe('useUserStore Pinia Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.stubGlobal('$fetch', vi.fn())
  })

  it('initializes with default empty state', () => {
    const store = useUserStore()
    expect(store.user).toBeNull()
    expect(store.profile).toBeNull()
    expect(store.dataSyncStatus).toBeNull()
    expect(store.userLoading).toBe(false)
  })

  it('fetches user data successfully via fetchUser()', async () => {
    const mockUserData = {
      id: 'user-123',
      email: 'runner@example.com',
      name: 'Jane Runner',
      subscriptionTier: 'PRO',
      subscriptionStatus: 'ACTIVE'
    }

    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(mockUserData))

    const store = useUserStore()
    await store.fetchUser()

    expect(store.user).toEqual(mockUserData)
    expect(store.userLoading).toBe(false)
  })

  it('handles fetchUser failure gracefully', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const store = useUserStore()
    await store.fetchUser()

    expect(store.user).toBeNull()
    expect(store.userLoading).toBe(false)
  })

  it('returns the cached profile without refetching when not forced', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ profile: { id: 'cached' }, dataSyncStatus: null, missingFields: [] })
    vi.stubGlobal('$fetch', fetchMock)

    const store = useUserStore()
    await store.fetchProfile()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    await store.fetchProfile()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.profile).toEqual({ id: 'cached' })
  })

  it('refetches the profile when force=true even with a populated cache (CW-852)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        profile: { id: 'stale' },
        dataSyncStatus: { latestWellnessDate: '2026-11-01' },
        missingFields: ['weight', 'height']
      })
      .mockResolvedValueOnce({
        profile: { id: 'fresh' },
        dataSyncStatus: { latestWellnessDate: '2026-11-11' },
        missingFields: ['height']
      })
    vi.stubGlobal('$fetch', fetchMock)

    const store = useUserStore()
    await store.fetchProfile()
    expect(store.profile).toEqual({ id: 'stale' })
    expect(store.dataSyncStatus).toEqual({ latestWellnessDate: '2026-11-01' })
    expect(store.missingFields).toEqual(['weight', 'height'])

    await store.fetchProfile(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.profile).toEqual({ id: 'fresh' })
    expect(store.dataSyncStatus).toEqual({ latestWellnessDate: '2026-11-11' })
    expect(store.missingFields).toEqual(['height'])
  })
})
