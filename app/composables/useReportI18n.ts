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
    // Tolgee applies defaultValue only when resolution (including language
    // fallback) fails; an intentionally empty translation remains ''. A second
    // default disambiguates a real value equal to the first probe's default.
    // Keep probes unwrapped, but retain normal in-context wrapping when rendering.
    const probe = t.value(key, '', { noWrap: true })
    if (probe === '' && t.value(key, 'missing', { noWrap: true }) === 'missing') {
      if (isDevWarnEnabled) {
        console.warn(`[useReportI18n] missing translation for key "${key}" — using fallback.`)
      }
      return interpolate(fallback, params)
    }
    return interpolate(t.value(key), params)
  }

  return { tr }
}
