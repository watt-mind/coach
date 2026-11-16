import { NoSuchToolError, isStepCount, streamText } from 'ai'
import { createGoogle } from '@ai-sdk/google'
import { calculateLlmCost } from '../ai-config'
import { getLlmOperationSettings } from '../ai-operation-settings'
import { getToolsWithContext } from '../ai-tools'
import { getUserAiSettings } from '../ai-user-settings'
import { prisma } from '../db'
import { getUserTimezone } from '../date'
import { buildGoogleProviderOptions } from '../gemini'
import {
  boundMessagesForModel,
  buildPersistedToolCalls,
  estimateTokenCount,
  expandStoredChatMessage
} from './history'
import { dispatchTask } from '../task-dispatcher'
import {
  CHAT_TURN_EVENT_TYPE,
  CHAT_TURN_EXECUTION_TIMEOUT_MS,
  CHAT_TURN_SLOW_RESPONSE_THRESHOLD_MS,
  CHAT_TURN_STATUS,
  CHAT_TURN_TIMEOUT_REASON,
  isMutatingChatTool
} from './turns'
import { buildAthleteContext } from '../services/chatContextService'
import { chatTurnService } from '../services/chatTurnService'
import { userMemoryService } from '../services/userMemoryService'
import { checkQuota } from '../quotas/engine'
import { sendToUser } from '../ws-state'
import { transformHistoryToCoreMessages } from '../ai-history'
import {
  sanitizeChatMessagesForToolApprovals,
  sanitizeCoreMessagesForToolApprovals
} from '../../api/chat/sanitize-tool-approval'
import { normalizeCoreMessagesForGemini } from './core-message-normalizer'
import { extractMemoryCandidatesFromConversation } from './memory-extraction'
import { findToolNameRepair } from './tool-call-repair'
import {
  classifyChatSkills,
  composeSkillInstructions,
  expandSkillSelectionForRequest,
  resolveApprovalToolNamesForSelection,
  selectToolsForSkills,
  type ChatSkillSelection
} from './skills'

const CHAT_TURN_HEARTBEAT_INTERVAL_MS = Number(
  process.env.CHAT_TURN_HEARTBEAT_INTERVAL_MS || 15_000
)
const CHAT_TURN_EXECUTION_TIMEOUT_LIMIT_MS = Number(
  process.env.CHAT_TURN_EXECUTION_TIMEOUT_MS || CHAT_TURN_EXECUTION_TIMEOUT_MS
)
const CHAT_TURN_SLOW_RESPONSE_LIMIT_MS = Number(
  process.env.CHAT_TURN_SLOW_RESPONSE_THRESHOLD_MS || CHAT_TURN_SLOW_RESPONSE_THRESHOLD_MS
)

function createAbortError(message: string) {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function getTimeoutFailureMessage(reason: string) {
  switch (reason) {
    case CHAT_TURN_TIMEOUT_REASON.FIRST_OUTPUT_TIMEOUT:
      return 'No response started within 60 seconds.'
    case CHAT_TURN_TIMEOUT_REASON.EXECUTION_TIMEOUT:
      return 'Response timed out before completion.'
    default:
      return 'Chat turn failed.'
  }
}

function hasVisibleAssistantArtifacts(input: {
  assistantText?: string
  toolCalls?: any[]
  toolApprovals?: any[]
  toolResults?: any[]
}) {
  const assistantText = typeof input.assistantText === 'string' ? input.assistantText : ''
  const toolCalls = Array.isArray(input.toolCalls) ? input.toolCalls : []
  const toolApprovals = Array.isArray(input.toolApprovals) ? input.toolApprovals : []
  const toolResults = Array.isArray(input.toolResults) ? input.toolResults : []

  return (
    assistantText.trim().length > 0 ||
    toolCalls.length > 0 ||
    toolApprovals.length > 0 ||
    toolResults.length > 0
  )
}

function buildMemoryEventFromToolResults(toolResults: any[]) {
  for (const toolResult of toolResults) {
    const toolName = toolResult?.toolName
    const result = toolResult?.result

    if (!result?.success) continue

    if (toolName === 'remember_memory') {
      return {
        action: result.action === 'updated' ? ('updated' as const) : ('saved' as const),
        memories: result.memory ? [result.memory] : [],
        notice: result.action === 'updated' ? 'Updated memory.' : 'Saved to memory.'
      }
    }

    if (toolName === 'update_memory') {
      return {
        action: 'updated' as const,
        memories: result.memory ? [result.memory] : [],
        notice: 'Updated memory.'
      }
    }

    if (toolName === 'forget_memory') {
      const memories = Array.isArray(result.matches)
        ? result.matches
        : result.memory
          ? [result.memory]
          : []

      return {
        action: 'forgotten' as const,
        memories,
        notice: 'Memory removed.'
      }
    }
  }

  return null
}

export function normalizeMessagesForSdk(inputMessages: any[]) {
  const sanitizedMessages = sanitizeChatMessagesForToolApprovals(inputMessages)
  const approvalResponses = new Map<string, { approved: boolean; reason?: string }>()

  for (const msg of sanitizedMessages) {
    if (msg.role !== 'tool') continue
    const parts = Array.isArray(msg.parts)
      ? msg.parts
      : Array.isArray(msg.content)
        ? msg.content
        : []
    for (const part of parts) {
      if (part?.type !== 'tool-approval-response') continue
      const approvalId = part.approvalId || part.toolCallId
      if (!approvalId) continue
      approvalResponses.set(approvalId, {
        approved: !!part.approved,
        reason: typeof part.reason === 'string' ? part.reason : undefined
      })
    }
  }

  return sanitizedMessages.map((msg) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.parts)) return msg

    const parts = msg.parts.map((part: any) => {
      if (!part?.type?.startsWith('tool-')) return part

      const approvalId = part.approvalId || part.approval?.id || part.toolCallId
      if (!approvalId) return part

      const response = approvalResponses.get(approvalId)
      if (!response) return part

      return {
        ...part,
        state: 'approval-responded',
        approval: {
          ...(part.approval || {}),
          id: approvalId,
          approved: response.approved,
          ...(response.reason !== undefined ? { reason: response.reason } : {})
        }
      }
    })

    return {
      ...msg,
      parts
    }
  })
}

export async function buildTurnExecutionSkillConfig(input: {
  allTools: Record<string, any>
  baseSystemInstruction: string
  skillSelection: ChatSkillSelection
  aiRequireToolApproval?: boolean
  nutritionTrackingEnabled?: boolean
}) {
  const tools = selectToolsForSkills(input.allTools, input.skillSelection.skillIds, {
    useTools: input.skillSelection.useTools
  })
  const selectedToolNames = Object.keys(tools)
  const approvalToolNames = await resolveApprovalToolNamesForSelection(tools, {
    aiRequireToolApproval: input.aiRequireToolApproval,
    useTools: input.skillSelection.useTools
  })

  return {
    tools,
    selectedToolNames,
    systemInstruction: composeSkillInstructions(
      input.baseSystemInstruction,
      input.skillSelection.skillIds,
      {
        aiRequireToolApproval: input.aiRequireToolApproval,
        nutritionTrackingEnabled: input.nutritionTrackingEnabled,
        useTools: input.skillSelection.useTools,
        approvalToolNames
      }
    )
  }
}

export function stripAssistantToolOutputsWhenCanonicalToolMessagesExist(messages: any[]) {
  const canonicalToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message?.role !== 'tool') continue
    const parts = Array.isArray(message.parts)
      ? message.parts
      : Array.isArray(message.content)
        ? message.content
        : []

    for (const part of parts) {
      const toolCallId = part?.toolCallId || part?.approvalId
      if (toolCallId) {
        canonicalToolCallIds.add(toolCallId)
      }
    }
  }

  if (canonicalToolCallIds.size === 0) {
    return messages
  }

  return messages.map((message) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.parts)) {
      return message
    }

    return {
      ...message,
      parts: message.parts.map((part: any) => {
        if (!part?.type?.startsWith('tool-')) return part
        if (part?.state !== 'output-available') return part
        if (!canonicalToolCallIds.has(part.toolCallId)) return part

        // Drop only the duplicated output, never the call itself. Downgrading to
        // `input-available` makes convertToModelMessages emit the `tool-call` without a
        // second `tool-result`, so the canonical tool message stays the single source of
        // the result. Removing the whole part instead would leave that canonical result
        // orphaned, and transformHistoryToCoreMessages would then drop it too, erasing
        // the entire tool exchange from the model's view of the conversation.
        const { output: _output, ...rest } = part
        return { ...rest, state: 'input-available' }
      })
    }
  })
}

