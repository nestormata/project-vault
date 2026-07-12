# Story 9.6: Backup & Restore Hardening

Status: done

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
| **Evaluator-visible** | no — this story hardens existing internal behavior (a lock inside an existing route handler, a worker's alert-resolution branch, a storage-write code path) behind the same four Story 9.1 endpoints. No new HTTP endpoint. Client-visible surface change is two new `409` response shapes on the restore endpoint (`restore_in_progress`, `backup_in_progress` — AC-2/AC-3), on an already-`409`-capable route family (adversarial review, medium: an earlier draft of this contract undercounted this as "one new `409` case"). |
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
     // Adversarial review (critical): this post-lock check MUST be guarded. If it throws
     // (transient DB error, pool exhaustion, query timeout), an unguarded throw here would leak
     // both the reserved connection and the session-level advisory lock forever — and because
     // restore/backup share this lock key (D1.1), that leak deadlocks every future restore AND
     // every future backup trigger until the process restarts. Any failure unlocks + releases
     // before rethrowing, exactly like the two explicit `{ ok: false }` paths below.
     try {
       // AC-3: close the reverse race — a backup dump already mid-flight (its own brief xact-lock
       // window has already closed by now) must still block restore.
       const [running] = await getDb().select({ id: backupRuns.id }).from(backupRuns).where(eq(backupRuns.status, 'running')).limit(1)
       if (running) {
         await unlockAndRelease(reserved)
         return { ok: false, reason: 'backup_in_progress' }
       }
     } catch (err) {
       await unlockAndRelease(reserved)
       throw err
     }
     return {
       ok: true,
       release: () => unlockAndRelease(reserved),
     }
   }

   // Adversarial review (low): checks pg_advisory_unlock's own return value rather than assuming
   // success — a `false` result means the lock wasn't actually held at unlock time, which would
   // indicate a lock-lifecycle bug worth surfacing (logged, not thrown — this runs in cleanup
   // paths including `finally` blocks, where throwing would mask the original error).
   async function unlockAndRelease(reserved: ReservedConnection): Promise<void> {
     const [{ unlocked }] = await reserved`SELECT pg_advisory_unlock(hashtext(${BACKUP_ADVISORY_LOCK_KEY})) AS unlocked`
     if (!unlocked) {
       logger.warn({ event: 'backup.restore_lock_unlock_unexpected' }, 'pg_advisory_unlock reported the restore lock was not held')
     }
     await reserved.release()
   }
   ```
5. `routes.ts`'s restore handler wraps its existing call to `restoreFromBackup()` with `acquireRestoreLock()` first; on `{ ok: false }`, return `409` before any decrypt/checksum work happens (cheapest possible rejection). On `{ ok: true }`, call `restoreFromBackup()` inside a `try { ... } finally { await lock.release() }` so the lock is released on **every** exit path (`not_found`, `checksum_mismatch`, `decrypt_failed`, `restore_failed`, `restored`).
6. **No reconciliation code needed for this lock** (unlike `reconcileStaleRunningBackups()` for the `backup_runs` row): a session-level advisory lock is automatically released by PostgreSQL itself the instant the holding connection closes — including a hard process crash/kill, which drops the TCP connection and the server-side backend cleans up that session's locks. This is different from `backup_runs.status='running'`, which is a *persisted row*, not a *live connection state* — that's precisely why it needed its own reconciliation function and this lock does not. Document this contrast in a code comment so a future reader doesn't "fix" a non-problem by copying `reconcileStaleRunningBackups()`'s pattern here.
7. **Rejected alternative (documented, not implemented):** extending `backup_runs` with a `'restore'` `triggered_by` value to reuse the exact same row-based marker backup uses. Rejected because `backup_runs.filename` has a `NOT NULL UNIQUE` constraint already held by the backup being restored *from* (which already has its own `succeeded` row under that filename) — a restore "run" row could not reuse that filename without a unique-constraint collision, and inventing a second filename convention for restore rows is more complexity than the session-lock approach for no additional benefit (restore has no multi-step "dump then upload" pipeline that benefits from a durable progress row the way backup does).
8. **Validate is explicitly NOT gated by this lock.** Per Story 9.1's AC-10 (already shipped, unchanged by this story), `validateBackupFile()` never opens a connection to, or executes anything against, `BACKUP_DATABASE_URL` or any live table — it is pure in-memory decrypt + structural text inspection. There is nothing for the lock to protect on that path. This is a deliberate scope decision closing 9-1's own open question ("needs a decision on lock scope and whether it should also block validate") — the answer is no.
9. **Filename format validation moves before lock acquisition (adversarial review, medium).** The route handler's existing CWE-22 path-traversal guard (`parseBackupFilename` — a pure regex/string check, zero I/O, zero DB) currently runs *inside* `restoreFromBackup()`, which is called *after* `acquireRestoreLock()` succeeds. This means a malformed or malicious `:filename` pays the full cost of `reserveConnection()` + an advisory-lock round trip + a `backup_runs` query before being rejected — inconsistent with AC-2's own "cheapest possible rejection" principle, and a rapid loop of bad-filename requests against the platform-operator-only endpoint would needlessly cycle the shared restore/backup lock. **Fix:** call `parseBackupFilename()` in the route handler *before* `acquireRestoreLock()` — reject a malformed filename with the existing `400`/path-traversal error with zero lock/DB involvement. The lock is only acquired once the filename shape is already known-good. (This does not change `restoreFromBackup()`'s own internal validation — it only moves the route-level pre-check earlier.)
10. **Known limitation, documented not fixed (adversarial review, medium — race-window mislabeling):** because `pg_try_advisory_lock` is non-blocking, if a restore's lock attempt lands during the brief moment `acquireBackupSlot()` holds its transaction-scoped xact-lock (the check-then-insert critical section for a *new* backup trigger, not an in-flight dump), `acquireRestoreLock()` reports `reason: 'restore_in_progress'` even though no restore is actually running — a backup-trigger's transient (sub-millisecond to low-millisecond) lock hold gets mislabeled as a competing restore. This is judged an acceptable trade-off: the window is extremely narrow, the operator-facing remedy is identical either way ("wait a moment and retry"), and distinguishing the two cases would require a third round-trip on every rejection to disambiguate a cause that doesn't change the caller's next action. The `409` response's `message` field (AC-2) must stay generic enough not to overclaim a specific cause ("Another restore is already in progress" is acceptable phrasing since it's true in the overwhelming majority of cases; do not word it as a guarantee).
11. **RLS/tenant-isolation of the new `backup_runs` query must be verified, not assumed (adversarial review, high).** `acquireRestoreLock()`'s post-lock check queries `backup_runs` via plain `getDb()` with no explicit org/tenant context, relying on Story 9.1's existing `EXCLUDED_TABLES` entry in `packages/db/scripts/check-rls-coverage.ts` (which already exempts `backup_runs` as a platform-operator-only, non-tenant-scoped table) still applying to this new call site. Since `backup_runs` is the same table `acquireBackupSlot()` already queries the same way (unchanged, already-shipped code), this call site does not introduce a *new* RLS exemption — but the assumption must be explicitly confirmed, not silently inherited: **Task 1.2 must include a test that runs `acquireRestoreLock()`'s post-lock check inside an org-scoped `withOrg()` context (or whatever mechanism this codebase's RLS policies key off) and asserts a `running` row is still visible** — proving AC-3's safety guarantee cannot silently no-op due to row-level filtering. If that test fails, this is a genuine gap requiring a real RLS policy fix, not just documentation.
12. **`packages/db/src/index.ts` regression scope (adversarial review, medium).** Task 1.1's refactor (hoisting the private `postgres()` client to module scope, adding `reserveConnection()`) touches shared low-level infrastructure consumed by every `getDb()` caller in the codebase, not just the backup module. Before merging, run the **full existing test suite for every package/app that imports `packages/db`** (not just `apps/api/src/modules/backup/**`) to confirm the module-scope hoist is behaviorally identical to the current per-call closure — this is a blast-radius regression check, not new functional test coverage, and should be called out explicitly in code review as satisfied. (See Testing Standards Summary below — this requirement is restated there.)

### D2 — `backup.missed` auto-resolve reuses Story 9.2's already-shipped `clearThresholdAlertEpisode` helper; no migration

**Current state (verified in `apps/api/src/workers/backup-health-check.ts` and `apps/api/src/lib/threshold-alerts.ts`):**
- `runBackupHealthCheck()` returns early with no action whenever the last successful backup is within `BACKUP_MAX_AGE_HOURS` — including when an `admin_alerts` row of type `backup.missed` is already `status: 'active'` from a prior unhealthy run. Nothing in the codebase ever transitions that row away from `'active'`. Confirmed by reading the full file: there is no call to any resolve/acknowledge function anywhere in `backup-health-check.ts`.
- Story 9.2 already built and shipped exactly the primitive this needs: `clearThresholdAlertEpisode(alertType: string, scopeKey: string | null)` (`apps/api/src/lib/threshold-alerts.ts:76-88`) — a single `UPDATE admin_alerts SET status = 'acknowledged', acknowledged_at = now() WHERE alert_type = $1 AND status = 'active' AND (payload->>'scopeKey' matches $2 or IS NULL)`. It is already used for exactly this "condition cleared, un-suppress the next crossing" purpose for Story 9.2's tiered resource-usage alerts.
- `admin_alerts.status`'s existing `CHECK` constraint already allows `'acknowledged'` (D3 of Story 9.1: `status IN ('active','acknowledged','dismissed')`), and `acknowledgedAt` is already a column on the table. **No migration is needed** — reusing this exact mechanism means this story requires zero schema changes for this finding.
- **Do not widen the `status` CHECK constraint** (e.g., adding a new `'resolved'` value) even if it seems more semantically precise than reusing `'acknowledged'` — widening a `CHECK` constraint requires `ALTER TABLE ... DROP CONSTRAINT` + `ADD CONSTRAINT`, and `packages/db/src/lib/migration-safety.ts` (Story 9.3) flags any `DROP CONSTRAINT` statement as a **destructive migration**, blocking `guarded-migrate.ts`/`scripts/migration-compatibility-check.ts` unless the migration is added to `KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS` — an unnecessary CI-gate fight for a distinction (`'resolved'` vs. reused `'acknowledged'`) that has no behavioral consequence, since nothing currently branches on which of those two values a resolved alert carries.
- **`clearThresholdAlertEpisode`'s `scopeKey: null` filter already works for `backup.missed` with zero modification.** Its SQL is `(payload->>'scopeKey') IS NULL` when `scopeKey` is passed as `null`. `backup.missed` alerts (created by `createAdminAlertIfNotActive` in `apps/api/src/modules/backup/alerts.ts`) never write a `scopeKey` field into their `payload` at all — a missing JSONB key accessed via `->>'scopeKey'` evaluates to SQL `NULL`, so the filter matches. `backup.missed` is inherently instance-wide (not per-org), exactly the case Story 9.2 built the `scopeKey: null` branch for.

**Resolution:** in `runBackupHealthCheck()`, before (or instead of) the current early return when `hoursSinceLastSuccess <= env.BACKUP_MAX_AGE_HOURS`, call `await clearThresholdAlertEpisode('backup.missed', null)`. This one-line addition (plus an operational-log call) is the entire fix. `backup.failure` alerts (AC-13 of Story 9.1) are explicitly **not** in scope for this change — each failure is deliberately its own undeduped row by design (9-1's own AC-13 text: "unlike the missed alert, each failure is a distinct event worth its own record"); do not add resolve logic there, that would be a regression against an intentional, already-correct design.

**Failure isolation (adversarial review, high):** this story adds a *second*, unrelated concern into the same `runBackupHealthCheck()` function — D3.6's hourly orphan-file-cleanup filesystem scan. The alert-resolve logic (this section) and the orphan-cleanup scan (D3.6) **must be wrapped in independent `try/catch` blocks** inside `runBackupHealthCheck()`, each logging its own failure operationally, so a filesystem error in one (permission error, missing mount, `ENOSPC`) can never prevent the other from running. The `backup.missed` auto-resolve/raise logic is the operator's single most important reliability signal from this job — it must never be silently skipped because an unrelated filesystem scan threw first.

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
8. **Staging directory is created on first use (adversarial review, high).** Neither an operator-set `BACKUP_S3_STAGING_PATH` nor the `os.tmpdir()`-based default is guaranteed to exist as a directory. The staging write step (item 2 above) must `mkdir(stagingPath, { recursive: true })` before the atomic temp-file+`rename()` write, on every write attempt (idempotent — a no-op if the directory already exists). If directory creation itself fails (e.g., a misconfigured mount, permission error), that failure is treated exactly like any other staging-write failure: the backup fails, `backup_runs.status = 'failed'` with a sanitized `errorMessage`, and the existing `backup.failure` alert fires (D3.5) — this is a new failure mode introduced by staging-before-upload, and it must be covered by AC-19's test list, not left silently unhandled.
9. **Cumulative staging-directory disk usage is monitored, not just individual-file age (adversarial review, high).** D3.6's 24h orphan sweep only bounds *how long* a single failed backup's staged file survives — it does nothing to bound total disk usage during a prolonged S3 outage (every failed attempt within that 24h window leaves a new full-size encrypted dump on disk). To close this without turning a remote-service outage into a local-disk-exhaustion incident: the same hourly health-check pass that runs orphan cleanup (D3.6) also sums the total bytes currently in `BACKUP_S3_STAGING_PATH` across all `.staged` files and, if that total exceeds a new optional env var `BACKUP_S3_STAGING_MAX_BYTES` (default: unset/disabled — this is a monitoring addition, not a hard cap that could itself block backups), raises a new `admin_alerts` row via `createAdminAlertIfNotActive('backup.staging_disk_pressure', ...)` (reusing the existing alerts helper, same pattern as `backup.missed`) with the current total size and file count in `payload`. This alert is **not** auto-cleared by D2's `clearThresholdAlertEpisode` wiring (different `alertType`) — it clears the same way `backup.missed` does, by the health check finding the total back under threshold on a later run, which requires adding `'backup.staging_disk_pressure'` as a second argument to a `clearThresholdAlertEpisode` call alongside the existing `'backup.missed'` one. This is a monitoring/alerting addition only — it does not change retry, staging, or cleanup behavior, and does not block a backup attempt from proceeding even while the threshold is exceeded (refusing to attempt backups because *previous* backups failed to upload would make outages strictly worse).
10. **Orphan-cleanup deletion is defensive against concurrent unlinks (adversarial review, medium).** Overlapping hourly health-check ticks (already an acknowledged possibility per AC-9's idempotency note for the alert-resolve side) could both list the same aged `.staged` file and both attempt to delete it. The cleanup scan's `unlink` call must catch and ignore `ENOENT` specifically (the file was already removed by the other tick) and log/rethrow any other error — this is the same "two ticks, no double-work, no crash" guarantee AC-9 already requires for alert-resolution, applied to the filesystem side of the same function.
11. **Operator convention for protecting an in-progress manual recovery from the 24h sweep (adversarial review, medium, documented — no code change).** D3.6's cleanup scan matches strictly on the literal `.staged` suffix (AC-16's edge case). An operator who needs more than 24h to manually recover a staged file (e.g., investigating before running `aws s3 cp`) can rename it to break that exact suffix match (e.g., append `.hold`, producing `....vault.staged.hold`) — the scan will never touch a file that isn't spelled exactly `*.staged`, by construction, so this requires no new code, only documenting the convention in the staging-path's `.env.example` comment and (if Story 9.5's runbook is still open) as an operational note there.
12. **Unclassified S3 upload errors default to retryable, not fail-fast (adversarial review, medium).** The retryable/non-retryable classification (item 3 above) enumerates specific known codes on both sides, but an error that matches neither list (DNS failure, a generic SDK `NetworkingError`, an unrecognized shape) must default to **retryable**. Rationale: retries are already bounded to 3 total attempts (item 3), so defaulting unknown errors to retryable costs at most ~2 seconds of extra latency in the worst case, versus defaulting to fail-fast which would silently convert a possibly-transient unknown error into an immediate, unrecoverable-this-run failure. Known non-retryable codes (`InvalidAccessKeyId`, `SignatureDoesNotMatch`, `AccessDenied`, other recognized 4xx) remain fail-fast as already specified.
13. **`SignatureDoesNotMatch` classification is a deliberate, documented trade-off, not a gap (adversarial review, low).** This code can occur both from genuinely wrong credentials (permanent) and from transient clock skew between the host and AWS (self-corrects after NTP resync). It remains classified as non-retryable per item 3 — a self-hosted deployment with clock skew severe enough to trip SigV4 has a more fundamental host-configuration problem than this retry loop should try to paper over, and the existing `backup.failure` alert (D3.5) surfaces the failure for operator investigation either way.
14. **No jitter on retry backoff is a deliberate, documented trade-off, not a gap (adversarial review, low).** The fixed 500ms/1500ms backoff (item 3) has no randomized jitter. This is acceptable for this codebase's target deployment shape (single-instance, self-hosted) where there is no thundering-herd risk from multiple instances retrying in lockstep. If this retry pattern is ever copied to a multi-instance context, jitter should be added at that time — it is out of scope here.

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
→ 409 { "code": "restore_in_progress", "message": "Another restore is already in progress. Wait for it to complete before retrying." }
```
(`"code"` uses the exact `RestoreLockResult.reason` string literal from D1.4 — `restore_in_progress`, not a paraphrase — so the wire contract and the implementation type can never drift, per the adversarial review's naming-inconsistency finding.)

Integration test: fire both via `Promise.all` against a `deps.restore` stub that resolves only after an explicit signal (so the race window is deterministic, not timing-dependent) — assert exactly one `200`/appropriate-outcome and one `409`.

**Example (negative — malformed filename, rejected before the lock is ever touched, adversarial review D1.9):**
```
POST /api/v1/admin/backups/../../etc/passwd/restore   { "confirmRestore": true, "reason": "..." }
→ 400 { "code": "invalid_filename", "message": "..." }
```
`parseBackupFilename()` runs in the route handler *before* `acquireRestoreLock()` is called (D1.9) — no `reserveConnection()`, no advisory-lock round trip, no `backup_runs` query for a malformed filename. Integration test: assert the S3/DB/lock mocks were never invoked for this request.

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
Integration test: manually insert a `backup_runs` row with `status: 'running'` (simulating a dump mid-flight — no need to spawn a real `pg_dump` subprocess for this test), then call `restoreFromBackup`'s route handler and assert `409`, and assert `pg_restore`/`deps.restore` was never invoked. **Per D1.11 (adversarial review, high):** this test must additionally run inside whatever org/tenant-scoped context (`withOrg()` or equivalent) the codebase's RLS policies key off of, and assert the `running` row is still visible to the query — proving this safety guarantee isn't silently defeated by row-level filtering.

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

**Example (edge — malformed filename never reaches the lock at all, D1.9):** a path-traversal-shaped `:filename` (Story 9.1's existing CWE-22 guard, unchanged) is now rejected by `parseBackupFilename()` in the route handler *before* `acquireRestoreLock()` is ever called (D1.9, moved here by the adversarial review to make rejection the cheapest possible path — see AC-2's malformed-filename example). This means this specific case no longer has a lock to release; the `finally`-block release guarantee below applies to every outcome reachable only *after* the lock is already held.

**Example (edge — an unexpected exception during the post-lock `backup_runs` check still releases the lock, D1.4):** if the `backup_runs` query inside `acquireRestoreLock()` itself throws (transient DB error, pool exhaustion — see D1.4's critical-finding fix), the lock and reserved connection are still released via `unlockAndRelease()` before the exception propagates — this is a distinct code path from the `finally` block (it runs *during* lock acquisition, not after), but the release guarantee is the same. Integration test: force the `backup_runs` select to reject and assert a lock-probe query succeeds immediately after the resulting error response.

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

**Example (edge — unrecognized error code defaults to retryable, D3.12, adversarial review medium):** an error matching neither the known-retryable nor known-non-retryable lists (e.g., a generic SDK `NetworkingError`, a DNS resolution failure) is treated as retryable and enters the same bounded 3-attempt loop as AC-13's transient case — it is never treated as fail-fast by default, since retries are already bounded and a wrong "fail fast" guess costs a lost backup while a wrong "retry" guess costs at most ~2 extra seconds.

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

**Example (negative — staging directory itself cannot be created, D3.8, adversarial review high):**
```
BACKUP_S3_STAGING_PATH=/mnt/unmounted-volume/staging   (mount missing at backup time)
→ mkdir(stagingPath, { recursive: true }) throws EACCES/ENOENT
→ backup_runs.status = 'failed', errorMessage: 'S3 upload failed: could not create staging directory' (path never logged verbatim if it could contain sensitive mount info — sanitized like all other errorMessage fields)
→ admin_alerts row created: { alertType: 'backup.failure', ... }   // same path as any other staging/upload failure — no new alert type
```
Integration test: point `BACKUP_S3_STAGING_PATH` at a path under a directory with no write permission, assert the backup fails cleanly via the existing `backup.failure` path rather than throwing an unhandled exception.

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

**Example (edge — overlapping health-check ticks deleting the same file, D3.10, adversarial review medium):** two hourly ticks both list the same aged `.staged` file and both attempt to delete it — the second `unlink` call catches and ignores `ENOENT` (the file the first tick already removed) rather than crashing the health-check run; any other unlink error is still logged/rethrown. Integration test: simulate a concurrent double-delete and assert no unhandled rejection.

**Example (edge — operator protects an in-progress manual recovery from the sweep, D3.11, documented convention, no code change):** renaming a staged file to break the exact `.staged` suffix match (e.g. `....vault.staged` → `....vault.staged.hold`) exempts it from the cleanup scan indefinitely, since the scan globs strictly on that literal suffix (same mechanism as the `notes.txt` edge case above). Documented in `.env.example`'s `BACKUP_S3_STAGING_PATH` comment — no test required beyond the existing suffix-matching test above, since this is the same behavior from a different angle.

---

### AC-16b — Cumulative staging-directory disk usage raises an alert before it becomes an incident (D3.9, adversarial review high)

**Given** `BACKUP_S3_STAGING_MAX_BYTES` is configured and a prolonged S3 outage has caused several consecutive backup failures, each leaving a retained `.staged` file (AC-15) within the same 24h orphan-cleanup window,
**When** the hourly health-check's staging-usage pass sums the total bytes across all `.staged` files in `BACKUP_S3_STAGING_PATH`,
**Then**, if that total exceeds `BACKUP_S3_STAGING_MAX_BYTES`, a `backup.staging_disk_pressure` `admin_alerts` row is raised via `createAdminAlertIfNotActive` (deduplicated the same way `backup.missed` is) with the current total bytes and file count in `payload`; once a later run finds the total back under threshold, the alert is cleared via `clearThresholdAlertEpisode('backup.staging_disk_pressure', null)` (same mechanism as D2, different `alertType`).

**Example (positive — threshold crossed):**
```
BACKUP_S3_STAGING_MAX_BYTES=5368709120   (5 GiB)
// staging dir currently holds 6.2 GiB across 4 .staged files after a 3-day S3 outage
→ admin_alerts row created: { alertType: 'backup.staging_disk_pressure', severity: 'warning', payload: { totalBytes: 6656000000, fileCount: 4 } }
```

**Example (edge — unset, monitoring disabled by default):** if `BACKUP_S3_STAGING_MAX_BYTES` is not set, this check is skipped entirely — this is a monitoring addition, not a hard cap, and must never block or fail a backup attempt on its own even while staging usage is over any threshold (refusing to attempt further backups because *earlier* backups failed to upload would make an outage strictly worse for RPO).

Integration test: seed several aged `.staged` files summing past the threshold, run the health check, assert the alert is raised; then remove the files and re-run, assert the alert clears.

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

**And** `BACKUP_S3_STAGING_MAX_BYTES` (AC-16b, D3.9) is accepted with the same optional-string-to-number shape (`z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional())`) — unset by default (disk-pressure monitoring off), documented in `.env.example` alongside `BACKUP_S3_STAGING_PATH`.

---

### AC-19 — Integration test coverage (explicit list — do not consider this story done without all of these)

**Given** the full feature set above,
**When** the test suite runs (extending `apps/api/src/modules/backup/*.test.ts` and `apps/api/src/workers/backup-health-check.test.ts`/`backup-snapshot.test.ts`, or a new `apps/api/src/modules/backup/restore-lock.test.ts`),
**Then** it covers, at minimum: (1) restore happy path acquires and releases the lock (AC-1); (2) concurrent restore-vs-restore returns 409 without touching storage/DB (AC-2); (3) restore blocked by an in-flight backup dump (AC-3), including the RLS-context assertion (D1.11); (4) backup trigger blocked by an in-flight restore, both manual and scheduled-cron paths (AC-4); (5) validate is never gated by the restore lock, concurrently with an active restore (AC-5); (6) lock released on all five restore outcomes (AC-6); (6b) lock released when the post-lock `backup_runs` check itself throws (AC-6, D1.4 critical fix); (7) lock self-releases on connection loss without reconciliation code (AC-7); (8) `backup.missed` auto-resolves when healthy again (AC-8); (9) auto-resolve doesn't suppress a later re-miss (AC-9); (10) auto-resolve idempotent under duplicate/overlapping health-check runs (AC-9); (11) auto-resolve scoped only to `backup.missed`, other alert types untouched (AC-10); (12) auto-resolve logs operationally, sends no notification (AC-11); (12b) alert-resolve and orphan-cleanup failures are isolated from each other (D2 failure-isolation fix); (13) S3 happy path stages then uploads then deletes, no orphan (AC-12); (14) staged ciphertext matches uploaded ciphertext, never plaintext (AC-12); (15) transient failure retried and recovers (AC-13); (16) non-retryable failure fails fast, single attempt (AC-14); (16b) unrecognized error code defaults to retryable (AC-14); (17) persistent failure retains staged file + fires existing `backup.failure` alert unchanged (AC-15); (17b) staging-directory creation failure fails cleanly via the existing `backup.failure` path (AC-15, D3.8); (18) orphan cleanup deletes files >24h, keeps younger ones, ignores non-`.staged` files (AC-16); (18b) overlapping-tick concurrent unlink doesn't crash (AC-16, D3.10); (18c) cumulative staging-directory disk-pressure alert raises and clears (AC-16b); (19) filesystem-destination backups unaffected — existing Story 9.1 tests still pass unmodified (AC-17); (20) `BACKUP_S3_STAGING_PATH`/`BACKUP_S3_STAGING_MAX_BYTES` env validation matrix (AC-18); (21) malformed filename rejected before the lock is touched (AC-2, D1.9); (22) every restore outcome emits an audit-relevant log entry (AC-20); (23) `packages/db` blast-radius regression pass — full existing test suite for every `getDb()` consumer outside the backup module still passes unmodified after the Task 1.1 refactor (D1.12).

---

### AC-20 — Every restore attempt (accepted or rejected) is audit-logged with the actor's identity (adversarial review, medium)

**Given** a platform operator calls `POST /api/v1/admin/backups/:filename/restore`,
**When** the request resolves to any outcome — lock acquired and restore proceeds (any of AC-1/AC-6's five sub-outcomes), or rejected at the lock (AC-2/AC-3), or rejected at filename validation (AC-2's malformed-filename example) —
**Then** an audit-relevant operational log entry is emitted recording the actor identity, the filename requested, and the outcome, consistent with Story 9.1's existing operational-logging-only interim posture for security-sensitive backup/restore actions (full `platform_audit_events` integration is Story 9.4's scope, not this story's — see Story 9.1's D6). This closes the gap where a blocked restore attempt (successful or not) against a secrets-vault's full-database-restore path left no trace of who attempted it.

**Example (positive — logged on rejection):**
```json
{ "event": "backup.restore_attempted", "level": "info", "actorId": "...", "filename": "backup_B.vault", "outcome": "rejected", "reason": "restore_in_progress", "timestamp": "..." }
```

**Example (positive — logged on success):**
```json
{ "event": "backup.restore_attempted", "level": "info", "actorId": "...", "filename": "backup_A.vault", "outcome": "restored", "timestamp": "..." }
```

Integration test: parametrize over an accepted restore, a lock-rejected restore, and a malformed-filename-rejected restore, and assert exactly one `backup.restore_attempted`-shaped log entry per request with the correct `outcome`/`reason`.

---

## Tasks / Subtasks

- [x] **Task 1 — Restore concurrency guard (D1, AC-1 through AC-7, AC-20)**
  - [x] 1.1 Refactor `packages/db/src/index.ts`: hoist the private `postgres()` client to module scope; add exported `reserveConnection()` wrapping `pgClient.reserve()`. Per D1.12 (adversarial review, medium): after this refactor, run the full test suite for every existing `getDb()` consumer outside the backup module, not just backup-scoped tests, to confirm behavioral parity.
  - [x] 1.2 Add `acquireRestoreLock()`/`RestoreLockResult`/`unlockAndRelease()` to `apps/api/src/modules/backup/service.ts` per D1.4's exact shape (session-level `pg_try_advisory_lock` + try/catch-guarded `backup_runs.status='running'` check + shared unlock-with-result-check helper — the try/catch and the unlock-result check are both required, not optional hardening, per D1.4's critical/low fixes). Include the RLS-context test required by D1.11.
  - [x] 1.3 In `apps/api/src/modules/backup/routes.ts`: call `parseBackupFilename()` **before** `acquireRestoreLock()` (D1.9 — moves existing CWE-22 guard earlier so a malformed filename never touches the lock). Then wire `acquireRestoreLock()` into the handler, wrapping the existing `restoreFromBackup()` call in `try/finally`; add the new `409` response schema case(s) (`restore_in_progress` / `backup_in_progress` — exact literals, matching D1.4's type, per the naming-consistency fix) to the route's `schema.response` union.
  - [x] 1.4 Add code comments at `acquireRestoreLock()`'s definition explaining why no reconciliation function is needed (D1.6/AC-7) — prevents a future reviewer from "fixing" a non-gap. Also comment the documented race-window mislabeling trade-off (D1.10).
  - [x] 1.5 Add the `backup.restore_attempted` audit-relevant operational log call (AC-20) covering every outcome: accepted, lock-rejected, and pre-lock filename-rejected.
  - [x] 1.6 Tests per AC-1 through AC-7, AC-20, and D1.11's RLS-context assertion.
- [x] **Task 2 — `backup.missed` auto-resolve (D2, AC-8 through AC-11)**
  - [x] 2.1 Add `OperationalEvent.BACKUP_MISSED_RESOLVED = 'backup.missed_resolved'` to `packages/shared/src/constants/operational-event-types.ts`, alongside the existing `BACKUP_*` block.
  - [x] 2.2 In `apps/api/src/workers/backup-health-check.ts`'s healthy branch, call `clearThresholdAlertEpisode('backup.missed', null)` (import from `apps/api/src/lib/threshold-alerts.ts`, unmodified) and log the resolution operationally when a row was actually updated. Wrap this logic in its own `try/catch`, independent of Task 3.4's orphan-cleanup/disk-pressure scan (D2 failure-isolation fix, adversarial review high) — a failure in one must never prevent the other from running.
  - [x] 2.3 Tests per AC-8 through AC-11, including the failure-isolation case.
- [x] **Task 3 — S3 staging, retry, orphan cleanup (D3, AC-12 through AC-18, AC-16b)**
  - [x] 3.1 Add `BACKUP_S3_STAGING_PATH` and `BACKUP_S3_STAGING_MAX_BYTES` to `apps/api/src/config/env.ts` (same shape as `BACKUP_STORAGE_PATH`); document both in `.env.example` with the ephemeral-default caveat and the `.staged`/`.staged.hold` operator-protection convention (D3.11); optionally add a `docker-compose.yml` volume-mount example (commented, like other optional backup vars).
  - [x] 3.2 In `apps/api/src/modules/backup/storage.ts`, extract the atomic temp-file+`rename()` write helper from `filesystemStorage()` into a small shared function; reuse it for S3-destination local staging. Ensure the staging directory is created (`mkdir(..., { recursive: true })`) before every write, and that creation failure routes through the existing `backup.failure` alert path (D3.8).
  - [x] 3.3 Modify `s3Storage()`'s `write()` (or the calling code in `executeBackupSnapshot()`, whichever keeps `storage.ts`'s `BackupStorage` interface clean) to: stage locally → retry-wrapped `PutObjectCommand` (bounded, backoff, retryable-vs-not classification, **defaulting unrecognized error codes to retryable** per D3.12) → delete staged file on success / retain on final failure.
  - [x] 3.4 Add the orphan-cleanup scan (24h `.staged`-file sweep, `unlink` guarded against concurrent-tick `ENOENT` per D3.10) **and** the cumulative staging-disk-usage check (`BACKUP_S3_STAGING_MAX_BYTES`, D3.9/AC-16b) to `apps/api/src/workers/backup-health-check.ts`'s hourly run, each in its own `try/catch` independent of Task 2.2's alert-resolve logic and of each other; no-op when `BACKUP_S3_STAGING_PATH`/S3 destination isn't in use.
  - [x] 3.5 Tests per AC-12 through AC-18 and AC-16b.
- [x] **Task 4 — Full integration coverage sweep (AC-19)** — confirm every item in AC-19's explicit (now 23-item) list has a corresponding test; re-run the full existing Story 9.1 `apps/api` backup/restore test suite unmodified to confirm zero regressions (AC-17); re-run the full `packages/db`-consumer regression pass (D1.12).

### Review Findings (bmad-code-review, 2026-07-11)

Clean pass — no `decision-needed` or `patch` findings against the merged diff (PR #128). Lock lifecycle (`acquireRestoreLock`/`unlockAndRelease`), retry classification (`isRetryableS3Error`), and orphan-cleanup idempotency all verified correct; the response-race fix (commit `aff3291`, lock release before `reply.send()`) confirmed present.

- [x] [Review][Defer] `SignatureDoesNotMatch` classified non-retryable, no retry-backoff jitter, advisory-lock false-positive mislabeling on transient xact-lock hold — all pre-existing documented trade-offs (D3.13/D3.14/D1.10), not new gaps.

**Status → done.**

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
- **Blast-radius regression requirement (D1.12, adversarial review medium):** Task 1.1's `packages/db/src/index.ts` refactor is infrastructure shared by every `getDb()` caller in the codebase, not just the backup module. Before this story is considered done, run the full test suite for every package/app that imports `packages/db` (not only `apps/api/src/modules/backup/**`) and confirm zero regressions — call this out explicitly as satisfied in code review, since it's easy for a reviewer scoped to "this is a backup story" to miss that this one task touches shared infrastructure.
- **Time-threshold cross-reference note (adversarial review, low, documentation only):** this story introduces or touches three independently-configurable time windows that happen to cluster around similar magnitudes but are **not** linked to each other and must not be assumed to be: `BACKUP_MAX_AGE_HOURS` (operator-tunable, AC-8's example uses `25`), the PRD's 24h RPO target (a design target, not a runtime value), and the orphan-cleanup window (AC-16, hardcoded 24h, not currently exposed as an env var). Document this explicitly in `.env.example`'s comments for `BACKUP_MAX_AGE_HOURS` so an operator tuning one doesn't assume it affects the others.
- **Delivery/sequencing note (adversarial review, low):** this story bundles three independently-valuable, differently-risky fixes (D1 restore-lock, D2 one-line alert auto-resolve, D3 S3 staging/retry/cleanup — by far the largest and most complex of the three). If implementation reveals that D3's complexity is putting the simpler D1/D2 fixes at risk of being held up, Tasks 1/2 and Task 3 are independently shippable in separate PRs — there is no code dependency between them (confirmed: D1 touches `service.ts`/`routes.ts`/`packages/db`, D2 touches only `backup-health-check.ts`'s alert branch, D3 touches `storage.ts`/`env.ts`/`backup-health-check.ts`'s cleanup branch — no shared new symbols between D1/D2 and D3). Prefer shipping as one story per the original bundling rationale (matches Story 8-5's precedent) unless a real blocker emerges.

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
claude-sonnet-5 (Claude Code) — implementation (Task 1)

### Debug Log References

### Completion Notes List

- **Task 1 (D1 restore concurrency guard) implemented, TDD red-green throughout.** `packages/db/src/index.ts`: hoisted the private `postgres()` client to module scope (`getPgClient()`), added exported `reserveConnection()` returning a `ReservedConnection` — verified with a new session-lock test in `index.test.ts` proving two independent reserved connections genuinely conflict on the same advisory-lock key, plus a full `packages/db` regression run (183/183 passing, D1.12 blast-radius check satisfied). `apps/api/src/modules/backup/service.ts`: added `acquireRestoreLock()`/`RestoreLockResult`/`unlockAndRelease()` exactly per D1.4 (session-level `pg_try_advisory_lock` on the same `hashtext('backup/snapshot')` key `acquireBackupSlot()` uses, guarded try/catch around the post-lock `backup_runs.status='running'` check per the critical adversarial-review fix, unlock-result-checked cleanup helper). Added a test-only `checkBackupRunning` deps override (matches this codebase's existing `BackupServiceDeps` injection convention) specifically to exercise D1.4's guarded-throw path (AC-6b) without needing a genuine DB failure. `apps/api/src/modules/backup/routes.ts`: moved `parseBackupFilename()` before `acquireRestoreLock()` (D1.9) returning a new `400 invalid_filename`; wired the lock into the restore handler with `try/finally` release; added `backup.restore_attempted` audit-relevant logging (AC-20) for all three attempt shapes (filename-rejected, lock-rejected, accepted). `packages/shared`: added `OperationalEvent.BACKUP_RESTORE_ATTEMPTED` and `BACKUP_MISSED_RESOLVED` (the latter pre-added for Task 2). New test file `apps/api/src/modules/backup/restore-lock.test.ts` covers AC-1/AC-3/AC-4/AC-6/AC-6b/AC-7 and D1.11's RLS-context assertion at the service level (using real Postgres advisory locks, not mocks); `backup.routes.test.ts` extended with an HTTP-level `describe` block for AC-2/AC-3/AC-4/AC-5/AC-6/AC-20, plus a dedicated log-capturing app instance for AC-20. **Deviation, documented and fixed:** two pre-existing tests (`AC-9 negative: unknown filename returns 404`, Story 9.4's `backup.restore_initiated is written even when the target filename does not exist`) used a `nonexistent-<uuid>.vault` fixture that, under the new D1.9 pre-check, no longer matches `FILENAME_PATTERN` and would now hit the new `400 invalid_filename` path instead of the intended "genuinely doesn't exist" `404` path — fixed by introducing a `wellFormedNonexistentFilename()` test helper (matches the real `backup_<timestamp>_<uuid>.vault` shape but was never written to storage) so these tests keep exercising their original intent. Also discovered and fixed a real cross-test-file pollution risk: two new tests inserted synthetic `backup_runs` rows with `triggeredBy: 'schedule'`, which an existing, unrelated test in `backup-snapshot.test.ts` queries by that exact value with no `orderBy`/`limit` — switched the synthetic rows to `triggeredBy: 'manual'` to avoid polluting that query; confirmed 3 consecutive full runs of `src/modules/backup` + `src/workers` together at 212/212 passing after the fix.
- **Task 2 (D2 `backup.missed` auto-resolve) implemented, TDD red-green.** `apps/api/src/workers/backup-health-check.ts`'s healthy branch now calls a new `resolveBackupMissedAlertIfActive()` helper instead of a bare early return: it first checks for an active `backup.missed` row (so the `BACKUP_MISSED_RESOLVED` log — AC-11 — only fires on a genuine transition, not every healthy tick), then calls `clearThresholdAlertEpisode('backup.missed', null)` (Story 9.2's helper, unmodified, as designed) wrapped in its own try/catch (D2 failure isolation, adversarial review high) so a future failure here can never block Task 3.4's orphan-cleanup/disk-pressure scan or vice versa. Added `OperationalEvent.BACKUP_MISSED_RESOLVED` and a new `BACKUP_MISSED_RESOLVE_FAILED` (for the catch branch, matching this codebase's existing per-failure-event-constant convention, e.g. `MONITORING_HEALTH_CHECK_ROW_FAILED`). Added a test-only `BackupHealthCheckDeps.clearBackupMissedAlert` override (same injection convention as Task 1) to exercise the failure-isolation catch path without a genuine DB failure. `backup-health-check.test.ts` extended with a nested `describe` covering AC-8 (auto-resolve), AC-9 (re-alert after resolution + idempotent no-op), AC-10 (scope isolation vs. `key_custody_risk`/`backup.failure`), AC-11 (log emitted, no notification/`boss.send` call), and the failure-isolation case. Combined `apps/api` backup+workers suite: 218/218 passing.
- **Task 3 (D3 S3 staging/retry/orphan-cleanup) implemented, TDD red-green, the largest of the three findings.** Extracted `filesystemStorage()`'s atomic temp-file+rename write into a new shared `apps/api/src/modules/backup/atomic-write.ts` (`atomicFileWrite`), reused by a new sibling `s3-upload.ts` for the S3 destination's local staging write. `s3-upload.ts` exports `stageAndUploadToS3` (stage → up-to-3-attempt retry with 500ms/1500ms backoff → delete staged file on success / retain on final failure, sanitized error messages only), `isRetryableS3Error` (known non-retryable codes fail fast; any other 4xx also fails fast; everything else — including unrecognized errors, D3.12 — defaults retryable), `cleanupOrphanedStagedFiles` (24h sweep, ENOENT-tolerant for D3.10's concurrent-tick race), and `stagingDirectoryUsage` (AC-16b). `storage.ts`'s `s3Storage()`/`filesystemStorage()` now delegate to these; `BackupStorage`'s public interface is unchanged (kept clean per Task 3.3's guidance) and the existing `storage.test.ts`/`service.test.ts` S3-failure tests pass unmodified (AC-17 regression guard). `env.ts` adds `BACKUP_S3_STAGING_PATH`/`BACKUP_S3_STAGING_MAX_BYTES` (same optional-string/positive-int shape as existing `BACKUP_*` vars); `.env.example` and `docker-compose.yml` document both with the ephemeral-`/tmp` persistence caveat and the `.staged`/`.staged.hold` operator-convention. `backup-health-check.ts` gained `runStagingMaintenance()` (no-op unless the configured destination is S3, per AC-16's edge case) running the orphan-cleanup scan and the `backup.staging_disk_pressure` disk-pressure alert (raised/cleared via the same `createAdminAlertIfNotActive`/`clearThresholdAlertEpisode` pattern as `backup.missed`) every tick, each in its own try/catch independent of D2's alert-resolve logic and of each other (D3.10). Added test-only deps overrides (`cleanupOrphanedStagedFiles`, `stagingDirectoryUsage`, `stagingMaxBytes`) to `BackupHealthCheckDeps` for deterministic testing without mutating live env state mid-suite. New test files: `atomic-write.test.ts`, `s3-upload.test.ts` (18 tests: AC-12 through AC-15, AC-16, AC-16b, D3.8/D3.10/D3.12/D3.13 classification), `backup-health-check-staging.test.ts` (4 integration tests against a real S3-configured env, AC-16/AC-16b/D3.10). Also added a `backup-snapshot.test.ts` test proving AC-4's scheduled-cron path (not just the manual-trigger route) is already correctly blocked by a held restore lock with zero code changes, closing AC-19 checklist item 4's "both manual and scheduled-cron paths" requirement. **Scope trim, documented:** AC-13's illustrative `retryAttempts` log field was not threaded through `BackupStorage.write()`'s return value, since Task 3.3 explicitly prioritizes keeping that interface clean — the testable behavior (upload succeeds after a transient failure, backup completes normally) is covered directly against `stageAndUploadToS3`. Full `apps/api` `src/modules/backup` + `src/workers` suite: 243/243 passing across 6 consecutive full runs (fileParallelism is disabled repo-wide, so no cross-file races); `packages/db` (183/183) and `packages/shared` (132/132) full suites also green.
- Ultimate context engine analysis completed — story bundles Story 9.1's 3 deferred high-severity code-review findings (restore concurrency, `backup.missed` auto-resolve, AC-6 S3-failure staging/retry/cleanup) into one self-contained hardening story, following the same bundling pattern Story 8-5 used for Story 5.4's deferred findings. All 3 designs verified against the actual shipped code in `apps/api/src/modules/backup/`, `apps/api/src/workers/backup-*.ts`, `apps/api/src/lib/threshold-alerts.ts`, and `packages/db/src/index.ts` in this worktree — not re-derived from epics.md or story prose alone. Key finding during research: Story 9.2 already shipped the exact primitive (`clearThresholdAlertEpisode`) needed for the auto-resolve fix, meaning that finding requires zero new migration — a fact not mentioned anywhere in Story 9.1's own follow-up note, discovered by reading Story 9.2's `threshold-alerts.ts` directly.
- **Adversarial review findings incorporated (2026-07-07):** `bmad-review-adversarial-general` produced 19 findings (1 critical, 5 high, 8 medium, 5 low) against the initial draft of this story — see `9-6-backup-restore-hardening-adversarial-review.md` for the original review. All 19 were folded directly into this story's design (D1.4/D1.9–D1.12, D2's failure-isolation paragraph, D3.8–D3.14) and ACs (new AC-2/AC-6 edge cases, AC-14/AC-15/AC-16 new edge cases, new AC-16b, new AC-20, expanded AC-19 checklist to 23 items) rather than deferred to a follow-up story, since deferring code-review findings from a story whose entire purpose is resolving deferred findings would repeat the same pattern indefinitely. The critical finding (unguarded post-lock-check exception leaking the restore/backup lock forever) and all 5 high findings received concrete design/code changes, not just documentation. Three low findings (`SignatureDoesNotMatch` classification, retry-backoff jitter, threshold cross-referencing) were resolved as explicit documented trade-offs rather than code changes, with rationale recorded inline at D3.13/D3.14 and in Dev Notes — these are considered accepted, not open.
- **Code review fix, race condition (2026-07-08, commit `aff3291`):** the restore route's `finally { await lock.release() }` wrapped a `try` block whose last statement called `handleRestoreOutcome()`, which calls `reply.send()` directly — Fastify does not wait for the handler's own promise to settle before writing that response to the client, so a caller could receive its response and retry before the lock was actually free server-side. Reproduced deterministically (100% failure rate across 3 isolated runs of AC-6's lock-release test, varying only which of the three probes tripped — clear signature of a race, not a flaky assertion). Fixed by restructuring so `restoreFromBackup()` and `lock.release()` both complete before `handleRestoreOutcome()` is ever called, guaranteeing the lock is free by the time any response reaches the client. AC-6 test now passes 5/5 in isolation; full `apps/api` CI run (attempt after this fix) confirms no regression.
- **Post-implementation full-suite verification (2026-07-08):** a full clean `apps/api` run (1712 tests) surfaced 4 failures. Root-caused each rather than assuming they were implementation bugs: 2 (`backup.routes.test.ts` AC-10 validate, D1 lock-release) were artifacts of an unrelated concurrent test run started by mistake against the same live DB — both pass cleanly on an isolated re-run. 1 (`orgs-routes.test.ts` maxOrgs AC-10) is the already-documented pre-existing `system_settings`-singleton flake unrelated to this story. 1 was genuine: `route-audit.test.ts`'s static-classification check flagged `workers/backup-health-check.ts`'s new direct `getDb()` call (from Task 2's `resolveBackupMissedAlertIfActive()`) as unclassified — fixed by adding a `PLATFORM_JOB` entry to `apps/api/src/lib/route-exemptions.ts`'s `DIRECT_DB_ACCESS_CLASSIFICATIONS` array (commit `c6f28c9`), matching the existing `workers/key-custody-check.ts` precedent for instance-wide, non-org-scoped worker DB access. Final isolated re-run: route-audit + `src/modules/backup` + `src/workers` all green (254/254).

### File List

- `packages/db/src/index.ts` — modified (D1.3: `reserveConnection()`, module-scoped `postgres()` client)
- `packages/db/src/index.test.ts` — modified (D1.3 tests)
- `packages/shared/src/constants/operational-event-types.ts` — modified (D2/AC-11, AC-20 new event constants)
- `packages/shared/src/constants/operational-event-types.test.ts` — modified
- `apps/api/src/modules/backup/service.ts` — modified (D1: `acquireRestoreLock`, `RestoreLockResult`, `unlockAndRelease`)
- `apps/api/src/modules/backup/routes.ts` — modified (D1.9 filename pre-check, lock wiring, AC-20 audit log)
- `apps/api/src/modules/backup/schema.ts` — modified (new 400/409 response schemas)
- `apps/api/src/modules/backup/restore-lock.test.ts` — new (AC-1/AC-3/AC-4/AC-6/AC-6b/AC-7, D1.11)
- `apps/api/src/modules/backup/backup.routes.test.ts` — modified (AC-2/AC-3/AC-4/AC-5/AC-6/AC-20 HTTP-level coverage; fixture fixes for D1.9 regression)
- `apps/api/src/workers/backup-health-check.ts` — modified (D2: `resolveBackupMissedAlertIfActive`, `BackupHealthCheckDeps`; D3.4: `runStagingMaintenance`/orphan-cleanup/disk-pressure wiring)
- `apps/api/src/workers/backup-health-check.test.ts` — modified (AC-8 through AC-11 + failure-isolation coverage)
- `apps/api/src/workers/backup-health-check-staging.test.ts` — new (AC-16/AC-16b/D3.10 integration coverage, S3-configured env)
- `apps/api/src/workers/backup-snapshot.test.ts` — modified (AC-4 scheduled-cron-vs-restore coverage)
- `apps/api/src/modules/backup/atomic-write.ts` — new (D3.2: shared atomic temp-file+rename helper)
- `apps/api/src/modules/backup/atomic-write.test.ts` — new
- `apps/api/src/modules/backup/s3-upload.ts` — new (D3: `stageAndUploadToS3`, `isRetryableS3Error`, `cleanupOrphanedStagedFiles`, `stagingDirectoryUsage`, `resolveStagingPath`)
- `apps/api/src/modules/backup/s3-upload.test.ts` — new (AC-12 through AC-15, AC-16, AC-16b, D3.8/D3.10/D3.12/D3.13)
- `apps/api/src/modules/backup/storage.ts` — modified (delegates to `atomic-write.ts`/`s3-upload.ts`; `BackupStorage` interface unchanged)
- `apps/api/src/config/env.ts` — modified (D3.1/AC-18: `BACKUP_S3_STAGING_PATH`, `BACKUP_S3_STAGING_MAX_BYTES`)
- `apps/api/src/config/env.test.ts` — modified (AC-18 env validation matrix)
- `.env.example` — modified (documents both new vars, ephemeral-default caveat, `.staged.hold` convention)
- `docker-compose.yml` — modified (env passthrough + optional commented staging-volume example)
- `apps/api/src/lib/route-exemptions.ts` — modified (new `DIRECT_DB_ACCESS_CLASSIFICATIONS` entry for `workers/backup-health-check.ts`)
