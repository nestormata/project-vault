---
stepsCompleted: ["step-01-init", "step-02-discovery", "step-02b-vision", "step-02c-executive-summary", "step-03-success", "step-04-journeys", "step-05-domain", "step-06-innovation", "step-07-project-type", "step-08-scoping", "step-09-functional", "step-10-nonfunctional", "step-11-polish", "step-e-01-discovery", "step-e-02-review", "step-e-03-edit"]
inputDocuments:
  - "_bmad-output/planning-artifacts/product-brief-Project-Vault.md"
  - "_bmad-output/planning-artifacts/product-brief-Project-Vault-distillate.md"
workflowType: 'prd'
lastEdited: '2026-07-23'
editHistory:
  - date: '2026-05-28'
    changes: 'Post-validation pass: closed FR31/FR37/FR71/FR73 threshold defaults; fixed TLS inbound/outbound split in Domain Requirements; updated MVP scope list (webhooks v1.1, wiki v1.1); added FR13/FR30 gap notes; moved v1 sustainability paragraph to Executive Summary; added machine user onboarding acceptance criterion; replaced axe-core tool name with tool-agnostic description in Accessibility NFR'
  - date: '2026-07-23'
    changes: 'Added new Phase 2 (inserted before former Phase 2/v1.1, renumbering subsequent phases to 3-5): Extension/Hook Architecture (general-purpose, distinct from rotation plugins), AGPLv3 relicense + CLA, multi-field secrets (field-set model with templates), i18n/localization, and structured non-code theming. New FR groups: Extension & Plugin Architecture (FR113-116, FR116 deferred), Internationalization & Localization (FR117-119), Theming (FR120-121); amended FR10/FR12/FR18/FR96 for multi-field secrets; added FR111-112. Renumbered 2026-07-23 from an initial FR99/FR100/FR106-114 assignment after discovering FR99-FR110 were already in use in epics.md for unrelated capabilities (see below) — final numbering is FR111-121. Extension trust model split by provenance: founder-only private SaaS extension is in-process/trusted, third-party community extensions (deferred to a later phase) are sandboxed/out-of-process with no default secret-value access. Replaced placeholder i18n NFR with real locale/fallback requirements; added Extension API stability, theming, and extension-trust-isolation NFRs. Frontmatter: added licenseModel and extensionModel classification fields.'
  - date: '2026-07-23'
    changes: 'Post-validation refinement pass: fixed WASM implementation-leakage wording (2 occurrences) to capability-level language; added 4 new user journeys (Priya/hosted-SaaS auth extension, Jordan/community extension, Amara/i18n+theming, Noah/multi-field secrets) closing the traceability gap for all Phase 2 capabilities; added competing-hosted-fork risk row to Domain-Specific Requirements Risk Mitigations table; updated journey count references from 5 to 9.'
  - date: '2026-07-23'
    changes: '5-agent adversarial review during Create Epics and Stories: amended FR115 to require explicit identity binding for external auth (no auto-link-by-email, invitation/OrgAdmin-linked only — closes a real gap, not just a documentation nit); added a scope note to Journey 7 (Jordan) clarifying it depicts a future, sandboxing-dependent state, not what the current Extension Architecture epic builds — was previously contradicting FR116s deferred status without saying so.'
  - date: '2026-07-23'
    changes: 'Discovered during Create Epics and Stories workflow: epics.md already used FR99-FR110 for 11 requirements added during epic/story work (recovery notifications, alert routing, machine-key rotation overlap and dormancy detection, account-recovery audit, platform operator audit log, dependent-system archival, break-glass rotation, master-key custody alerting, in-product notification inbox) that were never written back to this PRD. Two fixes applied: (1) renumbered this PRDs Phase 2 additions from FR99/FR100/FR106-114 to FR111-121 to resolve the collision; (2) back-ported all 11 missing FRs into their correct existing capability groups, each tagged "back-ported from epics.md 2026-07-23". FR106 has no corresponding epics.md requirement and is left intentionally unassigned rather than invented. Architecture.md FR cross-references updated to match the renumbering.'
classification:
  projectType: "Data-sensitive infrastructure platform — web UI + REST API primary, self-hosted Docker as primary trust path, SaaS convenience tier (v2). Two funnels: OSS (indie/solo) and commercial (mid-size teams)."
  domain: "Project Infrastructure Management — secrets lifecycle, operational visibility, credential automation"
  securityPosture: "Critical — security lens applied before all other architectural decisions"
  complexity: "High internal (cryptographic, plugin architecture, RBAC, compliance, tenant-aware data model) — zero complexity leaked to UX"
  projectContext: "greenfield"
  openCoreBoundary: "Open: secrets storage, versioning, RBAC, audit logs, plugin interface, manual rotation, monitoring, encryption at rest | Commercial: hosted SaaS, enterprise SSO, compliance reporting, managed provider plugins"
  propagationArchitecture: "Hybrid push/pull plugin interface — manual/assisted uses pull + human checklist; automated plugins use push via provider API or SSH/WinRM"
  multiTenancy: "Tenant-aware data model from v1; SaaS v2 uses isolated instances per customer"
  buyerVsUser: "User = engineer/DevOps | Buyer = Engineering Manager/CTO — PRD addresses both frames"
  licenseModel: "AGPLv3 for the open-source core (OSI-approved; network-copyleft deters uncompensated competing hosted forks without legally blocking them); CLA required from external contributors so the founder retains rights to use contributions in the closed-source SaaS extension. Not legal advice — requires attorney review pre-launch."
  extensionModel: "Two audiences: (1) third-party community extensions, self-hosted, sandboxed/out-of-process, no default secret-value access — deferred past initial extension rollout; (2) founder's own closed-source multi-tenant SaaS extension, in-process/trusted, deployed only on infrastructure the founder controls, never distributed to self-hosters"
prdFlaggedRequirements:
  - "Drift detection: alert when credentials are stale or systems lag behind current secret version"
  - "Secret versioning pinned to deploy-time for machine users"
  - "Availability/fallback for machine users when vault is unreachable"
  - "Integration alongside existing tools (K8s secrets, other vaults) — layering not replacing"
  - "Open-core security boundary must be explicit in product communications"
---

# Product Requirements Document - Project Vault

**Author:** Nestor
**Date:** 2026-04-07

## Executive Summary

Engineering teams have moved from monoliths to constellations — distributed architectures spanning multiple cloud providers, third-party services, VPS instances, databases, and SaaS tools. Each step away from the monolith adds new credentials, certificates, domains, payment subscriptions, and service dependencies that must be tracked, secured, and maintained. No single tool manages this operational surface under a project-centric context. Teams compensate with a patchwork of cloud-provider secrets managers, shared password tools, spreadsheets, unmaintained cron jobs, and calendar reminders — all operating in isolation, none modeling the natural unit of engineering responsibility: the *project*.

**Project Vault** is the institutional memory of a project — the master keyring, contract binder, and maintenance schedule for everything your project depends on externally. Secrets are stored and rotated. Certificates and domains are tracked. Services are monitored. Nothing critical lives only in a person's head. It is a self-hostable, open-core Project Operations Platform (ProjOps) accessible via web UI and REST API (CLI on roadmap). Secrets can be imported from `.env` files and JSON for frictionless migration. Encryption at rest and in transit by default; the full security implementation is open to independent audit.

Target users span all project scales — from solo indie developers managing multiple projects (OSS tier) to mid-size engineering teams of 5–50 engineers (commercial tier) who have outgrown ad hoc tooling. Machine users (CI/CD pipelines, microservices, cron jobs, serverless functions) are first-class citizens with scoped identities, offline/cache fallback, deploy-time secret versioning, drift detection, and full audit trails. For Engineering Managers and CTOs, Project Vault reduces credential-related incidents, eliminates manual rotation overhead, accelerates engineer onboarding, and delivers audit-ready logs — without vendor lock-in. The self-hosted open-core tier is free; commercial tiers add managed hosting, enterprise SSO, and compliance reporting.

The product ships as a self-hosted Docker deployment with a commercial SaaS tier in v2. Start with visibility. Automate as you grow.

**Business model note:** Project Vault has no commercial revenue in v1 (open-core, self-hosted). v2 SaaS is the revenue model. The development plan must address the gap between v1 launch and v2 commercial revenue — whether through funding, a paid self-hosted license tier, or consulting. This is a business continuity risk that affects whether v2 ships.

*Run complex projects. Miss nothing.*

### What Makes This Special

Every existing secrets manager organizes around a *storage location* — your AWS things here, your database things there, your staging environment over there. Project Vault organizes by *project* — like filing by project folder, not by cabinet. This is not a UI decision; it is a fundamentally different data model. Operational metadata (certificate expiry, payment renewal dates, uptime monitoring, documentation, service relationships) does not exist in secrets managers at all. It cannot be bolted onto environment-centric tools — it requires a project-centric architecture designed from the ground up.

Key differentiators:
- **Project as the unit of truth** — credentials, services, certificates, documentation, and monitoring grouped under one project context, mirroring how engineers think and work
- **Open-core and independently auditable** — core security engine (secrets storage, versioning, RBAC, audit logs, encryption at rest, plugin interface, manual rotation, monitoring) is fully open source; trust is earned through transparency, not claimed
- **Plugin-based rotation with propagation** — when a credential rotates, Project Vault updates it in every connected system and confirms each update before the old credential is retired; via a hybrid push/pull plugin architecture (manual/assisted in v1, automated provider plugins in v2)
- **Operational scope** — certificates, domains, payment dates, uptime, and documentation live alongside credentials because they are all part of keeping a project running
- **Self-hosted primary, SaaS optional** — data sovereignty is the default trust path; managed hosting is a convenience tier
- **Compliance by design** — audit logs, RBAC, and versioning are structured to support SOC 2 Type II and ISO 27001 evidence collection from day one
- **Extensible by design** — a versioned Extension API lets self-hosters build their own extensions and lets Project Vault's own hosted SaaS tier extend the same open-source core, without either forking it or shipping closed-source code inside the public repo

## Project Classification

| Dimension | Value |
|---|---|
| **Project Type** | Data-sensitive infrastructure platform — web UI + REST API; self-hosted Docker (primary); SaaS v2 |
| **Domain** | Project Infrastructure Management (ProjOps) |
| **Security Posture** | Critical — security lens applied before all other architectural decisions |
| **Complexity** | High internal (cryptographic, plugin architecture, RBAC, tenant-aware data model) — zero complexity leaked to UX |
| **Project Context** | Greenfield |
| **Open-Core Boundary** | Open: secrets, versioning, RBAC, audit logs, encryption, plugin interface, manual rotation, monitoring / Commercial: hosted SaaS, enterprise SSO, compliance reporting, managed provider plugins |
| **Multi-Tenancy** | Tenant-aware data model from v1; isolated instances per customer in v2 |
| **Adoption Funnels** | OSS self-hosted → indie/solo; Commercial upgrade → mid-size teams |
| **Buyer vs User** | User = engineer/DevOps; Buyer = Engineering Manager/CTO |

## Success Criteria

### User Success

- A team fully loads an existing project (credentials, certificates, services, documentation) into Project Vault within one working day
- First automated rotation completes with zero manual follow-up steps; rotation is only successful when all connected systems confirm the update and the old credential is retired
- A user catches an expiring certificate, domain renewal, or payment date through Project Vault before it causes a service disruption or incident
- Engineers report the dashboard as their first navigation destination when checking on project health
- A team cites Project Vault audit logs in a formal security review, audit, or compliance process
- An engineer joining a team can access all project operational context through Project Vault without asking a colleague
- At day 30, adopting teams describe the experience as "I can't imagine going back"

### Business Success

**3-month targets:**
- 50+ active projects (self-hosted), defined as ≥1 credential accessed in prior 30 days
- Week-1 retention ≥ 60% — teams still actively using Project Vault 7 days after install (primary leading indicator of long-term adoption)
- Meaningful OSS signal: GitHub stars trending upward, first external issues and PRs
- At least one public case study or write-up from an early adopter

**12-month targets:**
- 500 active projects across self-hosted and commercial deployments
- NPS ≥ 40 among primary segment (mid-size engineering teams)
- SaaS MRR covering infrastructure costs within 6 months of commercial tier launch
- 3+ documented cases of security incidents or service outages prevented
- 1+ team citing Project Vault in a formal compliance audit
- OSS community health: external contributors, community-submitted plugin(s), active discussions

### Technical Success

- **Availability:** Self-hosted reference deployment targets 99.9% uptime; commercial SaaS tier SLA defined at architecture phase
- **Secret fetch latency:** REST API secret retrieval ≤100ms p95 under reference load (to be defined at architecture phase); machine users must never be blocked by vault response time
- **Rotation success rate:** ≥99% of initiated *automated* rotations complete without human intervention (manual/assisted plugin excluded by design from this metric)
- **Drift alerts:** Fire within 5 minutes of threshold breach, zero false negatives — missing a stale credential is worse than a false positive
- **Offline fallback:** Machine users can retrieve last-known valid secret version during vault unavailability; deployments never blocked by vault downtime
- **Data integrity:** Zero secret corruption or unrecoverable data loss events; every secret version is immutable once written
- **Audit completeness:** 100% of secret access, rotation, and permission change events captured with no gaps, verified by a test harness covering edge cases (network partition during write, crash mid-rotation)

