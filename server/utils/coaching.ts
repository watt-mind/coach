import type { H3Event } from 'h3'
import { createError, getHeader } from 'h3'
import { getServerSession } from './session'
import { oauthRepository } from './repositories/oauthRepository'
import { validateApiKey } from './auth-api-key'
import { prisma } from './db'

function ensureActiveUser(user: { deactivatedAt?: Date | string | null } | null | undefined) {
  if (user?.deactivatedAt) {
    throw createError({
      statusCode: 403,
      message: 'Account deactivated'
    })
  }
}

/**
 * Validates an OAuth Bearer token and returns the associated user.
 */
async function validateOAuthToken(event: H3Event) {
  let authHeader: string | undefined
  if (event && event.node && event.node.req) {
    authHeader = getHeader(event, 'Authorization') || getHeader(event, 'authorization')
  } else if (event) {
    const headers =
      (event as any).headers || (event as any).node?.req?.headers || (event as any).req?.headers
    authHeader = headers?.['authorization'] || headers?.['Authorization']
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null
  }

  const tokenValue = authHeader.substring(7)
  const token = await oauthRepository.getAccessToken(tokenValue)

  if (!token || (token.accessTokenExpiresAt && token.accessTokenExpiresAt < new Date())) {
    return null
  }

  // REST only accepts legacy resource-less tokens; bound tokens belong to their audience.
  if (token.resource) {
    return null
  }

  // Update usage info (async)
  prisma.oAuthToken
    .update({
      where: { id: token.id },
      data: {
        lastUsedAt: new Date(),
        lastIp:
          getHeader(event, 'x-forwarded-for')?.toString().split(',')[0] ||
          event.node.req.socket.remoteAddress
      }
    })
    .catch((e) => console.error('Failed to update token usage:', e))

  return token.user
}

/**
 * Gets the effective user ID for the current request.
 * If the user is a coach acting as an athlete, it returns the athlete's ID
 * after verifying the coaching relationship.
 */
export async function getEffectiveUserId(event: H3Event): Promise<string> {
  // 1. Try centralized session (handles Acting As and Impersonation)
  const session = await getServerSession(event)
  if (session?.user?.id) {
    ensureActiveUser(session.user)
    return session.user.id
  }

  // 2. Try API key
  const user = await validateApiKey(event)
  if (user) {
    ensureActiveUser(user)
    return user.id
  }

  // 3. Try OAuth Bearer Token
  const oauthUser = await validateOAuthToken(event)
  if (oauthUser) {
    ensureActiveUser(oauthUser)
    return oauthUser.id
  }

  throw createError({ statusCode: 401, message: 'Unauthorized' })
}
