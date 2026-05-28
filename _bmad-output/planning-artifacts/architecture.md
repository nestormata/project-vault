---
stepsCompleted: [1, 2, 3]
workflowType: 'architecture'
project_name: 'Project Vault'
user_name: 'Nestor'
date: '2026-05-28'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/product-brief-Project-Vault.md
  - _bmad-output/planning-artifacts/product-brief-Project-Vault-distillate.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
  - _bmad-output/planning-artifacts/research/technical-cryptographic-architecture-secrets-vault-research-2026-04-08.md
  - _bmad-output/planning-artifacts/research/technical-rbac-permission-architecture-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-rotation-plugin-architecture-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-service-health-monitoring-architecture-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-multi-tenancy-data-model-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-machine-user-auth-offline-caching-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/market-secrets-management-tools-research-2026-04-09.md
  - docs/federated-multi-tenant-architecture-analysis.md
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
95 FRs across 12 capability areas. Core areas driving architectural complexity:
- Secret & Credential Management: versioned, encrypted storage with RBAC
- Rotation & Propagation: plugin-executed with per-system confirmation checklist and compound transaction atomicity
- Machine User Access: scoped API keys, in-memory offline fallback, CI/CD native integrations
- Audit & Compliance: append-only, row-checksums, 100% capture guarantee, compliance export
- Operational Monitoring & Alerts: HTTP health checks, expiry tracking, auto-enrollment on registration
- Security & Authentication: dual auth paths (human/machine), MFA, session management, RBAC

**Non-Functional Requirements:**
Performance targets that drive key design choices:
- Secret fetch: p95 ≤100ms — optimized read path with connection pooling
- Secret search/filter: p95 ≤300ms paginated — indexed queries
- Dashboard first meaningful content: ≤2s — progressive loading strategy
- Audit log queries: p95 ≤500ms — this target applies at maximum sustained write rate over 30 days at full utilization, not only at 1M entries; indexing strategy must be designed for streaming write load
- Rotation initiation: p95 ≤500ms
- Availability: 99.9% with ≤30s crash recovery (automatic container restart required)
- Audit completeness: 100% — zero entries dropped under any load condition; enforced as a same-transaction write invariant, not a best-effort target

Security requirements are architectural constraints, not implementation choices:
- AES-256-GCM encryption at rest for all secrets and backups
- TLS 1.3 minimum inbound; TLS 1.2 minimum outbound (plugin connections)
- Constant-time comparisons for all secret/token operations
- Memory zeroing after secret use — enforced at code review level
- Rate limiting: 120 req/min per authenticated account; 60 req/min per IP unauthenticated

**Scale & Complexity:**
- Primary domain: Full-stack web application + REST API + background processing, self-hosted Docker
- Complexity level: High — cryptographic architecture, plugin subprocess system, org-aware multi-tenancy, compliance-grade audit, real-time monitoring, dual authorization (RBAC + tier)
- Reference deployment scale: 50 concurrent users / 100 concurrent API calls / 10,000 secrets / 1,000,000 audit log entries (single instance)
- Build context: Solo founder + AI assistance — every architectural complexity introduced is complexity the solo builder carries; the architecture must be powerful without being speculative

### Technical Constraints & Dependencies

