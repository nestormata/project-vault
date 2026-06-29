# Project Vault

> **⚠️ Status: Pre-launch — in active development. Not yet available for use.**

*Run complex projects. Miss nothing.*

Project Vault is a self-hostable, open-core **Project Operations Platform (ProjOps)** — the institutional memory of an engineering project. Where every existing secrets manager organizes by environment (dev / staging / prod), Project Vault organizes by *project*: credentials, certificates, domains, services, payments, and documentation grouped under the natural unit of engineering responsibility.

This is not a UI reorganization. It is a different data model, a different RBAC model, and a different mental model.

---

## What Makes This Different

Every existing secrets manager organizes around a *storage location*. Project Vault organizes by *project* — like filing by project folder, not by cabinet. Operational metadata (certificate expiry, payment renewal dates, uptime monitoring, documentation, service relationships) does not exist in secrets managers at all. It requires a project-centric architecture designed from the ground up.

Key differentiators:

- **Project as the unit of truth** — credentials, services, certificates, documentation, and monitoring grouped under one project context, mirroring how engineers think and work
- **Open-core and independently auditable** — the full security engine is open source; trust is earned through transparency, not claimed
- **Plugin-based rotation with propagation** — when a credential rotates, Project Vault updates it in every connected system and confirms each update before the old credential is retired
- **Operational scope** — certificates, domains, payment dates, uptime, and documentation live alongside credentials because they are all part of keeping a project running
- **Self-hosted primary, SaaS optional** — data sovereignty is the default trust path
- **Compliance by design** — audit logs, RBAC, and versioning are structured to support SOC 2 Type II and ISO 27001 evidence collection from day one

---

## Planned Features (v1)

- 🔐 **Secrets management** — versioned, encrypted storage with RBAC, expiry tracking, and bulk import from `.env` / JSON
- 🔄 **Manual rotation with propagation** — per-system confirmation checklist; old credential retired only after every system confirms
- 📡 **Operational monitoring** — HTTP uptime checks, SSL/TLS certificate expiry, domain renewal alerts, payment subscription tracking
- 🤖 **Machine user support** — scoped API keys, offline/cache fallback, deploy-time versioning, CI/CD native integrations
- 📋 **Immutable audit logs** — append-only, row-level cryptographic chaining, GDPR-compliant pseudonymization, compliance export
- 🏢 **Multi-user RBAC** — project-scoped roles (Owner, Admin, Member, Viewer), organization-level administration
- 🔑 **Vault unsealing** — master password or envelope encryption with split-key default; KMS integration as advanced option
- 💾 **Built-in backup** — scheduled encrypted snapshots, configurable retention, restore verification
- 🌐 **REST API + OpenAPI spec** — all capabilities available via versioned API; no privileged UI-only operations
- 🐳 **Self-hosted Docker** — single `docker compose up` deployment; open-source core published

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Svelte 5 + SvelteKit 2 + Tailwind CSS v4 |
| Backend | Fastify v5 (TypeScript) |
| Database | PostgreSQL + Drizzle ORM + Row-Level Security |
| Background jobs | pg-boss (PostgreSQL-backed, no Redis) |
| Monorepo | Turborepo + pnpm workspaces |
| Testing | Vitest |
| Deployment | Docker / Docker Compose (AMD64 + ARM64) |

---

## Open-Core Model

Project Vault is **free and open source** under the AGPL-3.0 license. The core — secrets storage, versioning, RBAC, audit logs, encryption at rest, plugin interface, manual rotation, and monitoring — will always be open.

A commercial **SaaS tier** is planned for v2, adding managed hosting, enterprise SSO, and compliance reporting. Self-hosted deployments remain free.

---

## Roadmap

| Version | Target |
|---|---|
| **v1 (MVP)** | Self-hosted Docker, full secrets lifecycle, manual rotation, monitoring, audit logs, machine users, backup |
| **v1.1** | Webhooks, project wiki, break-glass revocation endpoint |
| **v2** | Commercial SaaS tier, automated provider plugins (AWS, GCP, Azure, databases), enterprise SSO, compliance reporting |

---

## Getting Started

### Minimum Tooling Versions

