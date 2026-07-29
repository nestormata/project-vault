import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
    // Story 9.1 D1: instance-wide (not org-scoped) authorization flag. The very first user ever
    // registered on a freshly-initialized instance is bootstrapped as the platform operator (see
    // registerUser() in apps/api/src/modules/auth/service.ts); every subsequent registration
    // defaults to false. A unique partial index (idx_users_one_platform_operator, migration 0038)
    // guarantees at most one row can ever have this set to true.
    isPlatformOperator: boolean('is_platform_operator').notNull().default(false),
    // Story 15.1: user's personal display-language preference. The set of allowed values here
    // MUST stay in sync with SUPPORTED_LOCALES (packages/db/src/supported-locales.ts), which is
    // also the single source of truth consumed by the API's zod validation and the web app's
    // Paraglide JS locale compilation (project.inlang/settings.json). Deliberately reused (not a
    // new column) by Story 15.2, which will seed this same column's initial value from an
    // org-level default at invite-acceptance time.
    locale: text('locale').notNull().default('en'),
    // Story 16.2 AC-8: user's personal active-theme preference. NULL means "base theme" (the
    // default for every user, including every pre-existing row — additive migration, no backfill
    // needed). Deliberately NOT validated against the live compiled-themes set at the schema
    // level (unlike `locale`'s CHECK constraint against a small fixed enum) — the set of valid
    // theme names is dynamic (filesystem-driven, changes on every admin reload), so that
    // validation happens at request time in the API route, not here. An "orphaned" value (a
    // theme that was selected but later removed/failed reload) is an expected, handled state
    // (see Story 16.2 AC-3), not a data-integrity violation.
    selectedThemeName: text('selected_theme_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    localeCheck: check('users_locale_check', sql`${t.locale} IN ('en', 'es')`),
  })
)
