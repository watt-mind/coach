/**
 * Static guard for `trigger/` — the only automated coverage those files have.
 *
 * WHY THIS EXISTS
 * ---------------
 * `trigger/` is outside every tsconfig project (CW-560), so `pnpm typecheck` does not see it.
 * These are Trigger.dev tasks that run against production data, so this test is the sole gate
 * standing between a broken module and production.
 *
 * WHAT IT GUARANTEES (and why a bare `await import()` is not enough)
 * -----------------------------------------------------------------
 * The previous version of this test imported a hardcoded list of modules and asserted only that
 * the import did not throw. That caught a bad *module specifier* but not a bad *export name*:
 * esbuild lowers `import { Foo } from 'bar'` to a namespace property access, so a typo'd export
 * name binds `undefined` and throws only at call time — in production, on whichever branch first
 * touches it (CW-512: `AbortTaskRunError`, reached only by a user with no Garmin integration).
 *
 * So this file asserts three things per module, and derives everything from disk and from the
 * source itself — there is no hand-maintained list to forget to update (CW-605):
 *
 *   1. MODULE RESOLVES     — the module imports without throwing. Catches bad module specifiers
 *                            and import-time crashes.
 *   2. BINDINGS EXIST      — every value-level named import (and named re-export) in the source
 *                            actually exists on the module it is imported from. Catches the
 *                            typo'd export name that check 1 is blind to. Type-only imports are
 *                            skipped: they are erased at runtime and have nothing to check.
 *   3. TASKS ARE EXPORTED  — every `task({ id: '...' })` declared in the source is reachable as a
 *                            runtime export. A task that is defined but not exported never
 *                            registers with Trigger.dev. Because that expectation is source-derived
 *                            and non-empty, it also keeps the *runtime-export detector* honest.
 *                            It says nothing about check 2, though: `readNamedBindings` and
 *                            `readDeclaredTaskIds` are independent parsers, so a regression in the
 *                            former is completely invisible here.
 *
 * The source parsers themselves are guarded by the discovery tripwire ('discovery itself found
 * something to check'), which asserts all three discovery outputs are non-trivial. Every per-module
 * check iterates over data produced at collection time, so a parser that silently returned nothing
 * would leave all 75 module tests green while asserting nothing — the exact failure this file
 * exists to eliminate, reproduced one level up. The tripwire is what makes that impossible.
 *
 * MAINTENANCE
 * -----------
 * Nothing here needs updating when a task is added, renamed or deleted. If CW-560 lands and
 * `trigger/` is genuinely typechecked, checks 1 and 2 become redundant and this file can be
 * reduced to check 3 (or deleted); until then it is the only thing covering these files.
 */
import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '../../..')
const triggerDir = path.join(repoRoot, 'trigger')

interface NamedBindingUse {
  /** Module specifier exactly as written in the source. */
  specifier: string
  /** Names expected to exist on that module (the *exported* name, not the local alias). */
  names: string[]
}

interface TriggerModule {
  /** Repo-relative path, used as the test name so a failure names the module. */
  rel: string
  /** Absolute path, used for the dynamic import. */
  abs: string
  namedBindings: NamedBindingUse[]
  /** Task ids declared in the source, e.g. `task({ id: 'garmin-backfill' })`. */
  declaredTaskIds: string[]
}

/** Every real module under `trigger/`, found on disk rather than listed by hand. */
function collectModuleFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectModuleFiles(abs))
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      found.push(abs)
    }
  }
  return found
}

/**
 * Value-level named imports/re-exports in a source file.
 *
 * Type-only forms are dropped — both `import type { A } from 'x'` and the inline
 * `import { type A, b } from 'x'` — because they are erased before the module ever runs.
 */
function readNamedBindings(source: ts.SourceFile): NamedBindingUse[] {
  const uses: NamedBindingUse[] = []

  for (const statement of source.statements) {
    let clause: ts.NamedImports | ts.NamedExports | undefined
    let moduleSpecifier: ts.Expression | undefined

    if (ts.isImportDeclaration(statement)) {
      const importClause = statement.importClause
      if (!importClause || importClause.isTypeOnly) continue
      const bindings = importClause.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      clause = bindings
      moduleSpecifier = statement.moduleSpecifier
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.moduleSpecifier) continue
      const exportClause = statement.exportClause
      if (!exportClause || !ts.isNamedExports(exportClause)) continue
      clause = exportClause
      moduleSpecifier = statement.moduleSpecifier
    } else {
      continue
    }

    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue

    // `propertyName` is set only when the binding is aliased (`import { a as b }`), and it holds
    // the name on the *source* module — which is the one that has to exist.
    const names = clause.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => (element.propertyName ?? element.name).text)

    if (names.length > 0) uses.push({ specifier: moduleSpecifier.text, names })
  }

  return uses
}

