# Story 8.1: Tamper-Evident Audit Log with HMAC Integrity

Status: ready-for-dev

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
- Audit-signing-key **rotation** (deriving a new `auditKeyVersion` and re-signing/retaining old keys) — deferred to a future story per the comment already in `packages/db/src/schema/vault-state.ts:9-11` ("Old key versions must be retained in a key_history store (Story 9.x)"). This story's verify endpoint must *detect* a key-version mismatch (AC-3) but does not implement rotation itself.

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story ships one owner-only verification endpoint consumed via REST API / curl, not a web screen |
| **Linked UI story** (if API-only) | `TBD` — **blocking note:** no story anywhere in the current epics.md (Epic 8's four stories, or any other epic) scopes a dedicated web UI for the audit log. The PRD's Dana persona journey (`prd.md:241`, "she opens Project Vault's audit log interface") and epics.md's AC-E8c ("displayed in the UI as a paginated table") both imply a UI surface exists somewhere, but no story number is assigned to build it. This is the same category of planning gap Story 7.1 flagged for machine-user management UI — not a decision this story can resolve. Until a UI story exists, org owners consume `GET /api/v1/org/audit/verify` exclusively via the REST API / OpenAPI docs (`/api/v1/docs`). Flagged as an open question below and should be raised at Epic 8 sprint planning before Story 8.2/8.3 (which explicitly mention UI tables) are scoped. |
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

### D4 — Verify endpoint range bounding: epics.md doesn't specify a limit; this story adds one

- epics.md's AC (`epics.md:1890`) specifies `GET /api/v1/org/audit/verify?from=<ISO>&to=<ISO>` with no stated bound on range size or row count. Recomputing an HMAC per row is CPU-bound; an org with millions of historical rows calling this with an unbounded range would be a self-inflicted DoS vector and directly touches NFR-PERF-style concerns already established elsewhere in the codebase (e.g., `AUDIT_LOG_STORAGE_LIMIT_GB` guard planned for Story 9.2).
- **Decision implemented in this story:** the endpoint enforces `to - from <= 90 days` (`AUDIT_VERIFY_MAX_RANGE_DAYS`, a named constant in `verify.ts`, not a magic number) and a hard cap of `AUDIT_VERIFY_MAX_ROWS = 50_000` rows actually recomputed per call; exceeding either returns `422 { code: "range_too_large" }` (see AC-6). A compliance officer verifying a full year needs to make ~4-5 calls across sub-ranges — an acceptable trade-off documented in the response error message itself, not just internal comments.

### D5 — Authorization: owner-only, no additional `requireMfa` flag on this GET

- epics.md is explicit: "the integrity verification endpoint is accessible to `owner` role only" (`epics.md:1892`). This is the **first** `allowedRoles: ['owner']`-only endpoint in the codebase (grep confirms no precedent) — every existing admin-tier endpoint uses `minimumRole: 'admin'` (which also admits `owner`) or `allowedRoles: ['admin', 'owner']`.
- Per the architecture's blanket MFA-enforcement rule (`architecture.md:319`), any authenticated `owner` without MFA enrolled and past their grace period is already rejected upstream with `403 MFA_ENROLLMENT_REQUIRED` before reaching route-level checks; per `mfa-policy-matrix.md:62`, safety/security-visibility GET endpoints like `GET /org/security-alerts` are **not** additionally gated with `requireMfa: true` at the route level, precisely so admins mid-grace-period can still see security-relevant state. `GET /api/v1/org/audit/verify` is the same category of "let a not-yet-MFA-enrolled-but-in-grace owner see security state" endpoint — **decision: no `requireMfa: true`** on this route, matching the `GET /org/security-alerts` precedent (`modules/org/routes.ts:78-93`) exactly, not the mutating-endpoint pattern.

### D6 — Route-audit classification: `action: 'read'`, not `'sensitive-read'`

- `apps/api/src/lib/route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` requires every route to declare a classification (enforced by `route-audit.test.ts`). The closest precedent is `GET /api/v1/org/security-alerts` (`route-exemptions.ts:199-204`): `action: 'read'`, `auditOmissionReason`, `reviewer: SECURITY_OWNER`. `GET /api/v1/org/audit/verify` returns pass/fail counts and HMAC-mismatch metadata — never a secret value, never a credential — so it is classified the same way, not as `'sensitive-read'` (reserved for endpoints that reveal actual credential plaintext, e.g. `GET .../credentials/:id/value`).
- **Decision implemented in this story:** add `'GET /api/v1/org/audit/verify': { action: 'read', auditOmissionReason: 'Integrity verification read returns pass/fail counts and event metadata only; never a secret or credential value.', reviewer: SECURITY_OWNER }` to `route-exemptions.ts`.

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
| Response shape | `{ summary, rowsChecked, passed, failed: [{ id, eventType, timestamp }], verifiedAt }` — comprehensible without cryptography background (UX-DR13). |
| Tamper detection | A row whose stored `hmac` doesn't match the recomputed HMAC over its own stored fields is reported as failed. |
| Key-version mismatch | A row whose `keyVersion` differs from the org's current `vault_state.auditKeyVersion` is reported as failed (rotation-without-re-signing scenario; not naturally reachable yet since rotation isn't implemented — tests simulate it directly). |
| Tenant isolation | Verification only ever considers the caller's own org's rows; RLS makes cross-org rows structurally invisible regardless of query construction. |
| Vault sealed | If the vault is sealed (`getAuditKey()` throws), the endpoint returns `503 { code: "audit_key_unavailable" }`, not a crash or a false-negative "all passed." |
| Rate limiting | `20/min` per owner (CPU-bound recompute; matches the sensitive-mutation rate-limit tier used elsewhere). |
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
    "verifiedAt": "2026-07-04T18:32:10.104Z"
  }
}
```

**And** each row's HMAC is recomputed via the *existing* `computeAuditHmac()` (`apps/api/src/modules/audit/write-entry.ts`) over exactly the same field set used at write time: `{ orgId, actorTokenId, actorType, eventType, resourceId, resourceType, payload, keyVersion }` — reusing the write-path function guarantees recompute and original-compute can never silently drift apart into two different canonicalization implementations.

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
    "verifiedAt": "2026-07-04T18:32:10.104Z"
  }
}
```

