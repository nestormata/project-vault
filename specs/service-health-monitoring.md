# Service Health Monitoring Architecture — Project Vault

**Version:** 1.0  
**Date:** 2026-04-09  
**Status:** Research-complete; pending ADR sign-off on three open decisions (ADR-13, ADR-14, ADR-15)  
**Source:** Technical research document `_bmad-output/planning-artifacts/research/technical-service-health-monitoring-architecture-research-2026-04-09.md`

---

## Overview

Project Vault runs three concurrent HTTP servers to cleanly separate public API traffic, health probing, and metrics scraping. Health checks use `alexliesenfeld/health` with async periodic probes for all expensive dependencies. Prometheus metrics are exposed via `prometheus/client_golang` on a dedicated internal port. `sony/gobreaker v2` circuit breakers wrap every external dependency call and feed their state directly into both the health checker and the metrics system. A bundled `docker/observability/` compose stack ships Prometheus + Alertmanager + Grafana for self-hosted operators.

---

## Three-Server Architecture

```
:8080  API server     ← public, behind Traefik, JWT auth middleware applied
:8081  Health server  ← internal, no auth, liveness + readiness probes
:9090  Metrics server ← internal, no auth, Prometheus scrape target
```

**Why separate ports:**
- `/metrics` must not require an auth token — Prometheus scrape has none
- Health endpoints in a degraded-auth scenario must still be reachable
- Traefik only forwards `:8080`; `:8081` and `:9090` stay on the internal Docker network

```go
// cmd/vault/main.go — skeleton
g, ctx := errgroup.WithContext(context.Background())
g.Go(func() error { return apiServer.ListenAndServe()     }) // :8080
g.Go(func() error { return healthServer.ListenAndServe()  }) // :8081
g.Go(func() error { return metricsServer.ListenAndServe() }) // :9090
```

---

## Health Endpoints

| Endpoint | Probe type | 200 OK when | 503 when |
|----------|-----------|-------------|----------|
| `GET /healthz/live` | Liveness | Process alive, goroutine count normal | Goroutine leak (>10k), panic recovery loop |
| `GET /healthz/ready` | Readiness | All critical deps healthy | DB unreachable, bbolt locked, scheduler stalled, migrations pending |

**Kubernetes probe config:**

```yaml
livenessProbe:
  httpGet:
    path: /healthz/live
    port: 8081
  initialDelaySeconds: 10
  periodSeconds: 15
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /healthz/ready
    port: 8081
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3

startupProbe:
  httpGet:
    path: /healthz/ready
    port: 8081
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 30   # 150s max startup window for slow DB migrations
```

