---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
workflowType: 'research'
lastStep: 6
research_type: 'technical'
research_topic: 'Machine User Auth & Offline Caching'
research_goals: 'Design machine user authentication and offline/local caching for Project Vault CLI and CI/CD agents'
user_name: 'Nestor'
date: '2026-04-09'
web_research_enabled: true
source_verification: true
---

# Research Report: Machine User Auth & Offline Caching

**Date:** 2026-04-09
**Author:** Nestor
**Research Type:** technical

---

## Research Overview

This document presents a comprehensive technical research report on Machine User Authentication and Offline Caching for Project Vault. The research was conducted using live web sources (Infisical docs, HashiCorp Vault docs, pkg.go.dev, GitHub repositories) covering how production secrets platforms handle non-human (machine) authentication, token lifecycle management, OS credential storage, and offline/local secret caching in CLI and CI/CD contexts.

The research addresses two distinct but tightly coupled concerns: (1) how a machine identity (CI runner, Kubernetes pod, developer workstation process) authenticates with Project Vault and obtains a scoped access token; and (2) how the CLI agent caches secrets locally so that repeated requests do not hit the server on every invocation, with guarantees around confidentiality, freshness, and invalidation.

All decisions are grounded in the existing Project Vault RBAC architecture (machine tokens with `mvt_` prefix and HMAC-SHA256 storage, per prior research) and the cryptographic architecture (AES-256-GCM envelope encryption). This research extends those foundations to cover the client-side token storage and offline cache layer.

---

## Table of Contents

