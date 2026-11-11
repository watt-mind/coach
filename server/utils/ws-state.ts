import { publishRealtimeEvent } from './realtime-bus'
import { logRealtimeEvent } from './realtime-logger'
import { wsAuthHasScopes } from './ws-auth'

export type PeerContext = {
  userId?: string
  /** `null` = unrestricted (session / API key). */
  scopes?: string[] | null
}

// Map to store peer authentication status
export const peerContext = new Map<any, PeerContext>()

function peerCanReceive(ctx: PeerContext, data: any): boolean {
  const type = typeof data?.type === 'string' ? data.type : ''
  // Chat realtime is privileged — require chat:read (same as REST chat GETs).
  if (type.startsWith('chat_')) {
    return wsAuthHasScopes(ctx.scopes, ['chat:read'])
  }
  // Match notification REST GET permissions on direct and bus delivery.
  if (type === 'notification_new') {
    return wsAuthHasScopes(ctx.scopes, ['profile:read'])
  }
  return true
}

export function sendToUserLocal(userId: string, data: any) {
  const message = JSON.stringify(data)
  let deliveredCount = 0

  for (const [peer, ctx] of peerContext.entries()) {
    if (ctx.userId === userId && peerCanReceive(ctx, data)) {
      try {
        peer.send(message)
        deliveredCount += 1
      } catch (e) {
        console.error(`Failed to send WS message to user ${userId}:`, e)
      }
    }
  }

  logRealtimeEvent(data?.channel || 'ws', 'local_deliver', {
    userId,
    type: data?.type,
    deliveredCount,
    reason: data?.event?.reason,
    entityType: data?.event?.entityType,
    entityId: data?.event?.entityId,
    runId: data?.runId
  })

  return deliveredCount
}

/**
 * Sends a WebSocket message to all active connections for a specific user.
 * This should only be used from within the same process as the WebSocket server.
 */
export async function sendToUser(userId: string, data: any) {
  sendToUserLocal(userId, data)
  await publishRealtimeEvent(userId, data)
}
