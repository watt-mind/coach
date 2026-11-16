import type { Integration } from '@prisma/client'
import { IntegrationAuthError, IntegrationProviderError } from './integration-errors'

export interface UltrahumanSettings {
  autoSync: boolean
  preferredSyncTime: string // HH:mm format, e.g., "08:00"
  ingestWellness: boolean
}

interface UltrahumanTokenResponse {
  access_token: string
  expires_in: number
  refresh_token: string
  scope: string
  token_type: string
}

/**
 * Retry budget for transient (5xx / network) failures of the Ultrahuman
 * token-refresh endpoint. Mirrors the fitbit/garmin `fetchWithRetry` shape:
 * short in-process backoff here, with Trigger.dev task-level retries
 * (`trigger.config.ts`) and Sentry final-attempt-only reporting
 * (`shouldReportIntegrationErrorToSentry`) as the outer layers.
 */
export const ULTRAHUMAN_TOKEN_REFRESH_MAX_ATTEMPTS = 3
export const ULTRAHUMAN_TOKEN_REFRESH_BASE_DELAY_MS = 1000
export const ULTRAHUMAN_TOKEN_REFRESH_MAX_DELAY_MS = 10_000

export interface UltrahumanRefreshOptions {
  /** Total attempts including the initial request. Defaults to `ULTRAHUMAN_TOKEN_REFRESH_MAX_ATTEMPTS`. */
  maxAttempts?: number
  /** Base delay for exponential backoff. Defaults to `ULTRAHUMAN_TOKEN_REFRESH_BASE_DELAY_MS`. */
  baseDelayMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 5xx from Ultrahuman is an upstream availability blip, not a defect here. */
export function isTransientUltrahumanRefreshStatus(status: number): boolean {
  return status >= 500
}

function getUltrahumanRefreshRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  response?: Response
): number {
  const retryAfter = response?.headers.get('Retry-After')
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, ULTRAHUMAN_TOKEN_REFRESH_MAX_DELAY_MS)
    }
  }
  return Math.min(baseDelayMs * 2 ** (attempt - 1), ULTRAHUMAN_TOKEN_REFRESH_MAX_DELAY_MS)
}

/**
 * Refreshes an expired Ultrahuman access token using the refresh token.
 *
 * A 5xx (or network-level failure) from Ultrahuman's token endpoint is an
 * upstream availability blip, so it is retried in-process with exponential
 * backoff instead of surfacing immediately. Only when the retry budget is
 * exhausted is the integration marked FAILED (with a user-visible reason) and
 * an `IntegrationProviderError` (retryable) thrown, letting Trigger.dev retry
 * the whole task and Sentry report only the persistent failure.
 */
