# Changelog

All notable changes to Project Vault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The `@project-vault/extension-api` package has its
own changelog at [packages/extension-api/CHANGELOG.md](packages/extension-api/CHANGELOG.md); the
GitHub Action in [packages/vault-action](packages/vault-action/README.md) is released on its own
`vault-action-v*` tags. How a release is cut is documented in [docs/releasing.md](docs/releasing.md).

## [Unreleased]

### Added

- **Delegation observability and key runbook.** `pv_delegation_assertions_total` now counts `accepted`
  (admitted by the delegation stages) and every `outcome` x `kid` series exists at 0 from boot, so
  Prometheus `increase()` sees the first incident. Shipped alert rules for Prometheus:
  [`docs/runbooks/alerts/delegation-alerts.rules.yml`](docs/runbooks/alerts/delegation-alerts.rules.yml),
  and a new runbook, [`docs/runbooks/delegation-key-rotation.md`](docs/runbooks/delegation-key-rotation.md)
  (routine rotation, emergency revoke with its limits, compromise triage, alert triage). A
  `delegation_assertion_rejected` security event now carries the request id and, for
  `store_unavailable`, a closed `storeFailure` (`sqlstate:<code>`, `driver_error`, `timeout`).
- **Injection points on the remaining top-level component uses** (Story 69.6, Epic 69, web-host). Every top-level
  component use of a PV route file is now its own region with a registered point: 21 new region points
  (`app.layout.search`, `project.layout.content`, `root.layout.progress`, `auth.layout.brand`, `auth.register.form`,
  `vault.home.gate`, `platform.home.{operator-notice,warnings,nav-cards}`, `settings.home.nav-cards`,
  `settings.security.enrollment`, the five `*.back` links, `project.{certificates,domains,services}.list-header`,
  `project.status-page.error`, `project.service-endpoints-detail.back`), hosted by thin wrapper components, so PV's own
  output is unchanged. Rule R3 of the shipped `monolithic-region` guard (a top-level component use outside a region
  is a finding) and the measurable coverage figure of `check-injection-point-coverage` make "an injection point in
  every region" checkable; both ship in `@project-vault/web-host`. A pack that overrides one of the changed route
  files sees its `hostSha256` drift (reconcile with `pv-compose --accept-host`). Published guard and manifest
  behavior change: the next web-host release is a MINOR bump. See `docs/composition-kit.md`.

### Changed

- **Delegated routes get a default per-IP limiter** (600 requests per minute per client IP, spent in
  `onRequest` before any signature check; over the limit: 429 with `Retry-After`, counted as
  `rate_limited_pre`). A signature-valid rejection is written as a security event only while its key is
  inside the per-`kid` limiter budget, and the event write has a 2 s deadline. No new environment
  variable and no migration.

### Fixed

- A delegated request answered 409 `delegation_replayed` or 503 `delegation_replay_store_unavailable` no
  longer continues into actor resolution after the response was sent (it counted a stray
  `actor_unlinked`).
- `store_unavailable` no longer reports a Node socket errno such as `EPIPE` as a Postgres SQLSTATE.

## [1.5.0] - 2026-10-05

Container images: `ghcr.io/nestormata/project-vault/{api,migrate,web}:1.5.0`
(aliases `1.5`, `1`, `latest`). Extension API contract: the source is at
`@project-vault/extension-api@3.32.0`, and this host loads extensions whose manifest `apiVersion`
is in `>=3.0.0 <=3.32.0` (`HOST_SUPPORTED_EXTENSION_API_RANGE`). The package is published separately
from the `extension-api-v3.32.0` tag. CLI: `pvault-1.5.0.mjs` on this release's assets.
Build-time composition packages publish from this tag to npm's `next` dist-tag:
`@project-vault/web-host@1.5.0` and `@project-vault/composition-kit@0.9.0`.

### Upgrade notes (read before `docker compose pull`)

