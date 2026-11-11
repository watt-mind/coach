import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { peerContext, sendToUser, sendToUserLocal } from '../../../../server/utils/ws-state'
import type { PeerContext } from '../../../../server/utils/ws-state'

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  log: vi.fn(),
  subscribe: vi.fn(),
  runner: vi.fn()
}))
vi.mock('../../../../server/utils/realtime-bus', () => ({
  publishRealtimeEvent: mocks.publish,
  isRealtimeBusEnabled: () => true,
  startRealtimeSubscription: mocks.subscribe,
  stopRealtimeSubscription: vi.fn()
}))
vi.mock('../../../../server/utils/realtime-logger', () => ({ logRealtimeEvent: mocks.log }))
vi.mock('../../../../server/utils/chat/turn-runner', () => ({ getChatTurnRunner: mocks.runner }))

const notification = { type: 'notification_new', notification: { title: 'Private workout' } }
function peer(scopes: PeerContext['scopes'], userId = 'user-1') {
  const socket = { send: vi.fn() }
  peerContext.set(socket, { userId, scopes })
  return socket
}

beforeEach(() => {
  peerContext.clear()
  vi.clearAllMocks()
})
afterEach(() => {
  peerContext.clear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('WebSocket notification delivery', () => {
  it.each([
    { scopes: ['workout:write'], allowed: false },
    { scopes: [], allowed: false },
    { scopes: undefined, allowed: false },
    { scopes: ['chat:read'], allowed: false },
    { scopes: ['profile:read'], allowed: true },
    // tokenHasScopes currently recognizes exact grants only.
    { scopes: ['profile:*'], allowed: false },
    { scopes: ['*'], allowed: false },
    { scopes: null, allowed: true }
  ])('checks notification grants: $scopes', ({ scopes, allowed }) => {
    const socket = peer(scopes)
    const otherUser = peer(scopes, 'user-2')
    expect(sendToUserLocal('user-1', notification)).toBe(allowed ? 1 : 0)
    expect(socket.send).toHaveBeenCalledTimes(allowed ? 1 : 0)
    if (allowed) expect(socket.send).toHaveBeenCalledWith(JSON.stringify(notification))
    expect(otherUser.send).not.toHaveBeenCalled()
  })

  it('keeps chat permission independent from notification permission', () => {
    const profile = peer(['profile:read'])
    const chat = peer(['chat:read'])
    const session = peer(null)
    for (const type of ['chat_message_upsert', 'chat_turn_status', 'chat_assistant_text_delta']) {
      expect(sendToUserLocal('user-1', { type })).toBe(2)
    }
    expect(profile.send).not.toHaveBeenCalled()
    expect(chat.send).toHaveBeenCalledTimes(3)
    expect(session.send).toHaveBeenCalledTimes(3)
  })

  it('gates direct publishing while forwarding to the bus for remote peers', async () => {
    const denied = peer(['workout:write'])
    const allowed = peer(['profile:read'])
    await sendToUser('user-1', notification)
    expect(denied.send).not.toHaveBeenCalled()
    expect(allowed.send).toHaveBeenCalledWith(JSON.stringify(notification))
    expect(mocks.publish).toHaveBeenCalledWith('user-1', notification)
    expect(mocks.log).toHaveBeenCalledWith(
      'ws',
      'local_deliver',
      expect.objectContaining({ deliveredCount: 1 })
    )
  })

  it('gates messages received by the actual plugin bus subscriber', async () => {
    vi.stubEnv('CHAT_TURN_RUNNER_ENABLED', 'false')
    vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
    const { default: plugin } = await import('../../../../server/plugins/chat-turn-runner')
    const denied = peer([])
    const allowed = peer(['profile:read'])
    const otherUser = peer(null, 'user-2')
    plugin({ hooks: { hookOnce: vi.fn() } } as any)
    const callback = mocks.subscribe.mock.calls[0]![0]
    callback({ userId: 'user-1', data: notification })
    expect(denied.send).not.toHaveBeenCalled()
    expect(allowed.send).toHaveBeenCalledWith(JSON.stringify(notification))
    expect(otherUser.send).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledWith(
      'ws',
      'local_deliver',
      expect.objectContaining({ deliveredCount: 1 })
    )
  })
})
