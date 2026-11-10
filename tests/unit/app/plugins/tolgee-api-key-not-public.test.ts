import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * CW-610 — the Tolgee API key must never reach the client payload.
 *
 * `runtimeConfig.public` is serialised into the HTML of every response, so a
 * secret declared there ships to every visitor in every environment. The key is
 * therefore declared only under nuxt.config.ts's `$development` block, which
 * c12 merges when `nuxt.options.dev` is true (i.e. `nuxt dev`) and never during
 * `nuxt build`.
 *
 * Declaring it (even as an empty string) is what these tests guard against: a
 * declared key can be overwritten at runtime by `NUXT_PUBLIC_TOLGEE_API_KEY`,
 * because nitro's `applyEnv` walks `for (const key in obj)` and can only
 * overwrite keys that already exist — it cannot create them.
 */

// Sentinels — deliberately fake. Never put a real key in a fixture.
const API_KEY_SENTINEL = 'tgpak_cw610_fake_key_sentinel_do_not_use'
const PUBLIC_API_KEY_SENTINEL = 'tgpak_cw610_fake_public_key_sentinel_do_not_use'
const API_URL_SENTINEL = 'https://tolgee.cw610.invalid'

type LoadedNuxtConfig = {
  runtimeConfig?: { public?: Record<string, unknown> }
  $development?: { runtimeConfig?: { public?: Record<string, unknown> } }
}

const TOLGEE_ENV_KEYS = [
  'TOLGEE_API_ENABLED',
  'TOLGEE_API_KEY',
  'TOLGEE_API_URL',
  'NUXT_PUBLIC_TOLGEE_API_KEY',
  'NUXT_PUBLIC_TOLGEE_API_URL'
] as const

let savedEnv: Record<string, string | undefined> = {}

/**
 * Evaluate nuxt.config.ts with Tolgee fully enabled, the way a misconfigured
 * deployment would have it, and hand back the raw config object.
 */
async function loadNuxtConfig(): Promise<LoadedNuxtConfig> {
  vi.resetModules()
  vi.stubGlobal('defineNuxtConfig', (config: LoadedNuxtConfig) => config)
  const mod = await import('../../../../nuxt.config')
  return mod.default as unknown as LoadedNuxtConfig
}

beforeEach(() => {
  savedEnv = Object.fromEntries(TOLGEE_ENV_KEYS.map((key) => [key, process.env[key]]))

  // The worst realistic misconfiguration: every Tolgee env var set on a stack.
  process.env.TOLGEE_API_ENABLED = 'true'
  process.env.TOLGEE_API_URL = API_URL_SENTINEL
  process.env.TOLGEE_API_KEY = API_KEY_SENTINEL
  process.env.NUXT_PUBLIC_TOLGEE_API_URL = API_URL_SENTINEL
  process.env.NUXT_PUBLIC_TOLGEE_API_KEY = PUBLIC_API_KEY_SENTINEL
})

afterEach(() => {
  for (const key of TOLGEE_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      Reflect.deleteProperty(process.env, key)
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('CW-610: Tolgee credentials stay out of runtimeConfig.public', () => {
  it('does not declare a `tolgee` key in runtimeConfig.public', async () => {
    const config = await loadNuxtConfig()
    const publicConfig = config.runtimeConfig?.public ?? {}

    // `in` rather than a truthiness check: an undefined-but-declared key is
    // still overridable by NUXT_PUBLIC_TOLGEE_API_KEY at runtime.
    expect('tolgee' in publicConfig).toBe(false)
  })

  it('declares no public runtime config key that looks Tolgee-related', async () => {
    const config = await loadNuxtConfig()
    const publicConfig = config.runtimeConfig?.public ?? {}

    expect(Object.keys(publicConfig).filter((key) => /tolgee/i.test(key))).toEqual([])
  })

  it('serialises runtimeConfig.public without either API key sentinel', async () => {
    const config = await loadNuxtConfig()

    // This is the value Nuxt embeds in the HTML payload sent to every browser.
    const serialisedPayload = JSON.stringify(config.runtimeConfig?.public ?? {})

    expect(serialisedPayload).not.toContain(API_KEY_SENTINEL)
    expect(serialisedPayload).not.toContain(PUBLIC_API_KEY_SENTINEL)
  })

  it('still hands the dev server its Tolgee credentials via $development', async () => {
    const config = await loadNuxtConfig()
    const devTolgee = config.$development?.runtimeConfig?.public?.tolgee as
      { apiUrl?: string; apiKey?: string } | undefined

    // In-context translation must keep working in local development.
    expect(devTolgee?.apiUrl).toBe(API_URL_SENTINEL)
    expect(devTolgee?.apiKey).toBe(PUBLIC_API_KEY_SENTINEL)
  })

  it('leaves $development.tolgee empty when TOLGEE_API_ENABLED is not "true"', async () => {
    process.env.TOLGEE_API_ENABLED = 'false'

    const config = await loadNuxtConfig()
    const devTolgee = config.$development?.runtimeConfig?.public?.tolgee as
      { apiUrl?: string; apiKey?: string } | undefined

    expect(devTolgee?.apiUrl).toBeUndefined()
    expect(devTolgee?.apiKey).toBeUndefined()
  })
})
