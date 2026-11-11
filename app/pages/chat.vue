<script setup lang="ts">
  import {
    ref,
    computed,
    onMounted,
    onBeforeUnmount,
    defineAsyncComponent,
    watch,
    nextTick,
    provide
  } from 'vue'
  import { useTranslate } from '@tolgee/vue'
  import { Chat } from '@ai-sdk/vue'
  import { DefaultChatTransport } from 'ai'
  import ChatSidebar from '~/components/chat/ChatSidebar.vue'
  import ChatMessageList from '~/components/chat/ChatMessageList.vue'
  import ChatInput from '~/components/chat/ChatInput.vue'
  import { shouldHideAssistantBubble } from '~/utils/chat-message-state'
  import {
    CHAT_OUTGOING_QUEUE_STORAGE_KEY,
    clearChatOutgoingQueue,
    createChatSendAttemptTracker,
    dispatchChatOutgoing
  } from '~/utils/chat-outgoing-queue'

  const { t } = useTranslate('chat')

  const DashboardTriggerMonitorButton = defineAsyncComponent(
    () => import('~/components/dashboard/TriggerMonitorButton.vue')
  )

  definePageMeta({
    middleware: 'auth'
  })

  useHead({
    title: 'AI Chat Coach',
    meta: [
      {
        name: 'description',
        content:
          'Chat with your AI endurance coach to analyze your training, ask questions, and get personalized advice.'
      }
    ]
  })

  // State
  const currentRoomId = ref('')
  const loadingMessages = ref(true)
  const messagesLoadError = ref<string | null>(null)
  const roomsLoadError = ref<string | null>(null)
  const rooms = ref<any[]>([])
  const loadingRooms = ref(true)
  const chatSidebarRef = ref<{ open: () => void; close: () => void } | null>(null)
  const input = ref('')
  const pendingComposerDraft = ref('')
  const quotaSystemNotices = ref<any[]>([])
  const chatInputRef = ref<any>(null)
  const toast = useToast()
  const editingMessage = ref<any | null>(null)
  const editingContent = ref('')
  const savingEditedMessage = ref(false)
  const chatViewportHeight = ref('100dvh')
  let visualViewportListener: (() => void) | null = null
  let previousDocumentOverflow = ''
  let previousBodyOverflow = ''
  let turnPollingTimer: ReturnType<typeof setInterval> | null = null
  let turnPollingGraceUntil = 0
  let chatWs: WebSocket | null = null
  let chatWsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  let chatWsPingTimer: ReturnType<typeof setInterval> | null = null
  const slowTurnNoticeIds = new Set<string>()
  const queueReconcileTimersByRoom: Record<string, ReturnType<typeof setTimeout> | undefined> = {}
  const terminalSyncTimersByRoom: Record<string, ReturnType<typeof setTimeout> | undefined> = {}
  const approvalSyncTimersByRoom: Record<string, ReturnType<typeof setInterval> | undefined> = {}
  let chatPageActive = true
  const loadMessagesInFlight: Record<string, boolean> = {}
  const loadMessagesPending: Record<string, boolean> = {}
  const isRealtimeConnected = ref(false)
  const lastChatRealtimeEventAt = ref(0)
  const awaitingTurnStart = ref(false)
  type QueuedAttachment = {
    url: string
    mediaType: string
    filename?: string
  }
  type QueuedOutgoingMessage = {
    id: string
    roomId: string
    text: string
    attachments: QueuedAttachment[]
    createdAt: Date
    failed?: boolean
  }
  type ChatRoomStateSnapshot = {
    latestMessageId: string | null
    latestMessageCreatedAt: string | null
    latestMessageUpdatedAt: string | null
    latestMessageSenderId: string | null
    activeTurnId: string | null
    activeTurnStatus: string | null
    activeTurnUpdatedAt: string | null
    hasAssistantMessage: boolean
  }
  const CHAT_QUEUE_STORAGE_KEY = CHAT_OUTGOING_QUEUE_STORAGE_KEY

  type SerializedQueuedOutgoingMessage = Omit<QueuedOutgoingMessage, 'createdAt'> & {
    createdAt: string
  }

  const loadPersistedOutgoingQueue = (): Record<string, QueuedOutgoingMessage[]> => {
    if (!import.meta.client) return {}

    try {
      const raw = sessionStorage.getItem(CHAT_QUEUE_STORAGE_KEY)
      if (!raw) return {}

      const parsed = JSON.parse(raw) as Record<string, SerializedQueuedOutgoingMessage[]>
      return Object.fromEntries(
        Object.entries(parsed).map(([roomId, messages]) => [
          roomId,
          messages.map((message) => ({
            ...message,
            createdAt: new Date(message.createdAt)
          }))
        ])
      )
    } catch {
      return {}
    }
  }

  const persistOutgoingQueue = (state: Record<string, QueuedOutgoingMessage[]>) => {
    if (!import.meta.client) return

    const serialized = Object.fromEntries(
      Object.entries(state).map(([roomId, messages]) => [
        roomId,
        messages.map((message) => ({
          ...message,
          createdAt: message.createdAt.toISOString()
        }))
      ])
    )
    sessionStorage.setItem(CHAT_QUEUE_STORAGE_KEY, JSON.stringify(serialized))
  }

  const queuedOutgoingByRoom = ref<Record<string, QueuedOutgoingMessage[]>>(
    loadPersistedOutgoingQueue()
  )
  const queueDispatchInFlightByRoom = ref<Record<string, boolean>>({})
  const roomStateSignaturesByRoom = ref<Record<string, string>>({})

  // Fetch session
  const { data: session } = await useFetch('/api/auth/session')

  const { refresh: refreshRuns } = useUserRuns()
  const { showQuotaPaywall, getOperationQuota } = useQuotaPaywall()
  const { formatRelativeTime } = useFormat()

  async function handleChatQuotaExceeded() {
    const quota = await getOperationQuota('chat')
    const resetLabel = quota?.resetsAt ? formatRelativeTime(quota.resetsAt) : 'soon'

    if (pendingComposerDraft.value) {
      input.value = pendingComposerDraft.value
    }

    const roomId = currentRoomId.value
    if (roomId) {
      quotaSystemNotices.value = quotaSystemNotices.value.filter(
        (notice) => notice.roomId !== roomId
      )
      quotaSystemNotices.value.push({
        id: `quota-notice-${roomId}`,
        roomId,
        role: 'assistant',
        content: `Free chat limit reached. Resets ${resetLabel}.`,
        metadata: { systemNotice: 'quota_exceeded' },
        createdAt: new Date()
      })
    }

    await showQuotaPaywall({
      operation: 'chat',
      title: 'Unlock More Coach Messages',
      featureTitle: 'AI Coach Chat',
      reason: 'quota_exceeded',
      quota,
      quotaResetLabel: quota?.resetsAt ? `Resets ${resetLabel}` : undefined
    })
  }
  const userStore = useUserStore()
  const coachingStore = useCoachingStore()
  const { trackChatSessionStart, trackChatError } = useAnalytics()

  watch(
    queuedOutgoingByRoom,
    (value) => {
      persistOutgoingQueue(value)
    },
    { deep: true }
  )

  const route = useRoute()
  const router = useRouter()

  const outgoingSendAttempts = createChatSendAttemptTracker()

  // Initialize Chat class
  const chat = new Chat({
    transport: new DefaultChatTransport({
      api: '/api/chat/messages',
      body: () => ({
        roomId: currentRoomId.value
      })
    }),
    onFinish: async () => {
      if (!chatPageActive) return
      pendingComposerDraft.value = ''
      refreshRuns()
      if (currentRoomId.value) {
        await loadMessages(currentRoomId.value, { silent: true })
        if (!chatPageActive) return
        restartTurnPolling({ forceForMs: 15000 })
        void processQueuedMessagesForRoom(currentRoomId.value)
      }
    },
    onError: (error) => {
      const errorRoomId = outgoingSendAttempts.roomId || currentRoomId.value
      outgoingSendAttempts.onError(error)
      // A send finishing in another room must not reset the current composer.
      if (errorRoomId === currentRoomId.value) awaitingTurnStart.value = false

      // Track chat error
      trackChatError(error.message || 'unknown')

      // Handle Quota Exceeded (429)
      if (
        error.message?.includes('429') ||
        error.message?.toLowerCase().includes('quota exceeded')
      ) {
        if (errorRoomId === currentRoomId.value) void handleChatQuotaExceeded()
        return
      }

      if (error.message && error.message.includes('No tool invocation found')) {
        console.warn(
          '[Chat] Suppressing expected tool invocation error. Refreshing chat to get response.'
        )
        // The backend executed successfully, but the frontend stream parser got confused.
        // We can just reload the messages to show the result.
        setTimeout(() => {
          if (chatPageActive && errorRoomId === currentRoomId.value) loadMessages(errorRoomId)
        }, 1000)
        return
      }
      console.error('[Chat] onError triggered:', error)
      console.error('[Chat] Error Stack:', error.stack)
    }
  })

  const sanitizeDisplayMessage = (message: any) => {
    const sanitizeText = (value: unknown) => {
      if (typeof value !== 'string') return ''
      return /^(undefined)+$/.test(value) ? '' : value
    }

    const parts = Array.isArray(message?.parts)
      ? message.parts
          .map((part: any) =>
            part?.type === 'text'
              ? {
                  ...part,
                  text: sanitizeText(part.text)
                }
              : part
          )
          .filter((part: any) => part?.type !== 'text' || part.text)
      : []

    const sanitizedContent = sanitizeText(message?.content)
    const hasMeaningfulText = sanitizedContent.trim().length > 0
    const hasRenderableParts = parts.length > 0

    if (
      message?.role === 'assistant' &&
      !message?.metadata?.turnId &&
      !hasMeaningfulText &&
      !hasRenderableParts
    ) {
      return null
    }

    return {
      ...message,
      content: sanitizedContent,
      parts
    }
  }
  const chatStatus = computed(() => chat.status)
  const activeTurnStatuses = ['RECEIVED', 'QUEUED', 'RUNNING', 'STREAMING', 'WAITING_FOR_TOOLS']
  const terminalTurnStatuses = ['COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED']
  const getLatestAssistantMessage = (
    messages: any[],
    options: {
      includeHidden?: boolean
    } = {}
  ) =>
    [...messages]
      .reverse()
      .find(
        (message) =>
          message?.role === 'assistant' &&
          !message?.metadata?.syntheticTyping &&
          (options.includeHidden !== false || !shouldHideAssistantBubble(message))
      )
  const hasActiveTurn = (messages: any[]) =>
    activeTurnStatuses.includes(
      getLatestAssistantMessage(messages, { includeHidden: true })?.metadata?.turnStatus
    )
  const getQueuedOutgoingMessages = (roomId: string) =>
    roomId ? queuedOutgoingByRoom.value[roomId] || [] : []
  const queuedOutgoingMessages = computed(() => getQueuedOutgoingMessages(currentRoomId.value))
  const queuedMessageCount = computed(() => queuedOutgoingMessages.value.length)
  const serializeRoomState = (state: ChatRoomStateSnapshot | null | undefined) =>
    JSON.stringify(state || null)
  const serializePollableRoomState = (state: ChatRoomStateSnapshot | null | undefined) => {
    if (!state) return 'null'
    const { activeTurnUpdatedAt: _activeTurnUpdatedAt, ...pollableState } = state
    return JSON.stringify(pollableState)
  }
  const setRoomStateSignature = (roomId: string, signature: string) => {
    roomStateSignaturesByRoom.value = {
      ...roomStateSignaturesByRoom.value,
      [roomId]: signature
    }
  }
  const getRoomStateSignature = (roomId: string) =>
    roomId ? roomStateSignaturesByRoom.value[roomId] || '' : ''
  const getPollableRoomStateSignature = (roomId: string) => {
    const raw = getRoomStateSignature(roomId)
    if (!raw) return ''
    try {
      return serializePollableRoomState(JSON.parse(raw) as ChatRoomStateSnapshot)
    } catch {
      return ''
    }
  }
  const buildRoomStateFromMessages = (messages: any[]): ChatRoomStateSnapshot => {
    const latestUpdatedMessage = [...messages].sort(
      (left, right) =>
        new Date(
          right?.updatedAt || right?.metadata?.updatedAt || right?.createdAt || 0
        ).getTime() -
        new Date(left?.updatedAt || left?.metadata?.updatedAt || left?.createdAt || 0).getTime()
    )[0]
    const activeAssistantTurn = [...messages]
      .reverse()
      .find((message) => activeTurnStatuses.includes(String(message?.metadata?.turnStatus || '')))

    return {
      latestMessageId: latestUpdatedMessage?.id || null,
      latestMessageCreatedAt: latestUpdatedMessage?.createdAt
        ? new Date(latestUpdatedMessage.createdAt).toISOString()
        : null,
      latestMessageUpdatedAt:
        latestUpdatedMessage?.updatedAt || latestUpdatedMessage?.metadata?.updatedAt || null,
      latestMessageSenderId: latestUpdatedMessage?.metadata?.senderId || null,
      activeTurnId: activeAssistantTurn?.metadata?.turnId || null,
      activeTurnStatus: activeAssistantTurn?.metadata?.turnStatus || null,
      activeTurnUpdatedAt: activeAssistantTurn?.metadata?.updatedAt || null,
      hasAssistantMessage: messages.some((message) => message?.role === 'assistant')
    }
  }
  const buildMessageParts = (text: string, attachments: QueuedAttachment[]) => {
    const parts: Array<Record<string, any>> = []

    if (text.trim()) {
      parts.push({ type: 'text', text })
    }

    attachments.forEach((attachment) => {
      if (!attachment?.url || !attachment?.mediaType) return
      parts.push({
        type: 'file',
        url: attachment.url,
        mediaType: attachment.mediaType,
        filename: attachment.filename
      })
    })

    return parts
  }
  const setQueuedOutgoingMessages = (roomId: string, messages: QueuedOutgoingMessage[]) => {
    queuedOutgoingByRoom.value = {
      ...queuedOutgoingByRoom.value,
      [roomId]: messages
    }
  }
  const enqueueOutgoingMessage = (message: QueuedOutgoingMessage) => {
    setQueuedOutgoingMessages(message.roomId, [
      ...getQueuedOutgoingMessages(message.roomId),
      message
    ])
  }
  const setQueueDispatchInFlight = (roomId: string, inFlight: boolean) => {
    queueDispatchInFlightByRoom.value = {
      ...queueDispatchInFlightByRoom.value,
      [roomId]: inFlight
    }
  }
  const clearQueueReconcileTimer = (roomId: string) => {
    const timer = queueReconcileTimersByRoom[roomId]
    if (!timer) return
    clearTimeout(timer)
    queueReconcileTimersByRoom[roomId] = undefined
  }
  const clearTerminalSyncTimer = (roomId: string) => {
    const timer = terminalSyncTimersByRoom[roomId]
    if (!timer) return
    clearTimeout(timer)
    terminalSyncTimersByRoom[roomId] = undefined
  }
  const clearApprovalSyncTimer = (roomId: string) => {
    const timer = approvalSyncTimersByRoom[roomId]
    if (!timer) return
    clearInterval(timer)
    approvalSyncTimersByRoom[roomId] = undefined
  }
  const getLatestAssistantTurnTimestamp = () => {
    const latestAssistant = [...((chat.messages as any[]) || [])]
      .reverse()
      .find((message) => message?.role === 'assistant' && !message?.metadata?.syntheticTyping)

    const rawTimestamp =
      latestAssistant?.updatedAt ||
      latestAssistant?.metadata?.updatedAt ||
      latestAssistant?.createdAt ||
      null

    const timestampMs = rawTimestamp ? new Date(rawTimestamp).getTime() : 0
    return Number.isFinite(timestampMs) ? timestampMs : 0
  }
  const startApprovalSync = (roomId: string, approvalSubmittedAtMs: number) => {
    if (!roomId || roomId !== currentRoomId.value) return

    clearApprovalSyncTimer(roomId)

    const startedAtMs = Date.now()
    approvalSyncTimersByRoom[roomId] = setInterval(async () => {
      if (!currentRoomId.value || roomId !== currentRoomId.value) {
        clearApprovalSyncTimer(roomId)
        return
      }

      await loadMessages(roomId, { silent: true })

      const latestAssistantTimestampMs = getLatestAssistantTurnTimestamp()
      const hasFreshAssistantMessage = latestAssistantTimestampMs > approvalSubmittedAtMs
      const turnStillActive =
        awaitingTurnStart.value || hasActiveTurn((chat.messages as any[]) || [])

      if (hasFreshAssistantMessage && !turnStillActive) {
        clearApprovalSyncTimer(roomId)
        return
      }

      if (Date.now() - startedAtMs >= 15000) {
        clearApprovalSyncTimer(roomId)
      }
    }, 1200)
  }
  const scheduleTerminalMessageSync = (roomId?: string, delayMs = 150) => {
    if (!roomId || roomId !== currentRoomId.value) return
    clearTerminalSyncTimer(roomId)
    terminalSyncTimersByRoom[roomId] = setTimeout(() => {
      terminalSyncTimersByRoom[roomId] = undefined
      void loadMessages(roomId, { silent: true })
    }, delayMs)
  }
  const scheduleQueueReconcile = (roomId: string, delayMs = 12000) => {
    if (!roomId) return
    clearQueueReconcileTimer(roomId)
    queueReconcileTimersByRoom[roomId] = setTimeout(() => {
      queueReconcileTimersByRoom[roomId] = undefined
      if (!currentRoomId.value || roomId !== currentRoomId.value) return
      void loadMessages(roomId, { silent: true })
    }, delayMs)
  }
  const sendOutgoingMessage = async (message: {
    roomId: string
    id: string
    text: string
    attachments: QueuedAttachment[]
  }) => {
    const parts = buildMessageParts(message.text, message.attachments)
    await outgoingSendAttempts.send(message.roomId, () =>
      (chat as any).sendMessage(
        parts.length > 0
          ? {
              // Reusing the same client-generated id across attempts lets the server
              // recognize a retry of an already-persisted message (see
              // server/api/chat/messages.post.ts) instead of creating a duplicate.
              id: message.id,
              role: 'user',
              parts
            }
          : {
              text: message.text
            },
        { body: { roomId: message.roomId } }
      )
    )
    if (message.roomId === currentRoomId.value) {
      awaitingTurnStart.value = true
      restartTurnPolling({ forceForMs: 15000 })
    }
  }
  const processQueuedMessagesForRoom = async (roomId: string) => {
    if (!roomId || roomId !== currentRoomId.value) return
    if (queueDispatchInFlightByRoom.value[roomId]) return
    if (awaitingTurnStart.value || hasActiveTurn(chat.messages as any[])) return

    const nextQueuedMessage = getQueuedOutgoingMessages(roomId)[0]
    if (!nextQueuedMessage) return

    if (nextQueuedMessage.failed) {
      setQueuedOutgoingMessages(
        roomId,
        getQueuedOutgoingMessages(roomId).map((message) =>
          message.id === nextQueuedMessage.id ? { ...message, failed: false } : message
        )
      )
    }

    setQueueDispatchInFlight(roomId, true)

    await dispatchChatOutgoing(nextQueuedMessage, {
      queued: true,
      getQueued: getQueuedOutgoingMessages,
      setQueued: setQueuedOutgoingMessages,
      send: () =>
        sendOutgoingMessage({
          roomId,
          id: nextQueuedMessage.id,
          text: nextQueuedMessage.text,
          attachments: nextQueuedMessage.attachments
        }),
      sent: () => {
        scheduleQueueReconcile(roomId)
      },
      failed: (error) => {
        if (roomId === currentRoomId.value) awaitingTurnStart.value = false
        toast.add({
          title: 'Message failed to send',
          description:
            error?.message || 'Could not send the queued message. It will retry when ready.',
          color: 'error'
        })
      },
      settled: () => {
        setQueueDispatchInFlight(roomId, false)
      }
    })
  }
  const chatMessages = computed(() => {
    const sanitizedMessages = (chat.messages as any[])
      .map((message) => sanitizeDisplayMessage(message))
      .filter(Boolean) as any[]
    const queuedMessages = queuedOutgoingMessages.value.map((message) => ({
      id: message.id,
      role: 'user',
      content: message.text,
      parts: buildMessageParts(message.text, message.attachments),
      createdAt: message.createdAt,
      metadata: {
        localOnly: true,
        localQueueState: message.failed ? 'FAILED' : 'QUEUED'
      }
    }))
    const combinedMessages = [
      ...sanitizedMessages,
      ...queuedMessages,
      ...quotaSystemNotices.value.filter((notice) => notice.roomId === currentRoomId.value)
    ].sort(
      (left, right) =>
        new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime()
    )
    const hasVisibleActiveAssistant = activeTurnStatuses.includes(
      getLatestAssistantMessage(combinedMessages, { includeHidden: false })?.metadata?.turnStatus
    )
    const needsTypingPlaceholder =
      awaitingTurnStart.value ||
      (hasActiveTurn(chat.messages as any[]) && !hasVisibleActiveAssistant)

    if (!needsTypingPlaceholder) {
      return combinedMessages
    }

    return [
      ...combinedMessages,
      {
        id: `typing-${currentRoomId.value || 'room'}`,
        role: 'assistant',
        content: '',
        parts: [],
        createdAt: new Date(),
        metadata: {
          syntheticTyping: true,
          turnStatus: 'STREAMING'
        }
      }
    ]
  })
  const areMessageListsEquivalent = (left: any[], right: any[]) => {
    if (left.length !== right.length) return false

    for (let index = 0; index < left.length; index += 1) {
      const leftMessage = left[index]
      const rightMessage = right[index]

      if (
        leftMessage?.id !== rightMessage?.id ||
        leftMessage?.role !== rightMessage?.role ||
        leftMessage?.content !== rightMessage?.content ||
        String(leftMessage?.createdAt || '') !== String(rightMessage?.createdAt || '')
      ) {
        return false
      }

      if (
        JSON.stringify(leftMessage?.metadata || {}) !== JSON.stringify(rightMessage?.metadata || {})
      ) {
        return false
      }
    }

    return true
  }
  const transformStoredMessage = (msg: any) => {
    let parts: any[] = msg.parts || [{ type: 'text', text: msg.content }]

    // Synthesize tool-approval-request parts from pending approvals stored in metadata.
    // These are tool calls blocked server-side by needsApproval() that the client needs
    // to render as approval UI. Without this, WebSocket-delivered messages never have
    // the part state that ChatMessageContent.vue requires to show ChatToolApproval.
    const pendingApprovals: any[] = msg.metadata?.pendingApprovals || []
    if (pendingApprovals.length > 0) {
      const existingApprovalIds = new Set(
        parts
          .filter(
            (p: any) =>
              p.type === 'tool-approval-request' ||
              (p?.type?.startsWith('tool-') && p?.state === 'approval-requested')
          )
          .map((p: any) => p.approvalId || p.approval?.id || p.toolCallId)
          .filter(Boolean)
      )
      const approvalParts = pendingApprovals
        .filter((a: any) => !existingApprovalIds.has(a.toolCallId))
        .map((a: any) => ({
          type: 'tool-approval-request',
          approvalId: a.toolCallId,
          toolCall: {
            toolName: a.toolName,
            args: a.args
          }
        }))
      if (approvalParts.length > 0) {
        parts = [...parts, ...approvalParts]
      }
    }

    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      parts,
      createdAt: new Date(msg.createdAt || msg.metadata?.createdAt || Date.now()),
      metadata: msg.metadata
    }
  }
  const applyAssistantTextDelta = (event: {
    roomId: string
    turnId: string
    messageId: string
    textDelta: string
    status?: string
  }) => {
    if (!chatPageActive || !event.textDelta || event.roomId !== currentRoomId.value) return
    awaitingTurnStart.value = false

    const existingMessages = [...(chat.messages as any[])]
    const existingIndex = existingMessages.findIndex((entry) => entry?.id === event.messageId)

    if (existingIndex >= 0) {
      const existingMessage = existingMessages[existingIndex]
      const existingParts = Array.isArray(existingMessage?.parts) ? existingMessage.parts : []
      const nonTextParts = existingParts.filter((part: any) => part?.type !== 'text')
      const nextText = `${typeof existingMessage?.content === 'string' ? existingMessage.content : ''}${event.textDelta}`
      const nextMessages = [...existingMessages]
      nextMessages[existingIndex] = {
        ...existingMessage,
        content: nextText,
        parts: [
          ...nonTextParts,
          {
            type: 'text',
            text: nextText
          }
        ],
        metadata: {
          ...(existingMessage?.metadata || {}),
          turnId: event.turnId,
          turnStatus: event.status || 'STREAMING'
        }
      }
      chat.messages = nextMessages as any
      return
    }

    chat.messages = [
      ...existingMessages,
      {
        id: event.messageId,
        role: 'assistant',
        content: event.textDelta,
        parts: [{ type: 'text', text: event.textDelta }],
        createdAt: new Date(),
        metadata: {
          turnId: event.turnId,
          turnStatus: event.status || 'STREAMING',
          isDraft: true,
          isRealtimeDraft: true
        }
      }
    ] as any
  }
  const mergeRealtimeMessage = (existingMessage: any, incomingMessage: any) => {
    const existingStatus = existingMessage?.metadata?.turnStatus
    const incomingStatus = incomingMessage?.metadata?.turnStatus
    const existingParts = Array.isArray(existingMessage?.parts) ? existingMessage.parts : []
    const incomingParts = Array.isArray(incomingMessage?.parts) ? incomingMessage.parts : []
    const existingNonTextParts = existingParts.filter((part: any) => part?.type !== 'text')
    const incomingHasNonTextParts = incomingParts.some((part: any) => part?.type !== 'text')

    if (!incomingHasNonTextParts && existingNonTextParts.length > 0) {
      const incomingTextPart = incomingParts.find((part: any) => part?.type === 'text')
      incomingMessage = {
        ...incomingMessage,
        parts: [
          ...existingNonTextParts,
          ...(incomingTextPart
            ? [incomingTextPart]
            : typeof incomingMessage?.content === 'string'
              ? [{ type: 'text', text: incomingMessage.content }]
              : [])
        ],
        metadata: {
          ...(existingMessage?.metadata || {}),
          ...(incomingMessage?.metadata || {}),
          toolCalls:
            incomingMessage?.metadata?.toolCalls || existingMessage?.metadata?.toolCalls || [],
          toolResults:
            incomingMessage?.metadata?.toolResults || existingMessage?.metadata?.toolResults || []
        }
      }
    }

    if (
      terminalTurnStatuses.includes(existingStatus) &&
      activeTurnStatuses.includes(incomingStatus)
    ) {
      return {
        ...incomingMessage,
        content:
          typeof existingMessage?.content === 'string' && existingMessage.content.trim()
            ? existingMessage.content
            : incomingMessage.content,
        parts:
          Array.isArray(existingMessage?.parts) && existingMessage.parts.length > 0
            ? existingMessage.parts
            : incomingMessage.parts,
        metadata: {
          ...(incomingMessage?.metadata || {}),
          ...(existingMessage?.metadata || {}),
          turnStatus: existingStatus
        }
      }
    }

    const existingText =
      typeof existingMessage?.content === 'string' ? existingMessage.content.trim() : ''
    const incomingText =
      typeof incomingMessage?.content === 'string' ? incomingMessage.content.trim() : ''
    const existingIsStreaming =
      activeTurnStatuses.includes(String(existingStatus || '')) ||
      existingMessage?.metadata?.isRealtimeDraft
    if (
      existingIsStreaming &&
      existingText.length > incomingText.length &&
      incomingMessage?.role === 'assistant'
    ) {
      const existingTextPart = existingParts.find((part: any) => part?.type === 'text')
      return {
        ...incomingMessage,
        content: existingMessage.content,
        parts: [
          ...existingNonTextParts,
          existingTextPart || { type: 'text', text: existingMessage.content }
        ],
        metadata: {
          ...(incomingMessage?.metadata || {}),
          ...(existingMessage?.metadata || {}),
          turnStatus: existingStatus || incomingStatus
        }
      }
    }

    return incomingMessage
  }
  const mergeLoadedMessages = (existingMessages: any[], loadedMessages: any[]) => {
    const existingById = new Map(existingMessages.map((message) => [message?.id, message]))

    return loadedMessages.map((loadedMessage) => {
      const existingMessage = existingById.get(loadedMessage?.id)
      if (!existingMessage) return loadedMessage
      return mergeRealtimeMessage(existingMessage, loadedMessage)
    })
  }
  const upsertChatMessage = (message: any) => {
    if (!chatPageActive) return
    const transformedMessage = transformStoredMessage(message)
    if (
      transformedMessage?.role === 'assistant' ||
      activeTurnStatuses.includes(transformedMessage?.metadata?.turnStatus)
    ) {
      awaitingTurnStart.value = false
    }
    const existingMessages = [...(chat.messages as any[])]
    const existingIndex = existingMessages.findIndex((entry) => entry?.id === transformedMessage.id)

    if (existingIndex >= 0) {
      const nextMessages = [...existingMessages]
      nextMessages[existingIndex] = mergeRealtimeMessage(
        existingMessages[existingIndex],
        transformedMessage
      )
      if (!areMessageListsEquivalent(existingMessages, nextMessages)) {
        chat.messages = nextMessages as any
      }
      if (
        transformedMessage?.role === 'assistant' &&
        terminalTurnStatuses.includes(transformedMessage?.metadata?.turnStatus)
      ) {
        scheduleTerminalMessageSync(currentRoomId.value)
        clearQueueReconcileTimer(currentRoomId.value)
        void processQueuedMessagesForRoom(currentRoomId.value)
      }
      return
    }

    const nextMessages = [...existingMessages, transformedMessage].sort(
      (left, right) =>
        new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime()
    )
    chat.messages = nextMessages as any

    if (
      transformedMessage?.role === 'assistant' &&
      terminalTurnStatuses.includes(transformedMessage?.metadata?.turnStatus)
    ) {
      scheduleTerminalMessageSync(currentRoomId.value)
      clearQueueReconcileTimer(currentRoomId.value)
      void processQueuedMessagesForRoom(currentRoomId.value)
    }
  }
  const uiChatStatus = computed(() =>
    hasActiveTurn(chat.messages as any[]) || awaitingTurnStart.value ? 'streaming' : 'ready'
  )
  const composerStatus = computed(() => {
    if (queuedMessageCount.value > 0) return 'submitted'
    return uiChatStatus.value
  })

  // Form submission handler
  const onSubmit = async (
    payload?:
      | Event
      | string
      | {
          text?: string
          attachments?: Array<{
            url: string
            mediaType: string
            filename?: string
          }>
        }
  ) => {
    if (payload && typeof payload === 'object' && 'preventDefault' in payload)
      payload.preventDefault()

    const submittedText =
      typeof payload === 'string'
        ? payload
        : payload && 'text' in payload
          ? payload.text || ''
          : input.value
    const attachments =
      payload && typeof payload === 'object' && 'attachments' in payload
        ? payload.attachments || []
        : []

    if ((!submittedText?.trim() && attachments.length === 0) || !currentRoomId.value) {
      return
    }

    // Track session start if it's the first message in this room
    if (chat.messages.length === 0 && currentRoomId.value) {
      trackChatSessionStart(currentRoomId.value)
    }

    const outgoingMessage: QueuedOutgoingMessage = {
      id: crypto.randomUUID(),
      roomId: currentRoomId.value,
      text: submittedText,
      attachments,
      createdAt: new Date()
    }

    pendingComposerDraft.value = submittedText

    if (
      awaitingTurnStart.value ||
      hasActiveTurn(chat.messages as any[]) ||
      queuedMessageCount.value
    ) {
      enqueueOutgoingMessage(outgoingMessage)
      input.value = ''
    } else {
      awaitingTurnStart.value = true
      await dispatchChatOutgoing(outgoingMessage, {
        queued: false,
        getQueued: getQueuedOutgoingMessages,
        setQueued: setQueuedOutgoingMessages,
        send: () =>
          sendOutgoingMessage({
            roomId: outgoingMessage.roomId,
            id: outgoingMessage.id,
            text: submittedText,
            attachments
          }),
        sent: () => {
          if (outgoingMessage.roomId === currentRoomId.value) input.value = ''
        },
        failed: (error) => {
          // The direct-send path bypassed the durable outgoing queue entirely, so a
          // transient failure here used to just restore the composer text and leave
          // no trace of the message anywhere else. Fall back to the same durable
          // queue the "turn already active" branch above uses, so the message is
          // retained, visible, and retried the same way. Reusing outgoingMessage.id
          // (rather than generating a new one) means a retry can't duplicate a
          // message that actually landed server-side before the client saw the error.
          if (outgoingMessage.roomId === currentRoomId.value) awaitingTurnStart.value = false
          if (outgoingMessage.roomId === currentRoomId.value) input.value = ''
          toast.add({
            title: 'Message failed to send',
            description: error?.message || 'Could not send the message. It will retry when ready.',
            color: 'error'
          })
        }
      })
    }
  }

  const pendingApprovalSubmissions = new Set<string>()

  const onToolApproval = async (approval: {
    approvalId: string
    approved: boolean
    result?: string
  }) => {
    if (pendingApprovalSubmissions.has(approval.approvalId)) return
    pendingApprovalSubmissions.add(approval.approvalId)

    const approvalToolMsg = {
      id: crypto.randomUUID(),
      role: 'tool',
      content: '',
      parts: [
        {
          type: 'tool-approval-response',
          toolCallId: approval.approvalId,
          approvalId: approval.approvalId,
          approved: approval.approved,
          reason:
            approval.result ||
            (approval.approved ? 'User confirmed action.' : 'User cancelled action.')
        }
      ],
      createdAt: new Date()
    }
    chat.messages = [...(chat.messages as any[]), approvalToolMsg] as any
    try {
      await (chat as any).sendMessage()
      awaitingTurnStart.value = true
      restartTurnPolling({ forceForMs: 15000 })
      if (currentRoomId.value) {
        startApprovalSync(currentRoomId.value, approvalToolMsg.createdAt.getTime())
      }
    } catch (error: any) {
      pendingApprovalSubmissions.delete(approval.approvalId)
      chat.messages = (chat.messages as any[]).filter(
        (message) => message.id !== approvalToolMsg.id
      ) as any
      toast.add({
        title: 'Tool approval failed',
        description: error?.message || 'Could not submit your approval. Please try again.',
        color: 'error'
      })
      throw error
    }
  }

  provide('chatToolApproval', onToolApproval)

  const getMessageText = (message: any) => {
    if (typeof message?.content === 'string') return message.content
    if (Array.isArray(message?.parts)) {
      return message.parts
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('')
    }
    return ''
  }

  const openEditMessageInline = (message: any) => {
    if (
      !message ||
      message.role !== 'user' ||
      uiChatStatus.value !== 'ready' ||
      isCurrentRoomReadOnly.value
    )
      return

    editingMessage.value = message
    editingContent.value = getMessageText(message)
  }

  const cancelEditedMessage = (force = false) => {
    if (!force && savingEditedMessage.value) return
    editingMessage.value = null
    editingContent.value = ''
  }

  const saveEditedMessage = async () => {
    if (!editingMessage.value || !currentRoomId.value || savingEditedMessage.value) return

    const content = editingContent.value.trim()
    if (!content) {
      toast.add({
        title: 'Message required',
        description: 'Edited message cannot be empty.',
        color: 'error'
      })
      return
    }

    savingEditedMessage.value = true

    try {
      const response = (await ($fetch as any)(`/api/chat/messages/${editingMessage.value.id}`, {
        method: 'PATCH',
        body: {
          roomId: currentRoomId.value,
          content,
          regenerateFromEdit: true
        }
      })) as { regenerateFromEdit?: boolean }

      cancelEditedMessage(true)
      await loadMessages(currentRoomId.value)

      if (response?.regenerateFromEdit) {
        awaitingTurnStart.value = true
        restartTurnPolling({ forceForMs: 15000 })
      }

      toast.add({
        title: 'Message updated',
        description: 'Your message has been updated and regenerated.',
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: 'Edit failed',
        description: error?.data?.message || 'Could not update this message.',
        color: 'error'
      })
    } finally {
      savingEditedMessage.value = false
    }
  }
  // Load initial room and messages
  onMounted(async () => {
    if (import.meta.client) {
      previousDocumentOverflow = document.documentElement.style.overflow
      previousBodyOverflow = document.body.style.overflow
      document.documentElement.style.overflow = 'hidden'
      document.body.style.overflow = 'hidden'

      const updateViewportHeight = () => {
        const viewportHeight = window.visualViewport?.height || window.innerHeight
        chatViewportHeight.value = `${Math.round(viewportHeight)}px`
      }

      updateViewportHeight()
      window.visualViewport?.addEventListener('resize', updateViewportHeight)
      window.visualViewport?.addEventListener('scroll', updateViewportHeight)
      window.addEventListener('resize', updateViewportHeight)
      visualViewportListener = updateViewportHeight
    }

    await loadChat()
    connectChatWebSocket()
    nextTick(() => {
      chatInputRef.value?.focus()
    })
  })

  onBeforeUnmount(() => {
    if (!import.meta.client) return

    chatPageActive = false

    document.documentElement.style.overflow = previousDocumentOverflow
    document.body.style.overflow = previousBodyOverflow

    if (visualViewportListener) {
      window.visualViewport?.removeEventListener('resize', visualViewportListener)
      window.visualViewport?.removeEventListener('scroll', visualViewportListener)
      window.removeEventListener('resize', visualViewportListener)
      visualViewportListener = null
    }

    stopTurnPolling()
    cleanupChatWebSocket()
    Object.keys(queueReconcileTimersByRoom).forEach((roomId) => clearQueueReconcileTimer(roomId))
    Object.keys(approvalSyncTimersByRoom).forEach((roomId) => clearApprovalSyncTimer(roomId))
    Object.keys(terminalSyncTimersByRoom).forEach((roomId) => clearTerminalSyncTimer(roomId))
  })

  function cleanupChatWebSocket() {
    if (chatWsReconnectTimer) {
      clearTimeout(chatWsReconnectTimer)
      chatWsReconnectTimer = null
    }
    if (chatWsPingTimer) {
      clearInterval(chatWsPingTimer)
      chatWsPingTimer = null
    }
    if (chatWs) {
      chatWs.close()
      chatWs = null
    }
    isRealtimeConnected.value = false
  }

  function connectChatWebSocket() {
    if (!import.meta.client || chatWs || !(session.value?.user as any)?.id) {
      return
    }

    isRealtimeConnected.value = false
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    chatWs = new WebSocket(`${protocol}//${window.location.host}/api/websocket`)

    chatWs.onopen = async () => {
      try {
        const { token } = await ($fetch as any)('/api/websocket-token')
        chatWs?.send(JSON.stringify({ type: 'authenticate', token }))

        if (chatWsPingTimer) {
          clearInterval(chatWsPingTimer)
        }
        chatWsPingTimer = setInterval(() => {
          if (chatWs?.readyState === WebSocket.OPEN) {
            chatWs.send('ping')
          }
        }, 30000)
      } catch (error) {
        console.error('[Chat] WebSocket auth failed:', error)
      }
    }

    chatWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'authenticated') {
          isRealtimeConnected.value = true
          // Don't stop polling here — loadMessages will call restartTurnPolling()
          // which correctly decides based on actual state after the fetch.
          // Stopping eagerly risks missing a turn that completed during the gap.
          if (currentRoomId.value) {
            void loadMessages(currentRoomId.value, { silent: true })
          }
          return
        }
        if (
          data.type === 'chat_assistant_text_delta' &&
          data.roomId === currentRoomId.value &&
          typeof data.textDelta === 'string'
        ) {
          lastChatRealtimeEventAt.value = Date.now()
          applyAssistantTextDelta(data)
          return
        }
        if (
          data.type === 'chat_message_upsert' &&
          data.roomId === currentRoomId.value &&
          data.message
        ) {
          lastChatRealtimeEventAt.value = Date.now()
          upsertChatMessage(data.message)
          return
        }
        if (data.type === 'chat_memory_event' && data.roomId === currentRoomId.value) {
          toast.add({
            title: 'Memory updated',
            description: data.notice || 'Chat memory changed.',
            color: 'success'
          })
          if (isMemoryPanelOpen.value) {
            void loadMemoryState()
          }
          return
        }
        if (
          data.type === 'chat_turn_status' &&
          data.roomId === currentRoomId.value &&
          data.turnId
        ) {
          lastChatRealtimeEventAt.value = Date.now()
          if (data.reason === 'slow_response') {
            if (!slowTurnNoticeIds.has(data.turnId)) {
              slowTurnNoticeIds.add(data.turnId)
              toast.add({
                title: 'Response delayed',
                description:
                  'This turn is taking longer than usual. You can keep waiting or retry if it fails.',
                color: 'warning'
              })
            }
            return
          }

          if (terminalTurnStatuses.includes(String(data.status || ''))) {
            awaitingTurnStart.value = false
            if (data.quotaExceeded) {
              void handleChatQuotaExceeded()
            }
            scheduleTerminalMessageSync(currentRoomId.value, 50)
          }
        }
      } catch (error) {
        console.error('[Chat] WebSocket message handling failed:', error)
      }
    }

    chatWs.onclose = () => {
      chatWs = null
      isRealtimeConnected.value = false

      if (chatWsPingTimer) {
        clearInterval(chatWsPingTimer)
        chatWsPingTimer = null
      }

      if (hasActiveTurn(chat.messages as any[]) || awaitingTurnStart.value) {
        restartTurnPolling({ forceForMs: 15000 })
      }

      if (import.meta.client && chatPageActive) {
        chatWsReconnectTimer = setTimeout(() => {
          chatWsReconnectTimer = null
          if (chatPageActive) {
            connectChatWebSocket()
          }
        }, 3000)
      }
    }

    chatWs.onerror = () => {
      chatWs?.close()
    }
  }

  function stopTurnPolling() {
    if (turnPollingTimer) {
      clearInterval(turnPollingTimer)
      turnPollingTimer = null
    }
  }

  async function fetchRoomState(roomId: string) {
    return (await ($fetch as any)(`/api/chat/rooms/${roomId}/state`)) as ChatRoomStateSnapshot
  }

  function restartTurnPolling(options?: { forceForMs?: number }) {
    if (!chatPageActive) return
    if (options?.forceForMs && options.forceForMs > 0) {
      turnPollingGraceUntil = Date.now() + options.forceForMs
    }

    stopTurnPolling()
    const activeTurn = hasActiveTurn(chat.messages as any[])
    const hasAssistantMessage = (chat.messages as any[]).some(
      (message) => message?.role === 'assistant'
    )
    if (
      !currentRoomId.value ||
      (!activeTurn &&
        !awaitingTurnStart.value &&
        (hasAssistantMessage || Date.now() >= turnPollingGraceUntil))
    ) {
      return
    }

    turnPollingTimer = setInterval(async () => {
      if (!chatPageActive || !currentRoomId.value) {
        stopTurnPolling()
        return
      }

      const hadActiveTurnAtPollStart = hasActiveTurn(chat.messages as any[])
      let nextHasActiveTurn = hadActiveTurnAtPollStart
      let nextHasAssistantMessage = (chat.messages as any[]).some(
        (message) => message?.role === 'assistant'
      )
      let didReloadMessages = false

      try {
        const roomState = await fetchRoomState(currentRoomId.value)
        const nextSignature = serializePollableRoomState(roomState)

        nextHasActiveTurn = activeTurnStatuses.includes(String(roomState.activeTurnStatus || ''))
        nextHasAssistantMessage = roomState.hasAssistantMessage

        if (nextSignature !== getPollableRoomStateSignature(currentRoomId.value)) {
          setRoomStateSignature(currentRoomId.value, serializeRoomState(roomState))
          await loadMessages(currentRoomId.value, { silent: true })
          didReloadMessages = true
          nextHasActiveTurn = hasActiveTurn(chat.messages as any[])
          nextHasAssistantMessage = (chat.messages as any[]).some(
            (message) => message?.role === 'assistant'
          )
        } else if (hadActiveTurnAtPollStart && !nextHasActiveTurn) {
          // Force one final sync when a streamed turn settles. This catches cases where
          // the final assistant upsert or approval parts were missed by realtime delivery.
          await loadMessages(currentRoomId.value, { silent: true })
          didReloadMessages = true
          nextHasActiveTurn = hasActiveTurn(chat.messages as any[])
          nextHasAssistantMessage = (chat.messages as any[]).some(
            (message) => message?.role === 'assistant'
          )
        }
      } catch (error) {
        console.error('Failed to poll room state:', error)
      }

      if (
        !nextHasActiveTurn &&
        !awaitingTurnStart.value &&
        (nextHasAssistantMessage || Date.now() >= turnPollingGraceUntil)
      ) {
        stopTurnPolling()
        if (didReloadMessages) {
          clearQueueReconcileTimer(currentRoomId.value)
        }
      }
    }, 1500)
  }

  async function loadRooms(selectFirst = true) {
    try {
      if (selectFirst) loadingRooms.value = true
      const loadedRooms = (await ($fetch as any)('/api/chat/rooms')) as any[]
      rooms.value = loadedRooms
      roomsLoadError.value = null

      // Select first room if we don't have a current one
      if (selectFirst && !currentRoomId.value && loadedRooms.length > 0 && loadedRooms[0]) {
        await selectRoom(loadedRooms[0].roomId)
      }
    } catch (err: any) {
      console.error('Failed to load rooms:', err)
      roomsLoadError.value =
        err?.data?.message || err?.message || 'Failed to load chat rooms. Please try again.'
    } finally {
      loadingRooms.value = false
    }
  }

  async function loadMessages(roomId: string, options?: { silent?: boolean }) {
    if (!chatPageActive) return
    const silent = options?.silent ?? false

    // Coalesce concurrent calls: if already inflight for this room, mark pending
    // and let the current call handle the final state.
    if (loadMessagesInFlight[roomId]) {
      loadMessagesPending[roomId] = true
      return
    }

    loadMessagesInFlight[roomId] = true

    try {
      if (!silent) {
        loadingMessages.value = true
      }
      const loadedMessages = (await ($fetch as any)(`/api/chat/messages?roomId=${roomId}`)) as any[]

      if (!chatPageActive || roomId !== currentRoomId.value) return

      // Transform DB messages to AI SDK format (UIMessage)
      const transformedMessages = loadedMessages.map((msg) => ({
        ...transformStoredMessage(msg),
        updatedAt: msg.updatedAt || msg.metadata?.updatedAt || null
      }))
      const mergedMessages = mergeLoadedMessages(chat.messages as any[], transformedMessages)

      // Avoid replacing the entire message list when nothing material changed,
      // because that retriggers internal scroll behavior in the chat UI.
      if (!areMessageListsEquivalent(chat.messages as any[], mergedMessages)) {
        chat.messages = mergedMessages as any
      }
      setRoomStateSignature(roomId, serializeRoomState(buildRoomStateFromMessages(mergedMessages)))
      if (
        transformedMessages.some(
          (message: any) =>
            message?.role === 'assistant' ||
            activeTurnStatuses.includes(message?.metadata?.turnStatus)
        )
      ) {
        awaitingTurnStart.value = false
      }
      restartTurnPolling()
      void processQueuedMessagesForRoom(roomId)
      messagesLoadError.value = null
    } catch (err: any) {
      console.error('Failed to load messages:', err)
      messagesLoadError.value =
        err?.data?.message || err?.message || 'Failed to load messages. Please try again.'
    } finally {
      loadMessagesInFlight[roomId] = false
      if (!silent) {
        loadingMessages.value = false
      }
      // If a refresh was requested while we were loading, run one more time
      // to ensure we have the latest state.
      if (loadMessagesPending[roomId]) {
        loadMessagesPending[roomId] = false
        void loadMessages(roomId, { silent: true })
      }
    }
  }

  async function loadChat() {
    await loadRooms(false)

    // Check for context from query params
    const roomFromQuery = route.query.room as string
    const workoutId = route.query.workoutId as string
    const isPlanned = route.query.isPlanned === 'true'
    const recommendationId = route.query.recommendationId as string
    const initialMessage = route.query.initialMessage as string

    if (roomFromQuery) {
      const roomExists = rooms.value.some((r) => r.roomId === roomFromQuery)
      if (roomExists) {
        await selectRoom(roomFromQuery)
      } else {
        useToast().add({
          title: 'Chat not found',
          description: 'The requested chat could not be found.',
          color: 'error'
        })
        await createNewChat()
      }
      // Clear query params
      router.replace({ query: {} })
    } else if (workoutId || recommendationId || initialMessage) {
      // Create new chat
      await createNewChat()

      let text = initialMessage || ''
      if (workoutId) {
        text = isPlanned
          ? `I'd like to discuss my upcoming planned workout (ID: ${workoutId}). What should I focus on?`
          : `Please analyze my completed workout with ID ${workoutId}. How did I perform?`
      } else if (recommendationId) {
        text = `Can you explain this recommendation (ID: ${recommendationId}) in more detail?`
      }

      if (text) {
        input.value = text
      }

      // Clear query params
      router.replace({ query: {} })
    } else {
      // No context provided - check if we should continue last chat or start new
      if (rooms.value.length > 0 && rooms.value[0]) {
        const lastRoom = rooms.value[0]
        const lastActivity = lastRoom.index // Timestamp in ms
        const now = Date.now()
        const timeSinceLastActivity = now - lastActivity
        const FIFTEEN_MINUTES = 15 * 60 * 1000

        // If last message/room update was > 15 mins ago, start fresh
        if (timeSinceLastActivity > FIFTEEN_MINUTES) {
          await createNewChat()
        } else {
          await selectRoom(lastRoom.roomId)
        }
      } else {
        // Fallback if no rooms exist (API usually creates one, but just in case)
        await createNewChat()
      }
    }
  }

  async function selectRoom(roomId: string) {
    if (currentRoomId.value && currentRoomId.value !== roomId) {
      clearApprovalSyncTimer(currentRoomId.value)
    }
    currentRoomId.value = roomId
    awaitingTurnStart.value = false
    await loadMessages(roomId)
    chatSidebarRef.value?.close()
    // Focus input after room selection
    nextTick(() => {
      chatInputRef.value?.focus()
    })
  }

  async function retryChatLoad() {
    if (roomsLoadError.value) {
      await loadRooms(false)
    }
    if (currentRoomId.value) {
      await loadMessages(currentRoomId.value)
    } else if (!roomsLoadError.value) {
      await loadChat()
    }
  }

  async function createNewChat() {
    try {
      const newRoom = await ($fetch as any)('/api/chat/rooms', {
        method: 'POST'
      })

      // Add to rooms list
      rooms.value.unshift(newRoom)

      // Track session start
      trackChatSessionStart(newRoom.roomId)

      // Switch to new room
      await selectRoom(newRoom.roomId)
    } catch (err: any) {
      console.error('Failed to create new chat:', err)
    }
  }

  async function deleteRoom(roomId: string) {
    try {
      // If we are in the room being deleted, we need to clear state immediately
      const wasCurrentRoom = currentRoomId.value === roomId

      // Determine the next room to select if we are deleting the current one
      let nextRoomId = ''
      if (wasCurrentRoom) {
        const currentIndex = rooms.value.findIndex((r) => r.roomId === roomId)
        if (currentIndex !== -1 && rooms.value.length > 1) {
          // Select next room, or previous if deleting the last one
          const nextRoom = rooms.value[currentIndex + 1] || rooms.value[currentIndex - 1]
          nextRoomId = nextRoom.roomId
        }
      }

      await $fetch<any, string & {}>(`/api/chat/rooms/${roomId}`, {
        method: 'DELETE'
      })

      if (wasCurrentRoom) {
        if (nextRoomId) {
          await selectRoom(nextRoomId)
          await loadRooms(false)
        } else {
          // No more rooms left, create a fresh one
          await createNewChat()
          await loadRooms(false)
        }
      } else {
        // Just refresh the list if we deleted a background room
        await loadRooms(false)
      }

      useToast().add({
        title: 'Chat room deleted',
        color: 'success'
      })
    } catch (err: any) {
      console.error('Failed to delete room:', err)
      useToast().add({
        title: 'Error',
        description: 'Failed to delete chat room',
        color: 'error'
      })
    }
  }

  async function renameRoom(roomId: string, newName: string) {
    try {
      await $fetch<any, string & {}>(`/api/chat/rooms/${roomId}`, {
        method: 'PATCH',
        body: { name: newName }
      })

      // Update locally or refresh
      await loadRooms(false)

      useToast().add({
        title: 'Chat room renamed',
        color: 'success'
      })
    } catch (err: any) {
      console.error('Failed to rename room:', err)
      useToast().add({
        title: 'Error',
        description: 'Failed to rename chat room',
        color: 'error'
      })
    }
  }

  // Get current room info
  const currentRoom = computed(() => rooms.value.find((r) => r.roomId === currentRoomId.value))

  const isCurrentRoomReadOnly = computed(() => currentRoom.value?.isReadOnly || false)

  const currentRoomName = computed(() => {
    return currentRoom.value?.roomName || t.value('chat_title')
  })

  // Share current chat room
  const isShareModalOpen = ref(false)
  const { toggle: toggleTriggerMonitor } = useTriggerMonitor()

  const chatOverflowItems = computed(() => [
    [
      {
        label: 'Tasks',
        icon: 'i-heroicons-cpu-chip',
        onSelect: () => toggleTriggerMonitor()
      },
      {
        label: 'Notifications',
        icon: 'i-heroicons-bell',
        to: '/notifications'
      },
      {
        label: 'Memory',
        icon: 'i-heroicons-bookmark',
        disabled: !currentRoomId.value,
        onSelect: () => {
          void openMemoryPanel()
        }
      },
      {
        label: t.value('nav_share'),
        icon: 'i-heroicons-share',
        disabled: !currentRoomId.value,
        onSelect: () => {
          isShareModalOpen.value = true
        }
      },
      {
        label: t.value('nav_settings'),
        icon: 'i-heroicons-cog-6-tooth',
        to: '/settings/ai'
      }
    ]
  ])

  const shareExpiryValue = ref('2592000')
  const isMemoryPanelOpen = ref(false)
  const loadingMemoryPanel = ref(false)
  const savingMemorySettings = ref(false)
  const showSensitiveMemories = ref(false)
  const memoryTab = ref<'global' | 'room'>('global')
  const memorySearch = ref('')
  const globalMemories = ref<any[]>([])
  const roomMemories = ref<any[]>([])
  const roomHistorySummary = ref('')
  const roomLastSummarizedAt = ref<string | null>(null)
  const editingMemory = ref<any | null>(null)
  const selectedMemoryId = ref<string | null>(null)
  const memoryDraft = ref({
    content: '',
    scope: 'GLOBAL',
    category: 'PREFERENCE',
    sensitive: false,
    pinned: false
  })
  const aiMemorySettings = ref({
    aiMemoryEnabled: false
  })

  const memoryCategories = [
    { label: 'Preference', value: 'PREFERENCE' },
    { label: 'Goal', value: 'GOAL' },
    { label: 'Constraint', value: 'CONSTRAINT' },
    { label: 'Profile', value: 'PROFILE' },
    { label: 'Communication', value: 'COMMUNICATION' },
    { label: 'Temporary', value: 'TEMPORARY' }
  ]
  const memoryScopeItems = [
    { label: 'Across chats', value: 'GLOBAL' },
    { label: 'This chat', value: 'ROOM' }
  ]

  const { shareLink, generatingShareLink, generateShareLink } = useResourceShare(
    'CHAT_ROOM',
    computed(() => currentRoomId.value)
  )

  const visibleGlobalMemories = computed(() =>
    globalMemories.value.filter((memory) => showSensitiveMemories.value || !memory.sensitive)
  )
  const visibleRoomMemories = computed(() =>
    roomMemories.value.filter((memory) => showSensitiveMemories.value || !memory.sensitive)
  )
  const currentVisibleMemories = computed(() =>
    (memoryTab.value === 'global' ? visibleGlobalMemories.value : visibleRoomMemories.value).filter(
      (memory) =>
        !memorySearch.value.trim() ||
        [memory.content, memory.category, memory.source]
          .filter(Boolean)
          .some((value) =>
            String(value).toLowerCase().includes(memorySearch.value.trim().toLowerCase())
          )
    )
  )
  const isCurrentMemoryTabEmpty = computed(() => currentVisibleMemories.value.length === 0)
  const selectedMemory = computed(
    () =>
      currentVisibleMemories.value.find((memory) => memory.id === selectedMemoryId.value) || null
  )

  const copyToClipboard = () => {
    if (!shareLink.value) return

    navigator.clipboard.writeText(shareLink.value)
    toast.add({
      title: t.value('toast_copied'),
      description: t.value('toast_copied_desc'),
      color: 'success'
    })
  }

  const resetMemoryDraft = () => {
    memoryDraft.value = {
      content: '',
      scope: memoryTab.value === 'room' ? 'ROOM' : 'GLOBAL',
      category: 'PREFERENCE',
      sensitive: false,
      pinned: false
    }
  }

  const selectMemoryTab = (tab: 'global' | 'room') => {
    memoryTab.value = tab
    memorySearch.value = ''
    editingMemory.value = null
    selectedMemoryId.value = null
    memoryDraft.value.scope = tab === 'room' ? 'ROOM' : 'GLOBAL'
  }

  const formatDateTime = (value?: string | Date | null) => {
    if (!value) return ''
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  const toggleMemoryEnabled = (value: boolean) => {
    void saveMemoryEnabledSetting(value)
  }

  const getOppositeMemoryScope = (scope: 'GLOBAL' | 'ROOM') =>
    scope === 'GLOBAL' ? 'ROOM' : 'GLOBAL'

  const formatMemoryCategory = (category?: string | null) => {
    switch (category) {
      case 'PREFERENCE':
        return 'Preference'
      case 'GOAL':
        return 'Goal'
      case 'CONSTRAINT':
        return 'Constraint'
      case 'PROFILE':
        return 'Profile'
      case 'COMMUNICATION':
        return 'Communication'
      case 'TEMPORARY':
        return 'Temporary'
      default:
        return category || 'Memory'
    }
  }

  const formatMemorySource = (source?: string | null) => {
    switch (source) {
      case 'MANUAL_UI':
        return 'Added manually'
      case 'USER_EXPLICIT':
        return 'Saved from chat'
      case 'AUTO':
        return 'Auto-saved'
      default:
        return source || 'Unknown source'
    }
  }

  const formatMemoryScope = (scope?: string | null) => {
    return scope === 'ROOM' ? 'This chat' : 'Across chats'
  }

  const loadMemoryState = async () => {
    if (!currentRoomId.value) return

    loadingMemoryPanel.value = true

    try {
      const [memoryResponse, roomMemoryResponse, settingsResponse] = await Promise.all([
        ($fetch as any)('/api/chat/memory'),
        ($fetch as any)(`/api/chat/rooms/${currentRoomId.value}/memory`),
        ($fetch as any)('/api/settings/ai')
      ])

      globalMemories.value = memoryResponse?.grouped?.global || []
      roomMemories.value = roomMemoryResponse?.memories || []
      roomHistorySummary.value = roomMemoryResponse?.historySummary || ''
      roomLastSummarizedAt.value = roomMemoryResponse?.lastSummarizedAt || null
      aiMemorySettings.value.aiMemoryEnabled = settingsResponse?.aiMemoryEnabled === true
      if (!selectedMemoryId.value) {
        selectedMemoryId.value = currentVisibleMemories.value[0]?.id || null
      }
      if (!memoryDraft.value.content) {
        resetMemoryDraft()
      }
    } catch (error) {
      console.error('[Chat] Failed to load memory state:', error)
      toast.add({
        title: 'Memory unavailable',
        description: 'Could not load memory right now.',
        color: 'error'
      })
    } finally {
      loadingMemoryPanel.value = false
    }
  }

  const openMemoryPanel = async () => {
    isMemoryPanelOpen.value = true
    resetMemoryDraft()
    await loadMemoryState()
  }

  const saveMemoryEnabledSetting = async (value: boolean) => {
    savingMemorySettings.value = true
    try {
      await $fetch<any, string & {}>('/api/settings/ai', {
        method: 'POST',
        body: {
          aiMemoryEnabled: value
        }
      })
      aiMemorySettings.value.aiMemoryEnabled = value
      toast.add({
        title: value ? 'Memory enabled' : 'Memory disabled',
        color: 'success'
      })
    } catch (error: any) {
      aiMemorySettings.value.aiMemoryEnabled = !value
      toast.add({
        title: 'Memory setting failed',
        description: error?.data?.message || 'Could not update memory settings.',
        color: 'error'
      })
    } finally {
      savingMemorySettings.value = false
    }
  }

  const createMemory = async () => {
    const content = memoryDraft.value.content.trim()
    if (!content) return

    try {
      await $fetch<any, string & {}>('/api/chat/memory', {
        method: 'POST',
        body: {
          content,
          scope: memoryDraft.value.scope,
          roomId: memoryDraft.value.scope === 'ROOM' ? currentRoomId.value : null,
          category: memoryDraft.value.category,
          sensitive: memoryDraft.value.sensitive,
          pinned: memoryDraft.value.pinned
        }
      })

      resetMemoryDraft()
      await loadMemoryState()
      selectedMemoryId.value = null
      toast.add({
        title: 'Memory saved',
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: 'Save failed',
        description: error?.data?.message || 'Could not save this memory.',
        color: 'error'
      })
    }
  }

  const startEditingMemory = (memory: any) => {
    selectedMemoryId.value = memory.id
    editingMemory.value = {
      ...memory
    }
  }

  const cancelEditingMemory = () => {
    editingMemory.value = null
  }

  const saveEditedMemory = async () => {
    if (!editingMemory.value?.id) return
    const editingMemoryId = editingMemory.value.id

    try {
      await $fetch<any, string & {}>(`/api/chat/memory/${editingMemory.value.id}`, {
        method: 'PATCH',
        body: {
          content: editingMemory.value.content,
          category: editingMemory.value.category,
          scope: editingMemory.value.scope,
          roomId: editingMemory.value.scope === 'ROOM' ? currentRoomId.value : null,
          pinned: editingMemory.value.pinned,
          sensitive: editingMemory.value.sensitive
        }
      })
      cancelEditingMemory()
      await loadMemoryState()
      selectedMemoryId.value = editingMemoryId
      toast.add({
        title: 'Memory updated',
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: 'Update failed',
        description: error?.data?.message || 'Could not update this memory.',
        color: 'error'
      })
    }
  }

  const deleteMemory = async (memoryId: string) => {
    try {
      await $fetch<any, string & {}>(`/api/chat/memory/${memoryId}`, {
        method: 'DELETE'
      })
      await loadMemoryState()
      if (selectedMemoryId.value === memoryId) {
        selectedMemoryId.value = currentVisibleMemories.value[0]?.id || null
      }
      toast.add({
        title: 'Memory deleted',
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: 'Delete failed',
        description: error?.data?.message || 'Could not delete this memory.',
        color: 'error'
      })
    }
  }

  const toggleMemoryPinned = async (memory: any) => {
    try {
      await $fetch<any, string & {}>(`/api/chat/memory/${memory.id}`, {
        method: 'PATCH',
        body: {
          pinned: !memory.pinned
        }
      })
      await loadMemoryState()
    } catch (error: any) {
      toast.add({
        title: 'Pin failed',
        description: error?.data?.message || 'Could not update pinned state.',
        color: 'error'
      })
    }
  }

  const moveMemoryScope = async (memory: any, scope: 'GLOBAL' | 'ROOM') => {
    try {
      await $fetch<any, string & {}>(`/api/chat/memory/${memory.id}`, {
        method: 'PATCH',
        body: {
          scope,
          roomId: scope === 'ROOM' ? currentRoomId.value : null
        }
      })
      await loadMemoryState()
    } catch (error: any) {
      toast.add({
        title: 'Move failed',
        description: error?.data?.message || 'Could not move this memory.',
        color: 'error'
      })
    }
  }

  const rememberFromText = async (text: string, scope: 'GLOBAL' | 'ROOM' = 'GLOBAL') => {
    const content = text.trim()
    if (!content) return

    try {
      await $fetch<any, string & {}>('/api/chat/memory/remember', {
        method: 'POST',
        body: {
          content,
          scope,
          roomId: scope === 'ROOM' ? currentRoomId.value : null,
          createdFrom: 'chat_action'
        }
      })
      if (isMemoryPanelOpen.value) {
        await loadMemoryState()
      }
      toast.add({
        title: scope === 'ROOM' ? 'Saved to this chat memory' : 'Saved across chats',
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: 'Memory save failed',
        description: error?.data?.message || 'Could not save this memory.',
        color: 'error'
      })
    }
  }

  const forgetFromText = async (text: string) => {
    const content = text.trim()
    if (!content) return

    try {
      const response = await ($fetch as any)('/api/chat/memory/forget', {
        method: 'POST',
        body: {
          content,
          roomId: currentRoomId.value
        }
      })
      if (isMemoryPanelOpen.value) {
        await loadMemoryState()
      }
      if (response?.status === 'ambiguous') {
        toast.add({
          title: 'Multiple memories matched',
          description: 'Open Memory to choose the exact item to remove.',
          color: 'warning'
        })
        return
      }
      if (response?.status === 'not_found') {
        toast.add({
          title: 'No saved memory matched',
          color: 'neutral'
        })
        return
      }
      toast.add({
        title: 'Memory removed',
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: 'Forget failed',
        description: error?.data?.message || 'Could not remove that memory.',
        color: 'error'
      })
    }
  }

  const onRememberMessage = async (payload: { text: string }) => {
    await rememberFromText(payload.text, 'GLOBAL')
  }

  const onForgetMessage = async (payload: { text: string }) => {
    await forgetFromText(payload.text)
  }

  const selectMemory = (memory: any) => {
    selectedMemoryId.value = memory.id
    editingMemory.value = null
  }

  const beginCreateMemory = () => {
    editingMemory.value = null
    selectedMemoryId.value = null
    resetMemoryDraft()
  }

  const clearOutgoingQueueState = () => {
    queuedOutgoingByRoom.value = {}
    clearChatOutgoingQueue()
    Object.keys(queueReconcileTimersByRoom).forEach((roomId) => clearQueueReconcileTimer(roomId))
  }

  watch(isShareModalOpen, () => {
    if (!isShareModalOpen.value) {
      shareLink.value = ''
    }
  })

  watch(currentRoomId, () => {
    shareLink.value = ''
  })

  watch(isMemoryPanelOpen, (open) => {
    if (open && currentRoomId.value) {
      void loadMemoryState()
    }
  })

  watch(currentRoomId, () => {
    if (isMemoryPanelOpen.value && currentRoomId.value) {
      void loadMemoryState()
    }
  })

  watch(
    () => [userStore.user?.id, coachingStore.actingAsUserId] as const,
    ([nextUserId, nextActingAsUserId], previous) => {
      const [prevUserId, prevActingAsUserId] = previous || [undefined, undefined]
      if (
        (prevUserId && nextUserId && prevUserId !== nextUserId) ||
        prevActingAsUserId !== nextActingAsUserId
      ) {
        clearOutgoingQueueState()
      }
    }
  )

  watch(
    () => [uiChatStatus.value, queuedMessageCount.value] as const,
    ([status, queueCount]) => {
      if (!currentRoomId.value || status !== 'ready' || queueCount === 0) return
      void processQueuedMessagesForRoom(currentRoomId.value)
    },
    { flush: 'post' }
  )

  async function resumeTurn(turnId: string) {
    if (!turnId) return

    try {
      await $fetch<any, string & {}>(`/api/chat/turns/${turnId}/resume`, {
        method: 'POST'
      })
      if (currentRoomId.value) {
        await loadMessages(currentRoomId.value)
      }
      restartTurnPolling({ forceForMs: 15000 })
      toast.add({
        title: 'Response resumed',
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: 'Resume failed',
        description: error?.data?.message || 'Could not resume that response.',
        color: 'error'
      })
    }
  }

  async function retryTurn(turnId: string) {
    if (!turnId) return

    try {
      await $fetch<any, string & {}>(`/api/chat/turns/${turnId}/retry`, {
        method: 'POST'
      })
      if (currentRoomId.value) {
        await loadMessages(currentRoomId.value)
      }
      restartTurnPolling({ forceForMs: 15000 })
      toast.add({
        title: 'Retry queued',
        color: 'success'
      })
    } catch (error: any) {
      toast.add({
        title: 'Retry failed',
        description: error?.data?.message || 'Could not retry that response.',
        color: 'error'
      })
    }
  }
</script>

<template>
  <UDashboardPanel
    id="chat"
    class="overflow-hidden"
    :style="{ height: chatViewportHeight }"
    :ui="{ body: 'p-0 min-h-0 overflow-hidden' }"
  >
    <template #header>
      <div class="sticky top-0 z-20">
        <UDashboardNavbar :title="currentRoomName">
          <template #leading>
            <UDashboardSidebarCollapse />
            <UButton
              color="neutral"
              variant="ghost"
              icon="i-heroicons-clock"
              aria-label="Open chat history"
              @click="
                () => {
                  void chatSidebarRef?.open()
                }
              "
            />
          </template>
          <template #right>
            <LayoutPageNavbarActions :overflow-items="chatOverflowItems">
              <ClientOnly>
                <DashboardTriggerMonitorButton />
                <NotificationDropdown />
              </ClientOnly>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-heroicons-bookmark"
                aria-label="Manage Memory"
                size="sm"
                class="font-bold"
                :disabled="!currentRoomId"
                @click="
                  () => {
                    void openMemoryPanel()
                  }
                "
              >
                <span class="hidden md:inline">Memory</span>
              </UButton>
              <UButton
                color="neutral"
                variant="outline"
                icon="i-heroicons-share"
                aria-label="Share Chat"
                size="sm"
                class="font-bold"
                :disabled="!currentRoomId"
                @click="
                  () => {
                    isShareModalOpen = true
                  }
                "
              >
                <span class="hidden md:inline">{{ t('nav_share') }}</span>
              </UButton>
              <UButton
                to="/settings/ai"
                icon="i-heroicons-cog-6-tooth"
                color="neutral"
                variant="outline"
                size="sm"
                class="font-bold"
                aria-label="AI Settings"
              >
                <span class="hidden md:inline">{{ t('nav_settings') }}</span>
              </UButton>
              <UButton
                color="primary"
                variant="solid"
                icon="i-heroicons-chat-bubble-left-right"
                aria-label="New Chat"
                size="sm"
                class="font-bold"
                @click="
                  () => {
                    void createNewChat()
                  }
                "
              >
                <span class="hidden md:inline">{{ t('nav_new_chat') }}</span>
                <span class="md:hidden">{{ t('controls_chat') }}</span>
              </UButton>

              <template #mobile>
                <LayoutNavbarIconButton
                  icon="i-heroicons-chat-bubble-left-right"
                  label="New Chat"
                  color="primary"
                  variant="solid"
                  @click="
                    () => {
                      void createNewChat()
                    }
                  "
                />
              </template>
            </LayoutPageNavbarActions>
          </template>
        </UDashboardNavbar>
      </div>
    </template>

    <template #body>
      <div class="flex h-full min-h-0 overscroll-none">
        <!-- Sidebar and Mobile Drawer -->
        <ChatSidebar
          ref="chatSidebarRef"
          :rooms="rooms"
          :current-room-id="currentRoomId"
          :loading="loadingRooms"
          @select="selectRoom"
          @delete="deleteRoom"
          @rename="renameRoom"
        />

        <!-- Chat Area -->
        <div class="flex-1 flex min-w-0 min-h-0 flex-col overflow-hidden">
          <!-- Read-only Banner -->
          <div
            v-if="isCurrentRoomReadOnly"
            class="p-2 sm:p-4 border-b border-warning-200 bg-warning-50 dark:border-warning-900/50 dark:bg-warning-950/20"
          >
            <UAlert
              color="warning"
              variant="subtle"
              icon="i-heroicons-information-circle"
              :title="t('legacy_banner_title')"
              :description="t('legacy_banner_desc')"
            >
              <template #actions>
                <UButton
                  color="warning"
                  variant="outline"
                  size="xs"
                  :label="t('legacy_banner_action')"
                  @click="
                    () => {
                      void createNewChat()
                    }
                  "
                />
              </template>
            </UAlert>
          </div>

          <!-- Messages -->
          <ChatMessageList
            :key="currentRoomId || 'no-room'"
            :messages="chatMessages"
            :status="uiChatStatus"
            :loading="loadingMessages"
            :load-error="messagesLoadError"
            :can-edit-messages="
              uiChatStatus === 'ready' && queuedMessageCount === 0 && !isCurrentRoomReadOnly
            "
            :editing-message-id="editingMessage?.id || null"
            :editing-content="editingContent"
            :saving-edited-message="savingEditedMessage"
            @tool-approval="onToolApproval"
            @edit-message="openEditMessageInline"
            @update:editing-content="editingContent = $event"
            @save-edit="saveEditedMessage"
            @cancel-edit="cancelEditedMessage"
            @resume-turn="resumeTurn"
            @retry-turn="retryTurn"
            @remember-message="onRememberMessage"
            @forget-message="onForgetMessage"
            @retry-load="retryChatLoad"
          />

          <!-- Input -->
          <ChatInput
            ref="chatInputRef"
            v-model="input"
            :status="composerStatus"
            :error="chat.error"
            :disabled="isCurrentRoomReadOnly"
            :queued-count="queuedMessageCount"
            :has-active-turn="uiChatStatus === 'streaming'"
            mobile-enter-behavior="newline"
            @submit="onSubmit"
          />
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <USlideover
    v-model:open="isMemoryPanelOpen"
    title="Manage Memory"
    description="Control what the coach remembers across chats and in this conversation."
    side="right"
    :ui="{ content: 'w-full sm:max-w-6xl' }"
  >
    <template #content>
      <div class="flex h-full min-h-0 flex-col">
        <div class="border-b border-gray-200 px-4 py-4 dark:border-gray-800">
          <div class="flex flex-wrap items-center gap-2">
            <div class="flex items-center gap-2">
              <UButton
                :variant="memoryTab === 'global' ? 'solid' : 'outline'"
                color="neutral"
                size="sm"
                @click="
                  () => {
                    void selectMemoryTab('global')
                  }
                "
              >
                Across chats
              </UButton>
              <UButton
                :variant="memoryTab === 'room' ? 'solid' : 'outline'"
                color="neutral"
                size="sm"
                @click="
                  () => {
                    void selectMemoryTab('room')
                  }
                "
              >
                This chat
              </UButton>
            </div>
            <div class="ml-auto flex flex-wrap items-center gap-3">
              <USwitch
                :model-value="showSensitiveMemories"
                label="Show sensitive"
                @update:model-value="showSensitiveMemories = !!$event"
              />
              <USwitch
                :model-value="aiMemorySettings.aiMemoryEnabled"
                :disabled="savingMemorySettings"
                label="Use memory"
                @update:model-value="toggleMemoryEnabled(!!$event)"
              />
            </div>
          </div>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <UInput
              v-model="memorySearch"
              icon="i-heroicons-magnifying-glass"
              placeholder="Search memories"
              class="min-w-0 flex-1 [&_input]:text-[15px] [&_input]:tracking-[0.01em]"
            />
            <UButton
              color="primary"
              variant="soft"
              icon="i-heroicons-plus"
              @click="
                () => {
                  void beginCreateMemory()
                }
              "
            >
              Add memory
            </UButton>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div
            class="flex min-h-0 w-full flex-col border-b border-gray-200 lg:w-[24rem] lg:border-b-0 lg:border-r dark:border-gray-800"
          >
            <div v-if="loadingMemoryPanel" class="space-y-3">
              <div class="p-4">
                <USkeleton class="h-24 w-full rounded-2xl" />
              </div>
              <div class="px-4 pb-4">
                <USkeleton class="h-24 w-full rounded-2xl" />
              </div>
            </div>

            <div
              v-else-if="isCurrentMemoryTabEmpty"
              class="m-4 rounded-2xl border border-dashed border-gray-300 p-6 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400"
            >
              No saved memories yet.
            </div>

            <div v-else class="min-h-0 flex-1 overflow-y-auto p-4">
              <div
                v-if="memoryTab === 'room' && roomHistorySummary"
                class="mb-4 rounded-2xl border border-gray-200 bg-gray-50/80 p-4 dark:border-gray-800 dark:bg-gray-900/70"
              >
                <div class="mb-2 flex items-center justify-between gap-3">
                  <div class="text-sm font-semibold">Room summary</div>
                  <div v-if="roomLastSummarizedAt" class="text-xs text-gray-500">
                    {{ formatDateTime(roomLastSummarizedAt) }}
                  </div>
                </div>
                <p class="text-sm leading-6 text-gray-700 dark:text-gray-200">
                  {{ roomHistorySummary }}
                </p>
              </div>

              <div class="space-y-3">
                <div
                  v-for="memory in currentVisibleMemories"
                  :key="memory.id"
                  class="cursor-pointer rounded-2xl border p-4 shadow-sm transition-colors"
                  :class="
                    selectedMemoryId === memory.id
                      ? 'border-primary bg-primary/5 dark:border-primary'
                      : 'border-gray-200 bg-white/90 dark:border-gray-800 dark:bg-gray-900/80'
                  "
                  @click="
                    () => {
                      void selectMemory(memory)
                    }
                  "
                >
                  <div class="mb-3 flex flex-wrap items-center gap-2">
                    <UBadge color="neutral" variant="soft" size="xs">
                      {{ formatMemoryCategory(memory.category) }}
                    </UBadge>
                    <UBadge color="neutral" variant="outline" size="xs">
                      {{ formatMemorySource(memory.source) }}
                    </UBadge>
                    <UBadge v-if="memory.scope === 'ROOM'" color="warning" variant="soft" size="xs">
                      {{ formatMemoryScope(memory.scope) }}
                    </UBadge>
                    <UBadge v-else color="primary" variant="soft" size="xs">
                      {{ formatMemoryScope(memory.scope) }}
                    </UBadge>
                    <UBadge v-if="memory.sensitive" color="error" variant="soft" size="xs">
                      Sensitive
                    </UBadge>
                    <UBadge v-if="memory.pinned" color="success" variant="soft" size="xs">
                      Pinned
                    </UBadge>
                  </div>
                  <p class="line-clamp-3 text-sm leading-6 text-gray-900 dark:text-white">
                    {{ memory.content }}
                  </p>
                  <div class="mt-3 text-xs text-gray-500 dark:text-gray-400">
                    Updated {{ formatDateTime(memory.updatedAt) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <div class="p-4 sm:p-6">
              <div
                class="rounded-3xl border border-gray-200 bg-white/90 p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900/80"
              >
                <template v-if="editingMemory">
                  <div class="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <h3 class="text-base font-semibold leading-6 text-gray-900 dark:text-white">
                        Edit Memory
                      </h3>
                      <p class="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
                        Adjust the content, scope, and sensitivity for this memory.
                      </p>
                    </div>
                  </div>
                  <div class="space-y-4">
                    <UTextarea
                      v-model="editingMemory.content"
                      :rows="4"
                      autoresize
                      class="w-full [&_textarea]:text-sm [&_textarea]:leading-6"
                    />
                    <div class="grid gap-3 sm:grid-cols-2">
                      <USelect
                        v-model="editingMemory.category"
                        :items="memoryCategories"
                        option-attribute="label"
                        value-attribute="value"
                      />
                      <USelect
                        v-model="editingMemory.scope"
                        :items="memoryScopeItems"
                        option-attribute="label"
                        value-attribute="value"
                      />
                    </div>
                    <div class="flex flex-wrap items-center gap-3">
                      <USwitch
                        v-model="editingMemory.sensitive"
                        label="Sensitive"
                        description="Health or personal details that should stay easy to review and control."
                      />
                      <USwitch
                        v-model="editingMemory.pinned"
                        label="Pin"
                        description="Keep this memory prioritized when selecting what the coach should remember."
                      />
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <UButton
                        @click="
                          () => {
                            void saveEditedMemory()
                          }
                        "
                        >Save changes</UButton
                      >
                      <UButton
                        color="neutral"
                        variant="ghost"
                        @click="
                          () => {
                            void cancelEditingMemory()
                          }
                        "
                        >Cancel</UButton
                      >
                    </div>
                  </div>
                </template>

                <template v-else-if="selectedMemory">
                  <div class="mb-4">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 class="text-base font-semibold leading-6 text-gray-900 dark:text-white">
                          Memory Details
                        </h3>
                        <div class="mt-2 flex flex-wrap items-center gap-2">
                          <UBadge color="neutral" variant="soft" size="xs">
                            {{ formatMemoryCategory(selectedMemory.category) }}
                          </UBadge>
                          <UBadge color="neutral" variant="outline" size="xs">
                            {{ formatMemorySource(selectedMemory.source) }}
                          </UBadge>
                          <UBadge
                            :color="selectedMemory.scope === 'ROOM' ? 'warning' : 'primary'"
                            variant="soft"
                            size="xs"
                          >
                            {{ formatMemoryScope(selectedMemory.scope) }}
                          </UBadge>
                          <UBadge
                            v-if="selectedMemory.sensitive"
                            color="error"
                            variant="soft"
                            size="xs"
                          >
                            Sensitive
                          </UBadge>
                          <UBadge
                            v-if="selectedMemory.pinned"
                            color="success"
                            variant="soft"
                            size="xs"
                          >
                            Pinned
                          </UBadge>
                        </div>
                      </div>
                      <div
                        class="flex items-center gap-1.5 rounded-full border border-gray-200/80 bg-white/60 px-2 py-1 dark:border-gray-700 dark:bg-gray-900/50"
                      >
                        <UButton
                          size="sm"
                          color="neutral"
                          variant="ghost"
                          :icon="
                            selectedMemory.pinned ? 'i-heroicons-star-solid' : 'i-heroicons-star'
                          "
                          class="rounded-full"
                          @click="
                            () => {
                              void toggleMemoryPinned(selectedMemory)
                            }
                          "
                        />
                        <UButton
                          size="sm"
                          color="neutral"
                          variant="ghost"
                          icon="i-heroicons-arrow-right-circle"
                          class="rounded-full"
                          @click="
                            () => {
                              moveMemoryScope(
                                selectedMemory,
                                getOppositeMemoryScope(selectedMemory.scope)
                              )
                            }
                          "
                        />
                        <UButton
                          size="sm"
                          color="neutral"
                          variant="ghost"
                          icon="i-heroicons-pencil-square"
                          class="rounded-full"
                          @click="
                            () => {
                              void startEditingMemory(selectedMemory)
                            }
                          "
                        />
                        <UButton
                          size="sm"
                          color="error"
                          variant="ghost"
                          icon="i-heroicons-trash"
                          class="rounded-full"
                          @click="
                            () => {
                              void deleteMemory(selectedMemory.id)
                            }
                          "
                        />
                      </div>
                    </div>
                  </div>
                  <p class="max-w-4xl text-sm leading-7 text-gray-900 dark:text-white">
                    {{ selectedMemory.content }}
                  </p>
                  <div
                    class="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-gray-200/70 pt-4 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"
                  >
                    <div class="flex items-center gap-2">
                      <span
                        class="font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500"
                      >
                        Updated
                      </span>
                      <span>{{ formatDateTime(selectedMemory.updatedAt) }}</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <span
                        class="font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500"
                      >
                        Confirmed
                      </span>
                      <span>{{
                        formatDateTime(selectedMemory.lastConfirmedAt) || 'Not confirmed yet'
                      }}</span>
                    </div>
                  </div>
                </template>

                <template v-else>
                  <div class="mb-4">
                    <h3 class="text-base font-semibold leading-6 text-gray-900 dark:text-white">
                      Add Memory
                    </h3>
                    <p class="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
                      Save something the coach should remember across chats or only in this room.
                    </p>
                  </div>
                  <div class="space-y-4">
                    <UTextarea
                      v-model="memoryDraft.content"
                      :rows="5"
                      autoresize
                      class="w-full [&_textarea]:text-sm [&_textarea]:leading-6"
                      placeholder="Example: I prefer morning workouts and concise answers."
                    />
                    <div class="grid gap-3 sm:grid-cols-2">
                      <USelect
                        v-model="memoryDraft.scope"
                        :items="memoryScopeItems"
                        option-attribute="label"
                        value-attribute="value"
                      />
                      <USelect
                        v-model="memoryDraft.category"
                        :items="memoryCategories"
                        option-attribute="label"
                        value-attribute="value"
                      />
                    </div>
                    <div class="flex flex-wrap items-center gap-3">
                      <USwitch
                        v-model="memoryDraft.sensitive"
                        label="Sensitive"
                        description="Health or personal details that should stay easy to review and control."
                      />
                      <USwitch
                        v-model="memoryDraft.pinned"
                        label="Pin"
                        description="Keep this memory prioritized when selecting what the coach should remember."
                      />
                    </div>
                    <UButton
                      block
                      @click="
                        () => {
                          void createMemory()
                        }
                      "
                      >Save memory</UButton
                    >
                  </div>
                </template>
              </div>
            </div>
          </div>
          <div class="border-t border-gray-200 px-4 py-3 dark:border-gray-800">
            <div class="flex w-full items-center justify-between">
              <UButton
                color="neutral"
                variant="ghost"
                @click="
                  () => {
                    void loadMemoryState()
                  }
                "
                >Refresh</UButton
              >
              <UButton
                color="neutral"
                variant="ghost"
                @click="
                  () => {
                    isMemoryPanelOpen = false
                  }
                "
                >Close</UButton
              >
            </div>
          </div>
        </div>
      </div>
    </template>
  </USlideover>

  <UModal
    v-model:open="isShareModalOpen"
    :title="t('modal_share_title', { name: currentRoomName })"
    :description="t('modal_share_history_desc')"
  >
    <template #body>
      <ShareAccessPanel
        :link="shareLink"
        :loading="generatingShareLink"
        :expiry-value="shareExpiryValue"
        resource-label="chat history"
        :share-title="`AI Chat: ${currentRoomName}`"
        @update:expiry-value="shareExpiryValue = $event"
        @generate="generateShareLink"
        @copy="copyToClipboard"
      />
    </template>
    <template #footer>
      <UButton
        :label="t('banner_exit')"
        color="neutral"
        variant="ghost"
        @click="
          () => {
            isShareModalOpen = false
          }
        "
      />
    </template>
  </UModal>
</template>
