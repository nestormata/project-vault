# Story 5.2: Rotation Checklist Confirmation & Completion

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-07-01 — comprehensive developer guide for the SECOND story in Epic 5. This story extends the `apps/api/src/modules/rotation/` module Story 5.1 creates: it adds checklist confirm/fail/retry mutations, the completion endpoint (which retires the superseded credential version), the FR65 upcoming-rotations read endpoint, and wires two previously-hardcoded dashboard placeholders to real data. Story 5.1 is `ready-for-dev` but NOT yet implemented in this branch (no `apps/api/src/modules/rotation/`, no `rotations` schema files, no migration exist yet) — this story's tasks assume 5.1 has landed by the time 5.2 is implemented, and every reference to 5.1's schema/routes below is a description of what 5.1's own story file specifies it will build, not code that exists in this branch today. Read "Prerequisites" and "Cross-Story Schema Extension" before touching anything. -->

## Story

As a developer completing a credential rotation,
I want to confirm each dependent system has been updated and complete the rotation when all are confirmed,
so that the old credential version is retired only after every system is safely updated.

*Covers: FR20, FR21, FR22, FR65, FR66, FR75.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-5.2-Rotation-Checklist-Confirmation--Completion`]

> **Note on FR65:** the epic's `*Covers:*` line for Story 5.2 lists only FR20/FR21/FR22/FR66/FR75, but the AC text immediately below it includes `GET /api/v1/projects/:projectId/rotations/upcoming` explicitly tagged `(FR65)` (epics.md line 1617). This is a documentation gap in the epic, not a scope signal — FR65 has no other story home anywhere else in the epics file, and 5.1's own Product Surface Contract explicitly deferred FR65/`upcoming` to "a 5.2 follow-up" (5.1 AC-19: "`GET .../rotations/upcoming?horizon=` (FR65) ... — Story 5.2"). FR65 is in scope for this story; treat the `*Covers:*` line as incomplete, not authoritative.

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 5.1 (`rotations` + `rotation_checklist_items` tables, `apps/api/src/modules/rotation/{schema,service,routes}.ts`, `packages/shared/src/schemas/rotations.ts`) merged | This story adds new columns to `rotation_checklist_items` (a new migration), new functions to the *existing* `service.ts`/`routes.ts`/`schema.ts` files (not a new module), and new exports to the *existing* `packages/shared/src/schemas/rotations.ts`. It does not recreate anything 5.1 built — see "Cross-Story Schema Extension" below for the exact starting shape. |
| Story 2.4 (`credentials.rotation_schedule` cron column + `validateRotationCron()`) merged | FR65's "upcoming rotations" computation reads `credentials.rotation_schedule` (a 5-field cron string, e.g. `"0 0 1 * *"`) and uses the same `cron-parser` library 2.4 already depends on (`packages/shared/src/validation/rotation-cron.ts` imports `CronExpressionParser` from `cron-parser`). No new dependency to add. |
| Story 2.2 (`credential_versions`, `rotation_locked_at` retention seam) merged | Completion (AC-12) clears `rotation_locked_at` on the superseded version — the exact column 2.2 built and 5.1 sets; this story is the first to *clear* it. |
| Epic 3 notification infrastructure (`notificationQueue` table, `apps/api/src/notifications/dispatcher.ts`, `packages/shared/src/constants/notification-types.ts`) merged and done | FR75's "alert is queued via the notification system" reuses `createOrgAdminNotificationEntries()`/`dispatchOrgAdminNotification()` verbatim — no new notification infrastructure. See "Notification Integration Pattern" below. |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | At 5.1-story-creation time the next free migration was `0026_rotations.sql` (5.1's own migration). This story's migration is therefore illustratively `0027_rotation_checklist_state.sql` — **re-read the journal immediately before generating**; if other stories land first, use the actual next free number. |

---

## Cross-Story Schema Extension (Read First — Do Not Skip)

Story 5.1 creates `rotation_checklist_items` with this shape (verbatim from `_bmad-output/implementation-artifacts/5-1-rotation-initiation-and-checklist-generation.md` AC-2 — **do not re-create this file, only extend it**):

```typescript
// packages/db/src/schema/rotation-checklist-items.ts (5.1's version — starting point)
export const rotationChecklistItems = pgTable('rotation_checklist_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  ...orgScoped({ onDelete: 'cascade' }),
  rotationId: uuid('rotation_id').notNull().references(() => rotations.id, { onDelete: 'cascade' }),
  dependencyId: uuid('dependency_id').references(() => credentialDependencies.id, { onDelete: 'set null' }),
  systemName: text('system_name').notNull(),
  status: text('status').notNull().default('unconfirmed'), // CHECK already includes: unconfirmed, confirmed, failed, max_retries_exceeded
  confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ /* indexes, status CHECK — unchanged by this story */ }))
```

**This story's migration adds five columns** (AC-1) — the `status` CHECK constraint's four values (`unconfirmed`, `confirmed`, `failed`, `max_retries_exceeded`) were **already fully declared by 5.1** (ADR-5.1-02: "the full state machine is already fully specified in epics.md Stories 5.1-5.3 today") — this story only ever *writes* the three values 5.1 reserved but never used (`confirmed`, `failed`, `max_retries_exceeded`). **No CHECK-constraint migration is needed for `status`.**

The `rotations` table (5.1 AC-1) already has everything this story's rotation-level mutations need: `status` (CHECK already includes `'completed'`, unused until now), `version` (optimistic-lock column, 5.1 only ever writes `1`), `completedAt` (nullable, unset until now), `newVersionId`/`previousVersionId` (direct FKs to the two `credential_versions` rows touched by initiation — added during 5.1's own adversarial-review pass specifically so this story would not need to re-derive "the locked version" by inference). **No `rotations` schema changes in this story.**

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no (no web UI ships in this story — same gap 5.1 flagged) |
| **Linked UI story** (if API-only) | `TBD` — same blocking note as 5.1: Epic 5 has no dedicated frontend story in `sprint-status.yaml` today. This story does not resolve that gap and must not be blocked on it (5.1 already established this precedent). When this story reaches `review`, the reviewer/SM must re-check whether a web rotation-UI story has since been added; if not, extend the `deferred-work.md` §Epic 5 entry 5.1 should have created, don't create a duplicate. |
| **Honest placeholder AC** (if UI deferred) | This story **removes** two of the three hardcoded placeholders `deferred-work.md` (line 51/53) documents as deferred to Epic 5: `AC-E2d — projects with overdue rotations` (org dashboard) and the project dashboard's `upcomingRotations: []` (see AC-15 below, both wired to real data by this story). The remaining `recentAccessEvents`/`monitoredServiceHealth` placeholders on the project dashboard are untouched — those belong to Epic 6/8, not this story. |
| **Persona journey** | API-only, no evaluator-visible UI this story. Same rationale as 5.1: the end-to-end rotation-confirmation *workflow* needs a checklist UI that isn't scheduled yet. A single-story persona stub would misrepresent an unusable partial flow. |

### Persona journey stub

N/A for this story — API-only, no UI surface exists yet. See "Linked UI story" blocking note above (inherited unresolved from 5.1).

---

## Notification Integration Pattern (Read Before Coding FR75)

FR75 ("alert is queued via the notification system") reuses **existing** Epic 3 infrastructure verbatim — do not build a new queue, dispatcher, or delivery mechanism.

**Enqueue inside the mutation's transaction**, exactly like `apps/api/src/workers/check-failed-auth-threshold.ts` (a synchronous, in-transaction call, not a separate job):
```typescript
import { enqueueSecurityAlertNotification } from '../../notifications/dispatcher.js'

