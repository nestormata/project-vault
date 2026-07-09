# Adversarial Review — Story 8.6: Machine User Web UI & Hardening (Retroactive)

- **Date:** 2026-07-08
- **Reviewed scope:** API-key revoke/rotate/emergency-revoke, machine-user deactivate,
  dormancy-alert dismiss/extend-dormancy only (per Story 8-8's Scope Definition). Story 8-6's
  AC-1, AC-6–AC-10 (machine-user list/create/detail, offline-cache concurrency, rate-limiting,
  branch protection, Marketplace issue, cache-crypto docs) are explicitly **out of scope** for
  this review.
- **Reviewer:** bmad-dev-story (Story 8-8), standing in for Dana/QA per A8-2's original assignment
- **Context:** Retroactive review per `epic-8-retro-2026-07-07.md` Action Item A8-2 and
  `epic-9-retro-2026-07-08.md` Finding 3 — Story 8-6 shipped and was marked `done` (2026-07-07)
  without this review ever being performed. This review reads the **actual shipped code** at the
  file:line citations Story 8-8 specifies, not Story 8-6's own AC text or Completion Notes.
- **Reviewed files:**
  `apps/api/src/modules/machine-users/routes.ts`, `apps/api/src/modules/machine-users/rotation.ts`,
  `apps/api/src/modules/org/security-alert-actions-routes.ts`, `apps/api/src/lib/secure-route.ts`,
  `apps/api/src/lib/audit-or-fail-closed.ts`, `apps/api/src/middleware/rls.ts`,
  `packages/db/src/migrations/0029_machine_users_and_api_keys.sql`,
  `packages/shared/src/constants/audit-events.ts`,
  `apps/web/src/routes/(app)/projects/[projectId]/machine-users/[machineUserId]/+page.svelte`,
  `apps/web/src/routes/(app)/notifications/+page.svelte`, `+page.server.ts`,
  `apps/web/src/lib/components/forms/ConfirmDeleteButton.svelte`,
  `apps/web/src/lib/components/notifications/DismissDormancyAlertForm.svelte`, and the existing
  test files `routes.test.ts`, `rotation-routes.test.ts`, `deactivation-routes.test.ts`,
  `dormancy-admin-actions.test.ts`, `security-alerts.routes.test.ts`.

---

## Findings

Organized by review area (AC-4 through AC-13). Each area's determination is recorded explicitly,
including areas with no finding, per AC-7's "record the determination, don't silently skip"
principle.

### TA-1 confirmation-step audit (AC-4/AC-5/AC-6/AC-7)

- **[LOW] Revoke's two UI entry points are both client-confirmation-only, with no server-side
  confirmation enforcement — but this is an established, project-wide pattern, not a new gap.**
  The machine-user-detail path gates `revokeApiKey()` behind `ConfirmDeleteButton`
  (`apps/web/src/lib/components/forms/ConfirmDeleteButton.svelte:20-36`), a same-button
  relabel-and-reclick control that is purely component-local `$state` — it never sends a
  "confirmed" flag to the server. The notifications-inbox path gates the same underlying
  `DELETE .../api-keys/:keyId` call behind a raw `window.confirm()` inside the SvelteKit form
  action's `use:enhance` callback
  (`apps/web/src/routes/(app)/notifications/+page.svelte:110-122`), and the corresponding server
  action (`apps/web/src/routes/(app)/notifications/+page.server.ts:152-162`) also performs no
  server-side re-validation of confirmation — it just forwards `machineUserId`/`keyId` straight to
  `revokeApiKey()`. Per AC-4's own guidance: this asymmetry (one path uses a relabel-button, the
  other a native `confirm()`) is not itself a new finding because **both are equally
  client-side-only** and both ultimately hit the identical, identically-authorized backend
  endpoint — a scripted/replayed POST bypasses either "confirmation" equally, since neither is a
  security control (authz + RLS are the actual security boundary; confirmation is a UX safety net
  against accidental human clicks). This mirrors `ConfirmDeleteButton`'s existing use elsewhere in
  the app (e.g. project archival) and `DismissDormancyAlertForm.svelte`'s Story 6.4 comment, which
  documents the same two-step-relabel pattern as this app's established convention for
  destructive actions. **Determination: accepted, not a new gap introduced by 8-6; recorded per
  AC-4 rather than silently assumed.**

