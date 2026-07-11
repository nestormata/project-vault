# Story 4.5: Fine-Grained Permissions and Project RBAC

Status: done

<!-- Ultimate context engine analysis completed 2026-07-09. This is an Epic 4 "completion round 2"
     closure story — same pattern as 5-5/6-4/8-6/8-7/9-7/9-8 — bundling two cross-epic security
     deferrals from `deferred-work.md`'s "Security & permissions" table that were never picked up
     despite their target epics landing:
     (a) per-project membership RBAC so org members only see projects they're a member of
         (deferred "to Story 4.1" by Story 2.1's ADR-2.1-01; Story 4.1 shipped the RBAC
         *infrastructure* — `project_memberships`, `project_invitations`, role checks on
         mutations — but never gated *visibility* with it), and
     (b) fine-grained `read:secret_value` vs `read:secret_metadata` (NFR-SEC9, deferred "to Epic
         4+" by Story 2.2's ADR-2.2-03; Epics 4-9 are all done now).
     Epic 4 was reopened `backlog → in-progress` in `sprint-status.yaml` to hold this story.
     Read `_bmad-output/implementation-artifacts/deferred-work.md` § "Security & permissions
     (cross-epic — explicit deferrals)" and the ADRs cited below before coding — this story
     restates everything needed from them so you do not have to open them, but they are the
     traceability source, not `epics.md` (Epic 4 in that file only defines stories 4.1-4.4; this
     story has no epics.md stub, matching 5-5/6-4/8-6/8-7/9-7/9-8's precedent). -->

## Story

As Alex (org admin) managing a growing organization with dozens of projects, and as Jordan (an
org `member` invited to exactly one project as a `viewer` for read-only oversight),
I want project visibility scoped to the projects I actually belong to — not every project in the
org — and I want a project-level `viewer` grant to mean "can see this project's credentials exist
and their history, but cannot reveal a plaintext value or create a new version" —
so that org growth doesn't force every member to wade through irrelevant projects, and so that a
narrowly-scoped grant (an auditor, a read-only contractor, a teammate added to one project only)
is actually narrow, instead of any `member`+ org role silently being able to reveal every secret
in every project in the org regardless of which projects they were ever actually added to.

*Closes: `deferred-work.md` § "Security & permissions (cross-epic — explicit deferrals)" —
row "Fine-grained `read:secret_value` vs `read:secret_metadata` (NFR-SEC9)" and row "Per-project
membership RBAC (all org members see all projects)".*
[Source: `_bmad-output/implementation-artifacts/deferred-work.md#Security-permissions-cross-epic-explicit-deferrals`]

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — the API changes (visibility filtering, the new project-role reveal gate) are the bulk of the work; the web UI needs **zero** code changes for the project list/dashboard (they already render whatever `GET /api/v1/projects` / `GET /api/v1/projects/:projectId/dashboard` return — scoping happens entirely server-side, AC-V2/AC-V3), but the credential-reveal 403 path (AC-P2) needs a small web-side error-message check (AC-P7) so a project-`viewer` sees an honest "you don't have permission to reveal this value" message instead of a generic error. |
| **Evaluator-visible** | yes — every org member with 2+ projects, and every project-scoped `viewer` grant, sees different (correct, narrower) behavior after this story. |
| **Linked UI story** (if API-only) | N/A — the one small web-side fix (AC-P7) ships in this story. |
| **Honest placeholder AC** (if UI deferred) | N/A. |
| **Persona journey** | See below. |

### Persona journey stub

**Alex (org admin, 40 projects in the org):** Before this story, Alex's `GET /projects` view
(and every other org member's) lists all 40 projects regardless of involvement — noisy, and a
minor least-privilege gap the org has been accepting since Story 2.1 (ADR-2.1-01). After this
story, Alex — as an org **admin** — still sees all 40 (org owner/admin retain unconditional
visibility, AC-V8, matching the existing org-owner-override precedent from Story 4.4's archival
guards and Story 4.2's member-management checks). Nothing changes for Alex's day-to-day.

**Priya (org `member`, added to 3 of the 40 projects via project invitations over time):** Before
this story, Priya's `GET /projects` also lists all 40 — she has to scroll past 37 projects she has
never touched to find the 3 she actually works on. After this story, Priya's list shows exactly
those 3 (AC-V2) — nothing she previously could reach is gone, because she already held explicit
`project_memberships` rows for all 3 (created automatically when she accepted each invitation,
Story 4.1). No migration risk for Priya: this is a pure UX improvement.

**Jordan (org `member`, added to exactly one project — "Payments API" — as a project `viewer` by
that project's owner, for read-only oversight during an audit):** Before this story, Jordan's org
`member` role means Jordan can call `GET .../credentials/:id/value` on *any* credential in *any*
of the org's 40 projects and get the plaintext back — the project-level `viewer` grant Jordan was
actually given is currently decorative for secret access (it only matters for archive/transfer/
member-management, which Jordan was never going to attempt). After this story, Jordan can list
Payments API's credentials and view their version history (unchanged — metadata reads stay
`viewer`-gated as before), but `GET .../value` and `POST .../versions` now return
`403 insufficient_project_role` for Jordan specifically in Payments API, because Jordan's
*effective* role there is the project role (`viewer`), not the org role (`member`) — this is the
actual, enforced meaning of NFR-SEC9's `read:secret_value` vs `read:secret_metadata` split. Jordan
sees a clear "You don't have permission to reveal this credential's value" message in the web UI
(AC-P7) instead of the plaintext.

**Riley (org `member`, never added to any project):** Before this story, Riley's org-wide
dashboard, search, and project list already showed all 40 projects (same as everyone else). After
this story, Riley sees zero projects until explicitly invited to one — this is intentional
tightening, not a bug (AC-V7's backfill migration does **not** grant Riley retroactive access,
because Riley never had a `project_memberships` row and never went through an invitation; Riley's
pre-story access was itself the exact gap this story closes).

---

## Background: What Already Exists (Read Before Coding)

**Read this section before writing any code — it corrects several assumptions the deferred-work
entries and the story-creation task itself made, based on direct verification of the shipped
code.** This story is narrower than "build project RBAC from scratch": Story 4.1 already shipped
the entire membership/role/invitation *mechanism*. The actual gap is that nothing *reads* it for
visibility or for secret-value-vs-metadata authorization yet.

### `project_memberships` is NOT vestigial — it is actively used, just not for visibility

Direct grep of every reference confirms `project_memberships` (`packages/db/src/schema/project-memberships.ts`)
is populated and read by:

- **Project creation** (`apps/api/src/modules/projects/routes.ts:267-272`) — creator becomes
  `owner`.
- **Project-invitation acceptance** (`apps/api/src/modules/invitations/token-routes.ts:164-172`) —
  invitee gets the invited role; the org membership they also receive (D5, Story 4.1) is
  unconditionally `'member'` regardless of the invited project role.
- **Member management** (`apps/api/src/modules/projects/routes.ts` — `callerCanManageMembers`,
  `GET`/`DELETE .../members`) — project admin/owner OR org admin/owner may view/remove members.
- **Archive/unarchive authorization** (`callerArchiveAuthorization`, ADR-4.4-05) — project owner OR
  org owner (not admin) may archive.
- **Ownership transfer** (`resolveTransferTargets`) — project owner OR org owner.
- **Org-admin project-role changes** (`apps/api/src/modules/org/routes.ts:563-678`,
  `PUT /org/users/:userId/projects/:projectId/role`) — requires the target **already** be a
  project member (`404 membership_not_found` otherwise) — this is a role-*change* endpoint, not an
  add-member endpoint (see Open Question 1).
- **The list query's `role` column** (`projects/routes.ts:356-406`) — a `LEFT JOIN` on
  `project_memberships` for the caller, falling back to the caller's **org role** when no
  membership row exists: `role: (row.role ?? secureCtx.auth.orgRole) as ...`. This fallback is the
  load-bearing idiom this story reuses for the new effective-role resolution (AC-P1).

**What's actually missing:** nothing reads `project_memberships` (or its absence) to *gate*
whether a caller can see a project or its credentials at all, or to *restrict* value-reveal below
what org role alone would grant. Every project-scoped GET route today is gated only by **org**
role (`minimumRole: 'viewer'`/`'member'`) plus org-scoped RLS (cross-org isolation) — verified by
direct inspection of every route below.

### Confirmed: `GET /api/v1/projects` returns every org project regardless of membership

```349:404:apps/api/src/modules/projects/routes.ts
      const listWhere = includeArchived ? undefined : isNull(projects.archivedAt)
      // ...
      const rows = await secureCtx.tx
        .select({ id: projects.id, name: projects.name, slug: projects.slug,
          description: projects.description, role: projectMemberships.role,
          createdAt: projects.createdAt, archivedAt: projects.archivedAt })
        .from(projects)
        .leftJoin(projectMemberships, and(
          eq(projectMemberships.projectId, projects.id),
          eq(projectMemberships.userId, secureCtx.auth.userId)
        ))
        .where(listWhere)
        .orderBy(desc(projects.createdAt))
        .limit(pagination.limit)
        .offset(offset)
      // ...
      role: (row.role ?? secureCtx.auth.orgRole) as 'owner' | 'admin' | 'member' | 'viewer',
```

The `LEFT JOIN` (not `INNER JOIN`) means a row with no membership still appears, with `role`
falling back to the org role. This is exactly the behavior ADR-2.1-01 documented as an explicit,
temporary v1 decision requiring "re-affirm[ation] or tighten[ing]... before shipping per-project
roles" at Story 4.1 — which shipped the roles but never revisited this query.

### Confirmed: every other project-scoped route has the identical gap

| Route | Current gate | Gap |
|---|---|---|
| `GET /projects/:projectId/dashboard` | org role `viewer` floor only | no membership check at all — any org member sees any project's dashboard |
| `GET /projects/:projectId/credentials` | org role `viewer` floor | same |
| `POST /projects/:projectId/credentials` | org role `member` floor | same — a `member` with **zero** project involvement can create credentials in any project |
| `GET .../credentials/:id`, `.../versions`, `.../dependencies` | org role `viewer` floor | same |
| `GET .../credentials/:id/access` | org role `owner`/`admin` floor (already excludes member/viewer) | **not gapped** — already unreachable by member/viewer regardless of this story; excluded from AC-V4's gate as dead-code-avoidance, not an oversight |
| `GET .../credentials/:id/value` (reveal) | org role `member` floor | same, **and** no project-role downgrade (NFR-SEC9 gap) |
| `POST .../credentials/:id/versions` | org role `member` floor | same |
| `PUT .../credentials/:id/tags`, `PATCH .../credentials/:id`, `.../dependencies` (POST/DELETE) | org role `member` floor | same |
| `GET /api/v1/search` (Story 2.7, `apps/api/src/modules/search/service.ts`) | org role `viewer` floor | `searchProjects`/`searchCredentials` query every org project with no membership filter |
| `GET /api/v1/dashboard` (org-wide, `apps/api/src/modules/dashboard/routes.ts` → `getOrgDashboardData`) | org role `viewer` floor | `expiringWithin30Days.items`/`projectsWithOverdueRotations.items` name credentials **and** projects across the whole org |

**Explicitly out of scope, tracked not silently skipped** (grepped, confirmed project-scoped but
NOT touched by this story — a future story should extend the same helper to these):
`modules/monitoring/status-page-service.ts` and the certs/domains/service-endpoints routes
(services/certificates/domains CRUD, Story 6.1-6.3), `modules/machine-users/*` (Story 7.1/7.2),
`modules/rotation/*` (Story 5.x). All of these already do their **own** project-role check for
*mutations* in some cases (e.g. `status-page-service.ts` reuses `callerProjectRole` per
ADR-6.3-07) but share the identical **visibility** gap on their GET/list routes. Doing all of them
in one story risks an inconsistent, rushed rollout across ~6 unrelated modules; this story fixes
the two highest-blast-radius surfaces named in `deferred-work.md` (project visibility itself, and
secret-value access) plus the org-wide aggregate surfaces (dashboard, search) that leak the same
information a different way. **Do not silently expand scope to these other modules** — if you
notice a quick win, note it in Dev Agent Record instead of fixing it, so a follow-up story can
scope it deliberately (matching this story's own origin).

### RLS is not the enforcement layer for this — confirmed via `check-rls-coverage.ts`

```47:82:packages/db/src/check-rls-coverage.ts
export async function checkRlsCoverage(sql: postgres.Sql): Promise<void> {
  // ...finds every table with an org_id column, asserts every one has an RLS policy...
```

RLS in this codebase is purely **org**-scoped (`org_id` column + `USING (org_id = current_setting('app.current_org_id')...)`
policy, `apps/api/src/middleware/rls.ts`'s `setRlsOrgContext`). `project_memberships` already has
its own org-scoped RLS policy (added when the table was created; it is not in
`check-rls-coverage.ts`'s `EXCLUDED_TABLES`) — that policy is unrelated to and unaffected by this
story. **Project-level scoping has never been an RLS concern in this codebase** — every existing
project-role check (archive, member-management, ownership transfer) is enforced at the
application/query layer via an in-handler helper call, not a database policy. This story follows
that exact, established convention: no new RLS policy, no migration to `check-rls-coverage.ts`.
The new visibility/effective-role checks are ordinary in-handler helper calls, architecturally
identical to `rejectIfProjectArchived`/`callerProjectRole`/`callerCanManageMembers`.

### Who grants/revokes project membership — reused unchanged, with one flagged gap

Story 4.1's invitation flow (create → email → accept, `modules/invitations/`) and Story 4.2's
`PUT /org/users/:userId/projects/:projectId/role` (change an *existing* member's project role) are
the only two ways `project_memberships` rows are created or changed today, alongside project
creation (auto-owner) and this story's one-time backfill (AC-V7). **This story adds no new
grant/revoke endpoint** — see Open Question 1 for the gap this creates.

---

## Key Design Decisions (read before coding — these are the load-bearing calls this story makes)

### D1 — Visibility default: org owner/admin bypass; org member/viewer require a `project_memberships` row

**Decision:** A caller can see/act on a project if **either** (a) their org role is `owner` or
`admin`, **or** (b) they hold a `project_memberships` row for that project (any role). Org
`member`/`viewer` with no row for a given project cannot see it, list its credentials, or act on
it at all (`404`, not `403` — see D3).

**Rationale:** Matches the *already-established* precedent in this exact codebase:
`callerCanManageMembers` already treats "project admin/owner OR **org** admin/owner" as
equally authorized for member management; `callerArchiveAuthorization` treats "project owner OR
**org owner**" as equally authorized for archive (ADR-4.4-05's explicit "org owners retain
authority over every project in their org even without a membership row" language — this story
extends that same override to `admin`, matching the member-management precedent's admin+owner
grouping rather than archive's owner-only one, because visibility is a much lower-stakes action
than archival). This is also the only design that makes the backward-compat migration (D2)
tractable — see below.

### D2 — Backward compatibility: role-based default + one-time backfill, not an opt-in setting

**The three options considered** (per this story's own creation brief): (a) opt-in org setting,
(b) role-based default (owner/admin see all; member/viewer scoped), (c) one-time backfill
preserving current access on migration day.

**Decision: (b) + (c) together.** Org owner/admin get the unconditional bypass (D1) —
this needs no migration, it's a permanent rule. For org member/viewer, a new migration
(`0043_project_membership_visibility_backfill.sql`, AC-V7) inserts a `project_memberships` row
with **role `'viewer'`** for every `(project, org member)` pair where the org member's role is
`member` or `viewer` **and no row already exists**, scoped per-org, `ON CONFLICT DO NOTHING`.
Going forward (new projects, new org members, or org members added to *existing* projects after
migration day), visibility requires an explicit, real `project_memberships` row — no more
automatic org-wide visibility.

**Rejected: (a) opt-in setting.** An org-level toggle ("scope project visibility: yes/no") adds a
new settings surface, a new default-value migration debate, and a permanent code fork (two
behaviors to maintain forever) to solve a problem (backward compatibility) that a one-time,
one-way migration already solves cleanly. Nothing in `deferred-work.md`, ADR-2.1-01, or the
current settings model (`system-settings.ts` is platform-wide, `organization-settings-routes.ts`
is a small fixed set of toggles) suggests per-org configurability was ever the intended shape —
ADR-2.1-01 explicitly frames this as something to "tighten," not make optional.

**Why the backfill role is `'viewer'`, not the member's org role:** `'viewer'` is deliberately
the *lowest* project role, so the backfill **only** restores what this story is removing
(visibility) and grants **no new capability**. Because `'viewer'` project role has never
unlocked anything beyond the org-role floor for archive/member-management/ownership-transfer
(those checks look for project role `owner`/`admin` specifically, which `'viewer'` never
satisfies), and because value-reveal's *new* project-role gate (D4/AC-P2) treats a present project
role as authoritative regardless of org role, backfilling `'viewer'` does not accidentally
*downgrade* anyone's reveal capability either — see the worked proof in AC-P5.

**Why this is safe against ADR-2.1-01's own stated rationale:** ADR-2.1-01 justified 2.1's org-wide
default on "(a) all org members are vetted/trusted, (b) project names/slugs are metadata not
secrets, (c) credential values are never exposed by project list/dashboard endpoints." Backfilling
visibility (not any new write capability) for existing members preserves exactly what those three
points already justified as low-risk, while D1's going-forward tightening is the "required action
at Story 4.1" ADR-2.1-01 asked for and never got.

### D3 — Visibility denial is `404`, not `403`

**Decision:** a member/viewer with no `project_memberships` row for a project gets the exact same
`404 project_not_found` response as a cross-org request, for every route this story touches.

**Rationale:** matches the *existing, documented* anti-pattern table from Story 2.1
(`2-1-project-creation-and-cross-project-dashboard.md:1457`: *"Cross-org access returns 403
instead of 404 | Dashboard handler query returns 0 rows for wrong-org projects; handler checks row
count → 404"*). A `403` would let a member enumerate which project IDs exist in their own org
(distinguishing "exists but I can't see it" from "doesn't exist") even though they can't see
the content — `404` gives no such signal, consistent with how this codebase already treats
cross-org access. This intentionally differs from the *mutation-authorization* 403s already in
this file (`insufficient_role` for archive/transfer) — those are for actions on a project the
caller can already see happens to exist; this is about not being able to see it in the first
place.

### D4 — The NFR-SEC9 split: effective role = project role (if present) else org role, project role never widens beyond org-role floor for owner/admin

**Decision:** define `effectiveProjectRole(caller, projectId)`:

```
if caller.orgRole is 'owner' or 'admin': effectiveRole = caller.orgRole   (unconditional — D1's bypass)
else: effectiveRole = projectRole(caller, projectId) ?? caller.orgRole
```

`GET .../credentials/:id/value` and `POST .../credentials/:id/versions` (exactly the two routes
ADR-2.2-03 grouped together as "value reveal + version creation require member") now require
`roleRank(effectiveRole) >= roleRank('member')` instead of just the org-role floor. Every other
credential route (list, detail, version-history, dependencies, access-list, tags, lifecycle PATCH)
is **unaffected** — they stay gated by org role only, exactly as ADR-2.2-03 originally split
"metadata/version reads require viewer" from "value reveal + version creation require member."
This story enforces the *value* half of that split at finer-than-org-role granularity; the
*metadata* half was already correctly enforced and needs no change.

**Why this is the "natural extension" the story-creation brief asked for:** it reuses the *exact*
`row.role ?? secureCtx.auth.orgRole` fallback idiom already shipped in `projects/routes.ts`'s list
query, and the exact `getProjectMembershipRole`/`roleRank` helpers already used by every other
project-role check in this codebase. No new permission-scope framework, no new table, no new
concept — a project role, once D1 makes it load-bearing for visibility, is simply also consulted
for this one additional, already-role-ranked decision.

**Consequence, worked through:** once D1 ships, an org `member`/`viewer` can only ever reach a
credential route for a project where they hold a `project_memberships` row (D1's visibility gate
runs first — see Task ordering). So for org `member`/`viewer`, `effectiveProjectRole`'s
`?? caller.orgRole` fallback is **dead in practice** — a `project_memberships` row is guaranteed
to exist by the time they reach this check. It exists in the type signature only as a defensive
default for the (documented, deliberately out-of-scope) modules this story does not touch —
see AC-P5's regression proof. Org owner/admin, by contrast, never need a row (D1's bypass) and
their `effectiveRole` is always their (unrestricted) org role — an org admin's reveal capability
is unaffected by this story, by design (D1's bypass applies uniformly to visibility *and* reveal).

### D5 — No new grant/revoke endpoint; reuse 4.1/4.2's model as-is (Open Question 1 flags the resulting gap)

**Decision:** this story does not add a "directly add an existing org member to a project"
endpoint. Grant flows stay: project creation (auto-owner), project-invitation accept (Story 4.1),
and `PUT /org/users/:userId/projects/:projectId/role` for *changing* an existing membership's role
(Story 4.2 — requires the row to already exist). This story's job is to make the existing model's
membership rows *mean something for visibility and reveal*, not to add new ways to create them.

---

## Acceptance Criteria

### Group V — Project visibility scoped to membership (ADR-2.1-01 closure)

**AC-V1 — New shared helper resolves visibility per D1.**
**Given** the new module `apps/api/src/modules/projects/project-access.ts`,
**When** it exports `async function callerCanSeeProject(secureCtx: SecureRouteContext, projectId: string): Promise<boolean>`,
**Then** it returns `true` unconditionally when `secureCtx.auth.orgRole` is `'owner'` or `'admin'`
(no query needed); otherwise it calls the existing `getProjectMembershipRole()`
(`modules/projects/member-management.ts`) with `{ orgId: secureCtx.auth.orgId, projectId, userId: secureCtx.auth.userId }`
and returns `true` iff a row was found (any role), `false` otherwise.

**Example (positive — org admin, no membership row):** `secureCtx.auth.orgRole = 'admin'`,
no `project_memberships` row for this user/project → `true`, zero DB queries.

**Example (positive — org member, has a row):** `secureCtx.auth.orgRole = 'member'`, a
`project_memberships` row exists with role `'viewer'` → `true`.

**Example (negative — org member, no row):** `secureCtx.auth.orgRole = 'member'`, no row →
`false`.

---

**AC-V2 — `GET /api/v1/projects` (list) filters to visible projects for member/viewer callers; unchanged for owner/admin.**
**Given** the existing query at `projects/routes.ts:349-404` (cited above),
**When** `secureCtx.auth.orgRole` is `'member'` or `'viewer'`,
**Then** the `.leftJoin(projectMemberships, ...)` becomes an `.innerJoin(projectMemberships, ...)`
for these two roles only (owner/admin keep the existing `leftJoin` + `role ?? orgRole` fallback
unchanged) — implement via a small branch (build the query with `leftJoin` or `innerJoin` based on
`roleRank(secureCtx.auth.orgRole) >= roleRank('admin')`, sharing every other clause). The `total`
count query (lines 351-354) must apply the identical join/role condition, or pagination metadata
(`total`) will disagree with the `items` actually returned for member/viewer callers.

**Example (positive — member with 3 memberships out of an org of 40 projects):** `GET /api/v1/projects`
→ `{ data: { items: [...3 projects...], page: 1, limit: 20, total: 3, ... } }` — not 40.

**Example (edge — member with zero memberships):** `GET /api/v1/projects` → `{ data: { items: [], total: 0, ... } }`, `200`, not an error — mirrors the existing "user with no projects" case already documented in Story 2.1.

**Example (regression — org owner, unaffected):** identical `leftJoin` behavior as today; owner
with 40 projects, 2 of which they hold no explicit membership row for → still sees all 40, `role`
falls back to `'owner'` on those 2 exactly as today.

---

**AC-V3 — `GET /projects/:projectId/dashboard` returns `404 project_not_found` for member/viewer callers with no membership row.**
**Given** the existing handler (`projects/routes.ts:408-436`), which today only checks the project
row exists (cross-org 404) with no membership check at all,
**When** the project exists (same org) but `await callerCanSeeProject(secureCtx, params.projectId)`
returns `false`,
**Then** return `reply.status(404).send(PROJECT_NOT_FOUND)` — the exact same shape as the
existing cross-org 404, before computing any dashboard data (do not leak dashboard aggregates via
timing or partial-response differences).

**Example (positive — member with a row, role `viewer`):** dashboard loads normally, response
unchanged from today.

**Example (negative — member, no row):** same org, project exists → `404 project_not_found`
(previously `200` with full dashboard data — this is the exact behavior this story changes).

**Example (regression — org admin, no row):** `callerCanSeeProject` short-circuits `true` via D1
— dashboard loads normally, unaffected by this story.

---

**AC-V4 — Every project-scoped credential route gains the same visibility gate, EXCEPT the two
routes already `owner`/`admin`-only.**
**Given** every route registered in `credentialRoutes()` (`modules/credentials/routes.ts`) that
takes a `:projectId` param, verified by direct count against the real file (15 total; corrects an
earlier miscount of "11"): `GET /credentials`, `POST /credentials`, `POST /credentials/import`,
`POST /credentials/import/confirm`, `GET /credentials/:id`, `GET /credentials/:id/value`,
`POST /credentials/:id/versions`, `GET /credentials/:id/versions`, `POST`/`GET`/`DELETE
.../dependencies` (3), `PATCH /credentials/:id`, `PUT /credentials/:id/tags`, `PATCH
/credentials/:id/tags` (append-mode; shares `handleCredentialTagUpdate()` with the `PUT` route
above, so fixing `PUT` fixes this one too — 13 routes needing the new gate, not 15, once this
shared-handler pair is counted once) — **EXCLUDING `GET /credentials/:id/access`, which is
already `allowedRoles: ['owner','admin']`-gated today** and therefore already unreachable by any
`member`/`viewer` caller regardless of this story; adding the new visibility check there would be
provably dead code (D1's owner/admin bypass makes it unconditionally `true` for the only callers
who can ever reach the handler) — **do not add the gate to this route**,
**When** a member/viewer caller has no `project_memberships` row for `params.projectId`,
**Then** every one of the 13 routes above returns `404` with the existing not-found body for that
route (`PROJECT_NOT_FOUND` for project-level 404s already returned elsewhere in this file, or the
route's own `CREDENTIAL_NOT_FOUND` if the route's existing not-found convention is
credential-scoped — pick whichever body the route already sends for "not found" so this change
is invisible in shape, only in *when* it now fires) — implement via one shared call inserted at
the top of each handler (immediately after `parseParams`, before any DB query), not by touching
each route's individual query logic. **Do not skip this for `POST /credentials`,
`PUT`/`PATCH .../tags`, `PATCH .../credentialId`, or the dependency mutation routes** — today they
have literally zero project-membership check (only org-role + archived-project checks), so a
`member` with no project involvement can currently create/modify credentials in a project they
cannot even list. The two import routes are already `owner`/`admin`-only today (same reasoning as
`/access`'s exclusion above) — adding the gate there is harmless (D1's bypass makes it a no-op for
their only reachable callers) but not required for security; include them anyway for consistency
since a future story could loosen their role gate and silently reintroduce the gap otherwise. This
is the same D1 gate as AC-V3, just applied to twelve additional routes (13 total minus the
already-counted `PUT`/`PATCH` tags pair); there is exactly one new helper (AC-V1), reused
throughout.

**Example (positive — member, has a row, creating a credential):** `POST /projects/:id/credentials`
→ `201`, unchanged.

**Example (negative — member, no row, attempting to create a credential in a project they cannot list):**
`POST /projects/:id/credentials` → `404 project_not_found` (previously `201` — this closes the
write-side gap that AC-V2/AC-V3's read-side fix alone would not have closed).

**Example (regression — org admin, no row, any of the gated routes):** unaffected by D1's bypass.

**Example (regression — `GET .../credentials/:id/access`, any role):** unchanged by this AC
entirely — still gated solely by its pre-existing `allowedRoles: ['owner','admin']` check, exactly
as today.

---

**AC-V5 — Cross-project search (`GET /api/v1/search`, Story 2.7) filters project and credential results to visible projects for member/viewer callers.**
**Given** `apps/api/src/modules/search/service.ts`'s `countProjects`/`searchCredentials`/project-search
queries, which today match against `projects.orgId = orgId` with no membership filter,
**When** the caller's org role is `member` or `viewer`,
**Then** every query in this file that reads from `projects` or joins through it to `credentials`
adds an `innerJoin`/`exists` condition against `project_memberships` for the caller (mirroring
AC-V2's join-swap approach) — owner/admin queries are unchanged. A search result must never
surface a project name, slug, or credential name/tag from a project the caller cannot see via
AC-V2's rule.

**Example (positive — member searching "api", 3 of their 5 visible projects match):** results
include only those 3 projects' matches, even if 10 other org projects also match "api" in name.

**Example (regression — org admin searching):** unaffected, sees matches across all 40 projects
as today.

---

**AC-V6 — Org-wide dashboard (`GET /api/v1/dashboard`) scopes its project-identifying lists to visible projects for member/viewer callers; `unresolvedAlertCount` is explicitly exempt.**
**Given** `getOrgDashboardData()` (`modules/projects/dashboard-stats.ts:197-252`), whose
`totalCredentials`, `expiringWithin30Days` (count + items naming credential/project), and
`projectsWithOverdueRotations` (count + items) today aggregate across every org project,
**When** the caller's org role is `member` or `viewer`,
**Then**:
- `totalCredentials` and `expiringWithin30Days.count`/`.items` are computed only over projects the
  caller can see, via a direct SQL join/filter against `project_memberships` (mirroring AC-V2's
  join-swap approach) — both are built from direct SQL against `credentials`/`projects` at this
  call site, so a join-level fix applies cleanly here.
- `projectsWithOverdueRotations.count`/`.items` requires a **different fix shape, not a SQL join**:
  this field is built from `computeUpcomingRotations(tx, { horizonDays: 0 })`
  (`modules/rotation/service.ts`), whose `opts.projectId` parameter only ever accepts a single
  project ID (not a set) and whose `UpcomingRotationResult` return shape has no `projectId` field
  at all — there is no SQL join available at this call site to scope it directly. Instead: first
  compute the caller's visible-credential-ID set (the same membership-filtered credential query
  this AC already needs for `totalCredentials` above, minus the count/aggregation — just the raw
  `credentials.id` set), then post-filter `computeUpcomingRotations`'s already-fetched, already
  org-wide result array by `activeCredentialIds.has(result.credentialId)` against that set, **before**
  the existing `.filter((r) => r.status === 'overdue')` and `.slice(0, 20)` steps (`dashboard-stats.ts`
  line ~231-232) — do not attempt to add a `projectId` filter parameter to
  `computeUpcomingRotations` itself or change `UpcomingRotationResult`'s shape; both are shared by
  other call sites (e.g. the per-project dashboard, `GET .../rotations/upcoming`) and an
  unnecessary signature change risks regressing them for no benefit, since a plain post-filter on
  the already-materialized JS array accomplishes the same scoping with zero SQL changes.

**`unresolvedAlertCount` is NOT scoped** — `security_alerts` has no
`project_id` column at all (ADR-3.4-01/02, pre-existing, ADR predates this story and is out of
scope to change) so it is fundamentally not project-scoped; it stays org-wide for every caller,
unchanged. Document this exemption inline where `getOrgDashboardData` is implemented so a future
reader does not mistake it for an oversight.

**Example (positive — member visible in 3 of 40 projects, one has a credential expiring in 10 days):**
`expiringWithin30Days.count = 1`, `items` contains that one credential/project pair — even if 5
other (invisible-to-this-caller) org projects also have credentials expiring within 30 days.

**Example (regression — `unresolvedAlertCount`):** identical org-wide value regardless of caller's
visible-project set — e.g. `5` for both an org admin and a member visible in only 1 project.

**Example (regression — org admin):** all four fields unchanged, org-wide as today.

---

**AC-V7 — One-time backfill migration preserves current visibility for existing member/viewer org members (D2).**

**Cross-story coordination (do not skip):** as of 2026-07-09, TWO sibling stories from the same
reconciliation batch *also* target migration index 43: `3-5-credential-expiry-notification-delivery`
(`0043_credential_expiry_alerts.sql`) and `1-13-infra-and-process-hardening`
(`0043_normalize_tag_case.sql`), for the same `packages/db/src/migrations/` directory. All three
stories were drafted in parallel worktrees and none reserves the number — whichever of
4-5/3-5/1-13 is implemented (and merged to `main`) **first** keeps `0043`; the second keeps
whatever the real next free number is at that time (likely `0044`); the third similarly takes the
next free number after that (likely `0045`). Re-check
`packages/db/src/migrations/meta/_journal.json`'s actual highest `idx` at implementation time and
renumber this migration file, its `--> statement-breakpoint` tag, and every in-file reference below
accordingly if `0043` is not actually free.

**Given** a new migration file `packages/db/src/migrations/0043_project_membership_visibility_backfill.sql`
(number per the coordination check above — may need to be `0044` or higher if 3-5 landed first;
next free number per `meta/_journal.json`'s actual highest `idx` at implementation time), registered in
`meta/_journal.json` following the exact existing entry shape (`idx: 43`, next sequential
`when` timestamp, `tag: "0043_project_membership_visibility_backfill"`, `breakpoints: true`),
**When** the migration runs,
**Then** it executes (per org, or a single cross-org statement scoped by matching `org_id` columns
directly — no RLS session context is available inside a migration, so do not rely on
`app.current_org_id`; write the `INSERT ... SELECT` with an explicit `org_memberships.org_id =
projects.org_id` join condition instead):

```sql
INSERT INTO project_memberships (org_id, project_id, user_id, role)
SELECT p.org_id, p.id, om.user_id, 'viewer'
FROM projects p
JOIN org_memberships om ON om.org_id = p.org_id
WHERE om.role IN ('member', 'viewer')
ON CONFLICT (project_id, user_id) DO NOTHING;
```

and the migration is a pure data migration (no schema/DDL change) — verify it is **not** flagged
by Story 9.3's `migration-safety.ts` destructive-statement guard (a plain `INSERT` is not
destructive; confirm by running `make db-migrate` locally and checking the guard does not reject
it — if it does, the guard's own allowlist needs a narrow addition, do not weaken the guard
generally).

**Example (positive — pre-existing org, 40 projects, 15 members with no explicit membership row):**
after migration, all 15 gain a `'viewer'` row on every project they lacked one for — their
`GET /api/v1/projects` list is unchanged (still shows all 40) on the day the migration runs, even
though AC-V2 is now enforced.

**Example (edge — a member who already has an explicit `'member'` role on 3 of 40 projects, via a
real Story 4.1 invitation):** the migration's `ON CONFLICT DO NOTHING` skips those 3 rows entirely
— their real `'member'` role is preserved, not downgraded to `'viewer'`. They gain backfilled
`'viewer'` rows on the other 37.

**Example (edge — a project with zero members besides the creator-owner, in an org with 50 other
members who are all `viewer`):** all 50 gain a backfilled `'viewer'` row on that one project too —
the backfill is genuinely per-`(project, member)` pair, not scoped to "active" projects only, and
runs even for archived projects (visibility, not mutation, is what's being preserved; an archived
project's `archivedAt` is irrelevant to this migration).

---

**AC-V8 — Regression: org owner/admin visibility and mutation authority are completely unaffected by this story.**
**Given** every AC above,
**When** the caller's org role is `owner` or `admin`,
**Then** `GET /projects`, `GET /projects/:id/dashboard`, every credential route, `GET /search`, and
`GET /dashboard` all behave **identically** to their pre-story behavior — same items, same counts,
same 404/403 conditions triggered only by the *pre-existing* checks (archived-project, cross-org,
etc.), never by the new D1 visibility gate. Write one integration test per surface (list,
dashboard, one representative credential route, search, org-dashboard) asserting an org
admin with **zero** `project_memberships` rows anywhere still sees full data on all five.

**Example (positive):** an org admin seeded directly with `orgRole: 'admin'` (this codebase has no
shipped API path that ever promotes an existing user to org `'admin'` — org role is set only at
registration (`'owner'`) or invitation-acceptance (`'member'`, unconditionally, per Story 4.1's D5;
Story 4.2's project-role-change endpoint changes a *project* role, not the org role — do not
conflate the two in this test's setup), with **zero** `project_memberships` rows anywhere,
immediately sees all of the org's projects and can reveal any credential's value in any of them —
day one, no membership rows needed, regardless of how that `orgRole: 'admin'` row came to exist.

---

**AC-V9 — Regression: RLS coverage and cross-org isolation are unaffected.**
**Given** `packages/db/src/check-rls-coverage.ts` and the existing multi-org isolation test suite
(`apps/api/src/__tests__/multi-org-session-isolation.test.ts`),
**When** this story's changes land,
**Then** `make check-rls` passes with no new entries needed in `EXCLUDED_TABLES` (this story adds
no new org-scoped table and no new RLS policy — `project_memberships`'s existing policy is
untouched), and the existing multi-org isolation suite passes unmodified — this story only ever
narrows *within-org* visibility for `member`/`viewer`, it never touches the *cross-org* boundary
RLS already enforces for every role.

**Example (regression):** a user in Org A, `member` role, with a `project_memberships` row for a
project in Org A, still gets `404` (not data leakage) when guessing a project ID that belongs to
Org B — unchanged, enforced by RLS as always, orthogonal to this story's new checks.

---

**AC-V10 — Structured denial logging for the new visibility gate (audit/failure-handling coverage per this repo's story-review convention).**
**Given** the existing `logArchiveDenied()` convention (`projects/routes.ts:102-110` — a
structured `req.log.warn` with `eventType: 'project.archive_denied'`, since SecureRoute's
same-transaction audit writer only fires on the success path),
**When** AC-V3 or AC-V4's new visibility gate returns a `404` for a `member`/`viewer` caller who
lacks a `project_memberships` row (i.e., the *new* denial path this story introduces, not a
pre-existing cross-org 404),
**Then** log a structured warning distinguishing this cause —
`{ eventType: 'project.visibility_denied', projectId, callerId: secureCtx.auth.userId, orgRole: secureCtx.auth.orgRole }`
— **before** sending the `404`, at every one of the 14 call sites this story adds (AC-V3's 1 route +
AC-V4's 13 routes) via the shared helper itself logging (extend `callerCanSeeProject` to accept the
`req`/logger, or return an enum distinguishing "not found" from "not visible" so callers can log
appropriately) rather than duplicating the log call at each of the 12 sites.

**Example (positive):** a `member` with no project row calls `GET /projects/:id/dashboard` → `404`
response body is unchanged (`PROJECT_NOT_FOUND`, indistinguishable from cross-org to the client,
per D3), but the server log for that request includes `eventType: 'project.visibility_denied'` —
giving security monitoring a real signal distinct from a génuine cross-org probe attempt (which
would show as an ordinary 404 with no matching row in either table, not worth a dedicated log
line since RLS already makes it invisible at the SQL layer).

---

### Group P — Fine-grained `read:secret_value` vs `read:secret_metadata` (NFR-SEC9, ADR-2.2-03 closure)

**AC-P1 — New helper computes the effective project role per D4.**
**Given** the new module `apps/api/src/modules/projects/project-access.ts` (same file as AC-V1),
**When** it exports `async function effectiveProjectRole(secureCtx: SecureRouteContext, projectId: string): Promise<OrgRole>`,
**Then** it returns `secureCtx.auth.orgRole` unconditionally when that role is `'owner'` or
`'admin'`; otherwise it calls `getProjectMembershipRole(...)` and returns the found role (cast to
`OrgRole`) if present, else falls back to `secureCtx.auth.orgRole`.

**Example (positive — member with an explicit project role `'viewer'`):** `effectiveProjectRole`
→ `'viewer'`, even though the org role is `'member'`.

**Example (positive — member with an explicit project role `'admin'`, elevated within this one project):**
`effectiveProjectRole` → `'admin'`, even though the org role is `'member'` — mirrors the existing
precedent (`callerArchiveAuthorization`) where a project role can grant *more* than the org role,
not just less.

**Example (edge — owner org role, no project row at all):** `effectiveProjectRole` → `'owner'`
(short-circuit, no query) — never downgraded by a missing/lower project row, per D1/D4's bypass.

---

**AC-P2 — `GET .../credentials/:credentialId/value` (reveal) requires `effectiveProjectRole >= 'member'`.**
**Given** the existing handler (`credentials/routes.ts:782-912`), currently gated only by
`security.minimumRole: 'member'` (org role) with response schema `{200, 401, 404, 422}` (**no
403 today**),
**When** `roleRank(await effectiveProjectRole(secureCtx, params.projectId)) < roleRank('member')`
(i.e., the caller's effective role — after AC-V4's visibility gate has already run and passed —
is `'viewer'`),
**Then** return `403 { code: 'insufficient_project_role', message: "Your role in this project does not permit revealing credential values" }`
**before** calling `revealCurrentValue()` — add `403: ApiErrorSchema` to the route's response
schema (it is currently missing). This check runs strictly after AC-V4's visibility gate (a
caller who fails visibility already got `404` and never reaches this check) and strictly before
the existing reveal-attempt logging (`OperationalEvent.CREDENTIAL_REVEAL_ATTEMPT`) so that a
project-role-denied attempt is not misleadingly logged as a real reveal attempt.

**Example (positive — org member, project role `'member'`):** unchanged — `200` with the value.

**Example (negative — org member, project role `'viewer'` on this specific project, per an
explicit invitation or the AC-V7 backfill):** `403 insufficient_project_role` — this is the
concrete NFR-SEC9 enforcement this story ships; **before** this story, the identical caller got
`200` with the plaintext value.

**Example (regression — org owner/admin, any/no project row):** unaffected — `effectiveProjectRole`
short-circuits to the org role (D1/D4 bypass), always `>= 'member'` for owner/admin, so reveal is
never blocked for them by this AC.

---

**AC-P3 — `POST .../credentials/:credentialId/versions` (new version) requires the identical `effectiveProjectRole >= 'member'` gate.**
**Given** ADR-2.2-03's original grouping ("value reveal **and version creation** require
`member`"),
**When** the same `effectiveProjectRole` check as AC-P2 is applied to this route,
**Then** a project-role `'viewer'` on this project cannot create a new credential version even if
their org role is `'member'`+, mirroring AC-P2 exactly (same error code/shape; add `403:
ApiErrorSchema` to this route's response schema too, currently `{200/201, 401, 404, 409?, 422}`
— check the actual current set before editing and add only what's missing).

**Example (negative — project-role viewer attempting to add a version):** `403
insufficient_project_role` — previously `201`.

---

**AC-P4 — Regression: every other credential route is unaffected by the Group P gate — org-role-only, exactly as ADR-2.2-03 originally specified.**
**Given** `GET .../credentials` (list), `GET .../credentials/:id` (detail),
`GET .../credentials/:id/versions` (history), `GET`/`POST`/`DELETE .../dependencies`,
`GET .../credentials/:id/access`, `PUT .../tags`, `PATCH .../credentials/:id`,
**When** a caller's effective project role is `'viewer'` (would be blocked by AC-P2/AC-P3),
**Then** all of the above routes behave exactly as before this story — still gated by **org**
role only (AC-V4's visibility gate applies to all of them except `.../access`, which was already
`owner`/`admin`-only before this story and is unchanged by either AC-V4 or this AC; none of them
gain the AC-P `effectiveProjectRole >= member` check). This is a deliberate scope boundary, not an
oversight: ADR-2.2-03 only ever grouped value
reveal + version creation under the `'member'` floor; metadata/history/dependency-management/tags
were always `'viewer'`-gated and stay that way. **Do not extend the Group P gate to these routes**
— doing so would silently expand this story's scope beyond NFR-SEC9's literal text and beyond what
ADR-2.2-03 ever proposed.

**Example (positive — project-role viewer, org role member):** can still list credentials, view
metadata/version history/dependencies/access-list/tags for a project they're visible in — only
reveal (AC-P2) and version-creation (AC-P3) are newly blocked.

---

**AC-P5 — Regression proof: the `?? orgRole` fallback in `effectiveProjectRole` is unreachable for member/viewer once AC-V4 ships, by construction.**
**Given** D4's stated consequence that the fallback branch is "dead in practice" for
member/viewer callers,
**When** a `member`/`viewer` caller reaches `GET .../credentials/:id/value` or
`POST .../credentials/:id/versions` at all (i.e., passed AC-V4's visibility gate for that
`projectId`),
**Then** a `project_memberships` row for that `(projectId, userId)` pair is **guaranteed** to
exist (AC-V1's `callerCanSeeProject` returning `true` for a non-owner/admin caller is only
possible via that exact row's existence) — write one integration test asserting this invariant
directly: register a `member`, backfill/grant them a project row (any role), confirm
`effectiveProjectRole` returns that row's role (not the org-role fallback) for every reachable
combination, proving the fallback path is only ever exercised by owner/admin (who never need a
row) in the routes this story touches.

**Example (proof, not a new runtime behavior):** a `member` who somehow reaches the value-reveal
handler for a project they hold no membership row for would hit the fallback and get their org
role (`'member'`) — but AC-V4 makes this combination unreachable via the API; this AC exists so a
future refactor that accidentally removes AC-V4's gate from one of the gated routes is caught by a
direct unit test of `effectiveProjectRole`'s fallback semantics, not only by an end-to-end gap.

---

**AC-P6 — Structured denial logging for the new reveal/version-create gate, distinguishing it from the pre-existing reveal-failure log taxonomy.**
**Given** the existing `OperationalEvent.CREDENTIAL_REVEAL_FAILURE` logging in the reveal handler
(`credentials/routes.ts:820-891` — covers decrypt errors, not-found, audit-write failure),
**When** AC-P2's new `403 insufficient_project_role` fires,
**Then** log a structured warning with a **distinct** reason so this new denial class is not
conflated with the pre-existing ones in monitoring/alerting —
`{ eventType: OperationalEvent.CREDENTIAL_REVEAL_FAILURE, orgId, credentialId, reason: 'insufficient_project_role' }`
(reuse the existing event type, add a new `reason` value — do not invent a parallel event type for
one new reason, matching this file's existing single-event-multiple-reasons pattern). Apply the
equivalent log to AC-P3's version-creation 403 using whatever this codebase's existing
version-creation route already logs (if anything — check before assuming a parallel structure
exists; if it doesn't, a plain `req.log.warn` matching `logArchiveDenied`'s shape is sufficient,
no new `OperationalEvent` enum member required for a single new call site).

**Example (positive):** a blocked reveal attempt produces a log line with
`reason: 'insufficient_project_role'`, distinguishable in log queries from `reason: 'decrypt_error'`
or `reason: 'not_found'`.

---

**AC-P7 — Web: refine the credential-value-reveal UI's existing 403 branch to distinguish the new project-role denial from the pre-existing org-role denial message.**
**Given** the web credential-detail page's `revealValue()` function
(`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`, lines
~33-51) **already has** a specific (not generic) branch for `error instanceof ApiClientError &&
error.status === 403`, which sets `revealError = 'You do not have permission to reveal credential
values.'` — this branch is unreachable today only because the API has never returned a 403 for
this route (correctly noted elsewhere in this story), not because it's a generic fallback. The
actual gap is narrower than "add a message where none exists": this story's new `403
insufficient_project_role` response needs its own, more specific message distinguishable from the
existing org-role-403 text (which, once this story ships, could in principle also still fire for a
different reason if the org-role floor check ever changes — keeping the two messages distinct
avoids conflating them going forward),
**When** the reveal request fails with `403 { code: 'insufficient_project_role' }` specifically (as
opposed to any other `403`),
**Then** the existing branch is refined to check `error.code === 'insufficient_project_role'` as a
**more specific** case checked before the general `error.status === 403` fallback, setting
`revealError` to a distinct message (e.g. "Your role in this project does not permit revealing
credential values — ask a project admin to change your role.") — the pre-existing generic
`error.status === 403` branch's message stays as the fallback for any other 403 reason, not
replaced or removed. This is the **only** web-code change in this story — do not add any other UI
surfacing for Group V's visibility changes (the project list/dashboard/search pages already render
server-driven data with no code changes needed, per this story's Product Surface Contract).

**Example (positive):** component test renders the credential detail page, mocks the reveal
fetch rejecting with `ApiClientError` `code: 'insufficient_project_role', status: 403`, asserts the
new specific message text renders (not the pre-existing generic-403 fallback string).

**Example (regression — a plain 403 with a different/absent `code`):** the pre-existing generic
`'You do not have permission to reveal credential values.'` message still renders unchanged,
proving this AC narrows the branch rather than replacing it.

**Example (regression — a `404` from AC-V4, i.e. the credential's whole project isn't visible):**
this case is unreachable from this page in practice (the caller could not have navigated to a
project detail page they cannot see — AC-V3 already 404s the whole project), so no corresponding
UI message is required for it; verify (do not just assume) by checking whether the project detail
page's own load function already 404s cleanly upstream of the credential page ever rendering.

---

## Open Questions (surfaced, not resolved — read before starting Group V work)

**Open Question 1 — No self-service way for an org admin to grant an existing org member access to an existing project without an email round-trip.**
Confirmed via direct code inspection: `PUT /org/users/:userId/projects/:projectId/role` requires
the target to *already* hold a `project_memberships` row (`404 membership_not_found` otherwise,
`org/routes.ts:630-640`) — it changes a role, it does not create a membership. The only way to
create one for an *existing, already-registered* org member is the full project-invitation
create → email → accept flow (`modules/invitations/`), even though the invitee already has an
account and is already in the org. Before this story, this was a minor inefficiency (visibility
was universal anyway, so the only thing an invite unlocked was elevated capability). **After** this
story, it becomes the *only* way to grant visibility at all for `member`/`viewer` org roles — a
real, no-existing-alternative UX/product gap for org admins managing team access to existing
projects, one email hop for something that could be an instant "add this teammate" action. This
story does **not** add a direct-add-existing-member endpoint (D5) — flagging for the SM/PO to
scope as an explicit fast-follow, not something to add unscoped inside this story.

**Open Question 2 — Should the AC-V7 backfill also run for *archived* projects, and does that matter?**
This story's answer (AC-V7's third example) is yes, unconditionally — visibility preservation
doesn't care about archival state, and Story 4.4's archived-project guards are about *mutation*,
not visibility (reads remain available on archived projects per AC-5 of that story). Flagging in
case a reviewer wants to reconsider scoping the backfill to non-archived projects only — this
story's position is that doing so would be an inconsistency (an archived project's *dashboard* is
still fully readable today for anyone with pre-story access; the backfill should preserve that,
not narrow it further than this story's own visibility rule already does).

**Open Question 3 — The six explicitly-out-of-scope modules (monitoring/status-pages, machine-users, rotations) now have a starker inconsistency than before this story.**
Before this story, *every* project-scoped surface had the identical "any org member sees
anything" gap, so the six modules named in the Background section were at least consistent with
projects/credentials/search/dashboard. After this story ships, those six modules become the
*only* remaining surfaces with the old, wider-than-intended visibility — a real, if bounded,
regression in *consistency* (not in security posture — nothing gets worse than it was). This is
the deliberate, documented trade-off of scoping this story to the two `deferred-work.md` rows
rather than boiling the ocean; flag as the natural next `deferred-work.md` entry once this story
lands (do not add it to `deferred-work.md` yourself — out of scope per this story's task
instructions; that file is maintained by the parent session).

**Open Question 4 — Should `effectiveProjectRole`'s owner/admin bypass be reconsidered for reveal specifically?**
D4 gives org owner/admin an unconditional reveal bypass, matching D1's visibility bypass. An
alternative design would let an *explicit* project-role `'viewer'` grant downgrade even an org
admin's reveal capability in that one project (stricter NFR-SEC9 enforcement). This story
deliberately does **not** do that — it would contradict the "org owner/admin retain administrative
oversight" precedent this story leans on everywhere else (D1, ADR-4.4-05, `callerCanManageMembers`)
and there is no stated product requirement asking for admins to be restrictable. Flagging so a
future security review can explicitly re-affirm or challenge this choice rather than discovering
it by accident.

---

## Tasks / Subtasks

Follow this project's TDD convention (`AGENTS.md`): write/update the failing test first, confirm
it fails for the expected reason, then implement, per AC.

- [x] **Task 1 — Group V: shared visibility helper (AC-V1)**
  - [x] 1.1 RED: new test file `apps/api/src/modules/projects/project-access.test.ts` — unit tests
    for `callerCanSeeProject` covering AC-V1's three examples (owner/admin bypass with zero
    queries — spy/mock `getProjectMembershipRole` and assert it's never called for owner/admin;
    member with a row; member without). Confirm failure (module doesn't exist).
  - [x] 1.2 GREEN: implement `apps/api/src/modules/projects/project-access.ts` — both
    `callerCanSeeProject` (AC-V1) and `effectiveProjectRole` (AC-P1) live in this one new file,
    both built on the existing `getProjectMembershipRole` import.
  - [x] 1.3 Re-run, confirm green.

- [x] **Task 2 — Group V: project list + dashboard (AC-V2, AC-V3, AC-V10)**
  - [x] 2.1 RED: extend `apps/api/src/modules/projects/routes.test.ts` — new integration tests: a
    `member` with a subset of memberships sees only those on `GET /projects` (AC-V2 positive +
    total-count assertion); a `member` with zero memberships sees `{items: [], total: 0}`; an
    `admin` with zero memberships still sees everything (AC-V8). Add the AC-V3 dashboard 404 test.
    Confirm all new tests fail against current code.
  - [x] 2.2 GREEN: branch the list query's join type on `roleRank(orgRole) >= roleRank('admin')`
    (apply identically to both the `total` count query and the `items` query); add the
    `callerCanSeeProject` 404 gate to the dashboard handler, with the AC-V10 structured log before
    the 404 send.
  - [x] 2.3 Re-run 2.1's tests plus the full existing `projects/routes.test.ts` and
    `projects-archival.routes.test.ts` suites (regression). Confirm all green.

- [x] **Task 3 — Group V: credential routes (AC-V4, AC-V10)**
  - [x] 3.1 RED: extend `apps/api/src/modules/credentials/routes.test.ts` — for each of the 13
    routes listed in AC-V4 (excluding `GET .../access`, which is deliberately not gated — see
    AC-V4), one new test: a `member` with no project row gets `404`; a `member`
    with a row (any role) is unaffected. Use `createMembershipTestHelpers`'s `addUserToOrg`/
    `addProjectMember` (`apps/api/src/__tests__/helpers/membership-test-helpers.ts`) to set up the
    no-membership and with-membership callers without duplicating scaffolding. Confirm failures.
  - [x] 3.2 GREEN: add one `if (!(await callerCanSeeProject(...))) { <log>; return reply.status(404).send(<existing not-found body for this route>) }` call at the top of each of the 13 handlers,
    immediately after `parseParams` and before any other query. Reuse a small local wrapper if it
    meaningfully dedupes (this file already has `withCredentialParams` for some of these routes —
    consider whether extending that helper's signature to optionally run the visibility check is
    cleaner than separate call sites; use judgment, but do not change `withCredentialParams`'s
    existing behavior for callers that don't opt in).
  - [x] 3.3 Re-run 3.1's tests plus the full existing credentials test suite (regression,
    including `credential-dependencies.test.ts`, `credential-import.test.ts`). Confirm green.

- [x] **Task 4 — Group V: search + org dashboard (AC-V5, AC-V6)**
  - [x] 4.1 RED: new/extended tests in `apps/api/src/modules/search/service.test.ts` (or the
    route-level test file, whichever exists) and `apps/api/src/modules/dashboard/routes.test.ts` —
    member visible in a subset of projects gets scoped results/aggregates; admin unaffected;
    `unresolvedAlertCount` explicitly asserted unscoped in both roles' responses. Confirm failures.
  - [x] 4.2 GREEN: add the join/filter condition to `search/service.ts`'s project and credential
    queries, and to `dashboard-stats.ts`'s `getOrgDashboardData`'s `totalCredentials`/
    `expiringWithin30Days` queries (branch on `roleRank(orgRole) >= roleRank('admin')`, mirroring
    Task 2's pattern — consider extracting the join-condition builder from Task 2 into a small
    shared helper in `project-access.ts` if the exact same Drizzle condition is needed in 3+
    places, to avoid copy-pasted join logic drifting). `projectsWithOverdueRotations` needs a
    **different** fix (per AC-V6): a post-filter on `computeUpcomingRotations`'s already-fetched
    result array against the caller's visible-credential-ID set, applied before the existing
    `status === 'overdue'` filter and `.slice(0, 20)` — not a SQL join at that call site.
  - [x] 4.3 Re-run 4.1's tests plus full search/dashboard suites. Confirm green.

- [x] **Task 5 — Group V: backfill migration (AC-V7, AC-V9)**
  - [x] 5.1 Write `packages/db/src/migrations/0043_project_membership_visibility_backfill.sql`
    (number per AC-V7's cross-story coordination check — may need to be `0044` or `0045` if
    sibling stories `3-5-credential-expiry-notification-delivery` and/or
    `1-13-infra-and-process-hardening` claimed 0043/0044 first; raw SQL,
    hand-authored — no schema change, so `drizzle-kit generate` will not produce this
    file automatically; add the `meta/_journal.json` entry by hand, following the existing
    `0042` entry's exact shape).
  - [x] 5.2 RED: new test `packages/db/src/migrations/project-membership-backfill.test.ts` (or
    wherever this project's migration-behavior tests live — check for precedent, e.g. how the
    Story 2.1 orphaned-`project_id`-clearing migration was tested, if it was) — seed an org with
    projects + members in various pre-migration states (some with rows, some without, some
    archived projects), run the migration, assert the exact AC-V7 examples. Confirm it fails
    pre-migration.
  - [x] 5.3 Run `make db-migrate` locally; confirm the migration applies cleanly and is not
    rejected by `migration-safety.ts`'s destructive-statement guard (Story 9.3). If rejected,
    investigate why a plain `INSERT` is being flagged before adding any allowlist entry — do not
    weaken the guard to pass this migration if the real cause is a guard bug elsewhere.
  - [x] 5.4 Run `make check-rls` (AC-V9) — confirm no new gaps reported.

- [x] **Task 6 — Group V: full regression pass (AC-V8, AC-V9)**
  - [x] 6.1 Run the full `apps/api` suite once — confirm zero regressions beyond the
    intentionally-changed tests from Tasks 2-4.
  - [x] 6.2 Run `apps/api/src/__tests__/multi-org-session-isolation.test.ts` in isolation —
    confirm unaffected.

- [x] **Task 7 — Group P: effective role + reveal/version-create gate (AC-P1 through AC-P6)**
  - [x] 7.1 RED: extend `project-access.test.ts` with `effectiveProjectRole` unit tests (AC-P1's
    three examples + AC-P5's invariant proof). Confirm failure.
  - [x] 7.2 GREEN: implement `effectiveProjectRole` (may already exist from Task 1.2 if written
    together — if so, this task is just the additional AC-P1/AC-P5 test coverage).
  - [x] 7.3 RED: extend `credentials/routes.test.ts` with AC-P2 (reveal 403)/AC-P3 (version-create
    403) tests: a `member` with an explicit project-role `'viewer'` grant (via
    `addProjectMember(..., 'viewer')`) is blocked on both routes; unaffected on every AC-P4 route.
    Add the equivalent org-admin regression test (AC-D4/Open Question 4's bypass). Confirm
    failures (current code returns 200/201).
  - [x] 7.4 GREEN: add the `effectiveProjectRole` check to both routes, in the order specified by
    AC-P2 (after AC-V4's visibility gate, before reveal-attempt logging); add `403: ApiErrorSchema`
    to both routes' response schemas; add the AC-P6 structured logging.
  - [x] 7.5 Re-run all of Task 7's tests plus the full credentials suite. Confirm green.

- [x] **Task 8 — Web: reveal-403 message refinement (AC-P7)**
  - [x] 8.1 RED: add a component test asserting the new, more-specific message renders for
    `code: 'insufficient_project_role'`, distinct from the pre-existing generic-403 message.
    Confirm failure.
  - [x] 8.2 GREEN: in the existing `error instanceof ApiClientError && error.status === 403`
    branch (`+page.svelte`'s `revealValue()`), add a more-specific `error.code ===
    'insufficient_project_role'` check ahead of the existing generic-403 message assignment,
    setting a distinct message for this new case. Do not remove or replace the existing
    generic-403 fallback.
  - [x] 8.3 Confirm no regression to the page's handling of other error codes (the pre-existing
    generic-403 message for any other reason, decrypt failures, generic 404/500, etc.) —
    add/verify a regression test per existing code path.

- [x] **Task 9 — Full verification**
  - [x] 9.1 Full `apps/api` suite green.
  - [x] 9.2 Full `apps/web` suite green.
  - [x] 9.3 `make ci` green (typecheck, lint, jscpd, migrations, RLS, audit-coverage, spec-drift).
  - [x] 9.4 Confirm `openapi.json` regenerated to include the two new `403` response schemas
    (AC-P2/AC-P3) — this repo's CI checks for spec/schema drift.

---

### Review Findings (bmad-code-review, 2026-07-11)

Clean pass — no `decision-needed` or `patch` findings. All 17 ACs (V1-V10, P1-P7) traced to matching code/tests against the merged diff; migration `0044` numbering (post 3-way `0043` collision) confirmed resolved with no residual conflict against `main`.

- [x] [Review][Defer] The 6 other project-scoped modules (monitoring/machine-users/rotation) share the same visibility gap this story closes elsewhere — deferred, explicitly out-of-scope and tracked, not a regression from this diff.

**Status → done.**

---

## Dev Notes

- **Do not modify `getProjectMembershipRole`, `callerProjectRole`, `callerCanManageMembers`, or
  `callerArchiveAuthorization`** — these are existing, tested, load-bearing helpers this story
  builds *alongside*, not on top of via modification. `project-access.ts`'s two new exports call
  the existing `getProjectMembershipRole` but add no new parameters or behavior to it.
- **Join-condition duplication risk:** AC-V2 (project list), AC-V5 (search), and AC-V6 (org
  dashboard) all need the same "is this project visible to a member/viewer caller" condition
  expressed as a SQL join/exists, in three different query-builder contexts. Resist the urge to
  over-abstract into one generic query-fragment helper on the first pass — write the three call
  sites directly first (matching each file's existing query style), then extract a shared
  Drizzle-condition builder only if the exact same expression is copy-pasted 3+ times verbatim (this
  project's own jscpd CI gate will tell you if you didn't).
- **`insufficient_project_role` is a new error code** — distinct from the existing
  `insufficient_role` (used for org-role-floor 403s elsewhere, e.g. `org/routes.ts`). Keep them
  distinct in the API surface so a client can tell "you need a higher org role" apart from "your
  role in this specific project doesn't allow this" — these are different remediation paths (ask
  an org owner to promote you, vs. ask a project admin/owner to change your project role).
- **This story changes previously-documented v1 behavior on purpose, twice** — both changes are
  the deliberate, planned closure of an explicit deferral, not accidental scope creep:
  (1) ADR-2.1-01's "any authenticated org member can list and view project dashboards for all org
  projects" is being tightened exactly as that ADR's own "Consequences" column demanded at Story
  4.1 (three epics late); (2) ADR-2.2-03's "any `member`+ can reveal any credential in their org's
  projects" is being narrowed for the subset of members who hold an explicit lower project role.
  Do not "fix" this story to restore either old behavior.
- **Route-audit test coverage:** this story adds no new routes (only new checks inside existing
  handlers) and no new `secureRoute()` registrations, so `route-audit.test.ts`'s
  `ROUTE_ACTION_CLASSIFICATIONS`/`ROUTE_FILES` registries need no new entries — confirm by running
  it, don't assume.
- **Test helper reuse:** `apps/api/src/__tests__/helpers/membership-test-helpers.ts`'s
  `createMembershipTestHelpers()` factory (`addUserToOrg`, `addProjectMember`, `projectRoleOf`) is
  the established pattern for exactly this story's test scenarios (org member with/without a
  specific project role) — use it directly rather than hand-rolling setup in each new test file.

### Project Structure Notes

- One new file: `apps/api/src/modules/projects/project-access.ts` (+ its test file) — houses both
  `callerCanSeeProject` (AC-V1) and `effectiveProjectRole` (AC-P1), since both are thin wrappers
  around the same existing `getProjectMembershipRole` call with different bypass/fallback rules;
  splitting them into two files would be needless ceremony for ~20 lines of logic each.
- One new migration: `packages/db/src/migrations/0043_project_membership_visibility_backfill.sql`
  (renumber if sibling stories `3-5-credential-expiry-notification-delivery` and/or
  `1-13-infra-and-process-hardening` claim 0043/0044 first — see AC-V7's cross-story coordination
  note) + its `meta/_journal.json` entry — no schema/Drizzle-model change, so no edit to
  `packages/db/src/schema/project-memberships.ts` is needed or expected.
- No new tables, no new columns, no new RLS policies.
- Edits (not new files) to: `apps/api/src/modules/projects/routes.ts` (list query join, dashboard
  gate), `apps/api/src/modules/credentials/routes.ts` (11 handlers gain the visibility gate; 2 of
  them additionally gain the effective-role reveal/version-create gate), `apps/api/src/modules/search/service.ts`,
  `apps/api/src/modules/projects/dashboard-stats.ts`, and one `+page.svelte`/error-handling file
  under `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/`.

### References

- [Source: `_bmad-output/implementation-artifacts/deferred-work.md#Security-permissions-cross-epic-explicit-deferrals`]
- [Source: `_bmad-output/implementation-artifacts/2-1-project-creation-and-cross-project-dashboard.md#ADR-2.1-01`]
- [Source: `_bmad-output/implementation-artifacts/2-2-credential-storage-and-retrieval-with-version-history.md#ADR-2.2-03`]
- [Source: `_bmad-output/implementation-artifacts/4-1-team-invitations-and-role-assignment.md`]
- [Source: `_bmad-output/implementation-artifacts/4-4-project-archival.md#ADR-4.4-05`]
- [Source: `apps/api/src/modules/projects/routes.ts`, `member-management.ts`, `archive-guards.ts`]
- [Source: `apps/api/src/modules/credentials/routes.ts`]
- [Source: `apps/api/src/modules/search/service.ts`]
- [Source: `apps/api/src/modules/projects/dashboard-stats.ts`]
- [Source: `apps/api/src/modules/org/routes.ts` (`PUT .../projects/:projectId/role`)]
- [Source: `apps/api/src/modules/invitations/token-routes.ts`]
- [Source: `packages/db/src/check-rls-coverage.ts`, `apps/api/src/middleware/rls.ts`]
- [Source: `apps/api/src/lib/secure-route.ts` (`roleRank`)]
- [Source: `apps/api/src/__tests__/helpers/membership-test-helpers.ts`]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

Cursor Grok 4.5 (pick-story / bmad-dev-story)

### Debug Log References

Focused suites green: projects/project-access, projects/routes, projects/dashboard-stats, search/routes, credentials/routes, multi-org-session-isolation (127 tests); packages/db migration-0044 (4); apps/web projects-credentials (16). Migration renumbered 0043→0044 because 1-13 claimed 0043.

### Completion Notes List

- Group V: `callerCanSeeProject` + list innerJoin, dashboard/credential visibility gates, search/org-dashboard membership scoping, backfill migration 0044, visibility_denied logging, org-admin/RLS regressions.
- Group P: `effectiveProjectRole`, reveal + version-create `403 insufficient_project_role`, structured denial logs, web AC-P7 specific message, openapi 403 schemas.
- `/credentials/:id/access` intentionally ungated (already owner/admin-only).

### File List

- apps/api/src/modules/projects/project-access.ts (new)
- apps/api/src/modules/projects/project-access.test.ts (new)
- apps/api/src/modules/projects/routes.ts
- apps/api/src/modules/projects/routes.test.ts
- apps/api/src/modules/projects/dashboard-stats.ts
- apps/api/src/modules/projects/dashboard-stats.test.ts
- apps/api/src/modules/credentials/routes.ts
- apps/api/src/modules/credentials/routes.test.ts
- apps/api/src/modules/search/service.ts
- apps/api/src/modules/search/routes.ts
- apps/api/src/modules/search/routes.test.ts
- apps/api/src/modules/dashboard/routes.ts
- apps/api/src/__tests__/multi-org-session-isolation.test.ts
- apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte
- apps/web/src/routes/projects-credentials.test.ts
- packages/db/src/migrations/0044_project_membership_visibility_backfill.sql (new)
- packages/db/src/__tests__/migration-0044-project-membership-visibility-backfill.test.ts (new)
- packages/db/src/migrations/meta/_journal.json
- packages/shared/openapi.json
- _bmad-output/implementation-artifacts/sprint-status.yaml

## Change Log

- 2026-07-10: Implemented Groups V+P (visibility scoping + NFR-SEC9 reveal/version gates); status → review.
