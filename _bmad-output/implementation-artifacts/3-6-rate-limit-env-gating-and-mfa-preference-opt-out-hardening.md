# Story 3.6: Rate-Limit Env Gating & MFA Preference Opt-Out Hardening

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a security-conscious operator of Project Vault,
I want rate-limit enforcement to be gated by an explicit, test-only opt-in flag (never by ambient
`NODE_ENV=test`) and a user's `channel: "none"` notification preference to persist as a durable
suppression rather than silently reverting to defaults,
so that a misconfigured non-test environment can never silently lose brute-force protection, and a
user who explicitly opts out of an alert type (including the new MFA recovery alerts) stays opted
out on every subsequent event.

## Background — Why This Story Exists

This story consolidates two **deferred, decision-needed findings** from Story 3.4's code review
(see `3-4-epic-3-completion-notification-surface-truth-mfa-alerts-and-doc-reconciliation.md` lines
602-603, 638, 742), confirmed during Story 3.6 planning as **not covered by Story 3.5**
(`3-5-credential-expiry-notification-delivery.md` — its AC-W6 `channel: "none"` example only
*assumes* the existing preference-override mechanism works; it does not fix it):

- **Item A (rate-limit env gating):** `isRateLimitEnforced()` in
  `apps/api/src/lib/route-helpers.ts` bypasses `@fastify/rate-limit` registration on
  `authRoutes`/`vaultRoutes` and the in-process `enforceUserRateLimit()` window checker whenever
  `process.env.NODE_ENV === 'test'`. Vitest sets `NODE_ENV=test` **ambiently** for every test run
  (this is Vitest's own default, not something this repo's test helpers set explicitly — confirmed
  by grep: no test helper in `apps/api/src/__tests__/helpers/*.ts` sets `NODE_ENV`). A
  misconfigured staging/smoke-test environment reachable by real traffic that happens to set
  `NODE_ENV=test` (e.g. copying a `.env.test` file, or a CI/staging script that exports it) would
  silently lose brute-force protection on `/login`, `/register`, and `/unseal` with no error, no
  log line, and no test coverage gap surfaced — because the code path *looks* identical to the
  intentional test-bypass path.
- **Item B (MFA/notification preference opt-out is silently ineffective):** `patchPreferences()` in
  `apps/api/src/modules/notifications/preferences.ts` handles `channel: "none"` by **deleting**
  the stored preference row(s) for that `(orgId, userId, alertType)` rather than persisting a
  suppression state. `getPreferences()`'s `fillDefaultPreferences()` then re-fills any
  `(alertType, channel)` pair with no stored row from `DEFAULT_NOTIFICATION_CHANNELS` (currently
  `email` + `inbox`). Net effect: a user who selects "None" for an alert type is opted back in to
  default `email`+`inbox` delivery the moment the delete completes — there is no persisted state
  that means "this user chose to receive nothing for this alert type." This is a **pre-existing
  Story 3.2 bug**, but Story 3.4 is what first exposed it to end users for the two new
  security-sensitive MFA recovery alert types (`security.mfa_recovery_used`,
  `security.mfa_recovery_regenerated`) via the personal-preferences UI — a user believes they
  opted out of MFA recovery alerts and did not.
- **`PUT /preferences` has the identical bug**, not just `PATCH`: `putPreferences()` filters out
  `channel: "none"` entries entirely before insert (`preferences.ts:121`,
  `const toInsert = items.filter((item) => item.channel !== 'none')`), so a full-replace call that
  includes a `"none"` entry silently drops it, and `fillDefaultPreferences()` backfills the default
  channels on the next read — same silent-revert behavior via the other write path.
- **Schema constraint discovery (not previously flagged as a migration item):** the
  `sprint-status.yaml` scheduling note for this story explicitly says "no schema change expected
  for either item; confirm during story creation." During story creation, direct inspection of
  `packages/db/src/schema/notification-preferences.ts` shows a **DB check constraint**:
  `channel IN ('email','slack','inbox')` — `'none'` is not and never has been a storable value.
  **This assumption from the scheduling note is incorrect: persisting a `"none"` suppression state
  requires a migration** to widen the check constraint to `channel IN ('email','slack','inbox','none')`.
  This story includes that migration; it was not optional or avoidable once "persist the
  suppression" was chosen as the fix strategy (the alternative — a separate boolean "muted" column
  or table — would be a larger, riskier change for the same outcome, and the existing unique index
  `uq_notification_preferences (orgId, userId, alertType, channel)` already naturally supports a
  `'none'` row coexisting per alert type without conflict).

