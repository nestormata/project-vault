# Story 1.10: Structured Operational Logging & Metrics

Status: in-progress

<!-- Ultimate context engine analysis completed 2026-06-24 — comprehensive developer guide for FR82 structured operational logging (Pino config, traceId propagation, redaction, eventType registry, startup/shutdown/job logs) and Prometheus metrics completion (rename duration metric, vault_sealed, db_pool_connections_active, histogram buckets, bind-host tests). Builds on Story 1.3 partial metrics baseline and Story 1.5 redact-secrets plugin. Resolves AC-E1b vs Story 1.10 field naming, Story 1.3 `_ms` vs epic `_seconds` metric naming, and `event` vs `eventType` legacy vault logs. -->

## Story

As a platform operator monitoring a running vault instance,
I want all application events emitted as structured JSON logs and Prometheus-compatible metrics,
so that I can ship logs to external aggregation tools and scrape metrics into my monitoring stack without custom parsing.

*Covers: FR82, NFR-MAINT4* [Source: _bmad-output/planning-artifacts/prd.md#Functional-Requirements]

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 1.3 complete — `/metrics` baseline, `METRICS_BIND_HOST`, `LOG_LEVEL` in env | Do **not** re-implement Docker/health; extend partial metrics + wire Pino |
| Story 1.5 complete — `redactBodyForLog()`, vault route handlers | Extend redaction into global Pino config; migrate `event` → `eventType` on vault logs |
| Story 1.2 complete — ESLint `no-console`, Fastify app factory pattern | All logging via Pino; replace `process.stderr.write` in `main.ts` |
| Stories 1.6–1.9 (in progress on branch) — auth/MFA/job handlers emit `eventType` | This story provides the **central logger config** those stories assume |

### Epic Cross-Story Context

| Story | Relationship to 1.10 |
|---|---|
| 1.3 | Delivered loopback-only `/metrics`, `http_requests_total`, `process_uptime_seconds`, `http_request_duration_ms` — **1.10 completes and corrects** per epic AC |
| 1.5 | Vault routes log `{ event: 'vault.init' }` + `redactBodyForLog()` — migrate to `eventType` + global Pino redact paths |
| 1.6 | Login/register emit `eventType: 'auth.*'` — must pass through structured logger mixin |
| 1.7 | pg-boss jobs emit `job.completed` / `job.failed` — wrap with shared `logJobEvent()` helper |
| 1.8 | MFA routes emit `alert.pending_epic3` — add event types to operational registry |
| 1.9 | Threshold job emits `security.failed_auth_threshold_no_org`, `security.mfa_enrollment_required_denied` — add to redaction review list |
| 1.11 | SecureRoute audit writes are **security audit log** (DB) — **not** operational Pino logs; do not conflate |
| Epic 8 | Tamper-evident `audit_log_entries` — separate from FR82 operational stdout logs |

---

## Architecture Conflict Resolution (Read Before Coding)

| Source wording | Canonical implementation | Rationale |
|---|---|---|
| AC-E1b: `trace_id`, `event_type` (snake_case) | JSON output uses **`traceId`**, **`eventType`** (camelCase) | Stories 1.6–1.9 + Story 1.10 epic AC use camelCase; AC-E1b is epic-level summary — operational log field names follow application convention |
| Pino default `time` field | Output field **`timestamp`** (ISO 8601) | FR82 / AC-E1b require `timestamp`; configure Pino `timestamp: () => ...` or formatter |
| Pino default `msg` field | Output field **`message`** | Map via custom log method wrapper or accept `msg` alias in tests — **prefer renaming to `message`** in mixin |
| Story 1.3 metric `http_request_duration_ms` | Rename to **`http_request_duration_seconds`** | Story 1.10 epic AC is authoritative; update tests + any dashboards |
| Story 1.3 buckets `[1,5,15,...]` ms | Buckets **`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]`** seconds | Epic AC specifies seconds histogram |
| Vault routes use `event` key | Migrate to **`eventType`** | Single operational log vocabulary |
| Epics: `GET /metrics` bound to localhost | **Access control via `req.ip` loopback check** (existing) + `METRICS_BIND_HOST=0.0.0.0` override | API listens on `0.0.0.0`; metrics security is IP-based gate, not separate listener — document in ADR |
| Architecture: operational log → `audit_log_operational` table | **v1: stdout Pino only** for FR82 | DB operational table is architecture future-state; FR82 satisfied by shippable JSON logs |
| `main.ts` `process.stderr.write('[vault]...')` | Structured **`eventType: 'startup.vault_status'`** via root logger | ESLint `no-console`; stderr only for fatal pre-logger bootstrap |

---

## Acceptance Criteria

### AC Quick Reference

| Component | Trigger | Success | Key verification |
|---|---|---|---|
| Pino config | Any log call | Required fields present | `structured-log.test.ts` parses JSON lines |
| HTTP request | Any route hit | `eventType: http.request` with timing | No body in log |
| Redaction | Request with secrets | `[REDACTED]` in output | String scan test |
| `/metrics` | Loopback GET | Prometheus text + 5 required metrics | `metrics.test.ts` |
| `/metrics` | Non-loopback default | `403` | Existing test preserved |
| pg-boss job | Worker start/complete/fail | `job.started/completed/failed` | Unit test on wrapper |
| Startup | `main()` boot | `startup.complete` with version + vault state | Integration smoke |

---

### AC-1: Module Structure & File Layout

**Given** Stories 1.3 and 1.5 established partial logging/metrics,
**When** Story 1.10 is complete,
**Then** add or modify:

```
apps/api/src/
├── lib/
│   ├── logger.ts                    # NEW: createLoggerConfig(), operationalLog(), mixin
│   ├── logger.test.ts               # NEW: field presence, redaction, level
│   ├── job-logging.ts               # NEW: logJobStarted/Completed/Failed wrappers
│   ├── job-logging.test.ts          # NEW
│   ├── db-pool-metrics.ts           # NEW: track active DB queries → Prometheus gauge
│   └── startup-logging.ts           # NEW: logStartupBanner(), logShutdown()
├── plugins/
│   ├── structured-logging.ts        # NEW: Fastify plugin — request mixin, http.request hook
│   ├── structured-logging.test.ts   # NEW
│   └── redact-secrets.ts            # MODIFY: export REDACTED_PATHS for Pino config merge
├── routes/
│   ├── metrics.ts                   # MODIFY: seconds histogram, vault_sealed, db_pool gauges, duration observe
│   └── metrics.test.ts              # MODIFY: assert all required metric names + buckets
├── modules/vault/routes.ts          # MODIFY: event → eventType on vault logs
├── app.ts                           # MODIFY: use createLoggerConfig(); register structured-logging plugin
├── main.ts                          # MODIFY: structured startup logs; instrument db pool
├── config/env.ts                    # MODIFY: LOG_LEVEL silent default when NODE_ENV=test
└── __tests__/
    ├── structured-log-schema.test.ts    # NEW: FR82 required fields on every line
    ├── structured-log-redaction.test.ts # NEW: epic AC string-scan test
    └── helpers/
        └── capture-logs.ts              # NEW: pino destination stream helper for tests

packages/shared/src/constants/
└── operational-event-types.ts       # NEW: canonical eventType string constants + registry

scripts/check-env-example.ts       # VERIFY: LOG_LEVEL, METRICS_BIND_HOST documented
.env.example                         # MODIFY: add Story 1.10 comment block
```

**And** export `OperationalEvent` constants from `@project-vault/shared` — operational logs use these, **not** hardcoded strings (mirrors `AuditEvent` pattern for security audit DB).

**And** **do not** add Sentry, OpenTelemetry, or a second logging library — Pino + prom-client only (architecture v1).

---

### AC-2: Environment Variables

**Modify `apps/api/src/config/env.ts`:**

| Variable | Type | Default | Validation / behavior |
|---|---|---|---|
| `LOG_LEVEL` | enum | `info` (prod/dev), **`silent` when `NODE_ENV=test`** | `fatal\|error\|warn\|info\|debug\|trace\|silent` |
| `METRICS_BIND_HOST` | string | `127.0.0.1` | Document: set `0.0.0.0` to allow non-loopback scrape (sidecar) |
| `SERVICE_NAME` | string | `api` | Emitted as `service` field on every log line. **Validation:** must match `/^[a-z][a-z0-9_-]{0,63}$/` — lowercase alphanumeric, hyphens, underscores, max 64 chars. Reject startup with a fatal env error if invalid. Prevents special characters reaching log aggregator index names, Prometheus label values, and Grafana selectors. |

**Production guards:**

- Reject startup when `NODE_ENV=production` and `LOG_LEVEL=debug` or `trace` (optional warn → error per security policy)
- `METRICS_BIND_HOST=0.0.0.0` in production emits **`startup.metrics_exposed`** warning log — intentional override documented

**Example `.env.example` snippet:**

```bash
# Story 1.10 — Structured operational logging & metrics
LOG_LEVEL=info                    # silent in NODE_ENV=test automatically
METRICS_BIND_HOST=127.0.0.1       # 0.0.0.0 allows external Prometheus scrape
SERVICE_NAME=api
```

---

### AC-3: FR82 Required Log Schema (Every Log Line)

**Given** the API process is running,
**When** any log line is emitted at any level (except pre-bootstrap fatal stderr),
**Then** each line is single-line JSON to stdout with **all** required fields:

| Field | Type | Source |
|---|---|---|
| `timestamp` | ISO 8601 string | Pino timestamp config |
| `level` | string | `trace\|debug\|info\|warn\|error\|fatal` |
| `service` | string | `env.SERVICE_NAME` (default `api`) |
| `traceId` | UUID string | Request: `X-Request-ID` header or generated; non-request: omit or use `system` constant |
| `eventType` | string | Caller-provided or defaulted (see registry AC-4) |
| `message` | string | Human-readable summary |

**Fastify configuration:**

```typescript
// apps/api/src/lib/logger.ts
import { randomUUID } from 'node:crypto'
import type { Env } from '../config/env.js'

export function createLoggerConfig(
  env: Env,
  destination?: pino.DestinationStream
) {
  const config = {
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    messageKey: 'message',
    base: { service: env.SERVICE_NAME },
    redact: {
      paths: PINO_REDACT_PATHS, // see AC-6
      censor: '[REDACTED]',
    },
    formatters: {
      level(label: string) {
        return { level: label }
      },
    },
    mixin() {
      return { eventType: 'system.untyped' } // overridden by callers
    },
  }
  // destination is optional: undefined → Pino uses process.stdout (synchronous, may block under
  // log-driver backpressure). Tests pass createLogCaptureStream().stream. Future production
  // deployments can pass pino.transport({ target: 'pino/file', options: { destination: 1 } })
  // for non-blocking worker-thread I/O. The interface must support this without refactoring.
  return destination ? pino(config, destination) : config
}

// apps/api/src/app.ts — Fastify factory options
const fastify = Fastify({
  logger: createLoggerConfig(env),
  requestIdHeader: 'x-request-id',
  genReqId(req) {
    const header = req.headers['x-request-id']
    const value = Array.isArray(header) ? header[0] : header
    // RFC 4122 UUID v4: version nibble = 4, variant nibble ∈ {8,9,a,b}
    // Do NOT substitute a looser regex — nil UUID and non-v4 formats are intentionally rejected.
    const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if (value && UUID_V4_RE.test(value)) return value
    return randomUUID()
  },
  disableRequestLogging: true, // we emit custom http.request — AC-5
})
```

**Request-scoped mixin (structured-logging plugin):**

```typescript
// apps/api/src/plugins/structured-logging.ts
fastify.addHook('onRequest', async (request) => {
  request.log = request.log.child({
    traceId: request.id,
  })
})
```

**Non-request logs (startup, jobs, shutdown):**

```typescript
// packages/shared/src/constants/operational-event-types.ts
export const SYSTEM_TRACE_ID = 'system' as const

export function operationalLog(
  logger: FastifyBaseLogger,
  level: 'info' | 'warn' | 'error',
  eventType: string,
  message: string,
  fields?: Record<string, unknown>
) {
  // traceId is always SYSTEM_TRACE_ID for non-request logs — callers cannot override
  logger[level]({ eventType, traceId: SYSTEM_TRACE_ID, ...fields }, message)
}
```

**Constraint:** `operationalLog()` always injects `SYSTEM_TRACE_ID` — callers within request scope must use `request.log.child()` directly (never `operationalLog()`). This prevents masking a real trace ID with the sentinel value.

**Example log lines (pretty-printed for readability; runtime is one line each):**

```json
{"timestamp":"2026-06-24T14:00:00.000Z","level":"info","service":"api","traceId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","eventType":"http.request","message":"request completed","method":"GET","url":"/health","statusCode":200,"responseTimeMs":3}

{"timestamp":"2026-06-24T14:00:01.000Z","level":"info","service":"api","traceId":"system","eventType":"startup.complete","message":"API startup complete","nodeVersion":"24.11.0","serviceVersion":"0.0.1","vaultStatus":"sealed","dbConnected":true}

{"timestamp":"2026-06-24T14:01:00.000Z","level":"warn","service":"api","traceId":"system","eventType":"alert.pending_epic3","message":"Security alert created; notification deferred to Epic 3","alertType":"security.failed_auth_threshold","orgId":"..."}
```

**Integration test (`structured-log-schema.test.ts`):**

- Boot `createApp({ logger: createTestLogger() })` with pino destination capturing lines
- Hit `GET /health`
- Parse each captured line as JSON
- Assert every object has keys: `timestamp`, `level`, `service`, `traceId`, `eventType`, `message`

---

### AC-4: Operational Event Type Registry

**Given** scattered `eventType` strings across Stories 1.5–1.9,
**When** Story 1.10 is complete,
**Then** create `packages/shared/src/constants/operational-event-types.ts`:

```typescript
export const OperationalEvent = {
  // HTTP
  HTTP_REQUEST: 'http.request',

  // Lifecycle
  STARTUP_VAULT_STATUS: 'startup.vault_status',
  STARTUP_COMPLETE: 'startup.complete',
  STARTUP_DB_CONNECTED: 'startup.db_connected',
  STARTUP_DB_FAILED: 'startup.db_failed',
  SHUTDOWN_SIGNAL: 'shutdown.signal_received',
  SHUTDOWN_COMPLETE: 'shutdown.complete',

  // Vault (migrate from event: vault.*)
  VAULT_INIT: 'vault.init',
  VAULT_UNSEAL: 'vault.unseal',
  VAULT_UNSEAL_FAILED: 'vault.unseal.failed',
  VAULT_SEAL: 'vault.seal',

  // Jobs (pg-boss)
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',

  // Auth (Stories 1.6–1.9 — register here, implement in those stories)
  AUTH_PASSWORD_HASH_CORRUPT: 'auth.password_hash_corrupt',
  SESSION_ACTIVITY_TOUCH_FAILED: 'session.activity_touch_failed',

  // Security / alerts (Epic 3 deferral marker)
  ALERT_PENDING_EPIC3: 'alert.pending_epic3',
  SECURITY_FAILED_AUTH_THRESHOLD_NO_ORG: 'security.failed_auth_threshold_no_org',
  SECURITY_MFA_ENROLLMENT_REQUIRED_DENIED: 'security.mfa_enrollment_required_denied',

  // DB
  DB_ERROR: 'db.error',

  // Metrics
  STARTUP_METRICS_EXPOSED: 'startup.metrics_exposed',
} as const

export type OperationalEventType = (typeof OperationalEvent)[keyof typeof OperationalEvent]
```

**Rules:**

- Application code imports `OperationalEvent.*` — ESLint rule or code review gate (optional custom lint in future story)
- `eventType` values use **`domain.action`** dot notation (lowercase)
- **Never** reuse `AuditEvent` constants in Pino logs — audit DB vs operational stdout are separate tables/streams
- `'system.untyped'` (the mixin default) must **never** appear in a normal request flow — the integration test in AC-13 asserts zero `system.untyped` lines during a standard `GET /health` invocation; a `system.untyped` line in CI is a failing test and acts as a lint substitute until a custom ESLint rule is added

**Migration — vault routes:**

```typescript
// BEFORE (Story 1.5)
req.log.info({ event: 'vault.init', keyVersion, kmsType, body: redactBodyForLog(req.body) }, 'Vault initialized')

// AFTER (Story 1.10)
req.log.info(
  { eventType: OperationalEvent.VAULT_INIT, keyVersion, kmsType, body: redactBodyForLog(req.body) },
  'Vault initialized'
)
```

---

### AC-5: HTTP Request Logging

**Given** `disableRequestLogging: true` on Fastify,
**When** any HTTP request completes,
**Then** emit exactly **one** structured log per request on `onResponse`:

```typescript
request.log.info(
  {
    eventType: OperationalEvent.HTTP_REQUEST,
    method: request.method,
    url: request.url,           // route pattern preferred: request.routeOptions.url ?? request.url
    statusCode: reply.statusCode,
    responseTimeMs: reply.elapsedTime,
  },
  'request completed'
)
```

**Invariants:**

- **Never** log `request.body` or `reply.payload` at info/warn/error
- **Never** log `Authorization`, `Cookie`, or JWT headers (Pino redact paths — AC-6)
- Query strings may be logged **only** when they contain no sensitive params — default: log `request.url` path without query for auth routes (`/api/v1/auth/*`)
- `url` field **must** be truncated and sanitized before logging to prevent log injection and log bloat from path-traversal probes:

```typescript
url: String(request.routeOptions?.url ?? request.url).slice(0, 256)
```

**Unit test:** A request with a 1000-character URL path must produce a log line where `url.length <= 256`.

**Route template normalization:**

| Raw URL | Logged `url` field |
|---|---|
| `GET /health` | `/health` |
| `GET /api/v1/auth/me` | `/api/v1/auth/me` |
| `POST /api/v1/vault/unseal` | `/api/v1/vault/unseal` |

**Example — curl + expected log:**

```bash
curl -s -H 'X-Request-ID: 550e8400-e29b-41d4-a716-446655440000' \
  http://localhost:3000/health

# Log (one line):
# {"timestamp":"...","level":"info","service":"api","traceId":"550e8400-e29b-41d4-a716-446655440000",
#  "eventType":"http.request","message":"request completed","method":"GET","url":"/health","statusCode":200,"responseTimeMs":2}
```

**And** propagate trace ID to response header:

```typescript
reply.header('X-Request-ID', request.id)
```

---

### AC-6: Pino Redaction Configuration

**Given** requests may contain credentials, keys, and secrets,
**When** any log serializer or handler runs,
**Then** configure Pino `redact.paths` (merge with `redact-secrets.ts` field list):

```typescript
export const PINO_REDACT_PATHS = [
  // Epic AC literal paths
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.passphrase',           // Story 1.5
  'req.body.masterKeyPath',
  'req.body.envelopeKeyPath',      // Story 1.5
  'req.body.secret',
  'req.body.value',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.body.totp',
  'req.body.recoveryCode',
  'req.body.currentPassword',
  'req.body.newPassword',
  // Nested / wildcard
  '*.password',
  '*.passphrase',
  '*.secret',
  '*.masterKeyPath',
  '*.envelopeKeyPath',
  '*.recoveryCode',
  '*.totp',
  // Story 1.9 — never log attempted email at info+
  'attemptedEmail',
  'attempted_email',
] as const
```

**And** extend `redactBodyForLog()` field set to match (keep manual redaction for structured fields like `body:` in vault logs).

**Redaction verification test (`structured-log-redaction.test.ts`):**

```typescript
it('never emits raw secret field values when present in request body', async () => {
  const { logs, app } = await captureLogs(async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/vault/unseal',
      payload: {
        kmsType: 'passphrase',
        passphrase: 'twelve-char-secret',
        masterKeyPath: '/run/secrets/key.bin',
        secret: 'top-secret-value',
        value: 'credential-value',
      },
    })
  })

  const combined = logs.join('\n')
  expect(combined).not.toMatch(/twelve-char-secret/)
  expect(combined).not.toMatch(/top-secret-value/)
  expect(combined).not.toMatch(/credential-value/)
  // Field names may appear as JSON keys — that is OK; VALUES must not leak
  expect(combined).toContain('[REDACTED]')
})
```

**Epic AC string-scan test (values only):**

```typescript
for (const forbidden of ['password', 'secret', 'masterKeyPath', 'value']) {
  // Assert the forbidden string does NOT appear as a substring following `:` with a non-redacted value
  // Implementation: parse JSON lines, walk string values, fail if value includes test secret literals
}
```

**Note:** JSON keys named `password` in redact path config are fine; test must distinguish **values** from **keys** — use injected known secret literals, not the English word "password" alone.

**Known Limitation — wildcard depth:** Pino `redact.paths` wildcards (e.g. `*.password`) are **single-level only** — they match `body.password` but not `data.body.password` or any object nested two or more levels deep. Future routes that wrap request bodies in an envelope (e.g. `{ data: { password: '...' } }`) must add explicit deep paths to `PINO_REDACT_PATHS` before merging.

**Known Limitation — array-indexed fields:** Pino's `*` wildcard is an object-key wildcard, not an array-index wildcard. A body like `{ "credentials": [{ "value": "secret" }] }` is **not** covered by `*.value` or `req.body.credentials[0].value` unless explicitly added. Any route accepting arrays of objects with sensitive fields must either: (a) add explicit Pino array-wildcard paths (verify support in installed Pino version), or (b) reject array credential payloads at the schema validation layer. **Audit new routes against this limitation before merging.**

**Nested-body redaction test:**

```typescript
it('redacts password nested one level inside a data envelope', async () => {
  // If route accepts { data: { password } }, add 'req.body.data.password' to PINO_REDACT_PATHS
  // This test documents the single-level wildcard limitation and catches regressions when new routes add envelope bodies
})
```

**Required redaction fixtures by route family:**

| Route family | Sentinel fields that must be injected and verified absent from logs |
|---|---|
| Vault | `passphrase`, `masterKeyPath`, `envelopeKeyPath`, `secret`, `value` |
| Auth/login | `password`, `refreshToken`, `accessToken`, `cookie`, `authorization` |
| MFA | `totp`, `recoveryCode`, `currentPassword`, `newPassword` |
| Future secret write/import routes | `secret`, `value`, nested credential arrays, import payloads |

Each fixture must inject unique sentinel values and assert those values appear nowhere in captured log lines. Do not rely on a single vault-route test to prove redaction across auth, MFA, sessions, and future secret import/write payloads.

**Sensitive field registry:** Maintain a single exported sensitive-field registry where practical, and derive both `PINO_REDACT_PATHS` and manual body-redaction field sets from it. If a field cannot be derived automatically because a path is structurally different, document the exception next to the path. Tests must fail if the registry contains a field that is absent from both Pino redaction and manual redaction coverage.

---

### AC-7: LOG_LEVEL Behavior

**Given** operators and CI have different noise tolerance,
**When** `LOG_LEVEL` or `NODE_ENV` is set,
**Then**:

| Condition | Effective level |
|---|---|
| `NODE_ENV=test` | **`silent`** (override `LOG_LEVEL` unless explicit test passes `logger: stream`) |
| `LOG_LEVEL=debug` + `NODE_ENV=development` | Debug logs visible |
| `LOG_LEVEL=info` + production | Info and above |
| `createApp({ logger: false })` | No logging (existing test pattern) |

**Vitest:** Tests using `vi.mock('../config/env.js')` should set `LOG_LEVEL: 'silent'` (existing pattern in `metrics.test.ts`).

**Manual verification:**

```bash
LOG_LEVEL=debug pnpm --filter @project-vault/api dev
# → startup.complete at info; optional debug lines from Fastify internals suppressed by custom config
```

---

### AC-8: Prometheus Metrics — Complete Epic Set

**Given** Story 1.3 partial metrics in `apps/api/src/routes/metrics.ts`,
**When** Story 1.10 is complete,
**Then** `GET /metrics` returns Prometheus text format (`Content-Type: text/plain; version=0.0.4; charset=utf-8`) including **at minimum**:

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `process_uptime_seconds` | gauge | — | Already exists — keep |
| `http_requests_total` | counter | `method`, `route`, `status_code` | Already exists — keep |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | **Rename** from `_ms`; observe `reply.elapsedTime / 1000` |
| `vault_sealed` | gauge | — | `1` sealed/uninitialized, `0` unsealed |
| `db_pool_connections_active` | gauge | — | In-flight queries on instrumented pool |

**Histogram buckets (seconds):** `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5`

**Implementation sketch:**

```typescript
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
})

export const vaultSealed = new Gauge({
  name: 'vault_sealed',
  help: '1 if vault is sealed or uninitialized, 0 if unsealed',
  // Use collect() callback — fires on every scrape, always reflects current state.
  // Do NOT call vaultSealed.set() manually from state-change hooks; that pattern
  // introduces TOCTOU staleness between transitions and push/pull consistency gaps.
  collect() {
    this.set(getVaultStatus() !== 'unsealed' ? 1 : 0)
  },
})

export const dbPoolConnectionsActive = new Gauge({
  name: 'db_pool_connections_active',
  help: 'Number of in-flight database queries',
})
```

**DB pool instrumentation (`db-pool-metrics.ts`):**

```typescript
export function instrumentDbPool<T extends { query: (sql: string) => Promise<unknown> }>(pool: T): T {
  return {
    query: async (sql: string) => {
      dbPoolConnectionsActive.inc()
      try {
        return await pool.query(sql)
      } finally {
        dbPoolConnectionsActive.dec()
      }
    },
  }
}
```

**Wire in `main.ts`:**

```typescript
const rawPool = { query: async (s: string) => sql.unsafe(s) }
const dbPool = instrumentDbPool(rawPool)
await createApp({ dbPool, ... })
```

**Example Prometheus output snippet:**

```
# HELP http_request_duration_seconds HTTP request duration in seconds
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.005",method="GET",route="/health",status_code="200"} 42

# HELP vault_sealed 1 if vault is sealed or uninitialized, 0 if unsealed
# TYPE vault_sealed gauge
vault_sealed 1

# HELP db_pool_connections_active Number of in-flight database queries
# TYPE db_pool_connections_active gauge
db_pool_connections_active 0
```

**Breaking change note:** Remove `http_request_duration_ms` — document in ADR-1.10-02 for anyone who scraped Story 1.3 metric name.

**Route label cardinality guard:** Metrics labels must use `request.routeOptions.url` when available. For unmatched routes, use `route="__unknown__"` rather than raw request paths. Raw URLs may be included only in logs after sanitization/truncation; never as Prometheus labels.

**Required metric edge-case tests:**

- `GET /does/not/exist/<uuid>` records route label `__unknown__`, not the raw path.
- A handler that throws still increments `http_requests_total` once and observes `http_request_duration_seconds` once.
- A request with query parameters never places the query string in metric labels.

**Known Limitation — `db_pool_connections_active`:** The gauge reflects only queries routed through the `instrumentDbPool()` wrapper. Prepared statements and Postgres.js template-literal queries (`sql\`...\``) are not counted in v1. This is acceptable pre-production — the gauge still usefully reads `0` at idle, confirming no in-flight instrumented queries. Replace with Postgres.js native pool instrumentation in Epic 9.

---

### AC-9: Metrics Endpoint Access Control

**Given** default secure deployment,
**When** `GET /metrics` is called,
**Then**:

| `METRICS_BIND_HOST` | Remote address | Result |
|---|---|---|
| `127.0.0.1` (default) | `127.0.0.1`, `::1`, `::ffff:127.0.0.1` | `200` + metrics body |
| `127.0.0.1` | `10.0.0.8` or any non-loopback | `403 { error: 'Forbidden' }` |
| `0.0.0.0` | any | `200` (operator override for sidecar scrape) |

**Preserve** existing `isLoopbackRemoteAddress()` logic from Story 1.3 — **do not regress** Story 1.3 review fix (check `req.ip`, not `Host` header).

**`trustProxy` guard:** `req.ip` is only safe for loopback gating when Fastify's `trustProxy` is `false` (default). If `trustProxy: true` is set globally (e.g. for auth routes behind Traefik), `req.ip` becomes the value of `X-Forwarded-For` — an attacker-controlled header. Verify `app.ts` does not set `trustProxy: true` globally; if it does for other reasons, `isLoopbackRemoteAddress()` must use `req.socket.remoteAddress` directly instead of `req.ip`.

**Additional test — X-Forwarded-For spoofing:**

```typescript
it('GET /metrics returns 403 when X-Forwarded-For: 127.0.0.1 is sent from a non-loopback connection', async () => {
  // Ensures trustProxy misconfiguration does not bypass the loopback gate
  // inject() with headers: { 'x-forwarded-for': '127.0.0.1' } from a simulated non-loopback remoteAddress
})
```

**Additional test — vault guard interaction:**

```typescript
it('GET /metrics returns 503 while vault sealed when vaultGuardEnabled', async () => {
  // Existing vault-lifecycle.test.ts behavior — metrics blocked by vault guard BEFORE bind check
  // Document: sealed vault → 503; unsealed → loopback check applies
})
```

**Docker operator note:**

```bash
# Scrape from host (default — fails by design):
curl -s http://localhost:3000/metrics   # → 403 from non-loopback perspective OR via published port

# Scrape from inside api container (works):
docker compose exec api wget -qO- http://127.0.0.1:3000/metrics
```

---

### AC-10: Background Job Structured Logging

**Given** pg-boss workers (Stories 1.7, 1.9+),
**When** a job handler runs,
**Then** use shared wrapper in `apps/api/src/lib/job-logging.ts`:

```typescript
export async function withJobLogging<T>(
  logger: FastifyBaseLogger,
  jobName: string,
  jobId: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now()
  operationalLog(logger, 'info', OperationalEvent.JOB_STARTED, 'job started', { jobName, jobId })
  try {
    const result = await fn()
    operationalLog(logger, 'info', OperationalEvent.JOB_COMPLETED, 'job completed', {
      jobName,
      jobId,
      durationMs: Date.now() - start,
    })
    return result
  } catch (err) {
    operationalLog(logger, 'error', OperationalEvent.JOB_FAILED, 'job failed', {
      jobName,
      jobId,
      durationMs: Date.now() - start,
      err: serializeError(err),
    })
    throw err
  }
}
```

**Wire at minimum one existing worker** (whichever lands first on branch — e.g. `prune-revoked-tokens` from 1.7 or threshold job from 1.9) as reference implementation.

**Example log sequence:**

```json
{"eventType":"job.started","jobName":"security:check-failed-auth-threshold","jobId":"boss-uuid-123","message":"job started",...}
{"eventType":"job.completed","jobName":"security:check-failed-auth-threshold","jobId":"boss-uuid-123","durationMs":145,"message":"job completed",...}
```

**On failure — rethrow** after log so pg-boss retry/DLQ behavior unchanged (Story 1.7 AC).

**Log sensitivity note:** `jobName` values (e.g. `'security:check-failed-auth-threshold'`) reveal internal security mechanism names to anyone with log read access, including third-party aggregator accounts. Log aggregator ACL is the primary mitigation. If the aggregator is a third-party SaaS, consider logging only a category label (e.g. `'security'`) at `info` level and the full `jobName` at `debug` level only.

**`serializeError()` guard:** Wrap serialization defensively — if `err` is not an `Error` instance (e.g. a string throw, `undefined`, or a pg-boss internal object), `serializeError()` may produce `{}` or throw itself. Always fall back:

```typescript
let serialized: unknown
try {
  serialized = serializeError(err)
} catch {
  serialized = { message: String(err) }
}
```

Always rethrow the **original** `err`, not a wrapped copy, so pg-boss retry/DLQ sees the correct failure.

**Unit test — non-Error throw:**

```typescript
it('logs job.failed and propagates when worker throws a string', async () => {
  const worker = () => { throw 'string error' }
  await expect(withJobLogging(logger, 'test-job', 'job-id-1', worker)).rejects.toBe('string error')
  expect(capturedLogs).toContainEqual(expect.objectContaining({ eventType: 'job.failed' }))
})
```

---

### AC-11: Startup & Shutdown Logs

**Given** `main.ts` boot sequence,
**When** the API starts or shuts down,
**Then** replace unstructured stderr with:

**Startup (in order):**

```typescript
// 1. After loadInitialVaultState()
operationalLog(logger, 'info', OperationalEvent.STARTUP_VAULT_STATUS, 'Vault status loaded', {
  vaultStatus: initialVaultStatus,
})

// 2. After DB connection verified
operationalLog(logger, 'info', OperationalEvent.STARTUP_DB_CONNECTED, 'Database reachable')

// 3. After fastify.listen()
operationalLog(logger, 'info', OperationalEvent.STARTUP_COMPLETE, 'API startup complete', {
  nodeVersion: process.version,
  serviceVersion: pkg.version,
  vaultStatus: getVaultStatus(),
  dbConnected: true,
  port: env.API_PORT,
  // NOTE: do NOT include metricsBindHost here — it reveals security posture to all log readers.
  // METRICS_BIND_HOST=0.0.0.0 is already surfaced via the separate startup.metrics_exposed warn (AC-2).
})
```

**Shutdown (`shutdown.ts`):**

```typescript
operationalLog(fastify.log, 'info', OperationalEvent.SHUTDOWN_SIGNAL, 'Received shutdown signal', { signal })
// ... zeroKeys(), fastify.close()
operationalLog(fastify.log, 'info', OperationalEvent.SHUTDOWN_COMPLETE, 'Shutdown complete')
```

**Fatal pre-logger errors:** `process.stderr.write` permitted **only** before logger exists (env parse failure) — already in `env.ts`.

**Remove:**

```typescript
// DELETE from main.ts
process.stderr.write(`[vault] Initial status: ${initialVaultStatus}\n`)
```

---

### AC-12: Database Error Logging

**Given** a database query fails outside normal HTTP error handler,
**When** the failure is caught (e.g. readiness check, vault key load),
**Then** log:

```typescript
operationalLog(logger, 'error', OperationalEvent.DB_ERROR, 'Database query failed', {
  err: serializeError(err),
  // NEVER include DATABASE_URL or connection strings
})
```

**Example — `/ready` DB failure produces `eventType: 'db.error'` at error level **and** returns `503` to client (no connection string in either).

**Critical — static message strings only:** Never pass `err.message` or any error-derived string as the `message` parameter to `operationalLog()`. ORM and database driver error messages may contain SQL fragments, query parameters, or partial row values. Always use a static string for `message`; place all error detail in `fields` via `serializeError(err)`:

```typescript
// WRONG — may leak SQL fragments from driver error:
operationalLog(logger, 'error', OperationalEvent.DB_ERROR, err.message, {})

// CORRECT — static message; structured detail in fields:
operationalLog(logger, 'error', OperationalEvent.DB_ERROR, 'Database query failed', {
  err: serializeError(err),
})
```

---

### AC-13: Integration Tests

**File:** `apps/api/src/__tests__/structured-logging.integration.test.ts`

```typescript
describe.sequential('Story 1.10 — structured logging & metrics', () => {
  describe('FR82 log schema', () => {
    it('every log line contains timestamp, level, service, traceId, eventType, message', ...)
    it('propagates X-Request-ID to traceId and response header', ...)
    it('http.request includes method, url, statusCode, responseTimeMs without body', ...)
    it('no log line contains eventType "system.untyped" during a normal GET /health request', ...)
    it('url field is truncated to 256 characters when request path exceeds 256 characters', ...)
    it('message-only application log calls are prohibited by helper tests or still emit required fields without system.untyped on request flows', ...)
    it('404 requests emit exactly one http.request log with bounded url and unknown metric route label', ...)
    it('thrown handler errors emit exactly one http.request log and one duration observation', ...)
  })

  describe('Redaction', () => {
    it('does not leak passphrase, secret, masterKeyPath, value literals in logs', ...)
    it('redacts Authorization header when present', ...)
  })

  describe('LOG_LEVEL', () => {
    it('NODE_ENV=test defaults to silent when using env loader', ...)
  })

  describe('Metrics', () => {
    it('returns all five required metric names', ...)
    it('http_request_duration_seconds uses second buckets', ...)
    it('vault_sealed gauge reflects sealed state', ...)
    it('403 for non-loopback /metrics with default bind config', ...)
    it('200 for loopback /metrics', ...)
  })

  describe('Startup logs', () => {
    it('emits startup.complete with serviceVersion and vaultStatus', ...)
  })
})
```

**Test helper (`capture-logs.ts`):**

```typescript
import pino from 'pino'
import { Writable } from 'node:stream'

export function createLogCaptureStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString())
      cb()
    },
  })
  return { stream, lines }
}
```

**Flush before asserting:** Pino uses an async, buffered write pipeline by default. Log lines emitted near the end of a request handler (especially `onResponse` hook logs) may still be in the buffer when test assertions run, producing flaky results. Always flush before asserting:

```typescript
await app.inject({ method: 'GET', url: '/health' })
await app.log.flush() // drain Pino's async buffer before checking captured lines
expect(capturedLines.length).toBeGreaterThan(0)
```

Alternatively, configure the test logger with `pino.destination({ sync: true })` to eliminate the race entirely — document that choice in `capture-logs.ts` if used.

**Required log-capture invariant:** Schema and redaction tests must use a deterministic synchronous capture destination. Do not rely on arbitrary sleeps. If `app.log.flush()` is used, guard for logger implementations where `flush` is unavailable and prefer a sync destination in `capture-logs.ts`.

---

### AC-14: Unit Tests

| File | Coverage |
|---|---|
| `logger.test.ts` | `createLoggerConfig()` level defaults; mixin fields |
| `job-logging.test.ts` | started/completed/failed sequence; durationMs present; rethrow on error |
| `db-pool-metrics.test.ts` | inc/dec around query; dec on throw |
| `structured-logging.test.ts` | onResponse hook emits http.request |
| `metrics.test.ts` | metric names, histogram buckets, 403 loopback |
| `redact-secrets.test.ts` | extend for new fields (totp, recoveryCode) |

**Mutation score target:** ≥80% on `logger.ts`, `job-logging.ts`, `structured-logging.ts`.

---

### AC-15: Security & Red Team Hardening

| Threat | Mitigation | Verified by |
|---|---|---|
| Credential leak via request logs | Pino redact + disable body logging | AC-6 string-scan test |
| JWT in logs | Redact `authorization`, `cookie` headers | AC-6 |
| Trace ID injection / log forging | Accept `X-Request-ID` only if valid UUID | genReqId validation |
| Metrics expose internal state | Loopback-only default | AC-9 |
| `METRICS_BIND_HOST=0.0.0.0` in prod | Startup warning log (AC-2); **not** in `startup.complete` payload | AC-2 + AC-11 |
| Operational vs audit log confusion | Separate `OperationalEvent` vs `AuditEvent` | Code review |
| Email PII in logs (Story 1.9) — structured field | Redact `attemptedEmail` paths | AC-6 |
| **Email PII interpolated into message string** (bypasses Pino redact) | **Never** interpolate user values into log `message` — template literals bypass redaction; structured fields only | Manual code review of all `req.log.*` calls in Stories 1.6–1.9 before merge |
| `metricsBindHost` in startup log reveals security posture | Exclude from `startup.complete`; handled by `startup.metrics_exposed` warn | AC-11 |
| `err.message` passed as log `message` leaks SQL/ORM fragments | Static message strings only; error detail via `serializeError(err)` in `fields` | AC-12 + Anti-Patterns |
| `jobName` reveals internal security mechanism names to log readers | Log sensitivity documented; log aggregator ACL is primary control; use `debug` level for full name if needed | AC-10 |
| Log flooding masks security events | pg-boss retry backoff limits burst; aggregator-side rate alerting (Epic 9 scope) | Architecture review |
| High-cardinality metric labels | Use route template (`routeOptions.url`), not raw URLs with UUIDs | metrics onResponse |
| Log injection via `X-Request-ID` | UUID regex validation | Unit test |
| Error object circular refs | `serializeError()` safe JSON | job-logging |
| Caller trace ID enables attacker self-correlation | Intentional by design; security boundary is log aggregator ACL — documented in ADR-1.10-01 | ADR |
| Proxy header spoofing bypasses `/metrics` loopback gate | Metrics authorization must not trust `X-Forwarded-For`; if `trustProxy` can be enabled, use raw socket remote address or an equivalent non-spoofable source | AC-9 spoofing regression test |
| Operational logs mistaken for compliance evidence | Operational Pino logs may provide visibility, but auth/MFA/session/secret/role/audit-export compliance capture belongs in `audit_log_entries` and SecureRoute audit machinery | AC-17 + Story 1.11 |
| Flaky log-capture assertions | Test capture helper uses deterministic flushing: prefer synchronous Pino destination; if calling `app.log.flush()`, guard for logger implementations without `flush` | AC-13 capture helper |
| New sensitive payload shape bypasses redaction | Every new route schema with sensitive fields updates `PINO_REDACT_PATHS`, manual `redactBodyForLog()` field lists, and exact-shape tests for nested objects or arrays | Code review + redaction tests |

**Code-review checklist for new route schemas:**

- [ ] If the route accepts any sensitive field, the PR updates both `PINO_REDACT_PATHS` and manual body redaction helpers in the same change.
- [ ] Nested objects and arrays of objects with sensitive fields have explicit redaction tests for their exact accepted shape.
- [ ] Auth, MFA, session, secret access, role change, and audit export events are not treated as compliance-complete merely because an operational log line exists.
- [ ] `/metrics` authorization tests cover spoofed `X-Forwarded-For` when `TRUST_PROXY` support exists in `app.ts`.

---

### AC-16: ADRs

#### ADR-1.10-01: camelCase operational log field names (`traceId`, `eventType`) + `SYSTEM_TRACE_ID` sentinel

| | |
|---|---|
| **Context** | AC-E1b lists snake_case; Stories 1.6–1.9 use camelCase in code. Non-request logs need a `traceId` value that satisfies FR82 "required fields" without claiming a UUID correlation. |
| **Decision** | JSON output uses camelCase; log aggregators map if needed. Non-request logs use the exported constant `SYSTEM_TRACE_ID = 'system'` injected automatically by `operationalLog()` — callers cannot override it. Request-scoped code must use `request.log`, never `operationalLog()`. |
| **Consequences** | Consistent with TypeScript codebase; differs from AC-E1b summary text. Aggregator UUID filters must allowlist `'system'`. Enforces clean separation between request and non-request log paths. Caller-provided `X-Request-ID` UUIDs are accepted by design for distributed tracing — an attacker can use a known UUID to self-correlate their log entries if they gain aggregator read access. The security boundary for trace correlation data is the log aggregator access control layer, not the application. |

#### ADR-1.10-02: Rename `http_request_duration_ms` → `http_request_duration_seconds`

| | |
|---|---|
| **Context** | Story 1.3 shipped `_ms` metric; Story 1.10 epic specifies seconds |
| **Decision** | Remove `_ms` metric; observe seconds with epic buckets |
| **Consequences** | Breaking change for early scrapers — acceptable pre-production |

#### ADR-1.10-03: Metrics security via loopback IP check, not separate HTTP server

| | |
|---|---|
| **Context** | API listens on `0.0.0.0`; epic says localhost-only metrics |
| **Decision** | Keep single listener; enforce loopback `req.ip` check unless `METRICS_BIND_HOST=0.0.0.0` |
| **Consequences** | Docker host scrape needs sidecar/exec; matches Story 1.3 implementation |

#### ADR-1.10-04: Custom `http.request` log replaces Fastify default request logging

| | |
|---|---|
| **Context** | Default Fastify logs lack `eventType` and use `reqId` not `traceId` |
| **Decision** | `disableRequestLogging: true` + `onResponse` hook |
| **Consequences** | Must maintain hook for all routes including 404 |

---

### AC-17: Compliance Traceability (FR82)

| FR82 requirement | Satisfied by | Status |
|---|---|---|
| Structured operational logs (not audit logs) | AC-3, AC-4 | **Complete** when merged |
| Shippable to external aggregation (JSON stdout) | Pino single-line JSON | **Complete** |
| Required fields on every line | AC-3 schema test | **Complete** |
| Secret redaction | AC-6 | **Complete** |
| Configurable log level | AC-7 | **Complete** |
| Prometheus-compatible metrics | AC-8, AC-9 | **Complete** |
| Background job visibility | AC-10 | **Complete** |
| Startup/shutdown visibility | AC-11 | **Complete** |

> **Compliance footnote:** "Complete when merged" refers to the **application-layer emission obligation** only. FR82 log retention, queryability, and durability depend on the deployment-layer log shipping pipeline (Fluent Bit, Vector, or equivalent — Epic 9 scope). Story 1.10 does not satisfy any retention SLA. Auditors reviewing FR82 compliance must assess both this story and the Epic 9 shipping/retention deliverable together.

**Compliance boundary:** Story 1.10 does not make Project Vault "audit ready." It only ensures operational logs are structured, parseable, and redacted. Compliance-grade evidence requires `audit_log_entries`, immutable/tamper-evident storage, retention controls, integrity verification, and export workflows in later audit stories. Any README, ADR, or release note created from this story must use "operational logs" wording and must not describe these logs as audit logs.

---

### AC-18: Tasks / Subtasks

- [x] **Task 1: Logger foundation** (AC: 3, 4, 7)
  - [x] **Pre-check:** Verify `packages/shared` package exists and is listed in `pnpm-workspace.yaml`; verify `@project-vault/api/package.json` already has `@project-vault/shared` as a dependency — add it if missing before writing any constants
  - [x] `lib/logger.ts` + `operationalLog()` (with `SYSTEM_TRACE_ID` sentinel — callers cannot override `traceId`)
  - [x] `plugins/structured-logging.ts`
  - [x] `operational-event-types.ts` in shared package (export `SYSTEM_TRACE_ID` alongside `OperationalEvent`)
  - [x] Env: `SERVICE_NAME`, test silent default
- [x] **Task 2: Redaction** (AC: 6)
  - [x] Merge `PINO_REDACT_PATHS`
  - [x] Extend `redact-secrets.ts`
  - [x] `structured-log-redaction.test.ts`
- [x] **Task 3: HTTP logging** (AC: 5)
  - [x] `disableRequestLogging`, custom onResponse
  - [x] `X-Request-ID` response header
  - [x] Migrate vault routes to `eventType`
- [x] **Task 4: Metrics completion** (AC: 8, 9)
  - [x] Rename histogram to seconds + buckets
  - [x] Add `vault_sealed`, `db_pool_connections_active`
  - [x] `db-pool-metrics.ts` + wire in main
  - [x] Update `metrics.test.ts`
- [x] **Task 5: Job logging** (AC: 10)
  - [x] `job-logging.ts` wrapper
  - [x] Wire one worker as reference
- [x] **Task 6: Lifecycle logs** (AC: 11, 12)
  - [x] Refactor `main.ts`, `shutdown.ts`
  - [x] DB error operational logs
- [x] **Task 7: Tests** (AC: 13, 14, 15)
  - [x] Integration + unit tests
  - [x] `capture-logs.ts` helper
  - [x] Update vitest coverage include paths
- [x] **Task 8: Docs** (AC: 2)
  - [x] `.env.example` Story 1.10 block
  - [x] `check-env-example.ts` parity

> Note: Tasks 1-8 reflect implementation progress before advanced elicitation. Task 9 captures deferred hardening requirements added during story review; schedule it as a follow-up before treating Story 1.10 as fully review-ready.

- [ ] **Task 9: Deferred elicitation hardening follow-up** (AC: 6, 8, 13, 15, 17)
  - [ ] Add or verify sensitive-field registry coverage tests for Pino and manual redaction paths
  - [ ] Add route-family redaction fixtures for vault, auth/login, MFA, and future secret write/import payloads
  - [x] Add metric cardinality tests for unknown routes, thrown handlers, and query strings
  - [ ] Ensure log-capture helper uses deterministic synchronous capture or guarded flush behavior
  - [ ] Add compliance language sanity check so operational logs are not described as audit evidence
  - [x] Add `/metrics` proxy spoofing regression test when `TRUST_PROXY` support is present

### Review Findings

- [x] [Review][Patch] HTTP metrics are only observed inside the `/metrics` plugin, so `/health`, vault, auth, org, and 404 requests are not counted or timed despite AC-8 requiring HTTP request metrics across the app. [`apps/api/src/routes/metrics.ts:62`] — fixed 2026-06-27
- [x] [Review][Patch] Unknown-route metric labels fall back to raw `req.url`, allowing high-cardinality labels and query strings instead of the AC-8 `__unknown__` fallback. [`apps/api/src/routes/metrics.ts:63`] — fixed 2026-06-27
- [x] [Review][Patch] `/metrics` loopback authorization uses `req.ip` while the app can enable `trustProxy`, allowing spoofed `X-Forwarded-For` headers to bypass the AC-9 loopback gate. [`apps/api/src/routes/metrics.ts:54`, `apps/api/src/app.ts:65`] — fixed 2026-06-27
- [x] [Review][Patch] Bare root logger error paths can emit non-FR82 log lines without `traceId` and with `eventType: system.untyped` on unexpected request errors or shutdown failures. [`apps/api/src/app.ts:100`, `apps/api/src/lib/shutdown.ts:23`] — fixed 2026-06-27
- [x] [Review][Patch] The reference job logging integration hardcodes `jobId: "unknown"`, so `job.started/completed/failed` logs do not carry the AC-10 job identifier. [`apps/api/src/main.ts:88`] — fixed 2026-06-27
- [x] [Review][Patch] The top-level `main().catch()` always writes unstructured stderr, including failures that occur after a structured logger exists, which violates the AC-11 fatal stderr constraint. [`apps/api/src/main.ts:120`] — fixed 2026-06-27
- [x] [Review][Patch] Non-Error job failure serialization calls `String(err)` outside a guard; a throwing `toString()` can replace the original worker failure instead of preserving pg-boss retry/DLQ behavior. [`apps/api/src/lib/job-logging.ts:13`] — fixed 2026-06-27

---

### Out of Scope (Explicit)

| Item | Owner story |
|---|---|
| `audit_log_operational` DB table | Architecture future / Epic 8+ |
| Sentry / OpenTelemetry / Grafana dashboards | v1.1+ |
| Custom ESLint `no-literal-event-type` rule | Optional follow-up |
| `pgboss_queue_depth`, SSE metrics | Architecture lists — add when pg-boss/SSE wired |
| Secret fetch latency histogram | Epic 2 |
| Log shipping sidecar (Fluent Bit, Vector) | Deployment guide / Epic 9 |
| Web frontend logging | SvelteKit separate concern |
| Replacing all Story 1.6–1.9 log calls | Those stories own business logs; 1.10 owns **infrastructure** — provide helpers + migrate vault routes only |

**Post-merge checklist (run after Story 1.10 merges to branch):**

- [ ] `rg -n "event:" apps/api/src/modules apps/api/src/routes` — any remaining `event:` keys (old vault pattern) must be migrated to `eventType:`
- [ ] `rg -n "eventType: '" apps/api/src` — any hardcoded string literals (not `OperationalEvent.*`) must be replaced with registry constants
- [ ] Verify Story 1.10 is merged **before** Stories 1.6–1.9 auth log calls are finalized — those stories must import `OperationalEvent` from `@project-vault/shared`, not define their own strings
- [ ] Open follow-up tasks for any auth/session/job log calls found that use ad-hoc strings

---

### Anti-Patterns (Do Not)

- Use `console.log` / `console.error` — ESLint `no-console` fails CI
- Log `req.body` on auth or vault routes at info level
- Use `event` key instead of `eventType` on new logs
- Store operational events in `audit_log_entries` — different classification (architecture)
- Reuse `AuditEvent` constants for Pino stdout logs
- Keep `http_request_duration_ms` alongside seconds — pick seconds only
- Log `DATABASE_URL`, JWTs, TOTP codes, recovery codes, passphrases
- Use Fastify default request logging alongside custom hook (duplicate lines)
- Bind metrics on a separate port without updating docker-compose docs
- Skip UUID validation on incoming `X-Request-ID`
- Add high-cardinality labels (user ID, org ID) to Prometheus metrics in v1
- Emit logs without `message` string (breaks FR82 human readability)
- Use `process.stderr.write` after logger initialized (except fatal env parse)
- Pass `err.message` or any error-derived string as the `message` parameter to `operationalLog()` — ORM/driver errors may contain SQL fragments or partial data values; use a static string and put error detail in `fields`
- Interpolate user-supplied values (email, username, IP, user ID) into log message strings via template literals — template literals bypass Pino redaction; always use structured fields
- Include `metricsBindHost` / `METRICS_BIND_HOST` value in `startup.complete` log — reveals security posture to all log readers; the `startup.metrics_exposed` warn (AC-2) is the correct signal
- Rely on `req.ip` for `/metrics` loopback authorization when `trustProxy` can be enabled; proxy headers are attacker-controlled unless authorization uses the raw socket address or another non-spoofable source
- Treat operational Pino logs as compliance-grade audit evidence
- Add a route accepting sensitive nested or array payloads without updating redaction paths and tests for that exact shape

---

### Manual QA Checklist

```bash
# 1. Start API with JSON logs visible
LOG_LEVEL=info pnpm --filter @project-vault/api dev

# 2. Hit health — verify structured log line
curl -s -H 'X-Request-ID: 11111111-1111-4111-8111-111111111111' http://localhost:3000/health
# → check stdout for eventType:http.request, traceId matches header

# 3. Verify metrics from loopback (inside same network namespace)
curl -s -H 'Host: 127.0.0.1' http://127.0.0.1:3000/metrics | grep -E '^(process_uptime_seconds|http_requests_total|http_request_duration_seconds|vault_sealed|db_pool_connections_active)'

# 4. Verify non-loopback blocked (simulate with inject test or custom curl --interface if available)

# 5. Redaction — unseal with wrong body (dev vault initialized)
curl -s -X POST http://localhost:3000/api/v1/vault/unseal \
  -H 'Content-Type: application/json' \
  -d '{"kmsType":"passphrase","passphrase":"wrong-secret-12","masterKeyPath":"/tmp/x"}'
# → logs must NOT contain wrong-secret-12

# 6. Docker compose — exec into api container
docker compose exec api wget -qO- http://127.0.0.1:3000/metrics | head -20

# 7. Compliance language sanity check
rg -n "audit ready|audit log|compliance evidence|tamper" apps/api packages/shared _bmad-output/implementation-artifacts/1-10-structured-operational-logging-and-metrics.md
# → verify any references clearly distinguish operational logs from security audit logs
```

---

### Project Structure Notes

| What | Where |
|---|---|
| Logger config factory | `apps/api/src/lib/logger.ts` |
| Operational event constants | `packages/shared/src/constants/operational-event-types.ts` |
| HTTP request hook | `apps/api/src/plugins/structured-logging.ts` |
| Prometheus metrics | `apps/api/src/routes/metrics.ts` |
| DB pool gauge | `apps/api/src/lib/db-pool-metrics.ts` |
| Job log wrapper | `apps/api/src/lib/job-logging.ts` |
| Log capture test helper | `apps/api/src/__tests__/helpers/capture-logs.ts` |
| Schema validation test | `apps/api/src/__tests__/structured-log-schema.test.ts` |
| Redaction test | `apps/api/src/__tests__/structured-log-redaction.test.ts` |

**vitest coverage:** Add new files to `apps/api/vitest.config.ts` `coverage.include` array.

**BossService:** Job logging wrapper is ready for 1.7/1.9 workers — import `withJobLogging` in worker handlers when those stories merge.

---

### Previous Story Intelligence

#### From Story 1.3 (Docker & metrics baseline)

- `/metrics` loopback check via `req.ip` — **preserve exactly**
- `METRICS_BIND_HOST` already in env — extend, don't duplicate
- Story 1.3 was verification-heavy; 1.10 is **net-new Pino infrastructure** + metrics completion

#### From Story 1.5 (Vault & redaction)

- `redactBodyForLog()` exists — extend field list, integrate into Pino paths
- Vault routes use `event:` key — migrate to `OperationalEvent.*`
- `vault-log-redaction.test.ts` tests helper only — add end-to-end capture test in 1.10

#### From Story 1.7 (Sessions & pg-boss)

- Job logging pattern: `eventType: 'job.completed'|'job.failed'` — formalize in `withJobLogging()`
- `session.activity_touch_failed` — add to operational registry

#### From Story 1.9 (Failed auth & MFA)

- `alert.pending_epic3`, `security.mfa_enrollment_required_denied`, `security.failed_auth_threshold_no_org` — registry entries + redaction review for `attemptedEmail`
- Threshold job defers notification — operational log is **intentional** visibility until Epic 3

---

### Git Intelligence Summary

Recent commits (`d8e82e1`, `b97e481`) established DB/RLS foundation. Metrics and partial logging exist on feature branch (`apps/api/src/routes/metrics.ts`, `app.ts` with basic `LOG_LEVEL`). Story 1.10 should **extend** these files rather than recreate. Auth module logs from Stories 1.6–1.9 may land in parallel — provide shared infrastructure first.

---

### Latest Tech Information

| Technology | Version | Story impact |
|---|---|---|
| Fastify | ^5.8.5 | `requestIdHeader`, `genReqId`, `disableRequestLogging`, `reply.elapsedTime` |
| Pino | ^9.7.0 | `redact.paths`, custom `timestamp`, `messageKey` |
| prom-client | ^15.1.3 | Histogram/Counter/Gauge; `register.contentType` for Prometheus text |
| Node.js | 24.x | `crypto.randomUUID()` for trace IDs |

**Fastify 5 note:** `reply.elapsedTime` available in `onResponse` hook for duration metrics/logging.

---

### References

- Epic AC: [_bmad-output/planning-artifacts/epics.md#Story-1.10-Structured-Operational-Logging--Metrics_]
- AC-E1b FR82 schema: [_bmad-output/planning-artifacts/epics.md#Epic-1_]
- FR82: [_bmad-output/planning-artifacts/prd.md#Functional-Requirements_]
- NFR-MAINT4: [_bmad-output/planning-artifacts/epics.md_]
- Architecture logging: [_bmad-output/planning-artifacts/architecture.md#Infrastructure--Deployment_]
- Story 1.3 baseline: [_bmad-output/implementation-artifacts/1-3-docker-deployment-and-health-endpoints.md_]
- Story 1.5 redaction: [_bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md#AC-25_]
- Story 1.9 deferred logs: [_bmad-output/implementation-artifacts/1-9-mfa-role-enforcement-and-failed-authentication-detection.md_]
- Fastify logging docs: [https://fastify.io/docs/latest/Reference/Logging/](https://fastify.io/docs/latest/Reference/Logging/)

---

## Dev Agent Record

### Agent Model Used

GPT-5.5

### Debug Log References

- 2026-06-27: Resumed suspended Story 1.10; loaded BMad config, story, sprint status, and `specs/operational-logging-and-metrics.md`.
- 2026-06-27: Confirmed focused logger/env tests pass: `pnpm --filter @project-vault/api exec vitest run src/lib/logger.test.ts src/config/env.test.ts`.
- 2026-06-27: Added structured logging integration tests, confirmed red failure on missing request-id/header/log wiring, implemented Fastify logger/request-id/plugin wiring, then confirmed green with focused logging suite.
- 2026-06-27: Confirmed shared operational event registry test passes: `pnpm --filter @project-vault/shared exec vitest run src/constants/operational-event-types.test.ts`.
- 2026-06-27: Added structured redaction tests, confirmed red failure for `body.value`, added missing Pino wildcard path, then confirmed redaction tests pass.
- 2026-06-27: Added vault operational logging test, confirmed red failure for legacy `event` key, migrated vault route logs to `OperationalEvent.*`, and confirmed HTTP/vault logging tests pass.
- 2026-06-27: Added metrics and DB pool instrumentation tests, confirmed red failures for old `_ms` histogram/missing DB module, implemented seconds histogram, vault/db gauges, duration observation, and startup DB pool instrumentation.
- 2026-06-27: Added job logging wrapper tests, confirmed red missing-module failure, implemented `withJobLogging()`, wired the failed-auth pruning worker as the reference worker, and confirmed job/BossService tests pass.
- 2026-06-27: Ran `pnpm --filter @project-vault/api typecheck` and fixed test/helper typings until clean.
- 2026-06-27: Added DB error and shutdown lifecycle log tests, confirmed red failures, implemented structured `db.error`, `shutdown.signal_received`, `shutdown.complete`, and startup lifecycle logs.
- 2026-06-27: Updated Vitest coverage include paths and confirmed focused Story 1.10 API/shared tests pass.
- 2026-06-27: Confirmed `check-env-example.ts` red failure for missing `SERVICE_NAME`, updated `.env.example`, and reran env parity successfully.
- 2026-06-27: Final validation passed: `pnpm --filter @project-vault/api test`, `pnpm --filter @project-vault/shared exec vitest run`, `pnpm --filter @project-vault/api typecheck`, `pnpm --filter @project-vault/api lint`, and `pnpm exec tsx scripts/check-env-example.ts`. API lint passes with pre-existing warnings only.

### Completion Notes List

- Completed logger foundation: shared `OperationalEvent` registry and `SYSTEM_TRACE_ID`, API logger config with required JSON fields/redaction config, `operationalLog()` sentinel trace behavior, `SERVICE_NAME` env validation/defaults, and root Fastify structured logging registration.
- Fastify now validates `X-Request-ID` itself by disabling blind built-in header trust and generating UUID v4 IDs when callers provide invalid values.
- Added integration coverage for `http.request` schema fields, response `X-Request-ID`, valid request-id propagation, invalid request-id regeneration, and zero `system.untyped` lines in normal request flow.
- Completed Pino redaction path coverage for request-shaped payloads and one-level structured handler payloads, including `value` fields.
- Completed HTTP request logging wiring and vault route migration from legacy `event` fields to registry-backed `eventType` fields.
- Completed Prometheus metric set required by Story 1.10, including `http_request_duration_seconds` buckets, `vault_sealed`, and `db_pool_connections_active`.
- Completed background job logging wrapper for started/completed/failed lifecycle events, including original error rethrow and non-Error throw serialization fallback.
- Completed structured lifecycle and DB error logging; removed the unstructured vault startup status stderr write from normal startup.
- Completed Story 1.10 focused unit/integration coverage and coverage configuration for new implementation files.
- Documented Story 1.10 operational logging and metrics environment settings in `.env.example`; env schema/example parity passes.

### File List

- apps/api/src/__tests__/helpers/capture-logs.ts
- apps/api/src/__tests__/structured-log-redaction.test.ts
- apps/api/src/__tests__/structured-logging.integration.test.ts
- apps/api/src/__tests__/vault-operational-logging.test.ts
- apps/api/src/app.ts
- apps/api/src/config/env.test.ts
- apps/api/src/config/env.ts
- apps/api/src/lib/boss.test.ts
- apps/api/src/lib/boss.ts
- apps/api/src/lib/db-pool-metrics.test.ts
- apps/api/src/lib/db-pool-metrics.ts
- apps/api/src/lib/job-logging.test.ts
- apps/api/src/lib/job-logging.ts
- apps/api/src/lib/logger.test.ts
- apps/api/src/lib/logger.ts
- apps/api/src/lib/redact-paths.ts
- apps/api/src/lib/shutdown.test.ts
- apps/api/src/lib/shutdown.ts
- apps/api/src/main.ts
- apps/api/src/modules/vault/routes.ts
- apps/api/src/plugins/http-metrics.ts
- apps/api/src/plugins/structured-logging.ts
- apps/api/src/routes/health.test.ts
- apps/api/src/routes/health.ts
- apps/api/src/routes/metrics.test.ts
- apps/api/src/routes/metrics.ts
- apps/api/vitest.config.ts
- .env.example

### Change Log

- 2026-06-27: Completed structured operational logging and metrics implementation; story moved to review.
- packages/shared/src/constants/operational-event-types.test.ts
- packages/shared/src/constants/operational-event-types.ts
- packages/shared/src/index.ts
