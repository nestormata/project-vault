# Story 3.5: Credential Expiry Notification Delivery

Status: ready-for-dev

<!-- Retro-driven backlog addition — no "Story 3.5" stub exists in `_bmad-output/planning-artifacts/
     epics.md` (Epic 3 there only defines 3.1-3.3; 3.4 is retro-driven too). Bundles four
     independently-tracked gaps into one story per `sprint-status.yaml`'s 3-5 entry (2026-07-09
     reconciliation pass): (1) `deferred-work.md`'s E3-2 (FR73 `PENDING_DELIVERY` ->
     `notification_queue` integration test, "Deferred from: Epic 2 closure retrospective"); (2) the
     "Credential expiry notifications" partial-AC row in the same section (columns exist since
     Story 2.2/2.4, no delivery jobs ever wired); (3)-(4) the two remaining "Open (Epic 3 closure,
     Story 3.4 AC-16 — out of scope)" items — `notification_queue` failed-status/DLQ cleanup and
     `dispatcher.ts`'s batch-preference-lookup N+1 `TODO`. All four target the same underlying gap:
     credential-expiry notification delivery was never wired end-to-end despite the backend
     columns/queue infrastructure existing since Epic 2, and Epic 3 has sat `in-progress` since
     2026-06-30 without anyone picking this up. Same hardening/closure-bucket pattern as
     8-5/8-6/8-7/9-6/9-8. This story restates everything needed from the source docs so you do not
     have to open them, but they remain the traceability source. -->

## Story

As an org owner/admin relying on Project Vault to warn me before a secret expires unattended
(FR73's original promise, and the reason `credentials.expiresAt`/`rotationSchedule` exist since
Story 2.2/2.4), I want an expiring credential to actually generate an email/Slack/inbox alert
through the same notification pipeline every other expiry alert (certificate, domain, payment,
machine key) already uses — not a silent database column nobody reads —

and as the operator relying on that notification pipeline's reliability, I want a stuck or
permanently-failing queue entry to eventually stop being retried forever and be visibly reported as
failed, and I want the dispatcher's per-notification recipient-preference lookup to not issue one
database round-trip per recipient as an org's admin/owner count grows,

so that credential expiry is no longer the one monitored-asset type in this codebase with backend
columns and zero delivery, the notification pipeline's own reliability gaps (unbounded retry,
no terminal failure state, N+1 preference lookups) are closed before Epic 3 can honestly close, and
the `PENDING_DELIVERY` -> `notification_queue` -> dispatched chain FR73 promised has an actual
integration test proving it works end-to-end.

*Closes: `deferred-work.md` § "Deferred from: Epic 2 closure retrospective (2026-06-30)" (E3-2, the
"Credential expiry notifications" row) and § "Epic 3 closure (Story 3.4, 2026-06-30)" › "Open (Epic
3 closure, Story 3.4 AC-16 — out of scope)" (all 3 rows).*
[Source: `_bmad-output/implementation-artifacts/deferred-work.md#Deferred-from-Epic-2-closure-retrospective-2026-06-30`,
`#Epic-3-closure-Story-3.4-2026-06-30`]
[Source: `_bmad-output/implementation-artifacts/sprint-status.yaml` — Epic 3 § `3-5-credential-expiry-notification-delivery` entry comment]

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` — every AC below is a scheduled worker, a dispatcher/queue internals fix, or a test. No new route, page, or component. |
| **Evaluator-visible** | Yes, indirectly — an org owner/admin with an expiring credential sees a real email/Slack message and a new row in the `/notifications` inbox (Story 3.3), identical in presentation to today's certificate/domain/payment/machine-key expiry alerts. The DLQ cleanup and N+1 fix are invisible reliability work with no user-facing surface at all. |
| **Linked UI story** (if API-only) | N/A — no new UI surface is introduced. The recipient's only touchpoint is the existing `/notifications` inbox (Story 3.3) and the existing `/settings/notifications` preferences page (Story 3.2), both of which already handle `credential.expiry` generically since it has been a member of `NOTIFICATION_ALERT_TYPES` (`packages/shared/src/constants/notification-types.ts`) since Story 3.2 shipped — this story is the first to actually *populate* that alert type, not the first to *expose* it. |
| **Honest placeholder AC** (if UI deferred) | N/A — nothing is deferred further; this is the delivery-side implementation the placeholder was waiting on. |
| **Persona journey** | See below. |

### Persona journey stub

Epic 2/3 story files in this codebase use generic role language rather than named UX personas for
this journey (`3-1`: "As a vault user"; `3-2`: "As a user and administrator"; `3-4`: "As a vault
evaluator and org administrator" — unlike Epic 9's PJ9/Priya). Following that convention:

**Org owner with an expiring credential:** an org owner has a database credential expiring in 6
days. Today, nothing happens — the `expiresAt` column sits in Postgres, silently correct but never
read by anything. After this story: the daily `credential/expiry-alert` job (running at the same
8am UTC cadence as the sibling certificate/domain/payment/machine-key jobs) finds it crossed the
7-day threshold, queues a `credential.expiry` notification through the exact same
`notification_queue`/dispatcher/preferences path every other alert type uses, and the owner
receives an email (if their preferences have email enabled, the default) and sees it appear in
`/notifications` — with the same visual severity styling and same "Enable in your preferences"
control the certificate-expiry alert they may already be receiving uses. One day later, nothing
re-fires (idempotency) unless the credential later crosses the 1-day threshold too. Separately, an
operator who never notices SMTP is misconfigured sees the entry get stuck in `pending`, resent every
10 minutes forever, indefinitely — until this story's DLQ cleanup marks it `failed` after a bounded
number of attempts and logs a summary the operator can actually find in their logs, instead of an
invisible infinite retry loop.

---

## Background: What Already Exists (Read Before Coding)

This story is almost entirely new backend work plus two internals fixes to already-shipped Epic 3
code. Read this section before touching anything — most of the design decisions below were made by
finding the *exact* existing pattern rather than inventing a new one.

### 1. The expiry-alert shared pattern — the worker's direct blueprint

Four workers (`cert-expiry-alert.ts`, `domain-expiry-alert.ts`, `payment-expiry-alert.ts`,
`machine-key-expiry-alert.ts`, Story 6.1/7.2) already implement "scan rows with a non-null expiry
date, compare to threshold arrays, queue a notification, persist which thresholds already fired" —
all through one shared module:

```73:96:apps/api/src/workers/expiry-alert-shared.ts
export function computeExpiryAlertFirings(params: {
  daysRemaining: number
  alertLeadDays: number[]
  notifiedLeadDays: number[]
}): ExpiryAlertResult {
  const { daysRemaining, alertLeadDays, notifiedLeadDays } = params
  const firings: ExpiryAlertFiring[] = []
  const nextNotifiedLeadDays = [...notifiedLeadDays]

  for (const threshold of alertLeadDays) {
    if (nextNotifiedLeadDays.includes(threshold)) continue
    if (Math.abs(daysRemaining - threshold) > MATCH_TOLERANCE_DAYS) continue
    firings.push({ threshold, severity: severityForDaysRemaining(daysRemaining), overdue: false })
    nextNotifiedLeadDays.push(threshold)
  }

  if (daysRemaining <= 0 && !nextNotifiedLeadDays.includes(0)) {
    firings.push({ threshold: 0, severity: 'critical', overdue: true })
    nextNotifiedLeadDays.push(0)
  }

  return { firings, nextNotifiedLeadDays }
}
```

`runExpiryAlertJob<Row>(boss, logger, config)` (same file) does the org fan-out
(`fetchAllOrgIds`/`runOrgScopedJob`), per-row failure isolation (a single row's error is caught,
logged via `operationalLog(..., OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED, ...)`, and the
loop continues), and the dispatch call (`sendNotificationJobs`) — the config object only needs
`jobName`, `templateId`, `assetType`/`assetLabel`, `fetchRows`, `getExpiryDate`, `buildPayload`, and
`updateNotifiedLeadDays`. `cert-expiry-alert.ts` (47 lines total) is the shortest, cleanest example:

```16:47:apps/api/src/workers/cert-expiry-alert.ts
export async function runCertExpiryAlertJob(
  boss: BossService,
  logger?: WorkerLogger
): Promise<void> {
  await runExpiryAlertJob<CertRecordRow>(boss, logger, {
    jobName: JOB_NAME,
    templateId: 'certificate.expiry',
    assetType: 'certificate',
    assetLabel: 'certificate',
    fetchRows: (orgId) =>
      runOrgScopedJob(orgId, JOB_NAME, ({ tx }) =>
        tx
          .select()
          .from(certRecords)
          .where(and(eq(certRecords.orgId, orgId), isNotNull(certRecords.expiresAt)))
      ),
    getExpiryDate: (row) => row.expiresAt,
    buildPayload: (row, ctx) => ({
      assetId: row.id,
      projectId: row.projectId,
      domain: row.domain,
      expiresAt: formatExpiryDate(row.expiresAt),
      ...baseExpiryPayload(ctx),
    }),
    updateNotifiedLeadDays: async (tx, rowId, nextNotifiedLeadDays) => {
      await tx
        .update(certRecords)
        .set({ notifiedLeadDays: nextNotifiedLeadDays })
        .where(eq(certRecords.id, rowId))
    },
  })
}
```

**`credentials` (`packages/db/src/schema/credentials.ts`) is missing the two columns every sibling
table has** — `alertLeadDays`/`notifiedLeadDays` (jsonb `number[]`). `payment_records` shows the
exact pattern to copy (ADR-6.1-02 — jsonb array, not a single-threshold integer):

```23:33:packages/db/src/schema/payment-records.ts
    // Default [14, 3] per epics.md AC-E6b-adjacent body text for services.
    alertLeadDays: jsonb('alert_lead_days')
      .notNull()
      .default(sql`'[14, 3]'::jsonb`)
      .$type<number[]>(),
    // Thresholds already alerted for the CURRENT renewalDate; reset to [] whenever renewalDate
    // changes (AC 6) so a new expiry cycle can re-fire the same threshold values.
    notifiedLeadDays: jsonb('notified_lead_days')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<number[]>(),
