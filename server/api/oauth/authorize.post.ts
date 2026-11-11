import { getServerSession } from '../../utils/session'
import { prisma } from '../../utils/db'
import { isMcpResourceRequest } from '../../utils/oauth/resource'
import { issueAuthorizationCodeRedirect } from '../../utils/oauth/issue-authorization-code'

function normalizeBodyValue(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function normalizePayloadString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function normalizeAuthorizeBody(body: unknown) {
  if (typeof body === 'string') {
    return Object.fromEntries(new URLSearchParams(body).entries())
  }

  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries())
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return Object.fromEntries(
      Array.from(body.entries()).map(([key, value]) => [key, normalizeBodyValue(value)])
    )
  }

  return body && typeof body === 'object' ? body : {}
}

defineRouteMeta({
  openAPI: {
    tags: ['OAuth'],
    summary: 'Approve Authorization Request',
    description: 'Called by the consent screen to approve or deny an authorization request.'
  }
})

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const siteUrl = config.public.siteUrl
  const session = await getServerSession(event)
  const userId = session?.user?.id
  if (!userId) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  if (session.user?.deactivatedAt) {
    throw createError({ statusCode: 403, message: 'Account deactivated' })
  }
  const body = normalizeAuthorizeBody(await readBody(event))
  const query = getQuery(event)
  const payload = {
    ...query,
    ...body
  }
  const client_id = normalizePayloadString(payload.client_id)
  const redirect_uri = normalizePayloadString(payload.redirect_uri)
  const scope = normalizePayloadString(payload.scope)
  const state = normalizePayloadString(payload.state)
  const code_challenge = normalizePayloadString(payload.code_challenge)
  const code_challenge_method = normalizePayloadString(payload.code_challenge_method)
  const resource = normalizePayloadString(payload.resource)
  const action = normalizePayloadString(payload.action)

  if (!client_id || !redirect_uri || !action) {
    throw createError({ statusCode: 400, message: 'Missing required fields.' })
  }

  const app = await prisma.oAuthApp.findUnique({
    where: { clientId: client_id }
  })

  if (!app) {
    throw createError({ statusCode: 400, message: 'Invalid client_id.' })
  }

  if (!app.redirectUris.includes(redirect_uri)) {
    throw createError({
      statusCode: 400,
      message:
        'The redirect_uri provided does not match any registered redirect URIs for this application.'
    })
  }

  const isMcpFlow = isMcpResourceRequest(resource, siteUrl)

  if (isMcpFlow) {
    if (!code_challenge) {
      throw createError({
        statusCode: 400,
        message: 'PKCE code_challenge is required for MCP authorization.'
      })
    }
    if (code_challenge_method && code_challenge_method !== 'S256') {
      throw createError({
        statusCode: 400,
        message: 'Only S256 PKCE is supported for MCP authorization.'
      })
    }
  }

  // Handle Denial
  if (action !== 'approve') {
    const errorUrl = new URL(redirect_uri)
    errorUrl.searchParams.set('error', 'access_denied')
    errorUrl.searchParams.set('error_description', 'The user denied the request.')
    if (state) errorUrl.searchParams.set('state', state)

    return sendRedirect(event, errorUrl.toString(), 303)
  }

  const location = await issueAuthorizationCodeRedirect({
    app,
    userId,
    redirectUri: redirect_uri,
    scope,
    state,
    resource,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    siteUrl
  })

  return sendRedirect(event, location, 303)
})
