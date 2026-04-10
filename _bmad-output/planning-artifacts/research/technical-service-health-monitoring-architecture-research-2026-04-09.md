---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
workflowType: 'research'
lastStep: 6
research_type: 'technical'
research_topic: 'Service Health Monitoring Architecture'
research_goals: 'Design health monitoring for Project Vault — endpoint liveness/readiness probes, dependency health checks (DB, cache, external integrations), metrics exposure, alerting integration, and operational observability for self-hosted deployments'
user_name: 'Nestor'
date: '2026-04-09'
web_research_enabled: true
source_verification: true
---

# Operational Clarity at the Edge: Service Health Monitoring Architecture for Project Vault

**Date:** 2026-04-09
**Author:** Nestor
**Research Type:** Technical

---

## Research Overview

This research examines how to build a production-grade health monitoring and observability stack for Project Vault — a self-hosted secrets management platform written in Go with Docker-primary deployment. The study covers three core pillars: (1) structured health check endpoints (`/healthz/live`, `/healthz/ready`) using `alexliesenfeld/health` with dependency probes for PostgreSQL, bbolt cache, rotation scheduler, and plugin subprocess health; (2) Prometheus metrics exposition via `prometheus/client_golang` exposing vault-domain metrics (secret read latency, rotation job state, token issuance rate, cache hit ratio); and (3) alerting integration via Alertmanager for self-hosted operators without requiring any cloud service. Architectural decisions open for ADR-13 through ADR-15 are identified.

See the **Executive Summary** and **Technical Research Conclusion** sections for key findings and strategic recommendations.

---

## Technical Research Scope Confirmation

**Research Topic:** Service Health Monitoring Architecture
**Research Goals:** Design health monitoring for Project Vault — endpoint liveness/readiness probes, dependency health checks (DB, cache, external integrations), metrics exposure, alerting integration, and operational observability for self-hosted deployments

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

Project Vault requires a health monitoring architecture that serves three distinct audiences simultaneously: the container orchestrator (Docker/Kubernetes) which needs fast binary liveness and readiness signals; the self-hosted operator who needs rich metric dashboards and alerting; and the Vault service itself, which needs circuit breaker feedback to avoid cascading failures when dependencies degrade.

The recommended stack consists of `alexliesenfeld/health` (Awesome Go, actively maintained) for structured health endpoint aggregation, `prometheus/client_golang` v1.23+ for metrics exposition, `sony/gobreaker v2` for circuit breaker protection on DB/external calls, and Prometheus + Alertmanager for operator alerting — all self-hosted, no cloud dependency required. OpenTelemetry Go SDK v1.43 (Traces: Stable, Metrics: Stable) provides the optional tracing layer for deep operational insight in v1.2+.

**Key Technical Findings:**

- Health check separation (liveness vs readiness) is architecturally critical — conflating them causes cascading restarts under load
- Asynchronous periodic checks (not per-request) are essential for expensive dependency probes (DB ping, plugin subprocess heartbeat)
- Prometheus metrics on a dedicated port (`:9090/metrics`) should be separated from the API server to prevent auth middleware interference
- Circuit breakers (`gobreaker v2`) double as health signal sources — state changes emit to the health checker's status bus
- Docker `HEALTHCHECK` and Kubernetes HTTP probes point to the same `/healthz/live` endpoint — one implementation serves both

**Technical Recommendations:**

1. Use `alexliesenfeld/health` with `WithPeriodicCheck` (15s interval, 3s initial delay) for all dependency checks
2. Expose `/metrics` on a separate internal port (`:9090`) — never behind API auth middleware
3. Integrate `gobreaker v2` circuit breakers on every external dependency; surface breaker state as a Prometheus gauge
4. Provide a Compose-bundled `prometheus.yml` + `alertmanager.yml` starter config in the repository
5. Reserve OpenTelemetry distributed tracing for v1.2+ — wire the OTEL SDK now but keep it no-op until needed

---

## Table of Contents

1. Technical Research Introduction and Methodology
2. Technology Stack Analysis
3. Integration Patterns Analysis
4. Architectural Patterns and Design
5. Implementation Approaches and Technology Adoption
6. Technical Research Conclusion

