# Project Vault

[![CI](https://github.com/nestormata/project-vault/actions/workflows/ci.yml/badge.svg)](https://github.com/nestormata/project-vault/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=nestormata_project-vault&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=nestormata_project-vault)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=nestormata_project-vault&metric=coverage)](https://sonarcloud.io/summary/new_code?id=nestormata_project-vault)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11.21.0-brightgreen)](package.json)

_Run complex projects. Miss nothing._

Project Vault is a self-hostable, open-core operations platform for engineering projects. Where every existing secrets manager organizes by environment (dev / staging / prod), Project Vault organizes by _project_: credentials, certificates, domains, services, and payment renewals grouped under the natural unit of engineering responsibility. It is a different data model, a different access-control model, and a different mental model — not a UI reorganization.

## Try it now

**[project-vault-demo-web.fly.dev](https://project-vault-demo-web.fly.dev)** — a real self-hosted deployment you can log into and explore right now. Same Docker images, same self-hosted Postgres, same code path as your own install.

- Register your own account.
- **The demo database resets every night.** Everything you create is wiped and reseeded on a nightly schedule. Treat it as a scratchpad.

## Why Project Vault

- **Project as the unit of truth** — credentials, services, certificates, and monitoring grouped under one project context, mirroring how engineers actually work.
- **Operational scope** — certificate expiry, domain and payment renewal dates, and uptime checks live alongside credentials, because they are all part of keeping a project running.
- **Rotation you can audit** — a staged rotation state machine with a per-system confirmation checklist, overlap windows, and break-glass recovery, so a rotation is a tracked operation instead of a memory.
- **Open-core and independently auditable** — the full security engine is open source; trust is earned through transparency, not claimed.
- **Self-hosted primary, SaaS optional** — data sovereignty is the default trust path.
- **Compliance by design** — chain-linked audit logs, role-based access control, and immutable versioning are structured to support SOC 2 Type II and ISO 27001 evidence collection.

## Features

| Feature | Details |
|---|---|
| Secrets management | Versioned, encrypted, project-scoped credentials; structured multi-field secrets with templates and per-field reveal and rotation; tags, dependent systems, expiry tracking; bulk import from `.env` or JSON; archive and delete; cross-project search |
| Credential sharing | Share with organization members or with external recipients via expiring single-use links; share history, revocation, expiry enforcement, rotation-recommended nudges, email delivery |
| Manual rotation with propagation | Staged rotation state machine with a per-system checklist, stale-rotation recovery, break-glass emergency mode, upcoming-rotation view; full web UI |
| Operational monitoring | HTTP uptime checks (pausable), TLS certificate expiry, domain renewal, service and payment renewal dates, per-project alerts with dismiss and snooze, cross-project health dashboard, public status pages |
| Multi-user access control | Project roles (Owner, Admin, Member, Viewer), invitations, organization user management (deactivate, pseudonymize, recovery link, session revoke), ownership transfer, project archival, `read:secret_value` vs `read:secret_metadata` |
| Authentication | Password plus TOTP multi-factor with recovery codes and a privileged-role grace period, per-account lockout, offline password-strength checks, enumeration-safe registration, session list and revoke with idle timeout, account recovery, self-hosted SSO by email domain, CentralizeMe browser-handoff SSO (`VAULT_HANDOFF_ENABLED`) |
| Notifications | Email, Slack, and in-app inbox; per-alert-type routing, digests, credential/certificate/domain/machine-key expiry alerts, organization security-alert feed (anomalous access, failed-auth bursts, key-custody risk, clock skew), extension delivery providers with a delivery-status webhook |
| Machine users and CI/CD | Scoped API keys with zero-downtime rotation, emergency revoke, and a dormancy policy; offline encrypted cache fallback; [GitHub Action](packages/vault-action/README.md) |
| Audit and compliance | Append-only audit log with chain-linked HMAC integrity (detects modified *and* deleted rows), search, export, external forwarding, retention, access reports, dormant-user detection, GDPR erasure, per-organization storage quotas and write-rate limits |
| Extensions | [`@project-vault/extension-api`](packages/extension-api/README.md) 3.x: auth providers, notification channels, delivery providers, UI panels with nav merge, module data routes and typed actions, capability-tier gating, audit-event sources, project-lifecycle hooks; host services for monitoring, notifications, authorization, and ephemeral state; fail-safe loading and a least-privilege extension database role |
| Localization and theming | English and Spanish UI with per-user and organization-default locale; custom theme packs (`VAULT_THEMES_DIR`) with organization default, per-user selection, pre-auth branding, and a contrast-validated token contract |
| Project export/import | Encrypted, portable project export (reveal-once key); import re-encrypts every secret under the destination vault's own master key |
| Vault unsealing | Master passphrase, split-key envelope (default), key file, or an external key management service |
| REST API | Versioned API behind every UI operation; generated OpenAPI spec, live Swagger UI (`ENABLE_API_DOCS`), independent contract-test suite; machine-to-machine service-provisioning API for hosted integrations |
| Self-hosted Docker | `docker compose` dev, production, and NFS overlays; multi-arch GHCR images; health, ready, status, and metrics endpoints |
| Backup | Scheduled encrypted snapshots to the filesystem or S3, retention, restore validation, admin UI, missed-backup alerts |
| Platform administration | First-user platform operator: system settings (SMTP, backup, policy), multi-organization provisioning, per-organization audit quotas, resource usage, token-protected `/status` endpoint, maintenance mode, version and migration-state information |
| Platform operator audit log | Instance-wide privileged-action log, separate from the per-organization log, with integrity verification and a maintenance-mode failsafe |

## Known limitations

Disclosed up front rather than discovered later:

- `vault_state.key_rotated_at` exists but no rotation-execution code path advances it yet. The same applies to the wrapped data key in key-management-service mode: no code path re-wraps it under a new key, so only credential rotation at the provider is transparent.
- Audit-chain verification detects modification and interior deletion, but cannot detect deletion of the newest rows at the tail of a chain.
- No first-party outbound HTTP webhook notification channel. Webhook-style delivery is achievable today by registering an extension notification channel or delivery provider.
- No live backup-job progress polling and no in-app upgrade trigger. In-place upgrades stay an out-of-band `docker compose pull && up -d` operation.
- The API serves plain HTTP and expects a TLS-terminating reverse proxy in front of it.

## Quick start (Docker)

Requires Node.js 24 LTS, pnpm 11.21.0+, Docker 24+ with Buildx, and Docker Compose v2. macOS and Linux natively; Windows needs WSL2.

```bash
cp .env.example .env
make check-ports          # then `make fix-ports` if any host port is BUSY
make bootstrap-docker     # Postgres, migrations, API, web, and Mailpit
```

`make bootstrap-docker` prints the web, API, and health URLs it selected — it assigns each checkout
its own host ports, so use the addresses it prints rather than assuming the defaults. Open the web
URL, initialize and unseal the vault, then register the first user. That account becomes the
instance's platform operator.

Full walkthrough, readiness states, production hardening, and troubleshooting: **[docs/operator-quickstart.md](docs/operator-quickstart.md)**.

## Next steps by role

| You are… | Start here |
|---|---|
| Operating an instance | [docs/operator-quickstart.md](docs/operator-quickstart.md), then [docs/runbook.md](docs/runbook.md) and [docs/runbooks/README.md](docs/runbooks/README.md) |
| Deploying prebuilt images | [docs/container-images.md](docs/container-images.md) |
| Configuring it | [docs/configuration.md](docs/configuration.md) |
| Fetching secrets from CI/CD | [docs/machine-users.md](docs/machine-users.md), [packages/vault-action](packages/vault-action/README.md) |
| Calling the API directly | [docs/api-consumers.md](docs/api-consumers.md) |
| Developing Project Vault | [docs/development.md](docs/development.md) |
| Writing an extension | [docs/extensions/README.md](docs/extensions/README.md), [packages/extension-api](packages/extension-api/README.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| Looking for everything | [docs/README.md](docs/README.md) |

## Architecture at a glance

| Layer | Technology |
|---|---|
| Frontend | Svelte 5 + SvelteKit 2 + Tailwind CSS v4 |
| Backend | Fastify v5 (TypeScript) |
| Database | PostgreSQL 16 + Drizzle ORM + row-level security |
| Background jobs | pg-boss (PostgreSQL-backed, no Redis) |
| Monorepo | Turborepo + pnpm workspaces |
| Testing | Vitest, Playwright |
| Deployment | Docker / Docker Compose (amd64 + arm64) |

The Compose stack is four moving parts: **db** (PostgreSQL), a one-shot **migrate** service that applies migrations behind a destructive-migration guard, **api** (Fastify, which also hosts the pg-boss background workers in-process), and **web** (SvelteKit). Tenant isolation is enforced in the database by row-level security, not only in application code. See [docs/architecture.md](docs/architecture.md) for the request path, the database roles, the vault key hierarchy, and how extensions load.

## Roadmap

| Version | Target | Status |
|---|---|---|
| **Current** | Self-hosted Docker, full secrets lifecycle, multi-field secrets, credential sharing, manual rotation, monitoring, teams, notifications, machine users, chain-linked audit logs, per-organization audit quotas, backup, in-place upgrades, extension architecture with UI panels and module packs, pluggable and self-hosted SSO, CentralizeMe handoff SSO, English/Spanish localization, custom theming, project export/import, service-provisioning API | Shipped |
| **Next** | First-party outbound HTTP webhook channel (webhook-style delivery is already possible via an extension), project wiki | Planned |
| **Later** | Commercial SaaS tier, automated provider plugins (AWS, GCP, Azure, databases), enterprise SSO, compliance reporting | Planned |

Released versions and their upgrade notes are in [CHANGELOG.md](CHANGELOG.md).

## Open-core model and license

Project Vault is free and open source under the **AGPL-3.0** license. The core — secrets storage, versioning, access control, audit logs, encryption at rest, the extension interface, manual rotation, and monitoring — will always be open. Self-hosted deployments are free, forever.

A commercial SaaS tier is planned, adding managed hosting, enterprise/managed SSO, and compliance reporting. It is distinct from the self-hosted, organization-configured SSO available today.

**CentralizeMe** is the maintainer's commercial hosted SaaS product, which embeds Project Vault as a module. It is the first consumer of the extension API and the issuer of the browser-handoff tokens Project Vault accepts. It is not required for self-hosting, and nothing in this repository depends on it.

Copyright (C) 2026 Nestor Mata Cuthbert. This program is distributed WITHOUT ANY WARRANTY; see [LICENSE](LICENSE) for the full text and <https://www.gnu.org/licenses/>.

## Security

Project Vault handles credentials, certificates, and sensitive operational data. Security is an architectural concern here, not a feature layer.

- All secrets are encrypted at rest with AES-256-GCM; secret values are zeroed in memory after use.
- Constant-time comparison for every secret and token operation; secret values must never reach logs, stack traces, or error messages.
- The API is designed to run behind a TLS-terminating reverse proxy. It emits HSTS headers and requires `COOKIE_SECURE=true` in production.
- Production boot refuses known development secret values and requires all twelve HMAC and session secrets to be set explicitly.

**To report a vulnerability, do not open a public issue.** Follow [SECURITY.md](SECURITY.md).

## Contributing

External code contributions are governed by [CONTRIBUTING.md](CONTRIBUTING.md), which covers branching and commit conventions, the local quality gates, and the Contributor License Agreement that every external pull request must satisfy — including a plain-language disclosure that contributions may be used in a closed-source commercial product built on top of this AGPLv3 core. The full text is in [CLA.md](CLA.md). Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Other ways to help without opening a pull request:

- Star this repository to signal interest and help with discovery.
- Open issues for feature requests, use cases, or questions — early input shapes the roadmap.
- Start a discussion about the extension interface, the access-control model, or integration patterns.
- Read the design specifications and research in [specs/](specs/README.md) and the operational documentation in [docs/](docs/README.md).
