# Audit, SecureRoute & Platform Conventions — Project Vault (v1 implemented reality)

**Version:** 1.0
**Date:** 2026-06-27
**Status:** Implemented (Epic 1 done); authoritative for Epic 2 story planning
**Scope:** What the *running codebase* actually does — for audit, route security, migrations, and the vault guard. Where the research/architecture docs disagree, **this spec describes the merged code** and the planning docs defer to it.

> Created during the Epic 2 story-spec readiness pass (Stories 2.0–2.2). It records facts that were being mis-stated in story drafts (e.g. "HMAC-chained" audit, hardcoded migration numbers, "Story 1.12 not done"). Verified against the source files cited below.

---

## 1. Audit log: per-row keyed HMAC (NOT a hash chain)

**Reality:** Each `audit_log_entries` row carries its own keyed HMAC over that row's canonical fields. There is **no prev-row hash chaining** in v1.

- Implementation: `apps/api/src/modules/audit/write-entry.ts` → `computeAuditHmac(fields, auditKey)`:
  - Canonical JSON = recursively **sorted keys, no whitespace** (`sortKeys` + `JSON.stringify`).
  - `HMAC-SHA256(canonicalJSON, auditKey)`, hex digest.
  - Input is only the row's own fields (`orgId`, `actorTokenId`, `actorType`, `eventType`, `resourceId`, `resourceType`, `payload`, `keyVersion`) — **no `prev_hash` input**.
- Key versioning: `keyVersion` comes from `currentAuditKeyVersion(tx)`; the audit key comes from `getAuditKey()` (vault must be unsealed).
- Human-actor writes: `apps/api/src/modules/audit/human-entry.ts` (`writeHumanAuditEntry`). Background/system writes set `actorType: 'system'`, `actorTokenId: null` (see `apps/api/src/workers/check-failed-auth-threshold.ts`).
- Immutability: enforced by the append-only trigger from `packages/db/src/migrations/0001_rls_and_triggers.sql` (no UPDATE/DELETE), **not** by a chain.

> ⚠️ **Discrepancy with `specs/cryptographic-architecture.md` "Audit Log" section**, which describes `entry_hash = SHA-256(fields || prev_hash)` (a hash chain). That is the *research design*, not v1. Do not write story ACs against the chain model. If true cryptographic chaining (prev-row linkage) is ever wanted, it must be added **intentionally** (Epic 8 territory), not assumed.

**Implication for FKs / mutation of audited columns:** because the HMAC is computed once at write time over the row's own values and never recomputed, nullifying a column later (e.g. `audit_log_entries.project_id` via `ON DELETE SET NULL`) does **not** invalidate the stored HMAC. (Basis for Story 2.1 ADR-2.1-04.)

---

## 2. SecureRoute audit model: fail-closed, same-transaction

Routes are registered via `secureRoute()` (`apps/api/src/lib/secure-route.ts`). Audit behavior:

- The audit row is written **in the same transaction as the handler**, *after* the handler returns.
- If the audit write fails, **the whole transaction rolls back** and the client receives `503` (e.g. `audit_write_failed`). A mutation/reveal is **never committed without its audit row** (100% capture). Basis for Story 2.2 ADR-2.2-09 (fail-closed reveal) and the Story 2.1 audit-failure-rollback requirement for `project.created`/`project.updated`.
- Audited handlers must **not** call `reply.send()` directly (a send-guard throws) — return data; SecureRoute sends it.
- Capturing a new resource id on a POST (no id in URL params): stash it on the request after insert (`(req as ...).auditResource = { id }`) and read it in a custom `auditWriter`. Pattern established in Story 2.1 AC-4; reused by Story 2.2 for `credential.created`.
- `FORBIDDEN_AUDIT_KEYS` sanitizer strips sensitive keys (e.g. `value`) from audit payloads — but never place secrets there in the first place.

### Route audit CI gate

