import { useTranslate } from '@tolgee/vue'

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template
  let result = template
  for (const [name, value] of Object.entries(params)) {
    result = result.replace(`{${name}}`, String(value))
  }
  return result
}

// Dev detection: `import.meta.dev` in the Nuxt app, `import.meta.env.DEV`
// under Vitest (where `import.meta.dev` is statically `false`), with a
// `NODE_ENV` fallback for plain runtimes. All three are `false` in
// production builds, so the warning stays dev-only.
const meta = import.meta as unknown as { dev?: boolean; env?: { DEV?: boolean } }
const isDevWarnEnabled =
  Boolean(meta.dev) || Boolean(meta.env?.DEV) || process.env.NODE_ENV !== 'production'

export function useReportI18n() {
  const { t } = useTranslate('report')

  const tr = (key: string, fallback: string, params?: Record<string, string | number>) => {
    if (typeof t.value !== 'function') return interpolate(fallback, params)
    // Ask Tolgee whether the key resolves instead of inferring it from the
    // returned value: with `orEmpty`, a key absent from both the active
    // locale and the English fallback resolves to '' — while a translation
    // whose value legitimately equals its key still resolves truthy (CW-450).
    // `noWrap` keeps the probe a raw string when the in-context observer is
    // active; the rendered lookup below stays wrapped for in-context editing.
    const probe = t.value(key, { noWrap: true, orEmpty: true })
    if (!probe) {
      if (isDevWarnEnabled) {
        console.warn(`[useReportI18n] missing translation for key "${key}" — using fallback.`)
      }
      return interpolate(fallback, params)
    }
    return interpolate(t.value(key), params)
  }

  return { tr }
}
