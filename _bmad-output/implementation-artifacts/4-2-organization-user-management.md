# Story 4.2: Organization User Management

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-07-01 — comprehensive developer guide for org-wide user visibility, cross-project role management, org/project removal, and project ownership transfer. This story is the SECOND story in Epic 4, built directly on Story 4.1's `project_memberships`/`org_memberships` foundation and the already-shipped FR84 session-revocation primitive (`revokeAllUserSessionsInOrg`, `apps/api/src/modules/org/routes.ts`). Read "Key Design Decisions & Open Questions" before coding — several genuine ambiguities in the PRD/epics text (self-modification scope, "last owner" protection, who may act on which role axis) are resolved there with explicit rationale. -->

## Story

As an organization admin,
I want to view all users across all projects, change their roles, remove them from projects or the org, and transfer project ownership,
so that I can maintain a clean, accurate access model as the team evolves.

*Covers: FR4, FR5a, FR5b, FR5c, FR62.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-4.2` (lines 1460-1486)]

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes — org user list, role change, removal, and ownership transfer are all reachable from the web UI |
| **Linked UI story** (if API-only) | N/A — UI ships in this story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below and AC-9 |

### Persona journey stub

**Alex** (org owner) manages the Acme org's team from **Settings → Users**:

1. Alex opens `/settings/users` and sees a table: every user in the org, their org role, and a per-project role chip list (e.g. "Payments API: admin", "Internal Tools: viewer").
2. Alex notices **Jordan** (an `admin` in "Payments API") should only be a `viewer` there. Alex clicks the role chip, picks `viewer` from a dropdown, confirms. The chip updates in place; no page reload.
3. Alex notices **Sam** left the company. Alex clicks **Remove from organization** next to Sam's row, confirms in a dialog ("This removes Sam from Acme and every project — Sam's sessions will be signed out immediately"). Sam disappears from the table; Sam's browser session (open in another tab) is rejected on its next request with `403 account_deactivated`... actually `403 { code: "insufficient_role" }`-equivalent 401/expired-session behavior (see AC-3) within 5 minutes (JWT TTL) — practically immediate because `sessionVersion` is checked on every request.
4. Separately, on the **Payments API → Members** page, Alex sees **Priya** (currently `member`) and decides to make her the project owner before Alex goes on leave. Alex clicks **Transfer ownership**, selects Priya, confirms. Priya is now `owner`; Alex is now `admin` on that project (still org `owner` — org role is untouched).
5. Alex tries to remove **Priya** (now sole owner of Payments API) directly from the org without transferring ownership elsewhere first — the UI shows "Priya owns 1 project (Payments API) — transfer ownership before removing" and blocks the action (AC-3's last-owner guard, surfaced honestly rather than silently failing).

**MFA note:** all four mutation endpoints in this story (`DELETE /org/users/:userId`, `PUT .../role`, `DELETE /projects/:projectId/members/:userId`, `POST /transfer-ownership`) require MFA enrollment via the standard grace-respecting `requireMfaEnrollment()` (i.e. `security: { requireMfa: true }` on `secureRoute()`) — **not** the strict, grace-ignoring gate Story 4.1 built specifically for FR57 invites (see D2 below for why these are different).

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** These resolve real ambiguities found by cross-referencing the PRD, `epics.md`, the live schema, and the routes Story 4.1 already shipped. Treat each as binding unless a later elicitation pass changes it — do not silently resolve differently.

### D1 — Two different authorization axes: org-wide admin vs. per-project admin

- The story's narrative frames every action as something an **"organization admin"** does. But FR62's canonical text is scoped differently: *"**Project Admins** can remove a user from a specific project without affecting that user's organization account or membership in other projects."* Project Vault has two independent role axes (FR3): `org_memberships.role` (org-wide) and `project_memberships.role` (per-project) — a user can be an org `member` but a project `admin`.
- **Decision:** the five endpoints split into two authorization models:
  - **Org-wide actions** (`GET /org/users`, `DELETE /org/users/:userId`, `PUT /org/users/:userId/projects/:projectId/role`) are gated on the caller's **org role** (`minimumRole: 'admin'` on `secureRoute()`) — these read/reach across every project in the org, which only an org-level admin/owner should do.
  - **Project-scoped actions** (`DELETE /projects/:projectId/members/:userId`, `POST /projects/:projectId/transfer-ownership`) are gated on the caller's **project role** for that specific project (`project_memberships.role IN ('admin','owner')` for removal; `role = 'owner'` for transfer), checked in-handler exactly like Story 4.4's ownership check (`4-4-project-archival.md:164-183`) — **with an org owner/admin override** for removal (so the org-wide admin promised by the story's narrative and FR5a-c can still act), and an **org owner-only override** for ownership transfer (FR4 says "Project Owners... transfer" with no admin-delegation language, and 4.4 already established the `isProjectOwner || isOrgOwner` pattern for the one other single-owner-gated action in this epic — do not add a third variant).
- **Rationale:** this is the only reading that satisfies both FR62's literal "Project Admins" language and the story narrative's "organization admin" framing without contradiction — project admins get local control, org admins/owners retain oversight, and ownership transfer (the highest-impact single action) stays the tightest.

### D2 — MFA gate: standard grace-respecting check, not Story 4.1's strict FR57 gate

- Story 4.1 built `requireMfaEnrollmentStrict()` specifically because the MFA policy matrix (`mfa-policy-matrix.md:38`) explicitly blocks **invites** even during an active grace period — a documented, invite-specific carve-out (FR57).
- No equivalent carve-out exists in the PRD, epics.md, or the MFA policy matrix for org user management, role changes, member removal, or ownership transfer. These are exactly the kind of "privileged route" the matrix already covers generically: *"Owner/admin, grace active, no MFA → **Allowed** + `X-MFA-Grace-Expires-At`"* (`mfa-policy-matrix.md:38`).
- **Decision:** use the standard `security: { requireMfa: true }` on `secureRoute()`, which resolves to `requireMfaEnrollment()` (grace-respecting) — matching the precedent already set by `DELETE /api/v1/org/users/:userId/sessions` (`apps/api/src/modules/org/routes.ts:30-69`), the one existing privileged org-admin route. Do **not** reuse or extend `requireMfaEnrollmentStrict()` — that function's grace-ignoring behavior is a one-off carve-out for FR57 invites, not a general pattern.

### D3 — `displayName` has no dedicated profile column; derive from `users.email`

- Epics AC-line (`epics.md:1472`) specifies the `GET /org/users` response shape includes `displayName`. `users` (`packages/db/src/schema/users.ts`) has **no `displayName` column** — only `id`, `email`, `passwordHash`, `mfaEnrolledAt`, timestamps.
- The only table with a `displayName` field is `user_identity_tokens` (`packages/db/src/schema/user-identity-tokens.ts`), which exists exclusively as the **audit-log PII externalization/pseudonymization layer** (Story 8.3 will let it diverge from the live email via `pseudonymize()`). Joining it here would be semantically wrong for a *live* user-management screen — a pseudonymized user (alias `user_<random>`) would show a meaningless alias instead of their real (still active) email, and pseudonymization is specifically an Epic 8 concept this story must not couple to.
- **Decision:** `displayName` in this story's `GET /org/users` response is simply `users.email` (identical to what `registerUser()` seeds into `user_identity_tokens.displayName` at signup anyway — `apps/api/src/modules/auth/service.ts:385`). No new column, no join. If a real separate display-name profile field ships later, this endpoint picks it up trivially.

### D4 — Self-modification scope: which self-actions are blocked vs. allowed

- Epics AC-line (`epics.md:1482`): *"no admin can modify their own role or remove themselves from the org (NFR-SEC10); self-modification returns `403 { error: "cannot_modify_self" }`."* This story introduces **no** org-role-change endpoint at all (org role changes are out of scope entirely — org role is only ever set at registration/invite-acceptance time per Story 4.1's D5). The only "modify a role" endpoint this story ships is the **project**-role PUT. Read literally, "modify their own role" must therefore refer to that endpoint.
- **Decision — blocked (403 `cannot_modify_self`):**
  1. `DELETE /api/v1/org/users/:userId` where `userId === caller.userId` (removing yourself from the org).
  2. `PUT /api/v1/org/users/:userId/projects/:projectId/role` where `userId === caller.userId` (changing your own project role — prevents an admin silently self-promoting toward owner-adjacent power via a side door instead of the audited `transfer-ownership` flow).
- **Decision — explicitly allowed (not a self-modification violation):**
  3. `DELETE /api/v1/projects/:projectId/members/:userId` where `userId === caller.userId` — **leaving a project you belong to is normal and not privilege-related**; it is still subject to the last-owner guard (D5) like any other removal, but is not blocked purely for being a self-action.
  4. `POST /api/v1/projects/:projectId/transfer-ownership` where the caller transfers ownership *away from themselves to someone else* — this is the entire point of the endpoint and is obviously allowed. (Transferring ownership *to yourself*, i.e. `newOwnerId === caller.userId` while already owner, is rejected as a no-op — see AC-6.)
- **Rationale:** NFR-SEC10's intent ("no user may grant permissions exceeding their own role or modify their own role assignment") is about preventing silent privilege escalation, not about preventing someone from leaving a project or orchestrating their own planned handoff through the one endpoint designed for exactly that.

### D5 — "Last owner" protection: exists nowhere yet; this story must add it in three places

- Grepping the entire codebase for `last owner`/`ownerCount`/`only owner` returns zero matches — **no such guard exists today**. `project_memberships` has no DB constraint enforcing "at least one owner per project" (only a `CHECK role IN (...)` on allowed values) — this is purely an application-level invariant this story must introduce and enforce everywhere it could be violated.
- **The guard must run in three places**, all as an atomic check-then-act within the same `secureCtx.tx` (using `SELECT ... FOR UPDATE` on the affected `project_memberships` rows to close the race described below):
  1. **`DELETE /projects/:projectId/members/:userId`**: if the target's role in this project is `'owner'` and no *other* `project_memberships` row for this project has `role = 'owner'`, reject with `409 { code: "last_owner", message: "Cannot remove the last owner of a project" }`.
  2. **`DELETE /org/users/:userId`** (org-wide removal, which cascades to removing every `project_memberships` row for that user — see AC-3): before cascading, find every project where the target user is the **sole** owner. If any exist, reject the *entire* removal with `409 { code: "sole_owner_of_projects", projects: [{ projectId, projectName }, ...] }` — do not partially remove. The admin must transfer ownership on each blocking project first (AC-6), then retry.
  3. **`PUT /org/users/:userId/projects/:projectId/role`**: if the target's *current* role in this project is `'owner'`, reject with `409 { code: "must_transfer_ownership_first", message: "Use transfer-ownership to change the project owner" }` — this endpoint's schema also excludes `'owner'` as a settable *target* role (see D6), so this guard only fires when someone tries to demote an existing owner via the wrong endpoint.
- **Concurrency:** two simultaneous `DELETE .../members/:userId` calls targeting the same sole owner (or a removal racing a role-change) must not both succeed. Lock the target project's owner-role rows with `SELECT ... FOR UPDATE` before counting, inside the same transaction as the mutation — mirrors the existing `revokeSessionById` pattern (`session-revoke.ts`) which already locks session rows `FOR UPDATE` before mutating. The loser of the race sees a consistent, re-checked count and gets the same `409`.

### D6 — `PUT .../role` never accepts `'owner'` as a target role

- `project_memberships.role` allows `'owner'` at the DB level, but this story's role-change endpoint is explicitly **not** how ownership changes hands — that is `POST /transfer-ownership` (AC-6), which atomically demotes the old owner in the same transaction. Allowing `PUT .../role` to set `role: 'owner'` would let two rows hold `'owner'` simultaneously (no DB constraint prevents it) or silently orphan the previous owner's status.
- **Decision:** the request body schema is `z.object({ role: z.enum(['admin', 'member', 'viewer']) })` — `'owner'` is not a valid enum value; a request with `role: 'owner'` gets a `422 validation_error`, not a `403`. This mirrors Story 4.1's identical decision to exclude `'owner'` from the invite-role enum (`project_invitations_role_check`, `4-1-team-invitations-and-role-assignment.md:223`).

### D7 — Org removal does not touch pending project invitations

- Story 4.3 (Account Deactivation, `epics.md:1500`) explicitly revokes a deactivated user's pending invitations as part of its own AC. Story 4.2's org removal (`DELETE /org/users/:userId`) has no equivalent instruction in epics.md, and org removal ("remove the user, keep their account") is a materially different lifecycle event from deactivation ("lock the account out").
- **Decision:** this story does **not** revoke or touch any `project_invitations` rows on org removal — that remains exclusively Story 4.3's concern for the *deactivation* path. If the removed user has a pending invitation to some other project in the same org, that invitation is untouched (it can still be accepted later, re-adding them). Documented here so a future reader doesn't assume this was an oversight.

### D8 — No reusable project-role resolver introduced (yet)

- Both Story 4.1 (`4-1-team-invitations-and-role-assignment.md:21`) and Story 4.4 (`4-4-project-archival.md:33,184`) explicitly deferred building a shared "resolve my role in project X" helper, each pointing at the other as the place it might eventually land. Story 4.2 needs this exact lookup in **two** routes (member removal, ownership transfer) — a third consumer.
- **Decision:** still do **not** build a shared resolver in this story. Copy the exact inline-query pattern from `4-4-project-archival.md:164-183` (`SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?`) into both of this story's project-scoped handlers. **Do** leave a one-line comment at each call site (`// Inline project-role lookup — see 4.1 D-notes / 4.4 AC-2 for why this isn't centralized yet; 3rd occurrence as of 4.2, consider extracting if a 4th consumer appears`) so the next story to need it has a concrete trigger to finally extract it, rather than re-deferring silently a fourth time.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| **Story 4.1 is `done`** (`sprint-status.yaml` confirms this) | This story is built entirely on `org_memberships` and `project_memberships`, both already shaped correctly by prior stories; 4.1 is the story that proved the `roleRank()` export and the `project_memberships` role-enforcement pattern this story reuses. |
| **`revokeAllUserSessionsInOrg()` exists** (`apps/api/src/modules/auth/session-revoke.ts:266-290`) | This story's org-removal path (AC-3) calls it directly — confirmed live and already consumed by `DELETE /api/v1/org/users/:userId/sessions` (`apps/api/src/modules/org/routes.ts:30-69`). Do not reimplement session revocation. |
| **`roleRank()` is exported from `secure-route.ts`** (`apps/api/src/lib/secure-route.ts:177-188`) | Confirmed exported (Story 4.1 Task 3) and already consumed by `apps/api/src/modules/invitations/routes.ts:15,164`. Reuse directly for the NFR-SEC10 role-elevation check in AC-4. |
| **Story 4.4 is `ready-for-dev`, NOT implemented** (`sprint-status.yaml`: `4-4-project-archival: ready-for-dev`) | No archival code exists yet — `projects.archivedAt` is a real column (from Story 2.1) but there is no archive/unarchive route. This story's project-scoped mutations should still defensively guard `isNull(projects.archivedAt)` (the idiom is already used in `modules/projects/routes.ts`'s list/dashboard/patch/tags routes) so they degrade gracefully once 4.4 ships, but must not assume any 4.4-specific error codes exist today. |
| **Migration numbering (verify, do NOT hardcode)** | Latest migration on this branch is `0025_project_invitations.sql` (`packages/db/src/migrations/meta/_journal.json`, idx 25). **This story requires no new migration** (see AC-1) unless you choose to add the optional performance index — if you do, re-read `_journal.json` at code time and use the next free number (anticipated `0026_*`, but confirm). |
| `apps/api/src/lib/route-exemptions.ts` `ROUTE_ACTION_CLASSIFICATIONS` | This story adds four new entries (list is read-classified with an omission reason; the other three are mutations with audit events). `route-audit.test.ts` enforces every route has an entry. |

