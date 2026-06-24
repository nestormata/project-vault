# Story 1.4: Database Foundation with PostgreSQL RLS & Core Schema

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a platform operator running a multi-organization vault instance,
I want the database schema to enforce organization-scoped data isolation at the PostgreSQL level via Row-Level Security,
so that no application-layer bug can ever leak data between organizations — isolation is structural, not conventional.

## Acceptance Criteria

*Covers: FR61* [Source: _bmad-output/planning-artifacts/epics.md#Story-1.4]

**Prerequisite:** Story 1.3 is complete and PostgreSQL 16 is running via Docker Compose.

---

### AC-1: Core Schema Tables Created by Migration

**Given** a fresh PostgreSQL 16 instance with no schema,
**When** the developer runs `pnpm --filter @project-vault/db db:migrate`,
**Then** all of the following tables are created across two migration files (see AC-1b) with zero errors:

**`organizations`**
```sql
CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**`users`**
```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**`org_memberships`** ← canonical name per Architecture doc (epics use `organization_members` — see Conflict Resolution)
```sql
CREATE TABLE org_memberships (
  org_id                   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                     TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  grace_period_expires_at  TIMESTAMPTZ,
  last_active_at           TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);
```

**`user_identity_tokens`** (PII externalization layer for audit log — referenced by all audit events instead of raw user identity)
```sql
CREATE TABLE user_identity_tokens (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,  -- nullable post-deletion
  display_name     TEXT NOT NULL,
  pseudonymized_at TIMESTAMPTZ,                                    -- set when user is deleted
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**`sessions`** *(partial schema — intentionally minimal for Story 1.4)*
```sql
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL DEFAULT 1,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      TEXT,
  user_agent      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NOTE: jti (TEXT UNIQUE) and revoked_at (TIMESTAMPTZ) are intentionally absent.
  -- They are added by Story 1.7 (JWT Session Management) via ALTER TABLE migration.
  -- Story 1.6 devs: do NOT assume these columns exist — see Dev Notes.
);
```

**`audit_log_entries`** ← canonical name per Architecture doc (epics use `audit_events` — see Conflict Resolution)
```sql
-- IMMUTABLE: append-only, no updates permitted
CREATE TABLE audit_log_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  project_id     UUID,                                         -- nullable; no FK yet (projects table in a later story)
  actor_token_id UUID REFERENCES user_identity_tokens(id),    -- nullable for system events
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('human','machine_user','system')),
  event_type     TEXT NOT NULL,                               -- must be an AuditEvent constant from packages/shared
  resource_id    UUID,
  resource_type  TEXT,
  ip_address     TEXT,
  user_agent     TEXT,
  payload        JSONB NOT NULL DEFAULT '{}',                 -- NEVER contains secret values
  key_version    INTEGER NOT NULL,
  hmac           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at: immutable table
);
CREATE INDEX idx_audit_log_entries_org_created   ON audit_log_entries (org_id, created_at DESC);
CREATE INDEX idx_audit_log_entries_project        ON audit_log_entries (project_id, created_at DESC);
CREATE INDEX idx_audit_log_entries_event_type     ON audit_log_entries (event_type, created_at DESC);
CREATE INDEX idx_audit_log_entries_resource       ON audit_log_entries (resource_id, created_at DESC);
```

**`security_alerts`**
```sql
CREATE TABLE security_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  alert_type       TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  payload          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'PENDING_DELIVERY'
                     CHECK (status IN ('PENDING_DELIVERY','delivered','dismissed')),
  dismissed_by     UUID REFERENCES user_identity_tokens(id),  -- nullable
  dismissed_at     TIMESTAMPTZ,
  dismissal_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**`api_instances`** (required for multi-instance guard per Architecture doc)
```sql
CREATE TABLE api_instances (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

### AC-1b: `vault_app` Application Role — RLS Is Only Effective with a Non-Superuser Connection

> 🔴 **CRITICAL — Without this AC, all RLS policies are silently bypassed.** PostgreSQL skips ALL RLS checks for SUPERUSER accounts and table owners, regardless of whether `ENABLE ROW LEVEL SECURITY` is set. If the app connects as `postgres`, every org sees every other org's data.

**Given** the schema migration has run,
**And** the `vault_app` role is created by the migration,
**When** the application connects to PostgreSQL using `DATABASE_URL`,
**Then** `DATABASE_URL` must use the `vault_app` role credentials — never `postgres` or any SUPERUSER:

```sql
-- Included in migration file 0001_rls_and_triggers.sql (see AC migration structure):
CREATE ROLE vault_app WITH LOGIN PASSWORD 'change-me-in-env';
GRANT CONNECT ON DATABASE project_vault TO vault_app;
GRANT USAGE ON SCHEMA public TO vault_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vault_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vault_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vault_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vault_app;
```

**And** `.env.example` is updated to document:
```
# IMPORTANT: Must use vault_app role, NOT postgres. Using postgres bypasses all RLS.
DATABASE_URL=postgresql://vault_app:change-me-in-env@localhost:5432/project_vault
```

**And** `apps/api/src/config/env.ts` adds a startup validation that rejects a `DATABASE_URL` containing `postgres` as the username with a clear error:
```
FATAL: DATABASE_URL must not use the 'postgres' superuser — RLS enforcement requires a non-superuser role.
Use 'vault_app' or another application role. See .env.example.
```

---

### AC-2: `orgScoped` Helper Enforces org_id Convention

**Given** the Drizzle schema is defined in `packages/db/src/schema/`,
**When** a developer adds a new org-scoped table,
**Then** they use the shared `orgScoped` helper (defined in `packages/db/src/schema/helpers.ts`) which adds the `org_id` column with a NOT NULL FK to `organizations` and the correct RLS policy:

```typescript
// packages/db/src/schema/helpers.ts
import { uuid } from 'drizzle-orm/pg-core'

