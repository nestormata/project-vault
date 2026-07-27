/**
 * Story 15.1: single source of truth for the set of display locales compiled into the build.
 * Importable by both apps/api (zod validation) and apps/web (Settings > Language UI) without
 * either depending on packages/db (which pulls in the Postgres driver — wrong dependency shape
 * for a frontend bundle).
 *
 * This list MUST stay in sync with:
 *  - the `users_locale_check` CHECK constraint (packages/db/src/schema/users.ts, migration 0056)
 *  - `apps/web/project.inlang/settings.json`'s `locales` array (Paraglide JS compile-time locale
 *    set)
 *
 * Adding a locale here alone is NOT sufficient — it requires a coordinated update of the CHECK
 * constraint (a new migration) and `project.inlang/settings.json`, plus a deploy/rebuild. This is
 * intentional: the *set* of supported locales is build-time, while *selecting* among them is
 * runtime (see Story 15.1 Dev Notes, "Build-time locale set vs. runtime selection boundary").
 */
export const SUPPORTED_LOCALES = ['en', 'es'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/** Human-readable display names, in each locale's own language, for the Settings > Language UI. */
export const SUPPORTED_LOCALE_DISPLAY_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  es: 'Español',
}
