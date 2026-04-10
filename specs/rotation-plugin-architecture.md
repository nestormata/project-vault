# Rotation Plugin Architecture — Project Vault

**Version:** 1.0  
**Date:** 2026-04-09  
**Status:** Research-complete; pending ADR sign-off on three open decisions (ADR-07, ADR-08, ADR-09)  
**Source:** Technical research document `_bmad-output/planning-artifacts/research/technical-rotation-plugin-architecture-research-2026-04-09.md`

---

## Overview

Project Vault's rotation system uses a three-tier plugin model: (1) in-process Go interface for v1.0 built-in trusted providers, (2) `hashicorp/go-plugin` gRPC subprocess for v1.2+ external providers, and (3) wazero WASM sandbox for v2.0+ untrusted community plugins. The core `RotationProvider` interface is the single extension point — all three execution models implement it. Dual-phase rotation (Active → Inactive → Revoked with overlapping credential windows) is the default, enabling zero-downtime credential cycling following Infisical's production model. The scheduler uses `gocron v2` with `WithSingletonMode` to prevent concurrent rotation of the same secret.

---

## Plugin Execution Tiers

| Tier | Phase | Transport | When to use |
|------|-------|-----------|-------------|
| In-process Go interface | v1.0 | None (compiled in) | Built-in trusted providers (postgres, mysql, generic-password) |
| `hashicorp/go-plugin` gRPC | v1.2+ | Unix socket + AutoMTLS | Operator-installed external providers; process isolation required |
| wazero WASM sandbox | v2.0+ | WASI host interface | Untrusted community-published providers; strict sandboxing required |

**v1.0 scope:** Built-in providers only. External and WASM tiers are future extensions — the `RotationProvider` interface is stable so they can be added without changing core code.

---

## RotationProvider Interface

```go
// internal/rotation/provider.go

type RotationProvider interface {
    // Type returns the provider identifier (e.g., "postgres-credentials").
    Type() string

    // SupportsDualPhase returns true if the provider manages two overlapping
    // credential sets for zero-downtime rotation.
    SupportsDualPhase() bool

    // Initialize validates provider config and tests connectivity.
    // Called once when a rotation job is created. Must be idempotent.
    Initialize(ctx context.Context, params map[string]any) error

    // Rotate executes the credential rotation.
    // Dual-phase: issues new credentials for the inactive slot.
    // Single-phase: replaces the single active credential.
    Rotate(ctx context.Context, req RotateRequest) (RotateResult, error)

    // Verify tests that newly issued credentials are functional.
    // If Verify fails, Rollback is called.
    Verify(ctx context.Context, req VerifyRequest) error

    // Rollback reverts a rotation attempt after a Verify failure.
    Rollback(ctx context.Context, req RollbackRequest) error

    // Close releases provider resources.
    Close() error
}

type RotateRequest struct {
    JobID       string
    ProjectID   string
    SecretPath  string
    ActiveIndex int            // 0 or 1 for dual-phase; 0 for single-phase
    Params      map[string]any
    Secrets     map[string]string // current credential values
}

type RotateResult struct {
    NewSecrets  map[string]string // keyed by secretsMapping names
    ActiveIndex int               // updated index after rotation
    Metadata    map[string]any
}
```

---

## Provider Registry

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

Built-in providers register via `init()` in their respective packages:

```go
// internal/rotation/providers/postgres/postgres.go
func init() {
    rotation.Register(&PostgresProvider{})
}
```

Phase 2 external plugins register via a `go-plugin` adapter that wraps the gRPC client and implements `RotationProvider` — core code stays unchanged.

---

## Dual-Phase Rotation Model

Dual-phase is the **default** for all providers that return `SupportsDualPhase() bool → true`.

```
State transition:

Active(slot 0) ──rotate──► slot 1 becomes Active, slot 0 becomes Inactive
                         ──verify passes──► slot 0 becomes Revoked (old credentials deleted)

activeIndex alternates: 0 → 1 → 0 → 1 ...

Overlap window:
  During rotation: both slot 0 and slot 1 credentials are valid
  After Verify passes: slot 0 is revoked
  Zero-downtime: running applications using slot 0 continue to work until revocation
```

**PostgreSQL dual-phase pattern (Infisical reference):** Two pre-provisioned DB users (`vault_user_0`, `vault_user_1`). Vault alternates between them, changing the password of the inactive user, verifying the new credentials connect successfully, then revoking/expiring the old session.

`secretsMapping` in `rotation_jobs.secrets_mapping` JSONB column maps provider output keys to secret store key names:
```json
{
  "username": "POSTGRES_DB_USERNAME",
  "password": "POSTGRES_DB_PASSWORD",
  "host":     "POSTGRES_DB_HOST"
}
```