### Measurable Outcomes

| Outcome | Signal | Target |
|---|---|---|
| Replaces patchwork tooling | Teams decommission ≥1 prior tool after adoption | Qualitative, 12mo |
| Prevents incidents | Documented expiry/rotation catches pre-incident | 3+ cases, 12mo |
| Compliance enablement | Teams cite PV audit logs in security review | 1+ team, 12mo |
| Developer adoption | Dashboard as session start destination | Behavioral, ongoing |
| Machine user trust | Zero deployment failures from vault unavailability | 100%, ongoing |
| Week-1 retention | Teams active 7 days post-install | ≥60%, ongoing |
| OSS community health | External contributors, community plugins | Qualitative, 12mo |

## Product Scope

### MVP — Minimum Viable Product

The smallest version that proves the core concept: a project has a single operational home where nothing critical is missing or unknown.

**Core (must ship):**
- Secure secrets storage with versioning and RBAC
- Manual/assisted rotation plugin with per-system confirmation checklist and full audit trail
- Service, hosting, and payment records with configurable expiry alerts
- SSL/TLS certificate expiry monitoring
- Uptime and health monitoring for endpoints and services
- Project dashboard — single-pane visibility across all projects
- Multi-user support with roles and access groups
- Machine user support with scoped API keys, offline/cache fallback, deploy-time versioning
- Event triggers and notifications (email + Slack; webhooks: v1.1)
- Immutable audit logs with edge-case verified completeness
- Import from `.env` and JSON
- Project notes and description fields (full wiki: v1.1)
- Self-hosted Docker / Docker Compose deployment
- Open-source core published
- Plugin interface defined and documented (provider implementations in v2)
- Key unsealing: user chooses at initialization between master password or Shamir's Secret Sharing (N-of-M threshold)
- Built-in backup tooling: scheduled encrypted snapshots, configurable retention, restore verification, backup health alerts

**MVP success gate:** A real engineering team can migrate an existing project's credentials, services, and documentation into Project Vault within one working day, use it as their operational home for 30 days without reverting to prior tools, and at day 30 describe the experience as "I can't imagine going back."

### Growth Features (Post-MVP)

- **Extension / Hook Architecture** — versioned Extension API; founder's private, closed-source SaaS extension (in-process, trusted); auth-provider hooks (SSO/SAML/OIDC/custom) as the first extension point
- **Multi-field secrets** — field-set secret model with built-in templates (Login, Database Connection, API Key, Secure Note, Custom), per-field sensitivity/masking, field-scoped rotation
- **Internationalization & Localization** — multi-language UI support
- **Theming** — structured, non-code custom themes loaded from a designated directory
- **Third-party community extensions** (deferred within Growth — depends on the Extension API above having shipped) — sandboxed/out-of-process, permission-scoped, no default secret-value access
- Automated provider plugins: AWS (IAM, RDS, Secrets Manager), Azure, GCP, Linux/Unix SSH, Windows (WinRM), major databases (MySQL, PostgreSQL)
- Drift detection: alerts when credentials are stale or systems lag behind current secret version (fires within 5 min of threshold breach)
- AI-assisted anomaly detection: unusual access patterns, unexpected geographic access, dormant service credential alerts
- SSO/SAML integration for enterprise buyers
- Multi-tenant SaaS hosting (commercial tier)
- Advanced compliance reporting (SOC 2 evidence export, ISO 27001 control mapping)
- CI/CD native integrations (GitHub Actions, GitLab CI, Jenkins)
- Secret versioning pinned to deploy-time
- SSH CLI access mode
- Deployment automation (validated against demand post-MVP)
- Auto-unseal via cloud KMS (AWS KMS, GCP Cloud KMS)
- Customer-managed encryption keys (CMEK)
- Hardware security module (HSM) support

### Vision (Future)

Project Vault becomes the **security intelligence layer of every project** — not just storing and rotating credentials, but actively monitoring how they're used, detecting anomalies, and surfacing threats before they become incidents. The vault that sees everything becomes the system that knows when something is wrong before any human does.

Long-term: provider integration marketplace with community plugins for any system; zero trust network capabilities; formal SOC 2 Type II and ISO 27001 certifications; cross-project security intelligence for engineering managers; the operational layer installed on day one of every project, alongside version control and CI.

## User Journeys

### Journey 1 — Alex: "The Moment Everything Clicked" *(Primary User — Success Path)*

**Who:** Alex is an engineering lead at a 15-person startup. Three microservices, AWS + GCP + two bare-metal VPS. Twelve months ago, a junior engineer left — and two weeks later, a production database stopped connecting. Turned out he'd been rotating a credential manually and never told anyone the new one was only half-propagated. It took four hours to find it. Alex hasn't slept well since.

**Opening scene:** It's a Sunday afternoon. Alex is setting up Project Vault on the company VPS — `docker compose up` and it's running in eight minutes. He spends the next two hours importing credentials from their shared 1Password vault and a scattered `.env` collection. The import wizard maps fields; he fixes three naming conflicts. By 4pm, every secret their three services use is in the vault.

**Rising action:** Monday morning he adds the team. Roles are straightforward: two leads get admin, five engineers get read access to their respective services, CI/CD pipelines get machine user keys scoped to exactly what they need. He sets expiry alerts on their three SSL certs and adds the annual renewal dates for their two domains. He notices one cert expires in 23 days — he'd completely forgotten.

**Climax:** Three weeks later, Project Vault fires a notification: the AWS RDS password for the payments service is approaching its 90-day rotation policy. Alex opens the vault, starts a manual rotation. The checklist shows every service that uses the credential. He works down the list — updates the RDS instance, updates the app config, marks each step done. The old credential is retired only when all systems are confirmed. Total time: 40 minutes. No incident. No mystery.

**Resolution:** Six weeks in, Alex is asked by their CTO to demonstrate their security posture for a potential enterprise customer. He pulls up the Project Vault audit log — every access, every rotation, every permission change, timestamped and immutable. The customer's security team is satisfied. Alex realizes he hasn't thought about "what am I forgetting?" in weeks.

**Requirements revealed:** credential import, Docker self-host, RBAC with per-service scoping, machine users, expiry alerts, SSL monitoring, manual rotation checklist, audit log export.

---

### Journey 2 — Sam: "Running Six Projects Without Losing Your Mind" *(Secondary User — Indie Path)*

**Who:** Sam is a solo developer. Six active projects — two SaaS products, two client projects, two open-source tools with paid hosting. Each has its own set of API keys, database passwords, and a Stripe account. Last month, Sam's client received a "your certificate has expired" message from their users. Sam had no idea. It was embarrassing and preventable.

**Opening scene:** Sam installs Project Vault on a $6/month VPS using the single-command Docker setup. Creates six projects — one per product. Spends a Saturday afternoon moving credentials in. Some come from a personal Bitwarden export, some from `.env` files scattered in project directories.

**Rising action:** Sam sets up the dashboard as the browser homepage. Every morning, one tab opens and shows all six projects: green for healthy, amber for "expiry coming," red for "needs attention." The cert that expired last month? It's now tracked. Renewal alert set for 30 days out.

**Climax:** Two months later, Sam is mid-sprint on a new feature when a Stripe webhook key needs rotating (Stripe flagged unusual activity). Sam opens the vault, generates the new key, pastes it into the two services that use it, marks both as updated. Old key retired. Five minutes, no context switch spiral, no "wait, which service uses this again?"

**Resolution:** Sam's six projects now have one home. When a client asks "is everything up to date?", the answer isn't a mental audit — it's a screenshot of the dashboard.

**Requirements revealed:** multi-project support for single user, simple self-host setup, cross-project dashboard, expiry alerts, manual rotation with system checklist, low-friction daily use.

---

### Journey 3 — Morgan: "The 2am Incident That Wasn't" *(Primary User — Edge Case / Incident Response)*

**Who:** Morgan is a platform engineer at an 80-person company managing credentials for four internal teams. At 2:07am on a Tuesday, a monitoring alert fires: the authentication service is returning 401s. Morgan is on-call.

**Opening scene:** Morgan opens Project Vault on their phone (mobile web). Authentication service → credentials → last rotation was 6 days ago. Nothing unusual. But drift detection shows: the staging environment's copy of the auth service credential is on version 8. Production is on version 9. Someone rotated in production but forgot staging. *That's the bug.*

**Rising action:** Morgan opens the manual rotation checklist for the staging auth credential. Four systems listed. Three are already on version 9 — updated during the original rotation. One wasn't checked off: the staging auth service config. Morgan SSH's into staging, updates the credential, marks it confirmed. The 401s stop at 2:19am. Total incident duration: 12 minutes.

**Resolution:** Morgan files a post-mortem. The audit log shows exactly what happened: the original rotation had one unchecked system. Morgan adds a policy: rotations with unchecked systems cannot be marked complete without a second approver sign-off (flagged for v2).

**Requirements revealed:** drift detection, version tracking per system, mobile-accessible UI, rotation checklist with incomplete-rotation warnings, audit log for incident post-mortems, future: rotation approval gates.

---

### Journey 4 — CI-Bot: "A Deployment That Just Works" *(Machine User — API Path)*

**Who:** CI-Bot is a GitHub Actions pipeline for the payments service. It runs 40 times a day. It needs the database password, the Stripe API key, and the internal service token — exactly the current versions, nothing else.

**Opening scene:** At deploy time, CI-Bot authenticates to Project Vault using its scoped machine user API key. It requests three secrets by name. Project Vault returns the current version of each, logs the access (machine user ID, secret name, version, timestamp), and responds in 34ms. CI-Bot injects them as environment variables. Deployment proceeds.

**Rising action:** Two weeks later, a credential rotation happens. The old database password is retired. CI-Bot's next deploy requests `payments-db-password` — and receives version 12 automatically. No config change needed. No human intervention.

**Edge case:** The vault is briefly unreachable during a maintenance window. CI-Bot requests the secret — the offline fallback returns the last cached version (still valid). The deployment succeeds. An alert fires noting the fallback was used; Morgan reviews it the next morning.

**Resolution:** 40 deployments a day, zero credential-related failures. The audit log shows every machine access — which version was served, when, by which pipeline.

**Requirements revealed:** machine user API authentication, scoped permissions, secret fetch by name (always current version), sub-100ms latency, immutable audit log per access, offline/cache fallback, fallback usage alerting.

---

### Journey 5 — Dana: "Passing the Audit" *(Compliance User — Regulatory Path)*

**Who:** Dana is the security and compliance lead at a fintech company. An external SOC 2 Type II audit is scheduled for next month.

**Opening scene:** Dana needs to demonstrate access controls, evidence of least-privilege, and a complete audit trail for the past 12 months. She opens Project Vault's audit log interface, filters by date range, and exports as structured JSON and CSV.

**Rising action:** The auditor asks: "Can you show us who had access to the production database credentials, and when that access was granted or revoked?" Dana filters the audit log by credential — every access event, permission grant, and role change, timestamped and immutable. She also pulls the rotation history: the production DB password was rotated five times in 12 months, always with a complete system checklist.

**Climax:** The auditor asks: "Were there any access attempts from terminated employees?" Dana filters by user status. One terminated employee's machine user key was deactivated the same day as offboarding — confirmed in the audit log. Zero accesses after deactivation.

**Resolution:** The audit passes. Dana files two feature requests: SOC 2 control-mapped evidence export (Growth), and automatic alerts for users inactive 90+ days (Growth).

**Requirements revealed:** audit log with date/user/credential filtering, export (JSON, CSV), rotation history per credential, user deactivation with immediate key revocation, future: SOC 2 evidence export, dormant user alerts.

---

### Journey 6 — Priya: "Logging In With the Company Identity" *(Enterprise User — Hosted SaaS / Auth Extension Path)*

**Who:** Priya is an IT admin at a 200-person company that just signed up for Project Vault's hosted SaaS tier. Company policy requires every tool to authenticate through their existing SSO provider — no separate passwords for engineers to manage or for Priya to audit.

**Opening scene:** Priya opens her Project Vault Cloud organization settings and looks for an SSO option. It's there — she's not expecting to find it in a self-hosted deployment, because it isn't: this is a hosted-SaaS-only capability, delivered through Project Vault's private extension rather than the open-source core.

**Rising action:** Priya connects the company's identity provider. She tests with her own account: logging in redirects to the company's SSO login, authenticates, and lands her back in Project Vault already signed in. She invites the rest of the IT team — each teammate logs in with their existing corporate identity, no new password created.

**Climax:** Three months later, an engineer leaves the company. Priya deactivates the account in the corporate identity provider, as she always does. She doesn't have to remember to also revoke it in Project Vault — the connected identity provider is the source of truth, and the next login attempt fails at the identity provider itself. She checks the Project Vault audit log to confirm: no access since deactivation.

