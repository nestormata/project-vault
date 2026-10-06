import { describe, expect, it } from 'vitest'
import { firstResultSequential } from './first-result-sequential.js'

describe('firstResultSequential', () => {
  it('resolves undefined without calling fn for an empty input', async () => {
    let calls = 0
    const result = await firstResultSequential([], () => {
      calls += 1
      return Promise.resolve('x')
    })
    expect(result).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('resolves the first non-nullish result and does not start later items', async () => {
    const seen: number[] = []
    const result = await firstResultSequential([1, 2, 3, 4], (n) => {
      seen.push(n)
      return Promise.resolve(n === 2 ? 'found' : null)
    })
    expect(result).toBe('found')
    expect(seen).toEqual([1, 2])
  })

  it('treats null and undefined as "continue" but 0, "" and false as results', async () => {
    expect(await firstResultSequential([1, 2], (n) => Promise.resolve(n === 1 ? null : 0))).toBe(0)
    expect(
      await firstResultSequential([1, 2], (n) => Promise.resolve(n === 1 ? undefined : ''))
    ).toBe('')
    expect(await firstResultSequential([1], () => Promise.resolve(false))).toBe(false)
  })

  it('resolves undefined when every call yields none, having tried each item in order', async () => {
    const events: string[] = []
    let active = 0
    let maxActive = 0
    const result = await firstResultSequential(['a', 'b', 'c'], async (item, index) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push(`start:${item}:${index}`)
      await Promise.resolve()
      events.push(`end:${item}`)
      active -= 1
      return null
    })
    expect(result).toBeUndefined()
    expect(maxActive).toBe(1)
    expect(events).toEqual(['start:a:0', 'end:a', 'start:b:1', 'end:b', 'start:c:2', 'end:c'])
  })

  it('stops at the first rejection and does not start later items', async () => {
    const seen: number[] = []
    await expect(
      firstResultSequential([1, 2, 3], (n) => {
        seen.push(n)
        return n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(null)
      })
    ).rejects.toThrow('boom')
    expect(seen).toEqual([1, 2])
  })

  it('turns a synchronous throw from fn into a rejection', async () => {
    await expect(
      firstResultSequential([1], () => {
        throw new Error('sync boom')
      })
    ).rejects.toThrow('sync boom')
  })
})