1. [Technical Research Scope Confirmation](#technical-research-scope-confirmation)
2. [Executive Summary](#executive-summary)
3. [Technology Stack Analysis](#technology-stack-analysis)
   - [Machine Auth Patterns in Production Platforms](#machine-auth-patterns-in-production-platforms)
   - [OS Credential Storage](#os-credential-storage)
   - [Offline Cache Storage Engine](#offline-cache-storage-engine)
   - [Cache Encryption Primitives](#cache-encryption-primitives)
   - [XDG Base Directory Paths](#xdg-base-directory-paths)
   - [Technology Comparison Matrix](#technology-comparison-matrix)
4. [Integration Patterns Analysis](#integration-patterns-analysis)
   - [Machine Auth Flows](#machine-auth-flows)
   - [Token Lifecycle & Renewal](#token-lifecycle--renewal)
   - [CLI Token Storage Pattern](#cli-token-storage-pattern)
   - [Offline Cache Read/Write Pattern](#offline-cache-readwrite-pattern)
   - [Cache Invalidation Patterns](#cache-invalidation-patterns)
   - [CI/CD Agent Pattern](#cicd-agent-pattern)
5. [Architectural Patterns and Design](#architectural-patterns-and-design)
   - [Machine Identity Model](#machine-identity-model)
   - [Auth Flow State Machine](#auth-flow-state-machine)
   - [Token Storage Architecture](#token-storage-architecture)
   - [Offline Cache Architecture](#offline-cache-architecture)
   - [Cache Encryption Design](#cache-encryption-design)
   - [Database Schema — Server Side](#database-schema--server-side)
   - [Security Architecture](#security-architecture)
6. [Implementation Approaches](#implementation-approaches)
   - [Phase 1 — CLI Token Auth & Keyring (v1.0)](#phase-1--cli-token-auth--keyring-v10)
   - [Phase 2 — Offline Cache (v1.1)](#phase-2--offline-cache-v11)
   - [Phase 3 — OIDC / Platform Auth (v1.2+)](#phase-3--oidc--platform-auth-v12)
   - [Go Module Layout](#go-module-layout)
   - [Test Strategy](#test-strategy)
   - [Risk Assessment](#risk-assessment)
7. [Research Conclusion](#research-conclusion)

---

## Technical Research Scope Confirmation

**Research Topic:** Machine User Auth & Offline Caching
**Research Goals:** Design machine user authentication and offline/local caching for Project Vault CLI and CI/CD agents

**Technical Research Scope:**

- Architecture Analysis — machine identity models, token lifecycle, cache architecture
- Implementation Approaches — Go keyring libraries, embedded KV stores, encryption primitives
- Technology Stack — `99designs/keyring`, `bbolt`, NaCl secretbox, Argon2id, `adrg/xdg`
- Integration Patterns — CLI auth flows, CI/CD patterns, cache read/write/invalidation
- Performance & Security Considerations — cache freshness, token renewal, offline guarantees

**Research Methodology:** Current web data with rigorous source verification against Infisical, Vault, and Go ecosystem documentation.

**Scope Confirmed:** 2026-04-09

---

## Executive Summary

Machine authentication and offline caching are two sides of the same operational problem: how do non-human identities securely obtain Project Vault secrets, and how do they do so without hammering the server on every startup? Production platforms (Infisical, HashiCorp Vault) have converged on a well-tested set of patterns that Project Vault can adopt directly.

**Key Findings:**

1. **Infisical Universal Auth** (Client ID + Client Secret → short-lived JWT access token, with periodic renewal to solve "secret zero") is the right model for Project Vault's machine token flow. The `mvt_` token from RBAC research maps directly to Infisical's Client Secret. Periodic token renewal eliminates the need to re-issue the Client Secret on every CI run. (Source: infisical.com/docs/documentation/platform/identities/universal-auth)

2. **HashiCorp Vault AppRole** (RoleID + SecretID → batch token) demonstrates why _two-part_ credentials are important: the RoleID can be stored in source control / CI config, while the SecretID is retrieved at runtime from a trusted channel. Project Vault should support the same two-part bootstrap: a non-sensitive identity ID (public) + a sensitive token (private). (Source: developer.hashicorp.com/vault/docs/auth/approle)

3. **Infisical OIDC Auth** (JWT from identity provider → short-lived access token, validated via OIDC Discovery) is the right pattern for GitHub Actions, GitLab CI, and Kubernetes workloads. No long-lived credential needed in CI environment. Deferred to v1.2+. (Source: infisical.com/docs/documentation/platform/identities/oidc-auth)

4. **`99designs/keyring`** provides a uniform Go API over macOS Keychain, Linux Secret Service (GNOME Keyring / KDE KWallet), Windows Credential Manager, Linux keyctl, and encrypted file fallback. All six backends expose the same `Get`/`Set`/`Remove` interface. This is the right library for storing the CLI's access token on developer workstations. (Source: pkg.go.dev/github.com/99designs/keyring v1.2.2)

5. **HashiCorp Vault Agent Persistent Cache** (BoltDB file encrypted with a generated key, containing tokens + leases + secret values) is the production blueprint for offline caching. Project Vault's offline cache should adopt the same storage engine (`bbolt`) and encryption approach. (Source: developer.hashicorp.com/vault/docs/agent-and-proxy/agent/caching/persistent-caches)

6. **NaCl `secretbox`** (XSalsa20+Poly1305) is the right cache encryption primitive — authenticated encryption, nonce-based, pure Go, interoperable with the NaCl spec. Cache encryption key derived from the machine token using HMAC-SHA256 (already available in the crypto architecture). For passphrase-protected human-used caches, **Argon2id** (RFC 9106 recommended: time=1, memory=64MB) derives the key. (Source: pkg.go.dev/golang.org/x/crypto/nacl/secretbox, pkg.go.dev/golang.org/x/crypto/argon2)

**Recommendations:**

1. Two-tier auth: `VAULT_TOKEN` env var (CI/CD, highest priority) → OS keyring (interactive human auth) → file fallback (`~/.config/project-vault/token`, chmod 0600).
2. Use `99designs/keyring` with service name `"project-vault"` and key per-server-URL for multi-server support.
3. Offline cache: `bbolt` at `xdg.CacheHome/project-vault/cache.db`, entries encrypted with NaCl secretbox, cache-key derived from machine token HMAC.
4. Cache TTL = min(server TTL, local config max TTL). Honor `X-Cache-TTL` response header. Default max: 5 minutes for interactive CLI, 15 minutes for CI agents.
5. CI/CD: `VAULT_TOKEN` set from `vault login` output; no keyring, no cache. Use `--no-cache` flag for cache bypass. One-use tokens with `num_uses=1` for highest-security pipelines.

---

## Technology Stack Analysis

### Machine Auth Patterns in Production Platforms

**Infisical Universal Auth — Reference Model for Project Vault v1**

Universal Auth is Infisical's platform-agnostic machine auth method. Flow:
1. Client submits **Client ID** + **Client Secret** to `POST /api/v1/auth/universal-auth/login`
2. Server verifies credentials → returns short-lived JWT access token
3. Client uses JWT for subsequent API requests (Bearer token)
4. Before JWT expiry, client calls `POST /api/v1/auth/universal-auth/renew` with current token → receives extended token

**Periodic Token** feature solves "secret zero": Client Secret can be configured with `num_uses=1` (single-use bootstrap), after which the periodic access token is self-renewable. A disruption in renewal requires manual re-issuance of Client Secret — intentional security forcing function.

_Source: infisical.com/docs/documentation/platform/identities/universal-auth — "Periodic tokens in Universal Auth are designed to solve this problem by enabling secure, automated bootstrapping and ongoing access renewal"_

**Infisical OIDC Auth — CI/CD Platform-Native Auth (v1.2+)**

OIDC Auth eliminates long-lived credentials in CI entirely:
1. CI runner requests OIDC JWT from platform (GitHub Actions, GitLab CI, etc.)
2. JWT sent to `POST /api/v1/auth/oidc-auth/login`
3. Server fetches IdP public key via OIDC Discovery, validates JWT, checks subject/audience/claims
4. Returns short-lived access token scoped to the identity's configured roles
5. `subject`, `audiences`, `claims` support glob patterns (e.g., `repo:my-org/my-repo:*` for GitHub Actions)

_Source: infisical.com/docs/documentation/platform/identities/oidc-auth_

**HashiCorp Vault AppRole — Two-Part Bootstrap Pattern**

AppRole uses two credentials:
- **RoleID**: non-sensitive identifier (can be stored in config files, source code). Identifies which AppRole to authenticate against.
- **SecretID**: sensitive credential (short TTL, limited uses). Retrieved at runtime from a trusted delivery channel (e.g., CI secrets store, Vault itself at startup).

`token_type=batch` is recommended for machine workloads: batch tokens are lightweight, non-revocable per-token (revoked by revoking the parent auth method), and suitable for short-lived CI runs.

Pull mode SecretID (server-generated) is preferred over Push mode — keeps full credentials unknown to the distributing system.

_Source: developer.hashicorp.com/vault/docs/auth/approle — "RoleID is an identifier that selects the AppRole… SecretID is a credential that is required by default for any login"_

**Infisical CLI Token Injection Pattern**

For CI/CD machine contexts, Infisical's CLI accepts:
- `INFISICAL_TOKEN` environment variable (pre-exported from `infisical login --method=universal-auth --silent --plain`)
- `--token` flag
- `infisical run --watch` — restarts process on secret change (watch mode for local dev)
- `.infisical.json` project config file for non-interactive project binding

_Source: infisical.com/docs/cli/commands/run_

### OS Credential Storage

**`99designs/keyring` v1.2.2**

Provides a uniform Go `Keyring` interface over all major OS credential stores:

| Backend | OS | Store |
|---------|-----|-------|
| `KeychainBackend` | macOS | macOS Keychain |
| `SecretServiceBackend` | Linux | GNOME Keyring / KDE KWallet via D-Bus |
| `KWalletBackend` | Linux | KDE KWallet directly |
| `KeyCtlBackend` | Linux | Linux kernel keyctl |
| `WinCredBackend` | Windows | Windows Credential Manager |
| `FileBackend` | All | Encrypted file (passphrase-protected) |
| `PassBackend` | All | `pass` (GPG-based) |

Key API:
```go
kr, err := keyring.Open(keyring.Config{
    ServiceName: "project-vault",
    // Falls back through available backends automatically
})
err = kr.Set(keyring.Item{Key: "token:https://vault.example.com", Data: []byte(token)})
item, err := kr.Get("token:https://vault.example.com")
```

`AvailableBackends()` returns a slice of backends supported on the current OS — allows graceful degradation to file backend on headless servers.

_Source: pkg.go.dev/github.com/99designs/keyring v1.2.2 — BackendType constants, `Open`, `Keyring` interface_

### Offline Cache Storage Engine

**bbolt (`go.etcd.io/bbolt`) — Recommended**

bbolt (etcd-maintained fork of Bolt) is a pure Go embedded key-value store used in production at 1TB+ database sizes. Key properties:
- **Single file** on disk (`cache.db`) — easy to locate, backup, wipe
- **ACID transactions**: one read-write at a time, unlimited concurrent read-only
- **Buckets** — namespace for grouping keys (e.g., `secrets`, `tokens`, `metadata`)
- `bolt.Open(path, 0600, &bolt.Options{Timeout: 1*time.Second})` — file locking with timeout prevents hang if cache already open
- **No network requirement** — embedded, no daemon

Used by HashiCorp Vault Agent persistent cache as its storage backend.

_Source: pkg.go.dev/go.etcd.io/bbolt — "Many companies such as Shopify and Heroku use Bolt-backed services every day… databases as large as 1TB"_
_Source: developer.hashicorp.com/vault/docs/agent-and-proxy/agent/caching/persistent-caches — "The persistent cache is a BoltDB file that includes tuples encrypted by a generated encryption key"_

### Cache Encryption Primitives

**NaCl `secretbox` (XSalsa20 + Poly1305) — Recommended for cache entries**

`golang.org/x/crypto/nacl/secretbox` provides authenticated symmetric encryption:
- `secretbox.Seal(nonce[:], plaintext, &nonce, &key)` — encrypt + authenticate
- `secretbox.Open(nil, ciphertext[24:], &nonce, &key)` — decrypt + verify
- 24-byte random nonce (prepended to ciphertext); negligible collision probability
- `Overhead = 16` bytes (Poly1305 MAC)
- Pure Go, no CGO — preserves Project Vault's static binary constraint

Pattern: store `nonce || ciphertext` as the bbolt value bytes.

_Source: pkg.go.dev/golang.org/x/crypto/nacl/secretbox — "XSalsa20 and Poly1305 to encrypt and authenticate messages"_

**Argon2id — For passphrase-derived cache keys (human interactive sessions)**

`golang.org/x/crypto/argon2.IDKey(password, salt, time, memory, threads, keyLen)` derives a 32-byte cache encryption key from a passphrase.

RFC 9106 recommended parameters for interactive use:
- `time=1, memory=64*1024` (64 MB), `threads=4`, `keyLen=32`

Used when the machine token is not available (human interactive session, `--passphrase` flag on `vault cache unlock`).

_Source: pkg.go.dev/golang.org/x/crypto/argon2 — "Argon2id is side-channel resistant and provides better brute-force cost savings"_

### XDG Base Directory Paths

`github.com/adrg/xdg` implements the XDG Base Directory Specification and Windows Known Folders:

| Purpose | Path (Linux) | Windows | macOS |
|---------|-------------|---------|-------|
| Config | `~/.config/project-vault/` | `%APPDATA%\project-vault\` | `~/Library/Application Support/project-vault/` |
| Cache | `~/.cache/project-vault/` | `%LOCALAPPDATA%\project-vault\` | `~/Library/Caches/project-vault/` |
| State | `~/.local/state/project-vault/` | `%LOCALAPPDATA%\project-vault\` | `~/Library/Application Support/project-vault/` |

Usage:
```go
cachePath, _ := xdg.CacheFile("project-vault/cache.db")
configPath, _ := xdg.ConfigFile("project-vault/config.yaml")
```

_Source: pkg.go.dev/github.com/adrg/xdg — XDG Base Directory implementation; `CacheFile`, `ConfigFile`, `StateFile`_

### Technology Comparison Matrix

| Concern | Recommended | Alternative | Rationale |
|---------|-------------|-------------|-----------|
| Machine auth (v1) | `mvt_` token + short-lived JWT exchange | Long-lived static token | Matches Infisical Universal Auth; periodic renewal solves secret zero |
| Machine auth (v1.2+) | OIDC JWT (GitHub/GitLab/K8s native) | Static token in CI env | No long-lived credential; IdP-issued, short TTL |
| OS token storage | `99designs/keyring` | Plain file | Uniform API; uses OS-native secure store on workstations |
| Cache storage | bbolt (BoltDB) | SQLite, flat files | Pure Go, embedded, ACID, Vault-proven, single file |
| Cache encryption | NaCl secretbox | AES-GCM | Simpler API, authenticated, pure Go, nonce-based |
| Key derivation (human) | Argon2id | bcrypt, scrypt | RFC 9106 winner; better memory-hardness |
| Path resolution | `adrg/xdg` | Hardcoded `~/.config` | Cross-platform; respects `XDG_*` env overrides |

---

## Integration Patterns Analysis

### Machine Auth Flows

**Flow A — CLI Interactive (Developer Workstation)**

```
1. User runs: vault login
2. CLI prompts for server URL + credentials (username/password or SSO)
3. Server returns short-lived JWT access token
4. CLI stores token in OS keyring via keyring.Set("token:{serverURL}", token)
5. Subsequent CLI commands:
   a. Read token from keyring
   b. If token expired or missing → auto-re-auth prompt
   c. Use token as Bearer in API requests
```

**Flow B — Machine Token (CI/CD Pipeline, Automated Process)**

```
1. Operator creates machine identity in Project Vault UI
   → Receives: identity_id (public) + mvt_{token} (secret, one-time display)
2. CI pipeline stores mvt_{token} as CI secret variable (e.g., VAULT_TOKEN)
3. At pipeline runtime:
   a. vault login --method=token --token=$VAULT_TOKEN
   b. Server validates HMAC-SHA256(token, serverSecret) against stored hash
   c. Returns short-lived JWT access token (1h TTL)
4. vault run -- <command> injects secrets as env vars using JWT
5. JWT auto-refreshed by CLI before expiry (silent renewal)
```

**Flow C — OIDC Platform Auth (CI/CD, v1.2+)**

```
1. Operator configures OIDC Auth method with: OIDC Discovery URL, issuer, subject glob
2. At pipeline runtime (e.g., GitHub Actions):
   a. Runner requests OIDC JWT from GitHub (automatic, no stored credential)
   b. CLI submits JWT to POST /api/v1/auth/oidc/login
   c. Server validates JWT via OIDC Discovery public key
   d. Returns short-lived access token
3. Zero long-lived credentials in CI environment
```

### Token Lifecycle & Renewal

Based on Infisical Universal Auth periodic token pattern:

```
Initial auth:
  mvt_{token} + identity_id → POST /api/v1/auth/token → {access_token, expires_at}

Renewal (before expiry):
  access_token → POST /api/v1/auth/renew → {access_token, expires_at (extended)}

Expiry:
  If renewal fails (server unreachable, token revoked):
    → CLI falls back to offline cache (if enabled and fresh)
    → Otherwise: error with actionable message

Revocation:
  DELETE /api/v1/auth/token (explicit logout)
  → Server marks jti in revoked_tokens table (per RBAC research)
  → CLI removes token from keyring
```

_Source: infisical.com/docs/documentation/platform/identities/universal-auth — "The token can be renewed any number of times, each time for the same period, with no maximum lifetime"_

### CLI Token Storage Pattern

Priority order for token resolution (highest → lowest):

```
1. VAULT_TOKEN env var          → CI/CD machines, overrides everything
2. --token flag                 → explicit per-command override
3. OS keyring                   → interactive human sessions (developer workstations)
4. ~/.config/project-vault/token (chmod 0600) → headless servers, containers without keyring
5. Error: not authenticated     → prompt for login
```

Keyring item key format: `"token:{sha256(serverURL)}"` — supports multiple servers on same workstation without collision.

Headless fallback file storage:
```
~/.config/project-vault/
    config.yaml          # server URL, default project, etc.
    token                # raw JWT access token, chmod 0600, no encryption (OS-level protection)
```

### Offline Cache Read/Write Pattern

```
CLI request for secret at path "/myapp/DATABASE_URL":

1. Check offline cache (bbolt):
   bucket="secrets", key="{projectID}:{env}:{path}"
   → cache hit + not expired → return cached value (zero network)
   → cache miss or expired → proceed to step 2

2. API request to server:
   GET /api/v1/secrets/{path} with Bearer token
   → 200: write to cache with TTL = min(X-Cache-TTL header, local_max_ttl)
   → 401: token expired → attempt renewal → retry
   → 503 / network error:
     → if stale cache entry exists → return with warning: "[stale: last updated Xs ago]"
     → no cache → hard error

3. Cache write:
   key  = HMAC-SHA256(projectID + env + path, cacheKey)
   value = secretbox.Seal(nonce, JSON(CacheEntry), &nonce, &cacheKey)
   stored as: bucket[key] = nonce || ciphertext
```

`CacheEntry` structure:
```go
type CacheEntry struct {
    Value     string    `json:"value"`
    FetchedAt time.Time `json:"fetched_at"`
    ExpiresAt time.Time `json:"expires_at"`
    SecretID  string    `json:"secret_id"`   // server-side version ID
    Stale     bool      `json:"stale"`
}
```

_Source: developer.hashicorp.com/vault/docs/agent-and-proxy/agent/caching/persistent-caches — "BoltDB file that includes tuples encrypted by a generated encryption key. The encrypted tuples include the Vault token used to retrieve secrets, leases for tokens/secrets, and secret values."_

### Cache Invalidation Patterns

**Time-based (TTL):** Each `CacheEntry` has `ExpiresAt`. Expired entries are served as stale with warning, not hard errors. Background goroutine sweeps expired entries every 5 minutes (`bbolt.Batch` delete).

**Server-push (webhook, v1.1+):** Server sends `POST /cache/invalidate` with `{projectID, path, reason}` to a registered callback URL. CLI agent (long-running `vault agent` process) listens on local HTTP port and evicts matching cache entries on receipt.

**Explicit invalidation:**
```
vault cache --clear                     # wipe all
vault cache --clear --project=myapp     # wipe project
vault cache --clear --path=/myapp/DB_*  # glob pattern
```

**Rotation event invalidation:** After a rotation completes (rotation plugin system from prior research), server sets `X-Cache-Invalidate: {path}` header on next fetch. CLI agent re-fetches and re-caches immediately.

**Version-based (SecretID comparison):** `CacheEntry.SecretID` is compared against the `X-Secret-Version` header on every online response. Mismatch triggers immediate re-cache even if TTL has not expired.

_Source: developer.hashicorp.com/vault/docs/agent-and-proxy/agent/caching — "agent evicts cache entries upon secret expirations and upon intercepting revocation requests… /agent/v1/cache-clear endpoint to manually evict cache entries"_

### CI/CD Agent Pattern

For CI/CD pipelines, the pattern is stateless (no keyring, no persistent cache):

```bash
# GitHub Actions example
- name: Get secrets
  env:
    VAULT_TOKEN: ${{ secrets.VAULT_TOKEN }}
    VAULT_ADDR: https://vault.internal
  run: |
    eval $(vault export --project=myapp --env=prod --format=env)
    # or: vault run --no-cache -- npm run deploy
```

Key decisions:
- `VAULT_TOKEN` injected by CI platform (GitHub Secrets, GitLab CI Variables)
- `--no-cache` flag disables cache for ephemeral runners (no persistent filesystem)
- Short-lived JWT access token obtained at step start, discarded at end
- `VAULT_DISABLE_UPDATE_CHECK=true` for faster startup (mirrors Infisical's `INFISICAL_DISABLE_UPDATE_CHECK`)

---

## Architectural Patterns and Design

### Machine Identity Model

Project Vault machine identities map to the existing RBAC model with these properties:

```
MachineIdentity {
    id          UUID            // public identity ID (safe to store in config)
    name        string          // human-readable label
    project_id  UUID            // project scope (from RBAC research: no Org Admin for machines in v1)
    role        string          // "viewer" | "member" | "admin" | "owner"
    token_hash  string          // HMAC-SHA256(mvt_{token}, serverSecret) — never plaintext
    token_prefix string         // "mvt_" prefix for identification
    num_uses    int             // 0 = unlimited, >0 = use-limited bootstrap token
    expires_at  TIMESTAMPTZ     // null = no expiry for long-lived machine tokens
    last_used_at TIMESTAMPTZ
    created_by  UUID            // user who created the identity
    is_active   bool
}
```

This is an extension of the `machine_tokens` table from RBAC research, adding `num_uses`, `expires_at`, and `last_used_at` for the Universal Auth pattern.

### Auth Flow State Machine

```
[unauthenticated]
    → VAULT_TOKEN present → [token_exchange] → [authenticated]
    → login command → [interactive_auth] → [authenticated]

[authenticated]
    → token valid → [serving requests]
    → token expiring (< 10% TTL left) → [renewing]
        → renewal success → [serving requests]
        → renewal failure → [offline_mode] or [unauthenticated]
    → token revoked → [unauthenticated]

[offline_mode]
    → cache hit (not expired) → [serving cached]
    → cache hit (stale) → [serving stale with warning]
    → cache miss → [error: no offline data]
```

### Token Storage Architecture

```
vault login flow:

┌─────────────────────────────────────────────────────┐
│ Token Resolution (priority order)                    │
│                                                      │
│ 1. VAULT_TOKEN env var ──────────────────────► use   │
│ 2. --token flag ─────────────────────────────► use   │
│ 3. keyring.Get("token:{sha256(serverURL)}") ──► use  │
│ 4. ~/.config/project-vault/token (0600) ──────► use  │
│ 5. unauthenticated ──────────────────────────► login │
└─────────────────────────────────────────────────────┘

vault login stores token:

┌─────────────────────────────────────────────────────┐
│ keyring.AvailableBackends()                          │
│   → OS keyring available (macOS/Linux/Windows)?      │
│     Yes → keyring.Set("token:{serverURLHash}", jwt)  │
│     No  → write to ~/.config/project-vault/token     │
│           with os.Chmod(path, 0600)                  │
└─────────────────────────────────────────────────────┘
```

### Offline Cache Architecture

```
~/.cache/project-vault/
    cache.db              # bbolt database (chmod 0600)
    cache.db.lock         # (created by bbolt automatically)

cache.db buckets:
    "secrets"    → encrypted CacheEntry per secret path
    "metadata"   → cache config, last_sweep, version
    "tokens"     → encrypted access tokens (for offline re-auth from persistent token)

Key structure: HMAC-SHA256(serverURL + projectID + env + secretPath, cacheKey)
  → 32-byte opaque key (no plaintext path info in bbolt key)

Value structure: nonce[24] || secretbox_ciphertext
  → decrypts to JSON(CacheEntry)

Cache key derivation:
  For machine tokens: cacheKey = HMAC-SHA256(mvt_{token}, "vault-cache-key")
  For human sessions: cacheKey = Argon2id(passphrase, salt, time=1, mem=64MB, threads=4, keyLen=32)
    where salt = random 32 bytes stored in "metadata" bucket
```

### Cache Encryption Design

```go
// internal/cache/crypto.go

// DeriveKeyFromToken derives a deterministic 32-byte cache key from a machine token.
// The same token always produces the same key — no separate key storage needed.
func DeriveKeyFromToken(token string) [32]byte {
    mac := hmac.New(sha256.New, []byte(token))
    mac.Write([]byte("vault-cache-key-v1"))
    var key [32]byte
    copy(key[:], mac.Sum(nil))
    return key
}

// EncryptEntry encrypts a CacheEntry value for storage in bbolt.
func EncryptEntry(value []byte, key [32]byte) ([]byte, error) {
    var nonce [24]byte
    if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
        return nil, err
    }
    // nonce prepended to ciphertext
    return secretbox.Seal(nonce[:], value, &nonce, &key), nil
}

// DecryptEntry decrypts a bbolt value back to CacheEntry bytes.
func DecryptEntry(stored []byte, key [32]byte) ([]byte, error) {
    if len(stored) < 24 {
        return nil, errors.New("cache entry too short")
    }
    var nonce [24]byte
    copy(nonce[:], stored[:24])
    out, ok := secretbox.Open(nil, stored[24:], &nonce, &key)
    if !ok {
        return nil, errors.New("cache decryption failed: tampered or wrong key")
    }
    return out, nil
}
```

_Source: pkg.go.dev/golang.org/x/crypto/nacl/secretbox — "XSalsa20 and Poly1305 to encrypt and authenticate messages with secret-key cryptography"_

### Database Schema — Server Side

Extensions to `machine_tokens` table from RBAC research:

```sql
-- Extends machine_tokens from RBAC research
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS num_uses INTEGER DEFAULT 0;
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS use_count INTEGER DEFAULT 0;
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS token_type TEXT DEFAULT 'static';
  -- 'static' = long-lived mvt_ token
  -- 'oidc'   = OIDC-issued (v1.2+)

-- Short-lived JWT sessions issued to machine tokens
CREATE TABLE machine_sessions (
    id          TEXT PRIMARY KEY,        -- UUID, used as JWT jti
    token_id    TEXT NOT NULL REFERENCES machine_tokens(id),
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    renewed_at  TIMESTAMPTZ,
    renewal_count INTEGER DEFAULT 0,
    ip_address  TEXT,
    revoked     BOOLEAN DEFAULT false
);

CREATE INDEX idx_machine_sessions_token ON machine_sessions(token_id);
CREATE INDEX idx_machine_sessions_expires ON machine_sessions(expires_at)
    WHERE revoked = false;
```

### Security Architecture

**Secret zero mitigation:**
- `num_uses=1` on bootstrap machine token: after first successful auth, token is invalidated server-side
- Resulting JWT access token is self-renewable — CI pipeline never needs the `mvt_` token again until manual re-issue
- Mirrors Infisical's periodic token recommendation

**Cache confidentiality:**
- bbolt file: chmod 0600 (owner-only read/write)
- All values encrypted with NaCl secretbox — cache file readable as binary only
- Cache key derived from machine token: stealing the cache file without the token is useless
- Metadata bucket keys (HMAC-SHA256 of paths) leak no plaintext path information

**Token storage:**
- macOS Keychain / Linux GNOME Keyring / Windows CredMan: OS-enforced access control, survives reboot
- File fallback: chmod 0600, not encrypted (relies on OS-level user isolation)
- `VAULT_TOKEN` env var: process-level isolation only — warn user if running as root

**OIDC validation (v1.2+):**
- Server fetches IdP public key via OIDC Discovery on every login (or with 1h key cache)
- Validates: `iss`, `aud`, `sub` against configured patterns; `exp`/`nbf` clock skew ≤30s
- `alg:none` explicitly rejected (consistent with RBAC research JWT validation)

---

## Implementation Approaches

### Phase 1 — CLI Token Auth & Keyring (v1.0)

**Deliverables:**
- `vault login` command: interactive + `--method=token` for machine auth
- `vault logout` command: removes token from keyring + calls server revoke endpoint
- Token resolution chain: `VAULT_TOKEN` → `--token` → keyring → file → error
- `99designs/keyring` integration with `FileBackend` fallback for headless environments
- `machine_sessions` DB table + session issuance/renewal/revocation API endpoints
- `GET /api/v1/auth/session` — check current token validity + metadata
- `POST /api/v1/auth/renew` — renew access token
- `DELETE /api/v1/auth/session` — explicit logout (adds jti to `revoked_tokens`)
- Machine token `num_uses` enforcement middleware

### Phase 2 — Offline Cache (v1.1)

**Deliverables:**
- bbolt-backed `CacheStore` at `xdg.CacheHome/project-vault/cache.db`
- `EncryptEntry` / `DecryptEntry` using NaCl secretbox
- Cache-key derivation from machine token HMAC
- Cache TTL logic: `X-Cache-TTL` response header + local `cache_max_ttl` config
- Stale-serve with warning on network failure
- Background sweep goroutine (5-min interval, deletes expired entries)
- `vault cache --list` (show cached paths + TTL), `vault cache --clear` (full/partial wipe)
- `--no-cache` global flag for bypass
- `--offline` flag: serve from cache only, error if missing

### Phase 3 — OIDC / Platform Auth (v1.2+)

**Deliverables:**
- OIDC Auth method: server-side OIDC Discovery validation
- `vault login --method=oidc` with auto-detection of GitHub Actions / GitLab CI OIDC tokens
- `machine_tokens.token_type='oidc'` + OIDC claim binding stored per identity
- Server-push cache invalidation via webhook callback registration
- `--watch` mode: long-running CLI agent that monitors for secret changes and re-injects env vars

### Go Module Layout

```
internal/auth/
    token.go          // TokenResolver: priority chain + keyring + file fallback
    keyring.go        // keyring.Open wrapper; service="project-vault"
    session.go        // SessionClient: login, renew, revoke API calls
    oidc.go           // OIDC JWT validation (v1.2+)

internal/cache/
    store.go          // CacheStore: bbolt Open/Get/Set/Delete/Sweep
    crypto.go         // DeriveKeyFromToken, EncryptEntry, DecryptEntry
    entry.go          // CacheEntry struct + TTL helpers
    sweep.go          // Background expiry sweep goroutine

cmd/vault/
    login.go          // vault login command
    logout.go         // vault logout command
    run.go            // vault run -- <cmd>: inject secrets as env vars
    cache.go          // vault cache --list / --clear / --stats
    export.go         // vault export --format=env|json|dotenv
```

### Test Strategy

| Test Category | Coverage |
|---|---|
| Token resolution | Priority chain: env var wins over keyring wins over file; missing all → error |
| Keyring round-trip | Set+Get+Remove with `ArrayKeyring` mock (from keyring package test utilities) |
| Session renewal | Token near expiry → silent renewal; renewal failure → offline fallback |
| Cache encrypt/decrypt | NaCl round-trip; tampered ciphertext → error; wrong key → error |
| Cache TTL | Expired entry returns stale + flag; fresh entry returns directly |
| Cache miss + network fail | No entry + server unreachable → hard error with actionable message |
| `num_uses` enforcement | Token with `num_uses=1` rejects second login attempt |
| VAULT_TOKEN override | Env var bypasses keyring even if keyring has a different token |
| `--no-cache` flag | Bypass cache, always fetches from server |
| `--offline` flag | Serves from cache; hard error if cache miss |
| Concurrent cache access | bbolt read-only transaction allows concurrent reads; write serialized |

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Machine token leaked via env var in CI logs | High | Warn if `VAULT_TOKEN` detected in non-CI environment; mask in output |
| Cache file readable by other users on shared systems | High | chmod 0600 on creation; check permissions on open; warn if wrong |
| Cache key derived from stolen token | High | Stealing cache without token is useless (NaCl secretbox); short token TTL limits window |
| Token renewal failure causes production outage | High | Serve stale cache with warning; alert notification; configurable grace period |
| OS keyring unavailable on headless server | Medium | Graceful fallback to file; warn user about reduced security |
| bbolt file lock blocks two CLI processes simultaneously | Medium | `bolt.Options{Timeout: 1s}` returns error on lock failure; CLI shows clear message |
| `num_uses=1` token consumed by attacker before operator | High | Short `expires_at` window + IP allowlist on machine token (v1.1+) |
| OIDC audience mismatch allows cross-tenant access | High | Strict glob validation; recommend non-glob hardcoded subject; audit log on OIDC auth |
| Stale cache serves revoked secret | Medium | SecretID version comparison on every online response; rotation events trigger cache wipe |

---

## Research Conclusion

### Summary of Key Technical Findings

**Technology Stack (Step 2):** Two authentication paradigms cover all Project Vault use cases: (1) `mvt_` token exchange → short-lived JWT (Universal Auth pattern, for CI/CD and long-running agents), and (2) OIDC JWT → short-lived JWT (for platform-native CI environments in v1.2+). OS credential storage uses `99designs/keyring` (6 backends, uniform Go interface) with graceful fallback to chmod 0600 file. Offline cache uses bbolt (Vault Agent's own proven choice) + NaCl secretbox authenticated encryption + Argon2id for human passphrase key derivation.

**Integration Patterns (Step 3):** Token resolution follows a strict priority chain (`VAULT_TOKEN` env → `--token` flag → keyring → file → error), enabling both CI/CD (stateless, env-based) and interactive (stateful, keyring-based) use cases from the same binary. Periodic token renewal solves "secret zero": bootstrap with one-use Client Secret, then self-renew the resulting JWT indefinitely. Cache read/write follows Vault Agent's pattern: serve fresh from cache → fetch on miss/expiry → serve stale with warning on network failure → hard error on total cache miss.

**Architectural Patterns (Step 4):** Machine identity = extension of RBAC `machine_tokens` table with `num_uses`, `use_count`, `expires_at`, `last_used_at`. Short-lived JWT sessions issued per authentication stored in `machine_sessions` table. Cache: bbolt at XDG cache dir, keys are HMAC-SHA256 of path (no plaintext leakage), values are `nonce||secretbox(CacheEntry)`. Cache key derived deterministically from machine token via HMAC — no separate key management.

**Implementation Strategy (Step 5):** Three phases — Phase 1 (v1.0): token auth + keyring + machine session API. Phase 2 (v1.1): offline bbolt cache + stale-serve + TTL + background sweep. Phase 3 (v1.2+): OIDC platform auth + server-push cache invalidation + `--watch` mode.

---

### Strategic Impact Assessment

This research directly unblocks two critical PRD capabilities: machine identity authentication for CI/CD pipelines and offline/disconnected operation for developer workstations and edge deployments. The architecture is incrementally deliverable (Phase 1 alone provides full CI/CD support), operationally safe (stale-serve prevents production outages on transient network failures), and security-sound (encrypted cache, HMAC-keyed entries, OS keyring integration, num_uses bootstrap).

The design is intentionally compatible with the `mvt_` prefix token protocol from RBAC research, the AES-256-GCM envelope encryption from crypto research, and the rotation event system from rotation plugin research — forming a cohesive auth + cache + rotation + audit stack.

---

### Next Steps

1. **ADR-10:** Token storage priority chain — document the `VAULT_TOKEN` → keyring → file fallback order and the CI vs interactive behavioral difference.
2. **ADR-11:** Offline cache encryption key derivation — document HMAC-from-token for machine contexts vs Argon2id for human passphrase contexts.
3. **ADR-12:** Cache stale-serve policy — document the default grace period (configurable, default: serve stale for up to 1h after TTL expiry on network failure) vs strict mode (`--no-stale` flag).
4. **Sprint execution:** Start Phase 1 — token resolution chain, `99designs/keyring` integration, `machine_sessions` table, login/logout/renew commands.
5. **Spec creation:** Create `specs/machine-user-auth-offline-caching.md` from this research as operational reference.

---

**Research Completion Date:** 2026-04-09
**Research Period:** Comprehensive current-state analysis (Steps 1–6 complete)
**Document Scope:** Machine User Auth & Offline Caching for Project Vault v1
**Source Verification:** All findings cited against live documentation (Infisical docs, HashiCorp Vault docs, pkg.go.dev: 99designs/keyring, go.etcd.io/bbolt, golang.org/x/crypto/nacl/secretbox, golang.org/x/crypto/argon2, github.com/adrg/xdg)
**Confidence Level:** High — based on multiple authoritative sources and production reference implementations

_This research document serves as the authoritative technical reference for machine user authentication and offline caching decisions in Project Vault._
