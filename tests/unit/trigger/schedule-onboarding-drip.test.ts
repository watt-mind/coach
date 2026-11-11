import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleOnboardingDripTask } from '../../../trigger/schedule-onboarding-drip'

import {
  executeRegisteredTask,
  registerCanonicalTaskHandler
} from '../../../server/utils/task-registry'

const { findUnique, dispatchTask, getJob } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  dispatchTask: vi.fn(),
  getJob: vi.fn()
}))
vi.mock('../../../server/utils/db', () => ({ prisma: { user: { findUnique } } }))
vi.mock('../../../server/utils/task-dispatcher', () => ({ dispatchTask }))
vi.mock('../../../server/utils/queue', () => ({ mainTaskQueue: { getJob } }))
vi.mock('../../../trigger/queues', () => ({ emailQueue: {} }))
// Keep real SDK waits: calling one without task context must fail this regression.
vi.mock('@trigger.dev/sdk/v3', async () => ({
  ...(await vi.importActual('@trigger.dev/sdk/v3')),
  task: (config: unknown) => config,
  logger: { log: vi.fn() }
}))

const run = scheduleOnboardingDripTask.run
const signup = new Date('2026-11-01T12:00:00Z')
const DAY = 86_400_000

describe('onboarding durable stages', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(signup)
    findUnique.mockResolvedValue({ id: 'u1', name: 'Alex', createdAt: signup, deactivatedAt: null })
    dispatchTask.mockResolvedValue({ id: 'job' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it.each(['redis', 'trigger'])(
    'schedules both stages without SDK context on %s',
    async (driver) => {
      vi.stubEnv('TASK_QUEUE_DRIVER', driver)
      await run({ userId: 'u1' })
      expect(dispatchTask.mock.calls).toEqual([
        [
          'schedule-onboarding-drip',
          { userId: 'u1', stage: 'day2' },
          {
            delay: `${2 * DAY}ms`,
            idempotencyKey: 'onboarding-drip-stage-day2:u1'
          }
        ],
        [
          'schedule-onboarding-drip',
          { userId: 'u1', stage: 'day7' },
          {
            delay: `${7 * DAY}ms`,
            idempotencyKey: 'onboarding-drip-stage-day7:u1'
          }
        ]
      ])
    }
  )

  it('uses the immutable Redis enqueue timestamp through the registered handler', async () => {
    const enqueuedAt = signup.getTime() + DAY
    getJob.mockResolvedValue({ timestamp: enqueuedAt })
    registerCanonicalTaskHandler('schedule-onboarding-drip', (payload) => run(payload))
    vi.setSystemTime(enqueuedAt + DAY)
    await executeRegisteredTask(
      'schedule-onboarding-drip',
      { userId: 'u1' },
      { runId: 'redis:parent' }
    )
    expect(getJob).toHaveBeenCalledWith('parent')
    expect(dispatchTask.mock.calls.map((call) => call[2].delay)).toEqual([
      `${DAY}ms`,
      `${6 * DAY}ms`
    ])
  })

  it('uses the original Trigger run timestamp across retries', async () => {
    vi.setSystemTime(signup.getTime() + DAY)
    await run({ userId: 'u1' }, { ctx: { run: { createdAt: signup } } })
    expect(dispatchTask.mock.calls.map((call) => call[2].delay)).toEqual([
      `${DAY}ms`,
      `${6 * DAY}ms`
    ])
  })

  it('retains signup deadlines and keys after a partial scheduling failure', async () => {
    dispatchTask.mockResolvedValueOnce({ id: 'day2' }).mockRejectedValueOnce(new Error('queue'))
    await expect(run({ userId: 'u1' })).rejects.toThrow('queue')
    vi.setSystemTime(signup.getTime() + 3 * DAY)
    dispatchTask.mockClear()
    await run({ userId: 'u1' })
    expect(dispatchTask.mock.calls.map((call) => call[2])).toEqual([
      { delay: '0ms', idempotencyKey: 'onboarding-drip-stage-day2:u1' },
      { delay: `${4 * DAY}ms`, idempotencyKey: 'onboarding-drip-stage-day7:u1' }
    ])
  })

  it.each(['day2', 'day7'] as const)(
    'preserves %s email contract on repeated execution',
    async (stage) => {
      for (let i = 0; i < 2; i++) await run({ userId: 'u1', stage })
      const day = stage === 'day2' ? '2' : '7'
      expect(dispatchTask).toHaveBeenCalledTimes(2)
      for (const [task, payload] of dispatchTask.mock.calls) {
        expect(task).toBe('send-email')
        expect(payload).toEqual({
          userId: 'u1',
          templateKey: `OnboardingDripDay${day}`,
          eventKey: `ONBOARDING_DRIP_DAY${day}`,
          idempotencyKey: `onboarding-drip-day${day}:u1`,
          audience: 'ENGAGEMENT',
          subject:
            stage === 'day2'
              ? 'Connect your training apps to unlock Coach Watts'
              : 'How was your first week with Coach Watts?',
          props: { name: 'Alex' }
        })
      }
    }
  )

  it.each([
    'stravaAccount',
    'garminAccount',
    'wahooAccount',
    'intervalsProfile',
    'ouraAccount',
    'polarAccount',
    'whoopAccount',
    'fitbitAccount',
    'withingsAccount'
  ])('skips Day 2 for %s but retains Day 7 eligibility', async (integration) => {
    findUnique.mockResolvedValue({ name: null, [integration]: { id: 'connected' } })
    await run({ userId: 'u1', stage: 'day2' })
    expect(dispatchTask).not.toHaveBeenCalled()
    expect(findUnique.mock.calls[0][0].select[integration]).toEqual({ select: { id: true } })
    await run({ userId: 'u1', stage: 'day7' })
    expect(dispatchTask).toHaveBeenCalledWith(
      'send-email',
      expect.objectContaining({ props: { name: 'Athlete' } })
    )
  })

  it.each([undefined, 'day2', 'day7'] as const)(
    'skips missing and deactivated users at %s',
    async (stage) => {
      for (const user of [null, { deactivatedAt: signup }]) {
        findUnique.mockResolvedValue(user)
        await run({ userId: 'u1', stage })
      }
      expect(dispatchTask).not.toHaveBeenCalled()
    }
  )

  it('does not reschedule Day 7 when Day 2 runs late or retries a failed email dispatch', async () => {
    vi.setSystemTime(signup.getTime() + 8 * DAY)
    dispatchTask.mockRejectedValueOnce(new Error('email queue'))
    await expect(run({ userId: 'u1', stage: 'day2' })).rejects.toThrow('email queue')
    await run({ userId: 'u1', stage: 'day2' })
    expect(dispatchTask.mock.calls.every(([task]) => task === 'send-email')).toBe(true)
    expect(dispatchTask.mock.calls[0]).toEqual(dispatchTask.mock.calls[1])
  })
})
