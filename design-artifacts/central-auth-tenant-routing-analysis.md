# Central Auth + Tenant Routing — Architecture Analysis

**Document type:** Security architecture analysis  
**Scope:** Central SSO + multi-app-server tenant routing for Project Vault  
**Stack:** Go, PostgreSQL, Docker  
**Related specs:** `specs/multi-tenancy-data-model.md`, `specs/rbac-permission-architecture.md`,
`specs/machine-user-auth-offline-caching.md`, `specs/cryptographic-architecture.md`

---

## Executive Summary

The proposed architecture — a central auth service that issues tokens encoding routing hints toward
per-tenant application servers — is a well-understood pattern used in large-scale SaaS (Atlassian,
Notion, Linear, Slack) and is closely related to OIDC federation. It is **implementable and secure
when done correctly**, but it introduces meaningful new attack surfaces that demand careful design
from the start.

This document provides concrete JWT structures, Go middleware pseudocode, sequence diagrams, and an
honest threat model. Where trade-offs exist they are called out explicitly rather than papered over.

---

## 1. Central SSO Patterns

### 1.1 Established Patterns

Three patterns are industry-canonical for this problem:

#### Pattern A — OIDC Federation (Recommended baseline)

Central auth acts as an **OIDC Authorization Server** (AS). Each application server acts as an
**OIDC Relying Party** (RP). Tokens are standard OIDC ID Tokens (JWTs) plus optional opaque
Access Tokens.

```
User → Central Auth AS
     ← ID Token (JWT) + Access Token
User → App Server RP (presents token)
App Server → validates against AS JWKS endpoint
```

What Keycloak, Authentik, and Dex all implement:
- **Keycloak:** Full OIDC AS. Multi-realm = multi-tenant. Token contains `iss` (realm URL),
  `azp` (authorised party), and custom attributes via mappers. App servers validate locally
  against the realm's JWKS endpoint (`/realms/{realm}/protocol/openid-connect/certs`).
- **Authentik:** OIDC AS + SAML IdP. Providers per application; token scopes per provider.
  Routing hint can be embedded in a custom claim via "Property Mappings".
- **Dex:** Lightweight OIDC connector aggregator. Delegates upstream to LDAP/GitHub/SAML;
  issues its own OIDC tokens. No built-in tenant routing — you add routing claims in a
  custom connector or token hook.

**Verdict for Project Vault:** Implement a minimal OIDC AS (not full Keycloak/Dex complexity).
Use RS256 (asymmetric), expose a JWKS endpoint. Application servers validate locally. This
gives you a standard, auditable protocol without third-party dependencies.

#### Pattern B — Shared Session Cookie + Reverse Proxy

Central auth sets a cookie on a shared parent domain (e.g., `.vault.example.com`). Every app
server reads the same cookie. A reverse proxy (nginx, Caddy, Traefik) routes based on
`tenant_id` extracted from a subdomain or path prefix.

**Verdict:** Works for web-only, collapses if tenants span different domains or if CLI clients
are first-class. Not recommended for Project Vault (CLI is first-class).

#### Pattern C — Opaque Token + Introspection (RFC 7662)

Central auth issues opaque tokens. App servers call a central `/introspect` endpoint on every
request. Simple to implement; no local validation logic.

**Verdict:** Creates an availability coupling — every request requires the central auth service
to be reachable. Acceptable only if central auth is HA and co-located. See Section 4 for the
full trade-off analysis.

### 1.2 How "Redirect to Correct Server" Works in Practice

Three sub-patterns:

```
A) Client-side redirect (CLI + Web):
   1. Client POSTs credentials to central auth
   2. Central auth returns: { token, server_url: "https://app-eu.vault.example.com" }
   3. Client stores server_url alongside token; all subsequent calls go to server_url

B) HTTP 302 redirect (Web browser flow):
   1. Browser hits central auth login page
   2. After successful auth, central auth sets token in cookie/localStorage and HTTP 302s
      to: https://app-eu.vault.example.com/?code=<auth_code>&state=<csrf>
   3. App server exchanges code for token with central auth

C) Transparent proxy routing (no client awareness):
   1. All traffic hits a single ingress/gateway
   2. Gateway extracts tenant_id from subdomain/path/header
   3. Gateway looks up which backend serves this tenant (registry DB or config)
   4. Proxies request transparently; client never sees backend server URLs
```

**Recommendation:** Pattern A for CLI (clean, explicit, machine-friendly), Pattern B for web
browser login. Pattern C is operationally simpler but hides topology from clients, which
complicates debugging and CLI multi-server support.

---

## 2. Token Design for Tenant Routing

