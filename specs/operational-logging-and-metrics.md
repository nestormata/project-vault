# Operational Logging & Metrics — Project Vault API

**Version:** 1.0
**Date:** 2026-06-25
**Status:** Implementation-ready — derived from Story 1.10 elicitation (ADR-1.10-01 through ADR-1.10-04)
**Covers:** `apps/api` (Fastify 5 + Pino 9 + prom-client 15); FR82, NFR-MAINT4

---

## Overview

The API emits all operational events as single-line JSON to stdout (Pino) and exposes a Prometheus-compatible `/metrics` endpoint (prom-client). There is no second logging library, no Sentry, no OpenTelemetry in v1. Log shipping to an external aggregator is handled at the deployment layer (Epic 9 scope).

**Two distinct log streams — never conflate them:**

| Stream | Mechanism | Purpose |
|---|---|---|
| Operational logs | Pino → stdout JSON | FR82 visibility: requests, jobs, lifecycle events |
| Security audit log | `audit_log_entries` DB table | Tamper-evident record of security-sensitive actions (Epic 8) |

---

## Log Schema (FR82 Required Fields)

Every Pino log line is single-line JSON to stdout containing all of:

| Field | Type | Notes |
|---|---|---|
| `timestamp` | ISO 8601 string | Configured via Pino `timestamp` option |
| `level` | string | `trace\|debug\|info\|warn\|error\|fatal` |
| `service` | string | `env.SERVICE_NAME` — validated format (see below) |
| `traceId` | string | UUID for request logs; `'system'` sentinel for non-request logs |
| `eventType` | string | `domain.action` dot notation — must use `OperationalEvent.*` constants |
| `message` | string | Static human-readable string — never interpolate user input |

---

## Pino Configuration

### `createLoggerConfig(env, destination?)`

```typescript
// apps/api/src/lib/logger.ts
export function createLoggerConfig(
  env: Env,
  destination?: pino.DestinationStream
) {
  const config = {
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    messageKey: 'message',
    base: { service: env.SERVICE_NAME },
    redact: { paths: PINO_REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level(label: string) { return { level: label } },
    },
    mixin() { return { eventType: 'system.untyped' } },
  }
  return destination ? pino(config, destination) : config
}
```

**`destination` parameter:** `undefined` → Pino uses `process.stdout` (synchronous; may block under log-driver backpressure). Tests pass `createLogCaptureStream().stream`. Future production deployments pass `pino.transport(...)` for non-blocking worker-thread I/O.

### Fastify Integration

```typescript
// apps/api/src/app.ts
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const fastify = Fastify({
  logger: createLoggerConfig(env),
  requestIdHeader: 'x-request-id',
  genReqId(req) {
    const header = req.headers['x-request-id']
    const value = Array.isArray(header) ? header[0] : header
    // RFC 4122 v4 only — nil UUID and non-v4 formats intentionally rejected
    if (value && UUID_V4_RE.test(value)) return value
    return randomUUID()
  },
  disableRequestLogging: true, // custom onResponse hook handles http.request log
})
```

**Do not** use a looser regex for `X-Request-ID` validation — the nil UUID (`00000000-...`) and arbitrary 36-char strings are rejected by design.

---

## `SYSTEM_TRACE_ID` Sentinel

Non-request logs (startup, shutdown, jobs) must include `traceId` to satisfy FR82 required fields, but have no correlation UUID. The canonical sentinel:

```typescript
// packages/shared/src/constants/operational-event-types.ts
export const SYSTEM_TRACE_ID = 'system' as const
```

**Rules:**
- `operationalLog()` always injects `SYSTEM_TRACE_ID` — callers cannot override `traceId`
- Code running inside a request handler must use `request.log.child()` — never `operationalLog()`
- Log aggregator UUID filters must allowlist `'system'`

---

## `operationalLog()` Helper

```typescript
export function operationalLog(
  logger: FastifyBaseLogger,
  level: 'info' | 'warn' | 'error',
  eventType: string,
  message: string,          // MUST be a static string literal — never err.message or user input
  fields?: Record<string, unknown>
) {
  logger[level]({ eventType, traceId: SYSTEM_TRACE_ID, ...fields }, message)
}
```

**Critical constraint:** Never pass `err.message` or any error-derived string as `message`. ORM/driver errors may contain SQL fragments or partial data values. Always use a static string; put error detail in `fields` via `serializeError(err)`.

---

## OperationalEvent Registry

All `eventType` values are defined in `packages/shared/src/constants/operational-event-types.ts` as `OperationalEvent.*` constants. Never use hardcoded strings in application code.

**Naming convention:** `domain.action` dot notation, lowercase (e.g. `http.request`, `startup.complete`, `job.failed`).

**Key events:**

