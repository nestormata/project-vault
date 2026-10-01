import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './map-with-concurrency.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('mapWithConcurrency', () => {
  it('returns an empty array without calling fn for an empty input', async () => {
    let calls = 0
    const result = await mapWithConcurrency([], 3, () => {
      calls++
      return Promise.resolve(1)
    })
    expect(result).toEqual([])
    expect(calls).toBe(0)
  })

  it('preserves input order in the results even when items finish out of order', async () => {
    const delays = [30, 5, 15, 0]
    const result = await mapWithConcurrency(delays, 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms * 2
    })
    expect(result).toEqual([60, 10, 30, 0])
  })

  it('never runs more than `limit` calls at once, and does reach the limit', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 2))
        inFlight--
      }
    )
    expect(maxInFlight).toBe(3)
  })

  it('starts no more than items.length workers when the limit exceeds the input size', async () => {
    const started: number[] = []
    await mapWithConcurrency([1, 2], 5, (n) => {
      started.push(n)
      return Promise.resolve(n)
    })
    expect(started).toEqual([1, 2])
  })

  it('rejects with the first error and starts no further items after a rejection', async () => {
    const started: number[] = []
    const gate = deferred<undefined>()
    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
      started.push(n)
      if (n === 0) throw new Error('boom')
      await gate.promise
      return n
    })
    await expect(run).rejects.toThrow('boom')
    gate.resolve(undefined)
    await new Promise((r) => setTimeout(r, 5))
    // Item 0 failed and item 1 was already in flight; nothing after the failure was started.
    expect(started).toEqual([0, 1])
  })

  it('rejects a non-positive or non-integer limit', async () => {
    await expect(mapWithConcurrency([1], 0, (n) => Promise.resolve(n))).rejects.toThrow(RangeError)
    await expect(mapWithConcurrency([1], 1.5, (n) => Promise.resolve(n))).rejects.toThrow(
      RangeError
    )
  })
})
