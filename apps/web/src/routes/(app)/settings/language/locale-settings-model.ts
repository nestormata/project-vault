import {
  SUPPORTED_LOCALES,
  SUPPORTED_LOCALE_DISPLAY_NAMES,
  isSupportedLocale,
  type SupportedLocale,
} from '@project-vault/shared'

export type LocaleOption = { locale: SupportedLocale; label: string; isCurrent: boolean }

/**
 * Story 15.1 AC 1 — builds the list of locale options for the Settings > Language page, driven
 * entirely by the compiled `SUPPORTED_LOCALES` set (never hardcoded to "at least 2" — if a future
 * deploy compiles a single locale, this still returns a valid one-item list).
 */
export function buildLocaleOptions(currentLocale: string): LocaleOption[] {
  return SUPPORTED_LOCALES.map((locale) => ({
    locale,
    label: SUPPORTED_LOCALE_DISPLAY_NAMES[locale],
    isCurrent: locale === currentLocale,
  }))
}

/** Story 15.1 AC 7 edge — a garbage/stale value (tampered cookie, removed-locale deploy) never
 * gets treated as "current"; falls back to comparing against 'en' so the UI still renders sanely. */
export function resolveDisplayedLocale(value: string): SupportedLocale {
  return isSupportedLocale(value) ? value : 'en'
}

/**
 * Story 15.1 AC 2/9 — decides whether a form action result should trigger the Paraglide runtime
 * locale switch. Only a *successful* action result (server confirmed the PATCH) yields a locale
 * to apply — never optimistically, and never on a `fail()`/error result, so a fail-closed audit
 * rollback on the server can never leave the client "showing" a locale that was never persisted.
 */
export function localeToApplyFromActionResult(
  result: { type: string; data?: unknown } | null | undefined
): SupportedLocale | null {
  if (!result || result.type !== 'success') return null
  const data = result.data as { locale?: unknown } | undefined
  return isSupportedLocale(data?.locale) ? data.locale : null
}
