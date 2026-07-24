# Operational Runbook & Deployment Guide

Continuation of [`docs/operator-quickstart.md`](operator-quickstart.md) (zero → eval-ready) for
**after** a healthy instance exists: upgrades, backups, key management, incident response,
monitoring, and quarterly maintenance. The "Vault Lifecycle" section below restates the
init/unseal ceremony so an operator mid-incident can follow this file alone, without also opening
the quickstart.

Every procedure below cites the story/AC it transcribes so it can be re-verified against the
codebase as that behavior evolves — see each section's `<!-- Source: ... -->` comments.

**Web UI available (Story 9.7):** most `curl`-based procedures below (backup trigger/list/restore/
validate, system settings, multi-org provisioning, resource-usage monitoring, version/upgrade info,
and platform audit log search/verify/maintenance-mode) also have an equivalent screen in the
**Platform Admin** web UI (`/platform`, visible only to the platform operator — the first user
registered on the instance). The commands below remain the authoritative, scriptable reference
(and the only option if the web app isn't reachable); the web UI is a convenience layer on top of
the same endpoints, with the same limitations (no live backup-job progress polling, no in-app
upgrade-trigger button — see Story 9.7 D3/D4).

---

## Vault Lifecycle

### First-time deployment

<!-- Source: Story 9.5 AC-2; verified against apps/api/src/modules/vault/{routes,key-service,schema}.ts, docker-compose.yml, docker-compose.prod.yml, Makefile -->

1. **Configure secrets.**

   ```bash
   cp .env.example .env
   # Required in production unless VAULT_ALLOW_REMOTE_INIT=true (dev-only, never set true in prod):
   export VAULT_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"
   ```

   Never leave `VAULT_BOOTSTRAP_TOKEN` blank in production. Setting `VAULT_ALLOW_REMOTE_INIT=true`
   disables this protection entirely — it is a local-dev convenience only, matching
   `docs/operator-quickstart.md`'s existing warning. Do not use it as a production shortcut.

2. **Start the stack.**

   ```bash
   # Production:
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
   # (equivalent: make docker-prod)

   # Eval/dev:
   make bootstrap-docker
   ```

   Either path runs the one-shot `migrate` service to completion before `api` starts (see
   Upgrades § In-place version upgrade).

3. **Initialize the vault** — `POST /api/v1/vault/init`, header `X-Vault-Bootstrap-Token: <token>`.
   Body shape depends on the chosen `kmsType` (`'kms'` does not exist — see Master Key Management
   § KMS integration status):

   ```bash
   # passphrase mode
   curl -X POST http://localhost:3000/api/v1/vault/init \
     -H 'Content-Type: application/json' \
     -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
     -d '{"kmsType":"passphrase","passphrase":"<at least 12 characters>"}'

   # envelope mode (recommended for production — split-key custody)
   openssl rand -hex 16   # → set as VAULT_ENVELOPE_KEY_HALF in the api container's env
   openssl rand -out dev-secrets/envelope-half.bin 16   # file-half, under VAULT_KEY_DIR
   curl -X POST http://localhost:3000/api/v1/vault/init \
     -H 'Content-Type: application/json' \
     -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
     -d '{"kmsType":"envelope","envelopeKeyPath":"/run/secrets/envelope-half.bin","acknowledgeSplitKeyModel":true}'

   # file mode (downgraded option — explicit acknowledgment required, not recommended for production)
   openssl rand -out dev-secrets/master.key 32
   curl -X POST http://localhost:3000/api/v1/vault/init \
     -H 'Content-Type: application/json' \
     -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
     -d '{"kmsType":"file","masterKeyPath":"/run/secrets/master.key","acknowledgeCoLocationRisk":true}'
   ```

   **The `dev-secrets/...` host path above only works as shown for the eval/dev compose path** —
   `docker-compose.yml`'s `api` service bind-mounts `./dev-secrets:/run/secrets:ro`, so a file
   written to `dev-secrets/` on the host appears at `/run/secrets/` inside the container. The
   **production** override (`docker-compose.prod.yml`) replaces that bind mount with a named Docker
   volume (`vault_keys:/run/secrets:ro`) that is not backed by any host directory — writing to
   `dev-secrets/` on a production host does **not** put the file where the container can read it.
   To get key material into `vault_keys` for a real production deployment, write it via a
   throwaway container mounting the same volume, e.g.:

   ```bash
   docker run --rm -v vault_keys:/run/secrets -v "$PWD":/host:ro busybox \
     sh -c 'cp /host/envelope-half.bin /run/secrets/envelope-half.bin'
   ```

   (substitute `master.key` for `file` mode). Then reference the same `/run/secrets/...` path in
   the `init`/`unseal` request bodies either way — only how that path gets populated differs
   between dev and production.

   Success: `200 {"initialized":true,"keyVersion":1,"kmsType":"<passphrase|envelope|file>"}`.
   Re-running `init` against an already-initialized vault returns `409 {"error":"already_initialized", ...}`
   — this is expected and safe (idempotent-to-fail, not destructive); proceed to "Manual unseal"
   below instead.

4. **Unseal.** First unseal happens automatically as part of a successful `init` call above — the
   vault is unsealed immediately on init, no separate call needed the very first time. For every
   subsequent seal (restart, crash, planned maintenance), see "Manual unseal" below.

5. **Register the first user** — `POST /api/v1/auth/register`:

   ```bash
   curl -s -X POST http://localhost:3000/api/v1/auth/register \
     -H 'Content-Type: application/json' \
     -d '{"email":"owner@acme.example","password":"correct-horse-battery-staple","orgName":"Acme Corp"}'
   ```

   The **first user ever registered on the instance** (not per-org) is automatically granted
   platform operator status — the role this runbook's backup/restore/audit/key-management
   procedures require. Registration does not auto-login; sign in separately.

6. **Verify.**

   ```bash
   curl -sf http://localhost:3000/health          # {"status":"ok","version":"..."}
   curl -sf http://localhost:3000/ready            # {"status":"ready"}
   ```

### Normal startup and shutdown

<!-- Source: Story 9.5 AC-3; verified against docker-compose.yml (stop_grace_period: 30s on api) -->

- **Startup:** `docker compose up -d` (or the prod-override equivalent) followed by a **manual
  unseal** (below) — the vault never auto-unseals on container start; the master key/passphrase is
  never persisted in a way that would allow it (Story 1.5).
- **Shutdown — data-preserving:** `docker compose down` (containers stop, volumes untouched).
- **Shutdown — destructive:** `docker compose down -v` **destroys the Postgres volume.** Never run
  this against a production volume without a fresh, verified backup in hand first (see Backup &
  Recovery). The two flags differ by a single character — read twice before running either.
- The `api` container has a 30-second graceful-shutdown window (`stop_grace_period: 30s` in
  `docker-compose.yml`). Always stop it with `docker compose down`/`stop` (sends `SIGTERM`), never
  `docker kill`/`kill -9` (`SIGKILL`) in normal operation — a force-kill can interrupt an in-flight
  operation (e.g. a restore) mid-write.

### Manual unseal after unexpected seal

<!-- Source: Story 9.5 AC-4; verified against apps/api/src/modules/vault/{routes,key-service,schema}.ts -->

`POST /api/v1/vault/unseal` — body depends on the instance's `kmsType` (exactly one field,
matching whatever mode the instance was initialized with):