### 2.1 JWT Claim Structure

```json
// Header
{
  "alg": "RS256",
  "kid": "vault-central-2025-01",
  "typ": "JWT"
}

// Claims (Central Auth issues this — all fields signed)
{
  // === Standard OIDC claims ===
  "iss": "https://auth.vault.example.com",
  "sub": "usr_01HXYZ...",           // user's stable UUID
  "aud": ["vault-app"],             // audience: all app servers accept this
  "iat": 1720000000,
  "exp": 1720003600,                // 1 hour
  "jti": "tok_01HXYZ...",           // unique per token; revocation list key

  // === Tenant routing claims (Project Vault extension) ===
  "vault": {
    "org_id":     "org_01HABC...",  // which org this session is for
    "app_server": "https://app-eu.vault.example.com",  // routing hint
    "shard_id":   "eu-1",           // logical shard label (for monitoring/ops)
    "auth_method": "password",      // "password" | "oidc" | "saml" | "machine"
    "amr": ["pwd", "totp"],         // authentication method references (MFA proof)
    "acr": "2"                      // auth context level: 1=password, 2=MFA
  },

  // === Embedded RBAC claims (fast-path, per existing RBAC spec) ===
  "roles": {
    "org:org_01HABC...": "org_member",
    "project:proj_01HDEF...": "project_owner",
    "project:proj_01HGHI...": "project_member"
  }
}
```

**Design decisions explained:**

| Decision | Rationale |
|---|---|
| `vault.app_server` is a full URL | CLI can directly configure its target without a second lookup; survives central auth downtime |
| `vault.shard_id` is a label, not the URL | Ops can reroute a shard to a new URL without re-issuing all tokens; label→URL resolution lives in app server config |
| `aud` is a shared constant | All app servers accept the same audience — no per-server audience segmentation needed unless you add hostile-tenant isolation |
| `jti` is required | Enables immediate revocation (plugs into existing `revoked_tokens` table from RBAC spec) |
| `vault.amr` / `vault.acr` | Lets high-security operations on app servers require MFA re-verification before proceeding |

### 2.2 Security Implications of Routing Hints in the Token

**The hint cannot be blindly trusted.** An attacker who steals a token for App Server A and
replays it at App Server B can test what app server B accepts. Mitigations:

1. **App servers validate `vault.org_id` against their own tenant registry at first use.**
   If `org_01HABC` is not in the local database, reject — even if the JWT signature is valid.
2. **`vault.app_server` is informational only.** App servers must not use it as an allow-list;
   they must use `org_id` as the authoritative tenant selector.
3. **Token binding (future hardening):** Bind the token to the `app_server` audience using a
   second audience claim entry: `"aud": ["vault-app", "https://app-eu.vault.example.com"]`.
   App server checks its own URL is in `aud`. This makes cross-server replay impossible.

```go
// Audience validation in app server middleware
parser := jwt.NewParser(
    jwt.WithValidMethods([]string{"RS256"}),
    jwt.WithAudience("vault-app"),
    jwt.WithIssuedAt(),
)
// If using per-server audience binding:
// jwt.WithAudience("https://app-eu.vault.example.com")
```

### 2.3 Refresh Token Strategy

Refresh tokens are **opaque, stored in the central auth database only**, and are never sent to
application servers. An app server that receives an expired JWT redirects the client to central
auth, which validates the refresh token and issues a new JWT. The new JWT may contain a different
`app_server` hint if the tenant has been migrated.

```
Refresh token: rt_01HXYZ...  (stored as HMAC-SHA256 hash in central auth DB)
Access token:  JWT (signed, 1h TTL, presented to app servers)
```

---

## 3. Session Lifecycle Across Servers

### 3.1 Happy Path — Initial Login

```
Client (CLI)          Central Auth              App Server (EU-1)
     |                      |                         |
     |-- POST /auth/login -->|                         |
     |   {email, password}  |                         |
     |                      |-- verify credentials    |
     |                      |-- lookup tenant shard   |
     |                      |   SELECT app_server_url |
     |                      |   FROM orgs WHERE id=?  |
     |<-- 200 OK ------------|                         |
     |   {                  |                         |
     |     access_token,    |                         |
     |     refresh_token,   |                         |
     |     server_url:      |                         |
     |     "https://eu-1.." |                         |
     |   }                  |                         |
     |                                               |
     |-- GET /api/v1/secrets ----------------------->|
     |   Authorization: Bearer <access_token>        |
     |                                               |
     |                         |-- validate JWT locally (JWKS cache)
     |                         |-- check jti not revoked
     |                         |-- check org_id in local tenant registry
     |<-- 200 OK -------------------------------------|
```

