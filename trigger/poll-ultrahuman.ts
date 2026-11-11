import { task } from '@trigger.dev/sdk/v3'
import { formatInTimeZone } from 'date-fns-tz'
import { prisma } from '../server/utils/db'
import { getUserTimezone, getUserLocalDate } from '../server/utils/date'
import type { UltrahumanSettings } from '../server/utils/ultrahuman'
import { dispatchTask } from '../server/utils/task-dispatcher'

// CW-188: This used to be a `schedules.task` with a declarative `cron`, which
// keeps re-registering an active schedule trigger on Trigger.dev Cloud every
// time it's deployed there. Actual scheduling now happens exclusively via
// cw:worker's Redis/BullMQ job scheduler (see cli/worker/start.ts,
// registerScheduledTasks), driven off the `schedule.cron` entry for this task
// id in server/utils/task-manifest.json. Keep this a plain `task()` so no
// declarative schedule gets synced back to Trigger.dev Cloud. The Redis
// scheduler synthesizes the same { timestamp, timezone, scheduleId, upcoming }
// payload shape the SDK's schedules.task would have provided (see
// mainTaskWorker in cli/worker/start.ts), so `payload.timestamp` below still
// works.
export const pollUltrahumanTask = task({
  id: 'poll-ultrahuman',
  // Actual cron ("5 * * * *", every hour at :05) lives in
  // server/utils/task-manifest.json and is registered by cw:worker.
  run: async (payload) => {
    const now = new Date(payload.timestamp)

    // 1. Find all Ultrahuman integrations
    const integrations = await prisma.integration.findMany({
      where: {
        provider: 'ultrahuman'
      },
      include: {
        user: true
      }
    })

    console.log(`[Ultrahuman Poller] Found ${integrations.length} integrations to check.`)

    for (const integration of integrations) {
      try {
        const settings = (integration.settings as unknown as UltrahumanSettings) || {}

        // Skip if auto-sync is explicitly disabled
        if (settings.autoSync === false) {
          continue
        }

        const userId = integration.userId
        const timezone = await getUserTimezone(userId)
        const userNow = getUserLocalDate(timezone, now)
        // userNow carries a calendar date at UTC midnight, not the current local time.
        const userHour = Number(formatInTimeZone(now, timezone, 'H'))

        let shouldTrigger = false

        // A. Check Preferred Sync Time (HH:mm)
        if (settings.preferredSyncTime) {
          const [prefHour] = settings.preferredSyncTime.split(':').map(Number)
          if (userHour === prefHour) {
            console.log(
              `[Ultrahuman Poller] Hour matches preferred time (${prefHour}:00) for user ${userId}`
            )
            shouldTrigger = true
          }
        }

        // B. Safety fallback: Sync every 6 hours if no match yet
        // This ensures data stays fresh even if preferred time is missed or not set
        if (!shouldTrigger && userHour % 6 === 0) {
          console.log(`[Ultrahuman Poller] 6-hour window trigger for user ${userId}`)
          shouldTrigger = true
        }

        if (shouldTrigger) {
          // Sync today and yesterday
          const startDate = new Date(userNow)
          startDate.setUTCDate(startDate.getUTCDate() - 1)
          const endDate = new Date(userNow)

          console.log(
            `[Ultrahuman Poller] Triggering ingestion for ${userId} (${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]})`
          )

          await dispatchTask(
            'ingest-ultrahuman',
            {
              userId,
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString()
            },
            {
              concurrencyKey: userId,
              tags: [`user:${userId}`, 'auto-poll']
            }
          )
        }
      } catch (err) {
        console.error(`[Ultrahuman Poller] Error processing integration ${integration.id}:`, err)
      }
    }
  }
})
