# Story 4.4: Project Archival

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-28 — comprehensive developer guide for non-destructive project archival with dependency guards. This story adds two endpoints (archive/unarchive), an `?includeArchived` filter on the project list, a fail-closed write guard that rejects mutations against archived projects (410), an active-rotation dependency check (409), and the Epic 7 machine-user stub. It reconciles a cross-epic dependency: the active-rotation guard reads the `rotations` table created in Epic 5 (Story 5.1). Read "Architecture Conflict Resolution" before coding. -->

## Story

As a project owner,
I want to archive projects that are no longer active and restore them if needed,
so that they disappear from my active dashboard while all credentials, version history, rotation records, and audit entries are preserved non-destructively.

*Covers: FR63.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-4.4-Project-Archival`]

---

## ⚠️ Cross-Epic Sequencing — READ FIRST

This story sits in Epic 4 but its **active-rotation dependency guard reads the `rotations` table that is created in Epic 5, Story 5.1**, and its **machine-user dependency guard depends on Epic 7**. The epic author wrote the FR63 acceptance criteria assuming rotation records already exist (epics.md line 1527). Two facts make this safe:

1. **Epic ordering vs. delivery ordering differ.** Epic 4 is `🔵 Tier 1 — Team beta`; the epic explicitly states *"FR63 (project archival) can be deferred; projects at beta scale are rarely archived"* (epics.md line 1412). Epic 5 (rotation) is `🟣 Tier 2 — recommended beta target`. The realistic delivery order is: rotation (5.1) ships, **then** 4.4.
2. **The story is implementable in either order** thanks to a documented table-existence seam (see AC-4 and ADR-4.4-02). When the `rotations` table exists, the guard is real; if 4.4 is somehow built before Story 5.1, the guard degrades to "no active rotations" exactly like the Epic 7 machine-user stub — and QA must not sign off FR63 until **both** Epic 5 (rotation guard live) and Epic 7 (machine-user guard live) are delivered.

**Recommended action:** implement 4.4 after Story 5.1. If your sprint forces strict epic order (4.4 before 5.1), implement the seam in AC-4 and track the QA hold in `deferred-work.md`.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| **Story 2.1 is implemented** (`projects` table, `project_memberships` table, `modules/projects/routes.ts`, `GET /api/v1/projects`) | 4.4 adds two routes to the existing projects module, extends the existing list endpoint with `?includeArchived`, and toggles the existing `projects.archived_at` column (created in 2.1 AC-1, currently write-never). 2.1 is `ready-for-dev` — confirm it is **done** before starting 4.4. |
| **Story 4.1 is implemented** (`project_memberships` role enforcement / project-scoped authorization) | 4.4 enforces **project-owner-only** archive/unarchive. 4.1 is the architectural step that introduces per-project roles (ADR-2.1-01 "Required action at Story 4.1"). 4.4 reads `project_memberships.role = 'owner'`; confirm 4.1 established how project roles are resolved (in-handler query vs. a `projectRole` seam on `AuthContext`). If 4.1 added a resolver, reuse it; do not reinvent. |
| **Story 5.1 `rotations` table exists** (recommended — see "Cross-Epic Sequencing") | The active-rotation guard queries `rotations WHERE status IN ('in_progress','stale_recovery') AND project_id = :id`. If absent, use the AC-4 table-existence seam. |
| **Migration numbering (verify, do NOT hardcode)** | The active migration tip on this branch is **`0012_refresh_tokens_org_id.sql`** (`packages/db/src/migrations/meta/_journal.json`). Story 2.1 lands `0013_projects.sql`; later Epic 2/4/5 stories consume further numbers. **Before generating any migration for 4.4, re-read `packages/db/src/migrations/meta/_journal.json` and use the next free number.** 4.4 likely needs **no new migration** (the `archived_at` column already exists from 2.1) — see AC-1. Only generate one if you add an index. |
| `apps/api/src/lib/route-exemptions.ts` `ROUTE_ACTION_CLASSIFICATIONS` exists | 4.4 adds two entries (archive, unarchive); the `route-audit.test.ts` CI gate enforces this. |
| Story 1.11 `SecureRoute` framework is merged and passing CI | Both new routes must use `secureRoute()`; the active-rotation/machine-user checks and the audit write run inside the SecureRoute `tx`. |

---

## Epic Cross-Story Context

| Story | Relationship to 4.4 |
|---|---|
| 1.4 | Established Drizzle schema conventions (`orgScoped()`, snake_case tables, `withTestOrg()` for RLS-active tests, `update_updated_at_column()` trigger). 4.4 changes no schema; it only writes `archived_at`. |
| 1.11 | Provides `secureRoute()`, `SecureRouteContext`, RLS middleware, the same-transaction audit writer, and the `route-audit.test.ts` CI gate. Both 4.4 routes go through this framework. |
| 2.1 | Created the `projects` table **with the `archived_at` column already present** (2.1 AC-1) and `GET /api/v1/projects` **already filtering `archivedAt IS NULL`** (2.1 AC-6). 2.1 explicitly deferred archival: *"Project archival (`DELETE` or `PATCH archived: true`) — `archivedAt` column is reserved for Story 4.4"* (2.1 AC-16). 4.4 is the consumer of that reserved column. **Do not add an `archived_at` column — it exists.** |
| 2.2 | Adds the `secrets` (credentials) table with a `project_id` FK. 4.4's "no new credentials after archive" guard (AC-5) protects `POST /secrets`. The guard is a shared helper that 2.2's create route (and 4.1's invite/member routes) must call. Coordinate: if 2.2/4.1 are already done, 4.4 inserts the guard into their handlers; if not, 4.4 ships the helper and the consuming stories wire it in (track in `deferred-work.md`). |
| 2.4 | Adds `secret_dependencies` and activates `expiresAt`/`rotationSchedule`. Not a direct input to 4.4, but the rotation records 4.4 inspects originate from rotations against these credentials. |
| 4.1 | Adds team invitations + per-project role assignment. 4.4's "no new invitations after archive" guard (AC-5) protects 4.1's `POST /projects/:projectId/invitations`. 4.4 also depends on 4.1 for project-owner role resolution (see Prerequisites). |
| 4.2 | Adds `POST /projects/:projectId/members` and ownership transfer. 4.4's "no new members after archive" guard (AC-5) protects the add-member path. |
| 4.3 | Account deactivation reuses the **identical 409 active-rotation block shape** (`409 { error: "active_rotations", rotationIds: [...] }`, epics.md line 1501). 4.4 MUST use the same error code and body shape so clients handle both uniformly. Extract a shared `findActiveRotationsForProject` / `findActiveRotationsForUser` pattern if 4.3 already created one. |
| 5.1 | Creates the `rotations` table with `status` (`in_progress`, …) and `project_id`. This is the data source for 4.4's active-rotation guard. |
| 5.3 | Adds `stale_recovery` and `break_glass_overlap` rotation statuses. 4.4's guard must treat `in_progress` **and** `stale_recovery` as "active" (both are unresolved and would be orphaned by archival). `break_glass_overlap` is a transient post-completion drain window — see ADR-4.4-03 for why it does **not** block. |
| 7.1 | Implements `GET /api/v1/projects/:projectId/machine-users/active-keys` and **closes the 4.4 machine-user stub** (epics.md line 1821). Until then, the stub returns "no machine-user blockers". |
| 8.x | Audit log has a FK to `projects(id)` with `ON DELETE SET NULL` (ADR-2.1-04). Archival is non-destructive (no row deletion), so audit rows keep their `project_id` intact — archived-project audit history remains fully queryable. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 4.4 | Rationale |
|---|---|---|
| Architecture canonical table noun is `secrets` and *"never `credentials` in URL paths"* (architecture.md line 575); epics + Story 2.1/2.2 use `credentials` in URLs | **For 4.4, the only domain object is `projects`** — 4.4 adds no secret/credential routes. When 4.4's guards reference credential rows, query the **table** by its real implemented name. Confirm at code time whether 2.2 implemented the table as `secrets` (architecture) or `credentials` (epics) and match it. Do **not** introduce a third name. | The arch/epics naming drift is real but orthogonal to 4.4; 4.4 must not relitigate it, only follow whatever 2.2 shipped. |
| Architecture `AuditEvent` registry is `UPPER_SNAKE_CASE` (e.g., `SECRET_ARCHIVED`, architecture.md line 548) | **Follow Story 2.1's established convention: lowercase dotted** — `project.archived`, `project.unarchived` (matches 2.1's `project.created` / `project.updated`). Add both to `AuditEventType` in `packages/shared/src/constants/audit-events.ts`. | 2.1 already shipped `project.*` lowercase-dotted events; consistency within the `project.*` family beats matching the stale registry. There is no `PROJECT_ARCHIVED` precedent to honor. |
| Epic AC says archive is for "project owner"; "unarchive (owner only)" | Enforce **project-membership owner**, not merely org role. SecureRoute `minimumRole` gates org role; add an in-handler check that the caller holds `project_memberships.role = 'owner'` for the target project (org `owner` is always allowed). Return `403 { code: "insufficient_role" }` otherwise. See AC-2. | "Project owner" is a project-scoped concept (`project_memberships`), distinct from org role. 4.1 introduced project roles; 4.4 enforces them for the highest-impact lifecycle action. |
| Epic says active-rotation check blocks archival | Treat rotation statuses `in_progress` **and** `stale_recovery` as blocking; `break_glass_overlap` does NOT block (ADR-4.4-03). If the `rotations` table does not exist yet, use the table-existence seam (AC-4, ADR-4.4-02). | A stale-recovery rotation is unresolved work that archival would orphan. Break-glass overlap is a self-resolving drain window already past the human-action point. |
| Epic says machine-user check is "explicitly stubbed … returning `false` (no block) until Epic 7" | Implement exactly as a named stub function `hasActiveMachineUserKeys(tx, projectId): Promise<false>` with the required TODO comment. QA sign-off on FR63 is gated on Epic 7 closing it. | Matches epics.md lines 1416–1417, 1529 verbatim. |
| `GET /api/v1/projects` is unpaginated (2.1 ADR-2.1-06) | The `?includeArchived=true` filter (AC-3) does not change pagination — it only widens the `WHERE` clause. Keep the `{ items, total }` envelope. | Forward-compatible; no new pagination contract. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Schema | **No migration required** — `projects.archived_at` already exists (2.1). Add `idx_projects_org_archived` only if list-query perf needs it (optional, see AC-1). |
| POST /:projectId/archive | Owner-only. Blocks on active rotations (409). Machine-user stub (Epic 7, no block). Sets `archived_at = NOW()`. Idempotency: already-archived → 409. Emits `project.archived`. |
| POST /:projectId/unarchive | Owner-only. Clears `archived_at`. Already-active → 409. Emits `project.unarchived`. |
| GET /api/v1/projects | New `?includeArchived=true` query param; default still hides archived. Archived items carry `archivedAt` (ISO) and `isArchived: true`. |
| Write guard | Archived projects reject new credentials / members / invitations / metadata edits with `410 { code: "project_archived" }`. Reads still allowed. |
| Non-destructive | Archival deletes nothing: credentials, versions, rotation history, audit rows all preserved. |
| RLS | Cross-org archive/unarchive impossible; cross-org returns 404 (not 403). |
| Route audit | Both routes in `ROUTE_ACTION_CLASSIFICATIONS`; `route-audit.test.ts` passes. |
| Audit fail-closed | Archive/unarchive never commit without their audit row (same-tx coupling → 503 on audit failure). |
| Sealed vault | Both routes return `503 { status: "sealed" }` when vault sealed (not allowlisted). |
| Integration tests | Archive-with-active-rotations (blocked 409), archive-clean (200), archived hidden from default list / shown with `?includeArchived`, no-new-credentials-after-archive (410), unarchive (200), cross-org 404, double-archive 409, owner-only 403, audit-failure rollback, sealed 503. |
| Web app | Archive/Unarchive actions (owner-only), confirm dialog, "Show archived" toggle, 409/410 error mapping. |

---

### AC-1: Schema — Reuse the Existing `archived_at` Column (No New Migration)

**Given** Story 2.1 already created `projects.archived_at timestamptz NULL` (2.1 AC-1) and reserved it for this story (2.1 AC-16),
**When** Story 4.4 implements archival,
**Then** **do not add a column and do not write a `CREATE TABLE` / `ALTER TABLE ADD COLUMN` migration for `archived_at`.** Confirm the column exists:

```bash
# Confirm the column is present before coding (do not re-add it)
rg "archivedAt" packages/db/src/schema/projects.ts
```

The Drizzle definition from 2.1 (do not duplicate, shown for reference):

```typescript
archivedAt: timestamp('archived_at', { withTimezone: true }),  // nullable; null = active, non-null = archived
```

**And** an index to keep `GET /api/v1/projects` fast as archived rows accumulate is **optional** in 4.4. If you add it, it is the only schema change and requires a real migration at the next free journal number (verify `meta/_journal.json` — do NOT hardcode):

```sql
-- OPTIONAL: only if the partial index on active projects is needed for list performance.
-- Story 2.1 already added idx_projects_org_created. A partial index narrows the default list scan.
CREATE INDEX idx_projects_org_active
  ON projects (org_id, created_at DESC)
  WHERE archived_at IS NULL;
