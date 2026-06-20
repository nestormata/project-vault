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
})