const jobs = await enqueueSecurityAlertNotification({
  orgId,
  templateId: 'rotation.confirmation_failed', // or 'rotation.max_retries_exceeded'
  payload: { rotationId, itemId, credentialId, systemName, reason },
  severity: 'warning', // 'critical' for max_retries_exceeded
  tx, // same transaction as the checklist item UPDATE + audit write
})
```

**Dispatch after commit**, exactly like `apps/api/src/modules/auth/routes.ts` (`sendPendingMfaNotifications`, lines 74-91) — `secureRoute`'s transaction has already committed by the time the route handler's return value is being built, so:
```typescript
type BossFastify = FastifyApp & { boss?: BossService }
// after ctx.tx has committed (i.e., after the service call returns):
const boss = (fastify as BossFastify).boss
if (boss) {
  try {
    await sendNotificationJobs(boss, jobs)
  } catch (error) {
    // never let dispatch failure surface as a 500 — the confirm/fail/retry mutation already
    // succeeded and committed; the notification_queue row is durable and the
    // notification:*-catchup cron (10-min, main.ts) will pick it up if this send fails.
    request.log.warn({ err: error }, 'rotation notification dispatch failed')
  }
}
```
`boss` is undefined in integration tests that build the app directly (no pg-boss instance) — the row still lands in `notification_queue`, only the async delivery push is skipped, identical to the auth module's documented behavior.

**New alert types** — add to `NOTIFICATION_ALERT_TYPES` in `packages/shared/src/constants/notification-types.ts` (currently: `security.failed_auth_threshold`, `security.mfa_recovery_used`, `security.mfa_recovery_codes_regenerated`, `credential.expiry`, `service.down`, `service.recovery`, `rotation.stale` [reserved for 5.3, unused until then], `backup.failure`, `machine_key.expiry`, `security.anomalous_access`, `machine_cache.activated`):
```typescript
'rotation.confirmation_failed',
'rotation.max_retries_exceeded',
```

**Template rendering:** `apps/api/src/notifications/templates/index.ts`'s `renderEmailTemplate()`/`renderSlackTemplate()` already fall back to a generic `[Project Vault] Notification (${templateId})` renderer for any `templateId` without a dedicated entry in `EMAIL_RENDERERS`/`SLACK_RENDERERS` (verified: `apps/api/src/notifications/templates/index.ts` lines ~68-80). **This story deliberately does not add dedicated template files** (`rotation-confirmation-failed.ts`, etc.) — the generic fallback is a legitimate, already-used code path (every alert type does not have a dedicated template), and hand-authoring email/Slack copy for two new alert types is presentation work, not part of any AC in this story. Flag, don't build: a follow-up polish story can add dedicated templates later without touching this story's logic.

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Migration | `rotation_checklist_items` gets 5 new columns: `retry_count`, `retry_scheduled_at`, `last_failure_reason`, `last_acted_by`, `last_acted_at`. No new tables, no CHECK-constraint changes (5.1 already declared the full vocabulary). |
| Confirm | `POST .../rotations/:rotationId/checklist/:itemId/confirm` — item → `confirmed` from any of `unconfirmed`/`failed`/`max_retries_exceeded`. Rejects re-confirming an already-`confirmed` item (409). |
| Fail | `POST .../checklist/:itemId/fail` — item → `failed` from `unconfirmed` only. Alert queued every call. |
| Retry | `POST .../checklist/:itemId/retry` — item `failed` → `unconfirmed`, `retryCount += 1`, up to `ROTATION_MAX_RETRIES` (default 3, env `min 1 max 10`). Exceeding the cap → item → `max_retries_exceeded`, alert queued, request itself returns `422`. |
| Concurrency (RS-E5a) | Every mutation acquires a non-blocking, transaction-scoped advisory lock keyed by `rotationId` (mirrors 5.1's ADR-5.1-01 pattern, different key domain), then CAS-increments `rotations.version`. Lock contention or CAS mismatch → `409 { code: "concurrent_modification", currentVersion }`. |
| Complete | `POST .../rotations/:rotationId/complete` — blocked (`422 checklist_incomplete`) unless every item is `confirmed`; zero-item rotations require `{ acknowledgedNoDependencies: true }` (AC-E5a). On success: rotation → `completed`, superseded `credential_versions` row's `rotation_locked_at` cleared (the "retirement" — see ADR-5.2-02), all atomic (NFR-REL3/4). |
| Live status (FR66) | Delivered by 5.1's *existing* `GET .../rotations/:rotationId` — no new route. This story adds the test coverage 5.1 could not write (mixed item states didn't exist yet) and adds `lastActedBy`/`lastActedAt` to the response shape. |
| Upcoming (FR65) | New `GET /api/v1/projects/:projectId/rotations/upcoming?horizon=7d\|30d\|90d` — cron-computed next-due date per credential, excludes credentials with an active (`in_progress`/`stale_recovery`) rotation. |
| Dashboard wiring | Two hardcoded placeholders (`projectsWithOverdueRotations` on org dashboard, `upcomingRotations` on project dashboard) now query real data via a shared `computeUpcomingRotations()` helper. |
| Roles | Confirm/fail/retry: `member`+ (matches general credential-mutation minimum). Complete: `admin`/`owner` (matches initiation's threshold — irreversible action). Reads: `viewer`+. |
| Security | RLS org-scoped (no new tables — inherits 5.1's policies); cross-org/cross-project/cross-credential/cross-rotation/cross-item → 404; sealed vault → 503; `.strict()` bodies. |
| Audit | 5 new fail-closed audit events: `rotation.checklist_item_confirmed`, `...failed`, `...retried`, `...max_retries_exceeded`, `rotation.completed`. |
| Notifications | FR75 alerts via existing Epic 3 dispatcher — see "Notification Integration Pattern" above. |
| Tests | Confirm (all 3 valid source states + already-confirmed 409), fail (+ alert), retry (success + max-exceeded), concurrent mutation (409, both lock and CAS backstop), complete (happy/incomplete/zero-dep/atomicity), role enforcement, cross-tenant 404s, sealed vault 503, validation 422s, upcoming (horizon filtering, active-rotation exclusion), dashboard wiring (both slices), audit-write-failure rollback. |

---

### AC-1: Migration — `rotation_checklist_items` New Columns

**Given** this story tracks retry counts, scheduled retry hints, the last failure's reason, and "who last acted" per FR66,
**When** the migration is authored,
**Then** `packages/db/src/schema/rotation-checklist-items.ts` (5.1's file) gains five new fields:

```typescript
retryCount: integer('retry_count').notNull().default(0),
retryScheduledAt: timestamp('retry_scheduled_at', { withTimezone: true }),
lastFailureReason: text('last_failure_reason'),
lastActedBy: uuid('last_acted_by').references(() => users.id, { onDelete: 'set null' }),
lastActedAt: timestamp('last_acted_at', { withTimezone: true }),
```

**And** the migration `packages/db/src/migrations/00NN_rotation_checklist_state.sql` (R1 — verify number) is a plain `ALTER TABLE rotation_checklist_items ADD COLUMN ...` for all five columns — no RLS change (table already has RLS from 5.1's migration), no new indexes required (none of these columns are queried by a WHERE clause anywhere in this story's ACs — `retryCount` is read by primary key row, never filtered/sorted on).

**And** `confirmedBy`/`confirmedAt` (5.1's columns) remain semantically narrow — set only when status becomes `confirmed`, unlike `lastActedBy`/`lastActedAt` which update on **every** mutation (confirm, fail, retry) regardless of the resulting status. This is deliberate: FR66 asks "who last acted on the checklist," a broader question than "who confirmed it." A future "who last touched this rotation" query (not built in this story) would be `SELECT * FROM rotation_checklist_items WHERE rotation_id = $1 ORDER BY last_acted_at DESC LIMIT 1` — no rotation-level column needed.

**And** `retryCount` is **not** reset by anything in this story once incremented — even a subsequent `confirm()` call (e.g., a human manually verifies the system and confirms directly after 2 failed retries) leaves `retryCount` at its last value. This is intentional: `retryCount` is a permanent record of how many automated retry cycles this item went through, useful for post-incident review, not a "live counter" that should reset on success.

---

### AC-2: `POST .../rotations/:rotationId/checklist/:itemId/confirm` — Happy Path

**Given** a rotation is `in_progress` and a checklist item belonging to it has status `unconfirmed`, `failed`, or `max_retries_exceeded`,
**When** a user with `member`/`admin`/`owner` org role calls this endpoint with `{ notes? }`,
**Then**, inside a single transaction, after acquiring the rotation-scoped advisory lock (AC-8):
1. `UPDATE rotation_checklist_items SET status = 'confirmed', confirmed_by = $userId, confirmed_at = NOW(), last_acted_by = $userId, last_acted_at = NOW(), notes = COALESCE($notes, notes) WHERE id = $itemId AND rotation_id = $rotationId RETURNING *`.
2. `UPDATE rotations SET version = version + 1, updated_at = NOW() WHERE id = $rotationId AND version = $observedVersion RETURNING version` (the CAS — see AC-8).
3. Write `rotation.checklist_item_confirmed` audit row (fail-closed).
4. Commit. Return `200` with the updated checklist item and the rotation's new `version`.

**Request:**
```http
POST /api/v1/projects/00000000-0000-4000-8000-000000000010/credentials/00000000-0000-4000-8000-000000000020/rotations/b2a1c3d4-0000-4000-8000-000000000099/checklist/c1c1c1c1-0000-4000-8000-000000000001/confirm
Content-Type: application/json
Cookie: access-token=<jwt>

