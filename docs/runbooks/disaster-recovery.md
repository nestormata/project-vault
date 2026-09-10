# Disaster recovery: rebuilding on a new host

<!-- Verified against docker-compose.yml, docker-compose.prod.yml, docker-compose.nfs.yml,
     packages/db/src/migrations/{0001_rls_and_triggers,0070_rls_ownership_and_force,
     0071_admin_pool_role,0081_extension_db_role}.sql, packages/db/src/scripts/guarded-migrate.ts,
     scripts/{check-rls-coverage,check-function-executability,check-extension-db-role,
     check-admin-pool}.ts, apps/api/src/modules/backup/service.ts, apps/api/src/config/env.ts -->

## When to use

The original host is gone, unreachable, or being replaced: hardware failure, a destroyed volume, a
provider migration, or a rehearsal. If the instance is still running and you only need to roll data
back, use [`backup-restore.md`](backup-restore.md) instead — the in-app restore endpoint needs a
running API and is far simpler.

**Read this before you need it.** The parts most likely to be missing on the day are the ones no
routine operation exercises: cluster roles and their passwords, key material custody, and a fresh
handoff instance identity.

---

## What you must have off-host to recover at all

| Artifact | Where it normally lives | Recoverable if lost? |
| --- | --- | --- |
| A verified encrypted backup **or** an external `pg_dump` | `backup_data` volume, or `BACKUP_S3_BUCKET`, or your own dump target | No |
| Vault key material — see below | `vault_keys` volume, secret manager, or AWS KMS | **No** |
| The twelve production HMAC/session secrets | Secret manager | Effectively no; see the impact table in [`secret-rotation.md`](secret-rotation.md) |
| Cluster role passwords (`vault_app`, `vault_admin`, `vault_extension`) | Secret manager | Yes — they can be reset by a superuser, but the app cannot start until they match |
| `SERVICE_PROVISIONING_TOKEN` / `SERVICE_REVOCATION_TOKEN` | Secret manager | Yes — rotate on both sides |

### Volumes

The production stack has three named volumes:

| Volume | Contents | Carry to the new host? |
| --- | --- | --- |
| `db_data` | The Postgres data directory | Optional — a filesystem-level copy of a *cleanly stopped* Postgres is the fastest recovery, but a backup/dump restore is the supported path and the one this runbook assumes |
| `vault_keys` | Mounted read-only at `/run/secrets`: the envelope file-half, or the `file`-mode master key | **Yes, if the instance uses `envelope` or `file` mode** — and its contents are unrecoverable if lost |
| `backup_data` | Encrypted backup files (`BACKUP_STORAGE_PATH`) | Yes, unless backups go to S3 or an external mount instead |

If the instance used the NFS override (`docker-compose.nfs.yml`), the backups live on the export at
`/var/backups/vault` rather than in `backup_data`; carry the export mount instead.

### Key material — unrecoverable if lost

The vault master key is not in the database and is not in the backup. Depending on the mode:

- **`kms`** — nothing to carry. The new host needs AWS credentials with `kms:Decrypt` on the same key
  and network reachability to the same region. The wrapped data key travels inside the restored
  database.
- **`envelope`** — you need **both halves**: `VAULT_ENVELOPE_KEY_HALF` (an environment variable,
  normally injected from your secret manager) and the file-half (a file under `VAULT_KEY_DIR`,
  normally `/run/secrets/...`, backed by the `vault_keys` volume).

  **Losing either half is exactly as fatal as losing a single-file key.** If
  `VAULT_ENVELOPE_KEY_HALF` is gone — the secret manager entry was deleted, the value only ever
  existed in a destroyed host's environment, nobody recorded it — the data is **unrecoverable**.
  There is no recovery mechanism, backdoor, or support escalation that can decrypt it, and every
  backup taken under that key is equally unreadable, because the backup encryption key is derived
  from the same master key. This is the identical statement that applies to the lost file-half; the
  split-key model buys independence of custody, not recoverability from one half.

  Symptom of a lost env-half specifically: the unseal call returns `401 unseal_failed` even though the
  file-half is present (a missing *file*-half returns `400 key_file_not_found` instead). Do not read
  `401` here as "wrong passphrase, try again."
- **`passphrase`** — the passphrase, from your password manager.
- **`file`** — the key file from `vault_keys`.

See [`master-key.md`](master-key.md) for the full loss matrix.

---

## Which path applies to you — read this first

The in-app restore endpoint decrypts a `.vault` backup with the **currently loaded** master key. On a
new host, whether a freshly-initialized instance derives that same key depends on the key mode:

| Mode | Does a fresh `init` with the same key material reproduce the backup key? | Which path |
| --- | --- | --- |
| `envelope` | **Yes.** The key material is derived directly from the two halves — deterministic. | Path A |
| `file` | **Yes.** Derived directly from the key file — deterministic. | Path A |
| `passphrase` | **No.** `init` generates a fresh random Argon2id salt, stored in `vault_state`. The same passphrase under a new salt yields a different key. | Path B |
| `kms` | **No.** `init` calls KMS `GenerateDataKey`, producing a brand-new data key. | Path B |

