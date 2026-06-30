# Story 3.1: Email & Slack Notification Delivery

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-28 - comprehensive developer guide for the notification delivery infrastructure.
     This story introduces the notification_queue table, nodemailer email delivery, Slack webhook delivery, the notification
     dispatcher helper, the PENDING_DELIVERY backfill job (wakes up pre-Epic-3 security alerts from Story 1.9), and the
     POST /api/v1/admin/notifications/test endpoint. It modifies check-failed-auth-threshold.ts to directly enqueue
     notifications instead of leaving PENDING_DELIVERY status. It is the foundation for Stories 3.2 (preferences/routing)
     and 3.3 (SSE inbox). -->

## Story

As a vault user,
I want to receive vault alerts and events via email and Slack,
so that I am notified of security events, expiring credentials, and system issues without checking the dashboard.

*Covers: FR51, FR52.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-3.1-Email--Slack-Notification-Delivery`]

---

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no (delivery is email/Slack; no primary web UI in this story) |
| **Linked UI story** | `3-2` (settings/notifications test UI), `3-3` (inbox — inbox channel stub only) |
| **Honest placeholder AC** | `/alerts` remains placeholder until 3.3; admin test endpoint is API-only |
| **Persona journey** | **N/A (infra)** — Org admin triggers `POST /api/v1/admin/notifications/test`; user receives email/Slack. Web inbox journey is Story 3.3. |

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 1.4 (`organizations`, `org_memberships`, `users`, `security_alerts` tables, RLS) is merged | The notification dispatcher looks up org admin/owner members via `org_memberships` and creates `notification_queue` entries scoped to `org_id`. The backfill job reads `security_alerts WHERE status = 'PENDING_DELIVERY'`. |
| Story 1.9 (`check-failed-auth-threshold.ts`, `security_alerts` status `PENDING_DELIVERY`) is merged | This story modifies `check-failed-auth-threshold.ts` to call the notification dispatcher directly (no longer writes `PENDING_DELIVERY`). The backfill job exists to drain all pre-Epic-3 `PENDING_DELIVERY` rows. |
| Story 1.10 (`withJobLogging`, `operationalLog`, pg-boss worker pattern) is merged | All three notification workers follow the same `withJobLogging` pattern established in Story 1.10. |
| Story 1.11 (`secureRoute()`, `SecureRouteContext`, route-audit CI gate) is merged | The admin test endpoint uses `secureRoute()`. The `route-audit.test.ts` CI gate requires `ROUTE_ACTION_CLASSIFICATIONS` entry for the new route. |
| Migration numbering **(R1 — verify against `meta/_journal.json`, do NOT hardcode)** | ⚠️ On the current branch after merging Stories 2.3–2.7, the expected free migration numbers are 0015–0019. This story's migration is the **next free number after whatever 2.7 actually committed** — call it `00XX_notification_queue.sql`. Before generating, run `cat packages/db/src/migrations/meta/_journal.json \| grep tag` and use the next free index. Every `00XX` placeholder in this doc is illustrative — substitute the real number. |

---

## Epic Cross-Story Context

| Story | Relationship to 3.1 |
|---|---|
| 1.4 | Established `orgScoped()`, RLS policy convention, `withOrg()` / `withTestOrg()` patterns. `notification_queue` uses `orgScoped({ onDelete: 'cascade' })` and follows the same RLS pattern. |
| 1.9 | Created `security_alerts` table with `status: 'PENDING_DELIVERY'` and the `check-failed-auth-threshold.ts` worker. This story completes the circuit by: (a) creating the `notification_queue` table, (b) modifying `check-failed-auth-threshold.ts` to enqueue directly, and (c) adding the backfill job for historical `PENDING_DELIVERY` rows. |
| 1.10 | Established the `withJobLogging`, `operationalLog`, and pg-boss worker pattern (`workers/*.ts`). All notification workers follow this pattern exactly. |
| 1.11 | Provides `secureRoute()` and `runOrgScopedJob()`. The admin test route and the email/Slack delivery workers use these constructs. |
| 3.2 | Adds per-user notification preferences and per-alert-type org routing. **3.1 deliberately uses a simplified dispatch**: notify all `owner` + `admin` members of the org. 3.2 will introduce a `notification_preferences` table and a smarter dispatcher. The 3.1 dispatcher should be factored into `notifications/dispatcher.ts` so 3.2 can replace the recipient-resolution logic without touching the workers. |
| 3.3 | Adds the in-product notification inbox (SSE + inbox channel). `notification_queue.channel` already accommodates `'inbox'` in its CHECK constraint; 3.1 workers only handle `'email'` and `'slack'`. The inbox worker is added in 3.3. |
| 9.x | Epic 9 adds the SMTP settings admin UI (FR86). Until then, SMTP is configured via env vars. The env var keys must match those used in Epic 9's admin settings page — do not invent your own naming; use the canonical names from this story: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Architecture wording | Canonical implementation for 3.1 | Rationale |
|---|---|---|
| Architecture says `notification:email` pg-boss job name | Use exactly **`notification:email`** and **`notification:slack`**. The `{domain}:{action}` job naming convention is authoritative (architecture.md). | Consistent with all other job names (`session:cleanup`, `health:check`, etc.). |
| Architecture shows `workers/notification-email.ts` and `workers/notification-slack.ts` (separate files) | Create two separate worker files as specified. | Architecture is explicit about the file layout. |
| Architecture says concurrency: `notification:* → teamSize: 5, teamConcurrency: 3` | Apply these exact limits via pg-boss `work()` options. | Required per architecture to prevent notification storms from starving API request handling. |
| Epic AC says `pg-boss job (send-email)` | The correct job name is **`notification:email`** (architecture.md `pg-boss Job Naming` section). The epic's "send-email" is descriptive, not canonical. | Architecture naming takes precedence over epic prose. |
| Epic says "retried up to 3 times with exponential backoff" | Use pg-boss native retry: `{ retryLimit: 3, retryBackoff: true, retryDelay: 60 }`. The `notification_queue.attemptCount` column tracks actual attempt count updated by the worker on each run. | pg-boss v12's native retry is simpler and more reliable than implementing retry logic inside the worker handler. |
| Architecture says "Email: nodemailer + SMTP" | Add `nodemailer` v6 as a production dependency to `apps/api`. It is not yet in `package.json`. | First use of nodemailer in the codebase. |
| Epic says SMTP configured via "env vars" + "system settings, Epic 9" | For this story: **env vars only** (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE`). Epic 9 adds admin UI for SMTP but the env var configuration must remain the fallback for self-hosted operators who prefer it. | Epic 9's admin UI will read from a `system_settings` table; this story's transport factory must check env vars first so the v1 deployment model (env-var config) works without Epic 9. |
| `security_alerts.status` has CHECK constraint: `PENDING_DELIVERY \| delivered \| dismissed` | When the dispatcher enqueues a notification, set `security_alerts.status = 'delivered'` immediately (meaning: "enqueued for delivery, not dropped"). The queue table (`notification_queue.status`) separately tracks whether the email was actually sent. | Having two status fields with different semantics (enqueue status vs send status) keeps the security alert lifecycle clean. `PENDING_DELIVERY` only appears on pre-Epic-3 rows. |

---

## AC Quick Reference

| Area | Required result |
|---|---|
| DB schema | `notification_queue` table, org-scoped with RLS in migration `00XX_notification_queue.sql` (next free number). |
| Dispatcher | `notifications/dispatcher.ts` — creates `notification_queue` rows for org owner+admin members (email) and org-level (slack), sends pg-boss jobs immediately via `boss.send()`. |
| Email worker | `workers/notification-email.ts` — handles `notification:email` jobs; sends via nodemailer SMTP; marks queue entry `delivered` on success; pg-boss native retry (3×, exponential); marks `failed` after exhaustion. |
| Slack worker | `workers/notification-slack.ts` — handles `notification:slack` jobs; HTTP POST to `SLACK_WEBHOOK_URL`; same retry policy. |
| Backfill | `workers/notification-backfill.ts` — one-time startup job (`notification:backfill-pending-delivery`); drains all `security_alerts WHERE status = 'PENDING_DELIVERY'`; creates queue entries; marks alerts `delivered`. |
| check-failed-auth-threshold update | Modify `workers/check-failed-auth-threshold.ts` to call `enqueueSecurityAlert()` (from dispatcher) in the same transaction instead of writing `PENDING_DELIVERY` status. Remove the `alert.pending_epic3` log line. |
| Admin test endpoint | `POST /api/v1/admin/notifications/test` (owner + admin only, rate-limited 10/hour) → `{ email: "delivered"\|"failed"\|"not_configured", slack: "delivered"\|"failed"\|"not_configured" }`. |
| Templates | `notifications/templates/security-failed-auth-threshold.ts` — plain-text-first + HTML alt; subject, text, html exports. |
| env.ts additions | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` (all optional, enabling/disabling email); `SLACK_WEBHOOK_URL` (optional, enabling/disabling Slack). |
| Main.ts | Register `notification:email`, `notification:slack`, `notification:backfill-pending-delivery` workers; schedule backfill as one-time job on vault-unseal; add email + Slack schedules. |
| Route audit | Add `POST /api/v1/admin/notifications/test` to `ROUTE_ACTION_CLASSIFICATIONS`; add worker paths to `DIRECT_DB_ACCESS_CLASSIFICATIONS`. |
| Worker registration test | Add `worker-registration.test.ts` assertions for `notification:email` and `notification:slack`. |
| Integration tests | Email (mock transport), Slack (mock HTTP), retry on failure, `not_configured` when SMTP absent, PENDING_DELIVERY backfill, cross-org RLS isolation. |

---

## AC-1: Database Schema — `notification_queue` Table

**Given** the Drizzle schema conventions in `packages/db/src/schema/`,
**When** Story 3.1 adds the `notification_queue` table,
**Then** create `packages/db/src/schema/notification-queue.ts` exactly as follows:

```typescript
import { pgTable, uuid, text, timestamp, integer, jsonb, check, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const notificationQueue = pgTable(
  'notification_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    // null for org-wide channels (slack); set for per-user channels (email)
    recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),  // 'email' | 'slack' | 'inbox'
    templateId: text('template_id').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCheck: check(
      'notification_queue_channel_check',
      sql`${t.channel} IN ('email','slack','inbox')`
    ),
    statusCheck: check(
      'notification_queue_status_check',
      sql`${t.status} IN ('pending','delivered','failed','suppressed')`
    ),
    // Partial index for pending dispatch: only undelivered rows need fast lookup
    pendingIdx: index('idx_notification_queue_pending')
      .on(t.orgId, t.status)
      .where(sql`${t.status} = 'pending'`),
    createdAtIdx: index('idx_notification_queue_created_at').on(t.createdAt),
  })
)
```

**And** export it from `packages/db/src/schema/index.ts`:
```typescript
export { notificationQueue } from './notification-queue.js'
```

**And** the `check-rls-coverage.ts` script automatically validates that `notification_queue` has RLS. Since it is `orgScoped({ onDelete: 'cascade' })`, the migration MUST include the RLS policy (see AC-2).

**Why `orgScoped({ onDelete: 'cascade' })`:** When an organization is deleted, all notification queue entries are deleted with it (consistent with `credentials`, `projects`, etc.). `recipientUserId` cascades on user deletion — the notification is suppressed.

---

## AC-2: Migration

**Given** the current migration journal (`packages/db/src/migrations/meta/_journal.json`),
**When** Story 3.1 creates the notification queue migration,
**Then** create `packages/db/src/migrations/00XX_notification_queue.sql` where `XX` is the next free index (verify the journal — do NOT hardcode):

```sql
-- Migration: 00XX_notification_queue
-- Created: Story 3.1

CREATE TABLE "notification_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "recipient_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "template_id" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_attempt_at" timestamptz,
  "delivered_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "notification_queue" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_queue_org_isolation"
ON "notification_queue"
USING (org_id = current_setting('app.current_org_id')::uuid);

CONSTRAINT "notification_queue_channel_check"
  CHECK (channel IN ('email','slack','inbox'));

CONSTRAINT "notification_queue_status_check"
  CHECK (status IN ('pending','delivered','failed','suppressed'));

CREATE INDEX "idx_notification_queue_pending"
  ON "notification_queue" (org_id, status)
  WHERE status = 'pending';

CREATE INDEX "idx_notification_queue_created_at"
  ON "notification_queue" (created_at);
```

**And** update `packages/db/src/migrations/meta/_journal.json` with the new entry:
```json
{
  "idx": <next_free_idx>,
  "version": "7",
  "when": <timestamp_ms>,
  "tag": "00XX_notification_queue",
  "breakpoints": true
}
```

**Migration ordering gate**: This table has a FK on `organizations` and `users` (both exist since Story 1.4). There is no FK on `projects` or `credentials`, so this migration has no dependency on Epic 2 migrations. It can be applied any time after Story 1.4.

---

## AC-3: Notification Dispatcher

**Given** the need to create queue entries and send pg-boss jobs atomically,
**When** any part of the system wants to dispatch a notification for an org,
**Then** create `apps/api/src/notifications/dispatcher.ts`:

```typescript
import { eq, and } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { notificationQueue, orgMemberships, users } from '@project-vault/db/schema'
import type BossService from '../lib/boss.js'

export type NotificationTemplate = {
  templateId: string
  payload: Record<string, unknown>
}

type DispatchOptions = {
  orgId: string
  template: NotificationTemplate
  tx: Tx  // caller provides the transaction (AC-3-NOTE-1)
  boss: BossService
}

// AC-3-NOTE-1: The caller provides the open transaction so queue-entry creation
// is atomic with the originating event (e.g., security_alerts insert).
// If the transaction rolls back, no notification is enqueued.
export async function dispatchOrgAdminNotification(options: DispatchOptions): Promise<void> {
  const { orgId, template, tx, boss } = options

  // 1. Resolve recipient users: active owner + admin members only.
  // Security alerts are admin/owner concern — viewers should not receive them.
  // Story 3.2 will replace this with full preference resolution (alert type, severity threshold,
  // per-channel opt-out). The role filter is NOT deferred — it is correct from day one.
  const recipients = await tx
    .select({ userId: orgMemberships.userId, email: users.email })
    .from(orgMemberships)
    .innerJoin(users, eq(orgMemberships.userId, users.id))
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.status, 'active'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (orgMemberships as any).role.in(['owner', 'admin'])
        // Note: use Drizzle's inArray() or eq() with OR depending on Drizzle version:
        // inArray(orgMemberships.role, ['owner', 'admin'])
      )
    )

  // 2. Enqueue one email entry per recipient
  const emailEntries = await tx
    .insert(notificationQueue)
    .values(
      recipients.map((r) => ({
        orgId,
        recipientUserId: r.userId,
        channel: 'email' as const,
        templateId: template.templateId,
        payload: template.payload,
        status: 'pending' as const,
      }))
    )
    .returning({ id: notificationQueue.id })

  // 3. Enqueue one Slack entry per org (not per user — Slack is org-level webhook)
  const [slackEntry] = await tx
    .insert(notificationQueue)
    .values({
      orgId,
      recipientUserId: null,
      channel: 'slack' as const,
      templateId: template.templateId,
      payload: template.payload,
      status: 'pending' as const,
    })
    .returning({ id: notificationQueue.id })

  // 4. Send pg-boss jobs AFTER the transaction commits (boss.send is idempotent on failure)
  // Note: pg-boss send() is called outside the tx to avoid deadlock. If the tx commits
  // but boss.send() fails, the pending rows will be picked up by the polling catchup schedule
  // (see AC-9: 'notification:email-catchup' cron every 10 minutes scans pending entries
  // older than 5 minutes). This is the outbox pattern — the queue table is the durable store.
  for (const entry of emailEntries) {
    if (entry.id) {
      await boss.send('notification:email', { notificationQueueId: entry.id }, {
        retryLimit: 3,
        retryBackoff: true,
        retryDelay: 60,  // 1 minute initial delay, doubles on each retry
      })
    }
  }
  if (slackEntry?.id) {
    await boss.send('notification:slack', { notificationQueueId: slackEntry.id }, {
      retryLimit: 3,
      retryBackoff: true,
      retryDelay: 60,
    })
  }
}
```

**And** export a standalone `enqueueSecurityAlert()` helper used by `check-failed-auth-threshold.ts` (AC-7):
```typescript
// Thin wrapper for security alert dispatching (called within an existing withOrg transaction)
export async function enqueueSecurityAlertNotification(opts: {
  orgId: string
  templateId: string
  payload: Record<string, unknown>
  tx: Tx
  boss: BossService
}): Promise<void> {
  await dispatchOrgAdminNotification({
    orgId: opts.orgId,
    template: { templateId: opts.templateId, payload: opts.payload },
    tx: opts.tx,
    boss: opts.boss,
  })
}
```

**Cross-story note (Story 3.2)**: When Story 3.2 is implemented, `dispatchOrgAdminNotification()` will be refactored to: (a) accept an `alertType` parameter, (b) query the `notification_preferences` table to determine channels and recipients per user, and (c) respect per-alert-type routing rules. The worker files themselves do not change — only the dispatcher logic changes.

---

## AC-4: Email Worker

**Given** a `notification:email` pg-boss job payload `{ notificationQueueId: string }`,
**When** the worker runs,
**Then** create `apps/api/src/workers/notification-email.ts`:

```typescript
import nodemailer from 'nodemailer'
import { getDb, withOrg } from '@project-vault/db'
import { notificationQueue, users } from '@project-vault/db/schema'
import { eq, and } from 'drizzle-orm'
import { env } from '../config/env.js'
import { renderEmailTemplate } from '../notifications/templates/index.js'
import { withJobLogging } from '../lib/job-logging.js'
import type { FastifyBaseLogger } from 'fastify'

// Note: getDb() is imported at the module level (static import).
// Dynamic imports (`await import(...)`) are an anti-pattern in ESM workers — avoid them.

// Lazy singleton transport — created once on first use.
// Returns null when SMTP is not configured (AC-10: SMTP is optional).
let _transport: ReturnType<typeof nodemailer.createTransport> | null = null

export function getEmailTransport(): ReturnType<typeof nodemailer.createTransport> | null {
  if (!env.SMTP_HOST) return null
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_SECURE ?? false,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  }
  return _transport
}

// Exported for test injection — allows tests to replace the transport without
// mocking the module (AC-13 uses nodemailer.createTransport with jsonTransport).
export function setEmailTransportForTesting(
  t: ReturnType<typeof nodemailer.createTransport>
): void {
  _transport = t
}

export async function sendEmailNotification(notificationQueueId: string): Promise<void> {
  const transport = getEmailTransport()

  // Determine the org_id of the queue entry to use withOrg()
  // We need a cross-org lookup here (the worker doesn't know the org_id from job payload).
  // Use getDb() for this lookup (static import, not dynamic), then use withOrg() for writes.
  // This pattern matches check-failed-auth-threshold.ts and is classified in DIRECT_DB_ACCESS.
  type QueueRow = { id: string; orgId: string; recipientUserId: string | null; templateId: string; payload: Record<string, unknown>; status: string; attemptCount: number }
  const rows = await getDb().execute<QueueRow>(
    `SELECT id, org_id, recipient_user_id, template_id, payload, status
     FROM notification_queue WHERE id = $1 LIMIT 1`,
    [notificationQueueId]
  )
  const entry = rows[0]
  if (!entry) {
    // Job was enqueued but queue entry was deleted (e.g., org deleted). Safe to ignore.
    return
  }
  if (entry.status !== 'pending') {
    // Already delivered or suppressed by a concurrent worker. Idempotent exit.
    return
  }

  await withOrg(entry.orgId, async (tx) => {
    // Increment attempt count
    await tx
      .update(notificationQueue)
      .set({ attemptCount: entry.attemptCount + 1, lastAttemptAt: new Date() })
      .where(and(eq(notificationQueue.id, notificationQueueId), eq(notificationQueue.status, 'pending')))

    if (!transport) {
      // SMTP not configured — suppress silently, mark suppressed so retries don't pile up
      await tx
        .update(notificationQueue)
        .set({ status: 'suppressed' })
        .where(eq(notificationQueue.id, notificationQueueId))
      return
    }

    // Fetch recipient email if this is a per-user notification
    let toAddress: string | null = null
    if (entry.recipientUserId) {
      const [user] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, entry.recipientUserId))
        .limit(1)
      toAddress = user?.email ?? null
    }
    if (!toAddress) {
      // Recipient deleted or not found — suppress
      await tx
        .update(notificationQueue)
        .set({ status: 'suppressed' })
        .where(eq(notificationQueue.id, notificationQueueId))
      return
    }

    const { subject, text, html } = renderEmailTemplate(entry.templateId, entry.payload)

    // Send email (throws on SMTP error — pg-boss will retry per retryLimit)
    await transport.sendMail({
      from: env.SMTP_FROM,
      to: toAddress,
      subject,
      text,
      html,
    })

    await tx
      .update(notificationQueue)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(notificationQueue.id, notificationQueueId))
  })
}

export async function notificationEmailHandler(
  job: { id?: string; data: { notificationQueueId: string } },
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await withJobLogging(
    logger,
    'notification:email',
    job.id ?? 'unknown',
    () => sendEmailNotification(job.data.notificationQueueId)
  )
}
```

**Worker registration** in `main.ts` (see AC-9) uses:
```typescript
boss.work('notification:email', { teamSize: 5, teamConcurrency: 3 },
  (job) => notificationEmailHandler(job, fastify.log))
```

**Error handling contract**:
- SMTP connection failure (ECONNREFUSED, ETIMEDOUT): throw → pg-boss retries (up to 3×, exponential 60s/120s/240s)
- Recipient not found (user deleted between enqueue and send): suppress, do NOT throw
- `SMTP not configured`: suppress, do NOT throw
- After 3 pg-boss retries exhausted: pg-boss moves job to DLQ → worker marks entry `failed` on the final attempt (via `onComplete` handler, or a separate cleanup job; see AC-9)

**Note on `getDb()` direct access**: The worker needs the `org_id` from the queue entry ID to call `withOrg()`. This cross-org lookup requires `getDb()`. This pattern is identical to `check-failed-auth-threshold.ts` and is classified in `DIRECT_DB_ACCESS_CLASSIFICATIONS` (see AC-12).

---

## AC-5: Slack Worker

**Given** a `notification:slack` pg-boss job payload `{ notificationQueueId: string }`,
**When** the worker runs,
**Then** create `apps/api/src/workers/notification-slack.ts`:

```typescript
import { getDb, withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { eq, and } from 'drizzle-orm'
import { env } from '../config/env.js'
import { renderSlackTemplate } from '../notifications/templates/index.js'
import { withJobLogging } from '../lib/job-logging.js'
import type { FastifyBaseLogger } from 'fastify'

type QueueRow = { id: string; orgId: string; templateId: string; payload: Record<string, unknown>; status: string; attemptCount: number }

export async function sendSlackNotification(notificationQueueId: string): Promise<void> {
  const webhookUrl = env.SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    // Slack not configured — suppress (same pattern as SMTP not configured)
    // Use getDb() for the org lookup, then withOrg() for the update
    const rows = await getDb().execute<{ orgId: string }>(
      `SELECT org_id FROM notification_queue WHERE id = $1 LIMIT 1`,
      [notificationQueueId]
    )
    const orgId = rows[0]?.orgId
    if (orgId) {
      await withOrg(orgId, async (tx) => {
        await tx
          .update(notificationQueue)
          .set({ status: 'suppressed' })
          .where(eq(notificationQueue.id, notificationQueueId))
      })
    }
    return
  }

  const rows = await getDb().execute<QueueRow>(
    `SELECT id, org_id, template_id, payload, status, attempt_count
     FROM notification_queue WHERE id = $1 LIMIT 1`,
    [notificationQueueId]
  )
  const entry = rows[0]
  if (!entry || entry.status !== 'pending') return

  await withOrg(entry.orgId, async (tx) => {
    await tx
      .update(notificationQueue)
      .set({ attemptCount: entry.attemptCount + 1, lastAttemptAt: new Date() })
      .where(and(eq(notificationQueue.id, notificationQueueId), eq(notificationQueue.status, 'pending')))

    const { text, blocks } = renderSlackTemplate(entry.templateId, entry.payload)

    // HTTP POST to Slack Incoming Webhook (throws on non-2xx → pg-boss retries)
    // SECURITY: Never log the webhook URL — it's a secret token. Log only status codes.
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
    })

    if (!response.ok) {
      // Do NOT include webhookUrl in the error message — log only the status code
      throw new Error(`Slack webhook returned ${response.status}`)
    }

    await tx
      .update(notificationQueue)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(notificationQueue.id, notificationQueueId))
  })
}

export async function notificationSlackHandler(
  job: { id?: string; data: { notificationQueueId: string } },
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await withJobLogging(
    logger,
    'notification:slack',
    job.id ?? 'unknown',
    () => sendSlackNotification(job.data.notificationQueueId)
  )
}
```

**Slack payload shape** (Block Kit format for rich messages):
```json
{
  "text": "[Project Vault] Security Alert: Failed authentication threshold exceeded",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "🔴 Security Alert" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Failed authentication threshold exceeded*\n10 failed attempts from IP 192.168.1.100 in the past 5 minutes."
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Project Vault · <https://vault.example.com/org/security-alerts|View alerts>" }
      ]
    }
  ]
}
```

**Slack rate limiting**: Slack Incoming Webhooks are rate-limited to 1 request per second per webhook. With `teamConcurrency: 3` and a typical low-volume deployment, this is not a concern. If rate-limit errors (HTTP 429) are encountered in a future high-volume deployment, add `retryDelay: 1500` to the pg-boss send options.

---

## AC-6: Notification Templates

**Given** the requirement for plain-text-first email with HTML alt and Slack Block Kit messages,
**When** Story 3.1 creates templates,
**Then** create `apps/api/src/notifications/templates/index.ts`:

```typescript
import { renderSecurityFailedAuthThreshold } from './security-failed-auth-threshold.js'

export type EmailRender = { subject: string; text: string; html: string }
export type SlackRender = { text: string; blocks: unknown[] }

const EMAIL_RENDERERS: Record<string, (payload: Record<string, unknown>) => EmailRender> = {
  'security.failed_auth_threshold': renderSecurityFailedAuthThreshold,
}

const SLACK_RENDERERS: Record<string, (payload: Record<string, unknown>) => SlackRender> = {
  'security.failed_auth_threshold': renderSecurityFailedAuthThresholdSlack,
}

// Import the Slack renderer too
import { renderSecurityFailedAuthThresholdSlack } from './security-failed-auth-threshold.js'

export function renderEmailTemplate(templateId: string, payload: Record<string, unknown>): EmailRender {
  const renderer = EMAIL_RENDERERS[templateId]
  if (!renderer) {
    // Fallback for unknown templates — prevents delivery failure on future alert types
    // before their templates are registered.
    return {
      subject: `[Project Vault] Notification (${templateId})`,
      text: `A vault notification was triggered. Template: ${templateId}.\nPayload: ${JSON.stringify(payload, null, 2)}`,
      html: `<p>A vault notification was triggered.</p><pre>${JSON.stringify(payload, null, 2)}</pre>`,
    }
  }
  return renderer(payload)
}

export function renderSlackTemplate(templateId: string, payload: Record<string, unknown>): SlackRender {
  const renderer = SLACK_RENDERERS[templateId]
  if (!renderer) {
    return {
      text: `[Project Vault] Notification: ${templateId}`,
      blocks: [],
    }
  }
  return renderer(payload)
}
```

**And** create `apps/api/src/notifications/templates/security-failed-auth-threshold.ts`:

```typescript
// Template for security.failed_auth_threshold alert
// Covers FR73 delivery — the first alert type in Project Vault.

export type FailedAuthThresholdPayload = {
  thresholdType: 'ip' | 'account'
  thresholdCount: number
  windowSeconds: number
  attemptCount: number
  windowStart: string  // ISO 8601
  windowEnd: string    // ISO 8601
  ipAddress?: string
  userId?: string
}

export function renderSecurityFailedAuthThreshold(
  raw: Record<string, unknown>
): { subject: string; text: string; html: string } {
  const p = raw as FailedAuthThresholdPayload
  const who = p.thresholdType === 'ip'
    ? `IP address ${p.ipAddress ?? 'unknown'}`
    : `user account ${p.userId ?? 'unknown'}`
  const window = Math.round(p.windowSeconds / 60)

  const subject = `[Project Vault] Security Alert: Failed login threshold exceeded`

  const text = [
    `Security Alert — Project Vault`,
    ``,
    `Failed authentication threshold exceeded.`,
    ``,
    `  Source: ${who}`,
    `  Attempts: ${p.attemptCount} in ${window} minutes`,
    `  Window: ${p.windowStart} — ${p.windowEnd}`,
    ``,
    `Review the security alerts dashboard to investigate and dismiss this alert.`,
    ``,
    `This is an automated message from Project Vault.`,
  ].join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Security Alert</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2 style="color:#dc2626;">⚠️ Security Alert</h2>
  <p>Failed authentication threshold exceeded.</p>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">Source</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(who)}</td></tr>
    <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">Attempts</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${p.attemptCount} in ${window} minutes</td></tr>
    <tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">Window</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(p.windowStart)} — ${escapeHtml(p.windowEnd)}</td></tr>
  </table>
  <p>Review the <a href="#">security alerts dashboard</a> to investigate and dismiss this alert.</p>
  <hr><p style="color:#6b7280;font-size:12px;">This is an automated message from Project Vault.</p>
</body>
</html>`

  return { subject, text, html }
}

export function renderSecurityFailedAuthThresholdSlack(
  raw: Record<string, unknown>
): { text: string; blocks: unknown[] } {
  const p = raw as FailedAuthThresholdPayload
  const who = p.thresholdType === 'ip'
    ? `IP \`${p.ipAddress ?? 'unknown'}\``
    : `user \`${p.userId ?? 'unknown'}\``
  const window = Math.round(p.windowSeconds / 60)

  return {
    text: `[Project Vault] Security Alert: Failed login threshold exceeded`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔴 Security Alert — Project Vault', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Failed authentication threshold exceeded*\n${p.attemptCount} attempts from ${who} in the past ${window} minutes.`,
        },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Window: ${p.windowStart} — ${p.windowEnd}` },
        ],
      },
    ],
  }
}

// SECURITY: HTML template values are escaped to prevent XSS via payload data.
// Never use {@html} or innerHTML with unescaped payload content.
// INVARIANT: Every new template added to this directory MUST escape all payload values
// using escapeHtml() before interpolating into HTML. This is enforced by code review —
// there is no automated lint rule for template functions, so the reviewer must check each
// new template function manually.
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
```

**Template conventions for future stories**:
- Each alert type gets its own template file: `apps/api/src/notifications/templates/<alert-type>.ts`
- File exports: `render<AlertType>()` (email) and `render<AlertType>Slack()` (Slack)
- Register both in `templates/index.ts`'s `EMAIL_RENDERERS` and `SLACK_RENDERERS`
- Plain-text is authoritative; HTML mirrors it
- Never embed secrets, user passwords, or raw credential values in template payloads

---

## AC-7: PENDING_DELIVERY Backfill Worker

**Given** the existence of `security_alerts` rows with `status = 'PENDING_DELIVERY'` created before Story 3.1 was deployed,
**When** the vault unseals for the first time after Story 3.1 is deployed,
**Then** create `apps/api/src/workers/notification-backfill.ts`:

```typescript
import { getDb, withOrg } from '@project-vault/db'
import { securityAlerts } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import { fetchAllOrgIds } from '../middleware/rls.js'
import { dispatchOrgAdminNotification } from '../notifications/dispatcher.js'
import type BossService from '../lib/boss.js'
import type { FastifyBaseLogger } from 'fastify'

type AlertRow = {
  id: string
  orgId: string
  alertType: string
  payload: Record<string, unknown>
}

export async function runNotificationBackfill(boss: BossService, logger: FastifyBaseLogger): Promise<void> {
  // Step 1: Fetch all org IDs (platform-level scan)
  const orgIds = await fetchAllOrgIds()
  let totalProcessed = 0

  for (const orgId of orgIds) {
    // Step 2: Find PENDING_DELIVERY alerts for this org
    const pendingAlerts = await withOrg(orgId, async (tx) => {
      return tx.execute<AlertRow>(
        `SELECT id, org_id, alert_type, payload
         FROM security_alerts
         WHERE org_id = $1 AND status = 'PENDING_DELIVERY'
         ORDER BY created_at ASC`,
        [orgId]
      )
    })

    for (const alert of pendingAlerts) {
      try {
        await withOrg(orgId, async (tx) => {
          // Enqueue notification for this alert
          await dispatchOrgAdminNotification({
            orgId,
            template: {
              templateId: alert.alertType,
              payload: alert.payload,
            },
            tx,
            boss,
          })

          // Mark the security alert as delivered (meaning: enqueued, not dropped)
          await tx
            .update(securityAlerts)
            .set({ status: 'delivered' })
            .where(eq(securityAlerts.id, alert.id))
        })
        totalProcessed++
      } catch (err) {
        logger.error({
          eventType: 'notification.backfill.error',
          alertId: alert.id,
          orgId,
          err,
        }, 'Failed to backfill PENDING_DELIVERY alert')
        // Continue processing other alerts — one failure should not block the rest
      }
    }
  }

  if (totalProcessed > 0) {
    logger.info({
      eventType: 'notification.backfill.completed',
      totalProcessed,
    }, `Backfill processed ${totalProcessed} PENDING_DELIVERY alerts`)
  }
}

export async function notificationBackfillHandler(
  boss: BossService,
  logger: FastifyBaseLogger
): Promise<void> {
  try {
    await runNotificationBackfill(boss, logger)
  } catch (err) {
    logger.error({
      eventType: 'notification.backfill.failed',
      err,
    }, 'Notification backfill job failed')
    throw err
  }
}
```

**Triggering mechanism**: The backfill job is sent once at vault-unseal time (see AC-9). Unlike other singleton jobs, **do NOT use `singletonKey`** — if the backfill fails midway (partial run), the next vault unseal must be able to re-queue it to process remaining `PENDING_DELIVERY` rows. The idempotency guarantee comes from the `status = 'PENDING_DELIVERY'` filter: already-processed alerts have `status = 'delivered'` and are skipped.

```typescript
// In startBossAndRegisterWorkers() in main.ts:
// No singletonKey — idempotency relies on the PENDING_DELIVERY status filter
await boss.send('notification:backfill-pending-delivery', {})
```

**Idempotency guarantee**: The backfill checks `status = 'PENDING_DELIVERY'` on each alert. If the job runs twice (e.g., concurrent unseal on restart), the second run finds no `PENDING_DELIVERY` rows and is a no-op.

---

## AC-8: Update `check-failed-auth-threshold.ts`

**Given** the Story 1.9 implementation writes `security_alerts` with `status = 'PENDING_DELIVERY'`,
**When** Story 3.1 establishes the notification infrastructure,
**Then** modify `apps/api/src/workers/check-failed-auth-threshold.ts` to directly enqueue notifications:

**Changes required**:

1. **Import the dispatcher** and thread `boss` through the call chain:
```typescript
import { enqueueSecurityAlertNotification } from '../notifications/dispatcher.js'
```

2. **Thread `boss: BossService` parameter** to `createAlertIfNeeded()` and `checkFailedAuthThresholdHandler()`:
```typescript
async function createAlertIfNeeded(
  breach: Breach,
  windowStart: Date,
  windowEnd: Date,
  boss: BossService  // ADD THIS
): Promise<void> {
  await runOrgScopedJob(breach.orgId, 'security:check-failed-auth-threshold', async ({ tx }) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${dedupLockKey(breach)}))`)
    if (await existingAlert(tx, breach, windowStart)) return
    const payload = failedAuthThresholdPayloadSchema.parse(payloadFor(breach, windowStart, windowEnd))

    const [alert] = await tx
      .insert(securityAlerts)
      .values({
        orgId: breach.orgId,
        alertType: ALERT_TYPE,
        severity: 'critical',
        status: 'delivered',  // CHANGE: was 'PENDING_DELIVERY', now immediately 'delivered' (meaning enqueued)
        payload,
      })
      .returning({ id: securityAlerts.id })
    if (!alert) return

    await insertAuditRow(tx, breach.orgId, alert.id, payload)

    // CHANGE: directly enqueue notification instead of logging alert.pending_epic3
    await enqueueSecurityAlertNotification({
      orgId: breach.orgId,
      templateId: ALERT_TYPE,
      payload,
      tx,
      boss,
    })

    process.stdout.write(
      `${JSON.stringify({ eventType: 'security.failed_auth_threshold.notification_enqueued', alertType: ALERT_TYPE, orgId: breach.orgId, thresholdType: breach.thresholdType })}\n`
    )
  })
}
```

3. **Thread `boss` through** `runFailedAuthThresholdCheck()` and `checkFailedAuthThresholdHandler()`:
```typescript
export async function runFailedAuthThresholdCheck(boss: BossService): Promise<void> { ... }
export async function checkFailedAuthThresholdHandler(boss: BossService): Promise<void> { ... }
```

4. **Update `main.ts` registration** to pass `boss` to the handler:
```typescript
'security:check-failed-auth-threshold': () => checkFailedAuthThresholdHandler(boss),
```

**Test coverage**: The existing Story 1.9 tests for `check-failed-auth-threshold.ts` must be updated to:
- Mock the dispatcher and verify `enqueueSecurityAlertNotification` is called
- Verify `security_alerts.status = 'delivered'` (not `PENDING_DELIVERY`) after the job runs
- Remove the `alert.pending_epic3` log assertion

---

## AC-9: Worker Registration in `main.ts`

**Given** the pg-boss worker registration pattern established in Stories 1.10 and 2.2,
**When** Story 3.1 adds notification workers,
**Then** modify `apps/api/src/main.ts`:

**Additions to `registerSchedules()`**:
```typescript
// Polling catchup schedules — catch any pending notification queue entries that were
// created when boss.send() failed after the transaction committed (outbox pattern).
// These are defense-in-depth; primary dispatch still uses boss.send() for low latency.
'notification:email-catchup': { cron: '*/10 * * * *' },  // every 10 min
'notification:slack-catchup': { cron: '*/10 * * * *' },
```

The catchup workers scan `notification_queue WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'` and re-send `notification:email` / `notification:slack` jobs for entries that are stale. This ensures that boss.send() failures during high-load events do not permanently suppress notifications.

