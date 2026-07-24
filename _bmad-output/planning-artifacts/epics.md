---
stepsCompleted: ["step-01-validate-prerequisites", "step-01-advanced-elicitation", "step-02-design-epics", "step-02-advanced-elicitation", "step-03-create-stories", "step-03-advanced-elicitation", "step-04-final-validation"]
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/architecture.md"
  - "_bmad-output/planning-artifacts/ux-design-specification.md"
phase2AmendmentHistory:
  - date: '2026-07-23'
    changes: 'Extracted Phase 2 PRD/architecture scope (FR10/12/18/96 amended, FR111-121) into Requirements Inventory and appended Epic 13 (Structured Multi-Field Secrets), Epic 14 (Extension Architecture & Pluggable Authentication, Story 0 = AGPLv3/CLA), Epic 15 (Localization), Epic 16 (Custom Theming) to the Epic List. Originally proposed as 3 epics; a 5-agent adversarial review (architecture completeness, cross-doc consistency, security, epic-dependency validation, UX/edge-cases) found and fixed 14 issues before the epic list was finalized — including an undocumented SSO identity-binding gap, missing CSRF/state validation, a broken FR Coverage Map (all Phase 2 FRs had been left mapped to a single epic), and the i18n+theming bundle lacking cohesion (split into 15/16). A follow-up elicitation pass moved the AGPLv3 story from a standalone untracked prerequisite into Epic 14 Story 0, and reordered recommended build sequence to Epic 14 first (business-critical path) ahead of Epic 13. Step 2 (design epics) complete for this amendment; step 3 (create stories) not yet started for epics 13-16.'
---

# Project Vault - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Project Vault, decomposing the requirements from the PRD, UX Design, and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

**Project & Organization Management**
- FR1: Users can create and configure projects as the primary organizational unit for all operational assets (credentials, services, certificates, documentation)
- FR2: Project Owners can invite users to a project and assign them a role (Owner, Admin, Member, Viewer)
- FR3: Users can hold different roles across different projects simultaneously
- FR4: Project Owners can transfer project ownership to another project member
- FR5a: Organization Admins can view all users in the organization and their membership and role across every project
- FR5b: Organization Admins can remove users from the organization
- FR5c: Organization Admins can change a user's role within any project in the organization
- FR6: Organization Admins can configure self-hosted instances to support multiple organizations within a single deployment
- FR7: Users can view all projects they have access to from a unified cross-project dashboard
- FR8: Users can add notes and descriptions to projects to capture operational context
- FR9: The system guides new users who access the web UI for the first time through an interactive onboarding wizard (bypass-proof; ends only after at least one real credential is correctly placed); the wizard contrasts project-centric vs. environment-centric organization; acceptance criterion: ≥80% correct second-credential placement without prompting in pre-launch testing with ≥5 participants. Scope: applies to web UI first-access only — operators bootstrapping the instance via Docker ENV or direct API calls are exempt, and the system provides a documented API-first onboarding path for that flow
- FR62: Project Admins can remove a user from a specific project without affecting that user's organization account or membership in other projects
- FR63: Users can archive projects to remove them from active dashboard views while preserving all credentials, history, and audit records
- FR98: A newly created empty project displays a purposeful empty state showing categories of assets and offering direct path to first import or manual addition

**Secret & Credential Management**
- FR10: Users can store a secret with a name, value, description, tags, expiry date, and linked dependent systems within a project
- FR11: Users can retrieve the current version of any secret they are authorized to access
- FR12: The system maintains a complete immutable version history for every secret
- FR105: The system enforces a configurable secret version retention policy (default: retain 3 versions; minimum: 1 — the current version only; maximum: configurable per tier). Versions beyond the retention window are cryptographically deleted (encryption key material destroyed, not merely record-deleted) after they are no longer referenced by any `in_progress` or `stale-recovery` rotation. Version pruning events are recorded in the audit log. Versions referenced by an incomplete rotation are exempt from pruning until the rotation concludes.
- FR14: Users can search and filter credentials within a project by name, tag, status, and expiry
- FR15: Users can set expiry dates and rotation schedules on individual credentials
- FR16: Users can record which external systems and services depend on each credential
- FR17: Users can import credentials in bulk from `.env` files and JSON exports; when an import contains a credential name matching an existing credential in the target project, the system presents an explicit per-conflict resolution choice: (a) **Create new version** — imports the value as a new version of the existing credential, preserving all metadata (rotation schedules, dependencies, notes, history) — this is the default; (b) **Skip** — keeps the existing credential unchanged; (c) **Create as new** — imports as a new credential with a disambiguating suffix; import operations can never destructively modify dependency records, rotation schedules, or notes on existing credentials
- FR64: Users can view which human users and machine users currently have access to a specific credential, based on their project roles
- FR95: Users can add, edit, and remove tags on credentials and projects for organization and cross-project filtering
- FR96: Users can reveal the current value of a secret they are authorized to access, with each reveal event captured in the audit log

**Rotation & Propagation**
- FR18: Users can initiate a rotation workflow for any stored credential
- FR19: The system generates a per-system confirmation checklist for every rotation listing all recorded dependent systems; systems that are currently in active fallback mode (vault unreachable) are explicitly flagged on the checklist as "unverifiable — fallback active" and the rotation cannot be marked complete while any registered system is in this state, OR the initiating admin explicitly acknowledges the unverifiable systems with a documented reason before completion
- FR20: Users can mark each system on the rotation checklist as confirmed-updated
- FR21: The system prevents a rotation from being marked complete while systems on the checklist remain unconfirmed or are flagged as unverifiable-fallback without explicit admin acknowledgement
- FR22: The system retires the old credential version only after all dependent systems are confirmed (or explicitly acknowledged as unverifiable with documented reason) and the rotation is explicitly completed; the rotation history records any unverifiable acknowledgements
- FR23: The system maintains a complete rotation history per credential (who initiated, each system confirmation, outcome)
- FR65: Users can view a consolidated list of credentials with upcoming rotation schedules, filterable by time horizon
- FR66: Users can view the live status of an in-progress rotation (which systems confirmed, pending, last actor)
- FR75: Users can record and respond to a system confirmation failure during an active rotation without abandoning the rotation
- FR108: The system supports a break-glass emergency rotation mode, accessible to Organization Admins, that initiates rotation and immediately retires the old credential without waiting for dependent system confirmations; the break-glass action is recorded as a separate high-severity audit event, automatically notifies all org admins via FR100 routing, and creates a mandatory post-rotation review task requiring confirmation that all dependent systems have been updated within a configurable grace window (default: 4 hours); the review task and its resolution are recorded in the audit log

> **v1 Design Decision — Rotation Confirmation Model:** v1 rotation confirmation is manual (human checklist per dependent system). A planned v2 enhancement is old-credential usage monitoring — detecting active use of the pre-rotation credential via a stored non-reversible fingerprint (HMAC of the old value, never the plaintext) and surfacing this as a safety signal alongside the manual checklist. This is explicitly deferred to v2; no v1 implementation should attempt credential-usage fingerprinting.

> **v1 Scope Decision — Cross-Project Shared Credentials:** v1 does not support organization-level (cross-project) credentials. Users requiring a shared infrastructure credential create a dedicated infrastructure project to own it. Project archival must check for dependencies — archiving a project that owns credentials with active rotation records or active machine user access must be blocked or require explicit confirmation with dependency transfer. Organization-level credentials are a v2 target.

**Operational Monitoring & Alerts**
- FR24: Users can add service records (hosting, payments, SaaS tools) with expiry or renewal dates to a project
- FR25: Users can add SSL/TLS certificate records with expiry dates to a project
- FR26: Users can add domain records with renewal dates to a project
- FR27: The system monitors registered HTTP endpoints for availability and alerts when they become unreachable
- FR28: Users can configure alert thresholds and lead times for expiry notifications on any tracked asset
- FR29: The system sends proactive alerts before credentials, certificates, domains, or service records reach their configured alert threshold
- FR31: The system alerts Organization Admins when anomalous access patterns exceed configured thresholds (default: 5 accesses outside normal role pattern within one hour)
- FR67: Users can dismiss or snooze an expiry alert for a specific asset, with the dismissal recorded in the audit log
- FR76: Users can view a cross-project health status page showing live availability status of all monitored services across every accessible project
- FR77: Project Owners can enable an optional public-facing status page for a project — a shareable URL using an unguessable token (not sequential IDs or org names; minimum 128-bit cryptographically random entropy, at least 22 base62 characters) that displays current health status of selected services to external stakeholders without requiring an account; the operator controls display names for each service (aliased names, not actual service identifiers); actual service URLs and internal identifiers are never exposed on the public page; the public status page endpoint is rate-limited at 60 requests/minute per IP to prevent token enumeration
- FR99: The system sends a recovery notification when a previously unreachable monitored endpoint becomes reachable again
- FR100: Administrators can configure per-alert-type routing — designating specific users or roles as recipients for each alert category (anomalous access, fallback activation, machine user key expiry, service down/recovery, backup failure, failed auth threshold) rather than routing all alerts exclusively to Organization Admins

**Machine User Access**
- FR32: Administrators can create machine user identities with scoped project roles within a project
- FR33: Administrators can issue and revoke API key credentials for machine users
- FR34: Machine users can authenticate to the REST API using API key credentials
- FR35: Machine users can retrieve the current version of secrets they are authorized to access by stable name
- FR36: The system maintains a separate, complete audit trail for all machine user access events, including credential version served
- FR37: The system maintains a local cache of authorized secrets that persists for the duration of the consuming process and activates when the vault is temporarily unreachable (default: 3 consecutive failed connections within 30 seconds)
- FR38: The system records fallback cache usage events in the audit log and alerts administrators when the fallback activates
- FR39: The system provides native integrations that allow CI/CD pipelines to retrieve secrets directly within GitHub Actions and GitLab CI workflows
- FR68: Administrators can configure expiry dates on machine user API keys and receive alerts before a key expires
- FR101: Machine user API key rotation supports a configurable overlap grace period — the new key becomes active before the old key is revoked, enabling zero-downtime rotation for long-running services without a restart or deployment window; the overlap grace period is configurable with a maximum enforced cap (default: 1h, max: 24h); while overlap is active, the system emits a `machine-key-overlap-active` alert to FR100-configured recipients; if the old key is used during the overlap window after the new key has been confirmed active by at least one successful authentication, an anomaly alert is generated
- FR110: The system detects machine user API keys that have not been used for authentication within a configurable inactivity threshold (default: 90 days) and alerts Organization Admins via FR100 routing; the alert includes the machine user name, last-used date, and the projects and credentials in scope; admins can dismiss with a recorded reason, revoke, or extend; machine user keys with no recorded use since creation flag after the same dormancy threshold

**Audit & Compliance**
- FR40: The system records every secret access, rotation event, permission change, and administrative action in an append-only audit log with row-level integrity verification
- FR41: Users can filter and search audit log entries by date range, user, credential, event type, and project
- FR42: Users can export audit log data in structured formats for compliance reviews and incident investigations
- FR43: The system supports forwarding audit log data to customer-controlled external write-once storage destinations
- FR44: The system pseudonymizes user identity in all audit log entries upon account deletion
- FR45: Organization Admins can deactivate user accounts with immediate revocation of all associated credentials and access
- FR69: Organization Admins can generate a point-in-time access report showing all users, roles, and project memberships
- FR70: Organization Admins can configure audit log retention periods within subscription tier limits
- FR71: The system detects user accounts inactive beyond a configurable threshold and alerts Organization Admins (default: 90 days)
- FR78: Administrators can verify audit log integrity against the last recorded checkpoint
- FR102: Account recovery initiation, each admin approval step, and recovery completion are recorded in the audit log as privileged events; user deactivation with in-progress rotation workflows triggers explicit orphan handling (cancel, transfer to another admin, or hold pending review) — the chosen outcome is recorded in the audit log

**Platform & Integration**
- FR46: Users can access all product capabilities through a web browser interface
- FR47: All product capabilities available in the web UI are also accessible via a versioned REST API (/api/v1/), with the explicit exception of guided setup flows (the onboarding wizard and vault initialization ceremony) which are web UI-only in v1; all data operations, configuration, and administrative actions outside of guided flows must be API-accessible
- FR48: The system publishes an OpenAPI specification covering all REST API endpoints
- FR49: The system is deployable on self-hosted infrastructure via Docker and Docker Compose
- FR50: The system supports in-place version upgrades that preserve all data, secrets, audit logs, and configuration
- FR51: The system delivers event notifications to users via email
- FR52: The system delivers event notifications to team channels via Slack
- FR72: The web UI is accessible and functional on mobile browsers
- FR80: Users can search across all projects they have access to by credential name, service name, tag, or metadata
- FR81: The system exposes a health and readiness endpoint for container runtime probes
- FR82: The system emits structured operational logs (separate from audit logs) shippable to external log aggregation tools
- FR97: The REST API supports pagination and filtering on all collection endpoints

**Security & Authentication**
- FR53: Users can create accounts and authenticate with email and password
- FR54: Users can enroll in TOTP-based multi-factor authentication
- FR55: Users can generate one-time recovery codes at MFA enrollment for account recovery
- FR56: Organization Admins can initiate and approve account recovery for users who have lost MFA device access
- FR57: The system enforces MFA enrollment for Owner and Admin roles in Team and Small Company tier organizations before those roles may invite additional members
- FR60: The system supports configurable vault unsealing via a master password on startup
- FR61: The system enforces organization-scoped data isolation — users in one organization cannot access data belonging to another
- FR73: The system logs all failed authentication attempts and alerts Organization Admins when failed attempts exceed a configurable threshold (default: 10 failed attempts within 5 minutes)
- FR83: Users can view all their currently active sessions and revoke any individual session
- FR84: Organization Admins can revoke all active sessions for any user in their organization
- FR85: The system enforces configurable idle session timeout

**System Administration**
- FR86: Administrators can configure system-level settings through the product UI (SMTP, backup schedule, notification defaults, instance-level policy)
- FR87: Administrators can view current resource usage against subscription tier limits and receive alerts when approaching limits
- FR109: On startup and on a weekly schedule, the system evaluates the master key custody configuration and surfaces a persistent admin dashboard alert if: (a) the master key is stored only as an environment variable with no KMS or escrow configured, AND (b) backup is enabled; the alert states explicitly that backups will be unrecoverable if the host environment is lost, and provides a direct path to configure KMS integration; this condition is also reflected in the readiness endpoint (FR81) as a degraded-configuration warning
- FR103: Platform operator actions on the instance (cross-org incident investigation, instance-level configuration changes, operator-initiated user or org modifications) are logged in a separate immutable platform audit log that is independently verifiable, not visible to org admins, and retained independently of per-org audit log retention policies; the same write-failure invariant applies as to per-org audit logs — platform operator actions fail if the platform audit write fails; an explicit operator-acknowledged maintenance mode exists to temporarily bypass this for emergency recovery, and any such bypass is recorded when the log becomes available
- FR104: Users with rotation initiation permission can remove or archive a dependent system record from a credential's dependency list; removal is recorded in the audit log; archived records are hidden from new rotation checklists but preserved in all historical rotation records where they appeared

**Project Dashboard**
- FR93: The project dashboard surfaces: credential status (active, expiring, expired), upcoming rotation schedule, monitored service health, recent access events, and unresolved alert count — for the currently viewed project

**Notification Preferences**
- FR94: Users can configure personal notification preferences including delivery channel, frequency (per-event or digest), and minimum severity threshold
- FR107: The system maintains a persistent in-product notification inbox per user, surfacing all alerts and system events routed to them (per FR94 preferences) regardless of whether they were also delivered via email or Slack. Inbox entries persist until explicitly dismissed or automatically expire per configurable retention (default: 90 days). Unread count is visible in the global navigation at all times. This provides a no-configuration-required baseline for users relying on the web UI as their primary interface.

**Backup & Restore**
- FR88: The system creates encrypted snapshots of all vault data on a configurable schedule
- FR89: Administrators can configure backup retention policy and storage destination
- FR90: Administrators can restore vault state from a backup snapshot
- FR92: The system monitors backup health and alerts administrators when backups are missed, fail verification, or encounter storage issues; the system also supports an operator-initiated backup restore validation procedure that decrypts and verifies the structural integrity of a selected backup snapshot in an isolated read-only context (without modifying live data), reporting which vault assets are present and verifiable — this procedure is documented in the deployment runbook as a recommended quarterly operation to validate the RTO/RPO guarantee

---

### Phase 2 Additions (2026-07-23, revised twice on 2026-07-23 — four new epics: 13, 14, 15, 16)

*Extracted from prd.md Phase 2 (Extension/Hook Architecture, AGPLv3 licensing boundary, multi-field secrets, i18n, theming) and architecture.md's corresponding decisions/patterns/structure additions. FR99-FR110 above were already covered by existing epics before this pass and needed no new epic — only the following are new. Originally proposed as three epics (13/14/15); a 5-agent review found the i18n+theming bundle (then Epic 15) lacked the shared-module cohesion that justifies bundling (no shared backend module, no shared data model — unlike Epic 6's legitimate bundling of monitored-asset types, which share one alert pipeline), so it's split into Epic 15 (Localization) and Epic 16 (Theming).*

