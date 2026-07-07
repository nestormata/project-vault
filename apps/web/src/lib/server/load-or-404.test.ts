import { describe, expect, it } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { loadOr404 } from './load-or-404.js'

describe('loadOr404', () => {
  it('returns the loader result on success', async () => {
    const result = await loadOr404(async () => 'ok', 'fallback')
    expect(result).toBe('ok')
  })

  it('returns notFoundValue on a 404 ApiClientError', async () => {
    const result = await loadOr404(async () => {
      throw new ApiClientError(404, null, 'not found')
    }, 'fallback')
    expect(result).toBe('fallback')
  })

  it('rethrows a non-404 ApiClientError', async () => {
    await expect(
      loadOr404(async () => {
        throw new ApiClientError(500, null, 'boom')
      }, 'fallback')
    ).rejects.toThrow('boom')
  })

  it('rethrows a non-ApiClientError error', async () => {
    await expect(
      loadOr404(async () => {
        throw new Error('unexpected')
      }, 'fallback')
    ).rejects.toThrow('unexpected')
  })
})
