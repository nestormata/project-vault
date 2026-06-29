# Story 2.2: Credential Storage & Retrieval with Version History

Status: done

<!-- Ultimate context engine analysis completed 2026-06-27 - comprehensive developer guide for the first durable secret-storage backend. This story introduces the credentials + credential_versions tables, AES-256-GCM value encryption via packages/crypto, the value-reveal endpoint with mandatory audit, version history, and a pg-boss retention/cryptographic-deletion job. -->

## Story

As a developer storing secrets in a project,
I want to create credentials with metadata, retrieve their current value, and access full version history with configurable retention,
so that I always have the current secret value and can audit or roll back to any previous version within the retention window.

*Covers: FR10, FR11, FR12, FR96, FR105.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.2-Credential-Storage--Retrieval-with-Version-History`]

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 2.1 (`projects` + `project_memberships` tables, its projects migration) is merged | Credentials are project-scoped (`credentials.project_id → projects.id`). This story's credentials migration builds on Story 2.1's projects migration. Run `pnpm --filter @project-vault/db migrate` first. (See R1 below for the actual numbers — do NOT hardcode.) |
| Story 1.11 `SecureRoute` framework is merged and passing CI | All four new credential routes must use `secureRoute()`. The route-audit CI gate (`route-audit.test.ts`) requires every route be classified. |
| Story 1.5 vault init/unseal + `packages/crypto` are merged | Value encryption uses `encrypt()` + `getPrimaryKey()`; decryption uses `withSecret()`. The vault must be unsealed for any credential value operation. |
| Story 1.4 audit log foundation (`audit_log_entries`, `user_identity_tokens`, `vault_state.audit_key_version`) exists | The reveal endpoint and retention job write **per-row keyed-HMAC** audit rows via the SecureRoute default audit writer / `computeAuditHmac` (canonical-JSON HMAC-SHA256 over each row's fields, keyed by the audit key). **There is no prev-row hash chaining in current Epic 1 reality** — `computeAuditHmac` takes only the row's own fields, not a previous HMAC. If cryptographic chaining is ever wanted it must be added intentionally (Epic 8 territory), not assumed here. |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | ⚠️ On the current branch the highest migration is **`0012_refresh_tokens_org_id.sql`** (`packages/db/src/migrations/meta/_journal.json` last entry, idx 12) — `projects` is **not yet added**. Story 2.1 will therefore land as **`0013_projects.sql`**, making **this story's migration `0014_credentials.sql`**. Before generating, run a fresh check of `packages/db/src/migrations/` and `meta/_journal.json` and use the **next free number after whatever Story 2.1 actually committed** (do not assume 0013 is still free if 2.1 has merged — re-read the journal). Every `0012`/`0013_credentials` reference elsewhere in this doc is an illustrative placeholder — substitute the real number. |
| Migration ordering guard (R1) | The credentials migration (`0014_credentials.sql`, or whatever number it takes) has an FK to `projects`; if it is applied before 2.1's projects migration, the `CREATE TABLE credentials … REFERENCES projects` fails mid-migration. Do not merge/deploy this story's migration until 2.1's projects migration is present and ordered earlier in `meta/_journal.json`. Add a CI/ordering check (or a manual gate) confirming the `projects` table/migration exists and precedes the credentials migration in the journal before it runs. |

---

## Epic Cross-Story Context

| Story | Relationship to 2.2 |
|---|---|
| 1.4 | Established Drizzle schema conventions (`orgScoped()`, snake_case tables, RLS policy in same migration, `withTestOrg()`/`withOrg()` for RLS-active tests). 2.2 follows them exactly. |
| 1.5 | Provides `encrypt()`, `withSecret()`, `getPrimaryKey()`, `getAuditKey()`, and the vault `unsealed` lifecycle. Credential values are encrypted with the **primary** key; the vault guard (`plugins/vault-guard.ts`) already returns `503` for every credential route while sealed. |
| 1.10 | Established the pg-boss worker pattern (`workers/*.ts`, `runPruneJob`, `withJobLogging`) and operational logging. The retention job follows this pattern. |
| 1.11 | Provides `secureRoute()`, `SecureRouteContext`, RLS middleware (`setRlsOrgContext`), the default audit writer, `runOrgScopedJob()`, and the `route-audit.test.ts` + `ROUTE_ACTION_CLASSIFICATIONS` CI gate. All four routes go through this framework; the retention job uses `runOrgScopedJob()`. |
| 2.1 | Created `projects`/`project_memberships` and the dashboard schema. Its `RecentAccessEventSchema` already declares the `credential.value_revealed` / `credential.created` / `credential.updated` event types, and `credentialStats` is wired to count credentials by `projectId`. 2.2 must use the **`credentials` / `credential_versions`** table names (NOT the architecture's older `secrets` naming) to stay consistent. |
| 2.3 | Adds credential **search/list/filter** and tag management. 2.2 deliberately does NOT implement a list/search endpoint — only create, value-reveal, version-history, and add-version. The RS-E2a guard (never index `value`/`encrypted_value`) is introduced here at the schema level and enforced in CI in 2.3. |
| 2.4 | Adds dependent-system recording, `expiresAt`/`rotationSchedule` mutation, and the access list. 2.2 stores `expiresAt` and `rotationSchedule` columns on create but does not add the dependency or PATCH-lifecycle endpoints. |
| 5.x | Rotation creates new credential versions and locks the active version against retention deletion. 2.2 provides the `rotation_locked_at` exemption seam on `credential_versions` so the retention job already honors it; Epic 5 sets/clears it. |
| 8.x | The audit events written here (`credential.value_revealed`, `credential.created`, `credential.version_created`, `credential.version_purged`) are queryable once Epic 8's audit UI lands (PJ5). They MUST be written to `audit_log_entries` from day one with correct HMAC + key version. |

---

## Architecture Conflict Resolution (Read Before Coding)

The architecture document predates the epic refinement and uses older names/shapes. Where they differ, the **epic is authoritative** and Story 2.1 has already locked in the canonical names. Resolve every conflict as follows:

| Architecture wording | Canonical implementation for 2.2 | Rationale |
|---|---|---|
| Tables named `secrets` / `secret_versions` (`architecture.md#Data-Model`) | Use **`credentials`** and **`credential_versions`**. | Story 2.1's dashboard schema, `credentialStats`, and `credential.*` audit event names are already built on the `credential` noun. Renaming now would break 2.1's contracts. |
| Reveal endpoint `POST /api/v1/projects/:projectId/secrets/:secretId/reveal` → `{ revealedValue }` | Use **`GET /api/v1/projects/:projectId/credentials/:credentialId/value`** → `{ value, versionNumber, retrievedAt }`. | The epic explicitly specifies the GET `/value` contract and response shape. The audit-on-read side effect is intentional and supported by SecureRoute `writeAuditEvent` on a GET (see AC-4). |
| Cursor pagination envelope `{ data, meta: { nextCursor, hasMore } }` | Not relevant to 2.2 — no list endpoint here. Pagination arrives in Story 2.3. | 2.2 has no collection endpoint. |
| Fine-grained permissions `read:secret_value` vs `read:secret_metadata` (NFR-SEC9) | v1 maps these to **org roles**: metadata/version reads require `viewer`; value reveal and version creation require `member`. The *enforced* control for value access is the **mandatory per-reveal audit event**, not a distinct permission scope. | No fine-grained permission framework exists yet (same situation as Story 2.1 ADR-2.1-01). The permission split is deferred; the audit trail is the day-one guarantee. |
| `secret_versions` is "Immutable — no `updated_at`" | `credential_versions` has **no `updated_at` and no append-only trigger**. It is content-immutable in normal operation, but the retention job performs the single sanctioned UPDATE (cryptographic purge). | An append-only trigger (like `audit_log_entries`) would block the purge UPDATE. The purge is the only permitted mutation; everything else is insert-only. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| DB schema | `credentials` + `credential_versions` tables, both org-scoped with RLS in the credentials migration (next free number, e.g. `0014_credentials.sql` — see R1). `credential_versions` carries `rotation_locked_at` (retention exemption seam) and `purged_at` (crypto-deletion marker). |
| Create credential | `POST /…/credentials` encrypts the value with `packages/crypto`, stores ciphertext in `credential_versions` (version 1), returns metadata only — never the value. |
| Reveal value | `GET /…/credentials/:id/value` decrypts via `withSecret()`, returns `{ value, versionNumber, retrievedAt }`, and writes a `credential.value_revealed` audit row in the same transaction. |
| Add version | `POST /…/credentials/:id/versions` creates a new version (monotonic `versionNumber`), no value dedup. |
| Version history | `GET /…/credentials/:id/versions` returns `[{ versionNumber, createdBy, createdAt, isCurrent, purgedAt }]` — never any encrypted/decrypted value. |
| Retention | pg-boss daily job purges (value-zeroed + nulled) versions beyond `retentionCount` (default 3, min 1; **always keeps ≥1 live version**), skipping `rotation_locked_at` versions; writes `credential.version_purged` audit rows. Value-zeroing is defense-in-depth, **not** byte-erasure (see AC-8 MVCC caveat). |
| Security | `encrypted_value` never appears in any list/history/search response or any index. Vault-sealed → 503. Cross-org/cross-project access → 404. Reveal is **fail-closed on audit** (ADR-2.2-09). |
| Route audit | All four routes registered in `ROUTE_FILES` and `ROUTE_ACTION_CLASSIFICATIONS`; `route-audit.test.ts` passes. The `:projectId` param is declared in each route's `url`, not the plugin prefix (AC-9). The retention worker is added to `DIRECT_DB_ACCESS_CLASSIFICATIONS`. |
| Tests | Create, reveal (audit verified), add version, version history, retention enforcement, rotation-locked exemption, cross-org isolation, sealed-vault 503, audit-failure rollback (fail-closed reveal), version-conflict concurrency, cross-org write isolation, purged-top current-version handling. |
| Operational metrics/logging | Reveal attempt/success/failure signals, audit-write-failure signal, retention purged/dry-run/job-failure logs — never logging values (AC-11A). |
| Deployment / first destructive rollout | Dry-run-first, backup warning, forward-only migration revert note, migration-order gate, schedule-registration check (AC-11B). |

---

### AC-1: Database Schema — `credentials` Table

**Given** the Drizzle schema conventions in `packages/db/src/schema/`,
**When** Story 2.2 adds the `credentials` table,
**Then** create `packages/db/src/schema/credentials.ts` exactly as follows:

```typescript
import { pgTable, uuid, text, timestamp, integer, jsonb, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // tags stored as a JSONB string array; search/management lands in Story 2.3.
    tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // cron string validated at the API layer; full lifecycle handling is Story 2.4.
    rotationSchedule: text('rotation_schedule'),
    // Per-credential override of the version retention count (default applied in app layer).
    retentionCount: integer('retention_count').notNull().default(3),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index('idx_credentials_project_created').on(
      t.projectId,
      t.createdAt.desc()
    ),
    orgIdx: index('idx_credentials_org').on(t.orgId),
    retentionCheck: check('credentials_retention_count_check', sql`${t.retentionCount} >= 1`),
  })
)
```

**And** the table has **no `value` or `encrypted_value` column** — credential material lives ONLY in `credential_versions`. This is the RS-E2a invariant: no full-text/trigram index may ever include credential material, and no list/search response may include it. Adding such a column to `credentials` is a security regression.

**And** `orgScoped({ onDelete: 'cascade' })` is required so deleting an org cascades to its credentials, and so the standard `org_id = current_setting('app.current_org_id')` RLS policy applies (denormalized `org_id` even though `project_id` already carries it — see Story 2.1 ADR-2.1-05 for the uniform-RLS rationale).

**And** `retentionCount` defaults to `3` with a DB `CHECK (retention_count >= 1)` guard so the minimum-1 rule (FR105) cannot be violated at the data layer.

**And** export it from `packages/db/src/schema/index.ts`:
```typescript
export * from './credentials.js'
export * from './credential-versions.js'
```

---

### AC-2: Database Schema — `credential_versions` Table

**Given** every credential keeps an immutable version history with cryptographic deletion,
**When** Story 2.2 adds the `credential_versions` table,
**Then** create `packages/db/src/schema/credential-versions.ts`:

```typescript
// IMMUTABLE (insert-only) EXCEPT the retention cryptographic-purge UPDATE.
// No updated_at column and NO append-only trigger: the retention job must be able to
// overwrite encrypted_value with zeros and clear key_version (the only sanctioned mutation).
import { pgTable, uuid, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { credentials } from './credentials.js'
import type { EncryptedValue } from '@project-vault/crypto'

export const credentialVersions = pgTable(
  'credential_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    // EncryptedValue JSON: { version, iv, ciphertext, tag }. Nullable so the retention
    // purge can null it out after zeroing. NEVER returned by any list/history response.
    encryptedValue: jsonb('encrypted_value').$type<EncryptedValue | null>(),
    // The vault primary-key version in effect when this value was encrypted. Cleared on purge.
    keyVersion: integer('key_version'),
    // Monotonic per credential, assigned in the app layer under a row lock (see AC-3/AC-5).
    versionNumber: integer('version_number').notNull(),
    // Retention exemption seam: when non-null, this version is locked by an in-progress or
    // stale-recovery rotation (Epic 5) and is exempt from retention deletion. Null in 2.2.
    rotationLockedAt: timestamp('rotation_locked_at', { withTimezone: true }),
    // Set when the version's value has been cryptographically purged by the retention job.
    purgedAt: timestamp('purged_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Enforces version-number uniqueness per credential at the DB layer (prevents races).
    credVersionUnique: uniqueIndex('idx_credential_versions_unique').on(
      t.credentialId,
      t.versionNumber
    ),
    credVersionIdx: index('idx_credential_versions_cred').on(
      t.credentialId,
      t.versionNumber.desc()
    ),
  })
)
```

**And** the unique index `(credential_id, version_number)` is the authoritative guard against duplicate version numbers under concurrent inserts — the application also serializes via a row lock (AC-3), but the DB constraint is the backstop.

**And** `encryptedValue` and `keyVersion` are **nullable specifically to support cryptographic deletion**: the purge sets `encrypted_value = NULL` (after the zero-overwrite UPDATE, see AC-7) and `key_version = NULL`. A normal (non-purged) version always has both populated.

**And** there is **no `updated_at` column and no append-only trigger** on this table (unlike `audit_log_entries`). Document the single permitted mutation with the file-top comment shown above.

---

### AC-3: Credentials Migration (next free number, e.g. `0014_credentials.sql`) — Schema, RLS Policies, `updated_at` Trigger

> **Migration number is dynamic (R1).** Use the next free number after the journal tip *as it stands once Story 2.1's projects migration has merged*. On today's branch the tip is `0012_refresh_tokens_org_id`; with 2.1 landing `0013_projects`, this story is `0014_credentials.sql`. Always re-read `packages/db/src/migrations/meta/_journal.json` immediately before `drizzle-kit generate`. Every `0012_credentials.sql` mention below is an illustrative placeholder.

**Given** the RLS coverage check (`packages/db/src/check-rls-coverage.ts`) fails CI if any `org_id` table lacks an `ALL` policy,
**When** Story 2.2 creates the migration,
**Then** create `packages/db/src/migrations/<next>_credentials.sql` (e.g. `0014_credentials.sql`) that:

1. Creates both tables (`drizzle-kit generate` emits the `CREATE TABLE` statements — `credentials` MUST be created before `credential_versions` because of the FK).
2. Enables RLS and adds isolation policies for **both** tables in the **same migration file**.
3. Adds the `updated_at` auto-update trigger for `credentials` (NOT for `credential_versions`).

Required policy block (must appear in the migration):

```sql
ALTER TABLE credentials         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE credential_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY credentials_isolation
  ON credentials
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY credential_versions_isolation
  ON credential_versions
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- updated_at trigger for credentials (function defined in 0001). credential_versions
-- intentionally has NO updated_at and NO trigger — it is insert-only plus the purge UPDATE.
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**And** these are command-less (`ALL`) policies with no explicit `WITH CHECK` — this is intentional and matches the convention in `0001_rls_and_triggers.sql`: when `WITH CHECK` is omitted, PostgreSQL defaults it to the same expression as `USING`, so `INSERT`/`UPDATE` writes are checked against the same `org_id` condition as reads. This means a write attempting to set a foreign `org_id` (cross-org write) is rejected by RLS. Do **not** add a separate `FOR INSERT`/`FOR UPDATE` policy that would override this default. (A positive test for this write-isolation guard is required — see AC-12.)

**And** after adding the migration, run `pnpm --filter @project-vault/db check-rls` to confirm no coverage gap, then `pnpm --filter @project-vault/db migrate` locally.

**Critical:** Do NOT add `credentials` or `credential_versions` to `EXCLUDED_TABLES` in `check-rls-coverage.ts`. Both are org-scoped and MUST have RLS.

**And** do NOT add an append-only trigger to `credential_versions` — it would block the retention purge UPDATE (AC-7).

---

### AC-4: POST /api/v1/projects/:projectId/credentials — Create Credential

**Given** a project exists and the caller has at least `member` org role,
**When** they call `POST /api/v1/projects/:projectId/credentials`,
**Then** create the credential and its first version (version 1) in one transaction, encrypting the value with `packages/crypto`.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/credentials
Content-Type: application/json
Cookie: access-token=<jwt>

{
  "name": "Stripe Secret Key",
  "value": "EXAMPLE_CREDENTIAL_VALUE_redacted_not_a_real_key",
  "description": "Production Stripe API secret",
  "tags": ["payments", "third-party"],
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "rotationSchedule": "0 0 1 * *"
}
```

**Successful response (`201 Created`) — metadata only, NEVER the value:**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000100",
    "projectId": "00000000-0000-4000-8000-000000000010",
    "orgId": "00000000-0000-4000-8000-000000000002",
    "name": "Stripe Secret Key",
    "description": "Production Stripe API secret",
    "tags": ["payments", "third-party"],
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "rotationSchedule": "0 0 1 * *",
    "retentionCount": 3,
    "currentVersionNumber": 1,
    "createdBy": "00000000-0000-4000-8000-000000000001",
    "createdAt": "2026-06-27T20:00:00.000Z",
    "updatedAt": "2026-06-27T20:00:00.000Z"
  }
}
```

**And** encryption uses the vault primary key, and the plaintext is zeroed immediately. Read the key version from `vault_state`:

```typescript
import { encrypt } from '@project-vault/crypto'
import { getPrimaryKey } from '../../vault/key-service.js'
import { vaultState } from '@project-vault/db/schema'

// 1. Read current primary key version for this ciphertext (parallels currentAuditKeyVersion()).
const [vs] = await tx.select({ keyVersion: vaultState.keyVersion }).from(vaultState).limit(1)
const keyVersion = vs?.keyVersion ?? 1

// 2. Encrypt. getPrimaryKey() returns a COPY — zero it after use. The vault guard guarantees
//    the vault is unsealed for this route, so getPrimaryKey() will not throw here.
const plaintext = Buffer.from(body.value, 'utf8')
const key = getPrimaryKey()
let encryptedValue
try {
  encryptedValue = await encrypt(plaintext, key)
} finally {
  plaintext.fill(0)
  key.fill(0)
}

// 3. Insert credential, then version 1 — both in the SecureRoute-provided tx.
const [credential] = await tx
  .insert(credentials)
  .values({
    orgId: auth.orgId,
    projectId: params.projectId,
    name: body.name,
    description: body.description ?? null,
    tags: body.tags ?? [],
    expiresAt: body.expiresAt ?? null,
    rotationSchedule: body.rotationSchedule ?? null,
    createdBy: auth.userId,
  })
  .returning()

await tx.insert(credentialVersions).values({
  orgId: auth.orgId,
  credentialId: credential.id,
  encryptedValue,
  keyVersion,
  versionNumber: 1,
  createdBy: auth.userId,
})
```

**And** the request body is validated with Zod `.strict()` (reject unknown keys → `422`). `orgId`, `projectId` (it comes from the URL), `id`, and any `value`-adjacent field must NOT be acceptable body inputs beyond `value` itself.

**And** the project must exist within the caller's org. Because RLS scopes the transaction, verify the project before inserting — if the project does not exist in the caller's org, return `404 { code: "project_not_found", message: "Project not found" }` (do not distinguish "wrong org" from "missing" — prevents enumeration, same as Story 2.1 AC-7).

**And** `value` is required and must be a non-empty string (1–65536 chars). `name` is required (1–256 chars). `tags` is an optional `string[]` (each ≤50 chars, ≤20 items — full tag management is Story 2.3, but enforce the bounds now). `expiresAt` is an optional ISO datetime. `rotationSchedule` is an optional cron string validated for basic 5-field shape; a malformed cron returns `422 { code: "invalid_cron" }` (full cron semantics handled in Story 2.4 — here, validate structure only).

**And** the SecureRoute security + audit capture the **new credential's id** (a POST has no id in the URL params, so use the custom-`auditWriter` stash pattern established in Story 2.1 AC-4):

```typescript
security: {
  minimumRole: 'member',
  requireMfa: false,
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'POST /api/v1/projects/:projectId/credentials' },
  writeAuditEvent: { eventType: 'credential.created', resourceType: 'credential' },
}
// In handler after insert:
;(req as unknown as { auditResource?: { id: string } }).auditResource = { id: credential.id }
// Custom auditWriter reads stash → resourceId = credential.id, payload = { name } (NOT the value).
```

**And** the audit payload MUST NOT contain `value` (the SecureRoute `FORBIDDEN_AUDIT_KEYS` sanitizer already strips `value`, but never place it there in the first place). Payload may include `name` and `projectId` only.

---

### AC-5: POST /api/v1/projects/:projectId/credentials/:credentialId/versions — Add Version

**Given** a credential exists,
**When** the caller (≥ `member`) posts a new value,
**Then** create a new version with the next `versionNumber`. Duplicate values are explicitly allowed (no dedup).

**Request:**
```http
POST /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/versions
Content-Type: application/json

{ "value": "EXAMPLE_ROTATED_VALUE_redacted_not_a_real_key" }
```

**Successful response (`201 Created`):**
```json
{ "data": { "credentialId": "00000000-0000-4000-8000-000000000100", "versionNumber": 2, "createdAt": "2026-06-27T21:00:00.000Z" } }
```

**And** the next version number is computed under a row-level lock to prevent two concurrent inserts from picking the same number:

```typescript
// Lock the parent credential row for the duration of the tx (advisory alternative also fine).
const [cred] = await tx
  .select({ id: credentials.id })
  .from(credentials)
  .where(and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId)))
  .for('update')
  .limit(1)
if (!cred) return reply.status(404).send({ code: 'credential_not_found', message: 'Credential not found' })

const [{ max }] = await tx
  .select({ max: sql<number>`COALESCE(MAX(${credentialVersions.versionNumber}), 0)` })
  .from(credentialVersions)
  .where(eq(credentialVersions.credentialId, params.credentialId))
const nextVersion = Number(max) + 1
// encrypt + insert as in AC-4, with versionNumber: nextVersion
```

**And** if two requests still race past the lock (e.g., separate transactions), the `(credential_id, version_number)` unique index throws `23505`; catch it and return `409 { code: "version_conflict" }` so the client can retry.

**And** creating a version with a value identical to an existing version is **allowed** — the system never deduplicates values (epic requirement). Do not add any equality check.

**And** the security config:
```typescript
security: {
  minimumRole: 'member',
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'POST …/credentials/:credentialId/versions' },
  writeAuditEvent: { eventType: 'credential.version_created', resourceType: 'credential', resourceIdFromParams: 'credentialId' },
}
```

---

### AC-6: GET /api/v1/projects/:projectId/credentials/:credentialId/value — Reveal Current Value

**Given** the caller has at least `member` role,
**When** they call the value endpoint,
**Then** decrypt the **current** (highest, non-purged) version via `withSecret()` and return it, writing a `credential.value_revealed` audit row in the **same transaction**.

**Request:**
```http
GET /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/value
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`):**
```json
{ "data": { "value": "EXAMPLE_CREDENTIAL_VALUE_redacted_not_a_real_key", "versionNumber": 1, "retrievedAt": "2026-06-27T22:00:00.000Z" } }
```

**And** decryption follows the ONE documented `Buffer → string` exception (architecture line ~592): the reveal path converts to a UTF-8 string inside the `withSecret` callback because the value flows directly into the HTTP response:

```typescript
import { withSecret } from '@project-vault/crypto'

const [version] = await tx
  .select({ versionNumber: credentialVersions.versionNumber, encryptedValue: credentialVersions.encryptedValue })
  .from(credentialVersions)
  .where(and(eq(credentialVersions.credentialId, params.credentialId), isNull(credentialVersions.purgedAt)))
  .orderBy(desc(credentialVersions.versionNumber))
  .limit(1)

if (!version || !version.encryptedValue) {
  return reply.status(404).send({ code: 'credential_not_found', message: 'Credential not found' })
}

// reveal path: Buffer→string permitted here (the one sanctioned conversion site)
const value = await withSecret(version.encryptedValue, async (plaintext) => plaintext.toString('utf8'))
return { data: { value, versionNumber: version.versionNumber, retrievedAt: new Date().toISOString() } }
```

**And** every successful reveal writes an audit event. Use SecureRoute `writeAuditEvent` on this GET (audit-on-read is intentional here):

```typescript
security: {
  minimumRole: 'member',
  rateLimit: { max: 120, timeWindowMs: 60_000, key: 'GET …/credentials/:credentialId/value' },
  writeAuditEvent: { eventType: 'credential.value_revealed', resourceType: 'credential', resourceIdFromParams: 'credentialId' },
}
```

The default audit writer records `actorTokenId` via `firstActorTokenIdForUser(tx, auth.userId)` (the `user_identity_token` reference, satisfying PJ6 — actor is a token, not raw identity), plus `ipAddress`, `keyVersion`, and the HMAC. The audit payload should include `{ versionNumber }` and MUST NOT include the value (use a custom `payload` resolver, or extend the writer to read a stashed `versionNumber`).

> **Audit-after-handler ordering note:** SecureRoute writes the audit row AFTER the handler returns, inside the same transaction. The reveal must therefore complete the decryption inside the handler and stash `versionNumber` (e.g., `(req as …).auditResource = { versionNumber }`) so the audit payload can record which version was revealed. If decryption fails, the handler throws and no audit row is written — a failed reveal is not an audit event.

**And** if the vault is sealed, the request never reaches the handler: `plugins/vault-guard.ts` returns `503 { status: "sealed" }`. Add an integration test asserting this.

**And** a credential whose only versions are all purged (no non-purged version with a non-null `encryptedValue`) returns `404` — there is no current value to reveal.

---

### AC-7: GET /api/v1/projects/:projectId/credentials/:credentialId/versions — Version History

**Given** the caller has at least `viewer` role,
**When** they request version history,
**Then** return version metadata ordered newest-first — NEVER any encrypted or decrypted value.

**Successful response (`200 OK`):**
```json
{
  "data": {
    "items": [
      { "versionNumber": 2, "createdBy": "00000000-0000-4000-8000-000000000001", "createdAt": "2026-06-27T21:00:00.000Z", "isCurrent": true,  "purgedAt": null },
      { "versionNumber": 1, "createdBy": "00000000-0000-4000-8000-000000000001", "createdAt": "2026-06-27T20:00:00.000Z", "isCurrent": false, "purgedAt": null }
    ]
  }
}
```

**And** the query selects ONLY `versionNumber`, `createdBy`, `createdAt`, `purgedAt` — `encryptedValue` and `keyVersion` are never selected into the response. `isCurrent` is computed as `versionNumber === MAX(non-purged versionNumber)`.

**And** purged versions ARE listed (their `versionNumber` and `createdAt` survive the crypto purge — only the value is destroyed) with `purgedAt` set, so the UI can show "value purged by retention policy". A purged version is never `isCurrent`.

**And** if the credential does not exist in the caller's org+project, return `404`.

**And** security: `minimumRole: 'viewer'`, `writeAuditEvent: false` (read-only metadata, classified in `ROUTE_ACTION_CLASSIFICATIONS`).

---

### AC-8: Version Retention — Cryptographic Deletion Job (FR105)

**Given** versions accumulate over time,
**When** the daily retention job runs,
**Then** for each credential, versions beyond `retentionCount` (default 3, min 1) — counting from the newest — are **cryptographically deleted**, EXCEPT versions with a non-null `rotation_locked_at`.

**Cryptographic deletion semantics (exact):**
1. Overwrite `encrypted_value` with a zero-filled `EncryptedValue` (zeroed `iv`/`ciphertext`/`tag` hex strings) via `UPDATE`, then set `encrypted_value = NULL`, `key_version = NULL`, `purged_at = now()`.
2. The row itself is **retained** (version history integrity) — only the value material is destroyed.
3. Write a `credential.version_purged` audit row (actor `system`, `actorTokenId = null`, payload `{ credentialId, versionNumber }`) in the same transaction as the purge.

> **MVCC / durability caveat (do not over-claim shredding):** Under PostgreSQL MVCC the zero-overwrite `UPDATE` does **not** scrub the ciphertext bytes in place — it writes a new tuple and leaves the prior tuple as dead row data until `VACUUM`, and the old ciphertext can also persist in the WAL and in any existing base backups. Therefore the column-zeroing in step 1 is **defense-in-depth and intent-signaling**, not a hard guarantee of byte-level erasure. The actual cryptographic-deletion guarantee for fully retired key material comes from **destroying the encryption key on master-key rotation** (Epic 5+), after which any lingering ciphertext is unrecoverable. Write the worker to perform the zero-overwrite, but do not document or test it as a guarantee that the bytes are physically gone from storage.

**Worker file `apps/api/src/workers/prune-credential-versions.ts`:**
- Follows the Story 1.10 pattern. Iterate orgs via `getDb().select … from(organizations)` then `runOrgScopedJob(orgId, 'credentials:prune-versions', async ({ tx }) => { … })` so the purge UPDATE and audit insert run RLS-scoped per org (mirrors `check-failed-auth-threshold.ts`).
- For each credential in the org: select non-purged, non-rotation-locked versions ordered `versionNumber DESC`, skip the first `retentionCount`, purge the rest.
- **Keep-≥-1 invariant (F1):** never purge the single highest non-purged version of a credential. Even if `retentionCount` somehow resolves to `0` (it cannot via the DB CHECK, but guard defensively), the newest live version is always retained. Assert `kept ≥ 1` before issuing any purge `UPDATE`.
- **Short-transaction batching (F7):** do NOT purge an entire org's credentials inside one long-held transaction. Process per credential (or in bounded chunks) so the purge `UPDATE`s and audit inserts hold row locks only briefly and never block concurrent reveals/add-version. Document the batch boundary in the worker.
- A version with `rotation_locked_at IS NOT NULL` is **never** counted toward the retained set nor purged — it is fully exempt until Epic 5 clears the lock.
- Log `job.completed` / `job.failed` operational events via the worker logger; never log credential values.

**Schedule + registration in `apps/api/src/main.ts`** (inside `startBossAndRegisterWorkers`, alongside the existing schedules):
```typescript
await boss.registerSchedules({ /* …existing… */ 'credentials:prune-versions': { cron: '0 3 * * *' } })
await boss.registerWorkers({ /* …existing… */ 'credentials:prune-versions': (job) =>
  withJobLogging(fastify.log, 'credentials:prune-versions', job.id ?? 'unknown', () => pruneCredentialVersions()),
})
```

**And** the worker reads from `getDb()` directly (background context) — add it to `DIRECT_DB_ACCESS_CLASSIFICATIONS` in `route-exemptions.ts`:
```typescript
{ path: 'workers/prune-credential-versions.ts', classification: 'platform-job',
  reason: 'Cryptographically purges expired credential versions per org via runOrgScopedJob; org-scoped writes.',
  reviewer: 'api-security-reviewer' }
