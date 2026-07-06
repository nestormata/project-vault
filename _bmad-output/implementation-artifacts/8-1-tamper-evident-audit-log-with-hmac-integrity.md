# Story 8.1: Tamper-Evident Audit Log with HMAC Integrity

Status: done

<!-- Ultimate context engine analysis completed 2026-07-04 — comprehensive developer guide for the audit-log HMAC integrity verification endpoint and its supporting CI guard. This is the FIRST story in Epic 8, but it is NOT a greenfield story: the `audit_log_entries` schema, the HMAC write path, the append-only RLS/trigger/grant stack, and the audit-signing-key derivation were all built incrementally by Epics 1–7 in anticipation of this epic (per epics.md PJ4/PJ5/PJ6). Read "Key Design Decisions & Open Questions" before writing any code — the single biggest risk on this story is reinventing infrastructure that already ships. -->

## Story

As an organization administrator and compliance officer,
I want every vault action recorded in a tamper-evident append-only audit log with row-level HMAC integrity verification,
so that I can prove to auditors that the log has not been altered since it was written.

*Covers: FR40, FR78.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-8.1` (lines 1872-1900)]

**Out of scope for this story (belongs to later stories — do not implement here):**
- Audit log search/filter UI and API, CSV export, external forwarding (webhook/S3), retention configuration — **Story 8.2** (FR41, FR42, FR43, FR70).
- Point-in-time access reports, dormant-user detection, user pseudonymization endpoint — **Story 8.3** (FR44, FR69, FR71, FR102). Story 8.3 depends on this story's backfill-coverage check (AC-13) having already run clean.
- Data-subject erasure request handling — **Story 8.4**.
- The separate `platform_audit_events` table, its own HMAC key (`project-vault-platform-audit-v1`), and the platform-operator-only verify endpoint — **Story 9.4**. Do not touch platform audit events in this story; they are a structurally separate table with separate RLS.
- Audit-signing-key **rotation** (deriving a new `auditKeyVersion` and re-signing/retaining old keys) — deferred to a future story per the comment already in `packages/db/src/schema/vault-state.ts:9-11` ("Old key versions must be retained in a key_history store (Story 9.x)"). This story's verify endpoint must *detect* a key-version mismatch (AC-3) but does not implement rotation itself. **Known, accepted technical debt (adversarial review finding, high):** AC-3's check (`row.keyVersion === currentAuditKeyVersion(tx)`) is unconditional and permanent — it has no seam for verifying a row against a *retained historical* key. This is intentional for this story (rotation doesn't exist yet, so there is no historical key to check against), but it means **whichever future story implements rotation must also revisit and extend this story's AC-3 comparison** to accept `row.keyVersion` values found in the future `key_history` store, not just the current version — otherwise every pre-rotation row will read as a permanent false "tampering" failure the moment rotation ships. Flag this explicitly in that future story's planning rather than rediscovering it as a bug.

**Threat model boundary (adversarial review finding, critical) — read before assuming this endpoint's guarantee is absolute:** This story's tamper-evidence mechanism protects against **database-level tampering only** — i.e., an actor with direct SQL access to the database (bypassing the application layer) who tries to alter a row's contents after the fact. The append-only trigger + grant REVOKE (D1) make even that hard (see AC-2's edge case: a real "tampered" row can only be simulated by inserting a self-inconsistent row, since `UPDATE`/`DELETE` are blocked outright). It does **not** protect against compromise of the API process itself: an attacker who gains code-execution in the API process, or who otherwise obtains the in-memory audit-signing key cached by `getAuditKey()` (D1), could `INSERT` a fully self-consistent forged row — correct `hmac`, correct `keyVersion` — that this endpoint would report as passed, silently defeating the guarantee. This is a fundamental limitation of any single-key HMAC scheme with no external anchor (e.g., a hash chain periodically published to an external, independently-controlled log, or an HSM-backed signing key that never enters process memory in reconstructable form). Building such an anchor is out of scope for this story; if the threat model needs to extend to API-process compromise, that is a distinct, larger hardening initiative for a future story, not an oversight to fix here. State this boundary plainly to auditors/stakeholders relying on this feature: it proves "no one altered the log via the database," not "no one with API-level access ever could have."

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story ships one owner-only verification endpoint consumed via REST API / curl, not a web screen |
| **Linked UI story** (if API-only) | `TBD` — **accepted trade-off for this story, not a blocker to `ready-for-dev`:** no story anywhere in the current epics.md (Epic 8's four stories, or any other epic) scopes a dedicated web UI for the audit log. The PRD's Dana persona journey (`prd.md:241`, "she opens Project Vault's audit log interface") and epics.md's AC-E8c ("displayed in the UI as a paginated table") both imply a UI surface exists somewhere, but no story number is assigned to build it. This is the same category of planning gap Story 7.1 flagged for machine-user management UI. FR40/FR78 (this story's covered requirements) describe an integrity-verification *capability*, satisfiable via API alone — the missing UI story affects Stories 8.2/8.3 (which explicitly need UI tables) more directly than it affects this one. **This story proceeds API-only deliberately**; the gap must still be raised at Epic 8 sprint planning before 8.2/8.3 are scoped, so it doesn't silently resurface as a surprise then. |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is being deferred with a placeholder; none exists yet for this surface, and no SvelteKit route should be stubbed in this story (would create dead route code with no linked follow-up story). |
| **Persona journey** | N/A — API-only, no evaluator-visible UI in this story. Rationale: FR40/FR78 describe an integrity-verification capability consumed by a compliance officer via API/export tooling; there is no human end-user journey through a web surface for this story's scope. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** It resolves what already exists (do not rebuild it) versus what is genuinely net-new in this story, and one concrete conflict between epics.md's literal wording and the shipped codebase.

### D1 — The `audit_log_entries` table, HMAC write path, RLS, and append-only enforcement are ALREADY SHIPPED — do not recreate any of it

Epics.md's Story 8.1 AC text (`epics.md:1882-1888`) reads as if the schema and write path are being created by this story. **They are not.** The following already exist, built by prior epics per the PJ4/PJ5/PJ6 cross-epic notes in epics.md's Epic 8 preamble:

| What epics.md's AC text describes | What already ships, and where |
|---|---|
| `audit_events` row with `id, orgId, projectId, actorTokenId, actorType, eventType, resourceId, resourceType, ipAddress, userAgent, payload, keyVersion, hmac` | Table is named **`audit_log_entries`** (not `audit_events` — same naming divergence Story 7.1's D9 already documented and resolved the same way: shipped code wins). Full Drizzle schema: `packages/db/src/schema/audit-log-entries.ts`. All fields listed in epics.md exist, field-for-field. |
| Audit signing key derived via HKDF with `info: "project-vault-audit-log-v1"` | `packages/crypto/src/kdf.ts:8` — `HKDF_INFO.AUDIT_LOG = 'project-vault-audit-log-v1'`. Derived and cached in-memory at vault init/unseal: `apps/api/src/modules/vault/key-service.ts:300,365,404-409` (`getAuditKey()`). |
| `hmac = HMAC-SHA256(auditSigningKey, canonicalJSON({...}))`, sorted keys, no whitespace | `apps/api/src/modules/audit/write-entry.ts` — `computeAuditHmac()`. Already covered by a determinism unit test (`write-entry.test.ts`). **Reuse this function; do not write a second HMAC helper.** |
| Same-transaction audit write, 100% capture invariant | `apps/api/src/lib/secure-route.ts` (`defaultAuditWriter`, wired into every `SecureRoute` via `writeAuditEvent`) + `apps/api/src/modules/audit/human-entry.ts` (`writeHumanAuditEntry`) + `apps/api/src/lib/audit-or-fail-closed.ts` (`writeHumanAuditEntryOrFailClosed`, used for audit rows written mid-handler rather than via the `SecureRoute` default writer). Both paths throw `SameTransactionAuditWriteError`/`AuditWriteError` on failure, which `secure-route.ts`'s `sendSecureRouteFailure` turns into a `503 audit_write_failed` and rolls back the whole transaction — the "if the audit write fails, the triggering operation fails" invariant (NFR-REL5) is **already enforced for every mutating route in the codebase**, not something this story adds. |
| `actorTokenId` — "never raw user identity" (PJ6) | Already structural, not a convention to police: `actor_token_id` is a **foreign key** to `user_identity_tokens(id)` (`audit-log-entries.ts:17`, enforced in migration `0000_initial_schema.sql:101`). It is architecturally impossible to insert a row referencing a UUID that isn't a real `user_identity_tokens.id` — the FK constraint rejects it at the database level. See D3 for what this means for the PJ6 "backfill check" AC. |
| RLS policy scoped to `org_id`, append-only enforcement | `packages/db/src/migrations/0001_rls_and_triggers.sql:41,53` (RLS enabled + `audit_log_isolation` policy), `:58-69` (`prevent_audit_log_mutation()` trigger blocking UPDATE/DELETE), `packages/db/src/migrations/0002_audit_log_revoke.sql` (defense-in-depth `REVOKE UPDATE, DELETE ON audit_log_entries FROM vault_app` — this fires *before* the trigger since Postgres checks grants first). Already covered by `packages/db/src/__tests__/audit-log-immutability.test.ts` and generically by `check-rls-coverage.ts` (audit_log_entries has an `org_id` column and is not in `EXCLUDED_TABLES`, so the existing coverage check already asserts it has a policy — see AC-9). |
| `keyVersion` tracking for future rotation | `packages/db/src/schema/vault-state.ts:29` (`auditKeyVersion`, starts at 1) + `apps/api/src/modules/audit/key-version.ts` (`currentAuditKeyVersion(tx)`). Rotation itself is out of scope (see "Out of scope" above). |
| Human actor writes across Epics 1–7 | Wired into every mutating `SecureRoute` and into bootstrap flows (registration — `apps/api/src/modules/auth/service.ts:383-398`, which also inserts the user's `user_identity_tokens` row in the **same transaction** as their first audit event). |

**Net effect: this story requires zero new migrations and zero new schema.** Its actual net-new deliverables are:
1. `GET /api/v1/org/audit/verify` — the verification endpoint (does not exist anywhere in the codebase today; confirmed by grep — no route, no handler, no schema file references it).
2. A CI-enforced backfill/coverage check for the PJ6 concern, adapted to how `actorTokenId` actually works (see D3).
3. Integration tests proving the *existing* write path plus the *new* verify endpoint compose correctly (clean range, tampered range, key-version-mismatch range, empty range, cross-org isolation).

If you find yourself writing a new Drizzle schema file, a new HMAC function, or a new migration for this story, stop and re-read this section — it means something has been misread.

### D2 — Endpoint location: new `apps/api/src/modules/audit/routes.ts`, registered under the existing `/api/v1/org` prefix

- `apps/api/src/modules/audit/` already exists as a module directory (`actor-token.ts`, `human-entry.ts`, `key-version.ts`, `write-entry.ts`) but has no `routes.ts` yet.
- `apps/api/src/app.ts:192` already registers `orgRoutes` at `{ prefix: '/api/v1/org' }`. Following the exact precedent of `credentialRoutes`/`rotationRoutes`/`monitoringRoutes` all sharing the `/api/v1/projects` prefix as separate registered plugins (`app.ts:198-200`), this story adds a new `auditRoutes` plugin registered with the **same** `/api/v1/org` prefix (`app.ts:192` area) rather than bolting the route onto `modules/org/routes.ts` — keeping the audit module's routes, business logic, and schema colocated under `modules/audit/` matches how every other feature module (`modules/rotation/`, `modules/monitoring/`) is organized.
- Resulting path: `GET /api/v1/org/audit/verify` — matches epics.md's literal endpoint path exactly (`epics.md:1890`).
- New files this story adds: `apps/api/src/modules/audit/routes.ts` (thin `secureRoute` registration only — no inline DB queries in the handler body beyond calling the sibling helper), `apps/api/src/modules/audit/verify.ts` (the actual recompute-and-compare logic, called from the route handler — mirrors the existing separation where `human-entry.ts`/`write-entry.ts` hold logic and routes call into them), `apps/api/src/modules/audit/schema.ts` (Zod query/response schemas, matching the `modules/org/schema.ts` / `modules/admin/schema.ts` convention).

### D3 — PJ6 "backfill check for raw `actor_id` values" reinterpreted for this codebase's actual schema

- Epics.md's PJ6 (`epics.md:1866`) and Story 8.1's literal AC (`epics.md:1896`) describe a backfill check for "`actor_id` values not routed through `user_identity_token`" — i.e., rows storing a raw user UUID instead of a token reference. **This scenario is structurally impossible here**: there is no `actor_id` column at all, only `actor_token_id`, and it is a real foreign key to `user_identity_tokens(id)` (D1). A row with a raw, non-token UUID in that column would be rejected by the FK constraint at insert time — the database itself is the backfill guard for "wrong reference type."
- **The real gap this check needs to catch:** `actor_token_id` is **nullable**, and `firstActorTokenIdForUser()` (`apps/api/src/modules/audit/actor-token.ts`) returns `null` if a user has no `user_identity_tokens` row. Every user created through the normal registration flow (`apps/api/src/modules/auth/service.ts:383-398`) gets a `user_identity_tokens` row in the *same transaction* as their first audit event, so this should never happen for a properly-onboarded user — but a future story's code path (or a bug) could write a `actorType: 'human'` audit row with `actorTokenId: null`, and such a row can **never be pseudonymized** by Story 8.3's GDPR erasure mechanism (there is no token to alias). That is the real compliance gap PJ6 is protecting against, translated to this schema.
- **Decision implemented in this story:** the "backfill check" (AC-13/AC-14) queries for `audit_log_entries` rows where `actor_type = 'human' AND actor_token_id IS NULL`. Today this should return zero rows (confirmed by reading every write call site — see D1 table); the check exists so it **stays** zero as new stories are added, and is wired into `make ci` as a hard gate (matching `check-rls-coverage`'s pattern), not left as a one-time manual audit.
- **Scope boundary, `actor_type = 'human'` only (adversarial review finding, medium):** this check deliberately does not cover `actor_type = 'machine_user'` rows, which Stories 7.1/7.2 (not yet implemented) will start writing to this same table. Machine-user identity is a structurally different model (API-key-based, not `user_identity_tokens`-based), so the same nullability gap and the same GDPR-pseudonymization rationale may not apply unchanged — but that hasn't been designed yet. This is an intentional, explicitly-flagged scope boundary, not a silent gap: **Story 7.1/7.2 or Story 8.3 must revisit whether machine-user audit rows need an analogous coverage check** once that schema exists, rather than assuming this check already covers them.

### D4 — Verify endpoint range bounding: epics.md doesn't specify a limit; this story adds one

- epics.md's AC (`epics.md:1890`) specifies `GET /api/v1/org/audit/verify?from=<ISO>&to=<ISO>` with no stated bound on range size or row count. Recomputing an HMAC per row is CPU-bound; an org with millions of historical rows calling this with an unbounded range would be a self-inflicted DoS vector and directly touches NFR-PERF-style concerns already established elsewhere in the codebase (e.g., `AUDIT_LOG_STORAGE_LIMIT_GB` guard planned for Story 9.2).
- **Decision implemented in this story:** the endpoint enforces `to - from <= 90 days` (`AUDIT_VERIFY_MAX_RANGE_DAYS`, a named constant in `verify.ts`, not a magic number) and a hard cap of `AUDIT_VERIFY_MAX_ROWS = 50_000` rows actually recomputed per call; exceeding either returns `422 { code: "range_too_large" }` (see AC-6). A compliance officer verifying a full year needs to make ~4-5 calls across sub-ranges — an acceptable trade-off documented in the response error message itself, not just internal comments.
- **Row-count check is race-free by construction (adversarial review finding, medium — corrected design):** the row-count guard is **not** implemented as a separate `COUNT(*)` pre-check followed by a second SELECT (which would leave a check-then-act window where concurrent writes land between the two queries, given AC-12 explicitly allows concurrent writes during a verify call). Instead, `verify.ts` issues a **single** query with `LIMIT AUDIT_VERIFY_MAX_ROWS + 1`. If the result set's length exceeds `AUDIT_VERIFY_MAX_ROWS`, the endpoint returns `422 { code: "range_too_large" }` without recomputing any HMACs; otherwise it proceeds directly with the same already-fetched rows. This is both race-free (one query, one snapshot) and strictly cheaper (no redundant COUNT query on the hot path).
- **Range boundary semantics (adversarial review finding, medium):** the range is **inclusive of `from`, exclusive of `to`** (`created_at >= from AND created_at < to`) — the same half-open convention used elsewhere for time-window queries. This is what makes D4's "stitch adjacent sub-range calls together" guidance gapless and non-duplicating: a compliance officer calling `[T0, T1)`, then `[T1, T2)`, then `[T2, T3)` covers every row exactly once with no missed or double-counted boundary row.

### D5 — Authorization: owner-only, no additional `requireMfa` flag on this GET

- epics.md is explicit: "the integrity verification endpoint is accessible to `owner` role only" (`epics.md:1892`). This is the **first** `allowedRoles: ['owner']`-only endpoint in the codebase (grep confirms no precedent) — every existing admin-tier endpoint uses `minimumRole: 'admin'` (which also admits `owner`) or `allowedRoles: ['admin', 'owner']`.
- Per the architecture's blanket MFA-enforcement rule (`architecture.md:319`), any authenticated `owner` without MFA enrolled and past their grace period is already rejected upstream with `403 MFA_ENROLLMENT_REQUIRED` before reaching route-level checks; per `mfa-policy-matrix.md:62`, safety/security-visibility GET endpoints are **not** additionally gated with `requireMfa: true` at the route level, precisely so admins/owners mid-grace-period can still see security-relevant state.
- **Corrected precedent citation (adversarial review finding, medium):** `GET /org/security-alerts` (`modules/org/routes.ts:78-93`) is cited here as the *category* precedent (a security-visibility GET endpoint intentionally left off `requireMfa`), **not** as an exact-audience match — that route's `allowedRoles` is actually `['owner', 'admin']`, a broader audience than this story's owner-only endpoint. Since this is the codebase's first-ever owner-only endpoint, it does not inherit an audience-identical precedent; the independent justification for skipping `requireMfa` here is the general `mfa-policy-matrix.md:62` rule itself (any security-visibility GET, regardless of which roles it admits, is intentionally left off `requireMfa` so a not-yet-MFA-enrolled-but-in-grace user in an allowed role isn't locked out of seeing security state) — **decision: no `requireMfa: true`** on this route, on that general-rule basis rather than a false audience-equivalence claim.

### D6 — Route-audit classification: `action: 'read'`, not `'sensitive-read'`

- `apps/api/src/lib/route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` requires every route to declare a classification (enforced by `route-audit.test.ts`). The closest precedent is `GET /api/v1/org/security-alerts` (`route-exemptions.ts:199-204`): `action: 'read'`, `auditOmissionReason`, `reviewer: SECURITY_OWNER`. `GET /api/v1/org/audit/verify` returns pass/fail counts and HMAC-mismatch metadata — never a secret value, never a credential — so it is classified the same way, not as `'sensitive-read'` (reserved for endpoints that reveal actual credential plaintext, e.g. `GET .../credentials/:id/value`).
- **Decision implemented in this story:** add `'GET /api/v1/org/audit/verify': { action: 'read', auditOmissionReason: 'Integrity verification read returns pass/fail counts and event metadata only; never a secret or credential value.', reviewer: SECURITY_OWNER }` to `route-exemptions.ts`.

### D7 — This endpoint's own calls ARE audited (corrected from an earlier "no audit write" assumption)

- **Adversarial review finding (medium):** an earlier draft of this story registered the route with `writeAuditEvent: false` and described no audit entry for calls to the verify endpoint itself. For a compliance-focused feature, "who ran an integrity check, and when" is itself a fact worth auditing — both for due-diligence evidence and for detecting a compromised owner account probing what has/hasn't been detected.
- **Decision implemented in this story:** the route uses the standard `SecureRoute` default audit writer (`writeAuditEvent: true`, the same-transaction path already shipped by D1 — no new write-path code needed), recording a new `eventType: 'audit.integrity_verify_run'` with `payload: { from, to, rowsChecked, passed, failedCount }` (the true total, not `failed.length` — see AC-2's truncation note). This reuses the existing `defaultAuditWriter`/`writeHumanAuditEntry` path exactly like every other mutating-or-notable route; it does not require the endpoint to be reclassified as a mutation, since audit writes already accompany plenty of GET-shaped security-relevant reads elsewhere in the codebase's `SecureRoute` conventions.
- Task 3.1 (below) reflects this: `writeAuditEvent: true`, not `false`.

---

## Prerequisites

| Prerequisite | Why | Status |
|---|---|---|
| Story 1.4 (Database Foundation, RLS, core schema) | Ships `audit_log_entries`, RLS, append-only trigger/grant, `check-rls-coverage.ts` | `done` |
| Story 1.5 (Vault Init & Master Key Management) | Ships the audit-signing-key HKDF derivation (`HKDF_INFO.AUDIT_LOG`) and `getAuditKey()` | `done` |
| Story 1.6 (User Registration) | Ships `user_identity_tokens` row creation at registration, same transaction as the first audit event | `done` |
| Story 1.11 (SecureRoute framework + Drizzle RLS middleware) | Ships the `SecureRoute` same-transaction audit-write wiring this story's verify endpoint reads *and* the transactional guarantees it depends on | `done` |
| Epics 2–7 (all `done`/`ready-for-dev` stories that write audit rows) | Populate `audit_log_entries` with real historical data this endpoint verifies; no re-ingestion needed (PJ5) since all epics share the one table | mixed — irrelevant to this story's correctness, since verify operates generically over whatever rows exist |
| `packages/db/src/migrations/meta/_journal.json` — latest migration is `0028_monitoring_records.sql` (idx 28) | **This story adds no migration** (D1), so this is informational only — confirm no new migration is needed before assuming one is, if requirements drift during implementation | n/a |

---

## Epic Cross-Story Context

| Story | Relationship to 8.1 |
|---|---|
| 8.2 (Audit Log Search, Export & External Forwarding, `backlog`) | Calls this story's verification logic (`verify.ts`'s exported function, not a new copy) as a **mandatory precondition** before any export proceeds (`epics.md:1920`, "the export job: (1) runs integrity verification first (Story 8.1)"). 8.2 must import and reuse `verifyAuditRange()` from `apps/api/src/modules/audit/verify.ts` — do not let 8.2 reimplement HMAC recomputation. |
| 8.3 (Access Reports, Dormant Users & Audit PII Management, `backlog`) | Re-runs this story's backfill/coverage check as part of its own completion gate (`epics.md:1950`) — the check function (AC-13) must be exported and reusable, not just a CLI script, so 8.3 can invoke it programmatically if needed. |
| 9.4 (Platform Operator Audit Log, `backlog`) | Reuses the **same HMAC mechanism** (`computeAuditHmac`) but against a structurally separate `platform_audit_events` table with a separate signing key (`project-vault-platform-audit-v1`) and a separate `GET /api/v1/platform/audit/verify` endpoint. Do not generalize this story's `verify.ts` to also handle the platform table — 9.4 should write its own thin wrapper calling the same `computeAuditHmac()` primitive, matching the precedent 8.1 itself sets by reusing (not rewriting) `write-entry.ts`. |
| 7.1/7.2 (Machine User Identity/Auth, `ready-for-dev`, not yet implemented) | Once implemented, machine-user actions will write `actorType: 'machine_user'` rows to the same `audit_log_entries` table (PJ4, already true structurally — the `actor_type` CHECK constraint already permits `'machine_user'`). This story's verify endpoint requires no changes to support that — it operates generically over `actor_type` values. |
| 1.10 (Structured Operational Logging & Metrics, `done`) | A **different concern**: pino structured *operational* logs (errors, request traces) versus this story's *compliance* audit trail. Do not conflate `request.log` calls with `audit_log_entries` rows — they serve different purposes and neither replaces the other. No code sharing expected between them. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 8.1 | Rationale |
|---|---|---|
| epics.md: table named `audit_events` | Table is `audit_log_entries` (already shipped) | Same resolution as Story 7.1's D9 — shipped code wins over an epics.md literal that was never implemented under that name |
| epics.md PJ6: backfill check for raw `actor_id` values | Check for `actor_type='human' AND actor_token_id IS NULL` rows instead (D3) | The literal scenario (raw UUID bypassing token reference) is structurally prevented by the FK constraint; the real residual risk is a NULL token reference, not a wrong-type reference |
| epics.md: no stated range/row limit on verify | `AUDIT_VERIFY_MAX_RANGE_DAYS = 90`, `AUDIT_VERIFY_MAX_ROWS = 50_000` (D4) | Prevents unbounded CPU-bound recomputation from being a self-inflicted availability risk; documented in the 422 error response itself |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Schema | **None new.** `audit_log_entries`, RLS, append-only trigger/grant, `vault_state.audit_key_version` all already exist (D1). |
| GET `/api/v1/org/audit/verify` | `allowedRoles: ['owner']`, no `requireMfa` flag (D5). Recomputes HMAC for every row in `[from, to]` for the caller's org; returns pass/fail summary. `422` on missing/invalid/inverted/oversized range. |
| Response shape | `{ summary, rowsChecked, passed, failed: [{ id, eventType, timestamp }] (capped at 500), failedCount, failedTruncated, verifiedAt }` — comprehensible without cryptography background (UX-DR13); `failedCount`/`failedTruncated` guard against an unbounded payload on bulk-tamper (see AC-2). |
| Tamper detection | A row whose stored `hmac` doesn't match the recomputed HMAC over its own stored fields is reported as failed. |
| Key-version mismatch | A row whose `keyVersion` differs from the org's current `vault_state.auditKeyVersion` is reported as failed (rotation-without-re-signing scenario; not naturally reachable yet since rotation isn't implemented — tests simulate it directly). |
| Tenant isolation | Verification only ever considers the caller's own org's rows; RLS makes cross-org rows structurally invisible regardless of query construction. |
| Vault sealed | If the vault is sealed (`getAuditKey()` throws), the endpoint returns `503 { code: "audit_key_unavailable" }`, not a crash or a false-negative "all passed." |
| Rate limiting | `20/min` per owner (CPU-bound recompute; tier borrowed from existing mutating-route precedents, e.g. account deactivation/session revocation, chosen for the shared resource-protection rationale, not because this is itself a mutation — see AC-11). |
| Concurrency | Verification is a point-in-time read; concurrent audit writes during a verify call are unaffected and do not corrupt the count (standard read-committed semantics — no new locking needed). |
| Backfill/coverage CI guard | New `packages/db/src/check-audit-actor-token-coverage.ts` + `scripts/check-audit-actor-token-coverage.ts`, wired into `make ci` and root `package.json`'s script list the same story it's introduced (product-surface-contract G3). Fails CI if any `actor_type='human'` row has `actor_token_id IS NULL`. |
| RLS/route-audit CI coverage | New route is classified in `route-exemptions.ts` (D6); `check-rls-coverage.ts` already covers `audit_log_entries` generically — this story adds an explicit assertion test confirming that, rather than relying on the generic check alone. |
| Migration safety | Zero new migrations; zero changes to any existing table or column. |
| Integration tests | Cover every AC below: verify pass (clean rows), verify fail (tampered row), key-version mismatch, missing/invalid/inverted/oversized date range, empty range, owner-only authz (403 for admin/member/viewer), cross-org isolation, vault-sealed 503, rate limiting, concurrent write during verify, backfill check clean/dirty cases, route-audit + RLS-coverage CI gates. |

---

### AC-1: Verify Endpoint — Happy Path, All Rows Pass

**Given** an org owner is authenticated and the org has 3 audit log rows written in the last hour, all inserted through the normal write path (`writeHumanAuditEntryOrFailClosed` or the `SecureRoute` default writer) and therefore all HMAC-valid,

**When** they call `GET /api/v1/org/audit/verify?from=2026-07-04T00:00:00.000Z&to=2026-07-04T23:59:59.999Z`,

**Then** the response is `200`:

```json
{
  "data": {
    "summary": "All 3 records verified — no tampering detected",
    "rowsChecked": 3,
    "passed": 3,
    "failed": [],
    "failedCount": 0,
    "failedTruncated": false,
    "verifiedAt": "2026-07-04T18:32:10.104Z"
  }
}
```

**And** each row's HMAC is recomputed via the *existing* `computeAuditHmac()` (`apps/api/src/modules/audit/write-entry.ts`) over exactly the same field set used at write time: `{ orgId, actorTokenId, actorType, eventType, resourceId, resourceType, payload, keyVersion }` — reusing the write-path function guarantees recompute and original-compute can never silently drift apart into two different canonicalization implementations.

**And** the recomputed HMAC is compared to the stored HMAC using a **constant-time comparison** (`crypto.timingSafeEqual`, comparing fixed-length buffers — not a plain `===`/`!==` string comparison), so the security-critical comparison at the center of this endpoint does not reintroduce a timing side-channel (adversarial review finding, medium).

---

### AC-2: Verify Endpoint — Tampered Row Detected

**Given** an org has 2 legitimately-written rows and one additional row inserted **directly via raw SQL** (bypassing `writeHumanAuditEntry`) with a `hmac` value that does not match what `computeAuditHmac()` would produce for its own stored fields — simulating what a tampered row looks like, since the append-only trigger + grant REVOKE (D1) make it impossible to actually `UPDATE` an existing row's `hmac` after the fact,

**When** the owner calls `GET /api/v1/org/audit/verify` over a range covering all 3 rows,

**Then** the response is `200` (verification *running* successfully is not the same as verification *passing* — this is not an error, it's the mechanism working as designed):

```json
{
  "data": {
    "summary": "2 of 3 records verified — 1 record failed integrity check",
    "rowsChecked": 3,
    "passed": 2,
    "failed": [
      {
        "id": "d4e5...-uuid",
        "eventType": "credential.value_revealed",
        "timestamp": "2026-07-04T17:10:00.000Z"
      }
    ],
    "failedCount": 1,
    "failedTruncated": false,
    "verifiedAt": "2026-07-04T18:32:10.104Z"
  }
}
```

**Edge case — integration test guidance:** because `UPDATE`/`DELETE` on `audit_log_entries` are blocked at both the trigger and grant layer (D1), any test that needs a "tampered" row must construct it at **insert time** with a deliberately wrong `hmac` string (e.g., `hmac: 'deadbeef'.repeat(8)`), not attempt to insert-then-corrupt. Attempting an `UPDATE` in a test to simulate tampering will itself throw a permission-denied error before the test even reaches the assertion under test — this is expected and is not a bug in the test.

**Edge case — large-scale failure payload (adversarial review finding, medium):** `rowsChecked` is capped at `AUDIT_VERIFY_MAX_ROWS = 50,000` (D4), but in a systemic-tamper or bulk-corruption scenario the `failed` array itself is otherwise unbounded and could return tens of thousands of entries in one JSON payload. The response caps `failed` at the first `500` entries (ordered by `timestamp` ascending) and adds two fields to the response shape: `failedCount` (the true total, which may exceed `failed.length`) and `failedTruncated: boolean`. The `summary` string still reports the true `failedCount`, not `failed.length`, so the human-readable summary is never misleading even when the array is truncated. See AC-17 for the corresponding schema addition.

---

### AC-3: Verify Endpoint — Key-Version Mismatch Detected as Failure

**Given** the org's `vault_state.auditKeyVersion` is `1` (the only value possible today, since key rotation is not yet implemented — see "Out of scope"), and a row is inserted directly with `keyVersion: 2` and a correctly-computed HMAC *for that row's own fields including `keyVersion: 2`*,

**When** the owner calls `GET /api/v1/org/audit/verify` over a range covering that row,

**Then** the row is reported in `failed` — **not** because the HMAC recomputation fails (it would actually match, since the test constructs a self-consistent row), but because the row's `keyVersion` does not equal `currentAuditKeyVersion(tx)` (`epics.md:1890`: "the current audit signing key version must match the row's `keyVersion` for verification to pass"). The verify logic must check both conditions independently — `hmacMatches AND row.keyVersion === currentKeyVersion` — a row can fail on either condition alone.

**And** the response's `failed` entry for this row has the same shape as AC-2's tampered-row entry — the caller-facing response does not need to distinguish "wrong HMAC" from "key version mismatch" (both are "integrity could not be confirmed" from an auditor's point of view); the distinction matters only for internal test assertions and pino debug logs, not the API contract.

**Known forward dependency (see "Out of scope" — key rotation):** this equality check is unconditional and has no historical-key seam. Whichever future story implements key rotation must revisit this check to also accept a row's `keyVersion` against a retained historical key, not just the current one — otherwise rotation will retroactively turn every pre-rotation row into a false failure here.

---

### AC-4: Verify Endpoint — Authorization: Owner-Only

**Given** an authenticated user with `orgRole: 'admin'`, `'member'`, or `'viewer'` (each tested independently),

**When** they call `GET /api/v1/org/audit/verify?from=...&to=...`,

**Then** the response is `403 { "code": "insufficient_role", "message": "Insufficient permissions" }` — matching `secure-route.ts`'s existing `sendInsufficientRole()` output exactly, since `allowedRoles: ['owner']` is enforced by the same `hasSufficientRole()` check every other `SecureRoute` uses (D5). No new authorization primitive is introduced.

**Edge case:** an unauthenticated request (no/invalid JWT) returns `401 { "code": "access_token_missing", ... }` before the role check ever runs — standard `SecureRoute` ordering, not new to this story.

---

### AC-5: Verify Endpoint — Tenant Isolation

**Given** org A has 5 audit rows and org B has 3 audit rows, both created via `withTwoTestOrgs()`,

**When** org A's owner calls `GET /api/v1/org/audit/verify` over a range covering both orgs' timestamps,

**Then** `rowsChecked` is `5`, never `8` — RLS (`audit_log_isolation` policy, already shipped) makes org B's rows structurally invisible to any query run with `app.current_org_id` set to org A, **regardless of how the verify query is written** (no `WHERE org_id = ...` clause needs to be hand-added in `verify.ts` — the `SecureRoute` transaction wrapper already calls `setRlsOrgContext(tx, auth.orgId)` before the handler runs, exactly like every other org-scoped route).

**And** an explicit regression test asserts this by running the identical query with two different `orgId` GUC values inside `withTwoTestOrgs()` and confirming each only sees its own org's count — this guards against a future refactor accidentally adding a raw `getDb()` call that bypasses the transaction-scoped RLS context (the same anti-pattern `architecture.md:280` already forbids via ESLint).

---

### AC-6: Verify Endpoint — Query Validation (Missing, Invalid, Inverted, Oversized Range)

**Given** an authenticated owner,

**When** they call the endpoint with any of the following malformed queries, tested independently:

| Query | Expected response |
|---|---|
| No `from`/`to` at all | `422 { code: "validation_error", details: { from: [...], to: [...] } }` — both are required, no default range is silently assumed (an auditor must be explicit about what window they're attesting to) |
| `from=not-a-date&to=2026-07-04T00:00:00.000Z` | `422` — Zod `z.iso.datetime()` rejects the malformed `from` |
| `from=2026-07-04T00:00:00.000Z&to=2026-07-01T00:00:00.000Z` (to before from) | `422 { code: "invalid_range", message: "..." }` |
| `from === to` (zero-width range) | **Not an error** — valid, since the range is half-open (`>= from AND < to`, D4); a zero-width window matches zero rows and returns `200` with the empty-range shape from AC-7, not `422` |
| `from`/`to` spanning 91 days (`AUDIT_VERIFY_MAX_RANGE_DAYS = 90`) | `422 { code: "range_too_large", message: "Range exceeds 90 days; narrow the from/to window and call again" }` (D4) |
| A valid ≤90-day range that would match more than `AUDIT_VERIFY_MAX_ROWS = 50,000` rows | Same `422 { code: "range_too_large" }` — detected via the single `LIMIT AUDIT_VERIFY_MAX_ROWS + 1` query described in D4 (not a separate `COUNT(*)` pre-check, which would leave a race window against AC-12's concurrent writes); the endpoint never recomputes HMACs for a rejected range |

**Then** each case is verified by an independent test; the missing/invalid/inverted/oversized-range cases never reach the HMAC-recompute step (the oversized-range case does touch the database — the single bounded-`LIMIT` query itself — but that query's own row count, not an HMAC comparison, is what triggers the rejection).

---

### AC-7: Verify Endpoint — Empty Range

**Given** an org with audit rows only outside the requested range (e.g., all rows are from last month),

**When** the owner calls `GET /api/v1/org/audit/verify?from=<today>&to=<today+1day>`,

**Then** the response is `200`:

```json
{
  "data": {
    "summary": "No records found in this range",
    "rowsChecked": 0,
    "passed": 0,
    "failed": [],
    "failedCount": 0,
    "failedTruncated": false,
    "verifiedAt": "2026-07-04T18:32:10.104Z"
  }
}
```

**And** this is explicitly distinct from a validation error — a real, valid range with zero matching rows is a legitimate, common case (e.g., a brand-new org, or a Sunday with no activity), not something to reject. **This includes the zero-width case** (`from === to`, AC-6): since the range is half-open (`>= from AND < to`, D4), `from === to` matches zero rows by construction and takes this same empty-range path, not `422`.

---

### AC-8: Verify Endpoint — Non-Cryptographer-Comprehensible Response (UX-DR13)

**Given** the UX design spec's explicit requirement (`ux-design-specification.md:203`: "one that a non-cryptographer can understand, that produces output an auditor..."; `epics.md:1892`: `{ summary: "All 1,247 records verified — no tampering detected", passed: 1247, failed: 0 }`),

**When** any verify response is constructed (all-pass, some-fail, or empty-range cases above),

**Then** the `summary` field is always a complete, grammatically correct English sentence stating the pass count and total count with no jargon (no "HMAC," "hash," "cryptographic" in the summary string itself — those terms are fine in API documentation, not in the runtime response body a compliance officer might paste directly into an audit report). Exact phrasing rules, enforced by unit test on the summary-builder function in `verify.ts`:
- All pass: `` `All ${rowsChecked} records verified — no tampering detected` ``
- Some fail: `` `${passed} of ${rowsChecked} records verified — ${failedCount} record${failedCount === 1 ? '' : 's'} failed integrity check` `` (singular/plural handled, using the true `failedCount` per AC-2's truncation note, not `failed.length`)
- Zero rows: `"No records found in this range"`

**Scope note (adversarial review finding, low):** this jargon ban applies only to the **runtime `summary` string value** in the response body. It does not extend to the OpenAPI spec's field descriptions, this story's own documentation, or code comments/identifiers — those remain free to use precise technical terms ("HMAC," "hash," "cryptographic") since their audience is a developer/API integrator, not the compliance officer reading the live `summary` text.

---

### AC-9: RLS Coverage — Explicit Assertion for `audit_log_entries`

**Given** `check-rls-coverage.ts`'s generic mechanism (queries every table with an `org_id` column not in `EXCLUDED_TABLES` and asserts a `pg_policies` row exists for it) already implicitly covers `audit_log_entries` — it has an `org_id` column (D1) and is not excluded,

**When** this story lands,

**Then** the developer MUST read `packages/db/src/__tests__/check-rls-coverage.test.ts` first, and then either (a) add one explicit test naming `audit_log_entries` in its expected-covered-tables list, **or** (b) if such a named assertion already exists, extend/confirm it explicitly in the PR description — "no equivalent assertion found" is not an acceptable outcome; skipping this AC entirely is not permitted (adversarial review finding, low: this is a hard requirement, not an optional either/or). The goal is that a future refactor of `EXCLUDED_TABLES` that accidentally added `audit_log_entries` to the exclusion set is caught by a *named* failure, not just a generic "some table lost coverage" failure. This satisfies epics.md's literal AC text ("the `check-rls-coverage.ts` CI guard must also verify that `audit_events` has an RLS policy") without writing new coverage logic — only a more specific test.

---

### AC-10: Vault-Sealed Handling — Fail Safe, Not Silent False-Positive

**Given** the vault is sealed (`getAuditKey()` throws `Error('getAuditKey: vault is sealed — audit key unavailable')`),

**When** an owner calls `GET /api/v1/org/audit/verify` while sealed,

**Then** the response is `503 { "code": "audit_key_unavailable", "message": "Audit key is unavailable while the vault is sealed" }` — the handler catches the thrown error from `getAuditKey()` explicitly and maps it to this response; it must **never** let the error escape as an unhandled `500`, and must **never** silently report `{ passed: rowsChecked, failed: [] }` by skipping the HMAC check when the key is unavailable (that would be a false "all verified" claim — the single worst possible failure mode for a tamper-evidence feature).

---

### AC-11: Rate Limiting

**Given** an org owner has already called `GET /api/v1/org/audit/verify` 20 times within the last 60 seconds,

**When** they call it an additional (21st) time within that same window,

**Then** the response is `429` (standard `enforceUserRateLimit` behavior, `rateLimit: { max: 20, timeWindowMs: 60_000, key: 'GET /api/v1/org/audit/verify' }` on the `secureRoute` registration — same mechanism as every other rate-limited route, no new rate-limiting primitive). **Corrected precedent (adversarial review finding, medium):** the `20/min` figure is drawn from existing **mutating**-route precedents (`POST /users/:userId/deactivate`, `DELETE /users/:userId/sessions`), not from a read-route precedent — this endpoint gets the same tier deliberately because it is CPU-bound (per-row HMAC recomputation), which is the same resource-protection rationale those mutating routes' rate limits exist for, even though this endpoint is itself a `GET`.

**Edge case:** rate limiting is enforced per-user (`auth.userId`), not per-org — two different owners in the same org each get their own 20/min budget, matching the existing `enforceUserRateLimit` keying convention used everywhere else in the codebase.

---

### AC-12: Concurrency — Verify Running Alongside New Audit Writes

**Given** an owner starts a verify call over range `[T0, T1]` at the same moment another request in the same org writes a new audit row with `createdAt` inside `[T0, T1]`,

**When** both operations execute concurrently,

**Then** the verify call either includes or excludes the new row deterministically based on standard Postgres read-committed snapshot semantics (whichever transaction's snapshot the new row falls before/after) — there is no torn read, no double-count, and no crash. This requires **no new locking or transaction-isolation code**: `verify.ts`'s query runs inside the same `SecureRoute`-provided transaction (`ctx.tx`) as every other read, which already uses the default Postgres `READ COMMITTED` isolation Drizzle configures elsewhere in the codebase.

**And** an integration test fires a verify call and a concurrent audit-triggering mutation (e.g., a project update) using `Promise.all`, and asserts only that the verify call completes successfully with a `rowsChecked` count that is internally consistent (`passed + failed.length === rowsChecked`) — not asserting a specific inclusion/exclusion of the racing row, since that's non-deterministic by design and asserting it would make the test flaky.

---

### AC-13: Backfill/Coverage Check — Clean Database Passes

**Given** an org's `audit_log_entries` rows are all written through the normal path (every `actor_type='human'` row has a non-null `actor_token_id`, per D3),

**When** `checkAuditActorTokenCoverage(sql)` (new function, `packages/db/src/check-audit-actor-token-coverage.ts`, mirroring `checkRlsCoverage`'s shape and error-class pattern) runs against that database,

**Then** it resolves successfully with no error, and the CLI wrapper (`scripts/check-audit-actor-token-coverage.ts`, mirroring `scripts/check-rls-coverage.ts`) prints `check-audit-actor-token-coverage: all human-actor audit rows reference a user_identity_token — OK` and exits `0`.

```typescript
// packages/db/src/check-audit-actor-token-coverage.ts
export class AuditActorTokenCoverageGapError extends Error {
  constructor(public readonly gapCount: number) {
    super(`Audit actor-token coverage gap: ${gapCount} human-actor row(s) with no actor_token_id`)
  }
}

