import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import * as runUtils from '../../../../app/utils/user-runs-client'

class FakeSocket {
  static OPEN = 1
  static peers: FakeSocket[] = []
  readyState = 0
  onopen?: () => Promise<void>
  onclose?: () => void
  onmessage?: (event: { data: string }) => void
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = 3
  })
  constructor(_url: string) {
    FakeSocket.peers.push(this)
  }
  async open() {
    this.readyState = 1
    await this.onopen?.()
  }
  closed() {
    this.readyState = 3
    this.onclose?.()
  }
}

const flush = async () => {
  await vue.nextTick()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useUserRuns socket ownership', () => {
  let session: vue.Ref<{ user: { id: string } } | null>
  let scope: vue.EffectScope
  let fetch: ReturnType<typeof vi.fn>
  let api: ReturnType<typeof load>
  function load() {
    // Execute the production module with Nuxt's client flag and auto-imports supplied.
    // Each load has fresh singleton state; Vue scopes and watchers remain real.
    const source = readFileSync('app/composables/useUserRuns.ts', 'utf8').replace(
      /import\.meta\.client/g,
      'true'
    )
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const exports: Record<string, any> = {}
    new Function('require', 'exports', code)(
      (id: string) => (id === 'vue' ? vue : runUtils),
      exports
    )
    return exports as {
      useUserRuns: () => { isConnected: vue.Ref<boolean>; runs: vue.Ref<unknown[]> }
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.peers = []
    session = vue.ref({ user: { id: 'A' } })
    fetch = vi.fn(async (url: string) => (url === '/api/websocket-token' ? { token: 'token' } : []))
    vi.stubGlobal('useAuth', () => ({ data: session }))
    vi.stubGlobal('$fetch', fetch)
    vi.stubGlobal('window', { location: { protocol: 'https:', host: 'example.test' } })
    vi.stubGlobal('WebSocket', FakeSocket)
    api = load()
    scope = vue.effectScope()
  })
  afterEach(() => {
    scope?.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps B tracked and pinging after delayed A close/open/message callbacks', async () => {
    const state = scope.run(() => api.useUserRuns())!
    await flush()
    const a = FakeSocket.peers[0]!
    await a.open()
    session.value = { user: { id: 'B' } }
    await flush()
    const b = FakeSocket.peers[1]!
    await b.open()
    a.closed()
    await a.onopen?.()
    a.onmessage?.({
      data: JSON.stringify({ type: 'run_update', runId: 'stale', status: 'EXECUTING' })
    })
    expect(state.isConnected.value).toBe(true)
    expect(state.runs.value).toEqual([])
    await vi.advanceTimersByTimeAsync(30000)
    expect(b.send).toHaveBeenCalledWith('ping')
    expect(FakeSocket.peers).toHaveLength(2)
    scope.stop()
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).toHaveBeenCalledTimes(1)
    b.closed()
    await vi.advanceTimersByTimeAsync(30000)
    expect(vi.getTimerCount()).toBe(0)
    expect(FakeSocket.peers).toHaveLength(2)
  })

  it('reconnects normally but cancels a pending retry on final disposal', async () => {
    scope.run(() => api.useUserRuns())
    await flush()
    const a = FakeSocket.peers[0]!
    await a.open()
    a.closed()
    await vi.advanceTimersByTimeAsync(3000)
    expect(FakeSocket.peers).toHaveLength(2)
    const b = FakeSocket.peers[1]!
    await b.open()
    b.closed()
    scope.stop()
    await vi.advanceTimersByTimeAsync(30000)
    expect(FakeSocket.peers).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the old retry when identity changes and closes the replacement on logout', async () => {
    scope.run(() => api.useUserRuns())
    await flush()
    FakeSocket.peers[0]!.closed()
    session.value = { user: { id: 'B' } }
    await flush()
    expect(FakeSocket.peers).toHaveLength(2)
    session.value = null
    await flush()
    FakeSocket.peers[1]!.closed()
    await vi.advanceTimersByTimeAsync(30000)
    expect(FakeSocket.peers).toHaveLength(2)
    expect(FakeSocket.peers[1]!.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not authenticate B with a delayed token requested by A', async () => {
    let resolve!: (value: { token: string }) => void
    fetch.mockImplementation((url: string) =>
      url === '/api/websocket-token'
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve([])
    )
    scope.run(() => api.useUserRuns())
    await flush()
    const a = FakeSocket.peers[0]!
    const opening = a.open()
    session.value = { user: { id: 'B' } }
    await flush()
    resolve({ token: 'old-token' })
    await opening
    expect(a.send).not.toHaveBeenCalled()
    expect(FakeSocket.peers[1]!.send).not.toHaveBeenCalled()
  })

  it('does not reopen after disposal while initialization is awaiting fetch', async () => {
    let resolve!: (value: never[]) => void
    fetch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    scope.run(() => api.useUserRuns())
    scope.stop()
    resolve([])
    await flush()
    expect(FakeSocket.peers).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
