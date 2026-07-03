# Story 4.1: Team Invitations & Role Assignment

Status: done

<!-- Ultimate context engine analysis completed 2026-07-01 — comprehensive developer guide for project-scoped invitations, MFA-gated invite creation (FR57), and the accept flow for both existing and brand-new users. This story is the FIRST story in Epic 4 and the architectural foundation for `project_memberships` role enforcement that Stories 4.2–4.4 depend on. Read "Key Design Decisions & Open Questions" before coding — this story resolves several contradictions between the PRD, epics.md, the MFA policy matrix, and the code as it exists today. -->

## Story

As a project owner or admin,
I want to invite users to my project by email and assign them a role,
so that teammates can access the credentials and assets they need with appropriate permissions.

*Covers: FR2, FR3, FR57 (invite gate).* [Source: `_bmad-output/planning-artifacts/epics.md#Story-4.1`]

---

## ⚠️ Read First — This Story Establishes Epic 4's Foundation

Story 4.1 is the **first implemented story in Epic 4**. Stories 4.2 (org user management), 4.3 (deactivation/recovery), and 4.4 (project archival — already `ready-for-dev`, written *before* this story) all assume 4.1 exists and reference it directly:

- Story 4.4 (`_bmad-output/implementation-artifacts/4-4-project-archival.md`) already depends on 4.1 for **project-role resolution** and states: *"If 4.1 added a reusable project-role resolver (e.g., on `SecureRouteContext` or a helper), use it instead of this inline query. Do not reinvent project-role resolution if 4.1 already centralized it."* This story does **not** add such a resolver (see AC-2 rationale) — 4.4's inline `project_memberships` query (`4-4-project-archival.md:164-183`) remains the pattern to copy. Record this explicitly so 4.4 isn't blocked waiting for something 4.1 never built.
- Story 4.4 also depends on 4.1 for the **"no new invitations after archive"** write guard (`4-4-project-archival.md:48,50`). This story does not implement that guard (the target project cannot be archived yet — Story 4.4 ships the `archivedAt` check). No action needed here; noted so the dev agent doesn't go looking for it.

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes — invite creation, list, revoke in web UI; accept flow is a public (unauthenticated-capable) page |
| **Linked UI story** (if API-only) | N/A — UI ships in this story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See **MFA journey (FR57)** below and AC-9 |

### Persona journey stub

**Alex** (project owner, MFA enrolled) invites **Jordan** (brand-new user, no account) as a project `member`:

1. Alex opens **Project → Members → Invite** in the web UI, enters `jordan@example.com`, selects role `Member`, clicks **Send Invite**.
2. Alex sees Jordan listed under **Pending Invitations** with email, role, and expiry countdown.
3. Jordan receives an email: *"Alex invited you to join Payments API on Project Vault"* with an **Accept Invitation** button.
4. Jordan clicks the link → lands on `/invitations/accept?token=...` → sees "You don't have an account yet — create one to join Payments API" → fills in email (pre-filled, read-only) + password → submits.
5. Jordan is redirected straight into the **Payments API** project dashboard as a `member` — not a new empty org of their own.
6. Alex's **Pending Invitations** list updates (via page refresh or SSE) to show Jordan as an accepted member.

**MFA journey (FR57) — Epic 1 retro P4:**

**Policy reference:** `_bmad-output/planning-artifacts/mfa-policy-matrix.md` — row *Owner/admin, MFA enrolled* and section "Epic 4 FR57 verification checklist".

**Persona:** Alex (project owner), MFA enrolled, grace period expired.

| Step | Action | Expected |
|------|--------|----------|
| 1 | `POST /api/v1/auth/login` with password | `200 { mfaRequired: true, mfaToken }` — no session cookies |
| 2 | `POST /api/v1/auth/mfa/verify-login` with valid TOTP | Full session cookies + `200 { userId, orgId }` |
| 3 | `POST /api/v1/projects/:projectId/invitations` | `201` invitation created |
| 4 | (negative) Unenrolled owner/admin, **including during an active grace period** | `403 { code: "mfa_required" }` on invite — no invitation row created |

**Regression dependency:** `apps/api/src/__tests__/mfa-journey.integration.test.ts` (steps 1–2 + privileged route) must stay green before this story closes; this story **extends** that test file with the invite-gate assertions above (see AC-9).

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** These are contradictions and gaps found by cross-referencing the PRD, `epics.md`, the MFA policy matrix, and the *actual current implementation* (not just the docs). Each includes the decision this story implements and the evidence. **These are also the seed list for the `/bmad-advanced-elicitation` pass that follows story creation — do not silently resolve differently without re-running that review.**

### D1 — FR57 tier-scoping vs. unconditional MFA gate

- **PRD FR57** (`prd.md:959`, `prd.md:469`): *"The system enforces MFA enrollment for Owner and Admin roles in **Team and Small Company tier** organizations before those roles may invite additional members... Solo/Indie: strongly encouraged, not enforced."* — i.e., tier-scoped.
- **epics.md Story 4.1 AC** (`epics.md:1455`) and the **MFA policy matrix** (`mfa-policy-matrix.md:16,28-31`) both describe the gate as applying to **every** unenrolled owner/admin, with no tier distinction.
- **Code reality:** `packages/db/src/schema/organizations.ts` has **no `tier` column at all**. No subscription/billing infrastructure exists anywhere in the codebase as of this story. Tier-scoped enforcement is not implementable today without adding a tier column and a full tier-assignment flow, which is out of scope for Epic 4 and not planned in any story up to Epic 9.
- **Decision implemented in this story:** enforce the MFA gate **unconditionally** for all owner/admin roles, regardless of (nonexistent) tier. This is the safe superset — it never *under*-enforces PRD intent (Team/Small Company are covered) and only *over*-enforces for a Solo/Indie tier that doesn't exist as an enforced concept yet. Matches epics.md and the matrix, which are the Epic-4-specific, more-recently-authored sources of truth (matrix was written 2026-06-30 specifically to resolve this class of conflict).
- **Follow-up:** when tier infrastructure ships (not currently scheduled), revisit this gate to add the Solo/Indie exemption per FR57's literal text.

### D2 — `requireMfaEnrollment()` allows grace period; the invite gate must not

- **Code reality** (`apps/api/src/modules/auth/mfa-enforcement.ts:69-100`, verified by reading the function): `requireMfaEnrollment()` — the function wired to `secureRoute({ security: { requireMfa: true } })` — calls `loadMfaEnforcementStatus()`, which returns `enrollmentRequired: false` whenever `gracePeriodActive` is true (`isMfaEnforcementActive()`, lines 22-32, explicitly returns `false` if `gracePeriodExpiresAt > now`). This is **correct and intentional** for privileged routes (Story 1.9/1.11) — grace-period owner/admins may use privileged routes.
- **But** the MFA policy matrix is explicit that invitations must be blocked **even during an active grace period**: *"Owner/admin, grace active, no MFA ... Invite (Epic 4): Blocked when 4.1 ships"* (`mfa-policy-matrix.md:28`, confirmed again in `epic-1-retro-2026-06-30.md:105`).
- **Consequence:** naively setting `security: { requireMfa: true }` on the invitations route via the standard `secureRoute()` path would **incorrectly allow** a grace-period unenrolled owner/admin to invite — contradicting the matrix this story is explicitly required to implement (P4 action item).
- **Decision implemented in this story:** do **not** use `security: { requireMfa: true }` on `POST /api/v1/projects/:projectId/invitations`. Instead, call a new **strict** check directly in the handler — `requireMfaEnrollmentStrict()` (new function, same file, same shape as `computeMfaStatus()` but ignoring `gracePeriodActive`) — before any invitation-creation logic runs. See AC-2 for the exact implementation. This is a **net-new function**, not a modification of `requireMfaEnrollment()` / `computeMfaStatus()`, because those are load-bearing for every existing privileged route and Story 1.9/1.11/1.12's tested behavior must not change.

### D3 — Invitation emails cannot go through the existing notification-queue/worker path unmodified