{ "notes": "Verified billing-worker picked up the new key at 14:41 UTC" }
```

**Response `200`:**
```json
{
  "data": {
    "item": {
      "id": "c1c1c1c1-0000-4000-8000-000000000001",
      "rotationId": "b2a1c3d4-0000-4000-8000-000000000099",
      "systemName": "billing-worker (production)",
      "status": "confirmed",
      "confirmedBy": "11111111-1111-4111-8111-111111111111",
      "confirmedAt": "2026-07-01T14:41:12.000Z",
      "lastActedBy": "11111111-1111-4111-8111-111111111111",
      "lastActedAt": "2026-07-01T14:41:12.000Z",
      "retryCount": 0,
      "notes": "Verified billing-worker picked up the new key at 14:41 UTC"
    },
    "rotationVersion": 2
  }
}
```

**And** confirming from `failed` or `max_retries_exceeded` (not just `unconfirmed`) is explicitly supported — a human who manually fixed the target system and verified it should not be forced through the `retry` endpoint first. `confirmedBy`/`confirmedAt` always reflect the actual confirm action regardless of the prior status.

---

### AC-3: `POST .../checklist/:itemId/confirm` — Invalid State (409)

**Given** a checklist item's current status is already `confirmed`,
**When** the same or a different user calls `confirm` on it again,
**Then** the request is rejected **before** any write, with:
```http
HTTP 409
{ "code": "already_confirmed", "message": "This checklist item is already confirmed.", "confirmedBy": "11111111-...", "confirmedAt": "2026-07-01T14:41:12.000Z" }
```
This is a deliberate non-idempotent design: re-confirming would silently overwrite `confirmedBy`/`confirmedAt`/`notes`, destroying the original evidentiary record FR23's audit trail depends on. A client that wants idempotent "already done" semantics should treat this specific `409` as success, not retry.

**And** `confirm`/`fail`/`retry` called against an item belonging to a rotation whose own `status` is not `in_progress` (e.g., already `completed`, `abandoned`, `stale_recovery`, `break_glass_complete`) is rejected with:
```http
HTTP 422
{ "code": "rotation_not_active", "message": "This rotation is not in progress.", "status": "completed" }
```
(checked immediately after acquiring the advisory lock, before any item-status validation — the rotation-level check always takes precedence over the item-level one).

---

### AC-4: `POST .../checklist/:itemId/fail` — Happy Path (FR75)

**Given** a checklist item has status `unconfirmed`,
**When** a user with `member`+ role calls this endpoint with `{ reason, retryScheduledAt? }`,
**Then**, inside the same locked-transaction pattern as AC-2:
1. `UPDATE rotation_checklist_items SET status = 'failed', last_failure_reason = $reason, retry_scheduled_at = $retryScheduledAt, last_acted_by = $userId, last_acted_at = NOW() WHERE id = $itemId AND rotation_id = $rotationId AND status = 'unconfirmed' RETURNING *` — the `AND status = 'unconfirmed'` clause is the state-machine guard; zero rows updated means the item wasn't in the expected state (AC-5).
2. CAS-increment `rotations.version` (AC-8).
3. Write `rotation.checklist_item_failed` audit row (fail-closed) with `payload: { rotationId, itemId, systemName, reason }`.
4. Queue a `rotation.confirmation_failed` alert via `enqueueSecurityAlertNotification` (severity `warning`) — **every** call to `fail`, not just the first, queues an alert (epics.md: "an alert is queued via the notification system," no "only once" qualifier).
5. Commit. Post-commit, best-effort `sendNotificationJobs` (see "Notification Integration Pattern").
6. Return `200` with the updated item. **The rotation itself remains `in_progress`** — FR75's entire point is that a failure does not abandon the rotation.

**Request:**
```http
POST .../rotations/b2a1c3d4-.../checklist/c1c1c1c1-.../fail
{ "reason": "GitHub Actions deploy pipeline still using the old key — secret not yet updated in repo settings", "retryScheduledAt": "2026-07-01T16:00:00.000Z" }
```

**Response `200`:**
```json
{
  "data": {
    "item": {
      "id": "c1c1c1c1-0000-4000-8000-000000000002",
      "status": "failed",
      "lastFailureReason": "GitHub Actions deploy pipeline still using the old key — secret not yet updated in repo settings",
      "retryScheduledAt": "2026-07-01T16:00:00.000Z",
      "retryCount": 0,
      "lastActedBy": "11111111-1111-4111-8111-111111111111",
      "lastActedAt": "2026-07-01T14:45:00.000Z"
    },
    "rotationVersion": 3
  }
}
```

**And** `retryScheduledAt`, when provided, is stored **for operator visibility only** — this story does **not** build a scheduler or reminder job that reads it and triggers an automatic retry. The item stays `failed` until a human calls `retry` or `confirm` explicitly. Inventing an unscheduled background job here would be scope creep with no epic AC requesting it (contrast with 5.3's real `rotation:recover` job, which *is* specified).

---

### AC-5: `POST .../checklist/:itemId/fail` — Invalid State & Validation

**Given** a checklist item's status is `confirmed`, `failed`, or `max_retries_exceeded` (anything but `unconfirmed`),
**When** `fail` is called on it,
**Then** the response is:
```http
HTTP 409
{ "code": "invalid_item_status", "message": "Cannot fail an item with status 'confirmed'.", "currentStatus": "confirmed", "lastActedBy": "11111111-1111-4111-8111-111111111111", "lastActedAt": "2026-07-01T14:45:00.000Z" }
```
(An already-`failed` item must go through `retry` first, which resets it to `unconfirmed`, before it can be failed again — this is what makes `retryCount` an accurate count of failure/retry cycles.)

**And**, mirroring AC-3's idempotent-retry guidance for `confirm`, this `409` includes `lastActedBy`/`lastActedAt` specifically so a client that lost the response to its own `fail` call can tell its retry apart from a race: if `lastActedBy` matches the retrying client's own `userId`, the retried call most likely observed its own prior write and can be treated as success (not a strict guarantee — a different user could theoretically act in the gap between the lost response and the retry, so a client that needs certainty should still re-fetch via `GET .../rotations/:rotationId`); if `lastActedBy` is a different user, someone else changed the item's state first. Unlike `confirm`'s single well-known prior state (`already_confirmed`), `fail`'s `409` can be reached from three different prior statuses (`confirmed`, `failed`, `max_retries_exceeded`) — the `currentStatus` field disambiguates which one, so a client that only expects to have raced its own retry (not a genuine `confirmed`/`max_retries_exceeded` transition by someone else) can distinguish that case too.

**Validation table** (request body `FailChecklistItemBodySchema = z.object({ reason: z.string().trim().min(1).max(1024), retryScheduledAt: z.iso.datetime().nullable().optional() }).strict()`):

| Invalid body | Expected `422` `code` |
|---|---|
| `{}` (missing `reason`) | `validation_error` (Zod path `["reason"]`) |
| `{ "reason": "" }` / `{ "reason": "   " }` (empty/whitespace-only after trim) | `validation_error` |
| `{ "reason": "x".repeat(1025) }` | `validation_error` |
| `{ "reason": "ok", "retryScheduledAt": "not-a-date" }` | `validation_error` (Zod path `["retryScheduledAt"]`) |
| `{ "reason": "ok", "extra": true }` (`.strict()`) | `validation_error` |

---

### AC-6: `POST .../checklist/:itemId/retry` — Happy Path (FR75)

**Given** a checklist item has status `failed` and `retryCount < ROTATION_MAX_RETRIES` (env var, default `3`, valid range `1`-`10` — AC-E5b),
**When** a user with `member`+ role calls this endpoint with an empty body (`{}`, `.strict()` — no fields accepted),
**Then**, inside the locked-transaction pattern:
1. `UPDATE rotation_checklist_items SET status = 'unconfirmed', retry_count = retry_count + 1, last_acted_by = $userId, last_acted_at = NOW() WHERE id = $itemId AND rotation_id = $rotationId AND status = 'failed' RETURNING *`.
2. CAS-increment `rotations.version`.
3. Write `rotation.checklist_item_retried` audit row with `payload: { rotationId, itemId, systemName, retryCount: <new value> }`.
4. Commit. Return `200` with the updated item, now `unconfirmed` again and ready for a fresh `confirm` or `fail`.

**Note:** `lastFailureReason`/`retryScheduledAt` are **not cleared** on retry — they remain visible as "the reason for the most recent failure" until either a new `fail` call overwrites them or the item reaches `confirmed`. This preserves context for whoever next looks at the item without an extra round-trip to audit history.

**Response `200`** (abbreviated): `{ "data": { "item": { "id": "...", "status": "unconfirmed", "retryCount": 1, ... }, "rotationVersion": 4 } }`.

---

### AC-7: `POST .../checklist/:itemId/retry` — Max Retries Exceeded (AC-E5b)

**Given** a checklist item has status `failed` and `retryCount >= ROTATION_MAX_RETRIES` (i.e., this would be the `(max+1)`th retry attempt),
**When** `retry` is called,
**Then**, inside the same locked transaction — the request is rejected, but the state transition and alert **still happen** as a side effect (this is the specified terminal-state transition, not a silently-ignored no-op):
1. `UPDATE rotation_checklist_items SET status = 'max_retries_exceeded', last_acted_by = $userId, last_acted_at = NOW() WHERE id = $itemId AND rotation_id = $rotationId AND status = 'failed' RETURNING *` (note: `retry_count` is **not** incremented on this transition — it stays at its already-at-the-cap value, since no actual retry occurred).
2. CAS-increment `rotations.version`.
3. Write `rotation.checklist_item_max_retries_exceeded` audit row.
4. Queue a `rotation.max_retries_exceeded` alert (severity `critical` — this is an escalation, unlike the `warning`-severity per-failure alert in AC-4).
5. Commit. Post-commit, best-effort dispatch.
6. Return:
```http
HTTP 422
{ "code": "max_retries_exceeded", "message": "Maximum retry attempts (3) reached for this item. Escalate or confirm manually.", "retryCount": 3, "maxRetries": 3 }
```

**And** a subsequent `retry` call on the now-`max_retries_exceeded` item (status no longer `failed`) hits the ordinary AC-5-style invalid-state guard:
```http
HTTP 409
{ "code": "invalid_item_status", "message": "Cannot retry an item with status 'max_retries_exceeded'.", "currentStatus": "max_retries_exceeded", "lastActedBy": "11111111-1111-4111-8111-111111111111", "lastActedAt": "2026-07-01T14:50:00.000Z" }
```
No further alert fires on this second call — the escalation already happened exactly once, at the transition. This `409` includes `lastActedBy`/`lastActedAt` for the same idempotent-retry reasoning documented in AC-5: a client that lost the response to the retry call that caused this escalation can compare `lastActedBy` against its own `userId` to tell "my own retry call caused this" apart from "someone else's retry call raced mine."

**And** the only way out of `max_retries_exceeded` is `confirm` (AC-2 explicitly allows confirming from this status) — there is no "reset retry count" or "un-escalate" endpoint in this story. This is intentional: once escalated, resolution requires either a human directly confirming after manual intervention, or the rotation being abandoned/recovered by Story 5.3's stale-rotation machinery (out of scope here — see AC-25).

**And** `ROTATION_MAX_RETRIES` is read fresh on every `retry` call (not cached per-rotation or per-item) — if an operator lowers the env var after some items already have a high `retryCount`, the next `retry` call on those items immediately evaluates against the new, lower cap. This is a deliberate simplification (no per-rotation config snapshot) consistent with every other env-var-configured threshold in this codebase (e.g., `FAILED_AUTH_THRESHOLD_COUNT`).

---

### AC-8: Concurrency — Non-Blocking Advisory Lock + Optimistic-Lock CAS (RS-E5a)

**Given** RS-E5a requires "all rotation state transitions... performed as DB-level transactions with optimistic locking on the rotation record... concurrent transition attempts on the same rotation must return 409 Conflict — not silently overwrite each other,"
**When** any of the four mutation endpoints (`confirm`, `fail`, `retry`, `complete`) is called,
**Then** the handler, immediately after opening `ctx.tx`:
1. Acquires `pg_try_advisory_xact_lock(hashtextextended('rotation:' || orgId || ':' || rotationId, 0))` — **the same single-key, domain-prefixed, transaction-scoped pattern 5.1's ADR-5.1-01 established for initiation**, keyed by `rotationId` this time (not `credentialId` — a genuinely different resource, so no keyspace collision concern with 5.1's own lock despite sharing the `'rotation:'` prefix; the full hashed string differs). If the lock is already held (another concurrent mutation on the *same rotation*, touching any item), return immediately:
```http
HTTP 409
{ "code": "concurrent_modification", "message": "Another update to this rotation is in progress. Retry.", "currentVersion": 4 }
```
(`currentVersion` looked up via a fresh `SELECT version FROM rotations WHERE id = $1` — the lock failure alone doesn't tell you the current value.)
2. If the lock is acquired: `SELECT status, version FROM rotations WHERE id = $rotationId` (no explicit row lock needed — the advisory lock already serializes all mutation attempts on this rotation).
3. Performs the item-level state-machine UPDATE (AC-2/4/6/7's `WHERE status = '<expected>'` clause).
4. `UPDATE rotations SET version = version + 1, updated_at = NOW() WHERE id = $rotationId AND version = $observedVersion RETURNING version` — the CAS. Under normal operation this always succeeds (the advisory lock already prevents a second concurrent writer from having observed the same version), so this is the **backstop**, not the primary mechanism — exactly mirroring 5.1's own ADR-5.1-01 relationship between its advisory lock and its partial unique index. If it returns zero rows (lock bypassed by a hypothetical future direct-DB caller), return the same `409 concurrent_modification` shape as step 1.

**Critical scope note — the lock is per-*rotation*, not per-item.** Two admins concurrently confirming **two different items of the same rotation** race on the same advisory lock: one succeeds, the other's lock-acquisition attempt fails immediately and receives `409`. This is the literal reading of RS-E5a ("optimistic locking on the rotation record" — singular, rotation-scoped, not item-scoped) and is **not a bug** — a `409`'d client is expected to re-fetch the rotation (`GET .../rotations/:rotationId`, which will show the other admin's just-committed change) and retry its own action. Document this in the client-facing error message and cover it with an explicit test (AC-19): two `Promise.all`-raced `confirm` calls on two *different* items of the same rotation → exactly one `200`, one `409`.

**And** the savepoint concern from 5.1's AC-5 does **not** apply here — this story never performs a follow-up `SELECT` on `ctx.tx` after catching a unique-violation error (there is no unique constraint being raced; the CAS `UPDATE ... WHERE version = $x` simply returns zero rows on a lost race, which is a normal, non-erroring outcome that doesn't abort the transaction). No nested `ctx.tx.transaction()` savepoint wrapper is needed for this story's concurrency handling.

---

### AC-9: `POST .../rotations/:rotationId/complete` — Happy Path (FR21, FR22)

**Given** a rotation is `in_progress` and every one of its checklist items has status `confirmed` (or it has zero items and the caller acknowledges — AC-11),
**When** a user with `admin`/`owner` org role calls this endpoint with `{ acknowledgedNoDependencies? }`,
**Then**, inside the same locked-transaction pattern as AC-8:
1. Acquire the rotation-scoped advisory lock; check `rotation.status === 'in_progress'` (else `422 rotation_not_active`).
2. `SELECT id, status FROM rotation_checklist_items WHERE rotation_id = $rotationId` — if any row's `status !== 'confirmed'`, reject (AC-10). If zero rows, require the acknowledgement flag (AC-11).
3. `UPDATE rotations SET status = 'completed', completed_at = NOW(), version = version + 1 WHERE id = $rotationId AND version = $observedVersion RETURNING *` (same CAS as AC-8).
4. `UPDATE credential_versions SET rotation_locked_at = NULL WHERE id = $rotation.previousVersionId` — the retirement (see ADR-5.2-02 below for why this is "clear the lock," not "set a `status` column").
5. Write `rotation.completed` audit row: `payload: { credentialId, projectId, checklistItemCount, confirmedCount }`.
6. Commit. Return `200` with the full rotation detail (same shape as 5.1's `GET .../rotations/:rotationId`), `status: "completed"`.

**Response `200`:**
```json
{
  "data": {
    "id": "b2a1c3d4-0000-4000-8000-000000000099",
    "status": "completed",
    "version": 6,
    "completedAt": "2026-07-01T15:02:00.000Z",
    "checklistItems": [ { "id": "...", "status": "confirmed", "...": "..." } ]
  }
}
```

**And** `GET .../credentials/:credentialId/value` behavior is **unchanged** by completion — per 5.1's ADR-5.1-04, the new version has been "current" (highest version, served by reveal) since *initiation*, not completion. Completion only affects the *old* version's retention-purge eligibility.

---

### AC-10: `POST .../complete` — Checklist Incomplete (422)

**Given** a rotation has at least one checklist item with status other than `confirmed` (`unconfirmed`, `failed`, or `max_retries_exceeded`),
**When** `complete` is called,
**Then** the response is:
```http
HTTP 422
{
  "code": "checklist_incomplete",
  "message": "3 of 5 checklist items are not yet confirmed.",
  "pendingItems": [
    { "id": "c1c1c1c1-...-0003", "systemName": "payment-webhook-relay", "status": "unconfirmed" },
    { "id": "c1c1c1c1-...-0004", "systemName": "GitHub Actions CI", "status": "failed" },
    { "id": "c1c1c1c1-...-0005", "systemName": "legacy-cron-box", "status": "max_retries_exceeded" }
  ]
}
```
No writes occur — the rotation remains `in_progress`, no advisory lock is even needed to be *held* past the read (though it's still acquired first per AC-8's uniform entry sequence, then released on rollback/no-op commit).

---

### AC-11: `POST .../complete` — Zero-Dependency Acknowledgement Gate (AC-E5a)

**Given** a rotation was initiated for a credential with zero non-archived dependencies (5.1 AC-6 — the rotation has `checklistItems: []`),
**When** `complete` is called **without** `{ acknowledgedNoDependencies: true }` in the body,
**Then** the response is:
```http
HTTP 422
{ "code": "acknowledgement_required", "message": "This credential has no recorded dependent systems. Confirm you have manually verified the credential is updated everywhere it is used before completing.", "checklistItemCount": 0 }
```

**And** calling `complete` with `{ acknowledgedNoDependencies: true }` on a zero-item rotation succeeds exactly like AC-9 (steps 3-6 unchanged; step 2's "any row not confirmed" check is vacuously satisfied by an empty result set, but the acknowledgement flag is the actual gate per AC-E5a — "an empty checklist that auto-completes is not acceptable").

**And** `acknowledgedNoDependencies: true` sent on a rotation that **does** have checklist items is accepted but **ignored** — it is not a bypass for AC-10's incomplete-checklist check. (Rationale: the flag's entire semantic meaning is "I have no systems to check, so I'm vouching for this manually" — it says nothing about a *populated* checklist with pending items, which must still be resolved through the normal confirm/fail/retry flow.) A test must assert this: zero-dep flag `true` + 2 pending items → still `422 checklist_incomplete`, not `200`.

---

### AC-12: `POST .../complete` — Atomicity & Retirement Semantics (NFR-REL3/4, ADR-5.2-02)

**Given** NFR-REL3 requires rotation completion's writes (status transition + version retirement) to be atomic, and NFR-REL4 requires the write to be synchronously durable,
**When** completion succeeds,
**Then** the `rotations` UPDATE (step 3) and the `credential_versions` UPDATE (step 4) happen in the **same transaction** as the audit write (step 5) — if any step fails (including the audit write, fail-closed per `writeHumanAuditEntryOrFailClosed`), the entire transaction rolls back: the rotation stays `in_progress`, the old version stays locked, nothing changes.

**Architecture/Epic Conflict Resolution — "the old credential version's `status` is set to `retired`":** epics.md's literal AC text (line 1613) says this, but **`credential_versions` has no `status` column** (confirmed against the actual Story 2.2 schema — only `encryptedValue`, `keyVersion`, `versionNumber`, `rotationLockedAt`, `purgedAt`, `createdBy`, `createdAt`). This is PRD-level shorthand for a behavior, not a literal schema instruction — same category of conflict 5.1's own "Architecture Conflict Resolution" table resolved for its own AC text. **Canonical implementation: "retiring" a version means clearing `rotation_locked_at`** (`UPDATE credential_versions SET rotation_locked_at = NULL WHERE id = $previousVersionId`), returning it to the Story 2.2 retention job's normal purge-eligibility rules (subject to `retentionCount`, no longer permanently exempt). This is *exactly* the seam 5.1's AC-13 built and explicitly deferred clearing to this story ("Clearing `rotation_locked_at` once a rotation completes... Story 5.2/5.3's job"). Do **not** add a new `status` enum column to `credential_versions` to literally satisfy the epic wording — that would duplicate the exact information `rotation_locked_at IS NULL` already encodes (a version with no active/former rotation lock and past its `retentionCount` window is exactly what "retired and purge-eligible" means).

**And** "retired" does **not** mean immediately deleted/purged — clearing the lock only makes the version *eligible* for the next scheduled run of `prune-credential-versions.ts` (an existing worker, unmodified by this story), which still respects `retentionCount` (default 3, minimum 1). A credential with `retentionCount: 5` and only 2 versions total will not purge anything even after "retirement" — the old version simply becomes an ordinary, unprotected version again.

**Test:** create a credential with `retentionCount: 1`, initiate + complete a rotation (2 versions total after initiation), assert `rotation_locked_at IS NULL` on the previous version immediately after completion, then run the retention job's purge-candidate query directly and assert the now-unlocked, now-superseded version **is** a purge candidate (inverse of 5.1's AC-13 test, which asserted it was *excluded* while locked).

---

### AC-13: Live Rotation Status (FR66) — No New Route, New Test Coverage

**Given** 5.1's `GET /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId` was explicitly built "to already support showing mixed states for forward compatibility" (5.1 AC-11) but could only ever test the all-`unconfirmed` state (no mutation endpoints existed yet),
**When** this story lands,
**Then** no new route is added for FR66 — epics.md's "`GET /api/v1/rotations/:rotationId` returns live rotation status" (a flat path, no project/credential segments) is resolved the same way 5.1 resolved its own path-shape conflicts: **the canonical path is 5.1's existing nested one**, not a new flat duplicate. Introducing a second "get rotation" route with a different path shape and independent auth/error-handling code would fragment the API surface for zero functional gain — RLS-scoped rotation lookup already works identically whether or not `:projectId`/`:credentialId` are present in the URL, since the row itself carries both.

**And** the response schema (`packages/shared/src/schemas/rotations.ts`, `RotationChecklistItemSchema`) is extended with the five new fields from AC-1 (`retryCount`, `retryScheduledAt`, `lastFailureReason`, `lastActedBy`, `lastActedAt`) — additive, non-breaking for any 5.1-era caller.

**Test (new in this story):** initiate a rotation with 3 dependencies; confirm one, fail-then-retry-then-fail-then-max-out a second (exercise the full state machine into `max_retries_exceeded`), leave the third `unconfirmed`; call `GET .../rotations/:rotationId`; assert the response shows all three items in their correct, independent final states with correct `lastActedBy`/`lastActedAt` per item — proving the "live status" claim is actually true, not just structurally possible.

---

### AC-14: `GET /api/v1/projects/:projectId/rotations/upcoming` — Happy Path (FR65)

**Given** credentials in a project may have a `rotationSchedule` cron string (Story 2.4, e.g. `"0 0 1 * *"` — monthly),
**When** a user with `viewer`+ role calls `GET .../rotations/upcoming?horizon=30d` (query: `UpcomingRotationsQuerySchema = z.object({ horizon: z.enum(['7d','30d','90d']).default('30d') }).strict()`),
**Then**, for every credential in the project with a non-null `rotationSchedule` **and no currently-active rotation** (`rotations.status IN ('in_progress','stale_recovery')` for that credential — checked via the existing `idx_rotations_credential_status` index from 5.1):
1. Compute a reference point: fetch the credential's most recent rotation row (`ORDER BY created_at DESC LIMIT 1`), regardless of status. Because credentials with an `in_progress`/`stale_recovery` rotation are already excluded from this endpoint entirely (see the filter above), any row found here is necessarily in a terminal state (`completed`, or a Story-5.3-introduced terminal state such as `abandoned`/`break_glass_complete`). If a row is found, use its `completedAt` when set (the `completed` case); otherwise use its `updatedAt` (covering non-`completed` terminal transitions — `updatedAt` is used rather than a status-specific timestamp column so this story does not need to depend on schema Story 5.3 has not yet defined). If the credential has no rotation row at all, use `credentials.createdAt`. **This matters:** a credential whose only rotation history is a non-`completed` terminal rotation (e.g. abandoned) must not fall all the way back to `credentials.createdAt` — that would produce a badly stale "next due" date for a credential that in fact has real, recent rotation activity.
2. Compute `nextDueAt = CronExpressionParser.parse(rotationSchedule, { currentDate: referencePoint }).next().toDate()` (same `cron-parser` library and API 2.4's `validateRotationCron()` already imports — `packages/shared/src/validation/rotation-cron.ts`).
3. Include the credential if `nextDueAt <= now + horizonDays` (7/30/90 depending on the query param); `status: 'overdue'` if `nextDueAt < now`, else `status: 'pending'`.

**And** the response reuses the **existing** `UpcomingRotationSchema` (`packages/shared/src/schemas/dashboard.ts` — `{ credentialId, credentialName, scheduledAt, status }`) verbatim, mapping `nextDueAt → scheduledAt` — no new response shape is introduced, and no field is added to that schema in this story (it deliberately has no `projectId`, matching its pre-existing, Epic-2-era shape; the endpoint itself is already project-scoped by URL, so it isn't needed here).

**Response `200`:**
```json
{
  "data": {
    "items": [
      { "credentialId": "00000000-...-0020", "credentialName": "Stripe API Key", "scheduledAt": "2026-07-15T00:00:00.000Z", "status": "overdue" },
      { "credentialId": "00000000-...-0021", "credentialName": "Postgres Prod Password", "scheduledAt": "2026-07-25T00:00:00.000Z", "status": "pending" }
    ]
  }
}
```
Sorted `nextDueAt ASC`.

**Edge case — credential with `rotationSchedule: null`:** excluded entirely (nothing to compute — this is not the same as "overdue," it's "no schedule configured," which this endpoint does not surface at all; a separate future "credentials with no rotation schedule" report is out of scope).

**Edge case — credential with an active `in_progress` rotation:** excluded, even if its cron-computed due date would otherwise land inside the horizon. Rationale: the live rotation status view (AC-13) is the correct signal once a rotation has actually started; showing it as also "upcoming/overdue" would be a confusing double-signal for the same underlying event.

**Edge case — credential whose only rotation history is a non-`completed` terminal rotation:** the reference point uses that rotation's `updatedAt`, not `credentials.createdAt` (see step 1 above). **Test:** seed a credential, give it one `abandoned` rotation with a recent `updatedAt` and no `completedAt`, and a `rotationSchedule` that would compute as far-overdue if (incorrectly) anchored to `credentials.createdAt`; assert `GET .../rotations/upcoming` computes `nextDueAt` from the abandoned rotation's `updatedAt`, not from `credentials.createdAt`.

---

### AC-15: Dashboard Placeholder Wiring — Org & Project

**Given** `deferred-work.md` line 51 documents `AC-E2d — projects with overdue rotations` as a hardcoded `{ count: 0, items: [] }` placeholder explicitly deferred to Epic 5, and the project dashboard's `upcomingRotations` field (`apps/api/src/modules/projects/dashboard-stats.ts` line 99) is hardcoded `[]`,
**When** this story ships,
**Then** both are wired to a new shared helper, `computeUpcomingRotations(tx, { projectId?: string, horizonDays: number })` (exported from `apps/api/src/modules/rotation/service.ts`, reusing the exact query logic from AC-14 — no duplicated cron-computation code):

- **Org dashboard** (`getOrgDashboardData`, line 121-165): `projectsWithOverdueRotations` — call `computeUpcomingRotations(tx, { horizonDays: 0 })` (no `projectId` = org-wide, across all projects the RLS context can see), then **explicitly filter the result to `results.filter((r) => r.status === 'overdue')`** before mapping to `{ count: filtered.length, items: filtered.slice(0, 20) }` (same 20-item cap the adjacent `expiringWithin30Days` slice already uses). **Do not rely on `horizonDays: 0`'s inclusion boundary alone to guarantee "overdue-only"** — AC-14's inclusion rule is `nextDueAt <= now + horizonDays` (inclusive), while its `status` label is `'overdue'` only when `nextDueAt < now` (strict). A credential whose `nextDueAt` lands exactly at `now` is included by the `horizonDays: 0` filter but labeled `'pending'` by that same function; without the explicit `status === 'overdue'` filter here, the org dashboard's overdue bucket could silently include that non-overdue boundary item.
- **Project dashboard** (`getProjectDashboardData` → `buildProjectDashboard`): `upcomingRotations` — call `computeUpcomingRotations(tx, { projectId, horizonDays: 30 })` (fixed 30-day default, no query-param horizon on the dashboard endpoint — the dashboard is a fixed summary view, not a filterable list).

**And** `buildProjectDashboard`'s existing `isEmpty`/`suggestedActions` computation (line 91, 106) is **not** changed to factor in `upcomingRotations` — a project with zero credentials/services but one upcoming rotation would be a contradiction (rotations only exist for credentials that exist), so this is a non-issue, not a gap; no test needed for that interaction beyond normal coverage.

**Test:** seed a project with one credential past its cron due date and one not-yet-due; assert `GET /api/v1/dashboard` (org) shows the overdue one in `projectsWithOverdueRotations.items` and NOT the pending one (since `horizonDays: 0` excludes non-overdue); assert `GET .../projects/:projectId` dashboard shows **both** in `upcomingRotations` (30-day default horizon includes pending-within-30-days too). **And** a third credential whose `nextDueAt` lands exactly at `now` (the inclusion/status-label boundary) — assert it does **not** appear in `projectsWithOverdueRotations.items`, proving the explicit `status === 'overdue'` filter (not just the `horizonDays: 0` inclusion boundary) is what gates this list.

---

### AC-16: Role Enforcement (403)

**Given** `confirm`/`fail`/`retry` are incremental, reversible bookkeeping actions typically performed by whoever actually updated the target system (often a `member`, not necessarily an `admin`/`owner`) — matching the general credential-mutation minimum role this codebase already uses for e.g. `POST .../credentials/:credentialId/versions` (`minimumRole: 'member'`) — while `complete` is the irreversible action that retires the old credential version, matching **initiation's** `admin`/`owner` threshold (5.1 AC-7),
**When** role checks are enforced,
**Then**:

| Endpoint | `minimumRole` |
|---|---|
| `POST .../checklist/:itemId/confirm` | `member` |
| `POST .../checklist/:itemId/fail` | `member` |
| `POST .../checklist/:itemId/retry` | `member` |
| `POST .../rotations/:rotationId/complete` | `admin` |
| `GET .../rotations/upcoming` | `viewer` |

**And** a `viewer` calling any of the four mutation endpoints receives:
```http
HTTP 403
{ "code": "insufficient_role", "message": "Insufficient permissions" }
```

**And** a `member` calling `complete` receives the same `403` shape — `complete` is the one endpoint in this story where `member` is insufficient.

**And**, mirroring 5.1's AC-7, a test verifies MFA enforcement actually applies to `complete` specifically (the highest-risk endpoint in this story) using the same test-fixture pattern as 5.1's own MFA test — do not take the "handled globally by auth middleware" claim on faith for a route this security-sensitive.

---

### AC-17: Cross-Tenant / Not-Found Isolation (404, No Enumeration)

**Given** every one of this story's five endpoints resolves a `rotationId` (and `confirm`/`fail`/`retry` additionally resolve an `itemId`) scoped by RLS to `app.current_org_id`,
**When** any of the following occurs:
- `:projectId`/`:credentialId`/`:rotationId` combination is valid but belongs to a different org (RLS-unreachable; app-layer backstop check, same as 5.1 AC-8),
- `:rotationId` exists but doesn't belong to the `:credentialId` in the path,
- `:itemId` exists but belongs to a **different** `:rotationId** than the one in the path (cross-rotation item ID — a distinct case from cross-org, still must not leak which rotation actually owns the item),
- any ID is a syntactically valid UUID that simply doesn't exist,

