---
stepsCompleted: [1, 2, 3, 4, 5, 6, 'addendum-federated']
inputDocuments: []
workflowType: 'research'
lastStep: 6
research_type: 'technical'
research_topic: 'Multi-Tenancy Data Model'
research_goals: 'Design the multi-tenancy data model architecture for Project Vault — a self-hosted secrets management platform — covering tenant isolation strategies, schema design, row-level security, cross-tenant access prevention, and scalability patterns'
user_name: 'Nestor'
date: '2026-04-09'
web_research_enabled: true
source_verification: true
---

# Research Report: Technical — Multi-Tenancy Data Model

**Date:** 2026-04-09
**Author:** Nestor
**Research Type:** Technical

---

## Technical Research Scope Confirmation

**Research Topic:** Multi-Tenancy Data Model  
**Research Goals:** Design the multi-tenancy data model architecture for Project Vault — a self-hosted secrets management platform — covering tenant isolation strategies, schema design, row-level security, cross-tenant access prevention, and scalability patterns

**Technical Research Scope:**

- Architecture Analysis — tenant isolation strategies, schema design patterns, row-level security
- Implementation Approaches — GORM multi-tenancy patterns, tenant context propagation, migration strategies
- Technology Stack — PostgreSQL RLS, GORM scopes and hooks, pgx driver patterns
- Integration Patterns — intersection with RBAC, machine tokens, encryption, audit log
- Performance Considerations — index strategy, connection pooling with tenant context, cardinality at scale

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** 2026-04-09

---

## Technology Stack Analysis

### Multi-Tenancy Isolation Strategies

Three fundamental isolation strategies exist for multi-tenant applications:

**Strategy 1: Shared Schema (Single Database, Shared Tables)**

All tenants share a single database and table set. Every tenant-owned table has an `org_id` (or `tenant_id`) column. Isolation is enforced at the application layer via query filters, and optionally hardened at the database layer via Row-Level Security (RLS).

- Pros: Operational simplicity (single DB, single migration), lowest resource overhead, cross-tenant analytics possible
- Cons: Application-layer bugs can cause data leakage; requires rigorous query discipline

_Confidence: High. This is the dominant strategy for SaaS platforms with 100–100,000 tenants at the scale of Project Vault._

**Strategy 2: Schema-per-Tenant (Single Database, Multiple Schemas)**

Each tenant gets their own PostgreSQL schema (namespace). The same table definitions exist in each schema. The `search_path` is switched at connection time to route queries to the correct schema.

- Pros: Strong logical isolation; per-tenant migrations theoretically simpler
- Cons: PostgreSQL schema switching via `SET search_path` carries security risks (search path hijacking); migration tooling (Atlas, golang-migrate) has limited multi-schema support; N×schema objects in `pg_catalog` with 1000+ tenants causes catalog bloat; poor fit for self-hosted single-node deployment

_Source: postgresql.org/docs/current/runtime-config-client.html — `search_path` GUC_  
_Confidence: High._

**Strategy 3: Database-per-Tenant**

Each tenant gets an entirely separate PostgreSQL database (or even a separate server). The application maintains a connection pool per tenant.

- Pros: Maximum isolation; independent backups; no cross-tenant leakage at any layer
- Cons: Extremely high operational overhead; impossible to manage at scale on a self-hosted single node; N connection pools; schema migrations multiplied by tenant count

_Confidence: High. Inappropriate for Project Vault's self-hosted, single-node primary deployment model._

### Recommended Strategy for Project Vault: Shared Schema + RLS Defense-in-Depth

Project Vault's architecture (single PostgreSQL instance, Go/GORM backend, self-hosted Docker-primary deployment) maps cleanly to the Shared Schema strategy. Row-Level Security is added as a defense-in-depth layer on the most sensitive tables.

### PostgreSQL Row-Level Security (RLS)

RLS is a PostgreSQL primitive that enforces per-row access control at the storage engine level. When enabled, every `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on a table automatically applies policy expressions — effectively injecting a `WHERE` clause that cannot be bypassed by application code.

```sql
-- Enable RLS on a table
ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;

-- Default-deny is applied automatically if no policy exists
-- Create a permissive policy for the application role
CREATE POLICY secrets_tenant_isolation ON secrets
    AS PERMISSIVE
    FOR ALL
    TO vault_app   -- the DB role used by the Go application
    USING (org_id = current_setting('app.current_org_id')::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id')::uuid);
```

**Policy evaluation:** The `USING` expression is evaluated for `SELECT`, `UPDATE`, and `DELETE`. The `WITH CHECK` expression is evaluated for `INSERT` and `UPDATE`. If no `WITH CHECK` is specified, `USING` serves double duty.

**Table owner bypass:** Table owners and superusers bypass RLS by default. This means the migration user (superuser) and application owner bypass policies — a critical consideration for the application role vs. migration role separation.

**`FORCE ROW LEVEL SECURITY`:** If the application role is the table owner, `ALTER TABLE ... FORCE ROW LEVEL SECURITY` makes RLS apply to the owner too.

_Source: postgresql.org/docs/current/ddl-rowsecurity.html — "When row security is enabled on a table, all normal access to the table for selecting rows or modifying rows must be allowed by a row security policy"_  
_Source: postgresql.org/docs/current/sql-createpolicy.html — CREATE POLICY syntax, PERMISSIVE/RESTRICTIVE, USING/WITH CHECK_

### Tenant Context Injection: `SET LOCAL` + `app.current_org_id`

The standard pattern for passing tenant context to RLS policies is the PostgreSQL application-level GUC (Grand Unified Configuration) variable. This is the same mechanism used by Supabase and is the only reliable way to communicate tenant context to RLS policies without using DB connection-per-tenant.

```sql
-- At the start of a DB transaction for org "abc123":
SELECT set_config('app.current_org_id', 'abc123-uuid', true);
-- The third argument (is_local=true) scopes the setting to the current transaction only
-- This is safer than session-level SET because it auto-resets on COMMIT/ROLLBACK
```

`set_config(setting_name, new_value, is_local)`:
- `is_local = true` → setting applies for current transaction only; reset on commit/rollback → safe for connection pooled environments
- `is_local = false` → setting applies for current session → unsafe with connection pooling (pool can return connection to different user)

**Critical for connection pooling (pgbouncer / pgx pool):** Always use `is_local=true`. With pgbouncer in transaction-pooling mode, sessions are recycled between transactions — a session-level GUC set for tenant A could be visible to tenant B's query if it runs on the same connection. `is_local=true` scopes the value to the transaction only.

_Source: postgresql.org/docs/current/functions-admin.html — `set_config(setting_name, new_value, is_local)` — "If is_local is true, the effect lasts only until the end of the current transaction"_  
_Source: supabase.com/docs/guides/database/postgres/row-level-security — production reference for `set_config` pattern in web applications_

### GORM: Scopes and Hooks for Multi-Tenancy

**GORM Scopes** allow reusable query modifiers. A tenant scope function injects `WHERE org_id = ?` on every query that uses it:

```go
func OrgScope(orgID string) func(db *gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        return db.Where("org_id = ?", orgID)
    }
}

