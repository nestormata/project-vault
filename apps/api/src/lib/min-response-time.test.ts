import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { holdUntilMinResponse, monotonicNowMs, withMinResponseTime } from './min-response-time.js'

describe('min-response-time', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('holdUntilMinResponse', () => {
    it('resolves only after the deadline measured from the start', async () => {
      const start = monotonicNowMs()
      vi.advanceTimersByTime(30)
      let done = false
      void holdUntilMinResponse(start, 100).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(69)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
    })

    it('does not wait when the deadline has already passed', async () => {
      const start = monotonicNowMs()
      vi.advanceTimersByTime(500)
      await expect(holdUntilMinResponse(start, 100)).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('withMinResponseTime', () => {
    const isMiss = (v: string) => v === 'miss'

    it('holds a miss that finished early until the deadline', async () => {
      let done = false
      void withMinResponseTime(100, () => Promise.resolve('miss'), { isMiss }).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(99)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
    })

    it('returns a success immediately, without arming a timer', async () => {
      await expect(withMinResponseTime(100, () => Promise.resolve('ok'), { isMiss })).resolves.toBe(
        'ok'
      )
      expect(vi.getTimerCount()).toBe(0)
    })

    it('adds no extra hold when the miss work was slower than the minimum', async () => {
      const promise = withMinResponseTime(
        50,
        () => new Promise<string>((resolve) => setTimeout(() => resolve('miss'), 80)),
        { isMiss }
      )
      await vi.advanceTimersByTimeAsync(80)
      await expect(promise).resolves.toBe('miss')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('propagates an unclassified error without holding it', async () => {
      await expect(
        withMinResponseTime(100, () => Promise.reject(new Error('boom')), { isMiss })
      ).rejects.toThrow('boom')
      expect(vi.getTimerCount()).toBe(0)
    })

    it('holds an error classified as a miss, then rethrows it', async () => {
      class Limited extends Error {}
      let settled = false
      const promise = withMinResponseTime(100, () => Promise.reject(new Limited('429')), {
        isMiss,
        isMissError: (e) => e instanceof Limited,
      }).catch((e: unknown) => {
        settled = true
        return e
      })
      await vi.advanceTimersByTimeAsync(99)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await promise).toBeInstanceOf(Limited)
    })
  })
})