- Every route must be classified in `ROUTE_ACTION_CLASSIFICATIONS` (`apps/api/src/lib/route-exemptions.ts`) and its file listed in `ROUTE_FILES` (`apps/api/src/__tests__/route-audit.test.ts`).
- `auditEvent` in classifications is typed loosely as `string`, so the gate passes regardless of the typed union (see §3).
- A typo in the `ROUTE_FILES` path **silently skips** the file (routes look unguarded with no CI failure) — run `route-audit` in isolation after editing and confirm the routes appear.
- A value-reveal GET is classified `sensitive-read` **with** an `auditEvent` (an audited read) — confirm the gate accepts an `auditEvent` on a GET.
- Background workers reading via `getDb()` must be added to `DIRECT_DB_ACCESS_CLASSIFICATIONS`.

---

## 3. Audit event vocabulary

Typed union: `AuditEventType` in `packages/shared/src/constants/audit-events.ts`.

- Auth events are `const AuditEvent = { USER_REGISTERED, SESSION_CREATED, ... }` (SCREAMING_CASE values, plus `security.failed_auth_threshold`).
- The union **also** carries **stale, never-emitted** members from the superseded architecture naming: `secret.created` / `secret.read` / `secret.updated` / `secret.deleted`. **Do not build on these.** Epic 2 uses the `credential.*` noun.
- Epic 2 additions (to be made by the dev agent during the relevant story, TDD applies):
  - **Story 2.1:** add `project.created`, `project.updated`.
  - **Story 2.2:** add `credential.created`, `credential.version_created`, `credential.value_revealed`, `credential.version_purged`; **remove** the stale `secret.*` members.
- Keep event strings **byte-identical** across: `ROUTE_ACTION_CLASSIFICATIONS`, `writeAuditEvent`, the worker, the `AuditEventType` union, and Story 2.1's dashboard `RecentAccessEventSchema` (which already references `credential.value_revealed` / `credential.created`).

---

## 4. Migrations: forward-only, journal-driven numbering

- Location: `packages/db/src/migrations/NNNN_*.sql`, tracked in `packages/db/src/migrations/meta/_journal.json`.
- **Forward-only**: there are no `down`/rollback files. To revert, author a **new forward migration** or restore from backup — never hand-roll a down migration that diverges from the journal.
- **Never hardcode the next migration number.** Re-read `meta/_journal.json` immediately before `drizzle-kit generate` and use the next free number after the current tip.
- **Current journal tip (2026-06-27):** `0012_refresh_tokens_org_id` (idx 12). Therefore:
  - Story 2.1 (`projects`) → **`0013_projects.sql`**
  - Story 2.2 (`credentials`) → **`0014_credentials.sql`**
  - These shift if anything else merges first — re-verify.
- RLS lives in the migration SQL, not application code. New `org_id` tables MUST `ENABLE ROW LEVEL SECURITY` + add a `USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)` policy in the **same migration file**. Command-less (`ALL`) policies default `WITH CHECK` to the same expression, so cross-org **writes** are blocked too. `check-rls-coverage.ts` fails CI if any `org_id` table lacks an `ALL` policy; do not add real org-scoped tables to `EXCLUDED_TABLES`.
- FK order within a generated migration matters (parent table `CREATE` before child). Confirm visually; a cross-migration FK (e.g. credentials → projects) requires the referenced migration to be ordered earlier in the journal — add an ordering gate before deploy.

---

## 5. Vault guard: global, fail-closed (503 while not unsealed)

- `apps/api/src/plugins/vault-guard.ts` is a global `onRequest` hook (registered via `fastify-plugin`, breaks encapsulation so it applies to every route incl. the 404 handler).
- When `getVaultStatus() !== 'unsealed'`, it returns `503 { status: "sealed", message: "Vault not initialized" }` for **every route not on the allowlist**.
- **Allowlist** (exact `METHOD path`): `GET /health`, `GET /ready`, `POST /api/v1/vault/init`, `POST /api/v1/vault/unseal`, `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`.
- Consequence: project routes, credential routes, etc. all return `503` while sealed/uninitialized — sealed-vault `503` tests are valid for them. Credential value operations also fail in `getPrimaryKey()`/`withSecret()` if reached while sealed, but the guard short-circuits first.