```

**And** if you add the index, run `pnpm --filter @project-vault/db generate`, then `pnpm --filter @project-vault/db check-rls` (must still pass — RLS already covers `projects` from 2.1), then `pnpm --filter @project-vault/db migrate`.

**And** **do not** add `projects` to `EXCLUDED_TABLES` in `check-rls-coverage.ts` — RLS coverage for `projects` was established in 2.1 and must remain.

---

### AC-2: POST /api/v1/projects/:projectId/archive — Archive Project

**Given** a project **owner** is authenticated (MFA per the project's role-enforcement policy from Epic 1),
**When** they call `POST /api/v1/projects/:projectId/archive`,
**Then** the system runs dependency checks, and on success sets `archived_at = NOW()` and returns the archived project.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/archive
Cookie: access-token=<jwt>
```
(No request body. If a body is sent, ignore it — there are no archive parameters in v1.)

**Successful response (`200 OK`):**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000010",
    "name": "Payments API",
    "slug": "payments-api",
    "archivedAt": "2026-06-28T15:42:00.000Z",
    "isArchived": true
  }
}
```

**Handler flow (exact order — fail fast, cheapest checks first):**

1. **Validate** `projectId` as `z.uuid()` → `422 { code: "validation_error" }` on malformed.
2. **Load the project** within the RLS `tx`. Zero rows (not found or wrong org) → `404 { code: "project_not_found", message: "Project not found" }`. **Never 403 for wrong-org — prevents enumeration** (same rule as 2.1 AC-7).
3. **Idempotency / double-archive:** if `project.archivedAt` is already non-null → `409 { code: "already_archived", message: "Project is already archived" }`.
4. **Ownership check:** the caller must hold `project_memberships.role = 'owner'` for this project (org `owner` always allowed). Otherwise `403 { code: "insufficient_role", message: "Only the project owner can archive a project" }`. (SecureRoute `minimumRole: 'admin'` is the org-level floor; this in-handler check enforces the project-owner requirement.)
5. **Active-rotation guard** (AC-4): if blocking rotations exist → `409 { code: "active_rotations", rotationIds: [...] }`.
6. **Machine-user guard** (AC-4 stub): always `false` until Epic 7 → no block.
7. **Archive:** `UPDATE projects SET archived_at = NOW() WHERE id = :projectId` using `.returning()`; if `.returning()` yields 0 rows (lost the row to a concurrent op), return `404`.
8. The SecureRoute same-tx audit writer emits `project.archived` (see AC-7).

**Ownership check query (concrete):**
```typescript
const [membership] = await tx
  .select({ role: projectMemberships.role })
  .from(projectMemberships)
  .where(and(
    eq(projectMemberships.projectId, params.projectId),
    eq(projectMemberships.userId, auth.userId),
  ))
  .limit(1)

