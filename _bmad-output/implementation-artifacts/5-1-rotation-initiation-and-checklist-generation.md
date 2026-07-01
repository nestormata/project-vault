# Story 5.1: Rotation Initiation & Checklist Generation

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-07-01 — comprehensive developer guide for the FIRST story in Epic 5 (Credential Rotation). This story creates the `rotations` + `rotation_checklist_items` tables (the foundational schema every later Epic 5 story builds on), the rotation-initiation endpoint (advisory-lock-guarded, atomic new-version + rotation + checklist write), the rotation-detail and rotation-history read endpoints, and activates the `rotation_locked_at` retention-exemption seam Story 2.2 built specifically for this story to fill in. Stories 4.3 and 4.4 (already `ready-for-dev`, not yet implemented) contain STUBBED forward-references to the exact `rotations` table shape this story must produce — read "Cross-Epic Coordination" below before touching the schema. -->

## Story

As a developer who has updated a credential in its target systems,
I want to initiate a formal rotation workflow that generates a checklist of all dependent systems,
so that nothing is missed and the rotation history is permanently recorded.

*Covers: FR18, FR19, FR23.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-5.1-Rotation-Initiation--Checklist-Generation`]

---

## Cross-Epic Coordination (Read First — Do Not Skip)

Two **already-created, `ready-for-dev`** stories in Epic 4 contain forward-looking stubs that this story's schema must satisfy exactly, without a follow-up migration:

| Story | Stub location | What it already assumes about `rotations` |
|---|---|---|
| 4.4 (`4-4-project-archival.md`, AC-4, ADR-4.4-02/03) | `apps/api/src/modules/projects/archive-guards.ts` → `findBlockingRotationIds(tx, projectId)` | Queries `SELECT id FROM rotations WHERE project_id = $1 AND status IN ('in_progress', 'stale_recovery')` via raw SQL (guarded by a `to_regclass('public.rotations')` existence check, because Epic 5 didn't exist yet when 4.4 was written). Requires a **`project_id` column directly on `rotations`** (not just reachable via a `credential_id` join) and requires `'in_progress'` and `'stale_recovery'` to be **legal `status` values**. |
| 4.3 (`4-3-account-deactivation-and-recovery.md`, D7, AC-8) | `checkActiveRotationsForUser(tx, userId)` (stub, always returns `{ blocked: false, rotationIds: [] }`) | Expects a future real implementation to query `rotations` for rows with `status = 'in_progress'` associated with a **user** — i.e. an `initiated_by` column FK'd to `users.id` (not a `user_identity_tokens` ref). |

**Action required by this story:** build `rotations` with `project_id`, `credential_id`, `initiated_by` (→ `users.id`), and a `status` CHECK constraint that includes at minimum `'in_progress'` and `'stale_recovery'` (see AC-1 — this story defines the **full** Epic 5 status vocabulary up front so 5.2/5.3 and the 4.3/4.4 stubs never need a second migration to widen the CHECK).

**Action NOT required by this story:** do not modify `4-3-...md` or `4-4-...md`, their stub code, or their route behavior. Those are separate stories with their own lifecycle. Leave a note for whoever next opens either of those two files (their own docs already say so): once this story merges, `findBlockingRotationIds` should be swapped from raw SQL + existence-check to a typed Drizzle query against the schema this story exports, and `checkActiveRotationsForUser`'s `// TODO: Epic 5` stub should be implemented for real. That swap is out of scope here — flag it, don't do it.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 2.2 (`credentials` + `credential_versions` tables, `packages/crypto` encryption, `credential.*` audit vocabulary) merged | Rotation initiation creates a new `credential_versions` row using the exact `encryptValue()` / `getPrimaryKey()` / row-lock pattern 2.2 established. **The `rotation_locked_at` column on `credential_versions` already exists** (2.2 AC-2: "Retention exemption seam: when non-null, this version is locked by an in-progress or stale-recovery rotation (Epic 5) and is exempt from retention deletion. Null in 2.2.") — this story is the first to set it. |
| Story 2.4 (`credential_dependencies` table, cron/lifecycle PATCH) merged | Rotation checklist generation reads every **non-archived** `credential_dependencies` row for the credential and snapshots it into one `rotation_checklist_items` row. 2.4's own cross-story table names this story as the "Primary consumer" and states the **point-in-time snapshot contract**: this story must read the dependency set **inside its own advisory-locked transaction** so a concurrent add/archive cannot mutate a checklist mid-generation. |
| Story 1.11 `SecureRoute` framework + `route-audit.test.ts` CI gate merged | All three new routes register via `secureRoute()`; the retention-adjacent write (`rotation_locked_at` UPDATE) happens inside the same `ctx.tx` SecureRoute already opens — no separate transaction needed. |
| Story 1.5 vault init/unseal merged | Rotation initiation and value-touching operations require the vault unsealed. Routes are **not** on the `vault-guard` allowlist → `503 { status: "sealed" }` while sealed (mirrors 2.2/2.4). |
| Story 1.4 audit foundation (`audit_log_entries`, keyed-HMAC writer, `writeHumanAuditEntryOrFailClosed`) merged | Rotation initiation writes a `rotation.initiated` audit row in the same transaction, fail-closed (same pattern as `credential.created`). |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | On this branch the highest migration is **`0025_project_invitations.sql`** (`packages/db/src/migrations/meta/_journal.json`, idx 25). This story's migration is therefore **`0026_rotations.sql`**. Before generating, re-read the journal — if other stories merged first, use the actual next free number. Every `0026_*` reference below is illustrative if the branch has moved on. |

---

## Epic Cross-Story Context