---

## Epic Cross-Story Context

| Story | Relationship to 4.2 |
|---|---|
| 2.1 | Created `projects`, `project_memberships` (composite PK `(projectId, userId)`, role check `owner/admin/member/viewer`), `GET /api/v1/projects`. 4.2 mutates `project_memberships` rows; it adds no new columns. |
| 4.1 | Created `project_invitations`, established `roleRank()` export, and the "inline project-role query" pattern this story copies a third time (D8). 4.2 does not touch invitation rows (D7). |
| 4.3 (Account Deactivation & Recovery, not yet created) | Will introduce `organization_members.status = 'deactivated'` transitions and revoke pending invitations on deactivation. 4.2's org removal (`DELETE /org/users/:userId`) is a **different, permanent** lifecycle event ("remove the membership record entirely") — 4.3's deactivation is reversible-ish (recovery flow) and status-based. Do not conflate the two; 4.2 does not set any `status` field, it deletes the `org_memberships` row outright. |
| 4.4 (Project Archival, `ready-for-dev`, not implemented) | Explicitly depends on 4.2's `DELETE /projects/:projectId/members` route existing so its "no new members after archive" write guard (`4-4-project-archival.md:51`) has something to protect. 4.2 does not add that guard itself (4.4 isn't implemented yet) — 4.4 will add the `archivedAt` check to this story's routes when it lands. This story's routes should still tolerate `isNull(projects.archivedAt)` in their base queries defensively (Prerequisites table), but the explicit 410 `project_archived` behavior is 4.4's to add. |
| NFR-SEC10 (`epics.md:174`) | *"No user may grant permissions exceeding their own role or modify their own role assignment"* — enforced via the role-elevation check (AC-4) and the self-modification checks (D4, AC-3/AC-4). |
| FR84 (`prd.md:964`, implemented alongside Story 1.7/1.9) | *"Organization Admins can revoke all active sessions for any user in their organization"* — already shipped as `DELETE /api/v1/org/users/:userId/sessions` + `revokeAllUserSessionsInOrg()`. 4.2's org removal (AC-3) calls this exact function synchronously rather than duplicating session-revocation logic. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 4.2 | Rationale |
|---|---|---|
| Architecture `AuditEvent` registry is `UPPER_SNAKE_CASE` (`architecture.md:543-570`) | Follow the established, actually-shipped convention: lowercase dotted, matching the `project.*` family (`project.created`, `project.invitation_created`, etc. — confirmed in `packages/shared/src/constants/audit-events.ts`). Add `org.user_removed`, `project.member_role_changed`, `project.member_removed`, `project.ownership_transferred`. | Same precedent Story 4.1 and Story 4.4 already established — every event added since Epic 2 follows the dotted-lowercase family, not the stale registry doc. |
| Architecture generic error envelope (`architecture.md:372-379`) uses `{ error, message, statusCode, requestId }` | Use `{ code, message }` — matches `ApiErrorSchema` (`packages/shared/src/schemas/api.ts:37-43`) and every shipped route. | Same rule Story 4.1 already documented; the architecture doc's example predates the actually-enforced contract. |
| Epic AC frames every action as something an "organization admin" does | Split authorization by axis per D1 above — org-wide actions gate on org role, project-scoped actions gate on project role (with an org owner/admin override). | Resolves the FR62 "Project Admins" vs. story-narrative "organization admin" tension explicitly rather than picking one reading and silently dropping the other's requirement. |
| epics.md's literal response shape for `GET /org/users` (`epics.md:1472`) is a bare array | Return `{ data: [...] }` (bare array under `data`, no `items`/`total` envelope) — matches the existing `GET /api/v1/projects/:projectId/invitations` list shape, not the paginated `GET /api/v1/projects` shape. | epics.md is explicit and literal here (no pagination fields mentioned); the invitations-list endpoint is the closer precedent (admin-facing, bounded, non-secret metadata list) than the paginated project list. Flagged in AC-2 as a known v1 scale limitation (no pagination) consistent with NFR-SCALE1's 50-concurrent-user reference scale. |
| Architecture module layout (`architecture.md:623-637`) prescribes `routes.ts/service.ts/schema.ts/repository.ts` per module | Extend the existing `modules/org/routes.ts` + `modules/org/schema.ts` (org-wide routes) and `modules/projects/routes.ts` + `modules/projects/schema.ts` (project-scoped routes) in place — no new module directory. Business logic inline in handler functions, matching every module shipped so far. | Matches what's actually shipped (`modules/org/`, `modules/projects/`, `modules/invitations/` all follow this); a new module would fragment two already-small, cohesive route files for no benefit. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Schema | **No migration required** — reuses `org_memberships`, `project_memberships`, `sessions`, `users` as-is. Optional perf index only if added (see AC-1). |
| GET `/api/v1/org/users` | Org role `admin`+. Lists every org member with `displayName` (= email, D3), `orgRole`, and every project membership + role. Bare array response (no pagination — documented limitation). |
| DELETE `/api/v1/org/users/:userId` | Org role `admin`+, MFA required. Removes `org_memberships` row + every `project_memberships` row for that user in this org, atomically. Blocks (`409`) if the user is the sole owner of any project (D5). Blocks self-removal (`403`, D4). Synchronously revokes all sessions via `revokeAllUserSessionsInOrg()` (FR84 reuse). |
| PUT `/api/v1/org/users/:userId/projects/:projectId/role` | Org role `admin`+, MFA required. Changes a `project_memberships.role` to `admin`/`member`/`viewer` (never `owner` — D6). Blocks role-elevation above caller's org role (NFR-SEC10). Blocks self-modification (D4). Blocks if target is currently `owner` (D5, must use transfer-ownership). |
| DELETE `/api/v1/projects/:projectId/members/:userId` | Caller must be project `admin`/`owner` for this project, OR org `admin`/`owner` (D1). MFA required. Removes the single `project_memberships` row. Blocks (`409`) if target is the sole project owner (D5). Self-removal allowed (D4) subject to the same last-owner guard. |
| POST `/api/v1/projects/:projectId/transfer-ownership` | Caller must be project `owner` for this project, OR org `owner` (D1, matches 4.4's `isProjectOwner \|\| isOrgOwner`). MFA required. Atomically: new owner's role → `owner`, old owner's role → `admin`. Target must be an accepted member (not a pending invite). Race-safe via conditional `WHERE role = 'owner'` update (mirrors 4.4's archive idempotency pattern). |
| Audit | `org.user_removed`, `project.member_role_changed`, `project.member_removed`, `project.ownership_transferred` — all same-transaction, fail-closed via `writeHumanAuditEntryOrFailClosed`. Org removal also produces one `SESSION_REVOKED` audit row per revoked session (from `revokeAllUserSessionsInOrg`, pre-existing behavior, not new). |
| Integration tests | List (with/without project memberships, empty org, 403 non-admin), org-removal (success + session revoke verified, self-block, sole-owner block, user-not-found), role-change (success, elevation-block, self-block, owner-target-block, invalid-role 422, cross-org 404), project-member-removal (success by project-admin, success by org-admin override, self-removal-allowed, sole-owner-block, not-a-member 404), transfer-ownership (success, non-accepted-member rejection, non-owner-caller 403, concurrent-transfer 409, self-transfer no-op rejection, cross-org 404). |
| Web app | New `/settings/users` page (org-wide table: email, org role, per-project role chips, role-change dropdown, remove-from-org action with confirm dialog and honest last-owner blocking message). Extended `/projects/:projectId/members` page: accepted-member list (not just pending invitations) with per-row role change, remove, and "Transfer ownership" action. |