// Usage
db.Scopes(OrgScope(orgID)).Find(&secrets)
```

_Source: gorm.io/docs/scopes.html — "Scopes allow you to re-use commonly used logic, the shared logic needs to be defined as type func(*gorm.DB) *gorm.DB"_

**GORM Callbacks (global)** can register a plugin or callback that automatically appends `org_id` to every query on multi-tenant tables:

```go
db.Callback().Query().Before("gorm:query").Register("tenant_scope", tenantScopeCallback)
```

This approach is powerful but fragile — a missed registration or a query bypassing the callback creates a data leak. The preferred Project Vault approach combines: (1) GORM scopes at service layer, (2) `org_id` columns on all tenant-owned tables, (3) PostgreSQL RLS as a defense-in-depth backstop.

_Source: gorm.io/docs/hooks.html — GORM hook lifecycle for BeforeCreate, BeforeQuery, etc._

### Technology Comparison Matrix

| Concern | Recommended | Alternative | Rationale |
|---------|-------------|-------------|-----------|
| Isolation strategy | Shared schema | Schema-per-tenant | Operational simplicity; self-hosted single node |
| RLS enforcement layer | PostgreSQL RLS | Application-only | Defense-in-depth; protects against app-layer bugs |
| Tenant context to DB | `set_config(..., true)` (transaction-local) | Session-level `SET` | Safe with connection pooling; auto-resets on tx end |
| Application-layer isolation | GORM scopes + `org_id` column | Global callbacks | Explicit, auditable; easy to verify in code review |
| Connection pooling | pgx built-in pool | pgbouncer | pgx pool works correctly with `set_config LOCAL`; simpler ops |

---

## Integration Patterns Analysis

### Tenant Context Propagation Through the Stack

The tenant context (`org_id`) must flow from the HTTP request through the service layer to every database query. This is done via Go's `context.Context`:

```
HTTP Request
  → Auth Middleware (validates JWT, extracts org_id from claims)
  → ctx = context.WithValue(ctx, orgIDKey, orgID)
  → Service Layer (calls DB with ctx)
  → DB Layer (reads org_id from ctx, calls set_config, runs GORM query with scope)
```

**Auth middleware** extracts the `org_id` from the validated JWT. The JWT claims (from the RBAC research) include the user's current org and their role. The org_id placed in context is the **validated** org from the token — never from URL parameters or user-supplied input alone.

**DB transaction wrapper** sets the tenant GUC at the start of every transaction:

```go
// internal/db/tenant.go

type contextKey string
const orgIDKey contextKey = "org_id"

func WithOrgID(ctx context.Context, orgID string) context.Context {
    return context.WithValue(ctx, orgIDKey, orgID)
}

func OrgIDFromCtx(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(orgIDKey).(string)
    return id, ok
}

// TenantTx wraps a GORM transaction with org_id context injection
func TenantTx(ctx context.Context, db *gorm.DB, fn func(tx *gorm.DB) error) error {
    orgID, ok := OrgIDFromCtx(ctx)
    if !ok {
        return errors.New("missing org_id in context")
    }
    return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
        // Set transaction-local GUC for RLS policies
        if err := tx.Exec("SELECT set_config('app.current_org_id', ?, true)", orgID).Error; err != nil {
            return err
        }
        // Run the caller's logic with scoped DB
        return fn(tx.Scopes(OrgScope(orgID)))
    })
}
```

### Integration with RBAC Architecture

The RBAC architecture (from RBAC research) already defines `org:{uuid}` and `project:{uuid}` domains for Casbin enforcement. The multi-tenancy data model aligns perfectly:

- **Org-level data** (e.g., `organizations` table) is owned by `org_id` — the Casbin org domain maps to `org_id` in the data model
- **Project-level data** (e.g., `secrets`, `environments`, `rotation_jobs`) is owned by both `org_id` and `project_id` — the Casbin project domain maps to `project_id`, but `org_id` on each row ensures cross-org isolation even if Casbin is bypassed
- **RBAC enforcement happens before the DB layer** — Casbin denies the request if the user lacks permissions. The `org_id` column + RLS policy acts as a second layer.

**Cross-project isolation within the same org:** A user who is `project_viewer` in Project A but `project_admin` in Project B within the same org must not read Project A's secrets via Project B's API path. This is enforced by: (1) `project_id` filter in all secret queries, (2) Casbin enforcing `project:{projectB_id}` domain permissions, (3) `project_id` on `secrets` table for RLS double-check.

### Integration with Secrets Encryption

From the cryptographic architecture, secrets are encrypted with envelope encryption (DEK per secret, KEK managed by KMS). The `encrypted_value` and `encrypted_dek` columns contain ciphertext only — even a cross-tenant data leak would reveal only ciphertext, not plaintext. However, Project Vault's design must not rely on encryption as the isolation mechanism — RLS and application-layer filters are the primary isolation guarantees.

**Per-org KMS key (optional v1.5+):** Each org can optionally have a dedicated KEK, stored in `kms_keys` table scoped to `org_id`. This provides cryptographic tenant isolation in addition to access control isolation.

### Integration with Audit Log

The `audit_events` table (from RBAC research) is inherently multi-tenant: every event has `org_id` and `project_id`. RLS should be applied to the audit log table too — a `project_viewer` in Org A must not read audit events from Org B. The audit log also serves as a cross-tenant breach detection system: alert on queries that `org_id` columns don't match the JWT's claimed org.

### Integration with Machine Tokens

Machine tokens (from Machine Auth research) have project-scoped roles. The `machine_tokens` table and `machine_sessions` table must also carry `org_id` to prevent a machine token in one org from being used by a maliciously crafted request claiming a different org. Token validation middleware extracts `org_id` from the token record (not from the request), making it unforgeable.

### Connection Pool Tenant Context Pattern

pgx's built-in connection pool (`pgxpool`) supports `BeforeAcquire` and `AfterRelease` hooks. These are the right place to set and clear session-level GUC variables — but **only if** using session-pooling. For transaction-pooling (the more scalable option), the `SET LOCAL` inside the transaction is the correct approach:

```go
// With pgxpool + transaction-pooling: set_config inside transaction (preferred)
pool.BeginTx(ctx, pgx.TxOptions{})  // → runs set_config inside fn
```

_Source: gorm.io/docs/connecting_to_the_database.html — "We are using pgx as postgres's database/sql driver"_

---

## Architectural Patterns and Design

### Entity Hierarchy

```
Organization (tenant root)
├── id (UUID, PK)
├── name
├── slug (unique)
├── plan (free|pro|enterprise) -- for SaaS hosted tier; ignored for self-hosted
├── created_at, updated_at, deleted_at

