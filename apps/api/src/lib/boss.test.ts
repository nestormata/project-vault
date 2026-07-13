import { describe, expect, it, vi } from 'vitest'
import { BossService } from './boss.js'

const TEST_QUEUE_NAME = 'prune-revoked-tokens'
const NOTIFICATION_EMAIL_JOB = 'notification/email'
const BOSS_NOT_STARTED_ERROR = 'BossService not started'

function createBossWithMocks(extra: Record<string, unknown> = {}) {
  return new BossService(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createQueue: vi.fn().mockResolvedValue(undefined),
    ...extra,
  }))
}

describe('BossService', () => {
  it('starts pg-boss only once and stops gracefully', async () => {
    const start = vi.fn().mockResolvedValue(undefined)
    const stop = vi.fn().mockResolvedValue(undefined)
    const boss = new BossService(() => ({
      start,
      stop,
    }))

    await boss.start()
    await boss.start()
    await boss.stop()
    await boss.stop()

    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('does not instantiate pg-boss when stopped before start', async () => {
    const createBoss = vi.fn(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }))
    const boss = new BossService(createBoss)

    await boss.stop()

    expect(createBoss).not.toHaveBeenCalled()
  })

  it('registers schedules and workers after start', async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined)
    const schedule = vi.fn().mockResolvedValue(undefined)
    const work = vi.fn().mockResolvedValue(undefined)
    const boss = new BossService(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      createQueue,
      schedule,
      work,
    }))
    const handler = vi.fn().mockResolvedValue(undefined)

    await boss.start()
    await boss.registerSchedules({ [TEST_QUEUE_NAME]: { cron: '0 * * * *' } })
    await boss.registerWorkers({ [TEST_QUEUE_NAME]: handler })

    expect(createQueue).toHaveBeenCalledWith(TEST_QUEUE_NAME)
    expect(schedule).toHaveBeenCalledWith(TEST_QUEUE_NAME, '0 * * * *', null, { tz: 'UTC' })
    expect(work).toHaveBeenCalledWith(TEST_QUEUE_NAME, expect.any(Function))
    expect(createQueue).toHaveBeenCalledTimes(1)
    const queueCreatedAt = createQueue.mock.invocationCallOrder[0]
    const scheduledAt = schedule.mock.invocationCallOrder[0]
    const workerRegisteredAt = work.mock.invocationCallOrder[0]
    expect(queueCreatedAt).toBeDefined()
    expect(scheduledAt).toBeDefined()
    expect(workerRegisteredAt).toBeDefined()
    expect(queueCreatedAt as number).toBeLessThan(scheduledAt as number)
    expect(queueCreatedAt as number).toBeLessThan(workerRegisteredAt as number)
    const registeredHandler = work.mock.calls[0]?.[1] as (job: { id: string }) => Promise<void>
    await registeredHandler({ id: 'job-123' })
    expect(handler).toHaveBeenCalledWith({ id: 'job-123' })
  })

  it('sends jobs after start', async () => {
    const send = vi.fn().mockResolvedValue('job-1')
    const boss = createBossWithMocks({ send })

    await boss.start()
    await boss.send(NOTIFICATION_EMAIL_JOB, { notificationQueueId: 'queue-1' }, { retryLimit: 3 })

    expect(send).toHaveBeenCalledWith(
      NOTIFICATION_EMAIL_JOB,
      { notificationQueueId: 'queue-1' },
      { retryLimit: 3 }
    )
  })

  it('passes singletonKey through to the underlying send call (Story 5.3 Task 4)', async () => {
    const ROTATION_RECOVER_JOB = 'rotation/recover'
    const send = vi.fn().mockResolvedValue('job-1')
    const boss = createBossWithMocks({ send })

    await boss.start()
    await boss.send(ROTATION_RECOVER_JOB, {}, { singletonKey: ROTATION_RECOVER_JOB })

    expect(send).toHaveBeenCalledWith(
      ROTATION_RECOVER_JOB,
      {},
      {
        singletonKey: ROTATION_RECOVER_JOB,
      }
    )
  })

  it('registers workers with concurrency options', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    const boss = createBossWithMocks({ work })
    const handler = vi.fn().mockResolvedValue(undefined)

    await boss.start()
    await boss.registerWorker(NOTIFICATION_EMAIL_JOB, handler, {
      localConcurrency: 5,
      localGroupConcurrency: 3,
    })

    expect(work).toHaveBeenCalledWith(
      NOTIFICATION_EMAIL_JOB,
      { localConcurrency: 5, localGroupConcurrency: 3 },
      expect.any(Function)
    )
  })

  describe('Story 10.4: not-started guards', () => {
    it('isStarted() is false before start() and true after', async () => {
      const boss = createBossWithMocks()
      expect(boss.isStarted()).toBe(false)
      await boss.start()
      expect(boss.isStarted()).toBe(true)
    })

    it('ensureQueue() throws when not started', async () => {
      const boss = createBossWithMocks()
      await expect(boss.ensureQueue(TEST_QUEUE_NAME)).rejects.toThrow(BOSS_NOT_STARTED_ERROR)
    })

    it('send() throws when not started', async () => {
      const boss = createBossWithMocks()
      await expect(boss.send(NOTIFICATION_EMAIL_JOB, {})).rejects.toThrow(BOSS_NOT_STARTED_ERROR)
    })

    it('registerSchedules() throws when not started', async () => {
      const boss = createBossWithMocks()
      await expect(
        boss.registerSchedules({ [TEST_QUEUE_NAME]: { cron: '0 * * * *' } })
      ).rejects.toThrow(BOSS_NOT_STARTED_ERROR)
    })

    it('registerWorker() throws when not started', async () => {
      const boss = createBossWithMocks()
      await expect(boss.registerWorker(TEST_QUEUE_NAME, async () => {})).rejects.toThrow(
        BOSS_NOT_STARTED_ERROR
      )
    })
  })

  describe('Story 10.4: unavailable-API guards', () => {
    it('ensureQueue() throws when the underlying client has no createQueue API', async () => {
      const boss = new BossService(() => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      }))
      await boss.start()
      await expect(boss.ensureQueue(TEST_QUEUE_NAME)).rejects.toThrow(
        'BossService createQueue API unavailable'
      )
    })

    it('send() throws when the underlying client has no send API', async () => {
      const boss = createBossWithMocks()
      await boss.start()
      await expect(boss.send(NOTIFICATION_EMAIL_JOB, {})).rejects.toThrow(
        'BossService send API unavailable'
      )
    })

    it('registerSchedules() throws when the underlying client has no schedule API', async () => {
      const boss = createBossWithMocks()
      await boss.start()
      await expect(
        boss.registerSchedules({ [TEST_QUEUE_NAME]: { cron: '0 * * * *' } })
      ).rejects.toThrow('BossService schedule API unavailable')
    })

    it('registerWorker() throws when the underlying client has no work API', async () => {
      const boss = createBossWithMocks()
      await boss.start()
      await expect(boss.registerWorker(TEST_QUEUE_NAME, async () => {})).rejects.toThrow(
        'BossService work API unavailable'
      )
    })
  })

  it('constructing with a connection string builds a real PgBoss instance internally', () => {
    // Exercises the `typeof connectionStringOrFactory === 'string'` branch of the constructor.
    const boss = new BossService('postgres://localhost:5432/test')
    expect(boss.isStarted()).toBe(false)
  })

  it('ensureQueue() creates a queue once and skips recreation on a second call for the same name', async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined)
    const boss = createBossWithMocks({ createQueue })
    await boss.start()

    await boss.ensureQueue(TEST_QUEUE_NAME)
    await boss.ensureQueue(TEST_QUEUE_NAME)

    expect(createQueue).toHaveBeenCalledTimes(1)
  })

  it('registerWorker() without options calls work() with just name and handler (no options arg)', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    const boss = createBossWithMocks({ work })
    const handler = vi.fn().mockResolvedValue(undefined)

    await boss.start()
    await boss.registerWorker(TEST_QUEUE_NAME, handler)

    expect(work).toHaveBeenCalledWith(TEST_QUEUE_NAME, expect.any(Function))
    const registeredHandler = work.mock.calls[0]?.[1] as (job: { id: string }) => Promise<void>
    await registeredHandler({ id: 'job-x' })
    expect(handler).toHaveBeenCalledWith({ id: 'job-x' })
  })

  it('registerWorkers() dispatches a { handler, options } registration through registerWorker with options', async () => {
    const work = vi.fn().mockResolvedValue(undefined)
    const boss = createBossWithMocks({ work })
    const handler = vi.fn().mockResolvedValue(undefined)

    await boss.start()
    await boss.registerWorkers({
      [TEST_QUEUE_NAME]: { handler, options: { localConcurrency: 2 } },
    })

    expect(work).toHaveBeenCalledWith(
      TEST_QUEUE_NAME,
      { localConcurrency: 2 },
      expect.any(Function)
    )
  })
})