**Resolution:** Priya never has to think about Project Vault as a separate identity system. It behaves like every other SSO-connected tool the company uses — while the local email/password + MFA path she doesn't need still works underneath it, unaffected, for the OSS self-hosted teams who don't have an identity provider to connect.

**Requirements revealed:** external authentication provider hooks (SSO/SAML/OIDC), built-in local/MFA auth remaining available as fallback regardless of extensions installed, hosted-SaaS-only capability delivered via extension rather than core.

---

### Journey 7 — Jordan: "Building the Integration Nobody Else Needed" *(Self-Hosted Power User — Community Extension Path — ASPIRATIONAL, FUTURE PHASE)*

**⚠️ Scope note (added on review):** this journey depicts the *target* community-extension experience once sandboxing ships (FR116 — see Extension & Plugin Architecture) — it is explicitly **not** what the Extension Architecture epic builds now. This phase's loader only accepts one exact, pinned package identity (the founder's own); there is no general install pathway, no permission-scope approval screen, and no official/unverified distinction yet, because the sandboxing infrastructure this journey depends on doesn't exist yet (see Domain-Specific Requirements → Technical Constraints and the Roadmap's Phase 4 community-extension entry). Keep this journey as forward-looking product vision, not a source of acceptance criteria for the current epic.

**Who:** Jordan runs a self-hosted Project Vault instance for a five-person agency. Their internal ticketing tool has no reason to exist as a Project Vault feature — but Jordan wants a notification to land there whenever a credential is 5 days from expiring, instead of relying on email.

**Opening scene:** Jordan reads the published Extension API documentation and writes a small extension that registers a notification-channel hook, posting a message to the ticketing tool's webhook whenever an expiry alert fires. No core code was touched — the extension is a separate package, installed by pointing Project Vault at it.

**Rising action:** Before it activates, Project Vault shows Jordan the extension's declared permission scopes — notification events only, no secret-value access — and requires explicit approval. Jordan approves, the extension registers, and the next expiry alert shows up in the ticketing tool within a minute.

**Edge case:** A teammate later tries to install a similar-looking extension downloaded from a forum post. Project Vault flags it as unverified third-party code, requiring a separate acknowledgment before it can even declare permissions — and the declared scopes include a request for secret-value access the notification use case doesn't need. Seeing the scope mismatch on the approval screen, the teammate cancels the install.

**Resolution:** Jordan's extension runs in its own sandboxed process — a bug in it can't touch the vault's stored secrets. Project Vault stays fully functional with or without it installed; Jordan removes it during a slow week without anything else in the product noticing.

**Requirements revealed:** third-party community extensions (sandboxed, out-of-process), manifest-declared permission scopes with no default secret-value access, explicit admin approval before activation, official/signed vs. unverified-community distinction, system remains fully functional with zero extensions installed.

---

### Journey 8 — Amara: "A Vault That Speaks the Team's Language" *(International Team — i18n & Theming Path)*

**Who:** Amara leads a twelve-person engineering team in Lyon. Most of her engineers are comfortable in English for code, but the team's ops lead — who checks Project Vault daily for expiry alerts and rotation status, not code — is far faster and makes fewer mistakes reading it in French.

**Opening scene:** Amara sets the organization's default locale to French for newly invited users. The ops lead's next login renders the dashboard, alert text, and notification emails in French; the credential names and technical values are untouched, exactly as expected.

**Rising action:** Two new hires join from the Lisbon office. Portuguese isn't in the list of supported locales yet — but rather than seeing broken text or blank labels, their UI falls back cleanly to English wherever a Portuguese translation doesn't exist, section by section, not as an all-or-nothing switch.

**Climax:** Separately, Amara's design lead asks if the login screen can carry the company's own colors and logo instead of Project Vault's default look, since the agency demos this to clients. Amara drops a structured theme definition — tokens and asset references, no code — into the instance's configured theme directory and restarts nothing; the new theme shows up as a selectable option immediately.

**Resolution:** The product feels like it belongs to the team, in the language they think in and the visual identity they present to clients — without anyone touching a line of Project Vault's source.

**Requirements revealed:** user-selectable display language, organization default locale for new users, graceful per-string fallback to English for untranslated content, structured non-code theme installation from a designated directory, runtime theme switching with no rebuild.

---

### Journey 9 — Noah: "One Login, Three Things to Remember" *(Everyday User — Multi-Field Secrets Path)*

**Who:** Noah manages a project's monitoring stack. The Grafana admin login isn't just a password — it's a username, a password, and a TOTP recovery code, and until now he's been splitting it across three separate single-value secrets with awkward names like `grafana-admin-user` and `grafana-admin-pw`.

**Opening scene:** Noah creates a new secret using the built-in Login template. It prompts for username and password as named fields instead of one opaque value; he adds a third custom field for the recovery code and marks it masked, same as the password.

**Rising action:** In the credential list, the username shows in plain view — useful for a quick glance — while the password and recovery code stay masked until Noah explicitly reveals them. Each reveal is logged separately: the audit trail shows exactly which field was viewed and when, not just "the secret was accessed."

**Climax:** Three months later, a routine security review requires rotating the Grafana password but not the username or recovery code. Noah starts a rotation and selects only the password field. The checklist tracks just that field's propagation; when it's confirmed, Project Vault creates a new version with the updated password and the username and recovery code carried forward unchanged.

**Resolution:** Noah's old single-value secrets from before this capability shipped still work exactly as they did — each is just a one-field secret under the hood, no migration, no broken links, no re-import.

**Requirements revealed:** multi-field secrets with built-in templates, per-field sensitivity/masking, field-level reveal audit logging, field-scoped rotation within a whole-secret version model, full backward compatibility with pre-existing single-value secrets.

---

### Journey Requirements Summary

| Journey | Capabilities Revealed |
|---|---|
| Alex (success path) | Import, RBAC, machine users, expiry alerts, SSL monitoring, manual rotation checklist, audit log |
| Sam (indie path) | Multi-project dashboard, simple self-host, cross-project visibility, low-friction daily use |
| Morgan (incident response) | Drift detection, version tracking per system, mobile UI, incomplete-rotation warnings, post-mortem audit trail |
| CI-Bot (machine user) | Machine API auth, scoped permissions, sub-100ms fetch, offline fallback, fallback alerting |
| Dana (compliance) | Audit log filtering/export, rotation history, user deactivation, future: SOC 2 evidence export |
| Priya (hosted SaaS / auth extension) | External auth provider hooks (SSO/SAML/OIDC), built-in auth as fallback, hosted-SaaS-only capability via extension |
| Jordan (community extension) | Sandboxed third-party extensions, permission-scoped manifest, explicit approval, no default secret-value access, official/unverified distinction |
| Amara (i18n & theming) | User/org locale selection, per-string English fallback, structured non-code themes, runtime theme switching |
| Noah (multi-field secrets) | Field-set secrets with templates, per-field masking, field-level reveal audit, field-scoped rotation, backward compatibility |

## Domain-Specific Requirements

### Compliance & Regulatory

- **SOC 2 Type II** — primary enterprise certification target; audit logs, RBAC, and rotation history map directly to CC6 (Logical and Physical Access), CC7 (System Operations), and CC8 (Change Management) controls. Structured for SOC 2 evidence collection from v1; formal certification post-launch.
- **ISO 27001** — information security management standard; relevant controls: A.9 (Access Control), A.12 (Operations Security), A.16 (Incident Management). Design aligns with these from v1.
- **GDPR** — user identity data and access logs may contain personal identifiers for EU customers. Self-hosted deployment largely addresses data residency. SaaS tier (v2) must offer regional deployment options and define data residency clearly.
- **PCI-DSS adjacency** — customers storing payment processor credentials (Stripe, etc.) have their own PCI-DSS obligations. Project Vault must not impede customer compliance; audit trails and access controls support it without requiring PCI certification of the platform itself.

### Technical Constraints

- **Encryption at rest:** AES-256 minimum for all stored secrets and credentials
- **Encryption in transit:** TLS 1.3 required for all inbound API and UI connections; TLS 1.2 minimum / 1.3 preferred for outbound plugin connections to target systems
- **Key unsealing — user's choice at initialization:**
  - *Option A: Master password* — single administrator password unseals the vault on startup; simplest, suitable for small teams
  - *Option B: Shamir's Secret Sharing* — root key is split into N shares distributed among M admins; vault requires a threshold of M shares to unseal; no single person can unseal alone; suitable for security-conscious teams
  - Auto-unseal via cloud KMS (AWS, GCP) is a Growth feature
- **Immutable audit logs (v1):** Append-only storage with file-level checksum verification; v1 simplification intentional. Full tamper-evident hash chaining deferred to v2. Logs must be verifiable and exportable.
- **External log shipping (open tier):** Webhook/export capability for shipping logs to external write-once sinks (S3 Object Lock, WORM storage) available in open tier. Pre-built sink integrations (Splunk, Datadog) are commercial Growth features.
- **Built-in backup tooling (v1):** Scheduled encrypted snapshots of vault state; configurable retention policy; restore verification tooling; backup health alerts. Backup encryption key derived from the same unsealing ceremony (master password or Shamir shares) — never stored server-side independently.
- **Plugin security boundary:** v1 ships manual/assisted plugin only (no external system connections); full container-level sandboxing with seccomp profiles applies when external-connecting plugins ship in v2. Plugin SDK published in v1 documents the v2 sandboxing model so community plugins are written sandbox-compatible.
- **Extension API boundary (general-purpose, distinct from the rotation plugin system above):** the core publishes a versioned Extension API package with typed registration entrypoints for defined extension points (authentication provider, notification channel, UI panel). Extension-point contract changes are backward-compatible for at least one minor release cycle; the core performs startup capability-negotiation against a declared semver range and fails loudly, not silently, on an incompatible extension. No core code path may special-case or hard-import a specific extension implementation — the system must run fully functional with zero extension packages present, as a supported and tested configuration.
- **Extension trust boundary is provenance-based, not self-declared:** the founder's own first-party extension (used to build the private SaaS tier) runs in-process and trusted. Third-party community extensions installed by self-hosting admins run in a sandboxed, out-of-process execution environment (reusing the rotation-plugin isolation tiers above), require a manifest declaring capability scopes, require explicit admin approval before activation, and have no default access to decrypted secret values — narrowly-scoped secret-value access requires an explicit, distinct grant. An extension cannot elevate its own trust tier by claiming to be first-party; the loader enforces this by extension origin, not by manifest content. Community extension support is scoped to a later phase (see Product Scope); the trust boundary is specified now so the architecture isn't retrofitted.
- **Offline cache encryption:** Machine user offline/cache fallback stores secrets encrypted-at-rest using the machine user's scoped key; only the in-use decrypted value is zeroed from memory after use. Encrypted cache persists for fallback availability.
- **Memory security:** Decrypted secret values zeroed from memory immediately after use; no plaintext secret caching in application memory beyond minimum necessary lifetime.
- **Rate limiting & brute force protection:** Exponential backoff after N failed auth attempts; IP-based rate limiting on all authentication endpoints including vault unsealing; alerting on repeated failures; configurable lockout policy.
- **JWT security:** Two distinct token lifetimes: web session JWTs (≤15 minutes TTL, human users, refresh via session); machine user token-exchange JWTs (≤1h TTL, refresh via API key). Both have token revocation endpoints; revocation list checked on each request. Machine user API keys minimum 128-bit entropy with zero-downtime rotation support.
- **Machine user bootstrap (secret zero):** One-time enrollment tokens invalidated after first use for initial machine user API key provisioning; instance metadata service support (AWS IMDSv2, GCP) as Growth feature.
- **Cryptographic agility:** Encryption scheme is versioned in storage format; migration path to new algorithms defined and documented; re-encryption migration tooling ships alongside any algorithm deprecation.
- **Master key rotation:** Vault master encryption key rotation procedure documented; supported without vault downtime; rotation event logged separately in admin audit trail.
- **Constant-time operations:** All secret/token comparison operations use constant-time algorithms to prevent timing oracle attacks.
- **Secret size limits:** Maximum secret size enforced at API layer (64KB default, configurable); prevents memory pressure and storage DoS.
- **Dependency supply chain:** Production dependencies pinned with hash verification; automated vulnerability scanning in CI pipeline; SBOM (Software Bill of Materials) published with each release.
- **GDPR compliance:** Audit logs pseudonymized using user IDs rather than personal identifiers; documented erasure exception process for regulatory right-to-erasure requests against immutable log entries.
- **Vault configuration change management:** Administrative actions on vault configuration (key unsealing policy, plugin permissions, RBAC structure) logged in a separate admin audit trail; defined approval process for security-critical configuration changes.
- **Concurrent session limits:** Configurable maximum concurrent sessions per user role; prevents credential sharing via shared session tokens.
- **SSRF protection:** Webhook URLs validated against blocklist (RFC 1918, localhost, link-local, metadata service endpoints); allowlist option for organizations with internal webhook targets.
- **Shamir share distribution:** Secret shares distributed via encrypted, out-of-band mechanism; shares never stored server-side; share transmission encrypted; ceremony documented in deployment guide.

