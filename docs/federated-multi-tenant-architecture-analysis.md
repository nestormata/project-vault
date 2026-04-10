# Federated Multi-Tenant Architecture Analysis — Project Vault

**Author:** Infrastructure Architecture Review  
**Date:** 2026-04-10  
**Status:** Analysis — pre-decision  
**Scope:** Operational complexity assessment of a federated DB-per-tenant architecture against the current shared-schema single-node baseline  
**Related:** `specs/multi-tenancy-data-model.md` (ADR-16), `_bmad-output/planning-artifacts/prd.md` (SaaS v2 tier)

---

## Preface: What We Are Actually Analyzing

The current Project Vault v1 data model (`specs/multi-tenancy-data-model.md`, ADR-16) **explicitly rejects DB-per-tenant** for the self-hosted case: "operationally heavy for self-hosted single-node." That decision is correct for the common path.

This analysis addresses a distinct question: **what does the federated architecture look like when it becomes necessary?** The honest answer is that it becomes necessary exactly once — at the SaaS v2 tier, where regulatory isolation, blast-radius containment per paying customer, and scale justify the overhead. For self-hosted, single-org, or small team deployments it does not.

This document is therefore structured as:
1. A concrete technical specification for when you *do* build it (SaaS v2 / enterprise isolation tier)
2. An honest cost/benefit verdict for when you *shouldn't*

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CONTROL PLANE (LXC 100)                   │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Auth Service │  │ Tenant Router│  │ Provisioning API │   │
│  │  (JWT issue) │  │ (route table)│  │ (lifecycle mgmt) │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         └─────────────────┴──────────────┬─────┘            │
│                                    ┌─────▼──────┐            │
│                                    │  Control   │            │
│                                    │  Plane DB  │            │
│                                    │ (PostgreSQL)│           │
│                                    └────────────┘            │
└─────────────────────────────────────────────────────────────┘
         │                    │                   │
         ▼                    ▼                   ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│  App Server A  │  │  App Server B  │  │  App Server C  │
│  (LXC 101)     │  │  (LXC 102)     │  │  (LXC 103)     │
│                │  │                │  │  (VIP tenant)  │
│  tenant-acme   │  │  tenant-beta   │  │  tenant-corp   │
│  tenant-foo    │  │  tenant-gamma  │  │  (dedicated)   │
│  tenant-bar    │  │  tenant-delta  │  │                │
│                │  │                │  │                │
│  PostgreSQL    │  │  PostgreSQL    │  │  PostgreSQL     │
│  vault_acme    │  │  vault_beta    │  │  vault_corp    │
│  vault_foo     │  │  vault_gamma   │  │                │
│  vault_bar     │  │  vault_delta   │  │                │
└────────────────┘  └────────────────┘  └────────────────┘
```

All inbound traffic hits Traefik on the control plane. Traefik routes per-tenant subdomain to the correct app server. The control plane never touches secret data — it owns routing, auth, and provisioning state.

---

## 1. Provisioning Automation

### Tenant Lifecycle State Machine

```
REQUESTED → PROVISIONING → MIGRATING → ACTIVE → SUSPENDED → DEPROVISIONED
                ↓ (failure)                          ↑ (reactivate)
           PROVISION_FAILED
```

### What "Provision a Tenant" Actually Does

A single `POST /tenants` to the control plane triggers a synchronous orchestration sequence across the control plane and the selected app server:

```
Control Plane                          App Server (selected)
─────────────────────────────────────────────────────────────
1. Validate request, assign tenant_id
2. Select target server (placement algorithm)
3. INSERT tenant row (state=PROVISIONING)
4. ──── POST /internal/provision ────►
                                    5. CREATE DATABASE vault_{slug}
                                    6. CREATE ROLE vault_{slug}_app
                                    7. GRANT privileges
                                    8. Run migrations (golang-migrate)
                                    9. Write provisioning result
                                    10. ◄── 200 OK + dsn_ref ────
11. INSERT routing_rules row
12. UPDATE tenant state=ACTIVE
13. Return 201 Created to caller
```

If step 4–10 fails, the control plane retries with exponential backoff (3×), then marks `PROVISION_FAILED`. A background reconciler periodically retries failed tenants and alerts after threshold.

### Go: Control Plane Provisioning Handler

```go
// internal/controlplane/provision.go

type ProvisionRequest struct {
    Slug        string          `json:"slug" validate:"required,slug"`
    DisplayName string          `json:"display_name" validate:"required"`
    Plan        TenantPlan      `json:"plan" validate:"required,oneof=starter pro enterprise vip"`
    Region      string          `json:"region,omitempty"`
}

type ProvisionResult struct {
    TenantID   uuid.UUID `json:"tenant_id"`
    ServerID   uuid.UUID `json:"server_id"`
    Subdomain  string    `json:"subdomain"`   // acme.vault.example.com
    State      string    `json:"state"`
}

func (s *ProvisioningService) ProvisionTenant(ctx context.Context, req ProvisionRequest) (*ProvisionResult, error) {
    tenantID := uuid.New()

    // 1. Select placement server (see §4 for algorithm)
    server, err := s.placement.Select(ctx, req.Plan, req.Region)
    if err != nil {
        return nil, fmt.Errorf("placement: %w", err)
    }

    // 2. Optimistic insert — idempotency key on slug
    tenant := &Tenant{
        ID:          tenantID,
        Slug:        req.Slug,
        DisplayName: req.DisplayName,
        Plan:        req.Plan,
        ServerID:    server.ID,
        State:       StateProvisioning,
    }
    if err := s.db.Create(tenant).Error; err != nil {
        return nil, fmt.Errorf("create tenant record: %w", err)
    }

    // 3. Call app server — this is the only network hop
    appReq := AppProvisionRequest{
        TenantID: tenantID,
        Slug:     req.Slug,
    }
    appResp, err := s.appClient.Provision(ctx, server.InternalURL, appReq)
    if err != nil {
        _ = s.db.Model(tenant).Update("state", StateProvisionFailed)
        return nil, fmt.Errorf("app server provision: %w", err)
    }

    // 4. Write routing rule
    rule := &RoutingRule{
        TenantID:  tenantID,
        ServerID:  server.ID,
        Subdomain: fmt.Sprintf("%s.vault.example.com", req.Slug),
        BackendURL: server.PublicURL,
        State:     RouteActive,
    }
    if err := s.db.Create(rule).Error; err != nil {
        return nil, fmt.Errorf("routing rule: %w", err)
    }

    // 5. Activate
    if err := s.db.Model(tenant).Updates(map[string]any{
        "state":   StateActive,
        "dsn_ref": appResp.DSNRef,  // opaque reference, not the actual DSN
    }).Error; err != nil {
        return nil, fmt.Errorf("activate tenant: %w", err)
    }

    return &ProvisionResult{
        TenantID:  tenantID,
        ServerID:  server.ID,
        Subdomain: rule.Subdomain,
        State:     string(StateActive),
    }, nil
}
```

### App Server Internal API (mTLS protected)

The internal API is **only reachable from the control plane** — bound to an internal network interface, protected by mutual TLS (both sides present client certificates). Never exposed to the public internet.

```go
// App server internal provision endpoint
// POST /internal/v1/provision
// Auth: mTLS (control plane cert required)

