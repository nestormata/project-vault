import { sql } from 'drizzle-orm'
import { check, integer, pgTable, uniqueIndex, uuid, text, timestamp } from 'drizzle-orm/pg-core'

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
    // Story 16.4: org-wide default/fallback theme, layered underneath Story 16.2's per-user
    // `users.selectedThemeName` override. Deliberately nullable with NO `.notNull()` and NO
    // `check(...)` — unlike `defaultLocale` above (a fixed, CHECK-constrained enum), a theme's
    // valid-name set is dynamic and filesystem-defined (VAULT_THEMES_DIR, reloadable via Story
    // 16.1), so there is no fixed enum a CHECK constraint could encode. Validation lives entirely
    // in the route handler against the live `getCompiledThemes()` list (see
    // `apps/api/src/modules/org/organization-settings-routes.ts`), exactly as
    // `PATCH /themes/selection` already validates `users.selectedThemeName`. This is a deliberate
    // omission, not an oversight — do not add a CHECK constraint here.
    defaultThemeName: text('default_theme_name'),
    // Story 26.1 (CM-E14.14 Task 1): idempotency key for POST /api/v1/service/organizations —
    // nullable, set only on organizations created through that service-provisioning endpoint.
    // Mirrors projects.creationRequestId's exact shape (migration 0082): a nullable UUID column
    // backed by a partial unique index, never an application-level check alone.
    serviceProvisioningRequestId: uuid('service_provisioning_request_id'),
    // Story 30.2 (org-mismatch critical-bug fix): CM's own organizationId claim — a
    // WorkOS-directory-shaped identifier (e.g. "org_synthetic_acme"), NEVER PV's own org UUID.
    // Nullable because pre-existing organizations, and any organization provisioned before CM's
    // provisioning client is updated to send this field (deferred — see deferred-work.md), have
    // no value here. A handoff token's `organizationId` claim must be compared against THIS
    // stored value, never against `organizations.id` directly. Mirrors
    // serviceProvisioningRequestId's exact shape: a nullable column backed by a partial unique
    // index, never an application-level check alone.
    centralizemeOrganizationId: text('centralizeme_organization_id'),
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
    // Story 26.1: partial unique index — WHERE ... IS NOT NULL means pre-existing organizations
    // (which never went through this endpoint) never collide with each other.
    serviceProvisioningRequestIdIdx: uniqueIndex(
      'idx_organizations_service_provisioning_request_id'
    )
      .on(t.serviceProvisioningRequestId)
      .where(sql`${t.serviceProvisioningRequestId} IS NOT NULL`),
    // Story 30.2: partial unique index mirroring serviceProvisioningRequestIdIdx above — WHERE
    // ... IS NOT NULL means pre-existing/non-CM-provisioned organizations never collide.
    centralizemeOrganizationIdIdx: uniqueIndex('idx_organizations_centralizeme_organization_id')
      .on(t.centralizemeOrganizationId)
      .where(sql`${t.centralizemeOrganizationId} IS NOT NULL`),
  })
)