### Integration Requirements

- Docker / Docker Compose for self-hosted deployment (single-command target)
- REST API with API key + short-lived JWT (≤15 min TTL) for machine user authentication
- Webhook delivery for triggers and notifications with retry, dead-letter queue, and SSRF protection
- Import: `.env`, JSON (v1); future: 1Password, Bitwarden, Doppler export formats
- Plugin SDK: standardized interface for building provider integrations, published with v1 core, documents v2 sandboxing model
- External log shipping: webhook/export interface for write-once log sinks (open tier)

### Risk Mitigations

| Risk | Mitigation |
|---|---|
| Master key compromise | Shamir's Secret Sharing at init; hardware token support (Growth); master key rotation procedure |
| Insider threat | Immutable audit logs; separate admin audit trail; dual-approval for sensitive rotations (Growth) |
| Plugin supply chain attack | Sandboxed execution (v2); signed plugin manifests; explicit user approval for updates; no silent auto-updates |
| Vault unavailability blocking deployments | Offline/cache fallback (encrypted-at-rest); fallback usage alerting |
| Backup failure | Built-in tooling with restore verification, health alerts; backup key from unsealing ceremony |
| Self-hosted misconfiguration | Hardened defaults; security checklist on first-run wizard |
| Data residency violation (SaaS) | Regional deployment options; customer data stays in selected region (v2) |
| Secret zero bootstrap | One-time enrollment tokens; Shamir ceremony documented; shares never stored server-side |
| Webhook SSRF | URL validation against RFC 1918 / localhost / metadata service blocklist |
| Cryptographic deprecation | Versioned encryption scheme; migration tooling ships with algorithm changes |
| Memory exposure | Secrets zeroed from RAM after use; offline cache encrypted-at-rest only |
| Audit log exhaustion (DoS) | Per-user rate limits on secret fetch; log storage monitoring and alerts |
| Timing attacks | Constant-time comparison for all secret/token operations |
| Backup key circular dependency | Backup key derived from unsealing ceremony; never stored independently |
| Competing hosted fork | AGPLv3 network-copyleft requires a forked competitor to disclose their modified source to their users — deters uncompensated competition without legally blocking it; see Licensing & Contribution Model |
| Log integrity (external verification) | External log shipping to write-once sink; open tier capability |

## Innovation & Novel Patterns

### Detected Innovation Areas

**Primary Innovation: The Project as the Unit of Truth**

Every secrets manager built since 2015 has assumed the *environment* is the organizing unit — dev, staging, prod. That assumption is so deeply embedded it shapes data models, RBAC systems, APIs, and documentation across the entire industry. No one has questioned it because it came from a reasonable place: different environments have different secrets.

But engineers don't think in environments. They think in projects. A "payments project" contains dev + staging + prod *and* its Stripe API keys, its SSL certificate, its domain renewal date, its RDS password, its deployment runbook, its uptime monitor, and its service documentation. All of that belongs together. No existing tool holds it together because none of them were built with the project as the organizing primitive.

This is not a UI reorganization. It requires a different data model, a different RBAC model (permissions scoped to projects, not environments), and a different mental model for users. Environment-centric tools cannot bolt on project-centric organization — the foundational architecture works against it. Importantly: engineers think in environments *because their tools forced them to*. Given a better mental model, they adapt quickly.

**The architectural distinction that matters:** Competitors can add a "Projects" grouping layer on top of environment-centric data models — cosmetic, not architectural. Project Vault has no environment layer. Projects are the foundation. That distinction must be visible in the product, not just claimed in positioning.

**Secondary Innovations:**
- **Operational scope expansion** — first tool to combine secrets, certs, domains, payments, uptime, and documentation under one project context
- **Confirmed rotation model** — rotation is not complete until every dependent system acknowledges the update; shifts burden of confirmation from human to system
- **Security intelligence destination** — vault's complete visibility into project access patterns creates the foundation for anomaly detection (Growth/Vision)
- **Shamir's Secret Sharing as first-class UX** — enterprise-grade key security as a simple init-time choice for teams of any size
- **Project-as-identity for RBAC (v2)** — permissions granted to projects; humans inherit through membership; offboarding revokes all inherited access automatically
- **Credential subscription model (v2)** — one project owns a credential, others subscribe; owning project manages rotation; handles shared infrastructure without breaking project-ownership principles

### Market Context & Competitive Landscape

The secrets management market is organized around environment-centric tools (HashiCorp Vault, Infisical, Doppler) and cloud-provider-native tools (AWS Secrets Manager, Azure Key Vault). No player has claimed the project-centric position.

The closest competitor is Infisical — open-source, modern UX, growing fast — but its data model is environment-centric. A "Projects" grouping layer can be shipped in a sprint. True project-centric RBAC, operational metadata as first-class objects, and project-scoped audit trails require rebuilding the data model — a 12–18 month effort for an existing product with customers.

**Adjacent unexplored use case:** Agencies, consultants, and freelancers running client projects have the identical operational problem. A "project handoff export" (portable package of credentials, documentation, and runbooks) is a natural v2 feature that expands TAM without changing the core product.

### Validation Approach

**How to know the paradigm is resonating (not just being tolerated):**
- **Behavioral:** Users start interactions from the project view, not the credential view; project dashboard is primary session entry point within week 1
- **Onboarding:** Users create a project before adding their first credential without being forced to; project container feels natural
- **Language:** Users describe Project Vault as "our project dashboard" not "our secrets manager" in open-text NPS responses
- **Comparison:** Users from environment-centric tools report "feels like how I actually think" rather than "feels like a workaround"

**Critical v1 requirement — "What is a project?" onboarding wizard:**
Must ship as an interactive guided setup, not a text screen. Engineers trained on environment-centric tools have deep muscle memory. The paradigm shift requires active re-education in the first 60 seconds. The wizard must walk through adding a first real project with real credentials and explicitly explain: "A project is everything for one product — not one environment. Add all your environments, services, and credentials for this product here."

**Onboarding wizard acceptance criterion:** ≥80% of first-time users (tested pre-launch with 5+ participants) correctly place a second credential into the right project without prompting after completing the wizard. Any result below this threshold triggers a redesign before launch — not a post-launch fix.

**Machine user onboarding acceptance criterion:** A developer with no prior Project Vault experience can complete API key creation, first secret retrieval, and offline fallback verification within 15 minutes using only the published documentation, with ≥95% success rate in pre-launch developer testing.

**Fallback:** If paradigm isn't resonating by week 4 (retention below 60%), ship project-type starter templates (web app, microservice, API) that pre-populate structure and show what a well-organized project looks like.

### Data Model Considerations (v1 design, v2+ features)

The following patterns should be designed into the v1 data model even if features ship later — retrofitting these requires painful migrations:
- **Project grouping/workspaces** — parent container for related projects ("payments initiative" contains payments API + billing + fraud detection projects)
- **Project lifecycle states** — Active → Maintenance → Deprecated → Archived, each with different rotation policies and access behaviors
- **Project ownership and transfer** — projects have an owner; ownership transition workflow triggers on departure; enables agency/consultant handoff export
- **Credential subscription** — credential owned by one project, subscribed to by others; enabling shared infrastructure management
- **Environment as attribute** — environments as tags/attributes on credentials within a project, never as structural organizing layers
- **Field-set secrets** — a secret's content is an ordered set of named fields (not a single opaque value), with a small set of built-in templates (Login, Database Connection, API Key, Secure Note, Custom) as UI/validation scaffolding over uniform underlying storage; existing single-value secrets are a one-field case of this model, requiring no migration

### Risk Mitigation

| Innovation Risk | Mitigation |
|---|---|
| Competitor copies surface ("Projects" tab) | Architectural distinction must be visible in product; operational scope + confirmed rotation are proof points competitors can't quickly replicate |
| Mental model friction — env-centric muscle memory | Interactive "what is a project?" onboarding wizard is must-ship; user-test before launch; don't wait for retention data to fix it |
| Category confusion — "better secrets manager?" | Own "Project Operations Platform / ProjOps" label consistently; positioning emphasizes new category, not better incumbent |
| Paradigm not resonating by week 4 | Starter templates as fallback; structured user interviews in first month |
| Consultant/agency use case dilutes v1 focus | Natural v2 expansion; design data model for project transferability now; don't build the feature in v1 |
| Data model migration pain in v2 | Two-week v1 investment in forward-compatible data model (workspaces, subscriptions, lifecycle) saves 6-month migration later |
| Open questions (revisit post-launch) | Long-term competitive moat beyond first-mover; whether environment sub-organization within projects is needed for larger teams |

The architectural and market bets above inform concrete platform requirements. The following section specifies how Project Vault must be built to carry them out.

## Infrastructure Platform Specific Requirements

### Project-Type Overview

Project Vault is a **hybrid saas_b2b + api_backend** platform: a multi-tenant, RBAC-governed, compliance-forward project operations platform delivered as a self-hostable web application with a REST API-first architecture. The platform organizes around *projects* rather than environments, making it structurally distinct from conventional secrets managers.

Two deployment paths: self-hosted (Docker, single or multi-org) and SaaS (v2, isolated instances per customer). Machine users are first-class API consumers alongside human users.

---

### Tenant Model

**Self-hosted:**
- Default configuration: single-organization
- Optional: multi-organization/workspace support within one instance (configurable at install or post-install by platform admin)
- **Org-aware schema from day one** — every entity (secrets, projects, audit logs, users) carries `org_id` at the schema level. Single-org mode suppresses org management UI; schema is unchanged. V1 architectural requirement, not optional.
- **Tenant isolation enforced at query level** — every database query scoped by `org_id`. Application-layer-only isolation is insufficient and constitutes a data leak risk.
- Organizations are fully isolated — no cross-org data access

**SaaS (v2):**
- Isolated instance per customer — no shared database or compute
- Data residency addressed in v2 SaaS architecture

**Data residency (v1):**
- For self-hosted customers: inherent — customer controls their own infrastructure
- GDPR and HIPAA data residency obligations rest with the customer; Project Vault provides the controls (encryption, export, deletion) they need to meet those obligations

---

### RBAC / Permission Model

**Role Hierarchy (project-scoped):**

| Role | Capabilities |
|---|---|
| **Owner** | Full control; can delete project, transfer ownership, manage billing |
| **Admin** | Full operational control; manage members, credentials, rotation schedules, integrations |
| **Member** | Read/write credentials and operational data; can trigger rotations |
| **Viewer** | Read-only; cannot trigger rotations or manage members |

**Scope rules:**
- Permissions are **project-scoped**: each user has a role per project
- A user can hold different roles across different projects
- No sub-credential permission granularity in v1 — access is determined by project membership and role
- Machine users are assigned project roles identically to human users; audit trail flows from their identity
- A platform-level **Organization Admin** role exists for user/org management, separate from project roles
- Users must be explicitly invited to or own a project; no project is accessible without explicit membership

---

### Subscription Tiers

Tier gates (v1 definition — exact values to be finalized during pricing validation):

| Gate | Solo | Indie | Small Company | Team |
|---|---|---|---|---|
| Projects | 1 | Unlimited | Unlimited | Unlimited |
| Users | 1 | 2 | ~10 | ~50+ |
| Secrets | Limited | Higher limit | Higher | Unlimited |
| Audit log retention | 30 days | 90 days | 1 year | Configurable |

Additional gates may be added as pricing is validated (rotation frequency, API rate limits, priority support, advanced RBAC features).

---

### Auth Model

**Human users:**
- v1: Local authentication (email/password) with secure session management
- v2: SSO/SAML (explicitly deferred as a built-in core feature — see Extension / Hook Architecture below for the pluggable-auth-provider path, which is how SSO/SAML/OIDC reaches production without becoming core scope)
- **MFA: Required in v1.** TOTP minimum. Enforcement policy: MFA available to all users; for Team and Small Company tiers, Owners and Admins must have MFA enabled before inviting members. Solo/Indie: strongly encouraged, not enforced.
- **Account recovery — explicit security model:**
  - Recovery codes issued at MFA enrollment (one-time, downloadable); this is the primary recovery path
  - Lost-device recovery (no codes): requires **two Organization Admins to independently confirm** the recovery request — a single-admin override is insufficient as a compromised admin account must not be enough to bypass MFA. If the org has only one admin, a time-delayed recovery with a 24-hour notification window is used instead (legitimate user can cancel; attacker window is limited)
  - Email-only verification is explicitly **not** sufficient for account recovery — email is weaker than TOTP and would make vault security bounded by email provider security
  - No "support resets it" path — recovery is entirely self-service or org-admin governed