Add two lightweight catchup handlers in `workers/notification-email.ts` and `workers/notification-slack.ts`:
```typescript
export async function notificationEmailCatchupHandler(logger: FastifyBaseLogger): Promise<void> {
  // Fetch stale pending email entries (older than 5 min) across all orgs
  const staleEntries = await getDb().execute<{ id: string }>(
    `SELECT id FROM notification_queue
     WHERE channel = 'email' AND status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'
     LIMIT 100`
  )
  for (const entry of staleEntries) {
    await boss.send('notification:email', { notificationQueueId: entry.id }, { retryLimit: 3, retryBackoff: true, retryDelay: 60 })
  }
  if (staleEntries.length > 0) {
    logger.warn({ eventType: 'notification.catchup.entries_found', count: staleEntries.length }, 'Notification catchup found stale pending entries')
  }
}
```

**Additions to `registerWorkers()`**:
```typescript
'notification:email': (job) =>
  notificationEmailHandler(job, fastify.log),
'notification:slack': (job) =>
  notificationSlackHandler(job, fastify.log),
'notification:backfill-pending-delivery': () =>
  notificationBackfillHandler(boss, fastify.log),
```

**pg-boss concurrency override** for notification workers:
```typescript
// In registerWorkers(), pg-boss v12 work() accepts options as 3rd arg to boss.work()
// The concurrency is set at the boss.work() registration level, not registerWorkers().
// Modify boss.ts registerWorkers() to accept per-worker options, OR call boss.work() directly.
// See CRITICAL note below.
```