---

### AC-1: Schema — No Migration Required; Optional Performance Index

**Given** `org_memberships`, `project_memberships`, `sessions`, and `users` already exist with everything this story needs (confirmed by reading `packages/db/src/schema/org-memberships.ts`, `project-memberships.ts`, `sessions.ts`, `users.ts`),
**When** Story 4.2 is implemented,
**Then** **do not write a migration** for any new table or column. Confirm before coding:

```bash
# Confirm no column is missing before assuming a migration is needed
rg "role|status|sessionVersion" packages/db/src/schema/org-memberships.ts packages/db/src/schema/project-memberships.ts packages/db/src/schema/sessions.ts
```

**And** an index to speed up the "last owner" guard's `COUNT(*) WHERE project_id = ? AND role = 'owner'` query (D5) is **optional** in this story — `project_memberships`'s existing composite PK `(projectId, userId)` already makes point lookups fast, and org-scale (NFR-SCALE1: 50 concurrent users) makes a full per-project scan cheap even unindexed. If you choose to add one anyway (recommended if load-testing later shows this hot), it is the only schema change and requires a real migration at the next free journal number (verify `meta/_journal.json` — do NOT hardcode `0026`):

```sql
-- OPTIONAL: only if the last-owner count query needs it under load.
CREATE INDEX idx_project_memberships_project_role
  ON project_memberships (project_id, role);
```

**And** if you add the index: run `pnpm --filter @project-vault/db generate`, then `pnpm --filter @project-vault/db check-rls` (must still pass — RLS already covers `project_memberships` and `org_memberships` from prior stories; do **not** add either to `EXCLUDED_TABLES`), then `pnpm --filter @project-vault/db migrate`.

