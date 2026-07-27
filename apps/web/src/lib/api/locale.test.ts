import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { patchUserLocale } from './locale.js'

describe('patchUserLocale (Story 15.1 AC 2/6)', () => {
  it('PATCHes the self-service locale endpoint with the chosen locale', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { locale: 'es' } }))

    const result = await patchUserLocale(fetchFn, 'es')

    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/users/me/locale',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ locale: 'es' }),
      })
    )
    expect(result.locale).toBe('es')
  })
})
