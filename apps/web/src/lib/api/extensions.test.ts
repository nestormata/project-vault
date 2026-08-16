import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { getExtensionStatus, type NativeLoginPolicy } from './extensions.js'

// Story 23.2 AC-12: the route returns an envelope, `{ extension, nativeLoginPolicy }`, as the
// bare response body (no `data` wrapper) — see apps/api/src/extensions/status-routes.ts.
const SAMPLE_POLICY: NativeLoginPolicy = {
  enabled: true,
  state: 'enabled',
  replacementDeclared: false,
  replacementProven: false,
  replacementProvenAt: null,
  appliedAtBoot: false,
  breakGlassActive: false,
  replacementConfirmedOverride: false,
  extensionStatus: 'not_configured',
  extensionFailureReason: null,
  sessionsLive: 0,
}

describe('getExtensionStatus', () => {
  it('calls GET /api/v1/admin/extensions/status and returns the parsed envelope', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        extension: {
          name: 'com.acme.sso-extension',
          apiVersion: '1.2.0',
          capabilities: ['auth-provider'],
          loadedAt: '2026-07-20T10:00:00.000Z',
        },
        nativeLoginPolicy: { ...SAMPLE_POLICY, extensionStatus: 'loaded' },
      })
    )

    const result = await getExtensionStatus(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/admin/extensions/status',
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result.extension).toEqual({
      name: 'com.acme.sso-extension',
      apiVersion: '1.2.0',
      capabilities: ['auth-provider'],
      loadedAt: '2026-07-20T10:00:00.000Z',
    })
    expect(result.nativeLoginPolicy.extensionStatus).toBe('loaded')
  })

  it('returns extension: null when no extension is configured', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ extension: null, nativeLoginPolicy: SAMPLE_POLICY }))

    const result = await getExtensionStatus(fetchFn)
    expect(result.extension).toBeNull()
    expect(result.nativeLoginPolicy).toEqual(SAMPLE_POLICY)
  })

  it('returns a manifest with an empty capabilities array unchanged (AC-2 edge case)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        extension: {
          name: 'com.acme.no-caps-extension',
          apiVersion: '1.0.0',
          capabilities: [],
          loadedAt: '2026-07-20T10:00:00.000Z',
        },
        nativeLoginPolicy: { ...SAMPLE_POLICY, extensionStatus: 'loaded' },
      })
    )

    const result = await getExtensionStatus(fetchFn)
    expect(result.extension?.capabilities).toEqual([])
  })
})