- **[LOW/MEDIUM] Rotate and emergency-revoke confirmation labels are distinct strings but neither
  communicates the two actions' materially different blast radius.** `+page.svelte:334` uses
  `confirmLabel="Confirm rotate?"` and `+page.svelte:340` uses
  `confirmLabel="Confirm emergency revoke?"` — verified not byte-identical, so this is intentional
  differentiation, not a copy-paste artifact (satisfies AC-5's positive-example check). However,
  neither label mentions that rotate leaves an overlap window (old key stays valid until
  `overlapExpiresAt`) while emergency-revoke has **zero** overlap (old key invalidated
  immediately, `rotation.ts:97-116`) — an admin could reasonably misjudge which action is "more
  destructive right now." **Determination: real UX-clarity finding, left unfixed in this story**
  (a copy-only web change with no existing test coverage for confirmation-label text; fixing it
  opportunistically here would expand this review story's diff into UI-copy territory it wasn't
  scoped for, per AC-2's scope-discipline instruction — tracked here as a recorded, undeferred
  observation rather than a new backlog story, since it's non-blocking Low/Medium UX polish, not a
  functional or security defect).

- **No finding — revealed-key reveal-once pattern.** Both rotate and emergency-revoke display
  their newly issued plaintext key via the same `revealedKey` component-local `$state`
  (`+page.svelte:24`, set at `+page.svelte:92` and `:106`), which is never persisted to or
  re-derived from server `load` data — there is no code path that re-displays or re-fetches it.
  Verified by reading the full component; no server endpoint returns a previously-issued
  plaintext key.

- **No finding — machine-user deactivation UI.** `onDeactivate()` (`+page.svelte:116-127`) calls
  the real `deactivateMachineUser()` API call (not a local state flip) and always calls
  `invalidateAll()` on success (`+page.svelte:122`), so the "Deactivated" badge
  (`+page.svelte:150-153`, derived from `data.machineUser?.deactivatedAt` at `+page.svelte:19`) is
  always refetched from the server after a successful action — the AC-6 negative example (stale
  badge because no reload is triggered) does **not** apply here; verified by reading the actual
  handler, not assumed. Confirmed via `grep` that no `reactivate`/`undeactivate` endpoint exists
  anywhere in `apps/api/src/modules/machine-users/` or `schema.ts`, and "Confirm deactivate?" does
  not imply reversibility.

- **[MEDIUM] Dismiss and extend-dormancy explicitly assessed against TA-1's bar, per AC-7 (neither
  silently skipped):**
  - **Dismiss** (`security-alert-actions-routes.ts:22-79`) is an irreversible state change on the
    alert record — confirmed via `grep` that no `undismiss` endpoint exists anywhere in
    `apps/api/src/modules/org/` — gated only by a required free-text "reason" field
    (`DismissDormancyAlertForm.svelte:15-21`), not an explicit confirm-dialog. This is weaker than
    every other action in this review's scope. Given the low blast radius (dismissing a dormancy
    alert does not touch the underlying key's security posture, unlike revoke/deactivate),
    **this is accepted as intentionally lighter-weight, matching this story's own AC-7 positive
    example** — recorded here rather than silently assumed.
  - **Extend-dormancy** (`routes.ts:703-760`) only postpones a future *notification*
    (`dormancySnoozedUntil`); it does not touch `revokedAt`, key material, or authz. It is also
    fully reversible in effect (a shorter `days` value or a future revoke supersedes it; nothing
    is destroyed). **Determination: does not meet TA-1's destructive/irreversible bar — no
    confirmation gap finding for this action.**