const isProjectOwner = membership?.role === 'owner'
const isOrgOwner = auth.orgRole === 'owner'
if (!isProjectOwner && !isOrgOwner) {
  return reply.status(403).send({
    code: 'insufficient_role',
    message: 'Only the project owner can archive a project',
  })
}
```
> If Story 4.1 added a reusable project-role resolver (e.g., on `SecureRouteContext` or a helper), use it instead of this inline query. Do not reinvent project-role resolution if 4.1 already centralized it.

**Archive update (concrete):**
```typescript
const [archived] = await tx
  .update(projects)
  .set({ archivedAt: new Date(), updatedAt: new Date() })
  .where(and(eq(projects.id, params.projectId), isNull(projects.archivedAt)))
  .returning({ id: projects.id, name: projects.name, slug: projects.slug, archivedAt: projects.archivedAt })

if (!archived) {
  // Either gone (concurrent delete) or already archived by a racing request.
  return reply.status(409).send({ code: 'already_archived', message: 'Project is already archived' })
}
return { data: { ...archived, archivedAt: archived.archivedAt?.toISOString() ?? null, isArchived: true } }
```
> The `isNull(projects.archivedAt)` predicate in the `WHERE` makes the archive **atomic and race-safe**: two concurrent archive requests cannot both succeed; the loser gets 0 rows → 409.

**SecureRoute security:**
```typescript
security: {
  minimumRole: 'admin',        // org-level floor; in-handler project-owner check is stricter
  requireMfa: true,            // archival is a high-impact lifecycle action
  rateLimit: { max: 10, timeWindowMs: 60_000, key: 'POST /api/v1/projects/:projectId/archive' },
  writeAuditEvent: {
    eventType: 'project.archived',
    resourceType: 'project',
    resourceIdFromParams: 'projectId',
  },
}
```

**And** timestamps are serialized with `.toISOString()` before sending (the response schema declares `z.iso.datetime()`; Drizzle returns `Date`). Same rule as 2.1 Dev Notes "Timestamp serialization".

---

### AC-3: GET /api/v1/projects — `?includeArchived` Filter

**Given** Story 2.1's `GET /api/v1/projects` already filters `archivedAt IS NULL` (2.1 AC-6),
**When** Story 4.4 adds archived visibility,
**Then** add an optional `?includeArchived=true` query parameter.

| `includeArchived` | Behavior |
|---|---|
| absent / `false` | Return **only active** projects (`archived_at IS NULL`) — unchanged 2.1 default. |
| `true` | Return **all** projects (active + archived). |

**Query schema (extend the 2.1 list route):**
```typescript
export const ListProjectsQuerySchema = z
  .object({
    includeArchived: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),  // query strings are strings; coerce explicitly
  })
  .meta({ id: 'ListProjectsQuery' })
```
> Do **not** use `z.coerce.boolean()` — it treats the string `"false"` as truthy. The explicit `=== 'true'` transform is correct.

**And** the list query conditionally applies the archived filter:
```typescript
const parsed = ListProjectsQuerySchema.safeParse(req.query)
if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))
const { includeArchived } = parsed.data

const whereClause = includeArchived
  ? eq(projectMemberships.userId, auth.userId)            // all projects (active + archived)
  : and(eq(projectMemberships.userId, auth.userId), isNull(projects.archivedAt))