For `passphrase` and `kms`, the surviving key material is only usable together with the *original*
`vault_state` row (which holds the salt, or the wrapped data key). That row lives in the database, so
you must reconstitute the database first — via Path B, or by carrying the `db_data` volume. Once the
original `vault_state` is in place and you have unsealed, in-app `.vault` restores work normally
again.

This is worth rehearsing rather than discovering: a `passphrase`-mode instance whose only artifact is
a `.vault` file and its passphrase, with no database and no dump, **cannot be recovered**.

---

## Path A — recover from an in-app encrypted backup

Applies to `envelope` and `file` modes.

### 1. Stand up a bare instance

Bring up the stack on the new host exactly as for a first deployment
([`vault-lifecycle.md`](vault-lifecycle.md)), with:

- the same `.env` secrets as the old host (the twelve HMAC/session secrets, the DB URLs, the backup
  configuration),
- the **same key material** — restore the `vault_keys` volume contents before starting:

  ```bash
  docker run --rm -v vault_keys:/run/secrets -v "$PWD":/host:ro busybox \
    sh -c 'cp /host/envelope-half.bin /run/secrets/envelope-half.bin'
  ```

  and, for `envelope` mode, the same `VAULT_ENVELOPE_KEY_HALF` value in the API's environment.
- the backup files reachable at `BACKUP_STORAGE_PATH` (restore the `backup_data` volume, re-mount the
  export, or point at the same `BACKUP_S3_BUCKET`).

Let the `migrate` service run, then `init` the new instance with the **same mode and the same key
material** as the old one, and register a first user (this becomes the platform operator the restore
call needs). The instance now derives the identical backup key, so it can read the old backup file.

### 2. Restore

Follow [`backup-restore.md`](backup-restore.md) § Full in-place restore. The restore replaces the
whole database — including `vault_state` and the user you just created — with the old instance's
contents, and then seals the vault. From here on, this *is* the old instance: use the old instance's
operator credentials.

A `401 {"code":"backup_decrypt_failed"}` at this step means the derived key does not match the backup
— re-check that both envelope halves (or the key file) are byte-identical to the originals, and see
the mode table above.

### 3. Continue at "Post-restore steps for a new host" below.

---

## Path B — recover from an external `pg_dump`

Use this when in-app backups were disabled and you took your own dumps, when the instance uses
`passphrase` or `kms` mode (see the table above), or when you need to move the database independently
of the application.

### 1. Recreate the cluster roles first — `pg_dump` does not carry them

A plain `pg_dump` of the application database contains **no roles**. Restoring it into a fresh
cluster without recreating the roles fails, or worse, silently reassigns ownership. The four roles
this application depends on:

| Role | Attributes | Purpose |
| --- | --- | --- |
| `vault_owner` | `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT` | Owns the RLS-protected tables. Ownership by a non-superuser is what makes `FORCE ROW LEVEL SECURITY` an actual boundary. |
| `vault_app` | `LOGIN`, no BYPASSRLS | The application's own connection (`DATABASE_URL`). |
| `vault_admin` | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT` | The narrow RLS-bypassing admin pool (`ADMIN_DATABASE_URL`). |
| `vault_extension` | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT` | Optional; only if a module pack uses the extension database handle. |

Create `vault_owner` **first**, before restoring the dump, so ownership lands correctly. Then create
the three login roles and set their passwords to the values the new host's `DATABASE_URL`,
`ADMIN_DATABASE_URL` and `EXTENSION_DATABASE_URL` will use. The migrations create these roles with
published development-only passwords when they run on a fresh database; on a real deployment you must
set real ones (`ALTER ROLE <role> PASSWORD '<secure-random>';`) or configure SCRAM/peer
authentication in `pg_hba.conf` and remove the passwords entirely.

Alternatively, capture the roles at dump time with `pg_dumpall --roles-only` and restore that first.

### 2. Restore the dump — never with `--no-owner`

```bash
pg_restore --dbname "$SUPERUSER_DATABASE_URL" --exit-on-error path/to/dump
# (for a plain-SQL dump instead: psql "$SUPERUSER_DATABASE_URL" -v ON_ERROR_STOP=1 -f path/to/dump.sql)
```

**Never use `--no-owner` for this database.** It can return table ownership to a superuser while
leaving `FORCE ROW LEVEL SECURITY` enabled — which quietly disables the tenant boundary, because
`FORCE` does not apply to a superuser owner. A restore that "worked" with `--no-owner` is a
cross-tenant data-exposure bug, not a convenience.

### 3. Bring the schema to the current version

Run migrations as the migration superuser identity (`postgres`), the same way a normal deploy does:

```bash
DATABASE_URL="$SUPERUSER_DATABASE_URL" pnpm --filter @project-vault/db db:migrate
```

The guarded wrapper refuses destructive migrations; see [`upgrades.md`](upgrades.md) if it does.

### 4. Continue at "Post-restore steps for a new host" below.

