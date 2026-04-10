# Multi-Tenancy Data Model — Project Vault

**Status:** Active — v1 design  
**Version:** 1.0  
**Source:** `_bmad-output/planning-artifacts/research/technical-multi-tenancy-data-model-research-2026-04-09.md`  
**ADRs:** ADR-16 (isolation strategy), ADR-17 (org_id denorm policy), ADR-18 (reporting bypass)

---

## Isolation Strategy

**Chosen strategy: Shared Schema** — single PostgreSQL database, single set of tables, `org_id UUID NOT NULL` column on every tenant-owned table.

All three strategies were evaluated:

| Strategy | Verdict for Project Vault v1 |
|---|---|
| Shared schema + `org_id` | ✅ Recommended — single node, simple migrations, works with GORM scopes + RLS |
| Schema-per-tenant (`SET search_path`) | ❌ Deferred — migration tooling pain, catalog bloat at scale, breaks SQLite compat |
| Database-per-tenant | ❌ Not suitable — operationally heavy for self-hosted single-node |

**Defense-in-depth**: Three isolation layers, any single failure does not produce a cross-tenant leak:
1. **Application layer** — GORM `OrgScope` appends `WHERE org_id = ?` to every query
2. **Database layer** — PostgreSQL RLS policy validates `org_id = current_setting('app.current_org_id', true)::uuid`
3. **RBAC layer** — Casbin `org:{uuid}` domain enforcement (see `specs/rbac-permission-architecture.md`)

---

## Entity Hierarchy

```
Organization (tenant root)
└── Project (sub-scope)
    └── Environment (within project)
        └── Secret (leaf — most sensitive)
            └── SecretVersion (history)
```

`org_id` is **denormalized** onto every tenant-scoped table — no JOINs needed in RLS expressions, and `(org_id, ...)` composite index serves as the leading column for all tenant-scoped queries.

---

## Database Schema

### `organizations`

```sql
CREATE TABLE organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    plan       TEXT NOT NULL DEFAULT 'self-hosted',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ  -- soft delete
);

CREATE INDEX idx_organizations_slug   ON organizations(slug);
CREATE INDEX idx_organizations_active ON organizations(id) WHERE deleted_at IS NULL;
```

### `projects`

```sql
CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ,
    UNIQUE (org_id, slug)
);
ALTER TABLE projects ADD UNIQUE (id, org_id);  -- required for composite FK references

CREATE INDEX idx_projects_org        ON projects(org_id);
CREATE INDEX idx_projects_org_active ON projects(org_id) WHERE deleted_at IS NULL;
```

### `environments`

```sql
CREATE TABLE environments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id     UUID NOT NULL REFERENCES organizations(id),  -- denormalized
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name),
    CONSTRAINT fk_env_project_org FOREIGN KEY (project_id, org_id)
        REFERENCES projects(id, org_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE environments ADD UNIQUE (id, org_id);  -- required for composite FK references

CREATE INDEX idx_environments_project ON environments(project_id);
CREATE INDEX idx_environments_org     ON environments(org_id);
```

### `secrets`

```sql
CREATE TABLE secrets (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id           UUID NOT NULL REFERENCES organizations(id),  -- denormalized
    environment_id   UUID NOT NULL REFERENCES environments(id),
    path             TEXT NOT NULL,
    key              TEXT NOT NULL,
    encrypted_value  BYTEA NOT NULL,   -- AES-256-GCM ciphertext
    encrypted_dek    BYTEA NOT NULL,   -- envelope-encrypted DEK
    version          INTEGER NOT NULL DEFAULT 1,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    comment          TEXT,
    created_by       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at       TIMESTAMPTZ,
    UNIQUE (project_id, environment_id, path, key) WHERE deleted_at IS NULL,
    CONSTRAINT fk_secret_env_org FOREIGN KEY (environment_id, org_id)
        REFERENCES environments(id, org_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_secrets_project    ON secrets(project_id);
CREATE INDEX idx_secrets_org        ON secrets(org_id);
CREATE INDEX idx_secrets_env        ON secrets(environment_id);
CREATE INDEX idx_secrets_lookup     ON secrets(project_id, environment_id, path, key)
    WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX idx_secrets_org_active ON secrets(org_id, project_id)
    WHERE deleted_at IS NULL AND is_active = true;
```

### `secret_versions`

```sql
CREATE TABLE secret_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    secret_id       UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    org_id          UUID NOT NULL REFERENCES organizations(id),  -- denormalized
    version         INTEGER NOT NULL,
    encrypted_value BYTEA NOT NULL,
    encrypted_dek   BYTEA NOT NULL,
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (secret_id, version)
);

CREATE INDEX idx_secret_versions_secret ON secret_versions(secret_id, version DESC);
CREATE INDEX idx_secret_versions_org    ON secret_versions(org_id);
```

