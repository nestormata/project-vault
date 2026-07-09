---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
workflowType: 'architecture'
lastStep: 8
status: 'complete'
completedAt: '2026-05-28'
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
- Credential fetch: p95 ≤100ms — optimized read path with connection pooling
- Credential search/filter: p95 ≤300ms paginated — indexed queries
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
- **Key co-location risk reduced by default deployment architecture** — env var key storage places the master key on the same host as the data, meaning full host compromise exposes both; the default deployment must architecturally reduce this risk without requiring KMS: (a) the master key is provided as a mounted file path at a location separate from the compose configuration — a mounted file can be stored on a different volume or permissions domain; (b) envelope encryption with split storage is the **recommended default path** at first-run initialization — half-key from env var, half-key from a host filesystem path the user specifies, neither half sufficient alone; (c) env-var-only mode is presented as **"Not recommended — full host env exposure decrypts all secrets"** — it must feel like a downgrade, not the default; KMS integration is the advanced option; first-run ceremony includes explicit acknowledgment of the chosen key storage model and its threat coverage. **Software threat model boundary:** complete host compromise (env + filesystem + database simultaneously) is outside the software-level threat boundary. Mitigations: envelope split key (v1), dedicated secrets server on separate host (operational), KMS integration (v2). This boundary must be explicitly documented in the deployment guide.
- **Audit log encryption key is separate from master key** — derived from master via HKDF with a distinct info string; master key rotation and audit log key rotation have independent lifecycles; each audit log entry (or batch) stores the key version used for encryption; old master key versions are retained in a key history store after rotation for audit log decryption — without retention, audit log entries written under a previous key version become unreadable; key derivation parameters (master key version, HKDF info, algorithm) are versioned in storage format alongside the encryption scheme versioning already specified in the PRD
- **Audit writes are in the same transaction as the operation they record** — operation fails if audit write fails; 100% capture guarantee is an architectural invariant, not a best-effort target; requires: (a) audit log storage monitoring with alerts at 80%, 90%, and 95% capacity giving operators time to act before the vault locks; (b) a documented maintenance mode allowing Organization Admins to read-only access secrets while audit log writes are suspended, with the suspension itself recorded out-of-band; (c) a tested recovery procedure for restoring audit write capability without data loss included in the deployment guide. **Operational escalation path for audit write bottlenecks (mandatory, do not improvise):** when `audit_log_entries` write latency exceeds 50ms p95 (tracked via `prom-client` histogram `audit_write_latency_ms`), the correct responses are in order: (1) ensure composite index on `(org_id, created_at DESC)` exists; (2) partition the table by month using PostgreSQL declarative partitioning; (3) scale PostgreSQL IOPS via storage configuration. Moving audit writes out of the transaction is **never** a valid response — it silently voids the audit completeness guarantee. Documenting this escalation path is required in `docs/operations/audit-log-scaling.md`, referenced from the deployment guide.
- **Audit log PII externalized at schema level** — audit log entries never contain PII directly; they reference a mutable `user_identity_token` table; pseudonymization on user deletion modifies the identity table only — audit log rows and their checksums are unchanged; identity tokens for deleted human users become permanent pseudonyms; tokens for active machine users associated with deleted users are preserved
- **Two distinct event log tables with explicit classification rule** — *Security audit log*: events where a human user or machine user intentionally acted on a protected resource (read a secret value, initiated rotation, changed a permission, created/deleted a user or machine user, exported audit data, modified system configuration); subject to cryptographic chaining, GDPR pseudonymization, compliance export, write-once export; low write volume. *Operational event log*: events generated by automated system processes (health check execution, background job completion, scheduler trigger, cache operation, backup execution) regardless of whether they touch a protected resource; not compliance-grade; high write volume; independent retention policy; not subject to tamper-evidence requirements. Classification rule: the actor's intent determines the table (intentional human/machine action → security log; automated process → operational log), not the event's subject
- **Rotation state machine locking** — evaluate PostgreSQL advisory locks on credential ID as primary mechanism before committing to transaction-level serializable isolation; advisory locks are simpler to reason about (explicit acquire/release), avoid serialization error retry complexity, and prevent concurrent in-progress rotation on the same credential without requiring the full compound transaction to run at SERIALIZABLE level; if advisory locks prove insufficient, serializable isolation is the fallback; the compound transaction (new version + rotation log + per-system checklist state + notification queue entry) must in all cases be atomic
- **Plugin IPC secret delivery via localhost TLS** — plugins never receive plaintext secret values via pipe/socket IPC (kernel buffers cannot be zeroed by application code); plugins request secret values via scoped execution token API served over a localhost TLS socket by the main process; PSK (pre-shared key) TLS mode eliminates certificate management overhead while maintaining transport security; plugin never holds plaintext longer than immediate operation requires; token expires at execution end
- **Plugin permissions are context-bound, not manifest-declared** — scoped execution token derived from rotation context (credential ID, project ID, execution ID); gateway enforces scope; token expires at execution end; threat model scope: this mitigation addresses external plugin supply chain attacks and accidental over-scoping; it does not address a malicious insider with Admin access who legitimately initiates a rotation to expose a credential — dual-approval for rotation initiation (PRD v2 feature) addresses the insider threat; this boundary must be documented in the plugin security model
- **Plugin network egress — v1 limitation (documented):** plugin subprocesses are not network-namespace-isolated in v1; a malicious plugin can make arbitrary outbound TCP connections. Mitigations in v1: (a) plugin installation is OrgAdmin-only — enforced at the API level, not just convention; (b) plugin manifests declare expected egress endpoints (`egress: [{ host, port }]`) — deviations **must** be logged as operational `WARN` events (this is NOT optional and NOT advisory — it is the only compensating control for the namespace gap); (c) the plugin security model documentation must explicitly state this limitation. v2 target: Linux network namespace isolation restricting plugin egress to declared endpoints only. **Egress monitoring implementation (required for v1, not deferrable):** the plugin host intercepts outbound connections via Node.js `http`/`https` agent override; any connection whose `host:port` does not appear in the plugin manifest's `egress` list emits `pino.warn({ event: 'PLUGIN_EGRESS_DEVIATION', pluginId, host, port })` to the operational log AND increments `prom-client` counter `plugin_egress_deviations_total{plugin_id}`. No plugin may be marked installable until this monitoring is active. Remove the phrase "not enforced" from all documentation — it invites skipping implementation.
- **Plugin process isolation** — separate processes; 3s timeout cap; max 2 retries exponential backoff; PSK TLS socket for secret delivery
- **Offline cache revocation model** — TTL alone is insufficient for urgent revocations; v1: per-secret fallback eligibility (high-sensitivity secrets explicitly excluded from cache) + revocation list cached alongside secrets at last vault contact (effective for revocations before vault downtime began); residual risk: revocations during active vault downtime take effect only after cache TTL expires; v1.1 target: break-glass revocation endpoint. **Cache TTL canonical values (env-var configurable, named constants in `packages/shared/constants/cache.ts`):**
  - `MACHINE_USER_CACHE_TTL_SECONDS` default = **300** (5 minutes) — balances recovery from routine deployments (< 5 min) against revocation propagation window; applies per-cached-secret
  - Per-secret TTL override range: 60s minimum, 3600s maximum (set on the secret record by OrgAdmin)
  - `HIGH_SENSITIVITY_CACHE_TTL_SECONDS` default = **0** (excluded from cache entirely) — secrets flagged `highSensitivity: true` are never served from cache regardless of `MACHINE_USER_CACHE_TTL_SECONDS`
  - Rationale: 5 minutes covers the typical Docker container restart window (< 30s) plus grace; a revocation issued during vault downtime takes effect at most 5 minutes after vault returns. v1.1 target: break-glass signed revocation endpoint with different availability profile than the main vault — lightweight, read-only from credential store, write-only to a signed revocation list; machine users check this endpoint on each secret fetch; signed revocation list verifiable offline without full vault contact; reduces revocation propagation window from full TTL to last revocation list fetch interval
  - **Offline cache stores ciphertext only — not plaintext.** The LRU cache stores the encrypted blob (ciphertext + IV + version tag). `withSecret()` is invoked on every cache hit — decryption occurs at access time, not at cache-fill time. The cache provides fault tolerance (DB unavailability) and connection spike protection, not cryptographic shortcut. This means master key rotation takes effect immediately on all subsequent accesses, with no stale-plaintext window. `// offline-cache stores ciphertext, not plaintext — decryption occurs on every access` comment required in the cache implementation.
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

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- Real-time transport: SSE with injected EventEmitter, Last-Event-ID replay, polling fallback
- Password hashing: Argon2id (memoryCost: 65536, timeCost: 3, parallelism: 4)
- Session/token revocation: Database-backed (`sessions` table, indexed jti)
- ORM + database enforcement: Drizzle + PostgreSQL RLS via `SET LOCAL` in `db.transaction()`
- Background jobs: pg-boss (PostgreSQL-backed); CPU-bound handlers via `worker_threads`
- Crypto versioning structure: versioned ciphertext format from first commit

**Important Decisions (Shape Architecture):**
- Component library: shadcn-svelte
- State management: Svelte 5 Runes + module-level state
- API client pattern: Shared Zod schemas + openapi-typescript + openapi-fetch
- MFA library: otpauth
- Logging: pino (Fastify native)
- Email: nodemailer + SMTP
- Graceful shutdown sequence: explicit SIGTERM → SSE close → pgBoss.stop() → fastify.close()

**Deferred Decisions (Post-v1):**
- Error monitoring: Sentry (v1.1 — structured logs + Prometheus sufficient for v1)
- Horizontal scaling / shared cache: in-memory LRU tier cache is a single-instance constraint; Redis or DB-backed cache required before multi-container deployment
- WebSocket upgrade: SSE covers all server-push use cases in v1

### Data Architecture

**Database:** PostgreSQL (latest stable) with connection pooling via `postgres.js`

**ORM:** Drizzle ORM 0.45.x
- SQL-like DSL maps cleanly to RLS-heavy schema
- drizzle-kit for migration generation
- `packages/db` is the single source of truth for database schema and RLS policy definitions
- No separate type generation step — types inferred from schema at compile time

**Row-Level Security:**
- PostgreSQL RLS enforced at database level — not application layer
- Every table has `org_id` column; RLS policy filters all queries by `current_setting('app.current_org_id')`
- **All database operations use `db.transaction()` to ensure `SET LOCAL app.current_org_id = '...'` is transaction-scoped** — `SET LOCAL` resets automatically on transaction end, eliminating connection pool race conditions where a pooled connection carries a previous request's org context
- Bare `db.select()` / `db.insert()` calls outside a transaction are forbidden; enforced by a custom ESLint rule that flags direct Drizzle calls not wrapped in `db.transaction()`
- Background job workers open their own transaction per job execution, setting org context from the job payload
- Drizzle migrations include RLS policy DDL alongside schema changes

**Session/Token Revocation:**
- Database-backed `sessions` table: `(jti, user_id, expires_at, revoked_at)` — one row per issued JWT
- `refresh_tokens` table linked via `session_id` FK — one row per issued refresh token with grace window fields (`used_at`, `new_session_id`)
- **Refresh token grace window:** prevents delivery-failure lockout; on refresh, `used_at` is set and `new_session_id` recorded before sending new tokens; client retry within 30s re-issues same new tokens idempotently; after 30s the token is fully revoked
- Index on `sessions.jti` (auto via UNIQUE) for fast per-request revocation check
- `session:cleanup` pg-boss job purges `sessions` and `refresh_tokens` where `expires_at < now() - interval '1 day'`; requires `idx_sessions_expires_at` and `idx_refresh_tokens_expires_at`
- Adds one indexed query per authenticated request — acceptable at target scale

