import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
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

    it('executes the CLI and observes the environment when command modules load', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cw660-cli-order-'))
      const commands = ['start', 'ping', 'status', 'clean']
      try {
        await writeFile(join(dir, 'dotenv.mjs'), '')
        await writeFile(
          join(dir, 'commander.mjs'),
          `export class Command {
            name() { return this }
            description() { return this }
            version() { return this }
            addCommand() { return this }
            parse() { console.log(JSON.stringify(globalThis.commandLoads)) }
          }`
        )
        await writeFile(
          join(dir, 'node-env.mjs'),
          ts.transpileModule(readNodeEnvSource(), {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
          }).outputText
        )
        for (const command of commands) {
          await writeFile(
            join(dir, `${command}.mjs`),
            `globalThis.commandLoads ??= [];
             globalThis.commandLoads.push([${JSON.stringify(command)}, process.env.NODE_ENV]);
             export const ${command}Command = {};`
          )
        }
        const source = readCliSource()
          .replace(/(['"])dotenv\/config\1/g, "'./dotenv.mjs'")
          .replace(/(['"])commander\1/g, "'./commander.mjs'")
          .replace(/(['"])\.\/(node-env|start|ping|status|clean)\1/g, "'./$2.mjs'")
        const run = async (cli: string) => {
          await writeFile(join(dir, 'cli.mjs'), cli)
          const env = { ...process.env }
          delete env.NODE_ENV
          return JSON.parse(
            execFileSync(process.execPath, [join(dir, 'cli.mjs'), 'status'], {
              env,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe']
            }).trim()
          )
        }
        const expected = commands.map((command) => [command, 'development'])
        expect(await run(source)).toEqual(expected)

        // Behavioral negative controls execute the same entrypoint with only
        // the ordering defect introduced; no source-position assertion is used.
        const lateGuard = source
          .replace(/^ensureNodeEnv\(\)\s*$/m, '')
          .replace('const program =', 'ensureNodeEnv()\nconst program =')
        expect(await run(lateGuard)).not.toEqual(expected)
        const staticCommand = source.replace(
          "const { startCommand } = await import('./start.mjs')",
          "import { startCommand } from './start.mjs'"
        )
        expect(await run(staticCommand)).not.toEqual(expected)
        expect(await run("import './start.mjs'\n" + source)).not.toEqual(expected)
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
