# Configuration reference

Every environment variable the API validates, taken from `apps/api/src/config/env.ts`, plus the
variables only `docker-compose*.yml` reads. The copyable starting point is
[`.env.example`](../.env.example); setup instructions are in the
[Operator Quickstart](operator-quickstart.md).

**How to read this page**

* **Default** is the value the app uses when the variable is unset. "—" means there is no default.
* **Prod** marks whether the variable must be set for a non-development deployment:
  * **required** — startup fails without it (and `docker-compose.prod.yml` fails at
    `docker compose config`).
  * **recommended** — the default is a localhost/dev convenience that is wrong in production.
  * blank — safe to leave alone.
* Nothing loads `.env` into the API process. Under Docker Compose the values are interpolated into
  the service definitions; for a host-run API you must export them yourself.
* Secrets: generate each with `openssl rand -hex 32` unless stated otherwise. The app rejects
  placeholder-looking values, the repository's own dev values, and duplicates between two secrets.

---

## Database & roles

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `DATABASE_URL` | — | **required** | Application connection string. Must name a non-superuser role (`vault_app`); `postgres` is rejected because it bypasses RLS. |
| `ADMIN_DATABASE_URL` | — | **required** | Connection used by `getAdminDb()` for reviewed cross-org / pre-auth reads and four maintenance writes. Must be the migrated non-superuser `BYPASSRLS` role (`vault_admin`) and a different role from `DATABASE_URL`. |
| `EXTENSION_DATABASE_URL` | unset | | Separate pool for an extension's operator-approved DB scope. Never `postgres`, `vault_app` or `vault_admin`. |
| `EXTENSION_DATABASE_POOL_MAX` | `3` | | Maximum connections in that extension pool. |

## Vault & key management

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `VAULT_KEY_DIR` | `/run/secrets` | | Directory holding envelope/file key halves; mounted read-only in production. |
| `VAULT_ENVELOPE_KEY_HALF` | unset | envelope mode only | The operator-held half of the split master key, 32 lowercase hex chars (`openssl rand -hex 16`). Unseal fails without it once the vault was initialized in envelope mode. |
| `VAULT_BOOTSTRAP_TOKEN` | unset | **required** | First-init protection, minimum 32 chars (`openssl rand -base64 32`). Without it every `POST /vault/init` returns `403 BOOTSTRAP_FORBIDDEN`. |
| `VAULT_ALLOW_REMOTE_INIT` | `false` | must stay `false` | Dev-only escape hatch that skips the bootstrap token on init. |
| `VAULT_KMS_ENDPOINT` | unset | leave unset | LocalStack/test-only KMS endpoint override. Real KMS credentials come from the AWS SDK provider chain; the key id is supplied per request at `POST /vault/init`. |

## Authentication & sessions

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `SESSION_SECRET` | dev value | **required** | Signs human session JWTs. |
| `REFRESH_TOKEN_HMAC_SECRET` | dev value | **required** | Keys the stored refresh-token hash. |
| `JWT_ACCESS_TTL_SECONDS` | `300` | | Access-token lifetime (max 600). |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | | Refresh-token lifetime. |
| `REFRESH_GRACE_WINDOW_SECONDS` | `30` | | Window in which a just-rotated refresh token is still accepted (client retry tolerance). |
| `JWT_MAX_CLOCK_SKEW_SECONDS` | `30` | | Accepted clock skew when verifying tokens. |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `30` | | Idle time after which a session is invalidated. |
| `SESSION_ACTIVITY_DEBOUNCE_SECONDS` | `60` | | Minimum interval between session "last active" writes. |
| `MAX_SESSIONS_PER_USER` | `0` | | Concurrent-session cap; `0` = unlimited. |
| `COOKIE_SECURE` | `true` when `NODE_ENV=production`, else `false` | | Sets the `Secure` flag on auth cookies. Browsers accept `Secure` on `http://localhost`, but not on a plain-HTTP LAN address. |
| `AUTH_REGISTRATION_ENABLED` | `true` | | Master switch for self-service registration. |
| `AUTH_DUMMY_PASSWORD_HASH` | dev hash | | Dummy Argon2 hash used to equalize unknown-email login timing. |
| `ARGON2_MEMORY_COST` | `65536` | | Argon2id memory cost (KiB). |
| `ARGON2_TIME_COST` | `3` | | Argon2id iterations. |
| `ARGON2_PARALLELISM` | `4` | | Argon2id parallelism. |
| `INVITATION_TOKEN_HMAC_SECRET` | dev value | **required** | Keys team-invitation acceptance tokens. |
| `RECOVERY_TOKEN_HMAC_SECRET` | dev value | **required** | Keys account-recovery / reactivation tokens. |
| `WEB_BASE_URL` | `http://localhost:5173` | recommended | Base URL used to build invitation and recovery links in email. This is the literal schema default; under Compose it follows `PUBLIC_WEB_ORIGIN` instead. |
| `SSO_STATE_HMAC_SECRET` | dev value | **required** | Signs the SSO login-state cookie/param, preventing callback CSRF and state tampering. |
| `API_KEY_HMAC_SECRET` | dev value | **required** | Keys the machine-user API-key hash. |
| `MACHINE_JWT_SECRET` | dev value | **required** | Signs the machine token-exchange JWT — an HS256 context independent of `SESSION_SECRET`. |
| `MACHINE_JWT_TTL_SECONDS` | `3600` | | Machine access-token lifetime. |
| `ERASURE_EMAIL_HASH_SECRET` | dev value | **required** | Keys `data_erasure_requests.original_email_hash`. Never reuse an auth-token secret here. |
| `VAULT_NATIVE_LOGIN_BREAK_GLASS` | `false` | leave `false` | Incident break-glass: re-enables every native-credential route regardless of the resolved policy. Warns loudly on every boot. |
| `VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED` | `false` | leave `false` | Disables native login on the strength of an extension's manifest declaration alone, skipping the proving latch. |