```

**And** `retentionCount` is read per credential (the `credentials.retention_count` column, default 3). The retention default and minimum (1) are enforced by the AC-1 `CHECK` constraint; the job trusts the column value.

> **Vault state note:** The purge writes audit rows, which requires `getAuditKey()` → the vault must be unsealed. Because pg-boss workers only start after unseal (`setOnVaultUnsealed` in `main.ts`), the job never runs while sealed. No extra guard is needed, but the job MUST surface a clear error (not silently skip audit) if `getAuditKey()` throws.

> **Concurrency model (reveal/add-version vs. retention purge) — Path A, optimistic, no added locking:** The retention job runs concurrently with live reveal and add-version requests. No lock coordination between the purge and the endpoints is needed, because the rows they touch are **disjoint by construction**:
> 1. **Keep-≥-1 + purge-only-beyond-`retentionCount` (≥1):** the purge never targets the current (highest non-purged) version, so a reveal of the current value and a purge of an older version never touch the same row.
> 2. **Atomic reveal read:** the reveal selects `versionNumber` and `encryptedValue` in a single `SELECT`; it holds a consistent, valid ciphertext in memory and can decrypt it even if a purge commits immediately afterward. (Under READ COMMITTED this is race-free.)
> 3. **Add-version vs. purge:** add-version inserts a *new* highest version and never collides with the purge, which only nulls *old* rows' values and never changes `MAX(version_number)`.
>
> **Do NOT add a parent-credential `FOR UPDATE` lock to the purge.** It would contradict the F7 short-transaction requirement and guards a race that cannot occur given the invariants above. The add-version row lock (ADR-2.2-06) is only for serializing *concurrent add-version* requests with each other, not against the purge.

#### Operational Risks & Mitigations (retention worker)

| Risk | Why it matters | Required mitigation |
|---|---|---|
| **R3 — Retention job silently never runs** | If the `boss.registerSchedules`/`registerWorkers` entry is omitted, mistyped, or throws at startup, versions accumulate forever with no signal. | Add a startup/integration test asserting `credentials:prune-versions` is registered in both the schedules and workers maps. Emit `job.completed` on each run so its **absence** can alarm (monitoring lands in Epic 8). |
| **R11 — The purge is irreversible** | A logic bug in the keep-set computation permanently destroys credential values; keep-≥-1 + tests reduce but do not eliminate first-run risk. | Implement the worker with a **`PRUNE_DRY_RUN` (log-only) mode** for initial rollout: it logs `{ orgId, credentialId, versionNumber }` it *would* purge without mutating, so operators can verify the keep-set before enabling destructive mode. Default destructive in tests; gate production first-run behind the flag. Explicitly document that the purge cannot be undone. |
| **R12 — No observability of purge volume** | Operators cannot distinguish "retention working" from "runaway purge" or "no-op". | The worker logs one structured summary per run: `{ orgId, credentialsScanned, versionsPurged }` (Story 1.10 logger). NEVER log credential values. |

---

### AC-9: Route Registration and Audit Classification

**Given** the route-audit CI gate reads `ROUTE_FILES` and `ROUTE_ACTION_CLASSIFICATIONS`,
**When** Story 2.2 adds the credentials module,
**Then**:

1. Create `apps/api/src/modules/credentials/routes.ts` exporting `async function credentialRoutes(fastify: FastifyApp): Promise<void>`.
2. Register in `apps/api/src/app.ts` AFTER the projects module. **Primary approach — declare the `:projectId` param in each route's `url`, NOT in the plugin prefix** (Fastify does not reliably populate `req.params` from a path parameter embedded in a *plugin prefix*):
```typescript
import { credentialRoutes } from './modules/credentials/routes.js'
await fastify.register(credentialRoutes, { prefix: '/api/v1/projects' })
// Inside credentialRoutes, each route's url carries the full sub-path, e.g.:
//   url: '/:projectId/credentials'
//   url: '/:projectId/credentials/:credentialId/value'
//   url: '/:projectId/credentials/:credentialId/versions'
```
> Match whatever Story 2.1's projects module did — inspect `apps/api/src/modules/projects/routes.ts` and follow the identical prefix convention. Only if 2.1 demonstrably registers a param-in-prefix (`prefix: '/api/v1/projects/:projectId/credentials'`) AND `req.params.projectId` is populated in its handlers may you mirror that style instead. When in doubt, prefer the param-in-`url` form above — it is the reliable default.
3. Add `modules/credentials/routes.ts` to `ROUTE_FILES` in `apps/api/src/__tests__/route-audit.test.ts` (typo here silently skips the file — run the test in isolation after).
4. Add all four routes to `ROUTE_ACTION_CLASSIFICATIONS` in `apps/api/src/lib/route-exemptions.ts`:
```typescript
'POST /api/v1/projects/:projectId/credentials': { action: 'mutation', auditEvent: 'credential.created' },
'POST /api/v1/projects/:projectId/credentials/:credentialId/versions': { action: 'mutation', auditEvent: 'credential.version_created' },
'GET /api/v1/projects/:projectId/credentials/:credentialId/value': { action: 'sensitive-read', auditEvent: 'credential.value_revealed' },
'GET /api/v1/projects/:projectId/credentials/:credentialId/versions': { action: 'read',
  auditOmissionReason: 'Version history returns metadata only; never any credential value.', reviewer: 'api-security-reviewer' },