Project (sub-tenant scope)
├── id (UUID, PK)
├── org_id (FK → organizations, NOT NULL)
├── name
├── slug (unique within org)

Environment (within project)
├── id (UUID, PK)
├── project_id (FK → projects, NOT NULL)
├── org_id (FK → organizations, NOT NULL)  ← denormalized for RLS + fast queries
├── name (e.g., "production", "staging")

Secret (leaf, most sensitive)
├── id (UUID, PK)
├── project_id (FK → projects, NOT NULL)
├── org_id (FK → organizations, NOT NULL)  ← denormalized for RLS
├── environment_id (FK → environments, NOT NULL)
├── path, key
├── encrypted_value, encrypted_dek
```

**`org_id` denormalization:** The `org_id` column is intentionally denormalized onto every tenant-owned table (secrets, environments, role_assignments, machine_tokens, audit_events, rotation_jobs, etc.) rather than requiring a JOIN to the parent table to determine org ownership. This serves three purposes:
1. Enables efficient RLS policies (`org_id = current_setting(...)::uuid`) without JOINs in the policy expression
2. Enables a composite index `(org_id, ...)` on every table for fast tenant-scoped queries
3. Acts as a double-check: even if `project_id` is manipulated, `org_id` must match the JWT's org

**Enforcement of `org_id` consistency:** A PostgreSQL `CHECK` constraint or trigger validates that `org_id` on a `secrets` row matches the `org_id` of the parent `project`. This prevents a malicious INSERT that sets `project_id` from Org A but `org_id` from Org B.

### Full Database Schema

```sql
-- ============================================================
-- CORE TENANT HIERARCHY
-- ============================================================

CREATE TABLE organizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    plan        TEXT NOT NULL DEFAULT 'self-hosted',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ     -- soft delete
);

CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_active ON organizations(id) WHERE deleted_at IS NULL;

-- ============================================================
-- PROJECT
-- ============================================================

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

CREATE INDEX idx_projects_org ON projects(org_id);
CREATE INDEX idx_projects_org_active ON projects(org_id) WHERE deleted_at IS NULL;

-- ============================================================
-- ENVIRONMENT
-- ============================================================

CREATE TABLE environments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id      UUID NOT NULL REFERENCES organizations(id),  -- denormalized
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,  -- display order
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, name),
    -- Consistency constraint: environment's org must match project's org
    CONSTRAINT fk_env_project_org FOREIGN KEY (project_id, org_id)
        REFERENCES projects(id, org_id) DEFERRABLE INITIALLY DEFERRED
);
-- Note: requires (id, org_id) UNIQUE on projects for the composite FK to work:
ALTER TABLE projects ADD UNIQUE (id, org_id);

CREATE INDEX idx_environments_project ON environments(project_id);
CREATE INDEX idx_environments_org     ON environments(org_id);

-- ============================================================
-- SECRET
-- ============================================================

CREATE TABLE secrets (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    org_id            UUID NOT NULL REFERENCES organizations(id),  -- denormalized
    environment_id    UUID NOT NULL REFERENCES environments(id),
    path              TEXT NOT NULL,          -- e.g. "/myapp"
    key               TEXT NOT NULL,          -- e.g. "DATABASE_URL"
    encrypted_value   BYTEA NOT NULL,         -- AES-256-GCM ciphertext
    encrypted_dek     BYTEA NOT NULL,         -- envelope-encrypted DEK
    version           INTEGER NOT NULL DEFAULT 1,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    comment           TEXT,
    created_by        UUID,                   -- user_id or machine_token_id
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ,
    UNIQUE (project_id, environment_id, path, key) WHERE deleted_at IS NULL,
    CONSTRAINT fk_secret_env_org FOREIGN KEY (environment_id, org_id)
        REFERENCES environments(id, org_id) DEFERRABLE INITIALLY DEFERRED
);
-- Add (id, org_id) unique for reference by other tables:
ALTER TABLE environments ADD UNIQUE (id, org_id);

CREATE INDEX idx_secrets_project       ON secrets(project_id);
CREATE INDEX idx_secrets_org           ON secrets(org_id);
CREATE INDEX idx_secrets_env           ON secrets(environment_id);
CREATE INDEX idx_secrets_lookup        ON secrets(project_id, environment_id, path, key)
    WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX idx_secrets_org_active    ON secrets(org_id, project_id)
    WHERE deleted_at IS NULL AND is_active = true;

-- ============================================================
-- ROW-LEVEL SECURITY
-- ============================================================