---

## Row-Level Security (RLS)

### Database Roles

| Role | Privileges | RLS Behavior |
|---|---|---|
| `vault_migrate` | SUPERUSER — schema changes and seed data | Bypasses RLS (expected for migrations) |
| `vault_app` | Application queries (SELECT, INSERT, UPDATE, DELETE) | Bound by RLS policies — FORCE RLS if owner |
| `vault_ro` | Read-only compliance/audit queries | Explicit SELECT-only bypass policy |

### Tenant Context Injection

```sql
-- Called at the start of every transaction (transaction-local; auto-resets on COMMIT/ROLLBACK)
SELECT set_config('app.current_org_id', '<org-uuid>', true);
```

`is_local = true` (third argument) is mandatory for connection-pooled environments. With `is_local = false`, the GUC persists for the session — unsafe when pgx pool or pgbouncer recycles connections between transactions.

### Policy Definitions

```sql
-- Enable on all tenant-scoped tables
ALTER TABLE projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_versions ENABLE ROW LEVEL SECURITY;

-- FORCE RLS so vault_app (table owner) is also subject to policy
ALTER TABLE projects       FORCE ROW LEVEL SECURITY;
ALTER TABLE environments   FORCE ROW LEVEL SECURITY;
ALTER TABLE secrets        FORCE ROW LEVEL SECURITY;
ALTER TABLE secret_versions FORCE ROW LEVEL SECURITY;

-- Permissive policy: all operations scoped to current org
CREATE POLICY projects_tenant_isolation ON projects
    AS PERMISSIVE FOR ALL TO vault_app
    USING     (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY environments_tenant_isolation ON environments
    AS PERMISSIVE FOR ALL TO vault_app
    USING     (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY secrets_tenant_isolation ON secrets
    AS PERMISSIVE FOR ALL TO vault_app
    USING     (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY secret_versions_tenant_isolation ON secret_versions
    AS PERMISSIVE FOR ALL TO vault_app
    USING     (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- Read-only bypass for vault_ro (admin audit queries)
CREATE POLICY projects_ro_bypass        ON projects        AS PERMISSIVE FOR SELECT TO vault_ro USING (true);
CREATE POLICY environments_ro_bypass    ON environments    AS PERMISSIVE FOR SELECT TO vault_ro USING (true);
CREATE POLICY secrets_ro_bypass         ON secrets         AS PERMISSIVE FOR SELECT TO vault_ro USING (true);
CREATE POLICY secret_versions_ro_bypass ON secret_versions AS PERMISSIVE FOR SELECT TO vault_ro USING (true);
```

**`current_setting('app.current_org_id', true)` with `missing_ok=true`:** returns NULL (not an error) when GUC is unset (e.g., connection not yet initialized or superuser session). NULL in USING expression → row excluded → default-deny behavior with no error thrown.

---

## GORM Models

```go
// internal/db/models/models.go

type Organization struct {
    ID        uuid.UUID      `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
    Name      string         `gorm:"not null"`
    Slug      string         `gorm:"not null;uniqueIndex"`
    Plan      string         `gorm:"not null;default:'self-hosted'"`
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt gorm.DeletedAt `gorm:"index"`
}

type Project struct {
    ID        uuid.UUID      `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
    OrgID     uuid.UUID      `gorm:"type:uuid;not null;index"`
    Name      string         `gorm:"not null"`
    Slug      string         `gorm:"not null"`
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt gorm.DeletedAt `gorm:"index"`
}

type Environment struct {
    ID        uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
    ProjectID uuid.UUID `gorm:"type:uuid;not null;index"`
    OrgID     uuid.UUID `gorm:"type:uuid;not null;index"`
    Name      string    `gorm:"not null"`
    Position  int       `gorm:"not null;default:0"`
    CreatedAt time.Time
    UpdatedAt time.Time
}

type Secret struct {
    ID             uuid.UUID      `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
    ProjectID      uuid.UUID      `gorm:"type:uuid;not null;index"`
    OrgID          uuid.UUID      `gorm:"type:uuid;not null;index"`
    EnvironmentID  uuid.UUID      `gorm:"type:uuid;not null;index"`
    Path           string         `gorm:"not null"`
    Key            string         `gorm:"not null"`
    EncryptedValue []byte         `gorm:"not null"`
    EncryptedDEK   []byte         `gorm:"not null"`
    Version        int            `gorm:"not null;default:1"`
    IsActive       bool           `gorm:"not null;default:true"`
    CreatedBy      *uuid.UUID     `gorm:"type:uuid"`
    CreatedAt      time.Time
    UpdatedAt      time.Time
    DeletedAt      gorm.DeletedAt `gorm:"index"`
}

