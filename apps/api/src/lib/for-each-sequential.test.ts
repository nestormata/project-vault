import { describe, expect, it } from 'vitest'
import { forEachSequential } from './for-each-sequential.js'

describe('forEachSequential', () => {
  it('resolves without calling fn for an empty input', async () => {
    let calls = 0
    await forEachSequential([], () => {
      calls += 1
      return Promise.resolve()
    })
    expect(calls).toBe(0)
  })

  it('runs items strictly one after another, in order, never overlapping', async () => {
    const events: string[] = []
    let active = 0
    let maxActive = 0
    await forEachSequential(['a', 'b', 'c'], async (item, index) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push(`start:${item}:${index}`)
      await Promise.resolve()
      events.push(`end:${item}`)
      active -= 1
    })
    expect(maxActive).toBe(1)
    expect(events).toEqual(['start:a:0', 'end:a', 'start:b:1', 'end:b', 'start:c:2', 'end:c'])
  })

  it('stops at the first rejection and does not start later items', async () => {
    const seen: number[] = []
    await expect(
      forEachSequential([1, 2, 3], (n) => {
        seen.push(n)
        return n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve()
      })
    ).rejects.toThrow('boom')
    expect(seen).toEqual([1, 2])
  })

  it('turns a synchronous throw from fn into a rejection', async () => {
    await expect(
      forEachSequential([1], () => {
        throw new Error('sync boom')
      })
    ).rejects.toThrow('sync boom')
  })
})