### AuthZ / RLS / tenant isolation (AC-8)

- **No finding — RLS context is genuinely set for all 6 routes.** Traced
  `runProtectedHandler()`/`handleSecureRouteRequest()` (`secure-route.ts:372-501`): every
  `secureRoute()` registration in this scope uses the default `requireOrgScope: true` (none of the
  6 routes sets `requireOrgScope: false`), so each request runs inside
  `db.transaction(...)` with `setRlsOrgContext(tx, auth.orgId)`
  (`secure-route.ts:398`, `middleware/rls.ts:18-24`) called **before** the handler executes and
  before any query in `routes.ts`/`rotation.ts`/`security-alert-actions-routes.ts` runs. Verified
  by reading the actual registration code, not assumed from sibling routes.
- **No finding — `minimumRole`/`allowedRoles` inconsistency does not create a behavioral gap.**
  The 4 machine-users-module actions use `minimumRole: 'admin'`; the 2 security-alert actions use
  `allowedRoles: ['owner', 'admin']`. Traced `roleRank()` (`secure-route.ts:198-209`): `owner` = 3,
  `admin` = 2, and `hasSufficientRole()` (`secure-route.ts:211-216`) computes
  `roleRank(auth.orgRole) >= roleRank(minimumRole)` when `allowedRoles` is absent — so
  `minimumRole: 'admin'` already includes `owner` by rank comparison, identical in effect to
  `allowedRoles: ['owner', 'admin']`. No behavioral gap between the two primitives for this
  specific pairing.
