# Story 2.4: Dependent System Recording & Expiry/Rotation Schedules

Status: done

<!-- Ultimate context engine analysis completed 2026-06-28 - comprehensive developer guide for the credential_dependencies table (the direct input to Epic 5 rotation checklists), the credential lifecycle PATCH (expiry + full cron-validated rotation schedule with a max-every-1-hour rule), the role-derived credential access list (FR64), and the hasDependencies coverage-gap flag (UX-DR7). This story activates the expiresAt/rotationSchedule columns Story 2.2 created write-only-at-create. -->

## Story

As a developer managing credential lifecycle,
I want to record which systems depend on each credential, set expiry dates and rotation schedules, and see who has access to a specific credential,
so that rotation checklists are pre-populated (for Epic 5) and I can audit credential exposure.

*Covers: FR15, FR16, FR64.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.4-Dependent-System-Recording--ExpiryRotation-Schedules`]

> **The two seams this story exists to build (read first):**
> 1. **Epic 5 rotation input (PJ1).** Every non-archived `credential_dependencies` row created here becomes exactly one `rotation_checklist_items` row when a rotation is initiated (Story 5.1). Shape the record (`id`, `systemName`, `systemType`, `notes`, `archivedAt`) and the **soft-archive** semantics so Epic 5 consumes it with **zero reshape** — archived dependencies stay in history but are excluded from checklist generation.
> 2. **Activating the lifecycle columns.** Story 2.2 created `credentials.expires_at` and `credentials.rotation_schedule` but only ever wrote them at create with a **shape-only** cron regex (2.2 explicitly deferred full cron semantics here — 2.2 ADR/residual F8). This story adds the mutation path (`PATCH`), upgrades cron validation to **real `cron-parser` semantics + a max-frequency-every-1-hour rule**, and applies that same validator back to 2.2's create path so both entry points agree.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 2.2 (`credentials` + `credential_versions` tables, the credentials migration, `credential.*` audit vocabulary, `apps/api/src/modules/credentials/` module + `schema.ts`) merged and passing CI | This story adds endpoints to the **existing** credentials module and reads the `expires_at`/`rotation_schedule`/`tags` columns 2.2 created. `credential_dependencies.credential_id` FKs to `credentials.id`. Run `pnpm --filter @project-vault/db migrate` first. |
| Story 2.3 (credential list endpoint + `CredentialSummarySchema`) merged | AC-8 (`hasDependencies` flag) **extends the Story 2.3 list summary** — 2.3 explicitly deferred this flag to 2.4 (2.3 AC-10 out-of-scope). The list query in `modules/credentials/` is amended here, not recreated. |
| Story 1.11 `SecureRoute` framework + `route-audit.test.ts` CI gate merged | All four new routes register via `secureRoute()` and must be classified in `ROUTE_ACTION_CLASSIFICATIONS`. |
| Story 1.5 vault init/unseal merged | The dependency/lifecycle/access routes are NOT on the `vault-guard` allowlist, so they return `503 { status: "sealed" }` while sealed — even though they touch only metadata. Tests must assert this fail-closed behavior. |
| Story 1.4 audit foundation (`audit_log_entries`, keyed-HMAC writer, `org_memberships`) merged | Dependency add/archive and lifecycle PATCH write per-row keyed-HMAC audit rows via the SecureRoute default audit writer. The access list (AC-7) reads `org_memberships` + `users`. |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | ⚠️ On today's branch the highest migration is **`0012_refresh_tokens_org_id.sql`**. The Epic 2 chain lands `0013_projects` (2.1) → `0014_credentials` (2.2) → `0015_credential_search_and_project_tags` (2.3), so **this story's migration is `0016_credential_dependencies.sql`**. Before generating, re-read `packages/db/src/migrations/` + `meta/_journal.json` and use the **next free number after whatever 2.1/2.2/2.3 actually committed**. Every `0016_*` reference in this doc is an illustrative placeholder. |

---

## Epic Cross-Story Context

| Story | Relationship to 2.4 |
|---|---|
| 2.1 | Created `projects` + the `modules/projects/` module; established `orgScoped()`, RLS-in-migration, cross-org-returns-404 (ADR-2.1-05/07), `.strict()` bodies, timestamp serialization. 2.4 follows all of them. The access list (AC-7) is org-role-scoped (no per-project RBAC yet — Story 4.1). |
| 2.2 | Created `credentials` (with `expires_at`, `rotation_schedule`, `tags`) + `credential_versions` + the credentials module/schema + the `credential.*` audit names. 2.2 wrote the lifecycle columns **only at create** with a **shape-only** cron regex (`CRON_REGEX = /^(\S+\s+){4}\S+$/`) and recorded "full cron semantics deferred to Story 2.4" (2.2 residual F8 / AC-10 out-of-scope). 2.4 adds the `PATCH` mutation path and the real cron validator, and **replaces** 2.2's shape-only regex with the shared validator on the create path too. |
| 2.3 | Created the credential **list** endpoint + `CredentialSummarySchema` and deliberately excluded `hasDependencies` ("Story 2.4's `hasDependencies` flag is NOT part of 2.3's list response" — 2.3 cross-story table + AC-10). 2.4 adds it via an `EXISTS` subquery. 2.3's `status`/`expiresWithin` filters READ `expires_at`; 2.4 is the first to MUTATE it — keep the 2.3 filter semantics intact. |
| 4.1 | Per-project RBAC. The AC-7 access list is **org-role-derived** in v1 (everyone with an active org membership has access per their org role); Story 4.1 will later scope it per project. The `[{ identityType, displayName, role, grantedAt }]` shape is forward-compatible. |
| 5.1 | **Primary consumer.** `POST …/rotations` reads every **non-archived** `credential_dependencies` row and creates one `rotation_checklist_items` row per dependency (`{ id, rotationId, dependencyId, systemName, status: 'unconfirmed', … }`). The `dependencyId` FK and `systemName` snapshot come from THIS story's record. Archived dependencies MUST be excluded from that read. Design for zero reshape (ADR-2.4-01). **Point-in-time snapshot contract:** 2.4 guarantees stable `dependencyId` PKs and never hard-deletes a dependency, but it does NOT coordinate add/archive with rotation. The *consistent* read of the dependency set is the consumer's responsibility — Story 5.1 reads it **inside its own advisory-locked transaction** (the rotation lock it already takes), so concurrent 2.4 add/archive cannot mutate a checklist mid-generation. **Duplicate-name consequence:** because 2.4 allows two non-archived dependencies with the same `systemName` (distinct `dependencyId`s — distinct systems that share a label), 5.1 will create **one checklist item per row**, i.e. two same-named-but-independently-confirmable items. This is intended; do NOT add a unique constraint to collapse them. |
| 5.2 | `GET …/rotations/upcoming?horizon=7d|30d|90d` (FR65) consumes `rotation_schedule` set here. 2.4 only **stores/validates** the cron; the "consolidated upcoming list" endpoint is Epic 5 scope (explicitly out of scope below). |
| 6.x | Asset expiry alerts (FR28/FR29) read `expires_at`. 2.4 sets it; the alerting job lands in Epic 6. |
| 8.x | The audit events written here (`credential.dependency_added`, `credential.dependency_archived`, `credential.lifecycle_updated`) become queryable when Epic 8's audit UI lands (PJ5). They MUST be written to `audit_log_entries` from day one with correct HMAC + key version + actor token (PJ6). |

---

## Architecture Conflict Resolution (Read Before Coding)

The architecture document predates the epic refinement. Where they differ, the **epic + Story 2.1/2.2/2.3 conventions are authoritative**. Resolve every conflict as follows:

| Architecture / prior wording | Canonical implementation for 2.4 | Rationale |
|---|---|---|
| Architecture may model dependent systems inline on the secret row or omit them | A dedicated **`credential_dependencies`** table (one row per dependency), org-scoped with RLS, soft-archived via `archived_at`. | The epic fixes the table name and fields, and Story 5.1 reads it row-per-dependency to build checklist items. A JSON blob on `credentials` could not be FK-referenced by `rotation_checklist_items.dependencyId`. |
| 2.2 create path validates `rotationSchedule` with a **shape-only** 5-field regex and accepts semantic garbage (2.2 residual F8) | 2.4 introduces a shared `validateRotationCron()` (real `cron-parser` parse + **max-frequency every 1 hour**) and uses it on BOTH the new `PATCH` and 2.2's existing create body. | 2.2 explicitly deferred full cron semantics to this story. Two different validators on two entry points would let an invalid schedule in via create — reconcile to one validator. |
| Fine-grained `read:secret_metadata` / access-permission scopes (NFR-SEC9) | Mapped to org roles in v1 (same as 2.2 ADR-2.2-03 / 2.3): dependency + lifecycle mutation require `member`; the access list (AC-7) requires `admin`/`owner`. | No fine-grained permission framework exists yet (Story 4.1 territory). |
| Access list "who has access" might imply a per-resource grant table | Derived from `org_memberships` (+ `users` for display) in v1; `identityType` is always `'user'` until Epic 7 adds machine users. | There is no per-credential or per-project grant table yet; access is org-role-based. The response shape is forward-compatible with Epic 7 machine users (ADR-2.4-04). |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| DB schema | New `credential_dependencies` table, org-scoped with RLS in the migration (next free number, e.g. `0016_credential_dependencies.sql`). Soft-archive via `archived_at` (+ `archived_by`); `system_type` constrained by a CHECK. Shaped for Epic 5 (`id`, `system_name`, `system_type`, `notes`, `archived_at`). |
| Add dependency | `POST …/credentials/:credentialId/dependencies` with `{ systemName, systemType?, notes? }` → creates a row, returns it; `member`+. Capped at 200 active deps per credential → `422 too_many_dependencies`. |
| List dependencies | `GET …/credentials/:credentialId/dependencies` returns non-archived only; `?includeArchived=true` returns all; response also carries `hasDependencies`. |
| Archive dependency | `DELETE …/credentials/:credentialId/dependencies/:dependencyId` is a **soft-archive** (sets `archived_at`/`archived_by`); hidden from active list, present in history; idempotent; Epic 5 excludes archived. |
| Lifecycle PATCH | `PATCH …/credentials/:credentialId` sets/clears `expiresAt` (ISO datetime) and/or `rotationSchedule` (cron). Full cron validation via `cron-parser`; **max frequency every 1 hour**; invalid → `422 { code: "invalid_cron" }`. |
| Cron reconciliation | A shared `validateRotationCron()` replaces 2.2's shape-only `CRON_REGEX` on the create path so create + PATCH validate identically. |
| Access list | `GET …/credentials/:credentialId/access` → `[{ identityType, displayName, role, grantedAt }]` derived from active `org_memberships`; `admin`/`owner` only. |
| Coverage flag (UX-DR7) | Credentials with zero non-archived dependencies are flagged `hasDependencies: false` — added to the Story 2.3 list summary (via `EXISTS` subquery) and the dependency list response. |
| Route audit | All new routes registered in `ROUTE_ACTION_CLASSIFICATIONS`; mutations carry audit events; list/access are `read` (audit-omitted, metadata only). `route-audit.test.ts` passes. |
| Security | RLS org-scoped; cross-org/cross-project/cross-credential → 404 (no enumeration); sealed vault → 503; mutations fail-closed on audit; `.strict()` bodies; no secret value ever touched (this story never reads `credential_versions.encrypted_value`). |
| Tests | Add dependency; archive (hidden from active, present in history, idempotent); list ±archived; set/clear expiry + rotation; invalid + too-frequent cron 422; access list role-scoped + shape; zero-dependency flag; cross-org isolation; sealed 503; audit rows + actor-as-token; audit-failure rollback. |

---

### AC-1: Database Schema — `credential_dependencies` Table (NEW)

**Given** the Drizzle schema conventions in `packages/db/src/schema/` (established by Stories 1.4/2.1/2.2),
**When** Story 2.4 adds dependent-system recording,
**Then** create `packages/db/src/schema/credential-dependencies.ts` exactly as follows:

```typescript
import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { credentials } from './credentials.js'