**Tier Limit Cache:**
- In-memory LRU cache (no Redis) per process; TTL ≤60 seconds
- Invalidated on subscription tier change event
- **Architectural constraint: incompatible with horizontal scaling.** Multiple API containers maintain independent caches; quota enforcement becomes inconsistent between processes during the TTL window. Any deployment with more than one API container requires replacing this with a shared cache layer (Redis or database-backed). This constraint must be documented in the deployment guide. v1 single-instance Docker Compose deployment is the only supported topology.
- **Startup multi-instance guard:** on API startup, if `INSTANCE_COUNT` env var is set to > 1 or a `CLUSTER_MODE=true` env var is detected, emit a pino `error`-level log and exit with code 1 — do not silently run in an unsafe topology. This check lives in `apps/api/src/config.ts`. **Supplementary DB-backed instance detection (required — env var alone is insufficient):** Docker Compose `replicas:` and Swarm scaling never set env vars. At startup, the API writes a heartbeat row to `api_instances (id uuid, started_at timestamptz, last_seen timestamptz)` and immediately queries `WHERE last_seen > now() - interval '30s' AND id != $currentInstanceId`. If any rows exist, another live instance is detected — emit `pino.error` and exit(1). The heartbeat is updated every 15s via `setInterval`; the query is only needed at startup. Add `api_instances` to implementation sequence Step 2 (infrastructure foundation).
- **Accepted trade-off — tier downgrade grace window:** because the cache TTL is ≤60 seconds, a customer whose subscription tier is downgraded retains access to the previous tier's limits for up to 60 seconds. This is an *explicitly accepted trade-off* for v1: the operational simplicity of no Redis dependency outweighs the 60-second enforcement gap. Upgrade enforcement (new limits take effect within TTL) is directionally safe. Downgrade enforcement has the 60-second window. This must be disclosed in the deployment and billing documentation.

**Full-text Search:**
- PostgreSQL `tsvector` for cross-project search (FR80)
- Sufficient for v1 at target scale (10,000 secrets); no external search engine needed

**Email:**
- `nodemailer` with SMTP transport
- SMTP configuration via admin UI (FR86)
- Self-hosted operators provide their own SMTP credentials

### Authentication & Security

**Password hashing:** Argon2id via `argon2` npm package
- Parameters: `memoryCost: 65536` (64MB), `timeCost: 3`, `parallelism: 4`
- OWASP 2024 recommended configuration
- Applied to all human user passwords and vault master password derivation

**MFA:** TOTP via `otpauth`
- RFC 6238 compliant
- Recovery codes: 8x 16-character codes, bcrypt-hashed at storage
- MFA enrollment generates codes; codes are one-time-use, invalidated on use
- **MFA enforcement rule (architectural invariant):** MFA is **mandatory for OrgAdmin and Owner roles** — the auth middleware checks `authContext.orgRole` after JWT verification; if the role is `OrgAdmin` or `Owner` and `user.mfa_enrolled_at IS NULL`, the request is rejected with `403 MFA_ENROLLMENT_REQUIRED` and the client is redirected to the MFA enrollment flow. MFA is **strongly encouraged but optional for Member and Viewer roles in v1** — enforcement is via UI prompts, not middleware. Rationale: OrgAdmin/Owner have write access to secrets, permissions, and billing; Member/Viewer access is read-scoped and lower-risk. This distinction must be enforced at the auth middleware level, not at individual route handlers.

**JWT architecture:**
- Web session JWTs: **≤5 min TTL**, signed with HMAC-SHA256 (`@fastify/jwt`) — a secrets vault protects production credentials; a stolen session JWT must have the shortest practical window; 5 minutes with silent refresh is the correct default for this threat model
- Machine user exchange JWTs: ≤1h TTL, issued via API key token exchange
- Both carry `jti` (JWT ID) for revocation lookup
- Revocation checked on every authenticated request via indexed DB query
- **JWT storage (architectural decision):** web session JWTs are stored exclusively in `httpOnly; Secure; SameSite=Strict` cookies — never in `Authorization` header for browser sessions, never in localStorage, never in JavaScript-accessible memory. `httpOnly` makes the token invisible to JavaScript, preventing exfiltration via XSS. Machine user API interactions use `Authorization: Bearer <token>` header (non-browser context, no XSS surface). SvelteKit `hooks.server.ts` reads the cookie server-side for SSR; client-side fetch uses credentials: 'include'.
- **Silent refresh (web session only):** a separate `httpOnly; Secure; SameSite=Strict; Path=/api/v1/auth/refresh` rotating refresh token cookie is issued at login with a 7-day absolute TTL. `hooks.server.ts` checks the JWT on every server-side request; if the JWT is expired (or within 2 minutes of expiry), it calls `POST /api/v1/auth/refresh`, issues a new JWT + new refresh token, and sets both cookies before continuing. The 5-minute JWT TTL is invisible to the user; stolen JWTs are usable for at most 5 minutes without a valid refresh token.
- **Silent refresh — SSR cookie forwarding (required implementation detail):** SvelteKit's global `fetch` does NOT automatically forward cookies. `hooks.server.ts` must: (1) extract the refresh token cookie via `event.cookies.get('refresh-token')`, (2) attach it manually to the outgoing `fetch()` call in the `Cookie` header, (3) forward the `Set-Cookie` response headers back via `event.cookies.set()`. Failure to do this causes silent 401 on every refresh attempt → user is logged out every 5 minutes. This must be implemented in the `handle` hook where `event.cookies` is accessible.
- **Silent refresh — grace window idempotent response:** when a client retries a refresh within the 30s grace window, the server looks up the original refresh token row (which has `used_at` set and `new_session_id` populated), retrieves the `new_session_id`'s `jti` from the `sessions` table, and signs a **fresh JWT** from that `jti` (same logical session, new `iat`/`exp`). This is the correct interpretation of "idempotent" — the *session identity* (`jti`) is idempotent, not the JWT string itself. **Raw JWT strings must never be stored in the database.** The retry response uses the same `new_session_id` row's `jti` to reconstruct a valid JWT without re-inserting any session rows. **Critical: `iat` must be `now()`, not the original session's `created_at`.** The JWT signing call uses `{ jti: newSession.jti, sub: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS }`. Using `newSession.created_at` as `iat` would produce a JWT with a shortened effective TTL proportional to the retry delay (e.g., a 28s retry delay produces a JWT that expires 272s later instead of 300s).
- **Silent refresh — concurrent request guard (required):** SvelteKit parallel `load` functions fire multiple simultaneous server requests; without a guard, all detect an expiring JWT and race to refresh, causing each to invalidate the previous. Mitigation: `hooks.server.ts` maintains a **module-level `refreshPromises: Map<string, Promise<Tokens>>`** keyed by the current refresh token's stable ID (first 16 bytes of its hash, safe to use as a key). When a refresh is needed, the hook checks the map first — if a promise is already in flight for this refresh token, it awaits that promise instead of issuing a new refresh. The promise is removed from the map on settlement (success or failure). This serializes all concurrent refresh attempts for the same token to a single HTTP call.

**Encryption:**
- `packages/crypto`: AES-256-GCM for secrets at rest; HKDF for key derivation
- Master key: env var (default) or mounted file path (stronger default — separate volume/permissions domain)
- Audit log encryption key: HKDF-derived from master with distinct info string
- Per-entry key version stored in audit log for independent rotation lifecycle
- **Every encrypted field stores the encryption scheme version alongside the ciphertext from the first commit.** Format: `{ version: 1, iv: ..., ciphertext: ..., tag: ... }`. Retrofitting versioning onto stored data later requires a full re-encryption migration. Cryptographic agility (per PRD) depends on this being in place from day one.
- Node.js built-in `crypto` module — no external crypto library needed
- **`SecretValue` wrapper type — mandatory for all decrypted secret values:**
  All decryption operations in `packages/crypto` return values through a `withSecret(encryptedValue, async (plaintext: Buffer) => { ... })` helper that zeros the plaintext buffer in `finally`. **The callback parameter is typed as `Buffer`, not `string`.** The helper returns only what the callback returns — the plaintext never escapes the callback scope. Converting the `Buffer` to a JS string inside the callback is permitted but explicitly forfeits the zeroing guarantee for that copy (JS strings are immutable; `Buffer.fill(0)` cannot reach them). This trade-off must be documented at any call site that converts to string. The `SecretValue` type (used only if the plaintext must cross a function boundary) overrides `toJSON()`, `toString()`, and `[Symbol.for('nodejs.util.inspect.custom')]` to return `'[REDACTED]'` — preventing accidental pino log serialization of plaintext. **Bare `decrypt()` returning a `string` is forbidden** — all call sites use `withSecret()`. This applies to the value revelation path, the rotation plugin token delivery path, and any backup/migration operation. The `packages/crypto` README must document the `Buffer`-first contract and the string conversion caveat explicitly.

**RBAC + tier authorization:**
- Unified `AuthContext` object: `{ userId, orgId, projectRole, tierLimits }`
- Populated by Fastify auth middleware on every authenticated request
- `tierLimits` fetched from in-memory LRU cache (≤60s TTL)
- Sealed `SecureRoute` handler abstraction — all routes use it; concerns are opt-out not opt-in

### API & Communication Patterns

**REST API:** Fastify v5, versioned at `/api/v1/`

**OpenAPI spec:** Auto-generated by `@fastify/swagger` from route definitions
- Published at `/api/v1/docs` (dev) and as static artifact at build time
- Single source of truth for API contract

**OpenAPI type generation pipeline (Turborepo task dependency):**
- `apps/api/scripts/generate-spec.ts` — initializes Fastify with mocked I/O dependencies (no live DB, no pg-boss), registers all routes and plugins, exports the OpenAPI spec to `packages/shared/openapi.json`, exits. **Required mocking pattern (`createMockApp` factory):** `apps/api/src/app.ts` exports a `createApp(options: { dbPool?: Pool; pgBoss?: PgBoss; logger?: boolean })` factory. When `dbPool` is not provided, the factory registers a stub DB plugin that returns empty results for all queries — it must never fall back to `process.env.DATABASE_URL`. `generate-spec.ts` calls `createApp({ logger: false })` with no `dbPool` or `pgBoss`. The same factory is used by `route-audit.test.ts`. This pattern prevents `generate-spec.ts` from ever touching a real database, which would cause parallel CI branch conflicts.
- `openapi-typescript` runs against `packages/shared/openapi.json` to generate `packages/shared/api-types.ts`
- `turbo.json` task dependencies:
  ```json
  {
    "generate-spec": { "dependsOn": ["^build"], "outputs": ["../../packages/shared/openapi.json"] },
    "typecheck": { "dependsOn": ["generate-spec"] }
  }
  ```
- `web#typecheck` implicitly depends on `api#generate-spec`; stale types are a CI error, not silent drift

**Validation:** `@fastify/type-provider-zod` — Zod schemas from `packages/shared` validate requests
- `openapi-fetch` provides typed HTTP client in SvelteKit

**Error handling standard:**
```typescript
{
  error: string,       // machine-readable code (e.g. "CREDENTIAL_NOT_FOUND")
  message: string,     // human-readable description
  statusCode: number,
  requestId: string    // Fastify request ID for log correlation
}
```

**Rate limiting:** `@fastify/rate-limit`
- Human users: 120 req/min per authenticated account
- Machine users: 120 req/min per API key (separate pool)
- Unauthenticated: 60 req/min per IP
- SSE connections counted separately (not against request rate limit)

