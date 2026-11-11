import type { LlmTrackingContext } from '../../server/utils/gemini'
import type { TargetFormatPolicy } from '../../server/utils/workout-target-format-policy'
import type { TargetPolicy } from '../../server/utils/workout-target-policy'
import { formatCompactTargetingBlock } from './workout-targeting'

const AI_CONTEXT_MAX_CHARS = 500
const AI_CONTEXT_SKIP_IF_DESCRIPTION_CHARS = 120
const CORRECTIVE_DRAFT_JSON_MAX_CHARS = 12_000

export type StructureContextProfile = 'minimal' | 'standard' | 'rich'

export function looksLikeIntervalWorkout(workout: {
  title?: string | null
  description?: string | null
}): boolean {
  const text = `${workout?.title || ''} ${workout?.description || ''}`.toLowerCase()
  return /\b(vo2|threshold|tempo|interval|repeats?|x\d+|\d+x)\b/.test(text)
}

export function looksLikeSteadyStateWorkout(workout: {
  title?: string | null
  description?: string | null
  workIntensity?: number | null
}): boolean {
  if (looksLikeIntervalWorkout(workout)) return false
  const text = `${workout?.title || ''} ${workout?.description || ''}`.toLowerCase()
  return /\b(zone\s*2|z2|endurance|aerobic|easy|recovery|rest|steady)\b/.test(text)
}

export function resolveStructureContextProfile(params: {
  workout: {
    title?: string | null
    description?: string | null
    workIntensity?: number | null
    trainingWeek?: unknown
  }
  preserveExistingStructure?: boolean
}): StructureContextProfile {
  if (params.preserveExistingStructure) return 'rich'
  if (looksLikeIntervalWorkout(params.workout)) return 'standard'
  if (looksLikeSteadyStateWorkout(params.workout)) return 'minimal'
  if (params.workout.trainingWeek) return 'standard'
  return 'minimal'
}

function zoneNameMatchesPatterns(zoneName: string, patterns: string[]): boolean {
  const normalized = zoneName.toLowerCase()
  return patterns.some((pattern) => normalized.includes(pattern))
}

export function filterZonesForWorkout(
  zones: unknown,
  workout: { title?: string | null; description?: string | null },
  limit: number
): any[] {
  if (!Array.isArray(zones) || zones.length === 0) return []

  const text = `${workout.title || ''} ${workout.description || ''}`.toLowerCase()
  let patterns: string[] | null = null

  if (/\b(zone\s*2|z2|endurance|aerobic|easy|recovery|rest|steady)\b/.test(text)) {
    patterns = ['z1', 'z2', 'z3', 'zone 1', 'zone 2', 'zone 3', 'endurance', 'aerobic', 'easy']
  } else if (/\b(tempo|sweet\s*spot|threshold|ftp)\b/.test(text)) {
    patterns = ['tempo', 'threshold', 'sweet', 'z3', 'z4', 'zone 3', 'zone 4', 'ftp']
  } else if (/\b(vo2|v02|anaerobic|sprint)\b/.test(text)) {
    patterns = ['vo2', 'anaerobic', 'sprint', 'z5', 'zone 5']
  }

  if (!patterns) return zones.slice(0, limit)

  const filtered = zones.filter((zone: any) =>
    zoneNameMatchesPatterns(String(zone?.name || ''), patterns!)
  )
  return (filtered.length > 0 ? filtered : zones).slice(0, limit)
}

export function buildStructureGoalContextBlock(params: {
  profile: StructureContextProfile
  goal: string
  phase: string
  focus: string
  persona: string
}): string {
  if (params.profile === 'minimal') {
    return `- Coach Persona: ${params.persona}`
  }

  return `CONTEXT:
- Goal: ${params.goal}
- Phase: ${params.phase}
- Focus: ${params.focus}
- Coach Persona: ${params.persona}`
}

