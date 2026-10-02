# Fly demo internal TLS (private CA, mTLS)

<!-- Verified against scripts/fly-internal-tls.sh, scripts/fly-setup.sh, scripts/fly-migrate.sh,
     scripts/fly-reset.sh, scripts/fly-proxy-lib.sh, deploy/fly/db/{Dockerfile,pg_hba.conf,
     entrypoint-tls.sh}, fly.db.toml, .github/workflows/{fly-bootstrap,fly-deploy,fly-reset}.yml,
     apps/api/src/config/internal-tls.ts, apps/api/src/lib/internal-tls-status.ts,
     apps/api/src/routes/health.ts, packages/db/src/pg-tls.ts,
     apps/web/src/lib/server/internal-api-tls.ts (Story 43.16) -->

This covers the **Fly.io demo only**. docker-compose, the e2e stack, CI and local development keep
plaintext on their private networks, and every setting below is unset (off) there. Self-hosted
production behind a reverse proxy is covered by [`reverse-proxy-tls.md`](reverse-proxy-tls.md).

## When to use

- Setting up the Fly demo for the first time, or deploying the first release that contains
  Story 43.16 (the CA secrets must exist **before** that deploy).
- Rotating the internal leaf certificates (every ≤ 397 days) or the CA (every ≤ 825 days).
- `/ready` warns `internal_tls_cert_expiring`, `pv_internal_tls_cert_expiry_seconds` drops below
  30 days, or the api/web log `internal_tls.cert_expiring`.
- The web returns `503 api_unreachable` on every page, or the api cannot reach the db, right after
  a deploy or a rotation.

## Topology

```text
browser ──https (Fly edge)──> web (project-vault-demo-web, public)
                                │  https://project-vault-demo-api.internal:3000
                                │  TLS 1.3, server cert pinned to the private CA,
                                │  web presents its client cert (mTLS)
                                ▼
                              api (project-vault-demo-api, 6PN only, listener requires mTLS)
                                │  postgresql://…@project-vault-demo-db.internal:5432/…?sslmode=verify-full
                                │  TLS 1.3, CA pinned via DATABASE_TLS_CA_B64,
                                │  api presents CN=project-vault-demo-api (+ scram password)
                                ▼
                              db (project-vault-demo-db, 6PN only, deploy/fly/db image)
                                ▲  localhost:15432 via `flyctl proxy`
                                │  TLS 1.3 verify-full, 1-day CN=fly-operator cert (+ password)
                     operator scripts (fly-migrate.sh / fly-reset.sh in GitHub Actions)
```

Every hop is TLS 1.3, and every certificate chains to one private CA (ECDSA P-256, 825 days).
Another app in the same Fly org can dial `<app>.internal`, but without a client certificate signed
by that CA it fails the handshake (api) or is refused before authentication (db `pg_hba`
`clientcert=verify-ca`).

## Where the PKI lives

| What                                                      | Where                                                                                                       | Lifetime |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------- |
| CA certificate + key                                      | GitHub Actions secrets `FLY_DEMO_INTERNAL_CA_CERT_B64`, `FLY_DEMO_INTERNAL_CA_KEY_B64` (base64 PEM)         | 825 days |
| api server, api → db client, web client, db server leaves | Fly secrets, minted per `fly-setup.sh` run by `fly-internal-tls.sh issue-leaves`                            | 397 days |
| Operator client certificate                               | Minted per `fly-migrate.sh` / `fly-reset.sh` run by `issue-operator` into a `mktemp -d` dir removed on exit | 1 day    |

Only the setup, migrate and reset workflow steps receive the CA secrets; deploy steps never do.
Accepted trade-off (Nestor, 2026-09-29): anyone who can read GitHub Actions secrets can mint
internal certificates. That is the same trust boundary as `FLY_API_TOKEN` and the DB superuser
password, which already live there.

### Env vars per app