```
> Note the value endpoint is classified `sensitive-read` WITH an `auditEvent` — it is the canonical example of a read that must be audited. Confirm the route-audit test accepts a `GET` carrying an `auditEvent`; if its logic only expects `auditEvent` on mutations, extend the test's allow-list for `sensitive-read`.

5. **Add the `credential.*` audit event names to the shared audit-event typing and retire the stale `secret.*` names** (`packages/shared/src/constants/audit-events.ts`):

   That file's `AuditEventType` union still carries the **stale, never-emitted** `secret.*` members (`secret.created` / `secret.read` / `secret.updated` / `secret.deleted`) from the superseded architecture naming (ADR-2.2-01). Story 2.2 is where the canonical `credential.*` vocabulary fully lands, so:

   - **Add** all four event names to `AuditEventType`: `'credential.created'`, `'credential.version_created'`, `'credential.value_revealed'`, `'credential.version_purged'`. These are the exact strings used in `ROUTE_ACTION_CLASSIFICATIONS`, `writeAuditEvent`, and the retention worker — keep them byte-identical across the route classifications, the audit payloads, and this union.
   - **Remove the stale `secret.*` members** from `AuditEventType` (Story 2.1 may have already deprecated them; this story deletes them). Do NOT type any 2.2 audit event as `secret.*`. The Story 2.1 dashboard `RecentAccessEventSchema` already references `credential.value_revealed` / `credential.created` — they must match these constants exactly.
   - `route-exemptions.ts` types `auditEvent` loosely as `string`, so the route-audit CI gate passes regardless; the union update is for cross-package type consistency and to remove the misleading `secret.*` vocabulary entirely. After editing, run `pnpm --filter @project-vault/shared test` and `pnpm typecheck` to confirm nothing still references the removed `secret.*` names.

---

### AC-10: Shared & API Zod Schemas

**Given** response shapes the web app will later consume should live in `@project-vault/shared` (Story 2.1 precedent),
**When** Story 2.2 adds schemas,
**Then**:

**`packages/shared/src/schemas/credentials.ts` (NEW — web-consumed response schemas):**
```typescript
import { z } from 'zod/v4'

