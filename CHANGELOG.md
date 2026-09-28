# Changelog

All notable changes to Project Vault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The `@project-vault/extension-api` package has its
own changelog at [packages/extension-api/CHANGELOG.md](packages/extension-api/CHANGELOG.md); the
GitHub Action in [packages/vault-action](packages/vault-action/README.md) is released on its own
`vault-action-v*` tags. How a release is cut is documented in [docs/releasing.md](docs/releasing.md).

## [Unreleased]

### Security

- `pvault` now strips Unicode bidi controls, zero-width characters and other invisible format
  characters (as well as control characters) from every string it prints, so a hostile server,
  credential name or command cannot visually reorder or hide what you read. Error text that comes
  from the server or a library is now printed on one line and capped at 500 characters.
- The API now drops an `x-vault-target-command` audit value that contains such characters (the
  reveal itself still succeeds and is still audited), and the agent strips them before sending it.

## [1.3.0] - 2026-09-27

Container images: `ghcr.io/nestormata/project-vault/{api,migrate,web}:1.3.0`
(aliases `1.3`, `1`, `latest`). Extension API contract: `@project-vault/extension-api@3.24.1`;
this host loads extensions whose manifest `apiVersion` is in `>=3.0.0 <=3.24.1`
(`HOST_SUPPORTED_EXTENSION_API_RANGE`). CLI: `pvault-1.3.0.mjs` on this release's assets.

### Upgrade notes (read before `docker compose pull`)

- **Migrations 0094-0100 run automatically** via the `migrate` service. All seven are additive
  (three new tables, nullable or defaulted new columns, new indexes), and the migration guard
  refuses none of them. None backfills existing rows. Migration 0098 builds a partial index on
  `notification_queue`, which briefly blocks writes to that table in proportion to its size.
  Images on `latest`, `1` or `1.3` pick these migrations up on the next pull.
- **No new required environment variables.** Four new optional API variables tune the
  scheduled-task extension hook: `MIN_SCHEDULED_TASK_INTERVAL_MINUTES` (default `1`),
  `MAX_SCHEDULED_TASKS_PER_EXTENSION` (default `32`), `SCHEDULED_TASK_MAX_CONCURRENCY`
  (default `20`) and `SCHEDULED_TASK_MISSED_TICK_THRESHOLD` (default `3`, range `2`-`100`; see
  the missed-tick alert under Added). `docker-compose.yml` does not forward them; to change one under Compose, add it
  to the `api` service's `environment`.
- **CLI:** new optional API variables `CLI_MINIMUM_SUPPORTED_VERSION` and `CLI_WITHDRAWN_VERSIONS`
  tighten the `pvault` version policy. Both are unset by default, and an invalid value fails boot.
  See [`docs/runbooks/cli-version-policy.md`](docs/runbooks/cli-version-policy.md).
- **Backup and restore now run `pg_dump` and `psql` only from `/usr/bin`, `/usr/local/bin` or
  `/bin`**, never from `$PATH`. The API image already installs them in `/usr/bin`. An API run
  outside the container whose PostgreSQL clients live elsewhere (for example
  `/usr/lib/postgresql/16/bin`) now fails backup and restore with `pg_dump not found in …`; link
  the clients into one of those directories. See
  [`docs/runbooks/backup-restore.md`](docs/runbooks/backup-restore.md).
- **Fly.io demo scripts:** `scripts/fly-setup.sh` and `scripts/fly-reset.sh` now require
  `VAULT_APP_PASSWORD` and no longer fall back to the migration's publicly known development
  password.
- **Handoff SSO (CentralizeMe):** `POST /api/v1/auth/handoff/prepare` now also returns a
  single-use `claim`, which `/handoff` exchanges same-origin for the `handoff-confirm` cookie. The
  existing cookie is still set, so a caller that ignores `claim` keeps working exactly as before.
