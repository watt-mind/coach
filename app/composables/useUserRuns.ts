import { ref, computed, watch, getCurrentScope, onScopeDispose } from 'vue'
import {
  ACTIVE_STATUSES,
  mergeActiveRunsFromApi,
  pruneRunsForCurrentUser,
  type TriggerRun
} from '../utils/user-runs-client'

export interface RealtimeDomainEvent {
  type: 'domain_event'
  channel?: string
  event?: {
    scope?: string
    entityType?: string
    entityId?: string
    reason?: string
    occurredAt?: string
  }
}

// Global Singleton State
const runs = ref<TriggerRun[]>([])
const isConnected = ref(false)
const isLoading = ref(false)
let ws: WebSocket | null = null
let connectionGeneration = 0
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
let activeSubscribers = 0
let initPromise: Promise<void> | null = null
let pollInterval: NodeJS.Timeout | null = null
let pingInterval: NodeJS.Timeout | null = null
const realtimeListeners = new Set<(event: RealtimeDomainEvent) => void>()
let lastPollAt = 0

const FAST_POLL_INTERVAL_MS = 5000
const IDLE_POLL_INTERVAL_MS = 15000

const trackedUserId: string | null = null

function getSessionUserId(session: { user?: { id?: string } } | null | undefined): string | null {
  const id = session?.user?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function resetRunsForIdentityChange() {
  runs.value = []
  initPromise = null
  cleanupUserRunsConnection()
}

function cleanupUserRunsConnection() {
  connectionGeneration++
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }
  const socket = ws
  ws = null
  socket?.close()

  isConnected.value = false
  initPromise = null

  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }

  if (pingInterval) {
    clearInterval(pingInterval)
    pingInterval = null
  }
}

