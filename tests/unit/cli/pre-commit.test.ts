import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression test for CW-758: the pre-commit hook must never use the
 * repository-global git stash (which is shared across worktrees), while
 * keeping the lint-staged checks and preserving staged/unstaged content on
 * both success and failure.
 *
 * These tests build an isolated temporary git repository, install the REAL
 * `.husky/pre-commit` hook into it, and run REAL `git commit` invocations
 * (exercising the actual lint-staged workflow, not just config text). A `git`
 * shim on PATH records every `git stash` invocation so even transient backup
 * stashes are detected, and the stash list is compared before/after.
 */

const REPO_ROOT = resolve(__dirname, '../../..')
const HOOK_SOURCE = join(REPO_ROOT, '.husky/pre-commit')
const REAL_NODE_MODULES = join(REPO_ROOT, 'node_modules')

const HOOK_TIMEOUT_MS = 120_000

interface TempRepo {
  dir: string
  env: NodeJS.ProcessEnv
  stashLog: string
}

function repoEnv(dir: string, stashLog: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = 'pre-commit-test'
  env.GIT_AUTHOR_EMAIL = 'pre-commit-test@example.com'
  env.GIT_COMMITTER_NAME = 'pre-commit-test'
  env.GIT_COMMITTER_EMAIL = 'pre-commit-test@example.com'
  // The shim dir must come first so every `git` (hook and lint-staged)
  // goes through the stash detector; the real .bin dir keeps
  // `npx lint-staged`, `eslint` and `prettier` resolvable.
  env.PATH = [
    join(dir, 'shimbin'),
    join(REAL_NODE_MODULES, '.bin'),
    dirname(process.execPath),
    process.env.PATH ?? ''
  ].join(':')
  env.GIT_STASH_LOG = stashLog
  return env
}

function git(repo: TempRepo, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo.dir, env: repo.env, encoding: 'utf-8' })
}

function writeFile(repo: TempRepo, name: string, content: string): void {
  writeFileSync(join(repo.dir, name), content)
}

function readWorktree(repo: TempRepo, name: string): string {
  return readFileSync(join(repo.dir, name), 'utf-8')
}

function readCommitted(repo: TempRepo, rev: string, name: string): string {
  return execFileSync('git', ['show', `${rev}:${name}`], {
    cwd: repo.dir,
    env: repo.env,
    encoding: 'utf-8'
  })
}

function indexTree(repo: TempRepo): string {
  return git(repo, 'write-tree').trim()
}

function fullDiffHash(repo: TempRepo): string {
  // SHA-1 of the complete HEAD-to-worktree binary diff: captures index and
  // working-tree bytes exactly (modes, new/deleted files included).
  const diff = execFileSync('git', ['diff', 'HEAD', '--binary', '--full-index'], {
    cwd: repo.dir,
    env: repo.env,
    encoding: null
  }) as unknown as Buffer
  const child = execFileSync('git', ['hash-object', '--stdin'], {
    cwd: repo.dir,
    env: repo.env,
    encoding: null,
    input: diff
  }) as unknown as Buffer
  return Buffer.from(child).toString('utf-8').trim()
}

