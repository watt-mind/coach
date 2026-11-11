import type { Integration } from '@prisma/client'
import { prisma } from './db'

interface StravaTokenResponse {
  token_type: string
  expires_at: number
  expires_in: number
  refresh_token: string
  access_token: string
  athlete: {
    id: number
    username?: string
    firstname: string
    lastname: string
  }
}

/**
 * Refreshes an expired Strava access token using the refresh token
 */
export async function refreshStravaToken(integration: Integration): Promise<Integration> {
  if (!integration.refreshToken) {
    throw new Error('No refresh token available for Strava integration')
  }

  const clientId = process.env.STRAVA_CLIENT_ID
  const clientSecret = process.env.STRAVA_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Strava credentials not configured')
  }

  console.log('Refreshing Strava token for integration:', integration.id)

  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: integration.refreshToken
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('Strava token refresh failed:', errorText)
    throw new Error(`Failed to refresh Strava token: ${response.status} ${response.statusText}`)
  }

  const tokenData: StravaTokenResponse = await response.json()
  const expiresAt = new Date(tokenData.expires_at * 1000) // Strava returns unix timestamp in seconds

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
    console.log('Strava token expired or expiring soon, refreshing...')
    return await refreshStravaToken(integration)
  }
  return integration
}

interface StravaActivity {
  id: number
  name: string
  distance: number
  moving_time: number
  elapsed_time: number
  total_elevation_gain: number
  type: string
  sport_type: string
  start_date: string
  start_date_local: string
  timezone: string
  achievement_count: number
  kudos_count: number
  comment_count: number
  athlete_count: number
  photo_count: number
  trainer: boolean
  commute: boolean
  manual: boolean
  private: boolean
  flagged: boolean
  gear_id?: string
  average_speed: number
  max_speed: number
  average_cadence?: number
  average_temp?: number
  average_watts?: number
  weighted_average_watts?: number
  kilojoules?: number
  device_watts?: boolean
  has_heartrate: boolean
  average_heartrate?: number
  max_heartrate?: number
  max_watts?: number
  elev_high?: number
  elev_low?: number
  upload_id?: number
  external_id?: string
  pr_count?: number
  suffer_score?: number
  has_kudoed: boolean
  description?: string
  calories?: number
  device_name?: string
  embed_token?: string
  updated_at?: string
  [key: string]: any
}

interface StravaAthlete {
  id: number
  username?: string
  resource_state: number
  firstname: string
  lastname: string
  bio?: string
  city?: string
  state?: string
  country?: string
  sex?: string
  premium?: boolean
  summit?: boolean
  created_at: string
  updated_at: string
  badge_type_id: number
  weight?: number
  profile_medium?: string
  profile?: string
  friend?: any
  follower?: any
  [key: string]: any
}

interface StravaStream {
  type: string
  data: number[] | [number, number][] // Most are number[], latlng is [lat, lng][]
  series_type: string // 'time' or 'distance'
  original_size: number
  resolution: string // 'low', 'medium', 'high'
}

/**
 * Fetch Strava activities for a date range
 */
export async function fetchStravaActivities(
  integration: Integration,
  startDate: Date,
  endDate: Date
): Promise<StravaActivity[]> {
  // Ensure we have a valid token before making the request
  const validIntegration = await ensureValidToken(integration)

  const url = new URL('https://www.strava.com/api/v3/athlete/activities')

  // Strava uses unix timestamps (seconds)
  url.searchParams.set('after', Math.floor(startDate.getTime() / 1000).toString())
  url.searchParams.set('before', Math.floor(endDate.getTime() / 1000).toString())
  url.searchParams.set('per_page', '200') // Max per page

  const allActivities: StravaActivity[] = []
  let page = 1

  while (true) {
    url.searchParams.set('page', page.toString())

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${validIntegration.accessToken}`
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Strava API Error Response:', errorText)
      throw new Error(`Strava API error: ${response.status} ${response.statusText}`)
    }

    const activities: StravaActivity[] = await response.json()

    if (activities.length === 0) {
      break // No more activities
    }

    allActivities.push(...activities)

    if (activities.length < 200) {
      break // Last page
    }

    page++
  }

  return allActivities
}

/**
 * Fetch detailed activity with streams (heart rate, power, etc.)
 */
export async function fetchStravaActivityDetails(
  integration: Integration,
  activityId: number
): Promise<StravaActivity> {
  const validIntegration = await ensureValidToken(integration)

  const response = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: {
      Authorization: `Bearer ${validIntegration.accessToken}`
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Strava API error: ${response.status} ${errorText}`)
  }

  return await response.json()
}

/**
 * Fetch the authenticated athlete's profile
 */