**Real-time transport:** Server-Sent Events (SSE)
- Server pushes: service health status, expiry alert changes, rotation progress, notification events
- Scoped per user: only events for projects the user can access (org_id + RBAC filtered)
- pg-boss job completions publish to an **injected `EventEmitter` instance** — not a module-level singleton; created at app startup and passed to both the Fastify SSE route and pg-boss worker registration; tests receive isolated instances without shared listener state
- Fastify route: `GET /api/v1/stream` — authenticated, returns `text/event-stream`
- **SSE reconnection and event replay:** server assigns monotonic `id` to every SSE event; client sends `Last-Event-ID` header on reconnect; server replays events since that ID from a short in-memory ring buffer (last 100 events, max 60 seconds); client refreshes full state via REST on reconnect if beyond buffer. **Ring buffer size and TTL are named constants** (`SSE_RING_BUFFER_SIZE = 100`, `SSE_RING_BUFFER_TTL_MS = 60_000`) defined in `lib/sse-ring-buffer.ts` — never magic numbers inline; revisit size if monitoring event density grows significantly. **Single-instance constraint (same as tier cache):** `sse-ring-buffer.ts` is a module-level singleton; multiple API containers maintain independent ring buffers — a client reconnecting to a different instance gets incorrect or empty `Last-Event-ID` replay silently. `sse-ring-buffer` must be added to the startup multi-instance guard in `config.ts`. When horizontal scaling is needed, replace with a Redis Streams or DB-backed replay source.
- **Polling fallback (required, not optional):** SvelteKit SSE consumer detects connection drop via `EventSource` `onerror`; after 3 failed reconnection attempts (5s intervals), switches to 30-second polling against `GET /api/v1/projects/{id}/status`; visual indicator shown in monitoring surface when in polling mode; SSE reconnection attempted every 60 seconds in background

**Graceful shutdown sequence:**
1. Stop accepting new HTTP connections
2. Send `event: reconnect` to all active SSE connections, then close them
3. `pgBoss.stop({ graceful: true })` — waits for active job handlers to complete
4. `fastify.close()` — drains in-flight requests, closes DB pool
5. Exit 0

Docker Compose `stop_grace_period: 30s` required (default 10s insufficient for active pg-boss jobs).

**Background worker constraints:**
- I/O-bound pg-boss handlers (health checks, notifications, expiry queries) run directly in main thread
- **CPU-bound handlers (backup encryption, audit log hash chain verification, bulk re-encryption) must offload to `worker_threads`** to prevent event loop blocking and latency spikes on the p95 ≤100ms credential fetch path
- **`withSecret()` × `worker_threads` boundary rule (critical):** `withSecret()` callbacks run in the calling thread — the callback cannot be serialized across a `postMessage()` boundary. CPU-bound workers receive only ciphertext and perform their own local `withSecret()` invocation inside the worker; the plaintext `Buffer` never crosses the `postMessage()` boundary. Workers communicate back the *result* (e.g., encrypted backup blob, hash chain result), never the plaintext. This is the only safe pattern; the alternative (`SharedArrayBuffer` for plaintext) adds side-channel attack surface and is **explicitly forbidden**. ESLint `no-bare-decrypt` rule (same scope as `no-bare-drizzle`): direct `decrypt()` calls in any `workers/` file are a CI error — workers must use `withSecret()`.
- **pg-boss concurrency caps (required — prevent main-thread saturation during event storms):** each worker type registers with explicit `teamSize` and `teamConcurrency` limits:
  - `health:check` — `teamSize: 10, teamConcurrency: 5` (prevents health-check storm from starving request handling)
  - `rotation:*` — `teamSize: 3, teamConcurrency: 1` (serialized per worker instance; advisory lock provides credential-level serialization)
  - `notification:*` — `teamSize: 5, teamConcurrency: 3`
  - `audit:verify-chain` — `teamSize: 1, teamConcurrency: 1` (CPU-bound; must not compete with request path)
  - `backup:snapshot` — `teamSize: 1, teamConcurrency: 1` (CPU-bound)
  - All others — `teamSize: 5, teamConcurrency: 2` (conservative default)
- **Dead-letter queue (DLQ) monitoring:** pg-boss DLQ entries for security-sensitive job types (`rotation:*`, `audit:*`) must trigger an operational alert (pino `error`-level log + `prom-client` counter `pgboss_dlq_entries_total{job_type}`) — silent DLQ accumulation on these types indicates a production reliability problem that must not go unnoticed

**Self-hosted upgrade notification:**
- In-app notification when newer image available (checked against GHCR API on startup, cached 24h)
- Upgrade procedure: `docker compose pull && docker compose up -d` with documented in-place runbook (FR50)

### Frontend Architecture

**Framework:** SvelteKit 2 + Svelte 5 (runes-first)

**Styling:** Tailwind CSS v4 — utility-first; monitoring-mode density via tight spacing scale

**Component library:** shadcn-svelte
- Unstyled primitives (bits-ui); copy-paste model; components owned by project
- Lives in `apps/web/src/lib/components/ui/`
- Dependencies: `bits-ui`, `tailwind-variants`, `clsx`, `lucide-svelte`

**State management:** Svelte 5 Runes + module-level state
- Local state: `$state` within components
- Shared state: module-level `$state` exports from `src/lib/state/`
- SSE events update module-level state; components derive via `$derived`
- No external state library

**API client:** `openapi-fetch` typed against spec from `openapi-typescript`
- `packages/shared` Zod schemas importable in SvelteKit for client-side validation
- SvelteKit `load` functions for SSR data fetching; typed fetch for client mutations

**Routing:** SvelteKit file-based
- `(auth)/` — unauthenticated routes
- `(app)/` — authenticated routes
- `(app)/projects/[projectId]/` — project-scoped routes

### Infrastructure & Deployment

**Deployment:** Docker / Docker Compose (self-hosted primary)
- Single `docker-compose.yml`: `api` (Node.js), `web` (SvelteKit/Node adapter), `db` (PostgreSQL)
- `stop_grace_period: 30s` on `api` service
- Health/readiness endpoint: `GET /health` on API (FR81)
- Multi-arch builds: AMD64 + ARM64 via GitHub Actions matrix

**Logging:** pino (Fastify native)
- Structured JSON; log level via env var; request ID in all entries
- Operational logs only — separate from security audit log

**Metrics:** `prom-client` — Prometheus-compatible `/metrics` endpoint
- Default Node.js metrics + custom: credential fetch latency, rotation count, SSE connection count, pg-boss queue depth
- Localhost-only by default; configurable for external scraping

**CI/CD:** GitHub Actions
- On PR: lint, typecheck (after `generate-spec`), Vitest, build
- On merge to main: above + Docker multi-arch build + push to GHCR
- Turborepo remote cache via GitHub Actions cache
- `pnpm audit` on every CI run; Dependabot for dependency updates
- **`{@html}` CI gate:** `eslint-plugin-svelte` rule `svelte/no-at-html-tags` enabled as `error` — any `{@html ...}` usage is a CI failure, not a warning. Exceptions require explicit `eslint-disable` with a mandatory comment explaining why the content is safe. This rule is in `packages/eslint-config/index.js` applied to all `*.svelte` files.

**Environment configuration:** 12-factor; all config via environment variables

### Decision Impact Analysis

**Implementation Sequence (order matters):**
1. Monorepo scaffold + shared packages — **crypto versioning structure in place from this step**
2. PostgreSQL schema + RLS policies + Drizzle migrations — **`db.transaction()` wrapper established as the only permitted DB access pattern from this step; ESLint rule added**
3. `packages/crypto` — AES-256-GCM + HKDF + Argon2id; versioned ciphertext format; worker_threads wrapper for CPU-bound operations
4. Fastify auth foundation — registration, login, session, MFA, JWT, revocation table; **graceful shutdown wired from this step**
5. Sealed `SecureRoute` abstraction + RBAC + org_id middleware chain
6. pg-boss worker registration + job types; **injected EventEmitter created at startup; CPU-bound handlers use worker_threads; concurrency caps set per worker type; DLQ monitoring wired**
7. SvelteKit auth flows + SSE consumer with reconnection, Last-Event-ID, and polling fallback
8. Core credential CRUD + encryption integration
9. SSE stream endpoint + ring buffer for event replay; `generate-spec` script + Turborepo task wiring
10. Dashboard + monitoring surface (SSE consumer + polling fallback visual indicator)

**Startup sequence note:** on every API startup, after pg-boss initialises, a `rotation:recover` job is immediately enqueued **with `singletonKey: 'rotation:recover'`** (pg-boss deduplication — a second enqueue with the same singletonKey is a no-op if one is already pending or running). This prevents crash-loop stacking of multiple concurrent recovery scans, which would produce duplicate `AuditEvent.ROTATION_ABANDONED` entries for the same rotation. This job scans `rotations` where `status = 'in_progress'` and the pg-boss advisory lock for that credential is no longer held (i.e., was released by a prior crash), transitioning them to `status = 'abandoned'` and writing `AuditEvent.ROTATION_ABANDONED` entries. This ensures no credential is left permanently un-rotatable after an API restart mid-rotation.

**Cross-Component Dependencies:**
- `packages/db` ← depended on by `apps/api` and `packages/crypto` (schema types for encrypted fields)
- `packages/shared` ← depended on by `apps/api` (validation) and `apps/web` (client types + Zod schemas)
- `packages/crypto` ← depended on by `apps/api` only (server-side only)
- pg-boss workers ← depend on `packages/db` for job payload types and `packages/crypto` for secret operations
- SSE stream ← depends on injected EventEmitter shared between HTTP handlers and pg-boss workers
- `apps/web` typecheck ← depends on `api#generate-spec` via Turborepo task graph

## Implementation Patterns & Consistency Rules

### Critical Conflict Points Identified

15 areas where AI agents working independently could make incompatible choices, addressed across 4 rounds of elicitation: naming conventions, API noun/URL structure, database schema conventions, audit event type format, SSE event naming, pg-boss job naming, file/module organization, TypeScript usage patterns, Drizzle query layer ownership, error handling, loading state, date/time handling, SSE connection lifecycle, integration test setup, and commit convention.

### Naming Patterns

**Database Naming (PostgreSQL / Drizzle):**
- Table names: `snake_case` plural — `credentials`, `projects`, `audit_log_entries`
- Column names: `snake_case` — `created_at`, `org_id`, `rotation_status`
- Drizzle schema property names: `camelCase` mapped to `snake_case` via `.name()`
- Foreign keys: `{singular_table}_id` — `project_id`, `user_id`, `credential_id`
- Index names: `idx_{table}_{columns}` — e.g. `idx_credentials_org`, `idx_credentials_project_created` (columns are abbreviated to their semantic purpose, not always a literal column list)
- **Mutable tables** include: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `org_id uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`
- **Append-only / immutable tables** (`audit_log_entries`, `audit_log_operational`) include `id` and `created_at` only — no `updated_at`; immutability noted in schema file comment: `// IMMUTABLE: append-only, no updates permitted`

**Canonical Schema Entity Names (fixed — do not invent alternatives):**

| Entity | Table Name |
|---|---|
| Credentials | `credentials` |
| Credential versions | `credential_versions` |
| Credential dependencies | `credential_dependencies` |
| Rotation records | `rotations` |
| Rotation checklist items | `rotation_checklist_items` |
| Projects | `projects` |
| Users | `users` |
| Machine users | `machine_users` |
| API keys | `api_keys` |
| Sessions | `sessions` |
| Refresh tokens | `refresh_tokens` |
| Audit log (security) | `audit_log_entries` |
| Audit log (operational) | `audit_log_operational` |
| Organizations | `organizations` |
| Org members | `org_memberships` |
| Project members | `project_memberships` |

> This list covers core domain entities. Before creating a new table, verify no existing table covers the concept — check `packages/db/schema/` first.

Additional schema notes:
- `api_keys` table includes `hmac_key_version integer NOT NULL DEFAULT 1` — required for HMAC secret rotation
- Audit log tables require composite index on `(created_at DESC, id DESC)` for correct cursor pagination

