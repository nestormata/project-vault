---
stepsCompleted: ["step-01-validate-prerequisites"]
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/architecture.md"
  - "_bmad-output/planning-artifacts/ux-design-specification.md"
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
- FR9: The system guides new users through creating their first project via an interactive wizard that walks through adding at least one real credential and contrasts project-centric vs. environment-centric organization
- FR62: Project Admins can remove a user from a specific project without affecting that user's organization account or membership in other projects
- FR63: Users can archive projects to remove them from active dashboard views while preserving all credentials, history, and audit records
- FR98: A newly created empty project displays a purposeful empty state showing categories of assets and offering direct path to first import or manual addition

**Secret & Credential Management**
- FR10: Users can store a secret with a name, value, description, tags, expiry date, and linked dependent systems within a project
- FR11: Users can retrieve the current version of any secret they are authorized to access
- FR12: The system maintains a complete immutable version history for every secret
- FR14: Users can search and filter credentials within a project by name, tag, status, and expiry
- FR15: Users can set expiry dates and rotation schedules on individual credentials
- FR16: Users can record which external systems and services depend on each credential
- FR17: Users can import credentials in bulk from `.env` files and JSON exports
- FR64: Users can view which human users and machine users currently have access to a specific credential, based on their project roles
- FR95: Users can add, edit, and remove tags on credentials and projects for organization and cross-project filtering
- FR96: Users can reveal the current value of a secret they are authorized to access, with each reveal event captured in the audit log

**Rotation & Propagation**
- FR18: Users can initiate a rotation workflow for any stored credential
- FR19: The system generates a per-system confirmation checklist for every rotation, listing all recorded dependent systems
- FR20: Users can mark each system on the rotation checklist as confirmed-updated
- FR21: The system prevents a rotation from being marked complete while systems on the checklist remain unconfirmed
- FR22: The system retires the old credential version only after all dependent systems are confirmed and the rotation is explicitly completed
- FR23: The system maintains a complete rotation history per credential (who initiated, each system confirmation, outcome)
- FR65: Users can view a consolidated list of credentials with upcoming rotation schedules, filterable by time horizon
- FR66: Users can view the live status of an in-progress rotation (which systems confirmed, pending, last actor)
- FR75: Users can record and respond to a system confirmation failure during an active rotation without abandoning the rotation

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
- FR77: Project Owners can enable an optional public-facing status page for a project — a shareable URL showing current health status to external stakeholders without an account

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

**Platform & Integration**
- FR46: Users can access all product capabilities through a web browser interface
- FR47: All product capabilities available in the web UI are also accessible via a versioned REST API
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

**Project Dashboard**
- FR93: The project dashboard surfaces: credential status (active, expiring, expired), upcoming rotation schedule, monitored service health, recent access events, and unresolved alert count — for the currently viewed project

**Notification Preferences**
- FR94: Users can configure personal notification preferences including delivery channel, frequency (per-event or digest), and minimum severity threshold

**Backup & Restore**
- FR88: The system creates encrypted snapshots of all vault data on a configurable schedule
- FR89: Administrators can configure backup retention policy and storage destination
- FR90: Administrators can restore vault state from a backup snapshot
- FR92: The system monitors backup health and alerts administrators when backups are missed, fail verification, or encounter storage issues

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
**NFR-MAINT7:** Internationalization: English-only in v1; no hardcoded strings in UI components

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

**Security Architecture**
- Constant-time comparisons for all secret/token operations; memory zeroing after secret use; secret values must not appear in logs/stack traces (enforced as code review requirement); secret-touching code paths enumerated
- Sealed route/handler constructor (`SecureRoute`) applies all cross-cutting concerns (RBAC, org_id, audit, rate limiting, memory safety) by default; concerns opted out explicitly with named flags — developer cannot create an unsecured route by forgetting middleware; applies to both HTTP handlers and background job execution contexts
- Rate limiting: 120 req/min per authenticated account/API key; 60 req/min per IP unauthenticated; CI/CD burst accommodated
- Unified authorization context: project-scoped RBAC + org-scoped subscription tier limits evaluated at a single framework gate per request; tier state cached with ≤60s TTL

**Plugin System**
- Plugin process isolation: separate processes; 3s timeout cap; max 2 retries with exponential backoff (3s → 6s)
- Plugin IPC secret delivery via localhost PSK TLS socket — plugins never receive plaintext via pipe/socket IPC; plugins request values via scoped execution token API; token expires at execution end
- Plugin permissions are context-bound (scoped execution token derived from rotation context: credential ID, project ID, execution ID); gateway enforces scope; threat model boundary documented
- Plugin interface defined and documented in v1; provider implementations deferred to v2

**Rotation State Machine**
- PostgreSQL advisory locks on credential ID as primary concurrency mechanism for rotation (prevents concurrent in-progress rotation on same credential); serializable isolation as fallback
- Compound rotation transaction (new version + rotation log + per-system checklist state + notification queue entry) must be atomic in all cases

**Machine User & Offline Cache**
- Offline cache: per-secret fallback eligibility (high-sensitivity secrets explicitly excluded); revocation list cached alongside secrets at last vault contact; residual risk: revocations during active vault downtime take effect after cache TTL expires
- v1.1 target: break-glass revocation endpoint with different availability profile; lightweight, read-only from credential store, write-only to signed revocation list; machine users check on each secret fetch

**Background Processing**
- Background jobs (health checks, rotation, monitoring) run in separate thread/process pool from request handling; org_id context enforced via same PostgreSQL RLS mechanism as HTTP requests; must not block UI

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

---

### FR Coverage Map

*(To be completed in Step 2 — Epic Design)*

---

## Epic List

*(To be completed in Step 2 — Epic Design)*

<!-- Repeat for each epic in epics_list (N = 1, 2, 3...) -->

<!-- End epic repeat -->