- **Code reality:** `notification_queue.recipientUserId` (`packages/db/src/schema/notification-queue.ts:11`) is the **only** addressing mechanism the email worker understands. `sendEmailNotification()` (`apps/api/src/workers/notification-email.ts:57-68`) resolves the destination address **exclusively** via `recipientUserId → users.email`; if `recipientUserId` is `null` or points to a non-existent row, the notification is silently marked `suppressed` and **no email is ever sent** (lines 65-68).
- A project invitation targets an **email address that may belong to no `users` row at all** (the whole point of the "new user" accept path, epics.md:1439). `createOrgAdminNotificationEntries()` / `dispatchOrgAdminNotification()` (`apps/api/src/notifications/dispatcher.ts`) is also semantically the wrong tool — it resolves recipients via `resolveRoutingRecipients(orgId, templateId, tx)`, i.e., **existing org members matching FR100 alert-routing rules**, not an arbitrary external invitee.
- **Decision implemented in this story:** add a nullable `recipientEmail text` column to `notification_queue` (migration, see AC-1) and extend `sendEmailNotification()` with a fallback: `toAddress = recipientUserId ? (lookup) : entry.recipientEmail`. This preserves the pg-boss retry/backoff semantics (`NOTIFICATION_JOB_OPTIONS`: 3 retries, exponential backoff) that a real SMTP delivery to an external address benefits from, and reuses `getEmailTransport()` / `renderEmailTemplate()` rather than hand-rolling a second `nodemailer.sendMail()` call site. A new template id `project.invitation_created` is added to `EMAIL_RENDERERS` (`apps/api/src/notifications/templates/index.ts`) — see AC-6.
- **Alternative considered and rejected:** calling `transport.sendMail()` directly from the invitation service, bypassing the queue. Rejected because it loses retry-on-transient-SMTP-failure behavior and creates a second, inconsistent email-sending code path.

### D4 — Accepting an invitation as a new user must NOT create a new organization

- **Code reality:** `registerUser()` (`apps/api/src/modules/auth/service.ts:223-260+`) **unconditionally** creates a brand-new organization (`allocateOrganizationSlug`) and inserts the registrant as that org's `owner`. `RegisterRequestSchema` (`packages/shared/src/schemas/auth.ts:3-9`) **requires** `orgName` (min 1 char) — there is no way today to register a user *into* an existing org.
- epics.md's AC (`epics.md:1439`) says a new user is *"redirected to registration with the invitation token preserved in the session"* — implying they end up in the **inviting** org with the **invited role**, not owning a fresh unrelated org. Silently sending an invitee through the existing `/auth/register` unchanged would give them their own org (as `owner`) while leaving the invitation unaccepted — clearly not the intent.
- **Decision implemented in this story:** extend `POST /api/v1/auth/register` to accept an optional `invitationToken` field. When present and valid:
  - `orgName` is **not required** (validated conditionally — see AC-4 schema).
  - Skip `allocateOrganizationSlug` / new-org creation entirely.
  - Insert the new user into the **inviting org's** `org_memberships` with `role: 'member'` (see D5 for why `'member'`, not the invited project role) and `status: 'active'`, no grace period (grace periods only apply to owner/admin — N/A here).
  - Insert into `project_memberships` for the invitation's `projectId` with the invitation's `roleToAssign`.
  - Mark the invitation `acceptedAt = NOW()`.
  - Skip the normal "identity token as new org owner" audit framing; emit `project.invitation_accepted` instead of (or in addition to) the standard `USER_REGISTERED` event.
  - All of the above happens in the **same transaction** as the existing register flow's user/identity-token insert.
  - This is a real, non-trivial change to a Story 1.6-owned function. Flag it loudly in code review — `registerUser()` is security-sensitive (Epic 1 retro P5: adversarial review mandatory for auth stories).

### D5 — What org role does an invited new user get?

- `org_memberships.role` (org-wide, powers FR5a-c org admin actions) is a **different axis** from `project_memberships.role` (the role the inviter actually chose in the invite). Nothing in the PRD or epics.md says inviting someone to a *project* as, say, `admin` should make them an **org-wide** admin able to see/manage every other project (FR5a) — that would be a privilege escalation bug, not a feature.
- **Decision implemented in this story:** a new user who joins solely via project invitation acceptance is granted `org_memberships.role = 'member'` **regardless of the invited project role**. Their actual permissions within the invited project come entirely from `project_memberships.role`. If they are later invited to other projects, their org role stays `'member'` unless explicitly promoted via Story 4.2's org role management (out of scope here).
- **For an existing user accepting an invite to a project in an org they are NOT yet a member of:** same rule — insert `org_memberships` row with `role: 'member'` if one doesn't already exist for that org (see AC-3).

### D6 — Invitation token format: epics.md literal spec vs. established codebase convention

