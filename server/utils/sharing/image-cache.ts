import { createHash } from 'node:crypto'
import IORedis from 'ioredis'
import type { WorkoutImageRatio, WorkoutImageStyle, WorkoutImageVariant } from './image-generator'

const REDIS_URL = process.env.REDIS_URL
const CACHE_VERSION = 'share-image-v1'
const DEFAULT_TTL_SECONDS = 60 * 60 * 6

let client: IORedis | null = null
let hasLoggedDisabled = false

interface CacheKeyInput {
  workout: Record<string, any>
  style: WorkoutImageStyle
  variant: WorkoutImageVariant
  ratio: WorkoutImageRatio
}

export function isWorkoutImageCacheEnabled() {
  return !!REDIS_URL && !process.env.NITRO_BUILD
}

export function buildWorkoutImageCacheKey(input: CacheKeyInput) {
  const payload = {
    id: input.workout.id ?? null,
    updatedAt: normalizeDate(input.workout.updatedAt),
    title: input.workout.title ?? null,
    type: input.workout.type ?? null,
    date: normalizeDate(input.workout.date),
    durationSec: input.workout.durationSec ?? null,
    distanceMeters: input.workout.distanceMeters ?? null,
    averageHr: input.workout.averageHr ?? null,
    averageWatts: input.workout.averageWatts ?? null,
    averageSpeed: input.workout.averageSpeed ?? null,
    // CW-379: not a Prisma read -- `input.workout` is an already-hydrated
    // object, and its only producer (server/api/share/workouts/[token]/image.get.ts)
    // builds it with attachStreamToWorkout(), so these series already come from
    // WorkoutStreamV2 with the legacy V1 fallback. Left as a plain property
    // read by design; changing it would just re-fetch what the caller has.
    streams: {
      latlng: input.workout.streams?.latlng ?? null,
      heartrate: input.workout.streams?.heartrate ?? null
    },
    style: input.style,
    variant: input.variant,
    ratio: input.ratio
  }

  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return `share:image:${CACHE_VERSION}:${input.workout.id ?? 'unknown'}:${input.style}:${input.variant}:${input.ratio}:${hash}`
}

export async function getCachedWorkoutImage(cacheKey: string) {
  const redis = await getCacheClient()
  if (!redis) return null

  try {
    return await redis.getBuffer(cacheKey)
  } catch (error: any) {
    console.warn('[WorkoutImageCache] Redis get failed:', error?.message || error)
    return null
  }
}

export async function setCachedWorkoutImage(
  cacheKey: string,
  pngBuffer: Buffer,
  ttlSeconds = DEFAULT_TTL_SECONDS
) {
  const redis = await getCacheClient()
  if (!redis) return

  try {
    await redis.set(cacheKey, pngBuffer, 'EX', ttlSeconds)
  } catch (error: any) {
    console.warn('[WorkoutImageCache] Redis set failed:', error?.message || error)
  }
}

async function getCacheClient() {
  if (!isWorkoutImageCacheEnabled()) {
    logDisabledOnce()
    return null
  }

  if (!client) {
    client = new IORedis(REDIS_URL!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null
    })

    client.on('error', (error) => {
      if (!process.env.NITRO_BUILD) {
        console.warn('[WorkoutImageCache] Redis error:', error.message)
      }
    })
  }

  if (client.status === 'wait') {
    try {
      await client.connect()
    } catch (error) {
      client.disconnect()
      client = null
      console.warn(
        '[WorkoutImageCache] Redis connect failed:',
        error instanceof Error ? error.message : String(error)
      )
      return null
    }
  }

  return client
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : (value ?? null)
}

function logDisabledOnce() {
  if (hasLoggedDisabled) return
  hasLoggedDisabled = true

  if (!process.env.NITRO_BUILD) {
    console.info('[WorkoutImageCache] Redis cache disabled: REDIS_URL missing or Nitro build mode')
  }
}
