# Story 3.3: In-Product Notification Inbox

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-28 - comprehensive developer guide for the persistent
     in-product notification inbox. This story introduces the notification_inbox table, the inbox delivery
     worker, the inbox CRUD API routes, the daily retention purge job, augments GET /api/v1/users/me with
     unreadCount, and wires up the SvelteKit notification bell and inbox page. It reuses the existing
     GET /api/v1/stream SSE infrastructure by adding 'notification.inbox' to SsePayloadMap. -->

## Story

As a user who relies on the web UI as my primary interface,
I want a persistent notification inbox in global navigation showing all alerts routed to me,
so that I never miss a vault event even without configuring email or Slack.

*Covers: FR107.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-3.3-In-Product-Notification-Inbox`]

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 3.1 (`notification_queue` table, `notification:deliver` worker concept, dispatcher) is merged | Story 3.3 adds the inbox channel delivery handler to the `notification:deliver` unified worker. The `notification_queue channel='inbox'` entries created by the dispatcher are the inputs to the inbox worker. |
| Story 3.2 (`notification_preferences` with `channel='inbox'` preferences, `org_notification_routing`) is merged | Story 3.2's dispatcher creates `notification_queue channel='inbox'` entries when user preferences include the inbox channel. Story 3.3's inbox worker processes these entries. |
| Story 1.x (`GET /api/v1/stream` SSE endpoint, `EventEmitter` injection, `lib/sse-ring-buffer.ts`, `SsePayloadMap`) is merged | Story 3.3 adds `notification.inbox` to `SsePayloadMap` and emits events via the established `emitSseEvent()` helper and injected `EventEmitter`. The inbox worker needs a reference to the shared EventEmitter. |
| Story 1.x (`GET /api/v1/users/me` endpoint) is merged | Story 3.3 augments the response of the existing users/me endpoint with `{ notifications: { unreadCount } }`. |
| Migration numbering **(R3 — verify `meta/_journal.json`, do NOT hardcode)** | ⚠️ Story 3.2 added one migration. This story adds `00ZZ_notification_inbox.sql`. Verify the journal for the next free number before generating. |

---

## Epic Cross-Story Context

| Story | Relationship to 3.3 |
|---|---|
| 3.1 | Created `notification_queue`, `notification:deliver` worker (AC-10), dispatcher. The `notification:deliver` worker in 3.1 stubs the `'inbox'` channel: "Story 3.3 will add the inbox delivery path." **3.3 fills that stub.** No new job type is needed — the inbox handler is registered inside the existing `notification:deliver` worker's `switch (entry.channel)` block. |
| 3.2 | Created dispatcher preferences/routing logic. When a user has `channel='inbox'` in their preferences for an alert type, the dispatcher creates `notification_queue` entries with `channel='inbox'`. 3.2 deliberately did not implement inbox delivery — 3.3 is the implementation. |
| 1.x SSE | The architecture mandates a single `GET /api/v1/stream` endpoint per session (established in `plugins/sse.ts`). 3.3 adds `notification.inbox` to `SsePayloadMap` and emits events on the shared EventEmitter. The existing SSE lifecycle, ring buffer, and reconnection logic are reused unchanged. |
| Future (6.x, 7.x) | Future alert types will create inbox entries via the same dispatcher + inbox worker pipeline. No changes to the inbox worker are needed when new alert types are added — the worker is template-agnostic (it renders title/body from whatever template is specified in the queue entry). |

---

## Architecture Conflict Resolution (Read Before Coding)

| Architecture wording | Canonical implementation for 3.3 | Rationale |
|---|---|---|
| Epic says `GET /api/v1/notifications/stream` for notification SSE | Use the existing `GET /api/v1/stream` endpoint. Add `notification.inbox` event type to `SsePayloadMap`. | Architecture is authoritative: "Fastify route: `GET /api/v1/stream` — authenticated, returns `text/event-stream`." One connection per session. Creating a second SSE endpoint at `/notifications/stream` would violate this. The epic's wording is descriptive, not prescriptive on the endpoint URL. |
| Epic says SSE reconnection backoff "1s → 2s → 4s → max 30s" | The SvelteKit `sse.svelte.ts` manages reconnection. Story 3.3 ensures `notifications.svelte.ts` calls `onSseEvent()` (not `new EventSource()`) and handles `notification.inbox` events. Reconnection is already handled by the shared `sse.svelte.ts`. | Architecture: "Pages never create `new EventSource()` directly." The single session SSE already handles reconnect. Notification bell state survives reconnects via `GET /api/v1/users/me` fallback. |
| Epic says SSE event payload `{ type: "new_notification", unreadCount }` | The payload type in `SsePayloadMap` is `NotificationInboxPayload = { unreadCount: number }`. The SSE `event:` line carries the event name (`notification.inbox`). The client reads `event.type` from the `MessageEvent` as `notification.inbox`. | Architecture SSE payload envelope: `{ event, id, projectId, timestamp, data: T }`. The `type` in the epic is the event name field, not a data field. |
| Epic says inbox entries include `resourceId`, `resourceType`, `projectId` | Store these in `notification_inbox.payload JSONB`. The table has separate columns for high-value display fields (`alertType`, `severity`, `readAt`) and `payload JSONB` for arbitrary template data including `{ resourceId, resourceType, projectId, title, body }`. | Avoids premature schema normalization while keeping the high-frequency read columns indexed. `title` and `body` are stored in `payload` since they're rendered at write time and are template-dependent. |
| Architecture says `emitSseEvent(emitter, event, projectId, orgId, data)` | For org-level notifications (no specific project), pass `projectId: ''` (empty string). | The ring buffer and SSE route filter events by `orgId`; an empty `projectId` signals org-wide scope. The client-side SSE filter in `sse.svelte.ts` must pass events where `projectId === '' \|\| projectId === currentProjectId`. Document this in the code. |

---

## AC Quick Reference

| Area | Required result |
|---|---|
| SSE event type | `'notification.inbox'` added to `SsePayloadMap` in `packages/shared/schemas/sse-payloads.ts`. |
| DB schema | `notification_inbox` table: per-user, per-org, with `readAt`, `payload` JSONB, RLS, expiry index. |
| Migration | `00ZZ_notification_inbox.sql` (next free number): creates table + indexes + RLS policy. |
| Inbox worker | Add `case 'inbox':` to `notification-deliver.ts`'s channel router — calls `deliverInboxNotification()`. New `workers/notification-inbox.ts` with `deliverInboxNotification()` function. |
| Purge worker | `workers/notification-inbox-purge.ts` — `notification:inbox-purge` daily cron; deletes `expires_at <= NOW()` entries. |
| API routes | 4 new routes in `modules/notifications/routes.ts`: `GET /api/v1/notifications/inbox`, `POST /api/v1/notifications/inbox/:id/read`, `POST /api/v1/notifications/inbox/read-all`, `DELETE /api/v1/notifications/inbox/:id`. |
| `GET /api/v1/users/me` | Add `notifications: { unreadCount }` to the existing endpoint response. |
| env.ts | `INBOX_RETENTION_DAYS` (default: 90). |
| Route audit | Add all 4 new routes to `ROUTE_ACTION_CLASSIFICATIONS`; add `notification-inbox.ts` to `DIRECT_DB_ACCESS_CLASSIFICATIONS`. |
| Frontend — state | `lib/state/notifications.svelte.ts` — `unreadCount` state + `onInboxEvent()` + `fetchUnreadCount()`. |
| Frontend — nav badge | `(app)/+layout.svelte` — subscribes to `notification.inbox` SSE event; renders notification bell with unread badge. |
| Frontend — inbox page | `(app)/notifications/+page.svelte` + `+page.server.ts` — paginated inbox list, read/dismiss actions. |
| Tests | Inbox delivery, SSE push on delivery, pagination, read, dismiss, expiry purge, `users/me` unreadCount, per-org RLS isolation. |

---

## AC-1: SSE Event Type — `notification.inbox`

**Given** the architecture requires all SSE event types to be registered in `SsePayloadMap` before being emitted,
**When** Story 3.3 adds the inbox notification event,
**Then** add to `packages/shared/schemas/sse-payloads.ts`:

```typescript
export interface NotificationInboxPayload {
  // Number of unread inbox entries for the recipient user in this org.
  // Client uses this to update the badge count without a REST round-trip.
  unreadCount: number
}

