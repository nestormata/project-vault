# Cryptographic Architecture — Project Vault

**Version:** 1.1  
**Date:** 2026-06-24  
**Status:** Research-complete; v1 implementation spec available for vault init/seal  
**Source:** Technical research document `_bmad-output/planning-artifacts/research/technical-cryptographic-architecture-secrets-vault-research-2026-04-08.md`

> **v1 implementation (Node.js / Story 1.5):** The running codebase uses PostgreSQL + `packages/crypto` (AES-256-GCM, HKDF, Argon2id) with manual seal/unseal — not Shamir/Raft from this research doc. See **[specs/vault-initialization-and-key-management.md](vault-initialization-and-key-management.md)** for operational details: custody models (passphrase, envelope, file), API endpoints, Docker wiring, and operator runbook.

---

## Overview

This spec captures the cryptographic architecture decisions for Project Vault — a self-hosted, open-core secrets and project infrastructure management platform. Every recommendation here is grounded in production evidence from HashiCorp Vault, OpenBao, Infisical, and Bitwarden, cross-validated against OWASP, NIST, and live CVE advisories as of April 2026.

---

## Key Hierarchy

Four-layer envelope encryption model (non-negotiable):

```
Secret plaintext
    └── encrypted by DEK  (Data Encryption Key — random, unique per secret)
DEK
    └── encrypted by KEK  (Key Encryption Key / Master Key — one per vault)
KEK
    └── encrypted by Root Key (stored encrypted in barrier storage)
Root Key
    └── encrypted by Unseal Key (Shamir shares OR cloud KMS)
```

**Why per-secret DEKs:** A single master DEK exposes everything on one compromise. Per-secret DEKs limit blast radius to one entry and allow independent rotation. This matches Google Cloud KMS, HashiCorp Vault, and the age encryption spec.

---

## Ciphertext Envelope Format

Every encrypted value stored in the database must include this header:

```
[version: 1 byte]       ← format version; pins algorithm (not negotiation)
[algorithm_id: 1 byte]  ← 1=AES-256-GCM, 2=AES-256-GCM-SIV, 3=ChaCha20-Poly1305
[key_version: 4 bytes]  ← identifies which DEK/KEK version encrypted this value
[nonce: 12 bytes]       ← random, per-encryption, CSPRNG
[ciphertext+tag: var]   ← GCM tag appended in combined mode
```

For KDF-derived keys (e.g., master password unlock):
```
[version][algorithm_id][kdf_id][kdf_params: var][salt: 32 bytes][nonce: 12 bytes][ciphertext+tag]
```

**Cryptographic agility rule:** `version` byte *declares* the algorithm — it is not a runtime negotiation flag. Old ciphertexts are decryptable via code paths keyed by `version`; new writes always use the current version. Increment `version`, never add a negotiation flag.

---

## Algorithm Selections

### Symmetric Encryption

| Algorithm | Use case | Status |
|---|---|---|
| AES-256-GCM | Default for all secret encryption | ✅ Primary |
| AES-256-GCM-SIV (RFC 8452) | Distributed deployments (nonce-misuse resistant) | 🔲 Open ADR |
| ChaCha20-Poly1305 | Non-AES-NI environments | ✅ Fallback |

**Nonce management (critical):**
- Always generate nonces from CSPRNG (`crypto/rand` in Go)
- Store nonce alongside ciphertext (in the envelope)
- Never use counter-based nonces without crash-durable counter state — a counter reset after restart under the same key is catastrophic
- Do NOT use AES-GCM with the same (key, nonce) pair twice — an attacker can recover `P1 XOR P2` and forge authenticated ciphertexts

### Key Derivation Function (KDF)

**Choice: Argon2id** — RFC 9106, OWASP #1 recommendation, Password Hashing Competition winner.

| Parameter | OWASP Minimum | Project Vault (Recommended) |
|---|---|---|
| Memory (m) | 19 MiB (m=19456) | **64 MiB (m=65536)** |
| Iterations (t) | 2 | **3** |
| Parallelism (p) | 1 | **4** |
| Salt | 16 bytes | **32 bytes** |

- Produces sub-1-second unlock on Docker hardware at these parameters (startup-time-only operation)
- PBKDF2: only if FIPS-140 compliance is a hard requirement
- scrypt: acceptable fallback; not preferred

**Go library:** `golang.org/x/crypto/argon2` — Go team maintained, constant-time, no CGo.

### Shamir's Secret Sharing (SSS)