### 3.2 Session Expiry and Re-authentication

```
Client (CLI)          Central Auth              App Server (EU-1)
     |                      |                         |
     |-- GET /api/v1/secrets ----------------------->|
     |   Authorization: Bearer <expired_token>       |
     |                                               |
     |                         |-- JWT exp check fails
     |<-- 401 Unauthorized ----------------------------|
     |   WWW-Authenticate: Bearer                    |
     |   X-Vault-Auth-Endpoint: https://auth.../token/refresh
     |   X-Vault-Hint: token-expired                 |
     |                                               |
     |-- POST /auth/token/refresh -->|               |
     |   {refresh_token}             |               |
     |                      |-- validate RT hash      |
     |                      |-- check RT not revoked  |
     |                      |-- re-lookup shard       |
     |<-- 200 OK ------------|                        |
     |   {new access_token,  |                        |
     |    new refresh_token, |                        |
     |    server_url}        |                        |
     |                                               |
     |-- GET /api/v1/secrets (retry) --------------->|
     |<-- 200 OK -------------------------------------|
```

**Key design choices:**
- The `X-Vault-Auth-Endpoint` response header tells the CLI exactly where to refresh without
  hardcoded URLs. CLI parses this and calls it directly.
- Central auth returns a **new** `server_url` on refresh. This enables transparent shard
  migration: if a tenant moved from `eu-1` to `eu-2` while the user was away, the refreshed
  token points to the new location.
- The CLI SDK wraps every HTTP call with automatic retry-after-refresh logic (see Section 7).

### 3.3 In-flight Request Preservation

For CLI, lost in-flight requests on expiry are acceptable — the CLI retries the command after
refresh. For the web UI, the approach is:

1. Detect 401 response while a mutation is in-flight.
2. Pause the mutation (do not commit).
3. Open a re-auth modal (no full page reload).
4. Re-auth modal calls central auth token endpoint.
5. Retry the paused mutation with the new token.
6. If re-auth fails (user cancels), surface a recoverable error.

Central auth does **not** need to remember which server the user came from in the token-refresh
flow. The client carries `server_url` in local state (CLI keyring / web localStorage); it is
present in the new JWT issued by central auth after refresh.

---

## 4. Cross-Server Token Validation

### 4.1 The Two Strategies

| Strategy | Mechanism | Latency | Coupling | Recommendation |
|---|---|---|---|---|
| **Local validation** | App server fetches JWKS once, caches public keys, validates JWTs in-process | ~0ms | Central auth needed only for key rotation | ✅ Primary |
| **Remote introspection** | App server calls `/introspect` on every request | 1–20ms network RTT | Every request coupled to central auth availability | ❌ Avoid as primary |
| **Hybrid** | Local for normal JWTs; remote introspect only for checking revocation of high-value operations | Nominal: ~0ms; elevated: ~5ms | Revocation path coupled | ✅ For compliance deployments |

### 4.2 JWKS Endpoint Design

Central auth exposes:

```
GET https://auth.vault.example.com/.well-known/openid-configuration
→ { "jwks_uri": "https://auth.vault.example.com/.well-known/jwks.json", ... }

GET https://auth.vault.example.com/.well-known/jwks.json
→ {
    "keys": [
      {
        "kty": "RSA",
        "kid": "vault-central-2025-01",
        "use": "sig",
        "alg": "RS256",
        "n": "...",
        "e": "AQAB"
      }
    ]
  }
```

**Key rotation protocol:**
1. Central auth generates a new RSA key pair; adds it to JWKS with a new `kid`.
2. Old key remains in JWKS for `2 × max_token_TTL` (to let in-flight tokens drain).
3. All new tokens use the new `kid` in their header.
4. App servers cache JWKS with a `Cache-Control: max-age=3600` signal. On encountering an
   unknown `kid`, they immediately re-fetch JWKS (one cache miss allowed per unknown kid).
5. After drain period, old key is removed from JWKS.

### 4.3 Local Validation with Revocation

Local validation cannot know about revoked tokens without a DB check. Options:

```
Option 1 — Short TTL (1h) + no revocation:
  Acceptable risk for most operations. Worst-case window = 1h.

Option 2 — Short TTL + jti revocation bloom filter:
  Central auth publishes a signed bloom filter of revoked jtis.
  App servers download it on a schedule (every 60s).
  False positive rate ~0.1% triggers a remote lookup.
  Zero false negatives (a revoked token is never allowed).

Option 3 — Short TTL + jti revocation endpoint:
  App server calls GET /auth/revocation/check?jti=<jti>
  Only for high-privilege operations (owner removal, delete project, export).
  Normal reads use local validation.
```