export const CredentialDetailSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  orgId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  expiresAt: z.iso.datetime().nullable(),
  rotationSchedule: z.string().nullable(),
  retentionCount: z.number().int().min(1),
  currentVersionNumber: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).meta({ id: 'CredentialDetail' })

export const CredentialValueSchema = z.object({
  value: z.string(),
  versionNumber: z.number().int().positive(),
  retrievedAt: z.iso.datetime(),
}).meta({ id: 'CredentialValue' })

export const CredentialVersionSummarySchema = z.object({
  versionNumber: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  isCurrent: z.boolean(),
  purgedAt: z.iso.datetime().nullable(),
}).meta({ id: 'CredentialVersionSummary' })

export type CredentialDetail = z.infer<typeof CredentialDetailSchema>
export type CredentialValue = z.infer<typeof CredentialValueSchema>
export type CredentialVersionSummary = z.infer<typeof CredentialVersionSummarySchema>
```
Add `export * from './schemas/credentials.js'` to `packages/shared/src/index.ts`.

**`apps/api/src/modules/credentials/schema.ts` (NEW — request schemas + response envelopes):**
```typescript
import { z } from 'zod/v4'
import { CredentialDetailSchema, CredentialValueSchema, CredentialVersionSummarySchema } from '@project-vault/shared'

const CRON_REGEX = /^(\S+\s+){4}\S+$/  // structural 5-field check only; full semantics in Story 2.4

export const CreateCredentialBodySchema = z.object({
  name: z.string().min(1).max(256).trim(),
  value: z.string().min(1).max(65536),               // value is NEVER trimmed (whitespace may be significant)
  description: z.string().max(1024).trim().nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  rotationSchedule: z.string().regex(CRON_REGEX, 'invalid_cron').nullable().optional(),
}).strict().meta({ id: 'CreateCredentialBody' })

export const AddVersionBodySchema = z.object({ value: z.string().min(1).max(65536) }).strict().meta({ id: 'AddVersionBody' })

export const CredentialParamsSchema = z.object({ projectId: z.uuid(), credentialId: z.uuid() }).meta({ id: 'CredentialParams' })
export const ProjectScopeParamsSchema = z.object({ projectId: z.uuid() }).meta({ id: 'ProjectScopeParams' })

export const CredentialDetailResponseSchema = z.object({ data: CredentialDetailSchema }).meta({ id: 'CredentialDetailResponse' })
export const CredentialValueResponseSchema = z.object({ data: CredentialValueSchema }).meta({ id: 'CredentialValueResponse' })
export const CredentialVersionListResponseSchema = z.object({
  data: z.object({ items: z.array(CredentialVersionSummarySchema) }),
}).meta({ id: 'CredentialVersionListResponse' })
```

**And** `value` must NOT be `.trim()`med — leading/trailing whitespace can be significant in secrets (e.g., a key with a trailing newline). Trimming would silently corrupt the stored secret.

**And** wire the response schemas to each route's `schema.response` so `@fastify/type-provider-zod` serializes correctly. Convert all Drizzle `Date` fields to ISO strings before sending (Story 2.1 "Timestamp serialization" note applies identically).

---

### AC-11: Security Hardening (Credential-Specific Invariants)

**Given** Project Vault is a secrets manager,
**When** Story 2.2 routes and the worker are implemented,
**Then** satisfy every invariant below:

| Threat | Required mitigation |
|---|---|
| Credential value leaks into a list/history/search response | `encrypted_value`/`key_version` are NEVER selected into any response except the dedicated `/value` reveal endpoint. Version history selects only metadata columns. Add an integration test that scans every non-reveal response body for the known plaintext and asserts absence. |
| Credential value indexed (RS-E2a) | No migration or Drizzle query adds `encrypted_value` (or any value column) to a full-text/trigram index. The `credentials` table has no value column at all. (CI lint enforcement lands in Story 2.3; the schema invariant starts here.) |
| Value logged | Never pass `value` into `req.log`/audit payload/operational logs. The SecureRoute `FORBIDDEN_AUDIT_KEYS` set already strips `value`; the `redact-secrets` plugin redacts response bodies — but never rely on redaction as the primary control: simply never put the value where it could be logged. |
| Plaintext lingers in memory | Encrypt path: zero the `plaintext` Buffer and the `getPrimaryKey()` copy in `finally`. Decrypt path: `withSecret()` zeros its buffer automatically; the only `Buffer→string` conversion is the reveal path, carrying the `// reveal path: Buffer→string permitted here` comment. |
| Cross-org / cross-project access | RLS scopes the tx by org; the handler additionally checks `credential.projectId === params.projectId`. Both "wrong org" and "missing" return `404` (no enumeration). |
| Reveal without audit | The reveal is audited in the same transaction (SecureRoute `writeAuditEvent`). If the audit write fails, the whole tx rolls back and the client gets `503 audit_write_failed` — the value is not returned without a recorded reveal (100% capture invariant). |
| Vault sealed | `plugins/vault-guard.ts` returns `503` for all credential routes while sealed; `withSecret()`/`getPrimaryKey()` also throw if reached while sealed. |
| Version-number race | `(credential_id, version_number)` unique index + `SELECT … FOR UPDATE` on the parent credential; `23505` → `409 version_conflict`. |
| Mass assignment | Both body schemas `.strict()`; Drizzle inserts use Zod-parsed output, never raw `req.body`. `orgId`/`projectId`/`id` never accepted from the body. |
| Retention destroys a rotation-active version | Versions with `rotation_locked_at IS NOT NULL` are fully exempt from the purge (Epic 5 seam). |

**Accepted residual risks (documented, not blocking):**