// Insert + soft-archive (archived_at) + updated_at. NEVER holds any credential value.
// One row per dependent system; the DIRECT input to Epic 5 rotation_checklist_items
// (Story 5.1 reads non-archived rows and snapshots system_name into each checklist item).
export const credentialDependencies = pgTable(
  'credential_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    systemName: text('system_name').notNull(),
    // Constrained set (see CHECK below). Stored as text, not a pg enum, for migration
    // flexibility (ADR-2.4-07) — mirrors org_memberships.role.
    systemType: text('system_type').notNull().default('other'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    // Soft-archive seam (ADR-2.4-02): non-null = archived. Epic 5 reads WHERE archived_at IS NULL.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedBy: uuid('archived_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Active-dependency lookups (list + Epic 5 checklist generation) filter by credential + archived_at.
    credActiveIdx: index('idx_credential_dependencies_cred_active').on(t.credentialId, t.archivedAt),
    orgIdx: index('idx_credential_dependencies_org').on(t.orgId),
    systemTypeCheck: check(
      'credential_dependencies_system_type_check',
      sql`${t.systemType} IN ('service','ci_pipeline','database','third_party','other')`
    ),
    systemNameLenCheck: check(
      'credential_dependencies_system_name_len_check',
      sql`char_length(${t.systemName}) BETWEEN 1 AND 256`
    ),
  })
)
```

**And** the `system_type` enum values are EXACTLY `service | ci_pipeline | database | third_party | other` (epic-fixed). Store as `text` + CHECK (not a Postgres `enum` type) so adding a value later is a one-line CHECK change, not an `ALTER TYPE` migration — mirrors `org_memberships.role` (ADR-2.4-07). `other` is the default when `systemType` is omitted.

**And** `archived_at` is the soft-archive marker: a `NULL` value means active, a non-null timestamp means archived. There is **no hard delete** — archiving preserves the row for rotation-history integrity and so Epic 5 never references a vanished `dependencyId` (ADR-2.4-02). `archived_by` records who archived it (`set null` on user deletion, like `created_by`).

**And** the table holds **no credential value, no encrypted material, and no FK to `credential_versions`** — it is pure metadata. `system_name`/`notes` are user-supplied free text (RS-E2a does not apply to them, but they are never indexed for search in this story).

**And** `orgScoped({ onDelete: 'cascade' })` denormalizes `org_id` (even though `credential_id → credentials` already carries org) so the uniform `org_id = current_setting('app.current_org_id')` RLS policy applies and an org delete cascades (same rationale as Story 2.1 ADR-2.1-05 / 2.2 AC-1).

**And** export it from `packages/db/src/schema/index.ts`:
```typescript
export * from './credential-dependencies.js'
```

---

### AC-2: Migration (next free number, e.g. `0016_credential_dependencies.sql`) — Schema, RLS Policy, `updated_at` Trigger

> **Migration number is dynamic (R1).** Re-read `meta/_journal.json` immediately before `drizzle-kit generate`. Today's chain: tip `0012` → `0013_projects` (2.1) → `0014_credentials` (2.2) → `0015_credential_search_and_project_tags` (2.3) → this story `0016_credential_dependencies.sql`. Substitute the real number; never hardcode.

**Given** the RLS coverage check (`packages/db/src/check-rls-coverage.ts`) fails CI if any `org_id` table lacks an `ALL` policy,
**When** Story 2.4 creates the migration,
**Then** create `packages/db/src/migrations/<next>_credential_dependencies.sql` (e.g. `0016_…`) that:

1. Creates the `credential_dependencies` table (`drizzle-kit generate` emits the `CREATE TABLE` — it must be created AFTER `credentials` exists because of the FK; the journal order guarantees this since 2.2's migration precedes it).
2. Enables RLS and adds the isolation policy in the **same migration file**.
3. Adds the `updated_at` auto-update trigger (function defined in `0001`).

Required policy + trigger block (must appear in the migration):

```sql
ALTER TABLE credential_dependencies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credential_dependencies_isolation
  ON credential_dependencies
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON credential_dependencies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**And** this is a command-less (`ALL`) policy with no explicit `WITH CHECK` — intentional, matching `0001_rls_and_triggers.sql`: PostgreSQL defaults `WITH CHECK` to the `USING` expression, so a cross-org `INSERT`/`UPDATE` (foreign `org_id`) is rejected by RLS. Do NOT add a separate `FOR INSERT`/`FOR UPDATE` policy. (A positive write-isolation test is required — AC-12.)

**And** confirm `drizzle-kit generate` actually emitted both `CHECK` constraints (`credential_dependencies_system_type_check`, `credential_dependencies_system_name_len_check`); drizzle-kit does not always emit `check()` — grep the generated SQL and hand-add any missing constraint (same gotcha as 2.2 F4).

**And** after adding the migration: `pnpm --filter @project-vault/db check-rls` (no gap — do NOT add `credential_dependencies` to `EXCLUDED_TABLES`), then `pnpm --filter @project-vault/db migrate` locally. The repo is **forward-only** (no down files) — revert via a new forward migration, never a hand-authored down (Story 2.1/2.2/2.3 convention).

---

### AC-3: `POST /api/v1/projects/:projectId/credentials/:credentialId/dependencies` — Add Dependency

**Given** a credential exists in the caller's org+project and the caller has at least `member` role,
**When** they record a dependent system,
**Then** create one `credential_dependencies` row and return it.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/credentials/00000000-0000-4000-8000-000000000100/dependencies
Content-Type: application/json
Cookie: access-token=<jwt>

{
  "systemName": "billing-worker (prod)",
  "systemType": "ci_pipeline",
  "notes": "GitHub Actions deploy pipeline reads this key from the prod environment secret."
}
```

**Successful response (`201 Created`):**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000500",
    "credentialId": "00000000-0000-4000-8000-000000000100",
    "systemName": "billing-worker (prod)",
    "systemType": "ci_pipeline",
    "notes": "GitHub Actions deploy pipeline reads this key from the prod environment secret.",
    "createdBy": "00000000-0000-4000-8000-000000000001",
    "archivedAt": null,
    "createdAt": "2026-06-28T16:00:00.000Z",
    "updatedAt": "2026-06-28T16:00:00.000Z"
  }
}
```

**And** validation (Zod `.strict()` — unknown keys → `422`):
- `systemName`: required, trimmed, 1–256 chars.
- `systemType`: optional; one of `service | ci_pipeline | database | third_party | other`; defaults to `other` when omitted. An out-of-set value → `422 { code: "validation_error" }`.
- `notes`: optional, trimmed, ≤2048 chars, nullable.
- `orgId`, `credentialId`, `id`, `archivedAt`, `createdBy` are NEVER accepted from the body (`credentialId` comes from the URL).

**And** the parent credential must exist within the caller's org+project. Verify it under the RLS-scoped `tx` before inserting; if it does not exist (wrong org, wrong project, or missing) return `404 { code: "credential_not_found", message: "Credential not found" }` — both "wrong org" and "missing" return 404 (no enumeration; Story 2.1/2.2/2.3 precedent):

```typescript
const [cred] = await tx
  .select({ id: credentials.id })
  .from(credentials)
  .where(and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId)))
  .limit(1)
if (!cred) return reply.status(404).send({ code: 'credential_not_found', message: 'Credential not found' })

// Per-credential active-dependency cap (abuse/DoS guard + bounds Epic 5 checklist size).
const [{ count }] = await tx
  .select({ count: sql<number>`count(*)` })
  .from(credentialDependencies)
  .where(and(eq(credentialDependencies.credentialId, params.credentialId), isNull(credentialDependencies.archivedAt)))
if (Number(count) >= MAX_ACTIVE_DEPENDENCIES) {
  return reply.status(422).send({ code: 'too_many_dependencies', message: 'A credential may have at most 200 active dependencies' })
}

const [dependency] = await tx
  .insert(credentialDependencies)
  .values({
    orgId: auth.orgId,
    credentialId: params.credentialId,
    systemName: body.systemName,
    systemType: body.systemType ?? 'other',
    notes: body.notes ?? null,
    createdBy: auth.userId,
  })
  .returning()
```

**And** duplicate dependencies are **allowed** — two rows with the same `systemName` on the same credential are not an error (a credential can be consumed by two pipelines that happen to share a name; de-duplication is a UI concern, not a data invariant). Do NOT add a unique constraint on `(credential_id, system_name)`.

**And** a credential may have at most **`MAX_ACTIVE_DEPENDENCIES = 200`** non-archived dependencies; a POST that would exceed it returns `422 { code: "too_many_dependencies", message: "A credential may have at most 200 active dependencies" }`. This bounds both abuse (a flood of rows) and the size of the Epic 5 rotation checklist generated from these records. Archived dependencies do NOT count toward the cap (archive one to add another). Define the constant alongside the schemas in `apps/api/src/modules/credentials/schema.ts`.

**And** the SecureRoute security + audit config (POST has no resource id in the URL params for the new row, so stash the new id with the custom-`auditWriter` pattern established in Story 2.1 AC-4 / 2.2 AC-4):
```typescript
security: {
  minimumRole: 'member',
  requireMfa: false,
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'POST …/credentials/:credentialId/dependencies' },
  writeAuditEvent: { eventType: 'credential.dependency_added', resourceType: 'credential', resourceIdFromParams: 'credentialId' },
}
// In handler after insert, stash the dependency id + payload metadata:
;(req as unknown as { auditResource?: { id: string; dependencyId: string; systemType: string } }).auditResource =
  { id: params.credentialId, dependencyId: dependency.id, systemType: dependency.systemType }
```
- The audit `resourceId` is the **credential id** (the thing being protected); the payload records `{ dependencyId, systemName, systemType }`. `systemName`/`notes` are non-secret metadata and may appear in the audit payload (contrast: a credential **value** never may). Do NOT put `notes` in the payload if it is large — record `systemName` + `systemType` + `dependencyId` only.

---

### AC-4: `GET /api/v1/projects/:projectId/credentials/:credentialId/dependencies` — List Dependencies

**Given** the caller has at least `viewer` role,
**When** they list a credential's dependencies,
**Then** return **non-archived** dependencies by default, newest-first, plus the `hasDependencies` coverage flag.

**Request (active only — default):**
```http
GET /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/dependencies
```

**Request (include archived):**
```http
GET /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/dependencies?includeArchived=true
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000500",
        "credentialId": "00000000-0000-4000-8000-000000000100",
        "systemName": "billing-worker (prod)",
        "systemType": "ci_pipeline",
        "notes": "GitHub Actions deploy pipeline reads this key from the prod environment secret.",
        "createdBy": "00000000-0000-4000-8000-000000000001",
        "archivedAt": null,
        "createdAt": "2026-06-28T16:00:00.000Z",
        "updatedAt": "2026-06-28T16:00:00.000Z"
      }
    ],
    "hasDependencies": true
  }
}
```

**And** filtering:
- Default (no `includeArchived`, or `includeArchived=false`): `WHERE credential_id = :id AND archived_at IS NULL`.
- `?includeArchived=true`: returns ALL rows (active + archived); archived rows have a non-null `archivedAt`.
- `includeArchived` is coerced from the query string (`z.coerce.boolean()` or an explicit `'true'`/`'false'` enum — mirror the existing query-coercion precedent). An unknown query key → `422` (`.strict()`).

**And** `hasDependencies` in the response reflects whether the credential has **at least one non-archived** dependency (it is `false` even when `includeArchived=true` returns only archived rows). This is the same value AC-8 surfaces on the list; compute it from the same "active dependency exists" predicate so the two surfaces never disagree.

**And** ordering is `created_at DESC, id DESC` (stable tiebreak). This list is **not paginated** in 2.4 — a single credential's dependency count is small and bounded by practice; if it ever needs pagination that is a follow-up (document this; do NOT invent a second pagination shape here).

**And** the parent credential must exist in the caller's org+project (else `404 credential_not_found`); an existing credential with no dependencies returns `200 { items: [], hasDependencies: false }` (not 404).

**Security config:**
```typescript
security: {
  minimumRole: 'viewer',
  writeAuditEvent: false,   // metadata read; classified 'read' in route-exemptions
  rateLimit: { max: 120, timeWindowMs: 60_000, key: 'GET …/credentials/:credentialId/dependencies' },
}
```

---