type AppProvisionRequest struct {
    TenantID uuid.UUID `json:"tenant_id"`
    Slug     string    `json:"slug"`
}

type AppProvisionResponse struct {
    DSNRef  string `json:"dsn_ref"`   // e.g., "vault_acme" — the DB name, not credentials
    Version string `json:"schema_version"`
}

func (h *InternalHandler) ProvisionTenant(w http.ResponseWriter, r *http.Request) {
    var req AppProvisionRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    dbName := fmt.Sprintf("vault_%s", req.Slug)
    pgRole := fmt.Sprintf("vault_%s_app", req.Slug)
    pgPassword := generateSecurePassword(32)

    steps := []struct {
        name string
        fn   func() error
    }{
        {"create_database",    func() error { return h.pg.Exec(fmt.Sprintf(`CREATE DATABASE %q`, dbName)).Error }},
        {"create_role",        func() error { return h.pg.Exec(fmt.Sprintf(`CREATE ROLE %q WITH LOGIN PASSWORD '%s'`, pgRole, pgPassword)).Error }},
        {"grant_connect",      func() error { return h.pg.Exec(fmt.Sprintf(`GRANT CONNECT ON DATABASE %q TO %q`, dbName, pgRole)).Error }},
        {"run_migrations",     func() error { return h.runMigrations(dbName, pgRole) }},
        {"store_credentials",  func() error { return h.storeCredentials(req.TenantID, dbName, pgRole, pgPassword) }},
    }

    for _, step := range steps {
        if err := step.fn(); err != nil {
            h.rollbackProvision(req.Slug, dbName, pgRole)
            http.Error(w, fmt.Sprintf("provision failed at %s: %v", step.name, err), http.StatusInternalServerError)
            return
        }
    }

    json.NewEncoder(w).Encode(AppProvisionResponse{
        DSNRef:  dbName,
        Version: h.migrations.CurrentVersion(),
    })
}

func (h *InternalHandler) runMigrations(dbName, role string) error {
    dsn := fmt.Sprintf("postgres://%s:%s@localhost:5432/%s?sslmode=require",
        role, h.credentials.Get(role), dbName)
    m, err := migrate.New("file:///app/migrations", dsn)
    if err != nil {
        return err
    }
    return m.Up()
}
```

### Rollback Procedure

Provisioning failures must be clean. The rollback drops the database and role in reverse order. This is idempotent — re-running provisioning after rollback is safe because of the optimistic slug uniqueness constraint:

```go
func (h *InternalHandler) rollbackProvision(slug, dbName, pgRole string) {
    // Terminate active connections first
    h.pg.Exec(fmt.Sprintf(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%s'`, dbName,
    ))
    h.pg.Exec(fmt.Sprintf(`DROP DATABASE IF EXISTS %q`, dbName))
    h.pg.Exec(fmt.Sprintf(`DROP ROLE IF EXISTS %q`, pgRole))
    // Credential store cleanup
    h.credentials.Delete(pgRole)
}
```

---

## 2. Tenant Migration Between Servers

Migration is the most operationally dangerous operation in this architecture. There are two strategies — choose based on tolerable downtime.

### Strategy A: pg_dump/Restore (Maintenance Window)

**Tolerable downtime:** ~1–5 minutes for a typical tenant DB. Acceptable for migrations triggered by capacity rebalancing, server decommission, or tenant relocation requests.

**Procedure:**

```
Phase 1: Prepare (zero downtime)
─────────────────────────────────
1. Control plane: UPDATE routing_rules SET state='draining' WHERE tenant_id=X
   └─ Traefik watches routing_rules; starts rejecting new long-lived connections
      (short HTTP requests still complete)

2. App Server B: Pre-provision empty DB for tenant
   POST /internal/v1/provision-empty { tenant_id, slug }
   └─ Creates database + role + schema (no data) on destination server

Phase 2: Maintenance Window (downtime starts)
─────────────────────────────────────────────
3. Control plane: UPDATE routing_rules SET state='readonly' WHERE tenant_id=X
   └─ Traefik returns 503 for writes; reads from local cache if available
   
4. App Server A: pg_dump
   pg_dump -h localhost -U vault_acme_app -Fc vault_acme > /backup/vault_acme_$(date +%s).dump
   
5. Transfer to App Server B (scp or internal S3-compatible store)
   
6. App Server B: pg_restore
   pg_restore -h localhost -U vault_beta_app -d vault_acme /backup/vault_acme_XXXXXX.dump

Phase 3: Cutover (downtime ends)
─────────────────────────────────
7. Control plane: UPDATE routing_rules SET server_id=B_ID, state='active' WHERE tenant_id=X
   └─ Traefik picks up new routing within its poll interval (< 5 seconds with watch mode)

8. Verify: curl -H "X-Tenant: acme" https://B_internal/healthz/ready

9. App Server A: DROP DATABASE vault_acme (after 24-hour grace period)
```

**Go migration coordinator:**

```go
// internal/controlplane/migration.go

type MigrationCoordinator struct {
    db         *gorm.DB
    appClients map[uuid.UUID]*AppClient  // serverID → client
    traefik    *TraefikWatcher
}

func (m *MigrationCoordinator) MigrateTenant(ctx context.Context, tenantID, targetServerID uuid.UUID) error {
    tenant, err := m.getTenant(ctx, tenantID)
    if err != nil {
        return err
    }
    
    // Insert migration record (idempotency + audit trail)
    migration := &TenantMigration{
        ID:             uuid.New(),
        TenantID:       tenantID,
        SourceServerID: tenant.ServerID,
        TargetServerID: targetServerID,
        State:          MigrationStatePreparing,
        StartedAt:      time.Now(),
    }
    if err := m.db.Create(migration).Error; err != nil {
        return fmt.Errorf("create migration record: %w", err)
    }

    stages := []struct {
        state MigrationState
        fn    func() error
    }{
        {MigrationStatePreparing,     func() error { return m.drainConnections(ctx, tenant) }},
        {MigrationStateReadOnly,      func() error { return m.setReadOnly(ctx, tenant) }},
        {MigrationStateDumping,       func() error { return m.dumpDB(ctx, tenant, migration) }},
        {MigrationStateRestoring,     func() error { return m.restoreDB(ctx, tenant, migration, targetServerID) }},
        {MigrationStateCuttingOver,   func() error { return m.cutover(ctx, tenant, migration, targetServerID) }},
        {MigrationStateVerifying,     func() error { return m.verify(ctx, tenant, targetServerID) }},
        {MigrationStateCleaningUp,    func() error { return m.scheduleSourceCleanup(ctx, tenant) }},
    }

    for _, stage := range stages {
        m.db.Model(migration).Update("state", stage.state)
        if err := stage.fn(); err != nil {
            m.db.Model(migration).Updates(map[string]any{
                "state":        MigrationStateFailed,
                "error_detail": err.Error(),
            })
            // Attempt rollback — restore original routing
            _ = m.rollbackRouting(ctx, tenant)
            return fmt.Errorf("migration failed at %s: %w", stage.state, err)
        }
    }

    m.db.Model(migration).Updates(map[string]any{
        "state":        MigrationStateCompleted,
        "completed_at": time.Now(),
    })
    return nil
}

