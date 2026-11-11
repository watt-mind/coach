// @vitest-environment nuxt

import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteLocationNormalizedGeneric } from 'vue-router'
import oauthAuthMiddleware from '~/middleware/oauth-auth'

type MockUser = {
  deactivatedAt?: string | Date | null
}

type AuthMockState = {
  status: { value: 'authenticated' | 'unauthenticated' | 'loading' }
  data: { value: { user: MockUser } | null }
  getSession: ReturnType<typeof vi.fn>
  signOut: ReturnType<typeof vi.fn>
}

const { navigateToMock, authMockRef } = vi.hoisted(() => ({
  navigateToMock: vi.fn(),
  authMockRef: { current: null as AuthMockState | null }
}))

mockNuxtImport('navigateTo', () => navigateToMock)
mockNuxtImport('useAuth', () => () => authMockRef.current)

function makeRoute(
  path: string,
  query: Record<string, string> = {},
  fullPath?: string
): RouteLocationNormalizedGeneric {
  const qs = new URLSearchParams(query).toString()
  return {
    path,
    fullPath: fullPath ?? (qs ? `${path}?${qs}` : path),
    query,
    params: {},
    hash: '',
    matched: [],
    meta: {},
    name: undefined,
    redirectedFrom: undefined
  } as unknown as RouteLocationNormalizedGeneric
}

function buildAuthMock(options: {
  status?: 'authenticated' | 'unauthenticated' | 'loading'
  user?: MockUser | null
  getSession?: ReturnType<typeof vi.fn>
  signOut?: ReturnType<typeof vi.fn>
}): AuthMockState {
  return {
    status: { value: options.status ?? 'authenticated' },
    data: { value: options.user ? { user: options.user } : null },
    getSession: options.getSession ?? vi.fn().mockResolvedValue(null),
    signOut: options.signOut ?? vi.fn().mockResolvedValue(undefined)
  }
}

describe('oauth-auth middleware signOut failure fallback (CW-372)', () => {
  beforeEach(() => {
    navigateToMock.mockReset()
    authMockRef.current = null
  })

  it('signs out with the prompt-stripped callbackUrl on the happy path', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined)
    authMockRef.current = buildAuthMock({ status: 'authenticated', user: {}, signOut })

    const to = makeRoute('/oauth/authorize', { prompt: 'login', client_id: 'x' })
    await oauthAuthMiddleware(to, to)

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/oauth/authorize?client_id=x' })
    expect(navigateToMock).not.toHaveBeenCalled()
  })

  it('falls back to navigateTo with the same target when prompt=login signOut rejects', async () => {
    const signOut = vi.fn().mockRejectedValue(new Error('sign-out endpoint failed'))
    authMockRef.current = buildAuthMock({ status: 'authenticated', user: {}, signOut })

    const to = makeRoute('/oauth/authorize', { prompt: 'login', client_id: 'x' })
    await expect(oauthAuthMiddleware(to, to)).resolves.not.toThrow()

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledWith('/oauth/authorize?client_id=x')
  })

  it('falls back to navigateTo when prompt=login signOut throws synchronously', async () => {
    const signOut = vi.fn().mockImplementation(() => {
      throw new Error('sync signOut boom')
    })
    authMockRef.current = buildAuthMock({ status: 'authenticated', user: {}, signOut })

    const to = makeRoute('/oauth/authorize', { prompt: 'login' })
    await expect(oauthAuthMiddleware(to, to)).resolves.not.toThrow()

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledWith('/oauth/authorize')
  })

  it('falls back to navigateTo /login?error=deactivated when deactivated signOut rejects', async () => {
    const signOut = vi.fn().mockRejectedValue(new Error('sign-out endpoint failed'))
    authMockRef.current = buildAuthMock({
      status: 'authenticated',
      user: { deactivatedAt: '2024-06-01T00:00:00.000Z' },
      signOut
    })

    const to = makeRoute('/oauth/authorize', { client_id: 'x' })
    await expect(oauthAuthMiddleware(to, to)).resolves.not.toThrow()

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login?error=deactivated' })
    expect(navigateToMock).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledWith('/login?error=deactivated')
  })

  it('falls back to navigateTo /login?error=deactivated when deactivated signOut throws synchronously', async () => {
    const signOut = vi.fn().mockImplementation(() => {
      throw new Error('sync signOut boom')
    })
    authMockRef.current = buildAuthMock({
      status: 'authenticated',
      user: { deactivatedAt: '2024-06-01T00:00:00.000Z' },
      signOut
    })

    const to = makeRoute('/oauth/authorize', { client_id: 'x' })
    await expect(oauthAuthMiddleware(to, to)).resolves.not.toThrow()

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledTimes(1)
    expect(navigateToMock).toHaveBeenCalledWith('/login?error=deactivated')
  })

  it('still signs out deactivated users on the happy path without an extra redirect', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined)
    authMockRef.current = buildAuthMock({
      status: 'authenticated',
      user: { deactivatedAt: '2024-06-01T00:00:00.000Z' },
      signOut
    })

    const to = makeRoute('/oauth/authorize', { client_id: 'x' })
    await oauthAuthMiddleware(to, to)

    expect(signOut).toHaveBeenCalledTimes(1)
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login?error=deactivated' })
    expect(navigateToMock).not.toHaveBeenCalled()
  })
})
