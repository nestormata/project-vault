/**
 * Story 15.1: re-exports the single source of truth for supported display locales from
 * @project-vault/shared (see that package's constants/locales.ts for the full rationale). Kept as
 * a re-export here (rather than removed) so `packages/db/src/schema/users.ts`'s existing
 * `import { SUPPORTED_LOCALES } from '../supported-locales.js'`-style call sites and the
 * `@project-vault/db/supported-locales` subpath export stay stable.
 */
export {
  SUPPORTED_LOCALES,
  SUPPORTED_LOCALE_DISPLAY_NAMES,
  isSupportedLocale,
  type SupportedLocale,
} from '@project-vault/shared'
