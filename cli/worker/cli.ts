import 'dotenv/config'
import { Command } from 'commander'

/**
 * Guarantee the worker agrees with the web server about NODE_ENV (CW-611).
 *
 * `realtime-bus.ts` / `chat-realtime-bus.ts` only namespace their Redis pub/sub
 * channels per instance when `NODE_ENV === 'development'` (CW-516). A worker started
 * with NODE_ENV unset therefore publishes to the unnamespaced `app:realtime` while the
 * dev server publishes and subscribes on `app:realtime:dev-db<n>-p<port>` — and the
 * events are dropped **silently, with no log**: the feature simply looks broken.
 *
 * Fixing that per launcher does not hold: every invocation funnels through this file
 * (`pnpm dev:worker`, `pnpm cw:worker`, `cli/worker/run.sh`, the e2e compose service,
 * `e2e/scripts/run-app-host.ts`), and only some of them set NODE_ENV. Defaulting it
 * here closes the gap for every current and future entrypoint.
 *
 * 'development' is the right default because it is what the worker already assumes
 * elsewhere (`start.ts` reports `process.env.NODE_ENV || 'development'`), and because
 * the deployed worker always has NODE_ENV set explicitly (`Dockerfile` sets
 * `NODE_ENV=production`, `docker-compose.e2e.yml` sets it on the worker service).
 * An explicit value — including `production` — is never overridden.
 */
function ensureNodeEnv(): void {
  if (process.env.NODE_ENV?.trim()) return

  process.env.NODE_ENV = 'development'
  console.warn(
    "[cw:worker] NODE_ENV was not set — defaulting to 'development' so realtime/chat " +
      'pub-sub channels resolve the same namespace as the dev server. Set NODE_ENV ' +
      'explicitly (or REALTIME_CHANNEL_NAMESPACE) if that is not what you want.'
  )
}

ensureNodeEnv()

// Imported after the guard on purpose: `./start` pulls in server/utils/realtime-bus,
// which reads NODE_ENV once at module load to build its channel name. Static imports
// are evaluated before any statement in this file, so they would see the pre-guard env.
const { startCommand } = await import('./start')
const { pingCommand } = await import('./ping')
const { statusCommand } = await import('./status')
const { cleanCommand } = await import('./clean')

const program = new Command()

program.name('cw:worker').description('Coach Watts Webhook Worker CLI').version('1.0.0')

program.addCommand(startCommand)
program.addCommand(pingCommand)
program.addCommand(statusCommand)
program.addCommand(cleanCommand)

// Default to 'start' if no subcommand is provided (backward compatibility)
if (process.argv.length === 2) {
  process.argv.push('start')
}

program.parse(process.argv)