export function orgScoped() {
  return {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
  }
}
```

**And** all org-scoped tables in this story use `orgScoped()` in their Drizzle schema definition (except `organizations` itself, `users`, `user_identity_tokens`, and `api_instances`, which are either the root entity or not org-scoped).

---

### AC-3: PostgreSQL Row-Level Security Enabled on All Org-Scoped Tables

**Given** the schema migration has run,
**When** a PostgreSQL query is executed without `app.current_org_id` being set in the transaction,
**Then** org-scoped tables (`org_memberships`, `sessions`, `audit_log_entries`, `security_alerts`) return zero rows (RLS blocks all access when the setting is absent or empty).

**And** the migration enables RLS and creates a policy on every org-scoped table:
```sql
ALTER TABLE org_memberships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_alerts   ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_memberships_isolation   ON org_memberships   USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY sessions_isolation          ON sessions          USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY audit_log_isolation         ON audit_log_entries USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY security_alerts_isolation   ON security_alerts   USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

> ⚠️ **`NULLIF` is required — not just `true` flag alone.** `current_setting('app.current_org_id', true)` returns `''` (empty string), NOT `NULL`, when the variable has never been set in the session. Casting `''` directly to UUID (`''::uuid`) throws `invalid input syntax for type uuid` — a runtime PostgreSQL error, not a clean empty result set. `NULLIF(..., '')` converts the empty string to `NULL` first; `NULL::uuid` is `NULL`; `NULL = any_uuid` is always `FALSE` under SQL three-valued logic — so all rows are safely blocked when no org context is set.
>
> **The one-liner to remember:** `NULLIF(current_setting('app.current_org_id', true), '')::uuid`

---

### AC-4: `withOrg()` Sets Transaction-Scoped Org Context

**Given** the `withOrg(orgId, fn)` function in `packages/db/src/index.ts`,
**When** it is called with a valid org UUID and a query function,
**Then** it opens a `db.transaction()` and executes `SET LOCAL "app.current_org_id" = '${orgId}'` as the first statement in the transaction, so RLS applies to all subsequent Drizzle queries in `fn`:

```typescript
// packages/db/src/index.ts — updated implementation
export async function withOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
    return fn(tx as unknown as Tx)
  })
}
```

**And** `SET LOCAL` (not `SET`) is used so the setting automatically resets when the transaction ends — eliminating connection pool contamination where a pooled connection carries a previous request's org context into the next request.

**And** `withOrgReadScope()` follows the same pattern and is wired identically for now (differentiated in a later story when read-only access patterns are introduced).

**And** the existing `withAdminAccess()` stub is updated to validate `authCtx.role === 'admin'` before opening the transaction (exact validation logic deferred to Story 1.11 — leave a `// TODO Story 1.11` comment at the validation point).

---

### AC-5: Append-Only Trigger on `audit_log_entries`

**Given** the `audit_log_entries` table exists,
**When** any application code attempts `UPDATE` or `DELETE` on the table,
**Then** a PostgreSQL trigger raises an exception and blocks the operation:

```sql
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_entries is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutability
  BEFORE UPDATE OR DELETE ON audit_log_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
```

