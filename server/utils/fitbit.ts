import type { Integration } from '@prisma/client'
import { prisma } from './db'
import { fromZonedTime } from 'date-fns-tz'
import { pickMealScheduledTime } from './nutrition/meal-pattern'

const FITBIT_API_BASE = 'https://api.fitbit.com'

interface FitbitTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string
  user_id: string
}

interface FitbitFoodLogEntry {
  logDate?: string
  logId?: number
  loggedFood?: {
    accessLevel?: string
    amount?: number
    brand?: string
    calories?: number
    foodId?: number
    locale?: string
    mealTypeId?: number
    name?: string
    unit?: {
      id?: number
      name?: string
      plural?: string
    }
  }
  nutritionalValues?: {
    calories?: number
    protein?: number
    carbs?: number
    fat?: number
    fiber?: number
    sugar?: number
    sodium?: number
    [key: string]: number | undefined
  }
  isFavorite?: boolean
}

type MealKey = 'breakfast' | 'lunch' | 'dinner' | 'snacks'
const MEAL_KEYS: MealKey[] = ['breakfast', 'lunch', 'dinner', 'snacks']

export interface FitbitFoodLogResponse {
  foods: FitbitFoodLogEntry[]
  summary?: {
    calories?: number
    carbs?: number
    fat?: number
    fiber?: number
    protein?: number
    sugar?: number
    sodium?: number
    water?: number
    [key: string]: number | undefined
  }
  goals?: {
    calories?: number
  }
}

export interface FitbitWaterLogResponse {
  summary?: {
    water?: number
  }
  water?: {
    amount?: number
    logId?: number
  }[]
}

export interface FitbitFoodGoalsResponse {
  goals?: {
    calories?: number
  }
}

export interface FitbitWaterGoalsResponse {
  goal?: {
    goal?: number
    startDate?: string
  }
}

export interface FitbitSleepLogResponse {
  sleep?: Array<{
    dateOfSleep?: string
    duration?: number
    efficiency?: number
    endTime?: string
    isMainSleep?: boolean
    logId?: number
    minutesAfterWakeup?: number
    minutesAsleep?: number
    minutesAwake?: number
    minutesToFallAsleep?: number
    startTime?: string
    timeInBed?: number
    type?: 'classic' | 'stages'
    levels?: {
      summary?: {
        deep?: { minutes?: number }
        light?: { minutes?: number }
        rem?: { minutes?: number }
        wake?: { minutes?: number }
        asleep?: { minutes?: number }
        restless?: { minutes?: number }
        awake?: { minutes?: number }
      }
    }
  }>
  summary?: {
    stages?: {
      deep?: number
      light?: number
      rem?: number
      wake?: number
    }
    totalMinutesAsleep?: number
    totalSleepRecords?: number
    totalTimeInBed?: number
  }
}

export interface FitbitHrvSummaryResponse {
  hrv?: Array<{
    dateTime?: string
    value?: {
      dailyRmssd?: number
      deepRmssd?: number
    }
  }>
}

export interface FitbitHeartRateResponse {
  'activities-heart'?: Array<{
    dateTime?: string
    value?: {
      restingHeartRate?: number
    }
  }>
}

export interface FitbitHeartRateIntradayResponse {
  'activities-heart'?: Array<{
    dateTime?: string
    value?: {
      restingHeartRate?: number
    }
  }>
  'activities-heart-intraday'?: {
    dataset?: Array<{
      time?: string
      value?: number
    }>
    datasetInterval?: number
    datasetType?: string
  }
}

export interface FitbitWeightLogResponse {
  weight?: Array<{
    date?: string
    bmi?: number
    fat?: number
    logId?: number
    source?: string
    time?: string
    weight?: number
  }>
}

export interface FitbitBodyFatLogResponse {
  fat?: Array<{
    date?: string
    fat?: number
    logId?: number
    source?: string
    time?: string
  }>
}

