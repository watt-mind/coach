import { defineStore, skipHydrate } from 'pinia'

export const ACT_AS_COOKIE_NAME = 'coach_wattz_act_as_user'
const ACT_AS_DASHBOARD_PATH = '/dashboard'

/**
 * Read the act-as identity from the cookie — the only persistence the server
 * reads. On the server this comes from the request header via `useCookie`
 * (SSR-safe); on the client it is parsed from `document.cookie` directly so
 * manual writes via `persistActAsCookie` (and test setup) are always fresh
 * without depending on a cached `useCookie` ref (CW-644).
 *
 * Returns the decoded ID or `null` when absent/empty. Never throws — outside
 * a Nuxt context (or with a malformed value) it safely yields `null`.
 */
function readActAsCookieId(): string | null {
  if (import.meta.client) {
    if (typeof document === 'undefined') return null
    const match = document.cookie.match(new RegExp(`(?:^|; )${ACT_AS_COOKIE_NAME}=([^;]*)`))
    const captured = match?.[1]
    if (captured == null) return null
    const raw = captured.trim()
    if (!raw) return null
    try {
      const decoded = decodeURIComponent(raw).trim()
      return decoded || null
    } catch {
      return raw || null
    }
  }

  try {
    const raw = useCookie<string | null>(ACT_AS_COOKIE_NAME).value
    if (raw == null) return null
    const text = String(raw).trim()
    if (!text) return null
    try {
      const decoded = decodeURIComponent(text).trim()
      return decoded || null
    } catch {
      return text || null
    }
  } catch {
    return null
  }
}

function persistActAsCookie(userId: string | null) {
  if (!import.meta.client) return

  if (!userId) {
    document.cookie = `${ACT_AS_COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`
    return
  }

  document.cookie = `${ACT_AS_COOKIE_NAME}=${encodeURIComponent(userId)}; path=/; SameSite=Lax`
}

/**
 * Hard-navigate so identity-scoped Pinia caches (user, profile, entitlements)
 * are wiped and re-fetched under the new act-as (or restored coach) identity.
 */
function hardResetForIdentityChange(path?: string) {
  if (!import.meta.client) return

  if (path) {
    window.location.assign(path)
    return
  }

  window.location.reload()
}

export interface PendingActAsRequest {
  userId: string
  userName: string
}

