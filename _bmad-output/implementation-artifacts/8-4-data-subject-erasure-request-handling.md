# Story 8.4: Data Subject Erasure Request Handling

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Ultimate context engine analysis completed 2026-07-05 — comprehensive developer guide for GDPR/CCPA right-to-erasure request handling: a governed two-step (request → PII inventory review → execute) workflow that permanently scrubs a user's directly-identifying PII from the `users` and `user_identity_tokens` tables while explicitly preserving `audit_log_entries` HMAC integrity (Story 8.1), rotation history, and project-membership referential integrity. Read "Key Design Decisions & Open Questions" before coding — several genuine gaps and contradictions in epics.md's literal wording are resolved there with explicit rationale (cross-org identity guard, the missing FR number, the pseudonymization mechanism this story must build inline because Story 8.3 is still `backlog`, the "how do you block re-invites once the email is scrubbed" mechanism, and account-recovery-token cleanup epics.md omits). -->

## Story

As an **organization administrator responding to a GDPR/CCPA right-to-erasure request**,
I want **a governed procedure for identifying all personally-identifying data held for a user and producing a verifiable, atomic erasure record**,
so that **I can demonstrate compliance with data subject erasure obligations without compromising audit log integrity, referential integrity, or other users' data**.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story ships REST endpoints (erasure request creation with PII inventory, execution, compliance report) consumed via API/curl or a future admin UI, not a web screen |
| **Linked UI story** (if API-only) | `TBD` — **same accepted gap Stories 8.1 and 8.2 already flagged, not a new one, not a blocker to `ready-for-dev`:** no story in the current `epics.md` (Epic 8's four stories, or any other epic) scopes a dedicated web UI for the erasure-request workflow. Story 8.1 raised this gap at the Epic 8 preamble level; Story 8.2 re-raised it explicitly rather than silently re-discovering it. **This story continues that same precedent** — the gap must be raised again at Epic 8 sprint planning/retrospective before Epic 8 can reach `done` (Product Surface Contract G2). A future UI story should minimally surface: (a) a "Request erasure" button on the org users page (extends Story 4.2's/4.3's users table) that shows the PII inventory for review before confirming, and (b) a downloadable compliance report link once complete. |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is being deferred with a placeholder; none exists yet for this surface, and no SvelteKit route should be stubbed in this story (dead route with no linked follow-up story). |
| **Persona journey** | N/A — API-only, no evaluator-visible UI in this story. Rationale: the erasure workflow is a compliance-officer/org-admin API-driven procedure invoked in response to an external regulatory request (there is no "shopper" persona journey for it in the UX spec); the eventual UI (see above) is a future story's concern. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** Several of these resolve genuine gaps/contradictions between `epics.md`'s literal wording (written before Stories 8.1/8.2 shipped their concrete schema) and the actual codebase. Getting D1 wrong means every reference to "the audit table" in this story points at a table that doesn't exist. Getting D2 wrong is a cross-org data-integrity incident (an Org A admin silently nukes a user's login credentials for Org B without Org B's owner ever consenting). Getting D3 wrong means duplicating pseudonymization logic that Story 8.3 will also need. Getting D6 wrong means the re-invite block is unenforceable the moment the email is scrubbed.

### D1 — Table names: `epics.md` says `audit_events`/`data_erasure_requests`; the real table is `audit_log_entries` (already shipped, immutable)

`epics.md:1968-1985` (Story 8.4's literal text) refers to erasure interacting with "the audit log" but doesn't rename it; Story 8.1's adversarial review (`8-1-...-adversarial-review.md:135`) already corrected this for that story: **the actual, already-migrated table is `audit_log_entries`** (`packages/db/src/schema/audit-log-entries.ts`), not `audit_events`. This story must reference `audit_log_entries` everywhere. The table is **append-only** (UPDATE/DELETE blocked by a DB trigger + `REVOKE` — Story 8.1 D1) — this story's erasure execution **never** touches `audit_log_entries` rows directly; it relies entirely on `user_identity_tokens.display_name` pseudonymization (a *different*, mutable table) to scrub the identity that `audit_log_entries.actor_token_id` references. This is the mechanism the PRD (`prd.md:632`) and architecture (`architecture.md:133`) call "PII externalized to a mutable identity reference table at schema design" — it already exists; this story is the first to *exercise* the erasure half of it end-to-end for a real user (Story 8.3, which owns the standalone `POST /pseudonymize` endpoint, is still `backlog` — see D3).

`data_erasure_requests` (the new table this story introduces) is a genuinely new table — no prior story created it. It **is** org-scoped (has `org_id`) and needs a normal RLS policy (see AC-20), unlike the identity-scoped tables in `EXCLUDED_TABLES`.

### D2 — CRITICAL: `users.email`/`users.password_hash` are GLOBAL (not org-scoped) — cross-org erasure guard is mandatory

`packages/db/src/schema/users.ts` has **no `org_id` column**. A single `users` row can be a member of multiple organizations via `org_memberships` (one row per `(org_id, user_id)`). `epics.md:1972-1973`'s literal erasure steps ("the user's email in `users` is replaced," "the user's `password_hash` is overwritten") operate on this **global** row — if executed naively from an org-scoped endpoint (`POST /api/v1/org/users/:userId/erasure-request/:requestId/execute`, called by an Org A admin), it would silently destroy the user's login credentials **for every org they belong to**, including orgs the calling admin has no authority over. This is the exact class of cross-org bleed Story 4.3 (`4-3-...-account-deactivation-and-recovery.md:64`) was careful to avoid for deactivation ("deactivating a user in org A does not touch their membership or sessions in org B").

**Resolution (v1 scope, must be implemented as a hard precondition — AC-8):** Erasure **execution** (not the read-only PII-inventory step) is blocked with `409 { code: "user_has_other_org_memberships", otherOrgCount: N }` unless the target user's **only** `org_memberships` row (with `status = 'active'` or `'deactivated'` — any row at all) is the requesting org's. This makes global-identity erasure (email/password/MFA/sessions) safe by construction: if it proceeds, the calling org is provably the only org with a stake in that user's identity. If an admin needs to erase a user who belongs to multiple orgs, they must coordinate with the other orgs first (out of scope for this story — an ops/process concern, not an application feature, mirroring Story 4.3's D4 precedent for its own descoped reactivation feature). Document this limitation plainly in the erasure-request response so admins aren't surprised by the 409.

This guard also **simplifies** the re-invite-block design (D6): since only single-org-membership users can ever be fully erased, "cannot be re-invited to any project in **the org**" (epics.md:1983) is automatically the only org that could ever matter for that user — there is no scenario where a fully-erased user still has a live membership elsewhere that the block would need to account for.

### D3 — Story 8.3's pseudonymization mechanism doesn't exist yet; build the shared primitive here, let 8.3 reuse it

`epics.md:1971` says step 1 of execution is "the user's `user_identity_tokens.display_name` is pseudonymized (**Story 8.3 mechanism**)" — but Story 8.3 (`8-3-access-reports-dormant-users-and-audit-pii-management.md`) is still `backlog` in `sprint-status.yaml` (no story file exists yet), and its own future `POST /api/v1/org/users/:userId/pseudonymize` endpoint (epics.md:1948) has not been built. **Do not block this story on 8.3 landing first** — `sprint-status.yaml`'s own workflow notes say "stories can be worked in parallel." Instead, this story must implement the narrow pseudonymization primitive itself, as a **standalone, reusable helper function** (not inline in the erasure handler), so that when Story 8.3 is eventually written, it calls the *same* helper rather than duplicating the logic (the exact anti-duplication discipline this workflow's checklist exists to enforce).

