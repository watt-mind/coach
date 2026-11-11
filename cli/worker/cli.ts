import 'dotenv/config'
import { Command } from 'commander'
import { ensureNodeEnv } from './node-env'

// Runs before the dynamic command imports below. `./start` pulls in
// server/utils/realtime-bus, which reads NODE_ENV once at module load to build
// its channel name — so the guard must win that race (CW-611, CW-660). It stays
// a static import: this module has no imports of its own, so nothing pulls
// realtime-bus in ahead of it (CW-660 made the four command modules dynamic).
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