-- Separate DB roles:
--   vault_migrate : superuser for migrations (bypasses RLS by default)
--   vault_app     : application role (subject to RLS)
--   vault_ro      : read-only audit queries

-- Enable RLS on all tenant-scoped tables
ALTER TABLE projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE environments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets        ENABLE ROW LEVEL SECURITY;

-- FORCE RLS if vault_app is also table owner
ALTER TABLE projects       FORCE ROW LEVEL SECURITY;
ALTER TABLE environments   FORCE ROW LEVEL SECURITY;
ALTER TABLE secrets        FORCE ROW LEVEL SECURITY;

-- RLS Policies (vault_app role reads org_id from transaction-local GUC)
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

-- Bypass policy for vault_migrate (no-op: superuser already bypasses)
-- Bypass for vault_ro (read-only analytics):
CREATE POLICY projects_ro_bypass ON projects
    AS PERMISSIVE FOR SELECT TO vault_ro USING (true);
CREATE POLICY environments_ro_bypass ON environments
    AS PERMISSIVE FOR SELECT TO vault_ro USING (true);
CREATE POLICY secrets_ro_bypass ON secrets
    AS PERMISSIVE FOR SELECT TO vault_ro USING (true);
```

**`current_setting('app.current_org_id', true)`:** The second argument `true` (missing_ok) prevents an error when the GUC is not set (e.g., during migrations run by superuser) — returns `NULL` instead, which causes the USING clause to return false, implicitly denying access for unset contexts. This is the safe default.

_Source: postgresql.org/docs/current/sql-createpolicy.html — "Rows for which the expression returns false or null will not be visible"_

### GORM Model Definitions

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
    Org       Organization   `gorm:"foreignKey:OrgID"`
    Name      string         `gorm:"not null"`
    Slug      string         `gorm:"not null"`
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt gorm.DeletedAt `gorm:"index"`
}

type Environment struct {
    ID        uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
    ProjectID uuid.UUID `gorm:"type:uuid;not null;index"`
    OrgID     uuid.UUID `gorm:"type:uuid;not null;index"`    // denormalized
    Name      string    `gorm:"not null"`
    Position  int       `gorm:"not null;default:0"`
    CreatedAt time.Time
    UpdatedAt time.Time
}

type Secret struct {
    ID              uuid.UUID      `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
    ProjectID       uuid.UUID      `gorm:"type:uuid;not null;index"`
    OrgID           uuid.UUID      `gorm:"type:uuid;not null;index"`       // denormalized
    EnvironmentID   uuid.UUID      `gorm:"type:uuid;not null;index"`
    Path            string         `gorm:"not null"`
    Key             string         `gorm:"not null"`
    EncryptedValue  []byte         `gorm:"not null"`
    EncryptedDEK    []byte         `gorm:"not null"`
    Version         int            `gorm:"not null;default:1"`
    IsActive        bool           `gorm:"not null;default:true"`
    CreatedBy       *uuid.UUID     `gorm:"type:uuid"`
    CreatedAt       time.Time
    UpdatedAt       time.Time
    DeletedAt       gorm.DeletedAt `gorm:"index"`
}
```

### Tenant Scope Helper

```go
// internal/db/tenant.go

// OrgScope is the standard GORM scope for tenant-scoped queries.
// Every query on a multi-tenant table must use this scope.
func OrgScope(orgID uuid.UUID) func(*gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        return db.Where("org_id = ?", orgID)
    }
}

// ProjectScope scopes a query to both org and project.
func ProjectScope(orgID, projectID uuid.UUID) func(*gorm.DB) *gorm.DB {
    return func(db *gorm.DB) *gorm.DB {
        return db.Where("org_id = ? AND project_id = ?", orgID, projectID)
    }
}

