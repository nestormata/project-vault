# Changelog

All notable changes to Project Vault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The `@project-vault/extension-api` package has its
own changelog at [packages/extension-api/CHANGELOG.md](packages/extension-api/CHANGELOG.md); the
GitHub Action in [packages/vault-action](packages/vault-action/README.md) is released on its own
`vault-action-v*` tags. How a release is cut is documented in [docs/releasing.md](docs/releasing.md).

## [Unreleased]

### Added

- **`@project-vault/web-host`:** every release now also publishes PV's web application source to
  npm (dist-tag `next`, OIDC provenance) for build-time composition, with path-independent
  `svelte`/`vite`/`vitest` config factories, the vendored `@project-vault/shared` source and a
  compatibility manifest. See [docs/web-host-package.md](docs/web-host-package.md). The
  `apps/web` workspace package is renamed from `@project-vault/web` to `@project-vault/web-host`, so
  `pnpm --filter` commands use the new name.

### Changed

- **Contributors:** every workspace `package.json` now declares the TypeScript and `tsx` versions
  the lockfile actually installs (`typescript ^6.0.3`, `tsx 4.21.1`). The `typescript` pnpm override
  is gone, because it made the declared `^7.0.2` false. A TypeScript 7 upgrade is separate work. A
  new CI check fails when a pnpm override no longer matches a declared range.
- **Contributors:** Paraglide's message-format plugin (4.4.4, MIT) is vendored in
  `apps/web/inlang-plugins/` and pinned by hash. It is no longer fetched from a CDN at `@latest`, so
  message compilation works offline and is reproducible.
- **Operators:** the api's `startup.failed` log line now carries `cause: {code, reason, depth}`
  when a database or TLS error code is found in the error chain (for example `28P01` /
  `auth_failed`, `SELF_SIGNED_CERT_IN_CHAIN` / `tls_failed`). Only the code and a closed reason
  are logged, never driver message text.
- **Operators (Fly demo):** `scripts/fly-migrate.sh` now requires `VAULT_APP_PASSWORD` and re-syncs
  the `vault_app` role password after every migration, as it already did for `vault_admin`.

### Fixed

- **Fly demo:** the Bootstrap workflow migrates the database before it deploys the api, and
  `fly-setup.sh` stages the api and web secrets instead of restarting the running api against the
  new TLS-only database. Bootstrap, deploy and reset now start any api machine Fly stopped after
  repeated crashes (`scripts/fly-ensure-started.sh`), and a deploy no longer reports success
  over an api that is down.
- **Fly demo:** the scheduled reset uses the pnpm version of the release it resets to, instead of
  `main`'s, and can no longer run in the middle of a deploy.
- `pvault`: the version check now returns its result before it tears the request down, so a slow
  teardown can no longer delay the command.

## [1.3.0] - 2026-10-01

Container images: `ghcr.io/nestormata/project-vault/{api,migrate,web}:1.3.0`
(aliases `1.3`, `1`, `latest`). Extension API contract: `@project-vault/extension-api@3.25.0`;
this host loads extensions whose manifest `apiVersion` is in `>=3.0.0 <=3.25.0`
(`HOST_SUPPORTED_EXTENSION_API_RANGE`). CLI: `pvault-1.3.0.mjs` on this release's assets.

### Upgrade notes (read before `docker compose pull`)

- **Migrations 0094-0101 run automatically** via the `migrate` service. All eight are additive
  (three new tables, nullable or defaulted new columns, new indexes), and the migration guard
  refuses none of them. None backfills existing rows. Migration 0098 builds a partial index on
  `notification_queue`, which briefly blocks writes to that table in proportion to its size.
  Migration 0101 adds two nullable columns to `notification_queue` (`claim_expires_at`,
  `send_started_at`) with no default and no index. Images on `latest`, `1` or `1.3` pick these
  migrations up on the next pull.
