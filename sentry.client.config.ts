import * as Sentry from '@sentry/nuxt'

// CW-601: same OAuth-credential scrubber as sentry.server.config.ts.
// The client rarely sees callback URLs, but a throw during the redirect
// (page still carrying ?code=...&state=...) would ship them via the
// client SDK too. Duplicated on purpose: both files are isolated Sentry
// entry points.
function scrubSentryData<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(
      /(^|[?&;])((?:code|state|access_token|refresh_token|id_token|client_secret)=)[^&#;\s]*/gi,
      '$1$2[Filtered]'
    ) as T
  }
  if (Array.isArray(value)) return value.map(scrubSentryData) as T
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(code|state|access_token|refresh_token|id_token|client_secret)$/i.test(key)) {
        ;(value as Record<string, unknown>)[key] = '[Filtered]'
      } else {
        ;(value as Record<string, unknown>)[key] = scrubSentryData(item)
      }
    }
  }
  return value
}

const config = useRuntimeConfig()

if (!config.public.sentryEnabled || !config.public.sentryDsn) {
  // Sentry is disabled in local dev unless SENTRY_ENABLED=true.
} else {
  Sentry.init({
    dsn: config.public.sentryDsn as string,
    release: config.public.sentryRelease as string,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration(),
      Sentry.consoleLoggingIntegration({ levels: ['log', 'warn', 'error'] })
    ],
    enableLogs: true,
    // CW-601: see sentry.server.config.ts — PII collection is not needed
    // for triage; turning it off is the stronger fix, scrubber stays as
    // defense-in-depth.
    sendDefaultPii: false,
    debug: false,
    environment: process.env.NODE_ENV || 'development',
    ignoreErrors: [
      'Object Not Found Matching Id:2, MethodName:update',
      'Object Not Found Matching Id:3, MethodName:update',
      '/api/auth/session',
      '/_nuxt/builds/meta/dev.json',
      'Failed to fetch dynamically imported module',
      'Importing a module script failed',
      'error loading dynamically imported module',
      'useLocalStorage is not defined',
      'getActivePinia()'
    ],
    beforeBreadcrumb(breadcrumb) {
      return scrubSentryData(breadcrumb)
    },
    beforeSendSpan(span) {
      return scrubSentryData(span)
    },
    beforeSend(event) {
      const message = event.exception?.values?.[0]?.value || event.message || ''
      if (typeof message === 'string') {
        if (message === 'Page not found' && event.request?.url?.includes('/documentation/')) {
          return null
        }
        if (message.includes('Failed to parse JSON file') && message.includes('hero.json')) {
          return null
        }
      }
      return scrubSentryData(event)
    }
  })
}