```bash
# passphrase mode
curl -X POST http://localhost:3000/api/v1/vault/unseal \
  -H 'Content-Type: application/json' -d '{"passphrase":"<the same passphrase from init>"}'

# envelope mode — VAULT_ENVELOPE_KEY_HALF is read from the container's own environment
# automatically; you only supply the file-half path (not already available to a fresh container)
curl -X POST http://localhost:3000/api/v1/vault/unseal \
  -H 'Content-Type: application/json' -d '{"envelopeKeyPath":"/run/secrets/envelope-half.bin"}'

# file mode
curl -X POST http://localhost:3000/api/v1/vault/unseal \
  -H 'Content-Type: application/json' -d '{"masterKeyPath":"/run/secrets/master.key"}'
```

Success: `200 {"unsealed":true,"keyVersion":<n>,"kmsType":"..."}`. Verify with
`curl -sf http://localhost:3000/ready` → `{"status":"ready"}` (no restart needed — the flip is
immediate on the same request/response cycle) or `curl -sf http://localhost:3000/health`.

**Wrong passphrase / key material:** `401 {"error":"unseal_failed","message":"Vault unseal failed: credentials do not match stored vault configuration."}`.
The unseal endpoint is rate-limited to **5 requests per minute per IP** — repeated guesses will
eventually be throttled (`429`), not locked permanently. Stop and verify your passphrase/key
source (e.g. password manager) rather than retrying blindly.

**Envelope mode, missing file half:** if the file at `envelopeKeyPath` does not exist (or is not a
regular file under `VAULT_KEY_DIR`), the response is `400 {"error":"key_file_not_found", ...}` —
a distinct failure mode from a wrong-passphrase rejection. This means the file-half artifact is
missing from this container, not that the credentials are wrong. Restore it from its original
secure storage location (documented at init time) before treating this as a lost-key scenario (see
Master Key Management § Lost key file).

### Unexpected seal mid-operation — triage decision tree

<!-- Source: Story 9.5 AC-5; verified against apps/api/src/routes/health.ts -->

1. **Check `GET /ready` first.** The actual response shape on any non-ready state is
   `503 {"status":"unavailable","reason":"<uninitialized|sealed|db>", ...}`:
   - `reason: "sealed"` → proceed straight to "Manual unseal" above.
   - `reason: "db"` → Postgres is unreachable. This is **not** a vault problem — do not attempt an
     unseal call (it will fail or hang against an unreachable database). Run `make db-up` or check
     `DATABASE_URL` / the `db` container's health first.
   - `reason: "uninitialized"` on a previously-`ready` instance should not happen. If seen, treat
     it as a possible volume/data-loss incident (see Incident Response), not a routine reseal.
2. **Check container logs** for the specific trigger:
   - OOM-kill: `docker inspect --format='{{.State.OOMKilled}}' <api-container>`.
   - Crash/panic: `docker compose logs api` for structured error-level log lines around the seal
     event.
   - Deliberate action: confirm with the team whether someone else restarted the container or
     called an unseal-adjacent endpoint before you unseal into a possibly-unintended state.
3. **Remediate by cause**, then unseal: OOM → raise the container memory limit first; crash →
   capture the log excerpt before restarting (it scrolls away otherwise); deliberate → confirm with
   the team first.

**Repeated unexpected reseals** (e.g. multiple OOM-kills within an hour) are not a series of
isolated one-off unseals — escalate to Incident Response § Vault unreachable.

For local-dev / hot-reload workflows instead of a production-style deploy, see
[`docs/operator-quickstart.md`](operator-quickstart.md).

---

## Upgrades

### In-place version upgrade

<!-- Source: Story 9.5 AC-6; verified against docker-compose.yml, packages/db/src/scripts/guarded-migrate.ts, apps/api/src/routes/openapi.ts, apps/api/src/app.ts -->

1. Pull the new image (`docker compose pull`) or update the pinned tag/digest in
   `docker-compose.prod.yml`.
2. `docker compose up -d` — the one-shot `migrate` service (`docker-compose.yml`) runs
   `pnpm --filter @project-vault/db db:migrate` (the guarded wrapper,
   `packages/db/src/scripts/guarded-migrate.ts`) before `api` starts, since `api` depends on
   `migrate` completing successfully. A destructive migration aborts the wrapper with a non-zero
   exit code (see § Identifying a destructive migration below) — `api` then **never starts**,
   leaving whatever was running before (if not yet torn down) as the last known-good state. Do not
   force-start `api` against a database mid-refusal.
3. Verify: `curl -sf http://localhost:3000/ready` → `{"status":"ready"}`. Optionally spot-check the
   deployed version via `GET /api/v1/openapi.json`'s `info.version` field — this is sourced live
   from `apps/api/package.json` at request time, not a hardcoded placeholder. **Note:** this route
   (and the Swagger UI at `/api/v1/docs`) is only registered when `ENABLE_API_DOCS=true` or
   `NODE_ENV` is `development`/`test` — it is **off by default in production**. Set
   `ENABLE_API_DOCS=true` deliberately (e.g. behind your own reverse-proxy auth) if you want this
   check available; otherwise rely on `/health`'s `version` field
   (`curl -sf http://localhost:3000/health` → `{"status":"ok","version":"..."}`) instead.

