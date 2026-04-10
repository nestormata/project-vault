# Machine User Auth & Offline Caching — Project Vault

**Version:** 1.0  
**Date:** 2026-04-09  
**Status:** Research-complete; pending ADR sign-off on three open decisions (ADR-10, ADR-11, ADR-12)  
**Source:** Technical research document `_bmad-output/planning-artifacts/research/technical-machine-user-auth-offline-caching-research-2026-04-09.md`

---

## Overview

Project Vault supports three machine authentication flows: (1) `mvt_` token exchange → short-lived JWT (Universal Auth, for CI/CD and long-running agents), (2) interactive human login → OS keyring token storage (developer workstations), and (3) OIDC JWT → short-lived JWT (platform-native CI, v1.2+). The CLI token resolution chain strictly prioritizes `VAULT_TOKEN` env var for CI/CD and OS keyring for interactive use. Offline caching uses `bbolt` (the same engine as HashiCorp Vault Agent's persistent cache) with NaCl `secretbox` per-entry encryption. The cache key is derived deterministically from the machine token via HMAC-SHA256 — no separate key management required.

---

## Authentication Flows

### Flow A — Machine Token (CI/CD, Automated Processes)

```
1. Operator creates machine identity in Project Vault UI
   → Receives: identity_id (public) + mvt_{token} (private, one-time display)

2. Operator stores mvt_{token} as CI secret (e.g., VAULT_TOKEN in GitHub Secrets)

3. At pipeline runtime:
   vault login --method=token --token=$VAULT_TOKEN
   → Server verifies HMAC-SHA256(token, serverSecret) against stored hash
   → Returns short-lived JWT access token (1h TTL)

4. vault run -- <command>  injects secrets as env vars using JWT

5. JWT auto-refreshed by CLI before expiry (silent periodic renewal)
```

`num_uses=1` on the bootstrap `mvt_` token solves "secret zero": token is consumed after first successful auth. The resulting JWT is self-renewable indefinitely — CI never needs the `mvt_` token again until manual re-issue.

### Flow B — Interactive CLI (Developer Workstation)

```
1. vault login  (prompts for server URL + credentials)
2. Server issues short-lived JWT access token
3. CLI stores token in OS keyring: keyring.Set("token:{sha256(serverURL)}", token)
4. Subsequent CLI commands read from keyring; re-auth prompt on expiry
```

### Flow C — OIDC Platform Auth (v1.2+)

```
1. Operator configures OIDC Auth method: OIDC Discovery URL, issuer, subject glob
2. At pipeline runtime (e.g., GitHub Actions):
   → Runner requests OIDC JWT from platform automatically
   → vault login --method=oidc submits JWT to server
   → Server validates via OIDC Discovery public key
   → Returns short-lived access token
3. Zero long-lived credentials in CI environment
```

---

## Token Resolution Priority Chain

```
1. VAULT_TOKEN env var          ← CI/CD; highest priority; overrides everything
2. --token flag                 ← explicit per-command override
3. OS keyring                   ← interactive human sessions
4. ~/.config/project-vault/token (chmod 0600) ← headless servers, containers
5. Error → prompt for login
```

Keyring item key format: `"token:{sha256(serverURL)}"` — supports multiple servers on the same workstation without collision.

```go
// internal/auth/token.go
func ResolveToken(serverURL string) (string, error) {
    if t := os.Getenv("VAULT_TOKEN"); t != "" {
        return t, nil
    }
    // check --token flag from cobra context...
    kr, _ := keyring.Open(keyring.Config{ServiceName: "project-vault"})
    if item, err := kr.Get("token:" + sha256Short(serverURL)); err == nil {
        return string(item.Data), nil
    }
    if t, err := readFileToken(); err == nil {
        return t, nil
    }
    return "", ErrNotAuthenticated
}
```

---

## OS Keyring Integration

**Library:** `github.com/99designs/keyring` v1.2.2

```go
go get github.com/99designs/keyring
```

Supported backends (automatically selected by availability):

| Backend | OS | Store |
|---------|-----|-------|
| `KeychainBackend` | macOS | Keychain |
| `SecretServiceBackend` | Linux | GNOME Keyring / KDE KWallet (D-Bus) |
| `KWalletBackend` | Linux | KDE KWallet (direct) |
| `KeyCtlBackend` | Linux | Linux kernel keyctl |
| `WinCredBackend` | Windows | Windows Credential Manager |
| `FileBackend` | All | AES-encrypted file (passphrase-prompted) |
| `PassBackend` | All | `pass` (GPG-based) |

```go
kr, err := keyring.Open(keyring.Config{ServiceName: "project-vault"})
// Falls through available backends; FileBackend as final fallback on headless systems

kr.Set(keyring.Item{Key: "token:" + serverURLHash, Data: []byte(token)})
item, err := kr.Get("token:" + serverURLHash)
kr.Remove("token:" + serverURLHash) // vault logout
```

`keyring.AvailableBackends()` returns supported backends on current OS — used to warn users on headless servers that only `FileBackend` is available.

---

## Token Lifecycle & Renewal

```
Initial auth:
  mvt_{token} + identity_id → POST /api/v1/auth/token
    → {access_token (JWT, 1h TTL), expires_at}

Renewal (triggered when < 10% TTL remaining):
  access_token → POST /api/v1/auth/renew
    → {access_token (extended TTL), expires_at}

Expiry:
  If renewal fails (server unreachable, token revoked):
    → Serve from offline cache if enabled and within grace period
    → Otherwise: error with actionable message

Explicit revocation:
  DELETE /api/v1/auth/session
    → Server adds jti to revoked_tokens (RBAC research table)
    → CLI removes token from keyring
```

---

## Offline Cache

### Storage

**Library:** `go.etcd.io/bbolt` (etcd-maintained Bolt fork)

```go
go get go.etcd.io/bbolt
```

Cache file location (XDG Base Directory Spec via `github.com/adrg/xdg`):

| OS | Path |
|----|------|
| Linux | `~/.cache/project-vault/cache.db` |
| macOS | `~/Library/Caches/project-vault/cache.db` |
| Windows | `%LOCALAPPDATA%\project-vault\cache.db` |

```go
db, err := bbolt.Open(cachePath, 0600, &bbolt.Options{Timeout: 1 * time.Second})
// Timeout prevents hang if cache already open by another process
```

bbolt file permissions: `0600` (owner-only read/write). `bbolt.Options{Timeout}` returns error instead of blocking if another process has the file locked.

### Encryption

**Algorithm:** NaCl `secretbox` (XSalsa20 + Poly1305)

```go
go get golang.org/x/crypto/nacl/secretbox
```

Per-entry encryption:

```go
// internal/cache/crypto.go

// DeriveKeyFromToken derives a deterministic 32-byte cache key from a machine token.
// Same token always → same key. No separate key storage needed.
func DeriveKeyFromToken(token string) [32]byte {
    mac := hmac.New(sha256.New, []byte(token))
    mac.Write([]byte("vault-cache-key-v1"))
    var key [32]byte
    copy(key[:], mac.Sum(nil))
    return key
}

func EncryptEntry(plaintext []byte, key [32]byte) ([]byte, error) {
    var nonce [24]byte
    io.ReadFull(rand.Reader, nonce[:])
    return secretbox.Seal(nonce[:], plaintext, &nonce, &key), nil
    // stored format: nonce[24] || ciphertext
}

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

**For human passphrase-protected sessions** (`--passphrase` flag on `vault cache unlock`):

```go
// Argon2id key derivation (RFC 9106 interactive parameters)
key := argon2.IDKey(passphrase, salt, 1, 64*1024, 4, 32)
// time=1, memory=64MB, threads=4, keyLen=32
// salt: random 32 bytes stored in "metadata" bucket
```

### Cache Key Design

```
bbolt bucket: "secrets"
key  = HMAC-SHA256(serverURL + projectID + env + secretPath, cacheKey)
     → 32-byte opaque key (no plaintext path info in the database file)
value = EncryptEntry(JSON(CacheEntry), cacheKey)
      → nonce[24] || secretbox_ciphertext
```

### Cache Entry Structure

```go
type CacheEntry struct {
    Value     string    `json:"value"`
    FetchedAt time.Time `json:"fetched_at"`
    ExpiresAt time.Time `json:"expires_at"`
    SecretID  string    `json:"secret_id"`   // server-side version ID for version-based invalidation
    Stale     bool      `json:"stale"`
}
```

### Cache Read/Write Flow

```
CLI request for secret at /myapp/DATABASE_URL:

1. Check bbolt cache (bucket="secrets", key=HMAC(path)):
   → hit + not expired    → return value (zero network, zero auth)
   → hit + expired/stale  → proceed to step 2 (prefer fresh)
   → miss                 → proceed to step 2

2. API request: GET /api/v1/secrets/{path} (Bearer token)
   → 200: cache write with TTL = min(X-Cache-TTL header, local_max_ttl)
   → 401: token expired → attempt renewal → retry
   → 503 / network error:
       → stale entry exists → return value + warning "[stale: last updated Xs ago]"
       → no cache           → error with actionable message

3. Cache write: EncryptEntry(CacheEntry) → bbolt.Put(key, nonce||ciphertext)
```

### Cache TTL

- Server sends `X-Cache-TTL: <seconds>` response header
- Local config sets `cache_max_ttl` (default: 5 minutes interactive, 15 minutes CI agents)
- Effective TTL = `min(X-Cache-TTL, cache_max_ttl)`
- Stale-serve grace period (ADR-12): expired entries are served with warning for up to 1h on network failure (configurable; `--no-stale` for strict mode)

### Cache Invalidation

| Method | Trigger | Action |
|--------|---------|--------|
| Time-based (TTL) | `CacheEntry.ExpiresAt` passed | Serve stale + warning; background sweep deletes |
| Version-based | `X-Secret-Version` header mismatch on online response | Immediate re-fetch + re-cache |
| Rotation event | Post-rotation: server sets `X-Cache-Invalidate: {path}` | Re-fetch on next request |
| Explicit CLI | `vault cache --clear [--path=glob]` | Delete matching entries from bbolt |
| Server-push webhook (v1.1+) | `POST /cache/invalidate` callback from server | CLI agent evicts matching entries |

Background sweep goroutine runs every 5 minutes, deletes expired entries via `bbolt.Batch`.

---

## CLI Commands

```bash
# Authentication
vault login [--method=token|password|oidc] [--token=mvt_...]
vault logout

# Secret retrieval
vault run --project=myapp --env=prod -- npm start    # inject as env vars
vault export --project=myapp --env=prod --format=env # print export statements
vault get /myapp/DATABASE_URL                        # get single secret

# Cache management
vault cache --list [--project=myapp]      # show cached paths + TTL
vault cache --clear [--path=/myapp/DB_*]  # wipe all or matching
vault cache --stats                       # hit rate, entry count, size

# Flags
--no-cache       # bypass cache; always fetch from server
--offline        # serve from cache only; error on miss
--no-stale       # strict TTL; error instead of serving stale
```

---

## CI/CD Pattern

```yaml
# GitHub Actions example
- name: Deploy with Project Vault secrets
  env:
    VAULT_TOKEN: ${{ secrets.VAULT_TOKEN }}
    VAULT_ADDR: https://vault.internal
  run: |
    eval $(vault export --project=myapp --env=prod --format=env --no-cache)
    npm run deploy
```

Key decisions for CI:
- `VAULT_TOKEN` injected by CI platform (no keyring, no persistent cache)
- `--no-cache` flag disables cache for ephemeral runners (no persistent filesystem)
- JWT access token obtained at step start, discarded at end
- `num_uses=1` on bootstrap `mvt_` token for highest-security pipelines

---

## Database Schema (Server-side)

Extensions to `machine_tokens` from RBAC research:

```sql
-- Additions to machine_tokens table
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS num_uses     INTEGER   DEFAULT 0;
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS use_count    INTEGER   DEFAULT 0;
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ;
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE machine_tokens ADD COLUMN IF NOT EXISTS token_type   TEXT DEFAULT 'static';
  -- 'static' = long-lived mvt_ token, 'oidc' = OIDC-issued (v1.2+)

-- Short-lived JWT sessions issued to machine tokens
CREATE TABLE machine_sessions (
    id            TEXT PRIMARY KEY,              -- UUID; used as JWT jti
    token_id      TEXT NOT NULL REFERENCES machine_tokens(id),
    issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    renewed_at    TIMESTAMPTZ,
    renewal_count INTEGER DEFAULT 0,
    ip_address    TEXT,
    revoked       BOOLEAN DEFAULT false
);
CREATE INDEX idx_machine_sessions_token   ON machine_sessions(token_id);
CREATE INDEX idx_machine_sessions_expires ON machine_sessions(expires_at)
    WHERE revoked = false;
```

---

## Security Architecture

**Secret zero:** `num_uses=1` on bootstrap token — consumed after first auth. JWT self-renews indefinitely. A revocation/expiry event requires manual re-issue of the `mvt_` token.

**Cache confidentiality:**
- bbolt file: `chmod 0600`
- All values encrypted with NaCl secretbox — file is opaque binary without the key
- Cache key derived from machine token: stealing the cache file without the token is useless
- bbolt bucket keys (HMAC-SHA256 of paths) leak no plaintext path information

**Token storage:**
- macOS Keychain / Linux GNOME Keyring / Windows CredMan: OS-enforced access control
- File fallback: `chmod 0600`, relying on OS-level user isolation
- `VAULT_TOKEN` env var: warn if running as root (process-level isolation only)

**OIDC validation (v1.2+):**
- Fetch IdP public key via OIDC Discovery on every login (1h key cache)
- Validate: `iss`, `aud`, `sub` against configured patterns; `exp`/`nbf` clock skew ≤30s
- `alg:none` explicitly rejected (consistent with JWT validation in RBAC research)

---

## Package Layout

```
internal/auth/
    token.go       # TokenResolver: priority chain, keyring, file fallback
    keyring.go     # keyring.Open wrapper; service="project-vault"
    session.go     # SessionClient: login, renew, revoke API calls
    oidc.go        # OIDC JWT validation (v1.2+)

internal/cache/
    store.go       # CacheStore: bbolt Open/Get/Set/Delete/Sweep
    crypto.go      # DeriveKeyFromToken, EncryptEntry, DecryptEntry
    entry.go       # CacheEntry struct + TTL helpers
    sweep.go       # Background expiry sweep goroutine

cmd/vault/
    login.go       # vault login command
    logout.go      # vault logout command
    run.go         # vault run -- <cmd>: inject secrets as env vars
    cache.go       # vault cache --list / --clear / --stats
    export.go      # vault export --format=env|json|dotenv
```

---

## Go Module Dependencies

```go
require (
    github.com/99designs/keyring       v1.2.2  // OS keyring (7 backends)
    go.etcd.io/bbolt                   v1.x.x  // offline cache storage
    golang.org/x/crypto                vX.x.x  // nacl/secretbox + argon2 (already present)
    github.com/adrg/xdg                v0.4.0  // XDG base directory paths
)
```

---

## Phased Delivery

| Phase | Version | Deliverables |
|-------|---------|-------------|
| 1 — Token Auth & Keyring | v1.0 | Token priority chain, `99designs/keyring`, machine session API, `vault login/logout`, `num_uses` enforcement |
| 2 — Offline Cache | v1.1 | bbolt `CacheStore`, NaCl encryption, TTL + stale-serve, background sweep, `vault cache` commands |
| 3 — OIDC Auth | v1.2+ | OIDC Discovery validation, platform-native CI auto-detection, server-push cache invalidation, `--watch` mode |

---

## Open ADRs

| ADR | Decision needed | Recommendation |
|-----|----------------|----------------|
| ADR-10 | Token storage priority chain — document CI vs interactive behavioral difference | `VAULT_TOKEN` env → `--token` → keyring → file → error; CI uses env var; interactive uses keyring; both handled by same binary |
| ADR-11 | Offline cache encryption key derivation — HMAC-from-token vs Argon2id | HMAC-SHA256(token, "vault-cache-key-v1") for machine contexts (no passphrase needed); Argon2id for human passphrase-protected cache unlock |
| ADR-12 | Cache stale-serve policy — grace period duration and opt-out | Default: serve stale for up to 1h after TTL expiry on network failure; strict mode via `--no-stale` flag |

---

## ADR Numbering Context

| Research Area | ADRs |
|--------------|------|
| Cryptographic Architecture | ADR-01 – ADR-03 |
| RBAC / Permission Architecture | ADR-04 – ADR-06 |
| Rotation Plugin Architecture | ADR-07 – ADR-09 |
| Machine User Auth & Offline Caching | ADR-10 – ADR-12 |
| Service Health Monitoring | ADR-13 – ADR-15 |