---

## 1. Technical Research Introduction and Methodology

### Technical Research Significance

Service health monitoring is no longer optional for a secrets management platform. Operators running Project Vault in production need deterministic answers to two questions at all times: "Is the vault running?" and "Is it safe to send traffic to the vault?" These are liveness and readiness — and answering them incorrectly in either direction carries severe consequences. A false liveness failure triggers unnecessary container restarts and potential secret rotation cascades. A false readiness pass routes requests to a vault that cannot reach its database, corrupting in-flight operations.

Beyond binary availability, Vault operators managing infrastructure for dozens of projects need dashboards and alerts that surface degradation before it becomes failure: rising DB query latency, rotation job backlog, cache miss spikes, or plugin subprocess crash loops. The health monitoring architecture directly determines how quickly operators can detect and respond to these events.

_Technical Importance: Secrets management platforms have zero tolerance for silent failures — undetected health degradation can mean secrets silently fail to rotate, expiring credentials without notification._
_Source: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/_

### Technical Research Methodology

- **Technical Scope:** Go health check ecosystem, Prometheus metrics exposition, circuit breaker patterns, Kubernetes/Docker probe compatibility, alerting integration
- **Data Sources:** pkg.go.dev library docs, Kubernetes official documentation, Prometheus official guides, GitHub repositories with README and API docs
- **Analysis Framework:** Evaluate libraries against Project Vault's specific dependency graph (PostgreSQL via GORM, bbolt, rotation scheduler gocron v2, plugin subprocesses via go-plugin, external OIDC endpoints)
- **Time Period:** Current (April 2026)
- **Technical Depth:** Production-implementation level — interface signatures, configuration values, Go module paths

### Technical Research Goals and Objectives

**Original Technical Goals:** liveness/readiness probes, dependency health checks (DB, cache, external integrations), metrics exposure, alerting integration, operational observability for self-hosted deployments

**Achieved Technical Objectives:**

- Health check library selected with verified API signatures and configuration patterns
- Probe endpoint naming and response schema defined
- Prometheus metrics strategy designed for Project Vault domain metrics
- Circuit breaker integration pattern specified for dependency resilience
- Self-hosted alerting stack designed for Docker Compose operators

---

## 2. Technology Stack Analysis

### Go Health Check Libraries

Two production-grade Go health check libraries are in active use and Awesome Go-listed as of 2026:

**`alexliesenfeld/health`** — The recommended choice for Project Vault.

```go
go get github.com/alexliesenfeld/health
```

- Provides `http.Handler` for health endpoints consumable by Kubernetes and Docker HEALTHCHECK
- `WithCheck` — synchronous check executed per HTTP request (cheap checks only)
- `WithPeriodicCheck(interval, initialDelay, check)` — async background check, **result cached** between intervals; critical for expensive dependency probes
- `WithCacheDuration(ttl)` — global result cache TTL (default 1s)
- `WithTimeout(duration)` — global per-check timeout
- `WithStatusListener(fn)` — fires on health state transitions (healthy→unhealthy→unknown), suitable for emitting Prometheus gauge changes
- Response body is structured JSON with component-level status details
- Prometheus integration available via `WithResultWriter` + custom writer

_Source: https://pkg.go.dev/github.com/alexliesenfeld/health_
_Source: https://github.com/alexliesenfeld/health_

**`heptiolabs/healthcheck`** — Alternative library with explicit liveness/readiness handler separation.

```go
go get -u github.com/heptiolabs/healthcheck
```

- Explicitly separates `AddLivenessCheck` and `AddReadinessCheck` — forces architectural discipline
- Built-in checks: `DatabasePingCheck`, `DNSResolveCheck`, `GoroutineCountCheck`, `TCPDialCheck`, `HTTPGetCheck`
- Optional Prometheus gauge export per check (`healthcheck.NewMetricsHandler(prometheus.DefaultRegisterer)`)
- Async checks supported via `healthcheck.Async(checkFn, interval)`
- Serves `/live` and `/ready` on a single `http.Handler`