- **Scripts that deactivate or remove users** (`POST /api/v1/org/users/:userId/deactivate`,
  `DELETE /api/v1/org/users/:userId`) now get `409` with `error: "active_rotations"` and the
  blocking `rotationIds` when the user initiated an unfinished rotation; before 1.3.0 the request
  succeeded and orphaned the rotation. Finish or abandon those rotations first, or send
  `{"rotationHandling": "abandon"}` (the only accepted value; anything else returns `422`). A
  `409` with `code: "rotation_busy"` means a rotation was being changed at that moment; retry.
- **Extension panels now show the extension's own html on failed actions.** When a module action
  returns `denied`, `conflict`, `validation_failed` or `error` with `html`, the panel displays it
  (sanitized, like a successful result) in place of its content, above the usual status message;
  before 1.3.0 that html was discarded and the user saw only a generic message. This needs no
  extension upgrade, so an installed extension that already attached html to failures (for example
  by spreading a result object) starts showing it on upgrade. Before upgrading, check that your
  extensions' failure html (CentralizeMe's included) contains no exception, stack-trace or database
  text and only the requesting organization's data. A hook that throws, times out or returns a
  malformed result still shows only the generic error.

### Added

- **The `pvault` command-line client**, a new `@project-vault/cli` package. It needs Node.js 20
  or newer on `PATH`; install it from this release's assets as described in
  [`packages/cli/README.md` "From a release"](packages/cli/README.md#from-a-release-story-436).
  - `pvault get <name>` prints one secret using a machine-user API key (`VAULT_API_KEY`), with
    the same offline encrypted-cache fallback as the GitHub Action. It refuses to print to an
    interactive terminal unless you pass `--stdout`. (#438)
  - `pvault login` / `pvault logout` sign a human user in with email, password and TOTP. The
    session is stored in a `0600` file under `~/.config/pvault` and refreshed silently. New
    endpoints: `POST /api/v1/auth/cli-login`, `/cli/mfa/verify-login`, `/cli/refresh` and
    `/cli/logout`. (#440)
  - `pvault run --secret NAME[=ENV_VAR] … -- <command>` runs a command with secrets in its
    environment, never on its command line. The fetch is all-or-nothing, and the child's exit code
    and signal are passed through. `--secrets-fd` delivers the secrets as JSON on file descriptor
    3 instead, keeping them out of `/proc/<pid>/environ`. (#442, #444)
  - `pvault write-env --secret NAME … --output <path>` writes a named set of secrets to an
    owner-only (`0600`) dotenv or shell file. It refuses to overwrite without `--force`, never
    writes through a symlink, and warns when the target is not gitignored. (#443)
- `pvault` now checks the server's CLI version policy before `get`, `run`, `write-env` and
  `login`. It prints a notice when it is older (or newer) than the server's release, warns below
  the minimum supported version, and refuses with exit code `29` when its exact version has been
  withdrawn. The check never blocks when the server is unreachable (1.5 s timeout, cached), and
  `PVAULT_NO_VERSION_CHECK=1` silences the notices, but never the withdrawn refusal.
- Public endpoint `GET /api/v1/client-version-policy` (unauthenticated, static, rate-limited).
- `pvault --version` reports the bundled agent's version and commit next to the CLI's.
- Platform Admin → Version & Upgrade shows the effective CLI version policy (current release,
  minimum supported version, withdrawn versions with reasons) exactly as the API publishes it, and
  flags a policy that contradicts the server's own release.
- `docker-compose.yml` now passes `CLI_MINIMUM_SUPPORTED_VERSION` and `CLI_WITHDRAWN_VERSIONS`
  to the `api` service; before this, setting them in the compose `.env` had no effect.
- Each GitHub Release now carries a single-file `pvault-X.Y.Z.mjs` CLI bundle and its `.sha256`
  (Node 20 or newer). See `docs/releasing.md` §8.
- `pvault` exits with the new code `30` when the server rate-limits `login`, MFA verification or
  a session refresh, and prints how long to wait. It no longer reports that as a wrong password or
  an expired session, and never deletes the session file because of it. `pvault logout` now warns
  when a rate-limited logout left the session valid on the server.
- Audit entries for secret reads made by `pvault` record which command asked for them
  (`clientInvocation`, and for `run` the target command's basename as `clientTargetCommand`). An
  invalid value is dropped and flagged, never failing the request. (#444)
- Extension API 3.16.0 through 3.24.1 (see
  [its changelog](packages/extension-api/CHANGELOG.md)):
  - `oauthHandoff` hook: an extension can run an OAuth-style redirect and provider callback
    through PV-hosted routes, limited to the origins in its manifest's `redirectOrigins`. (#415)
  - Request state for extensions: the OAuth callback can persist state that a later module action
    reads (`ModuleActionContext.requestState`) or consumes once
    (`HostServices.extensionRequestState`), bound to the organization and identity. (#419)
  - `scheduledTasks` manifest entries and an `onScheduledTask` hook run periodic background work
    once per active organization, with an operator-tunable interval floor, task cap and
    concurrency. (#418)
  - Missed scheduled-task alert: every scheduled-task invocation attempt is now recorded
    (migration 0100), and a watchdog raises one operator alert when a declared task has made no
    attempt for `max(SCHEDULED_TASK_MISSED_TICK_THRESHOLD × interval, 10 minutes)`: an admin
    alert, an error log, a platform-operator notification, a Prometheus gauge and a `/ready`
    warning. It resolves itself when the task runs again or is no longer declared.
    (Story 56-2, #466)
  - `HostServices.monitoring.createServiceEndpoint` and the out-of-request
    `listServiceEndpointsForScheduling`, which returns endpoint URLs unredacted so that the
    extension can probe them; extensions must not log them. (#417, #420)
  - `HostServices.notificationOriginator.enqueueNotificationForOrg`, usable outside a request,
    with its own rate-limit budget. (#426)
  - `HostServices.credentialSharing`: create, find, reveal, revoke and supersede external shares,
    and list shares per credential or organization, with a per-organization sliding-window limit
    on token lookups. (#431, #435)
  - `publicRoute` hook: anonymous routes an extension declares in `anonymousRoutePaths`, behind
    the `public-route` capability. Undeclared and denied paths return the same 404, and
    redirects are rejected. (#435)
  - `ActionResult.html` is now shown for every outcome, not only `ok`, after sanitization. (#447)

### Changed

- A module action result whose `html` is present but is not a string is now treated as
  malformed and returns the generic `500`, instead of being mapped by its outcome. Such a value
  was never type-valid. (#447)
- Module-action panels display the html an extension returns with a denied, conflict,
  validation-failed or error outcome in place of the panel content, instead of leaving the panel
  unchanged with only the status message. The denied `message` text is still never shown. (#447)
- `HostServices.monitoring`'s in-request methods reject a malformed `projectId`,
  `serviceEndpointId` or `userId` with the typed `MonitoringInvalidServiceEndpointInputError`
  instead of an unclassified database error. (#433)
- Deactivating or removing a user who initiated an unfinished rotation (`staged`, `promoted`,
  `stale_recovery` or legacy `in_progress`) is refused with `409 active_rotations` and changes
  nothing, so no rotation is silently orphaned. With `rotationHandling: "abandon"` the same
  request abandons that user's `staged` and `stale_recovery` rotations (audited), keeps
  `promoted` and `in_progress` ones for an admin to retire later, then deactivates or removes the
  user, and returns
  `abandonedRotationCount` and `heldRotationCount`. Settings → Users explains the refusal and
  offers to abandon the rotations and deactivate or remove the user. (Story 43-15, #460)
- The `migrate` image is much smaller (about 254 MB instead of 1.26 GB) and carries production
  dependencies only: `guarded-migrate` now applies migrations with drizzle-orm's migrator instead
  of spawning drizzle-kit. Its invocation and the resulting schema are unchanged.
  (Story 64-3, #465)

### Fixed

- The `web` service's Docker Compose environment never carried `CORS_ALLOWED_ORIGINS`, so the
  handoff-prepare CORS check always rejected every origin under `docker compose up`, including
  Project Vault's own. `docker-compose.yml`'s `web` service now gets the same
  `CORS_ALLOWED_ORIGINS` value the `api` service already uses. (Story 60-1)
- A panel action click made after the 5-minute access-token TTL returned `401` and showed "Unable
  to complete this action. Please try again.", with retrying never helping — the panel dispatcher
  bypassed the app's refresh-on-401 path. It now refreshes the session and retries once
  automatically, or sends the user to the login page if the session is dead. (Story 61-1)
- Browsers dropped the cross-site `handoff-confirm` cookie, so CentralizeMe handoff sign-in could
  fail on a cross-site deployment. The new same-origin claim exchange (see Upgrade notes) sets the
  cookie with `SameSite=Strict` intact. `/handoff` now sends `Referrer-Policy: strict-origin`, and
  the claim is redacted from security-event logs. Migration 0099 adds the claim column.
  (Story 60-3, #455)

### Security

- The CLI auth endpoints are now rate limited per IP, like their browser equivalents:
  `POST /api/v1/auth/cli-login` and `/cli/logout` at `AUTH_RATE_LIMIT_MAX` (default 60) per
  minute, `/cli/mfa/verify-login` at 20 and `/cli/refresh` at 120. Before this, the limits in the
  route definitions were never enforced, so `/cli-login` accepted unlimited password attempts per
  IP. Over-limit requests get `429` with `Retry-After`. The CI route audit now fails any public
  route that claims an IP rate limit without actually registering one.
- The pinned `node:24-alpine` base image (API and web Docker images) is refreshed to clear
  CVE-2026-14456 (`libssl3`/`libcrypto3`, HIGH). A new guard test keeps every `FROM` line across
  the API, web and CI Dockerfiles pinned to one identical digest. (Story 64-1)
- Outbound-URL checks (monitoring targets, audit-log forwarding, theme asset URLs) now also block
  `0.0.0.0/8` and `::`, which reach loopback on Linux. Addresses are classified with `ipaddr.js`
  behind a strict-format check, and IPv6 zone-ID forms fail closed. (Story 43-9, #457)
- `pvault run` strips `VAULT_API_KEY` from the child's environment, disables Node diagnostic
  reports, and never echoes a secret value in a spawn error. (#444)
- Dependency supply chain: the high-severity advisory `GHSA-2883-xcg3-v3hh` (`js-yaml`, a
  development-only transitive dependency) is patched, and the dependency audit in CI now blocks on
  high-severity advisories (#423, #425). The crypto-adjacent packages (`argon2`, `bcrypt`,
  `@fastify/jwt`, `fast-jwt`, `otpauth`) are exact-pinned, excluded from Dependabot's grouped
  updates, and need code-owner review (#430, #434).
- Every third-party GitHub Action in every workflow is pinned to a full commit SHA with its
  version in a comment, and a CI guard (`scripts/check-action-pins.test.ts`) fails any tag-pinned
  one; first-party `actions/*` stay on major tags. The Trivy scanner binary is pinned too.
  (Story 64-2, #462)
- Container image scans now cover all three images (`api`, `migrate`, `web`) in pull requests
  and nightly runs, and a release scans each pushed image on `linux/amd64` and `linux/arm64`
  before moving `latest` and the semver aliases; a finding leaves the aliases on the previous
  release. The migrate image went from 53 scanner findings to 0. (Story 64-3, #465)

## [1.2.0] - 2026-09-10

Container images: `ghcr.io/nestormata/project-vault/{api,migrate,web}:1.2.0`
(aliases `1.2`, `1`, `latest`). Extension API contract: `@project-vault/extension-api@3.15.0`.

### Upgrade notes (read before `docker compose pull`)

- **Migrations 0089-0093 run automatically** via the `migrate` service. Migration 0091 backfills
  `chain_seq` and `previous_entry_hmac` on every existing `audit_log_entries` and
  `platform_audit_events` row — on large audit tables, plan a maintenance window and take a
  backup first. All five migrations are additive; none is refused by the migration guard.
- **Production now refuses to start on the repository's committed development secret values.**
  If any of the twelve HMAC and session secrets (`SESSION_SECRET`,
  `REFRESH_TOKEN_HMAC_SECRET`, `TOTP_REPLAY_HMAC_SECRET`, `MFA_PENDING_SESSION_HMAC_SECRET`,
  `INVITATION_TOKEN_HMAC_SECRET`, `RECOVERY_TOKEN_HMAC_SECRET`, `API_KEY_HMAC_SECRET`,
  `MACHINE_JWT_SECRET`, `STATUS_PAGE_TOKEN_HMAC_SECRET`, `ERASURE_EMAIL_HASH_SECRET`,
  `SSO_STATE_HMAC_SECRET`, `OPERATIONAL_STATUS_TOKEN_HMAC_SECRET`) was ever left unset, generate
  fresh values for all twelve (`openssl rand -hex 32`) and treat existing sessions and tokens as
  forgeable. `docker-compose.prod.yml` now hard-requires all twelve and must be the last `-f`
  argument. See the production-hardening section of
  [docs/operator-quickstart.md](docs/operator-quickstart.md).
- **`POST /api/v1/auth/register` (self-signup) now always returns `202`** with a generic body,
  where it previously returned `201` with `userId`/`orgId`, or `409 email_taken`. Clients should
  follow the call with login and `GET /api/v1/auth/me`. Invitation-based registration is
  unchanged.
- **Service member provisioning now requires a CentralizeMe-linked organization.**
  `POST /api/v1/service/organizations/:organizationId/members` returns
  `403 organization_not_centralizeme_managed` otherwise; run the `centralizeme_organization_id`
  backfill for pre-existing organizations first.
- **Per-account login lockout is on by default** (10 failures in 900 seconds). Tune it with
  `LOGIN_LOCKOUT_THRESHOLD` and `LOGIN_LOCKOUT_WINDOW_SECONDS`.
- New optional environment variable `SERVICE_REVOCATION_TOKEN`; the route it guards is
  fail-closed while it is unset. No new required environment variables.

### Added

- Machine-authenticated organization-wide handoff-session revocation
  (`POST /api/v1/service/organizations/:centralizemeOrganizationId/revoke-sessions`), with a
  rotation and compromise runbook. (#384)
- Machine-authenticated per-member organization provisioning and CentralizeMe organization
  linking, plus a backfill for pre-existing organizations. (#389, #390)
- Generic notification delivery-provider capability and a delivery-status webhook
  (`POST /api/v1/notifications/delivery-webhook/:provider`); notifications now track `sent`,
  `bounced`, and `delivered` provider events. (#391)
- Per-account login lockout, independent from the failed-authentication operator alert. (#401)
- Offline password-strength checking (zxcvbn, score 3 or higher) for registration and password
  reset. (#399)
- Extension API 3.12.0 through 3.15.0: `HostServices.monitoring`,
  `HostServices.notificationOriginator`, `HostServices.projectAuthorization.checkProjectMembership`,
  and the `projectArchiveNotifier` hook backed by a new `extension_lifecycle_events` outbox.
  (#395-#398)

### Changed

- Audit-log integrity is now chain-linked: every row stores the previous row's HMAC, and
  verification reports `chain_break` when an interior row has been deleted. (#392)
- `.env.example` documents the role of `CORS_ALLOWED_ORIGINS` for the web handoff prepare-proxy,
  and the two service tokens. (#387)

### Fixed

- A wrong TOTP code during multi-factor login returned `500` instead of `422 invalid_totp`. (#402)
- The backup `pg_dump`/`pg_restore` process wrapper could leave an unhandled stream error. (#385)
- Monitoring host services now guard against out-of-request calls with malformed parameters. (#395)

### Security

- Registration no longer reveals whether an email address is already registered. (#394)
- Production boot rejects known development-only secret literals, and the production Compose
  overlay hard-requires every secret. (#388)
- Member provisioning is limited to CentralizeMe-managed organizations. (#389)
- The `fast-uri` transitive dependency is patched (CVE-2026-75899, CVE-2026-75931,
  CVE-2026-75975, CVE-2026-76172).

[Unreleased]: https://github.com/nestormata/project-vault/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/nestormata/project-vault/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/nestormata/project-vault/compare/v1.1.0...v1.2.0
