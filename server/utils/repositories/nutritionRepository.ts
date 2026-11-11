import { prisma } from '../db'
import { Prisma } from '@prisma/client'

/** Sentinel returned by `updateWithVersionCheck` when the row changed since it was read. */
export const CONCURRENT_UPDATE_CONFLICT = Symbol('CONCURRENT_UPDATE_CONFLICT')

export const nutritionRepository = {
  /**
   * Get nutrition entries for a user
   */
  async getForUser(
    userId: string,
    options: {
      startDate?: Date
      endDate?: Date
      limit?: number
      offset?: number
      orderBy?: Prisma.NutritionOrderByWithRelationInput
      select?: Prisma.NutritionSelect
      where?: Prisma.NutritionWhereInput
    } = {}
  ) {
    const where: Prisma.NutritionWhereInput = {
      userId,
      date: {
        gte: options.startDate,
        lte: options.endDate
      },
      ...options.where
    }

    return prisma.nutrition.findMany({
      where,
      take: options.limit,
      skip: options.offset,
      orderBy: options.orderBy || { date: 'desc' },
      select: options.select
    })
  },

  /**
   * Get a single nutrition entry by ID
   */
  async getByIdInternal(nutritionId: string) {
    return prisma.nutrition.findUnique({
      where: { id: nutritionId }
    })
  },

  /**
   * Get a single nutrition entry by ID, ensuring it belongs to the user
   */
  async getById(nutritionId: string, userId: string) {
    return prisma.nutrition
      .findUnique({
        where: {
          id: nutritionId
        }
      })
      .then((nutrition) => {
        if (nutrition && nutrition.userId === userId) {
          return nutrition
        }
        return null
      })
  },

  /**
   * Get nutrition entry by date for a user
   */
  async getByDate(userId: string, date: Date) {
    return prisma.nutrition.findUnique({
      where: {
        userId_date: {
          userId,
          date
        }
      }
    })
  },

  /**
   * Get total count of nutrition entries for a user
   */
  async count(
    userId: string,
    options: {
      startDate?: Date
      endDate?: Date
      where?: Prisma.NutritionWhereInput
    } = {}
  ) {
    const where: Prisma.NutritionWhereInput = {
      userId,
      date: {
        gte: options.startDate,
        lte: options.endDate
      },
      ...options.where
    }

    return prisma.nutrition.count({ where })
  },

  /**
   * Get the most recent nutrition entry for a user
   */
  async getMostRecent(userId: string) {
    return prisma.nutrition.findFirst({
      where: {
        userId
      },
      orderBy: { date: 'desc' }
    })
  },

  /**
   * Get nutrition entries pending analysis
   */
  async getPendingAnalysis(userId: string, endDate?: Date) {
    return prisma.nutrition.findMany({
      where: {
        userId,
        date: endDate ? { lte: endDate } : undefined,
        OR: [
          { aiAnalysisStatus: null },
          { aiAnalysisStatus: 'NOT_STARTED' },
          { aiAnalysisStatus: 'PENDING' },
          { aiAnalysisStatus: 'FAILED' },
          { aiAnalysisStatus: 'QUOTA_EXCEEDED' }
        ]
      },
      select: {
        id: true,
        date: true,
        aiAnalysisStatus: true
      },
      orderBy: {
        date: 'desc'
      }
    })
  },

  /**
   * Create a new nutrition entry
   */
  async create(data: Prisma.NutritionUncheckedCreateInput) {
    return prisma.nutrition.create({
      data
    })
  },

  /**
   * Update a nutrition entry by ID
   */
  async update(id: string, data: Prisma.NutritionUpdateInput) {
    return prisma.nutrition.update({
      where: { id },
      data
    })
  },

  /**
   * Update a nutrition entry with an optimistic concurrency check.
   *
   * The caller must pass the `updatedAt` value it originally read the row with.
   * The write is executed inside a transaction and its `where` clause includes
   * that `updatedAt`, so if another request modified the row in between, zero
   * rows match and Prisma raises `P2025` ("record not found"). We translate that
   * into a `CONCURRENT_UPDATE_CONFLICT` sentinel instead of throwing, so callers
   * can surface a clear 409 rather than silently losing the concurrent write.
   *
   * All item mutations (add/update/delete/move) should merge every field they
   * intend to change — meal arrays and recalculated totals alike — into a
   * single `data` payload passed here, so the entire mutation lands in one
   * atomic statement instead of a sequence of separate reads/writes that a
   * concurrent request could interleave with.
   */
  async updateWithVersionCheck(
    id: string,
    expectedUpdatedAt: Date,
    data: Prisma.NutritionUpdateInput
  ) {
    try {
      return await prisma.$transaction(async (tx) => {
        return tx.nutrition.update({
          where: { id, updatedAt: expectedUpdatedAt },
          data
        })
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return CONCURRENT_UPDATE_CONFLICT
      }
      throw error
    }
  },

  /** Persist a merged upload only if its snapshot is still current, including absence. */
  async saveWithVersionCheck(
    userId: string,
    date: Date,
    snapshot: { id: string; updatedAt: Date } | null,
    data: Prisma.NutritionUncheckedUpdateInput,
    source: string
  ) {
    try {
      if (!snapshot) {
        // A unique (userId, date) constraint arbitrates concurrent first uploads.
        return await prisma.nutrition.create({
          data: {
            ...data,
            userId,
            date,
            sourcePrecedence: source
          } as Prisma.NutritionUncheckedCreateInput
        })
      }
      return await prisma.nutrition.update({
        where: { id: snapshot.id, userId, date, updatedAt: snapshot.updatedAt },
        data: {
          ...data,
          sourcePrecedence: source,
          // Ensure a successful upload invalidates its snapshot even within one millisecond.
          updatedAt: new Date(Math.max(Date.now(), snapshot.updatedAt.getTime() + 1))
        }
      })
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === (snapshot ? 'P2025' : 'P2002')
      ) {
        return CONCURRENT_UPDATE_CONFLICT
      }
      throw error
    }
  },

  /**
   * Update analysis status
   */
  async updateStatus(id: string, status: string) {
    return prisma.nutrition.update({
      where: { id },
      data: { aiAnalysisStatus: status }
    })
  },

  /**
   * Update many nutrition entries
   */
  async updateMany(
    where: Prisma.NutritionWhereInput,
    data: Prisma.NutritionUpdateManyMutationInput
  ) {
    return prisma.nutrition.updateMany({
      where,
      data
    })
  },

  /**
   * Upsert a nutrition entry
   * Returns the record and a boolean indicating if it was created (isNew)
   */
  async upsert(
    userId: string,
    date: Date,
    createData: Prisma.NutritionUncheckedCreateInput,
    updateData: Prisma.NutritionUncheckedUpdateInput,
    source?: string
  ) {
    const existing = await this.getByDate(userId, date)

    // Ensure source is set in the data if provided
    if (source) {
      ;(createData as any).sourcePrecedence = source
      ;(updateData as any).sourcePrecedence = source
    }

    const record = await prisma.nutrition.upsert({
      where: {
        userId_date: {
          userId,
          date
        }
      },
      create: createData,
      update: updateData
    })

    return {
      record,
      isNew: !existing
    }
  }
}