export const useCoachingStore = defineStore('coaching', () => {
  // Identity source of truth is the `coach_wattz_act_as_user` cookie (CW-644).
  //
  // `app/plugins/coaching-interceptor.ts` has no `.client` suffix, so it is
  // universal and instantiates this store during SSR. Previously the store
  // restored from localStorage on the client only, while SSR always serialised
  // `null` — so SSR rendered `isCoachingMode=false` while the client flipped
  // to `true`, changing coach selectors on library pages after hydration.
  // Reading the cookie on both sides gives SSR and the initial client the
  // same identity, so `isCoachingMode` agrees and selectors do not diverge.
  //
  // The cookie is intent only, never authorization: `server/utils/session.ts`
  // still validates the coaching relationship before impersonating (read-only
  // here). Stale localStorage must never recreate an absent cookie or override
  // a different one — the cookie always wins (CW-644).
  //
  // `skipHydrate` history: CW-637 added it to stop SSR `null`s wiping the
  // localStorage restore. Cookie hydration now makes it unnecessary for the
  // ID (SSR serialises the cookie value, so hydration re-applies the same
  // ID). It is retained on the display name only: the name cache lives in
  // localStorage with no SSR source, and the banner that renders it is
  // `ClientOnly`, so skipping its hydration preserves the cached name without
  // affecting SSR agreement (which depends on the ID alone).
  const initialActAsId = readActAsCookieId()
  const actingAsUserId = ref<string | null>(initialActAsId)
  const actingAsUserName = skipHydrate(ref<string | null>(initialActAsId))

  /**
   * Act-as switches identity for the whole app and survives reloads, so it is
   * never entered on a single click. Every trigger stages the request here and
   * `CoachingBanner` renders the confirmation that commits it (CW-541).
   */
  const pendingActAs = ref<PendingActAsRequest | null>(null)

  // Resolve the display name on the client only. The cached name accompanies
  // the matching ID; any other cached value falls back to the ID itself so a
  // stale name for a different athlete is never displayed (CW-644). When no
  // cookie exists, stale legacy keys are cleared so a cached ID alone can
  // never silently start impersonation.
  if (import.meta.client) {
    if (initialActAsId) {
      const savedId = localStorage.getItem('coaching_act_as_id')
      const savedName = localStorage.getItem('coaching_act_as_name')
      if (savedId === initialActAsId && savedName) {
        actingAsUserName.value = savedName
      } else {
        actingAsUserName.value = initialActAsId
        try {
          localStorage.setItem('coaching_act_as_id', initialActAsId)
          localStorage.setItem('coaching_act_as_name', initialActAsId)
        } catch {
          // Storage unavailable — the cookie remains the authority.
        }
      }
    } else {
      actingAsUserName.value = null
      try {
        localStorage.removeItem('coaching_act_as_id')
        localStorage.removeItem('coaching_act_as_name')
      } catch {
        // Storage unavailable — nothing to clean.
      }
    }
  }

  const isCoachingMode = computed(() => !!actingAsUserId.value)
  const hasPendingActAsRequest = computed(() => !!pendingActAs.value)

  function commitActingAs(userId: string, userName: string) {
    actingAsUserId.value = userId
    actingAsUserName.value = userName
    if (import.meta.client) {
      localStorage.setItem('coaching_act_as_id', userId)
      localStorage.setItem('coaching_act_as_name', userName)
      persistActAsCookie(userId)
      // Mirror stopActingAs: full navigation clears stale coach identity UI
      hardResetForIdentityChange(ACT_AS_DASHBOARD_PATH)
    }
  }

  /**
   * Stage an act-as request. Does NOT change identity — it opens the global
   * confirmation. Every "act as athlete" trigger in the app calls this.
   */
  function startActingAs(userId: string, userName: string) {
    pendingActAs.value = { userId, userName }
  }

  /** Commit the staged request. No-op when nothing is pending. */
  function confirmActingAs() {
    const pending = pendingActAs.value
    if (!pending) return
    pendingActAs.value = null
    commitActingAs(pending.userId, pending.userName)
  }

  /** Dismiss the staged request without changing identity. */
  function cancelActingAs() {
    pendingActAs.value = null
  }

  /** Drop every trace of act-as: in-memory state, both localStorage keys, the cookie. */
  function clearActingAs() {
    actingAsUserId.value = null
    actingAsUserName.value = null
    pendingActAs.value = null
    if (import.meta.client) {
      // Clear the cookie FIRST, and in a `finally` so a storage exception cannot
      // skip it. The cookie is the only one of the three the *server* reads, so
      // if a `removeItem` throws (storage disabled or over quota) with the
      // cookie still set, the server keeps impersonating while the client
      // believes it exited — and, with no client state left, renders no exit
      // affordance. That is the half-impersonating state this ticket exists to
      // eliminate, so it must not be reachable through the exit path itself.
      try {
        persistActAsCookie(null)
      } finally {
        localStorage.removeItem('coaching_act_as_id')
        localStorage.removeItem('coaching_act_as_name')
      }
    }
  }

  function stopActingAs() {
    clearActingAs()
    // Force reload to clear all states and re-fetch session
    hardResetForIdentityChange()
  }

  return {
    actingAsUserId,
    actingAsUserName,
    pendingActAs,
    isCoachingMode,
    hasPendingActAsRequest,
    startActingAs,
    confirmActingAs,
    cancelActingAs,
    clearActingAs,
    stopActingAs
  }
})
