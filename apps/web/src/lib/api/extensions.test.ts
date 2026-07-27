import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { getExtensionStatus } from './extensions.js'

describe('getExtensionStatus', () => {
  it('calls GET /api/v1/admin/extensions/status and returns the parsed manifest', async () => {
    // The API route returns the manifest as the bare response body (no `data` envelope wrapper)
    // — see apps/api/src/extensions/status-routes.ts's handler, which returns the object or
    // `null` directly rather than `{ data: ... }`.
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        name: 'com.acme.sso-extension',
        apiVersion: '1.2.0',
        capabilities: ['auth-provider'],
        loadedAt: '2026-07-20T10:00:00.000Z',
      })
    )

    const result = await getExtensionStatus(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/admin/extensions/status',
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual({
      name: 'com.acme.sso-extension',
      apiVersion: '1.2.0',
      capabilities: ['auth-provider'],
      loadedAt: '2026-07-20T10:00:00.000Z',
    })
  })

  it('returns null when the API returns a null manifest (no extension configured)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(null))

    expect(await getExtensionStatus(fetchFn)).toBeNull()
  })

  it('returns a manifest with an empty capabilities array unchanged (AC-2 edge case)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        name: 'com.acme.no-caps-extension',
        apiVersion: '1.0.0',
        capabilities: [],
        loadedAt: '2026-07-20T10:00:00.000Z',
      })
    )

    const result = await getExtensionStatus(fetchFn)
    expect(result?.capabilities).toEqual([])
  })
})
