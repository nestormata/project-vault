import { sql } from 'drizzle-orm'
import { check, integer, pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Story 7.2 D8/FR110 — configurable machine-key dormancy threshold (epics.md AC-E7b).
    machineKeyDormancyThresholdDays: integer('machine_key_dormancy_threshold_days')
      .notNull()
      .default(90),
    // Story 8.3 D5/AC-12 — configurable user dormancy threshold, mirrors
    // machineKeyDormancyThresholdDays exactly (same allowed values, same default).
    userDormancyThresholdDays: integer('user_dormancy_threshold_days').notNull().default(90),
    // Story 15.2: org-level default display-language for newly invited/self-signed-up users. The
    // set of allowed values here MUST stay in sync with SUPPORTED_LOCALES
    // (packages/shared/src/constants/locales.ts), the same source of truth already consumed by
    // users.locale's own CHECK constraint (migration 0056, Story 15.1). This column only ever
    // *seeds* a brand-new user's users.locale at registration time (migration 0057) — it never
    // overrides an already-registered user's own locale.
    defaultLocale: text('default_locale').notNull().default('en'),
  },
  (t) => ({
    dormancyThresholdCheck: check(
      'organizations_dormancy_threshold_check',
      sql`${t.machineKeyDormancyThresholdDays} IN (30, 60, 90, 180)`
    ),
    userDormancyThresholdCheck: check(
      'organizations_user_dormancy_threshold_check',
      sql`${t.userDormancyThresholdDays} IN (30, 60, 90, 180)`
    ),
    defaultLocaleCheck: check(
      'organizations_default_locale_check',
      sql`${t.defaultLocale} IN ('en', 'es')`
    ),
  })
)
