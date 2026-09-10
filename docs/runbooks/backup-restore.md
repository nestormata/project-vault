# Backup and restore

<!-- Verified against apps/api/src/modules/backup/{routes,schema,service,storage-errors,alerts}.ts,
     apps/api/src/workers/backup-health-check.ts, apps/api/docker-entrypoint.sh,
     docker-compose.yml, docker-compose.nfs.yml, .env.example -->

## When to use

Taking or validating a backup, recovering from a bad write or an accidental deletion, remediating a
backup-storage permission failure, or responding to a `backup.missed` / `backup.failure` alert.

For rebuilding an instance on a **new host** — volumes, cluster roles, key material, instance
identity — use [`disaster-recovery.md`](disaster-recovery.md) instead; this runbook covers
in-place backup and restore against a working instance.

All four endpoints below are instance-wide (not org-scoped) and require platform operator status
(the role granted to the first-ever registered user). A non-operator caller receives
`403 {"code":"platform_operator_required"}`. There is no per-org "back up my org's data only" option
in v1 — backups are whole-instance.

---

## Trigger a manual backup and verify it succeeded

```bash
curl -s -X POST http://localhost:${API_HOST_PORT}/api/v1/admin/backup/trigger \
  -H 'Authorization: Bearer <platform operator token>'
# → 202 {"data":{"jobId":"<uuid>","status":"running"}}
```

Poll for completion:

```bash
curl -s http://localhost:${API_HOST_PORT}/api/v1/admin/backups \
  -H 'Authorization: Bearer <platform operator token>'
# → 200 {"data":{"items":[
#     {"filename":"backup_20260706T030000Z.vault","timestamp":"...","sizeBytes":48213,
#      "keyVersion":1,"verified":"unverified"}
#   ]}}
```

`verified` is one of `"unverified" | "valid" | "invalid"` (not a boolean) and starts `"unverified"`
immediately after trigger — run the validate step below before relying on a fresh backup for a real
restore.

**Triggering a second backup while one is already running is rejected, not queued:**
`409 {"code":"backup_already_running", "message":"A backup is already in progress...", "jobId":"<id>"}`.
Check `GET /api/v1/admin/backups` first.

---

## Validate a backup (quarterly, and before any real restore)

```bash
curl -s -X POST http://localhost:${API_HOST_PORT}/api/v1/admin/backups/backup_20260706T030000Z.vault/validate \
  -H 'Authorization: Bearer <platform operator token>'
# → 200 {"data":{"valid":true,
#     "assetsPresent":{"credentials":true,"projects":true,"users":true,"auditEvents":true},
#     "checksum":"match"}}
```

This decrypts and structurally verifies the backup in an isolated, read-only context — **no live data
is modified.** Treat any `false` value in `assetsPresent`, or `checksum: "mismatch"`, as a **failed**
validation requiring immediate escalation (do not wait for next quarter — the backup chain may be
silently broken). Do not attempt a real restore from a failed-validation file; trigger a fresh manual
backup, validate that one, and investigate the storage destination (disk corruption, S3 object
corruption, interrupted write) for the older file's root cause. Record the pass/fail result in your
own change-management log.

If `BACKUP_S3_BUCKET` is configured, wait for the backup's listing entry to show a stable `sizeBytes`
across two successive `GET /api/v1/admin/backups` polls before validating, to avoid a false
"mismatch" from validating a partially-propagated (eventually-consistent) upload.

---

## Full in-place restore, step by step

> **This is destructive: all current data is replaced with the backup's contents.** There is no
> partial or selective restore in v1.

### 1. Do not stop the API container

The restore call in step 2 is itself an HTTP request to the running `api` service; stopping it first
makes the call impossible. If you want to reduce the chance of other requests racing the restore, do
so by other means that leave the API reachable — pause background workers, or take the instance out
of any external load-balancer/reverse-proxy rotation — not by stopping the container this procedure
needs to call.

### 2. Call the restore endpoint with an explicit confirmation body

```bash
curl -s -X POST http://localhost:${API_HOST_PORT}/api/v1/admin/backups/backup_20260705T030000Z.vault/restore \
  -H 'Authorization: Bearer <platform operator token>' \
  -H 'Content-Type: application/json' \
  -d '{"confirmRestore":true,"reason":"recovering from accidental credential deletion, incident #42"}'
# → 200 {"data":{"restored":true,"filename":"backup_20260705T030000Z.vault","sealedAfterRestore":true}}
```

`reason` is mandatory free text for your own incident record. This call **completes synchronously**
(a direct `200`, not an async job you poll for). `confirmRestore: true` and a non-empty `reason` are
both required; omitting either returns `400 {"code":"confirmation_required"}`.