The first `docker compose up` after a fresh image pull can be slow — the `migrate` service rebuilds
the API builder image to run the migration command (a known, accepted tradeoff, see
`deferred-work.md` D4). This is progress, not a hang.

### Identifying a destructive migration and the offline migration path

<!-- Source: Story 9.5 AC-7 (D2); verified against scripts/migration-compatibility-check.ts, packages/db/src/scripts/guarded-migrate.ts, packages/db/src/lib/migration-safety.ts, root package.json -->

**Pre-flight check** (before an upgrade, no database connection required — a pure static scan of
every committed migration file):

```bash
pnpm check-migration-compatibility
```

> Note on wording: this is the correct, currently-shipped command
> (`package.json`'s `"check-migration-compatibility"` script, which runs
> `tsx scripts/migration-compatibility-check.ts`). Some older planning documents refer to it as
> `pnpm migration-compatibility-check` — that is the filename, not the script name; the command
> above is the one that actually runs.

Exits `0` if no committed migration is destructive. If one or more are, it prints every offending
file/finding and exits non-zero — no data or database is touched by this check either way.

**Runtime refusal.** Independently of the pre-flight check, the guarded `db:migrate` wrapper
refuses any **pending** destructive migration automatically during the upgrade's `docker compose
up -d` step (AC-6 above), whether or not you pre-checked. The exact refusal text it writes to
stderr (verified verbatim against `packages/db/src/scripts/guarded-migrate.ts`'s
`buildRefusalMessage()`):

```
FATAL: migration 0036_drop_legacy_column.sql contains a destructive operation:
  DROP COLUMN (line 3)
In-place auto-migration refuses destructive schema changes (AC-E9b).
Follow the documented offline migration procedure (see docs/runbook.md § Upgrades),
or re-run with --allow-destructive if you have already completed that procedure.
```

(The per-finding line is the operation label plus a line number — e.g. `DROP COLUMN (line 3)`,
`DROP TABLE (line 7)`, `RENAME COLUMN (line 2)` — it does not name the specific column/table being
dropped; read the cited migration file directly for that detail.)

**Offline migration path**, once a genuine destructive change must ship:

1. Take a fresh, verified backup first (see Backup & Recovery § Manual trigger and § Quarterly
   validation) — never attempt a destructive migration without one in hand.
2. Stop the API container so no traffic hits the database mid-migration: `docker compose stop api`.
3. Manually review the destructive statement's data impact (e.g. confirm a `DROP COLUMN` target is
   genuinely unused, not silently relied on elsewhere).
4. Run the migration explicitly with the escape hatch:
   `pnpm --filter @project-vault/db db:migrate --allow-destructive`.
5. Verify data integrity post-migration (spot-check row counts; run the app's own test suite
   against a staging copy first if at all possible).
6. Restart the API and verify: `docker compose up -d api && curl -sf http://localhost:3000/ready`.

**Do not reflexively re-run with `--allow-destructive`** the moment you see a refusal. The scanner
has documented false-positive guards (e.g. an identifier merely containing the substring "rename"
is not flagged) — if you do see a refusal, it is a genuine keyword match. Read the named file/line
first; `--allow-destructive` bypasses the safety check entirely rather than re-verifying it.

### Phase 2 upgrade — multi-field secrets

<!-- Source: Story 13.1 AC-3, AC-7; verified against packages/db/src/migrations/0049_credentials_current_version_id_backfill.sql -->

Migration `0049_credentials_current_version_id_backfill.sql` adds `credentials.current_version_id`
(nullable, no default) and backfills it for every pre-existing credential, plus adds
`credential_versions.schema_version`/`field_meta` (safe, defaulted column additions — no
backfill UPDATE needed for those two). It is a **required, ordered prerequisite** for any later
Phase 2 (Structured Multi-Field Secrets) release: the migration must be applied and complete
before deploying any application version whose code assumes `current_version_id` is non-null.
Deploying such app code first will crash on any row the backfill hasn't yet reached, or read
`NULL` and mis-render.

1. Run `make db-migrate` (or the standard in-place upgrade procedure above) as part of the normal
   upgrade — no separate step is required, this ships like any other migration.
2. Confirm it completes with **zero skipped/orphaned rows** in the migration output before
   deploying the new application image. The migration logs a `RAISE NOTICE` per skipped
   (zero-version) credential, naming only its id (never `encrypted_value` or any plaintext field),
   plus a final summary line: `N credentials backfilled, M skipped (zero versions) - see notices
   above for ids`. A non-zero `M` is not a migration failure — the migration still exits `0` — but
   it does flag pre-existing orphaned credentials worth investigating separately.
3. **Re-run safety:** the backfill UPDATE is idempotent (guarded by
   `WHERE current_version_id IS NULL`) — if the migration step is interrupted (connection drop,
   deploy timeout), simply re-running `make db-migrate` is always the correct recovery action, no
   manual cleanup required.
4. **Maintenance window:** this backfill is a single, unbatched `UPDATE` (matching this repo's
   `0043`/`0044` precedent), validated for fleets up to low tens of thousands of credentials. If
   your `credentials` table is significantly larger, run this migration during a low-traffic
   maintenance window — an unbatched UPDATE at that scale can hold a table-level lock long enough
   to cause visible latency on concurrent credential reads/writes. No batching is implemented in
   this migration.

---

## Backup & Recovery

All four endpoints below are instance-wide (not org-scoped) and require platform operator status
(the role granted to the first-ever registered user, see Vault Lifecycle § First-time deployment).
A non-operator caller receives `403 {"code":"platform_operator_required", ...}`. There is no
per-org "back up my org's data only" option in v1 — backups are whole-instance.

### Triggering a manual backup and verifying it succeeded

<!-- Source: Story 9.5 AC-8; verified against apps/api/src/modules/backup/{routes,schema}.ts -->

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/backup/trigger \
  -H 'Authorization: Bearer <platform operator token>'
# → 202 {"data":{"jobId":"<uuid>","status":"running"}}
```

Poll for completion:

```bash
curl -s http://localhost:3000/api/v1/admin/backups \
  -H 'Authorization: Bearer <platform operator token>'
