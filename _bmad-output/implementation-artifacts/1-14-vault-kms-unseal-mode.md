# Story 1.14: Vault KMS Unseal Mode

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a platform operator running Project Vault in production,
I want to initialize and unseal the vault using an external KMS (AWS KMS) instead of a locally-custodied passphrase, split key, or raw key file,
so that master key material never has to live on the host filesystem or be manually typed by an operator, and I can rely on the cloud provider's HSM-backed key management, IAM access control, and audit trail for the single highest-value secret in the system.

## Context — why this story exists

This closes a v1 design gap the project's own `README.md` discloses (lines ~54, ~84):

> 🔑 **Vault unsealing** — master password or envelope encryption with split-key default | 🟡 Partial | External KMS mode is schema-reserved but unimplemented (v1 gap, see Story 9.5 disclosure)

> - External KMS (`kms` mode) for vault unsealing is schema-reserved but has no implementation (Story 1.5 / Story 9.5).

**Confirmed by direct code inspection (not just the disclosure text):**
- `packages/db/src/schema/vault-state.ts` — the `vault_state_kms_type_check` CHECK constraint already allows `kms_type IN ('passphrase', 'envelope', 'file', 'kms')`. `'kms'` is a valid DB value today with **zero code path that ever sets or reads it**.
- `apps/api/src/modules/vault/schema.ts` — `VaultInitRequestSchema` is a `z.discriminatedUnion('kmsType', [...])` with exactly three members: `passphrase`, `envelope`, `file`. There is no `kms` member. `POST /api/v1/vault/init` with `{"kmsType":"kms",...}` fails Zod validation today (`400 validation_error`) — it does not silently succeed and it does not reach any placeholder logic.
- `apps/api/src/modules/vault/key-service.ts` — `deriveIkmForInit`/`deriveIkmForUnseal` have exactly three branches (`passphrase`/`envelope`/fallback-`file`). No `kms` branch exists.
- `apps/api/src/workers/key-custody-check.ts` — the FR109 key-custody-risk alert only checks `state.kmsType === 'file'`. It does not yet know `'kms'` is a *lower*-risk mode than `'file'`, which matters once `'kms'` becomes real (AC-19 below).
- Story 1.5 (`_bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md`, `done`) implemented `passphrase` (Argon2id KDF) and `envelope` (split-key: `VAULT_ENVELOPE_KEY_HALF` env var + a file half under `VAULT_KEY_DIR`) modes, explicitly documenting `'kms'` as reserved-but-unimplemented in its own D6 decision.
- Story 9.5 (`_bmad-output/implementation-artifacts/9-5-operational-runbook-and-deployment-guide.md`, `done`) — `docs/runbook.md` AC-14 documents this honestly: "true external KMS integration (AWS KMS, GCP KMS, HashiCorp Vault, etc.) is not implemented in v1" and instructs operators to use `envelope` mode as today's closest mitigation. **This story makes that runbook section stale — Task 8 below updates it.**

