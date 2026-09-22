import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFetchProvenanceTracking } from './cache-provenance.js'

const EXAMPLE_URL = 'https://example.com'

describe('withFetchProvenanceTracking', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reports no network failure when fetch is never called', async () => {
    const { result, servedAfterNetworkFailure } = await withFetchProvenanceTracking(
      async () => 'value'
    )
    expect(result).toBe('value')
    expect(servedAfterNetworkFailure).toBe(false)
  })

  it('reports no network failure when every fetch call resolves normally', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok'))
    const { servedAfterNetworkFailure } = await withFetchProvenanceTracking(async () => {
      await globalThis.fetch(EXAMPLE_URL)
      return 'value'
    })
    expect(servedAfterNetworkFailure).toBe(false)
  })

  it('reports a network failure when a fetch call throws a TypeError (connection refused/DNS/timeout)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const { result, servedAfterNetworkFailure } = await withFetchProvenanceTracking(async () => {
      try {
        await globalThis.fetch(EXAMPLE_URL)
      } catch {
        // swallowed here, mirroring how packages/agent internally falls back to cache
      }
      return 'cached-value'
    })
    expect(result).toBe('cached-value')
    expect(servedAfterNetworkFailure).toBe(true)
  })

  it('does not flag a resolved non-2xx HTTP response as a network failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }))
    const { servedAfterNetworkFailure } = await withFetchProvenanceTracking(async () => {
      await globalThis.fetch(EXAMPLE_URL)
      return 'value'
    })
    expect(servedAfterNetworkFailure).toBe(false)
  })

  it('restores the original global fetch after resolving', async () => {
    const sentinelFetch = vi.fn()
    globalThis.fetch = sentinelFetch
    await withFetchProvenanceTracking(async () => 'value')
    expect(globalThis.fetch).toBe(sentinelFetch)
  })

  it('restores the original global fetch even when the wrapped function throws', async () => {
    const sentinelFetch = vi.fn()
    globalThis.fetch = sentinelFetch
    await expect(
      withFetchProvenanceTracking(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(globalThis.fetch).toBe(sentinelFetch)
  })

  it('propagates a rejection from the wrapped function', async () => {
    await expect(
      withFetchProvenanceTracking(async () => {
        throw new Error('agent error')
      })
    ).rejects.toThrow('agent error')
  })
})