func (m *MigrationCoordinator) cutover(ctx context.Context, tenant *Tenant, migration *TenantMigration, targetServerID uuid.UUID) error {
    targetServer, err := m.getServer(ctx, targetServerID)
    if err != nil {
        return err
    }

    return m.db.Transaction(func(tx *gorm.DB) error {
        // Atomically update routing + tenant server assignment
        if err := tx.Model(&RoutingRule{}).
            Where("tenant_id = ?", tenant.ID).
            Updates(map[string]any{
                "server_id":   targetServerID,
                "backend_url": targetServer.PublicURL,
                "state":       RouteActive,
            }).Error; err != nil {
            return err
        }
        return tx.Model(tenant).Update("server_id", targetServerID).Error
    })
}
```

### Strategy B: Logical Replication (Near-Zero Downtime)

**Tolerable downtime:** <5 seconds (only for the routing cutover itself). Required for VIP tenants or SLAs that prohibit maintenance windows.

**Procedure:**

```
Phase 1: Setup Replication (zero downtime, hours before cutover)
────────────────────────────────────────────────────────────────
On App Server A (source):
  ALTER SYSTEM SET wal_level = logical;
  SELECT pg_reload_conf();

  CREATE PUBLICATION vault_acme_pub FOR ALL TABLES IN SCHEMA public;

On App Server B (destination):
  -- Schema must exist first (deploy migrations, no data)
  CREATE SUBSCRIPTION vault_acme_sub
    CONNECTION 'host=server-a port=5432 dbname=vault_acme user=replication_user'
    PUBLICATION vault_acme_pub;

  -- Subscription begins initial sync (table copy) + streaming changes

Phase 2: Monitor Lag (automatic)
─────────────────────────────────
SELECT
    subname,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), received_lsn)) AS replication_lag
FROM pg_stat_subscription;

-- Wait until lag < 1MB (typically seconds)
-- Control plane polls this via App Server B's /internal/v1/replication-lag endpoint

Phase 3: Cutover Window (<5 seconds)
──────────────────────────────────────
1. Pause writes to source (SET routing_rules.state = 'readonly')
2. Wait for subscription lag = 0
   SELECT * FROM pg_stat_subscription WHERE received_lsn = latest_end_lsn;
3. DROP SUBSCRIPTION vault_acme_sub ON Server B (stops replication, leaves data intact)
4. UPDATE routing_rules SET server_id=B, state='active' WHERE tenant_id=X
5. Resume traffic → Server B

Phase 4: Cleanup
─────────────────
6. DROP PUBLICATION vault_acme_pub ON Server A (after routing confirmed healthy)
7. Schedule DROP DATABASE vault_acme ON Server A (24h grace)
```

**Replication lag check on app server:**

```go
// App Server internal endpoint
// GET /internal/v1/replication-lag?tenant_slug=acme