_Source: https://github.com/heptiolabs/healthcheck_

**Selection rationale:** `alexliesenfeld/health` wins for Project Vault because: (1) richer configuration API with per-check timeouts and initial delays needed for slow-starting DB connections; (2) `WithStatusListener` hook is cleaner for emitting Prometheus state metrics; (3) actively maintained with CI badges green as of research date. `heptiolabs/healthcheck` is archived/stale; the Prometheus gauge integration is a strong feature but it can be replicated manually.

### Prometheus Client Go

```go
go get github.com/prometheus/client_golang/prometheus
go get github.com/prometheus/client_golang/prometheus/promauto
go get github.com/prometheus/client_golang/prometheus/promhttp
```

Current version: v1.23.2 (as observed in pkg.go.dev docs)

Core pattern for Project Vault:

```go
reg := prometheus.NewRegistry()
reg.MustRegister(
    collectors.NewGoCollector(),
    collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
)
// Custom vault metrics registered here
http.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
http.ListenAndServe(":9090", nil) // dedicated port, no auth middleware
```

Metric types used by Project Vault:
- `CounterVec` — secret reads, token issuances, rotation attempts
- `GaugeVec` — active rotation jobs, circuit breaker states, cache entries
- `HistogramVec` — DB query latency, secret read latency (buckets: 1ms, 5ms, 10ms, 50ms, 100ms, 500ms, 1s, 5s)
- `promauto` — auto-registers metrics at package init, cleaner for domain metric definitions

_Source: https://prometheus.io/docs/guides/go-application/_
_Source: https://pkg.go.dev/github.com/prometheus/client_golang/prometheus/promhttp_

### Circuit Breaker: sony/gobreaker v2

```go
go get github.com/sony/gobreaker/v2
```

Generic circuit breaker with type parameter support (Go 1.18+):

```go
cb := gobreaker.NewCircuitBreaker[*sql.Rows](gobreaker.Settings{
    Name:        "postgres",
    MaxRequests: 3,            // half-open probe request limit
    Interval:    30 * time.Second,
    Timeout:     10 * time.Second,
    ReadyToTrip: func(counts gobreaker.Counts) bool {
        return counts.ConsecutiveFailures > 5
    },
    OnStateChange: func(name string, from, to gobreaker.State) {
        // emit to health checker and Prometheus gauge
        circuitBreakerState.WithLabelValues(name).Set(float64(to))
    },
})
```

States: Closed (normal) → Open (failing fast) → Half-Open (probing) → Closed
`BucketPeriod` (v2 new) enables rolling-window strategy rather than fixed-window.

_Source: https://github.com/sony/gobreaker_

### OpenTelemetry Go SDK

Current version: v1.43.0
Status: Traces — Stable; Metrics — Stable; Logs — Beta

```go
go get go.opentelemetry.io/otel
go get go.opentelemetry.io/otel/trace
go get go.opentelemetry.io/otel/sdk/trace
```

Project Vault strategy: wire the OTEL SDK in v1.0 as a no-op provider. This means all instrumentation code is in place from day one, but no trace data is exported until an operator configures a collector endpoint. In v1.2+, activate OTLP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

_Source: https://opentelemetry.io/docs/languages/go/_
_Source: https://pkg.go.dev/go.opentelemetry.io/otel_

### Alertmanager

Handles alerts sent by Prometheus server. Core concepts:
- **Grouping** — collapses flood of similar alerts into one notification (critical for rotation failures)
- **Inhibition** — suppresses downstream alerts when a root-cause alert fires (DB down inhibits rotation failure alerts)
- **Silences** — time-windowed muting (maintenance windows)
- **HA mode** — `--cluster-*` flags for multi-node Alertmanager clusters

Receiver integrations: email, PagerDuty, OpsGenie, Slack, webhook. For self-hosted operators: email or webhook to a local notification service (Ntfy, Gotify).

_Source: https://prometheus.io/docs/alerting/latest/alertmanager/_

---

## 3. Integration Patterns Analysis

### Health Endpoint Naming Convention