export interface SsePayloadMap {
  'project.health.changed': HealthChangedPayload
  'credential.expiry.warning': CredentialExpiryPayload
  'rotation.step.confirmed': RotationStepPayload
  'rotation.completed': RotationCompletedPayload
  'alert.fired': AlertFiredPayload
  // Story 3.3: in-product notification inbox push
  'notification.inbox': NotificationInboxPayload
}
```

**Why `unreadCount` only**: The SSE event carries only the unread count as a lightweight push signal. The client fetches the actual notification details via `GET /api/v1/notifications/inbox`. This keeps SSE payloads small and avoids re-sending notification body content over the persistent stream.

**`projectId` for org-level events**: The `emitSseEvent()` helper signature is `(emitter, event, projectId, orgId, data)`. For inbox notifications that are not project-scoped, pass `projectId: ''`. The SSE route handler must include events where `projectId === ''` in the org-scoped stream for all org members.

**Audit**: `emitSseEvent('notification.inbox', ...)` is NOT audited (SSE push is observational, not a security event). Do NOT write an `audit_log_entries` row for inbox SSE push.

---

## AC-2: Database Schema — `notification_inbox` Table

**Given** the Drizzle schema conventions in `packages/db/src/schema/`,
**When** Story 3.3 creates the persistent inbox,
**Then** create `packages/db/src/schema/notification-inbox.ts`:

```typescript
import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const notificationInbox = pgTable(
  'notification_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    // Always set — inbox entries are always per-user (not org-level like Slack)
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    alertType: text('alert_type').notNull(),
    severity: text('severity').notNull().default('warning'),
    // Rendered at write time: title (subject line), body (plain text summary ≤ 500 chars)
    // Also contains: resourceId, resourceType, projectId (if applicable)
    payload: jsonb('payload').notNull().default({}),
    // null = unread; set = read timestamp
    readAt: timestamp('read_at', { withTimezone: true }),
    // null = active; set = dismissed (soft-deleted; not returned in normal queries)
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    // Fast lookup: user's unread count
    unreadIdx: index('notification_inbox_unread_idx')
      .on(t.orgId, t.userId, t.readAt)
      .where(sql`${t.readAt} IS NULL AND ${t.dismissedAt} IS NULL`),
    // Purge job: fast scan of expired entries
    expiryIdx: index('notification_inbox_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.dismissedAt} IS NULL`),
    // Pagination: user's inbox ordered by newest first
    userInboxIdx: index('notification_inbox_user_idx')
      .on(t.orgId, t.userId, t.createdAt),
  })
)
```

**Export** from `packages/db/src/schema/index.ts`:
```typescript
export { notificationInbox } from './notification-inbox.js'
```

**`payload` JSONB shape** (rendered at write time by the inbox worker):
```typescript
type InboxPayload = {
  title: string           // Rendered template subject (without "[Project Vault]" prefix)
  body: string            // Plain text summary, max 500 chars
  projectId?: string      // If alert is scoped to a project
  resourceId?: string     // E.g. credential ID
  resourceType?: string   // E.g. 'credential', 'machine_user'
}
```

**Why `dismissedAt` instead of hard delete**: Following the soft-archive pattern used throughout the codebase. Soft dismissal allows the expiry purge job to handle cleanup consistently. A dismissed entry is hidden from the user immediately (filtered in queries) but physically removed only when the purge job runs.

**RLS**: `notification_inbox` needs TWO levels of RLS:
1. Org isolation (same as all tables): `org_id = current_setting('app.current_org_id')::uuid`
2. User isolation: `user_id = current_setting('app.current_user_id')::uuid`

This is stricter than other tables — inbox entries are private per-user, not shared within the org.

---

## AC-3: Migration

**Given** the current migration journal,
**When** Story 3.3 adds the inbox table,
**Then** create `packages/db/src/migrations/00ZZ_notification_inbox.sql`:

```sql
-- Migration: 00ZZ_notification_inbox
-- Created: Story 3.3 (Epic 3)
-- Adds: notification_inbox table with per-user RLS

CREATE TABLE "notification_inbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "alert_type" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'warning',
  "payload" jsonb NOT NULL DEFAULT '{}',
  "read_at" timestamptz,
  "dismissed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);

-- Fast unread count query (partial index: only active unread entries)
CREATE INDEX "notification_inbox_unread_idx"
  ON "notification_inbox" (org_id, user_id, read_at)
  WHERE read_at IS NULL AND dismissed_at IS NULL;

-- Purge job scan (partial index: only non-dismissed entries for expiry check)
CREATE INDEX "notification_inbox_expiry_idx"
  ON "notification_inbox" (expires_at)
  WHERE dismissed_at IS NULL;