# → 200 {"data":{"items":[
#     {"filename":"backup_20260706T030000Z.vault","timestamp":"...","sizeBytes":48213,
#      "keyVersion":1,"verified":"unverified"}
#   ]}}
```

`verified` is one of `"unverified" | "valid" | "invalid"` (not a boolean) and starts
`"unverified"` immediately after trigger — run the validate step (below) before relying on a fresh
backup for a real restore.

**Triggering a second backup while one is already running is rejected, not queued:**
`409 {"code":"backup_already_running", "message":"A backup is already in progress...", "jobId":"<id>"}`.
Check `GET /api/v1/admin/backups` first to confirm no backup is already in progress before
triggering another.

### Full restore procedure, step by step

<!-- Source: Story 9.5 AC-9; verified against apps/api/src/modules/backup/{routes,schema}.ts -->

1. **Do not stop the API container** — the restore call in step 2 below is itself an HTTP request
   to the running `api` service; stopping it first makes that call impossible. If you want to
   reduce the chance of other requests racing the restore (e.g. a user writing data mid-restore),
   do so by other means that leave the API reachable — pause background workers, or take the
   instance out of any external load balancer/reverse-proxy rotation — not by stopping the
   container this procedure needs to call.
2. Call the restore endpoint with an explicit confirmation body:

   ```bash
   curl -s -X POST http://localhost:3000/api/v1/admin/backups/backup_20260705T030000Z.vault/restore \
     -H 'Authorization: Bearer <platform operator token>' \
     -H 'Content-Type: application/json' \
     -d '{"confirmRestore":true,"reason":"recovering from accidental credential deletion, incident #42"}'
   # → 200 {"data":{"restored":true,"filename":"backup_20260705T030000Z.vault","sealedAfterRestore":true}}
   ```

   `reason` is mandatory free text for your own incident record — this call **completes
   synchronously** (a direct `200`, not an async job you poll for). `confirmRestore: true` and a
   non-empty `reason` are both required; omitting either returns
   `400 {"code":"confirmation_required", ...}`.

3. **This is destructive: all current data is replaced with the backup's contents.** There is no
   partial/selective restore in v1.
4. After a successful restore the vault is **automatically sealed** — complete a manual unseal
   (Vault Lifecycle § Manual unseal) before the instance is usable again.
5. Post-restore verification: unseal, then `GET /ready` → `{"status":"ready"}`, then spot-check a
   known credential/project exists as expected.

Other outcomes: `404 {"code":"backup_not_found", ...}` (no such file); `422
{"code":"backup_checksum_mismatch", ...}` (refuses to restore a potentially corrupted/tampered
backup); `401 {"code":"backup_decrypt_failed", ...}` (could not decrypt with the current master
key — by design, this endpoint does not distinguish "wrong key" from "corrupted ciphertext",
matching Story 1.5's no-oracle unseal discipline); `500 {"code":"backup_restore_failed", ...}` (the
underlying `pg_restore`/`psql` subprocess failed after checksum verification passed — check server
logs).

Restoring a backup taken before a since-applied destructive migration (§ Upgrades) leaves the
restored schema mismatched with the currently-deployed application version — roll back the image
to match first, or treat it with the same offline-migration care as a destructive upgrade, not a
routine restore.

### Quarterly backup restore validation procedure

<!-- Source: Story 9.5 AC-10; verified against apps/api/src/modules/backup/{routes,schema}.ts -->

```bash
curl -s -X POST http://localhost:3000/api/v1/admin/backups/backup_20260706T030000Z.vault/validate \
  -H 'Authorization: Bearer <platform operator token>'