```

`dashboard-stats.ts`'s `EXPIRING_FILTER` (Story 2.8) already established a 30-day "expiring soon"
window as this codebase's convention — this story's default `alertLeadDays` must stay consistent
with it rather than inventing a different window:

```1:1:apps/api/src/modules/projects/dashboard-stats.ts
-- EXPIRING_FILTER uses: now() + make_interval(days => 30)
```
[Source: `apps/api/src/modules/projects/dashboard-stats.ts` — `EXPIRING_FILTER`]

`credential.expiry` is **already** registered in `NOTIFICATION_ALERT_TYPES`
(`packages/shared/src/constants/notification-types.ts`, added speculatively in Story 3.2) — no
shared-package change is needed there; this story is the first to actually populate it. No
dedicated email/Slack template exists for it in `apps/api/src/notifications/templates/index.ts`
either, but neither do certificate/domain/payment/machine-key — they all render through the same
generic fallback template today. Adding dedicated per-type templates is out of scope for this story
(same gap, same non-fix, across five alert types now — a documentation/backlog note, not a blocker).

The next free migration index is **43** (`packages/db/src/migrations/0042_platform_audit_retention_purge.sql`
is the latest; confirm against `packages/db/src/migrations/meta/_journal.json` before naming the new
file, in case a parallel story landed one first).

**Deliberately out of scope:** exposing `alertLeadDays` as a per-credential configurable value via
a PATCH endpoint. The "must cover at minimum" ask is "define reasonable thresholds," not "make them
operator-configurable" — every sibling table's thresholds are also configurable via their own
respective PATCH routes already, so this is a real, tracked gap for credentials too, but it is
new API surface beyond this story's scope (worker wiring + reliability fixes). Track it as a
follow-up in `deferred-work.md` at story close, do not silently add it.

### 2. Notification queue, dispatcher, and the real N+1

`notification_queue` (`packages/db/src/schema/notification-queue.ts`):

```1:37:packages/db/src/schema/notification-queue.ts
export const notificationQueue = pgTable(
  'notification_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }),
    recipientEmail: text('recipient_email'),
    channel: text('channel').notNull(),
    templateId: text('template_id').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliverAt: timestamp('deliver_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  ...
    statusCheck: check(
      'notification_queue_status_check',
      sql`${t.status} IN ('pending','delivered','failed','suppressed')`
    ),
```

`'failed'` is already a legal enum value at the DB level — **nothing in the codebase ever writes
it**. `notification-queue-ops.ts` only exports `markNotificationDelivered` and
`markNotificationSuppressed`; there is no `markNotificationFailed`.

The real, current N+1 (confirmed by direct grep, `apps/api/src/notifications/dispatcher.ts`):

```142:167:apps/api/src/notifications/dispatcher.ts
export async function createOrgAdminNotificationEntries(
  options: CreateEntriesOptions
): Promise<NotificationQueueJob[]> {
  const { orgId, template, tx } = options
  const alertSeverity = template.severity ?? 'warning'
  const recipientUserIds =
    options.recipientUserIds ?? (await resolveRoutingRecipients(orgId, template.templateId, tx))
  const queueJobs: NotificationQueueJob[] = []
  const seenUserChannels = new Set<string>()
  let slackEnabled = false

  // TODO(perf): one getPreferences() query per recipient — batch this into a single
  // query keyed by userId once routing tables grow past small org member counts
  // (deferred-work.md — Epic 3 closure, Story 3.4 AC-16).
  for (const userId of recipientUserIds) {
    const result = await processRecipientPreferences(
      orgId,
      userId,
      template,
      alertSeverity,
      tx,
      seenUserChannels
    )
```

`getPreferences(orgId, userId, tx)` (`apps/api/src/modules/notifications/preferences.ts`) issues one
`SELECT ... FROM notification_preferences WHERE org_id = ? AND user_id = ?` per call, then fills in
defaults for every `(alertType, channel)` pair not explicitly overridden. This is exactly one query
per recipient inside the loop above — the N+1.

### 3. The real DLQ gap — catchup resends forever, nothing ever marks `failed`

Every delivery channel handler (`notification-email.ts`, `notification-slack.ts`,
`notification-inbox.ts`, `notification-deliver.ts`) shares one "catchup" sweep,
`runNotificationCatchup` (`apps/api/src/workers/notification-worker-common.ts`), scheduled every 10
minutes (`NOTIFICATION_CATCHUP_CRON = '*/10 * * * *'`, `apps/api/src/main.ts`):

```41:63:apps/api/src/workers/notification-worker-common.ts
    const staleEntries = await withOrg(orgId, (tx) =>
      tx.execute<{ id: string }>(
        deliverAtAware
          ? sql`
              SELECT id::text AS id
              FROM notification_queue
              WHERE org_id = ${orgId}::uuid
                AND status = 'pending'
                AND (deliver_at IS NULL OR deliver_at <= NOW())
                AND created_at < NOW() - INTERVAL '5 minutes'
              LIMIT 100
            `
          : sql`
              SELECT id::text AS id
              FROM notification_queue
              WHERE org_id = ${orgId}::uuid
                AND channel = ${channel}
                AND status = 'pending'
                AND created_at < NOW() - INTERVAL '5 minutes'
              LIMIT 100
            `
      )
    )
    for (const entry of staleEntries) {
      await boss.send(jobName, { notificationQueueId: entry.id, orgId }, { retryLimit: 3, ... })
```

**Neither `WHERE` clause filters on `attempt_count` at all.** A poison-pill entry (e.g. SMTP
permanently misconfigured, so `sendEmailNotification` throws every time) stays `status = 'pending'`
forever — pg-boss's own 3 internal retries (`NOTIFICATION_JOB_OPTIONS.retryLimit`, `dispatcher.ts`)
exhaust and give up on that one job, but the *row* is untouched, so the next catchup pass 10 minutes
later re-sends it via `boss.send(...)` again, forever, with no terminal state and no visibility.
`claimPendingNotificationEntry` (`notification-queue-ops.ts`) increments `attempt_count` on every
single handler invocation (initial dispatch, every pg-boss retry, every catchup resend), so
`attempt_count` is a reliable proxy for "how many times has this actually been attempted" — it is
simply never checked or acted on.

---

## Acceptance Criteria

### Group W — New `credential/expiry-alert` scheduled worker

**AC-W1 — `credentials` gains `alertLeadDays`/`notifiedLeadDays` columns, migration + schema in
lockstep, matching the sibling-table pattern exactly.**
**Given** the next free migration index is 43 (re-verify against `packages/db/src/migrations/meta/_journal.json`
immediately before implementing),
**When** the migration runs,
**Then** `credentials` gains `alert_lead_days jsonb NOT NULL DEFAULT '[30, 7, 1]'::jsonb` and
`notified_lead_days jsonb NOT NULL DEFAULT '[]'::jsonb`, and `packages/db/src/schema/credentials.ts`
declares both with `.$type<number[]>()`, matching `payment-records.ts`'s exact column shape
(AC "must stay consistent with `dashboard-stats.ts`'s existing 30-day 'expiring soon' window" —
hence `30` as the first threshold, not a new window).

**Example (positive):** a fresh migration run against an empty DB leaves every existing credential
row with `alertLeadDays = [30, 7, 1]`, `notifiedLeadDays = []` (the column defaults apply
retroactively to pre-existing rows, matching how `payment_records`'/`cert_records`' own migrations
behaved).

**Example (edge — existing credential rows created before this migration):** a credential inserted
under the old schema (no `alertLeadDays` at insert time) still reads back `[30, 7, 1]` after the
migration — the `NOT NULL DEFAULT` backfills every row, not just future inserts.

---

**AC-W2 — New worker `runCredentialExpiryAlertJob` fires at the 30/7/1-day thresholds plus overdue,
built on the existing shared `runExpiryAlertJob`/`computeExpiryAlertFirings` machinery — no new
threshold-matching logic invented.**
**Given** a credential with `expiresAt` 7 days from now and `alertLeadDays = [30, 7, 1]`,
**When** `runCredentialExpiryAlertJob(boss, logger)` runs,
**Then** it fires a `credential.expiry` notification at `warning` severity (per
`severityForDaysRemaining`'s existing `<=7 -> warning` rule) with payload
`{ assetId, projectId, name, expiresAt, daysRemaining: 7, threshold: 7, overdue: false }`, and the
credential's `notifiedLeadDays` becomes `[7]` in the same transaction as the queue insert (per-row
transactional atomicity, `processExpiryAlertRow`'s existing pattern — no new transaction boundary
needed).

**Example (positive — critical threshold):** `expiresAt` 1 day from now → fires at `critical`
severity (`<=3 -> critical`), `threshold: 1`.

**Example (positive — overdue, already past expiry):** `expiresAt` 3 days in the past, `alertLeadDays
= [30, 7, 1]`, `notifiedLeadDays = [30, 7, 1]` (all three already fired earlier) → still fires one
more `threshold: 0, overdue: true, severity: 'critical'` alert (the shared `daysRemaining <= 0 &&
!notifiedLeadDays.includes(0)` branch), because `0` was never separately notified.

**Example (edge — no threshold boundary crossed):** `expiresAt` 20 days from now, `alertLeadDays =
[30, 7, 1]` → no firing (`|20-30|=10 > 1` tolerance, `|20-7|=13`, `|20-1|=19`, all outside the
±1-day match window) — no queue entry, `notifiedLeadDays` unchanged.

---

**AC-W3 — Idempotency: a threshold already recorded in `notifiedLeadDays` never re-fires on a
subsequent run, but a newly-crossed threshold fires independently.**
**Given** a credential with `expiresAt` 6 days from now, `alertLeadDays = [30, 7, 1]`,
`notifiedLeadDays = [7]` (the 7-day alert already fired yesterday),
**When** `runCredentialExpiryAlertJob` runs again today,
**Then** no new `notification_queue` entry is created for this credential and `notifiedLeadDays`
stays `[7]` — matching this codebase's existing, already-tested behavior for the sibling worker
(`cert-expiry-alert.test.ts`'s `'does not re-fire the same threshold on the following day'`).

**Example (positive — running the job twice in the same day, e.g. a duplicate cron trigger, is
safe):** run `runCredentialExpiryAlertJob` twice sequentially against the same 7-day-remaining
credential → exactly one `notification_queue` entry total, not two (the second run finds `7` already
in `notifiedLeadDays` from the first run's commit).

**Example (edge — boundary crossing fires a second, independent alert):** the same credential, one
day later, now at `daysRemaining = 1` → the 1-day threshold fires (not previously in
`notifiedLeadDays`), independent of the already-recorded 7-day firing — `notifiedLeadDays` becomes
`[7, 1]`.

---

**AC-W4 — Registered in `main.ts` at the same daily cadence as the sibling expiry-alert jobs.**
**Given** `payment/expiry-alert`, `cert/expiry-alert`, `domain/expiry-alert`, and
`machine-key/expiry-alert` all run `{ cron: '0 8 * * *' }`,
**When** `credential/expiry-alert` is added to both `registerSchedules({...})` and
`registerWorkers({...})` in `apps/api/src/main.ts`,
**Then** it uses the identical `'0 8 * * *'` cadence and the identical `withJobLogging(fastify.log,
'credential/expiry-alert', job.id ?? 'unknown', () => runCredentialExpiryAlertJob(boss,
fastify.log))` wiring pattern as its four siblings — no new scheduling convention invented.

**Example (positive):** `apps/api/src/__tests__/worker-registration.test.ts`'s existing
`arrayContaining([...])` queue-name assertion (which already lists all 4 sibling `*/expiry-alert`
names) gains `'credential/expiry-alert'` as a 5th entry — extend the array, do not create a new
test.

**Example (edge — job name charset):** `'credential/expiry-alert'` matches
`worker-registration.test.ts`'s `PG_BOSS_NAME_PATTERN` (`/^[\w.\-/]+$/`) — no colon, matching the
same lesson that test's own comment documents (`'payment:expiry-alert'` previously crashed
`registerSchedules` in production).

---

**AC-W5 — Edge cases: null `expiresAt` excluded from the scan; org isolation under RLS; one row's
failure never aborts the batch.**
**Given** an org with three credentials — one with `expiresAt = null`, one expiring in 7 days, and
one whose `updateNotifiedLeadDays` call is made to throw (simulated via a mocked/broken
`tx.update` in a unit test, or a genuinely malformed row) — plus a second, unrelated org with its
own expiring credential,
**When** `runCredentialExpiryAlertJob` runs across all orgs,
**Then**: (a) the `expiresAt = null` credential is never fetched at all (the `isNotNull` filter in
`fetchRows`, matching `cert-expiry-alert.ts`'s exact `and(eq(...), isNotNull(...))` predicate); (b)
the second org's credential fires its own alert regardless of the first org's outcome (`fetchAllOrgIds`'s
per-org loop, each in its own `withOrg`-scoped transaction — no row from org B is ever visible to
org A's iteration, RLS-enforced); (c) the throwing row's failure is caught by `processExpiryAlertRow`'s
existing per-row `try/catch` in `runExpiryAlertJob`, logged via `operationalLog('error',
OperationalEvent.MONITORING_EXPIRY_ALERT_ROW_FAILED, ..., { orgId, assetType: 'credential', assetId:
row.id, err })`, and the 7-day credential in the same org still fires its alert — one row's failure
does not abort the org's remaining rows or the job overall.

**Example (positive — cross-org isolation):** org A's expiring credential produces a
`notification_queue` row visible only under `withOrg(orgA, ...)`; org B's owner never receives it.

**Example (edge — documented, pre-existing, NOT introduced or fixed by this story):** two fully
concurrent invocations of `runCredentialExpiryAlertJob` (e.g. an operator manually triggers the job
while the cron tick is also mid-run) could both read the same credential's `notifiedLeadDays` before
either commits its `updateNotifiedLeadDays`, and both fire the same threshold — a genuine race. This
is identical, inherited behavior from `expiry-alert-shared.ts`, already present in all four sibling
workers since Story 6.1/7.2; this story does not introduce it and is not the place to fix it
(no per-row locking exists in the shared module today). Note it in Dev Notes as a known,
pre-existing limitation rather than silently ignoring it.

---

**AC-W6 — Delivery goes entirely through the existing `notification_queue`/dispatcher/preferences
path — no bespoke delivery mechanism.**
**Given** a firing credential-expiry threshold,
**When** the worker dispatches it,
**Then** it calls `createOrgAdminNotificationEntries({ orgId, tx, template: { templateId:
'credential.expiry', severity, payload } })` (the exact same function every other alert type calls)
followed by `sendNotificationJobs(boss, jobs)` — the recipient resolution (`resolveRoutingRecipients`,
default `owner` role), preference filtering (`getPreferences`/severity gate), and channel routing
(email/Slack/inbox) are 100% reused, unmodified for this alert type.

**Example (positive):** an org owner with default notification preferences (email + inbox enabled,
`minSeverity: 'warning'`) and no explicit `credential.expiry` override receives the alert on both
channels — proving the pre-existing default-preference fallback in `getPreferences` already covers
this new alert type without any preferences-schema change.

**Example (edge — owner has explicitly silenced `credential.expiry`):** an owner who previously
called `PATCH /settings/notifications` setting `credential.expiry` to `channel: 'none'` for both
channels receives no email/inbox entry for this alert type — proving the existing per-alert-type
preference override (Story 3.2) applies to this new type with zero new code.

---

**AC-W7 — No audit-log entry is written for an automated firing, consistent with all four sibling
expiry-alert workers.**
**Given** the worker fires a threshold notification for a credential,
**When** the `notification_queue` entry is created and `notifiedLeadDays` is updated,
**Then** no `audit_log_entries` row is written — matching `cert-expiry-alert.ts`/
`domain-expiry-alert.ts`/`payment-expiry-alert.ts`/`machine-key-expiry-alert.ts`, none of which
write an audit entry for a successful automated firing (audit logging in this codebase is reserved
for human-initiated or security-relevant actions, not scheduled system alerts). The only logging
on any path is the per-row `operationalLog` failure call from AC-W5(c), and only on error.

**Example (positive):** after a successful firing, `audit_log_entries` for that org gains zero new
rows; `notification_queue` gains exactly one (or more, per channel) new row(s).

**Example (edge — the row throws during processing, AC-W5(c)'s scenario):** still zero
`audit_log_entries` rows either way — only the `operationalLog` error call fires, not an audit
write.

---

### Group E — E3-2: `PENDING_DELIVERY` → `notification_queue` → dispatched integration test

**AC-E1 — Closes the literal test gap: the existing backfill test proves rows land in
`notification_queue`, but never proves they are actually dispatched. Extend it (or add a sibling
test) to assert the full FR73 chain.**
**Given** `notification-backfill.test.ts`'s existing `'processes all PENDING_DELIVERY security
alerts and marks them delivered'` test (seeds two `security_alerts` rows with `status =
'PENDING_DELIVERY'`, runs `runNotificationBackfill(boss, testLogger)`, and today only asserts the
alerts flip to `'delivered'` and `notification_queue.length > 0`),
**When** this story extends that test,
**Then** it additionally asserts the mocked `send` (from `createMockBoss()`) was called with
`'notification/deliver'` and a payload `{ notificationQueueId, orgId }` matching one of the created
queue-row ids, for **each** queue row created — proving the chain reaches the actual dispatch call,
which the current test never checks.

**Example (positive — dispatch is asserted):** `expect(send).toHaveBeenCalledWith('notification/deliver',
expect.objectContaining({ notificationQueueId: expect.any(String), orgId }), expect.anything())`,
once per queue row.

**Example (edge — true end-to-end, not just the dispatch call): a new test that additionally invokes
the real delivery function** `deliverNotification(notificationQueueId, orgId)`
(`apps/api/src/workers/notification-deliver.ts`) directly against a queue-row id created by
`runNotificationBackfill`, with the email transport stubbed (`setEmailTransportForTesting`,
matching `notification-email.test.ts`'s existing mocking convention) — asserts the row's terminal
`status` becomes `'delivered'` (via `getNotificationQueueEntry`/`expectQueueStatus`,
`notification-test-helpers.ts`). This is the genuine end of the FR73 chain: `PENDING_DELIVERY` →
`notification_queue` (`'pending'`) → dispatched (`boss.send`) → delivered (`status = 'delivered'`).

**Example (failure path — proving "dispatched" depends on boss being started, not just
enqueued):** if `boss.isStarted()` returns `false` (matches `sendNotificationJobs`'s existing early
return, `dispatcher.ts` lines 187-192), `send` is never called and every queue row created by that
run stays `status = 'pending'` — assert this explicitly (`createMockBoss()` without calling
`boss.start()`) as a named negative case, so the story doesn't just show the happy path.

---

### Group D — Dispatcher N+1 fix: batch the per-recipient preference lookup

**AC-D1 — New `getPreferencesBatch(orgId, userIds, tx)` issues exactly one query for N recipients,
not N.**
**Given** `getPreferences(orgId, userId, tx)`'s existing per-user query + in-memory default-filling
logic (`apps/api/src/modules/notifications/preferences.ts`),
**When** `getPreferencesBatch(orgId, userIds, tx)` is added alongside it,
**Then** it issues a single `SELECT ... FROM notification_preferences WHERE org_id = ? AND user_id
IN (...)` (Drizzle `inArray`), groups the results by `userId` in memory, and applies the exact same
`NOTIFICATION_ALERT_TYPES` × `DEFAULT_NOTIFICATION_CHANNELS` default-filling loop `getPreferences`
already uses — per user — returning a `Map<string, PreferenceOutput[]>` keyed by `userId`, with an
entry present for every `userId` passed in (even one with zero stored rows, backed entirely by
defaults).

**Example (positive):** 5 recipients, none with stored preference rows → 1 query total (not 5), and
the returned `Map` has 5 entries, each containing the full default set (every `NOTIFICATION_ALERT_TYPES`
× `DEFAULT_NOTIFICATION_CHANNELS` combination) — output identical in content to calling
`getPreferences` 5 times, just 1 query instead of 5.

**Example (edge — empty `userIds`):** `getPreferencesBatch(orgId, [], tx)` returns an empty `Map`
without issuing any query at all (short-circuit — an org with zero resolved recipients, e.g. a role
override pointing at a role no one currently holds, must not still pay for a trivially-empty `IN
()` query).

---

**AC-D2 — `createOrgAdminNotificationEntries` uses the batched lookup; output is byte-for-byte
equivalent to the old per-recipient-loop behavior.**
**Given** the existing `TODO(perf)` loop (`dispatcher.ts` lines 156-167) calling
`processRecipientPreferences` → `getPreferences` once per `userId`,
**When** it is replaced with one `getPreferencesBatch(orgId, recipientUserIds, tx)` call before the
loop, with `processRecipientPreferences` (or its replacement) reading from the pre-fetched `Map`
instead of querying again,
**Then** the `TODO(perf)` comment is deleted, and for the exact same inputs, the resulting
`NotificationQueueJob[]` (which recipients/channels/severities produce queue rows) is unchanged —
severity filtering (`passesSeverityFilter`), per-`(userId, channel)` dedup (`seenUserChannels`), and
Slack-aggregation-into-one-org-wide-entry behavior are all preserved exactly.

**Example (positive — regression, must produce identical output to today):**
`dispatcher.test.ts`'s existing `'creates email and inbox entries for owner with default
preferences'` test (asserts `jobs.length >= 2`, one `email` row, one `inbox` row, zero `slack` rows)
passes unmodified after the refactor — same assertions, same outcome, different internal query
count.

**Example (positive — the actual query-count fix, the point of this AC):** a new test with 3
org-admin recipients (default preferences) asserts `createOrgAdminNotificationEntries` issues
exactly 1 `notification_preferences` query total for the batch, not 3 — spy/count on the DB
call (e.g. wrapping `tx` or asserting via a query-count test helper already used elsewhere in this
codebase, or asserting behaviorally via a mocked `getPreferencesBatch` call count of 1).

**Example (edge — mixed stored-override and default-fallback recipients in the same batch):** 2
recipients, one with a stored `credential.expiry` → `slack`-only override, one with zero stored
rows (pure defaults) → both are resolved correctly from the single batched query's grouped-by-`userId`
result — the override recipient does not "leak" into or override the default recipient's entry.

---

**AC-D3 — Regression: `dispatchDirectUserNotification` (single-recipient self-alerts, e.g. MFA
recovery) is unaffected — it still calls single-user `getPreferences`, not the new batch function.**
**Given** `dispatchDirectUserNotification` (`dispatcher.ts`) is a genuinely single-recipient path
(one user, their own preferences, no org-routing fan-out) with no N+1 to fix,
**When** this story's refactor lands,
**Then** `dispatchDirectUserNotification` is left calling `getPreferences(orgId, userId, tx)`
unchanged — batching a single user is not a meaningful optimization and would only add
indirection; the existing test coverage for this function (`dispatcher.test.ts`) passes unmodified.

**Example (regression, must not change):** an MFA-recovery-used self-alert to a single user still
produces the same email/inbox entries as before, via the same unmodified code path.

---

### Group Q — `notification_queue` failed-status / DLQ cleanup

**AC-Q1 — `markNotificationFailed` exists; catchup stops resending entries that have exhausted a
bounded attempt budget.**
**Given** `NOTIFICATION_MAX_ATTEMPTS = 5` is defined as a new shared constant in
`notification-worker-common.ts` (chosen to comfortably exceed `NOTIFICATION_JOB_OPTIONS.retryLimit:
3`'s pg-boss-level retries plus at least one catchup-triggered resend cycle, so a genuinely
transient failure — e.g. one SMTP blip — is never prematurely marked failed),
**When** `runNotificationCatchup`'s two `SELECT` branches (`notification-worker-common.ts`) are
updated to add `AND attempt_count < ${NOTIFICATION_MAX_ATTEMPTS}` to both the `deliverAtAware` and
channel-specific queries,
**Then** an entry that has already reached `attempt_count = 5` is never re-selected by any future
catchup pass — closing the literal bug (confirmed by direct reading of the current code: neither
`WHERE` clause today filters on `attempt_count` at all, so a poison-pill entry is resent every 10
minutes forever).

**Example (positive — the exact bug this AC fixes):** a `notification_queue` entry with
`attempt_count = 5`, `status = 'pending'`, `created_at` 20 minutes ago → catchup's query no longer
returns it (previously: it would, every single 10-minute pass, forever).

**Example (edge — an entry still within its legitimate retry budget):** `attempt_count = 2`,
`status = 'pending'`, `created_at` 20 minutes ago (past the existing 5-minute staleness threshold)
→ still returned and resent by catchup, unchanged from today — this AC narrows catchup's upper
bound, it does not touch the existing lower-bound staleness check.

---

**AC-Q2 — New periodic `notification/dlq-cleanup` job marks exhausted entries `failed` and logs a
reportable summary.**
**Given** a `notification_queue` entry has reached `attempt_count >= NOTIFICATION_MAX_ATTEMPTS` and
`last_attempt_at` is older than 30 minutes (chosen to sit safely past pg-boss's own
`retryDelay: 60`-second backoff window and at least one full catchup cycle, so cleanup never races
an attempt still legitimately in flight),
**When** the new `runNotificationDlqCleanup(logger)` (`apps/api/src/workers/notification-dlq-cleanup.ts`)
runs — org-scoped via `fetchAllOrgIds`/`withOrg`, mirroring `runNotificationCatchup`'s exact
per-org-loop pattern,
**Then** it calls the new `markNotificationFailed(notificationQueueId, orgId)`
(`notification-queue-ops.ts`, sets `status = 'failed'`) for every matching entry, and logs one
`operationalLog(..., OperationalEvent.NOTIFICATION_DLQ_CLEANUP_SUMMARY, ..., { count })` call per
run — `'warn'` level if `count > 0` (an operator-visible signal something is actually failing
permanently), `'info'` level (or no log at all, matching `runNotificationBackfill`'s existing
"only log if `totalProcessed > 0`" convention — pick one and apply consistently) if `count === 0`.

**Example (positive):** 3 exhausted entries across 2 orgs → all 3 flip to `status = 'failed'`, one
log call with `{ count: 3 }`.

**Example (edge — zero exhausted entries, the common case):** no `status = 'failed'` writes, and
either no log line or an `'info'`-level one — never a spurious `'warn'` on a healthy run.

**Example (edge — the exact race AC-Q1/Q2 must not create — an in-flight send completes between
this job's `SELECT` and its `UPDATE`):** an entry is selected as a cleanup candidate, but before the
`UPDATE ... SET status = 'failed'` runs, a lagging in-flight delivery attempt succeeds and calls
`markNotificationDelivered` first. The cleanup `UPDATE` must be scoped `WHERE status = 'pending'`
(matching `markNotificationDelivered`'s/`claimPendingNotificationEntry`'s own unconditional-except-
status-guarded pattern) so it never clobbers an entry that became `'delivered'` in the interim —
verify with a test that pre-sets `status = 'delivered'` on a row that otherwise matches the
attempt-count/age criteria and asserts cleanup leaves it `'delivered'`, not `'failed'`.

**Known accepted limitation (flagged by 2026-07-09 adversarial review, not fixed here):** the
reverse ordering — cleanup marks an entry `'failed'` first, then a lagging in-flight delivery
completes and calls `markNotificationDelivered` — is NOT guarded, because `markNotificationDelivered`
(`notification-queue-ops.ts`) has no `WHERE status = ...` clause today (it's a plain `WHERE id = ?`
update, matching every other status-transition helper in that file). In that ordering the row
correctly ends up `'delivered'` (the notification really was sent — the terminal state is accurate),
but the earlier DLQ cleanup summary log for that run will have already reported it as part of the
`{ count }` of failures, which becomes a stale/overcounted metric for that one run. This is a minor
observability inaccuracy, not a correctness or data-integrity bug (no notification is lost or
double-sent), and is accepted as-is rather than adding a compensating guard — do not silently
"fix" it during implementation without discussing the trade-off (a guard here would need to
distinguish "already failed, stay failed" from "failed then legitimately delivered late," which
adds real complexity for a cosmetic metric).

---

**AC-Q3 — Registered in `main.ts`; org-isolated like every other org-scoped worker.**
**Given** the existing `notification/*-catchup` jobs all run on `NOTIFICATION_CATCHUP_CRON = '*/10 *
* * *'`,
**When** `notification/dlq-cleanup` is added to `registerSchedules`/`registerWorkers`,
**Then** it runs on a less-frequent cadence appropriate to a terminal-state sweep rather than a
resend sweep — `'*/30 * * * *'` (every 30 minutes) — and, like `runNotificationCatchup`, never
inspects or mutates another org's rows (each org's scan and update happen inside that org's own
`withOrg(orgId, ...)` transaction).

**Example (positive):** `worker-registration.test.ts`'s `arrayContaining([...])` queue-name list
gains `'notification/dlq-cleanup'`.

**Example (edge — cross-org isolation):** org A has 5 exhausted entries, org B has 0 → only org A's
5 flip to `'failed'`; the summary log's `count` reflects the cross-org total (matching
`runNotificationCatchup`'s existing pattern of a single job-wide total across all orgs, not a
per-org log line).

---

**AC-Q4 — New `OperationalEvent.NOTIFICATION_DLQ_CLEANUP_SUMMARY` constant, following this
codebase's existing registry convention.**
**Given** `packages/shared/src/constants/operational-event-types.ts`'s existing flat `OperationalEvent`
object (grouped by feature area with a comment header per section, e.g. `// Audit log
search/export/forwarding/retention (Story 8.2)`),
**When** this story adds the new constant,
**Then** it is added under a new `// Notification queue DLQ cleanup (Story 3.5)` section, value
`'notification.dlq_cleanup.summary'` — matching this codebase's existing `feature.action.detail`
dot-notation naming convention (compare `'audit.retention_prune.summary'`,
`'backup.missed_resolved'`).

**Example (positive):** `OperationalEvent.NOTIFICATION_DLQ_CLEANUP_SUMMARY === 'notification.dlq_cleanup.summary'`,
and the type-checked `OperationalEventType` union includes it automatically (it's a
`keyof typeof OperationalEvent` derived type — no separate union to hand-maintain).

---

## Tasks / Subtasks

Follow this project's TDD convention: write/update the failing test first, confirm it fails for the
expected reason, then implement, per AC.

- [ ] **Task 1 — Group W: schema + migration (AC-W1)**
  - [ ] 1.1 **Cross-story coordination (do not skip):** as of 2026-07-09, TWO sibling stories from
    the same reconciliation batch *also* target migration index 43:
    `4-5-fine-grained-permissions-and-project-rbac` (`0043_project_membership_visibility_backfill.sql`)
    and `1-13-infra-and-process-hardening` (`0043_normalize_tag_case.sql`), for the same
    `packages/db/src/migrations/` directory. All three stories were drafted in parallel worktrees and
    none reserves the number — whichever of 3-5/4-5/1-13 is implemented (and merged to `main`)
    **first** keeps `0043`; the second keeps whatever the real next free number is at that time
    (likely `0044`); the third similarly takes the next free number after that (likely `0045`).
    Re-confirm the actual next free index against `meta/_journal.json` before writing the file — do
    not trust this story's hardcoded "43" if either sibling already claimed it.
  - [ ] 1.2 Add `alertLeadDays`/`notifiedLeadDays` to `packages/db/src/schema/credentials.ts`,
    mirroring `payment-records.ts`'s exact column definitions (defaults `[30, 7, 1]`/`[]`).
  - [ ] 1.3 Generate/hand-write `packages/db/src/migrations/0043_credential_expiry_alerts.sql`
    (number per 1.1's coordination check — may need to be `0044` or higher if 4-5 landed first)
    (`ALTER TABLE credentials ADD COLUMN ...` × 2, matching `0032_machine_key_rotation_dormancy_cacheable.sql`'s
    single-`ALTER TABLE`-per-statement style with `--> statement-breakpoint` separators). Update
    `packages/db/src/migrations/meta/_journal.json`.

- [ ] **Task 2 — Group W: the worker itself (AC-W2 through AC-W7)**
  - [ ] 2.1 RED: new `apps/api/src/workers/credential-expiry-alert.test.ts`, mirroring
    `cert-expiry-alert.test.ts`'s exact structure (`withExpiryAlertTestOrg`, `insertTestProject`,
    `daysFromNow`, `expectQueueEntryFired`/`expectNoQueueEntries` from `expiry-alert-test-helpers.ts`)
    — cover every AC-W2/W3/W5/W6/W7 example. Confirm failure (module doesn't exist).
  - [ ] 2.2 GREEN: `apps/api/src/workers/credential-expiry-alert.ts`, copying `cert-expiry-alert.ts`'s
    shape exactly: `jobName: 'credential/expiry-alert'`, `templateId: 'credential.expiry'`,
    `assetType`/`assetLabel: 'credential'`, `fetchRows` against `credentials` filtered by
    `isNotNull(expiresAt)`, `buildPayload` with `{ assetId, projectId, name, expiresAt, ...baseExpiryPayload }`,
    `updateNotifiedLeadDays` against `credentials`.
  - [ ] 2.3 Register in `apps/api/src/main.ts`: `'credential/expiry-alert': { cron: '0 8 * * *' }` in
    `registerSchedules`, matching `withJobLogging` wiring in `registerWorkers` (AC-W4).
  - [ ] 2.4 Extend `worker-registration.test.ts`'s `arrayContaining([...])` list with
    `'credential/expiry-alert'`.
  - [ ] 2.5 Re-run all tests, confirm green.

- [ ] **Task 3 — Group E: E3-2 integration test (AC-E1)**
  - [ ] 3.1 RED: extend `notification-backfill.test.ts`'s existing test with the `send`-call
    assertions; add the new `deliverNotification`-direct-call test and the `boss.isStarted() ===
    false` negative test (new `describe`/`it` blocks in the same file, or a new sibling file if
    cleaner). Confirm the new assertions fail against current (unmodified) code only in the sense
    that they were never previously asserted — the underlying behavior likely already passes; the
    RED step here is confirming the *new assertions* are well-formed by first checking they fail
    against a deliberately broken temporary edit (e.g. commenting out `sendNotificationJobs`'s
    `boss.send` call), then reverting.
  - [ ] 3.2 Confirm all green with the real (unmodified where correct) code.

- [ ] **Task 4 — Group D: dispatcher batch fix (AC-D1 through AC-D3)**
  - [ ] 4.1 RED: add `getPreferencesBatch` tests to `preferences.test.ts` (AC-D1's examples). Confirm
    failure (function doesn't exist).
  - [ ] 4.2 GREEN: implement `getPreferencesBatch` in `preferences.ts` (single `inArray` query +
    per-user default-filling, reusing `getPreferences`'s existing default-filling loop body, factored
    into a shared private helper if that avoids duplication).
  - [ ] 4.3 RED: add the query-count regression test to `dispatcher.test.ts` (AC-D2's second
    example). Confirm it fails against the current per-recipient-loop code (N queries, not 1).
  - [ ] 4.4 GREEN: refactor `createOrgAdminNotificationEntries` to call `getPreferencesBatch` once;
    update `processRecipientPreferences` (or inline its logic) to read from the pre-fetched `Map`;
    delete the `TODO(perf)` comment.
  - [ ] 4.5 Re-run all of `dispatcher.test.ts` and `preferences.test.ts`, confirm every existing test
    still passes unmodified (AC-D2/D3 regressions) and the new tests pass.

- [ ] **Task 5 — Group Q: DLQ cleanup (AC-Q1 through AC-Q4)**
  - [ ] 5.1 Add `OperationalEvent.NOTIFICATION_DLQ_CLEANUP_SUMMARY` (AC-Q4).
  - [ ] 5.2 Add `markNotificationFailed` to `notification-queue-ops.ts` (mirrors
    `markNotificationSuppressed`'s exact shape).
  - [ ] 5.3 RED: add `notification-worker-common.test.ts` (or extend an existing catchup test file)
    covering AC-Q1's positive/edge examples. Confirm failure.
  - [ ] 5.4 GREEN: add `NOTIFICATION_MAX_ATTEMPTS` constant; add `attempt_count <
    NOTIFICATION_MAX_ATTEMPTS` to both `runNotificationCatchup` query branches.
  - [ ] 5.5 RED: new `apps/api/src/workers/notification-dlq-cleanup.test.ts` covering AC-Q2's
    positive/edge/race examples. Confirm failure (module doesn't exist).
  - [ ] 5.6 GREEN: implement `runNotificationDlqCleanup` in
    `apps/api/src/workers/notification-dlq-cleanup.ts`.
  - [ ] 5.7 Register `'notification/dlq-cleanup': { cron: '*/30 * * * *' }` in `main.ts`
    (AC-Q3); extend `worker-registration.test.ts`'s array.
  - [ ] 5.8 Re-run all tests, confirm green.

- [ ] **Task 6 — Full verification**
  - [ ] 6.1 Run the full `apps/api` test suite — confirm no regressions.
  - [ ] 6.2 `make ci` (or equivalent local lint/typecheck/test gate) green.
  - [ ] 6.3 Update `deferred-work.md`: mark E3-2, "Credential expiry notifications," and the 3 "Open
    (Epic 3 closure, Story 3.4 AC-16)" rows resolved, cross-referencing this story (do not delete the
    historical record). Also add the newly-identified, deliberately-deferred
    "configurable per-credential `alertLeadDays`" gap (Background § 1) as a new tracked row.

---

## Dev Notes

- **Do not invent a new worker-scheduling, org-fan-out, or failure-isolation pattern.**
  `runExpiryAlertJob`/`computeExpiryAlertFirings` (`expiry-alert-shared.ts`) already solve this
  completely and are used identically by 4 existing workers — the credential worker should be the
  shortest possible config object passed to that shared function, same as `cert-expiry-alert.ts`.
- **The concurrent-overlap race in AC-W5's last edge case is real, pre-existing, and shared across
  all 5 workers (4 existing + this story's new one) after this story ships.** It is explicitly out
  of scope to fix here — fixing it would mean adding row-level locking to `expiry-alert-shared.ts`
  itself, affecting all 4 already-shipped sibling workers, which is a bigger, cross-cutting change
  than this story's bundled scope. Flag it in `deferred-work.md` at story close (Task 6.3) rather
  than silently leaving it undocumented.
- **`NOTIFICATION_MAX_ATTEMPTS = 5` and the 30-minute DLQ-cleanup age threshold are this story's own
  judgment call, not a pre-existing convention** — there is no existing "how many retries is too
  many" constant anywhere in this codebase to copy. The reasoning (retryLimit 3 + at least one
  catchup cycle) is documented in AC-Q1/AC-Q2; if code review disagrees with the specific numbers,
  that is a legitimate discussion — the important, non-negotiable part is that *some* bounded
  terminal state now exists at all, closing the "resends forever" bug.
- **Do not add a dedicated `credential.expiry` email/Slack template.** Every sibling expiry alert
  type (certificate/domain/payment/machine-key) also renders through the generic fallback template
  in `apps/api/src/notifications/templates/index.ts` — adding a dedicated template for credentials
  only would be inconsistent, not an improvement. This is a real, pre-existing gap across all five
  types; leave it as-is and let a future template-polish story address all five together.
- **`getPreferencesBatch`'s per-user default-filling logic must stay byte-for-byte identical to
  `getPreferences`'s** — extract a shared private helper (e.g. `fillDefaultPreferences(stored:
  PreferenceOutput[]): PreferenceOutput[]`) rather than copy-pasting the loop, to guarantee AC-D2's
  "output identical to today" requirement isn't defeated by two slightly-diverging implementations.
- **`dispatchDirectUserNotification` is intentionally NOT touched (AC-D3)** — it's a genuinely
  single-recipient path; batching one user is not an optimization.

### Project Structure Notes

New files:
- `packages/db/src/migrations/0043_credential_expiry_alerts.sql` (renumber if sibling story
  `4-5-fine-grained-permissions-and-project-rbac` or `1-13-infra-and-process-hardening` claims
  0043 first — see Task 1.1)
- `apps/api/src/workers/credential-expiry-alert.ts` + `.test.ts`
- `apps/api/src/workers/notification-dlq-cleanup.ts` + `.test.ts`

Modified files:
- `packages/db/src/schema/credentials.ts` (AC-W1)
- `apps/api/src/main.ts` (AC-W4, AC-Q3 — register 2 new jobs)
- `apps/api/src/__tests__/worker-registration.test.ts` (extend the `arrayContaining` list, AC-W4/AC-Q3)
- `apps/api/src/notifications/dispatcher.ts` + `.test.ts` (AC-D2)
- `apps/api/src/modules/notifications/preferences.ts` + `.test.ts` (AC-D1)
- `apps/api/src/workers/notification-queue-ops.ts` (AC-Q1 — add `markNotificationFailed`)
- `apps/api/src/workers/notification-worker-common.ts` (+ new/extended test file) (AC-Q1)
- `apps/api/src/workers/notification-backfill.test.ts` (AC-E1)
- `packages/shared/src/constants/operational-event-types.ts` (AC-Q4)
- `_bmad-output/implementation-artifacts/deferred-work.md` (Task 6.3 closure notes)

No changes needed to: `NOTIFICATION_ALERT_TYPES` (already has `credential.expiry`), any
`+page.svelte`/`+page.server.ts` (no web surface), `notification-inbox.ts` (unchanged consumer of
the queue), `routing.ts` (default `owner`-role routing applies unchanged), `route-exemptions.ts`
(confirmed no existing expiry-alert worker has an entry there — none needed for this one either).

### References

- [Source: `_bmad-output/implementation-artifacts/deferred-work.md#Deferred-from-Epic-2-closure-retrospective-2026-06-30`]
- [Source: `_bmad-output/implementation-artifacts/deferred-work.md#Epic-3-closure-Story-3.4-2026-06-30`]
- [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml` — `3-5-credential-expiry-notification-delivery` entry]
- [Source: `apps/api/src/workers/expiry-alert-shared.ts`]
- [Source: `apps/api/src/workers/cert-expiry-alert.ts`, `domain-expiry-alert.ts`, `payment-expiry-alert.ts`, `machine-key-expiry-alert.ts`]
- [Source: `apps/api/src/workers/cert-expiry-alert.test.ts`, `expiry-alert-test-helpers.ts`]
- [Source: `packages/db/src/schema/credentials.ts`, `payment-records.ts`, `notification-queue.ts`]
- [Source: `apps/api/src/modules/projects/dashboard-stats.ts` — `EXPIRING_FILTER`]
- [Source: `apps/api/src/notifications/dispatcher.ts`, `dispatcher.test.ts`]
- [Source: `apps/api/src/modules/notifications/preferences.ts`, `preferences.test.ts`]
- [Source: `apps/api/src/workers/notification-worker-common.ts`, `notification-queue-ops.ts`, `notification-backfill.ts`, `notification-backfill.test.ts`, `notification-deliver.ts`, `notification-email.ts`]
- [Source: `apps/api/src/main.ts` — `registerSchedules`/`registerWorkers`, `NOTIFICATION_CATCHUP_CRON`]
- [Source: `apps/api/src/__tests__/worker-registration.test.ts`]
- [Source: `packages/shared/src/constants/notification-types.ts`, `operational-event-types.ts`]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

TBD

### Debug Log References

### Completion Notes List

### File List
