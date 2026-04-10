---
title: "Product Brief Distillate: Project Vault"
type: llm-distillate
source: "product-brief-Project-Vault.md"
created: "2026-04-07"
purpose: "Token-efficient context for downstream PRD creation"
---

# Project Vault — Detail Pack

## Core Identity

- **Type:** Self-hostable, open-core secrets and project infrastructure management platform
- **Organizing unit:** Project (not environment) — this is the key differentiator from all competitors
- **NOT a personal password manager** — built exclusively for projects and teams
- **Open-core model:** Core platform open source; advanced features (enterprise SSO, compliance reporting, expanded plugins, multi-tenancy) in commercial tier
- **Two deployment modes:** Self-hosted (Docker/Compose) and hosted SaaS multi-tenant (v2)

## Problem Details

- Engineers managing large projects deal with: DB creds, API keys, OAuth tokens, SSL certs, domain renewals, payment subscriptions, deployment creds, service accounts — across multiple cloud providers simultaneously
- Current coping mechanisms: cloud secrets manager (single provider) + shared password manager (no automation) + spreadsheet/Notion (overflow) + cron jobs (rotation, unmaintained) + calendar reminders (cert/domain renewals)
- Key pain: credential rotation that doesn't propagate — old passwords remain active in some systems, creating security gaps
- Key pain: no single screen showing project health — cert expiry, service uptime, payment dates, recent access
- Pain scales superlinearly with project size — 1 engineer can own 50+ credentials across 10+ services
- Tribal knowledge loss when engineers leave — no documentation tied to credentials

## Users

- **Primary:** Mid-size engineering teams (5–50 engineers), complex multi-service projects, outgrown ad hoc tools, not ready for enterprise contracts
- **Secondary:** Indie developers (1–4 people), multiple projects, replace Bitwarden + reminder app + cron jobs
- **Tertiary:** Larger orgs adopting at project/team level (not replacing enterprise systems)
- **Machine users are first-class** — CI/CD pipelines, microservices, scripts; each gets its own identity, permissions, audit trail; not shared service accounts
- Target is NOT personal/individual password management

## Pricing Model (tiered, details TBD)

- **Single project** — 1 user, 1 project (solo developer)
- **Indie** — multiple projects, 1–2 users
- **Small company** — multiple projects, more users
- **Team/Company** — scales up
- Dimensions: per project + per seat + per feature set (package-based)
- Open source self-hosted = always free (core features)
- Commercial tiers = advanced features + hosted SaaS option

## Plugin-Based Rotation & Propagation — Full Detail

- Architecture: plugin system where each provider has its own implementation; vault handles orchestration, versioning, scheduling, confirmation
- **Manual/Assisted plugin (v1):** Creates new credential, keeps old active, generates a step-by-step checklist of every system that needs updating, user marks each system done, old credential deprecated only when all steps confirmed — full audit trail throughout
- **v2 provider plugins (interface ships in v1, implementations in v2):**
  - AWS: IAM users, RDS passwords, Secrets Manager sync
  - Azure: equivalent services
  - Google Cloud: equivalent services
  - Linux/Unix VPS: SSH-based credential update
  - Windows servers: WinRM or equivalent
  - Databases: direct connection (MySQL, PostgreSQL, etc.)
- Plugin interface is public/open — community can contribute provider plugins
- Rotation flow: schedule → generate new → propagate via plugin → confirm per system → notify users/systems → deprecate old → audit log

## MVP Scope — Detailed

**In (v1):**
- Secrets storage: passwords, API keys, tokens, certificates; full versioning; RBAC
- Rotation: manual/assisted plugin only (full auto-propagation plugins in v2); plugin interface defined
- Service/hosting records with payment dates, expiry dates, configurable alerts
- SSL/TLS certificate expiry monitoring
- Uptime/health monitoring for endpoints and services
- Project dashboard: single-pane view across all projects and all credential/service/cert status
- Multi-user: roles, access groups, per-credential permissions
- Machine users: service accounts, API keys, scoped permissions
- Triggers: event-driven (cert expiry → alert, rotation → notify, health fail → escalate); webhooks + email
- Audit logs: all access, rotations, changes — immutable
- Import: .env files, JSON (migration path from existing setups)
- Self-hosted: Docker / Docker Compose, single-command setup goal
- Built-in docs: project wiki, runbooks, service documentation — lives alongside credentials
- Open source core published