## Multi-factor authentication

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `MFA_TOTP_ISSUER` | `Project Vault` | | Issuer label shown in the user's authenticator app. |
| `MFA_TOTP_PERIOD_SECONDS` | `30` | | TOTP step length. |
| `MFA_TOTP_DIGITS` | `6` | | TOTP code length. |
| `MFA_TOTP_WINDOW` | `1` | | Number of steps either side of "now" accepted. |
| `MFA_RECOVERY_CODE_COUNT` | `10` | | Recovery codes issued at enrollment. |
| `MFA_RECOVERY_CODE_BCRYPT_COST` | `12` | | bcrypt cost for stored recovery codes. |
| `TOTP_USED_CODES_TTL_MINUTES` | `90` | | How long a used TOTP code is remembered for replay rejection. |
| `TOTP_REPLAY_HMAC_SECRET` | dedicated dev value | **required** | Keys the replay cache. It has its own dev fallback and must differ from `REFRESH_TOKEN_HMAC_SECRET` — equality is rejected at startup. |
| `MFA_PENDING_SESSION_TTL_SECONDS` | `300` | | Lifetime of the pending-MFA session between the password and TOTP steps. |
| `MFA_PENDING_SESSION_HMAC_SECRET` | dev value | **required** | Signs that pending-MFA session. |
| `MFA_LOGIN_MAX_ATTEMPTS` | `5` | | TOTP attempts allowed per pending session. |
| `MFA_PRIVILEGED_ROLE_GRACE_DAYS` | `7` | | Grace period before a newly privileged user must have MFA enrolled. |

## Rate limits, lockout & abuse detection

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `AUTH_RATE_LIMIT_MAX` | `60` | | Global per-IP limit for `/register` + `/login` per minute. |
| `AUTH_REGISTER_RATE_LIMIT_MAX` | `10` | | Stricter per-route limit for `/register`. |
| `AUTH_SSO_DOMAIN_LOOKUP_RATE_LIMIT_MAX` | `20` | | Limit for the public SSO domain-lookup endpoint. |
| `RATE_LIMIT_TEST_BYPASS` | `false` | never set | Skips rate-limit enforcement; requires `NODE_ENV=test` as well. |
| `LOGIN_LOCKOUT_THRESHOLD` | `10` | | Failed logins that synchronously lock an account. |
| `LOGIN_LOCKOUT_WINDOW_SECONDS` | `900` | | Rolling window for that lockout counter. |
| `FAILED_AUTH_THRESHOLD_COUNT` | `10` | | Failures that raise an asynchronous operator alert (never blocks login). |
| `FAILED_AUTH_THRESHOLD_WINDOW_SECONDS` | `300` | | Window for that alert threshold. |
| `FAILED_AUTH_RETENTION_HOURS` | `24` | | Retention of `failed_auth_attempts` rows. |
| `FAILED_AUTH_RECORD_ENABLED` | `true` | | Master switch for recording failed-auth attempts. |
| `ANOMALOUS_ACCESS_THRESHOLD_COUNT` | `5` | | Credential reads that trigger an anomalous-access alert. |
| `ANOMALOUS_ACCESS_WINDOW_SECONDS` | `3600` | | Window for that detector. |

