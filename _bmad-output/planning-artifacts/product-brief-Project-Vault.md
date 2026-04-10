---
title: "Product Brief: Project Vault"
status: "complete"
created: "2026-04-07"
updated: "2026-04-07"
inputs: ["user discovery session", "competitive landscape research (knowledge base, Aug 2025)"]
---

# Product Brief: Project Vault

## Executive Summary

Engineering teams running real projects don't just manage code — they manage a sprawling web of credentials, services, certificates, domains, payments, and rotating secrets across dozens of servers and providers. Today, this is handled with a patchwork of tools, spreadsheets, shared password managers, and tribal knowledge. The result: security gaps, missed expiry dates, credential sprawl, and no single source of truth.

Project Vault is a self-hostable, open-core secrets and project infrastructure management platform built for engineering teams. It centralizes every credential, service, certificate, and operational deadline under one project — and automates what currently requires human attention: rotating passwords, propagating changes to live systems, alerting on expiry dates, and monitoring which systems are running which version of which secret.

Unlike generic secrets managers that organize by environment, Project Vault organizes by *project* — the unit that actually matters to the people building and running software. And unlike enterprise-grade tools that require a dedicated platform team, Project Vault is designed for the team that's past a spreadsheet but not ready for a six-figure contract. The open-core model means the platform can be audited, self-hosted, and trusted — while advanced capabilities are available for teams that need them.

## The Problem

A modern software project ships with dozens of moving parts: database credentials, API keys, OAuth tokens, SSL certificates, domain renewals, payment subscriptions, deployment credentials, and service accounts — spread across AWS, GCP, GitHub, Stripe, Cloudflare, and more. Each has its own rotation schedule, expiry date, access policy, and notification surface.