**Recommendation:** Option 1 for v1 (1h TTL is consistent with existing RBAC spec). Option 3
for high-privilege mutations, consistent with the existing `revoked_tokens` table. Option 2
can be added in v2 if compliance requirements tighten.

---

## 5. Machine Tokens and Service Accounts

### 5.1 Machine Token Flow in the Multi-Server Model

Machine tokens do **not** go through the browser redirect flow. They call central auth directly
and receive a server-routed JWT:

```
CI/CD Pipeline        Central Auth              App Server (EU-1)
     |                      |                         |
     |-- POST /auth/machine-token -->|                 |
     |   {identity_id, token: mvt_...}                 |
     |                      |-- HMAC-SHA256 verify    |
     |                      |-- lookup org_id for machine
     |                      |-- lookup app_server_url |
     |<-- 200 OK ------------|                         |
     |   {                  |                         |
     |     access_token: <JWT with vault.app_server>, |
     |     server_url: "https://eu-1...",              |
     |     expires_in: 3600  |                         |
     |   }                  |                         |
     |                                               |
     |-- GET /api/v1/secrets ----------------------->|
     |   Authorization: Bearer <access_token>        |
     |<-- 200 OK -------------------------------------|
```

**The CLI token resolution chain from the machine auth spec remains unchanged:**
```
VAULT_TOKEN env var → explicit --token → OS keyring → config file
```

In CI, `VAULT_TOKEN` holds the `mvt_` token. The CLI exchanges it for a JWT at startup and
then communicates directly with the `server_url`. If the JWT expires during a long pipeline,
the CLI re-exchanges `mvt_` at central auth (since machine tokens are not limited to one use
after initial bootstrap in this model).

### 5.2 Machine Token JWT Claims

Machine tokens produce JWTs with a `vault.auth_method: "machine"` claim and no `roles`
embedding beyond project scope (consistent with RBAC spec: no Org Admin for machines in v1).

```json
{
  "sub":  "machine_01HXYZ...",
  "vault": {
    "org_id":      "org_01HABC...",
    "app_server":  "https://app-eu.vault.example.com",
    "auth_method": "machine",
    "amr":         ["mvt"],
    "acr":         "1"
  },
  "roles": {
    "project:proj_01HDEF...": "project_member"
  }
}
```

### 5.3 Server Discovery Without Central Auth

For maximum resilience, the `server_url` should also be configurable statically:

```bash
# .vault.yaml / environment
VAULT_SERVER_URL=https://app-eu.vault.example.com
VAULT_AUTH_SERVER=https://auth.vault.example.com
```

If `VAULT_SERVER_URL` is set, the CLI skips the routing lookup entirely and calls the app
server directly. Central auth is still needed only for token exchange. This is the correct
model for air-gapped or highly isolated deployments.

---

## 6. Security Threat Model

### 6.1 New Attack Surfaces Introduced

This architecture adds the following surfaces that a single-server deployment does not have:

| Surface | Risk | Severity |
|---|---|---|
| Central auth as SPOF for authentication | DoS on central auth blocks all logins | High |
| Open redirect via `server_url` in token or response | Attacker-controlled `server_url` sends client to malicious server | High |
| Token replay across app servers | Stolen token valid on a different app server than intended | Medium |
| Server impersonation | Attacker runs a fake app server at a redirected URL | Medium |
| SSRF in routing layer | Central auth fetches an attacker-controlled URL to validate tenant location | Medium |
| JWKS endpoint poisoning | Attacker injects a fake public key if JWKS endpoint is unauthenticated | Medium |
| Refresh token theft from central auth DB | Compromise of central auth DB exposes all refresh tokens | High |
| Cross-tenant escalation via mis-configured `org_id` routing | User for Org A gets token hinting to App Server B; B has Org A data | High |

### 6.2 Open Redirect: `server_url` Poisoning

**Attack vector:** If central auth returns `server_url` based on user-supplied input (e.g., a
`redirect_uri` parameter) without validation, an attacker can direct the client to send the
token to `https://evil.example.com`.

**Mitigations:**

```go
// central auth: server_url must come from the database, never from user input
func lookupServerURL(orgID string) (string, error) {
    var url string
    err := db.QueryRow(
        "SELECT app_server_url FROM orgs WHERE id = $1 AND app_server_url IS NOT NULL",
        orgID,
    ).Scan(&url)
    if err != nil {
        return "", ErrOrgNotFound
    }
    // Enforce scheme and domain allowlist
    if !isAllowedServerURL(url) {
        return "", ErrInvalidServerURL
    }
    return url, nil
}

var allowedServerHostnames = []string{
    "app-eu.vault.example.com",
    "app-us.vault.example.com",
    "app-apac.vault.example.com",
}

func isAllowedServerURL(raw string) bool {
    u, err := url.Parse(raw)
    if err != nil || u.Scheme != "https" {
        return false
    }
    for _, h := range allowedServerHostnames {
        if u.Hostname() == h {
            return true
        }
    }
    return false
}
```

