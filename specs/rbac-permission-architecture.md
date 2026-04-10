# RBAC / Permission Architecture — Project Vault

**Version:** 1.0  
**Date:** 2026-04-09  
**Status:** Research-complete; pending ADR sign-off on three open decisions (ADR-04, ADR-05, ADR-06)  
**Source:** Technical research document `_bmad-output/planning-artifacts/research/technical-rbac-permission-architecture-research-2026-04-09.md`

---

## Overview

Project Vault uses **Casbin v2 with RBAC-with-Domains** (`g = _, _, _` three-field role definition) as its authorization engine. Org and Project scopes are fully independent authorization domains — Org Admin has zero implicit project permissions. The permission resolution pipeline is: JWT claims (fast path, zero I/O) → Casbin enforce (~0.164ms) → Additional Privileges DB lookup → async audit emit. Machine tokens use `mvt_` prefix with HMAC-SHA256 storage and flow through the same Casbin enforcer as human users.

---

## Authorization Scopes

Two fully independent scopes — no automatic permission bleed between them:

```
Organization Scope ("org:{uuid}")
├── org_admin  → manage org members, create/delete projects, view all audit logs
└── org_member → view org, create new projects (becomes Project Owner of new projects)

Project Scope ("project:{uuid}")
├── project_owner  → all permissions including delete project, manage roles
├── project_admin  → all except delete project and owner role management
├── project_member → read/write secrets and environments
└── project_viewer → read-only on secrets and environments
```

**Key design rules:**
- Org Admin does **not** automatically get Project Owner in any project (least-privilege)
- Creating a project makes the creator Project Owner automatically
- A user can be Org Admin and Project Viewer in the same project simultaneously
- Machine users receive project-scoped roles only; no Org Admin for machines in v1

---

## Casbin Model

```ini
# internal/authz/model/vault_model.conf  (embedded via go:embed)

[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _          # user, role, domain

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && r.obj == p.obj && r.act == p.act
```

**Domain encoding:**
```go
const (
    OrgDomain     = "org:%s"      // "org:550e8400-..."
    ProjectDomain = "project:%s"  // "project:abc123-..."
)
// Example enforce calls:
e.Enforce(userID, fmt.Sprintf(ProjectDomain, projectID), "secrets", "read")
e.Enforce(userID, fmt.Sprintf(OrgDomain, orgID), "org:members", "create")
```

---

## Built-in Policy Rules

Seeded at startup as `p` policy lines. These are role→permission mappings; user→role assignments are `g` lines stored in `role_assignments`.

```csv
# Project Owner (all permissions)
p, project_owner, *, secrets, read
p, project_owner, *, secrets, create
p, project_owner, *, secrets, update
p, project_owner, *, secrets, delete
p, project_owner, *, environments, create
p, project_owner, *, environments, delete
p, project_owner, *, members, create
p, project_owner, *, members, delete
p, project_owner, *, members, update
p, project_owner, *, settings, update
p, project_owner, *, rotation-plugins, execute

# Project Admin (no project delete, no owner management)
p, project_admin, *, secrets, read
p, project_admin, *, secrets, create
p, project_admin, *, secrets, update
p, project_admin, *, secrets, delete
p, project_admin, *, environments, create
p, project_admin, *, members, create
p, project_admin, *, members, update
p, project_admin, *, rotation-plugins, execute

# Project Member
p, project_member, *, secrets, read
p, project_member, *, secrets, create
p, project_member, *, secrets, update
p, project_member, *, environments, read

# Project Viewer
p, project_viewer, *, secrets, read
p, project_viewer, *, environments, read

# Org Admin
p, org_admin, *, org:members, create
p, org_admin, *, org:members, delete
p, org_admin, *, org:members, read
p, org_admin, *, org:projects, create
p, org_admin, *, org:projects, delete
```

---

## Permission Resolution Algorithm

```
isAllowed(subject, domain, resource, action) → (bool, reason):

1. JWT FAST PATH (zero I/O):
   → Extract claims from context (already decoded middleware)
   → If project domain: check claims.projects[projectID] role
   → If role grants action on resource → ALLOW (return immediately)

2. CASBIN ENFORCE (~0.164ms worst-case):
   → e.Enforce(subject, domain, resource, action)
   → ALLOW → return
   → DENY → check Additional Privileges (step 3)

3. ADDITIONAL PRIVILEGES LOOKUP (DB query, ~1-5ms):
   → SELECT from additional_privileges WHERE subject_id AND project_id
     AND (expires_at IS NULL OR expires_at > NOW())
   → Evaluate JSONB permissions array against (resource, action)
   → ALLOW if any match; else DENY

4. ASYNC AUDIT EMIT (non-blocking):
   → Write to audit_events via buffered channel → background writer
   → Never blocks the request path

5. RETURN decision + reason
```

