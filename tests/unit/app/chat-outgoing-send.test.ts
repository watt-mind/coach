import { describe, expect, it } from 'vitest'
import {
  createChatSendAttemptTracker,
  dispatchChatOutgoing
} from '../../../app/utils/chat-outgoing-queue'

describe('SDK outgoing send outcomes', () => {
  it('rejects a resolved SDK send that reported a transport error', async () => {
    const tracker = createChatSendAttemptTracker()
    const error = new Error('503 Service unavailable')
    await expect(tracker.send('room-a', async () => tracker.onError(error))).rejects.toBe(error)
  })
})

// Exercise the production outcome tracker with the SDK's swallowed-error contract.
describe('attempt isolation and recovery', () => {
  it.each(['Failed to fetch', '503 Service unavailable', '429 quota exceeded'])(
    'retains the original error for %s and allows a successful retry',
    async (message) => {
      const tracker = createChatSendAttemptTracker()
      const error = new Error(message)
      let status = 'ready'
      await expect(
        tracker.send('original-room', async () => {
          tracker.onError(error)
          status = 'error'
        })
      ).rejects.toBe(error)
      expect(status).toBe('error')
      expect(tracker.roomId).toBeUndefined()
      // A stale SDK error/status must not poison the next invocation.
      await expect(tracker.send('original-room', async () => {})).resolves.toBeUndefined()
    }
  )

  it('propagates thrown errors and releases the attempt', async () => {
    const tracker = createChatSendAttemptTracker()
    const error = new Error('transport threw')
    await expect(
      tracker.send('room-a', async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(tracker.roomId).toBeUndefined()
  })

  it('keeps the parser recovery branch successful', async () => {
    const tracker = createChatSendAttemptTracker()
    await expect(
      tracker.send('room-a', async () => {
        tracker.onError(new Error('No tool invocation found for tool call'))
      })
    ).resolves.toBeUndefined()
  })

  it('does not retain errors outside a send', async () => {
    const tracker = createChatSendAttemptTracker()
    tracker.onError(new Error('previous room'))
    await expect(tracker.send('room-b', async () => {})).resolves.toBeUndefined()
  })

  it('retains originating room through a room change', async () => {
    const tracker = createChatSendAttemptTracker()
    let currentRoom = 'room-a'
    const error = new Error('network error')
    await expect(
      tracker.send(currentRoom, async () => {
        currentRoom = 'room-b'
        expect(tracker.roomId).toBe('room-a')
        tracker.onError(error)
      })
    ).rejects.toBe(error)
    expect(currentRoom).toBe('room-b')
    expect(tracker.roomId).toBeUndefined()
  })
})

describe.each(['direct', 'queued'])('%s durable dispatch', (path) => {
  it.each(['resolved error', 'thrown error'])(
    'retains identity and attachments on %s, then retries',
    async (failure) => {
      const tracker = createChatSendAttemptTracker()
      const message = {
        id: 'client-id',
        roomId: 'room-a',
        text: 'full original text',
        attachments: [{ url: '/uploads/file', mediaType: 'image/png', filename: 'ride.png' }],
        createdAt: '2026-11-11T10:00:00.000Z',
        failed: false
      }
      let queue = path === 'queued' ? [message] : []
      const storage = new Map<string, string>()
      let awaiting = true
      let inFlight = true
      const ids: string[] = []
      const persist = () => storage.set(message.roomId, JSON.stringify(queue))
      const dispatch = (fail: boolean) =>
        dispatchChatOutgoing(message, {
          queued: path === 'queued',
          getQueued: () => queue,
          setQueued: (_room, messages) => {
            queue = messages
          },
          send: () =>
            tracker.send(message.roomId, async () => {
              ids.push(message.id)
              if (fail) {
                const error = new Error('503')
                if (failure === 'thrown error') throw error
                tracker.onError(error)
              }
            }),
          sent: () => {},
          failed: () => {
            awaiting = false
          },
          settled: () => {
            inFlight = false
            persist()
          }
        })
      await dispatch(true)
      expect(awaiting).toBe(false)
      expect(inFlight).toBe(false)
      // Simulate a same-tab reload of the durable record.
      queue = JSON.parse(storage.get(message.roomId)!)
      expect(queue).toEqual([{ ...message, failed: true }])
      await dispatch(false)
      expect(queue).toEqual([])
      expect(ids).toEqual(['client-id', 'client-id'])
    }
  )

  it('runs the success path once and releases dispatch', async () => {
    const tracker = createChatSendAttemptTracker()
    const calls: string[] = []
    await dispatchChatOutgoing(
      { id: 'id', roomId: 'room-a' },
      {
        queued: path === 'queued',
        getQueued: () => [],
        setQueued: () => {},
        send: () => tracker.send('room-a', async () => {}),
        sent: () => {
          calls.push('sent')
        },
        failed: () => {
          calls.push('failed')
        },
        settled: () => {
          calls.push('settled')
        }
      }
    )
    expect(calls).toEqual(['sent', 'settled'])
  })
})

it('observes a real SDK transport rejection even though sendMessage resolves', async () => {
  const { Chat } = await import('@ai-sdk/vue')
  const tracker = createChatSendAttemptTracker()
  const error = new Error('503 Service unavailable')
  const chat = new Chat({
    transport: {
      sendMessages: async () => {
        throw error
      },
      reconnectToStream: async () => null
    },
    onError: (error) => tracker.onError(error)
  })
  await expect(
    tracker.send('room-a', () =>
      chat.sendMessage({
        id: 'stable-client-id',
        role: 'user',
        parts: [
          { type: 'text', text: 'text with attachment' },
          { type: 'file', url: '/uploads/ride.png', mediaType: 'image/png', filename: 'ride.png' }
        ]
      })
    )
  ).rejects.toBe(error)
  expect(chat.status).toBe('error')
  expect(chat.messages[0]?.id).toBe('stable-client-id')
})

it('retries an ambiguous post-persistence failure with the same server deduplication key', async () => {
  const { Chat } = await import('@ai-sdk/vue')
  const tracker = createChatSendAttemptTracker()
  const persisted = new Set<string>()
  const attempts: string[] = []
  const chat = new Chat({
    transport: {
      sendMessages: async ({ messages }) => {
        const id = messages.find((message) => message.role === 'user')!.id
        attempts.push(id)
        persisted.add(id)
        if (attempts.length === 1) throw new Error('Connection lost after persistence')
        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'start', messageId: 'assistant-id' })
            controller.enqueue({ type: 'finish', finishReason: 'stop' })
            controller.close()
          }
        })
      },
      reconnectToStream: async () => null
    },
    onError: (error) => tracker.onError(error)
  })
  const send = () =>
    tracker.send('room-a', () =>
      chat.sendMessage({
        id: 'original-client-id',
        role: 'user',
        parts: [{ type: 'text', text: 'original' }]
      })
    )
  await expect(send()).rejects.toThrow('Connection lost after persistence')
  await expect(send()).resolves.toBeUndefined()
  expect(attempts).toEqual(['original-client-id', 'original-client-id'])
  expect(persisted.size).toBe(1)
})