| Tool | Minimum Version |
|---|---|
| Node.js | 24 LTS |
| pnpm | 9.x or later |
| Docker | 24+ with Buildx |
| Docker Compose | v2 |

**Supported platforms:** macOS and Linux natively. Windows requires WSL2.

### Docker Quickstart

```bash
cp .env.example .env          # configure environment variables
docker compose up --build     # start all services
```

Services will be available at:
- Web: http://localhost:5173
- API: http://localhost:3000
- API health: http://localhost:3000/health

### Use the Story 2.0 MVP Shell

Story 2.0 ships the first usable web shell: vault readiness, vault initialize/unseal forms, registration, login, server-side session refresh, logout, the authenticated app shell, and honest empty project dashboards.

The fastest local path is to run the API and web app in development mode against the local Postgres container:

```bash
pnpm install
make db-up
make db-migrate

export DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault
export VAULT_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)
pnpm turbo dev
```

Start or restart `pnpm turbo dev` after exporting the vault token. Turbo runs in strict
environment mode, so `turbo.json` must pass vault operator env vars through to the API task.

Open http://localhost:5173. The root route checks vault readiness and sends you to the correct next step:

1. If the vault is uninitialized, use **Initialize vault**. For local evaluation, choose **Passphrase**, paste the `VAULT_BOOTSTRAP_TOKEN` value from your shell into the bootstrap-token field, and enter a vault passphrase you can reuse for unseal.
2. If the vault is sealed, use **Unseal vault** with the same passphrase or with the configured server-side key path for file/envelope modes.
3. When the vault is ready, register the first user, then sign in. Registration creates the account but does not automatically create a session.
4. After login, use the authenticated shell navigation: Dashboard, Projects, Credentials, Alerts, Health, and Settings.
5. On Dashboard, choose **Preview an empty project dashboard** to see the project-centered MVP dashboard. This preview is intentionally in-memory only and resets on reload; durable projects arrive in Story 2.1.

What is intentionally not live yet:

- Saved project creation and project APIs are Story 2.1.
- Credential storage/search, imports, and credential actions start in later Epic 2 stories.
- Alerts, health monitoring, audit UI, machine users, backup/restore, and real operational counts are placeholders only.
- Empty states are not errors and are not "all healthy" signals; they show which operational coverage is still missing.

### Local Development

```bash
pnpm install                  # install dependencies
cp .env.example .env          # configure environment variables (see below)
```

Most local tasks need a real PostgreSQL connection. The repo uses **two** DB roles:

| Role | Used for | Why |
|---|---|---|
| `postgres` (superuser) | running migrations only | migrations bootstrap the `vault_app` role and the RLS policies/triggers in `packages/db/src/migrations/` |
| `vault_app` | everything else — the app itself, tests, RLS checks | the `postgres` **superuser bypasses Row-Level Security entirely**. If anything other than a migration connects as `postgres`, RLS/isolation tests will pass even when policies are broken or missing — they're silently not being checked |

Steps to get a working local DB:

```bash
docker compose up -d db                       # start just the Postgres container
DATABASE_URL=postgresql://postgres:password@localhost:5432/project_vault \
  pnpm db:migrate                             # bootstraps vault_app + RLS (superuser only)
```

From here on, **export `DATABASE_URL` using `vault_app`**, not `postgres`, for dev/test/lint work:

```bash
export DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault
pnpm turbo dev                                # start all dev servers
pnpm turbo test                               # run tests
pnpm check-rls                                # verify RLS coverage
```

`turbo.json` passes `DATABASE_URL` through to every task once it's set in your shell — but **nothing auto-loads `.env`** for you (no dotenv wiring in `turbo.json` or package scripts). If a task complains about missing rows, RLS isolation, or unexpected privileges, the most likely cause is `DATABASE_URL` not being exported, or still pointing at `postgres`.

### Auth Configuration

Story 1.6 adds password registration and cookie-based sessions. Local development can use the defaults in `.env.example`; production must replace both auth secrets with distinct 32+ byte random values:

```bash
SESSION_SECRET=$(openssl rand -hex 32)
REFRESH_TOKEN_HMAC_SECRET=$(openssl rand -hex 32)
```

Key auth settings:

| Variable | Local default | Production note |
|---|---|---|
| `AUTH_REGISTRATION_ENABLED` | `true` | Set `false` for invite-only deployments |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS/Traefik so browsers persist auth cookies |
| `TRUST_PROXY` / `TRUST_PROXY_HOPS` | `false` / `1` | Enable only behind a trusted reverse proxy |
| `JWT_ACCESS_TTL_SECONDS` | `300` | Access cookie lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | Refresh cookie lifetime |

Example auth flow after the vault is initialized and unsealed:

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.example","password":"correct-horse-battery-staple","orgName":"Acme Corp"}' | jq .

curl -s -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.example","password":"correct-horse-battery-staple"}' | jq .

curl -s -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/v1/auth/refresh | jq .
```

Rotating `SESSION_SECRET` invalidates access JWTs. Rotating `REFRESH_TOKEN_HMAC_SECRET` invalidates all refresh tokens and forces users to log in again.

A [`Makefile`](./Makefile) wraps all of this so you don't have to remember the roles or re-export `DATABASE_URL` by hand:

```bash
make help          # list all available tasks
make db-up          # start just the Postgres container
make db-migrate      # run migrations as postgres (bootstraps vault_app + RLS)
make test           # run tests as vault_app
make check-rls      # verify RLS coverage as vault_app
make ci             # run the full local quality-gate sequence
make docker-up       # build + start the full stack
```

### CI Quality Gates

Each gate runs on every PR:

| Gate | Command | What it checks |
|---|---|---|
| TypeScript | `pnpm turbo typecheck` | strict TS, noUncheckedIndexedAccess |
| Lint | `pnpm turbo lint` | ESLint flat config with security rules |
| Tests | `pnpm turbo test` (as `vault_app`) | Vitest with ≥80% coverage |
| Duplication | `pnpm jscpd` | Zero code duplication |
| Secrets | ESLint no-secrets | Entropy-based secret detection |
| Audit | `pnpm audit --audit-level=high` | Zero high/critical CVEs |
| Docker | CI only | Multi-arch build validation |

Nightly gates (runs at 02:00 UTC):
- **Mutation testing** (Stryker) — score ≥60% (target ≥80% after Epic 2)
- **Docker image scan** (Trivy) — zero high/critical CVEs

### Pre-PR Checklist

```bash
make ci              # typecheck, lint, migrate, RLS check, test, jscpd, audit, spec freshness
make docker-smoke     # end-to-end Docker health check
```

Equivalent without `make`:

```bash
pnpm turbo typecheck lint
DATABASE_URL=postgresql://postgres:password@localhost:5432/project_vault pnpm db:migrate
DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm check-rls
DATABASE_URL=postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault pnpm turbo test
pnpm jscpd
pnpm docker:smoke
```

### Base Image Update Procedure

Run `scripts/update-base-image.sh` weekly to get fresh digests for pinned Docker base images. Update the `FROM` lines in Dockerfiles with the output digest. Document quarterly in the operations checklist.

### Production Usage

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Contributing

Contributions are welcome once the initial codebase is bootstrapped. Until then, the best way to contribute is:

- ⭐ **Star this repository** to signal interest and help with OSS discovery
- 🐛 **Open issues** for feature requests, use cases, or questions — early input shapes the roadmap
- 💬 **Start a discussion** if you have ideas about the plugin interface, RBAC model, or integration patterns
- 📖 **Review the planning artifacts** in `_bmad-output/planning-artifacts/` — the PRD, UX spec, and architecture docs are open

When the codebase is live, a `CONTRIBUTING.md` will cover:
- Development environment setup
- Code style and conventions
- Security-sensitive code path requirements
- Plugin development guide
- PR review process

---

## Security

Project Vault handles credentials, certificates, and sensitive operational data. Security is a first-class architectural concern, not a feature layer.

- All secrets encrypted at rest with AES-256-GCM
- TLS 1.3 required for all inbound connections
- Constant-time comparisons for all secret/token operations; memory zeroing after secret use
- Secret values must never appear in logs, stack traces, or error messages
- Full security model documented in architecture artifacts

To report a security vulnerability, please **do not open a public issue**. Contact details will be published in a `SECURITY.md` at launch.

---

## License

Copyright (C) 2026 Nestor Mata Cuthbert

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.

See [LICENSE](./LICENSE) for the full license text.