export interface FitbitSpO2SummaryResponse {
  value?: {
    avg?: number
    spo2?: number
    average?: number
    min?: number
    max?: number
  }
  minutesBelow90?: {
    minute?: number
    value?: number
  }
  dateTime?: string
}

export interface FitbitBreathingRateSummaryResponse {
  br?: Array<{
    dateTime?: string
    value?: {
      breathingRate?: number
      avg?: number
      br?: number
      rate?: number
    }
  }>
}

function encodeBasicAuth(clientId: string, clientSecret: string) {
  const creds = `${clientId}:${clientSecret}`
  return Buffer.from(creds).toString('base64')
}

/**
 * Refreshes an expired Fitbit access token using the refresh token
 */
export async function refreshFitbitToken(integration: Integration): Promise<Integration> {
  if (!integration.refreshToken) {
    throw new Error('No refresh token available for Fitbit integration')
  }

  const clientId = process.env.FITBIT_CLIENT_ID
  const clientSecret = process.env.FITBIT_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Fitbit credentials not configured')
  }

  const response = await fetch(`${FITBIT_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${encodeBasicAuth(clientId, clientSecret)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: integration.refreshToken
    }).toString()
  })

  if (!response.ok) {
    throw new Error(`Failed to refresh Fitbit token: ${response.status} ${response.statusText}`)
  }

  const tokenData: FitbitTokenResponse = await response.json()
  if (
    !tokenData.access_token ||
    !tokenData.refresh_token ||
    !Number.isFinite(tokenData.expires_in) ||
    tokenData.expires_in <= 0
  ) {
    throw new Error('Invalid Fitbit token refresh response')
  }
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000)

  const updatedIntegration = await prisma.integration.update({
    where: { id: integration.id },
    data: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
      scope: tokenData.scope,
      externalUserId: tokenData.user_id
    }
  })

  // Publish credentials only after persistence succeeds, keeping sequential callers in sync.
  Object.assign(integration, {
    accessToken: updatedIntegration.accessToken,
    refreshToken: updatedIntegration.refreshToken,
    expiresAt: updatedIntegration.expiresAt,
    scope: updatedIntegration.scope,
    externalUserId: updatedIntegration.externalUserId
  })
  return integration
}

function isTokenExpired(integration: Integration): boolean {
  if (!integration.expiresAt) return false
  const now = new Date()
  const expiryWithBuffer = new Date(integration.expiresAt.getTime() - 5 * 60 * 1000)
  return now >= expiryWithBuffer
}

async function ensureValidToken(integration: Integration): Promise<Integration> {
  if (isTokenExpired(integration)) {
    return await refreshFitbitToken(integration)
  }
  return integration
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  backoff = 1000
): Promise<Response> {
  try {
    const response = await fetch(url, options)

    const limitHeader =
      response.headers.get('fitbit-rate-limit-limit') || response.headers.get('rate-limit-limit')
    const remainingHeader =
      response.headers.get('fitbit-rate-limit-remaining') ||
      response.headers.get('rate-limit-remaining')
    const resetHeader =
      response.headers.get('fitbit-rate-limit-reset') || response.headers.get('rate-limit-reset')

    const remaining = remainingHeader ? parseInt(remainingHeader, 10) : null
    const resetSeconds = resetHeader ? parseInt(resetHeader, 10) : null

    if (remaining !== null && resetSeconds !== null) {
      console.log(
        `[Fitbit API] Rate limit: ${remainingHeader}/${limitHeader ?? 'unknown'} remaining, resets in ${resetSeconds}s`
      )
    }

    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After')
      const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoff

      console.warn(
        `[Fitbit API] 429 Too Many Requests. Retrying in ${waitTime}ms... (${retries} retries left)`
      )
      await new Promise((resolve) => setTimeout(resolve, waitTime))

      return fetchWithRetry(url, options, retries - 1, backoff * 2)
    }

    return response
  } catch (error) {
    if (retries > 0) {
      console.warn(
        `[Fitbit API] Network error: ${error}. Retrying in ${backoff}ms... (${retries} retries left)`
      )
      await new Promise((resolve) => setTimeout(resolve, backoff))
      return fetchWithRetry(url, options, retries - 1, backoff * 2)
    }
    throw error
  }
}

async function fitbitGet<T>(integration: Integration, path: string): Promise<T> {
  const validIntegration = await ensureValidToken(integration)
  const response = await fetchWithRetry(`${FITBIT_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${validIntegration.accessToken}`,
      Accept: 'application/json'
    }
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('[Fitbit] API error:', errorText)

    if (response.status === 429) {
      const resetHeader =
        response.headers.get('fitbit-rate-limit-reset') || response.headers.get('rate-limit-reset')
      const resetSeconds = resetHeader ? parseInt(resetHeader, 10) : null
      throw new Error(`FITBIT_RATE_LIMITED${resetSeconds !== null ? `_RESET_${resetSeconds}` : ''}`)
    }

    if (response.status === 401) {
      const refreshed = await refreshFitbitToken(validIntegration)
      const retry = await fetchWithRetry(`${FITBIT_API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${refreshed.accessToken}`,
          Accept: 'application/json'
        }
      })

      if (!retry.ok) {
        const retryError = await retry.text()
        console.error('[Fitbit] API retry error:', retryError)
        throw new Error(`Fitbit API request failed: ${retry.status} ${retry.statusText}`)
      }

      return (await retry.json()) as T
    }

    throw new Error(`Fitbit API request failed: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as T
}

export async function fetchFitbitFoodLog(
  integration: Integration,
  date: string
): Promise<FitbitFoodLogResponse> {
  return await fitbitGet<FitbitFoodLogResponse>(
    integration,
    `/1/user/-/foods/log/date/${date}.json`
  )
}

export async function fetchFitbitWaterLog(
  integration: Integration,
  date: string
): Promise<FitbitWaterLogResponse> {
  return await fitbitGet<FitbitWaterLogResponse>(
    integration,
    `/1/user/-/foods/log/water/date/${date}.json`
  )
}

export async function fetchFitbitFoodGoals(
  integration: Integration
): Promise<FitbitFoodGoalsResponse> {
  return await fitbitGet<FitbitFoodGoalsResponse>(integration, '/1/user/-/foods/log/goal.json')
}

export async function fetchFitbitWaterGoals(
  integration: Integration
): Promise<FitbitWaterGoalsResponse> {
  return await fitbitGet<FitbitWaterGoalsResponse>(
    integration,
    '/1/user/-/foods/log/water/goal.json'
  )
}

export async function fetchFitbitSleepLog(
  integration: Integration,
  date: string
): Promise<FitbitSleepLogResponse> {
  return await fitbitGet<FitbitSleepLogResponse>(integration, `/1.2/user/-/sleep/date/${date}.json`)
}

export async function fetchFitbitHrvSummary(
  integration: Integration,
  date: string
): Promise<FitbitHrvSummaryResponse> {
  return await fitbitGet<FitbitHrvSummaryResponse>(integration, `/1/user/-/hrv/date/${date}.json`)
}

export async function fetchFitbitHeartRateSummary(
  integration: Integration,
  date: string
): Promise<FitbitHeartRateResponse> {
  return await fitbitGet<FitbitHeartRateResponse>(
    integration,
    `/1/user/-/activities/heart/date/${date}/1d.json`
  )
}

export async function fetchFitbitHeartRateIntraday(
  integration: Integration,
  date: string
): Promise<FitbitHeartRateIntradayResponse | null> {
  const scope = (integration.scope || '').toLowerCase()
  if (!scope.includes('heartrate')) {
    return null
  }

  try {
    return await fitbitGet<FitbitHeartRateIntradayResponse>(
      integration,
      `/1/user/-/activities/heart/date/${date}/1d/1min.json`
    )
  } catch (error) {
    if (error instanceof Error && /403|404/.test(error.message)) {
      return null
    }
    throw error
  }
}

export async function fetchFitbitWeightLog(
  integration: Integration,
  date: string
): Promise<FitbitWeightLogResponse> {
  return await fitbitGet<FitbitWeightLogResponse>(
    integration,
    `/1/user/-/body/log/weight/date/${date}.json`
  )
}

export async function fetchFitbitBodyFatLog(
  integration: Integration,
  date: string
): Promise<FitbitBodyFatLogResponse> {
  return await fitbitGet<FitbitBodyFatLogResponse>(
    integration,
    `/1/user/-/body/log/fat/date/${date}.json`
  )
}

export async function fetchFitbitSpO2Summary(
  integration: Integration,
  date: string
): Promise<FitbitSpO2SummaryResponse> {
  return await fitbitGet<FitbitSpO2SummaryResponse>(integration, `/1/user/-/spo2/date/${date}.json`)
}

export async function fetchFitbitBreathingRateSummary(
  integration: Integration,
  date: string
): Promise<FitbitBreathingRateSummaryResponse> {
  return await fitbitGet<FitbitBreathingRateSummaryResponse>(
    integration,
    `/1/user/-/br/date/${date}.json`
  )
}

export function normalizeFitbitWellness(
  sleepLog: FitbitSleepLogResponse | null,
  hrvSummary: FitbitHrvSummaryResponse | null,
  heartRateSummary: FitbitHeartRateResponse | null,
  heartRateIntraday: FitbitHeartRateIntradayResponse | null,
  weightLog: FitbitWeightLogResponse | null,
  bodyFatLog: FitbitBodyFatLogResponse | null,
  spO2Summary: FitbitSpO2SummaryResponse | null,
  breathingRateSummary: FitbitBreathingRateSummaryResponse | null,
  userId: string,
  date: string
) {
  const [yearStr, monthStr, dayStr] = date.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null
  }

  const dateObj = new Date(Date.UTC(year, month - 1, day))

  if (
    Number.isNaN(dateObj.getTime()) ||
    dateObj.getUTCFullYear() !== year ||
    dateObj.getUTCMonth() !== month - 1 ||
    dateObj.getUTCDate() !== day
  ) {
    return null
  }

  const mainSleep =
    sleepLog?.sleep?.find((entry) => entry?.isMainSleep) ||
    (Array.isArray(sleepLog?.sleep) ? sleepLog?.sleep[0] : null)
  const sleepSummary = sleepLog?.summary || {}

  const summaryStageMinutes = sleepSummary.stages || {}
  const levelSummary = mainSleep?.levels?.summary || {}

  const deepMinutes = summaryStageMinutes.deep ?? levelSummary.deep?.minutes ?? null
  const lightMinutes = summaryStageMinutes.light ?? levelSummary.light?.minutes ?? null
  const remMinutes = summaryStageMinutes.rem ?? levelSummary.rem?.minutes ?? null
  const wakeMinutes =
    summaryStageMinutes.wake ??
    levelSummary.wake?.minutes ??
    levelSummary.awake?.minutes ??
    mainSleep?.minutesAwake ??
    null

  const totalMinutesAsleep = mainSleep?.minutesAsleep ?? sleepSummary.totalMinutesAsleep ?? null
  const sleepSecs =
    typeof totalMinutesAsleep === 'number' && Number.isFinite(totalMinutesAsleep)
      ? Math.round(totalMinutesAsleep * 60)
      : null
  const sleepHours = sleepSecs != null ? Math.round((sleepSecs / 3600) * 10) / 10 : null

  const sleepQuality =
    typeof mainSleep?.efficiency === 'number' && Number.isFinite(mainSleep.efficiency)
      ? Math.round(mainSleep.efficiency)
      : null

  const asNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }

    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }

    return null
  }

  const firstNumber = (...values: unknown[]): number | null => {
    for (const value of values) {
      const parsed = asNumber(value)
      if (parsed !== null) {
        return parsed
      }
    }
    return null
  }

  const getNestedValue = (obj: unknown, path: (string | number)[]): unknown => {
    let current: unknown = obj
    for (const key of path) {
      if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[key as string]
      } else {
        return undefined
      }
    }
    return current
  }

  const sleepScoreRaw = firstNumber(
    getNestedValue(mainSleep, ['score', 'overall']),
    getNestedValue(mainSleep, ['score']),
    getNestedValue(mainSleep, ['sleepScore']),
    getNestedValue(mainSleep, ['levels', 'summary', 'sleepScore']),
    getNestedValue(sleepLog, ['summary', 'sleepScore']),
    getNestedValue(sleepLog, ['summary', 'sleep_score'])
  )

  const sleepScore = sleepScoreRaw != null ? Math.round(sleepScoreRaw) : null

  const hrvValue = hrvSummary?.hrv?.[0]?.value || null
  const hrvRmssd =
    typeof hrvValue?.dailyRmssd === 'number'
      ? hrvValue.dailyRmssd
      : typeof hrvValue?.deepRmssd === 'number'
        ? hrvValue.deepRmssd
        : null

  const restingHeartRate =
    heartRateSummary?.['activities-heart']?.[0]?.value?.restingHeartRate ?? null

  const toMinutesOfDay = (timeValue?: string): number | null => {
    if (!timeValue || typeof timeValue !== 'string') {
      return null
    }

    const isoMatch = timeValue.match(/T(\d{2}):(\d{2})/)
    if (isoMatch?.[1] && isoMatch?.[2]) {
      return Number(isoMatch[1]) * 60 + Number(isoMatch[2])
    }

    const plainMatch = timeValue.match(/^(\d{2}):(\d{2})/)
    if (plainMatch?.[1] && plainMatch?.[2]) {
      return Number(plainMatch[1]) * 60 + Number(plainMatch[2])
    }

    return null
  }

  const sleepWindowStartMinutes = toMinutesOfDay(mainSleep?.startTime)
  const sleepWindowEndMinutes = toMinutesOfDay(mainSleep?.endTime)

  const intradayHeartRates = (heartRateIntraday?.['activities-heart-intraday']?.dataset || [])
    .map((point) => {
      const hr =
        typeof point.value === 'number' && Number.isFinite(point.value) ? point.value : null
      const minutes = toMinutesOfDay(point.time)
      return { hr, minutes }
    })
    .filter(
      (point) =>
        point.hr !== null && point.minutes !== null && point.minutes >= 0 && point.minutes < 1440
    )

  let likelySleepingRates: number[] = []
  if (sleepWindowStartMinutes !== null && sleepWindowEndMinutes !== null) {
    const bufferMinutes = 30
    const windowStart = (sleepWindowStartMinutes - bufferMinutes + 1440) % 1440
    const windowEnd = (sleepWindowEndMinutes + bufferMinutes) % 1440
    const wrapsMidnight = windowStart > windowEnd

    likelySleepingRates = intradayHeartRates
      .filter((point) => {
        const minute = point.minutes as number
        if (wrapsMidnight) {
          return minute >= windowStart || minute <= windowEnd
        }
        return minute >= windowStart && minute <= windowEnd
      })
      .map((point) => point.hr as number)
  }

  if (likelySleepingRates.length === 0) {
    likelySleepingRates = intradayHeartRates
      .filter((point) => (point.minutes as number) <= 5 * 60 + 59)
      .map((point) => point.hr as number)
  }

  const avgSleepingHr =
    likelySleepingRates.length > 0
      ? Math.round(
          likelySleepingRates.reduce((sum, value) => sum + value, 0) / likelySleepingRates.length
        )
      : null

  const weight = firstNumber(weightLog?.weight?.[0]?.weight)
  const bodyFat = firstNumber(bodyFatLog?.fat?.[0]?.fat, weightLog?.weight?.[0]?.fat)

  const spO2 = firstNumber(
    spO2Summary?.value?.avg,
    spO2Summary?.value?.spo2,
    spO2Summary?.value?.average,
    (spO2Summary as any)?.spo2?.[0]?.value?.avg,
    (spO2Summary as any)?.spo2?.[0]?.value?.spo2,
    (spO2Summary as any)?.spo2?.[0]?.value
  )

  const respiration = firstNumber(
    breathingRateSummary?.br?.[0]?.value?.breathingRate,
    breathingRateSummary?.br?.[0]?.value?.avg,
    breathingRateSummary?.br?.[0]?.value?.br,
    breathingRateSummary?.br?.[0]?.value?.rate,
    (breathingRateSummary as any)?.value?.breathingRate,
    (breathingRateSummary as any)?.value?.avg
  )

  const hasWellnessData =
    hrvRmssd != null ||
    restingHeartRate != null ||
    avgSleepingHr != null ||
    sleepSecs != null ||
    sleepScore != null ||
    sleepQuality != null ||
    deepMinutes != null ||
    lightMinutes != null ||
    remMinutes != null ||
    wakeMinutes != null ||
    weight != null ||
    bodyFat != null ||
    spO2 != null ||
    respiration != null

  if (!hasWellnessData) {
    return null
  }

  return {
    userId,
    date: dateObj,
    hrv: hrvRmssd,
    hrvSdnn: null,
    restingHr: restingHeartRate,
    avgSleepingHr,
    sleepSecs,
    sleepHours,
    sleepScore,
    sleepQuality,
    sleepDeepSecs:
      typeof deepMinutes === 'number' && Number.isFinite(deepMinutes)
        ? Math.round(deepMinutes * 60)
        : null,
    sleepRemSecs:
      typeof remMinutes === 'number' && Number.isFinite(remMinutes)
        ? Math.round(remMinutes * 60)
        : null,
    sleepLightSecs:
      typeof lightMinutes === 'number' && Number.isFinite(lightMinutes)
        ? Math.round(lightMinutes * 60)
        : null,
    sleepAwakeSecs:
      typeof wakeMinutes === 'number' && Number.isFinite(wakeMinutes)
        ? Math.round(wakeMinutes * 60)
        : null,
    readiness: null,
    recoveryScore: null,
    weight,
    bodyFat,
    spO2,
    respiration,
    skinTemp: null,
    rawJson: {
      sleepLog,
      hrvSummary,
      heartRateSummary,
      heartRateIntraday,
      weightLog,
      bodyFatLog,
      spO2Summary,
      breathingRateSummary
    },
    source: 'fitbit'
  }
}