**And** an integration test in `packages/db/src/__tests__/audit-log-immutability.test.ts` asserts:
- INSERT succeeds
- `UPDATE` throws an error (caught via Drizzle's error propagation)
- `DELETE` throws an error

---

### AC-6: `updated_at` Auto-Update Trigger on All Mutable Tables

**Given** any of the mutable tables (`organizations`, `users`, `org_memberships`, `user_identity_tokens`, `sessions`, `security_alerts`),
**When** a row is updated,
**Then** `updated_at` is automatically set to `NOW()` by a PostgreSQL trigger — not by application code:

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to every mutable table:
CREATE TRIGGER set_updated_at BEFORE UPDATE ON organizations       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON users               FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON org_memberships     FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON user_identity_tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sessions            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON security_alerts     FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

---

### AC-7: Migration Idempotency

**Given** `pnpm --filter @project-vault/db db:migrate` has already been run against the target database,
**When** the developer runs it again,
**Then** the command exits 0 with no schema changes — Drizzle's migration tracking table (`drizzle.__drizzle_migrations`) records the applied migration and skips it on subsequent runs.

---

### AC-8: `pnpm db:seed:test` Fixture Script

**Given** a running PostgreSQL instance (local dev or Docker),
**When** the developer runs `pnpm --filter @project-vault/db db:seed:test`,
**Then** the script inserts exactly the following test fixture (idempotent — no error on re-run via `ON CONFLICT DO NOTHING` or `TRUNCATE + INSERT`):

- **Org A:** `{ id: '00000000-0000-0000-0000-000000000001', name: 'Org Alpha', slug: 'org-alpha' }`
- **Org B:** `{ id: '00000000-0000-0000-0000-000000000002', name: 'Org Beta', slug: 'org-beta' }`
- **User 1:** `{ id: '00000000-0000-0000-0000-000000000010', email: 'alice@example.com', password_hash: '<bcrypt sentinel>' }` — member of Org A with role `owner`
- **User 2:** `{ id: '00000000-0000-0000-0000-000000000011', email: 'bob@example.com', password_hash: '<bcrypt sentinel>' }` — member of Org B with role `owner`

**And** the seed script is located at `packages/db/src/seed-test.ts` and invoked via a `db:seed:test` script entry in `packages/db/package.json`.

**And** because `org_memberships` has RLS enabled, the seed script must use `withOrg()` when inserting membership rows — a direct `INSERT INTO org_memberships` without org context will be silently blocked by RLS:

```typescript
// packages/db/src/seed-test.ts — excerpt showing required pattern
const ORG_A_ID = '00000000-0000-0000-0000-000000000001'
const ORG_B_ID = '00000000-0000-0000-0000-000000000002'

// Non-org-scoped tables: insert directly
await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG_A_ID}, 'Org Alpha', 'org-alpha') ON CONFLICT DO NOTHING`)

// Org-scoped tables: MUST use withOrg() or RLS silently blocks the insert
await withOrg(ORG_A_ID, (tx) =>
  tx.insert(orgMemberships)
    .values({ orgId: ORG_A_ID, userId: USER_1_ID, role: 'owner', status: 'active' })
    .onConflictDoNothing()
)
```

---

### AC-9: `withTestOrg()` Integration Test Helper Updated

**Given** the real RLS infrastructure now exists,
**When** integration tests call `withTestOrg(fn)` from `@project-vault/db/test-helpers`,
**Then** the function creates a real test organization in the database, opens a `withOrg()` transaction scoped to that org, executes `fn({ orgId, tx })`, then cleans up the test organization and its members on completion (even on failure):

```typescript
// packages/db/src/test-helpers.ts — real implementation
export async function withTestOrg<T>(
  fn: (ctx: { orgId: string; tx: Tx }) => Promise<T>
): Promise<T> {
  const orgId = crypto.randomUUID()
  await getDb().execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${'test-org-' + orgId.slice(0,8)}, ${'test-' + orgId.slice(0,8)})`
  )
  try {
    return await withOrg(orgId, (tx) => fn({ orgId, tx }))
  } finally {
    // Delete non-cascading children FIRST to avoid FK constraint violations.
    // audit_log_entries and security_alerts have no ON DELETE CASCADE on org_id.
    // org_memberships and sessions DO have CASCADE — they are cleaned up automatically.
    await getDb().execute(sql`DELETE FROM audit_log_entries WHERE org_id = ${orgId}`)
    await getDb().execute(sql`DELETE FROM security_alerts WHERE org_id = ${orgId}`)
    await getDb().execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
  }
}
```

> ⚠️ **Cleanup order matters.** `audit_log_entries` and `security_alerts` FK to `organizations` without `ON DELETE CASCADE`. Deleting the org first causes a FK violation. Always delete these explicitly before the org row. `org_memberships` and `sessions` have `ON DELETE CASCADE` and are handled automatically.

**And** all existing and future integration tests in `apps/api/src/__tests__/` use `withTestOrg()` exclusively — never raw `db.transaction()` — as the test fixture harness.

---

### AC-10: `check-rls-coverage.ts` CI Guard

**Given** a running PostgreSQL instance with the migrated schema,
**When** `pnpm --filter @project-vault/db check-rls` is executed (mapped to `tsx scripts/check-rls-coverage.ts`),
**Then** the script queries `pg_tables` and `pg_policies` and exits non-zero with a descriptive error if any table with an `org_id` column does not have at least one RLS policy:

```typescript
// scripts/check-rls-coverage.ts
// Exits 0 if all org_id tables have RLS policies; exits 1 with table names if not.
// Also verifies: audit_log_entries has an RLS policy scoped to org_id.
```

