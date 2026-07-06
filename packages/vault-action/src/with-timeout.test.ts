import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VAULT_ACTION_TIMEOUT_MS, VaultActionTimeoutError, withTimeout } from './with-timeout.js'

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the wrapped value when it settles before the deadline', async () => {
    const promise = withTimeout(() => Promise.resolve('value'))
    await expect(promise).resolves.toBe('value')
  })

  it('rejects with the original error when the wrapped promise rejects before the deadline', async () => {
    const promise = withTimeout(() => Promise.reject(new Error('boom')))
    await expect(promise).rejects.toThrow('boom')
  })

  it('rejects with VaultActionTimeoutError once the fixed deadline elapses', async () => {
    const hung = new Promise<string>(() => {})
    const promise = withTimeout(() => hung, VAULT_ACTION_TIMEOUT_MS)

    const assertion = expect(promise).rejects.toBeInstanceOf(VaultActionTimeoutError)
    await vi.advanceTimersByTimeAsync(VAULT_ACTION_TIMEOUT_MS)
    await assertion
  })

  it('does not fire the timeout after the promise has already resolved', async () => {
    const promise = withTimeout(() => Promise.resolve('fast'), VAULT_ACTION_TIMEOUT_MS)
    const result = await promise
    expect(result).toBe('fast')
    // Advancing time after resolution must not throw an unhandled rejection.
    await vi.advanceTimersByTimeAsync(VAULT_ACTION_TIMEOUT_MS + 1000)
  })
})
