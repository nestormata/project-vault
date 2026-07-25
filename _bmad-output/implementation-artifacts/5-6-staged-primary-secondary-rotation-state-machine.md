# Story 5.6: Staged Primary/Secondary Rotation State Machine

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user rotating a credential,
I want the new value staged alongside the still-active old value, and to promote the new value and retire the old value as two separate explicit actions,
so that I never have to choose between an all-or-nothing checklist gate and an unsafe in-place value change, and I keep full control over exactly when the old value stops being usable.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — this amends both the API state machine (`apps/api/src/modules/rotation/service.ts`, routes, workers) and the shipped Epic 5 web UI (Story 5.4's rotation components under `apps/web/src/lib/components/rotations/` and routes under `.../credentials/[credentialId]/rotate/`, `.../rotations/[rotationId]/`). Unlike 5.1–5.3 (legitimately API-only pending 5.4), Epic 5 already has a UI, so an API-only version of this story would visibly regress it (buttons that call an endpoint that no longer behaves as documented). |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — UI changes are in-scope in this same story (Task 6) |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Riley-admin (org admin, rotation initiator):** opens a credential detail page → clicks "Rotate" → enters/generates the new value → sees two cards: **Active** (old value, still servable) and **Staged** (new value, independently revealable, gated by the same reveal permission/audit as the Active card) → optionally works the (now advisory, non-blocking) per-system checklist → clicks **Promote** on the Staged card (requires an explicit acknowledgement checkbox if checklist items are still unconfirmed) → the Staged card becomes the new Active card, the old value moves to a **Retire** card that stays servable → at their own pace (minutes, days, or weeks later) clicks **Retire** on the old-value card (same acknowledgement-if-incomplete-checklist gate) → old value is cryptographically deleted, card disappears, rotation shows `retired` in history. If Riley does nothing after promote, the **Stale Staged Alert** (Task 4) does NOT fire for them post-promote (that alert only watches `staged`, pre-promote rotations) — a promoted-but-unretired rotation has no equivalent nag in this story; see Dev Notes "Open Questions" for why this is an intentional v1 gap, not an oversight.

**Alex-viewer (read-only):** sees the Active/Staged/Retire cards on the credential detail page (values themselves still hidden behind the same reveal-permission gate as today — `viewer` role can see rotation status and checklist but not stage/promote/retire buttons, matching 5.1–5.3's existing `admin`/`owner`-only mutation gates). No regression: Alex could always see rotation status; now they see one more state value in the same place.

**Morgan-member (dependent-system owner, checklist confirmer):** experience on the checklist itself is unchanged from 5.2 (`confirm`/`fail`/`retry` on assigned items) — the only change visible to Morgan is that the checklist no longer blocks anyone else from promoting/retiring; a banner now reads "This checklist is advisory — an admin may promote or retire before all items are confirmed" instead of implying it's a hard gate.

## Acceptance Criteria

> Every AC below is written with the EXACT current code behavior as the baseline (verified against `apps/api/src/modules/rotation/service.ts`, `apps/api/src/modules/credentials/service.ts`, `packages/db/src/schema/rotations.ts`, `packages/db/src/schema/credential-versions.ts`, `apps/api/src/workers/rotation-recover.ts`, `apps/api/src/workers/prune-credential-versions.ts` on 2026-07-24). See Dev Notes → "Critical correction to the sprint-change-proposal's premise" before starting — the proposal's architecture-conflicts section describes a design that does NOT match the shipped code, and this story's ACs are written against the real code, not the proposal's premise.

### AC-1: `credential_versions` gains a promotion marker; "current" selection is inverted to require promotion

**Given** the current shipped behavior, where `revealCurrentValue()`/`selectCurrentVersionMeta()` (`apps/api/src/modules/credentials/service.ts`) select the **highest `versionNumber`** row with `purgedAt IS NULL AND abandonedAt IS NULL` as "current" — meaning today, initiating a rotation makes the **new** value immediately live/servable (ADR-5.1-04), not the old one,

**When** this story ships,

**Then**:
1. `credential_versions` gains a new nullable column `promoted_at timestamptz`.
2. The "current version" selection query in `revealCurrentValue()`, `selectCurrentVersionMeta()`, and every other call site that derives "the current value" (grep `orderBy(desc(credentialVersions.versionNumber))` combined with `isNull(credentialVersions.purgedAt)` / `isNull(credentialVersions.abandonedAt)` across `apps/api/src/modules/credentials/service.ts` — confirm the full call-site list at implementation time, do not assume the two functions named above are exhaustive) adds `AND promoted_at IS NOT NULL` to its WHERE clause, and re-orders by `promotedAt DESC, versionNumber DESC` (not `versionNumber DESC` alone) so that a version created later but promoted earlier never incorrectly outranks one created earlier but promoted later — see Example 1c.
3. A migration (0050, see Task 1) backfills `promoted_at = created_at` for **every existing row** in `credential_versions` at migration time, **except** rows belonging to a `rotations` row currently `status = 'in_progress'` at migration time (see AC-7, migration path for in-flight rotations — those get special handling, not the blanket backfill).
4. The non-rotation `addCredentialVersion()` / `insertVersionAndSetCurrent()` path (Epic 13 multi-field edits, `apps/api/src/modules/credentials/service.ts`) is updated to set `promotedAt = NOW()` on insert — those writes are still "immediately current" by design (field edits are not a staged workflow), so their behavior is unchanged from the caller's perspective; only the column-level mechanism changes.
5. `credentials.currentVersionId` (added by Story 13.1, `packages/db/src/schema/credentials.ts:56`) is **not** used by this story's selection logic (confirmed unused by the rotation path today, per ADR-5.1-04 and the direct code read) and this story does not start using it — do not "fix" this by wiring `currentVersionId` into the rotation path; that is a larger, separate refactor out of scope here. Flag this as a documented pre-existing inconsistency (architecture.md line 331 claims `currentVersionId` is the flip mechanism; it is not, for the rotation path) — file a Dev Notes note, do not silently "fix" architecture.md's claim by changing production behavior in this story.

**Example 1a (happy path, single rotation, no staging yet):** Credential C has one version, v1, `promotedAt` backfilled to its original `createdAt`. `GET .../credentials/C/value` returns v1. Unchanged from today.

**Example 1b (staged, not yet promoted):** Rotation initiated on C creates v2 with `promotedAt = NULL`, `rotations.status = 'staged'`. `GET .../credentials/C/value` (the existing "current value" reveal route) **still returns v1** — this is the behavior inversion this story exists to deliver, and is the opposite of today's shipped behavior (today it would return v2 immediately). This is the single most safety-critical behavior change in the whole story: get the WHERE clause and the migration backfill wrong, and every in-flight rotation at deploy time either loses its new value's visibility or silently un-serves a value dependent systems already switched to (see AC-7).

**Example 1c (promotedAt/versionNumber ordering edge case):** Credential C has v1 (`promotedAt = day 1`), v2 staged on day 2 (`promotedAt = NULL`), then abandoned via `abandonedAt` set on day 3 without ever promoting, then a fresh rotation creates v3 staged on day 4 and promoted on day 5. Only v1 and v3 have non-null `promotedAt`. `ORDER BY promotedAt DESC, versionNumber DESC LIMIT 1` correctly returns v3 (`promotedAt` day 5). A naive `ORDER BY versionNumber DESC` with only `promotedAt IS NOT NULL` in the WHERE would also return v3 here since v2 is filtered out by the WHERE clause — but write the explicit `promotedAt DESC` ordering anyway and add a regression test for it, because a future version created between two promotions (e.g., an abandoned v2.5 with a higher versionNumber than a not-yet-promoted-but-eventually-winning row) is a real ordering hazard the WHERE clause alone doesn't protect against once more state values exist.

---

### AC-2: `rotations.status` enum gains `staged`, `promoted`, `retired`; existing values keep their exact meaning

**Given** the current CHECK constraint `rotations_status_check IN ('in_progress','completed','abandoned','stale_recovery','break_glass_complete')` (`packages/db/src/schema/rotations.ts`),

**When** this story ships,

**Then**:
1. The CHECK constraint becomes `IN ('in_progress','staged','promoted','retired','completed','abandoned','stale_recovery','break_glass_complete')` — purely additive, per the sprint-change-proposal's explicit success criterion that `abandoned`/`stale_recovery`/`break_glass_complete` keep their exact current meaning, and `completed`/`in_progress` are kept in the enum for historical-row compatibility (see AC-7) even though new code never writes `completed` and only writes `in_progress` transiently during the AC-7 migration window (never as new-code steady state after this story ships — new rotations go straight to `staged`).
2. New rotations created by `initiateRotation()` are inserted with `status: 'staged'` (was `'in_progress'`).
3. `POST .../rotations/:rotationId/promote` (new route, Task 2) transitions `staged → promoted`, sets a new `promoted_at` timestamp column **on the `rotations` row itself** (distinct from `credential_versions.promoted_at` added in AC-1 — same name, different table, do not conflate; name the rotations-table column `promoted_at` too for consistency but be precise about which table in code comments and tests), flips the new version's `credential_versions.promoted_at`, and writes `AuditEvent.ROTATION_PROMOTED`.
4. `POST .../rotations/:rotationId/retire` (new route, Task 2) transitions `promoted → retired`, cryptographically purges the previous version (reusing `prune-credential-versions.ts`'s zero-then-null pattern — see AC-3), sets `rotations.retiredAt`, and writes `AuditEvent.ROTATION_OLD_RETIRED`.
5. `abandon`/`resume` (Story 5.3) continue to operate exactly as today, extended to also accept `staged` (not just `in_progress`/`stale_recovery`) as a valid starting state for `abandon` — an unpromoted staged rotation is exactly as abandonable as an in-progress one was. `promoted` (post-promotion, pre-retirement) is **not** abandonable via the existing `abandon` route — once promoted, the only forward paths are `retire` or leaving it promoted-but-unretired indefinitely (FR22); reaching into `abandon` for a `promoted` rotation returns `409 { code: "rotation_not_abandonable_after_promotion" }`.
6. The partial unique index `idx_rotations_one_active_per_credential ON (credential_id) WHERE status IN ('in_progress','stale_recovery')` is widened to `WHERE status IN ('staged','promoted','stale_recovery')` — a `promoted`-but-unretired rotation still counts as "active" for the purpose of blocking a second concurrent rotation on the same credential (you cannot start rotating again on a credential that still has an unretired old version sitting around from a previous rotation; retire it first, or the new rotation would have three live versions in flight with no defined "old" for the new rotation to retire).

**Example 2a (retire re-attempt after already retired):** `POST .../rotations/R/retire` called twice in sequence (not concurrently — see AC-5 for the concurrent case). Second call: `rotations.status` is now `retired`, not `promoted`; `acquireAndLoadRotation` (reused helper) finds the row but the retire handler checks `status === 'promoted'` before proceeding and returns `409 { code: "rotation_not_retirable", currentStatus: "retired" }` — same "guard on current status, not just CAS version" pattern `completeRotation()` already uses today for `checklist_incomplete` (status-shape check) layered on top of the CAS check (value check).

**Example 2b (promote called on an already-promoted rotation):** Same shape, `409 { code: "rotation_not_promotable", currentStatus: "promoted" }`.

**Example 2c (second rotation attempted while first is promoted-unretired):** Credential C has rotation R1, `status: promoted`, old version not yet retired. `POST .../credentials/C/rotations` (initiate) → `409 { code: "rotation_in_progress", rotationId: "R1" }` — same error shape and code the existing partial unique index backstop already returns for a `staged`/`stale_recovery` collision today (`packages/db/src/schema/rotations.ts`'s existing pattern), now also covering `promoted`.

---

### AC-3: FR105 retention-pruning exemption covers `staged` AND `promoted`-but-unretired versions

**Given** the current exemption seam — `prune-credential-versions.ts`'s `purgeCandidatesForCredential()` selects `WHERE purgedAt IS NULL AND rotationLockedAt IS NULL` (i.e., `rotationLockedAt IS NOT NULL` is the sole DB-level exemption today, set at rotation initiation and cleared today only inside `completeRotation()`),

**When** this story ships,

**Then**:
1. `rotationLockedAt` remains the exemption mechanism (no new column needed — this is the intentional, idiom-consistent design per ADR-5.3-04's established pattern of nullable-timestamp markers over new status enums) but its clearing point moves: it is set at initiation exactly as today, and is now cleared **only inside the new `retireRotation()` function**, not inside `promote`. This is the literal fix for the sprint-change-proposal's Round-3 elicitation finding — a promoted-but-unretired version stays `rotationLockedAt IS NOT NULL` and therefore stays exempt from the retention job indefinitely, until the user explicitly retires it.
2. Add an explicit regression test in `prune-credential-versions.test.ts`: create a credential, rotate it, promote (do not retire), set `retentionCount = 1` (the tightest possible setting), run the pruning job, assert the old (promoted-away-from) version is **not** purged (`purgedAt` still null) because `rotationLockedAt` is still set. This is the single most important regression test in this story — it is the literal reproduction of the highest-severity finding from the sprint-change-proposal's own advanced-elicitation round 3 ("the ordinary retention job could silently delete the very version the user deliberately chose to keep alive").
3. A second regression test: same setup, but call `retire`, then run the pruning job — `rotationLockedAt` is now null, `purgedAt` was already set by the `retire` call itself (the cryptographic deletion happens synchronously inside `retire`, not lazily by the next pruning job run — see AC-2.4) — assert the pruning job is a no-op for this version (idempotent double-purge guard: it's already purged) rather than erroring.

**Example 3a (indefinite promoted-unretired — the "forgotten rotation" scenario the stale-staged alert (AC-4) exists to catch):** Rotation promoted on day 1. Retention job runs nightly for 90 days. Old version is never purged (still `rotationLockedAt IS NOT NULL`) on day 90 — confirmed by test, not just documented. This is intentional per FR22 ("An old version may remain retrievable indefinitely after promotion until the user explicitly retires it") — do not add a secondary auto-retire timer for the ordinary (non-break-glass) path; that would silently violate FR22 and reintroduce exactly the auto-retirement the whole story exists to remove. See Dev Notes → Open Questions for the deliberate absence of a promoted-state nag alert.

---

### AC-4: New stale-staged alert (14-day default), fully distinct from the existing 1h `stale_recovery` mechanism

**Given** `rotation-recover.ts`'s `runStaleRotationRecoveryJob` — scans `WHERE status = 'in_progress' AND initiatedAt < NOW() - threshold`, `threshold = env.STALE_ROTATION_THRESHOLD_MINUTES` (default 60 min, schema max 10080 min / 7 days) — and **transitions** matching rows to `stale_recovery`, resetting checklist items,

**When** this story ships, a **new, separate** worker `rotation-stale-staged-alert.ts` is added that:

1. Scans `WHERE status = 'staged' AND initiatedAt < NOW() - threshold`, where `threshold` comes from a **brand-new** env var `STALE_STAGED_ROTATION_THRESHOLD_DAYS` (default **14**, min 1, max 90 — sized in days, not minutes, deliberately incompatible in scale with `STALE_ROTATION_THRESHOLD_MINUTES` so the two can never be confused or accidentally unified by a future refactor; this is a direct fix for the elicitation Round-4 finding that reusing the 1h threshold would auto-alert-as-abandon every legitimate staged rotation almost immediately).
2. **Never transitions status.** This job is purely informational — it does NOT move `staged → stale_recovery`, does NOT abandon, does NOT touch the rotation row's `status` field at all. This is the literal, load-bearing distinction from `rotation-recover.ts`: that job *changes state*, this job *only alerts*. Get this wrong (e.g., by copy-pasting `rotation-recover.ts` and forgetting to delete the status UPDATE) and every staged rotation older than 14 days silently reverts to the old crash-recovery flow, which is a regression this story exists to prevent, not reintroduce.
3. To avoid re-alerting every run (the job presumably runs on a recurring schedule, e.g. daily, matching the other workers' cron pattern — confirm the exact cron pattern used by `rotation-break-glass-expire.ts`/other workers at implementation time and match it), add a new nullable `rotations.stale_staged_alerted_at` timestamp column. The scan additionally filters `AND stale_staged_alerted_at IS NULL`, and on alert, sets `stale_staged_alerted_at = NOW()` in the same transaction as the audit write — one alert per staged rotation, not one per scan cycle. If the rotation later gets promoted, retired, or abandoned, this column is irrelevant going forward (the `status = 'staged'` filter already excludes it); no need to clear it.
4. Writes a new audit event `AuditEvent.ROTATION_STALE_STAGED_DETECTED` (new constant, `packages/shared/src/constants/audit-events.ts`, alongside the existing `ROTATION_STALE_DETECTED`) and dispatches an FR100-routed notification to the rotation's `initiatedBy` user and org admins — reuse the existing `enqueueSecurityAlertNotification`/`dispatchDirectUserNotification` machinery from `rotation-recover.ts`, do not build new notification plumbing.
5. Metric: add a counter analogous to `rotationStaleDetectionsTotal` (`apps/api/src/modules/rotation/metrics.js`) — e.g. `rotationStaleStagedAlertsTotal` — following the same pattern.

**Example 4a (collision-avoidance test, required):** A rotation is `staged` at hour 0. `STALE_ROTATION_THRESHOLD_MINUTES=60` (default), `STALE_STAGED_ROTATION_THRESHOLD_DAYS=14` (default). At hour 1, run `runStaleRotationRecoveryJob` — assert it does **not** match this rotation (its `WHERE status = 'in_progress'` filter never matches a `staged` row; write this as an explicit test, not just an inference from the WHERE clause, since a future refactor could accidentally widen that filter). At day 14, run the new stale-staged job — assert it **does** alert, sets `stale_staged_alerted_at`, and does not touch `status`. At day 15, re-run the new stale-staged job — assert it does NOT re-alert (already `stale_staged_alerted_at IS NOT NULL`) and — separately — assert `runStaleRotationRecoveryJob` **still** does not match it (status is still `staged`, never became `in_progress`). This three-part test is the direct regression guard for "make sure they can't collide/double-fire," called out explicitly by the task brief.

**Example 4b (promote before the alert fires):** Rotation staged at hour 0, promoted at day 10 (before the 14-day threshold). The stale-staged job's next run (day 15) does not match it (`status` is now `promoted`, not `staged`) — no alert ever fires for this rotation. This is intentional (see AC-3 Example 3a / Dev Notes Open Questions) — a promoted-but-unretired rotation has no staleness nag in this story.

---

### AC-5: `promote` and `retire` are each their own atomic, CAS-protected, idempotent-under-concurrency transaction

**Given** the existing pattern established by `completeRotation()`/`abandonRotation()`/checklist mutations — rotation-scoped advisory lock (`tryAcquireRotationScopedLock`, keyed by `rotationId`) + optimistic CAS on `rotations.version` in the same UPDATE that performs the status transition (Story 5.5 AC-10 established that **every** terminal transition needs the CAS guard, not just some),

**When** this story ships,

**Then**:
1. `promoteRotation()` and `retireRotation()` (new functions in `apps/api/src/modules/rotation/service.ts`) both call `acquireAndLoadRotation()` (reused helper — same lock-then-load pattern as every existing mutation) and both perform their state transition via a single `UPDATE ... WHERE id = $1 AND version = $observed` CAS, exactly matching `completeRotation()`'s existing shape (see the quoted code in Dev Notes).
2. Two concurrent `POST .../promote` calls for the same rotation (e.g., a genuine double-click, or two admins racing): the advisory lock serializes them at the DB level — the second call blocks briefly, then (once the lock is released by the first) re-reads the row and finds `status` is no longer `staged`, returning `409 { code: "rotation_not_promotable", currentStatus: "promoted" }` (Example 2b) — **not** a silent no-op and **not** a duplicate `ROTATION_PROMOTED` audit event. Write an integration test that fires two concurrent promote requests via `Promise.all` and asserts exactly one `200` and one `409`, and exactly one `ROTATION_PROMOTED` audit row.
3. Same shape for two concurrent `retire` calls — exactly one `200`, one `409 { code: "rotation_not_retirable" }`, exactly one cryptographic purge (assert the old version's `encryptedValue`/`keyVersion` are zeroed exactly once, not twice, and `purgedAt` is set exactly once — a double-purge attempt on an already-null `encryptedValue` must be a safe no-op at the SQL level even if some future refactor removes the status guard, as defense in depth, though the status guard should make this unreachable in practice).
4. A `retire` call racing a `prune-credential-versions.ts` pruning job run on the *same* version (both want to purge/zero the ciphertext) — document and test that both are safe to run concurrently: the pruning job explicitly excludes rows where `rotationLockedAt IS NOT NULL` (AC-3), and `retire` clears `rotationLockedAt` and sets `purgedAt` inside its own transaction, so the two paths cannot both be trying to purge the same still-locked row at the same instant; add an integration test that runs `retire` and a manual pruning-job invocation concurrently against the same credential and asserts no duplicate audit rows / no double-decrement of any counter / final state is `purgedAt` set exactly once.
5. **Atomicity (Failure Mode Analysis finding):** `promoteRotation()`'s status-transition UPDATE, the `credential_versions.promoted_at` flip, and the `ROTATION_PROMOTED` audit write are all issued inside the **same** database transaction as `acquireAndLoadRotation()`'s lock acquisition (mirroring the existing pattern every other rotation mutation already uses — the lock, the state change, and the audit write share one commit/rollback boundary). Same requirement for `retireRotation()`: the status transition, the cryptographic purge (ciphertext zeroing + `purgedAt`), the `rotationLockedAt` clear, and the `ROTATION_OLD_RETIRED` audit write are one transaction. Concretely: if the audit write fails (e.g., a constraint violation), the whole transaction rolls back — there must be no reachable state where a version is cryptographically purged but no `ROTATION_OLD_RETIRED` audit row exists, or vice versa. Add an explicit test that forces the audit-write step to throw (inject a failure, matching whatever fault-injection pattern existing rotation tests use for this) and asserts the version's `purgedAt`/`encryptedValue` are unchanged and `rotations.status` is unchanged after the failed attempt.
6. **Staged-value reveal racing an abandon/retire (Failure Mode Analysis finding):** `GET .../staged-value` reads outside the rotation-scoped advisory lock (reveal is a read, not a mutation, so it deliberately does not take the lock — matching the existing ordinary-value reveal route's pattern). This means a reveal request can, in principle, read mid-flight against a rotation that a concurrent `abandon`/`promote` call is simultaneously transitioning. Required behavior: the reveal query re-checks `rotations.status === 'staged'` as part of its own read (not a stale cached value) and returns `404` if it observes any non-`staged` status, exactly as AC-8.2 already specifies for the post-promotion case — this same check now also covers the post-abandon case for free, since abandon also moves `status` away from `staged`. Add a targeted test: abandon a staged rotation, then call `staged-value` — assert `404`, not a `500` or a stale successful read of ciphertext for a version that may since have been purged (abandon does not purge immediately, but a subsequent pruning run could, so the route must not assume the version is still live).

**Example 5a (rate limit interaction):** `promote`/`retire` are mutation routes under the same `admin`/`owner` role gate and rate-limit tier as `complete`/`abandon` today (confirm the exact rate-limit config applied to `.../rotations/:rotationId/complete` in `apps/api/src/routes.ts` at implementation time and mirror it verbatim for the two new routes — do not invent a new tier). A client hammering `promote` past the rate limit gets the existing `429` shape, unrelated to the CAS/lock behavior above.

---

### AC-6: Checklist confirmation becomes advisory; promote/retire require explicit acknowledgement if incomplete

**Given** `completeRotation()`'s current hard gate — `pending.length > 0` returns `409 { outcome: 'checklist_incomplete', ... }`, no way to override — and the existing `acknowledgedNoDependencies` flag for the *zero-checklist-items* case only,

**When** this story ships,

**Then**:
1. `promoteRotation()` and `retireRotation()` **never** hard-block on incomplete checklist items. Instead, each accepts a body flag — reuse the same name/shape convention, e.g. `{ acknowledgeIncompleteChecklist: true }` — required **only if** `pending.length > 0` at call time (checklist has zero items → same existing `acknowledgedNoDependencies` flag/semantics as today, unchanged). Omitting the required flag when items are pending returns `409 { outcome: 'acknowledgement_required', pendingItems: [...], totalItemCount }` (same response shape `completeRotation()` already returns for `checklist_incomplete`, renamed/repurposed as a soft prompt rather than a hard wall — the caller/UI can re-submit with the flag set, it is never truly stuck).
2. This acknowledgement is required **independently** at both `promote` and `retire` — acknowledging at promote time does not carry forward to retire time; if the checklist is still incomplete when the user later calls `retire`, they must acknowledge again. Rationale: time has passed between promote and retire (FR22 allows this gap to be indefinite), so re-confirming "yes, I still want to proceed despite N unconfirmed systems" at the point of an irreversible cryptographic deletion (retire) is a deliberate, not redundant, safety check.
3. The acknowledgement is recorded in rotation history: both the `ROTATION_PROMOTED` and `ROTATION_OLD_RETIRED` audit event payloads include `checklistAcknowledged: boolean` and `pendingItemCountAtAction: number` (0 if the checklist was actually complete) — this satisfies FR21's "recorded in rotation history" requirement literally, and gives a future auditor the ability to distinguish "promoted with a clean checklist" from "promoted despite 3 unconfirmed systems, explicitly acknowledged."
4. `completeRotation()` (the old route, `POST .../rotations/:rotationId/complete`) is **kept**, unchanged in its own logic, but is now reachable **only** for rotations still in the legacy `in_progress` status (see AC-7) — attempting to call it on a `staged`/`promoted`/`retired` rotation returns `409 { code: "rotation_wrong_state_for_legacy_complete", currentStatus }`. Do not delete this route or its handler function; in-flight legacy rotations from before this ships (a small, finite, shrinking population — see AC-7) still need it until they naturally complete or are migrated forward.

**Example 6a (advisory, not blocking — the core behavior change):** Rotation R has 3 checklist items, 1 confirmed, 2 unconfirmed. `POST .../rotations/R/promote` with no body → `409 { outcome: 'acknowledgement_required', pendingItems: [2 items], totalItemCount: 3 }`. Retry: `POST .../rotations/R/promote` with `{ acknowledgeIncompleteChecklist: true }` → `200`, `ROTATION_PROMOTED` audit written with `checklistAcknowledged: true, pendingItemCountAtAction: 2`. This is the literal FR21 "advisory not blocking" behavior — contrast with today's `completeRotation()`, where the equivalent second call would still be impossible (no ack override exists at all today).

**Example 6b (checklist fully confirmed — the common case, no friction added):** All 3 items confirmed. `POST .../rotations/R/promote` with no body → `200` directly (no acknowledgement needed, `pending.length === 0` short-circuits the check) — audit payload shows `checklistAcknowledged: false, pendingItemCountAtAction: 0` (acknowledgement wasn't needed, so it's recorded as not having been required/given, not conflated with "explicitly overridden").

---

### AC-7: Migration path for in-flight `in_progress` rotations under the OLD confirm-all-then-retire model

> This is the highest-risk part of the whole story per the task brief — do not hand-wave it. Every clause below is a specific, testable decision, not a placeholder.

**Given** that at the moment this migration runs, there may be zero, one, or many `rotations` rows with `status = 'in_progress'` in production — each representing a rotation where, per the ACTUAL shipped behavior (ADR-5.1-04, confirmed by direct code read, contradicting the sprint-change-proposal's stated premise — see Dev Notes), **the new version has already been "current"/servable since the moment the rotation was initiated**, and only the *old* version's retention-purge eligibility is still pending resolution via the (about-to-be-superseded) `completeRotation()` checklist gate,

**When** migration 0050 runs,

**Then**:
1. For every `rotations` row with `status = 'in_progress'`: **do not** move it to `staged`. Moving an in-flight `in_progress` rotation to `staged` would be a real, user-visible regression — the new version is *already* the value being served (per the actual current behavior), and reverting to serving the old value the instant this migration runs would silently break every dependent system that has already been updated to point at the new value, with zero warning. Instead, migrate it to **`promoted`**: set `rotations.status = 'promoted'`, `rotations.promoted_at = rotations.initiated_at` (best available approximation — the new version has effectively been "promoted" since initiation under the old model; there is no better historical timestamp to use, and this is called out explicitly as a judgment call, not a guess presented as fact), and set the corresponding `credential_versions` row's `promoted_at = credential_versions.created_at` for that specific new-version row (the one referenced by `rotations.new_version_id`) — i.e., the AC-1.3 blanket backfill explicitly excludes these rows because they get this row-specific treatment instead, not the generic `promoted_at = created_at` for every row (which happens to compute the same value here, but via a distinct, intentional code path — write the migration as an explicit `UPDATE ... FROM rotations WHERE rotations.new_version_id = credential_versions.id AND rotations.status = 'in_progress'` BEFORE the blanket backfill, then run the blanket backfill with `WHERE promoted_at IS NULL` so it only fills in the remaining untouched rows and never double-processes these).
2. The **old** (previous) version for each such migrated rotation already has `rotationLockedAt IS NOT NULL` (set at the original initiation, per the existing `initiateRotation()` code, unchanged by this migration) — this is preserved as-is, and per AC-3's new clearing rule, it now stays exempt from pruning until someone explicitly calls the new `retire` endpoint. No change needed to this column for these rows; it was already correctly set.
3. These migrated-to-`promoted` rotations are surfaced identically to freshly-promoted ones going forward: the UI's "Retire" card appears for them immediately post-migration (Task 6), the user calls the new `POST .../rotations/:rotationId/retire` endpoint to finish what would previously have been `POST .../complete`. **The old `complete` route becomes unreachable for these rows** (AC-6.4 — they're no longer `in_progress`, they're `promoted`, and `completeRotation()`'s guard only accepts `in_progress`), which is intentional: a rotation migrated to `promoted` should finish via the new `retire` action, not the old `complete` action, because the new "retire" is the more precise, more restricted verb for what's actually left to do (there's no promotion left to perform, only retirement).
4. **A genuinely-empty edge case still gets AC-6.4's legacy path**: if, hypothetically, zero rows have `status = 'in_progress'` at migration time (e.g., this ships to a fresh environment, or all rotations happened to be terminal at the moment of deploy), the legacy `complete` route becomes permanently unreachable in practice for that environment — this is fine and expected, not a bug; the route is kept for safety/back-compat, not because it's expected to be hit.
5. Migration must be **idempotent and safe to re-run** against a partially-migrated state (matching this project's own migration conventions — see 13.1's `WHERE current_version_id IS NULL` idempotency guard as the established precedent): guard the `in_progress → promoted` UPDATE with `WHERE status = 'in_progress'` (naturally idempotent — a second run finds zero matching rows) and the backfill UPDATE with `WHERE promoted_at IS NULL`.
6. Migration must **not** touch rows with `status IN ('completed','abandoned','stale_recovery','break_glass_complete')` at all — those are historical/terminal, their meaning is unchanged, and their `credential_versions` rows get the ordinary AC-1.3 blanket backfill (`promoted_at = created_at`) since by definition their "current" version (if any is still current) was already being served under the old versionNumber-only selection logic.
7. Add a dedicated migration-compatibility integration test (`packages/db/src/migrations/0050-*.test.ts`, following the pattern of `migration-0049-current-version-id-backfill.test.ts`) covering at minimum: (a) an `in_progress` rotation with a fully-unconfirmed checklist migrates to `promoted` with the new version immediately still-servable pre- and post-migration (assert `GET`-equivalent selection query returns the same version ID before and after — this is the literal "no silent value-serving regression" assertion), (b) a `completed` rotation is untouched, (c) an `abandoned` rotation is untouched, (d) re-running the migration a second time is a no-op (idempotency), (e) a credential with **no** rotation history at all still gets its single version's `promoted_at` backfilled correctly by the blanket step.
8. **Migration self-verification (Pre-mortem finding):** the single most plausible way this story causes a production incident is a silent ordering/logic bug in the 0050 backfill that flips which value is "current" for some in-flight rotation, discovered only when a dependent system starts failing days after deploy — by which point the migration is old news and hard to correlate. Mitigate by making the migration self-checking at run time, following the `RAISE NOTICE` summary-count precedent already established by migration 0049 (`_bmad-output/implementation-artifacts/13-1-...md`'s AC-5): after the AC-7 backfill runs, add a verification query that computes, for every credential with at least one non-purged, non-abandoned version, "does exactly one version have the max `(promoted_at, version_number)` tuple among promoted versions" and `RAISE NOTICE`s a single summary count of any credential that fails this invariant (expected: zero). This turns a silent latent bug into a loud, greppable migration-log line at deploy time instead of a multi-day-later production page.

**Example 7b (the "nobody ever retires" long tail — Pre-mortem finding):** FR22 deliberately allows a promoted-but-unretired version to live forever, and AC-3/Example 3a already asserts this is safe against accidental pruning. The pre-mortem risk is organizational, not technical: six months post-launch, dozens of old versions accumulate because "retire" is optional and nobody circles back, quietly growing the KMS key-material footprint and the count of live-but-unused secrets an attacker could target. This story does not add a second mandatory alert for this case (Dev Notes → Open Questions #1 already documents why), but it does add one cheap, low-risk mitigation: a new gauge metric `rotationsPromotedUnretiredCount` (labeled by org), incremented/decremented alongside the existing `rotationStaleDetectionsTotal`/`rotationStaleStagedAlertsTotal` counters (Task 4), giving operators passive dashboard visibility into the size of this population without this story taking on the larger, out-of-scope decision of whether/when to nag about it. Added as Task 4's fourth bullet.

**Example 7a (concrete before/after, the scenario this AC exists to get right):** Credential C, v1 (`createdAt` = day 0), rotation R1 initiated day 5 → v2 created (`createdAt` = day 5), `rotations.status = 'in_progress'`, `rotationLockedAt` set on v1. Dependent system Zeta was manually updated to v2's value on day 6 (outside this system's knowledge — a human did it). Migration 0050 runs day 10. **Before this AC's specific handling:** a naive migration mapping `in_progress → staged` would set v2's `promoted_at = NULL`, and the new AC-1 selection query would then return v1 as "current" — meaning `GET .../credentials/C/value` would suddenly start returning the day-0 value again on day 10, even though Zeta (and possibly other systems) have been using the day-5 value for 4 days. **With this AC's handling:** `in_progress → promoted`, v2's `promoted_at = day 5` (approximated from `initiatedAt`), v1 keeps `rotationLockedAt` set (exempt from pruning, still retrievable via version history, no longer "current"). `GET .../credentials/C/value` returns v2 on day 10, exactly as it did on day 9 — zero observable change for this rotation from the reveal caller's perspective, only a new "Retire" affordance appears in the UI where previously a "Complete rotation" affordance was.

---

### AC-8: Independently-retrievable staged value, gated by the identical reveal permission as normal reveal, with its own audit event

**Given** the sprint-change-proposal's Round-1 elicitation finding — "staged reveal must be gated by the identical permission check as normal reveal (a doubled live-secret surface is a bigger attack target, not smaller)" — and this story's AC-1 inversion meaning the staged (new, unpromoted) version is no longer reachable via the existing `GET .../credentials/:credentialId/value` route once staged,

**When** this story ships,

**Then**:
1. New route `GET /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/staged-value` — same role/permission gate as the existing value-reveal route (confirm the exact role check applied to `GET .../credentials/:credentialId/value` at implementation time — likely `member`+ or a dedicated reveal-permission check distinct from plain `viewer`, and mirror it exactly, do not weaken it).
2. Returns `404` if the rotation is not currently `staged` (i.e., after promotion, this route stops serving the now-promoted version — callers should use the ordinary value route once promoted; this route is scoped strictly to the pre-promotion staging window) — this is a deliberate, tested boundary, not an oversight; write a test that promotes a rotation and then confirms the staged-value route now 404s for it.
3. Writes a new audit event `AuditEvent.STAGED_VALUE_REVEALED` (distinct from the existing reveal-audit event for the ordinary value route) on every successful call — this satisfies the "audit behavior" requirement from AGENTS.md and gives a distinct, filterable audit trail for "who looked at the not-yet-live value" versus "who looked at the live value," which matters operationally (e.g., detecting a staged value being exfiltrated before it's ever promoted, an attack surface the ordinary reveal audit trail wouldn't distinguish).
4. Rate-limited identically to the existing value-reveal route (same tier — mirror, don't invent).
5. **Checklist remains workable between promote and retire (Challenge from Critical Perspective finding):** nothing in this story locks or archives `rotation_checklist_items` at promote time. Checklist items may still be confirmed/failed/retried by dependent-system owners in the window between `promote` and `retire` (this is the expected, common case — many systems will only get confirmed *after* promotion, once they've actually cut over). `retireRotation()`'s `pendingItemCountAtAction` (AC-6.3) is therefore computed fresh at retire time, not carried over from whatever it was at promote time — a rotation that needed an acknowledgement override to promote (5 pending items) may need no override at all to retire (0 pending items, all confirmed in the interim) or vice versa. Add an explicit test: promote with 2 pending items (acknowledged), confirm both items, then retire with no acknowledgement flag — assert `200` (no acknowledgement required, since `pending.length === 0` at retire time, independent of what was true at promote time).
6. **Multi-field (`target_fields`) compatibility (Challenge from Critical Perspective finding):** `rotations.target_fields text[]` (nullable — `NULL` = whole-secret rotation, non-null = specific field keys, per architecture.md line 335 / Epic 13) is unaffected by this story's mechanics. Per FR18's existing text ("the resulting new version is still a full field-set snapshot per FR12"), a field-scoped rotation still creates one ordinary `credential_versions` row exactly like a whole-secret rotation — meaning AC-1's `promoted_at`-gated selection logic, AC-3's exemption mechanism, and AC-8's staged-value reveal all apply completely uniformly regardless of whether `target_fields` is null or not; there is no field-level "current" concept to invert, only the existing credential-version-level one. This compatibility is not a new mechanism this story must build — it is an explicit confirmation, worth stating because Story 13-4 (blocked on this story landing) reuses this exact state machine for field-scoped rotations and needs to know it can build directly on AC-1/AC-3/AC-8 as written, with zero field-aware special-casing required in this story.
7. **Attacker-persona note (Security Audit Personas finding):** this route is a genuinely new secret-disclosure surface — before this story, the only way to see a not-yet-promoted value was to have generated it yourself; after this story, anyone with reveal permission on the credential can read a staged value they didn't create, ahead of it ever becoming "the" live value. This is intentional (FR18's whole point — dependent-system operators need to update ahead of promotion) but means the `STAGED_VALUE_REVEALED` audit stream (AC-8.3) is now a meaningful detective control, not a nice-to-have: confirm at implementation time that this new audit event type is included in whatever existing audit-log filtering/alerting/export surface (if any) already exists for reveal events, rather than silently landing only in the raw `audit_log_entries` table with no operator-facing visibility.

**Example 8a (permission parity test, required):** Create three test users: one with reveal permission, one without (e.g., a `viewer`-tier role that can see rotation status but not values, if such a distinction exists in the current role model — confirm exact role boundaries at implementation time), and one from a different org entirely. Assert: reveal-permitted user gets `200` + the staged value from both the ordinary route (for an already-current value) and the new staged-value route (for a staged value) with identical role gating; non-permitted user gets the same `403`/`401` shape from both routes; cross-org user gets the same tenant-isolation `404` (never a `403` that would leak existence — confirm this matches the existing cross-org behavior pattern on the ordinary value route, and mirror it exactly on the new route, per the AGENTS.md RLS/tenant-isolation testing requirement).

---

### AC-9: Break-glass still creates a staged version, then instantly promotes+retires it — not a bypass of version creation, with a fully layered audit trail

**Given** the current `breakGlassRotation()` (`apps/api/src/modules/rotation/service.ts:1345-1427`): credential-scoped lock → dedup check (`findRecentDuplicateBreakGlass`, Story 5.5 AC-4) → `supersedeActiveRotation()` (auto-abandons any existing active rotation, ADR-5.3-05) → creates a new version (immediately current under the OLD selection logic) → sets `rotationLockedAt` + `breakGlassOverlapExpiresAt` (1h default, `BREAK_GLASS_OVERLAP_MINUTES`) on the previous version → inserts `rotations` row directly with `status: 'break_glass_complete'`, no checklist items — and given the existing `rotation-break-glass-expire.ts` worker that, every minute, purges versions whose `breakGlassOverlapExpiresAt` has passed (clearing `rotationLockedAt`/`breakGlassOverlapExpiresAt`, i.e. the *physical* cryptographic purge is deliberately deferred by up to 1h as a rollback safety window, not instant today),

**When** this story ships,

**Then** — **this is a judgment call, flagged explicitly for maintainer review** because the sprint-change-proposal's literal text ("break-glass still creates a staged version then instantly promotes+retires it in the same transaction window") is in tension with the existing, deliberate 1h overlap safety window, and this story resolves the tension by keeping the safety window's *physical purge timing* unchanged while making the *state-machine bookkeeping* instant, as follows:

1. `breakGlassRotation()` is refactored to, within a single transaction: (a) create the new version with `promotedAt = NULL` initially (a literal `staged` moment, satisfying "still creates a staged version" literally, not just conceptually), (b) immediately set `promotedAt = NOW()` on it in the same transaction (the "instant promote"), (c) write `AuditEvent.ROTATION_PROMOTED` in addition to the existing `AuditEvent.ROTATION_BREAK_GLASS_INITIATED`, (d) set `rotationLockedAt` + `breakGlassOverlapExpiresAt` on the previous version exactly as today (the physical purge is NOT instant — it still waits for the existing overlap worker), and (e) write `AuditEvent.ROTATION_OLD_RETIRED` **at the moment `breakGlassOverlapExpiresAt` actually elapses and `rotation-break-glass-expire.ts` performs the physical purge** — i.e., the *audit event* for "old retired" is deferred to match when the *actual cryptographic deletion* happens, not fired eagerly at break-glass time when the old version is still, deliberately, retrievable during the overlap window. This preserves the existing rollback-safety property (old value still usable for up to 1h after break-glass) while giving 5-6's new audit vocabulary (`ROTATION_PROMOTED`/`ROTATION_OLD_RETIRED`) full coverage of the break-glass path, satisfying the "audit trail implications" focus called out in the task brief.
2. `rotations.status` for break-glass rotations stays `break_glass_complete` (unchanged literal value, per the proposal's own success criterion that this status keeps its exact current meaning) — it does NOT transition through `staged`/`promoted`/`retired` as literal `status` column values; those three ACs are conceptual (reflected via the two new audit events and the `promotedAt` timestamps) but the row's single `status` field remains the existing terminal `break_glass_complete` value for backward-compatible querying/filtering (any existing code or dashboard that filters `status = 'break_glass_complete'` keeps working unchanged).
3. `rotation-break-glass-expire.ts`'s existing purge logic is extended to write the deferred `ROTATION_OLD_RETIRED` audit event (item 1e above) in the same transaction as its existing purge — a straightforward addition to an existing, well-tested code path, not a new mechanism.
4. The existing idempotency dedup (Story 5.5 AC-4, `findRecentDuplicateBreakGlass`) is unchanged and still applies — this story does not touch break-glass's duplicate-request protection.

**Example 9a (audit trail sequencing test, required):** Trigger break-glass on credential C at `T0`. Assert, in order: `ROTATION_BREAK_GLASS_INITIATED` and `ROTATION_PROMOTED` are both written at `T0` (same transaction, same or adjacent timestamps), `ROTATION_OLD_RETIRED` is **not yet** written. Advance time (or directly set `breakGlassOverlapExpiresAt` into the past in the test, matching the existing overlap-expiry worker's own test pattern) and run the expiry worker — assert `ROTATION_OLD_RETIRED` is now written, `purgedAt` is now set on the old version, and `rotationLockedAt` is cleared. This test directly encodes the "audit trail implications" the task brief flagged as a specific area of elicitation focus.

---

### AC-10: Archiving a credential/project with a `staged` or `promoted`-unretired rotation is blocked or requires explicit confirmation

**Given** Story 5.5 AC-1's TOCTOU fix — `initiateRotation()` locks the parent `projects` row `FOR UPDATE` and checks the existing project-archival dependency guard (v1 Scope Decision, epics.md line 65: "Project archival must check for dependencies... archiving a project that owns credentials with active rotation records... must be blocked or require explicit confirmation") — and given this guard today checks for `status IN ('in_progress', 'stale_recovery')` (the pre-5-6 "active" set),

**When** this story ships,

**Then**:
1. The project-archival dependency guard's "active rotation" check is widened to the new active set: `status IN ('staged', 'promoted', 'stale_recovery')` (matching AC-2.6's widened unique-index predicate exactly — keep these two checks in sync, ideally by having both reference the same named constant/array in code rather than two independently-maintained literal lists, to prevent future drift).
2. Whatever confirmation/block UX exists today for archiving a project with an active rotation (confirm the exact mechanism — hard block vs. explicit-confirmation-required — at implementation time by reading the actual Story 4.4/5.5 archival guard code) is extended identically to cover `staged`/`promoted` rotations, with no new UX pattern invented — reuse whatever already exists for `in_progress`/`stale_recovery`.
3. Credential-level archival (if a credential, not just a project, can be independently archived — confirm this exists in the current schema/routes at implementation time) gets the identical guard extension if applicable.
4. **Safe default (Security Audit Personas finding):** if, contrary to expectation, the existing guard turns out to be advisory-only or missing entirely for one of these paths (e.g., credential-level archival exists but was never wired to the dependency guard), the default for `staged`/`promoted` rotations is a **hard block**, not a silently-allowed archival — an insider or a compromised session archiving a project/credential out from under a live `staged` rotation would destroy the ability to ever independently retrieve the staged value again (its only reveal path, AC-8, is scoped to the credential's own routes) with no confirmation step in the way. Do not resolve an ambiguous/missing existing guard by defaulting to "allow" for expedience; escalate to Nestor before shipping a permissive default here.

**Example 10a:** Project P owns credential C, which has an unretired `promoted` rotation (old value still exempt from pruning, per AC-3). Attempt to archive P → same block/confirmation behavior as if C had an `in_progress` rotation today. Retire the rotation first (or explicitly confirm archival with the existing confirmation flow, whichever the existing guard supports) → archival proceeds normally.

---

## Tasks / Subtasks

- [ ] **Task 1: Schema & migration (AC-1, AC-2, AC-3, AC-7)**
  - [ ] Add `credential_versions.promoted_at timestamptz` (nullable)
  - [ ] Add `rotations.promoted_at timestamptz`, `rotations.retired_at timestamptz`, `rotations.stale_staged_alerted_at timestamptz` (all nullable)
  - [ ] Widen `rotations_status_check` CHECK constraint (additive)
  - [ ] Widen `idx_rotations_one_active_per_credential` partial unique index predicate
  - [ ] Write migration `0050_staged_rotation_state_machine.sql` — confirm `0050` is still the next free number against `packages/db/src/migrations/meta/_journal.json` immediately before writing, per this project's recurring migration-numbering-collision risk (see prior stories 13.1/13.2's own flagged risk)
  - [ ] Implement the AC-7 in-flight-rotation backfill (row-specific UPDATE for `in_progress` rows' new-version `promoted_at`, THEN blanket `WHERE promoted_at IS NULL` backfill for everything else, THEN the `in_progress → promoted` status UPDATE — get the ordering right, the row-specific step must run before the blanket step or it will be a no-op double-write that's harmless but pointless; more importantly the STATUS update and the VERSION promoted_at update must both reference the pre-migration `status = 'in_progress'` filter, so do the version-level UPDATE first while it can still join against `status = 'in_progress'`, or capture the affected rotation IDs in a CTE first)
  - [ ] Migration compatibility test suite (AC-7.7's five required cases)
  - [ ] Run `make check-rls` — confirm no RLS gap introduced by new columns (all new columns live on already-org-scoped tables, `rotations`/`credential_versions`, so this should be a clean pass, but run it, don't assume)

- [ ] **Task 2: New service functions & routes (AC-2, AC-5, AC-6, AC-8)**
  - [ ] `promoteRotation()` in `apps/api/src/modules/rotation/service.ts`
  - [ ] `retireRotation()` in `apps/api/src/modules/rotation/service.ts`
  - [ ] `getStagedValue()` (reuses decrypt/reveal machinery from `revealCurrentValue()`, scoped to the staged version)
  - [ ] Routes: `POST .../rotations/:rotationId/promote`, `POST .../rotations/:rotationId/retire`, `GET .../rotations/:rotationId/staged-value` — register in `apps/api/src/routes.ts`, same role/rate-limit tier as sibling rotation mutation/reveal routes (mirror exactly, confirm exact values at implementation time)
  - [ ] Guard `completeRotation()`'s route handler to 409 on non-`in_progress` rotations (AC-6.4)
  - [ ] Update `apps/api/src/modules/credentials/service.ts`'s current-version selection queries per AC-1.2 (audit every call site, not just the two named functions)
  - [ ] Update `abandonRotation()` to accept `staged` as a valid starting state (AC-2.5) and reject `promoted` with the new error code

- [ ] **Task 3: Retention pruning integration (AC-3)**
  - [ ] Move the `rotationLockedAt` clear from `completeRotation()`'s pattern into `retireRotation()`
  - [ ] Regression tests: promoted-unretired survives pruning at `retentionCount = 1`; retired version is/stays purged; idempotent double-purge safety

- [ ] **Task 4: Stale-staged alert worker (AC-4)**
  - [ ] New file `apps/api/src/workers/rotation-stale-staged-alert.ts`
  - [ ] New env var `STALE_STAGED_ROTATION_THRESHOLD_DAYS` in `apps/api/src/config/env.ts` (default 14, min 1, max 90) + `.env.example` entry (per this project's `check-env-example` CI guard — do not forget this file, a prior story (14-2) flagged `.env.example` sync as a real, previously-missed step)
  - [ ] New audit event `AuditEvent.ROTATION_STALE_STAGED_DETECTED` in `packages/shared/src/constants/audit-events.ts`
  - [ ] New metric `rotationStaleStagedAlertsTotal` in `apps/api/src/modules/rotation/metrics.ts`
  - [ ] New gauge metric `rotationsPromotedUnretiredCount` (labeled by org), for passive dashboard visibility into the "promoted but never retired" population (Pre-mortem finding, Example 7b) — observability only, does not drive any alert/nag in this story
  - [ ] Follow `rotation-recover.ts`'s established per-candidate transaction pattern exactly: one transaction per stale-staged candidate row (lock → check → alert → set `stale_staged_alerted_at` → audit, all inside that row's own transaction), never a single transaction spanning multiple candidate rows — a worker crash mid-batch must leave already-processed rows fully alerted+audited and not-yet-processed rows fully untouched, with no partial state possible for any individual row
  - [ ] Register worker's cron schedule matching the existing pattern used by sibling workers (confirm exact registration site — likely `apps/api/src/lib/boss.ts` or equivalent — at implementation time)
  - [ ] Collision-avoidance tests (AC-4 Example 4a/4b)

- [ ] **Task 5: Break-glass audit-trail layering (AC-9)**
  - [ ] Refactor `breakGlassRotation()` per AC-9.1
  - [ ] Extend `rotation-break-glass-expire.ts` per AC-9.3
  - [ ] New audit events `AuditEvent.ROTATION_PROMOTED`, `AuditEvent.ROTATION_OLD_RETIRED` (also used by ordinary promote/retire, Task 2 — define once, use in both places)
  - [ ] Sequencing test (AC-9 Example 9a)

- [ ] **Task 6: Web UI (Surface scope: both)**
  - [ ] Update `apps/web/src/lib/components/rotations/` — Active/Staged/Retire card model replacing the current single-checklist-then-complete UI
  - [ ] New "Promote" and "Retire" actions wired to the new routes, each with the AC-6 acknowledgement-checkbox flow when checklist is incomplete
  - [ ] Staged-value reveal affordance on the Staged card (same reveal-confirmation UX pattern as the existing value-reveal button, wired to the new `staged-value` route)
  - [ ] Advisory-checklist banner copy change (AC "Morgan-member" persona journey note)
  - [ ] Stale-staged alert surfaced wherever `ROTATION_STALE_DETECTED`-driven UI (if any exists from 5.3/5.4) is shown today, or as a new notification-feed entry if no dedicated UI banner exists (confirm at implementation time)
  - [ ] `UpcomingRotationsWidget.svelte` and any rotation-status displays updated to render the new status values without erroring on an unrecognized enum value (defensive: a status-label mapping that throws/blanks on `staged`/`promoted`/`retired` would be a silent regression for every rotation card on the dashboard)

- [ ] **Task 7: Archival guard extension (AC-10)**
  - [ ] Locate and widen the existing project/credential-archival dependency guard's "active rotation" predicate
  - [ ] Keep this predicate and AC-2.6's index predicate in sync (shared constant if feasible)

- [ ] **Task 8: Documentation reconciliation**
  - [ ] Amend `prd.md` FR18, FR21, FR22, FR105 to the text in Dev Notes → "Exact FR text to apply" below
  - [ ] Amend `architecture.md`'s `rotations.status` enum description and completion-transaction description
  - [ ] Amend `epics.md` — add the Story 5.6 entry (it does not exist yet; confirmed by direct read, Epic 5's section currently ends at Story 5.3) using the AC set in this story file as the source of truth (this story file is more detailed/corrected than the sprint-change-proposal's stub — do not just copy the stub verbatim, reconcile it against AC-1/AC-7's corrected premise)
  - [ ] Add a runbook subsection (`docs/runbook.md`, following Story 13.1's precedent of adding an "Upgrades" subsection) documenting the AC-7 migration's operational behavior for anyone running this migration against a production environment with in-flight rotations

## Dev Notes

### Critical correction to the sprint-change-proposal's premise — read this first

The sprint-change-proposal (`_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-24.md`, §2.2) states: *"Today: only `current_version_id`'s value is servable at all during `in_progress` — the staged value isn't independently retrievable."* **This is factually wrong**, verified by direct code inspection:

- `credentials.currentVersionId` exists as a column but is **never written or read by the rotation path** — `completeRotation()` never touches it. It's only used by the unrelated Story 13.2 multi-field-edit path (`insertVersionAndSetCurrent()`).
- The actual "current version" selection (`revealCurrentValue()`, `selectCurrentVersionMeta()`, `apps/api/src/modules/credentials/service.ts`) is `ORDER BY versionNumber DESC` filtered to non-purged/non-abandoned — i.e., **the highest version number wins**, unconditionally.
- Per Story 5.1's own ADR-5.1-04 (quoted verbatim in that story file): *"a `GET .../credentials/:credentialId/value` call made immediately after [initiation] returns the **new** value... the value is live the instant rotation is initiated."*

So today, the **opposite** of the proposal's stated premise is true: initiating a rotation makes the NEW value immediately current/servable; the OLD value is merely purge-protected (`rotationLockedAt`), not "current." Building the staged→promoted model this story requires (old stays current/servable, new is staged separately, current only flips at explicit promote) means **inverting** the selection logic, not merely adding independent retrievability to an already-separate staged value. This is a materially bigger design lift than the proposal implies, and every AC above (especially AC-1 and AC-7) is written against the real, corrected premise. If you find yourself re-reading the sprint-change-proposal document during implementation, treat its narrative/rationale sections as directionally correct but its "Today" architecture-conflicts claims as superseded by this section.

### Exact FR text to apply (Task 8)

```
FR18 (re-amended): Users can initiate a rotation workflow for any stored credential and,
for multi-field secrets, select which field(s) are being rotated. Initiating a rotation
stages a new value alongside the current one — the current value remains live and servable
throughout. The staged value is independently retrievable (audited separately from normal
reveal) so dependent systems can be updated to it ahead of promotion.

FR21 (re-amended): The confirmation checklist is advisory, not blocking: promotion and
deletion of the old credential are explicit, independent user actions. If unconfirmed
checklist items remain, promoting or retiring requires an explicit acknowledgement
(reusing the existing fallback-active acknowledgement pattern), recorded in rotation
history.

FR22 (re-amended): The system never auto-retires the old credential version. Retirement
(cryptographic deletion of the old version's key material) is a separate, explicit user
action, only available after the new value has been promoted. An old version may remain
retrievable indefinitely after promotion until the user explicitly retires it. A
promoted-but-not-yet-retired version is exempt from FR105's retention-count pruning.

FR105 (amended): ...versions are cryptographically deleted after they are no longer
referenced by any staged, in-progress, or stale-recovery rotation, and are not the "old"
(pre-promotion) version of a rotation that has been promoted but not yet explicitly
retired. The exemption lasts until the user explicitly retires that version or its
credential is archived/deleted.
```

Break-glass (FR108) is unchanged by this story's FR text — its behavior amendment (AC-9) is an implementation-level audit-trail enrichment, not a change to what FR108 promises externally.

### Architecture Decision Records (this story)

Following the ADR-numbering convention established by Stories 5.1–5.3 (ADR-5.1-01 through ADR-5.3-08), this story's own decisions are recorded here so a future amending story (e.g. whatever eventually resolves Dev Notes → Open Questions #1) has the same breadcrumb trail to build on:

- **ADR-5.6-01 (current-version selection inversion via `promoted_at`, not a new `staged_version_id` pointer):** Considered and rejected an alternative design — adding a separate `credentials.staged_version_id` FK (parallel to the already-dormant `currentVersionId`) instead of reordering the hot-path current-version selection query. Rejected because: (a) it would be a second dormant-pointer-adjacent column in a codebase that already has one unused `currentVersionId` (AC-1.5) — adding a second unused-until-later pointer compounds the exact documentation/code drift risk already flagged for the first one; (b) the nullable-timestamp-marker idiom (`promoted_at`) is the established pattern from ADR-5.3-04 (`abandonedAt`) and ADR-5.2-02 (`rotationLockedAt`) — consistent with three prior Epic 5 decisions, not a new pattern; (c) a `staged_version_id` pointer still requires the same selection-query change to *exclude* the staged version from "current" — it does not avoid touching the hot path, it just moves the marker from the version row to the credential row. Accepted trade-off: the hot-path reveal query does change (AC-1.2), and this is the story's single highest-risk line-level change — mitigated by the explicit ordering test (Example 1c) and the AC-7 migration self-verification (Round 2 / Pre-mortem finding).
- **ADR-5.6-02 (in-flight `in_progress` rows migrate to `promoted`, not `staged`):** See AC-7 in full — the deciding factor is that the *actual* shipped behavior (not the sprint-change-proposal's stated premise) already serves the new value as current at initiation, so treating in-flight rows as `staged` would be a regression, not a neutral migration.
- **ADR-5.6-03 (`rotationLockedAt` reused for the FR105 exemption across both `staged` and `promoted`-unretired, no new exemption column):** Consistent with ADR-5.6-01's general preference for reusing established markers; the only change is *when* it's cleared (moved from `completeRotation()` to `retireRotation()`, AC-3.1) — the column's meaning ("this version is retention-exempt because a rotation still needs it") is unchanged, only which rotation-lifecycle step clears it.
- **ADR-5.6-04 (stale-staged alert is a wholly separate worker/env-var/column/event, never a parameterization of `rotation-recover.ts`):** Directly required by the Round-4 elicitation finding in the original sprint-change-proposal (reusing the 1h threshold would near-instantly false-alarm every staged rotation) and independently reconfirmed by this story's own research: `STALE_ROTATION_THRESHOLD_MINUTES`'s schema-enforced max (10080 minutes / 7 days) is already smaller than the proposed 14-day default, making a shared/parameterized threshold impossible without also widening the crash-recovery job's bounds — which would itself be a scope-creeping, unrelated change to a mechanism this story is explicitly required to leave untouched (sprint-change-proposal §5 success criteria).
- **ADR-5.6-05 (break-glass keeps its existing 1h physical-purge overlap window; only the audit-event *timing* changes, not the purge timing):** See AC-9 preamble — flagged there as the one ADR in this set that is a judgment call rather than a certainty, because it resolves a genuine textual tension in the source proposal rather than a clean extension of prior Epic 5 precedent. If this judgment call is wrong, the fix is scoped to AC-9 only (audit-event firing points) and does not ripple into AC-1 through AC-8.

### Open Questions / judgment calls for Nestor to confirm

1. **No staleness nag for promoted-but-unretired rotations (AC-3 Example 3a, AC-4 Example 4b).** FR22 explicitly allows indefinite promoted-unretired state, and the elicitation-driven stale-staged alert only watches the pre-promotion `staged` window. This means a rotation that gets promoted quickly (good!) but never retired could sit "promoted" forever with zero nag, only the passive fact that the old version stays retention-exempt (AC-3) and therefore never gets cleaned up. This was NOT explicitly requested by the sprint-change-proposal's 4 elicitation rounds (which focused on the pre-promotion staleness case) and is flagged here as a plausible gap for a future story rather than silently added as scope to this one — this story does not add a second alert type, but the absence is now a documented, deliberate decision rather than an oversight.
2. **Break-glass audit-trail sequencing (AC-9)** is a resolution of a real tension between the proposal's literal text and the existing, deliberate 1h rollback-safety window — flagged explicitly in AC-9's preamble as a judgment call, not a certainty. If Nestor's intent was truly "no overlap window at all under the new model" (a bigger behavior change than this story implements), that needs to be said explicitly, since AC-9 as written preserves the existing 1h window's *purge timing* and only changes *when the bookkeeping audit events fire*.
3. **`credentials.currentVersionId`'s pre-existing dormancy** (unused by the rotation path, confirmed unused by this story too) is left as-is per AC-1.5 — not fixed, not touched. This is called out as a known, pre-existing architecture.md/code inconsistency this story does not resolve, to avoid silently expanding scope.
4. **epics.md does not yet have a Story 5.6 entry** (confirmed by direct read — Epic 5's epics.md section ends at Story 5.3). Task 8 adds one, using this story file (not the sprint-change-proposal's shorter stub) as the source text, since this file's ACs are more precise and in places materially correct the proposal's premise (see the Critical Correction section above).

### Testing requirements summary (AGENTS.md coverage checklist, mapped to this story)

- **RLS/tenant isolation:** AC-8 Example 8a (cross-org staged-value reveal returns tenant-scoped 404, never a leaking 403); all new columns live on already org-scoped tables — run `make check-rls` regardless (Task 1).
- **Audit behavior/failure handling:** AC-2.3/2.4, AC-6.3, AC-8.3, AC-9 (new `ROTATION_PROMOTED`/`ROTATION_OLD_RETIRED`/`ROTATION_STALE_STAGED_DETECTED`/`STAGED_VALUE_REVEALED` events, each with a specific required payload shape and firing-condition test).
- **Auth/session lifecycle:** promote/retire/staged-value routes inherit the existing rotation-route role gates unchanged — no new auth surface, but AC-8.1/8.4 require confirming and mirroring the exact existing gate, not inventing a new one.
- **Concurrent access:** AC-5 (double-promote, double-retire, retire-vs-pruning-job race) — all three are required integration tests, not just documented behavior.
- **Rate limits:** AC-5 Example 5a, AC-8.4 — mirror existing tiers exactly.
- **Migration compatibility:** AC-7 in full — this is the story's highest-risk area; five required test cases enumerated in AC-7.7.
- **Operational logging:** new workers (Task 4) and extended workers (Task 5) should use the existing `operationalLog`/`serializeLogError` helpers (`apps/api/src/lib/logger.ts`) and existing metrics patterns (`rotationStaleDetectionsTotal` as the template for the new counter) — do not invent new logging conventions.

### Project Structure Notes

- Alignment with unified project structure: all new service logic lands in the existing `apps/api/src/modules/rotation/service.ts` (no new module directory needed — this is an amendment to an existing, already-large file, not a new subsystem); new worker follows the existing flat `apps/api/src/workers/*.ts` convention; new UI components extend the existing `apps/web/src/lib/components/rotations/` directory from Story 5.4.
- No detected conflicts with the unified project structure — this story is purely additive/amendatory within existing module boundaries.

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-24.md] — original 4-round elicitation and proposed FR/architecture text (premise partially corrected above, see Critical Correction section)
- [Source: _bmad-output/planning-artifacts/prd.md#FR18] [#FR21] [#FR22] [#FR105] — current pre-amendment text
- [Source: _bmad-output/planning-artifacts/architecture.md] lines 331, 335, 566, 636-637, 1472, 1499 — rotation-related architecture notes (line 331's `current_version_id` claim is superseded by this story's Critical Correction)
- [Source: _bmad-output/planning-artifacts/epics.md] lines 1649-1755 — Epic 5 section (Stories 5.1-5.3; no 5.6 stub present, added by this story's Task 8)
- [Source: _bmad-output/implementation-artifacts/5-1-rotation-initiation-and-checklist-generation.md] — ADR-5.1-01 (advisory lock), ADR-5.1-04 (new value live at initiation — foundational to this story's Critical Correction)
- [Source: _bmad-output/implementation-artifacts/5-2-rotation-checklist-confirmation-and-completion.md] — ADR-5.2-02 (retirement = clearing rotation_locked_at, no status column on credential_versions), line 386 (reveal behavior unchanged by completion)
- [Source: _bmad-output/implementation-artifacts/5-3-stale-rotation-recovery-and-break-glass-emergency-rotation.md] — ADR-5.3-02 (time-threshold not lock-presence staleness), ADR-5.3-04 (nullable-timestamp idiom over status enums), ADR-5.3-05 (break-glass supersedes not blocks), ADR-5.3-08 (partial unique index widening precedent)
- [Source: _bmad-output/implementation-artifacts/5-4-rotation-workflow-web-ui.md] — ground-truth route table, UI component locations
- [Source: _bmad-output/implementation-artifacts/5-5-epic-5-completion-rotation-hardening-and-technical-debt.md] — AC-1 (TOCTOU project-lock guard), AC-4 (break-glass idempotency dedup), AC-8 (org_id-leading index), AC-10 (CAS-on-every-terminal-transition precedent), AC-13 (audit payload completeness precedent)
- [Source: packages/db/src/schema/rotations.ts] — current schema, verified 2026-07-24
- [Source: packages/db/src/schema/credential-versions.ts] — current schema, verified 2026-07-24
- [Source: apps/api/src/modules/rotation/service.ts] — `initiateRotation()`, `completeRotation()` (lines ~907-980, quoted in full above), `breakGlassRotation()`, `acquireAndLoadRotation()`
- [Source: apps/api/src/modules/credentials/service.ts] — `selectCurrentVersionMeta()`, `revealCurrentValue()` current-version selection logic
- [Source: apps/api/src/workers/rotation-recover.ts] — stale-recovery job to NOT be confused with or reused by the new stale-staged job
- [Source: apps/api/src/workers/prune-credential-versions.ts] — FR105 pruning job, `rotationLockedAt` exemption mechanism
- [Source: packages/db/src/migrations/meta/_journal.json] — confirms next migration number 0050 as of 2026-07-24 (re-verify at implementation time)
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (bmad-create-story)

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created. Story written against a corrected premise (see Dev Notes → Critical correction) after direct code verification contradicted the sprint-change-proposal's stated "Today" architecture-conflicts claim about `current_version_id`. This correction materially changes the design (an inversion of current-version selection logic, not merely adding independent staged retrievability) and is the single most important thing a dev-story agent must internalize before starting Task 1.
- 5-round advanced elicitation applied and integrated directly into the ACs/Dev Notes (Failure Mode Analysis, Pre-mortem Analysis, Security Audit Personas, Architecture Decision Records, Challenge from Critical Perspective): added explicit promote/retire transaction-atomicity requirements and a staged-value-vs-abandon race test (AC-5.5/5.6); added a migration self-verification `RAISE NOTICE` invariant check and a `rotationsPromotedUnretiredCount` observability gauge for the indefinite-promoted-unretired long tail (AC-7.8, Task 4); hardened the archival guard to a safe-default hard-block if the existing guard mechanism turns out to be missing/ambiguous, plus an explicit note on routing the new `STAGED_VALUE_REVEALED` audit event into existing operator-facing audit surfaces (AC-10.4, AC-8.7); recorded 5 formal ADRs (ADR-5.6-01 through 05) including an explicitly-considered-and-rejected alternative design (a `staged_version_id` pointer instead of inverting the selection query); and confirmed/documented multi-field (`target_fields`) compatibility plus checklist-remains-workable-between-promote-and-retire semantics (AC-8.5/8.6), both relevant to the blocked Story 13-4.

### File List