export function formatAiContextForStructureGen(params: {
  aiContext?: string | null
  workoutDescription?: string | null
  profile?: StructureContextProfile
}): string {
  if (params.profile === 'minimal') return ''

  const raw = String(params.aiContext || '').trim()
  if (!raw) return ''

  const description = String(params.workoutDescription || '').trim()
  if (description.length >= AI_CONTEXT_SKIP_IF_DESCRIPTION_CHARS) {
    return ''
  }

  const maxChars =
    params.profile === 'rich' ? AI_CONTEXT_MAX_CHARS : Math.min(300, AI_CONTEXT_MAX_CHARS)
  const capped = raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}…`
  return `- User Preferences/Context: ${capped}`
}

export function buildCompactZoneDefinitions(params: {
  workoutType: string
  sportSettings: any
  primaryMetric: string
  loadPreference: string
  ftp: number
  lthr: number
  workout?: { title?: string | null; description?: string | null }
  contextProfile?: StructureContextProfile
}) {
  const {
    workoutType,
    sportSettings,
    primaryMetric,
    loadPreference,
    ftp,
    lthr,
    workout,
    contextProfile = 'standard'
  } = params
  const parts: string[] = []
  const primaryLimit = contextProfile === 'minimal' ? 3 : 5
  const secondaryLimit = contextProfile === 'minimal' ? 2 : 3

  const addZones = (label: string, zones: any[], unit: string, limit: number) => {
    if (!Array.isArray(zones) || zones.length === 0) return
    const scopedZones = workout
      ? filterZonesForWorkout(zones, workout, limit)
      : zones.slice(0, limit)
    const compact = scopedZones.map((z: any) => `${z.name}: ${z.min}-${z.max}${unit}`).join(' | ')
    if (compact) parts.push(`${label}: ${compact}`)
  }

  if (primaryMetric === 'heartRate')
    addZones(`${workoutType} HR Zones`, sportSettings?.hrZones, ' bpm', primaryLimit)
  if (primaryMetric === 'power')
    addZones(`${workoutType} Power Zones`, sportSettings?.powerZones, ' W', primaryLimit)
  if (primaryMetric === 'pace')
    addZones(`${workoutType} Pace Zones`, sportSettings?.paceZones, ' m/s', primaryLimit)

  if (
    primaryMetric !== 'heartRate' &&
    Array.isArray(sportSettings?.hrZones) &&
    sportSettings.hrZones.length > 0
  ) {
    addZones(`${workoutType} HR Zones`, sportSettings.hrZones, ' bpm', secondaryLimit)
  }
  if (
    primaryMetric !== 'power' &&
    Array.isArray(sportSettings?.powerZones) &&
    sportSettings.powerZones.length > 0
  ) {
    addZones(`${workoutType} Power Zones`, sportSettings.powerZones, ' W', secondaryLimit)
  }
  if (
    primaryMetric !== 'pace' &&
    Array.isArray(sportSettings?.paceZones) &&
    sportSettings.paceZones.length > 0
  ) {
    addZones(`${workoutType} Pace Zones`, sportSettings.paceZones, ' m/s', secondaryLimit)
  }

  if (lthr) parts.push(`Reference LTHR: ${lthr} bpm`)
  if (ftp) parts.push(`Reference FTP: ${ftp} W`)
  if (sportSettings?.thresholdPace) {
    const metersPerSecond = Number(sportSettings.thresholdPace)
    if (metersPerSecond > 0) {
      const secondsPerKm = 1000 / metersPerSecond
      const minutes = Math.floor(secondsPerKm / 60)
      const seconds = Math.round(secondsPerKm % 60)
      parts.push(
        `Reference Threshold Pace: ${metersPerSecond} m/s (${minutes}:${seconds
          .toString()
          .padStart(2, '0')}/km)`
      )
    }
  }
  parts.push(`Preferred Load Metric: ${loadPreference}`)
  if (sportSettings?.warmupTime) parts.push(`Default Warmup: ${sportSettings.warmupTime} min`)
  if (sportSettings?.cooldownTime) parts.push(`Default Cooldown: ${sportSettings.cooldownTime} min`)

  return parts.join('\n')
}

export function buildRunPaceUnitInstruction(targetFormatPolicy: TargetFormatPolicy): string {
  return targetFormatPolicy.pace.mode === 'absolutePace'
    ? 'Use pace.units="/km" with decimal minute values (5.33-5.67 for 5:20-5:40/km) when absolute pace is requested.'
    : 'Use heartRate.units="LTHR" and pace.units="Pace" for percentage targets.'
}

export function isStrengthWorkoutType(workoutType: unknown): boolean {
  const normalized = String(workoutType || '')
    .trim()
    .toLowerCase()
  return normalized.includes('gym') || normalized.includes('weight')
}

export function buildLegacyStructureJsonRules(workoutType: unknown): string {
  if (isStrengthWorkoutType(workoutType)) {
    return `JSON RULES:
- Omit null/empty properties.
- Return a non-empty 'blocks' array; do not include top-level 'steps' or 'exercises'.
- Output valid JSON only.`
  }

  return `JSON RULES:
- Omit null/empty properties.
- Every step must have non-zero durationSeconds.
- Output valid JSON only.`
}

export function buildLegacyStructureInstructions(params: {
  workoutType: unknown
  durationMinutes: number
  mode: 'generate' | 'adjust'
  preserveExistingStructure?: boolean
  persona?: string
}): string {
  const durationMinutes = Math.max(1, Math.round(Number(params.durationMinutes) || 60))

  if (isStrengthWorkoutType(params.workoutType)) {
    const sessionIdentityLine =
      params.mode === 'adjust'
        ? 'Respect feedback; preserve the workout objective unless explicitly changed.'
        : params.preserveExistingStructure
          ? 'Regenerate while preserving session identity unless title/description require change.'
          : 'Build the session from scratch.'
    const coachLine =
      params.mode === 'adjust'
        ? 'coachInstructions: explain what changed and the key execution cue (2-3 sentences).'
        : `coachInstructions: 2-3 sentences${params.persona ? ` in "${params.persona}" tone` : ''}.`

    return `INSTRUCTIONS:
- Return native strength 'blocks' (warmup, single_exercise, superset, circuit, cooldown) totaling about ${durationMinutes} minutes.
- Each exercise inside a block is a step with setRows; loaded lifts need real sets/reps/load (not one long duration row).
- Do NOT return top-level interval-style 'steps' (Warmup/Active/Rest/Cooldown) or flat 'exercises'.
- ${sessionIdentityLine}
- description: complete sentences only. ${coachLine}`
  }

  if (params.mode === 'adjust') {
    return `INSTRUCTIONS:
- Create a NEW structure matching ${durationMinutes} minutes.
- Repeat blocks (loops with reps > 1) MUST contain non-zero recovery/rest steps between active work intervals.
- Respect feedback; preserve objective unless explicitly changed.
- In-session steps only. coachInstructions: what changed and why.`
  }

  return `INSTRUCTIONS:
- Create steps (Warmup, Intervals, Rest, Cooldown) matching ${durationMinutes} minutes.
- Repeat blocks (loops with reps > 1) MUST contain non-zero recovery/rest steps (e.g. Rest step between Active work intervals) instead of continuous work blocks.
- ${
    params.preserveExistingStructure
      ? 'Regenerate while preserving session identity unless title/description require change.'
      : 'Build the session from scratch.'
  }
- Every step needs an intent and valid primary target.
- description: complete sentences only. coachInstructions: 2-3 sentences${
    params.persona ? ` in "${params.persona}" tone` : ''
  }.
- In-session steps only; no stretching/mobility as steps.`
}

export function buildSportSpecificInstructions(params: {
  workoutType: string
  targetFormatPolicy: TargetFormatPolicy
  steadyTargetStyleRule: string
}): string {
  const workoutType = String(params.workoutType || '').toLowerCase()
  const isCycling = workoutType.includes('ride')
  const isRun = workoutType.includes('run')
  const isSwim = workoutType.includes('swim')
  const isStrength = isStrengthWorkoutType(params.workoutType)
  const runPaceUnitInstruction = buildRunPaceUnitInstruction(params.targetFormatPolicy)

  if (isCycling) {
    return `FOR CYCLING:
- Use % FTP for power (0.95 = 95%), power.units="%".
- Include cadence (RPM) on every step; vary cadence on focus steps.
- Use power ramps (start/end) for warmup/cooldown when appropriate.
- Repeat blocks (reps > 1) MUST contain non-zero recovery/rest steps between work intervals.
- Avoid repeated identical 20+ minute blocks unless repeats are requested.`
  }

  if (isRun) {
    return `FOR RUNNING:
- Include distance (meters) on every step; estimate from pace when duration-based.
- ${runPaceUnitInstruction}
- ${params.steadyTargetStyleRule}
- Repeat blocks (reps > 1) MUST contain non-zero recovery/rest steps between work sets.
- In-session segments only; no static stretching as steps.
- Respect quality spacing between hard efforts.`
  }

  if (isSwim) {
    return `FOR SWIMMING:
- Prefer distanceMeters; use stroke, equipment, sendoffSeconds, restSeconds, targetSplit, cssPercent when relevant.
- One intensity cue per step when possible; drills may omit targets if send-off/rest defines the task.
- Total session time must land near planned duration; sanity-check before returning.`
  }

  if (isStrength) {
    return `FOR STRENGTH:
- Return native 'blocks' with steps and setRows; not flat interval-style top-level steps.
- Loaded lifts use real sets/reps/load, not one long duration row.
- Block types: warmup, single_exercise, superset, circuit, cooldown.`
  }

  return `FOR THIS SPORT: use sport-relevant fields with clear work/recovery structure.`
}

export function buildStructureAiCallOptions(params: {
  attempt: number
  userId: string
  operation: string
  entityType: string
  entityId: string
  timeoutMs: number
  retryThinkingLevel?: NonNullable<LlmTrackingContext['thinkingLevelOverride']>
}): LlmTrackingContext {
  const base: LlmTrackingContext = {
    userId: params.userId,
    operation: params.operation,
    entityType: params.entityType,
    entityId: params.entityId,
    maxRetries: 0,
    timeoutMs: params.timeoutMs
  }

  if (params.attempt === 1) {
    return { ...base, disableThinking: true }
  }

  return {
    ...base,
    thinkingLevelOverride: params.retryThinkingLevel ?? 'low'
  }
}

export function buildCorrectiveStructureRetryPrompt(params: {
  workout: { title?: string | null; type?: string | null; durationSec?: number | null }
  reason: string
  previousDraft?: unknown
  generatorMode: 'draft_json_v1' | 'legacy_json'
  extraInstructions?: string
}): string {
  const durationMinutes = Math.round(Number(params.workout.durationSec || 3600) / 60)
  const draftJson = params.previousDraft
    ? JSON.stringify(params.previousDraft, null, 2).slice(0, CORRECTIVE_DRAFT_JSON_MAX_CHARS)
    : null

  const schemaHint =
    params.generatorMode === 'draft_json_v1'
      ? 'Return compact JSON matching the draft schema (single target object per step).'
      : 'Return valid JSON matching the full structure schema.'

  return `Fix this ${params.workout.type || 'workout'} structure.

WORKOUT: ${params.workout.title || 'Untitled'} | ${durationMinutes} min

FAILURE: ${params.reason}
${params.extraInstructions ? `\n${params.extraInstructions}` : ''}
${draftJson ? `\nPREVIOUS DRAFT:\n${draftJson}\n` : ''}
Preserve valid steps where possible. ${schemaHint}`
}

export function buildDraftOutputRules(params: { preserveExistingStructure: boolean }): string {
  return `- Return compact JSON only.
- Use ONE \`target\` object per step, never multiple metric objects.
- \`target.metric\` must be one of: power, heartRate, pace, rpe.
- Use \`target.units\` from: %, w, bpm, LTHR, Pace, /km.
- Percentages use decimal fractions (0.80 LTHR, 0.95 FTP).
- Use \`durationSeconds\` for timed steps; \`distanceMeters\` when distance is central.
- Use nested \`steps\` plus \`reps\` for repeats. Interval repeat blocks (reps > 1) MUST contain non-zero recovery/rest steps between work steps (e.g. Rest steps or explicit restSeconds).
- Every step needs a clear purpose and \`intent\`.
- In-session steps only; no stretching/mobility as steps.
- Put recovery guidance in \`coachInstructions\`, not \`steps\`.
- ${params.preserveExistingStructure ? 'Preserve session identity unless the workout clearly requires change.' : 'Build the full session from scratch.'}`
}

export { formatCompactTargetingBlock }