**Do NOT use:**
- `sharks` crate (Rust) — **RUSTSEC-2024-0398** (unfixed): polynomial coefficients biased to [1,255] instead of [0,255]; secret recoverable by attacker with threshold shares. Maintainer unresponsive.
- Any GF(256) implementation using table lookups — cache-timing side channel (root cause of **CVE-2023-25000** in HashiCorp Vault, fixed in Vault 1.13.1).

**Use instead:**

| Language | Library | Notes |
|---|---|---|
| Go | `github.com/hashicorp/vault/shamir` ≥ v1.13.1 | Only production battle-tested Go SSS with CVE remediated |
| Rust | `blahaj` | Fork of `sharks` that fixes the range bias; recommended Rust SSS option |

**SSS implementation invariants:**
1. Polynomial coefficients must include 0 in the range
2. x-coordinates must be unique per share, chosen from CSPRNG
3. GF(256) multiplication must be constant-time (no table lookup)
4. Split the master key only once at initialization — repeated sharing of the same secret is dangerous

---

## Cryptographic Libraries

### Go (Primary Stack)

| Primitive | Library | Notes |
|---|---|---|
| AES-256-GCM | `crypto/aes` + `crypto/cipher` stdlib | What Vault/OpenBao use; no CGo |
| ChaCha20-Poly1305 | `golang.org/x/crypto/chacha20poly1305` | Go team maintained |
| Argon2id | `golang.org/x/crypto/argon2` | Go team maintained, constant-time |
| scrypt | `golang.org/x/crypto/scrypt` | Fallback KDF |
| SSS | `github.com/hashicorp/vault/shamir` ≥ v1.13.1 | Post-CVE-2023-25000 |
| CSPRNG | `crypto/rand` | Wraps `getrandom(2)` on Linux |
| FIPS path | OpenSSL-backed Go crypto (Red Hat guidance) | If FIPS-140 is a hard requirement |

### Rust (FFI / Plugin use only)

| Primitive | Library | Notes |
|---|---|---|
| AES-256-GCM | `aws-lc-rs` | FIPS 140-3 Level 1; adopted by rustls as default |
| AES-256-GCM (pure Rust) | `RustCrypto/aes-gcm` | NCC Group audited Feb 2020; no CGo |
| Argon2id | `argon2` crate (RustCrypto) | Pure Rust, actively maintained |
| SSS | `blahaj` | Fixed fork of `sharks` post-RUSTSEC-2024-0398 |
| **DO NOT USE** | `ring` | RUSTSEC-2025-0007 filed; maintenance concern; do not use for new projects |
| **DO NOT USE** | `sharks` | RUSTSEC-2024-0398 unfixed critical bias vulnerability |

---

## Seal / Unseal Architecture

### Default (v1): Shamir Manual Unseal