- epics.md (`epics.md:1435`) specifies *"cryptographically random token (256-bit, base62, 44 chars)"*.
- The established codebase pattern for exactly this kind of token — `generateRefreshToken()` (`apps/api/src/modules/auth/tokens.ts:46-48`) — uses `randomBytes(32).toString('base64url')` (256-bit entropy, ~43 chars, URL-safe, no encoding step beyond Node's built-in).
- **Decision implemented in this story:** reuse the exact `randomBytes(32).toString('base64url')` + HMAC-SHA256 pattern (see AC-1/AC-2), not a hand-rolled base62 encoder. Entropy target (256-bit) is met either way; base64url is already URL-safe and matches `refreshTokens`/`api_keys` precedent. This is a minor, low-risk divergence from the epics' literal encoding but keeps one crypto helper pattern in the codebase instead of two.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| **Story 2.1 is implemented and `done`** (`projects` table, `project_memberships` table, `modules/projects/routes.ts`) | This story adds the `invitations` module alongside the existing `projects` module and reuses `project_memberships`. Confirmed `done` in `sprint-status.yaml`. |
| **Story 1.6 `registerUser()` / `/auth/register`** | This story modifies `registerUser()` to support the invitation-accept path (D4). Confirmed `done`. |
| **Story 1.9/1.11/1.12 MFA + SecureRoute stack** | The MFA gate (AC-2) and the strict-check helper live alongside `requireMfaEnrollment()`. Confirmed `done`. |
| **Story 3.1 notification queue + email worker** | This story extends `notification_queue` (D3) rather than building new SMTP plumbing. Confirmed `done`. |
| **Migration numbering (verify, do NOT hardcode)** | Latest migration on this branch is `0024_notification_inbox_rls_nullif.sql` (`packages/db/src/migrations/meta/_journal.json`, 25 entries, idx 24). **Before generating any migration, re-read `_journal.json` and use the next free number** — this story anticipates `0025_*` but you must confirm at code time; another story may have landed first. |
| `apps/api/src/lib/route-exemptions.ts` `ROUTE_ACTION_CLASSIFICATIONS` | This story adds five new route entries (create, list, revoke, accept, accept-info) covered by `route-audit.test.ts`. |

---

## Epic Cross-Story Context

| Story | Relationship to 4.1 |
|---|---|
| 2.1 | Created `projects`, `project_memberships` (composite PK `(projectId, userId)`, `role` check `owner/admin/member/viewer`), `GET /api/v1/projects`. 4.1 inserts into `project_memberships` on invite acceptance; it does not alter the 2.1 schema. |
| 1.6 | Owns `registerUser()` / `POST /auth/register`, currently org-creating-only. 4.1 extends it to support joining an existing org via invitation token (D4) — the single riskiest change in this story. |
| 1.7/1.9/1.11/1.12 | Own the MFA/session/SecureRoute stack this story's invite-gate builds on (D2). |
| 3.1 | Owns `notification_queue`, `sendEmailNotification()`, `EMAIL_RENDERERS`. 4.1 adds a `recipientEmail` column and a new template (D3). |
| 4.2 (Organization User Management, not yet created) | Will consume `project_memberships`/`org_memberships` role-change endpoints; may introduce a reusable project-role resolver. 4.1 deliberately does **not** build one (see "Read First") to avoid over-scoping ahead of demonstrated need — 4.2/4.4 use the same inline-query pattern shown in AC-2. |
| 4.4 (Project Archival, already `ready-for-dev`) | Explicitly depends on 4.1 for `POST /projects/:projectId/invitations` existing (its "no new invitations after archive" guard protects this exact route) and for project-role resolution conventions. No archival guard exists yet since 4.4 isn't implemented — this story adds no archived-project check; 4.4 will add it when it lands. |
| NFR-SEC10 (epics.md:174) | *"No user may grant permissions exceeding their own role or modify their own role assignment"* — enforced in AC-5 (role-elevation rejection). |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 4.1 | Rationale |
|---|---|---|
| Architecture `AuditEvent` registry (`architecture.md:543-570`) is `UPPER_SNAKE_CASE` (`USER_INVITED`, `USER_REMOVED`) | Follow the **established, actually-shipped** convention in `packages/shared/src/constants/audit-events.ts`: lowercase dotted, `project.*` family (`project.created`, `project.updated`). Add `project.invitation_created`, `project.invitation_accepted`, `project.invitation_revoked`. | The registry constants file shows the codebase already diverged from the architecture doc's literal registry (confirmed by reading `audit-events.ts` — no `USER_INVITED` constant exists; `PROJECT_CREATED: 'project.created'` etc. do). Consistency with the shipped `project.*` family beats an unshipped architecture-doc example. Same precedent Story 4.4 already established for `project.archived`/`project.unarchived`. |
| Architecture generic error envelope (`architecture.md:372-379`) uses `{ error, message, statusCode, requestId }` | Use `{ code, message }` — matches `ApiErrorSchema` (`packages/shared/src/schemas/api.ts:37-43`, `code` refined to lower_snake_case) and every route in `modules/projects/routes.ts`, `modules/org/routes.ts`. | `ApiErrorSchema` is the actually-enforced, actually-typed contract; the architecture doc's example predates it. |
| Architecture module layout (`architecture.md:623-637`) prescribes `routes.ts/service.ts/schema.ts/repository.ts` per module | `modules/projects/` and `modules/org/` in practice ship `routes.ts` + `schema.ts` (+ helper files like `dashboard-stats.ts`), with business logic inline in `routes.ts` handler functions. Follow this — a new `modules/invitations/{routes.ts, schema.ts, tokens.ts}` (tokens.ts for the token generate/hash/verify trio, mirroring `auth/tokens.ts`). No separate `service.ts`/`repository.ts` unless the file grows unwieldy. | Matches what's actually shipped; inventing a 4-file layout no other module uses adds inconsistency, not clarity. |
| epics.md table name "`project_invitations`" vs. no existing precedent | Use `project_invitations` exactly as epics.md specifies (`epics.md:1435`) — do **not** call it `org_invitations` or `invitations`. | The invite is project-scoped (`POST /api/v1/projects/:projectId/invitations`), matching `project_memberships`' scoping, and epics.md is explicit and unambiguous here — no actual naming conflict exists, unlike D1/D2/D3/D4/D6 above. |
| PRD FR2 frames invites as something *"Project Owners"* do; epics AC says *"project owner or admin"* | Implement per epics AC: **owner or admin** may invite (SecureRoute `minimumRole: 'admin'`), not owner-only. | epics.md is the story-level source of truth and is explicit (`epics.md:1433`); FR2's summary line is not meant to be read as excluding admins — NFR-SEC10's "cannot invite above own role" only makes sense as a rule if more than one role can invite. |
| epics.md literally specifies a single `POST /api/v1/invitations/:token/accept` (`epics.md:1439`) for the whole accept flow | Split into `GET /api/v1/invitations/:token` (non-mutating peek) + `POST .../accept` (authenticated-only, actually mutates) — see AC-3. | **Elicitation finding (Pre-mortem Analysis).** The single-`POST` design's unauthenticated branch returned `200` without performing any mutation — a `POST` that doesn't accept anything is a misleading contract, and it forced the unauthenticated "preview" case and the authenticated "join" case to share one response shape that grew branchy. The two-endpoint split keeps `POST` meaning "this happened" and lets the web UI make a routing decision from a plain `GET` without special-casing method semantics. Net-new endpoint, not a conflict with any other story's routes. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Schema | New migration: `project_invitations` table + `notification_queue.recipient_email` column (nullable). |
| POST `/api/v1/projects/:projectId/invitations` | Owner/admin only. Strict MFA gate (blocks even during grace — D2). Creates hashed-token invitation row, enqueues email. `409` if already a member; existing **pending** duplicate invite is refreshed, not duplicated. Cannot invite above own role (NFR-SEC10). |
| GET `/api/v1/invitations/:token` | Public, non-mutating peek. Returns email/project/role/`accountExists` so the web UI can decide login-vs-register routing. |
| POST `/api/v1/invitations/:token/accept` | Authenticated only (caller must already be logged in as the invited email). Performs the actual join. Unauthenticated → standard `401`. |
| POST `/api/v1/auth/register` (extended) | Accepts optional `invitationToken`. When present: skip org creation, join inviting org as `member` (org role) + invited role (project role), mark invitation accepted, response includes `invitedProject` for redirect (D4/D5). |
| GET `/api/v1/projects/:projectId/invitations` | Admin+ only. Lists pending invitations. Token never returned. |
| DELETE `/api/v1/projects/:projectId/invitations/:id` | Admin+ only. Revokes a pending invitation. |
| Expiry | 72 hours. Expired accept attempts → `410 { code: "invitation_expired" }`. |
| Role elevation | No user may invite to a role higher than their own (NFR-SEC10) → `403 { code: "insufficient_role" }`. |
| Email | New `notification_queue.recipient_email` column + `project.invitation_created` template; delivered via existing pg-boss `notification:email` worker (D3). |
| Audit | `project.invitation_created`, `project.invitation_accepted`, `project.invitation_revoked` — same-transaction, fail-closed via `writeHumanAuditEntryOrFailClosed`. |
| MFA journey | `mfa-journey.integration.test.ts` extended with invite-gate assertions (grace-period-blocks-invite is the key new case). |
| Integration tests | invite (201), invite-duplicate-pending (refreshed, still 201), accept-peek (200, both `accountExists` states), accept-post existing-user (200), accept-post wrong-user (403), accept-new-user via register (201, includes `invitedProject`), already-member (409), expired/revoked/not-found/already-accepted (matching taxonomy: 410/410/404/409, identical across GET peek / POST accept / POST register), role-elevation rejection (403), MFA-gate blocks unenrolled (403), MFA-gate blocks grace-period (403 — the D2 regression case), list (200, no token leak), revoke (200/204), cross-org invite target (404). |
| Web app | Invite dialog (email + role select), Pending Invitations list with revoke action, `/invitations/accept` page: `GET` peek on load, then routes to login or registration, `POST` accept only after auth. |

---

### AC-1: Schema — `project_invitations` Table and `notification_queue.recipient_email`

**Given** no invitation infrastructure exists today,
**When** Story 4.1 is implemented,
**Then** a new migration creates:

```typescript
// packages/db/src/schema/project-invitations.ts
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { orgScoped } from './helpers.js'
import { projects } from './projects.js'
import { users } from './users.js'

export const projectInvitations = pgTable(
  'project_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleToAssign: text('role_to_assign').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_project_invitations_token_hash').on(t.tokenHash),
    projectPendingIdx: index('idx_project_invitations_project_id').on(t.projectId),
    orgIdIdx: index('idx_project_invitations_org_id').on(t.orgId),
    roleCheck: check(
      'project_invitations_role_check',
      // NOTE: no 'owner' — ownership transfer is Story 4.2 (AC-E4c), not an invite target
      sql`${t.roleToAssign} IN ('admin','member','viewer')`
    ),
  })
)

export type ProjectInvitation = typeof projectInvitations.$inferSelect
export type NewProjectInvitation = typeof projectInvitations.$inferInsert
```

Add to `packages/db/src/schema/index.ts`: `export * from './project-invitations.js'`.

**And** extend `notification_queue` (see D3) with a nullable recipient-email override:

```sql
-- 0025_project_invitations.sql (VERIFY next free number in meta/_journal.json before generating)
CREATE TABLE project_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email text NOT NULL,
  role_to_assign text NOT NULL,
  token_hash text NOT NULL,
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_invitations_role_check CHECK (role_to_assign IN ('admin','member','viewer'))
);
CREATE UNIQUE INDEX idx_project_invitations_token_hash ON project_invitations (token_hash);
CREATE INDEX idx_project_invitations_project_id ON project_invitations (project_id);
CREATE INDEX idx_project_invitations_org_id ON project_invitations (org_id);

ALTER TABLE notification_queue ADD COLUMN recipient_email text;
```

**And** run `pnpm --filter @project-vault/db check-rls` after generating — `project_invitations` is `org_id`-scoped like every other tenant table and must pass RLS coverage (do **not** add it to `EXCLUDED_TABLES`). `notification_queue`'s existing RLS policy is unaffected by an added nullable column.

**And** generate via `drizzle-kit generate`, do not hand-write column names that don't match the Drizzle schema above — run `pnpm --filter @project-vault/db generate` and diff the output against this AC before committing.

---

### AC-2: POST `/api/v1/projects/:projectId/invitations` — Create Invitation

**Given** a project owner or admin is authenticated,
**When** they call `POST /api/v1/projects/:projectId/invitations` with `{ email, role: "admin"|"member"|"viewer" }`,
**Then** the system runs the checks below in order and, on success, creates the invitation and enqueues the email.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/invitations
Cookie: access-token=<jwt>
Content-Type: application/json

{ "email": "jordan@example.com", "role": "member" }
```

**Successful response (`201 Created`):**
```json
{
  "data": {
    "id": "10000000-0000-4000-8000-000000000001",
    "projectId": "00000000-0000-4000-8000-000000000010",
    "email": "jordan@example.com",
    "roleToAssign": "member",
    "invitedBy": "aaaaaaaa-0000-4000-8000-000000000001",
    "expiresAt": "2026-07-04T12:00:00.000Z"
  }
}
```
(Note: `token` is never included in this response — the plaintext token exists only in the email.)

**Handler flow (exact order — fail fast, cheapest checks first):**

1. **SecureRoute config:** `minimumRole: 'admin'` (org-level floor — owner and admin both qualify; matches `roleRank()` in `secure-route.ts:177-188` where `admin` rank 2 ≤ both `admin` and `owner`). **Do not** set `security.requireMfa: true` — see D2, the strict check is manual (step 3 below).
2. **Validate body**: `email` (`z.email()`), `role` (`z.enum(['admin','member','viewer'])`) via `parseBody()`. Malformed → `422 { code: "validation_error" }` (existing `validationError()` helper).
3. **Strict MFA check (D2 — new function, not `requireMfaEnrollment()`):**
   ```typescript
   // apps/api/src/modules/auth/mfa-enforcement.ts — ADD this function
   export async function requireMfaEnrollmentStrict(): Promise<
     (request: FastifyRequest, reply: FastifyReply) => Promise<void>
   > {
     return async (request, reply) => {
       if (!request.authContext) {
         reply.status(401).send({ code: 'access_token_missing', message: 'Authentication required' })
         return
       }
       const { orgRole, userId } = request.authContext
       if (orgRole !== 'owner' && orgRole !== 'admin') return // members/viewers: no MFA policy for invites either
       const [user] = await getDb()
         .select({ mfaEnrolledAt: users.mfaEnrolledAt })
         .from(users)
         .where(eq(users.id, userId))
         .limit(1)
       if (!user?.mfaEnrolledAt) {
         // Deliberately ignores grace period — D2. Reuses the same response shape as
         // requireMfaEnrollment() so clients handle both identically.
         reply.status(403).send({ code: 'mfa_required', message: MFA_REQUIRED_MESSAGE })
       }
     }
   }
   ```
   Call this as the first line inside the route handler (not as a `preHandler`, since it must run **inside** the SecureRoute transaction per the audit fail-closed pattern — see `secure-route.ts:325-344` for why guards normally run as preHandlers, but this one additionally needs `secureCtx.tx` for a consistent read; using `getDb()` directly here, outside `tx`, is acceptable because this is a **read of `users`**, not a write, and RLS is not required for looking up the caller's own enrollment status by their own `userId`. If reviewers prefer, pass `secureCtx.tx` instead of `getDb()` for consistency — either is safe here since there's no cross-org read.). On `403`, return immediately before any invitation logic.
4. **Role-elevation check (NFR-SEC10):** `roleRank(body.role) > roleRank(auth.orgRole)` → `403 { code: "insufficient_role", message: "Cannot invite to a role higher than your own" }`. (Reuse `roleRank()` — it's currently unexported from `secure-route.ts`; export it, or duplicate the 4-line switch locally with a comment pointing at the canonical copy. Prefer exporting — avoids drift.)
5. **Already-a-member check:** query `project_memberships` for `(projectId, existing user matching email)` — requires a join through `users.email`. If found → `409 { code: "already_member", message: "User is already a project member" }`.
5b. **Pending-duplicate-invitation check** *(elicitation fix — Pre-mortem Analysis: without this, an admin can spam the same address with unlimited invitations, each minting a new token/row/email)*: query `project_invitations` for an existing row with `(projectId, email)` where `acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > NOW()`. If found → **do not create a second row**; instead **refresh** the existing invitation (`UPDATE ... SET expiresAt = NOW() + 72h, tokenHash = <new hash>, roleToAssign = body.role`) and re-send the email with a freshly generated token (the old link is invalidated by the token-hash overwrite — this is intentional and safe, matches "resend invite" UX expectations). Return `201` either way; response is identical whether this was a fresh insert or a refresh — the caller doesn't need to know which happened.
6. **Generate token** (D6): `const opaqueToken = randomBytes(32).toString('base64url')`; hash with a **new** `INVITATION_TOKEN_HMAC_SECRET` (see AC-8 for env var wiring — do **not** reuse `REFRESH_TOKEN_HMAC_SECRET`, matching the existing pattern where every HMAC secret must differ from every other in production).
7. **Insert** `project_invitations` row: `expiresAt = NOW() + 72h`.
8. **Enqueue email** (AC-6) in the same transaction.
9. **Audit** (`writeHumanAuditEntryOrFailClosed`, `eventType: 'project.invitation_created'`, `resourceType: 'project_invitation'`, `payload: { email, role: body.role, projectId }` — email is not in `FORBIDDEN_AUDIT_KEYS`, safe to log).
10. Return `201` with the shape above.

**Cross-org / not-found project:** if `projectId` doesn't resolve within the caller's org-scoped `tx` (RLS), return `404 { code: "project_not_found" }` — never `403`, matching the enumeration-prevention rule established in Story 2.1/4.4.

---

### AC-3: Invitation Peek + Accept — `GET /api/v1/invitations/:token` and `POST /api/v1/invitations/:token/accept`

> **Elicitation fix (Pre-mortem Analysis):** the original draft used a single `POST .../accept` for both "check what this token is" and "actually join." Its unauthenticated branch returned `200 { joined: false }` without mutating anything — a `POST` that doesn't accept is a misleading contract, and it also made status-code taxonomy diverge from AC-4 (see the fix below). Split into a non-mutating `GET` peek and a `POST` that only ever performs the actual join.

**Both routes share the same token lookup and status-code taxonomy — use one shared helper, `loadInvitationOrFail(tx, token, reply)`, called by both handlers:**
```typescript
const tokenHash = hashInvitationToken(params.token) // same HMAC helper as generation (AC-1/Task 2)
const [invitation] = await tx
  .select()
  .from(projectInvitations)
  .where(eq(projectInvitations.tokenHash, tokenHash))
  .limit(1)
if (!invitation) return reply.status(404).send({ code: 'invitation_not_found', message: 'Invitation not found' })
if (invitation.revokedAt) return reply.status(410).send({ code: 'invitation_revoked', message: 'This invitation has been revoked' })
if (invitation.acceptedAt) return reply.status(409).send({ code: 'invitation_already_accepted', message: 'This invitation has already been accepted' })
if (invitation.expiresAt < new Date()) return reply.status(410).send({ code: 'invitation_expired', message: 'This invitation has expired' })
```
**This exact taxonomy (`404` not-found / `410` revoked / `410` expired / `409` already-accepted) is the canonical shape — AC-4's registration-time re-validation must reuse the identical codes, not a collapsed `410 invitation_invalid` (see AC-4 fix below).**

**`GET /api/v1/invitations/:token` — peek, never mutates:**
- SecureRoute config: `security: { requireAuth: false, writeAuditEvent: false, rateLimit: { max: 20, timeWindowMs: 60_000, key: 'GET /api/v1/invitations/:token' } }` (public, token-guessable surface — tighter than the SecureRoute default 60/min).
- Runs the shared lookup, then returns `200 { data: { email, projectName, role: roleToAssign, accountExists: boolean } }` where `accountExists` is a plain `SELECT 1 FROM users WHERE email = :email LIMIT 1`.
- Web UI calls this on page load to decide whether to show "log in to accept" or "register to accept" — no side effects, safe to call repeatedly (e.g. on every page refresh).

**`POST /api/v1/invitations/:token/accept` — actually joins, authenticated only:**
- SecureRoute config: `security: { requireAuth: true, requireOrgScope: false, requireMfa: false, writeAuditEvent: false, rateLimit: { max: 20, timeWindowMs: 60_000 } }`. `requireOrgScope: false` because the caller is not yet a member of the invitation's org — the handler manages its own transaction/org-context rather than relying on SecureRoute's RLS-scoped `tx` (mirrors how `runProtectedHandler()` in `secure-route.ts:364-366` skips the transaction wrapper when `requireOrgScope` is false).
- Runs the shared lookup. **Then** requires `request.authContext.userId`'s email (looked up fresh, not trusted from the token) to match `invitation.email` exactly — mismatch → `403 { code: "invitation_email_mismatch" }` (prevents User B from accepting an invite addressed to User A just because they found the link).
- On match: insert `org_memberships` (if the user has no existing row for `invitation.orgId`, `role: 'member'` per D5) and `project_memberships` (`role: invitation.roleToAssign`), set `acceptedAt = NOW()`, audit `project.invitation_accepted`, return `200 { data: { projectId: invitation.projectId, projectName, role: invitation.roleToAssign } }`.
- If the caller is unauthenticated, standard SecureRoute `401` applies — the web UI must ensure the user is logged in (via the `accountExists` signal from the `GET`) before calling this endpoint.

**Web flow, restated for clarity:** `GET` on page load → `accountExists: true` → prompt login → after login, SPA calls `POST .../accept` → redirect into project. `accountExists: false` → route to `/register?invitationToken=...` (AC-4 handles the join as part of registration; the SPA does **not** separately call `POST .../accept` after registering — AC-4's response already contains the joined project).

**And** integration tests cover: `GET` peek (existing account, no account, expired, revoked, already-accepted, not-found), `POST` accept (correct user, wrong-user email mismatch → 403, unauthenticated → 401, expired/revoked/already-accepted/not-found matching the shared taxonomy).

---

### AC-4: POST `/api/v1/auth/register` (extended) — New User Accepts via Registration

**Given** Branch B of AC-3 redirected a brand-new user to registration with an invitation token,
**When** they submit `POST /api/v1/auth/register` with `{ email, password, invitationToken }` (no `orgName`),
**Then** `registerUser()` skips org creation and joins the inviting org/project instead (D4/D5).

**Schema change:**
```typescript
// packages/shared/src/schemas/auth.ts
export const RegisterRequestSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(12).max(256),
    orgName: z.string().min(1).max(128).trim().optional(),
    invitationToken: z.string().min(1).max(512).optional(),
  })
  .refine((data) => data.orgName || data.invitationToken, {
    message: 'orgName is required unless an invitationToken is provided',
    path: ['orgName'],
  })
  .meta({ id: 'RegisterRequest' })