**Out of v1 (explicitly deferred):**
- SSO/SAML — v2
- Multi-tenant SaaS hosting — v2 (self-host only at launch)
- Provider-specific rotation plugins (AWS/Azure/GCP/Linux/Windows/DB) — v2 (interface in v1)
- SSH CLI access mode — post-MVP
- Deployment automation — post-MVP, validate demand first
- Mobile app — not planned near-term
- Formal compliance certifications (SOC 2, ISO 27001) — design for them in v1, certify post-launch
- Zero trust network — nice-to-have, future consideration only

## Security & Compliance

- Security is first-class, not bolted on
- Compliance standards to design for: SOC 2, ISO 27001 (and others where feasible)
- Compliance as explicit selling point — audit logs, RBAC, versioning, access controls are structural
- Open-core model is itself a trust mechanism — engineers can audit the code
- No formal certification in v1; pursue post-launch
- Zero trust: explicitly "nice to have / future" — not a v1 or v2 requirement

## Competitive Intelligence

| Tool | Self-host | Multi-tenant SaaS | Rotation+Propagation | Monitoring | Notes |
|---|---|---|---|---|---|
| HashiCorp Vault | Yes | Enterprise only | Partial | Limited | Too complex/expensive; env-centric; steep learning curve |
| Infisical | Yes | Yes | Growing, limited | Weak | Closest competitor; open source; env-centric not project-centric; limited monitoring/triggers |
| Doppler | No | Yes | No | No | Good DX; cloud-only; env-var focused; no self-host |
| Bitwarden Secrets | Yes | Limited | No | No | Too simple; no automation |
| 1Password Teams | No | No | No | No | Not built for automation; not self-hostable |
| AWS/Azure/GCP | No | N/A | Native (own cloud) | Partial | Cloud-locked; multi-cloud painful |
| CyberArk | Yes | Enterprise | Yes | Yes | Very expensive; complex; enterprise-only |

**Key gap Project Vault fills:** No tool combines self-hostable + optional SaaS + project-centric organization + rotation WITH confirmed propagation + usage monitoring + triggers — at mid-size price/complexity.

**Trends supporting the opportunity:**
- Secrets sprawl is a growing, recognized pain
- Machine identities (CI/CD, services) growing faster than human identities
- Zero trust becoming standard (future opportunity)
- Multi-cloud is the norm → cloud-agnostic tools win
- SOC 2 / compliance requirements driving audit/logging demand

## Go-to-Market

- Launch channels: Hacker News (Show HN), r/selfhosted, ProductHunt
- Open-core model enables organic adoption: self-host free → discover value → upgrade commercial
- Trust-conscious engineers in self-hosting communities are the ideal early adopter
- No other specific GTM strategy defined yet — this is a starting point

## Open Questions (not resolved during discovery)

- Exact technical security architecture (encryption at rest/transit approach, key management)
- Backup and disaster recovery story for the vault itself — not discussed, but critical
- How does Project Vault authenticate to target systems for propagation? (credential bootstrap problem)
- CI/CD integration story (GitHub Actions, GitLab CI, Jenkins) — not discussed; important for adoption
- Specific compliance certifications to prioritize (SOC 2 Type I/II, ISO 27001, others?)
- Community governance model for open source core
- Exact pricing numbers — tier structure defined, amounts TBD

## Aha Moment

Landing on the project dashboard and seeing everything — credentials, cert expiry, service health, payment dates, recent access — in one screen for the first time. Also: watching the first automated rotation complete and knowing every connected system was updated without manual intervention.