export async function refreshUltrahumanToken(
  integration: Integration,
  options: UltrahumanRefreshOptions = {}
): Promise<Integration> {
  if (!integration.refreshToken) {
    throw new IntegrationAuthError({
      provider: 'ultrahuman',
      integrationId: integration.id,
      code: 'AUTH_MISSING',
      message: 'No refresh token available for Ultrahuman integration'
    })
  }

  const clientId = process.env.ULTRAHUMAN_CLIENT_ID
  const clientSecret = process.env.ULTRAHUMAN_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Ultrahuman credentials not configured')
  }

  console.log('Refreshing Ultrahuman token for integration:', integration.id)

  const maxAttempts = options.maxAttempts ?? ULTRAHUMAN_TOKEN_REFRESH_MAX_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? ULTRAHUMAN_TOKEN_REFRESH_BASE_DELAY_MS

  const tokenRequestBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: integration.refreshToken,
    client_id: clientId,
    client_secret: clientSecret
  }).toString()

  let lastStatus: number | undefined
  let lastStatusText = ''
  let lastErrorText = ''

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response
    try {
      response = await fetch('https://partner.ultrahuman.com/api/partners/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: tokenRequestBody
      })
    } catch (networkError) {
      // Network-level failure (DNS, connection reset, timeout): transient.
      if (attempt < maxAttempts) {
        const waitTime = getUltrahumanRefreshRetryDelayMs(attempt, baseDelayMs)
        console.warn(
          `[Ultrahuman] Token refresh network error (attempt ${attempt}/${maxAttempts}). Retrying in ${waitTime}ms...`,
          networkError
        )
        await sleep(waitTime)
        continue
      }
      await markUltrahumanIntegrationUnavailable(
        integration.id,
        'Ultrahuman is temporarily unavailable. Your integration is still connected — please try syncing again later.'
      )
      throw new IntegrationProviderError({
        provider: 'ultrahuman',
        integrationId: integration.id,
        message: `Ultrahuman token refresh unavailable: network error (${networkError instanceof Error ? networkError.message : String(networkError)})`
      })
    }

    if (response.ok) {
      const tokenData: UltrahumanTokenResponse = await response.json()
      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)
      const { prisma } = await import('./db')

      // Update the integration in the database
      const updatedIntegration = await prisma.integration.update({
        where: { id: integration.id },
        data: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt
        }
      })

      return updatedIntegration
    }

    const errorText = await response.text()

    if (response.status === 400 || response.status === 401) {
      console.error('Ultrahuman token refresh failed:', errorText)
      const { prisma: db } = await import('./db')
      await db.integration.update({
        where: { id: integration.id },
        data: {
          syncStatus: 'FAILED',
          errorMessage: `Refresh token revoked or invalid: ${errorText}`
        }
      })

      throw new IntegrationAuthError({
        provider: 'ultrahuman',
        integrationId: integration.id,
        statusCode: response.status,
        message: `Ultrahuman authorization expired or was revoked. Please reconnect Ultrahuman.`
      })
    }

    if (isTransientUltrahumanRefreshStatus(response.status)) {
      lastStatus = response.status
      lastStatusText = response.statusText
      lastErrorText = errorText
      if (attempt < maxAttempts) {
        const waitTime = getUltrahumanRefreshRetryDelayMs(attempt, baseDelayMs, response)
        console.warn(
          `[Ultrahuman] Token refresh transiently unavailable: ${response.status} ${response.statusText} (attempt ${attempt}/${maxAttempts}). Retrying in ${waitTime}ms...`
        )
        await sleep(waitTime)
        continue
      }
      console.error('Ultrahuman token refresh failed after retries:', errorText)
      await markUltrahumanIntegrationUnavailable(
        integration.id,
        `Ultrahuman is temporarily unavailable (status ${response.status}). Your integration is still connected — please try syncing again later.`
      )
      throw new IntegrationProviderError({
        provider: 'ultrahuman',
        integrationId: integration.id,
        statusCode: response.status,
        message: `Ultrahuman token refresh unavailable: ${response.status} ${response.statusText}`
      })
    }

    console.error('Ultrahuman token refresh failed:', errorText)
    throw new Error(`Failed to refresh Ultrahuman token: ${response.status} ${response.statusText}`)
  }

  // Unreachable: the loop above always returns or throws. Guards against
  // `maxAttempts` misconfiguration (e.g. 0) so a misconfigured budget still
  // surfaces as a transient provider error rather than failing silently.
  await markUltrahumanIntegrationUnavailable(
    integration.id,
    'Ultrahuman is temporarily unavailable. Your integration is still connected — please try syncing again later.'
  )
  throw new IntegrationProviderError({
    provider: 'ultrahuman',
    integrationId: integration.id,
    ...(lastStatus !== undefined ? { statusCode: lastStatus } : {}),
    message: `Ultrahuman token refresh unavailable${lastStatus !== undefined ? `: ${lastStatus} ${lastStatusText}` : ''}${lastErrorText ? ` — ${lastErrorText}` : ''}`
  })
}

/**
 * Marks the integration FAILED with a user-visible reason after the transient
 * retry budget is exhausted. The integration stays connected; the message
 * tells the user to retry later rather than reconnect.
 */
async function markUltrahumanIntegrationUnavailable(
  integrationId: string,
  errorMessage: string
): Promise<void> {
  try {
    const { prisma } = await import('./db')
    await prisma.integration.update({
      where: { id: integrationId },
      data: {
        syncStatus: 'FAILED',
        errorMessage
      }
    })
  } catch (updateError) {
    console.error('[Ultrahuman] Failed to mark integration as temporarily unavailable', {
      integrationId,
      updateError
    })
  }
}

/**
 * Checks if a token is expired or about to expire (within 5 minutes)
 */
function isTokenExpired(integration: Integration): boolean {
  if (!integration.expiresAt) {
    return false // If no expiry is set, assume it's valid
  }

  const now = new Date()
  const expiryWithBuffer = new Date(integration.expiresAt.getTime() - 5 * 60 * 1000) // 5 minutes buffer
  return now >= expiryWithBuffer
}

/**
 * Ensures the integration has a valid access token, refreshing if necessary
 */
async function ensureValidToken(integration: Integration): Promise<Integration> {
  if (isTokenExpired(integration)) {
    console.log('Ultrahuman token expired or expiring soon, refreshing...')
    return await refreshUltrahumanToken(integration)
  }
  return integration
}

// --- Data Fetching ---

/**
 * Fetches daily metrics from Ultrahuman
 * Based on docs: /api/partners/v1/user_data/metrics?date=YYYY-MM-DD
 */