export async function fetchStravaAthlete(
  tokenOrIntegration: string | Integration
): Promise<StravaAthlete> {
  let accessToken: string

  if (typeof tokenOrIntegration === 'string') {
    // Called with just an access token (e.g., during initial OAuth flow)
    accessToken = tokenOrIntegration
  } else {
    // Called with an integration object - ensure valid token
    const validIntegration = await ensureValidToken(tokenOrIntegration)
    accessToken = validIntegration.accessToken
  }

  const response = await fetch('https://www.strava.com/api/v3/athlete', {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Strava API error: ${response.status} ${errorText}`)
  }

  return await response.json()
}

/**
 * Normalize Strava activity to our Workout model
 */
export function normalizeStravaActivity(activity: StravaActivity, userId: string) {
  // Map Strava sport types to our types
  const typeMapping: Record<string, string> = {
    Ride: 'Ride',
    VirtualRide: 'Ride',
    Run: 'Run',
    VirtualRun: 'Run',
    Swim: 'Swim',
    Walk: 'Walk',
    Hike: 'Hike',
    AlpineSki: 'Ski',
    BackcountrySki: 'Ski',
    NordicSki: 'Ski',
    WeightTraining: 'Gym',
    Workout: 'Gym',
    Yoga: 'Yoga',
    Elliptical: 'Other',
    StairStepper: 'Other',
    Crossfit: 'Gym',
    RockClimbing: 'Other',
    IceSkate: 'Other',
    InlineSkate: 'Other',
    Kayaking: 'Other',
    Kitesurf: 'Other',
    Rowing: 'Row',
    Snowboard: 'Ski',
    Snowshoe: 'Other',
    Soccer: 'Other',
    StandUpPaddling: 'Other',
    Surfing: 'Other',
    Windsurf: 'Other'
  }

  const normalizedType = typeMapping[activity.sport_type] || activity.type || 'Other'

  // Build enhanced description with relevant training data
  let enhancedDescription = activity.description || ''

  // Add device info if available (useful for data quality context)
  if (activity.device_name) {
    enhancedDescription += `\n\nDevice: ${activity.device_name}`
  }

  // Add gear info if available (useful for tracking equipment usage)
  if ((activity as any).gear?.name) {
    enhancedDescription += `\nGear: ${(activity as any).gear.name}`
  }

  return {
    userId,
    externalId: String(activity.id),
    source: 'strava',
    // Use start_date (UTC) instead of start_date_local to ensure correct absolute time storage
    // This allows for correct matching with other sources like Whoop/Intervals
    date: new Date(activity.start_date),
    title: activity.name,
    description: enhancedDescription.trim() || null,
    type: normalizedType,
    durationSec: activity.moving_time,
    distanceMeters: activity.distance || null,
    elevationGain: activity.total_elevation_gain ? Math.round(activity.total_elevation_gain) : null,

    // Power metrics
    averageWatts: activity.average_watts ? Math.round(activity.average_watts) : null,
    maxWatts: activity.max_watts || null,
    normalizedPower: activity.weighted_average_watts
      ? Math.round(activity.weighted_average_watts)
      : null,
    weightedAvgWatts: activity.weighted_average_watts
      ? Math.round(activity.weighted_average_watts)
      : null,

    // Heart rate
    averageHr: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
    maxHr: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,

    // Cadence
    averageCadence: activity.average_cadence ? Math.round(activity.average_cadence) : null,
    maxCadence: (activity as any).max_cadence ? Math.round((activity as any).max_cadence) : null,

    // Speed
    averageSpeed: activity.average_speed || null,

    // Training load metrics
    tss: null, // Strava doesn't provide TSS directly
    trainingLoad: null, // Strava doesn't provide icu_training_load (Intervals.icu metric)
    // Strava doesn't provide Normalized Power or FTP, so we can't calculate proper Intensity Factor
    // If the user has FTP set, we could estimate IF as average_watts / FTP, but that's not accurate
    intensity: null,
    kilojoules: activity.kilojoules ? Math.round(activity.kilojoules) : null,
    trimp: activity.suffer_score || null, // Strava's suffer_score is similar to TRIMP

    // Performance metrics - Calculate some if we have the data
    ftp: null,
    variabilityIndex:
      activity.average_watts && activity.weighted_average_watts
        ? Math.round((activity.weighted_average_watts / activity.average_watts) * 100) / 100
        : null,
    powerHrRatio:
      activity.average_watts && activity.average_heartrate
        ? Math.round((activity.average_watts / activity.average_heartrate) * 100) / 100
        : null,
    efficiencyFactor: null,
    decoupling: null,
    polarizationIndex: null,

    // Training status
    ctl: null,
    atl: null,

    // Subjective metrics - Strava has perceived exertion in detailed view
    rpe: (activity as any).perceived_exertion || null,
    sessionRpe: null,
    feel: null,

    // Environmental
    avgTemp: activity.average_temp || null,
    trainer: activity.trainer || null,

    // Balance
    lrBalance: null,

    // Energy & Time
    calories: activity.calories || null,
    elapsedTimeSec: activity.elapsed_time || null,

    // Device & Metadata
    deviceName: activity.device_name || null,
    commute: activity.commute || false,
    isPrivate: activity.private || false,
    gearId: activity.gear_id || null,
    summaryPolyline: activity.map?.summary_polyline || null,

    // Store raw data with all fields
    rawJson: activity
  }
}

/** Persistent provider failure whose integration status could not be saved. */
class StravaStreamsRecordingError extends AggregateError {
  constructor(providerError: StravaStreamsError, recordingError: unknown) {
    super(
      [providerError, recordingError],
      `${providerError.message}; failed to record integration failure`
    )
    this.name = 'StravaStreamsRecordingError'
  }
}

/** A body-free error keeps upstream HTML and user data out of telemetry. */
export class StravaStreamsError extends Error {
  readonly transient: boolean

  constructor(readonly statusCode: number) {
    super(`Strava Streams API error: ${statusCode}`)
    this.name = 'StravaStreamsError'
    this.transient = statusCode >= 500 && statusCode < 600
  }
}

/**
 * Fetch activity streams (time-series data including pacing)
 * @see https://developers.strava.com/docs/reference/#api-Streams-getActivityStreams
 */
export async function fetchStravaActivityStreams(
  integration: Integration,
  activityId: number,
  streamTypes: string[] = [
    'time',
    'distance',
    'velocity_smooth',
    'heartrate',
    'cadence',
    'watts',
    'altitude'
  ]
): Promise<Record<string, StravaStream>> {
  const validIntegration = await ensureValidToken(integration)

  const url = `https://www.strava.com/api/v3/activities/${activityId}/streams`
  const params = new URLSearchParams({
    keys: streamTypes.join(','),
    key_by_type: 'true'
  })

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${url}?${params}`, {
      headers: {
        Authorization: `Bearer ${validIntegration.accessToken}`
      }
    })

    if (response.ok) {
      return await response.json()
    }

    const error = new StravaStreamsError(response.status)
    // Never read or interpolate provider bodies, even when mislabeled as JSON.
    await response.body?.cancel().catch(() => {
      // Cleanup failure must not mask the HTTP status or bypass retries.
    })
    if (!error.transient) {
      throw error
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
      continue
    }

    try {
      // updateMany tolerates a concurrent disconnect without masking the provider error.
      await prisma.integration.updateMany({
        where: { id: integration.id, userId: integration.userId, provider: 'strava' },
        data: {
          syncStatus: 'FAILED',
          errorMessage: `${error.message}; streams unavailable for activity ${activityId} after 3 attempts. Please retry later.`
        }
      })
    } catch (recordingError) {
      // Preserve both failures without putting database details in the public message.
      throw new StravaStreamsRecordingError(error, recordingError)
    }
    throw error
  }
}

/**
 * Create a Strava push subscription
 */
export async function createStravaSubscription(callbackUrl: string, verifyToken: string) {
  const clientId = process.env.STRAVA_CLIENT_ID
  const clientSecret = process.env.STRAVA_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Strava credentials not configured')
  }

  const formData = new URLSearchParams()
  formData.append('client_id', clientId)
  formData.append('client_secret', clientSecret)
  formData.append('callback_url', callbackUrl)
  formData.append('verify_token', verifyToken)

  const response = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
    method: 'POST',
    body: formData
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to create Strava subscription: ${response.status} ${errorText}`)
  }

  return await response.json()
}

/**
 * View current Strava push subscriptions
 */
export async function listStravaSubscriptions() {
  const clientId = process.env.STRAVA_CLIENT_ID
  const clientSecret = process.env.STRAVA_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Strava credentials not configured')
  }

  const url = new URL('https://www.strava.com/api/v3/push_subscriptions')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('client_secret', clientSecret)

  const response = await fetch(url.toString())

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to list Strava subscriptions: ${response.status} ${errorText}`)
  }

  return await response.json()
}

/**
 * Delete a Strava push subscription
 */
export async function deleteStravaSubscription(id: number) {
  const clientId = process.env.STRAVA_CLIENT_ID
  const clientSecret = process.env.STRAVA_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Strava credentials not configured')
  }

  const url = new URL(`https://www.strava.com/api/v3/push_subscriptions/${id}`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('client_secret', clientSecret)

  const response = await fetch(url.toString(), {
    method: 'DELETE'
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to delete Strava subscription: ${response.status} ${errorText}`)
  }

  return true
}