- Root key split into N shares with threshold T (default: 5 shares, 3 threshold — Vault's default)
- Human operators provide threshold shares at startup or after container restart
- Operational cost: manual unseal required after every Docker restart
- Security benefit: no dependency on external service; fully air-gap capable
- Key custody: each operator holds one share; shares stored offline (HSM, paper, encrypted USB)

### Opt-in (v1.1+): Cloud KMS Auto-Unseal

⚠️ **CRITICAL OPERATIONAL WARNING:** If the KMS key is permanently deleted, the cluster is **unrecoverable, even from backups**. Recovery keys (issued at KMS-unsealed initialization) **cannot** decrypt the root key — they are authorization-only tokens. This must be documented prominently in the product.

| KMS Provider | Auth (Docker self-hosted) | Notes |
|---|---|---|
| AWS KMS | IAM user keys via env vars; or EC2 instance profile (hop limit = 2) | AWS VPC Endpoint recommended for production |
| GCP Cloud KMS | Service account JSON via `GOOGLE_APPLICATION_CREDENTIALS` | GCP Private Service Connect for production |
| Azure Key Vault | Service principal via `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` | |

**Mitigations for KMS key deletion:**
- AWS Service Control Policy / GCP org policy blocking `kms:ScheduleKeyDeletion` / `kms:DisableKey`
- Multi-region key replication
- Quarterly test of unseal with recovery keys

### HSM / PKCS#11 Auto-Unseal (opt-in)

For high-security on-prem deployments without cloud KMS dependency.

```hcl
seal "pkcs11" {
  lib            = "/usr/lib/softhsm/libsofthsm2.so"
  token_label    = "vault-token"
  pin            = "1234"
  key_label      = "vault-hsm-key"
  hmac_key_label = "vault-hsm-hmac-key"
  mechanism      = "0x1087"   # CKM_AES_GCM
}
```

- SoftHSM2 for testing: `vegardit/docker-softhsm2-pkcs11-proxy` Docker image
- Go PKCS#11 wrapper: `miekg/pkcs11` (used by Bank-Vaults)
- Docker: requires `--device` for USB HSM passthrough, or network HSM client library mounted as volume
- Docker capability: `IPC_LOCK` required for mlock (prevents key pages from swapping to disk)

---

## Key Rotation

### Encryption Key Rotation (Automatic)

- NIST SP 800-38D recommends rotating AES-256-GCM keys before ~2³² encryption operations
- Monitor `vault.barrier.estimated_encryptions` metric; trigger auto-rotation before threshold
- Rotation produces a new key version added to the keyring; old versions retained for decryption
- New writes always use the current key version; old ciphertexts decryptable via `key_version` lookup

### Manual Rekey (Root Key / Unseal Shares)

- `vault operator rekey` / `bao operator rekey` — generates new root key and new unseal shares
- Safe to perform on live cluster (HA-aware); standby nodes receive upgrade key
- Perform after: suspected share compromise, operator departure, quarterly rotation policy

### Secret DEK Migration

- **Lazy migration (default):** Re-encrypt DEK to current key version on read; no scheduled downtime
- **Eager migration (scheduled):** Background sweep re-encrypts all DEKs; for post-compromise remediation
- `key_version` field in ciphertext envelope is what makes both strategies possible

---

## Storage Backend

### Default: Raft/BoltDB (Embedded, Zero External Dependencies)

```hcl
storage "raft" {
  path                   = "/vault/data"
  node_id                = "vault-1"
  performance_multiplier = 1      # production mode; default (0) is tuned for minimal servers
  snapshot_threshold     = 8192
  snapshot_interval      = "120s"
  max_entry_size         = 1048576  # 1 MiB
}
cluster_addr = "http://127.0.0.1:8201"
```

**BoltDB fragmentation gotcha:** Heavy write/delete workloads cause `.db` file growth with no self-compaction. At > 5–6 GB, offline compaction (`bolt compact`) is required (live leader must transfer leadership first). Mitigation: add a Prometheus storage size metric and a dashboard warning at 2 GB.

### Opt-in: PostgreSQL

- OpenBao v2.1.0 added transactional physical storage; PostgreSQL is the first backend to implement it
- All data stored as encrypted blobs (`openbao_kv_store` table) — PostgreSQL never sees plaintext
- Choose when: existing DBA team + backup infrastructure (pg_dump / WAL archiving) already in place

---

## Audit Log

> **⚠️ v1 implementation reality (Story 1.4+, 2026-06-27):** The running codebase does **NOT** use the hash-chained design below. v1 uses a **per-row keyed HMAC** (`HMAC-SHA256` over each row's canonical-JSON fields via `computeAuditHmac`, keyed by the vault audit key) with **no `prev_hash` linkage**; immutability is enforced by an append-only trigger (migration `0001`), not by a chain. See **[specs/audit-secureroute-and-platform-conventions.md](audit-secureroute-and-platform-conventions.md)** for the implemented model, the SecureRoute fail-closed same-transaction audit guarantee, and the audit event vocabulary. The hash chain below is the research design; adopting it (true prev-row chaining) is an intentional future change (Epic 8), not current behavior.

### Hash-Chained Tamper-Evident Log (PostgreSQL) — research design (not yet implemented)

```sql
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    event_time  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id    UUID NOT NULL,
    action      TEXT NOT NULL,
    resource    TEXT NOT NULL,
    resource_id UUID,
    metadata    JSONB,
    entry_hash  TEXT NOT NULL,  -- SHA-256(fields || prev_hash)
    prev_hash   TEXT NOT NULL   -- SHA-256 of previous row; genesis uses SHA-256('')
);
```

- Hash computed via `pgcrypto` `digest()` trigger (constant-time library call; no hand-rolled hash)
- Write-once enforcement via PostgreSQL RLS: `REVOKE UPDATE, DELETE ON audit_log FROM app_role`
- Chain verification query surfaces any tampered row as a result row (zero rows = chain intact)
- Include chain verification as a dashboard health check endpoint
- Future enterprise tier: `immudb` for formal cryptographic proof-of-inclusion (SOC 2 / ISO 27001)

---

## Memory Safety

| Practice | Implementation |
|---|---|
| Zero key material after use | `defer zeroize(keySlice)` — overwrite with zeros; GC does not guarantee zeroing |
| Minimize secret lifetime | Hold plaintext DEK only during encrypt/decrypt; discard immediately after |
| No secrets in logs | Redact hex strings ≥ 32 bytes from structured log output |
| mlock key pages | `syscall.Mlock(keyBytes)` + Docker `cap_add: [IPC_LOCK]` |

```yaml
# docker-compose.yml
services:
  vault:
    cap_add:
      - IPC_LOCK
    security_opt:
      - no-new-privileges:true
```

Without `IPC_LOCK`, Vault/OpenBao emit `WARNING! mlock not supported` at startup and key material may page to swap.

---

## CI/CD Integration

**Pattern: OIDC JWT with no static credentials stored anywhere.**

- GitHub Actions: job declares `permissions: id-token: write`; vault-action exchanges GitHub OIDC JWT for a short-lived Vault token; `bound_claims` restrict per-repo/branch/environment
- GitLab CI: `id_tokens` block (replaced deprecated `CI_JOB_JWT` in GitLab 17.0); native `secrets:` block (Premium+)
- JWT lifetime: minutes (single job); blast radius on leak: zero (token expires with job)

---

## Open ADRs (Decisions Required Before Implementation)

| # | Decision | Options | Impact |
|---|---|---|---|
| ADR-01 | Per-secret vs. per-project DEKs | Per-secret (lower blast radius, higher overhead) vs. per-project (Infisical pattern, simpler) | Fundamental to the data model |
| ADR-02 | Default seal mode | Shamir manual (recommended for v1) vs. KMS auto-unseal | Operational complexity and availability |

**v1 resolution (2026-06-24):** Manual unseal with three custody models — passphrase (Argon2id), envelope (split env+file), file (downgraded). Shamir and KMS deferred. Documented in `specs/vault-initialization-and-key-management.md`.
| ADR-03 | AES-GCM-SIV in v1 | Ship in v1 for distributed node safety vs. defer to v1.1 | Only relevant if multiple encrypt nodes exist |

---

## Known CVEs / Advisories to Track

| ID | Library | Severity | Status | Action |
|---|---|---|---|---|
| RUSTSEC-2024-0398 | `sharks` (Rust SSS) | Critical | Unfixed — maintainer unresponsive | **Do not use `sharks`; use `blahaj`** |
| CVE-2023-25000 | HashiCorp Vault SSS | High | Fixed in Vault 1.13.1 | Use `github.com/hashicorp/vault/shamir` ≥ v1.13.1 |
| RUSTSEC-2025-0007 | `ring` (Rust) | Medium | Partially resolved; maintenance concern | Do not use `ring` for new projects |

---

## Sources

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)
- [RFC 9106 — Argon2](https://www.rfc-editor.org/rfc/rfc9106.html)
- [RFC 8452 — AES-GCM-SIV](https://www.rfc-editor.org/rfc/rfc8452.html)
- [RFC 7696 — Cryptographic Agility](https://www.rfc-editor.org/rfc/rfc7696.html)
- [NIST SP 800-38D — AES-GCM](https://csrc.nist.gov/pubs/sp/800/38/d/final)
- [NIST SP 800-57 Part 1 — Key Management](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final)
- [NSA CNSA 2.0 — May 2025](https://media.defense.gov/2025/May/30/2003728741/-1/-1/0/CSA_CNSA_2.0_ALGORITHMS.PDF)
- [RUSTSEC-2024-0398](https://rustsec.org/advisories/RUSTSEC-2024-0398.html)
- [RUSTSEC-2025-0007](https://rustsec.org/advisories/RUSTSEC-2025-0007.html)
- [CVE-2023-25000 / GHSA-vq4h-9ghm-qmrr](https://github.com/advisories/GHSA-vq4h-9ghm-qmrr)
- [OpenBao Architecture](https://openbao.org/docs/internals/architecture/)
- [OpenBao Seal Concepts](https://openbao.org/docs/concepts/seal/)
- [OpenBao Raft Storage](https://openbao.org/docs/configuration/storage/raft/)
- [HashiCorp Vault Key Rotation Internals](https://developer.hashicorp.com/vault/docs/internals/rotation)
- [age C2SP Encryption Spec](https://github.com/C2SP/C2SP/blob/main/age.md)
- [Bitwarden KDF Algorithms](https://bitwarden.com/help/kdf-algorithms/)
- [Prossimo — rustls adopts aws-lc-rs](https://www.memorysafety.org/blog/rustls-with-aws-crypto-back-end-and-fips/)