## Audit log & per-org quotas

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `AUDIT_LOG_STORAGE_LIMIT_GB` | `50` | | Instance-wide audit-storage alert threshold (physical bytes). |
| `PLATFORM_AUDIT_RETENTION_DAYS` | `365` | | Retention for the platform-operator audit log. |
| `PLATFORM_AUDIT_STORAGE_LIMIT_GB` | `5` | | Storage alert threshold for that log. |
| `PLATFORM_RESOURCE_USAGE_ORG_LIST_CAP` | `500` | | Maximum organizations listed in the platform resource-usage view. |
| `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` | `true` | | Enforce per-organization audit-storage quotas. |
| `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB` | `2048` | | Default per-org quota (logical MB); `0` = unlimited. |
| `AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE` | `3.0` | | Physical-to-logical multiplier used when comparing usage against the quota. |
| `AUDIT_ORG_PREAUTH_ALERT_THRESHOLD_MB` | `0` | | Pre-authorization alert threshold; `0` disables it. |
| `AUDIT_ORG_USAGE_RECONCILE_CRON` | `0 5 * * 0` | | Schedule for the usage reconciliation job. |
| `AUDIT_ORG_USAGE_RECONCILE_TIMEOUT_MS` | `300000` | | Timeout for one reconciliation run. |
| `AUDIT_ORG_USAGE_STALE_AFTER_HOURS` | `240` | | Age at which cached per-org usage is considered stale. |
| `AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED` | `false` | | Enforce per-org audit write-rate limits. |
| `AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN` | `0` | | Default per-org write rate; `0` = unlimited. |
| `AUDIT_ORG_WRITE_RATE_WINDOW_MS` | `60000` | | Sliding window for that rate limit. |

## Credential rotation & retention

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `ROTATION_MAX_RETRIES` | `3` | | Retry cap for a rotation checklist item; re-read on every retry call. |
| `BREAK_GLASS_OVERLAP_MINUTES` | `60` | | Overlap window in which the old and new credential are both valid during emergency rotation. |
| `BREAK_GLASS_IDEMPOTENCY_WINDOW_SECONDS` | `10` | | Double-submit protection window for break-glass rotation. |
| `STALE_ROTATION_THRESHOLD_MINUTES` | `60` | | Age at which an in-flight rotation is reported stale. |
| `STALE_STAGED_ROTATION_THRESHOLD_DAYS` | `14` | | Age at which a STAGED rotation raises an alert — separate from the minutes threshold above. |
| `KEY_ROTATION_MAX_AGE_DAYS` | `365` | | Age at which the master key is reported overdue for rotation. |
| `CREDENTIAL_RETENTION_DRY_RUN` | `true` when `NODE_ENV=production`, else `false` | | The retention purge is irreversible; production defaults to log-only. Set `false` only after verifying dry-run output and backups. |

## Backup & restore

Backup is opt-in: leave `BACKUP_STORAGE_PATH`, `BACKUP_S3_BUCKET` and `BACKUP_DATABASE_URL` unset
and no scheduling happens at all. Configure exactly one destination (path **xor** bucket).

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `BACKUP_SCHEDULE` | `0 3 * * *` | | Cron expression for the scheduled encrypted snapshot. |
| `BACKUP_RETENTION_COUNT` | `7` | | Snapshots kept before the oldest is pruned. |
| `BACKUP_MAX_AGE_HOURS` | `25` | | Age after which a missing backup raises a missed-backup alert. |
| `BACKUP_DATABASE_URL` | unset | required to enable backup | Connection used by `pg_dump`/`pg_restore`. Must bypass RLS (the superuser, or a dedicated `BYPASSRLS` role). |
| `BACKUP_STORAGE_PATH` | unset | | Filesystem destination. Must be writable by uid:gid 1000:1000; the entrypoint repairs a named volume's ownership automatically. |
| `BACKUP_S3_BUCKET` | unset | | S3 destination bucket (alternative to the path above). |
| `BACKUP_S3_ENDPOINT` | unset | | Custom S3 endpoint (MinIO, R2, …). |
| `BACKUP_S3_REGION` | unset | | S3 region. |
| `BACKUP_S3_STAGING_PATH` | `os.tmpdir()/vault-backup-staging` | | Local staging directory for the S3 destination only. The default is ephemeral `/tmp`; point it at a mounted volume if a failed upload's staged file should survive a restart. |
| `BACKUP_S3_STAGING_MAX_BYTES` | unset | | Monitoring threshold for total `.staged` usage; raises an alert, never blocks a backup. |

