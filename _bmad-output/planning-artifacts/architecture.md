---
stepsCompleted: [1, 2, 3, 4]
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
- Database-backed `sessions` table: `(jti, user_id, expires_at, revoked_at)`
- Index on `(jti, expires_at)` for fast per-request lookup
- pg-boss cleanup job purges expired sessions on schedule (daily)
- Adds one indexed query per request to auth middleware — acceptable at target scale

**Tier Limit Cache:**
- In-memory LRU cache (no Redis) per process; TTL ≤60 seconds
- Invalidated on subscription tier change event
- **Architectural constraint: incompatible with horizontal scaling.** Multiple API containers maintain independent caches; quota enforcement becomes inconsistent between processes during the TTL window. Any deployment with more than one API container requires replacing this with a shared cache layer (Redis or database-backed). This constraint must be documented in the deployment guide. v1 single-instance Docker Compose deployment is the only supported topology.

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

**JWT architecture:**
- Web session JWTs: ≤15 min TTL, signed with HMAC-SHA256 (`@fastify/jwt`)
- Machine user exchange JWTs: ≤1h TTL, issued via API key token exchange
- Both carry `jti` (JWT ID) for revocation lookup
- Revocation checked on every authenticated request via indexed DB query

**Encryption:**
- `packages/crypto`: AES-256-GCM for secrets at rest; HKDF for key derivation
- Master key: env var (default) or mounted file path (stronger default — separate volume/permissions domain)
- Audit log encryption key: HKDF-derived from master with distinct info string
- Per-entry key version stored in audit log for independent rotation lifecycle
- **Every encrypted field stores the encryption scheme version alongside the ciphertext from the first commit.** Format: `{ version: 1, iv: ..., ciphertext: ..., tag: ... }`. Retrofitting versioning onto stored data later requires a full re-encryption migration. Cryptographic agility (per PRD) depends on this being in place from day one.
- Node.js built-in `crypto` module — no external crypto library needed

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
- `apps/api/scripts/generate-spec.ts` — initializes Fastify with mocked I/O dependencies (no live DB, no pg-boss), registers all routes and plugins, exports the OpenAPI spec to `packages/shared/openapi.json`, exits
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
  error: string,       // machine-readable code (e.g. "SECRET_NOT_FOUND")
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
- **SSE reconnection and event replay:** server assigns monotonic `id` to every SSE event; client sends `Last-Event-ID` header on reconnect; server replays events since that ID from a short in-memory ring buffer (last 100 events, max 60 seconds); client refreshes full state via REST on reconnect if beyond buffer
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
- **CPU-bound handlers (backup encryption, audit log hash chain verification, bulk re-encryption) must offload to `worker_threads`** to prevent event loop blocking and latency spikes on the p95 ≤100ms secret fetch path

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
- Default Node.js metrics + custom: secret fetch latency, rotation count, SSE connection count, pg-boss queue depth
- Localhost-only by default; configurable for external scraping

**CI/CD:** GitHub Actions
- On PR: lint, typecheck (after `generate-spec`), Vitest, build
- On merge to main: above + Docker multi-arch build + push to GHCR
- Turborepo remote cache via GitHub Actions cache
- `pnpm audit` on every CI run; Dependabot for dependency updates

**Environment configuration:** 12-factor; all config via environment variables

### Decision Impact Analysis

**Implementation Sequence (order matters):**
1. Monorepo scaffold + shared packages — **crypto versioning structure in place from this step**
2. PostgreSQL schema + RLS policies + Drizzle migrations — **`db.transaction()` wrapper established as the only permitted DB access pattern from this step; ESLint rule added**
3. `packages/crypto` — AES-256-GCM + HKDF + Argon2id; versioned ciphertext format; worker_threads wrapper for CPU-bound operations
4. Fastify auth foundation — registration, login, session, MFA, JWT, revocation table; **graceful shutdown wired from this step**
5. Sealed `SecureRoute` abstraction + RBAC + org_id middleware chain
6. pg-boss worker registration + job types; **injected EventEmitter created at startup; CPU-bound handlers use worker_threads**
7. SvelteKit auth flows + SSE consumer with reconnection, Last-Event-ID, and polling fallback
8. Core credential CRUD + encryption integration
9. SSE stream endpoint + ring buffer for event replay; `generate-spec` script + Turborepo task wiring
10. Dashboard + monitoring surface (SSE consumer + polling fallback visual indicator)

**Cross-Component Dependencies:**
- `packages/db` ← depended on by `apps/api` and `packages/crypto` (schema types for encrypted fields)
- `packages/shared` ← depended on by `apps/api` (validation) and `apps/web` (client types + Zod schemas)
- `packages/crypto` ← depended on by `apps/api` only (server-side only)
- pg-boss workers ← depend on `packages/db` for job payload types and `packages/crypto` for secret operations
- SSE stream ← depends on injected EventEmitter shared between HTTP handlers and pg-boss workers
- `apps/web` typecheck ← depends on `api#generate-spec` via Turborepo task graph
