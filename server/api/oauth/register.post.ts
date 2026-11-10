import {
  assertDcrRateLimit,
  getClientIpFromRequest,
  parseDcrRegistrationBody
} from '../../utils/oauth/dcr-policy'
import {
  findOrCreateCursorMcpApp,
  isCursorCompatibleDcrRequest,
  resolveMcpDcrOwnerId,
  serializeDcrRegistrationResponse
} from '../../utils/oauth/mcp-dcr'

defineRouteMeta({
  openAPI: {
    tags: ['OAuth'],
    summary: 'Dynamic Client Registration',
    description: 'Registers a public OAuth client for MCP integrations (RFC 7591).'
  }
})

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()

  if (config.mcpDcrEnabled !== true) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const ownerId = await resolveMcpDcrOwnerId({
    ownerUserId: config.mcpDcrOwnerUserId,
    ownerEmail: config.mcpDcrOwnerEmail
  })
  if (!ownerId) {
    throw createError({ statusCode: 503, message: 'Dynamic client registration is not configured' })
  }

  const ip = getClientIpFromRequest(
    event.node.req.headers as Record<string, string | string[] | undefined>,
    event.node.req.socket.remoteAddress
  )
  const hourlyLimit = Number(config.mcpDcrRateLimitPerHour || 10)

  try {
    assertDcrRateLimit(ip, hourlyLimit)
  } catch {
    throw createError({
      statusCode: 429,
      message: 'Dynamic client registration rate limit exceeded'
    })
  }

  const body = await readBody(event)

  let registration
  try {
    registration = parseDcrRegistrationBody(body)
  } catch (error) {
    throw createError({
      statusCode: 400,
      message: error instanceof Error ? error.message : 'Invalid registration request'
    })
  }

  if (!isCursorCompatibleDcrRequest(registration.redirectUris)) {
    throw createError({
      statusCode: 400,
      message: 'Unsupported dynamic client redirect URI'
    })
  }

  const app = await findOrCreateCursorMcpApp({
    ownerId,
    redirectUris: registration.redirectUris
  })

  setResponseStatus(event, 201)
  return serializeDcrRegistrationResponse(app)
})