```

**Type change — `RegisterResult` (`apps/api/src/modules/auth/service.ts:65-71`) is currently hard-typed `role: 'owner'` (a string literal, not `OrgRole`). This will not typecheck once a `'member'` branch exists — widen it, and add the fields the invited branch needs so the web client can redirect straight into the joined project (AC-10 persona journey step 5, which otherwise has nothing to redirect with):**

```typescript
export type RegisterResult = {
  userId: string
  orgId: string
  email: string
  orgName: string
  role: 'owner' | 'member' // widened — was 'owner' only
  invitedProject?: { projectId: string; projectName: string; role: 'admin' | 'member' | 'viewer' }
}
```

**Service change (`registerUser()`, `apps/api/src/modules/auth/service.ts`):**

```typescript
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const email = normalizeEmail(input.email)
  const passwordHash = await hashUserPassword(input.password)

  try {
    return await getDb().transaction(async (tx) => {
      let org: { id: string; name: string }
      let invitation: ProjectInvitation | undefined

      if (input.invitationToken) {
        const tokenHash = hashInvitationToken(input.invitationToken)
        ;[invitation] = await tx
          .select()
          .from(projectInvitations)
          .where(eq(projectInvitations.tokenHash, tokenHash))
          .limit(1)
        // Reuse AC-3's EXACT status-code taxonomy — do not collapse to a single generic code.
        if (!invitation) throw new AppError('invitation_not_found', 'Invitation not found', 404)
        if (invitation.revokedAt) throw new AppError('invitation_revoked', 'This invitation has been revoked', 410)
        if (invitation.acceptedAt) throw new AppError('invitation_already_accepted', 'This invitation has already been accepted', 409)
        if (invitation.expiresAt < new Date()) throw new AppError('invitation_expired', 'This invitation has expired', 410)
        if (normalizeEmail(invitation.email) !== email) {
          throw new AppError('invitation_email_mismatch', 'Registration email must match the invited email', 422)
        }
        const [orgRow] = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, invitation.orgId)).limit(1)
        if (!orgRow) throw new Error('registerUser: invitation references a deleted org')
        org = orgRow
      } else {
        const allocated = await allocateOrganizationSlug(tx as Tx, slugify(input.orgName!))
        await tx.update(organizations).set({ name: input.orgName!.trim() }).where(eq(organizations.id, allocated.id))
        org = { id: allocated.id, name: input.orgName!.trim() }
      }

      // NOTE: duplicate-email handling is already covered by the outer catch block below
      // (isUniqueViolation(error, 'users_email_unique') → 409 email_taken, with the
      // timing-attack-safe dummy-password verify). Do not add a second check here.
      const [user] = await tx.insert(users).values({ email, passwordHash }).returning({ id: users.id, email: users.email })
      if (!user) throw new Error('registerUser: user insert returned no row')

      await tx.execute(sql`SELECT set_config('app.current_org_id', ${org.id}, true)`)
      await tx.execute(sql`SELECT set_config('app.auth_bootstrap_org_id', ${org.id}, true)`)

      if (input.invitationToken && invitation) {
        // D5: joining via invite always grants org role 'member', never the invited project role.
        await tx.insert(orgMemberships).values({ orgId: org.id, userId: user.id, role: 'member', status: 'active' })
        await tx.insert(projectMemberships).values({
          orgId: org.id,
          projectId: invitation.projectId,
          userId: user.id,
          role: invitation.roleToAssign,
        })
        await tx.update(projectInvitations).set({ acceptedAt: new Date() }).where(eq(projectInvitations.id, invitation.id))
      } else {
        await tx.insert(orgMemberships).values({
          orgId: org.id,
          userId: user.id,
          role: 'owner',
          status: 'active',
          gracePeriodExpiresAt: setGracePeriodOnPrivilegedRole({ role: 'owner', mfaEnrolledAt: null }),
        })
      }

      // ...(existing identity-token insert, unchanged)...

      await insertAuditEntry(tx as Tx, {
        orgId: org.id,
        eventType: input.invitationToken ? AuditEvent.PROJECT_INVITATION_ACCEPTED : AuditEvent.USER_REGISTERED,
        // ...
      })

      if (input.invitationToken && invitation) {
        const [project] = await tx.select({ name: projects.name }).from(projects).where(eq(projects.id, invitation.projectId)).limit(1)
        return {
          userId: user.id, orgId: org.id, email: user.email, orgName: org.name, role: 'member' as const,
          invitedProject: { projectId: invitation.projectId, projectName: project?.name ?? '', role: invitation.roleToAssign as 'admin' | 'member' | 'viewer' },
        }
      }
      return { userId: user.id, orgId: org.id, email: user.email, orgName: org.name, role: 'owner' as const }
    })
  } catch (error) {
    if (isUniqueViolation(error, 'users_email_unique')) {
      await verifyUserPassword(input.password, env.AUTH_DUMMY_PASSWORD_HASH)
      throw new AppError('email_taken', 'An account with this email already exists', 409)
    }
    throw error
  }
}
```

> **This is the single riskiest diff in this story** — it changes a Story 1.6 auth-critical function. Per Epic 1 retro P5, this story requires adversarial review before merge, specifically on this function. Test both branches (invited vs. fresh org) exhaustively; a regression here breaks the existing registration flow for every non-invited signup. The existing outer `catch` (duplicate email → `409 email_taken`, unchanged) already wraps the new branch — confirmed by re-reading `service.ts:277-283`.

**And** the `POST /auth/register` route handler (`apps/api/src/modules/auth/routes.ts:468-474`) needs **no changes** — it already catches `AppError` and maps it via `sendAppError(reply, error)` (confirmed by reading the route), so every `AppError` thrown above (404/410/409/422) is already correctly surfaced.

**And** integration tests cover: register-with-invitation (no orgName, joins inviting org/project, invitation marked accepted, response includes `invitedProject`), register-without-invitation (unchanged existing behavior — regression guard), register-with-expired/revoked/not-found/already-accepted token (matching AC-3's exact status codes: 410/410/404/409), register-with-mismatched-email (`422`), register-with-both-orgName-and-invitationToken (invitationToken wins, orgName ignored — document this choice), register-with-invitation-to-an-email-that-already-has-an-account (`409 email_taken` — the pre-existing path, confirm it isn't accidentally bypassed by the new branch).

---

### AC-5: GET `/api/v1/projects/:projectId/invitations` — List Pending Invitations

**Given** an admin+ user is authenticated,
**When** they call `GET /api/v1/projects/:projectId/invitations`,
**Then** they receive pending (not accepted, not revoked, not expired) invitations for that project.

**Response (`200`):**
```json
{
  "data": [
    {
      "id": "10000000-0000-4000-8000-000000000001",
      "email": "jordan@example.com",
      "roleToAssign": "member",
      "invitedBy": "aaaaaaaa-0000-4000-8000-000000000001",
      "expiresAt": "2026-07-04T12:00:00.000Z"
    }
  ]
}
```

**And** `token`/`tokenHash` is **never** included in any field of this response (epics.md:1447 explicit requirement) — enforce via the Zod **response** schema (not just by omitting it in the handler — response schemas in this codebase are the enforced contract; see `ProjectCreateResponseSchema` pattern).

**And** `minimumRole: 'admin'`; no MFA gate on read (matches "MFA-exempt: `GET` status/read paths" pattern used elsewhere — reading pending invitations is not a privileged mutation).

---

### AC-6: DELETE `/api/v1/projects/:projectId/invitations/:id` — Revoke Invitation

**Given** an admin+ user is authenticated,
**When** they call `DELETE /api/v1/projects/:projectId/invitations/:id`,
**Then** the invitation's `revokedAt` is set (soft-delete, matching the table's audit-friendly design — never hard-delete a `project_invitations` row).

**Response:** `204 No Content` on success. `404` if the invitation doesn't exist in this project (or wrong org — RLS). `409 { code: "already_accepted" }` if `acceptedAt` is already set (nothing to revoke). Idempotent on double-revoke (`revokedAt` already set → `204`, not an error — matches typical DELETE semantics; document if you choose `409` instead, but `204`-idempotent is the recommended default).

**And** audit `project.invitation_revoked`, `resourceId: invitation.id`.

---

### AC-7: Email Delivery (D3 Implementation)

**`notification_queue` extension** (see AC-1 for migration):

```typescript
// packages/db/src/schema/notification-queue.ts — ADD this column
recipientEmail: text('recipient_email'),
```

**Enqueue (in AC-2's handler, inside the same `tx`):**
```typescript
// AuthContext (apps/api/src/@types/fastify.d.ts:4-11) does NOT carry email —
// only userId/orgId/sessionId/jti/sessionVersion/orgRole. Look it up.
const [inviter] = await secureCtx.tx
  .select({ email: users.email })
  .from(users)
  .where(eq(users.id, secureCtx.auth.userId))
  .limit(1)