---

## Enforcer Setup

```go
// internal/authz/enforcer.go

//go:embed model/vault_model.conf
var modelConf string

func NewEnforcer(db *gorm.DB) (*casbin.CachedEnforcer, error) {
    m, _ := model.NewModelFromString(modelConf)
    adapter, _ := gormadapter.NewAdapterByDB(db)
    e, _ := casbin.NewCachedEnforcer(m, adapter)
    e.EnableCache(true)
    e.SetExpireTime(5 * time.Minute)
    e.LoadPolicy()
    return e, nil
}
```

**Policy sync (single-node):** DB polling every 30 seconds reloads `LoadPolicy()`. Immediate revocation (e.g., Owner removal) is handled by the `jti` revocation list — Casbin sync latency of 30s is acceptable since the JWT is revoked instantly.

**Policy sync (multi-node, future):** `pg_notify("casbin_policy_update")` channel from `casbin/gorm-adapter` — all nodes reload within milliseconds.

### Performance Benchmarks

| Scale | Time/op | Memory |
|-------|---------|--------|
| 6 rules (typical v1) | 0.033 ms | 10.8 KB |
| 1,100 rules (small) | 0.164 ms | 80.6 KB |
| 11,000 rules (medium) | 2.258 ms | 765 KB |

CachedEnforcer (5-min TTL) reduces repeated identical checks to **~0ms** (in-memory map lookup).

---

## Database Schema

```sql
-- Role assignments (the g policy lines, normalized rows)
CREATE TABLE role_assignments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id   UUID NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'machine')),
    role         TEXT NOT NULL CHECK (role IN (
                   'org_admin', 'org_member',
                   'project_owner', 'project_admin',
                   'project_member', 'project_viewer'
                 )),
    scope_type   TEXT NOT NULL CHECK (scope_type IN ('organization', 'project')),
    scope_id     UUID NOT NULL,
    granted_by   UUID NOT NULL,
    granted_at   TIMESTAMPTZ DEFAULT NOW(),
    expires_at   TIMESTAMPTZ,     -- NULL = permanent
    revoked_at   TIMESTAMPTZ,     -- NULL = active
    UNIQUE (subject_id, subject_type, scope_type, scope_id)
);
CREATE INDEX idx_ra_subject ON role_assignments (subject_id, subject_type);
CREATE INDEX idx_ra_scope   ON role_assignments (scope_type, scope_id);
CREATE INDEX idx_ra_active  ON role_assignments (revoked_at, expires_at)
    WHERE revoked_at IS NULL;

-- Machine user API tokens
CREATE TABLE machine_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_user_id UUID NOT NULL REFERENCES machine_users(id) ON DELETE CASCADE,
    token_hash      BYTEA NOT NULL UNIQUE,  -- HMAC-SHA256(token, server_secret)
    prefix          TEXT NOT NULL,          -- first 8 chars for log identification
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);

-- JWT revocation list (immediate revocation for Owner removal etc.)
CREATE TABLE revoked_tokens (
    jti         TEXT PRIMARY KEY,
    subject_id  UUID NOT NULL,
    revoked_at  TIMESTAMPTZ DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL     -- cleaned up after original JWT exp
);
CREATE INDEX idx_rt_expires ON revoked_tokens (expires_at);

-- Audit events (append-only; application DB user has no UPDATE/DELETE)
CREATE TABLE audit_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type    TEXT NOT NULL,  -- 'permission.allow' | 'permission.deny' | 'role.assigned' | ...
    subject_id    UUID NOT NULL,
    subject_type  TEXT NOT NULL,
    subject_role  TEXT,
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   UUID,
    project_id    UUID,
    org_id        UUID NOT NULL,
    decision      TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    deny_reason   TEXT,
    request_id    TEXT,
    ip_address    INET,
    metadata      JSONB
);
CREATE INDEX idx_ae_timestamp ON audit_events (timestamp DESC);
CREATE INDEX idx_ae_subject   ON audit_events (subject_id, timestamp DESC);
CREATE INDEX idx_ae_project   ON audit_events (project_id, timestamp DESC)
    WHERE project_id IS NOT NULL;

-- Additional privileges — additive per-subject grants on top of base role (v1.5+)
CREATE TABLE additional_privileges (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id   UUID NOT NULL,
    subject_type TEXT NOT NULL,
    project_id   UUID NOT NULL,
    slug         TEXT NOT NULL,     -- e.g. "read-secrets-prod"
    permissions  JSONB NOT NULL,    -- [{action, subject, conditions}]
    is_temporary BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at   TIMESTAMPTZ,
    granted_by   UUID NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (subject_id, project_id, slug)
);
```

