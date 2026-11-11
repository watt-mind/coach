import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureNodeEnv } from '../../../cli/worker/node-env'

const WARNING_FRAGMENT = '[cw:worker] NODE_ENV was not set'

function readCliSource(): string {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '../../../cli/worker/cli.ts')
  return readFileSync(cliPath, 'utf8')
}

function readNodeEnvSource(): string {
  const modPath = join(dirname(fileURLToPath(import.meta.url)), '../../../cli/worker/node-env.ts')
  return readFileSync(modPath, 'utf8')
}

describe('worker node-env guard', () => {
  const hadNodeEnv = Object.hasOwn(process.env, 'NODE_ENV')
  const originalNodeEnv = process.env.NODE_ENV
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    warn.mockRestore()
    vi.unstubAllEnvs()
    if (hadNodeEnv) {
      process.env.NODE_ENV = originalNodeEnv as string
    } else {
      delete process.env.NODE_ENV
    }
  })

  it('is reachable without executing the CLI (no parse / Command side effects)', async () => {
    // Importing the CLI entrypoint would run program.parse(process.argv) and
    // start the worker. The extracted helper must carry no such side effect.
    expect(typeof ensureNodeEnv).toBe('function')

    const src = readNodeEnvSource()
    expect(src).not.toMatch(/program\.parse/)
    expect(src).not.toMatch(/new Command/)
    expect(src).not.toMatch(/process\.argv/)
    expect(src).not.toMatch(/await import\(/)

    const mod = await import('../../../cli/worker/node-env')
    expect(typeof mod.ensureNodeEnv).toBe('function')
  })

  it.each([['unset'], ['empty'], ['whitespace-only']])(
    'defaults %s NODE_ENV to development with the existing warning',
    (kind) => {
      if (kind === 'unset') delete process.env.NODE_ENV
      if (kind === 'empty') process.env.NODE_ENV = ''
      if (kind === 'whitespace-only') process.env.NODE_ENV = '   \t\n '

      ensureNodeEnv()

      expect(process.env.NODE_ENV).toBe('development')
      expect(warn).toHaveBeenCalledTimes(1)
      const message = String(warn.mock.calls[0]?.[0])
      expect(message).toContain(WARNING_FRAGMENT)
      expect(message).toContain("'development'")
      expect(message).toContain('REALTIME_CHANNEL_NAMESPACE')
    }
  )

  it.each([['production'], ['development'], ['test'], ['staging']])(
    'preserves explicit NODE_ENV=%s without warning',
    (value) => {
      process.env.NODE_ENV = value

      ensureNodeEnv()

      expect(process.env.NODE_ENV).toBe(value)
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('preserves padded-but-nonblank values verbatim without warning', () => {
    process.env.NODE_ENV = ' production '

    ensureNodeEnv()

    expect(process.env.NODE_ENV).toBe(' production ')
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps cli.ts behaviour — same warning source, same subcommands', () => {
    const cliSrc = readCliSource()

    // Warning lives in the extracted module now, with identical text.
    expect(readNodeEnvSource()).toContain(WARNING_FRAGMENT)
    expect(cliSrc).not.toMatch(/function\s+ensureNodeEnv/)

    // CLI wiring is untouched.
    expect(cliSrc).toContain("program.name('cw:worker')")
    expect(cliSrc).toContain('addCommand(startCommand)')
    expect(cliSrc).toContain('addCommand(pingCommand)')
    expect(cliSrc).toContain('addCommand(statusCommand)')
    expect(cliSrc).toContain('addCommand(cleanCommand)')
    expect(cliSrc).toContain('program.parse(process.argv)')
    expect(cliSrc).toContain('process.argv.push(')
  })

  describe('ordering: guard must run before anything importing realtime-bus', () => {
    it('statically imports the guard and calls it before the dynamic command imports', () => {
      const src = readCliSource()

      // The guard is a static import — safe because node-env.ts itself pulls
      // in nothing that could load realtime-bus ahead of it.
      expect(src).toMatch(/import\s*\{\s*ensureNodeEnv\s*\}\s*from\s*['"]\.\/node-env['"]/)
      expect(src).not.toMatch(/await import\(['"]\.\/node-env['"]\)/)

      // Command modules stay dynamic: a static `import './start'` would
      // evaluate realtime-bus (via task-run-events → ws-state) before any
      // statement in this file, including the guard.
      for (const mod of ['start', 'ping', 'status', 'clean']) {
        expect(src).not.toMatch(new RegExp(`^\\s*import\\s[^;]*from\\s*['"]\\.\\/${mod}['"]`, 'm'))
        expect(src).toContain(`await import('./${mod}')`)
      }
      expect(src).not.toMatch(/^\s*import\s[^\n;]*realtime-bus/m)

      // node-env.ts itself must stay side-effect free of realtime-bus.
      // (Doc comments may name the module; only an actual import races.)
      const helperSrc = readNodeEnvSource()
      expect(helperSrc).not.toMatch(/^\s*import\s[^\n;]*realtime-bus/m)
      expect(helperSrc).not.toMatch(/from\s*['"][^'"]*realtime-bus/m)
      expect(helperSrc).not.toMatch(/await import\([^)]*realtime-bus/)
      expect(helperSrc).not.toMatch(/require\([^)]*realtime-bus/)
      expect(helperSrc).not.toMatch(/from\s*['"]\.\/start['"]/)

      // The call wins the race: moving it below the dynamic imports (or
      // converting a command import back to a static import, which hoists
      // above it) must break this test.
      const guardCall = src.indexOf('ensureNodeEnv()')
      expect(guardCall).toBeGreaterThan(-1)
      const firstDynamicImport = src.indexOf('await import(')
      expect(firstDynamicImport).toBeGreaterThan(-1)
      expect(guardCall).toBeLessThan(firstDynamicImport)
    })

    it('behaves like realtime-bus: a module-load read before the guard sees the wrong env', async () => {
      // realtime-bus.ts computes CHANNEL_NAMESPACE once at module load
      // (realtime-bus.ts:52). This probe mimics that shape: whatever
      // NODE_ENV is at import time is baked in.
      const dir = await mkdtemp(join(tmpdir(), 'cw660-node-env-'))
      try {
        const probe = join(dir, 'probe.mjs')
        await writeFile(
          probe,
          'export const seenAtLoad = process.env.NODE_ENV\n' +
            "export const namespaced = process.env.NODE_ENV === 'development'\n"
        )

        // Correct order (what cli.ts does): guard, then load.
        delete process.env.NODE_ENV
        ensureNodeEnv()
        const good = await import(`${pathToFileURL(probe).href}?good=1`)
        expect(good.seenAtLoad).toBe('development')
        expect(good.namespaced).toBe(true)

        // Wrong order (guard moved below the imports): load, then guard.
        // The load already baked in the pre-guard env — too late.
        delete process.env.NODE_ENV
        const bad = await import(`${pathToFileURL(probe).href}?bad=1`)
        expect(bad.seenAtLoad).toBeUndefined()
        expect(bad.namespaced).toBe(false)
        ensureNodeEnv()
        expect(process.env.NODE_ENV).toBe('development')
        // The late guard cannot retroactively fix the earlier load.
        expect(bad.seenAtLoad).toBeUndefined()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('node-env helper source stays import-free so the static import cannot race', async () => {
      const src = await readFile(
        join(dirname(fileURLToPath(import.meta.url)), '../../../cli/worker/node-env.ts'),
        'utf8'
      )
      expect(src).not.toMatch(/^\s*import\s/m)
    })
  })
})