export function findApprovedToolContinuation(messages: any[]) {
  const latestMessage = messages[messages.length - 1]
  if (latestMessage?.role !== 'tool') {
    return null
  }

  const latestParts = Array.isArray(latestMessage?.parts)
    ? latestMessage.parts
    : Array.isArray(latestMessage?.content)
      ? latestMessage.content
      : []

  const approvalPart = latestParts.find(
    (part: any) => part?.type === 'tool-approval-response' && part?.approved
  )

  if (!approvalPart) {
    return null
  }

  const approvalId = approvalPart.toolCallId || approvalPart.approvalId
  if (!approvalId) {
    return null
  }

  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue

    const parts = Array.isArray(message?.parts)
      ? message.parts
      : Array.isArray(message?.content)
        ? message.content
        : []

    const matchingPart = parts.find((part: any) => {
      if (!part?.type?.startsWith('tool-')) return false
      const partApprovalId = part?.approval?.id || part?.approvalId || part?.toolCallId
      return partApprovalId === approvalId
    })

    if (!matchingPart) continue

    return {
      toolCallId: approvalId,
      toolName:
        matchingPart.toolName ||
        (typeof matchingPart.type === 'string' ? matchingPart.type.replace('tool-', '') : null),
      args: matchingPart.input || matchingPart.args || {},
      // Carried so the re-persisted call keeps its google thoughtSignature instead of
      // falling back to the skip-validation sentinel on later replays.
      rawToolCall: matchingPart.toolCall
    }
  }

  return null
}

export function buildApprovedContinuationConfirmation(toolName: string, result: any) {
  const baseMessage =
    typeof result?.message === 'string' && result.message.trim().length > 0
      ? result.message.trim()
      : `Completed ${toolName.replaceAll('_', ' ')}.`

  const totals = result?.totals
  if (!totals || typeof totals !== 'object') {
    return baseMessage
  }

  const summaryParts = [
    typeof totals.calories === 'number' ? `${Math.round(totals.calories)} kcal` : null,
    typeof totals.carbs === 'number' ? `${Math.round(totals.carbs)}g carbs` : null,
    typeof totals.protein === 'number' ? `${Math.round(totals.protein)}g protein` : null,
    typeof totals.fat === 'number' ? `${Math.round(totals.fat)}g fat` : null,
    typeof totals.water_ml === 'number' ? `${Math.round(totals.water_ml)}ml water` : null
  ].filter(Boolean)

  return summaryParts.length > 0
    ? `${baseMessage}\n\nUpdated totals: ${summaryParts.join(', ')}.`
    : baseMessage
}

const WRITE_REPAIR_SKILL_IDS = new Set([
  'support',
  'planning_write',
  'workout_update',
  'profile',
  'availability',
  'wellness',
  'nutrition'
])

const EMPTY_RESPONSE_FALLBACK =
  'I hit a response issue while processing that. Please retry your last message.'

export function shouldUseWriteRepairPrompt(skillSelection: ChatSkillSelection) {
  return (
    !!skillSelection?.useTools &&
    Array.isArray(skillSelection?.skillIds) &&
    skillSelection.skillIds.some((skillId) => WRITE_REPAIR_SKILL_IDS.has(skillId))
  )
}

export function shouldUseReadRepairPrompt(skillSelection: ChatSkillSelection) {
  return (
    !!skillSelection?.useTools &&
    Array.isArray(skillSelection?.skillIds) &&
    skillSelection.skillIds.length > 0 &&
    !shouldUseWriteRepairPrompt(skillSelection)
  )
}

export function buildWriteRepairSystemInstruction(systemInstruction: string) {
  return `${systemInstruction}

## Empty-Response Repair Rules

- This is a retry after an invalid empty response on a tool-enabled write turn.
- You must do exactly one of the following:
- Emit the relevant tool call now if the user has already provided enough information.
- Ask exactly one blocking clarification question if one concrete missing detail prevents the tool call.
- Do not answer with general prose, summaries, fake approval text, or unsupported free text.
- Do not say that something was prepared, created, updated, deleted, or ready for approval unless the matching tool call is emitted in this turn.`
}

export function buildReadRepairSystemInstruction(systemInstruction: string) {
  return `${systemInstruction}

## Empty-Response Repair Rules

- This is a retry after an invalid empty response on a tool-enabled read turn.
- Call the needed read tools if you still lack facts, then you MUST produce a clear textual answer for the athlete.
- Do not end the turn with only tool calls and no assistant text.
- Prefer a concise coaching summary over dumping raw tool JSON.
- Write a prose coaching reply the athlete can read without tables or UI cards. Lead with the answer, then 3-6 short bullets with numbers.
- If get_workout_analysis shows aiAnalysisStatus NOT_STARTED, PENDING, PROCESSING, or FAILED, say that clearly and summarize available metrics from get_workout_details.
- If tools already answered the question, summarize the key guidance now.`
}

function truncateFallbackText(value: string, maxChars: number) {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function getToolResultPayload(toolResult: any) {
  return toolResult?.result ?? toolResult?.output ?? toolResult?.response ?? null
}

function isSuccessfulToolResult(toolResult: any) {
  const payload = getToolResultPayload(toolResult)
  return !!payload && !payload.error && payload.success !== false
}

export function hasSuccessfulMutatingToolResult(toolResults: any[]) {
  return (toolResults || []).some(
    (toolResult) =>
      isMutatingChatTool(toolResult?.toolName || toolResult?.name || '') &&
      isSuccessfulToolResult(toolResult)
  )
}

export function shouldRetryEmptyToolResponse(attemptIndex: number, toolResults: any[]) {
  return attemptIndex === 0 && !hasSuccessfulMutatingToolResult(toolResults)
}

function formatDurationSeconds(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return `${Math.round(value / 60)} min`
}

function buildWorkoutDetailsFallback(details: any): string | null {
  if (!details || typeof details !== 'object') return null

  const title = details.title || details.name
  if (!title) return null

  const lines = [`## ${title}`]
  const metadata = [
    details.date ? `Date: ${details.date}` : null,
    details.type ? `Type: ${details.type}` : null,
    formatDurationSeconds(details.durationSec),
    typeof details.tss === 'number' ? `TSS: ${Math.round(details.tss)}` : null,
    typeof details.intensity === 'number'
      ? `Intensity: ${Math.round(details.intensity * (details.intensity <= 2 ? 100 : 1))}%`
      : null,
    typeof details.rpe === 'number' ? `RPE: ${details.rpe}/10` : null
  ].filter(Boolean)
  if (metadata.length > 0) lines.push('', metadata.join(' · '))

  const description = details.notes || details.description
  if (typeof description === 'string' && description.trim()) {
    lines.push('', truncateFallbackText(description, 1_500))
  }

  return lines.join('\n')
}

function buildAvailabilityFallback(payload: any): string | null {
  if (typeof payload?.message === 'string' && !Array.isArray(payload?.availability)) {
    return payload.message.trim()
  }
  if (!Array.isArray(payload?.availability)) return null

  const lines = ['## Training availability']
  for (const day of payload.availability.slice(0, 7)) {
    const slots = Array.isArray(day?.slots)
      ? day.slots
          .slice(0, 4)
          .map((slot: any) => {
            const time = slot?.startTime ? `${slot.startTime}` : ''
            const duration = typeof slot?.duration === 'number' ? `${slot.duration} min` : ''
            return [slot?.name, time, duration].filter(Boolean).join(' · ')
          })
          .filter(Boolean)
      : []
    lines.push(`- **${day?.day || 'Day'}:** ${slots.length > 0 ? slots.join('; ') : 'No slots'}`)
  }
  return lines.join('\n')
}

function buildWorkoutListFallback(toolName: string, payload: any): string | null {
  const workouts = Array.isArray(payload) ? payload : payload?.workouts
  if (!Array.isArray(workouts)) return null

  const heading = toolName.includes('planned') ? '## Planned workouts' : '## Workouts'
  if (workouts.length === 0) return `${heading}\n\nNo matching workouts found.`

  const lines = [heading]
  for (const workout of workouts.slice(0, 8)) {
    const metadata = [
      workout?.date,
      workout?.time,
      workout?.sport || workout?.type,
      typeof workout?.duration === 'number'
        ? formatDurationSeconds(workout.duration)
        : workout?.duration,
      typeof workout?.tss === 'number' ? `TSS ${Math.round(workout.tss)}` : null
    ].filter(Boolean)
    lines.push(
      `- **${workout?.title || 'Workout'}**${metadata.length ? ` — ${metadata.join(' · ')}` : ''}`
    )
  }
  return lines.join('\n')
}

function buildWellnessMetricsFallback(payload: any): string | null {
  if (!Array.isArray(payload?.metrics)) return null
  if (payload.metrics.length === 0) return 'No wellness metrics were found for that period.'

  const lines = ['## Wellness metrics']
  for (const metric of payload.metrics.slice(0, 7)) {
    const values = [
      typeof metric?.recovery?.recovery_score === 'number'
        ? `recovery ${metric.recovery.recovery_score}`
        : null,
      typeof metric?.recovery?.hrv === 'number' ? `HRV ${metric.recovery.hrv}` : null,
      typeof metric?.sleep?.hours === 'number' ? `sleep ${metric.sleep.hours}h` : null,
      typeof metric?.subjective?.fatigue === 'number'
        ? `fatigue ${metric.subjective.fatigue}`
        : null
    ].filter(Boolean)
    lines.push(
      `- **${metric?.date || 'Date'}:** ${values.length ? values.join(' · ') : 'No values'}`
    )
  }
  return lines.join('\n')
}

function buildMutationConfirmation(toolResults: any[]): string | null {
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const toolResult = toolResults[index]
    const toolName = toolResult?.toolName || toolResult?.name || ''
    const payload = getToolResultPayload(toolResult)
    if (!isMutatingChatTool(toolName) || !isSuccessfulToolResult(toolResult)) continue

    return buildApprovedContinuationConfirmation(toolName, payload)
  }
  return null
}