export function useUserRuns() {
  const { data: session } = useAuth()
  const hasUserSession = computed(() => Boolean((session.value?.user as any)?.id))

  // --- Initial Fetch ---
  const fetchActiveRuns = async () => {
    if (!hasUserSession.value) {
      runs.value = []
      return
    }

    if (isLoading.value) return

    isLoading.value = true
    lastPollAt = Date.now()
    try {
      const data = (await ($fetch as any)('/api/runs/active')) as TriggerRun[]
      const userId = getSessionUserId(session.value)
      const mergedRuns = mergeActiveRunsFromApi(runs.value, data)
      runs.value = pruneRunsForCurrentUser(mergedRuns, userId)
    } catch (e) {
      // Failed to fetch active runs
    } finally {
      isLoading.value = false
    }
  }

  // --- Polling ---
  const startPolling = () => {
    if (pollInterval) return
    pollInterval = setInterval(() => {
      if (activeSubscribers <= 0 || !hasUserSession.value) {
        return
      }

      const hasActiveRuns = runs.value.some((run) => ACTIVE_STATUSES.includes(run.status))
      const minInterval = hasActiveRuns ? FAST_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS

      if (Date.now() - lastPollAt >= minInterval) {
        fetchActiveRuns()
      }
    }, 1000)
  }

  const stopPolling = () => {
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
  }

  const stopPing = () => {
    if (pingInterval) {
      clearInterval(pingInterval)
      pingInterval = null
    }
  }

  const startPing = () => {
    stopPing()
    // Send a ping every 30 seconds to keep the connection alive
    // This prevents Nginx/Cloudflare/Browsers from closing idle connections
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('ping')
      }
    }, 30000)
  }

  // --- WebSocket ---
  const connectWebSocket = () => {
    if (ws || activeSubscribers <= 0) return
    if (!session.value?.user || !(session.value.user as any).id) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/api/websocket`

    const socket = new WebSocket(url)
    ws = socket

    socket.onopen = async () => {
      if (ws !== socket) return
      isConnected.value = true
      startPolling()
      startPing()
      if (session.value?.user && (session.value.user as any).id) {
        try {
          const { token } = await ($fetch as any)('/api/websocket-token')
          if (ws !== socket || socket.readyState !== WebSocket.OPEN) return
          socket.send(JSON.stringify({ type: 'authenticate', token }))
          socket.send(JSON.stringify({ type: 'subscribe_user' }))
        } catch (e) {
          console.error('WS Auth failed', e)
        }
      }
    }

    socket.onmessage = (event) => {
      if (ws !== socket) return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'run_update') {
          handleRunUpdate(data)
        } else if (data.type === 'domain_event') {
          realtimeListeners.forEach((listener) => listener(data))
        } else if (data.type === 'notification_new') {
          const notificationStore = useNotificationStore()
          const inserted = notificationStore.addNotification(data.notification)

          // Show toast for new notification
          if (inserted) {
            const toast = useToast()
            toast.add({
              title: data.notification.title,
              description: data.notification.message,
              icon: data.notification.icon || 'i-heroicons-bell',
              color: 'primary',
              onClick: () => {
                if (data.notification.link) {
                  navigateTo(data.notification.link)
                }
              }
            })
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    socket.onclose = () => {
      if (ws !== socket) return
      isConnected.value = false
      ws = null
      stopPing()
      startPolling()
      if (activeSubscribers > 0) {
        reconnectTimeout = setTimeout(() => {
          reconnectTimeout = null
          connectWebSocket()
        }, 3000)
      }
    }
  }

  const handleRunUpdate = (update: any) => {
    const userId = getSessionUserId(session.value)
    const updateTags = Array.isArray(update.tags) ? update.tags : undefined
    if (updateTags && updateTags.length > 0 && userId && !updateTags.includes(`user:${userId}`)) {
      return
    }

    const existingIndex = runs.value.findIndex((r) => r.id === update.runId)
    const existing = existingIndex !== -1 ? runs.value[existingIndex] : null

    // Don't update if we already have a final status and the update is non-final (out of order WS messages)
    const isLocalFinal =
      existing && ['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'].includes(existing.status)
    const isUpdateFinal = ['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT'].includes(update.status)
    if (isLocalFinal && !isUpdateFinal) {
      return
    }

    const updatedRun: TriggerRun = {
      id: update.runId,
      taskIdentifier: update.taskIdentifier || existing?.taskIdentifier || 'Unknown Task',
      status: update.status,
      startedAt: update.startedAt || existing?.startedAt || new Date().toISOString(),
      finishedAt: update.finishedAt || existing?.finishedAt,
      output: update.output !== undefined ? update.output : existing?.output,
      error: update.error !== undefined ? update.error : existing?.error,
      tags: Array.isArray(update.tags) ? update.tags : existing?.tags
    }

    const newRuns = [...runs.value]
    if (existingIndex !== -1) {
      newRuns[existingIndex] = updatedRun
    } else {
      newRuns.unshift(updatedRun)
    }

    runs.value = pruneRunsForCurrentUser(newRuns, userId)
  }

  const cancelRun = async (runId: string) => {
    await $fetch<any, string & {}>(`/api/runs/${runId}`, { method: 'DELETE' as any })
  }

  const init = async () => {
    if (!hasUserSession.value) {
      runs.value = []
      return
    }

    const generation = connectionGeneration
    if (!initPromise) {
      initPromise = fetchActiveRuns()
    }
    await initPromise
    if (generation !== connectionGeneration || activeSubscribers <= 0) return
    connectWebSocket()
    startPolling()
  }

  if (import.meta.client) {
    watch(
      () => (session.value?.user as any)?.id,
      (newId, oldId) => {
        if (newId && newId !== oldId) {
          cleanupUserRunsConnection()
          runs.value = []
          initPromise = null
          init()
        } else if (newId) {
          init()
        } else {
          cleanupUserRunsConnection()
          runs.value = []
          initPromise = null
        }
      }
    )
  }

  if (import.meta.client) {
    activeSubscribers++
    if (hasUserSession.value) {
      void init()
    }

    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      activeSubscribers = Math.max(0, activeSubscribers - 1)

      if (activeSubscribers === 0) {
        cleanupUserRunsConnection()
      }
    }

    // Pinia setup stores and plugins have an effect scope even when they do not
    // have a component instance, so scope disposal is the safe cleanup primitive here.
    if (getCurrentScope()) {
      onScopeDispose(dispose)
    }
  }

  return {
    runs,
    isConnected,
    isLoading,
    refresh: fetchActiveRuns,
    cancelRun
  }
}

export function useRealtimeEvents() {
  useUserRuns()

  const onEvent = (callback: (event: RealtimeDomainEvent) => void) => {
    realtimeListeners.add(callback)

    const dispose = () => {
      realtimeListeners.delete(callback)
    }

    if (getCurrentScope()) {
      onScopeDispose(dispose)
    }

    return dispose
  }

  return {
    onEvent
  }
}

export function useUserRunsState() {
  const { runs, cancelRun } = useUserRuns()

  const activeRunCount = computed(
    () => runs.value.filter((r) => ACTIVE_STATUSES.includes(r.status)).length
  )

  const notifiedRunIds = new Set<string>()

  const invokeTaskCallback = (
    taskIdentifier: string,
    phase: 'completed' | 'failed',
    callback: (run: TriggerRun) => void | Promise<void>,
    run: TriggerRun
  ) => {
    try {
      void Promise.resolve(callback(run)).catch((error) => {
        console.error(`[useUserRuns] ${taskIdentifier} ${phase} callback failed`, error)
      })
    } catch (error) {
      console.error(`[useUserRuns] ${taskIdentifier} ${phase} callback threw`, error)
    }
  }

  const onTaskCompleted = (
    taskIdentifier: string,
    callback: (run: TriggerRun) => void | Promise<void>
  ) => {
    const setupTime = Date.now()

    // Keep track of which runs were already completed when this watcher started
    const alreadyCompleted = new Set(
      runs.value
        .filter((r) => r.taskIdentifier === taskIdentifier && r.status === 'COMPLETED')
        .map((r) => r.id)
    )

    watch(
      runs,
      (newRuns) => {
        const matches = newRuns.filter(
          (r) => r.taskIdentifier === taskIdentifier && r.status === 'COMPLETED'
        )
        matches.forEach((run) => {
          if (alreadyCompleted.has(run.id) || notifiedRunIds.has(run.id)) {
            return
          }

          // Only notify if it finished AFTER we set up this watcher
          // We add a 2-second grace period to account for minor clock differences
          // and the time it takes for the initial fetch to reach the client.
          const finishedTime = run.finishedAt ? new Date(run.finishedAt).getTime() : 0
          if (finishedTime > setupTime - 2000) {
            notifiedRunIds.add(run.id)
            invokeTaskCallback(taskIdentifier, 'completed', callback, run)
          } else {
            // It's an old run that just appeared in the list (e.g. after initial fetch)
            alreadyCompleted.add(run.id)
          }
        })
      },
      { deep: true, immediate: true }
    )
  }

  const onTaskFailed = (
    taskIdentifier: string,
    callback: (run: TriggerRun) => void | Promise<void>
  ) => {
    const setupTime = Date.now()

    const alreadyFailed = new Set(
      runs.value
        .filter((r) => r.taskIdentifier === taskIdentifier && r.status === 'FAILED')
        .map((r) => r.id)
    )

    watch(
      runs,
      (newRuns) => {
        const matches = newRuns.filter(
          (r) => r.taskIdentifier === taskIdentifier && r.status === 'FAILED'
        )
        matches.forEach((run) => {
          if (alreadyFailed.has(run.id) || notifiedRunIds.has(run.id)) {
            return
          }

          const finishedTime = run.finishedAt ? new Date(run.finishedAt).getTime() : 0
          if (finishedTime > setupTime - 2000) {
            notifiedRunIds.add(run.id)
            invokeTaskCallback(taskIdentifier, 'failed', callback, run)
          } else {
            alreadyFailed.add(run.id)
          }
        })
      },
      { deep: true, immediate: true }
    )
  }

  return {
    activeRunCount,
    runs,
    onTaskCompleted,
    onTaskFailed,
    cancelRun
  }
}