The allowed hostnames list is **server-side configuration only** — not in the JWT, not in user
input.

### 6.3 Token Replay Across Servers

**Attack:** Steal a JWT intended for App Server EU-1, replay it at App Server US-1.

**Mitigations (layered):**
1. App server validates `vault.org_id` against its own tenant registry. If the org is not
   local, reject with 403.
2. Optional: Include the target server URL in `aud` (Section 2.2). App server checks its own
   URL appears in `aud` list.
3. Short token TTL (1h) limits replay window.
4. mTLS between services (in containerised deployments) prevents network-level replay.

**Residual risk:** If an attacker can register an org on another app server using the same
`org_id` UUID, they could replay. Prevent this by making `org_id` a globally unique UUID
controlled only by central auth at org creation time.

### 6.4 Server Impersonation

**Attack:** Attacker registers a server at an IP that has DNS overlap with a decommissioned app
server URL, or tricks a user into configuring a malicious `VAULT_SERVER_URL`.

**Mitigations:**
- All app servers use TLS certificates from a known CA (or a private CA in self-hosted deployments).
- CLI validates TLS certificate — never allows `InsecureSkipVerify: true` in production builds.
- Central auth signs the `server_url` inside the JWT payload (already handled by RS256 signing
  of the entire claims block). A forged server URL would require breaking RS256 or stealing
  the signing private key.

### 6.5 SSRF in Routing Layer

**Attack:** If central auth performs any HTTP call to a URL derived from user-supplied data
(e.g., validating a user-supplied OIDC discovery URL), an attacker can direct it to internal
services.

**Mitigations:**
- OIDC discovery URLs are admin-configured, not user-supplied, and validated against an
  allowlist at configuration time.
- Any outbound HTTP calls from central auth use a restricted HTTP client with:
  ```go
  transport := &http.Transport{
      DialContext: restrictedDialer(allowedCIDRs), // blocks RFC1918, loopback, link-local
  }
  ```
- Central auth never makes outbound HTTP calls to user-supplied URLs at request time.

### 6.6 JWKS Endpoint Integrity

App servers fetch JWKS over TLS and cache aggressively. Risks:

- **DNS poisoning:** Mitigated by TLS certificate validation (HSTS, pinning for self-hosted).
- **Compromised central auth serves malicious JWKS:** If central auth is compromised, the
  attacker can issue valid tokens anyway — JWKS poisoning adds no extra capability. The
  threat model for central auth compromise is full system compromise.
- **Cache poisoning:** App servers only update JWKS on explicit re-fetch triggered by unknown
  `kid`. They do not blindly accept any JWKS response without signature verification of the
  discovery document (for OIDC-conformant implementations).

### 6.7 Central Auth Database Compromise

Refresh tokens stored in central auth are HMAC-SHA256 hashes of the opaque token (consistent
with the `machine_tokens` approach in the existing machine auth spec). An attacker who reads
the database cannot reconstruct the plaintext refresh tokens without the server secret.

The server secret (HMAC key) must be stored in a hardware-backed secret store or at minimum
an environment variable injected at runtime, never in the database.

---

## 7. Concrete Implementation in Go

### 7.1 Go Library Stack

```go
// go.mod additions for the auth service
require (
    github.com/golang-jwt/jwt/v5       v5.x.x  // JWT issuance + validation (existing dep)
    github.com/lestrrat-go/jwx/v2      v2.x.x  // JWKS serving + client-side key fetch/cache
    github.com/go-jose/go-jose/v4      v4.x.x  // RFC 7517 key management (alternative to jwx)
    golang.org/x/crypto                vX.x.x  // HMAC for refresh tokens (existing dep)
)

// No new deps needed on app servers — golang-jwt/jwt/v5 + lestrrat-go/jwx handle
// both token validation and JWKS fetching.
```

**Library choice rationale:**
- `golang-jwt/jwt/v5`: already in the project per RBAC spec; handles `alg:none` rejection.
- `lestrrat-go/jwx/v2`: best-in-class JWKS client with automatic key caching, refresh on
  unknown `kid`, and RSA/EC/OKP support. Used by major Go OIDC implementations.

### 7.2 Central Auth: Token Issuance