-- Pagination (user's full inbox ordered by created_at)
CREATE INDEX "notification_inbox_user_idx"
  ON "notification_inbox" (org_id, user_id, created_at DESC);

-- Enable RLS
ALTER TABLE "notification_inbox" ENABLE ROW LEVEL SECURITY;

-- Dual RLS policy: org isolation + user isolation (inbox entries are private per-user)
CREATE POLICY "notification_inbox_user_isolation"
ON "notification_inbox"
USING (
  org_id = current_setting('app.current_org_id')::uuid
  AND user_id = current_setting('app.current_user_id')::uuid
);
```

**Dual RLS policy note**: Unlike most tables where only `org_id` is enforced by RLS, `notification_inbox` enforces both `org_id` AND `user_id`. This means:
- The `withOrg()` helper (which sets `app.current_org_id`) is not sufficient alone for inbox queries
- The inbox worker and API routes must use `withOrgAndUser(orgId, userId, fn)` — a new helper that sets BOTH `app.current_org_id` and `app.current_user_id`
- The `withOrgAndUser()` helper is created in this story (AC-4)

**`expires_at` computation**: Set at insert time as `NOW() + INTERVAL '${INBOX_RETENTION_DAYS} days'` (via parameterized interval). The default is 90 days. The application layer reads `env.INBOX_RETENTION_DAYS` and computes the timestamp.

---

## AC-4: `withOrgAndUser()` Database Helper

**Given** the dual RLS policy on `notification_inbox` requires both `org_id` and `user_id` in session variables,
**When** Story 3.3 creates the inbox worker and routes,
**Then** add `withOrgAndUser()` to `packages/db/src/index.ts`:

```typescript
// Runs fn inside a transaction with both org_id and user_id RLS session variables set.
// Use for tables with dual org+user RLS policies (notification_inbox).
export async function withOrgAndUser<T>(
  orgId: string,
  userId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_org_id', ${orgId}, true),
                 set_config('app.current_user_id', ${userId}, true)`
    )
    return fn(tx)
  })
}
```

**Also**: ensure `app.current_user_id` is set to `''` (empty string) in `withOrg()` to prevent stale user ID leaking across requests:

```typescript
// In withOrg() (existing function in packages/db/src/index.ts):
// MODIFY to also reset current_user_id:
await tx.execute(
  sql`SELECT set_config('app.current_org_id', ${orgId}, true),
             set_config('app.current_user_id', '', true)`
)
```

This ensures that any inadvertent `notification_inbox` query inside a bare `withOrg()` block returns zero rows (rather than matching stale `user_id`), making the dual RLS fail-closed.

---

## AC-5: Inbox Worker

**Given** the `notification:deliver` worker stubs `case 'inbox':` with a TODO comment,
**When** Story 3.3 implements inbox delivery,
**Then** update `apps/api/src/workers/notification-deliver.ts` to import and call the inbox handler:

```typescript
// In notification-deliver.ts switch block, replace the inbox stub:
case 'inbox':
  await deliverInboxNotification(entry.id, entry.orgId, emitter)
  break
```

**Note**: The `deliverNotification()` function needs access to the shared `EventEmitter` to emit SSE events after delivery. The worker registration must thread the emitter through:

```typescript
// In main.ts registerWorkers():
'notification:deliver': (job) => notificationDeliverHandler(job, fastify.log, fastify.emitter),
//                                                                                  ^ new param
```

**And** create `apps/api/src/workers/notification-inbox.ts`:

```typescript
import { eq, and, isNull, count } from 'drizzle-orm'
import type { EventEmitter } from 'events'
import { withOrgAndUser, getDb } from '@project-vault/db'
import { notificationQueue, notificationInbox } from '@project-vault/db/schema'
import { emitSseEvent } from '../lib/events.js'
import { renderTemplate } from '../notifications/templates/index.js'
import { env } from '../config/env.js'

// Called by notification-deliver.ts when channel = 'inbox'
export async function deliverInboxNotification(
  notificationQueueId: string,
  orgId: string,
  emitter: EventEmitter
): Promise<void> {
  // 1. Fetch queue entry (uses getDb() — no org scope needed; worker reads by specific ID)
  const rows = await getDb().execute<{
    id: string
    orgId: string
    recipientUserId: string
    templateId: string
    payload: Record<string, unknown>
    status: string
  }>(
    `SELECT id, org_id AS "orgId", recipient_user_id AS "recipientUserId",
            template_id AS "templateId", payload, status
     FROM notification_queue WHERE id = $1 LIMIT 1`,
    [notificationQueueId]
  )
  const entry = rows[0]

  if (!entry || entry.status !== 'pending') return
  if (!entry.recipientUserId) {
    // Inbox notifications must have a recipient — skip silently
    return
  }

  // 2. Render template to get inbox title + body
  const rendered = renderTemplate(entry.templateId, entry.payload)
  const expiresAt = new Date(Date.now() + env.INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  // 3. Insert inbox entry with dual-RLS context
  await withOrgAndUser(entry.orgId, entry.recipientUserId, async (tx) => {
    await tx.insert(notificationInbox).values({
      orgId: entry.orgId,
      userId: entry.recipientUserId,
      alertType: entry.templateId,
      severity: (entry.payload as { severity?: string }).severity ?? 'warning',
      payload: {
        title: rendered.inboxTitle,
        body: rendered.inboxBody,
        projectId: (entry.payload as { projectId?: string }).projectId,
        resourceId: (entry.payload as { resourceId?: string }).resourceId,
        resourceType: (entry.payload as { resourceType?: string }).resourceType,
      },
      expiresAt,
    })

    // Mark queue entry delivered (within same transaction)
    await tx.update(notificationQueue)
      .set({ status: 'delivered', deliveredAt: new Date(), attemptCount: 1 })
      .where(eq(notificationQueue.id, entry.id))

    // 4. Compute new unread count for SSE push
    const [countRow] = await tx
      .select({ count: count() })
      .from(notificationInbox)
      .where(
        and(
          eq(notificationInbox.orgId, entry.orgId),
          eq(notificationInbox.userId, entry.recipientUserId),
          isNull(notificationInbox.readAt),
          isNull(notificationInbox.dismissedAt)
        )
      )

    const unreadCount = countRow?.count ?? 0

    // 5. Emit SSE event AFTER transaction commits (post-commit, not inside)
    //    Note: emitSseEvent is called here but tx has not committed yet.
    //    This is acceptable: SSE emission is best-effort (fire-and-forget).
    //    The client will re-fetch unreadCount from users/me on reconnect.
    emitSseEvent(emitter, 'notification.inbox', '', entry.orgId, { unreadCount })
  })
}
```

**Critical design note — SSE inside transaction**: The `emitSseEvent()` call at step 5 is inside the `withOrgAndUser()` transaction callback, but the EventEmitter emit is synchronous and non-blocking. The SSE push happens immediately when the emit fires, before the DB transaction actually commits. This is acceptable because:
1. The SSE event is best-effort (the client will see the correct count on next poll/reconnect)
2. Moving it outside the transaction would require the unread count query to be outside the RLS-scoped context

**Better alternative** (recommended in ADR-3.3-01): Move the SSE emit outside the transaction by returning the `unreadCount` from the transaction and emitting after. This avoids the phantom-read risk (client fetches inbox before the TX commits):

```typescript
// Recommended pattern:
const unreadCount = await withOrgAndUser(entry.orgId, entry.recipientUserId, async (tx) => {
  await tx.insert(notificationInbox).values({...})
  await tx.update(notificationQueue).set({...})
  const [row] = await tx.select({ count: count() }).from(notificationInbox).where(...)
  return row?.count ?? 0
})
// SSE emit AFTER transaction commits:
emitSseEvent(emitter, 'notification.inbox', '', entry.orgId, { unreadCount })
```

Use the second pattern. Document it as the standard.

---

## AC-6: Template Rendering Extension

**Given** Story 3.1 created `notifications/templates/security-failed-auth-threshold.ts` with `{ subject, text, html }`,
**When** Story 3.3 needs `{ inboxTitle, inboxBody }` for inbox entries,
**Then** update `apps/api/src/notifications/templates/index.ts` to export:

```typescript
import { securityFailedAuthThresholdTemplate } from './security-failed-auth-threshold.js'

export type RenderedTemplate = {
  subject: string
  text: string
  html: string
  // Inbox-specific: title (without "[Project Vault]" prefix) and truncated body
  inboxTitle: string
  inboxBody: string
}

const TEMPLATES: Record<string, (payload: unknown) => RenderedTemplate> = {
  'security.failed_auth_threshold': (p) => {
    const { subject, text, html } = securityFailedAuthThresholdTemplate(p as SecurityFailedAuthPayload)
    return {
      subject,
      text,
      html,
      inboxTitle: subject.replace(/^\[Project Vault\]\s*/, ''),
      inboxBody: text.slice(0, 500),
    }
  },
}

export function renderTemplate(templateId: string, payload: unknown): RenderedTemplate {
  const tpl = TEMPLATES[templateId]
  if (!tpl) {
    // Fallback for unknown/future template IDs — safe default
    return {
      subject: `[Project Vault] Alert: ${templateId}`,
      text: `A vault event occurred: ${templateId}`,
      html: `<p>A vault event occurred: ${templateId}</p>`,
      inboxTitle: `Alert: ${templateId}`,
      inboxBody: `A vault event occurred: ${templateId}`,
    }
  }
  return tpl(payload)
}
```

**And** update `security-failed-auth-threshold.ts` to export a function (not just objects):
```typescript
// MODIFY: export a named function accepting payload
export function securityFailedAuthThresholdTemplate(payload: SecurityFailedAuthPayload): { subject: string; text: string; html: string } {
  return { subject: ..., text: ..., html: ... }
}
```

**Fallback template strategy**: The `renderTemplate()` function never throws for unknown `templateId` values. Unknown alert types get a generic fallback inbox entry. This ensures that when future epics add new alert types and dispatch `channel='inbox'` notifications before Story 3.3's template registry is updated, the inbox worker still creates valid entries.

---

## AC-7: Inbox API Routes

**Given** the notifications module (`modules/notifications/`) established in Story 3.2,
**When** Story 3.3 adds inbox CRUD endpoints,
**Then** add to `apps/api/src/modules/notifications/routes.ts`:

```typescript
import { and, eq, isNull, isNotNull, count, desc } from 'drizzle-orm'
import { notificationInbox } from '@project-vault/db/schema'
import { withOrgAndUser } from '@project-vault/db'
import {
  GetInboxQuerySchema,
  GetInboxResponseSchema,
} from './schema.js'

// --- Inbox CRUD ---

// GET /api/v1/notifications/inbox
secureRoute(fastify, {
  method: 'GET',
  url: '/notifications/inbox',
  security: {
    allowedRoles: ['owner', 'admin', 'member', 'viewer'],
    writeAuditEvent: false,
  },
  handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
    const secureCtx = ctx as SecureRouteContext
    const parsed = GetInboxQuerySchema.safeParse(req.query)
    if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))
    const { page, limit, status } = parsed.data

    const entries = await withOrgAndUser(secureCtx.auth.orgId, secureCtx.auth.userId, async (tx) => {
      return tx
        .select({
          id: notificationInbox.id,
          alertType: notificationInbox.alertType,
          severity: notificationInbox.severity,
          payload: notificationInbox.payload,
          readAt: notificationInbox.readAt,
          createdAt: notificationInbox.createdAt,
        })
        .from(notificationInbox)
        .where(
          and(
            eq(notificationInbox.orgId, secureCtx.auth.orgId),
            eq(notificationInbox.userId, secureCtx.auth.userId),
            isNull(notificationInbox.dismissedAt),
            status === 'unread' ? isNull(notificationInbox.readAt) : undefined,
            status === 'read' ? isNotNull(notificationInbox.readAt) : undefined,
          )
        )
        .orderBy(desc(notificationInbox.createdAt))
        .limit(limit)
        .offset((page - 1) * limit)
    })

    // Flatten payload into response shape
    const data = entries.map((e) => ({
      id: e.id,
      alertType: e.alertType,
      severity: e.severity,
      title: (e.payload as { title?: string }).title ?? '',
      body: (e.payload as { body?: string }).body ?? '',
      projectId: (e.payload as { projectId?: string }).projectId ?? null,
      resourceId: (e.payload as { resourceId?: string }).resourceId ?? null,
      resourceType: (e.payload as { resourceType?: string }).resourceType ?? null,
      readAt: e.readAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    }))

    return { data, page, limit }
  },
})

// POST /api/v1/notifications/inbox/:id/read
secureRoute(fastify, {
  method: 'POST',
  url: '/notifications/inbox/:id/read',
  security: {
    allowedRoles: ['owner', 'admin', 'member', 'viewer'],
    writeAuditEvent: false,
  },
  handler: async (ctx, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const secureCtx = ctx as SecureRouteContext
    const paramParsed = InboxEntryIdParamSchema.safeParse(req.params)
    if (!paramParsed.success) return reply.status(400).send(validationError(paramParsed.error, 'params'))
    const { id } = paramParsed.data

    await withOrgAndUser(secureCtx.auth.orgId, secureCtx.auth.userId, async (tx) => {
      const result = await tx
        .update(notificationInbox)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notificationInbox.id, id),
            eq(notificationInbox.orgId, secureCtx.auth.orgId),
            eq(notificationInbox.userId, secureCtx.auth.userId),
            isNull(notificationInbox.readAt)  // idempotent: no-op if already read
          )
        )
        .returning({ id: notificationInbox.id })

      if (result.length === 0) {
        // Either already read (no-op is fine) or not found — check which
        const existing = await tx
          .select({ id: notificationInbox.id })
          .from(notificationInbox)
          .where(
            and(
              eq(notificationInbox.id, id),
              eq(notificationInbox.orgId, secureCtx.auth.orgId),
              eq(notificationInbox.userId, secureCtx.auth.userId)
            )
          )
          .limit(1)

        if (existing.length === 0) return reply.status(404).send({ error: 'not_found' })
        // Already read — idempotent success
      }
    })

    return reply.status(204).send()
  },
})

// POST /api/v1/notifications/inbox/read-all
secureRoute(fastify, {
  method: 'POST',
  url: '/notifications/inbox/read-all',
  security: {
    allowedRoles: ['owner', 'admin', 'member', 'viewer'],
    writeAuditEvent: false,
  },
  handler: async (ctx, _req: FastifyRequest, reply: FastifyReply) => {
    const secureCtx = ctx as SecureRouteContext

    await withOrgAndUser(secureCtx.auth.orgId, secureCtx.auth.userId, async (tx) => {
      await tx
        .update(notificationInbox)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notificationInbox.orgId, secureCtx.auth.orgId),
            eq(notificationInbox.userId, secureCtx.auth.userId),
            isNull(notificationInbox.readAt),
            isNull(notificationInbox.dismissedAt)
          )
        )
    })

    return reply.status(204).send()
  },
})

// DELETE /api/v1/notifications/inbox/:id
secureRoute(fastify, {
  method: 'DELETE',
  url: '/notifications/inbox/:id',
  security: {
    allowedRoles: ['owner', 'admin', 'member', 'viewer'],
    writeAuditEvent: false,
  },
  handler: async (ctx, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const secureCtx = ctx as SecureRouteContext
    const { id } = req.params

    await withOrgAndUser(secureCtx.auth.orgId, secureCtx.auth.userId, async (tx) => {
      const result = await tx
        .update(notificationInbox)
        .set({ dismissedAt: new Date() })
        .where(
          and(
            eq(notificationInbox.id, id),
            eq(notificationInbox.orgId, secureCtx.auth.orgId),
            eq(notificationInbox.userId, secureCtx.auth.userId),
            isNull(notificationInbox.dismissedAt)
          )
        )
        .returning({ id: notificationInbox.id })

      if (result.length === 0) return reply.status(404).send({ error: 'not_found' })
    })

    return reply.status(204).send()
  },
})
```

**Pagination implementation**: `GET /api/v1/notifications/inbox?page=1&limit=20&status=unread|read|all`.
- `page` defaults to 1, `limit` defaults to 20, max 100.
- Results ordered newest first (`created_at DESC`).
- `status=unread`: only entries with `read_at IS NULL AND dismissed_at IS NULL`
- `status=read`: only entries with `read_at IS NOT NULL AND dismissed_at IS NULL`
- `status=all`: all non-dismissed entries (default)
- Dismissed entries (`dismissed_at IS NOT NULL`) are NEVER returned.

**Idempotency**: `POST .../inbox/:id/read` is idempotent — calling it on an already-read entry returns `204` without error. This prevents double-mark errors from retries or double-clicks.

**Example responses**:

```json
// GET /api/v1/notifications/inbox?page=1&limit=5&status=unread
{
  "data": [
    {
      "id": "a1b2c3d4-...",
      "alertType": "security.failed_auth_threshold",
      "severity": "warning",
      "title": "Failed Login Threshold Exceeded",
      "body": "5 consecutive failed login attempts detected for user alice@example.com in the last 10 minutes. This may indicate a brute-force attack.",
      "projectId": null,
      "resourceId": null,
      "resourceType": null,
      "readAt": null,
      "createdAt": "2026-06-28T20:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 5
}

// POST /api/v1/notifications/inbox/a1b2c3d4-.../read → 204 No Content
// POST /api/v1/notifications/inbox/a1b2c3d4-.../read (again) → 204 No Content (idempotent)
// DELETE /api/v1/notifications/inbox/a1b2c3d4-... → 204 No Content
// GET /api/v1/notifications/inbox after delete: entry no longer appears
```

---

## AC-8: Inbox Route Zod Schemas

**Given** the Zod schema pattern in `modules/notifications/schema.ts`,
**When** Story 3.3 adds inbox API routes,
**Then** add to `apps/api/src/modules/notifications/schema.ts`:

```typescript
// Inbox query parameters
export const GetInboxQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['unread', 'read', 'all']).default('all'),
})

// Inbox entry response shape
export const InboxEntrySchema = z.object({
  id: z.string().uuid(),
  alertType: z.string(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  projectId: z.string().nullable(),
  resourceId: z.string().nullable(),
  resourceType: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
})

// Path param validation for inbox entry ID
export const InboxEntryIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
})

export const GetInboxResponseSchema = z.object({
  data: z.array(InboxEntrySchema),
  page: z.number(),
  limit: z.number(),
})
```

---

## AC-9: Inbox Purge Worker

**Given** inbox entries expire after `INBOX_RETENTION_DAYS` days,
**When** Story 3.3 adds the purge job,
**Then** create `apps/api/src/workers/notification-inbox-purge.ts`:

```typescript
import { getDb } from '@project-vault/db'
import { notificationInbox } from '@project-vault/db/schema'
import { lte, isNull, or, isNotNull, sql } from 'drizzle-orm'
import { withJobLogging } from '../lib/job-logging.js'
import type { FastifyBaseLogger } from 'fastify'

export async function runInboxPurge(logger: FastifyBaseLogger): Promise<void> {
  const now = new Date()

  // Delete entries where expires_at <= now, regardless of dismissed_at status.
  // This is a cross-org operation (uses getDb() without org scope) because the purge
  // is a maintenance operation that needs to touch all orgs. The WHERE clause on
  // expires_at is the access control — only expired rows are deleted.
  // RLS is intentionally bypassed here via getDb() (not withOrg()).
  // This is classified in DIRECT_DB_ACCESS_CLASSIFICATIONS.
  const result = await getDb().execute<{ count: string }>(
    `DELETE FROM notification_inbox
     WHERE expires_at <= $1
     RETURNING id`,
    [now.toISOString()]
  )

  logger.info(
    { eventType: 'notification.inbox.purge.completed', deletedCount: Array.isArray(result) ? result.length : 0 },
    'Inbox purge job completed'
  )
}

export async function notificationInboxPurgeHandler(logger: FastifyBaseLogger): Promise<void> {
  await withJobLogging(logger, 'notification:inbox-purge', 'daily',
    () => runInboxPurge(logger))
}
```

**Register schedule and worker in `main.ts`**:
```typescript
// In registerSchedules():
'notification:inbox-purge': { cron: '0 3 * * *' },  // 3am UTC daily, before digest at 8am

// In registerWorkers():
'notification:inbox-purge': () => notificationInboxPurgeHandler(fastify.log),
```

**Why `getDb()` without `withOrg()`**: The purge job is a maintenance operation across all orgs. It must delete ALL expired entries regardless of org. Using `withOrg()` would scope to one org, requiring iteration over all org IDs. The raw `getDb()` access is intentional and documented in `DIRECT_DB_ACCESS_CLASSIFICATIONS`.

---

## AC-10: `INBOX_RETENTION_DAYS` env.ts Addition

**Given** inbox retention is configurable,
**When** Story 3.3 adds the purge job,
**Then** add to `apps/api/src/config/env.ts` `envSchema`:

```typescript
// Inbox entry retention period in days before automatic purge
INBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
```

---

## AC-11: `GET /api/v1/users/me` — `unreadCount` Augmentation

**Given** the epic requires `GET /api/v1/users/me` to include `{ notifications: { unreadCount } }`,
**When** Story 3.3 implements the inbox,
**Then** modify the existing `modules/auth/routes.ts` (or wherever `GET /api/v1/users/me` is implemented) to include the unread count:

```typescript
// In GET /api/v1/users/me handler:
const unreadCount = await withOrgAndUser(secureCtx.auth.orgId, secureCtx.auth.userId, async (tx) => {
  const [row] = await tx
    .select({ count: count() })
    .from(notificationInbox)
    .where(
      and(
        eq(notificationInbox.orgId, secureCtx.auth.orgId),
        eq(notificationInbox.userId, secureCtx.auth.userId),
        isNull(notificationInbox.readAt),
        isNull(notificationInbox.dismissedAt)
      )
    )
  return row?.count ?? 0
})

return {
  // ... existing user fields ...
  notifications: {
    unreadCount,
  },
}
```

**Performance note**: The partial index `notification_inbox_unread_idx` on `(org_id, user_id, read_at) WHERE read_at IS NULL AND dismissed_at IS NULL` makes this count query a fast index-only scan. No sequential table scan.

**`users/me` location**: The existing endpoint may be in `modules/auth/routes.ts`, `modules/users/routes.ts`, or similar. The dev agent must locate the actual file and modify it. Do NOT create a new endpoint — modify the existing one.

---

## AC-12: Route Audit Classification

**Given** four new inbox routes and one modified route (`users/me`),
**When** Story 3.3 registers them,
**Then** add to `apps/api/src/lib/route-exemptions.ts` `ROUTE_ACTION_CLASSIFICATIONS`:

```typescript
'GET /api/v1/notifications/inbox': {
  action: 'read',
  auditOmissionReason: 'User reads own notification inbox; no secrets exposed. High-frequency UI operation.',
  reviewer: SECURITY_OWNER,
},
'POST /api/v1/notifications/inbox/:id/read': {
  action: 'mutation',
  auditOmissionReason: 'User marks own inbox entry read; no security-sensitive state change.',
  reviewer: SECURITY_OWNER,
},
'POST /api/v1/notifications/inbox/read-all': {
  action: 'mutation',
  auditOmissionReason: 'User marks all own inbox entries read; no security-sensitive state change.',
  reviewer: SECURITY_OWNER,
},
'DELETE /api/v1/notifications/inbox/:id': {
  action: 'mutation',
  auditOmissionReason: 'User dismisses own inbox entry (soft delete); no credential or secret data removed.',
  reviewer: SECURITY_OWNER,
},
```

**Also add** to `DIRECT_DB_ACCESS_CLASSIFICATIONS`:
```typescript
{
  path: 'workers/notification-inbox.ts',
  classification: PLATFORM_JOB,
  reason: 'Inbox delivery worker uses withOrgAndUser() for per-user RLS; uses getDb() for initial queue entry lookup.',
  reviewer: SECURITY_OWNER,
},
{
  path: 'workers/notification-inbox-purge.ts',
  classification: PLATFORM_JOB,
  reason: 'Cross-org purge of expired inbox entries; deliberately bypasses org scope via getDb() for maintenance operation.',
  reviewer: SECURITY_OWNER,
},
```

---

## AC-13: Frontend — `notifications.svelte.ts` State Module

**Given** the architecture defines `lib/state/notifications.svelte.ts` as the inbox state container,
**When** Story 3.3 implements the notification bell,
**Then** create `apps/web/src/lib/state/notifications.svelte.ts`:

```typescript
import { onSseEvent } from './sse.svelte.js'
import type { NotificationInboxPayload } from '@project-vault/shared'

// Module-level reactive state (Svelte 5 runes)
// Note: components should access this via getUnreadCount() only — do not import the state
// variable directly as module-level $state is reactive but external function calls in
// $derived are tracked only if the function reads from $state synchronously.
// The getUnreadCount() function reads from the $state variable, which Svelte 5's
// fine-grained reactivity system tracks correctly.
let unreadCount = $state(0)
let initialized = $state(false)

export function getUnreadCount(): number {
  return unreadCount
}

export function isInitialized(): boolean {
  return initialized
}

export function setInitialUnreadCount(count: number): void {
  unreadCount = count
  initialized = true
}

// Subscribe to SSE notification.inbox events.
// Call once in (app)/+layout.svelte onMount; returns cleanup function.
export function subscribeToInboxEvents(): () => void {
  return onSseEvent('notification.inbox', (event: NotificationInboxPayload) => {
    unreadCount = event.unreadCount
  })
}

export function markAllReadLocally(): void {
  unreadCount = 0
}

export function decrementUnread(by = 1): void {
  unreadCount = Math.max(0, unreadCount - by)
}
```

**Svelte 5 runes compliance**: Uses `$state` at module level for shared reactive state. Exported functions mutate the state. Components import from this module and use `$derived()` to react to changes.

**Initialization flow**: On page load:
1. `(app)/+layout.server.ts` calls `GET /api/v1/users/me` and returns `notifications.unreadCount` in `data`
2. `(app)/+layout.svelte` calls `setInitialUnreadCount(data.unreadCount)` in the script section
3. `onMount` calls `subscribeToInboxEvents()` to start receiving SSE updates
4. When SSE pushes `notification.inbox`, `unreadCount` updates reactively

---

## AC-14: Frontend — Global Nav Notification Bell

**Given** the unread count must appear in global nav at all times,
**When** Story 3.3 adds the inbox bell,
**Then** modify `apps/web/src/routes/(app)/+layout.svelte` to:

1. Initialize unread count from page data:
```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { subscribeToInboxEvents, setInitialUnreadCount, getUnreadCount } from '$lib/state/notifications.svelte.js'
  import type { LayoutData } from './$types'

  const { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props()

  let unsubscribeInbox: (() => void) | null = null

  // Set initial count from SSR data (avoids badge flash on load)
  $effect(() => {
    setInitialUnreadCount(data.unreadCount ?? 0)
  })

  onMount(() => {
    unsubscribeInbox = subscribeToInboxEvents()
  })

  onDestroy(() => {
    unsubscribeInbox?.()
  })

  const unreadCount = $derived(getUnreadCount())
</script>
```

2. Render the notification bell in the nav (within the existing nav element):
```svelte
<!-- In the global nav, near the user menu: -->
<a href="/notifications" class="relative p-2 text-gray-500 hover:text-gray-700 rounded-full hover:bg-gray-100">
  <!-- Bell icon (lucide-svelte) -->
  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>
  {#if unreadCount > 0}
    <span class="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 font-medium">
      {unreadCount > 99 ? '99+' : unreadCount}
    </span>
  {/if}
</a>
```

3. Also modify `apps/web/src/routes/(app)/+layout.server.ts` to include `unreadCount` in the returned data:
```typescript
// In +layout.server.ts load function:
const meRes = await apiClient.GET('/api/v1/users/me', { headers: locals.authHeaders })
// ... existing user data extraction ...
return {
  // ... existing return fields ...
  unreadCount: meRes.data?.notifications?.unreadCount ?? 0,
}
```

**Badge cap**: Counts above 99 render as "99+" to avoid layout overflow. This is a UX standard.

---

## AC-15: Frontend — Inbox Page

**Given** the architecture maps notification inbox to the web UI,
**When** Story 3.3 creates the inbox page,
**Then** create `apps/web/src/routes/(app)/notifications/+page.server.ts`:

```typescript
import type { PageServerLoad, Actions } from './$types'
import { apiClient } from '$lib/api/client.js'
import { error, fail } from '@sveltejs/kit'

export const load: PageServerLoad = async ({ locals, url }) => {
  const page = Number(url.searchParams.get('page') ?? '1')
  const status = url.searchParams.get('status') ?? 'all'

  const res = await apiClient.GET('/api/v1/notifications/inbox', {
    params: { query: { page, limit: 20, status } },
    headers: locals.authHeaders,
  })

  // 403: user not in an org yet (valid edge case); show empty inbox gracefully
  if (res.status === 403) {
    return { notifications: [], page, status }
  }

  if (!res.ok) throw error(500, 'Failed to load notifications')

  return {
    notifications: res.data?.data ?? [],
    page: res.data?.page ?? 1,
    status,
  }
}

export const actions: Actions = {
  markRead: async ({ request, locals }) => {
    const data = await request.formData()
    const id = String(data.get('id'))
    await apiClient.POST('/api/v1/notifications/inbox/{id}/read', {
      params: { path: { id } },
      headers: locals.authHeaders,
    })
    return { success: true }
  },

  markAllRead: async ({ locals }) => {
    await apiClient.POST('/api/v1/notifications/inbox/read-all', {
      headers: locals.authHeaders,
    })
    return { success: true }
  },

  dismiss: async ({ request, locals }) => {
    const data = await request.formData()
    const id = String(data.get('id'))
    const res = await apiClient.DELETE('/api/v1/notifications/inbox/{id}', {
      params: { path: { id } },
      headers: locals.authHeaders,
    })
    if (!res.ok) return fail(404, { error: 'Notification not found' })
    return { success: true }
  },
}
```

**And** create `apps/web/src/routes/(app)/notifications/+page.svelte`:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms'
  import { markAllReadLocally, decrementUnread } from '$lib/state/notifications.svelte.js'
  import type { PageData } from './$types'

  const { data }: { data: PageData } = $props()

  const SEVERITY_COLORS: Record<string, string> = {
    info: 'bg-blue-50 border-blue-200',
    warning: 'bg-yellow-50 border-yellow-200',
    critical: 'bg-red-50 border-red-200',
  }

  const SEVERITY_DOT: Record<string, string> = {
    info: 'bg-blue-400',
    warning: 'bg-yellow-400',
    critical: 'bg-red-500',
  }

  const ALERT_TYPE_LABELS: Record<string, string> = {
    'security.failed_auth_threshold': 'Failed Login Threshold',
    'credential.expiry': 'Credential Expiry',
    'service.down': 'Service Down',
    'rotation.stale': 'Stale Rotation',
    'backup.failure': 'Backup Failure',
    'machine_key.expiry': 'Machine Key Expiry',
    'security.anomalous_access': 'Anomalous Access',
  }
</script>

<div class="max-w-3xl mx-auto px-4 py-8">
  <div class="flex items-center justify-between mb-6">
    <h1 class="text-2xl font-bold text-gray-900">Notifications</h1>
    {#if data.notifications.some((n) => !n.readAt)}
      <form method="POST" action="?/markAllRead" use:enhance={() => {
        return ({ update }) => { markAllReadLocally(); update() }
      }}>
        <button type="submit" class="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
          Mark all as read
        </button>
      </form>
    {/if}
  </div>

  <!-- Filter tabs -->
  <div class="flex gap-1 mb-6 border-b border-gray-200">
    {#each [['all', 'All'], ['unread', 'Unread'], ['read', 'Read']] as [value, label]}
      <a
        href="?status={value}"
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors {data.status === value
          ? 'border-indigo-600 text-indigo-600'
          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}"
      >
        {label}
      </a>
    {/each}
  </div>

  {#if data.notifications.length === 0}
    <div class="text-center py-16">
      <svg class="w-12 h-12 text-gray-300 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
      <p class="text-gray-500 text-lg">No notifications</p>
      <p class="text-gray-400 text-sm mt-1">
        {data.status === 'unread' ? "You're all caught up!" : 'Notifications will appear here when alerts fire.'}
      </p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each data.notifications as notification (notification.id)}
        <div class="border rounded-lg p-4 {SEVERITY_COLORS[notification.severity] ?? 'bg-gray-50 border-gray-200'} {!notification.readAt ? 'shadow-sm' : 'opacity-75'}">
          <div class="flex items-start gap-3">
            <!-- Severity dot -->
            <div class="mt-1.5 w-2 h-2 rounded-full flex-shrink-0 {SEVERITY_DOT[notification.severity] ?? 'bg-gray-400'}"></div>

            <div class="flex-1 min-w-0">
              <!-- Header row -->
              <div class="flex items-start justify-between gap-2">
                <div>
                  <span class="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    {ALERT_TYPE_LABELS[notification.alertType] ?? notification.alertType}
                  </span>
                  <h3 class="text-sm font-semibold text-gray-900 mt-0.5">
                    {notification.title}
                  </h3>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  <time class="text-xs text-gray-400" datetime={notification.createdAt}>
                    {new Date(notification.createdAt).toLocaleDateString()}
                  </time>
                  {#if !notification.readAt}
                    <span class="w-2 h-2 bg-indigo-500 rounded-full" title="Unread"></span>
                  {/if}
                </div>
              </div>

              <!-- Body -->
              <p class="text-sm text-gray-600 mt-1 line-clamp-3">{notification.body}</p>

              <!-- Actions -->
              <div class="flex items-center gap-4 mt-3">
                {#if notification.projectId}
                  <a href="/projects/{notification.projectId}" class="text-xs text-indigo-600 hover:underline">
                    View project →
                  </a>
                {/if}
                {#if !notification.readAt}
                  <form method="POST" action="?/markRead" use:enhance={() => {
                    return ({ update }) => { decrementUnread(1); update() }
                  }}>
                    <input type="hidden" name="id" value={notification.id} />
                    <button type="submit" class="text-xs text-gray-500 hover:text-gray-700">
                      Mark as read
                    </button>
                  </form>
                {/if}
                <form method="POST" action="?/dismiss" use:enhance>
                  <input type="hidden" name="id" value={notification.id} />
                  <button type="submit" class="text-xs text-red-500 hover:text-red-700">
                    Dismiss
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>

    <!-- Pagination -->
    <div class="flex justify-center mt-8 gap-2">
      {#if data.page > 1}
        <a href="?page={data.page - 1}&status={data.status}" class="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
          Previous
        </a>
      {/if}
      {#if data.notifications.length === 20}
        <a href="?page={data.page + 1}&status={data.status}" class="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
          Next
        </a>
      {/if}
    </div>
  {/if}
</div>
```

---

## AC-16: Integration & Unit Tests

### Inbox Worker Tests (`workers/notification-inbox.test.ts`)

```typescript
describe('inbox delivery worker', () => {
  it('creates notification_inbox entry when channel="inbox" queue entry is delivered', async () => {
    await withTestOrg(async (tx, { orgId, userId }) => {
      // Seed a notification_queue entry with channel='inbox'
      const [queueEntry] = await tx.insert(notificationQueue).values({
        orgId,
        recipientUserId: userId,
        channel: 'inbox',
        templateId: 'security.failed_auth_threshold',
        payload: { failedAttempts: 5, userId, severity: 'warning' },
        status: 'pending',
      }).returning({ id: notificationQueue.id })

      const mockEmitter = createMockEventEmitter()
      await deliverInboxNotification(queueEntry.id, orgId, mockEmitter)

      // Inbox entry created
      const inboxEntries = await withOrgAndUser(orgId, userId, (t) =>
        t.select().from(notificationInbox)
          .where(and(eq(notificationInbox.orgId, orgId), eq(notificationInbox.userId, userId)))
      )
      expect(inboxEntries).toHaveLength(1)
      expect(inboxEntries[0].alertType).toBe('security.failed_auth_threshold')
      expect(inboxEntries[0].readAt).toBeNull()

      // Queue entry marked delivered
      const [updated] = await tx.select({ status: notificationQueue.status })
        .from(notificationQueue).where(eq(notificationQueue.id, queueEntry.id))
      expect(updated.status).toBe('delivered')

      // SSE emitted
      expect(mockEmitter.emittedEvents).toContainEqual(
        expect.objectContaining({ event: 'notification.inbox', data: expect.objectContaining({ unreadCount: 1 }) })
      )
    })
  })

  it('is idempotent: skips if queue entry already delivered', async () => {
    await withTestOrg(async (tx, { orgId, userId }) => {
      const [queueEntry] = await tx.insert(notificationQueue).values({
        orgId, recipientUserId: userId, channel: 'inbox',
        templateId: 'security.failed_auth_threshold', payload: {}, status: 'delivered',
      }).returning({ id: notificationQueue.id })

      const mockEmitter = createMockEventEmitter()
      await deliverInboxNotification(queueEntry.id, orgId, mockEmitter)

      const inboxEntries = await withOrgAndUser(orgId, userId, (t) =>
        t.select().from(notificationInbox).where(eq(notificationInbox.userId, userId))
      )
      expect(inboxEntries).toHaveLength(0)  // no duplicate created
    })
  })

    it('inbox entries are isolated per org (dual RLS)', async () => {

    it('withOrg() after withOrgAndUser() does not leak user_id (regression test for AC-4)', async () => {
      await withTestOrg(async (tx, { orgId, userId }) => {
        // Seed an inbox entry
        await withOrgAndUser(orgId, userId, async (innerTx) => {
          await innerTx.insert(notificationInbox).values({...})
        })
        // Now query via withOrg() only (no user scope) — should return zero rows
        const leakedEntries = await withOrg(orgId, async (t) =>
          t.select().from(notificationInbox).where(eq(notificationInbox.orgId, orgId))
        )
        // RLS blocks this: app.current_user_id is '' after withOrg() resets it
        expect(leakedEntries).toHaveLength(0)
      })
    })
    const orgAId = await createTestOrg()
    const orgBId = await createTestOrg()
    const userId = await createTestUser()

    // Create inbox entry in org A
    await withOrgAndUser(orgAId, userId, async (tx) => {
      await tx.insert(notificationInbox).values({
        orgId: orgAId, userId, alertType: 'security.failed_auth_threshold',
        severity: 'warning', payload: { title: 'Test', body: 'Test body' },
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      })
    })

    // Try to read from org B context — should see nothing
    const inOrgB = await withOrgAndUser(orgBId, userId, async (tx) =>
      tx.select().from(notificationInbox).where(eq(notificationInbox.orgId, orgAId))
    )
    expect(inOrgB).toHaveLength(0)  // RLS blocks cross-org reads
  })
})
```

### API Route Tests (`modules/notifications/routes.test.ts` — extend)

```typescript
describe('GET /api/v1/notifications/inbox', () => {
  it('returns empty array when no inbox entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/inbox', headers: authHeaders(user) })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ data: [], page: 1, limit: 20 })
  })

  it('paginates results', async () => {
    // Seed 25 inbox entries
    // ...
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/inbox?page=2&limit=20', headers: authHeaders(user) })
    expect(JSON.parse(res.body).data).toHaveLength(5)
    expect(JSON.parse(res.body).page).toBe(2)
  })

  it('filters by status=unread', async () => {
    // Seed 2 unread + 1 read
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/inbox?status=unread', headers: authHeaders(user) })
    expect(JSON.parse(res.body).data).toHaveLength(2)
  })

  it('does not return dismissed entries', async () => {
    // Seed 1 active + 1 dismissed
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications/inbox?status=all', headers: authHeaders(user) })
    expect(JSON.parse(res.body).data).toHaveLength(1)
  })

  it('returns entries only for the authenticated user (not other users in same org)', async () => {
    // Seed entry for userA and userB in same org
    const resA = await app.inject({ method: 'GET', url: '/api/v1/notifications/inbox', headers: authHeaders(userA) })
    const resB = await app.inject({ method: 'GET', url: '/api/v1/notifications/inbox', headers: authHeaders(userB) })
    expect(JSON.parse(resA.body).data).toHaveLength(1)
    expect(JSON.parse(resB.body).data).toHaveLength(1)
    // Entries are different
    expect(JSON.parse(resA.body).data[0].id).not.toBe(JSON.parse(resB.body).data[0].id)
  })
})

describe('POST /api/v1/notifications/inbox/:id/read', () => {
  it('marks entry as read', async () => {
    const entryId = await seedInboxEntry(user)
    const res = await app.inject({ method: 'POST', url: `/api/v1/notifications/inbox/${entryId}/read`, headers: authHeaders(user) })
    expect(res.statusCode).toBe(204)
    // Confirm readAt is set
  })

  it('is idempotent: marking already-read entry returns 204', async () => {
    const entryId = await seedInboxEntry(user, { readAt: new Date() })
    const res = await app.inject({ method: 'POST', url: `/api/v1/notifications/inbox/${entryId}/read`, headers: authHeaders(user) })
    expect(res.statusCode).toBe(204)
  })

  it('returns 404 for entry belonging to another user', async () => {
    const entryId = await seedInboxEntry(userA)
    const res = await app.inject({ method: 'POST', url: `/api/v1/notifications/inbox/${entryId}/read`, headers: authHeaders(userB) })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/v1/users/me — unreadCount augmentation', () => {
  it('includes notifications.unreadCount in response', async () => {
    await seedInboxEntry(user)
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeaders(user) })
    const body = JSON.parse(res.body)
    expect(body.notifications).toBeDefined()
    expect(body.notifications.unreadCount).toBe(1)
  })

  it('unreadCount is 0 when no unread entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeaders(user) })
    expect(JSON.parse(res.body).notifications.unreadCount).toBe(0)
  })
})
```

### Purge Worker Test (`workers/notification-inbox-purge.test.ts`)

```typescript
describe('notification inbox purge', () => {
  it('deletes entries with expires_at in the past', async () => {
    // Seed 1 expired + 1 active
    await seedInboxEntry(user, { expiresAt: new Date(Date.now() - 1) })
    await seedInboxEntry(user, { expiresAt: new Date(Date.now() + 1000 * 60 * 60) })

    await runInboxPurge(mockLogger)

    // Only the active entry remains
    const remaining = await countInboxEntries(user)
    expect(remaining).toBe(1)
  })

  it('does not delete active (non-expired) entries', async () => {
    await seedInboxEntry(user, { expiresAt: new Date(Date.now() + 1000 * 60 * 60) })
    await runInboxPurge(mockLogger)
    expect(await countInboxEntries(user)).toBe(1)
  })
})
```

---

## AC-17: Out of Scope

| Deferred item | Story / Epic |
|---|---|
| WebSocket upgrade for real-time inbox | v2 — architecture explicitly defers WebSocket; SSE + polling is v1 |
| Per-notification action links (e.g., "Go to rotation") built with deep links | Epic 5/6/7 — implemented when the feature-specific alert types are delivered |
| Push notifications (browser push API, mobile) | v2 |
| Notification grouping / threading | v2 |
| Read receipts in audit log | Intentionally omitted — inbox read is not a security event; the audit log would become noise |
| SSE polling fallback for inbox (if SSE drops) | The existing SSE reconnect + `GET /api/v1/users/me` unreadCount serves this function. Dedicated polling for inbox is not needed. |

---

## Architecture Decisions

### ADR-3.3-01: SSE emit outside transaction (not inside)

**Decision**: The `emitSseEvent()` call in the inbox worker must happen AFTER the `withOrgAndUser()` transaction commits, not inside the transaction callback.

**Rationale**: If the SSE is emitted inside the transaction and the client immediately sends `GET /api/v1/notifications/inbox` (within milliseconds), the inbox entry may not yet be visible (transaction not committed). The client would see an unread count update but an empty inbox — a confusing phantom state.

**Implementation**: Return the `unreadCount` from the `withOrgAndUser()` block and call `emitSseEvent()` after it resolves. The delay between TX commit and SSE push is negligible (<1ms).

**Consequence**: There is a brief window (TX commit → SSE push) where the badge count is stale. This is acceptable — the count becomes correct when SSE fires.

### ADR-3.3-02: Dual RLS policy (org_id + user_id) — `withOrgAndUser()` helper

**Decision**: `notification_inbox` enforces RLS on both `org_id` AND `user_id`. A new `withOrgAndUser()` helper sets both `app.current_org_id` and `app.current_user_id` session variables. The existing `withOrg()` is modified to reset `app.current_user_id` to `''` to prevent stale user ID leakage.

**Rationale**: Inbox entries are private per-user. An org admin should not be able to read another member's inbox entries, even within the same org. The standard `withOrg()` helper only provides org isolation, which is insufficient here.

**Consequence**: Any future table that needs per-user privacy (not just per-org) must use `withOrgAndUser()`. This pattern is documented as the go-to for user-private data in this story.

### ADR-3.3-03: `projectId: ''` for org-level SSE events (no project scope)

**Decision**: The `emitSseEvent(emitter, event, projectId, orgId, data)` helper requires a `projectId`. For inbox notifications that are not project-scoped, pass `projectId: ''` (empty string).

**Rationale**: The architecture mandates `emitSseEvent()` as the only permitted emit path, and its signature includes `projectId`. Org-level events (security alerts, org-wide settings changes) don't have a meaningful `projectId`. Using `''` as a sentinel is explicit and avoids `null` TypeScript issues.

**Consequence**: The SSE route handler and `sse.svelte.ts` subscriber must pass org-level events (where `projectId === ''`) to all org members. Failing to handle this will cause org-level SSE events to be dropped silently. Add a unit test for this behavior.

### ADR-3.3-04: Soft dismiss (soft delete) for inbox entries

**Decision**: `DELETE /api/v1/notifications/inbox/:id` sets `dismissed_at`, not a hard delete. The purge job handles physical deletion when entries expire.

**Rationale**: Consistent with the soft-archive pattern used throughout the codebase (e.g., `archived_at` on credentials, `dismissed_at` on security alerts). Soft deletes prevent accidental permanent data loss from client bugs. The expiry purge handles cleanup.

**Consequence**: The inbox table accumulates `dismissed_at IS NOT NULL` entries until the purge job runs. These entries are excluded from all normal queries via the `WHERE dismissed_at IS NULL` partial indexes. The purge job must delete both expired+dismissed AND expired+undismissed entries.

### ADR-3.3-05: Svelte text interpolation (not `{@html}`) for inbox content — stored XSS prevention

**Decision**: The inbox page MUST render `notification.title` and `notification.body` using Svelte text interpolation (`{notification.title}`) NOT `{@html}`. The `renderTemplate()` function produces plain text for `inboxTitle` and `inboxBody` (no HTML tags). Using `{@html}` on any inbox content field is explicitly forbidden.

**Rationale**: `inboxTitle` and `inboxBody` are derived from alert payloads (e.g., user-provided data like email addresses, credential names). Even though templates use `escapeHtml()` (established in ADR-3.1-04), a defense-in-depth approach requires that the Svelte template also treats all inbox content as plain text. A future template that accidentally omits escaping would otherwise create a stored XSS vector visible to all users who receive that notification.

**Consequence**: Inbox entries cannot contain rich HTML formatting (bold, links, etc.). If rich formatting is needed in future, add a sanitized Markdown renderer (e.g., `marked` + `DOMPurify`) rather than raw HTML injection.

### ADR-3.3-06: EventEmitter threaded through `notification:deliver` worker handler

**Decision**: The shared `EventEmitter` (created at API startup and injected into the SSE route) is threaded through `notification:deliver` handler registration as a parameter: `'notification:deliver': (job) => notificationDeliverHandler(job, fastify.log, fastify.emitter)`. The `notificationDeliverHandler()` function signature must accept the emitter as a third parameter and pass it through to `deliverInboxNotification()`.

**Rationale**: The architecture mandates a single injected `EventEmitter` instance (not a module singleton) shared between the SSE route and pg-boss workers. Workers that emit SSE events (inbox delivery) must receive this emitter at registration time, not import a module-level singleton.

**Consequence**: `fastify.emitter` must be defined on the `FastifyInstance` type. Confirm the existing `plugins/sse.ts` or `app.ts` adds `emitter` to `FastifyInstance` via `fastify.decorate()`. If not present, add `fastify.decorate('emitter', createEventEmitter())` and the corresponding TypeScript declaration. The dev agent must verify this before implementing the inbox worker.

---

## Developer Pre-mortem: Likely Failure Points

1. **`app.current_user_id` not set in `withOrg()`**: If `withOrg()` is not modified to reset `app.current_user_id` to `''`, a request that calls `withOrg()` after a `withOrgAndUser()` call on the same connection could inherit the previous user ID. This would cause the dual-RLS policy on `notification_inbox` to match the stale user's entries. **Fix**: AC-4 explicitly modifies `withOrg()` to reset `app.current_user_id`. **Additional fix**: Add a regression test: call `withOrgAndUser(orgId, userId, ...)` followed immediately by `withOrg(orgId, ...)` and assert that a `notification_inbox` query inside `withOrg()` returns zero rows (not userId's entries).

2. **SSE filter drops org-level events (`projectId: ''`)**: The existing SSE stream handler likely filters events by `projectId` matching the user's current project context. An org-level notification with `projectId: ''` would be silently dropped. **Fix**: The SSE filter in `plugins/sse.ts` and `sse.svelte.ts` must explicitly pass-through events where `projectId === ''`.

3. **`GET /api/v1/users/me` location unknown**: The story says "modify the existing `users/me` endpoint" but the actual file path is not specified — it could be `modules/auth/routes.ts`, `modules/users/routes.ts`, or another location. The dev agent MUST find the actual file (use `Glob` or `Grep` for `/users/me`) rather than creating a new endpoint. Creating a second `users/me` route registration would cause a Fastify startup error.

4. **Inbox worker accesses `notification_queue` without org scope**: The initial queue entry fetch in `deliverInboxNotification()` uses `getDb()` (no org scope) to look up the queue entry by its `id`. This is intentional — the worker receives the queue entry ID and needs to fetch the record to get `orgId`. However, the cross-org `getDb()` lookup must be classified in `DIRECT_DB_ACCESS_CLASSIFICATIONS`. This is already covered by AC-12.

5. **`emitSseEvent()` signature mismatch for `notification.inbox`**: The `emitSseEvent()` helper takes `(emitter, event, projectId, orgId, data)`. If `notification.inbox` is not in `SsePayloadMap`, TypeScript will reject the call. **Fix**: AC-1 adds `notification.inbox` to `SsePayloadMap` BEFORE the worker is implemented (as required by architecture rules).

6. **Dismissed + expired entries not purged correctly**: The purge job uses `WHERE expires_at <= $1` without checking `dismissed_at`. This intentionally deletes ALL expired entries regardless of `dismissed_at` status — both dismissed and undismissed entries should be purged when expired. Confirm the purge query does NOT add `AND dismissed_at IS NULL` (which would leave expired-but-dismissed entries accumulating forever in the table).

7. **`notification:inbox-catchup` schedule missing**: Story 3.1 introduced `notification:email-catchup` and `notification:slack-catchup` crons for the outbox pattern. Story 3.3 must add `notification:inbox-catchup` (every 10 min) to scan for stale `channel='inbox'` pending entries. Without this, pg-boss job failures leave inbox entries stuck in `pending` indefinitely. Add this to Phase 6 Tasks.

8. **Badge count wrong after `mark-all-read` action**: `POST .../inbox/read-all` marks all entries as read in the DB but does not emit an SSE event. The frontend's `markAllReadLocally()` must be called in the `enhance` callback to synchronously update the Svelte state. If missing, the badge still shows a stale count until the next SSE push or page reload.

9. **Inbox page loads blank when user has no org**: If a user has no org association, `GET /api/v1/notifications/inbox` returns 403. The `+page.server.ts` `load` function must handle 403 gracefully (return empty state, not `error(403)`). Fixed in AC-15 with explicit `if (res.status === 403) return { notifications: [], ... }`.

10. **EventEmitter not threaded to `notification:deliver` handler**: The inbox worker needs the shared `EventEmitter` to emit SSE events. The `notification:deliver` handler in `main.ts` must receive `fastify.emitter` as a parameter. If `fastify.emitter` is not defined on the Fastify instance (requires a Fastify plugin or augmentation declaration), the TypeScript build will fail. **Fix**: Confirm that the existing SSE infrastructure (from Epic 1) already exposes `fastify.emitter` via `FastifyInstance` augmentation. If not, add the declaration as part of this story. Formalized in ADR-3.3-06.

11. **Dynamic import anti-pattern eliminated**: The story initially had `const { getDb } = await import('@project-vault/db')` inside `deliverInboxNotification()`. This was caught during self-consistency review (Method 2) and replaced with a static import at module level. Do NOT use dynamic imports inside worker functions.

---

## File Structure Summary

```
packages/shared/
  schemas/
    sse-payloads.ts             ← MODIFY: add 'notification.inbox': NotificationInboxPayload

packages/db/src/
  schema/
    notification-inbox.ts       ← CREATE
    index.ts                    ← MODIFY: export notificationInbox
  migrations/
    00ZZ_notification_inbox.sql ← CREATE (verify journal)
    meta/_journal.json          ← MODIFY
  index.ts                      ← MODIFY: add withOrgAndUser(); modify withOrg() to reset user_id

apps/api/src/
  config/
    env.ts                      ← MODIFY: add INBOX_RETENTION_DAYS
  notifications/
    templates/
      index.ts                  ← MODIFY: add renderTemplate() + inboxTitle + inboxBody
      security-failed-auth-threshold.ts ← MODIFY: export as named function
  workers/
    notification-inbox.ts       ← CREATE: deliverInboxNotification()
    notification-inbox-purge.ts ← CREATE: runInboxPurge()
    notification-deliver.ts     ← MODIFY: add case 'inbox': + thread emitter param
  modules/
    notifications/
      routes.ts                 ← MODIFY: add 4 inbox routes (GET/POST×2/DELETE)
      schema.ts                 ← MODIFY: add GetInboxQuerySchema, InboxEntrySchema, GetInboxResponseSchema
    auth/ (or users/)
      routes.ts                 ← MODIFY: augment GET /api/v1/users/me with notifications.unreadCount
  lib/
    route-exemptions.ts         ← MODIFY: add 4 ROUTE_ACTION_CLASSIFICATIONS + 2 DIRECT_DB_ACCESS
  main.ts                       ← MODIFY: register notification:inbox-purge schedule + worker;
                                           add emitter param to notification:deliver handler
  app.ts                        ← no change needed (notifications routes already registered)

apps/web/src/
  lib/
    state/
      notifications.svelte.ts   ← CREATE: unreadCount, subscribeToInboxEvents, markAllReadLocally
  routes/(app)/
    +layout.svelte              ← MODIFY: subscribe to notification.inbox SSE, render bell badge
    +layout.server.ts           ← MODIFY: include unreadCount from GET /api/v1/users/me
    notifications/              ← CREATE
      +page.server.ts           ← CREATE: load + actions (markRead, markAllRead, dismiss)
      +page.svelte              ← CREATE: inbox list UI

Test files:
  apps/api/src/workers/notification-inbox.test.ts          ← CREATE
  apps/api/src/workers/notification-inbox-purge.test.ts    ← CREATE
  apps/api/src/modules/notifications/routes.test.ts        ← MODIFY (add inbox route tests)
  packages/db/src/__tests__/notification-inbox-rls.test.ts ← CREATE (dual RLS isolation)
```

---

## Tasks

### Phase 1: Shared Types
- [ ] Add `NotificationInboxPayload` + `'notification.inbox'` to `SsePayloadMap` in `packages/shared/schemas/sse-payloads.ts` (AC-1)
- [ ] Run `pnpm typecheck` — `SsePayloadMap` change triggers typecheck on all consumers

### Phase 2: Database (TDD)
- [ ] **R3**: Read `packages/db/src/migrations/meta/_journal.json` for next free number
- [ ] Create `packages/db/src/schema/notification-inbox.ts` with dual-RLS indexes (AC-2)
- [ ] Export from `packages/db/src/schema/index.ts`
- [ ] Create migration `00ZZ_notification_inbox.sql` (AC-3)
- [ ] Update `meta/_journal.json`
- [ ] Modify `packages/db/src/index.ts`: add `withOrgAndUser()`, modify `withOrg()` to reset user_id (AC-4)
- [ ] Run `pnpm --filter @project-vault/db migrate` — confirm clean apply
- [ ] Write `packages/db/src/__tests__/notification-inbox-rls.test.ts` (AC-16)
- [ ] Verify dual RLS isolation tests pass

### Phase 3: env.ts
- [ ] Add `INBOX_RETENTION_DAYS` to `apps/api/src/config/env.ts` (AC-10)

### Phase 4: Templates (TDD)
- [ ] Modify `notifications/templates/security-failed-auth-threshold.ts` to export named function (AC-6)
- [ ] Create/update `notifications/templates/index.ts` with `renderTemplate()` + `inboxTitle`/`inboxBody` (AC-6)

### Phase 5: Workers (TDD)
- [ ] Write `workers/notification-inbox.test.ts` first (AC-16)
- [ ] Create `apps/api/src/workers/notification-inbox.ts` with `deliverInboxNotification()` (AC-5)
- [ ] Modify `notification-deliver.ts`: add `case 'inbox'` + thread emitter param (AC-5)
- [ ] Verify inbox worker tests pass (delivery, idempotency, RLS isolation, SSE emit)
- [ ] Write `workers/notification-inbox-purge.test.ts`
- [ ] Create `apps/api/src/workers/notification-inbox-purge.ts` (AC-9)
- [ ] Verify purge tests pass

### Phase 6: API Routes (TDD)
- [ ] Add `GetInboxQuerySchema`, `InboxEntrySchema`, `GetInboxResponseSchema` to `modules/notifications/schema.ts` (AC-8)
- [ ] Add 4 inbox routes to `modules/notifications/routes.ts` (AC-7)
- [ ] **Find** `GET /api/v1/users/me` location via Grep; modify to add `notifications.unreadCount` (AC-11)
- [ ] Add 4 `ROUTE_ACTION_CLASSIFICATIONS` + 2 `DIRECT_DB_ACCESS_CLASSIFICATIONS` (AC-12)
- [ ] Thread `emitter` param through `notification:deliver` handler in `main.ts` (AC-5)
- [ ] Register `notification:inbox-purge` schedule + worker in `main.ts` (AC-9)
- [ ] Add `notification:inbox-catchup` schedule (every 10 min) to `main.ts` — extends ADR-3.1-06 outbox pattern to inbox channel
- [ ] Write/extend `modules/notifications/routes.test.ts` (AC-16)
- [ ] Verify all route tests pass + `route-audit.test.ts` passes for 4 new routes

### Phase 7: Frontend
- [ ] Create `lib/state/notifications.svelte.ts` (AC-13)
- [ ] Modify `(app)/+layout.server.ts` to include `unreadCount` (AC-14)
- [ ] Modify `(app)/+layout.svelte` to subscribe to inbox events + render bell badge (AC-14)
- [ ] Create `(app)/notifications/+page.server.ts` (AC-15)
- [ ] Create `(app)/notifications/+page.svelte` (AC-15)
- [ ] Manual smoke test: badge shows in nav, inbox page loads, mark read/dismiss work

### Phase 8: Full CI Sweep
- [ ] `pnpm typecheck` — no errors
- [ ] `pnpm lint` — no errors
- [ ] `pnpm test` — all tests pass
- [ ] `route-audit.test.ts` passes for 4 new routes
- [ ] `check-rls-coverage.ts` passes for `notification_inbox` table

---

## Previous Story Intelligence (From Stories 3.1 and 3.2)

- The `notification:deliver` worker in Story 3.1 stubs `case 'inbox'` with a comment "Story 3.3 will add the inbox delivery path." Story 3.3 fills this stub. The worker registration in `main.ts` already exists.
- Story 3.2's `dispatchOrgAdminNotification()` creates `notification_queue channel='inbox'` entries when user preferences include `channel='inbox'`. The dispatcher is already wired.
- Story 3.2 added `notification_preferences` with `channel='inbox'` as a valid value. The default preference (all users) includes `channel='inbox'`. This means from day one, every user will have inbox entries delivered automatically.
- Story 3.1's `notification:email-catchup` and `notification:slack-catchup` schedules already exist for email/slack. Story 3.3 should add `notification:inbox-catchup` (every 10 min) for inbox entries that are stuck in `pending` with `channel='inbox'`.
- The `withJobLogging()` pattern used in notification workers (from Story 1.10) applies to `notification-inbox-purge.ts` as well.
- The `setEmailTransportForTesting()` export pattern from `notification-email.ts` is a test helper precedent; similarly expose `setEmitterForTesting(emitter)` from `notification-inbox.ts` for test isolation.

---

## Dev Agent Record

> **Fill in this section as you implement each phase.**

### Decisions Made During Implementation
*(To be filled by dev agent)*

### Problems Encountered
*(To be filled by dev agent)*

### Test Coverage Achieved
*(To be filled by dev agent)*

### Files Changed
*(To be filled by dev agent)*

### Notes for Story 3.4+ / Future Work
*(Dev agent: document any SSE infrastructure changes, RLS helper additions, or template registry expansions that affect future stories)*