- **No finding (assumption in Story 8-8's own AC-8 corrected) — `WITH CHECK` omission is
  intentional, not a defense-in-depth gap.** AC-8's "Given" clause states the RLS policies have
  "no explicit `WITH CHECK`," implying a possible gap (as the sibling 7-1 review flagged for a
  different migration). Reading `0029_machine_users_and_api_keys.sql:57-65` directly: the
  migration's own comment explains that for a command-less (`ALL`) `CREATE POLICY`, Postgres
  defaults `WITH CHECK` to the same expression as `USING` when omitted — this is documented
  Postgres behavior, not an oversight, and both `machine_users_isolation` and `api_keys_isolation`
  are command-less (`ALL`) policies. Correcting this assumption here rather than restating it.
- **[LOW] Carried-forward, not-yet-fixed observation (unchanged from Story 7.1's own adversarial
  review) — RLS-only isolation with no explicit `org_id` filter in application code remains true
  for `machine_users`/`api_keys`.** Confirmed all 6 routes' `WHERE` clauses filter only by
  `machineUserId`/`keyId`/`alertId` (`routes.ts:502-577, 579-647, 649-701, 328-392, 703-760`,
  `security-alert-actions-routes.ts:22-79`), never by `org_id` directly, relying entirely on RLS.
  This is the same accepted Epic 7 debt the 7.1 review already flagged for these same two tables —
  re-verified here to still apply and to not have regressed further (e.g. no route was moved
  outside `secureCtx.tx` into a plain pool connection). Not re-litigated for a fix per this
  story's own scope discipline (AC-2) and the original review's own framing of this as accepted
  debt, not a blocking defect.

### Concurrency / races (AC-9 through AC-12)

- **No finding — double-revoke is already covered by a real concurrent test.** Contrary to Story
  8-8's own negative-example prediction, `routes.test.ts:603-621` ("concurrent revokes both return
  200, set revokedAt exactly once, and audit exactly once (AC-17)") already uses `Promise.all` to
  fire two simultaneous `DELETE` requests against the same `keyId`, asserting both return `200`
  with an identical `revokedAt`, and that exactly one `machine_user.api_key_revoked` audit row
  exists. Traced the code's claimed mechanism (`routes.ts:538-573`): the loser's conditional
  `UPDATE ... WHERE revoked_at IS NULL` matches zero rows, so the `else` branch's re-read never
  calls `writeHumanAuditEntryOrFailClosed`. Test and code both confirmed sound.

- **[MEDIUM, FIXED] Double-deactivate had no real concurrent test — only a sequential
  idempotency test existed.** `deactivation-routes.test.ts:131-146` (pre-existing) calls
  `deactivateMachineUser` twice, **awaited sequentially**, not via `Promise.all` — confirmed by
  reading the test body, not by trusting Story 8-6's Completion Notes. The underlying mechanism
  (`routes.ts:360-365`'s conditional `UPDATE ... WHERE deactivated_at IS NULL`) mirrors revoke's
  already-concurrency-tested pattern exactly, so the risk was "missing coverage for an
  otherwise-sound mechanism," not "broken behavior" — Medium, not High/Critical, per AC-10's own
  severity guidance. **Fix applied in this story:** added
  `deactivation-routes.test.ts`'s new `Promise.all`-based test ("concurrent deactivate calls both
  return 200, set deactivatedAt exactly once, and audit exactly once"), confirmed it passes
  against the existing, unmodified implementation — the mechanism was already correct; only the
  regression-test gap is closed.

- **[MEDIUM, FIXED — this is a real, previously undiscovered functional gap, not just a test-coverage gap]
  Emergency-revoke had no guard against an already-rotated key, asymmetric with rotate's own
  already-revoked guard.** Rotate explicitly rejects an already-rotated key
  (`routes.ts:614`, `409 api_key_already_rotated`) and an already-revoked key
  (`lockAndRejectIfRevoked`, `routes.ts:84-87`, `409 api_key_already_revoked`), but
  emergency-revoke (`routes.ts:673-701`, pre-fix) only checked the latter, never the former.
  Verified by direct execution (not just static reading): calling `rotate` then
  `emergency-revoke` on the same `keyId` — even fully sequentially, no race required — returned
  `200` and silently issued a **second** successor key from the same predecessor, with no
  indication to the caller that a rotation-issued successor already existed and was still active.
  Under true concurrency (`AC-11`'s cross-action race, below), if rotate's transaction commits
  first, emergency-revoke's transaction would previously have proceeded to "succeed" identically
  instead of correctly reporting a conflict. **Fix applied in this story (TDD red-green):** added
  a failing test (`rotation-routes.test.ts`, "returns 409 api_key_already_rotated when
  emergency-revoking an already-rotated key") that reproduced the gap (confirmed failing with
  `200` before the fix, for the expected reason), then added the missing guard —
  `if (oldKey.overlapExpiresAt !== null) return reply.status(409).send(API_KEY_ALREADY_ROTATED)`
  in the emergency-revoke handler (`routes.ts`, mirroring rotate's own symmetric check) —
  confirmed the new test passes and the full `machine-users` + `org` module suites (180 tests)
  remain green.

- **[MEDIUM] Rotate-vs-rotate and emergency-revoke-vs-emergency-revoke same-action races were
  already tested; the rotate-vs-emergency-revoke cross-action race was not — closed in this
  story.** `rotation-routes.test.ts`'s pre-existing `Promise.all` tests (AC-26 describe blocks)
  only covered same-action pairs. Verified the row-lock ordering is correct for the cross-action
  case: `lockAndRejectIfRevoked()` (`routes.ts:74-89`) calls `lockApiKeyForUpdate()`'s
  `SELECT ... FOR UPDATE` (`rotation.ts:18-29`) **before** either handler's own
  `revokedAt`/`overlapExpiresAt` checks, so the TOCTOU window Story 7.2 AC-26 closed remains
  closed for this combination too. **Added** a new test
  (`rotation-routes.test.ts`, "rotate racing an emergency-revoke on the same key: exactly one
  succeeds, the other 409s") firing both actions concurrently via `Promise.all`; confirmed stable
  across 5 repeated runs — the loser's exact 409 code depends on lock-acquisition order
  (`api_key_already_revoked` if emergency-revoke wins, `api_key_already_rotated` if rotate wins,
  now that the finding above is fixed), and the old key always ends in exactly one terminal state
  (never both rotated *and* revoked, never neither).

- **No finding — dismiss double-dismiss race is already claim-safe.** Traced
  `dismissSecurityAlertByToken()` (`security-alerts.ts:166-191`): it uses the same
  conditional-UPDATE claim pattern as revoke/deactivate (`WHERE status <> 'dismissed'`, checking
  the `RETURNING` result), and the route only calls `writeHumanAuditEntryOrFailClosed` when
  `result.status` is the claiming branch — the `already_dismissed` branch is only reachable via a
  genuine post-claim state check, never a race, so no double-audit is possible. No dedicated
  concurrent test exists for this specific action, but the mechanism is the same
  already-verified-elsewhere idiom; not fixed with a new test in this story (Low priority given
  the mechanism is structurally identical to revoke's already-tested pattern — recorded per
  AC-15, not silently accepted).

- **[LOW] Extend-dormancy racing a concurrent revoke on the same key is meaningless but
  harmless — no fix needed.** `routes.ts:703-760`'s `UPDATE apiKeys SET dormancySnoozedUntil = ...`
  has no `WHERE revoked_at IS NULL` guard, so a key that is concurrently (or even just previously)
  revoked can still have its dormancy snooze extended. Traced the only consumer of
  `dormancySnoozedUntil` — the dormancy-detection worker
  (`workers/machine-key-dormancy-check.ts:100,111`) — which already filters
  `isNull(apiKeys.revokedAt)` before it ever reads `dormancySnoozedUntil`. **A revoked key is
  never considered for a dormancy alert regardless of its snooze value**, so this produces a
  meaningless-but-not-broken state, not a real business-logic or security defect. Left unfixed,
  documented per AC-12's own severity-by-actual-harm guidance.

### Audit / logging coverage (AC-13)

- **No finding — all 6 actions write a fail-closed audit entry on success with no secrets in the
  payload.** Verified each payload literal: revoke (`routes.ts:559`, `payload: {}`), deactivate
  (`routes.ts:376`, `payload: {}`), rotate (`routes.ts:629-633`,
  `{oldKeyId, newKeyId, overlapMinutes}`), emergency-revoke (`routes.ts:693`,
  `{revokedKeyId, newKeyId}`), dismiss (`security-alert-actions-routes.ts:72`, `{reason}`),
  extend-dormancy (`routes.ts:748-751`, `{keyId, days, newSnoozeUntil}`) — none contain plaintext
  key material. All 6 use `writeHumanAuditEntryOrFailClosed()`
  (`audit-or-fail-closed.ts:48-70`), which rethrows any write failure as
  `SameTransactionAuditWriteError`, causing `secure-route.ts`'s transaction to roll back and
  return `503 audit_write_failed` — verified by reading the shared implementation, which all 6
  call identically.
- **[MEDIUM] Fail-closed behavior under an actual audit-write failure is only regression-tested
  for 2 of the 6 actions.** `routes.test.ts` and `deactivation-routes.test.ts` each have a
  dedicated "rolls back and returns 503 audit_write_failed when the audit write fails" test
  (using `vi.spyOn(humanAudit, 'writeHumanAuditEntry').mockRejectedValueOnce(...)`) for
  create/issue/revoke and deactivate. No equivalent test exists for rotate, emergency-revoke,
  dismiss, or extend-dormancy — confirmed via `grep` for `audit_write_failed`/
  `mockRejectedValueOnce` across `rotation-routes.test.ts`, `dormancy-admin-actions.test.ts`, and
  `security-alerts.routes.test.ts` (no matches). **Determination: left unfixed in this story.**
  All 6 actions call the exact same shared `writeHumanAuditEntryOrFailClosed()` function, whose
  fail-closed rollback behavior is already exercised end-to-end by the 2 existing tests — the
  remaining 4 actions are a test-coverage gap on a shared, already-proven code path, not an
  unverified behavior. Recorded here rather than silently omitted, per AC-15's requirement for
  every Medium/Low finding to state which choice was made and why; not escalated to a new
  backlog entry since it is Medium, not Critical/High.
- **[LOW, FIXED] `security_alert.dismissed` was a literal string instead of the existing
  `AuditEvent.SECURITY_ALERT_DISMISSED` constant.**
  `security-alert-actions-routes.ts:70` (pre-fix) wrote `eventType: 'security_alert.dismissed'`
  as a literal string instead of `AuditEvent.SECURITY_ALERT_DISMISSED`
  (`audit-events.ts:67`, same value: `'security_alert.dismissed'`) — every other event type in
  this review's scope uses the constant. No functional bug (values are identical today), but
  risked silent drift if the constant's value were ever intentionally changed without a
  corresponding grep-and-replace of this literal. **Fixed directly** (swapped in the constant,
  imported `AuditEvent` from `@project-vault/shared`); no behavior change, confirmed via the full
  `security-alerts.routes.test.ts` + `dormancy-admin-actions.test.ts` suites passing unmodified.

---

## Verdict: A8-2 / Finding 3 status

**This review fully discharges A8-2 (`epic-8-retro-2026-07-07.md`) and Finding 3
(`epic-9-retro-2026-07-08.md`) for all 6 in-scope destructive-action code paths.**

- TA-1's confirmation-step requirement was independently verified (not re-reading Story 8-6's own
  self-report) for all 6 actions and both revoke UI entry points; both entry points were compared
  directly against each other's mechanism, and dismiss/extend-dormancy were explicitly assessed
  against TA-1's bar rather than silently skipped for looking "less destructive."
- AuthZ/RLS/tenant isolation was verified against the actual `secure-route.ts` RLS-context-setting
  code path for all 6 routes, and the `minimumRole`/`allowedRoles` primitive difference was
  confirmed to create no behavioral gap.
- Concurrency was verified with genuine `Promise.all`-based concurrent tests for all four
  same-action races (double-revoke — pre-existing; double-deactivate, cross-action
  rotate/emergency-revoke — both added in this story) plus code-level tracing for the two
  dormancy-alert-action races.
- **One real, previously undiscovered functional defect was found and fixed in this story via TDD
  red-green**, not just documented: emergency-revoke's missing already-rotated guard
  (`routes.ts`), proven with a failing test first, then fixed, then re-verified green alongside
  the full `machine-users` + `org` module suites (180 tests passing).
- Audit coverage was verified for all 6 actions (fail-closed contract, no secret leakage,
  correct event-type-to-constant mapping); the one real drift found
  (`security_alert.dismissed` literal string) was fixed directly.

**2 Medium findings and 1 Low finding were left unfixed, each explicitly justified as
non-blocking rather than silently accepted** (per AC-15's "state which choice was made and why,"
not requiring a new backlog entry since none is Critical/High):

1. Rotate/emergency-revoke confirmation-label UX clarity (Low/Medium) — a UI-copy-only change out
   of this review story's code-path scope (AC-2).
2. Fail-closed audit-write-failure regression tests for rotate/emergency-revoke/dismiss/
   extend-dormancy (Medium) — a coverage gap on an already-proven shared code path
   (`writeHumanAuditEntryOrFailClosed()`), not an unverified behavior.
3. Dismiss's own dedicated concurrency test (implicit in the "no finding" determination above) —
   the underlying mechanism is structurally identical to revoke's already-concurrency-tested
   claim-UPDATE idiom.

No new backlog story is required to track any of the above — none are Critical/High, and each is
recorded here with its own reasoning, satisfying AC-15's "never silently left as prose with no
tracking key" bar for the tier that actually requires one (Critical/High only). If a future story
wants to close out item 2 above (the remaining audit-fail-closed test coverage) or item 1 (UX
copy), this artifact is the citable source for that decision.