**Edge case — schema drift check:** if a future story renames or removes any of `org_memberships.role`, `project_memberships.role`, or `sessions.sessionVersion` before this one is implemented, every AC below breaks silently at the query level (wrong column name) rather than at compile time in a few spots (raw SQL fragments). Re-run the `rg` command above immediately before starting Task 1 to catch drift early.

---

### AC-2: GET `/api/v1/org/users` — List All Org Users With Cross-Project Roles

**Given** an org admin (or owner) is authenticated,
**When** they call `GET /api/v1/org/users`,
**Then** they receive every user with an `org_memberships` row in the caller's org, each annotated with every project they belong to in that org.

**Request:**
```http
GET /api/v1/org/users
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`) — happy path, user with two project memberships:**
```json
{
  "data": [
    {
      "userId": "aaaaaaaa-0000-4000-8000-000000000001",
      "email": "alex@acme.example",
      "displayName": "alex@acme.example",
      "orgRole": "owner",
      "projects": [
        { "projectId": "00000000-0000-4000-8000-000000000010", "projectName": "Payments API", "role": "owner" },
        { "projectId": "00000000-0000-4000-8000-000000000011", "projectName": "Internal Tools", "role": "admin" }
      ]
    },
    {
      "userId": "bbbbbbbb-0000-4000-8000-000000000002",
      "email": "jordan@acme.example",
      "displayName": "jordan@acme.example",
      "orgRole": "member",
      "projects": [
        { "projectId": "00000000-0000-4000-8000-000000000010", "projectName": "Payments API", "role": "admin" }
      ]
    }
  ]
}
```

**Edge case — org member with zero project memberships** (e.g. joined the org via a future FR6 multi-org path with no project invite yet, or an existing user whose only project membership was just removed by AC-4/AC-5): `projects` is `[]`, not omitted — the row still appears so the org admin has full visibility (this is the entire point of FR5a).

**Edge case — empty organization** (should not occur in practice since the creating owner always has an `org_memberships` row, but defensively): returns `{ "data": [] }`, `200`, not an error.

**Query shape (concrete, batched to avoid N+1 — mirrors the `getBatchedProjectCredentialStats` batching precedent in `modules/projects/dashboard-stats.ts`):**
```typescript
const orgUsers = await secureCtx.tx
  .select({ userId: orgMemberships.userId, email: users.email, orgRole: orgMemberships.role })
  .from(orgMemberships)
  .innerJoin(users, eq(users.id, orgMemberships.userId))
  .where(eq(orgMemberships.orgId, secureCtx.auth.orgId))

const projectRows = await secureCtx.tx
  .select({
    userId: projectMemberships.userId,
    projectId: projectMemberships.projectId,
    projectName: projects.name,
    role: projectMemberships.role,
  })
  .from(projectMemberships)
  .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
  .where(eq(projectMemberships.orgId, secureCtx.auth.orgId))

// Group projectRows by userId in application code; attach [] for users with no matches.
```

**And** `displayName` is `row.email` verbatim (D3) — do not join `user_identity_tokens`.

**SecureRoute security:**
```typescript
security: {
  minimumRole: 'admin', // org role floor — owner and admin both qualify
  requireMfa: false,    // read-only; matches "MFA-exempt: GET status/read paths" precedent
  writeAuditEvent: false,
  rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/org/users' },
}
```

