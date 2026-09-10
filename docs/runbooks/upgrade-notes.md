# Version-ordered upgrade notes

<!-- Verified against packages/db/src/migrations/{0049,0050,0071,0088,0089,0090,0091,0092,0093}*.sql,
     apps/api/src/config/env.ts, apps/api/src/modules/auth/{routes,handoff-boot,handoff-routes}.ts,
     apps/api/src/modules/service-provisioning/service.ts,
     apps/api/src/modules/audit/quota-gate.ts, apps/api/src/workers/audit-storage-check.ts -->

## When to use

Before every upgrade. Read every entry between the version you are on and the version you are moving
to, oldest first — several of them have a required pre-step that must be completed *before* the new
image starts. The generic mechanics live in [`upgrades.md`](upgrades.md); this file is only the
per-version deltas.

Entries are ordered oldest → newest.

---

## Migration `0049` — multi-field secrets prerequisite

`0049_credentials_current_version_id_backfill.sql` adds `credentials.current_version_id` (nullable,
no default) and backfills it for every pre-existing credential, plus adds
`credential_versions.schema_version`/`field_meta` (safe, defaulted column additions — no backfill
UPDATE needed for those two).

It is a **required, ordered prerequisite** for any later structured-multi-field-secrets release: the
migration must be applied and complete before deploying any application version whose code assumes
`current_version_id` is non-null. Deploying such app code first will crash on any row the backfill
has not yet reached, or read `NULL` and mis-render.

1. Run `make db-migrate` (or the standard in-place upgrade) — no separate step, this ships like any
   other migration.
2. Confirm it completes with **zero skipped/orphaned rows** before deploying the new application
   image. The migration logs a `RAISE NOTICE` per skipped (zero-version) credential, naming only its
   id (never `encrypted_value` or any plaintext field), plus a final summary:
   `N credentials backfilled, M skipped (zero versions) - see notices above for ids`. A non-zero `M`
   is not a migration failure — the migration still exits `0` — but it flags pre-existing orphaned
   credentials worth investigating separately.
3. **Re-run safety:** the backfill UPDATE is idempotent (guarded by `WHERE current_version_id IS
   NULL`). If the migration step is interrupted, re-running `make db-migrate` is always the correct
   recovery action; no manual cleanup is required.
4. **Maintenance window:** this backfill is a single, unbatched `UPDATE`, validated for fleets up to
   low tens of thousands of credentials. If your `credentials` table is significantly larger, run
   this migration during a low-traffic window — an unbatched UPDATE at that scale can hold a
   table-level lock long enough to cause visible latency on concurrent credential reads/writes. No
   batching is implemented.

---

## Migration `0050` — staged rotation state machine

`0050_staged_rotation_state_machine.sql` inverts credential "current version" selection from
unconditional-highest-version-number to a `credential_versions.promoted_at`-gated query, and widens
`rotations.status` to add `staged`/`promoted`/`retired`. **This is the most safety-critical migration
this project has shipped for the rotation subsystem** — get the backfill ordering wrong and every
in-flight rotation at deploy time either loses its new value's visibility or silently un-serves a
value dependent systems have already switched to.

1. Any `rotations` row still `status = 'in_progress'` when this migration runs is migrated to
   `status = 'promoted'` (**not** `staged`) — its new value is already live/servable under the older
   model, and moving it to `staged` would immediately revert
   `GET .../credentials/:id/value` to the old, pre-rotation value for that credential, with zero
   warning. This is intentional — do not "fix" it to `staged` in a future edit.
2. Every other `credential_versions` row (not touched by step 1) gets `promoted_at = created_at` —
   the ordinary blanket backfill, matching the previous behavior for every credential whose rotation
   history is already terminal (`completed`/`abandoned`/`stale_recovery`/`break_glass_complete`) or
   has never been rotated.
3. **Self-verification — read this before trusting a green migration run.** The migration ends with a
   `DO $$ ... RAISE NOTICE 'migration 0050: N credential(s) failed the exactly-one-current-version
   invariant check (expected 0)' ... END $$` block. **Grep the migration output for that line and
   confirm `N` is `0`** before considering the deploy successful. A non-zero count means some
   credential's "current" version selection is ambiguous or wrong and needs manual investigation
   (query `credential_versions WHERE credential_id = '<id>' ORDER BY promoted_at DESC, version_number
   DESC` for the affected credential) — not a reason to roll back blindly.
4. **Re-run safety:** both backfill `UPDATE`s are idempotent (guarded by `WHERE status =
   'in_progress'` and `WHERE promoted_at IS NULL`). If interrupted mid-run, re-running
   `make db-migrate` is the correct recovery.