- **Plaintext lingers as a JS string (F5):** `body.value` arrives as an immutable JS string that cannot be zeroed; only the `Buffer.from(body.value)` copy is zeroed in `finally`. The string stage is an unavoidable residual exposure given the HTTP/JSON ingress. Mitigation: never log `body`, do not retain it beyond the encrypt call, and rely on GC. This is an accepted limitation, not a fix to attempt in 2.2.
- **Cron regex is shape-only (F8):** `CRON_REGEX` validates a 5-field structure only; a structurally-valid-but-semantically-garbage cron (e.g. `"a b c d e"`) is intentionally accepted and stored. Full cron semantic validation is deferred to Story 2.4. Document this so it is not mistaken for a validation bug.
- **Bulk exfiltration within the rate limit (R9):** a compromised `member` can reveal up to the rate-limit ceiling (120/min on the value route), each reveal audited but with **no automated anomaly detection** in 2.2. The audit trail is forensic, not preventive — `credential.value_revealed` events are emitted for later anomaly-detection consumption (a future epic). Accepted residual for v1.
- **`retrievedAt` vs audit `created_at` skew (R8):** `retrievedAt` in the reveal response uses the server `new Date()` while the audit row's `created_at` is DB-time; minor timestamp skew is possible. Acceptable for v1 (both are within the same request). If exactness is later required, derive both from a single source.

---

### AC-11A: Operational Metrics & Logging

**Given** Story 1.10 established the structured operational logger + metrics conventions, and credential reveal/retention are the most security-sensitive operations in Epic 2,
**When** Story 2.2 routes and the retention worker run,
**Then** emit the following structured operational signals (Story 1.10 logger; metric counters where the metrics surface exists). **NEVER log credential values, plaintext, `encrypted_value`, or key material in any of these.**

| Signal | Where | What to emit | Why |
|---|---|---|---|
| **Reveal attempt** | `GET …/credentials/:id/value` (entry) | structured log/counter `credential.reveal.attempt` with `{ orgId, credentialId, actorTokenId }` — never the value | Baseline volume for later anomaly detection (the audit row is forensic; this is operational). |
| **Reveal success** | reveal handler, after audit commit | `credential.reveal.success` `{ orgId, credentialId, versionNumber }` | Distinguish served reveals from attempts/failures. |
| **Reveal failure** | reveal handler/guard error paths | `credential.reveal.failure` `{ orgId, credentialId, reason }` where `reason ∈ { not_found, all_versions_purged, sealed_vault, audit_write_failed, decrypt_error }` | Operators must see *why* reveals fail without reading values. |
| **Audit-write failure (fail-closed)** | reveal + create + add-version | `credential.audit_write_failed` `{ orgId, eventType, resourceId }` when the same-tx audit write throws and the tx rolls back (client gets `503`) | This is the 100%-capture guarantee (ADR-2.2-09); its failures must be observable, not silent. |
| **Retention — versions purged** | retention worker, per run | one summary `{ orgId, credentialsScanned, versionsPurged }` (extends AC-8 R12) | Distinguish "retention working" from "runaway purge" / "no-op". |
| **Retention — dry-run counts** | retention worker in `PRUNE_DRY_RUN` mode | `{ orgId, credentialsScanned, versionsWouldPurge }` and per-candidate `{ orgId, credentialId, versionNumber }` it *would* purge — without mutating | Operators verify the keep-set before enabling destructive mode (AC-8 R11). |
| **Retention — job failure** | retention worker error path | `job.failed` for `credentials:prune-versions` with the error (Story 1.10 `withJobLogging`); on `getAuditKey()` throw, surface a clear error — never silently skip the audit | A silently-dead retention job (AC-8 R3) lets versions accumulate forever with no signal. |

**And** reveal `attempt` vs `success` vs `failure` must be separately countable so a spike of failures (e.g., decrypt errors after a bad key rotation) is distinguishable from normal reveal volume.

**And** these operational logs are **in addition to** the mandatory `credential.value_revealed` / `credential.version_purged` **audit** rows — operational logging never replaces the audit trail, and the audit trail never substitutes for operational observability.

**And** tests assert: (a) a forced audit-write failure emits `credential.audit_write_failed` and returns `503` with no value and no committed audit row; (b) the retention worker emits its per-run summary with correct `versionsPurged`; (c) dry-run mode emits `versionsWouldPurge` and mutates nothing.

---

### AC-11B: Deployment / Operations for First Destructive Retention Rollout

**Given** the retention purge is **irreversible** (AC-8 R11) and this story is the first time Project Vault destroys credential material on a schedule,
**When** the credentials migration and retention worker are deployed for the first time,
**Then** satisfy these operational guardrails:

| # | Requirement | Detail |
|---|---|---|
| O1 | **Dry-run-first rollout** | The retention worker ships with a `PRUNE_DRY_RUN` (log-only) mode (AC-8 R11). Production first-run MUST start in dry-run: it logs the keep-set / would-purge candidates (AC-11A) and mutates nothing. Destructive mode is enabled only after an operator verifies the dry-run output. Document the env flag / toggle and its default. Tests default to destructive; production defaults to dry-run for the first deploy. |
| O2 | **Backup warning before enabling destructive mode** | The deploy runbook / story completion notes MUST state, prominently, that enabling destructive retention permanently destroys version values beyond `retentionCount` and that a verified database backup should exist before the first destructive run. The purge cannot be undone (cross-reference AC-8 MVCC caveat: zeroing is defense-in-depth, not byte-erasure; true shredding is key-destruction at master-key rotation, Epic 5+). |
| O3 | **Forward-only migration / no down-migration** | The repo uses **forward-only** drizzle-kit migrations — there are no `down`/rollback files. If the credentials migration must be reverted, do it via a **new forward migration** (or restore from backup); never hand-author a down migration that diverges from `meta/_journal.json`. Record this in the rollout note. |
| O4 | **Migration-order gate** | Before the credentials migration runs in any environment, confirm the `projects` migration (Story 2.1) is present and ordered earlier in `meta/_journal.json` (R1 ordering guard). The credentials `… REFERENCES projects` FK fails mid-migration otherwise. Add a CI/ordering check or a documented manual gate that blocks deploy if `projects` is absent or ordered later. |
| O5 | **Schedule-registration verification** | Confirm `credentials:prune-versions` is registered in both the schedules and workers maps at startup (AC-8 R3). A startup/integration test asserts registration so the job cannot silently never run. |

**And** these deployment requirements are recorded in the story's completion notes (and, on completion, offered to `specs/` per the repo's spec-maintenance rule) so the first destructive rollout is a deliberate, reviewed action — not a side effect of merging the migration.

---

### AC-12: Integration & Unit Tests

> Follow repo TDD red-green (`AGENTS.md`): write failing tests first, confirm the failure reason, implement the smallest change, then re-run focused + broader checks.

**DB-layer RLS test — `packages/db/src/__tests__/credentials-rls-isolation.test.ts`** (pattern from Story 2.1 AC-12 / `rls-isolation.test.ts`):
- `credentials` and `credential_versions` rows are isolated by org (`withOrg(orgA)` cannot see orgB rows; a bare `getDb().select()` returns zero rows).
- `(credential_id, version_number)` uniqueness is enforced (duplicate insert rejects).
- **Write-isolation (RLS `WITH CHECK` default):** within `withOrg(orgA)`, an `INSERT` that tries to set `org_id = orgB` is rejected by RLS (proves the command-less `ALL` policy blocks cross-org writes, not just cross-org reads). This is the positive guard referenced in AC-3.

**API integration tests — `apps/api/src/modules/credentials/routes.test.ts`** (use `registerAndLoginViaApi` + `cookieHeader` from `apps/api/src/__tests__/helpers/auth-test-helpers.ts`; vault must be unsealed in the harness — reuse the existing vault test setup):

```
POST …/credentials
  - 201 creates credential + version 1; response has currentVersionNumber: 1 and NO value field
  - 201 stores ciphertext (assert credential_versions row exists with encrypted_value populated, keyVersion set)
  - 201 writes credential.created audit row with resourceId = new credential id and NO value in payload
  - 422 when value is missing / empty
  - 422 when body contains an unknown key (.strict)
  - 422 when rotationSchedule is a malformed cron
  - 404 when projectId does not exist in caller's org (and when it belongs to another org)
  - 401 when unauthenticated; 403 when caller is viewer
  - 503 when the vault is sealed (vault-guard)

GET …/credentials/:id/value
  - 200 returns { value, versionNumber, retrievedAt } with the exact stored plaintext
  - 200 writes a credential.value_revealed audit row (actorTokenId set, payload has versionNumber, NO value)
  - 200 returns the CURRENT (highest non-purged) version after a new version is added
  - 200 reveals the next LIVE version (not 500) when the newest version is purged (F2: purged-top must not call withSecret(null))
  - 404 when credential missing / wrong project / all versions purged
  - 403 when caller is viewer; 503 when vault sealed
  - AUDIT-FAILURE ROLLBACK (100% capture invariant): when the audit write is forced to fail
    (inject a failure in the audit writer / HMAC step), the whole tx rolls back, the client gets
    503 audit_write_failed, NO value is returned, and NO partial audit row is persisted. This is
    the single most important security guarantee for reveal — it must be explicitly tested.

POST …/credentials/:id/versions
  - 201 creates version 2 with monotonic versionNumber
  - 201 allows a value identical to an existing version (no dedup)
  - 404 when credential missing
  - 403 when viewer
  - VERSION-CONFLICT CONCURRENCY: two near-simultaneous add-version requests for the same
    credential do not produce duplicate versionNumbers — one succeeds (201) and, if the second
    races past the FOR UPDATE lock into the unique index, it returns 409 version_conflict
    (23505 mapped). Assert no duplicate (credential_id, version_number) row exists afterward.

GET …/credentials/:id/versions
  - 200 lists versions newest-first with isCurrent on the highest non-purged version
  - 200 NEVER includes encrypted_value / value in any item
  - 200 lists a purged version with purgedAt set and isCurrent: false
  - 200 when the NEWEST version is purged: isCurrent falls to the highest non-purged version, the purged top shows isCurrent:false (F3)
  - 404 when credential missing
```

**Retention worker tests — `apps/api/src/workers/prune-credential-versions.test.ts`:**
```
- prunes versions beyond retentionCount (default 3): with 5 versions, the oldest 2 are purged (encrypted_value NULL, keyVersion NULL, purgedAt set)
- respects per-credential retentionCount override (e.g., 1 → keeps only the newest)
- does NOT purge a version with rotation_locked_at set, even if it is beyond the retention window
- writes a credential.version_purged audit row per purged version (actorType system)
- a purged version is overwritten (encrypted_value no longer decryptable / is NULL)
- keep-≥-1 invariant (F1): the single highest non-purged version is NEVER purged, even with an extreme retentionCount edge case
- each credential.version_purged audit row carries the CORRECT org_id (F10): seed two orgs, run the job, assert each purge audit row is attributed to its own org (no cross-attribution, no empty org_id)
```

**Security regression test — value never leaks:** a single test that creates a credential with a known sentinel value, then calls every non-reveal endpoint (create response, version list, add-version response) and asserts the sentinel string appears in NONE of the response bodies.

**And** all tests run with RLS active (`withTestOrg()`/`withOrg()`); never assert row state from a bare `getDb()` query without org context (it silently returns zero rows and false-passes).

---

### AC-13: Explicit Out of Scope

Do NOT implement in Story 2.2:

- Credential **list / search / filter** endpoints, pagination, or tag management UI/API — Story 2.3 (the only tag handling here is storing the `tags` column on create with bounds validation).
- The RS-E2a **CI lint rule** (`scripts/check-search-index.ts`) — Story 2.3. (2.2 only upholds the schema invariant: no value column, no value index.)
- Dependent-system recording, `PATCH` of `expiresAt`/`rotationSchedule`, full cron semantics, or the credential **access list** — Story 2.4.
- Bulk import (Story 2.5), onboarding wizard (Story 2.6), global search (Story 2.7).
- Wiring real `credentialStats` counts into the Story 2.1 **project dashboard** — leave the dashboard counts as-is (the dashboard already computes `isEmpty` from counts; backfilling real credential counts is a small follow-up but not required by the 2.2 epic ACs). If you choose to wire it opportunistically, do it behind the existing dashboard query and keep all 2.1 dashboard tests green.
- A "get a specific OLD version's value" endpoint — 2.2 reveals only the **current** version. Roll-back/restore-to-version is a future story.
- Frontend / web UI for credentials — this story is backend + worker only. (A web credential UI arrives with later Epic 2 stories.)
- Master-key rotation / re-encryption of existing versions — `keyVersion` is stored per version for future rotation, but rotation itself is out of scope.
- Machine-user secret retrieval (Epic 7).

---

## Tasks / Subtasks

- [x] **Task 1: Database schema + credentials migration (next free number, e.g. `0014_credentials.sql`)** (AC: 1, 2, 3)
  - [x] Create `packages/db/src/schema/credentials.ts` and `credential-versions.ts`.
  - [x] Export both from `packages/db/src/schema/index.ts`.
  - [x] Run `pnpm --filter @project-vault/db generate`; confirm `CREATE TABLE credentials` precedes `credential_versions`.
  - [x] Add RLS policies for both tables + `updated_at` trigger for `credentials` only to the migration.
  - [x] Run `pnpm --filter @project-vault/db check-rls` (no gap) and `migrate` (applies cleanly).
- [x] **Task 2: Shared + API schemas** (AC: 10)
  - [x] Create `packages/shared/src/schemas/credentials.ts`; add to `packages/shared/src/index.ts`; `pnpm --filter @project-vault/shared test`.
  - [x] Create `apps/api/src/modules/credentials/schema.ts` with request schemas (`.strict()`), cron + value rules (value NOT trimmed), and response envelopes.
  - [x] Unit-test value/cron/tag bounds and `.strict()` rejection.
- [x] **Task 3: DB-layer RLS isolation test** (AC: 12) — write `credentials-rls-isolation.test.ts` and confirm it fails before the schema exists, passes after.
- [x] **Task 4: POST create credential** (AC: 4, 9, 11) — failing test first; implement encrypt (zero buffers) + version-1 insert + project existence 404 + custom audit writer capturing new id.
- [x] **Task 5: POST add version** (AC: 5, 9, 11) — failing test first; `FOR UPDATE` lock + MAX+1 + `23505 → 409`; no dedup.
- [x] **Task 6: GET reveal value** (AC: 6, 9, 11) — failing test first; `withSecret` reveal-path conversion; audited GET; sealed-vault 503; all-purged 404.
- [x] **Task 7: GET version history** (AC: 7, 9) — failing test first; metadata-only select; `isCurrent` + `purgedAt`; value-leak regression test.
- [x] **Task 8: Retention worker + operational signals** (AC: 8, 11A, 11B, 12) — failing worker test first; `runOrgScopedJob` purge with overwrite-then-null + `credential.version_purged` audit; rotation-locked exemption; `PRUNE_DRY_RUN` (log-only) mode with `versionsWouldPurge` logging; per-run `{ orgId, credentialsScanned, versionsPurged }` summary; `job.failed` on error; register schedule/worker in `main.ts` and assert registration; add `DIRECT_DB_ACCESS_CLASSIFICATIONS` entry.
- [x] **Task 9: Route registration + audit classification + audit-event constants** (AC: 9) — `app.ts` register; `ROUTE_FILES` + four `ROUTE_ACTION_CLASSIFICATIONS` entries; add `credential.created` / `credential.version_created` / `credential.value_revealed` / `credential.version_purged` to `AuditEventType` in `packages/shared/src/constants/audit-events.ts` and **remove the stale `secret.*` members**; run `route-audit.test.ts` in isolation and confirm all four routes appear.
- [x] **Task 9A: Reveal/create operational logging** (AC: 11A) — emit reveal attempt/success/failure + `credential.audit_write_failed` structured signals (never logging values); test that a forced audit-write failure emits the signal, returns `503`, and persists no value/audit row.
- [x] **Task 9B: Deployment rollout guardrails** (AC: 11B) — document dry-run-first rollout, backup warning, forward-only revert, and migration-order gate in completion notes; ensure the migration-order/ schedule-registration checks exist.
- [x] **Task 10: Final verification** (AC: all)
  - [x] `pnpm --filter @project-vault/db test` (RLS isolation) + `check-rls`.
  - [x] `pnpm --filter @project-vault/api test` (integration + route-audit + worker).
  - [x] `pnpm --filter @project-vault/shared test`.
  - [x] `pnpm typecheck` and `pnpm lint` at repo root (confirm `no-bare-decrypt` passes — no direct `decrypt()` anywhere outside `packages/crypto`).

### Review Findings

- [x] [Review][Patch] `.env.example` disables the production dry-run safety for irreversible retention purge [`/.env.example`]
- [x] [Review][Patch] Retention purge selects unlocked candidates but does not re-check `rotation_locked_at`/`purged_at` at update time [`apps/api/src/workers/prune-credential-versions.ts`]
- [x] [Review][Patch] Whitespace-only credential names pass validation after trim [`apps/api/src/modules/credentials/schema.ts`]
- [x] [Review][Patch] Dry-run retention logs only aggregate counts, not each would-purge `{ orgId, credentialId, versionNumber }` candidate [`apps/api/src/workers/prune-credential-versions.ts`]
- [x] [Review][Patch] Malformed cron returns generic `validation_error` instead of the specified `invalid_cron` code [`apps/api/src/lib/route-helpers.ts`]
- [x] [Review][Patch] Reveal failure operational reasons are collapsed or missing for all-purged/decrypt failures [`apps/api/src/modules/credentials/routes.ts`]
- [x] [Review][Patch] Migration-order guard is documented but not enforced by an automated check [`apps/api/src/__tests__/worker-registration.test.ts`]

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| New API module | `apps/api/src/modules/credentials/` — `routes.ts`, `schema.ts`, and a `service.ts` if any handler exceeds ~60 lines (the encrypt/version logic likely warrants `service.ts`). Service functions MUST accept `tx: Tx` and use it exclusively — never call `getDb()` inside a handler-invoked helper (breaks RLS + the outer transaction). |
| New DB schema files | `packages/db/src/schema/credentials.ts`, `credential-versions.ts` — exported from `schema/index.ts`. |
| Migration | `packages/db/src/migrations/<next>_credentials.sql` — confirm the number against `meta/_journal.json` after Story 2.1's projects migration merges (tip `0012_refresh_tokens_org_id` → 2.1 `0013_projects` → this story `0014_credentials.sql`). Never hardcode. |
| Worker | `apps/api/src/workers/prune-credential-versions.ts` (+ `.test.ts`), wired in `main.ts`. |
| Shared schema | `packages/shared/src/schemas/credentials.ts`. |

### Key Code Patterns to Follow

- **Encryption:** `encrypt(plaintext: Buffer, key: Buffer)` from `@project-vault/crypto`; key from `getPrimaryKey()` (returns a copy — zero it). Key version from `vault_state.keyVersion` (parallels `currentAuditKeyVersion()` in `modules/audit/key-version.ts`).
- **Decryption:** ONLY `withSecret(encryptedValue, async (plaintext: Buffer) => …)`. The reveal endpoint is the single sanctioned `Buffer→string` site (carry the documented comment). Direct `decrypt()` outside `packages/crypto` is a `no-bare-decrypt` CI error.
- **SecureRoute:** copy the shape from `apps/api/src/modules/org/routes.ts` and Story 2.1's `modules/projects/routes.ts`. The handler returns data; SecureRoute sends it and writes audit after, in the same tx. Audited handlers must NOT call `reply.send()` (the send-guard throws).
- **Custom audit writer (capture new id / versionNumber):** stash on `req` after insert, read in `auditWriter` — exact pattern in Story 2.1 AC-4.
- **Background org-scoped writes:** `runOrgScopedJob(orgId, jobName, async ({ tx }) => …)` from `middleware/rls.ts`; iterate orgs from `organizations` like `check-failed-auth-threshold.ts`.
- **Audit HMAC:** `computeAuditHmac(fields, getAuditKey())` + `currentAuditKeyVersion(tx)` + `firstActorTokenIdForUser(tx, userId)` (or `actorTokenId: null`, `actorType: 'system'` for the worker) — see `workers/check-failed-auth-threshold.ts` `insertAuditRow`.
- **Timestamp serialization:** convert Drizzle `Date` → ISO string before sending (response schemas are `z.iso.datetime()`).

### Tech Stack (Repo Pinned)

| Tech | Version | Notes |
|---|---|---|
| Drizzle ORM | `0.45.x` | `pgTable`, `uuid`, `text`, `integer`, `jsonb` (`.$type<…>()`), `timestamp`, `uniqueIndex`, `index`, `check`. |
| zod | `zod/v4` | `import { z } from 'zod/v4'`; `.meta({ id })` on exported schemas; `.strict()` on mutation bodies. |
| Fastify | `5.x` | `secureRoute()` registers method+url+audit. |
| pg-boss | `12.18.2` | PostgreSQL-backed; schedule via `boss.registerSchedules`. |
| AES | AES-256-GCM | `packages/crypto` `encrypt`/`withSecret`; `EncryptedValue = { version, iv, ciphertext, tag }`, version `1`. **Pinned signature (authoritative):** `encrypt(plaintext: Buffer, key: Buffer): Promise<EncryptedValue>` (see `packages/crypto/src/aes.ts`). AC-4 uses this Buffer signature correctly. NOTE: `epics.md` (~line 657) and Story 1.5 docs still describe an older `encrypt(plaintext: string, key)` stub — that wording is **stale**; the implemented function takes a `Buffer`. Do not pass a raw string. |

### Architecture Compliance

- No bare `getDb()` in a SecureRoute handler — use the provided `tx`.
- `org_id`/`project_id` always from `auth`/URL, never the request body.
- RLS policies live in the migration SQL, not application code.
- `credential_versions` is insert-only except the retention purge; no append-only trigger (it would block the purge).
- `encrypted_value`/`value` never indexed, never in a non-reveal response, never logged.
- **Migration rollback (R10):** the repo uses **forward-only** drizzle-kit migrations — there are no `down`/rollback files (confirmed: `packages/db/src/migrations/` contains only forward `NNNN_*.sql` tracked in `meta/_journal.json`). If the credentials migration must be reverted, do it via a new forward migration (or restore from backup); do not author a hand-rolled down migration that diverges from the journal.

### Anti-Patterns (Do Not)

- Do not trim or normalize `value` — whitespace may be significant.
- Do not deduplicate identical version values — explicitly allowed.
- Do not return the value from create/add-version/version-history — reveal endpoint only.
- Do not call `decrypt()` directly anywhere outside `packages/crypto` — use `withSecret()`.
- Do not add an append-only trigger to `credential_versions`.
- Do not let the value endpoint return a value without writing the audit row in the same tx.
- Do not hardcode the migration number — confirm it follows Story 2.1's.
- Do not put `credential_versions` / `credentials` in `EXCLUDED_TABLES`.
- Do not skip zeroing the `getPrimaryKey()` copy and the plaintext Buffer after encrypt.

---

## Previous Story Intelligence (Story 2.1)