type SecretVersion struct {
    ID             uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
    SecretID       uuid.UUID `gorm:"type:uuid;not null;index"`
    OrgID          uuid.UUID `gorm:"type:uuid;not null;index"`
    Version        int       `gorm:"not null"`
    EncryptedValue []byte    `gorm:"not null"`
    EncryptedDEK   []byte    `gorm:"not null"`
    CreatedBy      *uuid.UUID `gorm:"type:uuid"`
    CreatedAt      time.Time
}
```

---

## Tenant Context Helpers (`internal/db/tenant.go`)

```go
type contextKey string
const orgIDKey contextKey = "org_id"

func WithOrgID(ctx context.Context, orgID uuid.UUID) context.Context {
    return context.WithValue(ctx, orgIDKey, orgID)
}

func OrgIDFromCtx(ctx context.Context) (uuid.UUID, bool) {
    id, ok := ctx.Value(orgIDKey).(uuid.UUID)
    return id, ok
}

// OrgScope appends WHERE org_id = ? to any GORM query.
func OrgScope(orgID uuid.UUID) func(*gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        return db.Where("org_id = ?", orgID)
    }
}

// ProjectScope appends WHERE org_id = ? AND project_id = ?.
func ProjectScope(orgID, projectID uuid.UUID) func(*gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        return db.Where("org_id = ? AND project_id = ?", orgID, projectID)
    }
}

// TenantTx opens a transaction, sets the transaction-local GUC for RLS,
// then calls fn with a pre-scoped DB.
func TenantTx(ctx context.Context, db *gorm.DB, orgID uuid.UUID, fn func(tx *gorm.DB) error) error {
    return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
        if err := tx.Exec(
            "SELECT set_config('app.current_org_id', ?, true)",
            orgID.String(),
        ).Error; err != nil {
            return fmt.Errorf("set tenant context: %w", err)
        }
        return fn(tx.Scopes(OrgScope(orgID)))
    })
}
```

**Usage example:**

```go
func (s *SecretService) GetSecret(ctx context.Context, orgID, projectID uuid.UUID, path, key string) (*Secret, error) {
    var secret Secret
    err := TenantTx(ctx, s.db, orgID, func(tx *gorm.DB) error {
        return tx.Scopes(ProjectScope(orgID, projectID)).
            Where("path = ? AND key = ? AND is_active = true", path, key).
            First(&secret).Error
    })
    return &secret, err
}
```

---

## Cross-Tenant Leakage Prevention

| Risk vector | Prevention mechanism |
|---|---|
| URL `org_id` manipulation | Auth middleware validates URL `orgID` against JWT-claimed `orgID`; mismatch → 403 |
| `project_id` belonging to different org | `ProjectScope(orgID, projectID)` filters BOTH columns; missing row → 404 |
| GORM scope forgotten at call site | RLS backstop; integration test per API endpoint asserting cross-tenant 404 |
| RLS GUC not set | `current_setting(..., true)` returns NULL → USING false → 0 rows (no error, no leak) |
| Migration bypassing app-layer scopes | Migrations run as `vault_migrate` (superuser); bypasses RLS intentionally |
| Backup/pg_dump cross-tenant | pg_dump uses `vault_migrate` role; `row_security=off` set explicitly |
| Machine token cross-org | Token's `org_id` from DB record (not request); request org validated against token's org |
| Concurrent connection GUC contamination | `is_local=true` in `set_config` — GUC auto-resets on COMMIT/ROLLBACK; cannot leak across connections |

---

## Package Layout

```
internal/
    db/
        tenant.go              # OrgScope, ProjectScope, TenantTx, context helpers
        models/
            organization.go
            project.go
            environment.go
            secret.go          # Secret + SecretVersion
    migrations/
        001_create_organizations.sql
        002_create_projects.sql
        003_create_environments.sql
        004_create_secrets.sql
        005_rls_policies.sql
        006_db_roles.sql