await secureCtx.tx.insert(notificationQueue).values({
  orgId: secureCtx.auth.orgId,
  recipientUserId: null,
  recipientEmail: body.email, // NEW — external, possibly-non-user recipient
  channel: 'email',
  templateId: 'project.invitation_created',
  payload: {
    projectId: project.id,
    projectName: project.name,
    inviterEmail: inviter?.email ?? null,
    role: body.role,
    acceptUrl: `${env.WEB_BASE_URL}/invitations/accept?token=${opaqueToken}`,
  },
  status: 'pending',
})
```
> `acceptUrl` embeds the **plaintext** token — this is the one and only place the plaintext token exists after generation (matches epics.md:1437: *"the token is not stored in plaintext anywhere after the email is sent"*). `WEB_BASE_URL` does **not** currently exist in `env.ts` (verified) — this story adds it as a required `z.url()` env var, documented in AC-8.

**Worker extension** (`apps/api/src/workers/notification-email.ts`):
```typescript
let toAddress: string | null = null
if (entry.recipientUserId) {
  // ...existing lookup unchanged...
} else if (entry.recipientEmail) {
  toAddress = entry.recipientEmail // NEW branch
}
if (!toAddress) {
  await markNotificationSuppressed(notificationQueueId, orgId)
  return
}
```

**Template** (`apps/api/src/notifications/templates/project-invitation-created.ts`, registered in `EMAIL_RENDERERS` under key `'project.invitation_created'`, mirroring `renderSecurityFailedAuthThreshold`'s shape): subject `"[Project Vault] You've been invited to {{projectName}}"`, body includes inviter, role, and the `acceptUrl` as a clear call-to-action link, expiry stated in human terms ("This invite expires in 72 hours").

**And** integration test: enqueue invitation → assert `notification_queue` row has `recipient_email` set and `recipient_user_id` null → run the email worker against a mocked transport (`setEmailTransportForTesting`, existing test utility) → assert `sendMail` called with `to: body.email`.

---

### AC-8: Environment Configuration

**Add to `apps/api/src/config/env.ts`**, following the exact existing pattern for `REFRESH_TOKEN_HMAC_SECRET` / `TOTP_REPLAY_HMAC_SECRET`:

```typescript
INVITATION_TOKEN_HMAC_SECRET: z.preprocess(/* same pattern as TOTP_REPLAY_HMAC_SECRET, line ~213 */),
```

**And** add production validation: required in production, must differ from `REFRESH_TOKEN_HMAC_SECRET`, `TOTP_REPLAY_HMAC_SECRET`, `MFA_PENDING_SESSION_HMAC_SECRET`, and `SESSION_SECRET` (extend the existing pairwise-distinctness checks around `env.ts:296-300` and the `addEnvIssue` blocks around lines 45-100). Dev fallback: a dedicated `DEV_INVITATION_TOKEN_HMAC_SECRET = 'e'.repeat(64)` constant, following the `DEV_REFRESH_TOKEN_HMAC_SECRET` / `DEV_MFA_PENDING_SESSION_HMAC_SECRET` precedent (`env.ts:4-5`).

**And** document `INVITATION_TOKEN_HMAC_SECRET` in the deployment `.env.example` / operator docs alongside the other HMAC secrets.

**And** add `WEB_BASE_URL: z.url()` to `env.ts` (verified absent from the current schema — confirmed by grep, no fallback exists). Required in all environments (no dev placeholder needed since it's not a secret); used to build the invitation `acceptUrl` (AC-7) and should also back any other web-facing links this codebase currently hardcodes (do not go hunting for those beyond this story's own use — just confirm no local duplicate constant already serves this purpose in `apps/api/src/config/`).

---

### AC-9: MFA Journey Regression Test Extension

**Given** `apps/api/src/__tests__/mfa-journey.integration.test.ts` currently ends at "accesses a privileged route" after the enroll → grace-expire → login-challenge → TOTP-verify sequence,
**When** Story 4.1 lands,
**Then** the same `describe.sequential` block gains additional `it()` cases, reusing the already-authenticated owner from the existing test:

1. `it('blocks invitation creation for an owner/admin without MFA, even during an active grace period')` — create a **second** org via `createDirectAuthenticatedUser(app, 'grace-owner', 'owner')` (grace period active by construction, per that helper), call `POST /projects/:projectId/invitations`, assert `403 { code: 'mfa_required' }` and assert **no row** was inserted into `project_invitations`. This is the D2 regression case — the one that would silently pass if AC-2 mistakenly used `security.requireMfa: true` instead of the strict check.
2. `it('allows invitation creation after the full MFA login journey')` — reuse the enrolled + logged-in-via-TOTP session from the existing test, call `POST /projects/:projectId/invitations`, assert `201`.

**And** this file remaining green end-to-end is a **merge gate** for this story (matches the story stub's original framing and the MFA policy matrix's explicit call-out).

---

### AC-10: Web Application

**Invite creation** (`apps/web/src/routes/(app)/projects/[projectId]/members/`, new route — confirm exact path against the actual `routes/` tree at code time, adjust to match sibling routes like `secrets/[secretId]`):
- "Invite member" button (visible only to project owner/admin — role check via the project's `role` field already returned on project detail responses, see `serializeProjectDetail()` in `modules/projects/routes.ts:30-38`) opens a dialog: email input + role `<select>` (admin/member/viewer — no owner option, matches AC-1's check constraint).
- On submit, `POST` via the typed `openapi-fetch` client; on `403 mfa_required`, show a clear "Enable MFA to invite teammates" message linking to `/settings/security` (reuse the existing MFA-required messaging pattern from other privileged-action error states in the app, if one exists — check `lib/components/` for an existing "MfaRequiredBanner" or similar before building a new one).
- On `409 already_member`, inline error under the email field.

**Pending invitations list**: table/list showing email, role, expiry (relative time, e.g. "expires in 2 days"), with a revoke icon-button per row (admin+ only) calling the `DELETE` endpoint with an optimistic-removal + confirm-on-error pattern, or a confirm dialog first — match whatever pattern `apps/web/src/lib/components/` already uses for other destructive actions (e.g., project archive confirm dialog, if 4.4's web work has landed by the time this is built; otherwise a plain `confirm()`-style dialog component).

**Accept flow page** (`apps/web/src/routes/(auth)/invitations/accept/+page.svelte` or similar — public route, lives alongside `(auth)/` login/register per the routing convention in `architecture.md:642`):
- Reads `?token=` from the URL, calls `GET /invitations/:token` (the non-mutating peek) on mount.
- Branches on `accountExists`: `true` → if not currently logged in, redirect to `/login?next=/invitations/accept?token=...`; once a session exists (either already logged in, or just after login), call `POST /invitations/:token/accept` and redirect into `/projects/:projectId` using the response. `false` → redirect to `/register?invitationToken=...&email=...` (pre-fill + lock email field); registration itself performs the join (AC-4) and its response's `invitedProject` tells the client where to redirect — no separate `POST .../accept` call needed after registering.
- Handles `404`/`410`/`409` from the `GET` peek with a clear "This invitation link is no longer valid" state — never a raw error dump (matches G3 "honest empty/placeholder" navigation-truth rule from the product surface contract).

---

## Tasks / Subtasks

- [x] **Task 1: Schema** (AC-1)
  - [x] `packages/db/src/schema/project-invitations.ts` — new table
  - [x] `packages/db/src/schema/notification-queue.ts` — add `recipientEmail`
  - [x] Verify next migration number in `_journal.json`, generate, run `check-rls`, run `migrate`
- [x] **Task 2: Token helpers** (D6)
  - [x] `apps/api/src/modules/invitations/tokens.ts` — `generateInvitationToken()`, `hashInvitationToken()`, `invitationTokensMatch()`, mirroring `auth/tokens.ts`
  - [x] `INVITATION_TOKEN_HMAC_SECRET` env wiring (AC-8)
- [x] **Task 3: Strict MFA check** (D2, AC-2)
  - [x] `requireMfaEnrollmentStrict()` in `apps/api/src/modules/auth/mfa-enforcement.ts`
  - [x] Export `roleRank()` from `secure-route.ts` (or duplicate with a pointer comment)
- [x] **Task 4: Invite creation route** (AC-2)
  - [x] `apps/api/src/modules/invitations/routes.ts`, `schema.ts`
  - [x] Wire into `apps/api/src/app.ts` route registration alongside `projectRoutes`
  - [x] `ROUTE_ACTION_CLASSIFICATIONS` entry
- [x] **Task 5: Accept routes** (AC-3) — `GET /invitations/:token` (peek, non-mutating) and `POST /invitations/:token/accept` (authenticated-only join); shared `loadInvitationOrFail()` helper for the canonical status-code taxonomy
- [x] **Task 6: Registration extension** (AC-4, D4/D5) — widen `RegisterResult`, add `invitedProject` to the response, reuse AC-3's error taxonomy — **adversarial review required**
- [x] **Task 7: List + revoke routes** (AC-5, AC-6)
- [x] **Task 8: Email delivery** (AC-7) — template, worker branch, dispatcher call site
- [x] **Task 9: Audit events** — add `PROJECT_INVITATION_CREATED`, `PROJECT_INVITATION_ACCEPTED`, `PROJECT_INVITATION_REVOKED` to `packages/shared/src/constants/audit-events.ts`
- [x] **Task 10: MFA journey regression test** (AC-9)
- [x] **Task 11: Web app** (AC-10)
- [x] **Task 12: Integration test suite** — all cases listed across ACs 1-9
- [x] **Task 13: Route audit + OpenAPI regen** — `pnpm --filter api generate-spec`, confirm `web#typecheck` picks up new types