- **`CORS_ALLOWED_ORIGINS` entries equal to `null` now stop the api from booting** (and web ignores
  them). This is the only 1.3.0 change that can stop an existing self-hosted config from booting.
  Browsers send `Origin: null` from sandboxed iframes and `file://` pages, so such an entry would
  have let any page that sandboxes itself make credentialed requests. Remove the entry. The same
  rule applies to the new Compose-only `CORS_EXTRA_ORIGINS` (see Added). (Story 60-7, #478)
- **No new required environment variables.** Four new optional API variables tune the
  scheduled-task extension hook: `MIN_SCHEDULED_TASK_INTERVAL_MINUTES` (default `1`),
  `MAX_SCHEDULED_TASKS_PER_EXTENSION` (default `32`), `SCHEDULED_TASK_MAX_CONCURRENCY`
  (default `20`) and `SCHEDULED_TASK_MISSED_TICK_THRESHOLD` (default `3`, range `2`-`100`; see
  the missed-tick alert under Added). `docker-compose.yml` does not forward them; to change one under Compose, add it
  to the `api` service's `environment`.
- **Internal TLS variables (optional, off by default):** the api reads `API_TLS_CERT_B64`,
  `API_TLS_KEY_B64`, `API_TLS_CLIENT_CA_B64`, `DATABASE_TLS_CA_B64`, `DATABASE_TLS_CLIENT_CERT_B64`
  and `DATABASE_TLS_CLIENT_KEY_B64`, and the web reads `API_TLS_CA_B64`, `API_TLS_CLIENT_CERT_B64`
  and `API_TLS_CLIENT_KEY_B64` (single-line base64 of PEM; empty means unset). Docker Compose does
  not set them and nothing changes when they are unset. A value that does not decode, a cert
  without its key, or a key that does not match its cert stops the api from booting; on the web,
  any of them set requires an `https://` `API_BASE_URL`, and a bad value fails the first
  server-side api call with an error naming the variable. See Added and
  [`docs/runbooks/fly-internal-tls.md`](docs/runbooks/fly-internal-tls.md). (Story 43-16, #477)
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
- **Fly.io demo internal TLS:** 1.3.0 is the first release whose Fly demo runs TLS 1.3 with client
  certificates on every internal hop (see Security). Its new `db` image refuses to start without
  the `DB_TLS_*` certificate secrets, which only `scripts/fly-setup.sh` from a 1.3.0 checkout
  issues. Before the first 1.3.0 deploy, set the CA secrets `FLY_DEMO_INTERNAL_CA_CERT_B64` and
  `FLY_DEMO_INTERNAL_CA_KEY_B64`, then run the Fly Demo Bootstrap workflow with
  `release_tag=v1.3.0` (it issues the certificates, switches the database URLs to
  `sslmode=verify-full` and the web's `API_BASE_URL` to `https://`, redeploys and resets the demo
  data). Docker Compose deployments are unaffected. See
  [`docs/runbooks/fly-internal-tls.md`](docs/runbooks/fly-internal-tls.md). (Story 43-16, #477)
- **Log shippers:** the API's `startup.failed` line is now written to stderr, not stdout, in every
  environment (see Changed). Read stderr too if you alert on it. (Story 66-4, #495)
- **Delivery-provider extensions:** a notification whose `send()` resolved, or whose outcome is
  unknown (the process stopped mid-send), is now marked `failed` instead of being sent again;
  `send()` is retried only after it rejected. Providers whose `send()` can reject after the
  message was accepted should deduplicate on `queueRowId` (see Changed). (Story 70-1, #489)
- **Building from source** needs pnpm 11.28.3 or newer (was 11.21.0). (#484)
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
- Extension API 3.16.0 through 3.25.0 (see
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
  - `DeliveryProviderSendPayload.attemptNumber` (3.25.0), the 1-based attempt number for logs and
    metrics, and `queueRowId` documented as the provider idempotency key: the same on every retry
    of one notification and never reused. (Story 70-1, #489)
- New Compose-only `CORS_EXTRA_ORIGINS`: a comma-separated list of extra trusted origins (e.g.
  CentralizeMe's real origin) appended to PV's own origin for both the api and web services. Under
  Docker Compose, `CORS_ALLOWED_ORIGINS` in `.env` is still ignored; use this variable instead.
  (Story 60-7, #478)
- Opt-in TLS 1.3 for the api listener (mutual TLS when `API_TLS_CLIENT_CA_B64` is set), a pinned
  private CA plus a client certificate on every api Postgres connection (pools, pg-boss,
  migrations), and the same for the web's server-side calls to the api, configured by the
  variables in Upgrade notes. When it is on, the api logs one `internal_tls.configured` line at
  startup, `/ready` adds the generic warning `internal_tls_cert_expiring` when a certificate is
  under 30 days from expiry, and the loopback `/metrics` exposes
  `pv_internal_tls_cert_expiry_seconds`. The Fly.io demo uses it; Docker Compose does not.
  (Story 43-16, #477)

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
- Notification delivery claims each `notification_queue` row exclusively with a lease, so two
  workers can no longer send the same notification twice. One `notification/deliver-catchup` job
  replaces the overlapping per-channel email, Slack and inbox catch-ups, whose old schedules are
  removed at startup. A row whose send started but whose outcome was never recorded is marked
  `failed` (logged as `notification.delivery_outcome_unknown`) instead of being sent again, and
  every notification email carries a stable `Message-ID` (`<pv-nq-<queueRowId>@<domain>>`).
  (Story 70-1, #489)
- Notifications enqueued through `HostServices.notificationOriginator` are dispatched right after
  the enqueue commits, so the first send happens in seconds instead of waiting 5 to 15 minutes for
  the periodic catch-up. If the immediate dispatch is unavailable, the catch-up still delivers the
  row. (Story 70-2, #493)
- The handoff consent page (`/handoff`) shows a "Sign-in couldn't be completed" heading on every
  error state, a "Not me" link to the login page beside "Confirm sign-in", and a "Return to
  CentralizeMe" link only when the web process has `VAULT_HANDOFF_ISSUER` set (its origin only;
  otherwise plain-text guidance). A CentralizeMe-provisioned account's internal placeholder email
  is shown as "your account". Docker Compose now passes `VAULT_HANDOFF_ISSUER` to both services
  (web: empty by default). (Story 60-4, #469)
- The example env file no longer sets `VAULT_HANDOFF_ISSUER`, so new configs do not show the
  "Return to CentralizeMe" link. Configs copied from an older example that still set it show the
  link. An empty `VAULT_HANDOFF_ISSUER` now means the default issuer
  (`https://app.centralizeme.com`) instead of an api boot failure. (Story 60-7, #478)
- An API startup failure (`startup.failed`) is now written to **stderr** instead of stdout, in
  every environment. Log shippers that read only stdout for this event must also read stderr.
  An `ADMIN_DATABASE_URL` that cannot be reached now names the reason (`auth_failed`,
  `database_missing`, `permission_denied`, `connection_failed`, `role_row_missing` or `unknown`),
  and `pnpm check-admin-pool` prints it too. (Story 66-4, #495)
- Licensing: `@project-vault/extension-api` is MIT-licensed from 3.24.2 (earlier published
  versions stay AGPL-3.0-or-later), and `@project-vault/agent` and the vault GitHub Action are
  MIT-licensed. Project Vault itself (API, web) stays AGPL-3.0-or-later. The Contributor License
  Agreement that external pull requests sign is now version 2 ([CLA.md](CLA.md)). (#482)
- The web app is built with Vite 8 (an override had kept it on Vite 6). (#484)

### Deprecated

- The runtime HTML panel extension API (`onRenderPanel`/`UIPanelResult`, `uiPanelSlots`,
  `moduleActions` and `data-pv-action`, `panelDataPaths`, the `/extensions/panels` route and its
  DOMPurify sanitizer) is deprecated and frozen: no new features or fixes, kept until it is
  replaced or removed, and security issues are resolved by replacing or removing the affected
  part rather than patching it. A build-time UI composition tier is the planned replacement.
  (#485)
- The `navItems` and `moduleDataRoutes` manifest fields are deprecated and frozen on the same
  terms; their planned replacements are build-time UI composition navigation and first-party API
  route composition. No code or contract changes; removal follows the
  [extension API versioning policy](docs/extension-api-versioning-policy.md). (#486)

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
- The handoff claim exchange now burns the claim and re-keys the confirmation cookie in one
  database transaction. Before, a failure between the two used up the link, so retrying the same
  `/handoff` link could never succeed; now a failed exchange leaves the claim usable. A database
  outage during the claim lookup returns the generic rejection instead of an error. (Story 60-5,
  #472)
- Notifications: mark as read, mark all as read and dismiss update the list again. They threw
  `callback is not a function` in the browser, so nothing changed until a reload. (Story 68-1,
  #490)
- Moving from one credential's page to another's (without a full reload) no longer keeps the
  first credential's dependencies, shares, nudges, lifecycle values, revealed secret value or
  one-time share token on screen, and a reveal or share started on one credential can no longer
  land on the next. The status-page settings, platform settings and theme pages likewise follow
  the project or data they are showing, and a just-issued status-page token is only shown for the
  project it belongs to. (Story 68-1, #490)
- The API now always reports why it refused to start: one redacted `startup.failed` JSON line on
  stderr, whatever `NODE_ENV` and `LOG_LEVEL` say. Before, `LOG_LEVEL=silent` or `fatal` in any
  environment, and every `NODE_ENV=test` process, exited 1 with no output. (Story 66-4, #495)

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
- `pvault` strips Unicode bidi controls, zero-width characters and other invisible format
  characters (as well as control characters) from every string it prints, so a hostile server,
  credential name or command cannot visually reorder or hide what you read. Error text that comes
  from the server or a library is printed on one line and capped at 500 characters. The API drops
  an `x-vault-target-command` audit value that contains such characters (the reveal itself still
  succeeds and is still audited), and the agent strips them before sending it. (Story 43-13, #473)
- On the Fly.io demo, every internal hop now uses TLS 1.3 with a pinned private CA and client
  certificates: web to api (before: plain HTTP on Fly's private network, carrying cookies,
  passwords and secrets), api to Postgres, and the CI operator path for migrations and resets.
  Another app in the same Fly organization can no longer talk to the api or the database. (Story
  43-16, #477)
- Forms that hold a secret (vault passphrase, bootstrap token, credential value and the other
  password fields) submit with `POST` and their secret inputs carry no `name`, so a submit made
  before the page's JavaScript loaded can no longer put the secret in the URL, browser history or
  proxy logs. (Story 66-3, #479)
- The `fast-uri` transitive dependency (used by the API's request validation) is patched for the
  high-severity advisories `GHSA-58mr-gqgx-xq4g` and `GHSA-qw65-cvwx-89v3`. (#475)
- The `devalue` transitive dependency (used by the web app's SvelteKit to serialize page data) is
  updated to 5.9.4 for the high-severity advisories `GHSA-j22f-vq7h-c4qm`,
  `GHSA-mcm9-63f2-9j32` and `GHSA-x5rw-q4pp-hg5g`. (#499)
- The `migrate` image's pnpm is updated to 11.28.3, whose bundled `undici` fixes CVE-2026-19534
  (HIGH, denial of service). (#484)
- `SECURITY.md` now publishes a private email address for security reports, as a fallback to
  GitHub's private vulnerability reporting. (#483)

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
