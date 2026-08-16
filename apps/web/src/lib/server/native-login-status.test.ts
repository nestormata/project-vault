import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import {
  __resetNativeLoginStatusCacheForTests,
  resolveNativeLoginEnabled,
} from './native-login-status.js'

describe('resolveNativeLoginEnabled (Story 23.2 AC-13)', () => {
  beforeEach(() => {
    __resetNativeLoginStatusCacheForTests()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns true when the health check succeeds with nativeLoginEnabled: true', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ nativeLoginEnabled: true }))
    const result = await resolveNativeLoginEnabled(fetchFn)
    expect(result).toBe(true)
  })

  it('returns false when the health check succeeds with nativeLoginEnabled: false', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ nativeLoginEnabled: false }))
    const result = await resolveNativeLoginEnabled(fetchFn)
    expect(result).toBe(false)
  })

  it('treats a missing field as enabled — version-skew fail-safe (AC-13)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' }))
    const result = await resolveNativeLoginEnabled(fetchFn)
    expect(result).toBe(true)
  })

  it('cold-start failure (no cache yet): returns null, the "temporarily unavailable" signal', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network error'))
    const result = await resolveNativeLoginEnabled(fetchFn)
    expect(result).toBeNull()
  })

  it('a non-ok HTTP status is treated as a failure', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }))
    const result = await resolveNativeLoginEnabled(fetchFn)
    expect(result).toBeNull()
  })

  it('serves the last-known-good cached value on a subsequent failure within 60s', async () => {
    const okFetch = vi.fn().mockResolvedValue(jsonResponse({ nativeLoginEnabled: false }))
    await resolveNativeLoginEnabled(okFetch)

    const failFetch = vi.fn().mockRejectedValue(new Error('blip'))
    const result = await resolveNativeLoginEnabled(failFetch)

    expect(result).toBe(false)
  })

  it('does not consult the cache at all on a successful call — always reflects the live value', async () => {
    const firstFetch = vi.fn().mockResolvedValue(jsonResponse({ nativeLoginEnabled: false }))
    await resolveNativeLoginEnabled(firstFetch)

    const secondFetch = vi.fn().mockResolvedValue(jsonResponse({ nativeLoginEnabled: true }))
    const result = await resolveNativeLoginEnabled(secondFetch)

    expect(result).toBe(true)
  })

  it('the cache expires after 60s — a failure past expiry returns null, not the stale value', async () => {
    vi.useFakeTimers()
    const okFetch = vi.fn().mockResolvedValue(jsonResponse({ nativeLoginEnabled: false }))
    await resolveNativeLoginEnabled(okFetch)

    vi.advanceTimersByTime(60_001)

    const failFetch = vi.fn().mockRejectedValue(new Error('blip'))
    const result = await resolveNativeLoginEnabled(failFetch)

    expect(result).toBeNull()
  })
})
