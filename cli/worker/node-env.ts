/**
 * Guarantee the worker agrees with the web server about NODE_ENV (CW-611).
 *
 * `realtime-bus.ts` / `chat-realtime-bus.ts` only namespace their Redis pub/sub
 * channels per instance when `NODE_ENV === 'development'` (CW-516). A worker started
 * with NODE_ENV unset therefore publishes to the unnamespaced `app:realtime` while the
 * dev server publishes and subscribes on `app:realtime:dev-db<n>-p<port>` — and the
 * events are dropped **silently, with no log**: the feature simply looks broken.
 *
 * Fixing that per launcher does not hold: every invocation funnels through
 * `cli/worker/cli.ts` (`pnpm dev:worker`, `pnpm cw:worker`, `cli/worker/run.sh`,
 * the e2e compose service, `e2e/scripts/run-app-host.ts`), and only some of them set
 * NODE_ENV. Defaulting it here closes the gap for every current and future entrypoint.
 *
 * 'development' is the right default because it is what the worker already assumes
 * elsewhere (`start.ts` reports `process.env.NODE_ENV || 'development'`), and because
 * the deployed worker always has NODE_ENV set explicitly (`Dockerfile` sets
 * `NODE_ENV=production`, `docker-compose.e2e.yml` sets it on the worker service).
 * An explicit value — including `production` — is never overridden.
 *
 * This module intentionally has no imports: `cli.ts` imports it statically at the
 * top, and any import here that transitively pulled in `server/utils/realtime-bus`
 * (which reads NODE_ENV once at module load) would run before the guard.
 */
export function ensureNodeEnv(): void {
  if (process.env.NODE_ENV?.trim()) return

  process.env.NODE_ENV = 'development'
  console.warn(
    "[cw:worker] NODE_ENV was not set — defaulting to 'development' so realtime/chat " +
      'pub-sub channels resolve the same namespace as the dev server. Set NODE_ENV ' +
      'explicitly (or REALTIME_CHANNEL_NAMESPACE) if that is not what you want.'
  )
}
