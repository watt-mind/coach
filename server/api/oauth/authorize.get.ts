import { prisma } from '../../utils/db'
import { getServerSession } from '../../utils/session'
import { parseScopeString, validateMcpOAuthScopes } from '../../utils/oauth/scopes'
import { assertMcpResource, isMcpResourceRequest } from '../../utils/oauth/resource'
import { issueAuthorizationCodeRedirect } from '../../utils/oauth/issue-authorization-code'

defineRouteMeta({
  openAPI: {
    tags: ['OAuth'],
    summary: 'Authorize OAuth Application',
    description:
      'Initiates the OAuth 2.0 authorization code flow. Official apps skip consent when the user is signed in; other apps redirect to the consent screen.'
  }
})

function buildAuthorizeApiPath(query: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== '') {
      params.set(key, value)
    }
  }
  return `/api/oauth/authorize?${params.toString()}`
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const siteUrl = config.public.siteUrl
  const query = getQuery(event)
  const responseType = query.response_type as string
  const clientId = query.client_id as string
  const redirectUri = query.redirect_uri as string
  const scope = query.scope as string
  const state = query.state as string
  const prompt = query.prompt as string
  const action = query.action as string
  const codeChallenge = query.code_challenge as string
  const codeChallengeMethod = query.code_challenge_method as string
  const resource = query.resource as string

  if (!responseType || !clientId || !redirectUri) {
    throw createError({
      statusCode: 400,
      message:
        'Missing required parameters: response_type, client_id, and redirect_uri are required.'
    })
  }

  if (responseType !== 'code') {
    throw createError({
      statusCode: 400,
      message: 'Unsupported response_type. Only "code" is supported.'
    })
  }

  const app = await prisma.oAuthApp.findUnique({
    where: { clientId }
  })

  if (!app) {
    throw createError({ statusCode: 400, message: 'Invalid client_id.' })
  }

  if (!app.redirectUris.includes(redirectUri)) {
    throw createError({
      statusCode: 400,
      message:
        'The redirect_uri provided does not match any registered redirect URIs for this application.'
    })
  }

  // `/oauth/login` uses this branch to complete a user cancellation without
  // requiring a web session. The app and redirect have already been validated
  // above, so the browser never gets to choose an arbitrary destination.
  if (action === 'deny') {
    const errorUrl = new URL(redirectUri)
    errorUrl.searchParams.set('error', 'access_denied')
    errorUrl.searchParams.set('error_description', 'The user cancelled sign-in.')
    if (state) errorUrl.searchParams.set('state', state)
    return sendRedirect(event, errorUrl.toString(), 303)
  }

  const isMcpFlow = isMcpResourceRequest(resource, siteUrl)

  if (isMcpFlow) {
    if (!codeChallenge) {
      throw createError({
        statusCode: 400,
        message: 'PKCE code_challenge is required for MCP authorization.'
      })
    }
    if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
      throw createError({
        statusCode: 400,
        message: 'Only S256 PKCE is supported for MCP authorization.'
      })
    }

    try {
      assertMcpResource(resource, siteUrl)
      const scopes = parseScopeString(scope)
      if (scopes.length > 0) {
        validateMcpOAuthScopes(scopes)
      }
    } catch (error) {
      throw createError({
        statusCode: 400,
        message: error instanceof Error ? error.message : 'Invalid MCP authorization request'
      })
    }
  }

  // First-party official apps normally skip consent when already signed in.
  // `prompt=login` is sent by native clients when the athlete explicitly starts
  // a new login. Preserve that interaction request so the hosted login page can
  // offer the current account alongside alternate providers instead of silently
  // issuing another code for the browser cookie's account.
  if (app.isOfficial && prompt !== 'consent') {
    const session = prompt === 'login' ? null : await getServerSession(event)

    if (session?.user?.id) {
      const location = await issueAuthorizationCodeRedirect({
        app,
        userId: session.user.id,
        redirectUri,
        scope,
        state,
        resource,
        codeChallenge,
        codeChallengeMethod: isMcpFlow ? 'S256' : codeChallengeMethod,
        siteUrl
      })
      return sendRedirect(event, location)
    }

    const authorizePath = buildAuthorizeApiPath({
      response_type: responseType,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scope || (isMcpFlow ? '' : 'profile:read'),
      state,
      // `prompt=login` has been fulfilled by sending the athlete to this page.
      // Keeping it in the post-provider callback would route back here forever.
      prompt: prompt === 'login' ? undefined : prompt,
      resource,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallenge
        ? isMcpFlow
          ? 'S256'
          : codeChallengeMethod || 'S256'
        : undefined
    })
    const loginUrl = new URL('/oauth/login', siteUrl)
    loginUrl.searchParams.set('callbackUrl', authorizePath)
    return sendRedirect(event, loginUrl.toString())
  }

  const consentUrl = new URL('/oauth/authorize', siteUrl)
  consentUrl.searchParams.set('client_id', clientId)
  consentUrl.searchParams.set('redirect_uri', redirectUri)
  consentUrl.searchParams.set('scope', scope || (isMcpFlow ? '' : 'profile:read'))
  if (state) consentUrl.searchParams.set('state', state)
  if (prompt) consentUrl.searchParams.set('prompt', prompt)
  if (resource) consentUrl.searchParams.set('resource', resource)
  if (codeChallenge) {
    consentUrl.searchParams.set('code_challenge', codeChallenge)
    consentUrl.searchParams.set(
      'code_challenge_method',
      isMcpFlow ? 'S256' : codeChallengeMethod || 'S256'
    )
  }

  return sendRedirect(event, consentUrl.toString())
})