### AC-5: `DELETE /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId` — Archive (Soft-Delete) Dependency

**Given** a dependency exists and the caller has at least `member` role,
**When** they archive it,
**Then** perform a **soft-archive** — set `archived_at = now()` and `archived_by = auth.userId`; the row is preserved (NOT physically deleted).

**Request:**
```http
DELETE /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/dependencies/00000000-0000-4000-8000-000000000500
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000500",
    "credentialId": "00000000-0000-4000-8000-000000000100",
    "archivedAt": "2026-06-28T17:30:00.000Z"
  }
}
```

**And** the archive UPDATE is RLS-scoped and matches both the dependency id AND its parent credential to prevent cross-credential archival. **`credential_dependencies` has no `project_id` column**, so the parent credential's membership in `:projectId` MUST be verified first (consistent with AC-3/AC-6/AC-7) — never trust the URL `:projectId` against a dependency the table can't scope to a project on its own:
```typescript
// 1. Verify the parent credential exists in the caller's org+project (RLS scopes org;
//    this adds the project scope the dependency row cannot carry on its own).
const [cred] = await tx
  .select({ id: credentials.id })
  .from(credentials)
  .where(and(eq(credentials.id, params.credentialId), eq(credentials.projectId, params.projectId)))
  .limit(1)
if (!cred) return reply.status(404).send({ code: 'dependency_not_found', message: 'Dependency not found' })

// 2. Archive, matching dependency id + parent credential id; idempotency guard via isNull.
const [archived] = await tx
  .update(credentialDependencies)
  .set({ archivedAt: new Date(), archivedBy: auth.userId })
  .where(and(
    eq(credentialDependencies.id, params.dependencyId),
    eq(credentialDependencies.credentialId, params.credentialId),
    isNull(credentialDependencies.archivedAt),          // idempotency guard (see below)
  ))
  .returning({ id: credentialDependencies.id, credentialId: credentialDependencies.credentialId, archivedAt: credentialDependencies.archivedAt })
```

> **Project-scope invariant for ALL dependency sub-routes:** because `credential_dependencies` carries only `credential_id` + `org_id` (no `project_id`), every route under `…/:projectId/credentials/:credentialId/dependencies…` (POST, GET, DELETE) MUST verify the parent credential belongs to `:projectId` — either by the prior `credentials` existence check (POST/DELETE/GET) or by matching `(id, projectId)` in the mutation (PATCH). Do NOT rely on the dependency row alone; a same-org caller passing a mismatched `:projectId` must get `404`, not a cross-project archive/read.

**And** behavior matrix:
| Situation | Result |
|---|---|
| Active dependency exists, owned | `200` with `archivedAt` set; row hidden from the default list, present with `?includeArchived=true`. |
| Already archived (the `isNull(archived_at)` guard matches 0 rows, but the row exists) | **Idempotent `200`** — re-fetch the row (it is already archived) and return its existing `archivedAt`. Archiving twice is not an error. Do NOT return 404 for an already-archived dependency that the caller owns. |
| Dependency id not found / wrong credential / wrong project / wrong org | `404 { code: "dependency_not_found", message: "Dependency not found" }` (no enumeration). |

> Implementation note: distinguish "already archived" (return its `archivedAt`) from "truly absent" (`404`) with a follow-up existence select scoped to `(id, credentialId)` when the conditional UPDATE returns 0 rows. Do not collapse both into 404 — re-archiving must be idempotent so retried/duplicate clicks are safe.

**And** archived dependencies are **excluded from Epic 5 rotation-checklist generation** (Story 5.1 reads `WHERE archived_at IS NULL`). This is the entire point of soft-archive: a system that no longer consumes the credential stops appearing on future rotation checklists, but its historical participation in past rotations remains intact via the preserved row + the `rotation_checklist_items.dependencyId` FK.

**And** there is no "unarchive" endpoint in 2.4 (out of scope — re-add a new dependency instead). Document this.

**And** archive is **not coordinated with an in-flight Epic 5 rotation initiation** — and intentionally so. Story 5.1 acquires a credential advisory lock and **snapshots** each non-archived dependency's `systemName` into a `rotation_checklist_items` row (with a `dependencyId` FK to the preserved row). Because archive only sets `archived_at` (READ COMMITTED, never deletes), a concurrent rotation either sees the dependency or does not — no corruption, no dangling FK either way. Do NOT add an advisory lock to the archive path; lock ownership for rotation belongs to Epic 5.

**Security config:**
```typescript
security: {
  minimumRole: 'member',
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'DELETE …/credentials/:credentialId/dependencies/:dependencyId' },
  writeAuditEvent: { eventType: 'credential.dependency_archived', resourceType: 'credential', resourceIdFromParams: 'credentialId' },
}
```
- Audit payload: `{ dependencyId, systemName }` (read from the row); `resourceId` = credential id. Actor recorded as `actorTokenId` (PJ6).

---

### AC-6: `PATCH /api/v1/projects/:projectId/credentials/:credentialId` — Set/Clear Expiry & Rotation Schedule (FR15)

**Given** a credential exists and the caller has at least `member` role,
**When** they set or clear the expiry date and/or rotation schedule,
**Then** update `credentials.expires_at` and/or `credentials.rotation_schedule` with full validation.

> **This is the credential-root PATCH** (`url: '/:projectId/credentials/:credentialId'`). It is DISTINCT from Story 2.3's tag PATCH (`…/:credentialId/tags`). Do not merge them.

**Request (set both):**
```http
PATCH /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100
Content-Type: application/json

{
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "rotationSchedule": "0 3 1 * *"
}
```

**Request (clear rotation schedule, leave expiry untouched):**
```http
PATCH /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100
Content-Type: application/json

{ "rotationSchedule": null }
```

**Successful response (`200 OK`) — metadata only:**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000100",
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "rotationSchedule": "0 3 1 * *",
    "updatedAt": "2026-06-28T18:00:00.000Z"
  }
}
```

**Partial-update semantics (three-state per field):**
| Field state in request body | Effect |
|---|---|
| Key **absent** | Field is left unchanged. |
| Key present with a **value** | Field is set to that value (after validation). |
| Key present and **`null`** | Field is cleared (`NULL`). |

- Distinguish "absent" from "null" using the parsed object's own keys (e.g. `'rotationSchedule' in body`), NOT a truthiness check — `null` must clear, absence must no-op. Build the Drizzle `.set({...})` object dynamically from only the present keys.
- A body with **neither** key present → `422 { code: "no_fields_to_update", message: "Provide expiresAt and/or rotationSchedule" }` (do not issue a no-op UPDATE).
- The body is `.strict()` — only `expiresAt` and `rotationSchedule` are accepted; any other key (including `name`, `tags`, `value`) → `422`. (Name/description editing and value changes are NOT part of this PATCH; value changes go through 2.2's add-version path; `tags` through 2.3's tag routes.)

**`expiresAt` validation:**
- Optional ISO 8601 datetime string, or `null` to clear.
- A non-ISO string → `422 { code: "validation_error" }`.
- A **past** `expiresAt` is **allowed** (you may record that a credential already expired). Do not reject past dates — the 2.3 `status=expired` filter depends on past expiry being storable.

**`rotationSchedule` validation — FULL cron semantics + max-frequency (the core of this AC):**
- Optional standard **5-field** cron string (`minute hour day-of-month month day-of-week`), or `null` to clear.
- Validate with `cron-parser` (real parse, not the 2.2 shape-only regex). A string `cron-parser` cannot parse → `422 { code: "invalid_cron", message: "Invalid cron expression" }`.
- **Max frequency: every 1 hour.** Reject any schedule whose **smallest** consecutive-fire gap (sampled across the next several occurrences — see shared util below) is **less than 60 minutes** → `422 { code: "invalid_cron", message: "Rotation schedule may run at most once per hour" }`. Examples: `* * * * *` (every minute) → reject; `*/30 * * * *` (every 30 min) → reject; `0 23,0 * * *` (fires 23:00 then 00:00 — a 1h gap hidden mid-cycle) → reject; `0 * * * *` (hourly) → accept; `0 3 1 * *` (monthly) → accept.
- Seconds-level (6-field) cron is rejected (5-field only) — a 6-field expression is treated as `invalid_cron` for this story (document; pg-boss/Epic 5 use 5-field).
- **Impossible-date crons** (e.g. `0 0 30 2 *` — February 30 never occurs) parse successfully but throw during iteration; they MUST resolve to `invalid_cron`, not a `500`. The shared util guards iteration (see below).

**Shared validator (NEW) — `packages/shared/src/validation/rotation-cron.ts`:**
```typescript
import { CronExpressionParser } from 'cron-parser'

const MIN_INTERVAL_MS = 60 * 60 * 1000 // max frequency: once per hour
const SAMPLE_OCCURRENCES = 6           // sample 6 fire times -> 5 consecutive gaps

export type RotationCronResult =
  | { ok: true }
  | { ok: false; reason: 'unparseable' | 'too_frequent' }

/**
 * Validate a 5-field rotation cron: parseable AND fires at most once per hour.
 * Hardened: BOTH parse and iteration are guarded (impossible dates like "0 0 30 2 *"
 * parse but throw on next()), and we sample several consecutive fire times rather than
 * just the first pair (irregular crons like "0 23,0 * * *" can hide a sub-hour gap that
 * is not the first delta).
 */
export function validateRotationCron(expr: string): RotationCronResult {
  // 5-field only: reject 6-field (seconds) up front.
  if (expr.trim().split(/\s+/).length !== 5) return { ok: false, reason: 'unparseable' }
  try {
    const interval = CronExpressionParser.parse(expr)
    const times: number[] = []
    for (let i = 0; i < SAMPLE_OCCURRENCES; i++) {
      times.push(interval.next().toDate().getTime()) // may throw on impossible dates -> caught below
    }
    // Reject if ANY consecutive pair fires < 1h apart (min gap over the sample window).
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < MIN_INTERVAL_MS) return { ok: false, reason: 'too_frequent' }
    }
    return { ok: true }
  } catch {
    // parse failure OR an iteration that throws (impossible date, parser max-iteration ceiling)
    return { ok: false, reason: 'unparseable' }
  }
}
```
- Add `cron-parser` (`^5.6.1`, the current stable as of 2026-06 — `CronExpressionParser.parse` static entrypoint, v5+) to `packages/shared/package.json` dependencies. Export `validateRotationCron` from `packages/shared/src/index.ts`.
- **Both `parse()` and every `next()` are inside the `try`** — a cron that parses but throws while iterating (e.g. `"0 0 30 2 *"` — February 30 never occurs, so the parser exhausts its iteration ceiling) MUST resolve to `invalid_cron`, never an uncaught `500`. Do not move the `next()` loop outside the `try`.
- The min-gap is checked across **all sampled consecutive pairs**, not just the first, so an irregular schedule whose smallest interval is not the first pair (e.g. `"0 23,0 * * *"`) is still correctly evaluated.
- **Cross-story reconciliation (ADR-2.4-03):** REPLACE Story 2.2's shape-only `CRON_REGEX` in `apps/api/src/modules/credentials/schema.ts` create body with `validateRotationCron()` (call it in a Zod `.refine`/`.superRefine`, returning the `invalid_cron` code) so the create path (2.2) and this PATCH validate **identically**. After this story, a too-frequent or unparseable cron is rejected at BOTH create and PATCH. Update/clarify the 2.2 create test that previously accepted `"a b c d e"` — it must now be rejected.

**And** cross-org/cross-project/missing credential → `404 credential_not_found` (the `.returning()` 0-row check; do not fabricate a 200). The PATCH UPDATE matches `(id, projectId)` and is RLS-scoped by org.

**And** `updated_at` is bumped by the existing `set_updated_at` trigger on `credentials` (this is an UPDATE).

**Security config:**
```typescript
security: {
  minimumRole: 'member',
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'PATCH …/credentials/:credentialId' },
  writeAuditEvent: { eventType: 'credential.lifecycle_updated', resourceType: 'credential', resourceIdFromParams: 'credentialId' },
}
```
- Audit payload records the **changed fields** for forensic reconstruction (non-secret metadata): `{ changed: ('expiresAt' | 'rotationSchedule')[], expiresAt, rotationSchedule }` (the new values, or `null` for cleared). NEVER the credential value.

---

### AC-7: `GET /api/v1/projects/:projectId/credentials/:credentialId/access` — Access List (FR64)

**Given** the caller has `admin` or `owner` role,
**When** they ask who can access a specific credential,
**Then** return the list of identities that currently have access **based on org roles** (v1 has no per-project RBAC — Story 4.1).

**Request:**
```http
GET /api/v1/projects/.../credentials/00000000-0000-4000-8000-000000000100/access
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "items": [
      { "identityType": "user", "displayName": "alice@example.com", "role": "owner",  "grantedAt": "2026-05-01T09:00:00.000Z" },
      { "identityType": "user", "displayName": "bob@example.com",   "role": "member", "grantedAt": "2026-05-10T11:30:00.000Z" }
    ]
  }
}
```

**And** the list is derived from **active org memberships** joined to `users` for the display name (there is no per-credential grant table in v1 — ADR-2.4-04):
```typescript
const items = await tx
  .select({
    displayName: users.email,                 // no separate display-name column exists yet; email is the identifier
    role: orgMemberships.role,
    grantedAt: orgMemberships.createdAt,       // membership creation = when access was granted
  })
  .from(orgMemberships)
  .innerJoin(users, eq(users.id, orgMemberships.userId))
  .where(and(eq(orgMemberships.orgId, auth.orgId), eq(orgMemberships.status, 'active')))
  .orderBy(desc(orgMemberships.createdAt))
