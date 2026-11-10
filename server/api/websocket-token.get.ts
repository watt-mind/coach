import { requireAuth } from '../utils/auth-guard'
import { generateWsToken } from '../utils/ws-auth'

/**
 * Mint a short-lived WebSocket auth token.
 *
 * Supports cookie sessions (web) and OAuth Bearer / API keys (mobile companion)
 * via requireAuth. Granted OAuth scopes are embedded in the token so `/api/websocket`
 * can enforce chat:read / chat:write (and keep non-chat realtime usable without
 * those scopes). Session and API-key mints are unrestricted (`scopes: null`).
 */
export default defineEventHandler(async (event) => {
  const user = await requireAuth(event, undefined, { allowOAuth: true })

  const scopes =
    event.context.authType === 'oauth' ? ((event.context.oauthScopes as string[]) ?? []) : null

  const token = generateWsToken(user.id, scopes)
  return { token }
})