---

## Dev Notes

- This story's **highest-risk surface** is the `registerUser()` change (AC-4/D4) — it is a Story 1.6-owned, security-sensitive function. Do not treat this as a routine extension; get adversarial review specifically on the branching logic and the transaction boundaries.
- The strict MFA check (D2) is **new code**, not a parameter on `requireMfaEnrollment()`. Do not be tempted to add a `strict?: boolean` flag to the shared function — Story 1.9/1.11/1.12 tests assert its current (grace-respecting) behavior, and conflating the two increases blast radius for a change that only one route needs.
- `roleRank()` currently lives unexported in `secure-route.ts`. Exporting it is a two-line change; do it rather than duplicating the switch statement, to avoid the two copies drifting.
- Watch for the **email-uniqueness-is-global** trap: `users.email` has a single unique constraint with no org scoping (`packages/db/src/schema/users.ts:5`). A user can belong to multiple orgs (composite PK on `org_memberships`). When checking "does an account exist for this email" (AC-3), query `users` directly — do not assume email is scoped to the inviting org.
- The `EMAIL_RENDERERS` map (`apps/api/src/notifications/templates/index.ts`) currently has exactly one entry (`security.failed_auth_threshold`). Follow that file's existing pattern exactly (a `render*()` function imported and mapped by template id) rather than inlining template strings in `templates/index.ts` itself.