/** Task ids declared in the source: any `…task({ id: '<literal>' })` call. */
function readDeclaredTaskIds(source: ts.SourceFile): string[] {
  const ids: string[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const calleeName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : ''

      if (/task$/i.test(calleeName)) {
        const [config] = node.arguments
        if (config && ts.isObjectLiteralExpression(config)) {
          for (const property of config.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === 'id' &&
              ts.isStringLiteral(property.initializer)
            ) {
              ids.push(property.initializer.text)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return ids
}

const modules: TriggerModule[] = collectModuleFiles(triggerDir)
  .sort()
  .map((abs) => {
    const source = ts.createSourceFile(
      abs,
      readFileSync(abs, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    return {
      rel: path.relative(repoRoot, abs),
      abs,
      namedBindings: readNamedBindings(source),
      declaredTaskIds: readDeclaredTaskIds(source)
    }
  })

/**
 * Load a module namespace once and reuse it. Everything here is already in the module graph by
 * the time we look at it (the trigger module that imports it has been loaded), so this is a cache
 * hit rather than a second evaluation.
 */
const namespaces = new Map<string, Promise<Record<string, unknown>>>()

function loadNamespace(id: string): Promise<Record<string, unknown>> {
  let pending = namespaces.get(id)
  if (!pending) {
    pending = import(/* @vite-ignore */ id) as Promise<Record<string, unknown>>
    namespaces.set(id, pending)
  }
  return pending
}

/** Relative specifiers must be resolved against the importing file, not against this test. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  return specifier.startsWith('.') ? path.resolve(path.dirname(fromFile), specifier) : specifier
}

function describeAvailable(name: string, available: string[]): string {
  const lowered = name.toLowerCase()
  const near = available.filter(
    (candidate) =>
      candidate.toLowerCase().includes(lowered) || lowered.includes(candidate.toLowerCase())
  )
  if (near.length > 0) return `did you mean ${near.map((n) => `'${n}'`).join(', ')}?`
  const shown = [...available].sort().slice(0, 12)
  const suffix =
    available.length > shown.length ? `, …+${available.length - shown.length} more` : ''
  return `exports: ${shown.map((n) => `'${n}'`).join(', ')}${suffix}`
}

describe('trigger/ module guard', () => {
  test('discovery itself found something to check', () => {
    // Tripwire over all three discovery outputs — the file list AND both source parsers. Every
    // per-module check below iterates over data produced at collection time, so a detector that
    // silently returned nothing (a TypeScript API change, or a future "simplification" of the
    // isTypeOnly filters) would leave all 75 module tests green while asserting nothing at all.
    //
    // Thresholds sit well below the current actuals — 75 modules, 913 named bindings, 66 task ids
    // — so ordinary churn never trips them, but a collapsed detector does.
    expect(modules.length).toBeGreaterThan(50)
    expect(modules.map((m) => m.rel)).toContain('trigger/garmin-backfill.ts')

    const namedBindingCount = modules.reduce(
      (total, module) =>
        total + module.namedBindings.reduce((count, use) => count + use.names.length, 0),
      0
    )
    expect(namedBindingCount).toBeGreaterThan(500)

    const declaredTaskIdCount = modules.reduce(
      (total, module) => total + module.declaredTaskIds.length,
      0
    )
    expect(declaredTaskIdCount).toBeGreaterThan(40)
  })

  test.each(modules.map((module) => [module.rel, module] as const))(
    '%s imports cleanly, and every imported binding and declared task exists',
    async (rel, module) => {
      // 1. MODULE RESOLVES — a bad module specifier or an import-time crash fails here.
      const namespace = (await import(/* @vite-ignore */ module.abs)) as Record<string, unknown>

      // 2. BINDINGS EXIST — the check a bare import cannot make.
      const missing: string[] = []
      for (const use of module.namedBindings) {
        const id = resolveSpecifier(module.abs, use.specifier)
        let target: Record<string, unknown>
        try {
          target = await loadNamespace(id)
        } catch (error) {
          missing.push(
            `  from '${use.specifier}' — module failed to load: ${(error as Error).message}`
          )
          continue
        }
        const available = Object.keys(target)
        for (const name of use.names) {
          if (!(name in target)) {
            missing.push(
              `  { ${name} } from '${use.specifier}' — ${describeAvailable(name, available)}`
            )
          }
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `${rel} imports ${missing.length} binding(s) that do not exist.\n` +
            `These bind to undefined at runtime and throw only when the code path is reached:\n` +
            missing.join('\n')
        )
      }

      // 3. TASKS ARE EXPORTED — a task defined but not exported never registers with Trigger.dev.
      const exportedTaskIds = Object.values(namespace)
        .map((value) => (value as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string')
      const unexported = module.declaredTaskIds.filter((id) => !exportedTaskIds.includes(id))
      if (unexported.length > 0) {
        throw new Error(
          `${rel} declares task id(s) ${unexported.map((id) => `'${id}'`).join(', ')} ` +
            `but does not export them (exported task ids: ` +
            `${exportedTaskIds.map((id) => `'${id}'`).join(', ') || 'none'}).`
        )
      }
    },
    30000
  )

  test('task ids are unique across trigger/', () => {
    const seen = new Map<string, string[]>()
    for (const module of modules) {
      for (const id of module.declaredTaskIds) {
        seen.set(id, [...(seen.get(id) ?? []), module.rel])
      }
    }
    const duplicates = [...seen.entries()].filter(([, files]) => files.length > 1)
    expect(duplicates.map(([id, files]) => `'${id}' declared in ${files.join(' and ')}`)).toEqual(
      []
    )
  })
})