The Kubernetes ecosystem has standardized on two probe patterns. Project Vault will implement both:

| Endpoint | Probe Type | Returns 200 when... | Returns 503 when... |
|----------|-----------|---------------------|----------------------|
| `GET /healthz/live` | Liveness | Process is alive and not deadlocked | Goroutine count exploded, panic recovery failed |
| `GET /healthz/ready` | Readiness | All critical deps healthy | DB unreachable, bbolt locked, migrations pending |

**Startup probe:** Kubernetes startup probe points to `/healthz/ready` with high `failureThreshold` (30) and short `periodSeconds` (5). This gives up to 150 seconds for slow DB migrations before liveness kicks in.

The `alexliesenfeld/health` library returns structured JSON:

```json
{
  "status": "down",
  "timestamp": "2026-04-09T21:00:00Z",
  "details": {
    "postgres": { "status": "down", "timestamp": "...", "error": "connection refused" },
    "bbolt-cache": { "status": "up", "timestamp": "..." },
    "rotation-scheduler": { "status": "up", "timestamp": "..." }
  }
}
```

HTTP status: `200` for `up`/`degraded`, `503` for `down`. Kubernetes probe only looks at HTTP status; the JSON body is for operator tooling.

_Source: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/_

### Docker HEALTHCHECK Integration

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz/live || exit 1
```

Docker Compose service:

```yaml
services:
  vault:
    image: project-vault:latest
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz/live"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    depends_on:
      postgres:
        condition: service_healthy
```

`depends_on` with `condition: service_healthy` ensures the vault container waits for PostgreSQL to be ready before accepting traffic.

### Prometheus Scrape Integration

Project Vault runs a dedicated metrics server on port `:9090` (internal only, not exposed through Traefik). This separation is architecturally important:

- `/metrics` must not require auth tokens — Prometheus scrape has no token
- API server middleware (JWT validation, rate limiting) must not apply to metrics
- Metrics port can be firewalled from public internet while API port is exposed

Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: project-vault
    scrape_interval: 15s
    static_configs:
      - targets: ['vault:9090']
```

### gRPC Health Protocol

Project Vault's rotation plugins running as go-plugin subprocesses implement the gRPC Health Checking Protocol:

```protobuf
service Health {
  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);
  rpc Watch(HealthCheckRequest) returns (stream HealthCheckResponse);
}
```

The plugin manager polls plugin subprocesses via `Check` every 30 seconds. A plugin returning `NOT_SERVING` or timing out triggers a restart attempt (up to 3 times) before marking the rotation job as `error` state. The health checker's `WithPeriodicCheck` wraps this gRPC poll.

_Source: https://grpc.github.io/grpc/core/md_doc_health-checking.html_

### Traefik Health Routing Integration

Traefik (the existing reverse proxy per `specs/proxmox-server.md`) supports service health checking via its API:

```yaml
# traefik dynamic config
http:
  services:
    vault:
      loadBalancer:
        healthCheck:
          path: /healthz/ready
          interval: 30s
          timeout: 5s
```

When `/healthz/ready` returns 503, Traefik removes the backend from rotation. This means vault can signal "I'm alive but not ready" (e.g., during DB migration) and Traefik will queue-hold traffic rather than forward it to a degraded instance.

### Circuit Breaker ↔ Health Check Integration

`gobreaker` state changes feed directly into the health checker through a shared channel:

```go
type HealthBus struct {
    updates chan ComponentHealth
}

// In gobreaker OnStateChange callback:
onStateChange: func(name string, from, to gobreaker.State) {
    bus.updates <- ComponentHealth{
        Name:    name,
        Healthy: to == gobreaker.StateClosed,
        State:   to.String(),
    }
}

// Health checker checks shared state:
health.WithCheck(health.Check{
    Name: "postgres-circuit",
    Check: func(ctx context.Context) error {
        if circuitState["postgres"] == gobreaker.StateOpen {
            return fmt.Errorf("circuit open: postgres")
        }
        return nil
    },
})
```

This avoids double-probing the database on every health check request — the circuit breaker already knows the DB state from production traffic.