**Requirements traceability (epics.md):**
- **FR60** (`epics.md` line 354/#124): "The system supports configurable vault unsealing via a master password on startup." This story extends the configurable-unseal mechanism with a fourth, KMS-backed mode — it does not replace FR60's existing modes.
- **NFR-SEC2** (`epics.md` line 166): "Master key management via environment variable (default); external KMS integration (advanced option)." This story is the first implementation of NFR-SEC2's "advanced option" half.
- **FR109 / AC-E9d** (`epics.md` lines 134, 2002, 2060): the master-key-custody dashboard alert fires when `kms_type = 'file'` AND backup is enabled, nudging operators toward KMS. Once `'kms'` mode is real, the alert logic must recognize it as the *resolution* the alert points to, not just leave it unrecognized (AC-19).
- **AC-E1a** (`epics.md` line 484): "unseal is manual-only on startup; vault auto-seals on unexpected shutdown/crash; auto-seal requires manual unseal before any API or UI request is served." KMS mode inherits this invariant unchanged — a KMS-unsealed vault seals exactly like every other mode on crash/SIGTERM (`zeroKeys()` in `key-service.ts`), and manual `POST /api/v1/vault/unseal` is still required on restart. KMS mode changes *what* the operator supplies to unseal, not *when* unsealing happens.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no (platform-operator/pre-auth bootstrap ceremony, not an end-user-facing feature) |
| **Linked UI story** (if API-only) | N/A — vault init/unseal has never had a web UI in this codebase (it is a pre-auth, pre-database-of-users ceremony driven by `curl`/deployment scripts, same as `passphrase`/`envelope`/`file` modes today; see Story 1.5's own scope). No UI story is being silently deferred — this mirrors the existing, already-shipped modes exactly. |
| **Honest placeholder AC** (if UI deferred) | N/A — not a UI deferral, it is architectural: init/unseal happen before any user session exists and before the web app can even reach the API (vault is sealed → all routes but `/health`/`/ready`/`/vault/init`/`/vault/unseal` return 503). |
| **Persona journey** | See below |

### Persona journey stub

Riley (platform operator, self-hosting Project Vault on AWS with an existing KMS key for other infrastructure) runs `docker compose up -d`, then issues `POST /api/v1/vault/init` with `{"kmsType":"kms","kmsKeyId":"arn:aws:kms:us-east-1:123456789012:key/abcd-..."}` and the bootstrap-token header — no passphrase to remember, no key file to provision and protect on the host filesystem. On every subsequent restart, Riley issues `POST /api/v1/vault/unseal` with an **empty body** — the API derives everything it needs from the encrypted data key already stored in `vault_state` plus the container's ambient AWS credentials (IAM role or environment credentials — the same credential-provider-chain pattern this codebase already uses for S3 backup storage in `apps/api/src/modules/backup/storage.ts`). This is a CLI/API-only ceremony; there is no `/platform` web UI page for this and none is expected in v1 (same as every other unseal mode today).

## Acceptance Criteria

### Init — happy path and validation

**AC-1 (happy path — KMS init).**
**Given** the vault is uninitialized (no `vault_state` row) and a real (or LocalStack-emulated) AWS KMS key exists,
**When** `POST /api/v1/vault/init` is called with a valid bootstrap token and body `{"kmsType":"kms","kmsKeyId":"arn:aws:kms:us-east-1:123456789012:key/abcd-1234-...."}`,
**Then** the server calls AWS KMS `GenerateDataKey` (`KeySpec: AES_256`, `KeyId: <kmsKeyId>`), receives `{ Plaintext: <32-byte IKM>, CiphertextBlob: <opaque bytes> }`, derives the same four keys as every other mode via the existing `deriveAllKeysFromIkm(ikm)` (primary/audit/backup/platformAudit — no new derivation logic), zeroes the plaintext IKM immediately after derivation (identical discipline to the `passphrase`/`envelope`/`file` paths), encrypts the sentinel with the derived primary key, and inserts a `vault_state` row with `kms_type = 'kms'`, `kms_key_id = 'arn:aws:kms:...'`, `kms_encrypted_dek = <base64 CiphertextBlob>`, `key_derivation_params = NULL`. Response: `200 { initialized: true, keyVersion: 1, kmsType: "kms" }`.
**Example (positive):** identical to today's file-mode `curl` example in the runbook, just a different `kmsType`:
```
curl -X POST http://localhost:3000/api/v1/vault/init \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kmsType":"kms","kmsKeyId":"arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr"}'
# → 200 { "initialized": true, "keyVersion": 1, "kmsType": "kms" }
```
**Example (edge — key alias instead of ARN):** `kmsKeyId` also accepts a KMS alias (`alias/project-vault-master`) since AWS KMS's `GenerateDataKey` API itself accepts aliases — the server does not restrict the string format beyond non-empty, delegating format validation to AWS KMS's own error response (AC-3/AC-4 below cover the rejection path).

**AC-2 (init validation — missing/malformed `kmsKeyId`).**
**Given** the vault is uninitialized,
**When** `POST /api/v1/vault/init` is called with `{"kmsType":"kms"}` (no `kmsKeyId`) or `{"kmsType":"kms","kmsKeyId":""}`,
**Then** Zod's discriminated-union validation rejects the request **before any AWS KMS call is made** (same fail-fast discipline as `passphrase`'s empty-string rejection today): `400 { error: "validation_error", message: "..." }`.
**Example (positive counterpart):** a well-formed `kmsKeyId` (non-empty string) passes this layer and proceeds to AC-1/AC-3/AC-4's AWS-call-dependent outcomes.
**Example (negative):** `{"kmsType":"kms","kmsKeyId":null}` → `400 validation_error` (Zod rejects non-string).

**AC-3 (init — KMS unreachable).**
**Given** the vault is uninitialized and a syntactically valid `kmsKeyId` is supplied,
**When** the AWS KMS `GenerateDataKey` call times out or the network is unreachable (SDK throws a network/timeout error, e.g. `ETIMEDOUT`, `NetworkingError`),
**Then** the server catches the SDK error, does **not** insert any `vault_state` row (init remains re-attemptable — no partial state), and returns `503 { error: "kms_unreachable", message: "Could not reach the configured KMS provider. Verify network connectivity and KMS endpoint configuration." }`. No plaintext key material was ever generated in this path (the failure happens at the KMS call itself, before any local IKM exists to zero).
**Example (positive counterpart):** once connectivity is restored, retrying the identical request succeeds per AC-1 (idempotent-safe to retry since nothing was persisted).
**Example (negative — do not confuse with AC-4):** a `503 kms_unreachable` must never be returned for a KMS key that *does* exist and *is* reachable but simply lacks the operator's requested permission — that is AC-5's `403`, a distinct failure class the operator must be able to tell apart (network problem vs. IAM problem).

**AC-4 (init — KMS key not found).**
**Given** the vault is uninitialized,
**When** `kmsKeyId` refers to a key that does not exist (AWS KMS returns `NotFoundException`),
**Then** the server returns `400 { error: "kms_key_not_found", message: "The specified KMS key was not found. Verify kmsKeyId and that the key exists in the configured AWS region." }` and inserts no `vault_state` row.
**Example (positive counterpart):** the same request with a corrected, existing `kmsKeyId` succeeds per AC-1.
**Example (edge — key exists but is disabled/pending-deletion):** AWS KMS returns `DisabledException` or `KMSInvalidStateException` for a key scheduled for deletion or explicitly disabled — the server maps these to the same `400 kms_key_not_found`-class response (operator-actionable: "this key cannot currently be used"), distinct from `kms_permission_denied` (AC-5) which means the credentials lack rights, not that the key itself is unusable.

**AC-5 (init — permission denied).**
**Given** the vault is uninitialized and the KMS key exists and is enabled,
**When** the AWS credentials available to the API process (ambient IAM role, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars — same credential-provider-chain the codebase already uses for S3 in `apps/api/src/modules/backup/storage.ts`) lack `kms:GenerateDataKey` permission on the key (AWS KMS returns `AccessDeniedException`),
**Then** the server returns `403 { error: "kms_permission_denied", message: "The API's AWS credentials do not have permission to use the configured KMS key. Verify the IAM policy grants kms:GenerateDataKey and kms:Decrypt on this key." }` and inserts no `vault_state` row.
**Example (positive counterpart):** granting the missing IAM permission and retrying the identical request succeeds per AC-1.
**Example (negative — no credential leak):** the error message never echoes back the IAM principal ARN, access key ID, or any part of the credential chain — only the fact that permission was denied on the given key.

**AC-6 (init — already initialized, parity with existing modes).**
**Given** a `vault_state` row already exists (any `kmsType`, including a prior `'kms'` init),
**When** `POST /api/v1/vault/init` is called again with `{"kmsType":"kms",...}`,
**Then** the atomic `INSERT ... ON CONFLICT DO NOTHING` (unchanged from the existing implementation — no new race window is introduced) returns zero rows, the freshly-generated KMS data key's plaintext and derived secondary keys are zeroed exactly like the existing `zeroSecondaryKeys()` path, and the server returns `409 { error: "already_initialized", message: "Vault is already initialized. Use POST /api/v1/vault/unseal to unseal." }` — identical behavior to `passphrase`/`envelope`/`file` today.
**Example (edge — the discarded KMS data key does not leak):** even though a real `GenerateDataKey` call succeeded before the conflict was detected (the same "derive first, then attempt insert" order as today's other modes), the plaintext IKM/derived keys from that call are `.fill(0)`'d and never persisted — the pre-existing `vault_state` row (of whatever mode it actually is) remains the sole source of truth, unchanged.

### Init — schema and storage

**AC-7 (vault_state schema extension — additive, backward compatible).**
**Given** the migration for this story runs against a database with an existing `vault_state` row in `passphrase`/`envelope`/`file` mode,
**When** migration `00XX_vault_kms_columns.sql` (next sequential number after the current latest, `0047`) adds two new nullable columns — `kms_key_id TEXT` and `kms_encrypted_dek TEXT` — to `vault_state`,
**Then** the migration is purely additive (no column drops, no renames, no NOT NULL on existing rows, no data transformation of existing rows) per this project's own upgrade-compatibility rule (AC-E9b, Story 9.3's migration-compatibility-matrix check must pass), and the two new columns remain `NULL` for every non-`'kms'`-mode row, both before and after this migration.
**Example (positive):** `pnpm check-migration-compatibility` (Story 9.3's actual shipped script name — not `epics.md`'s stale prose) passes with this migration.
**Example (negative — a migration mistake this AC forbids):** adding a `NOT NULL` constraint or a CHECK requiring `kms_encrypted_dek` to be non-null whenever `kms_type = 'kms'` at the database level would be **correctness-desirable but is explicitly out of scope for this migration** — the CHECK constraint enforcing "kms_encrypted_dek IS NOT NULL when kms_type = 'kms'" is deferred to avoid coupling a schema constraint to application-layer validation timing (the row is inserted only after AWS KMS already succeeded, per AC-1, so the invariant holds in practice without a DB-level CHECK); this decision must be recorded in Dev Notes as an accepted trade-off, not silently omitted.

**AC-8 (Zod schema — new discriminated-union member).**
**Given** `apps/api/src/modules/vault/schema.ts`'s `VaultInitRequestSchema`,
**When** this story adds a fourth `KmsInitSchema` member to the existing `z.discriminatedUnion('kmsType', [...])`,
**Then** `KmsInitSchema = z.object({ kmsType: z.literal('kms'), kmsKeyId: z.string().min(1) })` — no `acknowledge*` boolean flag is required (unlike `envelope`'s `acknowledgeSplitKeyModel` and `file`'s `acknowledgeCoLocationRisk`), because KMS mode is the **most**-secure option, not a downgraded one requiring explicit risk acknowledgment. `VaultInitResponseSchema.kmsType` and `VaultUnsealResponseSchema.kmsType` both extend their `z.enum([...])` to include `'kms'`.
**Example (positive):** `VaultInitRequestSchema.safeParse({kmsType:'kms', kmsKeyId:'alias/foo'})` succeeds with no acknowledgment field.
**Example (negative — cross-mode field confusion must still be rejected):** `{"kmsType":"kms","kmsKeyId":"alias/foo","passphrase":"irrelevant-extra-field-here"}` — Zod's discriminated union matches on `kmsType` and (by default, non-strict) ignores unknown extra fields the same way it already does for the other three modes today; this AC only requires that supplying an *extra*, wrong-mode field never causes the server to silently honor it (verified by asserting the resulting `deriveIkmForInit` call only reads `body.kmsKeyId`, never `body.passphrase`, in this branch).

### Unseal — happy path and validation

**AC-9 (happy path — KMS unseal, empty body).**
**Given** the vault is sealed with a stored `vault_state` row where `kms_type = 'kms'`, `kms_key_id = 'arn:...'`, `kms_encrypted_dek = '<base64>'`,
**When** `POST /api/v1/vault/unseal` is called with an **empty JSON body** `{}` (no `passphrase`, `envelopeKeyPath`, or `masterKeyPath` — the server needs none of these for KMS mode),
**Then** the server reads the stored `kms_key_id`/`kms_encrypted_dek`, calls AWS KMS `Decrypt` with the stored ciphertext blob, receives the plaintext IKM back, re-derives all four keys via the same `deriveAllKeysFromIkm(ikm)`, decrypts and verifies the sentinel exactly as every other mode, and on success transitions to `unsealed` and returns `200 { unsealed: true, keyVersion: 1, kmsType: "kms" }`.
**Example (positive):**
```
curl -X POST http://localhost:3000/api/v1/vault/unseal -H "Content-Type: application/json" -d '{}'
# → 200 { "unsealed": true, "keyVersion": 1, "kmsType": "kms" }
```
**Example (edge — `Decrypt` does not require `KeyId` to be re-specified):** AWS KMS's `Decrypt` API recovers the key ID from the ciphertext blob's metadata itself; the server does not need to pass `kms_key_id` as a parameter to `Decrypt` (only to the original `GenerateDataKey` call at init) — this AC exists to prevent a developer from assuming (incorrectly) that `Decrypt` needs the key ID re-supplied and adding unnecessary/wrong logic.

**AC-10 (unseal validation — request-shape parity with existing modes, extended for KMS).**
**Given** `VaultUnsealRequestSchema`'s existing `.refine()` — today it requires "exactly one of `passphrase`/`envelopeKeyPath`/`masterKeyPath`",
**When** this story relaxes that refine to: "either exactly one of the three legacy fields, **or** zero of them (the zero-field case is valid only when the stored `kmsType` turns out to be `'kms'`, checked server-side in `unsealVault()` after reading `vault_state` — the Zod layer cannot know the stored mode)",
**Then** a request body supplying zero legacy fields against a **non-KMS**-mode stored vault (e.g. `{}` against a `passphrase`-mode vault) passes Zod but fails inside `deriveIkmForUnseal`'s existing `passphrase`-branch check (`if (!body.passphrase) throw INVALID_PASSPHRASE`) — i.e. the existing per-mode required-field checks in `key-service.ts` remain the actual enforcement point, unchanged for the three legacy modes, and a new equivalent check is added for the `kms` branch: **if a legacy field IS present in the body while the stored mode is `'kms'`, it is silently ignored** (not an error) — KMS mode never reads `body.passphrase`/`body.envelopeKeyPath`/`body.masterKeyPath`.
**Example (positive):** `{}` against a `kms`-mode vault → succeeds per AC-9.
**Example (negative — wrong-mode empty body):** `{}` against a `passphrase`-mode vault → `400 { error: "invalid_passphrase", message: "Passphrase must be at least 12 characters" }` (unchanged existing behavior — this AC's relaxed Zod-layer refine must not accidentally let an empty body slip past into `bootstrapDecrypt` for non-KMS modes).
**Example (edge — extraneous field against KMS mode):** `{"passphrase":"irrelevant-value-here"}` against a `kms`-mode vault → succeeds per AC-9, the supplied passphrase is never read or compared to anything.

**AC-11 (unseal — KMS unreachable).**
**Given** the vault is sealed in `kms` mode,
**When** the AWS KMS `Decrypt` call times out or the network is unreachable,
**Then** the server returns `503 { error: "kms_unreachable", message: "Could not reach the configured KMS provider. The vault remains sealed. Verify network connectivity and retry." }`, the vault status remains `sealed` (no partial unseal, no key material committed to module state), and the request is safely retryable once connectivity returns.
**Example (positive counterpart):** retrying after connectivity is restored succeeds per AC-9.
**Example (negative — must not be conflated with a real unseal failure):** this is a distinct error code/status from `401 UNSEAL_FAILED` (wrong credentials/tampered sentinel) — an operator seeing `503 kms_unreachable` should troubleshoot network/AWS-availability, not suspect data corruption or a compromised vault.

**AC-12 (unseal — KMS key deleted/disabled since init).**
**Given** the vault is sealed in `kms` mode and the KMS key referenced by the stored ciphertext blob has since been deleted, disabled, or scheduled for deletion,
**When** `POST /api/v1/vault/unseal` is called,
**Then** AWS KMS's `Decrypt` call fails (`DisabledException`/`KMSInvalidStateException`/`NotFoundException` depending on the exact state) and the server returns `503 { error: "kms_key_unavailable", message: "The KMS key required to unseal this vault is not currently usable (deleted, disabled, or pending deletion). This is a permanent data-loss risk if the key cannot be restored — see the runbook's KMS key-loss procedure." }`. This is documented as the KMS-mode equivalent of "the operator lost the master key file" for `file`/`envelope` modes — **unrecoverable without restoring the KMS key** (AWS KMS supports a 7–30 day pending-deletion recovery window; after that, the vault's data is permanently unrecoverable, same class of catastrophic loss as losing a `file`-mode key file).
**Example (positive counterpart):** restoring/re-enabling the KMS key (within AWS's pending-deletion recovery window) and retrying succeeds per AC-9.
**Example (negative — this must be surfaced distinctly from AC-11's transient unreachability):** an operator must be able to tell "KMS is temporarily down, retry" (AC-11, `kms_unreachable`) apart from "the key itself is gone, this may be permanent" (AC-12, `kms_key_unavailable`) — conflating the two into one generic error would send the operator down the wrong troubleshooting path during an actual incident.

**AC-13 (unseal — permission denied).**
**Given** the vault is sealed in `kms` mode and the API's AWS credentials lack `kms:Decrypt` permission on the key (credentials may have been narrowed since init, or the process is now running under a different IAM role),
**When** `POST /api/v1/vault/unseal` is called,
**Then** the server returns `403 { error: "kms_permission_denied", message: "The API's AWS credentials do not have permission to decrypt the vault's KMS-wrapped key. Verify the IAM policy grants kms:Decrypt on this key." }`.
**Example (positive counterpart):** granting the missing permission and retrying succeeds per AC-9.
**Example (edge — credentials present but for the wrong AWS account):** AWS KMS returns the same class of `AccessDeniedException` when credentials belong to an account without cross-account key-policy access — mapped to the identical `403 kms_permission_denied` response; the server does not need to distinguish "wrong account" from "right account, missing permission" since the operator remediation (fix IAM/key policy) is the same either way.

**AC-14 (unseal — sentinel mismatch after successful KMS decrypt).**
**Given** the vault is sealed in `kms` mode and AWS KMS successfully decrypts the stored ciphertext blob (returning *some* plaintext — e.g. `vault_state.encrypted_sentinel` was tampered with independently of the KMS-wrapped key, or the wrong `vault_state` row's ciphertext blob was somehow paired with a different row's sentinel),
**When** the recovered IKM's derived primary key fails to decrypt `encrypted_sentinel`, or decrypts it to a value that does not match `SENTINEL_PLAINTEXT`,
**Then** the server follows the exact same path as the existing `passphrase`/`envelope`/`file` sentinel-mismatch handling: zero all derived keys, return `401 { error: "unseal_failed", message: "Vault unseal failed: sentinel mismatch." }` — no new error class is introduced for this case, since it is not KMS-specific (it is "the sentinel doesn't match," identical regardless of which mode produced the candidate key).
**Example (positive counterpart):** an untampered `vault_state` row always passes this check, per AC-9.
**Example (negative — this AC exists to prevent a dangerous shortcut):** a developer must not skip sentinel verification for KMS mode on the theory that "KMS already authenticated the decrypt, so the result must be correct" — KMS's `Decrypt` only proves the ciphertext blob round-trips through *some* valid KMS key; it says nothing about whether the resulting IKM is the one that actually encrypted *this row's* sentinel (e.g. a `vault_state` row manually edited to point at a different KMS key's ciphertext blob). Sentinel verification is the only correctness guarantee — it must remain mode-independent and unconditional.

### Concurrency and credential rotation

**AC-15 (concurrent unseal attempts — no double-KMS-call race, parity with existing modes).**
**Given** the vault is sealed in `kms` mode,
**When** two concurrent `POST /api/v1/vault/unseal` requests arrive before either completes,
**Then** the existing `if (_status === 'unsealed') throw ALREADY_UNSEALED` guard at the top of `unsealVault()` is unchanged and continues to apply — both requests may race into the KMS `Decrypt` call (this is the same behavior as today's `passphrase`/`envelope`/`file` modes racing into `readKeyFile`/`bootstrapDecrypt`; there is no new lock introduced by this story, and none is required since both racing calls are idempotent reads that converge on the identical derived key), but only one commits via `commitUnsealedKeys()` — the module-level `_status`/`_primaryKey`/etc. assignments are synchronous and the second call's `commitUnsealedKeys()` simply re-zeroes-and-replaces the first call's already-set keys with an identical set of bytes (same key, same derivation), leaving the vault in a correct, single, unsealed state either way.
**Example (positive):** both concurrent requests return `200 { unsealed: true, ... }` (Node's single-threaded event loop means no actual data race on the module-level buffers themselves — this AC documents existing behavior, not new locking).
**Example (edge — one request during, one after, the vault becomes unsealed):** if request A completes and unseals the vault before request B's KMS `Decrypt` call resolves, request B still proceeds (no mid-flight cancellation) but its `commitUnsealedKeys()` call still succeeds harmlessly (re-derives the same key). This is called out explicitly (not left implicit) because a developer unfamiliar with the existing `passphrase` mode's identical behavior might assume KMS mode needs new locking — it does not; this AC is a regression guard, not new functionality.

**AC-16 (KMS credential rotation mid-operation).**
**Given** the API process's ambient AWS credentials (IAM role session, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) are rotated by the platform operator's infrastructure (e.g. IAM role credential refresh, or an operator swapping env vars and restarting) between the vault's `'kms'`-mode `init` and a later `unseal`,
**When** `POST /api/v1/vault/unseal` is called using the **new** credentials,
**Then** unseal succeeds exactly as in AC-9, **provided the new credentials retain `kms:Decrypt` permission on the same key** — the server never stores or depends on the credentials used at init time; each request resolves credentials fresh via the AWS SDK's standard credential-provider chain (the same mechanism already used for S3 in `apps/api/src/modules/backup/storage.ts`, which this story's `AwsKmsProvider` implementation mirrors), so credential rotation between init and unseal is transparent by construction.
**Example (positive):** init happens under an IAM role with short-lived STS credentials; hours later, after several credential refreshes have occurred transparently via the AWS SDK's own token-refresh logic, unseal succeeds without any special handling in this codebase.
**Example (negative — the failure mode this AC must NOT produce):** if the *new* credentials lack `kms:Decrypt` (e.g. an overly-narrow IAM policy rotation), the failure is AC-13's `403 kms_permission_denied` — not a crash, not a hang, not a misleading "unreachable" or "key not found" error. This AC's test must specifically verify the credential-rotation scenario reaches the *correct* one of AC-9/AC-13, not a generic catch-all.

### Authorization, audit, and logging parity

**AC-17 (bootstrap-token gating — parity with existing modes).**
**Given** `POST /api/v1/vault/init`'s existing `assertBootstrapAuthorized()` check (requires `X-Vault-Bootstrap-Token` header matching `VAULT_BOOTSTRAP_TOKEN`, unless `VAULT_ALLOW_REMOTE_INIT=true`),
**When** a `{"kmsType":"kms",...}` init request is made without a valid bootstrap token,
**Then** it is rejected `403 { error: "bootstrap_forbidden", message: "Vault bootstrap requires valid bootstrap credentials" }` **before any AWS KMS call is attempted** — `kmsType` never bypasses this existing gate, and the same "no new authz surface" rule from Story 9.1's `requirePlatformOperator` pattern applies: init/unseal remain pre-auth ceremonies (no user session exists yet), gated only by the bootstrap token (init) or nothing additional (unseal — unchanged from today, since a sealed vault by definition has no way to authenticate a user session yet).
**Example (positive):** a valid bootstrap token + `{"kmsType":"kms","kmsKeyId":"..."}` succeeds per AC-1.
**Example (negative):** `VAULT_ALLOW_REMOTE_INIT=false` (production default) and no token header → `403 bootstrap_forbidden`, unchanged from `passphrase`/`envelope`/`file` today; this AC is a regression guard confirming KMS mode does not accidentally introduce a bypass.

**AC-18 (operational logging — parity, no secret leakage).**
**Given** the existing `req.log.info({ eventType: OperationalEvent.VAULT_INIT, keyVersion, kmsType, body: redactBodyForLog(req.body) }, ...)` / `VAULT_UNSEAL` logging in `apps/api/src/modules/vault/routes.ts`,
**When** a `'kms'`-mode init or unseal succeeds or fails,
**Then** the identical log call sites apply unchanged (`kmsType: 'kms'` flows through the existing `kmsType` field, no new logging code path is needed) and `redactBodyForLog` — already covering `passphrase`/`masterKeyPath`/`envelopeKeyPath` — is extended to also redact `kmsKeyId` is **not** required (the KMS key ARN/alias is not secret material — AWS IAM/KMS access policy is the actual security boundary, not obscurity of the key identifier — this mirrors how `BACKUP_S3_BUCKET`'s bucket name is never redacted either), but the KMS `CiphertextBlob`/plaintext data key must **never** appear in any log line, error message, or stack trace at any layer (enforced by the same discipline as every other mode: plaintext IKM only ever exists in a local `Buffer` that is `.fill(0)`'d immediately after derivation, per AC-1/AC-9, and is never passed to any logging call).
**Example (positive):** `vault.init` log line: `{ eventType: 'vault.init', keyVersion: 1, kmsType: 'kms', body: { kmsType: 'kms', kmsKeyId: 'arn:aws:kms:...' } }` — the ARN appears (non-secret), no ciphertext/plaintext key material appears.
**Example (negative — the leak this AC forbids):** an AWS SDK error object's `.message` or `.stack` must never be logged verbatim without inspection, since some AWS SDK error paths could theoretically echo request parameters; this story's KMS error-handling wrapper (AC-3/AC-4/AC-5/AC-11/AC-12/AC-13) constructs its own sanitized `AppError` messages rather than forwarding raw SDK error text to the client or logs.

**AC-19 (key-custody-risk alert — `'kms'` mode must not be flagged as the risk it mitigates).**
**Given** `apps/api/src/workers/key-custody-check.ts`'s `evaluateKeyCustodyTriggers()`, which today fires `file_kms_with_backup` when `state.kmsType === 'file' && isBackupEnabled()` (FR109/AC-E9d),
**When** this story is implemented and the vault's `kms_type` is `'kms'`,
**Then** the `file_kms_with_backup` trigger condition remains `state.kmsType === 'file'` — **unchanged, not broadened** — since `'kms'` mode is not the risk condition FR109 targets (a KMS-backed key is not "stored only as an environment variable with no KMS or escrow configured" per FR109's own trigger definition); this AC is a regression guard ensuring the developer does not accidentally write `state.kmsType !== 'kms'` (which would incorrectly re-flag `passphrase`/`envelope` modes that were never the FR109 trigger condition) instead of leaving the existing `=== 'file'` check untouched.
**Example (positive):** a `'kms'`-mode vault with backup enabled produces **zero** `key_custody_risk` alerts from the `file_kms_with_backup` trigger (correct — KMS custody is the mitigation, not the risk).
**Example (edge — the age-based trigger still applies independently):** `'kms'`-mode vaults are still subject to `evaluateKeyCustodyTriggers()`'s *second*, independent trigger — `key_age_exceeded` (based on `keyRotatedAt`/`KEY_ROTATION_MAX_AGE_DAYS`) — unchanged and mode-independent, since key-rotation hygiene matters regardless of custody mechanism; this AC must not accidentally exempt `'kms'`-mode vaults from the age check too.

### Backward compatibility

**AC-20 (existing `file`/`envelope`/`passphrase` vaults completely unaffected).**
**Given** a production instance already initialized in `passphrase`, `envelope`, or `file` mode before this story ships,
**When** the API is upgraded to a build containing this story's code and migration,
**Then** the vault continues to unseal via its existing mode with **zero behavior change** — no forced migration, no re-init, no new required env vars for non-KMS deployments (`VAULT_KMS_KEY_ID`/AWS credentials are only consulted when `kms_type = 'kms'` is actually read from the stored row; their absence never affects `passphrase`/`envelope`/`file` code paths), and the two new nullable `vault_state` columns (AC-7) sit unused and `NULL` for these rows indefinitely.
**Example (positive):** an existing `envelope`-mode vault, after this story's migration runs, unseals with the identical `POST /api/v1/vault/unseal` request body it used before this story existed — no behavior difference, verified by re-running Story 1.5's own existing envelope-mode integration tests unmodified against the post-migration schema.
**Example (negative — a regression this AC forbids):** the migration must not add any `NOT NULL` default, trigger, or backfill that touches existing rows' `kms_type`/`encrypted_sentinel`/other pre-existing columns in any way — this AC is verified by asserting the migration's SQL contains no `UPDATE vault_state` statement at all, only `ALTER TABLE ... ADD COLUMN ... TEXT` (nullable, no default).

### Extensibility and configuration

**AC-21 (pluggable KMS provider interface — v1 scope is AWS KMS only, behind a small interface).**
**Given** the explicit v1 scope decision (see "KMS Backend Decision" below): AWS KMS only, not GCP KMS or HashiCorp Vault Transit,
**When** this story's implementation is structured,
**Then** a small `KmsKeyProvider` interface is introduced (new file, e.g. `apps/api/src/modules/vault/kms-provider.ts`) with exactly two methods — `generateDataKey(keyId: string): Promise<{ plaintext: Buffer; ciphertextBlob: string }>` and `decryptDataKey(ciphertextBlob: string): Promise<Buffer>` — and `key-service.ts`'s `deriveIkmForInit`/`deriveIkmForUnseal` call this interface, not the AWS SDK directly, so a future story adding a second provider (GCP KMS, Vault Transit) only needs to implement this interface and add a provider-selection mechanism, without touching `key-service.ts`'s core init/unseal logic. This story ships exactly one implementation, `AwsKmsProvider`, using `@aws-sdk/client-kms`.
**Example (positive):** `AwsKmsProvider.generateDataKey('arn:aws:kms:...')` calls `GenerateDataKeyCommand({ KeyId, KeySpec: 'AES_256' })` and returns `{ plaintext, ciphertextBlob: ciphertextBlob.toString('base64') }`.
**Example (negative — scope creep this AC forbids):** this story does **not** add a `kmsProvider` selector field to the request/response schemas, does **not** add GCP/Vault SDK dependencies, and does **not** attempt to make the interface generically "cloud-agnostic" beyond what's needed to not hard-code AWS types into `key-service.ts` — over-engineering a multi-provider abstraction before a second real consumer exists is explicitly out of scope (YAGNI), consistent with this story's narrowest-defensible-v1-scope decision.

**AC-22 (environment configuration — new env vars, additive to `.env.example`).**
**Given** the existing env var patterns in `apps/api/src/config/env.ts` (e.g. `VAULT_KEY_DIR`, `VAULT_ENVELOPE_KEY_HALF`, `BACKUP_S3_REGION`),
**When** this story adds AWS KMS configuration,
**Then** it introduces `VAULT_KMS_ENDPOINT` (optional, `z.string().url().optional()` — for LocalStack/test-double override, mirroring `BACKUP_S3_ENDPOINT`'s existing pattern) and reuses the AWS SDK's standard credential/region resolution (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or an ambient IAM role) — **no new required env var is introduced for the credentials themselves**, since `kmsKeyId` (the only KMS-specific required input) is supplied per-request at init time (AC-1), not configured instance-wide via env var (unlike `VAULT_KEY_DIR`, which is a directory shared across `file`/`envelope` modes). `.env.example` is updated with `VAULT_KMS_ENDPOINT=` (commented, empty by default) and a comment explaining it is LocalStack/test-only.
**Example (positive):** production deployment sets no `VAULT_KMS_ENDPOINT` at all — the AWS SDK talks to the real regional KMS endpoint by default, exactly like the existing `S3Client` construction in `storage.ts` when `destination.endpoint` is unset.
**Example (negative — a config mistake this AC forbids):** `VAULT_KMS_ENDPOINT` must never be consulted for anything except constructing the `KMSClient`'s `endpoint` override (test/LocalStack use only) — it must not leak into production code paths as a required or defaulted-to-something-real value, mirroring `BACKUP_S3_ENDPOINT`'s existing test-only convention exactly.

**AC-23 (LocalStack/mock-based test coverage for the AWS KMS integration).**
**Given** integration tests cannot call real AWS KMS in CI,
**When** this story's test suite is written,
**Then** `AwsKmsProvider` is tested against either (a) a LocalStack KMS container (if the project's CI already runs LocalStack for S3 — check `docker-compose.yml`/CI config first and reuse that pattern if present) or (b) a mocked `KMSClient` (`{ send: vi.fn() }`, mirroring `apps/api/src/modules/backup/service.test.ts`'s existing `MinimalS3Client` mock pattern for `S3Client`) if no LocalStack KMS fixture already exists — the choice must match whatever pattern `s3-upload.ts`/`storage.ts`'s own existing tests use, for consistency, not introduce a third, novel test-double style into the codebase.
**Example (positive):** a test asserts `AwsKmsProvider.generateDataKey()` calls `client.send` with a `GenerateDataKeyCommand` carrying the exact `KeyId`/`KeySpec` parameters, and returns the mocked `{Plaintext, CiphertextBlob}` correctly converted to `{plaintext: Buffer, ciphertextBlob: base64 string}`.
**Example (negative — a test-only shortcut this AC forbids):** tests must not stub out `key-service.ts`'s `deriveIkmForInit`/`deriveIkmForUnseal` KMS branch entirely and only test the AWS-call wrapper in isolation — at least one full-stack `vault-lifecycle.test.ts`-style test (matching the existing file's own pattern) must exercise `POST /api/v1/vault/init` → `POST /api/v1/vault/unseal` end-to-end with `kmsType: 'kms'` against the mocked/LocalStack KMS client, verifying the sentinel round-trips correctly through real HKDF/AES-GCM code (only the KMS network call itself is mocked).

### Documentation — closing the disclosed gap honestly

**AC-24 (README gap-disclosure lines are corrected, not left stale).**
**Given** `README.md` lines ~54 and ~84 currently disclose `'kms'` mode as unimplemented,
**When** this story ships,
**Then** the feature-status table row for "🔑 Vault unsealing" is updated to `✅ Done` (or an accurate equivalent reflecting all four modes now implemented) with a note pointing to this story (`Story 1.14`), and the "Known v1 design gaps" bullet referencing `Story 1.5 / Story 9.5` for the KMS gap is removed (the gap is closed) — leaving the README's own disclosure discipline intact rather than letting it silently drift out of sync with shipped code (the same "honest documentation, not aspirational" principle Story 9.5's own D6 decision and AC-14 established).
**Example (positive):** the updated README row reads something like: `| 🔑 **Vault unsealing** — master password, envelope encryption with split-key default, or external KMS (AWS KMS) | ✅ Done | Epic 1 — KMS mode added in Story 1.14 |`.
**Example (negative — the disaster this AC prevents):** shipping this story's code without updating the README would leave a **published, discoverable false-negative disclosure** — worse than never having disclosed the gap at all, since a reader would trust the "still unimplemented" claim and not realize KMS mode is now available.

**AC-25 (runbook `docs/runbook.md` AC-14 section is corrected, per its own dated-note convention).**
**Given** Story 9.5's runbook AC-14 section already anticipates this exact moment — its own text says: *"the runbook's KMS section includes a dated note (e.g., 'as of Epic 9 / v1') so a future reader knows this section may be stale once a real KMS story ships... when that story lands, updating this section is that story's own documentation responsibility, not silently left for someone to notice independently"* —
**When** this story ships,
**Then** `docs/runbook.md`'s "Master Key Management: KMS integration status" section is updated to state that AWS KMS mode (`kmsType: 'kms'`) is now implemented as of Story 1.14, with a copy-pasteable `curl` example (matching AC-1/AC-9's examples above), a note on IAM permissions required (`kms:GenerateDataKey`, `kms:Decrypt`), and the key-loss procedure from AC-12, replacing (not merely appending to) the prior "not implemented in v1" framing so the two are not left contradicting each other.
**Example (positive):** an operator reading the runbook post-this-story sees accurate, actionable KMS setup instructions instead of a "not yet implemented" disclaimer.
**Example (negative — the exact disaster this AC's own source material warns against):** leaving the "not implemented in v1" sentence in place alongside new KMS documentation would recreate precisely the "lying about completion"-class documentation defect Story 9.5's AC-14 was written to prevent — just in the opposite direction (claiming non-existence of something that now exists).

**AC-26 (OpenAPI spec regenerated and contract-test-suite-verified).**
**Given** Story 9.3's AC-E9a contract-test suite (enumerates all routes from the live OpenAPI spec, verifies each has an implemented handler returning the documented response schema, runs in CI as a required check),
**When** this story's schema changes (`VaultInitRequestSchema`'s new `kms` union member, both response schemas' extended `kmsType` enum) are complete,
**Then** `openapi.json` is regenerated (same mechanism Story 9.3 established) and the contract-test suite passes with the new schema shape — no manual/undocumented drift between the live route behavior and the published spec.
**Example (positive):** `GET /api/v1/openapi.json`'s `VaultInitRequestSchema` component now shows all four `kmsType` variants in its `oneOf`/discriminator.
**Example (negative):** shipping the Zod schema change without regenerating `openapi.json` would fail Story 9.3's own CI-required contract check — this AC is a checklist item, not new logic, but is called out explicitly since it is a common "forgot the generated-artifact step" mistake in this codebase (per Story 9.5's own drift-correction notes about stale generated docs).

## Tasks / Subtasks

- [x] Task 1: Add `@aws-sdk/client-kms` dependency to `apps/api/package.json` (same version family as the existing `@aws-sdk/client-s3` dependency) (AC-1, AC-21)
- [x] Task 2: DB migration — add `kms_key_id TEXT` and `kms_encrypted_dek TEXT` nullable columns to `vault_state` (`packages/db/src/migrations/0048_vault_kms_columns.sql`); update `packages/db/src/schema/vault-state.ts` (AC-7, AC-20)
  - [x] Subtask 2.1: Run `pnpm check-migration-compatibility` to confirm additive-only
- [x] Task 3: `apps/api/src/modules/vault/kms-provider.ts` — `KmsKeyProvider` interface + `AwsKmsProvider` implementation using `@aws-sdk/client-kms`'s `GenerateDataKeyCommand`/`DecryptCommand`, mapping AWS SDK errors to typed categories (unreachable/not-found/permission-denied) (AC-1, AC-3, AC-4, AC-5, AC-11, AC-12, AC-13, AC-21, AC-22)
- [x] Task 4: `apps/api/src/modules/vault/schema.ts` — add `KmsInitSchema` to the discriminated union, extend both response schemas' `kmsType` enum, relax `VaultUnsealRequestSchema`'s refine to allow zero legacy fields (AC-2, AC-8, AC-10)
- [x] Task 5: `apps/api/src/modules/vault/key-service.ts` — add `kms` branches to `deriveIkmForInit`/`deriveIkmForUnseal` calling `KmsKeyProvider`; wire error mapping to `AppError` subtypes (`KMS_UNREACHABLE`, `KMS_KEY_NOT_FOUND`, `KMS_PERMISSION_DENIED`, `KMS_KEY_UNAVAILABLE`); persist `kmsKeyId`/`kmsEncryptedDek` on init, read them on unseal (AC-1, AC-3–AC-6, AC-9, AC-11–AC-16)
- [x] Task 6: `apps/api/src/modules/vault/routes.ts` — extend response schema wiring for the new error codes' status codes (`403`, `503` alongside existing `400`/`401`/`409`) (AC-3, AC-5, AC-11, AC-12, AC-13, AC-17, AC-18)
- [x] Task 7: `apps/api/src/workers/key-custody-check.ts` — confirm/regression-test that `file_kms_with_backup` trigger condition remains `=== 'file'` only, unaffected by `'kms'` mode (AC-19) — code already correct pre-story; `key-custody-check.test.ts` already had `kmsType: 'kms'` regression coverage (lines 76/117), confirmed green, no code change needed
- [x] Task 8: `apps/api/src/config/env.ts` + `.env.example` — add optional `VAULT_KMS_ENDPOINT` (AC-22)
- [x] Task 9: Tests — unit tests for `AwsKmsProvider` (mocked `KMSClient.send`), integration tests in `apps/api/src/__tests__/vault-lifecycle.test.ts`-style file covering AC-1 through AC-19 (happy paths, all error classes, concurrency, backward compat) (AC-1–AC-20, AC-23)
- [x] Task 10: Regenerate `openapi.json`; confirm Story 9.3's contract-test suite passes (AC-26)
- [x] Task 11: Update `README.md` lines ~54/~84 (AC-24)
- [x] Task 12: Update `docs/runbook.md`'s KMS section (AC-25)

## Dev Notes

### KMS Backend Decision (v1 scope — explicit, not an open question left ambiguous)

**Decision: AWS KMS only, for v1.** Not GCP KMS, not HashiCorp Vault Transit, not a generic multi-provider abstraction.

**Justification, grounded in the actual codebase (not a guess):**
1. `@aws-sdk/client-s3` (`^3.1082.0`) is **already a direct dependency** of `apps/api` (`apps/api/src/modules/backup/storage.ts`, `s3-upload.ts` — used for S3-compatible backup storage). Adding `@aws-sdk/client-kms` at the same version line is the smallest possible new-dependency surface — same SDK family, same credential-provider-chain behavior the team has already integrated, tested, and operated (`docker-compose.yml`'s existing AWS credential env vars for backup S3 apply identically to KMS, no new credential plumbing).
2. No GCP or HashiCorp Vault SDK or credential pattern exists anywhere in this codebase today — introducing either would be a first-of-its-kind dependency with no precedent to follow, meaningfully larger scope than this story's disclosed gap warrants.
3. The `KmsKeyProvider` interface (AC-21) keeps the door open for a future story to add a second provider without revisiting `key-service.ts`'s core logic — the narrowness is a scope decision, not an architectural dead end.

This mirrors the task brief's own instruction: *"if truly undetermined, pick the narrowest defensible v1 scope... and document it as an explicit open question/decision rather than silently expanding scope."* AWS KMS is not "truly undetermined" here — the existing `@aws-sdk/client-s3` dependency is a strong, concrete signal — so this is documented as a **decision**, not an open question.

### Envelope-encryption design (why a Data Key, not a direct KMS-wrapped 32-byte key)

AWS KMS's `Decrypt`/`Encrypt` operations support at most 4KB of data directly, but more importantly, calling KMS on the hot unseal path for a *symmetric key operation* is the standard "envelope encryption" pattern AWS itself documents: `GenerateDataKey` returns both a plaintext key (used immediately, then discarded — never stored) and an encrypted ("wrapped") copy of that same key (stored, harmless if leaked since only KMS can unwrap it). This story's design **is** that pattern: the "Data Encryption Key" plaintext IS the vault's IKM (fed into the existing `deriveAllKeysFromIkm`, identical to how `passphrase`/`envelope`/`file` modes already produce an IKM from their respective sources) — no new derivation logic, no new crypto primitives, only a new *source* for the IKM.

### Key files to read before implementing

- `apps/api/src/modules/vault/key-service.ts` — `deriveIkmForInit`/`deriveIkmForUnseal`/`deriveAllKeysFromIkm`/`commitUnsealedKeys` — this story adds one new branch to two functions; it does not restructure the existing three.
- `apps/api/src/modules/vault/schema.ts` — the discriminated union pattern to extend.
- `apps/api/src/modules/vault/routes.ts` — the two route handlers; error-code-to-status-code mapping already exists via `AppError`'s `.statusCode`, no new pattern needed, just new `AppError` subclasses/codes.
- `apps/api/src/modules/backup/storage.ts` + `s3-upload.ts` — the AWS SDK usage pattern (`S3Client` construction, credential-provider-chain reliance, endpoint override for LocalStack) to mirror for `KMSClient`.
- `apps/api/src/modules/backup/service.test.ts` — existing `MinimalS3Client`/mocked-`send` test pattern to mirror for `KMSClient` tests (AC-23).
- `packages/db/src/schema/vault-state.ts` — the table to extend (additive only).
- `apps/api/src/workers/key-custody-check.ts` — confirm the `=== 'file'` check is not touched (AC-19).
- `apps/api/src/config/env.ts` lines ~578–602 (`VAULT_KEY_DIR`, `VAULT_ENVELOPE_KEY_HALF`, `VAULT_BOOTSTRAP_TOKEN`, `VAULT_ALLOW_REMOTE_INIT`) — existing vault-related env var patterns to follow for `VAULT_KMS_ENDPOINT`.
- `apps/api/src/lib/errors.ts` — `AppError` base class, to add new error codes to (`KMS_UNREACHABLE`, `KMS_KEY_NOT_FOUND`, `KMS_PERMISSION_DENIED`, `KMS_KEY_UNAVAILABLE`).

### Testing standards summary

This codebase's existing pattern for vault tests: `apps/api/src/__tests__/vault-lifecycle.test.ts` (full init→unseal integration tests per mode), `apps/api/src/__tests__/vault-errors.test.ts` (error-path coverage), `apps/api/src/__tests__/vault-log-redaction.test.ts` (log-safety assertions), `apps/api/src/__tests__/vault-operational-logging.test.ts` (structured-log-field assertions). This story's tests should follow the same file-splitting convention rather than inventing a new structure — add `kms`-mode cases to the existing files where the existing mode's cases already live, plus a new `kms-provider.test.ts` for the `AwsKmsProvider` unit tests (mirroring `apps/api/src/modules/backup/s3-upload.ts`'s own unit-test file for its AWS SDK wrapper).

### Project Structure Notes

- Alignment with unified project structure: all new code lives under the existing `apps/api/src/modules/vault/` module — no new top-level module is created, consistent with `envelope.ts`/`passwords.ts` living inside `packages/crypto/src/` as siblings rather than separate packages.
- No conflicts detected between this story's additions and the existing file layout; `kms-provider.ts` is a new file in an existing directory, not a new directory.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` — FR60 (line 354/124), NFR-SEC2 (line 166), FR109 (line 134/1995/2038), AC-E9d (line 2002), AC-E1a (line 484), Story 9.2's `file_kms_with_backup` trigger text (line 2060)]
- [Source: `_bmad-output/implementation-artifacts/1-5-vault-initialization-and-master-key-management.md` — D6 decision (line 59-61), `kmsType` enum source of truth, existing init/unseal AC structure this story mirrors]
- [Source: `_bmad-output/implementation-artifacts/9-5-operational-runbook-and-deployment-guide.md` — AC-14 (line 300-310), the runbook's own forward-looking note this story fulfills]
- [Source: `apps/api/src/modules/vault/key-service.ts`, `schema.ts`, `routes.ts` — current implementation, verified by direct read, 2026-07-11]
- [Source: `packages/db/src/schema/vault-state.ts` — existing `kms_type` CHECK constraint already permitting `'kms'`]
- [Source: `apps/api/src/workers/key-custody-check.ts` — FR109 alert logic, AC-19's regression-guard target]
- [Source: `apps/api/src/modules/backup/storage.ts`, `s3-upload.ts`, `service.test.ts` — AWS SDK usage and test-double patterns this story mirrors for KMS]
- [Source: `README.md` lines ~54, ~84 — the exact gap-disclosure text this story closes]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Open Questions (raised during story creation, not blocking — flagged for dev/review attention)

1. **DB-level CHECK constraint for `kms_encrypted_dek` non-null when `kms_type='kms'`** (see AC-7's negative example) — deliberately deferred to keep this migration purely additive; if a future story wants stronger DB-level enforcement, it is a separate, small migration.
2. **KMS key rotation execution** — this story does not add a "rotate the KMS-wrapped key" operation (mirrors the existing, already-disclosed limitation that `key_rotated_at` has no rotation-execution code path yet, per Story 9.2 D8/Story 9.5). A `'kms'`-mode vault's `key_rotated_at` behaves identically to every other mode today — set once at init, never advanced — and remains subject to the same `key_age_exceeded` FR109 trigger (AC-19's edge example). Native AWS KMS key rotation (KMS automatically rotating the *underlying* CMK, transparent to `GenerateDataKey`/`Decrypt` callers) is a separate AWS-side feature this story neither depends on nor needs to configure — it is an operator choice on the AWS side, out of this story's scope.
3. **LocalStack vs. mocked-client test approach** (AC-23) is left to the implementing developer to resolve by checking whatever pattern the existing S3 tests actually use in this codebase at implementation time, rather than prescribed here, since that repo fact was not fully confirmed during story creation (only that `service.test.ts` references a `MinimalS3Client` mock pattern — whether a LocalStack container is *also* used elsewhere in CI was not exhaustively verified).

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (via `bmad-create-story` skill, story-authoring pass; `bmad-dev-story` skill, implementation pass)

### Debug Log References

- Local Postgres (docker-compose `db` service, `DB_HOST_PORT=5433` after `make fix-ports`) had never had migrations applied in this worktree — `vault_app` role didn't exist until migrations ran once as the `postgres` superuser. `.env`'s `DATABASE_URL` was corrected from a placeholder password to the real `dev-only-change-in-prod` password (0001_rls_and_triggers.sql) and the fixed port, matching the known ADMIN_DATABASE_URL-port-trap pattern already documented in project memory.
- Migration `0048_vault_kms_columns.sql` required a matching `meta/_journal.json` entry (idx 48) — added by hand, following the existing entries' shape exactly.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created. Story authored from scratch (no epics.md entry exists for 1.14 — this is a genuinely new backlog item closing a disclosed v1 gap, not a re-plan of an existing epics.md story) by direct inspection of `key-service.ts`, `schema.ts`, `routes.ts`, `vault-state.ts`, `key-custody-check.ts`, `backup/storage.ts`, `env.ts`, Story 1.5, Story 9.5, `epics.md`, and `README.md` as of 2026-07-11.
- Implementation pass (2026-07-11): all 26 ACs implemented and test-covered. TDD red-green followed throughout — new test files were written and confirmed failing (missing exports/modules) before the corresponding implementation landed; existing test files were updated in lockstep where the story's own ACs (AC-10) intentionally change prior behavior.
- `KmsKeyProvider` interface (AC-21) + `AwsKmsProvider` (`kms-provider.ts`) classify AWS SDK errors into a provider-agnostic `KmsErrorKind` (`unreachable`/`not_found`/`permission_denied`/`unknown`); `key-service.ts` maps that `kind` to context-specific `AppError`s — deliberately different for init (`AC-4`: `400 kms_key_not_found`) vs. unseal (`AC-12`: `503 kms_key_unavailable`) for the identical underlying AWS exception classes, since the same failure means "never worked" at init vs. "a working key became unusable" at unseal.
- Judgment call (not in the AC set, addressing adversarial-review finding 4/11): AWS `ThrottlingException`/`LimitExceededException` are classified as `unreachable` (not a fifth public error code, not `unknown`) — gives operators an actionable "retry" signal under load without inventing new API surface beyond the story's 26 ACs. An unrecognized/future AWS exception type falls back to `unknown` → `503 kms_unreachable`/`kms_unreachable`-class message, never forwarding the raw SDK error text (AC-18's no-leak guarantee holds for the unmapped case too).
- Judgment call: added an explicit app-level guard for `kms_type='kms'` with a `NULL kms_encrypted_dek` (adversarial-review finding 7 — a gap the deferred DB-level CHECK, AC-7, could theoretically allow via a future migration bug or manual DB edit) — `unsealVault()` now throws the existing `VAULT_CORRUPTED`/503 class rather than crashing deeper in the KMS provider call. Covered by a new regression test.
- AC-19 (key-custody-risk alert) required no code change — `apps/api/src/workers/key-custody-check.ts`'s `=== 'file'` check was already correct pre-story, and `key-custody-check.test.ts` already had `kmsType: 'kms'` regression coverage from an earlier story. Verified green, left untouched.
- AC-16 (credential rotation) is tested by swapping the injected `KmsKeyProvider` mid-test (simulating rotated credentials resolving fresh via the AWS SDK's standard chain) rather than mocking STS directly — consistent with the story's own framing that credential rotation is transparent by construction, never plumbed through this codebase's own logic.
- Full `apps/api` test suite (92 suites / 318 tests) and `packages/api-contract-tests` (22 tests) pass. `packages/db`'s suite has 13 pre-existing failures unrelated to this story (audit_log_entries FK/RLS-coverage-test issues, none touching `vault_state`) — confirmed identical failure count via `git stash`/re-run before this story's changes were applied.

### File List

- `apps/api/src/modules/vault/kms-provider.ts` (new) — `KmsKeyProvider` interface, `AwsKmsProvider` implementation, `KmsProviderError`/`KmsErrorKind` classification
- `apps/api/src/modules/vault/kms-provider.test.ts` (new) — unit tests, mocked `KMSClient.send`
- `apps/api/src/modules/vault/key-service.ts` — `kms` branches in `deriveIkmForInit`/`deriveIkmForUnseal`, error mapping, `__setKmsProviderForTest` test hook
- `apps/api/src/modules/vault/schema.ts` — `KmsInitSchema`, extended `kmsType` enums, relaxed `VaultUnsealRequestSchema` refine
- `apps/api/src/modules/vault/routes.ts` — added `503`/`403` response schema entries for the new KMS error codes
- `apps/api/src/config/env.ts` — `VAULT_KMS_ENDPOINT` (optional, LocalStack/test-only)
- `apps/api/package.json` / `pnpm-lock.yaml` — `@aws-sdk/client-kms` dependency
- `packages/db/src/schema/vault-state.ts` — `kmsKeyId`/`kmsEncryptedDek` columns
- `packages/db/src/migrations/0048_vault_kms_columns.sql` (new)
- `packages/db/src/migrations/meta/_journal.json` — journal entry for migration 0048
- `.env.example` — `VAULT_KMS_ENDPOINT=` documented
- `README.md` — feature-status row + "Known v1 design gaps" bullet updated (AC-24)
- `docs/runbook.md` — KMS integration status section rewritten (AC-25)
- `packages/shared/openapi.json` — regenerated (AC-26)
- `apps/api/src/__tests__/vault-kms-lifecycle.test.ts` (new) — AC-1, AC-6, AC-9, AC-10, AC-14, AC-15, AC-16, AC-20
- `apps/api/src/__tests__/vault-kms-errors.test.ts` (new) — AC-3, AC-4, AC-5, AC-11, AC-12, AC-13
- `apps/api/src/__tests__/vault-errors.test.ts` — AC-2, AC-10 (updated to match the relaxed Zod refine)

## Change Log

- 2026-07-11: Implemented Story 1.14 (AWS KMS unseal mode) via strict TDD across all 26 ACs —
  `KmsKeyProvider`/`AwsKmsProvider`, `kms` branches in init/unseal, migration 0048, README/runbook
  documentation closure, OpenAPI regeneration; moved story to review.