**Edge case — integration test guidance:** because `UPDATE`/`DELETE` on `audit_log_entries` are blocked at both the trigger and grant layer (D1), any test that needs a "tampered" row must construct it at **insert time** with a deliberately wrong `hmac` string (e.g., `hmac: 'deadbeef'.repeat(8)`), not attempt to insert-then-corrupt. Attempting an `UPDATE` in a test to simulate tampering will itself throw a permission-denied error before the test even reaches the assertion under test — this is expected and is not a bug in the test.

---

### AC-3: Verify Endpoint — Key-Version Mismatch Detected as Failure

**Given** the org's `vault_state.auditKeyVersion` is `1` (the only value possible today, since key rotation is not yet implemented — see "Out of scope"), and a row is inserted directly with `keyVersion: 2` and a correctly-computed HMAC *for that row's own fields including `keyVersion: 2`*,

**When** the owner calls `GET /api/v1/org/audit/verify` over a range covering that row,

**Then** the row is reported in `failed` — **not** because the HMAC recomputation fails (it would actually match, since the test constructs a self-consistent row), but because the row's `keyVersion` does not equal `currentAuditKeyVersion(tx)` (`epics.md:1890`: "the current audit signing key version must match the row's `keyVersion` for verification to pass"). The verify logic must check both conditions independently — `hmacMatches AND row.keyVersion === currentKeyVersion` — a row can fail on either condition alone.