func (h *InternalHandler) ReplicationLag(w http.ResponseWriter, r *http.Request) {
    slug := r.URL.Query().Get("tenant_slug")
    subName := fmt.Sprintf("vault_%s_sub", slug)

    var lagBytes int64
    err := h.pg.Raw(`
        SELECT COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), received_lsn), -1)
        FROM pg_stat_subscription
        WHERE subname = ?
    `, subName).Scan(&lagBytes).Error

    if err != nil || lagBytes == -1 {
        http.Error(w, "subscription not found", http.StatusNotFound)
        return
    }

    json.NewEncoder(w).Encode(map[string]any{
        "lag_bytes": lagBytes,
        "lag_human": formatBytes(lagBytes),
        "ready":     lagBytes < 1024*1024, // < 1MB
    })
}
```

### Routing Table During Migration

| Phase | `routing_rules.state` | Traefik behavior |
|---|---|---|
| Normal | `active` | Forward to backend |
| Draining | `draining` | Accept reads, queue writes, no new long-polls |
| Maintenance | `readonly` | Forward GETs, return `503 + Retry-After` for POSTs/PUTs/DELETEs |
| Cutover | `active` (new server) | Forward to new backend — Traefik picks up within poll interval |
| Rollback | `active` (original server) | Restored immediately |

---

## 3. Control Plane Data Model

The control plane database is the **only** database the control plane service owns. It contains no secret data — only operational metadata.

### Full Schema DDL

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Control Plane Database Schema
-- Project Vault — Federated Multi-Tenant (SaaS v2)
-- ─────────────────────────────────────────────────────────────────────────────

-- App servers registered in the fleet
CREATE TABLE servers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,          -- "app-server-a", "app-server-lxc-101"
    internal_url    TEXT NOT NULL UNIQUE,          -- https://10.0.1.101:8443 (mTLS endpoint)
    public_url      TEXT NOT NULL UNIQUE,          -- https://a.vault.example.com
    region          TEXT NOT NULL DEFAULT 'local', -- 'local', 'eu-west', 'us-east'
    state           TEXT NOT NULL DEFAULT 'active' -- 'active', 'draining', 'decommissioning', 'offline'
        CHECK (state IN ('active', 'draining', 'decommissioning', 'offline')),

    -- Capacity tracking (refreshed by heartbeat)
    tenant_count    INTEGER NOT NULL DEFAULT 0,
    db_count        INTEGER NOT NULL DEFAULT 0,
    pg_connections  INTEGER NOT NULL DEFAULT 0,
    pg_max_conn     INTEGER NOT NULL DEFAULT 100,
    disk_used_bytes BIGINT  NOT NULL DEFAULT 0,
    disk_total_bytes BIGINT NOT NULL DEFAULT 0,
    cpu_percent     NUMERIC(5,2),
    mem_percent     NUMERIC(5,2),

    -- Limits (admin configurable)
    max_tenants     INTEGER NOT NULL DEFAULT 50,
    max_db_size_gb  INTEGER NOT NULL DEFAULT 100,

    -- Health
    last_heartbeat  TIMESTAMPTZ,
    last_seen_ok    TIMESTAMPTZ,
    healthy         BOOLEAN NOT NULL DEFAULT false,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_servers_state   ON servers(state);
CREATE INDEX idx_servers_healthy ON servers(healthy, state);


-- Tenant registry — one row per tenant
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT NOT NULL UNIQUE,           -- URL-safe, immutable after creation
    display_name    TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'starter'
        CHECK (plan IN ('starter', 'pro', 'enterprise', 'vip')),
    server_id       UUID REFERENCES servers(id),    -- NULL during provisioning
    state           TEXT NOT NULL DEFAULT 'provisioning'
        CHECK (state IN (
            'requested', 'provisioning', 'provision_failed',
            'active', 'suspended', 'migrating', 'deprovisioning', 'deprovisioned'
        )),
    dsn_ref         TEXT,                           -- opaque DB name reference (not credentials)
    region          TEXT NOT NULL DEFAULT 'local',
    isolated        BOOLEAN NOT NULL DEFAULT false, -- true = dedicated server

    -- Provisioning/migration tracking
    provision_attempts  INTEGER NOT NULL DEFAULT 0,
    last_provision_err  TEXT,
    provisioned_at      TIMESTAMPTZ,

    -- Soft delete
    suspended_at    TIMESTAMPTZ,
    suspend_reason  TEXT,
    deleted_at      TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug       ON tenants(slug);
CREATE INDEX idx_tenants_server     ON tenants(server_id);
CREATE INDEX idx_tenants_state      ON tenants(state);
CREATE INDEX idx_tenants_active     ON tenants(server_id) WHERE state = 'active';


-- Routing table — maps tenant subdomains to backend URLs
-- This is the table Traefik's provider plugin (or a sync process) reads
CREATE TABLE routing_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    server_id   UUID NOT NULL REFERENCES servers(id),
    subdomain   TEXT NOT NULL UNIQUE,    -- acme.vault.example.com
    backend_url TEXT NOT NULL,           -- https://10.0.1.101:8080
    state       TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'draining', 'readonly', 'offline', 'provisioning')),
    priority    INTEGER NOT NULL DEFAULT 100,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_routing_tenant    ON routing_rules(tenant_id);
CREATE INDEX idx_routing_subdomain ON routing_rules(subdomain);
CREATE INDEX idx_routing_active    ON routing_rules(subdomain, state) WHERE state = 'active';


-- Provisioning state machine log — every transition recorded
CREATE TABLE provisioning_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    server_id   UUID REFERENCES servers(id),
    event_type  TEXT NOT NULL,   -- 'provision_started', 'provision_failed', 'provision_completed', ...
    from_state  TEXT,
    to_state    TEXT,
    detail      JSONB,           -- step output, error messages, timing
    actor       TEXT,            -- 'system', 'admin@example.com', 'api'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prov_events_tenant ON provisioning_events(tenant_id, created_at DESC);
CREATE INDEX idx_prov_events_type   ON provisioning_events(event_type, created_at DESC);


-- Migration jobs — one row per migration attempt
CREATE TABLE tenant_migrations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id),
    source_server_id UUID NOT NULL REFERENCES servers(id),
    target_server_id UUID NOT NULL REFERENCES servers(id),
    state            TEXT NOT NULL DEFAULT 'preparing'
        CHECK (state IN (
            'preparing', 'draining', 'readonly', 'dumping', 'transferring',
            'restoring', 'cutting_over', 'verifying', 'cleanup', 'completed',
            'failed', 'rolled_back'
        )),
    strategy         TEXT NOT NULL DEFAULT 'pg_dump'
        CHECK (strategy IN ('pg_dump', 'logical_replication')),
    dump_size_bytes  BIGINT,
    error_detail     TEXT,
    initiated_by     TEXT NOT NULL,  -- 'capacity_rebalancer', 'admin', 'api'
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ,
    downtime_start   TIMESTAMPTZ,    -- when readonly/draining began
    downtime_end     TIMESTAMPTZ     -- when active routing resumed
);

CREATE INDEX idx_migrations_tenant ON tenant_migrations(tenant_id, started_at DESC);
CREATE INDEX idx_migrations_state  ON tenant_migrations(state) WHERE state NOT IN ('completed', 'rolled_back');


-- Server heartbeat metrics history (last 24h rolling)
-- Used for capacity planning and anomaly detection
CREATE TABLE server_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id       UUID NOT NULL REFERENCES servers(id),
    tenant_count    INTEGER NOT NULL,
    pg_connections  INTEGER NOT NULL,
    disk_used_bytes BIGINT NOT NULL,
    cpu_percent     NUMERIC(5,2),
    mem_percent     NUMERIC(5,2),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_metrics_server_time ON server_metrics(server_id, recorded_at DESC);

-- Prune metrics older than 24h (run via pg_cron or app scheduler)
-- DELETE FROM server_metrics WHERE recorded_at < NOW() - INTERVAL '24 hours';


-- Immutable audit log — append-only, never UPDATE/DELETE
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,         -- sequential, not UUID — orderable
    tenant_id   UUID REFERENCES tenants(id),   -- NULL for system events
    server_id   UUID REFERENCES servers(id),
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,                 -- 'tenant.provision', 'tenant.migrate', 'server.register'
    resource    TEXT,
    detail      JSONB,
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_tenant  ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_action  ON audit_log(action, created_at DESC);
CREATE INDEX idx_audit_actor   ON audit_log(actor, created_at DESC);

-- Prevent modification — control plane app role has INSERT only on this table
-- REVOKE UPDATE, DELETE ON audit_log FROM cp_app;


-- Tenant plan quotas
CREATE TABLE plan_quotas (
    plan            TEXT PRIMARY KEY
        CHECK (plan IN ('starter', 'pro', 'enterprise', 'vip')),
    max_secrets     INTEGER NOT NULL DEFAULT 100,
    max_projects    INTEGER NOT NULL DEFAULT 5,
    max_members     INTEGER NOT NULL DEFAULT 3,
    max_db_size_mb  INTEGER NOT NULL DEFAULT 500,
    isolated_server BOOLEAN NOT NULL DEFAULT false  -- VIP gets dedicated server
);

INSERT INTO plan_quotas VALUES
    ('starter',    100,  5,   3,   500,  false),
    ('pro',        1000, 25,  25,  5120, false),
    ('enterprise', -1,   -1,  -1,  -1,   false),
    ('vip',        -1,   -1,  -1,  -1,   true);
```

### Key Design Decisions

- **`routing_rules` is the hot path** — Traefik or a thin proxy reads this table (via HTTP provider or a sync daemon) on every request. It must have a covering index on `(subdomain, state)` and ideally be cached in Redis with a 5-second TTL.
- **`audit_log` uses BIGSERIAL** — UUID primary keys are not monotonically orderable; audit logs must be queried by time range efficiently.
- **`dsn_ref` in `tenants` is NOT the connection string** — it's an opaque reference (the DB name). Credentials live in a secrets store (vault itself, ironically, or a separate encrypted KV store accessible only to app servers).
- **No foreign key from `tenants` to an application users table** — the control plane does not own users. User-to-tenant membership is managed by the auth service.

---

## 4. Health and Capacity Management

### Heartbeat Protocol

App servers POST to the control plane every 30 seconds:

```go
// App server heartbeat sender
func (h *HeartbeatSender) Run(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            h.sendHeartbeat(ctx)
        case <-ctx.Done():
            return
        }
    }
}

func (h *HeartbeatSender) sendHeartbeat(ctx context.Context) {
    metrics := h.collectMetrics()
    // POST /internal/v1/heartbeat to control plane
    h.cpClient.Heartbeat(ctx, HeartbeatPayload{
        ServerID:       h.serverID,
        TenantCount:    metrics.TenantCount,
        DBCount:        metrics.DBCount,
        PGConnections:  metrics.PGConnections,
        PGMaxConn:      metrics.PGMaxConn,
        DiskUsedBytes:  metrics.DiskUsedBytes,
        DiskTotalBytes: metrics.DiskTotalBytes,
        CPUPercent:     metrics.CPUPercent,
        MemPercent:     metrics.MemPercent,
    })
}

func (h *HeartbeatSender) collectMetrics() ServerMetrics {
    var result ServerMetrics

    // DB count from PostgreSQL catalog
    h.pg.Raw(`SELECT count(*) FROM pg_database WHERE datname LIKE 'vault_%'`).Scan(&result.DBCount)

    // Active connections
    h.pg.Raw(`SELECT count(*) FROM pg_stat_activity WHERE state = 'active'`).Scan(&result.PGConnections)

    // Disk usage
    var diskInfo DiskInfo
    syscall.Statfs("/var/lib/postgresql/data", &diskInfo)
    result.DiskUsedBytes = int64(diskInfo.Blocks-diskInfo.Bavail) * int64(diskInfo.Bsize)
    result.DiskTotalBytes = int64(diskInfo.Blocks) * int64(diskInfo.Bsize)

    return result
}
```

### Control Plane: Server Marked Unhealthy After 3 Missed Heartbeats (90s)

```go
// Background reconciler in control plane
func (r *ServerReconciler) Run(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    for range ticker.C {
        r.checkServerHealth(ctx)
    }
}

func (r *ServerReconciler) checkServerHealth(ctx context.Context) {
    threshold := time.Now().Add(-90 * time.Second)
    r.db.Model(&Server{}).
        Where("last_heartbeat < ? AND healthy = true", threshold).
        Updates(map[string]any{"healthy": false, "state": "offline"})

    // Alert if any servers went offline
    var offlineServers []Server
    r.db.Where("state = 'offline' AND updated_at > ?", time.Now().Add(-35*time.Second)).Find(&offlineServers)
    for _, s := range offlineServers {
        r.alerter.ServerOffline(s)
    }
}
```

### Tenant Placement Algorithm

```go
// Scoring function — lower score = better placement
func (p *PlacementEngine) Score(server Server, plan TenantPlan) float64 {
    if !server.Healthy || server.State != "active" {
        return math.MaxFloat64 // ineligible
    }

    // VIP tenants must have a dedicated server
    if plan == PlanVIP && server.TenantCount > 0 {
        return math.MaxFloat64
    }

    // Hard limits
    if server.TenantCount >= server.MaxTenants {
        return math.MaxFloat64
    }
    connRatio := float64(server.PGConnections) / float64(server.PGMaxConn)
    if connRatio > 0.85 {
        return math.MaxFloat64 // connection pool near saturation
    }
    diskRatio := float64(server.DiskUsedBytes) / float64(server.DiskTotalBytes)
    if diskRatio > 0.80 {
        return math.MaxFloat64
    }

    // Weighted score (lower = better)
    tenantScore := float64(server.TenantCount) / float64(server.MaxTenants)
    connScore := connRatio
    diskScore := diskRatio

    return (tenantScore * 0.4) + (connScore * 0.35) + (diskScore * 0.25)
}

func (p *PlacementEngine) Select(ctx context.Context, plan TenantPlan, region string) (*Server, error) {
    var servers []Server
    query := p.db.Where("healthy = true AND state = 'active'")
    if region != "" {
        query = query.Where("region = ?", region)
    }
    query.Find(&servers)

    var best *Server
    bestScore := math.MaxFloat64
    for i := range servers {
        s := servers[i]
        score := p.Score(s, plan)
        if score < bestScore {
            bestScore = score
            best = &s
        }
    }

    if best == nil {
        // Trigger scale-out alert — no eligible server found
        p.alerter.NoCapacityAvailable(plan, region)
        return nil, ErrNoCapacityAvailable
    }
    return best, nil
}
```

### Capacity Thresholds (Recommended Defaults)

| Metric | Soft Limit (alert) | Hard Limit (no new tenants) |
|---|---|---|
| Tenant count | 80% of `max_tenants` | 100% |
| PG connections | 70% of `max_conn` | 85% |
| Disk usage | 70% of total | 80% |
| CPU (5min avg) | 70% | 90% |
| Memory | 75% | 85% |

---

## 5. Failure Scenarios

### Scenario A: App Server Goes Offline

```
Timeline:
  T+0s:   App Server B crashes / network partition
  T+30s:  Heartbeat missed (first)
  T+60s:  Heartbeat missed (second)
  T+90s:  Heartbeat missed (third) → control plane marks B as offline
  T+91s:  All tenants on B have routing_rules.state updated to 'offline'
  T+92s:  Traefik detects routing state change (polling interval)
  T+97s:  Traefik returns 503 for all B-hosted tenants
  T+97s:  Error: "Vault temporarily unavailable. Cached credentials remain valid."

Tenants on Server A: unaffected
Tenants on Server B: 503 on vault API; machine users use offline cache
Auth service (control plane): fully available — login, token refresh still work
```

**Machine user offline cache** (from `specs/machine-user-auth-offline-caching.md`): This is the existing Project Vault design for exactly this scenario. When the vault is unreachable, machine users serve from local encrypted cache. The federated architecture does not change this contract — it only means the outage scope is one server's tenants, not all tenants.

**Routing layer response during server offline:**

```go
// Control plane: mark affected tenants when server goes offline
func (r *ServerReconciler) handleServerOffline(ctx context.Context, server Server) error {
    return r.db.Transaction(func(tx *gorm.DB) error {
        // Mark routing rules offline
        if err := tx.Model(&RoutingRule{}).
            Where("server_id = ? AND state = 'active'", server.ID).
            Update("state", "offline").Error; err != nil {
            return err
        }

        // Audit log
        r.audit.Log(AuditEntry{
            ServerID: &server.ID,
            Actor:    "system:reconciler",
            Action:   "server.offline",
            Detail:   map[string]any{"affected_tenants": server.TenantCount},
        })

        return nil
    })
}
```

**Traefik custom error page for offline tenants:**

```yaml
# Traefik middleware for tenant-offline state
http:
  middlewares:
    vault-offline-handler:
      errors:
        status: ["503"]
        service: vault-error-service
        query: "/errors/{status}.html"
```

### Scenario B: Control Plane Goes Offline

This is the more dangerous scenario. If the control plane is unreachable:

- **Auth service down**: New logins fail. Existing JWT tokens remain valid until expiry (configurable, default 1h). Apps continue to work using cached tokens.
- **Routing table stale**: Traefik has cached the routing table. With a Redis-backed cache (5s TTL), routing continues for existing tenants. No new tenant provisioning is possible.
- **No new tenant operations**: Provisioning, migration, suspension all fail. The vault remains readable/writable per existing routes.

**Mitigation**: Traefik should have a fallback cache — if the dynamic provider is unreachable, it uses the last known good configuration rather than dropping all routes. Traefik's built-in file provider can act as a static fallback.