---

## Machine Token Protocol

- Format: `mvt_` prefix + 32-byte CSPRNG base64url → `mvt_xxxxxxxxxxxxxxxx...`
- Storage: `HMAC-SHA256(token, serverSecret)` — plaintext token never stored
- Verification: re-compute HMAC on incoming token, compare to stored hash (constant-time)
- Displayed to operator **once** at creation time; server cannot recover it
- Follows identical Casbin enforce path as human users

---

## Security Rules

**Deny by default:** Casbin `policy_effect = some(where (p.eft == allow))` — any unmatched request is denied. No catch-all allow rules.

**Immutable audit log:** `audit_events` table has no UPDATE/DELETE grants for the application DB user. A separate read-only DB user is used for compliance queries and exports.

**`alg:none` JWT bypass prevention:** Use `golang-jwt/jwt/v5` which rejects `alg:none` by default. Explicit algorithm whitelist required on parser init (RS256 or HS256 only).

**Last-owner lockout prevention:** Service layer checks `role_assignments` count for `project_owner` before allowing any Owner demotion or removal. Casbin check runs after this guard.

**Horizontal privilege escalation prevention:** All resource queries include `project_id` filter derived from authenticated token — never from user-supplied input alone. Casbin `dom == p.dom` matcher enforces isolation.

**Privilege expiry:** `role_assignments.expires_at` supports time-limited grants. Background job revokes expired assignments and emits `role.expired` audit events.

---

## Package Layout

```
internal/
├── auth/
│   ├── jwt.go             # token issuance, validation, claims struct
│   ├── machine_token.go   # mvt_ token generation, HMAC verification
├── authz/
│   ├── enforcer.go        # CachedEnforcer init, LoadPolicy, watcher
│   ├── middleware.go       # HTTP middleware: Enforce + audit emit
│   ├── resource.go         # URL → resource+action mapping helpers
│   └── model/
│       └── vault_model.conf   # embedded via go:embed
├── audit/
│   ├── emitter.go         # async buffered channel + background DB writer
│   └── schema.go          # AuditEvent struct
└── rbac/
    ├── assignments.go     # role_assignments CRUD (grant, revoke, list)
    └── seed.go            # built-in policy rows seeded at startup
```

---

## Go Module Dependencies

```go
require (
    github.com/casbin/casbin/v2         v2.x.x  // RBAC enforcement engine
    github.com/casbin/gorm-adapter/v3   v3.x.x  // PostgreSQL + SQLite adapter
    github.com/golang-jwt/jwt/v5        v5.x.x  // JWT issuance + validation
    golang.org/x/crypto                 vX.x.x  // HMAC for machine tokens
)
```

---

## Phased Delivery

| Phase | Sprint | Deliverables |
|-------|--------|-------------|
| 1 — Foundation | 1–2 | Casbin enforcer, `role_assignments` schema, built-in policy seeding, middleware, permission matrix tests |
| 2 — Machine Users | 3 | `machine_tokens` table, `mvt_` token issuance, HMAC verification, machine user role assignments |
| 3 — Audit Completeness | 4 | Async audit channel, `revoked_tokens` table, `jti` revocation middleware |
| 4 — Hardening | 5+ | PostgreSQL RLS on `secrets` table, `pg_notify` watcher, `additional_privileges` table |

---

## Open ADRs

| ADR | Decision needed | Recommendation |
|-----|----------------|----------------|
| ADR-04 | Casbin vs OPA — formally record choice and OPA deferral conditions | Casbin for v1 (Go-native, in-process, RBAC1); OPA deferred to v2+ if user-editable policies are required |
| ADR-05 | JWT claims strategy for users with >50 projects or Org Admin scope | Opaque token + DB lookup for Org Admins and broad users; embedded project-role claims for ≤50 projects |
| ADR-06 | Audit write mode default: `strict` (block request if audit write fails) vs `relaxed` (log error, allow) | `relaxed` default for availability; `strict` opt-in via config for compliance deployments |

---

## ADR Numbering Context

| Research Area | ADRs |
|--------------|------|
| Cryptographic Architecture | ADR-01 – ADR-03 |
| RBAC / Permission Architecture | ADR-04 – ADR-06 |
| Rotation Plugin Architecture | ADR-07 – ADR-09 |
| Machine User Auth & Offline Caching | ADR-10 – ADR-12 |
| Service Health Monitoring | ADR-13 – ADR-15 |
