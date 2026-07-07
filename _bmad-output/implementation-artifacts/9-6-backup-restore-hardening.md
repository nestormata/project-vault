# Story 9.6: Backup & Restore Hardening

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Ultimate context engine analysis completed 2026-07-07 — this story bundles Story 9.1's ("Encrypted Backup & Restore", done) 3 unresolved high-severity code-review findings, exactly the pattern Story 8-5 used to bundle 5.4's unresolved findings. It closes 3 independent gaps in the already-shipped `apps/api/src/modules/backup/` module: (1) no concurrency guard on restore itself; (2) `backup.missed` admin_alerts never auto-resolve; (3) AC-6's S3-upload-failure negative case (local staging/retry/orphan-cleanup) was never implemented. This story is fully self-contained — it pulls forward every fact from Story 9.1 a developer needs, so implementing it does not require opening 9-1's story file. -->

## Story

As a **platform operator relying on Story 9.1's encrypted backup/restore system**,
I want **restore to be safely serialized against a concurrent restore or an in-flight backup dump, `backup.missed` alerts to clear automatically once backups start succeeding again, and S3 upload failures to leave a locally recoverable file instead of silently losing the backup**,
so that **the backup/restore subsystem is actually safe to depend on during a real incident, not just correct on the happy path**.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story hardens existing internal behavior (a lock inside an existing route handler, a worker's alert-resolution branch, a storage-write code path) behind the same four Story 9.1 endpoints. No new HTTP endpoint, no new request/response shape visible to a client beyond one new `409` case on an already-`409`-capable route family. |
| **Linked UI story** (if API-only) | `TBD` — same accepted gap as Story 9.1 (see 9-1's Product Surface Contract): no story in `epics.md` scopes a backup/restore admin web screen. This story does not change that; it does not add new UI-relevant surface (no new fields for a future "Backups" page to render — `admin_alerts.status` transitioning to `'acknowledged'` on auto-resolve is an existing status value a future UI would already need to render). |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is deferred with a placeholder; same as 9-1. |
| **Persona journey** | N/A — API-only, no new persona journey; the platform operator's existing curl/scripts-based interaction from Story 9.1 (AC-1 through AC-19) is unchanged in shape, only hardened in behavior. |

### Persona journey stub

N/A — internal hardening story, no new user-facing surface. Rationale: see Product Surface Contract row above.

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** It resolves the "needs a decision" items Story 9.1's Dev Agent Record explicitly left open. Every fact below was verified against the actual code in this worktree, not just epics/story prose.

### D1 — Restore's concurrency guard reuses backup's existing advisory-lock key via a session-reserved connection; no new schema

**Current state (verified in `apps/api/src/modules/backup/service.ts`):**
- `acquireBackupSlot()` (AC-7, already shipped) guards backup-trigger concurrency with `pg_try_advisory_xact_lock(hashtext('backup/snapshot'))` — **transaction-scoped**, held only for the brief "check no `backup_runs` row is `running`, then insert one" critical section. The inserted row's `status = 'running'` is the actual long-lived marker other backup triggers check against. `reconcileStaleRunningBackups()` resets any row still `running` at process startup (crash recovery for that row).
- `restoreFromBackup()` has **zero** concurrency guard today — it decrypts and calls `runPgRestore(requireBackupDatabaseUrl(), plainSql)` with nothing preventing a second, simultaneous call to `restoreFromBackup()`, or a `backup:snapshot` job's `pg_dump` subprocess, from running against the same `BACKUP_DATABASE_URL` at the same time.
- Restore is **synchronous within a single HTTP request** (`POST /admin/backups/:filename/restore` returns `200 { restored: true }` directly — unlike backup-trigger's `202 { jobId }` fire-and-forget). This means restore's entire risk window is scoped to one request/handler invocation, which a **held-for-the-whole-duration** lock fits naturally (backup's brief xact-lock pattern does NOT fit restore, because restore has no equivalent "row that stays `running`" to lean on for the long tail — see rejected alternative below).

**Resolution — session-scoped advisory lock, same key, held for the whole restore:**

1. PostgreSQL advisory locks share **one keyspace** across session-level and transaction-level flavors: a session-level `pg_advisory_lock`/`pg_try_advisory_lock` held by one connection **will** block another connection's `pg_try_advisory_xact_lock` attempt on the same key, and vice versa (documented Postgres behavior — same lock table, different release semantics). This means restore holding a session-level lock on `hashtext('backup/snapshot')` for its whole duration automatically makes `acquireBackupSlot()`'s existing `pg_try_advisory_xact_lock` call on that same key fail — **zero changes needed to `acquireBackupSlot()` itself** to block a new backup trigger while a restore is running.
2. The reverse direction (restore must not start while a backup dump is already mid-flight) needs one explicit check: after acquiring the session lock, restore must check for an existing `backup_runs` row with `status = 'running'` — because `acquireBackupSlot()`'s own xact-lock is only held for its brief check-then-insert window, not for the dump's full duration; a backup that started (and inserted its `running` row) *before* restore attempted the lock will already have released that brief xact-lock by the time restore checks, so restore's own lock-acquisition would otherwise succeed even though a dump is genuinely in flight. This second check closes that gap.
3. **New DB helper required:** `getDb()` (`packages/db/src/index.ts`) uses the `postgres` npm package (`postgres-js`), not `node-postgres` — it exposes `sql.reserve()`, which checks out a **single dedicated connection** from the pool for exclusive use until explicitly released (`reserved.release()`). This is required for a session-level advisory lock: acquiring it on a connection borrowed from a normal pooled query and then returning that connection to the pool without unlocking would leak the lock onto a connection some *other* unrelated query later reuses — poisoning the pool. Add a new exported helper in `packages/db/src/index.ts`:
   ```typescript
   // Returns a single reserved connection (postgres-js `sql.reserve()`) for operations that need
   // session-scoped state (advisory locks) to persist across multiple statements — never share a
   // reserved connection with pooled queries. Caller MUST call `.release()` when done (finally block).
   export async function reserveConnection() {
     const pgClient = getRawPgClient() // internal accessor to the module-level `postgres()` client
     return pgClient.reserve()
   }
   ```
   (Refactor the private `pgClient` currently local to `getDb()`'s closure into a module-level `let _pgClient` so both `getDb()` and `reserveConnection()` share the same underlying `postgres()` instance/pool — do not create a second, separate `postgres()` client.)
4. New functions in `apps/api/src/modules/backup/service.ts`:
   ```typescript
   export type RestoreLockResult =
     | { ok: true; release: () => Promise<void> }
     | { ok: false; reason: 'restore_in_progress' | 'backup_in_progress' }

   export async function acquireRestoreLock(): Promise<RestoreLockResult> {
     const reserved = await reserveConnection()
     const [{ locked }] = await reserved`SELECT pg_try_advisory_lock(hashtext(${BACKUP_ADVISORY_LOCK_KEY})) AS locked`
     if (!locked) {
       await reserved.release()
       return { ok: false, reason: 'restore_in_progress' }
     }
     // AC-3: close the reverse race — a backup dump already mid-flight (its own brief xact-lock
     // window has already closed by now) must still block restore.
     const [running] = await getDb().select({ id: backupRuns.id }).from(backupRuns).where(eq(backupRuns.status, 'running')).limit(1)
     if (running) {
       await reserved`SELECT pg_advisory_unlock(hashtext(${BACKUP_ADVISORY_LOCK_KEY}))`
       await reserved.release()
       return { ok: false, reason: 'backup_in_progress' }
     }
     return {
       ok: true,
       release: async () => {
         await reserved`SELECT pg_advisory_unlock(hashtext(${BACKUP_ADVISORY_LOCK_KEY}))`
         await reserved.release()
       },
     }
   }
   ```
5. `routes.ts`'s restore handler wraps its existing call to `restoreFromBackup()` with `acquireRestoreLock()` first; on `{ ok: false }`, return `409` before any decrypt/checksum work happens (cheapest possible rejection). On `{ ok: true }`, call `restoreFromBackup()` inside a `try { ... } finally { await lock.release() }` so the lock is released on **every** exit path (`not_found`, `checksum_mismatch`, `decrypt_failed`, `restore_failed`, `restored`).
6. **No reconciliation code needed for this lock** (unlike `reconcileStaleRunningBackups()` for the `backup_runs` row): a session-level advisory lock is automatically released by PostgreSQL itself the instant the holding connection closes — including a hard process crash/kill, which drops the TCP connection and the server-side backend cleans up that session's locks. This is different from `backup_runs.status='running'`, which is a *persisted row*, not a *live connection state* — that's precisely why it needed its own reconciliation function and this lock does not. Document this contrast in a code comment so a future reader doesn't "fix" a non-problem by copying `reconcileStaleRunningBackups()`'s pattern here.
7. **Rejected alternative (documented, not implemented):** extending `backup_runs` with a `'restore'` `triggered_by` value to reuse the exact same row-based marker backup uses. Rejected because `backup_runs.filename` has a `NOT NULL UNIQUE` constraint already held by the backup being restored *from* (which already has its own `succeeded` row under that filename) — a restore "run" row could not reuse that filename without a unique-constraint collision, and inventing a second filename convention for restore rows is more complexity than the session-lock approach for no additional benefit (restore has no multi-step "dump then upload" pipeline that benefits from a durable progress row the way backup does).
8. **Validate is explicitly NOT gated by this lock.** Per Story 9.1's AC-10 (already shipped, unchanged by this story), `validateBackupFile()` never opens a connection to, or executes anything against, `BACKUP_DATABASE_URL` or any live table — it is pure in-memory decrypt + structural text inspection. There is nothing for the lock to protect on that path. This is a deliberate scope decision closing 9-1's own open question ("needs a decision on lock scope and whether it should also block validate") — the answer is no.

### D2 — `backup.missed` auto-resolve reuses Story 9.2's already-shipped `clearThresholdAlertEpisode` helper; no migration

**Current state (verified in `apps/api/src/workers/backup-health-check.ts` and `apps/api/src/lib/threshold-alerts.ts`):**
- `runBackupHealthCheck()` returns early with no action whenever the last successful backup is within `BACKUP_MAX_AGE_HOURS` — including when an `admin_alerts` row of type `backup.missed` is already `status: 'active'` from a prior unhealthy run. Nothing in the codebase ever transitions that row away from `'active'`. Confirmed by reading the full file: there is no call to any resolve/acknowledge function anywhere in `backup-health-check.ts`.
- Story 9.2 already built and shipped exactly the primitive this needs: `clearThresholdAlertEpisode(alertType: string, scopeKey: string | null)` (`apps/api/src/lib/threshold-alerts.ts:76-88`) — a single `UPDATE admin_alerts SET status = 'acknowledged', acknowledged_at = now() WHERE alert_type = $1 AND status = 'active' AND (payload->>'scopeKey' matches $2 or IS NULL)`. It is already used for exactly this "condition cleared, un-suppress the next crossing" purpose for Story 9.2's tiered resource-usage alerts.
- `admin_alerts.status`'s existing `CHECK` constraint already allows `'acknowledged'` (D3 of Story 9.1: `status IN ('active','acknowledged','dismissed')`), and `acknowledgedAt` is already a column on the table. **No migration is needed** — reusing this exact mechanism means this story requires zero schema changes for this finding.
- **Do not widen the `status` CHECK constraint** (e.g., adding a new `'resolved'` value) even if it seems more semantically precise than reusing `'acknowledged'` — widening a `CHECK` constraint requires `ALTER TABLE ... DROP CONSTRAINT` + `ADD CONSTRAINT`, and `packages/db/src/lib/migration-safety.ts` (Story 9.3) flags any `DROP CONSTRAINT` statement as a **destructive migration**, blocking `guarded-migrate.ts`/`scripts/migration-compatibility-check.ts` unless the migration is added to `KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS` — an unnecessary CI-gate fight for a distinction (`'resolved'` vs. reused `'acknowledged'`) that has no behavioral consequence, since nothing currently branches on which of those two values a resolved alert carries.
- **`clearThresholdAlertEpisode`'s `scopeKey: null` filter already works for `backup.missed` with zero modification.** Its SQL is `(payload->>'scopeKey') IS NULL` when `scopeKey` is passed as `null`. `backup.missed` alerts (created by `createAdminAlertIfNotActive` in `apps/api/src/modules/backup/alerts.ts`) never write a `scopeKey` field into their `payload` at all — a missing JSONB key accessed via `->>'scopeKey'` evaluates to SQL `NULL`, so the filter matches. `backup.missed` is inherently instance-wide (not per-org), exactly the case Story 9.2 built the `scopeKey: null` branch for.

**Resolution:** in `runBackupHealthCheck()`, before (or instead of) the current early return when `hoursSinceLastSuccess <= env.BACKUP_MAX_AGE_HOURS`, call `await clearThresholdAlertEpisode('backup.missed', null)`. This one-line addition (plus an operational-log call) is the entire fix. `backup.failure` alerts (AC-13 of Story 9.1) are explicitly **not** in scope for this change — each failure is deliberately its own undeduped row by design (9-1's own AC-13 text: "unlike the missed alert, each failure is a distinct event worth its own record"); do not add resolve logic there, that would be a regression against an intentional, already-correct design.

### D3 — S3 upload hardening: local staging + bounded retry + 24h orphan cleanup; filesystem destination is untouched

**Current state (verified in `apps/api/src/modules/backup/storage.ts`):** `s3Storage(destination).write()` calls `PutObjectCommand` directly against the in-memory encrypted `Buffer` with no local copy ever written and no retry — a single transient network blip or throttling response loses the backup outright, with only the already-existing `backup.failure` alert (AC-13, unchanged) as the operator's signal that something happened, and nothing left to recover from. `filesystemStorage()`'s `write()` already has a correct atomic temp-file+`rename()` pattern (Story 9.1 AC-5) — **that path is not touched by this story.**

**Resolution (S3 destination only):**

1. **New env var** `BACKUP_S3_STAGING_PATH` (optional string, same `z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional())` shape as `BACKUP_STORAGE_PATH` in `apps/api/src/config/env.ts`). Only meaningful when `BACKUP_S3_BUCKET` is configured; ignored otherwise. **Default when unset:** `os.tmpdir() + '/vault-backup-staging'` — document in `.env.example` and the env var's own comment that this default does **not** survive a container restart (ephemeral `/tmp`), and that operators who want a failed-upload's staged file to survive a restart (so the 24h orphan-cleanup window is meaningful across restarts, not just within one process lifetime) should set `BACKUP_S3_STAGING_PATH` to a path on a mounted, persistent volume — mirror `BACKUP_STORAGE_PATH`'s existing `docker-compose.yml` volume-mount precedent.
2. **Staging write, in `executeBackupSnapshot()` (`service.ts`), S3-branch only:** after encryption, before calling `storage.write(run.filename, encrypted)`, write the same `encrypted` bytes to `<BACKUP_S3_STAGING_PATH>/<run.filename>.staged` using the same atomic temp-file+`rename()` pattern `filesystemStorage()` already uses (reuse that helper's logic, don't reinvent it — extract it if needed into a small shared function both call). This ciphertext is **identical to what will be uploaded** — never plaintext; encryption already happened in-memory via `runBackupCrypto('encrypt', ...)` before this point, per Story 9.1's existing `worker_threads` boundary rule (architecture.md: plaintext never crosses a `postMessage()` boundary, and the storage layer never sees plaintext at all).
3. **Upload with bounded retry:** wrap the `PutObjectCommand` call in a retry loop — up to 3 attempts total, exponential backoff (e.g., 500ms/1500ms between attempts). Only retry errors that look transient/network-shaped (connection reset, timeout, 5xx from S3, throttling `SlowDown`/`RequestTimeout` error codes); **do not retry** auth/permission errors (`InvalidAccessKeyId`, `SignatureDoesNotMatch`, `AccessDenied` — these will never succeed on retry, and retrying them only delays the failure alert for no benefit and risks tripping the caller's own HTTP timeout).
4. **On successful upload (first attempt or after retry):** delete the staged file (`<filename>.staged`) — no orphan left behind, matching the pre-existing filesystem-destination behavior of never leaving temp artifacts around after success.
5. **On final failure (retries exhausted, or a non-retryable error hit immediately):** do **not** delete the staged file — leave it in place for operator recovery, exactly as Story 9.1's own (never-implemented) AC-6 negative-case text already specified: *"The local encrypted temp file is retained... so a subsequent manual retry or operator intervention doesn't require re-running the entire dump+encrypt pipeline."* `backup_runs.status` is set to `'failed'` and the existing `backup.failure` alert path (AC-13, unchanged code) fires exactly as it does today for a `pg_dump` failure — this story does not add a new alert type, it reuses the existing one.
6. **Orphan cleanup, hourly, inside `runBackupHealthCheck()`** (not the post-success retention step in `backup-retention.ts`, which only runs after a *successful* backup and would never fire during a run of consecutive failures — exactly the scenario that produces orphans in the first place): scan `BACKUP_S3_STAGING_PATH` for `*.staged` files older than 24h (`mtime` comparison) and delete them. Only files matching the `.staged` suffix are ever touched by this scan — it must never delete a real `.vault`/`.meta.json` blob (those live at the S3 destination, not in the staging directory, by construction) or any unrelated file that happens to be in that directory. No-op entirely if `BACKUP_S3_STAGING_PATH` was never configured/used (filesystem-destination deployments, or S3 deployments where no failure has ever occurred).
7. **Explicitly out of scope (documented, not a gap):** a dedicated HTTP endpoint to manually re-trigger uploading a specific staged file without re-running `pg_dump`. Story 9.1's AC-6 text only promises the file is *retained* for "manual retry or operator intervention" (i.e., an operator can `aws s3 cp` it themselves as a last resort, or simply let the next scheduled/manual backup supersede it) — it never specifies an API for automated re-upload. Adding one would be new scope beyond the 3 findings this story bundles; noted here as a possible future enhancement, not implemented.

---

## Acceptance Criteria

### AC-1 — Restore acquires a session-scoped advisory lock before touching `BACKUP_DATABASE_URL` (happy path)

**Given** no backup is currently `running` and no other restore is in progress,
**When** a platform operator calls `POST /api/v1/admin/backups/:filename/restore` with a valid confirmation body,
**Then** the handler successfully acquires the restore lock (D1) before any decrypt/checksum work begins, proceeds through the existing Story 9.1 restore flow unchanged, and releases the lock after the outcome (success or failure) is determined.

**Example (positive):**
```
POST /api/v1/admin/backups/backup_20260704T030000Z_8f2a1c3e.vault/restore
{ "confirmRestore": true, "reason": "Recovering from accidental bulk-delete incident INC-4821" }
→ 200 { "restored": true, "filename": "backup_20260704T030000Z_8f2a1c3e.vault", "sealedAfterRestore": true }
```
A subsequent `SELECT pg_try_advisory_lock(hashtext('backup/snapshot'))` from a fresh connection immediately after the response returns `true` (lock available again — proves it was released).

---

### AC-2 — Two concurrent restore requests: the loser is rejected with `409`, not a race against the live database

**Given** a restore is already in progress (its session-scoped lock is held),
**When** a second `POST /api/v1/admin/backups/:filename/restore` request arrives (same or different filename) before the first completes,
**Then** the second request's lock-acquisition attempt fails immediately and it returns `409` **without ever calling `storage.read`, decrypting, or invoking `pg_restore`** — the rejection must be the cheapest possible path, before any I/O against the backup file or `BACKUP_DATABASE_URL`.

**Example (negative — concurrency conflict, restore vs. restore):**
```
POST /api/v1/admin/backups/backup_A.vault/restore   { "confirmRestore": true, "reason": "..." }  // in flight
POST /api/v1/admin/backups/backup_B.vault/restore   { "confirmRestore": true, "reason": "..." }  // fired 50ms later
→ 409 { "code": "restore_already_in_progress", "message": "Another restore is already in progress. Wait for it to complete before retrying." }
```
Integration test: fire both via `Promise.all` against a `deps.restore` stub that resolves only after an explicit signal (so the race window is deterministic, not timing-dependent) — assert exactly one `200`/appropriate-outcome and one `409`.

---

### AC-3 — Restore is blocked while a backup dump is already mid-flight (closes the reverse race)

**Given** `acquireBackupSlot()` has already inserted a `backup_runs` row with `status = 'running'` (the dump itself is in progress — its own brief xact-lock has already been released per D1's explanation of why this case needs an explicit check),
**When** `POST /api/v1/admin/backups/:filename/restore` is called,
**Then** the restore lock's post-acquisition check finds the `running` row and rejects with `409` before decrypting or restoring, releasing the session lock it had just acquired.

**Example (negative — restore vs. in-flight backup dump):**
```
// backup_runs has one row: { status: 'running', filename: 'backup_20260705T030000Z_....vault', triggeredBy: 'schedule' }
POST /api/v1/admin/backups/backup_20260701T030000Z_....vault/restore
{ "confirmRestore": true, "reason": "test" }
→ 409 { "code": "backup_in_progress", "message": "A backup is currently running. Wait for it to complete before restoring." }
```
Integration test: manually insert a `backup_runs` row with `status: 'running'` (simulating a dump mid-flight — no need to spawn a real `pg_dump` subprocess for this test), then call `restoreFromBackup`'s route handler and assert `409`, and assert `pg_restore`/`deps.restore` was never invoked.

---

### AC-4 — A new backup trigger is blocked while a restore holds the lock (symmetric — zero code changes required in `acquireBackupSlot`)

**Given** a restore is in progress and holds the session-scoped advisory lock,
**When** `POST /api/v1/admin/backup/trigger` is called (manual trigger) or the `backup:snapshot` cron fires,
**Then** `acquireBackupSlot()`'s existing `pg_try_advisory_xact_lock(hashtext('backup/snapshot'))` call fails (blocked by the restore's session-level lock on the same key, per D1.1's documented Postgres advisory-lock keyspace-sharing behavior) and the trigger is rejected/skipped exactly as it already is for a concurrent backup-vs-backup race — **no code changes to `acquireBackupSlot()` itself are required or expected**; this AC exists to prove the existing code already does the right thing once restore participates in the same lock key.

**Example (negative — manual trigger vs. in-flight restore):**
```
POST /api/v1/admin/backup/trigger   // fired while a restore holds the lock
→ 409 { "code": "backup_already_running", "message": "A backup is already in progress...", "jobId": null }
```
(Reuses the exact existing `409` shape `acquireBackupSlot()` already returns for backup-vs-backup conflicts — from the caller's perspective this looks identical to today's concurrent-backup case, which is correct: the caller doesn't need to know *why* the slot is unavailable, only that it is.)

**Example (negative — scheduled cron tick vs. in-flight restore):** the `backup:snapshot` cron fires while a restore holds the lock → `acquireBackupSlot()` returns `{ ok: false }` → `runBackupSnapshotJob` silently skips the tick (existing AC-7 behavior, unchanged) — no alert, no error, next scheduled tick will retry.

---

### AC-5 — Restore-validate is unaffected by this lock (explicit scope decision, regression-guarded)

**Given** a restore is in progress and holds the session-scoped lock,
**When** `POST /api/v1/admin/backups/:filename/validate` is called concurrently,
**Then** the validate request proceeds and completes normally — it is never gated by the restore lock, since `validateBackupFile()` (Story 9.1 AC-10, unchanged) never opens a connection to or touches `BACKUP_DATABASE_URL` or any live table.

**Example (positive — validate is never blocked):**
```
POST /api/v1/admin/backups/backup_A.vault/restore   { "confirmRestore": true, "reason": "..." }   // holds the lock
POST /api/v1/admin/backups/backup_B.vault/validate                                                 // fired concurrently
→ 200 { "valid": true, "assetsPresent": {...}, "checksum": "match" }   // succeeds immediately, no 409
```
Regression test: assert `validateBackupFile`/the validate route never calls `acquireRestoreLock` or any advisory-lock SQL — a static/behavioral check that this endpoint's code path has zero new lock-related imports.

---

### AC-6 — The restore lock is released on every outcome, including every failure branch

**Given** a restore proceeds past lock acquisition,
**When** the restore ultimately resolves to any of `not_found`, `checksum_mismatch`, `decrypt_failed`, `restore_failed`, or `restored`,
**Then** the lock is released in all five cases (via `try { ... } finally { await lock.release() }` wrapping the entire post-acquisition flow) — a subsequent lock-acquisition attempt succeeds immediately after any of these outcomes.

**Example (positive — released after checksum-mismatch failure):**
```
POST /api/v1/admin/backups/backup_corrupted.vault/restore   { "confirmRestore": true, "reason": "test" }
→ 422 { "code": "backup_checksum_mismatch", ... }
// immediately after:
POST /api/v1/admin/backup/trigger   → 202 { "jobId": "..." }   // NOT 409 — proves the lock was released, not leaked
```
Integration test: parametrize over all five outcomes (stub `deps.restore`/`deps.storage` to force each one), assert a lock-probe query succeeds immediately after each.

**Example (edge — released even when `parseBackupFilename` rejects the filename before any I/O):** a path-traversal-shaped `:filename` (Story 9.1's existing CWE-22 guard, unchanged) is rejected by `restoreFromBackup` before `storage.read` — this happens *after* `acquireRestoreLock()` succeeds (the lock is acquired first, per AC-1's ordering: lock before any decrypt/checksum work — filename validation happens inside `restoreFromBackup`, which runs after the lock is held). The `finally` block must still release the lock in this case too.

---

### AC-7 — Session-scoped lock self-releases on connection loss; no reconciliation code needed or added

**Given** a restore holds the session-scoped lock on a reserved connection,
**When** that connection is closed without an explicit `pg_advisory_unlock` call (simulating a process crash — the connection drops without the `finally` block running),
**Then** PostgreSQL itself releases the session-level advisory lock as part of that connection's cleanup — a subsequent lock-acquisition attempt from a different connection succeeds without any application-level reconciliation step.

**Example (positive — crash simulation via explicit `.release()`/close without unlock):**
```typescript
const reserved = await reserveConnection()
await reserved`SELECT pg_advisory_lock(hashtext('backup/snapshot'))`
await reserved.end() // or reserved.release() without first calling pg_advisory_unlock — simulates a crash
// from a fresh connection:
const [{ locked }] = await getDb().execute(sql`SELECT pg_try_advisory_lock(hashtext('backup/snapshot')) AS locked`)
// locked === true — the lock was released when the holding connection closed, not leaked
```
**And** this AC is a **regression guard**, not a call to add new code: confirm in code review that no `reconcileStaleRunningBackups()`-style startup reconciliation function was added for this lock — such a function would be redundant (the lock self-cleans) and its absence should not be flagged as a gap by a reviewer unfamiliar with this distinction. A comment at `acquireRestoreLock()`'s definition site must explain why (cross-reference D1.6).

---

### AC-8 — `backup.missed` alert auto-resolves once backups are healthy again

**Given** an `admin_alerts` row exists with `alertType: 'backup.missed'`, `status: 'active'` (created by a prior unhealthy health-check run per Story 9.1 AC-12, unchanged),
**When** the hourly `backup:health-check` job next runs and finds the last successful backup is now within `BACKUP_MAX_AGE_HOURS` (a subsequent scheduled or manual backup succeeded in the meantime),
**Then** that `admin_alerts` row transitions to `status: 'acknowledged'`, `acknowledgedAt` set to the resolution time — via `clearThresholdAlertEpisode('backup.missed', null)` (D2, reusing Story 9.2's already-shipped helper unchanged).

**Example (positive — auto-resolve):**
```json
// before: { "alertType": "backup.missed", "status": "active", "acknowledgedAt": null, ... }
// health check runs; last successful backup is now 3 hours old (< BACKUP_MAX_AGE_HOURS=25)
// after:
{ "alertType": "backup.missed", "status": "acknowledged", "acknowledgedAt": "2026-07-07T09:00:00Z", ... }
```
Integration test: seed an active `backup.missed` alert row, seed a `backup_runs` succeeded row with a recent `completedAt`, run `runBackupHealthCheck`, assert the alert row's `status`/`acknowledgedAt` updated.

---

### AC-9 — Auto-resolve does not permanently suppress a future re-miss (idempotent, re-alertable)

**Given** a `backup.missed` alert was auto-resolved (AC-8),
**When** backups later become unhealthy again (a fresh miss, independent of the resolved episode),
**Then** a **new** `admin_alerts` row is created (via the existing, unchanged `createAdminAlertIfNotActive`) — the prior resolved row (`status: 'acknowledged'`) does not count as "already active" and does not block the new alert.

**Example (positive — re-alert after resolution):**
```
// day 1: backup missed → alert A created (active) → later resolved (acknowledged)
// day 5: backup missed again → alert B created (active, distinct row from A)
```
Integration test: create-then-resolve one alert, then simulate a second unhealthy condition, assert a second, distinct `admin_alerts` row is created and delivered.

**Example (edge — health check runs twice while healthy, no active alert exists):** two overlapping hourly ticks both find the age healthy and no active alert — both call `clearThresholdAlertEpisode('backup.missed', null)`; the `UPDATE ... WHERE status = 'active'` matches zero rows both times — no error, no-op, no duplicate work. (A single `UPDATE` statement is atomic; no additional locking is needed for this idempotency, unlike `createAdminAlertIfNotActive`'s insert path which genuinely needs its own advisory lock to prevent a duplicate-insert race — resolving an already-non-active row has no equivalent race to guard against.)

---

### AC-10 — Auto-resolve is scoped only to `backup.missed`; every other `admin_alerts` type/episode is untouched

**Given** an active `key_custody_risk` alert (Story 9.2) and an active `backup.failure` alert (Story 9.1 AC-13, never deduped by design) both exist in `admin_alerts` at the same time as an active `backup.missed` alert,
**When** the `backup:health-check` job resolves the `backup.missed` alert per AC-8,
**Then** the `key_custody_risk` and `backup.failure` rows are completely unaffected — still `status: 'active'`, `acknowledgedAt: null`.

**Example (positive — scope isolation):**
```sql
-- before and after health-check run:
SELECT alert_type, status FROM admin_alerts WHERE alert_type IN ('key_custody_risk', 'backup.failure');
-- key_custody_risk | active     (unchanged)
-- backup.failure    | active     (unchanged — never auto-resolved, by design, see D2)
-- only this row changed:
SELECT alert_type, status FROM admin_alerts WHERE alert_type = 'backup.missed';
-- backup.missed     | acknowledged
```
Integration test: seed all three alert types active, run the health check once, assert only the `backup.missed` row's status changed.

---

### AC-11 — Auto-resolve is logged operationally; it does not enqueue a new notification

**Given** a `backup.missed` alert auto-resolves (AC-8),
**When** the resolution happens,
**Then** a structured operational log entry is emitted (new `OperationalEvent.BACKUP_MISSED_RESOLVED = 'backup.missed_resolved'` constant, added alongside the existing `BACKUP_*` constants in `packages/shared/src/constants/operational-event-types.ts`) — but **no** notification (email/Slack/inbox) is delivered for the resolution itself; only the original "missed" alert (AC-12 of Story 9.1, unchanged) was ever notification-worthy.

**Example (positive):**
```json
{ "event": "backup.missed_resolved", "level": "info", "lastSuccessAt": "2026-07-07T06:00:00Z", "timestamp": "2026-07-07T09:00:00Z" }
```
**And** `deliverAdminAlertAcrossOrgs` (D7's cross-org notification loop, unchanged) is never called from the resolve path — a regression test asserts `sendNotificationJobs`/the notification dispatcher receives zero calls attributable to the resolve branch of `runBackupHealthCheck` (distinguishing it from the "raise" branch, which does call it, unchanged).

---

### AC-12 — S3-destination backups stage the encrypted file locally before upload (happy path — no orphan left)

**Given** `BACKUP_S3_BUCKET` is configured and a scheduled or manual backup completes encryption,
**When** the storage-write step runs,
**Then** the encrypted bytes are first written atomically to `<BACKUP_S3_STAGING_PATH>/<filename>.staged` (temp-file + `rename()`, same pattern as `filesystemStorage()`'s existing AC-5 write), then uploaded to S3 via `PutObjectCommand`; on upload success, the `.staged` file is deleted immediately — no orphan remains.

**Example (positive):**
```
BACKUP_S3_BUCKET=vault-backups-prod
BACKUP_S3_STAGING_PATH=/var/backups/vault-staging
```
```
1. write /var/backups/vault-staging/backup_20260707T030000Z_....vault.staged  (atomic)
2. PutObjectCommand succeeds
3. delete /var/backups/vault-staging/backup_20260707T030000Z_....vault.staged
4. backup_runs.status = 'succeeded'
```
`ls /var/backups/vault-staging/` is empty after a successful run.

**Example (edge — staged bytes are identical ciphertext, never plaintext):** an integration test decrypts the `.staged` file (using the same `getBackupKey()`) mid-upload (before step 3 deletes it) and confirms it round-trips to the same plaintext as the final S3-uploaded object — proving staging never introduces a second, differently-encrypted copy, and confirming no plaintext ever touches disk at any point (encryption already happened in-memory before storage.write is ever called, per Story 9.1's existing `worker_threads` boundary rule — unchanged by this story).

---

### AC-13 — Transient S3 upload failures are retried automatically with bounded backoff

**Given** the first `PutObjectCommand` attempt fails with a transient/network-shaped error (connection reset, timeout, S3 `SlowDown`/`RequestTimeout`/`5xx`),
**When** the upload step runs,
**Then** it retries up to 2 more times (3 attempts total) with exponential backoff (e.g., 500ms, then 1500ms) before giving up; if any retry succeeds, the backup completes normally (AC-12's success path, including staged-file deletion).

**Example (positive — succeeds on 2nd attempt):**
```
Attempt 1: PutObjectCommand → ECONNRESET
  (wait 500ms)
Attempt 2: PutObjectCommand → 200 OK
→ backup_runs.status = 'succeeded'; staged file deleted; operational log notes the retry: { event: 'backup.completed', retryAttempts: 2 }
```

---

### AC-14 — Non-retryable S3 failures fail fast without wasting retries

**Given** the `PutObjectCommand` attempt fails with a non-retryable error (`InvalidAccessKeyId`, `SignatureDoesNotMatch`, `AccessDenied`, or any 4xx that is not `RequestTimeout`/`SlowDown`),
**When** the upload step runs,
**Then** it fails immediately after the first attempt — no retry loop is entered, since a credentials/permissions error will not succeed on retry and delaying the failure signal only wastes time and risks the caller's own timeout.

**Example (negative — auth failure, immediate, no retry):**
```
BACKUP_S3_BUCKET=vault-backups-prod  (bucket exists, credentials are wrong)
Attempt 1: PutObjectCommand → AccessDenied
→ (no attempt 2) backup_runs.status = 'failed', errorMessage: 'S3 upload failed: access denied' (sanitized — never logs the AWS secret key)
```
Integration test: mock `PutObjectCommand` to reject with an `AccessDenied`-shaped error and assert the S3 client mock was called exactly once (proving no retry was attempted).

---

### AC-15 — Persistent upload failure (retries exhausted) leaves a recoverable staged file and reuses the existing failure-alert path unchanged

**Given** all 3 upload attempts fail (transient case, retries exhausted) or a single non-retryable failure occurs (AC-14),
**When** the backup job's error handling runs,
**Then** the `<filename>.staged` file is **retained** on disk (not deleted), `backup_runs.status = 'failed'` with a sanitized `errorMessage`, and the existing (Story 9.1 AC-13, unchanged) `backup.failure` `admin_alerts` row is created and delivered exactly as it already is for a `pg_dump` failure — this story does not add a new alert type or delivery path for this case.

**Example (negative — retries exhausted, file recoverable):**
```
Attempt 1/2/3: PutObjectCommand → ETIMEDOUT (all three)
→ backup_runs.status = 'failed', errorMessage: 'S3 upload failed after 3 attempts: connection timed out'
→ admin_alerts row created: { alertType: 'backup.failure', severity: 'critical', payload: { filename: '...', errorMessage: '...' } }
→ /var/backups/vault-staging/backup_....vault.staged   STILL EXISTS — recoverable
```

---

### AC-16 — Orphaned staged files are cleaned up after 24 hours; younger ones are preserved

**Given** `BACKUP_S3_STAGING_PATH` contains one `.staged` file older than 24 hours (from a failed run, per AC-15) and one newer than 24 hours,
**When** the hourly `backup:health-check` job's orphan-cleanup step runs (D3.6),
**Then** the file older than 24h is deleted; the file younger than 24h is left untouched.

**Example (positive):**
```
/var/backups/vault-staging/
  backup_20260705T030000Z_....vault.staged   (mtime: 30h ago)   → deleted
  backup_20260707T030000Z_....vault.staged   (mtime: 2h ago)    → kept
```

**Example (edge — cleanup only ever touches `.staged` files):** a hypothetical unrelated file dropped into `BACKUP_S3_STAGING_PATH` by an operator (e.g., `notes.txt`) is never touched by the cleanup scan regardless of age — the scan globs strictly on the `.staged` suffix. Integration test: place a non-`.staged` file older than 24h in the staging directory, run the cleanup, assert it still exists.

**Example (edge — no staging path configured, or filesystem destination):** if `BACKUP_S3_BUCKET` was never configured (filesystem destination, or backup disabled entirely), the orphan-cleanup step is a no-op — it must not attempt to read/create `BACKUP_S3_STAGING_PATH`'s default value or throw if the directory doesn't exist.

---

### AC-17 — Filesystem-destination backups (`BACKUP_STORAGE_PATH`) are completely unaffected (regression guard)

**Given** `BACKUP_STORAGE_PATH` is configured (not `BACKUP_S3_BUCKET`),
**When** a backup runs,
**Then** `filesystemStorage()`'s existing atomic temp-file + `rename()` write (Story 9.1 AC-5, unchanged) is used exactly as before — no staging directory, no retry loop, no orphan-cleanup scan runs for this destination type.

**Example (regression — no behavior change):** an integration test that already passed under Story 9.1 for the filesystem-destination happy path is re-run unmodified against this story's changes and produces identical results (same file written, same `backup_runs` fields, no new files created anywhere).

---

### AC-18 — `BACKUP_S3_STAGING_PATH` env var validated consistently with existing `BACKUP_*` vars; no new redaction gap

**Given** the API starts up with `BACKUP_S3_BUCKET` configured,
**When** `apps/api/src/config/env.ts` parses the environment,
**Then** `BACKUP_S3_STAGING_PATH` is accepted as an optional string (same `z.preprocess` empty-string-to-undefined shape as `BACKUP_STORAGE_PATH`/`BACKUP_S3_ENDPOINT`), defaulting at the storage layer (not env validation) to `os.tmpdir() + '/vault-backup-staging'` when unset.

**Example (positive):**
```
BACKUP_S3_BUCKET=vault-backups-prod
BACKUP_S3_STAGING_PATH=/var/backups/vault-staging
```
Startup succeeds; `.env.example` documents the new var with the persistence caveat (D3.1).

**And** no new log-redaction entry is needed in `apps/api/src/lib/redact-paths.ts` — `BACKUP_S3_STAGING_PATH` is a filesystem path (like `BACKUP_STORAGE_PATH`, already unredacted), not a credential; only `BACKUP_DATABASE_URL` and AWS secret keys (already redacted/never logged, unchanged) carry sensitive material.

**Example (edge — S3 destination without an explicit staging path):**
```
BACKUP_S3_BUCKET=vault-backups-prod
# BACKUP_S3_STAGING_PATH not set
```
Startup succeeds (no fatal validation error — the default is applied at the storage layer); an `info`-level log line on first use notes the ephemeral-`/tmp` default and recommends setting the var explicitly for production self-hosted deployments (does not block startup, purely advisory).

---

### AC-19 — Integration test coverage (explicit list — do not consider this story done without all of these)

**Given** the full feature set above,
**When** the test suite runs (extending `apps/api/src/modules/backup/*.test.ts` and `apps/api/src/workers/backup-health-check.test.ts`/`backup-snapshot.test.ts`, or a new `apps/api/src/modules/backup/restore-lock.test.ts`),
**Then** it covers, at minimum: (1) restore happy path acquires and releases the lock (AC-1); (2) concurrent restore-vs-restore returns 409 without touching storage/DB (AC-2); (3) restore blocked by an in-flight backup dump (AC-3); (4) backup trigger blocked by an in-flight restore, both manual and scheduled-cron paths (AC-4); (5) validate is never gated by the restore lock, concurrently with an active restore (AC-5); (6) lock released on all five restore outcomes (AC-6); (7) lock self-releases on connection loss without reconciliation code (AC-7); (8) `backup.missed` auto-resolves when healthy again (AC-8); (9) auto-resolve doesn't suppress a later re-miss (AC-9); (10) auto-resolve idempotent under duplicate/overlapping health-check runs (AC-9); (11) auto-resolve scoped only to `backup.missed`, other alert types untouched (AC-10); (12) auto-resolve logs operationally, sends no notification (AC-11); (13) S3 happy path stages then uploads then deletes, no orphan (AC-12); (14) staged ciphertext matches uploaded ciphertext, never plaintext (AC-12); (15) transient failure retried and recovers (AC-13); (16) non-retryable failure fails fast, single attempt (AC-14); (17) persistent failure retains staged file + fires existing `backup.failure` alert unchanged (AC-15); (18) orphan cleanup deletes files >24h, keeps younger ones, ignores non-`.staged` files (AC-16); (19) filesystem-destination backups unaffected — existing Story 9.1 tests still pass unmodified (AC-17); (20) `BACKUP_S3_STAGING_PATH` env validation matrix (AC-18).

---

## Tasks / Subtasks

- [ ] **Task 1 — Restore concurrency guard (D1, AC-1 through AC-7)**
  - [ ] 1.1 Refactor `packages/db/src/index.ts`: hoist the private `postgres()` client to module scope; add exported `reserveConnection()` wrapping `pgClient.reserve()`.
  - [ ] 1.2 Add `acquireRestoreLock()`/`RestoreLockResult` to `apps/api/src/modules/backup/service.ts` per D1.4's exact shape (session-level `pg_try_advisory_lock` + `backup_runs.status='running'` check + release helper).
  - [ ] 1.3 Wire `acquireRestoreLock()` into the restore route handler in `apps/api/src/modules/backup/routes.ts`, wrapping the existing `restoreFromBackup()` call in `try/finally`; add the new `409` response schema case(s) (`restore_already_in_progress` / `backup_in_progress`) to the route's `schema.response` union.
  - [ ] 1.4 Add code comments at `acquireRestoreLock()`'s definition explaining why no reconciliation function is needed (D1.6/AC-7) — prevents a future reviewer from "fixing" a non-gap.
  - [ ] 1.5 Tests per AC-1 through AC-7.
- [ ] **Task 2 — `backup.missed` auto-resolve (D2, AC-8 through AC-11)**
  - [ ] 2.1 Add `OperationalEvent.BACKUP_MISSED_RESOLVED = 'backup.missed_resolved'` to `packages/shared/src/constants/operational-event-types.ts`, alongside the existing `BACKUP_*` block.
  - [ ] 2.2 In `apps/api/src/workers/backup-health-check.ts`'s healthy branch, call `clearThresholdAlertEpisode('backup.missed', null)` (import from `apps/api/src/lib/threshold-alerts.ts`, unmodified) and log the resolution operationally when a row was actually updated.
  - [ ] 2.3 Tests per AC-8 through AC-11.
- [ ] **Task 3 — S3 staging, retry, orphan cleanup (D3, AC-12 through AC-18)**
  - [ ] 3.1 Add `BACKUP_S3_STAGING_PATH` to `apps/api/src/config/env.ts` (same shape as `BACKUP_STORAGE_PATH`); document in `.env.example` with the ephemeral-default caveat; optionally add a `docker-compose.yml` volume-mount example (commented, like other optional backup vars).
  - [ ] 3.2 In `apps/api/src/modules/backup/storage.ts`, extract the atomic temp-file+`rename()` write helper from `filesystemStorage()` into a small shared function; reuse it for S3-destination local staging.
  - [ ] 3.3 Modify `s3Storage()`'s `write()` (or the calling code in `executeBackupSnapshot()`, whichever keeps `storage.ts`'s `BackupStorage` interface clean) to: stage locally → retry-wrapped `PutObjectCommand` (bounded, backoff, retryable-vs-not classification) → delete staged file on success / retain on final failure.
  - [ ] 3.4 Add the orphan-cleanup scan (24h `.staged`-file sweep) to `apps/api/src/workers/backup-health-check.ts`'s hourly run, no-op when `BACKUP_S3_STAGING_PATH`/S3 destination isn't in use.
  - [ ] 3.5 Tests per AC-12 through AC-18.
- [ ] **Task 4 — Full integration coverage sweep (AC-19)** — confirm every item in AC-19's explicit list has a corresponding test; re-run the full existing Story 9.1 `apps/api` backup/restore test suite unmodified to confirm zero regressions (AC-17).

## Dev Notes

- This story touches **only** `apps/api/src/modules/backup/**`, `apps/api/src/workers/backup-*.ts`, `apps/api/src/config/env.ts`, `apps/api/src/lib/threshold-alerts.ts` (read-only reuse, no modification expected), `packages/db/src/index.ts`, `packages/shared/src/constants/operational-event-types.ts`, `.env.example`, and optionally `docker-compose.yml` (staging volume example). **No new migration, no new database table, no new HTTP endpoint.** If implementation reveals a genuine need for a migration, stop and re-read D2 — it is very likely a sign the `'acknowledged'`-reuse approach was abandoned in favor of a new status value, which should be reconsidered first.
- `apps/api/src/modules/backup/service.ts`, `alerts.ts`, `storage.ts`, `routes.ts`, and `apps/api/src/workers/backup-health-check.ts`, `backup-snapshot.ts`, `backup-retention.ts` are the exact, already-shipped files this story extends — their current contents (as read and quoted throughout the Key Design Decisions above) are the ground truth for what "unchanged" means in every AC's regression-guard language. Do not re-derive their behavior from `epics.md` or Story 9.1's prose alone; the code in this worktree is authoritative.
- `apps/api/src/modules/backup/alerts.ts`'s `createAdminAlertIfNotActive` and `apps/api/src/lib/threshold-alerts.ts`'s `clearThresholdAlertEpisode`/`upsertThresholdAlert` are two **parallel, independently-evolved** admin_alerts helpers (the former from Story 9.1, the latter from Story 9.2) that happen to compose correctly for this story's purposes without modification — resist the temptation to "unify" them into one shared module as part of this story; that refactor is out of scope and risks destabilizing Story 9.2's already-`done`, already-tested tiered-threshold logic for no benefit to this story's 3 findings.
- Worker_threads/`withSecret()` boundary rules (architecture.md, unchanged) apply as-is: nothing in this story introduces a new plaintext-crossing-a-`postMessage()`-boundary risk — the staged file is ciphertext, exactly like the final uploaded object.

### Architecture Compliance

- Advisory-lock-based concurrency control is an established pattern in this codebase (Story 5.1's rotation state machine, Story 9.1's `acquireBackupSlot`, Story 9.2's `upsertThresholdAlert`/`clearThresholdAlertEpisode`) — this story's `acquireRestoreLock()` follows the same family, just at session rather than transaction scope, which is itself an established `postgres`-npm-package (`sql.reserve()`) capability already available in the dependency tree (no new dependency).
- `@aws-sdk/client-s3` is already a dependency (added by Story 9.1) — no new S3 SDK dependency for the retry logic; use the SDK's own error `name`/`$metadata.httpStatusCode` fields to classify retryable vs. non-retryable (do not add a second retry library; a small hand-rolled loop with `setTimeout`-based backoff is sufficient and matches this codebase's general preference for minimal dependencies for simple, bounded retry logic).

### Project Structure Notes

- No new files strictly required — all changes fit inside existing module files (`service.ts`, `storage.ts`, `routes.ts`, `backup-health-check.ts`, `env.ts`, `index.ts`, `operational-event-types.ts`). If `storage.ts`'s retry/staging logic grows large enough to hurt readability, splitting a `s3-upload.ts` sibling file inside `apps/api/src/modules/backup/` is acceptable and consistent with the module's existing granularity (`pg-process.ts`, `dump-inspect.ts`, `filename.ts` are all similarly narrow, single-purpose siblings).
- No conflicts detected with the unified project structure — this story adds no new route, no new schema file, no new worker file (extends `backup-health-check.ts` in place rather than adding a `backup-orphan-cleanup.ts` worker, since the hourly cadence and "no backup, no problem" guard logic it needs already exist there).

### Testing Standards Summary

- Follow this codebase's established TDD discipline (Story 9.1's Completion Notes: "tests written/confirmed failing for the right reason before implementation, for every new file/function"). Every new exported function (`acquireRestoreLock`, `reserveConnection`, the retry-wrapped S3 upload, the orphan-cleanup scan) needs a dedicated unit test plus the integration coverage in AC-19.
- Concurrency tests (AC-2, AC-3, AC-4) must use deterministic synchronization (an explicit signal/promise the test controls), not `setTimeout`-based timing races — matches this codebase's existing pattern for testing `acquireBackupSlot`'s own concurrency (Story 9.1's `service.test.ts`).
- Reuse `apps/api/src/modules/backup/service.test.ts`'s existing `deps: BackupServiceDeps` injection pattern (`dump`/`restore`/`storage` overrides) for the new lock and retry logic — do not spin up a real `pg_dump`/`pg_restore` subprocess or a real S3 endpoint in unit tests; MinIO/testcontainer-based S3 integration tests, if any exist already for Story 9.1's AC-6 happy path, should be extended for the retry/staging cases rather than duplicated.

### References

- [Source: `_bmad-output/implementation-artifacts/9-1-encrypted-backup-and-restore.md` — "Code Review Follow-ups" section (Dev Agent Record), the origin of all 3 findings this story resolves; also D2 (filename/instance-id scheme), D4 (`BACKUP_DATABASE_URL`/RLS-bypass threat model), D6 (operational-logging-only audit interim), D7 (cross-org alert delivery loop), AC-7 (`acquireBackupSlot` design), AC-9/AC-10 (restore/validate contracts), AC-12/AC-13 (alert contracts) — all unchanged by this story, restated above where load-bearing so this story is self-contained]
- [Source: `apps/api/src/modules/backup/service.ts` — `acquireBackupSlot`, `restoreFromBackup`, `decryptAndRestore`, `reconcileStaleRunningBackups` (read in full for this story; current contents are ground truth)]
- [Source: `apps/api/src/modules/backup/storage.ts` — `filesystemStorage`, `s3Storage`, `BackupStorage` interface (read in full)]
- [Source: `apps/api/src/modules/backup/alerts.ts` — `createAdminAlertIfNotActive`, `deliverAdminAlertAcrossOrgs` (read in full; unchanged)]
- [Source: `apps/api/src/workers/backup-health-check.ts` — `runBackupHealthCheck`, `raiseBackupMissedAlert` (read in full; extended by this story)]
- [Source: `apps/api/src/lib/threshold-alerts.ts` — `clearThresholdAlertEpisode`, `upsertThresholdAlert` (Story 9.2, read in full; reused unmodified by this story)]
- [Source: `packages/db/src/index.ts` — `getDb`, `withOrg` (`postgres`-npm-package usage confirmed; `sql.reserve()` is the basis for D1's new `reserveConnection()` helper)]
- [Source: `packages/db/src/lib/migration-safety.ts` — `DROP CONSTRAINT` destructive-pattern detection (Story 9.3), the reason D2 avoids widening `admin_alerts.status`'s CHECK constraint]
- [Source: `_bmad-output/planning-artifacts/epics.md` §"Epic 9: Platform Operations, API & Self-Hosting", Story 9.1 text (lines ~1989-2033) — original FR88-FR92 acceptance criteria this story hardens, including the literal AC-6 negative-case text this story finally implements]
- [Source: `_bmad-output/planning-artifacts/architecture.md` — worker_threads/`withSecret()` plaintext-boundary rule (unchanged, referenced by AC-12's staging-is-ciphertext-only requirement); advisory-lock precedent from Story 5.1's rotation state machine]
- [Source: `_bmad-output/planning-artifacts/prd.md` — 24h RPO / 2h RTO targets (unchanged; this story improves reliability of the mechanisms that deliver those targets, does not change the targets themselves)]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

### Previous Story Intelligence (Story 9.5 — Operational Runbook & Deployment Guide, `ready-for-dev`)

Story 9.5 is the sequentially-previous story file in Epic 9 (9-1 through 9-4 already `done`/`ready-for-dev`), but it is a **docs-only** deliverable with no code overlap with this story. Its one relevant lesson: Story 9.5's own D1/D2 establish the precedent that **shipped code/story-defined names win over `epics.md`'s literal prose where they differ** (documented twice already, by Stories 9.2 and 9.4) — this story follows the same discipline: every mechanism above (`acquireBackupSlot`, `clearThresholdAlertEpisode`, `filesystemStorage`'s atomic-write pattern) is described from the actual current code, not from `epics.md`'s original Story 9.1 summary text, which predates all of Story 9.1's own code-review fixes.

Note for whoever picks up Story 9.5 after this story merges: this story does not change any of the 4 backup/restore HTTP endpoints' paths, request, or success-response shapes — only adds new `409` cases and internal reliability behavior — so Story 9.5's runbook content describing those endpoints should not need factual correction as a result of this story, beyond optionally documenting the new `409` cases and the `BACKUP_S3_STAGING_PATH` env var if Story 9.5 is still being drafted/revised when this story lands.

### Git Intelligence (Recent Commits)

Most recent commits on this branch are unrelated to backup/restore (9.3 migration-safety/API-contract-tests hardening, docker/auth fixes). No recent commit touches `apps/api/src/modules/backup/` or `apps/api/src/workers/backup-*.ts` since Story 9.1's original implementation (commit `46975cb` per 9-1's Dev Agent Record) — this story is the first change to that module tree since 9-1 shipped, confirming no other in-flight work will conflict with these files.

## Dev Agent Record

### Agent Model Used

claude-sonnet-5 (Claude Code) — story creation

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed — story bundles Story 9.1's 3 deferred high-severity code-review findings (restore concurrency, `backup.missed` auto-resolve, AC-6 S3-failure staging/retry/cleanup) into one self-contained hardening story, following the same bundling pattern Story 8-5 used for Story 5.4's deferred findings. All 3 designs verified against the actual shipped code in `apps/api/src/modules/backup/`, `apps/api/src/workers/backup-*.ts`, `apps/api/src/lib/threshold-alerts.ts`, and `packages/db/src/index.ts` in this worktree — not re-derived from epics.md or story prose alone. Key finding during research: Story 9.2 already shipped the exact primitive (`clearThresholdAlertEpisode`) needed for the auto-resolve fix, meaning that finding requires zero new migration — a fact not mentioned anywhere in Story 9.1's own follow-up note, discovered by reading Story 9.2's `threshold-alerts.ts` directly.

### File List

_(populated by dev-story implementation — not applicable at story-creation time)_