## Notifications & email

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `SMTP_HOST` | unset (`mailpit` under Compose) | recommended | SMTP server host. A host-run API talking to the local Mailpit uses `127.0.0.1`. |
| `SMTP_PORT` | unset (`1025` under Compose) | recommended | SMTP port. |
| `SMTP_SECURE` | unset (`false` under Compose) | recommended | Use implicit TLS for the SMTP connection. |
| `SMTP_USER` | unset | | SMTP username, when the provider requires auth. |
| `SMTP_PASS` | unset | | SMTP password. |
| `SMTP_FROM` | unset (Compose supplies a `notifications` sender at the `project-vault.local` domain) | recommended | Verified sender address for outgoing mail. |
| `SLACK_WEBHOOK_URL` | unset | | Incoming-webhook URL for Slack notifications; omit to disable the channel. |
| `NOTIFICATION_DIGEST_HOUR` | `8` | | Hour (UTC, 0–23) at which the daily digest email is sent. |
| `INBOX_RETENTION_DAYS` | `90` | | Retention for in-app inbox entries before automatic purge. |

## Monitoring, health & observability

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `LOG_LEVEL` | `info` (`silent` when `NODE_ENV=test`) | | Pino log level. Keep `debug`/`trace` out of production. |
| `SERVICE_NAME` | `api` | | Service name stamped on structured logs and metrics. |
| `METRICS_BIND_HOST` | `127.0.0.1` | | Interface the Prometheus `/metrics` listener binds. Use `0.0.0.0` only for an intended external scraper. |
| `STATUS_PAGE_TOKEN_HMAC_SECRET` | dev value | **required** | Signs public status-page opaque tokens. |
| `OPERATIONAL_STATUS_TOKEN_HMAC_SECRET` | dev value | **required** | Keys the `GET /status` bearer-token hash (`operational_status_tokens`). |
| `STATUS_DISK_MIN_FREE_PERCENT` | `10` | | Free-disk percentage below which `GET /status` reports disk pressure. |
| `MAX_SERVICE_ENDPOINTS_PER_PROJECT` | `25` | | Cap on monitored HTTP endpoints per project. |
| `HEALTH_CHECK_MAX_CONCURRENCY` | `20` | | Parallelism of the endpoint health-check sweep. |

## Extensions & theming

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `VAULT_EXTENSIONS_PACKAGE` | unset | | Exact package identity of a founder-trusted extension, dynamically imported at boot. Unset means zero extension code loads. |
| `VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST` | `false` | leave `false` | Incident-only rollback escape allowing a same-major extension above the host's API version. Warns on every boot. |
| `VAULT_THEMES_DIR` | `/data/themes` | | Directory of admin-installed theme packs, kept on a persistent volume so they survive image upgrades. An absent directory is zero behaviour change. |

## Handoff & service integration

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `VAULT_HANDOFF_ENABLED` | `false` | | Master switch for the CentralizeMe browser-handoff login. |
| `VAULT_HANDOFF_INSTANCE_ID` | unset | required when enabled | This instance's identifier in the handoff claim. |
| `VAULT_HANDOFF_VERIFY_KEYS` | unset | required when enabled | Public key(s) used to verify the router's handoff assertion. |
| `VAULT_HANDOFF_ISSUER` | `https://app.centralizeme.com` | | Exact expected `iss` claim; a mismatch is rejected as `handoff_malformed_claim`. |
| `VAULT_HANDOFF_CLOCK_SKEW_WARN_MS` | `20000` | | Skew above which a clock-skew warning is raised. |
| `SERVICE_PROVISIONING_TOKEN` | unset | | Shared secret gating `POST /api/v1/service/organizations`. Unset means the route is unreachable (fail-closed). Generate with `openssl rand -base64 32`. |
| `SERVICE_REVOCATION_TOKEN` | unset | | Shared secret for the companion service-side revocation callback. Same fail-closed default. |