it('does not resurrect a queued item reconciled as persisted during an ambiguous failure', async () => {
  const tracker = createChatSendAttemptTracker()
  const message = { id: 'persisted-id', roomId: 'room-a', failed: false }
  let queue = [message]
  await dispatchChatOutgoing(message, {
    queued: true,
    getQueued: () => queue,
    setQueued: (_room, messages) => {
      queue = messages
    },
    send: () =>
      tracker.send(message.roomId, async () => {
        queue = [] // History reconciliation confirmed the original client ID.
        tracker.onError(new Error('stream disconnected'))
      }),
    sent: () => {},
    failed: () => {}
  })
  expect(queue).toEqual([])
})

it.each([false, true])(
  'settles the originating room when navigation occurs (queued=%s)',
  async (queued) => {
    const tracker = createChatSendAttemptTracker()
    const message = { id: 'old-room-id', roomId: 'room-a', failed: false }
    const other = { id: 'new-room-id', roomId: 'room-b', failed: false }
    const rooms: Record<string, (typeof message)[]> = {
      'room-a': queued ? [message] : [],
      'room-b': [other]
    }
    let currentRoom = 'room-a'
    await dispatchChatOutgoing(message, {
      queued,
      getQueued: (roomId) => rooms[roomId]!,
      setQueued: (roomId, messages) => {
        rooms[roomId] = messages
      },
      send: () =>
        tracker.send(message.roomId, async () => {
          currentRoom = 'room-b'
          tracker.onError(new Error('503'))
        }),
      sent: () => {},
      failed: () => {}
    })
    expect(currentRoom).toBe('room-b')
    expect(rooms['room-a']).toEqual([{ ...message, failed: true }])
    expect(rooms['room-b']).toEqual([other])
  }
)