---

## Post-restore steps for a new host

Do all of these **before serving traffic**.

### 1. Verify the database privilege boundary

All three must pass. Any failure means the restore is incomplete — do not put the instance in front
of users.

```bash
DATABASE_URL="$VAULT_APP_DATABASE_URL" pnpm check-rls
DATABASE_URL="$VAULT_APP_DATABASE_URL" pnpm check-function-executability
# → function-executability-check: OK
pnpm check-extension-db-role        # only if vault_extension is in use
pnpm check-admin-pool
# → Admin pool preflight OK: role=vault_admin rolsuper=false rolbypassrls=true
```

`check-rls` verifies policy coverage, `ENABLE`/`FORCE` equality, safe ownership, expanded `vault_app`
ACLs, non-public `org_id` schema scope, and view safety — see
[`rls-ownership.md`](rls-ownership.md). `check-function-executability` verifies that no in-scope
function is `PUBLIC`-executable and that the function default-ACL row is keyed to the migration owner
— a restore is exactly the scenario it exists for, so read
[`function-executability.md`](function-executability.md) before dismissing a failure.
`check-extension-db-role` asserts that no default ACL, non-public schema usage, function execution,
or ownership path has widened the extension role.

### 2. Unseal

The restored instance is sealed. Unseal with the **original** key material
([`vault-lifecycle.md`](vault-lifecycle.md)):

```bash
curl -sf http://localhost:${API_HOST_PORT}/ready
# → 503 {"status":"unavailable","reason":"sealed"}
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/unseal -H 'Content-Type: application/json' -d '...'
curl -sf http://localhost:${API_HOST_PORT}/ready
# → {"status":"ready"}
```

A `401 unseal_failed` here means the key material does not match what the restored `vault_state`
expects — the most common causes are a stale `VAULT_ENVELOPE_KEY_HALF` on the new host, or restoring
a backup taken under different key material.

### 3. Provision a **new** `VAULT_HANDOFF_INSTANCE_ID`

If `VAULT_HANDOFF_ENABLED` is set, a restore or redeploy to a new physical/virtual instance must be
given a **new** `VAULT_HANDOFF_INSTANCE_ID`, agreed with the CentralizeMe directory out of band —
never inherit the old one automatically. It is deployment configuration, not application state, and
there is deliberately no carry-forward mechanism.

Format: 3–63 lowercase DNS-label characters, `^[a-z][a-z0-9-]{1,61}[a-z0-9]$`. Provision
`VAULT_HANDOFF_VERIFY_KEYS` in the same change — the API refuses to boot with handoff enabled and
either value missing on an instance where native login is excluded. See
[`handoff-instance-identity.md`](handoff-instance-identity.md).

### 4. Regenerate the `/status` monitoring token

The `/status` bearer token's hash travels with the database, so the *old* token still works if you
carried both the database and `OPERATIONAL_STATUS_TOKEN_HMAC_SECRET`. Rotate it anyway if the old host
may have been compromised, or if the secret was not carried:
Settings → Platform Admin → `POST /api/v1/admin/settings/status-token/rotate` (operator + MFA). The
plaintext is shown exactly once. Re-point the external monitor, then confirm with `.../test` and a
real `curl` from the monitor.

If token-based access was never configured, `/status` reverts to loopback-only and a remote monitor
gets a generic `404` until you generate a token.

### 5. Re-point everything external

- DNS and TLS: issue certificates for the new host and update the reverse proxy
  ([`reverse-proxy-tls.md`](reverse-proxy-tls.md)). Check `CORS_ALLOWED_ORIGINS` and `WEB_BASE_URL`
  still name the right origin.
- CentralizeMe: the new instance identity from step 3, and any provisioning/revocation endpoints CM
  calls.
- Backup destination: confirm `BACKUP_STORAGE_PATH` / `BACKUP_S3_BUCKET` point somewhere writable on
  the new host, then **trigger and validate a fresh backup immediately** — a recovered instance with
  no working backup is one incident away from the same position again.
- Prometheus scraping: `/metrics` is loopback-only unless `METRICS_BIND_HOST` says otherwise.

### 6. Final verification

```bash
curl -sf http://localhost:${API_HOST_PORT}/health   # {"status":"ok","version":"...","versionSource":"release"}
curl -sf http://localhost:${API_HOST_PORT}/ready    # {"status":"ready"}
```

Then run both audit-log integrity checks ([`monitoring.md`](monitoring.md)) — a clean chain
verification on both logs is the strongest single signal that the data arrived intact — and spot-check
that a known credential decrypts.

---

## Rollback

There is nothing to roll back on a new host: if a restore attempt fails, drop the database, recreate
the roles, and start again from the same backup or an earlier one. Do **not** iterate by partially
re-restoring over a half-restored database — ownership and ACL state from a failed attempt is exactly
what `check-rls` and `check-function-executability` will flag, and diagnosing it costs more than a
clean re-run.

Keep the original host, its volumes and its key material untouched until the new instance has passed
every step above.