```

---

## Open ADRs

| ADR | Topic | Recommendation |
|---|---|---|
| ADR-16 | Tenant isolation strategy — Shared Schema for Tier 0 (v1 self-hosted + small SaaS). Cell-based for Tier 1/2 when triggered by isolation contracts or 50+ enterprise tenants. | Shared Schema now; cell-based when business trigger materializes. |
| ADR-17 | `org_id` denormalization scope — all tenant-owned tables vs. only tables with RLS | All tables (RLS applied to all; one UUID column overhead is negligible; enables future cell extraction with zero schema changes) |
| ADR-18 | Reporting bypass strategy — `vault_ro` role with explicit SELECT-only bypass policy | `vault_ro` + bypass policy; no separate analytics DB until scale requires it |
| ADR-19 | When federation is built: lookup-table routing (Pattern A) vs. consistent hash routing. Central auth JWT design. | Lookup table for operational flexibility. RS256 JWTs with `vault.app_server` routing hint. JWKS-based local validation on app servers (no per-request central auth coupling). |
| ADR-20 | Machine tokens in federated model — how do they bypass browser redirect? | Machine tokens exchange directly with central auth for JWT + `server_url`. `VAULT_SERVER_URL` env var overrides routing for air-gapped/CI deployments. |
| ADR-21 | Connection pooling in DB-per-tenant cells | PgBouncer in transaction mode per cell (mandatory when >10 tenant DBs per cell). Per-tenant `pgxpool` registry with idle reaper on app servers. Compatible with existing `set_config(..., true)` pattern. |

---

## Future Architecture: Three-Tier Isolation Model

> This section documents the architecture to build when v1 triggers are met. No implementation action required for v1.

Three isolation tiers driven by concrete business triggers:

```
TIER 0 — SHARED SCHEMA (current, v1)
  Target:    Self-hosted, small SaaS (<50 tenants)
  Database:  Single PostgreSQL, shared tables, org_id on all rows
  Isolation: GORM OrgScope + PostgreSQL RLS
  Overhead:  Low
  Stay here: Until isolation contracts or 50th enterprise tenant

TIER 1 — CELL-BASED (SaaS v2)
  Target:    50–500 tenants, regulatory isolation requirements
  Database:  N cells, each with 25–100 tenant DBs + PgBouncer
  Isolation: DB-per-tenant, central auth + routing
  Overhead:  4–6× vs. Tier 0
  Trigger:   First isolation contract OR 50th enterprise customer

TIER 2 — DEDICATED CELLS (enterprise)
  Target:    VIP tenants, physical isolation contracts
  Database:  1 PostgreSQL per tenant, dedicated server
  Isolation: Physical; 1 tenant per cell
  Overhead:  Highest; justified by revenue/contract
  Trigger:   Explicit enterprise isolation contract
```

### Central Auth JWT (for Tier 1/2)

```json
{
  "iss": "https://auth.vault.example.com",
  "sub": "usr_01HXYZ...",
  "aud": ["vault-app"],
  "exp": 1720003600,
  "jti": "tok_01HXYZ...",
  "vault": {
    "org_id":      "org_01HABC...",
    "app_server":  "https://app-eu.vault.example.com",
    "shard_id":    "eu-1",
    "auth_method": "password"
  },
  "roles": { "org:org_01HABC...": "org_member" }
}
```

`vault.app_server` is **informational only** — app servers validate `org_id` against their local tenant registry, not the routing hint. JWKS-based local validation; no per-request central auth coupling.

### Control Plane DB (minimal schema)

```sql
CREATE TABLE servers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL UNIQUE,
    internal_url  TEXT NOT NULL,   -- mTLS-protected provisioning API
    public_url    TEXT NOT NULL,   -- Traefik backend
    tier          TEXT NOT NULL DEFAULT 'standard',
    status        TEXT NOT NULL DEFAULT 'active',
    max_tenants   INTEGER NOT NULL DEFAULT 100,
    current_tenants INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE routing_rules (
    tenant_id     UUID NOT NULL PRIMARY KEY,
    server_id     UUID NOT NULL REFERENCES servers(id),
    subdomain     TEXT NOT NULL UNIQUE,
    state         TEXT NOT NULL DEFAULT 'active'  -- active|draining|readonly|migrating
);
-- Traefik polls GET /api/v1/traefik-config (HTTP provider, 5s interval)
```

### Proxmox Migration Path (from current single LXC)

```
Phase 0 (now):   LXC 108 — everything (Traefik + vault-api + PostgreSQL)
Phase 1:         LXC 100 — control plane + Traefik  (~4h engineering, ~15 min downtime)
                 LXC 108 — existing vault (now "Server 01")
Phase 2:         LXC 101 — new app server (Server 02), new tenants land here
Phase 3 (VIP):   LXC 102 — dedicated server, single-tenant cell
```

**Full analysis:** `design-artifacts/central-auth-tenant-routing-analysis.md`, `design-artifacts/cell-based-architecture-analysis.md`, `docs/federated-multi-tenant-architecture-analysis.md`  
**Research addendum:** `_bmad-output/planning-artifacts/research/technical-multi-tenancy-data-model-research-2026-04-09.md` (Addendum A.1–A.7)