**Docker HEALTHCHECK:**

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8081/healthz/live || exit 1
```

**Response body (JSON):**

```json
{
  "status": "down",
  "timestamp": "2026-04-09T21:00:00Z",
  "details": {
    "postgres":           { "status": "down", "timestamp": "...", "error": "connection refused" },
    "bbolt-cache":        { "status": "up",   "timestamp": "..." },
    "rotation-scheduler": { "status": "up",   "timestamp": "..." },
    "plugin-manager":     { "status": "up",   "timestamp": "..." }
  }
}
```

HTTP status `200` for `up` or `degraded`; `503` for `down`. Kubernetes and Docker only look at HTTP status; JSON body is for operator tooling.

---

## Health Checker Configuration

**Library:** `github.com/alexliesenfeld/health` (Awesome Go listed, actively maintained)

```go
go get github.com/alexliesenfeld/health
```

```go
// internal/health/checker.go
func NewChecker(deps *Dependencies) health.Checker {
    return health.NewChecker(
        health.WithCacheDuration(5*time.Second),
        health.WithTimeout(10*time.Second),

        // Layer 1: cheap synchronous (per-request)
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

        // Layer 2a: PostgreSQL — async, 15s interval, 5s initial delay
        health.WithPeriodicCheck(15*time.Second, 5*time.Second, health.Check{
            Name:    "postgres",
            Timeout: 3 * time.Second,
            Check:   deps.DB.PingContext,
        }),

        // Layer 2b: bbolt cache — async, 30s interval
        health.WithPeriodicCheck(30*time.Second, 2*time.Second, health.Check{
            Name:    "bbolt-cache",
            Timeout: 1 * time.Second,
            Check:   deps.CacheStore.Ping,
        }),

        // Layer 2c: rotation scheduler — async, 30s interval
        health.WithPeriodicCheck(30*time.Second, 10*time.Second, health.Check{
            Name:    "rotation-scheduler",
            Timeout: 2 * time.Second,
            Check:   deps.Scheduler.HealthCheck,
        }),

        // Layer 2d: plugin subprocess gRPC heartbeats — async, 30s
        health.WithPeriodicCheck(30*time.Second, 15*time.Second, health.Check{
            Name:  "plugin-manager",
            Check: deps.PluginManager.HealthCheck,
        }),

        // Emit state transitions to Prometheus gauge + DB event log
        health.WithStatusListener(func(ctx context.Context, state health.CheckerState) {
            vaultDependencyHealth.WithLabelValues("overall").Set(statusToFloat(state.Status))
            // write to service_health_events table (async, fire-and-forget)
        }),
    )
}
```

**Critical rule:** All dependency probes MUST use `WithPeriodicCheck` (cached results). Never use `WithCheck` for DB ping, bbolt reads, gRPC calls, or any I/O-bound check — a burst of health check requests during a rolling deploy cannot thunderherd the database.

---

## Circuit Breaker Integration

**Library:** `github.com/sony/gobreaker/v2`

```go
go get github.com/sony/gobreaker/v2
```

Circuit breakers wrap every external dependency call. Their `OnStateChange` callback feeds directly into the Prometheus metrics gauge — circuit breakers see real production traffic, making them a more accurate health signal than synthetic pings.

```go
// internal/circuitbreaker/breakers.go
func NewPostgresBreaker(bus *HealthBus) *gobreaker.CircuitBreaker[*sql.Rows] {
    return gobreaker.NewCircuitBreaker[*sql.Rows](gobreaker.Settings{
        Name:         "postgres",
        MaxRequests:  3,
        Interval:     30 * time.Second,
        Timeout:      10 * time.Second,
        BucketPeriod: 5 * time.Second, // rolling window (v2 feature)
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            return counts.ConsecutiveFailures > 5
        },
        OnStateChange: func(name string, from, to gobreaker.State) {
            vaultCircuitBreakerState.WithLabelValues(name).Set(float64(to))
            bus.Notify(name, to)
        },
    })
}
```

State encoding for Prometheus gauge: `0 = Closed` (healthy), `1 = Half-Open` (recovering), `2 = Open` (failing fast).

**Breakers to create:**

| Breaker name | Wraps | Trips after |
|-------------|-------|-------------|
| `postgres` | All GORM/pgx DB calls | 5 consecutive failures |
| `bbolt` | Cache read/write operations | 3 consecutive failures |
| `oidc-provider` | External OIDC token validation (v1.2+) | 3 consecutive failures |
| `plugin:{uuid}` | Per-plugin gRPC calls (v1.2+) | 5 consecutive failures |

---

## Prometheus Metrics

**Library:** `github.com/prometheus/client_golang` v1.23.2

```go
go get github.com/prometheus/client_golang/prometheus
go get github.com/prometheus/client_golang/prometheus/promauto
go get github.com/prometheus/client_golang/prometheus/promhttp
```

Use a **custom registry** (not `prometheus.DefaultRegisterer`) to avoid collisions with any bundled library auto-registrations.

### Metric Definitions

```go
// internal/metrics/vault_metrics.go
var (
    // Secret operations
    VaultSecretReadsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "vault_secret_reads_total",
        Help: "Total secret read operations",
    }, []string{"status"}) // status: success, error, unauthorized

    VaultSecretReadDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "vault_secret_read_duration_seconds",
        Help:    "Secret read operation latency",
        Buckets: []float64{.001, .005, .01, .05, .1, .5, 1, 5},
    }, []string{"status"})

    // Token operations
    VaultTokenIssuancesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "vault_token_issuances_total",
        Help: "Total token issuance attempts",
    }, []string{"method", "status"}) // method: password, mvt, oidc

    // Rotation jobs
    VaultRotationJobsActive = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "vault_rotation_jobs_active",
        Help: "Number of active rotation jobs by state",
    }, []string{"provider_type", "state"}) // state: pending, running, error

    VaultRotationAttemptsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "vault_rotation_attempts_total",
        Help: "Total rotation attempt outcomes",
    }, []string{"provider_type", "status"}) // status: success, failure, rollback

    // Offline cache
    VaultCacheHitsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "vault_cache_hits_total",
        Help: "Offline cache lookup outcomes",
    }, []string{"result"}) // result: hit, miss, stale

    // Circuit breakers
    VaultCircuitBreakerState = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "vault_circuit_breaker_state",
        Help: "Circuit breaker state: 0=closed, 1=half-open, 2=open",
    }, []string{"dependency"})

    // Dependency health
    VaultDependencyHealth = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "vault_dependency_health",
        Help: "Dependency health status: 1=up, 0=down",
    }, []string{"component"})
)
```

**Cardinality rule (ADR-14 pending):** Do NOT add `project_id` as a label on per-operation counters — a deployment with 1000 projects creates 1000× metric series. If per-project visibility is needed, use a separate project-level gauge updated on aggregated intervals, not per-operation labels.

### Metrics Server

```go
// internal/metrics/server.go
func NewServer(reg *prometheus.Registry) *http.Server {
    mux := http.NewServeMux()
    mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{
        Registry:          reg,
        EnableOpenMetrics: true,
    }))
    return &http.Server{
        Addr:         ":9090",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
    }
}
```

---

## Prometheus Scrape Config

```yaml
# docker/observability/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - alerts/vault.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