**Machine users:**
- **API Keys:** Long-lived, project+role scoped, revocable; primary method for CI/CD pipelines and persistent services
- **Short-lived tokens:** JWT/OIDC-style; issued via token exchange; appropriate for ephemeral workloads (serverless, short-lived containers)
- Both carry machine user identity into audit logs

**Offline / Availability Fallback — by environment type:**

Fallback strategy is split by deployment context, since ephemeral environments (containers, serverless, CI runners) have no persistent disk:

| Environment | Fallback Strategy |
|---|---|
| Persistent services (VPS, long-running Docker) | Encrypted local fallback file (AES-256, key derived from machine user credential via KDF) |
| Ephemeral workloads (Kubernetes pods, Lambda, CI runners) | In-process memory cache for the lifetime of the process/job; no file written to disk |
| Sidecar pattern | Optional: a vault-agent sidecar in Kubernetes that holds a short-lived in-memory cache and proxies secret requests for co-located containers |

**Fallback rules (all environments):**
- **Scope controls:** Fallback eligibility is configurable per-secret; high-sensitivity secrets can be explicitly excluded
- **Key derivation — DECIDED: Option B (Vault-assisted KDF)**

  The fallback cache encryption key is derived with vault participation — the vault seeds the KDF on first connection; subsequent offline access uses the derived key. The vault never needs to be reachable again until the cache TTL expires or is explicitly invalidated.

  | Option | Security | Availability | Notes |
  |---|---|---|---|
  | **A — Pure offline KDF** | Lower (offline-crackable with API key on same machine) | Full (no vault needed) | Not selected |
  | **✅ B — Vault-assisted KDF** | Higher (offline crack impossible without vault) | Requires vault reachability to first seed cache | **Selected for v1** |
  | **C — Hardware-backed (where available)** | Highest | Full | TPM/Secure Enclave; deferred to future version |

  *Decision rationale: Option B provides meaningfully stronger security (offline crack requires compromising the vault, not just the local machine) at the cost of requiring vault reachability on first deployment. This trade-off is acceptable — machines that have never reached the vault have no business using a fallback. Option A remains available as a documented downgrade path for environments with strict network isolation requirements.*

- **TTL:** Short default (e.g., 4–24 hours, configurable); maximum TTL capped per tier
- **Rotation grace period awareness:** Fallback cache honors the credential grace period during rotation — old credential remains valid until grace period expires, preventing outages during the rotation window
- Cache invalidated on next successful vault connection
- Fallback access events captured in audit logs

---

### Encryption & Key Management

- Encryption at rest for all secrets: AES-256 minimum
- TLS 1.2+ enforced in transit
- **Master key architecture (v1):** Server-side key derived from a host secret (environment variable or mounted secret on the Docker host) using a strong KDF. The vault's security model has an **explicit dependency on the host's security posture** — documented in deployment guides and compliance artifacts so auditors understand the trust boundary.
- **Customer-managed keys (CMK):** Design intent for v2. The v1 encryption layer must be abstracted such that swapping the key source does not require re-encrypting all data. CMK migration path must not be closed off by v1 implementation choices.
- **Fallback cache key derivation:** Derived from machine user identity credential — not a separately managed secret.

---

### API Architecture

- REST API is the **primary interface** — all web UI functionality is API-backed; no privileged UI-only operations
- Versioned from day one (`/api/v1/`)
- JSON throughout (request/response)
- OpenAPI/Swagger spec published with the open-source release
- **Rate limiting:**
  - Enforced per machine user identity — separate pool from human users, preventing pipeline activity from starving interactive users
  - Limits vary by subscription tier
  - **CI/CD burst use case is an explicit design input:** monorepo with N microservices pulling secrets at pipeline start must be accommodated within tier limits
  - **GitHub Actions and GitLab CI integrations must implement exponential backoff with jitter** on 429 responses — hard failure on rate limit is not acceptable
- No official SDK in v1 — OpenAPI spec enables community SDK generation
- CLI planned post-MVP

---

### Extension / Hook Architecture

*General-purpose extensibility — distinct from the rotation plugin system in the next section, which is scoped only to credential propagation.*