```go
// internal/centralauth/token_issuer.go

type CentralAuthClaims struct {
    jwt.RegisteredClaims
    Vault VaultClaims            `json:"vault"`
    Roles map[string]string      `json:"roles,omitempty"`
}

type VaultClaims struct {
    OrgID      string   `json:"org_id"`
    AppServer  string   `json:"app_server"`
    ShardID    string   `json:"shard_id"`
    AuthMethod string   `json:"auth_method"`
    AMR        []string `json:"amr"`
    ACR        string   `json:"acr"`
}

type TokenIssuer struct {
    signingKey    *rsa.PrivateKey
    signingKeyID  string
    issuer        string
    accessTTL     time.Duration
    orgRepo       OrgRepository
    roleRepo      RoleRepository
}

func (ti *TokenIssuer) IssueAccessToken(ctx context.Context, sub string, orgID string) (string, error) {
    org, err := ti.orgRepo.GetByID(ctx, orgID)
    if err != nil {
        return "", fmt.Errorf("org lookup: %w", err)
    }
    if !isAllowedServerURL(org.AppServerURL) {
        return "", ErrInvalidServerConfiguration
    }

    roles, err := ti.roleRepo.GetEmbeddableRoles(ctx, sub, orgID)
    if err != nil {
        return "", fmt.Errorf("role lookup: %w", err)
    }

    now := time.Now().UTC()
    claims := CentralAuthClaims{
        RegisteredClaims: jwt.RegisteredClaims{
            Issuer:    ti.issuer,
            Subject:   sub,
            Audience:  jwt.ClaimStrings{"vault-app"},
            IssuedAt:  jwt.NewNumericDate(now),
            ExpiresAt: jwt.NewNumericDate(now.Add(ti.accessTTL)),
            ID:        newJTI(),
        },
        Vault: VaultClaims{
            OrgID:      orgID,
            AppServer:  org.AppServerURL,
            ShardID:    org.ShardID,
            AuthMethod: "password",
            AMR:        []string{"pwd"},
            ACR:        "1",
        },
        Roles: roles,
    }

    token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
    token.Header["kid"] = ti.signingKeyID
    return token.SignedString(ti.signingKey)
}
```

### 7.3 App Server: Auth Middleware

```go
// internal/appserver/middleware/auth.go

type AuthMiddleware struct {
    jwksCache     *jwxjwk.Cache   // lestrrat-go/jwx auto-refreshing cache
    issuer        string
    orgRegistry   OrgRegistry     // local lookup: is this org_id served here?
    revokedTokens RevokedTokens   // implements: IsRevoked(jti string) bool
}

func NewAuthMiddleware(jwksURI, issuer string, orgReg OrgRegistry, rev RevokedTokens) *AuthMiddleware {
    cache := jwxjwk.NewCache(context.Background())
    cache.Register(jwksURI, jwxjwk.WithMinRefreshInterval(15*time.Minute))
    return &AuthMiddleware{
        jwksCache:     cache,
        issuer:        issuer,
        orgRegistry:   orgReg,
        revokedTokens: rev,
    }
}

func (m *AuthMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        raw, err := extractBearerToken(r)
        if err != nil {
            writeUnauthorized(w, "missing token", m.issuer+"/token/refresh")
            return
        }

        // 1. Fetch current JWKS (cached; re-fetched on unknown kid)
        keySet, err := m.jwksCache.Get(r.Context(), m.issuer+"/.well-known/jwks.json")
        if err != nil {
            writeServiceUnavailable(w, "jwks unavailable")
            return
        }

        // 2. Parse and validate JWT locally
        parser := jwt.NewParser(
            jwt.WithValidMethods([]string{"RS256"}),
            jwt.WithAudience("vault-app"),
            jwt.WithIssuer(m.issuer),
            jwt.WithIssuedAt(),
        )
        claims := &CentralAuthClaims{}
        _, err = parser.ParseWithClaims(raw, claims, jwksKeyFunc(keySet))
        if err != nil {
            writeUnauthorized(w, "invalid token", m.issuer+"/token/refresh")
            return
        }

        // 3. Check jti revocation (fast: bloom filter or in-memory set)
        if m.revokedTokens.IsRevoked(claims.ID) {
            writeUnauthorized(w, "token revoked", m.issuer+"/token/refresh")
            return
        }

        // 4. Validate org is served by THIS app server
        if !m.orgRegistry.IsLocal(claims.Vault.OrgID) {
            // Tenant has been migrated; tell client where to go
            newServer, _ := m.orgRegistry.CurrentServerFor(claims.Vault.OrgID)
            w.Header().Set("X-Vault-Relocated-To", newServer)
            writeMoved(w, newServer)
            return
        }

        // 5. Attach claims to context for downstream handlers
        ctx := WithAuthClaims(r.Context(), claims)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// jwksKeyFunc returns a jwt.Keyfunc that selects the right key by kid from a JWKS key set.
func jwksKeyFunc(keySet jwxjwk.Set) jwt.Keyfunc {
    return func(token *jwt.Token) (interface{}, error) {
        kid, ok := token.Header["kid"].(string)
        if !ok {
            return nil, errors.New("missing kid header")
        }
        key, found := keySet.LookupKeyID(kid)
        if !found {
            return nil, fmt.Errorf("unknown kid: %s", kid)
        }
        var pubKey rsa.PublicKey
        if err := key.Raw(&pubKey); err != nil {
            return nil, err
        }
        return &pubKey, nil
    }
}
```

