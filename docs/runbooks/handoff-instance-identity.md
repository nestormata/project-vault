# Handoff instance identity, key set, and clock-skew signal

<!-- Verified against apps/api/src/config/env.ts (parseHandoffVerifyKeys, handoffVerifyKeys),
     apps/api/src/modules/auth/handoff-boot.ts, apps/api/src/modules/auth/handoff-routes.ts,
     apps/api/src/modules/auth/handoff-verify.ts, apps/api/src/workers/clock-skew-check.ts,
     apps/api/src/main.ts, apps/api/src/extensions/status-routes.ts,
     apps/api/src/modules/backup/filename.ts -->

## When to use

Configuring, changing, or diagnosing the CentralizeMe-to-Project-Vault authenticated browser handoff
on this instance. Rotating the signing keys has its own runbook:
[`handoff-key-rotation.md`](handoff-key-rotation.md).

This is the configuration reference for three environment variables and one diagnostic signal. The
routes that consume them — `POST /api/v1/auth/handoff/prepare` and
`POST /api/v1/auth/handoff/confirm`, with an EdDSA compact-JWS verifier and a durable single-use
`jti` burn — are live.

All three variables are parsed once, at boot. **Every change requires a restart.**

---

## `VAULT_HANDOFF_ENABLED`

The explicit opt-in toggle. Unset (the default) means handoff auth is not registered at all, even if
the other two variables happen to be configured — their presence alone never implies enablement.

### Boot behaviour matrix

| `VAULT_HANDOFF_ENABLED` | Instance ID + verify keys | Native login | Outcome |
| --- | --- | --- | --- |
| unset / false | anything | anything | Handoff auth silently not registered. No error. |
| set | both present and valid | anything | Handoff auth registered; an informational log line records it. |
| set | either missing or empty | **enabled** | **`fatal`-level log**, handoff auth NOT registered, native login remains the usable login path. Fail-safe: the instance still boots and people can still sign in. |
| set | either missing or empty | **excluded** | **The API refuses to boot.** A log line with no usable login path is not acceptable, so the process throws rather than starting into a configuration nobody can log in to. |

The last row is the one that bites during a migration or a restore: if this instance excludes native
login ([`native-login-exclusion.md`](native-login-exclusion.md)) and you enable handoff without
provisioning both values in the same change, the API will not start.

---

## `VAULT_HANDOFF_INSTANCE_ID`

A stable, operator-provisioned identity string for this instance, checked by the verifier against a
handoff token's audience/`instanceId` claim (a mismatch rejects as `handoff_audience_mismatch`).

- **Format:** 3–63 lowercase DNS-label characters — `^[a-z][a-z0-9-]{1,61}[a-z0-9]$`. Must start and
  end with a lowercase letter or digit; no uppercase, no underscore. A worked example is `app001`.
- **Optional when handoff is disabled:** unset is allowed — no instance in the fleet is required to
  provision an identity it may never use.
- **Boot behaviour:** whenever a value *is* present it must satisfy the format rule, or boot fails
  with a `FATAL:`-prefixed message in the same "Missing or invalid environment variables" block every
  other fatal env issue uses, and the process exits.

### ⚠️ `resolveInstanceId()` is a different, unrelated value

`apps/api/src/modules/backup/filename.ts` also has a function named `resolveInstanceId()`. **It is not
this value.** It disambiguates encrypted backup filenames by reading the most recent
`backup_runs.filename` row's embedded UUID, or generating a fresh `randomUUID()` when no backup exists
yet. It regenerates over time and carries no audience-identity meaning; it is used in exactly one
place, in the backup service, and has nothing to do with authentication.

Never wire backup-filename disambiguation into handoff verification, and never treat a
`VAULT_HANDOFF_INSTANCE_ID` value as backup-filename state.

---

## `VAULT_HANDOFF_VERIFY_KEYS`

A JSON array of EdDSA public keys this instance trusts to verify inbound handoff tokens. A
missing or unparseable key set is a boot error.