// identityType is constant 'user' until Epic 7 adds machine users.
```
- `identityType` is always `'user'` in 2.4. The field exists now so Epic 7 can append `{ identityType: 'machine_user', … }` rows with **no shape change** (the epic AC: "users and machine users (once Epic 7 exists)").
- `displayName` = the user's `email` (the `users` table has no separate name column — AC verified against `packages/db/src/schema/users.ts`). Document this; a richer display name is a future enhancement.
- `role` is the org role (`owner | admin | member | viewer`); `grantedAt` is the membership `created_at` — i.e. when the user **joined the org**, NOT when their current role was last granted. A later role change (e.g. member→admin) does not move `grantedAt` (there is no per-role-change timestamp on `org_memberships`). Document this so it is not misread as "role granted at".
- **Deactivated** memberships (`status != 'active'`) are excluded — a deactivated user no longer has access.

**And** the parent credential must exist in the caller's org+project (else `404 credential_not_found`) — verify before returning the org-membership list, so calling `access` on a foreign/missing credential does not leak the org roster.

**And** this endpoint exposes only **role metadata** — never any credential value, version, or encrypted material. It does not touch `credential_versions`.

**Security config:**
```typescript
security: {
  allowedRoles: ['owner', 'admin'],   // FR64: admin/owner only (matches the org security-alerts route convention)
  writeAuditEvent: false,             // metadata read; classified 'read' in route-exemptions (see ADR-2.4-06)
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET …/credentials/:credentialId/access' },
}
```
- `403` for `member`/`viewer` callers; `401` unauthenticated; `503` if vault sealed.

---

### AC-8: `hasDependencies` Coverage-Gap Flag on the Credential List (UX-DR7)

**Given** UX-DR7 wants the UI to surface credentials that have **no recorded dependencies** (a rotation coverage gap), and Story 2.3 deliberately deferred this flag to 2.4,
**When** Story 2.4 lands,
**Then** add a `hasDependencies: boolean` field to each item of the Story 2.3 credential **list** response (`GET /api/v1/projects/:projectId/credentials`).

**Amended list item (additive — all 2.3 fields retained):**
```json
{
  "id": "00000000-0000-4000-8000-000000000100",
  "projectId": "00000000-0000-4000-8000-000000000010",
  "name": "Stripe Secret Key",
  "description": "Production Stripe API secret",
  "tags": ["payments", "prod"],
  "status": "active",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "rotationSchedule": "0 3 1 * *",
  "currentVersionNumber": 2,
  "hasDependencies": false,
  "createdAt": "2026-06-27T20:00:00.000Z",
  "updatedAt": "2026-06-28T18:00:00.000Z"
}
```

**And** `hasDependencies` is computed with an `EXISTS` subquery on **non-archived** dependencies — never a denormalized counter column (ADR-2.4-05), and never a value-bearing join:
```typescript
// Added to the SELECT projection in the existing 2.3 list query — metadata only, no value.
hasDependencies: sql<boolean>`EXISTS (
  SELECT 1 FROM credential_dependencies d
  WHERE d.credential_id = ${credentials.id} AND d.archived_at IS NULL
)`
```

**And** extend `CredentialSummarySchema` in `packages/shared/src/schemas/credentials.ts` with `hasDependencies: z.boolean()` (additive — do not alter the existing fields). All Story 2.3 list tests must remain green (the field is additive; update the 2.3 list-shape assertion to include it).

**And** `hasDependencies` reflects active dependencies only: a credential whose every dependency has been archived shows `hasDependencies: false` (it has a coverage gap again). This matches the AC-4 dependency-list flag exactly (same predicate).

**And** this is the ONLY change to the 2.3 list endpoint — do not alter its filters, pagination, ordering, or the never-index-values guarantee.

---

### AC-9: Shared & API Zod Schemas

**Given** response shapes the web app consumes live in `@project-vault/shared` (Story 2.1/2.2/2.3 precedent), and request schemas live in the API module,
**When** Story 2.4 adds schemas,
**Then**:

**`packages/shared/src/schemas/credential-dependencies.ts` (NEW — web-consumed shapes):**
```typescript
import { z } from 'zod/v4'

export const SystemTypeSchema = z.enum(['service', 'ci_pipeline', 'database', 'third_party', 'other'])

