# Story 9.4: Platform Operator Audit Log

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a platform operator performing cross-org incident investigation,
I want my operator actions recorded in a separate immutable platform audit log that org admins cannot access or modify,
so that there is an independent, verifiable record of all privileged operator actions separate from the per-org audit log.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story ships REST endpoints only (`GET /api/v1/platform/audit/events`, `GET /api/v1/platform/audit/verify`, `POST /api/v1/platform/maintenance-mode`). There is no web screen in this story. The epics.md PJ9 requirement ("UI clearly labels this as distinct from the per-org log") is satisfied at the API-contract level in this story (the `X-Log-Scope: platform` response header, AC-13) — the actual web-UI rendering of that label is deferred, matching Stories 9.1/9.2's precedent exactly (see Linked UI story below). |
| **Linked UI story** (if API-only) | `TBD` — no story in `epics.md` (Epic 9's five stories, or any other epic) scopes a platform-operator admin web screen of any kind. This is the same accepted-gap pattern Stories 9.1 and 9.2 already flagged (Product Surface Contract G1); raise it again at Epic 9 sprint planning/retrospective before Epic 9 can reach `done` (G2). A future UI story should minimally surface: (a) a "Platform Audit Log" admin page, visually and textually distinct from the existing per-org "Audit Log" page (Story 8.2), with its own nav entry/breadcrumb reading "Platform Operator Audit Log"; (b) a filterable/paginated event list backed by `GET /api/v1/platform/audit/events`; (c) an "Verify integrity" action backed by `GET /api/v1/platform/audit/verify`, following the UX spec's "verification-first, non-cryptographer-legible output" principle already established for the per-org log (`ux-design-specification.md` lines 199-204); (d) a maintenance-mode status banner when active. |
| **Honest placeholder AC** (if UI deferred) | N/A — no SvelteKit route is stubbed in this story (a dead route with no linked follow-up story is worse than no route), matching Stories 9.1/9.2's precedent exactly. |
| **Persona journey** | N/A — API-only; the "persona" is the platform operator running curl/scripts (or, later, the deferred UI) against the documented endpoints; see AC-1 through AC-27 for the exact request/response contracts they depend on. |

---

## Key Design Decisions & Open Questions

### D1 — Hard prerequisite: Stories 9.1 AND 9.2 must be **merged** (not just story-created) before this story starts

This story retrofits `platform_audit_events` writes into route handlers that Stories 9.1 (backup/restore) and 9.2 (settings/org-creation) introduce, and it consumes `users.is_platform_operator` / `requirePlatformOperator()` / `admin_alerts` primitives that Story 9.1 defines. As of this story's creation, `_bmad-output/implementation-artifacts/sprint-status.yaml` shows 9-1 and 9-2 both at `ready-for-dev` (story files exist; **no code has landed** — confirmed by grep: zero hits for `is_platform_operator`, `requirePlatformOperator`, `admin_alerts` anywhere in `apps/api/src` or `packages/db/src` in this worktree). **Do not start implementation of this story until 9.1's and 9.2's PRs have actually merged** — their dev-story runs must complete Task 1/Task 2 (9.1) establishing the platform-operator primitives, and 9.2's `modules/platform-admin/` route family must exist, before this story's retrofit tasks (AC-7, AC-8) have anything to attach to. If picked up prematurely, implement 9.1's platform-operator bootstrap (`is_platform_operator` column + `requirePlatformOperator()` preHandler) and 9.2's `modules/platform-admin/` module skeleton first, exactly as 9.2 itself instructs for its own dependency on 9.1.

### D2 — New table is named `platform_audit_events`, not `platform_audit_log_entries`

The existing org-scoped table is `audit_log_entries` (packages/db/src/schema/audit-log-entries.ts) — epics.md's own Story 8.1/9.4 prose calls it `audit_events`, which is stale relative to the shipped schema; the code is authoritative. For this story's **new, platform-level** table, `platform_audit_events` (epics.md's literal name) is kept rather than renamed to match `audit_log_entries`'s convention, because there is already a shipped precedent for exactly this naming family: `platform_security_events` (`packages/db/src/schema/platform-security-events.ts`, migration `0006_platform_security_events.sql`) — a platform-level, non-org-scoped, HMAC-signed, append-only table using the `platform_<noun>_events` pattern. `platform_audit_events` is the correct sibling name, not a `audit_log_entries`-style rename.

### D3 — Separate platform audit signing key, reusing the already-reserved HKDF info string

`packages/crypto/src/kdf.ts` already defines:
```typescript
export const HKDF_INFO = {
  PRIMARY: 'project-vault-v1',
  AUDIT_LOG: 'project-vault-audit-log-v1',
  BACKUP: 'project-vault-backup-v1',
  PLATFORM_AUDIT: 'project-vault-platform-audit-v1', // Story 9.4 uses this
} as const
```
`HKDF_INFO.PLATFORM_AUDIT` is reserved but **completely unconsumed** anywhere in the codebase today — this story is what wires it up. Do not add a new info string; use this constant exactly as-is.

This story adds, mirroring `getAuditKey()`/`_auditKey` in `apps/api/src/modules/vault/key-service.ts` **exactly**:
- A module-level `let _platformAuditKey: Buffer | null = null` cache.
- Derivation at both `initVault()` and `unsealVault()`: `const platformAuditKey = deriveKey(ikm, HKDF_INFO.PLATFORM_AUDIT)`, cached alongside `primaryKey`/`auditKey`, zeroed (`.fill(0)`) on every reseal/error path exactly where `auditKey.fill(0)` already happens (same lines, same discipline).
- `export function getPlatformAuditKey(): Buffer` — throws `VaultSealedError` (the existing class, reused, not a new one) when `_status !== 'unsealed'`, otherwise returns `Buffer.from(_platformAuditKey)` (a copy, matching `getAuditKey()`'s copy-not-reference contract).
- A new `vault_state.platform_audit_key_version` column (`integer NOT NULL DEFAULT 1`) — **not** a reuse of the existing `audit_key_version` column, which is dedicated to the org-scoped audit key's independent rotation lifecycle. The platform audit key has its own, separate rotation lifecycle (rotation execution itself remains out of scope for this story, same accepted gap as `audit_key_version` and `key_version` — see Story 9.2's D8/Open Question #3, which applies identically here).

### D4 — RLS enforcement mechanism for a table with no `org_id` column

`platform_audit_events` has a nullable `target_org_id` (which org, if any, an operator action affected — informational, for cross-org investigation reporting) but **no `org_id` column for tenant isolation**, because the table itself is not tenant-scoped — it belongs to the platform, not to any org. This means `packages/db/src/check-rls-coverage.ts`'s automated gap-detection (which only scans `information_schema.columns` for `column_name = 'org_id'`) will **not** flag this table either way — it is invisible to that specific check regardless of whether RLS is configured correctly.

Because `requirePlatformOperator()` (application-layer) is the primary gate, but this codebase's stated architectural principle is **"RLS enforced at database level — not application layer"** (architecture.md, Data Architecture), this story adds defense-in-depth at the DB level too, mirroring the `org_id`/`app.current_org_id` pattern but for the platform-operator claim instead of an org:

```sql
ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_events_isolation ON platform_audit_events
  USING (current_setting('app.platform_operator_verified', true) = 'true');
```

The session variable `app.platform_operator_verified` is set to `'true'` via `SELECT set_config('app.platform_operator_verified', 'true', true)` (transaction-scoped `SET LOCAL` semantics via the third `true` arg, exactly like `app.current_org_id`) at the top of every `platform_audit_events` read/write, **only after** `requirePlatformOperator()` has already confirmed `authContext.isPlatformOperator === true` and MFA is verified. This means even a hypothetical future bug that mounts a route under `modules/platform-audit/` without the `requirePlatformOperator()` preHandler would still hit an empty result set / blocked write at the database layer, not just an application-layer 403 — the same "belt and suspenders" reasoning the codebase already applies to `audit_log_entries`' append-only trigger *plus* grant revoke (D5). This table is **also** added to `packages/db/src/check-rls-coverage.ts`'s `EXCLUDED_TABLES` set with an explanatory comment (it has no `org_id` column so it wouldn't be auto-detected as a gap regardless, but explicit documentation here matches this codebase's existing practice of listing every platform-level table there, e.g. `vault_state`, `platform_security_events`, `account_recovery_tokens`).

### D5 — Append-only enforcement: trigger + grant revoke (stronger than the `platform_security_events` precedent)

`platform_security_events` (the closest existing precedent, D2) only has grant-layer enforcement (`REVOKE UPDATE, DELETE ... FROM vault_app`) — no trigger. Because `platform_audit_events` is a compliance-grade tamper-evidence log (the entire point of this story), it gets the **stronger** two-layer pattern already used for `audit_log_entries`:
```sql
CREATE OR REPLACE FUNCTION prevent_platform_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_events is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_audit_immutability
  BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_audit_mutation();

REVOKE UPDATE, DELETE ON platform_audit_events FROM vault_app;
```
Postgres checks grants before triggers, so the `REVOKE` fires first in practice; both layers are kept per the existing `audit_log_entries`/`0001_rls_and_triggers.sql` + `0002_audit_log_revoke.sql` precedent (a trigger alone is a single point of failure if a future migration accidentally drops it).

### D6 — HMAC mechanism: per-row HMAC, no hash chain (matches the actual 8.1 implementation, not the stale "chaining" language in architecture.md/PRD)

`architecture.md` and `prd.md` both describe the org-scoped audit log using "cryptographic chaining" language, but the **actual shipped code** (`apps/api/src/modules/audit/write-entry.ts`, `verify.ts`) implements an independent per-row HMAC — no `previous_hash`/`prev_hmac` column, no chain. This story's `platform_audit_events` follows the **actual, shipped** mechanism, not the stale docs:

```typescript
// apps/api/src/modules/platform-audit/write-entry.ts
import { createHmac } from 'node:crypto'

function sortKeys(value: unknown): unknown { /* identical to modules/audit/write-entry.ts's sortKeys — reuse via import, do not duplicate */ }

export function computePlatformAuditHmac(fields: Record<string, unknown>, platformAuditKey: Buffer): string {
  const canonical = JSON.stringify(sortKeys(fields))
  return createHmac('sha256', platformAuditKey).update(canonical).digest('hex')
}
```
HMAC input fields (exact set, matching the `computeAuditHmac` precedent's approach of covering identity + content but not storage metadata): `{ operatorId, actionType, targetOrgId, targetUserId, payload, keyVersion }`. As with the org-scoped precedent, `targetOrgId`/`targetUserId` must be passed as `undefined` (not `null`) when unset at write time, and converted back from Postgres `null` to `undefined` before recompute in `verifyPlatformAuditRange` — the exact same gotcha 8.1's Dev Notes flag, reproduced here to prevent 9.4 from reintroducing it. **Threat model boundary (inherited, unchanged):** this mechanism protects against database-level tampering only — an attacker with API-process code execution or access to the in-memory signing key could forge a self-consistent row. A separate key only isolates blast radius between the two logs; it does not change this fundamental limitation (Story 8.1's adversarial review, finding #1, applies identically here).

### D7 — Retrofit scope: exactly which existing (not-yet-built) route handlers get a platform-audit write added

Per Story 9.1's own explicit forward-reference (D6, Open Question #4) and Story 9.2's own explicit forward-reference (AC-25, Open Question #5), this story must add a `writePlatformAuditEntryOrFailClosed()` call, in the same transaction as the underlying action, to:

| Route (introduced by) | `actionType` |
|---|---|
| `POST /api/v1/admin/backup/trigger` (9.1) | `backup.triggered` |
| `POST /api/v1/admin/backups/:filename/restore` (9.1) | `backup.restore_initiated` (before restore) and `backup.restore_completed` (after, same transaction if restore is transactional, else a follow-up write — see AC-7) |
| `POST /api/v1/admin/backups/:filename/validate` (9.1) | `backup.validated` |
| `PUT /api/v1/admin/settings` (9.2) | `settings.updated` |
| `POST /api/v1/admin/orgs` (9.2) | `org.created` |

`GET /api/v1/admin/backups`, `GET /api/v1/admin/orgs`, `GET /api/v1/admin/resource-usage`, `GET /api/v1/admin/settings` are **read-only** and are explicitly **not** retrofitted — consistent with `audit_log_entries`'s existing convention of auditing mutations and security-relevant reads (e.g. `audit.integrity_verify_run`) but not routine metadata GETs. The two new GET endpoints this story itself introduces (AC-10, AC-12) are also not self-auditing for the same reason (mirroring `GET /api/v1/org/audit/verify`, which IS audited, because verification is a security-sensitive action in that precedent — so `GET /api/v1/platform/audit/verify` **is** audited, as `audit.integrity_verify_run`-equivalent; see AC-12).

These 9.1/9.2 route files do not exist yet in this worktree (D1) — this story's Tasks describe the retrofit as edits to be made to those files once they exist, not as net-new routes.

### D8 — Maintenance-mode & retroactive-recording mechanism

Epics.md requires: "(1) an operator-acknowledged maintenance mode that temporarily bypasses the write-failure invariant for emergency recovery; (2) actions taken during maintenance mode are recorded retroactively when the log becomes available; (3) the maintenance mode activation itself is the first record written after recovery."

Design (self-consistent, satisfies all three literally):
- New single-row-pattern table `platform_audit_maintenance_state` (`id smallint PRIMARY KEY DEFAULT 1` + `CHECK (id = 1)`, matching `vault_state`'s single-row convention): `{ active boolean NOT NULL DEFAULT false, reason text, activatedByUserId uuid, activatedAt timestamptz, deactivatedAt timestamptz }`.
- New staging table `platform_audit_pending_entries`: `{ id uuid PRIMARY KEY DEFAULT gen_random_uuid(), intendedFields jsonb NOT NULL, attemptedAt timestamptz NOT NULL DEFAULT now(), sequenceNum bigint NOT NULL }` — `sequenceNum` from a dedicated sequence (`CREATE SEQUENCE platform_audit_pending_seq`) guarantees strict FIFO drain order even under concurrent writers, which insertion order via `created_at` alone cannot guarantee at sub-millisecond concurrency.
- `writePlatformAuditEntryOrFailClosed()` behavior change when maintenance mode is active: it still **attempts** the real `platform_audit_events` INSERT first (unchanged happy path — if the log is actually available, the row is written normally, no queuing). Only if that attempt throws **and** `platform_audit_maintenance_state.active = true` does the write helper catch the failure, insert an `intendedFields` row into `platform_audit_pending_entries` instead, and return successfully (the parent action's transaction is **not** rolled back — this is the literal "bypass" epics.md describes). If maintenance mode is **not** active, any write failure still aborts the parent transaction exactly as `writeHumanAuditEntryOrFailClosed` does today (D6, unchanged invariant).
- `POST /api/v1/platform/maintenance-mode { reason }` (activate): sets `platform_audit_maintenance_state.active = true`, `reason`, `activatedByUserId`, `activatedAt`, **then itself attempts** a `maintenance_mode.activated` platform-audit write through the exact same `writePlatformAuditEntryOrFailClosed()` path used by every other action. If the log is genuinely unavailable (the reason the operator is invoking this endpoint), that write fails and becomes `platform_audit_pending_entries` row #1 (via the dedicated sequence) — naturally first in FIFO order, satisfying requirement (3) without any special-casing.
- Recovery/drain: the **next** time any `writePlatformAuditEntryOrFailClosed()`-guarded action succeeds a real INSERT while `platform_audit_pending_entries` has rows, the write helper additionally drains the staging table FIFO (`ORDER BY sequence_num ASC`) into real `platform_audit_events` rows, computing the HMAC with the now-available key, using each row's original `attemptedAt` as the `timestamp` field (so the historical record reflects when the action actually happened, not when it was backfilled) and setting `payload.recordedRetroactively: true` on each drained row for auditor transparency. After the drain completes and `platform_audit_pending_entries` is empty, `platform_audit_maintenance_state.active` is set to `false` and `deactivatedAt = now()`, and a `maintenance_mode.deactivated` row is written fresh (not queued — the log is confirmed available at this point).
- `POST /api/v1/platform/maintenance-mode { action: 'deactivate' }`: an operator can also explicitly request deactivation (e.g., they know the emergency has passed even before any write has been attempted) — this immediately attempts the drain-and-deactivate sequence described above; if the log is still actually unavailable, the deactivation attempt itself fails closed with `503` (do not let an operator manually declare recovery that the system cannot verify).

### D9 — Cross-log distinction (PJ9) is satisfied at the API-contract level, not the UI level, in this story

Every response from `/api/v1/platform/*` routes carries `X-Log-Scope: platform` (AC-13). The OpenAPI spec tags these routes `Platform Audit` (distinct from the existing per-org `Audit` tag, if 8.2 has landed by then, or simply a new distinct tag if not). No unified cross-log search exists or is planned for v1 (explicitly out of scope, per epics.md's PJ9 boundary) — this must be stated plainly in this story's Dev Notes (done, see below) so a future reader does not mistake the absence of a combined search for an oversight.

### D10 — Extend Story 9.2's audit-storage monitoring to cover `platform_audit_events` (closes 9.2's own forward-reference)

Story 9.2's `audit-storage:check` job (D5/AC-18) monitors only `audit_log_entries` size against `AUDIT_LOG_STORAGE_LIMIT_GB` and explicitly defers `platform_audit_events` coverage to this story (9.2's adversarial review flagged this as a real gap, not just documentation debt). This story's Tasks must **edit** `apps/api/src/workers/audit-storage-check.ts` (once it exists, per D1) to additionally query `pg_total_relation_size('platform_audit_events')` and evaluate it against a **separate** threshold, `PLATFORM_AUDIT_STORAGE_LIMIT_GB` (its own env var — the two logs have independent, unrelated growth rates and retention policies, so a single shared threshold would be wrong), raising a distinct `admin_alerts` row (`alertType: 'platform_audit_storage.warning'` / `.critical'`) reusing the existing `admin_alerts` table (D3 from Story 9.1 — do not invent a second alert table).

### D11 — Verify endpoint bounds mirror 8.1's constants exactly, scoped platform-wide (no org filter)

`GET /api/v1/platform/audit/verify` reuses the exact numeric bounds Story 8.1 established for `GET /api/v1/org/audit/verify` (`AUDIT_VERIFY_MAX_RANGE_DAYS = 90`, `AUDIT_VERIFY_MAX_ROWS = 50_000`, `FAILED_ENTRIES_CAP = 500`) as `PLATFORM_AUDIT_VERIFY_MAX_RANGE_DAYS`, `PLATFORM_AUDIT_VERIFY_MAX_ROWS`, `PLATFORM_AUDIT_VERIFY_FAILED_ENTRIES_CAP` — same values, own named constants (this table's write volume is expected to be far lower than the org-scoped log, but there is no reason to pick different numbers without operational evidence). Unlike the org-scoped verify (which relies entirely on RLS for tenant scoping, D4 there), this endpoint has no tenant scope to rely on — it verifies every row platform-wide in the given time range, which is correct since there is exactly one platform-operator "tenant."

### Open Questions (for Epic 9 sprint planning / retrospective — not blockers to `ready-for-dev`)

1. No story currently scopes a Platform Operator Audit Log web UI (Product Surface Contract gap — same pattern as Stories 9.1/9.2; must be raised at Epic 9 retro per G2).
2. Platform-operator grant/revoke (i.e., changing `users.is_platform_operator` for a user other than the bootstrap-first-user) has no dedicated endpoint anywhere in Stories 9.1/9.2/9.4 — it is a manual SQL operation per 9.1's documented upgrade path. This story does **not** add audit coverage for that manual SQL operation (there is no application code path to hook into). A future story should decide whether to add a dedicated `POST /api/v1/platform/operators` grant/revoke endpoint, at which point it would naturally get `platform_audit_events` coverage as part of that story.
3. `platform_audit_key_version`/`audit_key_version`/`key_version` all currently start at 1 with no rotation-execution code path anywhere (Story 9.2's D8/Open Question #3 applies identically to the new column this story adds) — a future key-rotation story must revisit all three, not just the org-scoped one.
4. Per-log retention/pruning enforcement: this story defines `PLATFORM_AUDIT_RETENTION_DAYS` and a pruning mechanism (AC-20), independent of whether Story 8.2's equivalent org-scoped pruning mechanism has landed — confirm at Epic 9 retro whether the two pruning jobs should eventually be consolidated into one scheduler pattern once both exist.

---

## Acceptance Criteria

### AC-1 — `platform_audit_events` schema, migration, and column set (D2, D4)

**Given** this story's migration runs,
**When** inspected,
**Then** `platform_audit_events` exists with exactly: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `operator_id uuid NOT NULL REFERENCES users(id)`, `action_type text NOT NULL`, `target_org_id uuid` (nullable, no FK enforcement — see edge case below), `target_user_id uuid` (nullable, no FK enforcement), `payload jsonb NOT NULL DEFAULT '{}'`, `ip_address text`, `key_version integer NOT NULL`, `hmac text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()` — **no `updated_at`** (immutable table, matching `audit_log_entries`'s documented convention exactly).

**Example (positive):** after migration, `\d platform_audit_events` in psql shows all ten columns with the exact types above, plus indexes `idx_platform_audit_events_operator_created (operator_id, created_at DESC)`, `idx_platform_audit_events_action_type (action_type, created_at DESC)`, `idx_platform_audit_events_target_org (target_org_id, created_at DESC)`.

**Example (edge — `target_org_id` referencing a since-deleted org):** an operator investigation logged against `targetOrgId = 'abc-123'`, and that org is later deleted (org deletion is out of scope for v1 per epics.md but hypothetically possible via direct DB access) — the audit row must **not** be deleted or nullified (unlike a `CASCADE` FK), preserving the historical record. This is why `target_org_id`/`target_user_id` intentionally have **no FK constraint** — an enforced FK would either block the org deletion (wrong — audit trail must not constrain unrelated operations) or cascade-delete/null the audit row (wrong — destroys history). This mirrors `audit_log_entries.project_id`'s existing "intentionally deferred FK" precedent.

**Example (schema-file convention check):** `packages/db/src/schema/platform-audit-events.ts` carries the same top-of-file comment style as `audit-log-entries.ts`: `// IMMUTABLE: append-only, no updates permitted`.

---

### AC-2 — Append-only immutability enforced at trigger and grant level (D5)

**Given** the migration's trigger and `REVOKE` statements have run,
**When** any code path (application or a stray manual `psql` session using the `vault_app` role) attempts `UPDATE platform_audit_events SET ... ` or `DELETE FROM platform_audit_events WHERE ...`,
**Then** the statement fails.

**Example (positive — grant layer blocks first):** `UPDATE platform_audit_events SET payload = '{}' WHERE id = '...'` as `vault_app` → Postgres error `permission denied for table platform_audit_events` (grant-level, checked before the trigger fires).

**Example (edge — trigger as the second line of defense):** if a future migration accidentally re-grants `UPDATE`/`DELETE` to `vault_app` (regression), the `platform_audit_immutability` trigger still fires and raises `platform_audit_events is append-only: UPDATE and DELETE are forbidden` — verified by a dedicated test that temporarily re-grants the privilege inside a rolled-back transaction and confirms the trigger alone still blocks the mutation (mirrors the equivalent `audit_log_entries` test pattern, if one exists, or is added here as a first-of-its-kind test for this defense-in-depth claim).

**Example (negative — INSERT is unaffected):** a normal `INSERT` via `writePlatformAuditEntry()` succeeds; only `UPDATE`/`DELETE` are blocked.

---

### AC-3 — RLS restricts `platform_audit_events` visibility to verified platform-operator transactions only (D4)

**Given** `platform_audit_events` has RLS enabled with the `platform_audit_events_isolation` policy,
**When** a query runs without `app.platform_operator_verified` set to `'true'` in the current transaction,
**Then** the query returns zero rows (RLS silently filters, does not error) — including a hypothetical bug where a route mounts under `modules/platform-audit/` without wiring `requirePlatformOperator()`.

**Example (positive):** `requirePlatformOperator()` preHandler confirms `authContext.isPlatformOperator === true` and MFA verified; the route's transaction runs `SELECT set_config('app.platform_operator_verified', 'true', true)` before querying; rows are visible normally.

**Example (edge — session variable set outside a transaction, or with `true` local flag omitted):** if `set_config`'s third argument were `false` (session-scoped, not transaction-scoped) instead of `true`, the variable would leak across pooled-connection reuse into an unrelated subsequent request — this is exactly the connection-pool race architecture.md already warns about for `app.current_org_id`; the implementation **must** use the transaction-scoped form (`true`), verified by a test that runs two sequential unrelated transactions on the same pooled connection and confirms the second one (which never sets the variable) sees zero rows.

**Example (negative — direct DB query attempting to read platform_audit_events as if it were org-scoped data):** even a query run inside a transaction that *has* `app.current_org_id` set (i.e., an ordinary org-scoped request context) but never sets `app.platform_operator_verified` returns zero rows from `platform_audit_events` — org context and platform-operator context are orthogonal, and only the latter grants visibility here.

---

### AC-4 — Platform audit signing key derivation and lifecycle (D3)

**Given** the vault is initialized or unsealed,
**When** `initVault()` or `unsealVault()` runs,
**Then** a platform audit key is derived via `deriveKey(ikm, HKDF_INFO.PLATFORM_AUDIT)`, cached in `_platformAuditKey`, and zeroed/replaced on every subsequent unseal exactly like `_auditKey`.

**Example (positive):** immediately after `POST /api/v1/vault/unseal` succeeds, `getPlatformAuditKey()` returns a 32-byte `Buffer` without throwing.

**Example (edge — vault sealed):** `getPlatformAuditKey()` called while `_status !== 'unsealed'` throws `VaultSealedError('getPlatformAuditKey: vault is sealed — platform audit key unavailable')` — same class as `getAuditKey()`'s error (`instanceof VaultSealedError` still works for shared error-handling code), distinct message.

**Example (edge — reseal clears the previous key):** after a reseal, a lingering reference to a previously-returned `Buffer` from `getPlatformAuditKey()` is unaffected (it was a copy, `Buffer.from(_platformAuditKey)`), but the module-level `_platformAuditKey` itself is `.fill(0)`'d before being reassigned or nulled — verified by a test that captures the key before reseal, reseals, and confirms a fresh `getPlatformAuditKey()` call after re-unseal returns a key that still matches the original expectation (since `ikm` — the master key material — is unchanged across reseal/unseal of the same instance) while the in-between sealed-state call throws.

---

### AC-5 — `vault_state.platform_audit_key_version` tracks the platform key's own rotation lifecycle (D3)

**Given** `vault_state` gets a new `platform_audit_key_version integer NOT NULL DEFAULT 1` column via this story's migration,
**When** an existing pre-migration instance runs the migration,
**Then** its single `vault_state` row gets `platform_audit_key_version = 1` (the column default) with **no** other data change — this is purely additive.

**Example (positive):** a brand-new instance's first `platform_audit_events` row has `key_version: 1`, matching a fresh `vault_state.platform_audit_key_version` of 1.

**Example (edge — independence from `audit_key_version`):** `audit_key_version` and `platform_audit_key_version` can diverge in the future (e.g., if the org-scoped audit key is rotated but the platform key is not, or vice versa) — no code path should assume they move together; `currentPlatformAuditKeyVersion(tx)` (mirroring `currentAuditKeyVersion(tx)`) reads only its own column.

---

### AC-6 — `writePlatformAuditEntry` / `writePlatformAuditEntryOrFailClosed` — fail-closed invariant, payload redaction (D6, D7)

**Given** any privileged platform-operator action executes inside a DB transaction,
**When** the action's handler calls `writePlatformAuditEntryOrFailClosed(tx, { operatorId, actionType, targetOrgId, targetUserId, payload, request })`,
**Then** the row is written in the **same transaction** as the triggering action, using `computePlatformAuditHmac()` and `getPlatformAuditKey()`; any error during this write (HMAC computation failure, DB constraint violation, sealed-vault `VaultSealedError`) is rewrapped as a new `SameTransactionPlatformAuditWriteError` (sibling to the existing `SameTransactionAuditWriteError`, same rethrow pattern in `rethrowAsSameTransactionAuditWriteError`, reused not duplicated) and the parent transaction rolls back — **unless maintenance mode is active** (D8, AC-16/17), in which case the failure is caught and queued instead.

**Example (positive):** `PUT /api/v1/admin/settings` succeeds; in the same transaction, a `platform_audit_events` row is written with `actionType: 'settings.updated'`, `payload: { operatorId, fieldsChanged: ['smtp.host'] }` — no `smtp.password` field appears anywhere in `payload` even though the request body contained one (see redaction rule below).

**Example (edge — payload redaction):** `writePlatformAuditEntry`'s `payload` construction reuses the existing `FORBIDDEN_AUDIT_KEYS` set from `apps/api/src/lib/secure-route.ts` (`password`, `passphrase`, `masterKeyPath`, `secret`, `value`, `apiKey`, etc.) — any handler-constructed payload object passing a forbidden key through throws a development-time assertion error (fail loud in tests/dev, strip silently and log a warning in production) rather than ever persisting a credential value into an immutable table. This is the same discipline already applied to the org-scoped audit log's `writeAuditEvent` config.

**Example (negative — write failure aborts the action, maintenance mode inactive):** vault is unexpectedly resealed mid-request (race condition) between the settings UPDATE and the audit write; `getPlatformAuditKey()` throws `VaultSealedError`; the wrapper rethrows `SameTransactionPlatformAuditWriteError`; the route handler catches this and returns `503 { code: "platform_audit_write_failed", message: "..." }`; the settings change itself is rolled back — the operator sees the settings UPDATE did NOT take effect, consistent with the "100% capture guarantee" invariant (no privileged action completes without its audit record).

---

### AC-7 — Retrofit: 9.1's backup/restore routes write `platform_audit_events` (D7)

**Given** Story 9.1's `POST /api/v1/admin/backup/trigger`, `POST /api/v1/admin/backups/:filename/restore`, `POST /api/v1/admin/backups/:filename/validate` exist (post-D1 merge),
**When** each is called successfully,
**Then** each also writes a `platform_audit_events` row in the same transaction as its existing `operationalLog()` call (both are kept — operational log for ops-team pino-based monitoring, platform audit log for compliance-grade tamper-evidence; this story does not remove 9.1's operational logging).

**Example (positive — backup trigger):** `POST /api/v1/admin/backup/trigger` → `202 { jobId, status: 'running' }` and a `platform_audit_events` row `{ actionType: 'backup.triggered', targetOrgId: null, targetUserId: null, payload: { jobId } }`.

**Example (positive — restore, two-phase):** `POST /api/v1/admin/backups/:filename/restore` with `{ confirmRestore: true, reason: "..." }` writes `backup.restore_initiated` (payload includes the operator-supplied `reason` and a **sanitized/validated** `filename` — reusing whatever path-traversal guard 9.1 applies to the `:filename` param itself, per 9.1's adversarial-review finding #3) before the restore executes, and `backup.restore_completed` (or `backup.restore_failed` on error) after — as two separate rows since `pg_restore` is a long-running, non-transactional operation that cannot share a single DB transaction with the audit write for its full duration.

**Example (edge — restore fails mid-operation):** if `pg_restore` itself fails after `backup.restore_initiated` was already committed, `backup.restore_failed` is written as its own subsequent row (not retroactively rewriting the `_initiated` row — the table is append-only); an operator reviewing the log sees both rows and can reconstruct the timeline.

---

### AC-8 — Retrofit: 9.2's settings/org-creation routes write `platform_audit_events` (D7)

**Given** Story 9.2's `PUT /api/v1/admin/settings` and `POST /api/v1/admin/orgs` exist (post-D1 merge),
**When** each is called successfully,
**Then** each writes a `platform_audit_events` row in the same transaction as the underlying change (not a separate follow-up transaction — these ARE single-transaction operations, unlike backup/restore).

**Example (positive — settings update):** `PUT /api/v1/admin/settings { smtp: { host: "new.example.com" } }` → `200`, and in the same transaction, `platform_audit_events` row `{ actionType: 'settings.updated', payload: { fieldsChanged: ['smtp.host'] } }` (never the raw new/old values for `smtp.password` — AC-6's redaction rule).

**Example (positive — org creation):** `POST /api/v1/admin/orgs { name: "Acme", ownerEmail: "owner@acme.com" }` → `201 { id, name, slug, ownerAccountAction, ownerUserId }`, and `platform_audit_events` row `{ actionType: 'org.created', targetOrgId: <new org id>, targetUserId: <ownerUserId>, payload: { name, ownerAccountAction } }`.

**Example (edge — settings update that changes nothing):** `PUT /api/v1/admin/settings {}` (empty body, no fields) — still returns `200` (per 9.2's partial-update semantics) but this story's retrofit must **not** write a `platform_audit_events` row with an empty `fieldsChanged: []`, since no actual change occurred; verified by a test asserting row count is unchanged after a no-op `PUT`.

---

### AC-9 — `GET /api/v1/platform/audit/events` — search and pagination

**Given** the platform operator calls `GET /api/v1/platform/audit/events` with any combination of `operatorId`, `actionType`, `targetOrgId`, `targetUserId`, `from`, `to`, `page` (default 1), `limit` (default 20, max 100),
**When** the query executes,
**Then** it returns `{ data: { items: [{ id, operatorId, actionType, targetOrgId, targetUserId, payload, ipAddress, timestamp }], page, limit, total } }`, matching the existing `PaginationQuerySchema` offset-pagination convention (`apps/api/src/modules/machine-users/schema.ts`) rather than inventing a cursor scheme.

**Example (positive — no filters):** `GET /api/v1/platform/audit/events` → `200 { data: { items: [...20 most recent rows...], page: 1, limit: 20, total: 143 } }`.

**Example (positive — filtered):** `GET /api/v1/platform/audit/events?actionType=org.created&from=2026-07-01T00:00:00Z&to=2026-07-06T00:00:00Z` → only rows matching both the action type and the date range.

**Example (edge — `limit` exceeds max):** `?limit=500` → `422 { code: "validation_error", message: "..." }` (Zod schema caps at 100, matching the `PaginationQuerySchema` precedent's `max(100)`).

**Example (edge — empty result, not an error):** a fresh instance with zero operator actions yet → `200 { data: { items: [], page: 1, limit: 20, total: 0 } }` — never a 404.

**Example (negative — org admin, not platform operator):** `GET /api/v1/platform/audit/events` with an org Owner's token → `403 { code: "platform_operator_required", message: "This endpoint requires platform operator privileges." }`.

---

### AC-10 — Platform-operator authorization + MFA required on every `/api/v1/platform/*` route (D1, mirrors 9.2's AC-1 pattern)

**Given** all three routes this story adds (`GET /platform/audit/events`, `GET /platform/audit/verify`, `POST /platform/maintenance-mode`),
**When** any is called,
**Then** it requires `requirePlatformOperator()` + `requireOrgScope: false` + `requireMfa: true` — never `allowedRoles`/`requireOrgRole`, following the exact convention 9.1/9.2 establish for `modules/platform-admin/`. This story's own routes live in a **new sibling module**, `apps/api/src/modules/platform-audit/`, not inside `modules/platform-admin/` (a distinct concept — audit-log read/verify vs. instance administration — kept in separate modules the same way `modules/audit/` is already separate from `modules/admin/` for the org-scoped equivalent).

**Example (positive):** a platform operator with a fully MFA-verified session succeeds on all three routes.

**Example (negative — unauthenticated):** no `Authorization`/session cookie → `401 { code: "access_token_missing", ... }`.

**Example (negative — authenticated org admin, not platform operator):** `403 { code: "platform_operator_required", ... }` on all three routes.

**Example (negative — platform operator, MFA not verified this session):** `403 { code: "mfa_required", message: "This endpoint requires a session with MFA verified." }`.

**Example (regression guard):** a `platform-audit-route-audit.test.ts` (sibling to 9.2's proposed `platform-admin-route-audit.test.ts`) asserts every route under `modules/platform-audit/` has `requireOrgScope: false`, `requireMfa: true`, and zero `allowedRoles` entries.

---

### AC-11 — `GET /api/v1/platform/audit/verify` — integrity verification (D11)

**Given** the platform operator calls `GET /api/v1/platform/audit/verify?from=<ISO>&to=<ISO>`,
**When** the range is valid,
**Then** it recomputes the HMAC for every `platform_audit_events` row in `[from, to)` and returns `{ data: { summary, rowsChecked, passed, failed: [{id, actionType, timestamp}] (capped at `PLATFORM_AUDIT_VERIFY_FAILED_ENTRIES_CAP=500`), failedCount, failedTruncated, verifiedAt } }` — same response shape as the org-scoped `/audit/verify`, with `eventType` renamed to `actionType` in the `failed` array entries to match this table's column name.

**Example (positive — no tampering):** `200 { data: { summary: "All 42 records verified — no tampering detected", rowsChecked: 42, passed: 42, failed: [], failedCount: 0, failedTruncated: false, verifiedAt: "..." } }`.

**Example (edge — range exceeds 90 days):** `?from=2025-01-01T00:00:00Z&to=2026-07-01T00:00:00Z` → `422 { code: "range_too_large", message: "Range exceeds 90 days; narrow the from/to window and call again" }`.

**Example (edge — vault sealed):** `getPlatformAuditKey()` throws before any row fetch (matching 8.1's precedent of checking key availability before touching the DB) → `503 { code: "platform_audit_key_unavailable", message: "Platform audit key is unavailable while the vault is sealed" }`.

**Example (negative — a row's HMAC was forged via direct DB write bypassing the write helper, e.g. a hypothetical `INSERT` with a fabricated `hmac`):** that row's recomputed HMAC does not match the stored value → included in `failed`, `failedCount` incremented, `summary` reads `"41 of 42 records verified — 1 record failed integrity check"`.

**Example (audit-of-the-auditor):** this endpoint's own successful call writes a `platform_audit_events` row `{ actionType: 'platform_audit.integrity_verify_run', payload: { from, to, rowsChecked, passed, failedCount } }` — mirroring the org-scoped precedent where `GET /audit/verify` audits itself (D7 exemption list explicitly excludes this route from the "reads aren't audited" rule, same as its org-scoped sibling).

---

### AC-12 — `X-Log-Scope: platform` header on every response (D9, PJ9)

**Given** any of the three routes in this story respond (success or error),
**When** the response is serialized,
**Then** it includes response header `X-Log-Scope: platform`.

**Example (positive):** `GET /api/v1/platform/audit/events` → `200` with header `X-Log-Scope: platform` present alongside the JSON body.

**Example (edge — error responses also carry the header):** a `403 platform_operator_required` response still carries `X-Log-Scope: platform` — the header identifies which log family the endpoint belongs to regardless of whether the caller was authorized to use it, so client tooling can distinguish "wrong log, still your fault" from "right log, try again."

---

### AC-13 — Rate limiting on `GET` endpoints (matches 8.1's `/audit/verify` precedent)

**Given** `GET /api/v1/platform/audit/events` and `GET /api/v1/platform/audit/verify`,
**When** called repeatedly by the same platform-operator account,
**Then** each is capped at 20 requests/minute (matching 8.1's `/org/audit/verify` limit exactly — this table's expected call volume is lower than the org-scoped equivalent, so there is no reason for a looser limit).

**Example (positive):** 20 calls in 60 seconds all succeed.

**Example (edge — 21st call within the window):** `429 { code: "rate_limited", message: "..." }` with a `Retry-After` header, matching the existing `@fastify/rate-limit` response shape used elsewhere in the codebase.

---

### AC-14 — `POST /api/v1/platform/maintenance-mode` — activation (D8)

**Given** the platform operator calls `POST /api/v1/platform/maintenance-mode { reason: "..." }` (no `action` field, or `action: 'activate'`),
**When** `platform_audit_maintenance_state.active` is currently `false`,
**Then** it sets `active = true`, `reason`, `activatedByUserId = auth.userId`, `activatedAt = now()`, attempts a `maintenance_mode.activated` platform-audit write (which becomes pending-entry #1 if the log is genuinely unavailable, per D8), and returns `200 { active: true, activatedAt, reason }`.

**Example (positive — proactive activation, log actually still available):** operator activates maintenance mode preemptively before a planned emergency DB operation; the `maintenance_mode.activated` write succeeds immediately (nothing queued); `platform_audit_maintenance_state.active` remains `true` until explicitly deactivated or until an actual write failure+recovery cycle occurs.

**Example (edge — already active):** a second `POST { reason: "..." }` while `active` is already `true` → `409 { code: "maintenance_mode_already_active", message: "..." }` (idempotency by rejection, not silent overwrite — the original `reason`/`activatedAt` must not be clobbered by a second, possibly accidental, activation call).

**Example (edge — validation):** `POST {}` with no `reason` → `422 { code: "validation_error", message: "reason is required" }` — an un-reasoned maintenance-mode activation is not permitted; this is a deliberately high-friction, rarely-used emergency escape hatch, not a routine toggle.

---

### AC-15 — Maintenance-mode bypass suspends the write-failure invariant, queues to `platform_audit_pending_entries` (D8)

**Given** `platform_audit_maintenance_state.active = true` and the vault is sealed (or any other transient cause makes `platform_audit_events` writes fail),
**When** an operator action (e.g., `PUT /api/v1/admin/settings`) executes and its `writePlatformAuditEntryOrFailClosed()` call fails,
**Then** the failure is caught, an `intendedFields` row is inserted into `platform_audit_pending_entries` with the next `sequenceNum`, and the parent action's transaction **commits normally** — the settings change takes effect even though its audit record is not yet durably in `platform_audit_events`.

**Example (positive):** three operator actions occur in sequence while maintenance mode is active and the vault is sealed: `maintenance_mode.activated` (seq 1), `settings.updated` (seq 2), `org.created` (seq 3) — all three succeed as normal actions, all three end up in `platform_audit_pending_entries` in that exact order.

**Example (edge — maintenance mode active but the log is actually fine):** an action's `writePlatformAuditEntryOrFailClosed()` call succeeds on the first attempt (no failure) — nothing is queued; maintenance mode being "active" does not itself suppress or delay writes, it only changes what happens **if** a write fails.

**Example (negative — maintenance mode NOT active, same failure):** the exact same vault-sealed scenario with `active = false` → the settings UPDATE itself is rolled back and the operator sees `503 platform_audit_write_failed` (AC-6's unmodified invariant) — this contrast is the entire point of D8's design and must be covered by a side-by-side test pair.

---

### AC-16 — Retroactive drain on recovery; activation event recorded first (D8)

**Given** `platform_audit_pending_entries` has queued rows and the platform audit log becomes available again (e.g., the vault is unsealed),
**When** the next `writePlatformAuditEntryOrFailClosed()` call succeeds a real INSERT,
**Then** it first drains all pending rows FIFO (`ORDER BY sequence_num ASC`) into real `platform_audit_events` rows — each with `timestamp` set to its original `attemptedAt`, `payload.recordedRetroactively: true` — before or alongside writing its own new row, and finally (once the pending table is empty) sets `platform_audit_maintenance_state.active = false`, `deactivatedAt = now()`, and writes a fresh (non-queued) `maintenance_mode.deactivated` row.

**Example (positive — exact ordering):** after the vault is unsealed, the first `platform_audit_events` rows to appear (by `created_at`, the actual insert time) are, in this order: the drained `maintenance_mode.activated` (seq 1, `payload.recordedRetroactively: true`, `timestamp` = original activation time), the drained `settings.updated` (seq 2), the drained `org.created` (seq 3), then a fresh `maintenance_mode.deactivated` row (real-time, not retroactive) — satisfying epics.md's literal "the maintenance mode activation itself is the first record written after recovery."

**Example (edge — concurrent drain race):** two operator actions succeed "at the same time" right as the log recovers — only one of them should perform the drain (advisory lock or `SELECT ... FOR UPDATE SKIP LOCKED` on `platform_audit_maintenance_state`'s single row prevents a double-drain that would duplicate rows); the other proceeds with its own normal write once the drain-holder releases the lock.

**Example (edge — operator-initiated deactivation while genuinely still broken):** `POST /api/v1/platform/maintenance-mode { action: 'deactivate' }` while the vault is still sealed → the drain attempt itself fails (same underlying cause) → `503 { code: "platform_audit_write_failed", message: "Cannot deactivate maintenance mode: platform audit log is still unavailable" }`; `active` remains `true`.

---

### AC-17 — `PLATFORM_AUDIT_RETENTION_DAYS` configuration and pruning (D8, epics.md's stated requirement)

**Given** the env var `PLATFORM_AUDIT_RETENTION_DAYS` (`z.coerce.number().int().min(30).max(3650).default(365)`, following the exact validation pattern already used for `INBOX_RETENTION_DAYS` in `apps/api/src/config/env.ts`),
**When** a scheduled `platform-audit:retention` pg-boss job runs (daily, matching `session:cleanup`'s cadence pattern),
**Then** rows older than `now() - PLATFORM_AUDIT_RETENTION_DAYS` are purged via a dedicated `SECURITY DEFINER` function `purge_expired_platform_audit_entries(p_cutoff timestamptz)` (its own function — this story does **not** depend on Story 8.2's `purge_expired_audit_log_entries()` existing, since 8.2 may not have landed yet; the two pruning functions are independent, mirroring D10's reasoning that the two logs have unrelated growth rates and retention policies).

**Example (positive):** with `PLATFORM_AUDIT_RETENTION_DAYS=365` (default), a row created 400 days ago is purged on the next daily run; a row created 300 days ago is retained.

**Example (edge — retention shorter than a pending compliance investigation):** an operator sets `PLATFORM_AUDIT_RETENTION_DAYS=30` (the configured minimum) — the story does not add any "legal hold" override mechanism; this is a documented v1 limitation (an operator who needs to retain specific rows longer than the instance-wide retention window must export them first via manual `SELECT`, since Story 8.2's export mechanism is scoped to the org-scoped log, not this one). Note this explicitly in Dev Notes as an accepted v1 gap, not silently.

**Example (negative — purge function bypass attempt):** the `SECURITY DEFINER` function contains no caller-supplied filtering beyond the cutoff timestamp (unlike `purge_expired_audit_log_entries`'s org-context check, which doesn't apply here since there's no tenant to check against) — it purges platform-wide by design, callable only by the scheduled job's internal invocation path, not exposed as an HTTP endpoint.

---

### AC-18 — Extend Story 9.2's audit-storage monitoring to cover `platform_audit_events` (D10)

**Given** Story 9.2's `audit-storage:check` job exists (post-D1 merge) and this story adds `PLATFORM_AUDIT_STORAGE_LIMIT_GB` (own env var, own default, e.g. 5 GB — independent of `AUDIT_LOG_STORAGE_LIMIT_GB`),
**When** the job's next scheduled run occurs,
**Then** it additionally queries `pg_total_relation_size('platform_audit_events')` and, at ≥95% of the configured limit, raises an `admin_alerts` row `{ alertType: 'platform_audit_storage.critical', severity: 'critical', payload: { sizeBytes, limitBytes } }` (reusing the existing `admin_alerts` table, D3 from 9.1 — not a new table).

**Example (positive):** at 60% utilization, no alert fires (below the 95% threshold, matching 9.2's existing threshold convention for the org-scoped log).

**Example (edge — both logs cross their thresholds independently):** `audit_log_entries` at 96% and `platform_audit_events` at 40% → only the org-scoped alert fires; they are evaluated and alerted independently, never conflated into one alert row.

**Example (regression check — closes 9.2's own flagged gap):** a test asserts `audit-storage:check`'s output/alert set includes coverage for both table names after this story lands, directly closing 9.2's adversarial-review finding that its "100% audit-storage-monitoring coverage" claim would otherwise become false once this table exists.

---

### AC-19 — Concurrency: simultaneous operator actions do not lose audit rows (D6)

**Given** two platform-operator requests execute concurrently (e.g., two different operators, or the same operator from two browser tabs, both triggering actions that each write a `platform_audit_events` row),
**When** both transactions commit,
**Then** both `platform_audit_events` rows exist — Postgres's normal MVCC/row-locking guarantees this for independent `INSERT`s (no shared mutable state between them at the row level); the `platform_audit_pending_seq` sequence (D8) guarantees strictly increasing, gap-tolerant-but-never-duplicated ordering numbers even under concurrent queuing.

**Example (positive):** 50 concurrent `POST /api/v1/admin/backup/trigger`-style test calls (against a test double or serialized-in-test-setup scenario) each produce exactly one `platform_audit_events` row — total row count increases by exactly 50, no lost writes, no duplicate `id`s (verified via `gen_random_uuid()`'s effectively-zero collision probability plus a `PRIMARY KEY` constraint as a hard backstop).

**Example (edge — concurrent maintenance-mode drain, covered already in AC-16's concurrency example):** cross-reference — the `SELECT ... FOR UPDATE SKIP LOCKED` (or advisory lock) on `platform_audit_maintenance_state` is the specific mechanism preventing a double-drain under concurrency; this AC's general claim about ordinary concurrent writes does not by itself protect the drain path, which needs its own explicit lock (already specified in AC-16).

---

### AC-20 — Sealed-vault guard applies uniformly (D3, D11)

**Given** the vault is sealed,
**When** any of this story's three routes, or any retrofitted 9.1/9.2 route's audit-write step, is invoked,
**Then** `getPlatformAuditKey()` throws `VaultSealedError`, surfaced as `503 { code: "platform_audit_key_unavailable" }` for the two GET routes, or as `503 { code: "platform_audit_write_failed" }` (with the underlying action rolled back, unless maintenance mode is active per AC-15) for any write path.

**Example (positive — vault unsealed):** all routes function normally.

**Example (edge — vault sealed, maintenance mode NOT active, GET /platform/audit/verify called):** `getPlatformAuditKey()` is checked **before** any row fetch (mirroring 8.1's `verifyAuditRange`'s existing "check the key before touching the DB" ordering) → immediate `503`, no wasted query.

**Example (edge — vault sealed, maintenance mode active, a write is attempted):** per AC-15, the write is queued to `platform_audit_pending_entries` instead of aborting — this is the **one** documented, intentional exception to this AC's general "sealed vault blocks writes" rule, and must be cross-referenced in the implementation's code comments exactly as 9.2's D10 cross-references its own equivalent exception.

---

### AC-21 — Tenant isolation: an org admin cannot access `platform_audit_events` by any means (D4)

**Given** an authenticated org Owner (not a platform operator),
**When** they attempt `GET /api/v1/platform/audit/events` (application-layer 403, AC-10) **or**, hypothetically, a direct database query using the application's own `vault_app` connection role within an org-scoped transaction (i.e., simulating "what if the application layer check were bypassed"),
**Then** both are blocked — the first by `requirePlatformOperator()`, the second by RLS (`app.platform_operator_verified` never gets set to `'true'` in an ordinary org-scoped transaction, so the policy filters all rows).

**Example (positive — the RLS test that proves the 403 isn't the only line of defense):** a test opens a transaction, sets `app.current_org_id` (ordinary org context) but deliberately does **not** call `requirePlatformOperator()`'s session-var side effect, and runs `SELECT * FROM platform_audit_events` directly against the test DB connection — asserts zero rows returned, proving RLS (not just the route handler) enforces isolation.

**Example (edge — a platform operator who is ALSO a member of an org, querying while in an ordinary org-scoped request):** if the same human user is both `is_platform_operator = true` and an org Owner, and they are currently in an **org-scoped** request (e.g., viewing their org's dashboard) rather than a platform-operator-scoped request, `app.platform_operator_verified` is still not set for that transaction (it is only set by the `requirePlatformOperator()` preHandler on platform routes, not globally for the user) — the two contexts do not bleed into each other even for the same person.

---

### AC-22 — Migration is additive-only and safe on an existing, populated instance (D1, D3, D5)

**Given** an existing instance with data in `users`, `organizations`, `vault_state`, etc. (post 9.1/9.2 merge, so `is_platform_operator`/`admin_alerts`/`system_settings` already exist too),
**When** this story's migration runs,
**Then** it only **creates** new objects (`platform_audit_events`, `platform_audit_maintenance_state`, `platform_audit_pending_entries`, `platform_audit_pending_seq`, the two new trigger functions, the RLS policy, the new `vault_state.platform_audit_key_version` column with a `DEFAULT 1`) — it modifies zero existing rows and drops nothing.

**Example (positive):** running the migration against a populated staging DB snapshot completes with zero errors and zero rows changed in any pre-existing table other than the `ALTER TABLE vault_state ADD COLUMN platform_audit_key_version integer NOT NULL DEFAULT 1` (which, being `NOT NULL DEFAULT`, back-fills the single existing row automatically with no manual `UPDATE` needed).

**Example (edge — `checkRlsCoverage()` still passes post-migration):** since `platform_audit_events` has no `org_id` column, it is invisible to the automated gap-scan regardless (D4) — a test explicitly asserts `checkRlsCoverage()` does not throw after this migration, and separately asserts the table appears in `EXCLUDED_TABLES` for documentation purposes even though it isn't strictly required to be there for the check to pass.

**Example (negative — a hypothetical destructive alternative rejected):** this story does **not** attempt any kind of backfill of historical operator actions into `platform_audit_events` for actions that happened before this migration (e.g., 9.1/9.2 actions logged only operationally before 9.4 landed) — there is no reliable source data to reconstruct HMAC-signed rows for pre-migration events, and fabricating them would be worse than an honest gap. This must be stated in Dev Notes as an accepted, permanent gap: operator actions taken between 9.1/9.2's merge and 9.4's merge are only in operational logs, never backfilled into `platform_audit_events`.

---

### AC-23 — Integration test coverage (explicit list — do not consider this story `done` until every item below has a corresponding test)

1. Schema/migration: table exists with exact columns (AC-1); append-only trigger + grant revoke both independently block mutation (AC-2); RLS blocks non-operator-context queries (AC-3, AC-21); migration is additive/idempotent on a populated DB (AC-22).
2. Key lifecycle: `getPlatformAuditKey()` returns a key when unsealed, throws `VaultSealedError` when sealed, key is stable across a reseal/unseal cycle of the same instance (AC-4, AC-5).
3. Write path: `writePlatformAuditEntryOrFailClosed()` writes correctly, redacts forbidden payload keys, aborts the parent transaction on failure when maintenance mode is inactive (AC-6).
4. Retrofit: each of the five 9.1/9.2 action types produces exactly one (or two, for restore) correctly-shaped `platform_audit_events` row, and a no-op settings PUT produces zero rows (AC-7, AC-8).
5. `GET /platform/audit/events`: all filter combinations, pagination bounds, empty-result case, 403 for non-operators (AC-9, AC-10).
6. `GET /platform/audit/verify`: happy path, range-too-large, vault-sealed 503, tampered-row detection, self-audit of the verify call itself (AC-11).
7. `X-Log-Scope` header present on success and error responses (AC-12).
8. Rate limiting: 20 allowed, 21st rejected (AC-13).
9. Maintenance mode: activation happy path, already-active 409, missing-reason 422, bypass-and-queue behavior contrasted directly against the non-maintenance-mode failure path (side-by-side test pair), FIFO drain ordering with activation-event-first, concurrent-drain race protection, deactivate-while-still-broken 503 (AC-14 through AC-16).
10. Retention: env var validation bounds, purge function removes rows older than cutoff and retains newer ones (AC-17).
11. Storage monitoring: `audit-storage:check` extension covers both tables independently (AC-18).
12. Concurrency: N concurrent writes produce N rows, no duplicates/losses (AC-19).
13. Sealed-vault guard applies to every route and to the retrofit write paths, with the one documented maintenance-mode exception (AC-20).

---

## Tasks / Subtasks

- [x] Task 1: Schema, migration, crypto foundation (AC-1, AC-2, AC-3, AC-4, AC-5, AC-22)
  - [x] 1.1 Add `packages/db/src/schema/platform-audit-events.ts`, `platform-audit-maintenance-state.ts`, `platform-audit-pending-entries.ts`
  - [x] 1.2 Add `vault_state.platform_audit_key_version` column to `packages/db/src/schema/vault-state.ts`
  - [x] 1.3 New migration (`0041_platform_audit_events.sql`, next sequence number confirmed against `_journal.json` at implementation time): table DDL, RLS policy, append-only trigger, grant revoke, `platform_audit_pending_seq` sequence, `vault_state` column addition
  - [x] 1.4 Add `platform_audit_events` (and the two support tables) to `packages/db/src/check-rls-coverage.ts`'s `EXCLUDED_TABLES` with an explanatory comment
  - [x] 1.5 Add `getPlatformAuditKey()` + `_platformAuditKey` cache to `apps/api/src/modules/vault/key-service.ts`, wired into `initVault()`/`unsealVault()`
  - [x] 1.6 Add `currentPlatformAuditKeyVersion(tx)` to `apps/api/src/modules/platform-audit/key-version.ts`

- [x] Task 2: Write path and HMAC (AC-6)
  - [x] 2.1 `apps/api/src/modules/platform-audit/write-entry.ts` — `computePlatformAuditHmac()` (reusing `sortKeys` from `modules/audit/write-entry.ts`, not duplicating), `writePlatformAuditEntry()`
  - [x] 2.2 Add `writePlatformAuditEntryOrFailClosed()` + `SameTransactionPlatformAuditWriteError` to `apps/api/src/lib/audit-or-fail-closed.ts`
  - [x] 2.3 Payload redaction reusing `FORBIDDEN_AUDIT_KEYS` from `apps/api/src/lib/secure-route.ts` (plus a dev/test-time throw + production-only silent-strip-and-warn branch, `redactPlatformAuditPayload()`)
  - [x] 2.4 `packages/shared/src/constants/platform-audit-actions.ts` — `PlatformAuditAction` registry

- [x] Task 3: Maintenance mode (AC-14, AC-15, AC-16)
  - [x] 3.1 `apps/api/src/modules/platform-audit/maintenance-mode.ts` — activate/deactivate/drain logic, `SELECT ... FOR UPDATE SKIP LOCKED` guard
  - [x] 3.2 Wire maintenance-mode-aware fallback into `writePlatformAuditEntryOrFailClosed()`

- [x] Task 4: API routes (AC-9 through AC-13, AC-20)
  - [x] 4.1 `apps/api/src/modules/platform-audit/routes.ts` — `GET /platform/audit/events`, `GET /platform/audit/verify`, `POST /platform/maintenance-mode`, all with `requirePlatformOperator: true` + `requireOrgScope: false` + `requireMfa: true` (secure-route.ts's existing flag mechanism, same convention 9.1/9.2 already ship — not the standalone `requirePlatformOperator()` preHandler plugin, which those stories don't actually use either), `X-Log-Scope: platform` header (via a plugin-scoped `onSend` hook so it also covers vaultGuard's pre-handler 503s, AC-20)
  - [x] 4.2 `apps/api/src/modules/platform-audit/schema.ts` — Zod schemas
  - [x] 4.3 `apps/api/src/modules/platform-audit/verify.ts` — `verifyPlatformAuditRange()` (adapted from `modules/audit/verify.ts`; `hmacMatches`/`buildVerifySummary`/`rangeErrorResponse` reused directly from there, not duplicated, to keep `jscpd` clean)
  - [x] 4.4 OpenAPI: `Platform Audit` tag; regenerated spec (`pnpm --filter @project-vault/api generate-spec`)
  - [x] 4.5 `apps/api/src/modules/platform-audit/platform-audit-route-audit.test.ts` — regression guard (AC-10). Deviation: placed alongside the module (mirroring where `platform-admin-route-audit.test.ts` actually lives) rather than under `apps/api/src/__tests__/`, which the story text named but which contradicts its own cited precedent's real location.

- [x] Task 5: Retrofit 9.1/9.2 routes (AC-7, AC-8) — confirmed 9.1/9.2 both merged (`sprint-status.yaml`: both `done`) before starting
  - [x] 5.1 Added `writePlatformAuditEntryOrFailClosed()` calls to all five listed 9.1/9.2 route handlers (`backup.triggered`/`.restore_initiated`/`.restore_completed`/`.restore_failed`/`.validated` in `modules/backup/routes.ts`; `settings.updated` in `modules/platform-admin/service.ts`'s `upsertSystemSettings`; `org.created` in `modules/platform-admin/service.ts`'s `createOrg`)
  - [x] 5.2 No-op-update guard for `PUT /admin/settings` (AC-8 edge case) — reuses the route's existing `Object.keys(update)` `fieldsChanged` computation; a code-review-caliber fix was also needed here: routes that declare a `503` response schema must include vaultGuard's own `{status, message}` shape in that union or its sealed-vault body fails the compiled serializer (silent 500) — fixed on both retrofitted backup routes and this story's own two 503-declaring platform-audit routes

- [x] Task 6: Retention and storage monitoring (AC-17, AC-18)
  - [x] 6.1 `PLATFORM_AUDIT_RETENTION_DAYS`, `PLATFORM_AUDIT_STORAGE_LIMIT_GB` env vars in `apps/api/src/config/env.ts` + `.env.example`
  - [x] 6.2 `purge_expired_platform_audit_entries()` SQL function (migration `0042_platform_audit_retention_purge.sql`, allowlisted in `migration-safety.ts`'s `KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS` alongside 0036's precedent) + `platform-audit/retention` pg-boss daily job (`workers/platform-audit-retention-prune.ts`, wired in `main.ts`)
  - [x] 6.3 Extended `apps/api/src/workers/audit-storage-check.ts` to cover `platform_audit_events` independently (own `platform_audit_storage.warning`/`.critical` alert types, no per-org top-contributors breakdown or fan-out delivery — not applicable to a platform-wide, non-org-scoped table)

- [x] Task 7: Tests (AC-23, full list) — see Debug Log References for exact suite/file counts

---

### Review Findings (bmad-code-review, 2026-07-11)

Reviewed against the merged diff (PR #122). Overall a rigorous implementation (AC-1–22 traced to matching code/tests), but one real finding keeps this story at `review`:

- [x] [Review][Decision] Partial-drain data loss on operator-initiated deactivate — `deactivateMaintenanceMode`/`drainPendingEntries` (`apps/api/src/modules/platform-audit/maintenance-mode.ts`) run the whole drain inside one outer transaction; `deactivateMaintenanceMode` throws `MaintenanceModeStillUnavailableError` whenever any entry remains undrained. That throw rolls back the entire outer transaction, discarding the SAVEPOINT-isolated work already committed for entries that *did* drain successfully — contradicting the code's own "a failed entry is left in place, never silently dropped" guarantee when the queue has a mix of drainable and genuinely-poisoned entries. The opportunistic auto-drain path is unaffected (it never throws). Untested: the existing "still unavailable" test only covers the uniform-failure case (every entry fails, `drained: 0`), not the partial-success case. Needs a design decision: e.g. commit each drained entry outside the outer transaction before evaluating the remaining count, or restructure the failure-reporting so a partial drain's successes are preserved regardless of outcome.
  **Fixed 2026-07-11** (branch `fix/9-4-maintenance-drain-partial-loss`, on top of the already-merged PR #122): `deactivateMaintenanceMode` no longer accepts a caller-supplied `Tx` and runs entirely inside a single outer transaction the caller controls. It now takes the `Db` handle directly and opens its own top-level `db.transaction(...)` around just the `drainPendingEntries` call, which commits unconditionally once the per-entry-SAVEPOINT loop finishes — the decision to throw `MaintenanceModeStillUnavailableError` (when `result.remaining > 0`) happens afterward, outside any transaction, so it can no longer roll back the drain's already-committed work. `routes.ts`'s deactivate handler updated to call `deactivateMaintenanceMode(getDb(), auth.userId)` directly instead of wrapping it in `getDb().transaction(...)`. Added a new TDD test, `deactivateMaintenanceMode preserves a partial drain when the queue has a poisoned entry`, seeding two drainable pending entries and one genuinely-poisoned entry (payload with a forbidden audit key, which throws deterministically on every retry, not just a transient vault-sealed condition) — confirmed red against the old code (all 3 entries survived in the queue after the rollback) and green against the fix (the 2 drainable entries are durably gone from `platform_audit_pending_entries` and present in `platform_audit_events` with `recordedRetroactively: true`, even though the call still rejects with `MaintenanceModeStillUnavailableError` for the 1 poisoned entry and `active` stays `true`). Confirmed the opportunistic auto-drain path (`writePlatformAuditEntryOrFailClosed` → `drainPendingEntries(tx, ...)`) is unaffected — it already ran inside the *triggering action's* own transaction and never throws, so this restructuring only touches the operator-initiated deactivate path. Full `maintenance-mode.test.ts` (10/10), the full `platform-audit`/`audit-or-fail-closed` suite (11 files/83 tests), and `make ci` (typecheck, lint, migrate, full test suite incl. `apps/api` 203/203, jscpd, openapi.json freshness) all green.

Two items intentionally left as `defer` (pre-existing, not introduced by this diff, already documented in this story's own Dev Notes/Open Questions): Story 9.1's backup/restore routes lacking `requireMfa: true`; architecture/PRD docs still describing "cryptographic chaining" instead of the shipped per-row HMAC mechanism.

**Status: `done`** — the decision-needed finding above is resolved and verified.

## Dev Notes

### Architecture Compliance

- Follows the sealed-route/opt-out-not-opt-in principle established by Stories 9.1/9.2: all three new routes use `requireOrgScope: false` as an explicit named flag.
- Reuses the existing `admin_alerts` table for the new storage-pressure alert type (D10) rather than inventing a second alert table — same discipline Story 9.2 already applied for its own new alert types.
- Reuses `HKDF_INFO.PLATFORM_AUDIT` (already reserved in `packages/crypto/src/kdf.ts`), `computeAuditHmac`'s `sortKeys` canonicalization approach, `FORBIDDEN_AUDIT_KEYS`, and the `VaultSealedError` class — this story adds one genuinely new signing-key lifecycle (D3) but no new cryptographic *primitives*.
- Departs from `architecture.md`'s and `prd.md`'s "cryptographic chaining" language for audit tamper-evidence — the actual, shipped Story 8.1 mechanism (and this story's platform equivalent) is per-row HMAC, not a hash chain. This is a pre-existing documentation drift (not introduced by this story) that should be flagged for a documentation-fix pass; this story's own Dev Notes state the accurate mechanism explicitly so a future reader is not misled by the stale architecture doc.
- `architecture.md` has no concept of a "platform operator" role at all (confirmed by full-document search) — the entire `is_platform_operator`/`requirePlatformOperator()` model is defined in Stories 9.1/9.2's dev-story files, not architecture.md. This story inherits that model as-is; it does not redefine or extend the authorization primitive itself.

### Project Structure Notes

- New backend module: `apps/api/src/modules/platform-audit/` — a sibling to (not nested inside) `modules/platform-admin/` (9.2) and `modules/audit/` (8.1/8.2), mirroring how the org-scoped codebase already separates `modules/audit/` from `modules/admin/`.
- New schema files: `packages/db/src/schema/platform-audit-events.ts`, `platform-audit-maintenance-state.ts`, `platform-audit-pending-entries.ts`; modification to the existing `packages/db/src/schema/vault-state.ts` (add `platform_audit_key_version`).
- Modification to existing files (once they exist per D1): `apps/api/src/modules/vault/key-service.ts` (add `getPlatformAuditKey`), `apps/api/src/lib/audit-or-fail-closed.ts` (add `writePlatformAuditEntryOrFailClosed`), `apps/api/src/config/env.ts` + `.env.example` (new env vars), the five retrofitted 9.1/9.2 route files, `apps/api/src/workers/audit-storage-check.ts`.
- New shared constant: `packages/shared/src/constants/platform-audit-actions.ts`.
- No `apps/web` changes in this story (API-only surface — see Product Surface Contract).

### Testing Standards Summary

- Vitest across all packages; this story's logic is entirely platform-level (no `org_id` on the core table), so most tests query `platform_audit_events`/`platform_audit_maintenance_state`/`platform_audit_pending_entries` directly rather than using `withTestOrg()` — except AC-8's `targetOrgId` assertions, which do need a real org created via `withTestOrg()` or the org-creation retrofit path itself.
- A `createPlatformOperator(app, ...)` test helper will need to be added (no existing helper does this yet, since `is_platform_operator` doesn't exist in code as of this story's writing) — mint a user, directly `UPDATE users SET is_platform_operator = true` via `getDb()`, then issue a session the same way `createDirectAuthenticatedUser()` does. If Story 9.1's own dev-story run already added this helper, reuse it rather than duplicating.
- `platform-audit-route-audit.test.ts` (or folded into a broader platform-route-audit suite alongside 9.2's) must assert `requireOrgScope: false` + `requireMfa: true` + no `allowedRoles` on every route in `modules/platform-audit/`.
- `check-rls-coverage.test.ts` must continue to pass with the new table excluded/documented (AC-22).
- Per the codebase's critical test-isolation gotcha (`packages/db/src/test-helpers.ts`): `platform_audit_events` is append-only exactly like `audit_log_entries` — any test that inserts a "tampered" row for the verify-endpoint tests must do so inside a transaction that is explicitly rolled back before the test ends, or it will permanently poison subsequent "clean database" test runs against that Postgres instance.

### Previous Story Intelligence

**Story 9.1 (Encrypted Backup & Restore, `ready-for-dev`, not yet `done`):**
- Defines `users.is_platform_operator`, `requirePlatformOperator()`, `admin_alerts` — this story's hard, load-bearing dependency (D1). If picked up before 9.1 merges, this story cannot proceed past Task 1 without first implementing 9.1's own Task 1/2.
- 9.1's D6 (interim operational-logging pending this story) and its own adversarial-review finding #2 (critical: whole-instance restore has zero tamper-evident audit trail today) are the direct justification for this story's existence and its AC-7 retrofit of the restore route specifically.
- 9.1's adversarial-review finding #3 (no filename validation on `:filename`) — this story's AC-7 payload must reuse whatever sanitization 9.1 ends up applying, not silently trust an unsanitized filename into an immutable audit payload.
- 9.1's adversarial-review finding #13 (ambiguous whether `isPlatformOperator` is a live DB lookup or baked into the JWT) — if the JWT-baked interpretation is what 9.1 ships, this story's audit rows should be understood as recording "the operator claim asserted by the JWT at request time," not necessarily "verified against the current DB state at that exact instant." Worth a one-line caveat if this ambiguity is still unresolved when 9.4 is implemented.

**Story 9.2 (System Settings, Multi-Org & Resource Monitoring, `ready-for-dev`, not yet `done`):**
- Defines `modules/platform-admin/`, the six settings/orgs/resource-usage routes, `audit-storage:check` job, `system_settings` table — this story's second load-bearing dependency (D1).
- 9.2's AC-25/Open Question #5 is the direct, explicit forward-reference that created this story's AC-8 and AC-18 scope — 9.2's own text says almost verbatim what this story must do.
- 9.2's D10 (maintenance-mode circuit breaker for the *org-scoped* log, storage-triggered) is the direct design precedent this story's D8 (operator-triggered, for the *platform* log) deliberately parallels — same allowlist/suspend/resume shape, different trigger and different table.
- 9.2's Open Question #7 (per-org audit-storage rate limiting, candidate for bundling into this story) was **not** bundled in here — it concerns the org-scoped log's storage growth attribution, not this story's platform-scoped concern; left as a separate future item, not silently dropped.

### Git Intelligence (Recent Commits)

- Recent commits in this worktree (`47db7fa`, `fc23596`, `0fb32b3`, `c8ae06b`, `0ffc395`) are merges of Stories 9.2 and 8.5's planning/dev-story documents, not code — no commit yet touches `packages/db/src/schema/platform-audit-events.ts`, `apps/api/src/modules/platform-audit/`, or `apps/api/src/modules/vault/key-service.ts`'s `getPlatformAuditKey`. This is greenfield within an otherwise mature codebase, same as Stories 9.1/9.2's own greenfield notes.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 9.4: Platform Operator Audit Log] (lines 2095-2122) — the literal AC text this story's ACs formalize with examples; also the Epic 9 header (PJ9 cross-log-search boundary, AC-E9d key-custody trigger — not this story's concern but shares the epic).
- [Source: _bmad-output/implementation-artifacts/8-1-tamper-evident-audit-log-with-hmac-integrity.md] — the org-scoped audit log's design this story's platform-scoped equivalent mirrors (HMAC mechanism, fail-closed invariant, verify-endpoint bounds).
- [Source: apps/api/src/modules/audit/write-entry.ts, verify.ts, human-entry.ts, key-version.ts] — actual shipped code for `computeAuditHmac`, `verifyAuditRange`, `writeHumanAuditEntry`, `currentAuditKeyVersion` — the concrete precedents this story's platform-scoped analogues are built from.
- [Source: apps/api/src/lib/audit-or-fail-closed.ts] — `writeHumanAuditEntryOrFailClosed`/`SameTransactionAuditWriteError` — the fail-closed pattern this story extends with `writePlatformAuditEntryOrFailClosed`/`SameTransactionPlatformAuditWriteError`.
- [Source: packages/crypto/src/kdf.ts] — `HKDF_INFO.PLATFORM_AUDIT`, already reserved for this story.
- [Source: apps/api/src/modules/vault/key-service.ts] — `getAuditKey`/`VaultSealedError`/`initVault`/`unsealVault` — the exact pattern `getPlatformAuditKey` mirrors.
- [Source: packages/db/src/schema/platform-security-events.ts, migrations/0006_platform_security_events.sql] — the closest existing precedent for a platform-level, non-org-scoped, HMAC-signed, append-only table (D2), though notably without a trigger (D5 adds one here for stronger enforcement).
- [Source: packages/db/src/migrations/0001_rls_and_triggers.sql, 0002_audit_log_revoke.sql] — the exact append-only trigger + grant-revoke pattern (D5) this story's migration reproduces for `platform_audit_events`.
- [Source: packages/db/src/check-rls-coverage.ts] — `EXCLUDED_TABLES`/`checkRlsCoverage` — this story's D4 RLS design and why the automated check does not (and need not) flag this table.
- [Source: _bmad-output/implementation-artifacts/9-1-encrypted-backup-and-restore.md] — D1 (platform-operator primitive), D3 (`admin_alerts`), D6/Open Question #4 (explicit forward-reference to this story for backup/restore audit coverage), adversarial-review findings #2/#3/#13.
- [Source: _bmad-output/implementation-artifacts/9-2-system-settings-multi-org-and-resource-monitoring.md] — D2 (`modules/platform-admin/` separation convention this story's `modules/platform-audit/` also follows), D10 (maintenance-mode precedent for this story's D8), AC-25/Open Question #5 (explicit forward-reference to this story), adversarial-review's open storage-monitoring-coverage finding (D10 in this story's numbering).
- [Source: _bmad-output/planning-artifacts/architecture.md] (Data Architecture, Authentication & Security, API & Communication Patterns, Naming Patterns, Structure Patterns sections) — RLS/session-variable convention, module structure convention, migration convention, rate-limiting convention; also documents the "cryptographic chaining" language this story's actual mechanism (D6) deliberately does not follow (matching the already-shipped Story 8.1 code instead).
- [Source: _bmad-output/planning-artifacts/prd.md] (lines 923-932, 1012, 1027-1028, 1042) — FR40/41/70/78 (org-scoped audit requirements this story's platform equivalent parallels), audit-completeness/immutability NFRs. Note: FR103/FR109 (cited by epics.md for this story) do not appear in prd.md itself — prd.md was frozen at "95 FRs" before epics.md's later FR catalog extension; this is a pre-existing documentation drift, not something this story can resolve, but worth flagging at a future PRD/epics reconciliation pass.
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md] (lines 199-204) — "verification-first, non-cryptographer-legible output" principle from the per-org audit log's compliance-officer journey, cited as the design precedent a future Platform Operator Audit Log UI should follow (no UI exists in this story itself).
- [Source: _bmad-output/implementation-artifacts/product-surface-contract.md] — Product Surface Contract rules (G1-G4) applied above.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude (claude-sonnet-4.5), via Claude Code dev-story workflow

### Debug Log References

- `packages/db` new/changed suites: `platform-audit-schema.test.ts`, `platform-audit-events-immutability-and-rls.test.ts`, `platform-audit-retention-purge.test.ts` — all green
- `apps/api` new `modules/platform-audit/` suite (key-version, write-entry ×3 files, maintenance-mode, verify, routes, route-audit) + `modules/vault/platform-audit-key.test.ts` + `lib/audit-or-fail-closed.platform-audit.test.ts` + `workers/platform-audit-retention-prune.test.ts`: all green
- Retrofit regressions: `modules/backup/backup.routes.test.ts` (12/12), `modules/platform-admin/settings-routes.test.ts` (12/12), `modules/platform-admin/orgs-routes.test.ts` (11/11), `workers/audit-storage-check.test.ts` (8/8) — all green, including new Story 9.4 assertions
- `pnpm turbo typecheck`: clean (2 pre-existing, unrelated `@project-vault/agent` module-resolution errors present before this story, from an unbuilt sibling package)
- `pnpm jscpd`: 0 clones (initial pass flagged 5 — 3 from the new platform-audit module duplicating org-scoped audit logic byte-for-byte, 2 from `key-service.ts`'s init/unseal key-derivation blocks crossing the clone-size threshold once a 4th key was added; resolved via direct reuse — `hmacMatches`/`buildVerifySummary`/`rangeErrorResponse` now exported from `modules/audit/verify.ts` and imported by `modules/platform-audit/verify.ts` instead of being reimplemented, and two new `key-service.ts` helpers, `zeroSecondaryKeys()`/`commitUnsealedKeys()`, shared between `initVault()`/`unsealVault()`)
- `make check-rls`, `pnpm check-migration-compatibility`, `pnpm tsx scripts/check-env-example.ts`, `pnpm check-search-index`, `pnpm check-alert-pending-epic3`, `pnpm tsx scripts/check-audit-baseline.ts`, `pnpm check-audit-actor-token-coverage`: all passing
- `pnpm turbo lint`: clean, 0 errors (fixed 15 real lint errors introduced by this story's new files: `sonarjs/no-duplicate-string`, `@typescript-eslint/no-non-null-assertion`, one `complexity` violation in the retrofitted restore-route handler, resolved by extracting `handleRestoreOutcome()`)
- `apps/api/src/__tests__/route-audit.test.ts`: found and fixed 2 real regressions this story's new code caused — the 3 new `/api/v1/platform/*` routes needed `ROUTE_ACTION_CLASSIFICATIONS` entries, and `modules/backup/routes.ts`/`modules/platform-audit/routes.ts`'s new direct `getDb()` imports (needed since these are `requireOrgScope: false` routes with no `secureCtx.tx`) needed `DIRECT_DB_ACCESS_CLASSIFICATIONS` entries
- **Full clean `apps/api` regression run** (`npx vitest run`, isolated — no other process touching the shared dev DB concurrently): **187 test files (184 passed), 1655 tests (1648 passed)**. The 3 "failed" files are: 2 pre-existing, unrelated `@project-vault/agent` module-resolution failures (present before this story, from an unbuilt sibling package never built in this worktree) and `modules/platform-admin/orgs-routes.test.ts` (7 failing tests). Root-caused the orgs-routes failures via an isolated repro script: `allocateOrganizationSlug`'s `MAX_SLUG_ATTEMPTS = 5` retry budget was exhausted because this story's long TDD session ran `orgs-routes.test.ts`'s AC-23 race test (which creates real, never-cleaned-up orgs literally named "Org A"/"Org B") more than 5 times against the same persistent shared dev Postgres instance, producing `org-a`, `org-a-2`...`org-a-5`, `org-b`, `org-b-2`...`org-b-5` — a genuine, pre-existing test-design gap (static org names in a test not designed for repeated runs against a persistent DB) exposed by this story's unusually long implementation session, not a regression in any Story 9.4 code. Confirmed via a standalone script reproducing the identical `409 org_name_unavailable` against the *unmodified* `createOrg()` retry path. Every platform-audit-specific test file (the entire new `modules/platform-audit/` suite, both retrofit files, `audit-storage-check.test.ts`, `platform-audit-key.test.ts`, `audit-or-fail-closed.platform-audit.test.ts`, `platform-audit-retention-prune.test.ts`) passed with zero failures in this same full run.
- Two real bugs were caught and fixed specifically because of this full-suite run (not visible from isolated single-file runs — see Completion Notes): the opportunistic-drain auto-deactivation bug, and an `audit-storage-check.test.ts` test-isolation bug where this story's own new AC-18 tests called `runAuditStorageCheck()` without a platform-specific limit override, inadvertently re-triggering the *org-scoped* `audit_storage.critical` alert and leaving it active for the rest of the suite (fixed by widening that describe block's `afterAll` to clear both alert families, and by adding a dedicated `platformLimitGbOverride` parameter to `runAuditStorageCheck()` so the two thresholds can be exercised independently going forward)

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide for Story 9.4 covering: a hard sequencing dependency on Stories 9.1 AND 9.2 both being merged, not just story-created (D1); a table-naming decision reconciling epics.md's literal name against the shipped codebase's actual conventions by anchoring to the `platform_security_events` precedent rather than `audit_log_entries` (D2); wiring up an already-reserved-but-unconsumed HKDF info string into a full key lifecycle mirroring the existing org-scoped audit key exactly (D3); a novel but consistent RLS design for a table with no `org_id` column, using a session-variable-gated policy as defense-in-depth alongside the application-layer platform-operator check (D4); a stronger-than-precedent append-only enforcement given this table's compliance-grade purpose (D5); an explicit correction of stale "hash chain" language in architecture.md/PRD against the actual, shipped per-row-HMAC mechanism (D6); a precisely scoped retrofit of exactly which not-yet-built Story 9.1/9.2 route handlers this story must edit once they exist (D7); a fully-specified maintenance-mode/retroactive-recording mechanism satisfying epics.md's three-part literal requirement including the tricky "activation event recorded first" ordering constraint via a self-consistent FIFO-queue design (D8); and closure of two forward-references Stories 9.1 and 9.2 explicitly left for this story (D7 backup/restore + settings/org-creation audit coverage, D10 storage-monitoring extension).

- **Implementation completed via TDD red-green (dev-story pass), Tasks 1-7 in order.** Both prerequisite stories (9.1, 9.2) were confirmed `done` in `sprint-status.yaml` before starting, exactly as D1 required. Key findings and deviations discovered during implementation:
  - **Opportunistic-drain bug caught by the route-level test, not the unit test (AC-14/AC-16).** The first `drainPendingEntries()` implementation unconditionally deactivated maintenance mode and wrote a fresh `maintenance_mode.deactivated` row whenever it found `active: true`, even with an EMPTY pending queue — meaning the very act of activating maintenance mode (which itself triggers the opportunistic drain check after its own successful audit write) immediately auto-deactivated it again. Unit tests in `maintenance-mode.test.ts` didn't catch this because they always queued something before draining; the full-route test (`POST /platform/maintenance-mode` twice, expecting 409 on the second call) caught it immediately. Fixed by only deactivating when `drained > 0`, and adding a `deactivateMaintenanceMode()` fallback path (`forceDeactivateWithFreshWrite()`) so an operator's *explicit* deactivate call still works even with nothing ever queued (AC-14's "proactive activation" case). Both the regression and the fix are covered by dedicated tests.
  - **A route declaring a `503` response schema must include vaultGuard's own sealed-vault body shape in that union, or the response fails to serialize.** `vaultGuard`'s global `onRequest` hook sends `{status: 'sealed', message: '...'}` before any route handler runs whenever the vault is sealed — but Fastify still compiles a response serializer per declared status code once routing has matched. Adding a bare `503: ApiErrorSchema` (`{code, message}`) to the retrofitted backup restore/validate routes and this story's own two 503-declaring platform-audit routes caused vaultGuard's `{status, message}` body to fail that serializer, surfacing as an opaque `500` instead of the intended `503` — caught by the pre-existing `AC-16`/`AC-20` sealed-vault regression tests going red unexpectedly. Fixed by unioning `VaultSealedResponseSchema` into every such `503` declaration (mirroring the pattern `backup/routes.ts`'s trigger route already used correctly).
  - **Cross-file HMAC-key collision risk in verify tests against a shared, non-tenant-scoped table.** Unlike the org-scoped audit log (isolated per test by `orgId` + RLS), `platform_audit_events` has no tenant scope — every test file that unseals its own independently-keyed vault instance writes into the SAME physical table. A verify test using a real wall-clock time window (e.g. "now ± 1 minute") risks picking up another test file's genuinely-valid-under-a-different-key rows and misreporting them as tampered. Worked around by scoping the happy-path verify test's window tightly to the exact row just written (via its own returned `createdAt`), rather than an ambient time window — a genuine test-design gotcha for any future test against this table, now documented in `verify.test.ts`.
  - **AC-11's audit-of-the-auditor row and AC-8's settings/org-creation retrofit both landed exactly as specified** — no deviation from the literal AC text.
  - **9.1's backup/restore routes have no `requireMfa: true`** (confirmed by reading the already-merged `modules/backup/routes.ts`), unlike 9.2's settings/orgs routes and this story's own three new routes. This is a pre-existing 9.1 characteristic, not something this story's retrofit changes or is in scope to fix.
  - `packages/shared/src/constants/operational-event-types.ts` gained two new events (`PLATFORM_AUDIT_RETENTION_PRUNE_SUMMARY`, `PLATFORM_AUDIT_STORAGE_CHECK_FAILED`) for the retention-prune and storage-check workers' own operational logging — distinct from, and never written to, `platform_audit_events` itself.
  - Accepted, explicitly-scoped test gap: `POST /admin/backups/:filename/restore`'s `backup.restore_completed`/`backup.restore_failed` retrofit code paths are implemented, but the `restored`/`restore_failed` outcomes themselves are not exercised end-to-end via a real successful `pg_restore` over HTTP in this story's route-level tests — this mirrors a pre-existing gap in the inherited test suite (no test in this codebase drives a real successful restore via HTTP either, given the complexity/danger of doing so against a shared dev database; `service.test.ts`'s own AC-9 coverage exercises `restoreFromBackup()` directly with an injected fake `restore` dependency instead). `AC-7`'s `backup.restore_initiated` write (which always fires, regardless of outcome) IS covered via HTTP. `AC-16`'s concurrent-drain-race `SKIP LOCKED` behavior IS covered with a genuine two-connection simulation (a raw second Postgres connection holds the row lock via `FOR UPDATE` while the code under test attempts a `skipLocked: true` drain and observes `{skipped: true}`).

### File List

**New files:**
- `packages/db/src/schema/platform-audit-events.ts`, `platform-audit-maintenance-state.ts`, `platform-audit-pending-entries.ts`, `platform-audit-schema.test.ts`
- `packages/db/src/migrations/0041_platform_audit_events.sql`, `0042_platform_audit_retention_purge.sql`
- `packages/db/src/__tests__/platform-audit-events-immutability-and-rls.test.ts`, `platform-audit-retention-purge.test.ts`
- `packages/shared/src/constants/platform-audit-actions.ts` + `.test.ts`
- `apps/api/src/modules/platform-audit/` (new module): `key-version.ts` + `.test.ts`, `write-entry.ts` + `.test.ts` + `write-entry-integration.test.ts` + `write-entry-concurrency.test.ts`, `maintenance-mode.ts` + `.test.ts`, `verify.ts` + `.test.ts`, `routes.ts` + `.test.ts`, `schema.ts`, `platform-audit-route-audit.test.ts`
- `apps/api/src/modules/vault/platform-audit-key.test.ts`
- `apps/api/src/lib/audit-or-fail-closed.platform-audit.test.ts`
- `apps/api/src/workers/platform-audit-retention-prune.ts` + `.test.ts`

**Modified files:**
- `packages/db/src/schema/vault-state.ts` (`platform_audit_key_version` column), `schema/index.ts` (new exports), `check-rls-coverage.ts` (`EXCLUDED_TABLES`), `index.ts` (`withPlatformOperatorContext`), `lib/migration-safety.ts` (`KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS` entry for migration 0042), `migrations/meta/_journal.json`
- `packages/shared/src/constants/operational-event-types.ts` (two new events), `src/index.ts` (new export), `openapi.json` (regenerated)
- `apps/api/src/modules/vault/key-service.ts` (`getPlatformAuditKey()`/`_platformAuditKey`, wired into `initVault()`/`unsealVault()`/`zeroKeys()`; `zeroSecondaryKeys()`/`commitUnsealedKeys()` extracted to keep `jscpd` clean after the 4th key)
- `apps/api/src/lib/audit-or-fail-closed.ts` (`writePlatformAuditEntryOrFailClosed()`, `SameTransactionPlatformAuditWriteError`)
- `apps/api/src/lib/secure-route.ts` (exported `FORBIDDEN_AUDIT_KEYS`, `isForbiddenAuditKey`, `sanitizeAuditPayload` for reuse)
- `apps/api/src/modules/audit/write-entry.ts` (exported `sortKeys`), `apps/api/src/modules/audit/verify.ts` (exported `hmacMatches`, `rangeErrorResponse`; both also reused by the org-scoped route below)
- `apps/api/src/modules/audit/routes.ts` (dedup: uses the new `rangeErrorResponse()` helper)
- `apps/api/src/modules/backup/routes.ts` (AC-7 retrofit: `backup.triggered`/`.restore_initiated`/`.restore_completed`/`.restore_failed`/`.validated` platform-audit writes; 503 response-schema fix for the sealed-vault serialization bug) + `backup.routes.test.ts` (new AC-7 assertions)
- `apps/api/src/modules/platform-admin/service.ts` (AC-8 retrofit: `settings.updated`/`org.created` platform-audit writes, `createOrg()`'s new `CreateOrgOptions` signature), `settings-routes.ts`/`orgs-routes.ts` (pass `req`/operator context through) + their `.test.ts` files (new AC-8 assertions)
- `apps/api/src/config/env.ts` + `.env.example` (`PLATFORM_AUDIT_RETENTION_DAYS`, `PLATFORM_AUDIT_STORAGE_LIMIT_GB`)
- `apps/api/src/workers/audit-storage-check.ts` (extended to cover `platform_audit_events` independently) + `.test.ts` (new AC-18 assertions)
- `apps/api/src/main.ts` (`platform-audit/retention` schedule + worker registration)
- `apps/api/src/app.ts` (`platformAuditRoutes` registered under `/api/v1/platform`)
- `apps/api/src/lib/route-exemptions.ts` (`ROUTE_ACTION_CLASSIFICATIONS` entries for the 3 new platform-audit routes and updated auditOmissionReason text for the 5 retrofitted 9.1/9.2 routes; `DIRECT_DB_ACCESS_CLASSIFICATIONS` entries for `modules/backup/routes.ts` and `modules/platform-audit/routes.ts`'s new direct `getDb()` imports)

### Change Log

- 2026-07-07: Implemented Story 9.4 end-to-end via TDD red-green (Tasks 1-7): `platform_audit_events`/`platform_audit_maintenance_state`/`platform_audit_pending_entries` schema + migration with RLS, append-only trigger, and grant revoke (AC-1-AC-5, AC-22); `getPlatformAuditKey()` key lifecycle wired into `initVault()`/`unsealVault()` (D3); `writePlatformAuditEntry()`/`writePlatformAuditEntryOrFailClosed()` with payload redaction and the fail-closed invariant (AC-6); maintenance-mode activate/deactivate/FIFO-drain mechanism satisfying epics.md's three-part literal requirement (AC-14-AC-16, D8); three new `/api/v1/platform/*` routes with `X-Log-Scope: platform` header and platform-operator+MFA gating (AC-9-AC-13, AC-20); retrofitted `platform_audit_events` writes into all five 9.1/9.2 route handlers (AC-7, AC-8); daily retention-prune job + independent storage-monitoring extension (AC-17, AC-18); concurrency coverage (AC-19). Fixed three implementation bugs caught by tests during this pass: an opportunistic-drain bug that auto-deactivated maintenance mode immediately after activation when nothing was queued; a response-schema gap that caused vaultGuard's sealed-vault body to fail serialization (silent 500) on any route declaring a bare `503: ApiErrorSchema`; and a test-isolation bug in this story's own `audit-storage-check.test.ts` additions that leaked an active `audit_storage.critical` alert into the rest of the suite. `pnpm jscpd` reduced to 0 clones by reusing `hmacMatches`/`buildVerifySummary`/`rangeErrorResponse`/`validateVerifyRange`/`finalizeVerifyResult` from the org-scoped `modules/audit/verify.ts` and extracting two small helpers in `key-service.ts`. Fixed 15 real `pnpm turbo lint` errors and 2 `route-audit.test.ts` classification-registry regressions this story's new code triggered. Final full, isolated `apps/api` regression run: 187 files (184 passed)/1655 tests (1648 passed) — the 3 "failed" files are 2 pre-existing unrelated `@project-vault/agent` build-resolution failures plus `orgs-routes.test.ts`, whose 7 failures are a confirmed pre-existing shared-DB slug-collision artifact from this session's own repeated manual test invocations (root-caused via an isolated repro against unmodified `createOrg()` code), not a Story 9.4 regression — every platform-audit-specific test file passed with zero failures. See Dev Agent Record's Completion Notes and Debug Log References for full detail.