Single-phase opt-out: providers that declare `SupportsDualPhase() → false` rotate in-place. Old credential is immediately invalid after `Rotate` succeeds and `Verify` passes.

---

## Rotation State Machine

```
pending ──trigger──► running ──rotate+verify success──► success
                        │
                        ├──rotate failure──► rolling_back ──rollback success──► rolled_back
                        │                         │
                        │                   rollback failure──► failed (manual intervention)
                        └──verify failure──► rolling_back
```

State transitions are written transactionally to `rotation_attempts`. A `running` job exceeding `rotation_window_secs` (default: 5 min) is force-transitioned to `failed` by a watchdog goroutine.

---

## Scheduler

**Library:** `github.com/go-co-op/gocron/v2`

```go
go get github.com/go-co-op/gocron/v2
```

```go
// internal/rotation/scheduler.go

func (rs *RotationScheduler) LoadJob(j *RotationJob) error {
    def := resolveTrigger(j) // CronJob or DurationJob
    _, err := rs.scheduler.NewJob(
        def,
        gocron.NewTask(rs.executeRotation, j.ID),
        gocron.WithName(j.ID),
        gocron.WithSingletonMode(gocron.LimitModeReschedule), // no concurrent runs
        gocron.WithEventListeners(
            gocron.AfterJobRunsWithError(func(id uuid.UUID, name string, err error) {
                rs.audit.Emit(RotationAuditEvent{
                    EventType:     "rotation.failed",
                    RotationJobID: name,
                    Error:         err.Error(),
                })
            }),
        ),
    )
    return err
}
```

**Trigger types:**
- `rotation_schedule` (cron): `CronJob("0 2 * * *", false)` — rotate at 2am daily
- `rotation_interval_secs` (duration): `DurationJob(30 * 24 * time.Hour)` — rotate every 30 days
- Manual: `POST /api/v1/rotation-jobs/{id}/rotate-now`

---

## Database Schema

```sql
-- Rotation job definitions (one per rotation configuration)
CREATE TABLE rotation_jobs (
    id                         TEXT PRIMARY KEY,  -- UUID
    project_id                 TEXT NOT NULL REFERENCES projects(id),
    secret_path                TEXT NOT NULL,
    provider_type              TEXT NOT NULL,      -- matches RotationProvider.Type()
    params                     JSONB NOT NULL DEFAULT '{}',  -- encrypted at rest (envelope encryption)
    secrets_mapping            JSONB NOT NULL DEFAULT '{}',  -- {"username": "SECRET_KEY_NAME", ...}
    dual_phase                 BOOLEAN NOT NULL DEFAULT true,
    active_index               INTEGER NOT NULL DEFAULT 0,   -- 0 or 1 for dual-phase
    rotation_schedule          TEXT,              -- cron expression (nullable if interval)
    rotation_interval_secs     BIGINT,            -- interval in seconds (nullable if cron)
    rotation_window_secs       BIGINT DEFAULT 3600,          -- max rotation attempt duration
    auto_rotation_enabled      BOOLEAN NOT NULL DEFAULT true,
    disable_automated_rotation BOOLEAN NOT NULL DEFAULT false,  -- maintenance freeze flag
    next_rotation_at           TIMESTAMPTZ,
    last_rotated_at            TIMESTAMPTZ,
    last_rotation_status       TEXT DEFAULT 'pending',  -- pending|running|success|failed|rolled_back
    last_rotation_error        TEXT,
    created_by                 TEXT NOT NULL REFERENCES users(id),
    machine_token_id           TEXT REFERENCES machine_tokens(id),  -- scoped write token
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-attempt execution log (append-only)
CREATE TABLE rotation_attempts (
    id              TEXT PRIMARY KEY,  -- UUID; used as idempotency key in provider calls
    rotation_job_id TEXT NOT NULL REFERENCES rotation_jobs(id),
    triggered_by    TEXT NOT NULL,     -- "scheduler" | "manual:{user_id}"
    status          TEXT NOT NULL,     -- running|success|failed|rolled_back
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

---

## Security Architecture

**`params` column encrypted at rest:** Provider configuration (DB host, port, credentials) stored in `rotation_jobs.params` JSONB is encrypted using the same envelope encryption (AES-256-GCM + per-row DEK) from the cryptographic architecture spec. Never stored plaintext.

**Per-job machine token:** Each rotation job has a dedicated `mvt_` machine token with `secret:write` permission scoped to the specific secret path only. This token is provisioned by core at rotation job creation — not accessible by any user. Follows the RBAC machine token protocol.

**Rotation idempotency:** Each `rotation_attempts` row UUID is passed as `RotateRequest.JobID`. Providers must use this as an idempotency key. Re-delivering the same UUID must not create duplicate credentials.

**Phase 2 process isolation (`go-plugin`):**
- `SecureConfig` with SHA256 checksum validation before launching any external binary
- AutoMTLS mutual authentication on every gRPC call
- Plugin directory must be explicitly operator-configured; no symlink traversal

**Phase 3 WASM sandbox (wazero):**
- Zero CGO — preserves Project Vault's static binary constraint
- WASM modules cannot access host memory or syscalls beyond explicit WASI grants
- Host exports only: `write_secret(path, value)`, `read_secret(path)`, `log(level, msg)`

---

## RBAC Integration

All rotation operations require the `rotation-plugins, execute` permission. The Casbin enforcer checks this before any trigger (scheduled or manual):

```go
// Enforce before executing any rotation
if ok, _ := enforcer.Enforce(userID, fmt.Sprintf("project:%s", projectID), "rotation-plugins", "execute"); !ok {
    return ErrForbidden
}
```

---

## Built-in Providers (v1.0)

| Provider type | Dual-phase | Description |
|--------------|-----------|-------------|
| `postgres-credentials` | Yes | Alternates between two pre-provisioned PostgreSQL users |
| `mysql-credentials` | Yes | Same pattern for MySQL |
| `generic-password` | No | Replaces a single stored password value in-place |

---

## Package Layout

```
internal/rotation/
    provider.go       # RotationProvider interface + request/result types
    registry.go       # ProviderRegistry (Register, Get)
    scheduler.go      # gocron v2 wrapper (LoadJob, UnloadJob, Start, Stop)
    executor.go       # executeRotation: state machine, Rotate→Verify→Rollback
    audit.go          # RotationAuditEvent + emit helpers
    providers/
        postgres/     # PostgresProvider (dual-phase)
        mysql/        # MySQLProvider (dual-phase)
        generic/      # GenericPasswordProvider (single-phase)
