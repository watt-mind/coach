import { prisma } from '../db'
import { slugifyPublicName } from '../../../shared/public-plans'
import type { TeamRole } from '@prisma/client'
import { coachingRepository } from './coachingRepository'
import {
  generateInviteCode,
  isUniqueConstraintError,
  MAX_INVITE_CODE_RETRIES
} from '../invite-code'

function sanitizeTeamMemberEmail(
  member: {
    user: {
      id: string
      name: string | null
      email: string | null
      image: string | null
      teamVisibility?: string | null
    }
  },
  viewerId: string,
  isStaff: boolean
) {
  if (isStaff || member.user.id === viewerId) {
    return member
  }

  return {
    ...member,
    user: {
      ...member.user,
      email: null
    }
  }
}

export const teamRepository = {
  // --- Team Management ---

  async createTeam(ownerId: string, data: { name: string; description?: string }) {
    const baseSlug = slugifyPublicName(data.name)
    let slug = baseSlug
    let counter = 1

    // Ensure unique slug
    while (await (prisma as any).team.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${counter++}`
    }

    return await prisma.$transaction(async (tx) => {
      const team = await (tx as any).team.create({
        data: {
          name: data.name,
          description: data.description,
          slug,
          ownerId
        }
      })

      // Creator is automatically the OWNER member
      await (tx as any).teamMember.create({
        data: {
          teamId: team.id,
          userId: ownerId,
          role: 'OWNER'
        }
      })

      return team
    })
  },

  async getTeamsForUser(userId: string) {
    return await (prisma as any).teamMember.findMany({
      where: { userId, status: 'ACTIVE' },
      include: {
        team: {
          include: {
            _count: {
              select: { members: true, groups: true }
            }
          }
        }
      }
    })
  },

  async getTeamDetails(teamId: string, options: { viewerId?: string; isStaff?: boolean } = {}) {
    const team = await (prisma as any).team.findUnique({
      where: { id: teamId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                teamVisibility: true
              }
            }
          }
        },
        groups: {
          include: {
            coach: { select: { id: true, name: true } },
            members: { select: { athleteId: true } },
            _count: { select: { members: true } }
          }
        },
        _count: {
          select: { members: true, groups: true, invites: true }
        }
      }
    })

    if (!team || !options.viewerId) {
      return team
    }

    return {
      ...team,
      members: team.members.map((member: any) =>
        sanitizeTeamMemberEmail(member, options.viewerId!, options.isStaff ?? false)
      )
    }
  },

  async updateTeam(teamId: string, data: { name?: string; description?: string }) {
    return await (prisma as any).team.update({
      where: { id: teamId },
      data
    })
  },

  async deleteTeam(teamId: string) {
    return await (prisma as any).team.delete({
      where: { id: teamId }
    })
  },

  // --- Team Membership & Roster ---

  async addTeamMember(teamId: string, userId: string, role: TeamRole = 'ATHLETE') {
    return await (prisma as any).teamMember.upsert({
      where: { teamId_userId: { teamId, userId } },
      update: { role, status: 'ACTIVE' },
      create: { teamId, userId, role }
    })
  },

  async getTeamMember(teamId: string, userId: string) {
    return await (prisma as any).teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } }
    })
  },

  async countActiveMembersWithRole(teamId: string, role: TeamRole) {
    return await (prisma as any).teamMember.count({
      where: { teamId, role, status: 'ACTIVE' }
    })
  },

  async updateMemberRole(teamId: string, userId: string, role: TeamRole) {
    return await (prisma as any).teamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { role }
    })
  },

  async removeTeamMember(teamId: string, userId: string) {
    return await (prisma as any).teamMember.delete({
      where: { teamId_userId: { teamId, userId } }
    })
  },

  /**
   * Directly adds an athlete to a team if the coach is already coaching them.
   */
  async addAthleteToTeamByCoach(teamId: string, coachId: string, athleteId: string) {
    // 1. Verify coach is staff in the team
    const isStaff = await this.checkTeamAccess(teamId, coachId, ['OWNER', 'ADMIN', 'COACH'])
    if (!isStaff) throw new Error('Insufficient permissions in team')

    // 2. Verify coaching relationship exists
    const isCoaching = await coachingRepository.checkRelationship(coachId, athleteId)
    if (!isCoaching) throw new Error('You must be coaching this athlete to add them directly')

    // 3. Add to team
    return await (prisma as any).teamMember.upsert({
      where: { teamId_userId: { teamId, userId: athleteId } },
      update: { status: 'ACTIVE', role: 'ATHLETE' },
      create: { teamId, userId: athleteId, role: 'ATHLETE' }
    })
  },

  /**
   * Combined flow: Accepts an athlete's personal "Invite a Coach" code,
   * creates the coaching relationship, and adds them to the professional team.
   */
  async addAthleteToTeamByPersonalCode(teamId: string, coachId: string, code: string) {
    // 1. Verify coach is staff in the team
    const isStaff = await this.checkTeamAccess(teamId, coachId, ['OWNER', 'ADMIN', 'COACH'])
    if (!isStaff) throw new Error('Insufficient permissions in team')

    // 2. Connect via coaching code
    const relationship = await coachingRepository.connectAthleteWithCode(coachId, code)

    // 3. Add to team
    return await (prisma as any).teamMember.upsert({
      where: { teamId_userId: { teamId, userId: relationship.athleteId } },
      update: { status: 'ACTIVE', role: 'ATHLETE' },
      create: { teamId, userId: relationship.athleteId, role: 'ATHLETE' }
    })
  },

  async checkTeamAccess(teamId: string, userId: string, roles?: TeamRole[]) {
    const member = await (prisma as any).teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } }
    })

    if (!member || member.status !== 'ACTIVE') return false
    if (roles && roles.length > 0 && !roles.includes(member.role)) return false
    return true
  },

  /**
   * Fetches all athletes in a team with their metrics (CTL, TSB, etc.)
   */
  async getTeamRoster(
    teamId: string,
    options: { maskSensitiveData?: boolean; viewingCoachId?: string } = {}
  ) {
    const memberships = await (prisma as any).teamMember.findMany({
      where: { teamId, role: 'ATHLETE', status: 'ACTIVE' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            teamVisibility: true,
            currentFitnessScore: true,
            profileLastUpdated: true,
            recommendations: {
              orderBy: { generatedAt: 'desc' },
              take: 1
            },
            wellness: {
              orderBy: { date: 'desc' },
              take: 1
            },
            plannedWorkouts: {
              where: {
                date: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
                category: 'WORKOUT'
              },
              orderBy: { date: 'asc' },
              take: 2
            },
            events: {
              where: {
                date: { gte: new Date() },
                priority: 'A'
              },
              orderBy: { date: 'asc' },
              take: 1
            }
          }
        }
      }
    })

    const viewingCoachId = options.viewingCoachId

    return await Promise.all(
      memberships.map(async (m: any) => {
        const shouldMask = options.maskSensitiveData && m.user.teamVisibility === 'COACHES_ONLY'

        if (shouldMask) {
          // The raw user relation contains private metrics; retain only membership metadata.
          const { user, ...membership } = m
          return {
            ...membership,
            canViewDetails: false,
            athlete: {
              id: user.id,
              name: user.name,
              image: user.image,
              isMasked: true,
              canViewDetails: false
            }
          }
        }

        const hasDirectCoaching = viewingCoachId
          ? await coachingRepository.checkRelationship(viewingCoachId, m.user.id)
          : false

        if (hasDirectCoaching && viewingCoachId) {
          const athlete = await coachingRepository.getEnrichedAthleteForCoach(
            viewingCoachId,
            m.user.id
          )

          return {
            ...m,
            canViewDetails: true,
            athlete: athlete
              ? {
                  ...athlete,
                  canViewDetails: true
                }
              : {
                  id: m.user.id,
                  name: m.user.name,
                  email: m.user.email,
                  image: m.user.image,
                  canViewDetails: true,
                  stats: {
                    adherence7d: null,
                    completedCount: 0,
                    plannedCount: 0
                  }
                }
          }
        }

        return {
          ...m,
          canViewDetails: false,
          athlete: {
            id: m.user.id,
            name: m.user.name,
            email: m.user.email,
            image: m.user.image,
            canViewDetails: false,
            stats: {
              adherence7d: null,
              completedCount: 0,
              plannedCount: 0
            }
          }
        }
      })
    )
  },

  // --- Team Invitation Management ---

  async createTeamInvite(
    teamId: string,
    data: { email?: string; role: TeamRole; groupId?: string }
  ) {
    if (data.groupId) {
      if (data.role !== 'ATHLETE') {
        throw new Error('Only athlete invites can be assigned to groups')
      }

      const group = await (prisma as any).athleteGroup.findUnique({
        where: { id: data.groupId },
        select: { id: true, teamId: true }
      })

      if (!group || group.teamId !== teamId) {
        throw new Error('Selected group does not belong to this team')
      }
    }

    for (let attempt = 0; attempt < MAX_INVITE_CODE_RETRIES; attempt++) {
      try {
        return await (prisma as any).teamInvite.create({
          data: {
            teamId,
            email: data.email?.toLowerCase(),
            role: data.role,
            groupId: data.groupId,
            code: generateInviteCode(),
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
            status: 'PENDING'
          }
        })
      } catch (error) {
        if (isUniqueConstraintError(error) && attempt < MAX_INVITE_CODE_RETRIES - 1) {
          continue
        }
        throw error
      }
    }

    throw new Error('Failed to generate invite code')
  },

  async getTeamInvites(teamId: string) {
    return await (prisma as any).teamInvite.findMany({
      where: { teamId, status: 'PENDING', expiresAt: { gt: new Date() } },
      include: {
        group: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
  },

  async revokeInvite(teamId: string, inviteId: string) {
    const result = await (prisma as any).teamInvite.updateMany({
      where: { id: inviteId, teamId, status: 'PENDING' },
      data: { status: 'REVOKED' }
    })

    if (result.count === 0) {
      throw new Error('Invite not found')
    }

    return result
  },

  async acceptInvite(userId: string, code: string) {
    const invite = await (prisma as any).teamInvite.findUnique({
      where: { code }
    })

    if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
      throw new Error('Invalid or expired invite code')
    }

    const user = await (prisma as any).user.findUnique({
      where: { id: userId },
      select: { email: true }
    })
    const userEmail = user?.email?.toLowerCase()

    if (invite.email && invite.email !== userEmail) {
      throw new Error('This invite is restricted to another email address')
    }

    return await prisma.$transaction(async (tx) => {
      const membership = await (tx as any).teamMember.upsert({
        where: { teamId_userId: { teamId: invite.teamId, userId } },
        update: { role: invite.role, status: 'ACTIVE' },
        create: { teamId: invite.teamId, userId, role: invite.role }
      })

      // Auto-assign to group if present
      if (invite.groupId) {
        await (tx as any).athleteGroupMember.upsert({
          where: { groupId_athleteId: { groupId: invite.groupId, athleteId: userId } },
          update: {},
          create: { groupId: invite.groupId, athleteId: userId }
        })
      }

      if (invite.email) {
        await (tx as any).teamInvite.update({
          where: { id: invite.id },
          data: { status: 'ACCEPTED' }
        })
      }

      return membership
    })
  },

  // --- Athlete Group Management ---

  async createGroup(
    coachId: string,
    data: { name: string; description?: string; teamId?: string }
  ) {
    return await (prisma as any).athleteGroup.create({
      data: {
        name: data.name,
        description: data.description,
        coachId,
        teamId: data.teamId
      }
    })
  },

  async getGroupsForCoach(coachId: string, teamId?: string) {
    return await (prisma as any).athleteGroup.findMany({
      where: {
        coachId,
        ...(teamId ? { teamId } : {})
      },
      include: {
        members: { select: { athleteId: true } },
        _count: { select: { members: true } }
      }
    })
  },

  async getTeamGroups(teamId: string) {
    return await (prisma as any).athleteGroup.findMany({
      where: { teamId },
      include: {
        coach: { select: { id: true, name: true } },
        members: { select: { athleteId: true } },
        _count: { select: { members: true } }
      }
    })
  },

  async getGroupDetails(groupId: string) {
    return await (prisma as any).athleteGroup.findUnique({
      where: { id: groupId },
      include: {
        members: {
          include: {
            athlete: {
              select: { id: true, name: true, email: true, image: true }
            }
          }
        }
      }
    })
  },

  async updateGroup(groupId: string, data: { name?: string; description?: string }) {
    return await (prisma as any).athleteGroup.update({
      where: { id: groupId },
      data
    })
  },

  async deleteGroup(groupId: string) {
    return await (prisma as any).athleteGroup.delete({
      where: { id: groupId }
    })
  },

  async addAthleteToGroup(groupId: string, athleteId: string) {
    return await (prisma as any).athleteGroupMember.upsert({
      where: { groupId_athleteId: { groupId, athleteId } },
      update: {},
      create: { groupId, athleteId }
    })
  },

  async removeAthleteFromGroup(groupId: string, athleteId: string) {
    return await (prisma as any).athleteGroupMember.delete({
      where: { groupId_athleteId: { groupId, athleteId } }
    })
  },

  async checkGroupOwnership(groupId: string, coachId: string) {
    const group = await (prisma as any).athleteGroup.findUnique({
      where: { id: groupId },
      select: { coachId: true }
    })
    return group?.coachId === coachId
  }
}