// TenantTx runs fn inside a transaction with the org_id GUC set for RLS.
func TenantTx(ctx context.Context, db *gorm.DB, orgID uuid.UUID, fn func(tx *gorm.DB) error) error {
    return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
        // Transaction-local GUC: resets automatically on COMMIT/ROLLBACK
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

**Usage at service layer:**

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

### Cross-Tenant Leakage Prevention Checklist

| Risk vector | Prevention |
|------------|-----------|
| URL parameter manipulation (`/api/v1/orgs/{orgID}/...`) | orgID in URL validated against JWT-claimed orgID in auth middleware; mismatch → 403 |
| projectID belonging to a different org | `ProjectScope(orgID, projectID)` — query must match BOTH; missing row result treated as 404 |
| GORM Scopes forgotten at call site | Code review checklist; integration test per endpoint with cross-tenant assertion; RLS as backstop |
| RLS GUC not set (forgotten `TenantTx`) | `current_setting(..., true)` returns NULL → RLS USING returns false → query returns 0 rows (no error, just empty — equivalent to 404, not data leak) |
| DB migration runs as vault_app (hits RLS) | Migrations run as `vault_migrate` (superuser) which bypasses RLS |
| Admin CLI / backup tool | Uses `vault_migrate` role; `row_security = off` set explicitly for pg_dump |
| Audit log cross-tenant read | `audit_events` table also has `org_id` column + RLS policy |
| Machine token used across orgs | Token validation extracts `org_id` from DB record (not request); `machine_tokens.org_id` column enforced |

### Secret Version History

To support secret versioning without unbounded table growth:

```sql
CREATE TABLE secret_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    secret_id       UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    org_id          UUID NOT NULL REFERENCES organizations(id),  -- denormalized for RLS
    version         INTEGER NOT NULL,
    encrypted_value BYTEA NOT NULL,
    encrypted_dek   BYTEA NOT NULL,
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (secret_id, version)
);

ALTER TABLE secret_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY secret_versions_tenant_isolation ON secret_versions
    AS PERMISSIVE FOR ALL TO vault_app
    USING     (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE INDEX idx_secret_versions_secret ON secret_versions(secret_id, version DESC);
CREATE INDEX idx_secret_versions_org    ON secret_versions(org_id);
```

---

## Implementation Approaches and Technology Adoption

### Phase 1 — Foundation (v1.0)

**Deliverables:**
- `organizations` and `projects` tables with soft delete
- `environments` table with display ordering
- `secrets` table with envelope encryption columns, `org_id` denormalization, composite unique constraint
- `secret_versions` table for version history
- PostgreSQL RLS policies on all tenant-scoped tables
- Three DB roles: `vault_migrate` (superuser), `vault_app` (RLS-bound), `vault_ro` (read-only)
- `TenantTx` / `OrgScope` / `ProjectScope` helpers in `internal/db/tenant.go`
- Validation that `org_id` on `project_id` matches URL-derived org in auth middleware
- Cross-tenant integration tests: create secret in Org A; assert Org B cannot read it, even with correct `project_id`

**Go module layout:**
```
internal/
    db/
        tenant.go           # OrgScope, ProjectScope, TenantTx
        models/
            organization.go # Organization GORM model
            project.go      # Project GORM model
            environment.go  # Environment GORM model
            secret.go       # Secret + SecretVersion GORM models
    migrations/
        001_create_organizations.sql
        002_create_projects.sql
        003_create_environments.sql
        004_create_secrets.sql
        005_rls_policies.sql
        006_db_roles.sql
```

### Phase 2 — Hardening (v1.1)

- Consistency check trigger: validate `environments.org_id` matches `projects.org_id` on INSERT/UPDATE
- Audit log (`audit_events`) with `org_id` column + RLS policy (from RBAC research, Phase 3)
- Per-org KMS key support (`kms_keys` table with `org_id`)
- Background job to verify RLS policies are enabled on all tenant tables (schema health check)
- `vault_ro` role used for compliance audit queries

### Phase 3 — Advanced Isolation (v1.5+)

- PostgreSQL schema-per-org option for regulated deployments (opt-in, operator-configured)
- Database-per-org for air-gapped enterprise deployments (separate operator tooling)
- Logical replication per-org for backup isolation
- Cross-org admin tooling for self-hosted super-admin operations (authenticated separately, not via `vault_app`)

### Test Strategy

| Test Category | Coverage |
|---|---|
| RLS unit tests | Direct SQL: connect as `vault_app`, set GUC to Org A, verify Org B rows invisible; verify INSERT with wrong org rejected |
| Application-layer isolation | API: create secret in Org A project; authenticate as Org B user; call GET endpoint → expect 404 (not 403, not data) |
| `TenantTx` GUC scope | Verify `current_setting('app.current_org_id', true)` is NULL after transaction commits (connection recycling test) |
| `org_id` consistency | INSERT environment with `org_id` mismatching parent project's `org_id` → FK constraint violation |
| Missing scope regression | Service function without `OrgScope` → verify RLS blocks cross-tenant data |
| Migration role bypass | Run migration as `vault_migrate` → verify rows from all orgs visible (expected for migration) |
| Concurrent tenant transactions | Two goroutines: Org A and Org B transactions simultaneously; verify no GUC contamination between connections |
| Secret versioning | Create 5 versions; fetch by version number; verify version history scoped to org |

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Developer forgets `OrgScope` on a query | High | RLS provides backstop; code review requirement; integration test per endpoint |
| `set_config` called with `is_local=false` in pooled environment | High | Linter rule; code review; always use `TenantTx` wrapper (never call `set_config` directly) |
| `org_id` mismatch between secret and parent project | High | Deferred FK consistency constraint on `(project_id, org_id)` pair |
| RLS policy accidentally disabled during migration | Medium | Schema health check CI job; `pg_policies` catalog query in health check endpoint |
| Superuser connection used by application accidentally | High | `vault_app` role has no superuser privilege; connection string validation on startup |
| Cross-tenant data in exported backup (pg_dump) | Medium | `row_security = off` required explicitly for pg_dump; migration role used; audit log tracks dump events |
| GUC value visible in `pg_stat_activity` | Low | `app.current_org_id` is a plain GUC string; visible to superusers in `pg_stat_activity.application_name` — use short hash if sensitive; org UUID is already public-knowledge within the request |

---

## Research Conclusion

### Summary of Key Technical Findings Across All Research Areas

**Technology Stack (Step 2):** Project Vault should use Shared Schema multi-tenancy (single PostgreSQL database, `org_id` column on all tenant-owned tables) as the primary isolation strategy. This is the right fit for a self-hosted, single-node, Docker-primary deployment. PostgreSQL RLS provides defense-in-depth on top of application-layer `org_id` filtering. The key primitive is `set_config('app.current_org_id', orgID, true)` — transaction-local GUC injection — combined with RLS policies that read `current_setting('app.current_org_id', true)`. Schema-per-tenant and DB-per-tenant are inappropriate for Project Vault's architecture at this stage.

**Integration Patterns (Step 3):** Tenant context (`org_id`) flows from JWT claims → `context.Context` → `TenantTx` wrapper → `set_config` + GORM `OrgScope`. Four key integration points: (1) RBAC — Casbin domain `org:{uuid}` maps directly to `org_id` column; (2) Encryption — `org_id` denormalization on `secrets` enables RLS without JOINs, and enables per-org KEK in v1.5+; (3) Audit log — `audit_events.org_id` + RLS ensures audit isolation; (4) Machine tokens — `machine_tokens.org_id` column enforces token scope unforgeable from the request.

**Architectural Patterns (Step 4):** `org_id` is denormalized onto every tenant-scoped table (projects, environments, secrets, secret_versions, role_assignments, machine_tokens, audit_events, rotation_jobs) — no JOINs needed in RLS policy expressions, and composite indexes `(org_id, ...)` serve as leading columns for all tenant-scoped queries. Deferred FK constraint `(project_id, org_id)` prevents cross-org `org_id`/`project_id` mismatches at write time. Three DB roles: `vault_migrate` (superuser, bypasses RLS for schema changes), `vault_app` (application role, bound by RLS), `vault_ro` (read-only, for audit/compliance queries, explicit bypass policy for admin reports).

**Implementation Strategy (Step 5):** Phase 1 (v1.0) delivers the full schema with RLS policies, `TenantTx` helper, and `OrgScope`/`ProjectScope` GORM scopes. Tests cover: RLS unit (direct SQL), API-level cross-tenant assertion, GUC scoping correctness, concurrent transaction isolation. Phase 2 (v1.1) adds consistency triggers, per-org KMS key table, and RLS health check. Phase 3 (v1.5+) adds optional schema-per-org for regulated enterprise deployments.

---

### Strategic Impact Assessment

Multi-tenancy data isolation is a foundational security requirement for Project Vault. A single cross-tenant data leak — even of ciphertext — would be a critical security incident for a secrets management product. The defense-in-depth architecture (application-layer `org_id` filter + GORM scope + PostgreSQL RLS) provides three independent layers of isolation. Any single layer failing does not result in data exposure; all three would need to fail simultaneously for a cross-tenant leak to occur.

The chosen architecture is intentionally aligned with production multi-tenant PostgreSQL deployments (Supabase, Infisical) that have validated this pattern at scale, while remaining operationally simple for Project Vault's self-hosted, single-node deployment target.

---

### Open ADRs

| ADR | Decision needed | Recommendation |
|-----|----------------|----------------|
| ADR-16 | Tenant isolation strategy tier — formally record Shared Schema as v1 strategy and schema-per-tenant as v1.5+ opt-in | Shared Schema for all self-hosted deployments; schema-per-tenant is opt-in only for regulated enterprise use cases |
| ADR-17 | `org_id` denormalization scope — should `org_id` be on all tables or only those with RLS? | All tenant-owned tables — RLS is applied to all of them; the overhead of one extra UUID column is negligible |
| ADR-18 | RLS bypass for reporting/analytics — `vault_ro` role with explicit bypass vs. separate analytics DB | `vault_ro` with explicit `USING (true)` SELECT-only policies for admin audit queries; no separate analytics DB until scale justifies it |

---

### Next Steps

1. **ADR-16:** Tenant isolation strategy — record Shared Schema decision and schema-per-tenant deferral conditions
2. **ADR-17:** `org_id` denormalization policy — record all-tables rule
3. **ADR-18:** Reporting bypass strategy — record `vault_ro` approach
4. **Sprint execution:** Phase 1 schema migrations + `TenantTx` helper + cross-tenant integration test suite
5. **Spec creation:** Create `specs/multi-tenancy-data-model.md` from this research as operational reference

---

**Research Completion Date:** 2026-04-09  
**Research Period:** Comprehensive current-state analysis (Steps 1–6 complete)  
**Document Scope:** Multi-Tenancy Data Model for Project Vault v1  
**Source Verification:** All findings cited against live documentation (postgresql.org RLS docs, postgresql.org CREATE POLICY, postgresql.org set_config, supabase.com RLS guide, gorm.io scopes, gorm.io hooks, gorm.io connecting to database)  
**Confidence Level:** High — based on multiple authoritative sources and production reference implementations (Supabase, Infisical)

_This research document serves as the authoritative technical reference for multi-tenancy data model decisions in Project Vault._

---

## Addendum: Federated Cell-Based Architecture Analysis (2026-04-09)

**Trigger:** User proposed an alternative architecture — DB-per-tenant with a central auth+routing control plane and multiple application servers (cells) hosting different tenants. Three parallel expert analyses were commissioned to evaluate this architecture rigorously.

**Expert analyses on file:**
- `design-artifacts/central-auth-tenant-routing-analysis.md` — Auth/identity architecture (968 lines)
- `design-artifacts/cell-based-architecture-analysis.md` — Cell-based deployment patterns (1,008 lines)
- `docs/federated-multi-tenant-architecture-analysis.md` — Infrastructure/operations analysis (1,498 lines)

---

### A.1 Architecture Description (Proposed)

```
┌─────────────────────────────────────────────────────────────┐
│                  CONTROL PLANE (central)                     │
│  Auth Service (JWT) │ Tenant Router │ Provisioning API       │
│                     └──────── Control Plane DB ─────────────┘
└──────────────────────────────────────────────────────────────┘
         │                    │                   │
         ▼                    ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  App Server A    │ │  App Server B    │ │  App Server C    │
│  (LXC 101)       │ │  (LXC 102)       │ │  (VIP dedicated) │
│  vault_acme DB   │ │  vault_beta DB   │ │  vault_corp DB   │
│  vault_foo DB    │ │  vault_gamma DB  │ │                  │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

**Core properties:**
- Central control plane owns auth, routing table, provisioning state — never secret data
- Each app server owns N tenant databases (DB-per-tenant)
- Central auth issues JWTs with `vault.app_server` routing hint; clients route directly to their app server
- New app servers are added on demand; tenants can be migrated between servers

---

### A.2 Consensus Verdict Across All Three Experts

All three expert analyses reached the same conclusion independently:

| Use case | Right choice |
|---|---|
| Self-hosted, 1–2 orgs (the common case) | **Current shared schema + RLS — do not change** |
| SaaS, <50 customers | **Isolated Docker instances, script-provisioned** (simpler than full federation) |
| SaaS, 50+ customers or isolation contracts | **Full federation (cell-based)** |
| Enterprise VIP tenant, dedicated hardware | **Full federation, Pattern C (1 tenant per cell)** |

**ADR-16 (shared schema for v1) is confirmed correct.** The federated architecture is a v2 SaaS feature, not a v1 change.

---

### A.3 Central Auth Architecture (Expert 1 Findings)

The proposed auth pattern is sound and is used at production scale by Atlassian, Notion, and Linear. The recommended implementation is a **minimal OIDC-inspired Authorization Server** (not full Keycloak complexity):

**JWT structure:**
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
    "auth_method": "password",
    "amr":         ["pwd", "totp"],
    "acr":         "2"
  },
  "roles": {
    "org:org_01HABC...": "org_member",
    "project:proj_01HDEF...": "project_owner"
  }
}
```

**Key design decisions:**
- `vault.app_server` is **informational only** — app server validates `org_id` against its own tenant registry, not the routing hint
- App servers validate JWTs **locally** via a cached JWKS endpoint — zero request-time coupling to central auth
- Refresh tokens are **opaque, central-auth-only** — app servers never see refresh tokens; expired access tokens trigger a redirect to central auth
- `vault.shard_id` is a label not a URL — enables shard rerouting without re-issuing all tokens

**Session lifecycle (simplified):**
```
Login:     Client → Central Auth → {access_token, refresh_token, server_url}
           Client → App Server (direct, using server_url)

Expiry:    App Server → 401 + X-Vault-Auth-Endpoint header
           Client → Central Auth /token/refresh → {new access_token, possibly new server_url}
           Client → App Server (retry with new token)

Migration: After tenant moves from Server A → B, next token refresh returns new server_url.
           Client transparently updates its stored server_url. Zero manual config change.
```

**Machine tokens:** Exchange with central auth via a direct API call (no browser redirect). The response includes `server_url`. The `VAULT_SERVER_URL` env var override bypasses routing entirely for air-gapped/CI deployments. Fully compatible with the existing machine auth spec.

**Critical security findings:**

| Risk | Mitigation |
|---|---|
| Open redirect: attacker supplies malicious `server_url` | `server_url` comes from DB only, validated against a server-side allowlist. Never from user input. |
| Cross-server token replay | App server rejects JWT whose `org_id` is not in its own tenant registry |
| Token binding hardening | Add target server URL to `aud` claim — makes cross-server replay cryptographically impossible |
| Central auth SPOF for new logins | In-flight sessions survive (local JWT validation). Only new logins and refreshes are blocked. HA pair required for production. |

**Recommended Go libraries:** `golang-jwt/jwt` for signing/validation; `lestrrat-go/jwx` for JWKS key management; `zitadel/oidc` if full OIDC compliance is ever required.

---

### A.4 Cell-Based Architecture Patterns (Expert 2 Findings)

**Cell-based architecture is a deployment pattern, not a data model pattern.** Each "cell" is a self-contained unit: its own app server + its own PostgreSQL instance(s). Cells share nothing.

**Industry precedent:**
- **Notion**: flat `workspace_id → shard → RDS instance` routing table. New workspaces placed on shards with capacity. Large workspaces promoted to dedicated shards (Pattern C).
- **Slack**: workspace-to-cell lookup table. Cell size capped; new tenants go to new cells when limit reached. Hard blast-radius isolation.
- **GitHub Enterprise Server**: one cell per enterprise customer — most extreme form.

**Three cell tiers for Project Vault:**
```
Tier 0 (Standard):    Shared schema on one server — current v1 architecture
Tier 1 (Growth):      25–100 tenants per cell — shared DB-per-tenant on one server
Tier 2 (Enterprise):  1 tenant per cell — dedicated server, dedicated PG instance
```

**The connection pool math problem** (most underestimated cost):
```
50 tenants × 5 min_connections = 250 open PG connections at idle
PostgreSQL default max_connections = 100  → immediately broken

Fix: PgBouncer in transaction-mode per cell
  vault-api → PgBouncer → postgres
  Cost: 1 PgBouncer container per cell, ~50MB RAM
  Note: transaction-mode is compatible with Project Vault's set_config(..., true) pattern
```

**Go: PoolRegistry for DB-per-tenant on a cell**
```go
type PoolRegistry struct {
    mu    sync.RWMutex
    pools map[uuid.UUID]*pgxpool.Pool  // tenantID → pool
    reaper *time.Ticker                // close idle pools after TTL
}

func (r *PoolRegistry) Get(ctx context.Context, tenantID uuid.UUID) (*pgxpool.Pool, error) {
    r.mu.RLock()
    if pool, ok := r.pools[tenantID]; ok {
        r.mu.RUnlock()
        return pool, nil
    }
    r.mu.RUnlock()
    // cache miss: look up DSN, create pool
    return r.create(ctx, tenantID)
}
```

**Migration complexity — the expand/contract pattern is mandatory:**
```
Without expand/contract: you can end up with two schema versions simultaneously in production.
With 100 tenant DBs: one failed migration leaves you with 99 at v2, 1 at v1 — both served by the same app.

The rule: every schema change requires 2 deploys:
  1. Deploy backward-compatible schema change (expand)
  2. Run async migration worker against all tenant DBs (tracked in control plane)
  3. Deploy new code that uses the new column (contract)
```

**Shared-schema vs. DB-per-tenant crossover:**
- **< 50 tenants:** shared schema wins on every operational metric
- **50+ tenants with isolation contracts:** DB-per-tenant wins
- **GDPR erasure:** DB-per-tenant is cleaner (`DROP DATABASE` vs. scrubbing millions of rows)

---

### A.5 Infrastructure and Operations (Expert 3 Findings)

**Honest operational overhead: 4–6× more than shared schema in Year 1.**

**Control plane database schema (7 tables):**
```sql
CREATE TABLE servers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT NOT NULL UNIQUE,           -- "app-01", "vip-01"
    region         TEXT NOT NULL,
    tier           TEXT NOT NULL DEFAULT 'standard',
    internal_url   TEXT NOT NULL,                  -- mTLS-protected internal API
    public_url     TEXT NOT NULL,                  -- Traefik backend URL
    max_tenants    INTEGER NOT NULL DEFAULT 100,
    current_tenants INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'active', -- "active" | "draining" | "offline"
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tenants (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug           TEXT NOT NULL UNIQUE,
    plan           TEXT NOT NULL DEFAULT 'standard',
    server_id      UUID NOT NULL REFERENCES servers(id),
    state          TEXT NOT NULL DEFAULT 'provisioning',
    dsn_ref        TEXT,       -- opaque DB name reference (not credentials)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at     TIMESTAMPTZ
);

CREATE TABLE routing_rules (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL UNIQUE REFERENCES tenants(id),
    server_id      UUID NOT NULL REFERENCES servers(id),
    subdomain      TEXT NOT NULL UNIQUE,           -- "acme.vault.example.com"
    state          TEXT NOT NULL DEFAULT 'active', -- "active" | "draining" | "readonly" | "migrating"
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Traefik polls this table every 5s via /api/v1/traefik-config

CREATE TABLE provisioning_events (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    event_type     TEXT NOT NULL,  -- "provision_started", "db_created", "migrated", "activated"
    payload        JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tenant_migrations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    source_server  UUID NOT NULL REFERENCES servers(id),
    target_server  UUID NOT NULL REFERENCES servers(id),
    state          TEXT NOT NULL DEFAULT 'preparing',
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at   TIMESTAMPTZ
);
```

**Tenant migration strategies:**

| Strategy | Downtime | Use case |
|---|---|---|
| pg_dump/restore | 1–5 min | Capacity rebalancing, server decommission |
| Logical replication + cutover | < 5 sec | Live migration, tenant relocation |

Migration state machine:
```
PREPARING → DRAINING → READONLY (downtime starts) → DUMPING → RESTORING → CUTOVER → VERIFYING → DONE
                                                                                          ↓ (failure)
                                                                                      ROLLBACK
```

**Traefik HTTP provider (dynamic per-tenant routing without static config):**
```yaml
# traefik.yml
providers:
  http:
    endpoint: "http://control-plane:8080/api/v1/traefik-config"
    pollInterval: "5s"
```

```go
// Control plane serves Traefik dynamic config
func (h *TraefikConfigHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    rules, _ := h.db.GetActiveRoutingRules(r.Context())
    config := buildTraefikConfig(rules)  // generates router+service per tenant subdomain
    json.NewEncoder(w).Encode(config)
}
```

**Proxmox migration path (from current single LXC):**
```
Phase 0 (now):        LXC 108 — everything (Traefik + vault-api + PostgreSQL)
Phase 1 (extract):    LXC 100 — control plane + Traefik
                      LXC 108 — existing vault-api + PG (now "Server 01")
Phase 2 (expand):     LXC 101 — new app server (Server 02) with PgBouncer + vault-api
                      New tenants provisioned on LXC 101
Phase 3 (VIP):        LXC 102 — dedicated server for VIP tenant
Engineering time: ~4–8h. Downtime: ~15 min for Phase 1 extraction.
```

**Why connection pooling math is the non-obvious killer:**
```
100 tenant DBs × 5 min_connections = 500 connections minimum
PostgreSQL default max_connections = 100  →  instantly exceeds limit
Even with max_connections = 1000:  1000 × 10MB/connection = 10GB RAM just for PG backends

Mandatory: PgBouncer in transaction mode per cell
Compatible with: set_config(..., true)  ← Project Vault already uses this
Incompatible with: session-level SET, LISTEN/NOTIFY, unpooled prepared statements
```

**Schema migrations across N tenant DBs:**
```
Problem: One failed migration on tenant #81 of 100 leaves you with 2 schema versions simultaneously.

Required: Parallel migration worker with per-tenant version tracking in control plane DB
  - Track: tenant_id, schema_version, last_migration_at, migration_state
  - Run 5-10 tenant DBs concurrently (semaphore-limited)
  - Record failures; retry with backoff; alert after threshold
  - API-version-gate to handle old+new schemas during rolling window
```

---

### A.6 Synthesis: Three-Tier Isolation Model

The correct architecture for Project Vault is not a binary choice — it is a **three-tier progression** triggered by concrete business events:

```
TIER 0 — SHARED SCHEMA (v1, current)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Target: Self-hosted deployments, small SaaS (<50 tenants)
Isolation: GORM OrgScope + PostgreSQL RLS
Database: Single PostgreSQL instance, shared tables, org_id on all rows
Operational overhead: Low (1 database, 1 migration run, 1 connection pool)
When to stay here: Until you have isolation contracts or 50+ enterprise tenants

TIER 1 — CELL-BASED WITH SHARED CELLS (v2 SaaS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Target: SaaS with 50–500 tenants, some needing logical isolation
Isolation: DB-per-tenant per cell; central auth + routing
Database: N cells, each with 25-100 tenant DBs; PgBouncer per cell
Operational overhead: High (N databases, parallel migration worker, connection pool registry)
Trigger: Regulatory isolation requirement OR 50th enterprise customer

TIER 2 — DEDICATED CELLS (enterprise isolation)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Target: VIP/enterprise tenants requiring physical isolation
Isolation: 1 tenant per cell, dedicated server hardware
Database: 1 PostgreSQL instance, 1 database, dedicated server
Operational overhead: Highest; justified by revenue/contract requirements
Trigger: Explicit enterprise isolation contract or customer request
```

**The current `org_id` denormalization on every table is exactly the right foundation for future cell extraction.** When Tier 1 is built, each tenant's rows are moved to their own DB with zero schema changes — the `org_id` column simply becomes redundant (still harmless).

---

### A.7 Updated ADRs

| ADR | Decision | Rationale |
|---|---|---|
| ADR-16 (updated) | Shared Schema for Tier 0 (self-hosted + small SaaS). Cell-based for Tier 1/2 when triggered. | Validated by 3 independent expert analyses. Operational overhead is 4–6× before business trigger justifies it. |
| ADR-19 (new) | When federation is built, use Pattern A (lookup table routing, not hash-ring). Central auth issues RS256 JWTs with `vault.app_server` routing hint. App servers validate locally via JWKS. | Lookup table gives operational flexibility for tenant migration. Hash-ring makes migration complex. JWKS-based local validation eliminates central auth as a per-request dependency. |
| ADR-20 (new) | Machine tokens bypass browser auth redirect; exchange directly with central auth for a JWT + `server_url`. `VAULT_SERVER_URL` env var overrides routing for air-gapped/CI deployments. | Machine users cannot handle HTTP redirects. Air-gapped deployments must not require central auth connectivity. |
| ADR-21 (new) | Per-cell PgBouncer in transaction mode is mandatory when a cell hosts >10 tenant DBs. Connection pool registry (`PoolRegistry`) with idle pool reaper manages per-tenant pgxpool instances on the app server. | Connection math: 50 tenants × 5 min_connections exceeds PG default max_connections immediately. Transaction-mode PgBouncer is compatible with the existing `set_config(..., true)` pattern. |

---

**Addendum completion date:** 2026-04-09  
**Expert analyses authored by:** 3 parallel agent analysis sessions  
**Confidence level:** High — all three analyses reached the same verdict independently