## Acceptance Criteria

### AC-1 — `isRateLimitEnforced()` no longer keys off ambient `NODE_ENV`

**Given** any process environment, **when** `isRateLimitEnforced()` is evaluated, **then** its
result depends **only** on a new, dedicated, explicit opt-in environment flag —
`RATE_LIMIT_TEST_BYPASS` — and **never** on `NODE_ENV` alone.

- The flag must default to **unset/false** (rate limiting **enforced**) in every environment,
  including when `NODE_ENV=test`, unless a test explicitly sets `RATE_LIMIT_TEST_BYPASS=true`.
- `RATE_LIMIT_TEST_BYPASS=true` must only take effect when `NODE_ENV === 'test'` **as well** — i.e.
  require both conditions (`NODE_ENV === 'test' && RATE_LIMIT_TEST_BYPASS === 'true'`) so the flag
  can never silently disable rate limiting in a `development` or `production` environment even if
  someone sets it there by mistake. This "flag can never be true outside an actual test run" double
  gate is the core hardening: neither condition alone is sufficient to disable enforcement.
- Add `RATE_LIMIT_TEST_BYPASS` to the Zod env schema in `apps/api/src/config/env.ts` as
  `z.enum(['true', 'false']).default('false')` (string enum, matching the existing pattern for
  other boolean-like env flags in that file — check for an existing convention and follow it
  exactly rather than introducing `z.coerce.boolean()` if the file doesn't already use that
  pattern).

**Example (happy path):** Staging environment has `NODE_ENV=production`,
`RATE_LIMIT_TEST_BYPASS` unset. `isRateLimitEnforced()` returns `true`. `/login` rate limiting is
active; the 6th failed login attempt within the window returns `429`.

**Example (the exact regression this closes):** A misconfigured environment reachable by real
traffic sets `NODE_ENV=test` (e.g. a bad deployment script copies `.env.test`).
`RATE_LIMIT_TEST_BYPASS` is unset (default `false`). **Before this story:** rate limiting was
silently disabled. **After this story:** `isRateLimitEnforced()` still returns `true` because the
bypass flag was never explicitly set — rate limiting remains active despite the `NODE_ENV`
misconfiguration.

**Example (intentional test bypass, still works):** A test file calls
`process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'` in its setup and runs under Vitest (which sets
`NODE_ENV=test` ambiently). `isRateLimitEnforced()` returns `false`; rate-limit registration is
skipped for that test run, matching current bypass behavior for tests that don't test rate
limiting itself.

**Example (flag set in production by mistake):** `NODE_ENV=production`,
`RATE_LIMIT_TEST_BYPASS=true` (e.g. leaked from a shared `.env` template). `isRateLimitEnforced()`
still returns `true` because `NODE_ENV !== 'test'` — the double gate holds even under direct
misconfiguration of the new flag itself.

### AC-2 — Existing rate-limit test suites keep passing with an explicit opt-in

**Given** the 11 test files identified via
`grep -rn "RATE_LIMIT_TEST_ENFORCE" apps/api/src --include=*.test.ts -l` (the old flag name) that
currently rely on the `NODE_ENV=test` implicit bypass or the old `RATE_LIMIT_TEST_ENFORCE=true`
explicit-opt-in-to-enforcement flag, **when** this story lands, **then** every one of them is
updated to use the new `RATE_LIMIT_TEST_BYPASS` semantics with equivalent behavior:

- Test files that want rate limiting **bypassed** (most integration tests that register/log in many
  fixture users but don't test rate limiting itself) explicitly set
  `process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'` in their setup (or via a shared test helper —
  prefer adding this to `configureAuthIntegrationEnv()` in
  `apps/api/src/__tests__/helpers/auth-test-helpers.ts` if the majority of the 11 files already call
  it, to avoid 11 duplicated env-var lines).
- Test files that specifically test rate-limit **enforcement** (e.g.
  `apps/api/src/modules/auth/register-rate-limit.test.ts`) must **not** set
  `RATE_LIMIT_TEST_BYPASS=true` (or must explicitly set it to `'false'`/leave it unset) so
  enforcement stays active for those assertions — this replaces the old inverted
  `RATE_LIMIT_TEST_ENFORCE=true` opt-in-to-enforcement flag with the new opt-out-of-enforcement
  default-enforced model.
- `apps/api/src/lib/secure-route.test.ts` and `apps/api/src/__tests__/vault-lifecycle.test.ts`
  (named in Story 3.4's deferred `RATE_LIMIT_TEST_ENFORCE` shared-mutation finding) are included in
  this migration; the cross-test-race concern noted there was explicitly deferred as "too broad for
  a non-controversial batch patch" — this story does not need to fix that concurrency risk, only
  rename/re-home the flag it uses.

**Example (bypass test, happy path):** An integration test registers 20 fixture users in
`beforeAll`. It sets `RATE_LIMIT_TEST_BYPASS=true`. All 20 registrations succeed without hitting
`429`, exactly as before this story.

**Example (enforcement test, happy path):** `register-rate-limit.test.ts` does not set the bypass
flag. It POSTs to `/register` 6 times in a tight loop; the 6th response is `429` with
`{ code: 'rate_limit_exceeded', ... }`, matching current test assertions.

**Edge case:** A test file sets `RATE_LIMIT_TEST_BYPASS=true` in one `describe` block and needs
enforcement active in a sibling block within the same file — must explicitly reset
(`process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'` or `delete process.env['RATE_LIMIT_TEST_BYPASS']`)
before the enforcement-testing block, since `process.env` mutations are global/shared across
`describe` blocks in the same file (same caveat as the current `RATE_LIMIT_TEST_ENFORCE` pattern —
not a new risk introduced by this story).

### AC-3 — Migration widens the `channel` check constraint to allow `'none'`

**Given** the existing `notification_preferences_channel_check` constraint
(`packages/db/src/schema/notification-preferences.ts`) restricting `channel` to
`'email','slack','inbox'`, **when** this story's migration runs, **then** the constraint is widened
to `channel IN ('email','slack','inbox','none')` via a new numbered migration file
(`packages/db/src/migrations/0047_notification_preference_none_channel.sql`, next sequential number
after `0046_project_membership_visibility_backfill_bridge.sql` — check
`packages/db/src/migrations/meta` for the actual next available number at implementation time, as
other stories may land migrations concurrently) using `ALTER TABLE ... DROP CONSTRAINT ... ADD
CONSTRAINT ...` (Postgres has no `ALTER CONSTRAINT` for check clauses).

- The Drizzle schema file's `check(...)` clause must be updated in the same commit so schema and
  migration stay in sync (Drizzle won't auto-detect a hand-written raw-SQL migration; update both
  or `drizzle-kit` schema drift checks will flag a mismatch on the next `generate`).
- **Runtime schema compatibility:** this is an additive constraint widening (existing valid values
  remain valid), so it is safe to deploy without a maintenance window and safe to roll forward
  ahead of application code that writes `'none'` rows (old app code simply never writes that value
  until the code changes ship). Rolling back the constraint (narrowing again) is **not** safe
  without first deleting any `'none'` rows written by the new code — document this one-way
  dependency in the migration file's header comment.

**Example (happy path):** After migration, `INSERT INTO notification_preferences (..., channel, ...)
VALUES (..., 'none', ...)` succeeds. `INSERT ... VALUES (..., 'bogus', ...)` still fails the check
constraint exactly as before.

**Edge case — concurrent migration numbering:** if another in-flight story's migration also claims
the "next" number, `pnpm db:migrate` must fail loudly on a duplicate/out-of-order file rather than
silently applying one and skipping the other — confirm the migration runner's behavior (check
`packages/db/src/migrations/meta/_journal.json` handling) as part of implementation; do not simply
pick a number and assume no collision.

### AC-4 — `patchPreferences()` persists `channel: "none"` as a durable row instead of deleting

**Given** a `PATCH /preferences` request with an item `{ alertType: "security.mfa_recovery_used",
channel: "none", frequency: "immediate", minSeverity: "warning" }`, **when** `patchPreferences()`
processes it, **then** it **upserts** a row with `channel = 'none'` for that
`(orgId, userId, alertType)` (using the same `onConflictDoUpdate` pattern already used for
non-`"none"` channels, keyed on the existing unique index
`(orgId, userId, alertType, channel)`) instead of deleting existing rows for that alert type.

- If other channel rows already exist for the same alert type (e.g. the user previously had `email`
  and `slack` configured for this alert type) and the user now PATCHes `channel: "none"` for it,
  those **other channel rows must be deleted** in the same operation — `"none"` for an alert type is
  mutually exclusive with any other channel for that same alert type (a user can't be "opted out"
  and "receiving email" for the same alert simultaneously). Implement this as: on a `"none"` item,
  delete all other-channel rows for that `(orgId, userId, alertType)` **and** upsert the `"none"`
  row, within the same transaction.

**Example (happy path — fresh opt-out):** User has no stored preference for
`security.mfa_recovery_used` (receiving defaults: `email`+`inbox`). PATCH with `channel: "none"`.
Immediately after, `GET /preferences` shows exactly one entry for that alert type:
`{ alertType: "security.mfa_recovery_used", channel: "none", frequency: "immediate", minSeverity:
"warning" }` — no `email`/`inbox` rows are backfilled by `fillDefaultPreferences()` (see AC-6).

**Example (opt-out overrides existing explicit channels):** User has stored rows
`{ alertType: "billing.invoice", channel: "email" }` and
`{ alertType: "billing.invoice", channel: "slack" }`. PATCH with `{ alertType: "billing.invoice",
channel: "none", ... }`. After the PATCH, both the `email` and `slack` rows for `billing.invoice`
are gone, replaced by a single `none` row.

**Example (re-opt-in after opting out):** User has a `none` row for `security.mfa_recovery_used`.
PATCH with `{ alertType: "security.mfa_recovery_used", channel: "email", frequency: "immediate",
minSeverity: "warning" }`. The `none` row for that alert type is deleted (mutual exclusivity, same
rule as above symmetrically applied) and an `email` row is upserted.

**Edge case — PATCH with `"none"` and a real channel for the same alert type in one request body:**
`PatchPreferencesBodySchema` already rejects duplicate `alertType`+`channel` pairs, but does *not*
reject `[{ alertType: "x", channel: "none" }, { alertType: "x", channel: "email" }]` (different
channels, same alert type) — since these are now semantically contradictory (mutual exclusivity),
add a `superRefine` check to `PatchPreferencesBodySchema` (and `PutPreferencesBodySchema`) in
`apps/api/src/modules/notifications/schema.ts` rejecting any request body containing both a
`"none"` entry and any other-channel entry for the same `alertType`, with a `422` validation error
(reuse the existing `validationError()` / `ctx.addIssue` pattern already used for the duplicate-pair
check in that file).

### AC-5 — `putPreferences()` (full replace) no longer silently drops `"none"` entries

**Given** a `PUT /preferences` request whose body includes an item with `channel: "none"`, **when**
`putPreferences()` processes it, **then** the `"none"` row is inserted (not filtered out by the
`items.filter((item) => item.channel !== 'none')` line, which must be removed/changed), applying the
same mutual-exclusivity rule as AC-4 (a `"none"` entry for an alert type means no other channel rows
for that alert type are inserted, regardless of what else the request body contains for that alert
type — reject such contradictory bodies with the same `superRefine` validation from AC-4, since
`PutPreferencesBodySchema` reuses `PreferenceItemSchema`).

**Example (happy path):** `PUT /preferences` body:
`[{ alertType: "security.mfa_recovery_used", channel: "none", frequency: "immediate", minSeverity:
"warning" }, { alertType: "billing.invoice", channel: "email", frequency: "immediate", minSeverity:
"warning" }]`. After the call, `GET /preferences` shows the `none` row for
`security.mfa_recovery_used`, plus the explicit `email` row for `billing.invoice` **and** the
still-missing `inbox` default backfilled for `billing.invoice` (per AC-6, `fillDefaultPreferences()`
only skips backfilling for alert types with an explicit `none` row — `billing.invoice` has no
`none` row, so its normal partial-override backfill behavior is unchanged).

### AC-6 — `fillDefaultPreferences()` never re-adds default channels for an alert type with a stored `"none"` row

**Given** `getPreferences()` / `getPreferencesBatch()` read stored rows including a `channel = 'none'`
row for some alert type, **when** `fillDefaultPreferences()` runs, **then** it must **not** add any
`DEFAULT_NOTIFICATION_CHANNELS` entries for that alert type, and must return the stored `none` row
as-is (not filtered out of the API response — the PRD's documented `GET /preferences` contract
explicitly lists `channel: "email"|"slack"|"inbox"|"none"` as valid output, see
`_bmad-output/planning-artifacts/epics.md:1366`).

- Update `PreferenceOutputItemSchema` in `apps/api/src/modules/notifications/schema.ts` to
  `channel: z.enum([...NOTIFICATION_CHANNELS, 'none'] as [string, ...string[]])` (matching the input
  schema's existing pattern) so the OpenAPI/response validation doesn't reject `'none'` in `GET`
  responses.

**Example (happy path):** Stored rows: `{ alertType: "security.mfa_recovery_used", channel: "none" }`
only. `fillDefaultPreferences()` output for that alert type: exactly the one `none` row — no
`email`/`inbox` rows added.

**Example (unrelated alert types unaffected):** Stored rows: one `none` row for
`security.mfa_recovery_used`; no rows for `billing.invoice`. Output: the `none` row for
`security.mfa_recovery_used`, plus the normal default-backfilled `email`+`inbox` rows for
`billing.invoice` — the `none` suppression is scoped strictly per-alert-type and never leaks to
other alert types.

### AC-7 — `dispatchOrgAdminNotification()` / self-alert delivery never enqueues a `"none"` channel

**Given** `processRecipientPreferences()` in `apps/api/src/notifications/dispatcher.ts` iterates
`alertPrefs` (now potentially including `channel: 'none'` rows per AC-6), **when** it encounters a
`'none'` row, **then** it must skip it entirely (no queue insert, not counted toward
`seenUserChannels` dedup, no `slackEnabled` flag flip) — add an explicit
`if (pref.channel === 'none') continue` guard at the top of the loop body, before the severity
filter (severity is irrelevant for a channel that will never deliver).

**Example (happy path — the original bug, now fixed):** A `security.mfa_recovery_used` event fires
for a user with a stored `none` row for that alert type and no other channel rows. `getPreferences()`
returns just the `none` row. `processRecipientPreferences()` skips it. Zero `notificationQueue` rows
are inserted for that user for that event — the user's opt-out is honored on the very next event,
not just at read time.

**Example (self-alert path):** The MFA recovery self-alert delivery function mentioned in
`dispatcher.ts` (search for the self-alert function near the `ADR-3.4-07` comment, "Delivers a
notification to a specific user... Enqueues email and inbox channels only; never slack") must also
respect a `none` row for the recipient's `security.mfa_recovery_*` preference — trace that function's
preference lookup and apply the same skip.

**Edge case — org-routed alert with mixed recipients:** Two admins are routed an alert; admin A has
a `none` row for that alert type, admin B has default `email`+`inbox`. Only admin B's `email`+`inbox`
jobs are enqueued; admin A gets nothing; if any *other* recipient in the batch has `slack`
configured, the shared org Slack webhook entry is still enqueued once (existing dedup/slackEnabled
logic, unaffected by admin A's opt-out).

### AC-8 — Audit logging for preference changes captures the opt-out transition

**Given** the codebase's existing audit-logging convention for preference mutations (check
`apps/api/src/modules/notifications/routes.ts` and any existing audit-entry calls around
`patchPreferences`/`putPreferences` — if no audit entry currently exists for preference changes,
this AC is N/A and must be noted as such in the Dev Agent Record rather than inventing new audit
scope beyond this story's boundary), **when** a user's preference for an alert type transitions to
or from `channel: "none"`, **then** whatever audit mechanism already covers preference changes must
continue to fire correctly for `"none"` transitions (no special-casing that accidentally skips
audit logging just because the row represents a suppression rather than a delivery channel).

**Note for implementer:** this AC exists to prevent a regression, not to add new audit scope. If
`patchPreferences`/`putPreferences` currently have zero audit-log integration, confirm that in the
Dev Agent Record and move on — do not add audit logging as new scope under this story.

## Tasks / Subtasks

- [ ] Task 1 — Rate-limit env gating (AC-1, AC-2)
  - [ ] Add `RATE_LIMIT_TEST_BYPASS` to `apps/api/src/config/env.ts` Zod schema, default `'false'`
  - [ ] Rewrite `isRateLimitEnforced()` in `apps/api/src/lib/route-helpers.ts` to require
        `NODE_ENV === 'test' && RATE_LIMIT_TEST_BYPASS === 'true'` to disable enforcement
  - [ ] Write/update unit tests for `isRateLimitEnforced()` covering: default-enforced, bypass
        active only under both conditions, flag-true-but-wrong-NODE_ENV still enforced
  - [ ] Grep for every `RATE_LIMIT_TEST_ENFORCE` reference (11 files) and migrate each to the new
        `RATE_LIMIT_TEST_BYPASS` semantics (inverted meaning — confirm each file's intent
        individually, don't blind-rename)
  - [ ] Consider centralizing the bypass-flag-set into `configureAuthIntegrationEnv()` if most files
        already call it
  - [ ] Run the full rate-limit-related test files to confirm enforcement/bypass behavior unchanged
        from a test-observer's perspective
- [ ] Task 2 — Migration: widen `channel` check constraint (AC-3)
  - [ ] Determine next sequential migration number from `packages/db/src/migrations/meta`
  - [ ] Write `ALTER TABLE notification_preferences DROP CONSTRAINT
        notification_preferences_channel_check, ADD CONSTRAINT
        notification_preferences_channel_check CHECK (channel IN ('email','slack','inbox','none'))`
  - [ ] Update `packages/db/src/schema/notification-preferences.ts`'s `check(...)` clause to match
  - [ ] Add/update a schema test asserting `'none'` is now a valid stored value and an invalid value
        is still rejected (follow existing schema test conventions, e.g.
        `packages/db/src/schema/*-schema.test.ts` pattern)
  - [ ] Run migration locally against the dev DB stack and confirm it applies cleanly
- [ ] Task 3 — Preference write-path hardening (AC-4, AC-5)
  - [ ] Rewrite `patchPreferences()` to upsert `'none'` rows and delete conflicting other-channel
        rows for the same alert type within the same transaction
  - [ ] Rewrite `putPreferences()` to stop filtering out `'none'` items; insert them, respecting
        mutual exclusivity
  - [ ] Add `superRefine` validation to `PatchPreferencesBodySchema` and `PutPreferencesBodySchema`
        in `apps/api/src/modules/notifications/schema.ts` rejecting a body with both `'none'` and
        another channel for the same `alertType`
  - [ ] Extend `apps/api/src/modules/notifications/preferences.test.ts` with cases for: fresh
        opt-out, opt-out overriding existing channels, re-opt-in after opt-out, PUT with `'none'`
        entries, contradictory-body rejection (422)
- [ ] Task 4 — Read-path and dispatcher fixes (AC-6, AC-7)
  - [ ] Update `fillDefaultPreferences()` to skip backfilling default channels for any alert type
        with a stored `'none'` row
  - [ ] Update `PreferenceOutputItemSchema` to allow `'none'` in `channel`
  - [ ] Add `if (pref.channel === 'none') continue` guard in
        `processRecipientPreferences()` in `apps/api/src/notifications/dispatcher.ts`
  - [ ] Trace and fix the MFA-recovery self-alert delivery function's preference handling for the
        same `'none'` skip
  - [ ] Extend dispatcher tests to cover: `'none'`-suppressed recipient gets zero queue rows,
        mixed-recipient batch (one opted out, one default) still delivers correctly to the other,
        self-alert path respects `'none'`
- [ ] Task 5 — Audit verification (AC-8)
  - [ ] Confirm current audit-logging scope for preference mutations (may be N/A) and document
        finding in Dev Agent Record
- [ ] Task 6 — Full regression pass
  - [ ] `pnpm lint && pnpm test && pnpm typecheck && pnpm build && pnpm jscpd` (repo quality gates)
  - [ ] Confirm no other call site assumes `channel` is restricted to `NOTIFICATION_CHANNELS`
        (3-value enum) without accounting for `'none'` now appearing in read results (search apps/web
        consumers of `GET /preferences` too — `apps/web/src/lib/api/*` preference/notification
        clients, and any UI rendering channel values)

## Dev Notes

- **Do not conflate the two items' scope.** Item A (rate limiting) and Item B (preference opt-out)
  touch entirely different subsystems (`route-helpers.ts`/`config/env.ts` vs.
  `notifications/preferences.ts`/`schema.ts`/`dispatcher.ts`/a new migration). Implement and test
  them independently; a failure or blocker in one must not block landing the other if time-boxed
  (though both are in scope for this story and both should ship together if possible).
- **RLS/tenant isolation:** all preference reads/writes are already scoped by `(orgId, userId)` via
  existing `and(eq(...orgId), eq(...userId))` predicates — this story does not change tenant
  scoping, only the `channel` value space and default-fill logic. Confirm no new query in this story
  omits the `orgId` predicate (copy-paste risk when adding the mutual-exclusion delete).
- **Concurrency:** `patchPreferences()`'s new "delete conflicting channels + upsert none" logic for
  a single alert type must happen within the same DB transaction (`tx` parameter already threaded
  through every function in `preferences.ts`) to avoid a race where a concurrent read sees neither
  the deleted rows nor the new `none` row (a transient state with zero rows for that alert type
  would incorrectly get backfilled with defaults by a concurrent `getPreferences()` call outside the
  transaction boundary — acceptable if Postgres's default read-committed isolation is used
  correctly within the existing `tx` pattern, but confirm the existing `patchPreferences` transaction
  boundary in `routes.ts` wraps the whole per-item loop, not just individual statements).
- **Migration/runtime compatibility:** see AC-3's one-way-rollback note. Do not write a
  reversible-down migration that silently deletes `'none'` rows — if a down migration is added at
  all (check repo convention — search `packages/db/src/migrations/*.sql` for whether down-migrations
  are a pattern here at all before adding one), it must fail loudly or require an explicit
  `--force`-style flag rather than silently dropping data.
- **Naming:** the new env flag is `RATE_LIMIT_TEST_BYPASS`, replacing (not aliasing)
  `RATE_LIMIT_TEST_ENFORCE`. Do not keep both names alive as synonyms — that would recreate the
  ambient-footgun risk this story exists to close, just with two knobs instead of one.

### Project Structure Notes

- Rate-limit gating logic lives entirely in `apps/api/src/lib/route-helpers.ts` and
  `apps/api/src/config/env.ts` — no new files needed for Item A.
- Preference logic lives in `apps/api/src/modules/notifications/{preferences,schema,routes}.ts` and
  `apps/api/src/notifications/dispatcher.ts` — no new files needed for Item B beyond the migration.
- New migration file: `packages/db/src/migrations/0047_notification_preference_none_channel.sql`
  (number TBD at implementation time — check `meta/_journal.json`).
- No new frontend (`apps/web`) work is required by this story's ACs, but Task 6 requires confirming
  no `apps/web` consumer breaks when `GET /preferences` starts returning `channel: "none"` rows.

### References

- [Source: _bmad-output/implementation-artifacts/3-4-epic-3-completion-notification-surface-truth-mfa-alerts-and-doc-reconciliation.md#Review-Deferred-items (lines 602-603, 638, 742)]
- [Source: _bmad-output/implementation-artifacts/3-5-credential-expiry-notification-delivery.md#AC-W6]
- [Source: _bmad-output/planning-artifacts/epics.md:1366 — documented GET /preferences channel enum including "none"]
- [Source: apps/api/src/lib/route-helpers.ts#isRateLimitEnforced]
- [Source: apps/api/src/modules/notifications/preferences.ts#patchPreferences,putPreferences,fillDefaultPreferences]
- [Source: apps/api/src/modules/notifications/schema.ts#PreferenceItemSchema,PreferenceOutputItemSchema]
- [Source: packages/db/src/schema/notification-preferences.ts#channelCheck]
- [Source: apps/api/src/notifications/dispatcher.ts#processRecipientPreferences]
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml — story 3-6 scheduling note]

## Dev Agent Record

### Agent Model Used

TBD (populated by dev-story)

### Debug Log References

### Completion Notes List

### File List