/** Create an isolated repo wired to the real hook and real tool binaries. */
function createTempRepo(): TempRepo {
  const dir = join(
    tmpdir(),
    `pre-commit-test-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  const stashLog = join(dir, 'stash-invocations.log')
  writeFileSync(stashLog, '')
  const repo: TempRepo = { dir, env: repoEnv(dir, stashLog), stashLog }

  const systemGit = (() => {
    const found = (process.env.PATH ?? '')
      .split(':')
      .map((entry) => join(entry, 'git'))
      .find((candidate) => {
        try {
          return candidate !== join(dir, 'shimbin', 'git') && existsSync(candidate)
        } catch {
          return false
        }
      })
    if (!found) throw new Error('could not locate a system git binary for the test shim')
    return found
  })()

  // Shim every `git` invocation to detect `git stash` usage (including
  // transient backup stashes that are created and dropped within one run).
  mkdirSync(join(dir, 'shimbin'), { recursive: true })
  writeFileSync(
    join(dir, 'shimbin', 'git'),
    `#!/bin/sh\nif [ "$1" = "stash" ]; then\n  echo "stash $@" >> "$GIT_STASH_LOG"\nfi\nexec "${systemGit}" "$@"\n`
  )
  chmodSync(join(dir, 'shimbin', 'git'), 0o755)

  git(repo, 'init', '-b', 'main', '.')
  git(repo, 'config', 'user.email', 'pre-commit-test@example.com')
  git(repo, 'config', 'user.name', 'pre-commit-test')
  git(repo, 'config', 'commit.gpgsign', 'false')

  // Resolve tool binaries from the real repo without network access.
  symlinkSync(REAL_NODE_MODULES, join(dir, 'node_modules'))

  // Mirror the REAL lint-staged patterns/commands so the hook under test runs
  // the same checks as the actual pre-commit workflow.
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    'lint-staged': Record<string, string[]>
  }
  expect(packageJson['lint-staged']).toBeDefined()
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      { name: 'pre-commit-fixture', 'lint-staged': packageJson['lint-staged'] },
      null,
      2
    )
  )
  // Minimal eslint flat config: `prefer-const` is auto-fixable (success path
  // must change the committed content), `no-undef` is not (failure path must
  // leave content untouched). No stylistic rules that would fight prettier.
  writeFileSync(
    join(dir, 'eslint.config.mjs'),
    `export default [{ languageOptions: { globals: { console: "readonly" } }, rules: { "prefer-const": "error", "no-undef": "error" } }]\n`
  )

  // Install the ACTUAL hook.
  copyFileSync(HOOK_SOURCE, join(dir, '.git', 'hooks', 'pre-commit'))
  chmodSync(join(dir, '.git', 'hooks', 'pre-commit'), 0o755)

  return repo
}

function stashList(repo: TempRepo): string {
  return git(repo, 'stash', 'list')
}

function stashInvocations(repo: TempRepo): string {
  return readFileSync(repo.stashLog, 'utf-8')
}