**Audit Log Event Type Registry (`packages/shared/constants/audit-events.ts`):**
All audit event types are constants from this registry. Hardcoded string literals as `event_type` values are forbidden.
```typescript
export const AuditEvent = {
  CREDENTIAL_CREATED: 'credential.created',
  CREDENTIAL_VERSION_CREATED: 'credential.version_created',
  CREDENTIAL_VALUE_REVEALED: 'credential.value_revealed',
  CREDENTIAL_TAGS_UPDATED: 'credential.tags_updated',
  CREDENTIAL_VERSION_PURGED: 'credential.version_purged',
  ROTATION_INITIATED: 'rotation.initiated',
  ROTATION_CHECKLIST_ITEM_CONFIRMED: 'rotation.checklist_item_confirmed',
  ROTATION_CHECKLIST_ITEM_FAILED: 'rotation.checklist_item_failed',
  ROTATION_COMPLETED: 'rotation.completed',
  ROTATION_ABANDONED: 'rotation.abandoned',
  PROJECT_MEMBER_ROLE_CHANGED: 'project.member_role_changed',
  PROJECT_INVITATION_CREATED: 'project.invitation_created',
  ORG_USER_REMOVED: 'org.user_removed',
  ORG_USER_DEACTIVATED: 'org.user_deactivated',
  MACHINE_USER_CREATED: 'machine_user.created',
  MACHINE_USER_API_KEY_ISSUED: 'machine_user.api_key_issued',
  MACHINE_USER_API_KEY_REVOKED: 'machine_user.api_key_revoked',
  MACHINE_CACHE_ACTIVATED: 'machine_cache.activated',
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  MFA_ENROLLED: 'MFA_ENROLLED',
  MFA_RECOVERY_USED: 'MFA_RECOVERY_USED',
  LOGIN_FAILED: 'LOGIN_FAILED',
} as const
export type AuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent]
// NOTE: earlier auth/session/MFA entries keep the legacy uppercase-string value style
// (value === key); domain events (credential, project, rotation, machine_user, org, ...)
// use lowercase dot-notation values. Both styles are real and currently coexist in the
// registry — this is not a drift artifact, do not "fix" one style to match the other.
```

**API Endpoint Naming:**
- **Canonical API noun for stored credentials: `credentials`** — matches DB table; used consistently in URL paths
- **URL structure: nested under project for both human-facing and machine user fetch**
  - Human-facing CRUD: `/api/v1/projects/{projectId}/credentials/{credentialId}`
  - Machine user fetch: `GET /api/v1/machine/projects/{projectId}/credentials/{name}/value` — project scope is validated against the machine JWT's own scoped `projectId`, not read from an unscoped flat path
- Actions: POST to sub-resource — `/credentials/{credentialId}/rotations` (initiate rotation); value retrieval is `GET /credentials/{credentialId}/value` (a read, not a POST action)
- Route parameters in Fastify: camelCase — `:projectId`, `:credentialId` (never `:project_id`)
- Query parameters: camelCase — `?pageSize=20&sortBy=createdAt`

**Value Revelation Endpoint:**
```
GET /api/v1/projects/{projectId}/credentials/{credentialId}/value
→ 200: { data: { value: string, versionNumber: number, retrievedAt: string } }
```
- Requires `Member` role minimum
- Always emits `AuditEvent.CREDENTIAL_VALUE_REVEALED`; the metadata-only `GET .../credentials/{credentialId}` route does not emit any audit event (`writeAuditEvent: false`) — only the `/value` route is audited
- `GET .../credentials/{credentialId}` never returns plaintext value — metadata only
- Frontend value displayed in-memory only, cleared on navigation
- **`withSecret()` → HTTP response pattern (the ONE documented exception to the zeroing rule):** the reveal service calls `withSecret(encryptedValue, async (plaintext: Buffer) => { return plaintext.toString('utf8') })`. The returned string is assigned to the `value` field inside `{ data: { value, versionNumber, retrievedAt } }` and sent immediately by Fastify. Converting to string here is **explicitly permitted and documented** — the plaintext string lives only for the duration of HTTP response serialization, then becomes GC-eligible. This is the only call site where `Buffer → string` conversion is sanctioned; it must carry a `// revelation path: Buffer→string permitted here` comment. `SecretValue` wrapper is not used on the revelation path because the value flows directly to the response and must be a string. All other call sites that receive a `Buffer` from `withSecret()` must not convert to string.

**SSE Event Naming:**
- Format: `{domain}.{event-type}` — two parts, dot-separated, lowercase
- Three parts only when sub-entity disambiguates: `project.health.changed`, `credential.expiry.warning`
- Two parts for domain-level events: `rotation.completed`, `alert.fired`
- Payload envelope: `{ event, id, projectId, timestamp: ISO8601, data: T }`

**pg-boss Job Naming:**
- Format: `{domain}:{action}` — colon-separated, lowercase
- Examples: `health:check`, `rotation:schedule`, `rotation:recover`, `notification:email`, `backup:snapshot`, `session:cleanup`

**API Key Format:**
- `pk_` prefix + `crypto.randomBytes(32).toString('base64url')` — 46 chars total
- Storage: HMAC-SHA256 (NOT Argon2id — see Token Hashing below)
- Shown once at creation; thereafter only last 8 chars displayed

**Date Range Query Parameters:**
- Standardized: `?from=<ISO8601Z>&to=<ISO8601Z>` — always with Z timezone designator
- Default lookback when `from` omitted: last 30 days (never unbounded)
- Export endpoints require explicit `from` AND `to` — 400 if missing
- Maximum export range: 366 days per request

**Commit Convention (Conventional Commits):**
- `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Breaking: `feat!:` or `BREAKING CHANGE:` footer
- Scope optional: `feat(rotation): add mid-rotation dependency discovery`
- Enforced by `commitlint` in CI; required for changelog generation and version tagging

### Structure Patterns

**Backend Module Organization (`apps/api/src/`):**
```
modules/{feature}/
  routes.ts      # Fastify route registration — owns withOrg() call
  service.ts     # Business logic — accepts tx: Tx as first param
  schema.ts      # Zod schemas (or imported from packages/shared)
  repository.ts  # Drizzle queries — accepts tx: Tx as first param
plugins/         # Fastify plugins (auth, rate-limit, swagger)
workers/         # pg-boss job handlers (one file per job type)
lib/
  events.ts      # Injected EventEmitter + emitSseEvent() helper
  errors.ts      # AppError class
  shutdown.ts    # Graceful shutdown sequence
  config.ts      # Validated config — only process.env access point
```

**Frontend Organization (`apps/web/src/`):**
```
routes/
  (auth)/                          # Login, MFA, recovery
  (app)/
    +layout.svelte                 # Establishes SSE connection (onMount)
    +layout.server.ts              # Auth gate for all (app) routes
    projects/[projectId]/
      credentials/[credentialId]/
lib/
  components/ui/                   # shadcn-svelte base components
  components/{feature}/            # Feature-specific composed components
  state/
    auth.svelte.ts
    sse.svelte.ts                  # Single session SSE connection + onSseEvent()
    notifications.svelte.ts
  api/                             # openapi-fetch typed client
  utils/                           # Pure utility functions
```

**Test Organization:**
- Unit tests: co-located `*.test.ts` next to the file under test
- Integration tests: `apps/api/src/__tests__/` — always use `withTestOrg()` helper
- E2E: `apps/web/e2e/` — Playwright

### Format Patterns

**API Response Formats:**

Single resource (200): direct object, no wrapper
Collection — page-based (default for all except audit log):
```typescript
{ data: T[], meta: { total: number, page: number, pageSize: number, hasMore: boolean } }
```
Collection — cursor-based (**required for audit log endpoints**):
```typescript
{ data: T[], meta: { nextCursor: string | null, hasMore: boolean, limit: number } }
```
Created (201): same as GET response shape, plus any `revealed*` fields
No content (204): empty body

**Cursor Format:**
- Compound: `base64url(JSON.stringify({ id, createdAt }))` — never simple `base64url(id)`
- Simple ID cursor fails for time-ordered tables when records share a millisecond timestamp
- Page query uses PostgreSQL row comparison: `WHERE (created_at, id) < ($ct, $id)`
- Requires composite index `(created_at DESC, id DESC)` on every cursor-paginated table

**One-Time Secret `revealed` Convention:**
- `revealed*` fields exist ONLY in Zod response schemas — never in Drizzle table schemas
- Service layer computes and adds them to the return object before serialization
- Frontend shows "copy and save" UI for any `revealed*` field
```typescript
// Correct: Zod response schema only
export const MachineUserCreatedSchema = MachineUserSchema.extend({
  revealedApiKey: z.string()  // NOT a DB column — computed value
})
```

**Date/Time:** ISO 8601 with Z suffix — `"2026-05-28T10:00:00Z"`; never Unix timestamps
**JSON Fields:** camelCase in API; snake_case in DB (mapped by Drizzle)

**Integrity Verification Endpoint:**
```
GET /api/v1/audit-log/verify
→ { verified: boolean, entryCount: number, firstEntryId: string, lastEntryId: string,
    lastHash: string, verifiedAt: string, durationMs: number }