// NOTE: keep the existing innerJoin on (projectId AND userId) from 2.1 AC-6.
```

**And** each item gains two fields so the UI can render archived state (extend `ProjectSummarySchema` in `packages/shared/src/schemas/projects.ts`):
```typescript
archivedAt: z.iso.datetime().nullable(),   // null for active projects
isArchived: z.boolean(),                   // derived: archivedAt !== null
```
> `isArchived` is **derived** in the handler (`isArchived: row.archivedAt !== null`), not stored. Adding these as **required** fields is a contract change to `ProjectSummary` — update the shared schema and any 2.1 web/test code that constructs `ProjectSummary` objects, or those tests break. Default-archived items in the active list always have `archivedAt: null, isArchived: false`.

**Example — `GET /api/v1/projects?includeArchived=true`:**
```json
{
  "data": {
    "items": [
      { "id": "…010", "name": "Payments API", "slug": "payments-api", "description": null, "role": "owner", "credentialCount": 0, "expiringCount": 0, "alertCount": 0, "createdAt": "2026-06-27T20:00:00.000Z", "archivedAt": null, "isArchived": false },
      { "id": "…011", "name": "Legacy Billing", "slug": "legacy-billing", "description": "Decommissioned 2026-Q2", "role": "owner", "credentialCount": 0, "expiringCount": 0, "alertCount": 0, "createdAt": "2026-05-01T09:00:00.000Z", "archivedAt": "2026-06-28T15:42:00.000Z", "isArchived": true }
    ],
    "total": 2
  }
}
```

---

### AC-4: Dependency Guards — Active Rotations (real) + Machine Users (stub)

**Given** archiving a project must not orphan in-flight work,
**When** the archive handler runs its guards,
**Then** implement two guard functions in `apps/api/src/modules/projects/archive-guards.ts`:

**Guard 1 — Active rotations (REAL; blocks):**

```typescript
import { sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'

/**
 * Returns the ids of rotations that block archival for a project.
 * Blocking statuses: 'in_progress' (active workflow) and 'stale_recovery' (unresolved; would be orphaned).
 * 'break_glass_overlap' does NOT block — it is a self-expiring drain window past the human-action point (ADR-4.4-03).
 *
 * Cross-epic seam (ADR-4.4-02): the `rotations` table is created in Epic 5 (Story 5.1).
 * If it does not yet exist (4.4 built before 5.1), this returns [] (no block) and QA must hold
 * FR63 sign-off until Epic 5 is delivered.
 */
export async function findBlockingRotationIds(tx: Tx, projectId: string): Promise<string[]> {
  const tableExists = await rotationsTableExists(tx)
  if (!tableExists) return []   // Epic 5 not yet delivered — documented degradation (ADR-4.4-02)

  const rows = await tx.execute(sql`
    SELECT id FROM rotations
    WHERE project_id = ${projectId}
      AND status IN ('in_progress', 'stale_recovery')
  `)
  return (rows as Array<{ id: string }>).map((r) => r.id)
}

async function rotationsTableExists(tx: Tx): Promise<boolean> {
  const res = await tx.execute(sql`SELECT to_regclass('public.rotations') AS reg`)
  return (res as Array<{ reg: string | null }>)[0]?.reg !== null
}
```
> When Story 5.1 is confirmed done, replace the raw SQL with a typed Drizzle query against the `rotations` schema object and **delete** `rotationsTableExists` + the seam. Track this as a follow-up in `deferred-work.md`.

**Guard 2 — Machine-user API keys (STUB; never blocks until Epic 7):**

```typescript
/**
 * Returns whether the project has active machine-user API keys that would block archival.
 * STUBBED until Epic 7 delivers GET /api/v1/projects/:projectId/machine-users/active-keys.
 */
// TODO: Epic 7 — check for active machine user API key access
export async function hasActiveMachineUserKeys(_tx: Tx, _projectId: string): Promise<false> {
  return false
}
```
> This comment text is mandated by the epic (epics.md line 1529): `// TODO: Epic 7 — check for active machine user API key access`. Keep it verbatim so a repo-wide `rg "TODO: Epic 7"` finds it when Epic 7 lands.

**Block response shape (MUST match Story 4.3 exactly — epics.md line 1501):**
```json
HTTP 409
{ "error": "active_rotations", "rotationIds": ["…", "…"] }
```
> **Naming note:** this one uses `error` (not `code`) and `rotationIds` to stay byte-compatible with the Story 4.3 deactivation block, so a client can handle both with one branch. This is a deliberate, recorded divergence from the `{ code, message }` envelope used elsewhere in this story (ADR-4.4-04). Do not "normalize" it to `code`.

---

### AC-5: Write Guard — Archived Projects Are Read-Only (410 Gone)

**Given** an archived project must not receive new credentials, members, invitations, or metadata edits (epics.md line 1535),
**When** any mutating route operates on an archived project,
**Then** the request returns:
```json
HTTP 410
{ "code": "project_archived", "message": "This project is archived and cannot be modified. Unarchive it first." }
```

**Implementation — shared guard helper** (`apps/api/src/modules/projects/archive-guards.ts`):
```typescript
import { eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { projects } from '@project-vault/db/schema'

/** Returns true if the project is archived (caller should reject the mutation with 410). */
export async function isProjectArchived(tx: Tx, projectId: string): Promise<boolean> {
  const [row] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return row?.archivedAt != null
}
```

**Routes that MUST call this guard before mutating (reject with 410 if archived):**

| Route | Owner story | 4.4 action |
|---|---|---|
| `POST /api/v1/projects/:projectId/credentials` (create credential) | 2.2 | Insert guard at top of handler. |
| `PATCH /api/v1/projects/:projectId` (update metadata) | 2.1 | Insert guard. |
| `POST /api/v1/projects/:projectId/invitations` (invite) | 4.1 | Insert guard. |
| `POST /api/v1/projects/:projectId/members` (add member) | 4.2 | Insert guard. |
| `POST /api/v1/projects/:projectId/transfer-ownership` | 4.2 | Insert guard. |

**Routes that MUST NOT be guarded (reads + the archival lifecycle itself stay allowed):**
- `GET /api/v1/projects`, `GET /api/v1/projects/:projectId/dashboard`, any `GET` credential/metadata reads — archived projects remain fully **readable** (non-destructive preservation is the whole point).
- `POST /api/v1/projects/:projectId/unarchive` — obviously must work on an archived project.

**Coordination rule (because owner routes span multiple stories):**
- If a target route's owning story is **already done**, 4.4 inserts the `isProjectArchived` guard into that handler **in this story's PR** and adds a test.
- If the owning story is **not yet done** (e.g., 2.2/4.1/4.2 still pending), 4.4 ships the `isProjectArchived` helper + tests, and adds a one-line entry per pending route to `_bmad-output/implementation-artifacts/deferred-work.md` so those stories wire the guard in. The guard helper and its unit test are unconditionally part of 4.4.

> **Why 410 (Gone) and not 403/409?** 410 communicates "the resource exists but is in a state where this operation is permanently unavailable until the state changes" — semantically precise for "archived". 403 implies a permissions problem (it isn't), 409 implies a transient conflict (archival is a deliberate state). See ADR-4.4-01.

---

### AC-6: POST /api/v1/projects/:projectId/unarchive — Restore Project

**Given** a project **owner** wants to restore an archived project (epics.md line 1537 — "owner only"),
**When** they call `POST /api/v1/projects/:projectId/unarchive`,
**Then** clear `archived_at` and return the restored project.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000011/unarchive
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000011",
    "name": "Legacy Billing",
    "slug": "legacy-billing",
    "archivedAt": null,
    "isArchived": false
  }
}
```

**Handler flow:**
1. Validate `projectId` (`z.uuid()`) → 422 on malformed.
2. Load project in `tx`; zero rows → `404 { code: "project_not_found" }` (cross-org also 404).
3. Ownership check identical to AC-2 (project-owner or org-owner) → 403 otherwise.
4. If `project.archivedAt IS NULL` (already active) → `409 { code: "not_archived", message: "Project is not archived" }`.
5. Atomic clear (race-safe with the `WHERE archived_at IS NOT NULL` predicate):
```typescript
const [restored] = await tx
  .update(projects)
  .set({ archivedAt: null, updatedAt: new Date() })
  .where(and(eq(projects.id, params.projectId), isNotNull(projects.archivedAt)))
  .returning({ id: projects.id, name: projects.name, slug: projects.slug, archivedAt: projects.archivedAt })
if (!restored) {
  return reply.status(409).send({ code: 'not_archived', message: 'Project is not archived' })
}
return { data: { ...restored, archivedAt: null, isArchived: false } }
```

**SecureRoute security** (same as AC-2 but `project.unarchived`):
```typescript
security: {
  minimumRole: 'admin',
  requireMfa: true,
  rateLimit: { max: 10, timeWindowMs: 60_000, key: 'POST /api/v1/projects/:projectId/unarchive' },
  writeAuditEvent: {
    eventType: 'project.unarchived',
    resourceType: 'project',
    resourceIdFromParams: 'projectId',
  },
}
```

> **v1 scope note:** unarchive does **not** revalidate slug uniqueness — slugs are immutable (2.1 AC-8) and archiving never freed the slug for reuse (archived rows still occupy `idx_projects_org_slug`). So a restored project's slug is guaranteed still unique. No slug re-check needed.

---

### AC-7: Route Registration, Audit Classification, and Audit-Event Constants

**Given** the route-audit CI gate reads `ROUTE_FILES` and `ROUTE_ACTION_CLASSIFICATIONS`,
**When** 4.4 adds the two routes,
**Then**:

**1. Register both routes in the existing `apps/api/src/modules/projects/routes.ts`** (do not create a new module — archival lives in `modules/projects/`, matching architecture.md line 982 "CRUD + members + archive").

**2. `modules/projects/routes.ts` is already in `ROUTE_FILES`** (added by 2.1 AC-9) — no `route-audit.test.ts` `ROUTE_FILES` change needed. Confirm it is present.

**3. Add both routes to `ROUTE_ACTION_CLASSIFICATIONS` in `apps/api/src/lib/route-exemptions.ts`:**
```typescript
'POST /api/v1/projects/:projectId/archive': {
  action: 'mutation',
  auditEvent: 'project.archived',
},
'POST /api/v1/projects/:projectId/unarchive': {
  action: 'mutation',
  auditEvent: 'project.unarchived',
},
```

**4. Add the two event names to `AuditEventType` in `packages/shared/src/constants/audit-events.ts`:**
```typescript
export type AuditEventType =
  | AuthAuditEventType
  | 'user.login'
  | 'user.logout'
  | 'project.created'      // added by 2.1
  | 'project.updated'      // added by 2.1
  | 'project.archived'     // NEW (4.4)
  | 'project.unarchived'   // NEW (4.4)
  // legacy 'secret.*' members: deprecated — superseded by credential.* in Epic 2
```
> If 2.1's `project.created`/`project.updated` are not yet in the union (2.1 not merged), add them too; this story depends on 2.1 being done (Prerequisites).

**5. Run `pnpm --filter @project-vault/api test -- route-audit` in isolation** and confirm both new routes appear as classified before final PR. A typo in the classification key (e.g., `:projectid`) makes the route appear unguarded without failing the gate — verify the exact `:projectId` casing.

---

### AC-8: Zod Request/Response Schemas

**`packages/shared/src/schemas/projects.ts` (extend — these are web-consumed):**
```typescript
// Add to existing ProjectSummarySchema (AC-3): archivedAt + isArchived (both required, see AC-3 note).

// Minimal archive/unarchive response representation:
export const ProjectArchiveStateSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    archivedAt: z.iso.datetime().nullable(),
    isArchived: z.boolean(),
  })
  .meta({ id: 'ProjectArchiveState' })