function buildWorkoutAnalysisFallback(analysis: any): string | null {
  const structured =
    analysis?.aiAnalysisJson &&
    typeof analysis.aiAnalysisJson === 'object' &&
    !Array.isArray(analysis.aiAnalysisJson)
      ? analysis.aiAnalysisJson
      : null
  const summary =
    typeof structured?.executive_summary === 'string'
      ? structured.executive_summary.trim()
      : typeof analysis?.overallQualityExplanation === 'string'
        ? analysis.overallQualityExplanation.trim()
        : ''
  const markdown = typeof analysis?.aiAnalysis === 'string' ? analysis.aiAnalysis.trim() : ''
  const status =
    typeof analysis?.aiAnalysisStatus === 'string' ? analysis.aiAnalysisStatus.toUpperCase() : ''

  if (!summary && !markdown && !structured) {
    if (!status || status === 'COMPLETED') return null

    const title = analysis?.title || 'Workout'
    const dateLine = analysis?.date ? ` (${analysis.date})` : ''
    if (status === 'PENDING' || status === 'PROCESSING' || status === 'IN_PROGRESS') {
      return [
        `Deep analysis for **${title}**${dateLine} is still generating.`,
        '',
        'I have the session loaded. Ask again shortly for the full breakdown.'
      ].join('\n')
    }
    if (status === 'NOT_STARTED' || status === 'FAILED') {
      return [
        `Deep analysis for **${title}**${dateLine} is not available yet${status === 'FAILED' ? ' (the previous attempt failed)' : ''}.`,
        '',
        'I can still cover the raw session metrics now, and the full analysis can be queued from this workout.'
      ].join('\n')
    }
    return null
  }

  const title = analysis?.title || structured?.title || 'Workout analysis'
  const lines = [`## ${title}`]
  if (analysis?.date) lines.push('', `Date: ${analysis.date}`)
  if (summary) lines.push('', summary)

  const scores = structured?.scores || {}
  const scoreEntries = [
    ['Overall', analysis?.overallScore ?? scores.overall],
    ['Technical', analysis?.technicalScore ?? scores.technical],
    ['Effort', analysis?.effortScore ?? scores.effort],
    ['Pacing', analysis?.pacingScore ?? scores.pacing],
    ['Execution', analysis?.executionScore ?? scores.execution]
  ].filter((entry) => typeof entry[1] === 'number')
  if (scoreEntries.length > 0) {
    lines.push('', scoreEntries.map(([label, value]) => `${label}: ${value}/10`).join(' · '))
  }

  const strengths = Array.isArray(structured?.strengths) ? structured.strengths.slice(0, 3) : []
  if (strengths.length > 0) {
    lines.push('', '**Strengths**', ...strengths.map((item: unknown) => `- ${String(item)}`))
  }

  const weaknesses = Array.isArray(structured?.weaknesses) ? structured.weaknesses.slice(0, 3) : []
  if (weaknesses.length > 0) {
    lines.push(
      '',
      '**Areas to improve**',
      ...weaknesses.map((item: unknown) => `- ${String(item)}`)
    )
  }

  const recommendations = Array.isArray(structured?.recommendations)
    ? structured.recommendations.slice(0, 3)
    : []
  if (recommendations.length > 0) {
    lines.push('', '**Recommendations**')
    for (const recommendation of recommendations) {
      if (typeof recommendation === 'string') {
        lines.push(`- ${truncateFallbackText(recommendation, 320)}`)
        continue
      }

      const recommendationTitle = recommendation?.title || 'Recommendation'
      const description =
        typeof recommendation?.description === 'string'
          ? truncateFallbackText(recommendation.description, 320)
          : ''
      lines.push(`- **${recommendationTitle}:**${description ? ` ${description}` : ''}`)
    }
  }

  if (!summary && markdown) {
    lines.push('', truncateFallbackText(markdown, 6_000))
  }

  return lines.join('\n')
}

export function buildEmptyResponseFallbackFromToolResults(toolResults: any[]): string | null {
  const latestByName = new Map<string, any>()

  for (const toolResult of toolResults || []) {
    const toolName = toolResult?.toolName || toolResult?.name
    const payload = getToolResultPayload(toolResult)
    if (!toolName || !payload || payload.error || payload.success === false) continue
    latestByName.set(toolName, payload)
  }

  const workoutAnalysisFallback = buildWorkoutAnalysisFallback(
    latestByName.get('get_workout_analysis')
  )
  if (workoutAnalysisFallback) return workoutAnalysisFallback

  const mutationConfirmation = buildMutationConfirmation(toolResults || [])
  if (mutationConfirmation) return mutationConfirmation

  const workoutDetailsFallback = buildWorkoutDetailsFallback(
    latestByName.get('get_workout_details')
  )
  if (workoutDetailsFallback) return workoutDetailsFallback

  const availabilityFallback = buildAvailabilityFallback(
    latestByName.get('get_training_availability')
  )
  if (availabilityFallback) return availabilityFallback

  for (const toolName of [
    'get_planned_workouts',
    'search_planned_workouts',
    'get_recent_workouts',
    'search_workouts'
  ]) {
    const workoutListFallback = buildWorkoutListFallback(toolName, latestByName.get(toolName))
    if (workoutListFallback) return workoutListFallback
  }

  const wellnessFallback = buildWellnessMetricsFallback(latestByName.get('get_wellness_metrics'))
  if (wellnessFallback) return wellnessFallback

  for (const payload of [...latestByName.values()].reverse()) {
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return truncateFallbackText(payload.message, 1_500)
    }
  }

  const details = latestByName.get('get_planned_workout_details')
  const structure = latestByName.get('get_planned_workout_structure')
  if (!details && !structure) return null

  const title = details?.title || structure?.title || 'Planned workout'
  const type = details?.type || structure?.type
  const date = details?.date || structure?.date
  const durationMinutes = details?.duration_minutes || structure?.duration_minutes
  const tss = details?.tss
  const description = typeof details?.description === 'string' ? details.description.trim() : ''

  const lines = [
    'I recovered your planned session details after a temporary reply issue:',
    '',
    `**${title}**${type ? ` (${type})` : ''}`
  ]

  const meta = [
    date ? `Date: ${date}` : null,
    typeof durationMinutes === 'number' ? `Duration: ${durationMinutes} min` : null,
    typeof tss === 'number' ? `TSS: ${tss}` : null
  ].filter(Boolean)
  if (meta.length > 0) lines.push(meta.join(' · '))
  if (description) {
    lines.push('', description)
  }

  const steps = structure?.structured_workout?.steps
  if (Array.isArray(steps) && steps.length > 0) {
    lines.push('', 'Key focus by step:')
    for (const step of steps.slice(0, 8)) {
      const name = step?.name || step?.type || 'Step'
      const mins =
        typeof step?.durationSeconds === 'number'
          ? `${Math.round(step.durationSeconds / 60)} min`
          : null
      const cue =
        typeof step?.targetSplit === 'string' && step.targetSplit.trim()
          ? truncateFallbackText(step.targetSplit, 160)
          : null
      lines.push(`- ${name}${mins ? ` (${mins})` : ''}${cue ? `: ${cue}` : ''}`)
    }
  }

  lines.push('', 'Ask again if you want more specific cues for this session.')
  return lines.join('\n')
}

export function getHardcodedChatProviderOptions(modelType: 'flash' | 'pro', modelId: string) {
  if (modelType === 'pro') {
    return buildGoogleProviderOptions(modelId, 'high', 0)
  }

  return buildGoogleProviderOptions(modelId, 'low', 2000)
}

export function shouldScheduleChatRoomSummary(input: {
  roomName?: string | null
  roomMetadata?: Record<string, any> | null
  newMessages?: { content: string | null }[]
}) {
  const roomName = input.roomName?.trim()
  const roomMetadata = input.roomMetadata || {}

  const needsTitleGeneration =
    !roomName || roomName === 'New Chat' || !roomMetadata.titleGeneratedAt
  const needsSummaryGeneration =
    !roomMetadata.historySummary || !roomMetadata.lastSummarizedMessageId

  const newMessages = input.newMessages || []
  const estimatedNewTokens = newMessages.reduce(
    (sum, message) =>
      sum + (typeof message.content === 'string' ? Math.ceil(message.content.length / 4) : 0),
    0
  )

  return (
    needsTitleGeneration ||
    needsSummaryGeneration ||
    newMessages.length >= 12 ||
    estimatedNewTokens >= 1000
  )
}

