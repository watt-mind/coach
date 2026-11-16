import type { H3Event } from 'h3'
import { getCookie, getHeader } from 'h3'
import { getServerSession as getBaseSession } from '#auth'
import { prisma } from './db'
import { coachingRepository } from './repositories/coachingRepository'

export interface CustomSession {
  user?: {
    name?: string | null
    email?: string | null
    image?: string | null
    timezone?: string | null
    language?: string | null
    uiLanguage?: string | null
    deactivatedAt?: string | Date | null
    id: string
    isAdmin: boolean
    isImpersonating?: boolean
    isCoaching?: boolean
    originalUserId?: string
    originalUserEmail?: string | null
  }
  expires: string
}

/**
 * Centralized session utility that handles regular authentication
 * and admin impersonation.
 */
export async function getServerSession(event: H3Event): Promise<CustomSession | null> {
  // 1. Check for standard auth session
  const session = await getBaseSession(event)

  if (!session || !session.user) {
    return null
  }

  const baseUserId = (session.user as any).id
  if (baseUserId) {
    const baseUser = await prisma.user.findUnique({
      where: { id: baseUserId },
      select: {
        deactivatedAt: true
      }
    })

    if (!baseUser || baseUser.deactivatedAt) {
      return null
    }
  }

  // 2. Handle Admin Impersonation
  const impersonatedUserId = getCookie(event, 'auth.impersonated_user_id')

  if ((session.user as any).isAdmin && impersonatedUserId) {
    // If user is admin and requesting impersonation, fetch the target user
    const targetUser = await prisma.user.findUnique({
      where: { id: impersonatedUserId }
    })

    if (targetUser) {
      return {
        ...session,
        user: {
          ...session.user,
          id: targetUser.id,
          name: targetUser.name,
          email: targetUser.email,
          image: targetUser.image,
          timezone: targetUser.timezone ?? null,
          language: targetUser.language ?? null,
          uiLanguage: targetUser.uiLanguage ?? null,
          deactivatedAt: targetUser.deactivatedAt ?? null,
          isAdmin: (targetUser as any).isAdmin || false,
          isImpersonating: true,
          originalUserId: (session.user as any).id,
          originalUserEmail: session.user.email
        }
      } as CustomSession
    }
  }

  // 3. Handle Coaching "Act As"
  const actAsUserId =
    getHeader(event, 'x-act-as-user') || getCookie(event, 'coach_wattz_act_as_user')
  const currentUserId = (session.user as any).id

  if (actAsUserId && actAsUserId !== currentUserId) {
    // Verify coaching relationship
    const hasRelationship = await coachingRepository.checkRelationship(currentUserId, actAsUserId)

    if (hasRelationship) {
      const targetUser = await prisma.user.findUnique({
        where: { id: actAsUserId }
      })

      if (targetUser) {
        return {
          ...session,
          user: {
            ...session.user,
            id: targetUser.id,
            name: targetUser.name,
            email: targetUser.email,
            image: targetUser.image,
            timezone: targetUser.timezone ?? null,
            language: targetUser.language ?? null,
            uiLanguage: targetUser.uiLanguage ?? null,
            deactivatedAt: targetUser.deactivatedAt ?? null,
            isAdmin: false,
            isCoaching: true,
            originalUserId: currentUserId,
            originalUserEmail: session.user.email
          }
        } as CustomSession
      }
    }
  }

  // Ensure default session matches CustomSession
  if (!(session.user as any).id) {
    // Need to fetch user id if not in session token
    // This logic depends on how auth is set up (JWT vs Database)
    // Usually next-auth-prisma-adapter puts id in session user if configured.
    // If not, we might need to fetch it.
    // Assuming it IS there for now but typed as 'any' to fix TS error.
  }

  return session as unknown as CustomSession
}