### 7.4 CLI: Automatic Token Refresh

```go
// internal/cli/httpclient/client.go

type VaultClient struct {
    httpClient   *http.Client
    serverURL    string
    authServer   string
    tokenStore   TokenStore      // OS keyring abstraction (existing from machine auth spec)
    refreshToken string
    mu           sync.Mutex
}

func (c *VaultClient) Do(req *http.Request) (*http.Response, error) {
    token, err := c.tokenStore.Get(c.serverURL)
    if err != nil {
        return nil, ErrNotAuthenticated
    }

    req.Header.Set("Authorization", "Bearer "+token)
    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, err
    }

    // Automatic token refresh on 401
    if resp.StatusCode == http.StatusUnauthorized {
        resp.Body.Close()

        // Serialize refresh attempts (avoid thundering herd)
        c.mu.Lock()
        newToken, newServer, err := c.refresh()
        c.mu.Unlock()
        if err != nil {
            return nil, ErrSessionExpired
        }

        // Update server URL if tenant was migrated
        if newServer != "" && newServer != c.serverURL {
            c.serverURL = newServer
            req.URL.Host = mustParseHost(newServer)
        }

        // Retry original request once with new token
        req.Header.Set("Authorization", "Bearer "+newToken)
        return c.httpClient.Do(req)
    }

    // Handle explicit relocation (tenant migrated mid-session)
    if resp.StatusCode == http.StatusPermanentRedirect {
        newServer := resp.Header.Get("X-Vault-Relocated-To")
        if newServer != "" {
            c.serverURL = newServer
            req.URL.Host = mustParseHost(newServer)
            resp.Body.Close()
            return c.httpClient.Do(req)
        }
    }

    return resp, nil
}

func (c *VaultClient) refresh() (newToken, newServer string, err error) {
    body, _ := json.Marshal(map[string]string{"refresh_token": c.refreshToken})
    resp, err := c.httpClient.Post(c.authServer+"/auth/token/refresh", "application/json", bytes.NewReader(body))
    if err != nil {
        return "", "", err
    }
    defer resp.Body.Close()

    var result struct {
        AccessToken  string `json:"access_token"`
        RefreshToken string `json:"refresh_token"`
        ServerURL    string `json:"server_url"`
    }
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return "", "", err
    }

    c.tokenStore.Set(result.ServerURL, result.AccessToken)
    c.refreshToken = result.RefreshToken
    return result.AccessToken, result.ServerURL, nil
}
```

### 7.5 Central Auth: JWKS Endpoint

```go
// internal/centralauth/jwks_handler.go

type JWKSHandler struct {
    publicKeys []*rsa.PublicKey
    keyIDs     []string
}

func (h *JWKSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    keys := make([]map[string]any, 0, len(h.publicKeys))
    for i, pubKey := range h.publicKeys {
        jwkKey, _ := jwxjwk.FromRaw(pubKey)
        jwkKey.Set(jwxjwk.KeyIDKey, h.keyIDs[i])
        jwkKey.Set(jwxjwk.AlgorithmKey, jwa.RS256)
        jwkKey.Set(jwxjwk.KeyUsageKey, "sig")

        var buf bytes.Buffer
        json.NewEncoder(&buf).Encode(jwkKey)
        var m map[string]any
        json.Unmarshal(buf.Bytes(), &m)
        keys = append(keys, m)
    }

    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Cache-Control", "public, max-age=3600")
    json.NewEncoder(w).Encode(map[string]any{"keys": keys})
}
```

---

## 8. Database Schema Additions (Central Auth)

The central auth service requires its own dedicated database. Schema:

```sql
-- Tenants registry: which app server serves which org
CREATE TABLE org_routing (
    org_id          UUID PRIMARY KEY,
    app_server_url  TEXT NOT NULL,
    shard_id        TEXT NOT NULL,
    migrated_at     TIMESTAMPTZ,
    previous_url    TEXT         -- keep during migration drain period
);
CREATE INDEX idx_or_shard ON org_routing (shard_id);

-- Refresh tokens (opaque; stored as HMAC hash)
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash      BYTEA NOT NULL UNIQUE,  -- HMAC-SHA256(token, serverSecret)
    subject_id      UUID NOT NULL,
    org_id          UUID NOT NULL,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    user_agent      TEXT,
    ip_address      INET
);
CREATE INDEX idx_rt_subject   ON refresh_tokens (subject_id, revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_rt_expires   ON refresh_tokens (expires_at);

-- JWKS signing key rotation log
CREATE TABLE signing_keys (
    kid             TEXT PRIMARY KEY,
    public_key_pem  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    retired_at      TIMESTAMPTZ
);
```

---

## 9. Key Architectural Decisions Summary

| Decision | Choice | Rationale |
|---|---|---|
| Token format | RS256 JWT | Asymmetric; app servers validate locally without shared secret |
| Routing hint location | Inside JWT (`vault.app_server`) + also in login response body | Signed; can't be tampered with; client has it before first app server call |
| App server validation | Local (JWKS cache) + jti revocation check | Low latency; no request-time coupling to central auth |
| Refresh token storage | Opaque, HMAC hash in central auth DB | Consistent with existing `machine_tokens` pattern |
| Open redirect prevention | `server_url` from DB only, validated against allowlist | User input never influences routing |
| Tenant migration | `X-Vault-Relocated-To` response header + new `app_server` in refresh token response | Transparent to user; CLI handles automatically |
| Machine token flow | Direct `mvt_` → JWT exchange at central auth, then direct app server calls | No browser redirect; CI-friendly; `VAULT_SERVER_URL` override for air-gapped |
| Central auth HA | Standard: PostgreSQL primary + standby, app-level retry on central auth calls | Login is the only central-auth-required path; app servers run independently once token issued |

---

## 10. What This Architecture Does NOT Solve

Be honest about gaps before committing to implementation:

1. **Central auth is still a single point of failure for new logins.** Existing sessions
   (valid JWT + refreshable via refresh token) work if central auth is down. New logins and
   token refreshes are blocked. Mitigate with HA deployment and circuit breakers, not by
   design changes.

2. **Tenant migration is a multi-step operational process.** Moving a tenant from Shard A to
   Shard B requires: (a) data migration, (b) updating `org_routing`, (c) a drain period where
   both shards accept the token, (d) old shard stops accepting. This document describes the
   protocol hooks; the migration runbook is a separate operational concern.

3. **The `roles` claim in the JWT creates a staleness window.** Role changes take up to 1h
   to propagate (existing JWT TTL). The existing `revoked_tokens` JTI mechanism handles
   Owner removal, but routine role changes (e.g., member → viewer demotion) are eventually
   consistent. This is the same trade-off documented in the RBAC spec and is acceptable for v1.

4. **Web UI requires additional CSRF protection.** The token-in-cookie approach for web
   requires standard `SameSite=Strict` + CSRF token headers. The CLI bearer token flow does
   not have this issue.

5. **This design is not yet OIDC-conformant.** It borrows OIDC conventions (JWKS, discovery
   document) but does not implement the full authorization code flow or introspection endpoint.
   If a future requirement is to federate with external OIDC clients (e.g., third-party apps
   that want to authenticate against Project Vault), a full OIDC server (consider `zitadel/oidc`
   or `ory/fosite`) would be needed. V1 does not require this.

---

## 11. Recommended Implementation Sequence

```
Phase 1 — Foundation (implement before any app server work)
  ├── Central auth service: login endpoint, JWT issuance, org_routing table
  ├── JWKS endpoint + discovery document
  ├── App server: AuthMiddleware with JWKS validation + org_id check
  └── CLI client: bearer token injection + 401 retry hook

Phase 2 — Session lifecycle
  ├── Refresh token issuance + storage in central auth DB
  ├── Token refresh endpoint on central auth
  └── CLI: automatic refresh on 401; keyring update on new server_url

Phase 3 — Machine tokens
  ├── mvt_ → JWT exchange endpoint on central auth (consistent with existing machine auth spec)
  └── VAULT_SERVER_URL override for air-gapped deployments

Phase 4 — Hardening
  ├── Per-server audience binding in JWT aud claim
  ├── jti revocation endpoint for high-privilege operations
  ├── SSRF-restricted HTTP client on central auth for external OIDC calls
  └── Key rotation protocol + automated JWKS drain period
```
