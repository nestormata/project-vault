# Cell-Based / Silo Multi-Tenancy Architecture Analysis
## Project Vault — Distributed Systems Evaluation

**Author:** Architecture Review  
**Date:** 2026-04-09  
**Status:** Reference analysis — evaluating as v2 SaaS hosting strategy  
**Related specs:** `specs/multi-tenancy-data-model.md` (v1 baseline)

---

## Executive Summary

Cell-based architecture is a deployment and operational pattern, not a data model pattern. It distributes tenants across independent, self-contained units ("cells") that share nothing — each cell has its own compute, database, and network boundary. The central system handles only auth and routing; all tenant workloads run inside cells.

For Project Vault's v1 (self-hosted, single node): **do not use this**. The operational overhead is roughly 10× the complexity and brings zero benefit for the target deployment.

For Project Vault's v2 (hosted SaaS, multi-tenant cloud service): **this is the correct long-term architecture**. The isolation, blast-radius containment, and compliance guarantees it provides are exactly what enterprise secrets management customers require. Build it when you have 50+ enterprise tenants, not before.

---

## 1. What Is a Cell in Distributed Systems

### 1.1 Canonical Definition

A **cell** (also called a **silo** or **pod**) is a fully independent, self-contained deployment unit that:

- Owns its own database(s)
- Owns its own application servers / compute
- Owns its own internal networking
- Cannot directly communicate with sibling cells
- Shares only a thin routing/discovery layer with the outside world

The defining property is **shared-nothing between cells**. A failure in cell A cannot cascade to cell B because there is literally no shared resource for the failure to propagate through.

### 1.2 How Industry Leaders Implement This

**Slack (2022 "Cellular Architecture" write-up)**  
Slack partitioned their monolithic backend into cells mapped to channel clusters. Each cell runs its own Vitess MySQL cluster. The routing layer (their "Miro" service) maps workspace IDs to cell IDs. A workspace never crosses cell boundaries once assigned. Cell size is capped intentionally — when a cell approaches its limit, new tenants go to a new cell. This gives Slack hard blast-radius isolation: an outage in cell 3 does not affect workspaces in cells 1, 2, 4.

**GitHub**  
GitHub uses a concept they call "cluster routing" rather than "cells." For GitHub Actions and Packages, distinct runner clusters are scoped to regions with no shared state. For data, large enterprise customers on GHES (GitHub Enterprise Server) get entirely separate instances — the most extreme form of cell: one cell, one tenant.

**Notion (2022 blog post)**  
Notion migrated from shared RDS to a sharded PostgreSQL topology. Each "shard" is a cell: a dedicated RDS instance hosting N workspaces. The routing table is a flat mapping: `workspace_id → shard_id → shard_connection_string`. New workspaces are assigned to shards with available capacity. Hot/large workspaces can be promoted to dedicated shards (VIP cells in your proposed model). This is almost exactly the architecture you described.

**Figma**  
Figma uses a document-sharding model where each file is hashed to a backend worker cell. The cell owns the in-memory CRDT state and the PostgreSQL row for that file. This is a finer-grained cell (per-document vs. per-tenant), but structurally identical.

### 1.3 The Canonical Patterns

```
Pattern A — Tenant-to-Cell Mapping (Notion model)
Each tenant is assigned to exactly one cell. All of tenant's data lives in that cell.
Routing is a simple lookup table.

Pattern B — Consistent Hash Sharding (Figma/Vitess model)
Tenant (or entity) ID is hashed to determine cell. No lookup table needed — routing is deterministic.
Drawback: moving tenants requires rehashing; lookup-table model is more flexible.

Pattern C — One-Tenant-One-Cell (GHES model)
Maximum isolation. Each customer is their own cell. Used for enterprise/compliance tier.
Operationally expensive but provides full physical isolation.
```

For Project Vault's use case, **Pattern A** is the correct model.

---

## 2. The Architecture Diagram

```
                        ┌─────────────────────────────────────┐
                        │         CENTRAL CONTROL PLANE        │
                        │                                      │
                        │  ┌─────────────┐  ┌──────────────┐  │
                        │  │  Auth Svc   │  │ Router/Proxy │  │
                        │  │  (JWT issue)│  │  (cell lookup)│  │
                        │  └──────┬──────┘  └──────┬───────┘  │
                        │         │                 │          │
                        │  ┌──────▼─────────────────▼──────┐  │
                        │  │       Control Plane DB         │  │
                        │  │   (tenants, cell assignments,  │  │
                        │  │    cell registry, health)      │  │
                        │  └───────────────────────────────┘  │
                        └──────────────────┬──────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
          ┌─────────▼──────────┐ ┌─────────▼──────────┐ ┌────────▼───────────┐
          │      CELL 1        │ │      CELL 2        │ │    CELL 3 (VIP)    │
          │   (server-01)      │ │   (server-02)      │ │   (server-03)      │
          │                    │ │                    │ │                    │
          │ ┌────────────────┐ │ │ ┌────────────────┐ │ │ ┌────────────────┐ │
          │ │  vault-api     │ │ │ │  vault-api     │ │ │ │  vault-api     │ │
          │ │  (container)   │ │ │ │  (container)   │ │ │ │  (container)   │ │
          │ └───────┬────────┘ │ │ └───────┬────────┘ │ │ └───────┬────────┘ │
          │         │          │ │         │          │ │         │          │
          │ ┌───────▼────────┐ │ │ ┌───────▼────────┐ │ │ ┌───────▼────────┐ │
          │ │  PG: tenant_A  │ │ │ │  PG: tenant_C  │ │ │ │  PG: tenant_E  │ │
          │ │  PG: tenant_B  │ │ │ │  PG: tenant_D  │ │ │ │  (VIP, large)  │ │
          │ └────────────────┘ │ │ └────────────────┘ │ │ └────────────────┘ │
          └────────────────────┘ └────────────────────┘ └────────────────────┘
```

