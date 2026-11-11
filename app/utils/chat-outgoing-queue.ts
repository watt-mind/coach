export const CHAT_OUTGOING_QUEUE_STORAGE_KEY = 'coach-chat-outgoing-queue'

export function clearChatOutgoingQueue() {
  if (!import.meta.client) return
  sessionStorage.removeItem(CHAT_OUTGOING_QUEUE_STORAGE_KEY)
}

// The SDK reports transport failures through onError, but resolves sendMessage.
// Serialize invocations across rooms: SDK callbacks carry no request identity.
// A previous chat.error is not an outcome for the next invocation.
export function createChatSendAttemptTracker() {
  let tail: Promise<void> | undefined
  let active: { roomId: string; error?: Error } | undefined
  return {
    get roomId() {
      return active?.roomId
    },
    onError(error: Error) {
      if (active) active.error = error
    },
    async send(roomId: string, send: () => Promise<unknown>) {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => {
        release = resolve
      })
      if (previous) await previous
      const attempt = { roomId } as { roomId: string; error?: Error }
      active = attempt
      try {
        await send()
        // This parser error is already recovered by reloading persisted history.
        if (attempt.error && !attempt.error.message.includes('No tool invocation found')) {
          throw attempt.error
        }
      } finally {
        if (active === attempt) active = undefined
        release()
      }
    }
  }
}

// Both direct and queued sends must use the same completion contract.
export async function dispatchChatOutgoing<
  T extends { id: string; roomId: string; failed?: boolean }
>(
  message: T,
  callbacks: {
    queued: boolean
    getQueued: (roomId: string) => T[]
    setQueued: (roomId: string, messages: T[]) => void
    send: () => Promise<unknown>
    sent: () => void
    failed: (error: any) => void
    settled?: () => void
  }
) {
  try {
    await callbacks.send()
    callbacks.setQueued(
      message.roomId,
      callbacks.getQueued(message.roomId).filter((item) => item.id !== message.id)
    )
    callbacks.sent()
  } catch (error) {
    const queue = callbacks.getQueued(message.roomId)
    // A queued record may already have been reconciled against persisted history.
    callbacks.setQueued(
      message.roomId,
      callbacks.queued
        ? queue.map((item) => (item.id === message.id ? { ...item, failed: true } : item))
        : [...queue.filter((item) => item.id !== message.id), { ...message, failed: true }]
    )
    callbacks.failed(error)
  } finally {
    callbacks.settled?.()
  }
}