5. **No maintenance window strictly required** — the backfills are set-based but scoped by
   status/null checks, not a full-table rewrite. Still validated only for fleets up to low tens of
   thousands of credentials; a significantly larger `rotations`/`credential_versions` table warrants
   the same low-traffic caution as `0049`.
6. Once this migration lands, the legacy `POST .../rotations/:rotationId/complete` route is reachable
   **only** for rows still `in_progress` — a shrinking population. Expect that route's call volume to
   trend toward zero as those rows are individually retired via `POST .../retire`.

---

## Migration `0071` — dedicated admin pool role (`vault_admin`)

**Required pre-step: provision the role credential before the new image starts.** After this
migration, the API refuses to boot unless `ADMIN_DATABASE_URL` reaches the dedicated `vault_admin`
role (`rolsuper=false`, `rolbypassrls=true`). Existing deployments still pointing this setting at
`postgres` must rotate before deploying. Do not restore service by pointing it back at a superuser.

Run the steps in this order:

1. Run `make db-migrate` (or `pnpm db:migrate`) with the migration-only superuser connection.
   `0071_admin_pool_role` creates the role and its explicit table grants, but does **not** install a
   usable credential.
2. Provision `vault_admin`'s credential through your deployment secret manager.
3. Set `ADMIN_DATABASE_URL` to that role everywhere the API runs. Before restarting, verify it with
   the deployment's existing environment:

   ```bash
   pnpm check-admin-pool
   # → Admin pool preflight OK: role=vault_admin rolsuper=false rolbypassrls=true
   ```

   It reports only the role and its flags, never the DSN. Any other line (`Admin pool preflight
   failed: <status>.`) means the API will refuse to boot — fix the credential before restarting.
4. Deploy/restart the API and re-run `pnpm check-admin-pool`, or confirm the startup log reports the
   same `role=vault_admin rolsuper=false rolbypassrls=true` identity.

Docker Compose runs a local-only credential-provisioning service between `migrate` and `api`.
Production/Fly operators must provision the role credential separately.

**Rollback:** to roll the image back, keep the narrowed role configured — the older image accepts it.
Only drop the role after rotating away from it and redeploying the older image.

---

## Per-org audit storage quotas become the default

Two `apps/api/src/config/env.ts` defaults flipped together:

| Variable                              | Old default     | New default    |
| ------------------------------------- | --------------- | -------------- |
| `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` | `false`         | `true`         |
| `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB`  | `0` (unlimited) | `2048` (2 GiB) |

**Why.** Previously, an organization with no explicit `audit_storage_quota_config` row was fully
unbounded — the master kill switch defaulted off, and even if it were on, the fallback quota was `0`
("unlimited"). This closes that gap: on a fresh install, or any upgrading instance that has never
touched these two variables, every unconfigured org is now bounded at a conservative 2 GiB logical
default. Design rationale: [`docs/design/audit-quota.md`](../design/audit-quota.md).

**Check before upgrading whether any existing org would immediately exceed the new default.** Run
directly against your database (adjust the threshold if you plan a different
`AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB`):

```sql
SELECT usage.org_id, usage.bytes_used
FROM audit_org_storage_usage usage
LEFT JOIN audit_storage_quota_config cfg ON cfg.org_id = usage.org_id
WHERE cfg.org_id IS NULL          -- no explicit per-org quota row. NOT the same as an explicit NULL
                                  -- quota row, which is an operator's deliberate "unlimited"
                                  -- override and is correctly excluded here.
  AND usage.bytes_used > 2147483648  -- 2048 MB * 1048576, in bytes
ORDER BY usage.bytes_used DESC;
```

For each org this returns, before upgrading you can either:

- Raise that org's explicit quota via `PUT /api/v1/admin/orgs/:orgId/audit-quota` (or the equivalent
  web page), so it never resolves to the instance default at all, or
- Set a higher `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB` in `.env` before deploying, so the instance-wide
  fallback covers this org's current usage.

**To opt out entirely**, set `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=false` in your own `.env`. That
gets you exactly the previous shipped behavior, unconditionally — the kill switch is checked first,
in process memory, before any database access. `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB=0` also remains a
valid, still-honored value meaning "no instance-wide fallback" if you set it explicitly.

**If you do not run the query above before upgrading:** the daily `audit-storage/check` job (cron
`0 4 * * *`) includes an early-warning step — within 24 hours of upgrading, any org already over the
new default is WARN-logged (`AUDIT_ORG_DEFAULT_QUOTA_ALREADY_EXCEEDED`) naming the org id, its
current `bytes_used`, and the resolved default quota. This is a pure read, never a refusal, but it is
a same-day, after-the-fact signal rather than a before-you-upgrade one.

