# Story 9.1: Encrypted Backup & Restore

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Ultimate context engine analysis completed 2026-07-05 — comprehensive developer guide for the first story of Epic 9 (Platform Operations, API & Self-Hosting): scheduled + on-demand encrypted whole-instance backups (pg_dump → gzip → AES-256-GCM via a backup key HKDF-derived from the vault master key), an isolated read-only restore-validation procedure, a destructive full restore, retention pruning, and health-monitoring alerts. This story is the FIRST in Epic 9 — there is no prior Epic 9 story to depend on, but it introduces several brand-new platform-level primitives (a `users.is_platform_operator` authorization flag, an `admin_alerts` table, a `backup_runs` table, a dedicated RLS-bypassing database role for the dump/restore subprocess) that Stories 9.2–9.4 are expected to reuse. Read "Key Design Decisions & Open Questions" before writing any code — it resolves several genuine contradictions and gaps between epics.md's literal wording (written before any Epic 9 story had concrete schema) and the actual, already-shipped Epic 1/8 codebase. Getting D1 wrong means backup/restore endpoints have no working authorization model. Getting D2 wrong means the backup file naming contradicts the "all current data is replaced" restore semantics. Getting D4 wrong means pg_dump silently produces an EMPTY backup (RLS strips every row) or restore fails outright. -->

## Story

