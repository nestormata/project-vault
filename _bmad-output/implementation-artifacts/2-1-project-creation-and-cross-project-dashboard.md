# Story 2.1: Project Creation & Cross-Project Dashboard

Status: review

<!-- Ultimate context engine analysis completed 2026-06-27 - comprehensive developer guide for the first durable backend and frontend project model. This story introduces the projects table, project_memberships, RLS policies, four new API routes, and the real ProjectDashboard schema replacing the Story 2.0 preview stub. -->

## Story

As a user who wants to organize my operational assets,
I want to create projects with names and descriptions and view all my projects on a unified dashboard,
so that I can group secrets, services, and certificates by team or domain and get a single-glance status overview.

*Covers: FR1, FR7, FR8, FR93, FR98.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.1-Project-Creation--Cross-Project-Dashboard`]

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Migration numbering **(verify, do NOT hardcode)** | ⚠️ On the current branch the highest migration is **`0012_refresh_tokens_org_id.sql`** (`packages/db/src/migrations/meta/_journal.json` last entry, idx 12) — Story 2.1 therefore lands as **`0013_projects.sql`**, NOT 0011. The `0011` references elsewhere in this doc are illustrative placeholders — before generating, re-check `packages/db/src/migrations/` and `meta/_journal.json` and use the next free number. Run `pnpm --filter @project-vault/db migrate` before implementing. |
| Story 2.0 is complete OR its `ProjectDashboardPreviewSchema` is available in `packages/shared` | Story 2.1 replaces the `z.never()` stub arrays in that schema with real item schemas. The web app must be updated in the same PR so the dashboard page compiles. |
| `apps/api/src/lib/route-exemptions.ts` `ROUTE_ACTION_CLASSIFICATIONS` exists | Story 2.1 adds four new route entries to that map; the route-audit.test.ts CI gate enforces this. |
| Story 1.11 `SecureRoute` framework is merged and passing CI | All four new project routes must use `secureRoute()`. |

---

## Epic Cross-Story Context

| Story | Relationship to 2.1 |
|---|---|
| 1.4 | Established Drizzle schema patterns (`orgScoped()`, snake_case tables, `withTestOrg()` for RLS-active tests). 2.1 follows the exact same schema and migration conventions. |
| 1.11 | Provides `secureRoute()`, `SecureRouteContext`, RLS middleware (`setRlsOrgContext`), audit writer, and the `route-audit.test.ts` CI gate. All four 2.1 routes go through this framework. |
| 2.0 | Defined `ProjectDashboardPreviewSchema` in `packages/shared/src/schemas/dashboard.ts` with `z.never()` stub arrays. 2.1 must replace `upcomingRotations` and `recentAccessEvents` with real (but still empty-at-launch) schemas, keeping `isEmpty` and `suggestedActions` for the web app. |
| 2.2 | Adds `credential_versions` and `credentials` tables. `credentialStats` in the dashboard counts rows from those tables by `projectId`. For 2.1, all counts are `0` because no credentials exist yet — the dashboard query returns zeros, not errors. |
| 4.1 | Will add project-specific membership roles. For 2.1, project access uses the calling user's org membership role (`orgRole` on `AuthContext`). The `project_memberships` table records the creator as `owner`; actual per-project RBAC enforcement is deferred to 4.1. |
| 8.x | Audit log FK to `projects(id)` was intentionally deferred (see comment in `packages/db/src/schema/audit-log-entries.ts`). Story 2.1 MUST add that FK in this story's projects migration (next free number, e.g. `0013_projects.sql`) as instructed by the inline defer note. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 2.1 | Rationale |
|---|---|---|
| Architecture lists `modules/projects/` and `modules/dashboard/` as separate modules | For 2.1, implement a single `modules/projects/` module with routes for both project CRUD and the per-project dashboard. A separate `modules/dashboard/` is warranted only when the dashboard logic grows significantly (Epic 3+). | Premature separation creates more import surface without benefit at this scale. |
| Architecture shows `projectRole` in the `AuthContext` | For 2.1, `projectRole` is not yet on `AuthContext` — it was scoped to future RBAC work. Use `orgRole` for access decisions. The `project_memberships` table records the creator's role but is not enforced by `SecureRoute` in this story. | Project-scoped RBAC in `AuthContext` is the Story 4.1 architectural step. |
| Epic says integration tests cover cross-org isolation | Use the existing `withTestOrg()` from `packages/db/src/test-helpers.ts` — it creates a real org, runs RLS-active queries, and cleans up. Never disable RLS in tests. | RLS is always active per architectural invariant. |
| Dashboard returns `isEmpty: true` with `suggestedActions` | For 2.1, a project with no credentials/services always returns `isEmpty: true`. The suggestedActions list is server-derived, not stored. | `isEmpty` is computed at query time; it is not a column. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Database schema | `projects` and `project_memberships` tables created with org-scoped RLS in the same migration file. FK from `audit_log_entries.project_id` to `projects.id` added. |
| Shared schema | `ProjectDashboardPreviewSchema` in `packages/shared` promoted to real `ProjectDashboardSchema`; `z.never()` arrays replaced with real (empty-for-now) schemas. |
| POST /api/v1/projects | Creates project, records creator as owner in `project_memberships`, returns full project object. |
| GET /api/v1/projects | Returns all projects in the user's org with summary counts. |
| GET /api/v1/projects/:projectId/dashboard | Returns dashboard payload with counts, isEmpty flag, suggestedActions. |
| PATCH /api/v1/projects/:projectId | Updates name/description; slug is immutable. |
| RLS isolation | Cross-org project leak is impossible at the database level. |
| Route audit | All four routes appear in `ROUTE_ACTION_CLASSIFICATIONS`; `route-audit.test.ts` passes. |
| Integration tests | Create, dashboard empty state, slug duplicate, cross-org isolation. |
| Web app | Dashboard page compiles against the real schema; preview stub replaced. |

---

### AC-1: Database Schema — `projects` Table

**Given** the codebase follows Drizzle schema conventions established in `packages/db/src/schema/`,
**When** Story 2.1 adds the `projects` table,
**Then** create `packages/db/src/schema/projects.ts` exactly as follows:

```typescript
import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    // Nullable: projects survive user deletion (Story 4.3 deactivation).
    // SET NULL on user delete is intentional — the project belongs to the org, not the user.
    // NOT NULL would contradict onDelete: 'set null' and break user deletion at the DB level.
    createdBy: uuid('created_by')
      .references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    orgSlugUnique: uniqueIndex('idx_projects_org_slug').on(t.orgId, t.slug),
    orgCreatedIdx: index('idx_projects_org_created').on(t.orgId, t.createdAt.desc()),
  })
)
```

**And** the slug is NOT unique globally — only unique within an org. The `uniqueIndex` on `(orgId, slug)` enforces this at the database level.

**And** `name` is intentionally NOT unique — two projects in the same org may share a display name (e.g., "API") as long as their slugs differ. `name` is a human-facing label; `slug` is the stable identity. Do not add a unique constraint on `name`.

**And** `orgScoped({ onDelete: 'cascade' })` means deleting an organization cascades to all its projects. This is intentional — projects have no value without their org.

**And** `createdBy` uses `onDelete: 'set null'` — deleting a user does not cascade to delete their projects (the org still owns the projects).

**And** export `projects` from `packages/db/src/schema/index.ts` by adding:
```typescript
export * from './projects.js'
export * from './project-memberships.js'
```

---

### AC-2: Database Schema — `project_memberships` Table

**Given** projects need to record which user has which role,
**When** Story 2.1 adds the `project_memberships` table,
**Then** create `packages/db/src/schema/project-memberships.ts`:

```typescript
import { pgTable, uuid, text, timestamp, primaryKey, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'
import { projects } from './projects.js'

export const projectMemberships = pgTable(
  'project_memberships',
  {
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.userId] }),
    roleCheck: check(
      'project_memberships_role_check',
      sql`${t.role} IN ('owner','admin','member','viewer')`
    ),
  })
)
```

**And** the primary key is `(projectId, userId)` — one membership record per user per project.

**And** `orgId` is present via `orgScoped()` so the RLS policy can enforce cross-org isolation on membership queries too.

---

### AC-3: Migration (next free number, e.g. `0013_projects.sql`) — Schema, RLS Policies, FK, and `updated_at` Trigger

> **Migration number is dynamic.** Use the next free number after the current journal tip (`0012_refresh_tokens_org_id` → `0013_projects.sql` on today's branch). Confirm against `packages/db/src/migrations/meta/_journal.json` immediately before running `drizzle-kit generate`. Every `0011`/`0011_projects.sql` mention below is an illustrative placeholder — substitute the real number.

**Given** the RLS coverage check (`packages/db/src/check-rls-coverage.ts`) fails CI if any `org_id` table lacks an `ALL` policy,
**When** Story 2.1 creates the migration,
**Then** create `packages/db/src/migrations/<next>_projects.sql` (e.g. `0013_projects.sql`) that:

1. Creates both tables (let Drizzle generate the `CREATE TABLE` statements via `drizzle-kit generate`).
2. Enables RLS and creates isolation policies for **both** new tables in the **same migration file**.
3. Adds the FK from `audit_log_entries.project_id` to `projects.id` (as instructed by the inline defer comment in `packages/db/src/schema/audit-log-entries.ts`).
4. Creates the `updated_at` auto-update trigger for `projects`.

Example RLS policy block (must appear inside the migration file):

```sql
-- Enable RLS on new org-scoped tables
ALTER TABLE projects            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Isolation policies (same pattern as org_memberships in 0001_rls_and_triggers.sql)
CREATE POLICY projects_isolation
  ON projects
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY project_memberships_isolation
  ON project_memberships
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
--> statement-breakpoint

-- FK deferred from audit-log-entries.ts (Story 2.1 instruction)
-- CRITICAL: Clear any orphaned project_id values FIRST.
-- Before this story, project_id accepted any UUID without referential validation.
-- Integration tests or manual testing may have written non-null project_id values that
-- do not correspond to any real project row. Adding the FK without this cleanup causes:
--   ERROR: insert or update on table "audit_log_entries" violates foreign key constraint
-- This UPDATE is safe: it only nullifies values that would otherwise block the constraint.
UPDATE audit_log_entries SET project_id = NULL WHERE project_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE audit_log_entries
  ADD CONSTRAINT fk_audit_project
  FOREIGN KEY (project_id) REFERENCES projects(id)
  ON DELETE SET NULL;
--> statement-breakpoint

-- updated_at trigger for projects (same pattern as 0001 for other mutable tables)
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**And** after adding the migration, run `pnpm --filter @project-vault/db check-rls` (the `db#check-rls` Turborepo task) to confirm no gap is reported.

**And** verify the generated migration SQL order before committing: `CREATE TABLE projects` MUST appear before `CREATE TABLE project_memberships` because the memberships table has a FK to `projects.id`. Drizzle normally resolves this, but confirm visually — if the order is reversed the migration fails with "relation does not exist".

**Critical:** Do NOT add `projects` or `project_memberships` to the `EXCLUDED_TABLES` set in `packages/db/src/check-rls-coverage.ts`. These tables ARE org-scoped and MUST have RLS. Adding them to the exclusion list would be a security regression.

---

### AC-4: POST /api/v1/projects — Create Project

**Given** an authenticated user calls `POST /api/v1/projects`,
**When** the request body is valid,
**Then** create the project and record the creator in `project_memberships`:

**Request:**
```http
POST /api/v1/projects
Content-Type: application/json
Cookie: access-token=<jwt>

{
  "name": "Payments API",
  "slug": "payments-api",
  "description": "All credentials and services for the payments domain."
}
```

**Successful response (`201 Created`):**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000010",
    "orgId": "00000000-0000-4000-8000-000000000002",
    "name": "Payments API",
    "slug": "payments-api",
    "description": "All credentials and services for the payments domain.",
    "role": "owner",
    "createdBy": "00000000-0000-4000-8000-000000000001",
    "createdAt": "2026-06-27T20:00:00.000Z",
    "updatedAt": "2026-06-27T20:00:00.000Z",
    "archivedAt": null
  }
}
```

**And** within the same database transaction, and using `.returning()` to get the created row (never reconstruct the response from request values — the DB is the source of truth for generated fields like `id`, `createdAt`, `updatedAt`):

```typescript
const [project] = await tx
  .insert(projects)
  .values({ orgId: auth.orgId, name: body.name, slug: body.slug, description: body.description ?? null, createdBy: auth.userId })
  .returning()