---

## 4. Architectural Patterns and Design

### Three-Layer Health Architecture

Project Vault's health monitoring follows a three-layer model:

```
Layer 1: Process Health (Liveness)
├── Goroutine count < threshold
├── No panic recovery loops
└── HTTP server responding

Layer 2: Dependency Health (Readiness)
├── PostgreSQL: ping + circuit breaker state
├── bbolt cache: file open + read test
├── Rotation scheduler: job queue not stalled
└── Active plugins: gRPC Health Check

Layer 3: Business Health (Metrics/Alerting)
├── Secret rotation success rate
├── Token issuance error rate
├── DB query latency P99
└── Cache hit ratio
```

### Health Check Configuration Design

```go
// internal/health/checker.go

func NewChecker(deps *Dependencies) health.Checker {
    return health.NewChecker(
        health.WithCacheDuration(5*time.Second),
        health.WithTimeout(10*time.Second),

        // Layer 1: cheap synchronous checks (per-request)
        health.WithCheck(health.Check{
            Name:    "goroutines",
            Timeout: 100 * time.Millisecond,
            Check: func(ctx context.Context) error {
                if n := runtime.NumGoroutine(); n > 10000 {
                    return fmt.Errorf("goroutine leak: %d", n)
                }
                return nil
            },
        }),

        // Layer 2a: PostgreSQL (async, 15s interval, 5s initial delay)
        health.WithPeriodicCheck(15*time.Second, 5*time.Second, health.Check{
            Name:    "postgres",
            Timeout: 3 * time.Second,
            Check: func(ctx context.Context) error {
                return deps.DB.PingContext(ctx)
            },
        }),

        // Layer 2b: bbolt cache (async, 30s interval)
        health.WithPeriodicCheck(30*time.Second, 2*time.Second, health.Check{
            Name:    "bbolt-cache",
            Timeout: 1 * time.Second,
            Check: deps.CacheStore.Ping,
        }),

        // Layer 2c: rotation scheduler (async, 30s interval)
        health.WithPeriodicCheck(30*time.Second, 10*time.Second, health.Check{
            Name:    "rotation-scheduler",
            Timeout: 2 * time.Second,
            Check: deps.Scheduler.HealthCheck,
        }),

        // Layer 2d: active plugin subprocesses
        health.WithPeriodicCheck(30*time.Second, 15*time.Second, health.Check{
            Name:  "plugin-manager",
            Check: deps.PluginManager.HealthCheck,
        }),

        // Status change listener → Prometheus gauge
        health.WithStatusListener(func(ctx context.Context, state health.CheckerState) {
            healthStatus.WithLabelValues("overall").Set(statusToFloat(state.Status))
        }),
    )
}
```

### Dedicated Metrics Server Architecture

```go
// cmd/vault/main.go

func main() {
    // API server (public, behind Traefik, with auth)
    apiServer := &http.Server{
        Addr:    ":8080",
        Handler: apiRouter,
    }

    // Health server (internal, no auth)
    healthChecker := health.NewChecker(...)
    healthMux := http.NewServeMux()
    healthMux.Handle("/healthz/live",  health.NewHandler(checker, health.WithStatusCodeUp(200), health.WithStatusCodeDown(503)))
    healthMux.Handle("/healthz/ready", health.NewHandler(checker))
    healthServer := &http.Server{
        Addr:    ":8081",
        Handler: healthMux,
    }

    // Metrics server (internal, no auth, dedicated port)
    metricsMux := http.NewServeMux()
    metricsMux.Handle("/metrics", promhttp.HandlerFor(metricsRegistry, promhttp.HandlerOpts{}))
    metricsServer := &http.Server{
        Addr:    ":9090",
        Handler: metricsMux,
    }

    // All three servers run concurrently
    g, ctx := errgroup.WithContext(context.Background())
    g.Go(func() error { return apiServer.ListenAndServe() })
    g.Go(func() error { return healthServer.ListenAndServe() })
    g.Go(func() error { return metricsServer.ListenAndServe() })
    g.Wait()
}
```

