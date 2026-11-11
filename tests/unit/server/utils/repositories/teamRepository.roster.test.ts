import { beforeEach, describe, expect, it, vi } from 'vitest'
import { teamRepository } from '../../../../../server/utils/repositories/teamRepository'
import { prisma } from '../../../../../server/utils/db'
import { coachingRepository } from '../../../../../server/utils/repositories/coachingRepository'

vi.mock('../../../../../server/utils/db', () => ({
  prisma: { teamMember: { findMany: vi.fn() } }
}))
vi.mock('../../../../../server/utils/repositories/coachingRepository', () => ({
  coachingRepository: { checkRelationship: vi.fn(), getEnrichedAthleteForCoach: vi.fn() }
}))

const privateFields = {
  email: 'private-email-sentinel',
  currentFitnessScore: 987654321,
  profileLastUpdated: 'private-profile-sentinel',
  recommendations: [{ id: 'private-recommendation-sentinel' }],
  wellness: [{ id: 'private-wellness-sentinel' }],
  plannedWorkouts: [{ id: 'private-workout-sentinel' }],
  events: [{ id: 'private-event-sentinel' }]
}
const membership = (id: string, visibility = 'COACHES_ONLY') => ({
  id: `membership-${id}`,
  teamId: 'team',
  userId: id,
  role: 'ATHLETE',
  status: 'ACTIVE',
  joinedAt: '2026-01-01',
  user: {
    id,
    name: `Name ${id}`,
    image: `image-${id}`,
    teamVisibility: visibility,
    ...privateFields
  }
})

describe('teamRepository.getTeamRoster privacy', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(coachingRepository.checkRelationship).mockResolvedValue(false)
  })

  it('removes private data throughout serialized masked entries while preserving mixed roster behavior', async () => {
    const hidden = membership('hidden')
    const visible = membership('visible', 'TEAM')
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([hidden, visible] as any)
    const result = await teamRepository.getTeamRoster('team', {
      maskSensitiveData: true,
      viewingCoachId: 'viewer'
    })
    const masked = JSON.parse(JSON.stringify(result[0]))
    const { user: _user, ...metadata } = hidden
    expect(masked).toEqual({
      ...metadata,
      canViewDetails: false,
      athlete: {
        id: 'hidden',
        name: 'Name hidden',
        image: 'image-hidden',
        isMasked: true,
        canViewDetails: false
      }
    })
    for (const [key, value] of Object.entries(privateFields)) {
      expect(JSON.stringify(masked)).not.toContain(key)
      expect(JSON.stringify(masked)).not.toContain(JSON.stringify(value))
    }
    expect(result[1].user).toEqual(visible.user)
    expect(result[1].athlete.email).toBe(privateFields.email)
    expect(coachingRepository.checkRelationship).toHaveBeenCalledExactlyOnceWith(
      'viewer',
      'visible'
    )
    expect(coachingRepository.getEnrichedAthleteForCoach).not.toHaveBeenCalled()
  })

  it('preserves staff unmasked data and direct coaching enrichment', async () => {
    const member = membership('hidden')
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([member] as any)
    vi.mocked(coachingRepository.checkRelationship).mockResolvedValue(true)
    const enriched = { id: 'hidden', stats: { adherence7d: 90 } }
    vi.mocked(coachingRepository.getEnrichedAthleteForCoach).mockResolvedValue(enriched as any)
    const [result] = await teamRepository.getTeamRoster('team', {
      maskSensitiveData: false,
      viewingCoachId: 'coach'
    })
    expect(result).toEqual({
      ...member,
      canViewDetails: true,
      athlete: { ...enriched, canViewDetails: true }
    })
    expect(coachingRepository.getEnrichedAthleteForCoach).toHaveBeenCalledWith('coach', 'hidden')
  })

  it('preserves direct coaching fallback and default unmasked responses', async () => {
    const member = membership('hidden')
    vi.mocked(prisma.teamMember.findMany).mockResolvedValue([member] as any)
    expect((await teamRepository.getTeamRoster('team'))[0].user).toEqual(member.user)
    vi.mocked(coachingRepository.checkRelationship).mockResolvedValue(true)
    vi.mocked(coachingRepository.getEnrichedAthleteForCoach).mockResolvedValue(null)
    const [result] = await teamRepository.getTeamRoster('team', { viewingCoachId: 'coach' })
    expect(result.canViewDetails).toBe(true)
    expect(result.athlete).toMatchObject({
      id: 'hidden',
      email: privateFields.email,
      canViewDetails: true
    })
  })
})