export const CredentialDependencySchema = z.object({
  id: z.uuid(),
  credentialId: z.uuid(),
  systemName: z.string(),
  systemType: SystemTypeSchema,
  notes: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).meta({ id: 'CredentialDependency' })

export const CredentialAccessEntrySchema = z.object({
  identityType: z.enum(['user', 'machine_user']),
  displayName: z.string(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  grantedAt: z.iso.datetime(),
}).meta({ id: 'CredentialAccessEntry' })

export type SystemType = z.infer<typeof SystemTypeSchema>
export type CredentialDependency = z.infer<typeof CredentialDependencySchema>
export type CredentialAccessEntry = z.infer<typeof CredentialAccessEntrySchema>
```
Add `export * from './schemas/credential-dependencies.js'` to `packages/shared/src/index.ts`.

**`packages/shared/src/schemas/credentials.ts` (EXTEND — Story 2.2/2.3 created this):** add `hasDependencies: z.boolean()` to `CredentialSummarySchema` (AC-8). Do NOT modify the other fields.

**`packages/shared/src/validation/rotation-cron.ts` (NEW):** the `validateRotationCron()` util (AC-6). Export from `packages/shared/src/index.ts`.

**`apps/api/src/modules/credentials/schema.ts` (EXTEND — Story 2.2/2.3 created this):**
```typescript
import { z } from 'zod/v4'
import { SystemTypeSchema } from '@project-vault/shared'
import { validateRotationCron } from '@project-vault/shared'

// Per-credential active-dependency cap (AC-3) — abuse guard + bounds Epic 5 checklist size.
export const MAX_ACTIVE_DEPENDENCIES = 200

export const AddDependencyBodySchema = z.object({
  systemName: z.string().trim().min(1).max(256),
  systemType: SystemTypeSchema.optional(),
  notes: z.string().trim().max(2048).nullable().optional(),
}).strict().meta({ id: 'AddDependencyBody' })

export const ListDependenciesQuerySchema = z.object({
  includeArchived: z.coerce.boolean().optional().default(false),
}).strict().meta({ id: 'ListDependenciesQuery' })

export const DependencyParamsSchema = z.object({
  projectId: z.uuid(), credentialId: z.uuid(), dependencyId: z.uuid(),
}).meta({ id: 'DependencyParams' })

// Credential-root PATCH (lifecycle). superRefine routes cron failures to the invalid_cron code.
export const UpdateCredentialLifecycleBodySchema = z.object({
  expiresAt: z.iso.datetime().nullable().optional(),
  rotationSchedule: z.string().trim().nullable().optional(),
}).strict()
  .superRefine((val, ctx) => {
    if (typeof val.rotationSchedule === 'string') {
      const res = validateRotationCron(val.rotationSchedule)
      if (!res.ok) {
        ctx.addIssue({ code: 'custom', path: ['rotationSchedule'], message: 'invalid_cron' })
      }
    }
  })
  .meta({ id: 'UpdateCredentialLifecycleBody' })

// Response envelopes
export const DependencyResponseSchema = z.object({ data: CredentialDependencySchema }).meta({ id: 'DependencyResponse' })
export const DependencyListResponseSchema = z.object({
  data: z.object({ items: z.array(CredentialDependencySchema), hasDependencies: z.boolean() }),
}).meta({ id: 'DependencyListResponse' })
export const DependencyArchivedResponseSchema = z.object({
  data: z.object({ id: z.uuid(), credentialId: z.uuid(), archivedAt: z.iso.datetime() }),
}).meta({ id: 'DependencyArchivedResponse' })
export const CredentialLifecycleResponseSchema = z.object({
  data: z.object({ id: z.uuid(), expiresAt: z.iso.datetime().nullable(), rotationSchedule: z.string().nullable(), updatedAt: z.iso.datetime() }),
}).meta({ id: 'CredentialLifecycleResponse' })
export const CredentialAccessListResponseSchema = z.object({
  data: z.object({ items: z.array(CredentialAccessEntrySchema) }),
}).meta({ id: 'CredentialAccessListResponse' })
```

**And** notes:
- The lifecycle body uses `.superRefine` for the cron rule but the handler must ALSO map a cron failure to the literal `{ code: "invalid_cron" }` response shape the epic requires (the generic `validationError` envelope is acceptable only if it surfaces `invalid_cron`). Prefer: validate cron explicitly in the handler with `validateRotationCron` and return `422 { code: "invalid_cron", message: <too_frequent vs unparseable> }`, keeping the schema-level `.superRefine` as a belt-and-suspenders guard.
- The "neither field present" → `422 no_fields_to_update` check is enforced in the **handler** (Zod cannot easily express "at least one of two optional keys present" together with the absent/null distinction) — check `!('expiresAt' in body) && !('rotationSchedule' in body)`.
- `z.coerce.boolean()` treats any non-empty string as `true` (including `'false'`). To honor `includeArchived=false` literally, prefer `z.enum(['true','false']).transform(v => v === 'true').optional().default('false' as const)` OR explicitly compare `req.query.includeArchived === 'true'` in the handler. Pick one and test the `=false` case.
- Wire every response schema to the route's `schema.response`; convert Drizzle `Date` → ISO string before sending (Story 2.1/2.2/2.3 timestamp note).

---

### AC-10: Route Registration, Audit Classification & Audit-Event Constants

**Given** the route-audit CI gate (`route-audit.test.ts`) reads `ROUTE_FILES` + `ROUTE_ACTION_CLASSIFICATIONS`,
**When** Story 2.4 adds the new routes,
**Then**:

1. **Credentials module** (`apps/api/src/modules/credentials/routes.ts`, created by 2.2 — already in `ROUTE_FILES`): add the four new routes (POST dependency, GET dependencies, DELETE dependency, PATCH lifecycle, GET access). No `ROUTE_FILES` change needed; confirm the module is present in the list.
2. Each route declares the `:projectId`/`:credentialId`/`:dependencyId` params in its `url` (NOT in the plugin prefix) — mirror the exact convention 2.2/2.3 used (Fastify does not reliably populate `req.params` from a plugin-prefix param). e.g. `url: '/:projectId/credentials/:credentialId/dependencies'`.
3. Add all new routes to `ROUTE_ACTION_CLASSIFICATIONS` in `apps/api/src/lib/route-exemptions.ts`:
```typescript
'POST /api/v1/projects/:projectId/credentials/:credentialId/dependencies': {
  action: 'mutation', auditEvent: 'credential.dependency_added',
},
'GET /api/v1/projects/:projectId/credentials/:credentialId/dependencies': {
  action: 'read',
  auditOmissionReason: 'Dependency list returns non-secret metadata only; never any credential value.',
  reviewer: 'api-security-reviewer',
},
'DELETE /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId': {
  action: 'mutation', auditEvent: 'credential.dependency_archived',
},
'PATCH /api/v1/projects/:projectId/credentials/:credentialId': {
  action: 'mutation', auditEvent: 'credential.lifecycle_updated',
},
'GET /api/v1/projects/:projectId/credentials/:credentialId/access': {
  action: 'read',
  auditOmissionReason: 'Access list returns org-role metadata only; never any credential value (ADR-2.4-06).',
  reviewer: 'api-security-reviewer',
},
```
4. Add the three new audit event names to `AuditEventType` in `packages/shared/src/constants/audit-events.ts`: `'credential.dependency_added'`, `'credential.dependency_archived'`, `'credential.lifecycle_updated'`. Keep the strings byte-identical across classifications, `writeAuditEvent`, payloads, and this union. (If the stale `secret.*` members still linger from before 2.2, delete them here too.) Run `pnpm --filter @project-vault/shared test` + `pnpm typecheck` after.
5. After updating, run `route-audit.test.ts` in isolation and confirm all five routes appear and are classified (two `read` with omission reasons, three `mutation` with audit events). Confirm the gate accepts a `read` GET with an omission reason (precedent: `GET /api/v1/auth/sessions`, the 2.3 list route).

---

### AC-11: Security Hardening (Story-Specific Invariants)

**Given** Project Vault is a secrets manager,
**When** Story 2.4 routes are implemented,
**Then** satisfy every invariant below:

| Threat | Required mitigation |
|---|---|
| Any credential **value** exposure | This entire story touches ONLY metadata. NO route reads `credential_versions.encrypted_value`, decrypts, or returns a value. The `EXISTS` subquery (AC-8) and access join (AC-7) never reference value columns. A regression test scans every 2.4 response body for a seeded sentinel value and asserts absence. |
| Cross-org access | RLS scopes every `tx` by org; handlers additionally constrain `credentialId`/`projectId`/`dependencyId`. Both "wrong org" and "missing" return `404` (no enumeration). The access list is scoped to `auth.orgId` only. |
| Cross-credential archive | The archive UPDATE matches `(dependencyId, credentialId)` together — a dependency id from another credential returns `404`, never archives a foreign row. |
| Mass assignment | All bodies/queries `.strict()`; Drizzle writes use Zod-parsed output, never raw `req.body`. `orgId`/`credentialId`/`id`/`archivedAt`/`createdBy` never accepted from the body. |
| Cron DoS / unbounded compute | `validateRotationCron` parses with `cron-parser` and computes only the **next two** fire times (O(1)) — never iterates unboundedly. 5-field length check rejects 6-field before parsing. |
| Over-frequent rotation schedule | Schedules firing more than once per hour are rejected (`422 invalid_cron`) at both create and PATCH — prevents a pathological `* * * * *` from later flooding Epic 5/6 jobs. |
| Mutation without audit | Dependency add/archive + lifecycle PATCH are fail-closed on audit via SecureRoute same-tx `writeAuditEvent` — a failed audit write rolls the mutation back and returns `503 audit_write_failed`. |
| Access roster leak via missing-credential probe | AC-7 verifies the credential exists in the caller's org+project BEFORE returning the org-membership list, so probing `…/<foreign-or-missing-id>/access` returns `404`, not the org roster. |
| Vault sealed | The dependency/lifecycle/access routes are NOT on the `vault-guard` allowlist → `503 { status: "sealed" }` while sealed. Assert for at least one dependency route, the PATCH, and the access route. |
| Privilege escalation on access list | Access list is `allowedRoles: ['owner','admin']`; `member`/`viewer` get `403`. Dependency + lifecycle mutations require `member` (viewer → `403`). |
| Cross-org leak via `EXISTS` subquery / access join | The `hasDependencies` `EXISTS` (on `credential_dependencies`) and the access-list join (on `org_memberships`) run inside the SecureRoute RLS-scoped `tx`; both tables carry an `org_id` RLS policy, so a missing/empty `app.current_org_id` GUC returns **zero rows (fail-closed)**, never another org's data. A test asserts both surfaces are RLS-scoped (run a bare query without org context → empty). |
| Dependency flooding (abuse / Epic 5 blast radius) | A per-credential cap of `MAX_ACTIVE_DEPENDENCIES = 200` non-archived rows (AC-3) returns `422 too_many_dependencies`, bounding both row growth and the size of the rotation checklist Epic 5 generates. The 60/min rate limit is a secondary burst bound. |
| Cron iteration crash / DoS | `validateRotationCron` guards BOTH `parse()` and every `next()` in one `try` (impossible dates throw on iteration → `invalid_cron`, never `500`), samples a fixed small number of occurrences (O(1), no unbounded iteration), and rejects 6-field expressions before parsing. |
| Notes/systemName injection or PII | `systemName`/`notes` are stored verbatim (trimmed, bounded), never interpolated into raw SQL (parameterized Drizzle inserts), never indexed for search in 2.4. They may contain user PII — recording `systemName` in the audit payload is acceptable (non-secret metadata); PII erasure for these fields is Epic 8 scope. |

**Accepted residual risks (documented, not blocking):**
- **Access list is org-role-derived, not per-project (R-AC7):** in v1 every active org member appears in every credential's access list per their org role; there is no per-project narrowing. Story 4.1 (per-project RBAC) refines this. The `{ identityType, displayName, role, grantedAt }` shape is forward-compatible. Documented, not a bug.
- **`displayName` is the email:** the `users` table has no separate display-name column; `email` is used. A richer profile name is a future enhancement.
- **Duplicate dependencies allowed (and their Epic 5 consequence):** no unique constraint on `(credential_id, system_name)`; two systems with the same name are two distinct rows (distinct `dependencyId`s). De-dup is a UI concern. **Downstream:** Story 5.1 generates one `rotation_checklist_items` row per non-archived dependency, so duplicate-named dependencies produce two same-named-but-independently-confirmable checklist items — intended (they are distinct systems sharing a label). Do NOT add a unique constraint to collapse them; that would break the intended model. Documented.
- **Cron timezone:** `validateRotationCron` validates in the server's default timezone; the max-frequency interval check is timezone-agnostic (it compares two consecutive fire deltas). Per-credential rotation timezones are out of scope (Epic 5+ may add a `tz` option).
- **No unarchive:** archived dependencies cannot be un-archived in 2.4; re-add a new dependency instead. Documented.
- **Secret pasted into `systemName`/`notes`:** these are free-text metadata stored unencrypted and may appear in the dependency-added audit payload. A user who mistakenly pastes a real secret into a system name/notes field exposes it as metadata. This is the same residual class as Story 2.3's free-text tags — no scrubbing in 2.4; PII/secret handling for free-text fields is Epic 8 scope. Documented, not blocking.

---

### AC-11A: Operational Metrics & Logging

**Given** Story 1.10 established the structured operational logger conventions,
**When** Story 2.4 routes run,
**Then** emit these structured operational signals (Story 1.10 logger). **NEVER log credential values** (this story never holds one) — and never log full `notes` content (it may contain PII; log `dependencyId`/`systemType` instead).

| Signal | Where | What to emit |
|---|---|---|
| `credential.dependency.added` | POST dependency, after commit | `{ orgId, credentialId, dependencyId, systemType }` |
| `credential.dependency.archived` | DELETE dependency, after commit | `{ orgId, credentialId, dependencyId }` |
| `credential.lifecycle.updated` | PATCH lifecycle, after commit | `{ orgId, credentialId, changed: ['expiresAt'|'rotationSchedule'] }` (field NAMES only, not values) |
| `credential.lifecycle.invalid_cron` | PATCH lifecycle, on rejection | `{ orgId, credentialId, reason: 'unparseable' | 'too_frequent' }` — operators see WHY a schedule was rejected without logging the cron string content (the cron string is non-secret, so logging it is acceptable but the reason code is the primary signal) |
| `credential.audit_write_failed` | all three mutations | `{ orgId, eventType, resourceId }` when the same-tx audit write throws and the tx rolls back (client gets `503`) — the fail-closed signal must be observable, not silent |

**And** these operational logs are **in addition to** the mandatory audit rows (`credential.dependency_added` / `credential.dependency_archived` / `credential.lifecycle_updated`) — operational logging never replaces the audit trail.

---

### AC-12: Integration & Unit Tests

> Follow repo TDD red-green (`AGENTS.md`): write failing tests first, confirm the failure reason, implement the smallest change, then re-run focused + broader checks. All DB/integration tests run with RLS active (`withTestOrg()`/`withOrg()`); never assert state from a bare `getDb()` query without org context (it silently returns zero rows and false-passes). Reuse `registerAndLoginViaApi` + `cookieHeader` from `apps/api/src/__tests__/helpers/auth-test-helpers.ts`; vault unsealed in the harness.

**Shared unit test — `packages/shared/src/validation/rotation-cron.test.ts`:**
```
- valid hourly '0 * * * *' -> { ok: true }
- valid monthly '0 3 1 * *' -> { ok: true }
- every-minute '* * * * *' -> { ok: false, reason: 'too_frequent' }
- every-30-min '*/30 * * * *' -> { ok: false, reason: 'too_frequent' }
- irregular hidden sub-hour gap '0 23,0 * * *' -> { ok: false, reason: 'too_frequent' } (min gap is NOT the first pair)
- exactly hourly boundary '0 * * * *' -> ok (>= 60 min accepted)
- garbage 'not a cron' -> { ok: false, reason: 'unparseable' }
- impossible date '0 0 30 2 *' (Feb 30) -> { ok: false, reason: 'unparseable' } (parses but throws on next(); must NOT throw out of the util)
- 6-field '0 0 * * * *' -> { ok: false, reason: 'unparseable' } (5-field only)
- empty string -> unparseable
```

**DB-layer RLS test — `packages/db/src/__tests__/credential-dependencies-rls-isolation.test.ts`** (pattern from Story 2.2 `credentials-rls-isolation.test.ts`):
```
- credential_dependencies rows are org-isolated (withOrg(orgA) cannot see orgB rows; bare getDb() returns zero)
- WRITE-isolation: within withOrg(orgA), an INSERT with org_id = orgB is rejected by RLS (command-less ALL policy WITH CHECK default)
- system_type CHECK rejects an out-of-set value (e.g. 'frobnicator')
- archived_at defaults to NULL; setting it preserves the row (no cascade delete)
```

**API integration tests — `apps/api/src/modules/credentials/credential-dependencies.test.ts`:**
```
POST .../dependencies
  - 201 creates a dependency; response shape matches CredentialDependency; systemType defaults to 'other' when omitted
  - 201 writes credential.dependency_added audit row (resourceId = credentialId, payload has dependencyId + systemName + systemType, actorTokenId set, NO credential value)
  - 201 allows two dependencies with the same systemName (no dedup)
  - 422 missing systemName / systemName > 256 / unknown body key (.strict) / out-of-set systemType
  - 422 too_many_dependencies when a credential already has MAX_ACTIVE_DEPENDENCIES (200) active deps; archiving one then re-adding succeeds
  - 404 credential in another org (not 403) / non-existent credential / wrong project
  - 401 unauthenticated; 403 viewer; 503 vault sealed

GET .../dependencies
  - 200 returns only non-archived by default; archived row excluded
  - 200 ?includeArchived=true returns active + archived (archived has non-null archivedAt)
  - 200 ?includeArchived=false literally excludes archived (coercion correctness)
  - 200 hasDependencies true when an active dep exists; false when none / all archived
  - 200 empty { items: [], hasDependencies: false } for a real credential with no deps
  - 404 missing/foreign credential; 503 sealed

DELETE .../dependencies/:dependencyId  (soft-archive)
  - 200 sets archivedAt; row hidden from default list, present with includeArchived=true
  - 200 IDEMPOTENT: archiving an already-archived dep returns 200 with its existing archivedAt (not 404)
  - 200 writes credential.dependency_archived audit row (payload dependencyId + systemName, actorTokenId)
  - 404 dependency id from a different credential (cross-credential archive blocked) / missing / foreign org
  - 404 mismatched-but-same-org :projectId (credential belongs to project B, URL says project A) — project-scope verified, not just credentialId
  - 403 viewer; 503 sealed
  - AUDIT-FAILURE ROLLBACK: forced audit-write failure rolls back the archive, returns 503, archivedAt stays NULL

PATCH .../credentials/:credentialId  (lifecycle)
  - 200 sets expiresAt + rotationSchedule together
  - 200 partial: only expiresAt present leaves rotationSchedule unchanged
  - 200 clear: { rotationSchedule: null } nulls it; { expiresAt: null } nulls it
  - 200 past expiresAt is accepted (status=expired downstream)
  - 422 no_fields_to_update when body has neither key
  - 422 invalid_cron (unparseable) for 'nonsense' and for the impossible-date '0 0 30 2 *' (no 500)
  - 422 invalid_cron (too_frequent message) for '*/30 * * * *' and for the irregular '0 23,0 * * *'
  - 200 hourly '0 * * * *' accepted
  - 422 unknown key (.strict) incl. attempt to PATCH name/value/tags here
  - 404 missing/foreign credential; 403 viewer; 503 sealed
  - audit credential.lifecycle_updated payload { changed, expiresAt, rotationSchedule }, NO value
  - REGRESSION: 2.2 create path now also rejects '*/30 * * * *' and 'a b c d e' (shared validator wired in)

GET .../credentials/:credentialId/access
  - 200 lists active org members as [{ identityType:'user', displayName(email), role, grantedAt }]
  - 200 excludes deactivated memberships
  - 403 for member and viewer; 200 for admin and owner
  - 404 foreign/missing credential (does NOT leak the org roster); 401 unauth; 503 sealed
```

**`hasDependencies` on the 2.3 list — `apps/api/src/modules/credentials/credentials-search.test.ts` (extend):**
```
- list item includes hasDependencies; false for a dep-less credential, true after adding one, false again after archiving the only dep
- all existing 2.3 list/filter/pagination tests remain green with the added field
```

**RLS fail-closed (cross-org) — `apps/api/src/modules/credentials/credential-dependencies.test.ts` (extend):** assert the `hasDependencies` `EXISTS` subquery and the access-list join return only the caller's org data — seed two orgs, and confirm a bare query without org context (no `app.current_org_id`) returns zero rows (proving both surfaces are RLS-scoped, not application-filtered).

**Security regression (value never leaks):** one test seeds a credential with a known sentinel value (via 2.2 create), then calls every 2.4 endpoint (POST/GET/DELETE dependency, PATCH lifecycle, GET access, and the amended list) and asserts the sentinel appears in NONE of the response bodies.

---

### AC-13: Explicit Out of Scope

Do NOT implement in Story 2.4:

- **Rotation execution / checklists / `rotations` + `rotation_checklist_items` tables** — Epic 5 (Story 5.1 consumes the dependency records created here).
- **`GET …/rotations/upcoming` consolidated upcoming-rotation list (FR65)** — Story 5.2. 2.4 only stores/validates `rotationSchedule`; it does not list credentials by upcoming schedule.
- **Expiry/rotation alerting jobs (FR28/FR29)** — Epic 6. 2.4 sets `expires_at`; the daily alert job is Epic 6.
- **Per-project RBAC / per-credential grants** — Story 4.1. The access list (AC-7) is org-role-derived in v1.
- **Machine-user identities in the access list** — Epic 7. `identityType` is always `'user'` now; the shape is forward-compatible.
- **Unarchive / restore a dependency** — re-add a new dependency instead.
- **Editing a dependency's `systemName`/`systemType`/`notes` in place** — 2.4 supports add + archive only (a PATCH-dependency endpoint is a future enhancement). **Confirmed scope decision (PM):** the workaround for a typo is archive + re-add, which starts a NEW row (new `dependencyId`, new `createdAt`) and does not preserve identity/history continuity of the original. Accepted as a papercut for 2.4; revisit if in-place edit is needed.
- **Credential `name`/`description`/`value`/`tags` mutation via the lifecycle PATCH** — value via 2.2 add-version; tags via 2.3 tag routes; name/description editing is not in any current Epic 2 story.
- **Pagination of the dependency list** — a single credential's dependency set is small; add pagination only if a real need arises (do not invent a second pagination shape).
- **A single-credential detail GET endpoint** — not required here; `hasDependencies` rides the existing list (AC-8) and the dependency/access endpoints cover the detail panel. (If a detail GET is added opportunistically, keep it metadata-only.)
- **Frontend / web UI** — this story is backend only.

---

## Tasks / Subtasks

- [x] **Task 1: `credential_dependencies` schema + migration** (AC: 1, 2)
  - [x] Create `packages/db/src/schema/credential-dependencies.ts` (soft-archive `archived_at`, `system_type` CHECK, indexes).
  - [x] Export from `packages/db/src/schema/index.ts`.
  - [x] `pnpm --filter @project-vault/db generate`; confirm next free number against `meta/_journal.json` (e.g. `0016_credential_dependencies.sql`); confirm both CHECK constraints emitted (hand-add if drizzle-kit omits).
  - [x] Add the RLS policy + `updated_at` trigger to the migration.
  - [x] `pnpm --filter @project-vault/db check-rls` (no gap; do NOT exclude the table) + `migrate`.
- [x] **Task 2: DB-layer RLS isolation test** (AC: 12) — write `credential-dependencies-rls-isolation.test.ts`; confirm it fails before the schema exists, passes after (org read isolation, write isolation, system_type CHECK).
- [x] **Task 3: Shared cron validator + schemas** (AC: 6, 9)
  - [x] Add `cron-parser` `^5.6.1` to `packages/shared/package.json`.
  - [x] Create `packages/shared/src/validation/rotation-cron.ts` (`validateRotationCron`) + `rotation-cron.test.ts` (red first) — guard BOTH `parse()` and every `next()` in one try (impossible dates → `unparseable`, never throw out), and reject on the **min** gap across the sampled occurrences (covers irregular crons).
  - [x] Create `packages/shared/src/schemas/credential-dependencies.ts`; extend `schemas/credentials.ts` with `hasDependencies`; export all from `index.ts`; `pnpm --filter @project-vault/shared test`.
- [x] **Task 4: API schemas** (AC: 9) — extend `apps/api/src/modules/credentials/schema.ts` with dependency body/query/params, lifecycle body (`.superRefine` cron), and response envelopes. Unit-test `.strict()` rejection, systemType set, includeArchived coercion.
- [x] **Task 5: POST add dependency** (AC: 3, 10, 11) — failing test first; credential existence 404; active-dependency cap (`MAX_ACTIVE_DEPENDENCIES = 200`) → `422 too_many_dependencies`; insert; custom audit writer stashing dependencyId; `credential.dependency_added`.
- [x] **Task 6: GET list dependencies** (AC: 4, 10, 11) — failing test first; non-archived default + includeArchived; `hasDependencies` in response; ordering; 404; classify route `read`.
- [x] **Task 7: DELETE archive dependency** (AC: 5, 10, 11) — failing test first; soft-archive UPDATE matching `(id, credentialId)`; idempotent re-archive 200; cross-credential 404; `credential.dependency_archived`.
- [x] **Task 8: PATCH lifecycle** (AC: 6, 10, 11) — failing test first; absent/null/value three-state; `no_fields_to_update`; `invalid_cron` (unparseable incl. impossible-date `0 0 30 2 *` → no 500; too_frequent incl. irregular `0 23,0 * * *`); wire shared validator into 2.2's create body and update the 2.2 create test; `credential.lifecycle_updated`.
- [x] **Task 9: GET access list** (AC: 7, 10, 11) — failing test first; org-membership join → access entries; admin/owner only; credential existence check before roster; classify route `read`.
- [x] **Task 10: `hasDependencies` on the 2.3 list** (AC: 8) — failing test first; add the `EXISTS` subquery to the existing list query; extend `CredentialSummarySchema`; keep all 2.3 list tests green.
- [x] **Task 11: Route registration + audit constants + operational logging** (AC: 10, 11A) — register all five routes; add 3 audit event names to `AuditEventType`; classify in `ROUTE_ACTION_CLASSIFICATIONS`; emit operational signals; run `route-audit.test.ts` in isolation.
- [x] **Task 12: Security regression + audit-failure rollback** (AC: 11, 12) — value-never-leaks scan across all 2.4 responses; forced audit-write-failure rollback test on a mutation (e.g. archive).
- [x] **Task 13: Final verification** (AC: all)
  - [x] `pnpm --filter @project-vault/db test` + `check-rls`.
  - [x] `pnpm --filter @project-vault/api test` (integration + route-audit).
  - [x] `pnpm --filter @project-vault/shared test`.
  - [x] `pnpm check-search-index` (still clean — 2.4 adds no value-bearing index).
  - [x] `pnpm typecheck` + `pnpm lint` at repo root.

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| Credentials module | `apps/api/src/modules/credentials/` (created by 2.2). Add the five routes to `routes.ts`; add schemas to `schema.ts`; extract a `dependencies-service.ts` / `lifecycle-service.ts` if a handler exceeds ~60 lines. Service functions MUST accept `tx: Tx` and use it exclusively — never `getDb()` inside a handler-invoked helper (breaks RLS + the outer transaction). |
| New DB schema file | `packages/db/src/schema/credential-dependencies.ts` — exported from `schema/index.ts`. |
| Migration | `packages/db/src/migrations/<next>_credential_dependencies.sql` — verify number against `meta/_journal.json`; never hardcode. |
| Shared schema + validator | `packages/shared/src/schemas/credential-dependencies.ts`, `packages/shared/src/validation/rotation-cron.ts`; extend `schemas/credentials.ts` for `hasDependencies`. |

### Key Code Patterns to Follow

- **SecureRoute:** copy the shape from `apps/api/src/modules/org/routes.ts` and 2.2/2.3's credentials routes. Handler returns `{ data: … }`; SecureRoute sends it and writes audit AFTER, in the same tx. Audited handlers must NOT call `reply.send()` on the success path (the send-guard throws) — `return { data: … }`. The `allowedRoles` and `minimumRole` forms both exist (`secure-route.ts` lines ~62–63, ~184–187); use `minimumRole` for the graded routes and `allowedRoles: ['owner','admin']` for the access list (matches `org/routes.ts`).
- **Custom audit writer (capture new id):** stash on `req` after insert, read in the writer — exact pattern in Story 2.1 AC-4 / 2.2 AC-4.
- **Cross-org/missing → 404:** explicit parent-credential existence check + `.returning()` 0-row check on UPDATEs; never 403 for cross-org (enumeration prevention).
- **Validation helper:** `validationError(parsed.error, 'body' | 'query' | 'params')` from `apps/api/src/lib/route-helpers.ts`.
- **JSONB / `sql` subquery:** the `hasDependencies` `EXISTS` uses a `sql<boolean>` template against `credentials.id` — selects no value column.
- **Org-role join (access list):** `orgMemberships` (`role`, `status`, `createdAt`) `innerJoin` `users` (`email`) — both from `@project-vault/db/schema`.
- **Timestamp serialization:** convert Drizzle `Date` → ISO string before sending (response schemas are `z.iso.datetime()`).

### Tech Stack (Repo Pinned)

| Tech | Version | Notes |
|---|---|---|
| Drizzle ORM | `0.45.x` | `pgTable`, `uuid`, `text`, `timestamp`, `index`, `check`; `and`, `eq`, `isNull`, `desc`, `sql`. |
| zod | `zod/v4` | `import { z } from 'zod/v4'`; `.strict()` bodies; `.superRefine` for the cron rule; `.meta({ id })` on exported schemas; `z.coerce` for query booleans (mind the `'false'` pitfall — AC-9). |
| Fastify | `5.x` | `secureRoute()`; `@fastify/type-provider-zod` (convert Date → ISO). |
| PostgreSQL | 16+ | `EXISTS` subquery for `hasDependencies`; `text` + CHECK for `system_type`. |
| cron-parser | `^5.6.1` (current stable, 2026-06; `CronExpressionParser.parse` static entrypoint, v5+) | Validates the rotation cron and computes the next two fire times for the max-frequency-1-hour rule. NEW dependency in `packages/shared`. |

### Architecture Compliance

- No bare `getDb()` in a SecureRoute handler — use the provided `tx`.
- `org_id`/`credential_id` always from `auth`/URL, never the request body.
- RLS policy lives in the migration SQL, not application code; do NOT exclude `credential_dependencies` from the RLS coverage check.
- This story never reads, decrypts, indexes, or returns any credential value — metadata only.
- **No worker / background job in 2.4** — unlike Story 2.2 (retention worker), this story adds NO pg-boss job. Therefore add NO `DIRECT_DB_ACCESS_CLASSIFICATIONS` entry and make NO `vault-guard` allowlist change. The new routes are intentionally NOT on the vault-guard allowlist, so they return `503` while sealed by default — that is the desired behavior, requiring no code change. Do not copy 2.2's worker/exemption wiring.
- Forward-only migrations — revert via a new forward migration, never a hand-authored down.

### Anti-Patterns (Do Not)

- Do not hard-delete a dependency — archive is a soft-delete (`archived_at`); Epic 5 + history depend on the row persisting.
- Do not return 404 when re-archiving an already-archived (owned) dependency — archive is idempotent (200).
- Do not collapse "already archived" and "absent" into the same branch without an existence check (one is 200, the other 404).
- Do not use the 2.2 shape-only `CRON_REGEX` anywhere — replace it with `validateRotationCron` on BOTH create and PATCH.
- Do not accept a rotation schedule firing more than once per hour.
- Do not treat an absent body key the same as `null` in the lifecycle PATCH — absent = no-op, null = clear.
- Do not return a value from any 2.4 route or join `credential_versions` for `encrypted_value`.
- Do not add a unique constraint on `(credential_id, system_name)` — duplicates are allowed.
- Do not return the org roster for a missing/foreign credential's `access` endpoint — verify the credential first.
- Do not return 403 for cross-org access — return 404.
- Do not skip `writeAuditEvent` on the three mutations.
- Do not hardcode the migration number — confirm against `meta/_journal.json`.

---

## Previous Story Intelligence

### Story 2.2 (credentials schema + module)
- `credentials.expires_at` and `credentials.rotation_schedule` columns ALREADY EXIST (created write-only-at-create). 2.4 mutates them — do not recreate.
- 2.2's create body validates `rotationSchedule` with a **shape-only** `CRON_REGEX = /^(\S+\s+){4}\S+$/` and explicitly accepts semantic garbage (2.2 residual F8). 2.4 replaces it with `validateRotationCron` (ADR-2.4-03) — and 2.2's create test that accepted `"a b c d e"` must be updated to expect rejection.
- The credentials module (`routes.ts`, `schema.ts`) + the `credential.*` audit vocabulary + `ROUTE_FILES` entry already exist; 2.4 extends them.
- Custom audit writer (capture a POST's new id by stashing on `req`) is the 2.2/2.1 pattern — reuse for `credential.dependency_added`.
- Cross-org returns 404 not 403; `.strict()` bodies; timestamp serialization (Date → ISO); fail-closed same-tx audit — all carry forward.
- `drizzle-kit generate` does not always emit `check()` constraints (2.2 F4) — grep the generated SQL and hand-add if missing.

### Story 2.3 (list/search + tags)
- The credential **list** endpoint + `CredentialSummarySchema` exist; 2.4 adds `hasDependencies` to both (2.3 explicitly deferred it — 2.3 AC-10 out-of-scope).
- 2.3's `status`/`expiresWithin` filters READ `expires_at`; keep their semantics intact when 2.4 makes expiry mutable.
- ADR-2.2-05 "current = `MAX(version_number) WHERE purged_at IS NULL`" is reused by the list's `currentVersionNumber`; 2.4 does not touch it.
- `ROUTE_ACTION_CLASSIFICATIONS` accepts a `read` GET with an `auditOmissionReason` (precedent: the 2.3 list + `GET /api/v1/auth/sessions`) — the dependency-list and access routes use that.

### Story 2.1 / 1.x
- `orgScoped()`, RLS-in-migration, `check-rls` gate, `withTestOrg()`/`withOrg()`, `idx_<table>_<cols>` naming, `set_updated_at` trigger (function from `0001`) — all established; 2.4 mirrors them.
- `org_memberships` (role `owner|admin|member|viewer`, `status active|deactivated`, `createdAt`) + `users` (email only) are the AC-7 access-list source.
- SecureRoute `allowedRoles` vs `minimumRole` both exist; `org/routes.ts` uses `allowedRoles: ['owner','admin']` for admin-gated reads.

---

## Git Intelligence Summary

Branch state (Epic 1 `done`, Epic 2 `in-progress`): Stories 2.0 `done`; 2.1, 2.2, 2.3 are `ready-for-dev`. 2.2 (`credentials`/`credential_versions` schema + module, lifecycle columns) and 2.3 (list + `CredentialSummarySchema`) are the **direct prerequisites** for 2.4 — coordinate so their migrations (`0013_projects`, `0014_credentials`, `0015_credential_search_and_project_tags`) are journaled before this story's `0016_credential_dependencies`.

Pattern observations (verified in the live tree):
- Route modules export `async function xRoutes(fastify: FastifyApp): Promise<void>`; `org/routes.ts` shows the `secureRoute()` + `allowedRoles` + `validationError(parsed.error, …)` shape.
- DB schema files use `orgScoped()` + a `(t) => ({ ...indexes, ...checks })` block; `org_memberships.ts` shows the `text` + `check(... IN (...))` enum pattern reused for `system_type`.
- `users` has only `email` (no display-name) — AC-7 uses `email` as `displayName`.
- No cron library is present yet — `cron-parser` is a NEW dependency (add to `packages/shared`).
- CI guard scripts (`check-rls`, `check-search-index`) live in `scripts/*.ts`; 2.4 adds no new guard but must keep both passing.

---

## Pre-mortem Failure Modes

| Failure mode | Why it happens | Prevention |
|---|---|---|
| Epic 5 can't build a checklist from 2.4's records | Dependency reshaped, or hard-deleted instead of archived | AC-1/AC-5 + ADR-2.4-01/02: stable `{ id, systemName, systemType, notes, archivedAt }`; soft-archive only; Story 5.1 reads `WHERE archived_at IS NULL`. |
| Over-frequent rotation schedule accepted | Only shape-checked (2.2 regex), first-pair-only check, or no max-frequency rule | AC-6 + ADR-2.4-03/09: `validateRotationCron` rejects on the **min** gap across sampled occurrences (catches irregular crons); wired into create AND patch; unit + integration tests. |
| Cron PATCH 500s instead of 422 | `next()` left outside the try; impossible date (`0 0 30 2 *`) throws on iteration | AC-6: BOTH `parse()` and every `next()` inside one try → `invalid_cron`; unit + integration test for the impossible-date case. |
| Dependency flooding inflates Epic 5 checklists / DB | No per-credential cap; a compromised member adds unbounded rows | AC-3 + ADR-2.4-08: `MAX_ACTIVE_DEPENDENCIES = 200` active-row cap → `422 too_many_dependencies`; test covers the cap + archive-frees-capacity. |
| Create path still accepts garbage cron after this story | 2.2's `CRON_REGEX` left in place | AC-6 task: REPLACE the regex with the shared validator; regression test asserts 2.2 create now rejects `"a b c d e"` / `*/30 * * * *`. |
| `null` vs absent confused in lifecycle PATCH | Truthiness check instead of key-presence | AC-6: use `'rotationSchedule' in body`; build `.set({})` from present keys only; tests for set/clear/no-op. |
| Re-archiving returns 404 (breaks retried clicks) | Conditional UPDATE returns 0 rows → assumed missing | AC-5: existence check distinguishes already-archived (idempotent 200) from absent (404). |
| Cross-credential archive | UPDATE matches only `dependencyId` | AC-5/AC-11: match `(id, credentialId)` together; test a foreign-credential dependency id → 404. |
| Access endpoint leaks the org roster for a foreign credential | Roster returned before checking the credential exists | AC-7/AC-11: verify credential in caller's org+project FIRST; test foreign id → 404. |
| `hasDependencies` disagrees between list and dependency endpoint | Two different predicates | AC-4/AC-8: identical "active dependency EXISTS" predicate (`archived_at IS NULL`) on both. |
| RLS gap on the new table | Forgot policy or excluded the table | AC-2: policy in the migration; `check-rls` passes; do NOT add to `EXCLUDED_TABLES`; write-isolation test. |
| Value leaks via the list `EXISTS` or access join | Careless `select(*)` or a `credential_versions` join | AC-8/AC-11: `EXISTS` selects `1`; access join selects only `email`/`role`/`createdAt`; sentinel-scan regression test. |
| `system_type` CHECK missing from emitted SQL | drizzle-kit omits `check()` | Task 1: grep generated SQL; hand-add; DB test rejects an out-of-set value. |
| route-audit fails | New routes missing from classifications, or `read` GET with omission reason rejected | AC-10 lists all five + the precedent; run route-audit in isolation. |
| Mutation commits without audit | Audit outside tx / swallowed | SecureRoute same-tx `writeAuditEvent`; audit-failure-rollback test on archive. |
| `includeArchived=false` still returns archived | `z.coerce.boolean()` treats `'false'` as `true` | AC-9: use explicit `'true'`/`'false'` handling; test the `=false` case. |
| Sealed vault returns 500 not 503 | Handler reached while sealed | vault-guard returns 503 first; tests for a dependency route, the PATCH, and access. |

---

## ADRs

### ADR-2.4-01: `credential_dependencies` is a dedicated row-per-system table shaped for Epic 5 consumption
| | |
|---|---|
| **Context** | Story 5.1 generates one `rotation_checklist_items` row per non-archived dependency, FK-referencing `dependencyId` and snapshotting `systemName`. The dependency record could be a JSON array on `credentials` or a dedicated table. |
| **Decision** | A dedicated `credential_dependencies` table, one row per dependent system, org-scoped with RLS, with `{ id, credentialId, systemName, systemType, notes, archivedAt }`. |
| **Rationale** | `rotation_checklist_items.dependencyId` needs a stable FK target; a JSON blob has no addressable row id and could not be referenced from a future rotation. A table also gets RLS, indexing, and audit for free. The fields match exactly what Story 5.1's AC enumerates, so Epic 5 consumes them with no reshape. |
| **Consequences** | One extra table + migration now; Epic 5 wires in with zero schema change. |

### ADR-2.4-02: Dependencies are soft-archived (`archived_at`), never hard-deleted
| | |
|---|---|
| **Context** | A system can stop depending on a credential. Removing it must not appear on future rotation checklists, but its participation in PAST rotations must remain intact (`rotation_checklist_items.dependencyId` would dangle if the row vanished). |
| **Decision** | `DELETE …/dependencies/:id` sets `archived_at`/`archived_by` (soft-archive); the row is preserved. Active lists and Epic 5 checklist generation read `WHERE archived_at IS NULL`. |
| **Rationale** | History integrity + a non-dangling FK for Epic 5; the epic explicitly says "archived records are hidden from active lists but preserved in history". Hard delete would break rotation history and forfeit audit value. |
| **Consequences** | `credential_dependencies` rows accumulate (archived ones persist). Acceptable — they are tiny metadata rows. No unarchive in v1 (re-add instead). |

### ADR-2.4-03: One shared `validateRotationCron` (real `cron-parser` + max-frequency 1h), used by create AND patch
| | |
|---|---|
| **Context** | 2.2 validated `rotationSchedule` shape-only at create and deferred full semantics here. FR15 + the epic require "max frequency: every 1 hour" and `invalid_cron` on bad input. Two validators on two entry points would let bad data in via create. |
| **Options** | (a) Validate only in PATCH; leave create shape-only. (b) One shared validator used by both create and PATCH. (c) A DB CHECK on the cron string. |
| **Decision** | **(b)** — `packages/shared/src/validation/rotation-cron.ts` parses with `cron-parser` and rejects schedules whose **smallest** gap across the next several sampled fire times is `< 60 min` (see ADR-2.4-09 for the sampling rationale); wired into both the 2.2 create body and the 2.4 PATCH body. |
| **Rationale** | A single source of truth means create and PATCH cannot diverge. `cron-parser` is the de-facto standard (also used by pg-boss) and computing two `next()` deltas is O(1). A DB CHECK cannot evaluate cron semantics. |
| **Consequences** | New `cron-parser` dependency in `packages/shared`; the 2.2 create test that accepted garbage cron must be updated to expect rejection. |

### ADR-2.4-04: The access list is derived from `org_memberships` in v1; `identityType` is forward-compatible with Epic 7
| | |
|---|---|
| **Context** | FR64 wants "which human users and machine users currently have access". No per-project RBAC (Story 4.1) and no machine users (Epic 7) exist yet. |
| **Decision** | Derive the list from active `org_memberships` joined to `users` (`displayName = email`, `role`, `grantedAt = membership.createdAt`); `identityType` is the constant `'user'` for now. |
| **Rationale** | Access in v1 IS the org role (everyone with a membership can access the org's project credentials per their role). Building a per-credential grant table now would be speculative. The `{ identityType, displayName, role, grantedAt }` shape lets Epic 7 append machine-user rows and Story 4.1 narrow by project with no breaking change. |
| **Consequences** | The list is org-wide, not per-project, until Story 4.1 (documented residual). `displayName` is the email until a profile-name column exists. |

### ADR-2.4-05: `hasDependencies` is computed via `EXISTS`, not a denormalized counter
| | |
|---|---|
| **Context** | UX-DR7 needs a coverage-gap flag on the credential list and detail. It could be a stored `dependency_count` kept in sync, or computed on read. |
| **Decision** | Compute `hasDependencies` with an `EXISTS (… archived_at IS NULL)` subquery on read; no stored counter. |
| **Rationale** | A counter is a second mutation point (add/archive would both have to maintain it) that drifts from reality (same reasoning as ADR-2.2-05's computed current-version). `EXISTS` short-circuits on the first active row and is backed by `idx_credential_dependencies_cred_active`. |
| **Consequences** | A cheap subquery per list row; the list and dependency-list flags share one predicate so they never disagree. |

### ADR-2.4-06: Viewing the access list is a `read` (audit-omitted) in v1; access-report auditing is Epic 8
| | |
|---|---|
| **Context** | FR64 lets admins see who can access a credential. Should viewing the roster be an audited event? |
| **Decision** | Classify the access GET as `read` with an `auditOmissionReason` — it returns org-role metadata only, never a secret value, and writes no audit row in 2.4. |
| **Rationale** | The mandatory-audit invariant exists for VALUE access (FR96, 2.2). The access list exposes no value. Compliance auditing of "who viewed access reports" belongs to Epic 8 (access reports / audit PII), where it is designed coherently rather than ad hoc here. The route is still admin/owner-gated. |
| **Consequences** | No audit row for access-list views in 2.4; Epic 8 may add one. The route-audit gate accepts the `read` + omission-reason classification. |

### ADR-2.4-07: `system_type` is `text` + CHECK, not a Postgres `enum` type
| | |
|---|---|
| **Context** | `systemType` is a fixed set (`service | ci_pipeline | database | third_party | other`). |
| **Decision** | Store as `text` with a CHECK constraint `IN (...)`, mirroring `org_memberships.role`. |
| **Rationale** | Adding a value to a `text`+CHECK column is a one-line CHECK swap in a forward migration; an `ALTER TYPE … ADD VALUE` on a real pg enum is more brittle (can't run in a transaction in older PG, can't easily remove values). The repo already uses the `text`+CHECK convention for roles/status. |
| **Consequences** | Type-safety lives in the Zod `SystemTypeSchema` + the DB CHECK, not a native enum. Consistent with the codebase. |

### ADR-2.4-08: Active-dependency cap (200) enforced at the app layer, not a DB constraint
| | |
|---|---|
| **Context** | A credential needs a bound on its non-archived dependencies — to limit abuse (a flood of rows) and to bound the size of the rotation checklist Epic 5 generates from them. |
| **Options** | (a) App-layer count-check before insert (in the RLS tx). (b) A DB trigger / partial constraint. (c) No cap. |
| **Decision** | **(a)** — count non-archived rows for the credential and return `422 too_many_dependencies` at `MAX_ACTIVE_DEPENDENCIES = 200`. Archived rows do not count. |
| **Rationale** | A plain DB `CHECK` cannot express "count of non-archived rows < N"; a trigger couples the cap to write latency and cannot return a clean typed API error. The app-layer check runs in the same RLS transaction, excludes archived rows (so archiving frees capacity), and yields the precise `422`. |
| **Consequences** | A TOCTOU race between two concurrent inserts could momentarily cross 199→201 — **accepted**: the cap is a soft abuse guard, not a security boundary. If exactness is ever required, add a `FOR UPDATE` on the parent credential or a DB trigger. |

### ADR-2.4-09: Rotation max-frequency enforced by sampling consecutive fire times, not analytic derivation
| | |
|---|---|
| **Context** | The "at most once per hour" rule must hold for an arbitrary 5-field cron, including irregular schedules whose smallest inter-fire gap is not the first pair (e.g. `0 23,0 * * *`). |
| **Options** | (a) Compare only the first two fire times. (b) Sample N consecutive fire times and reject if the **minimum** gap < 60 min. (c) Analytically derive the minimum interval from the cron fields. |
| **Decision** | **(b)** — sample 6 occurrences (5 gaps) via `cron-parser` and reject on the smallest. |
| **Rationale** | (a) misses irregular crons whose sub-hour gap hides mid-cycle; (c) is brittle across DST, lists, steps, and range interactions and easy to get subtly wrong. Sampling a small fixed window catches realistic abuse (every-minute/30-min, hidden 1h-list gaps) at O(1) cost and with guarded iteration (impossible dates → `invalid_cron`). |
| **Consequences** | A pathological cron whose only sub-hour gap falls beyond the sample window could slip through — **accepted**: rotation is a low-frequency operation and the floor is an abuse guard, not a security control. Widen `SAMPLE_OCCURRENCES` if a real case emerges. |

### ADR-2.4-10: Lifecycle PATCH is a JSON-merge-patch (absent = no-op, null = clear); empty patch rejected
| | |
|---|---|
| **Context** | `PATCH …/credentials/:credentialId` sets/clears `expiresAt` and/or `rotationSchedule` independently of each other. |
| **Options** | (a) PUT / full-replace (every field must be sent every time). (b) RFC-7396-style three-state merge. (c) Separate set/clear endpoints per field. |
| **Decision** | **(b)** — an absent key leaves the field unchanged, an explicit `null` clears it, a value sets it; a body with neither field returns `422 no_fields_to_update`. |
| **Rationale** | A PUT would force callers to resend (and risk clobbering) the expiry when only changing the rotation schedule; separate endpoints multiply routes and audit events. Merge-patch is the least-surprising REST idiom, and rejecting empty patches avoids a meaningless audited no-op UPDATE. |
| **Consequences** | Handlers MUST distinguish absent vs `null` by key presence (`'rotationSchedule' in body`), never truthiness — explicitly tested. `.strict()` still bars unknown keys (no `name`/`value`/`tags` via this PATCH). |

### ADR-2.4-11: Soft-archive is idempotent (re-archiving returns 200, not 404/409)
| | |
|---|---|
| **Context** | `DELETE …/dependencies/:id` soft-archives; clients may retry the call or double-click. |
| **Options** | (a) Idempotent `200` on an already-archived row. (b) `404` once archived. (c) `409 conflict`. |
| **Decision** | **(a)** — re-archiving an owned, already-archived dependency returns `200` with its existing `archivedAt`. |
| **Rationale** | Archive is state convergence, not a one-shot mutation; retries and duplicate clicks on a `DELETE` are expected and safe. `404` would falsely imply "not found"; `409` burdens the client for a benign, idempotent case. Truly-absent or foreign ids still return `404`. |
| **Consequences** | The handler needs an existence re-check (when the conditional `… WHERE archived_at IS NULL` UPDATE matches 0 rows) to separate already-archived (`200`) from absent (`404`). The **first** archive's `archived_at`/`archived_by` are preserved — a re-archive does NOT overwrite them. |

---

## References

- Story source: `_bmad-output/planning-artifacts/epics.md#Story-2.4-Dependent-System-Recording--ExpiryRotation-Schedules`
- Epic 5 consumer contract (rotation checklist per non-archived dependency, PJ1): `_bmad-output/planning-artifacts/epics.md#Story-5.1` and `#Story-5.2`
- FR15 / FR16 / FR64: `_bmad-output/planning-artifacts/prd.md` (lines ~868–871)
- UX-DR7 coverage-gap indicator: `_bmad-output/planning-artifacts/epics.md` (UX decision references)
- Previous story (credentials/credential_versions schema, lifecycle columns, shape-only cron F8, custom audit writer): `_bmad-output/implementation-artifacts/2-2-credential-storage-and-retrieval-with-version-history.md`
- Previous story (credential list + `CredentialSummarySchema`, `hasDependencies` deferral, `read`+omission classification): `_bmad-output/implementation-artifacts/2-3-credential-search-filter-and-tag-management.md`
- Previous story (projects, org-scoped 404, conventions): `_bmad-output/implementation-artifacts/2-1-project-creation-and-cross-project-dashboard.md`
- SecureRoute (`allowedRoles`/`minimumRole`, `resourceIdFromParams`, audit writer): `apps/api/src/lib/secure-route.ts`
- Admin-gated read + `validationError` pattern: `apps/api/src/modules/org/routes.ts`
- Route audit classification + `ROUTE_FILES`: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`
- Audit event union: `packages/shared/src/constants/audit-events.ts`
- Schema conventions (`orgScoped`, `text`+CHECK enum): `packages/db/src/schema/helpers.ts`, `packages/db/src/schema/org-memberships.ts`
- Access-list source tables: `packages/db/src/schema/org-memberships.ts`, `packages/db/src/schema/users.ts`
- RLS coverage check / `0001` trigger function: `scripts/check-rls-coverage.ts`, `packages/db/src/migrations/0001_rls_and_triggers.sql`
- Auth test helpers: `apps/api/src/__tests__/helpers/auth-test-helpers.ts`
- cron-parser (v5+, `CronExpressionParser.parse`): https://www.npmjs.com/package/cron-parser
- Repo TDD rule: `AGENTS.md`
- Key decisions to read first: **ADR-2.4-01/02** (Epic 5 consumption + soft-archive) and **ADR-2.4-03** (one shared cron validator, max 1h, used by create + patch).

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

- `make ci` green on branch `feature/2-4-dependent-system-recording-and-expiry-rotation-schedules`
- `0 23,0 * * *` accepted by cron validator (exactly 60-minute gap; story example treated as boundary-ok per `< 3600000` rule)
- `hasDependencies` implemented via batched `selectDistinct` + Set lookup (not per-row EXISTS subquery) after EXISTS approach failed integration tests

### Completion Notes List

- Migration `0016_credential_dependencies.sql` with RLS + `updated_at` trigger
- Five new credential routes: dependency POST/GET/DELETE, lifecycle PATCH, access GET
- Shared `validateRotationCron()` replaces shape-only regex on create + PATCH paths
- Extracted `org-role-test-helpers.ts` and `credential-route-test-helpers.ts` for jscpd dedup

### File List

- `packages/db/src/schema/credential-dependencies.ts`
- `packages/db/src/migrations/0016_credential_dependencies.sql`
- `packages/db/src/__tests__/credential-dependencies-rls-isolation.test.ts`
- `packages/db/src/__tests__/credential-test-helpers.ts`
- `packages/shared/src/validation/rotation-cron.ts`
- `packages/shared/src/schemas/credential-dependencies.ts`
- `packages/shared/src/schemas/credentials.ts`
- `apps/api/src/modules/credentials/dependencies-service.ts`
- `apps/api/src/modules/credentials/routes.ts`
- `apps/api/src/modules/credentials/schema.ts`
- `apps/api/src/modules/credentials/service.ts`
- `apps/api/src/modules/credentials/credential-dependencies.test.ts`
- `apps/api/src/modules/credentials/credential-route-test-helpers.ts`
- `apps/api/src/__tests__/helpers/org-role-test-helpers.ts`
- `apps/api/src/lib/route-exemptions.ts`