**And** the response's `failed` entry for this row has the same shape as AC-2's tampered-row entry — the caller-facing response does not need to distinguish "wrong HMAC" from "key version mismatch" (both are "integrity could not be confirmed" from an auditor's point of view); the distinction matters only for internal test assertions and pino debug logs, not the API contract.

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
| `from`/`to` spanning 91 days (`AUDIT_VERIFY_MAX_RANGE_DAYS = 90`) | `422 { code: "range_too_large", message: "Range exceeds 90 days; narrow the from/to window and call again" }` (D4) |
| A valid ≤90-day range that would match more than `AUDIT_VERIFY_MAX_ROWS = 50,000` rows | Same `422 { code: "range_too_large" }` — checked via a cheap `COUNT(*)` before recomputing any HMACs, so the endpoint never starts expensive work it will reject anyway |

**Then** each case is verified by an independent test; no case reaches the HMAC-recompute code path.

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
    "verifiedAt": "2026-07-04T18:32:10.104Z"
  }
}
```

**And** this is explicitly distinct from a validation error — a real, valid range with zero matching rows is a legitimate, common case (e.g., a brand-new org, or a Sunday with no activity), not something to reject.

---

### AC-8: Verify Endpoint — Non-Cryptographer-Comprehensible Response (UX-DR13)

**Given** the UX design spec's explicit requirement (`ux-design-specification.md:203`: "one that a non-cryptographer can understand, that produces output an auditor..."; `epics.md:1892`: `{ summary: "All 1,247 records verified — no tampering detected", passed: 1247, failed: 0 }`),

**When** any verify response is constructed (all-pass, some-fail, or empty-range cases above),

**Then** the `summary` field is always a complete, grammatically correct English sentence stating the pass count and total count with no jargon (no "HMAC," "hash," "cryptographic" in the summary string itself — those terms are fine in API documentation, not in the runtime response body a compliance officer might paste directly into an audit report). Exact phrasing rules, enforced by unit test on the summary-builder function in `verify.ts`:
- All pass: `` `All ${rowsChecked} records verified — no tampering detected` ``
- Some fail: `` `${passed} of ${rowsChecked} records verified — ${failedCount} record${failedCount === 1 ? '' : 's'} failed integrity check` `` (singular/plural handled)
- Zero rows: `"No records found in this range"`

---

### AC-9: RLS Coverage — Explicit Assertion for `audit_log_entries`

**Given** `check-rls-coverage.ts`'s generic mechanism (queries every table with an `org_id` column not in `EXCLUDED_TABLES` and asserts a `pg_policies` row exists for it) already implicitly covers `audit_log_entries` — it has an `org_id` column (D1) and is not excluded,

**When** this story lands,

**Then** add one explicit test to `packages/db/src/__tests__/check-rls-coverage.test.ts` (or confirm an equivalent assertion already exists — read the file first) that specifically names `audit_log_entries` in its expected-covered-tables list, so a future refactor of `EXCLUDED_TABLES` that accidentally added `audit_log_entries` to the exclusion set would be caught by a *named* failure, not just a generic "some table lost coverage" failure. This satisfies epics.md's literal AC text ("the `check-rls-coverage.ts` CI guard must also verify that `audit_events` has an RLS policy") without writing new coverage logic — only a more specific test.

---

### AC-10: Vault-Sealed Handling — Fail Safe, Not Silent False-Positive

**Given** the vault is sealed (`getAuditKey()` throws `Error('getAuditKey: vault is sealed — audit key unavailable')`),

**When** an owner calls `GET /api/v1/org/audit/verify` while sealed,

**Then** the response is `503 { "code": "audit_key_unavailable", "message": "Audit key is unavailable while the vault is sealed" }` — the handler catches the thrown error from `getAuditKey()` explicitly and maps it to this response; it must **never** let the error escape as an unhandled `500`, and must **never** silently report `{ passed: rowsChecked, failed: [] }` by skipping the HMAC check when the key is unavailable (that would be a false "all verified" claim — the single worst possible failure mode for a tamper-evidence feature).

---

### AC-11: Rate Limiting

**Given** an org owner has already called `GET /api/v1/org/audit/verify` 20 times within the last 60 seconds,

**When** they call it an additional (21st) time within that same window,

**Then** the response is `429` (standard `enforceUserRateLimit` behavior, `rateLimit: { max: 20, timeWindowMs: 60_000, key: 'GET /api/v1/org/audit/verify' }` on the `secureRoute` registration — same mechanism as every other rate-limited route, no new rate-limiting primitive).

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

**Given** a test inserts one `audit_log_entries` row directly via raw SQL with `actor_type: 'human'` and `actor_token_id: null` (simulating a hypothetical future bug where a code path forgets to resolve the actor's token),

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

**Then** integration tests cover, at minimum: verify pass (AC-1), verify fail — tampered row (AC-2), verify fail — key-version mismatch (AC-3), owner-only authz for admin/member/viewer (AC-4) and unauthenticated (AC-4 edge case), cross-org isolation (AC-5), missing/invalid/inverted/oversized-range validation (AC-6, 5 sub-cases), empty range (AC-7), summary string phrasing for all three cases including singular/plural (AC-8), explicit named RLS coverage assertion (AC-9), vault-sealed 503 (AC-10), rate limiting 429 on the 21st call (AC-11), concurrent verify + write internal-consistency (AC-12), backfill check clean (AC-13), backfill check dirty (AC-14), route-audit classification present (AC-15), and confirmation of zero migration diff (AC-16, a repo-inspection assertion rather than a runtime test).

---

## Tasks / Subtasks

- [ ] Task 1: Verify endpoint core logic (AC: 1, 2, 3, 7, 8, 10)
  - [ ] 1.1 Create `apps/api/src/modules/audit/verify.ts` exporting `verifyAuditRange(tx, { orgId, from, to }): Promise<VerifyResult>` — queries `audit_log_entries` for rows in range, recomputes HMAC per row via the existing `computeAuditHmac()`, compares `keyVersion` against `currentAuditKeyVersion(tx)`, builds the pass/fail lists and the comprehensible `summary` string (AC-8's exact phrasing rules)
  - [ ] 1.2 Handle `getAuditKey()` throwing (vault sealed) by letting the error propagate to the route handler, which maps it to `503 audit_key_unavailable` (AC-10) — do not swallow it inside `verify.ts`
  - [ ] 1.3 Unit test the summary-string builder in isolation (all three phrasing branches, including 1-failure singular vs N-failure plural)
- [ ] Task 2: Query validation and range bounding (AC: 6)
  - [ ] 2.1 Add `AuditVerifyQuerySchema` (`apps/api/src/modules/audit/schema.ts`) with `z.iso.datetime()` for `from`/`to`
  - [ ] 2.2 In the route handler: `safeParse` → `422 validation_error` on parse failure; explicit `to >= from` check → `422 invalid_range`; explicit day-span and pre-check `COUNT(*)` → `422 range_too_large` for either bound, using named constants `AUDIT_VERIFY_MAX_RANGE_DAYS = 90` and `AUDIT_VERIFY_MAX_ROWS = 50_000`
- [ ] Task 3: Route registration (AC: 4, 5, 11, 15, 17)
  - [ ] 3.1 Create `apps/api/src/modules/audit/routes.ts` exporting `auditRoutes(fastify)`, one `secureRoute` registration: `method: 'GET'`, `url: '/audit/verify'`, `security: { allowedRoles: ['owner'], writeAuditEvent: false, rateLimit: { max: 20, timeWindowMs: 60_000, key: 'GET /api/v1/org/audit/verify' } }`
  - [ ] 3.2 Register `auditRoutes` in `apps/api/src/app.ts` with `{ prefix: '/api/v1/org' }`, alongside the existing `orgRoutes` registration
  - [ ] 3.3 Add `AuditVerifyResponseSchema` to the route's `schema.response[200]`; standard `defaultErrorResponses` (401/403/404/429) plus an explicit `422`/`503` entry
  - [ ] 3.4 Add the `route-exemptions.ts` classification entry (AC-15)
- [ ] Task 4: RLS coverage explicit assertion (AC: 9)
  - [ ] 4.1 Read `packages/db/src/__tests__/check-rls-coverage.test.ts`; add or confirm an explicit `audit_log_entries` assertion in the expected-covered-tables list
- [ ] Task 5: Backfill/coverage CI guard (AC: 13, 14)
  - [ ] 5.1 Create `packages/db/src/check-audit-actor-token-coverage.ts` (`checkAuditActorTokenCoverage`, `AuditActorTokenCoverageGapError`)
  - [ ] 5.2 Create `packages/db/src/__tests__/check-audit-actor-token-coverage.test.ts` (clean case + dirty case with a directly-inserted `actor_token_id: null` row)
  - [ ] 5.3 Create `scripts/check-audit-actor-token-coverage.ts` CLI wrapper, mirroring `scripts/check-rls-coverage.ts`'s error formatting
  - [ ] 5.4 Add `"check-audit-actor-token-coverage": "tsx scripts/check-audit-actor-token-coverage.ts"` to root `package.json`
  - [ ] 5.5 Add `pnpm tsx scripts/check-audit-actor-token-coverage.ts` to the `Makefile`'s `ci` target, immediately after `$(MAKE) check-rls`
- [ ] Task 6: Integration tests for the endpoint (AC: 1, 2, 3, 4, 5, 6, 7, 10, 11, 12)
  - [ ] 6.1 `apps/api/src/modules/audit/routes.test.ts` — happy path, tampered row (insert-time-only, per AC-2's edge case guidance), key-version mismatch, authz matrix (owner/admin/member/viewer/unauthenticated), cross-org isolation via `withTwoTestOrgs()`, all 5 validation sub-cases, empty range, vault-sealed mock, rate-limit 21st-call rejection, concurrent verify+write consistency check
- [ ] Task 7: OpenAPI regeneration and full-suite verification (AC: 16, 17, 18)
  - [ ] 7.1 Run `pnpm generate-spec`; confirm the new endpoint appears in `packages/shared/openapi.json` with no manual edits needed
  - [ ] 7.2 Confirm `git diff --stat packages/db/src/migrations/` is empty before opening the PR (AC-16)
  - [ ] 7.3 Run `make ci` locally end-to-end, confirming the two new CI guard lines (check-rls's existing generic pass + the new backfill check) both succeed against a freshly migrated test database

---

## Dev Notes

- **The single biggest risk on this story is scope inflation from epics.md's literal wording.** Re-read D1 before starting: there is no new schema, no new HMAC function, no new migration. The story is genuinely small in schema/infra terms and concentrated entirely in one read endpoint plus one CI guard script.
- `computeAuditHmac()` is the single source of truth for HMAC computation — it is already unit-tested for determinism (`write-entry.test.ts`). `verify.ts` must import and call it, never reimplement canonical-JSON-then-HMAC logic independently, or the two code paths could silently drift.
- Test tampering by **inserting** a row with a wrong `hmac` from the start, never by `UPDATE`-ing an existing row — the append-only trigger + grant REVOKE will reject the `UPDATE` itself (AC-2's edge case note). This is a common trap: a developer unfamiliar with the append-only stack will initially try `tx.update(auditLogEntries)...` in a test and get a confusing permission-denied error unrelated to what they're trying to test.
- `audit_log_entries` rows inserted by tests are **never actually deleted** by `withTestOrg()`'s cleanup (see `test-helpers.ts:39-48` comment) — this is correct, intentional behavior mirroring production immutability, not a test-hygiene bug to "fix." Each test should use a fresh `withTestOrg()`/`withTwoTestOrgs()` org so row counts stay deterministic within that org's scope, rather than relying on any cleanup of prior rows.
- Do not add `audit_log_entries` to `check-rls-coverage.ts`'s `EXCLUDED_TABLES` — it should never be excluded; AC-9 exists specifically to make an accidental future exclusion loudly fail a *named* assertion.
- Keep `apps/api/src/modules/audit/routes.ts` thin: the handler should call `verifyAuditRange()` and translate its result/thrown errors into HTTP responses, with no inline SQL and no HMAC logic in the route file itself — matching how every other route in this codebase delegates to a sibling module file (`human-entry.ts`, `deactivation.ts`, `user-management.ts`, etc.).

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

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
