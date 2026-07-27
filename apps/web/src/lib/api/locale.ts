import { apiFetch } from './client.js'

export type UserLocaleResponse = { locale: 'en' | 'es' }

/** Story 15.1 AC 6/8 — self-service locale change; the endpoint takes no userId, it operates
 * exclusively on the authenticated session's own user row. */
export function patchUserLocale(fetchFn: typeof fetch, locale: 'en' | 'es') {
  return apiFetch<UserLocaleResponse>(fetchFn, '/api/v1/users/me/locale', {
    method: 'PATCH',
    body: JSON.stringify({ locale }),
  })
}