- The core publishes a versioned `@project-vault/extension-api` package: typed registration interfaces for defined extension points (authentication provider, notification channel, UI panel), plus a `registerExtension()` bootstrap entrypoint.
- **Mechanism:** code-based registration API (Fastify decorator/hook style, comparable to `fastify.register()` and Passport.js's `.use(strategy)`), not a declarative manifest-as-mechanism. A thin manifest carries identity and a semver capability range only, used for startup compatibility negotiation — not for wiring hooks.
- **Loading:** the core conditionally imports a configured extension package (env-gated) at startup if present. Absence of any extension package is a supported, tested configuration — the OSS core is never crippled by the extension system's existence.
- **Two audiences, two trust tiers (see Domain-Specific Requirements → Technical Constraints for the full trust boundary):**
  - The founder's own private, closed-source SaaS extension — in-process, trusted, deployed only on infrastructure the founder controls, never distributed to self-hosters.
  - Third-party community extensions built by self-hosters for their own instances — out-of-process/sandboxed, permission-scoped, no default secret-value access. **Scoped to a later phase** (see Product Scope); the extension-point API and trust boundary are specified now so this isn't retrofitted.
- **Auth hooks are the first concrete extension point:** an extension can register one or more external authentication provider strategies (SSO/SAML/OIDC/custom) that participate in the auth flow via Fastify's request hook chain, alongside the built-in local/MFA strategy, which remains available as fallback regardless of which extensions are installed.
- **Licensing note:** this architecture is what makes the AGPLv3 open-core model work — see Licensing & Contribution Model below.

---

### Theming

- Core ships one base theme.
- Additional themes are structured definitions (JSON/YAML tokens + asset references, not CSS-only) loaded at runtime from a designated, non-tracked directory/config path — installing a theme never requires modifying application code or rebuilding the application.
- Administrators select the active theme from the base theme plus any installed custom themes.

---

### Licensing & Contribution Model

- **Core license: AGPLv3** — OSI-approved, freely self-hostable and modifiable. As sole copyright holder, the founder is not bound by the core's own license for his own use, which is what permits the in-process, closed-source private SaaS extension described above without a disclosure obligation.
- **AGPLv3's network-use clause is the deterrent mechanism, not a legal block:** a third party who forks the core and hosts a competing paid service must disclose the complete source of *their modified version* to users interacting with it over a network. This does not prevent competition; it prevents a competitor from quietly building proprietary features on top of the OSS core without contributing back.
- **External contributions require a CLA** (not a bare DCO): a Contributor License Agreement that keeps the outbound project AGPLv3 while separately granting the founder rights to use each contribution in the closed-source SaaS extension. The dual-use intent is disclosed transparently in the CLA text.
- **Self-hosted community extensions and AGPL scope:** extensions communicating with core only through the versioned Extension API (a defined, arm's-length interface) are architecturally positioned as separate works, not derivatives of the AGPL core — this is the same boundary that lets community extensions exist without forcing every self-hoster's custom extension to be AGPL-licensed.
- **Not legal advice.** A real IP/open-source licensing attorney must review the CLA text and the extension-API architecture before launch.

---

### Plugin Architecture & Rotation

*Rotation-specific — see Extension / Hook Architecture above for the general-purpose extension system.*

**v1:**
- Plugin interface defined and published (open to community)
- Manual/assisted rotation plugin ships in v1: generates a step-by-step per-system checklist, user confirms each update, old credential retired only when all systems confirmed — full audit trail
- **At least one automated rotation plugin ships in v1** to validate the plugin architecture with a real implementation and deliver the automated rotation aha moment. Target: a common self-hosted or cloud-agnostic provider (e.g., environment variable injection for a modern deployment platform, or database password rotation for PostgreSQL/MySQL). Exact target to be decided during technical planning.

**Plugin trust model (v1 architectural requirement):**
- **Runtime permissions:** Plugins access only the specific credentials for which a rotation is executing — not the full secret store. Least privilege enforced at the plugin API boundary.
- **Plugin sandboxing:** v1 minimum: plugins run as separate processes (not in-process), limiting blast radius of a malicious plugin. Full sandboxing (WASM, containers) is a v2 hardening target.
- **Plugin registry:** Official plugins (Vault-maintained) are signed and verified. Community plugins require explicit user acknowledgment that they are unverified third-party code. No silent installation of unsigned plugins.
- **Plugin manifest:** Each plugin declares its required permissions at install time; users must approve the permission set before activation.

**v2:**
- Full provider plugin library: AWS (IAM, RDS, Secrets Manager), Azure, GCP, Linux/Unix (SSH), Windows (WinRM), major databases
- Plugin interface is public/open — community plugins supported
- Full container-level sandboxing with seccomp profiles

---

### Integration List (v1)

| Integration | Type | Notes |
|---|---|---|
| Webhook (outbound) | Trigger/notification | See security requirements below |
| Email | Notification | Expiry alerts, rotation confirmations, access events |
| Slack | Notification | Webhook or app integration for alerts and rotation events |
| GitHub Actions | Native CI/CD | Official Action; retry/backoff on rate limits; in-process memory cache for ephemeral environments |
| GitLab CI | Native CI/CD | Official component/include; same retry/backoff and caching requirements as GitHub Actions. Excluding GitLab CI in v1 explicitly excludes ~30% of the market, particularly enterprise and regulated environments. |
| `.env` import | Data ingestion | Bulk import from .env files |
| JSON import | Data ingestion | Bulk import from JSON credential exports |
| Doppler import | Migration | v1 or fast-follow; export-compatible import |
| Infisical import | Migration | v1 or fast-follow |
| HashiCorp Vault import | Migration | Fast-follow; KV secrets via API |
| AWS Secrets Manager import | Migration | Fast-follow |
| Manual/assisted rotation plugin | Rotation | Step-by-step checklist with per-system confirmation and audit trail |
| At least one automated rotation plugin | Rotation | See Plugin Architecture section |

**Migration path rationale:** The aha moment only lands after real credentials are loaded. Teams on competitor tools must have a viable migration path or adoption stalls before value is discovered. Doppler and Infisical import are highest priority given user overlap.

**Webhook security requirements (v1):**
- **SSRF protection:** Webhook target URLs validated against a blocklist of private IP ranges (RFC 1918), localhost, loopback, and cloud metadata endpoints (e.g., `169.254.169.254`). Users cannot point webhooks at internal infrastructure.
- **No secret values in payloads:** Webhook payloads contain event metadata only (event type, project ID, timestamp, resource reference). Secret values are never included in webhook bodies. Receiving systems must call back to the vault API with proper authentication to retrieve values.
- **HMAC payload signing:** All webhook payloads are signed with HMAC-SHA256 using a per-webhook secret. Receiving servers can verify payload authenticity. Signature verification documented in webhook setup UI.

**Import endpoint security requirements (v1):**
- **Import endpoints never log request bodies.** Secret values transit in memory only during import. This is an explicit stated requirement — not an implementation assumption. Must be enforced in code review and verified in security audit.
- Import operations are captured in audit logs (who imported, when, how many secrets, source format) — the values themselves are never written to any log.

---

### Compliance Requirements

**Standards to design for in v1** (certifications pursued post-launch):

| Standard | Scope | Notes |
|---|---|---|
| **SOC 2 Type II** | Audit logging, access controls, encryption, availability | Core design target |
| **ISO 27001** | InfoSec management; access control, cryptography, incident management | Core design target |
| **GDPR** | Data residency (self-hosted inherent); right to erasure; data processing controls | v1 controls; DPA for SaaS v2 |
| **HIPAA** | PHI-adjacent controls; encryption, audit, access control | BAA capability for SaaS v2; self-hosted customers own their compliance |

**Tiered security posture — v1 ships honestly, not aspirationally:**

| Level | What it means | v1 status |
|---|---|---|
| **Delivers** | Ships and is true | AES-256 at rest, TLS in transit, RBAC, MFA, comprehensive audit logging, query-level tenant isolation, org-aware schema, GDPR pseudonymization |
| **Designed for** | Architecture supports; not yet externally certified | SOC 2, ISO 27001, HIPAA, GDPR controls in place; no external audit has validated them |
| **Post-launch** | Formal certifications pursued using v1 compliance artifacts as the basis | SOC 2 Type II, ISO 27001 certification process begins after launch |

Marketing must not claim certifications that don't exist. "Built for compliance" is accurate; "SOC 2 certified" is not until it is.

**Audit log tamper-evidence — v1 architectural commitment required:**

"Tamper-evident" is a specific claim requiring a specific mechanism. v1 must implement one of:

| Mechanism | Description | Recommendation |
|---|---|---|
| **Cryptographic chaining** | Each log entry includes a hash of the previous entry; tampering breaks the chain detectably | v1 target |
| **Write-once export** | Periodic export to customer-controlled write-once storage (S3 Object Lock, WORM) | Open-tier capability (already in scope) |
| **Signed log entries** | Each entry signed with a server key; deletion is detectable but entries can still be physically deleted from DB | Weaker; not recommended as sole mechanism |

*Cryptographic chaining + write-once export capability is the recommended v1 combination. "Tamper-evident" without a specified mechanism is a compliance claim that will not survive an auditor's questions.*

**Design-for controls (v1):**
- Encryption at rest (AES-256)
- TLS 1.2+ in transit
- Immutable audit logs with cryptographic chaining (tamper-evidence mechanism)
- RBAC structural — not retrofitted
- CMK migration path preserved in encryption layer design
- Query-level tenant isolation enforced at the database query level, not application layer alone
- Org-aware data model from schema level, day one

**GDPR right to erasure vs. immutable audit logs — resolution:**
- **Audit log pseudonymization:** On account deletion, user identity in all audit log entries replaced with a pseudonymous token (e.g., `[deleted-user:a3f9b2]`). Audit event preserved (required for compliance and forensics); PII removed (required for GDPR erasure). Must be designed into audit log schema from v1 — cannot be retrofitted.
- **Account deletion data handling (v1 product requirement):** When a user is deleted, their owned projects must be explicitly handled. Options: (a) transfer ownership to another member before deletion is permitted, (b) project enters an org-admin-controlled grace period, (c) org admin assumes ownership automatically. This flow requires UX design — it is a v1 product requirement.

---

### Security Operations Requirements

**Blast radius containment:**
- **Bulk read rate limiting:** Secret read operations have a separate, stricter rate limit from general API usage. A single credential (human or machine) cannot read all secrets across all projects in a short window without triggering throttling.
- **Anomaly detection (v1 baseline):** Flag and alert on threshold-based suspicious access patterns — one machine user reading secrets across many projects in rapid succession; access from a new IP for a privileged account; bulk export attempts. Alerts go to Org Admins. Full behavioral analytics is a v2 feature; basic threshold alerting is v1.
- **Blast radius documentation:** Security documentation must explicitly state what an attacker can access at each privilege level (Viewer, Member, Admin, Owner, Org Admin, DB-level). Users and auditors should know the worst-case at each level.

**Dependency security:**
- Automated dependency vulnerability scanning runs in CI on every commit (e.g., `cargo audit`, `npm audit`, Dependabot, or equivalent)
- Critical CVEs trigger an expedited patch release — not bundled into the next scheduled release
- SBOM (Software Bill of Materials) published with each release
- Dependency update policy documented

**Responsible disclosure:**
- A coordinated vulnerability disclosure policy (CVE process) is published at launch
- A security contact (`security@` or equivalent) is publicly listed
- A basic acknowledgment / bug bounty program is in place at launch

**Self-hosted upgrade path:**
- Documented in-place upgrade process ships with v1 (not "reinstall from scratch")
- Upgrade path preserves all data, secrets, audit logs, and configuration
- Version compatibility matrix maintained
- Security patch releases clearly labeled; communicated to self-hosted users via release notes and optional in-app notification

---

### Implementation Considerations

- Security lens applied **before** all architectural decisions — not retrofitted
- Open-core model is a trust mechanism and an attacker's research resource — both are true and both are accepted
- **OSS standalone value thesis:** A team running the self-hosted OSS tier gets secrets storage with versioning, RBAC, manual rotation with confirmed propagation, expiry monitoring, uptime monitoring, audit logs, and project documentation — all functional without a commercial license. This is sufficient to solve the core operational problem and constitutes a complete product, not a teaser. Commercial tiers add managed hosting, enterprise SSO, compliance reporting, and advanced provider plugins — acceleration and scale, not access to the core value. The OSS tier must be genuinely useful as a standalone product; if it isn't, the adoption funnel breaks before trust is established.
- Compliance certification artifacts (threat models, security controls documentation, key management boundary docs) must be produced during v1 development — inputs to post-launch certification, not outputs of it
- GDPR/HIPAA for self-hosted: customer's operational responsibility; Project Vault provides the necessary controls
- BAA (HIPAA) and DPA (GDPR) required before v2 SaaS launch
- **Deployment security boundary explicitly documented:** Project Vault's security model depends on the host's security posture — auditors will ask about this boundary
- **Compliance and auth features require UX design treatment:** MFA enrollment and recovery, machine user token management, fallback cache status visibility, account deletion flows, org admin vs. project admin distinctions — each is a potential complexity leak. These flows must be inputs to the UX design step.

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Problem-solving MVP — ship the complete core operational problem solver. The bar is not "minimally functional" but "genuinely solves the problem so that early adopters won't revert." Every feature in v1 must directly answer the question: *does a team need this to trust Project Vault as their single source of operational truth?* If the answer is "they'd compensate with another tool," it stays out.

**Build context:** Solo founder with AI assistance. This is viable for this product given the REST API-first architecture (well-understood patterns), the Docker self-hosted deployment model (no managed infra to operate), and the open-core model (no enterprise sales motion in v1). The constraint is calendar time, not architectural capability. Scope decisions must protect the single engineer's focus above all else.

**Rotation philosophy:** Rotation is the highest-risk technical area due to provider diversity and failure modes. The v1 answer is the manual/assisted plugin — a structured, confirmed, auditable checklist that solves the problem without requiring provider-specific automation. This is not a compromise: for most v1 users, knowing *every system that needs updating* and tracking each confirmation is already a massive improvement over the status quo. Automated provider plugins ship when the plugin architecture is proven against real usage.

**MVP success gate:** See [Product Scope](#product-scope) for the full success gate definition.

---

### MVP Feature Set (Phase 1 — v1)

**Core user journeys fully supported in v1:**
- Alex (engineering lead, success path) — full journey ✓
- Sam (indie developer, multi-project) — full journey ✓
- Dana (compliance/audit) — full journey ✓
- CI-Bot (machine user, API) — API keys + in-memory fallback + audit trail ✓; encrypted file fallback deferred to v1.1

**Must-have capabilities (v1 ships these):**

| Capability | Rationale |
|---|---|
| Secrets storage with versioning + RBAC | Core of everything |
| Manual/assisted rotation with per-system confirmation + audit trail | Solves rotation without provider-specific automation risk |
| Service, hosting, and payment records with expiry alerts | Core operational visibility |
| SSL/TLS certificate expiry monitoring | Prevents the most common embarrassing incident |
| Simple HTTP uptime monitoring (ping, configurable interval, alert on failure) | Required for the dashboard aha moment — "project as unit of truth" needs live status data |
| Project dashboard — cross-project single-pane view | The aha moment; without this it's just another secrets tool |
| Multi-user support (Owner/Admin/Member/Viewer, project-scoped) | Required for team use |
| Machine users with API key authentication | CI/CD pipeline access; scoped, revocable, audited |
| In-memory machine user fallback (process-lifetime cache; CI/ephemeral environments) | Prevents brief vault unavailability from failing CI pipelines — adoption blocker without this |
| Notes/description field on credentials and projects | 80% of the documentation value with trivial implementation; keeps credential context co-located |
| Email + Slack notifications | Sufficient for v1 event delivery |
| Immutable audit logs — append-only with row-level checksums + write-once export capability | Append-only is defensible for v1 compliance posture; row checksums enable individual entry verification; write-once export gives power users their own tamper-evidence story. Full cryptographic chaining → v1.1. |
| `.env` + JSON import | Migration path from existing setups |
| Self-hosted Docker / Docker Compose | Primary trust path and deployment model |
| Open-source core published (code public day one; v1.0 release gated on responsible disclosure process) | Trust mechanism and distribution strategy; "code public" and "v1.0 released" are distinct events |
| Plugin interface as internal abstraction only (not published externally) | Manual/assisted plugin built against internal abstraction; no external SDK docs until v1.1 when there's an implementation to reference |
| GitHub Actions native integration | Days of work; "use this Action" vs. "write curl commands yourself" is the difference between adoption and a pilot that quietly dies |
| GitLab CI native integration | ~30% of CI/CD market; particularly strong in enterprise and regulated environments |
| MFA (TOTP) with recovery codes | Non-negotiable for security posture claim; 2-week build time box — schedule early, not late |
| Basic threshold anomaly alerting | Org Admin alerts on suspicious bulk access patterns |
| Master password unsealing | Simplest viable key management for v1 |

**Deliberately excluded from v1 (scope protection):**

| Capability | Rationale for deferral |
|---|---|
| Advanced uptime monitoring | Multi-region probes, SSL chain validation, incident history, SLA tracking → v1.1/v2. Simple ping covers v1. |
| Full built-in documentation/wiki | Rich text editor, search, version history → v1.1. Notes fields cover 80% of the need in v1. |
| Short-lived JWT machine user tokens | API keys solve v1 machine auth. JWTs add token exchange + refresh + revocation complexity. v1.1. |
| Encrypted file fallback for persistent services | In-memory fallback covers CI/ephemeral in v1. Persistent-service file fallback (key derivation, TTL, rotation grace period) → v1.1. |
| Automated provider rotation plugins (AWS, GCP, etc.) | Manual/assisted covers v1 completely. Automated plugins need the plugin interface validated first. v2. |
| Shamir's Secret Sharing key unsealing | Master password sufficient for v1; Shamir adds ceremony complexity. v2. |
| Webhook outbound notifications | Email + Slack cover v1. SSRF protection adds non-trivial complexity. v1.1. |
| Cryptographic audit log chaining | Full chain verification → v1.1. Append-only + row checksums is honest and defensible for v1. |
| Plugin SDK external documentation | Published in v1.1 alongside first automated plugin. Internal abstraction in v1; external docs without implementation = maintenance debt. |
| Doppler / Infisical migration import | Beyond .env + JSON; v1.1 fast-follow. |
| Drift detection | Growth feature. v2. |
| Org-level multi-tenancy UI | Schema is org-aware from day one; UI exposed in v1.1. |

---

### Phased Development Roadmap

**Phase 1 — v1 (MVP)**

The complete problem-solver: teams trust Project Vault as their single source of operational truth for credentials, expiry dates, and rotation history. Machine users authenticate via API keys with in-memory fallback for brief unavailability. Dashboard shows live project health. Notes keep credential context co-located. GitHub Actions and GitLab CI integrations make secret injection a one-liner.

**Phase 2 — Extension Architecture, Multi-Field Secrets, i18n & Theming**

*Inserted 2026-07-23; renumbers original Phase 2 (v1.1) → Phase 3, Phase 3 (v2) → Phase 4, Phase 4 (Vision) → Phase 5. This phase numbering tracks the PRD's roadmap sequence and is decoupled from shipped epic numbering (epics 1–12 already cover v1 MVP and several v1.1/v2-scoped items delivered ahead of this roadmap ordering).*

- Extension / Hook Architecture: versioned Extension API, founder's private closed-source SaaS extension (in-process, trusted), auth-provider hooks
- Multi-field secrets: field-set model, built-in templates, per-field masking, field-scoped rotation
- Internationalization & Localization
- Theming: structured custom themes from a non-tracked directory
- AGPLv3 relicense + CLA for external contributors (precondition for the extension architecture's business model to function)

**Phase 3 — v1.1 (Fast-follow)**

Close the gaps early adopters surface:
- Encrypted file fallback for persistent services (VPS, long-running Docker)
- Short-lived JWT tokens for machine users
- Webhook outbound notifications (with SSRF protection)
- Cryptographic audit log chaining (full tamper-evidence)
- Advanced uptime / health monitoring (multi-region, SSL chain, incident history)
- Full built-in project documentation / wiki (rich text, search, version history)
- Plugin SDK external documentation + first automated rotation plugin
- Doppler + Infisical migration import
- Multi-org support via UI (schema already supports it)

**Phase 4 — v2 (Growth, 3–9 months post-launch)**

Commercial tier unlocked; SaaS hosting:
- Automated provider plugin library (AWS, Azure, GCP, Linux/Unix, databases)
- SSO/SAML (enterprise buyer unlock, delivered via the Phase 2 auth-hook extension point, not built-in core)
- Multi-tenant SaaS hosting — the founder's privately-hosted, closed-source extension (per Phase 2 Extension Architecture); never distributed to self-hosters
- Third-party community extensions — sandboxed/out-of-process, permission-scoped (deferred from Phase 2; ships once the Extension API has real usage)
- Shamir's Secret Sharing key unsealing
- Customer-managed encryption keys (CMK)
- Drift detection and version-lag alerting
- Advanced compliance reporting (SOC 2 evidence export, ISO 27001 control mapping)
- Behavioral anomaly detection (beyond threshold alerting)
- Secret versioning pinned to deploy-time

**Phase 5 — Vision**

- Zero trust network capabilities
- Formal SOC 2 Type II + ISO 27001 certifications
- Provider integration marketplace (community plugins, building on the Phase 4 community extension system)
- Cross-project security intelligence
- "Project handoff export" for agencies/consultants

---

### Risk Mitigation Strategy

**Technical risks:**

| Risk | Mitigation |
|---|---|
| Cryptographic design becomes a time sink | Decide early and commit: AES-256-GCM + HKDF, standard libraries only, no custom crypto. Document in an ADR. Architecture review is a week, not a month. |
| Rotation complexity blocks launch | Manual/assisted plugin is the v1 rotation story — full stop. No automated plugins in v1. Already decided. |
| Security feature scope creep | Security requirements are fully specced in this PRD. Implement what's specced; defer new discoveries to post-launch backlog. |
| Plugin architecture over-engineered for v1 | Internal abstraction only. One plugin (manual/assisted). Don't build marketplace scaffolding in v1. |

**Market risks:**

| Risk | Mitigation |
|---|---|
| Adoption stalls before migration pain is solved | Ship .env + JSON import on day one. Make "load your first project" frictionless in the first 30 minutes. Doppler/Infisical import in v1.1 as immediate fast-follow. |
| "Just use Infisical" objection | Lean into structural differences: project-centric organization, operational scope (expiry alerts, services, payments), confirmed rotation. These are architectural, not cosmetic. |
| Open-source users never convert | Accept this for v1. v1 proves the value proposition and builds reputation. Commercial conversion is a v2 motion after real users and case studies exist. |
| v1 sustainability gap | Solo founder builds on personal runway or pre-seed. The open-source launch is the fundraising pitch artifact. v1 doesn't need to be sustainable — it needs to prove the thesis. |

**Resource risks:**

| Risk | Mitigation |
|---|---|
| Single point of failure (solo build) | AI-assisted development substantially mitigates velocity. Real risk is decision fatigue and rabbit holes. Use this PRD as the decision authority — don't re-litigate scope during build. |
| Scope creep during build | This scoping document is the contract. Any new idea goes to the post-MVP backlog, never directly into v1. Review the "deliberately excluded" list before adding anything. |
| Underestimating compliance feature complexity | MFA (TOTP setup, recovery codes, tier enforcement) is a 2-week time box — schedule early, not late. If MFA runs long, something in v1.1 gets cut, not MFA. |
| Running out of runway before v2 revenue | **Build in public from day one:** GitHub repo is public immediately (builds community, invites security researchers early). "Code public" and "v1.0 released" are distinct events — v1.0 release waits until the responsible disclosure process, security contact, and patch release workflow are operational. Regular progress posts (Hacker News, X) convert build time into community time. |
| v1 too "done" before real users see it | **Ship a focused alpha to 5–10 real users at month 3–4.** Goal is **paradigm validation** — does project-centric organization feel right to real users? — not feature completeness. Rotation and machine users can be beta features. See Alpha milestone below. |

**Alpha Milestone (Month 3–4, Pre-Beta)**

Explicit FR subset that must be stable before any external user sees the product. Alpha scope is not a separate product — it is the earliest shippable slice of v1 for paradigm validation:

| Capability | Alpha Status |
|---|---|
| Secrets storage with versioning + RBAC | Required |
| Project dashboard (read-only health view) | Required |
| `.env` + JSON import | Required |
| Expiry alerts (SSL certs, domains, services) | Required |
| Email notifications | Required |
| Docker / Docker Compose self-hosted deployment | Required |
| "What is a project?" onboarding wizard | Required |
| Multi-user with Owner/Admin/Member/Viewer roles | Required |
| Machine users + API key auth | Deferred to beta |
| Manual rotation checklist | Deferred to beta |
| GitHub Actions / GitLab CI integrations | Deferred to beta |
| MFA (TOTP) | Deferred to beta |

Alpha success criterion: 5–10 real engineering teams load a real project and return the next day without prompting.

## Functional Requirements

> **Capability Contract:** This section is binding. UX designers, architects, and engineers will only design, build, and support capabilities listed here. Any capability missing from this list does not exist in the product unless explicitly added through a change process.
>
> *Note: Encryption at rest and TLS enforcement are quality attributes addressed in Non-Functional Requirements.*

---

### Project & Organization Management

- **FR1:** Users can create and configure projects as the primary organizational unit for all operational assets (credentials, services, certificates, documentation)
- **FR2:** Project Owners can invite users to a project and assign them a role (Owner, Admin, Member, Viewer)
- **FR3:** Users can hold different roles across different projects simultaneously
- **FR4:** Project Owners can transfer project ownership to another project member
- **FR5a:** Organization Admins can view all users in the organization and their membership and role across every project
- **FR5b:** Organization Admins can remove users from the organization
- **FR5c:** Organization Admins can change a user's role within any project in the organization
- **FR6:** Organization Admins can configure self-hosted instances to support multiple organizations within a single deployment
- **FR7:** Users can view all projects they have access to from a unified cross-project dashboard
- **FR8:** Users can add notes and descriptions to projects to capture operational context
- **FR9:** The system guides new users through creating their first project and understanding the project-centric organizational model via an interactive wizard (not a text screen); the wizard walks through adding at least one real credential and explicitly contrasts project-centric vs. environment-centric organization
- **FR98:** A newly created empty project displays a purposeful empty state that communicates the project's potential — showing the categories of assets that belong here (credentials, certificates, services, documentation) and offering a direct path to the first import or manual addition; an empty project must never appear as a dead end
- **FR62:** Project Admins can remove a user from a specific project without affecting that user's organization account or membership in other projects
- **FR63:** Users can archive projects to remove them from active dashboard views while preserving all credentials, history, and audit records

---

### Secret & Credential Management

- **FR10 (amended):** Users can store a secret with a name, description, tags, expiry date, and linked dependent systems within a project, plus one or more named fields each holding a value; a secret created without specifying a template has a single default field, preserving pre-existing single-value behavior with no migration required
- **FR111:** The system provides built-in secret templates (Login, Database Connection, API Key, Secure Note, Custom) that pre-populate a secret's field names; users can add, rename, or remove fields regardless of template
- **FR112:** Each field on a secret has an independent sensitivity flag (masked or visible-in-list); masked fields require an explicit reveal action (see FR96 for reveal audit behavior)
- **FR11:** Users can retrieve the current version of any secret they are authorized to access
- **FR12 (amended):** The system maintains a complete immutable version history for every secret, where a version is the full field-set as of that point in time; any change to any single field creates a new version of the whole secret
- *(FR13 intentionally reserved — merged into FR12 during consolidation)*
- **FR14:** Users can search and filter credentials within a project by name, tag, status, and expiry
- **FR15:** Users can set expiry dates and rotation schedules on individual credentials
- **FR16:** Users can record which external systems and services depend on each credential
- **FR17:** Users can import credentials in bulk from `.env` files and JSON exports
- **FR64:** Users can view which human users and machine users currently have access to a specific credential, based on their project roles
- **FR95:** Users can add, edit, and remove tags on credentials and projects for organization and cross-project filtering
- **FR96 (amended):** Users can reveal the current value of a secret (or, for multi-field secrets, a specific masked field) they are authorized to access, with each reveal event captured in the audit log including which specific field(s) were revealed
- **FR105 (back-ported from epics.md 2026-07-23 — see note below):** The system enforces a configurable secret version retention policy (default: retain 3 versions; minimum: 1 — the current version only; maximum: configurable per tier). Versions beyond the retention window are cryptographically deleted (encryption key material destroyed, not merely record-deleted) after they are no longer referenced by any in-progress or stale-recovery rotation. Version pruning events are recorded in the audit log. Versions referenced by an incomplete rotation are exempt from pruning until the rotation concludes.

---

### Rotation & Propagation

- **FR18 (amended):** Users can initiate a rotation workflow for any stored credential and, for multi-field secrets, select which field(s) are being rotated (e.g., password only, keeping username unchanged); the resulting new version is still a full field-set snapshot per FR12
- **FR19:** The system generates a per-system confirmation checklist for every rotation, listing all recorded dependent systems
- **FR20:** Users can mark each system on the rotation checklist as confirmed-updated
- **FR21:** The system prevents a rotation from being marked complete while systems on the checklist remain unconfirmed
- **FR22:** The system retires the old credential version only after all dependent systems are confirmed and the rotation is explicitly completed
- **FR23:** The system maintains a complete rotation history per credential, capturing who initiated, each system confirmation, and the outcome
- **FR65:** Users can view a consolidated list of credentials with upcoming rotation schedules, filterable by time horizon
- **FR66:** Users can view the live status of an in-progress rotation — which dependent systems are confirmed, which are pending, and who last acted on the checklist
- **FR75:** Users can record and respond to a system confirmation failure during an active rotation — marking a specific system as failed, retrying the confirmation, or escalating — without abandoning the rotation
- **FR108 (back-ported from epics.md 2026-07-23):** The system supports a break-glass emergency rotation mode, accessible to Organization Admins, that initiates rotation and immediately retires the old credential without waiting for dependent system confirmations; the break-glass action is recorded as a separate high-severity audit event, automatically notifies all org admins via FR100's alert routing, and creates a mandatory post-rotation review task requiring confirmation that all dependent systems have been updated within a configurable grace window (default: 4 hours); the review task and its resolution are recorded in the audit log

---

### Operational Monitoring & Alerts

- **FR24:** Users can add service records (hosting providers, payment subscriptions, SaaS tools) with expiry or renewal dates to a project
- **FR25:** Users can add SSL/TLS certificate records with expiry dates to a project
- **FR26:** Users can add domain records with renewal dates to a project
- **FR27:** The system monitors registered HTTP endpoints for availability and alerts when they become unreachable
- **FR28:** Users can configure alert thresholds and lead times for expiry notifications on any tracked asset
- **FR29:** The system sends proactive alerts before credentials, certificates, domains, or service records reach their configured alert threshold
- *(FR30 intentionally reserved — merged into FR29 during consolidation)*
- **FR31:** The system alerts Organization Admins when anomalous access patterns exceed configured thresholds (default: 5 accesses to credentials outside the account's normal role pattern within one hour)
- **FR67:** Users can dismiss or snooze an expiry alert for a specific asset, with the dismissal recorded in the audit log
- **FR76:** Users can view a cross-project health status page showing the live availability status of all monitored services and endpoints across every project they can access — distinct from the per-project dashboard, which shows all asset types for one project
- **FR77:** Project Owners can enable an optional public-facing status page for a project — a shareable URL that displays the current health status of selected services to external stakeholders without requiring an account
- **FR99 (back-ported from epics.md 2026-07-23):** The system sends a recovery notification when a previously unreachable monitored endpoint becomes reachable again
- **FR100 (back-ported from epics.md 2026-07-23):** Administrators can configure per-alert-type routing — designating specific users or roles as recipients for each alert category (anomalous access, fallback activation, machine user key expiry, service down/recovery, backup failure, failed auth threshold) rather than routing all alerts exclusively to Organization Admins

---

### Machine User Access

- **FR32:** Administrators can create machine user identities with scoped project roles within a project
- **FR33:** Administrators can issue and revoke API key credentials for machine users
- **FR34:** Machine users can authenticate to the REST API using API key credentials
- **FR35:** Machine users can retrieve the current version of secrets they are authorized to access by stable name, always receiving the current version without requiring knowledge of internal identifiers
- **FR36:** The system maintains a separate, complete audit trail for all machine user access events, including credential version served
- **FR37:** The system maintains a local cache of authorized secrets that persists for the duration of the consuming process and activates automatically when the vault is temporarily unreachable (default trigger: 3 consecutive failed connection attempts within 30 seconds)
- **FR38:** The system records fallback cache usage events in the audit log and alerts administrators when the fallback activates
- **FR39:** The system provides native integrations that allow CI/CD pipelines to retrieve secrets directly within GitHub Actions and GitLab CI workflows
- **FR68:** Administrators can configure expiry dates on machine user API keys and receive alerts before a key expires
- **FR101 (back-ported from epics.md 2026-07-23):** Machine user API key rotation supports a configurable overlap grace period — the new key becomes active before the old key is revoked, enabling zero-downtime rotation for long-running services without a restart or deployment window; the overlap grace period is configurable with a maximum enforced cap (default: 1h, max: 24h); while overlap is active, the system emits a machine-key-overlap-active alert to FR100-configured recipients; if the old key is used during the overlap window after the new key has been confirmed active by at least one successful authentication, an anomaly alert is generated
- **FR110 (back-ported from epics.md 2026-07-23):** The system detects machine user API keys that have not been used for authentication within a configurable inactivity threshold (default: 90 days) and alerts Organization Admins via FR100 routing; the alert includes the machine user name, last-used date, and the projects and credentials in scope; admins can dismiss with a recorded reason, revoke, or extend; machine user keys with no recorded use since creation flag after the same dormancy threshold

---

### Audit & Compliance

- **FR40:** The system records every secret access, rotation event, permission change, and administrative action in an append-only audit log with row-level integrity verification
- **FR41:** Users can filter and search audit log entries by date range, user, credential, event type, and project
- **FR42:** Users can export audit log data in structured formats for use in compliance reviews and incident investigations
- **FR43:** The system supports forwarding audit log data to customer-controlled external write-once storage destinations
- **FR44:** The system pseudonymizes user identity in all audit log entries upon account deletion, preserving the event record while removing personally identifiable information
- **FR45:** Organization Admins can deactivate user accounts with immediate revocation of all associated credentials and access
- **FR69:** Organization Admins can generate a point-in-time access report showing all users, their roles, and their project memberships across the organization
- **FR70:** Organization Admins can configure audit log retention periods within the limits set by their subscription tier
- **FR71:** The system detects user accounts that have been inactive beyond a configurable threshold and alerts Organization Admins (default: 90 days)
- **FR78:** Administrators can verify audit log integrity against the last recorded checkpoint
- **FR102 (back-ported from epics.md 2026-07-23):** Account recovery initiation, each admin approval step, and recovery completion are recorded in the audit log as privileged events; user deactivation with in-progress rotation workflows triggers explicit orphan handling (cancel, transfer to another admin, or hold pending review) — the chosen outcome is recorded in the audit log

---

### Platform & Integration

- **FR46:** Users can access all product capabilities through a web browser interface
- **FR47:** All product capabilities available in the web UI are also accessible via a versioned REST API
- **FR48:** The system publishes an OpenAPI specification covering all REST API endpoints
- **FR49:** The system is deployable on self-hosted infrastructure via Docker and Docker Compose
- **FR50:** The system supports in-place version upgrades that preserve all data, secrets, audit logs, and configuration without requiring reinstallation
- **FR51:** The system delivers event notifications to users via email
- **FR52:** The system delivers event notifications to team channels via Slack
- **FR72:** The web UI is accessible and functional on mobile browsers without requiring a native application
- **FR80:** Users can search across all projects they have access to by credential name, service name, tag, or metadata
- **FR81:** The system exposes a health and readiness endpoint for container runtime liveness and readiness probes
- **FR82:** The system emits structured operational logs (separate from audit logs) that administrators can ship to external log aggregation tools
- **FR97:** The REST API supports pagination and filtering on all collection endpoints

---

### Security & Authentication

- **FR53:** Users can create accounts and authenticate with email and password
- **FR54:** Users can enroll in TOTP-based multi-factor authentication
- **FR55:** Users can generate one-time recovery codes at MFA enrollment for account recovery
- **FR56:** Organization Admins can initiate and approve account recovery for users who have lost MFA device access, subject to the configured recovery policy
- **FR57:** The system enforces MFA enrollment for Owner and Admin roles in Team and Small Company tier organizations before those roles may invite additional members
- **FR60:** The system supports configurable vault unsealing via a master password on startup
- **FR61:** The system enforces organization-scoped data isolation such that users in one organization cannot access data belonging to another organization
- **FR73:** The system logs all failed authentication attempts and alerts Organization Admins when failed attempts exceed a configurable threshold for a single account or IP address (default: 10 failed attempts within 5 minutes)
- **FR83:** Users can view all their currently active sessions and revoke any individual session
- **FR84:** Organization Admins can revoke all active sessions for any user in their organization
- **FR85:** The system enforces configurable idle session timeout

---

### System Administration

- **FR86:** Administrators can configure system-level settings through the product UI — including SMTP configuration, backup schedule, notification defaults, and instance-level policy
- **FR87:** Administrators can view current resource usage (projects, secrets, users) against their subscription tier limits and receive alerts when approaching limits
- **FR103 (back-ported from epics.md 2026-07-23):** Platform operator actions on the instance (cross-org incident investigation, instance-level configuration changes, operator-initiated user or org modifications) are logged in a separate immutable platform audit log that is independently verifiable, not visible to org admins, and retained independently of per-org audit log retention policies; the same write-failure invariant applies as to per-org audit logs — platform operator actions fail if the platform audit write fails; an explicit operator-acknowledged maintenance mode exists to temporarily bypass this for emergency recovery, and any such bypass is recorded when the log becomes available
- **FR104 (back-ported from epics.md 2026-07-23):** Users with rotation initiation permission can remove or archive a dependent system record from a credential's dependency list; removal is recorded in the audit log; archived records are hidden from new rotation checklists but preserved in all historical rotation records where they appeared
- **FR109 (back-ported from epics.md 2026-07-23):** On startup and on a weekly schedule, the system evaluates the master key custody configuration and surfaces a persistent admin dashboard alert if: (a) the master key is stored only as an environment variable with no KMS or escrow configured, AND (b) backup is enabled; the alert states explicitly that backups will be unrecoverable if the host environment is lost, and provides a direct path to configure KMS integration; this condition is also reflected in the readiness endpoint (FR81) as a degraded-configuration warning

---

### Project Dashboard

- **FR93:** The project dashboard surfaces, at minimum: credential status (active, expiring, expired), upcoming rotation schedule, monitored service health, recent access events, and unresolved alert count — for the currently viewed project

---

### Notification Preferences

- **FR94:** Users can configure personal notification preferences including delivery channel, frequency (per-event or digest), and minimum severity threshold
- **FR107 (back-ported from epics.md 2026-07-23):** The system maintains a persistent in-product notification inbox per user, surfacing all alerts and system events routed to them (per FR94 preferences) regardless of whether they were also delivered via email or Slack. Inbox entries persist until explicitly dismissed or automatically expire per configurable retention (default: 90 days). Unread count is visible in the global navigation at all times. This provides a no-configuration-required baseline for users relying on the web UI as their primary interface.

---

### Backup & Restore

- **FR88:** The system creates encrypted snapshots of all vault data on a configurable schedule
- **FR89:** Administrators can configure backup retention policy and storage destination
- **FR90:** Administrators can restore vault state from a backup snapshot
- **FR92:** The system monitors backup health and alerts administrators when backups are missed, fail verification, or encounter storage issues

---

### Extension & Plugin Architecture

*General-purpose extensibility — distinct from the existing rotation plugin FRs above (FR18–FR23, FR75), which are scoped only to credential propagation.*

- **FR113:** The system exposes a versioned Extension API with defined extension points (authentication provider, notification channel, UI panel) that an external package can register against via a typed, code-based registration API
- **FR114:** The system loads a configured extension package at startup if present; the system remains fully functional with zero extension packages installed
- **FR115 (amended on review):** The system supports registering one or more external authentication provider strategies via the Extension API, participating in the authentication flow alongside the built-in local/MFA strategy, which always remains available as fallback. A successful external authentication resolves to an existing, explicitly-linked user identity — never auto-provisioned or auto-linked by matching email address alone; a first-time external login with no existing link requires a pending invitation or explicit Organization Admin action to complete. MFA enforcement for Owner/Admin roles applies identically regardless of authentication source.
- **FR116 (deferred — see Product Scope):** Administrators can install third-party community extensions with declared permission scopes, requiring explicit approval before activation and running with no default access to decrypted secret values

---

### Internationalization & Localization

- **FR117:** Users can select their preferred display language from the set of supported locales
- **FR118:** The system renders UI text, dates, and notification content in the user's selected language, falling back to English for any untranslated content
- **FR119:** Organization Admins can configure a default locale for newly invited users within their organization

---

### Theming

- **FR120:** Administrators can install custom themes as structured (JSON/YAML) definitions placed in a designated, non-tracked directory, without modifying application code
- **FR121:** Users can select the active theme from the base theme and any installed custom themes

---

> **Final count: 95 FRs across 12 capability areas** at initial PRD publication; see edit history for: (a) 11 FRs (FR99–FR105, FR107–FR110) back-ported 2026-07-23 from epics.md, where they were added during epic/story work but never written back to this PRD — a pre-existing drift between this document and epics.md, now reconciled; **FR106 has no corresponding requirement in epics.md and is intentionally left unassigned** — origin of the gap is undocumented, left as-is rather than inventing a requirement to fill it; (b) 11 new Phase 2 FRs (FR111, FR112, FR113–FR121) for Extension/Hook Architecture, multi-field secrets, i18n, and theming. All 9 user journeys fully covered (5 v1 MVP + 4 Phase 2). All MVP scope items represented. All domain, project-type, and scoping requirements traceable to at least one FR.

---

## Non-Functional Requirements

### Performance

- **Reference load:** 20 concurrent human users + 10 concurrent machine API calls
- **Infrastructure baseline:** 2 vCPU / 4GB RAM / SSD-backed storage, PostgreSQL with connection pooling
- **Secret fetch (by-id/name):** p95 ≤100ms
- **Secret search/filter:** p95 ≤300ms, paginated
- **Dashboard first meaningful content:** ≤2s (meaningful = project list + active warnings with real data rendered)
- **Dashboard load order:** (1) status summary → (2) expiry alerts/warnings → (3) activity feed → (4) details
- **Rotation initiation:** p95 ≤500ms
- **Audit log queries at 1M entries:** p95 ≤500ms; required indexes on `(actor_id, timestamp)` and `(project_id, timestamp)`
- **External plugin timeout cap:** 3s; breach surfaces as rotation step failure; max 2 retries, exponential backoff (3s → 6s)
- **Background operations** (health checks, rotation) never block UI
- **UI asset caching:** static/versioned assets served immutable; API responses no-cache
- **Connection pooling** required in production; reference configuration provided in deployment docs

### Security

- **Encryption at rest:** AES-256-GCM for all secrets and backups
- **Master key management:** environment variable (default); external KMS integration (advanced option). Note: if host is fully compromised, both key and data are at risk — external KMS wrap mitigates this
- **Backup key envelope:** backup encrypted with master key; external KMS wrap documented as advanced option
- **Encryption in transit:** TLS 1.3 required for all inbound API connections; TLS 1.2 minimum / 1.3 preferred for outbound plugin connections to target systems
- **Memory safety:** secret values must not appear in logs, stack traces, or error messages; enforced as a code review requirement for all secret-handling paths
- **Authentication:** MFA (TOTP) supported and enforced per policy; machine users authenticate via API key + short-lived JWT (≤1h TTL, refresh via API key)
- **Session management:** web UI inactivity timeout 30 minutes, configurable, minimum enforced (non-zero)
- **Audit log immutability:** append-only writes; per-entry cryptographic chaining; chain verification API available
- **Audit log access:** read requires Owner or explicit Audit role; Admin access scoped to own projects only
- **RBAC permission granularity:** list/enumerate is a distinct permission from read-value
- **Privilege escalation prevention:** no user may grant permissions exceeding their own role or modify their own role assignment
- **Rate limiting:** 120 req/min per authenticated account (humans) or per API key (machine users); 60 req/min per IP (unauthenticated / secondary layer)
- **Credential entropy:** API keys ≥256 bits; generated passwords ≥128 bits or policy-defined minimum
- **CVE response:** critical vulnerabilities patched ≤7 days; high severity ≤30 days
- **Incident notification:** security incidents affecting stored credentials → user notification ≤72h of confirmed incident
- **Extension trust isolation:** third-party community extensions execute in a sandboxed, out-of-process execution environment; no default access to decrypted secret values; capability scopes declared in a manifest and enforced by the host loader based on extension provenance, not self-declaration. The founder's first-party private extension is exempt from sandboxing (in-process, trusted) but not from capability declaration.

### Reliability

- **Uptime target:** 99.9% (~8.7h downtime/year); requires automatic container restart enabled (deployment constraint, not optional)
- **Crash recovery:** ≤30s with automatic restart
- **Atomic writes:** all credential operations are atomic; rotation is a compound transaction (new version + rotation log + per-system checklist state + notification queue entry) — all committed or none
- **Rotation durability:** completed rotation writes synchronously durable; this supersedes the general RPO for in-flight operations
- **Audit completeness:** 100% — no audit entry dropped under any load condition
- **RPO:** 24h (backup-based); **RTO:** 2h with documented runbook

### Scalability

- **Reference scale (single instance):** 50 concurrent users / 100 concurrent API calls / 10,000 secrets / 1,000,000 audit log entries
- No clustering or horizontal scaling required in v1; design should not preclude it

### Accessibility

- WCAG 2.1 AA compliance for all UI components
- Automated: automated accessibility testing tool integrated as CI gate (blocks merge on violations)
- Manual: top-5 user flows audited before launch

### Data Integrity

- Secret versions are immutable once written (append-only, no overwrite)
- All writes atomic; no partial state persisted
- Backup integrity guaranteed via AES-256-GCM authenticated encryption; checksums verified on restore

### Maintainability

- Structured JSON logging with configurable log levels
- 12-factor app compliance (config via environment, stateless processes, etc.)
- Security-sensitive code paths enumerated and tracked in code review checklist
- Prometheus-compatible metrics endpoint; defaults to localhost-only binding (configurable for external scraping)
- Multi-arch container builds: AMD64 + ARM64
- API v1 compatibility policy: no breaking changes within v1.x
- **Internationalization:** no hardcoded strings in UI components; locale switch completes without a page reload; missing translations fall back to English rather than rendering a translation key or blank string; locale files structured for community-contributed translations without core code changes
- **Extension API stability:** the Extension API is semver-versioned independently of the application; breaking changes require an explicit major version bump, a changelog entry, and a documented migration note; core performs startup capability-negotiation against a declared extension semver range and fails loudly (not silently) on incompatibility
- **Theming:** installing or switching a theme requires no application rebuild and no restart; a malformed theme definition fails validation at load time with a clear error, falling back to the base theme rather than rendering a broken UI
