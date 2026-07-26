import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'

/**
 * Story 14.4 AC-1/AC-5/AC-10: maps an email domain to the org+provider whose SSO strategy the
 * pre-auth domain-lookup route should route into. Org-scoped (RLS via the same
 * `NULLIF(current_setting('app.current_org_id', true), '')::uuid` pattern used by every other
 * org-scoped table — see `external-identities.ts`) even though the *lookup* itself happens
 * pre-auth via `getAdminDb()` (Dev Notes RLS/pre-auth-tension judgment call, mirroring Story
 * 14.3's `external_identities`/`project_invitations` pre-auth exception).
 *
 * Unique index on `domain` alone: Task 1.1 treats "one org per domain" as the safe default
 * (epics.md's singular-mapping framing) — a domain can only ever route to one org/provider.
 *
 * Normalization: `domain` is stored lowercased on write (normalize-on-write, not normalize-on-read)
 * so the lookup route stays a trivial indexed equality query rather than needing a `lower()`
 * comparison on every request (Dev Notes).
 *
 * OPERATIONAL HAZARD (pre-mortem finding, Dev Notes): because there is no admin UI or
 * domain-ownership-verification layer for this table yet, nothing today stops an operator from
 * mistakenly (or a self-service OrgAdmin from maliciously, in a future story) mapping a shared
 * PUBLIC email domain (e.g. `gmail.com`, `outlook.com`) to one org's SSO strategy. Because the
 * unique index is on `domain` alone, a single bad row here would silently force *every* user
 * across *every* org whose email happens to end in that domain into one org's SSO flow, breaking
 * local login for everyone else who shares that domain. This story does not build
 * domain-ownership verification (future admin-UI story's job) — this comment exists so that
 * future story inherits the warning instead of rediscovering it.
 */
export const orgSsoDomains = pgTable(
  'org_sso_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    providerName: text('provider_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // AC-1: "one org per domain" — a domain can only route to a single org/provider.
    domainIdx: uniqueIndex('idx_org_sso_domains_domain').on(t.domain),
  })
)

export type OrgSsoDomain = typeof orgSsoDomains.$inferSelect
export type NewOrgSsoDomain = typeof orgSsoDomains.$inferInsert