export async function checkAuditActorTokenCoverage(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM audit_log_entries
    WHERE actor_type = 'human' AND actor_token_id IS NULL
  `
  const gapCount = Number(rows[0]?.count ?? 0)
  if (gapCount > 0) throw new AuditActorTokenCoverageGapError(gapCount)
}
```

---

### AC-14: Backfill/Coverage Check — Dirty Database Fails Loudly

**Critical isolation requirement (adversarial review finding, critical):** `checkAuditActorTokenCoverage()` is deliberately **not** org-scoped — it is a database-wide CI gate (correct for its purpose: it must catch a gap anywhere, not just in one test org). But `audit_log_entries` is append-only, and `withTestOrg()`'s cleanup intentionally does **not** delete rows from it (`test-helpers.ts:39-48`) — mirroring production immutability. Combined, these two facts mean a naive test that inserts a dirty row via `withTestOrg()` and never removes it would **permanently poison AC-13's "clean database passes" assertion** for every subsequent test run against that same Postgres instance (any CI environment or local dev setup that doesn't recreate the database from scratch between every single test invocation).

**Given** this test therefore wraps its dirty-row insert **and** its `checkAuditActorTokenCoverage(sql)` call inside a transaction that is explicitly rolled back before the test completes (e.g. `sql.begin(async (tx) => { /* insert dirty row, run the check, assert it throws */ throw new RollbackTestTransaction() }).catch((e) => { if (!(e instanceof RollbackTestTransaction)) throw e })`, or an equivalent named rollback-sentinel/savepoint helper already used elsewhere in this codebase's test suite — read `packages/db/src/test-helpers.ts` for an existing pattern before inventing a new one) — so the dirty row **never persists past this single test**, regardless of whether the surrounding CI/dev database is recreated between runs,

**And** a test inserts one `audit_log_entries` row directly via raw SQL with `actor_type: 'human'` and `actor_token_id: null` (simulating a hypothetical future bug where a code path forgets to resolve the actor's token),

**When** `checkAuditActorTokenCoverage(sql)` runs,

**Then** it throws `AuditActorTokenCoverageGapError` with `gapCount: 1`, and the CLI wrapper prints an actionable message to stderr (mirroring `check-rls-coverage.ts`'s CLI error formatting) and exits non-zero — e.g.:

```
FATAL: audit actor-token coverage gap detected — 1 human-actor audit row has no actor_token_id
and cannot be pseudonymized under Story 8.3's GDPR erasure flow.
Investigate the write path that produced this row before merging.
```

**And** this check is wired into `make ci` (new line `pnpm tsx scripts/check-audit-actor-token-coverage.ts`, placed immediately after the existing `$(MAKE) check-rls` line) and into root `package.json`'s `scripts` block (`"check-audit-actor-token-coverage": "tsx scripts/check-audit-actor-token-coverage.ts"`) in **this same story** — per the product-surface-contract's G3 rule ("Security CI guards introduced in a story must land in `make ci` the same story"), matching exactly how `check-rls-coverage`/`check-alert-pending-epic3` were wired in their introducing stories.

---

### AC-15: Route-Audit CI Coverage for the New Endpoint

**Given** `route-audit.test.ts` enforces that every registered route has a matching entry in `ROUTE_ACTION_CLASSIFICATIONS` (`route-exemptions.ts`),

**When** `GET /api/v1/org/audit/verify` is registered,

**Then** a corresponding entry is added (D6):

```typescript
'GET /api/v1/org/audit/verify': {
  action: 'read',
  auditOmissionReason:
    'Integrity verification read returns pass/fail counts and event metadata only; never a secret or credential value.',
  reviewer: SECURITY_OWNER,
},
```

**And** `route-audit.test.ts` passes without modification to the test file itself — only `route-exemptions.ts` gains the new entry, following the exact pattern every prior story used.

---

### AC-16: Migration Safety — Zero Schema Changes

**Given** this story's entire net-new surface is one route, one query-side check script, and reused write-path primitives (D1),

**When** the story is implemented,

**Then** `packages/db/src/migrations/` gains **no new file**, `packages/db/src/migrations/meta/_journal.json`'s latest entry remains `0028_monitoring_records.sql`, and no existing table's columns, indexes, constraints, or RLS policies are altered. This is itself a testable assertion: the story's PR diff for `packages/db/src/migrations/` must be empty.

---

### AC-17: OpenAPI / Response Schema Contract

**Given** `@fastify/swagger` auto-generates the OpenAPI spec from registered route schemas (`architecture.md:352-358`),

**When** the route is registered with a `schema.response` block,

**Then** `apps/api/src/modules/audit/schema.ts` exports:

```typescript
import { z } from 'zod/v4'

export const AuditVerifyQuerySchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .meta({ id: 'AuditVerifyQuery' })

export const AuditVerifyResponseSchema = z
  .object({
    data: z.object({
      summary: z.string(),
      rowsChecked: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.array(
        z.object({
          id: z.uuid(),
          eventType: z.string(),
          timestamp: z.iso.datetime(),
        })
      ),
      failedCount: z.number().int().nonnegative(),
      failedTruncated: z.boolean(),
      verifiedAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'AuditVerifyResponse' })
```

**And** `GET /api/v1/docs` (Swagger UI) and `GET /api/v1/openapi.json` reflect the new endpoint after `pnpm generate-spec` runs — verified by the existing `apps/api/scripts/generate-spec.ts` pipeline requiring no changes beyond the new route being registered (it uses the mocked-DB `createApp()` factory, `architecture.md:357`, so it never touches a live database).

---

### AC-18: Full Integration Test Matrix

**Given** all ACs above,

**When** the story's test suite runs (`apps/api/src/modules/audit/routes.test.ts` for the endpoint, `packages/db/src/__tests__/check-audit-actor-token-coverage.test.ts` for the CI guard, plus the `check-rls-coverage.test.ts` addition from AC-9),

**Then** integration tests cover, at minimum: verify pass (AC-1), verify fail — tampered row (AC-2), failed-array truncation at 500 entries with correct `failedCount`/`failedTruncated` on a bulk-tamper scenario (AC-2), verify fail — key-version mismatch (AC-3), owner-only authz for admin/member/viewer (AC-4) and unauthenticated (AC-4 edge case), cross-org isolation (AC-5), missing/invalid/inverted/oversized-range validation including the zero-width `from === to` non-error case (AC-6, 6 sub-cases), empty range (AC-7), summary string phrasing for all three cases including singular/plural (AC-8), explicit named RLS coverage assertion (AC-9), vault-sealed 503 (AC-10), rate limiting 429 on the 21st call (AC-11), concurrent verify + write internal-consistency (AC-12), backfill check clean via rolled-back transaction fixture (AC-13), backfill check dirty via rolled-back transaction fixture (AC-14), this route's own call being recorded as an `audit.integrity_verify_run` audit entry (D7), route-audit classification present (AC-15), and confirmation of zero migration diff (AC-16, a repo-inspection assertion rather than a runtime test).

---

## Tasks / Subtasks

- [x] Task 1: Verify endpoint core logic (AC: 1, 2, 3, 7, 8, 10)
  - [x] 1.1 Create `apps/api/src/modules/audit/verify.ts` exporting `verifyAuditRange(tx, { orgId, from, to }): Promise<VerifyResult>` — queries `audit_log_entries` for rows in range (half-open `>= from AND < to`, D4), recomputes HMAC per row via the existing `computeAuditHmac()`, compares each recomputed HMAC to the stored value using `crypto.timingSafeEqual` (constant-time, not `===`), compares `keyVersion` against `currentAuditKeyVersion(tx)`, builds the pass/fail lists (capping `failed` at 500 entries with a true `failedCount` and `failedTruncated` flag — AC-2) and the comprehensible `summary` string using `failedCount` (AC-8's exact phrasing rules)
  - [x] 1.2 Handle `getAuditKey()` throwing (vault sealed) by letting the error propagate to the route handler, which maps it to `503 audit_key_unavailable` (AC-10) — do not swallow it inside `verify.ts`
  - [x] 1.3 Unit test the summary-string builder in isolation (all three phrasing branches, including 1-failure singular vs N-failure plural, using `failedCount` not `failed.length`)
- [x] Task 2: Query validation and range bounding (AC: 6)
  - [x] 2.1 Add `AuditVerifyQuerySchema` (`apps/api/src/modules/audit/schema.ts`) with `z.iso.datetime()` for `from`/`to`
  - [x] 2.2 In the route handler: `safeParse` → `422 validation_error` on parse failure; explicit `to >= from` check → `422 invalid_range` (`from === to` is valid, not rejected — AC-6/AC-7); fetch rows with `LIMIT AUDIT_VERIFY_MAX_ROWS + 1` in the same query used for verification (no separate `COUNT(*)` pre-check — avoids the check-then-act race against AC-12's concurrent writes) and reject with `422 range_too_large` if the day-span exceeds `AUDIT_VERIFY_MAX_RANGE_DAYS = 90` or the result set exceeds `AUDIT_VERIFY_MAX_ROWS = 50_000`
- [x] Task 3: Route registration (AC: 4, 5, 11, 15, 17)
  - [x] 3.1 Create `apps/api/src/modules/audit/routes.ts` exporting `auditRoutes(fastify)`, one `secureRoute` registration: `method: 'GET'`, `url: '/audit/verify'`, `security: { allowedRoles: ['owner'], writeAuditEvent: true, rateLimit: { max: 20, timeWindowMs: 60_000, key: 'GET /api/v1/org/audit/verify' } }` — audit writes use `eventType: 'audit.integrity_verify_run'` with `payload: { from, to, rowsChecked, passed, failedCount }` (D7)
  - [x] 3.2 Register `auditRoutes` in `apps/api/src/app.ts` with `{ prefix: '/api/v1/org' }`, alongside the existing `orgRoutes` registration
  - [x] 3.3 Add `AuditVerifyResponseSchema` to the route's `schema.response[200]`; standard `defaultErrorResponses` (401/403/404/429) plus an explicit `422`/`503` entry
  - [x] 3.4 Add the `route-exemptions.ts` classification entry (AC-15)
- [x] Task 4: RLS coverage explicit assertion (AC: 9)
  - [x] 4.1 Read `packages/db/src/__tests__/check-rls-coverage.test.ts`; add an explicit `audit_log_entries` assertion in the expected-covered-tables list, or if one already exists, confirm and reference it explicitly in the PR description — do not skip this task on the assumption coverage is implicit (AC-9)
- [x] Task 5: Backfill/coverage CI guard (AC: 13, 14)
  - [x] 5.1 Create `packages/db/src/check-audit-actor-token-coverage.ts` (`checkAuditActorTokenCoverage`, `AuditActorTokenCoverageGapError`) — scoped to `actor_type = 'human'` only; `actor_type = 'machine_user'` is an explicit non-goal for this story (D3)
  - [x] 5.2 Create `packages/db/src/__tests__/check-audit-actor-token-coverage.test.ts` (clean case + dirty case). The dirty case MUST insert its `actor_token_id: null` row and invoke the check inside a transaction that is rolled back before the test ends (AC-14) — never via `withTestOrg()`'s normal insert/cleanup path, since `audit_log_entries` cleanup is a documented no-op and would permanently poison the clean-database case
  - [x] 5.3 Create `scripts/check-audit-actor-token-coverage.ts` CLI wrapper, mirroring `scripts/check-rls-coverage.ts`'s error formatting
  - [x] 5.4 Add `"check-audit-actor-token-coverage": "tsx scripts/check-audit-actor-token-coverage.ts"` to root `package.json`
  - [x] 5.5 Add `pnpm tsx scripts/check-audit-actor-token-coverage.ts` to the `Makefile`'s `ci` target, immediately after `$(MAKE) check-rls`
- [x] Task 6: Integration tests for the endpoint (AC: 1, 2, 3, 4, 5, 6, 7, 10, 11, 12)
  - [x] 6.1 `apps/api/src/modules/audit/routes.test.ts` — happy path, tampered row (insert-time-only, per AC-2's edge case guidance), failed-array truncation (bulk-tamper scenario, asserting `failedCount`/`failedTruncated`), key-version mismatch, authz matrix (owner/admin/member/viewer/unauthenticated), cross-org isolation via `withTwoTestOrgs()`, all 6 validation sub-cases (including zero-width `from === to`), empty range, vault-sealed mock, rate-limit 21st-call rejection, concurrent verify+write consistency check, this route's own call recorded as an `audit.integrity_verify_run` entry (D7)
- [x] Task 7: OpenAPI regeneration and full-suite verification (AC: 16, 17, 18)
  - [x] 7.1 Run `pnpm generate-spec`; confirm the new endpoint appears in `packages/shared/openapi.json` with no manual edits needed
  - [x] 7.2 Confirm `git diff --stat packages/db/src/migrations/` is empty before opening the PR (AC-16)
  - [x] 7.3 Run `make ci` locally end-to-end, confirming the two new CI guard lines (check-rls's existing generic pass + the new backfill check) both succeed against a freshly migrated test database

---

## Dev Notes

- **The single biggest risk on this story is scope inflation from epics.md's literal wording.** Re-read D1 before starting: there is no new schema, no new HMAC function, no new migration. The story is genuinely small in schema/infra terms and concentrated entirely in one read endpoint plus one CI guard script.
- `computeAuditHmac()` is the single source of truth for HMAC computation — it is already unit-tested for determinism (`write-entry.test.ts`). `verify.ts` must import and call it, never reimplement canonical-JSON-then-HMAC logic independently, or the two code paths could silently drift.
- Test tampering by **inserting** a row with a wrong `hmac` from the start, never by `UPDATE`-ing an existing row — the append-only trigger + grant REVOKE will reject the `UPDATE` itself (AC-2's edge case note). This is a common trap: a developer unfamiliar with the append-only stack will initially try `tx.update(auditLogEntries)...` in a test and get a confusing permission-denied error unrelated to what they're trying to test.
- `audit_log_entries` rows inserted by tests are **never actually deleted** by `withTestOrg()`'s cleanup (see `test-helpers.ts:39-48` comment) — this is correct, intentional behavior mirroring production immutability, not a test-hygiene bug to "fix." Each test should use a fresh `withTestOrg()`/`withTwoTestOrgs()` org so row counts stay deterministic within that org's scope, rather than relying on any cleanup of prior rows.
- Do not add `audit_log_entries` to `check-rls-coverage.ts`'s `EXCLUDED_TABLES` — it should never be excluded; AC-9 exists specifically to make an accidental future exclusion loudly fail a *named* assertion.
- Keep `apps/api/src/modules/audit/routes.ts` thin: the handler should call `verifyAuditRange()` and translate its result/thrown errors into HTTP responses, with no inline SQL and no HMAC logic in the route file itself — matching how every other route in this codebase delegates to a sibling module file (`human-entry.ts`, `deactivation.ts`, `user-management.ts`, etc.).
- **Use `crypto.timingSafeEqual` for the HMAC comparison in `verify.ts`, never `===`.** Both buffers must be the same fixed length (both are SHA-256 HMAC hex output) before comparing; a length mismatch (which should never happen given `computeAuditHmac()`'s fixed output size, but guard defensively) should be treated as a failed match, not thrown as an unhandled error.
- **Range-check the row count via the same query that fetches rows for verification** (`LIMIT AUDIT_VERIFY_MAX_ROWS + 1`), not a separate `COUNT(*)` beforehand — a two-query check-then-act sequence has a race window against concurrent writes (AC-12) that a single bounded query avoids entirely.
- **AC-14's dirty-row test fixture must be wrapped in a transaction that gets rolled back**, not inserted-and-left, or it will permanently corrupt AC-13's "clean database" assertion for any Postgres instance reused across test runs — see AC-14's isolation requirement for the exact pattern.
- This route now writes its own audit entry (`eventType: 'audit.integrity_verify_run'`, D7) via the standard `SecureRoute` writer — `writeAuditEvent: true`, not `false`. Don't special-case this route as audit-write-exempt.

### Project Structure Notes

- New files: `apps/api/src/modules/audit/routes.ts`, `apps/api/src/modules/audit/verify.ts`, `apps/api/src/modules/audit/schema.ts`, `apps/api/src/modules/audit/routes.test.ts`, `packages/db/src/check-audit-actor-token-coverage.ts`, `packages/db/src/__tests__/check-audit-actor-token-coverage.test.ts`, `scripts/check-audit-actor-token-coverage.ts`.
- Modified files: `apps/api/src/app.ts` (register `auditRoutes`), `apps/api/src/lib/route-exemptions.ts` (new classification entry), `package.json` (new script), `Makefile` (new `ci` target line), `packages/db/src/__tests__/check-rls-coverage.test.ts` (explicit assertion, if not already present).
- No changes to `packages/db/src/schema/`, no new migration file, no changes to `packages/db/src/migrations/meta/_journal.json`.
- Alignment with unified project structure: matches the existing `modules/<feature>/{routes,schema,*.ts}` convention used by every other feature module; matches the existing `scripts/check-*.ts` + root `package.json` script + `Makefile` `ci` target wiring convention (`check-rls-coverage`, `check-alert-pending-epic3`).

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story-8.1` (lines 1858-1900)] — Epic 8 preamble (PJ4/PJ5/PJ6, AC-E8a integrity-mechanism blocker resolution) and Story 8.1's literal AC text.
- [Source: `_bmad-output/planning-artifacts/prd.md` lines 610-633] — "Audit log tamper-evidence — v1 architectural commitment required" (mechanism choice: cryptographic chaining via per-row HMAC), GDPR pseudonymization requirement feeding D3/Story 8.3.
- [Source: `_bmad-output/planning-artifacts/architecture.md` lines 332-346] — Encryption/HKDF architecture, `SecureRoute` abstraction.
- [Source: `packages/db/src/schema/audit-log-entries.ts`, `packages/db/src/schema/vault-state.ts`, `packages/db/src/schema/user-identity-tokens.ts`] — existing schema this story reads and reuses.
- [Source: `apps/api/src/modules/audit/write-entry.ts`, `human-entry.ts`, `key-version.ts`, `actor-token.ts`] — existing write-path primitives this story reuses.
- [Source: `apps/api/src/lib/secure-route.ts`, `audit-or-fail-closed.ts`] — existing same-transaction audit-write enforcement this story does not modify.
- [Source: `packages/db/src/migrations/0000_initial_schema.sql`, `0001_rls_and_triggers.sql`, `0002_audit_log_revoke.sql`, `0005_auth_bootstrap_audit_policy.sql`] — existing RLS/append-only/grant migrations this story adds nothing to.
- [Source: `packages/db/src/check-rls-coverage.ts`] — pattern this story's new coverage-check script mirrors.
- [Source: `_bmad-output/implementation-artifacts/7-1-machine-user-identity-and-api-key-management.md`] — house style and the D9 precedent (`audit_events` vs. `audit_log_entries` naming) this story continues.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-5

### Debug Log References

- Full `apps/api` suite: 371 test files, 1196 tests, 0 failures (clean DB, single run).
- `packages/db` suite: 95 tests, 0 failures.
- `pnpm turbo typecheck`, `pnpm turbo lint`, `pnpm jscpd`, `pnpm generate-spec` all pass.
- `git diff --stat packages/db/src/migrations/` is empty (AC-16).

### Completion Notes List

- All 18 ACs implemented and verified by integration/unit tests in `apps/api/src/modules/audit/routes.test.ts` (14 cases) and `apps/api/src/modules/audit/verify.test.ts` (6 summary-builder unit cases).
- **AC-9 (RLS coverage explicit assertion):** confirmed an existing named assertion already exists — `packages/db/src/__tests__/check-rls-coverage.test.ts`'s `'includes audit_log_entries in the gap list when its policy is missing'` test. Per the story's Task 4.1 instruction ("if one already exists, confirm and reference it explicitly"), no new test was added; this is that explicit confirmation.
- **D7 audit-write mechanism deviation (corrected during implementation):** the story's Task 3.1 literally specifies `writeAuditEvent: true`. Implemented instead as `writeAuditEvent: false` plus an inline `writeHumanAuditEntryOrFailClosed()` call in the route handler. Reason: `SecureRoute`'s default audit writer's `AuditConfig.payload` callback only receives the request's `params`/`query`, never the handler's computed result — there is no mechanism to plumb `rowsChecked`/`passed`/`failedCount` (only known after the handler runs) into a `writeAuditEvent: true`/`{eventType}` registration. Every existing route in the codebase needing a handler-computed audit payload uses this exact `writeAuditEvent: false` + inline `writeHumanAuditEntryOrFailClosed` pattern (e.g. `POST /org/users/:userId/deactivate`); this route now matches that established convention. Behavior is otherwise identical to D7's intent: same transaction, same `eventType: 'audit.integrity_verify_run'`, fail-closed via `SameTransactionAuditWriteError` → `503 audit_write_failed` on audit-write failure.
- **AC-17 / `generate-spec.ts` correction:** `apps/api/src/scripts/generate-spec.ts` (note: actual path is `src/scripts/`, not `apps/api/scripts/` as the story text states) is a small, fully hand-curated static JSON generator covering only the handful of pre-auth bootstrap routes (register/login/refresh/vault init.../mfa recover) — it does not introspect the running app and does not include any `SecureRoute`-registered endpoint added since Epic 2 (confirmed: none of dozens of existing routes like `GET /org/security-alerts` appear in it either). Running `pnpm generate-spec` correctly produces no diff for this route. AC-17 was instead verified directly against the live `@fastify/swagger` document (`app.swagger()`), which correctly includes `GET /api/v1/org/audit/verify` with its full response schema.
- **Route-level querystring schema omitted deliberately:** `AuditVerifyQuerySchema` is exported from `schema.ts` and used for the handler's own manual `safeParse`, but is intentionally NOT wired into the route's `schema.querystring`. Fastify's own schema-based query validator runs before `attachValidation` applies (which `secure-route.ts` only wires for `schema.body`), and a missing/invalid required field there produces a `400 { error: ... }` shape that doesn't match `ApiErrorSchema`'s `{code, message}` — the resulting response-serialization failure surfaced as an opaque `500` instead of AC-6's required `422 { code: "validation_error" }`. Matches the existing `GET /org/security-alerts` precedent (manual `safeParse` only, no `schema.querystring`).
- **Null vs. undefined subtlety (caught by TDD, not just designed around):** the write path omits `resourceId`/`resourceType` from the HMAC input entirely when unset (`undefined`, filtered out of the canonical JSON by `sortKeys`), while a fresh DB read of an unset nullable column yields `null`. `verify.ts` converts `row.resourceId ?? undefined` / `row.resourceType ?? undefined` before recomputing — without this, AC-1's happy-path test (real rows from registration/login, which never set a resource) would have failed with false "tampered" results on nearly every ordinary row. This was caught by using real write-path fixtures in the AC-1 test rather than fully-synthetic rows.
- **`pnpm jscpd` clone-detection fix:** the new `scripts/check-audit-actor-token-coverage.ts` CLI wrapper initially duplicated ~12 lines/52 tokens of boilerplate (env-var check, `postgres()` connect, try/finally) against the pre-existing `scripts/check-rls-coverage.ts` — expected, since the story explicitly asks the wrapper to mirror that script's shape. Resolved by extracting the shared boilerplate into a new `scripts/lib/run-db-check.ts` helper and refactoring both CLI scripts to use it (behavior-preserving; both re-verified end-to-end against a live Postgres instance, clean and dirty cases).
- Vault-sealed test (AC-10) exercises the route's own `getAuditKey()`-catch fail-closed logic directly (`vaultGuardEnabled: false`), since the global `vaultGuardPlugin` would otherwise intercept every request with a generic `503 {status:'sealed'}` before this route's handler ever runs — that global-guard behavior is already covered elsewhere (e.g. `projects/routes.test.ts`).

### File List

**New files:**
- `apps/api/src/modules/audit/verify.ts`
- `apps/api/src/modules/audit/verify.test.ts`
- `apps/api/src/modules/audit/schema.ts`
- `apps/api/src/modules/audit/routes.ts`
- `apps/api/src/modules/audit/routes.test.ts`
- `packages/db/src/check-audit-actor-token-coverage.ts`
- `packages/db/src/__tests__/check-audit-actor-token-coverage.test.ts`
- `scripts/check-audit-actor-token-coverage.ts`
- `scripts/lib/run-db-check.ts`

**Modified files:**
- `apps/api/src/app.ts` (register `auditRoutes` at `/api/v1/org`)
- `apps/api/src/lib/route-exemptions.ts` (new `GET /api/v1/org/audit/verify` classification, D6/AC-15)
- `packages/shared/src/constants/mfa-exempt-routes.ts` (new entry, D5)
- `packages/shared/src/constants/mfa-exempt-routes.test.ts` (updated expected list)
- `scripts/check-rls-coverage.ts` (refactored to use the new shared `runDbCheck` helper; behavior unchanged)
- `package.json` (new `check-audit-actor-token-coverage` script)
- `Makefile` (new `check-audit-actor-token-coverage` target; wired into `ci` immediately after `check-rls`)

**Not modified (confirmed):**
- `packages/db/src/migrations/` — zero diff (AC-16)
- `packages/db/src/schema/` — no changes
- `packages/db/src/__tests__/check-rls-coverage.test.ts` — pre-existing explicit `audit_log_entries` assertion already satisfies AC-9

### Change Log

- 2026-07-06: Implemented Story 8.1 — `GET /api/v1/org/audit/verify` HMAC integrity verification endpoint, backfill/coverage CI guard (`checkAuditActorTokenCoverage`), and full integration/unit test coverage for all 18 ACs. All tasks/subtasks complete.
