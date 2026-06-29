import { describe, expect, it, vi } from 'vitest'
import { BossService } from './boss.js'

const TEST_QUEUE_NAME = 'prune-revoked-tokens'

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
})
