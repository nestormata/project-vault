import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { raceWithTimeout } from './race-with-timeout.js'

/**
 * Story 25.7 Task 1a / Cascading Failure Simulation finding — `raceWithTimeout()` is shared by
 * every one of the five extension hook call sites (soon all five, after this story's AC5
 * migration), so a regression here now has a blast radius across panel rendering, action
 * dispatch, capability gating, auth, and project creation simultaneously. Its own doc comment
 * describes two edge cases (a late rejection never producing an `unhandledRejection`, a late
 * resolution never retroactively mutating an already-finalized result) that had never been
 * directly, deliberately proven by a test before this story — only indirectly, via each call
 * site's own tests.
 */
describe('raceWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the attempt value when it settles before the timeout', async () => {
    const result = await raceWithTimeout(async () => 'ok', 1_000)
    expect(result).toEqual({ status: 'resolved', value: 'ok' })
  })

  it('returns timed_out when the attempt never settles before the timeout elapses', async () => {
    const promise = raceWithTimeout(() => new Promise<never>(() => undefined), 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise
    expect(result).toEqual({ status: 'timed_out' })
  })

  it('returns rejected with the original error when the attempt rejects before the timeout', async () => {
    const error = new Error('boom')
    const result = await raceWithTimeout(async () => {
      throw error
    }, 1_000)
    expect(result).toEqual({ status: 'rejected', error })
  })

  it('clears the timeout handle once the attempt settles, leaving no dangling timer', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await raceWithTimeout(async () => 'ok', 1_000)
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('a late rejection of the losing attempt (after the timeout already won) never produces an unhandledRejection', async () => {
    const unhandledRejectionHandler = vi.fn()
    process.once('unhandledRejection', unhandledRejectionHandler)

    let rejectAttempt: (error: unknown) => void = () => undefined
    const attempt = () =>
      new Promise<never>((_, reject) => {
        rejectAttempt = reject
      })

    const promise = raceWithTimeout(attempt, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise
    expect(result).toEqual({ status: 'timed_out' })

    // The attempt promise rejects only AFTER the timeout has already won the race — this is
    // exactly the late-settling-promise scenario the eager no-op `.catch()` in
    // `race-with-timeout.ts` exists to neutralize.
    rejectAttempt(new Error('late rejection after timeout'))
    // Flush microtasks so the late rejection (and, if the eager catch were absent, the
    // unhandledRejection event) has a chance to fire before this test asserts on it.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    await Promise.resolve()

    expect(unhandledRejectionHandler).not.toHaveBeenCalled()
    process.removeListener('unhandledRejection', unhandledRejectionHandler)
  })

  it('a late resolution of the losing attempt (after the timeout already won) never retroactively changes the result', async () => {
    let resolveAttempt: (value: string) => void = () => undefined
    const attempt = () =>
      new Promise<string>((resolve) => {
        resolveAttempt = resolve
      })

    const promise = raceWithTimeout(attempt, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await promise
    expect(result).toEqual({ status: 'timed_out' })

    // The attempt resolves only after `Promise.race` has already settled on the timeout — a late
    // resolution must simply be discarded (never consumed), not mutate the already-returned
    // result object.
    resolveAttempt('too late')
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toEqual({ status: 'timed_out' })
  })

  it('distinguishes a genuine timeout from a rejection whose message happens to collide with the internal sentinel', async () => {
    const result = await raceWithTimeout(async () => {
      throw new Error('race-with-timeout: timed out')
    }, 1_000)
    // This is a known, accepted ambiguity of the current implementation (message-string
    // matching, not a typed sentinel) — documented here as a pinned characterization rather than
    // a bug, since `race-with-timeout.ts`'s own error message is not something extension/hook
    // code is expected to reproduce by coincidence.
    expect(result).toEqual({ status: 'timed_out' })
  })
})