| App | Variable                                                      | Content                                                                                  |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| api | `API_TLS_CERT_B64`, `API_TLS_KEY_B64`                         | listener server cert (SAN `DNS:project-vault-demo-api.internal`, EKU serverAuth) and key |
| api | `API_TLS_CLIENT_CA_B64`                                       | CA the web's client cert must chain to (setting it turns on mTLS)                        |
| api | `DATABASE_TLS_CA_B64`                                         | CA pinned for every Postgres client (pools, pg-boss)                                     |
| api | `DATABASE_TLS_CLIENT_CERT_B64`, `DATABASE_TLS_CLIENT_KEY_B64` | api → db client cert (CN `project-vault-demo-api`, EKU clientAuth) and key               |
| api | `DATABASE_URL`, `ADMIN_DATABASE_URL`                          | end in `?sslmode=verify-full` (documentation; the pin is `DATABASE_TLS_CA_B64`)          |
| web | `API_BASE_URL`                                                | `https://project-vault-demo-api.internal:3000`                                           |
| web | `API_TLS_CA_B64`                                              | CA that must sign the api's server cert                                                  |
| web | `API_TLS_CLIENT_CERT_B64`, `API_TLS_CLIENT_KEY_B64`           | web client cert (CN `project-vault-demo-web`, EKU clientAuth) and key                    |
| db  | `DB_TLS_CERT_B64`, `DB_TLS_KEY_B64`                           | db server cert (SAN `DNS:project-vault-demo-db.internal`, `DNS:localhost`) and key       |
| db  | `DB_TLS_CLIENT_CA_B64`                                        | CA client certs must chain to (`ssl_ca_file`)                                            |

The api and web refuse to start (api) or to send a request (web) on a half-configured pair, a pair
without its CA, an https `.internal` `API_BASE_URL` without `API_TLS_CA_B64`, or TLS variables with
an `http://` `API_BASE_URL`. Errors name the variable, never the value. The db image exits non-zero
naming the missing `DB_TLS_*` variable.

## One-time CA setup (before the first deploy of this code)

Run locally, once. `fly-setup.sh`, `fly-migrate.sh` and `fly-reset.sh` fail closed without these
secrets, so they must exist **before** the first `fly-deploy`/`fly-bootstrap`/`fly-reset` run that
contains Story 43.16.

```bash
scripts/fly-internal-tls.sh init-ca --out ~/pv-ca          # refuses a non-empty directory
gh secret set FLY_DEMO_INTERNAL_CA_CERT_B64 -R nestormata/project-vault < ~/pv-ca/ca.crt.b64
gh secret set FLY_DEMO_INTERNAL_CA_KEY_B64 -R nestormata/project-vault < ~/pv-ca/ca.key.b64
# then store ~/pv-ca offline (encrypted) or delete it securely:
shred -u ~/pv-ca/ca.key ~/pv-ca/ca.key.b64 && rm -rf ~/pv-ca
```

`init-ca` prints only paths, the subject and `notAfter`, and writes 0600 files in a 0700 directory.

## First rollout of this story on the live demo

The order matters, and there is a short, expected outage window (a demo; no dual-stack):

1. CA secrets set (above).
2. Issue and stage the leaves, and switch the URLs: run the Fly Demo Bootstrap workflow (or
   `scripts/fly-setup.sh`) with the usual secrets plus `FLY_INTERNAL_CA_*_B64`. `fly-setup.sh`
   deploys the TLS-only db and **stages** every api and web secret (TLS leaves and the
   `?sslmode=verify-full` DB URLs alike), so it never restarts the running api; everything applies
   on each app's next deploy (Story 43.28). The bootstrap then runs, in order:
   **db → migrate (`fly-migrate.sh`, which also syncs the `vault_app`/`vault_admin` passwords) →
   api → ensure started (`fly-ensure-started.sh`) → web → first reset**.
   The old api still loses the db once the TLS-only db is up (it has no client certificate), so the
   short outage below starts here, not at the api deploy. If the bootstrap fails at
   `Run pending migrations`, the api has not been redeployed and its new secrets are only staged:
   the outage is the same as before, not worse. Fix the cause and re-run the Bootstrap. A
   destructive pending migration is refused by `guarded-migrate` and fails the run there, by design.
3. Full deploy: `fly-deploy.yml` already runs **db → migrate → api → web**.
   - Old api machines fail DB handshakes until the new api is up; old web machines fail api
     handshakes (web `503 api_unreachable`) until the new web is up. Minutes, not hours.
4. After any api restart the vault may be sealed: use the existing `fly-auto-unseal.yml` workflow
   or `scripts/fly-reset.sh` (no new unseal logic).

## Leaf rotation (routine, no GitHub change)

Re-run the `issue-leaves` path, then deploy db → api → web:

```bash
# locally, with the CA secrets' values in the environment, or via the Fly Demo Bootstrap workflow:
FLY_INTERNAL_CA_CERT_B64=… FLY_INTERNAL_CA_KEY_B64=… scripts/fly-internal-tls.sh issue-leaves
gh workflow run fly-deploy.yml -R nestormata/project-vault -f tag=vX.Y.Z   # db -> migrate -> api -> web
```

`issue-leaves` generates and verifies all twelve values before staging any of them. If a staging
call fails it exits with "re-run scripts/fly-internal-tls.sh before any deploy — staged TLS secrets
may be inconsistent across apps": re-run it; a clean run overwrites every staged value.

## CA rotation

1. `scripts/fly-internal-tls.sh init-ca --out ~/pv-ca-new`, then re-set both GitHub secrets.
2. Issue the leaves (step 2 of the first rollout) and run a full deploy. The outage window above
   applies, because the old leaves do not chain to the new CA.
   (`API_TLS_CLIENT_CA_B64`/`DATABASE_TLS_CA_B64` accept a PEM bundle, which allows a manual
   overlap rotation if the window ever matters.)

## Expiry alerting

- **api `/ready`:** stays `ready` but adds the generic warning token `internal_tls_cert_expiring`
  when a leaf the api holds is under **30 days** from `notAfter`. Nothing else: `/ready` is
  unauthenticated and the public web passes it through, so (like Story 56.2's watchdog token) it
  never says which leaf or how many days — read those from the gauge or the warn log below.
  Evaluated on each call; never flips `/ready` to not-ready (an expiring certificate still works).
  An already-expired certificate cannot be reported here: the api would not be reachable, or would
  have no DB pool.
- **api `/metrics`** (loopback only): `pv_internal_tls_cert_expiry_seconds{which="api-server"|"db-client"}`,
  seconds until `notAfter`. No series at all when TLS is off. Alert threshold: `< 2592000` (30 days).
- **Logs:** the api logs `internal_tls.configured` once at startup (`internalTls: off|tls|mtls`,
  `certSubjectAltName`, `certNotAfter`, `dbTls: off|pinned-ca`) and `internal_tls.cert_expiring`
  (`warn`, `daysRemaining`) per leaf under 30 days. The web logs `internal_tls.configured` on the
  first api call (mode, client-cert `notAfter`) and `internal_tls.cert_expiring` at first use and at
  most once per 24 h while under 30 days.
- **Handshake failures** on the api listener (an org-neighbour probe, or a stale web certificate)
  log `internal_tls.handshake_failed` (`warn`, `remoteAddress`, `code`), at most once per 60 s per
  remote address.

## Verify

```bash
# api startup line
fly logs -a project-vault-demo-api | grep internal_tls.configured   # internalTls "mtls", dbTls "pinned-ca"

# db side: every api connection is TLS 1.3 with the api's client DN
fly ssh console -a project-vault-demo-db -C \
  "psql -U postgres -d project_vault -c \"select usename, ssl, version, client_dn from pg_stat_ssl join pg_stat_activity using (pid) where client_addr is not null\""

# org-neighbour probe: no client cert -> handshake failure (curl exit 56/35, no HTTP status)
fly ssh console -a project-vault-demo-web -C \
  "sh -c 'echo \"\$API_TLS_CA_B64\" | base64 -d > /tmp/ca.pem; curl -sS --cacert /tmp/ca.pem https://project-vault-demo-api.internal:3000/health; echo exit=\$?; rm -f /tmp/ca.pem'"

# expiry signals from inside the api machine (loopback-only /metrics, mTLS listener)
fly ssh console -a project-vault-demo-api -C "sh -c 'd=\$(mktemp -d); \
  echo \"\$API_TLS_CLIENT_CA_B64\" | base64 -d > \$d/ca; echo \"\$DATABASE_TLS_CLIENT_CERT_B64\" | base64 -d > \$d/c; \
  echo \"\$DATABASE_TLS_CLIENT_KEY_B64\" | base64 -d > \$d/k; \
  curl -sS --cacert \$d/ca --cert \$d/c --key \$d/k --resolve project-vault-demo-api.internal:3000:127.0.0.1 \
    https://project-vault-demo-api.internal:3000/ready; echo; rm -rf \$d'"
```

The last command authenticates with the api's own DB client certificate. It is signed by the
private CA with EKU clientAuth, so the listener accepts it, and it never leaves the machine.
`/metrics` is fetched the same way with `/metrics` in place of `/ready`.

## Troubleshooting

| Symptom (most likely first)                                                                                                               | Cause                                                                                                  | Fix                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| web `503 api_unreachable` on every page right after a rotation or deploy                                                                  | web not yet redeployed with the new leaves (its client cert, or its CA pin, no longer matches the api) | finish the deploy (web is last); `fly deploy -c fly.web.toml` |
| web `503 api_unreachable`, api log `internal_tls.handshake_failed` with a web address                                                     | expired or foreign web client certificate                                                              | leaf rotation                                                 |
| api `/ready` → `503 {"reason":"db"}`, api log `DB handshake`/`SELF_SIGNED_CERT_IN_CHAIN`/`connection requires a valid client certificate` | db not redeployed with its new certificate, or the api is on old code that ignores `DATABASE_TLS_*`    | deploy db, then api                                           |
| api exits at boot: `API_TLS_KEY_B64 is required when API_TLS_CERT_B64 is set` (or similar)                                                | half-staged secrets                                                                                    | re-run `issue-leaves`, redeploy                               |
| db machine crash-loops: `DB_TLS_KEY_B64 is required`                                                                                      | db deployed before `issue-leaves` staged its secrets                                                   | run `issue-leaves` (or `fly-setup.sh`), redeploy db           |
| `fly-migrate.sh`/`fly-reset.sh`: `Set FLY_INTERNAL_CA_CERT_B64`                                                                           | CA GitHub secrets missing or not passed to that step                                                   | set the secrets; check the workflow step `env:`               |
| `internal_tls_cert_expiring` on `/ready`                                                                                                  | a leaf is < 30 days from `notAfter` (which one: the gauge or the `internal_tls.cert_expiring` log)     | leaf rotation                                                 |

Expired certificates: the first signature is web `503 api_unreachable` on every page (web ↔ api),
then api `/ready` failing on the DB (api ↔ db).

### api machine stopped after max restarts

Fly stops a machine that crash-loops past its max restart count (10). `flyctl apps restart` does not
start it, and `flyctl deploy` can leave it stopped while reporting a good state. Since Story 43.28
the bootstrap, `fly-deploy` and the reset start it themselves, but by hand:

```bash
flyctl machine list -a project-vault-demo-api            # STATE "stopped"?
./scripts/fly-ensure-started.sh project-vault-demo-api https://project-vault-demo-web.fly.dev
# or: flyctl machine start <id> -a project-vault-demo-api
```

Then read why it crashed: the api's single `startup.failed` line carries
`cause: {code, reason, depth}` (the SQLSTATE or Node error code only, never driver text). Read
`cause.code` as well as `cause.reason`: `auth_failed` covers two SQLSTATEs with different fixes.

| `cause.reason`      | Meaning                                                                                                                                                                                        | Fix                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_failed`       | `28P01`: the role passwords differ from the api secrets. `28000`: `pg_hba.conf` refused the connection, most often no or a wrong client certificate (an api older than 43.16, or stale leaves) | `28P01`: run `scripts/fly-migrate.sh` (it re-syncs `vault_app` and `vault_admin`). `28000`: check the api release and its staged TLS leaves, as for `tls_failed` |
| `tls_failed`        | the TLS leaves do not match                                                                                                                                                                    | `scripts/fly-internal-tls.sh issue-leaves`, then redeploy db → api → web                                                                                         |
| `schema_missing`    | migrations have not been applied                                                                                                                                                               | `scripts/fly-migrate.sh`                                                                                                                                         |
| `connection_failed` | the db app is down or still starting                                                                                                                                                           | check `flyctl machine list -a project-vault-demo-db`                                                                                                             |

## Rollback

Rolling back to a release **without** Story 43.16 needs more than a redeploy: old code cannot use
the `?sslmode=verify-full` URLs (postgres.js would verify against the public roots and fail), and
the old web cannot speak https to the api.

1. Reset the DB URL secrets without `sslmode` and `API_BASE_URL` back to
   `http://project-vault-demo-api.internal:3000` — i.e. run the previous release's
   `scripts/fly-setup.sh`.
2. Redeploy the stock db image (the previous `fly.db.toml`, `image = "postgres:16-alpine"`), then
   the previous api and web.
3. Unset the TLS secrets if desired (`fly secrets unset API_TLS_CERT_B64 … -a <app>`); they are
   ignored by old code either way.