# → 200 {"data":{"valid":true,
#     "assetsPresent":{"credentials":true,"projects":true,"users":true,"auditEvents":true},
#     "checksum":"match"}}
```

This decrypts and structurally verifies the backup in an isolated, read-only context — **no live
data is modified.** Treat any `false` value in `assetsPresent` or `checksum: "mismatch"` as a
**failed** quarterly validation requiring immediate escalation (do not wait for next quarter — the
backup chain may be silently broken). Do not attempt a real restore from a failed-validation file;
trigger a fresh manual backup, validate that one, and investigate the storage destination (disk
corruption, S3 object corruption, interrupted write) for the older file's root cause. Record the
pass/fail result in your own change-management log (outside this application).

If `BACKUP_S3_BUCKET` is configured, wait for the backup's listing entry to show a stable
`sizeBytes` across two successive `GET /api/v1/admin/backups` polls before validating, to avoid a
false "mismatch" from validating a partially-propagated (eventually-consistent) upload.

### What to do when a backup has been missed for more than 24 hours

<!-- Source: Story 9.5 AC-11; verified against docker-compose.yml (BACKUP_SCHEDULE/BACKUP_MAX_AGE_HOURS defaults), apps/api/src/workers/backup-health-check.ts, apps/api/src/modules/backup/{routes,alerts}.ts -->

The `backup.missed` alert fires once the most recent successful backup is older than
`BACKUP_MAX_AGE_HOURS` (default **25** hours — already includes slack over the 24h RPO for timing
drift, so a firing alert reliably means the RPO is currently at risk, not a false positive). The
scheduled backup job runs per `BACKUP_SCHEDULE` (default `0 3 * * *`, i.e. daily at 03:00 UTC).

1. Check operational logs around the missed window for a `backup.failure` alert or job-error log
   entry (note: the alert type is `backup.failure`, singular past-tense "failure", not "failed").
2. If it failed with a storage error (`BACKUP_S3_BUCKET` unreachable, disk full at
   `BACKUP_STORAGE_PATH`), remediate the storage destination first.
3. Trigger a manual backup immediately (§ Triggering a manual backup) rather than waiting for the
   next scheduled run.
4. Confirm `GET /api/v1/admin/backups` shows the new, successful entry. **Note:** `GET /ready`'s
   `warnings` array only ever surfaces `audit_storage_critical`/`key_custody_risk` (§ Monitoring) —
   there is no backup-related `/ready` warning to watch for clearing; the backups listing above is
   the only confirmation this step has.

Do not silence/acknowledge the alert without confirming a fresh, valid backup exists. Backups can
be entirely disabled for operators using external backup tooling — unset `BACKUP_STORAGE_PATH`,
`BACKUP_S3_BUCKET`, **and** `BACKUP_DATABASE_URL` together; leaving `BACKUP_DATABASE_URL` set while
unsetting only the two storage vars is an inconsistent configuration the app refuses to boot with
(`FATAL: Backup is enabled but neither BACKUP_STORAGE_PATH nor BACKUP_S3_BUCKET is configured`) —
a loud startup failure, not a silent misconfiguration, but still worth knowing in advance rather
than hitting at restart time. With all three unset, `backup.missed` should never fire; if it does
fire on an instance believed to have backups disabled, that is itself a configuration-drift
incident (verify the disable setting actually took effect), not a normal missed-backup scenario.

---

## Master Key Management

### Rotating the master key (manual procedure, v1 scope) — and a disclosed limitation

<!-- Source: Story 9.5 AC-12 (D7); verified against packages/db/src/schema/vault-state.ts, apps/api/src/workers/key-custody-check.ts -->

There is **no rotation-execution HTTP endpoint** anywhere in this codebase for the vault master
key (FR101 is unrelated — it covers machine-user API key rotation only, Epic 7). Rotation is a
manual, offline, out-of-band procedure:

1. Generate new key material (mode-dependent): a new passphrase for `'passphrase'` mode, or new
   env-half/file-half values for `'envelope'` mode.
2. Take the API offline and re-run the equivalent of the init-time key-derivation/sentinel-encrypt
   sequence with the new material, bumping the stored key version — this is an offline maintenance
   operation, not an HTTP call (no endpoint exists to do this online).
3. Re-seal and re-unseal with the new key material to confirm it decrypts correctly before
   considering the rotation complete.
4. Take a fresh backup immediately after rotation. The backup encryption key is itself derived from
   the master key (HKDF), so a backup taken under the *old* key remains restorable via
   key-version-aware decryption — but a fresh post-rotation backup is good hygiene regardless.

**Disclosed limitation:** rotating the master key via this manual procedure does **not** update
`vault_state.key_rotated_at` — no application code path advances that column past its migration-time
backfill (it is set once, to `initialized_at`, and never updated again). The age-based key-custody
alert (`key_custody_risk`, fires by default after `KEY_ROTATION_MAX_AGE_DAYS` = 365 days since
`key_rotated_at`) therefore **continues using the original init timestamp regardless of any manual
rotation you perform, and will fire again on schedule even immediately after a real rotation.**
This is a known, disclosed gap (tracked from Story 9.2) — there is no in-app remediation available
today. Track your actual rotation history outside the application; do not expect the alert to
reflect it.

`'file'` mode has the weakest rotation story (no split-key defense-in-depth — replace the raw file
and re-encrypt the sentinel with no independent second custodian). Operators on `'file'` mode
should migrate to `'envelope'` mode (a full re-init with data migration — there is no in-place
mode-conversion endpoint) rather than repeatedly rotating within `'file'` mode.

### What to do if the key file is lost (unrecoverable) — and how to prevent it

<!-- Source: Story 9.5 AC-13 -->

**If the key material required to unseal is genuinely lost (deleted with no backup, or a
`'passphrase'`-mode passphrase forgotten with no password-manager record), the data is
unrecoverable.** There is no master-key-recovery mechanism, backdoor, or support escalation path
that can decrypt existing data without the original key material — this is a deliberate
architectural property (AES-256-GCM under a master-key-derived key hierarchy). Losing the master
key is equivalent to losing every secret, credential, and audit-log signing key it protects.

The only "recovery" is restoring from a backup encrypted under a **still-available** key — which
itself requires the backup's own key material (HKDF-derived from the same master key), meaning a
truly lost master key also makes all of its own backups permanently unreadable.

Raw database access (e.g. `psql` as the `postgres` superuser) **cannot** recover data without the
key — the ciphertext is opaque without it, and there is no partial-recovery or
brute-force-feasible path (256-bit key space). Do not attempt this as a "recovery" path.

**Prevention, not recovery:**

- Use `'envelope'` mode (split env-half/file-half) with each half stored under genuinely
  independent custody (e.g. an env var in a secrets manager plus a file in a separate secure
  location) — a single lost artifact is then not immediately fatal.
- Never use `'file'` mode for production (single key file, no split-key defense).
- Maintain key material under the same operational discipline as your backups: independent,
  tested, access-controlled storage.

### KMS integration status and configuration

<!-- Source: Story 1.14 (supersedes Story 9.5 AC-14/D6's "not implemented" disclosure); verified
     against packages/db/src/schema/vault-state.ts, apps/api/src/modules/vault/schema.ts, and
     apps/api/src/modules/vault/kms-provider.ts as of Story 1.14. -->

**As of Story 1.14, AWS KMS-backed unsealing (`kmsType: 'kms'`) is implemented.** V1 scope is
AWS KMS only (not GCP KMS or HashiCorp Vault Transit — see the story's "KMS Backend Decision"
Dev Note), behind a small `KmsKeyProvider` interface that keeps the door open for a future
provider without revisiting the core init/unseal logic.

**How it works:** at init, the server calls AWS KMS `GenerateDataKey` to obtain a plaintext data
key (used once to derive the vault's keys, then zeroed — never stored) and an encrypted
("wrapped") copy of that same key, which is the only thing persisted in `vault_state`
(`kms_key_id`, `kms_encrypted_dek`). At unseal, the server calls AWS KMS `Decrypt` on the stored
wrapped key to recover the same plaintext data key and re-derive the vault's keys — no passphrase,
key file, or envelope half is ever supplied by the operator in this mode.

**Init:**

```bash
curl -X POST http://localhost:3000/api/v1/vault/init \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kmsType":"kms","kmsKeyId":"arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr"}'
# → 200 { "initialized": true, "keyVersion": 1, "kmsType": "kms" }
```

`kmsKeyId` may be a full key ARN or a `alias/...` KMS alias.

**Unseal (every restart) — empty body, no credentials in the request:**

```bash
curl -X POST http://localhost:3000/api/v1/vault/unseal -H "Content-Type: application/json" -d '{}'
# → 200 { "unsealed": true, "keyVersion": 1, "kmsType": "kms" }
```

**IAM permissions required** on the API process's AWS credentials (ambient IAM role, or
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — the same credential-provider-chain pattern already
used for S3 backup storage):

- `kms:GenerateDataKey` on the configured key — required at init only.
- `kms:Decrypt` on the configured key — required at every unseal.

No credentials env var is required specifically for KMS — the AWS SDK's standard
credential-provider chain is used, and the only KMS-specific configuration is the optional
`VAULT_KMS_ENDPOINT` (LocalStack/test-only KMSClient endpoint override; never set in production).

**KMS key-loss procedure (permanent data-loss risk):** if the configured KMS key is deleted,
disabled, or scheduled for deletion, unseal fails with `503 kms_key_unavailable` — the KMS-mode
equivalent of losing a `file`-mode key file. AWS KMS supports a 7–30 day pending-deletion recovery
window; restoring or re-enabling the key within that window and retrying unseal recovers the
vault. After that window elapses, the vault's data is **permanently unrecoverable** — treat KMS
key deletion protection (`kms:ScheduleKeyDeletion` restrictions, deletion-window settings) with the
same operational discipline as backup custody.

**Other failure modes an operator may see:**

- `503 kms_unreachable` — network/timeout/throttling talking to AWS KMS; safe to retry once
  connectivity is restored. Distinct from `kms_key_unavailable` above — this means "try again,"
  not "the key may be gone."
- `403 kms_permission_denied` — the API's AWS credentials lack `kms:GenerateDataKey` (init) or
  `kms:Decrypt` (unseal) on the configured key. Verify the IAM/key policy.
- `400 kms_key_not_found` (init only) — the `kmsKeyId` does not exist, or is currently disabled/
  pending deletion, in the configured AWS region.

Credential rotation (IAM role session refresh, or an operator swapping env vars and restarting)
between init and a later unseal is transparent by construction — the server never stores or
depends on init-time credentials; each request resolves credentials fresh via the AWS SDK's
standard chain.

---

## Credential Version Retention

<!-- Doc reconciliation, 2026-07-09: closes deferred-work.md D2 ("Epic 2 closure retrospective")
     and its "Operations & production" duplicate entry — verified against
     apps/api/src/workers/prune-credential-versions.ts and apps/api/src/config/env.ts. -->

### `CREDENTIAL_RETENTION_DRY_RUN` — enabling destructive version purge

Each credential's `retentionCount` (set at creation, per-credential) bounds how many historical
versions are kept; older, non-current, non-rotation-locked versions are candidates for the retention
worker to purge. Purging is **irreversible** — a purged version's `encryptedValue` is zero-overwritten
then set to `null` and cannot be recovered from the live database (only from a pre-purge backup
snapshot, see § Backup & Recovery).

`CREDENTIAL_RETENTION_DRY_RUN` (env var, boolean) controls whether the worker actually purges or only
logs what it *would* purge:

- **Production defaults to `true` (dry-run)** — `apps/api/src/config/env.ts` sets the default from
  `isProduction`, so a fresh production deployment never purges anything until an operator explicitly
  overrides it. Every run instead emits a `CREDENTIAL_RETENTION_DRY_RUN` operational log line per
  purge-eligible version (`credentialId`, `versionNumber`) plus a per-org summary
  (`credentialsScanned`, `versionsWouldPurge`).
- **Development/test default to `false`** (destructive) — for local test coverage; not relevant to
  production rollout.

**Recommended rollout procedure for a new production deployment:**

1. Leave `CREDENTIAL_RETENTION_DRY_RUN` unset (or explicitly `true`) for at least one full retention
   worker run cycle after go-live. Confirm the worker is actually running (check for
   `CREDENTIAL_RETENTION_DRY_RUN`-tagged log lines in your log aggregator — zero log lines with
   credentials present in the org usually means the worker isn't scheduled, not that nothing is
   purge-eligible).
2. Review the dry-run summary log lines' `versionsWouldPurge` counts against your own expectations for
   how many old versions each project's credentials should realistically have accumulated. Investigate
   before proceeding if the count looks implausibly high (may indicate a `retentionCount` misconfiguration
   rather than a worker bug).
3. Take a fresh backup snapshot (§ Triggering a manual backup) immediately before flipping the flag —
   this is your only recovery path if a purge turns out to be wrong.
4. Set `CREDENTIAL_RETENTION_DRY_RUN=false` and restart the API process so the worker picks up the new
   value.
5. After the next run, confirm the `CREDENTIAL_RETENTION_SUMMARY` log lines' `versionsPurged` counts
   are consistent with the dry-run's `versionsWouldPurge` counts from step 2 (they should match closely;
   a large discrepancy suggests new versions were created between the dry-run and the real run, which is
   expected under normal usage, not a defect).

**Rotation-in-progress exemption:** a version that is the current active credential value for an
in-progress rotation is exempt from purge until the rotation completes or is abandoned
(`rotationLockedAt` guard in `purgeCandidatesForCredential`/`purgeVersion`) — this is enforced
automatically and requires no operator action, but is worth knowing about if a `versionsWouldPurge`
count looks lower than expected for a project with active rotations.

**Every purge is audited:** each purged version writes a `credential.version_purged` entry to the
tamper-evident audit log (`payload: { credentialId, versionNumber }`) in the same transaction as the
purge — query the audit log (§ Verifying audit log integrity) if you need to reconstruct exactly which
versions were purged and when.

---

## Incident Response

### "Vault unreachable" triage flowchart

<!-- Source: Story 9.5 AC-15; verified against apps/api/src/routes/metrics.ts (db_pool_connections_active) -->

A strictly worse condition than a sealed-but-responsive vault (§ Vault Lifecycle) — no HTTP
response at all.

1. **Container not running at all.** `docker compose ps` shows `api` exited/restarting. Check
   `docker compose logs api` for a crash-loop — most commonly a failed startup env-var validation
   (a Zod schema failure — the exact message names the specific missing/invalid variable; see
   `docs/operator-quickstart.md`'s "Common failures" section) or an unrecovered OOM-kill loop.
2. **Container running but not responding.** Check `docker compose logs api` for a hang (e.g. a
   stuck migration, § Upgrades). Check Postgres reachability independently
   (`docker compose logs db`, or `docker compose exec db pg_isready`).
3. **Container responding but `/health`/`/ready` both time out.** Check for connection-pool
   exhaustion (the `db_pool_connections_active` Prometheus gauge, § Monitoring — a sustained high
   value indicates this failure mode) or an event-loop-blocking bug (check CPU usage; Node.js is
   single-threaded for non-worker-thread code).

Each branch ends in a concrete remediation: restart the specific failed component, or — if the
failure correlates exactly with a just-completed upgrade — roll back to the last-known-good image
tag (often faster and safer than deep triage, **provided no destructive migration was part of the
failed upgrade**, which would make a rollback unsafe without the offline procedure). Only escalate
to a full restore (Backup & Recovery § Full restore) if data corruption — not just unavailability —
is suspected; do not reach for a destructive, hours-long restore reflexively before ruling out a
simple container-crash-loop.

### Audit log storage at 95% capacity — export-and-prune procedure

<!-- Source: Story 9.5 AC-16; verified against apps/api/src/workers/audit-storage-check.ts, apps/api/src/routes/health.ts, .env.example -->

Fires when audit storage crosses the 95% `AUDIT_LOG_STORAGE_LIMIT_GB` threshold (default **50GB**)
and maintenance mode activates (routine audit writes suspended, replaced with `WARN`-level
structured log entries — **security-critical event types are never suspended**, even during
maintenance mode).

1. Confirm the condition: `GET /ready` → `{"status":"ready","warnings":["audit_storage_critical"]}`.
2. Identify the responsible org(s) via the alert payload's `topContributingOrgs` breakdown — an
   array of `{orgId, bytesAdded, rowsAdded}`, the top 5 orgs by growth — rather than guessing.
3. Export the audit log for compliance retention **before** pruning anything (Story 8.2's export
   mechanism) — `audit_log_entries` is the org's compliance record; never prune without a
   completed, verified export first.
4. Prune entries older than the org's configured retention period via the existing retention-purge
   mechanism (Organization Admins configure retention within tier limits, FR70).
5. Re-check storage utilization drops below the 80% tier and confirm `/ready` no longer reports the
   warning.
6. Review the `WARN`-level log lines queued during the suspension window — these are the
   operational record of what happened while maintenance mode was active; the export step does not
   recover them (they were legitimately suspended, non-security-critical events), but they should
   still be reviewed, not discarded.

If the responsible org disputes the growth is illegitimate, that is a business/product
conversation (e.g. guide a legitimately high-activity org toward a tier upgrade of their
audit-log-entries limit) — not something resolved by deleting their data faster. Export-and-prune
buys time; it does not replace addressing root cause.

### Break-glass rotation post-incident sweep checklist

<!-- Source: Story 9.5 AC-17; verified against apps/api/src/modules/rotation/routes.ts (POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass) -->

After `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass` (Story
5.3) is used during an incident:

1. Confirm the old credential value is actually revoked/rotated in the target system, not just
   marked rotated in Project Vault.
2. Verify the break-glass action produced the expected audit trail entries (a
   `rotation.break_glass`-tagged `audit_log_entries` row, plus a superseded-rotation entry if a
   prior rotation was in flight) and that they are visible via the standard org-scoped audit
   search.
3. Confirm the rotation web UI's client-side secrets-clearing hardening (Story 8.5) functioned for
   this incident — no lingering plaintext new-value in browser memory/devtools after the emergency
   action.
4. Review whether the incident requires a broader credential sweep — were any dependent credentials
   (Story 2.4's dependency tracking) also potentially exposed and requiring their own rotation? "No
   dependents configured" is a valid fast answer, but confirm it reflects reality (dependents were
   actually recorded in Project Vault), not an unconfigured gap masquerading as "nothing to worry
   about."
5. Document the incident timeline and root cause in your own incident record (outside this
   application).

Do not close the incident the moment the break-glass rotation itself succeeds — the rotation
succeeding is necessary but not sufficient; skipping the dependency-sweep step (item 4) risks
leaving a genuinely compromised dependent credential unaddressed.

### Compromised machine user API key — emergency revoke procedure

<!-- Source: Story 9.5 AC-18; verified against apps/api/src/modules/machine-users/routes.ts (POST .../emergency-revoke) -->

```bash
curl -s -X POST http://localhost:3000/api/v1/machine-users/mu_abc123/api-keys/pk_9f3aB7xQ.../emergency-revoke \
  -H 'Authorization: Bearer <org admin token, MFA verified>'