await tx.insert(projectMemberships).values({
  orgId: auth.orgId, projectId: project.id, userId: auth.userId, role: 'owner',
})

// CRITICAL: `role` lives in project_memberships, NOT projects — .returning() does not include it.
// Assemble it into the response explicitly. Also convert Drizzle Date objects to ISO strings
// (see Dev Notes "Timestamp serialization") because ProjectDetailSchema fields are z.iso.datetime().
return reply.status(201).send({
  data: {
    ...project,
    role: 'owner',
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    archivedAt: project.archivedAt?.toISOString() ?? null,
  },
})
```

1. Insert into `projects` with `orgId = auth.orgId`, `createdBy = auth.userId`.
2. Insert into `project_memberships` with `orgId = auth.orgId`, `projectId = <new id>`, `userId = auth.userId`, `role = 'owner'`.
3. Assemble the response as `{ ...project, role: 'owner' }` with ISO-string timestamps — `role` is never returned by `.returning()` on the `projects` table.

**And** `orgId` is taken from `auth.orgId` (the JWT claim), never from the request body. A client supplying `orgId` in the body must receive a `422` (the Zod schema must not include `orgId` as an input field).

**And** `description` is optional (nullable). If omitted from the request, store `null`.

**And** the response includes `role: "owner"` — this is the `project_memberships.role` for the calling user, useful for the frontend to immediately render the correct permission context.

**And** the SecureRoute security configuration for this route must capture the **new project's id** in the audit event. The default audit writer reads `resourceIdFromParams`, but for a POST the new id is not in the URL params — without handling, `project.created` would record a null resource, which is a compliance gap. Resolve it with a custom `auditWriter` that reads an id the handler stashes on the request:

```typescript
security: {
  minimumRole: 'member',   // any authenticated org member can create a project
  requireMfa: false,        // project creation is not a security-action requiring MFA
  rateLimit: { max: 20, timeWindowMs: 60_000, key: 'POST /api/v1/projects' },
  writeAuditEvent: {
    eventType: 'project.created',
    resourceType: 'project',
    payload: ({ /* params, query */ }) => ({}),  // projectId injected via custom writer below
  },
}
// Note: no per-org project count cap exists in Story 2.1 — subscription-tier limits
// are deferred to the billing/tier story. The rate limit mitigates bulk creation abuse.
```

**Audit capture pattern (required):** inside the handler, after inserting, stash the new id and slug on the request; the custom `auditWriter` reads them so the audit row records `resourceId = <new projectId>` and a `{ slug }` payload:

```typescript
// in handler, after .returning():
;(req as unknown as { auditResource?: { id: string; slug: string } }).auditResource = {
  id: project.id, slug: project.slug,
}

// auditWriter passed to secureRoute (extends defaultAuditWriter behavior):
auditWriter: async ({ tx, auth, request, config }) => {
  const stashed = (request as unknown as { auditResource?: { id: string; slug: string } }).auditResource
  await writeProjectAudit(tx, {
    orgId: auth.orgId, actorUserId: auth.userId,
    eventType: config.eventType, resourceType: 'project',
    resourceId: stashed?.id ?? null,
    payload: stashed ? { slug: stashed.slug } : {},
  })
}
```

> Alternatively, set `writeAuditEvent: false` and write the audit entry explicitly in-handler within the same `tx` (the precedent is `modules/org/routes.ts` session-revoke, which uses `writeAuditEvent: false` + a service that writes its own audit). Either approach is acceptable as long as `project.created` records the new `projectId`. Do not ship a `project.created` event with a null resource id.

---

### AC-5: Slug Validation Rules

**Given** project slugs must be unique within an org,
**When** the slug is provided in the request body,
**Then** validate with these rules:

| Rule | Constraint | Error response |
|---|---|---|
| Format | Lowercase alphanumeric + hyphens only; regex `/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$\|^[a-z0-9]{3}$/` | `422 { code: "validation_error", message: "Slug must be 3–50 lowercase alphanumeric characters and hyphens" }` |
| Length | 3 minimum, 50 maximum | Same 422 |
| No leading/trailing hyphen | `payments-` or `-payments` → invalid | Same 422 |
| Unique within org | Duplicate in same org | `409 { code: "slug_taken", message: "A project with this slug already exists in your organization" }` |

**Example valid slugs:** `payments-api`, `abc`, `frontend-prod-v2`, `a1b`

**Example invalid slugs:** `Payments-API` (uppercase), `pa` (too short), `payments api` (space), `-payments` (leading hyphen), `payments-` (trailing hyphen)

**And** the `409 slug_taken` error MUST be returned when a `UniqueConstraintViolationError` (Postgres error code `23505`) is thrown on the `idx_projects_org_slug` index. Catch the database error, inspect the constraint name, and return `409` — do not let it surface as a `500`.

**Implementation pattern for catching duplicate slug:**
```typescript
try {
  // insert project
} catch (error) {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  if (
    cause && typeof cause === 'object' &&
    (cause as { code?: string }).code === '23505' &&
    (cause as { constraint?: string }).constraint === 'idx_projects_org_slug'
  ) {
    return reply.status(409).send({ code: 'slug_taken', message: 'A project with this slug already exists in your organization' })
  }
  throw error
}
```

---

### AC-6: GET /api/v1/projects — List Projects

**Given** an authenticated user calls `GET /api/v1/projects`,
**When** the request succeeds,
**Then** return all non-archived projects the user has access to in their org.

**Request:**
```http
GET /api/v1/projects
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000010",
        "name": "Payments API",
        "slug": "payments-api",
        "description": "All credentials and services for the payments domain.",
        "role": "owner",
        "credentialCount": 0,
        "expiringCount": 0,
        "alertCount": 0,
        "createdAt": "2026-06-27T20:00:00.000Z"
      }
    ],
    "total": 1
  }
}
```

**And** the query logic:
- Join `projects` with `project_memberships` using BOTH `projectId` AND `userId` conditions. **This is critical for correctness when Story 4.1 adds multi-member projects** — omitting the `userId` condition returns one row per project member, not one row per project:

```typescript
tx.select({ ...projectFields, role: projectMemberships.role })
  .from(projects)
  .innerJoin(
    projectMemberships,
    and(
      eq(projectMemberships.projectId, projects.id),
      eq(projectMemberships.userId, auth.userId)   // ← REQUIRED: scoped to calling user
    )
  )
  .where(isNull(projects.archivedAt))
  .orderBy(desc(projects.createdAt))
```

- Filter: `projects.orgId = auth.orgId` (enforced by RLS), `projects.archivedAt IS NULL`.
- `credentialCount`, `expiringCount`, `alertCount` are all `0` in Story 2.1. These fields are placeholders for Epics 2.2+ and 3. **Do not make them nullable** — always return `0` as the type. Future stories will add real subqueries.
- Order by `projects.createdAt DESC` (most recently created first).

**And** pagination — **accepted PRD exception to FR97 (recorded, not an oversight):** FR97 ("all list endpoints support `page`/`limit` pagination", reaffirmed by the Story 2.3 epic ACs) would otherwise require the project list to paginate. Story 2.1 deliberately ships `GET /api/v1/projects` **unpaginated**, returning all org projects, per ADR-2.1-06. This is a conscious, bounded exception (orgs are expected to have tens, not thousands, of projects; the POST rate limit of 20/min bounds growth), **not** a missed requirement. The `{ items, total }` envelope is forward-compatible — adding `page`/`limit`/`hasNext` later is non-breaking. **Revisit trigger:** if any org exceeds ~200 projects, or before Epic 9's multi-org platform story, add pagination to match the Story 2.3 credential-list shape. Until then, the exception stands and is documented in ADR-2.1-06 and AC-16.

**And** a user with no projects in their org receives:
```json
{ "data": { "items": [], "total": 0 } }
```

**And** the `role` field in each item is the user's role from `project_memberships` for that project.

**And** project names and slugs are visible to all org members including `viewer` role — **this is an explicit, recorded product + security decision, not an implementation default.** Until Story 4.1 adds per-project membership scoping, *every authenticated member of an org can list and view the dashboard of every project in that org.* The decision: project names/slugs are treated as org-internal metadata (not secret values), and all org members are trusted/vetted, so org-wide visibility is acceptable for v1. The security boundary that still holds in 2.1 is **cross-org isolation** (RLS), not intra-org per-project isolation. Credential *values* are never exposed by these endpoints regardless of visibility. This decision is owned jointly by product and security and MUST be re-affirmed (or tightened) when Story 4.1 introduces project-scoped roles — see ADR-2.1-01. Restricting project list visibility to per-project members is therefore deferred to Story 4.1. Project names must not be sanitized at the API layer (frontend escaping handles XSS; SvelteKit auto-escapes template expressions). In 2.1, `role` is always `owner` for the project creator; Story 4.1 will allow other members with different roles.

---

### AC-7: GET /api/v1/projects/:projectId/dashboard — Project Dashboard

**Given** an authenticated user calls `GET /api/v1/projects/:projectId/dashboard`,
**When** the project exists and the user has access,
**Then** return the dashboard payload:

**Request:**
```http
GET /api/v1/projects/00000000-0000-4000-8000-000000000010/dashboard
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "credentialStats": {
      "active": 0,
      "expiringSoon": 0,
      "expired": 0
    },
    "upcomingRotations": [],
    "monitoredServiceHealth": {
      "healthy": 0,
      "degraded": 0,
      "down": 0
    },
    "recentAccessEvents": [],
    "unresolvedAlertCount": 0,
    "isEmpty": true,
    "suggestedActions": ["add_credential", "add_service", "import_credentials"]
  }
}
```

**And** `isEmpty` MUST be computed from the actual counts in the response — not hardcoded. In Story 2.1 all counts are `0` so the result is always `true`, but writing it as a derived expression means Story 2.2 only needs to add the subquery counts and `isEmpty` auto-updates with no logic change:

```typescript
const credentialTotal =
  credentialStats.active + credentialStats.expiringSoon + credentialStats.expired
const serviceTotal =
  monitoredServiceHealth.healthy + monitoredServiceHealth.degraded + monitoredServiceHealth.down
const isEmpty = credentialTotal === 0 && serviceTotal === 0

const suggestedActions: Array<'add_credential' | 'add_service' | 'import_credentials'> = isEmpty
  ? ['add_credential', 'add_service', 'import_credentials']
  : []
// Note: suggestedActions returns [] when isEmpty: false — partial-completion guidance
// (e.g., "add a service" when credentials exist but no services) is deferred to Epic 6.
```

**And** `projectId` must be validated as a UUID (`z.uuid()`). A malformed path param returns `422 { code: "validation_error" }`.

**And** if the project does not exist within the calling user's org, return:
```json
HTTP 404
{ "code": "project_not_found", "message": "Project not found" }
```

> **Important:** Do NOT return a different error for "project exists but belongs to another org" vs "project does not exist". Both return `404`. The RLS policy already enforces that the query returns no rows for out-of-org projects; the application layer sees zero rows in both cases. This is intentional — it prevents org enumeration.

**And** data fields not yet populated by future epics (`upcomingRotations`, `monitoredServiceHealth`, `recentAccessEvents`) return empty arrays/zero counts — they MUST NOT return `null` or cause a 500. The response shape is fixed.

**And** the SecureRoute security:
```typescript
security: {
  minimumRole: 'viewer',   // any org member can read the dashboard
  writeAuditEvent: false,  // read-only; no audit event
}
```

---

### AC-8: PATCH /api/v1/projects/:projectId — Update Project

**Given** an authenticated user with `member` or higher role,
**When** they call `PATCH /api/v1/projects/:projectId`,
**Then** update `name` and/or `description`:

**Request:**
```http
PATCH /api/v1/projects/00000000-0000-4000-8000-000000000010
Content-Type: application/json
Cookie: access-token=<jwt>