- **Migration 0103 runs automatically** via the `migrate` service. It is additive and instant: one
  new table, `delegation_assertion_jti` (row-level security forced, owned by `vault_owner`),
  with no change to any existing table and no backfill. `vault_app` can only `SELECT` and `INSERT`
  on it; `vault_admin` gets `SELECT` on `org_id`, `jti` and `expires_at` plus `DELETE`, for the
  prune job only. No new environment variables.
- **Service-delegated routes require optional key configuration.** Existing deployments are
  unchanged; set `VAULT_DELEGATION_VERIFY_KEYS` only when an extension declares delegated routes.
  The key set also requires `VAULT_HANDOFF_INSTANCE_ID` and must be disjoint from
  `VAULT_HANDOFF_VERIFY_KEYS`. See [configuration](docs/configuration.md).

### Added

- **Injection points on the credential detail page** (Story 69.2, Epic 69, web-host). The page is now 13
  replaceable region components (`credential.detail.{vault-sealed,not-found,summary,actions,nudges,metadata,
lifecycle,value,versions,dependencies,rotation,shares,footer}`, under
  `$lib/components/credentials/detail/`), each with its own injection point, and every point of the page
  receives one props contract: `{ routeId, params, credential, project, projectId, credentialId, orgRole,
projectRole }` (additive). Credential and project context therefore reaches a composed product through
  point props, never through a panel. A contribution `load` or form `action` at a credential region opts in
  with `hostRoutes` (Story 69.1). When PV's own load answers `vaultSealed: true` (as it already did for
  `notFound: true`), no contribution `load` runs and every contribution gets a `null` entry, so a
  contribution that calls the API cannot turn PV's sealed banner into an error page. PV's rendered markup is
  unchanged. Editing the credential page changes the hash of that overridable file: a pack that overrides it
  re-accepts the new host with `pv-compose --accept-host`.