export type ProjectArchiveState = z.infer<typeof ProjectArchiveStateSchema>
```

**`apps/api/src/modules/projects/schema.ts` (extend — API-only):**
```typescript
import { ProjectArchiveStateSchema } from '@project-vault/shared'

// Reuse the existing ProjectParamsSchema { projectId: z.uuid() } from 2.1.

export const ArchiveResponseSchema = z
  .object({ data: ProjectArchiveStateSchema })
  .meta({ id: 'ArchiveResponse' })

// Active-rotation 409 body (matches Story 4.3 shape — uses `error`, not `code`):
export const ActiveRotationsErrorSchema = z
  .object({ error: z.literal('active_rotations'), rotationIds: z.array(z.uuid()) })
  .meta({ id: 'ActiveRotationsError' })

export const ListProjectsQuerySchema = z
  .object({
    includeArchived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  })
  .meta({ id: 'ListProjectsQuery' })
```

**And** wire response schemas to the routes (engages the serializer + OpenAPI), same pattern as 2.1 Dev Notes "Wire response schemas":
```typescript
schema: { response: { 200: ArchiveResponseSchema, 404: ApiErrorSchema, 409: ApiErrorSchema } }
```
> Note: the 409 active-rotations body uses a different shape (`{ error, rotationIds }`) than `ApiErrorSchema` (`{ code, message }`). Either type the 409 response as a union (`z.union([ApiErrorSchema, ActiveRotationsErrorSchema])`) or omit the 409 from the typed response map and `reply.status(409).send(...)` directly. Do not force the active-rotations body into `ApiErrorSchema` — that would change the wire shape away from the 4.3-compatible contract.

---

### AC-9: RLS Cross-Org Isolation — Integration Test

**Given** RLS is always active (`withTestOrg()` / `withOrg()` from `packages/db/src/test-helpers.ts`),
**When** 4.4 tests are written,
**Then** add `packages/db/src/__tests__/projects-archival-rls.test.ts` proving:

- An org-A owner cannot archive an org-B project: the archive `UPDATE` filtered by RLS touches **0 rows** when run under org-A's context against an org-B project id → handler returns 404 (asserted at the API layer in AC-10; at the DB layer assert the update affects 0 rows).
- `archived_at` writes/reads are org-isolated: archiving a project in org A does not change row visibility for org B.
- A bare `getDb().update(projects)...` without org context affects **0 rows** (RLS denies) — never assert success on a bare query (2.1 AC-13 rule: such tests false-pass).

Use the `createTestUser`/`deleteTestUser` + nested `withTestOrg` pattern from `packages/db/src/__tests__/projects-rls-isolation.test.ts` (2.1 AC-12).

---

### AC-10: API Integration Tests

**Given** API integration tests use Fastify `inject()` against a real DB with `registerAndLoginViaApi` (`apps/api/src/__tests__/helpers/auth-test-helpers.ts`),
**When** 4.4 API tests are written,
**Then** add archival tests to `apps/api/src/modules/projects/routes.test.ts` (or a new `projects-archival.test.ts` in the module).

**Minimum required scenarios:**
```
POST /api/v1/projects/:projectId/archive
  - 200 archives a clean project (archivedAt set, isArchived: true)
  - 200 archived project disappears from default GET /api/v1/projects
  - 409 { error: "active_rotations", rotationIds } when a blocking rotation exists
        (seed a rotations row with status 'in_progress'; if the rotations table is not present
         in the test schema, skip-with-reason and assert the guard returns [] — ADR-4.4-02)
  - 409 { code: "already_archived" } when archiving an already-archived project (double-archive)
  - 403 { code: "insufficient_role" } when caller is a project member/viewer (not owner)
  - 404 when projectId does not exist
  - 404 when projectId belongs to another org (NOT 403 — enumeration guard)
  - 422 when projectId is not a UUID
  - 401 when unauthenticated
  - 403/precondition when MFA is required but not enrolled (requireMfa: true)

POST /api/v1/projects/:projectId/unarchive
  - 200 restores an archived project (archivedAt null, isArchived: false)
  - 200 restored project reappears in default GET /api/v1/projects
  - 409 { code: "not_archived" } when project is already active
  - 403 when caller is not the owner
  - 404 cross-org / not found

GET /api/v1/projects?includeArchived=true
  - 200 default (no param) hides archived projects
  - 200 ?includeArchived=true returns active + archived with correct archivedAt/isArchived
  - 200 ?includeArchived=false behaves like default (explicit false)

WRITE GUARD (410 project_archived)
  - 410 { code: "project_archived" } on PATCH /api/v1/projects/:projectId for an archived project
  - 410 on POST .../credentials for an archived project (if 2.2 done; else covered by helper unit test)
  - 200 GET reads still succeed against an archived project (dashboard + list)

SEALED-VAULT GUARD
  - 503 { status: "sealed" } for archive and unarchive when the vault is sealed
    (project routes are NOT allowlisted — guard runs before handler)

AUDIT-FAILURE ROLLBACK (fail-closed)
  - POST .../archive: when the project.archived audit write is forced to fail, the whole tx rolls back —
    archived_at remains NULL and the client gets 503 (audit_write_failed), not 200.
  - POST .../unarchive: symmetric — archived_at unchanged, 503, not 200.
