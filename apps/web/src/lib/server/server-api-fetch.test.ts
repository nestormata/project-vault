import { describe, expect, it, vi } from 'vitest'
import { createServerApiFetch } from './server-api-fetch.js'
import { jsonResponse } from '$lib/test/json-response.js'

describe('server API fetch', () => {
  it('routes relative server API requests to the trusted API origin', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(jsonResponse({ status: 'ready' }))
    const fetchFn = createServerApiFetch({
      apiBaseUrl: 'http://api.local:3000',
      fetchFn: nativeFetch as unknown as typeof fetch,
    })

    await fetchFn('/ready?probe=1', { credentials: 'include' })

    expect(nativeFetch).toHaveBeenCalledWith('http://api.local:3000/ready?probe=1', {
      credentials: 'include',
    })
  })

  it('falls back to the local API origin when no trusted API base is configured', async () => {
    const nativeFetch = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    const fetchFn = createServerApiFetch({
      apiBaseUrl: '',
      fetchFn: nativeFetch as unknown as typeof fetch,
    })

    await fetchFn('/api/v1/auth/me')

    expect(nativeFetch).toHaveBeenCalledWith('http://localhost:3000/api/v1/auth/me', undefined)
  })
})