{
  "name": "Payments API v2",
  "description": "Updated description for the payments domain."
}
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "id": "00000000-0000-4000-8000-000000000010",
    "name": "Payments API v2",
    "slug": "payments-api",
    "description": "Updated description for the payments domain.",
    "updatedAt": "2026-06-27T21:00:00.000Z"
  }
}
```

**And** `slug` is immutable after creation. If the client sends `slug` in the PATCH body, ignore it silently (strip from the update set) — do NOT return a validation error or update the slug.

**Rationale for slug immutability:** Slugs appear in URLs (future `/projects/payments-api/...` routes). Allowing slug changes after creation breaks bookmarked URLs and any existing references. [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.1`]

**And** both `name` and `description` are optional in the PATCH body. The Zod schema uses `.partial()`:
```typescript
const PatchProjectBodySchema = z.object({
  name: z.string().min(1).max(128).trim().optional(),
  description: z.string().max(512).trim().nullable().optional(),
})
```

**And** if neither `name` nor `description` is provided, return `422 { code: "validation_error", message: "No updatable fields provided" }`.

**And** the handler MUST use `.returning()` to get the updated row. A cross-org `PATCH` attempt returns 0 rows from the RLS-filtered update — if the handler doesn't check, it sends `200` with fabricated response data while writing nothing to the DB (a silent false success):

```typescript
const [updated] = await tx
  .update(projects)
  .set(updateSet)
  .where(eq(projects.id, params.projectId))
  .returning({
    id: projects.id,
    name: projects.name,
    slug: projects.slug,
    description: projects.description,
    updatedAt: projects.updatedAt,
  })

if (!updated) {
  return reply.status(404).send({ code: 'project_not_found', message: 'Project not found' })
}
return reply.send({ data: updated })
```

**And** the `200` response always includes the original (unchanged) `slug`. Clients sending a `slug` field see it unchanged — this is the intentional mechanism for communicating immutability. The web app create-project form must not include `slug` in PATCH requests.

**And** `description` has three meaningful states — the update logic MUST distinguish all three. Using `body.description ?? existing` silently skips an explicit `null` (clear) and keeps the old value, which is wrong:

```typescript
// CORRECT: three-state update — undefined means "not provided", null means "clear it"
const updateSet: Record<string, unknown> = {}
if (body.name !== undefined)        updateSet.name = body.name
if (body.description !== undefined) updateSet.description = body.description  // null IS a valid write

if (Object.keys(updateSet).length === 0) {
  return reply.status(422).send({ code: 'validation_error', message: 'No updatable fields provided' })
}
updateSet.updatedAt = new Date()
await tx.update(projects).set(updateSet).where(eq(projects.id, params.projectId))
```

**And** if the project is not found in the caller's org, return `404 { code: "project_not_found" }`.

**And** only `owner` and `admin` org roles may update a project:
```typescript
security: {
  minimumRole: 'admin',
  requireMfa: false,
  writeAuditEvent: {
    eventType: 'project.updated',
    resourceType: 'project',
    resourceIdFromParams: 'projectId',
  },
}
```

---

### AC-9: Route Registration and `app.ts`

**Given** the route audit CI gate reads `ROUTE_FILES` in `route-audit.test.ts`,
**When** Story 2.1 adds the projects module,
**Then** register the routes and update all required registries:

**1. Create `apps/api/src/modules/projects/routes.ts`** (see AC-4, AC-6, AC-7, AC-8 for handler details).

**2. Register in `apps/api/src/app.ts`:**
```typescript
import { projectRoutes } from './modules/projects/routes.js'
// ...
await fastify.register(projectRoutes, { prefix: '/api/v1/projects' })
```

**3. Add to `ROUTE_FILES` in `apps/api/src/__tests__/route-audit.test.ts`:**
```typescript
const ROUTE_FILES: Array<{ path: string; prefix: string }> = [
  { path: 'modules/auth/routes.ts', prefix: '/api/v1/auth' },
  { path: 'modules/org/routes.ts', prefix: '/api/v1/org' },
  { path: 'modules/vault/routes.ts', prefix: '' },
  { path: 'modules/projects/routes.ts', prefix: '/api/v1/projects' },  // ADD THIS
]
```

> **Typo risk:** The path string `'modules/projects/routes.ts'` is read from the filesystem at test time. A typo (e.g., `module/projects/routes.ts` or `modules/project/routes.ts`) causes the audit test to silently skip the file — all project routes appear unguarded without CI catching it. After updating `ROUTE_FILES`, run `pnpm --filter @project-vault/api test -- --reporter=verbose route-audit` in isolation and confirm it outputs route entries for the projects module before proceeding.

**4. Add all four routes to `ROUTE_ACTION_CLASSIFICATIONS` in `apps/api/src/lib/route-exemptions.ts`:**
```typescript
'POST /api/v1/projects': {
  action: 'mutation',
  auditEvent: 'project.created',
},
'GET /api/v1/projects': {
  action: 'read',
  auditOmissionReason: 'Project list read is org-scoped and does not reveal secret values.',
  reviewer: 'api-security-reviewer',
},
'GET /api/v1/projects/:projectId/dashboard': {
  action: 'read',
  auditOmissionReason: 'Dashboard read is org-scoped and returns only aggregate counts.',
  reviewer: 'api-security-reviewer',
},
'PATCH /api/v1/projects/:projectId': {
  action: 'mutation',
  auditEvent: 'project.updated',
},
```

**Critical:** Failing to add any of the above causes `route-audit.test.ts` to fail. Run this test before marking the story done.

**5. Add the `project.*` audit event names to the shared audit-event typing (`packages/shared/src/constants/audit-events.ts`):**

That file currently declares an `AuditEventType` union that still carries stale, never-emitted `secret.*` members (`secret.created` / `secret.read` / `secret.updated` / `secret.deleted`) inherited from the superseded architecture naming. Story 2.1 introduces the first `project.*` events. Therefore:

- Add `'project.created'` and `'project.updated'` to the `AuditEventType` union so the event names used in `ROUTE_ACTION_CLASSIFICATIONS` / `writeAuditEvent` are typed consistently across packages.
- Do **not** add new `secret.*` names. The credential events (`credential.*`) are added by Story 2.2; the legacy `secret.*` members should be treated as deprecated and removed in Story 2.2 when the canonical `credential.*` names land (do not depend on them here). If removing them in 2.1 is low-risk (no references), remove them now; otherwise leave the removal to Story 2.2 and add a `// deprecated: superseded by credential.* (Epic 2)` comment.
- `route-exemptions.ts` types `auditEvent` loosely as `string`, so the route-audit gate will pass regardless — the union update is for cross-package type consistency and to stop new code reaching for the stale `secret.*` names.

> Note: this is the only `packages/shared` source change required for 2.1's audit naming; the dev agent makes it during implementation (TDD applies). It is called out here so the audit-event vocabulary stays consistent from Epic 2 onward.

---

### AC-10: Shared Package — Promote `ProjectDashboardPreviewSchema` to Real Schema

**Given** Story 2.0 created `packages/shared/src/schemas/dashboard.ts` with `z.never()` stub arrays,
**When** Story 2.1 ships the real dashboard API,
**Then** replace the `z.never()` stubs with typed item schemas that are still empty-at-launch:

**Updated `packages/shared/src/schemas/dashboard.ts`:**
```typescript
import { z } from 'zod/v4'

// Rotation item shape (populated in Epic 5; empty array until then)
export const UpcomingRotationSchema = z
  .object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    scheduledAt: z.iso.datetime(),
    status: z.enum(['pending', 'overdue']),
  })
  .meta({ id: 'UpcomingRotation' })

// Access event item shape (populated in Story 2.2 with credential reveal events)
export const RecentAccessEventSchema = z
  .object({
    credentialId: z.uuid(),
    credentialName: z.string(),
    actorDisplayName: z.string(),
    eventType: z.enum(['credential.value_revealed', 'credential.created', 'credential.updated']),
    occurredAt: z.iso.datetime(),
  })
  .meta({ id: 'RecentAccessEvent' })

export const ProjectDashboardSchema = z
  .object({
    credentialStats: z.object({
      active: z.number().int().nonnegative(),
      expiringSoon: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
    }),
    upcomingRotations: z.array(UpcomingRotationSchema),
    monitoredServiceHealth: z.object({
      healthy: z.number().int().nonnegative(),
      degraded: z.number().int().nonnegative(),
      down: z.number().int().nonnegative(),
    }),
    recentAccessEvents: z.array(RecentAccessEventSchema),
    unresolvedAlertCount: z.number().int().nonnegative(),
    isEmpty: z.boolean(),
    suggestedActions: z.array(
      z.enum(['add_credential', 'add_service', 'import_credentials'])
    ),
  })
  .meta({ id: 'ProjectDashboard' })

export type UpcomingRotation = z.infer<typeof UpcomingRotationSchema>
export type RecentAccessEvent = z.infer<typeof RecentAccessEventSchema>
export type ProjectDashboard = z.infer<typeof ProjectDashboardSchema>

// Keep the Preview type as an alias for backwards compat with Story 2.0 web app code
export const ProjectDashboardPreviewSchema = ProjectDashboardSchema
export type ProjectDashboardPreview = ProjectDashboard

// Canonical empty value (still used by web app and unit tests)
export const EMPTY_PROJECT_DASHBOARD: ProjectDashboard = {
  credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
  upcomingRotations: [],
  monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
  recentAccessEvents: [],
  unresolvedAlertCount: 0,
  isEmpty: true,
  suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
}

// Backwards-compat alias
export const EMPTY_PROJECT_DASHBOARD_PREVIEW = EMPTY_PROJECT_DASHBOARD
```

**And** add/update the export in `packages/shared/src/index.ts`:
```typescript
export * from './schemas/dashboard.js'
```
(This line was added by Story 2.0. If it already exists, no change needed.)

**And** update `packages/shared/src/schemas/dashboard.test.ts` (created in Story 2.0). **CRITICAL: Story 2.0 added assertions that must be DELETED (not edited)** — they assert that non-empty arrays throw, which is now inverted behavior:

```typescript
// ❌ DELETE these Story 2.0 tests — z.never() is gone; these now fail by NOT throwing:
// expect(() => ProjectDashboardPreviewSchema.parse({ ...data, upcomingRotations: [someItem] })).toThrow()
// expect(() => ProjectDashboardPreviewSchema.parse({ ...data, recentAccessEvents: [someItem] })).toThrow()
```

Replace with these 2.1 tests:

```typescript
// ✅ ADD: non-empty arrays with valid items now succeed
it('accepts a valid upcomingRotation item', () => {
  expect(() => ProjectDashboardSchema.parse({
    ...EMPTY_PROJECT_DASHBOARD,
    upcomingRotations: [{
      credentialId: '00000000-0000-4000-8000-000000000001',
      credentialName: 'DB Password',
      scheduledAt: '2026-07-01T00:00:00.000Z',
      status: 'pending',
    }],
    isEmpty: false,
  })).not.toThrow()
})

it('rejects an upcomingRotation item missing required fields', () => {
  expect(() => ProjectDashboardSchema.parse({
    ...EMPTY_PROJECT_DASHBOARD,
    upcomingRotations: [{ credentialName: 'only-name' }],  // missing credentialId, scheduledAt, status
  })).toThrow()
})

// ✅ KEEP: empty dashboard still parses successfully
it('parses EMPTY_PROJECT_DASHBOARD', () => {
  expect(() => ProjectDashboardSchema.parse(EMPTY_PROJECT_DASHBOARD)).not.toThrow()
})
```

**And** update `apps/web/src/lib/api/dashboard-preview.ts` (or wherever the web app imports the schema) to use `ProjectDashboardSchema` / `ProjectDashboard`. The type alias `ProjectDashboardPreview = ProjectDashboard` ensures the rename is source-compatible without a full find-and-replace.

---

### AC-11: Zod Request/Response Schemas for the Projects Module