function commit(repo: TempRepo, message: string): { status: number; output: string } {
  try {
    const output = execFileSync('git', ['commit', '-m', message], {
      cwd: repo.dir,
      env: repo.env,
      encoding: 'utf-8'
    })
    return { status: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      status: err.status ?? 1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`
    }
  }
}

describe('pre-commit hook (CW-758)', () => {
  it(
    'commits lint fixes while preserving unrelated and partially-staged changes without touching the stash',
    () => {
      const repo = createTempRepo()

      // Baseline commit (hook installed but nothing staged-matched yet).
      writeFile(repo, 'ok.js', 'const ok = 1\nconsole.log(ok)\n')
      git(repo, 'add', '-A')
      expect(commit(repo, 'baseline').status).toBe(0)

      // Pre-existing stash entry that must survive the hook run untouched.
      writeFile(repo, 'ok.js', 'const ok = 2\nconsole.log(ok)\n')
      git(repo, 'stash', 'push', '-m', 'pre-existing-entry')
      const stashBefore = stashList(repo)
      expect(stashBefore).toContain('pre-existing-entry')
      writeFileSync(repo.stashLog, '')

      // Success scenario: fixable staged file, partially-staged file with an
      // unstaged hunk elsewhere, badly-formatted staged JSON, and unrelated
      // staged + unstaged text changes (a pattern lint-staged ignores).
      writeFile(repo, 'fix.js', 'let z = 1\nconsole.log(z)\n')
      writeFile(repo, 'part.js', 'const y = 1\nconsole.log(y)\n')
      writeFile(repo, 'data.json', '{"b"  :  2}\n')
      writeFile(repo, 'notes.txt', 'staged note\n')
      git(repo, 'add', 'fix.js', 'part.js', 'data.json', 'notes.txt')
      writeFile(repo, 'part.js', 'const y = 1\nconsole.log(y)\n\nconsole.log("unstaged-hunk")\n')
      writeFile(repo, 'notes.txt', 'staged note\nunstaged note\n')

      const result = commit(repo, 'hook success case')
      expect(result.status).toBe(0)

      // No stash operation may have happened, not even transiently ...
      expect(stashInvocations(repo)).toBe('')
      // ... and the final stash state is unchanged.
      expect(stashList(repo)).toBe(stashBefore)

      // Intended fixes landed in the commit ...
      expect(readCommitted(repo, 'HEAD', 'fix.js')).toBe('const z = 1;\nconsole.log(z);\n')
      expect(readCommitted(repo, 'HEAD', 'data.json')).toBe('{ "b": 2 }\n')
      // ... while the commit contains only the staged side of partially
      // staged / unrelated files ...
      expect(readCommitted(repo, 'HEAD', 'part.js')).toBe('const y = 1;\nconsole.log(y);\n')
      expect(readCommitted(repo, 'HEAD', 'notes.txt')).toBe('staged note\n')
      // ... and the unstaged edits remain intact in the working tree.
      expect(readWorktree(repo, 'part.js')).toBe(
        'const y = 1;\nconsole.log(y);\n\nconsole.log("unstaged-hunk")\n'
      )
      expect(readWorktree(repo, 'notes.txt')).toBe('staged note\nunstaged note\n')

      // No leftover lint-staged state inside the repo.
      expect(existsSync(join(repo.dir, '.git', 'lint-staged_unstaged.patch'))).toBe(false)
    },
    HOOK_TIMEOUT_MS
  )

  it(
    'blocks the commit and preserves the exact staged/unstaged state when checks fail, without touching the stash',
    () => {
      const repo = createTempRepo()

      writeFile(repo, 'ok.js', 'const ok = 1\nconsole.log(ok)\n')
      git(repo, 'add', '-A')
      expect(commit(repo, 'baseline').status).toBe(0)

      writeFile(repo, 'ok.js', 'const ok = 2\nconsole.log(ok)\n')
      git(repo, 'stash', 'push', '-m', 'pre-existing-entry')
      const stashBefore = stashList(repo)
      expect(stashBefore).toContain('pre-existing-entry')
      writeFileSync(repo.stashLog, '')

      // Failing scenario: `bad.js` has an unfixable error plus a fixable
      // style issue (exercises the restore path for partial --fix output),
      // alongside partially-staged and unrelated files.
      writeFile(repo, 'bad.js', 'let   q   =   undeclaredVar\nconsole.log(q)\n')
      writeFile(repo, 'part.js', 'const y = 1\nconsole.log(y)\n')
      writeFile(repo, 'notes.txt', 'staged note\n')
      git(repo, 'add', 'bad.js', 'part.js', 'notes.txt')
      writeFile(repo, 'part.js', 'const y = 1\nconsole.log(y)\n\nconsole.log("unstaged-hunk")\n')
      writeFile(repo, 'notes.txt', 'staged note\nunstaged note\n')

      const headBefore = git(repo, 'rev-parse', 'HEAD').trim()
      const indexBefore = indexTree(repo)
      const diffBefore = fullDiffHash(repo)

      const result = commit(repo, 'hook failure case')
      expect(result.status).not.toBe(0)

      // No commit was created ...
      expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
      // ... the index (staged content, incl. the un-fixed bad.js) is
      // byte-identical ...
      expect(indexTree(repo)).toBe(indexBefore)
      // ... the working tree (incl. partially-staged hunks) is byte-identical ...
      expect(fullDiffHash(repo)).toBe(diffBefore)
      // ... and the stash was never touched.
      expect(stashInvocations(repo)).toBe('')
      expect(stashList(repo)).toBe(stashBefore)
    },
    HOOK_TIMEOUT_MS
  )

  it('never invokes the repository-global stash backup in its own workflow', () => {
    // The behavioral tests above prove no stash is used at runtime; this pins
    // the hook source so a future edit cannot reintroduce one (comments
    // explaining the stash problem are fine, invocations are not).
    const hook = readFileSync(HOOK_SOURCE, 'utf-8')
    const invocations = hook
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .filter((line) => /(^|[;|&]\s*|^\s*)git\s+stash\b/.test(line))
    expect(invocations).toEqual([])
  })
})