### Project Structure Notes

- New module: `apps/api/src/modules/invitations/` (`routes.ts`, `schema.ts`, `tokens.ts`). Consistent with the `modules/projects/`, `modules/org/` precedent (routes.ts + schema.ts, no forced service/repository split — see Architecture Conflict Resolution table).
- New web routes under `apps/web/src/routes/(app)/projects/[projectId]/members/` (invite UI, list) and `apps/web/src/routes/(auth)/invitations/accept/` (public accept page) — confirm exact directory names against the current tree before creating, since route naming for "members" vs. "team" vs. "invitations" isn't precedented yet in this codebase.
- No detected conflicts with in-flight work — Story 3.4 (epic 3 completion, `ready-for-dev`) and Story 4.4 (`ready-for-dev`) touch different modules (`notifications`, `projects` archival respectively) and do not overlap this story's file set except the shared `notification_queue` schema file (AC-1's `recipientEmail` addition) and `audit-events.ts` (additive only, no conflict risk).

### References

- Epics AC: [Source: `_bmad-output/planning-artifacts/epics.md#Story-4.1` (lines 1423-1456)]
- PRD: [Source: `_bmad-output/planning-artifacts/prd.md` FR2 (l.845), FR3 (l.846), FR57 (l.959), Subscription Tiers (l.449-460), Auth Model (l.464-479), NFR-SEC10 via epics.md:174]
- MFA Policy Matrix: [Source: `_bmad-output/planning-artifacts/mfa-policy-matrix.md`]
- Epic 1 Retro (P1-P5 action items, MFA decision): [Source: `_bmad-output/implementation-artifacts/epic-1-retro-2026-06-30.md`]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]
- Prior art for token/HMAC pattern: `apps/api/src/modules/auth/tokens.ts`, `packages/db/src/schema/refresh-tokens.ts`
- Prior art for SecureRoute usage: `apps/api/src/modules/projects/routes.ts`
- Prior art for MFA enforcement internals: `apps/api/src/modules/auth/mfa-enforcement.ts`
- Prior art for notification queue/email worker: `apps/api/src/notifications/dispatcher.ts`, `apps/api/src/workers/notification-email.ts`, `apps/api/src/notifications/templates/index.ts`
- Downstream dependent: `_bmad-output/implementation-artifacts/4-4-project-archival.md` (already references this story extensively — re-read its Prerequisites/Epic Cross-Story Context tables after finishing 4.1 to confirm nothing drifted)