**Honest assessment**: Control plane is an SPOF in this design. For production, the control plane DB needs streaming replication + a read replica that can be promoted, and the control plane services should run in a minimal HA pair (primary + standby with keepalived VIP on Proxmox).

### Scenario C: Migration Failure Mid-Flight

| Stage when failure occurs | Impact | Recovery |
|---|---|---|
| Before `readonly` set | Zero — routing still active on source | Re-run migration from beginning |
| During dump | Tenant in `readonly` state | Restore routing to `active` on source; tenant is degraded (reads only) for dump duration |
| During transfer/restore | Tenant in `readonly` state | Restore routing to `active` on source; delete incomplete DB on target |
| After cutover to target | Tenant on target | Roll forward (fix target) or roll back (re-migrate back to source) |

The migration coordinator always records the last known good routing state before modifying it, enabling rollback to exactly the pre-migration configuration.

---

## 6. Docker/Proxmox Path: Single LXC to Federated Fleet

### Starting Point: Current State (LXC 108)

```
LXC 108 (current)
└── Docker
    ├── traefik          (reverse proxy, :80/:443)
    ├── vault-api        (Go backend, :8080)
    ├── postgres         (single DB, all tenants via shared schema)
    └── vault-ui         (frontend, :3000)
```

### Target State: Minimal Federated (Single Proxmox, Multiple LXC)

```
Proxmox Node
├── LXC 100 — Control Plane
│   └── Docker
│       ├── traefik          (public ingress, :80/:443)
│       ├── vault-controlplane (Go service, :8080)
│       ├── postgres-cp      (control plane DB only)
│       └── redis            (routing table cache)
│
├── LXC 101 — App Server A (tenants: acme, foo, bar)
│   └── Docker
│       ├── vault-app        (Go service, :8080)
│       └── postgres-app     (vault_acme, vault_foo, vault_bar)
│
└── LXC 102 — App Server B (tenants: beta, gamma)
    └── Docker
        ├── vault-app        (Go service, :8080)
        └── postgres-app     (vault_beta, vault_gamma)
```

**Network topology**: LXC containers communicate over a Proxmox internal bridge (`vmbr1`, e.g., `10.0.1.0/24`). Only LXC 100's Traefik has external ports. LXC 101/102 are internal-only — no port exposure to the host network.

### Docker Compose: Control Plane (LXC 100)

```yaml
# docker-compose.yml — Control Plane (LXC 100)
version: "3.9"

networks:
  internal:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/24

services:
  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik/config:/etc/traefik
      - ./traefik/certs:/certs
      - traefik-acme:/acme
    networks:
      - internal
    command:
      - --providers.http.endpoint=http://vault-controlplane:8080/api/v1/traefik-config
      - --providers.http.pollInterval=5s
      - --providers.file.directory=/etc/traefik/dynamic
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.le.acme.tlschallenge=true
      - --certificatesresolvers.le.acme.email=admin@example.com
      - --certificatesresolvers.le.acme.storage=/acme/acme.json

  vault-controlplane:
    image: ghcr.io/your-org/vault-controlplane:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://cp_app:${CP_DB_PASSWORD}@postgres-cp:5432/vault_controlplane
      REDIS_URL: redis://redis:6379/0
      INTERNAL_API_TLS_CERT: /certs/cp-client.crt
      INTERNAL_API_TLS_KEY: /certs/cp-client.key
      INTERNAL_API_CA: /certs/ca.crt
      JWT_SECRET: ${JWT_SECRET}
    volumes:
      - ./certs:/certs:ro
    networks:
      - internal
    depends_on:
      postgres-cp:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8081/healthz/ready"]
      interval: 30s
      timeout: 5s
      retries: 3

  postgres-cp:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: vault_controlplane
      POSTGRES_USER: cp_app
      POSTGRES_PASSWORD: ${CP_DB_PASSWORD}
    volumes:
      - postgres-cp-data:/var/lib/postgresql/data
    networks:
      - internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cp_app -d vault_controlplane"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD} --save 60 1
    volumes:
      - redis-data:/data
    networks:
      - internal

volumes:
  postgres-cp-data:
  redis-data:
  traefik-acme:
```

### Docker Compose: App Server (LXC 101 / 102)

```yaml
# docker-compose.yml — App Server (identical for LXC 101, 102, ...)
version: "3.9"

networks:
  internal:
    driver: bridge

services:
  vault-app:
    image: ghcr.io/your-org/vault-app:latest
    restart: unless-stopped
    ports:
      - "10.0.1.101:8080:8080"   # Only exposed on internal Proxmox network
      - "10.0.1.101:8081:8081"   # Health port
      - "10.0.1.101:8443:8443"   # mTLS internal API
    environment:
      PG_HOST: postgres-app
      PG_PORT: "5432"
      PG_SUPERUSER: vault_super
      PG_SUPERPASS: ${PG_SUPERPASS}
      SERVER_ID: ${SERVER_ID}          # UUID registered in control plane
      CONTROL_PLANE_URL: https://10.0.1.100:8443
      TLS_CERT: /certs/app-server.crt
      TLS_KEY: /certs/app-server.key
      CA_CERT: /certs/ca.crt
      MIGRATIONS_PATH: /app/migrations
    volumes:
      - ./certs:/certs:ro
    networks:
      - internal
    depends_on:
      postgres-app:
        condition: service_healthy

  postgres-app:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: postgres           # superuser default db; tenant DBs created dynamically
      POSTGRES_USER: vault_super
      POSTGRES_PASSWORD: ${PG_SUPERPASS}
    command: >
      postgres
        -c max_connections=200
        -c shared_buffers=256MB
        -c effective_cache_size=768MB
        -c wal_level=logical
        -c max_wal_senders=10
        -c max_replication_slots=20
    volumes:
      - postgres-app-data:/var/lib/postgresql/data
    networks:
      - internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vault_super"]
      interval: 10s
      retries: 5

volumes:
  postgres-app-data:
```

### Traefik Dynamic Configuration (HTTP Provider)

The control plane exposes `/api/v1/traefik-config` — a Traefik HTTP provider endpoint that Traefik polls every 5 seconds. The response is generated from the `routing_rules` table.

```go
// Control plane: Traefik HTTP provider endpoint
// GET /api/v1/traefik-config
// Returns Traefik dynamic configuration JSON

func (h *TraefikConfigHandler) ServeConfig(w http.ResponseWriter, r *http.Request) {
    var rules []RoutingRule
    h.db.Where("state = 'active'").Find(&rules)

    config := TraefikDynamicConfig{
        HTTP: TraefikHTTP{
            Routers:  make(map[string]TraefikRouter),
            Services: make(map[string]TraefikService),
        },
    }

    for _, rule := range rules {
        routerName := fmt.Sprintf("tenant-%s", rule.TenantID)
        serviceName := fmt.Sprintf("svc-%s", rule.TenantID)

        config.HTTP.Routers[routerName] = TraefikRouter{
            Rule:        fmt.Sprintf("Host(`%s`)", rule.Subdomain),
            Service:     serviceName,
            EntryPoints: []string{"websecure"},
            TLS: &TraefikTLS{
                CertResolver: "le",
            },
            Middlewares: []string{"vault-auth-forward"},
        }

        config.HTTP.Services[serviceName] = TraefikService{
            LoadBalancer: TraefikLoadBalancer{
                Servers: []TraefikServer{
                    {URL: rule.BackendURL},
                },
                HealthCheck: &TraefikHealthCheck{
                    Path:     "/healthz/ready",
                    Interval: "10s",
                    Timeout:  "5s",
                },
            },
        }
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(config)
}
```