- **Schema + migration conventions** are fully established by 2.1: `orgScoped()`, RLS-in-migration, `check-rls` gate, `withTestOrg()`/`withOrg()` test helpers, `idx_<table>_<cols>` index naming. 2.2 mirrors them.
- **SecureRoute custom audit writer** for capturing a POST's new resource id is implemented in 2.1 AC-4 — reuse the exact stash-on-`req` pattern for `credential.created`.
- **Timestamp serialization gotcha:** Drizzle returns `Date`; response Zod is `z.iso.datetime()`. 2.1 hit this on all four routes; convert with `.toISOString()`.
- **Dashboard contract:** 2.1 already declared `credential.value_revealed` / `credential.created` in `RecentAccessEventSchema` and counts credentials in `credentialStats`. Keep the `credential` noun and these event names exactly.
- **Cross-org returns 404 not 403** (enumeration prevention) — 2.1 ADR; applies to every credential lookup.
- **`.strict()` mutation schemas** — 2.1 precedent; unknown keys → 422.

---

## Git Intelligence Summary

Recent commits on `feature/1-11-secureroute-framework-and-drizzle-rls-middleware`:
- `1cfd889 fix(core): improve secureroute framework and drizzle rls middleware` — the SecureRoute + RLS + route-audit foundations this story builds on are freshly hardened. Re-read `secure-route.ts` (audit writer signature, `withAuditSendGuard`) before wiring routes.
- Story 2.0 / 2.1 are `ready-for-dev` on this branch (Epic 1, including Story 1.12 MFA login, is `done`); 2.1's `projects` schema/migration is the direct prerequisite (it may not be merged yet — coordinate so the `projects` migration, e.g. `0013_projects`, lands and is journaled before this story's credentials migration, e.g. `0014_credentials`).

Pattern observations:
- Route modules export `async function xRoutes(fastify: FastifyApp): Promise<void>`.
- Workers are thin wrappers over a pure function + `runPruneJob`/`runOrgScopedJob`; DB tests live in `__tests__/`, API/worker tests are co-located `.test.ts`.
- Audit rows from background jobs use `actorType: 'system'`, `actorTokenId: null` (see `check-failed-auth-threshold.ts`).

---

## Pre-mortem Failure Modes

| Failure mode | Why it happens | Prevention |
|---|---|---|
| Credential value leaks in a response | Developer selects `*` or includes `encryptedValue` in history/create response | AC-7/AC-11: select only metadata columns; value-leak regression test scans every non-reveal body. |
| Plaintext lingers in memory | `getPrimaryKey()` copy or plaintext Buffer not zeroed | AC-4 `finally` zeroes both; reveal uses `withSecret()` (auto-zero). |
| Reveal returns value but audit fails silently | Audit write outside the tx, or swallowed error | SecureRoute writes audit in the same tx after the handler; failure → rollback + `503`. Test asserts the audit row exists on success. |
| Duplicate version numbers under concurrency | MAX+1 computed without a lock | AC-5 `SELECT … FOR UPDATE` + `(credential_id, version_number)` unique index; `23505 → 409`. |
| Retention destroys a rotation-active version | Job ignores rotation lock (Epic 5 not built yet) | `rotation_locked_at` exemption seam exists from day one; worker test covers it. |
| Append-only trigger blocks purge | Developer copies `audit_log_entries` immutability trigger onto `credential_versions` | AC-2/AC-3 explicitly forbid it; the purge is the sanctioned UPDATE. |
| `no-bare-decrypt` CI failure | Worker/handler calls `decrypt()` directly | Always `withSecret()`; reveal path is the only `Buffer→string` site. |
| route-audit fails | New routes missing from `ROUTE_FILES` / `ROUTE_ACTION_CLASSIFICATIONS`, or GET-with-audit not accepted | AC-9 lists all four + the `sensitive-read`+`auditEvent` note; run route-audit in isolation. |
| Migration FK order wrong | `credential_versions` created before `credentials` | AC-3: confirm generated order; `credentials` first. |
| Sealed-vault 500 instead of 503 | Handler reached while sealed | `vault-guard` returns 503 first; test asserts it. |
| Value silently corrupted | `value` trimmed by Zod | AC-10: `value` is never `.trim()`med. |
| Retention purges the only live version → reveal 404s forever (F1) | `retentionCount` math off-by-one or a race resolves the kept set to 0 | AC-8 "keep ≥ 1" invariant: never purge the single highest non-purged version; assert `kept ≥ 1` before purging. Worker test covers `retentionCount` edge values. |
| Reveal returns 500 on a purged top version (F2) | `isNull(purgedAt)` filter dropped from the current-version query → `withSecret(null)` throws | AC-6 filters `purged_at IS NULL`; AC-12 test reveals the next live version (not 500) when the newest is purged. |
| `retention_count` CHECK missing from emitted SQL (F4) | `drizzle-kit generate` does not always emit `check()` constraints | Task 1: grep generated SQL for `credentials_retention_count_check`; hand-add if absent. DB test asserts `retention_count = 0` insert is rejected. |
| Reveal audit records `versionNumber: undefined` (F6) | Stash set after `return`, or stash key drifts, under the audit-after-handler ordering | AC-6 normative sequence: decrypt → stash `versionNumber` → return. Test asserts audit payload `versionNumber` equals the revealed version. |
| Retention long-tx / lock storm in large orgs (F7) | One `runOrgScopedJob` tx purges all credentials in the org, holding locks that block reveals/add-version | AC-8 batching note: chunk the purge (short transactions), do not hold a single org-wide tx open across all credentials. |
| Worker audit row attributed to wrong/empty org (F10) | `runOrgScopedJob` org context mis-scoped or a stale GUC persists on a reused connection | Worker test asserts each `credential.version_purged` audit row carries the correct `org_id`; re-set org context per org, never reuse without setting. |

---

## ADRs

### ADR-2.2-01: Canonical table/endpoint naming is `credentials` + `GET …/value` (not architecture's `secrets` + `POST …/reveal`)
| | |
|---|---|
| **Context** | The architecture doc uses `secrets`/`secret_versions` tables and `POST …/reveal → { revealedValue }`. The epic and Story 2.1 use `credentials`/`credential_versions` and `GET …/value → { value, versionNumber, retrievedAt }`. |
| **Decision** | Follow the epic + Story 2.1: `credentials`/`credential_versions`, `GET …/value`. |
| **Rationale** | Story 2.1 already shipped dashboard contracts on the `credential` noun (`credentialStats`, `credential.value_revealed`). Diverging would break 2.1. The epic is the authoritative per-story source. |
| **Consequences** | The architecture doc's `secrets` naming is treated as superseded for Epic 2. A future architecture-doc update should reconcile the noun. |

### ADR-2.2-02: Value reveal is an audited GET
| | |
|---|---|
| **Context** | Reveal must be audited (FR96). Architecture modeled it as a POST; the epic specifies a GET `/value`. A GET with a write side effect is unusual REST. |
| **Decision** | `GET …/value` that writes a `credential.value_revealed` audit row in the same transaction via SecureRoute `writeAuditEvent`. |
| **Rationale** | The epic fixes the GET contract and response shape. SecureRoute fully supports auditing any method and runs the audit in the operation's transaction (100% capture). Modeling it as a POST would contradict the epic and the dashboard's read-event semantics. |
| **Consequences** | The route-audit gate must accept a `sensitive-read` carrying an `auditEvent`. Reveal is not idempotent in audit terms (each GET = one audit row) — intended. |

### ADR-2.2-03: `read:secret_value` vs `read:secret_metadata` mapped to roles in v1; audit is the enforced control
| | |
|---|---|
| **Context** | NFR-SEC9 wants a distinct value-read permission. No fine-grained permission framework exists (same as Story 2.1 ADR-2.1-01). |
| **Decision** | Metadata/version reads require `viewer`; value reveal + version creation require `member`. The mandatory per-reveal audit event is the day-one enforced control for value access. |
| **Rationale** | Building scoped permissions is a larger framework effort (Story 4.1 territory). Roles + universal reveal-auditing provide acceptable control now. |
| **Consequences** | Any `member`+ can reveal any credential in their org's projects. Fine-grained `read:secret_value` is deferred; the audit trail makes every access attributable. |

### ADR-2.2-04: Cryptographic deletion is a soft-purge (row retained, value zeroed) with a `rotation_locked_at` exemption seam
| | |
|---|---|
| **Context** | FR105 requires retention with cryptographic deletion, exempting rotation-active versions. Rotations (Epic 5) do not exist yet. |
| **Decision** | The retention job overwrites `encrypted_value` with zeros then nulls it, clears `key_version`, sets `purged_at` — the row survives for history integrity. A nullable `rotation_locked_at` column exempts locked versions; it is always null in 2.2 and set/cleared by Epic 5. |
| **Rationale** | Nulling the value + clearing `key_version` removes the value material from the logical row while preserving version-history metadata. The zero-overwrite is defense-in-depth, **not** a guarantee of byte-level erasure (see AC-8 MVCC/WAL caveat) — true shredding of retired material is achieved by destroying the key on master-key rotation (Epic 5+). The exemption seam is testable in 2.2 (set the column directly) without depending on Epic 5, and Epic 5 wires into it with zero schema change. |
| **Consequences** | `credential_versions.encrypted_value`/`key_version` are nullable; consumers must treat a purged version as value-less. Version history shows purged versions with `purgedAt`. Do not advertise the purge as cryptographic byte-erasure to users until key-rotation-based shredding lands. |

### ADR-2.2-05: "Current version" is computed (`MAX` non-purged), not a denormalized pointer column
| | |
|---|---|
| **Context** | Reveal and version-history both need "the current version." This can be computed on read or stored as a pointer on `credentials`. The F1/F2/F3 failure modes all cluster around current-version correctness. |
| **Options** | (a) compute `MAX(version_number) WHERE purged_at IS NULL` on each read; (b) denormalize `current_version_number`/`current_version_id` on `credentials`, updated on each insert/purge. |
| **Decision** | (a) computed from `MAX` of non-purged versions, backed by the `(credential_id, version_number DESC)` index. |
| **Rationale** | Removes a second mutation point that can drift from reality (the purge and add-version paths would both have to maintain it). The descending index makes the aggregate cheap, and "current = highest live version" is always trivially consistent. |
| **Consequences** | Every reveal/history runs a small aggregate (acceptable, indexed). All current-version queries MUST include `purged_at IS NULL`; this is asserted by the F2/F3 tests. |

### ADR-2.2-06: Version numbers are app-assigned (`MAX+1` under `FOR UPDATE`), not a DB sequence/identity
| | |
|---|---|
| **Context** | Each credential needs gapless, per-credential monotonic version numbers (v1, v2, v3 …). |
| **Options** | (a) `SELECT MAX(version_number)+1 … FOR UPDATE` on the parent credential; (b) a Postgres sequence; (c) a per-credential counter column. |
| **Decision** | (a) app-assigned `MAX+1` under the parent-row lock, with `(credential_id, version_number)` unique index as backstop and `23505 → 409 version_conflict`. |
| **Rationale** | Sequences are global and leave gaps and cannot reset per credential; a counter column is another mutable field to keep in sync. The row lock serializes assignment and the unique index is the race backstop, giving the gapless per-credential numbering users expect. |
| **Consequences** | Add-version takes a brief row lock on the parent credential; a rare lost race surfaces as `409` for client retry. |