const MEAL_TYPE_MAP: Record<number, MealKey> = {
  1: 'breakfast',
  2: 'snacks',
  3: 'lunch',
  4: 'snacks',
  5: 'dinner',
  6: 'snacks',
  7: 'snacks'
}

function resolveMealKey(mealTypeId: number | null | undefined): MealKey {
  if (typeof mealTypeId !== 'number') return 'snacks'
  return MEAL_TYPE_MAP[mealTypeId] || 'snacks'
}

function getFitbitIdentity(item: any): string | null {
  if (!item || typeof item !== 'object') return null

  if (item.fitbitLogId != null) return `log:${String(item.fitbitLogId)}`
  if (item.logId != null) return `log:${String(item.logId)}`

  if (typeof item.id === 'string' && item.id.startsWith('fitbit:')) {
    return `id:${item.id}`
  }

  return null
}

function isFitbitItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false
  if (item.source === 'fitbit') return true
  if (item.fitbitLogId != null || item.logId != null) return true
  return typeof item.id === 'string' && item.id.startsWith('fitbit:')
}

function asItemArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

function toScheduledLoggedAt(
  date: string,
  mealKey: MealKey,
  options?: { mealPattern?: unknown; timezone?: string }
): string {
  const scheduled = pickMealScheduledTime(mealKey, options?.mealPattern)
  const timezone = options?.timezone || 'UTC'

  try {
    return fromZonedTime(`${date}T${scheduled}:00`, timezone).toISOString()
  } catch (error) {
    console.warn('[Fitbit] Failed timezone conversion for scheduled meal time', {
      date,
      mealKey,
      timezone,
      scheduled,
      error
    })

    const fallback = new Date(`${date}T${scheduled}:00`)
    if (!Number.isNaN(fallback.getTime())) {
      return fallback.toISOString()
    }

    return fromZonedTime(`${date}T${scheduled}:00`, 'UTC').toISOString()
  }
}