> **Schema placement (single source of truth):** Response representation schemas that the **web app also consumes** (`ProjectSummarySchema`, `ProjectDetailSchema`) live in `packages/shared/src/schemas/projects.ts` — mirroring how `dashboard.ts` is shared between API and web (Story 2.0 precedent). **Request** schemas (`CreateProjectBodySchema`, `PatchProjectBodySchema`, `ProjectParamsSchema`) are API-only and live in `apps/api/src/modules/projects/schema.ts`. The API module imports the response schemas from `@project-vault/shared`; the web app imports its types from the same place. Do NOT define `ProjectSummary`/`ProjectDetail` in the API module — the web app cannot import API-module types.

**Step A — `packages/shared/src/schemas/projects.ts` (NEW, web-consumed response schemas):**

```typescript
import { z } from 'zod/v4'

export const ProjectRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer'])

// Naming note: the list-summary fields (alertCount, expiringCount) intentionally differ
// from the dashboard's field names (unresolvedAlertCount, credentialStats.expiringSoon).
// The list shows simple totals; the dashboard shows status-specific breakdowns. Do NOT
// rename one to match the other — they are distinct contracts on distinct endpoints.
export const ProjectSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    role: ProjectRoleSchema,
    credentialCount: z.number().int().nonnegative(),
    expiringCount: z.number().int().nonnegative(),
    alertCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ProjectSummary' })

export const ProjectDetailSchema = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    role: ProjectRoleSchema,
    createdBy: z.uuid().nullable(),  // nullable: matches the DB column (SET NULL on user delete, ADR-2.1-04)
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ProjectDetail' })

export type ProjectRole = z.infer<typeof ProjectRoleSchema>
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>
```

**And** add to `packages/shared/src/index.ts`:
```typescript
export * from './schemas/projects.js'
```

**Step B — `apps/api/src/modules/projects/schema.ts` (NEW, request schemas + response envelopes):**

```typescript
import { z } from 'zod/v4'
import { ProjectDashboardSchema, ProjectSummarySchema, ProjectDetailSchema } from '@project-vault/shared'

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$|^[a-z0-9]{3}$/

// .strict() is intentional on both mutation schemas:
// Zod's default .strip() silently drops unknown keys — mass-assignment attempts
// (e.g., sending orgId, createdBy) disappear without any error or log entry.
// .strict() returns 422 on unknown keys, making such attempts visible in error logs.
// Trade-off: clients sending new fields get 422 until the schema is updated — acceptable
// for a versioned internal API where clients are under the project's control.
export const CreateProjectBodySchema = z
  .object({
    name: z.string().min(1).max(128).trim(),
    slug: z.string().regex(SLUG_REGEX, 'Slug must be 3–50 lowercase alphanumeric characters and hyphens'),
    description: z.string().max(512).trim().nullable().optional(),
  })
  .strict()
  .meta({ id: 'CreateProjectBody' })

export const PatchProjectBodySchema = z
  .object({
    name: z.string().min(1).max(128).trim().optional(),
    description: z.string().max(512).trim().nullable().optional(),
  })
  .strict()
  .meta({ id: 'PatchProjectBody' })

export const ProjectParamsSchema = z
  .object({ projectId: z.uuid() })
  .meta({ id: 'ProjectParams' })

// ProjectSummarySchema and ProjectDetailSchema are imported from @project-vault/shared (Step A) —
// do NOT redefine them here. They are response representations the web app also consumes.

export const ProjectListResponseSchema = z
  .object({
    data: z.object({
      items: z.array(ProjectSummarySchema),
      total: z.number().int().nonnegative(),
    }),
  })
  .meta({ id: 'ProjectListResponse' })

export const ProjectDashboardResponseSchema = z
  .object({ data: ProjectDashboardSchema })
  .meta({ id: 'ProjectDashboardResponse' })

export const PatchProjectResponseSchema = z
  .object({
    data: z.object({
      id: z.uuid(),
      name: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      updatedAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'PatchProjectResponse' })

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>
export type PatchProjectBody = z.infer<typeof PatchProjectBodySchema>
export type ProjectParams = z.infer<typeof ProjectParamsSchema>
// ProjectSummary / ProjectDetail types come from @project-vault/shared — re-export if convenient:
export type { ProjectSummary, ProjectDetail } from '@project-vault/shared'
```

---

### AC-12: RLS Cross-Org Isolation — Integration Test

**Given** the `withTestOrg()` + `withOrg()` test helpers in `packages/db/src/test-helpers.ts`,
**When** Story 2.1 integration tests are written,
**Then** add `packages/db/src/__tests__/projects-rls-isolation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb, withOrg } from '../index.js'
import { withTestOrg } from '../test-helpers.js'
import { projects, projectMemberships } from '../schema/index.js'

async function createTestUser(label: string): Promise<string> {
  const [user] = await getDb().execute(
    sql`INSERT INTO users (email, password_hash)
        VALUES (${`proj-rls-${label}-${crypto.randomUUID()}@example.com`}, 'x')
        RETURNING id`
  )
  return (user as { id: string }).id
}

async function deleteTestUser(userId: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM users WHERE id = ${userId}`)
}

