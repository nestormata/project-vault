import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { getThemes, patchThemeSelection, triggerThemeReload } from './themes.js'

describe('getThemes (Story 16.2 AC-1)', () => {
  it('calls GET /api/v1/themes', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ themes: [], selected: null }))

    const result = await getThemes(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/themes',
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result).toEqual({ themes: [], selected: null })
  })
})

describe('patchThemeSelection (Story 16.2 AC-2)', () => {
  it('calls PATCH /api/v1/themes/selection with the themeName body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ themeName: 'acme-brand' }))

    const result = await patchThemeSelection(fetchFn, 'acme-brand')

    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/themes/selection')
    expect(init).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ themeName: 'acme-brand' })
    expect(result).toEqual({ themeName: 'acme-brand' })
  })
})

// Story 16.3 Task 1 — triggerThemeReload mirrors platform.ts's triggerBackup(fetchFn) exactly: a
// bare POST with no body.
describe('triggerThemeReload (Story 16.3 AC-2, AC-3)', () => {
  it('calls POST /api/v1/admin/themes/reload with no body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ loaded: ['acme-brand'], failed: [] }))

    const result = await triggerThemeReload(fetchFn)

    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/admin/themes/reload')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
    expect((init as RequestInit).body).toBeUndefined()
    expect(result).toEqual({ loaded: ['acme-brand'], failed: [] })
  })

  it('surfaces the loaded/failed shape unchanged, including a partial-failure result', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        loaded: ['acme-brand'],
        failed: [{ file: 'broken.css', reason: 'invalid CSS syntax' }],
      })
    )

    const result = await triggerThemeReload(fetchFn)

    expect(result).toEqual({
      loaded: ['acme-brand'],
      failed: [{ file: 'broken.css', reason: 'invalid CSS syntax' }],
    })
  })
})