**CRITICAL — concurrency configuration**: The architecture requires `notification:* → teamSize: 5, teamConcurrency: 3`. In pg-boss v12, these are set via `boss.work(jobName, { teamSize, teamConcurrency }, handler)`. The current `registerWorkers()` API in `lib/boss.ts` does not pass these options. **Story 3.1 must extend `BossService.registerWorkers()` to accept per-job concurrency options**, or call `boss.work()` directly for notification workers.

Extend `lib/boss.ts`:
```typescript
type WorkerOptions = { teamSize?: number; teamConcurrency?: number }

async registerWorkers(
  handlers: Record<string, { handler: (job: BossJob) => Promise<void>; options?: WorkerOptions }>
): Promise<void>
```

Or, simpler: add a separate `registerWorker()` method (singular) that takes options:
```typescript
async registerWorker(
  name: string,
  handler: (job: BossJob) => Promise<void>,
  options?: WorkerOptions
): Promise<void>
```

**Backfill startup trigger** (after workers are registered):
```typescript
// At the end of startBossAndRegisterWorkers(), after all workers are registered.
// No singletonKey — idempotency relies on PENDING_DELIVERY status filter (ADR-3.1-07).
// This job is a no-op once all historical PENDING_DELIVERY rows are processed.
await boss.send('notification:backfill-pending-delivery', {})
```