Create `apps/api/src/modules/compliance/pseudonymize-identity.ts`:

```ts
export async function pseudonymizeUserIdentityToken(
  tx: Tx,
  userId: string
): Promise<{ tokenId: string; alias: string }[]>
```

- Finds **all** `user_identity_tokens` rows with `user_id = :userId` (there can be more than one historically, though in practice each user has exactly one — do not assume uniqueness without checking; no unique constraint exists on `user_identity_tokens.user_id` in the current schema).
- For each row: generates an alias `user_<8-random-lowercase-alphanumeric-chars>` (crypto-random, not `Math.random()` — reuse the codebase's existing random-token helper used by invitation/recovery tokens, e.g. `packages/db` or `apps/api/src/lib/crypto.ts`'s existing secure-random utility rather than adding a new one), sets `display_name = alias`, sets `pseudonymized_at = NOW()`.
- **Idempotent**: if a row's `pseudonymized_at` is already set, re-running replaces the alias with a **new** one and updates `pseudonymized_at` again (matches AC-E8d's "repeated pseudonymization" contract that Story 8.3 will also need — do not special-case "already pseudonymized" as a no-op, since Story 8.3's own AC explicitly wants idempotent *re*-pseudonymization to succeed, not silently skip).
- Does **not** touch `audit_log_entries` — the FK (`actor_token_id`) is stable; only the referenced row's `display_name` changes (this is the whole point of the design — HMAC values in `audit_log_entries` are computed over `actor_token_id`, `payload`, etc., never over `display_name`, so changing `display_name` cannot invalidate any HMAC — confirm this by re-reading `computeAuditHmac`'s field list in `apps/api/src/modules/audit/write-entry.ts` before coding, per D-note precedent in Story 8.1).

When Story 8.3 is written later, its `POST /pseudonymize` route should import and call this exact function — flag this cross-reference in that story's own Dev Notes when it's created.

### D4 — `SessionRevokeScope` needs a new `'erasure'` literal

`apps/api/src/modules/auth/session-revoke.ts:13-22` defines `SessionRevokeScope` as a closed union: `'single' | 'all_except_current' | 'admin_action' | 'logout' | 'idle_expiry' | 'deactivation' | 'security' | 'account_recovery'`. Erasure step 5 (epics.md:1975, "all active sessions are revoked (FR84 path)") must reuse `revokeAllUserSessionsInOrg` (do **not** reimplement session revocation — same discipline Story 4.3 followed for deactivation) but needs a scope value that's distinguishable in audit rows from an ordinary admin-forced revoke or a self-service deactivation. Add `'erasure'` as a new literal to the union (one-line change) and pass `scope: 'erasure'` from the erasure-execution handler.

### D5 — MFA/recovery erasure: exact columns, not a single "TOTP secret" field

`epics.md:1974` says "the user's TOTP secret and MFA recovery codes are deleted" as if `users` has a `totp_secret` column — it does not. The real schema (`packages/db/src/schema/mfa-enrollments.ts`, `mfa-recovery-codes.ts`) stores this as:
- `mfa_enrollments` — one or more rows per user (`secret_encrypted` JSONB, `status: 'pending'|'confirmed'`). **Delete all rows** for the user (both pending and confirmed — a pending, unconfirmed enrollment attempt is still PII/security material and must not survive erasure).
- `mfa_recovery_codes` — potentially many rows per user (`code_hash`, `used_at`). **Delete all rows**, used and unused.
- `users.mfa_enrolled_at` — set to `NULL` (this is the only MFA-related column that actually lives on `users`).

**Gap epics.md omits — flagged and closed here (do not skip):** `account_recovery_tokens` (Story 4.3's table — `packages/db/src/schema/account-recovery-tokens.ts`) can hold a **live, unexpired** password/MFA-reset token for the user at the moment of erasure. If left alone, a leaked or intercepted recovery token would let an attacker "recover" (reset the password of) an identity that was supposed to be erased — a real security hole, not a hypothetical. This story adds an **8th erasure step, beyond epics.md's literal 7**: delete all `account_recovery_tokens` rows for the user (or at minimum set them to an unusable/expired state — deletion is simpler and consistent with the "delete" framing of steps 3/4). Document this explicitly in the compliance report's `piiRemoved` list as `account_recovery_tokens` so the deviation from epics.md's literal step count is traceable, not silent.

### D6 — Re-invite block: the email is gone by the time you'd check it — store a hash up front

`epics.md:1983`'s "a user with a pending or completed erasure request cannot be re-invited to any project in the org" is checked at `POST /api/v1/projects/:projectId/invitations` (`apps/api/src/modules/invitations/routes.ts:130-191`), which validates against `parsed.data.email` (the *invitee's* email, normalized — see `normalizeEmail`). But by the time an admin tries to re-invite, the erased user's `users.email` has already been overwritten to `erased_<hash>@erased.invalid` (epics.md step 2) — **the original email is gone**, so a plain `WHERE users.email = :invitedEmail` lookup against erased users will never match.

**Resolution:** at erasure-**request** creation time (`AC-1`, before any PII is touched), compute and store `original_email_hash = SHA-256(normalizeEmail(currentEmail))` on the new `data_erasure_requests` row. The invitation-creation handler, after its existing `archivedAt`/`already_member` checks (`invitations/routes.ts:183-191`), adds one more check: hash the invitee email the same way and look for a `data_erasure_requests` row in this project's org with `status IN ('pending','in_progress','completed')` and a matching `original_email_hash`. If found, return `410 { code: "user_erased" }` (matches the existing 410 response schema already declared for this route — `CreateInvitationResponseSchema`'s sibling error schemas at `invitations/routes.ts:141`, no schema migration needed, just a new response case).

**Accepted, documented limitation (do not "fix" beyond this):** because the check is by email hash, if a *different* real person legitimately owns that same email address after erasure (e.g., a shared/generic mailbox, or the org's email convention gets reassigned), they will also be blocked from being invited under that address. This is judged an acceptable false-positive rate for a GDPR compliance safety net (erring toward over-blocking, never silently under-blocking) — same "accepted risk, documented, not silently discovered later" posture the codebase already takes elsewhere (e.g., Story 8.2's cross-org display-name bleed note).

### D7 — Authorization split: request creation is `admin`+`owner`; execution is `owner`-only