export function mergeFitbitNutritionWithExisting(
  incomingNutrition: any,
  existingNutrition: any | null
): any {
  if (!existingNutrition) return incomingNutrition

  const mealKeys = MEAL_KEYS
  const existingFitbitByIdentity = new Map<string, any>()
  const existingMealByIdentity = new Map<string, MealKey>()

  for (const mealKey of mealKeys) {
    const existingItems = asItemArray(existingNutrition[mealKey])
    for (const existingItem of existingItems) {
      if (!isFitbitItem(existingItem)) continue
      const identity = getFitbitIdentity(existingItem)
      if (!identity) continue
      existingFitbitByIdentity.set(identity, existingItem)
      existingMealByIdentity.set(identity, mealKey)
    }
  }

  const mergedMealItems: Record<MealKey, any[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snacks: []
  }

  const preserveAlwaysKeys = new Set(['absorptionType', 'water_ml'])
  const preserveIfMissingKeys = new Set(['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar'])

  for (const mealKey of mealKeys) {
    const existingItems = asItemArray(existingNutrition[mealKey])
    const existingNonFitbitItems = existingItems.filter((item) => !isFitbitItem(item))
    const incomingItems = asItemArray(incomingNutrition[mealKey])

    mergedMealItems[mealKey].push(...existingNonFitbitItems)

    for (const incomingItem of incomingItems) {
      const identity = getFitbitIdentity(incomingItem)
      const existing = identity ? existingFitbitByIdentity.get(identity) : null

      if (!existing) {
        mergedMealItems[mealKey].push(incomingItem)
        continue
      }

      const incomingLoggedAt =
        typeof incomingItem.logged_at === 'string' ? incomingItem.logged_at : undefined
      const existingLoggedAt =
        typeof existing.logged_at === 'string' ? existing.logged_at : undefined
      const legacyManualTimeDetected =
        existing.fitbitTimeDerived == null &&
        !!existingLoggedAt &&
        !!incomingLoggedAt &&
        existingLoggedAt !== incomingLoggedAt

      const preserveManualLoggedAt =
        (existing.fitbitTimeDerived === false || legacyManualTimeDetected) &&
        typeof existing.logged_at === 'string' &&
        existing.logged_at.length > 0

      const mergedItem: any = {
        ...incomingItem,
        id: existing.id || incomingItem.id,
        ...(preserveManualLoggedAt
          ? { logged_at: existing.logged_at, fitbitTimeDerived: false }
          : {})
      }

      for (const key of preserveAlwaysKeys) {
        if (existing[key] !== undefined) {
          mergedItem[key] = existing[key]
        }
      }

      for (const key of preserveIfMissingKeys) {
        if ((mergedItem[key] === null || mergedItem[key] === undefined) && existing[key] != null) {
          mergedItem[key] = existing[key]
        }
      }

      const existingMeal = identity ? existingMealByIdentity.get(identity) : null
      const legacyManualMealDetected =
        existing.fitbitMealDerived == null && !!existingMeal && existingMeal !== mealKey
      const preserveManualMeal = existing.fitbitMealDerived === false || legacyManualMealDetected
      const targetMealKey = preserveManualMeal && existingMeal ? existingMeal : mealKey

      if (preserveManualMeal) {
        mergedItem.fitbitMealDerived = false
      }

      mergedMealItems[targetMealKey].push(mergedItem)
    }
  }

  const mergedMeals: Record<MealKey, any[] | null> = {
    breakfast: mergedMealItems.breakfast.length ? mergedMealItems.breakfast : null,
    lunch: mergedMealItems.lunch.length ? mergedMealItems.lunch : null,
    dinner: mergedMealItems.dinner.length ? mergedMealItems.dinner : null,
    snacks: mergedMealItems.snacks.length ? mergedMealItems.snacks : null
  }

  return {
    ...incomingNutrition,
    ...mergedMeals
  }
}

