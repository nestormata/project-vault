const REGISTRATION_LOCALE_PENDING_KEY = 'project-vault.registration-locale-pending'
type SupportedLocale = 'en' | 'es'
type PendingRegistrationLocale = { userId: string; locale: SupportedLocale }

let inMemoryPending: PendingRegistrationLocale | null = null

/**
 * Registration cannot persist the selected locale immediately because the registration response
 * intentionally does not establish an authenticated session. Keep a tab-local handoff marker so
 * the first successful login can reuse the authenticated users/me/locale endpoint.
 */
export function markRegistrationLocalePending(userId: string, locale: SupportedLocale) {
  const pending = { userId, locale }
  inMemoryPending = pending
  try {
    globalThis.sessionStorage?.setItem(REGISTRATION_LOCALE_PENDING_KEY, JSON.stringify(pending))
  } catch {
    // Storage can be disabled; the in-memory handoff still survives the SPA redirect to login.
  }
}

function readStoredRegistrationLocale(): PendingRegistrationLocale | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(REGISTRATION_LOCALE_PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingRegistrationLocale>
    if (typeof parsed.userId !== 'string') return null
    if (parsed.locale !== 'en' && parsed.locale !== 'es') return null
    return parsed as PendingRegistrationLocale
  } catch {
    // Storage can be disabled or contain malformed data; ignore it and use the memory fallback.
    return null
  }
}

export function consumeRegistrationLocalePending(userId: string): SupportedLocale | null {
  const pending = readStoredRegistrationLocale() ?? inMemoryPending

  if (pending?.userId !== userId) return null

  inMemoryPending = null
  try {
    globalThis.sessionStorage?.removeItem(REGISTRATION_LOCALE_PENDING_KEY)
  } catch {
    // The handoff has still been consumed in memory; an unavailable store cannot be cleared.
  }
  return pending.locale
}
