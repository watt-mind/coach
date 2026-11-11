import { beforeEach, describe, expect, it, vi } from 'vitest'
import { teamRepository } from '../../../../../server/utils/repositories/teamRepository'
import { prisma } from '../../../../../server/utils/db'

vi.mock('../../../../../server/utils/db', () => ({
  prisma: { teamMember: { findUnique: vi.fn() } }
}))
vi.mock('../../../../../server/utils/repositories/coachingRepository', () => ({
  coachingRepository: {}
}))
vi.mock('../../../../../server/utils/auth-guard', () => ({
  requireAuth: vi.fn().mockResolvedValue({ id: 'viewer' })
}))

vi.stubGlobal('defineRouteMeta', vi.fn())
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('getRouterParam', () => 'team')
vi.stubGlobal('createError', (error: unknown) => error)
const { default: handler } =
  await import('../../../../../server/api/coaching/teams/[id]/roster.get')

describe('GET team roster access policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['ATHLETE', 'OWNER', 'ADMIN', 'COACH'])(
    'uses the correct masking policy for active %s members',
    async (role) => {
      vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({ role, status: 'ACTIVE' } as any)
      const response = [{ athlete: { id: 'athlete' } }]
      const roster = vi.spyOn(teamRepository, 'getTeamRoster').mockResolvedValue(response)
      expect(await handler({} as any)).toEqual(response)
      expect(roster).toHaveBeenCalledWith('team', {
        maskSensitiveData: role === 'ATHLETE',
        viewingCoachId: 'viewer'
      })
      roster.mockRestore()
    }
  )

  it.each([null, { role: 'ATHLETE', status: 'INACTIVE' }, { role: 'OWNER', status: 'INACTIVE' }])(
    'denies absent or inactive membership: %j',
    async (member) => {
      vi.mocked(prisma.teamMember.findUnique).mockResolvedValue(member as any)
      const roster = vi.spyOn(teamRepository, 'getTeamRoster')
      await expect(handler({} as any)).rejects.toMatchObject({ statusCode: 403 })
      expect(roster).not.toHaveBeenCalled()
      roster.mockRestore()
    }
  )
})