**Request flow:**

```
Client → Central Router → [lookup cell for tenant] → HTTP 302 or proxy → Cell API → Tenant DB
```

---

## 3. DB-Per-Tenant: Operational Realities

### 3.1 Connection Pool Overhead

This is the most underestimated cost of DB-per-tenant.

With shared-schema, you have **one connection pool** to one DB. With DB-per-tenant on a cell hosting N tenant DBs:

```
Connections = N_tenants × min_pool_size

Cell with 50 tenants × 5 min connections = 250 open PG connections at idle
PostgreSQL default max_connections = 100

You immediately need to:
  1. Set max_connections = 1000+ (requires pg restart, memory: ~10MB per connection)
  2. Use PgBouncer in transaction-mode between app and PG
  3. OR use lazy pool acquisition (open connection only on first request, close after TTL)
```

PostgreSQL connection memory cost: ~10MB per backend process. 1000 connections = ~10GB RAM just for PG backends. This is a hard constraint on cell sizing.

**Mitigation: PgBouncer per cell**

```
vault-api → PgBouncer (transaction mode) → postgres

PgBouncer multiplexes N app connections to M actual PG connections.
In transaction mode, a server connection is held only for the duration of one transaction.
Cost: 1 PgBouncer process per cell, ~50MB RAM.
```

