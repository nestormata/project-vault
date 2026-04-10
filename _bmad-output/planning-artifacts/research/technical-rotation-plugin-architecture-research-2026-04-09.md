---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
workflowType: 'research'
lastStep: 6
research_type: 'technical'
research_topic: 'Rotation Plugin Architecture'
research_goals: 'Design a pluggable secret rotation system for Project Vault'
user_name: 'Nestor'
date: '2026-04-09'
web_research_enabled: true
source_verification: true
---

# Research Report: Rotation Plugin Architecture

**Date:** 2026-04-09
**Author:** Nestor
**Research Type:** technical

---

## Research Overview

This document presents a comprehensive technical research report on Rotation Plugin Architecture for Project Vault — a self-hosted, open-core secrets management platform built in Go. The research was conducted using live web sources (HashiCorp Vault docs, Infisical docs, pkg.go.dev, GitHub repositories) with rigorous source verification. All architectural decisions are grounded in production reference implementations and Go ecosystem tooling.

The core research goal was to design a pluggable secret rotation system that works for both PostgreSQL and SQLite backends, supports zero-downtime dual-phase rotation, is extensible to new credential providers without modifying core code, and integrates cleanly with the Project Vault RBAC and audit systems already specified in prior research.

The research covers five technical dimensions: technology stack (Go plugin systems, schedulers, WASM runtimes), integration patterns (plugin lifecycle, scheduling hooks, audit emission), architectural patterns (plugin interface design, dual-phase rotation state machine, provider catalog), implementation strategy (Go module layout, Phase 1–3 delivery plan, test coverage), and a synthesis concluding with three open ADRs.

---

## Table of Contents