it.each([false, true])(
  'serializes overlapping room dispatch and preserves failed retries (queued=%s)',
  async (queued) => {
    const tracker = createChatSendAttemptTracker()
    const a = {
      id: 'a-id',
      roomId: 'a',
      text: 'original A',
      attachments: [{ url: '/a.png' }],
      failed: false
    }
    const b = { ...a, id: 'b-id', roomId: 'b', text: 'original B' }
    const rooms: Record<string, (typeof a)[]> = { a: queued ? [a] : [], b: queued ? [b] : [] }
    const gates = { a: Promise.withResolvers<undefined>(), b: Promise.withResolvers<undefined>() }
    const startedA = Promise.withResolvers<undefined>()
    const startedB = Promise.withResolvers<undefined>()
    const calls: string[] = []
    const inFlight = new Set<string>()
    let currentRoom = 'a'
    let awaiting = true
    const dispatch = (message: typeof a, retry = false) => {
      inFlight.add(message.roomId)
      return dispatchChatOutgoing(message, {
        queued: retry || queued,
        getQueued: (room) => rooms[room]!,
        setQueued: (room, messages) => {
          rooms[room] = messages
        },
        send: () =>
          tracker.send(message.roomId, async () => {
            calls.push(message.id)
            if (retry) return
            if (message === a) startedA.resolve(undefined)
            else startedB.resolve(undefined)
            await gates[message.roomId as 'a' | 'b'].promise
            if (message === a) {
              // SDK reports failure then resolves; navigation must not reset B's composer.
              const errorRoom = tracker.roomId
              tracker.onError(new Error('room-a 503'))
              if (errorRoom === currentRoom) awaiting = false
            }
          }),
        sent: () => {
          calls.push('sent:' + message.roomId)
        },
        failed: () => {
          calls.push('failed:' + message.roomId)
        },
        settled: () => {
          inFlight.delete(message.roomId)
        }
      })
    }
    const first = dispatch(a)
    await startedA.promise
    currentRoom = 'b'
    const second = dispatch(b)
    // Complete B's transport gate first: it must still wait for A's callback/settlement.
    gates.b.resolve(undefined)
    await Promise.resolve(undefined)
    expect(calls).toEqual(['a-id'])
    expect(tracker.roomId).toBe('a')
    gates.a.resolve(undefined)
    await first
    await startedB.promise
    await second
    expect(awaiting).toBe(true)
    expect(rooms.a).toEqual([{ ...a, failed: true }])
    expect(rooms.b).toEqual([])
    expect(calls.filter((call) => call.endsWith(':a'))).toEqual(['failed:a'])
    expect(calls.filter((call) => call.endsWith(':b'))).toEqual(['sent:b'])
    expect(inFlight.size).toBe(0)
    await dispatch(a, true)
    expect(rooms.a).toEqual([])
    expect(calls.slice(-2)).toEqual(['a-id', 'sent:a'])
  }
)

it.each(['a', 'b'])(
  'correlates real SDK completion/error callbacks when room %s fails',
  async (failedRoom) => {
    const { Chat } = await import('@ai-sdk/vue')
    const tracker = createChatSendAttemptTracker()
    const a = { id: 'a-client', roomId: 'a', failed: false }
    const b = { id: 'b-client', roomId: 'b', failed: false }
    const rooms: Record<string, (typeof a)[]> = { a: [a], b: [b] }
    const gates = { a: Promise.withResolvers<undefined>(), b: Promise.withResolvers<undefined>() }
    const started = Promise.withResolvers<undefined>()
    const callbacks: string[] = []
    const chat = new Chat({
      transport: {
        sendMessages: async ({ body }) => {
          const room = body!.roomId as 'a' | 'b'
          if (room === 'a') started.resolve(undefined)
          await gates[room].promise
          if (room === failedRoom) throw new Error(room + ' 503')
          return new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'start', messageId: room + '-assistant' })
              controller.enqueue({ type: 'finish', finishReason: 'stop' })
              controller.close()
            }
          })
        },
        reconnectToStream: async () => null
      },
      onError: (error) => {
        callbacks.push('error:' + tracker.roomId)
        tracker.onError(error)
      },
      onFinish: () => {
        callbacks.push('finish:' + tracker.roomId)
      }
    })
    const dispatch = (message: typeof a) =>
      dispatchChatOutgoing(message, {
        queued: true,
        getQueued: (room) => rooms[room]!,
        setQueued: (room, messages) => {
          rooms[room] = messages
        },
        send: () =>
          tracker.send(message.roomId, () =>
            chat.sendMessage(
              {
                id: message.id,
                role: 'user',
                parts: [{ type: 'text', text: message.roomId }]
              },
              { body: { roomId: message.roomId } }
            )
          ),
        sent: () => {},
        failed: () => {}
      })
    const first = dispatch(a)
    await started.promise
    const second = dispatch(b)
    gates.b.resolve(undefined)
    gates.a.resolve(undefined)
    await Promise.all([first, second])
    expect(rooms[failedRoom]).toEqual([{ ...(failedRoom === 'a' ? a : b), failed: true }])
    expect(rooms[failedRoom === 'a' ? 'b' : 'a']).toEqual([])
    expect(callbacks).toContain('error:' + failedRoom)
    expect(callbacks).toContain('finish:' + (failedRoom === 'a' ? 'b' : 'a'))
    expect(tracker.roomId).toBeUndefined()
  }
)
