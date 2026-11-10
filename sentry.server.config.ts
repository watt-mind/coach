import * as Sentry from '@sentry/nuxt'

// CW-601: OAuth callback URLs carry single-use credentials
// (`/api/integrations/<provider>/callback?code=...&state=...`). Any throw
// inside a callback handler ships `event.request.url` to Sentry, so scrub
// sensitive query params by name across ALL routes — never per-provider — so
// newly added integrations are covered by default. The same helper also runs
// over breadcrumbs, query_string blobs, and transaction/span payloads, which
// can embed the URL through other Sentry channels.
// Duplicated (not imported) in sentry.client/server.config.ts on purpose:
// both files are isolated Sentry entry points.
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
    integrations: [Sentry.consoleLoggingIntegration({ levels: ['log', 'warn', 'error'] })],
    enableLogs: true,
    // CW-601: `sendDefaultPii` was true, which attaches request headers,
    // cookies, and IPs to every event. Nothing in triage needs that PII
    // (no Sentry.setUser / PII-based grouping in this repo), and it widens
    // the blast radius of any unspent credential that slips through. The
    // stronger fix is to stop collecting it; the scrubber above stays as
    // defense-in-depth for URLs that still reach Sentry.
    sendDefaultPii: false,
    debug: false,
    environment: process.env.NODE_ENV || 'development',
    beforeBreadcrumb(breadcrumb) {
      return scrubSentryData(breadcrumb)
    },
    beforeSendSpan(span) {
      return scrubSentryData(span)
    },
    beforeSend(event, hint) {
      const error = hint.originalException

      if (
        error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'IntegrationAuthError'
      ) {
        return null
      }

      const exceptionValues = event.exception?.values ?? []
      const messages = [event.message, ...exceptionValues.map((value) => value?.value)].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
      const message = messages[0] || ''
      const combinedMessage = messages.join('\n')
      const requestUrl = event.request?.url || event.transaction || ''
      const isDevelopment = (process.env.NODE_ENV || 'development') !== 'production'

      if (typeof message === 'string') {
        if (message.includes('no such table: _content_content')) {
          return null
        }

        if (/Failed to refresh (Ultrahuman|Whoop|Withings) token/i.test(message)) {
          return null
        }

        if (message === 'Page not found' && event.request?.url?.includes('/documentation/')) {
          return null
        }

        if (message.includes('Failed to parse JSON file') && message.includes('hero.json')) {
          return null
        }

        if (
          message.includes('getActivePinia()') ||
          message.includes('useLocalStorage is not defined')
        ) {
          return null
        }

        // Local-dev noise when SENTRY_ENABLED=true (COACH-WATTS-1EP / 1EV / 1ET).
        if (combinedMessage.includes('IPC connection closed')) {
          return null
        }

        if (isDevelopment) {
          if (
            requestUrl.includes('/api/runs') &&
            (combinedMessage.includes('Bad Gateway') ||
              combinedMessage.includes('ECONNREFUSED') ||
              combinedMessage.includes('fetch failed'))
          ) {
            return null
          }

          if (
            requestUrl.includes('/api/chat/messages') &&
            (message === 'terminated' || combinedMessage.includes('other side closed'))
          ) {
            return null
          }
        }
      }

      return scrubSentryData(event)
    }
  })
}
