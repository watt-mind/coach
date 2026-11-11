import type { Prisma } from '@prisma/client'
import { prisma } from '../db'
import bcrypt from 'bcrypt'
import { v4 as uuidv4 } from 'uuid'
import { validateRedirectUris } from '../oauth/redirect-uri'
import { mcpMetrics } from '../mcp/metrics'

/**
 * Repository for managing OAuth 2.0 applications and related entities.
 */
export const oauthRepository = {
  async listAppsForUser(userId: string) {
    return prisma.oAuthApp.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        sourceName: true,
        description: true,
        homepageUrl: true,
        logoUrl: true,
        clientId: true,
        redirectUris: true,
        isTrusted: true,
        isOfficial: true,
        isPublic: true,
        isPublicClient: true,
        registrationType: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            tokens: true,
            consents: true
          }
        }
      }
    })
  },

  async getApp(id: string) {
    return prisma.oAuthApp.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    })
  },

  async createApp(
    userId: string,
    data: {
      name: string
      sourceName?: string
      description?: string
      homepageUrl?: string
      redirectUris: string[]
    }
  ) {
    const secret = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '')
    const hashedSecret = await bcrypt.hash(secret, 12)

    const app = await prisma.oAuthApp.create({
      data: {
        name: data.name,
        sourceName: data.sourceName,
        description: data.description,
        homepageUrl: data.homepageUrl,
        redirectUris: data.redirectUris,
        clientSecret: hashedSecret,
        ownerId: userId
      }
    })

    return {
      ...app,
      clientSecret: secret
    }
  },

  async createPublicMcpClient(data: {
    ownerId: string
    name: string
    redirectUris: string[]
    description?: string
    homepageUrl?: string
  }) {
    const redirectUris = validateRedirectUris(data.redirectUris)
    const secret = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '')
    const hashedSecret = await bcrypt.hash(secret, 12)

    return prisma.oAuthApp.create({
      data: {
        name: data.name,
        description: data.description || 'Pre-registered MCP client for Cursor',
        homepageUrl: data.homepageUrl,
        redirectUris,
        clientSecret: hashedSecret,
        ownerId: data.ownerId,
        isPublicClient: true,
        registrationType: 'manual'
      },
      select: {
        id: true,
        clientId: true,
        name: true,
        redirectUris: true,
        isPublicClient: true,
        registrationType: true,
        createdAt: true
      }
    })
  },

  async registerPublicClient(data: {
    ownerId: string
    name: string
    redirectUris: string[]
    clientUri?: string
    logoUri?: string
  }) {
    const redirectUris = validateRedirectUris(data.redirectUris)
    const secret = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '')
    const hashedSecret = await bcrypt.hash(secret, 12)

    return prisma.oAuthApp.create({
      data: {
        name: data.name,
        description: 'Dynamically registered MCP client',
        homepageUrl: data.clientUri,
        logoUrl: data.logoUri,
        redirectUris,
        clientSecret: hashedSecret,
        ownerId: data.ownerId,
        isPublicClient: true,
        registrationType: 'dcr'
      },
      select: {
        clientId: true,
        name: true,
        redirectUris: true,
        createdAt: true,
        registrationType: true,
        isPublicClient: true
      }
    })
  },

  async updateApp(
    id: string,
    userId: string,
    data: {
      name?: string
      sourceName?: string | null
      description?: string
      homepageUrl?: string
      logoUrl?: string
      redirectUris?: string[]
      webhookSecret?: string | null
      isPublic?: boolean
    }
  ) {
    const result = await prisma.oAuthApp.updateMany({
      where: { id, ownerId: userId },
      data
    })

    if (result.count === 0) {
      throw new Error('App not found or you do not have permission to update it')
    }

    return prisma.oAuthApp.findUnique({ where: { id } })
  },

  async deleteApp(id: string, userId: string) {
    const result = await prisma.oAuthApp.deleteMany({
      where: { id, ownerId: userId }
    })

    if (result.count === 0) {
      throw new Error('App not found or you do not have permission to delete it')
    }

    return true
  },

  async regenerateSecret(id: string, userId: string) {
    const secret = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '')
    const hashedSecret = await bcrypt.hash(secret, 12)

    const result = await prisma.oAuthApp.updateMany({
      where: { id, ownerId: userId },
      data: {
        clientSecret: hashedSecret
      }
    })

    if (result.count === 0) {
      throw new Error('App not found or you do not have permission to modify it')
    }

    return secret
  },

  async regenerateWebhookSecret(id: string, userId: string) {
    const secret = 'wh_' + uuidv4().replace(/-/g, '')

    const result = await prisma.oAuthApp.updateMany({
      where: { id, ownerId: userId },
      data: {
        webhookSecret: secret
      }
    })

    if (result.count === 0) {
      throw new Error('App not found or you do not have permission to modify it')
    }

    return secret
  },

  async verifyClient(clientId: string, clientSecret: string) {
    const app = await prisma.oAuthApp.findUnique({
      where: { clientId }
    })

    if (!app) return null
    if (app.isPublicClient) return null

    const isValid = await bcrypt.compare(clientSecret, app.clientSecret)
    return isValid ? app : null
  },

  async createAuthCode(data: {
    appId: string
    userId: string
    redirectUri: string
    scopes: string[]
    resource?: string
    codeChallenge?: string
    codeChallengeMethod?: string
  }) {
    const crypto = await import('node:crypto')
    const code = crypto.randomBytes(32).toString('hex')

    return prisma.oAuthAuthCode.create({
      data: {
        code,
        appId: data.appId,
        userId: data.userId,
        redirectUri: data.redirectUri,
        scopes: data.scopes,
        resource: data.resource,
        codeChallenge: data.codeChallenge,
        codeChallengeMethod: data.codeChallengeMethod || 'S256',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      }
    })
  },

  async getAuthCode(code: string) {
    return prisma.oAuthAuthCode.findUnique({
      where: { code },
      include: {
        app: true,
        user: true
      }
    })
  },

  async deleteAuthCode(code: string) {
    try {
      return await prisma.oAuthAuthCode.delete({
        where: { code }
      })
    } catch {
      return null
    }
  },

  async redeemAuthCode(
    code: string,
    data: {
      appId: string
      userId: string
      scopes: string[]
      resource?: string
      includeRefreshToken?: boolean
    }
  ) {
    return prisma.$transaction(async (tx) => {
      // The conditional delete is the database-enforced single-use claim.
      // A failed token/consent write rolls it back with the rest of the exchange.
      const claimed = await tx.oAuthAuthCode.deleteMany({
        where: { code, appId: data.appId, userId: data.userId, expiresAt: { gt: new Date() } }
      })
      if (claimed.count === 0) return null
      return this.createToken(data, tx)
    })
  },

  async createToken(
    data: {
      appId: string
      userId: string
      scopes: string[]
      resource?: string
      includeRefreshToken?: boolean
    },
    db: Prisma.TransactionClient = prisma
  ) {
    const crypto = await import('node:crypto')
    const accessToken = crypto.randomBytes(32).toString('hex')
    const refreshToken =
      data.includeRefreshToken === false ? null : crypto.randomBytes(32).toString('hex')

    await db.oAuthConsent.upsert({
      where: {
        userId_appId: {
          userId: data.userId,
          appId: data.appId
        }
      },
      create: {
        userId: data.userId,
        appId: data.appId,
        scopes: data.scopes
      },
      update: {
        scopes: data.scopes
      }
    })

    return db.oAuthToken.create({
      data: {
        accessToken,
        refreshToken,
        appId: data.appId,
        userId: data.userId,
        scopes: data.scopes,
        resource: data.resource,
        accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        refreshTokenExpiresAt: data.resource ? new Date(Date.now() + 90 * 24 * 3600 * 1000) : null
      }
    })
  },

  async getAccessToken(token: string) {
    return prisma.oAuthToken.findUnique({
      where: { accessToken: token },
      include: {
        user: true,
        app: true
      }
    })
  },

  async rotateRefreshToken(
    refreshToken: string,
    options?: { clientId?: string; resource?: string }
  ) {
    const oldToken = await prisma.oAuthToken.findUnique({
      where: { refreshToken },
      include: { app: true }
    })

    if (!oldToken || !oldToken.refreshToken) {
      return null
    }

    if (oldToken.refreshTokenExpiresAt && oldToken.refreshTokenExpiresAt < new Date()) {
      await prisma.oAuthToken.delete({ where: { id: oldToken.id } })
      return null
    }

    if (options?.clientId && oldToken.app.clientId !== options.clientId) {
      throw new Error('Client mismatch')
    }

    if (oldToken.resource) {
      if (!options?.resource || options.resource !== oldToken.resource) {
        throw new Error('Resource mismatch')
      }

      if (oldToken.refreshTokenRotatedAt) {
        await prisma.oAuthToken.deleteMany({
          where: {
            appId: oldToken.appId,
            userId: oldToken.userId,
            resource: oldToken.resource
          }
        })
        mcpMetrics.recordRefreshReuseDetected()
        throw new Error('Refresh token reuse detected')
      }

      const crypto = await import('node:crypto')
      const accessToken = crypto.randomBytes(32).toString('hex')
      const nextRefreshToken = crypto.randomBytes(32).toString('hex')

      return prisma.$transaction(async (tx) => {
        const current = await tx.oAuthToken.findUnique({ where: { refreshToken } })
        if (!current) {
          return null
        }

        const claimed = await tx.oAuthToken.updateMany({
          where: {
            id: current.id,
            refreshTokenRotatedAt: null
          },
          data: {
            refreshTokenRotatedAt: new Date(),
            accessTokenExpiresAt: new Date(0)
          }
        })

        if (claimed.count === 0) {
          await tx.oAuthToken.deleteMany({
            where: {
              appId: current.appId,
              userId: current.userId,
              resource: current.resource
            }
          })
          mcpMetrics.recordRefreshReuseDetected()
          throw new Error('Refresh token reuse detected')
        }

        const newToken = await tx.oAuthToken.create({
          data: {
            accessToken,
            refreshToken: nextRefreshToken,
            appId: current.appId,
            userId: current.userId,
            scopes: current.scopes,
            resource: current.resource,
            accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
            refreshTokenExpiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
            lastUsedAt: new Date()
          }
        })

        return newToken
      })
    }

    const crypto = await import('node:crypto')
    const accessToken = crypto.randomBytes(32).toString('hex')

    return prisma.oAuthToken.update({
      where: { id: oldToken.id },
      data: {
        accessToken,
        accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        lastUsedAt: new Date()
      }
    })
  },

  async revokeToken(token: string) {
    const byAccess = await prisma.oAuthToken.findUnique({ where: { accessToken: token } })
    if (byAccess) {
      return prisma.oAuthToken.delete({ where: { id: byAccess.id } })
    }
    const byRefresh = await prisma.oAuthToken.findUnique({ where: { refreshToken: token } })
    if (byRefresh) {
      return prisma.oAuthToken.delete({ where: { id: byRefresh.id } })
    }
    return null
  }
}