# → 200 {"data":{"revokedKeyId":"<uuid>","newKey":"<plaintext, shown only this once>","newKeyId":"<uuid>"}}
```

No request body. This is an **atomic revoke-old + issue-new operation in a single call** —
deliberately distinct from both the routine `.../rotate` endpoint's overlap-based zero-downtime
rotation (the old key here stops working *immediately*, with no overlap window, since a suspected
compromise means it must stop working *now*) and from a plain revoke — there is no separate
"issue a replacement key" step because the replacement is already in this response. **Capture
`newKey` immediately: like every other key-issuance response in this API, the plaintext is
returned exactly once and is not recoverable from any later `GET` call.** Requires MFA on the
calling admin session (`403 {"code":"mfa_required"}` if not MFA-verified — a stolen session alone
must not be sufficient to interfere with key-compromise response) and is itself rate-limited; do
not interpret a rate-limit response as the revoke having silently failed.

Post-revoke:

1. Confirm via the key list (`GET .../api-keys`) that the old key's `isRevoked` is now `true` — the
   list view exposes a boolean flag here, not a `revokedAt` timestamp.
2. Update the CI/CD or automation system's stored credential with the `newKey` captured above —
   there is no separate create-new-key step to perform; re-running `.../rotate` or
   `.../emergency-revoke` against the now-revoked old key instead returns
   `409 {"code":"api_key_already_revoked", "message":"This key has already been revoked"}`.
3. Review the audit trail for any usage of the compromised key between suspected exposure and
   revocation, to scope the incident.

---

## Monitoring

### Scraping Prometheus metrics

<!-- Source: Story 9.5 AC-19; verified against apps/api/src/routes/metrics.ts, apps/api/src/modules/rotation/metrics.ts -->

`GET /metrics` is bound loopback-only by default — any caller whose remote address is not
`127.0.0.1`/`::1` receives `403 {"error":"Forbidden"}` unless `metricsBindHost` is explicitly
configured to `0.0.0.0`. This is a deliberate default-secure posture; scrape from a
sidecar/same-host collector to stay within the loopback-only default, or configure the bind host
deliberately if you need external scraping.

Verified, currently-shipped metric set (not aspirational — cross-checked directly against
`apps/api/src/routes/metrics.ts` and `apps/api/src/modules/rotation/metrics.ts`):

| Metric | Meaning |
|---|---|
| `http_requests_total` | Per-route request count, labeled `method`/`route`/`status_code` |
| `http_request_duration_seconds` | Per-route request latency histogram, same labels |
| `process_uptime_seconds` | Process uptime |
| `vault_sealed` | **1** if sealed or uninitialized, **0** if unsealed — the single most important dashboard tile for this application |
| `db_pool_connections_active` | In-flight query count — sustained high values indicate connection-pool exhaustion (§ Incident Response) |
| `rotation_initiations_total`, `rotation_completions_total`, `rotation_checklist_items_pending_total`, `rotation_break_glass_total` (+ related stale/recovery counters/gauges) | Rotation-lifecycle metrics (Epic 5) |
| Node.js default process metrics | via `collectDefaultMetrics()` |

Recommended alerting: `vault_sealed == 1` for more than 2 minutes (an unattended reseal, worth
paging on) plus a sustained `db_pool_connections_active` threshold.

**A metric that does not exist despite being mentioned in planning docs:** the architecture
document's prose mentions a "pg-boss queue depth" metric as planned; no such metric is implemented
as of Epic 9. This is a documentation-drift item in that other document, not a gap in this list —
this table only lists metrics verified to exist in code.

### Key alert types and recommended response actions

<!-- Source: Story 9.5 AC-20; verified against apps/api/src/workers/{backup-health-check,key-custody-check,audit-storage-check,resource-usage-check,user-dormancy-check,check-failed-auth-threshold}.ts -->

| Alert type | First response |
|---|---|
| `backup.missed` / `backup.failure` | § Backup & Recovery → What to do when a backup has been missed |
| `key_custody_risk` (key age > `KEY_ROTATION_MAX_AGE_DAYS`, default 365 days) | § Master Key Management → Rotating the master key / Lost key file / KMS status |
| `audit_storage_critical` (95% of `AUDIT_LOG_STORAGE_LIMIT_GB`) | § Incident Response → Audit log storage at 95% capacity |
| `resource.orgs_near_limit`, `resource.users_near_limit` (80/90/95% tier thresholds) | Contact the org to plan a tier upgrade or usage reduction — **not** a technical incident |
| `security.failed_auth_threshold` (FR73) | Existing, already-documented response owner: Organization Admins, not the platform operator |
| `user.dormant` (FR71) | Existing, already-documented response owner: Organization Admins, not the platform operator |

Org-level alerts landing in a shared ops channel the platform operator also monitors are **not**
automatically the platform operator's to act on — the table above exists specifically to prevent
misrouting incident-response time to an alert that belongs to an org admin. Treat this table as
living documentation: any new alert type introduced by a future story should be added here as part
of that story's own documentation-impact review.

### Verifying audit log integrity — the PJ9 cross-log distinction

<!-- Source: Story 9.5 AC-21; verified against apps/api/src/modules/audit/{routes,schema}.ts, apps/api/src/modules/platform-audit/{routes,schema}.ts -->

Two entirely separate logs, each with its own verify endpoint, with **no unified cross-log search
in v1** — this is a deliberate v1 scope boundary (PJ9), not an oversight. Checking one does not
mean you have checked "the" audit trail.

- **Per-org security audit log** (`audit_log_entries`, Story 8.1) — `GET /api/v1/org/audit/verify`
  (**Owner role only** — there is no separate "Audit" role in this application; an org Admin is
  not sufficient and receives `403`). Response:
  `{"data":{"summary":"...", "rowsChecked":N, "passed":N, "failed":[{"id","eventType","timestamp"}],
  "failedCount":N, "failedTruncated":bool, "verifiedAt":"..."}}`.
- **Platform operator audit log** (`platform_audit_events`, Story 9.4) —
  `GET /api/v1/platform/audit/verify` (platform-operator-only, requires MFA). Every response from
  this endpoint carries an `X-Log-Scope: platform` header. Response shape matches the org-scoped
  one except `failed[]` entries use `actionType` instead of `eventType`.

An operator investigating a full incident picture must check both independently — e.g. an
admin-initiated org creation or a backup/restore action is recorded exclusively in the platform
log, not the org log; checking only the org log and finding it clean is an incomplete
investigation if the suspected action was a platform-operator action.

Both endpoints require an unsealed vault (they recompute HMACs against the respective signing key)
— a sealed vault returns `503`; complete Vault Lifecycle § Manual unseal first.

---

## Quarterly Operations Checklist

<!-- Source: Story 9.5 AC-23; verified against .trivyignore, .github/workflows/ci.yml -->

Each item links to the concrete, verifiable procedure it points at — check a box only after
actually running the underlying procedure, not just reading its description.

- [ ] **Backup restore validation** — run `POST /api/v1/admin/backups/:filename/validate` against
      the most recent backup (§ Backup & Recovery → Quarterly backup restore validation). Record
      pass/fail; a failure requires immediate escalation, not a note for next quarter.
- [ ] **Audit log integrity check, both logs** — run both `GET /api/v1/org/audit/verify` and
      `GET /api/v1/platform/audit/verify` (§ Monitoring → Verifying audit log integrity). Checking
      only one is an incomplete check.
- [ ] **Dormant user review** — normally an org-admin responsibility (FR71/Story 8.3); the platform
      operator's quarterly item is confirming the alert *mechanism* itself is healthy
      instance-wide, not merely that there happen to be no dormant users this quarter (a vacuous
      "no dormant users" does not confirm the mechanism works).
- [ ] **Key custody review** — confirm `kmsType` is not `'file'` in production; confirm the team is
      aware of the `key_rotated_at` limitation (§ Master Key Management → Rotating the master key)
      so no one assumes the age-based alert reflects real rotation history.
- [ ] **CVE scan review** — review any currently-active `.trivyignore` entries for continued
      justification (repo root; empty by default). Do not rely solely on CI to catch this — CI's
      "Check .trivyignore entries" step only rejects entries whose `exp:` date has **already
      passed**; it does not enforce the "max 30 days out from today" convention documented in the
      file's own header comment at entry-creation time. A human quarterly review is the actual
      enforcement of that convention.
- [ ] **`.trivyignore` expiry audit** — for every active entry, confirm its `exp: YYYY-MM-DD`
      deadline is not approaching without a renewal plan (same file/mechanism as the item above).