`epics.md:1966` says "an org admin is authenticated" for request creation, without distinguishing execution's authority level. Given execution is an **irreversible, destructive, cross-cutting** action (global identity fields, not just this-org data), this story follows the precedent Story 8.1 set for its own highest-stakes endpoint (`GET /org/audit/verify`, owner-only) rather than the lower bar used for routine admin actions like deactivation (`admin`+`owner`):
- `POST .../erasure-request` (create + PII inventory, **read-only**, reversible by simply not executing) — `minimumRole: 'admin'` (admin or owner).
- `POST .../erasure-request/:requestId/execute` (irreversible) — `minimumRole: 'owner'`.
- `GET .../erasure-request/:requestId/report` (read-only compliance artifact) — `minimumRole: 'admin'` (admin or owner; compliance officers reviewing the paper trail don't need owner-level destructive authority).

### D8 — No FR number: this operationalizes a narrative PRD requirement, not a numbered FR

Unlike Stories 8.1 (`FR40, FR78`), 8.2 (`FR41, FR42, FR43, FR70`), and 8.3 (`FR44, FR69, FR71, FR102`), `epics.md`'s Story 8.4 section has **no** `*Covers: FRxx*` line, and the PRD's numbered FR list (`prd.md` FR40-FR44 audit cluster) does not include a distinct erasure FR either. This story instead operationalizes the PRD's **narrative** GDPR requirement at `prd.md:294` ("documented erasure exception process for regulatory right-to-erasure requests against immutable log entries") and `prd.md:631-632` ("GDPR right to erasure vs. immutable audit logs — resolution"). Treat those two PRD passages as this story's requirement source in lieu of a numbered FR; do not invent an FR number.

### D9 — Concurrency: execution must be safe under a two-admin race

Two owners could call `execute` for the same `requestId` at nearly the same time (mirrors Story 4.3 AC-19's "two admins race to deactivate the same user" pattern, and Story 8.1 finding 5's check-then-act race concern). Guard with a status-transition compare-and-set inside the transaction: `UPDATE data_erasure_requests SET status = 'in_progress' WHERE id = :requestId AND status = 'pending' RETURNING id` (or `SELECT ... FOR UPDATE` then check in application code — either is acceptable, but the check-then-transition must happen atomically inside the same transaction that performs steps 1-7/8, not as a separate pre-check). If zero rows are affected, another request already claimed it — return `409 { code: "erasure_already_in_progress" }` (or `already_completed` if it's already `completed` — distinguish the two in the response) and perform **zero** mutation.

### D10 — `audit_log_entries.actor_token_id` for the erasure event itself: the actor is the *admin*, the resource is the *erased user*

The `user.erasure_executed` privileged audit event (epics.md:1977) must be written via `writeHumanAuditEntryOrFailClosed` (`apps/api/src/lib/audit-or-fail-closed.ts`) with `actorTokenId` = the **executing owner's** identity token (i.e., resolve the *caller's* `user_identity_tokens` row, exactly like every other audit-writing route already does), **not** the erased user's token. `resourceId` = the erased user's `id` (or their now-pseudonymized `user_identity_tokens.id` — pick the erased user's `users.id`, since that's stable and matches how other stories reference "the user acted upon" as `resourceId`, e.g. Story 4.3's `org.user_deactivated` event). `resourceType: 'user'`. `payload` must **not** contain any PII (no email, no display name) — only structural facts: `{ dataErasureRequestId, tablesErased: [...], revokedSessionCount }`.

### D11 — No "un-erasure" endpoint; this is a one-way door (matches Story 4.3's precedent for its own one-way decisions)

Like Story 4.3's deliberate choice not to build a reactivation endpoint (`4-3-...md:68`), this story does not build any reversal mechanism. Once `completed`, a `data_erasure_requests` row and its effects are permanent. If a future story needs reversal (extremely unlikely to ever be a legitimate GDPR need — erasure is meant to be permanent), that is new, out-of-scope work requiring its own product decision. Flag for the PM if raised.

---

## Prerequisites

| Prerequisite | Why | Status |
|---|---|---|
| Story 8.1 (Tamper-Evident Audit Log) — should be `done` or at least `in-progress`/merged before this story's dev work starts | Ships `audit_log_entries`, `writeHumanAuditEntryOrFailClosed` (actually lives in `apps/api/src/lib/audit-or-fail-closed.ts`, built on top of Story 8.1's `computeAuditHmac`/`currentAuditKeyVersion`), and the append-only guarantee this story relies on to prove the audit trail survives erasure (AC-12). | `ready-for-dev` (not yet implemented in this worktree as of this story's creation) |
| Story 1.7 (JWT Session Management) | Provides `revokeAllUserSessionsInOrg()` and the `SessionRevokeScope` union this story extends with `'erasure'` (D4) — do not reimplement session revocation. | `done` |
| Story 1.6 (User Registration) | `users`, `user_identity_tokens` schema this story mutates. | `done` |
| Story 1.8/1.9 (TOTP MFA Enrollment/Recovery) | `mfa_enrollments`, `mfa_recovery_codes` schema this story deletes rows from. | `done` |
| Story 4.1 (Team Invitations) | `project_invitations` creation route (`apps/api/src/modules/invitations/routes.ts`) this story adds the re-invite block to (D6). | `done` |
| Story 4.3 (Account Deactivation & Recovery) | `account_recovery_tokens` schema this story purges (D5 gap-fix); `org_memberships.status` this story's cross-org guard (D2) reads. | `done` |
| Story 1.11 (SecureRoute framework) | `secureRoute()`, transaction-scoped RLS context, rate limiting — this story's routes use the same framework. | `done` |
| Story 8.3 (Access Reports, Dormant Users & Audit PII Management) | **Not a prerequisite** (see D3) — this story builds and owns the pseudonymization primitive Story 8.3 will later reuse. Do not wait for 8.3. | `backlog` |
| `packages/db/src/migrations/meta/_journal.json` — confirm the latest migration index before claiming the next one for this story's new `data_erasure_requests` table and the `account_recovery_tokens`/`mfa_enrollments`/`mfa_recovery_codes` DELETE-permission checks (no schema change needed there, just confirm app-level DELETE is already permitted — these tables are not append-only) | Avoid a migration-index collision with Stories 8.1/8.2 if they land first. | informational — check at implementation time |

---

## Epic Cross-Story Context

| Story | Relationship to 8.4 |
|---|---|
| 8.1 (Tamper-Evident Audit Log, `ready-for-dev`) | Source of `audit_log_entries`, `writeHumanAuditEntryOrFailClosed`/`computeAuditHmac`, and the append-only guarantee. This story's AC-12 explicitly re-runs (or references) 8.1's `GET /org/audit/verify` semantics to prove erasure didn't break HMAC integrity for the erased user's historical rows. |
| 8.2 (Audit Log Search, Export & Forwarding, `ready-for-dev`) | Not a hard dependency, but shares the same `audit_log_entries` table this story's rows continue to be searchable/exportable through after erasure — no special-casing needed there since erasure never touches that table (D1). |
| 8.3 (Access Reports, Dormant Users & Audit PII Management, `backlog`) | **This story builds the `pseudonymizeUserIdentityToken()` primitive (D3) that 8.3's future `POST /pseudonymize` endpoint must reuse**, not duplicate. When 8.3 is written, cross-reference `apps/api/src/modules/compliance/pseudonymize-identity.ts` explicitly in its Dev Notes. |
| 4.3 (Account Deactivation & Recovery, `done`) | Source of `revokeAllUserSessionsInOrg()` (this story adds the `'erasure'` scope, D4), `account_recovery_tokens` schema (this story purges live tokens, D5), and the org-scoping/cross-org-bleed discipline this story's D2 cross-org guard directly follows. |
| 4.1 (Team Invitations, `done`) | Owns `project_invitations` creation route this story adds the `410 user_erased` check to (D6). |
| 1.5 (Vault Initialization & Master Key Management, `done`) | Source of the audit signing key (HKDF `info: "project-vault-audit-log-v1"`) `writeHumanAuditEntryOrFailClosed` uses internally — no direct interaction needed in this story beyond the existing helper. |
| 9.1 (Encrypted Backup & Restore, `backlog`) | Out of scope for this story, but worth noting: an erased user's PII may still exist in **pre-erasure backups**. This is a known, accepted limitation of backup-based recovery systems generally (restoring an old backup necessarily reintroduces previously-erased data) — Story 9.1, when written, should document this as an explicit operational caveat for compliance officers (e.g., "restoring a backup taken before an erasure request will reintroduce the erased data; re-run erasure after any restore that predates it"). Flag for that story; no code change needed here. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 8.4 | Rationale |
|---|---|---|
| `epics.md`: "the audit log" / implicit `audit_events` table | `audit_log_entries` (already shipped by Story 8.1's design; see D1) | Table name divergence already corrected by Story 8.1's own adversarial review; this story must not reintroduce the wrong name |
| `epics.md:1971`: step 1 "pseudonymized (Story 8.3 mechanism)" | Standalone `pseudonymizeUserIdentityToken()` helper built in **this** story (D3), reused by 8.3 later | Story 8.3 doesn't exist yet; do not block or duplicate |
| `epics.md:1975`: "all active sessions are revoked (FR84 path)" | `revokeAllUserSessionsInOrg({ ..., scope: 'erasure', ... })` — new `'erasure'` literal added to `SessionRevokeScope` (D4) | Reuse Story 1.7's tested primitive; distinguish erasure-triggered revocation from other scopes in audit payloads |
| `epics.md:1974`: "TOTP secret and MFA recovery codes are deleted" | Delete all `mfa_enrollments` rows + all `mfa_recovery_codes` rows for the user; set `users.mfa_enrolled_at = NULL` (D5) | No single "TOTP secret" column exists; the real schema splits this across two tables plus one `users` column |
| `epics.md:1970-1977`: 7 numbered erasure steps | 8 steps — adds "delete `account_recovery_tokens` rows for the user" (D5) | epics.md omits this; a live, unexpired recovery token surviving erasure is a security hole (attacker could reset credentials for an "erased" identity) |
| `epics.md:1983`: "cannot be re-invited to any project in the org" | Checked via `original_email_hash` stored on `data_erasure_requests` at request-creation time, compared against the invitee email's hash at invite-creation time (D6) | The literal email is gone by execution time (overwritten to `erased_<hash>@erased.invalid`); a hash captured *before* erasure is the only way to make this check possible later |
| `epics.md:1966`: "an org admin is authenticated" (no execution-authority distinction) | Request creation: `admin`+`owner`. Execution: `owner`-only (D7) | Execution is irreversible and cross-cutting (global identity fields); mirrors Story 8.1's precedent of reserving the highest-stakes endpoint for `owner` only |
| No FR number in `epics.md` for this story | Sourced from `prd.md:294` and `prd.md:631-632` narrative GDPR requirement (D8) | Unlike Stories 8.1-8.3, this story has no numbered FR; document the narrative source instead of inventing one |

---

## Acceptance Criteria

### AC-1: PII Inventory Generation — Happy Path

**Given** Riley (org `admin` or `owner`) is authenticated in Org A, and Sam is a `member` of Org A with a `users` row, one `user_identity_tokens` row, a confirmed `mfa_enrollments` row, two `mfa_recovery_codes` rows (one used, one unused), and one active `sessions` row,

**When** Riley calls `POST /api/v1/org/users/:userId/erasure-request` with body `{ "reason": "GDPR Article 17 request received via support ticket #4821", "requestedBy": "Sam <sam@example.com> via privacy@example-org.com" }`,

**Then** the system:
1. Creates a `data_erasure_requests` row: `id` (new uuid), `userId: Sam's id`, `orgId: Org A's id`, `requestedBy` (as given), `reason` (as given), `status: 'pending'`, `originalEmailHash: SHA-256(normalizeEmail('sam@example.com'))` (D6), `createdAt: now`, `completedAt: null`.
2. Computes and returns a PII inventory covering every table with erasable PII for Sam:

```json
{
  "data": {
    "requestId": "9f2c...-uuid",
    "status": "pending",
    "piiInventory": {
      "tables": [
        { "table": "users", "rowCount": 1, "piiFields": ["email", "passwordHash"] },
        { "table": "user_identity_tokens", "rowCount": 1, "piiFields": ["displayName"] },
        { "table": "mfa_enrollments", "rowCount": 1, "piiFields": ["secretEncrypted"] },
        { "table": "mfa_recovery_codes", "rowCount": 2, "piiFields": ["codeHash"] },
        { "table": "account_recovery_tokens", "rowCount": 0, "piiFields": ["tokenHash"] }
      ]
    }
  }
}
```

3. Returns `201` with this payload so the admin can review scope **before** calling execute.

**And** integration test confirms all five table rows are counted accurately by seeding known row counts (e.g., 2 `mfa_recovery_codes` rows) and asserting the returned `rowCount` matches exactly.

---

### AC-2: PII Inventory — Authorization

**Given** the same setup as AC-1,

**When** a `member` or `viewer` role calls `POST /api/v1/org/users/:userId/erasure-request`,

**Then** the request is rejected `403 { code: "insufficient_role" }` and **no** `data_erasure_requests` row is created.

**Edge cases:**

| Caller role | Result |
|---|---|
| `owner` | `201` — allowed (D7) |
| `admin` | `201` — allowed (D7) |
| `member` | `403 insufficient_role` |
| `viewer` | `403 insufficient_role` |
| Machine user (any) | `403 insufficient_role` — this endpoint is human-admin-only; machine users cannot initiate erasure requests, no AC in epics.md suggests otherwise |

---

### AC-3: PII Inventory — Unknown or Cross-Org User

**Given** Riley is authenticated in Org A,

**When** Riley calls `POST /api/v1/org/users/:userId/erasure-request` with a `userId` that does not exist, or exists but has no `org_memberships` row for Org A (e.g., a user who is only a member of Org B),

**Then** the endpoint returns `404 { code: "user_not_found" }` (tenant-isolation-safe error — do not leak whether the user exists globally, only whether they're a member of *this* org, mirroring the existing `PROJECT_NOT_FOUND`-style pattern used elsewhere in the codebase).

**Edge case — Sam was already fully erased (org membership row is gone or `data_erasure_requests` already `completed`):** since erasure does **not** delete the `org_memberships` row (epics.md explicitly retains it, D2/"what is NOT erased"), the membership lookup still succeeds. This case is instead caught by AC-4 (duplicate request guard), not AC-3.

---

### AC-4: PII Inventory — Duplicate Request Guard

**Given** Sam already has a `data_erasure_requests` row with `status: 'pending'` (created by an earlier call),

**When** Riley calls `POST /api/v1/org/users/:userId/erasure-request` again for Sam,

**Then** the endpoint returns `409 { code: "erasure_request_already_pending", requestId: "<existing id>" }` with the **existing** request's current PII inventory recomputed fresh (row counts may have changed since the original call, e.g. a new session was created) — it does **not** create a second row.

**Edge case — existing request is `status: 'completed'`:** returns `410 { code: "user_already_erased", requestId: "<existing id>", completedAt: "..." }` instead of creating a new request or recomputing an inventory (there's nothing left to inventory).

**Edge case — existing request is `status: 'in_progress'` (execution is mid-flight, see AC-9/AC-10):** returns `409 { code: "erasure_execution_in_progress", requestId: "<existing id>" }`.

---

### AC-5: Execute Erasure — Happy Path (8 Atomic Steps)

**Given** Sam's `data_erasure_requests` row exists with `status: 'pending'`, Riley is the org `owner` (D7), and Sam has exactly one `org_memberships` row total (Org A only — satisfies D2's cross-org guard),

**When** Riley calls `POST /api/v1/org/users/:userId/erasure-request/:requestId/execute` with `{ "confirm": true }`,

**Then**, in a single database transaction:
1. `pseudonymizeUserIdentityToken(tx, Sam.id)` runs (D3) — Sam's `user_identity_tokens.display_name` becomes e.g. `user_a3f9b2c1`, `pseudonymized_at = now()`.
2. `users.email` for Sam is set to `erased_<12-hex-chars>@erased.invalid` (hash derived from Sam's original user id + a random salt, not reversible to the original email).
3. `users.password_hash` is overwritten with a fixed sentinel value (a constant, non-functional bcrypt-shaped string such that no password will ever match it — e.g., reuse the same sentinel pattern the codebase uses elsewhere for "impossible to authenticate" placeholder hashes, or document a new one clearly in Dev Notes if none exists yet).
4. `users.mfa_enrolled_at` is set to `NULL`; **all** `mfa_enrollments` rows for Sam are deleted; **all** `mfa_recovery_codes` rows for Sam are deleted.
5. **All** `account_recovery_tokens` rows for Sam are deleted (D5 gap-fix, beyond epics.md's literal 7 steps).
6. `revokeAllUserSessionsInOrg({ userId: Sam.id, orgId: Org A.id, actorUserId: Riley.id, reason: 'erasure', scope: 'erasure', tx })` is called (D4) — reused verbatim, not reimplemented.
7. `data_erasure_requests.status` is set to `'completed'`, `completedAt = now()`.
8. One `user.erasure_executed` privileged audit event is written via `writeHumanAuditEntryOrFailClosed` (D10): `actorTokenId` = Riley's identity token, `resourceId` = Sam's `users.id`, `resourceType: 'user'`, `payload: { dataErasureRequestId, tablesErased: ["users","user_identity_tokens","mfa_enrollments","mfa_recovery_codes","account_recovery_tokens"], revokedSessionCount }`.

**And** the response is `200`:
```json
{ "data": { "requestId": "...", "status": "completed", "completedAt": "2026-07-05T...", "revokedSessionCount": 1, "auditEventId": "..." } }
```

**And** if **any** step fails (e.g., the audit write fails), the entire transaction rolls back — no partial erasure (same "same-transaction invariant" discipline as Story 8.1's audit writes; erasure must be all-or-nothing).

---

### AC-6: Execute Erasure — `confirm: true` Is Mandatory

**Given** the same setup as AC-5,

**When** Riley calls execute with `{ "confirm": false }` or omits `confirm` entirely,

**Then** the endpoint returns `400 { code: "confirmation_required", message: "Erasure is irreversible; confirm: true is required" }` and performs **zero** mutation (no status change, no audit row, no session revocation).

---

### AC-7: Execute Erasure — Authorization

**Given** the same setup as AC-5,

**When** an `admin` (not `owner`) calls execute,

**Then** the endpoint returns `403 { code: "insufficient_role" }` (D7 — execution requires `owner`, unlike request creation which allows `admin`+`owner`).

**Edge cases:**

| Caller role | Endpoint | Result |
|---|---|---|
| `owner` | execute | `200` — allowed |
| `admin` | execute | `403 insufficient_role` |
| `owner` | create request | `201` — allowed |
| `admin` | create request | `201` — allowed |
| `member`/`viewer` | either | `403 insufficient_role` |

---

### AC-8: Execute Erasure — Cross-Org Guard (D2, CRITICAL)

**Given** Sam has **two** `org_memberships` rows: one in Org A (`status: 'active'`) and one in Org B (`status: 'active'`), and a `data_erasure_requests` row exists in Org A with `status: 'pending'`,

**When** Riley (Org A owner) calls execute,

**Then** the endpoint returns `409 { code: "user_has_other_org_memberships", otherOrgCount: 1 }` and performs **zero** mutation — Sam's `users.email`, `password_hash`, sessions, and MFA data are all left untouched; the `data_erasure_requests` row remains `status: 'pending'` (not transitioned to `in_progress` or `completed`).

**Edge case — Sam's Org B membership is `status: 'deactivated'` (not active):** the guard **still blocks** — a deactivated-but-present membership row still represents a live stake in Sam's global identity (Org B could reactivate access via direct DB action per Story 4.3's D4, or Sam could still exist in Org B's audit history) and the epics.md "what is NOT erased" list explicitly retains membership rows for referential integrity. `otherOrgCount` counts membership rows regardless of `status`.

**Edge case — Sam's only other membership is in Org A itself under a different, stale row (data bug scenario) or the same org twice (should be impossible — `org_memberships` has a composite PK `(orgId, userId)`):** not reachable given the schema's primary key constraint; no special handling needed, but worth a defensive comment in the query.

**Positive/happy-path confirmation:** if Sam's Org B membership is removed (e.g., Org B's admin explicitly removes Sam first, out of band), a **subsequent** execute call for the same Org A request succeeds normally per AC-5.

---

### AC-9: Execute Erasure — Idempotency on Already-Completed Requests

**Given** Sam's `data_erasure_requests` row already has `status: 'completed'`,

**When** Riley calls execute again for the same `requestId`,

**Then** the endpoint returns `409 { code: "already_completed", completedAt: "<original timestamp>" }` and performs **zero** additional mutation — no second `user.erasure_executed` audit event, no re-running of steps 1-8, no double session-revocation.

---

### AC-10: Execute Erasure — Concurrency (D9)

**Given** Sam's `data_erasure_requests` row has `status: 'pending'`,

**When** two owners, Riley and Jordan, call execute for the same `requestId` at nearly the same time (simulated in a test via two concurrent transactions),

**Then** exactly **one** call succeeds (`200`, full 8-step execution) and the other receives `409 { code: "erasure_already_in_progress" }` (or `already_completed`, depending on timing relative to the winner's commit) — the status-transition compare-and-set (D9: `UPDATE ... WHERE status = 'pending'` or `SELECT ... FOR UPDATE`) guarantees only one transaction can claim the `pending → in_progress` transition. Integration test asserts: exactly one `user.erasure_executed` audit row exists afterward, exactly one session-revocation occurred (not two), and `users.email`/`password_hash` were touched exactly once (assert via a `updated_at`-style check or by counting side effects, since the value itself is deterministic either way).

---

### AC-11: Audit Log Integrity Survives Erasure (Cross-Ref Story 8.1)

**Given** Sam has 5 pre-existing `audit_log_entries` rows with `actor_token_id` pointing at Sam's `user_identity_tokens` row (e.g., credential-read events from Epic 2, a rotation event from Epic 5), all written and HMAC-signed **before** erasure,

**When** Sam's erasure is executed (AC-5),

**Then**: (a) all 5 pre-existing rows are **untouched** — same `id`, `hmac`, `keyVersion`, `payload`; (b) `GET /api/v1/org/audit/verify?from=<before>&to=<after>` (Story 8.1's endpoint) still reports `passed: true` for all 5 rows — erasure changing `user_identity_tokens.display_name` does **not** invalidate any HMAC, because `computeAuditHmac`'s canonical-JSON input never includes `display_name` (confirm this by reading `apps/api/src/modules/audit/write-entry.ts`'s field list before coding — D3 depends on this being true); (c) any **new** audit search/export (Story 8.2, if implemented) that resolves `actor_display_name` for these 5 historical rows now shows Sam's pseudonymized alias (e.g. `user_a3f9b2c1`) instead of Sam's original display name — this is the intended, working mechanism, not a bug (same "live join, not a frozen copy" design Story 8.2's D-notes already documented for pseudonymization generally).

---

### AC-12: Erasure Audit Event Shape and Actor Semantics (D10)

**Given** Riley (owner, identity token `riley-token-id`) executes erasure for Sam (`users.id: sam-user-id`),

**When** the `user.erasure_executed` audit row is written,

**Then** it has: `actor_token_id: riley-token-id` (**not** Sam's token — the actor is who performed the action), `actor_type: 'human'`, `event_type: 'user.erasure_executed'`, `resource_id: sam-user-id`, `resource_type: 'user'`, `payload: { dataErasureRequestId, tablesErased: [...], revokedSessionCount }` — **and** the payload contains **no** PII: no email (original or scrubbed), no display name, no password hash fragment. Integration test asserts the payload JSON, stringified, contains none of Sam's original email substring.

**Edge case — Riley's own `user_identity_tokens` row was itself previously pseudonymized (e.g., Riley is being off-boarded via a separate process) at the moment they execute someone else's erasure:** not blocked — an admin/owner's own pseudonymization status is unrelated to their authority to act; the audit row still correctly references whatever `user_identity_tokens.id` Riley currently has (the FK is stable regardless of `display_name` changes).

---

### AC-13: Session/MFA/Recovery-Token Purge Completeness

**Given** Sam has: 2 active `sessions` rows, 1 confirmed + 1 pending `mfa_enrollments` row, 3 `mfa_recovery_codes` rows (2 unused, 1 used), and 1 unexpired `account_recovery_tokens` row,

**When** erasure executes,

**Then**, verified field-by-field in an integration test:
- Both `sessions` rows: `revoked_at` set, `session_version` incremented (via `revokeAllUserSessionsInOrg`, not new logic).
- Both `mfa_enrollments` rows (pending **and** confirmed): deleted — `SELECT count(*) FROM mfa_enrollments WHERE user_id = :samId` returns `0`.
- All 3 `mfa_recovery_codes` rows (used and unused): deleted — count returns `0`.
- The `account_recovery_tokens` row: deleted — count returns `0` (D5 gap-fix; without this check, a regression that forgets step 5/8 would go unnoticed).
- `users.mfa_enrolled_at`: `NULL`.

**Edge case — Sam has zero MFA enrollment (never set up MFA):** all MFA-related deletes affect 0 rows; erasure still succeeds (no error for "nothing to delete").

---

### AC-14: Compliance Report — Happy Path

**Given** Sam's erasure request is `status: 'completed'`,

**When** an `admin` or `owner` calls `GET /api/v1/org/users/:userId/erasure-request/:requestId/report`,

**Then** the response is `200`:
```json
{
  "data": {
    "requestId": "...",
    "executedAt": "2026-07-05T14:32:10.000Z",
    "piiRemoved": [
      { "table": "users", "fields": ["email", "passwordHash"], "method": "overwritten with sentinel/erased-domain value" },
      { "table": "user_identity_tokens", "fields": ["displayName"], "method": "replaced with pseudonymous alias" },
      { "table": "mfa_enrollments", "fields": ["secretEncrypted"], "method": "rows deleted" },
      { "table": "mfa_recovery_codes", "fields": ["codeHash"], "method": "rows deleted" },
      { "table": "account_recovery_tokens", "fields": ["tokenHash"], "method": "rows deleted" }
    ],
    "piiRetained": [
      { "table": "audit_log_entries", "reason": "audit log integrity — tamper-evident log (Story 8.1); identity pseudonymized via user_identity_tokens, not this table" },
      { "table": "org_memberships", "reason": "referential integrity — role/project history retained; display identity pseudonymized" },
      { "table": "rotation history / project_invitations.invitedBy", "reason": "referential integrity for historical operational records" }
    ],
    "retentionJustification": "audit log integrity",
    "auditEventId": "..."
  }
}
```

This is the machine-readable compliance artifact a regulator or DPO would receive as proof of erasure.

---

### AC-15: Compliance Report — Not Found / Not Yet Completed

**Given** a `requestId` that doesn't exist, or belongs to a different org, or belongs to Sam but `status` is still `'pending'`/`'in_progress'`,

**When** the report endpoint is called,

**Then**: unknown/cross-org `requestId` → `404 { code: "erasure_request_not_found" }`; `status: 'pending'` or `'in_progress'` → `409 { code: "erasure_not_yet_completed", status: "pending" }` (no report exists until execution completes — the report is a **post-execution** artifact, not a preview; the pre-execution PII inventory from AC-1 is a separate, already-returned payload).

---

### AC-16: Compliance Report — Authorization

**Given** the same setup as AC-14,

**When** a `member`/`viewer` calls the report endpoint,

**Then** `403 { code: "insufficient_role" }` (D7 — `admin`+`owner` only, same as request creation, since this is read-only).

---

### AC-17: Re-Invite Block — Happy Path (410 `user_erased`)

**Given** Sam's erasure request is `status: 'completed'` with `original_email_hash` stored for `sam@example.com`,

**When** Riley calls `POST /api/v1/projects/:projectId/invitations` with `{ "email": "sam@example.com", "role": "member" }` for **any** project in Org A,

**Then** the endpoint returns `410 { code: "user_erased" }` (checked after the existing `archivedAt`/`already_member` checks in `invitations/routes.ts`, per D6) and creates **no** `project_invitations` row.

**Edge case — email casing differs (`Sam@Example.COM`):** still blocked — the check reuses the same `normalizeEmail()` helper the invitation route already applies before its existing checks, so casing/whitespace normalization is consistent (D6 explicitly calls this out).

**Edge case — erasure request is still `status: 'pending'` (not yet executed) at invite time:** epics.md:1983 says "a user with a **pending or completed** erasure request" — so the block applies even before execution. The invite-check query includes `status IN ('pending','in_progress','completed')`.

---

### AC-18: Re-Invite Block — No False Positive for Unrelated Users

**Given** Sam's erasure is `completed`, and a **different**, never-erased user Alex has email `alex@example.com`,

**When** Riley invites `alex@example.com` to a project,

**Then** the invitation succeeds normally (`201`) — the hash lookup only matches Sam's specific original-email hash, not an unrelated email.

---

### AC-19: `data_erasure_requests` Table — RLS / Tenant Isolation (D1)

**Given** `data_erasure_requests` is a new, org-scoped table (has `org_id`),

**When** `packages/db/src/check-rls-coverage.ts`'s CI guard runs,

**Then** it must find a proper RLS policy scoping `data_erasure_requests` to `org_id` — this table is **not** added to `EXCLUDED_TABLES` (unlike `mfa_recovery_codes`/`account_recovery_tokens`, which are identity-scoped with no `org_id`; `data_erasure_requests` has a real `org_id` column and normal multi-tenant semantics, so it gets a normal policy, not an exclusion).

**And** an integration test confirms: an Org B admin querying/attempting to act on an Org A erasure `requestId` gets `404` (tenant isolation), not `403` (which would leak existence) — same convention as AC-3/AC-15.

---

### AC-20: Rate Limiting

**Given** the sensitive-mutation rate-limit tier already used for comparable high-stakes admin actions (`POST /org/users/:userId/deactivate`, `DELETE /org/users/:userId/sessions` — both `max: 20` per Story 4.3/1.7 precedent),

**When** the erasure-request, execute, and report routes are registered via `secureRoute()`,

**Then** each gets `rateLimit: { max: 20, timeWindowMs: 60_000, key: 'POST /api/v1/org/users/:userId/erasure-request' }` (and the equivalent per-route key for execute/report) — do not invent a new, unjustified rate-limit tier without citing this precedent (mirrors Story 8.1 finding 10's critique of switching precedents without acknowledgment — this story picks the mutating-admin-action precedent explicitly, not the read-only one, since even the "read-only" report endpoint exposes compliance-sensitive completion data).

---

### AC-21: `requireMfa` Gate

**Given** execution is the highest-stakes, `owner`-only action in this story (D7),

**When** the execute route is registered,

**Then** `security.requireMfa: true` (standard grace-respecting gate, matching the majority of `owner`-role mutating routes in `org/routes.ts`) — request-creation and report routes may use the same `requireMfa: true` default for consistency, since there's no cost to requiring it and it avoids the exact ambiguity Story 8.1 finding 9 flagged about borrowing a weaker analogy to justify skipping MFA.

---

### AC-22: Route Registration and CI Guards (Migration/Backward-Compatibility)

**Given** every new mutating route must be classified in `apps/api/src/lib/route-exemptions.ts`'s `RouteActionClassification` map (enforced by `route-audit.test.ts` per this repo's "thin routes" convention — routes.ts files must stay thin, with DB/business logic in sibling helper modules, not inline),

**When** this story adds `POST /api/v1/org/users/:userId/erasure-request`, `POST .../execute`, and `GET .../report` to `apps/api/src/modules/compliance/erasure-routes.ts` (thin route handlers) backed by `apps/api/src/modules/compliance/erasure-service.ts` (PII inventory computation, execution transaction, report builder — all business logic) and `apps/api/src/modules/compliance/pseudonymize-identity.ts` (D3's shared helper),

**Then**: (a) each route is added to `route-exemptions.ts` with `sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed'` (execute route) or `action: 'mutation'`/`'read'` as appropriate (request-creation/report routes); (b) `apps/api/src/app.ts` registers the new routes file with `prefix: '/api/v1/org'` (same prefix as existing `orgRoutes`, alongside the existing `/users/:userId/deactivate` pattern in that same URL family); (c) the new `data-erasure-requests.ts` Drizzle schema file is added to `packages/db/src/schema/index.ts`'s barrel export; (d) a new migration file claims the next available index in `packages/db/src/migrations/meta/_journal.json` (confirm the actual next-free index at implementation time — do not hardcode a number here since Stories 8.1/8.2 may have already claimed indices by then).

---

### AC-23: Integration Test Coverage Summary

Integration tests must cover, at minimum, one test per AC above, plus:
- PII inventory generation accuracy (AC-1) with non-trivial row counts (not just 0/1) for at least one many-rows table (`mfa_recovery_codes`).
- Full 8-step erasure execution (AC-5) with **every** field verified post-execution (AC-13), not just a status-code check.
- Audit event preserved and HMAC-verifiable post-erasure (AC-11) — this requires Story 8.1's verify endpoint to exist; if 8.1 isn't merged yet when this story's tests are written, assert directly against `computeAuditHmac` recomputation instead of calling the not-yet-existing HTTP endpoint, and add a `// TODO(8.1 merge): replace with GET /org/audit/verify call` comment.
- Re-invite blocked (AC-17) and not-blocked-for-unrelated-users (AC-18).
- Cross-org guard (AC-8) — this is the single highest-value test in this story; do not skip it.
- Concurrent execute race (AC-10).
- Compliance report format (AC-14) matches the documented shape exactly (snapshot-style assertion on keys present).
- RLS/tenant isolation (AC-19) — cross-org 404, not 403.

---

## Tasks / Subtasks

- [ ] Task 1: Schema (AC: 1, 19)
  - [ ] 1.1 Create `packages/db/src/schema/data-erasure-requests.ts` — org-scoped, `id`, `userId` (FK → `users.id`, no cascade delete since `users` row is never hard-deleted), `orgId`, `requestedBy`, `reason`, `status` (`check` constraint `IN ('pending','in_progress','completed')`), `originalEmailHash`, `createdAt`, `completedAt`.
  - [ ] 1.2 Add RLS policy for `data_erasure_requests` scoped to `org_id`; do **not** add to `EXCLUDED_TABLES`.
  - [ ] 1.3 Add indexes: `(org_id, user_id)`, `(status, created_at)` for the pending/in-progress lookup in AC-4.
  - [ ] 1.4 Add migration; confirm next-free index in `_journal.json` at implementation time.
  - [ ] 1.5 Add to `packages/db/src/schema/index.ts` barrel export.

- [ ] Task 2: Pseudonymization primitive (AC: 5, 11; D3)
  - [ ] 2.1 Create `apps/api/src/modules/compliance/pseudonymize-identity.ts` with `pseudonymizeUserIdentityToken(tx, userId)`.
  - [ ] 2.2 Confirm via test/read that `computeAuditHmac`'s field list excludes `display_name` (AC-11 depends on this).

- [ ] Task 3: PII inventory + request creation (AC: 1, 2, 3, 4)
  - [ ] 3.1 `erasure-service.ts`: `computePiiInventory(tx, orgId, userId)` — queries row counts across `users`, `user_identity_tokens`, `mfa_enrollments`, `mfa_recovery_codes`, `account_recovery_tokens`.
  - [ ] 3.2 `erasure-routes.ts`: `POST /users/:userId/erasure-request` — thin handler, `minimumRole: 'admin'`, calls service.

- [ ] Task 4: Execution (AC: 5-13; D2, D4, D5, D9, D10)
  - [ ] 4.1 `erasure-service.ts`: `executeErasure(tx, { requestId, orgId, actorUserId, actorTokenId })` — cross-org guard (D2) → status compare-and-set (D9) → 8 steps → audit write.
  - [ ] 4.2 Add `'erasure'` to `SessionRevokeScope` union in `session-revoke.ts` (D4).
  - [ ] 4.3 `erasure-routes.ts`: `POST /users/:userId/erasure-request/:requestId/execute` — `minimumRole: 'owner'`, `requireMfa: true`.

- [ ] Task 5: Compliance report (AC: 14, 15, 16)
  - [ ] 5.1 `erasure-service.ts`: `buildErasureReport(tx, requestId)`.
  - [ ] 5.2 `erasure-routes.ts`: `GET /users/:userId/erasure-request/:requestId/report` — `minimumRole: 'admin'`.

- [ ] Task 6: Re-invite block (AC: 17, 18; D6)
  - [ ] 6.1 Add `original_email_hash` lookup helper in `erasure-service.ts` (or a small shared `erasure-lookup.ts`).
  - [ ] 6.2 Modify `apps/api/src/modules/invitations/routes.ts` to check this after the existing `archivedAt`/`already_member` checks, before creating the invitation.

- [ ] Task 7: Registration and CI guards (AC: 19, 20, 21, 22)
  - [ ] 7.1 Register `erasure-routes.ts` in `app.ts` with `prefix: '/api/v1/org'`.
  - [ ] 7.2 Add all three routes to `route-exemptions.ts`'s classification map.
  - [ ] 7.3 Run `check-rls-coverage.ts` and `route-audit.test.ts` locally; fix any gaps before marking `review`.

- [ ] Task 8: Tests (AC: 23 — all ACs)
  - [ ] 8.1 Unit tests for `pseudonymizeUserIdentityToken`, `computePiiInventory`, `executeErasure`, `buildErasureReport`.
  - [ ] 8.2 Integration tests per AC-1 through AC-22 (see AC-23 checklist).
  - [ ] 8.3 `make ci` passes, including RLS/route-audit CI guards.

---

## Dev Notes

- **Do not reimplement session revocation, HMAC computation, or invitation validation** — reuse `revokeAllUserSessionsInOrg`, `writeHumanAuditEntryOrFailClosed`/`computeAuditHmac`, and the existing `invitations/routes.ts` validation chain respectively. This story is additive to all three.
- **Keep `erasure-routes.ts` thin** — per this repo's route-audit convention (bare `.get()`/`.post()` handlers should delegate to `erasure-service.ts`; do not inline DB queries or the 8-step transaction logic directly in the route file).
- **`users` rows are never hard-deleted** by this story — only specific columns are overwritten/nulled. This preserves every FK relationship (`org_memberships.user_id`, `project_invitations.invited_by`, `sessions.user_id`, etc.) without cascade complications.
- **The sentinel `password_hash` value** must be a fixed, well-documented constant that can never validate against any real password (e.g., a hash of a value that's structurally valid bcrypt-shape but whose plaintext is an unguessable, unused constant) — check whether an existing sentinel/placeholder pattern already exists elsewhere in the auth module before inventing a new format.
- **Do not build any UI in this story** (Product Surface Contract: `api`-only, gap already accepted at Epic 8 level per Stories 8.1/8.2 precedent).

### Project Structure Notes

- New module: `apps/api/src/modules/compliance/` (routes.ts, service.ts, pseudonymize-identity.ts) — first story to introduce this module directory; follows the existing per-feature module convention (`modules/audit/`, `modules/invitations/`, `modules/rotation/`, etc.).
- New schema file: `packages/db/src/schema/data-erasure-requests.ts`.
- Modified files: `apps/api/src/modules/auth/session-revoke.ts` (add `'erasure'` scope), `apps/api/src/modules/invitations/routes.ts` (add re-invite check), `apps/api/src/lib/route-exemptions.ts` (classify new routes), `apps/api/src/app.ts` (register new routes), `packages/db/src/schema/index.ts` (barrel export), `packages/db/src/check-rls-coverage.ts` (no change needed if RLS policy is correctly applied — just confirm the guard passes).

### Testing Standards Summary

- Integration tests use the existing `withTestOrg()` test-helper pattern (`packages/db/src/test-helpers.ts`).
- Cross-org scenarios (AC-8, AC-19) require **two** orgs in the same test — use two `withTestOrg()` contexts or the existing multi-org test pattern already established in Story 4.3's test suite.
- Concurrency test (AC-10) uses two concurrent transactions against the same `requestId` — mirror Story 4.3 AC-19's existing race-condition test pattern if one exists in that story's test file.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story 8.4: Data Subject Erasure Request Handling` (lines 1958-1985)] — literal AC text this story reinterprets per the Key Design Decisions above.
- [Source: `_bmad-output/planning-artifacts/epics.md#Epic 8` preamble (lines 1858-1870)] — PJ4/PJ5/PJ6/AC-E8a-d cross-cutting context.
- [Source: `_bmad-output/planning-artifacts/prd.md` lines 294, 597, 604-605, 631-633] — narrative GDPR erasure requirement (D8), no numbered FR.
- [Source: `_bmad-output/planning-artifacts/architecture.md` lines 76, 103, 133] — audit log vs. operational log classification; PII externalization design.
- [Source: `_bmad-output/implementation-artifacts/8-1-tamper-evident-audit-log-with-hmac-integrity.md`] — `audit_log_entries` schema, `writeHumanAuditEntryOrFailClosed`/`computeAuditHmac`, append-only guarantee.
- [Source: `_bmad-output/implementation-artifacts/8-1-tamper-evident-audit-log-with-hmac-integrity-adversarial-review.md` line 135] — table-name correction (`audit_events` → `audit_log_entries`) this story inherits.
- [Source: `_bmad-output/implementation-artifacts/8-2-audit-log-search-export-and-external-forwarding.md`] — Product Surface Contract precedent (API-only gap acceptance), cross-org display-name-bleed precedent informing D2.
- [Source: `_bmad-output/implementation-artifacts/8-3-access-reports-dormant-users-and-audit-pii-management` section of `epics.md`, lines 1932-1955] — `POST /pseudonymize` mechanism this story's D3 helper is built to be reused by.
- [Source: `_bmad-output/implementation-artifacts/4-3-account-deactivation-and-recovery.md` lines 64, 68, 102-122, 191-273] — cross-org scoping discipline (D2), one-way-door precedent (D11), `revokeAllUserSessionsInOrg`/`SessionRevokeScope` (D4), `account_recovery_tokens` schema (D5).
- [Source: `packages/db/src/schema/users.ts`, `user-identity-tokens.ts`, `mfa-enrollments.ts`, `mfa-recovery-codes.ts`, `org-memberships.ts`, `audit-log-entries.ts`, `project-invitations.ts`] — real schema this story's field-level ACs are grounded in.
- [Source: `apps/api/src/modules/auth/session-revoke.ts`] — `SessionRevokeScope` union (D4).
- [Source: `apps/api/src/lib/audit-or-fail-closed.ts`, `apps/api/src/modules/audit/human-entry.ts`] — `writeHumanAuditEntryOrFailClosed`/`writeHumanAuditEntry` this story's audit write reuses.
- [Source: `apps/api/src/modules/invitations/routes.ts` lines 129-191] — re-invite check insertion point (D6).
- [Source: `packages/db/src/check-rls-coverage.ts` lines 4-22] — `EXCLUDED_TABLES` precedent this story's `data_erasure_requests` table deliberately does **not** join (D1/AC-19).
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