**Additions to imports in `main.ts`**:
```typescript
import { notificationEmailHandler } from './workers/notification-email.js'
import { notificationSlackHandler } from './workers/notification-slack.js'
import { notificationBackfillHandler } from './workers/notification-backfill.js'
```

---

## AC-10: Environment Variables

**Given** the `apps/api/src/config/env.ts` Zod schema,
**When** Story 3.1 adds notification config,
**Then** add the following to the `envSchema` object in `env.ts`:

```typescript
// Email (SMTP) — all optional; absence means email notifications are suppressed (not_configured)
SMTP_HOST: z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional()
),
SMTP_PORT: z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.coerce.number().int().min(1).max(65535).optional()
),
SMTP_SECURE: z.preprocess(
  (v) => (v === '' ? undefined : String(false)),
  z.enum(['true', 'false']).transform((v) => v === 'true').optional()
),
SMTP_USER: z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().optional()
),
SMTP_PASS: z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().optional()
),
SMTP_FROM: z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().email('SMTP_FROM must be a valid email address').optional()
),

// Slack — optional; absence means Slack notifications are suppressed (not_configured)
SLACK_WEBHOOK_URL: z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().url('SLACK_WEBHOOK_URL must be a valid URL').optional()
),
```

**Validation rule**: If `SMTP_HOST` is set, then `SMTP_FROM` must also be set. Add a `superRefine` check:
```typescript
if (env.SMTP_HOST && !env.SMTP_FROM) {
  ctx.addIssue({ code: 'custom', path: ['SMTP_FROM'], message: 'SMTP_FROM is required when SMTP_HOST is set' })
}
```