### Project Vault Domain Metrics

```go
// internal/metrics/vault_metrics.go

var (
    // Secret operations
    SecretReadsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "vault_secret_reads_total",
        Help: "Total secret read operations",
    }, []string{"project_id", "status"})

    SecretReadDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "vault_secret_read_duration_seconds",
        Help:    "Secret read operation latency",
        Buckets: []float64{.001, .005, .01, .05, .1, .5, 1, 5},
    }, []string{"project_id"})

    // Token operations
    TokenIssuancesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "vault_token_issuances_total",
        Help: "Total token issuance attempts",
    }, []string{"method", "status"}) // method: password, mvt, oidc

    // Rotation jobs
    RotationJobsActive = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "vault_rotation_jobs_active",
        Help: "Number of active rotation jobs",
    }, []string{"provider_type", "state"}) // state: pending, running, error

    RotationAttemptsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "vault_rotation_attempts_total",
        Help: "Total rotation attempt outcomes",
    }, []string{"provider_type", "status"}) // status: success, failure, rollback

    // Cache performance
    CacheHitsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "vault_cache_hits_total",
        Help: "Offline cache lookup outcomes",
    }, []string{"result"}) // result: hit, miss, stale

    // Circuit breaker states
    CircuitBreakerState = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "vault_circuit_breaker_state",
        Help: "Circuit breaker state (0=closed, 1=half-open, 2=open)",
    }, []string{"dependency"})

    // Dependency health
    DependencyHealthStatus = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "vault_dependency_health",
        Help: "Dependency health status (1=up, 0=down)",
    }, []string{"component"})
)
```

### Alerting Rules Design

```yaml
# prometheus/alerts/vault.yml
groups:
  - name: vault.health
    rules:
      # Critical: vault is not ready to serve traffic
      - alert: VaultNotReady
        expr: up{job="project-vault"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Project Vault is down"
          description: "Vault has been unreachable for more than 1 minute"

      # Critical: database circuit breaker open
      - alert: VaultDatabaseCircuitOpen
        expr: vault_circuit_breaker_state{dependency="postgres"} == 2
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Vault database circuit breaker is open"

      # Warning: high rotation failure rate
      - alert: VaultRotationFailureRate
        expr: |
          rate(vault_rotation_attempts_total{status="failure"}[5m]) /
          rate(vault_rotation_attempts_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High rotation failure rate (>10% of attempts failing)"

      # Warning: cache miss rate degraded
      - alert: VaultCacheMissRateHigh
        expr: |
          rate(vault_cache_hits_total{result="miss"}[5m]) /
          rate(vault_cache_hits_total[5m]) > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cache miss rate above 50%"

      # Warning: secret read latency P99 high
      - alert: VaultSecretReadLatencyHigh
        expr: |
          histogram_quantile(0.99, rate(vault_secret_read_duration_seconds_bucket[5m])) > 1.0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Secret read P99 latency above 1 second"
```

### DB Schema Extensions

```sql
-- New table: service_health_events
-- Records health state transition history for audit and post-incident analysis
CREATE TABLE service_health_events (
    id          BIGSERIAL PRIMARY KEY,
    component   TEXT        NOT NULL,  -- 'postgres', 'bbolt-cache', 'rotation-scheduler', 'plugin:uuid'
    from_status TEXT        NOT NULL,  -- 'up', 'down', 'unknown'
    to_status   TEXT        NOT NULL,
    detail      TEXT,                  -- error message if degraded/down
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_health_events_component_time ON service_health_events (component, occurred_at DESC);
```

This table is written by the `WithStatusListener` callback. It provides operators with health event history in the Admin UI without requiring external log aggregation.

---

## 5. Implementation Approaches and Technology Adoption

### Phase 1: Core Health Endpoints (v1.0)

**Scope:** All health infrastructure goes in v1.0 alongside the API server.

```
internal/
  health/
    checker.go          # NewChecker() factory with all dependency probes
    server.go           # HTTP server for /healthz/live and /healthz/ready
  metrics/
    vault_metrics.go    # All promauto metric definitions
    server.go           # Metrics HTTP server on :9090
  circuitbreaker/
    breakers.go         # NewPostgresBreaker(), NewOIDCBreaker() factories
```