| Constant | Value | Emitted by |
|---|---|---|
| `HTTP_REQUEST` | `http.request` | `onResponse` hook |
| `STARTUP_COMPLETE` | `startup.complete` | `main.ts` after `fastify.listen()` |
| `STARTUP_METRICS_EXPOSED` | `startup.metrics_exposed` | `main.ts` when `METRICS_BIND_HOST=0.0.0.0` |
| `SHUTDOWN_SIGNAL` | `shutdown.signal_received` | `shutdown.ts` |
| `JOB_STARTED/COMPLETED/FAILED` | `job.*` | `withJobLogging()` wrapper |
| `VAULT_INIT/UNSEAL/SEAL` | `vault.*` | vault route handlers |
| `DB_ERROR` | `db.error` | DB failure catch blocks |

**`system.untyped` zero-tolerance:** This mixin default must never appear in a normal request flow. The integration test suite asserts zero `system.untyped` lines during `GET /health` — a CI failure here acts as a lint substitute until a custom ESLint rule is added.

---

## HTTP Request Logging

```typescript
// apps/api/src/plugins/structured-logging.ts
fastify.addHook('onRequest', async (request) => {
  request.log = request.log.child({ traceId: request.id })
})

fastify.addHook('onResponse', async (request, reply) => {
  request.log.info({
    eventType: OperationalEvent.HTTP_REQUEST,
    method: request.method,
    url: String(request.routeOptions?.url ?? request.url).slice(0, 256), // truncate — prevents log injection
    statusCode: reply.statusCode,
    responseTimeMs: reply.elapsedTime,
  }, 'request completed')
  reply.header('X-Request-ID', request.id)
})
```

**Invariants:**
- `url` field truncated to 256 characters — prevents log bloat from path-traversal probes
- Never log `request.body` or `reply.payload`
- Never log `Authorization`, `Cookie`, or JWT headers
- Never interpolate user values into message strings — template literals bypass Pino redaction

---

## Redaction Configuration

```typescript
export const PINO_REDACT_PATHS = [
  'req.headers.authorization', 'req.headers.cookie',
  'req.body.password', 'req.body.passphrase', 'req.body.masterKeyPath',
  'req.body.envelopeKeyPath', 'req.body.secret', 'req.body.value',
  'req.body.refreshToken', 'req.body.accessToken', 'req.body.totp',
  'req.body.recoveryCode', 'req.body.currentPassword', 'req.body.newPassword',
  '*.password', '*.passphrase', '*.secret', '*.masterKeyPath',
  '*.envelopeKeyPath', '*.recoveryCode', '*.totp',
  'attemptedEmail', 'attempted_email',
] as const
```

### Known Limitations

**Single-level wildcards:** `*.password` matches `body.password` but not `data.body.password`. Nested objects beyond one level require explicit paths.

**Array-indexed fields:** `*` is an object-key wildcard, not an array-index wildcard. A body like `{ "credentials": [{ "value": "secret" }] }` is not covered. Any route accepting arrays of objects with sensitive fields must add explicit paths or reject array payloads at schema validation.

**Template literal bypass:** Pino redaction operates on the bindings object, not on the string `message`. A `logger.warn(`Login failed for ${email}`)` call ships the email unredacted. Always use structured fields — never interpolate user values into log message strings.

---

## Prometheus Metrics

### Required Metrics (v1)

| Metric | Type | Labels |
|---|---|---|
| `process_uptime_seconds` | gauge | — |
| `http_requests_total` | counter | `method`, `route`, `status_code` |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` |
| `vault_sealed` | gauge | — |
| `db_pool_connections_active` | gauge | — |

**Histogram buckets (seconds):** `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5`

`http_request_duration_ms` was removed (Story 1.3 name) — breaking change documented in ADR-1.10-02.

### `vault_sealed` — Use `collect()` Callback

```typescript
export const vaultSealed = new Gauge({
  name: 'vault_sealed',
  help: '1 if vault is sealed or uninitialized, 0 if unsealed',
  collect() {
    // Fires on every scrape — always reflects current state.
    // Do NOT call vaultSealed.set() from state-change hooks; that pattern
    // introduces TOCTOU staleness between transitions.
    this.set(getVaultStatus() !== 'unsealed' ? 1 : 0)
  },
})
```

### `db_pool_connections_active` — Known Limitation

The `instrumentDbPool()` wrapper only counts queries routed through it. Postgres.js template-literal queries (`sql\`...\``) are not counted. Gauge correctly reads `0` at idle. Replace with native pool instrumentation in Epic 9.

### Metrics Access Control

```
METRICS_BIND_HOST=127.0.0.1 (default)  →  loopback check via req.ip  →  403 for non-loopback
METRICS_BIND_HOST=0.0.0.0              →  all origins allowed (sidecar scrape)
```

**`trustProxy` warning:** `req.ip` is safe for loopback gating only when Fastify `trustProxy` is `false` (default). If `trustProxy: true` is set globally, `req.ip` becomes the `X-Forwarded-For` header value — attacker-controlled. In that case, use `req.socket.remoteAddress` directly in `isLoopbackRemoteAddress()`.

---

## Environment Variables