**Then** every case returns the identical `404`:
```http
HTTP 404
{ "code": "rotation_not_found", "message": "Rotation not found" }
```
for the four rotation-scoped endpoints, or:
```http
HTTP 404
{ "code": "checklist_item_not_found", "message": "Checklist item not found" }
```
specifically when the rotation itself resolves fine but the `itemId` doesn't belong to it (distinct `code` so clients can tell which resource was missing, mirroring 5.1 AC-11's `rotation_not_found` vs. `credential_not_found` distinction) — **never** a `403`, **never** a response revealing which case was true.

**And** malformed (non-UUID) path parameters (`itemId`, `rotationId`, etc.) are a Zod validation failure → `422 { code: "validation_error", ... }`, **never** folded into `404` (same `parseParams` pattern as 5.1 AC-8's edge case).

**And** `GET .../rotations/upcoming` against a cross-org/nonexistent `:projectId` also returns the standard project-not-found `404` (reuses the existing project-resolution check every other project-scoped route already has — no new logic).

**And** an integration test seeds two orgs, creates a rotation + checklist item in org A, and asserts an org-B admin gets `404` (not `403`, not data leakage) on all five endpoints.

---

### AC-18: Sealed Vault (503)

**Given** none of this story's five endpoints read or write credential plaintext (checklist confirmation is pure workflow metadata; completion clears a boolean-ish timestamp column, never touches `encryptedValue`), but `VAULT_GUARD_ALLOWLIST` blocks by default and cannot pattern-match parameterized routes (5.1 AC-9's documented structural limitation, unchanged in this story),
**When** any of the five routes is called while the vault is sealed,
**Then** the response is the standard:
```http
HTTP 503
{ "status": "sealed" }
```