The restore holds a session-scoped Postgres advisory lock on the same key the backup job uses, so a
restore and a backup can never run concurrently against the same database.

### 3. Unseal

After a successful restore the vault is **automatically sealed**. Complete a manual unseal
([`vault-lifecycle.md`](vault-lifecycle.md)) before the instance is usable again.

### 4. Verify the database privilege boundary before serving traffic

A restore can silently return table ownership or function ACLs to the wrong role. Run both guards and
require both to pass:

```bash
DATABASE_URL="$VAULT_APP_DATABASE_URL" pnpm check-rls
DATABASE_URL="$VAULT_APP_DATABASE_URL" pnpm check-function-executability
# → function-executability-check: OK
```

(`make check-rls` and `make check-function-executability` wrap the same commands with the repo's own
`DATABASE_URL`.) If you do not have the repository or pnpm to hand, the second check has a pasteable
SQL twin at `scripts/sql/check-function-executability.sql`:

```bash
psql "$VAULT_APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/check-function-executability.sql
```

Treat any failure as an incomplete restore — see [`function-executability.md`](function-executability.md)
for how to read a failure, and [`rls-ownership.md`](rls-ownership.md) § Restore and rollback for the
`vault_owner` ownership rule and the **`--no-owner` prohibition** (never restore this database with
`pg_restore --no-owner`: it can return table ownership to a superuser while leaving `FORCE ROW LEVEL
SECURITY` enabled).

### 5. Post-restore verification

`GET /ready` → `{"status":"ready"}`, then spot-check that a known credential/project exists as
expected.

### Other outcomes

| Response | Meaning |
| --- | --- |
| `404 {"code":"backup_not_found"}` | No such file. |
| `422 {"code":"backup_checksum_mismatch"}` | Refuses to restore a potentially corrupted or tampered backup. |
| `401 {"code":"backup_decrypt_failed"}` | Could not decrypt with the **current** master key. By design this endpoint does not distinguish "wrong key" from "corrupted ciphertext". |
| `500 {"code":"backup_restore_failed"}` | The underlying `pg_restore`/`psql` subprocess failed after checksum verification passed — check server logs. |

`backup_decrypt_failed` after a key change is expected and is not recoverable by retrying: the backup
encryption key is derived from the master key, so a backup taken under a different master key cannot
be read. See [`master-key.md`](master-key.md).

### Rollback

Restoring a backup taken before a since-applied destructive migration leaves the restored schema
mismatched with the currently-deployed application version — roll the image back to match first, or
treat it with the same offline-migration care as a destructive upgrade
([`upgrades.md`](upgrades.md)), not a routine restore.

---

## Backup missed for more than 24 hours

- **Trigger:** the `backup.missed` alert, which fires once the most recent successful backup is older
  than `BACKUP_MAX_AGE_HOURS` (default **25** hours — this already includes slack over the 24h RPO
  for timing drift, so a firing alert reliably means the RPO is currently at risk, not a false
  positive). The scheduled backup job runs per `BACKUP_SCHEDULE` (default `0 3 * * *`, daily at 03:00
  UTC).

### Diagnose

1. Check operational logs around the missed window for a `backup.failure` alert or job-error entry.
   The alert type is `backup.failure` — singular past-tense "failure", not "failed".
2. If it failed with a storage error (`BACKUP_S3_BUCKET` unreachable, disk full at
   `BACKUP_STORAGE_PATH`), remediate the storage destination first — see "Backup permission
   remediation" below for the permission case.

### Fix and verify

3. Trigger a manual backup immediately rather than waiting for the next scheduled run.
4. Confirm `GET /api/v1/admin/backups` shows the new, successful entry. **Note:** `GET /ready`'s
   `warnings` array only ever surfaces `audit_storage_critical` / `key_custody_risk` — there is no
   backup-related `/ready` warning to watch for clearing; the backups listing is the only
   confirmation this step has.

Do not silence or acknowledge the alert without confirming a fresh, valid backup exists.

### Backups deliberately disabled

Backups can be disabled entirely for operators using external backup tooling — unset
`BACKUP_STORAGE_PATH`, `BACKUP_S3_BUCKET`, **and** `BACKUP_DATABASE_URL` together. Leaving
`BACKUP_DATABASE_URL` set while unsetting only the two storage vars is an inconsistent configuration
the app refuses to boot with:

```
FATAL: Backup is enabled but neither BACKUP_STORAGE_PATH nor BACKUP_S3_BUCKET is configured
```

That is a loud startup failure, not a silent misconfiguration, but it is worth knowing in advance
rather than hitting at restart time. With all three unset, `backup.missed` should never fire; if it
does fire on an instance believed to have backups disabled, that is itself a configuration-drift
incident (verify the disable setting actually took effect), not a normal missed-backup scenario.

