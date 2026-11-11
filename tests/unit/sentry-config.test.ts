import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { NodeClient, defaultStackParser } from '@sentry/node'

describe.each(['server', 'client'])('Sentry %s config', (side) => {
  it('scrubs error and full transaction envelopes, including encoded and duplicate keys', async () => {
    const init = vi.fn()
    const source = readFileSync(new URL(`../../sentry.${side}.config.ts`, import.meta.url), 'utf8')
    // Evaluate the actual entry point without Nuxt's auto-import transform or a running app.
    runInNewContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS }), {
      exports: {},
      require: () => ({
        init,
        replayIntegration: () => ({}),
        consoleLoggingIntegration: () => ({})
      }),
      process: { env: { NODE_ENV: 'production' } },
      useRuntimeConfig: () => ({
        public: { sentryEnabled: true, sentryDsn: 'https://public@example.test/1' }
      })
    })
    const options = init.mock.calls[0]![0]
    expect(options.sendDefaultPii).toBe(false)
    const envelopes: unknown[] = []
    const client = new NodeClient({
      ...options,
      integrations: [],
      stackParser: defaultStackParser,
      transport: () => ({
        send: async (envelope: unknown) => {
          envelopes.push(envelope)
          return { statusCode: 200 }
        },
        flush: async () => true
      })
    })
    client.init()
    const query =
      '%63ode=UNSPENT&code=DUPLICATE&st%61te=SECRET&ACCESS_TOKEN=ACCESS&refresh_token=REFRESH&id_token=ID&client_secret=CLIENT&keep=visible&bad%ZZ=safe'
    const url = `https://app.test/api/integrations/new-provider/callback?${query}#fragment`
    const expected = url.replace(
      /UNSPENT|DUPLICATE|SECRET|ACCESS(?=&)|REFRESH|ID(?=&)|CLIENT/g,
      '[Filtered]'
    )
    for (const type of [undefined, 'transaction'] as const) {
      client.captureEvent({
        ...(type
          ? { type, start_timestamp: 1, timestamp: 2 }
          : { message: 'Token exchange failed' }),
        transaction: url,
        request: { url, query_string: query },
        extra: { callback: url, state: 'OBJECT_SECRET' },
        breadcrumbs: [{ category: 'http', data: { url } }],
        ...(type
          ? {
              spans: [
                {
                  span_id: '1234567890abcdef',
                  trace_id: 'a'.repeat(32),
                  start_timestamp: 1,
                  timestamp: 2,
                  description: url,
                  data: { url }
                }
              ]
            }
          : {})
      })
    }
    await client.flush(2000)
    expect(envelopes).toHaveLength(2)
    for (const envelope of envelopes) {
      const event = (envelope as [unknown, [unknown, Record<string, any>][]])[1][0]![1]
      expect(event.request.url).toBe(expected)
      expect(event.request.query_string).toBe(expected.split('?')[1]!.split('#')[0])
      expect(event.transaction).toBe(expected)
      expect(event.extra).toEqual({ callback: expected, state: '[Filtered]' })
      expect(event.breadcrumbs[0].data.url).toBe(expected)
      if (event.type === 'transaction') {
        expect(event.spans[0].description).toBe(expected)
        expect(event.spans[0].data.url).toBe(expected)
      }
      expect(JSON.stringify(envelope)).not.toMatch(/UNSPENT|DUPLICATE|SECRET|OBJECT_SECRET/)
    }
    expect(options.beforeBreadcrumb({ data: { url } }).data.url).toBe(expected)
    await client.close()
  })
})