```
On failure: `{ verified: false, firstFailedEntryId: string, ... }`
This is the ONLY integrity verification endpoint.

**CSV Export Column Naming:** camelCase headers, ISO 8601 timestamps, `true`/`false` booleans

### Communication Patterns

**SSE Event Types (two interfaces — never conflate):**
```typescript
// Server-internal (includes orgId for filtering)
interface SseEventInternal<T> { event: string; id: string; orgId: string; projectId: string; timestamp: string; data: T }
// Client-facing (orgId excluded structurally)
interface SseEventPayload<T> { event: string; id: string; projectId: string; timestamp: string; data: T }
// Serialization: always use toClientPayload() — never JSON.stringify(internalEvent)
function toClientPayload<T>({ orgId, ...rest }: SseEventInternal<T>): SseEventPayload<T> { return rest }
```

**SSE Payload Registry (`packages/shared/schemas/sse-payloads.ts`):**
```typescript
export interface SsePayloadMap {
  'project.health.changed': HealthChangedPayload
  'credential.expiry.warning': CredentialExpiryPayload
  'rotation.step.confirmed': RotationStepPayload
  'rotation.completed': RotationCompletedPayload
  'alert.fired': AlertFiredPayload
  // Add new event types here BEFORE implementing the emitter
}
```

**Typed SSE Emission (ONLY permitted emit path):**
```typescript
export function emitSseEvent<K extends keyof SsePayloadMap>(
  emitter: EventEmitter, event: K, projectId: string, orgId: string, data: SsePayloadMap[K]
): void { emitter.emit('sse', { event, id: nextEventId(), orgId, projectId, timestamp: new Date().toISOString(), data }) }
// Anti-pattern: emitter.emit('rotation.completed', ...) directly
```

**SSE Connection Lifecycle (SvelteKit):**
One connection per authenticated session — established in `(app)/+layout.svelte` `onMount`,
stored in `src/lib/state/sse.svelte.ts`. Individual pages call `onSseEvent()` to subscribe
and return the cleanup function in `onDestroy`. Pages never create `new EventSource()` directly.

**pg-boss Job Payload Structure:**
```typescript
interface JobPayload<T = unknown> { orgId: string; data: T }
// Every job payload includes orgId — worker sets SET LOCAL at transaction start
```

**Module-Level State (Svelte 5 Runes):**
```typescript
// .svelte.ts files only — never export raw $state
let items = $state<Item[]>([])
export function getItems() { return items }
export function addItem(i: Item) { items = [...items, i] }
```

### Process Patterns

**Layer Ownership of `withOrg()`:**
Route handler calls `withOrg()` and passes `tx` down. Service and repository functions
accept `tx: Tx` as first parameter — never call `withOrg()` themselves.
```typescript
// ✅ Route handler owns transaction boundary
fastify.get('/projects/:projectId/credentials/:id', async (req, reply) =>
  withOrg(req.authContext.orgId, (tx) => credentialsService.getById(tx, req.params.id, req.params.projectId))
)
// ✅ Service accepts tx
async function getById(tx: Tx, credentialId: string, projectId: string): Promise<CredentialRecord>
// ❌ Service calling withOrg() — nested transaction, wrong ownership
```

**Rotation Advisory Lock — Failure Response:**
When `pg_try_advisory_lock()` returns false (another rotation is already in progress on the same credential), the rotation service must immediately return a structured `409 Conflict` response — no queuing, no waiting:
```typescript
// Rotation lock acquisition failure — explicit 409, not a generic error
throw new AppError('ROTATION_IN_PROGRESS', 'A rotation is already in progress for this credential. Complete or abandon it before initiating a new one.', 409)
// Response shape: { error: 'ROTATION_IN_PROGRESS', message: '...', statusCode: 409, requestId: string }
```
The frontend rotation UI must handle `ROTATION_IN_PROGRESS` explicitly — show the current rotation's status and direct the user to the checklist, not a generic error toast.

**Database Access Helpers (three — use the right one):**
```typescript
withOrg(orgId, fn)           // Standard: org-scoped, all normal operations
withOrgReadScope(orgId, fn)  // Read-only cross-scope: display queries (Admin+), e.g. scope visualization
withAdminAccess(authCtx, fn) // Full bypass: OrgAdmin write operations; throws if !authCtx.isOrgAdmin
```

**Error Handling:**
```typescript
export class AppError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message) }
}
// Error handler checks: AppError → code/message/statusCode; ZodError → VALIDATION_ERROR with issues array; unknown → 500 generic
// Validation error response: { error: 'VALIDATION_ERROR', message: '...', statusCode: 400, requestId: string, issues: [{field, message}] }
```

**Token Hashing vs Password Hashing:**
```typescript
// Passwords (Argon2id): memoryCost: 65536, timeCost: 3, parallelism: 4
// API keys / tokens (HMAC-SHA256): fast, sufficient for 256-bit entropy, no brute-force surface
const hash = createHmac('sha256', config.apiKeyHmacSecret).update(apiKey).digest('hex')
// api_keys.hmac_key_version enables rotation without simultaneous invalidation
// HMAC secret is per-environment — config validation rejects defaults in production
```

**Integration Test Database Setup:**
```typescript
// packages/db/test-helpers.ts
export async function withTestOrg<T>(fn: (ctx: { orgId: string; tx: Tx }) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const orgId = crypto.randomUUID()
    await tx.execute(sql`SET LOCAL app.current_org_id = ${orgId}`)
    await tx.insert(organizations).values({ id: orgId, name: 'test-org' })
    return fn({ orgId, tx })
    // Transaction auto-rolls-back — no manual cleanup
  })
}
// RLS is ALWAYS active in integration tests — never disable
```

**Loading State:** `isLoading` for fetches; `is{Action}ing` for mutations; always reset in `finally`
**Validation Timing:** backend via Fastify+Zod before any business logic; frontend on blur + submit

### Enforcement Guidelines

**All AI Agents MUST:**
- Use `withOrg()` only in route handlers — pass `tx` to service/repository
- Use `AuditEvent.*` constants — never hardcoded event type strings
- Use compound cursor `base64url({id, createdAt})` — never `base64url(id)` alone
- Use `emitSseEvent()` helper — never `emitter.emit()` directly
- Add SSE event types to `SsePayloadMap` before implementing
- Add audit event types to `AuditEvent` before implementing
- Use `withOrgReadScope()` for display queries needing all-org data (Admin+)
- Use `withAdminAccess(authContext, fn)` for OrgAdmin write operations
- Keep `revealed*` fields ONLY in Zod schemas — never in Drizzle schemas
- Use per-environment `apiKeyHmacSecret` — config validation rejects defaults in prod
- Use `request.log` / `fastify.log` — never `console.log`
- Access `process.env` only in `apps/api/src/config.ts` — never inline
- Use cursor-based pagination for audit log; page-based for all others
- Apply Conventional Commits format on every commit
- Use `withTestOrg()` in all integration tests — RLS always active
- **Treat the ESLint `no-bare-drizzle` rule and `withTestOrg()` integration tests as a paired enforcement mechanism:** the lint rule catches omissions at build time; RLS-active integration tests catch bypasses at test time. Neither is sufficient alone.
- **Route audit integration test (`apps/api/src/__tests__/route-audit.test.ts`):** The `SecureRoute` factory maintains a **module-level `secureRoutes: Set<string>`** (exported from `apps/api/src/lib/secure-route.ts`). Each time `SecureRoute` registers a route, it adds the route's method+path to this set. The `route-audit.test.ts` initializes the app with mocked I/O (same approach as `generate-spec.ts`), retrieves the generated OpenAPI spec (via `app.inject({ method: 'GET', url: '/documentation/json' })`), extracts all paths under `/api/v1/`, and asserts that every path (except `/health`, `/metrics`, `/api/v1/auth/*`) appears in `secureRoutes`. Any route registered outside `SecureRoute` will be present in the OpenAPI spec but absent from `secureRoutes` — the test fails. This approach uses only stable public APIs (`@fastify/swagger` output + exported module state), not Fastify internals.
- **Use `withSecret(encryptedValue, async (plaintext: Buffer) => { ... })` for ALL secret decryption** — bare `decrypt()` returning a string is forbidden; plaintext must never escape the callback; `withSecret()` zeros the buffer in `finally`; converting `plaintext` to a JS string inside the callback forfeits zeroing for that copy — document at call site
- **Validate health check endpoint URLs at registration time** — reject RFC1918 private ranges (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local (169.254/16), IPv6 equivalents, and cloud metadata addresses (169.254.169.254); re-validate resolved IP at check time (DNS rebinding); never store health check response body — only `{ statusCode, latencyMs, checkedAt, isHealthy }`
- **Store web session JWTs in `httpOnly; Secure; SameSite=Strict` cookies only** — never Authorization header for browser sessions, never localStorage

**Anti-Patterns (explicitly forbidden):**
- Bare `db.select()` / `db.insert()` outside `withOrg()` / `withOrgReadScope()` / `withAdminAccess()`
- `withOrg(null, fn)` or `withOrg(undefined, fn)` — use `withAdminAccess()`
- `any` type — use `unknown` and narrow
- Exporting raw `$state` from state modules — always via getter/setter functions
- Auth checks in SvelteKit component `onMount` — always in layout/page server files
- Inline Zod schemas for API contracts — import from `packages/shared` (exception: internal-only schemas)
- Silent error swallowing in `catch` blocks
- Unix timestamps in API responses — ISO 8601 only
- Hardcoded `org_id` in queries — always from `AuthContext` or job payload
- `console.log` / `console.error` — use injected pino logger
- `process.env` access outside `config.ts`
- `{@html}` with user-controlled content — use text interpolation `{value}`
- Hardcoded audit event type strings — use `AuditEvent.*` constants
- `revealed*` columns in Drizzle schemas — phantom response fields only
- `emitter.emit('event.name', ...)` directly — use `emitSseEvent()`
- Argon2id for API key / token hashing — HMAC-SHA256 for high-entropy tokens
- `base64url(id)` as cursor for time-ordered tables — use compound cursor
- `new EventSource()` in individual SvelteKit page components
- Missing `withTestOrg()` in integration tests (RLS bypass in tests)
- **`sql\`` template literals outside `withOrg()`/`withOrgReadScope()`/`withAdminAccess()`** — the `no-bare-drizzle` ESLint rule covers both ORM helpers and raw `sql\`` usage; **rule scope: `apps/api/src/**` and `apps/web/src/**` only — not `packages/db/**`** (where the safe abstractions are implemented using these primitives legitimately)
- **Bare `decrypt()` calls returning a `string`** — always use `withSecret()`; plaintext must not escape the callback scope
- **Direct `decrypt()` calls in `workers/` files** — `no-bare-decrypt` ESLint rule: `packages/eslint-config/no-bare-decrypt.js`, applied in `packages/eslint-config/index.js` to glob `apps/api/src/**/*.ts` excluding `packages/crypto/**`; any direct `decrypt()` call in `workers/**` or outside `packages/crypto/**` is a CI error; workers receive ciphertext and call `withSecret()` locally — plaintext never crosses `postMessage()` boundary. **Scope extends to audit log export path:** `AuditLogDecryptedEntry` type in `packages/crypto/types.ts` wraps any decrypted audit field — not only raw secret values — and overrides `toJSON()`/`toString()`/`[Symbol.for('nodejs.util.inspect.custom')]` identically to `SecretValue`. The export worker must use `AuditLogDecryptedEntry` for any decoded audit content that flows through formatting/CSV steps.
- **Storing response body from health check probes** — only status code, latency, and result boolean are stored
- **Registering health check endpoints with private/loopback/metadata IP ranges** — SSRF vector; validated and rejected at registration
- **`{@html}` with any content** — `svelte/no-at-html-tags` is a CI error; exceptions require explicit disable comment with justification
- **Enforcing MFA at the route handler level** — MFA role check (`OrgAdmin`/`Owner` require `mfa_enrolled_at IS NOT NULL`) belongs in auth middleware, not individual route handlers; check once, enforce everywhere
- **Missing RLS policy in new table migrations** — every migration that creates a new mutable table (with `org_id`) must include the `CREATE POLICY` statement in the **same migration file**; a table deployed without RLS is immediately accessible cross-org. Enforcement: `packages/db/scripts/check-rls-coverage.ts` — reads all Drizzle schema files, collects `org_id` tables, queries `information_schema.policies`, fails CI if any `org_id` table has no RLS policy. Runs as the `db#check-rls` Turborepo task, required before `db#migrate`. Exceptions (`sessions`, `refresh_tokens`) must be explicitly listed in the script's allow-list.

## Project Structure & Boundaries

### Requirements to Structure Mapping

| FR Category | Backend Module | Frontend Route | Workers |
|---|---|---|---|
| Project & Org Management | `modules/projects/`, `modules/organizations/` | `(app)/projects/`, `(app)/admin/` | — |
| Secret & Credential Management | `modules/credentials/` | `(app)/projects/[id]/credentials/` | — |
| Rotation & Propagation | `modules/rotation/` | `(app)/projects/[id]/credentials/[id]/rotation/` | `workers/rotation-reminder.ts` |
| Operational Monitoring & Alerts | `modules/monitoring/` | `(app)/projects/[id]/services/`, `(app)/projects/[id]/assets/` | `workers/health-check.ts`, `workers/credential-expiry-alert.ts`, `workers/cert-expiry-alert.ts`, `workers/domain-expiry-alert.ts`, `workers/payment-expiry-alert.ts` |
| Machine User Access | `modules/machine-users/` | `(app)/projects/[id]/machine-users/` | `workers/api-key-expiry.ts` |
| Audit & Compliance | `modules/audit/`, `modules/compliance/` | `(app)/audit/`, `(app)/admin/compliance/` | `workers/audit-verify.ts` |
| Platform & Integration | `modules/integrations/`, `plugins/` | `(app)/admin/integrations/` | `workers/notification-email.ts`, `workers/notification-slack.ts` |
| Security & Authentication | `modules/auth/` | `(auth)/login/`, `(auth)/mfa/` | `workers/session-cleanup.ts` |
| System Administration | `modules/admin/` | `(app)/admin/` | `workers/backup-snapshot.ts` |
| Project Dashboard (FR93) | `modules/dashboard/` | `(app)/projects/[id]/+page.svelte` (IS the dashboard) | — |
| Notification Preferences | `modules/notifications/` | `(app)/settings/notifications/` | — |
| Backup & Restore | `modules/backup/` | `(app)/admin/backup/` | `workers/backup-snapshot.ts` |
| Org Health (Buyer View) | `modules/org-health/` | `(app)/org-health/` | `workers/org-health-snapshot.ts` |
| Compliance Reporting | `modules/compliance/` | `(app)/admin/compliance/` | — |

### Canonical Schema Entity Names (complete)

| Entity | Table Name | Notes |
|---|---|---|
| Credentials | `credentials` | Core credential storage |
| Credential versions | `credential_versions` | Immutable — no `updated_at` |
| Credential dependencies | `credential_dependencies` | Systems depending on a credential |
| Rotation records | `rotations` | One per initiated rotation |
| Rotation checklist items | `rotation_checklist_items` | Per-system confirmation records |
| Projects | `projects` | Primary org unit |
| Users | `users` | Human users; includes `mfa_enrolled_at` |
| MFA enrollments | `mfa_enrollments` | TOTP devices; supports future multi-device |
| Machine users | `machine_users` | CI/CD + service identities |
| API keys | `api_keys` | Hashed; includes `hmac_key_version integer NOT NULL DEFAULT 1` |
| Sessions | `sessions` | JWT revocation; `(id uuid PK, jti text UNIQUE NOT NULL, user_id uuid FK, expires_at timestamptz, revoked_at timestamptz)` — one row per issued JWT; new row on each silent refresh. **No `org_id` — RLS exception (see below).** |
| Refresh tokens | `refresh_tokens` | `(id uuid PK, session_id uuid FK → sessions.id, token_hash text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, new_session_id uuid FK → sessions.id, revoked_at timestamptz)` — one row per issued token. **Grace window pattern:** on refresh, set `used_at = now()` and `new_session_id` before issuing new tokens; retry within 30s of `used_at` re-issues same new tokens (idempotent); after 30s, `used` becomes `revoked`. `session:cleanup` worker removes rows where `expires_at < now() - interval '1 day'`. **No `org_id` — RLS exception (see below).** |
| Audit log (security) | `audit_log_entries` | Immutable — no `updated_at`; composite index `(created_at DESC, id DESC)` |
| Audit log (operational) | `audit_log_operational` | Background events; independent retention |
| Organizations | `organizations` | Org/tenant root |
| Org members | `org_memberships` | User ↔ org association |
| Project members | `project_memberships` | User/machine-user ↔ project + role |
| Service health endpoints | `service_endpoints` | HTTP uptime monitoring |
| SSL/TLS cert records | `cert_records` | Includes `alert_threshold_days integer NOT NULL DEFAULT 30` |
| Domain renewal records | `domain_records` | Includes `alert_threshold_days integer NOT NULL DEFAULT 30` |
| Payment/subscription records | `payment_records` | Includes `alert_threshold_days integer NOT NULL DEFAULT 30` |
| Org health snapshots | `org_health_snapshots` | Pre-computed; refreshed every 30 min via pg-boss |

All mutable tables include `id`, `org_id`, `created_at`, `updated_at`.
Immutable tables (`audit_log_entries`, `audit_log_operational`, `credential_versions`) include `id` and `created_at` only — no `updated_at`. Schema file comment: `// IMMUTABLE: append-only`.

**RLS exception tables — `sessions` and `refresh_tokens`:**
These tables are identity-scoped (not org-scoped). A user may belong to multiple orgs; a session/refresh token is valid across all of them. Adding `org_id` would either require per-org tokens (breaking the single-session model) or be semantically incorrect. These tables **do not carry `org_id`** and are **not subject to org RLS policies**. Access is exclusively via direct key lookup (`WHERE jti = $jti` or `WHERE token_hash = $hash`) in `modules/auth/service.ts` using `withAdminAccess()`. No other module may query these tables directly.

**Required indexes (declare in migration alongside schema):**
- `sessions.jti` — UNIQUE constraint auto-creates index; used by per-request revocation check ✅
- `idx_sessions_expires_at` on `sessions(expires_at)` — `session:cleanup` worker range scan
- `idx_sessions_user_id` on `sessions(user_id)` — logout-all-sessions query
- `idx_refresh_tokens_session_id` on `refresh_tokens(session_id)` — FK join; PostgreSQL does not auto-index FKs
- `idx_refresh_tokens_expires_at` on `refresh_tokens(expires_at)` — `session:cleanup` worker range scan
- `idx_refresh_tokens_token_hash` on `refresh_tokens(token_hash)` — refresh endpoint lookup (if not UNIQUE constraint)

### Complete Project Directory Structure

```
project-vault/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                    # lint, typecheck, generate-spec freshness, test, build
│   │   └── release.yml               # multi-arch Docker build + GHCR push on main
│   └── dependabot.yml
├── apps/
│   ├── api/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── tsconfig.json             # includes: ["src/**/*"]; typeRoots: ["./src/@types", "./node_modules/@types"]
│   │   ├── .env.example
│   │   ├── .env.test                 # not committed — DATABASE_URL, VAULT_MASTER_KEY, API_KEY_HMAC_SECRET, SESSION_SECRET
│   │   └── src/
│   │       ├── main.ts               # Startup order: createEventEmitter → createRingBuffer(emitter)
│   │       │                         # → register ssePlugin({ringBuffer}) → registerWorkers(emitter)
│   │       │                         # → fastify.listen() + SIGTERM graceful shutdown wiring
│   │       ├── app.ts                # Plugin registration, route mounting
│   │       ├── config.ts             # ONLY process.env access point; validates all required vars at startup
│   │       ├── scripts/
│   │       │   └── generate-spec.ts  # Dry-run Fastify init (mocked I/O) → packages/shared/openapi.json
│   │       ├── @types/
│   │       │   └── fastify.d.ts      # FastifyRequest augmentation: authContext: AuthContext
│   │       ├── plugins/
│   │       │   ├── auth.ts           # JWT verification + session lookup → populates request.authContext
│   │       │   ├── rate-limit.ts
│   │       │   ├── swagger.ts        # @fastify/swagger — reads routes, generates OpenAPI spec
│   │       │   └── sse.ts            # Thin SSE route — delegates to lib/sse-ring-buffer.ts
│   │       ├── modules/
│   │       │   ├── auth/
│   │       │   │   ├── routes.ts     # POST /auth/login, /auth/logout, /auth/refresh
│   │       │   │   ├── service.ts
│   │       │   │   ├── mfa.ts        # TOTP enroll, verify, recovery codes (otpauth)
│   │       │   │   └── schema.ts
│   │       │   ├── projects/
│   │       │   │   ├── routes.ts     # CRUD + members + archive
│   │       │   │   ├── service.ts
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── credentials/
│   │       │   │   ├── routes.ts     # CRUD + GET .../value + import (.env, JSON)
│   │       │   │   ├── service.ts
│   │       │   │   ├── service.test.ts  # co-located unit test (pattern example)
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── rotation/
│   │       │   │   ├── routes.ts     # initiate, checklist CRUD, complete, abandon
│   │       │   │   ├── service.ts    # rotation state machine; uses withRotationLock()
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── monitoring/
│   │       │   │   ├── routes.ts     # service_endpoints, cert_records, domain_records, payment_records
│   │       │   │   │                 # SSRF GUARD: URL validation on service_endpoint registration —
│   │       │   │   │                 # reject private RFC1918, loopback, link-local, cloud metadata ranges at write time
│   │       │   │   ├── service.ts
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── machine-users/
│   │       │   │   ├── routes.ts     # CRUD, API key issue/revoke (pk_ + base64url + HMAC-SHA256)
│   │       │   │   ├── service.ts
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── audit/
│   │       │   │   ├── routes.ts     # filter, cursor-paginated list, GET .../verify, export
│   │       │   │   ├── service.ts    # audit READ path only; compliance/ imports these functions
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── org-health/       # Org-level health snapshot (owner/admin access)
│   │       │   │   ├── routes.ts     # GET /api/v1/organizations/{orgId}/health
│   │       │   │   ├── service.ts    # Reads org_health_snapshots; imports lib/org-queries.ts
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── compliance/       # SOC2/ISO evidence; OrgAdmin only
│   │       │   │   ├── routes.ts     # GET /api/v1/organizations/{orgId}/compliance-summary
│   │       │   │   ├── service.ts    # Imports audit/service.ts + lib/org-queries.ts; no own queries
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── dashboard/        # Per-project real-time operational views ONLY
│   │       │   │   ├── routes.ts     # GET /projects/{id}/dashboard, /health-status
│   │       │   │   ├── service.ts    # Aggregates: credential status, service health, rotation queue
│   │       │   │   └── schema.ts     # BOUNDARY: real-time + project-scoped only
│   │       │   ├── organizations/
│   │       │   │   ├── routes.ts
│   │       │   │   ├── service.ts
│   │       │   │   ├── repository.ts
│   │       │   │   └── schema.ts
│   │       │   ├── notifications/
│   │       │   │   ├── routes.ts
│   │       │   │   ├── service.ts
│   │       │   │   └── schema.ts
│   │       │   ├── admin/            # System config only (SMTP, settings, resource usage)
│   │       │   │   ├── routes.ts
│   │       │   │   └── schema.ts
│   │       │   ├── backup/           # Flat module (not nested under admin/)
│   │       │   │   ├── routes.ts     # POST /admin/backup/trigger, GET /admin/backup/status
│   │       │   │   ├── service.ts    # Delegates to packages/crypto/workers/backup-encrypt.worker.ts
│   │       │   │   └── schema.ts
│   │       │   └── integrations/
│   │       │       ├── github-actions/
│   │       │       │   ├── routes.ts # POST /api/v1/integrations/github-actions/token
│   │       │       │   ├── service.ts # OIDC JWT verification + machine user token issuance
│   │       │       │   └── schema.ts
│   │       │       └── gitlab-ci/
│   │       │           ├── routes.ts # POST /api/v1/integrations/gitlab-ci/token
│   │       │           ├── service.ts
│   │       │           └── schema.ts
│   │       ├── workers/
│   │       │   ├── index.ts                      # Registers all workers at startup
│   │       │   ├── health-check.ts               # health:check
│   │       │   ├── credential-expiry-alert.ts    # monitoring:credential-expiry
│   │       │   ├── cert-expiry-alert.ts          # monitoring:cert-expiry
│   │       │   ├── domain-expiry-alert.ts        # monitoring:domain-expiry
│   │       │   ├── payment-expiry-alert.ts       # monitoring:payment-expiry
│   │       │   ├── rotation-reminder.ts          # rotation:reminder
│   │       │   ├── rotation-recover.ts           # rotation:recover — runs on startup; scans stale in_progress rotations where advisory lock is no longer held; transitions to abandoned + AuditEvent.ROTATION_ABANDONED
│   │       │   ├── api-key-expiry.ts             # monitoring:api-key-expiry
│   │       │   ├── notification-email.ts         # notification:email
│   │       │   ├── notification-slack.ts         # notification:slack
│   │       │   ├── session-cleanup.ts            # session:cleanup (OrgJobPayload — no projectId)
│   │       │   ├── org-health-snapshot.ts        # org:health-snapshot (every 30 min)
│   │       │   ├── backup-snapshot.ts            # backup:snapshot — CPU-bound → worker_threads
│   │       │   └── audit-verify.ts               # audit:verify-chain — CPU-bound → worker_threads
│   │       ├── lib/
│   │       │   ├── errors.ts
│   │       │   ├── events.ts                     # createEventEmitter() + emitSseEvent() helper
│   │       │   ├── shutdown.ts                   # SIGTERM → SSE close → pgBoss.stop → fastify.close
│   │       │   ├── secure-route.ts               # SecureRoute factory; rbac (project) + orgRole (org); exports secureRoutes: Set<string> — populated on each route registration; used by route-audit.test.ts
│   │       │   ├── sse-ring-buffer.ts            # createRingBuffer(emitter); last 100 events, 60s TTL
│   │       │   ├── audit-writer.ts               # writeAuditEntry(tx, entry) — internal write path only
│   │       │   └── org-queries.ts                # getMfaCoverage(), getExpiringAssetsAcrossOrg(),
│   │       │                                     # getUserAccessSummary() — shared by org-health + compliance
│   │       └── __tests__/                        # Integration tests (withTestOrg) — NOT unit tests
│   │           ├── auth.test.ts
│   │           ├── credentials.test.ts
│   │           ├── rotation.test.ts
│   │           ├── audit.test.ts
│   │           └── route-audit.test.ts           # Enumerates all /api/v1/ routes; asserts SecureRoute marker on each; CI guard against unsecured route registration
│   │
│   └── web/
│       ├── Dockerfile
│       ├── package.json
│       ├── svelte.config.js
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       ├── tsconfig.json
│       ├── .env.example
│       ├── playwright.config.ts              # globalSetup: './e2e/global-setup.ts'
│       ├── e2e/
│       │   ├── .env.test                     # API startup secrets for E2E test server (not committed)
│       │   ├── global-setup.ts               # Loads e2e/.env.test → starts API → runs migrations → seeds
│       │   ├── global-teardown.ts
│       │   ├── fixtures/
│       │   │   ├── auth.ts                   # Authenticated session state
│       │   │   └── test-data.ts              # Pre-created project + credentials
│       │   ├── pages/
│       │   │   ├── DashboardPage.ts
│       │   │   └── CredentialDetailPage.ts
│       │   ├── auth.spec.ts
│       │   ├── dashboard.spec.ts
│       │   └── rotation.spec.ts
│       └── src/
│           ├── app.html
│           ├── app.css
│           ├── hooks.server.ts
│           ├── routes/
│           │   ├── (auth)/
│           │   │   ├── +layout.svelte
│           │   │   ├── login/
│           │   │   ├── mfa/
│           │   │   └── recovery/
│           │   └── (app)/
│           │       ├── +layout.svelte          # SSE connection init (onMount); one per session
│           │       ├── +layout.server.ts        # Auth gate for all (app) routes
│           │       ├── dashboard/               # Cross-project health overview
│           │       ├── org-health/              # Buyer entry point; Owner/Admin+ access (no OrgAdmin gate)
│           │       │   ├── +page.svelte
│           │       │   └── +page.server.ts
│           │       ├── projects/
│           │       │   └── [projectId]/
│           │       │       ├── +layout.server.ts
│           │       │       ├── +page.svelte     # IS the project dashboard (FR93) — not a sub-route
│           │       │       ├── credentials/
│           │       │       │   ├── +page.svelte
│           │       │       │   └── [credentialId]/
│           │       │       │       ├── +page.svelte    # Detail + reveal button
│           │       │       │       └── rotation/
│           │       │       ├── services/               # HTTP service health monitoring ONLY
│           │       │       ├── assets/                 # Cert, domain, payment expiry tracking
│           │       │       │   ├── +page.svelte
│           │       │       │   └── new/+page.svelte
│           │       │       ├── machine-users/
│           │       │       └── settings/
│           │       ├── audit/
│           │       ├── admin/
│           │       │   ├── +layout.server.ts    # OrgAdmin gate
│           │       │   ├── +page.svelte         # System administration
│           │       │   ├── users/
│           │       │   ├── backup/
│           │       │   ├── compliance/          # SOC2/ISO reporting (OrgAdmin only)
│           │       │   └── settings/
│           │       └── settings/
│           └── lib/
│               ├── components/
│               │   ├── ui/                       # shadcn-svelte base components
│               │   ├── dashboard/                # MonitoringCard, AlertBanner, StatusIndicator
│               │   ├── credentials/               # CredentialCard, RevealButton, ImportWizard
│               │   ├── rotation/                 # RotationChecklist, ChecklistItem, RotationProgress
│               │   ├── machine-users/            # ScopeVisualizer
│               │   ├── audit/                    # AuditLogTable (cursor-paginated), IntegrityVerifyButton
│               │   └── onboarding/               # ProjectWizard (bypass-proof first-run)
│               ├── state/
│               │   ├── auth.svelte.ts
│               │   ├── sse.svelte.ts             # Single SSE connection + onSseEvent()
│               │   └── notifications.svelte.ts
│               ├── api/
│               │   └── client.ts                 # openapi-fetch typed client
│               └── utils/
│                   ├── dates.ts
│                   └── format.ts
│
├── packages/
│   ├── db/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts
│   │   ├── index.ts                  # withOrg, withOrgReadScope, withAdminAccess, withRotationLock, Tx type
│   │   ├── test-helpers.ts           # withTestOrg, withTestAdminAccess
│   │   ├── schema/
│   │   │   ├── organizations.ts
│   │   │   ├── users.ts              # includes mfa_enrollments relation
│   │   │   ├── projects.ts
│   │   │   ├── credentials.ts        # credentials
│   │   │   ├── credential-versions.ts      # credential_versions (separate file — not merged into credentials.ts)
│   │   │   ├── credential-dependencies.ts  # credential_dependencies
│   │   │   ├── rotations.ts          # rotations + rotation_checklist_items
│   │   │   ├── monitoring.ts         # service_endpoints, cert_records, domain_records, payment_records
│   │   │   │                         # all monitoring tables include alert_threshold_days INT DEFAULT 30
│   │   │   ├── machine-users.ts      # machine_users + api_keys (hmac_key_version)
│   │   │   ├── audit.ts              # audit_log_entries (IMMUTABLE) + audit_log_operational
│   │   │   ├── notifications.ts
│   │   │   ├── sessions.ts
│   │   │   └── org-health.ts         # org_health_snapshots
│   │   └── migrations/               # Each migration includes DDL + CREATE POLICY — no separate rls/
│   │       ├── 0001_init.sql
│   │       └── ...
│   │
│   ├── crypto/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── index.ts                  # withSecret, SecretValue, deriveKey, hashPassword, verifyPassword, hashToken, verifyToken
│   │   │                             # NOTE: bare decrypt() is NOT exported — all callers use withSecret()
│   │   ├── aes.ts                    # AES-256-GCM; versioned ciphertext: { version, iv, ciphertext, tag }; internal only
│   │   ├── secret-value.ts           # SecretValue wrapper; toJSON/toString/inspect → '[REDACTED]'; withSecret() helper
│   │   ├── kdf.ts                    # HKDF; master key + audit log derived key
│   │   ├── passwords.ts              # Argon2id (memoryCost:65536, timeCost:3, parallelism:4)
│   │   ├── tokens.ts                 # HMAC-SHA256 for API keys; hmac_key_version support; dual-key rotation
│   │   └── workers/
│   │       ├── backup-encrypt.worker.ts   # CPU-bound; referenced via dist/ path by apps/api workers
│   │       └── audit-hash.worker.ts       # CPU-bound; same dist/ resolution
│   │
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── index.ts
│   │   ├── schemas/
│   │   │   ├── projects.ts
│   │   │   ├── credentials.ts
│   │   │   ├── rotation.ts
│   │   │   ├── machine-users.ts
│   │   │   ├── audit.ts
│   │   │   ├── monitoring.ts
│   │   │   ├── auth.ts
│   │   │   ├── compliance.ts         # Must exist before modules/compliance/ is implemented
│   │   │   └── sse-payloads.ts       # SsePayloadMap — add before implementing SSE events
│   │   ├── constants/
│   │   │   ├── audit-events.ts       # AuditEvent registry
│   │   │   ├── cache.ts              # MACHINE_USER_CACHE_TTL_SECONDS=300, HIGH_SENSITIVITY_CACHE_TTL_SECONDS=0, per-secret min/max overrides
│   │   │   └── system.ts             # SYSTEM_ACTOR_ID, SYSTEM_ACTOR_TYPE
│   │   ├── openapi.json              # Generated — IS committed; CI verifies freshness
│   │   └── api-types.ts              # Generated — IS committed; DO NOT EDIT
│   │
│   ├── tsconfig/
│   │   ├── base.json
│   │   ├── node.json
│   │   └── svelte.json
│   │
│   └── eslint-config/
│       ├── index.js                  # svelte/no-at-html-tags: error (CI gate for {@html})
│       └── rules/
│           └── no-bare-drizzle.js    # Flags db.select()/db.insert()/sql`` outside withOrg() — scope: apps/api/src/** and apps/web/src/** ONLY (not packages/db/** where withOrg() itself is implemented)
│
├── docker-compose.yml                # api + web + db; stop_grace_period: 30s on api
├── docker-compose.dev.yml
├── turbo.json                        # generate-spec → typecheck; crypto#build --watch in dev
├── pnpm-workspace.yaml
├── package.json
├── .commitlintrc.ts
├── .gitignore
└── README.md
```

### Architectural Boundaries

**Module Boundary Definitions:**

| Module | Scope | Temporal | Access | Purpose |
|---|---|---|---|---|
| `dashboard/` | Per-project | Real-time | Member+ | Credential status, service health, rotation queue — things changing minute-to-minute |
| `org-health/` | Org-wide | Snapshot ≤1h | Owner/Admin+ | MFA coverage, expiring assets across org, user access summary — governance views |
| `compliance/` | Org-wide | Historical | OrgAdmin only | SOC2 evidence, audit export for auditors — formal compliance artifacts |
| `audit/` | Org-wide | Append-only | Owner+ | Audit log READ API only — compliance/ imports its query functions |

**Audit Log Tamper-Evidence Boundary (documented limitation):**
Software-only audit log integrity (row checksums + cryptographic chaining) detects accidental corruption and external attackers without DB access. It does not prevent a sophisticated insider who simultaneously holds DB write access and the master key from forging the log — deriving the audit key from the master key makes chain recomputation possible. True tamper-evidence requires external anchoring outside the attacker's control. v1 mitigation: scheduled automatic export to an operator-configured external destination (configurable in admin UI, `AuditEvent.AUDIT_LOG_EXPORTED_AUTO` recorded for each scheduled export); v2 target: signed external notary integration. This limitation must be explicitly disclosed in the security documentation.

**Data Boundaries:**
- `packages/db` — only package permitted to hold Drizzle schema and execute queries; exports `withOrg`, `withOrgReadScope`, `withAdminAccess`, `withRotationLock`, `Tx`
- `packages/crypto` — encryption/decryption only; `apps/web` never touches crypto
- `packages/shared` — API contract between api and web; no business logic; `openapi.json` and `api-types.ts` are committed and CI-verified for freshness
- RLS at database level enforces org isolation; `SET LOCAL` always scoped to transaction via db helpers
- `lib/org-queries.ts` — shared aggregation layer; both `org-health/` and `compliance/` import from here

**Component Boundaries (Frontend):**
- `(app)/+layout.server.ts` — session validation gate for all authenticated surfaces
- `(app)/admin/+layout.server.ts` — OrgAdmin gate; additional check above session gate
- `(app)/org-health/` — Owner/Admin+ gate (not OrgAdmin); `has-any-owner-or-admin` check via `orgRole`
- `lib/state/sse.svelte.ts` — single SSE connection; pages subscribe via `onSseEvent()`, never `new EventSource()`
- `lib/components/ui/` — base primitives only; no business logic or API calls

**Worker Boundaries:**
- All workers receive `orgId` in job payload; project-scoped workers also receive `projectId`
- `ProjectJobPayload<T>` — `{ orgId, projectId, data: T }` for workers emitting project-scoped SSE
- `OrgJobPayload<T>` — `{ orgId, data: T }` for org-level workers (session cleanup, backup, audit verify)
- CPU-bound workers (backup, audit hash) spawn `worker_threads` from `packages/crypto/dist/workers/`
- `turbo dev` required for worker development (rebuilds `packages/crypto` on change)

### Integration Points

**Internal Communication:**
- HTTP → `SecureRoute` (auth + rbac/orgRole + rate limiting) → `AuthContext` → module routes → service → `withOrg()` → repository
- pg-boss job → worker → `withOrg(orgId from payload)` → service → `emitSseEvent()` + `writeAuditEntry()`
- SSE stream → ring buffer → `toClientPayload()` → `text/event-stream`
- `modules/compliance/` → imports → `modules/audit/service.ts` + `lib/org-queries.ts`

**External Integrations:**
- Email: `nodemailer` + SMTP — `workers/notification-email.ts`
- Slack: webhook HTTP POST — `workers/notification-slack.ts`
- GitHub Actions OIDC: `modules/integrations/github-actions/` — verifies GitHub JWKS, issues machine user token
- GitLab CI OIDC: `modules/integrations/gitlab-ci/` — equivalent
- GHCR: `release.yml` on merge to main
- Prometheus: `GET /metrics` — prom-client, localhost-only default

**Data Flow:**
1. Human user → SvelteKit `+page.server.ts` → `openapi-fetch` → Fastify → `withOrg()` → PostgreSQL (RLS) → `packages/crypto` decrypt → response
2. Machine user → `GET /api/v1/machine/projects/{projectId}/credentials/{name}/value` → API key auth (HMAC-SHA256 verify) → `withOrg(scope from key)` → credential fetch → `AuditEvent.CREDENTIAL_VALUE_REVEALED` → response
3. Monitoring worker → pg-boss `health:check` → HTTP probe → result stored → `emitSseEvent('service.health.changed', ...)` → SSE stream → dashboard update
4. Rotation → human initiates → advisory lock on credential → checklist from `credential_dependencies` → per-system confirmation → all confirmed → old version retired → `AuditEvent.ROTATION_COMPLETED` → SSE + audit
5. Org health → pg-boss `org:health-snapshot` every 30min → `lib/org-queries.ts` joins → `org_health_snapshots` row written → `GET /organizations/{orgId}/health` returns snapshot (fast single-row read)

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**
All technology choices are mutually compatible. SvelteKit 2 (Svelte 5 runes) + Fastify v5 + Drizzle ORM + PostgreSQL 16 + pg-boss 10 have no version conflicts. The `openapi-typescript` + `openapi-fetch` pipeline creates a compile-time type contract between API and UI that eliminates runtime shape mismatches. The `worker_threads` pattern for CPU-bound operations is fully compatible with the pg-boss job dispatch model. `@fastify/jwt` (HMAC-SHA256) integrates cleanly with the `sessions` revocation table approach. Argon2id and HMAC-SHA256 serve distinct purposes with no overlap (passwords vs. high-entropy tokens). No contradictory decisions identified after 5 rounds of adversarial elicitation.

**Pattern Consistency:**
All implementation patterns are internally coherent. The `withOrg()` / `withOrgReadScope()` / `withAdminAccess()` trinity covers all access patterns without overlap. The `SecureRoute` sealed abstraction and the `no-bare-drizzle` ESLint rule form a two-layer enforcement net (compile-time + runtime-pattern). The `AuditEvent` constant registry + SSE payload registry + pg-boss job naming convention all follow the same "registry-first, no magic strings" discipline. Svelte 5 runes state management pattern is consistent across all state modules. Error handling (`AppError` + Zod validation errors) uses a single response shape throughout.

**Structure Alignment:**
The monorepo package boundaries (`packages/crypto`, `packages/db`, `packages/shared`) cleanly separate concerns and their dependency direction is acyclic. Backend module structure (`modules/{feature}/routes|service|schema|repository.ts`) aligns with the `withOrg()` ownership rule. Frontend route structure maps 1:1 to FR categories. The Turborepo task graph (`generate-spec → typecheck`) enforces the type contract at CI level. No circular dependencies or boundary violations identified.

---

### Requirements Coverage Validation ✅

**Functional Requirements Coverage (95 FRs across 12 categories):**

| FR Category | Coverage | Notes |
|---|---|---|
| Secret & Credential Management | ✅ Full | CRUD, versioning, `withSecret()` zeroing, encryption scheme versioning |
| Rotation & Propagation | ✅ Full | Advisory lock, checklist state machine, per-system confirmation, `rotation:recover` singleton |
| Machine User Access | ✅ Full | API key HMAC, offline ciphertext cache, scoped token exchange, `MACHINE_USER_CACHE_TTL_SECONDS` |
| Audit & Compliance | ✅ Full | Same-transaction invariant, cryptographic chaining, PII externalization, write-once export, CI harness |
| Operational Monitoring & Alerts | ✅ Full | pg-boss health:check, SSRF validation, SSE event replay, expiry tracking, auto-enrollment |
| Authentication & Sessions | ✅ Full | Argon2id, MFA (TOTP + recovery codes), JWT 5-min TTL + silent refresh, grace window, MFA enforcement for OrgAdmin/Owner |
| RBAC & Permissions | ✅ Full | `AuthContext`, `SecureRoute`, `withOrg()` chain, project-scoped RBAC |
| Organization & Multi-tenancy | ✅ Full | `org_id` on all mutable tables, PostgreSQL RLS, `check-rls-coverage.ts` CI guard |
| Plugin & Rotation Integrations | ✅ Full | PSK TLS delivery, egress monitoring (required v1), scoped execution tokens |
| Search & Discovery | ✅ Full | PostgreSQL `tsvector`, cursor pagination for audit, page-based for others |
| Email & Notifications | ✅ Full | `nodemailer` + SMTP admin config, pg-boss `notification:email`, SSE push |
| Backup & Export | ✅ Full | `backup:snapshot` worker_threads, `AuditLogDecryptedEntry` wrapper, compliance export |

**Non-Functional Requirements Coverage:**

| NFR | Target | Architectural Support |
|---|---|---|
| Credential fetch p95 | ≤100ms | Connection pooling, ciphertext offline cache, CPU-bound ops in `worker_threads` |
| Search p95 | ≤300ms | `tsvector` index, paginated queries |
| Dashboard FMC | ≤2s | SvelteKit SSR, progressive loading, SSE for live data |
| Audit log p95 | ≤500ms at max write rate | Composite index `(org_id, created_at DESC)`, monthly partitioning escalation path |
| Availability | 99.9%, ≤30s restart | Docker Compose `restart: always`, pg-boss `rotation:recover` startup job |
| Audit completeness | 100% | Same-transaction invariant, CI deliberate-failure harness, `audit_write_latency_ms` metric |
| Security | AES-256-GCM, RBAC, MFA | Full cryptographic stack + `withSecret()` + RLS + MFA enforcement middleware |

---

### Implementation Readiness Validation ✅

**Decision Completeness:**
All critical decisions are documented with specific versions, rationale, and implementation constraints. Security decisions include explicit threat model boundaries. Performance decisions include specific targets and the measurement approach (`prom-client`). Every constraint includes a "why" — AI agents have enough context to make consistent choices without guessing.

**Structure Completeness:**
The complete project directory structure is specified to file level. All `packages/`, `apps/api/src/modules/`, `apps/web/src/routes/`, and `workers/` entries are enumerated. Integration points (Turborepo task graph, `createApp` factory, EventEmitter injection, `secureRoutes: Set<string>`) are fully specified. The `api_instances` heartbeat table and `check-rls-coverage.ts` script add two new infrastructure items that must be included in Step 2 of the implementation sequence.

**Pattern Completeness:**
15 potential conflict areas addressed across 5 rounds of adversarial elicitation (4 methods): naming conventions, API structure, DB schema, audit event types, SSE event naming, pg-boss job naming, module organization, TypeScript patterns, Drizzle ownership, error handling, loading state, date/time handling, SSE lifecycle, integration test setup, commit convention. Anti-patterns list covers 20+ explicitly forbidden patterns.

---

### Gap Analysis Results

**Critical Gaps — All Resolved:**
All critical gaps identified across elicitation rounds have been resolved and documented in the architecture:
- JWT TTL (5 min), silent refresh concurrency guard, grace window idempotency with `iat = now()`
- `withSecret(Buffer)` contract, `no-bare-decrypt` ESLint rule with explicit file location
- `withSecret()` × `worker_threads` boundary — ciphertext-only cross-thread pattern
- Offline cache stores ciphertext only — `withSecret()` on every access
- `sessions` / `refresh_tokens` split schema with full field list, indexes, RLS exception
- MFA enforcement (OrgAdmin/Owner mandatory, middleware-level)
- `rotation:recover` singletonKey, startup DB-backed multi-instance detection
- SSR cookie forwarding in `hooks.server.ts`
- `createApp()` factory pattern for `generate-spec.ts` (no live DB in CI)
- Plugin egress monitoring mandatory for v1 (not deferrable)
- Audit write bottleneck escalation path documented in `docs/operations/audit-log-scaling.md`
- `check-rls-coverage.ts` CI guard for new mutable table migrations
- `AuditLogDecryptedEntry` type for audit export path
- SSE ring buffer single-instance constraint documented and added to startup guard

**Important Gaps — Accepted for v1:**
- Break-glass revocation endpoint (v1.1 target — documented)
- Plugin network namespace isolation (v2 target — documented)
- HMAC API key rotation (migration path documented via `hmac_key_version`)
- Redis for horizontal scaling (single-instance constraint explicitly documented with startup guard)

**Nice-to-Have:**
- Per-plugin resource usage caps (CPU/memory) — v2
- Dual-approval for rotation initiation — v2 PRD feature
- CLI tooling — post-MVP

---

### Validation Issues Addressed

Five rounds of adversarial elicitation (First Principles Analysis, Challenge from Critical Perspective, Thesis Defense Simulation, Failure Mode Analysis, Pre-mortem Analysis) surfaced and resolved 21 issues across security, schema design, operational constraints, and implementation clarity. All findings were applied to the architecture document. The architecture transitioned from **MEDIUM-HIGH confidence** (pre-elicitation) to **HIGH confidence** (post-elicitation) with no unresolved critical or high-severity issues remaining.

---

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Project context thoroughly analyzed (95 FRs, 7 NFRs, 12 capability areas)
- [x] Scale and complexity assessed (10,000 secrets, single-instance v1, documented scaling constraints)
- [x] Technical constraints identified (single-instance, no Redis, Node.js crypto only)
- [x] Cross-cutting concerns mapped (encryption, RLS, audit, RBAC, SSE, graceful shutdown)

**✅ Architectural Decisions**
- [x] Critical decisions documented with versions and rationale
- [x] Technology stack fully specified (SvelteKit 2 / Svelte 5, Fastify v5, Drizzle, PostgreSQL 16, pg-boss 10, pnpm, Turborepo)
- [x] Integration patterns defined (openapi-typescript pipeline, EventEmitter injection, createApp factory)
- [x] Performance considerations addressed (p95 targets, worker_threads, caching strategy, audit index escalation)

**✅ Implementation Patterns**
- [x] Naming conventions established (DB snake_case, API camelCase, SSE dot-separated, pg-boss colon-separated)
- [x] Structure patterns defined (module layout, withOrg() ownership, SecureRoute abstraction)
- [x] Communication patterns specified (SSE payload registry, typed emission, ring buffer replay)
- [x] Process patterns documented (error handling, token hashing, date handling, cursor pagination)

**✅ Project Structure**
- [x] Complete directory structure defined to file level
- [x] Component boundaries established (package dependency graph, acyclic)
- [x] Integration points mapped (Turborepo graph, EventEmitter, secureRoutes Set)
- [x] Requirements to structure mapping complete (all 12 FR categories mapped to modules/routes/workers)

---

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION ✅

**Confidence Level: HIGH** — 5 adversarial elicitation rounds across 21 issues; no unresolved critical or high-severity gaps; all implementation contract ambiguities resolved.

**Key Strengths:**
- Layered, redundant enforcement (ESLint + TypeScript + RLS + SecureRoute + integration tests)
- Every security constraint has a "why" — AI agents have threat model context, not just rules
- Operational failure modes documented with prescribed responses (not just detection)
- Single-instance constraints are explicit, tested at startup, and have a documented upgrade path
- All session/auth edge cases (race conditions, grace windows, cookie forwarding, `iat` precision) fully specified

**Areas for Future Enhancement (v1.1 / v2):**
- Break-glass revocation endpoint (reduces revocation propagation window from TTL to near-zero)
- Plugin network namespace isolation (closes the egress monitoring gap at OS level)
- Redis shared cache layer (enables horizontal scaling for tier cache + SSE ring buffer)
- KMS integration for master key (removes key co-location risk entirely)
- Dual-approval for rotation initiation (closes insider threat window on credential exposure)

---

### Implementation Handoff

**AI Agent Guidelines:**
- Follow all architectural decisions exactly as documented — every constraint has a documented rationale
- Use implementation patterns consistently across all components
- Check the anti-patterns list before implementing any cross-cutting concern
- The `packages/eslint-config/` rules (`no-bare-drizzle`, `no-bare-decrypt`, `svelte/no-at-html-tags`) are CI gates, not suggestions
- `withTestOrg()` in every integration test — RLS must always be active in tests
- Refer to this document for all architectural questions before making a new decision

**First Implementation Priority:**
Follow the Implementation Sequence (Step 2 in Decision Impact Analysis):
1. `pnpm create turbo` monorepo scaffold + Turborepo config
2. `packages/db` — PostgreSQL schema, RLS policies, Drizzle migrations, `api_instances` table, `withOrg()` helpers, `check-rls-coverage.ts` CI script
3. `packages/crypto` — AES-256-GCM + HKDF + Argon2id + `withSecret()` + `SecretValue` + `AuditLogDecryptedEntry`
4. Fastify auth foundation — `createApp()` factory, registration, login, session, MFA, JWT, revocation