```

**And** all tests use `withTestOrg()` (RLS always on). The cross-org 404 test registers two distinct authenticated orgs and asserts org B archiving org A's project returns **404, not 403**.

---

### AC-11: Web App — Archive / Unarchive UI

**Given** the web app project list/detail from Story 2.1,
**When** 4.4 ships,
**Then** add archive/unarchive affordances (owner-only) and an archived filter.

**Required additions to `apps/web/src/lib/api/projects.ts`:**
```typescript
export async function archiveProject(fetchFn: typeof fetch, projectId: string): Promise<ProjectArchiveState> {
  return apiFetch(fetchFn, `/api/v1/projects/${projectId}/archive`, { method: 'POST' })
}
export async function unarchiveProject(fetchFn: typeof fetch, projectId: string): Promise<ProjectArchiveState> {
  return apiFetch(fetchFn, `/api/v1/projects/${projectId}/unarchive`, { method: 'POST' })
}
// Extend listProjects to accept { includeArchived?: boolean } and append ?includeArchived=true when set.
```

**UI requirements:**
- An **"Archive project"** action, visible **only when the current user's `role === 'owner'`** for that project, behind a **confirmation dialog** that states archival is reversible and non-destructive ("Credentials and history are preserved; the project is hidden from active views. You can unarchive it later.").
- On `409 active_rotations`, surface a clear message listing that active rotations block archival ("This project has N in-progress rotation(s). Complete or abandon them before archiving.") — read `rotationIds.length`.
- A **"Show archived"** toggle on the project list that re-fetches with `includeArchived=true`; archived projects render with a visible "Archived" badge and an **"Unarchive"** action (owner-only) instead of normal project actions.
- Archived projects in the list are visually de-emphasized (e.g., muted styling) and **not selectable as the active dashboard project** unless unarchived.
- Mobile-friendly per 2.1 invariants (no horizontal scroll at 320/375/390px; touch-friendly confirm dialog).

**And** add `apps/web/src/lib/api/projects.test.ts` cases:
```
- archiveProject posts to the archive URL and returns archive state
- unarchiveProject posts to the unarchive URL and returns archive state
- listProjects({ includeArchived: true }) appends the query param
- archiveProject surfaces 409 active_rotations as a catchable ApiClientError carrying rotationIds
- archiveProject surfaces 410 project_archived distinctly from 409
```

---

### AC-12: Security Hardening

| Threat | Required mitigation |
|---|---|
| Cross-org archive/unarchive | RLS isolates `projects`; handler returns **404** for both "not found" and "wrong org" (no enumeration). The atomic `UPDATE ... WHERE id AND archived_at IS [NOT] NULL` under RLS touches 0 rows cross-org → 404. |
| Non-owner archiving a project | SecureRoute `minimumRole: 'admin'` floor + in-handler `project_memberships.role = 'owner'` (or org-owner) check → 403. |
| Concurrent double-archive race | Archive `UPDATE` predicate includes `archived_at IS NULL`; the losing concurrent request gets 0 rows → 409, never a double event. Symmetric for unarchive (`IS NOT NULL`). |
| Orphaning in-flight rotations | Active-rotation guard blocks archival on `in_progress`/`stale_recovery` rotations (409). |
| Silent data loss | Archival is `UPDATE archived_at`, never `DELETE`. No credential/version/rotation/audit row is removed. Asserted by AC-10 ("GET reads still succeed against archived project"). |
| Mutations against archived project | `isProjectArchived` guard returns **410** on credential create, metadata edit, invites, members, ownership transfer. |
| MFA bypass on lifecycle action | `requireMfa: true` on both routes. |
| Audit gap | `project.archived`/`project.unarchived` written in the **same tx**; audit failure → rollback + 503, never a silent un-audited archive. Asserted by AC-10 audit-failure tests. |
| Sealed/uninitialized vault | Global `vault-guard` returns `503 { status: "sealed" }`; project routes are not allowlisted → fail-closed. |
| Unbounded archive churn | Rate limit `{ max: 10, timeWindowMs: 60_000 }` per route. |
| Machine-user dependency not yet enforced | Documented stub (Epic 7). QA must not sign off FR63 complete until Epic 7 closes it (epics.md lines 1417, 1529). |

---

### AC-13: Explicit Out of Scope

Do **not** implement in 4.4:
- A hard project **delete** endpoint — archival is non-destructive and there is no delete in v1.
- The **real** machine-user active-keys check — stubbed (Epic 7, Story 7.1).
- **Dependency transfer on archive** ("archiving … require explicit confirmation with dependency transfer", epics.md line 62) — v1 blocks on active rotations rather than offering transfer-on-archive. Org-level shared credentials and transfer-on-archive are a v2 target. Record as deferred.
- **Cascading archival** of credentials/services within the project (no per-credential archived flag flips — those rows are simply hidden because their parent project is hidden from active views).
- **Auto-archival** / retention-based archival (no scheduled job).
- A new **`archived_at` column or table** — it already exists (2.1).
- Changing **pagination** of `GET /api/v1/projects` (2.1 ADR-2.1-06 exception stands).
- Wiring the 410 guard into routes whose **owning story is not yet done** — ship the helper + tests and defer the wiring to those stories (AC-5 coordination rule).

---

### AC-14: Tasks / Subtasks

> Follow repo TDD red-green (`AGENTS.md`): write or update failing tests first, confirm they fail for the expected reason, implement the smallest change, then rerun focused + relevant broader checks.

- [ ] **Task 1: Confirm schema reuse** (AC: 1)
  - [ ] Verify `projects.archived_at` exists (`rg archivedAt packages/db/src/schema/projects.ts`); do NOT re-add it.
  - [ ] (Optional) Add `idx_projects_org_active` partial index + migration at the next free journal number; run `check-rls` + `migrate`.
- [ ] **Task 2: Dependency + archive guards** (AC: 4, 5)
  - [ ] Create `apps/api/src/modules/projects/archive-guards.ts` with `findBlockingRotationIds` (+ `rotationsTableExists` seam), `hasActiveMachineUserKeys` stub (verbatim TODO comment), and `isProjectArchived`.
  - [ ] Unit test each guard: blocking rotation ids; stale_recovery blocks; break_glass_overlap does NOT block; rotations-table-absent returns []; machine stub returns false; isProjectArchived true/false.
- [ ] **Task 3: POST /:projectId/archive** (AC: 2, 4, 7, 8)
  - [ ] Failing integration tests (clean archive, 409 active rotations, 409 double-archive, 403 non-owner, 404 cross-org, 422 bad UUID).
  - [ ] Implement handler with ownership check, guards, atomic `UPDATE ... WHERE archived_at IS NULL` + `.returning()`.
- [ ] **Task 4: POST /:projectId/unarchive** (AC: 6, 7, 8)
  - [ ] Failing tests (restore, 409 not_archived, 403 non-owner, 404).
  - [ ] Implement atomic `UPDATE ... WHERE archived_at IS NOT NULL`.
- [ ] **Task 5: GET /api/v1/projects ?includeArchived** (AC: 3, 8)
  - [ ] Failing tests (default hides, true shows, explicit false hides, archivedAt/isArchived fields).
  - [ ] Extend list query + `ProjectSummarySchema`; update any 2.1 web/test constructors of `ProjectSummary`.
- [ ] **Task 6: Write guard wiring** (AC: 5)
  - [ ] Insert `isProjectArchived` 410 guard into `PATCH /api/v1/projects/:projectId` (2.1, done) and any other owner routes already merged.
  - [ ] For not-yet-done owner routes (2.2/4.1/4.2), add entries to `deferred-work.md`.
  - [ ] Test: PATCH archived → 410; GET archived → 200.
- [ ] **Task 7: Route audit + audit-event constants** (AC: 7)
  - [ ] Add both routes to `ROUTE_ACTION_CLASSIFICATIONS`.
  - [ ] Add `project.archived` / `project.unarchived` to `AuditEventType`.
  - [ ] Run `route-audit` in isolation; confirm both classified.
- [ ] **Task 8: RLS isolation test** (AC: 9)
  - [ ] `packages/db/src/__tests__/projects-archival-rls.test.ts` (cross-org update 0 rows; bare query 0 rows).
- [ ] **Task 9: Audit-failure + sealed-vault tests** (AC: 10, 12)
  - [ ] Force `project.archived`/`project.unarchived` audit write to fail → assert rollback + 503, archived_at unchanged.
  - [ ] Assert 503 `{ status: "sealed" }` for both routes when sealed.
- [ ] **Task 10: Web app** (AC: 11)
  - [ ] `archiveProject` / `unarchiveProject` helpers; extend `listProjects` with `includeArchived`.
  - [ ] Owner-only Archive action + confirm dialog; "Show archived" toggle + Unarchive action + Archived badge; 409/410 mapping.
  - [ ] `projects.test.ts` cases; mobile responsiveness (320/375/390px).
- [ ] **Task 11: Final verification** (AC: all)
  - [ ] `pnpm --filter @project-vault/db test` (RLS isolation).
  - [ ] `pnpm --filter @project-vault/api test` (route-audit, archival integration, sealed, audit-failure).
  - [ ] `pnpm --filter @project-vault/shared test`.
  - [ ] `pnpm --filter @project-vault/web test`, `typecheck`, `lint`.
  - [ ] `pnpm typecheck` + `pnpm lint` at repo root; `pnpm --filter @project-vault/db check-rls`.
  - [ ] Add the Epic 5 (replace rotation seam) + Epic 7 (machine-user stub) + AC-5 guard-wiring follow-ups to `deferred-work.md`.

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| Routes | Extend `apps/api/src/modules/projects/routes.ts` (created in 2.1). No new module. |
| Guards | New file `apps/api/src/modules/projects/archive-guards.ts` (rotation/machine/archived guards + helpers). |
| Request schemas | Extend `apps/api/src/modules/projects/schema.ts` (reuse `ProjectParamsSchema`). |
| Shared schemas | Extend `packages/shared/src/schemas/projects.ts` (`ProjectSummary` gains `archivedAt`/`isArchived`; add `ProjectArchiveStateSchema`). |
| Web helpers | Extend `apps/web/src/lib/api/projects.ts` (created in 2.1). |
| Migration | Likely none. Only if you add the optional partial index — next free journal number, verify `meta/_journal.json`. |

### Key Code Patterns to Follow

**SecureRoute usage** (copy from `apps/api/src/modules/org/routes.ts` and 2.1's projects routes):
```typescript
secureRoute(fastify, {
  method: 'POST',
  url: '/:projectId/archive',           // prefix '/api/v1/projects' set in app.ts
  schema: { response: { 200: ArchiveResponseSchema, 404: ApiErrorSchema } },
  security: {
    minimumRole: 'admin',
    requireMfa: true,
    rateLimit: { max: 10, timeWindowMs: 60_000, key: 'POST /api/v1/projects/:projectId/archive' },
    writeAuditEvent: { eventType: 'project.archived', resourceType: 'project', resourceIdFromParams: 'projectId' },
  },
  handler: async (ctx, req, reply) => {
    const { auth, tx } = ctx as SecureRouteContext
    // validate params → load project → idempotency/ownership → guards → atomic update → return data
  },
})
```

**Return data, do not `reply.send` on audited routes.** SecureRoute installs an audit-send guard on audited handlers (see `withAuditSendGuard` in `secure-route.ts`): an audited handler must **return** the response object so the audit write runs in the same tx *after* the handler. Use `reply.status(404).send(...)` etc. **only for early-exit error paths** (those are not audited because the handler returns before the success path). For the success path, `return { data: ... }`.
> Re-read `secure-route.ts` lines 247–257 and 366–393: on the audited success path, calling `reply.send` throws `SecureRoute: audited handlers must return data instead of sending replies`. Early-return error replies (422/403/404/409) are fine because they short-circuit before the audit phase — but verify each early return is reached before the success `return`.

**Timestamp serialization:** Drizzle returns `Date`; response schemas declare `z.iso.datetime()`. Convert `archivedAt?.toISOString() ?? null` before returning (2.1 Dev Notes).

**Atomic state-flip predicate:** always include `archived_at IS NULL` (archive) / `IS NOT NULL` (unarchive) in the `WHERE` so concurrent requests cannot both win.

### Architecture Compliance

- **No bare `getDb()` in handlers** — use the SecureRoute `tx`. Guard helpers accept `tx: Tx` and use it exclusively; never call `getDb()` inside them (would escape the RLS-scoped transaction; route-audit `DIRECT_DB_ACCESS_CLASSIFICATIONS` would also flag a new `getDb` import).
- **`org_id` from JWT only** — archive/unarchive take no body and resolve org from `auth.orgId`; RLS does the isolation.
- **404 not 403 for cross-org** — preserve enumeration resistance (2.1 ADR/AC-7).
- **RLS already covers `projects`** (2.1) — do not touch `check-rls-coverage.ts`.

### Tech Stack Versions (Repo Pinned)

| Technology | Version | Notes |
|---|---|---|
| Drizzle ORM | `^0.45.x` | `update().set().where().returning()`, `isNull`, `isNotNull`, `and`, `eq`, `sql`. |
| zod | `zod/v4` | `import { z } from 'zod/v4'`; `.meta({ id })` on exported schemas. |
| Fastify | `^5.x` | `secureRoute()` handles registration + same-tx audit. |
| Node | `>=24.0.0` | — |

### Anti-Patterns (Do Not)

- Do **not** add an `archived_at` column or a migration for it — it exists from 2.1.
- Do **not** `DELETE` anything — archival is `UPDATE archived_at` only.
- Do **not** call `reply.send(...)` on the audited **success** path — return the data object (audit-send guard throws otherwise).
- Do **not** normalize the active-rotations 409 body to `{ code, message }` — keep `{ error: "active_rotations", rotationIds }` for 4.3 compatibility (ADR-4.4-04).
- Do **not** use `z.coerce.boolean()` for `includeArchived` — `"false"` would be truthy. Use the explicit `=== 'true'` transform.
- Do **not** guard reads with 410 — only mutations. Archived projects must remain fully readable.
- Do **not** implement the real machine-user check — keep the Epic 7 stub with the verbatim TODO comment.
- Do **not** treat `break_glass_overlap` as a blocking rotation status (ADR-4.4-03).
- Do **not** return 403 for cross-org access — return 404.
- Do **not** archive without the `archived_at IS NULL` predicate — it is the race guard.
- Do **not** skip `requireMfa: true` — archival is a high-impact lifecycle action.

---

## Previous Story Intelligence

> Story 4.4 has **no implemented predecessor story file in Epic 4** (4.1–4.3 are still `backlog`/not created). The direct technical predecessor is **Story 2.1 (Project Creation)** — it owns the `projects` table, `project_memberships`, the `archived_at` column, and `GET /api/v1/projects`. Treat 2.1 as the carry-forward source.

Key carry-forward from **Story 2.1**:
- `projects.archived_at` exists and is **reserved for this story** (2.1 AC-16). The list endpoint already filters `archivedAt IS NULL`.
- The list join is `innerJoin(projectMemberships, and(eq(projectId), eq(userId, auth.userId)))` — keep both conditions when adding `?includeArchived` (omitting `userId` returns one row per member once 4.1 lands).
- `ProjectSummary`/`ProjectDetail` live in `packages/shared/src/schemas/projects.ts` (web-consumed); request schemas live in `apps/api/src/modules/projects/schema.ts`. Update the shared schema for the new fields and `pnpm install` so the web app picks them up.
- Cross-org access returns **404**, not 403 (enumeration resistance). Mutations use `.returning()` + row-count checks (a 0-row RLS-filtered update must not 200).
- SecureRoute writes audit in the same tx; audit failure → rollback + 503. Sealed vault → 503 for non-allowlisted routes.
- Web API helpers pattern: `apps/web/src/lib/api/projects.ts` with `apiFetch`.

Carry-forward from **Story 4.3** (when implemented): reuse the exact `409 { error: "active_rotations", rotationIds }` block shape and any shared "find active rotations" helper.

---

## Git Intelligence Summary

Recent branch context:
- The current branch is a Dependabot pnpm-workspace bump; the substantive foundations are the merged Epic 1 stories (SecureRoute, RLS middleware, route-audit gate, vault-guard) which this story builds on directly.
- The `projects` module and `archived_at` column arrive with Story 2.1 (`ready-for-dev`) — confirm 2.1 (and 4.1) are merged before starting.

Pattern observations (Epic 1 reality):
- Route modules export `async function xRoutes(fastify: FastifyApp): Promise<void>`.
- DB tests co-located under `__tests__/`; API tests `.test.ts` co-located in module dirs.
- Audit events for the `project.*` family use lowercase-dotted names (2.1), not the architecture registry's `UPPER_SNAKE`.

---

## Pre-mortem Failure Modes

| Failure mode | Why it would happen | Prevention |
|---|---|---|
| **Active-rotation guard is a no-op forever** | The Epic 5 seam returns `[]` and is never replaced after 5.1 ships | ADR-4.4-02 + AC-4 require a `deferred-work.md` entry; QA holds FR63 sign-off until Epic 5 live; `rg "rotationsTableExists"` finds the seam. |
| **Machine-user stub silently accepted as complete** | Stub returns false; reviewer forgets Epic 7 | Verbatim `// TODO: Epic 7` comment (epics.md line 1529) + QA hold (epics.md line 1417). |
| **`reply.send` on audited success path throws** | Developer sends instead of returning on the success branch | Dev Notes "Return data, do not reply.send"; audit-send guard throws a clear message; AC-10 success tests catch it. |
| **Double-archive creates two `project.archived` events** | No race predicate on the update | AC-2 mandates `WHERE archived_at IS NULL`; loser gets 0 rows → 409. |
| **Archived project still mutable** | 410 guard not wired into a mutating route (esp. cross-story routes) | AC-5 enumerates every route; coordination rule + `deferred-work.md` for pending stories; tests assert 410. |
| **Cross-org archive returns 403 (enumeration)** | Explicit ownership check returns Forbidden for wrong-org | RLS update touches 0 rows cross-org → 404; AC-9/AC-10 assert 404 not 403. |
| **`includeArchived=false` shows archived** | `z.coerce.boolean()` treats `"false"` as truthy | AC-3 mandates explicit `=== 'true'` transform; AC-10 tests explicit-false. |
| **`ProjectSummary` consumers break** | New required `archivedAt`/`isArchived` fields added without updating 2.1 web/test constructors | AC-3 note + Task 5 require updating all `ProjectSummary` constructors. |
| **Audit write skipped → silent archive** | Audit failure swallowed | SecureRoute same-tx coupling; AC-10 audit-failure rollback test asserts archived_at unchanged + 503. |
| **route-audit passes but route unguarded** | Typo in classification key casing (`:projectid`) | AC-7 step 5: run route-audit in isolation; verify exact `:projectId`. |
| **Stale-recovery rotation orphaned by archive** | Guard only checks `in_progress` | AC-4: block on `in_progress` AND `stale_recovery`. |
| **Break-glass overlap blocks archival wrongly** | Guard over-blocks on all rotation statuses | ADR-4.4-03: `break_glass_overlap` excluded from blocking set. |
| **Non-owner archives a project** | Only org-role floor enforced, no project-owner check | AC-2 in-handler `project_memberships.role = 'owner'` (or org-owner) check → 403. |
| **Unarchive frees/collides slug** | Assumed slug freed on archive | AC-6 note: archived rows still occupy the unique slug index; no re-check needed. |