**`.env.example` additions**:
```dotenv
# Email notifications (optional; omit to disable)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=notifications@example.com
SMTP_PASS=your_smtp_password_here
SMTP_FROM=notifications@example.com

# Slack notifications (optional; omit to disable)
SLACK_WEBHOOK_URL=your-slack-webhook-url
```

---

## AC-11: Admin Module & Test Endpoint

**Given** the admin module defined in the architecture at `apps/api/src/modules/admin/`,
**When** Story 3.1 creates it for the first time,
**Then** create `apps/api/src/modules/admin/routes.ts`:

```typescript
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute } from '../../lib/secure-route.js'
import { env } from '../../config/env.js'
import { getEmailTransport } from '../../workers/notification-email.js'
import { renderEmailTemplate, renderSlackTemplate } from '../../notifications/templates/index.js'

const TEST_TEMPLATE_ID = 'security.failed_auth_threshold'
const TEST_PAYLOAD = {
  thresholdType: 'ip',
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 10,
  windowStart: new Date(Date.now() - 300_000).toISOString(),
  windowEnd: new Date().toISOString(),
  ipAddress: '203.0.113.1',  // RFC 5737 documentation address — safe for test emails
}

export async function adminRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/notifications/test',
    security: {
      allowedRoles: ['owner', 'admin'],
      requireMfa: true,
      rateLimit: { max: 10, key: 'POST /admin/notifications/test' },
      writeAuditEvent: false,
    },
    handler: async (_ctx, _req: FastifyRequest, _reply: FastifyReply) => {
      const emailResult = await testEmailDelivery()
      const slackResult = await testSlackDelivery()
      return { email: emailResult, slack: slackResult }
    },
  })
}

async function testEmailDelivery(): Promise<'delivered' | 'failed' | 'not_configured'> {
  const transport = getEmailTransport()
  if (!transport) return 'not_configured'
  try {
    const { subject, text, html } = renderEmailTemplate(TEST_TEMPLATE_ID, TEST_PAYLOAD)
    // 5-second timeout guard: a hanging SMTP server must not block the HTTP response
    const sendPromise = transport.sendMail({
      from: env.SMTP_FROM,
      to: env.SMTP_FROM,  // test sends to the configured "from" address as self-test
      subject: `[TEST] ${subject}`,
      text: `[THIS IS A TEST MESSAGE]\n\n${text}`,
      html: `<p><em>[THIS IS A TEST MESSAGE]</em></p>${html}`,
    })
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SMTP test timed out after 5s')), 5000)
    )
    await Promise.race([sendPromise, timeoutPromise])
    return 'delivered'
  } catch {
    return 'failed'
  }
}

async function testSlackDelivery(): Promise<'delivered' | 'failed' | 'not_configured'> {
  const webhookUrl = env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return 'not_configured'
  try {
    const { text, blocks } = renderSlackTemplate(TEST_TEMPLATE_ID, TEST_PAYLOAD)
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `[TEST] ${text}`, blocks }),
    })
    return response.ok ? 'delivered' : 'failed'
  } catch {
    return 'failed'
  }
}
```

**And** create `apps/api/src/modules/admin/schema.ts` with the response Zod schema:
```typescript
import { z } from 'zod/v4'

export const NotificationChannelResultSchema = z.enum(['delivered', 'failed', 'not_configured'])

export const NotificationTestResponseSchema = z.object({
  email: NotificationChannelResultSchema,
  slack: NotificationChannelResultSchema,
})

export type NotificationTestResponse = z.infer<typeof NotificationTestResponseSchema>
```

The admin test endpoint uses this schema for the response type annotation on `secureRoute`. This ensures the OpenAPI spec (`@fastify/swagger`) generates a correct response schema for the endpoint.
```typescript
import { adminRoutes } from './modules/admin/routes.js'

// After existing route registrations:
await fastify.register(adminRoutes, { prefix: '/api/v1/admin' })
```

**Response examples**:
- All configured and working: `{ "email": "delivered", "slack": "delivered" }`
- SMTP missing: `{ "email": "not_configured", "slack": "delivered" }`
- SMTP wrong credentials: `{ "email": "failed", "slack": "not_configured" }`
- Both missing: `{ "email": "not_configured", "slack": "not_configured" }`

**MFA requirement**: The test endpoint requires MFA verification (`requireMfa: true`) because it transmits a real email/Slack message to configured channels. Sending a test notification is an observable side effect with rate-limit implications.

**Note on `writeAuditEvent: false`**: The test action does not modify vault state or expose secrets; it is an operational verification. The `secureRoute` audit framework already logs admin actions via the `SecureRoute` telemetry. If an explicit audit trail for test notifications is desired, add `auditEvent: 'notification.test_sent'` to `ROUTE_ACTION_CLASSIFICATIONS` and set `writeAuditEvent: true` — this is a judgment call for the implementing developer.

---

## AC-12: Route Audit Classification & Direct DB Access

**Given** the CI gates in `route-audit.test.ts` require all protected routes to be classified,
**When** Story 3.1 adds the admin notification test endpoint and notification workers,
**Then** add to `apps/api/src/lib/route-exemptions.ts`:

**In `ROUTE_ACTION_CLASSIFICATIONS`**:
```typescript
'POST /api/v1/admin/notifications/test': {
  action: 'mutation',
  auditOmissionReason: 'Test notification sends to configured channels; does not mutate vault state or expose secrets. Operational verification only.',
  reviewer: SECURITY_OWNER,
},
```