PgBouncer in transaction mode is incompatible with:
- Session-level `SET` statements (must use `SET LOCAL` in transactions — which you're already doing for RLS GUC)
- `LISTEN/NOTIFY`
- Prepared statements without `server_reset_query` tuning

For Project Vault this is acceptable since you already use `set_config(..., true)` (transaction-local).

### 3.2 Migration Complexity

With one DB, `golang-migrate up` runs once. With N tenant DBs, you must:

1. Run migrations against every tenant DB when deploying a new version
2. Handle partial failures (some DBs migrated, some not — now you have schema drift)
3. Version-gate the API to handle both old and new schemas during rolling migration

```
naive approach:
  for each tenant DB in cell:
    migrate up                    # what if tenant_17 fails?
    # all subsequent tenants in same deploy now blocked or skipped

robust approach:
  1. store migration version in control plane DB per tenant DB
  2. deploy new app version with backward-compatible schema change first
  3. run migration worker that processes tenant DBs in batches with retry
  4. after all DBs are migrated, deploy app version that uses new column
```

This is the **expand/contract** pattern (also called blue/green schema). It makes every schema change a two-deploy process. Teams underestimate how much this slows down iteration velocity.

**Migration worker pseudocode:**

```go
// cmd/migrate-worker/main.go

func runCellMigrations(ctx context.Context, cell CellConfig, migrationPath string) error {
    tenants, err := controlPlane.ListTenantsForCell(ctx, cell.ID)
    if err != nil {
        return err
    }
    
    sem := semaphore.NewWeighted(5) // migrate 5 tenant DBs concurrently
    var errs []error
    var mu sync.Mutex
    
    for _, tenant := range tenants {
        tenant := tenant
        sem.Acquire(ctx, 1)
        go func() {
            defer sem.Release(1)
            if err := migrateTenantDB(ctx, tenant.DBDSN, migrationPath); err != nil {
                mu.Lock()
                errs = append(errs, fmt.Errorf("tenant %s: %w", tenant.ID, err))
                mu.Unlock()
                controlPlane.RecordMigrationFailure(ctx, tenant.ID, err)
                return
            }
            controlPlane.RecordMigrationSuccess(ctx, tenant.ID)
        }()
    }
    sem.Acquire(ctx, 5) // wait for all goroutines
    return errors.Join(errs...)
}
```

### 3.3 Provisioning Automation

Creating a new tenant requires:

1. Choose target cell (capacity-aware placement algorithm)
2. Create PostgreSQL database on that cell's PG server
3. Create PG user/role with least privilege
4. Run migrations against new DB
5. Register tenant → cell mapping in control plane
6. Issue initial encryption keys (for Project Vault: master key, KEK)
7. Return 201 Created to client

```go
// internal/provisioner/tenant.go

type ProvisionRequest struct {
    TenantID   uuid.UUID
    TenantSlug string
    Plan       string // "standard" | "vip"
}

func (p *Provisioner) ProvisionTenant(ctx context.Context, req ProvisionRequest) (*TenantRecord, error) {
    // 1. Select cell
    cell, err := p.cellSelector.SelectCell(ctx, req.Plan)
    if err != nil {
        return nil, fmt.Errorf("cell selection: %w", err)
    }
    
    dbName := fmt.Sprintf("vault_tenant_%s", req.TenantID.String()[:8])
    dbUser := fmt.Sprintf("vault_t_%s", req.TenantID.String()[:8])
    dbPass := generateSecurePassword(32)
    
    // 2. Create DB and user (connects as cell superuser)
    adminDB, err := p.cellConnections.GetAdminConn(ctx, cell.ID)
    if err != nil {
        return nil, fmt.Errorf("cell admin conn: %w", err)
    }
    
    if _, err := adminDB.ExecContext(ctx, 
        fmt.Sprintf(`CREATE DATABASE %s`, pgQuoteIdent(dbName))); err != nil {
        return nil, fmt.Errorf("create db: %w", err)
    }
    
    if _, err := adminDB.ExecContext(ctx,
        `CREATE USER $1 WITH PASSWORD $2`, dbUser, dbPass); err != nil {
        return nil, fmt.Errorf("create user: %w", err)
    }
    
    // 3. Run migrations
    tenantDSN := buildDSN(cell.Host, dbName, dbUser, dbPass)
    if err := p.migrator.MigrateUp(ctx, tenantDSN); err != nil {
        // rollback: DROP DATABASE is expensive; mark as poisoned and retry async
        p.scheduler.ScheduleCleanup(dbName, cell.ID)
        return nil, fmt.Errorf("migration: %w", err)
    }
    
    // 4. Register in control plane (atomic: if this fails, tenant is in limbo)
    record := &TenantRecord{
        TenantID:  req.TenantID,
        CellID:    cell.ID,
        DBDSN:     encryptDSN(tenantDSN), // never store plaintext credentials
        DBName:    dbName,
        CreatedAt: time.Now(),
    }
    if err := p.controlPlane.RegisterTenant(ctx, record); err != nil {
        return nil, fmt.Errorf("register tenant: %w", err)
    }
    
    return record, nil
}
```

**Provisioning latency is non-trivial.** `CREATE DATABASE` on PostgreSQL copies the `template1` database — typically 100–500ms. Migrations on an empty DB: 200–2000ms depending on count. Total provisioning time: 1–10 seconds. This should be async with a provisioning status endpoint, not synchronous in the sign-up flow.

### 3.4 Backup Isolation

This is a genuine advantage of DB-per-tenant. Each tenant DB can be backed up independently:

```bash
# Per-tenant logical backup
pg_dump -h cell-01.internal -U vault_admin -d vault_tenant_abc12345 \
  --format=custom --compress=9 \
  --file=/backups/tenants/abc12345/$(date +%Y%m%dT%H%M%S).dump

# Per-tenant PITR (requires per-DB WAL streaming — not standard)
# Standard PITR restores the entire PG instance.
# For per-tenant PITR you need either:
#   a) Logical replication slot per tenant DB → separate standby per tenant (expensive)
#   b) ZFS/LVM snapshots at filesystem level (works if one PG instance per tenant DB)
```

With shared-schema, restoring a single tenant requires:
1. Restore full DB to a temporary instance
2. Extract that tenant's rows
3. Import into production

With DB-per-tenant, you `pg_restore` exactly that tenant's dump. This is significantly simpler and faster for single-tenant recovery scenarios.

**RTO comparison:**

| Scenario | Shared Schema | DB-per-Tenant |
|---|---|---|
| Single tenant data corruption | Hours (extract from full restore) | ~15 min (restore single dump) |
| Full cell failure | N/A | Restore all tenants on cell (sequential) |
| Cross-tenant backup separation | Impossible with pg_dump | Native |

### 3.5 Recovery Time

DB-per-tenant does not automatically mean faster recovery. A cell with 50 tenant DBs that suffers PG server failure requires recovering 50 DBs. If you're using a shared PG instance (one postgres process hosting N databases), you lose all N tenants simultaneously — blast radius is the same as shared schema on that server.

True blast-radius isolation requires **one PostgreSQL instance per tenant** (Pattern C) or **one PG instance per N-tenant cell**, which contains the blast to only that cell's tenants.

---

## 4. Tenant Routing Layer

### 4.1 Control Plane Data Model

```sql
-- Control plane database (central, separate from any cell)

CREATE TABLE cells (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL UNIQUE,           -- "cell-01", "cell-vip-01"
    region        TEXT NOT NULL,                  -- "us-east-1", "eu-west-1"
    tier          TEXT NOT NULL DEFAULT 'standard', -- "standard" | "vip"
    api_base_url  TEXT NOT NULL,                  -- "https://cell-01.vault.internal"
    admin_db_dsn  TEXT NOT NULL,                  -- encrypted; cell's PG superuser DSN
    max_tenants   INTEGER NOT NULL DEFAULT 100,
    current_tenants INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active', -- "active" | "draining" | "offline"
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tenant_cells (
    tenant_id     UUID PRIMARY KEY,               -- FK → tenants.id in control plane
    cell_id       UUID NOT NULL REFERENCES cells(id),
    db_name       TEXT NOT NULL,
    db_dsn_enc    BYTEA NOT NULL,                 -- AES-256-GCM encrypted DSN
    status        TEXT NOT NULL DEFAULT 'active', -- "active" | "migrating" | "frozen"
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    migrated_from UUID REFERENCES cells(id),      -- non-null during/after tenant migration
    
    INDEX idx_tenant_cells_cell (cell_id),
    INDEX idx_tenant_cells_status (status)
);

CREATE TABLE tenants (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          TEXT NOT NULL UNIQUE,
    plan          TEXT NOT NULL DEFAULT 'standard',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ
);
```

### 4.2 Routing Lookup

The router is the hottest path in the system. It must:

1. Receive a request with tenant identifier (from JWT, subdomain, or `X-Tenant-ID` header)
2. Look up `tenant_id → cell_id → cell_api_base_url`
3. Forward or redirect the request

**This lookup must be cached.** Cache miss hits the control plane DB; cache hit is pure memory.

```go
// internal/router/router.go

type TenantRoute struct {
    CellID     uuid.UUID
    APIBaseURL string
    DBDSN      string
    ExpiresAt  time.Time
}

type Router struct {
    controlDB  *sql.DB
    cache      *ristretto.Cache // or sync.Map for small scale
    cacheTTL   time.Duration    // 60s is fine; tenant→cell mapping rarely changes
}

func (r *Router) Resolve(ctx context.Context, tenantID uuid.UUID) (*TenantRoute, error) {
    // L1: in-process cache
    if cached, ok := r.cache.Get(tenantID.String()); ok {
        return cached.(*TenantRoute), nil
    }
    
    // L2: control plane DB
    var route TenantRoute
    err := r.controlDB.QueryRowContext(ctx, `
        SELECT c.api_base_url, tc.db_dsn_enc, tc.cell_id
        FROM tenant_cells tc
        JOIN cells c ON c.id = tc.cell_id
        WHERE tc.tenant_id = $1
          AND tc.status = 'active'
          AND c.status IN ('active', 'draining')
    `, tenantID).Scan(&route.APIBaseURL, &encDSN, &route.CellID)
    
    if errors.Is(err, sql.ErrNoRows) {
        return nil, ErrTenantNotFound
    }
    if err != nil {
        return nil, fmt.Errorf("routing lookup: %w", err)
    }
    
    r.cache.SetWithTTL(tenantID.String(), &route, 1, r.cacheTTL)
    return &route, nil
}
```

### 4.3 Routing Strategies: HTTP 302 vs Transparent Proxy

**Option A: HTTP 302 Redirect**

```
Client → Central Router [302 Location: https://cell-01.internal/api/secrets]
Client → Cell-01 API (direct)
```

Pros: Zero proxy overhead after redirect; cell servers handle their own TLS  
Cons: Client must follow redirect (most HTTP clients do, but adds 1 RTT); leaks cell topology to clients; subdomains get complicated

For Project Vault CLI/SDK clients: **do not use 302**. Machine users (CI/CD pipelines) often have limited redirect handling. Internal SDKs should not expose cell topology.

**Option B: Transparent Reverse Proxy (Recommended)**

```
Client → Central Router (NGINX/Envoy/custom Go handler)
           └─ router.Resolve(tenantID)
           └─ proxy.ServeHTTP → https://cell-01.internal/api/secrets
```

```go
// internal/router/handler.go

func (h *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    tenantID, err := h.extractTenantID(r) // from JWT or X-Vault-Org header
    if err != nil {
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }
    
    route, err := h.router.Resolve(r.Context(), tenantID)
    if err != nil {
        if errors.Is(err, ErrTenantNotFound) {
            http.Error(w, "not found", http.StatusNotFound)
            return
        }
        http.Error(w, "service unavailable", http.StatusServiceUnavailable)
        return
    }
    
    target, _ := url.Parse(route.APIBaseURL)
    proxy := httputil.NewSingleHostReverseProxy(target)
    proxy.Transport = h.transportFor(route.CellID) // per-cell connection pool
    
    // Forward tenant context to cell (cell verifies JWT independently)
    r.Header.Set("X-Vault-Tenant-ID", tenantID.String())
    proxy.ServeHTTP(w, r)
}
```

**Latency budget for transparent proxy:**

```
Route cache hit:
  Cache lookup:     ~0.1ms
  Proxy overhead:   ~0.5ms
  Cell RTT:         ~1-5ms (same datacenter)
  Total overhead:   ~2-6ms vs direct

Route cache miss:
  Control plane DB: ~5-15ms
  + above           = 7-21ms
  
Cache hit rate target: >99% (most requests are repeat tenants)
```

**Option C: DNS-based routing**

```
tenant-slug.vault.example.com → CNAME → cell-01.vault.internal
```

DNS TTL of 30s gives reasonable failover speed. Works well if you control DNS; breaks if tenants use custom domains. **Too slow for tenant migration** (DNS propagation). Not recommended as primary routing mechanism, but useful as a secondary routing hint.

### 4.4 JWT Design for Cell Architecture

The JWT must carry enough context for the cell to validate the request without calling back to the control plane on every request:

```json
{
  "sub": "user-uuid",
  "org_id": "tenant-uuid",
  "cell_id": "cell-01-uuid",
  "exp": 1700000000,
  "iss": "vault-auth.control-plane"
}
```

Each cell has a copy of the control plane's JWT signing public key. The cell validates:
1. JWT signature (local, no network call)
2. `org_id` matches request path/header
3. `cell_id` matches its own identity (prevents token reuse on wrong cell)
4. Expiry

---

## 5. Scaling Mechanics

### 5.1 Tenant Migration (Moving Tenant Across Cells)

This is the hardest operational problem in cell-based architecture. It is unavoidable if you want to rebalance load or promote a tenant to a VIP cell.

**Migration algorithm: logical replication + cutover**

```
Phase 1: Setup (no downtime)
  1. Create new empty DB on target cell
  2. Run all migrations on target DB
  3. Establish logical replication: source DB → target DB
     (PostgreSQL logical replication via publication/subscription)
  4. Wait for initial copy to complete and replication lag → ~0

Phase 2: Cutover (brief downtime: 1-30 seconds)
  1. Set tenant status = 'migrating' in control plane
  2. Drain in-flight requests to source cell (wait for active transactions to complete)
  3. Stop accepting new requests for this tenant (router returns 503 briefly)
  4. Apply final WAL: confirm replication lag = 0
  5. Promote target DB (break replication)
  6. Update tenant_cells: set new cell_id, status = 'active'
  7. Invalidate router cache for this tenant
  8. Resume accepting requests → now served by new cell

Phase 3: Cleanup
  1. Keep source DB in read-only mode for 24-48h (rollback window)
  2. Drop source DB after verification window
```

```go
// internal/migrator/tenant_migrator.go

type TenantMigrator struct {
    controlDB    *sql.DB
    cellConns    CellConnectionRegistry
    router       *Router
}

func (m *TenantMigrator) Migrate(ctx context.Context, tenantID uuid.UUID, targetCellID uuid.UUID) error {
    // Phase 1: logical replication setup
    sourceCell, targetCell, err := m.getCells(ctx, tenantID, targetCellID)
    
    sourceDB := m.cellConns.GetAdminConn(sourceCell)
    targetDB := m.cellConns.GetAdminConn(targetCell)
    
    pubName := fmt.Sprintf("vault_pub_%s", tenantID.String()[:8])
    subName := fmt.Sprintf("vault_sub_%s", tenantID.String()[:8])
    
    // Create publication on source
    sourceDB.ExecContext(ctx, fmt.Sprintf(
        `CREATE PUBLICATION %s FOR ALL TABLES`, pubName))
    
    // Create subscription on target pointing to source
    targetDB.ExecContext(ctx, fmt.Sprintf(
        `CREATE SUBSCRIPTION %s CONNECTION '%s' PUBLICATION %s`,
        subName, sourceCell.DSN, pubName))
    
    // Wait for replication to catch up
    if err := m.waitForReplicationLag(ctx, targetDB, subName, 100*time.Millisecond); err != nil {
        return fmt.Errorf("replication lag wait: %w", err)
    }
    
    // Phase 2: cutover — must complete in < 30s or client timeouts begin
    return m.performCutover(ctx, tenantID, sourceCell, targetCell, subName)
}

func (m *TenantMigrator) performCutover(ctx context.Context, tenantID uuid.UUID, 
    source, target Cell, subName string) error {
    
    cutoverCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    
    // Mark as migrating (router starts returning 503 for this tenant)
    m.controlDB.ExecContext(cutoverCtx,
        `UPDATE tenant_cells SET status = 'migrating' WHERE tenant_id = $1`, tenantID)
    m.router.Invalidate(tenantID)
    
    // Final replication sync
    m.waitForReplicationLag(cutoverCtx, target.DB, subName, 0)
    
    // Atomic control plane update
    tx, _ := m.controlDB.BeginTx(cutoverCtx, nil)
    tx.ExecContext(cutoverCtx,
        `UPDATE tenant_cells SET cell_id = $1, status = 'active', migrated_from = cell_id 
         WHERE tenant_id = $2`, target.ID, tenantID)
    tx.Commit()
    
    // Re-enable routing to new cell
    m.router.Invalidate(tenantID)
    
    return nil
}
```

**Migration duration estimates:**

| Tenant DB size | Replication setup | Cutover window |
|---|---|---|
| < 1 GB | 1-5 min | 5-15 sec |
| 1-10 GB | 5-30 min | 15-30 sec |
| > 10 GB | 30+ min | 30-60 sec |

### 5.2 Provisioning a New Cell / Server

```go
// internal/provisioner/cell.go

type CellProvisionRequest struct {
    Name    string
    Region  string
    Tier    string
    Host    string  // IP or hostname of new server
    DBPort  int
    MaxTenants int
}

func (p *Provisioner) ProvisionCell(ctx context.Context, req CellProvisionRequest) (*Cell, error) {
    // 1. Verify connectivity to new server
    if err := p.pingCellDB(ctx, req.Host, req.DBPort); err != nil {
        return nil, fmt.Errorf("cell unreachable: %w", err)
    }
    
    // 2. Bootstrap cell: install vault-api service, configure PG
    //    (done via Ansible/cloud-init outside this code; assume it's ready)
    
    // 3. Register in control plane
    cell := &Cell{
        ID:         uuid.New(),
        Name:       req.Name,
        Region:     req.Region,
        Tier:       req.Tier,
        APIBaseURL: fmt.Sprintf("https://%s", req.Host),
        AdminDBDSN: encryptDSN(buildAdminDSN(req.Host, req.DBPort)),
        MaxTenants: req.MaxTenants,
        Status:     "active",
    }
    
    if err := p.controlDB.InsertCell(ctx, cell); err != nil {
        return nil, fmt.Errorf("register cell: %w", err)
    }
    
    // 4. Cell is now eligible for tenant placement
    return cell, nil
}
```

**Cell capacity selector:**

```go
// internal/provisioner/selector.go

func (s *CellSelector) SelectCell(ctx context.Context, tier string) (*Cell, error) {
    // Prefer cells with most available capacity first
    // For VIP tier: only select VIP cells
    row := s.db.QueryRowContext(ctx, `
        SELECT id, api_base_url, admin_db_dsn
        FROM cells
        WHERE status = 'active'
          AND tier = $1
          AND current_tenants < max_tenants
        ORDER BY (max_tenants - current_tenants) DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED  -- prevent two simultaneous provisions from selecting same cell
    `, tier)
    
    var cell Cell
    if err := row.Scan(&cell.ID, &cell.APIBaseURL, &cell.AdminDBDSNEncrypted); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, ErrNoCellCapacity // trigger: provision new cell
        }
        return nil, err
    }
    return &cell, nil
}
```

### 5.3 Load Rebalancing

Unlike a stateless service, you cannot simply add a cell and rebalance via load balancer weight. Tenant data must physically move. The rebalancer should:

1. Identify cells that are above a high-water mark (e.g., >80% of `max_tenants`)
2. Select tenants to migrate (smallest tenants first — fastest migration)
3. Schedule migrations during off-peak hours
4. Respect rate limits (e.g., no more than 3 concurrent tenant migrations per cell)

---

## 6. Go/PostgreSQL Specifics: Dynamic DB Connections

### 6.1 The Core Problem

With shared-schema, you have one `*gorm.DB` or `*pgxpool.Pool`. With DB-per-tenant, you need N pools, one per tenant DB. Managing this safely requires a pool-of-pools.

### 6.2 pgx Pool Registry

```go
// internal/db/pool_registry.go

type PoolRegistry struct {
    mu      sync.RWMutex
    pools   map[uuid.UUID]*pgxpool.Pool  // tenantID → pool
    config  *pgxpool.Config
    router  *router.Router
}

func NewPoolRegistry(router *router.Router) *PoolRegistry {
    return &PoolRegistry{
        pools:  make(map[uuid.UUID]*pgxpool.Pool),
        router: router,
    }
}

func (r *PoolRegistry) Get(ctx context.Context, tenantID uuid.UUID) (*pgxpool.Pool, error) {
    // Fast path: pool already exists
    r.mu.RLock()
    pool, ok := r.pools[tenantID]
    r.mu.RUnlock()
    if ok {
        return pool, nil
    }
    
    // Slow path: create pool (must be goroutine-safe)
    r.mu.Lock()
    defer r.mu.Unlock()
    
    // Double-check after acquiring write lock
    if pool, ok = r.pools[tenantID]; ok {
        return pool, nil
    }
    
    route, err := r.router.Resolve(ctx, tenantID)
    if err != nil {
        return nil, fmt.Errorf("resolve tenant route: %w", err)
    }
    
    cfg, err := pgxpool.ParseConfig(route.DBDSN)
    if err != nil {
        return nil, fmt.Errorf("parse DSN: %w", err)
    }
    
    // Conservative pool sizing: too large = PG connection exhaustion
    cfg.MaxConns = 10
    cfg.MinConns = 2
    cfg.MaxConnLifetime = 30 * time.Minute
    cfg.MaxConnIdleTime = 5 * time.Minute
    
    pool, err = pgxpool.NewWithConfig(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("create pool for tenant %s: %w", tenantID, err)
    }
    
    r.pools[tenantID] = pool
    return pool, nil
}

func (r *PoolRegistry) Evict(tenantID uuid.UUID) {
    r.mu.Lock()
    defer r.mu.Unlock()
    if pool, ok := r.pools[tenantID]; ok {
        pool.Close()
        delete(r.pools, tenantID)
    }
}
```

**Memory cost per pool:** ~2MB for pool metadata + connection overhead. 100 tenant pools × 2MB = ~200MB before PG connections. Acceptable.

**Pool eviction:** You need a background goroutine that closes pools for inactive tenants (tenants not queried in, say, 15 minutes). Without eviction, a cell with 500 historical tenants maintains 500 open connection pools indefinitely.

```go
// Idle pool reaper — runs every 5 minutes
func (r *PoolRegistry) StartReaper(ctx context.Context, idleTTL time.Duration) {
    ticker := time.NewTicker(5 * time.Minute)
    go func() {
        for {
            select {
            case <-ticker.C:
                r.mu.Lock()
                for tenantID, pool := range r.pools {
                    if pool.Stat().IdleConns() == pool.Stat().TotalConns() {
                        // All connections idle — this tenant hasn't been active
                        pool.Close()
                        delete(r.pools, tenantID)
                    }
                }
                r.mu.Unlock()
            case <-ctx.Done():
                return
            }
        }
    }()
}
```

### 6.3 GORM with Dynamic DB Connections

GORM wraps a single `*sql.DB`. For DB-per-tenant, you can't use the standard GORM initialization pattern. Two options:

**Option A: GORM DB factory per request (expensive but simple)**

```go
func (s *SecretService) GetSecret(ctx context.Context, tenantID uuid.UUID, ...) (*Secret, error) {
    pool, err := s.registry.Get(ctx, tenantID)
    if err != nil {
        return nil, err
    }
    
    // Wrap pgx pool in a *sql.DB for GORM compatibility
    sqlDB := stdlib.OpenDBFromPool(pool) // pgx/v5/stdlib
    gormDB, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlDB}), &gorm.Config{})
    
    // This creates a new GORM instance each call — expensive! GORM caches prepared statements.
    // Acceptable if GORM instance is cached per-tenant too.
}
```

**Option B: GORM instance cache (recommended)**

```go
type GORMRegistry struct {
    mu      sync.RWMutex
    dbs     map[uuid.UUID]*gorm.DB
    pools   *PoolRegistry
}

func (g *GORMRegistry) Get(ctx context.Context, tenantID uuid.UUID) (*gorm.DB, error) {
    g.mu.RLock()
    db, ok := g.dbs[tenantID]
    g.mu.RUnlock()
    if ok {
        return db.WithContext(ctx), nil
    }
    
    g.mu.Lock()
    defer g.mu.Unlock()
    
    pool, err := g.pools.Get(ctx, tenantID)
    if err != nil {
        return nil, err
    }
    
    sqlDB := stdlib.OpenDBFromPool(pool)
    gormDB, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlDB}), &gorm.Config{
        Logger: logger.Default.LogMode(logger.Silent),
    })
    if err != nil {
        return nil, err
    }
    
    g.dbs[tenantID] = gormDB
    return gormDB.WithContext(ctx), nil
}
```

**Note:** With DB-per-tenant, RLS is still a useful defense-in-depth layer even though the DB boundary already provides isolation. The GUC-setting `TenantTx` wrapper can remain unchanged — it adds zero-cost redundancy.

---

## 7. Honest Comparison: Cell-Based vs. Shared Schema + RLS

### 7.1 Tradeoff Matrix

| Dimension | Shared Schema + RLS | Cell-Based / DB-per-Tenant |
|---|---|---|
| **Operational complexity** | Low (1 DB, 1 migration run, 1 connection pool) | Very High (N DBs, migration orchestration, pool registry, routing layer, tenant migration tooling) |
| **Development velocity** | Fast (add column = 1 migration) | Slow (expand/contract, migration worker) |
| **Blast radius** | Full DB (all tenants affected by DB failure) | Cell (only tenants on that cell affected) |
| **Tenant data isolation** | Logical (RLS + app scope) | Physical (separate DB files, separate OS processes) |
| **Compliance posture** | "Data is logically isolated" | "Data is physically isolated" |
| **Single-tenant recovery** | Hard (extract from full backup) | Easy (restore single dump) |
| **Connection overhead** | 1 pool, ~10-50 connections | N pools, 2-10 connections each |
| **Backup strategy** | Full DB backup, complex restore | Per-tenant backup, simple restore |
| **Schema migration** | 1 command | Migration worker + drift tracking |
| **Tenant provisioning** | Fast (~10ms: insert org row) | Slow (1-10s: CREATE DATABASE + migrations) |
| **Cross-tenant queries** | Trivial (same DB) | Impossible by design (requires control plane aggregation) |
| **Cost at 10 tenants** | ~$20/mo (single small PG) | ~$200/mo (cell infra + routing service) |
| **Cost at 10,000 tenants** | Single large DB or read replicas | ~100 cells × $20-200/mo |
| **Encryption key isolation** | Application-managed (same KEK store) | True per-tenant KEK isolation possible |
| **Noisy neighbor problem** | Possible (one tenant's heavy query affects all) | Eliminated within cell; possible between tenants in same cell |
| **Time to build v1** | 2-4 weeks | 3-6 months |

### 7.2 When DB-Per-Tenant Starts to Win

The crossover point depends on your compliance tier and operational maturity:

**DB-per-tenant wins clearly when:**

1. **Enterprise/regulated customers require physical data isolation.** "Logically isolated via RLS" fails SOC 2 Type II audits at some enterprise procurement teams. "Dedicated database, separate from all other customers" passes. This is the dominant reason companies do this.

2. **You have VIP/large tenants generating 90% of your data.** A single tenant with 10M secrets in a shared schema degrades query performance for all tenants even with perfect indexing. In their own DB, their usage patterns don't affect anyone else.

3. **You need per-tenant backup SLAs.** "We can restore your specific org to any point in the last 30 days within 15 minutes" is operationally achievable with per-tenant dumps. Not achievable with shared schema.

4. **You've crossed ~500 tenants on a shared DB and are seeing hot-row contention or catalog overhead.** The `pg_catalog` (system tables) is a shared resource; 500+ tenants with millions of rows each starts to show.

5. **GDPR "right to erasure" is a product requirement.** Deleting a tenant from shared schema requires deleting/anonymizing every row with their `org_id` — expensive and risky. Dropping a database is `DROP DATABASE` — instant, complete, and auditable.

**Shared schema + RLS wins clearly when:**

1. **You are self-hosted.** A team running their own Project Vault instance has exactly 1-10 orgs. The infrastructure overhead of cell-based architecture is absurd for this use case.

2. **You are pre-product-market-fit.** Schema iteration speed matters more than isolation purity when you're still changing your data model weekly.

3. **You have fewer than ~200 tenants.** Below this scale, the operational costs of cell-based architecture exceed the benefits by a large margin.

4. **Your engineering team is < 5 people.** Cell-based architecture requires dedicated platform/infra engineering. It is not a side project.

### 7.3 The v1 → v2 Migration Path

Project Vault's architecture (from `specs/multi-tenancy-data-model.md`) is well-designed for a future migration:

```
v1 (current): Shared Schema + RLS
  - All tenants in one DB
  - org_id on every table
  - Three-layer isolation (app + RLS + RBAC)

v2 (future SaaS): Cell-based
  - Extract control plane (auth + routing) as separate service
  - Each new enterprise tenant gets provisioned into a dedicated DB on a cell
  - Existing shared-schema tenants remain on "cell-0" (legacy shared cell)
  - Migration path: self-service tenant DB export → re-import to dedicated DB
```

The `org_id` denormalization on every table is not wasted work — it becomes the natural partition key for extracting a tenant's data during this migration. A single `pg_dump --table ... --where "org_id = 'uuid'"` per table dumps exactly that tenant's data.

---

## 8. Recommended Architecture for Project Vault v2 SaaS

If/when you build the hosted SaaS tier, use this tiered cell model:

```
Tier 0 — Shared Cell (Standard Plan)
  One PostgreSQL DB, shared schema + RLS
  All standard-plan tenants
  Exactly what you have today
  Operational cost: ~$0 marginal per new tenant

Tier 1 — Standard Cell (Growth Plan)
  One cell = 1 PostgreSQL instance + 1 vault-api container
  25-100 tenants per cell
  DB-per-tenant within the cell
  Operational cost: ~$0.50-2/tenant/mo

Tier 2 — Dedicated Cell (Enterprise Plan)
  One cell = 1 tenant
  Highest isolation guarantee
  Customer can specify region
  Operational cost: ~$50-200/tenant/mo
```

This matches the Notion "workspace sharding" model and gives you a commercial upsell story at each tier.

---

## 9. Implementation Checklist (If You Build This)

Before starting implementation, you need all of these:

- [ ] **Control plane service** — separate deployable from vault-api; owns cell registry, tenant routing table, auth
- [ ] **Cell provisioner** — automated `CREATE DATABASE` + migrations + registration
- [ ] **Migration worker** — parallel tenant DB migrations with drift tracking
- [ ] **Pool registry** — pgx pool per tenant DB with idle reaper
- [ ] **Transparent proxy** — HTTP reverse proxy with tenant-to-cell routing, route cache
- [ ] **Tenant migrator** — logical replication + cutover automation
- [ ] **Cell health monitor** — detects cell failures, triggers rerouting
- [ ] **Backup automation** — per-tenant `pg_dump` scheduled jobs
- [ ] **Capacity planner** — auto-provision new cells when existing cells approach capacity
- [ ] **Observability** — per-tenant metrics (latency, error rate, DB size) across all cells

**Estimated build time:** 3-6 months for a 2-person team building nothing else.

---

## 10. Final Verdict

| Question | Answer |
|---|---|
| Is cell-based architecture right for Project Vault v1? | **No.** Single-node shared schema is correct and sufficient. |
| Is it right for v2 SaaS? | **Yes, eventually.** But only after 50+ enterprise tenants justify the infra investment. |
| Is the proposed design sound? | **Yes.** Central control plane + cell routing + DB-per-tenant is the canonical pattern. No architectural flaws. |
| What's the biggest risk? | Tenant migration complexity. `CREATE DATABASE` and logical replication during cutover are operationally fragile. Build this last, not first. |
| What to build first? | Control plane data model + provisioner. Routing can start as 302 redirects. Transparent proxy and migration tooling come later. |
| Does the v1 schema facilitate v2 migration? | **Yes.** `org_id` denormalization on every table is exactly right for future extraction. |

The architecture you proposed is well-conceived. The risk is not in the design — it's in underestimating the operational engineering required to run it reliably. Cells are not free isolation; they are a redistribution of complexity from the data model into the infrastructure layer.