export async function fetchUltrahumanDaily(integration: Integration, date: Date) {
  const validIntegration = await ensureValidToken(integration)
  const dateStr = date.toISOString().split('T')[0]

  const response = await fetch(
    `https://partner.ultrahuman.com/api/partners/v1/user_data/metrics?date=${dateStr}`,
    {
      headers: {
        Authorization: `Bearer ${validIntegration.accessToken}`
      }
    }
  )

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      console.warn(`[Ultrahuman] Unauthorized access to daily data.`)
      return null
    }
    if (response.status === 404) {
      return null // No data for this date
    }

    const errorText = await response.text()
    console.error(`[Ultrahuman] API Error (daily):`, {
      status: response.status,
      statusText: response.statusText,
      error: errorText
    })
    throw new Error(`Ultrahuman API error: ${response.status} ${response.statusText}`)
  }

  const result = await response.json()
  return result
}

export async function fetchUltrahumanProfile(tokenOrIntegration: string | Integration) {
  let accessToken: string
  if (typeof tokenOrIntegration === 'string') {
    accessToken = tokenOrIntegration
  } else {
    const validIntegration = await ensureValidToken(tokenOrIntegration)
    accessToken = validIntegration.accessToken
  }

  const response = await fetch(
    'https://partner.ultrahuman.com/api/partners/v1/user_data/user_info',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  )

  if (!response.ok) {
    throw new Error(`Ultrahuman API error: ${response.status} ${response.statusText}`)
  }

  return await response.json()
}

// --- Normalization ---

export function normalizeUltrahumanWellness(dailyData: any, userId: string, date: Date) {
  if (dailyData?.data) {
    dailyData = dailyData.data
  }

  if (!dailyData || !dailyData.metric_data || !Array.isArray(dailyData.metric_data)) return null

  const metrics: Record<string, any> = {}
  for (const item of dailyData.metric_data) {
    if (item.type && item.object) {
      metrics[item.type] = item.object
    }
  }

  // Sleep Data (Capital S!)
  const sleepObj = metrics['Sleep'] || {}
  const sleepScore = sleepObj.score_trend?.day_avg ?? null

  let sleepSecs = null
  let sleepDeepSecs = null
  let sleepRemSecs = null
  let sleepLightSecs = null
  let sleepAwakeSecs = null

  if (sleepObj.quick_metrics) {
    const totalSleepMetric = sleepObj.quick_metrics.find((m: any) => m.type === 'total_sleep')
    if (totalSleepMetric) {
      sleepSecs = totalSleepMetric.value
    }
  }

  if (sleepObj.sleep_stages) {
    sleepDeepSecs =
      sleepObj.sleep_stages.find((s: any) => s.type === 'deep_sleep')?.stage_time ?? null
    sleepRemSecs =
      sleepObj.sleep_stages.find((s: any) => s.type === 'rem_sleep')?.stage_time ?? null
    sleepLightSecs =
      sleepObj.sleep_stages.find((s: any) => s.type === 'light_sleep')?.stage_time ?? null
    sleepAwakeSecs = sleepObj.sleep_stages.find((s: any) => s.type === 'awake')?.stage_time ?? null
  }

  const sleepHours = sleepSecs ? Math.round((sleepSecs / 3600) * 10) / 10 : null

  // HRV
  // Prefer avg_sleep_hrv if available, otherwise hrv.avg
  const hrv = metrics['avg_sleep_hrv']?.value ?? metrics['hrv']?.avg ?? null

  // Resting HR
  // Prefer night_rhr or sleep_rhr
  const restingHr =
    metrics['night_rhr']?.avg ?? metrics['sleep_rhr']?.value ?? metrics['hr']?.last_reading ?? null

  // Recovery/Readiness
  const recoveryScore = metrics['recovery_index']?.value ?? null
  const readiness = recoveryScore ? Math.round(recoveryScore / 10) : null

  // Body Temp
  const skinTemp = metrics['temp']?.gist_object?.avg ?? metrics['temp']?.last_reading ?? null

  // Movement
  const steps = metrics['steps']?.total ?? null
  // Note: distance and calories not found in sample payload but keeping as fallbacks
  const distance = metrics['distance']?.total ?? null

  // VO2 Max
  const vo2max = metrics['vo2_max']?.value ?? null

  // If we have no significant data, return null to avoid creating empty records
  if (!hrv && !restingHr && !sleepSecs && !sleepScore && !recoveryScore && !steps) {
    return null
  }

  return {
    userId,
    date,
    hrv,
    restingHr: restingHr ? Math.round(restingHr) : null,
    sleepSecs,
    sleepHours,
    sleepScore,
    sleepDeepSecs,
    sleepRemSecs,
    sleepLightSecs,
    sleepAwakeSecs,
    readiness,
    recoveryScore,
    skinTemp,
    vo2max,
    totalCaloriesBurned: metrics['calories']?.total || null,
    activeCaloriesBurned: metrics['calories']?.active || null,
    rawJson: dailyData,
    comments:
      `Ultrahuman: ${steps ? steps + ' steps' : ''}${distance ? ', ' + (distance / 1000).toFixed(1) + 'km' : ''}`.trim()
  }
}
