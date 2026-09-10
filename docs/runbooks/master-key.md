# Master key management

<!-- Verified against apps/api/src/modules/vault/{schema,key-service,kms-provider}.ts,
     packages/db/src/schema/vault-state.ts, apps/api/src/workers/key-custody-check.ts,
     apps/api/src/config/env.ts -->

## When to use

Choosing a key mode at init, responding to the `key_custody_risk` alert, handling a KMS failure, or
facing lost key material. Unsealing itself is in [`vault-lifecycle.md`](vault-lifecycle.md).

---

## The four key modes

| Mode | Operator supplies at unseal | Custody model | Recommended for |
| --- | --- | --- | --- |
| `kms` | nothing (empty body) | AWS KMS holds the wrapping key; only a wrapped data key is stored in `vault_state` | Production on AWS |
| `envelope` | the file-half path (the env-half is read from the container's own environment) | split: `VAULT_ENVELOPE_KEY_HALF` env var + a key file under `VAULT_KEY_DIR` | Self-hosted production |
| `passphrase` | the passphrase | a human-held secret | Small deployments with disciplined password-manager custody |
| `file` | the key file path | a single raw key file, co-located with the app | **Not recommended for production** — requires an explicit `acknowledgeCoLocationRisk: true` at init |

The mode is chosen once, at `init`, and is stored in `vault_state`. **There is no in-place
mode-conversion path** — see "Changing key material or key mode" below.

---

## Changing key material or key mode — not supported in v1

**Master-key rotation is not supported in v1. There is no procedure, no endpoint, no script, and no
SQL to run.** The same is true of converting an instance from one `kmsType` to another (for example
`file` → `envelope`): no in-place conversion exists.

The only path that changes an instance's key material is:

1. Export the data by ordinary application means (project/credential export, audit export).
2. Stand up a **fresh instance** and `init` it with the new key material or the new mode.
3. Re-import into the new instance.

**Every existing encrypted backup stays tied to the old key.** The backup encryption key is derived
from the master key, so backups taken under the old key cannot be restored into the new instance —
a restore attempt returns `401 {"code":"backup_decrypt_failed"}`. Keep the old instance's key
material in custody for as long as you need those backups to remain readable, and treat the cutover
as a migration with its own retention plan, not a rotation.

Do not attempt to "re-run the init-time key derivation with new material" against a live database.
Nothing in this codebase supports it, and a partially re-keyed `vault_state` makes existing
ciphertext unreadable with no recovery path.

### Consequence for the `key_custody_risk` alert

`vault_state.key_rotated_at` is set once, at initialization, and **no application code path ever
advances it**. The age-based alert (`key_custody_risk`, fires by default after
`KEY_ROTATION_MAX_AGE_DAYS` = 365 days since `key_rotated_at`) therefore measures the age of the
instance's original key material, which — given that rotation is not supported — is exactly what it
should measure.

Treat the alert as "this instance has been running on its original key for a year; review your key
custody, and decide whether the export/re-init/re-import migration above is warranted." It is not
telling you to run a rotation procedure, because there is none. There is no in-app way to reset the
timestamp; if you complete a migration, the new instance starts its own clock.

Also note: **KMS-mode credential rotation is a different thing and is transparent.** Rotating the
AWS credentials the API uses (an IAM role session refresh, or swapping env vars and restarting)
requires no action here — the server never stores or depends on init-time credentials; each request
resolves credentials fresh via the AWS SDK's standard chain. What does not exist is **data-key**
rotation: re-wrapping the stored `kms_encrypted_dek` under a new KMS key.

---

## Lost key material — unrecoverable

**If the key material required to unseal is genuinely lost, the data is unrecoverable.** There is no
master-key-recovery mechanism, backdoor, or support escalation path that can decrypt existing data
without the original key material. This is a deliberate architectural property (AES-256-GCM under a
master-key-derived key hierarchy). Losing the master key is equivalent to losing every secret,
credential, and audit-log signing key it protects.

This applies identically to each mode, and to **each half** of an envelope-mode key:

| What is lost | Recoverable? | Symptom |
| --- | --- | --- |
| `passphrase` mode: the passphrase, with no password-manager record | **No** | `401 unseal_failed` |
| `file` mode: the key file, with no backup | **No** | `400 key_file_not_found`, or `401 unseal_failed` if a wrong file is present |
| `envelope` mode: the **file-half** (`envelopeKeyPath`, under `VAULT_KEY_DIR`) | **No** — the env-half alone is useless | `400 key_file_not_found` |
| `envelope` mode: the **env-half** (`VAULT_ENVELOPE_KEY_HALF`) | **No** — the file-half alone is equally useless | `401 unseal_failed` (the file exists, so this is not a `key_file_not_found`) |
| `kms` mode: the KMS key deleted past its pending-deletion window | **No** | `503 kms_key_unavailable` |

Both envelope halves are required. Losing either one is exactly as fatal as losing a single-file key
— the split-key model buys you independence of *custody*, so that one compromised or one accidentally
deleted artifact is not immediately fatal **as long as the other half plus a copy of the lost half's
backup still exist**. It does not make the instance recoverable from one half.

The only "recovery" is restoring from a backup encrypted under a **still-available** key — which
itself requires that key material, meaning a truly lost master key also makes all of its own backups
permanently unreadable.

Raw database access (e.g. `psql` as the `postgres` superuser) **cannot** recover data without the
key — the ciphertext is opaque without it, and there is no partial-recovery or brute-force-feasible
path (256-bit key space). Do not attempt this as a "recovery" path.

### Prevention, not recovery

- Prefer `kms` mode where AWS KMS is available: custody, audit and deletion protection are handled by
  a system built for it.
- Otherwise use `envelope` mode with each half under **genuinely independent** custody — for example
  the env-half injected from a secrets manager into the container environment, and the file-half
  stored in a separate offline vault and written into the `vault_keys` volume at deploy time. Storing
  both halves in the same secrets manager, or both in the same backup archive, gives you the
  operational cost of a split key with none of the benefit.
- Never use `file` mode for production.
- Maintain key material under the same operational discipline as your backups: independent, tested,
  access-controlled storage. Record at init time **where each artifact lives**, because the unseal
  procedure needs that answer under time pressure.

---

## KMS mode

### How it works

At init, the server calls AWS KMS `GenerateDataKey` to obtain a plaintext data key (used once to
derive the vault's keys, then zeroed — never stored) and an encrypted ("wrapped") copy of that same
key, which is the only thing persisted in `vault_state` (`kms_key_id`, `kms_encrypted_dek`). At
unseal, the server calls AWS KMS `Decrypt` on the stored wrapped key to recover the same plaintext
data key and re-derive the vault's keys — no passphrase, key file, or envelope half is ever supplied
by the operator in this mode.

V1 scope is AWS KMS only (not GCP KMS or HashiCorp Vault Transit), behind a small `KmsKeyProvider`
interface that keeps the door open for another provider without revisiting the core init/unseal
logic.

### Init and unseal

```bash
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/init \
  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kmsType":"kms","kmsKeyId":"arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr"}'
# → 200 { "initialized": true, "keyVersion": 1, "kmsType": "kms" }

# Every restart — empty body, no credentials in the request:
curl -X POST http://localhost:${API_HOST_PORT}/api/v1/vault/unseal -H "Content-Type: application/json" -d '{}'
# → 200 { "unsealed": true, "keyVersion": 1, "kmsType": "kms" }
```

`kmsKeyId` may be a full key ARN or an `alias/...` KMS alias.

### IAM permissions

On the API process's AWS credentials (ambient IAM role, or `AWS_ACCESS_KEY_ID`/
`AWS_SECRET_ACCESS_KEY` — the same credential-provider chain already used for S3 backup storage):

- `kms:GenerateDataKey` on the configured key — required at init only.
- `kms:Decrypt` on the configured key — required at every unseal.

No KMS-specific credentials env var is required. The only KMS-specific configuration is the optional
`VAULT_KMS_ENDPOINT` (LocalStack/test-only `KMSClient` endpoint override; the API refuses to boot in
production with it set).

### KMS failure modes

| Response | Meaning | Action |
| --- | --- | --- |
| `503 kms_unreachable` | Network/timeout/throttling talking to AWS KMS | Safe to retry once connectivity is restored. This means "try again", not "the key may be gone". |
| `503 kms_key_unavailable` | The configured key is deleted, disabled, or scheduled for deletion | See below — this is the KMS equivalent of losing a key file. |
| `403 kms_permission_denied` | The API's AWS credentials lack `kms:GenerateDataKey` (init) or `kms:Decrypt` (unseal) | Verify the IAM/key policy. |
| `400 kms_key_not_found` (init only) | The `kmsKeyId` does not exist, or is disabled/pending deletion, in the configured region | Verify the ARN/alias and region. |

**There is no failover.** This codebase has no multi-region KMS configuration, no backup key, and no
alternate unseal path for a KMS-mode instance. While KMS is unreachable, the instance is sealed and
cannot serve any request that touches encrypted data — `/ready` returns
`503 {"reason":"sealed"}` and `vault_sealed` is `1`. Plan the availability of the KMS key and its
region as a hard dependency of this instance's availability, and alert on `vault_sealed == 1` for
more than a couple of minutes ([`monitoring.md`](monitoring.md)).

### KMS key loss — permanent data-loss risk

If the configured KMS key is deleted, disabled, or scheduled for deletion, unseal fails with
`503 kms_key_unavailable`. AWS KMS supports a 7–30 day pending-deletion recovery window: restoring or
re-enabling the key within that window and retrying the unseal recovers the vault. **After that
window elapses, the vault's data is permanently unrecoverable.** Treat KMS key-deletion protection
(`kms:ScheduleKeyDeletion` restrictions, deletion-window settings) with the same operational
discipline as backup custody.