**In `DIRECT_DB_ACCESS_CLASSIFICATIONS`**:
```typescript
{
  path: 'workers/notification-email.ts',
  classification: PLATFORM_JOB,
  reason: 'Fetches notification_queue entry org_id via getDb() for cross-org job dispatch; uses withOrg() for all writes.',
  reviewer: SECURITY_OWNER,
},
{
  path: 'workers/notification-slack.ts',
  classification: PLATFORM_JOB,
  reason: 'Fetches notification_queue entry org_id via getDb() for cross-org job dispatch; uses withOrg() for all writes.',
  reviewer: SECURITY_OWNER,
},
{
  path: 'workers/notification-backfill.ts',
  classification: PLATFORM_JOB,
  reason: 'One-time backfill job uses fetchAllOrgIds() (getDb()) to scan PENDING_DELIVERY security alerts across all orgs.',
  reviewer: SECURITY_OWNER,
},
```

---

## AC-13: New Dependency — `nodemailer`

**Given** `nodemailer` is not currently in `apps/api/package.json`,
**When** Story 3.1 adds the email worker,
**Then** add the following dependencies:
```bash
pnpm --filter @project-vault/api add nodemailer
pnpm --filter @project-vault/api add -D @types/nodemailer
```

**Confirm version** via `package.json` after install — do not hardcode a version in this story. The current stable release of nodemailer is v6.9.x (June 2026). It uses CommonJS modules but works fine in ESM projects via `import nodemailer from 'nodemailer'` with `moduleResolution: "bundler"` or `"node16"`.

**ESM compatibility note**: If the project uses `"type": "module"` in `apps/api/package.json`, verify that `import nodemailer from 'nodemailer'` works correctly. If not, use `import { createTransport } from 'nodemailer'` or add `"nodemailer": { "default": ... }` to `package.json`'s `imports`. Check at install time.

---

## AC-14: Integration & Unit Tests

**Given** the TDD-first development mandate from `AGENTS.md`,
**When** Story 3.1 implements notification delivery,
**Then** write tests before implementing each component:

### Unit Tests: Email Worker (`workers/notification-email.test.ts`)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import nodemailer from 'nodemailer'
import { setEmailTransportForTesting, sendEmailNotification } from './notification-email.js'

describe('sendEmailNotification', () => {
  it('sends email and marks queue entry delivered on success', async () => {
    // Arrange: use nodemailer's jsonTransport for testing
    const transport = nodemailer.createTransport({ jsonTransport: true })
    setEmailTransportForTesting(transport)
    const queueEntryId = await createTestEmailQueueEntry()  // test helper

    // Act
    await sendEmailNotification(queueEntryId)

    // Assert: status is 'delivered'
    const entry = await getQueueEntry(queueEntryId)
    expect(entry.status).toBe('delivered')
    expect(entry.deliveredAt).not.toBeNull()
    expect(entry.attemptCount).toBe(1)
  })

  it('marks entry suppressed when SMTP is not configured', async () => {
    setEmailTransportForTesting(null as any)  // no transport
    const queueEntryId = await createTestEmailQueueEntry()

    await sendEmailNotification(queueEntryId)

    const entry = await getQueueEntry(queueEntryId)
    expect(entry.status).toBe('suppressed')
  })

  it('marks entry suppressed when recipient user does not exist', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    setEmailTransportForTesting(transport)
    const queueEntryId = await createTestEmailQueueEntry({ recipientUserId: crypto.randomUUID() })

    await sendEmailNotification(queueEntryId)

    const entry = await getQueueEntry(queueEntryId)
    expect(entry.status).toBe('suppressed')
  })

  it('throws and increments attemptCount on SMTP failure (pg-boss will retry)', async () => {
    const failingTransport = nodemailer.createTransport({ streamTransport: true })
    vi.spyOn(failingTransport, 'sendMail').mockRejectedValue(new Error('ECONNREFUSED'))
    setEmailTransportForTesting(failingTransport)
    const queueEntryId = await createTestEmailQueueEntry()

    await expect(sendEmailNotification(queueEntryId)).rejects.toThrow('ECONNREFUSED')

    const entry = await getQueueEntry(queueEntryId)
    expect(entry.status).toBe('pending')  // NOT failed — pg-boss handles retries
    expect(entry.attemptCount).toBe(1)
  })

  it('is idempotent — skips already-delivered entries', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    setEmailTransportForTesting(transport)
    const spy = vi.spyOn(transport, 'sendMail')
    const queueEntryId = await createTestEmailQueueEntry({ status: 'delivered' })

    await sendEmailNotification(queueEntryId)

    expect(spy).not.toHaveBeenCalled()
  })
})
```

### Unit Tests: Slack Worker (`workers/notification-slack.test.ts`)

```typescript
describe('sendSlackNotification', () => {
  it('sends Slack message and marks entry delivered on 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' }))
    const queueEntryId = await createTestSlackQueueEntry()

    await sendSlackNotification(queueEntryId)

    const entry = await getQueueEntry(queueEntryId)
    expect(entry.status).toBe('delivered')
  })

  it('throws on non-2xx Slack response (pg-boss retries)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' }))
    const queueEntryId = await createTestSlackQueueEntry()

    await expect(sendSlackNotification(queueEntryId)).rejects.toThrow('429')

    const entry = await getQueueEntry(queueEntryId)
    expect(entry.status).toBe('pending')
    expect(entry.attemptCount).toBe(1)
  })

  it('marks entry suppressed when SLACK_WEBHOOK_URL is not configured', async () => {
    // Temporarily remove SLACK_WEBHOOK_URL from env
    const queueEntryId = await createTestSlackQueueEntry({ webhookUrl: undefined })

    await sendSlackNotification(queueEntryId)

    const entry = await getQueueEntry(queueEntryId)
    expect(entry.status).toBe('suppressed')
  })

  it('throws on network error (fetch rejected)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const queueEntryId = await createTestSlackQueueEntry()

    await expect(sendSlackNotification(queueEntryId)).rejects.toThrow('ECONNREFUSED')
  })
})
```

### Integration Test: PENDING_DELIVERY Backfill

```typescript
describe('notification backfill', () => {
  it('processes all PENDING_DELIVERY security alerts and marks them delivered', async () => {
    // Insert two PENDING_DELIVERY security alerts for the test org
    const alert1Id = await insertTestSecurityAlert({ status: 'PENDING_DELIVERY' })
    const alert2Id = await insertTestSecurityAlert({ status: 'PENDING_DELIVERY' })

    // Run backfill
    const mockBoss = createMockBoss()
    await runNotificationBackfill(mockBoss, testLogger)

    // Both alerts should now be 'delivered'
    const alert1 = await getSecurityAlert(alert1Id)
    const alert2 = await getSecurityAlert(alert2Id)
    expect(alert1.status).toBe('delivered')
    expect(alert2.status).toBe('delivered')

    // Notification queue should have entries for each alert
    const queueEntries = await getQueueEntriesForOrg(testOrgId)
    expect(queueEntries.length).toBeGreaterThan(0)
  })

  it('is idempotent — running twice does not double-enqueue', async () => {
    const alertId = await insertTestSecurityAlert({ status: 'PENDING_DELIVERY' })
    const mockBoss = createMockBoss()

    await runNotificationBackfill(mockBoss, testLogger)
    await runNotificationBackfill(mockBoss, testLogger)  // second run

    // Alert still 'delivered', no duplicate queue entries
    const alert = await getSecurityAlert(alertId)
    expect(alert.status).toBe('delivered')
    const queueEntries = await getQueueEntriesForOrg(testOrgId)
    expect(queueEntries.filter((e) => e.templateId === alert.alertType)).toHaveLength(2)  // 1 email + 1 slack
  })
})
```

### Integration Test: RLS Isolation (`packages/db/src/__tests__/notification-queue-rls.test.ts`)

```typescript
describe('notification_queue RLS isolation', () => {
  it('org A cannot read org B notification queue entries', async () => {
    const { orgId: orgAId } = await withTestOrg(async (tx, orgA) => {
      await tx.insert(notificationQueue).values({
        orgId: orgA.orgId, channel: 'email', templateId: 'test', payload: {},
        status: 'pending', attemptCount: 0,
      })
      return orgA
    })

    const orgBEntries = await withTestOrg(async (tx) => {
      return tx.select().from(notificationQueue)
    })

    expect(orgBEntries.every((e) => e.orgId !== orgAId)).toBe(true)
  })

  it('org A cannot write to org B notification queue', async () => {
    const { orgId: orgBId } = await createTestOrgData()

    await withTestOrg(async (tx) => {
      await expect(
        tx.insert(notificationQueue).values({
          orgId: orgBId,  // ← wrong org
          channel: 'email', templateId: 'test', payload: {}, status: 'pending', attemptCount: 0,
        })
      ).rejects.toThrow()  // RLS violation
    })
  })
})
```

### Integration Test: Admin Test Endpoint (`modules/admin/routes.test.ts`)

```typescript
describe('POST /api/v1/admin/notifications/test', () => {
  it('returns not_configured when SMTP and Slack are absent', async () => {
    // No SMTP_HOST or SLACK_WEBHOOK_URL set
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/test',
      headers: authHeaders(adminUser),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.email).toBe('not_configured')
    expect(body.slack).toBe('not_configured')
  })

  it('returns 403 when caller is member (not admin or owner)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/test',
      headers: authHeaders(memberUser),
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns delivered when SMTP sends successfully (mock transport)', async () => {
    setEmailTransportForTesting(nodemailer.createTransport({ jsonTransport: true }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/test',
      headers: authHeaders(adminUser),
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).email).toBe('delivered')
  })

  it('returns failed when SMTP connection is refused', async () => {
    const failingTransport = nodemailer.createTransport({ host: '127.0.0.1', port: 1 })  // nothing listening
    setEmailTransportForTesting(failingTransport)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/test',
      headers: authHeaders(adminUser),
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).email).toBe('failed')
  })
})
```

### Worker Registration Test

Add to `apps/api/src/__tests__/worker-registration.test.ts`:
```typescript
it('registers notification:email and notification:slack workers (Story 3.1 AC-9)', () => {
  expect(workersBlock).toContain("'notification:email'")
  expect(workersBlock).toContain("'notification:slack'")
  expect(workersBlock).toContain("'notification:backfill-pending-delivery'")
})
```

---

## AC-15: Out of Scope

The following items are explicitly **deferred** to later stories:

| Deferred item | Story |
|---|---|
| Notification preferences (per-user, per-alert-type, frequency, severity threshold) | 3.2 |
| Org-level notification routing (route to role: admin/owner/member) | 3.2 |
| Digest notifications (daily digest vs immediate) | 3.2 |
| In-product notification inbox (SSE + unread count badge) | 3.3 |
| SMTP configuration via admin UI (env vars are the sole config mechanism now) | 9.x |
| Per-org Slack webhook URL (multiple Slack channels per org) | v2 |
| Email template customization (custom subject/body per org) | v2 |
| Notification DLQ monitoring + operational alerts on exhausted retries | 3.2 or operational runbook |
| `notification.test_sent` formal audit event (nice-to-have, not required by epics) | optional |
| **SSRF risk from Epic 9 admin UI**: When Epic 9 adds admin UI for SMTP/Slack config, the `SLACK_WEBHOOK_URL` and `SMTP_HOST` values come from a database-stored `system_settings` table. An org admin could potentially set these to internal network addresses (SSRF). Epic 9 must add a URL allowlist/blocklist for webhook URLs and validate SMTP hosts against an allowed domain list. Document this boundary in Epic 9's story. | 9.x |

---

## File Structure Summary

```
apps/api/src/
  config/
    env.ts                          ← MODIFY: add SMTP_*, SLACK_WEBHOOK_URL vars
  modules/
    admin/                          ← CREATE: new module (first use)
      routes.ts                     ← CREATE: POST /notifications/test
      schema.ts                     ← CREATE (can be empty for Story 3.1)
  notifications/
    dispatcher.ts                   ← CREATE: dispatchOrgAdminNotification(), enqueueSecurityAlertNotification()
    templates/
      index.ts                      ← CREATE: renderEmailTemplate(), renderSlackTemplate()
      security-failed-auth-threshold.ts  ← CREATE: first template
  workers/
    check-failed-auth-threshold.ts  ← MODIFY: enqueue directly instead of PENDING_DELIVERY
    notification-email.ts           ← CREATE: notification:email worker
    notification-slack.ts           ← CREATE: notification:slack worker
    notification-backfill.ts        ← CREATE: notification:backfill-pending-delivery worker
  lib/
    boss.ts                         ← MODIFY: add registerWorker() with concurrency options
    route-exemptions.ts             ← MODIFY: add ROUTE_ACTION_CLASSIFICATIONS + DIRECT_DB_ACCESS entries
  app.ts                            ← MODIFY: register adminRoutes
  main.ts                           ← MODIFY: register notification workers