---

## ADRs

### ADR-4.4-01: Mutations against an archived project return `410 Gone` (not 403/409)

| | |
|---|---|
| **Context** | Archived projects must reject new credentials/members/invitations/edits (epics.md line 1535). The status code communicates intent to clients. |
| **Options** | **A** 403 Forbidden — implies permissions. **B** 409 Conflict — implies a transient/optimistic conflict. **C** 410 Gone — resource exists but the operation is unavailable in its current (archived) state. |
| **Decision** | **C — 410 `{ code: "project_archived" }`.** |
| **Rationale** | The caller may have full permission and there is no concurrency conflict; the project is deliberately in a state where writes are disallowed until unarchived. 410 maps most precisely; the message tells the client to unarchive first. |
| **Consequences** | Clients branch on 410 → "archived" UX (offer Unarchive to owners). Distinct from the 409 used for active-rotation/double-archive races. |

### ADR-4.4-02: Active-rotation guard tolerates the `rotations` table not existing yet (Epic 5 seam)

| | |
|---|---|
| **Context** | 4.4 (Epic 4) checks the `rotations` table created in Epic 5 (Story 5.1). Strict epic order would build 4.4 first. |
| **Options** | **A** Hard-require Story 5.1 (4.4 fails to build/run without `rotations`). **B** Table-existence seam: real check when present, "no block" when absent, with a QA hold + tracked follow-up. |
| **Decision** | **B**, with a strong recommendation to deliver 4.4 after 5.1. |
| **Rationale** | Mirrors the epic-sanctioned machine-user stub pattern (Epic 7). Keeps 4.4 implementable under either sequencing while making the gap explicit and auditable (`to_regclass` check + `deferred-work.md` + QA hold). Avoids a hard build coupling that would block the Tier-1 team-beta epic on a Tier-2 epic. |
| **Consequences** | If 4.4 ships before 5.1, projects with (not-yet-existent) rotations can be archived — acceptable because no rotations can exist before 5.1. The seam MUST be replaced with a typed query and removed once 5.1 is done; FR63 is not "complete" until then (and until Epic 7). |