| Story | Relationship to 5.1 |
|---|---|
| 2.1 | Established `orgScoped()`, RLS-in-migration, cross-org-returns-404, `.strict()` bodies, `SecureRoute` conventions. 5.1 follows all of them. |
| 2.2 | Created `credentials` + `credential_versions`, `encryptValue()`/`withSecret()`/`getPrimaryKey()`, the `credential.*` audit vocabulary, and — critically — the **`rotation_locked_at`** column on `credential_versions` specifically so this story would have a retention-exemption seam to fill in without a schema change. |
| 2.4 | Created `credential_dependencies` (soft-archived via `archived_at`). 5.1 is its **primary consumer**: every non-archived row becomes exactly one `rotation_checklist_items` row, snapshotting `systemName`. Archived dependencies are excluded. Duplicate `systemName` values across distinct `dependencyId`s are intentional (2.4 explicitly allows this) — 5.1 creates one checklist item per row, never collapsing duplicates. |
| 4.3 | `ready-for-dev`, not yet implemented. Contains a stub (`checkActiveRotationsForUser`, D7) that this story's `initiated_by`/`status` columns must make satisfiable later without a schema change. See "Cross-Epic Coordination" above. |
| 4.4 | `ready-for-dev`, not yet implemented. Contains a stub (`findBlockingRotationIds`, ADR-4.4-02/03/04) that this story's `project_id`/`status` columns must make satisfiable later without a schema change. See "Cross-Epic Coordination" above. |
| 5.2 | Adds `POST /rotations/:id/checklist/:itemId/confirm|fail|retry` and `POST /rotations/:id/complete`. Consumes the `version` optimistic-lock column and `status` CHECK values (`confirmed`, `failed`, `max_retries_exceeded` on checklist items; `completed` on rotations) this story reserves in the CHECK constraints but never writes. Also clears `rotation_locked_at` on the superseded version at completion (not this story's job). |
| 5.3 | Adds break-glass (`status: 'break_glass_complete'` on rotations) and stale-recovery (`status: 'stale_recovery'`) transitions, both reserved in this story's CHECK constraint but never written here. Also adds the `rotation:recover` startup job that scans `rotations WHERE status = 'in_progress'`. |
| 8.x | `rotation.initiated` audit events become queryable once Epic 8's audit UI lands. Must be written to `audit_log_entries` from day one with correct HMAC + key version + actor token. |

---

## Architecture Conflict Resolution (Read Before Coding)

The architecture document predates the epic refinement and the Epic 2 naming decisions. Where they differ, the **epic + Story 2.1/2.2/2.4 conventions are authoritative**. Resolve every conflict as follows:

| Architecture / prior wording | Canonical implementation for 5.1 | Rationale |
|---|---|---|
| `architecture.md` line 781 example error: `throw new AppError('ROTATION_IN_PROGRESS', 'A rotation is already in progress for this credential...', 409)` and epics.md's illustrative `409 { error: "rotation_in_progress", rotationId }` | The actual repo-wide error envelope is `{ code, message }` (see `apps/api/src/lib/errors.ts` `AppError`, `ApiErrorSchema`). Use `409 { code: "rotation_in_progress", message: "...", rotationId: "<uuid>" }` — `code` (not `error`) is the machine-readable field; `rotationId` is an additional, non-enveloped field alongside it (same pattern 4.4 used for `active_rotations`, except 4.4 deliberately used `error` for byte-compatibility with 4.3 — 5.1 has no such cross-story compatibility constraint, so it uses the standard `code` envelope). | Every other route in this codebase uses `{ code, message }`. Don't introduce a third shape. |
| `architecture.md` §"Rotation state machine locking": "PostgreSQL advisory locks on credential ID as primary mechanism... `pg_try_advisory_lock()` returns false → immediately return 409, no queuing, no waiting" | Use **`pg_try_advisory_xact_lock(hashtext(credentialId), hashtext(orgId))`** — the transaction-scoped, non-blocking, two-key variant already established in this codebase (`apps/api/src/modules/auth/mfa-login.ts` line 129, `apps/api/src/workers/check-failed-auth-threshold.ts` line 229) — **not** the session-scoped `pg_advisory_lock()`/`pg_try_advisory_lock()` architecture.md's prose implies. | A session-scoped lock taken in one HTTP request cannot practically persist across the multiple independent requests a rotation's lifecycle spans (initiate → confirm → complete are separate requests, likely served by different pooled connections) — worse, an un-released session lock on a returned pooled connection is a resource leak. The xact-scoped variant auto-releases at commit/rollback of the *initiation* transaction, which is all 5.1 needs: it only has to win the race against a second, concurrent *initiate* call. The durable, connection-independent guarantee that only one `in_progress` rotation exists per credential is the **partial unique index** in AC-1, not the lock. Story 5.3's `rotation:recover` job scans DB state (`status = 'in_progress' AND initiated_at < threshold`), not a held pg lock — confirming the DB row, not a session lock, is the source of truth across the rotation's multi-request lifetime. |
| Epic 5.3 text: "a rotation record is created with `status: 'break_glass_complete'`... the old credential version... enters a `break_glass_overlap` status" | `break_glass_overlap` is a status on **`credential_versions`** (a column this story does not add — out of scope, Story 5.3's job), not on `rotations`. Do not add `break_glass_overlap` to the `rotations.status` CHECK constraint. | Conflating the two tables' status vocabularies in the same CHECK would let an invalid rotation status slip past a copy-paste error. |
| Epic 5.1 text: "`initiatedBy` (user_identity_token ref)" | Use **`initiatedBy: uuid references users.id`** — the same pattern as `credentials.createdBy` / `credential_dependencies.createdBy` (2.2/2.4), **not** a new FK to `user_identity_tokens`. | `user_identity_tokens` is the audit-actor pseudonymization table, populated separately via `firstActorTokenIdForUser()` inside the audit writer — it is never a business-data FK target elsewhere in the schema (see `packages/db/src/schema/user-identity-tokens.ts` header comment: "platform-level identity table"). Story 4.3's stub (`checkActiveRotationsForUser`) also expects to query rotations by a plain `userId`, confirming `initiatedBy → users.id` is correct. |
| Architecture canonical name `secrets`/`secret_dependencies` (architecture.md line 910-911 uses `rotations`/`rotation_checklist_items` — these two ARE already aligned with the epic) | No conflict for this story's own two new tables — architecture.md's "Canonical Schema Entity Names" table already lists `rotations` and `rotation_checklist_items` verbatim. Only the *columns/FKs* need reconciling per the rows above. | — |

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no (no web UI ships in this story) |
| **Linked UI story** (if API-only) | `TBD` — **blocking note:** as currently scoped, Epic 5 (`5-1`, `5-2`, `5-3` in `sprint-status.yaml`) contains **no dedicated frontend/web story** for the rotation initiation flow or checklist UI, unlike Epic 2 (which paired `2.2`/`2.4` API work with `2.0`/`2.1`/`2.3` web stories) and Epic 3/4. This is the same category of gap the Product Surface Contract (G1, Epic 2 retrospective) exists to catch. Do not let this slide silently: when this story reaches `review`, the reviewer/SM must either (a) confirm a web rotation-UI story already exists in `sprint-status.yaml` under Epic 5 or a later epic and link it here, or (b) add one via `deferred-work.md` §Epic 5 (mirroring the existing `deferred-work.md` line 63 entry for 2.4's own "no edit form" web gap) before `epic-5-retrospective` runs. **This story itself must not be blocked on that decision** — it is pure backend/API and ships independently. |
| **Honest placeholder AC** (if UI deferred) | The dashboard already ships an honest placeholder for this exact surface: `deferred-work.md` line 51 — `AC-E2d — projects with overdue rotations`: schema slot exists, `count: 0, items: []`, explicitly deferred to Epic 5. **This story does not touch that dashboard slice** (the "upcoming/overdue rotations" list is FR65, Story 5.2's `GET /rotations/upcoming`). Do not wire the dashboard placeholder to this story's tables — that would be scope creep into 5.2 and would need `?horizon=` filtering this story doesn't build. Leave `AC-E2d`'s placeholder as-is; note it as a 5.2 follow-up (see AC-19). |
| **Persona journey** | API-only, no evaluator-visible UI this story. Rationale: the rotation *workflow* (Alex-viewer/Morgan-member persona completing a rotation end-to-end) requires the checklist-confirmation UI, which does not exist until a web story is scheduled (see "Linked UI story" above) and until Story 5.2 (confirmation endpoints) ships. A single-story persona journey stub would misrepresent an unusable partial flow. |

### Persona journey stub

N/A for this story — API-only, no UI surface exists yet to walk a persona through. See "Linked UI story" blocking note above.

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| DB schema | New `rotations` + `rotation_checklist_items` tables, org-scoped with RLS, in migration `0026_rotations.sql` (see R1). `status` CHECK constraints define the **full** Epic 5 state vocabulary now (AC-1/AC-2) so 5.2/5.3 never need to widen them. |
| Initiate rotation | `POST …/credentials/:credentialId/rotations` acquires a non-blocking transaction-scoped advisory lock, creates `rotations` + N `rotation_checklist_items` (one per non-archived dependency) + a new `credential_versions` row (the `newValue`) + locks the superseded version's `rotation_locked_at`, all atomically. `admin`/`owner` only. |
| Concurrency | A second concurrent initiate on the same credential → `409 { code: "rotation_in_progress", rotationId }`. No queuing, no blocking wait. |
| Zero dependencies | A credential with zero non-archived dependencies still initiates successfully with an **empty checklist** — the *completion* gate (AC-E5a) is Story 5.2's job, not this story's. |
| Reads | `GET …/rotations/:rotationId` returns the full rotation + checklist items. `GET …/rotations` returns paginated summaries (`id, status, initiatedBy, initiatedAt, completedAt, itemCount, confirmedCount`). Both `viewer`+. |
| Retention seam | The credential's previously-current version gets `rotation_locked_at = NOW()` in the same transaction, exempting it from the Story 2.2 retention job while the rotation is in flight. |
| Security | RLS org-scoped; cross-org/cross-project/cross-credential → 404 (no enumeration); sealed vault → 503; mutation fails closed on audit; `.strict()` bodies. |
| Audit | `rotation.initiated` audit row written same-transaction, fail-closed, via `writeHumanAuditEntryOrFailClosed`. |
| Route audit | New routes registered + classified in `ROUTE_ACTION_CLASSIFICATIONS`; `route-audit.test.ts` passes. |
| Tests | Initiate happy path, concurrent initiate (409, advisory lock + partial-unique-index backstop both exercised), zero-dependency initiate, role enforcement (403 for member/viewer), cross-org/cross-project/nonexistent-credential 404, sealed-vault 503, validation 422s, retention-lock verified (version not purged while locked), rotation detail read, rotation history pagination, cross-org RLS isolation (direct DB query), audit-write-failure rollback. |
| Operational metrics/logging | Rotation-initiated counter, initiation-failure log (lock contention vs. validation vs. audit failure distinguished) — never logging the `newValue` plaintext. |

---

### AC-1: Database Schema — `rotations` Table (NEW)

**Given** the Drizzle schema conventions in `packages/db/src/schema/` (established by Stories 1.4/2.1/2.2/2.4),
**When** Story 5.1 adds the rotation record table,
**Then** create `packages/db/src/schema/rotations.ts` exactly as follows:

```typescript
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'
import { credentials } from './credentials.js'

// One row per initiated rotation. Immutable history once completed/abandoned (FR23) —
// no route in this story or Story 5.2/5.3 ever DELETEs a rotation row.
// `status` CHECK lists the FULL Epic 5 state machine now (5.1 only ever writes 'in_progress')
// so Stories 5.2/5.3 and the Story 4.3/4.4 forward-reference stubs never need a second
// migration to widen this constraint.
export const rotations = pgTable(
  'rotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('in_progress'),
    // Optimistic-lock column (RS-E5a) — incremented on every state transition. Story 5.1
    // only ever writes 1 (at creation); Story 5.2 increments it on confirm/fail/retry/complete.
    version: integer('version').notNull().default(1),
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Backstop for the advisory-lock race (see AC-4/AC-5): the DB, not the lock, is the
    // durable source of truth for "at most one in_progress rotation per credential".
    oneInProgressPerCredential: uniqueIndex('idx_rotations_one_in_progress_per_credential')
      .on(t.credentialId)
      .where(sql`${t.status} = 'in_progress'`),
    projectInitiatedIdx: index('idx_rotations_project_initiated').on(
      t.projectId,
      t.initiatedAt.desc()
    ),
    credentialStatusIdx: index('idx_rotations_credential_status').on(t.credentialId, t.status),
    orgIdx: index('idx_rotations_org').on(t.orgId),
    statusCheck: check(
      'rotations_status_check',
      sql`${t.status} IN ('in_progress','completed','abandoned','stale_recovery','break_glass_complete')`
    ),
  })
)
```

**And** `projectId` is a **denormalized, directly-queryable column** (not reached only via `credentialId → credentials.projectId`) — Story 4.4's already-written `findBlockingRotationIds()` stub queries `WHERE project_id = $1` directly and must not require a join once this table exists.

**And** the table holds **no credential value, no encrypted material** — rotation records are pure workflow metadata; the new credential value lives only in `credential_versions` (created in the same transaction, AC-4).

**And** export it from `packages/db/src/schema/index.ts`:
```typescript
export * from './rotations.js'
export * from './rotation-checklist-items.js'
```

---

### AC-2: Database Schema — `rotation_checklist_items` Table (NEW)

**Given** every rotation needs a per-dependent-system confirmation checklist (FR19),
**When** Story 5.1 adds the checklist table,
**Then** create `packages/db/src/schema/rotation-checklist-items.ts`:

```typescript
import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { rotations } from './rotations.js'
import { credentialDependencies } from './credential-dependencies.js'

// One row per dependent system snapshotted at rotation-initiation time. `status` CHECK lists
// the full Story 5.2 state machine now (5.1 only ever writes 'unconfirmed') for the same
// reason as rotations.status (see AC-1).
export const rotationChecklistItems = pgTable(
  'rotation_checklist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    rotationId: uuid('rotation_id')
      .notNull()
      .references(() => rotations.id, { onDelete: 'cascade' }),
    // 'set null' (not restrict/cascade): Story 2.4 never hard-deletes a dependency, so this FK
    // should never actually go null in practice — but if it ever did, the systemName snapshot
    // below preserves checklist-item history independent of the source dependency row.
    dependencyId: uuid('dependency_id').references(() => credentialDependencies.id, {
      onDelete: 'set null',
    }),
    // Snapshot, NOT a live join — Story 2.4's dependency systemName could change after this
    // rotation completes; the checklist item must show what it was AT ROTATION TIME.
    systemName: text('system_name').notNull(),
    status: text('status').notNull().default('unconfirmed'),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One checklist item per (rotation, dependency) pair — prevents double-generation if
    // checklist-creation logic is ever accidentally invoked twice for the same rotation.
    rotationDependencyUnique: uniqueIndex('idx_rotation_checklist_items_rotation_dependency').on(
      t.rotationId,
      t.dependencyId
    ),
    rotationIdx: index('idx_rotation_checklist_items_rotation').on(t.rotationId),
    orgIdx: index('idx_rotation_checklist_items_org').on(t.orgId),
    statusCheck: check(
      'rotation_checklist_items_status_check',
      sql`${t.status} IN ('unconfirmed','confirmed','failed','max_retries_exceeded')`
    ),
  })
)
```

**And** two independent, non-archived `credential_dependencies` rows that happen to share the same `systemName` (2.4 explicitly permits this — distinct `dependencyId`s, same label) produce **two independent checklist items**, each confirmable separately. Do not add a uniqueness constraint on `systemName` that would collapse them — only `(rotationId, dependencyId)` is unique.

**And** export it from `packages/db/src/schema/index.ts` (combined with AC-1's export block above).

---

### AC-3: Migration `0026_rotations.sql` — Schema, RLS, Triggers

> **Migration number is dynamic (R1).** Re-read `packages/db/src/migrations/meta/_journal.json` immediately before `drizzle-kit generate`; use the actual next free number.

**Given** `packages/db/src/check-rls-coverage.ts` fails CI if any `org_id` table lacks an `ALL` RLS policy,
**When** Story 5.1 creates the migration,
**Then** `pnpm --filter @project-vault/db generate` (or hand-authored, matching drizzle-kit's emitted style) produces `packages/db/src/migrations/0026_rotations.sql` containing, in order:

1. `CREATE TABLE rotations (...)` (before `rotation_checklist_items`, because of the FK).
2. `CREATE TABLE rotation_checklist_items (...)`.
3. All FK `ALTER TABLE ... ADD CONSTRAINT` statements.
4. Both partial/unique/plain indexes from AC-1/AC-2.
5. RLS enable + isolation policy for **both** tables.
6. `updated_at` triggers for **both** tables (both are mutated later by Story 5.2 — unlike `credential_versions`, neither table has an append-only invariant).

Required RLS + trigger block:
```sql
ALTER TABLE rotations                ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE rotation_checklist_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY rotations_isolation
  ON rotations
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY rotation_checklist_items_isolation
  ON rotation_checklist_items
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON rotations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON rotation_checklist_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**And** these are command-less (`ALL`) policies with no explicit `WITH CHECK`, matching every prior migration's convention (PostgreSQL defaults `WITH CHECK` to the `USING` expression, rejecting cross-org writes). A positive cross-org-write-isolation test is required (AC-15).

**And** after adding the migration: run `pnpm --filter @project-vault/db check-rls` (must show zero coverage gaps) then `pnpm --filter @project-vault/db migrate` locally.

**Critical:** Do NOT add `rotations` or `rotation_checklist_items` to `EXCLUDED_TABLES` in `check-rls-coverage.ts` — both are org-scoped and MUST have RLS.

---

### AC-4: `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations` — Initiate Rotation (Happy Path)

**Given** a credential exists in a project the caller can access, has zero or more non-archived dependencies (Story 2.4), and no rotation is currently `in_progress` for it,
**When** a user with `admin` or `owner` org role calls this endpoint,
**Then** the following happens **inside a single database transaction** (`ctx.tx`, already opened by `secureRoute`):

1. Acquire `pg_try_advisory_xact_lock(hashtext(credentialId), hashtext(orgId))`. If it returns `false`, stop immediately and return `409` (see AC-5) — do not proceed to any of the following steps.
2. `SELECT id FROM credentials WHERE id = credentialId AND project_id = projectId FOR UPDATE` — row lock, 404 if not found (AC-8).
3. Read the credential's current highest non-purged `credential_versions` row (`ORDER BY version_number DESC LIMIT 1`, `FOR UPDATE`) — this is the version about to be superseded.
4. Insert a new `credential_versions` row: `versionNumber = previousMax + 1`, `encryptedValue = encryptValue(newValue)` (via `packages/crypto`, exactly as `addCredentialVersion` does in 2.2), `keyVersion = currentKeyVersion(tx)`, `createdBy = auth.userId`.
5. `UPDATE credential_versions SET rotation_locked_at = NOW() WHERE id = <the version read in step 3>` — locks the superseded version against the Story 2.2 retention job (AC-13).
6. `SELECT id, system_name FROM credential_dependencies WHERE credential_id = credentialId AND archived_at IS NULL` — the snapshot read happens here, inside the same lock-protected transaction, so a concurrent 2.4 add/archive cannot race it (2.4's documented point-in-time-snapshot contract).
7. Insert one `rotations` row: `status = 'in_progress'`, `version = 1`, `initiatedBy = auth.userId`, `initiatedAt = NOW()`, `completedAt = NULL`, `notes = body.notes ?? null`.
8. Insert one `rotation_checklist_items` row per dependency read in step 6: `status = 'unconfirmed'`, `systemName` = the snapshotted name, `confirmedBy = NULL`, `confirmedAt = NULL`.
9. Write a `rotation.initiated` audit row (fail-closed, AC-14).
10. Commit. Return `201` with the full rotation detail (AC-4 response below).

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/credentials/00000000-0000-4000-8000-000000000020/rotations
Content-Type: application/json
Cookie: access-token=<jwt>

{
  "newValue": "sk_live_EXAMPLE_ROTATED_VALUE_not_a_real_key",
  "notes": "Rotating after the Stripe key was pasted into a shared Slack channel"
}
```

**Response `201`:**
```json
{
  "data": {
    "id": "b2a1c3d4-0000-4000-8000-000000000099",
    "credentialId": "00000000-0000-4000-8000-000000000020",
    "projectId": "00000000-0000-4000-8000-000000000010",
    "status": "in_progress",
    "version": 1,
    "initiatedBy": "11111111-1111-4111-8111-111111111111",
    "initiatedAt": "2026-07-01T14:32:00.000Z",
    "completedAt": null,
    "notes": "Rotating after the Stripe key was pasted into a shared Slack channel",
    "checklistItems": [
      {
        "id": "c1c1c1c1-0000-4000-8000-000000000001",
        "dependencyId": "d1d1d1d1-0000-4000-8000-000000000001",
        "systemName": "billing-worker (production)",
        "status": "unconfirmed",
        "confirmedBy": null,
        "confirmedAt": null
      },
      {
        "id": "c1c1c1c1-0000-4000-8000-000000000002",
        "dependencyId": "d1d1d1d1-0000-4000-8000-000000000002",
        "systemName": "GitHub Actions CI (deploy pipeline)",
        "status": "unconfirmed",
        "confirmedBy": null,
        "confirmedAt": null
      }
    ]
  }
}
```

**And** a `GET .../credentials/:credentialId/value` call made immediately after this response returns the **new** `newValue` (versioning is append-only and reveal always returns the highest non-purged version — the value is live the instant rotation is initiated; "retiring" the old version in Story 5.2 is about purge-eligibility bookkeeping, not about which value is currently served).

---

### AC-5: `POST .../rotations` — Concurrent Initiation Is Rejected, Not Queued

**Given** a rotation is already `in_progress` for a credential,
**When** a second `POST .../credentials/:credentialId/rotations` call arrives for the **same credential** — whether truly concurrent (racing for the advisory lock) or simply a retry after a rotation was already started —

**Then**, for the truly-concurrent case: the second request's `pg_try_advisory_xact_lock` call returns `false` immediately (no blocking wait). The handler returns:
```http
HTTP 409
{ "code": "rotation_in_progress", "message": "A rotation is already in progress for this credential.", "rotationId": "b2a1c3d4-0000-4000-8000-000000000099" }
```
(`rotationId` is looked up via a plain `SELECT id FROM rotations WHERE credential_id = $1 AND status = 'in_progress'` — the lock failure alone doesn't tell you *which* rotation is running.)

**And**, for the backstop case — the advisory lock somehow was NOT held (e.g. two requests land on different physical connections in a way that defeats a hypothetical future refactor away from `pg_try_advisory_xact_lock`) — the **partial unique index** `idx_rotations_one_in_progress_per_credential` (AC-1) causes the second `INSERT INTO rotations` to raise a `23505` unique-violation. The service layer catches this via `isUniqueViolation()` (reuse `apps/api/src/modules/credentials/db-helpers.ts`) and converts it to the **same** `409 rotation_in_progress` response (looking up the winning rotation's `id` for the payload) — never a raw 500.

**And** integration tests cover both paths explicitly: (a) fire two initiate requests concurrently via `Promise.all` against the same credential and assert exactly one `201` and one `409`; (b) a targeted unit/integration test that bypasses the lock (e.g. by holding it open in a separate connection before calling the service function directly) to prove the partial unique index alone is sufficient — this test is what proves the backstop actually backstops.

---

### AC-6: `POST .../rotations` — Zero-Dependency Credential

**Given** a credential has zero non-archived `credential_dependencies` rows (either none were ever recorded, or all were archived),
**When** a user with `admin`/`owner` role initiates a rotation,
**Then** the rotation is created successfully with `checklistItems: []` — an empty checklist does **not** block *initiation*. (The rule that an empty checklist cannot auto-*complete* — AC-E5a, "I confirm this credential is updated in all consuming systems" acknowledgement — is enforced by Story 5.2's `POST .../rotations/:id/complete` endpoint, which does not exist yet in this story. Do not add a completion-blocking check here; there is no completion endpoint to block.)

**Response `201`** (abbreviated): `{ "data": { "id": "...", "status": "in_progress", "checklistItems": [] } }`.

---

### AC-7: `POST .../rotations` — Role Enforcement (403)

**Given** the epic requires `admin` or `owner` org role to initiate a rotation (epics.md line 1572: "a user with `admin` or `owner` role"),
**When** a user with `member` or `viewer` org role calls `POST .../rotations`,
**Then** the request is rejected before any DB write, with:
```http
HTTP 403
{ "code": "insufficient_role", "message": "Insufficient permissions" }
```

**Implementation:** `secureRoute` `security.minimumRole: 'admin'` (role rank: `owner`=3 ≥ `admin`=2 ≥ `member`=1 ≥ `viewer`=0 — `minimumRole: 'admin'` allows `admin` and `owner`, rejects `member`/`viewer`; see `apps/api/src/lib/secure-route.ts` `roleRank()`/`hasSufficientRole()`). Do **not** use `allowedRoles: ['admin']` (that would wrongly exclude `owner`).

**And** `GET .../rotations` and `GET .../rotations/:rotationId` (read-only) require only `viewer`+ (any org role) — read access to rotation status/history is not restricted to admin/owner (matches the general "list/enumerate is read" convention from 2.2/2.4).

---

### AC-8: `POST .../rotations` — Cross-Tenant / Not-Found Isolation (404, No Enumeration)

**Given** RLS scopes every query to `current_setting('app.current_org_id')`,
**When** any of the following occurs:
- (a) `:projectId` belongs to a different org than the caller's,
- (b) `:projectId` is valid but `:credentialId` belongs to a different project,
- (c) `:credentialId` does not exist at all,
- (d) `:projectId`/`:credentialId` are both valid but the *project* itself belongs to a different org (RLS should make this unreachable, but the app-layer `findProjectInOrg`-style check is the defense-in-depth backstop, same as 2.2/2.4),

**Then** every case returns the identical `404`:
```http
HTTP 404
{ "code": "credential_not_found", "message": "Credential not found" }
```
— never a `403`, and never a response that reveals *which* of (a)-(d) was true (no enumeration).

**And** the same 404 contract applies to `GET .../rotations/:rotationId` (nonexistent or cross-org rotation ID) and to a `GET .../rotations` list request against a nonexistent/cross-org credential.

**And** an integration test seeds two orgs, creates a credential in org A, and asserts that an authenticated org-B admin gets `404` (not `403`, not data leakage) on all three endpoints.

---

### AC-9: `POST .../rotations` — Sealed Vault (503)

**Given** the vault-guard plugin returns `503` for routes not on its allowlist while the vault is sealed (Story 1.5),
**When** any of the three rotation routes is called while the vault is sealed,
**Then** the response is:
```http
HTTP 503
{ "status": "sealed" }
```
(exact shape per the existing `vault-guard.ts` plugin — do not add rotation routes to the vault-guard allowlist; they touch credential values, so fail-closed while sealed is correct, matching 2.2's create/reveal/add-version routes.)

**And** a test asserts this for `POST .../rotations` specifically (the read routes inherit the same guard and don't need a separate assertion beyond one smoke check).

---

### AC-10: `POST .../rotations` — Request Validation (422)

**Given** the request body schema `InitiateRotationBodySchema = z.object({ newValue: z.string().min(1).max(65536), notes: z.string().max(1024).trim().nullable().optional() }).strict()`,
**When** any of the following invalid bodies is sent:

| Invalid body | Expected `422` `code` |
|---|---|
| `{}` (missing `newValue`) | `validation_error` (Zod issue path `["newValue"]`) |
| `{ "newValue": "" }` (empty string) | `validation_error` |
| `{ "newValue": "x".repeat(65537) }` (too long) | `validation_error` |
| `{ "newValue": "ok", "extraField": true }` (`.strict()` rejects unknown keys) | `validation_error` |
| `{ "newValue": 12345 }` (wrong type) | `validation_error` |

**Then** the response is `422` using the existing `validationError()` helper (`apps/api/src/lib/route-helpers.js`), mirroring the exact shape used by `CreateCredentialBodySchema` validation failures elsewhere in the codebase — no DB write occurs, and no advisory lock is acquired (validation happens before the transaction opens, or is the very first check inside it, before step 1 of AC-4).

---

### AC-11: `GET /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId` — Rotation Detail

**Given** a rotation exists for a credential the caller can access,
**When** any org member (`viewer`+) calls this endpoint,
**Then** it returns the same shape as the `POST` `201` response body (AC-4): full rotation fields + `checklistItems` array, reflecting current live state (useful once Story 5.2 starts mutating item statuses — this story's rows are always `unconfirmed`, but the endpoint's shape must already support showing mixed states for forward compatibility).

**Example — immediately after initiation (this story's only reachable state):**
```json
GET /api/v1/projects/.../credentials/.../rotations/b2a1c3d4-0000-4000-8000-000000000099
```
```json
{
  "data": {
    "id": "b2a1c3d4-0000-4000-8000-000000000099",
    "status": "in_progress",
    "version": 1,
    "initiatedBy": "11111111-1111-4111-8111-111111111111",
    "initiatedAt": "2026-07-01T14:32:00.000Z",
    "completedAt": null,
    "notes": null,
    "checklistItems": [
      { "id": "...", "dependencyId": "...", "systemName": "billing-worker (production)", "status": "unconfirmed", "confirmedBy": null, "confirmedAt": null }
    ]
  }
}
```

**Edge case:** a `rotationId` that is syntactically a valid UUID but does not exist (or belongs to a different credential/project/org) → `404 { code: "rotation_not_found", message: "Rotation not found" }` (distinct `code` from `credential_not_found` so clients can tell which resource was missing).

---

### AC-12: `GET /api/v1/projects/:projectId/credentials/:credentialId/rotations` — Rotation History (Paginated)

**Given** a credential has zero or more rotation records across its lifetime (FR23 — history is immutable and permanent),
**When** any org member (`viewer`+) calls this endpoint with optional `?page=&limit=` (reuse `parsePagination`/`buildPaginationMeta` from `apps/api/src/lib/pagination.ts`, same as the credential list endpoint),
**Then** it returns:
```json
{
  "data": {
    "items": [
      {
        "id": "b2a1c3d4-0000-4000-8000-000000000099",
        "status": "in_progress",
        "initiatedBy": "11111111-1111-4111-8111-111111111111",
        "initiatedAt": "2026-07-01T14:32:00.000Z",
        "completedAt": null,
        "itemCount": 2,
        "confirmedCount": 0
      }
    ],
    "page": 1,
    "limit": 20,
    "total": 1,
    "hasMore": false
  }
}
```
`itemCount`/`confirmedCount` are computed via a `COUNT(*)` / `COUNT(*) FILTER (WHERE status = 'confirmed')` subquery or join against `rotation_checklist_items` — never a denormalized counter column (consistent with 2.4 ADR-2.4-05's `hasDependencies` precedent of computing via query, not maintaining a counter).

**Edge case — credential with zero rotations ever:** returns `{ "data": { "items": [], "page": 1, "limit": 20, "total": 0, "hasMore": false } }` — a `200`, never a `404` (the *credential* existing is what's checked; having no rotation history is a valid, common state, not an error).

**Edge case — deep pagination beyond result count:** `?page=999` on a credential with 1 rotation → `200` with `items: []`, `total: 1`, `hasMore: false` (does not 422 — rotation history realistically never approaches the `MAX_CREDENTIAL_LIST_OFFSET`-style deep-pagination guard 2.3 needed for full-text search; omit that guard here unless/until it becomes necessary).

---

### AC-13: Retention-Exemption Seam — Superseded Version Is Locked

**Given** Story 2.2's retention job (`apps/api/src/workers/prune-credential-versions.ts`) purges versions beyond `retentionCount` (default 3, **minimum 1**) but explicitly **skips any version where `rotation_locked_at IS NOT NULL`**,
**When** a rotation is initiated on a credential whose `retentionCount` is set to the **minimum allowed value, `1`**,

**Then**, without this story's locking behavior, the *previously-current* version (now the second-highest version number, immediately below the brand-new rotation version) would become an **immediate purge candidate** the next time the retention job runs — because with `retentionCount = 1`, only the single highest version is normally protected. This would be a disaster: the old value could be zeroed and nulled while dependent systems on the checklist are still mid-confirmation and might legitimately need the old value for comparison/rollback.

**This story prevents that:** step 5 of AC-4 sets `rotation_locked_at = NOW()` on that superseded version, **in the same transaction** as the version insert, so the retention job's `WHERE rotation_locked_at IS NULL` filter excludes it from purge candidacy for as long as the rotation remains `in_progress` (clearing the lock on completion/abandonment is Story 5.2/5.3's job — out of scope here, see AC-19).

**Test:** create a credential with `retentionCount: 1` and 2 existing versions; initiate a rotation (creating version 3); run the retention job's purge-candidate query directly; assert version 2 (the superseded one, now locked) is **excluded** from candidates, and assert its `rotation_locked_at` is non-null in the DB.

**Edge case:** initiating a rotation on a credential with **only one existing version** (version 1, freshly created, never rotated before) — version 1 gets `rotation_locked_at` set even though, absent a rotation, it would already have been protected by the keep-≥1 invariant. This is harmless (locking an already-protected version is a no-op in terms of purge eligibility) and is the simplest correct behavior — do not special-case "credential has exactly one version" to skip the lock.

---

### AC-14: Audit Logging — `rotation.initiated`

**Given** the SecureRoute default audit writer requires the resource ID up front, but a rotation's ID doesn't exist until after the INSERT,
**When** a rotation is successfully initiated,
**Then** the route registers with `security.writeAuditEvent: false` and the handler calls `writeHumanAuditEntryOrFailClosed(tx, { orgId, actorUserId: auth.userId, eventType: AuditEvent.ROTATION_INITIATED /* 'rotation.initiated' */, resourceId: rotation.id, resourceType: 'rotation', payload: { credentialId, projectId, checklistItemCount: checklistItems.length }, request: req })` **before** the transaction commits — mirroring the exact pattern `POST .../credentials` uses for `credential.created` (`apps/api/src/modules/credentials/routes.ts` lines 426-433).

**And** the payload never includes `newValue` or any derivative of it — `FORBIDDEN_AUDIT_KEYS` in `secure-route.ts` already strips keys like `value`/`secret` from the *default* writer's auto-payload, but since this route uses a **manual** payload object, the developer must not hand-construct a payload containing the plaintext or ciphertext. Only IDs and counts.

**Edge case — audit write fails (e.g. simulated DB error in the audit insert):** `writeHumanAuditEntryOrFailClosed` rethrows as `SameTransactionAuditWriteError`, which propagates out of the handler; the enclosing `ctx.tx` transaction rolls back entirely — **the rotation, its checklist items, the new credential version, and the retention lock are all rolled back too**. The client receives `503 { code: "audit_write_failed", ... }` (or whatever the existing SecureRoute error-mapping produces for this error type — verify against `secure-route.ts`'s catch handling and match it exactly, do not invent a new shape). A forced-audit-failure integration test (reuse the `FORCED_AUDIT_FAILURE` test harness constant already used by the credentials module, `credential-integration-context.ts`) must assert **zero** `rotations`/`rotation_checklist_items`/`credential_versions` rows exist after the failed attempt.

---

### AC-15: RLS Cross-Org Isolation — Direct DB-Level Test

**Given** RLS is the enforced tenant-isolation mechanism (not app-layer filtering),
**When** a direct Drizzle query is run with `app.current_org_id` set to org A,
**Then** rotations and checklist items belonging to org B are invisible even to a raw `SELECT * FROM rotations` (no `WHERE org_id = ...` in the query itself) — write a test analogous to `packages/db/src/__tests__/projects-rls-isolation.test.ts`, using the repo's `withTestOrg()`/`withOrg()` test helpers, that: (1) inserts a rotation as org A, (2) switches RLS context to org B, (3) asserts the row is not returned by an unscoped `SELECT`, (4) asserts an attempted `UPDATE`/`DELETE` from org B's context affects zero rows (the `WITH CHECK` default backstop).

**Edge case — cross-org write attempt:** with `app.current_org_id` set to org B, attempt `INSERT INTO rotations (..., org_id) VALUES (..., '<org-A-uuid>')` directly — RLS's default `WITH CHECK` (same as `USING`) rejects the row because `org_id <> current_setting(...)`. Assert this raises a policy-violation error, not a silent success.

---

### AC-16: Route Registration & Audit Classification

**Given** `route-audit.test.ts` derives registered routes from `app.ts` via static analysis and requires every route to be classified in `ROUTE_ACTION_CLASSIFICATIONS` (`apps/api/src/lib/route-exemptions.ts`),
**When** the three new routes are added,
**Then**:
1. Create `apps/api/src/modules/rotation/routes.ts` exporting `rotationRoutes(fastify: FastifyApp)`, registered in `apps/api/src/app.ts` via `await fastify.register(rotationRoutes, { prefix: '/api/v1/projects' })` (placed alongside the existing `credentialRoutes` registration — same prefix, since rotation routes nest under `/:projectId/credentials/:credentialId/rotations`).
2. Add three entries to `ROUTE_ACTION_CLASSIFICATIONS`:
   - `'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations'`: `{ action: 'mutation', auditEvent: 'rotation.initiated', sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed' }`
   - `'GET /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId'`: `{ action: 'read', auditOmissionReason: 'Rotation status read does not expose credential values.' }`
   - `'GET /api/v1/projects/:projectId/credentials/:credentialId/rotations'`: `{ action: 'read', auditOmissionReason: 'Rotation history list does not expose credential values.' }`
3. Add `AuditEvent.ROTATION_INITIATED = 'rotation.initiated'` to `packages/shared/src/constants/audit-events.ts` (both the `AuditEvent` const object and the `AuditEventType` union — follow the exact pattern of the existing `CREDENTIAL_*` entries).
4. `pnpm --filter @project-vault/api test route-audit.test.ts` passes with zero unclassified routes.

---

### AC-17: Rate Limiting

**Given** the repo-wide default rate limit (`120 req/min` per authenticated account) applies unless a route overrides it,
**When** the three rotation routes are registered,
**Then** `POST .../rotations` uses a tighter override consistent with other mutation-heavy security-sensitive routes: `{ max: 30, timeWindowMs: 60_000, key: 'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations' }` (rotation initiation is a deliberate, infrequent admin action — 30/min is generous headroom without allowing a compromised admin session to hammer the advisory lock). The two `GET` routes use the standard `120/min` default (no override needed).

---

### AC-18: Operational Metrics & Logging

**Given** the Maintainability NFR requires structured logging and Prometheus-compatible metrics, and rotation is a `rotation:*`-classified security-sensitive workflow (per architecture.md's pg-boss DLQ-monitoring note, even though this story adds no background job),
**When** rotation initiation succeeds, fails validation, hits the lock/409 path, or fails audit,
**Then** emit structured (pino) logs distinguishing each outcome — e.g. `{ event: 'rotation.initiate.success', credentialId, rotationId, itemCount }`, `{ event: 'rotation.initiate.conflict', credentialId }`, `{ event: 'rotation.initiate.audit_failed', credentialId }` — and increment a `prom-client` counter `rotation_initiations_total{outcome="success"|"conflict"|"validation_error"|"audit_failed"}`.

**Critical:** never log `newValue`, `encryptedValue`, or any request body field that could contain the rotated secret — log only IDs, counts, and the outcome discriminant. This mirrors the repo-wide "secret values must not appear in logs" NFR and the existing `redact-secrets.ts` plugin's intent (verify the new routes' request bodies are covered by its redaction list; `newValue` should be added to the redaction key list if it isn't already covered by a substring match like `value`).

---

### AC-19: Explicit Out of Scope

The following are **intentionally not implemented** in this story — each is a later Epic 5 story's job, and building any of them here would be scope creep that duplicates or conflicts with that story's design:

- **Checklist confirmation, failure, retry** (`POST .../checklist/:itemId/confirm|fail|retry`) — Story 5.2 (FR20, FR75).
- **Rotation completion** (`POST .../rotations/:id/complete`, the zero-dependency `acknowledgedNoDependencies` flag, retiring the old version) — Story 5.2 (FR21, FR22, AC-E5a).
- **Optimistic-lock `version` increments on the rotation record** — this story only ever writes `version: 1` at creation. Concurrent-modification `409`s on *updates* to an existing rotation are Story 5.2's concern (RS-E5a); this story's only concurrency concern is *initiation*, handled by the advisory lock + partial unique index (AC-5).
- **`GET .../rotations/upcoming?horizon=` (FR65)** and wiring the dashboard's `AC-E2d` "overdue rotations" placeholder to real data — Story 5.2.
- **Break-glass emergency rotation, stale-rotation recovery, dependency archival endpoint** — Story 5.3 (FR108, FR104).
- **Clearing `rotation_locked_at`** once a rotation completes or is abandoned — Story 5.2/5.3. This story only ever *sets* it, never clears it; a credential with a permanently-`in_progress` rotation (e.g., abandoned mid-development before 5.2 ships) will have its superseded version locked indefinitely, which is safe (over-retention, not data loss) but is a known, documented gap until 5.2 lands.
- **Updating Story 4.3's `checkActiveRotationsForUser` stub or Story 4.4's `findBlockingRotationIds` stub** to use the real `rotations` table — see "Cross-Epic Coordination" above. Flagged, not fixed, here.
- **Web/UI rotation screens** — see Product Surface Contract above.
- **`rotation:recover` startup job** — Story 5.3.

---

## Tasks / Subtasks

- [ ] **Task 1: Schema** (AC-1, AC-2, AC-3)
  - [ ] `packages/db/src/schema/rotations.ts`
  - [ ] `packages/db/src/schema/rotation-checklist-items.ts`
  - [ ] Export both from `packages/db/src/schema/index.ts`
  - [ ] Generate/author migration `0026_rotations.sql` (verify actual next-free number against `meta/_journal.json` first)
  - [ ] `pnpm --filter @project-vault/db check-rls` clean; `pnpm --filter @project-vault/db migrate` succeeds locally
- [ ] **Task 2: Shared Zod schemas** (packages/shared)
  - [ ] `packages/shared/src/schemas/rotations.ts`: `RotationStatusSchema`, `RotationChecklistItemStatusSchema`, `RotationChecklistItemSchema`, `RotationDetailSchema`, `RotationSummarySchema` (for history list)
  - [ ] Export from `packages/shared/src/index.ts`
  - [ ] Add `AuditEvent.ROTATION_INITIATED` to `packages/shared/src/constants/audit-events.ts` (const + type union)
- [ ] **Task 3: `apps/api/src/modules/rotation/` module**
  - [ ] `schema.ts`: `InitiateRotationBodySchema`, `RotationParamsSchema` (`{ projectId, credentialId, rotationId }`), `ListRotationsQuerySchema`
  - [ ] `service.ts`: `initiateRotation(tx, input)` implementing AC-4/AC-5/AC-13 step-by-step; `getRotationDetail(tx, params)`; `listRotationHistory(tx, params)`
  - [ ] `routes.ts`: `rotationRoutes(fastify)` registering all three endpoints via `secureRoute()` (AC-4 through AC-12, AC-16, AC-17)
  - [ ] Register `rotationRoutes` in `apps/api/src/app.ts`
- [ ] **Task 4: Route audit + classification** (AC-16)
  - [ ] Add 3 entries to `ROUTE_ACTION_CLASSIFICATIONS`
  - [ ] `route-audit.test.ts` passes
- [ ] **Task 5: Metrics/logging** (AC-18)
  - [ ] `rotation_initiations_total` counter; structured pino events; verify `redact-secrets.ts` covers `newValue`
- [ ] **Task 6: Integration & unit tests** (AC-4 through AC-15, AC-Quick-Reference "Tests" row)
  - [ ] Happy path (single dependency, multi-dependency, zero-dependency)
  - [ ] Concurrent initiation: both the lock-contention path and the partial-unique-index backstop path
  - [ ] Role enforcement (403 member/viewer; 201 admin/owner)
  - [ ] Cross-org/cross-project/nonexistent-credential 404 (all three endpoints)
  - [ ] Sealed vault 503
  - [ ] Validation 422s (table in AC-10)
  - [ ] Retention-lock verified against the real purge-candidate query (AC-13, with `retentionCount: 1`)
  - [ ] Rotation detail read (found + 404 for nonexistent/cross-tenant rotation ID)
  - [ ] Rotation history pagination (empty history, single page, deep page beyond total)
  - [ ] RLS cross-org isolation, direct-query style (AC-15)
  - [ ] Audit-write-failure rollback (AC-14) — assert zero rows across all three affected tables

---

## Dev Notes

### Project Structure Notes

- New module: `apps/api/src/modules/rotation/{schema,service,routes}.ts` + colocated `*.test.ts` files (mirrors `modules/credentials/` layout).
- New schema files: `packages/db/src/schema/rotations.ts`, `packages/db/src/schema/rotation-checklist-items.ts`.
- New shared schema file: `packages/shared/src/schemas/rotations.ts`.
- No new worker/job file in this story (5.3 adds `workers/rotation-recover.ts`; 5.2 adds nothing to `workers/`, its endpoints are all synchronous routes).
- Architecture's intended directory (`architecture.md` line 992-994) lists `modules/rotation/service.ts # rotation state machine; uses withRotationLock()` — there is **no existing `withRotationLock()` helper in the codebase**; this story introduces the lock inline in `service.ts` (a small local helper is fine, e.g. `async function tryAcquireRotationLock(tx, credentialId, orgId): Promise<boolean>`) rather than inventing a shared abstraction prematurely — if Story 5.3's `rotation:recover` job ends up needing the same lock-acquire logic, extract a shared helper then, not now.

### Key Code Patterns to Follow

- **Row locking + version numbering:** copy `addCredentialVersion()` in `apps/api/src/modules/credentials/service.ts` (lines ~320-365) almost verbatim for the new-version-insert half of `initiateRotation()` — `.for('update')` on the credential row, `MAX(version_number) + 1`, `encryptValue()`, catch `isUniqueViolation()`.
- **Advisory lock:** copy the two-key `pg_advisory_xact_lock(hashtext($1), hashtext($2))` call style from `apps/api/src/modules/auth/mfa-login.ts` line 129, but use **`pg_try_advisory_xact_lock`** (boolean-returning, non-blocking) instead of the blocking `pg_advisory_xact_lock` — `mfa-login.ts` uses the blocking variant because it's fine to wait there; rotation initiation must never block (architecture.md's explicit requirement).
- **Fail-closed audit:** copy the `writeCredentialAuditOrFailClosed`-style call from `credentials/routes.ts` lines 426-433, but call the generic `writeHumanAuditEntryOrFailClosed` (`apps/api/src/lib/audit-or-fail-closed.ts`) directly with `resourceType: 'rotation'` — do not create a rotation-specific audit wrapper function unless a second call site needs one later.
- **Params/response parsing:** `parseParams`, `parseBody`, `validationError` from `apps/api/src/lib/route-helpers.js` — identical usage to every credentials route.
- **Pagination:** `parsePagination`/`paginationOffset`/`buildPaginationMeta` from `apps/api/src/lib/pagination.ts` — identical usage to `GET .../credentials`.
- **Zod style:** `.strict()` + `.meta({ id: '...' })` on every request/response schema (see `packages/shared/src/schemas/credential-dependencies.ts` and `apps/api/src/modules/credentials/schema.ts` for the exact idiom).

### Tech Stack (Repo Pinned)

- Drizzle ORM 0.45.x, `drizzle-kit generate` for migrations.
- Zod v4 (`zod/v4` import path, matches `credentials/schema.ts`).
- Fastify v5 + `@fastify/type-provider-zod`.
- `packages/crypto`: `encrypt()`, `withSecret()`, `getPrimaryKey()` — no new crypto primitives needed, reuse 2.2's.
- `postgres.js` connection pooling — this is precisely why the advisory lock must be transaction-scoped (`_xact_lock`), not session-scoped (see Architecture Conflict Resolution table).

### Architecture Compliance

- MFA enforcement for `admin`/`owner` roles is already handled globally by the auth middleware (architecture.md's "MFA enforcement rule" — checked once per request, not per-route). No route-level `requireMfa` option is needed here beyond the framework default.
- RLS: every table has `org_id`; all queries run inside `db.transaction()` via `ctx.tx` (SecureRoute already guarantees this — no bare `db.select()`/`db.insert()` calls are possible in route handlers by construction).
- `NFR-REL3`/atomic-writes NFR ("rotation is a compound transaction (new version + rotation log + per-system checklist state + notification queue entry) — all committed or none"): this story's transaction covers version + rotation + checklist state (three of the four); the notification-queue entry is **not written by this story** — Story 5.1's epic AC never mentions notifying anyone at *initiation* (only failures/break-glass in 5.2/5.3 notify). Do not add a speculative notification write; there's no recipient/template designed for "rotation initiated" and inventing one would be scope creep.

### Anti-Patterns (Do Not)

- Do NOT use `pg_advisory_lock`/`pg_try_advisory_lock` (session-scoped) — always the `_xact_` variant.
- Do NOT add `break_glass_overlap` to the `rotations.status` CHECK — it belongs on `credential_versions` (Story 5.3), not here.
- Do NOT make `initiatedBy` a FK to `user_identity_tokens` — it's a plain `users.id` FK (see Architecture Conflict Resolution).
- Do NOT implement checklist confirmation, completion, or the `acknowledgedNoDependencies` flag — Story 5.2.
- Do NOT touch `4-3-account-deactivation-and-recovery.md`'s or `4-4-project-archival.md`'s stub code — flag the follow-up, don't perform it.
- Do NOT log or audit-payload the plaintext/ciphertext `newValue`.
- Do NOT collapse duplicate-`systemName` dependencies into one checklist item — one row per `dependencyId`, always.
- Do NOT skip the partial-unique-index backstop test by testing the advisory lock alone — both mechanisms need independent coverage (AC-5).

---

## Previous Story Intelligence

There is no prior story *within Epic 5* (this is Story 5.1, the first). The most relevant prior-story intelligence comes from the two stories this one directly consumes:

### Story 2.2 (`credentials` + `credential_versions`, done)
- Built `rotation_locked_at` on `credential_versions` **specifically anticipating this story** ("Retention exemption seam... Epic 5 sets/clears it"). Confirmed still present and unused (`isNull(credentialVersions.rotationLockedAt)` filters in `prune-credential-versions.ts`).
- `encryptValue()`/`getPrimaryKey()`/`currentKeyVersion()` are the exact primitives to reuse — do not reinvent encryption call sites.
- ADR-2.2-01 established `credentials`/`credential_versions` naming over architecture.md's `secrets`/`secret_versions` — the same "epic naming wins over stale architecture doc" principle applies to every conflict resolved in this story's own table above.

### Story 2.4 (`credential_dependencies`, done)
- Explicitly designed the dependency record shape "for zero reshape" by this story (ADR-2.4-01) — confirmed: `id`, `systemName`, `archivedAt` map directly into `rotation_checklist_items` with no transformation needed beyond the snapshot copy.
- Documented the point-in-time-snapshot contract this story must honor: read dependencies **inside the advisory-locked transaction** (2.4's own text: "Story 5.1 reads it inside its own advisory-locked transaction... so concurrent 2.4 add/archive cannot mutate a checklist mid-generation").
- Confirmed duplicate-`systemName` dependencies are intentional and must NOT be deduplicated.

### Stories 4.3 and 4.4 (both `ready-for-dev`, not yet implemented — read, do not modify)
- Both contain forward-looking stubs whose shape constrains this story's schema (`project_id`, `credential_id`, `initiated_by`, `status` CHECK values) — see "Cross-Epic Coordination" at the top of this file. This is an unusual but real dependency direction: a *later-numbered but earlier-created* story constrains an *earlier-numbered but later-created* story's schema. Get the column names and status vocabulary right the first time; a later migration to widen `4-3`/`4-4`'s expectations would touch three story files instead of zero.

---

## Git Intelligence Summary

Recent commits on this branch (`git log --oneline -10` at story-creation time) show the established pattern for landing a story: schema + migration first, then module (schema/service/routes), then route-audit classification, then tests, with a separate "docs(story): create and adversarially review" commit preceding implementation commits for the *next* story. No commits yet exist for Epic 5 — this is the first. The immediately preceding commits (`4-4-project-archival`, `4-3-...`, `4-2-...`) all follow the same `packages/db/src/schema/*.ts` → `*.sql` migration → `apps/api/src/modules/<domain>/*.ts` → route-exemptions.ts → tests ordering; follow the same ordering for this story's Task list above.

---

## Pre-mortem Failure Modes

1. **Forgetting the partial unique index and relying on the advisory lock alone.** If `pg_try_advisory_xact_lock` is ever refactored, removed, or bypassed (e.g. a future direct-DB job initiates a rotation without going through the route), two `in_progress` rotations could exist for one credential simultaneously, corrupting the "at most one active rotation" invariant every later Epic 5 story assumes. The partial unique index (AC-1) is the actual guarantee; the lock is an optimization to fail fast without a wasted `INSERT`/rollback round-trip.
2. **Setting `rotation_locked_at` on the wrong version.** It must be the *previous* highest version (the one being superseded), read and row-locked (`FOR UPDATE`) *before* inserting the new version — not the newly-inserted version itself (which needs no protection; it's already the highest, hence already retention-safe) and not an arbitrary older version.
3. **Reading the dependency list outside the locked transaction** (e.g. as a separate query before opening `ctx.tx`, or after committing) — reintroduces the exact race 2.4 warned about: a concurrent dependency archive could remove a system from the checklist that should have been included, or vice versa.
4. **Treating `initiatedBy` as nullable-and-unused** — Story 4.3's stub explicitly needs to query rotations by user later; leaving this column unpopulated or pointing at the wrong table breaks that story's eventual real implementation silently (no test would catch it until 4.3's own follow-up work).
5. **Confusing "current value" with "rotation complete."** A common misreading is that the new value shouldn't be live until the rotation completes. Per the epic (developer "who has updated a credential in its target systems" — external systems are already updated *before* calling this endpoint), the new version is live immediately upon initiation. Do not add a "pending" version state that hides the new value from `GET .../value` until Story 5.2's complete endpoint runs — that contradicts the epic's own framing and would break the FR22 "retire only after complete" semantics, which is about the *old* version's fate, not the new version's visibility.
6. **Widening the `status` CHECK constraints incompletely.** If only `'in_progress'` is added to the CHECK (forgetting `'completed'`, `'abandoned'`, `'stale_recovery'`, `'break_glass_complete'`), Story 5.2/5.3 will need a second migration just to relax a constraint this story could have gotten right immediately using information already available in the epic (5.1-5.3 are fully specified in `epics.md` today).

---

## ADRs

### ADR-5.1-01: Rotation initiation uses a transaction-scoped, non-blocking advisory lock plus a partial unique index — not a session-scoped lock

Architecture.md's prose (`pg_try_advisory_lock`, implicitly session-scoped) cannot practically span the multi-request lifetime of a rotation and risks a connection-pool lock leak. This story uses `pg_try_advisory_xact_lock(hashtext(credentialId), hashtext(orgId))` — auto-released at commit/rollback — purely to fail fast on the *initiation* race, backed by `idx_rotations_one_in_progress_per_credential` (a partial unique index on `rotations(credential_id) WHERE status = 'in_progress'`) as the actual, durable, connection-independent invariant. This mirrors the existing two-key `hashtext()` pattern already used in `mfa-login.ts` and `check-failed-auth-threshold.ts`.

### ADR-5.1-02: `rotations.status` and `rotation_checklist_items.status` CHECK constraints define the complete Epic 5 state vocabulary now

Rather than widening a CHECK constraint in Story 5.2 and again in 5.3 (two extra migrations touching a table this story owns), all five `rotations` statuses (`in_progress`, `completed`, `abandoned`, `stale_recovery`, `break_glass_complete`) and all four `rotation_checklist_items` statuses (`unconfirmed`, `confirmed`, `failed`, `max_retries_exceeded`) are declared in this story's migration, even though only `in_progress`/`unconfirmed` are ever written here. This is safe because the full state machine is already fully specified in `epics.md` Stories 5.1-5.3 today — there is no risk of guessing wrong. Both are `text` + `CHECK`, not Postgres `enum` types, matching the `credential_dependencies.system_type` precedent (ADR-2.4-07) for future one-line-CHECK-change flexibility.

### ADR-5.1-03: `initiatedBy` is a plain `users.id` FK, matching `createdBy` elsewhere — not a `user_identity_tokens` reference

The epic's "user_identity_token ref" phrasing is PRD-level shorthand, not a literal schema instruction — `user_identity_tokens` is exclusively the audit-actor pseudonymization table (populated via `firstActorTokenIdForUser()` inside the audit writer), never a business-data FK target elsewhere in this schema. `initiatedBy` follows the exact precedent of `credentials.createdBy` / `credential_dependencies.createdBy`. This also happens to be exactly what Story 4.3's forward-referencing stub (`checkActiveRotationsForUser(tx, userId)`) expects to query against.

### ADR-5.1-04: The new credential version is written — and becomes "current" for reveal purposes — at initiation, not at completion

FR22 ("retires the old credential version only after... completion") governs the *old* version's purge/retirement bookkeeping, not which version `GET .../value` serves. Because rotation initiation implies the developer already updated the value in external systems before calling this endpoint, the new version must be live immediately. The old version is protected from *deletion* (via `rotation_locked_at`) during the rotation, not hidden from being superseded as "current."

### ADR-5.1-05: `rotation_checklist_items.systemName` is copied at creation time, never live-joined to `credential_dependencies`

If Story 2.4's dependency `systemName` is edited after a rotation completes (2.4 has no edit endpoint today, but nothing prevents one being added later), historical checklist items must continue showing the name as it was *at rotation time* — an audit/history table that silently reflects present-day edits to a foreign row is a correctness bug waiting to happen. This mirrors the general principle that `audit_log_entries` payloads are also point-in-time snapshots, never live joins.

---

## References

- Epic source: `_bmad-output/planning-artifacts/epics.md` lines 1546-1589 (Epic 5 intro + Story 5.1), plus the `PJ1`, `AC-E5a`, `RS-E5a` epic-level notes at lines 1552-1559.
- PRD: `_bmad-output/planning-artifacts/prd.md` lines 877-887 (FR18-FR23, FR65, FR66, FR75), lines 1036-1043 (Reliability NFRs — atomic writes, rotation durability).
- Architecture: `_bmad-output/planning-artifacts/architecture.md` lines 777-784 (advisory-lock 409 pattern — see ADR-5.1-01 for the reconciliation), lines 903-931 (canonical schema names), lines 944-1300 (directory structure, `modules/rotation/`), line 1375 (multi-instance guard), lines 1449 (v2 dual-approval note, explicitly out of scope for v1/this story).
- Predecessor schema + seams: `_bmad-output/implementation-artifacts/2-2-credential-storage-and-retrieval-with-version-history.md` (AC-1, AC-2, ADR-2.2-01, `rotation_locked_at` seam), `_bmad-output/implementation-artifacts/2-4-dependent-system-recording-and-expiry-rotation-schedules.md` (AC-1, cross-story table row "5.1", ADR-2.4-01/02/07).
- Forward-stub dependents (read, do not modify): `_bmad-output/implementation-artifacts/4-3-account-deactivation-and-recovery.md` (D7), `_bmad-output/implementation-artifacts/4-4-project-archival.md` (AC-4, ADR-4.4-02/03/04).
- Product Surface Contract rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`.
- Dashboard placeholder this story does NOT touch: `_bmad-output/implementation-artifacts/deferred-work.md` line 51 (`AC-E2d`).
- SecureRoute framework + same-tx fail-closed audit: `apps/api/src/lib/secure-route.ts`, `apps/api/src/lib/audit-or-fail-closed.ts`.
- Route-audit registries: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`.
- Audit-event constants: `packages/shared/src/constants/audit-events.ts`.
- Advisory-lock precedent: `apps/api/src/modules/auth/mfa-login.ts` line 129, `apps/api/src/workers/check-failed-auth-threshold.ts` line 229.
- Retention job (consumes `rotation_locked_at`): `apps/api/src/workers/prune-credential-versions.ts`.
- Migration journal (verify R1 before generating): `packages/db/src/migrations/meta/_journal.json`.
- Repo TDD rule: `AGENTS.md`.

---

## Dev Agent Record

### Agent Model Used

_(to be filled by dev agent)_

### Debug Log References

### Completion Notes List

### File List
