import { describe, expect, it, vi } from 'vitest'
import { BossService } from './boss.js'

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
    const schedule = vi.fn().mockResolvedValue(undefined)
    const work = vi.fn().mockResolvedValue(undefined)
    const boss = new BossService(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      schedule,
      work,
    }))
    const handler = vi.fn().mockResolvedValue(undefined)

    await boss.start()
    await boss.registerSchedules({ 'prune-revoked-tokens': { cron: '0 * * * *' } })
    await boss.registerWorkers({ 'prune-revoked-tokens': handler })

    expect(schedule).toHaveBeenCalledWith('prune-revoked-tokens', '0 * * * *', null, { tz: 'UTC' })
    expect(work).toHaveBeenCalledWith('prune-revoked-tokens', expect.any(Function))
    const registeredHandler = work.mock.calls[0]?.[1] as (job: { id: string }) => Promise<void>
    await registeredHandler({ id: 'job-123' })
    expect(handler).toHaveBeenCalledWith({ id: 'job-123' })
  })
})