Both variables are parsed once at boot. Changing either in `.env` requires an **API restart**.

### Related: the instance-wide audit-write circuit breaker was deleted

**The instance-wide audit-write circuit breaker (`isAuditStorageMaintenanceModeActive()` as a write
gate, `shouldSuppressAuditWrite()`) was deleted, not converted.** Previously, a single active
`audit_storage.critical` alert silently suppressed non-security-critical audit writes for **every**
organization on the instance — the write appeared to succeed (2xx) but no audit row was recorded.

Today a write is refused only if the **writing organization itself** is over its own configured
quota (`503 audit_quota_exhausted`). Instance-wide utilization is still measured and alerted
(80/90/95% tiers, unchanged), but no longer gates anyone's writes. In a default deployment this is
strictly an improvement: writes that used to be silently dropped now succeed and are recorded.

Operational consequence: there is **no** "audit writes are suspended" state to reason about any
more. When `audit_storage.critical` fires while every org is inside its own quota, follow
[`audit-storage-exhaustion.md`](audit-storage-exhaustion.md).

---

## CentralizeMe browser handoff variables

The handoff feature is opt-in via `VAULT_HANDOFF_ENABLED`. If you enable it, you must also provision
`VAULT_HANDOFF_INSTANCE_ID` and `VAULT_HANDOFF_VERIFY_KEYS` **in the same change** — the API now
validates them at boot and will not start into a half-configured state where native login is also
excluded. Full matrix and formats: [`handoff-instance-identity.md`](handoff-instance-identity.md).

All three are parsed once at boot; every change requires a restart of every instance
([`handoff-key-rotation.md`](handoff-key-rotation.md)).

A restore or redeploy to a **new** host must be provisioned with a **new**
`VAULT_HANDOFF_INSTANCE_ID`, agreed with the CentralizeMe directory out of band — never inherit the
old one ([`disaster-recovery.md`](disaster-recovery.md)).

---

## Upgrading to 1.2.0

Five migrations ship in this release: `0089`–`0093`. Read all of the sub-sections below before
starting; two of them can block boot and one can hold a long lock on your largest table.

### Migrations `0089`–`0093`

| Migration | What it does | Operator impact |
| --- | --- | --- |
| `0089` | `notification_queue`: adds `provider_id`, `provider_message_id`, `last_event_at`; widens the status CHECK to `pending`/`sent`/`delivered`/`bounced`/`failed`/`suppressed`; adds a partial unique index on `(provider_id, provider_message_id)` | Metadata-only. None. |
| `0090` | Narrow column-level `GRANT SELECT (id, org_id, provider_id, provider_message_id) ON notification_queue TO vault_admin` | None. Requires `vault_admin` to exist — see the `0071` entry above. |
| `0091` | Chain-links audit HMACs: adds `previous_entry_hmac` + `chain_seq` to **both** `audit_log_entries` and `platform_audit_events`, backfills both, then makes `chain_seq` `NOT NULL GENERATED ALWAYS AS IDENTITY` and indexes it | **Backfill cost — see below.** |
| `0092` | New `extension_lifecycle_events` outbox table (org-scoped, status CHECK, pending partial index) | Purely additive. None. |
| `0093` | `notification_queue`: adds `origin_extension_name` + a partial index for extension-origin rate limiting | Metadata-only. None. |

### `0091` backfill cost — plan a window

`0091` is the only migration in this release with a real runtime cost, and it scales with the size of
your audit tables. It runs **four full-table `UPDATE` statements** — a `row_number()` pass and a
`LAG()` pass over each of `audit_log_entries` and `platform_audit_events` — inside a single
transaction, followed by `SET NOT NULL` and two unique index builds per table.

- On an instance with a large, long-lived `audit_log_entries` table this is the most expensive
  migration this project has shipped. Budget for it, and run it in a low-traffic window.
- The migration deliberately avoids the worst case: it does **not** use
  `ADD COLUMN ... NOT NULL GENERATED ALWAYS AS IDENTITY` (which this project's own
  `guarded-migrate.ts` refuses outright, and which would hold `ACCESS EXCLUSIVE` for the whole
  backfill). It adds nullable columns first (metadata-only, fast), backfills with ordinary UPDATEs,
  then enforces `NOT NULL` (cheap once no NULLs remain) and converts the column to
  `GENERATED ALWAYS AS IDENTITY` (metadata-only). The expensive part is the row churn of the
  backfill itself and the subsequent index builds, not a table-rewriting lock.
- **Take a verified backup first** ([`backup-restore.md`](backup-restore.md)). Audit tables are
  append-only compliance records.