As a **platform operator running a self-hosted Project Vault instance**,
I want **the vault to create encrypted backups of all instance data on a schedule (or on demand), verify their integrity without touching live data, and restore from them reliably**,
so that **I can recover from data loss within the documented 2-hour RTO and 24-hour RPO targets, and periodically prove my backups actually work before I need them in an emergency**.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story ships REST endpoints (`POST /api/v1/admin/backup/trigger`, `GET /api/v1/admin/backups`, `POST /api/v1/admin/backups/:filename/restore`, `POST /api/v1/admin/backups/:filename/validate`) plus a scheduled background job; there is no web screen in this story. Operators interact via curl/scripts, matching Epic 9's "REST API first, no privileged UI-only operations" architectural constraint. |
| **Linked UI story** (if API-only) | `TBD` — **no story in the current `epics.md` (Epic 9's five stories, or any other epic) scopes a dedicated backup/restore admin web screen.** Architecture.md's aspirational directory listing reserves a route (`(app)/admin/backup/`) and a module (`modules/backup/`) for a future UI, but no story authors it. This is the same accepted-gap pattern Stories 8.1/8.2/8.4 already flagged for their own surfaces (Product Surface Contract G1) — raise it again at Epic 9 sprint planning/retrospective before Epic 9 can reach `done` (G2). A future UI story should minimally surface: (a) an admin "Backups" page listing recent runs with status/size/verified badges (from `GET /admin/backups`), (b) a "Trigger backup now" button, and (c) a "Validate" action per backup row surfacing the `assetsPresent`/`checksum` result. |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is being deferred with a placeholder; no SvelteKit route is stubbed in this story (a dead route with no linked follow-up story is worse than no route). |
| **Persona journey** | N/A — API-only; there is no "shopper"/end-user persona journey for platform-operator backup/restore in the UX spec. The relevant "persona" is the platform operator running curl/scripts against the documented endpoints; see AC-1 through AC-19 for the exact request/response contracts they depend on. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** Story 9.1 is the first story in Epic 9; several mechanisms epics.md assumes already exist (a "platform operator" concept, an instance-level alert table, per-org backup filenames) do not exist anywhere in the shipped Epic 1–8 codebase. Getting these wrong produces code that looks plausible but is either insecure (D1), silently produces empty backups (D4), or contradicts its own stated behavior (D2).

### D1 — "Platform operator" does not exist as an authorization concept anywhere in the codebase; this story must introduce it

`epics.md` (Story 9.1 and 9.2 alike) repeatedly says endpoints are "platform operator only," and Story 9.2's own AC text says "**Given** the platform operator account exists (bootstrapped at vault init)." But:

- The only roles that exist today are **org-scoped**: `org_memberships.role IN ('owner','admin','member','viewer')` (`packages/db/src/schema/org-memberships.ts`) and the equivalent project-scoped roles.
- Every `FastifyRequest.authContext` (`apps/api/src/@types/fastify.d.ts`) carries a **mandatory, single** `orgId` — there is no instance-wide, cross-org authorization context anywhere.
- Story 1.5 (`vault_state`, master key ceremony — already `done`) does **not** create any user account; it only establishes encryption key custody. Story 1.6 (user registration — already `done`) creates a brand-new **org** and an `owner` for every registration (`RegisterResponseSchema.role: z.enum(['owner'])`, comment: `// v1 first user only` refers to that org, not the instance). Multi-org support (FR6) is Story 9.2's job, not yet built. So "bootstrapped at vault init" in epics.md's 9.2 text does not match anything Story 1.5 actually shipped — this is a genuine cross-epic gap, not something you missed.
- Backup/restore is fundamentally an **instance-wide** operation (it dumps/restores every organization's data, see D2) — it cannot be gated by any existing org-scoped role check (`requireOrgRole`, `withAdminAccess`'s `authCtx.role === 'admin'`) without a real security hole: an OrgAdmin of a low-privilege org in a future multi-org deployment must **not** be able to trigger a whole-instance restore that clobbers every other org's data.

**Resolution (this story must implement, for 9.2/9.3/9.4 to reuse):**

1. Add `is_platform_operator boolean NOT NULL DEFAULT false` to `packages/db/src/schema/users.ts` (migration `NNNN_platform_operator_bootstrap.sql` — see AC-1 for exact DDL). This is a **user-level** flag, orthogonal to and independent of any org-scoped role — a platform operator may or may not also hold an org role.
2. **Bootstrap rule:** the very first user ever registered on a freshly-initialized instance is automatically flagged `is_platform_operator = true`, set in the *same transaction* as the registration INSERT in `apps/api/src/modules/auth/service.ts` (Story 1.6's registration service). Detection: `SELECT COUNT(*) FROM users` (queried via `withAdminAccess`-style unscoped access, since this check must run before any org context exists) `= 0` at the moment the new user row is about to be inserted. This mirrors `vault_state`'s single-row bootstrap pattern (`INSERT ... ON CONFLICT DO NOTHING` guards against a race between two concurrent first-registrations — see AC-1's concurrency example) and is consistent with "no self-service org signup" (AC-E9c) since only the very first registration gets this privilege automatically; every subsequent registration creates an ordinary non-operator user.
3. Add `requirePlatformOperator()` to `apps/api/src/plugins/require-org-role.ts` (or a sibling file `require-platform-operator.ts` — colocate next to `requireOrgRole` since it is the same shape of preHandler), checking `authContext.isPlatformOperator === true`. Add `isPlatformOperator: boolean` to `AuthContext` in `apps/api/src/@types/fastify.d.ts`, populated at JWT-verification time from `users.is_platform_operator` (same place `orgRole` is currently populated — find that code path in the JWT verification middleware from Story 1.11/1.7 and add the extra column read).
4. Backup/restore routes use `SecureRoute` with `requireOrgScope: false` (an explicit, named opt-out — architecture.md's "concerns opted out explicitly with named flags" principle) plus the new `requirePlatformOperator()` preHandler. `authContext.orgId` is still present (from whichever org the operator is currently a member of, if any) but is **never** used to scope backup data.
5. Existing-deployment upgrade path (AC-19 covers this): instances that already have users before this migration runs get `is_platform_operator = false` for all of them (the column default). The migration's own comment must instruct operators to manually flag one user via direct SQL (`UPDATE users SET is_platform_operator = true WHERE email = '...'`) as a one-time post-upgrade step, documented in the runbook (Story 9.5 — flag this cross-reference there when it is written).

### D2 — Backup unit-of-operation contradiction: "per-org filename" vs. "pg_dump of all tables" vs. "all current data is replaced"

`epics.md:2015-2023` (Story 9.1's literal text) says three things that cannot all be true simultaneously:
- "the job performs a PostgreSQL `pg_dump` of **all tables**" → whole-database dump.
- "each backup file is named `backup_<timestamp>_<orgId>.vault`" → implies one file **per organization**.
- "restore... **all current data is replaced**" → whole-database restore.

A per-org filename only makes sense if the dump itself is filtered to one org's rows — but "pg_dump of all tables" and "all current data is replaced" are unambiguously whole-instance semantics. This is a leftover artifact from an earlier draft of the epics document (most FR88-92 language predates FR6/multi-org being assigned to Epic 9 at all — see the epics.md Epic 9 preamble: "Multi-org (FR6) is an operator deployment feature required for GA self-hosting but not for beta validation," i.e., added later).

**Resolution:** Backup and restore operate at the **whole-instance/whole-database level** — one backup captures every organization's data in a single encrypted file; restore replaces the entire database's contents. The `_<orgId>` filename component is replaced with `_<instanceId>` — a random UUID generated once (on first backup) and cached in the new `backup_runs` table (see D3) purely to disambiguate backups from multiple separate self-hosted instances if an operator points several deployments at the same shared S3 bucket. Filename format: `backup_<ISO8601-compact-timestamp>_<instanceId>.vault` with sidecar `backup_<ISO8601-compact-timestamp>_<instanceId>.meta.json`. Document this explicitly as a deliberate deviation from epics.md's literal text in code comments at the point of filename generation, e.g. `// Deviation from epics.md:2017 (orgId → instanceId): backup is whole-instance, not per-org (D2, story 9-1)`.

### D3 — Two new platform-level (non-org-scoped, RLS-exempt) tables this story introduces

Neither table below is org-scoped; both follow the `vault_state`/`api_instances` precedent (`EXCLUDED_TABLES` in `packages/db/src/check-rls-coverage.ts`), not the `orgScoped()` helper.

**`backup_runs`** — source of truth for backup history, health monitoring, and the `GET /admin/backups` listing (avoids re-scanning the storage destination on every list request):

```typescript
// packages/db/src/schema/backup-runs.ts
import { pgTable, uuid, text, integer, bigint, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    filename: text('filename').notNull().unique(),
    status: text('status').notNull().default('running'), // running | succeeded | failed
    triggeredBy: text('triggered_by').notNull(), // 'schedule' | 'manual'
    triggeredByUserId: uuid('triggered_by_user_id'), // NULL for schedule-triggered runs
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    keyVersion: integer('key_version'),
    checksumSha256: text('checksum_sha256'),
    verified: text('verified').notNull().default('unverified'), // unverified | valid | invalid
    errorMessage: text('error_message'),
  },
  (t) => [
    check('backup_runs_status_check', sql`${t.status} IN ('running','succeeded','failed')`),
    check(
      'backup_runs_triggered_by_check',
      sql`${t.triggeredBy} IN ('schedule','manual')`
    ),
    check(
      'backup_runs_verified_check',
      sql`${t.verified} IN ('unverified','valid','invalid')`
    ),
  ]
)
export type BackupRun = typeof backupRuns.$inferSelect
export type NewBackupRun = typeof backupRuns.$inferInsert
```

**`admin_alerts`** — a new platform-level alert table (distinct from org-scoped `monitoring_alerts`/`security_alerts`), used here for `backup.missed`/`backup.failure`, and explicitly reserved for Story 9.2's FR109 key-custody-risk alert to reuse (do not let 9.2 invent a second, competing platform-alert table):

```typescript
// packages/db/src/schema/admin-alerts.ts
import { pgTable, uuid, text, jsonb, timestamp, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const adminAlerts = pgTable(
  'admin_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    alertType: text('alert_type').notNull(), // 'backup.missed' | 'backup.failure' | (9.2 adds 'key_custody_risk')
    severity: text('severity').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('active'), // active | acknowledged | dismissed
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (t) => [
    check('admin_alerts_severity_check', sql`${t.severity} IN ('info','warning','critical')`),
    check(
      'admin_alerts_status_check',
      sql`${t.status} IN ('active','acknowledged','dismissed')`
    ),
  ]
)
export type AdminAlert = typeof adminAlerts.$inferSelect
```

Both tables must be added to `packages/db/src/check-rls-coverage.ts`'s `EXCLUDED_TABLES` set in the **same migration** that creates them (mirrors the requirement already documented for `vault_state` in Story 1.5's Dev Notes) — otherwise `check-rls-coverage.ts` fails CI with a false-positive RLS gap.

### D4 — CRITICAL: the API's own `DATABASE_URL` (the `vault_app` role) cannot be used for `pg_dump`/restore — it is RLS-restricted by design

`apps/api/src/config/env.ts`'s `DATABASE_URL` schema has a `.refine()` that explicitly **rejects** the `postgres` superuser connection string, with the comment: *"RLS enforcement requires a non-superuser role."* The `vault_app` role that the API actually connects as has full `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants (`0001_rls_and_triggers.sql`) but is still subject to every table's RLS policy — a session with no `app.current_org_id` set (or with it set to one org) does **not** see other orgs' rows. `docker-compose.yml` already establishes the precedent that schema-level operations need superuser: the one-shot `migrate` service connects as `${POSTGRES_USER}` (the actual `postgres` superuser, which `BYPASSRLS` implicitly via superuser status), while the long-running `api` service deliberately never gets that credential.

**If `pg_dump` is run using the API's existing `DATABASE_URL`, the resulting backup silently contains zero rows from every RLS-protected table** (or, at best, rows from whichever single org happened to be set in that connection's session state at dump time) — a catastrophic, silent data-loss bug that would only be discovered during a real restore, i.e., the worst possible time.

**Resolution:** Introduce a **new, separate** env var `BACKUP_DATABASE_URL`, required only when backup is configured (either `BACKUP_STORAGE_PATH` or `BACKUP_S3_BUCKET` set), pointed at a connection that bypasses RLS. For v1, reuse the existing `postgres` superuser credential already present in every deployment (`docker-compose.yml`'s `POSTGRES_USER`/`POSTGRES_PASSWORD`) rather than inventing a new database role — this mirrors the `migrate` service's existing, already-accepted precedent (superuser for whole-database/schema-level operations, `vault_app` for row-level application operations) instead of adding a third distinct trust tier. **This must be explicitly documented as a threat-model trade-off** (architecture.md already has this pattern for other risk acceptances, e.g. plugin network egress, key co-location): the long-running `api` container now holds superuser DB credentials for the lifetime of any backup/restore subprocess. Mitigations: (a) `BACKUP_DATABASE_URL` is read from the environment only at the moment `pg_dump`/`pg_restore` is spawned, never held in a long-lived in-memory variable; (b) the subprocess's environment is scoped to only that child process, never logged (add `BACKUP_DATABASE_URL` and any URL containing `postgresql://` with embedded credentials to the log redaction paths in `apps/api/src/lib/logger.ts`, alongside the existing `password`/`passphrase` redaction list); (c) document in the runbook (Story 9.5) that operators may optionally create a dedicated `vault_backup` role with `BYPASSRLS` (no superuser privileges beyond that) and point `BACKUP_DATABASE_URL` at it instead — note in code comments that this is supported (any role with `BYPASSRLS` works) without being the enforced default.

`pg_dump`/`pg_restore` binaries must exist in the `apps/api` runtime container: add `RUN apk add --no-cache postgresql16-client` to the **runner** stage of `apps/api/Dockerfile` (matching the pinned `postgres:16-alpine` server version in `docker-compose.yml` — pg_dump's major version must match or exceed the server's).

### D5 — Backup key derivation requires a change to Story 1.5's `key-service.ts` (IKM is zeroed after unseal; a new key cannot be derived later)

`packages/crypto/src/kdf.ts` already reserves `HKDF_INFO.BACKUP = 'project-vault-backup-v1'` with the comment `// Story 9.1 uses this` — this story is expected to consume it. However, `apps/api/src/modules/vault/key-service.ts`'s `unsealVault()`/`initVault()` derive `primaryKey` and `auditKey` from the raw IKM and then **immediately zero the IKM buffer** (`ikm.fill(0)`) — there is no raw key material left in memory to derive a third key from later. `getAuditKey()`/`getPrimaryKey()` are the only key-retrieval exports.

**Resolution:** Modify `key-service.ts`'s `initVault()` and `unsealVault()` to also compute `const backupKey = deriveKey(ikm, HKDF_INFO.BACKUP)` at the same point `auditKey` is derived (before `ikm.fill(0)`), store it in a new private `_backupKey` module variable (mirroring `_auditKey`'s exact handling — zeroed and reassigned on unseal, zeroed by `zeroKeys()` on shutdown), and export `getBackupKey(): Buffer` (mirrors `getAuditKey()`'s "throws if vault is sealed" contract exactly). This is a small, additive change to an already-`done` story's file — call this out prominently in the PR/commit description since it touches Story 1.5's code, not just new Story 9.1 files.

### D6 — Audit trail for backup/restore actions: use structured operational logging, not `audit_log_entries` or `platform_audit_events` (the latter doesn't exist yet)

Story 9.4 (`Platform Operator Audit Log`, still `backlog`) is explicitly designed to capture "platform operator actions... instance-level configuration changes... **backup/restore**" in a new `platform_audit_events` table — but that table does not exist yet; Story 9.4 has not been written. `audit_log_entries` (Story 8.1) is org-scoped and requires an `orgId` — backup/restore actions have no single owning org (D2), so writing to `audit_log_entries` would require picking an arbitrary org, which is worse than not logging there at all, and would pollute that org's audit trail with an event it has no ownership of.

**Resolution (interim, expected to be retrofitted by Story 9.4):** log backup/restore actions via the existing structured **operational** logging system (`apps/api/src/lib/job-logging.ts` / `operationalLog()`, `packages/shared/src/constants/operational-event-types.ts` — Story 1.10's mechanism). Add new `OperationalEvent` constants: `BACKUP_TRIGGERED`, `BACKUP_COMPLETED`, `BACKUP_FAILED`, `BACKUP_MISSED`, `BACKUP_RESTORE_INITIATED`, `BACKUP_RESTORE_COMPLETED`, `BACKUP_RESTORE_FAILED`, `BACKUP_VALIDATE_INITIATED`, `BACKUP_VALIDATE_COMPLETED`, `BACKUP_RETENTION_PRUNED`. This is explicitly **not** tamper-evident and **not** compliance-grade for this story — document this limitation plainly in Dev Notes and cross-reference it from Story 9.4 (when written) as the story that must add `platform_audit_events` coverage for these same action types retroactively (9.4's own epics.md AC text already lists "backup/restore" as one of the platform-audit-covered action types, confirming this sequencing is intentional, not an oversight).

### D7 — Alert delivery for `backup.missed`/`backup.failure`: no instance-level routing config exists yet; loop across every org

`resolveRoutingRecipients(orgId, alertType, tx)` (`apps/api/src/modules/notifications/routing.ts`) is **org-scoped** — "FR100-configured recipients" (epics.md's phrase for backup alerts) has no defined meaning at the instance level today, since per-alert-type routing (FR100) is configured per-org. **Resolution:** for backup health alerts (which by definition affect every org on the instance, since backup is whole-instance), resolve recipients by iterating every row in `organizations` and calling `resolveRoutingRecipients(org.id, 'backup.missed'|'backup.failure', tx)` for each, then deliver to the union of resolved recipients (de-duplicated by user id) via the existing `notification:email`/`notification:slack`/inbox delivery pipeline. In the common single-org self-hosted deployment (the vast majority of v1 installs — multi-org is Story 9.2, not yet built) this loop runs exactly once, so there is no behavior change for the typical case; it is written to generalize correctly once 9.2 ships. Also add `'backup.missed'` to `NOTIFICATION_ALERT_TYPES` in `packages/shared/src/constants/notification-types.ts` — `'backup.failure'` is already present in that array (pre-reserved, same pattern as `HKDF_INFO.BACKUP`), but `'backup.missed'` is not; add it as a one-line, purely-additive change.

### D8 — FR92's "post-Epic-8 schema freeze" precondition is not yet satisfied; document the limitation, do not block on it

The epics.md Epic 9 preamble states: *"restore validation can only be verified as fully correct after all table schemas from Epics 1-8 are stable. A post-Epic-8 schema freeze is a precondition for signing off FR92."* As of this story's creation, Epic 8 (`8-1`, `8-2`, `8-3`, `8-4`) are all `ready-for-dev`, not `done` — the schema is not frozen. **This story proceeds anyway** (per `sprint-status.yaml`'s own stated policy that stories can be worked in parallel, and because Epic 9 being entirely `backlog` while Epic 8 is `in-progress` blocks all forward progress otherwise). The restore-validation endpoint's `assetsPresent` check (AC-10) enumerates the tables that exist **at the time this story is implemented** — if Epic 8 stories later add new tables (e.g., Story 8.4's `data_erasure_requests`), a follow-up story or the Epic 9 retrospective must extend `assetsPresent`'s table list. Document this explicitly as a known, accepted limitation in code comments at the `assetsPresent` construction site, not silently.

---

## Acceptance Criteria

### AC-1 — Platform operator bootstrap and authorization (D1)

**Given** a freshly initialized vault with zero rows in `users`,
**When** `POST /api/v1/auth/register` is called for the first time,
**Then** the created user row has `is_platform_operator = true`, set within the same transaction as the INSERT.

**Example (happy path):**
```
POST /api/v1/auth/register
{ "email": "alice@example.com", "password": "correct-horse-battery-staple9", "orgName": "Acme Corp" }
→ 201 { "userId": "...", "orgId": "...", "email": "alice@example.com", "orgName": "Acme Corp", "role": "owner" }
```
```sql
SELECT is_platform_operator FROM users WHERE email = 'alice@example.com';
-- true
```

**And** every subsequent registration (second user onward, in the same or a different org) has `is_platform_operator = false`.

**Example (second user, different org):**
```
POST /api/v1/auth/register
{ "email": "bob@othercompany.com", "password": "another-strong-pw1", "orgName": "Other Co" }
→ 201 { ... }
```
```sql
SELECT is_platform_operator FROM users WHERE email = 'bob@othercompany.com';
-- false
```

**And** a race between two concurrent first-registrations results in exactly one user with `is_platform_operator = true` — the loser of the race still succeeds as an ordinary registration (never fails outright), consistent with `vault_state`'s `INSERT ... ON CONFLICT DO NOTHING` pattern for TOCTOU-safe single-winner bootstrap.

**Example (concurrency edge case):** two `POST /api/v1/auth/register` requests fire within the same millisecond on a brand-new instance. Both transactions read `COUNT(*) FROM users` = 0 before either commits. The registration service must serialize this check (e.g., `SELECT ... FOR UPDATE` on a sentinel row, or rely on the transaction isolation level plus a unique partial index `CREATE UNIQUE INDEX ... ON users ((true)) WHERE is_platform_operator = true` that causes the second writer's `is_platform_operator = true` attempt to fail with a unique-violation, caught and retried as `is_platform_operator = false`). Integration test: fire two registrations via `Promise.all`, assert `SELECT COUNT(*) FROM users WHERE is_platform_operator = true` = 1 afterward, and both registrations return `201`.

**And** all four backup/restore endpoints (`POST /admin/backup/trigger`, `GET /admin/backups`, `POST /admin/backups/:filename/restore`, `POST /admin/backups/:filename/validate`) require `authContext.isPlatformOperator === true`; a non-operator authenticated user (including an org Owner/Admin who is not the platform operator) receives `403`.

**Example (authz edge case):** Bob (org Owner of "Other Co", `is_platform_operator = false`) calls `POST /api/v1/admin/backup/trigger` with a valid JWT.
```
POST /api/v1/admin/backup/trigger
Authorization: Bearer <bob's valid access token>
→ 403 { "code": "platform_operator_required", "message": "This endpoint requires platform operator privileges." }
```

**And** an unauthenticated request to any backup/restore endpoint receives `401`.

**Example:** `POST /api/v1/admin/backup/trigger` with no `Authorization` header → `401 { "code": "access_token_missing", ... }`.

---

### AC-2 — `backup_runs` and `admin_alerts` schema and migration (D3)

**Given** this story's migration runs,
**When** `pnpm --filter @project-vault/db db:migrate` executes,
**Then** `backup_runs` and `admin_alerts` tables exist exactly as specified in D3, and both are added to `EXCLUDED_TABLES` in `packages/db/src/check-rls-coverage.ts` in the same migration.

**Example (positive):** after migration, `pnpm --filter @project-vault/db check-rls` (or the CI task `db#check-rls`) passes with zero gaps reported for `backup_runs`/`admin_alerts`.

**Example (negative — regression guard):** a unit/integration test asserts `check-rls-coverage.ts`'s gap-scan throws `RlsCoverageGapError` if `backup_runs` is **removed** from `EXCLUDED_TABLES` while the table still lacks an RLS policy — proving the exclusion is load-bearing, not a no-op (mirrors the existing test pattern for `vault_state`'s exclusion).

---

### AC-3 — `users.is_platform_operator` migration and backward compatibility (D1, AC-19 cross-reference)

**Given** an existing deployment upgrading from a pre-9.1 version with users already in the `users` table,
**When** the migration adds `is_platform_operator boolean NOT NULL DEFAULT false`,
**Then** every existing user row gets `is_platform_operator = false` (the column default) — no existing user is retroactively granted platform-operator access by the migration itself.

**Example (positive — safe default):** a 3-user instance upgrades; `SELECT COUNT(*) FROM users WHERE is_platform_operator = true` = 0 immediately after migration. No backup/restore endpoint is callable by anyone until an operator manually runs the documented one-time SQL (`UPDATE users SET is_platform_operator = true WHERE email = '<chosen-operator-email>'`).

**Example (negative — must NOT silently auto-promote):** the migration must **not** contain any `UPDATE users SET is_platform_operator = true WHERE ...` heuristic (e.g., "oldest user," "first-created org's owner") — auto-promoting an arbitrary existing user to instance-wide backup/restore authority without explicit operator action is a privilege-escalation bug, not a convenience. A code-review checklist item / test asserts the migration file contains no `UPDATE` statement against `users`.

---

### AC-4 — Backup key derivation available after unseal (D5)

**Given** the vault is initialized (passphrase, envelope, or file custody mode) and unsealed,
**When** `getBackupKey()` is called from `apps/api/src/modules/vault/key-service.ts`,
**Then** it returns a 32-byte `Buffer` derived via `deriveKey(ikm, HKDF_INFO.BACKUP)` at the same unseal/init moment `auditKey` was derived.

**Example (positive):**
```typescript
await initVault({ kmsType: 'passphrase', passphrase: 'correct-horse-battery-staple' })
const backupKey = getBackupKey()
// backupKey.length === 32
```

**And** `getBackupKey()` throws if the vault is sealed (matches `getAuditKey()`'s/`getPrimaryKey()`'s existing contract exactly — same error-message style).

**Example (negative):**
```typescript
// vault never initialized, or sealed after a restart
getBackupKey()
// throws Error('getBackupKey: vault is sealed — backup key unavailable')
```

**And** `zeroKeys()` (called on graceful shutdown) also zeros the in-memory backup key buffer — a unit test asserts the buffer's bytes are all `0x00` after `zeroKeys()` runs.

---

### AC-5 — Scheduled backup job: pg_dump → gzip → AES-256-GCM → store to filesystem (happy path)

**Given** the vault is initialized and unsealed, `BACKUP_STORAGE_PATH=/var/backups/vault` is configured, and the `backup:snapshot` pg-boss cron job fires (default schedule `0 3 * * *` UTC, configurable via `BACKUP_SCHEDULE`),
**When** the job runs,
**Then** it: (1) creates a `backup_runs` row with `status: 'running'`, `triggeredBy: 'schedule'`; (2) spawns `pg_dump` against `BACKUP_DATABASE_URL` (D4) in plain-SQL or custom format, piping stdout through gzip; (3) hands the gzipped bytes to a `worker_threads` Worker (`packages/crypto/dist/workers/backup-encrypt.worker.ts`, keeping the CPU-bound encryption off the main event loop per architecture.md) which encrypts with AES-256-GCM using `getBackupKey()`; (4) writes `backup_<timestamp>_<instanceId>.vault` and its `.meta.json` sidecar to `BACKUP_STORAGE_PATH`; (5) updates the `backup_runs` row to `status: 'succeeded'`, `sizeBytes`, `keyVersion`, `checksumSha256` (SHA-256 of the final encrypted file).

**Example (positive):**
```json
// backup_20260705T030000Z_8f2a1c3e-....meta.json
{
  "vaultVersion": "1.4.0",
  "timestamp": "2026-07-05T03:00:00.000Z",
  "keyVersion": 1,
  "tables": ["organizations", "users", "org_memberships", "projects", "secrets", "..."],
  "rowCounts": { "organizations": 3, "users": 12, "secrets": 847, "audit_log_entries": 15302 },
  "checksumSha256": "b7e2...f01a"
}
```
Structured operational log emitted: `{ event: 'backup.completed', filename: '...', sizeBytes: 4831201, durationMs: 8213 }`.

**Example (negative — pg_dump failure):** the database becomes unreachable mid-dump (connection dropped). The job catches the subprocess non-zero exit, sets `backup_runs.status = 'failed'`, `errorMessage`, emits `OperationalEvent.BACKUP_FAILED` at `warn` level, and enqueues the `backup.failure` alert path (AC-11). No partial `.vault` file is left on disk (write to a `.tmp` path and `rename()` only on full success — atomic on the same filesystem).

**Example (negative — vault sealed at job-fire time):** the scheduled job fires (pg-boss cron) but the vault has sealed since the last unseal (e.g., process restarted and hasn't been manually unsealed yet). Per `main.ts`'s existing pattern, pg-boss workers are only started `onVaultUnsealed` — so this job literally cannot fire while sealed (no registration exists yet); document this as the enforcing mechanism rather than adding a redundant runtime guard, but add a defensive `getBackupKey()` try/catch anyway (belt-and-suspenders) that logs `OperationalEvent.BACKUP_FAILED` with `reason: 'vault_sealed'` if it is ever invoked in that state (e.g., a hot-reload race in dev).

---

### AC-6 — S3-compatible storage destination (happy + failure)

**Given** `BACKUP_S3_BUCKET` is configured instead of `BACKUP_STORAGE_PATH` (mutually exclusive — see AC-15),
**When** a backup completes encryption,
**Then** the encrypted `.vault` file and `.meta.json` sidecar are uploaded to the configured S3-compatible bucket (via `@aws-sdk/client-s3`, added as a new dependency to `apps/api/package.json` — not previously present in the dependency tree) using `PutObjectCommand`, with the same filename convention.

**Example (positive):**
```
BACKUP_S3_BUCKET=vault-backups-prod
BACKUP_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com  # or MinIO/compatible endpoint
BACKUP_S3_REGION=us-east-1
```
Upload succeeds; `backup_runs.status = 'succeeded'`.

**Example (negative — auth/network failure):** S3 credentials are invalid or the endpoint is unreachable. The upload throws; caught the same way as a `pg_dump` failure (AC-5's negative case) — `backup_runs.status = 'failed'`, `errorMessage: 'S3 upload failed: <sanitized reason>'` (never log the AWS secret key), `backup.failure` alert enqueued. The local encrypted temp file is retained (not deleted) on upload failure so a subsequent manual retry or operator intervention doesn't require re-running the entire dump+encrypt pipeline — deleted only after 24h by the retention/cleanup job if still orphaned.

---

### AC-7 — Manual backup trigger endpoint

**Given** a platform operator calls `POST /api/v1/admin/backup/trigger`,
**When** no backup is currently `running`,
**Then** the API enqueues an immediate `backup:snapshot` pg-boss job (`triggeredBy: 'manual'`, `triggeredByUserId` set) and returns `{ jobId }` without waiting for completion (backup itself can take longer than an HTTP request timeout for large instances).

**Example (positive):**
```
POST /api/v1/admin/backup/trigger
Authorization: Bearer <platform operator token>
→ 202 { "jobId": "3f9c2b10-...", "status": "running" }
```

**And** if a backup is already `running` (either scheduled or a prior manual trigger), the endpoint rejects the new trigger rather than running two concurrent dumps against the same destination.

**Example (negative — concurrency conflict):**
```
POST /api/v1/admin/backup/trigger  // fired while a backup is already running
→ 409 { "code": "backup_already_running", "message": "A backup is already in progress (started at 2026-07-05T03:00:00Z).", "jobId": "..." }
```
Implementation: a PostgreSQL advisory lock on a fixed key (e.g., `pg_try_advisory_lock(hashtext('backup:snapshot'))`) acquired at job start and released on completion/failure — same mechanism family as the rotation state machine's advisory locks (Story 5.1), applied here at the single-instance-wide granularity rather than per-credential.

---

### AC-8 — List backups

**Given** one or more completed backup runs exist,
**When** a platform operator calls `GET /api/v1/admin/backups`,
**Then** the API returns the `backup_runs` rows (most recent first) formatted as `[{ filename, timestamp, sizeBytes, keyVersion, verified }]`.

**Example (positive):**
```
GET /api/v1/admin/backups
→ 200 { "items": [
  { "filename": "backup_20260705T030000Z_8f2a1c3e.vault", "timestamp": "2026-07-05T03:00:00Z", "sizeBytes": 4831201, "keyVersion": 1, "verified": "valid" },
  { "filename": "backup_20260704T030000Z_8f2a1c3e.vault", "timestamp": "2026-07-04T03:00:00Z", "sizeBytes": 4790112, "keyVersion": 1, "verified": "unverified" }
] }
```

**Example (negative/edge — no backups yet):**
```
GET /api/v1/admin/backups
→ 200 { "items": [] }
```
(Not a 404 — an empty, honest, well-formed collection response, consistent with the rest of the API's collection endpoints.)

**And** a `failed` run (from `backup_runs.status = 'failed'`) is included in the listing with `sizeBytes: null`, so operators can see recent failures without a separate endpoint.

---

### AC-9 — Restore from a backup (destructive)

**Given** a platform operator calls `POST /api/v1/admin/backups/:filename/restore` with `{ "confirmRestore": true, "reason": "..." }` for a backup that exists at the storage destination,
**When** the request is processed,
**Then** the API decrypts the file with `getBackupKey()`, verifies the SHA-256 checksum from the sidecar matches, runs `pg_restore`/`psql` against `BACKUP_DATABASE_URL` to replace **all** current data, and afterward seals the vault (`zeroKeys()` + `_status = 'sealed'`) and requires manual unseal — matching Story 1.5's existing seal semantics exactly.

**Example (positive):**
```
POST /api/v1/admin/backups/backup_20260704T030000Z_8f2a1c3e.vault/restore
{ "confirmRestore": true, "reason": "Recovering from accidental bulk-delete incident INC-4821" }
→ 200 { "restored": true, "filename": "backup_20260704T030000Z_8f2a1c3e.vault", "sealedAfterRestore": true }
```
`GET /ready` immediately after → `503 { "status": "sealed", "message": "Manual unseal required." }` (same shape as Story 1.5's post-crash-restart behavior).

**Example (negative — missing confirmation):**
```
POST /api/v1/admin/backups/backup_....vault/restore
{ "reason": "oops" }
→ 400 { "code": "confirmation_required", "message": "Restore is destructive. confirmRestore: true and a reason are both required." }
```

**Example (negative — checksum mismatch, corrupted/tampered file):**
```
POST /api/v1/admin/backups/backup_....vault/restore
{ "confirmRestore": true, "reason": "test" }
→ 422 { "code": "backup_checksum_mismatch", "message": "Stored checksum does not match the backup file — refusing to restore a potentially corrupted or tampered backup." }
```
No data is touched — the checksum verification runs **before** `pg_restore` is invoked, not after.

**Example (negative — unknown filename):**
```
POST /api/v1/admin/backups/nonexistent.vault/restore
{ "confirmRestore": true, "reason": "test" }
→ 404 { "code": "backup_not_found", "message": "No backup found with that filename." }
```

**Example (negative — wrong key version, e.g. restoring a backup encrypted under a rotated-away master key):** decryption fails (GCM auth tag mismatch) → `401 { "code": "backup_decrypt_failed", "message": "Backup could not be decrypted with the current master key." }` — same "no oracle" discipline as Story 1.5's unseal error (do not distinguish "wrong key" from "corrupted ciphertext" in the response).

---

### AC-10 — Restore validation (isolated, read-only, non-destructive)

**Given** a platform operator calls `POST /api/v1/admin/backups/:filename/validate`,
**When** the request is processed,
**Then** the API decrypts the backup **in an isolated context that never touches the live database** (e.g., restores into a throwaway temporary database created for this check only, or performs structural inspection of the decompressed SQL/dump content without executing it against any live connection — either approach is acceptable as long as zero writes reach the tables the running instance actually serves), and returns which vault assets are present and verifiable.

**Example (positive):**
```
POST /api/v1/admin/backups/backup_20260705T030000Z_8f2a1c3e.vault/validate
→ 200 {
  "valid": true,
  "assetsPresent": { "credentials": true, "projects": true, "users": true, "auditEvents": true },
  "checksum": "match"
}
```
`backup_runs.verified` is updated to `'valid'` for this filename as a side effect (feeds AC-8's listing).

**Example (negative — corrupted file):**
```
POST /api/v1/admin/backups/backup_corrupted.vault/validate
→ 200 { "valid": false, "assetsPresent": { "credentials": false, "projects": false, "users": false, "auditEvents": false }, "checksum": "mismatch" }
```
(Note: `200`, not an error status — validation *reporting* that a backup is invalid is a successful validation run, not an endpoint failure; this mirrors how a health check reporting "unhealthy" is still a successful health-check invocation.)

**And** per D8, `assetsPresent`'s table list reflects the schema as of this story's implementation (`credentials`/`secrets`, `projects`, `users`, `audit_log_entries` at minimum) — a code comment at the construction site notes this must be extended if Epic 8 stories add new compliance-relevant tables before Epic 9 closes.

**And** no live table is modified during validation — an integration test asserts `SELECT COUNT(*) FROM secrets` (and other representative tables) is identical before and after a `validate` call, even when the backup being validated is stale/different from current live data.

---

### AC-11 — Backup retention pruning

**Given** `BACKUP_RETENTION_COUNT=7` (default) is configured,
**When** the retention cleanup step runs (as part of the scheduled `backup:snapshot` job, after a successful new backup, or as its own periodic job),
**Then** only the 7 most recent **succeeded** backups are kept at the storage destination; older ones are deleted (file + sidecar + corresponding `backup_runs` row, or the row is retained with a `deleted_at` marker for history — pick one and document it; recommendation: keep the `backup_runs` row for audit/history purposes, only delete the physical file, so `GET /admin/backups` can still show "this backup existed but was pruned").

**Example (positive):** 9 succeeded backups exist; after pruning, the 7 newest remain on disk/S3, the 2 oldest are deleted.

**Example (edge — minimum retention enforced):** an operator attempts to configure `BACKUP_RETENTION_COUNT=0`. Env validation (AC-15) rejects this at startup: `FATAL: BACKUP_RETENTION_COUNT must be >= 1`. Minimum retention is always 1 — a configuration that could prune every backup (leaving zero recovery points) must be structurally impossible, not just discouraged.

**Example (edge — concurrent prune vs. in-flight backup):** the retention job must never delete a backup whose `backup_runs.status = 'running'` — only `status = 'succeeded'` rows are eligible for pruning, so a slow in-progress backup can never be pruned mid-write by an overlapping retention run.

---

### AC-12 — Backup health monitoring: missed backup alert (D7)

**Given** `BACKUP_MAX_AGE_HOURS=25` (default) and the last **succeeded** backup completed more than 25 hours ago (or no backup has ever succeeded since instance init),
**When** a periodic health-check job (hourly cron, `backup:health-check`) runs,
**Then** it creates an `admin_alerts` row (`alertType: 'backup.missed'`, `severity: 'critical'`) if one is not already `active` for this condition, and delivers to every org's `backup.missed`-routed recipients (D7).

**Example (positive — healthy, no alert):** last succeeded backup completed 4 hours ago. Health check runs, finds age < 25h, does nothing (no new `admin_alerts` row, no notification).

**Example (negative/alerting case — missed):** last succeeded backup completed 26 hours ago (a scheduled run silently failed to even fire, or repeatedly failed).
```json
// admin_alerts row created
{ "alertType": "backup.missed", "severity": "critical", "payload": { "lastSuccessAt": "2026-07-04T02:00:00Z", "hoursSinceLastSuccess": 26 }, "status": "active" }
```
Email/Slack/inbox notification delivered to resolved recipients per D7's cross-org loop.

**And** the alert is **not** re-created every hour while the condition persists (idempotent — check for an existing `active` `admin_alerts` row of this type before inserting a new one, same discipline as `monitoring_alerts`' `episodeKey` de-duplication pattern from Story 6.2).

---

### AC-13 — Backup health monitoring: job-failure alert

**Given** a scheduled or manual backup run completes with `backup_runs.status = 'failed'` (AC-5's negative case, AC-6's negative case),
**When** the failure is recorded,
**Then** a `backup.failure` alert (`admin_alerts`, `severity: 'critical'`) is created immediately (not waiting for the next hourly health check) and delivered per D7.

**Example (positive — alert fires on first failure):**
```json
{ "alertType": "backup.failure", "severity": "critical", "payload": { "filename": "backup_20260705T030000Z_....vault", "errorMessage": "pg_dump: connection to server ... failed" }, "status": "active" }
```

**Example (edge — repeated failures don't spam):** three consecutive scheduled runs fail on three consecutive nights. Each failure creates its own `admin_alerts` row (unlike the "missed" alert, each failure is a distinct event worth its own record for the audit trail), but notification delivery for the 2nd/3rd failure within the same 24h window is subject to the existing notification-preferences digest/dedup logic (Story 3.2) rather than this story reinventing throttling — reuse, don't duplicate.

---

### AC-14 — Env var configuration and validation (D4, AC-15)

**Given** the API starts up,
**When** `apps/api/src/config/env.ts` parses the environment,
**Then** it validates: `BACKUP_SCHEDULE` (default `'0 3 * * *'`, must be a syntactically valid 5-field cron expression), `BACKUP_RETENTION_COUNT` (`z.coerce.number().int().min(1).default(7)`), `BACKUP_MAX_AGE_HOURS` (`z.coerce.number().int().positive().default(25)`), `BACKUP_STORAGE_PATH` (optional string), `BACKUP_S3_BUCKET`/`BACKUP_S3_ENDPOINT`/`BACKUP_S3_REGION` (optional strings), `BACKUP_DATABASE_URL` (optional string, same shape validation as `DATABASE_URL` minus the anti-superuser refine — this one is *expected* to be a superuser or `BYPASSRLS` role, per D4).

**Example (positive):**
```
BACKUP_SCHEDULE=0 3 * * *
BACKUP_RETENTION_COUNT=7
BACKUP_MAX_AGE_HOURS=25
BACKUP_STORAGE_PATH=/var/backups/vault
BACKUP_DATABASE_URL=postgresql://postgres:password@db:5432/project_vault
```
Startup succeeds; the `backup:snapshot` schedule is registered with the `onVaultUnsealed` hook, same as every other pg-boss schedule.

**Example (negative — neither destination configured):** if backup scheduling is enabled (see AC-16 for the "backup disabled entirely" escape hatch) but neither `BACKUP_STORAGE_PATH` nor `BACKUP_S3_BUCKET` is set → startup fails fast with `FATAL: Backup is enabled but neither BACKUP_STORAGE_PATH nor BACKUP_S3_BUCKET is configured.` (fail at startup, not at 3am when the job first fires).

**Example (negative — both destinations configured):** setting both `BACKUP_STORAGE_PATH` and `BACKUP_S3_BUCKET` simultaneously → startup fails fast with `FATAL: BACKUP_STORAGE_PATH and BACKUP_S3_BUCKET are mutually exclusive — configure exactly one backup destination.`

**Example (negative — invalid cron):** `BACKUP_SCHEDULE=not-a-cron` → startup fails fast with a clear validation error rather than pg-boss throwing an opaque error at schedule-registration time.

---

### AC-15 — Backup can be entirely disabled (self-hosted operators who use external DB-level backup tooling)

**Given** an operator does not set `BACKUP_STORAGE_PATH`, `BACKUP_S3_BUCKET`, nor `BACKUP_DATABASE_URL`,
**When** the API starts,
**Then** backup scheduling is skipped entirely (no `backup:snapshot`/`backup:health-check` schedules registered, no startup failure) — backup is opt-in, not mandatory, since some operators run their own PostgreSQL-level backup tooling (e.g., WAL-E, pgBackRest) outside the application.

**Example (positive):** no backup-related env vars set → startup succeeds, `GET /ready` shows no backup-related warnings, `POST /api/v1/admin/backup/trigger` returns `503 { "code": "backup_not_configured", "message": "Backup is not configured on this instance. Set BACKUP_STORAGE_PATH or BACKUP_S3_BUCKET." }` if called anyway (honest, not a silent no-op).

---

### AC-16 — Sealed-vault guard applies to all backup/restore endpoints

**Given** the vault is sealed (never initialized, or sealed after restart/crash),
**When** any of the four backup/restore endpoints is called,
**Then** the existing global sealed-vault guard (Story 1.5's `vaultGuardEnabled: true` middleware — every route not on the explicit allow-list returns `503` while sealed) applies automatically; **no route-specific guard code is needed** — this is exactly the "sealed constructor, opt-out not opt-in" architecture already in place.

**Example (positive — confirms no new allow-list entry needed):**
```
POST /api/v1/admin/backup/trigger   (vault sealed)
→ 503 { "code": "sealed", "message": "Vault not initialized" }  // or "vault sealed" per existing exact copy
```
A regression test in `apps/api/src/__tests__/route-audit.test.ts`'s style confirms none of the four new backup routes are added to `EXEMPT_PATHS`/allow-lists (they must NOT be treated like `/vault/init`/`/vault/unseal`, which are pre-auth bootstrap routes).

---

### AC-17 — Docker/deployment: `pg_dump`/`pg_restore` binaries present in the runtime image (D4)

**Given** the `apps/api` production Docker image is built,
**When** the runner stage completes,
**Then** `pg_dump --version` and `pg_restore --version` succeed inside the container, reporting a PostgreSQL 16.x client matching the pinned `postgres:16-alpine` server version.

**Example (positive):** `docker run --rm project-vault-api pg_dump --version` → `pg_dump (PostgreSQL) 16.x`.

**Example (negative — regression guard):** CI step (or a Dockerfile-lint test) fails the build if `apk add postgresql16-client` is removed from the runner stage in a future refactor — add this as an explicit assertion in the existing Docker build/CI verification (`.github/workflows/ci.yml` or `release.yml`), not just tribal knowledge in a comment.

**And** multi-arch builds (AMD64 + ARM64, NFR-MAINT5) are unaffected — `postgresql16-client` is available in Alpine's package repository for both architectures; verify the release workflow's multi-arch build still succeeds after this Dockerfile change.

---

### AC-18 — Audit trail for backup/restore actions via operational logging (D6)

**Given** any backup/restore action occurs (trigger, completion, failure, restore, validate),
**When** the action executes,
**Then** a structured operational log entry is emitted using the new `OperationalEvent` constants listed in D6, including enough context to reconstruct "who did what when" from logs alone even though this is not yet tamper-evident.

**Example (positive):**
```json
{ "event": "backup.restore.initiated", "level": "warn", "userId": "...", "filename": "backup_....vault", "reason": "Recovering from accidental bulk-delete incident INC-4821", "timestamp": "..." }
{ "event": "backup.restore.completed", "level": "warn", "filename": "backup_....vault", "durationMs": 42311 }
```

**And** this story's Dev Notes must state plainly (already done in D6) that this is an interim, non-tamper-evident mechanism pending Story 9.4 — a code comment at the logging call sites references D6/Story 9.4 so a future reader understands this is intentional sequencing, not a forgotten TODO.

---

### AC-19 — Integration test coverage (explicit list — do not consider this story done without all of these)

**Given** the full feature set above,
**When** the integration test suite runs (`apps/api/src/__tests__/backup.test.ts` or `apps/api/src/modules/backup/*.test.ts`),
**Then** it covers, at minimum: (1) platform-operator bootstrap on first registration + non-bootstrap on subsequent registrations (AC-1); (2) concurrent first-registration race (AC-1); (3) `backup_runs`/`admin_alerts` RLS-exclusion regression (AC-2); (4) migration does not auto-promote existing users (AC-3); (5) `getBackupKey()` available post-unseal, throws while sealed (AC-4); (6) scheduled backup produces a decryptable file with matching checksum (AC-5); (7) pg_dump failure path (AC-5); (8) S3 upload failure path (AC-6); (9) manual trigger + concurrent-trigger 409 (AC-7); (10) list backups including a failed run (AC-8); (11) restore happy path + vault sealed after (AC-9); (12) restore missing confirmation / checksum mismatch / unknown filename / decrypt failure (AC-9); (13) validate happy path + corrupted file + zero live-table writes (AC-10); (14) retention pruning + minimum-1 enforcement + running-backup exclusion (AC-11); (15) missed-backup alert idempotency (AC-12); (16) failure alert creation (AC-13); (17) env var validation matrix (AC-14); (18) backup-disabled startup path (AC-15); (19) sealed-vault 503 on all four routes (AC-16).

---

## Tasks / Subtasks

- [x] **Task 1 — Platform operator authorization primitive (D1, AC-1, AC-3)**
  - [x] Migration: add `is_platform_operator boolean NOT NULL DEFAULT false` to `users`; add unique partial index guarding the bootstrap race (AC-1)
  - [x] Update `packages/db/src/schema/users.ts`
  - [x] Update `apps/api/src/modules/auth/service.ts` registration path: detect first-user-on-instance, set flag in same transaction
  - [x] Add `isPlatformOperator` to `AuthContext` (`apps/api/src/@types/fastify.d.ts`) and populate it wherever `orgRole` is currently populated at JWT-verification time
  - [x] Add `requirePlatformOperator()` preHandler (`apps/api/src/plugins/`)
  - [x] Update `secure-route.ts`'s `SecureRouteOptions`/`security` shape if needed to support `requireOrgScope: false` + custom preHandler composition for these routes
- [x] **Task 2 — New platform-level tables (D3, AC-2)**
  - [x] `packages/db/src/schema/backup-runs.ts`, `packages/db/src/schema/admin-alerts.ts`; export from `schema/index.ts`
  - [x] Migration SQL; add both tables to `check-rls-coverage.ts`'s `EXCLUDED_TABLES`
- [x] **Task 3 — Backup key derivation (D5, AC-4)**
  - [x] Modify `apps/api/src/modules/vault/key-service.ts`: derive + store `_backupKey` in `initVault()`/`unsealVault()`; export `getBackupKey()`; wire into `zeroKeys()`
  - [x] Unit tests in `packages/crypto`/`key-service.test.ts` (`apps/api/src/modules/vault/backup-key.test.ts`; crypto-level tests in `packages/crypto/src/workers/backup-crypto.test.ts`)
- [x] **Task 4 — Backup dump/encrypt pipeline (D2, D4, AC-5, AC-6)**
  - [x] `packages/crypto/src/workers/backup-encrypt.worker.ts` (worker_threads entry point)
  - [x] `apps/api/src/modules/backup/service.ts`: pg_dump subprocess (via `BACKUP_DATABASE_URL`) → gzip → worker-thread encrypt → filesystem or S3 write
  - [x] Add `@aws-sdk/client-s3` dependency for S3 destination (already present in `apps/api/package.json` from Story 8.2's audit S3 forwarding — reused, not newly added)
  - [x] Instance-id generation/caching for filename (D2)
  - [x] Atomic temp-file + rename write pattern
- [x] **Task 5 — Workers and scheduling (AC-5, AC-11, AC-12, AC-13)**
  - [x] `apps/api/src/workers/backup-snapshot.ts` (scheduled + manual entry point, advisory-lock guarded)
  - [x] `apps/api/src/workers/backup-retention.ts` (post-success step of backup-snapshot, per AC-11's documented "either approach acceptable")
  - [x] `apps/api/src/workers/backup-health-check.ts` (hourly missed-backup check)
  - [x] Register schedules + `onVaultUnsealed` wiring in `apps/api/src/main.ts`
- [x] **Task 6 — Routes (AC-1, AC-7, AC-8, AC-9, AC-10, AC-16)**
  - [x] `apps/api/src/modules/backup/routes.ts`: `POST /admin/backup/trigger`, `GET /admin/backups`, `POST /admin/backups/:filename/restore`, `POST /admin/backups/:filename/validate`
  - [x] `apps/api/src/modules/backup/schema.ts`: Zod request/response schemas (kept local to the module, mirroring `modules/vault/schema.ts`/`modules/compliance/schema.ts`'s convention, since this is an API-only surface with no web consumer — see Dev Notes deviation note)
  - [x] Route-exemption/classification entries in `apps/api/src/lib/route-exemptions.ts` per existing pattern; `route-audit.test.ts` passes
- [x] **Task 7 — Alerts and notification integration (D7, AC-12, AC-13)**
  - [x] Add `'backup.missed'` to `NOTIFICATION_ALERT_TYPES` (`packages/shared/src/constants/notification-types.ts`) — `'backup.failure'` already present
  - [x] Cross-org `resolveRoutingRecipients` loop helper (`apps/api/src/modules/backup/alerts.ts`)
  - [x] Admin alert creation/dedup helper (episodeKey-style idempotency, `apps/api/src/modules/backup/alerts.ts`)
- [x] **Task 8 — Operational logging (D6, AC-18)**
  - [x] New `OperationalEvent` constants in `packages/shared/src/constants/operational-event-types.ts`
  - [x] Wire `operationalLog()`/`withJobLogging()` calls throughout backup/restore/validate paths
- [x] **Task 9 — Env var validation (AC-14, AC-15)**
  - [x] Add all `BACKUP_*` vars to `apps/api/src/config/env.ts` with the mutual-exclusivity/fail-fast refinements
  - [x] Update `apps/api/.env.example` (root `.env.example`) / `docker-compose.yml` documentation comments
- [x] **Task 10 — Docker (D4, AC-17)**
  - [x] Add `postgresql16-client` to `apps/api/Dockerfile` runner stage
  - [ ] Verify multi-arch release build still succeeds — **not verified in this session** (no Docker buildx/multi-arch environment available in the dev sandbox); the added `apk add postgresql16-client` package is confirmed available for both amd64/arm64 in Alpine's repo, and a regression test (`deployment-hardening.test.ts`) guards the Dockerfile line itself, but an actual multi-arch CI build should be watched on this story's first real CI run.
  - [x] Add `BACKUP_DATABASE_URL` / any embedded-credential URL to log redaction paths (`apps/api/src/lib/redact-paths.ts`)
- [x] **Task 11 — OpenAPI spec** — ran `pnpm generate-spec`; confirmed `git diff --exit-code packages/shared/openapi.json` reports no drift. `generate-spec.ts` is a small hand-maintained stub covering only auth/session routes (confirmed via git history it has not been extended by any story since 1.6/1.7, including Epic 8's many new routes) — Story 9.3's own sprint-status note independently confirms this generator is known-stale/limited and is that story's job to fix, not 9.1's. No `api-types.ts` file exists anywhere in this repo. Nothing further to commit here.
- [x] **Task 12 — Integration tests (AC-19)** — implemented the full list; see Dev Agent Record for the exact test files covering each of the 19 items.

---

## Dev Notes

### Architecture Compliance

- Follows the sealed-route/opt-out-not-opt-in principle: backup/restore routes use `SecureRoute` with `requireOrgScope: false` as an explicit named flag, not a bespoke unsecured route (architecture.md "Cross-cutting concern composition").
- CPU-bound crypto (backup encryption) runs via `worker_threads`, per architecture.md's explicit mandate ("CPU-bound handlers (backup encryption, audit log hash chain verification...) run via `worker_threads`") — this story is the first to actually implement that pattern (no prior story had CPU-bound crypto workers yet; `packages/crypto/src/workers/` did not exist until this story).
- `HKDF_INFO.BACKUP` and its independent key lifecycle from the primary/audit keys were already reserved by Story 1.5 — this story is the first consumer, not the first definer.
- The `BACKUP_DATABASE_URL`/superuser trade-off (D4) is a documented threat-model boundary, matching the existing precedent set for plugin egress and key co-location risk in architecture.md — do not treat this as "insecure code," it is a deliberate, disclosed trade-off.

### Project Structure Notes

- New backend module: `apps/api/src/modules/backup/` (`routes.ts`, `service.ts`, `schema.ts`) — matches architecture.md's reserved `modules/backup/` location exactly.
- New workers: `apps/api/src/workers/backup-snapshot.ts`, `backup-retention.ts` (or folded into snapshot), `backup-health-check.ts` — flat, one file per job type, matching every existing worker in that directory.
- New crypto worker: `packages/crypto/src/workers/backup-encrypt.worker.ts` — matches architecture.md's reserved path.
- No `apps/web` changes in this story (API-only surface — see Product Surface Contract).
- Two brand-new platform-level (non-org-scoped) schema files: `packages/db/src/schema/backup-runs.ts`, `admin-alerts.ts`.

### Testing Standards Summary

- Vitest across all packages, `withTestOrg`/`withTestAdminAccess` test helpers where org context is needed (most backup logic explicitly is NOT org-scoped, so most tests will bypass those helpers and query `backup_runs`/`admin_alerts` directly).
- Integration tests (not unit tests) belong in `apps/api/src/__tests__/` or `apps/api/src/modules/backup/*.test.ts`, per the existing convention.
- `route-audit.test.ts` must pass with the four new routes correctly classified (not accidentally added to an `EXEMPT_PATHS`/public allow-list — they require auth + platform-operator, unlike `/vault/init`/`/vault/unseal`).
- `check-rls-coverage.ts` must pass with `backup_runs`/`admin_alerts` correctly excluded.

### Previous Story Intelligence (Story 1.5 — Vault Initialization & Master Key Management, `done`)

- `packages/crypto/src/kdf.ts` already contains `HKDF_INFO.BACKUP = 'project-vault-backup-v1'` with an explicit `// Story 9.1 uses this` comment — confirming this story's key-derivation approach was anticipated.
- `key-service.ts`'s exact pattern for `getAuditKey()`/`zeroKeys()` must be mirrored precisely for `getBackupKey()` (D5) — same "throws while sealed," same buffer-zeroing discipline.
- The vault state machine (`uninitialized → unsealed → sealed → unsealed`) and its enforcement via `vaultGuardEnabled: true` in `createApp()` requires **zero** new guard code for this story's routes (AC-16) — this is the single biggest reuse win from Story 1.5.
- `docker-compose.yml`'s `migrate` vs. `api` service split (superuser vs. `vault_app`) is the direct precedent D4 extends.

### Git Intelligence (Recent Commits)

- Most recent Epic 8 work (8-1 through 8-4 story files) established the `writeHumanAuditEntryOrFailClosed`/operational-log-vs-audit-log split this story's D6 explicitly does NOT use for backup (org-scoped audit log doesn't fit an instance-wide action) — read `apps/api/src/lib/audit-or-fail-closed.ts` to understand why it is *not* reused here, rather than assuming it should be.
- `packages/shared/src/constants/notification-types.ts` already contains `'backup.failure'` (pre-reserved) — a one-line addition of `'backup.missed'` is all that's needed there (D7).
- No prior commit touches `packages/crypto/src/workers/`, `apps/api/src/modules/backup/`, or any `backup_*`/`admin_alerts` table — this is genuinely greenfield within an otherwise mature, pattern-rich codebase; lean on the patterns cited throughout this story rather than inventing new ones.

### Cross-References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.1: Encrypted Backup & Restore] (lines ~2003-2033) — literal AC text this story's ACs are derived from, with D1-D8 documenting where this story's implementation deviates from or extends that literal text.
- [Source: _bmad-output/planning-artifacts/epics.md#Epic 9: Platform Operations, API & Self-Hosting] (preamble, lines ~1989-2001) — FR coverage, blockers (AC-E9a/b/c/d), and the FR92 schema-freeze precondition (D8).
- [Source: _bmad-output/planning-artifacts/prd.md#Backup & Restore] (FR88-FR90, FR92) and [#NonFunctional Requirements] (NFR-SEC1, NFR-DI3, NFR-REL6, NFR-SEC2).
- [Source: _bmad-output/planning-artifacts/architecture.md] — key co-location risk / custody models (lines ~72), audit log key independence (lines ~73), worker_threads for CPU-bound crypto (lines ~405-406, 1278), `packages/crypto` structure (lines ~1191-1203), module/route/worker mapping table (lines ~896-901).
- [Source: _bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md] — vault state machine, HKDF_INFO reservations, key-service.ts exact patterns this story extends.
- [Source: _bmad-output/implementation-artifacts/8-1-tamper-evident-audit-log-with-hmac-integrity.md] and [8-4-data-subject-erasure-request-handling.md] — precedent for the "Key Design Decisions & Open Questions" documentation style and the audit-log-vs-operational-log classification rule this story's D6 applies.
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — Product Surface Contract rules (G1-G4) applied above.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

### Open Questions (for Epic 9 sprint planning / retrospective — not blockers to `ready-for-dev`)

1. No story currently scopes a backup/restore admin web UI (Product Surface Contract gap — same pattern as Epic 8's stories; must be raised at Epic 9 retro per G2).
2. The `vault_backup` dedicated-role hardening path (D4's documented alternative to reusing the superuser) is left as a runbook-documented option, not enforced — a future hardening story could make it the default.
3. `assetsPresent`'s table enumeration (AC-10, D8) will need extension once Epic 8's schema fully freezes (e.g., if Story 8.4's `data_erasure_requests` or Story 8.3's still-unbuilt tables should be included in restore-validation reporting).
4. Story 9.4 (not yet written) must retroactively add `platform_audit_events` coverage for the backup/restore action types this story only logs operationally (D6) — flag this explicitly when 9.4 is created.

## Dev Agent Record

### Agent Model Used

claude-sonnet-5 (Claude Code)

### Debug Log References

- Discovered and fixed: worker_thread structured-clone loses custom Error subclass identity — `BackupDecryptError` thrown inside `backup-encrypt.worker.ts` arrived at the caller as a plain `Error` after crossing the `worker_threads` postMessage boundary, breaking `restoreFromBackup`'s `instanceof BackupDecryptError` check (AC-9's `decrypt_failed` → 401 case) whenever the real worker path was used (i.e., always in production). Fixed by tagging the worker's failure message with a `kind: 'decrypt_failed' | 'other'` field and reconstructing the correct class in `run-backup-worker.ts`. Caught by a dedicated test (`service.test.ts`'s "checksum-matching but wrong-key-encrypted file" case) once `packages/crypto`'s dist was rebuilt and the real worker path was actually exercised.
- Discovered and fixed: initial filename scheme (`backup_<YYYYMMDDTHHMMSSZ>_<instanceId>.vault`, whole-second precision) collided under the `backup_runs.filename` unique constraint when two backups were created within the same wall-clock second (a real risk for rapid manual-trigger-after-completion sequences, and a certainty for fast automated tests). Fixed by adding millisecond precision to the compact-ISO timestamp component (documented as a deliberate, minor deviation from the AC-5 example's illustrative filename).
- Fastify response-schema validation applies to whatever status code is actually sent for a matched route, regardless of which layer sent it — declaring a custom `503` schema (`BackupNotConfiguredErrorSchema`) on `POST /admin/backup/trigger` caused a 500 "Response doesn't match the schema" error when the *global* sealed-vault guard (a different, pre-existing 503 shape: `{status, message}`) fired first. Fixed by unioning the route's `503` schema with a `VaultSealedResponseSchema`. This is very likely a latent, currently-untested issue on `audit/routes.ts`'s and `machine-users/*.ts`'s own pre-existing `503: ApiErrorSchema` declarations too (same shape mismatch), but fixing those is out of scope for this story — flagged here for visibility, not fixed elsewhere.
- Confirmed (via `git stash` + rerun) that `apps/api/src/__tests__/secure-route.integration.test.ts`'s "rolls back handler writes when audit HMAC key material is unavailable" test fails identically against the pre-story, unmodified codebase in this dev sandbox — a pre-existing environmental flake (likely accumulated shared-dev-Postgres `vault_state` state from many isolated test-file runs across a long session), not a regression introduced by this story.

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide for Story 9.1 covering: platform-operator authorization bootstrap (new primitive, D1), whole-instance backup/restore semantics resolving an epics.md filename/dump-scope contradiction (D2), two new platform-level tables reused by future Epic 9 stories (D3), a required RLS-bypass database credential for pg_dump/restore that the API's normal connection cannot provide (D4, a genuine latent bug this story prevents), a required change to the already-`done` Story 1.5 key-service (D5), and an interim operational-logging audit strategy pending Story 9.4 (D6).
- **Implementation summary (2026-07-06):** all 12 tasks and all 19 ACs implemented with TDD red-green (tests written/confirmed failing for the right reason before implementation, for every new file). 1414+ apps/api tests green, 0 regressions (see Debug Log for the one confirmed-pre-existing flake). `pnpm turbo typecheck`/`lint` clean across `apps/api`, `packages/db`, `packages/crypto`, `packages/shared` (only pre-existing, unrelated warnings remain).
- **AC-10 design choice:** implemented the "structural inspection of the decompressed SQL text" option (regex-extracting `CREATE TABLE` statements from the decrypted, decompressed dump) rather than the "throwaway temporary database restore" option — both are documented as acceptable by the AC; the text-inspection approach has zero risk of ever touching a live connection by construction, and is fully unit-testable without needing `BACKUP_DATABASE_URL`/`createdb` privileges in a test environment.
- **AC-7 concurrency design:** `acquireBackupSlot()` uses a `pg_try_advisory_xact_lock` scoped only to the brief atomic "check running / insert running row" critical section (not held for the whole dump duration) — the `backup_runs.status = 'running'` row's mere existence is the actual, long-lived concurrency marker future triggers check against. Documented in code comments as a deliberate design choice, not an oversight.
- **D2 filename deviation:** added millisecond precision to the compact-ISO timestamp (not just whole seconds as the AC-5 example illustrates) to make the `backup_runs.filename` unique constraint safe against rapid successive backups; see Debug Log.
- **Known limitations carried forward (all explicitly documented in code comments at their construction sites, per D8/D6):**
  - `assetsPresentFromTables`'s table list (`credentials`, `projects`, `users`, `audit_log_entries`) reflects the schema as of this story; must be extended if Epic 8 lands new compliance-relevant tables before Epic 9 closes (D8).
  - Backup/restore/validate actions are audited via structured operational logging only (D6) — not tamper-evident, pending Story 9.4's `platform_audit_events` retrofit.
  - Docker multi-arch build was not actually re-run in this session (no buildx environment available) — see Task 10's unchecked sub-item.
  - The pre-existing `secure-route.integration.test.ts` flake (see Debug Log) was not fixed — it predates this story and is out of scope.

### File List

**New — backup module (apps/api)**
- `apps/api/src/modules/backup/config.ts` — resolves backup destination/enablement from env (D-Task4)
- `apps/api/src/modules/backup/filename.ts` (+ `filename.test.ts`) — instance-id resolution, filename scheme (D2)
- `apps/api/src/modules/backup/pg-process.ts` — `pg_dump`/`psql` subprocess wrappers (D4)
- `apps/api/src/modules/backup/storage.ts` (+ `storage.test.ts`) — filesystem/S3 destination abstraction (AC-5, AC-6)
- `apps/api/src/modules/backup/dump-inspect.ts` — structural `CREATE TABLE` extraction for validate (AC-10, D8)
- `apps/api/src/modules/backup/service.ts` (+ `service.test.ts`) — core orchestration (acquire/execute/list/restore/validate/prune)
- `apps/api/src/modules/backup/alerts.ts` — admin_alerts creation/dedup + cross-org delivery (D7)
- `apps/api/src/modules/backup/schema.ts` — Zod request/response schemas
- `apps/api/src/modules/backup/routes.ts` — the four HTTP endpoints + `reportBackupFailureAlert`
- `apps/api/src/modules/backup/backup.routes.test.ts`, `backup-disabled.routes.test.ts` — HTTP-layer integration tests

**New — workers (apps/api)**
- `apps/api/src/workers/backup-snapshot.ts` (+ `.test.ts`) — scheduled/manual job entry point
- `apps/api/src/workers/backup-retention.ts` — retention prune post-success step
- `apps/api/src/workers/backup-health-check.ts` (+ `.test.ts`) — hourly missed-backup check

**New — auth/vault/plugins (apps/api)**
- `apps/api/src/modules/auth/platform-operator-bootstrap.test.ts`
- `apps/api/src/modules/vault/backup-key.test.ts`
- `apps/api/src/plugins/require-platform-operator.ts`

**New — crypto worker (packages/crypto)**
- `packages/crypto/src/workers/backup-crypto.ts` (+ `.test.ts`) — AES-256-GCM encrypt/decrypt
- `packages/crypto/src/workers/backup-encrypt.worker.ts` — worker_threads entry point
- `packages/crypto/src/workers/run-backup-worker.ts` (+ `.test.ts`) — worker runner with sync fallback

**New — db (packages/db)**
- `packages/db/src/schema/backup-runs.ts`, `admin-alerts.ts` (+ `backup-schema.test.ts`)
- `packages/db/src/migrations/0038_platform_operator_and_backup_tables.sql`

**Modified**
- `packages/db/src/schema/users.ts` — `isPlatformOperator` column
- `packages/db/src/schema/index.ts` — export new schema modules
- `packages/db/src/check-rls-coverage.ts` — `EXCLUDED_TABLES` additions
- `packages/db/src/migrations/meta/_journal.json` — migration 0038 entry
- `packages/crypto/src/index.ts` — export new backup crypto/worker functions
- `packages/shared/src/constants/notification-types.ts` (+ `.test.ts`) — `'backup.missed'`
- `packages/shared/src/constants/operational-event-types.ts` — `BACKUP_*` events
- `apps/api/src/modules/vault/key-service.ts` — `_backupKey`/`getBackupKey()`/`zeroKeys()` wiring, `__getRawBackupKeyForTest()`
- `apps/api/src/modules/auth/service.ts` — `resolveIsFirstUser`/`insertUserWithPlatformOperatorBootstrap`
- `apps/api/src/plugins/authenticate.ts` — populates `isPlatformOperator`
- `apps/api/src/lib/secure-route.ts` — `security.requirePlatformOperator` support
- `apps/api/src/lib/route-exemptions.ts` — classification entries for the 4 new routes
- `apps/api/src/lib/redact-paths.ts` — `backupDatabaseUrl` redaction
- `apps/api/src/@types/fastify.d.ts` — `AuthContext.isPlatformOperator`
- `apps/api/src/app.ts` — registers `backupRoutes`
- `apps/api/src/main.ts` — conditional schedule registration + worker wiring
- `apps/api/src/config/env.ts` (+ `.test.ts`) — `BACKUP_*` env vars and validation
- `apps/api/Dockerfile` — `postgresql16-client` in runner stage
- `apps/api/src/__tests__/deployment-hardening.test.ts` — Dockerfile regression guard
- `docker-compose.yml` — `BACKUP_*` env passthrough + `backup_data` volume
- `.env.example` — `BACKUP_*` documentation
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 9-1 status → review