export function normalizeFitbitNutrition(
  foodLog: FitbitFoodLogResponse | null,
  waterLog: FitbitWaterLogResponse | null,
  foodGoals: FitbitFoodGoalsResponse | null,
  userId: string,
  date: string,
  options?: {
    mealPattern?: unknown
    timezone?: string
  }
) {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  const dateObj = new Date(Date.UTC(year, month - 1, day))

  const mealGroups: Record<MealKey, any[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
    snacks: []
  }

  for (const entry of foodLog?.foods || []) {
    const loggedFood = entry.loggedFood || {}
    const nutrients = entry.nutritionalValues || {}
    const mealTypeId = loggedFood.mealTypeId ?? 7
    const mealKey = resolveMealKey(mealTypeId)
    const unitName = loggedFood.unit?.name || loggedFood.unit?.plural || null
    const itemName = loggedFood.name ?? 'Unknown'
    const itemBrand = loggedFood.brand ?? null

    const itemDate = entry.logDate || date

    const fitbitLogId = entry.logId ?? null
    const stableId = fitbitLogId != null ? `fitbit:${fitbitLogId}` : crypto.randomUUID()

    mealGroups[mealKey].push({
      id: stableId,
      fitbitLogId,
      logId: entry.logId,
      mealTypeId,
      amount: loggedFood.amount ?? null,
      serving: unitName,
      unit: unitName,
      name: itemName,
      product_name: itemName,
      brand: itemBrand,
      product_brand: itemBrand,
      date: itemDate,
      logged_at: toScheduledLoggedAt(date, mealKey, options),
      fitbitTimeDerived: true,
      fitbitMealDerived: true,
      source: 'fitbit',
      calories: nutrients.calories ?? loggedFood.calories ?? null,
      protein: nutrients.protein ?? null,
      carbs: nutrients.carbs ?? null,
      fat: nutrients.fat ?? null,
      fiber: nutrients.fiber ?? null,
      sugar: nutrients.sugar ?? null,
      raw: entry
    })
  }

  const summary = foodLog?.summary || {}
  const waterMl = waterLog?.summary?.water ?? null

  return {
    userId,
    date: dateObj,
    calories: summary.calories ?? null,
    protein: summary.protein ?? null,
    carbs: summary.carbs ?? null,
    fat: summary.fat ?? null,
    fiber: summary.fiber ?? null,
    sugar: summary.sugar ?? null,
    waterMl: waterMl ?? null,
    caloriesGoal: foodGoals?.goals?.calories ?? foodLog?.goals?.calories ?? null,
    proteinGoal: null,
    carbsGoal: null,
    fatGoal: null,
    breakfast: mealGroups.breakfast.length ? mealGroups.breakfast : null,
    lunch: mealGroups.lunch.length ? mealGroups.lunch : null,
    dinner: mealGroups.dinner.length ? mealGroups.dinner : null,
    snacks: mealGroups.snacks.length ? mealGroups.snacks : null,
    rawJson: {
      foodLog,
      waterLog,
      foodGoals
    }
  }
}