- **Verify after:** run an audit-log integrity check on both logs
  (`GET /api/v1/org/audit/verify` and `GET /api/v1/platform/audit/verify` — see
  [`monitoring.md`](monitoring.md)). The backfill retroactively links historical rows, so both should
  pass. Rows written before this migration keep their original `hmac` values untouched.
- **Rollback:** there is none for the identity-column conversion short of a restore. Do not attempt to
  roll back the schema by hand — roll back to a backup taken before the migration if you must.

### Twelve production secrets are now required, and dev values are rejected

A production boot (`NODE_ENV=production`) now requires all twelve of these to be set, at least 32
characters, distinct from each other where the code says so, and **not** equal to any of the
published dev-only values or a recognizable placeholder:

`SESSION_SECRET`, `REFRESH_TOKEN_HMAC_SECRET`, `TOTP_REPLAY_HMAC_SECRET`,
`MFA_PENDING_SESSION_HMAC_SECRET`, `INVITATION_TOKEN_HMAC_SECRET`, `RECOVERY_TOKEN_HMAC_SECRET`,
`API_KEY_HMAC_SECRET`, `MACHINE_JWT_SECRET`, `STATUS_PAGE_TOKEN_HMAC_SECRET`,
`ERASURE_EMAIL_HASH_SECRET`, `SSO_STATE_HMAC_SECRET`, `OPERATIONAL_STATUS_TOKEN_HMAC_SECRET`.

If any instance was running on a dev-shaped value (the repeated single-character strings shipped for
local development), the API now refuses to boot with a `FATAL:` env issue naming the exact variable.
This is a hard gate, not a warning.

**Pre-step:** generate real values and put them in your secret manager *before* deploying. This is a
first-time rotation for anything previously left on a dev value — read
[`secret-rotation.md`](secret-rotation.md) for the per-secret blast radius, because several of these
invalidate outstanding tokens, keys, or links the moment they change.

### `POST /api/v1/auth/register` self-signup now returns `202`, not `201`

Self-signup returns `202` with a fixed generic body
(`{"message":"If that email is available, your account has been created and you can sign in."}`)
regardless of whether the email was novel or already registered — the response no longer
distinguishes the two, so it cannot be used to enumerate accounts. The `201`-with-body response now
occurs only on the invitation-acceptance path.

**Anything scripted against a `201` from self-signup — provisioning scripts, smoke tests, CI
bootstrap steps — will break.** Accept `202` and confirm the account by signing in, not by reading
the register response.

### Service-provisioned org members require a CentralizeMe link

Provisioning a new member into an organization through the service route now fails closed with
`403 {"code":"organization_not_centralizeme_managed"}` when that organization's
`centralizeme_organization_id` is `NULL`. Migration `0088` added the column (nullable, with a partial
unique index) and pre-existing organizations have it unset.

**Pre-step for CentralizeMe-linked deployments:** ensure every organization CM provisions into is
linked before CM's next provisioning call, otherwise those calls start returning `403`. The column is
also what a handoff token's `organizationId` claim is matched against, so an unlinked org cannot be
the target of a browser handoff either.

Purely self-hosted instances that never use the service-provisioning or handoff routes are
unaffected.

### Per-account login lockout defaults

Login lockout is on by default and is **separate** from the informational failed-auth alert:

| Variable                             | Default | Range     | Effect                                                                |
| ------------------------------------ | ------- | --------- | --------------------------------------------------------------------- |
| `LOGIN_LOCKOUT_THRESHOLD`            | `10`    | 3–100     | Failed attempts within the window before login is **blocked outright** |
| `LOGIN_LOCKOUT_WINDOW_SECONDS`       | `900`   | 60–3600   | The rolling window (15 minutes)                                       |
| `FAILED_AUTH_THRESHOLD_COUNT`        | `10`    | 3–100     | Attempts before an **informational operator alert**; never blocks      |
| `FAILED_AUTH_THRESHOLD_WINDOW_SECONDS` | `300` | 60–3600   | The alert's window (5 minutes)                                        |

`LOGIN_LOCKOUT_*` drives a synchronous, blocking check inside the login path.
`FAILED_AUTH_THRESHOLD_*` drives an async alerting worker only. They read the same
`failed_auth_attempts` table but are independently tunable on purpose — changing one does not change
the other.

**Operator impact:** an org whose users habitually fumble passwords, or an automated client
re-trying a stale credential, can now lock an account for up to 15 minutes. If that is too tight for
your deployment, raise `LOGIN_LOCKOUT_THRESHOLD` or shorten `LOGIN_LOCKOUT_WINDOW_SECONDS` in `.env`
and restart the API. Both are parsed at boot.