| Variable | Default | Validation |
|---|---|---|
| `LOG_LEVEL` | `info` (prod/dev), `silent` when `NODE_ENV=test` | `fatal\|error\|warn\|info\|debug\|trace\|silent` |
| `METRICS_BIND_HOST` | `127.0.0.1` | `0.0.0.0` allows external scrape; emits `startup.metrics_exposed` warn |
| `SERVICE_NAME` | `api` | Must match `/^[a-z][a-z0-9_-]{0,63}$/` — reject startup if invalid. Prevents special chars reaching aggregator index names and Prometheus label values. |

**Production guards:**
- Reject startup when `NODE_ENV=production` and `LOG_LEVEL=debug` or `trace`
- `METRICS_BIND_HOST=0.0.0.0` emits `startup.metrics_exposed` warn — intentional override signal
- `metricsBindHost` value must **not** appear in the `startup.complete` log payload (security posture disclosure)

---

## Background Job Logging

```typescript
// apps/api/src/lib/job-logging.ts
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
      jobName, jobId, durationMs: Date.now() - start,
    })
    return result
  } catch (err) {
    let serialized: unknown
    try { serialized = serializeError(err) }
    catch { serialized = { message: String(err) } }    // guard: err may not be an Error instance
    operationalLog(logger, 'error', OperationalEvent.JOB_FAILED, 'job failed', {
      jobName, jobId, durationMs: Date.now() - start, err: serialized,
    })
    throw err  // rethrow original — never a wrapped copy; pg-boss retry/DLQ sees the correct failure
  }
}
```

**Log sensitivity:** `jobName` values (e.g. `'security:check-failed-auth-threshold'`) reveal internal security mechanism names. Log aggregator ACL is the primary control. For third-party SaaS aggregators, consider logging only a category at `info` level and the full name at `debug`.

---

## Test Patterns

### Log Capture Helper

```typescript
// apps/api/src/__tests__/helpers/capture-logs.ts
import { Writable } from 'node:stream'

export function createLogCaptureStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(chunk.toString()); cb() },
  })
  return { stream, lines }
}
```

**Always flush before asserting** — Pino's async buffer may not have flushed by the time assertions run:

```typescript
await app.inject({ method: 'GET', url: '/health' })
await app.log.flush()   // drain buffer before checking captured lines
expect(capturedLines.length).toBeGreaterThan(0)
```

Alternatively, configure the test Pino instance with `pino.destination({ sync: true })` — document the choice in `capture-logs.ts`.

### Key Test Assertions (AC-13)

- Every log line contains: `timestamp`, `level`, `service`, `traceId`, `eventType`, `message`
- Zero `system.untyped` lines during a normal `GET /health` flow
- `url` field length ≤ 256 when request path exceeds 256 chars
- `passphrase`, `secret`, `masterKeyPath`, `value` literals never appear as log values
- `X-Request-ID` header propagated to response and captured in `traceId`
- `GET /metrics` with `X-Forwarded-For: 127.0.0.1` from non-loopback returns `403`

---

## Security Constraints Summary

| Constraint | Detail |
|---|---|
| Static message strings only | Never `err.message` or user input in `message` param — may contain SQL fragments or PII |
| No template literal interpolation | `logger.warn(\`failed for ${email}\`)` bypasses redaction — always use structured fields |
| `metricsBindHost` not in startup log | Reveals security posture; use `startup.metrics_exposed` warn instead |
| `vault_sealed` via `collect()` | Avoids TOCTOU staleness; do not call `.set()` from state-change hooks |
| `UUID_V4_RE` for trace ID validation | RFC 4122 v4 only — nil UUID intentionally rejected |
| `SERVICE_NAME` format validated | `/^[a-z][a-z0-9_-]{0,63}$/` — fatal env error if invalid |
| `trustProxy` must be `false` globally | Or use `req.socket.remoteAddress` in loopback check |
| Array body fields not auto-redacted | Audit new routes; add explicit paths or reject at schema layer |
| `operationalLog()` injects `SYSTEM_TRACE_ID` | Callers cannot override `traceId`; request code uses `request.log` only |

---

## ADR Quick Reference

| ADR | Decision |
|---|---|
| ADR-1.10-01 | camelCase field names (`traceId`, `eventType`); `SYSTEM_TRACE_ID = 'system'` sentinel for non-request logs; caller-provided trace IDs are intentional (aggregator ACL is the security boundary) |
| ADR-1.10-02 | Rename `http_request_duration_ms` → `http_request_duration_seconds`; breaking change for pre-production scrapers |
| ADR-1.10-03 | Single HTTP listener with loopback `req.ip` check for metrics; not a separate port |
| ADR-1.10-04 | `disableRequestLogging: true` + custom `onResponse` hook — eliminates duplicate lines and adds `eventType` |

---

## Compliance Note (FR82)

Story 1.10 satisfies FR82 at the **application-layer emission** level only:
- Structured JSON stdout ✓
- Required fields on every line ✓
- Secret redaction ✓
- Configurable log level ✓
- Prometheus-compatible metrics ✓

**Log retention, queryability, and durability** depend on the deployment-layer log shipping pipeline (Fluent Bit, Vector, or equivalent — Epic 9 scope). Auditors must assess both Story 1.10 and the Epic 9 shipping/retention deliverable together.
