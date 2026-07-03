# Story 4.3: Account Deactivation & Recovery

Status: review

<!-- Ultimate context engine analysis completed 2026-07-01 — comprehensive developer guide for org-admin account deactivation (immediate access revocation, orphan-rotation handling stub) and governed account recovery (self- and admin-initiated, password reset + optional MFA re-enrollment). This is the THIRD story in Epic 4, built directly on Story 1.7's session-revocation primitives (`revokeAllUserSessionsInOrg`, already exported and already anticipates a `'deactivation'` scope) and Story 4.1's `project_invitations` token pattern. Story 4.2 (org user management) is a sibling, not a hard prerequisite — see "Prerequisites" for the exact dependency boundary. Read "Key Design Decisions & Open Questions" before coding — several genuine ambiguities in the PRD/epics text (recovery MFA re-enrollment mechanics, audit scoping for a cross-org account event, the Epic 5 rotation-block forward dependency) are resolved there with explicit rationale, mirroring the precedent set by Story 4.4 for its Epic 7 stub. -->

## Story

As an **organization admin**,
I want **to deactivate user accounts with immediate access revocation and support account recovery for users who lose MFA access**,
so that **offboarded users are immediately locked out and locked-out users have a governed recovery path**.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story ships its own UI (recovery pages are new; the deactivate/send-link controls extend `4-2-organization-user-management`'s users page, or a minimal fallback page if 4.2 hasn't merged yet — see Prerequisites) |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Persona A — Riley (org admin), offboarding a teammate:**
1. Sam leaves the company. Riley opens **Settings → Users** (`/settings/users`, from Story 4.2; if that page doesn't exist yet, Riley uses the minimal fallback at `/settings/users/[userId]` described in Prerequisites) and finds Sam's row.
2. Riley clicks **Deactivate account**, confirms in a dialog that states the consequence explicitly ("Sam will be signed out of every session immediately and can no longer log in. Pending invitations Sam sent will be revoked.").
3. Sam's browser (open in another tab) is rejected on its very next request with `403 { code: "account_deactivated" }` — practically immediate, because `sessions.sessionVersion` is checked on every request (same mechanism as Story 1.7).
4. Sam's row shows a "Deactivated" badge. Riley can later send Sam a recovery link if Sam is reactivated by other means (see D5 — reactivation is out of scope for this story).

**Persona B — Alex (member), locked out after losing their phone (MFA device):**
1. Alex can't log in — their authenticator app was on a phone that broke, and they don't have their MFA recovery codes handy either (those exist from Story 1.8's `/auth/mfa/recover`, but Alex used their last one months ago and never regenerated).
2. Alex clicks **"Can't access your account?"** on the login page (`/login`), which routes to `/recovery` — a public page — and enters their email.
3. Alex sees a generic confirmation ("If that email is registered, we've sent a recovery link") regardless of whether the email exists (anti-enumeration — AC-11).
4. Alex clicks the emailed link, lands on `/recovery/[token]`, sets a new password, and optionally re-enrolls MFA by scanning a fresh QR code right there.
5. Alex is logged in with a fresh session; their old session(s) and old MFA enrollment are gone.

**Persona C — Riley (org admin), assisting a locked-out teammate who has no working email:**
1. Sam (still active, not deactivated) lost their MFA device and their email inbox is also inaccessible (e.g. it's an old work alias). Sam messages Riley on Slack.
2. Riley opens Sam's row in **Settings → Users** and clicks **Send recovery link** — this sends the same 15-minute link to Sam's email on file (Riley cannot bypass email delivery; if Sam truly has no access to that inbox, this story has no further path — see D6).

---

## Key Design Decisions & Open Questions

### D1 — Recovery completion's optional `totpCode`: two-call MFA re-enrollment, not a single-shot field

**Ambiguity:** `epics.md:1508` describes `POST /api/v1/auth/recovery/:token/complete` with `{ newPassword, totpCode? }` as if a fresh TOTP secret and its verification code arrive in one call. That's not achievable statelessly — a TOTP secret must be generated and *shown* to the user (QR code) before they can produce a valid code against it, exactly like Story 1.8's `POST /auth/mfa/enroll` → `POST /auth/mfa/verify-enrollment` two-step.

**Decision:** Recovery MFA re-enrollment reuses that same two-step shape, scoped to the recovery token instead of a session:
- `POST /api/v1/auth/recovery/:token/mfa/start` (public, token-authenticated) — validates the token is still live, deletes any existing `mfa_enrollments` row for the token's user (`deletePendingEnrollmentForUser`, already imported by `apps/api/src/modules/auth/session-revoke.ts:10` from `./recovery-codes.js` — reuse it, don't duplicate), generates a new TOTP secret via the same helpers `enrollMfa` uses internally (`buildOtpAuthUrl`, `buildQrCodeSvg` in `apps/api/src/modules/auth/mfa.ts:152,205-210`), and returns `{ otpauthUrl, secret, qrCodeSvg }`. It does **not** call `enrollMfa(authContext, ...)` directly because that function requires a full `AuthContext` tied to an active session (`apps/api/src/modules/auth/mfa.ts:156`), which a recovering user by definition does not have — build the `mfa_enrollments` insert directly (status `'pending'`), following the same shape as `enrollMfa`'s body (lines 156–210).
- `POST /api/v1/auth/recovery/:token/complete` with `{ newPassword, totpCode? }` — if `totpCode` is present, it must verify against the **pending** enrollment created by the `mfa/start` call in the same recovery session; on success, promote it to `status: 'confirmed'` (mirrors `verifyEnrollment` in `mfa.ts:328`, but again cannot call it directly — same `AuthContext` constraint). If `totpCode` is present but no pending enrollment exists for this token's user, return `422 { code: "mfa_not_staged" }`. If `totpCode` is omitted, any existing MFA enrollment is left untouched **unless** the recovering user's org role requires MFA (owner/admin in Team/Small Company tier — Story 1.9's `requireMfaEnrollment` grace logic) — in that case, do not force enrollment inline; let the existing grace-period mechanism (`apps/api/src/modules/auth/mfa-enforcement.js`) handle it on their next privileged action, exactly as it already does for any other enrollment gap.

### D2 — Audit scoping for a cross-org account event

**Ambiguity:** `audit_log_entries.orgId` is `NOT NULL` (`packages/db/src/schema/audit-log-entries.ts:11`, via `orgScoped()`), but `users` and password/MFA state are **not** org-scoped (`packages/db/src/schema/users.ts`) — a user can belong to multiple orgs (`org_memberships`). Self-initiated recovery (AC-9) resets a single global password/MFA state that can affect every org the user belongs to.

**Decision:** For self-initiated recovery request and recovery completion, write **one `audit_log_entries` row per active `org_memberships` row** the user holds at that moment (same `eventType`, same `payload`, different `orgId` each time) — so every org's admins see the event in their own audit log, consistent with FR102's "each admin approval step" language implying org-local visibility. For admin-initiated recovery (`send-link`), only the admin's own org gets an audit row (the admin only knows about their org). Deactivation (AC-2) is single-org by design (AC-E4a, `epics.md:1420`) and only ever writes one row.

### D3 — Deactivation is scoped to one org; it is not a platform ban

Per `epics.md:1420` (AC-E4a): deactivating a user in org A does not touch their membership or sessions in org B. A user can be `active` in one org and `deactivated` in another simultaneously. `org_memberships` is keyed `(orgId, userId)` (`packages/db/src/schema/org-memberships.ts:21`) — the deactivation UPDATE always includes `WHERE org_id = :callerOrgId AND user_id = :targetUserId`.

### D4 — Reactivation is out of scope for this story

No FR in the PRD (`prd.md`) grants an explicit "reactivate a deactivated user" capability, and `epics.md:1488-1515` doesn't describe one either — deactivation there reads as a one-way offboarding action. This story does **not** add a reactivation endpoint. `org_memberships.status` can only be flipped back to `'active'` by direct database action today (an ops/runbook concern, not an application feature). This is a deliberate scope boundary, not an oversight — flag it for the PM if a future story needs it (candidate: extend Story 4.2's users page, since it already owns the user-management surface).

### D5 — Recovery vs. deactivation are unrelated lifecycle events (mirrors D-note already recorded in Story 4.2)

Story 4.2 (`_bmad-output/implementation-artifacts/4-2-organization-user-management.md:133`) already documents: *"4.3's deactivation is reversible-ish (recovery flow) and status-based... [4.2's org removal is] a different, permanent lifecycle event."* Clarifying further here: recovery (FR56) resets credentials for a **currently-active** user who lost access (forgot password / lost MFA device) — it is not a mechanism to un-deactivate a deactivated account. If a deactivated user's token is somehow used against `/auth/recovery/:token/complete`, the completion must still succeed at the credential level (their password/MFA reset), but they remain `deactivated` in that org and are still rejected at the API layer by AC-6's check — recovery only helps them if they're a member of at least one other **active** org membership, or once a future reactivation mechanism (D4) restores this one.

### D6 — No-admin / no-email boundary is a documented dead end, not a new feature

Per `epics.md:1510`: *"if no admin exists and no recovery email is accessible, recovery requires a platform operator action (Epic 9)."* This story does **not** build an Epic 9 platform-operator recovery tool. It only documents the boundary: the self-initiated recovery-request endpoint returns `404 { code: "no_admin_available" }` when the target user's org(s) have zero active admins (AC-12), and that response body includes a message pointing at the operator-action boundary. Nothing else is built for this edge case in this story.

### D7 — Rotation-block check is stubbed pending Epic 5 (mirrors Story 4.4's Epic 7 stub exactly)

`epics.md:1504` requires deactivation to block with `409 { error: "active_rotations", rotationIds: [...] }` when the target user has `in_progress` rotation workflows (FR102). **Epic 5 (Credential Rotation) has not shipped** — `sprint-status.yaml` shows `epic-5: backlog`, and there is no `rotations` table in `packages/db/src/schema/`. Building a real check against a table that doesn't exist is impossible. Following the exact precedent Story 4.4 sets for its own forward dependency on Epic 7 (`epics.md:1532`: *"the machine user API key dependency check is explicitly stubbed with a comment `// TODO: Epic 7`... returning `false` (no block) until Epic 7 is delivered"*), this story stubs the rotation check the same way:

```ts
// TODO: Epic 5 — query the `rotations` table for rows with status = 'in_progress'
// assigned to this user once Epic 5 ships. Until then, never block.
async function checkActiveRotationsForUser(
  _userId: string,
  _orgId: string,
  _tx: Tx
): Promise<{ blocked: boolean; rotationIds: string[] }> {
  return { blocked: false, rotationIds: [] }
}
```

QA must **not** sign off FR102's rotation-block guarantee as complete until Epic 5 closes this stub — same caveat pattern as Story 4.4's FR63 note.

---

## Prerequisites

| Prerequisite | Why it matters here |
|---|---|
| Story 1.7 complete — `sessions`, `revoked_tokens`, `revokeAllUserSessionsInOrg()`, `SessionRevokeScope` including `'deactivation'` | This story's deactivation (AC-2) and recovery completion (AC-8) both revoke sessions through this existing, tested primitive — do not reimplement session revocation. |
| Story 1.8/1.9 complete — `mfa_enrollments`, `mfa_recovery_codes`, `enrollMfa`/`verifyEnrollment` helpers, MFA grace-period enforcement | Recovery's optional MFA re-enrollment (D1) reuses these TOTP helpers; MFA-required-role enforcement after recovery reuses the existing grace mechanism, not a new one. |
| Story 4.1 complete — `project_invitations`, HMAC token pattern (`generateInvitationToken`/`hashInvitationToken`/`invitationTokensMatch` in `apps/api/src/modules/invitations/tokens.ts`), admin-connection point-lookup pattern (`apps/api/src/modules/invitations/lookup.ts`) | The new recovery-token table and its public lookup routes mirror this pattern exactly — same trust model (the 256-bit token is itself the authorization credential), same RLS-exclusion precedent. |
| Story 4.2 (**not** a hard blocker) — org users page at `apps/web/src/routes/(app)/settings/users/` | This story's admin-facing UI (deactivate button, send-link button) is most naturally a row action on that page. **If Story 4.2 has not merged when 4.3 implementation starts:** do not duplicate its full listing page. Build the minimal fallback described in AC-13 (a standalone `/settings/users/[userId]` detail view reachable only by direct link, with just the two buttons this story needs) so 4.3's UI ships independently and 4.2 can extend the deactivate/send-link controls into its table later without conflict. The API layer (AC-1 through AC-9, AC-12) has **zero** dependency on 4.2 either way. |
| Real PostgreSQL in integration tests | No DB mocks for deactivation/recovery flows — same standard as every prior Epic 1/4 story. |

## Epic Cross-Story Context

| Story | Relationship to 4.3 |
|---|---|
| 1.7 (JWT Session Management) | Provides `revokeAllUserSessionsInOrg()` and the `'deactivation'` session-revoke scope this story consumes for both AC-2 (deactivation) and AC-8 (recovery completion, via a new `'account_recovery'`-labelled call path — see AC-1). |
| 1.8/1.9 (MFA enrollment/recovery codes, role enforcement) | Provides the TOTP secret/QR helpers reused by D1; provides the existing `/auth/mfa/recover` endpoint (recovery-**code**-based self-service, for users who still have a code) which this story's recovery flow is explicitly *not* a duplicate of — see "Architecture Conflict Resolution" below. |
| 4.1 (Team Invitations) | Provides the opaque-token + HMAC-hash + admin-connection-lookup pattern this story's recovery tokens reuse verbatim. Also: deactivation (AC-7) revokes the target's pending `project_invitations` — same table Story 4.1 introduced. |
| 4.2 (Org User Management) | Sibling story, not a hard prerequisite (see Prerequisites). 4.2's `4-2-organization-user-management.md:133` already anticipates this story's `org_memberships.status = 'deactivated'` transition and explicitly does *not* touch it. |
| 4.4 (Project Archival) | Independent — no shared code path. Both stories independently stub a forward dependency on a not-yet-built epic (4.4 → Epic 7, 4.3 → Epic 5), using the identical stub pattern (see D7). |
| Epic 5 (Credential Rotation, not yet built) | Forward dependency for the rotation-block check (D7) — stubbed, not implemented. |
| Epic 8 (Compliance, not yet built) | FR102's "queryable via the standard audit search" requirement is satisfied automatically once Epic 8 ships search — this story only needs to write correct `audit_log_entries` rows today (schema already supports it; no stub needed here, unlike D7). |

## Architecture Conflict Resolution (Read Before Coding)

**`epics.md`'s "increment session_version on the user record" language does not apply here either** — same correction Story 1.7 already made (`1-7-jwt-session-management-and-security-controls.md:143-158`): `session_version` lives on the **`sessions`** row, not on `users`. Deactivation calls `revokeAllUserSessionsInOrg()`, which already increments it per-session. Do not add a `users.session_version` or `org_memberships.session_version` column.

**This story's recovery flow is distinct from the existing `/auth/mfa/recover` (Story 1.8/1.9) recovery-**code** flow** — do not conflate them or try to extend one into the other:

| | `/auth/mfa/recover` (existing, Story 1.8/1.9) | This story's `/auth/recovery/*` (new) |
|---|---|---|
| Precondition | User still knows their password and has an unused one-time recovery code | User has lost password, MFA device, **and** recovery codes, or wants an admin-mediated path |
| Mechanism | `{ email, password, recoveryCode }` → logs in directly, consuming the code | Emailed time-limited link → reset password (+ optional fresh MFA enrollment) |
| Session effect | Issues a new session immediately | Issues no session by itself; user logs in normally afterward with the new password |
| Table | `mfa_recovery_codes` | New `account_recovery_tokens` (AC-1) |

---

## Acceptance Criteria

### AC Quick Reference

| AC | Summary |
|---|---|
| AC-1 | Schema: `account_recovery_tokens` table, `SessionRevokeScope` extension, audit event constants, env secret |
| AC-2 | `POST /org/users/:userId/deactivate` — happy path |
| AC-3 | Deactivation authorization guards (self, hierarchy, sole-owner, not-found, cross-org) |
| AC-4 | Deactivation is idempotent-safe (already-deactivated target) |
| AC-5 | Deactivation synchronously revokes sessions (FR84/PJ3) |
| AC-6 | Deactivated user rejected at the API layer (`403 account_deactivated`) |
| AC-7 | Deactivation revokes the target's pending project invitations |
| AC-8 | Deactivation blocked by active rotation workflows — **stubbed**, see D7 |
| AC-9 | Self-initiated recovery request (`POST /auth/recovery/request`) |
| AC-10 | Admin-initiated recovery request (`POST /org/users/:userId/recovery/send-link`) |
| AC-11 | Recovery token anti-enumeration + rate limiting |
| AC-12 | No-admin boundary (`404 no_admin_available`) |
| AC-13 | Recovery token validation/peek + single-use + superseding |
| AC-14 | Recovery completion — password reset + session invalidation |
| AC-15 | Recovery MFA re-enrollment (two-step, D1) |
| AC-16 | Audit logging for every deactivation/recovery step (FR102) |
| AC-17 | Route registration, public-route exemptions, OpenAPI, RLS coverage |
| AC-18 | Web application (deactivate UI, recovery UI) |
| AC-19 | Concurrency: double deactivation, double recovery-complete |

---

### AC-1: Schema — New Table, Session-Revoke Scope, Audit Events, Secret

**Given** the codebase already has `org_memberships.status` supporting `'active'`/`'deactivated'` (`packages/db/src/schema/org-memberships.ts:26-29`, check constraint already in place — confirmed by reading the file; **no migration needed for that column**) and `sessions.sessionVersion` (`packages/db/src/schema/sessions.ts:14`),

**When** this story adds account recovery,

**Then** a new migration `packages/db/src/migrations/0026_account_recovery_tokens.sql` (numbers continue from `0025_project_invitations.sql`, the latest existing migration) creates:

```sql
CREATE TABLE account_recovery_tokens (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL,
  initiated_by     TEXT NOT NULL CHECK (initiated_by IN ('self','admin')),
  initiator_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  initiator_org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ,
  superseded_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_account_recovery_tokens_token_hash ON account_recovery_tokens (token_hash);
CREATE INDEX idx_account_recovery_tokens_user_id ON account_recovery_tokens (user_id);
CREATE INDEX idx_account_recovery_tokens_expires_at ON account_recovery_tokens (expires_at);
```

Corresponding Drizzle schema file `packages/db/src/schema/account-recovery-tokens.ts` (mirror the shape of `project-invitations.ts`), exported from `packages/db/src/schema/index.ts`.

**And** `account_recovery_tokens` is added to `EXCLUDED_TABLES` in `packages/db/src/check-rls-coverage.ts:4-18` (identity-scoped, no `org_id` column on the row itself — same reasoning already documented there for `mfa_recovery_codes`, `revoked_tokens`).

**And** `apps/api/src/modules/auth/session-revoke.ts:14-21`'s `SessionRevokeScope` union gains `'account_recovery'` as a new literal (alongside the existing `'admin_action' | 'deactivation' | 'security'` etc.), used exclusively by recovery completion (AC-14) so its audit rows are distinguishable from an admin-forced revoke.

**And** `packages/shared/src/constants/audit-events.ts` gains, in both the `AuditEvent` const object and the `AuditEventType` union (matching the existing dual-declaration pattern already used for e.g. `PROJECT_INVITATION_CREATED`):
```
ORG_USER_DEACTIVATED: 'org.user_deactivated'
ACCOUNT_RECOVERY_REQUESTED: 'auth.recovery_requested'
ACCOUNT_RECOVERY_LINK_SENT: 'auth.recovery_link_sent'
ACCOUNT_RECOVERY_COMPLETED: 'auth.recovery_completed'
ACCOUNT_RECOVERY_BLOCKED: 'auth.recovery_blocked_no_admin'
```

**And** `apps/api/src/config/env.ts` gains `RECOVERY_TOKEN_HMAC_SECRET?: string` following the exact pattern already used for `INVITATION_TOKEN_HMAC_SECRET` (`env.ts:6,24`): a `DEV_RECOVERY_TOKEN_HMAC_SECRET = 'f'.repeat(64)` dev default, and a production-mode validation block requiring it be set, non-placeholder, and different from every other HMAC secret in the file (same shape as the `TOTP_REPLAY_HMAC_SECRET` checks at `env.ts:64-76`).

**Edge case — schema drift check:** if a future change renames `org_memberships.status` or removes the `'deactivated'` value from its check constraint before this story lands, every deactivation AC below breaks at the query/constraint level. Re-run `rg "status" packages/db/src/schema/org-memberships.ts` immediately before starting Task 1 to catch drift early (same discipline Story 4.2 documents at `4-2-organization-user-management.md:192`).

---

### AC-2: `POST /api/v1/org/users/:userId/deactivate` — Happy Path

**Given** org admin Riley (`orgRole: 'admin'`) is authenticated with MFA enrolled and verified, and target user Sam has `org_memberships.status = 'active'` in Riley's org with two open sessions,

**When** Riley calls `POST /api/v1/org/users/:userId/deactivate` with `userId = Sam's id`,

**Then**, in one transaction:
1. `org_memberships.status` is set to `'deactivated'` for `(orgId: Riley's org, userId: Sam)`.
2. `revokeAllUserSessionsInOrg({ userId: Sam, orgId: Riley's org, actorUserId: Riley, reason: 'deactivation', tx })` is called (reused verbatim from `apps/api/src/modules/auth/session-revoke.ts:266-290` — do not reimplement).
3. All of Sam's pending `project_invitations` (where `invitedBy = Sam` — invitations Sam *sent*, not received) within this org are revoked (AC-7 detail).
4. `checkActiveRotationsForUser` (D7 stub) is called and, being always non-blocking today, allows the transaction to proceed.
5. One `org.user_deactivated` audit row is written via `writeHumanAuditEntryOrFailClosed` with `payload: { revokedSessionCount, revokedInvitationCount }`.

**Response `200`:**
```json
{ "data": { "userId": "sam-uuid", "revokedSessionCount": 2, "revokedInvitationCount": 1 } }
```

**And** integration test confirms Sam's two sessions are rejected on their next authenticated request (AC-6) and Sam's row in `org_memberships` shows `status: 'deactivated'`.

---

### AC-3: Deactivation Authorization Guards

**Given** the same org-role hierarchy and self-modification rules already established in Story 4.2 (D4/D9 there),

**When** any of the following are attempted:

| Scenario | Expected result |
|---|---|
| Riley (`admin`) attempts to deactivate themselves | `403 { code: "cannot_deactivate_self" }` — no state change |
| Riley (`admin`) attempts to deactivate the org's owner | `403 { code: "insufficient_role" }` — an admin may never act on an equal-or-higher role (NFR-SEC10, mirrors D9 in `4-2-organization-user-management.md:103-113`) |
| Riley (`admin`) attempts to deactivate another `admin` | `403 { code: "insufficient_role" }` — same hierarchy rule, admin-vs-admin is blocked too (matches 4.2's exact precedent) |
| Owner Jordan attempts to deactivate the org's **sole owner** (themselves, since they're the only owner) | Covered by the self-block above — this can't be reached as a distinct case since sole-owner-targeting-self is always self |
| Owner Jordan attempts to deactivate a `member` | `200` success — owner outranks member |
| `userId` does not exist, or exists but is not a member of the caller's org | `404 { code: "user_not_found" }` |
| Non-admin (`member`/`viewer`) calls the endpoint | `403 { code: "insufficient_role" }` — route requires `allowedRoles: ['admin', 'owner']` |
| Caller has not completed MFA verification (unenrolled, or enrolled but mid-login-challenge) | `403` (or the standard `mfaRequired` flow response) — route sets `security: { requireMfa: true }`, same as the one existing privileged org route (`DELETE /org/users/:userId/sessions`, `org/routes.ts:30-69`) |

**Edge case — concurrent hierarchy check under role change:** if Sam's role is being elevated to `admin` by a second admin in a concurrent transaction while Riley's deactivation call is in flight, lock the target's `org_memberships` row with `SELECT ... FOR UPDATE` before evaluating the hierarchy check and performing the update — mirrors the existing lock pattern in `4-2-organization-user-management.md:86` for its own last-owner race. The loser of the race sees a consistent, re-checked role.

---

### AC-4: Deactivation Is Idempotent-Safe

**Given** Sam's `org_memberships.status` is already `'deactivated'`,

**When** Riley calls `POST /api/v1/org/users/:userId/deactivate` again for Sam,

**Then** the endpoint returns `409 { code: "already_deactivated" }` and performs **no** mutation (no duplicate audit row, no re-attempt at session revocation — Sam has no active sessions left anyway since AC-5 already handled that the first time).

**Edge case — two admins race to deactivate the same active user simultaneously:** see AC-19 (concurrency).

---

### AC-5: Deactivation Synchronously Revokes Sessions (FR84 / PJ3)

**Given** `epics.md:1419` (PJ3): *"Account deactivation (FR45) must explicitly trigger org-level session revocation (FR84) ... as part of the deactivation transaction — not as an eventual side-effect,"*

**When** Sam is deactivated while holding an active access-token JWT with `sessionVersion: 1` matching their live `sessions` row,

**Then**, within the same transaction as the `org_memberships.status` update, `revokeAllUserSessionsInOrg` (AC-2 step 2) sets `sessions.revoked_at = NOW()`, increments `sessions.session_version`, revokes linked `refresh_tokens`, and inserts a `revoked_tokens` row keyed by `jti` — **the exact four-step sequence already documented and tested in Story 1.7** (`1-7-jwt-session-management-and-security-controls.md:149-156`). Do not write a parallel/duplicate session-revocation code path.

**And** integration test: create 2 sessions for Sam before deactivation, deactivate, then attempt an authenticated request with each of Sam's two old access-token cookies — both must return `403 account_deactivated` (AC-6), verifying both the `revoked_tokens` fast-path and the `sessionVersion` mismatch fallback independently catch it (defense in depth, same dual-check already exercised by Story 1.7's own tests).

**Edge case — Sam has zero active sessions at deactivation time (e.g., already logged out everywhere):** `revokedSessionCount: 0` in the response payload; the deactivation still succeeds (status flip + invitation revocation + audit still happen).

---

### AC-6: Deactivated User Rejected at the API Layer

**Given** Sam's `org_memberships.status = 'deactivated'` in org X, and Sam has since obtained a *new* valid session in org X somehow (e.g., a race — see AC-19),

**When** Sam makes any authenticated request scoped to org X,

**Then** the request is rejected with `403 { code: "account_deactivated" }` **in addition to** the existing JWT/`sessionVersion`/`revoked_tokens` checks — i.e., even if a session row were somehow still valid, the auth middleware (`apps/api/src/modules/auth/authenticate.ts`, per Story 1.7's file list) must also check `org_memberships.status` for the request's resolved `orgId` and reject deactivated members. This is the actual **enforcement** layer; AC-5's session revocation is defense-in-depth, not the sole gate (a session created *after* deactivation via some other org's still-valid refresh token, if the user is multi-org, must still be blocked for the deactivated org specifically).

**And** example: Sam is `active` in org Y and `deactivated` in org X (D3). A request scoped to org Y succeeds normally; the identical request re-scoped to org X (e.g., via `X-Org-Id` header or org-scoped route param, per existing org-resolution convention) returns `403 account_deactivated`.

**Edge case — deactivation happens mid-request:** if Sam's deactivation UPDATE commits *between* the auth middleware's session check and the route handler's own logic, the org-membership-status check in the auth middleware (evaluated once per request, at the start) is the authoritative gate — no route-level double-check is required beyond what the middleware already provides, since Postgres transaction isolation means Sam's in-flight request either sees the pre- or post-deactivation state consistently, never a torn read.

---

### AC-7: Deactivation Revokes the Target's Pending Project Invitations

**Given** Sam (being deactivated) had previously sent 2 pending `project_invitations` (as `invitedBy`) that are not yet accepted, revoked, or expired,

**When** Sam is deactivated,

**Then** both invitations get `revoked_at = NOW()` set in the same transaction; `POST /api/v1/invitations/:token/accept` against either token now returns `410 { code: "invitation_revoked" }` (existing `validateInvitationStatus` logic in `apps/api/src/modules/invitations/lookup.ts:43-49` already returns this for any revoked invitation — no new logic needed there, just the UPDATE from this story).

**And** the response payload's `revokedInvitationCount` reflects this count (AC-2 example: `1`).

**Edge case — Sam has zero pending invitations:** `revokedInvitationCount: 0`, no-op, no error.

**Edge case — an invitation Sam *received* (not sent) is pending when Sam is deactivated:** untouched — only invitations Sam **sent** (`invitedBy = Sam`) are revoked. An invitation addressed *to* Sam's email for a different project remains valid; if accepted after Sam's deactivation in this org, that's a *different* org/project's invitation and is out of scope for this org's deactivation (only relevant if Sam is being invited into a project in a different org — cross-org, unaffected by D3).

---

### AC-8: Deactivation Blocked by Active Rotation Workflows (FR102) — Stubbed Pending Epic 5

**Given** the D7 stub (`checkActiveRotationsForUser` always returns `{ blocked: false, rotationIds: [] }` today, since Epic 5 hasn't shipped),

**When** Riley deactivates Sam who — in a future world where Epic 5 exists — has 2 `in_progress` rotation workflows assigned,

**Then** today, deactivation **proceeds** (the stub never blocks) — this is intentional and documented, not a bug.

**And** once Epic 5 ships and `checkActiveRotationsForUser` is implemented for real: `POST /org/users/:userId/deactivate` must return `409 { code: "active_rotations", rotationIds: ["rot-1", "rot-2"] }` and perform no mutation until each rotation is cancelled, transferred to another admin, or held pending review — the chosen outcome recorded in the audit log (verbatim FR102 requirement, `epics.md:1504`). **This story does not implement that branch** — it only implements the stub function with the correct signature and a `// TODO: Epic 5` comment, so the real check can be dropped in later without touching the deactivation route's call site.

**Edge case for QA:** do not mark FR102's rotation-block guarantee `done` in any tracking document until Epic 5 closes this stub — cite this AC (mirrors the exact QA caveat Story 4.4 documents for its own FR63/Epic 7 stub).

---

### AC-9: Self-Initiated Recovery Request

**Given** Alex has an account with email `alex@example.com` and is a member of one org that has at least one active admin,

**When** an unauthenticated client calls `POST /api/v1/auth/recovery/request` with `{ "email": "alex@example.com" }`,

**Then**:
1. The email is normalized (reuse `normalizeEmail` from `apps/api/src/modules/auth/normalize.ts`, same as registration/login/invitations).
2. A new `account_recovery_tokens` row is inserted: `userId: Alex's id`, `tokenHash` (HMAC via a new `hashRecoveryToken` helper mirroring `hashInvitationToken`, using `RECOVERY_TOKEN_HMAC_SECRET`), `initiatedBy: 'self'`, `expiresAt: NOW() + 15 minutes` (per `epics.md:1506`: *"a time-limited recovery link (15 minutes)"*).
3. Any prior unused, unexpired `account_recovery_tokens` row for Alex is superseded (`superseded_at = NOW()`) — see AC-13.
4. An email is enqueued via `notificationQueue` (same insert pattern as `enqueueInvitationEmail` in `apps/api/src/modules/invitations/routes.ts`) with a new `templateId: 'auth.recovery_link_created'` containing the opaque token in the link — the opaque token itself is **never** stored, only its hash (same discipline as invitation tokens).
5. One `auth.recovery_requested` audit row is written per active `org_memberships` Alex holds (D2).

**Response (always, regardless of whether the email matched an account):** `202 { "message": "If that email is registered, a recovery link has been sent." }`.

**And** example — email does **not** match any account: identical `202` response, same latency envelope (constant-time-ish by always doing a DB lookup + no early return before the response, to avoid a timing side-channel), no token created, no email sent, no audit row.

---

### AC-10: Admin-Initiated Recovery Request

**Given** Riley (`admin`) is authenticated with MFA verified, and Sam is an active member of Riley's org,

**When** Riley calls `POST /api/v1/org/users/:userId/recovery/send-link` with `userId = Sam's id`,

**Then** the same token-creation/supersede/email-enqueue steps as AC-9 run, but with `initiatedBy: 'admin'`, `initiatorUserId: Riley's id`, `initiatorOrgId: Riley's org`, and the audit event is `auth.recovery_link_sent` (not `_requested`), written **once**, scoped to Riley's org only (D2) — not fanned out to Sam's other org memberships, since Riley only has visibility into their own org.

**Response `200`:** `{ "data": { "userId": "sam-uuid", "linkSent": true } }` — deliberately **not** silent-202 here, because the caller is an authenticated admin who already knows Sam exists (no enumeration concern for this path).

**Edge case — Sam not found / not a member of Riley's org:** `404 { code: "user_not_found" }`.

**Edge case — target user is deactivated:** allowed to proceed — sending a recovery link to a deactivated user doesn't reactivate them (D5); it's a no-op in practice unless they're active in another org, but the endpoint doesn't need to special-case this (harmless).

**Edge case — non-admin caller:** `403 { code: "insufficient_role" }` — route requires `allowedRoles: ['admin', 'owner']`, `requireMfa: true` (same pattern as `org/routes.ts:30-38`).

---

### AC-11: Recovery Token Anti-Enumeration + Rate Limiting

**Given** the self-initiated recovery-request endpoint is public (unauthenticated) and therefore a natural target for both account enumeration and abuse (mass password-reset-email spam),

**When** requests are made,

**Then**:
- `POST /api/v1/auth/recovery/request` is rate-limited by IP (`enforceRecoverRateLimit('ip:' + req.ip, 10, reply)`) and by normalized email (`enforceRecoverRateLimit('email:' + normalizedEmail, 5, reply)`) — reusing the existing `auth_rate_limit_buckets` table and `enforceRecoverRateLimit` helper verbatim from `apps/api/src/modules/auth/routes.ts:213-238`, same two-tier check order already used by `/mfa/recover` (`routes.ts:603,609`). Rate-limited requests return `429 { code: "rate_limit_exceeded", retryAfterSeconds }`.
- The response is identical (`202`, same message) whether the email exists or not (AC-9).
- `POST /api/v1/org/users/:userId/recovery/send-link` (admin path) is rate-limited too, but per-admin-action, e.g. `rateLimit: { max: 20, key: 'POST /org/users/:userId/recovery/send-link' }` via `secureRoute`'s built-in `security.rateLimit` (same shape as `org/routes.ts:36`) — this doesn't need the email/IP dual-bucket scheme since the caller is already authenticated and rate-limited per-account by the standard `secureRoute` mechanism.

**Edge case — attacker enumerates by timing:** the self-initiated endpoint always performs a full user lookup + org-membership lookup before responding, even on a miss, so response latency doesn't trivially distinguish "no such email" from "email exists, link sent" (best-effort constant-shape handling, not cryptographic constant-time — acceptable given the existing project precedent, e.g. login's own generic-error handling).

---

### AC-12: No-Admin Boundary

**Given** `epics.md:1510`'s explicit requirement, and the D6 decision that this is a documented dead end (not a new feature),

**When** `POST /api/v1/auth/recovery/request` is called with an email that **does** match an account, and **every** org that account is an active member of has **zero** active admins/owners (e.g., a single-person org whose sole owner deactivated their own... no, D3/AC-3 blocks self-deactivation — realistic trigger: the sole owner's `org_memberships.status` somehow became non-active through another path, or an org was created with only a `member`-role invite accepted and the inviting owner's account was separately closed),

**Then** the endpoint returns `404 { code: "no_admin_available", message: "This account cannot use self-service recovery. Contact your platform administrator." }` instead of the generic `202` — a deliberate, documented exception to AC-11's anti-enumeration default, accepted because it only reveals "an account with no reachable admin exists," not which email/org, and the PRD explicitly requires this boundary to be visible rather than silently swallowed. One `auth.recovery_blocked_no_admin` audit row is still written (per active org membership, D2) so this rare event is traceable.

**And** example: Alex's only org has an owner whose own `org_memberships.status` is somehow `'deactivated'` (edge state, not reachable through this story's own guards but possible via manual DB action or a future story) and no other admin/owner exists in that org → `404 no_admin_available`.