- **Self-hosted Docker / Docker Compose primary** — single-command setup target; 12-factor app compliance required
- **PostgreSQL** — reference database; connection pooling required in production
- **Org-aware schema from v1** — every entity carries org_id at schema level; non-negotiable architectural constraint; enforcement must be structural, not conventional
- **Org_id enforcement via PostgreSQL Row-Level Security (RLS)** — the only mechanism that enforces at the database level regardless of application code; a query without org_id fails at the database, not the application; cannot be bypassed by raw SQL queries, application bugs, or developer omission; RLS policies maintained alongside schema migrations; the PostgreSQL application role has restricted default access enforced by RLS; complexity cost is justified at solo-build scale where database-level enforcement is the only mechanism that survives application bugs
- **Encryption layer abstracted for CMK** — v1 env-var-derived master key; abstraction must not close off future CMK migration without re-encryption
- **Key co-location risk reduced by default deployment architecture** — env var key storage places the master key on the same host as the data, meaning full host compromise exposes both; the default deployment must architecturally reduce this risk without requiring KMS: (a) the master key is provided as a mounted file path at a location separate from the compose configuration — a mounted file can be stored on a different volume or permissions domain; (b) envelope encryption with split storage is offered at first-run initialization as a stronger default — half-key from env var, half-key from a host filesystem path the user specifies, neither half sufficient alone; KMS integration is the advanced option, not the only mitigation; first-run ceremony includes explicit acknowledgment of the chosen key storage model and its threat coverage
- **Audit log encryption key is separate from master key** — derived from master via HKDF with a distinct info string; master key rotation and audit log key rotation have independent lifecycles; each audit log entry (or batch) stores the key version used for encryption; old master key versions are retained in a key history store after rotation for audit log decryption — without retention, audit log entries written under a previous key version become unreadable; key derivation parameters (master key version, HKDF info, algorithm) are versioned in storage format alongside the encryption scheme versioning already specified in the PRD
- **Audit writes are in the same transaction as the operation they record** — operation fails if audit write fails; 100% capture guarantee is an architectural invariant, not a best-effort target; requires: (a) audit log storage monitoring with alerts at 80%, 90%, and 95% capacity giving operators time to act before the vault locks; (b) a documented maintenance mode allowing Organization Admins to read-only access secrets while audit log writes are suspended, with the suspension itself recorded out-of-band; (c) a tested recovery procedure for restoring audit write capability without data loss included in the deployment guide
- **Audit log PII externalized at schema level** — audit log entries never contain PII directly; they reference a mutable `user_identity_token` table; pseudonymization on user deletion modifies the identity table only — audit log rows and their checksums are unchanged; identity tokens for deleted human users become permanent pseudonyms; tokens for active machine users associated with deleted users are preserved
- **Two distinct event log tables with explicit classification rule** — *Security audit log*: events where a human user or machine user intentionally acted on a protected resource (read a secret value, initiated rotation, changed a permission, created/deleted a user or machine user, exported audit data, modified system configuration); subject to cryptographic chaining, GDPR pseudonymization, compliance export, write-once export; low write volume. *Operational event log*: events generated by automated system processes (health check execution, background job completion, scheduler trigger, cache operation, backup execution) regardless of whether they touch a protected resource; not compliance-grade; high write volume; independent retention policy; not subject to tamper-evidence requirements. Classification rule: the actor's intent determines the table (intentional human/machine action → security log; automated process → operational log), not the event's subject
- **Rotation state machine locking** — evaluate PostgreSQL advisory locks on credential ID as primary mechanism before committing to transaction-level serializable isolation; advisory locks are simpler to reason about (explicit acquire/release), avoid serialization error retry complexity, and prevent concurrent in-progress rotation on the same credential without requiring the full compound transaction to run at SERIALIZABLE level; if advisory locks prove insufficient, serializable isolation is the fallback; the compound transaction (new version + rotation log + per-system checklist state + notification queue entry) must in all cases be atomic
- **Plugin IPC secret delivery via localhost TLS** — plugins never receive plaintext secret values via pipe/socket IPC (kernel buffers cannot be zeroed by application code); plugins request secret values via scoped execution token API served over a localhost TLS socket by the main process; PSK (pre-shared key) TLS mode eliminates certificate management overhead while maintaining transport security; plugin never holds plaintext longer than immediate operation requires; token expires at execution end
- **Plugin permissions are context-bound, not manifest-declared** — scoped execution token derived from rotation context (credential ID, project ID, execution ID); gateway enforces scope; token expires at execution end; threat model scope: this mitigation addresses external plugin supply chain attacks and accidental over-scoping; it does not address a malicious insider with Admin access who legitimately initiates a rotation to expose a credential — dual-approval for rotation initiation (PRD v2 feature) addresses the insider threat; this boundary must be documented in the plugin security model
- **Plugin process isolation** — separate processes; 3s timeout cap; max 2 retries exponential backoff; PSK TLS socket for secret delivery
- **Offline cache revocation model** — TTL alone is insufficient for urgent revocations; v1: per-secret fallback eligibility (high-sensitivity secrets explicitly excluded from cache) + revocation list cached alongside secrets at last vault contact (effective for revocations before vault downtime began); residual risk: revocations during active vault downtime take effect only after cache TTL expires; v1.1 target: break-glass revocation endpoint with a different availability profile than the main vault — lightweight, read-only from credential store, write-only to a signed revocation list; machine users check this endpoint on each secret fetch; signed revocation list verifiable offline without full vault contact; reduces revocation propagation window from full TTL to last revocation list fetch interval
- **Unified authorization context** — role-based (project-scoped RBAC) and tier-based (org-scoped subscription limits) evaluated at a single framework gate per request; tier state cached in auth context with short TTL (≤60 seconds) — upgrades and downgrades take effect within one TTL window without per-request database hits; RBAC schema and tier limit schema designed together
- **Sealed route constructor for concern composition** — a `SecureRoute` / secured handler abstraction that applies all cross-cutting concerns (RBAC, org_id, audit, rate limiting, memory safety) as defaults; concerns are opted out explicitly, not opted in; a developer cannot create an unsecured route by forgetting middleware — only by explicitly disabling a concern with a named configuration flag; this is architecturally stronger than a CI lint rule (which catches omissions later) and scales better at solo-build pace; the abstraction must work for both HTTP request handlers and background job execution contexts
- **REST API first** — all UI functionality API-backed; versioned (/api/v1/); OpenAPI spec published with OSS release; no privileged UI-only operations
- **Multi-arch container builds** — AMD64 + ARM64
- **No CLI in v1** — post-MVP
- **WCAG 2.1 AA** — axe-core CI gate; manual audit of top-5 flows pre-launch

