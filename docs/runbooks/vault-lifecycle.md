# Vault lifecycle: first deploy, unseal, startup/shutdown

<!-- Verified against apps/api/src/modules/vault/{routes,key-service,schema}.ts,
     apps/api/src/routes/{health,status}.ts, apps/api/src/modules/auth/routes.ts,
     docker-compose.yml, docker-compose.prod.yml, Makefile -->

## When to use

Standing up a new instance, unsealing after a restart or an unexpected seal, or deciding whether a
non-`ready` instance is a vault problem or a database problem.

For local-dev / hot-reload workflows instead of a production-style deploy, see
[`docs/operator-quickstart.md`](../operator-quickstart.md).

---

## First-time deployment

### 1. Configure secrets

```bash
cp .env.example .env
# Required in production unless VAULT_ALLOW_REMOTE_INIT=true (dev-only, never set true in prod):
export VAULT_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"
```

Never leave `VAULT_BOOTSTRAP_TOKEN` blank in production. Setting `VAULT_ALLOW_REMOTE_INIT=true`
disables this protection entirely — it is a local-dev convenience only. Do not use it as a
production shortcut.

A production instance must also set the twelve HMAC/session secrets; boot fails loudly if any is
missing, is a placeholder, or is one of the published dev values. See
[`secret-rotation.md`](secret-rotation.md) for the full list and how to generate them.

### 2. Start the stack

```bash
# Production:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
# (equivalent: make docker-prod)

# Eval/dev:
make bootstrap-docker
```

Either path runs the one-shot `migrate` service to completion before `api` starts (see
[`upgrades.md`](upgrades.md)).

### 3. Initialize the vault

`POST /api/v1/vault/init`, header `X-Vault-Bootstrap-Token: <token>`. The body shape depends on the
chosen `kmsType`. **There are four modes — `passphrase`, `envelope`, `file`, and `kms`** — all four
are live members of the init request union (`apps/api/src/modules/vault/schema.ts`). `kms` (AWS KMS)
is the most secure and is the only mode that needs no operator-supplied credential at unseal time;
`file` is the weakest and requires an explicit acknowledgment flag. See
[`master-key.md`](master-key.md) for the full KMS configuration, IAM permissions, and failure modes.

```bash
# passphrase mode
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -d '{"kmsType":"passphrase","passphrase":"<at least 12 characters>"}'

# envelope mode (recommended for self-hosted production — split-key custody)
openssl rand -hex 16   # → set as VAULT_ENVELOPE_KEY_HALF in the api container's env
openssl rand -out dev-secrets/envelope-half.bin 16   # file-half, under VAULT_KEY_DIR
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -d '{"kmsType":"envelope","envelopeKeyPath":"/run/secrets/envelope-half.bin","acknowledgeSplitKeyModel":true}'

# kms mode (AWS KMS; no operator credential is supplied at unseal)
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -d '{"kmsType":"kms","kmsKeyId":"arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr"}'

# file mode (downgraded option — explicit acknowledgment required, not recommended for production)
openssl rand -out dev-secrets/master.key 32
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/init \
  -H 'Content-Type: application/json' \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -d '{"kmsType":"file","masterKeyPath":"/run/secrets/master.key","acknowledgeCoLocationRisk":true}'
```

`kmsKeyId` may be a full key ARN or an `alias/...` KMS alias.

**The `dev-secrets/...` host path above only works as shown for the eval/dev compose path** —
`docker-compose.yml`'s `api` service bind-mounts `./dev-secrets:/run/secrets:ro`, so a file written
to `dev-secrets/` on the host appears at `/run/secrets/` inside the container. The **production**
override (`docker-compose.prod.yml`) replaces that bind mount with a named Docker volume
(`vault_keys:/run/secrets:ro`) that is not backed by any host directory — writing to `dev-secrets/`
on a production host does **not** put the file where the container can read it. To get key material
into `vault_keys` for a real production deployment, write it via a throwaway container mounting the
same volume:

```bash
docker run --rm -v vault_keys:/run/secrets -v "$PWD":/host:ro busybox \
  sh -c 'cp /host/envelope-half.bin /run/secrets/envelope-half.bin'
```

(substitute `master.key` for `file` mode). Then reference the same `/run/secrets/...` path in the
`init`/`unseal` request bodies either way — only how that path gets populated differs between dev
and production.

Success: `200 {"initialized":true,"keyVersion":1,"kmsType":"<passphrase|envelope|file|kms>"}`.
Re-running `init` against an already-initialized vault returns `409 {"error":"already_initialized"}`
— expected and safe (idempotent-to-fail, not destructive); proceed to "Manual unseal" instead.

### 4. Unseal

The first unseal happens automatically as part of a successful `init` call — the vault is unsealed
immediately on init, no separate call needed the very first time. For every subsequent seal
(restart, crash, planned maintenance), see "Manual unseal" below.

### 5. Register the first user