scrape_configs:
  - job_name: project-vault
    scrape_interval: 15s
    static_configs:
      - targets: ['vault:9090']

  - job_name: postgres
    scrape_interval: 30s
    static_configs:
      - targets: ['postgres-exporter:9187']
```

---

## Alerting Rules

```yaml
# docker/observability/alerts/vault.yml
groups:
  - name: vault.health
    rules:

      - alert: VaultNotReady
        expr: up{job="project-vault"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Project Vault is unreachable"
          description: "Vault has been unreachable by Prometheus for more than 1 minute"

      - alert: VaultDatabaseCircuitOpen
        expr: vault_circuit_breaker_state{dependency="postgres"} == 2
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Vault database circuit breaker is OPEN"
          description: "More than 5 consecutive DB failures; vault is failing fast on all DB calls"

      - alert: VaultRotationFailureRate
        expr: |
          rate(vault_rotation_attempts_total{status="failure"}[5m])
          / rate(vault_rotation_attempts_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Vault rotation failure rate above 10%"

      - alert: VaultCacheMissRateHigh
        expr: |
          rate(vault_cache_hits_total{result="miss"}[5m])
          / rate(vault_cache_hits_total[5m]) > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Vault offline cache miss rate above 50%"

      - alert: VaultSecretReadLatencyHigh
        expr: |
          histogram_quantile(0.99,
            rate(vault_secret_read_duration_seconds_bucket[5m])) > 1.0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Vault secret read P99 latency above 1 second"
```

---

## Traefik Integration

```yaml
# docker/traefik/dynamic/vault.yml
http:
  services:
    vault:
      loadBalancer:
        healthCheck:
          path: /healthz/ready
          port: 8081
          interval: 30s
          timeout: 5s
```

When `/healthz/ready` returns 503, Traefik removes the backend from rotation. The vault signals "alive but not ready" during DB migrations without triggering container restarts — Traefik holds traffic at the edge.

---

## Docker Compose Dependencies

```yaml
# docker-compose.yml (vault service)
services:
  vault:
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8081/healthz/live"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    depends_on:
      postgres:
        condition: service_healthy
```

The `depends_on` + `condition: service_healthy` pair ensures vault doesn't start before PostgreSQL is fully initialized.

---

## DB Schema Extension

```sql
-- Records health state transition history for audit and post-incident analysis.
-- Written by the health.WithStatusListener callback.
CREATE TABLE service_health_events (
    id          BIGSERIAL    PRIMARY KEY,
    component   TEXT         NOT NULL,   -- 'postgres', 'bbolt-cache', 'rotation-scheduler', 'plugin:{uuid}'
    from_status TEXT         NOT NULL,   -- 'up', 'down', 'unknown'
    to_status   TEXT         NOT NULL,
    detail      TEXT,                    -- error message if degraded/down
    occurred_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_health_events_component_time ON service_health_events (component, occurred_at DESC);
```

This table surfaces health history in the Admin UI without requiring external log aggregation. Writes are async/fire-and-forget from the `WithStatusListener` callback.

---

## Bundled Observability Stack

The repository ships a ready-to-use observability stack under `docker/observability/`:

```
docker/
  observability/
    docker-compose.yml          # prometheus + alertmanager + grafana
    prometheus.yml              # scrape config → vault:9090
    alertmanager.yml            # email/webhook receiver (fill in credentials)
    alerts/
      vault.yml                 # the 5 alerting rules above
    grafana/
      provisioning/
        datasources/
          prometheus.yaml
        dashboards/
          vault-overview.json   # pre-built dashboard: health, latency, rotation
```

```bash
# Start full observability stack:
cd docker/observability && docker compose up -d

# Access:
# Grafana:      http://localhost:3000  (admin/admin)
# Prometheus:   http://localhost:9091
# Alertmanager: http://localhost:9093
```

Operators running their own Prometheus can skip this stack entirely and point their existing Prometheus at `vault:9090/metrics`.

---

## OpenTelemetry (v1.0 no-op, v1.2+ active)

Wire the OTEL SDK as a no-op provider in v1.0 — zero overhead, all instrumentation code in place:

```go
// internal/telemetry/otel.go
func InitTracerProvider(ctx context.Context) (trace.TracerProvider, func()) {
    if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
        return trace.NewNoopTracerProvider(), func() {}
    }
    // v1.2+: initialize OTLP gRPC exporter
    // ...
}
```

All critical code paths (secret read, token issuance, rotation execution) carry `ctx` with span creation calls from day one. Tracing activates transparently when an operator sets `OTEL_EXPORTER_OTLP_ENDPOINT`.

OTEL SDK version: `go.opentelemetry.io/otel` v1.43.0 — Traces: Stable, Metrics: Stable, Logs: Beta.

---

## Go Module Dependencies

```go
require (
    github.com/alexliesenfeld/health    v0.8.0
    github.com/prometheus/client_golang v1.23.2
    github.com/sony/gobreaker/v2        v2.0.0
    go.opentelemetry.io/otel            v1.43.0
    go.opentelemetry.io/otel/trace      v1.43.0
    go.opentelemetry.io/otel/sdk/trace  v1.43.0
    golang.org/x/sync                   v0.10.0  // errgroup for server lifecycle
)
```

---

## Package Layout

```
internal/
  health/
    checker.go          # NewChecker() factory — all WithPeriodicCheck registrations
    server.go           # HTTP mux for :8081 with /healthz/live and /healthz/ready
  metrics/
    vault_metrics.go    # All promauto metric variable definitions
    server.go           # HTTP mux for :9090 with /metrics handler
  circuitbreaker/
    breakers.go         # NewPostgresBreaker(), NewBBoltBreaker(), NewOIDCBreaker()
    bus.go              # HealthBus — channel-based state change propagation
  telemetry/
    otel.go             # InitTracerProvider() — no-op or OTLP depending on env
```

---

## Open ADRs

| ADR | Decision needed | Recommendation |
|-----|----------------|----------------|
| ADR-13 | Health endpoint authentication policy: should `/healthz/*` require a token? | Unauthenticated on internal port `:8081` — auth-system degradation must not block health probes |
| ADR-14 | Prometheus label cardinality: include `project_id` on per-operation counters? | No — use aggregated project-level gauges only; per-operation `project_id` labels blow up cardinality at scale |
| ADR-15 | Bundle Prometheus+Grafana+Alertmanager in `docker/observability/` or leave to operators? | Ship bundled stack as opt-in; operators can ignore it, newcomers get instant dashboards |

---

## ADR Numbering Context

| Research Area | ADRs |
|--------------|------|
| Cryptographic Architecture | ADR-01 – ADR-03 |
| RBAC / Permission Architecture | ADR-04 – ADR-06 |
| Rotation Plugin Architecture | ADR-07 – ADR-09 |
| Machine User Auth & Offline Caching | ADR-10 – ADR-12 |
| Service Health Monitoring | ADR-13 – ADR-15 |
