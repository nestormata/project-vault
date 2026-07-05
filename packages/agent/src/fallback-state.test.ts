import { describe, expect, it } from 'vitest'
import {
  createFallbackState,
  markLiveRetryAttempted,
  recordNetworkFailure,
  recordSuccess,
  shouldAttemptLiveRetry,
} from './fallback-state.js'

describe('fallback-state', () => {
  it('does not enter fallback mode before the threshold is reached', () => {
    const state = createFallbackState()
    recordNetworkFailure(state, 3)
    recordNetworkFailure(state, 3)
    expect(state.inFallback).toBe(false)
  })

  it('enters fallback mode once the threshold of consecutive failures is reached', () => {
    const state = createFallbackState()
    recordNetworkFailure(state, 3)
    recordNetworkFailure(state, 3)
    recordNetworkFailure(state, 3)
    expect(state.inFallback).toBe(true)
  })

  it('resets the counter on any success, so 2 failures + a success never trips fallback', () => {
    const state = createFallbackState()
    recordNetworkFailure(state, 3)
    recordNetworkFailure(state, 3)
    recordSuccess(state)
    expect(state.consecutiveFailures).toBe(0)
    expect(state.inFallback).toBe(false)

    recordNetworkFailure(state, 3)
    recordNetworkFailure(state, 3)
    expect(state.inFallback).toBe(false)
  })

  it('activates fallback immediately with an explicit threshold of 1', () => {
    const state = createFallbackState()
    recordNetworkFailure(state, 1)
    expect(state.inFallback).toBe(true)
  })

  it('resets the failure window if failures are more than 30s apart', () => {
    const state = createFallbackState()
    const t0 = 1_000_000
    recordNetworkFailure(state, 3, t0)
    recordNetworkFailure(state, 3, t0 + 31_000)
    // Window reset — this counts as failure 1 of a new window, not failure 2.
    expect(state.consecutiveFailures).toBe(1)
    expect(state.inFallback).toBe(false)
  })

  it('always allows a live attempt when not in fallback mode', () => {
    const state = createFallbackState()
    expect(shouldAttemptLiveRetry(state)).toBe(true)
  })

  it('throttles live retries to at most once every 30 seconds while in fallback mode', () => {
    const state = createFallbackState()
    const t0 = 1_000_000
    recordNetworkFailure(state, 1, t0)
    markLiveRetryAttempted(state, t0)

    expect(shouldAttemptLiveRetry(state, t0 + 1_000)).toBe(false)
    expect(shouldAttemptLiveRetry(state, t0 + 30_000)).toBe(true)
  })
})
