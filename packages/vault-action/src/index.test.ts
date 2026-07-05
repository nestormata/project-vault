import { describe, expect, it, vi } from 'vitest'

const setFailedMock = vi.fn()

vi.mock('@actions/core', () => ({
  setFailed: setFailedMock,
}))

vi.mock('./run.js', () => ({
  run: vi.fn(() => Promise.reject(new Error('boom'))),
}))

describe('index entry point', () => {
  it('converts an unexpected run() rejection into core.setFailed instead of an unhandled rejection', async () => {
    await import('./index.js')
    // Let the run().catch(...) microtask settle.
    await new Promise((resolve) => setImmediate(resolve))

    expect(setFailedMock).toHaveBeenCalledWith(
      expect.stringContaining('vault-action: unexpected internal error: boom')
    )
  })
})