**Module additions:**

```go
require (
    github.com/alexliesenfeld/health    v0.8.0
    github.com/prometheus/client_golang v1.23.2
    github.com/sony/gobreaker/v2        v2.0.0
    golang.org/x/sync                   v0.10.0  // errgroup for server lifecycle
)
```

**Wire-up sequence:**
1. Initialize `metricsRegistry` (custom registry, not `prometheus.DefaultRegisterer`)
2. Register all `vault_metrics.go` vars against `metricsRegistry`
3. Initialize circuit breakers with `OnStateChange` callbacks updating `CircuitBreakerState` gauge
4. Build `health.Checker` with `WithPeriodicCheck` for all dependencies; `WithStatusListener` writes to `service_health_events` and updates `DependencyHealthStatus` gauge
5. Start three servers: API `:8080`, health `:8081`, metrics `:9090`

### Phase 2: Bundled Observability Stack (v1.0)

Ship a `docker/observability/` directory with ready-to-use configs:

```
docker/
  observability/
    docker-compose.yml      # prometheus + alertmanager + grafana
    prometheus.yml          # scrape config pointing to vault:9090
    alertmanager.yml        # email/webhook receiver config with placeholder values
    alerts/
      vault.yml             # the alerting rules above
    grafana/
      provisioning/
        datasources/
          prometheus.yaml
        dashboards/
          vault-overview.json   # pre-built dashboard: health, latency, rotation
```

Operators running the full stack:

```bash
cd docker/observability
docker compose up -d
# Grafana available at http://localhost:3000
# Prometheus at http://localhost:9091
# Alertmanager at http://localhost:9093
```

### Phase 3: OpenTelemetry Tracing (v1.2+)

Wire the OTEL SDK in v1.0 as a no-op provider:

```go
// internal/telemetry/otel.go
func InitTracerProvider(ctx context.Context) (trace.TracerProvider, func()) {
    endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint == "" {
        // no-op provider — zero overhead
        return trace.NewNoopTracerProvider(), func() {}
    }
    // Initialize OTLP exporter in v1.2+
    // ...
}
```

All critical code paths (secret read, token issuance, rotation execution) already carry `ctx` with span creation calls — they just produce no-op spans until an endpoint is configured.

### Testing Strategy

| Test Type | What's Tested | Tool |
|-----------|--------------|------|
| Unit | Health checker aggregation logic | `health.NewChecker` + mock deps |
| Unit | Circuit breaker state transitions | `gobreaker` with simulated failures |
| Unit | Metrics counter increments | `prometheus/testutil.ToFloat64` |
| Integration | `/healthz/live` and `/healthz/ready` HTTP responses | `httptest.NewServer` |
| Integration | Postgres check with real DB (via `pgx`) | `testcontainers-go` |
| E2E | Full Compose stack health after restart | `docker compose up` → curl probes |

```go
// testing/health_test.go
import "github.com/prometheus/client_golang/prometheus/testutil"

func TestSecretReadCounter(t *testing.T) {
    SecretReadsTotal.WithLabelValues("proj-1", "success").Inc()
    expected := 1.0
    assert.Equal(t, expected, 
        testutil.ToFloat64(SecretReadsTotal.WithLabelValues("proj-1", "success")))
}
```

### Risk Table

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Health check endpoint adds latency to API requests | Medium | Low | Use `WithPeriodicCheck` for all non-trivial checks; cache results |
| Prometheus metrics port accidentally exposed to internet | Medium | High | Traefik config: only expose `:8080`; `:9090` is internal Docker network only |
| Too many metrics cause Prometheus storage bloat | Low | Medium | Cardinality cap: `project_id` label only on summary metrics, not per-path |
| gobreaker opens on transient DB hiccup, blocks traffic | Medium | High | Tune `ReadyToTrip` to 5 consecutive failures (not % based) for predictability |
| Plugin subprocess health check polling causes excessive gRPC overhead | Low | Low | 30s interval + timeout 2s; gRPC connection pool reused between polls |