export async function scheduleChatRoomSummaryIfNeeded(input: {
  roomId: string
  userId: string
  roomName?: string | null
  roomMetadata?: Record<string, any> | null
}) {
  if (!shouldScheduleChatRoomSummary(input)) {
    // Match summarize-chat's next incremental batch, rather than lifetime room size.
    const cursor = await prisma.chatMessage.findUnique({
      where: { id: input.roomMetadata!.lastSummarizedMessageId },
      select: { createdAt: true }
    })
    const newMessages = await prisma.chatMessage.findMany({
      where: {
        roomId: input.roomId,
        ...(cursor ? { createdAt: { gt: cursor.createdAt } } : {})
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { content: true }
    })
    if (!shouldScheduleChatRoomSummary({ ...input, newMessages })) {
      return false
    }
  }

  await dispatchTask('summarize-chat', {
    roomId: input.roomId,
    userId: input.userId
  })

  return true
}

export async function executeChatTurn(turnId: string, expectedRunId?: string | null) {
  const turn = await prisma.chatTurn.findUnique({
    where: { id: turnId },
    include: {
      room: {
        select: {
          metadata: true,
          deletedAt: true,
          name: true,
          _count: { select: { messages: true } }
        }
      }
    }
  })

  if (!turn || turn.room.deletedAt) {
    return { success: false, error: 'Turn not found or room deleted.' }
  }
  const activeTurn = turn

  const requestSnapshot = chatTurnService.getRequestSnapshot(turn)
  const submittedMessages = Array.isArray(requestSnapshot.messages) ? requestSnapshot.messages : []
  const lastMessage = submittedMessages[submittedMessages.length - 1]
  const messageParts = Array.isArray(lastMessage?.parts)
    ? lastMessage.parts
    : typeof lastMessage?.content === 'string'
      ? [{ type: 'text', text: lastMessage.content }]
      : Array.isArray(lastMessage?.content)
        ? lastMessage.content
        : []

  const attachedFiles = [
    ...messageParts
      .filter((part: any) => part?.type === 'file' && part?.url && part?.mediaType)
      .map((part: any) => ({
        url: part.url,
        mediaType: part.mediaType,
        filename: part.filename
      })),
    ...(Array.isArray(requestSnapshot.files) ? requestSnapshot.files : [])
  ].filter(
    (file: any, index: number, array: any[]) =>
      file?.url &&
      file?.mediaType &&
      index === array.findIndex((candidate) => candidate?.url === file.url)
  )

  const content =
    requestSnapshot.content ||
    (typeof lastMessage?.content === 'string'
      ? lastMessage.content
      : messageParts
          .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
          .map((p: any) => p.text)
          .join(''))
  const actorUserId =
    requestSnapshot.coachingContext?.actorUserId &&
    requestSnapshot.coachingContext.actorUserId !== turn.userId
      ? requestSnapshot.coachingContext.actorUserId
      : turn.userId

  const startedAt = new Date()
  const executionStartedAtMs = Date.now()
  let currentPhase = 'preflight'
  let slowResponseRecorded = false
  let firstVisibleOutputAt: Date | null = null
  let firstOutputLatencyMs: number | null = null
  let terminalTimeoutReason: string | null = null
  let terminalFailureReason: string | null = null
  const executionAbortController = new AbortController()
  const executionHost = {
    deploymentId:
      process.env.RENDER_GIT_COMMIT ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.TRIGGER_DEPLOYMENT_ID ||
      'unknown',
    serviceId: process.env.RENDER_SERVICE_ID || process.env.FLY_APP_NAME || 'app-worker',
    processId: process.pid
  }

  try {
    await checkQuota(turn.userId, 'chat')
  } catch (error: any) {
    const reason =
      error?.statusCode === 429
        ? error?.message || 'Chat quota exceeded.'
        : error instanceof Error
          ? error.message
          : 'Chat turn failed before execution.'
    const finishedAt = new Date()

    await chatTurnService
      .updateStatus(turn.id, CHAT_TURN_STATUS.FAILED, {
        finishedAt,
        failureReason: reason
      })
      .catch(() => null)

    await sendToUser(turn.userId, {
      type: 'chat_turn_status',
      roomId: turn.roomId,
      turnId: turn.id,
      status: CHAT_TURN_STATUS.FAILED,
      reason: 'turn_failed',
      failureReason: reason,
      quotaExceeded: error?.statusCode === 429
    }).catch(() => null)

    throw error
  }

  const executionRunId = expectedRunId || turn.runId
  const startedTurn = await chatTurnService.tryStartExecution(turn.id, executionRunId, {
    startedAt,
    finishedAt: null,
    failureReason: null,
    metadata: chatTurnService.mergeTurnMetadata(turn, {
      timeoutReason: null,
      slowResponse: false,
      firstOutputLatencyMs: null,
      executionDurationMs: null,
      executionPhase: currentPhase,
      executionHost
    })
  })
  if (!startedTurn) {
    console.warn(
      '[ChatTurn] Execution start skipped because another runner already owns the turn.',
      {
        turnId: activeTurn.id,
        expectedRunId: expectedRunId || turn.runId || null
      }
    )
    return {
      success: false,
      skipped: true,
      reason: 'execution_already_started'
    }
  }
  const ownedRunId = executionRunId!
  await chatTurnService.recordEvent(turn.id, CHAT_TURN_EVENT_TYPE.TURN_STARTED, {
    roomId: turn.roomId,
    userMessageId: turn.userMessageId,
    runId: ownedRunId,
    executionHost
  } as any)

  const heartbeatTimer = setInterval(() => {
    void chatTurnService
      .heartbeatWithTelemetry(turn.id, ownedRunId, {
        executionPhase: currentPhase,
        heartbeatPhaseAt: new Date().toISOString(),
        executionHost
      })
      .then((result) => {
        if (result.count === 0 && !executionAbortController.signal.aborted) {
          terminalFailureReason = 'Turn ownership changed during execution.'
          executionAbortController.abort(terminalFailureReason)
        }
      })
      .catch((error) => {
        console.error('[ChatTurn] Heartbeat keepalive failed:', {
          turnId: activeTurn.id,
          runId: ownedRunId,
          error
        })
      })
  }, CHAT_TURN_HEARTBEAT_INTERVAL_MS)

  const executionTimeoutTimer = setTimeout(() => {
    terminalTimeoutReason = firstVisibleOutputAt
      ? CHAT_TURN_TIMEOUT_REASON.EXECUTION_TIMEOUT
      : CHAT_TURN_TIMEOUT_REASON.FIRST_OUTPUT_TIMEOUT
    terminalFailureReason = getTimeoutFailureMessage(terminalTimeoutReason)
    executionAbortController.abort(terminalFailureReason)
  }, CHAT_TURN_EXECUTION_TIMEOUT_LIMIT_MS)

  let slowResponseTimer: ReturnType<typeof setTimeout> | undefined
  const clearExecutionTimers = () => {
    clearInterval(heartbeatTimer)
    clearTimeout(executionTimeoutTimer)
    if (slowResponseTimer !== undefined) {
      clearTimeout(slowResponseTimer)
    }
  }

  return await (async () => {
    try {
      const earlyUsage = await chatTurnService.startLlmUsage(turn.id, turn.userId, content || '')

      const draft = await chatTurnService.createAssistantDraft({
        turnId: turn.id,
        roomId: turn.roomId,
        status: CHAT_TURN_STATUS.RUNNING,
        existingMessageId: turn.assistantMessageId
      })

      const { systemInstruction: baseSystemInstruction } = await buildAthleteContext(turn.userId, {
        includeDomainToolInstructions: false
      })
      ensureTurnNotAborted()
      const timezone = await getUserTimezone(turn.userId)
      ensureTurnNotAborted()
      const aiSettings = await getUserAiSettings(turn.userId)
      ensureTurnNotAborted()
      const roomMetadata = (turn.room.metadata as any) || {}
      const { globalBlock: globalMemoryBlock, roomBlock: roomMemoryBlock } =
        await userMemoryService.composePromptMemoryBlock({
          userId: turn.userId,
          roomId: turn.roomId,
          memoryEnabled: aiSettings.aiMemoryEnabled
        })
      const roomSummaryBlock = roomMetadata?.historySummary
        ? `## Previous Conversation Summary\n${roomMetadata.historySummary}`
        : ''
      let finalSystemInstruction = [
        globalMemoryBlock,
        roomSummaryBlock,
        roomMemoryBlock,
        baseSystemInstruction
      ]
        .filter(Boolean)
        .join('\n\n')

      const google = createGoogle({
        apiKey: process.env.GEMINI_API_KEY
      })
      const opSettings = await getLlmOperationSettings(turn.userId, 'chat')
      ensureTurnNotAborted()
      const modelName = opSettings.modelId
      const allTools = getToolsWithContext(turn.userId, timezone, aiSettings, turn.roomId, {
        turnId: turn.id,
        lineageId: turn.lineageId,
        roomId: turn.roomId,
        userId: turn.userId,
        actorUserId
      })
      const routedSkillSelection = await classifyChatSkills({
        userId: turn.userId,
        turnId: turn.id,
        messages: submittedMessages,
        roomMetadata,
        requireToolApproval: !!aiSettings?.aiRequireToolApproval,
        nutritionTrackingEnabled: aiSettings?.nutritionTrackingEnabled !== false
      })
      const skillSelection = expandSkillSelectionForRequest(routedSkillSelection, content || '')
      ensureTurnNotAborted()
      const { tools, selectedToolNames, systemInstruction } = await buildTurnExecutionSkillConfig({
        allTools,
        baseSystemInstruction: finalSystemInstruction,
        skillSelection,
        aiRequireToolApproval: !!aiSettings?.aiRequireToolApproval,
        nutritionTrackingEnabled: aiSettings?.nutritionTrackingEnabled !== false
      })
      finalSystemInstruction = systemInstruction
      const availableToolNames = selectedToolNames

      const skillSelectionMetadata = {
        skillIds: skillSelection.skillIds,
        confidence: skillSelection.confidence,
        useTools: skillSelection.useTools,
        extractMemories: !!skillSelection.extractMemories,
        memoryReason: skillSelection.memoryReason || null,
        usedFallback: !!skillSelection.usedFallback,
        source: skillSelection.source || 'router',
        reason: skillSelection.reason || null,
        selectedToolNames,
        requestHistoryMessageCount: submittedMessages.length,
        requestHistoryEstimatedTokens: estimateTokenCount(submittedMessages)
      }

      const runningUpdate = await chatTurnService.updateStatusIfOwned(
        turn.id,
        ownedRunId,
        CHAT_TURN_STATUS.RUNNING,
        {
          metadata: chatTurnService.mergeTurnMetadata(turn, {
            timeoutReason: null,
            slowResponse: false,
            firstOutputLatencyMs: null,
            executionDurationMs: null,
            executionPhase: currentPhase,
            skillSelection: skillSelectionMetadata
          })
        }
      )
      if (runningUpdate.count === 0) {
        throw createAbortError('Turn ownership changed before model execution.')
      }

      const historyToolCalls = new Map<string, any>()
      const currentTurnToolCalls = new Map<string, any>()
      const allToolResults: any[] = []

      let assistantText = ''
      let persistedText = draft.content || ' '
      let lastPersistAt = 0
      let latestUsage: any = null
      const persistToolResultMessages = async (toolResults: any[]) => {
        if (!toolResults.length) return

        const canonicalParts = toolResults.map((toolResult: any) => ({
          type: 'tool-result',
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          result: toolResult.result
        }))

        await chatTurnService.upsertToolResultMessage({
          turnId: turn.id,
          roomId: turn.roomId,
          toolResponses: canonicalParts
        })
      }

      let historyMessages = stripAssistantToolOutputsWhenCanonicalToolMessagesExist(
        normalizeMessagesForSdk(submittedMessages)
      )

      const approvedContinuation = findApprovedToolContinuation(historyMessages)
      if (
        approvedContinuation?.toolName &&
        typeof tools[approvedContinuation.toolName]?.execute === 'function'
      ) {
        const continuationCall = {
          type: 'tool-call',
          toolCallId: approvedContinuation.toolCallId,
          toolName: approvedContinuation.toolName,
          input: approvedContinuation.args,
          args: approvedContinuation.args,
          ...(approvedContinuation.rawToolCall?.providerMetadata
            ? { providerMetadata: approvedContinuation.rawToolCall.providerMetadata }
            : {}),
          ...(approvedContinuation.rawToolCall?.providerOptions
            ? { providerOptions: approvedContinuation.rawToolCall.providerOptions }
            : {})
        }
        historyToolCalls.set(approvedContinuation.toolCallId, continuationCall)
        currentTurnToolCalls.set(approvedContinuation.toolCallId, continuationCall)

        const directResult = await tools[approvedContinuation.toolName].execute(
          approvedContinuation.args,
          {
            toolCallId: approvedContinuation.toolCallId,
            context: {
              turnId: activeTurn.id,
              lineageId: turn.lineageId,
              roomId: turn.roomId,
              userId: turn.userId,
              actorUserId
            }
          }
        )

        const directDetailedResult = {
          toolCallId: approvedContinuation.toolCallId,
          toolName: approvedContinuation.toolName,
          args: approvedContinuation.args,
          result: directResult
        }

        allToolResults.push(directDetailedResult)
        await persistToolResultMessages(allToolResults)

        historyMessages = [
          ...historyMessages,
          {
            role: 'tool',
            parts: [
              {
                type: 'tool-result',
                toolCallId: approvedContinuation.toolCallId,
                toolName: approvedContinuation.toolName,
                result: directResult
              }
            ]
          }
        ]

        if (isMutatingChatTool(approvedContinuation.toolName)) {
          currentPhase = 'completed'
          await markFirstVisibleOutput('tool_step', {
            toolCallCount: 1,
            toolResultCount: 1,
            approvedContinuation: true
          })

          assistantText = buildApprovedContinuationConfirmation(
            approvedContinuation.toolName,
            directResult
          )

          const finishedAt = new Date()
          const executionDurationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())

          await persistDraft(CHAT_TURN_STATUS.COMPLETED, true, {
            hideUntilContent: false,
            hiddenBecauseEmptyFailure: false,
            executionPhase: currentPhase,
            executionDurationMs
          })

          const completedUpdate = await chatTurnService.updateStatusIfOwned(
            turn.id,
            ownedRunId,
            CHAT_TURN_STATUS.COMPLETED,
            {
              finishedAt,
              assistantMessageId: draft.id,
              metadata: chatTurnService.mergeTurnMetadata(turn, {
                timeoutReason: null,
                slowResponse: slowResponseRecorded,
                firstOutputLatencyMs,
                executionDurationMs,
                executionPhase: currentPhase,
                finishedAt: finishedAt.toISOString(),
                skillSelection: skillSelectionMetadata,
                completedLocallyAfterApprovedTool: true
              })
            }
          )
          if (completedUpdate.count === 0) {
            throw createAbortError('Turn ownership changed before local completion.')
          }

          await broadcastAssistantMessage(
            {
              id: draft.id,
              content: assistantText,
              createdAt: draft.createdAt,
              metadata: {
                ...((draft.metadata as any) || {}),
                isDraft: false
              }
            },
            CHAT_TURN_STATUS.COMPLETED,
            { finishedAt, skillSelection: skillSelectionMetadata }
          )

          await chatTurnService.recordEvent(turn.id, CHAT_TURN_EVENT_TYPE.TURN_COMPLETED, {
            assistantMessageId: draft.id,
            firstOutputLatencyMs,
            executionDurationMs,
            completionMode: 'local_after_approved_tool'
          } as any)

          await prisma.llmUsage
            .update({
              where: { id: earlyUsage.id },
              data: {
                model: 'approval_continuation_local',
                success: true,
                errorType: null,
                errorMessage: null,
                durationMs: executionDurationMs,
                ttft: firstOutputLatencyMs,
                responsePreview: assistantText.substring(0, 500)
              }
            })
            .catch(() => null)

          await scheduleChatRoomSummaryIfNeeded({
            roomId: turn.roomId,
            userId: turn.userId,
            roomName: turn.room.name,
            roomMetadata
          }).catch((error) => {
            console.error('[ChatTurn] Failed to schedule chat summary after local completion:', {
              turnId: activeTurn.id,
              roomId: turn.roomId,
              error
            })
          })

          return {
            success: true,
            assistantMessageId: draft.id
          }
        }
      }

      historyMessages = boundMessagesForModel(historyMessages)
      Object.assign(skillSelectionMetadata, {
        boundedHistoryMessageCount: historyMessages.length,
        boundedHistoryEstimatedTokens: estimateTokenCount(historyMessages)
      })

      const coreMessages = sanitizeCoreMessagesForToolApprovals(
        await transformHistoryToCoreMessages(historyMessages)
      )
      ensureTurnNotAborted()
      const normalizedMessages = normalizeCoreMessagesForGemini(coreMessages)

      async function broadcastAssistantMessage(
        message: { id: string; content: string; createdAt: Date; metadata?: any },
        status: string,
        extra: {
          failureReason?: string | null
          finishedAt?: Date | null
          skillSelection?: Record<string, any> | null
        } = {}
      ) {
        await sendToUser(activeTurn.userId, {
          type: 'chat_message_upsert',
          roomId: activeTurn.roomId,
          message: expandStoredChatMessage({
            ...message,
            senderId: 'ai_agent',
            turn: {
              id: activeTurn.id,
              status,
              failureReason: extra.failureReason ?? null,
              startedAt,
              finishedAt: extra.finishedAt ?? null,
              metadata: extra.skillSelection ? { skillSelection: extra.skillSelection } : undefined
            }
          })
        })
      }

      async function broadcastAssistantTextDelta(textDelta: string, status: string) {
        await sendToUser(activeTurn.userId, {
          type: 'chat_assistant_text_delta',
          roomId: activeTurn.roomId,
          turnId: activeTurn.id,
          messageId: draft.id,
          textDelta,
          status
        })
      }

      async function broadcastTurnStatus(reason: string, extra: Record<string, any> = {}) {
        await sendToUser(activeTurn.userId, {
          type: 'chat_turn_status',
          roomId: activeTurn.roomId,
          turnId: activeTurn.id,
          status: extra.status || CHAT_TURN_STATUS.RUNNING,
          reason,
          ...extra
        })
      }

      async function broadcastMemoryEvent(payload: {
        action: 'saved' | 'updated' | 'forgotten'
        memories: any[]
        notice: string
      }) {
        await sendToUser(activeTurn.userId, {
          type: 'chat_memory_event',
          roomId: activeTurn.roomId,
          action: payload.action,
          memories: payload.memories,
          notice: payload.notice
        })
      }

      async function logAttemptUsage(params: {
        attemptIndex: number
        usage: any
        success: boolean
        errorType?: string | null
        errorMessage?: string | null
        responsePreview: string
        durationMs: number
        repairPromptUsed: boolean
      }) {
        try {
          const promptTokens = params.usage?.inputTokens || 0
          const completionTokens = params.usage?.outputTokens || 0
          const cachedTokens = params.usage?.inputTokenDetails?.cacheReadTokens || 0
          const reasoningTokens = params.usage?.outputTokenDetails?.reasoningTokens || 0
          const estimatedCost = calculateLlmCost(
            modelName,
            promptTokens,
            completionTokens + reasoningTokens,
            cachedTokens
          )

          await prisma.llmUsage.create({
            data: {
              userId: activeTurn.userId,
              turnId: activeTurn.id,
              provider: 'gemini',
              model: modelName,
              modelType: aiSettings.aiModelPreference === 'flash' ? 'flash' : 'pro',
              operation: 'chat_attempt',
              entityType: 'ChatTurn',
              entityId: activeTurn.id,
              promptTokens,
              completionTokens,
              cachedTokens,
              reasoningTokens,
              totalTokens: promptTokens + completionTokens,
              estimatedCost,
              durationMs: params.durationMs,
              ttft: firstOutputLatencyMs,
              retryCount: params.attemptIndex,
              success: params.success,
              errorType: params.errorType || null,
              errorMessage: params.errorMessage || null,
              promptPreview: (content || '').substring(0, 500),
              responsePreview: params.responsePreview.substring(0, 500),
              promptFull: JSON.stringify({
                skillSelection: skillSelectionMetadata,
                attemptIndex: params.attemptIndex,
                repairPromptUsed: params.repairPromptUsed
              }).substring(0, 2000)
            }
          })
        } catch (error) {
          console.error('[ChatTurn] Attempt usage log failed:', error)
        }
      }

      async function persistDraft(
        status: string,
        force = false,
        extraMetadata: Record<string, any> = {}
      ) {
        const now = Date.now()
        if (!force && assistantText === persistedText && now - lastPersistAt < 250) return

        const toolCallsUsed = buildPersistedToolCalls(
          Array.from(currentTurnToolCalls.values()),
          allToolResults
        )
        const toolApprovals = Array.isArray(extraMetadata.toolApprovals)
          ? extraMetadata.toolApprovals
          : []
        const hasVisibleOutput = hasVisibleAssistantArtifacts({
          assistantText,
          toolCalls: toolCallsUsed,
          toolApprovals,
          toolResults: allToolResults
        })
        const executionDurationMs = Math.max(0, Date.now() - executionStartedAtMs)
        const runtimeTimeoutReason =
          extraMetadata.timeoutReason ||
          terminalTimeoutReason ||
          (slowResponseRecorded ? CHAT_TURN_TIMEOUT_REASON.SLOW_RESPONSE : null)

        persistedText = assistantText || ' '
        lastPersistAt = now

        const lease = await chatTurnService.heartbeat(activeTurn.id, undefined, ownedRunId)
        if (lease.count === 0) {
          throw createAbortError('Turn ownership changed while persisting the response.')
        }

        const updatedDraft = await chatTurnService.updateAssistantDraft({
          messageId: draft.id,
          content: persistedText,
          metadata: {
            isDraft: status !== CHAT_TURN_STATUS.COMPLETED,
            turnId: activeTurn.id,
            turnStatus: status,
            toolCalls: toolCallsUsed,
            toolsUsed: toolCallsUsed.map((entry: any) => entry.name),
            toolCallCount: toolCallsUsed.length,
            hideUntilContent: status === CHAT_TURN_STATUS.RUNNING && !hasVisibleOutput,
            hiddenBecauseEmptyFailure:
              status !== CHAT_TURN_STATUS.RUNNING &&
              !hasVisibleOutput &&
              !!extraMetadata.hiddenBecauseEmptyFailure,
            slowResponse: slowResponseRecorded,
            timeoutReason: runtimeTimeoutReason,
            firstOutputLatencyMs,
            executionDurationMs,
            executionPhase: extraMetadata.executionPhase || currentPhase,
            ...extraMetadata
          } as any
        })

        const statusHeartbeat = await chatTurnService.heartbeat(
          activeTurn.id,
          status as any,
          ownedRunId
        )
        if (statusHeartbeat.count === 0) {
          throw createAbortError('Turn ownership changed while updating response status.')
        }
        await broadcastAssistantMessage(updatedDraft, status, {
          failureReason:
            typeof extraMetadata.failureReason === 'string' ? extraMetadata.failureReason : null
        })
      }

      const markSlowResponse = async () => {
        if (slowResponseRecorded || firstVisibleOutputAt || terminalTimeoutReason) {
          return
        }

        slowResponseRecorded = true
        await chatTurnService.recordEvent(activeTurn.id, CHAT_TURN_EVENT_TYPE.SLOW_RESPONSE, {
          thresholdMs: CHAT_TURN_SLOW_RESPONSE_LIMIT_MS,
          reason: CHAT_TURN_TIMEOUT_REASON.SLOW_RESPONSE,
          phase: currentPhase
        } as any)
        await persistDraft(CHAT_TURN_STATUS.RUNNING, true, {
          slowResponse: true,
          timeoutReason: CHAT_TURN_TIMEOUT_REASON.SLOW_RESPONSE,
          executionPhase: currentPhase
        })
        await broadcastTurnStatus(CHAT_TURN_TIMEOUT_REASON.SLOW_RESPONSE, {
          phase: currentPhase,
          thresholdMs: CHAT_TURN_SLOW_RESPONSE_LIMIT_MS
        })
      }

      slowResponseTimer = setTimeout(() => {
        void markSlowResponse().catch((error) => {
          console.error('[ChatTurn] Slow response marker failed:', {
            turnId: activeTurn.id,
            error
          })
        })
      }, CHAT_TURN_SLOW_RESPONSE_LIMIT_MS)

      function ensureTurnNotAborted() {
        if (executionAbortController.signal.aborted) {
          throw createAbortError(terminalFailureReason || 'Turn aborted.')
        }
      }

      async function markFirstVisibleOutput(
        source: 'text_delta' | 'tool_step',
        extra: Record<string, any> = {}
      ) {
        if (firstVisibleOutputAt) {
          return
        }

        firstVisibleOutputAt = new Date()
        firstOutputLatencyMs = Math.max(0, firstVisibleOutputAt.getTime() - startedAt.getTime())
        currentPhase = source === 'text_delta' ? 'streaming' : 'tool_step'

        await chatTurnService.recordEvent(
          activeTurn.id,
          CHAT_TURN_EVENT_TYPE.FIRST_OUTPUT_RECEIVED,
          {
            source,
            firstOutputLatencyMs,
            ...extra
          } as any
        )
      }

      await broadcastAssistantMessage(draft, CHAT_TURN_STATUS.RUNNING)
      ensureTurnNotAborted()
      currentPhase = 'awaiting_first_output'

      const providerOptions = getHardcodedChatProviderOptions(opSettings.model, modelName)

      const executeStreamAttempt = async (attemptIndex: number) => {
        let shouldRetryEmptyResponse = false
        const attemptProviderOptions = providerOptions
        const writeRepairPromptUsed = attemptIndex > 0 && shouldUseWriteRepairPrompt(skillSelection)
        const readRepairPromptUsed = attemptIndex > 0 && shouldUseReadRepairPrompt(skillSelection)
        const repairPromptUsed = writeRepairPromptUsed || readRepairPromptUsed
        const attemptSystemInstruction = writeRepairPromptUsed
          ? buildWriteRepairSystemInstruction(finalSystemInstruction)
          : readRepairPromptUsed
            ? buildReadRepairSystemInstruction(finalSystemInstruction)
            : finalSystemInstruction

        if (repairPromptUsed) {
          await chatTurnService.recordEvent(turn.id, CHAT_TURN_EVENT_TYPE.SLOW_RESPONSE, {
            reason: writeRepairPromptUsed
              ? 'empty_response_repair_prompt'
              : 'empty_response_read_repair_prompt',
            attempt: attemptIndex + 1,
            phase: currentPhase
          } as any)
        }

        const result = streamText({
          model: google(modelName),
          instructions: attemptSystemInstruction,
          messages: normalizedMessages,
          tools,
          abortSignal: executionAbortController.signal,
          experimental_repairToolCall: async ({ toolCall, error }) => {
            if (!NoSuchToolError.isInstance(error)) {
              return null
            }

            const repair = findToolNameRepair(toolCall.toolName, availableToolNames)
            if (!repair) {
              return null
            }

            await chatTurnService.recordEvent(turn.id, CHAT_TURN_EVENT_TYPE.TOOL_CALL_REPAIRED, {
              toolCallId: toolCall.toolCallId,
              originalToolName: toolCall.toolName,
              repairedToolName: repair.repairedName,
              strategy: repair.strategy,
              distance: repair.distance ?? null
            } as any)

            return {
              ...toolCall,
              toolName: repair.repairedName
            }
          },
          stopWhen: isStepCount(opSettings.maxSteps),
          providerOptions: attemptProviderOptions,
          onChunk: async ({ chunk }) => {
            if (chunk.type === 'text-delta') {
              const deltaText = chunk.text
              await markFirstVisibleOutput('text_delta')
              assistantText += deltaText
              currentPhase = 'streaming'
              await broadcastAssistantTextDelta(deltaText, CHAT_TURN_STATUS.STREAMING)
              await persistDraft(CHAT_TURN_STATUS.STREAMING)
              await chatTurnService.recordEvent(
                activeTurn.id,
                CHAT_TURN_EVENT_TYPE.ASSISTANT_TEXT_DELTA,
                {
                  textDelta: deltaText
                } as any
              )
            }
          },
          onStepEnd: async ({ toolCalls, toolResults, usage }) => {
            latestUsage = usage
            if (toolCalls) {
              toolCalls.forEach((tc) => {
                historyToolCalls.set(tc.toolCallId, tc)
                currentTurnToolCalls.set(tc.toolCallId, tc)
              })
            }
            if (toolResults) {
              const detailed = toolResults.map((tr: any) => {
                const call = historyToolCalls.get(tr.toolCallId)
                return {
                  ...tr,
                  args: (tr as any).args || (tr as any).input || call?.args || call?.input,
                  toolName: tr.toolName || call?.toolName,
                  result: (tr as any).result || (tr as any).output
                }
              })
              allToolResults.push(...detailed)
              await persistToolResultMessages(allToolResults)
            }

            if (
              !firstVisibleOutputAt &&
              ((toolCalls?.length || 0) > 0 || (toolResults?.length || 0) > 0)
            ) {
              await markFirstVisibleOutput('tool_step', {
                toolCallCount: toolCalls?.length || 0,
                toolResultCount: toolResults?.length || 0
              })
            }

            currentPhase = toolCalls?.length ? 'tool_step' : 'streaming'

            await persistDraft(
              toolCalls?.length ? CHAT_TURN_STATUS.WAITING_FOR_TOOLS : CHAT_TURN_STATUS.STREAMING,
              true,
              {
                executionPhase: currentPhase
              }
            )
          },
          onEnd: async (event) => {
            const { text, toolResults: finalStepResults, usage, toolCalls: finalCalls } = event
            latestUsage = usage
            assistantText = text || assistantText
            currentPhase = 'completed'
            const hasMeaningfulText =
              typeof assistantText === 'string' && assistantText.trim().length > 0
            const executedToolCallIds = new Set([
              ...(finalStepResults || []).map((result: any) => result.toolCallId),
              ...allToolResults.map((result: any) => result.toolCallId)
            ])
            const pendingApprovals = (finalCalls || [])
              .filter((call: any) => !executedToolCallIds.has(call.toolCallId))
              .map((call: any) => ({
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                args: call.args || call.input
              }))
            const shouldFallbackForEmptyResponse =
              !hasMeaningfulText && pendingApprovals.length === 0

            if (
              shouldFallbackForEmptyResponse &&
              shouldRetryEmptyToolResponse(attemptIndex, allToolResults)
            ) {
              shouldRetryEmptyResponse = true
              currentPhase = 'retrying_empty_response'
              await logAttemptUsage({
                attemptIndex,
                usage,
                success: false,
                errorType: 'EMPTY_RESPONSE_RETRY',
                errorMessage: 'LLM response finished empty on initial attempt; retrying.',
                responsePreview: '',
                durationMs: Math.max(0, Date.now() - startedAt.getTime()),
                repairPromptUsed
              })
              await chatTurnService.recordEvent(turn.id, CHAT_TURN_EVENT_TYPE.SLOW_RESPONSE, {
                reason: 'empty_response_retry',
                attempt: attemptIndex + 1,
                phase: currentPhase
              } as any)
              return
            }

            if (shouldFallbackForEmptyResponse) {
              assistantText =
                buildEmptyResponseFallbackFromToolResults(allToolResults) || EMPTY_RESPONSE_FALLBACK
            }

            const recoveredEmptyResponse =
              shouldFallbackForEmptyResponse && assistantText !== EMPTY_RESPONSE_FALLBACK

            if (finalStepResults?.length) {
              const finalDetailedResults = finalStepResults.map((tr: any) => {
                const call =
                  finalCalls?.find((tc: any) => tc.toolCallId === tr.toolCallId) ||
                  historyToolCalls.get(tr.toolCallId)
                return {
                  ...tr,
                  args: tr.args || call?.args || call?.input,
                  toolName: tr.toolName || call?.toolName,
                  result: tr.result || tr.output
                }
              })
              allToolResults.push(...finalDetailedResults)
              await persistToolResultMessages(allToolResults)
            }

            if (
              !firstVisibleOutputAt &&
              hasVisibleAssistantArtifacts({
                assistantText,
                toolCalls: finalCalls,
                toolResults: finalStepResults
              })
            ) {
              await markFirstVisibleOutput(
                assistantText.trim().length > 0 ? 'text_delta' : 'tool_step',
                {
                  toolCallCount: finalCalls?.length || 0,
                  toolResultCount: finalStepResults?.length || 0
                }
              )
            }

            const finishedAt = new Date()
            const executionDurationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())

            // Detect tool calls blocked by needsApproval: present in finalCalls but absent from results
            await persistDraft(CHAT_TURN_STATUS.COMPLETED, true, {
              hideUntilContent: false,
              hiddenBecauseEmptyFailure: false,
              executionPhase: currentPhase,
              executionDurationMs,
              ...(pendingApprovals.length > 0 ? { pendingApprovals } : {})
            })

            const completedUpdate = await chatTurnService.updateStatusIfOwned(
              turn.id,
              ownedRunId,
              CHAT_TURN_STATUS.COMPLETED,
              {
                finishedAt,
                assistantMessageId: draft.id,
                metadata: chatTurnService.mergeTurnMetadata(turn, {
                  timeoutReason:
                    terminalTimeoutReason ||
                    (slowResponseRecorded ? CHAT_TURN_TIMEOUT_REASON.SLOW_RESPONSE : null),
                  slowResponse: slowResponseRecorded,
                  firstOutputLatencyMs,
                  executionDurationMs,
                  executionPhase: currentPhase,
                  finishedAt: finishedAt.toISOString(),
                  skillSelection: skillSelectionMetadata
                })
              }
            )
            if (completedUpdate.count === 0) {
              throw createAbortError('Turn ownership changed before completion.')
            }
            await broadcastAssistantMessage(
              {
                id: draft.id,
                content: assistantText || ' ',
                createdAt: draft.createdAt,
                metadata: {
                  ...((draft.metadata as any) || {}),
                  isDraft: false
                }
              },
              CHAT_TURN_STATUS.COMPLETED,
              { finishedAt, skillSelection: skillSelectionMetadata }
            )

            await chatTurnService.recordEvent(turn.id, CHAT_TURN_EVENT_TYPE.TURN_COMPLETED, {
              assistantMessageId: draft.id,
              firstOutputLatencyMs,
              executionDurationMs
            } as any)
            await broadcastTurnStatus('turn_completed', {
              status: CHAT_TURN_STATUS.COMPLETED,
              assistantMessageId: draft.id,
              executionDurationMs,
              firstOutputLatencyMs
            })

            await prisma.llmUsage
              .update({
                where: { id: earlyUsage.id },
                data: {
                  model: modelName,
                  success: !shouldFallbackForEmptyResponse || recoveredEmptyResponse,
                  errorType: shouldFallbackForEmptyResponse
                    ? recoveredEmptyResponse
                      ? 'EMPTY_RESPONSE_RECOVERED'
                      : 'EMPTY_RESPONSE'
                    : null,
                  errorMessage: shouldFallbackForEmptyResponse
                    ? 'LLM response finished with empty text.'
                    : null,
                  durationMs: executionDurationMs,
                  ttft: firstOutputLatencyMs,
                  responsePreview: assistantText.substring(0, 500),
                  retryCount: attemptIndex
                }
              })
              .catch(() => null)

            await logAttemptUsage({
              attemptIndex,
              usage,
              success: !shouldFallbackForEmptyResponse || recoveredEmptyResponse,
              errorType: shouldFallbackForEmptyResponse
                ? recoveredEmptyResponse
                  ? 'EMPTY_RESPONSE_RECOVERED'
                  : 'EMPTY_RESPONSE'
                : null,
              errorMessage: shouldFallbackForEmptyResponse
                ? 'LLM response finished with empty text.'
                : null,
              responsePreview: assistantText,
              durationMs: executionDurationMs,
              repairPromptUsed
            })

            try {
              const promptTokens = usage.inputTokens || 0
              const completionTokens = usage.outputTokens || 0
              const cachedTokens = usage.inputTokenDetails?.cacheReadTokens || 0
              const reasoningTokens = usage?.outputTokenDetails?.reasoningTokens || 0
              const estimatedCost = calculateLlmCost(
                modelName,
                promptTokens,
                completionTokens + reasoningTokens,
                cachedTokens
              )

              await prisma.llmUsage.create({
                data: {
                  userId: turn.userId,
                  turnId: activeTurn.id,
                  provider: 'gemini',
                  model: modelName,
                  modelType: aiSettings.aiModelPreference === 'flash' ? 'flash' : 'pro',
                  operation: 'chat',
                  entityType: 'ChatMessage',
                  entityId: draft.id,
                  promptTokens,
                  completionTokens,
                  cachedTokens,
                  reasoningTokens,
                  totalTokens: promptTokens + completionTokens,
                  estimatedCost,
                  durationMs: executionDurationMs,
                  ttft: firstOutputLatencyMs,
                  retryCount: 0,
                  success: !shouldFallbackForEmptyResponse || recoveredEmptyResponse,
                  errorType: shouldFallbackForEmptyResponse
                    ? recoveredEmptyResponse
                      ? 'EMPTY_RESPONSE_RECOVERED'
                      : 'EMPTY_RESPONSE'
                    : null,
                  errorMessage: shouldFallbackForEmptyResponse
                    ? 'LLM response finished with empty text.'
                    : null,
                  promptPreview: (content || '').substring(0, 500),
                  responsePreview: assistantText.substring(0, 500),
                  promptFull: JSON.stringify(skillSelectionMetadata).substring(0, 2000)
                }
              })
            } catch (error) {
              console.error('[ChatTurn] LLM usage log failed:', error)
            }

            await scheduleChatRoomSummaryIfNeeded({
              roomId: turn.roomId,
              userId: turn.userId,
              roomName: turn.room.name,
              roomMetadata
            }).catch((error) => {
              console.error('[ChatTurn] Failed to schedule chat summary after completion:', {
                turnId: activeTurn.id,
                roomId: turn.roomId,
                error
              })
            })

            if (aiSettings.aiMemoryEnabled && skillSelection.extractMemories && content?.trim()) {
              const existingMemories = await userMemoryService.listMemories({ userId: turn.userId })
              const extraction = await extractMemoryCandidatesFromConversation({
                userId: turn.userId,
                roomId: turn.roomId,
                turnId: activeTurn.id,
                messages: [
                  { role: 'user', content },
                  ...(assistantText.trim()
                    ? [{ role: 'assistant' as const, content: assistantText.trim() }]
                    : [])
                ],
                existingMemories: existingMemories.map((memory) => ({
                  scope: memory.scope,
                  content: memory.content
                })),
                operation: 'chat-memory-extract',
                entityType: 'ChatTurn',
                entityId: turn.id
              })

              const savedMemories = await userMemoryService.saveMemoryCandidates({
                userId: turn.userId,
                candidates: extraction.candidates
              })

              if (savedMemories.length > 0) {
                await broadcastMemoryEvent({
                  action: 'saved',
                  memories: savedMemories,
                  notice:
                    savedMemories.length === 1
                      ? 'Saved 1 memory from this conversation.'
                      : `Saved ${savedMemories.length} memories from this conversation.`
                }).catch((error) => {
                  console.error('[ChatTurn] Failed to broadcast auto-saved memory event:', {
                    turnId: activeTurn.id,
                    roomId: turn.roomId,
                    error
                  })
                })
              }
            }

            const memoryToolEvent = buildMemoryEventFromToolResults(allToolResults)
            if (memoryToolEvent && memoryToolEvent.memories.length > 0) {
              await broadcastMemoryEvent(memoryToolEvent).catch((error) => {
                console.error('[ChatTurn] Failed to broadcast tool-driven memory event:', {
                  turnId: activeTurn.id,
                  roomId: turn.roomId,
                  error
                })
              })
            }
          }
        })

        let streamError: Error | undefined
        await result.consumeStream({
          onError: (error) => {
            streamError = error instanceof Error ? error : new Error(String(error))
            console.error('[ChatTurn] Mid-stream error from LLM:', streamError.message)
          }
        })
        if (streamError) {
          throw streamError
        }

        return shouldRetryEmptyResponse
      }

      try {
        const maxEmptyResponseAttempts = 2
        for (let attemptIndex = 0; attemptIndex < maxEmptyResponseAttempts; attemptIndex += 1) {
          const shouldRetry = await executeStreamAttempt(attemptIndex)
          if (!shouldRetry) break

          assistantText = ''
          persistedText = draft.content || ' '
          lastPersistAt = 0
          latestUsage = null
          currentPhase = 'awaiting_first_output'
        }

        return {
          success: true,
          assistantMessageId: draft.id
        }
      } catch (error: any) {
        const isExplicitTimeout =
          terminalTimeoutReason === CHAT_TURN_TIMEOUT_REASON.FIRST_OUTPUT_TIMEOUT ||
          terminalTimeoutReason === CHAT_TURN_TIMEOUT_REASON.EXECUTION_TIMEOUT
        const terminalStatus = isExplicitTimeout
          ? CHAT_TURN_STATUS.FAILED
          : error?.name === 'AbortError'
            ? CHAT_TURN_STATUS.INTERRUPTED
            : CHAT_TURN_STATUS.FAILED
        const reason =
          terminalFailureReason ||
          (error?.name === 'AbortError' ? 'Turn aborted.' : error?.message || 'Chat turn failed.')
        const finishedAt = new Date()
        const executionDurationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())
        const hiddenBecauseEmptyFailure = !hasVisibleAssistantArtifacts({
          assistantText,
          toolCalls: Array.from(currentTurnToolCalls.values()),
          toolResults: allToolResults
        })

        currentPhase = isExplicitTimeout ? currentPhase : 'failed'

        await persistDraft(terminalStatus, true, {
          interrupted: terminalStatus === CHAT_TURN_STATUS.INTERRUPTED,
          failureReason: reason,
          timeoutReason: terminalTimeoutReason,
          hiddenBecauseEmptyFailure,
          hideUntilContent: false,
          executionPhase: currentPhase,
          executionDurationMs
        }).catch(() => null)
        const terminalUpdate = await chatTurnService.updateStatusIfOwned(
          turn.id,
          ownedRunId,
          terminalStatus,
          {
            finishedAt,
            failureReason: reason,
            assistantMessageId: draft.id,
            metadata: chatTurnService.mergeTurnMetadata(turn, {
              timeoutReason:
                terminalTimeoutReason ||
                (slowResponseRecorded ? CHAT_TURN_TIMEOUT_REASON.SLOW_RESPONSE : null),
              slowResponse: slowResponseRecorded,
              firstOutputLatencyMs,
              executionDurationMs,
              executionPhase: currentPhase,
              finishedAt: finishedAt.toISOString(),
              skillSelection: skillSelectionMetadata
            })
          }
        )
        if (terminalUpdate.count === 0) {
          throw error
        }
        await broadcastAssistantMessage(
          {
            id: draft.id,
            content: assistantText || ' ',
            createdAt: draft.createdAt,
            metadata: {
              ...((draft.metadata as any) || {}),
              isDraft: false,
              interrupted: terminalStatus === CHAT_TURN_STATUS.INTERRUPTED,
              failureReason: reason
            }
          },
          terminalStatus,
          { failureReason: reason, finishedAt, skillSelection: skillSelectionMetadata }
        ).catch(() => null)
        await chatTurnService.recordEvent(
          turn.id,
          terminalStatus === CHAT_TURN_STATUS.INTERRUPTED
            ? CHAT_TURN_EVENT_TYPE.TURN_INTERRUPTED
            : CHAT_TURN_EVENT_TYPE.TURN_FAILED,
          {
            reason:
              terminalTimeoutReason ||
              (terminalStatus === CHAT_TURN_STATUS.INTERRUPTED ? 'interrupted' : 'failed'),
            failureReason: reason,
            firstOutputLatencyMs,
            executionDurationMs,
            phase: currentPhase
          } as any
        )
        await broadcastTurnStatus(
          terminalStatus === CHAT_TURN_STATUS.INTERRUPTED ? 'turn_interrupted' : 'turn_failed',
          {
            status: terminalStatus,
            assistantMessageId: draft.id,
            executionDurationMs,
            firstOutputLatencyMs,
            failureReason: reason
          }
        ).catch(() => null)
        await prisma.llmUsage
          .update({
            where: { id: earlyUsage.id },
            data: {
              model: modelName,
              success: false,
              errorType:
                (terminalTimeoutReason ? String(terminalTimeoutReason).toUpperCase() : '') ||
                (terminalStatus === CHAT_TURN_STATUS.INTERRUPTED ? 'INTERRUPTED' : 'FAILED'),
              errorMessage: reason,
              durationMs: executionDurationMs,
              ttft: firstOutputLatencyMs
            }
          })
          .catch(() => null)
        throw error
      }
    } catch (error: any) {
      const activeStatuses = [
        CHAT_TURN_STATUS.RUNNING,
        CHAT_TURN_STATUS.STREAMING,
        CHAT_TURN_STATUS.WAITING_FOR_TOOLS,
        CHAT_TURN_STATUS.RECEIVED
      ]
      const reason =
        error?.statusCode === 429
          ? error?.message || 'Chat quota exceeded.'
          : error instanceof Error
            ? error.message
            : 'Chat turn failed during execution.'

      const failedUpdate = await prisma.chatTurn
        .updateMany({
          where: {
            id: turn.id,
            runId: ownedRunId,
            status: { in: activeStatuses }
          },
          data: {
            status: CHAT_TURN_STATUS.FAILED,
            finishedAt: new Date(),
            failureReason: reason,
            lastHeartbeatAt: new Date()
          }
        })
        .catch(() => ({ count: 0 }))

      if (failedUpdate.count > 0) {
        await sendToUser(turn.userId, {
          type: 'chat_turn_status',
          roomId: turn.roomId,
          turnId: turn.id,
          status: CHAT_TURN_STATUS.FAILED,
          reason: 'turn_failed',
          failureReason: reason,
          quotaExceeded: error?.statusCode === 429
        }).catch(() => null)
      }

      throw error
    } finally {
      clearExecutionTimers()
    }
  })()
}