```bash
read -r -p 'Owner email: ' ADMIN_EMAIL
read -r -s -p 'Owner password: ' ADMIN_PASSWORD; echo

curl -s -X POST "http://localhost:${API_HOST_PORT}/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<JSON
{"email":"$ADMIN_EMAIL","password":"$ADMIN_PASSWORD","orgName":"Acme Corp"}
JSON
# → 202 {"message":"If that email is available, your account has been created and you can sign in."}
```

**Self-signup always returns `202` with that generic message**, whether or not the account was
actually created — the response is deliberately identical for a novel and an already-registered
email so it cannot be used to enumerate accounts. It is not a confirmation. Confirm success by
signing in. (Only the invitation-acceptance path returns `201` with a body.)

The **first user ever registered on the instance** (not per-org) is automatically granted platform
operator status — the role the backup/restore/audit/key-management procedures require. Registration
does not auto-login; sign in separately.

### 6. Verify

```bash
curl -sf http://localhost:${API_HOST_PORT}/health          # {"status":"ok","version":"..."}
curl -sf http://localhost:${API_HOST_PORT}/ready           # {"status":"ready"}
```

---

## External monitoring — `GET /status`

Three distinct probes exist — use the right one:

| Probe         | Purpose                                                                            | Depends on DB/vault? | Who should call it                       |
| ------------- | ---------------------------------------------------------------------------------- | -------------------- | ---------------------------------------- |
| `GET /health` | Unconditional liveness (Docker healthcheck)                                        | No                   | Container supervisor                     |
| `GET /ready`  | Readiness (init/seal/DB gate)                                                      | Yes                  | Orchestrator routing decisions           |
| `GET /status` | Aggregate operational status (DB responsiveness, vault seal state, disk capacity)  | Yes                  | External monitor / alerting              |

`GET /status` returns
`{"status":"healthy"|"degraded"|"unavailable","version":"...","timestamp":"...","checks":{"database":{...},"vault":{...},"disk":{...}}}`
— HTTP 200 when `healthy`, HTTP 503 otherwise (same schema either way). Each check reports a stable,
non-sensitive reason code (`db_timeout`, `db_error`, `db_unavailable`, `vault_sealed`,
`vault_uninitialized`, `disk_threshold_exceeded`, `disk_check_failed`, or `disk_not_configured` when
no filesystem backup path is configured — the disk check is skipped entirely in that case, not
treated as a failure). The response never includes tenant names, credentials, connection strings,
filesystem paths, or stack traces, and is sent with `Cache-Control: no-store`.

**Disk threshold:** `disk_threshold_exceeded` is governed by `STATUS_DISK_MIN_FREE_PERCENT` (integer
percent, 1–50, default **10**). The disk check is only evaluated when `BACKUP_STORAGE_PATH` is
configured. Lower it if a legitimately tight filesystem is producing noise; raise it to get earlier
warning.

**Access control (safe by default):** if no bearer token has been generated, only loopback callers
(`127.0.0.1`/`::1`) may call `GET /status` unauthenticated — every other caller gets a generic 404
(the endpoint is undiscoverable to a remote caller until an operator opts in, rather than a 401 that
would confirm it exists). Once a token is generated, every caller — including loopback — must supply
`Authorization: Bearer <token>`; missing, malformed, wrong, or revoked tokens all return the same
generic 401. The route is rate-limited (30 requests/minute per source IP).

### `/status` token lost, or the monitor is locked out

- **Trigger:** the external monitor started getting `401`, or the plaintext token was never captured.
- **Diagnose:** a `401` means a token exists and the presented value does not match. A `404` from a
  non-loopback caller means no token has been generated yet.
- **Fix:** Settings → Platform Admin (operator + MFA required) →
  `POST /api/v1/admin/settings/status-token/rotate` (or `.../generate` if none exists). Rotate issues
  a new token and immediately invalidates the old one; the plaintext is shown exactly once and is
  never persisted in plaintext or shown again — copy it immediately. `.../revoke` disables
  token-based access entirely, reverting to the loopback-only default.
- **Verify:** `.../test` calls the live check logic in-process and shows the current
  healthy/degraded/unavailable result without a separate `curl`; then confirm the monitor itself gets
  a `200`.
- **Rollback:** none — the old token cannot be restored. Re-point the monitor at the new value.

Note that the hash of this token is keyed by `OPERATIONAL_STATUS_TOKEN_HMAC_SECRET`; rotating that
secret also invalidates the token (see [`secret-rotation.md`](secret-rotation.md)).

**Reverse-proxy exposure:** if exposing `/status` to an external monitor over the public internet
(rather than calling it from inside the host network), always terminate TLS at a reverse proxy —
never forward the bare HTTP port. Configure the token in your monitor's `Authorization: Bearer`
header, not as a URL query parameter (query parameters are logged by intermediate proxies). See
[`reverse-proxy-tls.md`](reverse-proxy-tls.md).

---

## Normal startup and shutdown