**Example Traefik dynamic config output (simplified):**

```json
{
  "http": {
    "routers": {
      "tenant-acme": {
        "rule": "Host(`acme.vault.example.com`)",
        "service": "svc-acme",
        "entryPoints": ["websecure"],
        "tls": { "certResolver": "le" },
        "middlewares": ["vault-auth-forward"]
      }
    },
    "services": {
      "svc-acme": {
        "loadBalancer": {
          "servers": [{ "url": "https://10.0.1.101:8080" }],
          "healthCheck": {
            "path": "/healthz/ready",
            "interval": "10s"
          }
        }
      }
    },
    "middlewares": {
      "vault-auth-forward": {
        "forwardAuth": {
          "address": "http://vault-controlplane:8080/auth/verify",
          "authResponseHeaders": ["X-Tenant-ID", "X-User-ID", "X-Org-ID"]
        }
      }
    }
  }
}
```

### Offline / Maintenance Routing (Static Fallback)

```yaml
# traefik/dynamic/maintenance.yml — loaded from file provider
# Activated manually during control plane maintenance
http:
  middlewares:
    vault-maintenance:
      headers:
        customResponseHeaders:
          Retry-After: "300"
      
  # Override specific tenant routes to return maintenance page
  # This file takes precedence when control plane HTTP provider is unreachable
```

### Migration Path from Current Single LXC

```
Phase 0 — Current state
  LXC 108: Traefik + vault-api (shared schema) + postgres
  → Rename LXC 108 to become LXC 101 (first app server)
  → Create new LXC 100 (control plane)

Phase 1 — Extract control plane (no downtime to existing tenants)
  LXC 100: Deploy control plane services
  LXC 100: Run control plane DB migrations
  LXC 100: Register LXC 101 as first app server
  LXC 100: Import existing tenants into routing table (pointing to LXC 101)
  LXC 100: Start Traefik on LXC 100, update DNS to point to LXC 100

Phase 2 — Migrate LXC 108 → LXC 101 identity
  LXC 101: Deploy vault-app (new multi-tenant-aware binary)
  LXC 101: Run schema migration (shared → per-tenant DBs, one DB per org)
  LXC 101: Verify all tenant routes work through new stack

Phase 3 — Add second app server when needed
  LXC 102: Provision new LXC, deploy vault-app
  POST /api/v1/servers to control plane (register)
  Control plane starts placing new tenants on LXC 102
```

**Time estimate for Phase 0→2**: 4–8 hours of engineering time for initial setup, ~15 minutes of actual downtime for DNS cutover.

---

## 7. Operational Cost vs. Shared Schema

This is the most important section. Be honest with yourself before choosing this architecture.

### Operational Overhead Per Tenant Added (DB-per-Tenant)

| Operation | Shared Schema | DB-per-Tenant (Federated) | Delta |
|---|---|---|---|
| Schema migration | 1 `migrate up` | N `migrate up` (one per tenant DB, parallelizable) | O(N) migrations |
| Backup | 1 `pg_dump` covers all | N `pg_dump` jobs (or logical backup per DB) | O(N) backup jobs |
| Backup monitoring | 1 alert rule | N alert rules (or aggregate monitoring) | High if naive |
| Index bloat check | 1 query | N queries | O(N) or aggregate view |
| Vacuum/autovacuum | Managed by Postgres | Separate autovacuum per DB | Effectively free, but N DBs to monitor |
| Connection pool sizing | Shared pool across tenants | Pool per DB (or PgBouncer per DB) | Significant — see below |
| Monitoring dashboards | 1 set | 1 aggregate + N tenant-level | Tooling investment |
| Migration rollback | 1 `migrate down` | N rollbacks, must succeed atomically across all tenants | Much harder |
| Adding a new DB column | 1 migration file | 1 migration file, N executions | Same code, more ops |
| Storage monitoring | 1 volume | N databases, each sized separately | Better isolation, more alert rules |

### Connection Pooling is the Biggest Hidden Cost

With shared schema: **one PgBouncer in transaction mode**, pool of 20–50 connections serves all tenants. PostgreSQL `max_connections=100` is easy to stay under.

With DB-per-tenant: **each tenant DB is a separate connection target**. Options:

1. **PgBouncer instance per tenant DB** — config file explosion, N processes
2. **PgBouncer with multiple `[databases]` sections** — manageable, but config must be regenerated on every tenant provision/deprovision
3. **pgpool-II** — can route by database name, but complex
4. **Direct connections with app-level pool** — simplest but hits `max_connections` quickly at N=50+ tenants

For a realistic 100-tenant deployment on a single server:
- 100 tenant DBs × 3 app connections (min pool) = 300 connections minimum
- PostgreSQL default `max_connections=100` — must be increased to ≥500
- Memory cost: ~5MB per connection × 500 = 2.5GB just for connection overhead
- **Required**: PgBouncer with per-database routing, OR reduce per-tenant pool to 1–2 connections

### Schema Migration Complexity

With shared schema, a migration is:

```bash
migrate -path ./migrations -database $DATABASE_URL up
# Done. 30 seconds.
```

With DB-per-tenant, a migration must run against every tenant DB, in order, with failure handling:

```go
func (m *MigrationRunner) RunAllTenants(ctx context.Context, version uint) error {
    var tenants []Tenant
    m.db.Where("state = 'active'").Find(&tenants)

    // Parallel with bounded concurrency
    sem := make(chan struct{}, 10) // 10 concurrent migrations
    var wg sync.WaitGroup
    var mu sync.Mutex
    var failures []string

    for _, t := range tenants {
        t := t
        wg.Add(1)
        sem <- struct{}{}
        go func() {
            defer wg.Done()
            defer func() { <-sem }()
            if err := m.migrateTenant(ctx, t.Slug, version); err != nil {
                mu.Lock()
                failures = append(failures, fmt.Sprintf("%s: %v", t.Slug, err))
                mu.Unlock()
            }
        }()
    }
    wg.Wait()

    if len(failures) > 0 {
        // CRITICAL: some tenants are on old schema, some on new
        // Must either: roll forward all failures, or roll back all successes
        return fmt.Errorf("%d tenant migrations failed: %v", len(failures), failures)
    }
    return nil
}
```

**The nightmare scenario**: A migration succeeds for 80 of 100 tenants, fails on tenant 81 due to a data anomaly, and rolls back. Now 80 tenants are on the new schema, 20 on the old. Your application must handle **both schema versions simultaneously**. In shared schema, this cannot happen.