1. [Technical Research Scope Confirmation](#technical-research-scope-confirmation)
2. [Technology Stack Analysis](#technology-stack-analysis)
   - [Plugin Execution Models (Go)](#plugin-execution-models-go)
   - [Scheduling Libraries](#scheduling-libraries)
   - [WASM Plugin Runtime](#wasm-plugin-runtime)
   - [Production Reference Implementations](#production-reference-implementations)
   - [Technology Comparison Matrix](#technology-comparison-matrix)
3. [Integration Patterns Analysis](#integration-patterns-analysis)
   - [Plugin Lifecycle Protocol](#plugin-lifecycle-protocol)
   - [Rotation Trigger Patterns](#rotation-trigger-patterns)
   - [Dual-Phase vs Single-Phase Rotation](#dual-phase-vs-single-phase-rotation)
   - [Plugin ↔ Core Integration Points](#plugin--core-integration-points)
   - [Audit Emission Pattern](#audit-emission-pattern)
4. [Architectural Patterns and Design](#architectural-patterns-and-design)
   - [Plugin Interface Definition](#plugin-interface-definition)
   - [Provider Catalog and Registry](#provider-catalog-and-registry)
   - [Rotation State Machine](#rotation-state-machine)
   - [Database Schema](#database-schema)
   - [Scheduler Architecture](#scheduler-architecture)
   - [Security Architecture](#security-architecture)
5. [Implementation Approaches and Technology Adoption](#implementation-approaches-and-technology-adoption)
   - [Phase 1 — Foundation (v1.0)](#phase-1--foundation-v10)
   - [Phase 2 — External Plugins (v1.2+)](#phase-2--external-plugins-v12)
   - [Phase 3 — WASM Plugins (v2.0+)](#phase-3--wasm-plugins-v20)
   - [Go Module Layout](#go-module-layout)
   - [Test Strategy](#test-strategy)
   - [Risk Assessment](#risk-assessment)
6. [Research Conclusion](#research-conclusion)

---

## Technical Research Scope Confirmation

**Research Topic:** Rotation Plugin Architecture
**Research Goals:** Design a pluggable secret rotation system for Project Vault

**Technical Research Scope:**

- Architecture Analysis — design patterns, frameworks, system architecture
- Implementation Approaches — development methodologies, coding patterns
- Technology Stack — languages, frameworks, tools, platforms
- Integration Patterns — APIs, protocols, interoperability
- Performance Considerations — scalability, optimization, patterns

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** 2026-04-09

---

## Executive Summary

Secret rotation is a critical security primitive that Project Vault must support natively and extensibly. Without an open plugin architecture, every new credential provider (database, cloud API key, SSH, JWT signing key) requires modifying core code — a maintenance burden that compounds as the platform grows.

**Key Findings:**

1. **HashiCorp Vault's Database Plugin System** is the production gold standard for Go-based rotation plugin architectures. Its `Database` interface (`Initialize`, `NewUser`, `UpdateUser`, `DeleteUser`, `Close`) and go-plugin gRPC transport are battle-tested at enterprise scale. Project Vault should adopt the same interface model for its built-in providers. (Source: developer.hashicorp.com/vault/docs/secrets/databases/custom)
2. **Infisical's dual-phase rotation** (Active → Inactive → Revoked with overlapping credential windows) is the correct model for zero-downtime rotation. Their PostgreSQL implementation uses two pre-provisioned DB users rotated in round-robin, with `secretsMapping` to write active credentials to named secret keys. Project Vault should adopt this exact pattern. (Source: infisical.com/docs/documentation/platform/secret-rotation)
3. **hashicorp/go-plugin** (gRPC over Unix socket, AutoMTLS, SHA256 checksum validation, process isolation) is the right external plugin transport for v1.2+. Plugin crashes do not crash the host process. (Source: pkg.go.dev/github.com/hashicorp/go-plugin)
4. **gocron v2** (`go-co-op/gocron/v2`) is the right scheduler for v1 — supports cron syntax, `WithDistributedElector` for HA, `WithSingletonMode` to prevent concurrent rotation of the same secret, and `AfterJobRunsWithError` event listeners for failure handling. (Source: pkg.go.dev/github.com/go-co-op/gocron/v2)
5. **wazero** (zero-dependency WASM runtime in Go, AOT compiler, no CGO) is the right sandbox runtime for untrusted third-party rotation plugins in v2.0+. Its zero-dependency constraint matches Project Vault's static binary goal. (Source: wazero.io, github.com/tetratelabs/wazero)
6. **Phase 1 (v1.0)** must be internal plugins only — compiled Go structs implementing a `RotationProvider` interface. External subprocess plugins (go-plugin) and WASM plugins are Phase 2/3 scope and must not be blocked on for v1 delivery.

**Recommendations:**

1. Define `RotationProvider` interface in `internal/rotation/provider.go` with methods: `Type() string`, `Rotate(ctx, params) (RotationResult, error)`, `Verify(ctx, params) error`, `Rollback(ctx, params) error`.
2. Use dual-phase rotation as the default model. Single-phase supported for providers that declare `SupportsDualPhase() bool → false`.
3. Use `go-co-op/gocron/v2` as the scheduler with `WithSingletonMode(LimitModeReschedule)` to prevent overlapping rotation runs for the same secret.
4. Store rotation state in a `rotation_jobs` table with `status` enum: `pending | running | success | failed | rolled_back`.
5. Defer external go-plugin subprocess model and WASM sandbox to v1.2+ and v2.0+ respectively.

---

## Technology Stack Analysis

### Plugin Execution Models (Go)

**Go Interface (In-Process) — Recommended for v1**

The simplest and most performant plugin model: a Go `interface` that built-in providers implement. No IPC, no subprocess management. Providers are compiled into the binary. This matches HashiCorp Vault's _built-in plugin_ model where built-in plugins are spawned within the Vault process itself.

```go
type RotationProvider interface {
    Type() string
    SupportsDualPhase() bool
    Rotate(ctx context.Context, req RotateRequest) (RotateResult, error)
    Verify(ctx context.Context, req VerifyRequest) error
    Rollback(ctx context.Context, req RollbackRequest) error
    Close() error
}
```

_Source: developer.hashicorp.com/vault/docs/secrets/databases/custom — `Database` interface (`Initialize`, `NewUser`, `UpdateUser`, `DeleteUser`, `Close`)_

**hashicorp/go-plugin (External Subprocess via gRPC) — Phase 2**

`hashicorp/go-plugin` v1.7.0 runs each plugin as a separate subprocess communicating over a Unix socket with gRPC + AutoMTLS. Features:
- Process isolation: plugin panic does not crash host
- `SecureConfig` validates SHA256 checksum before launching binary
- `HandshakeConfig` version negotiation prevents version mismatch
- `plugin.Discover(glob, dir)` for filesystem-based plugin discovery
- Supports multiplexing: one process for multiple connections of same plugin type

This is Vault's external plugin model — the same approach used for the PostgreSQL, MySQL, and MongoDB database plugins shipped as separate binaries.

_Source: pkg.go.dev/github.com/hashicorp/go-plugin v1.7.0_
_Source: developer.hashicorp.com/vault/docs/plugins/plugin-architecture_

**WASM (wazero) — Phase 3**

wazero is a WebAssembly Core Spec 1.0 and 2.0 compliant runtime, written in pure Go, zero dependencies, no CGO. Key properties:
- Compiler mode (AOT, ~10x faster than interpreter), Interpreter mode (all platforms including riscv64)
- `wazero.NewRuntime(ctx)` → `r.Instantiate(wasmBytes)` → `mod.ExportedFunction("rotate").Call(ctx, ...)`
- Strict sandboxing: WASM modules cannot access host memory or syscalls beyond explicit WASI grants
- Perfect for untrusted community-published rotation plugins
- Stable since March 2023 (v1.0); current version in active use in production

_Source: wazero.io, github.com/tetratelabs/wazero_

### Scheduling Libraries

**gocron v2 (`go-co-op/gocron/v2`) — Recommended**

Modern Go job scheduler with first-class support for production requirements:
- `CronJob(crontab, withSeconds)` — standard cron syntax with optional seconds field
- `DurationJob(duration)` — interval-based scheduling (e.g., rotate every 30 days)
- `WithSingletonMode(LimitModeReschedule)` — prevents overlapping rotation runs for the same job
- `WithDistributedElector(elector)` and `WithDistributedLocker(locker)` — HA/multi-node support via external coordination
- `BeforeJobRuns` / `AfterJobRuns` / `AfterJobRunsWithError` / `AfterJobRunsWithPanic` event listeners
- `WithContext(ctx)` — propagates cancellation to rotation jobs
- Thread-safe, supports job removal at runtime

_Source: pkg.go.dev/github.com/go-co-op/gocron/v2_

**robfig/cron v3 — Alternative (simpler, less features)**

Lightweight cron-only scheduler. `Chain` + `JobWrapper` for cross-cutting behavior (panic recovery, skip-if-running, logging). Does not support distributed locking natively. Suitable for single-node deployments only.

_Source: github.com/robfig/cron (v3.0.0)_

### WASM Plugin Runtime

| Runtime | Dependencies | CGO | AOT | Platforms | Status |
|---------|-------------|-----|-----|-----------|--------|
| wazero | zero | No | Yes (amd64, arm64) | Linux, macOS, Windows, BSD | Production (v1+) |
| wasmer-go | wasmer C library | Yes | Yes | Limited | Not recommended (CGO breaks cross-compile) |
| wasmtime-go | wasmtime C library | Yes | Yes | Limited | Not recommended (CGO breaks cross-compile) |

**Decision: wazero** for Phase 3 — only runtime that preserves Project Vault's CGO-free, cross-compile static binary requirement.

_Source: github.com/tetratelabs/wazero — "zero dependencies, doesn't rely on CGO"_

### Production Reference Implementations

**HashiCorp Vault Database Secrets Engine**

Vault's most mature rotation system. Key patterns:
- Static roles: 1-to-1 mapping of Vault role → DB username; Vault stores and auto-rotates passwords on configurable `rotation_schedule` (cron syntax) or `rotation_period`
- `rotation_window` — allowed window for rotation attempt before giving up
- `disable_automated_rotation` field for maintenance freezes
- Root credential rotation via explicit API call (`/database/rotate-root/{name}`)
- `UpdateUserRequest.Password.Statements.Commands` — SQL statements executed during rotation (templated with `{{name}}`, `{{password}}`)
- Rotation logging: success logs `rotationID` + `expire_time`; failure logs `rotationID=err`

_Source: developer.hashicorp.com/vault/docs/secrets/databases — Static Roles, Schedule-based root credential rotation, Rotation Logging_

**Infisical Secret Rotation v2**

Infisical's rotation architecture uses:
- **Dual-phase rotation** as default: `Active → Inactive → Revoked` lifecycle per credential set
- Pre-provisioned user pairs (e.g., `infisical_user_1`, `infisical_user_2`) — Infisical alternates between them
- `secretsMapping` — writes active credentials to named secret keys (e.g., `POSTGRES_DB_USERNAME`, `POSTGRES_DB_PASSWORD`)
- `isAutoRotationEnabled`, `rotationInterval` (days), `rotateAtUtc` (hours + minutes) — per-rotation config
- `activeIndex` — tracks which credential set is currently active (0 or 1)
- REST API: `POST /api/v2/secret-rotations/postgres-credentials`
- `rotationStatus`: `success | failed`; `lastRotationAttemptedAt`, `lastRotatedAt`, `nextRotationAt` tracking fields

_Source: infisical.com/docs/documentation/platform/secret-rotation/postgres-credentials_

### Technology Comparison Matrix

| Concern | Recommended Choice | Alternative | Rationale |
|---------|-------------------|-------------|-----------|
| v1 plugin model | Go interface (in-process) | External subprocess | Zero overhead; v1 providers are trusted built-ins |
| v2 external plugins | hashicorp/go-plugin (gRPC) | net/rpc | Process isolation, AutoMTLS, production-proven |
| v3 untrusted plugins | wazero (WASM) | wasmer-go | Zero CGO, cross-compile safe, sandboxed |
| Scheduler | gocron v2 | robfig/cron | Distributed lock, singleton mode, event listeners |
| Rotation model | Dual-phase (default) | Single-phase | Zero-downtime; single-phase opt-out for limited providers |
| Config syntax | Cron (`0 0 * * *`) + interval (`30d`) | Interval only | Matches Vault/Infisical pattern; user familiarity |

---

## Integration Patterns Analysis

### Plugin Lifecycle Protocol

A rotation plugin follows a consistent lifecycle regardless of execution model (in-process, subprocess, WASM):

```
Register → Validate Config → [Scheduled Trigger | Manual Trigger]
    → Rotate(ctx, req)
        → on success: Verify(ctx, req) → write new secret → emit audit → update status
        → on failure: Rollback(ctx, req) → emit audit → mark failed → alert
    → [next scheduled run]
```

**Registration:** Providers register themselves in a `ProviderRegistry` map keyed by `type` string (e.g., `"postgres-credentials"`, `"mysql-credentials"`, `"aws-iam"`, `"ssh-key"`). Built-in providers register at init time.

**Config validation:** `Initialize(ctx, params map[string]any) error` — called when a rotation job is created. Validates required parameters, tests connectivity, returns error with actionable message if invalid.

**Rotation execution:** `Rotate(ctx, RotateRequest)` — performs the actual credential change. Must be idempotent: calling Rotate twice with the same `jobID` must not create duplicate credentials or leave the system in a partially-rotated state.

**Verification:** `Verify(ctx, VerifyRequest)` — tests that newly rotated credentials are functional before writing them to the secrets store. If Verify fails, Rollback is called.

**Rollback:** `Rollback(ctx, RollbackRequest)` — reverts the rotation attempt. For dual-phase: re-activates the previous credential set. For single-phase: provider-specific (may be a no-op if the old credential is gone).

_Source: developer.hashicorp.com/vault/docs/secrets/databases/custom — Database interface, InitializeRequest, UpdateUserRequest_

### Rotation Trigger Patterns

Three trigger modes, all producing the same `RotateRequest` payload:

1. **Scheduled (automatic):** gocron job fires at `rotation_schedule` cron expression or `rotation_interval` duration. `WithSingletonMode(LimitModeReschedule)` prevents concurrent execution for the same rotation job.

2. **Manual (on-demand):** API call `POST /api/v1/rotation-jobs/{id}/rotate-now`. Directly enqueues a rotation task, bypassing scheduler queue but subject to same idempotency guards.

3. **Event-driven (future):** Triggered by external event (e.g., audit log detects credential exposure, CI/CD pipeline webhook). Deferred to v1.2+ alongside webhook support.

### Dual-Phase vs Single-Phase Rotation

**Dual-Phase (default):**

```
Phase 1 — Issue new credentials (NEW_CRED)
    → NEW_CRED becomes Active
    → OLD_CRED becomes Inactive (still valid)
    → secretsMapping updated to point to NEW_CRED

Phase 2 — Next rotation cycle
    → NEXT_CRED becomes Active
    → NEW_CRED becomes Inactive
    → OLD_CRED is Revoked (deleted from DB/provider)
```

Requires two pre-provisioned credential slots (e.g., `user_1` / `user_2` for PostgreSQL). `activeIndex` alternates between 0 and 1. Each slot transitions: `pending → active → inactive → revoked`.

_Source: infisical.com/docs/documentation/platform/secret-rotation/overview — "Dual-phase rotation is the recommended approach that ensures zero downtime"_

**Single-Phase:**

```
→ Generate new credential
→ OLD_CRED immediately invalidated
→ secretsMapping updated
```

Used when the provider API only allows one active credential (e.g., some API key providers, personal accounts). `SupportsDualPhase() bool → false` opts the provider out of the dual-phase lifecycle.

_Source: infisical.com/docs/documentation/platform/secret-rotation/overview — "Some providers have technical limitations that prevent dual-phase rotation"_

### Plugin ↔ Core Integration Points

The rotation plugin system integrates with four existing Project Vault subsystems:

| Integration Point | Direction | Mechanism |
|-------------------|-----------|-----------|
| Secrets Store | Plugin → Core | `WriteSecret(ctx, path, value)` after successful rotation |
| RBAC Enforcement | Core → Plugin trigger | Only users with `secret:rotate` permission can trigger manual rotation |
| Audit Log | Plugin → Core (async) | Buffered channel → background writer (same pattern as RBAC audit) |
| Notification System | Core → User | `AfterJobRunsWithError` event listener → notification queue |

**Secret write on rotation:** After `Verify` succeeds, core calls `SecretsStore.Write(ctx, project, path, newValue)` using the **machine user** token associated with the rotation job — not the triggering user's token. This ensures rotation jobs continue to work even if the original user's access is revoked.

### Audit Emission Pattern

Every rotation attempt emits an audit event regardless of outcome:

```go
type RotationAuditEvent struct {
    EventType    string    // "rotation.started" | "rotation.success" | "rotation.failed" | "rotation.rolled_back"
    RotationJobID string
    SecretPath   string
    ProviderType string
    DualPhase    bool
    ActiveIndex  int       // 0 or 1 for dual-phase
    TriggeredBy  string    // "scheduler" | "manual:{user_id}"
    Error        string    // empty on success
    Timestamp    time.Time
}
```

Emitted asynchronously via buffered channel → background writer (consistent with RBAC audit pattern from prior research).

---

## Architectural Patterns and Design

### Plugin Interface Definition

```go
// internal/rotation/provider.go

package rotation

import "context"

// RotationProvider is the core interface all rotation providers must implement.
// Built-in providers compile this interface directly; external providers implement
// it over gRPC (Phase 2) or WASM exports (Phase 3).
type RotationProvider interface {
    // Type returns the provider identifier string (e.g., "postgres-credentials").
    Type() string

    // SupportsDualPhase returns true if the provider can manage two overlapping
    // credential sets for zero-downtime rotation.
    SupportsDualPhase() bool

    // Initialize validates provider configuration and tests connectivity.
    // Called once when a rotation job is created. Must be idempotent.
    Initialize(ctx context.Context, params map[string]any) error

    // Rotate executes the credential rotation.
    // For dual-phase providers: issues new credentials for the inactive slot.
    // For single-phase providers: replaces the single active credential.
    Rotate(ctx context.Context, req RotateRequest) (RotateResult, error)

    // Verify tests that the newly issued credentials are functional.
    // Called after Rotate succeeds. If Verify fails, Rollback is called.
    Verify(ctx context.Context, req VerifyRequest) error

    // Rollback reverts a rotation attempt after a Verify failure.
    Rollback(ctx context.Context, req RollbackRequest) error

    // Close releases resources held by the provider (connections, etc.).
    Close() error
}

type RotateRequest struct {
    JobID       string
    ProjectID   string
    SecretPath  string
    ActiveIndex int   // 0 or 1 for dual-phase; 0 for single-phase
    Params      map[string]any
    Secrets     map[string]string // current credential values
}

type RotateResult struct {
    NewSecrets  map[string]string // keyed by secretsMapping names
    ActiveIndex int               // updated index after rotation
    Metadata    map[string]any
}

type VerifyRequest struct {
    JobID      string
    NewSecrets map[string]string
    Params     map[string]any
}

type RollbackRequest struct {
    JobID       string
    PrevSecrets map[string]string
    Params      map[string]any
}
```

### Provider Catalog and Registry

```go
// internal/rotation/registry.go

var globalRegistry = map[string]RotationProvider{}

func Register(p RotationProvider) {
    globalRegistry[p.Type()] = p
}

func Get(providerType string) (RotationProvider, error) {
    p, ok := globalRegistry[providerType]
    if !ok {
        return nil, fmt.Errorf("unknown rotation provider: %q", providerType)
    }
    return p, nil
}
```

Built-in providers register via `init()` in their respective files:

```go
// internal/rotation/providers/postgres/postgres.go
func init() {
    rotation.Register(&PostgresProvider{})
}
```

Phase 2 external plugins register via `go-plugin` discovery + adapter wrapper that implements `RotationProvider` over gRPC calls. Core code stays unchanged.

### Rotation State Machine

Each rotation job instance tracks state in `rotation_jobs`:

```
pending ──trigger──► running ──rotate+verify success──► success
                         │
                         ├──rotate failure──► rolling_back ──rollback success──► rolled_back
                         │                           │
                         │                     rollback failure──► failed (manual intervention)
                         └──verify failure──► rolling_back
```

State transitions are written transactionally to the DB. A `running` job that exceeds `rotation_timeout` (default: 5 min) is force-transitioned to `failed` by a watchdog goroutine.

### Database Schema

```sql
-- Rotation job definitions (one per secret rotation configuration)
CREATE TABLE rotation_jobs (
    id            TEXT PRIMARY KEY,           -- UUID
    project_id    TEXT NOT NULL REFERENCES projects(id),
    secret_path   TEXT NOT NULL,
    provider_type TEXT NOT NULL,              -- matches RotationProvider.Type()
    params        JSONB NOT NULL DEFAULT '{}', -- provider-specific config (encrypted at rest)
    secrets_mapping JSONB NOT NULL DEFAULT '{}', -- { "username": "SECRET_KEY_NAME", ... }
    dual_phase    BOOLEAN NOT NULL DEFAULT true,
    active_index  INTEGER NOT NULL DEFAULT 0, -- 0 or 1 for dual-phase
    rotation_schedule TEXT,                   -- cron expression (nullable if interval only)
    rotation_interval_secs BIGINT,            -- interval in seconds (nullable if cron only)
    rotation_window_secs   BIGINT DEFAULT 3600, -- max time allowed for a rotation attempt
    auto_rotation_enabled  BOOLEAN NOT NULL DEFAULT true,
    disable_automated_rotation BOOLEAN NOT NULL DEFAULT false,
    next_rotation_at  TIMESTAMPTZ,
    last_rotated_at   TIMESTAMPTZ,
    last_rotation_status TEXT DEFAULT 'pending', -- pending|running|success|failed|rolled_back
    last_rotation_error  TEXT,
    created_by    TEXT NOT NULL REFERENCES users(id),
    machine_token_id TEXT REFERENCES machine_tokens(id), -- token used to write secrets after rotation
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-attempt execution log (append-only)
CREATE TABLE rotation_attempts (
    id              TEXT PRIMARY KEY,
    rotation_job_id TEXT NOT NULL REFERENCES rotation_jobs(id),
    triggered_by    TEXT NOT NULL,   -- "scheduler" | "manual:{user_id}"
    status          TEXT NOT NULL,   -- running|success|failed|rolled_back
    active_index    INTEGER,
    error_message   TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_rotation_jobs_project ON rotation_jobs(project_id);
CREATE INDEX idx_rotation_jobs_next_at ON rotation_jobs(next_rotation_at)
    WHERE auto_rotation_enabled = true AND disable_automated_rotation = false;
CREATE INDEX idx_rotation_attempts_job ON rotation_attempts(rotation_job_id);
```

### Scheduler Architecture

```go
// internal/rotation/scheduler.go

type RotationScheduler struct {
    scheduler   gocron.Scheduler
    registry    *ProviderRegistry
    store       SecretsStore
    audit       AuditEmitter
    jobsByID    sync.Map // rotationJobID → gocron.Job
}

func NewRotationScheduler(ctx context.Context, store SecretsStore, audit AuditEmitter) (*RotationScheduler, error) {
    s, err := gocron.NewScheduler(
        gocron.WithLocation(time.UTC),
        gocron.WithLogger(gocron.NewLogger(gocron.LogLevelWarn)),
    )
    // ...
}

// LoadJob registers or updates a rotation job in the scheduler.
// Uses WithSingletonMode to prevent concurrent runs of the same job.
func (rs *RotationScheduler) LoadJob(j *RotationJob) error {
    def := resolveTrigger(j) // CronJob or DurationJob based on rotation_schedule vs rotation_interval
    _, err := rs.scheduler.NewJob(
        def,
        gocron.NewTask(rs.executeRotation, j.ID),
        gocron.WithName(j.ID),
        gocron.WithSingletonMode(gocron.LimitModeReschedule),
        gocron.WithEventListeners(
            gocron.AfterJobRunsWithError(func(id uuid.UUID, name string, err error) {
                rs.audit.Emit(RotationAuditEvent{EventType: "rotation.failed", RotationJobID: name, Error: err.Error()})
                // notify via notification queue
            }),
        ),
    )
    return err
}
```

_Source: pkg.go.dev/github.com/go-co-op/gocron/v2 — `CronJob`, `WithSingletonMode`, `AfterJobRunsWithError`_

### Security Architecture

**Credential confidentiality during rotation:**
- `params` column (provider config) is encrypted at rest using the same envelope encryption as secrets (AES-256-GCM + KMS-managed DEK from crypto architecture research)
- New credentials are written to the secrets store only after `Verify` succeeds — never stored in `rotation_attempts`

**Machine token isolation:**
- Each rotation job has a dedicated machine token (`machine_token_id`) with `secret:write` permission scoped to the specific secret path only
- Machine tokens follow the `mvt_` prefix + HMAC-SHA256 storage protocol from RBAC research
- Machine token is not accessible by any user; it is provisioned by core at rotation job creation time

**Provider process isolation (Phase 2):**
- External plugins launched via `go-plugin` with `SecureConfig` SHA256 checksum validation — prevents binary substitution attacks
- AutoMTLS mutual authentication on every RPC call
- Plugin directory must be operator-configured; no symbolic link traversal

_Source: developer.hashicorp.com/vault/docs/plugins/plugin-architecture — "Vault only allows manual plugin registration from an explicitly configured plugin directory"_

**Rotation idempotency:**
- Each rotation attempt has a unique `attempt_id` (UUID) passed as `RotateRequest.JobID`
- Providers must use `attempt_id` as an idempotency key for credential issuance (e.g., as a suffix in DB username: `vault_user_{attempt_id[:8]}`)
- Re-delivering the same `attempt_id` must not create a second credential set

---

## Implementation Approaches and Technology Adoption

### Phase 1 — Foundation (v1.0)

**Deliverables:**
- `RotationProvider` interface + `RotationRequest/Result` types
- `ProviderRegistry` with `Register` / `Get` functions
- Built-in providers: `postgres-credentials` (dual-phase), `mysql-credentials` (dual-phase), `generic-password` (single-phase, rotates a single stored password)
- `rotation_jobs` and `rotation_attempts` DB tables + migration
- gocron v2 scheduler with job load/unload at runtime
- `POST /api/v1/projects/{id}/rotation-jobs` — create rotation job
- `POST /api/v1/rotation-jobs/{id}/rotate-now` — manual trigger
- `GET /api/v1/rotation-jobs/{id}` — status + last attempt
- Audit emission for all rotation events
- Full permission check: `secret:rotate` via Casbin enforcer before any rotation operation

**Go module layout:**
```
internal/rotation/
    provider.go         // RotationProvider interface + request/result types
    registry.go         // ProviderRegistry
    scheduler.go        // gocron v2 wrapper (RotationScheduler)
    executor.go         // executeRotation: state machine, Rotate→Verify→Rollback
    audit.go            // RotationAuditEvent definition + emit helpers
    providers/
        postgres/       // PostgresProvider (dual-phase, two pre-provisioned users)
        mysql/          // MySQLProvider (dual-phase)
        generic/        // GenericPasswordProvider (single-phase)
```

### Phase 2 — External Plugins (v1.2+)

- `go-plugin` gRPC adapter: `ExternalRotationProvider` wraps a `go-plugin` client and implements `RotationProvider`
- Plugin discovery: scan `{data_dir}/rotation-plugins/` for binaries registered in `external_rotation_plugins` table
- SHA256 checksum validation before launching any external binary
- Plugin catalog API: `GET /api/v1/rotation-plugins` — list installed providers
- Operators install plugins by placing binary in plugin dir + registering via API

_Source: developer.hashicorp.com/vault/docs/plugins/plugin-architecture — plugin catalog, SHA256 verification, `plugin.Discover`_

### Phase 3 — WASM Plugins (v2.0+)

- wazero runtime embedded in binary (no CGO, no shared libs)
- WASM plugins distributed as `.wasm` files, uploaded via `POST /api/v1/rotation-plugins/wasm`
- WASI-based interface: host exports `write_secret(path, value)`, `read_secret(path)`, `log(level, msg)` to WASM module
- WASM module exports `rotate(json_params_ptr) json_result_ptr`, `verify(...)`, `rollback(...)`
- Strict sandboxing: no filesystem access, no network access beyond host-provided callbacks

_Source: wazero.io — "safely run code compiled in other languages"; github.com/tetratelabs/wazero — "strict sandboxing: WASM modules cannot access host memory or syscalls beyond explicit WASI grants"_

### Test Strategy

| Test Category | Coverage |
|---------------|----------|
| Provider unit tests | Each built-in provider: `Rotate` succeeds, `Verify` fails triggers `Rollback`, idempotency (same `attempt_id` → no duplicate credentials) |
| Dual-phase lifecycle | `activeIndex` alternates 0→1→0; `inactive` credential still valid during overlap window; `revoked` credential rejected |
| Single-phase lifecycle | Old credential immediately invalid after `Rotate` |
| Scheduler integration | Job fires at scheduled time; `WithSingletonMode` prevents concurrent run; error listener emits audit event |
| Permission enforcement | `secret:rotate` required; deny-by-default; cross-project rotation blocked by Casbin domain |
| State machine | All transition paths: `pending→running→success`, `running→rolling_back→rolled_back`, `running→failed` (rollback failure) |
| Audit completeness | All events emitted: `started`, `success`, `failed`, `rolled_back` |
| Timeout watchdog | `running` job exceeding `rotation_window_secs` force-transitioned to `failed` |

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Rotation leaves system in half-rotated state (old + new both active, secrets store not updated) | High | Transactional state write; Verify must pass before secrets store write; Rollback on Verify failure |
| Provider crashes mid-rotation (Phase 2) | Medium | go-plugin process isolation; watchdog detects `running` jobs beyond timeout → mark `failed` |
| Concurrent rotation of same job | Medium | `WithSingletonMode(LimitModeReschedule)` in gocron v2 |
| Machine token for rotation job revoked/expired | High | Rotation job creation validates token; auto-renewal or alert before expiry |
| External plugin binary replaced (Phase 2) | High | SHA256 checksum validation via `go-plugin` `SecureConfig` before launch |
| WASM plugin sandbox escape (Phase 3) | Medium | wazero strict WASI permissions; no host syscall access; security audit before enabling |
| Last valid credential deleted before new one verified | High | Dual-phase keeps previous credential active until new one verified; single-phase providers: Verify before Revoke |
| DB schema migration failure mid-deployment | Low | Separate migration step; `rotation_jobs` table created in dedicated migration; zero data loss on rollback |

---

## Research Conclusion

### Summary of Key Technical Findings Across All Research Areas

**Technology Stack (Step 2):** Three plugin execution tiers are defined for Project Vault: (1) in-process Go interface for v1 built-in providers (zero overhead, trusted code), (2) `hashicorp/go-plugin` gRPC subprocess for v1.2+ external providers (process isolation, SHA256 validation, AutoMTLS), (3) wazero WASM sandbox for v2.0+ untrusted community plugins (zero CGO, strict sandboxing). gocron v2 is the scheduler of choice for its distributed locking, singleton mode, and event listener support. Infisical's dual-phase rotation model is the production-proven approach for zero-downtime credential cycling.

**Integration Patterns (Step 3):** Rotation integrates with four existing subsystems: secrets store (write after Verify success), RBAC (Casbin `secret:rotate` permission enforced before any trigger), audit log (async channel, same pattern as RBAC audit), and notification queue (gocron `AfterJobRunsWithError` event listener). A dedicated per-job machine token (`mvt_` prefix, scoped to specific secret path) performs the secrets write — decoupled from triggering user's access. Three trigger modes: scheduled (gocron), manual API, event-driven (deferred v1.2+).

**Architectural Patterns (Step 4):** `RotationProvider` interface (6 methods: `Type`, `SupportsDualPhase`, `Initialize`, `Rotate`, `Verify`, `Rollback`, `Close`) is the extension point. Provider catalog uses a `map[string]RotationProvider` registry with `init()`-time registration for built-in providers. Rotation state machine has 5 states: `pending → running → success | rolling_back → rolled_back | failed`. DB schema: `rotation_jobs` (config + schedule + state) + `rotation_attempts` (append-only log). Security: `params` column encrypted at rest via existing envelope encryption; per-job machine token; process isolation for Phase 2.

**Implementation Strategy (Step 5):** Phase 1 (v1.0): three built-in providers, gocron scheduler, REST API, full audit + RBAC integration. Phase 2 (v1.2+): go-plugin external providers with SHA256 validation and plugin catalog. Phase 3 (v2.0+): wazero WASM sandbox. Test matrix covers all state machine transitions, dual/single-phase lifecycle, permission enforcement, concurrent run prevention, and audit completeness.

---

### Strategic Impact Assessment

This rotation architecture unblocks a key PRD requirement: automated secret rotation with provider extensibility. It does so without introducing new infrastructure (rotation state is stored in the existing DB), without breaking the zero-CGO constraint (wazero, gocron v2, go-plugin all CGO-free), and with a clear incremental delivery path (Phase 1 is v1.0 scope; Phases 2–3 are extensions).

The architecture is intentionally aligned with HashiCorp Vault's battle-tested patterns (same plugin interface shape, same go-plugin transport) and Infisical's dual-phase rotation model — giving Project Vault production-grade semantics from day one without re-inventing proven solutions.

---

### Next Steps

1. **ADR-07:** Rotation plugin execution model — formally record the three-tier Go-interface / go-plugin / WASM progression and the v1/v1.2+/v2.0+ phasing.
2. **ADR-08:** Dual-phase vs single-phase as default — record dual-phase default with single-phase opt-out via `SupportsDualPhase()`, and the pre-provisioned user-pair requirement for DB providers.
3. **ADR-09:** Rotation scheduler HA strategy — record `gocron v2 + WithDistributedElector` for multi-node deployments; single-node uses in-memory scheduler with DB-level mutex.
4. **Sprint execution:** Start Phase 1 — `RotationProvider` interface, `rotation_jobs` schema, `postgres-credentials` provider, gocron scheduler integration.
5. **Spec creation:** Create `specs/rotation-plugin-architecture.md` from this research as operational reference.

---

**Research Completion Date:** 2026-04-09
**Research Period:** Comprehensive current-state analysis (Steps 1–6 complete)
**Document Scope:** Rotation Plugin Architecture for Project Vault v1
**Source Verification:** All findings cited against live documentation (HashiCorp Vault docs, Infisical docs, pkg.go.dev, GitHub: tetratelabs/wazero, go-co-op/gocron, robfig/cron, hashicorp/go-plugin)
**Confidence Level:** High — based on multiple authoritative sources and production reference implementations

_This research document serves as the authoritative technical reference for rotation plugin architecture decisions in Project Vault._