Teams today cope with a combination of tools that don't talk to each other:
- A cloud-provider secrets manager (but it only covers that cloud)
- A shared password manager (not built for automation or machine users)
- A spreadsheet or Notion doc (for the things that don't fit anywhere else)
- Cron jobs and custom scripts (for rotation — mostly unmaintained)
- Calendar reminders (for certificate and domain renewals)

The cost: security incidents when rotated credentials aren't propagated everywhere, outages when certificates expire unnoticed, wasted hours debugging which service is still on the old password, and the constant anxiety of not knowing if everything is actually up to date.

The bigger the project, the worse it gets. One engineer can easily be responsible for 50+ credentials across 10+ services. And when someone leaves the team, that tribal knowledge walks out the door.

## The Solution

Project Vault gives every project a single, secure home for everything that keeps it running:

**Secrets & Credentials** — Store passwords, API keys, tokens, and certificates with full version history. Access via UI, REST API, or SSH. Machine users (CI/CD pipelines, services) get their own identities with scoped permissions and audit trails.

**Plugin-Based Rotation & Propagation** — Schedule credential rotation and let Project Vault push the new value to connected systems through a plugin architecture that supports multiple propagation models: assisted manual workflows (step-by-step tracking with per-system confirmation), AWS (IAM users, RDS, Secrets Manager), Azure, Google Cloud, Linux/Unix servers via SSH, Windows servers, and direct database connections. Each plugin handles the specifics of its target; the vault handles orchestration, versioning, and confirmation. New providers can be added without changing the core.

**Operational Visibility** — Track domains, certificates, hosting services, and payment subscriptions with expiry dates and proactive alerts. Never be surprised by an expired cert or a lapsed subscription again.

**Health & Uptime Monitoring** — Monitor the live status of services, endpoints, and infrastructure from the same context as your credentials.

**Project Dashboard** — One screen. All projects. Everything that matters: what's healthy, what's expiring, what's been rotated, who accessed what and when. This is the aha moment — landing on the dashboard and finally seeing the whole picture.

**Triggers & Notifications** — Events drive actions. A certificate nearing expiry triggers an alert. A rotation triggers a system update. A failed health check triggers an escalation. Configurable, auditable, automatable.

**Built-in Documentation** — Project wikis, runbooks, and service documentation live alongside the credentials they describe. The context for *why* a credential exists and *how* to use it never gets separated from the credential itself.

**Audit & Compliance** — Every access, rotation, and change is logged. Know who requested what, when, and from where. Built with SOC 2, ISO 27001, and other common security standards in mind — so the platform actively helps teams pass audits, not just survive them.

## What Makes This Different

**Project-centric, not environment-centric.** Every other tool organizes secrets by environment (dev/staging/prod). Project Vault organizes by *project* — which is how engineering teams actually think about their work.

**Open-core and auditable.** The core platform is open source. Engineers can read the code, verify the security model, and self-host with confidence. Advanced features (enterprise SSO, compliance reporting, expanded provider plugins, multi-tenancy) are available in the commercial tier.

**Self-hostable with a SaaS path.** Teams that need data sovereignty run their own instance. Teams that want managed infrastructure use the hosted offering. Same platform, both ways.

**Plugin-based propagation.** Rotation isn't just "generate a new secret" — it's a coordinated update across every system that uses that credential. The plugin model means Project Vault works with your stack today and extends to new providers as they're added, without changing the core platform.

**Operational scope, not just secrets scope.** Certificates, domains, payment dates, uptime, and documentation — these live alongside credentials because they're all part of keeping a project running. One tool. One dashboard.

**Security and compliance as a selling point, not an afterthought.** Project Vault is designed to help teams meet SOC 2, ISO 27001, and similar standards. The audit logs, RBAC, versioning, and access controls aren't bolted on — they're structural.

**Mid-size by design, scalable by architecture.** Not an enterprise appliance requiring a platform team (HashiCorp Vault). Not a cloud-provider lock-in (AWS Secrets Manager). Not an env-var tool with API access bolted on (Doppler). Not a close-but-limited newcomer (Infisical). Project Vault is built for the team that has real operational complexity but finite resources to manage it.

**Tiered access model.** Single project (solo developer), indie (multiple projects, 1–2 users), small company, and team tiers — so the right version exists at every stage of a project's life.

## Who This Serves

**Primary: Mid-size engineering teams (5–50 engineers)** running complex multi-service projects. They've outgrown shared password managers and ad hoc scripts but aren't ready for enterprise tooling. They feel the pain most acutely — security incidents, missed renewals, credential sprawl.

**Secondary: Indie developers and small teams (1–4 engineers)** managing multiple projects simultaneously. For them, Project Vault replaces a combination of Bitwarden, a reminder app, and a collection of cron jobs they no longer maintain.

**Tertiary: Larger engineering organizations** adopting Project Vault at the project or team level, where it complements (rather than replaces) broader enterprise systems. The open-core model and compliance focus make it legible to security teams and procurement.

**Machine users are first-class.** CI/CD pipelines, microservices, and automated scripts get real identities with real permissions and audit trails — not afterthoughts sharing a service account.

## Success Criteria

**User success signals:**
- A team loads all credentials, certificates, and services for an existing project within one working day
- First automated rotation completes with zero manual follow-up steps
- A user catches an expiring certificate or domain renewal through Project Vault — before it causes an incident
- Engineers report the dashboard as their first stop when checking on project health
- A team cites Project Vault audit logs when passing a security review or audit

**Business objectives (12 months post-launch):**
- 500 active projects across self-hosted and SaaS deployments
- Net Promoter Score ≥ 40 among primary user segment
- SaaS monthly recurring revenue covering infrastructure costs within 6 months of launch
- At least 3 documented case studies of security incidents or outages prevented
- Meaningful open source community traction (stars, contributors, community plugins)

## Scope

**V1 (MVP) — in scope:**
- Secure secrets storage with versioning and access control (RBAC)
- Plugin-based rotation with propagation: manual/assisted (v1), with plugin interfaces for cloud providers and servers
- Hosting and service records with expiry dates and configurable alerts
- SSL/TLS certificate expiry monitoring
- Uptime and health monitoring for services and endpoints
- Project dashboard (single-pane visibility across all projects)
- Multi-user support with roles and access groups
- Machine user support (service accounts, API keys)
- Triggers and notification system (webhooks, email)
- Audit logs
- Import from common formats (.env, JSON) to ease migration
- Self-hosted deployment (Docker / Docker Compose)
- Built-in documentation and notes (project wiki, runbooks, service documentation)
- Open source core

**V1 — out of scope:**
- SSO/SAML integration (v2)
- Zero trust network features (future)
- Multi-tenant SaaS hosting (v2 — self-host only at launch)
- Deployment automation (validated post-MVP against user demand)
- SSH access mode (post-MVP)
- Provider-specific plugins beyond manual/assisted: AWS, Azure, GCP, Linux, Windows, database plugins (v2 — plugin interface ships in v1)
- Mobile app
- Formal compliance certifications (SOC 2, ISO 27001 — design for them in v1, pursue certification post-launch)

## Roadmap Thinking

If V1 succeeds, Project Vault becomes the operational foundation for every project — the thing teams install on day one, alongside version control and CI. V2 ships the provider plugin library (AWS, Azure, GCP, Linux/Unix, Windows, major databases), SSO/SAML for enterprise buyers, and the hosted SaaS multi-tenant offering. V3 builds the integration marketplace — community-contributed plugins, compliance certification, and zero trust network capabilities.

The long-term moat is the combination of trust (open-core, auditable, self-hostable) and the integrations ecosystem (plugins that handle every provider a project might use). Being the system teams rely on for their most sensitive operational data is a durable position — especially when the platform actively helps them prove their security posture to auditors and customers.

## Go-to-Market Starting Point

Initial distribution through self-hosting communities (Hacker News, r/selfhosted, ProductHunt) where trust-conscious engineers already look for open-source infrastructure tools. The open-core model enables organic adoption: teams self-host, discover the value, and upgrade to commercial tiers for advanced features or the managed SaaS offering.