- **The runtime route audit is runnable from the API image** (Story 68.23, Epic 68). A consumer proves its
  composed API's routes with Project Vault's own audit and without cloning Project Vault:
  `docker run --rm -v <dir>:/audit:ro <api-image> node dist/scripts/runtime-route-audit.js --extension <pkg>
--classifications /audit/classifications.json` (exit `0` pass, `1` audit failure or extension did not load,
  `2` usage or input error; no database, network or secret needed). The compiled entry is a supported,
  versioned interface of the `api` image. The `Mock UI pack mechanism e2e` job now runs this shipped form
  against the mock UI pack, with classifications extracted by `pv-verify --only classifications`.
  See [docs/composition-kit.md](docs/composition-kit.md#runtime-route-audit-from-the-api-image-no-pv-checkout).
- **Delegation assertion replay store** (Story 71.7, Epic 71). The burn ledger that makes a
  service-delegated actor assertion single-use: each assertion's `jti` is recorded once per org in
  `delegation_assertion_jti` (primary key `(org_id, jti)`, insert-first, fail closed when the store
  is unreachable). Rows live about 90 seconds after the assertion expires plus a 5-minute prune
  grace; the new `delegation/prune-assertion-jti` job deletes expired rows every minute in one
  bounded batch.
- **Delegated actor assertions are verified on M7 routes** (Story 71.3, Epic 71). An extension route that
  declares `security.delegation` is now authenticated by a signed `Authorization: PV-Delegation <jws>`
  assertion instead of a session, before its handler runs: signature and claims (separate key set
  `VAULT_DELEGATION_VERIFY_KEYS`), the signed operation must equal the route, the exact raw body must hash
  to the signed `bsh`, the org is resolved from `organizations.centralizeme_organization_id`, the `jti`
  is burned once per org, and the actor is resolved through `external_identities` and the org membership
  (an unlinked actor is admitted as `issuer_attested`, with no PV role). Failures answer a stable set of
  `delegation_*` codes; signature-valid rejections are recorded as `platform_security_events` rows and
  counted in `pv_delegation_assertions_total{outcome,kid}`. A delegated route must set
  `writeAuditEvent: false` and cannot combine `delegation` with `requireMfa`, `requirePlatformOperator`
  or `requireAuth: false` (the API refuses to boot). With no delegated route declared, and no
  `VAULT_DELEGATION_VERIFY_KEYS`, nothing changes. See
  [docs/extensions/authoring.md](docs/extensions/authoring.md#delegated-routes-securitydelegation).
- **Neutral request types** (extension-api 3.30.0): `ExtensionRequestContext` and
  `ExtensionActionResult`, for `oauthHandoff` and `publicRoute` code that should not depend on the
  panel vocabulary. `ModuleActionContext` and `ActionResult` remain as deprecated names.
- **Notification provider controls** (extension-api 3.32.0): providers can send an HTML message
  part, classify permanent send failures so PV does not retry them, and set a per-provider rate
  limit for delivery-status webhooks.
- **Injection-load denial signaling** (Story 69.7): when a PV page load denies access with
  `allowed: false`, injected loads are skipped, so an extension cannot make a denied page call its
  API. The marker is removed from the page data returned to the browser.

### Deprecated

- **Legacy UI-panel API, `navItems` and `moduleDataRoutes`** (Story 68.11, Phase A;
  `@project-vault/extension-api` 3.30.0, released on its own tag). Nothing is removed and nothing
  changes at runtime. The panel types and hooks (`uiPanel`, `moduleAction`, `UIPanel*`,
  `ModuleAction*`, `ActionResult`, `ModuleData*`), the manifest fields `uiPanelSlots`,
  `moduleActions`, `navItems` and `moduleDataRoutes`, and the `'ui-panel'` capability are marked
  `@deprecated`. Removal is a later major (4.0.0 at time of writing), no earlier than 2027-01-14
  (projected; the 90-day window starts when 3.30.0 is published) and only after CentralizeMe stops
  using them. Replacements: composed UI (ADR 0007) for panels, the M5 nav delta for `navItems`, M7
  `apiRoutes` for `moduleDataRoutes`.

### Fixed

- The composed-tree no-op test for injection behavior now uses explicit empty injection tables,
  avoiding interference from process-wide production registrations (Story 68.28, PR #566).

## [1.4.0] - 2026-10-03

Container images: `ghcr.io/nestormata/project-vault/{api,migrate,web}:1.4.0`
(aliases `1.4`, `1`, `latest`). Extension API contract: the source is at
`@project-vault/extension-api@3.29.0`, and this host loads extensions whose manifest `apiVersion`
is in `>=3.0.0 <=3.29.0` (`HOST_SUPPORTED_EXTENSION_API_RANGE`). **The npm package is released on its
own tags and is not part of this release:** `3.29.0` was published to `next` from its own tag
`extension-api-v3.29.0` (commit `49c27b34`) shortly before this release, and `latest` is still
`3.25.0`. `3.28.0` was never published; `3.29.0` includes it. CLI: `pvault-1.4.0.mjs` on this
release's assets.
Build-time composition packages published from this tag to the npm `next` dist-tag:
`@project-vault/web-host@1.4.0` and `@project-vault/composition-kit@0.7.0`.

### Upgrade notes (read before `docker compose pull`)

- **Migration 0102 runs automatically** via the `migrate` service. It is additive: one new table,
  `extension_audit_idempotency_keys` (row-level security forced, `vault_app` limited to `SELECT` and
  `INSERT`), with no change to `audit_log_entries` and no backfill. Images on `latest`, `1` or `1.4`
  pick it up on the next pull.
- **No new required environment variables.** One new optional API variable,
  `VAULT_EXTENSIONS_REQUIRED` (default `false`), stops the boot when the configured extension fails
  to load or `VAULT_EXTENSIONS_PACKAGE` is unset. Leave it unset unless you run a composed deployment. `docker-compose.yml` forwards it.
- **Per-user rate-limit buckets are keyed per route and reset on deploy.** The default bucket key is
  now the prefixed route key. Before, `GET /api/v1/dashboard` and `GET /api/v1/projects` shared one
  bucket and so did `GET /api/v1/auth/me` and `GET /api/v1/users/me`; they no longer do. Buckets are
  in memory, so the first minutes after the upgrade start from empty counters.
- **Extensions load before the core routes.** A configured extension that declares an override for a
  route PV does not have, or a route that collides with an existing one, now stops the boot.
  Without `apiRoutes` in the manifest nothing changes for an extension.
- **The admin extension status response gained fields** (`apiRoutes`, and `app` for app-level
  behavior). Clients that compare the exact key set of that response must allow the new keys.
- **Composed deployments:** the hashes of many `apps/web` files change in this release (navigation,
  hooks, injection points, the `AppShell` header split). Reconcile any override or replacement of
  one with `pv-compose --accept-host`, and expect `composition.lock.json` to move to version 2.
  Pack authors: a `routeClassifications` entry now has the runtime route audit's shape
  (`{ route: "METHOD /url", reason }`), and the old `{ method, url, class }` fields are rejected with
  a migration hint. This is a breaking change in kit 0.7.0, which is the first version of the kit
  published to npm, so no published version breaks.

### Added

- **App-level `apiRoutes` behavior and the runtime route audit (Story 68-14,
  `@project-vault/extension-api` 3.29.0):** an extension can add global hooks (before and after
  every route), and wrap or replace PV's error handler and not-found handler, with a fallback to
  PV's own handler when the extension's throws. `AppOptions.extension` and
  `AppOptions.routeObserver` back a new `route-audit:runtime` CLI that fails on a route no
  classification covers and on a stale classification entry. The `generate-spec` script takes
  `--extension` and `--out` options and writes a composed OpenAPI spec (it refuses PV's own spec
  path). The status endpoint gains an `app` object and the events `extension.api_route.app_override` and
  `extension.api_route.app_handler_failed`.
- **API route composition, M7 (Story 68-8, `@project-vault/extension-api` 3.27.0):** an extension
  manifest can declare `apiRoutes` to add routes, or override PV routes with `replace` or `wrap`
  (inside the request transaction, with `next()`). A capability id PV does not know is passed to
  the extension's `capabilityGate` for `apiRoutes` entries only, and is denied when no gate is
  registered; PV's own routes keep the strict check. The `security` object is validated, so a typo
  no longer drops a restriction silently.
- **Idempotent `writeAuditEvent` (Story 71-1, `@project-vault/extension-api` 3.28.0):** an optional
  `idempotencyKey` (`^[A-Za-z0-9._:-]{1,128}$`) makes a replayed extension audit write return the
  original `{id, createdAt}` instead of writing a second row. The same key with different content
  is a typed conflict, replays skip the rate and storage gates and count under a new `deduped`
  counter, and keyed payloads over 1 MiB are rejected. Omitting the key keeps the old behavior.
  Dedupe state lives in the new table from migration 0102 and is removed with its audit row.
- **Resolved-path module replacement, M4 (Story 68-5):** composition-kit's `pvReplace` Vite plugin
  shadows any `$lib` module by its resolved path in the client, SSR and vitest, and the
  `pv-original:` specifier lets a replacement wrap the original. `web-host` ships
  `component-index.json`. PV's `AppShell` header is split into `ShellBrand`, `NotificationsLink` and
  `ShellAccount` with byte-identical output.
- **`pv-verify` (Story 68-9, kit 0.5.0):** runs PV's web guards and self-contained tests over a
  composed tree, merges a pack's own guard entries (`defineGuardEntries`, the lock's
  `guardEntries` record) and fails closed when the lock's `excludedPvTests` disagrees with its
  overrides. `web-host` ships `guards.json` and `test-subjects.json`.
- **Pack route classifications for the runtime route audit (Story 68-16, kit 0.7.0):**
  `pv-verify --only classifications --out <file>` writes the merged `routeClassifications` of a
  composed pack as a sorted JSON array (written atomically, and only after the preflight and the lock
  tamper check pass), in the entry shape that the `route-audit:runtime` CLI parses. A stale
  classification entry fails the audit, so keep one file per variant.
- **Navigation as data with stable ids on every nav surface (Story 68-7, M5):** every PV nav surface
  (primary and mobile nav, project tabs, the shell's brand, bell, MFA-banner link, account menu and
  footer, the settings and platform indexes, sub-section link rows, the notifications tabs,
  breadcrumbs, page back links, the error page's way back and the auth cross-links) now renders from
  one registry of stable ids, and a composed app changes it with a nav delta (insert, remove, hide,
  relabel, move, replace, reorder, at any depth) through `pvNav()` and
  `@project-vault/composition-kit/nav` in kit 0.6.0. `web-host` ships the new `manifests/nav-ids.json`
  and a `composed-nav.test.ts` that validates a composed app's delta. Two new CI guards,
  `check-nav-ids` and `check-nav-surfaces`. PV's own rendered navigation is unchanged except that
  **the project tabs are now translated** (Spanish under `es`). The rewritten nav files' hashes drift
  with the next web-host release (`PrimaryNav.svelte`, `ProjectNav.svelte`, `AppShell.svelte`,
  `ShellBrand.svelte`, `NotificationsLink.svelte`, `ShellAccount.svelte`, `Footer.svelte`,
  `PlatformBreadcrumb.svelte`, `PlatformSettingsBreadcrumb.svelte`, `BackLink.svelte`,
  `AssetDetailFooter.svelte`, `nav-model.ts`, `project-nav-model.ts`, `+error.svelte`, the settings
  and platform index pages and every page whose back link, breadcrumb, link row or tab bar moved onto
  the data): reconcile a CM override or replacement of one with `pv-compose --accept-host`.
  `BackLink.svelte` now takes `{ node, projectId, credentialId? }` and `AssetDetailFooter.svelte`
  `{ backNode, projectId }` instead of an href and a label. Nav ids removed: none. See
  [docs/composition-kit.md](docs/composition-kit.md#navigation-delta-m5).
- **Composable hooks, header policy and protected paths (Story 68-6):** a UI pack can contribute to
  every SvelteKit hook (server, universal, client), change PV's security-header policy and get its
  `(app)` routes protected, through `pvHooks()` in `@project-vault/composition-kit` 0.4.0 and the new
  web-host `manifests/hooks-surface.json`. PV's own responses, redirects and cookies are unchanged,
  with two intended tightenings: a percent-encoded URL of a protected route (for example
  `/%73ettings/notifications`), or a URL rerouted onto one, is now redirected by the hook like the
  plain URL; and a header rule also matches the decoded pathname, so `/%68andoff` now carries the
  handoff headers (`referrer-policy: strict-origin`) like `/handoff`. `apps/web` gains `src/hooks.ts` and `src/hooks.client.ts` (no-op in PV's build), and
  `src/hooks.server.ts` changes, so its `hostSha256` drifts: any CM override of it must be
  re-accepted. See [docs/composition-kit.md](docs/composition-kit.md#hooks-header-policy-and-protected-paths).
- **Injection points with behavior injection (Story 68-4, M3):** every PV page, layout and error file now
  exposes `<prefix>.before`, `<prefix>.after` and `<prefix>.header.actions` injection points, the shell
  exposes `shell.head`, `shell.header.end` and `shell.body.end`, and PV's server files call
  `injectLoad`/`injectActions` so a composed pack can add server data and form actions. `web-host` ships
  `manifests/injection-points.json`; `@project-vault/composition-kit` 0.2.0 adds the `pvInject()` Vite plugin
  and the `injections` lock section. PV's own build is a no-op (the rendered markup, headers and data are
  unchanged). A new CI guard, `check-injection-point-coverage`, keeps every PV route file covered. About 70
  PV route files changed, so the hash of any file a pack overrides there drifts with the next `web-host`
  release: reconcile it with `pv-compose --accept-host`.
- **`@project-vault/composition-kit` (MIT):** the `pv-compose` composer that overlays a UI pack onto
  `@project-vault/web-host`, the `defineUiPack()` manifest, the committed `composition.lock.json`
  drift lock, the version-tuple compatibility check and a Vite dev plugin. It has its own semver and
  publishes (dist-tag `next`, OIDC provenance) from the same `vX.Y.Z` tag, before `web-host`. The
  web-host compatibility manifest now names the kit version (`kitVersion`). See
  [docs/composition-kit.md](docs/composition-kit.md). Nothing in PV's own web build, image or tests
  changes.
- **`@project-vault/web-host`:** every release now also publishes PV's web application source to
  npm (dist-tag `next`, OIDC provenance) for build-time composition, with path-independent
  `svelte`/`vite`/`vitest` config factories, the vendored `@project-vault/shared` source and a
  compatibility manifest. PV's self-contained web unit tests ship with the source, so a composer
  can run them over its composed tree. See [docs/web-host-package.md](docs/web-host-package.md). The
  `apps/web` workspace package is renamed from `@project-vault/web` to `@project-vault/web-host`, so
  `pnpm --filter` commands use the new name.

### Changed

- **Contributors:** every workspace `package.json` now declares the TypeScript and `tsx` versions
  the lockfile actually installs (`typescript ^6.0.3`, `tsx 4.21.1`). The `typescript` pnpm override
  is gone, because it made the declared `^7.0.2` false. A TypeScript 7 upgrade is separate work. A
  new CI check fails when a pnpm override no longer matches a declared range.
- **Contributors:** Paraglide's message-format plugin is no longer fetched from a CDN at `@latest`.
  It is an exact-pinned `apps/web` devDependency (`@inlang/plugin-message-format` 4.4.4, MIT), loaded
  from `node_modules` and hash-pinned in `apps/web/inlang-plugins/plugins.lock.json`, so message
  compilation works offline and is reproducible.
- **Operators:** the api's `startup.failed` log line now carries `cause: {code, reason, depth}`
  when a database or TLS error code is found in the error chain (for example `28P01` /
  `auth_failed`, `SELF_SIGNED_CERT_IN_CHAIN` / `tls_failed`). Only the code and a closed reason
  are logged, never driver message text.
- **Operators (Fly demo):** `scripts/fly-migrate.sh` now requires `VAULT_APP_PASSWORD` and re-syncs
  the `vault_app` role password after every migration, as it already did for `vault_admin`.
- **Operators:** the base-image guard now covers every Dockerfile the repository ships, and the Fly
  database image's PostgreSQL base is pinned by digest. A scheduled workflow opens a refresh pull
  request when the pinned `node` or `postgres` digest has an upstream update; this release carries
  one such PostgreSQL digest refresh.
- **Contributors:** the nightly workflow skips days with no new commits (with a force input), splits
  the flaky repeat run from the main run, uses budgets measured from a forced run for the sharded
  Stryker jobs, and posts its failure alert through the Slack action's v4 inputs. Isolated e2e
  stacks take their ports from the operating system and stop children that died or timed out.
  The deferred-work ledger guard also checks residual-risk sections and checked defers.

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
- **Fly demo:** `fly-ensure-started.sh` now runs from the workflow's own commit, so a deploy of an
  older release tag no longer fails because that tag predates the script.
- **Contributors:** the version-skew guard creates the local `main` ref it compares against when CI
  runs by dispatch, and the `pvault` README's from-a-release install block puts `~/.local/bin` on
  `PATH`.

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

[Unreleased]: https://github.com/nestormata/project-vault/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/nestormata/project-vault/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/nestormata/project-vault/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/nestormata/project-vault/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/nestormata/project-vault/compare/v1.1.0...v1.2.0