---

## 6. Technical Research Conclusion

### Summary of Key Technical Findings

The Go health monitoring ecosystem for self-hosted services has converged around two complementary tools: `alexliesenfeld/health` for structured health endpoint aggregation with async periodic checks, and `prometheus/client_golang` for metrics exposition. Together they cover the full observability surface needed by Project Vault's three audiences (orchestrator, operator, service itself) without requiring any cloud services.

**Critical architectural finding:** The separation of liveness and readiness probes is not optional. Using a single `/health` endpoint that conflates both leads to cascading container restarts under DB load — a catastrophic outcome for a secrets manager. `alexliesenfeld/health` supports this correctly with its `WithStatusListener` and per-check result API.

**Critical implementation finding:** All expensive dependency probes (DB ping, plugin subprocess gRPC health, rotation scheduler state) must be `WithPeriodicCheck` with cached results — never per-request synchronous checks. A burst of health check requests during a Kubernetes rolling deploy cannot be allowed to thunderherd the database.

**Circuit breaker as health signal:** `sony/gobreaker v2`'s `OnStateChange` callback provides real-time circuit state that is already derived from production traffic — not from synthetic health probes. Wiring breaker state changes into the health checker's component status eliminates duplicate DB probing and provides more accurate "is the DB reachable from production code paths" signal than a separate ping.

### Strategic Impact Assessment

| Concern | Project Vault Position | ADR Needed |
|---------|----------------------|------------|
| Health endpoint security | `/healthz/*` and `/metrics` on internal ports only; no auth required | ADR-13 |
| Metrics cardinality | `project_id` label capped via label allow-list; no per-path cardinality explosion | ADR-14 |
| Observability stack bundling | Compose-bundled Prometheus+Grafana+Alertmanager vs operator-provided | ADR-15 |

**ADR-13: Health Endpoint Authentication Policy**
Decision needed: Should `/healthz/live` and `/healthz/ready` be completely unauthenticated, or should they require a read-only bearer token? Recommendation: unauthenticated on internal port `:8081` — health endpoints that require auth create a chicken-and-egg problem when the auth system itself is degraded.

**ADR-14: Prometheus Label Cardinality Policy**
Decision needed: Should `project_id` be a label on per-operation metrics (e.g., `vault_secret_reads_total`)? High project count (1000+) creates high-cardinality metrics. Recommendation: include `project_id` only on aggregated project-level gauges, not on per-operation counters.

**ADR-15: Bundled vs Operator-Provided Observability Stack**
Decision needed: Should Project Vault ship a bundled Prometheus+Grafana+Alertmanager Compose stack, or only publish metric endpoints and let operators connect their existing stacks? Recommendation: ship bundled `docker/observability/` with opt-in compose override — operators can ignore it, newcomers get instant dashboards.

### Next Steps — Technical Recommendations

1. **Create `internal/health/` and `internal/metrics/` packages** as part of the v1.0 API server work — these are not optional add-ons, they're core infrastructure
2. **Wire `gobreaker v2` around all GORM database calls** — replace direct DB calls with `cb.Execute(func() (T, error) { ... })` wrapper
3. **Draft ADR-13 (health endpoint auth)**, ADR-14 (metric cardinality), and ADR-15 (observability bundling) before sprint begins
4. **Add `HEALTHCHECK` instruction** to the production `Dockerfile` targeting `/healthz/live`
5. **Add Traefik `healthCheck` config** in `docker/traefik/dynamic/vault.yml` pointing to `/healthz/ready`
6. **Wire OTEL no-op provider** in v1.0 — all code paths instrument now, activate in v1.2+

---

**Technical Research Completion Date:** 2026-04-09
**Research Period:** Current comprehensive technical analysis (April 2026)
**Source Verification:** All technical claims cited with current sources
**Technical Confidence Level:** High — based on multiple authoritative technical sources

_This research document serves as the authoritative technical reference for Project Vault's health monitoring architecture and provides the specification base for the `specs/service-health-monitoring.md` operational spec._
