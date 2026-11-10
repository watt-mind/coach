import { z } from 'zod'
import { oauthRepository } from '../../utils/repositories/oauthRepository'
import { normalizeResourceUrl } from '../../utils/oauth/resource'

defineRouteMeta({
  openAPI: {
    tags: ['OAuth'],
    summary: 'Exchange Code for Token',
    description: 'Exchanges an authorization code or refresh token for an access token.'
  }
})

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const {
    grant_type,
    code,
    redirect_uri,
    client_id,
    client_secret,
    refresh_token,
    code_verifier,
    resource
  } = body

  if (grant_type === 'authorization_code') {
    if (!code || !client_id) {
      return sendOAuthError(event, 'invalid_request', 'Missing code or client_id')
    }

    const authCode = await oauthRepository.getAuthCode(code)
    if (!authCode) {
      return sendOAuthError(event, 'invalid_grant', 'Invalid authorization code')
    }

    if (authCode.expiresAt < new Date()) {
      await oauthRepository.deleteAuthCode(code)
      return sendOAuthError(event, 'invalid_grant', 'Authorization code expired')
    }

    const app = authCode.app
    if (app.clientId !== client_id) {
      return sendOAuthError(event, 'invalid_client', 'Client ID mismatch')
    }

    if (redirect_uri && redirect_uri !== authCode.redirectUri) {
      return sendOAuthError(event, 'invalid_grant', 'Redirect URI mismatch')
    }

    const isMcpCode = !!authCode.resource

    if (client_secret) {
      const isValid = await oauthRepository.verifyClient(client_id, client_secret)
      if (!isValid) {
        return sendOAuthError(event, 'invalid_client', 'Invalid client secret')
      }
    } else if (!authCode.codeChallenge && !app.isPublicClient) {
      return sendOAuthError(event, 'invalid_client', 'Client secret required for non-PKCE flow')
    }

    if (authCode.codeChallenge) {
      if (!code_verifier) {
        return sendOAuthError(event, 'invalid_request', 'code_verifier is required for PKCE')
      }

      const crypto = await import('node:crypto')
      let expectedChallenge: string
      if (authCode.codeChallengeMethod === 'S256') {
        expectedChallenge = crypto.createHash('sha256').update(code_verifier).digest('base64url')
      } else if (isMcpCode) {
        return sendOAuthError(event, 'invalid_grant', 'Only S256 PKCE is supported for MCP tokens')
      } else {
        expectedChallenge = code_verifier
      }

      if (expectedChallenge !== authCode.codeChallenge) {
        return sendOAuthError(event, 'invalid_grant', 'Invalid code_verifier')
      }
    }

    if (isMcpCode) {
      const requestResource = resource ? normalizeResourceUrl(resource) : null
      if (!requestResource || requestResource !== authCode.resource) {
        return sendOAuthError(event, 'invalid_target', 'Resource mismatch')
      }
    }

    const includeRefreshToken = authCode.scopes.includes('offline_access')

    const token = await oauthRepository.createToken({
      appId: app.id,
      userId: authCode.userId,
      scopes: authCode.scopes,
      resource: authCode.resource || undefined,
      includeRefreshToken
    })

    await oauthRepository.deleteAuthCode(code)

    return serializeTokenResponse(token, includeRefreshToken)
  }

  if (grant_type === 'refresh_token') {
    if (!refresh_token || !client_id) {
      return sendOAuthError(event, 'invalid_request', 'Missing refresh_token or client_id')
    }

    if (client_secret) {
      const isValid = await oauthRepository.verifyClient(client_id, client_secret)
      if (!isValid) {
        return sendOAuthError(event, 'invalid_client', 'Invalid client secret')
      }
    }

    const requestResource = resource ? normalizeResourceUrl(resource) : undefined

    try {
      const newToken = await oauthRepository.rotateRefreshToken(refresh_token, {
        clientId: client_id,
        resource: requestResource || undefined
      })
      if (!newToken) {
        return sendOAuthError(event, 'invalid_grant', 'Invalid or expired refresh token')
      }

      return serializeTokenResponse(newToken)
    } catch (error) {
      return sendOAuthError(
        event,
        'invalid_grant',
        error instanceof Error ? error.message : 'Refresh token rejected'
      )
    }
  }

  return sendOAuthError(event, 'unsupported_grant_type', 'Unsupported grant type')
})

function sendOAuthError(event: any, error: string, description: string) {
  setResponseStatus(event, 400)
  return {
    error,
    error_description: description
  }
}

function serializeTokenResponse(
  token: {
    accessToken: string
    refreshToken: string | null
    refreshTokenExpiresAt: Date | null
    scopes: string[]
    resource?: string | null
  },
  includeRefreshToken = true
) {
  const response: Record<string, unknown> = {
    access_token: token.accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: token.scopes.join(' ')
  }

  if (includeRefreshToken && token.refreshToken) {
    response.refresh_token = token.refreshToken
  }

  if (includeRefreshToken && token.refreshTokenExpiresAt) {
    response.refresh_token_expires_in = Math.max(
      0,
      Math.floor((token.refreshTokenExpiresAt.getTime() - Date.now()) / 1000)
    )
  }

  if (token.resource) {
    response.resource = token.resource
  }

  return response
}
