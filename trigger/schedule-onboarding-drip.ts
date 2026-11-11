import { task, logger } from '@trigger.dev/sdk/v3'
import { prisma } from '../server/utils/db'
import { emailQueue } from './queues'
import { getCurrentTaskExecution } from '../server/utils/task-registry'
import { dispatchTask } from '../server/utils/task-dispatcher'

type OnboardingDripPayload = { userId: string; stage?: 'day2' | 'day7' }

const DAY_MS = 24 * 60 * 60 * 1000

export const scheduleOnboardingDripTask = task({
  id: 'schedule-onboarding-drip',
  queue: emailQueue,
  maxDuration: 900,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000
  },
  run: async (payload: OnboardingDripPayload, context?: { ctx: { run: { createdAt?: Date } } }) => {
    const { userId } = payload
    logger.log('Starting onboarding drip sequence', { userId })

    if (!payload.stage) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { createdAt: true, deactivatedAt: true }
      })
      if (!user || user.deactivatedAt) return { success: true, userId }

      // Use the original run's timestamp, never its retry/processing time.
      // Direct context-free invocations fall back to the signup timestamp.
      let scheduledAt = context?.ctx?.run.createdAt?.getTime() ?? user.createdAt.getTime()
      const runId = getCurrentTaskExecution()?.runId
      if (runId?.startsWith('redis:')) {
        const { mainTaskQueue } = await import('../server/utils/queue')
        const job = await mainTaskQueue.getJob(runId.slice('redis:'.length))
        if (!job) throw new Error('Onboarding scheduling job disappeared')
        scheduledAt = job.timestamp
      }
      // Enqueue both stages now so a late Day 2 worker cannot push back Day 7.
      for (const [stage, days] of [
        ['day2', 2],
        ['day7', 7]
      ] as const) {
        await dispatchTask(
          'schedule-onboarding-drip',
          { userId, stage },
          {
            delay: `${Math.max(0, scheduledAt + days * DAY_MS - Date.now())}ms`,
            idempotencyKey: `onboarding-drip-stage-${stage}:${userId}`
          }
        )
      }
      return { success: true, userId }
    }

    if (payload.stage === 'day2') {
      const userDay2 = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          deactivatedAt: true,
          stravaAccount: { select: { id: true } },
          garminAccount: { select: { id: true } },
          wahooAccount: { select: { id: true } },
          intervalsProfile: { select: { id: true } },
          ouraAccount: { select: { id: true } },
          polarAccount: { select: { id: true } },
          whoopAccount: { select: { id: true } },
          fitbitAccount: { select: { id: true } },
          withingsAccount: { select: { id: true } }
        }
      })

      if (userDay2 && !userDay2.deactivatedAt) {
        const hasIntegration = Boolean(
          userDay2.stravaAccount ||
          userDay2.garminAccount ||
          userDay2.wahooAccount ||
          userDay2.intervalsProfile ||
          userDay2.ouraAccount ||
          userDay2.polarAccount ||
          userDay2.whoopAccount ||
          userDay2.fitbitAccount ||
          userDay2.withingsAccount
        )

        if (!hasIntegration) {
          logger.log('User has no connected integrations on Day 2, sending OnboardingDripDay2', {
            userId
          })
          await dispatchTask('send-email', {
            userId,
            templateKey: 'OnboardingDripDay2',
            eventKey: 'ONBOARDING_DRIP_DAY2',
            idempotencyKey: `onboarding-drip-day2:${userId}`,
            audience: 'ENGAGEMENT',
            subject: 'Connect your training apps to unlock Coach Watts',
            props: {
              name: userDay2.name || 'Athlete'
            }
          })
        } else {
          logger.log('User has connected integrations on Day 2, skipping Day 2 email', { userId })
        }
      }

      return { success: true, userId }
    }

    if (payload.stage !== 'day7') throw new Error('Unknown onboarding drip stage')

    const userDay7 = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, deactivatedAt: true }
    })

    if (userDay7 && !userDay7.deactivatedAt) {
      logger.log('Sending Day 7 onboarding trial check-in email', { userId })
      await dispatchTask('send-email', {
        userId,
        templateKey: 'OnboardingDripDay7',
        eventKey: 'ONBOARDING_DRIP_DAY7',
        idempotencyKey: `onboarding-drip-day7:${userId}`,
        audience: 'ENGAGEMENT',
        subject: 'How was your first week with Coach Watts?',
        props: {
          name: userDay7.name || 'Athlete'
        }
      })
    }

    return { success: true, userId }
  }
})