### ADR-4.4-03: Blocking rotation statuses are `in_progress` + `stale_recovery`; `break_glass_overlap` does not block

| | |
|---|---|
| **Context** | Epic 5 defines rotation statuses `in_progress`, `stale_recovery`, `break_glass_overlap`, `completed`, `abandoned`. The 4.4 epic AC names only `in_progress`. |
| **Decision** | Block archival on `in_progress` and `stale_recovery`; do not block on `break_glass_overlap` (or terminal `completed`/`abandoned`). |
| **Rationale** | `in_progress` and `stale_recovery` represent unresolved human work that archival would orphan. `break_glass_overlap` is a self-expiring drain window after a completed emergency rotation (a pg-boss job retires the old version automatically, epics.md line 1634) — the human action is already done; blocking on it would needlessly prevent archiving a project whose emergency is resolved. |
| **Consequences** | The guard's status set is `('in_progress','stale_recovery')`. If Epic 5 renames/adds statuses, revisit the set (tracked in `deferred-work.md`). |

### ADR-4.4-04: Active-rotation 409 body uses `{ error, rotationIds }` (not the `{ code, message }` envelope)

| | |
|---|---|
| **Context** | Most 4.4 errors use `{ code, message }`. The epic specifies the rotation block as `409 { error: "active_rotations", rotationIds: [...] }` (epics.md line 1527), identical to Story 4.3 deactivation (line 1501). |
| **Decision** | Keep `{ error: "active_rotations", rotationIds }` verbatim for this one response. |
| **Rationale** | Byte-compatibility with the 4.3 deactivation block lets clients handle "blocked by active rotations" with a single code path across both archival and deactivation. Consistency of the *cross-cutting* contract beats local envelope uniformity. |
| **Consequences** | The 409 response schema is a distinct type (`ActiveRotationsErrorSchema`), not `ApiErrorSchema`. The typed response map for the route must union them or omit the 409. Documented so a reviewer does not "fix" it to `code`. |

---

## References

- Story source: `_bmad-output/planning-artifacts/epics.md#Story-4.4-Project-Archival` (lines 1515–1539)
- Epic 4 constraints + FR63 stub notes: `_bmad-output/planning-artifacts/epics.md#Epic-4` (lines 1410–1421, 1529)
- FR63 (archive projects, preserve all data): `_bmad-output/planning-artifacts/epics.md` line 32; PRD FR63
- v1 archival dependency-check decision: `_bmad-output/planning-artifacts/epics.md` line 62
- Active-rotation 409 shape precedent (Story 4.3 deactivation): `_bmad-output/planning-artifacts/epics.md` line 1501
- Rotation statuses + `rotations` table: `_bmad-output/planning-artifacts/epics.md` Stories 5.1 (line 1572), 5.3 (lines 1632–1642); architecture.md lines 520, 549–553
- Machine-user stub closure (Epic 7): `_bmad-output/planning-artifacts/epics.md` line 1821
- Predecessor `projects` schema + list endpoint + reserved `archived_at`: `_bmad-output/implementation-artifacts/2-1-project-creation-and-cross-project-dashboard.md` (AC-1, AC-6, AC-16; ADR-2.1-04 audit FK)
- SecureRoute framework + same-tx audit + audit-send guard: `apps/api/src/lib/secure-route.ts`
- Route-audit registries: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`
- Audit-event constants: `packages/shared/src/constants/audit-events.ts`
- Org route in-handler audit precedent (`writeAuditEvent: false` + service writes own audit): `apps/api/src/modules/org/routes.ts`
- RLS coverage check + test helpers: `packages/db/src/check-rls-coverage.ts`, `packages/db/src/test-helpers.ts`, `packages/db/src/__tests__/projects-rls-isolation.test.ts`
- Backend module layout ("CRUD + members + archive"): `_bmad-output/planning-artifacts/architecture.md` line 982
- Naming conventions (tables, audit registry, API nouns): `_bmad-output/planning-artifacts/architecture.md` lines 505–575
- Repo TDD rule: `AGENTS.md`

---

## Dev Agent Record

### Agent Model Used

_(to be filled by dev agent)_

### Debug Log References

### Completion Notes List

### File List
