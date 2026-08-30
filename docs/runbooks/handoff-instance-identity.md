# Handoff instance identity, key set, and clock-skew signal (Story 30.1)

<!-- Source: Story 30.1 (DW-129) AC12/AC13; verified against apps/api/src/config/env.ts,
     apps/api/src/modules/backup/filename.ts:20-28, apps/api/src/workers/clock-skew-check.ts,
     apps/api/src/extensions/status-routes.ts,
     _bmad-output/planning-artifacts/handoff-token-claim-contract.md -->

This story lays the config/boot groundwork for the CentralizeMe-to-Project-Vault authenticated
browser handoff (Story 30.2 builds the actual `/auth/handoff/prepare`/`/auth/handoff/confirm`
routes and EdDSA verification on top of it): a stable, operator-provisioned instance identity, a
boot-validated set of trusted verification public keys, and a diagnostic signal for local-clock
drift against Postgres. None of the three variables below are consumed by any route yet — Story
30.2 is the first thing that reads them at request time.

## `VAULT_HANDOFF_INSTANCE_ID`

A stable, operator-provisioned identity string for this Project Vault instance, checked by Story
30.2's verifier against a handoff token's `aud`/`instanceId` claim (claim contract, "Instance
identity decision"; rejection-matrix row 6, `handoff_audience_mismatch`).

- **Format:** 3–63 lowercase DNS-label characters — `^[a-z][a-z0-9-]{1,61}[a-z0-9]$`. Must start
  and end with a lowercase letter or digit; no uppercase, no underscore. The claim contract's
  worked example is `app001`.
- **Optional at this stage:** unset is allowed — no PV instance in the fleet is required to
  provision a handoff instance ID it may never use. Story 30.2 is responsible for refusing to
  register the handoff `AuthStrategy` when this is unset; that strategy does not exist yet.
- **Boot behavior:** whenever a value IS present, it must satisfy the format rule above, or boot
  fails with a `FATAL:`-prefixed message in the same "Missing or invalid environment variables"
  block every other fatal env issue in `apps/api/src/config/env.ts` uses, and the process exits.

### ⚠️ `resolveInstanceId()` is a different, unrelated value — do not confuse or reuse it

`apps/api/src/modules/backup/filename.ts:20-28` also has a function named `resolveInstanceId()`.
**It is not this value.** It disambiguates encrypted backup filenames by reading the most recent
`backup_runs.filename` row's embedded UUID, or generating a fresh `randomUUID()` when no backup
exists yet. It regenerates over time and carries no audience-identity meaning. It is used in
exactly one place (`apps/api/src/modules/backup/service.ts:144`) and has nothing to do with
authentication. Never wire backup-filename disambiguation logic into handoff verification, and
never treat a `VAULT_HANDOFF_INSTANCE_ID` value as backup-filename state.

## `VAULT_HANDOFF_VERIFY_KEYS`

A JSON array of EdDSA public keys this instance trusts to verify inbound handoff tokens (claim
contract, "Key provisioning, rotation, and compromise response": "A missing/unparseable key set
is a boot error").

**This story validates JSON/array/object shape and PEM envelope syntax only** — it never calls
`crypto.createPublicKey()` or otherwise attempts to construct/use an Ed25519 key from the PEM.
Verifying that a PEM string actually decodes to a valid Ed25519 key (`alg: EdDSA` specifically) is
Story 30.2's request-time job.

### Shape

```json
[
  {
    "kid": "2026-08-key-1",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----"
  }
]
```

- `kid` — 1–128 ASCII characters, unique across the array. Identifies which key signed a given
  token so a verifier (Story 30.2) can pick the right one without trying every key.
- `publicKeyPem` — a syntactically well-formed PEM block: must contain both
  `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`.

### Boot behavior

| Input | Outcome |
|---|---|
| Unset | Allowed at this stage — parses to an empty list. Same reasoning as `VAULT_HANDOFF_INSTANCE_ID`: no route consumes it yet. |
| `[]` (empty array) | Treated identically to "unset" for this story — parses successfully. Story 30.2 decides what an empty trusted-key set means for strategy registration (almost certainly: refuse to register, since no token could ever verify). |
| Valid array of `{ kid, publicKeyPem }` | Parses successfully; exposed via `parseHandoffVerifyKeys()`/the cached `handoffVerifyKeys` export in `apps/api/src/config/env.ts` for Story 30.2 to import directly (never re-parses raw env text per request). |
| Not valid JSON, not an array, a duplicated `kid`, or a `publicKeyPem` missing its PEM header/footer | Boot `FATAL:` env issue — process exits, same mechanism as `VAULT_HANDOFF_INSTANCE_ID`. Never a silently-ignored value, never a runtime 500 on first use. |

## Clock-skew magnitude signal (W2 mitigation)

The claim contract flags clock skew as a residual risk (W2: "no clock-drift detector or skew
metric today"). This story adds one: at boot, and every 5 minutes thereafter
(`apps/api/src/workers/clock-skew-check.ts`, registered in `apps/api/src/main.ts` as the
`handoff/clock-skew-check` job, reusing the same pg-boss cron-scheduling pattern as
`prune-revoked-tokens`), the API process runs a single lightweight `SELECT now()` round-trip
against Postgres — already the trusted, always-present reference clock in this architecture, so
this introduces no new dependency such as NTP — and computes:

```
driftMs = abs(localNow - dbNow - roundTripEstimate)
```

- **`info`-level `clock_skew.measured` log** when `driftMs` is under the threshold.
- **`warn`-level `clock_skew.measured` log** when `driftMs` meets or exceeds
  `VAULT_HANDOFF_CLOCK_SKEW_WARN_MS` (default `20000`ms — deliberately tighter than the 30-second
  `JWT_MAX_CLOCK_SKEW_SECONDS`-style tolerance Story 30.2's verifier will use, so this warning
  fires before the verifier would actually start rejecting handoff tokens on clock-skew grounds).
- **`warn`-level `clock_skew.check_failed` log**, never `fatal`, when the `SELECT now()`
  round-trip itself fails (DB unreachable, connection pool exhausted). That cycle's measurement is
  skipped; the process keeps running and the previous diagnostics value is left in place — this is
  a diagnostic signal, not a startup gate. (This repository's actual replay-safety property comes
  from the durable JTI burn Story 30.2 builds, not from clock precision.)

### Where an operator finds it

- **Log events:** `clock_skew.measured` / `clock_skew.check_failed`
  (`packages/shared/src/constants/operational-event-types.ts`).
- **Admin diagnostics route:** `GET /api/v1/admin/extensions/status` (the same envelope that
  carries `nativeLoginPolicy.state`, see `docs/runbooks/native-login-exclusion.md`) now also
  returns:

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

  `status` is `unknown` until the first measurement completes (the boot-time one-shot run makes
  this window brief), `ok` below the threshold, and `warn` at or above it.

### Concurrency

Safe to run concurrently with itself (a single Node.js event loop per process; no shared mutable
state beyond the interval timer) and safe across multiple replicas of the same instance, each
measuring its own local drift independently against the same Postgres primary — no coordination or
locking is required, since each replica's drift measurement is local diagnostic information about
that replica's own clock, not a replica-shared resource.

## Restore/redeploy to a new instance

Per the claim contract's "Instance identity decision": a restore to a new physical/virtual
instance must be provisioned with a **new** `VAULT_HANDOFF_INSTANCE_ID` value, agreed with the CM
directory out-of-band, rather than inheriting the old one automatically. This story does not build
any migration/carry-forward mechanism for the value — it is deployment configuration, not
application state, and always requires explicit operator action on a restore/redeploy to a
different instance.

## Cross-link

Story 30.2 will add a key-rotation and compromise-response runbook alongside this one, covering
what to do when a `VAULT_HANDOFF_VERIFY_KEYS` entry needs to be rotated or revoked. That runbook
does not exist yet at the time this document was written — this is a forward-reference only.
