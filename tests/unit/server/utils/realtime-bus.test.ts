import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  clients: [] as any[],
  connectFails: false,
  subscribeFails: false
}))
vi.mock('ioredis', () => ({
  default: class extends EventEmitter {
    status = 'wait'
    options: any
    connect = vi.fn(async () => {
      if (state.connectFails) throw new Error('offline')
      this.status = 'ready'
    })
    subscribe = vi.fn(async () => {
      if (state.subscribeFails) throw new Error('subscribe failed')
      return 1
    })
    publish = vi.fn(async () => {
      if (this.status !== 'ready') throw new Error('offline')
      return 1
    })
    disconnect = vi.fn(() => {
      this.status = 'end'
    })
    constructor(_url: string, options: any) {
      super()
      this.options = options
      state.clients.push(this)
    }
  }
}))
vi.mock('../../../../server/utils/realtime-logger', () => ({
  logRealtimeEvent: vi.fn(),
  logRealtimeDisabled: vi.fn()
}))
let bus: typeof import('../../../../server/utils/realtime-bus')
const receive = (client: any, channel = 'app:realtime', originInstanceId = 'remote') =>
  client.emit(
    'message',
    channel,
    JSON.stringify({ originInstanceId, userId: 'user', data: { type: 'chat_update' } })
  )

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  state.clients = []
  state.connectFails = false
  state.subscribeFails = false
  vi.stubEnv('REDIS_URL', 'redis://localhost/3')
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('NITRO_BUILD', '')
  vi.stubEnv('REALTIME_CHANNEL_NAMESPACE', '')
  vi.stubEnv('HOSTNAME', 'local')
  bus = await import('../../../../server/utils/realtime-bus')
})
afterEach(async () => {
  await bus.stopRealtimeSubscription()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('realtime Redis lifecycle', () => {
  it('recovers repeated outages with one subscription and listener, preserving routing', async () => {
    const handler = vi.fn()
    await Promise.all([
      bus.startRealtimeSubscription(handler),
      bus.startRealtimeSubscription(handler)
    ])
    for (let i = 0; i < 3; i++) {
      const client = state.clients.at(-1)
      expect(client.subscribe).toHaveBeenCalledTimes(1)
      expect(client.listenerCount('message')).toBe(1)
      receive(client)
      receive(client, 'other')
      receive(client, 'app:realtime', 'local')
      client.emit('message', 'app:realtime', 'invalid')
      expect(handler).toHaveBeenCalledTimes(i + 1)
      expect(handler).toHaveBeenLastCalledWith({ userId: 'user', data: { type: 'chat_update' } })
      client.status = 'end'
      client.emit('end')
      expect(client.eventNames()).toEqual([])
      await vi.advanceTimersByTimeAsync(250)
    }
  })

  it.each(['connect', 'subscribe'])(
    'recovers initial %s failure with capped backoff and no start storms',
    async (failure) => {
      state.connectFails = failure === 'connect'
      state.subscribeFails = failure === 'subscribe'
      const handler = vi.fn()
      await bus.startRealtimeSubscription(handler)
      for (const delay of [250, 500, 1000, 2000, 4000, 8000, 10000, 10000]) {
        const count = state.clients.length
        await bus.startRealtimeSubscription(handler)
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(state.clients).toHaveLength(count)
        await vi.advanceTimersByTimeAsync(1)
        expect(state.clients).toHaveLength(count + 1)
      }
      state.connectFails = state.subscribeFails = false
      await vi.advanceTimersByTimeAsync(10000)
      receive(state.clients.at(-1))
      expect(handler).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps local websocket delivery during Redis failure', async () => {
    const { peerContext, sendToUser } = await import('../../../../server/utils/ws-state')
    const peer = { send: vi.fn() }
    peerContext.set(peer, { userId: 'user', scopes: null })
    state.connectFails = true
    try {
      await sendToUser('user', { type: 'chat_update' })
      expect(peer.send).toHaveBeenCalledWith(JSON.stringify({ type: 'chat_update' }))
    } finally {
      peerContext.clear()
    }
  })

  it('honors explicit namespace overrides', async () => {
    vi.stubEnv('REALTIME_CHANNEL_NAMESPACE', ' shared ')
    vi.resetModules()
    bus = await import('../../../../server/utils/realtime-bus')
    await bus.publishRealtimeEvent('user', {})
    expect(state.clients[0].publish).toHaveBeenCalledWith('app:realtime:shared', expect.any(String))
  })

  it('replaces ended publishers and fails softly during outage', async () => {
    await bus.publishRealtimeEvent('user', {})
    const first = state.clients[0]
    first.status = 'end'
    state.connectFails = true
    await expect(bus.publishRealtimeEvent('user', {})).resolves.toBeUndefined()
    state.connectFails = false
    await vi.advanceTimersByTimeAsync(250)
    await bus.publishRealtimeEvent('user', {})
    expect(state.clients.at(-1).publish).toHaveBeenCalledTimes(1)
    expect(first.eventNames()).toEqual([])
  })

  it('stop cancels recovery, cleans both clients, and allows explicit restart', async () => {
    await bus.startRealtimeSubscription(vi.fn())
    await bus.publishRealtimeEvent('user', {})
    state.clients[0].emit('end')
    await bus.stopRealtimeSubscription()
    await vi.advanceTimersByTimeAsync(60000)
    expect(state.clients).toHaveLength(2)
    for (const client of state.clients) {
      expect(client.status).toBe('end')
      expect(client.eventNames()).toEqual([])
    }
    await bus.startRealtimeSubscription(vi.fn())
    expect(state.clients).toHaveLength(3)
  })

  it('stop during connect cannot attach listeners or subscribe afterward', async () => {
    const handler = vi.fn()
    const start = bus.startRealtimeSubscription(handler)
    await bus.stopRealtimeSubscription()
    await start
    expect(state.clients[0].subscribe).not.toHaveBeenCalled()
    expect(state.clients[0].eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['development', 'production'])('preserves %s channel names', async (environment) => {
    vi.stubEnv('NODE_ENV', environment)
    vi.stubEnv('NUXT_PORT', '3204')
    vi.stubEnv('NITRO_PORT', '')
    vi.resetModules()
    bus = await import('../../../../server/utils/realtime-bus')
    await bus.startRealtimeSubscription(vi.fn())
    expect(state.clients[0].subscribe).toHaveBeenCalledWith(
      environment === 'development' ? 'app:realtime:dev-db3-p3204' : 'app:realtime'
    )
  })

  it.each(['missing Redis', 'build'])('disables clients for %s', async (mode) => {
    vi.stubEnv(mode === 'build' ? 'NITRO_BUILD' : 'REDIS_URL', mode === 'build' ? '1' : '')
    vi.resetModules()
    bus = await import('../../../../server/utils/realtime-bus')
    await bus.startRealtimeSubscription(vi.fn())
    await bus.publishRealtimeEvent('user', {})
    expect(state.clients).toHaveLength(0)
  })
})