```

---

## REST API (v1.0)

| Method | Path | Permission | Description |
|--------|------|-----------|-------------|
| `POST` | `/api/v1/projects/{id}/rotation-jobs` | `rotation-plugins, execute` | Create rotation job |
| `GET` | `/api/v1/rotation-jobs/{id}` | `secrets, read` | Get job status + last attempt |
| `POST` | `/api/v1/rotation-jobs/{id}/rotate-now` | `rotation-plugins, execute` | Manual trigger |
| `PATCH` | `/api/v1/rotation-jobs/{id}` | `rotation-plugins, execute` | Update schedule/config |
| `DELETE` | `/api/v1/rotation-jobs/{id}` | `project_admin` | Delete rotation job |
| `GET` | `/api/v1/rotation-jobs/{id}/attempts` | `secrets, read` | List attempts (audit log) |

---

## Go Module Dependencies

```go
require (
    github.com/go-co-op/gocron/v2       v2.x.x  // scheduler
    github.com/hashicorp/go-plugin      v1.7.0  // external plugins (Phase 2)
    github.com/tetratelabs/wazero       v1.x.x  // WASM runtime (Phase 3)
    // All other deps (postgres driver, etc.) already present in project
)
```

---

## Phased Delivery

| Phase | Version | Deliverables |
|-------|---------|-------------|
| 1 — Foundation | v1.0 | `RotationProvider` interface, registry, gocron scheduler, 3 built-in providers, DB schema, REST API, RBAC + audit integration |
| 2 — External Plugins | v1.2+ | `go-plugin` adapter, plugin discovery, SHA256 validation, plugin catalog API |
| 3 — WASM Plugins | v2.0+ | wazero runtime, `.wasm` upload API, WASI host interface, strict sandboxing |

---

## Open ADRs

| ADR | Decision needed | Recommendation |
|-----|----------------|----------------|
| ADR-07 | Plugin execution model phasing — formally record the v1/v1.2+/v2.0+ tier progression | Three-tier progression; v1 in-process only; go-plugin and WASM are additive extensions; `RotationProvider` interface is the stable contract |
| ADR-08 | Dual-phase as default — should providers opt in or opt out? | Dual-phase is default (`SupportsDualPhase() → true`); providers opt out via `→ false`; single-phase requires explicit `disable_dual_phase: true` in job config |
| ADR-09 | Rotation scheduler HA strategy | Single-node: in-process gocron with DB-level optimistic locking on `rotation_jobs.last_rotation_status`; multi-node: `WithDistributedElector` via shared DB row lock |

---

## ADR Numbering Context

| Research Area | ADRs |
|--------------|------|
| Cryptographic Architecture | ADR-01 – ADR-03 |
| RBAC / Permission Architecture | ADR-04 – ADR-06 |
| Rotation Plugin Architecture | ADR-07 – ADR-09 |
| Machine User Auth & Offline Caching | ADR-10 – ADR-12 |
| Service Health Monitoring | ADR-13 – ADR-15 |
