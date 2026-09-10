# Changelog

All notable changes to Project Vault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The `@project-vault/extension-api` package has its
own changelog at [packages/extension-api/CHANGELOG.md](packages/extension-api/CHANGELOG.md); the
GitHub Action in [packages/vault-action](packages/vault-action/README.md) is released on its own
`vault-action-v*` tags. How a release is cut is documented in [docs/releasing.md](docs/releasing.md).

## [Unreleased]

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

[Unreleased]: https://github.com/nestormata/project-vault/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/nestormata/project-vault/compare/v1.1.0...v1.2.0