### Cross-Cutting Concerns Identified

1. **Encryption at rest** — AES-256-GCM; master key from env var or mounted file via KDF; separate HKDF-derived key for audit logs with independent rotation lifecycle and per-entry key version storage; abstraction layer for future CMK; secret-reading abstraction applies encryption + memory zeroing + audit as a single composable unit

2. **Org/tenant isolation** — org_id on every entity; enforced via PostgreSQL RLS at database level; applies in both HTTP request context and background job execution context; machine user scope enforced at secret-read time (not only at key issuance); scope changes invalidate cached permissions and generate audit entries

3. **Security audit logging** — intentional human/machine actions on protected resources; same-transaction writes (operation fails if audit write fails); append-only; row-level checksums; PII externalized to mutable identity reference table; write-once export; completeness tested in CI with deliberate write failure harness; storage monitoring at 80/90/95% capacity thresholds; maintenance mode + recovery procedure documented and tested

4. **Operational event logging** — automated system process events; separate table from security audit log; high write volume; independent retention policy; not tamper-evident; not subject to GDPR pseudonymization

5. **RBAC + tier authorization** — unified authorization context object; project-scoped role + org-scoped tier limit evaluated together at single framework gate; tier state cached with ≤60s TTL; schemas designed in concert

6. **Rate limiting** — all endpoints; separate human/machine pools; CI/CD burst accommodated; audit storage implications of maximum write rate accounted for in indexing strategy (streaming write rate constraint, not point-in-time)

7. **Security code paths** — constant-time comparisons; memory zeroing; no secrets in logs/stack traces; secret-touching paths enumerated; code review checklist as CI artifact; secret-reading abstraction enforces these as a unit

8. **Background job reliability** — event-triggered + scheduled; separate thread/process pool from request handling; org_id context enforced via same RLS mechanism as HTTP requests; must not block UI

9. **Plugin process isolation** — subprocess model; context-bound scoped execution tokens; PSK TLS localhost socket for secret delivery; timeout enforcement; token expires at execution end; threat model boundary documented

10. **Cross-cutting concern composition** — sealed route/handler constructor as primary enforcement mechanism; all concerns applied by default, opted out explicitly with named flags; applies to both HTTP handlers and background job contexts; number of places where a developer manually applies a cross-cutting concern approaches zero

### Architectural Risk Register

| Risk | Failure Mode | Resolution |
|---|---|---|
| Key co-location | Host compromise exposes key + data | Architectural default: mounted file path separation or envelope split; KMS as advanced option; first-run ceremony with explicit threat model acknowledgment |
| Org_id bypass by omission | Cross-org data leak | PostgreSQL RLS — database-level enforcement that survives application bugs |
| Audit/operation split writes | Silent audit gap; 100% capture violated | Same-transaction writes; storage monitoring at 80/90/95%; maintenance mode + recovery procedure |
| Rotation race condition | Concurrent confirmations retire credential early | Advisory lock on credential ID (preferred); serializable isolation as fallback; compound transaction atomic in all cases |
| Plugin manifest privilege escalation | Plugin claims broader scope than rotation context | Context-bound scoped tokens; gateway enforces; insider threat boundary documented |
| Cross-cutting concern drift | New endpoint missing full concern chain | Sealed constructor — opt-out not opt-in; no CI gate dependency |

### Cross-Cutting Concern Interaction Map

| Interaction | Finding | Resolution |
|---|---|---|
| Encryption × Audit | Master key rotation ≠ audit log re-encryption | Separate HKDF-derived audit key; per-entry key version stored; old master versions retained |
| Org Isolation × Audit × GDPR | PII in audit rows makes pseudonymization break checksums | PII externalized to mutable identity reference table at schema design |
| RBAC × Offline Cache | Revocation cannot propagate during vault downtime | Per-secret exclusion + cached revocation list (v1); break-glass signed revocation endpoint (v1.1 target) |
| Audit × Background Jobs | Background events dominate audit volume and index performance | Two log tables with explicit classification rule: actor intent determines table |
| Plugin Isolation × Memory Safety | IPC passes plaintext through kernel buffers that cannot be zeroed | PSK TLS localhost socket; plugin requests value via execution token API |
| Rate Limiting × Audit Volume | 1M entry target understates real write load | Performance target reframed as streaming write rate over 30 days at maximum utilization |
| Org Isolation × Background Jobs | Org context not natively available in job frameworks | PostgreSQL RLS applies to all connections — job context uses same enforcement as HTTP context |
| RBAC × Subscription Tiers | Dual authorization systems create omission risk | Unified authorization context at single framework gate; tier state cached ≤60s TTL |