**Negative case — caller is `member`/`viewer`:** `403 { code: "insufficient_role", message: "Insufficient permissions" }` (SecureRoute's default `sendInsufficientRole`, no custom handling needed).

**Negative case — unauthenticated:** standard SecureRoute `401 { code: "access_token_missing" }`.

**And** integration tests cover: happy path (multiple users, multiple projects each), user with zero project memberships, empty org (theoretical), non-admin caller `403`, unauthenticated `401`, cross-org isolation (a second org's users never appear — verified via RLS, not an application-level filter).

---

### AC-3: DELETE `/api/v1/org/users/:userId` — Remove User From Organization

**Given** an org admin (or owner) is authenticated,
**When** they call `DELETE /api/v1/org/users/:userId`,
**Then** the target's `org_memberships` row and every `project_memberships` row for that user in this org are deleted, and all their sessions in this org are revoked — atomically, in one transaction.

**Request:**
```http
DELETE /api/v1/org/users/bbbbbbbb-0000-4000-8000-000000000002
Cookie: access-token=<jwt>
```

**Successful response (`200 OK`) — happy path, user with one non-owner project membership:**
```json
{
  "data": { "userId": "bbbbbbbb-0000-4000-8000-000000000002", "revokedSessionCount": 2 }
}
```

**Handler flow (exact order — fail fast, cheapest checks first):**

1. **Validate** `userId` as `z.uuid()` → `422 { code: "validation_error" }` on malformed.
2. **Self-modification check (D4):** `params.userId === secureCtx.auth.userId` → `403 { code: "cannot_modify_self", message: "You cannot remove yourself from the organization" }`. Checked **before** the DB lookup — cheapest possible check.
3. **Target membership lookup:** `SELECT userId FROM org_memberships WHERE userId = :userId AND orgId = :callerOrgId` within `secureCtx.tx` (RLS-scoped — cross-org targets simply don't exist in this query). Zero rows → `404 { code: "user_not_found", message: "User not found" }` (never `403` — enumeration-prevention rule, matches 4.1/4.4 precedent).
4. **Sole-owner guard (D5, item 2):** lock and count. Concretely:
   ```typescript
   const soleOwnerProjects = await secureCtx.tx.execute(sql`
     SELECT pm.project_id AS "projectId", p.name AS "projectName"
     FROM project_memberships pm
     JOIN projects p ON p.id = pm.project_id
     WHERE pm.org_id = ${secureCtx.auth.orgId}
       AND pm.user_id = ${params.userId}
       AND pm.role = 'owner'
       AND NOT EXISTS (
         SELECT 1 FROM project_memberships pm2
         WHERE pm2.project_id = pm.project_id
           AND pm2.role = 'owner'
           AND pm2.user_id != ${params.userId}
         FOR UPDATE
       )
     FOR UPDATE OF pm
   `)
   if (soleOwnerProjects.length > 0) {
     return reply.status(409).send({
       code: 'sole_owner_of_projects',
       message: 'Transfer ownership of these projects before removing this user',
       projects: soleOwnerProjects,
     })
   }
   ```
   (Adapt the raw-SQL shape to this codebase's Drizzle query builder idioms if a cleaner builder equivalent exists at code time — the `FOR UPDATE` locking semantics and the "no other owner exists" logic must be preserved exactly.)
5. **Delete project memberships:** `DELETE FROM project_memberships WHERE org_id = :orgId AND user_id = :userId` (no join through `projects` needed — `project_memberships` is itself `orgScoped()`, confirmed in `packages/db/src/schema/project-memberships.ts`).
6. **Delete org membership:** `DELETE FROM org_memberships WHERE org_id = :orgId AND user_id = :userId`.
7. **Revoke sessions (FR84 reuse — do not reimplement):**
   ```typescript
   const { revokedCount } = await revokeAllUserSessionsInOrg({
     userId: params.userId,
     orgId: secureCtx.auth.orgId,
     actorUserId: secureCtx.auth.userId,
     reason: 'admin_action',
     tx: secureCtx.tx,
   })
   ```
8. **Audit:** `writeHumanAuditEntryOrFailClosed(secureCtx.tx, { eventType: 'org.user_removed', resourceType: 'org_membership', resourceId: params.userId, payload: { removedProjectCount: <count from step 5> }, ... })`. Note `revokeAllUserSessionsInOrg` already writes its own `SESSION_REVOKED` audit row per session (existing, unrelated code path) — this is additive, not a conflict.
9. Return `200` with `{ data: { userId, revokedSessionCount: revokedCount } }`.

**SecureRoute security:**
```typescript
security: {
  minimumRole: 'admin',
  requireMfa: true, // D2 — standard grace-respecting gate
  writeAuditEvent: false, // custom writeHumanAuditEntryOrFailClosed call inside the handler
  rateLimit: { max: 20, timeWindowMs: 60_000, key: 'DELETE /api/v1/org/users/:userId' },
}
```

**Edge case — user has zero project memberships:** steps 4-5 are no-ops (empty result sets); step 6-7 proceed normally. `revokedProjectCount: 0` in the audit payload.

**Edge case — user has an already-expired or already-revoked session:** `revokeAllUserSessionsInOrg` only touches non-revoked sessions (existing behavior, confirmed in `session-revoke.ts`) — `revokedSessionCount` reflects only sessions actually revoked by this call, which may be `0` if the user had no active session.

**Edge case — concurrent removal of the same user (double-click / retry):** the second call's step 3 lookup finds zero rows (already deleted by the first call's transaction, which commits first) → `404 { code: "user_not_found" }`. Idempotent-safe; not a `500`.

**And** integration tests cover: happy path with session-revocation count assertion (create 2 sessions for the target, verify both rejected on next authenticated request), self-removal block (`403`), sole-owner block (`409` with correct `projects` array, verified user is **not** removed — transaction rolled back, `org_memberships`/`project_memberships` rows still present), user-not-found (`404`), zero-project-memberships user (succeeds, `revokedProjectCount: 0`), non-admin caller (`403`), cross-org target (`404`).

---

### AC-4: PUT `/api/v1/org/users/:userId/projects/:projectId/role` — Change Project Role

**Given** an org admin (or owner) is authenticated,
**When** they call `PUT /api/v1/org/users/:userId/projects/:projectId/role` with `{ role: "admin" | "member" | "viewer" }`,
**Then** the target's `project_memberships.role` for that project is updated, subject to the elevation and self-modification guards.

**Request:**
```http
PUT /api/v1/org/users/bbbbbbbb-0000-4000-8000-000000000002/projects/00000000-0000-4000-8000-000000000010/role
Cookie: access-token=<jwt>
Content-Type: application/json

{ "role": "viewer" }
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "userId": "bbbbbbbb-0000-4000-8000-000000000002",
    "projectId": "00000000-0000-4000-8000-000000000010",
    "role": "viewer"
  }
}
```

**Handler flow (exact order):**

1. **Validate params** (`userId`, `projectId` as `z.uuid()`) and **body** (`role: z.enum(['admin','member','viewer'])` — D6, `'owner'` is a schema-level `422`, not a `403`).
2. **Self-modification check (D4):** `params.userId === secureCtx.auth.userId` → `403 { code: "cannot_modify_self" }`.
3. **Role-elevation check (NFR-SEC10):** `roleRank(body.role) > roleRank(secureCtx.auth.orgRole)` → `403 { code: "insufficient_role", message: "Cannot assign a role higher than your own" }`. Reuse the exported `roleRank()` from `secure-route.ts` — do not duplicate.
4. **Target membership lookup:** `SELECT role FROM project_memberships WHERE project_id = :projectId AND user_id = :userId AND org_id = :orgId` (RLS-scoped; also implicitly confirms the project belongs to the caller's org). Zero rows → `404 { code: "membership_not_found", message: "User is not a member of this project" }`.
5. **Current-owner guard (D5, item 3):** if `membership.role === 'owner'` → `409 { code: "must_transfer_ownership_first", message: "Use transfer-ownership to change the project owner" }`.
6. **Update:** `UPDATE project_memberships SET role = :role WHERE project_id = :projectId AND user_id = :userId`.
7. **Audit:** `writeHumanAuditEntryOrFailClosed(..., eventType: 'project.member_role_changed', resourceType: 'project_membership', resourceId: params.userId, payload: { projectId, oldRole: membership.role, newRole: body.role })`.
8. Return `200`.

**SecureRoute security:**
```typescript
security: {
  minimumRole: 'admin',
  requireMfa: true,
  writeAuditEvent: false,
  rateLimit: { max: 30, timeWindowMs: 60_000, key: 'PUT /api/v1/org/users/:userId/projects/:projectId/role' },
}
```

**Edge case — role unchanged (no-op update):** `{ role: "member" }` when the target is already `member` — allowed, succeeds with `200`, still writes an audit row (`oldRole === newRole` is visible in the payload for anyone reviewing the log; not treated as an error, matches how most PATCH-style endpoints in this codebase behave elsewhere).

**Edge case — target user exists in the org but not in this specific project:** `404 { code: "membership_not_found" }`, not `403` — this is a not-found condition (no `project_memberships` row), distinct from cross-org enumeration prevention but using the same "safe 404" instinct.

**Edge case — `projectId` belongs to a different org than the caller's:** the RLS-scoped `tx` in step 4 returns zero rows regardless (the `project_memberships` row, if any, is invisible under RLS) → `404`, never `403` (enumeration-prevention rule, same as AC-3).

**And** integration tests cover: happy path (each of admin/member/viewer as target role), role-elevation rejection (org `admin` caller attempts `role: "admin"`... wait — a caller with org role `admin` (rank 2) attempting to set a project role of `admin` (rank 2) is **not** elevation, since `roleRank(body.role) > roleRank(caller)` requires strictly greater; construct the actual failing case: an org `member` cannot reach this route at all (`minimumRole: 'admin'` blocks first) — so exercise elevation via a caller whose org role is `admin` attempting to defeat the check is not reachable either. **Document this the same way Story 4.1 documented its equivalent unreachable case** (`4-1-...md` Implementation Notes: "Role-elevation check... implemented but not integration-tested... every caller who can reach the handler already outranks every settable role"): since `minimumRole: 'admin'` (rank 2) is the floor and the settable target roles are `admin`/`member`/`viewer` (max rank 2), no caller who can reach this handler can ever fail the elevation check today. Keep the guard as defensive infrastructure (it becomes reachable the moment `owner` is ever added as a settable value, or if `minimumRole` is ever loosened) and flag this in Dev Notes exactly as 4.1 did — do not fabricate a fake-passing test for an unreachable branch), self-modification block (`403`), current-owner-target block (`409`), invalid role value `422` (`role: "owner"` and `role: "superadmin"` both), membership-not-found `404`, cross-org project `404`, non-admin caller `403`.

---

### AC-5: DELETE `/api/v1/projects/:projectId/members/:userId` — Remove From a Single Project

**Given** the caller is a project `admin`/`owner` for the target project, **or** an org `admin`/`owner` (D1),
**When** they call `DELETE /api/v1/projects/:projectId/members/:userId`,
**Then** the single `project_memberships` row is deleted without touching the user's org membership or their membership in any other project.

**Request:**
```http
DELETE /api/v1/projects/00000000-0000-4000-8000-000000000010/members/bbbbbbbb-0000-4000-8000-000000000002
Cookie: access-token=<jwt>
```

**Successful response:** `204 No Content`.

**Handler flow (exact order):**

1. **Validate** `projectId`/`userId` as `z.uuid()` → `422` on malformed.
2. **Target membership lookup:** `SELECT role FROM project_memberships WHERE project_id = :projectId AND user_id = :userId AND org_id = :callerOrgId` (RLS-scoped). Zero rows → `404 { code: "membership_not_found" }` (covers both "not a member" and "wrong org" — enumeration-prevention rule).
3. **Authorization check (D1 — in-handler, since SecureRoute's org-role floor alone is insufficient):**
   ```typescript
   const [callerMembership] = await secureCtx.tx
     .select({ role: projectMemberships.role })
     .from(projectMemberships)
     .where(and(eq(projectMemberships.projectId, params.projectId), eq(projectMemberships.userId, secureCtx.auth.userId)))
     .limit(1)
   // Inline project-role lookup — see 4.1 D-notes / 4.4 AC-2 for why this isn't centralized yet;
   // 3rd occurrence as of 4.2, consider extracting if a 4th consumer appears.
   const isProjectAdminOrOwner = callerMembership?.role === 'admin' || callerMembership?.role === 'owner'
   const isOrgAdminOrOwner = secureCtx.auth.orgRole === 'admin' || secureCtx.auth.orgRole === 'owner'
   if (!isProjectAdminOrOwner && !isOrgAdminOrOwner) {
     return reply.status(403).send({ code: 'insufficient_role', message: 'Only project admins/owners or org admins/owners can remove project members' })
   }
   ```
4. **Sole-owner guard (D5, item 1):** if `targetMembership.role === 'owner'` and no other `project_memberships` row for this `projectId` has `role = 'owner'` (same `FOR UPDATE` pattern as AC-3 step 4, scoped to one project) → `409 { code: "last_owner", message: "Cannot remove the last owner of a project" }`.
5. **Delete:** `DELETE FROM project_memberships WHERE project_id = :projectId AND user_id = :userId`.
6. **Audit:** `writeHumanAuditEntryOrFailClosed(..., eventType: 'project.member_removed', resourceType: 'project_membership', resourceId: params.userId, payload: { projectId, removedRole: targetMembership.role })`.
7. Return `204`.

**SecureRoute security:**
```typescript
security: {
  minimumRole: 'member', // broad floor — real authorization is the in-handler project/org role check (step 3)
  requireMfa: true,
  writeAuditEvent: false,
  rateLimit: { max: 30, timeWindowMs: 60_000, key: 'DELETE /api/v1/projects/:projectId/members/:userId' },
}
```

**Edge case — self-removal by a non-owner project admin (allowed, D4):** an `admin`-role member removing themselves from a project they don't own — succeeds, `204`, no last-owner conflict (they're not `owner`).

**Edge case — self-removal by the sole owner (blocked, D5 applies regardless of self vs. other):** `409 { code: "last_owner" }` — the guard does not special-case self-removal; "leaving a project you solely own" is exactly as forbidden as "removing someone else who solely owns it."

**Edge case — an org `viewer` who is also a project `admin` for this specific project:** `isOrgAdminOrOwner` is `false` but `isProjectAdminOrOwner` is `true` — request **succeeds** (the whole point of D1's per-project axis).

**Edge case — target not a member of this project at all:** `404 { code: "membership_not_found" }`.

**Edge case — cross-org `projectId`:** RLS makes step 2's lookup return zero rows → `404` (never `403`).

**And** integration tests cover: success via project-admin caller, success via org-admin override (caller has no project-level role at all but org role `admin`), self-removal-allowed (non-owner), self-removal-blocked (sole owner), sole-owner-block (removing someone else), membership-not-found `404`, insufficient-role `403` (caller is project `member`/`viewer` and org `member`/`viewer`), cross-org `404`.

---

### AC-6: POST `/api/v1/projects/:projectId/transfer-ownership` — Transfer Project Ownership

**Given** the caller is the project `owner`, **or** the org `owner` (D1, matches 4.4's exact `isProjectOwner || isOrgOwner` pattern — note: **not** `isOrgAdminOrOwner`; only the org `owner`, not `admin`, gets the override here, since FR4 scopes this action to "Project Owners" specifically),
**When** they call `POST /api/v1/projects/:projectId/transfer-ownership` with `{ newOwnerId }`,
**Then** the new owner's `project_memberships.role` becomes `'owner'` and the previous owner's becomes `'admin'`, atomically.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/transfer-ownership
Cookie: access-token=<jwt>
Content-Type: application/json

{ "newOwnerId": "cccccccc-0000-4000-8000-000000000003" }
```

**Successful response (`200 OK`):**
```json
{
  "data": {
    "projectId": "00000000-0000-4000-8000-000000000010",
    "previousOwnerId": "aaaaaaaa-0000-4000-8000-000000000001",
    "newOwnerId": "cccccccc-0000-4000-8000-000000000003"
  }
}
```

**Handler flow (exact order):**

1. **Validate** `projectId` (`z.uuid()`) and body `{ newOwnerId: z.uuid() }` → `422` on malformed.
2. **Caller authorization (D1):** load caller's `project_memberships.role` for `projectId` (inline query, same pattern as AC-5 step 3). `isProjectOwner = callerMembership?.role === 'owner'`; `isOrgOwner = secureCtx.auth.orgRole === 'owner'`. Neither → `403 { code: "insufficient_role", message: "Only the project owner can transfer ownership" }`.
3. **Self-transfer no-op rejection:** `body.newOwnerId === secureCtx.auth.userId` → `422 { code: "invalid_new_owner", message: "Cannot transfer ownership to yourself" }` (this is a request-shape problem, not an authz problem — `422`, not `403` or `409`).
4. **Target eligibility (AC-E4c, `epics.md:1422`):** `newOwnerId` must already be an **accepted** `project_memberships` row for this project (not merely invited): `SELECT role FROM project_memberships WHERE project_id = :projectId AND user_id = :newOwnerId AND org_id = :orgId`. Zero rows → `404 { code: "not_a_project_member", message: "Target user is not a member of this project" }` — this correctly rejects both "never invited" and "invited but not yet accepted" (a pending invite has no `project_memberships` row at all until acceptance, confirmed by Story 4.1's AC-3/AC-4).
5. **Atomic transfer, race-safe (mirrors 4.4's `isNull(archivedAt)` conditional-update idempotency pattern):**
   ```typescript
   const [demoted] = await secureCtx.tx
     .update(projectMemberships)
     .set({ role: 'admin' })
     .where(and(
       eq(projectMemberships.projectId, params.projectId),
       eq(projectMemberships.userId, secureCtx.auth.userId), // the CALLER, not necessarily an org-owner override target
       eq(projectMemberships.role, 'owner'), // <-- race guard: only succeeds if caller is still the owner right now
     ))
     .returning({ userId: projectMemberships.userId })

   // If the caller was an org-owner override (not the project owner themselves), there is no
   // "demote the caller" step — instead demote whoever currently holds project 'owner'. Resolve
   // the *current* owner's userId from the AC-6 step 2 project_memberships row lookup (not
   // necessarily secureCtx.auth.userId) before this update, and condition the WHERE on that
   // resolved owner's userId + role = 'owner' for the same race-safety guarantee.

   if (!demoted) {
     return reply.status(409).send({ code: 'ownership_already_changed', message: 'Project ownership changed concurrently — reload and retry' })
   }

   await secureCtx.tx
     .update(projectMemberships)
     .set({ role: 'owner' })
     .where(and(eq(projectMemberships.projectId, params.projectId), eq(projectMemberships.userId, params.newOwnerId)))
   ```
   **Concurrency note (explicit, since the snippet above simplifies for the common case):** resolve the *current* owner's `userId` from a fresh `SELECT ... FOR UPDATE` on `project_memberships WHERE project_id = :projectId AND role = 'owner'` at the start of step 5, then condition the demotion `UPDATE` on `(projectId, userId = <that resolved id>, role = 'owner')`. This makes the race-safety correct whether the caller is the owner themselves or an org-owner acting on their behalf. Two concurrent `transfer-ownership` calls for the same project: the first to commit wins; the second's conditional `UPDATE` affects 0 rows (the owner role was already moved) → `409`.
6. **Audit:** `writeHumanAuditEntryOrFailClosed(..., eventType: 'project.ownership_transferred', resourceType: 'project', resourceId: params.projectId, payload: { previousOwnerId: <resolved current owner>, newOwnerId: body.newOwnerId })`.
7. Return `200`.

**SecureRoute security:**
```typescript
security: {
  minimumRole: 'member', // broad floor — real authorization is the in-handler project/org-owner check (step 2)
  requireMfa: true,
  writeAuditEvent: false,
  rateLimit: { max: 10, timeWindowMs: 60_000, key: 'POST /api/v1/projects/:projectId/transfer-ownership' },
}
```

**Edge case — target is a pending invitee, not yet accepted:** `404 { code: "not_a_project_member" }` (step 4) — matches AC-E4c exactly: *"target must be an existing accepted member of the project (not a pending invite)."*

**Edge case — target is already the owner (no-op transfer attempt):** step 4's lookup finds `role: 'owner'` already — this is not explicitly forbidden by any AC, but step 5's conditional update would demote-then-promote the same user, which is harmless but pointless. Add an explicit early check: `targetMembership.role === 'owner'` → `409 { code: "already_owner", message: "User is already the project owner" }`, avoiding a confusing audit entry that claims a transfer happened when nothing changed.

**Edge case — concurrent transfer-ownership calls with two different target new-owners:** both callers pass step 2/4 (both read the current owner as the same person before either commits); step 5's conditional demotion succeeds for exactly one (first to commit); the loser gets `409 { code: "ownership_already_changed" }` and must retry against the new state.

**Edge case — org-owner-override transfer where the org owner is not a member of the project at all:** allowed — `isOrgOwner` alone satisfies step 2's authorization even with no `project_memberships` row for the caller; step 5's demotion still targets the *actual current project owner*, not the caller.

**And** integration tests cover: happy path (project-owner-initiated), happy path (org-owner-override-initiated, caller has no project membership), non-accepted-member target `404`, non-owner-and-non-org-owner caller `403`, self-transfer `422`, already-owner target `409`, concurrent-transfer race `409` (use two overlapping transactions / advisory delay to force the interleaving deterministically in the test), cross-org project `404`.

---

### AC-7: Audit Events and Route Classifications

**Given** four new mutation events are introduced,
**When** Story 4.2 is implemented,
**Then** add to `packages/shared/src/constants/audit-events.ts` — **both** the `AuditEvent` object **and** the separate `AuditEventType` string union (the file has two parallel definitions that must stay in sync, confirmed by reading the file):

```typescript
// Added to the AuditEvent object:
ORG_USER_REMOVED: 'org.user_removed',
PROJECT_MEMBER_ROLE_CHANGED: 'project.member_role_changed',
PROJECT_MEMBER_REMOVED: 'project.member_removed',
PROJECT_OWNERSHIP_TRANSFERRED: 'project.ownership_transferred',

// Added to the AuditEventType union:
| 'org.user_removed'
| 'project.member_role_changed'
| 'project.member_removed'
| 'project.ownership_transferred'
```

**And** add to `apps/api/src/lib/route-exemptions.ts` `ROUTE_ACTION_CLASSIFICATIONS`:

```typescript
'GET /api/v1/org/users': {
  action: 'read',
  auditOmissionReason: 'Org user list read is admin-scoped and does not reveal secret values.',
  reviewer: SECURITY_OWNER,
},
'DELETE /api/v1/org/users/:userId': {
  action: 'security-action',
  auditEvent: 'org.user_removed',
  sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'PUT /api/v1/org/users/:userId/projects/:projectId/role': {
  action: 'mutation',
  auditEvent: 'project.member_role_changed',
  sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'DELETE /api/v1/projects/:projectId/members/:userId': {
  action: 'mutation',
  auditEvent: 'project.member_removed',
  sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'POST /api/v1/projects/:projectId/transfer-ownership': {
  action: 'security-action',
  auditEvent: 'project.ownership_transferred',
  sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
```

**And** none of these four routes should be added to `MFA_ENROLLMENT_EXEMPT_ROUTES` (`packages/shared/src/constants/mfa-exempt-routes.ts`) — they all set `security.requireMfa: true` directly (D2), matching the precedent of the one existing exempt-adjacent org route (`DELETE /org/users/:userId/sessions`, also not exempted).

**Edge case — audit write failure mid-transaction:** per the existing fail-closed contract (`SecureRoute`'s `AuditWriteError` handling, `secure-route.ts:403-431`), if `writeHumanAuditEntryOrFailClosed` throws, the entire transaction (including the membership deletion/update and, for AC-3, the session revocation) rolls back and the client receives `503 { code: "audit_write_failed" }` — no route in this story may complete a mutation without its audit row. Verify this with a forced-failure integration test (mock `getAuditKey()` or the audit table insert to throw) for at least one of the four routes.

**And** integration test: `route-audit.test.ts` (or equivalent static route-coverage test) passes with all four new routes classified.

---

### AC-8: Route Registration and OpenAPI Regeneration

**Given** the new routes are added to existing files (`modules/org/routes.ts`, `modules/projects/routes.ts` — no new module directory, per Architecture Conflict Resolution),
**When** Story 4.2 is implemented,
**Then**:

- `GET /users`, `DELETE /users/:userId`, `PUT /users/:userId/projects/:projectId/role` are added to `orgRoutes()` in `apps/api/src/modules/org/routes.ts` (already mounted at `/api/v1/org` in `apps/api/src/app.ts:190` — no `app.ts` change needed for these three).
- `DELETE /:projectId/members/:userId`, `POST /:projectId/transfer-ownership` are added to `projectRoutes()` in `apps/api/src/modules/projects/routes.ts` (already mounted at `/api/v1/projects` in `apps/api/src/app.ts:193` — no `app.ts` change needed for these two either).
- New Zod schemas live in the existing `modules/org/schema.ts` (extend, reusing the existing `OrgUserParamsSchema` for the `userId`-only param shape; add `OrgUserProjectRoleParamsSchema` and `ProjectRoleChangeBodySchema`) and `modules/projects/schema.ts` (add `ProjectMemberParamsSchema` and `TransferOwnershipBodySchema`).
- Response schemas are added and enforced (never rely on the handler alone to omit sensitive fields — this codebase's convention, per Story 4.1's `ProjectCreateResponseSchema` precedent, is that response schemas are the actually-enforced contract).
- Run `pnpm --filter api generate-spec` and confirm `packages/shared/openapi.json` picks up all five new routes; confirm `web#typecheck` (which depends on `api#generate-spec` per the turbo task graph) has no new type errors.

**Edge case — `generate-spec.ts`'s mocked-DB app factory:** confirm the five new routes register cleanly against `createApp({ logger: false })` with no `dbPool` (the existing `generate-spec.ts` pattern, `architecture.md:357`) — they must not perform any DB access at route-registration time (only inside handlers), which is already guaranteed by following the existing `secureRoute()` idiom exactly.

---

### AC-9: Web Application

**Org-wide user management page** — new route `apps/web/src/routes/(app)/settings/users/+page.svelte` + `+page.server.ts`, linked from the existing `/settings` landing page (`apps/web/src/routes/(app)/settings/+page.svelte`) alongside the existing "Notifications" list item, following the exact same `<li><a href={resolve('/settings/users')}>...` pattern:
- Table columns: email (used as `displayName`, D3), org role, per-project role chips (e.g. "Payments API: admin").
- Per-row: a role-change control per project chip (only rendered for projects where the *viewing* admin has permission to change it — i.e., every project, since this page is org-admin-gated) calling `PUT /org/users/:userId/projects/:projectId/role`; a "Remove from organization" button (org `admin`+ only, calling `DELETE /org/users/:userId`) with a confirm dialog that states the session-revocation consequence explicitly (matches the persona journey step 3 wording).
- **Honest error surfacing (G3 — product surface contract):** a `409 sole_owner_of_projects` response must render the blocking project names inline (e.g. "Jordan owns 1 project (Payments API) — transfer ownership before removing") rather than a generic error toast — this is the exact scenario the API's structured `409` payload exists to support.
- Page is gated: `+page.server.ts` checks `locals.orgRole` is `admin`/`owner` (mirrors the existing `members/+page.server.ts` `canManage` pattern) and redirects or shows an access-denied state otherwise — never a raw 403 from an unguarded fetch.

**Extended project members page** (`apps/web/src/routes/(app)/projects/[projectId]/members/+page.svelte`, currently only lists **pending invitations** — confirmed by reading the file) gains:
- An **accepted members** section (new — this page currently has no accepted-member list at all) fetching from... **note:** there is no dedicated "list accepted members for one project" endpoint in this story or any prior one; the closest available data source is this story's own `GET /api/v1/org/users` (org-wide) filtered client-side to this `projectId`, **or** add a lightweight reuse of the project detail's existing membership join (`modules/projects/routes.ts`'s `GET ''` list route already returns `role` for the *current* user only, not all members). **Decision for this story:** reuse `GET /api/v1/org/users` and filter its `projects` array to the current `projectId` on the client — do not add a sixth backend endpoint just for this view; the org-wide endpoint already contains everything needed and this page is already gated to admin-level users who are authorized to call it.
- Per-member: role-change dropdown (`admin`/`member`/`viewer`, disabled/hidden for the current owner row — must use transfer-ownership instead, D5/D6) calling `PUT /org/users/:userId/projects/:projectId/role`; a remove button calling `DELETE /projects/:projectId/members/:userId`; a "Transfer ownership" action (visible only to the current project owner or an org owner) opening a member picker that calls `POST /projects/:projectId/transfer-ownership`.
- **Last-owner UX:** attempting to remove or demote the sole owner surfaces the `409` message inline near that row, not a generic toast (same G3 honesty rule as the org-wide page).

**Navigation truth (G3):** confirm `resolve('/settings/users')` resolves to a real SvelteKit route before wiring the link (no dead link) — verified by the route file actually existing at `apps/web/src/routes/(app)/settings/users/+page.svelte`.

**Edge case — a viewer/member visiting `/settings/users` directly via URL:** `+page.server.ts` must redirect (or render an honest access-denied state) rather than attempting the fetch and surfacing a raw `403` — matches the `canManage`-gating precedent already established on the members page.

**And** integration/component tests cover: org-users page renders the table and role chips, role-change control calls the PUT endpoint and updates optimistically or via `invalidateAll()` (matching the existing invitations page's `invalidateAll()` pattern), remove-from-org confirm dialog flow, sole-owner-block message rendering, project members page accepted-member list + role change + remove + transfer-ownership flow, non-admin redirect/access-denied on both pages.

---

## Tasks / Subtasks

- [ ] **Task 1: Schema verification** (AC-1) — confirm no migration needed; optionally add the perf index if you choose to (verify next journal number if so)
- [ ] **Task 2: `GET /api/v1/org/users`** (AC-2) — batched query, response schema, route classification
- [ ] **Task 3: `DELETE /api/v1/org/users/:userId`** (AC-3, D4, D5) — self-mod check, sole-owner guard (`FOR UPDATE`), cascade delete, `revokeAllUserSessionsInOrg()` reuse, audit
- [ ] **Task 4: `PUT /api/v1/org/users/:userId/projects/:projectId/role`** (AC-4, D4, D5, D6) — self-mod check, elevation check (`roleRank()` reuse), owner-target guard, schema excludes `'owner'`, audit
- [ ] **Task 5: `DELETE /api/v1/projects/:projectId/members/:userId`** (AC-5, D1, D5) — in-handler project/org role check, sole-owner guard, audit
- [ ] **Task 6: `POST /api/v1/projects/:projectId/transfer-ownership`** (AC-6, D1) — in-handler owner check, accepted-member validation, race-safe atomic transfer, audit
- [ ] **Task 7: Audit events + route classifications** (AC-7) — `audit-events.ts` (both the object and the type union), `route-exemptions.ts` entries for all 4 mutation routes + 1 read route
- [ ] **Task 8: Route registration + OpenAPI regen** (AC-8) — extend `modules/org/routes.ts`/`schema.ts` and `modules/projects/routes.ts`/`schema.ts`; `pnpm --filter api generate-spec`; confirm `web#typecheck`
- [ ] **Task 9: Web app — org users page** (AC-9) — `/settings/users` route, link from `/settings`, table + role-change + remove-from-org UI
- [ ] **Task 10: Web app — extended project members page** (AC-9) — accepted-member list (derived from `GET /org/users` filtered client-side), role change, remove, transfer-ownership UI
- [ ] **Task 11: Integration test suite** — all cases listed across AC-2 through AC-7 (list, org-removal incl. session-revoke + sole-owner + self-block, role-change incl. elevation + self-block + owner-target, project-member-removal incl. project-admin + org-admin-override + self-removal + sole-owner-block, transfer-ownership incl. race + non-accepted-member + self-transfer + already-owner, audit-write-failure rollback)
- [ ] **Task 12: Route audit + OpenAPI regen verification** — confirm `route-audit.test.ts` (or equivalent) passes with all 5 new routes classified

---

## Dev Notes

- **The role-elevation check in AC-4 (Task 4) is currently unreachable through the HTTP layer**, exactly like Story 4.1's equivalent NFR-SEC10 guard on invite creation — `minimumRole: 'admin'` (rank 2) is the floor to reach the handler, and the settable target roles (`admin`/`member`/`viewer`, max rank 2) can never exceed an `admin`-or-higher caller's own rank. Keep the guard anyway (defensive infrastructure for if `minimumRole` is ever loosened or a higher settable role is added) and do not attempt to fabricate a passing test for the unreachable branch — document it in your Completion Notes the same way 4.1 did, so a reviewer isn't surprised by its absence from the test suite.
- **The "last owner" guard (D5) is genuinely new infrastructure** — there is zero precedent in the codebase. Get this right with real `FOR UPDATE` locking; a naive read-then-write without locking is a real, exploitable race (two admins racing to remove/demote the same sole owner from two different browser tabs).
- **Watch the `secureCtx.tx.execute(sql\`...\`)` escape hatch (AC-3 step 4):** this codebase's convention is Drizzle query-builder calls, not raw SQL, wherever the builder can express the query. The sole-owner-across-all-projects check in AC-3 involves a correlated `NOT EXISTS` subquery that may be awkward in the builder — using `sql\`...\`` with `tx.execute()` is acceptable here (this codebase already uses `sql\`\`` fragments for `CHECK` constraints and `set_config()` calls), but keep it to this one query; do not reach for raw SQL as a first resort elsewhere in this story.
- **`revokeAllUserSessionsInOrg()` already writes its own audit rows** (one `SESSION_REVOKED` entry per revoked session) via its own internal path — do not also try to audit-log the session revocation yourself in AC-3's handler; only add the `org.user_removed` entry for the membership removal itself.
- **`project_memberships` has no `updatedAt` column** (confirmed by reading the schema — only `createdAt`). AC-4's role-change `UPDATE` and AC-6's ownership-transfer `UPDATE` therefore do not (and cannot) set an `updatedAt` timestamp; do not add one without a migration, and do not assume one exists when writing response serialization.
- **Do not build the shared project-role resolver** this is the third story to defer it (D8) — copy the inline query pattern with the pointer comment specified in D8/AC-5 so the pattern's frequency is visible to whoever eventually extracts it.

### Project Structure Notes

- No new module directory. `modules/org/routes.ts` gains 3 routes (from 2 to 5); `modules/org/schema.ts` gains 2-3 new schemas. `modules/projects/routes.ts` gains 2 routes (from 5 to 7); `modules/projects/schema.ts` gains 2 new schemas.
- New web route: `apps/web/src/routes/(app)/settings/users/` (new directory, mirrors the existing `apps/web/src/routes/(app)/settings/notifications/` sibling exactly — `+page.server.ts` + `+page.svelte`, no separate model file needed unless the role-change/remove logic grows complex enough to warrant one, matching the notification settings precedent).
- Extended web route: `apps/web/src/routes/(app)/projects/[projectId]/members/+page.svelte` and `+page.server.ts` (both modified, not replaced — the existing pending-invitations UI from Story 4.1 stays; this story adds the accepted-members section alongside it).
- New API client functions: extend `apps/web/src/lib/api/` with an `org-users.ts` file (mirrors `invitations.ts`'s shape: typed request/response types + thin `apiFetch` wrappers) covering `listOrgUsers`, `removeOrgUser`, `changeProjectRole`, `removeProjectMember`, `transferOwnership`.
- No detected conflicts with in-flight work — Story 3.4 (`review`) and Story 4.4 (`ready-for-dev`) touch different modules (`notifications`, and no live archival code respectively) and do not overlap this story's file set.

### References

- Epics AC: [Source: `_bmad-output/planning-artifacts/epics.md#Story-4.2` (lines 1460-1486)]
- PRD: [Source: `_bmad-output/planning-artifacts/prd.md` FR4 (l.847), FR5a (l.848), FR5b (l.849), FR5c (l.850), FR62 (l.856), FR84 (l.964), NFR-SEC10 via `epics.md:174`]
- AC-E4c (ownership transfer eligibility): [Source: `_bmad-output/planning-artifacts/epics.md:1422`]
- MFA Policy Matrix (D2 rationale): [Source: `_bmad-output/planning-artifacts/mfa-policy-matrix.md:38`]
- Prior art for `roleRank()`/NFR-SEC10 elevation check: `apps/api/src/lib/secure-route.ts:177-188`, `apps/api/src/modules/invitations/routes.ts:15,164`
- Prior art for FR84 session revocation (reused directly, not reimplemented): `apps/api/src/modules/auth/session-revoke.ts:266-290`, `apps/api/src/modules/org/routes.ts:30-69`
- Prior art for project-owner in-handler check + race-safe conditional update: `_bmad-output/implementation-artifacts/4-4-project-archival.md` AC-2 (lines 164-200)
- Prior art for `writeHumanAuditEntryOrFailClosed` and fail-closed audit semantics: `apps/api/src/lib/audit-or-fail-closed.ts`, `apps/api/src/lib/secure-route.ts:403-431`
- Prior art for the invite-role-enum exclusion pattern (D6 precedent): `_bmad-output/implementation-artifacts/4-1-team-invitations-and-role-assignment.md` AC-1 (`project_invitations_role_check`)
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]
- Downstream dependents: `_bmad-output/implementation-artifacts/4-4-project-archival.md` (its "no new members after archive" guard protects this story's `DELETE /projects/:projectId/members/:userId` route — re-read 4.4's Epic Cross-Story Context after finishing 4.2 to confirm nothing drifted); Story 4.3 (Account Deactivation, not yet created — will introduce `org_memberships.status = 'deactivated'`, a distinct lifecycle from this story's outright membership deletion, per D7)

---

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