If you disable in-app backups, you are responsible for the external `pg_dump` path end to end,
including cluster roles and the key material the dump does not carry — see
[`disaster-recovery.md`](disaster-recovery.md).

---

## Backup permission remediation

- **Trigger:** a backup write fails with a permission/full/unavailable error. It surfaces on
  `GET /api/v1/admin/backups` (and the admin Backups page) as a stable, sanitized category message
  referencing `BACKUP_STORAGE_PATH` and this runbook — never the raw Node `EACCES`/`ENOSPC` text or
  any secret value.

### Background

The API container runs as the non-root `node` user (uid:gid **1000:1000**). `BACKUP_STORAGE_PATH`
must be writable by that uid/gid. At container start, `apps/api/docker-entrypoint.sh` runs briefly as
root and repairs ownership of **only** that single directory (`mkdir -p`, `chown 1000:1000`,
`chmod 0750`) before dropping privileges via `su-exec` and exec'ing the app — the running application
process itself never runs as root, and this repair never touches any other path or recurses into the
directory's existing contents. If it cannot repair ownership, the container still starts and serves
`/health`; only the backup path degrades.

### Fix — named volume (default, `backup_data`)

Docker creates a fresh named volume root-owned by default; the entrypoint repairs it automatically on
first start. If a backup still fails with a permission error against a named volume, something
outside normal operation changed its ownership:

```bash
# Inspect current ownership inside the volume (host-side, via a disposable container):
docker run --rm -v <project>_backup_data:/var/backups/vault alpine stat -c '%u:%g' /var/backups/vault
# Repair it directly if it is not 1000:1000:
docker run --rm -v <project>_backup_data:/var/backups/vault alpine chown 1000:1000 /var/backups/vault
```

### Fix — bind mount

If `BACKUP_STORAGE_PATH` maps to a host directory instead of the named volume, pre-create it and set
ownership on the **host** before starting the container:

```bash
sudo mkdir -p /path/on/host/for/backups
sudo chown 1000:1000 /path/on/host/for/backups
```

### Fix — unfixable bind mount

Some bind-mount configurations (a host filesystem/permission model the container's root cannot chown,
or a read-only mount) cannot be repaired by the entrypoint at all. In that case:

1. Startup logs a structured `backup.storage_init_failed` warning stating the exact required uid:gid
   (1000:1000) and the configured path — check container logs around startup, not just at
   backup-attempt time.
2. The container still starts and `/health` still succeeds; only backup writes fail, each recorded as
   a `failed` `backup_runs` row with the same sanitized remediation message.
3. Fix ownership/mode on the host for that specific mount, or point `BACKUP_STORAGE_PATH` at a fresh
   named volume instead, then restart the `api` container so the entrypoint re-attempts the repair.

### Verify

Fixing ownership never requires deleting or moving existing backup files — the entrypoint's repair
and the manual commands above only change the destination directory's owner/mode, not its contents.

1. Restart the `api` container (or wait for the next scheduled run) so the repair re-runs.
2. Trigger a manual backup to confirm the fix.
3. Confirm `GET /api/v1/admin/backups` shows a new `succeeded` row and that previously listed backups
   are still present and unchanged.
4. `docker compose logs api | grep backup.storage_init_failed` shows no new occurrences after the
   affected container start.

---

## Example: NFS-backed filesystem storage on a hypervisor host

This is one worked example of an external backup destination, not the deployment model — adapt it to
your own storage. The pattern is: mount the export on the host, expose only a dedicated subdirectory
to the container runtime, and layer the tracked `docker-compose.nfs.yml` override instead of the
default Docker named volume.

The example below is a Proxmox host with an unprivileged LXC (`103`) running the Docker stack:

```bash
# On the hypervisor host; choose a subdirectory dedicated to this application.
mkdir -p /mnt/pve/backups01/vault-backups
pct set 103 -mp0 /mnt/pve/backups01/vault-backups,mp=/mnt/backups

# Inside the container, from the deployment directory.
export BACKUP_NFS_PATH=/mnt/backups
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  -f docker-compose.nfs.yml \
  up -d
```

Before starting the API, verify that `/mnt/backups` is mounted and writable by the API's runtime user
(`uid=1000`). Do not use the NFS export root; keep it in a dedicated subdirectory. The export must
allow the mapped runtime identity to create files, including the temporary `.tmp-*` file used during
an atomic backup write.

After the stack starts, confirm the API container sees the bind mount at `/var/backups/vault`, then
trigger a manual backup and wait for a `succeeded` row before validating it.
