const REGISTRATION_LOCALE_PENDING_KEY = 'project-vault.registration-locale-pending'

/**
 * Registration cannot persist the selected locale immediately because the registration response
 * intentionally does not establish an authenticated session. Keep a tab-local handoff marker so
 * the first successful login can reuse the authenticated users/me/locale endpoint.
 */
export function markRegistrationLocalePending() {
  try {
    globalThis.sessionStorage?.setItem(REGISTRATION_LOCALE_PENDING_KEY, '1')
  } catch {
    // Storage can be disabled; the account still exists and Settings remains the recovery path.
  }
}

export function consumeRegistrationLocalePending(): boolean {
  try {
    if (globalThis.sessionStorage?.getItem(REGISTRATION_LOCALE_PENDING_KEY) !== '1') return false
    globalThis.sessionStorage.removeItem(REGISTRATION_LOCALE_PENDING_KEY)
    return true
  } catch {
    return false
  }
}