## Starter Template Evaluation

### Primary Technology Domain

Full-stack web application + REST API + background processing.
Self-hosted Docker primary deployment. Monorepo architecture.

### Technical Preferences

- **Language:** TypeScript throughout (frontend + backend)
- **Frontend framework:** Svelte 5 + SvelteKit 2
- **Monorepo tooling:** Turborepo + pnpm workspaces
- **Deployment:** Docker / Docker Compose self-hosted

### Starter Options Considered

| Option | Verdict |
|---|---|
| `create-turbo` with SvelteKit example | Selected — official, maintained, 100% TypeScript |
| NestJS for backend | Rejected — too heavy, opinionated DI adds friction at solo scale |
| Hono for backend | Considered — edge-runtime advantage irrelevant for self-hosted Docker; Fastify's OpenAPI and rate-limit plugins more mature for this use case |
| BullMQ for background jobs | Rejected — requires Redis, adds a separate infrastructure dependency; pg-boss uses existing PostgreSQL |
| Prisma ORM | Considered — code-generation approach and heavier runtime less suited to RLS-heavy schema patterns; Drizzle's SQL-like DSL maps more cleanly |

### Selected Foundation: Turborepo + pnpm workspaces

**Initialization Command:**

```bash
pnpm dlx create-turbo@latest project-vault --example with-svelte
```

Then extend manually with:
- `apps/api` — Fastify application
- `packages/db` — Drizzle schema + migrations + RLS policy definitions
- `packages/crypto` — AES-256-GCM encryption utilities
- `packages/shared` — Zod schemas, shared TypeScript types, constants

**Monorepo Structure:**

```
project-vault/
├── apps/
│   ├── web/           # SvelteKit 2 + Svelte 5 + Tailwind CSS v4
│   └── api/           # Fastify v5 + pg-boss v12 (REST API + background workers)
├── packages/
│   ├── db/            # Drizzle ORM 0.45.x schema, migrations, RLS policies
│   ├── crypto/        # AES-256-GCM + HKDF key derivation utilities
│   ├── shared/        # Zod schemas, TypeScript types, constants
│   ├── tsconfig/      # Shared TypeScript configuration
│   └── eslint-config/ # Shared ESLint configuration
├── turbo.json
└── pnpm-workspace.yaml
```

**Architectural Decisions Provided by This Foundation:**

**Language & Runtime:**
TypeScript throughout; Node.js 24 LTS for API; SvelteKit server-side rendering for web app.

**Styling Solution:**
Tailwind CSS v4 in SvelteKit — utility-first, well-suited to monitoring-mode density requirements
and responsive layout across desktop and mobile contexts.

**Build Tooling:**
Turborepo for task orchestration (build, test, lint, typecheck across packages with caching);
Vite via SvelteKit for frontend; tsx for API development server.

**Testing Framework:**
Vitest across all packages — unified runner, TypeScript-native, compatible with both SvelteKit
and Node.js environments.

**ORM & Database:**
Drizzle ORM 0.45.x with `postgres.js` driver; SQL-like DSL maps cleanly to RLS-heavy schema;
drizzle-kit for migration generation and schema introspection.

**Background Job Processing:**
pg-boss 12.18.2 — PostgreSQL-backed queue (no Redis); exactly-once delivery via SKIP LOCKED;
cron scheduling, dead-letter queue, exponential backoff; runs in same Node.js process as API,
registered as handlers on startup; shares PostgreSQL connection pool.

**API Framework:**
Fastify v5 with `@fastify/swagger` (OpenAPI spec auto-generation), `@fastify/rate-limit`,
`@fastify/jwt`, `@fastify/type-provider-zod` (Zod schema validation + type inference).
OpenAPI spec published automatically from route definitions.

**Code Organization:**
`packages/shared` Zod schemas serve as the single source of truth for API request/response
types — validated in Fastify, inferred in SvelteKit client. `packages/db` schema definitions
are the single source of truth for database types — no separate type generation step.

**Development Experience:**
Turborepo caching for incremental builds; Vitest for fast unit tests;
`tsx --watch` for API hot reload; SvelteKit dev server with HMR.

**Note:** Project initialization using the command above should be the first implementation
story. Manual package additions (api, db, crypto, shared) should follow immediately as the
second story before any feature implementation begins.