Example expected output on failure:
```
FATAL: RLS coverage gap detected — the following tables have org_id but no RLS policy:
  - my_new_table

Run: ALTER TABLE my_new_table ENABLE ROW LEVEL SECURITY;
     CREATE POLICY ... ON my_new_table USING (org_id = current_setting('app.current_org_id', true)::uuid);
```

**And** this script is added as a required CI step in `.github/workflows/ci.yml` that runs after `pnpm --filter @project-vault/db db:migrate` in the integration test job.

---

### AC-11: `rls-isolation.test.ts` Integration Test — Required CI Pass

**Given** the schema and RLS policies are in place,
**When** `rls-isolation.test.ts` runs in `packages/db/src/__tests__/`,
**Then** the test:
1. Creates Org A and Org B (two separate organizations)
2. Inserts one `sessions` row scoped to Org A
3. Inserts one `sessions` row scoped to Org B
4. Calls `withOrg(orgA.id, tx => tx.select().from(sessions))` and asserts the result contains **exactly 1 row** (Org A's) — zero Org B rows
5. Calls `withOrg(orgB.id, tx => tx.select().from(sessions))` and asserts the result contains **exactly 1 row** (Org B's) — zero Org A rows
6. Runs identical cross-org assertions for `security_alerts` and `org_memberships`
7. Runs identical cross-org assertions for `audit_log_entries`

**And** the test asserts that a raw `db.select().from(sessions)` without a `withOrg()` wrapper returns **zero rows** (because RLS blocks access when `app.current_org_id` is not set).

**And** this test file is registered as a required check in CI — a PR cannot merge if it fails.

---

### AC-12: Drizzle Schema File Organization

**Given** the schema is defined in `packages/db/src/schema/`,
**When** the developer opens that directory,
**Then** the structure is:

```
packages/db/src/schema/
  index.ts                  # re-exports all tables + helpers
  helpers.ts                # orgScoped() helper
  organizations.ts          # organizations table
  users.ts                  # users table
  org-memberships.ts        # org_memberships table (using orgScoped())
  user-identity-tokens.ts   # user_identity_tokens table
  sessions.ts               # sessions table (using orgScoped())
  audit-log-entries.ts      # audit_log_entries table (using orgScoped()); IMMUTABLE comment
  security-alerts.ts        # security_alerts table (using orgScoped())
  api-instances.ts          # api_instances table
```

**And** every schema file that defines an org-scoped table includes the comment:
```typescript
// IMMUTABLE: append-only, no updates permitted
```
on `audit_log_entries` only (the others are mutable).

**And** `packages/db/src/schema/index.ts` re-exports all tables so consumers import from `@project-vault/db`:
```typescript
export * from './organizations.js'
export * from './users.js'
export * from './org-memberships.js'
// ... etc
```

---

### AC-13: Drizzle Schema Follows Naming Convention

**Given** the Drizzle schema definitions,
**When** inspecting any schema file,
**Then** the following naming rules from the Architecture document are applied:

- Table names: `snake_case` plural (Drizzle `.name()` method)
- Column names: `snake_case` (Drizzle column `.name()`)
- TypeScript property names: `camelCase` mapped to `snake_case` via `.name()`
- Foreign key pattern: `{singular_table}_id`
- Index names: `idx_{table}_{columns}`

Example for `org_memberships`:
```typescript
export const orgMemberships = pgTable(
  'org_memberships',
  {
    orgId:                 uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId:                uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role:                  text('role').notNull(),
    status:                text('status').notNull().default('active'),
    gracePeriodExpiresAt:  timestamp('grace_period_expires_at', { withTimezone: true }),
    lastActiveAt:          timestamp('last_active_at', { withTimezone: true }),
    createdAt:             timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt:             timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
  })
)
```

---

### AC-14: `jscpd` Schema Exclusion Confirmed

**Given** the `packages/db/src/schema/` directory is excluded from jscpd duplication checking,
**When** the developer opens `.jscpd.json`,
**Then** it contains an exclusion for `packages/db/src/schema/` with the documented comment:
```json
{
  "ignore": [
    "packages/db/src/schema/**"  // Drizzle schema column definitions are intentionally repetitive by design
  ]
}
```

**And** the developer has manually reviewed each schema file to confirm no column block is duplicated where a shared helper could be used instead (DoD gate — this is a manual review step logged in the Dev Agent Record).

---

### AC-15: Quality Gate Pass

**Given** all implementation tasks are complete,
**When** the developer runs the project-wide quality gates,
**Then** all pass:
- `pnpm lint` — zero ESLint errors across all packages
- `pnpm typecheck` — zero TypeScript errors
- `pnpm test` — all tests pass including new integration tests
- `pnpm build` — all packages build cleanly
- `pnpm jscpd` — zero duplication above threshold (schema folder excluded)
- `docker compose up` — PostgreSQL starts healthy; `pnpm --filter @project-vault/db db:migrate` runs cleanly against the container
- `pnpm docker:smoke` — exits 0

---

## Tasks / Subtasks

- [ ] Task 1: Write the Drizzle schema files (AC: #12, #13, #14)
  - [ ] Create `packages/db/src/schema/helpers.ts` with `orgScoped()` function
  - [ ] Create `packages/db/src/schema/organizations.ts` — `organizations` table (mutable, no orgScoped)
  - [ ] Create `packages/db/src/schema/users.ts` — `users` table (mutable, no orgScoped)
  - [ ] Create `packages/db/src/schema/org-memberships.ts` — `org_memberships` table using `orgScoped()`
  - [ ] Create `packages/db/src/schema/user-identity-tokens.ts` — `user_identity_tokens` table (nullable `user_id` FK)
  - [ ] Create `packages/db/src/schema/sessions.ts` — `sessions` table using `orgScoped()`
  - [ ] Create `packages/db/src/schema/audit-log-entries.ts` — `audit_log_entries` table; add `// IMMUTABLE` comment
  - [ ] Create `packages/db/src/schema/security-alerts.ts` — `security_alerts` table using `orgScoped()`
  - [ ] Create `packages/db/src/schema/api-instances.ts` — `api_instances` table (no orgScoped, no RLS)
  - [ ] Update `packages/db/src/schema/index.ts` to re-export all tables
  - [ ] Confirm `.jscpd.json` has the schema exclusion with documented comment
  - [ ] Manually verify no column blocks are duplicated without a helper

- [ ] Task 2: Generate and validate the Drizzle migration (AC: #1, #7)
  - [ ] Run `pnpm --filter @project-vault/db generate` to generate the migration SQL from schema
  - [ ] Review the generated SQL to confirm it matches the AC-1 table definitions exactly
  - [ ] Add RLS `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` statements to the migration SQL (Drizzle does not generate these automatically — they must be added manually to the generated migration file)
  - [ ] Add the `prevent_audit_log_mutation()` trigger function and `audit_log_immutability` trigger to the migration
  - [ ] Add the `update_updated_at_column()` trigger function and per-table `set_updated_at` triggers to the migration
  - [ ] Run `pnpm --filter @project-vault/db db:migrate` against a local/Docker PostgreSQL — confirm exit 0
  - [ ] Run `pnpm --filter @project-vault/db db:migrate` a second time — confirm idempotent exit 0

- [ ] Task 3: Implement the `withOrg()` function with real RLS wiring (AC: #4)
  - [ ] Update `packages/db/src/index.ts` — `withOrg()` must call `SET LOCAL "app.current_org_id" = $orgId` inside the transaction using `tx.execute(sql\`SELECT set_config('app.current_org_id', ${orgId}, true)\`)`
  - [ ] Update `withOrgReadScope()` identically for now
  - [ ] Update `withAdminAccess()` — add `// TODO Story 1.11: validate authCtx.role === 'admin' here` placeholder
  - [ ] Confirm TypeScript compiles after changes: `pnpm --filter @project-vault/db typecheck`

- [ ] Task 4: Implement `withTestOrg()` real integration helper (AC: #9)
  - [ ] Update `packages/db/src/test-helpers.ts` — replace stub with real implementation that creates a test org, opens `withOrg()`, runs `fn`, then deletes the org in a `finally` block
  - [ ] Verify `withTestOrg` cleans up even when `fn` throws

- [ ] Task 5: Write the `rls-isolation.test.ts` integration test (AC: #11)
  - [ ] Create `packages/db/src/__tests__/rls-isolation.test.ts`
  - [ ] Test covers: two orgs, cross-org query isolation for `sessions`, `org_memberships`, `security_alerts`, `audit_log_entries`
  - [ ] Test asserts zero rows returned when `withOrg()` is not used (bare `db.select()` outside transaction returns 0 rows from RLS-enabled tables)
  - [ ] Test passes with `pnpm --filter @project-vault/db test`
  - [ ] Confirm no `skip`, `todo`, or `.only` markers in committed code

- [ ] Task 6: Write the `audit-log-immutability.test.ts` test (AC: #5)
  - [ ] Create `packages/db/src/__tests__/audit-log-immutability.test.ts`
  - [ ] Test: INSERT succeeds; UPDATE throws; DELETE throws
  - [ ] Use `withTestOrg()` as the fixture harness

- [ ] Task 7: Create `pnpm db:seed:test` script (AC: #8)
  - [ ] Create `packages/db/src/seed-test.ts` with deterministic UUIDs and `ON CONFLICT DO NOTHING`
  - [ ] Add `"db:seed:test": "tsx src/seed-test.ts"` to `packages/db/package.json`
  - [ ] Run `pnpm --filter @project-vault/db db:seed:test` twice — confirm idempotent exit 0

- [ ] Task 8: Implement `check-rls-coverage.ts` CI script (AC: #10)
  - [ ] Create `scripts/check-rls-coverage.ts` at the repo root (alongside other `scripts/` files)
  - [ ] Script queries `information_schema.columns` for tables with `org_id` and `pg_policies` for policies
  - [ ] Script verifies `audit_log_entries` has a policy (per epics cross-reference at line 1833)
  - [ ] Script exits 1 with a clear error if any gap found; exits 0 if all covered
  - [ ] Add `"check-rls": "tsx scripts/check-rls-coverage.ts"` to root `package.json`
  - [ ] Add a CI step in `.github/workflows/ci.yml` to run this after migration in the integration test job

- [ ] Task 9: Full quality-gate regression pass (AC: #15)
  - [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
  - [ ] `pnpm jscpd`
  - [ ] `pnpm docker:smoke`
  - [ ] Confirm Stryker mutation score on new logic meets ≥80% threshold (upgrade from DoD: ≥80% for Story 1.4, as this is the foundational security layer)
  - [ ] `pnpm audit --audit-level=high` — zero high/critical vulnerabilities

---

## Dev Notes

### Story Intent & What Already Exists

This story builds the foundational database layer that all subsequent stories depend on. The starting state is:

- `packages/db/src/schema/index.ts` — **empty** with a comment `// Empty schema — tables added in Story 1.4`
- `packages/db/src/index.ts` — **stub** `withOrg()` / `withOrgReadScope()` / `withAdminAccess()` functions that open a plain transaction without setting org context
- `packages/db/src/test-helpers.ts` — **stub** `withTestOrg()` that uses a fake `Tx` object
- `packages/db/src/migrations/` — **empty** (`.gitkeep` only)
- `packages/db/drizzle.config.ts` — already configured: schema at `./src/schema/index.ts`, output at `./src/migrations`

**Do not touch:** Fastify app, health/ready endpoints, Docker compose files, CI workflows (except adding the `check-rls` step), or any frontend code.

---

### ⚠️ Critical Conflict Resolution: Table Name Discrepancies

The epics document (Story 1.4 AC) and the architecture document use different canonical names for two tables. **The architecture document's Canonical Schema Entity Names table is the authoritative source. Use these names:**

| Epics doc name (Story 1.4) | Architecture canonical name | Use this |
|---|---|---|
| `organization_members` | `org_memberships` | ✅ `org_memberships` |
| `audit_events` | `audit_log_entries` | ✅ `audit_log_entries` |

**Rationale:** Architecture doc states *"Canonical Schema Entity Names (fixed — do not invent alternatives)"*. The epics story was written before the architecture naming elicitation completed. Using the architecture names now prevents a rename migration later when Stories 1.8, 1.11, and Epic 8 reference `org_memberships` and `audit_log_entries` by name.

**Reference:** `_bmad-output/planning-artifacts/architecture.md#Naming-Patterns` (the Canonical Schema Entity Names table).

> ⚠️ Any future epics story that references `organization_members` or `audit_events` should be treated as referring to `org_memberships` or `audit_log_entries` respectively.

---

### RLS Implementation — Critical Details

#### Why `SET LOCAL` not `SET`

`SET LOCAL "app.current_org_id" = '...'` scopes the setting to the current transaction. When the transaction ends (commit or rollback), the setting is automatically cleared. This is essential for connection pool safety — a connection pool reuses connections across requests, so a plain `SET` would leak the org context from Request A into Request B on the same connection.

```typescript
// CORRECT — transaction-scoped, safe for connection pools:
await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
// The third argument `true` to set_config() = is_local (same as SET LOCAL)

// WRONG — session-scoped, leaks across requests:
await tx.execute(sql`SET app.current_org_id = ${orgId}`)
```

#### Why `current_setting('app.current_org_id', true)` not without the second arg

The two-arg form returns `NULL` when the setting doesn't exist, instead of throwing an error. `NULL::uuid` is never equal to any `org_id`, so RLS blocks all rows when no org context is set — the safe default. The one-arg form throws `unrecognized configuration parameter`, which surfaces as an unhandled error instead of a clean "no rows returned" response.

#### RLS + Drizzle Schema Separation

Drizzle-kit does NOT auto-generate RLS DDL from schema definitions. You must:
1. Run `pnpm --filter @project-vault/db generate` to generate the schema DDL migration
2. Manually append the RLS `ALTER TABLE` and `CREATE POLICY` statements to the generated migration file
3. Commit the migration file — drizzle-kit tracks it via hash

This is the established pattern for RLS in Drizzle ORM 0.45.x. Do not attempt to use Drizzle's experimental RLS API — it is not stable in 0.45.x.

---

### Drizzle ORM 0.45.x Patterns

**Import path (ESM):** All imports use the `.js` extension in source:
```typescript
import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
```

**Transaction-first query pattern** (enforced by ESLint `no-bare-drizzle` rule from Story 1.2):
```typescript
// WRONG — bare Drizzle call, ESLint error:
await db.select().from(sessions).where(eq(sessions.orgId, orgId))

// CORRECT — always wrapped in withOrg():
await withOrg(orgId, (tx) =>
  tx.select().from(sessions).where(eq(sessions.orgId, orgId))
)
```

**Schema property to column name mapping:**
```typescript
// camelCase property → snake_case DB column (via .name())
createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
// Access as: row.createdAt in TypeScript, created_at in SQL
```

**UUID primary key with DB default:**
```typescript
id: uuid('id').primaryKey().defaultRandom()
// defaultRandom() maps to DEFAULT gen_random_uuid() in PostgreSQL
```

---

### File Locations Reference

| What | Where |
|---|---|
| Drizzle schema files | `packages/db/src/schema/*.ts` |
| Schema re-export | `packages/db/src/schema/index.ts` |
| Drizzle config | `packages/db/drizzle.config.ts` |
| Generated migrations | `packages/db/src/migrations/` |
| DB client + withOrg | `packages/db/src/index.ts` |
| Test helpers | `packages/db/src/test-helpers.ts` |
| Test seed script | `packages/db/src/seed-test.ts` |
| RLS coverage check | `scripts/check-rls-coverage.ts` (repo root) |
| RLS isolation test | `packages/db/src/__tests__/rls-isolation.test.ts` |
| Audit immutability test | `packages/db/src/__tests__/audit-log-immutability.test.ts` |

---

### `api_instances` Table Purpose

The `api_instances` table is required by the Architecture's multi-instance guard (see architecture.md lines ~296):

> "At startup, the API writes a heartbeat row to `api_instances (id uuid, started_at timestamptz, last_seen timestamptz)` and immediately queries `WHERE last_seen > now() - interval '30s' AND id != $currentInstanceId`. If any rows exist, another live instance is detected — emit `pino.error` and exit(1)."

This table is **not org-scoped** — it is a platform-level table. Do NOT add it to `orgScoped()` or create an RLS policy for it. The `check-rls-coverage.ts` script must exclude `api_instances` from the "all tables with org_id must have RLS" check (because it has no `org_id` column and none is needed).

The actual startup guard logic using this table is deferred to the story that wires up `apps/api/src/config.ts`. Story 1.4's responsibility is only to create the table in the migration.

---

### `user_identity_tokens` — PII Externalization Layer

This table is the schema mechanism that ensures audit logs never contain raw PII:
- Every audit event references `actor_token_id` (FK → `user_identity_tokens`) instead of `user_id` directly
- On user deletion (Story 4.3), `user_id` is set to NULL and `display_name` is pseudonymized
- The audit log row (`audit_log_entries`) never changes — only the identity token is updated
- This preserves HMAC integrity on audit rows while enabling GDPR right-to-erasure

**Not org-scoped:** `user_identity_tokens` is a platform-level identity table (one token per user, shared across orgs). Do NOT apply `orgScoped()` to it. Do NOT create an RLS policy for it.

---

### `AuditEvent` Constants — No Hardcoded Strings

The `event_type` column in `audit_log_entries` must always be populated from `AuditEvent` constants in `packages/shared/src/constants/audit-events.ts`. This file was established in Story 1.2 (see architecture.md lines 540–571 for the full registry). Hardcoded string literals as `event_type` values are a CI error (`eslint-plugin-security` rule + custom lint rule).

Example:
```typescript
// CORRECT:
import { AuditEvent } from '@project-vault/shared/constants/audit-events'
await tx.insert(auditLogEntries).values({ eventType: AuditEvent.SESSION_CREATED, ... })

// WRONG — hardcoded string, ESLint error:
await tx.insert(auditLogEntries).values({ eventType: 'session_created', ... })
```

---

### Testing Standards for This Story

**Integration test setup:**
- Integration tests require a real PostgreSQL connection — use `DATABASE_URL` from environment or `.env.test`
- All integration tests use `withTestOrg()` from `@project-vault/db/test-helpers` as the fixture harness
- Tests run via `pnpm --filter @project-vault/db test`
- Vitest config: `packages/db/vitest.config.ts` (already exists, do not create a new one)

**Running tests against Docker PostgreSQL:**
```bash
# Start the DB container first:
docker compose up db -d
# Then run tests:
DATABASE_URL=postgresql://postgres:password@localhost:5432/project_vault pnpm --filter @project-vault/db test
```

**No mocks for the DB layer:** The Architecture document and Definition of Done both require "Integration tests cover all API endpoints and database interactions using a real test database (no mocks for DB layer)."

**Mutation score requirement:** ≥80% (updated from ≥60% nightly gate — this is a security-critical story; the mutation gate applies to `withOrg()`, `withTestOrg()`, and `check-rls-coverage.ts`).

---

### Previous Story Intelligence (from Story 1.3)

- Story 1.3 (in-progress) closes Docker/health gaps: image size enforcement, multi-arch CI, CORS test, docker-compose.prod.yml corrections. It does NOT touch `packages/db` at all.
- `apps/api/src/main.ts` wires a real `dbPool` into `createApp()` for the `/ready` health check — Story 1.4 must not change `main.ts` or the `dbPool` wiring. The existing `postgres.js` pool in `packages/db/src/index.ts` is a separate singleton from the one used in `main.ts` for health checks.
- The `no-bare-drizzle` ESLint rule that flags direct Drizzle calls outside `db.transaction()` was established in Story 1.2. It applies to all new query code in Story 1.4.
- The `packages/db` package already builds cleanly (`turbo build` passes). Do not break this — run `pnpm --filter @project-vault/db typecheck` after every schema change.

---

### Git Intelligence

Recent commits: `feat(setup): story 1.2 configure backend` → `fix(setup): fix security warnings` → `fix(setup): fix workflow` (merged via PR #1, 2026-06-24).

The two `fix(setup)` commits after Story 1.2 suggest CI/workflow iteration — double-check `.github/workflows/ci.yml` when adding the `check-rls` step to avoid introducing drift.

---

### Project Structure Notes

- Alignment with monorepo: all DB work stays in `packages/db/`. No schema definitions in `apps/api/`.
- `packages/db` is the single source of truth for database schema and RLS policy definitions per Architecture doc.
- Schema types are inferred from Drizzle schema at compile time — no separate type generation step.
- The `@project-vault/db` package exports from `dist/` — rebuild after schema changes: `pnpm --filter @project-vault/db build`.
- `packages/crypto` depends on `packages/db` for schema types of encrypted fields — ensure the build order is correct (db builds before crypto).

---

### References

- Story user story & ACs: [Source: _bmad-output/planning-artifacts/epics.md#Story-1.4-Database-Foundation-with-PostgreSQL-RLS--Core-Schema]
- Canonical table names (authoritative): [Source: _bmad-output/planning-artifacts/architecture.md#Naming-Patterns — Canonical-Schema-Entity-Names]
- RLS implementation pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Data-Architecture — Row-Level-Security]
- db.transaction() as only permitted access pattern: [Source: _bmad-output/planning-artifacts/architecture.md#Data-Architecture]
- `api_instances` heartbeat requirement: [Source: _bmad-output/planning-artifacts/architecture.md#Data-Architecture — Tier-Limit-Cache (~line 296)]
- `user_identity_tokens` PII externalization: [Source: _bmad-output/planning-artifacts/epics.md#Story-1.4 AC; _bmad-output/planning-artifacts/architecture.md#Audit-Log-PII]
- `orgScoped` helper convention: [Source: _bmad-output/planning-artifacts/epics.md#Story-1.4 AC]
- `check-rls-coverage.ts` requirement: [Source: _bmad-output/planning-artifacts/epics.md#Story-1.4 AC; line 1833 cross-reference for audit_log_entries]
- `rls-isolation.test.ts` requirement: [Source: _bmad-output/planning-artifacts/epics.md#Story-1.4 AC; line 250 multi-org RLS correctness requirement]
- AuditEvent constants registry: [Source: _bmad-output/planning-artifacts/architecture.md#Naming-Patterns — Audit-Log-Event-Type-Registry]
- jscpd schema exclusion: [Source: _bmad-output/planning-artifacts/epics.md#Story-1.1-jscpd-Scope-section (~line 635)]
- Previous story intelligence: [Source: _bmad-output/implementation-artifacts/1-3-docker-deployment-and-health-endpoints.md#Previous-Story-Intelligence]
- Drizzle ORM version: 0.45.x [Source: _bmad-output/planning-artifacts/architecture.md#Data-Architecture; packages/db/package.json]
- Current repo starting state: [Source: packages/db/src/schema/index.ts, packages/db/src/index.ts, packages/db/src/test-helpers.ts]

---

## Dev Agent Record

### Agent Model Used

_to be filled by dev agent_

### Debug Log References

_to be filled by dev agent_

### Completion Notes List

- [ ] Conflict resolution applied: `org_memberships` used (not `organization_members`); `audit_log_entries` used (not `audit_events`) — per Architecture canonical naming
- [ ] `packages/db/src/schema/` manually reviewed for copy-paste duplication (jscpd DoD gate)
- [ ] Migration idempotency verified: `db:migrate` run twice, second run produces no changes
- [ ] RLS isolation test passes with real PostgreSQL
- [ ] `check-rls-coverage.ts` CI step added to `.github/workflows/ci.yml`
- [ ] Stryker mutation score ≥80% on `withOrg()`, `withTestOrg()`, and `check-rls-coverage.ts`

### File List

_to be filled by dev agent — list every file created or modified_