## Platform & infrastructure

| Variable | Default | Prod | Purpose |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | Selects strict production validation. Docker Compose forces `production` for the api and web services regardless of `.env`. |
| `API_PORT` | `3000` | | Port the API listens on **inside** its process/container. Not the published host port. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173` | recommended | Browser origins allowed to make credentialed requests; a literal `*` is rejected at boot. This is the literal schema default; under Compose it is derived from `PUBLIC_WEB_ORIGIN`. |
| `ENABLE_API_DOCS` | `false` (auto-on when `NODE_ENV` is development or test) | | Exposes `GET /api/v1/openapi.json` and the Swagger UI at `GET /api/v1/docs`. |

## Compose-only variables

Not part of the API's schema — read by `docker-compose*.yml` interpolation, so
`pnpm check-env-example` does not police them.

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `PUBLIC_WEB_ORIGIN` | `http://localhost:${WEB_HOST_PORT}` | `docker-compose.yml` | The exact origin browsers use. Feeds the api's `CORS_ALLOWED_ORIGINS`, the web service's `ORIGIN`, and `WEB_BASE_URL`. Required for any non-localhost deployment. |
| `TRUST_PROXY` | `false` | `docker-compose.yml` | Trust `X-Forwarded-*` headers. Set `true` behind a reverse proxy. |
| `TRUST_PROXY_HOPS` | `1` | `docker-compose.yml` | Number of proxies in front of the API, so the real client IP is used for rate limiting and audit logging. |
| `POSTGRES_USER` | `postgres` | `db`, `migrate`, `admin-provision` | Superuser for the Postgres container itself. |
| `POSTGRES_PASSWORD` | `password` | same | Superuser password. |
| `POSTGRES_DB` | `project_vault` | same | Database name. |
| `VAULT_ADMIN_PASSWORD` | `password` | `admin-provision`, `api` | Password the `admin-provision` service assigns to `vault_admin`, and the one Compose builds the api's `ADMIN_DATABASE_URL` from. Change it in production. |
| `DB_HOST_PORT` | `5432` | `db` | Host port Postgres is published on (loopback only). Rewritten per checkout by `scripts/docker-ports.sh`. |
| `API_HOST_PORT` | `3000` | `api` | Host port for the API. Rewritten per checkout. |
| `WEB_HOST_PORT` | `5173` | `web`, api CORS | Host port for the web app. Rewritten per checkout. |
| `MAILPIT_UI_HOST_PORT` | `8025` | `mailpit` | Host port for the Mailpit inbox UI. |
| `MAILPIT_SMTP_HOST_PORT` | `1025` | `mailpit` | Host port for Mailpit's SMTP listener. |
| `VAULT_IMAGE_REPO` | `ghcr.io/nestormata/project-vault` | `docker-compose.images.yml` | GHCR namespace for the prebuilt images; change it for a fork. |
| `VAULT_IMAGE_TAG` | `latest` | `docker-compose.images.yml` | Release tag to run. Pin an exact version in production. |
| `BACKUP_NFS_PATH` | — | `docker-compose.nfs.yml` | Host path of the mounted NFS export bind-mounted at `/var/backups/vault`. Required whenever that overlay is used. |
| `DOCKER_PORTS_KEEP_DEFAULTS` | unset | `scripts/docker-ports.sh` | Set to `1` to keep 5432/3000/5173 instead of per-checkout ports. Busy ports are still moved. |

## Operator-only

| Variable | Default | Purpose |
|---|---|---|
| `EXTENSION_GRANT_DATABASE_URL` | unset | Higher-privilege connection used by operator tooling to **grant** the extension role its scope. **Never** place it in the API container environment, a Compose service, or any process that serves requests. |

## Local tooling

`SONAR_TOKEN`, `SONAR_ORGANIZATION`, `SONAR_PROJECT_KEY` and `SONAR_HOST_URL` are used only by
`make sonar-issues` / `scripts/sonar-issues.sh` to read SonarCloud results from the CLI. CI runs
the scanner from `sonar-project.properties` instead. See [docs/sonarqube.md](sonarqube.md).

---

## See also

- [Operator Quickstart](operator-quickstart.md) — the four setup paths
- [`.env.example`](../.env.example) — the copyable file, grouped the same way
- [Operational runbook](runbook.md) — running a live instance