packages/db/src/
  schema/
    notification-queue.ts           ← CREATE
    index.ts                        ← MODIFY: export notificationQueue
  migrations/
    00XX_notification_queue.sql     ← CREATE (verify journal for next free number)
    meta/_journal.json              ← MODIFY: add new entry

Test files:
  apps/api/src/workers/notification-email.test.ts          ← CREATE
  apps/api/src/workers/notification-slack.test.ts          ← CREATE
  apps/api/src/workers/notification-backfill.test.ts       ← CREATE
  apps/api/src/modules/admin/routes.test.ts                ← CREATE
  apps/api/src/__tests__/worker-registration.test.ts       ← MODIFY: add notification assertions
  packages/db/src/__tests__/notification-queue-rls.test.ts ← CREATE
```

---

## Architecture Decisions

### ADR-3.1-01: Dispatcher-Worker separation

**Decision**: Create a `notifications/dispatcher.ts` that handles recipient resolution and pg-boss job dispatch, separate from the worker files that handle actual delivery.

**Rationale**: Story 3.2 will refactor recipient resolution (add preferences, roles). If dispatcher logic lived in the workers, Story 3.2 would need to modify the workers. The separation means Story 3.2 only modifies `dispatcher.ts` — workers remain unchanged.

**Consequence**: The dispatcher is called within an open transaction (`tx` parameter). pg-boss `send()` is called AFTER the transaction commits. There is a narrow window where the transaction commits but pg-boss send fails. The pending queue rows will be picked up by the scheduled polling fallback.

### ADR-3.1-02: SMTP via env vars only (Epic 9 deferred)

**Decision**: SMTP is configured via env vars (`SMTP_HOST` etc.), not from a database `system_settings` table.

**Rationale**: Epic 9 is not yet implemented. The env var approach is sufficient for self-hosted deployments and matches the architecture comment "SMTP configuration via admin UI (FR86)" as a future enhancement. The env var keys established here (`SMTP_HOST`, `SMTP_PORT`, etc.) MUST be preserved as the fallback when Epic 9's admin UI is added.

**Consequence**: SMTP changes require a container restart in v1. This is acceptable for a self-hosted vault with operator-managed deployments.

### ADR-3.1-03: Owner+admin recipient scope (Story 3.2 will add preferences)

**Decision**: For Story 3.1, only active `owner` and `admin` members of the org receive notifications. Story 3.2 will add per-user preferences that allow further filtering (opt-out, digest, severity threshold).

**Rationale**: Security alerts are administrative in nature — viewers should not receive them. Sending to all active members would be wrong both semantically and privacy-wise. The role filter (`owner` and `admin`) is correct from day one, not a simplification. Story 3.2 adds *refinement* on top of this baseline (preferences, routing), not correction.

**Consequence**: An org with no active `owner` or `admin` members (edge case: all admins pending acceptance) receives no email notifications. This is acceptable — such an org is in an unusable state anyway. Log a warning in the dispatcher when no recipients are found.

### ADR-3.1-04: pg-boss native retry vs. application-level retry

**Decision**: Use pg-boss's native `{ retryLimit: 3, retryBackoff: true, retryDelay: 60 }` for delivery retries.

**Rationale**: pg-boss v12 has mature retry support with exponential backoff. Implementing retry logic inside the worker handler would duplicate this and create a risk of infinite retry loops if pg-boss errors are not distinguished from SMTP errors.

**Consequence**: After 3 pg-boss retries, the job is moved to the DLQ. The `notification_queue` entry remains in `pending` status. A future story should add DLQ monitoring (architecture requirement: "DLQ entries for `rotation:*`, `audit:*` must trigger an operational alert") — Story 3.1 adds a pino `error` log when the entry is still `pending` after max attempts. The entry is not automatically marked `failed` by pg-boss; a separate cleanup job (Story 3.2 or 3.3) should prune stale `pending` entries after N days.

### ADR-3.1-05: notification_queue.recipientUserId nullable for Slack entries

**Decision**: Slack queue entries have `recipientUserId = null` because Slack notifications are org-level (one webhook per org), not per-user.

**Rationale**: The `notification_queue.channel` column already differentiates between email (per-user) and Slack (org-level). Forcing a Slack entry to have a `recipientUserId` would require picking an arbitrary user (e.g., org owner) which is misleading.

**Consequence**: Workers must check `recipientUserId` for `null` before attempting user email lookup. The RLS policy applies to the `org_id` column regardless of whether `recipientUserId` is null, so multi-tenancy isolation is preserved.

### ADR-3.1-06: Outbox pattern for boss.send() reliability

**Context**: The dispatcher creates `notification_queue` entries in a transaction, then calls `boss.send()` after commit. If `boss.send()` fails (pg-boss restart, network partition), the queue entry remains in `pending` state permanently with no job to process it.

**Options considered**:
1. **pg-boss transactional send** (`sendWithConnection()`): Atomic with the transaction. Would require using the raw pg connection from the Drizzle transaction — complex and fragile across pg-boss API versions.
2. **Polling catchup cron** (every 10 min): Scans `notification_queue WHERE status = 'pending' AND created_at < NOW() - '5 min'` and re-sends jobs. Simple and resilient.
3. **Accept the gap** with documentation: Notify operators via runbook. Unacceptable for security alerts.

**Decision**: Option 2 (polling catchup cron). Add `notification:email-catchup` and `notification:slack-catchup` scheduled jobs that re-send boss.send() for stale pending entries.

**Consequence**: Notification delivery for entries missed by `boss.send()` is delayed up to 10 minutes. This is acceptable for security alert notifications (not real-time critical). The catchup schedule also provides defense against any other code path that creates queue entries without calling boss.send().

### ADR-3.1-07: Backfill idempotency without singletonKey

**Context**: The backfill job must process all `PENDING_DELIVERY` security alerts from pre-Epic-3 history. If we use `singletonKey` to prevent duplicate runs, a crash mid-backfill will permanently prevent re-runs (the DLQ'd job cannot be re-queued).

**Decision**: No `singletonKey`. The backfill is idempotent via the `status = 'PENDING_DELIVERY'` filter — already-processed rows have `status = 'delivered'` and are skipped on every subsequent run. The backfill is sent on every vault unseal; it is a no-op after the first successful completion.

**Consequence**: Every vault unseal queues a backfill job. Once all historical rows are processed (after first successful run), subsequent backfills scan 0 rows in O(1) time (the partial index `idx_notification_queue_pending` makes this fast). No performance concern.

---

## Developer Pre-mortem: Likely Failure Points

1. **nodemailer ESM import error**: If `apps/api` uses ESM modules, `import nodemailer from 'nodemailer'` may fail because nodemailer ships CJS. **Fix**: Use `createRequire` or ensure `tsconfig.json` has `"esModuleInterop": true` and `"allowSyntheticDefaultImports": true`. Test the import at install time.

2. **pg-boss `work()` with concurrency options**: The current `BossService.registerWorkers()` does not pass `teamSize`/`teamConcurrency`. If you call `boss.work()` directly in main.ts without these options, notification workers run at default concurrency (could exceed the architecture's `teamSize: 5` cap). **Fix**: Always extend `BossService` to support per-worker concurrency before registering notification workers.

3. **RLS policy missing from migration**: If the migration creates the `notification_queue` table but omits the `CREATE POLICY` and `ENABLE ROW LEVEL SECURITY`, `check-rls-coverage.ts` will fail CI. **Fix**: The migration must include both `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY notification_queue_org_isolation`. Template from Story 1.4.

4. **`check-failed-auth-threshold.ts` tests break**: Story 1.9 tests assert `alert.pending_epic3` log output and `status = 'PENDING_DELIVERY'`. After AC-8 changes, these tests will fail. **Fix**: Update the test assertions before running `pnpm test`.

5. **Boss not available at dispatcher call time**: The dispatcher calls `boss.send()` which requires the boss to be started. If a notification is dispatched during app startup (before `startBossAndRegisterWorkers()` runs), `boss.send()` will throw. **Fix**: The `check-failed-auth-threshold.ts` job only runs after unseal (workers are registered post-unseal), so this timing issue does not occur in practice. However, add a guard in `dispatchOrgAdminNotification()` that logs a warning and skips `boss.send()` if boss is not started. The catchup schedule (ADR-3.1-06) will pick up any pending entries created before boss was ready.

6. **Backfill sends duplicate notifications on fast restart** (resolved by ADR-3.1-07): If the vault unseals, starts the backfill, processes 5 of 10 alerts, then restarts, the second unseal re-queues the backfill. The first 5 alerts are already `'delivered'`, so they are skipped. The remaining 5 are processed on the second run. This is correct idempotent behavior by design — no singletonKey needed.

7. **Dispatcher sends to all org members including viewers** (FIXED): The original dispatcher queried all active members. Security alerts must only reach `owner` and `admin` roles. The dispatcher now filters by `role IN ('owner', 'admin')` from the start — this is not deferred to Story 3.2.

8. **Slack webhook URL in error logs**: If a catch block logs the webhook URL (e.g., `"Failed to POST to ${webhookUrl}"`), the URL is leaked to log aggregators. The Slack worker explicitly logs only the HTTP status code — never the URL.

9. **SMTP_FROM omitted when SMTP_HOST is set**: The `env.ts` superRefine validation (AC-10) will catch this at startup, aborting the process with a clear error message. Do not silently allow `SMTP_FROM` to be undefined when sending — the `sendMail({ from: undefined })` call would fail in production with a cryptic SMTP error.

---

## Tasks

### Phase 1: Database & Migration
- [ ] **R1**: Read `packages/db/src/migrations/meta/_journal.json`, note the next free migration number
- [ ] Create `packages/db/src/schema/notification-queue.ts` (AC-1)
- [ ] Export `notificationQueue` from `packages/db/src/schema/index.ts`
- [ ] Create `packages/db/src/migrations/00XX_notification_queue.sql` (AC-2) with RLS policy
- [ ] Update `meta/_journal.json`
- [ ] Run `pnpm --filter @project-vault/db migrate` in dev environment — confirm migration applies cleanly
- [ ] Run `pnpm --filter @project-vault/db generate` — confirm Drizzle schema is in sync
- [ ] Run `check-rls-coverage.ts` — confirm `notification_queue` is covered

### Phase 2: Env Vars & Dependencies
- [ ] Add `SMTP_*` and `SLACK_WEBHOOK_URL` to `apps/api/src/config/env.ts` (AC-10) — with `superRefine` validation
- [ ] Add SMTP_HOST required-when-SMTP_FROM validation
- [ ] Update `.env.example` with SMTP and Slack examples
- [ ] Run `pnpm --filter @project-vault/api add nodemailer` (AC-13)
- [ ] Run `pnpm --filter @project-vault/api add -D @types/nodemailer`
- [ ] Verify `import nodemailer from 'nodemailer'` works in the ESM context

### Phase 3: Templates (TDD — write tests first)
- [ ] Write template unit tests (renderSecurityFailedAuthThreshold, renderSlackTemplate)
- [ ] Create `apps/api/src/notifications/templates/security-failed-auth-threshold.ts` (AC-6)
- [ ] Create `apps/api/src/notifications/templates/index.ts` (AC-6)
- [ ] Verify template tests pass

### Phase 4: Dispatcher (TDD)
- [ ] Write dispatcher unit tests (`notifications/dispatcher.test.ts`)
- [ ] Create `apps/api/src/notifications/dispatcher.ts` (AC-3)
- [ ] Verify dispatcher tests pass

### Phase 5: Workers (TDD)
- [ ] Write `workers/notification-email.test.ts` before implementing (AC-14)
- [ ] Write `workers/notification-slack.test.ts` before implementing (AC-14)
- [ ] Create `apps/api/src/workers/notification-email.ts` (AC-4)
- [ ] Create `apps/api/src/workers/notification-slack.ts` (AC-5)
- [ ] Write `workers/notification-backfill.test.ts` before implementing
- [ ] Create `apps/api/src/workers/notification-backfill.ts` (AC-7)
- [ ] Verify all worker tests pass

### Phase 6: `check-failed-auth-threshold.ts` Update
- [ ] Update existing Story 1.9 tests for `check-failed-auth-threshold.ts` to reflect new behavior (AC-8)
- [ ] Modify `apps/api/src/workers/check-failed-auth-threshold.ts` to call dispatcher (AC-8)
- [ ] Verify existing tests still pass + new assertions (no `PENDING_DELIVERY`, calls enqueueSecurityAlertNotification)

### Phase 7: Boss Extension
- [ ] Extend `apps/api/src/lib/boss.ts` to support per-worker concurrency options (AC-9)
- [ ] Update `boss.test.ts` for the new API

### Phase 8: Admin Module
- [ ] Write `modules/admin/routes.test.ts` before implementing (AC-14)
- [ ] Create `apps/api/src/modules/admin/routes.ts` and `schema.ts` (AC-11)
- [ ] Register `adminRoutes` in `apps/api/src/app.ts` (AC-11)
- [ ] Verify admin route tests pass

### Phase 9: Route Audit & Main.ts
- [ ] Add `ROUTE_ACTION_CLASSIFICATIONS` entry for `POST /api/v1/admin/notifications/test` (AC-12)
- [ ] Add `DIRECT_DB_ACCESS_CLASSIFICATIONS` entries for notification workers (AC-12)
- [ ] Register notification workers in `apps/api/src/main.ts` (AC-9)
- [ ] Add backfill startup trigger in `startBossAndRegisterWorkers()` (AC-7)
- [ ] Update `worker-registration.test.ts` assertions (AC-14)
- [ ] Verify `route-audit.test.ts` passes

### Phase 10: RLS Test
- [ ] Create `packages/db/src/__tests__/notification-queue-rls.test.ts` (AC-14)
- [ ] Verify RLS isolation tests pass

### Phase 11: Full CI Sweep
- [ ] `pnpm typecheck` — no errors
- [ ] `pnpm lint` — no errors
- [ ] `pnpm test` (all workspaces) — all tests pass
- [ ] `pnpm --filter @project-vault/api test` — notification-specific tests pass
- [ ] Manual smoke test: vault unsealed → `POST /api/v1/admin/notifications/test` returns expected result

---

## Previous Story Intelligence

**From Story 1.9 (check-failed-auth-threshold.ts)**:
- The `runOrgScopedJob()` utility from `middleware/rls.ts` provides a `{ tx }` context with RLS set to `orgId`. Use this pattern in the backfill worker.
- `fetchAllOrgIds()` is the platform-level scan used to iterate orgs for cross-org jobs. Import from `middleware/rls.ts`.
- `pg_advisory_xact_lock(hashtext(dedupKey))` is used to prevent concurrent duplicate alert inserts. The notification workers don't need this (pg-boss deduplicates by job ID).
- The `PENDING_DELIVERY` status string is a string literal in the `security_alerts` table CHECK constraint — it must match exactly (uppercase, underscore-separated) when updating.

**From Story 1.10 (worker patterns)**:
- `withJobLogging(logger, 'job:name', jobId, async () => ...)` logs `job.started` / `job.completed` / `job.failed` events. Use it in all notification workers.
- Workers that need `getDb()` for platform-level queries must be listed in `DIRECT_DB_ACCESS_CLASSIFICATIONS`.
- Avoid `process.stdout.write(JSON.stringify(...))` for logging in new code — use the Fastify logger (`fastify.log`) passed via `withJobLogging`.

**From Story 2.2 (credential worker patterns)**:
- The `prune-credential-versions.ts` worker uses `runOrgScopedJob()` for org-scoped writes and `getDb()` + `fetchAllOrgIds()` for cross-org queries. Mirror this pattern in `notification-backfill.ts`.
- The retention job test (`prune-credential-versions.test.ts`) uses a real test database with `withTestOrg()`. Use the same approach for notification worker integration tests.

---

## Dev Agent Record

> **Fill in this section as you implement each phase. It becomes the intelligence source for Story 3.2.**

### Decisions Made During Implementation
*(To be filled by dev agent)*

### Problems Encountered
*(To be filled by dev agent)*

### Test Coverage Achieved
*(To be filled by dev agent)*

### Files Changed
*(To be filled by dev agent)*

### Notes for Story 3.2
*(Dev agent: document anything Story 3.2 must know — dispatcher refactoring hooks, schema limitations, unexpected behaviors)*