*The AGPLv3/CLA item was initially pulled out as a standalone prerequisite (whole-repo governance, not SSO-specific — bundling process work into a feature epic is the anti-pattern this project's epic-design principles warn against). A follow-up elicitation pass reconsidered this: a standalone story with no epic home is untracked in this project's convention (every retro/rollup happens at the epic level via sprint-status.yaml) and risks silently never getting scheduled. **Resolution: it's Epic 14's Story 0** — not because it's SSO-specific, but because this project tracks work at the epic level and Epic 14 is where it's most urgently needed (see recommended build order below).*

**Recommended build order: Epic 14 → Epic 13 → Epic 15 → Epic 16** (epic numbers are stable identifiers, not a sequencing mandate — same convention as epics 10-12, which weren't built in ID order either). All four epics are independent and could ship in any order; this order reflects business priority, not a dependency. Epic 14 is the business-critical path — the whole Phase 2 initiative traces back to enabling a hosted SaaS business on the Extension API, and AGPLv3 relicensing before any public-facing Extension API ships avoids a disruptive mid-flight relicense for early adopters. Epic 13 (multi-field secrets) has no urgency driving it ahead of that. Epic 15/16 are correctly last — lowest risk, no dependency, no urgency.

**Epic 13 — Secret & Credential Management (amended + new)**
- FR10 (amended): secrets now support one or more named fields (not just a single value); a secret created without a template has one default field — no migration for existing secrets
- FR111: built-in secret templates (Login, Database Connection, API Key, Secure Note, Custom) pre-populate field names; fields addable/renamable/removable regardless of template
- FR112: per-field sensitivity flag (masked/visible-in-list); masked fields require explicit reveal; field keys unique per secret (case-insensitive), rename collision rejected not silently overwritten
- FR12 (amended): a version is the full field-set at a point in time; any field change creates a new version of the whole secret
- FR96 (amended): reveal action can target a specific masked field; audit log records which field(s) were revealed
- FR18 (amended, Rotation & Propagation): rotation can target specific field(s) of a multi-field secret; the resulting version is still a full field-set snapshot; `credential_dependencies` gains an optional field-level scope so the rotation checklist can correctly filter which dependent systems are affected by a partial-field rotation

**Epic 14 — Extension Architecture & Pluggable Authentication**
- **Story 0 (build first, blocks the rest of this epic):** AGPLv3 relicense + CLA setup (LICENSE file, CONTRIBUTING.md/CLA-assistant or equivalent) — see prd.md Licensing & Contribution Model. Whole-repo governance, not SSO-specific, but homed here (not standalone) because this project tracks work at the epic level, and here is where it's urgently needed: relicensing before any public-facing Extension API ships avoids a disruptive mid-flight relicense for early adopters.
- FR113: versioned Extension API with defined extension points (auth-provider, notification-channel, UI-panel) an external package registers against via typed, code-based registration
- FR114: a configured extension package loads at startup if present; system remains fully functional with zero extension packages installed
- FR115 (amended on review): one or more external authentication provider strategies can register via the Extension API, participating in auth alongside the built-in local/MFA strategy (which always remains available); a successful external login resolves to an existing, explicitly-linked identity — never auto-provisioned or auto-linked by email match alone; first-time login with no link requires a pending invitation or explicit OrgAdmin action; MFA enforcement for Owner/Admin applies identically regardless of auth source
- FR116 (deferred — not in this epic's scope): third-party community extensions with declared permission scopes and explicit approval — the loader in this epic only accepts the founder's exact designated private package identity; no general install pathway ships yet. **Journey 7 (Jordan) in prd.md depicts this future state and is explicitly out of scope for this epic's stories** — do not draft acceptance criteria against it.
- Security items required by this epic, not optional hardening: CSRF/state-parameter validation on the SSO callback flow (state stored server-side, short-TTL, single-use, never a bare query param); fixed SSO callback route shape `POST /api/v1/auth/sso/callback/:providerName`; email-first login screen with domain-based SSO routing (`org_sso_domains` lookup)

**Epic 15 — Localization**
- FR117: users select preferred display language from supported locales
- FR118: UI text/dates/notifications render in the user's language, falling back to English for untranslated content; user-generated content (credential names, project names, notes) is never translated, including when interpolated into translated notification templates
- FR119: Organization Admins configure a default locale for newly invited users
- Note: supported locale set is build-time (new language = a deploy); locale *selection* among supported locales is runtime (no rebuild) — these are different mechanisms, keep them distinct in story scoping
- Note: audit log exports remain locale-invariant (ISO 8601 dates, English) regardless of UI locale, to preserve UX-DR13's auditor-comprehensibility requirement

**Epic 16 — Custom Theming**
- FR120: administrators install custom themes as structured (JSON/YAML) definitions in a designated, non-tracked directory — no code changes; theme token values validated against a per-type CSS grammar before compilation (color/length/enum), rejecting anything that doesn't match rather than raw-interpolating into CSS
- FR121: users select the active theme from base + installed custom themes; an admin-deleted theme that's still selected by a user falls back to base theme silently plus a one-time dismissible notice, never a broken UI
- Reload endpoint (`POST /api/v1/admin/themes/reload`, OrgAdmin-only) validates files independently — one malformed file doesn't block others — and reports per-file, specific failure reasons

---

### NonFunctional Requirements

**NFR-PERF1:** Secret fetch (by-id/name): p95 ≤100ms at reference load (20 concurrent human + 10 concurrent machine API calls; 2 vCPU / 4GB RAM / SSD)
**NFR-PERF2:** Secret search/filter: p95 ≤300ms, paginated
**NFR-PERF3:** Dashboard first meaningful content: ≤2s (project list + active warnings rendered)
**NFR-PERF4:** Dashboard load order enforced: (1) status summary → (2) expiry alerts → (3) activity feed → (4) details
**NFR-PERF5:** Rotation initiation: p95 ≤500ms
**NFR-PERF6:** Audit log queries at 1M entries: p95 ≤500ms; required indexes on `(actor_id, timestamp)` and `(project_id, timestamp)`
**NFR-PERF7:** External plugin timeout cap: 3s; max 2 retries with exponential backoff (3s → 6s)
**NFR-PERF8:** Background operations (health checks, rotation) must never block UI
**NFR-PERF9:** Static/versioned UI assets served immutable; API responses no-cache

**NFR-SEC1:** Encryption at rest: AES-256-GCM for all secrets and backups
**NFR-SEC2:** Master key management via environment variable (default); external KMS integration (advanced option)
**NFR-SEC3:** Encryption in transit: TLS 1.3 required for all inbound API connections; TLS 1.2 min / 1.3 preferred for outbound plugin connections
**NFR-SEC4:** Secret values must not appear in logs, stack traces, or error messages (enforced as code review requirement)
**NFR-SEC5:** MFA (TOTP) supported and enforced per policy; machine users authenticate via API key + short-lived JWT (≤1h TTL)
**NFR-SEC6:** Web UI inactivity timeout: 30 minutes, configurable, minimum enforced (non-zero)
**NFR-SEC7:** Audit log: append-only writes; per-entry cryptographic chaining; chain verification API available
**NFR-SEC8:** Audit log access requires Owner or explicit Audit role; Admin access scoped to own projects only
**NFR-SEC9:** RBAC: list/enumerate is a distinct permission from read-value
**NFR-SEC10:** No user may grant permissions exceeding their own role or modify their own role assignment
**NFR-SEC11:** Rate limiting: 120 req/min per authenticated account/API key; 60 req/min per IP unauthenticated
**NFR-SEC12:** API keys ≥256 bits; generated passwords ≥128 bits or policy-defined minimum
**NFR-SEC13:** Critical CVEs patched ≤7 days; high severity ≤30 days
**NFR-SEC14:** Security incidents affecting stored credentials → user notification ≤72h of confirmed incident

**NFR-REL1:** Uptime target: 99.9% (~8.7h downtime/year); requires automatic container restart enabled
**NFR-REL2:** Crash recovery: ≤30s with automatic restart
**NFR-REL3:** All credential operations are atomic; rotation is a compound transaction — all committed or none
**NFR-REL4:** Completed rotation writes synchronously durable
**NFR-REL5:** Audit completeness: 100% — no audit entry dropped under any load condition
**NFR-REL6:** RPO: 24h (backup-based); RTO: 2h with documented runbook

**NFR-SCALE1:** Reference scale (single instance): 50 concurrent users / 100 concurrent API calls / 10,000 secrets / 1,000,000 audit log entries
**NFR-SCALE2:** No clustering or horizontal scaling required in v1; design must not preclude it

**NFR-ACC1:** WCAG 2.1 AA compliance for all UI components
**NFR-ACC2:** Automated accessibility testing tool integrated as CI gate (blocks merge on violations)
**NFR-ACC3:** Top-5 user flows audited manually before launch

**NFR-DI1:** Secret versions are immutable once written (append-only, no overwrite)
**NFR-DI2:** All writes atomic; no partial state persisted
**NFR-DI3:** Backup integrity guaranteed via AES-256-GCM authenticated encryption; checksums verified on restore

**NFR-MAINT1:** Structured JSON logging with configurable log levels
**NFR-MAINT2:** 12-factor app compliance (config via environment, stateless processes, etc.)
**NFR-MAINT3:** Security-sensitive code paths enumerated and tracked in code review checklist
**NFR-MAINT4:** Prometheus-compatible metrics endpoint; defaults to localhost-only binding (configurable)
**NFR-MAINT5:** Multi-arch container builds: AMD64 + ARM64
**NFR-MAINT6:** API v1 compatibility policy: no breaking changes within v1.x
**NFR-MAINT7 (superseded 2026-07-23 — see NFR-I18N1 below):** ~~Internationalization: English-only in v1; no hardcoded strings in UI components~~

**NFR-I18N1 (Phase 2):** No hardcoded strings in UI components; locale switch completes without a page reload; missing translations fall back to English rather than a translation key or blank string; locale files structured for community-contributed translations without core code changes
**NFR-EXT1 (Phase 2):** Extension API is semver-versioned independently of the app; breaking changes require an explicit major bump + changelog + migration note; core performs startup capability-negotiation and fails loudly (not silently) on incompatibility
**NFR-EXT2 (Phase 2, Security):** Third-party community extensions execute in a sandboxed, out-of-process execution environment with no default access to decrypted secret values; capability scopes declared in a manifest, enforced by extension provenance not self-declaration; the founder's first-party private extension is exempt from sandboxing but not from capability declaration
**NFR-THEME1 (Phase 2):** Installing or switching a theme requires no application rebuild and no restart; a malformed theme definition fails validation at load time and falls back to the base theme rather than rendering a broken UI

---

### Additional Requirements

**⚠️ Starter Template — MUST be Epic 1, Story 1**
- **Initialization command:** `pnpm dlx create-turbo@latest project-vault --example with-svelte`
- Manual package additions (`apps/api`, `packages/db`, `packages/crypto`, `packages/shared`) must follow as the second story before any feature implementation begins
- Monorepo structure: `apps/web` (SvelteKit 2 + Svelte 5 + Tailwind CSS v4), `apps/api` (Fastify v5 + pg-boss), `packages/db` (Drizzle ORM), `packages/crypto`, `packages/shared`, `packages/tsconfig`, `packages/eslint-config`

**Technology Stack**
- **Language:** TypeScript throughout (frontend + backend); Node.js 24 LTS
- **Frontend:** Svelte 5 + SvelteKit 2; Tailwind CSS v4
- **Monorepo tooling:** Turborepo + pnpm workspaces; Vite via SvelteKit; tsx for API dev server
- **API framework:** Fastify v5 with `@fastify/swagger` (OpenAPI auto-gen), `@fastify/rate-limit`, `@fastify/jwt`, `@fastify/type-provider-zod`
- **ORM:** Drizzle ORM 0.45.x with `postgres.js` driver; drizzle-kit for migrations; SQL-like DSL maps cleanly to RLS-heavy schema patterns
- **Background jobs:** pg-boss 12.18.2 — PostgreSQL-backed queue (no Redis); exactly-once delivery via SKIP LOCKED; cron scheduling, dead-letter queue, exponential backoff; runs in same Node.js process as API
- **Testing:** Vitest across all packages — unified runner, TypeScript-native
- **Schema as source of truth:** `packages/shared` Zod schemas = single source of truth for API request/response types; `packages/db` schema = single source of truth for database types

**Deployment & Infrastructure**
- Greenfield project; self-hosted Docker / Docker Compose as primary deployment target; single-command setup; 12-factor app compliance required
- PostgreSQL with connection pooling required in production; org_id on every entity enforced via PostgreSQL Row-Level Security (RLS) at database level — enforcement is structural, not conventional; applies to both HTTP request context and background job execution context
- Multi-arch container builds: AMD64 + ARM64
- REST API first — all UI functionality API-backed; versioned (/api/v1/); OpenAPI spec published with OSS release; no privileged UI-only operations

**Encryption & Key Management**
- AES-256-GCM encryption at rest for all secrets and backups
- Master key provided as a mounted file path at first-run initialization; envelope encryption (split key: half from env var, half from a separate host filesystem path) offered as stronger default at initialization ceremony; KMS integration is the advanced option
- Encryption layer abstracted for future CMK migration without re-encryption
- Audit log encryption key is separate from master key — derived via HKDF with a distinct info string; independent rotation lifecycle; per-entry key version stored; old master key versions retained in key history store after rotation

**Audit Log Architecture**
- Two distinct event log tables: *Security audit log* (intentional human/machine actions on protected resources — same-transaction writes, append-only, row-level checksums, PII externalized, compliance export, write-once export) and *Operational event log* (automated system process events — health checks, background jobs, scheduler; high write volume, independent retention, not tamper-evident)
- Audit writes are in the same transaction as the operation they record — operation fails if audit write fails; 100% capture guarantee is an architectural invariant
- Audit log storage monitoring with alerts at 80%, 90%, 95% capacity; documented maintenance mode (read-only secret access while audit writes suspended); tested recovery procedure in deployment guide
- Audit log PII externalized at schema level — entries reference a mutable `user_identity_token` table; pseudonymization on deletion modifies identity table only, leaving audit rows and checksums unchanged
- **Required indexes to support FR41's 5-dimensional filtering within NFR-PERF6 (p95 ≤500ms at 1M entries):** `(actor_id, timestamp)`, `(project_id, timestamp)`, `(event_type, timestamp)`, `(resource_id, timestamp)` — all four composite indexes required; queries combining multiple dimensions must use query planner hints or be tested explicitly against the 1M-entry benchmark

**Security Architecture**
- Constant-time comparisons for all secret/token operations; memory zeroing after secret use; secret values must not appear in logs/stack traces (enforced as code review requirement); secret-touching code paths enumerated
- Sealed route/handler constructor (`SecureRoute`) applies all cross-cutting concerns (RBAC, org_id, audit, rate limiting, memory safety) by default; concerns opted out explicitly with named flags — developer cannot create an unsecured route by forgetting middleware; applies to both HTTP handlers and background job execution contexts
- Rate limiting: 120 req/min per authenticated account/API key; 60 req/min per IP unauthenticated; CI/CD burst accommodated
- Unified authorization context: project-scoped RBAC + org-scoped subscription tier limits evaluated at a single framework gate per request; tier state cached with ≤60s TTL
- **JWT immediate invalidation on deactivation/session revocation:** JWT claims include a `session_version` integer stored per user in the database. On account deactivation or explicit session revocation, the stored version increments. All endpoints accessing secrets or performing writes validate `session_version` against the live database value. A short-TTL revocation table (DB table with TTL index or Redis) holds actively revoked JWTs for the remainder of their 5-minute TTL window. This ensures FR45's "immediate revocation" guarantee is actually achievable with the 5-minute JWT TTL architecture.
- **Multi-org RLS correctness testing:** Multi-org data isolation (FR61) must be verified by an automated integration test suite (`rls-isolation.test.ts` or equivalent) that executes every collection query and export path as a user from Org A and asserts that zero records from Org B are returned — this suite runs as a required passing check in CI. The existing `check-rls-coverage.ts` guard verifies RLS *presence* on all tables; this suite verifies RLS *correctness* for all query patterns. Both are required; one does not substitute for the other.

**Plugin System**
- Plugin process isolation: separate processes; 3s timeout cap; max 2 retries with exponential backoff (3s → 6s)
- Plugin IPC secret delivery via localhost PSK TLS socket — plugins never receive plaintext via pipe/socket IPC; plugins request values via scoped execution token API; token expires at execution end
- Plugin permissions are context-bound (scoped execution token derived from rotation context: credential ID, project ID, execution ID); gateway enforces scope; threat model boundary documented
- Plugin interface defined and documented in v1; provider implementations deferred to v2
- **Total plugin execution budget per rotation event:** 60s aggregate cap (configurable, minimum 10s per plugin, maximum 3 plugins in default config). Plugin execution for rotation is always async from the rotation state machine write — rotation transitions to `complete` synchronously; plugin notifications are best-effort post-commit. If the aggregate budget is exceeded, remaining plugins are cancelled, their status recorded as `timed-out` in the rotation history, and an alert sent to FR100-configured recipients.

**Rotation State Machine**
- PostgreSQL advisory locks on credential ID as primary concurrency mechanism for rotation (prevents concurrent in-progress rotation on same credential); serializable isolation as fallback
- Compound rotation transaction (new version + rotation log + per-system checklist state + notification queue entry) must be atomic in all cases
- **Stale rotation recovery:** A startup recovery job and periodic background check (every 15 minutes) scan for rotations in `in_progress` state older than a configurable stale threshold (default: 1h). Stale rotations are transitioned to `stale-recovery` status, all pending dependent-system confirmations reset to unconfirmed, and the initiating admin plus FR100-configured recipients notified. The rotation can be restarted or cancelled from `stale-recovery` state. This is the operational trigger for the `rotation:recover` singletonKey.

**Machine User & Offline Cache**
- Offline cache: per-secret fallback eligibility (high-sensitivity secrets explicitly excluded); revocation list cached alongside secrets at last vault contact; residual risk: revocations during active vault downtime take effect after cache TTL expires
- v1.1 target: break-glass revocation endpoint with different availability profile; lightweight, read-only from credential store, write-only to signed revocation list; machine users check on each secret fetch

**Background Processing**
- Background jobs (health checks, rotation, monitoring) run in separate thread/process pool from request handling; org_id context enforced via same PostgreSQL RLS mechanism as HTTP requests; must not block UI

**Multi-Field Secrets Data Model (Phase 2, from architecture.md — Epic 13)**
- `credential_versions.fields` — JSONB column, whole field-set encrypted as one envelope (same `{version, iv, ciphertext, tag}` format as every other encrypted field); `credential_versions.field_meta` — unencrypted JSONB (field keys/sensitivity/template, unique keys per secret), nullable
- **`credential_versions.schema_version smallint NOT NULL DEFAULT 1`** — the authoritative format discriminator (1=legacy bare string, 2=field-set JSON), not `field_meta`'s nullability (revised on review: a nullable column doing double duty as data and version-marker was fragile). Legacy rows decrypt exactly as today (bare string, not JSON) and are wrapped into the field-set response shape at the application layer — the stored ciphertext is never touched. Genuinely migration-free but not by "old rows already contain JSON" (a corrected assumption — see architecture.md validation notes)
- `credentials.current_version_id` — explicit FK, flipped atomically in the existing rotation-completion compound transaction, never derived via `MAX(created_at)`; **one-time backfill migration required** (same pattern as `check-rls-coverage.ts`) setting it to each pre-existing credential's latest version — without this, pre-Phase-2 credentials never rotated since would have a permanently NULL pointer
- `rotations.target_fields text[]` — nullable; NULL = whole-secret rotation, non-null = specific field keys targeted
- `credential_dependencies.field_key text` — nullable; NULL = dependency applies to the whole credential, non-null = scoped to that field. Closes a gap where field-scoped rotation had no data-model support for computing which dependencies are actually affected by a partial-field change
- Field-scoped rotation reuses the existing credential-level advisory lock and `409 ROTATION_IN_PROGRESS` — no new concurrency primitive
- Field-level reveal audit: `audit_log_entries.revealed_fields text[]`, populated only on `CREDENTIAL_VALUE_REVEALED`; machine reveal route gains an optional `?field=` query param
- `.env`/JSON bulk import creates single-field secrets only, one per imported key — no automatic grouping into multi-field secrets

**Extension / Hook Architecture (Phase 2, from architecture.md — Epic 14)**
- New workspace package `packages/extension-api`: `defineExtension()`, typed hook interfaces (`AuthStrategy`, `NotificationChannel`, `UIPanel`), `registerExtension(manifest, hooksFactory)` — `hooksFactory` is a **lazy factory**, invoked only after capability negotiation passes, so zero extension code runs before the gate
- Loading: `apps/api/src/extensions/loader.ts` reads `VAULT_EXTENSIONS_PACKAGE` env var; absent = zero behavior change (tested default for self-hosted); a failed load does not crash core — surfaces as `extensions_status: "load_failed"` on `GET /health` (FR81) plus an `AuditEvent.EXTENSION_LOAD_FAILED` entry (fixed-enum reason, never a raw stack trace)
- Auth hooks: `registerAuthStrategy()` Fastify decorator in `modules/auth/strategies.ts`; local strategy always index 0; `authStrategies` is a list core always iterates — extension presence changes data, never the code path
- **Identity binding (added on review — closes the sharpest gap found):** `AuthResult` asserts `{externalSubject, providerName, email?, displayName?}`, never a bare `userId`. New table `external_identities` (org_id, user_id FK, provider_name, external_subject) resolves it. No auto-link-by-email — first-time external login with no existing link requires a pending invitation or explicit OrgAdmin action.
- **CSRF/state validation on the SSO callback** — server-generated `state`/`RelayState`, stored server-side keyed to a short-TTL single-use httpOnly cookie, validated before `onAuthenticate()` runs. Fixed callback route: `POST /api/v1/auth/sso/callback/:providerName`.
- **Login UI:** email-first — email domain resolves to an org's SSO config (`org_sso_domains` table) before showing SSO redirect vs. password field
- `GET /api/v1/admin/extensions/status` — returns the loaded extension's manifest or null; backs the `(app)/admin/extensions/` status/audit view (no install UI — loader is origin-locked to the founder's designated package only)
- `capabilities[]` in the manifest is informational/audit-only this phase, not an enforced authorization boundary — **with a stated forcing function**: the future community-extension sandboxing work item's Definition of Done explicitly includes flipping this to enforced, so it isn't silently forgotten

**Internationalization (Phase 2, from architecture.md — Epic 15)**
- Paraglide JS (`@inlang/paraglide-js`), `apps/web/messages/{locale}.json`; supported locale set is build-time (new language = deploy), locale *selection* is runtime (no rebuild)
- User-generated content (credential/project names, notes) is never translated, including when interpolated into translated notification templates
- Audit exports remain locale-invariant (ISO 8601, English) regardless of UI locale, to protect UX-DR13's auditor-comprehensibility requirement

**Theming (Phase 2, from architecture.md — Epic 16)**
- Tailwind v4 native `@theme` CSS custom properties; `VAULT_THEMES_DIR` env var (default `/data/themes`, inside the persistent Docker volume, not the image); explicit `POST /api/v1/admin/themes/reload` trigger (OrgAdmin-only) — no filesystem watcher; per-file validation with specific failure reasons, one bad file doesn't block others
- Theme asset URLs validated against the existing webhook SSRF blocklist at install/reload time (browser fetches assets directly — no server-side proxy, so no per-request re-validation needed)
- Theme token values validated against a per-type CSS grammar before compiling into custom properties — prevents CSS injection via a hostile theme file
- Admin-deleted-but-still-selected theme falls back to base theme silently plus a one-time dismissible notice — never a broken UI

**Licensing (Phase 2, from prd.md — Epic 14 Story 0, see epic definition above)**
- Core license: AGPLv3; requires a CLA from external contributors (not a bare DCO). Whole-repository governance, homed in Epic 14 as Story 0 for tracking reasons (this project tracks work at the epic level), not because it's SSO-specific — build it first, before FR113-115.
- Not an engineering task per se, but repo-level LICENSE file and CONTRIBUTING.md/CLA setup should land alongside or before this epic if not already in place — flagged for story-level scoping in the next step

---

### UX Design Requirements

- **UX-DR1:** Onboarding wizard enforces project-centric model through structure (never shows an environment layer); wizard is bypass-proof and completes only after the user successfully places at least one real credential; acceptance criterion: ≥80% correct placement of a second credential without prompting
- **UX-DR2:** Dashboard design must clearly separate monitoring mode (single-glance 15–30 second scan optimized for "nothing needs attention" signal) from action mode (step-by-step focused flows with progress indicators); surfaces must not blend modes
- **UX-DR3:** All security-critical configuration flows (machine user scoping, vault unsealing, rotation policy, MFA recovery, account deletion with transfer) follow the principle: correct/most secure path = default path; inline contextual education at every decision point as primary UI content (not tooltips or help center)
- **UX-DR4:** Alert system implements intelligent default urgency calculation from context (e.g., "SSL cert expires in 4 days — no renewal recorded" not just "SSL cert expires in 30 days"); users should rarely need to configure notifications to receive appropriately signal-quality alerts
- **UX-DR5:** Project view surfaces absent asset categories alongside present ones (coverage gaps); project health score or coverage indicator shows which expected asset categories are populated; reaching complete coverage must be a visible, rewarding milestone
- **UX-DR6:** Credential import experience shows a review screen with full field mapping, conflicts surfaced, and nothing committed until user confirmation; converts migration anxiety into trust-building moment
- **UX-DR7:** Credential creation flow includes inline dependency prompting ("Which systems or services use this credential?") with a fast-add interaction — not a separate settings screen; credentials with no recorded dependencies are flagged as coverage gaps
- **UX-DR8:** Global search-first credential retrieval resolves credentials by name in under 3 keystrokes from anywhere in the product; navigation is for exploration, search is for retrieval — these are distinct modes
- **UX-DR9:** Operational assets with time-sensitive properties (services, certificates, domains, credentials with expiry dates) automatically enroll in monitoring and alerting when registered — no configuration step required; users opt out of defaults, never opt in
- **UX-DR10:** Mobile incident response must meet: alert deep-links resolve to affected resource in ≤2 taps from notification; rotation status and version-per-system visible without horizontal scrolling on mobile; confirmation, note, and escalation actions available without a full keyboard; 24-hour audit trail accessible within 3 taps from affected resource
- **UX-DR11:** Machine user creation flow presents concrete, reviewable scope boundary before API key issuance — showing explicitly what the machine user can AND cannot access; scope expansion requires deliberate additional step; key immutability after scope change is explicitly communicated at confirmation
- **UX-DR12:** Buyer/governance view distinct from operator project dashboard surfaces: team access summary, compliance readiness indicators (MFA enrollment by role, audit log health, expiring org-level credentials), recent security events, subscription usage; exportable and shareable with non-engineering stakeholders
- **UX-DR13:** Audit log integrity verification is a mandatory first step in every compliance export flow (not optional); verification result travels with the exported file; verification output is comprehensible to a non-cryptographer and acceptable to an auditor
- **UX-DR14:** Every empty/zero state communicates project potential — shows asset categories that belong here and offers a direct path to first action; an empty project must never appear as a dead end
- **UX-DR15:** Responsive web application — same product adapts to desktop, tablet, and mobile; information density adapts to viewport; no interaction requires a specific device or input method; WCAG 2.1 AA is a baseline, not an enhancement

**⚠️ Gap (2026-07-23):** No UX Design Specification update accompanied Phase 2 — `ux-design-specification.md` was not touched during the PRD/architecture amendment. The new admin surfaces (`(app)/admin/extensions/`, `(app)/admin/themes/`, `(app)/settings/language/`) have architectural placement but no interaction/visual design treatment. Existing UX-DR3 (correct-path-is-default-path for security-critical config) plausibly extends to the extensions/themes admin views, but this hasn't been confirmed with a UX pass. Flagging for story-level scoping — stories touching these surfaces may need a lightweight UX review step, or explicit acceptance that they follow existing admin-panel conventions without new UX-DR coverage.

---

### FR Coverage Map

| FR | Epic | Domain |
|----|------|--------|
| FR1 | Epic 2 | Project creation |
| FR2 | Epic 4 | Team invitations |
| FR3 | Epic 4 | Multi-role membership |
| FR4 | Epic 4 | Ownership transfer |
| FR5a | Epic 4 | Org user visibility |
| FR5b | Epic 4 | Org user removal |
| FR5c | Epic 4 | Org role management |
| FR6 | Epic 9 | Multi-org configuration |
| FR7 | Epic 2 | Cross-project dashboard |
| FR8 | Epic 2 | Project notes |
| FR9 | Epic 2 | Onboarding wizard |
| FR10 | Epic 2 | Credential storage |
| FR11 | Epic 2 | Credential retrieval |
| FR12 | Epic 2 | Version history |
| FR14 | Epic 2 | Credential search/filter |
| FR15 | Epic 2 | Expiry & rotation schedules |
| FR16 | Epic 2 | Dependent system recording |
| FR17 | Epic 2 | Bulk import |
| FR18 | Epic 5 | Rotation initiation |
| FR19 | Epic 5 | Rotation checklist generation |
| FR20 | Epic 5 | Checklist confirmation |
| FR21 | Epic 5 | Rotation completion guard |
| FR22 | Epic 5 | Old version retirement |
| FR23 | Epic 5 | Rotation history |
| FR24 | Epic 6 | Service records |
| FR25 | Epic 6 | SSL certificate records |
| FR26 | Epic 6 | Domain records |
| FR27 | Epic 6 | HTTP endpoint monitoring |
| FR28 | Epic 6 | Alert thresholds & lead times |
| FR29 | Epic 6 | Proactive expiry alerts |
| FR31 | Epic 6 | Anomalous access alerts |
| FR32 | Epic 7 | Machine user creation |
| FR33 | Epic 7 | API key issuance/revocation |
| FR34 | Epic 7 | Machine user authentication |
| FR35 | Epic 7 | Programmatic secret retrieval |
| FR36 | Epic 7 | Machine user audit trail |
| FR37 | Epic 7 | Offline fallback cache |
| FR38 | Epic 7 | Fallback cache audit & alerts |
| FR39 | Epic 7 | CI/CD integrations |
| FR40 | Epic 8 | Append-only audit log |
| FR41 | Epic 8 | Audit log search/filter |
| FR42 | Epic 8 | Audit log export |
| FR43 | Epic 8 | External audit log forwarding |
| FR44 | Epic 8 ⚠️ | Audit log pseudonymization (user-facing flow Epic 8; `user_identity_token` schema is an Epic 1 architectural prerequisite) |
| FR45 | Epic 4 | Account deactivation |
| FR46 | Epic 1 | Web browser interface |
| FR47 | Epic 9 | REST API parity verification + OpenAPI finalization (API endpoints built with feature epics 1-8) |
| FR48 | Epic 9 | OpenAPI specification |
| FR49 | Epic 1 | Docker deployment |
| FR50 | Epic 9 | In-place version upgrades |
| FR51 | Epic 3 | Email notifications |
| FR52 | Epic 3 | Slack notifications |
| FR53 | Epic 1 | Account creation & auth |
| FR54 | Epic 1 | TOTP MFA enrollment |
| FR55 | Epic 1 | MFA recovery codes |
| FR56 | Epic 4 | Account recovery workflow |
| FR57 | Epic 1 | MFA enforcement by role (verified in Epic 4 when invitations land) |
| FR60 | Epic 1 | Vault unsealing |
| FR61 | Epic 1 | Org-scoped data isolation |
| FR62 | Epic 4 | Project member removal |
| FR63 | Epic 4 | Project archival (machine user dependency guard completed in Epic 7) |
| FR64 | Epic 2 | Credential access visibility |
| FR65 | Epic 5 | Rotation schedule view |
| FR66 | Epic 5 | Live rotation status |
| FR67 | Epic 6 | Alert dismiss/snooze |
| FR68 | Epic 7 | Machine user key expiry |
| FR69 | Epic 8 | Point-in-time access report |
| FR70 | Epic 8 | Audit log retention config |
| FR71 | Epic 8 | Dormant user detection |
| FR72 | Epic 6 | Mobile browser support (primary use case: mobile incident response) |
| FR73 | Epic 1 | Failed auth alerting (delivered via Epic 3 notification infrastructure) |
| FR75 | Epic 5 | Rotation confirmation failure handling |
| FR76 | Epic 6 | Cross-project health status page |
| FR77 | Epic 6 | Public status page |
| FR78 | Epic 8 | Audit log integrity verification |
| FR80 | Epic 2 | Cross-project global search |
| FR81 | Epic 1 | Health & readiness endpoint |
| FR82 | Epic 1 | Structured operational logs |
| FR83 | Epic 1 | Session management |
| FR84 | Epic 1 | Org-level session revocation |
| FR85 | Epic 1 | Idle session timeout |
| FR86 | Epic 9 | System settings configuration |
| FR87 | Epic 9 | Resource usage monitoring |
| FR88 | Epic 9 | Encrypted backup schedule |
| FR89 | Epic 9 | Backup retention & destination |
| FR90 | Epic 9 | Backup restore |
| FR92 | Epic 9 | Backup health monitoring & restore validation |
| FR93 | Epic 2 | Project dashboard |
| FR94 | Epic 3 | Notification preferences |
| FR95 | Epic 2 | Tags management |
| FR96 | Epic 2 | Secret reveal with audit |
| FR97 | Epic 9 | API pagination & filtering |
| FR98 | Epic 2 | Empty project state |
| FR99 | Epic 6 | Service recovery notifications |
| FR100 | Epic 3 | Per-alert-type routing |
| FR101 | Epic 7 | Zero-downtime key rotation |
| FR102 | Epic 8 | Recovery & deactivation audit trail |
| FR103 | Epic 9 | Platform operator audit log |
| FR104 | Epic 5 | Dependency removal/archival |
| FR105 | Epic 2 | Version retention policy |
| FR107 | Epic 3 | In-product notification inbox |
| FR108 | Epic 5 | Break-glass emergency rotation |
| FR109 | Epic 9 | Key custody risk alert |
| FR110 | Epic 7 | Machine user key dormancy |
| FR10 (amended) | Epic 13 | Multi-field secret storage |
| FR111 | Epic 13 | Secret templates |
| FR112 | Epic 13 | Per-field sensitivity/masking |
| FR12 (amended) | Epic 13 | Whole-field-set versioning |
| FR96 (amended) | Epic 13 | Field-scoped reveal + audit |
| FR18 (amended) | Epic 13 | Field-scoped rotation |
| FR113 | Epic 14 | Extension API package |
| FR114 | Epic 14 | Extension loader |
| FR115 (amended) | Epic 14 | Auth extension hooks + identity binding |
| FR116 (deferred) | — | Community extensions — out of Epic 14 scope; Journey 7 is aspirational |
| FR117 | Epic 15 | Locale selection |
| FR118 | Epic 15 | Localized rendering + fallback |
| FR119 | Epic 15 | Org default locale |
| FR120 | Epic 16 | Theme installation |
| FR121 | Epic 16 | Theme selection |

---

## Definition of Done

Every story must satisfy **all** of the following before it is considered complete. These are non-negotiable quality gates enforced by CI — a story is not done if CI is red.

### Testing
- All BDD acceptance criteria are covered by automated tests using Vitest
- Unit tests cover all business logic (pure functions, service layer, validators)
- Integration tests cover all API endpoints and database interactions using a real test database (no mocks for DB layer)
- Mutation score ≥ 80% on all code touched by the story (Stryker + `@stryker-mutator/vitest-runner`)
- No test may use `skip`, `todo`, or `.only` markers in committed code

### Code Quality
- Zero ESLint errors (config: `@typescript-eslint/recommended-strict`, `eslint-plugin-security`, `eslint-plugin-sonarjs`)
- Zero Prettier formatting violations
- Cyclomatic complexity ≤ 10 per function (ESLint `complexity` rule)
- Cognitive complexity ≤ 15 per function (`sonarjs/cognitive-complexity`)
- Code duplication: zero blocks above threshold (jscpd: min-lines 5, min-tokens 50, cross-file)
- TypeScript strict mode: zero errors, zero `any` casts without explicit `// eslint-disable` justification comment
- No `console.log` or unstructured log output (enforced via ESLint `no-console` rule)

### Security
- `npm audit --audit-level=high` passes (zero high or critical vulnerabilities)
- Trivy filesystem scan passes (zero HIGH/CRITICAL CVEs in dependencies)
- Trivy Docker image scan passes (zero HIGH/CRITICAL CVEs in built image)
- `eslint-plugin-security` zero violations
- No secret values, credential material, or PII in any log output (code review gate + ESLint `no-secrets` rule)

### Docker & Deployment
- `docker compose up` starts all services cleanly from a cold state
- `/health` and `/ready` endpoints return 200 after container startup
- Container passes its own Docker health check within 30 seconds of start
- Multi-arch build succeeds: `linux/amd64` and `linux/arm64`
- No hardcoded environment values — all config via environment variables (12-factor)

### Pre-commit & CI Gates (all enforced as required checks — PR cannot merge if any fail)
- Husky pre-commit: lint-staged runs ESLint + Prettier on staged files
- CI: TypeScript compile (`tsc --noEmit`)
- CI: Vitest test suite (all packages)
- CI: Stryker mutation score gate
- CI: jscpd duplication report (fails on threshold breach)
- CI: `npm audit` + Trivy scans
- CI: Docker build + health check smoke test
- CI: Accessibility gate (axe-core via Playwright, blocks on WCAG 2.1 AA violations — UI stories only)

### Documentation
- Public API changes reflected in OpenAPI spec (auto-generated via `@fastify/swagger`)
- Any non-obvious implementation decision has a single-line comment explaining WHY (not what)

---

## Epic List

### Release Scope Summary

| Epic | Beta Tier | Release Gate |
|------|-----------|-------------|
| Epic 1: Vault Foundation | 🟢 Tier 0 — Solo/Evaluator beta | Required for any beta |
| Epic 2: Secret & Credential Management | 🟢 Tier 0 — Solo/Evaluator beta | Required for any beta |
| Epic 3: Notification Infrastructure | 🟢 Tier 0 — Solo/Evaluator beta | Hard dependency on E2; must follow E1 immediately |
| Epic 4: Team & Org Management | 🔵 Tier 1 — Team beta | Required for multi-user scenarios |
| Epic 5: Credential Rotation | 🟣 Tier 2 — Operational beta *(recommended beta target)* | Differentiates from a password manager |
| Epic 6: Operational Monitoring | 🟣 Tier 2 — Operational beta *(recommended beta target)* | Completes proactive alert story |
| Epic 7: Machine User Access | ⚪ v1 GA | Blocked on FR37 SDK scope decision |
| Epic 8: Compliance, Audit & Governance | ⚪ v1 GA | Enterprise features; audit log writes from day 1 |
| Epic 9: Platform Operations, API & Self-Hosting | ⚪ v1 GA | Production hardening; requires stable feature API |
| Epic 14: Extension Architecture & Pluggable Authentication | 🟠 Phase 2 | Recommended build order: first of the four Phase 2 epics — business-critical path (enables the hosted SaaS model); Story 0 (AGPLv3 relicense) blocks the rest of this epic |
| Epic 13: Structured Multi-Field Secrets | 🟠 Phase 2 | Independent of Epic 14; no urgency driving it ahead |
| Epic 15: Localization | 🟠 Phase 2 | Independent; lowest risk |
| Epic 16: Custom Theming | 🟠 Phase 2 | Independent; lowest risk |

**Recommended beta target:** Epics 1–6 with within-epic cuts (see notes per epic) ≈ 55 FRs.
**Post-beta v1 GA:** Epics 7–9 complete the full feature set.

---

### Epic 1: Vault Foundation — Deployment, Authentication & Core Platform
**🟢 Tier 0 — Required for all beta tiers**
Users can deploy the vault on self-hosted infrastructure via Docker, create accounts, authenticate securely with MFA, manage sessions with idle timeout and explicit revocation, and operate the vault with health/readiness endpoints and structured operational logging. This epic establishes the prerequisite foundation — including the `user_identity_token` schema for audit PII externalization — for all subsequent epics.

**FRs covered:** FR46, FR49, FR53, FR54, FR55, FR57, FR60, FR61, FR73, FR81, FR82, FR83, FR84, FR85
> ⚠️ FR57 (MFA enforcement before inviting members) is implemented here; its full acceptance criteria are verified in Epic 4 when the invitation flow is delivered.
> ⚠️ FR44 (`user_identity_token` schema): user-facing pseudonymization flow is Epic 8; the schema itself is an architectural prerequisite built in this epic.
> ⚠️ **Dependency gate:** FR73 (failed auth alerting) is built in this epic but is functionally inert until Epic 3 (notification infrastructure) is delivered. Epic 3 should be targeted for the sprint immediately following Epic 1. Until Epic 3 is live, all alert channels must be stubbed with an explicit "PENDING: Epic 3" marker so the team knows alerts are intentionally silent — not dropped silently.
> ⚠️ **PJ6 — `user_identity_token` enforcement:** The `user_identity_token` schema is created in this epic. All subsequent epic stories that write audit events must use token references — not raw user identity. Story templates for Epics 2-7 must include an explicit audit-event checklist item: "actor stored as `user_identity_token` reference, not raw identity."
> 📋 **AC-E1a — FR60 seal/unseal semantics:** Story must specify: (a) unseal is manual-only on startup; (b) vault auto-seals on unexpected shutdown/crash; (c) auto-seal requires manual unseal before any API or UI request is served. If auto-seal-on-crash is out of v1 scope, document explicitly.
> 📋 **AC-E1b — FR82 log schema:** Story must define the required JSON fields (minimum: `timestamp`, `level`, `service`, `trace_id`, `event_type`, `message`). Any structured log output lacking required fields fails acceptance.
> 📋 **AC-E1c — FR57 MFA enforcement point:** MFA is enforced at **privileged routes** for owner/admin roles after the enrollment grace period expires (`requireMfaEnrollment()` / `SecureRoute({ requireMfa: true })`). Users **with** MFA enrolled must complete the login challenge (`mfaRequired` → `verify-login`) before receiving a session. Users **without** MFA after grace may still complete password-only login but cannot perform privileged actions until enrolled (Option A — see `_bmad-output/planning-artifacts/mfa-policy-matrix.md`, ADR-1.9-05). Grace period duration: `MFA_PRIVILEGED_ROLE_GRACE_DAYS` (default 7). Full FR57 invite gate verified in Epic 4 Story 4.1.

#### Story 1.1: Initialize Turborepo Monorepo with Full Quality Gate Suite

**As a** developer setting up the Project Vault codebase for the first time,
**I want** the project initialized as a Turborepo monorepo with all quality gates, CI enforcement, and Docker infrastructure configured,
**So that** every subsequent story is written, tested, and merged against a real, automated quality baseline from day one.

**Acceptance Criteria:**

**Given** a clean environment with Node.js 24 LTS and pnpm 9+ installed,
**When** the developer runs `pnpm dlx create-turbo@latest project-vault --example with-svelte`,
**Then** the monorepo is scaffolded with `apps/web` (SvelteKit 2 + Svelte 5 + Tailwind CSS v4) and Turborepo pipeline configuration.

**And** the following workspace packages are present and configured with TypeScript strict mode:
- `apps/web` — SvelteKit 2 + Svelte 5 + Tailwind CSS v4
- `apps/api` — Fastify v5 skeleton (empty routes, server start/stop)
- `packages/db` — Drizzle ORM 0.45.x + `postgres.js` driver (empty schema, migration runner wired)
- `packages/crypto` — empty module with placeholder export
- `packages/shared` — empty Zod schema module
- `packages/tsconfig` — base TypeScript configs (`base.json`, `svelte.json`, `node.json`) with `strict: true`, `noUncheckedIndexedAccess: true`
- `packages/eslint-config` — shared ESLint flat config (see lint gate below)

**And** `turbo build`, `turbo dev`, `turbo lint`, `turbo test`, and `turbo typecheck` all execute from the repo root without errors.

**And** the `apps/web` dev server starts and serves a default page at `localhost:5173`.

**And** `apps/api` starts and responds to `GET /health` → `200 { status: "ok" }` at `localhost:3000`.

**— Lint & Code Quality Gate —**

**Given** the `packages/eslint-config` shared config is installed,
**When** ESLint runs across all packages,
**Then** it enforces: `@typescript-eslint/recommended-strict`, `eslint-plugin-security` (all rules warn-or-error), `eslint-plugin-sonarjs` (cognitive-complexity ≤ 15, no-duplicate-string, no-identical-functions), `eslint/complexity` (max: 10), `no-console`.

**And** `eslint-plugin-no-secrets` is configured with `entropyThreshold: 4.5` and an allowlist pattern covering UUIDs (`[0-9a-f]{8}-[0-9a-f]{4}-…`), hex hashes (≤ 64 chars), and base64 test fixtures annotated with `// test-fixture`; default config is explicitly forbidden (produces too many false positives on migration hashes and test data).

**And** Prettier is configured at the repo root (`.prettierrc`) and `eslint-config-prettier` disables conflicting ESLint rules.

**And** running `turbo lint` on the initial scaffold produces zero errors and zero warnings.

**— Testing Gate —**

**Given** Vitest is configured in each package (`vitest.config.ts` extending a shared base),
**When** `turbo test` runs,
**Then** all test suites pass (initial scaffold has at minimum one passing smoke test per package).

**And** coverage reporting is configured (V8 provider); per-package thresholds enforced on PR: lines ≥ 80%, branches ≥ 80%, functions ≥ 80%, statements ≥ 80% — failing the suite if unmet.

**— Mutation Testing Gate —**

**Given** Stryker is configured at the repo root (`stryker.config.mjs`) with `@stryker-mutator/vitest-runner`,
**When** the nightly CI schedule or a merge to `main` triggers the mutation job,
**Then** the mutation score for each package is reported; the gate fails if any package with more than 10 lines of non-trivial logic scores below 60% (initial threshold); this threshold is documented to ratchet to 80% after Epic 2 is complete.

**And** Stryker only runs on packages whose `src/` contains logic files (excludes packages with only re-exports, type declarations, or config); the initial scaffold correctly reports 0 packages in scope with a `no mutants found` pass.

**And** the Stryker config excludes: generated files, migration files, `*.config.*` files, and `*.d.ts` files.

**And** mutation CI runs as a **scheduled nightly job** and on merge to `main` — it does NOT run on every PR (to keep PR fast-path ≤ 10 minutes); PRs gate on coverage thresholds instead.

**— Code Duplication Gate —**

**Given** jscpd is configured (`.jscpd.json`: `minLines: 5`, `minTokens: 50`, `threshold: 0`) across all `src/` directories,
**When** `pnpm jscpd` runs,
**Then** zero duplicate blocks are reported; CI fails on any detected duplication above threshold.

**— Security Scanning Gate —**

**Given** all dependencies are installed,
**When** `audit-ci` runs (configured in `audit-ci.jsonc` with `--high` level),
**Then** zero high or critical vulnerabilities are reported; `audit-ci` is used instead of raw `npm audit` to enable baseline tracking — new vulnerabilities introduced by a PR cause CI to fail even if pre-existing ones are acknowledged.

**And** Trivy filesystem scan runs in CI against the repository; zero HIGH or CRITICAL CVEs cause CI to fail.

**And** Trivy Docker image scan runs against the built production image; zero HIGH or CRITICAL CVEs cause CI to fail.

**And** all Dockerfiles pin the base image to a specific digest (e.g., `node:24-alpine@sha256:…`), not a mutable tag; a `base-image-update` script or documented weekly procedure exists for rotating the pinned digest.

**— Docker Gate —**

**Given** a `docker-compose.yml` at the repo root defines: `api` service (Fastify), `web` service (SvelteKit), `db` service (PostgreSQL 16),
**When** `docker compose up --build` runs from a cold state,
**Then** all three containers reach a healthy state as defined by their Docker `HEALTHCHECK` directives within 60 seconds.

**And** the `db` service has a `HEALTHCHECK` using `pg_isready -U ${POSTGRES_USER}`; the `api` service declares `depends_on: db: condition: service_healthy` so the API never attempts a DB connection before Postgres is ready — eliminating timing-dependent crash-loops.

**And** `GET http://localhost:3000/health` returns `200 { status: "ok" }` (liveness — always responds if the process is alive).

**And** `GET http://localhost:3000/ready` returns `200 { status: "ready" }` when the DB connection is verified, or `503 { status: "unavailable", reason: "db" }` when the DB is unreachable; this contract is the established pattern for all future dependency checks added in subsequent stories.

**And** the Docker health check (`HEALTHCHECK CMD curl -f http://localhost:3000/health`) passes within 30 seconds of container start.

**And** multi-arch builds succeed via `docker buildx` with the `docker-container` driver (not the default driver); the CI job explicitly creates this builder before the build step with `docker buildx create --use --driver docker-container`; `docker buildx build --platform linux/amd64,linux/arm64` completes without error for both `apps/api` and `apps/web`.

**And** no environment values are hardcoded in any Dockerfile or `docker-compose.yml`; all config is injected via environment variables with a documented `.env.example` at the repo root.

**— Pre-commit Hook Gate —**

**Given** Husky is installed and `lint-staged` is configured,
**When** a developer attempts a git commit,
**Then** lint-staged runs ESLint + Prettier on all staged `.ts`, `.svelte`, and `.js` files; the commit is blocked if any check fails.

**— CI Pipeline Gate —**

**Given** a GitHub Actions workflow file is present at `.github/workflows/ci.yml`,
**When** a pull request is opened or a commit is pushed to any branch,
**Then** the following jobs run as required PR checks — the **fast path must complete in ≤ 10 minutes** total:
- `typecheck` — `tsc --noEmit` across all packages
- `lint` — ESLint + Prettier check
- `test` — Vitest suite with coverage thresholds (≥ 80% all metrics)
- `duplication` — jscpd zero-tolerance check
- `security` — `audit-ci` + Trivy filesystem scan
- `docker-build` — multi-arch build + health/ready smoke test (`docker compose up`, poll `/health` and `/ready` until 200 or 60s timeout, `docker compose down`)

**And** a **separate scheduled workflow** (`.github/workflows/nightly.yml`) runs on a nightly cron:
- `mutation` — Stryker gate with per-package threshold (≥ 60% initial, ratchets to 80% post-Epic 2)
- `trivy-image` — Trivy Docker image scan (separate from filesystem scan to avoid blocking PRs on upstream base image CVEs)

**And** the CI workflow uses Node.js 24 LTS and pnpm 9+ (versions pinned, not `latest`).

**And** CI caches `~/.pnpm-store` and `.turbo` across runs.

**— Repository Hygiene —**

**And** `.gitignore` covers: `node_modules/`, `.turbo/`, `dist/`, `build/`, `.svelte-kit/`, `coverage/`, `.stryker-tmp/`, `reports/`, `.env*` (but not `.env.example`).

**And** `.env.example` documents every required environment variable with a description and safe placeholder value.

**And** the root `README.md` documents: minimum tooling versions, `docker compose up` quickstart, `pnpm install && turbo dev` local dev start, CI gate descriptions, the base image update procedure, and a pre-PR checklist including `pnpm docker:smoke`.

**And** README explicitly states supported platforms: **macOS and Linux natively; Windows requires WSL2** — all tooling (Husky hooks, shell scripts, Docker buildx) is verified on macOS and Linux only.

**— Local Docker Smoke Test —**

**And** `package.json` at the repo root includes a `docker:smoke` script: `docker compose up --build -d && sleep 15 && curl -f http://localhost:3000/health && curl -f http://localhost:3000/ready && docker compose down`; running `pnpm docker:smoke` exits 0 on a healthy stack and non-zero on any failure.

**— CVE Exception Management —**

**And** a `.trivyignore` file is present at the repo root (initially empty); any CVE entry added must include an expiry date in ISO format (`exp: YYYY-MM-DD`, maximum 30 days out) and a one-line justification comment; CI fails if any `.trivyignore` entry has an expired date or is missing an expiry.

**And** a `.trivyignore-check` CI step validates all entries in `.trivyignore` against today's date, failing with a human-readable list of expired entries that require review.

**— audit-ci Baseline Hygiene —**

**And** `audit-ci.jsonc` is configured as the vulnerability acknowledgement file; each acknowledged vulnerability entry must include an `"expires"` field (ISO date, maximum 90 days out) and a `"reason"` string; a CI step (`scripts/check-audit-baseline.ts`) fails if any entry is missing `expires`, has an expired date, or has a blank `reason`.

**— jscpd Scope —**

**And** `packages/db/src/schema/` is excluded from jscpd in `.jscpd.json` with a documented comment (`// Drizzle schema column definitions are intentionally repetitive by design`); this exclusion is compensated by an explicit Definition of Done checklist item for any story that touches schema files: "Schema reviewed manually for copy-paste duplication; no table column blocks duplicated without a shared helper."

**— Nightly CI Failure Alerting —**

**And** `.github/workflows/nightly.yml` includes a `notify-failure` job that runs `if: failure()` after all other jobs; it posts a summary of failed jobs to the configured Slack webhook (stored as `SLACK_WEBHOOK_URL` GitHub Actions secret) so nightly failures are visible without requiring developers to monitor the Actions dashboard.

---

#### Story 1.2: Configure Backend Package Structure

**As a** developer building the API and data layers,
**I want** the `apps/api`, `packages/db`, `packages/crypto`, and `packages/shared` packages fully configured with their dependencies, TypeScript paths, and inter-package references,
**So that** feature stories can import from shared packages without any build or resolution errors.

**Acceptance Criteria:**

**Given** Story 1.1 is complete and the monorepo scaffold exists,
**When** the developer configures the backend packages,
**Then** `apps/api` has Fastify v5 installed with: `@fastify/swagger`, `@fastify/rate-limit`, `@fastify/jwt`, `@fastify/type-provider-zod`, `@fastify/cors`, `@fastify/helmet`.

**And** `packages/db` has Drizzle ORM 0.45.x installed with `postgres.js` driver and `drizzle-kit`; a `drizzle.config.ts` points to `src/schema/index.ts` and a `migrations/` directory; `pnpm db:migrate` runs `drizzle-kit migrate` against the configured database URL.

**And** `packages/crypto` has `node:crypto` as its only runtime dependency (no third-party crypto libraries); it exports a typed interface stub: `encrypt(plaintext: string, key: Buffer): Promise<EncryptedValue>` and `decrypt(ciphertext: EncryptedValue, key: Buffer): Promise<string>` — implementations deferred to Story 1.5.

**And** `packages/shared` has Zod installed; it exports the following canonical schemas used as the envelope types for all API responses — establishing the contract every subsequent story follows:
- `ApiResponse<T>` — success envelope: `{ data: T, meta?: { page?, limit?, total?, hasNext? } }`
- `ApiError` — error envelope: `{ code: string, message: string, details?: Record<string, string[]> }`; `code` is a machine-readable snake_case string (e.g., `"slug_taken"`, `"already_member"`); `message` is human-readable; `details` holds per-field validation errors; **every** API error response across all stories uses this exact shape — no ad-hoc error objects.
- All Fastify route schemas use `@fastify/type-provider-zod` with `ApiResponse<T>` and `ApiError` as the reply schemas, so OpenAPI spec auto-generation includes error shapes.

**And** `apps/api` imports from `@project-vault/shared` and `@project-vault/db` via workspace protocol (`workspace:*`) with TypeScript path aliases resolving correctly (`tsc --noEmit` passes).

**And** `apps/api` has `tsx` configured as the dev server runner (`tsx watch src/index.ts`); `turbo dev` starts the API in watch mode alongside the web app.

**And** pg-boss 12.18.2 is installed in `apps/api`; a `BossService` stub class is exported with `start()` and `stop()` methods — wired to the Fastify lifecycle hooks (onReady/onClose) but scheduling no jobs yet.

**And** all inter-package imports resolve correctly in the initial build: `turbo build` produces zero TypeScript errors across all packages.

**And** each package has a `vitest.config.ts` that extends the shared base from `packages/tsconfig`; `turbo test` runs all package test suites (each passing their initial smoke test from Story 1.1).

---

#### Story 1.3: Docker Deployment & Health Endpoints

*Covers: FR49, FR81*

**As a** platform operator deploying Project Vault on self-hosted infrastructure,
**I want** the full application stack deployable with a single `docker compose up` command,
**So that** I can run a production-grade vault without installing Node.js or any build tools on the host.

**Acceptance Criteria:**

**Given** Story 1.2 is complete,
**When** the operator runs `docker compose up --build` from the repo root,
**Then** three services start: `db` (PostgreSQL 16), `api` (Fastify), `web` (SvelteKit); all reach healthy status within 60 seconds.

**And** the `api` Dockerfile uses a multi-stage build: `builder` stage compiles TypeScript; `runner` stage copies only the compiled output and production `node_modules` — final image size must be under 300MB.

**And** the `web` Dockerfile uses SvelteKit's Node adapter; static assets are served from the SvelteKit server (no separate Nginx required in v1).

**And** both Dockerfiles pin their base image to a specific digest (e.g., `node:24-alpine@sha256:…`) as established in Story 1.1.

**And** `GET /health` on the API returns `200 { status: "ok", version: "<semver from package.json>" }` at all times when the process is alive — it never checks dependencies (liveness probe).

**And** `GET /ready` on the API returns `200 { status: "ready" }` when a test DB query (`SELECT 1`) succeeds, or `503 { status: "unavailable", reason: "db", retryAfter: 5 }` when it fails — this is the readiness probe (as per the contract established in Story 1.1).

**And** the `db` container has a `HEALTHCHECK` using `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}`; the `api` container declares `depends_on: db: condition: service_healthy`.

**And** the `api` container's `HEALTHCHECK` polls `GET /health` every 10 seconds, with 3 retries and a 30-second start period.

**And** all configuration is injected via environment variables; `.env.example` is updated with: `DATABASE_URL`, `API_PORT` (default: 3000), `WEB_PORT` (default: 5173), `NODE_ENV`.

**And** `pnpm docker:smoke` (from Story 1.1) exits 0 against the built stack.

**And** multi-arch build succeeds for both images (`linux/amd64` + `linux/arm64`) via the `docker-container` buildx driver established in Story 1.1.

**And** the Prometheus metrics endpoint (`GET /metrics`) is bound to `localhost` only by default (not exposed on the public interface); it returns a valid Prometheus text format response with at minimum: `process_uptime_seconds`, `http_requests_total`, `http_request_duration_ms`.

**— HTTP Security Headers & CORS —**

**And** `@fastify/helmet` is registered with the following explicit configuration (not defaults): `contentSecurityPolicy` with `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'` (required for SvelteKit), `img-src 'self' data:`; `strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true }`; `frameguard: { action: 'deny' }`; `referrerPolicy: { policy: 'strict-origin-when-cross-origin' }`.

**And** `@fastify/cors` is registered with `origin` set from `CORS_ALLOWED_ORIGINS` env var (comma-separated list; defaults to `http://localhost:5173` in development; no wildcard `*` is ever a valid production value); requests from unlisted origins receive `403`; the `CORS_ALLOWED_ORIGINS` var is required and validated at startup.

**And** a test asserts that a request from an unlisted origin receives `403` and a request from a listed origin includes the correct `Access-Control-Allow-Origin` header.

**— Startup Environment Validation —**

**And** `apps/api/src/config/env.ts` exports a Zod schema for all required environment variables; on startup, the schema is parsed with `z.parse(process.env)`; if any required variable is missing or invalid, the process exits with code 1 and a human-readable error listing every missing variable: `FATAL: missing required environment variables: DATABASE_URL, JWT_SECRET`; the process never starts with an undefined required variable.

**And** `.env.example` is the source of truth for required variables; a CI check (`scripts/check-env-example.ts`) verifies that every variable in the Zod schema has a corresponding entry in `.env.example` — failing CI if any are out of sync.

**— Production Docker Compose —**

**And** a `docker-compose.prod.yml` file exists alongside `docker-compose.yml` with production-hardening overrides: `mem_limit: 512m` and `cpu_shares: 512` for `api`; `mem_limit: 256m` for `web`; `mem_limit: 1g` for `db`; `restart: unless-stopped` on all services; `logging: driver: json-file` with `max-size: 10m, max-file: 5` on all services; named volumes (`db_data`, `vault_keys`) replacing bind mounts; `CORS_ALLOWED_ORIGINS` set from env (not hardcoded).

**And** the README documents: use `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` for production; `docker-compose.yml` alone is for local development only.

---

#### Story 1.4: Database Foundation with PostgreSQL RLS & Core Schema

*Covers: FR61*

**As a** platform operator running a multi-organization vault instance,
**I want** the database schema to enforce organization-scoped data isolation at the PostgreSQL level via Row-Level Security,
**So that** no application-layer bug can ever leak data between organizations — isolation is structural, not conventional.

**Acceptance Criteria:**

**Given** Story 1.3 is complete and PostgreSQL 16 is running,
**When** the developer runs `pnpm db:migrate`,
**Then** the following tables are created in the correct order with no migration errors:

- `organizations` — `id` (uuid PK), `name`, `slug` (unique), `created_at`, `updated_at`
- `users` — `id` (uuid PK), `email` (unique), `password_hash`, `created_at`, `updated_at`
- `organization_members` — `org_id` (FK → organizations), `user_id` (FK → users), `role` (enum: owner/admin/member/viewer), `status` (enum: active/deactivated), `grace_period_expires_at` (nullable), `last_active_at`, `created_at`; PK is `(org_id, user_id)`
- `user_identity_tokens` — `id` (uuid PK), `user_id` (FK → users, nullable post-deletion), `display_name`, `pseudonymized_at` (nullable); this table is the PII externalization layer for audit logs — referenced by all audit events instead of raw user identity
- `sessions` — `id` (uuid PK), `user_id` (FK → users), `org_id` (FK → organizations), `session_version` (integer, default 1), `expires_at`, `created_at`, `last_active_at`, `ip_address`, `user_agent`
- `audit_events` — `id` (uuid PK), `org_id` (FK → organizations), `project_id` (uuid nullable), `actor_token_id` (FK → user_identity_tokens, nullable for system events), `actor_type` (enum: human/machine_user/system), `event_type` (varchar), `resource_id` (uuid nullable), `resource_type` (varchar nullable), `ip_address` (varchar nullable), `user_agent` (varchar nullable), `payload` (JSONB — never contains secret values), `key_version` (integer), `hmac` (varchar), `created_at`; indexes: `(org_id, created_at)`, `(project_id, created_at)`, `(event_type, created_at)`, `(resource_id, created_at)`; RLS policy scoped to `org_id`; append-only enforced via a PostgreSQL trigger that blocks UPDATE and DELETE on this table
  > **Doc reconciliation, 2026-07-09:** the shipped table is named `audit_log_entries`, not `audit_events` — a deliberate, already-reconciled naming decision made during implementation (Story 7.1 Dev Note D9, Story 8.1 Dev Note D1: "shipped code wins"), not a bug or an unresolved drift. All ~23 `audit_events` references throughout this document (this schema block plus every Epic 2/5/7/8 AC that names the table) are being left as-is rather than mass-renamed, since this is a planning artifact describing intent at the time each epic was written, and the real table name is authoritative in the actual codebase (`packages/db/src/schema/`). This note was the missing log entry `deferred-work.md`'s "Planning document reconciliation" section flagged (Epic 8 retro, A8-5) — no further action needed on this item.
- `security_alerts` — `id` (uuid PK), `org_id` (FK → organizations), `alert_type` (varchar), `severity` (enum: info/warning/critical), `payload` (JSONB), `status` (enum: PENDING_DELIVERY/delivered/dismissed), `dismissed_by` (FK → user_identity_tokens, nullable), `dismissed_at` (nullable), `dismissal_reason` (nullable), `created_at`; RLS policy scoped to `org_id`

**And** every table that contains organization-scoped data has an `org_id` column (FK → organizations); this is enforced as a Drizzle schema convention with a shared `orgScoped` helper that adds the column and FK.

**And** PostgreSQL Row-Level Security is enabled on all org-scoped tables; a policy is created for each table: `USING (org_id = current_setting('app.current_org_id')::uuid)`; the application sets `app.current_org_id` at the start of every transaction via a Drizzle middleware.

**And** a `check-rls-coverage.ts` script (run as a required CI check) queries `pg_tables` and `pg_policies` and fails if any table with an `org_id` column does not have an RLS policy — this is the guard referenced in the Architecture document.

**And** an `rls-isolation.test.ts` integration test creates two organizations (Org A and Org B), inserts a row in each, then queries as Org A and asserts zero rows from Org B are returned — this test is a required passing CI check and is explicitly the "correctness" complement to `check-rls-coverage.ts`.

**And** all UUID primary keys use `gen_random_uuid()` as the PostgreSQL default.

**And** all tables have `created_at TIMESTAMPTZ DEFAULT NOW()` and `updated_at TIMESTAMPTZ DEFAULT NOW()` with a trigger that auto-updates `updated_at` on every row update.

**And** `pnpm db:migrate` is idempotent — running it twice on an already-migrated database produces no errors and no schema changes.

**And** a `pnpm db:seed:test` script inserts two organizations with one user each — used by integration tests as the standard test fixture.

---

#### Story 1.5: Vault Initialization & Master Key Management

*Covers: FR60*

**As a** platform operator starting a fresh vault instance,
**I want** a guided vault initialization ceremony that establishes master key custody and encrypts the vault,
**So that** all secrets stored in subsequent operations are encrypted at rest with AES-256-GCM from the first write.

**Acceptance Criteria:**

**Given** Story 1.4 is complete and the database is migrated,
**When** the API starts for the first time (no vault state record exists),
**Then** the API serves only `GET /health`, `GET /ready`, and `POST /api/v1/vault/init` — all other endpoints return `503 { status: "sealed", message: "Vault not initialized" }`.

**And** `POST /api/v1/vault/init` accepts: `{ masterKeyPath: string }` — a path to a file on the host filesystem containing the master key material (minimum 32 bytes); the API reads the file, derives a 256-bit AES-GCM key via HKDF-SHA256, encrypts a test sentinel value, stores the encrypted sentinel and key metadata in a `vault_state` table, then returns `{ initialized: true, keyVersion: 1 }`.

**And** the `vault_state` table stores: `key_version` (integer), `encrypted_sentinel`, `kms_type` (enum: `file` | `envelope` | `kms`), `initialized_at`; there is exactly one row — a second call to `POST /api/v1/vault/init` returns `409 { error: "already_initialized" }`.

**And** on subsequent API starts, if `vault_state` exists, the API enters **sealed** state: it serves only `/health` and `/ready`, and waits for `POST /api/v1/vault/unseal` with `{ masterKeyPath: string }`; the API decrypts and verifies the sentinel — if verification succeeds, the vault transitions to **unsealed** and all endpoints become available.

**And** if the API process terminates unexpectedly (SIGKILL, OOM, crash), on restart it enters sealed state and requires manual unseal — auto-unseal on crash is explicitly out of v1 scope and must be documented as such in the API response to `/ready` while sealed: `{ status: "unavailable", reason: "sealed", message: "Manual unseal required via POST /api/v1/vault/unseal" }`.

**And** the master key **never touches the database in plaintext** — only the encrypted sentinel is stored; the in-memory derived key is stored in a module-scoped `Buffer` that is zeroed (`key.fill(0)`) on SIGTERM/SIGINT before process exit.

**And** `packages/crypto` now implements `encrypt` and `decrypt` using `node:crypto` AES-256-GCM: random 12-byte IV per encryption, authenticated tag appended, encoded as `{ iv: hex, tag: hex, ciphertext: hex }`; all crypto operations use constant-time comparison for tag verification.

**And** a separate audit encryption key is derived from the master key via HKDF with a distinct `info` string (`"project-vault-audit-log-v1"`); this key is stored separately from the primary encryption key and has an independent rotation lifecycle — its key version is stored in `vault_state`.

**And** `GET /ready` returns `{ status: "unavailable", reason: "sealed" }` (503) while sealed and `{ status: "ready" }` (200) when unsealed and DB is reachable.

**And** a Vitest integration test covers the full init → restart → unseal sequence using a temp file as the key source.

---

#### Story 1.6: User Registration & Password Authentication

*Covers: FR53*

**As a** new user,
**I want** to create an account with my email and password and log in to the vault,
**So that** I can access my organization's secrets securely.

**Acceptance Criteria:**

**Given** the vault is initialized and unsealed (Story 1.5),
**When** a user submits `POST /api/v1/auth/register` with `{ email, password, orgName }`,
**Then** a new organization and user are created atomically in a single transaction; the user is assigned the `owner` role in the new organization.

**And** passwords are hashed with **Argon2id** (using the `argon2` npm package): `memoryCost: 65536` (64 MiB), `timeCost: 3`, `parallelism: 4` — these parameters must be stored alongside the hash so future re-hashing on parameter upgrade is possible.

**And** the Argon2id hash parameters are configurable via environment variables (`ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`) with the above values as defaults.

**And** `POST /api/v1/auth/login` with `{ email, password }` returns `{ accessToken, expiresAt }` on success; the JWT is signed with RS256 (asymmetric); the key pair is generated at vault init and stored encrypted in `vault_state`.

**And** the JWT payload contains: `{ sub: userId, orgId, sessionId, sessionVersion, iat, exp }`; TTL is 5 minutes (short-lived, per the architecture's session invalidation design).

**And** a refresh token (opaque, 256-bit random, stored hashed in the `sessions` table) is returned as an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; `POST /api/v1/auth/refresh` exchanges a valid refresh token for a new access token + rotated refresh token (token rotation on every refresh).

**And** registration rejects: passwords under 12 characters, emails that don't match RFC 5322 format, duplicate emails (`409 { error: "email_taken" }`).

**And** all auth response times are constant regardless of whether the email exists — timing oracle protection via always running the full Argon2id hash even on non-existent accounts.

**And** password values never appear in any log, error message, or stack trace — enforced by the `no-secrets` ESLint rule and a test that asserts the Fastify error handler strips `password` fields from logged request bodies.

**And** the entire register + login + refresh flow is covered by integration tests using a real test database (no mocks).

---

#### Story 1.7: JWT Session Management & Security Controls

*Covers: FR83, FR84, FR85*

**As a** user managing my account security,
**I want** to view all my active sessions and revoke any of them — including org admins being able to revoke any user's sessions — with idle timeout enforced automatically,
**So that** compromised or abandoned sessions cannot be used to access vault secrets.

**Acceptance Criteria:**

**Given** a user is logged in with a valid session,
**When** they call `GET /api/v1/auth/sessions`,
**Then** they receive a list of their active sessions: `[{ sessionId, createdAt, lastActiveAt, ipAddress, userAgent, isCurrent }]` — `isCurrent: true` marks the session used for this request.

**And** `DELETE /api/v1/auth/sessions/:sessionId` revokes a specific session by deleting its refresh token and incrementing `session_version` on the user record for that session; subsequent access token validations for that session fail because the JWT `sessionVersion` claim no longer matches the stored value.

**And** `DELETE /api/v1/auth/sessions` (no ID) revokes all sessions for the calling user except the current one.

**And** an org admin calling `DELETE /api/v1/org/users/:userId/sessions` revokes all sessions for the target user in that organization (FR84); this is also the path called during account deactivation (Epic 4).

**And** every API request that accesses secrets or performs writes validates `sessionVersion` from the JWT against the live `session_version` value in the `sessions` table; a mismatch returns `401 { error: "session_revoked" }`.

**And** idle session timeout is enforced server-side: if `last_active_at` on the session record is older than the configured `SESSION_IDLE_TIMEOUT_MINUTES` (default: 30, minimum: 1, configurable via env var), the refresh token is rejected with `401 { error: "session_expired" }` and the session record is deleted.

**And** `last_active_at` is updated on every authenticated API request (debounced: at most one DB write per 60 seconds per session to avoid write amplification).

**And** a short-TTL revocation table (`revoked_tokens`) stores actively-revoked JWT IDs (`jti` claim) for the remainder of their 5-minute TTL window; all endpoints check this table on every request for the remaining TTL window after revocation; the table schema: `jti` (uuid PK), `expiresAt` (timestamptz), with a B-tree index on `expiresAt`.

**And** a pg-boss job (`prune-revoked-tokens`) runs hourly and deletes all `revoked_tokens` rows where `expiresAt < NOW()`; without this job a high-traffic vault accumulates millions of stale rows; the job is registered in `BossService` during Story 1.2's lifecycle setup.

**And** integration tests cover: list sessions, revoke single, revoke all, admin revoke, idle timeout expiry, session_version mismatch rejection, revoked_tokens cleanup job (rows past TTL deleted, active rows preserved).

---

#### Story 1.8: TOTP MFA Enrollment & Recovery Codes

*Covers: FR54, FR55*

**As a** user who wants to secure my account with a second factor,
**I want** to enroll a TOTP authenticator app and generate one-time recovery codes,
**So that** my account remains protected even if my password is compromised, and I have a recovery path if I lose my authenticator device.

**Acceptance Criteria:**

**Given** a user is authenticated (Story 1.6),
**When** they call `POST /api/v1/auth/mfa/enroll`,
**Then** the server generates a TOTP secret (160-bit random, base32-encoded), stores it encrypted in the `users` table (`totp_secret_encrypted`), and returns: `{ otpauthUrl, secret, qrCodeSvg }`; the QR code SVG is generated server-side (no external service call).

**And** MFA enrollment is not complete until the user verifies with `POST /api/v1/auth/mfa/verify-enrollment` with `{ totp: "6-digit code" }`; a valid TOTP code transitions `users.mfa_enrolled` to `true`; an invalid code returns `422 { error: "invalid_totp" }` and the pending secret is discarded.

**And** TOTP validation accepts codes from the current 30-second window and one window before (clock skew tolerance ±30 seconds); it does not accept the same code twice within the same window (replay protection via a `totp_used_codes` table with TTL cleanup).

**And** upon successful MFA enrollment, 10 one-time recovery codes are generated (each: 10 random alphanumeric characters, formatted as `XXXXX-XXXXX`), displayed once, and stored as individual bcrypt hashes in a `mfa_recovery_codes` table — the plaintext values are never stored.

**And** recovery codes are shown exactly once at enrollment time; the UI must present a "I have saved these codes" confirmation before the enrollment flow completes; there is no "show recovery codes again" endpoint.

**And** `POST /api/v1/auth/mfa/recover` with `{ email, password, recoveryCode }` allows login when the TOTP device is unavailable; a valid recovery code is consumed (deleted) and cannot be reused; consuming a recovery code emits a `mfa.recovery_used` event to the audit log and, once Epic 3 is live, sends an email alert to the user.

**And** `POST /api/v1/auth/mfa/regenerate-recovery-codes` (requires current TOTP verification) generates 10 new codes and invalidates all existing ones — displayed once and immediately stored hashed.

**And** the TOTP secret is stored encrypted using the vault's primary encryption key (Story 1.5 `packages/crypto`); a compromised database without the master key reveals no TOTP secrets.

**And** integration tests cover: full enrollment flow, duplicate code rejection (replay), recovery code consumption, code regeneration, and enrollment without verification (pending state discarded on session end).

---

#### Story 1.9: MFA Role Enforcement & Failed Authentication Detection

*Covers: FR57, FR73*

**As an** organization owner or admin,
**I want** MFA to be required before my role grants me the ability to invite new members, and failed authentication attempts to be detected and flagged,
**So that** privileged accounts are protected by a second factor before they can expand access, and brute-force attacks are visible.

**Acceptance Criteria:**

**Given** a user with `owner` or `admin` role is authenticated but has not enrolled MFA,
**When** they attempt any endpoint that requires elevated privilege (inviting members, changing roles, accessing audit logs),
**Then** the response is `403 { error: "mfa_required", message: "MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security." }`.

**And** the MFA enforcement check is applied at the `SecureRoute` handler constructor level (Architecture document) as a named flag `requireMfa: true` — not duplicated per-endpoint; adding a new privileged endpoint correctly enforces MFA by default when the flag is set.

**And** a 7-day grace period applies from the moment a user is first assigned `owner` or `admin` role; during the grace period, the user sees a persistent banner but is not blocked; after 7 days, enforcement becomes hard; the grace period expiry timestamp is stored in `organization_members`.

**And** failed authentication attempts (wrong password, invalid TOTP, expired recovery code) are recorded in a `failed_auth_attempts` table: `(user_id nullable, ip_address, attempted_email, reason, attempted_at)`.

**And** a background check (running every 60 seconds via pg-boss) queries `failed_auth_attempts` for the past 5 minutes; if any IP has ≥ 10 failed attempts, a `security.failed_auth_threshold` event is emitted to the `security_alerts` table; once Epic 3 is live, this triggers an alert to org admins — until then, the alert record is created with status `PENDING_DELIVERY` and a log entry with `event_type: "alert.pending_epic3"` is written to confirm intentional deferral.

**And** the threshold (10 attempts / 5 minutes) is configurable via env vars `FAILED_AUTH_THRESHOLD_COUNT` and `FAILED_AUTH_THRESHOLD_WINDOW_SECONDS`.

**And** failed attempt records older than 24 hours are pruned by a pg-boss scheduled job (daily at 02:00 UTC).

**And** integration tests cover: MFA-blocked privileged endpoint, grace period bypass, grace period expiry block, failed attempt recording, threshold detection job, and pruning job.

---

#### Story 1.10: Structured Operational Logging & Metrics

*Covers: FR82*

**As a** platform operator monitoring a running vault instance,
**I want** all application events emitted as structured JSON logs and Prometheus-compatible metrics,
**So that** I can ship logs to external aggregation tools and scrape metrics into my monitoring stack without custom parsing.

**Acceptance Criteria:**

**Given** the API is running (any story from 1.3 onward),
**When** any event occurs (HTTP request, DB query error, background job execution, startup/shutdown),
**Then** it is logged as a single-line JSON object to stdout with the following required fields: `timestamp` (ISO 8601), `level` (trace/debug/info/warn/error/fatal), `service` (string: `api`), `traceId` (uuid, per-request correlation ID propagated from `X-Request-ID` header or generated), `eventType` (string: e.g., `http.request`, `db.error`, `job.completed`), `message` (string).

**And** the logging library is **Pino** (already a Fastify dependency); Pino is configured with `redact: ["req.headers.authorization", "req.body.password", "req.body.masterKeyPath", "req.body.secret", "req.body.value"]` — these fields are replaced with `[REDACTED]` in all log output.

**And** HTTP request logs include: `method`, `url`, `statusCode`, `responseTimeMs`; they do NOT include request or response body by default.

**And** a `LOG_LEVEL` environment variable controls the minimum log level (default: `info`); in test environments it defaults to `silent` to prevent log noise during `turbo test`.

**And** `GET /metrics` returns Prometheus text format (Content-Type: `text/plain; version=0.0.4`) with at minimum:
- `process_uptime_seconds` (gauge)
- `http_requests_total{method, route, status_code}` (counter)
- `http_request_duration_seconds{method, route, status_code}` (histogram, buckets: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5)
- `vault_sealed` (gauge: 1 = sealed, 0 = unsealed)
- `db_pool_connections_active` (gauge)

**And** `/metrics` is bound to `localhost` only by default; `METRICS_BIND_HOST` env var overrides this (e.g., `0.0.0.0` for Prometheus scraping from a sidecar); the default localhost-only binding is verified by a test that asserts the endpoint is unreachable on `0.0.0.0` with default config.

**And** background job events (pg-boss) emit structured logs with `eventType: "job.started"`, `"job.completed"`, or `"job.failed"` including `jobName`, `jobId`, and `durationMs`.

**And** startup logs include: Node.js version, service version (from `package.json`), vault seal state, database connection status.

**And** a test asserts that no log output at any level contains the strings `password`, `secret`, `masterKeyPath`, or `value` when those fields are present in a request — verifying the Pino redaction config is active.

---

#### Story 1.11: SecureRoute Framework & Drizzle RLS Middleware

**As a** developer building API endpoints,
**I want** a `SecureRoute` handler constructor that applies RBAC, org-scoped RLS, audit writes, and rate limiting by default,
**So that** security concerns are structural — I cannot accidentally create an unprotected endpoint by forgetting to add middleware.

**Acceptance Criteria:**

**Given** Story 1.4 (RLS schema) and Story 1.6 (JWT auth) are complete,
**When** a developer registers any new Fastify route using `SecureRoute`,
**Then** the following cross-cutting concerns are applied automatically unless explicitly opted out with a named flag: `requireAuth` (validates JWT, rejects with 401 if invalid), `requireOrgScope` (sets `app.current_org_id` PostgreSQL session variable for RLS), `requireRole` (minimum role check — default: `viewer`), `writeAuditEvent` (writes to `audit_events` within the same transaction), `rateLimit` (applies per-account rate limit via `@fastify/rate-limit`).

**And** opting out requires an explicit named flag, e.g. `{ requireAuth: false }` for public endpoints like `/health`; a route without explicit opt-out of `requireAuth` that lacks a valid JWT returns `401` — there is no way to create an unprotected route by accident.

**And** the Fastify → PostgreSQL RLS middleware (`packages/api/src/middleware/rls.ts`) runs as a Fastify `preHandler` hook on every authenticated request: it calls `SET LOCAL app.current_org_id = $1` within the Drizzle transaction context using the `orgId` from the validated JWT; all subsequent Drizzle queries in that request context are automatically scoped by PostgreSQL RLS.

**And** the middleware explicitly handles the background job execution context: pg-boss job handlers receive an `orgId` parameter and call the same RLS-setting function before any DB queries — RLS is never bypassed for background jobs.

**And** `SecureRoute` is implemented as a Fastify plugin factory in `apps/api/src/framework/secure-route.ts`; it is the **only** approved way to register routes; a CI ESLint rule (`no-raw-fastify-route`) fails if `fastify.get/post/put/patch/delete` is called directly outside of `SecureRoute`.

**And** integration tests cover: authenticated request sets `app.current_org_id` (verified via `SHOW app.current_org_id`), unauthenticated request rejected 401, insufficient role rejected 403, audit event written in same transaction, RLS middleware in background job context.

---

#### Story 1.12: MFA Login Verification Flow

**As a** user who has enrolled MFA,
**I want** the login flow to require my TOTP code as a second step before issuing a full access token,
**So that** my enrolled MFA actually protects my account — not just my ability to invite others.

**Acceptance Criteria:**

**Given** a user has MFA enrolled (`users.mfa_enrolled = true`),
**When** they call `POST /api/v1/auth/login` with valid `{ email, password }`,
**Then** instead of a full JWT, the response is `200 { mfaRequired: true, mfaToken: "<opaque 128-bit token>" }` with HTTP status 200; no access token or refresh token is issued yet; the `mfaToken` is a short-lived (5-minute TTL) single-use token stored hashed in a `pending_mfa_sessions` table.

**And** `POST /api/v1/auth/mfa/verify-login` with `{ mfaToken, totp }` completes the login: if the TOTP code is valid and the `mfaToken` is not expired or already used, the `pending_mfa_sessions` record is deleted and a full JWT + refresh token are issued (same response shape as Story 1.6 for non-MFA users).

**And** `pending_mfa_sessions` rows expire after 5 minutes; an hourly pg-boss cleanup job prunes expired rows.

**And** if `mfaToken` is already used or expired, `POST /auth/mfa/verify-login` returns `401 { code: "mfa_token_expired" }`; the user must restart the login flow from `POST /auth/login`.

**And** users without MFA enrolled continue to receive the full JWT directly from `POST /auth/login` (no change to non-MFA flow).

**And** the MFA verification step records a failed attempt in `failed_auth_attempts` (Story 1.9) on invalid TOTP — brute-forcing the TOTP via repeated `verify-login` calls is subject to the same threshold detection as password failures.

**And** integration tests cover: MFA-enrolled login returns `mfaRequired: true` (no JWT issued), successful TOTP verification returns full JWT, expired mfaToken rejected, used mfaToken rejected, non-MFA user receives JWT directly, failed TOTP records in failed_auth_attempts.

---

### Epic 2: Secret & Credential Management — Store, Retrieve, Search & Import
**🟢 Tier 0 — Required for all beta tiers**
> 🔵 **Beta cuts (T2 recommended scope):** FR9 (onboarding wizard), FR80 (global search), FR17 (bulk import) are deferrable to post-beta polish. Per-project search and manual entry are sufficient at beta scale. *(Doc reconciliation, 2026-07-09: all three shipped as part of Epic 2's normal scope — Story 2.6 (onboarding), 2.7 (global search), 2.5 (bulk import), all `done`. This is a documented scope expansion beyond the T2-recommended cut, not a bug or a broken deferral — `deferred-work.md`'s "Planning document reconciliation" flagged this note as stale.)*
> 🟢 **Course-correction insert:** Story 2.0 pulls a thin, visible SvelteKit frontend shell forward before durable credential work. It validates the vault/login/project mental model using real Epic 1 APIs and either a minimal reusable project API or explicitly marked temporary project stubs. This story must not expand Epic 1 scope or imply shipped credential, alert, or health functionality.
Users can create projects, store and retrieve credentials with full version history and configurable retention/cryptographic deletion, search and filter by name/tag/status/expiry, record dependent systems, set expiry and rotation schedules, bulk-import from `.env`/JSON files with per-conflict resolution, complete the guided onboarding wizard, view a cross-project dashboard, and use global search.

**FRs covered:** FR1, FR7, FR8, FR9, FR10, FR11, FR12, FR14, FR15, FR16, FR17, FR64, FR80, FR93, FR95, FR96, FR98, FR105
> ⚠️ **PJ1 — FR16 → FR19 linkage:** Dependent system records captured in FR16 must be automatically surfaced in the rotation checklist generated by FR19 (Epic 5). Story authors for FR19 must reference FR16 records as the authoritative source for checklist line items — not a separate manual re-entry step.
> ⚠️ **PJ5 — Pre-audit-log coverage:** Credential access events (FR64, FR96) generated in this epic occur before the audit log (Epic 8) exists. Stories for FR64 and FR96 must emit structured audit events to the same append-only log table from the start — even though Epic 8's query/export UI does not exist yet. Events written before Epic 8 must be queryable once Epic 8 lands.
> 🔴 **AC-E2a — FR80 search scope (BLOCKER):** Global search must explicitly exclude credential values. Acceptance criteria must include a negative test: searching a known credential value returns zero results. Any implementation that indexes or returns credential values fails security review.
> 🔴 **RS-E2a — Credential value column protection:** The `value` and `encrypted_value` columns (and any column containing credential material) must never be added to a full-text search index, exposed in any search query result, or included in any list/filter API response. A CI lint rule or DB migration check must enforce this constraint from Epic 1 schema onwards. Any PR adding these columns to an index fails CI.
> 📋 **AC-E2b — FR17 bulk import conflict resolution UX:** Story must specify the batch conflict resolution mode: a single "apply to all conflicts" option (skip/overwrite/rename) rather than per-conflict dialogs. Per-conflict dialogs for large imports are a UX blocker. Batch mode is the v1 scope; per-conflict granular UI is v2.
> 📋 **AC-E2c — FR9 onboarding wizard trigger:** Wizard triggers once per user per org on first project creation only. It is permanently dismissible. It does not re-trigger on subsequent project creation.
> 📋 **AC-E2d — FR7 dashboard scope:** Dashboard must display at minimum: total credentials count, credentials expiring within 30 days (count + list), projects with overdue rotations. Additional widgets are out of v1 scope.
> 📋 **AC-E2e — FR12/FR105 version retention race condition:** Story must specify: a version that is the current active credential for an in-progress rotation is exempt from retention policy deletion until rotation completes or is abandoned.
> 📋 **AC-E2f — Story 2.0 honest placeholders:** Any dashboard, credential, alert, or health panel rendered before its backing API exists must display an explicit empty/not-configured state. The UI must not show fabricated counts, fake health statuses, simulated alerts, or copy implying unavailable capabilities are already functional.

#### Story 2.0: MVP Frontend Shell & Empty Project Dashboard

*Covers: FR46, supports early validation of FR1, FR7, FR8, FR53, FR60, FR72, FR93, FR98*

**As a** first-time evaluator,
**I want** to initialize or unseal the vault, register or log in, and land in a project-centered app shell,
**So that** I understand Project Vault's core product model before the full credential-management feature set exists.

**Acceptance Criteria:**

**Given** the SvelteKit app loads before the vault is ready,
**When** it calls the existing readiness and vault endpoints (`GET /ready`, `POST /api/v1/vault/init`, `POST /api/v1/vault/unseal`),
**Then** it renders distinct uninitialized, sealed, unavailable, and ready states with only the valid next action visible for each state.

**And** vault init/unseal forms must be explicit operator flows: they accept the key file path required by the API, display clear host-trust-boundary copy, never echo the submitted path after submission, and never log or persist it in browser storage.

**And** registration and login use the existing Epic 1 auth APIs (`POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`) and rely on `HttpOnly` cookies for session state; the frontend must not store access tokens in `localStorage`, `sessionStorage`, IndexedDB, or JavaScript-accessible memory.

**And** authenticated routes are guarded in SvelteKit server-side load or hooks: unauthenticated users are redirected to login, authenticated users can refresh transparently when the refresh endpoint succeeds, and expired/revoked sessions return to login with a non-alarming message.

**And** if Story 1.12 is complete before this story is implemented, the login UI supports the MFA-required response and verification step; if Story 1.12 is not complete, MFA login UI is intentionally deferred and marked as blocked by Story 1.12 in the story implementation notes. *(Doc reconciliation, 2026-07-09: Story 1.12 shipped `done` well before Story 2.0's own implementation — the conditional never needed to fall to the "deferred" branch; the web login UI has always supported the MFA-required verification step. `deferred-work.md`'s "Planning document reconciliation" flagged this note as stale — recorded here rather than in a new story, per that item's own "periodic epic doc reconciliation" resolution.)*

**And** the authenticated layout includes responsive navigation for Dashboard, Projects, Credentials, Alerts, Health, and Settings; unavailable sections render honest placeholder/empty states rather than 404s or fake data.

**And** the cross-project dashboard renders an empty state that explains Project Vault's organizing principle: projects are the home for credentials, certificates, services, alerts, and operational context; the empty state gives a clear first action toward creating or selecting a project.

**And** the project dashboard placeholder uses the Story 2.1 response shape when possible (`credentialStats`, `upcomingRotations`, `monitoredServiceHealth`, `recentAccessEvents`, `unresolvedAlertCount`, `isEmpty`, `suggestedActions`) so the frontend can swap from stubbed data to the real Story 2.1 API without redesigning the screen.

**And** the "Create project" UI is included only if one of these implementation paths is selected before development starts:
- **Preferred:** implement the minimal real `POST /api/v1/projects` and `GET /api/v1/projects` subset from Story 2.1 using the final schema and RLS model, then Story 2.1 completes the remaining dashboard and update behavior.
- **Fallback:** use an explicitly labeled in-memory/local preview stub that resets on reload and cannot be mistaken for persisted product behavior.

**And** all credential, alert, and health widgets are placeholders only: credentials show "No credentials added yet", alerts show "No alert sources configured yet", and health shows "No monitored services configured yet"; no widget shows green/healthy/success states until a real backing API exists.

**And** the shell is mobile-friendly at common phone widths: the navigation collapses cleanly, primary vault/auth/dashboard flows do not require horizontal scrolling, and the empty project/dashboard states remain readable without desktop-only layout assumptions.

**And** automated tests cover: vault-state rendering, register/login happy and error paths with mocked API responses, authenticated-route redirects, logout behavior, empty dashboard rendering, honest placeholder copy, and a mobile viewport smoke test.

**And** Story 2.0 does not modify the security-critical scope of Epic 1; it depends on Epic 1 API contracts being stable enough for frontend wiring and may be scheduled only after the current Epic 1 security stories are not blocked by frontend work.

**Out of scope:**
- Storing, revealing, searching, importing, or versioning credential values.
- Real alert delivery, in-product notification inbox, Slack/email notifications, or threshold alert configuration.
- Real service, certificate, domain, uptime, or public status-page monitoring.
- Rotation workflows, dependent-system management, machine users, API keys, audit-log UI, compliance exports, backup/restore UI, full onboarding wizard, Shamir unseal UX, or any fake demo data that implies those capabilities are functional.

#### Story 2.1: Project Creation & Cross-Project Dashboard

*Covers: FR1, FR7, FR8, FR93, FR98*

**As a** user who wants to organize my operational assets,
**I want** to create projects with names and descriptions and view all my projects on a unified dashboard,
**So that** I can group secrets, services, and certificates by team or domain and get a single-glance status overview.

**Acceptance Criteria:**

**Given** the user is authenticated and MFA-enrolled (if owner/admin),
**When** they call `POST /api/v1/projects` with `{ name, slug, description? }`,
**Then** a project is created with the calling user as `owner`; `org_id` is set from the JWT; the project record includes `id`, `name`, `slug` (unique within org), `description`, `org_id`, `created_by`, `created_at`, `archived_at` (null).

**And** `GET /api/v1/projects` returns all projects the user has access to within their org, with summary counts: `{ id, name, slug, description, role, credentialCount, expiringCount, alertCount, createdAt }`.

**And** `GET /api/v1/projects/:projectId/dashboard` returns the project dashboard payload: `{ credentialStats: { active, expiringSoon, expired }, upcomingRotations: [...], monitoredServiceHealth: { healthy, degraded, down }, recentAccessEvents: [...last 5], unresolvedAlertCount }` — data fields not yet populated by future epics return empty arrays or zero counts (not errors).

**And** a newly created project with no credentials or services renders an **empty state** response: `GET /api/v1/projects/:projectId/dashboard` includes `{ isEmpty: true, suggestedActions: ["add_credential", "add_service", "import_credentials"] }` — the UI uses this to render the purposeful empty state (UX-DR14).

**And** `PATCH /api/v1/projects/:projectId` updates `name` or `description`; `slug` is immutable after creation.

**And** project slugs are validated: lowercase alphanumeric + hyphens only, 3–50 characters, unique within the org; duplicate slug returns `409 { error: "slug_taken" }`.

**And** all project endpoints enforce org-scoped RLS — a user cannot read or modify a project belonging to a different org.

**And** integration tests cover: create, dashboard empty state, dashboard with data, slug validation, cross-org isolation.

---

#### Story 2.2: Credential Storage & Retrieval with Version History

*Covers: FR10, FR11, FR12, FR96, FR105*

**As a** developer storing secrets in a project,
**I want** to create credentials with metadata, retrieve their current value, and access full version history with configurable retention,
**So that** I always have the current secret value and can audit or roll back to any previous version within the retention window.

**Acceptance Criteria:**

**Given** a project exists and the user has at least `member` role,
**When** they call `POST /api/v1/projects/:projectId/credentials` with `{ name, value, description?, tags?, expiresAt?, rotationSchedule? }`,
**Then** a credential record is created with: `id`, `projectId`, `orgId`, `name`, `description`, `tags` (array), `expiresAt` (nullable), `rotationSchedule` (nullable cron string), `createdBy`, `createdAt`; the value is encrypted using `packages/crypto` with the vault master key and stored in a separate `credential_versions` table.

**And** the `credential_versions` table stores: `id`, `credentialId`, `encryptedValue`, `keyVersion`, `versionNumber` (auto-incrementing integer per credential), `createdBy`, `createdAt`; `encryptedValue` is never returned in list or search responses.

**And** `GET /api/v1/projects/:projectId/credentials/:credentialId/value` returns the decrypted current value: `{ value, versionNumber, retrievedAt }`; this endpoint requires explicit `read:secret_value` permission (distinct from `read:secret_metadata` per NFR-SEC9).

**And** every call to the value endpoint writes an audit event: `{ eventType: "credential.value_revealed", actorToken: <user_identity_token_id>, credentialId, versionNumber, projectId, orgId, ipAddress, timestamp }` — actor stored as `user_identity_token` reference, not raw identity (PJ6).

**And** `GET /api/v1/projects/:projectId/credentials/:credentialId/versions` returns version history: `[{ versionNumber, createdBy, createdAt, isCurrent }]` — encrypted values are never included.

**And** version retention is enforced by a pg-boss scheduled job (daily): versions beyond the configured retention count (default: 3, minimum: 1, configurable per credential via `retentionCount`) are cryptographically deleted — the `encryptedValue` is overwritten with zeros and `keyVersion` is cleared; the deletion event is recorded in the audit log; versions referenced by an `in_progress` or `stale-recovery` rotation are exempt.

**And** creating a new credential version (via `POST /api/v1/projects/:projectId/credentials/:credentialId/versions`) with a value matching an existing version is allowed — the system does not deduplicate values.

**And** integration tests cover: create, retrieve value (audit event verified), version history, retention enforcement, rotation-exempt version not pruned.

---

#### Story 2.3: Credential Search, Filter & Tag Management

*Covers: FR14, FR95*

> **Readiness note (Epic 2 planning pass, 2026-06-27):** Search/index work here MUST never index or return credential values. The `credentials` table has no `value`/`encrypted_value` column (introduced clean in Story 2.2 per RS-E2a); this story adds the CI lint rule (`scripts/check-search-index.ts`) that fails if any migration/Drizzle query puts a value column into a full-text or trigram index, plus the required negative test (searching a known plaintext returns zero results). Pagination here is the canonical FR97 implementation (`page`/`limit`, max 100) — note that Story 2.1's project list is an explicit, recorded FR97 exception (ADR-2.1-06), not a precedent for skipping pagination on the credential list. Relies on: Story 2.2 `credentials`/`credential_versions` schema + audit vocabulary. Consumed by: Story 2.7 global search (same never-index-values invariant).

**As a** developer working across many credentials,
**I want** to search and filter credentials by name, tag, status, and expiry, and manage tags on both credentials and projects,
**So that** I can quickly locate what I need without scrolling through a full list.

**Acceptance Criteria:**

**Given** a project has credentials,
**When** the user calls `GET /api/v1/projects/:projectId/credentials?q=&tags=&status=&expiresWithin=&page=&limit=`,
**Then** the response is paginated (`{ items, total, page, limit, hasNext }`) and filtered by all provided parameters simultaneously.

**And** `q` is a case-insensitive substring match on credential `name` and `description` only — `encryptedValue` and `value` are never included in search index or results (AC-E2a blocker).

**And** `status` filter accepts: `active` (no expiry or expiry in future), `expiring` (expires within `expiresWithin` days, default 30), `expired` (past expiry date).

**And** `tags` filter accepts a comma-separated list; credentials matching **all** provided tags are returned (AND logic).

**And** `GET /api/v1/projects/:projectId/credentials` without filters returns all credentials with metadata but never with encrypted or decrypted values.

**And** `PUT /api/v1/projects/:projectId/credentials/:credentialId/tags` replaces the credential's tag array; `PATCH` appends; tags are free-text strings, max 50 chars each, max 20 tags per credential.

**And** `PUT /api/v1/projects/:projectId/tags` manages project-level tags (same constraints).

**And** a CI lint rule (`scripts/check-search-index.ts`) verifies that no migration or Drizzle query adds `encrypted_value` or `value` columns to any full-text or trigram index — this is the RS-E2a guard running in CI.

**And** all list endpoints support `page` (default: 1) and `limit` (default: 20, max: 100) pagination per FR97.

**And** integration tests include the negative test: searching for a known credential plaintext value returns zero results.

---

#### Story 2.4: Dependent System Recording & Expiry/Rotation Schedules

*Covers: FR15, FR16, FR64*

> **Readiness note (Epic 2 planning pass, 2026-06-27):** The `credential_dependencies` records created here are the **direct input to Epic 5 rotation checklists** — Story 5.1 generates a `rotation_checklist_items` row per non-archived dependency (see epics.md Story 5.1 ACs). Design the dependency record (`systemName`, `systemType`, `notes`, `archivedAt`) and the archive semantics so Epic 5 can consume them with no reshape; archived dependencies stay in history but are excluded from checklist generation. This story also activates the `expiresAt`/`rotationSchedule` columns that Story 2.2 created but left write-only-at-create — full cron semantics land here (2.2 validated shape only). Relies on: Story 2.2 credential schema (`expiresAt`/`rotationSchedule` columns, `rotation_locked_at` seam). Consumed by: Epic 5 (rotation checklists), Story 2.3 (status/expiry filters).

**As a** developer managing credential lifecycle,
**I want** to record which systems depend on each credential, set expiry dates and rotation schedules, and see who has access to a specific credential,
**So that** rotation checklists are pre-populated (for Epic 5) and I can audit credential exposure.

**Acceptance Criteria:**

**Given** a credential exists,
**When** the user calls `POST /api/v1/projects/:projectId/credentials/:credentialId/dependencies` with `{ systemName, systemType?, notes? }`,
**Then** a `credential_dependencies` record is created: `id`, `credentialId`, `orgId`, `systemName`, `systemType` (enum: `service` | `ci_pipeline` | `database` | `third_party` | `other`), `notes`, `createdBy`, `archivedAt` (null); archived records are hidden from active dependency lists but preserved in history.

**And** `GET /api/v1/projects/:projectId/credentials/:credentialId/dependencies` returns only non-archived dependencies; archived ones are available at `?includeArchived=true`.

**And** `PATCH /api/v1/projects/:projectId/credentials/:credentialId` accepts `expiresAt` (ISO datetime) and `rotationSchedule` (cron string, max frequency: every 1 hour); invalid cron strings return `422 { error: "invalid_cron" }`.

**And** `GET /api/v1/projects/:projectId/credentials/:credentialId/access` returns the list of users and machine users (once Epic 7 exists) who currently have access based on project roles: `[{ identityType: "user" | "machine_user", displayName, role, grantedAt }]`; this endpoint requires `admin` or `owner` role.

**And** credentials with zero recorded dependencies are flagged in the API response with `{ hasDependencies: false }` — enabling the UI coverage gap indicator (UX-DR7).

**And** integration tests cover: add dependency, archive dependency (hidden from active list, present in history), set expiry + rotation schedule, access list (role-scoped), zero-dependency flag.

---

#### Story 2.5: Credential Bulk Import from .env & JSON

*Covers: FR17*

> **Readiness note (Epic 2 planning pass, 2026-06-27):** Import MUST preserve existing version history and dependency/rotation metadata. The `new_version` conflict action creates a **new credential version** (reusing Story 2.2's add-version path, monotonic `versionNumber`, no dedup) and must NOT overwrite or truncate prior versions, dependencies (Story 2.4), `rotationSchedule`, tags, or notes — only the value advances via a new version. `skip` leaves the credential untouched; `create_new` makes a suffixed new credential. Every imported value goes through the same encrypt + version-insert path as a manual create (no bypass of the no-value-leak / audit invariants). Relies on: Story 2.2 (versioning + encryption), Story 2.4 (dependencies/rotation metadata to preserve). Consumed by: Story 2.6 onboarding (step 3 links to import).

**As a** developer migrating secrets from an existing setup,
**I want** to import credentials in bulk from `.env` files or JSON exports with explicit per-conflict resolution,
**So that** I can migrate my existing secrets without accidentally overwriting version history or rotation schedules.

**Acceptance Criteria:**

**Given** a project exists and the user has `admin` or `owner` role,
**When** they call `POST /api/v1/projects/:projectId/credentials/import` with a multipart form containing a `.env` or `.json` file,
**Then** the server parses the file and returns an import preview: `{ parsed: [{ name, value: "[REDACTED]", conflictsWith?: existingCredentialId, suggestedAction: "new_version" | "skip" | "create_new" }], warnings: [] }` — no credentials are created yet.

**And** the user confirms the import with `POST /api/v1/projects/:projectId/credentials/import/confirm` with `{ importId, defaultAction: "new_version" | "skip" | "create_new", overrides?: { [name]: action } }` — applying a batch resolution mode per AC-E2b; the `overrides` map allows per-name action overrides from the default.

**And** on confirm, conflicting credentials are resolved per their action: `new_version` creates a new credential version preserving all metadata (dependencies, rotation schedule, tags, notes); `skip` leaves the existing credential unchanged; `create_new` creates a new credential with a `_imported_<timestamp>` suffix.

**And** import operations never modify `dependencyRecords`, `rotationSchedule`, or `notes` on existing credentials — only the `value` (via a new version) is affected.

**And** import previews expire after 15 minutes (stored in a `pending_imports` table with TTL); a confirm call after expiry returns `410 { error: "import_expired" }`.

**And** `.env` parsing supports: `KEY=value`, `KEY="quoted value"`, `KEY='single quoted'`, `export KEY=value`; lines starting with `#` are skipped; lines without `=` produce a warning in the preview response.

**And** JSON import format: `{ "KEY": "value", ... }` (flat object only; nested objects return `422`).

**And** imports are limited to 500 credentials per file; exceeding this returns `422 { error: "import_too_large", limit: 500 }`.

**And** integration tests cover: .env parse, JSON parse, conflict preview, new_version action (metadata preserved), skip action, create_new action, batch default + per-name override, expiry.

---

#### Story 2.6: Onboarding Wizard

*Covers: FR9*

> **Readiness note (Epic 2 planning pass, 2026-06-27):** Onboarding triggers **once per user per org** and is permanently dismissible — the `user_onboarding` table keyed by `(userId, orgId)` is the source of truth; `POST /api/v1/users/me/onboarding { completed: true }` must make the wizard never re-trigger on subsequent logins or project creation (AC-E2c). Operators bootstrapping via Docker ENV / direct API are exempt (web-UI first-access only; the API has no wizard gate). Step 2 completes only on a real non-empty credential value (no placeholder/demo). Relies on: Story 2.1 (first project), Story 2.2 (real credential create), Story 2.0 (web shell/auth guard). Consumed by: none downstream — it is a one-time UX gate, not a data dependency.

**As a** new user accessing the web UI for the first time after creating an account,
**I want** a guided onboarding wizard that teaches me project-centric organization and walks me through adding my first real credential,
**So that** I understand the vault's model and can place secrets confidently before working independently.

**Acceptance Criteria:**

**Given** a user has just registered and created their first project (Story 2.1),
**When** they access the web UI for the first time,
**Then** the onboarding wizard launches automatically and cannot be bypassed — all other UI navigation is disabled until the wizard completes or the user places at least one real credential (not a placeholder or demo value).

**And** the wizard has exactly 3 steps: (1) "Why projects?" — explains project-centric model with a visual showing projects containing credentials, services, and certificates; (2) "Add your first credential" — an inline credential creation form; (3) "What's next?" — summary of what they can now do and links to import bulk credentials or add a service.

**And** the wizard never shows an "environment" layer or environment-based mental model — the structure shown is always: Organization → Project → Assets (UX-DR1).

**And** step 2 is only completable when the user has created a credential with a real non-empty `value` and at least one character in `name`; submitting with empty values shows validation errors inline.

**And** `POST /api/v1/users/me/onboarding` with `{ completed: true }` marks the wizard as permanently dismissed for this user in this org; it never re-triggers on subsequent logins or project creation (AC-E2c).

**And** a user who accesses the web UI via direct URL (e.g., a deep link to a credential) is redirected to the wizard first; after completing the wizard they are redirected to their original destination.

**And** the `user_onboarding` table stores: `userId`, `orgId`, `completedAt`, `firstCredentialId`; this is the source of truth for wizard state.

**And** operators bootstrapping the instance via Docker ENV or direct API calls are explicitly exempt from the wizard — it only applies to web UI first-access; the API has no wizard requirement.

**And** integration tests cover: wizard state per-user per-org, completion gate (empty value rejected), permanent dismissal, direct-URL redirect.

---

#### Story 2.7: Cross-Project Global Search

*Covers: FR80*

> **Readiness note (Epic 2 planning pass, 2026-06-27):** Global search MUST exclude credential values and any secret material entirely — it matches only credential `name`/`description`/`tags`, project `name`/`tags`. The negative test (searching a known credential plaintext returns zero results) is a **required passing CI check** (AC-E2a), reusing the same never-index-values invariant established in Story 2.2 (no value column) and enforced by the Story 2.3 CI lint rule (`scripts/check-search-index.ts`); the `pg_trgm` indexes added here go on `name`/`description`/`tags` only, never on value/encrypted columns. Results are org-scoped at the DB query level via RLS (not post-filtered). Relies on: Story 2.3 (search/index foundation + lint rule), Story 2.2 (value-free schema), Story 2.1 (projects). Consumed by: the web shell's global search affordance.

**As a** developer working across multiple projects,
**I want** to search all accessible credentials, services, and projects by name or tag from anywhere in the product,
**So that** I can find any asset in under 3 keystrokes without knowing which project it belongs to.

**Acceptance Criteria:**

**Given** a user has access to multiple projects,
**When** they call `GET /api/v1/search?q=<term>&types=credentials,projects,services&limit=10`,
**Then** the response returns matching results across all projects the user can access within their org: `{ results: [{ type, id, name, projectId, projectName, matchedField, snippet }], total }`.

**And** search matches on: credential `name` and `description`, project `name`, project `tags`, credential `tags`; it does NOT match on credential values, encrypted data, or any secret material — a negative test asserting this is a required passing CI check (AC-E2a).

**And** results are ordered by relevance score (name exact match > name prefix > description/tag match) then by `updatedAt` descending within each score tier.

**And** the search uses PostgreSQL `pg_trgm` trigram indexes on `name`, `description`, and `tags` columns for efficient substring matching; a migration adds these indexes in this story.

**And** search results respect org-scoped RLS — a user sees only results from their own org, enforced at the DB query level, not filtered post-query.

**And** `GET /api/v1/search` requires the user to be authenticated; unauthenticated calls return `401`.

**And** `limit` is capped at 50; `types` defaults to all types if omitted.

**And** integration tests include: multi-project result, type filter, relevance ordering, negative test (no credential values in results), cross-org isolation.

---

### Epic 3: Notification Infrastructure — Alert Delivery, Routing & In-App Inbox
**🟢 Tier 0 — Required for all beta tiers** *(hard dependency: must ship in sprint immediately following Epic 1)*
> 🔵 **Beta cuts (T2 recommended scope):** FR107 (in-product inbox) and FR100 (per-alert-type routing) are deferrable. Email + Slack delivery to org owner is sufficient to validate the alert story at beta. Inbox and routing are Tier 1 enhancements.
> 🟢 **G2 gate:** FR107 inbox and FR100 routing are required for **epic completion** in sprint-status. T2 beta-cut defers them only for **external tier packaging**, not for marking `epic-3: done`.
All alert-generating features across epics 1-9 have working delivery. Users receive notifications via email and Slack, manage personal preferences and delivery channels, configure per-alert-type routing to specific users or roles, and access a persistent in-product notification inbox with unread count in global nav — providing complete alert delivery from this point forward.

**FRs covered:** FR51, FR52, FR94, FR100, FR107
> ⚠️ FR73 (failed auth alerting, built in Epic 1) delivers via the notification infrastructure established in this epic.
> 📋 **AC-E3a — FR51 email delivery mechanism:** Story must specify: email is sent via operator-configured SMTP (host/port/credentials in system settings, Epic 9). No hardcoded third-party SaaS provider. Acceptance criteria includes: a vault with a valid SMTP config successfully sends a test email from the notification settings page.
> 📋 **AC-E3b — FR107 inbox update mechanism:** In-product notification inbox uses server-sent events (SSE) or polling at ≤30s interval. WebSocket is out of v1 scope. Story must specify the chosen mechanism and its fallback behavior when the connection drops.
> 📋 **AC-E3c — FR100 routing targets:** Per-alert-type routing supports routing to a named role (e.g., "Admin", "Owner") resolved to current role members at send-time. Routing to individually named users is v2. Story must specify role-resolution behavior when a role has zero members (fall back to org owner; log a warning).
> 📋 **AC-E3d — FR94 preference scope:** Notification preferences are per-user per-org. A user in multiple orgs can configure separate delivery channels per org. Global cross-org preferences are v2.

#### Story 3.1: Email & Slack Notification Delivery

*Covers: FR51, FR52*

**As a** vault user,
**I want** to receive vault alerts and events via email and Slack,
**So that** I am notified of security events, expiring credentials, and system issues without checking the dashboard.

**Acceptance Criteria:**

**Given** SMTP is configured via env vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`),
**When** a `notification_queue` entry is created with `channel: "email"`,
**Then** a pg-boss job (`send-email`) picks it up and sends via SMTP using `nodemailer`; on success the entry is marked `delivered`; on failure it is retried up to 3 times with exponential backoff before being marked `failed`.

**And** email templates are plain-text-first with an HTML alternative; stored in `apps/api/src/notifications/templates/`; no external template service is used.

**And** Slack delivery uses the Incoming Webhooks API (`SLACK_WEBHOOK_URL` env var); retried 3 times on failure.

**And** the `notification_queue` table: `id`, `orgId`, `recipientUserId` (nullable), `channel` (email | slack | inbox), `templateId`, `payload` (JSONB), `status` (pending | delivered | failed | suppressed), `attemptCount`, `lastAttemptAt`, `deliveredAt`, `createdAt`.

**And** `POST /api/v1/admin/notifications/test` (admin only) sends a test notification via each configured channel and returns `{ email: "delivered" | "failed" | "not_configured", slack: ... }` (AC-E3a).

**And** all `PENDING_DELIVERY` security alerts from Story 1.9 (FR73) are processed: the delivery job queries `security_alerts WHERE status = 'PENDING_DELIVERY'` and creates `notification_queue` entries.

**And** integration tests cover: email delivery (nodemailer mock transport), Slack delivery (webhook mock), retry on failure, PENDING_DELIVERY alert processing.

---

#### Story 3.2: Notification Preferences & Per-Alert-Type Routing

*Covers: FR94, FR100*

**As a** user and administrator,
**I want** personal notification preferences per alert type and org-level routing configuration,
**So that** I receive signal-quality alerts and critical events reach the right responders.

**Acceptance Criteria:**

**Given** a user is authenticated,
**When** they call `GET /api/v1/users/me/notification-preferences`,
**Then** they receive their preferences: `[{ alertType, channel: "email"|"slack"|"inbox"|"none", frequency: "immediate"|"digest_daily", minSeverity: "info"|"warning"|"critical" }]`; defaults: all types, email + inbox, immediate, warning+.

**And** `PUT /api/v1/users/me/notification-preferences` replaces the full array; `PATCH` supports per-alert-type partial update.

**And** preferences are per-user per-org; `org_id` is derived from the JWT (AC-E3d).

**And** `GET /api/v1/org/notification-routing` (admin only) returns routing config: `[{ alertType, routeTo: "owner"|"admin"|"member" }]`; default: all types → `owner`.

**And** `PUT /api/v1/org/notification-routing` updates routing; if a role has zero members the alert falls back to `owner` and emits a `notification.routing_fallback` warning log (AC-E3c).

**And** the dispatcher resolves recipients at send-time: (1) check org routing, (2) filter by user preferences and severity, (3) deduplicate by user+channel, (4) enqueue one `notification_queue` entry per recipient+channel.

**And** integration tests cover: preference CRUD, per-org isolation, routing resolution, zero-member fallback, severity filtering.

---

#### Story 3.3: In-Product Notification Inbox

*Covers: FR107*

**As a** user who relies on the web UI as my primary interface,
**I want** a persistent notification inbox in global navigation showing all alerts routed to me,
**So that** I never miss a vault event even without configuring email or Slack.

**Acceptance Criteria:**

**Given** a user is authenticated and the web UI is open,
**When** a new notification is routed to them via the inbox channel,
**Then** the unread count in global nav updates within 30 seconds without a page refresh via SSE (AC-E3b).

**And** `GET /api/v1/notifications/stream` (authenticated) opens an SSE connection; the server pushes `{ type: "new_notification", unreadCount }` events; if the connection drops the client reconnects with backoff (1s → 2s → 4s → max 30s).

**And** `GET /api/v1/notifications/inbox?page=&limit=&status=unread|read|all` returns paginated entries: `[{ id, alertType, title, body, severity, createdAt, readAt, resourceId, resourceType, projectId }]`.

**And** `POST /api/v1/notifications/inbox/:id/read` marks a single entry read; `POST /api/v1/notifications/inbox/read-all` marks all read.

**And** `DELETE /api/v1/notifications/inbox/:id` permanently dismisses an entry.

**And** inbox entries expire after 90 days (`INBOX_RETENTION_DAYS` env var); a daily pg-boss job purges expired entries.

**And** `GET /api/v1/users/me` includes `{ notifications: { unreadCount } }` for initial badge render without SSE.

**And** integration tests cover: SSE push on new notification, reconnect behavior, pagination, read/dismiss, expiry purge.

---

### Epic 4: Team & Organization Management — Roles, Invitations, Access & Lifecycle
**🔵 Tier 1 — Team beta**
> 🔵 **Beta cuts (T2 recommended scope):** FR56 (account recovery) and FR45 (account deactivation) are deferrable — beta users can be assisted manually. FR63 (project archival) can be deferred; projects at beta scale are rarely archived.
Project owners can invite team members, assign roles, and transfer ownership; organization admins can view and govern all users across projects, change roles, deactivate accounts with immediate access revocation, and manage account recovery workflows; project members can be removed from individual projects; projects can be safely archived with dependency checks.

**FRs covered:** FR2, FR3, FR4, FR5a, FR5b, FR5c, FR45, FR56, FR62, FR63
> ⚠️ FR63 (project archival): machine user dependency guard is partially implemented here; the full guard (checking active machine user API key access) is completed in Epic 7.
> ⚠️ **Acceptance criteria note for FR63:** Epic 4 archival blocks only on team member access. The check for active machine user API keys is explicitly stubbed and incomplete until Epic 7. QA must not sign off FR63 as fully complete until Epic 7 is delivered.
> ⚠️ **PJ3 — FR45 → FR84 session revocation:** Account deactivation (FR45) must explicitly trigger org-level session revocation (FR84, Epic 1). Story for FR45 must call the FR84 session invalidation path as part of the deactivation transaction — not as an eventual side-effect. Acceptance criteria: deactivated user's active sessions are invalidated synchronously on deactivation.
> 📋 **AC-E4a — FR45 deactivation scope:** Deactivation scopes to the org where the admin performed the action. If the user is a member of other orgs, those memberships are unaffected. Cross-org deactivation (platform-level ban) is an Epic 9 / operator action only.
> 📋 **AC-E4b — FR56 recovery initiator:** Account recovery can be self-initiated (user requests a recovery link via email) OR admin-initiated (admin sends recovery link from user management UI). Story must implement both paths. Edge case: if no admin exists and no recovery email is accessible, the break-glass recovery path is a platform operator action (Epic 9 scope); document this boundary explicitly.
> 📋 **AC-E4c — FR4 ownership transfer eligibility:** Ownership transfer target must be an existing accepted member of the project (not a pending invite). Story must validate this constraint and return a clear error if attempted with a pending invite.

#### Story 4.1: Team Invitations & Role Assignment

*Covers: FR2, FR3*

**As a** project owner or admin,
**I want** to invite users to my project by email and assign them a role,
**So that** teammates can access the credentials and assets they need with appropriate permissions.

**Acceptance Criteria:**

**Given** a project owner or admin is authenticated with MFA enrolled,
**When** they call `POST /api/v1/projects/:projectId/invitations` with `{ email, role: "admin"|"member"|"viewer" }`,
**Then** an invitation record is created with a cryptographically random token (256-bit, base62, 44 chars), stored hashed in `project_invitations`: `id`, `projectId`, `orgId`, `email`, `roleToAssign`, `tokenHash`, `invitedBy`, `expiresAt` (72 hours), `acceptedAt` (null), `revokedAt` (null).

**And** an email is sent to the invited address with an accept link containing the plaintext token; the token is not stored in plaintext anywhere after the email is sent.

**And** `POST /api/v1/invitations/:token/accept` (unauthenticated or authenticated): if the user has an account, they are added to the project with the assigned role and the invitation is marked accepted; if no account exists, they are redirected to registration with the invitation token preserved in the session.

**And** a user can hold different roles across different projects in the same org (FR3); `organization_members` tracks org-level membership and `project_members` tracks project-level role.

**And** inviting a user who is already a project member returns `409 { error: "already_member" }`.

**And** invitation tokens expire after 72 hours; expired token accept attempts return `410 { error: "invitation_expired" }`.

**And** `GET /api/v1/projects/:projectId/invitations` (admin+) lists pending invitations: `[{ id, email, roleToAssign, invitedBy, expiresAt }]` — token is never returned.

**And** `DELETE /api/v1/projects/:projectId/invitations/:id` revokes a pending invitation.

**And** no user may invite to a role higher than their own role (NFR-SEC10); an admin cannot invite an owner.

**And** integration tests cover: invite, accept (existing user), accept (new user), expired token, role elevation rejection, revocation.

**And** (FR57 / Epic 1 retro P4 — MFA journey) unenrolled owner/admin cannot create invitations; enrolled owner/admin who completed the Story 1.12 login challenge (`mfaRequired` → `verify-login`) can invite successfully. Persona journey references `_bmad-output/planning-artifacts/mfa-policy-matrix.md` row "Owner/admin, MFA enrolled". Regression: `apps/api/src/__tests__/mfa-journey.integration.test.ts` must remain green.

---

#### Story 4.2: Organization User Management

*Covers: FR4, FR5a, FR5b, FR5c, FR62*

**As an** organization admin,
**I want** to view all users across all projects, change their roles, remove them from projects or the org, and transfer project ownership,
**So that** I can maintain a clean, accurate access model as the team evolves.

**Acceptance Criteria:**

**Given** an org admin is authenticated,
**When** they call `GET /api/v1/org/users`,
**Then** they receive a list of all users in the org with their membership across every project: `[{ userId, email, displayName, orgRole, projects: [{ projectId, projectName, role }] }]` (FR5a).

**And** `DELETE /api/v1/org/users/:userId` removes the user from the organization and all its projects; their account is not deleted; their org membership record is removed; their sessions in this org are invalidated synchronously (FR5b, leveraging FR84 from Story 1.7).

**And** `PUT /api/v1/org/users/:userId/projects/:projectId/role` with `{ role }` changes a user's role in a specific project; an admin cannot assign a role higher than their own (NFR-SEC10); the change is recorded in the audit log (FR5c).

**And** `DELETE /api/v1/projects/:projectId/members/:userId` removes a user from a specific project without affecting their org account or membership in other projects (FR62); the last owner of a project cannot be removed.

**And** `POST /api/v1/projects/:projectId/transfer-ownership` with `{ newOwnerId }` transfers project ownership; target must be an existing accepted member (not a pending invite — AC-E4c); the current owner's role becomes `admin`; the audit log records the transfer.

**And** no admin can modify their own role or remove themselves from the org (NFR-SEC10); self-modification returns `403 { error: "cannot_modify_self" }`.

**And** integration tests cover: org user list, remove from org (sessions invalidated), role change, project-only removal, ownership transfer, self-modification rejection.

---

#### Story 4.3: Account Deactivation & Recovery

*Covers: FR45, FR56, FR102*

**As an** organization admin,
**I want** to deactivate user accounts with immediate access revocation and support account recovery for users who lose MFA access,
**So that** offboarded users are immediately locked out and locked-out users have a governed recovery path.

**Acceptance Criteria:**

**Given** an org admin is authenticated,
**When** they call `POST /api/v1/org/users/:userId/deactivate`,
**Then** the user's `organization_members.status` is set to `deactivated`; all their active sessions in this org are invalidated synchronously via the FR84 path (AC-E4a, PJ3); all their pending project invitations are revoked; the deactivation is recorded in the audit log as a privileged event.

**And** a deactivated user's API requests return `403 { error: "account_deactivated" }` immediately after deactivation — the `session_version` increment ensures their existing JWTs are invalid within their 5-minute TTL.

**And** if the user being deactivated has any `in_progress` rotation workflows, deactivation is blocked with `409 { error: "active_rotations", rotationIds: [...] }` until each rotation is cancelled, transferred to another admin, or held pending review — the chosen outcome is recorded in the audit log (FR102).

**And** account recovery (FR56) is initiated two ways: (a) self-initiated — `POST /api/v1/auth/recovery/request` with `{ email }` sends a time-limited recovery link (15 minutes) to the user's email; (b) admin-initiated — `POST /api/v1/org/users/:userId/recovery/send-link` sends the same link from the admin UI.

**And** `POST /api/v1/auth/recovery/:token/complete` with `{ newPassword, totpCode? }` completes recovery: resets the password, optionally re-enrolls MFA if a TOTP code from a new device is provided, and invalidates all existing sessions.

**And** if no admin exists and no recovery email is accessible, recovery requires a platform operator action (Epic 9); this boundary is explicitly documented in the `404` response from the recovery request endpoint when the org has no active admins.

**And** every step of account recovery (initiation, admin approval if required, completion) is recorded in the audit log as a privileged event (FR102).

**And** integration tests cover: deactivation (session invalidation verified), active-rotation block, self-initiated recovery, admin-initiated recovery, completion, no-admin boundary.

---

#### Story 4.4: Project Archival

*Covers: FR63*

**As a** project owner,
**I want** to archive projects that are no longer active,
**So that** they disappear from my active dashboard while preserving all credentials, history, and audit records.

**Acceptance Criteria:**

**Given** a project owner is authenticated,
**When** they call `POST /api/v1/projects/:projectId/archive`,
**Then** the system checks for active dependencies before archiving: if the project has credentials with active `in_progress` rotation records, archival returns `409 { error: "active_rotations", rotationIds: [...] }`.

**And** the machine user API key dependency check is explicitly stubbed with a comment `// TODO: Epic 7 — check for active machine user API key access` returning `false` (no block) until Epic 7 is delivered; QA must not sign off FR63 as fully complete until Epic 7 closes this stub (per Epic 4 notes).

**And** if no blockers exist, `projects.archived_at` is set to `NOW()`; the project disappears from `GET /api/v1/projects` by default; `?includeArchived=true` restores it to the list.

**And** all credentials, versions, rotation history, and audit records within the archived project are preserved — archival is non-destructive.

**And** an archived project cannot receive new credentials, members, or invitations; attempts return `410 { error: "project_archived" }`.

**And** `POST /api/v1/projects/:projectId/unarchive` reverses archival (owner only).

**And** integration tests cover: archive with active rotations (blocked), archive clean (succeeds), archived project hidden from default list, no new credentials after archive, unarchive.

---

### Epic 5: Credential Rotation — Safe, Trackable Rotation Workflows
**🟣 Tier 2 — Operational beta (recommended beta target)** *(key differentiator from password managers)*
> 🔵 **Beta cuts (T2 recommended scope):** FR108 (break-glass emergency rotation) and FR104 (dependency archival) are deferrable. Core rotation workflow (FR18–FR23, FR65, FR66, FR75) is the essential beta story.
Users can initiate rotation workflows with per-system confirmation checklists (including fallback-active flagging), track live rotation status, handle confirmation failures without abandoning the rotation, archive stale dependent system records, manage complete rotation history, and invoke break-glass emergency rotation during incidents — with full audit coverage and stale-rotation recovery.

**FRs covered:** FR18, FR19, FR20, FR21, FR22, FR23, FR65, FR66, FR75, FR104, FR108
> ⚠️ **PJ1 — FR19 checklist source:** The rotation checklist must be auto-populated from FR16 dependent system records (Epic 2). See Epic 2 note. Story for FR19 must not require the user to re-enter systems they already recorded.
> ⚠️ **PJ7 — Break-glass gap:** FR108 (break-glass emergency rotation) covers credential rotation only. There is no emergency path for machine user API key rotation under incident conditions — that gap is addressed in Epic 7. Stories for FR108 must explicitly document this scope boundary: break-glass applies to vault-stored credentials, not machine user API keys.
> ⚠️ **PJ8 — Post-break-glass sweep:** After a break-glass rotation completes, dependent systems may still hold the old credential. FR108 acceptance criteria must include: (a) break-glass rotation emits a "sweep required" audit event listing all FR16-recorded dependent systems, and (b) the UI surfaces a post-rotation dependent system sweep checklist (even if non-blocking) so on-call engineers are not left without a recovery checklist.
> 📋 **AC-E5a — FR21 minimum checklist gate:** A credential with zero dependent system records (FR16) must still require at least one explicit confirmation step before rotation can be marked complete. An empty checklist that auto-completes is not acceptable. Story must define the minimum gate (e.g., an explicit "I confirm this credential is updated in all consuming systems" acknowledgement checkbox).
> 📋 **AC-E5b — FR75 max retry timeout:** A rotation confirmation failure (system fails to confirm update) may be retried a maximum of 3 times (configurable by admin, min 1 max 10). After the maximum is reached, the rotation transitions to `confirmation-failed` state and an alert is sent. Indefinite retry is not acceptable.
> 📋 **AC-E5c — FR108 old-version retirement:** Break-glass rotation does NOT immediately retire the old credential version (FR22). The old version remains accessible for a configurable emergency overlap window (default: 1 hour) to allow in-flight systems to drain. After the overlap window, the old version is automatically retired. The overlap window and its expiry are surfaced in the UI.
> 📋 **AC-E5d — Stale rotation recovery resolution:** The stale-rotation recovery job transitions an `in_progress` rotation older than the configured threshold to `stale-recovery` state. Resolution action: an admin must explicitly choose "resume" or "abandon". The system does not auto-resolve. An alert is sent when any rotation enters `stale-recovery`.
> 🔴 **RS-E5a — State machine optimistic locking:** All rotation state transitions must be performed as DB-level transactions with optimistic locking on the rotation record (e.g., a `version` column incremented on every write). Concurrent transition attempts on the same rotation must return a `409 Conflict` error — not silently overwrite each other. Stories for FR18, FR20, FR21, FR22, and FR108 must each specify the locking mechanism in their acceptance criteria.

#### Story 5.1: Rotation Initiation & Checklist Generation

*Covers: FR18, FR19, FR23*

**As a** developer who has updated a credential in its target systems,
**I want** to initiate a formal rotation workflow that generates a checklist of all dependent systems,
**So that** nothing is missed and the rotation history is permanently recorded.

**Acceptance Criteria:**

**Given** a credential exists with recorded dependencies (Story 2.4),
**When** a user with `admin` or `owner` role calls `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations`,
**Then** a PostgreSQL advisory lock is acquired on the credential ID; if a rotation is already `in_progress` for this credential, the request returns `409 { error: "rotation_in_progress", rotationId }`.

**And** a `rotations` record is created with: `id`, `credentialId`, `projectId`, `orgId`, `status` (`in_progress`), `version` (integer, starts at 1 — optimistic lock column per RS-E5a), `initiatedBy` (user_identity_token ref), `initiatedAt`, `completedAt` (null), `notes` (optional from request body).

**And** a `rotation_checklist_items` record is created for each non-archived `credential_dependency` (Story 2.4 FR16 records — PJ1); each item: `id`, `rotationId`, `dependencyId`, `systemName`, `status` (`unconfirmed`), `confirmedBy` (null), `confirmedAt` (null), `notes` (null).

**And** the rotation initiation, all checklist items, and a new credential version (with the updated value from the request body `{ newValue }`) are written in a single atomic transaction (NFR-REL3); if any write fails, the entire transaction is rolled back.

**And** `GET /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId` returns the full rotation record with checklist items and current status.

**And** rotation history is immutable — completed and abandoned rotation records cannot be deleted or modified, only queried (FR23).

**And** `GET /api/v1/projects/:projectId/credentials/:credentialId/rotations` returns paginated rotation history: `[{ id, status, initiatedBy, initiatedAt, completedAt, itemCount, confirmedCount }]`.

**And** integration tests cover: successful initiation (advisory lock, atomic write, checklist populated from dependencies), concurrent initiation rejection (409), zero-dependency credential (checklist has zero items — minimum gate covered in Story 5.2), rotation history query.

---

#### Story 5.2: Rotation Checklist Confirmation & Completion

*Covers: FR20, FR21, FR22, FR66, FR75*

**As a** developer completing a credential rotation,
**I want** to confirm each dependent system has been updated and complete the rotation when all are confirmed,
**So that** the old credential version is retired only after every system is safely updated.

**Acceptance Criteria:**

**Given** a rotation is `in_progress`,
**When** a user calls `POST /api/v1/rotations/:rotationId/checklist/:itemId/confirm` with `{ notes? }`,
**Then** the checklist item's `status` is updated to `confirmed`, `confirmedBy` (user_identity_token ref) and `confirmedAt` are set; the rotation record's `version` is incremented (optimistic lock — RS-E5a); a concurrent update to the same rotation returns `409 { error: "concurrent_modification", currentVersion }`.

**And** `POST /api/v1/rotations/:rotationId/checklist/:itemId/fail` with `{ reason, retryScheduledAt? }` records a confirmation failure; the item transitions to `failed`; an alert is queued via the notification system; the rotation remains `in_progress` so the user can retry or escalate (FR75).

**And** a failed item can be retried (reset to `unconfirmed`) via `POST /api/v1/rotations/:rotationId/checklist/:itemId/retry`; retry is limited to a configurable maximum (default: 3, admin-configurable: min 1 max 10); after the maximum is reached the item transitions to `max_retries_exceeded` and an alert fires (AC-E5b).

**And** `POST /api/v1/rotations/:rotationId/complete` attempts to complete the rotation; it is blocked if any checklist item is not `confirmed` — returning `422 { error: "checklist_incomplete", pendingItems: [...] }` (FR21).

**And** if a credential has zero recorded dependencies, the completion endpoint requires an explicit `{ acknowledgedNoDependencies: true }` flag in the request body before it proceeds — an empty checklist does not auto-complete (AC-E5a).

**And** on successful completion: the rotation `status` transitions to `completed`, `completedAt` is set, the old credential version's `status` is set to `retired`; all three writes are atomic (NFR-REL3, NFR-REL4); the old version remains queryable in history but `GET /credential/:id/value` returns only the current version.

**And** `GET /api/v1/rotations/:rotationId` returns live rotation status including per-item state — this is the live status view (FR66).

**And** `GET /api/v1/projects/:projectId/rotations/upcoming` returns credentials with upcoming rotation schedules filtered by `?horizon=7d|30d|90d` (FR65).

**And** integration tests cover: confirm item (optimistic lock verified), fail item, max retries exceeded, complete with pending items (blocked), complete with zero deps (requires flag), complete success (old version retired, atomic write), concurrent modification 409.

---

#### Story 5.3: Stale Rotation Recovery & Break-Glass Emergency Rotation

*Covers: FR108, FR104*

**As an** organization admin handling an incident,
**I want** a break-glass emergency rotation path that immediately retires the old credential and a stale rotation recovery mechanism,
**So that** I can act in seconds during a breach without waiting for checklist confirmation, and abandoned rotations don't block future work.

**Acceptance Criteria:**

**Given** an org admin is authenticated and a credential exists,
**When** they call `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass` with `{ newValue, reason }`,
**Then** a rotation record is created with `status: "break_glass_complete"` immediately; the old credential version is NOT retired immediately — it enters a `break_glass_overlap` status and is accessible for a configurable overlap window (default: 1 hour, `BREAK_GLASS_OVERLAP_MINUTES` env var) to allow in-flight systems to drain (AC-E5c).

**And** after the overlap window expires, a pg-boss job automatically retires the old version and transitions it to `retired`; this expiry event is recorded in the audit log.

**And** the break-glass action is recorded as a `high_severity` audit event with the reason; all org admins receive an alert via the notification system (FR108); the alert includes a post-rotation sweep checklist listing all FR16 recorded dependencies (PJ8).

**And** `POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/break-glass` is scoped to `org_admin` role only; a project admin cannot trigger break-glass.

**And** a startup job and a pg-boss recurring check (every 15 minutes) scan `rotations WHERE status = 'in_progress' AND initiated_at < NOW() - INTERVAL '1 hour'` (configurable `STALE_ROTATION_THRESHOLD_MINUTES`); stale rotations transition to `stale_recovery`; all pending checklist items reset to `unconfirmed`; the initiating admin and FR100-configured recipients are notified.

**And** from `stale_recovery` state, an admin must explicitly choose: `POST /api/v1/rotations/:rotationId/resume` (reset to `in_progress`, checklist preserved) or `POST /api/v1/rotations/:rotationId/abandon` (marks rotation `abandoned`, old version remains current — the new version written at initiation is marked `abandoned_version`); the system never auto-resolves (AC-E5d).

**And** `DELETE /api/v1/projects/:projectId/credentials/:credentialId/dependencies/:dependencyId` archives a dependency record (FR104); the record is hidden from new rotation checklists but preserved in historical rotation records; the archival is recorded in the audit log; only users with rotation initiation permission may archive dependencies.

**And** integration tests cover: break-glass (overlap window, old version accessible during overlap, retired after), stale detection job, resume, abandon, dependency archival (hidden from new checklist, present in historical).

---

### Epic 6: Operational Monitoring & Status — Services, Certificates, Domains & Mobile
**🟣 Tier 2 — Operational beta (recommended beta target)** *(completes the proactive alert story)*
> 🔵 **Beta cuts (T2 recommended scope):** FR72 (mobile browser) and FR76/FR77 (public status pages) are deferrable. Desktop-first monitoring is sufficient for beta validation. Public status pages are a customer-facing feature better suited for GA.
Users can register and monitor services, SSL certificates, and domains; receive proactive expiry and availability alerts with intelligent defaults; dismiss/snooze alerts; view cross-project health status and public status pages with unguessable token URLs; and perform all incident-response actions on mobile browsers — completing the mobile-optimized experience at the point where users actually need it.

**FRs covered:** FR24, FR25, FR26, FR27, FR28, FR29, FR31, FR67, FR72, FR76, FR77, FR99
> 📋 **AC-E6a — FR27 monitoring check frequency and down threshold:** HTTP endpoint checks run every 5 minutes (configurable: 1/5/15/30 min). A service is marked "down" after 2 consecutive failed checks. These are the v1 defaults; story must hard-code them as defaults and make them configurable per-service.
> 📋 **AC-E6b — FR28 alert default lead times:** Default alert lead times must be specified in the story: SSL certificate expiry — 30 days and 7 days; domain expiry — 30 days; credential expiry — 14 days and 3 days. "Intelligent defaults" is not an acceptable acceptance criterion without these specific values.
> 📋 **AC-E6c — FR67 snooze re-trigger behavior:** Snoozing an alert suppresses re-notification for the snooze duration. However, if a new threshold is crossed during the snooze (e.g., certificate passes from "30 days out" threshold to "7 days out" threshold), a new alert is generated regardless of the snooze. Snooze suppresses the same-threshold re-notification only.
> 📋 **AC-E6d — FR72 mobile browser target matrix:** v1 target: Chrome (latest) and Safari (latest) on iOS 16+ and Android 13+. Story must include mobile browser testing in acceptance criteria against this matrix. Other mobile browsers are best-effort.

#### Story 6.1: Service, Certificate & Domain Record Management

*Covers: FR24, FR25, FR26, FR28, FR29*

**As a** developer tracking my operational assets,
**I want** to register services, SSL/TLS certificates, and domains with expiry dates and receive proactive alerts before they expire,
**So that** nothing silently lapses and causes an outage.

**Acceptance Criteria:**

**Given** a project exists,
**When** a user calls `POST /api/v1/projects/:projectId/services` with `{ name, url?, renewalDate?, alertLeadDays?: [14, 3] }`,
**Then** a `monitored_assets` record is created with `assetType: "service"`, `name`, `url` (nullable), `renewalDate` (nullable), `alertLeadDays` (array, default: `[14, 3]`), `orgId`, `projectId`.

**And** `POST /api/v1/projects/:projectId/certificates` creates an asset with `assetType: "certificate"`, `domain`, `expiresAt`, `alertLeadDays` (default: `[30, 7]` per AC-E6b).

**And** `POST /api/v1/projects/:projectId/domains` creates an asset with `assetType: "domain"`, `domainName`, `renewalDate`, `alertLeadDays` (default: `[30]`).

**And** assets with time-sensitive properties (any asset with `expiresAt` or `renewalDate`) are automatically enrolled in monitoring when registered — no extra configuration step required (UX-DR9).

**And** a pg-boss scheduled job runs daily at 08:00 UTC: for each monitored asset, it computes days until expiry/renewal; if `daysRemaining` matches any value in `alertLeadDays` (±1 day tolerance), it queues a notification via Story 3.1 with `alertType: "asset_expiry"`, severity computed from days remaining: ≤3 days → `critical`, ≤7 days → `warning`, ≤30 days → `info`.

**And** `PATCH /api/v1/projects/:projectId/assets/:assetId` updates `renewalDate`, `expiresAt`, or `alertLeadDays`.

**And** `DELETE /api/v1/projects/:projectId/assets/:assetId` removes the asset and cancels any pending alerts for it.

**And** integration tests cover: create each asset type, daily alert job (days-matching logic), alert severity mapping, update renewal date, delete cancels alerts.

---

#### Story 6.2: HTTP Endpoint Monitoring & Availability Alerts

*Covers: FR27, FR31, FR67, FR99*

**As a** developer monitoring services,
**I want** the vault to check my registered HTTP endpoints and alert me when they go down or recover, and when anomalous access patterns are detected,
**So that** I am notified of availability issues and unusual credential access without manual monitoring.

**Acceptance Criteria:**

**Given** a service asset has a `url` configured,
**When** the pg-boss health check job runs (every 5 minutes by default, configurable per service: 1/5/15/30 min — AC-E6a),
**Then** it performs `GET {url}` with a 10-second timeout; a 2xx response records `status: "healthy"`, `responseTimeMs`, `checkedAt` in `endpoint_health_checks`; a non-2xx or timeout records `status: "unhealthy"`.

**And** a service is marked `down` after 2 consecutive `unhealthy` checks (AC-E6a); a `service.down` alert is queued via the notification system.

**And** when a previously `down` service returns a `healthy` check, a `service.recovered` alert is queued (FR99) and the service status returns to `healthy`.

**And** `GET /api/v1/projects/:projectId/assets/:assetId/health-history?from=&to=&limit=` returns paginated health check history.

**And** `POST /api/v1/projects/:projectId/alerts/:alertId/snooze` with `{ durationMinutes }` suppresses re-notification for the snooze duration; if a new threshold is crossed during the snooze (e.g., service goes from `degraded` to `down`), a new alert fires regardless (AC-E6c); snooze is recorded in the audit log (FR67).

**And** `POST /api/v1/projects/:projectId/alerts/:alertId/dismiss` permanently dismisses the alert; recorded in audit log.

**And** the anomalous access detection job (pg-boss, runs every 60 seconds) queries `audit_events` for credential access events in the past hour per user per project; if any user has ≥ 5 accesses outside their normal access pattern (default threshold, configurable), a `security.anomalous_access` alert is queued to FR100-configured recipients (FR31).

**And** integration tests cover: healthy check recorded, down after 2 consecutive failures, recovery alert, snooze (same threshold suppressed, new threshold fires), dismiss, anomalous access detection.

---

#### Story 6.3: Cross-Project Health Dashboard & Public Status Page

*Covers: FR76, FR77, FR72*

**As a** developer or external stakeholder,
**I want** a cross-project health overview and a shareable public status page for selected services,
**So that** I can monitor all my services in one view and share status with stakeholders who don't have vault accounts.

**Acceptance Criteria:**

**Given** a user has access to multiple projects,
**When** they call `GET /api/v1/health-dashboard`,
**Then** they receive the live availability status of all monitored services across every accessible project: `{ projects: [{ projectId, projectName, services: [{ id, name, status: "healthy"|"degraded"|"down", lastCheckedAt }] }], summary: { healthy, degraded, down } }` (FR76).

**And** `POST /api/v1/projects/:projectId/status-page` (owner only) enables a public status page for the project; it generates a cryptographically random URL token (minimum 128-bit entropy, 22+ base62 chars per FR77); the token is stored hashed; the response includes the plaintext token once — it cannot be retrieved again (only regenerated).

**And** `GET /status/:token` (unauthenticated public endpoint) returns the public status page: `{ services: [{ displayName, status, lastCheckedAt }] }` using operator-configured display names — actual service URLs and internal identifiers are never exposed (FR77).

**And** the public status page endpoint is rate-limited at 60 requests/minute per IP (FR77); exceeding this returns `429`.

**And** `PUT /api/v1/projects/:projectId/status-page` updates the list of services shown and their display names; `DELETE /api/v1/projects/:projectId/status-page` disables the public page (the token URL returns 404).

**And** the web UI renders correctly on Chrome and Safari on iOS 16+ and Android 13+ (AC-E6d); Playwright mobile viewport tests verify: (a) alert deep-links resolve to the affected resource in ≤2 taps from the notification, (b) rotation status and version-per-system are visible without horizontal scrolling, (c) 24-hour audit trail accessible within 3 taps from the affected resource (UX-DR10).

**And** integration tests cover: health dashboard cross-project aggregation, public page token generation (hashed storage, plaintext shown once), public page display name aliasing (no internal identifiers), rate limiting, public page disable (404 after delete).

---

### Epic 7: Machine User Access & CI/CD Integration
**⚪ v1 GA — Post-beta**
> ⚠️ **Release gate:** FR37 (offline fallback cache SDK scope decision) must be resolved before stories can be written. This is a hard pre-story blocker. CI/CD integration also requires a settled credential API (E2) and project model (E4).
Applications and CI/CD pipelines can authenticate with scoped API keys, retrieve secrets programmatically with offline fallback cache, integrate natively with GitHub Actions and GitLab CI, and administrators can manage full key lifecycle — expiry alerts, dormancy detection, and zero-downtime overlap rotation. Project archival machine-user dependency guard is completed here.

**FRs covered:** FR32, FR33, FR34, FR35, FR36, FR37, FR38, FR39, FR68, FR101, FR110
> ⚠️ **PJ2 — Offline fallback cache deliverable:** FR37 (offline fallback cache) requires a client-side agent or SDK that applications install locally. No epic currently ships this artifact. This is a **scope decision**: either (a) add a story in this epic to ship an official SDK/CLI agent package (npm/pip/binary), or (b) document FR37 as requiring a third-party SDK integration pattern and descope the first-party agent to v2. This must be resolved before Epic 7 stories are written.
> 🔴 **RS-E7a — FR37 offline cache encryption (BLOCKER):** The offline fallback cache stores decrypted credential values on the client filesystem — the highest-risk data store outside the vault itself. The cache file must be AES-256-GCM encrypted at rest, keyed from a secret derived from the machine user's API key (e.g., HKDF). File permissions must be set to mode 600 (owner read/write only). An unencrypted cache file fails security review. Story must specify the encryption scheme, key derivation method, and permission enforcement. Cache decryption failure (e.g., key mismatch after key rotation) must return a clear error — not silently fall back to plaintext.
> ⚠️ **PJ4 — Machine user audit trail unification:** FR36 (machine user audit trail) must write to the same append-only audit log table as FR40 (Epic 8), not a separate table. Stories for FR36 must specify the shared `audit_events` table as the target so that Epic 8's search, export, and integrity verification apply uniformly to machine user events.
> ⚠️ **PJ7 — Emergency machine user key rotation:** Break-glass (FR108, Epic 5) does not cover machine user API key rotation. This epic must define an explicit emergency revocation + immediate reissuance path for machine user API keys under incident conditions. Add to FR101 acceptance criteria: emergency revocation must complete within one synchronous API call, with the new key returned in the same response.
> 📋 **AC-E7a — FR39 integration depth:** "GitHub Actions and GitLab CI integration" means: (a) documented usage pattern using the vault REST API + a machine user API key, and (b) an official reusable GitHub Actions action (`project-vault/vault-action`) that retrieves secrets and exports them as masked environment variables. A GitLab CI component equivalent is a v2 item. Story must specify this scope boundary.
> 📋 **AC-E7b — FR110 dormancy threshold:** A machine user API key is considered dormant if it has not been used for authentication or secret retrieval in 90 days (configurable by admin: 30/60/90/180 days). The default is 90 days. Story must include this value.
> 📋 **AC-E7c — FR101 overlap window cap:** The zero-downtime overlap window for machine user key rotation has a maximum of 24 hours (configurable by admin: 1h/4h/8h/24h). Default: 4 hours. After the cap, the old key is automatically revoked regardless of active usage. An alert fires at 1 hour before automatic revocation.

#### Story 7.1: Machine User Identity & API Key Management

*Covers: FR32, FR33, FR36, FR68*

**As an** administrator provisioning programmatic access,
**I want** to create machine user identities with scoped project roles and issue API keys with expiry dates,
**So that** CI/CD pipelines and applications can access secrets without using human user credentials.

**Acceptance Criteria:**

**Given** an org admin is authenticated with MFA enrolled,
**When** they call `POST /api/v1/projects/:projectId/machine-users` with `{ name, role: "member"|"viewer", description? }`,
**Then** a `machine_users` record is created: `id`, `projectId`, `orgId`, `name`, `description`, `role`, `createdBy`, `createdAt`, `deactivatedAt` (null); the machine user is shown a concrete scope boundary before any key is issued: `{ canAccess: ["credentials in project X"], cannotAccess: ["other projects", "org settings", "audit logs"] }` (UX-DR11).

**And** `POST /api/v1/machine-users/:machineUserId/api-keys` with `{ name, expiresAt? }` generates an API key: a 256-bit cryptographically random value (`node:crypto.randomBytes(32)`), encoded as base62 (44 chars), prefixed `pvk_`; the plaintext key is returned **once** in the response and never stored — only a BLAKE2b hash is persisted in `machine_user_api_keys`: `id`, `machineUserId`, `orgId`, `keyHash`, `name`, `expiresAt` (nullable), `lastUsedAt` (null), `createdAt`, `revokedAt` (null).

**And** `DELETE /api/v1/machine-users/:machineUserId/api-keys/:keyId` revokes the key immediately; revoked keys return `401` on any subsequent use.

**And** a pg-boss daily job checks `machine_user_api_keys` for keys expiring within `alertLeadDays` (default: `[14, 3]`); expiring keys trigger `machine_key.expiry` alerts to FR100-configured recipients (FR68).

**And** `GET /api/v1/machine-users/:machineUserId/api-keys` lists keys with metadata: `[{ id, name, expiresAt, lastUsedAt, createdAt, isRevoked }]` — key hashes and plaintext are never returned.

**And** machine user API key events (issuance, revocation, successful authentication, failed authentication) are written to the shared `audit_events` table (PJ4, same table as FR40) — not a separate table.

**And** integration tests cover: machine user creation with scope boundary, key issuance (plaintext once), revocation (401 after), expiry alert job, audit event for each key event.

---

#### Story 7.2: Machine User Authentication & Programmatic Secret Retrieval

*Covers: FR34, FR35, FR37, FR38, FR101, FR110*

**As a** CI/CD pipeline or application,
**I want** to authenticate with an API key and retrieve secrets by name — with a local offline cache if the vault is temporarily unreachable,
**So that** my deployments are not blocked by transient vault unavailability.

**Acceptance Criteria:**

**Given** a valid (non-expired, non-revoked) API key prefixed `pvk_`,
**When** the application calls `POST /api/v1/auth/machine-token` with `Authorization: Bearer pvk_<key>`,
**Then** the server hashes the provided key (BLAKE2b), looks up the matching `machine_user_api_keys` record, validates non-revoked and non-expired, updates `lastUsedAt`, and returns a short-lived JWT (≤1h TTL, `sub: machineUserId`, `scope: projectId`, `keyId`) signed with RS256.

**And** `GET /api/v1/machine/projects/:projectId/credentials/:name/value` with a valid machine JWT returns `{ name, value, versionNumber }` for credentials the machine user's project role authorizes; credential access is recorded in the shared `audit_events` table with `actorType: "machine_user"`.

**And** the offline fallback cache implementation: a first-party npm package (`@project-vault/agent`) is published to the repo as `packages/agent`; it wraps `GET .../credentials/:name/value` with a local encrypted cache file (AES-256-GCM, key derived from the API key via HKDF, file permissions set to 0600 per RS-E7a); cache is activated after 3 consecutive connection failures within 30 seconds (`VAULT_FALLBACK_THRESHOLD` env var).

**And** the cache file stores: `{ credentialName, encryptedValue, versionNumber, cachedAt, ttlSeconds }`; decryption failure (e.g., key mismatch after key rotation) returns a clear error — it does NOT fall back to plaintext.

**And** high-sensitivity credentials (flagged with `cacheable: false` on the credential record) are never written to the offline cache; the agent returns an error if vault is unreachable and the credential is not cacheable.

**And** fallback cache activation events are written to `audit_events` with `eventType: "machine_cache.activated"` and an alert is queued to FR100-configured recipients (FR38).

**And** zero-downtime key rotation: `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/rotate` with `{ overlapMinutes: 240 }` (default 4h, max 24h — AC-E7c) issues a new key (plaintext returned once), starts the overlap window; both old and new keys are valid during the window; after the window, the old key is automatically revoked by a pg-boss scheduled job; if the old key is used after the new key has had at least one successful auth, an anomaly alert fires.

**And** emergency revocation: `POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke` atomically revokes the old key AND issues a new key in the same response: `{ revokedKeyId, newKey: "pvk_...", newKeyId }` (PJ7); the plaintext new key is returned once.

**And** a pg-boss daily dormancy check identifies keys with `lastUsedAt < NOW() - INTERVAL '90 days'` (configurable: 30/60/90/180 days — AC-E7b) or `lastUsedAt IS NULL AND createdAt < threshold`; dormancy alerts include: machine user name, last-used date, projects and credentials in scope; admins can dismiss (with reason), revoke, or extend (FR110).

**And** `packages/agent` completes the Epic 4 FR63 archival stub: `GET /api/v1/projects/:projectId/machine-users/active-keys` is implemented; the project archival endpoint now checks this and blocks if active machine user keys exist.

**And** integration tests cover: machine token issuance, credential retrieval (audit event), fallback activation (3 failed connections), cache file encryption (0600 permissions verified), non-cacheable credential error, overlap rotation, emergency revoke + new key, dormancy detection.

---

#### Story 7.3: GitHub Actions CI/CD Integration

*Covers: FR39*

**As a** developer using GitHub Actions,
**I want** an official `project-vault/vault-action` GitHub Action that retrieves secrets from the vault and exports them as masked environment variables,
**So that** my CI/CD pipelines can use vault secrets without manual API calls or custom scripts.

**Acceptance Criteria:**

**Given** a GitHub Actions workflow with a configured vault URL and machine user API key,
**When** the workflow includes `uses: project-vault/vault-action@v1` with inputs `{ vaultUrl, apiKey, secrets: "PROJECT/CREDENTIAL_NAME as ENV_VAR_NAME" }`,
**Then** the action authenticates with the vault (Story 7.2 machine token flow), retrieves each secret by name, and exports it as a masked environment variable (`::add-mask::` command) so the value never appears in workflow logs.

**And** the action is implemented as a TypeScript GitHub Action in `packages/vault-action/` in the monorepo; it uses `@actions/core` and `@actions/http-client`.

**And** the action handles vault unavailability: if the vault is unreachable and `continueOnError: true` is set, the action warns but does not fail the workflow; if `continueOnError: false` (default), it fails the step.

**And** the action is published to the GitHub Marketplace under `project-vault/vault-action`; the `action.yml` metadata file is complete with all input/output definitions.

**And** the action's README documents: setup, secret mapping syntax (`PROJECT/NAME as ENV_VAR`), multiple secrets (one per line), `continueOnError` option, and a complete example workflow.

**And** a GitLab CI integration is explicitly documented as a v2 item in the action's README; the documented v1 path for GitLab is: use the vault REST API directly with `curl` and the machine token flow.

**And** integration tests (using the GitHub Actions toolkit test utilities) cover: successful secret retrieval + masking, vault unreachable with `continueOnError: true` (warns, does not fail), vault unreachable with `continueOnError: false` (fails step).

---

### Epic 8: Compliance, Audit & Governance
**⚪ v1 GA — Post-beta**
> ℹ️ The `audit_events` table and all event writes from Epics 1-7 are in place before this epic. This epic delivers the query/export UI and compliance workflows on top of already-accumulated data. No data is lost by deferring this epic.
Admins can audit all access and changes in a tamper-evident append-only log with row-level integrity, filter and export for compliance with mandatory integrity verification, forward to write-once external storage, configure retention, generate point-in-time access reports, detect dormant accounts, handle account recovery and deactivation audit trails, verify audit chain integrity, and pseudonymize departed user identities across the entire log.

**FRs covered:** FR40, FR41, FR42, FR43, FR44, FR69, FR70, FR71, FR78, FR102
> ⚠️ **PJ4 — Unified audit log:** FR40 (append-only audit log) must be the single log table that receives events from all epics (credential access from E2, rotation events from E5, machine user access from E7, etc.). This epic delivers the query/export UI on top of that shared table — it does not create a new table. Architecture must confirm one `audit_events` table from Epic 1 schema onwards.
> ⚠️ **PJ5 — Historical event coverage:** Audit events written by Epics 2-7 before this epic's UI exists must be queryable when Epic 8 lands. No data migration required if all prior epics write to the same `audit_events` table (see PJ4). Acceptance criteria for FR41 must include: events from Epics 2-7 are searchable and exportable without re-ingestion.
> ⚠️ **PJ6 — `user_identity_token` backfill:** The `user_identity_token` schema is an Epic 1 prerequisite; however, if any early epic stories write raw user identity into audit rows instead of token references (due to schema being available but stories not enforcing it), FR44 pseudonymization will be incomplete for those rows. Epic 8 FR44 acceptance criteria must include: a backfill check that scans `audit_events` for any `actor_id` values not routed through `user_identity_token`, and flags or migrates them before sign-off.
> 🔴 **AC-E8a — FR40/FR78 tamper-evident integrity mechanism (BLOCKER):** "Tamper-evident with row-level integrity" must specify the cryptographic mechanism before stories are written. Chosen approach: each audit row includes an HMAC of its content keyed by a per-org audit signing key stored in the vault's key management layer. FR78 integrity verification re-computes and compares HMACs for a given time range. Story must include the HMAC field schema and the verification API/UI. Alternative approaches (Merkle, DB triggers) are out of scope for v1.
> 📋 **AC-E8b — FR43 forwarding targets in scope for v1:** External audit log forwarding supports: (a) webhook (HTTP POST, configurable URL + secret header), and (b) S3-compatible object storage (AWS S3, Minio). Syslog and Splunk are v2. "Write-once" enforcement for S3 is the operator's responsibility (object lock configuration); the vault documents this requirement but does not configure it.
> 📋 **AC-E8c — FR69 point-in-time report format:** Reports are generated as CSV (machine-readable) and displayed in the UI as a paginated table. PDF export is v2. Report columns: `timestamp`, `actor_display_name`, `event_type`, `resource_id`, `resource_type`, `org_id`, `project_id`, `ip_address`.
> 📋 **AC-E8d — FR44 repeated pseudonymization:** A user whose `user_identity_token` has already been pseudonymized (display name replaced with alias) can be re-pseudonymized (alias replaced with a new alias) without error. The token reference in `audit_events` rows is immutable; only the display name in `user_identity_token` changes. Story must confirm idempotent behavior.

#### Story 8.1: Tamper-Evident Audit Log with HMAC Integrity

*Covers: FR40, FR78*

**As an** organization administrator and compliance officer,
**I want** every vault action recorded in a tamper-evident append-only audit log with row-level HMAC integrity verification,
**So that** I can prove to auditors that the log has not been altered since it was written.

**Acceptance Criteria:**

**Given** the vault is running and the audit signing key has been derived (Story 1.5 — separate HKDF key with `info: "project-vault-audit-log-v1"`),
**When** any auditable action occurs (credential access, rotation event, permission change, admin action),
**Then** an `audit_events` row is written in the same transaction as the action: `id` (uuid), `orgId`, `projectId` (nullable), `actorTokenId` (FK → `user_identity_tokens` — never raw user identity, PJ6), `actorType` (`human`|`machine_user`|`system`), `eventType` (string), `resourceId` (nullable), `resourceType` (nullable), `ipAddress`, `userAgent`, `payload` (JSONB — no credential values), `keyVersion` (audit signing key version), `hmac` (hex string).

**And** the `hmac` field is computed as `HMAC-SHA256(auditSigningKey, canonicalJSON({ id, orgId, actorTokenId, eventType, resourceId, payload, timestamp }))` before the row is inserted; the canonical JSON must use sorted keys and no whitespace to ensure determinism.

**And** audit writes use the same-transaction invariant: if the audit write fails, the triggering operation fails — 100% capture is an architectural invariant (NFR-REL5). This is enforced by the `SecureRoute` constructor writing audit events within the Drizzle transaction wrapper.

**And** `GET /api/v1/org/audit/verify?from=<ISO>&to=<ISO>` re-computes HMACs for all rows in the range and returns: `{ rowsChecked, passed, failed: [{ id, eventType, timestamp }], verifiedAt }` — failed rows indicate tampering or key rotation without re-signing (FR78); the current audit signing key version must match the row's `keyVersion` for verification to pass.

**And** the integrity verification endpoint is accessible to `owner` role only; the response is designed to be comprehensible to a non-cryptographer: `{ summary: "All 1,247 records verified — no tampering detected", passed: 1247, failed: 0 }` (UX-DR13).

**And** the `check-rls-coverage.ts` CI guard (Story 1.4) must also verify that `audit_events` has an RLS policy and that the policy correctly scopes to `org_id`.

**And** a backfill check queries `audit_events` for any `actor_token_id` values that are raw UUIDs not present in `user_identity_tokens` and reports them (PJ6 guard — AC-E8 backfill requirement).

**And** integration tests cover: audit event written in same transaction (action fails if audit write fails), HMAC computation determinism (same input → same HMAC), verification pass (all clean rows), verification fail (tampered row detected), key version mismatch detection.

---

#### Story 8.2: Audit Log Search, Export & External Forwarding

*Covers: FR41, FR42, FR43, FR70*

**As a** compliance officer conducting an audit,
**I want** to search, filter, and export audit log data with mandatory integrity verification, and forward logs to external write-once storage,
**So that** I can produce a verifiable compliance record that travels with integrity proof.

**Acceptance Criteria:**

**Given** audit events exist across all epics (written since Epic 1),
**When** a user with `owner` role calls `GET /api/v1/org/audit/events?actorId=&eventType=&resourceId=&projectId=&from=&to=&page=&limit=`,
**Then** paginated results are returned filtered by all provided dimensions simultaneously; required indexes `(actor_id, timestamp)`, `(project_id, timestamp)`, `(event_type, timestamp)`, `(resource_id, timestamp)` are in place and the query planner uses them (verified by `EXPLAIN ANALYZE` in a test at 1M entries per NFR-PERF6).

**And** results from Epics 2–7 events (written before this epic's UI) are queryable without re-ingestion (PJ5).

**And** `POST /api/v1/org/audit/export` with `{ from, to, format: "csv", includeIntegrityReport: true }` triggers an async export job (pg-boss); returns `{ jobId }` immediately.

**And** the export job: (1) runs integrity verification first (Story 8.1), (2) if verification passes, generates a CSV with columns per AC-E8c (`timestamp`, `actor_display_name`, `event_type`, `resource_id`, `resource_type`, `org_id`, `project_id`, `ip_address`), (3) appends an integrity summary row, (4) stores the CSV in a `audit_exports` table; `GET /api/v1/org/audit/exports/:jobId` returns status and download URL when complete.

**And** integrity verification is mandatory — export cannot proceed if verification fails; the export file includes the verification result header (UX-DR13).

**And** `PUT /api/v1/org/audit/forwarding` (admin only) configures external forwarding: `{ type: "webhook" | "s3", config: { url?, secretHeader?, bucket?, prefix?, region?, accessKeyId?, secretAccessKey? } }`; webhook forwards each new `audit_events` row as a JSON POST within 60 seconds of insertion; S3 forwards daily batch exports as gzipped JSONL files; "write-once" S3 object lock is the operator's responsibility (AC-E8b).

**And** `PUT /api/v1/org/audit/retention` (admin only) sets `retentionDays` (within subscription tier limits); a daily pg-boss job prunes rows older than the retention window (FR70).

**And** integration tests cover: 5-dimension filter query, mandatory integrity check before export, CSV format with integrity header, webhook forwarding (mock webhook receiver), S3 forwarding (mock S3), retention pruning.

---

#### Story 8.3: Access Reports, Dormant Users & Audit PII Management

*Covers: FR44, FR69, FR71, FR102*

**As an** organization administrator,
**I want** point-in-time access reports, dormant account detection, and compliant pseudonymization of departed users' audit trail identities,
**So that** I can demonstrate access governance and protect privacy without losing the integrity of historical records.

**Acceptance Criteria:**

**Given** the audit log has accumulated events across all epics,
**When** an admin calls `POST /api/v1/org/audit/access-report` with `{ asOf: ISO_datetime }`,
**Then** a point-in-time report is generated showing all users, roles, and project memberships as they existed at `asOf`: `{ users: [{ userId, displayName, orgRole, projects: [{ projectId, role, grantedAt }] }], generatedAt, asOf }`; formatted as CSV per AC-E8c and displayed as a paginated UI table (FR69).

**And** a pg-boss daily job checks `organization_members.last_active_at`; users inactive for ≥ 90 days (configurable `DORMANT_USER_THRESHOLD_DAYS`) trigger `user.dormant` alerts to org owners (FR71); admins can dismiss (with reason) or deactivate the account; dismissal is recorded in the audit log.

**And** `POST /api/v1/org/users/:userId/pseudonymize` (owner only) replaces the user's `user_identity_tokens.display_name` with an anonymized alias (`user_<random_8_chars>`); the `pseudonymized_at` timestamp is set; all `audit_events` rows continue to reference the same `actor_token_id` — their HMAC integrity is preserved because the `user_identity_token` table is separate (PJ6 design); re-pseudonymization is idempotent (AC-E8d).

**And** the backfill check from Story 8.1 runs as part of this story's completion: any `audit_events` rows with raw `actor_id` values not routed through `user_identity_tokens` are identified, flagged in a report, and must be resolved before Story 8.3 is signed off.

**And** account recovery and deactivation events (Story 4.3) appear in the audit log as privileged events and are queryable via the standard audit search (FR102).

**And** integration tests cover: access report at historical timestamp, dormant detection and alert, pseudonymization (display name changes, HMAC intact on existing rows), idempotent re-pseudonymization, backfill check (clean and dirty cases).

---

#### Story 8.4: Data Subject Erasure Request Handling

**As an** organization administrator responding to a GDPR right-to-erasure request,
**I want** a governed procedure for identifying all PII held for a user and producing a verifiable erasure record,
**So that** we can demonstrate compliance with data subject erasure obligations without compromising audit log integrity.

**Acceptance Criteria:**

**Given** an org admin is authenticated,
**When** they call `POST /api/v1/org/users/:userId/erasure-request` with `{ reason, requestedBy }`,
**Then** the system generates a `data_erasure_requests` record: `id`, `userId`, `orgId`, `requestedBy`, `reason`, `status` (pending → in_progress → completed), `createdAt`, `completedAt`; a PII inventory is computed: `{ tables: [{ table, rowCount, piiFields: [...] }] }` covering every table with PII for this user — returned in the response so the admin can review scope before proceeding.

**And** `POST /api/v1/org/users/:userId/erasure-request/:requestId/execute` with `{ confirm: true }` executes the erasure in a single atomic transaction:
1. The user's `user_identity_tokens.display_name` is pseudonymized (Story 8.3 mechanism)
2. The user's email in `users` is replaced with `erased_<hash>@erased.invalid`
3. The user's `password_hash` is overwritten with a fixed sentinel value
4. The user's TOTP secret and MFA recovery codes are deleted
5. All active sessions are revoked (FR84 path)
6. The `data_erasure_requests` record is marked `completed` with `completedAt`
7. The erasure execution is written as a `user.erasure_executed` privileged audit event — this audit record itself is NOT erased (audit integrity preserved)

**And** what is explicitly NOT erased: `audit_events` rows (they reference `user_identity_token` ID, not PII directly — pseudonymization handles them); rotation history; project membership records (org_id/project_id foreign keys are retained for referential integrity — display identity is pseudonymized).

**And** `GET /api/v1/org/users/:userId/erasure-request/:requestId/report` returns a machine-readable erasure completion report: `{ requestId, executedAt, piiRemoved: [...], piiRetained: [...], retentionJustification: "audit log integrity", auditEventId }` — this report is the compliance artifact for regulators.

**And** a user with a pending or completed erasure request cannot be re-invited to any project in the org; attempts return `410 { code: "user_erased" }`.

**And** integration tests cover: PII inventory generation (all tables counted), erasure execution (each field verified), audit event preserved post-erasure, re-invite blocked, compliance report format.

---

### Epic 9: Platform Operations, API & Self-Hosting
**⚪ v1 GA — Post-beta**
> ℹ️ API parity verification (FR47) is only meaningful once feature epics 1-8 are settled. Backup/restore (FR88-FR92) and in-place upgrades (FR50) are production hardening features. Multi-org (FR6) is an operator deployment feature required for GA self-hosting but not for beta validation.
The platform exposes a verified complete versioned REST API with finalized OpenAPI spec and pagination/filtering hardening across all endpoints; supports encrypted backup/restore with restore validation; in-place version upgrades; multi-org configuration for multi-tenant deployments; system settings; resource usage monitoring; master key custody risk alerting; and a separate immutable platform operator audit log.

**FRs covered:** FR6, FR47, FR48, FR50, FR86, FR87, FR88, FR89, FR90, FR92, FR97, FR103, FR109
> ⚠️ FR47 (REST API parity): API endpoints are built alongside their feature epics (1-8). This epic performs completeness verification, finalizes the OpenAPI spec, and hardens pagination/filtering — not first-time endpoint creation.
> ⚠️ FR92 (backup restore validation): restore validation can only be verified as fully correct after all table schemas from Epics 1-8 are stable. A post-Epic-8 schema freeze is a precondition for signing off FR92.
> ⚠️ **PJ9 — Cross-log search:** FR103 (platform operator audit log) is a separate immutable log from FR40 (main audit log). Admins querying for a complete picture of an incident must know which log to consult. FR103 acceptance criteria must include: (a) clear UI labeling distinguishing the two logs, and (b) documentation of which event types appear in which log. A unified cross-log search is explicitly descoped to v2; this boundary must be documented.
> 🔴 **AC-E9a — FR47 parity verification mechanism (BLOCKER):** API parity verification must be automated, not manual. Story must deliver a contract test suite that: (a) enumerates all routes from the OpenAPI spec, (b) verifies each route has an implemented handler returning the documented response schema, (c) runs in CI as a required check. Manual checklist parity is not acceptable for sign-off.
> 🔴 **AC-E9b — FR50 in-place upgrade scope (BLOCKER):** "In-place version upgrades" scope must be defined before story writing. v1 scope: binary/container replacement upgrades where database schema migrations are additive only (no column drops, no renames). Breaking schema migrations require a documented offline migration path. Story must include a migration compatibility matrix check in the upgrade process.
> 📋 **AC-E9c — FR6 org provisioning mechanism:** New org creation is performed via the admin UI by a platform operator (admin account). There is no self-service org signup in v1. API-based org creation (for scripted multi-tenant provisioning) is also supported via the platform operator API. Direct database access is not required for any supported provisioning flow.
> 📋 **AC-E9d — FR109 key custody risk trigger:** Master key custody risk alert fires when: (a) only one user holds the master key recovery share (single point of failure), OR (b) the master key has not been rotated in 365 days (configurable). Alert is sent to all org owners and the platform operator audit log. Story must include both trigger conditions and the configurable rotation threshold.

#### Story 9.1: Encrypted Backup & Restore

*Covers: FR88, FR89, FR90, FR92*

**As a** platform operator,
**I want** the vault to create encrypted backups on a schedule and restore from them reliably,
**So that** I can recover from data loss within the 2-hour RTO and 24-hour RPO targets.

**Acceptance Criteria:**

**Given** the vault is initialized and unsealed,
**When** the pg-boss scheduled backup job runs (default: daily at 03:00 UTC, configurable via `BACKUP_SCHEDULE` cron env var),
**Then** the job performs a PostgreSQL `pg_dump` of all tables, compresses the output (gzip), encrypts the result with AES-256-GCM using a backup key derived from the master key via HKDF (distinct `info: "project-vault-backup-v1"`), and stores the encrypted file at the configured destination (`BACKUP_STORAGE_PATH` for local filesystem or `BACKUP_S3_BUCKET` for S3-compatible).

**And** each backup file is named `backup_<timestamp>_<orgId>.vault` and accompanied by a metadata sidecar `backup_<timestamp>_<orgId>.meta.json` containing: `{ vaultVersion, timestamp, keyVersion, tables: [...], rowCounts: {...}, checksumSHA256 }`; the checksum covers the encrypted backup file.

**And** `POST /api/v1/admin/backup/trigger` (platform operator only) triggers an immediate backup outside the schedule; returns `{ jobId }`.

**And** `GET /api/v1/admin/backups` lists available backups with metadata: `[{ filename, timestamp, sizeBytes, keyVersion, verified: bool }]`.

**And** `POST /api/v1/admin/backups/:filename/restore` (platform operator only) decrypts and restores the backup into the live database after an explicit confirmation step (`{ confirmRestore: true, reason }`); restore is a destructive operation — all current data is replaced; the vault is automatically sealed after restore and requires manual unseal.

**And** the restore validation procedure (`POST /api/v1/admin/backups/:filename/validate`) decrypts and verifies structural integrity in an isolated read-only context (no live data modified): returns `{ valid: bool, assetsPresent: { credentials, projects, users, auditEvents }, checksum: "match"|"mismatch" }` (FR92).

**And** backup retention: `BACKUP_RETENTION_COUNT` (default: 7) keeps the N most recent backups; older backups are deleted by a cleanup job; minimum retention is 1.

**And** backup health monitoring: if a backup has not succeeded within `BACKUP_MAX_AGE_HOURS` (default: 25 — slightly over 24h to account for timing drift), a `backup.missed` alert fires to FR100-configured recipients; a `backup.failed` alert fires on any job failure (FR92).

**And** integration tests cover: backup job creates encrypted file, metadata checksum matches, validation (clean and corrupted file), restore (data replaced, vault sealed after), retention pruning, missed backup alert.

---

#### Story 9.2: System Settings, Multi-Org & Resource Monitoring

*Covers: FR6, FR86, FR87, FR109*

**As a** platform operator managing a self-hosted deployment,
**I want** a system settings UI and API for SMTP/notification configuration, multi-organization provisioning, and resource usage visibility with key custody risk alerting,
**So that** I can operate the vault without direct database access.

**Acceptance Criteria:**

**Given** the platform operator account exists (bootstrapped at vault init),
**When** they call `GET /api/v1/admin/settings`,
**Then** they receive current system settings: `{ smtp: { host, port, user, from, configured: bool }, backup: { schedule, retentionCount, storageType }, notifications: { defaultSlackWebhook }, instancePolicy: { maxOrgs, maxUsersPerOrg, sessionIdleTimeoutMinutes } }` — sensitive values (SMTP password) are returned as `[configured]` not plaintext (FR86).

**And** `PUT /api/v1/admin/settings` updates any subset of settings; SMTP password is only updated when explicitly provided (not overwritten with `[configured]`).

**And** `POST /api/v1/admin/orgs` (platform operator) creates a new organization (FR6); no self-service org signup exists; API-based creation is also supported for scripted provisioning (AC-E9c).

**And** `GET /api/v1/admin/resource-usage` returns current usage against tier limits: `{ orgs: { current, limit }, usersPerOrg: [{ orgId, current, limit }], secretsPerProject: [...], auditLogEntries: { current, limit }, storageBytes: { current, limit }, auditLogStorage: { currentBytes, limitBytes, utilizationPct } }`; alerts fire at 80%, 90%, 95% of each limit (FR87).

**And** audit log storage capacity is monitored specifically: a pg-boss daily job queries `pg_total_relation_size('audit_events')` and `pg_total_relation_size('platform_audit_events')`; if utilization exceeds 80%, 90%, or 95% of `AUDIT_LOG_STORAGE_LIMIT_GB` (default: 50GB, configurable), tiered alerts fire to FR100-configured recipients; the alert at 95% also activates a documented maintenance mode: `audit_events` writes are temporarily suspended and replaced with a `WARN`-level structured log entry — the operator must either increase storage or export-and-prune before the vault resumes normal audit writes.

**And** the `GET /ready` endpoint reflects audit storage pressure: at ≥ 95% utilization, `{ status: "ready", warnings: ["audit_storage_critical"] }` is returned — allowing monitoring systems to detect the condition without a full outage.

**And** on startup and on a weekly pg-boss schedule, the vault evaluates master key custody: if (a) `vault_state.kms_type = 'file'` AND (b) backup is enabled, a persistent `admin_alerts` record is created with `alertType: "key_custody_risk"` and a direct link to KMS configuration; this alert is also reflected in `GET /ready` as `{ status: "ready", warnings: ["key_custody_risk"] }` (FR109, AC-E9d).

**And** the key custody alert also fires when the master key has not been rotated in 365 days (configurable `KEY_ROTATION_MAX_AGE_DAYS`).

**And** integration tests cover: settings read/update (password not overwritten), org creation, resource usage with threshold alerts, key custody alert on startup (file KMS + backup enabled), key custody alert on age threshold.

---

#### Story 9.3: In-Place Version Upgrades & API Parity Verification

*Covers: FR47, FR48, FR50, FR97*

**As a** platform operator upgrading a running vault deployment,
**I want** in-place version upgrades that preserve all data and a contract-tested OpenAPI spec covering every endpoint,
**So that** I can upgrade without downtime risk and API consumers have a reliable, tested contract.

**Acceptance Criteria:**

**Given** a running vault instance,
**When** the operator replaces the Docker image with a newer version and runs `docker compose up -d`,
**Then** the API container runs pending Drizzle migrations automatically on startup before serving any requests; migration errors abort startup and the container exits with a non-zero code.

**And** v1 scope for in-place upgrades: additive-only schema migrations (new columns with defaults, new tables, new indexes); no column drops or renames — these require a documented offline migration procedure per AC-E9b; the migration runner checks for destructive operations (DROP COLUMN, RENAME COLUMN) and refuses to apply them in auto-migrate mode, requiring explicit `--allow-destructive` flag.

**And** a `migration-compatibility-check.ts` CI script verifies all migrations in the `migrations/` directory are additive-only; any destructive migration causes CI to fail with a message explaining the required offline migration procedure.

**And** the `@fastify/swagger` plugin auto-generates the OpenAPI spec from all registered route schemas; `GET /api/v1/openapi.json` returns the complete v1 spec; `GET /api/v1/docs` serves the Swagger UI.

**And** a contract test suite (`packages/api-contract-tests/`) enumerates all routes from the generated OpenAPI spec, sends a request to each, and verifies the response matches the documented schema; this suite runs as a required CI check (AC-E9a blocker); manual parity checklist is not acceptable for sign-off.

**And** all collection endpoints support `page` (default: 1), `limit` (default: 20, max: 100), and relevant filter parameters; the contract test suite verifies pagination fields (`{ items, total, page, limit, hasNext }`) are present on all collection responses (FR97).

**And** integration tests cover: migration runs on startup, additive migration succeeds, destructive migration rejected without flag, OpenAPI spec accessible, contract test suite passes against a running instance.

---

#### Story 9.4: Platform Operator Audit Log

*Covers: FR103*

**As a** platform operator performing cross-org incident investigation,
**I want** my operator actions recorded in a separate immutable platform audit log that org admins cannot access or modify,
**So that** there is an independent verifiable record of all privileged operator actions separate from the per-org audit log.

**Acceptance Criteria:**

**Given** the platform operator account performs any privileged action (cross-org investigation, instance config change, user/org modification, backup/restore),
**When** the action is executed,
**Then** a `platform_audit_events` row is written in the same transaction: `id`, `operatorId`, `actionType`, `targetOrgId` (nullable), `targetUserId` (nullable), `payload` (JSONB — no credential values), `ipAddress`, `timestamp`, `hmac` (same HMAC-SHA256 mechanism as Story 8.1 but using a separate platform audit signing key derived via HKDF with `info: "project-vault-platform-audit-v1"`).

**And** `platform_audit_events` is a separate table with its own RLS policy: accessible only to the platform operator role — org admins querying `audit_events` never see platform events (PJ9).

**And** `GET /api/v1/platform/audit/events` (platform operator only) searches and filters platform events; the UI clearly labels this as "Platform Operator Audit Log" distinct from the per-org log (PJ9 — no unified cross-log search in v1; this boundary is documented in the UI tooltip and API response header `X-Log-Scope: platform`).

**And** platform audit write failures abort the operator action — the same write-failure invariant applies as FR40 (100% capture guarantee is architectural).

**And** an explicit operator-acknowledged maintenance mode exists (`POST /api/v1/platform/maintenance-mode` with `{ reason }`) that temporarily bypasses the write-failure invariant for emergency recovery; any actions taken during maintenance mode are recorded retroactively when the log becomes available; the maintenance mode activation itself is the first record written after recovery.

**And** platform audit log retention is independent of per-org retention policies; default: 365 days, configurable via `PLATFORM_AUDIT_RETENTION_DAYS`.

**And** `GET /api/v1/platform/audit/verify` performs the same HMAC verification as Story 8.1 but against `platform_audit_events`.

**And** integration tests cover: operator action written to platform log (not org log), org admin cannot access platform log (403), write failure aborts action, maintenance mode bypass + retroactive recording, independent retention.


---

#### Story 9.5: Operational Runbook & Deployment Guide

**As a** platform operator managing a self-hosted deployment,
**I want** a complete operational runbook covering all failure and maintenance scenarios,
**So that** I can recover the vault reliably without tribal knowledge or guesswork during an incident.

**Acceptance Criteria:**

**Given** Epics 1–9 are complete,
**When** the operator consults `docs/runbook.md`,
**Then** it covers the following procedures — each with step-by-step commands, expected outputs, and decision trees:

**Vault Lifecycle:**
- First-time deployment (`docker compose up`, vault init ceremony, first unseal)
- Normal startup and shutdown sequences
- Manual unseal after unexpected seal (`POST /api/v1/vault/unseal` with key file)
- What to do if the vault seals unexpectedly mid-operation (check `/ready`, identify reason, unseal procedure)

**Upgrades:**
- In-place version upgrade procedure (pull new image, `docker compose up -d`, verify migrations ran, verify `/ready`)
- How to identify if a migration is destructive (run `pnpm migration-compatibility-check`) and the offline migration path

**Backup & Recovery:**
- How to trigger a manual backup and verify it succeeded
- Restore procedure step-by-step (seal vault, restore, unseal, verify data integrity)
- Quarterly backup restore validation procedure (`POST /admin/backups/:filename/validate`)
- What to do when backup has been missed for > 24 hours (check job logs, trigger manual, investigate storage)

**Master Key Management:**
- How to rotate the master key (procedure documented; v1 scope: new key file + re-encrypt sentinel)
- What to do if the key file is lost (data is unrecoverable — prevention via KMS integration documented)
- How to configure KMS integration to replace file-based key custody

**Incident Response:**
- Vault unreachable: triage flowchart (sealed? DB down? OOM-killed?)
- Audit log storage at 95% capacity: export-and-prune procedure
- Break-glass rotation post-incident sweep checklist
- Compromised machine user API key: emergency revoke procedure (Story 7.2)

**Monitoring:**
- How to scrape Prometheus metrics and what each metric means
- Key alert types and their recommended response actions
- How to verify audit log integrity (`GET /audit/verify`)

**And** `docs/runbook.md` is linked from the root `README.md` under "Operations".

**And** the runbook includes a "Quarterly Operations Checklist" section with: backup restore validation, audit log integrity check, dormant user review, key custody review, CVE scan review, `.trivyignore` expiry audit.

**And** this story has no integration tests — it is a documentation deliverable; acceptance is verified by a documentation review where a team member who was not the author successfully completes the "first-time deployment" and "manual unseal" procedures against a clean environment without asking questions.

---

### Epic 14: Extension Architecture & Pluggable Authentication
**🟠 Phase 2 — Recommended build order: first of the four Phase 2 epics**

Self-hosters can extend the platform via a documented, versioned Extension API; enterprise and hosted-SaaS users can log in via their organization's SSO provider instead of a local password, while local auth always remains available as fallback. This epic is the business-critical path for Phase 2 — the founder's hosted SaaS model depends on the Extension API and the AGPLv3 licensing boundary it's paired with, which is why it's sequenced before Epic 13 despite the lower epic number. Story 0 (AGPLv3 relicense + CLA) blocks the rest of this epic — the public-facing Extension API must not ship under a to-be-decided license.

Third-party community extensions (FR116) are explicitly out of scope — this epic's loader accepts only the founder's exact, pinned private package identity; there is no general install pathway, no permission-scope approval UI, and no sandboxing. Journey 7 (Jordan) in prd.md depicts that future state and must not be used as a source of acceptance criteria for this epic's stories.

**FRs covered:** FR113, FR114, FR115 (amended), FR116 (deferred — tracked for completeness, not built here)
> ⚠️ **Story 0 (AGPLv3 + CLA) is a prerequisite for this epic, not a feature story** — no FR maps to it; it exists because this project tracks work at the epic level and this is where the licensing work is most urgently needed.
> ⚠️ **Security-critical, not optional hardening:** CSRF/state-parameter validation on the SSO callback, the `external_identities` identity-binding table (no auto-link-by-email), and the fixed `POST /api/v1/auth/sso/callback/:providerName` route shape are all part of FR115's acceptance criteria, not follow-up work — see architecture.md Authentication & Security for the full design, added after a security review found the original hook design had no identity-validation mechanism at all.
> ⚠️ **Dependency note:** `authStrategies` list and `registerAuthStrategy()` land in `apps/api/src/modules/auth/strategies.ts` — this epic does not touch `modules/credentials/` (Epic 13) at all; the two epics share no backend module.

#### Story 14.0: Establish AGPLv3 License and Contributor Agreement

**As a** project maintainer preparing to build a commercial extension on top of the open-source core,
**I want** the repository relicensed to AGPLv3 with a Contributor License Agreement process for external contributions,
**So that** the open-source core can remain freely self-hostable while legally enabling a closed-source SaaS extension and deterring uncompensated competing hosted forks.

**Acceptance Criteria:**

**Given** the relicensing work is complete,
**When** the repository root is inspected,
**Then** a `LICENSE` file containing the full AGPLv3 text is present.

**And** `CONTRIBUTING.md` documents that external contributions require signing a CLA before merge, and explicitly discloses that contributions may be used in a closed-source commercial SaaS extension maintained by the project owner — the CLA text itself must carry this disclosure, not just internal documentation (per prd.md's Licensing & Contribution Model: transparency here is a stated requirement, not optional).

**And** a CLA-assistant bot (or equivalent, e.g. a `cla-assistant` GitHub Action) is configured to block PR merges from unsigned contributors.

**Given** a new external contributor opens their first PR,
**When** the CLA-assistant check runs,
**Then** the PR is blocked from merge until the contributor signs the CLA via the automated flow.

**And** existing PR templates reference the CLA requirement.

**And** this story has no automated tests — acceptance is verified by a maintainer confirming the `LICENSE` file, `CONTRIBUTING.md`, and CLA bot are correctly configured, and a test PR from an unsigned account is actually blocked from merging.

---

#### Story 14.1: Define and Publish the Extension API Package

**As a** developer building an extension for Project Vault (starting with the founder's own private SaaS package),
**I want** a versioned, typed Extension API package with capability negotiation,
**So that** my extension registers hooks against a stable contract and gets a clear failure instead of silent breakage when core's extension surface changes.

**Acceptance Criteria:**

**Given** the monorepo workspace,
**When** `packages/extension-api` is created,
**Then** it exports `defineExtension()`, `registerExtension(manifest: ExtensionManifest, hooksFactory: () => ExtensionHooks)`, and an `EXTENSION_API_VERSION` semver constant.

**And** it exports typed hook interfaces `AuthStrategy`, `NotificationChannel`, `UIPanel` from `hooks/`, all re-exported from the package root — an extension author's only import path is `@project-vault/extension-api`, never a `hooks/` subpath directly.

**And** every hook interface method (`onAuthenticate`, `onNotify`, `onRenderPanel`) is typed as returning `Promise<T>` — a hook method typed to return a non-Promise value fails TypeScript compilation.

**Given** an extension manifest declaring `apiVersion: "^1.2.0"` and core's `EXTENSION_API_VERSION` is `"1.3.0"`,
**When** `registerExtension(manifest, hooksFactory)` is called,
**Then** `semver.satisfies(EXTENSION_API_VERSION, manifest.apiVersion)` passes, `hooksFactory()` is invoked, and its returned hooks are accepted.

**Given** an extension manifest declaring `apiVersion: "^2.0.0"` against the same core version,
**When** `registerExtension()` is called,
**Then** the semver check fails, `registerExtension()` throws synchronously, and **`hooksFactory` is never invoked** — zero extension code executes.

**Given** a manifest's `name` field,
**When** validated at registration,
**Then** it must match `/^[a-z0-9]+(\.[a-z0-9-]+)+$/` (reverse-DNS style) or registration is rejected.

**Given** the CI pipeline,
**When** any file under `packages/extension-api/src/**` changes without a corresponding `package.json` version bump in the same commit,
**Then** CI fails with an explicit error naming the version-skew guard.

---

#### Story 14.2: Load a Configured Extension at Startup, Fail-Safe

**As a** self-hosted administrator,
**I want** the vault to load my configured extension package at startup without risking an outage if it's misconfigured,
**So that** a bad extension config never takes down my vault.

**Acceptance Criteria:**

**Given** `VAULT_EXTENSIONS_PACKAGE` is unset,
**When** the API starts,
**Then** zero extension code loads, `GET /health` reports no active extension, and all core functionality is identical to a build with no extension system at all.

**Given** `VAULT_EXTENSIONS_PACKAGE` is set to a valid, resolvable package name,
**When** the API starts,
**Then** `apps/api/src/extensions/loader.ts` dynamically imports it via native ESM `import()`, validates the manifest (name pattern + capability negotiation per Story 14.1) **before** `hooksFactory()` is invoked, wires the returned hooks in on success, writes an `AuditEvent.EXTENSION_LOADED` entry with `manifest.name`, `manifest.apiVersion`, `manifest.capabilities`, and `GET /api/v1/admin/extensions/status` (OrgAdmin only) returns the loaded manifest.

**And** this story is testable with a minimal stub hook (e.g. a no-op `NotificationChannel` implementation) — it does not require Story 14.3's auth-strategy machinery to exist first; "wires hooks in" means generic hook-type dispatch, not auth-specific behavior.

**Given** `VAULT_EXTENSIONS_PACKAGE` is set to a package that fails to import, fails manifest validation, or fails capability negotiation,
**When** the API starts,
**Then** the failure is caught at the loader call site, logged at fatal-equivalent severity with a **fixed-enum reason** (`import_error` | `manifest_invalid` | `capability_mismatch`) — never the raw exception message or stack trace — an `AuditEvent.EXTENSION_LOAD_FAILED` entry is written with that reason, `GET /health` reports `extensions_status: "load_failed"`, and **the API process still starts and serves all core functionality.**

**Given** no extension is loaded,
**When** `GET /api/v1/admin/extensions/status` is called by an OrgAdmin,
**Then** it returns `null`.

**And** a non-OrgAdmin calling this endpoint receives `403`.

---

#### Story 14.3: Authenticate via a Registered External Provider Strategy

**As an** enterprise user whose organization uses SSO,
**I want** to log in to Project Vault through my organization's identity provider,
**So that** I don't need a separate password and my company's existing SSO/MFA policy applies.

**Acceptance Criteria:**

**Given** the API boots,
**When** the local email/password + MFA strategy registers (before any extension bootstrap runs),
**Then** it occupies index 0 of `authStrategies` and remains registered regardless of what any extension does.

**Given** an extension calls `registerAuthStrategy(strategy)` during its `hooksFactory`-provided registration,
**When** registration completes,
**Then** the strategy is appended to `authStrategies` — append-only at boot, no runtime add/remove.

**Given** a user initiates SSO login,
**When** the server responds,
**Then** it generates a cryptographically random `state` value and stores it server-side, keyed to a short-TTL (10 min), single-use, `httpOnly; Secure; SameSite=Lax` cookie — never a bare query parameter.

**Given** the IdP redirects back to `POST /api/v1/auth/sso/callback/:providerName`,
**When** the callback is received,
**Then** the `state`/`RelayState` is validated against the stored value **before** `onAuthenticate()` is invoked; a missing, mismatched, expired, or already-consumed `state` is rejected with a generic auth error and `onAuthenticate()` is never called.

**Given** a valid callback with a matched `state`,
**When** the registered strategy's `onAuthenticate()` returns `{ externalSubject, providerName, email?, displayName? }`,
**Then** the system looks up `external_identities` by `(org_id, providerName, externalSubject)`.

**Given** a matching `external_identities` row exists,
**When** the lookup succeeds,
**Then** `issueSession()` is called for that row's `user_id` — identical session/JWT lifecycle to local login — and if that user is OrgAdmin/Owner without MFA enrolled, the identical `403 MFA_ENROLLMENT_REQUIRED` check applies exactly as it would for local login.

**Given** the `external_identities` lookup succeeds but `issueSession()` itself then fails (e.g. a transient DB error),
**When** this happens after the single-use `state` cookie has already been consumed,
**Then** the user sees a clear "login failed, please try again" error and can immediately restart the SSO flow (a fresh `state` is generated) — the consumed `state` from the failed attempt is never required again, so the user is never stuck unable to retry.

**Given** no matching `external_identities` row exists (first-time external login),
**When** the lookup misses,
**Then** **no session is issued and no user is auto-provisioned** — the user is shown a "link your account" step requiring either a pending invitation for that email or an explicit OrgAdmin-initiated linking action, and the system never creates an `external_identities` row solely because `AuthResult.email` matches an existing `users.email`.

**Given** the one registered external strategy's `onAuthenticate()` throws or rejects — note: this phase's loader is origin-locked to a single extension (Story 14.2), so at most one external strategy can ever be registered alongside local; this AC is scoped to that reality, not a multi-strategy fallback scenario,
**When** the dispatch layer in `strategies.ts` invokes it,
**Then** the error is caught, logged via `pino.error`, and local login remains fully reachable regardless of the external strategy's failure state — the user sees a clear error for the SSO attempt specifically, not a broken login page.

**And** this story requires an integration test asserting that a forged `AuthResult` for an arbitrary `externalSubject` with no corresponding `external_identities` row is rejected, not silently accepted — this is the test that guards the identity-binding gap this story exists to close.

---

#### Story 14.4: Route Login to SSO by Email Domain

**As a** user at a company that uses SSO,
**I want** the login screen to automatically offer SSO once I enter my work email,
**So that** I don't have to know in advance whether my org uses SSO or hunt for a separate button.

**Acceptance Criteria:**

**Given** an org has registered an SSO strategy and configured an `org_sso_domains` entry mapping `"acme.com"` to that strategy,
**When** a user on the login screen enters an email ending in `@acme.com`,
**Then** the client looks up the domain via the server and is redirected into that org's SSO flow (per Story 14.3) — no password field is shown.

**Given** a user enters an email whose domain has no `org_sso_domains` mapping,
**When** the lookup completes,
**Then** the password field renders and local login proceeds normally.

**Given** the `org_sso_domains` lookup itself fails (e.g. a transient DB error),
**When** this happens during login,
**Then** the login screen fails open to the password field — same fail-safe philosophy as the extension loader (Story 14.2) — never a hung or broken login screen.

**Given** an org has no SSO extension registered at all,
**When** any user logs in,
**Then** the login screen never attempts an SSO domain lookup — only local email/password is shown, matching the "core never special-cases the extension" invariant: with zero extensions installed, this code path behaves exactly as it does today.

---

### Epic 13: Structured Multi-Field Secrets
**🟠 Phase 2**

Users can store real-world credentials that need more than one field (username+password, database connection strings) using built-in templates, with per-field masking and field-scoped rotation — instead of splitting them across multiple awkwardly-named single-value secrets. Fully self-contained within existing credential management; independent of Epic 14, 15, and 16.

**FRs covered:** FR10 (amended), FR111, FR112, FR12 (amended), FR96 (amended), FR18 (amended)
> ⚠️ **Data model prerequisites, not optional:** `credential_versions.schema_version` (the format discriminator), the `credentials.current_version_id` backfill migration for pre-existing credentials, field-key uniqueness enforcement, and `credential_dependencies.field_key` (for field-scoped rotation checklist filtering) are all part of this epic's acceptance criteria — added after an architecture review found the original design had gaps in exactly these spots. See architecture.md Data Architecture for the full design.
> ⚠️ **Backward compatibility is mandatory, not best-effort:** every pre-existing single-value secret must continue to work with zero migration of its stored ciphertext — only new writes use the field-set format. Any story that touches the read/write path for `credential_versions` must include an explicit test against a legacy (`schema_version = 1`) row.

#### Story 13.1: Backfill `current_version_id` for Existing Credentials

**As a** platform operator upgrading to a version of Project Vault that ships multi-field secrets,
**I want** every existing credential's `current_version_id` backfilled automatically during the upgrade,
**So that** no credential is left with an undefined "current version" after the upgrade completes.

**Acceptance Criteria:**

**Given** a Postgres database with existing `credentials` rows created before this migration,
**When** the Phase 2 migration runs,
**Then** `credentials.current_version_id` is set for every row to the `id` of its latest `credential_versions` row by `created_at`.

**Given** a credential with multiple existing versions,
**When** the backfill runs,
**Then** `current_version_id` points to the most recently created version, not the first.

**And** the migration must complete before the application version that assumes non-null `current_version_id` deploys — documented as an explicit deployment-ordering requirement in the migration's own header comment and the upgrade runbook.

**Given** existing `credential_versions` rows,
**When** the migration runs,
**Then** their `schema_version` column defaults to `1` (legacy bare-string format) and `field_meta` remains `NULL` — no re-encryption, no ciphertext touched.

**Given** a `credentials` row with zero `credential_versions` rows (orphaned/corrupted state),
**When** the backfill runs,
**Then** it skips that row, logs it explicitly, and surfaces it in the migration's summary output rather than crashing the migration or silently leaving `current_version_id` in an undefined state.

**And** this story requires an integration test verifying: (a) a credential with 5 versions backfills to the version with the max `created_at`, (b) a credential with exactly 1 version backfills correctly, (c) the migration is idempotent — running it twice produces the same result, (d) a credential with zero versions is skipped and logged, not crashed on.

---

#### Story 13.2: Store and Edit a Secret with Multiple Named Fields via Templates

**As a** user managing a credential that has more than one meaningful piece of information (e.g. a database login),
**I want** to create a secret using a template that defines its fields, and add/rename/remove fields freely,
**So that** I can store a Login, Database Connection, API Key, or custom credential as one coherent record instead of splitting it across several oddly-named single-value secrets.

**Acceptance Criteria:**

**Given** a user creating a new secret,
**When** they select the Login template,
**Then** the create form pre-populates fields for username and password (masked by default per Story 13.3).

**And** the Database Connection, API Key, Secure Note, and Custom templates each pre-populate their own appropriate field set when selected (Custom starts empty).

**Given** a user editing a secret's field set,
**When** they add, rename, or remove a field,
**Then** the change is validated against field-key uniqueness (case-insensitive) within that secret — a rename colliding with an existing field key on the same secret is rejected with `409`, never silently overwritten.

**Given** any field value is created, edited, or removed,
**When** the change is saved,
**Then** a new `credential_versions` row is written with `schema_version = 2`, the full field-set JSON as `fields` (encrypted as one envelope), and `field_meta` populated with the current field keys/sensitivity/template — the previous version is retained, immutable, per FR12's "any field change creates a new version of the whole secret" — and `credentials.current_version_id` flips to the new version's `id` atomically in the same transaction.

**Given** a secret created without selecting a template,
**When** saved,
**Then** it has exactly one default field, preserving pre-existing single-value creation behavior.

**Given** the `.env`/JSON bulk import flow (FR17, pre-existing),
**When** credentials are imported,
**Then** each imported key/value pair creates a single-field secret — bulk import does not group related keys into a multi-field secret. This is a regression guard confirming existing import behavior is unchanged, not new behavior for this story to build.

**Given** a pre-existing secret with `schema_version = 1` (legacy, single value),
**When** a user views or edits it,
**Then** it renders as a single unnamed field in the UI, identical to its pre-Phase-2 appearance, and editing it for the first time transitions it to `schema_version = 2` on save.

**And** editing a `sensitive: true` field's value (e.g. setting a new password) is a blind overwrite — it does **not** require revealing the field's current value first. This is independent of Story 13.3's reveal capability; edit and reveal are separate actions.

---

#### Story 13.3: Control Field Visibility and Reveal Sensitive Fields

**As a** user viewing a multi-field secret,
**I want** each field to have its own masking behavior, and to reveal only the field I need,
**So that** I don't expose more sensitive data than necessary and can quickly reference non-sensitive fields like a username without an extra step.

**Acceptance Criteria:**

**Given** a secret's `field_meta`,
**When** the credential list or detail view renders,
**Then** it reads `field_meta` only — never calling `withSecret()` — to determine which field keys exist and whether each is sensitive.

**Given** a field marked `sensitive: false` (e.g. username),
**When** the detail view renders,
**Then** its value is visible without a reveal action (still gated by normal access control, just not an extra UI step).

**Given** a field marked `sensitive: true` (e.g. password),
**When** the detail view renders,
**Then** the value is masked and requires an explicit reveal action.

**Given** a user reveals a specific field,
**When** the reveal request is made,
**Then** `GET .../credentials/{id}/value?field={key}` is called, returning only that field's value, and an `AuditEvent.CREDENTIAL_VALUE_REVEALED` entry is written with `revealed_fields: [key]` — recording exactly which field was revealed, not just that "the secret" was accessed.

**Given** a user reveals a secret without specifying `?field=`,
**When** the request completes,
**Then** all non-masked-by-default fields are returned in one response, `revealed_fields` lists every sensitive field actually included, and masked fields not explicitly requested are **omitted from the response body entirely** — never sent as `null` or a placeholder.

**Given** a legacy (`schema_version = 1`) secret,
**When** revealed,
**Then** it behaves exactly as today — single value returned, single audit entry — no behavior change.

**Given** a reveal request with `?field=` naming a key that doesn't exist on that secret,
**When** the request is processed,
**Then** it returns `400` with a clear error, not a silent empty response or a `500`.

---

#### Story 13.4: Rotate Specific Fields of a Multi-Field Secret

**As a** user who needs to rotate just the password of a multi-field secret without touching its username,
**I want** to select which field(s) a rotation targets,
**So that** I don't have to treat an unrelated field as changed when only one credential component actually rotated.

**Acceptance Criteria:**

**Given** a user initiates a rotation on a multi-field secret,
**When** they reach the rotation initiation screen,
**Then** they can select one or more specific fields to rotate, or rotate the whole secret.

**Given** a rotation targeting specific field(s),
**When** initiated,
**Then** `rotations.target_fields` is set to the array of targeted field keys; a whole-secret rotation leaves `target_fields` `NULL`.

**Given** a rotation request naming a field key that no longer exists on the credential (e.g. renamed or removed since the rotation form was loaded),
**When** the initiation request is processed,
**Then** it is rejected with a specific validation error naming the missing field key — not silently accepted or applied to the wrong field.

**Given** `credential_dependencies` rows for the credential being rotated — some scoped to a specific `field_key`, some with `field_key NULL` (whole-credential),
**When** the rotation checklist is generated,
**Then** it includes only dependencies where `field_key IS NULL OR field_key = ANY(target_fields)` — dependencies scoped to fields not being rotated are excluded from this rotation's checklist.

**Given** the rotation completes (all checklist items confirmed),
**When** the completion transaction runs,
**Then** a new `credential_versions` row is written containing the updated field(s) and the previous values for all non-targeted fields unchanged — still one atomic full-field-set snapshot per FR12 — and `current_version_id` flips atomically in the same transaction as the existing rotation-completion compound transaction.

**Given** this rotation reuses the existing credential-level advisory lock,
**When** a second rotation attempt (whole-secret or another field subset) is made on the same credential while one is in progress,
**Then** it receives the existing explicit `409 ROTATION_IN_PROGRESS` response — never silent interleaving — regardless of whether the two rotations target overlapping or disjoint fields.

**Given** a legacy single-value secret,
**When** rotated,
**Then** rotation behaves exactly as it does today — `target_fields` remains `NULL`, no behavior change.

---

### Epic 15: Localization
**🟠 Phase 2**

Users can use the product in their preferred language. Independent of Epic 13, 14, and 16 — no shared backend module, no shared data model.

**FRs covered:** FR117, FR118, FR119
> ⚠️ **Scope boundary:** the supported locale set is build-time (adding a new language is a deploy); locale *selection* among already-supported locales is runtime. Don't conflate these in story acceptance criteria.
> ⚠️ User-generated content (credential names, project names, notes) is never translated — including when interpolated into translated notification templates. Audit log exports stay locale-invariant (ISO 8601, English) to preserve UX-DR13's auditor-comprehensibility requirement.

#### Story 15.1: Select and Use a Preferred Display Language

**As a** user,
**I want** to choose my preferred display language from the set of supported locales and have the interface render in that language,
**So that** I can use Project Vault comfortably in the language I think in.

**Acceptance Criteria:**

**Given** the set of supported locales compiled into the build,
**When** a user opens their language settings,
**Then** they see a list of all currently supported locales to choose from.

**Given** a user selects a locale from the supported set,
**When** the selection is saved,
**Then** the UI immediately renders in that language — no page reload required, no rebuild required (locale selection is a runtime operation).

**Given** a message key with no translation in the user's selected locale,
**When** the UI renders that string,
**Then** it falls back to English for that specific string, per-string — not an all-or-nothing switch to English for the whole page, not a blank string or raw translation key.

**Given** user-generated content — credential names, project names, notes,
**When** the UI renders alongside translated strings,
**Then** that content is never translated, even when interpolated into a translated notification template (e.g., "Credential 'grafana-admin' expires in 5 days" — the template text translates, `grafana-admin` never does).

**Given** an audit log export,
**When** generated, regardless of the user's UI locale,
**Then** dates are ISO 8601 and all text is English — audit exports are locale-invariant, protecting UX-DR13's auditor-comprehensibility requirement.

**And** adding a new supported locale to the codebase requires a deploy (build-time compilation via Paraglide) — explicitly a different mechanism than locale selection, not in this story's scope to change.

---

#### Story 15.2: Configure Organization Default Locale for New Users

**As an** Organization Admin,
**I want** to set a default display language for newly invited users,
**So that** new team members land in the right language from their first login without each person having to change it manually.

**Acceptance Criteria:**

**Given** an OrgAdmin sets a default locale for their organization,
**When** a new user is invited and accepts,
**Then** their initial locale preference is set to the org's configured default.

**Given** a user with an org-assigned default locale,
**When** they change their personal language setting afterward,
**Then** their individual preference overrides the org default going forward — the org default only seeds the initial value.

**Given** an org has not configured a default locale,
**When** a new user is invited,
**Then** their locale defaults to English, consistent with existing pre-Phase-2 behavior.

---

### Epic 16: Custom Theming
**🟠 Phase 2**

Administrators can brand a self-hosted instance with a custom theme without touching code. Independent of Epic 13, 14, and 15.

**FRs covered:** FR120, FR121
> ⚠️ **Security-critical, not optional hardening:** theme token values must be validated against a per-type CSS grammar before compiling into custom properties (prevents CSS injection via a hostile theme file), and theme asset URLs must be validated against the existing webhook SSRF blocklist at install/reload time — both are part of this epic's acceptance criteria, added after a security review flagged the original design as unaddressed on both points. See architecture.md Frontend Architecture (Theming).
> ⚠️ Reload must validate theme files independently (one malformed file doesn't block others) and report specific, actionable per-file failure reasons — not a generic error.

#### Story 16.1: Install and Compile a Custom Theme

**As a** self-hosted administrator,
**I want** to install a custom theme by placing a structured definition file in a designated directory and triggering a reload,
**So that** I can brand my instance without modifying application code or rebuilding the application.

**Acceptance Criteria:**

**Given** `VAULT_THEMES_DIR` (default `/data/themes`, inside the persistent Docker volume, not the application image),
**When** an admin places a structured (JSON/YAML) theme definition file there,
**Then** it is picked up on the next reload — automatic on container startup, or via `POST /api/v1/admin/themes/reload` (OrgAdmin only).

**Given** `VAULT_THEMES_DIR` is unset or the directory doesn't exist,
**When** the reload runs,
**Then** this is not an error — zero custom themes are available, base theme only, identical to the "absent = zero behavior change" pattern used by the extension loader.

**Given** the reload endpoint processes multiple theme files,
**When** one file is malformed — including a file that isn't valid JSON/YAML at all (wrong extension, binary garbage, truncated content), not just valid-syntax-wrong-schema,
**Then** validation is per-file — the malformed file fails independently and does not block the other valid files from loading. The response reports `{ loaded: string[], failed: { file: string, reason: string }[] }` with a specific, actionable `reason` (e.g. "token `primaryColor`: invalid color value", or "not valid JSON/YAML"), never a generic "validation failed."

**Given** a canonical theme token registry (`packages/shared/constants/theme-tokens.ts` or equivalent) defining every valid token key and its type (`color` | `length` | enum-with-declared-values),
**When** a theme file's token values are compiled into `[data-theme="name"]` CSS custom-property declarations,
**Then** each value is validated against its token's declared type from the registry — `color` tokens accept only a constrained color grammar (no `url()`, no `;`, no `}`), `length` tokens accept only numeric+unit patterns, enum tokens accept only their declared values — and any token key not present in the registry, or any value that doesn't match its type's grammar, fails validation (same fallback-to-base-theme behavior as a malformed file) rather than being raw-interpolated into CSS. This registry is a required deliverable of this story, not an assumed pre-existing artifact — without it, "per-type grammar" has nothing concrete to validate against.

**Given** a theme's asset references (fonts, images, logo),
**When** validated at install/reload time,
**Then** each URL is checked against the same SSRF blocklist already established for webhook URLs (RFC 1918 / localhost / link-local / cloud metadata endpoints) — a theme is admin-installed but still effectively untrusted input. Assets are fetched directly by the browser, not proxied server-side, so this is a one-time check at install/reload, not a per-request re-validation.

**Given** a theme fails validation for any reason (malformed structure, invalid token grammar, blocklisted asset URL),
**When** the reload processes it,
**Then** the system falls back to the base theme for anyone with that theme selected, rather than rendering a broken or unsafe UI.

**And** a successful reload writes an `AuditEvent.THEME_RELOADED` entry.

---

#### Story 16.2: Select an Active Theme

**As a** user,
**I want** to choose which installed theme is active for my view,
**So that** I see the branding my organization has configured, or the default if none is selected.

**Acceptance Criteria:**

**Given** the base theme and any successfully installed custom themes,
**When** a user opens theme selection,
**Then** they see all currently available themes to choose from.

**Given** a user selects a theme,
**When** the selection is saved,
**Then** the UI immediately applies the `[data-theme="name"]` CSS custom-property overrides — no rebuild, no restart.

**Given** a user has a custom theme selected,
**When** an admin removes that theme's file from `VAULT_THEMES_DIR` and reloads,
**Then** the user's next page load falls back to the base theme silently, plus a one-time, dismissible in-app notice ("your selected theme is no longer available, showing the default") — never a broken or unstyled UI, never a hard error blocking product access.