### `/ready` readiness ambiguity (current, unresolved)

`apps/api/src/routes/health.ts` returns, on `503`, `reason: "sealed"` for **both** uninitialized and sealed states, distinguished only by `message`:

- Uninitialized → `{ status: "unavailable", reason: "sealed", message: "Vault not initialized. POST /api/v1/vault/init to initialize." }`
- Sealed → `{ status: "unavailable", reason: "sealed", message: "Manual unseal required via POST /api/v1/vault/unseal" }`
- DB failure → `{ status: "unavailable", reason: "db", retryAfter: 5 }`
- Ready → `200 { status: "ready" }`

Frontends (Story 2.0) must classify uninitialized vs sealed **by message** and must not collapse them. Preferred future fix (ADR-2.0-02): add a machine-readable `reason: "uninitialized"` and update the API tests.

---

## 6. Auth / MFA login (Story 1.12 — done)

- Story 1.12 is `done`. MFA login is real, not conditional.
- `POST /api/v1/auth/login`:
  - Non-MFA user → `200 { data: { userId, orgId, expiresAt } }` + HttpOnly `access-token`/`refresh-token` cookies.
  - MFA-enrolled user (`users.mfa_enrolled_at IS NOT NULL`) → `200 { data: { mfaRequired: true, mfaToken } }`, **no** cookies yet.
- `POST /api/v1/auth/mfa/verify-login` (`apps/api/src/modules/auth/mfa-login.ts`): body `{ mfaToken, totp }` →
  - success → `200 { data: { userId, orgId, expiresAt } }` + cookies (pending row deleted, single-use).
  - invalid TOTP → `422 { code: "invalid_totp" }` (row kept for retry until TTL/attempt cap).
  - dead/expired/consumed/attempt-capped token → `401 { code: "mfa_token_expired" }`.
- Sessions are **HttpOnly cookies only** (`SameSite=Strict`). The frontend never reads/stores access/refresh/MFA tokens. `mfaToken` lives only in transient login-step component state.
- `pending_mfa_sessions` stores an HMAC of the opaque token (keyed by `MFA_PENDING_SESSION_HMAC_SECRET`), never the raw token; hourly pg-boss cleanup `mfa:prune-pending-mfa-sessions`.

---

## 7. Key source files (quick index)

| Concern | File |
|---|---|
| Audit HMAC | `apps/api/src/modules/audit/write-entry.ts` |
| Human audit write | `apps/api/src/modules/audit/human-entry.ts` |
| Audit key version | `apps/api/src/modules/audit/key-version.ts` |
| SecureRoute + audit writer | `apps/api/src/lib/secure-route.ts` |
| Route classification gate | `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts` |
| Audit event union | `packages/shared/src/constants/audit-events.ts` |
| Vault guard | `apps/api/src/plugins/vault-guard.ts` |
| Readiness/health | `apps/api/src/routes/health.ts` |
| MFA login | `apps/api/src/modules/auth/mfa-login.ts` |
| Migrations + journal | `packages/db/src/migrations/`, `packages/db/src/migrations/meta/_journal.json` |
| RLS coverage check | `packages/db/src/check-rls-coverage.ts` |
| Audit FK defer note | `packages/db/src/schema/audit-log-entries.ts` |

---

## 8. Gotchas discovered

- "HMAC-chained audit" is a **research-doc artifact**, not implemented. Audit is per-row keyed HMAC.
- Migration numbers in older story drafts were wrong (assumed tip was `0010`/`0011`); always read the journal.
- The `AuditEventType` union still ships dead `secret.*` members — they will be removed in Story 2.2.
- `route-audit` `ROUTE_FILES` typos fail **silently** (file skipped, no error) — verify in isolation.
- Retention purge (Story 2.2) zero-overwrite is **defense-in-depth, not byte-erasure** under PostgreSQL MVCC/WAL; true shredding is key-destruction at master-key rotation (Epic 5+).