### ADR-2.2-07: Retention runs as a scheduled pg-boss job, not a DB trigger / TTL / on-write purge
| | |
|---|---|
| **Context** | Versions beyond `retentionCount` must be cryptographically purged AND each purge must write a per-row keyed-HMAC, key-versioned, RLS-scoped audit row (per-row `computeAuditHmac`, not a prev-row chain). |
| **Options** | (a) daily pg-boss cron job (Story 1.10 worker pattern + `runOrgScopedJob`); (b) DB trigger/rule purging inline on insert; (c) `pg_cron` / partition TTL. |
| **Decision** | (a) scheduled pg-boss job (`credentials:prune-versions`, `0 3 * * *`). |
| **Rationale** | Only the app worker path has `getAuditKey()` and `runOrgScopedJob` for audited, org-scoped writes. A trigger cannot cleanly produce audited, key-versioned audit rows and would couple write latency to purge work; `pg_cron`/TTL adds infra outside the audit/RLS framework. Eventual (daily) purge is acceptable for a retention policy. |
| **Consequences** | Up to ~one day of overflow versions may exist before purge. The worker must be added to `DIRECT_DB_ACCESS_CLASSIFICATIONS` and only runs post-unseal. |

### ADR-2.2-08: Encrypted material stored as a single JSONB `EncryptedValue`, not split columns or `bytea`
| | |
|---|---|
| **Context** | `credential_versions` must store the AES-256-GCM output `{ version, iv, ciphertext, tag }`, nullable for purge, never queried/indexed. |
| **Options** | (a) one `jsonb` column typed `$type<EncryptedValue \| null>()`; (b) separate `iv`/`ciphertext`/`tag`/`version` columns; (c) a packed `bytea` blob. |
| **Decision** | (a) single `jsonb` column. |
| **Rationale** | The crypto layer already produces/consumes `EncryptedValue`; one column round-trips it directly and nulls cleanly as a unit on purge. The field is never filtered or indexed, so JSONB's lack of query optimization is irrelevant; split columns add migration churn with no benefit, and `bytea` needs custom (de)serialization. |
| **Consequences** | Consumers treat the column as an opaque `EncryptedValue \| null`; a purged version is `null`. |

### ADR-2.2-09: Reveal is fail-closed on audit — availability is intentionally coupled to audit-write success
| | |
|---|---|
| **Context** | FR96 requires every value reveal to be auditable. SecureRoute writes the audit row in the same transaction as the handler. |
| **Options** | (a) audit write in the same tx — on failure, roll back and return `503`, value NOT returned; (b) return the value, write audit best-effort/async. |
| **Decision** | (a) fail-closed: no value is returned without a committed `credential.value_revealed` audit row. |
| **Rationale** | For a secrets manager, serving a secret with no record of access is worse than a temporarily unavailable reveal. Same-transaction coupling is the only way to guarantee 100% capture (FR96). The availability cost during an audit-subsystem outage is accepted and explicit. |
| **Consequences** | An audit-write failure makes reveals unavailable (`503 audit_write_failed`) rather than serving unaudited secrets. This behavior is asserted by the AC-12 audit-failure-rollback test. |

---

## References

- Story source: `_bmad-output/planning-artifacts/epics.md#Story-2.2-Credential-Storage--Retrieval-with-Version-History`
- Epic 2 constraints (RS-E2a value-column protection, PJ5 pre-audit-log, PJ6 actor token): `_bmad-output/planning-artifacts/epics.md#Epic-2`
- FR10/FR11/FR12/FR96/FR105: `_bmad-output/planning-artifacts/prd.md`
- Crypto API (`encrypt`, `withSecret`, `EncryptedValue`): `packages/crypto/src/index.ts`, `secret-value.ts`, `aes.ts`
- `Buffer→string` reveal exception + `SecretValue`: `_bmad-output/planning-artifacts/architecture.md` (Value Revelation Endpoint / SecretValue sections)
- Vault key access (`getPrimaryKey`, `getAuditKey`, unseal lifecycle): `apps/api/src/modules/vault/key-service.ts`
- Vault guard (sealed → 503): `apps/api/src/plugins/vault-guard.ts`
- SecureRoute + default audit writer + custom `auditWriter`: `apps/api/src/lib/secure-route.ts`
- RLS helpers (`setRlsOrgContext`, `runOrgScopedJob`): `apps/api/src/middleware/rls.ts`
- Audit HMAC + key version + actor token: `apps/api/src/modules/audit/{write-entry,key-version,actor-token}.ts`
- Background-job org-scoped audit pattern: `apps/api/src/workers/check-failed-auth-threshold.ts`
- Worker + schedule registration: `apps/api/src/main.ts`; prune pattern: `apps/api/src/workers/prune-utils.ts`, `prune-totp-used-codes.ts`
- Route audit classification: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`
- Schema conventions (`orgScoped`, RLS-in-migration): `packages/db/src/schema/helpers.ts`, `packages/db/src/migrations/0001_rls_and_triggers.sql`
- Previous story (projects schema, dashboard contract, conventions): `_bmad-output/implementation-artifacts/2-1-project-creation-and-cross-project-dashboard.md`
- Auth test helpers: `apps/api/src/__tests__/helpers/auth-test-helpers.ts`
- Repo TDD rule: `AGENTS.md`
- Key decisions to read first: **ADR-2.2-05** (current = computed `MAX` non-purged; basis for F1–F3) and **ADR-2.2-09** (reveal is fail-closed on audit; basis for the audit-rollback test).
- RLS `WITH CHECK` default for command-less (`ALL`) policies (cross-org write protection): `packages/db/src/migrations/0001_rls_and_triggers.sql` (lines ~46–48).
- Actual `encrypt` signature (Buffer, not string): `packages/crypto/src/aes.ts`.

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

- Migration number confirmed dynamically against `packages/db/src/migrations/meta/_journal.json` before generating: tip was `0013_projects` (Story 2.1, merged via PR #23), so this story landed as `0014_credentials.sql`.
- `apps/api/src/__tests__/route-audit.test.ts` confirms all four credential routes are registered via `secureRoute()`, classified in `ROUTE_ACTION_CLASSIFICATIONS`, and that the worker's direct `getDb()` usage is classified in `DIRECT_DB_ACCESS_CLASSIFICATIONS`.

### Completion Notes List

- **AC-11B O1 (dry-run-first rollout):** The retention worker reads `CREDENTIAL_RETENTION_DRY_RUN` (new env var, `apps/api/src/config/env.ts`). Default is `isProduction` (true in production, false in dev/test) — production's first deploy defaults to dry-run (log-only, `credential.retention.dry_run` operational log with `versionsWouldPurge`); tests/dev default to destructive so coverage exercises the real purge path. Operators must explicitly set `CREDENTIAL_RETENTION_DRY_RUN=false` in production after verifying the dry-run output.
- **AC-11B O2 (backup warning):** Enabling destructive retention permanently destroys credential version values beyond `retentionCount` (default 3, min 1). **A verified database backup must exist before the first destructive run in any environment.** The zero-overwrite in `purgeVersion()` (`apps/api/src/workers/prune-credential-versions.ts`) is defense-in-depth/intent-signaling only — under PostgreSQL MVCC it does not guarantee byte-level erasure (the prior tuple persists as dead-row data until `VACUUM`, and may persist in WAL/backups). The only true cryptographic-deletion guarantee comes from destroying the encryption key at master-key rotation (Epic 5+).
- **AC-11B O3 (forward-only migration):** `0014_credentials.sql` is forward-only, consistent with every prior migration in this repo (no down-migration files exist). If it must be reverted, write a new forward migration (e.g. `0015_drop_credentials.sql`) or restore from backup — never hand-author a down migration.
- **AC-11B O4 (migration-order gate):** `0014_credentials.sql` has an FK to `projects` (Story 2.1's `0013_projects.sql`). The migration was generated and applied only after confirming `0013_projects` precedes it in `meta/_journal.json` (idx 13 vs idx 14). `apps/api/src/__tests__/worker-registration.test.ts` now asserts this journal ordering, and `make ci`'s `db-migrate` step applies migrations in journal order.
- **AC-11B O5 (schedule-registration verification):** `apps/api/src/__tests__/worker-registration.test.ts` asserts `'credentials:prune-versions'` appears in both the `registerSchedules` and `registerWorkers` maps in `main.ts`, so the job cannot silently go unregistered.
- The "custom auditWriter stash pattern" referenced in the story's AC-4 prose does not exist as a framework feature in `secure-route.ts` — Story 2.1's actual precedent (`writeProjectAudit` in `modules/projects/routes.ts`) is `writeAuditEvent: false` + a manual same-transaction audit call wrapped in `SameTransactionAuditWriteError` on failure. This story follows that real precedent (`writeCredentialAudit`/`writeCredentialAuditOrFailClosed` in `modules/credentials/routes.ts`) for the create and add-version routes (no `credentialId` in the create URL); the reveal and version-history routes use SecureRoute's declarative `writeAuditEvent`/`resourceIdFromParams` since `credentialId` is already in those URLs.
- `packages/db` did not declare `@project-vault/crypto` as a runtime dependency even though `credential-versions.ts` imports `EncryptedValue` from it; added to `packages/db/package.json` dependencies (required for the workspace package graph to resolve correctly).

### File List

- `packages/db/src/schema/credentials.ts` (new)
- `packages/db/src/schema/credential-versions.ts` (new)
- `packages/db/src/schema/index.ts` (modified — export new schemas)
- `packages/db/package.json` (modified — add `@project-vault/crypto` dependency)
- `packages/db/src/migrations/0014_credentials.sql` (new)
- `packages/db/src/migrations/meta/0014_snapshot.json` (new)
- `packages/db/src/migrations/meta/_journal.json` (modified)
- `packages/db/src/__tests__/credentials-rls-isolation.test.ts` (new)
- `packages/shared/src/schemas/credentials.ts` (new)
- `packages/shared/src/schemas/credentials.test.ts` (new)
- `packages/shared/src/index.ts` (modified — export new schema)
- `packages/shared/src/constants/audit-events.ts` (modified — add `credential.*`, remove stale `secret.*`)
- `packages/shared/src/constants/audit-events.test.ts` (modified)
- `packages/shared/src/constants/operational-event-types.ts` (modified — add `credential.reveal.*`/`credential.retention.*`/`credential.audit_write_failed`)
- `apps/api/src/modules/credentials/schema.ts` (new)
- `apps/api/src/modules/credentials/schema.test.ts` (new)
- `apps/api/src/modules/credentials/service.ts` (new)
- `apps/api/src/modules/credentials/routes.ts` (new)
- `apps/api/src/modules/credentials/routes.test.ts` (new)
- `apps/api/src/workers/prune-credential-versions.ts` (new)
- `apps/api/src/workers/prune-credential-versions.test.ts` (new)
- `apps/api/src/__tests__/worker-registration.test.ts` (new)
- `apps/api/src/app.ts` (modified — register `credentialRoutes`)
- `apps/api/src/main.ts` (modified — register `credentials:prune-versions` schedule/worker)
- `apps/api/src/config/env.ts` (modified — add `CREDENTIAL_RETENTION_DRY_RUN`)
- `apps/api/src/lib/route-exemptions.ts` (modified — four new `ROUTE_ACTION_CLASSIFICATIONS` entries + one `DIRECT_DB_ACCESS_CLASSIFICATIONS` entry)
- `.env.example` (modified — document `CREDENTIAL_RETENTION_DRY_RUN`)



