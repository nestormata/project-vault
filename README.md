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

### Local Development

```bash
pnpm install                  # install dependencies
pnpm turbo dev                # start all dev servers
```

### CI Quality Gates

Each gate runs on every PR:

| Gate | Command | What it checks |
|---|---|---|
| TypeScript | `pnpm turbo typecheck` | strict TS, noUncheckedIndexedAccess |
| Lint | `pnpm turbo lint` | ESLint flat config with security rules |
| Tests | `pnpm turbo test` | Vitest with ≥80% coverage |
| Duplication | `pnpm jscpd` | Zero code duplication |
| Secrets | ESLint no-secrets | Entropy-based secret detection |
| Audit | `pnpm audit --audit-level=high` | Zero high/critical CVEs |
| Docker | CI only | Multi-arch build validation |

Nightly gates (runs at 02:00 UTC):
- **Mutation testing** (Stryker) — score ≥60% (target ≥80% after Epic 2)
- **Docker image scan** (Trivy) — zero high/critical CVEs

### Pre-PR Checklist

```bash
pnpm turbo typecheck lint test  # all must pass
pnpm jscpd                      # zero duplicates
pnpm docker:smoke               # end-to-end Docker health check
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