**Mitigation**: Expand/contract pattern — additive migrations only (never rename/drop in the same release), backward-compatible schema changes always. This is good practice regardless, but it becomes load-bearing with DB-per-tenant.

### Backup Strategy

```bash
# Naive: separate cron job per tenant
# This does NOT scale. Instead:

# pg_dumpall with per-database output (one job, N files)
for db in $(psql -U vault_super -t -c "SELECT datname FROM pg_database WHERE datname LIKE 'vault_%'"); do
  pg_dump -U vault_super -Fc "$db" > "/backups/${db}_$(date +%Y%m%d_%H%M%S).dump"
done

# Better: pg_basebackup for the whole PostgreSQL instance (one backup covers all tenant DBs)
pg_basebackup -h localhost -U replication_user -D /backups/pgbase -Ft -z -P

# Better still: pgBackRest or Barman with incremental WAL archiving
# One configuration covers all databases on the instance
```

**Key insight**: if all tenant DBs live on the same PostgreSQL instance, `pg_basebackup` + WAL archiving is actually not much worse than shared schema. The complexity multiplier only becomes real when tenant DBs are spread across different instances (true federation).

### Realistic Overhead Numbers

For a **50-tenant SaaS deployment** on 2 app servers:

| Overhead category | Shared Schema | DB-per-Tenant | Additional effort |
|---|---|---|---|
| Initial setup | 2h | 8–16h | Control plane, provisioning, mTLS, routing |
| Schema migration deploy | 5 min | 20–30 min | Parallel runner + monitoring |
| New tenant provisioning | Instant (row insert) | 30–60 seconds (DB create + migrate) | Acceptable |
| Backup setup | 2h | 4h | pgBackRest config per instance |
| Monitoring setup | 4h | 8–12h | Aggregate dashboards across N DBs |
| On-call runbook pages | ~10 | ~30 | More failure modes, more procedures |
| Quarterly ops review | 30 min | 2h | More states, more to audit |
| **Year 1 engineering overhead** | ~20h | ~80–120h | **4–6× more** |

---

## 8. Self-Hosted First-Run Experience: Honest Verdict

### The Common Case

A user deploying Project Vault for the first time is:
- One team
- One organization
- Self-hosted, likely on a single VPS or Proxmox node
- Starting with 1–10 members
- Zero interest in multi-tenancy

For this user, the federated architecture is **actively harmful**:

| What they expect | What they get |
|---|---|
| `docker compose up` | Three compose files, two LXC containers, mTLS certificate generation |
| One database to understand | Control plane DB + at least one app server DB |
| `psql $DATABASE_URL` to debug | "Which database? What server?" |
| Simple backup | "Back up the control plane DB AND the app server DB" |
| `migrate up` | "Which tenant? All of them?" |
| Traefik config is obvious | Traefik HTTP provider polling an API that routes per-subdomain |

**The existing shared-schema design is correct for v1.** ADR-16 made the right call.

### When the Architecture Becomes Justified

| Trigger | Justification |
|---|---|
| Regulatory requirement (HIPAA, SOC2) requiring data isolation per customer | Shared schema + RLS may not satisfy an auditor who wants physical DB separation |
| Customer contracts requiring "your data is in its own database" | DB-per-tenant is the contractual answer |
| >500 tenants where one noisy neighbor affects p99 latency for others | DB-per-tenant allows per-tenant query plan isolation |
| Need to migrate one customer to a different region/server | Impossible with shared schema; trivial with DB-per-tenant |
| VIP customer requests their own dedicated hardware | Cannot do this with shared schema |
| Tenant-level PITR (restore one tenant to T-5min without restoring all) | Requires DB-per-tenant |

### Recommended Staged Approach

```
Stage 1 (v1, now): Shared schema, single node, single LXC
  → Serve 95% of use cases
  → Zero operational overhead
  → Current design, correct

Stage 2 (v2, SaaS tier): Shared schema per-instance, isolated Docker instances
  → Each SaaS customer gets a Docker Compose stack on a dedicated VM
  → Simpler than full federation — no control plane, no routing table
  → Just: one vault instance per customer, placed on a server with capacity
  → This covers "physical isolation" without the full federated complexity

Stage 3 (v2.5, enterprise tier): Full federation (this document)
  → Only when: >50 SaaS tenants, explicit isolation contract, VIP dedicated servers
  → Control plane as described above
  → Estimated to require: 3 months of focused engineering (not counting app changes)
```

### Stage 2 as an Alternative to Stage 3

Stage 2 deserves elaboration because it is **significantly simpler** than full federation while providing most of the isolation guarantees:

```
Per-customer isolated instance model:
  Customer ACME:  VPS-1, runs vault-acme docker-compose stack, one Postgres DB
  Customer BETA:  VPS-1 (different directory), runs vault-beta stack, one Postgres DB
  Customer CORP:  VPS-2 (VIP), dedicated VPS, runs vault-corp stack

Control plane needed: ONLY for:
  - Billing / account management
  - DNS / subdomain routing (static, or simple nginx map)
  - Backup orchestration (one job per stack)
  
No dynamic routing table. No provisioning API. No tenant migration orchestration.
Just: deploy a new docker-compose.yml, point DNS, done.
```

This model — "isolated instances, manually or script-provisioned" — serves Stage 2 with 20% of the engineering complexity of full federation. It becomes insufficient only when you need automated provisioning at scale (>20 new customers/month) or live tenant migration.

---

## Summary Decision Matrix

| Situation | Recommended Architecture |
|---|---|
| Self-hosted, single org, any size team | **Shared schema, single node** (current v1) |
| Self-hosted, multiple orgs (SaaS reseller) | **Shared schema + RLS** — existing design already supports this |
| SaaS, <50 customers, no isolation contract | **Isolated instances per customer** (Stage 2), script-provisioned |
| SaaS, >50 customers, isolation contracts | **Full federation** (this document, Stage 3) |
| VIP tenant, dedicated hardware required | **Full federation** with VIP placement support |
| One customer wants PITR or region migration | **Full federation** minimum |

### Irreducible Complexity Tax

If you commit to the federated architecture, these costs are non-negotiable:

1. **Expand/contract migrations always** — you can never do a breaking schema change in a single release
2. **mTLS between control plane and app servers** — the internal API has god-mode access; it must be mutually authenticated
3. **Routing table is a load-bearing single table** — it needs a Redis read cache, monitoring, and a static fallback for Traefik
4. **Every runbook doubles** — "restart the app server" is now "which app server, check if tenants are affected, update routing to offline first"
5. **Schema migration CI must test N-tenant scenarios** — a migration that works on one DB may fail on tenant DB #47 due to data drift
6. **Connection pool math must be re-done for every server added** — max_connections is a hard limit that must account for all tenant DBs

These are permanent. They do not get easier with scale; some get worse.

---

*This analysis is intended as input to an architecture decision record (ADR). The recommended action is: preserve shared schema for v1 and v2 self-hosted, implement isolated-instances for SaaS v2, and revisit full federation only when a concrete business trigger (regulatory isolation contract, VIP dedicated server request, or >50 SaaS customers) materializes.*