describe('projects RLS cross-org isolation', () => {
  it('isolates projects rows by org', async () => {
    const userId = await createTestUser('projects')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          await withOrg(orgAId, (tx) =>
            tx.insert(projects).values({
              orgId: orgAId,
              name: 'Project A',
              slug: 'project-a',
              createdBy: userId,
            })
          )
          await withOrg(orgBId, (tx) =>
            tx.insert(projects).values({
              orgId: orgBId,
              name: 'Project B',
              slug: 'project-b',
              createdBy: userId,
            })
          )

          const orgARows = await withOrg(orgAId, (tx) => tx.select().from(projects))
          expect(orgARows).toHaveLength(1)
          expect(orgARows[0]?.orgId).toBe(orgAId)

          const orgBRows = await withOrg(orgBId, (tx) => tx.select().from(projects))
          expect(orgBRows).toHaveLength(1)
          expect(orgBRows[0]?.orgId).toBe(orgBId)

          // Bare query (no org context) returns zero rows
          const bareRows = await getDb().select().from(projects)
          expect(bareRows).toHaveLength(0)
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('slug uniqueness is per-org (same slug allowed in different orgs)', async () => {
    const userId = await createTestUser('slug-unique')
    try {
      await withTestOrg(async ({ orgId: orgAId }) => {
        await withTestOrg(async ({ orgId: orgBId }) => {
          await withOrg(orgAId, (tx) =>
            tx.insert(projects).values({ orgId: orgAId, name: 'API', slug: 'api', createdBy: userId })
          )
          // Same slug in a different org must succeed
          await expect(
            withOrg(orgBId, (tx) =>
              tx.insert(projects).values({ orgId: orgBId, name: 'API', slug: 'api', createdBy: userId })
            )
          ).resolves.not.toThrow()

          // Same slug in the SAME org must fail (unique constraint)
          await expect(
            withOrg(orgAId, (tx) =>
              tx.insert(projects).values({ orgId: orgAId, name: 'API 2', slug: 'api', createdBy: userId })
            )
          ).rejects.toThrow()
        })
      })
    } finally {
      await deleteTestUser(userId)
    }
  })
})
```

---

### AC-13: API Integration Tests

**Given** the API integration tests use Fastify `inject()` against a real database,
**When** Story 2.1 API tests are written,
**Then** add `apps/api/src/modules/projects/routes.test.ts` covering the scenarios below.

> **Auth harness (reuse — do not reinvent):** Authenticated requests are set up with the existing helpers in `apps/api/src/__tests__/helpers/auth-test-helpers.ts` — `registerAndLoginViaApi(app, { ... })` returns `{ userId, orgId, cookies }`, and `cookieHeader(jar)` produces the `cookie` request header. The cross-org test (org B accessing org A's project) registers two separate users via this helper to get two distinct authenticated orgs. See `apps/api/src/__tests__/sessions.integration.test.ts` for the exact usage pattern (`registerAndLogin` → `app.inject({ headers: { cookie: cookieHeader(...) } })`).

Required scenarios:

**Test scenarios (minimum required):**

```
POST /api/v1/projects
  - 201 creates project, returns detail with role: "owner"
  - 201 description is optional; null when omitted
  - 201 creates project_memberships entry for creator
  - 409 when slug is already taken in the same org
  - 422 when slug format is invalid (uppercase, spaces, leading hyphen)
  - 422 when name is missing
  - 422 when orgId is provided in body (must be stripped/rejected)
  - 401 when unauthenticated

GET /api/v1/projects
  - 200 returns empty list when no projects exist
  - 200 returns only the caller's org projects (cross-org isolation)
  - 200 includes role from project_memberships for the calling user
  - 200 credentialCount, expiringCount, alertCount are always 0 in 2.1
  - 401 when unauthenticated

GET /api/v1/projects/:projectId/dashboard
  - 200 returns empty dashboard with isEmpty: true and suggestedActions
  - 200 all array fields are empty, all counts are 0
  - 404 when projectId does not exist
  - 404 when projectId belongs to a different org (not 403 — prevent enumeration)
  - 422 when projectId is not a valid UUID
  - 401 when unauthenticated

PATCH /api/v1/projects/:projectId
  - 200 updates name
  - 200 updates description (including setting to null)
  - 200 silently ignores slug in body (returns original slug)
  - 200 updatedAt is newer than createdAt
  - 404 when projectId does not exist
  - 422 when body is empty (no updatable fields)
  - 403 when caller has viewer role (minimumRole: admin)
  - 401 when unauthenticated

SEALED-VAULT GUARD (vault-guard fail-closed)
  - 503 { status: "sealed" } for POST /api/v1/projects when the vault is sealed/uninitialized
  - 503 { status: "sealed" } for GET /api/v1/projects when sealed
  - 503 { status: "sealed" } for GET /api/v1/projects/:projectId/dashboard when sealed
  - 503 { status: "sealed" } for PATCH /api/v1/projects/:projectId when sealed
  - (project routes are NOT on the vault-guard allowlist; assert the guard runs before the handler)

AUDIT-FAILURE ROLLBACK (mutations are fail-closed on audit)
  - POST /api/v1/projects: when the audit write (project.created) is forced to fail, the whole
    transaction rolls back — NO projects row and NO project_memberships row are persisted, and the
    client receives 503 (audit_write_failed), not a 201 with an un-audited project.
  - PATCH /api/v1/projects/:projectId: when the audit write (project.updated) is forced to fail,
    the update rolls back — the project row is unchanged and the client receives 503, not a 200.
  - These prove the SecureRoute same-transaction audit coupling: a mutation is never committed
    without its audit row (mirrors the Story 2.2 reveal fail-closed guarantee for write events).
```

**And** all tests use `withTestOrg()` — RLS is always active. **Never assert row counts after a bare `getDb()` insert** — RLS silently returns zero rows without the org context, making tests false-pass (0 rows seen, assertion expects 0, test passes, but the data was written, not absent). Always insert AND query within the same `withOrg()` / `withTestOrg()` scope.

**And** the cross-org `404` test must be explicit:
```typescript
it('dashboard returns 404 for a project in another org (prevents enumeration)', async () => {
  // Create project in org A
  const projectIdFromOrgA = /* ... */
  // Authenticate as a user in org B
  // Call GET /api/v1/projects/:projectIdFromOrgA/dashboard
  // Expect 404, not 403
})
```

---

### AC-14: Web App Dashboard Page Update

**Given** the web app dashboard page (`apps/web/src/routes/(app)/dashboard/+page.svelte` or equivalent) currently uses the Story 2.0 preview stub data,
**When** Story 2.1 ships the real API,
**Then** update the web app to call `GET /api/v1/projects/:projectId/dashboard` via the API client helpers in `apps/web/src/lib/api/`.

**Required additions to the web API client (`apps/web/src/lib/api/projects.ts` — new file):**
```typescript
import { apiFetch } from './client.js'
// ProjectDashboard from schemas/dashboard.ts; ProjectDetail/ProjectSummary from schemas/projects.ts — both in @project-vault/shared
import type { ProjectDashboard, ProjectDetail, ProjectSummary } from '@project-vault/shared'

export async function createProject(
  fetchFn: typeof fetch,
  body: { name: string; slug: string; description?: string | null }
): Promise<ProjectDetail> {
  return apiFetch(fetchFn, '/api/v1/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function listProjects(
  fetchFn: typeof fetch
): Promise<{ items: ProjectSummary[]; total: number }> {
  return apiFetch(fetchFn, '/api/v1/projects')
}

export async function getProjectDashboard(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ProjectDashboard> {
  return apiFetch(fetchFn, `/api/v1/projects/${projectId}/dashboard`)
}

export async function updateProject(
  fetchFn: typeof fetch,
  projectId: string,
  body: { name?: string; description?: string | null }
): Promise<{ id: string; name: string; slug: string; description: string | null; updatedAt: string }> {
  return apiFetch(fetchFn, `/api/v1/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}
```

**And** the `dashboard/+page.svelte` server load must:
1. Call `GET /api/v1/projects` to list the user's projects.
2. If the user has projects, call `GET /api/v1/projects/:firstProjectId/dashboard` to populate the dashboard.
3. If the user has no projects, render the empty state (same as Story 2.0 but now confirmed from the real API).

**And** a real "Create Project" form replaces the Story 2.0 preview stub. The form (e.g., `apps/web/src/routes/(app)/projects/new/+page.svelte` or a modal on the projects list) must:

- Provide labeled inputs for `name` (required), `slug` (required), and `description` (optional).
- **Auto-suggest the slug from the name** as a non-binding affordance (per ADR-2.1-03): lowercase the name, replace spaces/invalid chars with hyphens, trim leading/trailing hyphens, truncate to 50 chars. The user may edit the suggestion. The backend always validates the final explicit value — the frontend never silently submits a name-derived slug the user didn't see.
- Apply client-side validation mirroring the backend rules (slug regex, 3–50 chars, name 1–128) for fast feedback — but never weaker than the server.
- On submit, call `createProject()`. On success, **navigate to the new project's dashboard** (`/dashboard` populated with the new project, or a future `/projects/:id` route) — do not leave the user on an empty form.
- On `409 slug_taken`, surface the message **inline on the slug field** ("A project with this slug already exists — try another"), not as a generic page error. The form must catch the `ApiClientError` with status `409` and map it to the slug field.
- On `422 validation_error`, show field-level messages from the backend `details`.

**And** the new form and the project list must remain mobile-friendly per Story 2.0's invariants: no horizontal scroll at 320px / 375px / 390px, touch-friendly controls, labels visible. Add a structural assertion to the mobile smoke test (or extend the existing one from Story 2.0).

**And** the preview stub in `apps/web/src/lib/state/preview-project.svelte.ts` and `apps/web/src/routes/(app)/projects/preview/+page.svelte` (if implemented in 2.0) is superseded by the real creation flow. Remove it (and its tests) OR retain it as an explicitly-labeled "quick preview" distinct from real projects. **Do not remove the preview stub without updating all dependent Story 2.0 tests** — run `pnpm --filter @project-vault/web test` after.

**And** add `apps/web/src/lib/api/projects.test.ts` covering:
```
- createProject sends correct body and returns project data
- listProjects returns items array
- getProjectDashboard returns dashboard with isEmpty
- updateProject sends correct body
- all helpers normalize { code, message } errors
- createProject surfaces 409 slug_taken as a catchable ApiClientError (form maps to slug field)
```

**And** add a focused test for the create form's slug auto-suggestion helper (pure function): `"Payments API" -> "payments-api"`, `"  My  App!! " -> "my-app"`, names longer than 50 chars truncate without a trailing hyphen.

---

### AC-15: Security Hardening

**Given** Project Vault is a data-sensitive platform,
**When** Story 2.1 routes are implemented,
**Then** satisfy these security invariants:

| Threat | Required mitigation |
|---|---|
| Cross-org project access | PostgreSQL RLS enforces isolation at the DB layer; application returns 404 for both "not found" and "wrong org" (prevents enumeration). |
| Slug injection | Zod regex validation rejects anything except `[a-z0-9-]`; no interpolation of slug into SQL (Drizzle ORM parameterized queries). |
| orgId poisoning | `orgId` is always taken from `auth.orgId` (JWT claim), never from request body/query params. Both mutation schemas use `.strict()` — unknown keys including `orgId` return `422`. |
| Mass assignment via `req.body` spread | Drizzle insert/update values always come from Zod parse output, never from `req.body` directly. TypeScript casts are erased at runtime and provide no protection. |
| PATCH silent false success on cross-org write | Handler uses `.returning()` and checks row count — 0 rows → `404`, not `200`. |
| Unbounded project creation | POST rate limit overridden to `{ max: 20, timeWindowMs: 60_000 }`. |
| Unprivileged project update | `PATCH` requires `minimumRole: 'admin'`; `viewer` and `member` receive `403 { code: "insufficient_role" }`. |
| Audit trail completeness | POST and PATCH emit audit events via SecureRoute `writeAuditEvent`. GET routes omit audit (read-only, classified in `ROUTE_ACTION_CLASSIFICATIONS`). |
| Audit-write failure must not silently commit a mutation | SecureRoute writes the audit row in the **same transaction** as the handler. If the `project.created`/`project.updated` audit write fails, the whole tx rolls back and the client gets `503 audit_write_failed` — no project is created/updated without a recorded audit event. Asserted by the AC-13 audit-failure rollback tests. |
| RLS bypass in tests | `withTestOrg()` must be used in all integration tests. Never call `getDb().select().from(projects)` without org context in a test that asserts real data — the RLS will silently return zero rows and the test will false-pass. |
| Service function breaking outer transaction | Helper functions accept `tx: Tx` parameter; never call `getDb()` internally — documented in Anti-Patterns. |
| Operating on a sealed/uninitialized vault | The global `vault-guard` (`apps/api/src/plugins/vault-guard.ts`) is an `onRequest` hook that returns `503 { status: "sealed" }` for every route not on its allowlist whenever the vault is not `unsealed`. None of the four project routes are allowlisted, so all project reads/writes return `503` while sealed — fail-closed. This is asserted by the sealed-vault tests in AC-13. |

---

### AC-16: Explicit Out of Scope

Do **not** implement any of the following in Story 2.1:

- Credential storage, retrieval, search, or version history (Story 2.2+).
- Dependent system recording, rotation schedules (Story 2.4).
- Bulk import (Story 2.5).
- Onboarding wizard (Story 2.6).
- Cross-project global search (Story 2.7).
- Per-project RBAC (inviting members with custom roles per project) — this is Story 4.1. In 2.1, project access means "authenticated user in the org".
- Real `credentialCount`, `expiringCount`, or `alertCount` subqueries — always return `0`.
- Real `monitoredServiceHealth`, `upcomingRotations`, or `recentAccessEvents` data — always return empty.
- Project archival (`DELETE` or `PATCH archived: true`) — `archivedAt` column is reserved for Story 4.4.
- Project deletion endpoint.
- A dedicated org-wide aggregate dashboard endpoint (epic AC-E2d: total credentials, expiring-within-30-days, projects with overdue rotations). Deferred per ADR-2.1-08 — every input is zero until Story 2.2+/Epic 3/Epic 5 exist. The v1 cross-project view is the per-project list with per-project counts; a client-side rollup is acceptable if shown.
- Pagination on `GET /api/v1/projects` — intentionally omitted as an **accepted FR97 exception** (ADR-2.1-06 / AC-6). Not an oversight; revisit at ~200 projects/org or Epic 9. The `{ items, total }` envelope is forward-compatible.
- Project notes as a separate entity (FR8 `description` field covers notes for v1; a dedicated notes API is not required in 2.1).
- `suggestedActions` partial-completion guidance (e.g., showing `add_service` when credentials already exist but no services are configured). In Story 2.1, `suggestedActions` is either the full 3-item list (when `isEmpty: true`) or empty (when `isEmpty: false`). Smarter partial-completion suggestions are deferred until Epic 6 monitoring data exists to reason about coverage gaps.
- Machine user project access (Epic 7).
- Audit log query UI (Epic 8).

---

### AC-17: Tasks / Subtasks

> Follow repo TDD red-green (`AGENTS.md`): write or update failing tests first, confirm they fail for the expected reason, implement the smallest change, then rerun focused and relevant broader checks.

- [x] **Task 1: Database schema and migration** (AC: 1, 2, 3)
  - [x] Create `packages/db/src/schema/projects.ts` and `project-memberships.ts`.
  - [x] Export both from `packages/db/src/schema/index.ts`.
  - [x] Run `pnpm --filter @project-vault/db generate` to generate the projects migration (next free number — `0013_projects.sql` on today's branch; verify `meta/_journal.json` first).
  - [x] Add RLS policies, FK from `audit_log_entries`, and `updated_at` trigger to the generated migration.
  - [x] Run `pnpm --filter @project-vault/db check-rls` to confirm no coverage gap.
  - [x] Run `pnpm --filter @project-vault/db migrate` locally to apply.
- [x] **Task 2: Shared package schemas** (AC: 10, 11)
  - [x] Write failing test in `dashboard.test.ts` for the new item schemas; DELETE the Story 2.0 `z.never()` rejection tests.
  - [x] Update `packages/shared/src/schemas/dashboard.ts` to replace `z.never()` with real schemas and backwards-compat aliases.
  - [x] Create `packages/shared/src/schemas/projects.ts` with `ProjectSummarySchema`, `ProjectDetailSchema`, `ProjectRoleSchema` (web-consumed response schemas).
  - [x] Add `export * from './schemas/projects.js'` to `packages/shared/src/index.ts`.
  - [x] Run `pnpm --filter @project-vault/shared test`; run `pnpm install` so the web app picks up new exports.
- [x] **Task 3: API request schema types** (AC: 11)
  - [x] Create `apps/api/src/modules/projects/schema.ts` with request schemas (`CreateProjectBodySchema`, `PatchProjectBodySchema`, `ProjectParamsSchema`) and response envelopes, importing `ProjectSummarySchema`/`ProjectDetailSchema`/`ProjectDashboardSchema` from `@project-vault/shared`.
  - [x] Add unit tests for slug validation regex edge cases (leading hyphen, trailing hyphen, uppercase, min/max length).
  - [x] Add a unit test asserting `.strict()` rejects unknown keys (e.g., `orgId`) with a parse error.
- [x] **Task 4: POST /api/v1/projects** (AC: 4, 5, 9)
  - [x] Write failing integration test for project creation.
  - [x] Implement handler including `project_memberships` insert in same transaction.
  - [x] Implement `409 slug_taken` catch (Postgres error code `23505` + constraint name).
  - [x] Run route-audit test to confirm classification entry is present.
- [x] **Task 5: GET /api/v1/projects** (AC: 6, 9)
  - [x] Write failing test for empty list, populated list, cross-org isolation.
  - [x] Implement handler with project + membership join.
  - [x] Confirm `credentialCount`, `expiringCount`, `alertCount` are always `0`.
- [x] **Task 6: GET /api/v1/projects/:projectId/dashboard** (AC: 7, 9)
  - [x] Write failing tests for empty dashboard, 404, cross-org 404 (not 403), and 422 on bad UUID.
  - [x] Implement handler with `isEmpty` computation and `suggestedActions` derivation.
- [x] **Task 7: PATCH /api/v1/projects/:projectId** (AC: 8, 9)
  - [x] Write failing tests for update, slug immutability, empty body rejection, and viewer 403.
  - [x] Implement handler; strip `slug` from update set.
- [x] **Task 8: Route audit registration + audit-event constants** (AC: 9)
  - [x] Add `projectRoutes` to `app.ts`.
  - [x] Add `modules/projects/routes.ts` to `ROUTE_FILES` in `route-audit.test.ts`.
  - [x] Add all four route entries to `ROUTE_ACTION_CLASSIFICATIONS` in `route-exemptions.ts`.
  - [x] Add `'project.created'` and `'project.updated'` to `AuditEventType` in `packages/shared/src/constants/audit-events.ts`; do not add new `secret.*` names (treat legacy `secret.*` as deprecated — see AC-9 step 5).
  - [x] Run `pnpm --filter @project-vault/api test` to confirm route-audit passes.
- [x] **Task 9: RLS isolation integration test** (AC: 12)
  - [x] Create `packages/db/src/__tests__/projects-rls-isolation.test.ts`.
  - [x] Confirm cross-org isolation and per-org slug uniqueness.
- [x] **Task 10: Web app updates** (AC: 14)
  - [x] Create `apps/web/src/lib/api/projects.ts` with typed API helpers (importing `ProjectDetail`/`ProjectSummary`/`ProjectDashboard` from `@project-vault/shared`).
  - [x] Build the real "Create Project" form: name/slug/description inputs, slug auto-suggest from name, client validation, submit → navigate to the new project's dashboard.
  - [x] Map `409 slug_taken` to an inline error on the slug field; map `422` to field-level errors.
  - [x] Update the dashboard page server load to call the real API (list → first project dashboard, or empty state).
  - [x] Supersede or relabel the Story 2.0 preview stub; update its dependent tests.
  - [x] Add `projects.test.ts` (API helpers + 409 path) and a unit test for the slug auto-suggest helper.
  - [x] Confirm the new form + project list pass mobile responsiveness (320/375/390px) — extend the Story 2.0 mobile smoke test.
  - [x] Run `pnpm --filter @project-vault/web test`, `typecheck`, and `lint`.
- [x] **Task 11: Final verification** (AC: 13, 15, 17)
  - [x] Confirm the AC-13 sealed-vault `503` tests pass for all four project routes (vault-guard fail-closed).
  - [x] Confirm the AC-13 audit-failure rollback tests pass for `project.created` and `project.updated` (mutation never commits without its audit row).
  - [x] Run `pnpm --filter @project-vault/db test` (includes RLS isolation test).
  - [x] Run `pnpm --filter @project-vault/api test` (includes route-audit, integration tests).
  - [x] Run `pnpm --filter @project-vault/shared test`.
  - [x] Run `pnpm --filter @project-vault/web test`, `typecheck`, and `lint`.
  - [x] Run `pnpm typecheck` and `pnpm lint` at repo root.
  - [x] Confirm `pnpm --filter @project-vault/db check-rls` passes.

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| New API module location | `apps/api/src/modules/projects/` — create `routes.ts`, `schema.ts`, and a `service.ts` if the handler logic grows beyond ~60 lines per handler. |
| New DB schema files | `packages/db/src/schema/projects.ts` and `project-memberships.ts`. Both must be exported from `schema/index.ts`. |
| Migration file | `packages/db/src/migrations/<next>_projects.sql` — number follows the current journal tip. On today's branch the last migration is `0012_refresh_tokens_org_id.sql`, so this is `0013_projects.sql`. Verify `meta/_journal.json` before generating; never hardcode. |
| Shared schema location | `packages/shared/src/schemas/dashboard.ts` — already exists from Story 2.0; update in place with backwards-compat aliases. NEW `packages/shared/src/schemas/projects.ts` holds `ProjectSummarySchema`/`ProjectDetailSchema` (response shapes the web app also consumes). |
| Web API helpers | `apps/web/src/lib/api/projects.ts` — new file, follows the existing pattern in `auth.ts` and `vault.ts`. |

### Key Code Patterns to Follow

**SecureRoute usage** (copy from `apps/api/src/modules/org/routes.ts`):
```typescript
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'

secureRoute(fastify, {
  method: 'POST',
  url: '/',                           // prefix '/api/v1/projects' is set in app.ts
  security: { minimumRole: 'member', writeAuditEvent: { eventType: 'project.created', resourceType: 'project' } },
  handler: async (ctx, req, reply) => {
    const { auth, tx } = ctx as SecureRouteContext
    // auth.orgId, auth.userId, auth.orgRole are available
    // tx is the RLS-scoped transaction — use it for ALL db queries in this handler
    // ...
    return reply.status(201).send({ data: { /* ... */ } })
  },
})
```

**Transaction-scoped insert (both tables in one tx):**
```typescript
// The SecureRoute framework wraps the handler in db.transaction() with setRlsOrgContext() already called.
// Just use the provided `tx` — do NOT call getDb() or db.transaction() again inside the handler.
const [project] = await tx.insert(projects).values({
  orgId: auth.orgId,
  name: body.name,
  slug: body.slug,
  description: body.description ?? null,
  createdBy: auth.userId,
}).returning()

await tx.insert(projectMemberships).values({
  orgId: auth.orgId,
  projectId: project.id,
  userId: auth.userId,
  role: 'owner',
})
```

**OrgRole vs project role in 2.1:** The `SecureRoute` `minimumRole` check uses `auth.orgRole` (the user's org-wide role). In 2.1, project access = org membership. `project_memberships` records the creator for future use (Story 4.1) but does not gate access in this story.

**Timestamp serialization (applies to ALL four endpoints):** Drizzle `.returning()` and `select()` return `createdAt`/`updatedAt`/`archivedAt` as JS `Date` objects, but the response Zod schemas declare them as `z.iso.datetime()` (strings). With `@fastify/type-provider-zod`'s `serializerCompiler`, a `Date` fails string validation at serialization time. Convert every timestamp with `.toISOString()` (and `?.toISOString() ?? null` for nullable `archivedAt`) before sending. The auth module avoids this only because its service layer already returns strings.

**Wire response schemas to each route.** Match the auth module pattern — pass the response schema so OpenAPI documents it and the serializer is engaged:
```typescript
secureRoute(fastify, {
  method: 'GET',
  url: '/',
  schema: { response: { 200: ProjectListResponseSchema, 401: ApiErrorSchema } },
  security: { minimumRole: 'viewer', writeAuditEvent: false },
  handler: async (ctx, req, reply) => { /* ... */ },
})
```
Use `ProjectListResponseSchema` (GET list), `ProjectDashboardResponseSchema` (GET dashboard), `PatchProjectResponseSchema` (PATCH), and a `{ data: ProjectDetailSchema }` envelope (POST 201). Import `ApiErrorSchema` from `../../lib/api-contracts.js`.

**`validationError()` helper** (from `apps/api/src/lib/route-helpers.ts`) for Zod parse errors:
```typescript
const parsed = CreateProjectBodySchema.safeParse(req.body)
if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
```

### Architecture Compliance

- **No bare `getDb()` in route handlers.** The `SecureRoute` framework passes a transaction-scoped `tx` in the `SecureRouteContext`. Using `getDb()` inside a handler bypasses RLS. If you add `getDb` to the import list in a route file, you must add it to `DIRECT_DB_ACCESS_CLASSIFICATIONS` in `route-exemptions.ts` with justification — and the route-audit test will fail if you don't.
- **`org_id` always from JWT, never from request.** `auth.orgId` is the only valid source. The Zod body schemas must not include `orgId` as an accepted field.
- **RLS policies in the same migration file.** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` must be in the projects migration (`<next>_projects.sql`, e.g. `0013_projects.sql`). The `check-rls` CI task runs before `migrate`; if the policy is missing, CI fails.
- **No `test-helpers.ts` change is needed for cleanup.** `projects` and `project_memberships` are `orgScoped({ onDelete: 'cascade' })`, so deleting the test organization in `withTestOrg()`'s teardown cascades both tables automatically. The new `audit_log_entries → projects` FK uses `ON DELETE SET NULL`, so cascading project deletion nullifies `project_id` on any audit rows rather than blocking — it does not interfere with the existing append-only audit cleanup path (which already tolerates the expected append-only/FK-violation errors). Do not add manual `projects` cleanup to `withTestOrg()`.
- **Route registration order in `app.ts`.** Register `projectRoutes` after `orgRoutes` and before any future epic-scoped modules. Fastify plugin registration is order-dependent for logging/metrics context.
- **`authMeResponseSchema` and `authMeResponse`** in `modules/auth/schema.ts` does not include `projectRole` — do not add it in 2.1. `projectRole` is a Story 4.1 concern.

### Tech Stack Versions (Repo Pinned)

| Technology | Version | Notes |
|---|---|---|
| Drizzle ORM | `^0.45.x` | Use `pgTable`, `uuid`, `text`, `timestamp`, `uniqueIndex`, `index`, `check`, `primaryKey`. |
| zod | `zod/v4` | Import as `import { z } from 'zod/v4'`. Use `.meta({ id })` on all exported schemas. |
| Fastify | `^5.x` | `secureRoute()` handles method+url registration and audit. |
| Node | `>=24.0.0` | Do not add tooling incompatible with Node 24. |

### Anti-Patterns (Do Not)

- Do not call `getDb()` or `db.transaction()` inside a SecureRoute handler — use the provided `tx`.
- Do not mark `createdBy` as `.notNull()` — it is intentionally nullable (`onDelete: 'set null'`) so user deletion does not cascade to project deletion.
- Do not add `projects` or `project_memberships` to `EXCLUDED_TABLES` in `check-rls-coverage.ts`.
- Do not return `403` for cross-org project access — return `404` to prevent org enumeration.
- Do not add `orgId` to the POST/PATCH request body schemas.
- Do not implement real credential/health/rotation counts in the dashboard — always `0` in 2.1.
- Do not change the `slug` on PATCH — silently ignore it, never error on it.
- Do not create a separate `modules/dashboard/` module for 2.1 — `modules/projects/` handles it.
- Do not skip `writeAuditEvent` for POST and PATCH — both are mutations that require audit trail.
- Do not manually write RLS policies in application code — they belong in the migration SQL file.
- Do not import `ProjectDashboardPreviewSchema` if you can use the new `ProjectDashboardSchema` — the alias exists only for backwards compat.
- **Never pass `req.body` directly to a Drizzle insert/update.** Always use the output of `Schema.safeParse(req.body)` (or `.parse()`). TypeScript casts like `req.body as CreateProjectBody` are erased at runtime — they do not strip unknown keys. Only Zod parsing strips or rejects them.
- **Service functions called from within a SecureRoute handler must accept `tx: Tx` and use it exclusively.** If a helper function calls `getDb()` or `getDb().transaction()` internally, it creates a separate DB connection outside the RLS-scoped transaction. The outer transaction's rollback will not cover work done in the inner connection.
- **PATCH and any other update handler must use `.returning()` and check row count.** A cross-org update writes 0 rows but does not throw — without the check, the handler sends `200` with fabricated response data while nothing was written to the DB.

---

## Previous Story Intelligence (Story 2.0)

Story 2.0 is the direct predecessor. Key carry-forward:

- **`ProjectDashboardPreviewSchema`** was defined in `packages/shared/src/schemas/dashboard.ts` with `z.never()` arrays. Story 2.1 must replace those stubs (see AC-10). The web app imports from `@project-vault/shared` — update the shared package first, then `pnpm install` to propagate.
- **File layout established**: `apps/web/src/lib/api/client.ts`, `auth.ts`, `vault.ts` — follow these exact file patterns for the new `projects.ts`.
- **`apiFetch` helper** in `apps/web/src/lib/api/client.ts` handles `credentials: 'include'`, response envelope unwrapping, and error normalization. Import it, do not duplicate.
- **Preview project state** in `apps/web/src/lib/state/preview-project.svelte.ts` is client-only. Now that 2.1 provides real persistence, the "Preview project dashboard" flow in the dashboard page can be replaced by "Create your first project" linking to a real create form, or retained as an exploratory path before committing. Confirm with product before removing the preview path.
- **`packages/shared` workspace dependency** is now in `apps/web/package.json`. No `pnpm install` change needed for the web app — only `packages/shared` source changes are required.
- **Route guard and session refresh** in `hooks.server.ts` was implemented in 2.0. The new dashboard server load operates within the same auth context — no changes to the guard needed.

---

## Git Intelligence Summary

Recent commits on this branch:
- `feature/1-11-secureroute-framework-and-drizzle-rls-middleware` — the SecureRoute framework, RLS middleware, and route-audit CI gate are the exact foundations this story builds on.
- Story 2.0 was created (ready-for-dev) on 2026-06-27 establishing the frontend shell.

Pattern observations:
- All route modules follow `async function xRoutes(fastify: FastifyApp): Promise<void>` export shape.
- Drizzle schema files use `import` not `require`; no barrel re-exports at the module level (only `schema/index.ts`).
- Test files co-located with source in `__tests__/` subdirectories for DB tests; `.test.ts` suffix co-located in module dirs for API tests.

---

## Pre-mortem Failure Modes

| Failure mode | Why it would happen | Prevention |
|---|---|---|
| **RLS policy missing from migration** | Developer creates tables but forgets the `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` block | `check-rls` CI task fails before `migrate`. Run it locally before pushing (AC-3). |
| **route-audit test fails** | New routes not added to `ROUTE_FILES` or `ROUTE_ACTION_CLASSIFICATIONS` | Task 8 explicitly requires updating both files. Run `route-audit.test.ts` in isolation before final PR (AC-9). |
| **`orgId` in POST body accepted** | Developer adds `orgId` to `CreateProjectBodySchema` for convenience | Zod schema must not include `orgId`. Integration test asserts `422` when `orgId` is supplied (AC-13). |
| **Cross-org access returns 403 instead of 404** | Developer adds explicit ownership check and returns "Forbidden" | Dashboard handler query returns 0 rows for wrong-org projects; handler checks row count → 404. Test asserts `404` not `403` (AC-13). |
| **`z.never()` stubs not replaced** | Story 2.0 schema not updated | TypeScript compile error: `upcomingRotations: []` in test data passes `z.never()` but a real item would fail at runtime. AC-10 requires replacing stubs and updating tests. |
| **`getDb()` called inside a SecureRoute handler** | Developer creates service function that calls `getDb()` | Route-audit `DIRECT_DB_ACCESS_CLASSIFICATIONS` check fails in CI. Never call `getDb()` inside a handler — use `tx`. |
| **Slug unique constraint not caught as 409** | `23505` error from Postgres surfaces as unhandled 500 | AC-5 provides the exact catch pattern. Integration test asserts `409` for duplicate slug (AC-13). |
| **Story 2.0 web app does not compile** | `ProjectDashboardPreviewSchema` shape changed incompatibly | Backwards-compat alias `ProjectDashboardPreview = ProjectDashboard` keeps source compatibility. Run `pnpm --filter @project-vault/web typecheck` in Task 11. |
| **Audit FK migration fails** | Existing `audit_log_entries` rows have orphaned `project_id` UUIDs from pre-2.1 tests | AC-3 migration clears orphaned values with `UPDATE ... SET project_id = NULL` before adding the FK. |
| **User deletion breaks after 2.1** | `createdBy NOT NULL` + `onDelete: 'set null'` is a DB contradiction | AC-1 removes `.notNull()` from `createdBy` — projects survive user deletion. |
| **`GET /api/v1/projects` returns duplicate rows in Story 4.1** | Join on `projectId` alone returns N rows per project when N members exist | AC-6 requires `AND project_memberships.user_id = auth.userId` in the join condition. |
| **`isEmpty: true` persists after credentials are added (Story 2.2)** | `isEmpty` was hardcoded `true` instead of computed | AC-7 requires computing `isEmpty` from actual counts from day one. |
| **PATCH returns 200 on cross-org write attempt** | Handler sends response without checking `.returning()` row count | AC-8 requires `.returning()` + row count check → 404 if 0 rows. |
| **`req.body` spread passes orgId or createdBy to Drizzle** | Developer spreads raw body without Zod parse | Mutation schemas use `.strict()`; Anti-Patterns forbids raw `req.body` in Drizzle calls. |
| **Project created/updated without an audit row** | Audit write swallowed or run outside the tx | SecureRoute writes audit in the same tx; failure → rollback + `503`. AC-13 audit-failure rollback tests assert no project row persists when the audit write fails. |
| **Project route returns 500 instead of 503 while sealed** | Handler reached before the vault guard, or guard misordered | The global `vault-guard` `onRequest` hook short-circuits non-allowlisted routes with `503 { status: "sealed" }`; AC-13 sealed-vault tests assert this for all four routes. |
| **Org-wide project visibility silently persists past Story 4.1** | The 2.1 org-scoped default is forgotten when per-project roles land | ADR-2.1-01 + AC-6 record it as an explicit decision requiring re-affirmation/tightening at Story 4.1. |
| **FR97 pagination treated as an oversight** | Reviewer flags missing pagination on the project list | ADR-2.1-06 + AC-6 record the unpaginated list as an accepted, bounded FR97 exception with a revisit trigger (~200 projects / Epic 9). |

---

## ADRs

### ADR-2.1-01: Project access is org-scoped (not project-scoped) in v1

| | |
|---|---|
| **Context** | Story 2.1 introduces `project_memberships` but does not yet enforce per-project RBAC in `SecureRoute`. Story 4.1 adds project-specific membership enforcement. |
| **Decision** | In 2.1, any authenticated org member can read project dashboards (minimumRole: viewer) and create projects (minimumRole: member). Only admin/owner can mutate project metadata (PATCH). `project_memberships` records the creator as owner for future use. |
| **Rationale** | Implementing per-project RBAC in `SecureRoute` requires a `projectRole` resolver that queries `project_memberships` on every request — a significant framework change. For 2.1, org-level role gates provide acceptable access control without requiring 4.1's framework work. |
| **Consequences** | Any authenticated org member can list and view project dashboards for all org projects. **This is an explicit product + security decision (not an accident of the framework), and must be signed off as such:** org-wide project visibility is accepted for v1 because (a) all org members are vetted/trusted, (b) project names/slugs are metadata, not secrets, and (c) credential values are never exposed by project endpoints. The only enforced isolation boundary in 2.1 is cross-org (RLS). **Required action at Story 4.1:** explicitly re-affirm or tighten this to per-project membership scoping before shipping per-project roles; do not let the org-wide default silently persist past 4.1. Cross-referenced in AC-6. |

### ADR-2.1-02: `modules/projects/` handles both project CRUD and per-project dashboard

| | |
|---|---|
| **Context** | Architecture lists `modules/dashboard/` as a separate module. The dashboard data in 2.1 is entirely derived from aggregate counts (currently all zero). |
| **Decision** | Single `modules/projects/` module with four routes. No separate `modules/dashboard/`. |
| **Rationale** | The dashboard at this stage is a thin projection of project state. Separating it adds import/registration surface without benefit. When the dashboard gains real-time SSE streaming and complex queries (Epic 6), splitting off `modules/dashboard/` becomes justified. |
| **Consequences** | Future epic needing `modules/dashboard/` (SSE, cross-project health) will move the `GET /projects/:projectId/dashboard` route. Migration is clean — just update `ROUTE_FILES` in route-audit and `prefix` in `app.ts`. |

### ADR-2.1-03: Slug is validated by Zod regex, not normalized

| | |
|---|---|
| **Context** | Org slugs in `organizations.ts` are also lowercase alphanumeric + hyphens. The auth registration normalizes email to lowercase ASCII. |
| **Decision** | Project slug validation is strict and synchronous: Zod regex `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$|^[a-z0-9]{3}$` rejects anything non-conforming with `422`. No auto-normalization (toLower, trim, replace spaces). |
| **Rationale** | Normalizing slugs silently (e.g., converting `Payments API` to `payments-api`) creates surprising behavior and makes duplicate detection harder. Explicit rejection teaches the caller the constraint once and enforces it on the client side (the web app can derive a slug from the name as a UX suggestion, but the user confirms it). |
| **Consequences** | The web app create-project form should provide a slug suggestion based on the name (toLower + replace spaces with hyphens + strip invalid chars) as a non-binding UX affordance. But the backend always validates the explicit value — never derives from name. |

### ADR-2.1-04: Audit log FK uses `ON DELETE SET NULL` (preserve trail over referential cascade)

| | |
|---|---|
| **Context** | AC-3 adds `fk_audit_project` from `audit_log_entries.project_id` to `projects.id`. The `ON DELETE` behavior was chosen inline without recording why. Three options exist when a project is deleted. |
| **Options** | **A** — `CASCADE`: deleting a project deletes its audit rows. **B** — `RESTRICT`: cannot delete a project while audit rows reference it. **C** — `SET NULL`: project deletion nullifies `project_id` on audit rows, preserving the events. |
| **Decision** | **Option C (`ON DELETE SET NULL`).** |
| **Rationale** | `audit_log_entries` is an append-only, tamper-evident table (per-row keyed HMAC over canonical row fields via `computeAuditHmac`, plus the immutability trigger from migration 0001 — there is **no** prev-row HMAC chaining in current Epic 1 reality). `CASCADE` would let project deletion destroy audit history — unacceptable for a compliance product (Epic 8). `RESTRICT` would make projects undeletable once any audit event references them, breaking Story 4.4 archival. `SET NULL` keeps the event (org_id, actor, timestamp, HMAC intact) while severing the now-dangling project reference. |
| **Consequences** | Audit queries filtering by `project_id` will miss events for deleted projects (their `project_id` is now null). Epic 8 audit-export must account for null `project_id` rows. The HMAC covers the original `project_id` value computed at write time and is never recomputed, so nullifying the column does NOT invalidate the stored HMAC. |

### ADR-2.1-05: `org_id` is denormalized onto `project_memberships` for RLS uniformity

| | |
|---|---|
| **Context** | `project_memberships` references `project_id` (which carries `org_id`), so `org_id` on the membership row is technically derivable via join. AC-2 still adds `org_id` directly via `orgScoped()`. |
| **Options** | **A** — Omit `org_id`; rely on a join to `projects` for org scoping (no RLS policy on memberships, or a policy that subqueries `projects`). **B** — Denormalize `org_id` onto every org-scoped table and apply the standard `current_setting('app.current_org_id')` RLS policy uniformly. |
| **Decision** | **Option B.** Every org-scoped table carries its own `org_id` and its own simple RLS policy. |
| **Rationale** | The architecture mandates a uniform RLS pattern: one `org_id` column + one `USING (org_id = current_setting(...))` policy per table. A subquery-based policy on memberships would be slower (per-row join), harder to audit, and would break the `check-rls-coverage.ts` heuristic (which looks for an `org_id` column + an `ALL` policy). Uniformity is worth the denormalization. |
| **Consequences** | Risk: `project_memberships.org_id` could drift from `projects.org_id` if inserted incorrectly. Mitigation: both are set from the same `auth.orgId` inside one transaction (AC-4). A future hardening could add a composite FK `(project_id, org_id) REFERENCES projects(id, org_id)` to make drift impossible at the DB level — noted as a deferred enhancement (would require a composite unique key on `projects(id, org_id)`). |

### ADR-2.1-06: `GET /api/v1/projects` is unpaginated in v1 — accepted exception to FR97

| | |
|---|---|
| **Context** | AC-6 returns all org projects with no `page`/`limit`. **FR97** mandates pagination on all list endpoints (reaffirmed by the Story 2.3 epic ACs, which paginate the credential list with `page`/`limit`, max 100). The project list deliberately diverges from FR97. |
| **Options** | **A** — Paginate the project list now to comply with FR97 and match the credential list pattern. **B** — Return all projects unpaginated and record an explicit, bounded FR97 exception with a revisit trigger. |
| **Decision** | **Option B** — ship unpaginated and **formally record this as an accepted PRD exception to FR97**, with a hard revisit trigger. This is a deliberate product decision, not an unmet requirement. |
| **Rationale** | Orgs are expected to have tens, not thousands, of projects. Unpaginated keeps the cross-project dashboard simple (no client-side pagination state for the primary nav). The POST rate limit (`max: 20/min`) bounds abusive growth. The cost of full FR97 compliance here (client + server pagination state on the primary nav) is not justified at v1 scale. |
| **Consequences** | An org that creates thousands of projects degrades `GET /api/v1/projects` (full scan, large payload). **Revisit trigger (exception expires):** if any org exceeds ~200 projects, or before the multi-org platform story (Epic 9), FR97 must be honored here. The current `{ items, total }` envelope is forward-compatible — adding `page`/`limit`/`hasNext` to match the Story 2.3 shape is non-breaking. The exception is cross-referenced in AC-6 and AC-16. |

### ADR-2.1-07: Resource response shapes are right-sized per endpoint, not uniform

| | |
|---|---|
| **Context** | The same `project` resource is returned in three shapes: `ProjectDetail` (POST — includes `orgId`, `createdBy`, `archivedAt`), `ProjectSummary` (GET list — adds `credentialCount`/`expiringCount`/`alertCount`, omits `orgId`/`createdBy`), and a minimal subset (PATCH — `id`, `name`, `slug`, `description`, `updatedAt`). |
| **Options** | **A** — Return one canonical `Project` representation everywhere (uniform, REST-purist). **B** — Right-size each response: list gets summary counts, detail gets full metadata, patch echoes only the mutable fields + `updatedAt`. |
| **Decision** | **Option B.** |
| **Rationale** | The list endpoint needs aggregate counts that the detail endpoint should not pay for (count subqueries per project are only acceptable in batch). The PATCH response intentionally omits `orgId`/`createdBy` because they are immutable and irrelevant to a mutation confirmation. Uniform representation would either bloat the list or starve it of counts. |
| **Consequences** | Frontend types must distinguish `ProjectSummary` vs `ProjectDetail` (both exported from `schema.ts`). A consumer wanting full detail after a list must call the detail/dashboard endpoint. This matches the web app flow (list → select → dashboard) naturally. |

### ADR-2.1-08: Cross-project view in v1 is the project list, not an org-wide aggregate endpoint

| | |
|---|---|
| **Context** | The story title is "Cross-Project Dashboard." Epic constraint **AC-E2d** specifies a dashboard showing org-wide aggregates: total credentials, credentials expiring within 30 days (count + list), and projects with overdue rotations. Story 2.1's epic-level ACs define only `GET /api/v1/projects` (per-project list with counts) and `GET /projects/:id/dashboard` (single project). |
| **Options** | **A** — Add a dedicated org-wide aggregate endpoint (`GET /api/v1/dashboard` or similar) now, returning summed totals across all projects. **B** — Treat the per-project list (`GET /api/v1/projects`, each item carrying `credentialCount`/`expiringCount`/`alertCount`) as the v1 cross-project view; the frontend sums client-side if a rollup is shown. Defer a dedicated aggregate endpoint until the underlying data exists. |
| **Decision** | **Option B for Story 2.1.** No dedicated aggregate endpoint. The cross-project surface is the project list; all per-project counts are `0` until Story 2.2+/Epic 3 populate them. |
| **Rationale** | Every aggregate input (credential counts, expiry, rotations) is zero in 2.1 because the backing tables do not exist yet. Building a dedicated aggregate endpoint now would return all-zero data and bake in a shape before the real semantics (e.g., "projects with overdue rotations" needs Epic 5) are known. The per-project list already carries the per-project counts, so a client-side rollup is trivial and forward-compatible. |
| **Consequences** | AC-E2d's dedicated aggregate is **explicitly deferred**, not forgotten — it lands when its data sources exist (Story 2.2 credentials; Epic 3 alerts; Epic 5 rotations). When added, it should be a new endpoint reusing the per-project count semantics, not a reshape of `GET /api/v1/projects`. Documented in AC-16 Out of Scope with the AC-E2d reference. |

---

## References

- Story source: `_bmad-output/planning-artifacts/epics.md#Story-2.1-Project-Creation--Cross-Project-Dashboard`
- Epic 2 epic-level constraints (AC-E2a cross-org search blocker, AC-E2d dashboard scope): `_bmad-output/planning-artifacts/epics.md#Epic-2`
- FR1, FR7, FR8, FR93, FR98 requirements: `_bmad-output/planning-artifacts/prd.md`
- Database schema conventions (`orgScoped`, migration pattern, RLS in same file): `_bmad-output/planning-artifacts/architecture.md#Database-Schema`
- SecureRoute framework and route-audit CI gate: `apps/api/src/lib/secure-route.ts`, `apps/api/src/__tests__/route-audit.test.ts`
- RLS coverage check: `packages/db/src/check-rls-coverage.ts`
- Existing migration RLS pattern: `packages/db/src/migrations/0001_rls_and_triggers.sql`
- `audit_log_entries` FK defer note: `packages/db/src/schema/audit-log-entries.ts` line 12–16
- `orgScoped()` helper: `packages/db/src/schema/helpers.ts`
- `withTestOrg()` for integration tests: `packages/db/src/test-helpers.ts`
- RLS isolation test pattern: `packages/db/src/__tests__/rls-isolation.test.ts`
- `secureRoute()` usage pattern: `apps/api/src/modules/org/routes.ts`
- `validationError()` helper: `apps/api/src/lib/route-helpers.ts`
- `ROUTE_ACTION_CLASSIFICATIONS` and `ROUTE_FILES`: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`
- `apiFetch` client helper: `apps/web/src/lib/api/client.ts`
- Shared package index: `packages/shared/src/index.ts`
- `ProjectDashboardPreviewSchema` (to be promoted): `packages/shared/src/schemas/dashboard.ts`
- Story 2.0 context (preview stub, web app shell): `_bmad-output/implementation-artifacts/2-0-mvp-frontend-shell-and-empty-project-dashboard.md`
- Frontend architecture (SvelteKit route groups, SSR patterns): `_bmad-output/planning-artifacts/architecture.md#Frontend-Architecture`
- UX empty-state and project-centric principles: `_bmad-output/planning-artifacts/ux-design-specification.md`
- Repo TDD rule: `AGENTS.md`

---

## Dev Agent Record

### Agent Model Used

GPT-5.5

### Debug Log References
2026-06-28: Task 1 red-green validation:
- Red: `pnpm --filter @project-vault/db test -- src/schema/projects-schema.test.ts` failed because `projects` and `projectMemberships` exports were undefined.
- Green: added schema files/exports, generated next migration number, replaced broad generated SQL with scoped `0013_projects.sql`, applied migration with owner connection, ran RLS coverage and db tests with app role.
2026-06-28: Task 2 red-green validation:
- Red: `pnpm --filter @project-vault/shared test -- src/schemas/dashboard.test.ts src/schemas/projects.test.ts` failed because `ProjectDashboardSchema`/`EMPTY_PROJECT_DASHBOARD` and `schemas/projects.ts` did not exist.
- Green: promoted dashboard preview schema to `ProjectDashboardSchema`, added typed rotation/access-event items and backwards-compatible aliases, added shared project response schemas and exports.
2026-06-28: Task 3 red-green validation:
- Red: `pnpm exec vitest run src/modules/projects/schema.test.ts --coverage` failed because `apps/api/src/modules/projects/schema.ts` did not exist.
- Green: added API request schemas and response envelopes; focused schema tests pass without coverage. Shared package was rebuilt so API imports resolve the new shared schema exports.
2026-06-28: Tasks 4-8 red-green validation:
- Red: `pnpm exec vitest run src/modules/projects/routes.test.ts --coverage.enabled=false` failed with 404s because the projects routes were not registered.
- Green: added `projectRoutes`, registered them in `app.ts`, added explicit same-transaction audit writes for POST/PATCH, route classifications, project audit event constants, and PATCH MFA exemption. Project route integration tests and route-audit test pass.
2026-06-28: Task 9 validation:
- Added `projects-rls-isolation.test.ts`; `DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm --filter @project-vault/db test -- src/__tests__/projects-rls-isolation.test.ts` passes.
2026-06-28: Task 10 red-green validation:
- Red: `pnpm exec vitest run src/lib/api/projects.test.ts --coverage.enabled=false` failed because `apps/web/src/lib/api/projects.ts` did not exist.
- Green: added typed project API helpers, slug suggestion tests, dashboard/projects server loads, real create-project form, and updated empty-state copy. Focused web tests and web typecheck pass.
2026-06-28: Task 11 final verification:
- Full checks passed: `pnpm --filter @project-vault/db test`, `pnpm --filter @project-vault/api test`, `pnpm --filter @project-vault/shared test`, `pnpm --filter @project-vault/web test`, `pnpm --filter @project-vault/web typecheck`, `pnpm --filter @project-vault/web lint`, `pnpm typecheck`, `pnpm lint`, and `DATABASE_URL=postgresql://postgres:password@localhost:5432/project_vault pnpm check-rls`.
- `pnpm lint` exits 0 with 5 existing script warnings after excluding generated agent asset trees from root lint.

### Completion Notes List
- Task 1 complete: added org-scoped `projects` and `project_memberships` Drizzle schemas, exported them, created scoped `0013_projects.sql` with RLS policies, audit-log `project_id` FK, and project `updated_at` trigger. Migration applied locally with the owner role; db tests pass under `vault_app`.
- Task 2 complete: shared dashboard schema now accepts real rotation/access event item shapes while retaining Story 2.0 aliases; shared project role/detail/summary schemas are exported for API and web use. Shared tests and `pnpm install` completed.
- Task 3 complete: API projects schema module validates create/patch bodies, UUID params, and response envelopes. PATCH treats `slug` as a special immutable field that is accepted and stripped while true unknown keys such as `orgId` still fail validation, reconciling AC-8 with the strict mass-assignment guard.
- Tasks 4-8 complete: project create/list/dashboard/update routes are implemented under SecureRoute with RLS-scoped transactions, duplicate slug handling, owner membership creation, zero-count dashboard/list placeholders, cross-org 404 behavior, and mutation audit entries written in the same transaction.
- Task 9 complete: projects table is covered by app-role RLS integration tests for cross-org isolation, bare-query denial, and per-org slug uniqueness.
- Task 10 complete: web app now lists projects, loads the first project dashboard from the API, provides a real create-project form with slug suggestion and inline conflict handling, and keeps the preview flow explicitly labeled as preview-only.
- Task 11 complete: sealed-vault and audit-failure rollback project route tests pass; full package/root verification passed and story is ready for review.

### File List
- packages/db/src/schema/projects-schema.test.ts
- packages/db/src/schema/projects.ts
- packages/db/src/schema/project-memberships.ts
- packages/db/src/schema/index.ts
- packages/db/src/migrations/0013_projects.sql
- packages/db/src/migrations/meta/_journal.json
- packages/shared/src/schemas/dashboard.test.ts
- packages/shared/src/schemas/dashboard.ts
- packages/shared/src/schemas/projects.test.ts
- packages/shared/src/schemas/projects.ts
- packages/shared/src/index.ts
- apps/api/src/modules/projects/schema.test.ts
- apps/api/src/modules/projects/schema.ts
- apps/api/src/modules/projects/routes.test.ts
- apps/api/src/modules/projects/routes.ts
- apps/api/src/app.ts
- apps/api/src/lib/secure-route.ts
- apps/api/src/lib/route-exemptions.ts
- packages/shared/src/constants/audit-events.test.ts
- packages/shared/src/constants/audit-events.ts
- packages/shared/src/constants/mfa-exempt-routes.test.ts
- packages/shared/src/constants/mfa-exempt-routes.ts
- packages/db/src/__tests__/projects-rls-isolation.test.ts
- packages/db/src/migrations/meta/0013_snapshot.json
- apps/web/src/lib/api/projects.test.ts
- apps/web/src/lib/api/projects.ts
- apps/web/src/routes/(app)/dashboard/+page.server.ts
- apps/web/src/routes/(app)/dashboard/+page.svelte
- apps/web/src/routes/(app)/projects/+page.server.ts
- apps/web/src/routes/(app)/projects/+page.svelte
- apps/web/src/routes/(app)/projects/new/+page.svelte
- apps/web/src/lib/components/dashboard/CrossProjectEmptyState.svelte
- apps/web/src/lib/components/dashboard/dashboard-copy.ts
- apps/web/src/routes/dashboard.test.ts
- apps/web/src/routes/mobile-smoke.test.ts
- eslint.config.mjs
- packages/tsconfig/package.json
- pnpm-lock.yaml

### Change Log
- 2026-06-28: Implemented Story 2.1 project schema, API, shared contracts, web project flow, RLS/audit hardening tests, and final verification; status moved to review.