**And** this is the same "consciously accepted trade-off" 5.1 already documented and decided not to special-case — this story does not re-litigate it, just extends the same default behavior to its own new routes. A single smoke test per new route is sufficient (matching 5.1's "read routes... don't need a separate assertion beyond one smoke check" precedent).

---

### AC-19: Concurrent-Mutation Integration Test (RS-E5a Coverage)

**Given** AC-8 specifies rotation-scoped (not item-scoped) locking,
**When** integration tests are written,
**Then** they cover, at minimum:
1. Two `Promise.all`-raced `confirm` calls on the **same item** → exactly one `200`, one `409 concurrent_modification` (the losing request's item-status UPDATE would have found the item already `confirmed` even if it *had* won the lock race — but in practice the lock contention itself produces the `409` before that check ever runs).
2. Two `Promise.all`-raced `confirm` calls on **two different items of the same rotation** → exactly one `200`, one `409` — proving the lock is rotation-scoped, not item-scoped (the surprising case flagged in AC-8).
3. A targeted test that bypasses the advisory lock (holds it open on a separate connection, then calls the service function directly) to prove the CAS `UPDATE ... WHERE version = $x` backstop alone is sufficient — mirrors 5.1 AC-5(b)'s "prove the backstop actually backstops" test.
4. `complete` racing a `confirm` on the last pending item of the same rotation — whichever transaction's advisory-lock acquisition wins determines whether `complete` sees a fully-confirmed checklist or not; the loser gets `409`, not a corrupted partial state.

---

### AC-20: Request Validation (422) — Confirm/Retry/Complete Bodies

**Given** `ConfirmChecklistItemBodySchema = z.object({ notes: z.string().max(1024).trim().nullable().optional().transform((v) => (v ? v : null)) }).strict()` (identical trim/transform idiom to 5.1's `notes` field, fixing the same whitespace-vs-null inconsistency 5.1's own adversarial review flagged and fixed),
`RetryChecklistItemBodySchema = z.object({}).strict()` (an explicit empty object — `{}` is the only valid body; omitting the body entirely is also accepted, per the same Fastify+Zod convention as other bodyless-intent POSTs in this codebase),
`CompleteRotationBodySchema = z.object({ acknowledgedNoDependencies: z.boolean().optional() }).strict()`,

**When** invalid bodies are sent:

| Endpoint | Invalid body | Expected `422` `code` |
|---|---|---|
| confirm | `{ "notes": "x".repeat(1025) }` | `validation_error` |
| confirm | `{ "notes": "ok", "extra": 1 }` | `validation_error` (`.strict()`) |
| retry | `{ "anything": true }` | `validation_error` (`.strict()` rejects any key) |
| complete | `{ "acknowledgedNoDependencies": "yes" }` (wrong type — string not boolean) | `validation_error` |
| complete | `{ "acknowledgedNoDependencies": true, "extra": 1 }` | `validation_error` |

(`fail`'s validation table is AC-5 above.)

**Then** every case is `422` via the existing `validationError()` helper, no DB write, no advisory lock acquired.

---

### AC-21: Audit Logging — 5 New Events, Fail-Closed

**Given** every mutation in this story writes an audit row in the same transaction as its state change, fail-closed via `writeHumanAuditEntryOrFailClosed` (identical pattern to 5.1 AC-14),
**When** each mutation succeeds,
**Then** the following `AuditEvent` constants are added to `packages/shared/src/constants/audit-events.ts` (both the const object and the type union, following the exact `CREDENTIAL_*`/`ROTATION_INITIATED` pattern):

| Constant | String value | Written by |
|---|---|---|
| `ROTATION_CHECKLIST_ITEM_CONFIRMED` | `rotation.checklist_item_confirmed` | AC-2 |
| `ROTATION_CHECKLIST_ITEM_FAILED` | `rotation.checklist_item_failed` | AC-4 |
| `ROTATION_CHECKLIST_ITEM_RETRIED` | `rotation.checklist_item_retried` | AC-6 |
| `ROTATION_CHECKLIST_ITEM_MAX_RETRIES_EXCEEDED` | `rotation.checklist_item_max_retries_exceeded` | AC-7 |
| `ROTATION_COMPLETED` | `rotation.completed` | AC-9 |

**And** every payload contains only IDs, system names, counts, and free-text `reason`/`notes` fields (never a credential value — none of these endpoints ever touch one, so there's no redaction risk analogous to 5.1's `newValue` concern, but payloads are still reviewed against `FORBIDDEN_AUDIT_KEYS` as a matter of course).

**And** an audit-write-failure test (reusing 5.1's `FORCED_AUDIT_FAILURE` harness pattern) is required for **at least** `confirm` and `complete` (the two most consequential endpoints) — asserts the entire transaction rolls back: item status unchanged, rotation `version` unchanged (for `confirm`), rotation still `in_progress` and old version still locked (for `complete`).

---

### AC-22: Route Registration & Audit Classification

**Given** `route-audit.test.ts` requires every route classified in `ROUTE_ACTION_CLASSIFICATIONS`,
**When** the five new routes are added to the **existing** `apps/api/src/modules/rotation/routes.ts` (5.1's file — same `rotationRoutes(fastify)` export, already registered in `app.ts`, no new registration call needed),
**Then** five entries are added to `ROUTE_ACTION_CLASSIFICATIONS` (`apps/api/src/lib/route-exemptions.ts`):

```typescript
'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/confirm': {
  action: 'mutation', auditEvent: 'rotation.checklist_item_confirmed', sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/fail': {
  action: 'mutation', auditEvent: 'rotation.checklist_item_failed', sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/checklist/:itemId/retry': {
  action: 'mutation', auditEvent: 'rotation.checklist_item_retried', sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'POST /api/v1/projects/:projectId/credentials/:credentialId/rotations/:rotationId/complete': {
  action: 'mutation', auditEvent: 'rotation.completed', sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed',
},
'GET /api/v1/projects/:projectId/rotations/upcoming': {
  action: 'read', auditOmissionReason: 'Upcoming-rotation schedule read is metadata-only; never exposes a credential value.',
},
```

**And** `pnpm --filter @project-vault/api test route-audit.test.ts` passes with zero unclassified routes.

---

### AC-23: Rate Limiting

**Given** the repo-wide `120 req/min` default applies unless overridden,
**When** the five routes are registered,
**Then**: the four mutation endpoints use `{ max: 60, timeWindowMs: 60_000, key: '<METHOD PATH>' }` — more generous than 5.1's `30/min` initiation limit (checklist confirmation is a routine, frequent action during an active rotation with many dependent systems, unlike the deliberately-infrequent initiation), but still tighter than the `120/min` default. `GET .../rotations/upcoming` uses the standard `120/min` default (no override).

**And** the bucket this `key` selects is never global or org-wide, despite the literal string containing only method+path: `enforceRouteRateLimit`/`enforceUserRateLimit` (`apps/api/src/lib/secure-route.ts`, `apps/api/src/lib/route-helpers.ts`) always prefix the bucket with the caller's `auth.userId` (`` `${userId}:${key}` ``) before applying `max`/`timeWindowMs` — confirmed against the actual implementation, not assumed. The `key` here only distinguishes *which endpoint's* budget a given authenticated user is spending; it does not pool requests across different users or orgs. One noisy or malicious user can only ever exhaust their own 60/min budget for these routes, never another user's or another org's. (5.1's `POST .../rotations` rate limit uses this identical `key` shape for the same reason — this is an established, verified codebase convention, not a new gap introduced by this story.)

---

### AC-24: Operational Metrics & Logging

**Given** the Maintainability NFR requires structured logging and Prometheus metrics for every rotation outcome,
**When** each mutation succeeds, hits a state-machine conflict, hits the concurrency lock, fails validation, fails audit, or exceeds max retries,
**Then** emit structured pino log lines per outcome (e.g. `{ event: 'rotation.checklist.confirm.success', rotationId, itemId }`, `{ event: 'rotation.checklist.retry.max_exceeded', rotationId, itemId, retryCount }`, `{ event: 'rotation.complete.success', rotationId, credentialId }`, `{ event: 'rotation.complete.checklist_incomplete', rotationId, pendingCount }`) and increment `prom-client` counters:
- `rotation_checklist_confirmations_total{outcome="success"|"already_confirmed"|"invalid_state"|"concurrent_modification"}`
- `rotation_checklist_failures_total` (every `fail` call — this **is** the operational signal for "how often do rotations hit friction," not an error metric about the endpoint itself)
- `rotation_checklist_retries_total{outcome="success"|"max_exceeded"}`
- `rotation_completions_total{outcome="success"|"checklist_incomplete"|"acknowledgement_required"}`

**And** a gauge, `rotation_checklist_items_pending_total`, reporting the current count of `rotation_checklist_items` rows with `status IN ('unconfirmed','failed','max_retries_exceeded')` across all `in_progress` rotations — periodic-query-backed, same `prom-client` `Gauge` + `collect()` pattern as 5.1 AC-18's `credential_versions_locked_by_rotation_total`. This is the operational visibility for "how much unconfirmed rotation work is currently outstanding org-wide."

---

### AC-25: Explicit Out of Scope

The following are **intentionally not implemented** in this story:

- **Stale-rotation recovery, break-glass emergency rotation, dependency archival** — Story 5.3 (FR108, FR104).
- **A scheduler/reminder job acting on `retryScheduledAt`** — see AC-4. The field is stored for visibility only.
- **Dedicated email/Slack templates** for the two new alert types — the generic fallback renderer covers them; see "Notification Integration Pattern."
- **An "un-escalate" or "reset retry count" endpoint** for `max_retries_exceeded` items — resolution is `confirm` (manual) or Story 5.3's recovery machinery.
- **Per-org (DB-configurable) `ROTATION_MAX_RETRIES`** — this story uses a single env-var-configured value for the whole instance, matching every other "admin-configurable" threshold in this codebase (`FAILED_AUTH_THRESHOLD_COUNT`, `MFA_LOGIN_MAX_ATTEMPTS`, etc. — all env vars, not per-org DB rows). AC-E5b's "admin-configurable" language means "the self-hosting operator can configure it," not "each org can set its own value at runtime."
- **Web/UI rotation checklist screens** — see Product Surface Contract above.
- **Changing `credential_versions` schema** (e.g., adding a `status` column) to literally match epics.md's "retired" wording — see ADR-5.2-02.
- **A rotation-level "last acted" column** — derivable via a query over `rotation_checklist_items.last_acted_at`; see AC-1.
- **Filtering `GET .../rotations/upcoming` by anything other than `horizon`** (e.g., by tag, by owner) — not requested by FR65 or any epic AC.

---

## Tasks / Subtasks

- [ ] **Task 1: Schema migration** (AC-1)
  - [ ] Add 5 columns to `packages/db/src/schema/rotation-checklist-items.ts`
  - [ ] Generate/author migration (verify next-free number against `meta/_journal.json` — R1)
  - [ ] `pnpm --filter @project-vault/db check-rls` clean (no new tables, should be a no-op pass); `pnpm --filter @project-vault/db migrate` succeeds locally
- [ ] **Task 2: Shared Zod schemas** (extends `packages/shared/src/schemas/rotations.ts` from 5.1)
  - [ ] `ConfirmChecklistItemBodySchema`, `FailChecklistItemBodySchema`, `RetryChecklistItemBodySchema`, `CompleteRotationBodySchema`, `UpcomingRotationsQuerySchema`
  - [ ] Extend `RotationChecklistItemSchema` with `retryCount`, `retryScheduledAt`, `lastFailureReason`, `lastActedBy`, `lastActedAt`
  - [ ] Add 5 new `AuditEvent.*` constants to `packages/shared/src/constants/audit-events.ts`
  - [ ] Add `'rotation.confirmation_failed'`, `'rotation.max_retries_exceeded'` to `NOTIFICATION_ALERT_TYPES`
- [ ] **Task 3: Config** — add `ROTATION_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3)` to `apps/api/src/config/env.ts`
- [ ] **Task 4: Extend `apps/api/src/modules/rotation/` module** (5.1's files, not a new module)
  - [ ] `service.ts`: `confirmChecklistItem`, `failChecklistItem`, `retryChecklistItem`, `completeRotation`, `getUpcomingRotations`, `computeUpcomingRotations` (shared helper), the rotation-scoped advisory-lock + CAS helper (AC-8)
  - [ ] `routes.ts`: register the 5 new endpoints via `secureRoute()`
  - [ ] `schema.ts`: `RotationChecklistItemParamsSchema` (`{ projectId, credentialId, rotationId, itemId }`)
- [ ] **Task 5: Notification integration** (AC-4, AC-7) — wire `enqueueSecurityAlertNotification` + post-commit `sendNotificationJobs` per the pattern above
- [ ] **Task 6: Dashboard wiring** (AC-15) — update `apps/api/src/modules/projects/dashboard-stats.ts`'s `getOrgDashboardData`/`buildProjectDashboard` to call `computeUpcomingRotations`
- [ ] **Task 7: Route audit + classification** (AC-22)
- [ ] **Task 8: Metrics/logging** (AC-24)
- [ ] **Task 9: Integration & unit tests** (AC-2 through AC-21, AC-23, AC-Quick-Reference "Tests" row)

---

## Dev Notes

### Project Structure Notes

- **No new module** — all changes land in 5.1's existing `apps/api/src/modules/rotation/{schema,service,routes}.ts` files, `packages/db/src/schema/rotation-checklist-items.ts` (extended, not replaced), and `packages/shared/src/schemas/rotations.ts` (extended).
- New file: `packages/db/src/migrations/00NN_rotation_checklist_state.sql` (R1 — verify number).
- No new worker/job file (5.3 adds `workers/rotation-recover.ts`; this story's endpoints are all synchronous routes, same as 5.1).
- `computeUpcomingRotations` lives in `apps/api/src/modules/rotation/service.ts` and is imported by `apps/api/src/modules/projects/dashboard-stats.ts` (a cross-module import — acceptable, `dashboard-stats.ts` already imports from `credentials`/`security-alerts` modules for its other slices).

### Key Code Patterns to Follow

- **Advisory lock + CAS:** copy 5.1's `pg_try_advisory_xact_lock(hashtextextended(...))` pattern verbatim, substituting `rotationId` for `credentialId` in the hashed string. The CAS (`UPDATE ... WHERE version = $x`) is new to this story — no existing precedent in the codebase; document inline why it's needed (backstop, not primary mechanism) so a future reader doesn't mistake it for redundant.
- **Notification enqueue + post-commit dispatch:** copy `apps/api/src/modules/auth/routes.ts`'s `sendPendingMfaNotifications` pattern (lines 74-91) verbatim — same `BossFastify` type cast, same try/catch-and-log-don't-throw semantics.
- **Fail-closed audit:** identical to 5.1 — `writeHumanAuditEntryOrFailClosed(tx, { orgId, actorUserId, eventType, resourceId, resourceType: 'rotation', payload, request })`.
- **Cron next-due computation:** `CronExpressionParser.parse(expr, { currentDate: referenceDate }).next().toDate()` — same import (`cron-parser`) and API 2.4's `validateRotationCron()` already uses (`packages/shared/src/validation/rotation-cron.ts`), just called for a single "next occurrence" instead of a multi-sample validation loop.
- **Params/response parsing, pagination:** identical helpers to 5.1 (`parseParams`, `parseBody`, `validationError`, `apps/api/src/lib/route-helpers.js`).

### Tech Stack (Repo Pinned — unchanged from 5.1)

- Drizzle ORM 0.45.x, Zod v4 (`zod/v4`), Fastify v5, `cron-parser` (already a dependency via `packages/shared`), pg-boss (`notification:deliver`, `notification:slack`, existing catchup crons — no new job types).

### Architecture Compliance

- MFA enforcement: global middleware, no route-level opt-in — but see AC-16's explicit test requirement for `complete`.
- RLS: no new tables in this story; both mutated tables (`rotations`, `rotation_checklist_items`) already have RLS from 5.1's migration.
- `NFR-REL3`/`NFR-REL4`: completion's rotation-status + version-retirement + audit writes are the "compound transaction, all committed or none" this NFR describes for the *completion* half of the rotation lifecycle (5.1's own Dev Notes already covered the *initiation* half).

### Anti-Patterns (Do Not)

- Do NOT add a `status` column to `credential_versions` — retirement is `rotation_locked_at = NULL` (ADR-5.2-02).
- Do NOT make the advisory lock item-scoped — it's rotation-scoped per RS-E5a's literal wording (AC-8).
- Do NOT build a scheduler for `retryScheduledAt` — visibility only (AC-4, AC-25).
- Do NOT add a new flat `GET /api/v1/rotations/:rotationId` route — 5.1's nested one already serves FR66 (AC-13).
- Do NOT let `acknowledgedNoDependencies: true` bypass AC-10's incomplete-checklist check on a populated checklist (AC-11).
- Do NOT cache/snapshot `ROTATION_MAX_RETRIES` per rotation — read fresh on every `retry` call (AC-7).
- Do NOT touch Story 5.3's scope (break-glass, stale recovery, dependency archival) — flag, don't build (AC-25).

---

## Previous Story Intelligence

### Story 5.1 (`rotations` + `rotation_checklist_items`, ready-for-dev, not yet implemented in this branch)
- Established the advisory-lock-plus-backstop pattern (ADR-5.1-01) this story's AC-8 directly extends with a new key domain.
- Its own adversarial review (10 findings addressed in a follow-up commit) already fixed several issues this story would otherwise have inherited: added `newVersionId`/`previousVersionId` FKs (this story's AC-12 completion logic depends on `previousVersionId` existing), fixed the "immutable" vs. "permanently retained" terminology confusion (this story's own migration comments should say "permanently retained," never "immutable," for the same reason), added an `ORDER BY created_at` requirement for checklist item arrays (already satisfied — this story doesn't reorder anything), added the `.trim()`+`.transform()` idiom for optional text fields (reused verbatim in this story's `notes`/`reason` fields).
- Confirmed via `git log`/`find` that **no code from 5.1 exists in this branch yet** — `apps/api/src/modules/rotation/`, `packages/db/src/schema/rotations.ts`, and the `0026_*` migration are all absent as of this story's creation. Whoever implements 5.2 must implement (or verify the prior implementation of) 5.1 first — this story's tasks are written assuming 5.1's exact final schema/route shape as specified in its own story file, not as currently-existing code.

### Story 2.4 (`credential_dependencies`, `rotationSchedule` cron column, done)
- `validateRotationCron()` (`packages/shared/src/validation/rotation-cron.ts`) confirms `cron-parser`'s `CronExpressionParser.parse(expr).next().toDate()` API — this story's FR65 computation reuses this exact call shape with a `currentDate` option instead of iterating multiple samples.
- 2.4's own cross-story table (line 43) already named this story ("5.2") as the consumer of `rotation_schedule` for the upcoming-rotations endpoint — confirming this design was anticipated, not improvised.

### Epic 3 (notification infrastructure, done)
- `apps/api/src/notifications/dispatcher.ts`'s `enqueueSecurityAlertNotification`/`createOrgAdminNotificationEntries`/`sendNotificationJobs` and `apps/api/src/modules/auth/routes.ts`'s post-commit dispatch pattern are reused verbatim — no new notification code paths invented.

---

## Git Intelligence Summary

At story-creation time, the most recent commits (`git log --oneline -5`) are `dd4eb42 docs(story): address adversarial-review findings in 5-1-...` and `86ce3a4 docs(story): create and adversarially review 5-1` — confirming 5.1 has been through its own create → adversarial-review → fix cycle but has **no implementation commits yet**. The established pattern for landing a story once implementation starts (visible in every prior epic): schema + migration first, then module extension, then route-audit classification, then tests — follow the same ordering for this story's Task list.

---

## Pre-mortem Failure Modes

1. **Making the advisory lock item-scoped instead of rotation-scoped.** This would make AC-19's "two different items, same rotation" test pass differently than specified (both would succeed, no `409`) — silently violating RS-E5a's literal "optimistic locking on the rotation record" wording. Re-read AC-8's "Critical scope note" before implementing.
2. **Forgetting that `retry`'s over-limit case is a state transition with side effects, not a plain rejection.** A naive implementation might just return `422` without also flipping the item to `max_retries_exceeded` and firing the alert — silently dropping AC-E5b's "the item transitions... and an alert fires" requirement. The `UPDATE` and the `422` response are not mutually exclusive; both happen in the same call (AC-7).
3. **Trying to add a `status` column to `credential_versions` because the epic text says "status is set to retired."** This contradicts 5.1's own retention-seam design and would require reconciling two different "is this version still needed" signals (`rotation_locked_at` vs. a new `status`). Read ADR-5.2-02 before touching `credential_versions`.
4. **Allowing `acknowledgedNoDependencies: true` to silently bypass a populated, incomplete checklist.** The flag's name is specific to the zero-item case; a bug here would let a rotation complete with unconfirmed systems, defeating FR21 entirely. AC-11's explicit test (flag `true` + pending items → still `422`) is what catches this.
5. **Building a `retryScheduledAt`-driven background job because it "seems obviously needed."** No epic AC requests one; inventing it is exactly the kind of scope creep 5.1's own Dev Notes warned against for the analogous "notification-queue entry" question. Store and display only (AC-4, AC-25).
6. **Re-adding a flat `GET /api/v1/rotations/:rotationId` route because epics.md literally shows that path for FR66.** This duplicates 5.1's existing nested endpoint with different auth/error-handling code paths to maintain in parallel. Read AC-13 before adding any new GET route.
7. **Confusing `retryCount` semantics between "count of `retry` calls" and "count of `fail` calls."** Per AC-6/AC-7, `retryCount` only increments on a *successful* `retry` call (or is compared-but-not-incremented on the terminal over-limit call) — it does not increment on `fail`. Mixing these up would make the "default 3, max 10" cap (AC-E5b) count the wrong thing.

---

## ADRs

### ADR-5.2-01: The optimistic lock (RS-E5a) is scoped to the *rotation*, not the checklist item — reusing 5.1's advisory-lock-plus-CAS pattern with a `rotationId`-keyed domain

Epics.md's RS-E5a says "optimistic locking on the rotation record" (singular). This story implements that literally: `pg_try_advisory_xact_lock(hashtextextended('rotation:' || orgId || ':' || rotationId, 0))` serializes **all** mutations touching any item of a given rotation, followed by a `rotations.version` CAS backstop — the same two-layer pattern (fail-fast lock + durable backstop) 5.1's ADR-5.1-01 established for initiation, applied to a different resource identifier (`rotationId` instead of `credentialId`). The practical consequence — two admins concurrently confirming two *different* items of the same rotation will have one lose with `409` — is a deliberate, tested (AC-19) trade-off favoring a single simple, epic-literal locking rule over a more granular per-item scheme the epic never asked for and that would complicate the `complete` endpoint's "read the whole checklist consistently" requirement (item-scoped locks would need a second, separate locking discipline for `complete` to safely enumerate all items).

### ADR-5.2-02: "Retiring" the old credential version means clearing `rotation_locked_at`, not setting a `status` column

Epics.md's literal AC-8 text ("the old credential version's `status` is set to `retired`") does not match the actual `credential_versions` schema (Story 2.2, confirmed: no `status` column exists — only `rotationLockedAt`/`purgedAt`). Rather than adding a new column to satisfy the literal wording, this story clears `rotation_locked_at` — exactly the seam 5.1's AC-13 built and explicitly deferred to this story ("Clearing `rotation_locked_at`... Story 5.2/5.3's job"). This keeps "is this version protected from purge" as a single source of truth (`rotation_locked_at IS NOT NULL`) rather than introducing a second, potentially-divergent signal.

### ADR-5.2-03: Confirm/fail/retry require `member`+; complete requires `admin`/`owner` — an intentionally asymmetric role gate

Unlike 5.1's uniform `admin`/`owner` gate on initiation, this story splits roles by risk tier: checklist bookkeeping (confirm/fail/retry) matches the codebase's general credential-mutation minimum (`member`, e.g. `POST .../credentials/:credentialId/versions`), since the person physically updating a dependent system and checking it off is often not an org admin. Completion — which irreversibly retires the old credential version (FR22) — matches initiation's `admin`/`owner` threshold, the same risk tier as starting the rotation in the first place. Epics.md's Story 5.2 AC text specifies no roles at all for any of its four endpoints; this asymmetric design is this story's own resolution of that gap, chosen for consistency with existing codebase role-gating precedent rather than either extreme (uniform `member` for everything, or uniform `admin` for everything).

---

## References

- Epic source: `_bmad-output/planning-artifacts/epics.md` lines 1546-1559 (Epic 5 intro + `AC-E5a`, `AC-E5b`, `RS-E5a`), lines 1591-1621 (Story 5.2).
- PRD: `_bmad-output/planning-artifacts/prd.md` lines 877-887 (FR20-FR22, FR65, FR66, FR75), lines 1036-1043 (Reliability NFRs).
- Predecessor story (schema + patterns this story extends): `_bmad-output/implementation-artifacts/5-1-rotation-initiation-and-checklist-generation.md` (AC-1, AC-2, AC-4, AC-13, ADR-5.1-01, ADR-5.1-02, ADR-5.1-04) and its adversarial review `_bmad-output/implementation-artifacts/5-1-rotation-initiation-and-checklist-generation-adversarial-review.md` (findings 1-2 explain why `newVersionId`/`previousVersionId` and the savepoint pattern exist).
- Rotation-schedule cron source: `_bmad-output/implementation-artifacts/2-4-dependent-system-recording-and-expiry-rotation-schedules.md` line 43 (names this story as FR65's consumer), `packages/shared/src/validation/rotation-cron.ts` (actual `cron-parser` usage).
- Retention seam this story activates the "clear" side of: `_bmad-output/implementation-artifacts/2-2-credential-storage-and-retrieval-with-version-history.md`, `apps/api/src/workers/prune-credential-versions.ts`.
- Notification infrastructure reused verbatim: `apps/api/src/notifications/dispatcher.ts`, `apps/api/src/modules/auth/routes.ts` lines 74-91 (post-commit dispatch pattern), `packages/shared/src/constants/notification-types.ts`, `apps/api/src/notifications/templates/index.ts` (generic fallback renderer).
- Dashboard placeholders wired by this story: `apps/api/src/modules/projects/dashboard-stats.ts` lines 99, 162; `packages/shared/src/schemas/dashboard.ts`, `packages/shared/src/schemas/org-dashboard.ts`; `_bmad-output/implementation-artifacts/deferred-work.md` line 51 (`AC-E2d`).
- Product Surface Contract rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`.
- SecureRoute framework + same-tx fail-closed audit: `apps/api/src/lib/secure-route.ts`, `apps/api/src/lib/audit-or-fail-closed.ts`.
- Route-audit registries: `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/__tests__/route-audit.test.ts`.
- Audit-event constants: `packages/shared/src/constants/audit-events.ts`.
- Config pattern precedent: `apps/api/src/config/env.ts` (`FAILED_AUTH_THRESHOLD_COUNT`, `MFA_LOGIN_MAX_ATTEMPTS` — the env-var-as-admin-configurable-threshold convention `ROTATION_MAX_RETRIES` follows).
- Migration journal (verify R1 before generating): `packages/db/src/migrations/meta/_journal.json`.
- Repo TDD rule: `AGENTS.md`.

---

## Dev Agent Record

### Agent Model Used

_(to be filled by dev agent)_

### Debug Log References

### Completion Notes List

### File List