**Edge case — account belongs to 2 orgs, one with an admin and one without:** succeeds normally (AC-9 path) — only orgs *without* any active admin are excluded from consideration; as long as at least one org has a reachable admin, self-service recovery proceeds. (This is a reasonable interpretation of `epics.md:1510`'s "no admin exists" as an all-orgs condition — documented here since the PRD doesn't spell out the multi-org case explicitly.)

---

### AC-13: Recovery Token Validation, Single-Use, and Superseding

**Given** a valid, unused, unexpired `account_recovery_tokens` row exists for Alex,

**When** `GET /api/v1/auth/recovery/:token` is called (public peek, used by the web UI to decide what to render before submitting anything — mirrors `GET /api/v1/invitations/:token`'s peek role),

**Then** it returns `200 { "data": { "email": "al***@example.com", "mfaCurrentlyEnrolled": true } }` — the email is partially masked (unlike invitation peek, which shows the full invited email to the token holder who is, by construction, the intended recipient reading their own inbox link — here, masking is extra defense since a leaked/logged URL is a more direct account-takeover vector than a leaked invitation link).

**And** the same status taxonomy as `validateInvitationStatus` (`apps/api/src/modules/invitations/lookup.ts:36-61`) applies, adapted: `404 { code: "recovery_token_not_found" }` (unknown hash), `410 { code: "recovery_token_expired" }` (past `expires_at`), `409 { code: "recovery_token_used" }` (already completed), `410 { code: "recovery_token_superseded" }` (a newer request superseded it — AC-9 step 3 / AC-10).

**And** requesting a new recovery link (self or admin path) while a prior unused, unexpired token exists for the same user sets that prior row's `superseded_at = NOW()` — preventing two simultaneously-valid links for the same account (mirrors the reasoning, though not the exact mechanism, of `project_invitations`' upsert-by-pending-row pattern in `apps/api/src/modules/invitations/routes.ts:44-84`, adapted here to an insert-and-supersede shape since recovery tokens, unlike invitations, aren't naturally keyed by a stable `(projectId, email)` pair for an `UPDATE`).

**And** completion (AC-14) atomically claims the token via a conditional `UPDATE ... SET used_at = NOW() WHERE id = :id AND used_at IS NULL AND superseded_at IS NULL AND expires_at > NOW() RETURNING *` — the exact TOCTOU-safe pattern `claimInvitation` uses (`apps/api/src/modules/invitations/lookup.ts:70-87`). A `null` result from that claim means a concurrent completion or supersession won already happened — return `409 { code: "recovery_token_already_used" }`.

**Edge case — token used twice concurrently:** see AC-19.

---

### AC-14: Recovery Completion — Password Reset + Session Invalidation

**Given** Alex's recovery token is valid and unused,

**When** `POST /api/v1/auth/recovery/:token/complete` is called with `{ "newPassword": "correct horse battery staple 9!" }` (password strength validated by the same rules as registration — reuse the existing password schema/validator, do not invent a new one),

**Then**, in one transaction:
1. The token is atomically claimed (AC-13).
2. `users.passwordHash` is updated (same bcrypt hashing helper as registration/login, `apps/api/src/modules/auth/password.ts`).
3. For **every** active `org_memberships` row Alex holds, `revokeAllUserSessionsInOrg({ userId: Alex, orgId: <that org>, actorUserId: Alex, reason: 'account_recovery', tx })` is called (D2/AC-1's new scope literal) — a full account credential reset invalidates sessions everywhere, not just one org.
4. One `auth.recovery_completed` audit row per active org membership (D2).

**Response `200`:** `{ "data": { "email": "alex@example.com", "sessionsRevoked": 3 } }` — note: **no session is created by this call** (unlike `/mfa/recover`, per the "Architecture Conflict Resolution" table above); Alex must log in normally afterward with the new password.

**Edge case — user has no active sessions at all when recovering:** `sessionsRevoked: 0`, still succeeds.

**Edge case — `newPassword` fails strength validation:** `422` with the same validation-error shape used by registration, before the token is claimed (so a failed attempt doesn't burn the token — the client can retry with a stronger password using the same link, up to `expires_at`).

---

### AC-15: Recovery MFA Re-Enrollment (Two-Step, D1)

**Given** Alex's recovery token is valid, and Alex wants to re-enroll MFA because their old device is gone,

**When** Alex calls `POST /api/v1/auth/recovery/:token/mfa/start` (token still unused/unexpired — this does **not** consume the token, only `complete` does),

**Then** any existing `mfa_enrollments` row for Alex is deleted (reusing `deletePendingEnrollmentForUser`), a fresh `pending` `mfa_enrollments` row is inserted with a newly generated TOTP secret, and the response is `200 { "data": { "otpauthUrl": "...", "secret": "...", "qrCodeSvg": "<svg>...</svg>" } }` (same shape as `mfaEnrollResponseSchema`, reusing `apps/api/src/modules/auth/mfa.ts:205-210`'s helpers).

**And when** Alex then calls `POST /api/v1/auth/recovery/:token/complete` with `{ "newPassword": "...", "totpCode": "123456" }`, the code is verified against the pending enrollment from the prior call (same TOTP verification logic as `verifyEnrollment`, `mfa.ts:328`); on success the enrollment's `status` becomes `'confirmed'` and `users.mfaEnrolledAt` is set, **in the same transaction** as the password reset and session revocation (AC-14) — MFA re-enrollment is not a separate, un-atomic step from the credential reset.

**Edge case — `totpCode` submitted without a prior `mfa/start` call:** `422 { code: "mfa_not_staged" }`.

**Edge case — `totpCode` is wrong:** `422 { code: "invalid_totp_code" }`; the token is **not** consumed (Alex can retry — same "don't burn the token on a recoverable input error" principle as AC-14's password-strength edge case), but repeated wrong attempts against the same pending enrollment should be capped (reuse whatever attempt-cap convention `verifyEnrollment`/`pending_mfa_sessions` already applies elsewhere in the codebase, e.g. the "pending-token-attempt-cap" compensating control already named in `route-exemptions.ts:95` for `/mfa/verify-login`).

**Edge case — Alex omits `totpCode` entirely and their org requires MFA for their role:** completion still succeeds (password reset + session revocation happen regardless); Alex simply re-enters the existing grace-period flow on their next login/privileged action, per D1's decision — no special-casing needed here.

---

### AC-16: Audit Logging for Every Deactivation/Recovery Step (FR102)

**Given** FR102 (`epics.md:102`): *"Account recovery initiation, each admin approval step, and recovery completion are recorded in the audit log as privileged events,"*

**When** any of AC-2 (deactivation), AC-9/AC-10 (recovery request), or AC-14 (recovery completion) occur,

**Then** every one writes its audit row(s) via `writeHumanAuditEntryOrFailClosed` (or the equivalent same-transaction helper already used by `revokeAllUserSessionsInOrg` for its own `SESSION_REVOKED` rows) — **never** as a fire-and-forget after the transaction commits. If the audit write throws, the entire transaction (membership/status update, session revocation, invitation revocation, password reset) rolls back and the client receives `503 { code: "audit_write_failed" }` — the same fail-closed contract already documented for Story 4.2's routes (`4-2-organization-user-management.md:691`) and enforced by `SecureRoute`'s `AuditWriteError` handling (`secure-route.ts:403-431` per that story's citation).

**And** example payloads (illustrative, not exhaustive):
```json
// org.user_deactivated
{ "targetUserId": "sam-uuid", "revokedSessionCount": 2, "revokedInvitationCount": 1 }
// auth.recovery_requested (one row per active org membership)
{ "targetUserId": "alex-uuid", "initiatedBy": "self" }
// auth.recovery_completed
{ "targetUserId": "alex-uuid", "sessionsRevoked": 3, "mfaReEnrolled": true }
```

**Edge case — audit write fails for a self-initiated recovery request fanned out across 3 orgs (D2), and the 2nd org's write throws:** the whole transaction rolls back (no token is created, no email sent) — verify with a forced-failure integration test (mock the audit insert to throw on the 2nd call) for at least the recovery-request and deactivation paths, matching the existing precedent Story 4.2 sets for its own audit-failure test.

**And** these events are readable via the standard `audit_log_entries` table today (no new read API required by this story) and will become searchable through the UI/API once Epic 8 ships (cross-reference `epics.md:1952`, which already names this story explicitly: *"account recovery and deactivation events (Story 4.3) appear in the audit log as privileged events and are queryable via the standard audit search (FR102)"*) — no stub needed on the write side, only the search UI is a future dependency.

---

### AC-17: Route Registration, Public-Route Exemptions, OpenAPI, RLS Coverage

**Given** this story adds three genuinely public (unauthenticated) routes,

**When** they're registered,

**Then**:
- `POST /api/v1/auth/recovery/request`, `GET /api/v1/auth/recovery/:token`, `POST /api/v1/auth/recovery/:token/mfa/start`, and `POST /api/v1/auth/recovery/:token/complete` are each added to `PUBLIC_ROUTE_EXEMPTIONS` in `apps/api/src/lib/route-exemptions.ts:35-112`, following the exact shape of the existing `POST /api/v1/auth/mfa/recover` entry (`route-exemptions.ts:83-89`): `reason`, `securityOwner: 'api-security-reviewer'`, `compensatingControls: ['ip-rate-limit', 'email-rate-limit', 'token-is-the-credential']` (or equivalent), `expiresAfterStory: null`.
- Each is also added to `ROUTE_ACTION_CLASSIFICATIONS` (`route-exemptions.ts:120-387`) with the correct `action` (`'security-action'` for the mutating ones, `'read'` with an `auditOmissionReason` for the peek `GET`) and `auditEvent`/`sameTransactionAuditService` fields, following the exact shape of the `/mfa/enroll` and `/mfa/verify-enrollment` entries (`route-exemptions.ts:126-135`).
- `POST /org/users/:userId/deactivate` and `POST /org/users/:userId/recovery/send-link` go through `secureRoute` (not the public path) and are added to `ROUTE_ACTION_CLASSIFICATIONS` mirroring `DELETE /api/v1/org/users/:userId/sessions` (`route-exemptions.ts:167-171`).
- The public token-lookup helper for recovery tokens (mirroring `findInvitationByTokenHash`'s use of `getAdminDb()` in `apps/api/src/modules/invitations/lookup.ts:15-24`) is added to `DIRECT_DB_ACCESS_CLASSIFICATIONS` (`route-exemptions.ts:389-501`) with a `reason` citing the same trust model already documented for `modules/invitations/token-routes.ts` (`route-exemptions.ts:446-452`): the 256-bit recovery token is itself the authorization credential.
- `apps/api/src/__tests__/route-audit.test.ts` passes without modification to its assertions — only the classification/exemption **data** grows, not the test logic itself (same as every prior story that added routes).
- The OpenAPI spec is regenerated (whatever the existing `pnpm` script/CI step is — same as every prior story with new routes) so `FR48` stays satisfied.
- `checkRlsCoverage()` (`packages/db/src/check-rls-coverage.ts`) still passes: `account_recovery_tokens` is excluded (AC-1); no other new org-scoped table is introduced by this story that lacks a policy.

---

### AC-18: Web Application

**Given** the Product Surface Contract requires a real, non-dead-end UI for both personas,

**When** the web app is extended,

**Then**:

**Public recovery pages** (new `apps/web/src/routes/(auth)/recovery/` directory, mirroring the existing `(auth)/invitations/accept/` sibling — `+page.svelte` only, no server load needed beyond what `apiFetch` provides client-side, matching that precedent):
- `apps/web/src/routes/(auth)/recovery/+page.svelte` — email input form, calls the new `requestRecovery(fetchFn, email)` client function (`apps/web/src/lib/api/recovery.ts`, mirroring `invitations.ts`'s shape), always shows the generic "if that email is registered..." message (AC-9/AC-11) regardless of the response, so the UI itself cannot leak enumeration info even if a future bug changed the API's behavior.
- `apps/web/src/routes/(auth)/recovery/[token]/+page.svelte` — on load, calls `peekRecovery(fetchFn, token)`; renders the appropriate error state for each of AC-13's status codes (expired/used/superseded/not-found — matching the existing invitation-accept page's error-state handling pattern); on a valid peek, renders a new-password field, an optional "Set up two-factor authentication" toggle that (if enabled) calls `startRecoveryMfa` and displays the returned QR code + a code-entry field, then a submit button that calls `completeRecovery(fetchFn, token, { newPassword, totpCode? })`. On success, redirects to `/login` with a success banner (no auto-login, per AC-14).
- `apps/web/src/routes/(auth)/login/+page.svelte` gets a "Can't access your account?" link to `/recovery`, next to the existing password field (exact placement/wording deferred to UX polish, but the link must exist and resolve — G3 navigation truth).

**Admin-facing controls:**
- If `apps/web/src/routes/(app)/settings/users/+page.svelte` exists (Story 4.2 merged first): add a "Deactivate account" row action with a confirm dialog stating the session-revocation and invitation-revocation consequences explicitly (Persona A journey step 2), and a "Send recovery link" row action with a lighter confirm ("Send Sam a password recovery link?"). Both call new functions in a new `apps/web/src/lib/api/org-users.ts` (or extend it if 4.2 already created it) — `deactivateOrgUser(fetchFn, userId)` and `sendRecoveryLink(fetchFn, userId)`.
- If that page does **not** exist yet (4.2 not merged — Prerequisites): create a minimal standalone `apps/web/src/routes/(app)/settings/users/[userId]/+page.svelte` reachable by direct URL (not yet linked from a listing page) with just the user's email, current status, and the two action buttons above. This satisfies G3 (no dead links introduced by *this* story) without duplicating 4.2's future listing table; when 4.2 merges, its listing page links into this same route rather than rebuilding it.

**And** integration/component tests cover: recovery-request form submit (generic success message regardless of backend response), recovery-completion page for each of the 4 error states (AC-13) plus the happy path (with and without MFA re-enrollment), deactivate confirm-dialog flow (success + `already_deactivated` + `insufficient_role` rendering), send-recovery-link confirm-dialog flow.

---

### AC-19: Concurrency

**Given** two of this story's flows are naturally racy (deactivation-vs-deactivation, recovery-completion-vs-recovery-completion),

**When**:

- **Two admins call `POST /org/users/:userId/deactivate` for the same target simultaneously:** the target's `org_memberships` row is locked with `SELECT ... FOR UPDATE` before the status check and update (AC-3's edge case already specifies this for the hierarchy check; the same lock covers the idempotency check in AC-4). The loser of the race sees the now-current `status = 'deactivated'` and returns `409 already_deactivated`; only one `org.user_deactivated` audit row is ever written, and `revokeAllUserSessionsInOrg` is only ever invoked once (the loser's session-revocation call, if reached before the lock resolves, must either be skipped entirely by checking status first inside the lock, or be a safe no-op — `revokeAllUserSessionsInOrg` is already idempotent per-session per Story 1.7, so a second call finding zero remaining active sessions is harmless even if reached, but the row-lock should make this unreachable in practice).

- **Two requests call `POST /auth/recovery/:token/complete` with the same token simultaneously:** the atomic claim (`UPDATE ... WHERE used_at IS NULL ... RETURNING *`, AC-13) ensures only one wins; the loser gets `409 recovery_token_already_used` and triggers **no** password change, no session revocation, no audit row.

**And** integration tests cover both races directly (fire two concurrent requests via `Promise.all`, assert exactly one succeeds and the loser gets the documented error, assert exactly one audit row / one password-hash-change / one session-revocation-count).

---

## Tasks / Subtasks

- [x] **Task 1: Schema** (AC-1) — `account_recovery_tokens` migration + Drizzle schema, `EXCLUDED_TABLES` entry, `SessionRevokeScope` extension, `AuditEvent` constants, `RECOVERY_TOKEN_HMAC_SECRET` env var + production validation
- [x] **Task 2: Recovery token helpers** (AC-1, AC-9, AC-13) — `apps/api/src/modules/auth/recovery-tokens.ts`: `generateRecoveryToken`, `hashRecoveryToken`, `recoveryTokensMatch` (mirror `invitations/tokens.ts`); `apps/api/src/modules/auth/recovery-lookup.ts`: `findRecoveryTokenByHash` (admin-connection point lookup, mirror `invitations/lookup.ts`), `validateRecoveryTokenStatus`, `claimRecoveryToken`
- [x] **Task 3: `POST /org/users/:userId/deactivate`** (AC-2 through AC-8) — hierarchy/self/sole-owner guards, row lock, status update, session revocation call, invitation revocation, rotation-check stub (D7), audit
- [x] **Task 4: `POST /auth/recovery/request`** (self-initiated) (AC-9, AC-11, AC-12) — normalize email, lookup, no-admin check, token create + supersede, rate limits, notification enqueue, per-org audit fan-out
- [x] **Task 5: `POST /org/users/:userId/recovery/send-link`** (admin-initiated) (AC-10) — auth guard, token create + supersede, notification enqueue, single-org audit
- [x] **Task 6: `GET /auth/recovery/:token`** (peek) (AC-13) — status validation, masked email response
- [x] **Task 7: `POST /auth/recovery/:token/mfa/start`** (AC-15/D1) — pending-enrollment cleanup + fresh secret generation, reusing `mfa.ts` helpers without requiring `AuthContext`
- [x] **Task 8: `POST /auth/recovery/:token/complete`** (AC-14, AC-15, AC-19) — atomic claim, password reset, optional MFA verify/promote, multi-org session revocation, per-org audit fan-out
- [x] **Task 9: Auth-middleware deactivation gate** (AC-6) — org-membership-status check in the request-auth path
- [x] **Task 10: Route registration + exemptions + OpenAPI + RLS coverage** (AC-17)
- [x] **Task 11: Web — recovery pages** (AC-18) — `(auth)/recovery/+page.svelte`, `(auth)/recovery/[token]/+page.svelte`, `lib/api/recovery.ts`, login-page link
- [x] **Task 12: Web — admin controls** (AC-18) — deactivate + send-link actions, either extending 4.2's page or the minimal fallback page, `lib/api/org-users.ts`
- [x] **Task 13: Integration test suite** — all cases across AC-2 through AC-19 (deactivation happy path + guards + idempotency + session-revocation verification + invitation-revocation + rotation-stub, recovery request self/admin + rate limits + no-admin boundary, token peek all 4 error states, completion happy path + MFA re-enrollment + password-validation edge + concurrency races, audit-write-failure rollback for at least deactivation and recovery-request)

## Dev Notes

- Every session-revocation call in this story goes through `revokeAllUserSessionsInOrg` (Story 1.7) — never write raw `UPDATE sessions SET revoked_at = ...` in this story's own code.
- Every token (recovery) follows the invitation-token trust model exactly: opaque value in the email link, HMAC hash at rest, admin-connection point lookup by unique hash index before org context is known.
- `org_memberships.status` already has the `'deactivated'` value available in its check constraint — confirmed by reading `packages/db/src/schema/org-memberships.ts` directly; this was not something this story needs to migrate.
- The rotation-block check (AC-8/D7) is intentionally a stub — do not attempt to build a `rotations` table as part of this story; that's Epic 5's job.
- Do not build any Epic 9 platform-operator tooling for the no-admin dead end (D6) — document only.
- Do not build a reactivation endpoint (D4) — out of scope, flagged for PM follow-up.

### Project Structure Notes

- New files land in `apps/api/src/modules/auth/` (recovery-tokens.ts, recovery-lookup.ts, and route additions to `routes.ts` or a new `recovery-routes.ts` if `routes.ts` is getting unwieldy — follow whatever the codebase's existing size convention favors at implementation time) and `apps/api/src/modules/org/routes.ts` (deactivate, send-link — extending the existing file that already has the `/users/:userId/sessions` precedent).
- New DB files: `packages/db/src/migrations/0026_account_recovery_tokens.sql`, `packages/db/src/schema/account-recovery-tokens.ts`.
- New web files: `apps/web/src/routes/(auth)/recovery/`, `apps/web/src/lib/api/recovery.ts`, and either extensions to or a new minimal page under `apps/web/src/routes/(app)/settings/users/`.
- No conflicts detected with Story 4.2's planned file list (`4-2-organization-user-management.md:764-766`) — that story's `org-users.ts` client and `settings/users/` page are additive alongside this story's; if both stories land out of order, whichever merges second should extend rather than overwrite the other's files.

### References

- PRD: [Source: `_bmad-output/planning-artifacts/prd.md` FR45 (l.928), FR56 (l.958), FR83 (l.963), FR84 (l.964), FR102 via `epics.md:102`]
- Epics: [Source: `_bmad-output/planning-artifacts/epics.md` Story 4.3 (l.1488-1515), Epic 4 header notes AC-E4a/AC-E4b/PJ3 (l.1419-1421), Story 4.4's Epic 7 stub precedent (l.1532), FR102 cross-reference in Story 8.2 (l.1952)]
- Prior art for FR84 session revocation (reused directly): `apps/api/src/modules/auth/session-revoke.ts:266-290`, `apps/api/src/modules/org/routes.ts:30-69`
- Prior art for token pattern (reused directly): `apps/api/src/modules/invitations/tokens.ts`, `apps/api/src/modules/invitations/lookup.ts`, `apps/api/src/modules/invitations/routes.ts:44-121`
- Prior art for MFA TOTP helpers (reused, adapted for tokenless context per D1): `apps/api/src/modules/auth/mfa.ts:152-232,328-376`
- Prior art for public-route rate limiting: `apps/api/src/modules/auth/routes.ts:213-238,586-616`
- Story 1.7: [Source: `1-7-jwt-session-management-and-security-controls.md` AC-4 session_version architecture decision (l.143-158)]
- Story 4.2: [Source: `4-2-organization-user-management.md` D5/D9 org-role hierarchy and last-owner patterns (l.78-113), forward reference to this story (l.95-96,133), audit fail-closed contract (l.691)]
- Story 4.4: [Source: `4-4-project-archival.md`, and `epics.md:1532` for the exact Epic-dependency stub pattern this story mirrors for Epic 5]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4.5 (via claude code, bmad-dev-story workflow)

### Debug Log References

- `make db-up` + hand-written `packages/db/src/migrations/0026_account_recovery_tokens.sql` (drizzle-kit generate's snapshot chain is broken in this repo — intermediate `meta/*_snapshot.json` files were never committed for 0001-0024 except a handful, so `drizzle-kit generate` recomputes a diff from a stale base and re-declares unrelated tables; every prior story hand-writes migration SQL instead, confirmed by inspecting `0025_project_invitations.sql`'s style, so this migration was hand-written to match).
- `apps/api/debug-ac12.mjs` (scratch script, deleted before completion) — used to isolate why AC-12's no-admin test initially returned 202 instead of 404: `addUserToOrg` test helper auto-creates the new user's *own* org as `owner`, which the D2 fan-out logic correctly treats as "a reachable admin exists" (AC-12's own documented multi-org edge case). Fixed by inserting the AC-12 test's member user directly (no auto-created org) instead of via that helper.
- `pnpm jscpd` (zero-tolerance duplication gate) flagged 11 clones after the first implementation pass — all resolved via extraction: `apps/api/src/lib/opaque-token.ts` (shared HMAC-hash/compare primitives), `parseRecoveryTokenParams`/`sendRecoveryStatusError`/`enforceIpRateLimitAndNormalizeEmailBody`/`parseBodyAndEnforceEmailRateLimit` in `auth/routes.ts`, and `blockSelfAction`/`hasTarget`/`blockPeerOrHigherRole`/`isUsableTarget` in `org/routes.ts` (the last of these also refactors the pre-existing `DELETE /org/users/:userId` handler to reuse the same D9 hierarchy-guard helper, verified via full org-module regression). Final `pnpm jscpd` run: 0 clones.

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide created covering deactivation (immediate session/invitation revocation, stubbed rotation-block per Epic 5 forward dependency), self- and admin-initiated account recovery (password reset, optional two-step MFA re-enrollment), cross-org audit fan-out, anti-enumeration/rate-limiting, route-exemption registry updates, and concurrency guards. Seven Key Design Decisions (D1-D7) resolve genuine PRD/epics ambiguities explicitly rather than leaving them for the dev agent to guess.
- Implementation follows TDD red-green throughout: every new module (`recovery-tokens.ts`, and each integration-test file) had its test file written and run-to-fail before the implementation landed; `apps/api/src/modules/org/deactivation.routes.test.ts` (21 tests) and `apps/api/src/modules/auth/recovery.routes.test.ts` (24 tests) exercise every AC end-to-end against real PostgreSQL (no DB mocks), including both concurrency races (AC-19), both audit-fail-closed rollback paths (AC-16), and all 4 recovery-token status states (AC-13).
- Adversarial-review findings addressed in the implementation (not just documented): **HIGH-1** (MFA re-enrollment recreates the lockout it fixes) — recovery completion now regenerates a fresh recovery-code batch and invalidates old ones when `totpCode` is confirmed, mirroring `verifyEnrollment`'s own behavior (`recovery.ts:promoteStagedEnrollmentAndReissueCodes`); also fixes a latent bug the finding didn't call out explicitly — promoting a second confirmed `mfa_enrollments` row without first deleting any prior confirmed row would violate `idx_mfa_enrollments_user_confirmed`. **HIGH-3** (undocumented `RECOVERY_TOKEN_HMAC_SECRET` operator secret) — added to `.env.example` matching the `INVITATION_TOKEN_HMAC_SECRET` precedent. **MEDIUM** (`enforceRecoverRateLimit` is module-private) — resolved by construction: the new public recovery routes live in the same `auth/routes.ts` file rather than a new file, so no export was needed. **MEDIUM** (AC-10 send-link has no hierarchy guard unlike AC-3's deactivation) — added the same D9 peer-or-higher-role block to `POST /org/users/:userId/recovery/send-link`, beyond the literal AC text. **MEDIUM** (admin vs. self-service email copy) — separate `auth.recovery_link_created` / `auth.recovery_link_sent` templates with distinct anti-phishing framing. **MEDIUM** (RLS discipline unstated for the public recovery flow) — resolved with actual code: every RLS-scoped table touch in `recovery.ts` (`org_memberships` enumeration, `notification_queue` insert) explicitly sets `app.current_org_id` per row/target rather than relying on an ambient context, since the public routes self-manage their own transaction. **LOW** (masked-email algorithm underspecified) — implemented and unit-tested (`maskRecoveryEmail`): 2 visible local-part chars, or 1 for a ≤2-char local part, domain untouched. **LOW** (`rotationIds` forward-compat field) — the D7 stub's `{blocked, rotationIds}` shape is already wired through, ready for Epic 5 without a response-schema change.
- Adversarial-review findings acknowledged but **not** further mitigated beyond the story's own documented acceptance (out of scope for this pass): the residual write-count timing side-channel on AC-11's anti-enumeration guarantee for multi-org users (inherent to D2's per-org audit fan-out; the miss path already performs an equivalent-shape scan per AC-9's own edge case); D2 fan-out has no batching/upper-bound for a hypothetical very-high-org-count user (matches existing `mfa.ts` precedent for the same pre-auth org-scan problem).
- Web layer: this repo's established testing convention for `apps/web` is `lib/api/*.test.ts` unit tests around the fetch wrappers (mocked `fetch`) — there is no existing Svelte component-rendering test harness anywhere in `apps/web/src` (confirmed: only a placeholder `routes/page.test.ts` exists). `lib/api/recovery.ts` and the `org-users.ts` additions have full unit coverage; the two new Svelte pages and the settings/users page changes were implemented to match this story's AC-18 requirements and manually verified via typecheck/lint/`svelte-kit sync`, but do not have dedicated component-level tests, consistent with (not a regression from) the rest of the codebase.
- `checkActiveRotationsForUser` (D7/AC-8) is confirmed stubbed exactly as specified — `{ blocked: false, rotationIds: [] }` unconditionally, with a `// TODO: Epic 5` comment at the call site. QA must not mark FR102's rotation-block guarantee `done` until Epic 5 replaces this stub (same caveat the story itself calls out).

### Change Log

| Date | Change |
|---|---|
| 2026-07-02 | Story 4.3 implemented end-to-end: schema/migration, recovery-token helpers, deactivation route (AC-2–AC-8), self- and admin-initiated recovery request (AC-9–AC-12), token peek/mfa-start/complete (AC-13–AC-15), auth-middleware deactivation gate confirmed already correct (AC-6), route registration/exemptions/OpenAPI/RLS coverage (AC-17), web recovery pages + admin controls (AC-18), full concurrency/audit-fail-closed integration test suite (AC-16/AC-19). Adversarial-review HIGH/MEDIUM findings addressed in code (see Completion Notes). `pnpm jscpd` duplication gate brought to 0 clones via extracted shared helpers. Status → review. |

### File List

**New files**
- `packages/db/src/migrations/0026_account_recovery_tokens.sql`
- `packages/db/src/schema/account-recovery-tokens.ts`
- `apps/api/src/lib/opaque-token.ts`
- `apps/api/src/modules/auth/recovery-tokens.ts`
- `apps/api/src/modules/auth/recovery-tokens.test.ts`
- `apps/api/src/modules/auth/recovery-lookup.ts`
- `apps/api/src/modules/auth/recovery-schema.ts`
- `apps/api/src/modules/auth/recovery.ts`
- `apps/api/src/modules/auth/recovery.routes.test.ts`
- `apps/api/src/modules/org/deactivation.ts`
- `apps/api/src/modules/org/deactivation.routes.test.ts`
- `apps/api/src/notifications/templates/account-recovery.ts`
- `apps/web/src/lib/api/recovery.ts`
- `apps/web/src/lib/api/recovery.test.ts`
- `apps/web/src/routes/(auth)/recovery/+page.svelte`
- `apps/web/src/routes/(auth)/recovery/[token]/+page.svelte`

**Modified files**
- `.env.example`
- `packages/db/src/check-rls-coverage.ts`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/index.ts`
- `packages/shared/src/constants/audit-events.ts`
- `packages/shared/src/schemas/auth.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/lib/route-exemptions.ts`
- `apps/api/src/modules/auth/mfa.ts`
- `apps/api/src/modules/auth/routes.ts`
- `apps/api/src/modules/auth/session-revoke.ts`
- `apps/api/src/modules/org/routes.ts`
- `apps/api/src/modules/org/schema.ts`
- `apps/api/src/modules/org/user-management.ts`
- `apps/api/src/notifications/templates/index.ts`
- `apps/web/src/lib/api/org-users.ts`
- `apps/web/src/lib/api/org-users.test.ts`
- `apps/web/src/lib/security/hardening.ts`
- `apps/web/src/lib/security/hardening.test.ts`
- `apps/web/src/routes/(app)/settings/users/+page.svelte`
- `apps/web/src/routes/(auth)/login/+page.svelte`