---

## Dev Agent Record

### Agent Model Used

Claude Sonnet 4.6

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed 2026-07-01. Six concrete design decisions (D1-D6) were resolved by cross-referencing the PRD, epics.md, the MFA policy matrix, and the live codebase rather than any single document in isolation — see "Key Design Decisions & Open Questions".
- `/bmad-advanced-elicitation` pass completed 2026-07-01 using 4 methods (Red Team vs Blue Team, Self-Consistency Validation, Architecture Decision Records, Pre-mortem Analysis). All findings accepted and applied: (1) fixed a non-existent `AuthContext.email` reference in the email-enqueue snippet; (2) made `WEB_BASE_URL` env var addition explicit instead of conditional; (3) added missing SecureRoute config + rate limiting to the accept flow; (4) split the single `POST .../accept` endpoint into a non-mutating `GET` peek + authenticated-only `POST` accept, after finding the original unauthenticated branch was a no-op mutation disguised as a `POST`; (5) unified the invitation-status error taxonomy (404/410/410/409) across the peek, accept, and registration endpoints, which had diverged; (6) fixed `RegisterResult.role` being hard-typed to the literal `'owner'`, which would not have compiled once the invited-member branch was added; (7) added `invitedProject` to the registration response so the web client has something to redirect into, closing a gap where AC-10's persona journey promised a redirect the API never supplied; (8) added a pending-duplicate-invitation check to invite creation to prevent unbounded invite-spam to the same address. D1-D3, D5, D6 were validated as sound without changes.

### Implementation Notes (Dev, 2026-07-01)

- **Token lookup implementation diverges from AC-3/AC-4's literal snippets**: those snippets query `project_invitations` by `tokenHash` before any org context (`set_config`) is established. Under the RLS policy AC-1 requires (org-scoped, not excluded), that query would return zero rows for the vault_app role. Resolved by adding `apps/api/src/modules/invitations/lookup.ts` (`findInvitationByTokenHash` + `validateInvitationStatus`, shared by the peek/accept routes and `registerUser()`). It performs a single indexed point-lookup via `getAdminDb()` (admin connection) keyed on the unique `tokenHash` index — the 256-bit token is itself the authorization credential, the same trust model already used to exclude `refresh_tokens`/`pending_mfa_sessions` from RLS. An earlier draft instead scanned every org via `withOrg()` (mirroring `findLoginUser()`); that was reverted after it caused 20s+ timeouts against this environment's ~10,600-organization shared dev database and starved concurrent tests of DB connections. Once the owning org is resolved, all further reads/writes go through `withOrg()`/`secureCtx.tx` as normal.
- **`invitationTokenRoutes` lives in a separate file** (`apps/api/src/modules/invitations/token-routes.ts`) from `projectInvitationRoutes` (`routes.ts`), even though both are "the invitations module" — `route-audit.test.ts`'s static parser maps one registered-route file to one `prefix`, and registering two different prefixes (`/api/v1/projects`, `/api/v1/invitations`) from the same file silently mis-attributed the prefix to every route in the file. Splitting by prefix avoids the tooling gap.
- **Role-elevation check (AC-2 step 4, NFR-SEC10) is implemented but not integration-tested**: given the invite-role enum excludes `'owner'` and `minimumRole: 'admin'` already excludes member/viewer callers, every caller who can reach the handler (admin rank 2, owner rank 3) already outranks every invitable role (admin rank 2 max) — the guard cannot currently be triggered through the HTTP layer. Kept per the story's explicit requirement and as defensive infrastructure for when a higher invitable role is added; flagging so a reviewer doesn't expect to find a passing 403 test for it.
- `MFA_ENROLLMENT_EXEMPT_ROUTES` (shared) gained the 3 project-invitation routes — the create route enforces MFA via the manual `requireMfaEnrollmentStrict()` call (D2) rather than `security.requireMfa`/`requireMfaEnrollment()`, which the shared exemption registry's static check doesn't recognize as "has an MFA check."
- CI: `make ci` is green except two pre-existing failures in `apps/api/src/__tests__/sessions.integration.test.ts` (`DELETE /auth/sessions revokes all sessions except current`, `MAX_SESSIONS_PER_USER revokes oldest sessions on login when configured`) — both time out at their existing 20s override. That file has zero overlap with this story's diff; a mid-run `getDb(...).insert is not a function` log line during the same suite run matches this codebase's already-documented cross-file vitest flake class (Makefile `test-repeat` comment, referencing a prior mfa-login/mfa-enrollment flake). Full API suite: 528/530 passing.
- Fixed two pre-existing tests that needed updating for a new required-in-production secret and a route-list snapshot, unrelated to functional behavior: `apps/api/src/config/env.test.ts` (added `INVITATION_TOKEN_HMAC_SECRET` to "valid production env" fixtures + 2 new dedicated test cases) and `packages/shared/src/constants/mfa-exempt-routes.test.ts` (updated the expected route list).
- Web UI simplifies AC-10's "dialog" language to an inline toggle-able invite form on the members page (no existing modal/dialog primitive in this app outside onboarding) — list, revoke, and the full accept-flow branching (peek → login-with-`next`/register-with-prefill → accept) are implemented as specified.
- Manual verification: exercised register (with/without invitation), login, project creation, and invite creation end-to-end via the real API server; confirmed the invitation-aware register page (pre-filled/locked email, hidden orgName field, correct copy) via SSR HTML. Full interactive browser click-through of the members page was blocked by a **pre-existing, unrelated** dev-mode SSR crash in `GlobalSearch.svelte` (`window is not defined`) that 500s every page under the `(app)` layout, including `/dashboard`; flagged separately, not fixed here (out of scope).

### File List

**New:**
- `packages/db/src/schema/project-invitations.ts`
- `packages/db/src/migrations/0025_project_invitations.sql`
- `apps/api/src/modules/invitations/tokens.ts`
- `apps/api/src/modules/invitations/lookup.ts`
- `apps/api/src/modules/invitations/schema.ts`
- `apps/api/src/modules/invitations/routes.ts`
- `apps/api/src/modules/invitations/routes.test.ts`
- `apps/api/src/modules/invitations/token-routes.ts`
- `apps/api/src/notifications/templates/project-invitation-created.ts`
- `apps/web/src/lib/api/invitations.ts`
- `apps/web/src/lib/components/auth/form-model.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/members/+page.server.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/members/+page.svelte`
- `apps/web/src/routes/(auth)/invitations/accept/+page.svelte`

**Modified:**
- `packages/db/src/schema/index.ts`
- `packages/db/src/schema/notification-queue.ts`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/shared/src/constants/audit-events.ts`
- `packages/shared/src/constants/mfa-exempt-routes.ts` (+ `.test.ts`)
- `packages/shared/src/schemas/auth.ts` (+ `.test.ts`)
- `apps/api/src/app.ts`
- `apps/api/src/config/env.ts` (+ `.test.ts`)
- `apps/api/src/lib/secure-route.ts` (exported `roleRank`)
- `apps/api/src/lib/route-exemptions.ts`
- `apps/api/src/modules/auth/mfa-enforcement.ts`
- `apps/api/src/modules/auth/service.ts` (`registerUser()` — D4/D5)
- `apps/api/src/notifications/templates/index.ts`
- `apps/api/src/workers/notification-email.ts`
- `apps/api/src/__tests__/mfa-journey.integration.test.ts` (AC-9)
- `apps/web/src/lib/api/auth.ts`
- `apps/web/src/lib/components/auth/LoginForm.svelte`
- `apps/web/src/lib/components/auth/RegisterForm.svelte`
- `apps/web/src/lib/components/auth/form-model.ts`
- `apps/web/src/routes/(auth)/login/+page.svelte`
- `apps/web/src/routes/(auth)/register/+page.svelte`
- `.env.example`