- **Startup:** `docker compose up -d` (or the prod-override equivalent) followed by a **manual
  unseal** (below) — the vault never auto-unseals on container start; the master key/passphrase is
  never persisted in a way that would allow it.
- **Shutdown — data-preserving:** `docker compose down` (containers stop, volumes untouched).
- **Shutdown — destructive:** `docker compose down -v` **destroys the Postgres volume.** Never run
  this against a production volume without a fresh, verified backup in hand first (see
  [`backup-restore.md`](backup-restore.md)). The two flags differ by a single character — read twice
  before running either.
- The `api` container has a 30-second graceful-shutdown window (`stop_grace_period: 30s` in
  `docker-compose.yml`). Always stop it with `docker compose down`/`stop` (sends `SIGTERM`), never
  `docker kill`/`kill -9` (`SIGKILL`) in normal operation — a force-kill can interrupt an in-flight
  operation (e.g. a restore) mid-write.

---

## Manual unseal after an unexpected seal

- **Trigger:** `GET /ready` returns `503 {"status":"unavailable","reason":"sealed"}`, or the
  `vault_sealed` metric is `1`.

### Fix

`POST /api/v1/vault/unseal` — body depends on the instance's `kmsType` (exactly one field, matching
whatever mode the instance was initialized with):

```bash
# passphrase mode
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/unseal \
  -H 'Content-Type: application/json' -d '{"passphrase":"<the same passphrase from init>"}'

# envelope mode — VAULT_ENVELOPE_KEY_HALF is read from the container's own environment
# automatically; you only supply the file-half path (not already available to a fresh container)
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/unseal \
  -H 'Content-Type: application/json' -d '{"envelopeKeyPath":"/run/secrets/envelope-half.bin"}'

# file mode
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/unseal \
  -H 'Content-Type: application/json' -d '{"masterKeyPath":"/run/secrets/master.key"}'

# kms mode — empty body, no credentials in the request
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/unseal \
  -H 'Content-Type: application/json' -d '{}'
```

### Verify

Success: `200 {"unsealed":true,"keyVersion":<n>,"kmsType":"..."}`. Confirm with
`curl -sf http://localhost:${API_HOST_PORT}/ready` → `{"status":"ready"}`. No restart is needed — the flip is
immediate on the same request/response cycle.

### Failure modes

- **Wrong passphrase / key material:**
  `401 {"error":"unseal_failed","message":"Vault unseal failed: credentials do not match stored vault configuration."}`.
  The unseal endpoint is rate-limited to **5 requests per minute per IP** — repeated guesses are
  eventually throttled (`429`), not locked permanently. Stop and verify your passphrase/key source
  (e.g. password manager) rather than retrying blindly.
- **Envelope mode, missing file half:** if the file at `envelopeKeyPath` does not exist (or is not a
  regular file under `VAULT_KEY_DIR`), the response is `400 {"error":"key_file_not_found"}` — a
  distinct failure mode from a wrong-passphrase rejection. This means the file-half artifact is
  missing from this container, not that the credentials are wrong. Restore it from its original
  secure storage location before treating this as a lost-key scenario (see
  [`master-key.md`](master-key.md)).
- **KMS mode:** see [`master-key.md`](master-key.md) for `kms_key_unavailable`, `kms_unreachable`,
  `kms_permission_denied`.

### Rollback

There is nothing to roll back — an unseal either succeeds or leaves the vault sealed exactly as it
was. There is **no seal endpoint**: the only way to return an unsealed instance to the sealed state
is to restart the API process.

---

## Unexpected seal mid-operation — triage decision tree

1. **Check `GET /ready` first.** The response shape on any non-ready state is
   `503 {"status":"unavailable","reason":"<uninitialized|sealed|db>"}`:
   - `reason: "sealed"` → proceed straight to "Manual unseal" above.
   - `reason: "db"` → Postgres is unreachable. This is **not** a vault problem — do not attempt an
     unseal call (it will fail or hang against an unreachable database). Run `make db-up` or check
     `DATABASE_URL` / the `db` container's health first.
   - `reason: "uninitialized"` on a previously-`ready` instance should not happen. If seen, treat it
     as a possible volume/data-loss incident (see [`incident-response.md`](incident-response.md)),
     not a routine reseal.
2. **Check container logs** for the specific trigger:
   - OOM-kill: `docker inspect --format='{{.State.OOMKilled}}' <api-container>`.
   - Crash/panic: `docker compose logs api` for structured error-level log lines around the seal
     event.
   - Deliberate action: confirm with the team whether someone else restarted the container before you
     unseal into a possibly-unintended state.
3. **Remediate by cause**, then unseal: OOM → raise the container memory limit first; crash → capture
   the log excerpt before restarting (it scrolls away otherwise); deliberate → confirm with the team
   first.

**Repeated unexpected reseals** (e.g. multiple OOM-kills within an hour) are not a series of isolated
one-off unseals — escalate to [`incident-response.md`](incident-response.md) § Vault unreachable.