```json
[
  {
    "kid": "2026-08-key-1",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----"
  }
]
```

- `kid` — 1–128 ASCII characters, unique across the array. Identifies which key signed a given token
  so the verifier can select it directly rather than trying every key.
- `publicKeyPem` — a syntactically well-formed PEM block: must contain both
  `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`.

Boot-time parsing validates JSON/array/object shape and PEM envelope syntax only. Verifying that a
PEM string actually decodes to a usable Ed25519 key is done at request time by the verifier.

| Input | Outcome |
| --- | --- |
| Unset | Parses to an empty list. Allowed while handoff is disabled; combined with `VAULT_HANDOFF_ENABLED` it hits the boot matrix above. |
| `[]` (empty array) | Identical to unset — parses successfully, then counts as "no keys" for the boot matrix. No token could ever verify against an empty set. |
| Valid array of `{ kid, publicKeyPem }` | Parses successfully; exposed as the cached `handoffVerifyKeys` export, never re-parsed per request. |
| Not valid JSON, not an array, a duplicated `kid`, or a `publicKeyPem` missing its PEM header/footer | Boot `FATAL:` env issue — the process exits. Never a silently-ignored value, never a runtime 500 on first use. |

---

## Clock-skew magnitude signal

At boot, and every 5 minutes thereafter (`apps/api/src/workers/clock-skew-check.ts`, registered as
the `handoff/clock-skew-check` job), the API runs a single lightweight `SELECT now()` round-trip
against Postgres — already the trusted, always-present reference clock in this architecture, so this
introduces no new dependency such as NTP — and computes:

```
driftMs = abs(localNow - dbNow - roundTripEstimate)
```

- **`info`-level `clock_skew.measured` log** when `driftMs` is under the threshold.
- **`warn`-level `clock_skew.measured` log** when `driftMs` meets or exceeds
  `VAULT_HANDOFF_CLOCK_SKEW_WARN_MS` (default `20000` ms — deliberately tighter than the verifier's
  own clock-skew tolerance, so this warning fires *before* the verifier would start rejecting handoff
  tokens on clock-skew grounds).
- **`warn`-level `clock_skew.check_failed` log**, never `fatal`, when the round-trip itself fails (DB
  unreachable, connection pool exhausted). That cycle's measurement is skipped, the process keeps
  running, and the previous diagnostics value is left in place. This is a diagnostic signal, not a
  startup gate — the replay-safety property comes from the durable `jti` burn, not from clock
  precision.

### Where an operator finds it

- **Log events:** `clock_skew.measured` / `clock_skew.check_failed`.
- **Admin diagnostics route:** `GET /api/v1/admin/extensions/status` (admin + MFA; the same envelope
  that carries `nativeLoginPolicy.state`) also returns:

  ```json
  {
    "clockSkew": {
      "lastMeasuredMs": 42,
      "measuredAt": "2026-08-30T09:00:00.000Z",
      "warnThresholdMs": 20000,
      "status": "ok"
    }
  }
  ```

  `status` is `unknown` until the first measurement completes (the boot-time one-shot run makes this
  window brief), `ok` below the threshold, and `warn` at or above it.

### Fix, when it warns

Correct the host's clock (NTP/chrony on the API host, or the hypervisor's time source) and confirm
`status` returns to `ok` on the next 5-minute cycle. A persistent warning means handoff logins are at
risk of rejection even though nothing about the keys or the token is wrong.

Each API process measures its own drift independently against the same Postgres primary — no
coordination or locking is required, and the diagnostics route reports only the answering process's
measurement.

---

## Restore or redeploy to a new instance

A restore to a new physical or virtual instance must be provisioned with a **new**
`VAULT_HANDOFF_INSTANCE_ID`, agreed with the CentralizeMe directory out of band, rather than
inheriting the old one automatically. There is deliberately no migration or carry-forward mechanism:
this is deployment configuration, not application state, and it always requires explicit operator
action. See [`disaster-recovery.md`](disaster-recovery.md).
