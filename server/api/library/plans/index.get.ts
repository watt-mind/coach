import { getServerSession } from '../../../utils/session'
import { prisma } from '../../../utils/db'
import {
  getLibraryAccessContext,
  getLibraryOwnerScope,
  getReadableLibraryOwnerIds,
  groupLibraryItemsByOwner,
  parseLibraryScope
} from '../../../utils/library-access'

export default defineEventHandler(async (event) => {
  const session = await getServerSession(event)
  if (!session?.user?.id) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  const userId = session.user.id
  const context = getLibraryAccessContext(session.user)
  const query = getQuery(event)
  const scope = parseLibraryScope(query.scope, 'athlete')
  const folderId = query.folderId as string | undefined
  const type = query.type as string | undefined // 'my', 'team', 'public', 'favorites'

  // 1. Determine base owner IDs for templates
  const ownerIds = getReadableLibraryOwnerIds(context, scope)

  // 2. Fetch user's teams to include team-shared plans if needed
  const userTeams = await prisma.teamMember.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { teamId: true }
  })
  const teamIds = userTeams.map((t) => t.teamId)

  // 3. Build WHERE clause
  const where: any = {
    isTemplate: true
  }

  if (type === 'favorites') {
    // Favorite membership never grants read access: intersect the session
    // user's favorites with the currently readable templates (own scope,
    // PUBLIC, or TEAM with an ACTIVE membership) on every request.
    where.AND = [
      { favorites: { some: { userId } } },
      {
        OR: [
          { userId: { in: ownerIds } },
          { visibility: 'PUBLIC' },
          { visibility: 'TEAM', teamId: { in: teamIds } }
        ]
      }
    ]
  } else if (type === 'team') {
    where.OR = [
      { teamId: { in: teamIds }, visibility: 'TEAM' },
      { userId: { in: ownerIds } } // Coaches still see their own templates
    ]
  } else if (type === 'public') {
    where.visibility = 'PUBLIC'
  } else {
    // Default: filtered by ownerIds (my/coach templates)
    where.userId = { in: ownerIds }
    if (folderId) {
      where.folderId = folderId
    } else if (folderId === null) {
      where.folderId = null
    }
  }

  const templates = await prisma.trainingPlan.findMany({
    where,
    include: {
      goal: { select: { title: true } },
      folder: { select: { name: true } },
      team: { select: { name: true } },
      _count: { select: { blocks: true } },
      favorites: {
        where: { userId },
        select: { id: true }
      }
    },
    orderBy: [{ createdAt: 'desc' }]
  })

  const annotated = templates.map((template: any) => ({
    ...template,
    isFavorite: template.favorites.length > 0,
    ownerUserId: template.userId,
    ownerScope: getLibraryOwnerScope(context, template.userId),
    isEditable: template.userId === userId
  }))

  if (scope === 'all' && !type && !folderId) {
    return groupLibraryItemsByOwner(context, annotated)
  }

  return annotated
})
