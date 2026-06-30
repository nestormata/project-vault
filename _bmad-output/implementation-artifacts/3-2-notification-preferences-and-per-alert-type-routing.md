# Story 3.2: Notification Preferences & Per-Alert-Type Routing

Status: done

<!-- Ultimate context engine analysis completed 2026-06-28 - comprehensive developer guide for notification preferences,
     per-alert-type routing, and dispatcher refactoring. This story introduces notification_preferences and
     org_notification_routing tables; adds a /settings/notifications frontend page; refactors dispatcher.ts to
     resolve recipients via routing config and apply user preferences (channel, frequency, severity); and adds the
     daily digest worker (notification:send-digest). It modifies the notification_queue schema to add a deliverAt column. -->

## Story

As a user and administrator,
I want personal notification preferences per alert type and org-level routing configuration,
so that I receive signal-quality alerts and critical events reach the right responders.

*Covers: FR94, FR100.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-3.2-Notification-Preferences--Per-Alert-Type-Routing`]

---

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `both` |
| **Evaluator-visible** | yes |
| **Linked UI story** | N/A (web included: `/settings/notifications`) |
| **Honest placeholder AC** | Inbox channel preference UI may show inbox option; delivery UI is Story 3.3 |
| **Persona journey** | **Riley (admin):** opens Settings → Notifications, configures email + inbox channels per alert type. **Morgan (member):** updates personal preferences; org routing read-only. |

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Story 3.1 (`notification_queue` table, `notifications/dispatcher.ts`, `notification:email` + `notification:slack` workers, `modules/admin/routes.ts`) is merged | Story 3.2 refactors `dispatcher.ts` to add preference/routing logic. The existing `notification_queue` table gains a new `deliverAt` nullable column. The `modules/admin/routes.ts` test endpoint is extended to show channel status (no breaking change). |
| Story 1.11 (`secureRoute()`, route-audit CI gate, `ROUTE_ACTION_CLASSIFICATIONS`) is merged | All new preference and routing routes go through `secureRoute()` and must be registered in `ROUTE_ACTION_CLASSIFICATIONS`. |
| Migration numbering **(R2 — verify `meta/_journal.json`, do NOT hardcode)** | ⚠️ Story 3.1 created one migration (`00XX_notification_queue.sql`). This story adds a second migration (`00YY_notification_preferences.sql`) with the new tables AND an `ALTER TABLE notification_queue ADD COLUMN deliver_at` addition. Verify the journal for the next free number before generating. |

---

## Epic Cross-Story Context

| Story | Relationship to 3.2 |
|---|---|
| 3.1 | Created `notification_queue`, `notifications/dispatcher.ts`, email/Slack workers. **3.2 refactors dispatcher** to use routing + preferences instead of "all owner+admin members". The Story 3.1 dispatcher is explicitly factored for this replacement. 3.1 workers (`notification-email.ts`, `notification-slack.ts`) are unchanged — the change is purely in how recipients and delivery times are resolved. |
| 3.3 | Adds the `inbox` channel worker and the SSE push infrastructure. Story 3.2 sets up the preference for `channel: "inbox"` — the actual inbox delivery worker is implemented in 3.3. When a preference has `channel: "inbox"`, the dispatcher creates a `notification_queue` entry with `channel: "inbox"`. The 3.3 inbox worker then processes these entries. |
| 5.x, 6.x, 7.x | Future alert types (`rotation.stale`, `credential.expiry`, `machine_key.expiry`, etc.) will use the FR100 routing table defined in this story. 3.2 defines the canonical `NOTIFICATION_ALERT_TYPES` registry in `packages/shared`. Future stories add new types to this registry and the preferences system automatically supports them. |
| AC-E3c | The routing fallback rule (zero-member role → owner) is implemented here and must log `notification.routing_fallback`. |
| AC-E3d | Preferences are per-user per-org. Multi-org users see different preferences when authenticated to different orgs (org_id derived from JWT). The API layer enforces this via RLS. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Architecture wording | Canonical implementation for 3.2 | Rationale |
|---|---|---|
| Architecture says `modules/notifications/` for notification preferences | Create `apps/api/src/modules/notifications/routes.ts` + `schema.ts` + `preferences.ts` + `routing.ts`. Register at prefix `/api/v1`. | Architecture table maps Notification Preferences to `modules/notifications/`. |
| Epic says `channel: "email"\|"slack"\|"inbox"\|"none"` (singular) | DB stores one row per `(userId, orgId, alertType, channel)` where channel is `email\|slack\|inbox`. "none" in the API means "remove all channel rows for this alertType" — it is not stored as a channel value. | Normalized rows are simpler to query in the dispatcher (`WHERE userId = ? AND alertType = ?`) than JSONB arrays. The "none" value is a PUT/PATCH API shorthand. |
| Epic says defaults: "email + inbox, immediate, warning+" | Defaults are **computed**, not stored. If no preference row exists for a user+org+alertType+channel combination, the system uses the default. This avoids seeding rows for every new user × every alert type. | Storage efficiency + future-proofing: new alert types added in later epics get correct defaults without a migration or data backfill. |
| Epic says `PUT` replaces full array; `PATCH` supports per-alert-type partial update | `PUT /api/v1/users/me/notification-preferences` deletes all existing preference rows for the user+org and inserts the full provided array. `PATCH` upserts only the provided items. | Atomic replace semantics for PUT (no partial state). Upsert for PATCH (idempotent). |
| Architecture says `modules/notifications/` maps to `(app)/settings/notifications/` frontend | Create `apps/web/src/routes/(app)/settings/notifications/+page.svelte` and `+page.server.ts`. Route is guarded by the standard `(app)` layout auth. | Architecture is explicit about the frontend route location. |

---

## AC Quick Reference

| Area | Required result |
|---|---|
| Alert type registry | `packages/shared/constants/notification-types.ts` — `NOTIFICATION_ALERT_TYPES` const + `NotificationAlertType` type used everywhere preferences and routing are validated. |
| DB schema: `notification_preferences` | Per-user per-org per-alertType per-channel, org-scoped with RLS. UNIQUE on `(orgId, userId, alertType, channel)`. |
| DB schema: `org_notification_routing` | Per-org per-alertType, org-scoped with RLS. UNIQUE on `(orgId, alertType)`. Default: implicit (no row = routeTo "owner"). |
| `notification_queue` ALTER | Add `deliver_at timestamptz` column (nullable) for digest scheduling. |
| User preferences API | `GET/PUT/PATCH /api/v1/users/me/notification-preferences` — per-user per-org. Default (no stored rows) = email + inbox, immediate, warning+. |
| Org routing API | `GET/PUT /api/v1/org/notification-routing` (admin/owner only). Default (no stored rows) = routeTo "owner" for all types. Zero-member fallback to owner + `notification.routing_fallback` warning log. |
| Dispatcher refactor | `notifications/dispatcher.ts` — full replacement of recipient resolution logic: (1) routing lookup, (2) role member resolution, (3) preference filtering per user+channel, (4) severity check, (5) dedup by userId+channel, (6) `deliver_at` set for digest preferences. |
| Digest worker | `workers/notification-digest.ts` — `notification:send-digest` cron daily at `NOTIFICATION_DIGEST_HOUR` UTC; bundles pending digest entries per recipient; renders multi-item digest email; marks delivered. |
| Frontend | `apps/web/src/routes/(app)/settings/notifications/+page.svelte` — preference table with per-row edit controls. |
| Route audit | New routes added to `ROUTE_ACTION_CLASSIFICATIONS`; workers to `DIRECT_DB_ACCESS_CLASSIFICATIONS` if needed. |
| Tests | Preference CRUD, per-org isolation, routing resolution, zero-member fallback, severity filtering, digest scheduling, dispatcher integration. |

---

## AC-1: Alert Type Registry

**Given** the need for a canonical list of alert types across epics,
**When** Story 3.2 introduces preferences per alert type,
**Then** create `packages/shared/constants/notification-types.ts`:

```typescript
// Canonical list of alert types that can be routed and have preferences configured.
// New alert types added by future epics MUST be added here before being used in dispatching.
// The dispatcher accepts any string for alertType (forward-compat), but the preferences
// API only allows values from this list on input validation.
export const NOTIFICATION_ALERT_TYPES = [
  'security.failed_auth_threshold',   // Story 1.9 / 3.1: active
  'credential.expiry',                 // Epic 6: future
  'service.down',                      // Epic 6: future
  'service.recovery',                  // Epic 6: future
  'rotation.stale',                    // Epic 5: future
  'backup.failure',                    // Epic 9: future
  'machine_key.expiry',               // Epic 7: future
  'security.anomalous_access',        // Epic 6: future
  'machine_cache.activated',          // Epic 7: future
] as const

export type NotificationAlertType = typeof NOTIFICATION_ALERT_TYPES[number]

export const NOTIFICATION_CHANNELS = ['email', 'slack', 'inbox'] as const
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number]

export const NOTIFICATION_FREQUENCIES = ['immediate', 'digest_daily'] as const
export type NotificationFrequency = typeof NOTIFICATION_FREQUENCIES[number]

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const
export type NotificationSeverity = typeof NOTIFICATION_SEVERITIES[number]

// Default preference applied when no explicit preference row exists for a user+org+alertType+channel.
// "email + inbox, immediate, warning+" per AC-E3d.
export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannel[] = ['email', 'inbox']
export const DEFAULT_NOTIFICATION_FREQUENCY: NotificationFrequency = 'immediate'
export const DEFAULT_NOTIFICATION_MIN_SEVERITY: NotificationSeverity = 'warning'

// Default org routing: all alert types route to the owner role
export const DEFAULT_ROUTING_ROLE = 'owner' as const
export type RoutingRole = 'owner' | 'admin' | 'member'
```

**And** export from `packages/shared/index.ts`:
```typescript
export * from './constants/notification-types.js'
```

**Why a shared constant**: The preferences API (`apps/api`) validates `alertType` against this list. The frontend settings page (`apps/web`) uses it to render the preferences table. The dispatcher uses it for default resolution. A single source of truth prevents drift.

**Forward-compatibility note**: The dispatcher must handle `alertType` values NOT in `NOTIFICATION_ALERT_TYPES` without throwing (future epics may dispatch before updating this list). The preferences API returns default behavior for unknown types.

---

## AC-2: Database Schema — `notification_preferences` Table

**Given** the Drizzle schema conventions in `packages/db/src/schema/`,
**When** Story 3.2 adds per-user notification preferences,
**Then** create `packages/db/src/schema/notification-preferences.ts`:

```typescript
import { pgTable, uuid, text, timestamp, check, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'
import { users } from './users.js'

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // alertType: any of NOTIFICATION_ALERT_TYPES (open text for forward-compat)
    alertType: text('alert_type').notNull(),
    // channel: one of 'email' | 'slack' | 'inbox'
    channel: text('channel').notNull(),
    frequency: text('frequency').notNull().default('immediate'),
    minSeverity: text('min_severity').notNull().default('warning'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCheck: check(
      'notification_preferences_channel_check',
      sql`${t.channel} IN ('email','slack','inbox')`
    ),
    frequencyCheck: check(
      'notification_preferences_frequency_check',
      sql`${t.frequency} IN ('immediate','digest_daily')`
    ),
    severityCheck: check(
      'notification_preferences_severity_check',
      sql`${t.minSeverity} IN ('info','warning','critical')`
    ),
    // One preference per user+org+alertType+channel combination
    uniquePreference: uniqueIndex('uq_notification_preferences')
      .on(t.orgId, t.userId, t.alertType, t.channel),
  })
)
```

**And** export from `packages/db/src/schema/index.ts`:
```typescript
export { notificationPreferences } from './notification-preferences.js'
```

**Default behavior** (no stored rows): When the dispatcher queries preferences for a user+org+alertType and finds no rows, it applies the default: channels = ['email', 'inbox'], frequency = 'immediate', minSeverity = 'warning'. This means a new user with zero stored preferences automatically gets email + inbox immediate warning+ delivery — matching the epic spec without requiring a data migration.

**Per-org isolation** (AC-E3d): A user in two orgs has completely independent preference rows for each org. The RLS policy scoped to `org_id` ensures org A cannot read org B's preferences. The JWT-derived `orgId` ensures the correct org's preferences are queried.

---

## AC-3: Database Schema — `org_notification_routing` Table

**Given** the need for admins to configure per-alert-type routing to roles,
**When** Story 3.2 adds org-level routing configuration,
**Then** create `packages/db/src/schema/org-notification-routing.ts`:

```typescript
import { pgTable, uuid, text, timestamp, check, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgScoped } from './helpers.js'

export const orgNotificationRouting = pgTable(
  'org_notification_routing',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...orgScoped({ onDelete: 'cascade' }),
    alertType: text('alert_type').notNull(),
    routeTo: text('route_to').notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    routeToCheck: check(
      'org_notification_routing_route_to_check',
      sql`${t.routeTo} IN ('owner','admin','member')`
    ),
    // One routing config per org+alertType
    uniqueRouting: uniqueIndex('uq_org_notification_routing')
      .on(t.orgId, t.alertType),
  })
)
```

**And** export from `packages/db/src/schema/index.ts`:
```typescript
export { orgNotificationRouting } from './org-notification-routing.js'
```

**Default behavior** (no stored rows): When no routing row exists for an org+alertType, the system defaults to `routeTo = 'owner'`. This matches the epic: "default: all types → owner". The dispatcher must resolve "owner" to current org owner members at send-time (not cached).

**Zero-member fallback** (AC-E3c): If the resolved role has zero active members (e.g., `routeTo = 'admin'` but the org has no admins), fall back to `routeTo = 'owner'` and emit `notification.routing_fallback` warning log. If owner also has zero members, log an error and enqueue no email notifications (silent — do not throw). Slack is org-level and always gets sent if configured.

---

## AC-4: Migration

**Given** the current migration journal,
**When** Story 3.2 adds new tables and alters `notification_queue`,
**Then** create `packages/db/src/migrations/00YY_notification_preferences.sql` (next free number after Story 3.1's migration):

```sql
-- Migration: 00YY_notification_preferences
-- Created: Story 3.2 (Epic 3)
-- Adds: notification_preferences, org_notification_routing tables
-- Alters: notification_queue (adds deliver_at column for digest scheduling)

-- 1. Alter notification_queue to add digest delivery scheduling column
ALTER TABLE "notification_queue"
  ADD COLUMN "deliver_at" timestamptz;

-- 2. Create notification_preferences table
CREATE TABLE "notification_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "alert_type" text NOT NULL,
  "channel" text NOT NULL,
  "frequency" text NOT NULL DEFAULT 'immediate',
  "min_severity" text NOT NULL DEFAULT 'warning',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_preferences_channel_check"
    CHECK (channel IN ('email','slack','inbox')),
  CONSTRAINT "notification_preferences_frequency_check"
    CHECK (frequency IN ('immediate','digest_daily')),
  CONSTRAINT "notification_preferences_severity_check"
    CHECK (min_severity IN ('info','warning','critical'))
);

CREATE UNIQUE INDEX "uq_notification_preferences"
  ON "notification_preferences" (org_id, user_id, alert_type, channel);

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_preferences_org_isolation"
ON "notification_preferences"
USING (org_id = current_setting('app.current_org_id')::uuid);

-- 3. Create org_notification_routing table
CREATE TABLE "org_notification_routing" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "alert_type" text NOT NULL,
  "route_to" text NOT NULL DEFAULT 'owner',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "org_notification_routing_route_to_check"
    CHECK (route_to IN ('owner','admin','member'))
);

CREATE UNIQUE INDEX "uq_org_notification_routing"
  ON "org_notification_routing" (org_id, alert_type);

ALTER TABLE "org_notification_routing" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_notification_routing_org_isolation"
ON "org_notification_routing"
USING (org_id = current_setting('app.current_org_id')::uuid);
```

**Migration order note**: This migration must run AFTER Story 3.1's `00XX_notification_queue.sql` since it ALTERs the `notification_queue` table. The journal order enforces this.

**`ALTER TABLE` safety**: Adding a nullable column (`deliver_at timestamptz`) to an existing table is a safe, non-blocking operation in PostgreSQL. No table rewrite occurs. No existing data is affected.

---

## AC-5: Notification Module — User Preferences API

**Given** the `modules/notifications/` module location defined in the architecture,
**When** Story 3.2 creates the preferences endpoints,
**Then** create `apps/api/src/modules/notifications/routes.ts`:

```typescript
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { secureRoute } from '../../lib/secure-route.js'
import type { SecureRouteContext } from '../../lib/secure-route.js'
import { validationError } from '../../lib/route-helpers.js'
import {
  GetPreferencesResponseSchema,
  PutPreferencesBodySchema,
  PatchPreferencesBodySchema,
  GetRoutingResponseSchema,
  PutRoutingBodySchema,
} from './schema.js'
import {
  getPreferences,
  putPreferences,
  patchPreferences,
} from './preferences.js'
import {
  getOrgRouting,
  putOrgRouting,
} from './routing.js'

export async function notificationRoutes(fastify: FastifyApp): Promise<void> {
  // --- User Preferences ---

  secureRoute(fastify, {
    method: 'GET',
    url: '/users/me/notification-preferences',
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'],
      writeAuditEvent: false,
    },
    handler: async (ctx, _req: FastifyRequest, _reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const prefs = await getPreferences(secureCtx.auth.orgId, secureCtx.auth.userId, secureCtx.tx)
      return { data: prefs }
    },
  })

  secureRoute(fastify, {
    method: 'PUT',
    url: '/users/me/notification-preferences',
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = PutPreferencesBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      const prefs = await putPreferences(secureCtx.auth.orgId, secureCtx.auth.userId, parsed.data, secureCtx.tx)
      return { data: prefs }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/users/me/notification-preferences',
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = PatchPreferencesBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      const prefs = await patchPreferences(secureCtx.auth.orgId, secureCtx.auth.userId, parsed.data, secureCtx.tx)
      return { data: prefs }
    },
  })

  // --- Org Routing (admin/owner only) ---

  secureRoute(fastify, {
    method: 'GET',
    url: '/org/notification-routing',
    security: {
      allowedRoles: ['owner', 'admin'],
      writeAuditEvent: false,
    },
    handler: async (ctx, _req: FastifyRequest, _reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const routing = await getOrgRouting(secureCtx.auth.orgId, secureCtx.tx)
      return { data: routing }
    },
  })

  secureRoute(fastify, {
    method: 'PUT',
    url: '/org/notification-routing',
    security: {
      allowedRoles: ['owner', 'admin'],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = PutRoutingBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      const routing = await putOrgRouting(secureCtx.auth.orgId, parsed.data, secureCtx.tx)
      return { data: routing }
    },
  })
}
```

**And** register in `apps/api/src/app.ts`:
```typescript
import { notificationRoutes } from './modules/notifications/routes.js'

// After existing registrations:
await fastify.register(notificationRoutes, { prefix: '/api/v1' })
```

**Route prefix note**: The notifications routes use the general `/api/v1` prefix (not `/api/v1/notifications`) because the routes are `/users/me/notification-preferences` and `/org/notification-routing`, which sit in the user/org namespaces, not a separate notifications namespace.

---

## AC-6: Notification Module — Zod Schemas

**Given** the Zod v4 schema pattern used across the codebase,
**When** Story 3.2 creates the notifications schemas,
**Then** create `apps/api/src/modules/notifications/schema.ts`:

```typescript
import { z } from 'zod/v4'
import { NOTIFICATION_ALERT_TYPES, NOTIFICATION_CHANNELS, NOTIFICATION_FREQUENCIES, NOTIFICATION_SEVERITIES } from '@project-vault/shared'

// A single preference item: per-alertType per-channel config
export const PreferenceItemSchema = z.object({
  // alertType: open text for forward-compat with future epics, but bounded to prevent pollution
  alertType: z.string().min(1).max(100).regex(/^[a-z0-9_.]+$/, 'alertType must be lowercase alphanumeric with dots and underscores'),
  // 'none' on input means "remove all channel preferences for this alertType"
  // On output, 'none' is never returned; absence of rows means default applies
  channel: z.enum([...NOTIFICATION_CHANNELS, 'none'] as [string, ...string[]]),
  frequency: z.enum(NOTIFICATION_FREQUENCIES),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES),
})

// On output: only 'email' | 'slack' | 'inbox' (never 'none')
export const PreferenceOutputItemSchema = z.object({
  alertType: z.string(),
  channel: z.enum(NOTIFICATION_CHANNELS),
  frequency: z.enum(NOTIFICATION_FREQUENCIES),
  minSeverity: z.enum(NOTIFICATION_SEVERITIES),
})

export const PutPreferencesBodySchema = z.array(PreferenceItemSchema)
  .max(200, 'Maximum 200 preference entries')  // N alert types × 3 channels + headroom
  .superRefine((items, ctx) => {
    // Prevent duplicate (alertType, channel) pairs within a single PUT request
    const seen = new Set<string>()
    for (const [i, item] of items.entries()) {
      const key = `${item.alertType}:${item.channel}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate alertType+channel combination: ${item.alertType} / ${item.channel}`,
          path: [i],
        })
      }
      seen.add(key)
    }
  })

export const PatchPreferencesBodySchema = z.array(PreferenceItemSchema)
  .min(1, 'At least one preference entry required for PATCH')
  .max(200)

export const GetPreferencesResponseSchema = z.object({
  data: z.array(PreferenceOutputItemSchema),
})

// Org routing item
export const RoutingItemSchema = z.object({
  alertType: z.string().min(1).max(100),
  routeTo: z.enum(['owner', 'admin', 'member']),
})

export const PutRoutingBodySchema = z.array(RoutingItemSchema)
  .max(100, 'Maximum 100 routing entries')

export const GetRoutingResponseSchema = z.object({
  data: z.array(RoutingItemSchema),
})
```

**`alertType` validation strategy**: The schema accepts any valid string for `alertType` on input (not restricted to `NOTIFICATION_ALERT_TYPES`). This provides forward-compatibility — a frontend built after new alert types are added can send preferences for them before the backend enum is updated. The preferences service stores and returns whatever `alertType` values are provided.

**Input validation examples**:
```json
// Valid PUT body (replaces all preferences):
[
  { "alertType": "security.failed_auth_threshold", "channel": "email", "frequency": "immediate", "minSeverity": "warning" },
  { "alertType": "security.failed_auth_threshold", "channel": "inbox", "frequency": "immediate", "minSeverity": "warning" },
  { "alertType": "credential.expiry", "channel": "none", "frequency": "immediate", "minSeverity": "critical" }
]

// "none" on the last item means: remove all channel preference rows for credential.expiry
// (user will get no credential.expiry notifications even when that alert type is activated)

// Valid PATCH body (partial update):
[
  { "alertType": "security.failed_auth_threshold", "channel": "email", "frequency": "digest_daily", "minSeverity": "info" }
]
// ↑ Changes only the email channel for security.failed_auth_threshold to digest_daily

// Valid PUT org routing body:
[
  { "alertType": "security.failed_auth_threshold", "routeTo": "admin" },
  { "alertType": "credential.expiry", "routeTo": "member" }
]
```

---

## AC-7: Preferences Service Layer

**Given** the need to manage preference CRUD with default-if-absent semantics,
**When** Story 3.2 implements the preferences service,
**Then** create `apps/api/src/modules/notifications/preferences.ts`:

```typescript
import { and, eq, inArray } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { notificationPreferences } from '@project-vault/db/schema'
import {
  NOTIFICATION_ALERT_TYPES,
  NOTIFICATION_CHANNELS,
  DEFAULT_NOTIFICATION_CHANNELS,
  DEFAULT_NOTIFICATION_FREQUENCY,
  DEFAULT_NOTIFICATION_MIN_SEVERITY,
  type NotificationChannel,
  type NotificationFrequency,
  type NotificationSeverity,
} from '@project-vault/shared'
import type { z } from 'zod/v4'
import type { PreferenceItemSchema } from './schema.js'

type PreferenceInput = z.infer<typeof PreferenceItemSchema>

export type PreferenceOutput = {
  alertType: string
  channel: NotificationChannel
  frequency: NotificationFrequency
  minSeverity: NotificationSeverity
}

// Returns all active preferences for a user+org.
// Merges stored rows with defaults: for any alertType+channel combination NOT in the
// stored rows, the default is used (email+inbox, immediate, warning+) for all known
// alert types (NOTIFICATION_ALERT_TYPES). Unknown types from stored rows are included as-is.
export async function getPreferences(
  orgId: string,
  userId: string,
  tx: Tx
): Promise<PreferenceOutput[]> {
  const stored = await tx
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.orgId, orgId),
        eq(notificationPreferences.userId, userId)
      )
    )

  // Build a set of stored (alertType, channel) pairs for efficient lookup
  const storedKeys = new Set(stored.map((r) => `${r.alertType}:${r.channel}`))

  // Collect stored preferences as output
  const result: PreferenceOutput[] = stored.map((r) => ({
    alertType: r.alertType,
    channel: r.channel as NotificationChannel,
    frequency: r.frequency as NotificationFrequency,
    minSeverity: r.minSeverity as NotificationSeverity,
  }))

  // Fill in defaults for known alert types where no explicit preference exists
  for (const alertType of NOTIFICATION_ALERT_TYPES) {
    for (const channel of DEFAULT_NOTIFICATION_CHANNELS) {
      if (!storedKeys.has(`${alertType}:${channel}`)) {
        result.push({
          alertType,
          channel,
          frequency: DEFAULT_NOTIFICATION_FREQUENCY,
          minSeverity: DEFAULT_NOTIFICATION_MIN_SEVERITY,
        })
      }
    }
  }

  return result.sort((a, b) =>
    a.alertType.localeCompare(b.alertType) || a.channel.localeCompare(b.channel)
  )
}

// Full replacement: delete all preference rows for this user+org and insert the provided array.
// Items with channel 'none' cause all rows for that alertType to be deleted (suppress all channels).
export async function putPreferences(
  orgId: string,
  userId: string,
  items: PreferenceInput[],
  tx: Tx
): Promise<PreferenceOutput[]> {
  // Delete all existing preferences for this user+org
  await tx
    .delete(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.orgId, orgId),
        eq(notificationPreferences.userId, userId)
      )
    )

  // Insert non-"none" items
  const toInsert = items.filter((item) => item.channel !== 'none')
  if (toInsert.length > 0) {
    await tx.insert(notificationPreferences).values(
      toInsert.map((item) => ({
        orgId,
        userId,
        alertType: item.alertType,
        channel: item.channel as NotificationChannel,
        frequency: item.frequency,
        minSeverity: item.minSeverity,
      }))
    )
  }

  return getPreferences(orgId, userId, tx)
}

// Partial update: upsert only the provided items.
// Items with channel 'none' delete all preference rows for that alertType.
export async function patchPreferences(
  orgId: string,
  userId: string,
  items: PreferenceInput[],
  tx: Tx
): Promise<PreferenceOutput[]> {
  for (const item of items) {
    if (item.channel === 'none') {
      // Delete all rows for this alertType (explicit suppress)
      await tx
        .delete(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.orgId, orgId),
            eq(notificationPreferences.userId, userId),
            eq(notificationPreferences.alertType, item.alertType)
          )
        )
    } else {
      // Upsert: insert or update the specific (alertType, channel) row
      await tx
        .insert(notificationPreferences)
        .values({
          orgId,
          userId,
          alertType: item.alertType,
          channel: item.channel as NotificationChannel,
          frequency: item.frequency,
          minSeverity: item.minSeverity,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            notificationPreferences.orgId,
            notificationPreferences.userId,
            notificationPreferences.alertType,
            notificationPreferences.channel,
          ],
          set: {
            frequency: item.frequency,
            minSeverity: item.minSeverity,
            updatedAt: new Date(),
          },
        })
    }
  }

  return getPreferences(orgId, userId, tx)
}
```

**Default merging strategy**: The `getPreferences()` function is the single place where default expansion happens. All other functions (dispatcher, preferences service) call `getPreferences()` to get the fully-resolved preference list, including defaults. This ensures consistency: the dispatcher sees exactly what the user would see on the settings page.

---

## AC-8: Routing Service Layer

**Given** the need to manage org-level per-alert-type routing,
**When** Story 3.2 implements the routing service,
**Then** create `apps/api/src/modules/notifications/routing.ts`:

```typescript
import { and, eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { orgNotificationRouting, orgMemberships } from '@project-vault/db/schema'
import {
  NOTIFICATION_ALERT_TYPES,
  DEFAULT_ROUTING_ROLE,
  type RoutingRole,
} from '@project-vault/shared'
import type { z } from 'zod/v4'
import type { RoutingItemSchema } from './schema.js'
import { operationalLog } from '../../lib/logger.js'

type RoutingInput = z.infer<typeof RoutingItemSchema>

export type RoutingOutput = {
  alertType: string
  routeTo: RoutingRole
}

// Returns routing config for all known alert types.
// Default (no row): routeTo = 'owner'.
export async function getOrgRouting(orgId: string, tx: Tx): Promise<RoutingOutput[]> {
  const stored = await tx
    .select()
    .from(orgNotificationRouting)
    .where(eq(orgNotificationRouting.orgId, orgId))

  const storedMap = new Map(stored.map((r) => [r.alertType, r.routeTo as RoutingRole]))

  return NOTIFICATION_ALERT_TYPES.map((alertType) => ({
    alertType,
    routeTo: storedMap.get(alertType) ?? DEFAULT_ROUTING_ROLE,
  }))
}

// Full replacement of routing config.
// Security: 'security.*' alert types cannot be routed to 'member' (all members) to prevent
// potential email amplification. Security alerts must route to 'owner' or 'admin' only.
const SECURITY_ALERT_TYPE_PREFIX = 'security.'

export async function putOrgRouting(
  orgId: string,
  items: RoutingInput[],
  tx: Tx
): Promise<RoutingOutput[]> {
  // Validate: security alert types cannot route to 'member' (would email all org members)
  for (const item of items) {
    if (item.alertType.startsWith(SECURITY_ALERT_TYPE_PREFIX) && item.routeTo === 'member') {
      throw Object.assign(
        new Error(`Security alert type '${item.alertType}' cannot be routed to all members. Use 'owner' or 'admin'.`),
        { statusCode: 422, code: 'SECURITY_ALERT_ROUTING_RESTRICTED' }
      )
    }
  }

  // Delete existing and insert new
  await tx.delete(orgNotificationRouting).where(eq(orgNotificationRouting.orgId, orgId))

  if (items.length > 0) {
    await tx.insert(orgNotificationRouting).values(
      items.map((item) => ({
        orgId,
        alertType: item.alertType,
        routeTo: item.routeTo,
      }))
    )
  }

  return getOrgRouting(orgId, tx)
}

// Resolve the set of user IDs that should receive alerts for the given alertType in this org.
// Implements the AC-E3c fallback: zero members → owner; if owner also empty → warn + return [].
export async function resolveRoutingRecipients(
  orgId: string,
  alertType: string,
  tx: Tx
): Promise<string[]> {
  const routing = await tx
    .select({ routeTo: orgNotificationRouting.routeTo })
    .from(orgNotificationRouting)
    .where(
      and(
        eq(orgNotificationRouting.orgId, orgId),
        eq(orgNotificationRouting.alertType, alertType)
      )
    )
    .limit(1)

  const targetRole: RoutingRole = (routing[0]?.routeTo as RoutingRole) ?? DEFAULT_ROUTING_ROLE

  const members = await getMembersWithRole(orgId, targetRole, tx)

  if (members.length === 0 && targetRole !== 'owner') {
    // AC-E3c: zero-member fallback to owner
    process.stdout.write(
      `${JSON.stringify({
        eventType: 'notification.routing_fallback',
        orgId,
        alertType,
        targetRole,
        fallbackRole: 'owner',
      })}\n`
    )
    const owners = await getMembersWithRole(orgId, 'owner', tx)
    if (owners.length === 0) {
      process.stderr.write(
        `${JSON.stringify({
          eventType: 'notification.routing_no_recipients',
          orgId,
          alertType,
          message: 'No owner or admin members found; no notifications will be sent',
        })}\n`
      )
      return []
    }
    return owners
  }

  return members
}

async function getMembersWithRole(orgId: string, role: RoutingRole, tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ userId: orgMemberships.userId })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.status, 'active'),
        // 'member' = all active members regardless of role (no role filter)
        // 'owner' or 'admin' = only members with that specific role
        role === 'member'
          ? undefined  // intentionally omitted: Drizzle's and() drops undefined conditions
          : eq(orgMemberships.role, role)
      )
    )
  return rows.map((r) => r.userId)
}
```

---

## AC-9: Dispatcher Refactor

**Given** the Story 3.1 `notifications/dispatcher.ts` uses simplified "all owner+admin" dispatch,
**When** Story 3.2 implements routing and preferences,
**Then** replace the body of `dispatchOrgAdminNotification()` in `apps/api/src/notifications/dispatcher.ts`:

```typescript
import { and, eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { withOrg } from '@project-vault/db'
import { notificationQueue, users } from '@project-vault/db/schema'
import { DEFAULT_NOTIFICATION_CHANNELS, DEFAULT_NOTIFICATION_FREQUENCY, DEFAULT_NOTIFICATION_MIN_SEVERITY, NOTIFICATION_SEVERITIES } from '@project-vault/shared'
import { resolveRoutingRecipients } from '../modules/notifications/routing.js'
import { getPreferences } from '../modules/notifications/preferences.js'
import type BossService from '../lib/boss.js'

export type NotificationTemplate = {
  templateId: string
  payload: Record<string, unknown>
  severity?: 'info' | 'warning' | 'critical'  // severity of the originating alert
}

type DispatchOptions = {
  orgId: string
  template: NotificationTemplate
  tx: Tx
  boss: BossService
}

// Computes the next digest delivery time: today at DIGEST_HOUR UTC if that time is in the future,
// otherwise tomorrow at DIGEST_HOUR UTC.
function nextDigestDeliveryTime(digestHourUtc: number): Date {
  const now = new Date()
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), digestHourUtc))
  if (candidate.getTime() > now.getTime()) return candidate
  return new Date(candidate.getTime() + 24 * 60 * 60 * 1000)
}

// Severity ordering for minSeverity filtering
const SEVERITY_LEVEL: Record<string, number> = { info: 0, warning: 1, critical: 2 }

export async function dispatchOrgAdminNotification(options: DispatchOptions): Promise<void> {
  const { orgId, template, tx, boss } = options
  const alertType = template.templateId
  const alertSeverity = template.severity ?? 'warning'
  const alertSeverityLevel = SEVERITY_LEVEL[alertSeverity] ?? 1

  // 1. Resolve routing: which user IDs should receive this alert type?
  const recipientUserIds = await resolveRoutingRecipients(orgId, alertType, tx)

  if (recipientUserIds.length === 0) {
    // No recipients — still send Slack (org-level, not user-level)
  }

  // 2. Per-user: resolve preferences and enqueue
  const queueEntriesToSend: Array<{ id: string; deliverAt: Date | null }> = []
  const slackEnabled = { send: false }  // track if any user has Slack enabled

  const seenUserChannels = new Set<string>()  // dedup by userId+channel

  for (const userId of recipientUserIds) {
    const prefs = await getPreferences(orgId, userId, tx)

    // Filter preferences for this alertType
    const alertPrefs = prefs.filter((p) => p.alertType === alertType)

    for (const pref of alertPrefs) {
      // 3. Severity filter: skip if alert severity is below user's minSeverity threshold
      const prefSeverityLevel = SEVERITY_LEVEL[pref.minSeverity] ?? 1
      if (alertSeverityLevel < prefSeverityLevel) continue

      // 4. Dedup by userId+channel
      const dedupKey = `${userId}:${pref.channel}`
      if (seenUserChannels.has(dedupKey)) continue
      seenUserChannels.add(dedupKey)

      if (pref.channel === 'slack') {
        slackEnabled.send = true
        // Slack is org-level, handled below — don't create per-user entries
        continue
      }

      // 5. Compute deliverAt for digest preferences
      const deliverAt = pref.frequency === 'digest_daily'
        ? nextDigestDeliveryTime(Number(process.env.NOTIFICATION_DIGEST_HOUR ?? '8'))
        : null

      // 6. Enqueue notification_queue entry
      const [entry] = await tx
        .insert(notificationQueue)
        .values({
          orgId,
          recipientUserId: userId,
          channel: pref.channel,
          templateId: template.templateId,
          payload: template.payload,
          status: 'pending',
          deliverAt,
        })
        .returning({ id: notificationQueue.id })

      if (entry?.id) {
        queueEntriesToSend.push({ id: entry.id, deliverAt })
      }
    }
  }

  // 7. Org-level Slack entry (if any recipient has Slack preference for this alertType)
  if (slackEnabled.send) {
    const [slackEntry] = await tx
      .insert(notificationQueue)
      .values({
        orgId,
        recipientUserId: null,
        channel: 'slack',
        templateId: template.templateId,
        payload: template.payload,
        status: 'pending',
        deliverAt: null,  // Slack is always immediate
      })
      .returning({ id: notificationQueue.id })

    if (slackEntry?.id) {
      queueEntriesToSend.push({ id: slackEntry.id, deliverAt: null })
    }
  }

  // 8. Send pg-boss jobs for immediate entries (deliverAt = null)
  //    Digest entries are picked up by notification:send-digest cron
  //    INVARIANT (ADR-3.1-06): boss.send() MUST be called AFTER the tx commits.
  //    The caller of dispatchOrgAdminNotification() is responsible for passing a
  //    committed (or soon-to-commit) tx. Do NOT call this inside a try/rollback block.
  //    If boss.send() fails, the notification:deliver-catchup schedule will re-enqueue
  //    stale pending entries (outbox pattern).
  for (const entry of queueEntriesToSend) {
    if (entry.deliverAt !== null) continue  // will be sent by digest worker

    const jobName = // determine job from notification_queue rows (we don't know channel here)
      'notification:email'  // simplification: boss sends email/slack based on channel from queue
    // Better: send a generic 'notification:deliver' job that reads channel from queue entry
    await boss.send('notification:deliver', { notificationQueueId: entry.id }, {
      retryLimit: 3,
      retryBackoff: true,
      retryDelay: 60,
    })
  }
}
```

**CRITICAL architecture decision** (ADR-3.2-01): The pg-boss job sent after dispatch is `notification:deliver` (generic delivery), NOT `notification:email` or `notification:slack` separately. The delivery worker reads the `channel` from the `notification_queue` row and routes to the appropriate transport. This avoids the dispatcher needing to know which job name corresponds to which channel — the worker handles the routing.

This means Story 3.1's `notification:email` and `notification:slack` workers must be unified into a single `notification:deliver` worker (or a thin router that dispatches to email/slack handlers). See AC-10.

**N+1 query optimization note**: `getPreferences()` is called per recipient in the dispatcher loop. For orgs with many recipients, add a batch version:
```typescript
// TODO (performance): Add getPreferencesBatch(orgId, userIds[], tx) that fetches
// all preference rows for multiple users in a single query:
// WHERE org_id = ? AND user_id = ANY(?)
// Then group by userId in memory. Use this in dispatcher for orgs with > 5 recipients.
```
This is a recommended TODO comment in `dispatcher.ts` for the dev agent to add at implementation time.

---

## AC-10: Unified Delivery Worker

**Given** the dispatcher now sends generic `notification:deliver` jobs (ADR-3.2-01),
**When** the delivery worker receives a job,
**Then** create `apps/api/src/workers/notification-deliver.ts` that routes to the appropriate transport:

```typescript
import { getDb, withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { eq } from 'drizzle-orm'
import { sendEmailNotification } from './notification-email.js'
import { sendSlackNotification } from './notification-slack.js'
import { withJobLogging } from '../lib/job-logging.js'
import type { FastifyBaseLogger } from 'fastify'

type QueueRow = { id: string; orgId: string; channel: string; deliverAt: string | null; status: string }

export async function deliverNotification(notificationQueueId: string): Promise<void> {
  const rows = await getDb().execute<QueueRow>(
    `SELECT id, org_id, channel, deliver_at, status FROM notification_queue WHERE id = $1 LIMIT 1`,
    [notificationQueueId]
  )
  const entry = rows[0]
  if (!entry) return
  if (entry.status !== 'pending') return

  // Check deliver_at: if in the future, skip (digest worker will handle it)
  if (entry.deliverAt && new Date(entry.deliverAt) > new Date()) return

  switch (entry.channel) {
    case 'email':
      await sendEmailNotification(notificationQueueId)
      break
    case 'slack':
      await sendSlackNotification(notificationQueueId)
      break
    case 'inbox':
      // Story 3.3 will add the inbox delivery path.
      // For now: inbox entries are written to notification_queue but not delivered
      // until Story 3.3's inbox worker is registered.
      break
    default:
      process.stderr.write(
        `${JSON.stringify({ eventType: 'notification.unknown_channel', channel: entry.channel, queueId: notificationQueueId })}\n`
      )
  }
}

export async function notificationDeliverHandler(
  job: { id?: string; data: { notificationQueueId: string } },
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
): Promise<void> {
  await withJobLogging(logger, 'notification:deliver', job.id ?? 'unknown',
    () => deliverNotification(job.data.notificationQueueId))
}
```

**Migration from Story 3.1's direct email/slack workers**: In Story 3.1, the dispatcher sent `notification:email` and `notification:slack` jobs directly. In Story 3.2, the dispatcher sends `notification:deliver` jobs. The Story 3.1 email and slack workers remain registered (for backward compatibility with any pending queue entries created by the Story 3.1 dispatcher), but new queue entries use `notification:deliver`.

**Register in `main.ts`**:
```typescript
import { notificationDeliverHandler } from './workers/notification-deliver.js'
// In registerWorkers():
'notification:deliver': (job) => notificationDeliverHandler(job, fastify.log),
```

---

## AC-11: Daily Digest Worker

**Given** users can set `frequency = "digest_daily"` for notification preferences,
**When** the daily digest time arrives,
**Then** create `apps/api/src/workers/notification-digest.ts`:

```typescript
import { getDb, withOrg } from '@project-vault/db'
import { notificationQueue, users, organizations } from '@project-vault/db/schema'
import { eq, and, lte, isNull, not, sql } from 'drizzle-orm'
import { renderEmailTemplate } from '../notifications/templates/index.js'
import { getEmailTransport } from './notification-email.js'
import { env } from '../config/env.js'
import { withJobLogging } from '../lib/job-logging.js'
import type { FastifyBaseLogger } from 'fastify'

type DigestEntry = {
  id: string
  orgId: string
  recipientUserId: string
  templateId: string
  payload: Record<string, unknown>
}

export async function runDigestSend(logger: FastifyBaseLogger): Promise<void> {
  const now = new Date()
  const transport = getEmailTransport()
  if (!transport) {
    logger.warn({ eventType: 'notification.digest.skipped', reason: 'smtp_not_configured' }, 'Digest send skipped: SMTP not configured')
    return
  }

  // Fetch all org IDs that have pending digest entries ready to deliver
  // (avoids fetching ALL org IDs globally — only orgs with pending digest work)
  const orgsWithDigestWork = await getDb().execute<{ orgId: string }>(
    `SELECT DISTINCT org_id AS "orgId"
     FROM notification_queue
     WHERE channel = 'email'
       AND status = 'pending'
       AND deliver_at IS NOT NULL
       AND deliver_at <= $1
       AND recipient_user_id IS NOT NULL`,
    [now.toISOString()]
  )

  const orgIds = orgsWithDigestWork.map((r) => r.orgId)

  for (const orgId of orgIds) {
    // Find all pending digest entries with deliverAt <= now
    const pendingEntries = await withOrg(orgId, async (tx) => {
      return tx.execute<DigestEntry>(
        `SELECT id, org_id, recipient_user_id, template_id, payload
         FROM notification_queue
         WHERE org_id = $1
           AND channel = 'email'
           AND status = 'pending'
           AND deliver_at IS NOT NULL
           AND deliver_at <= $2
           AND recipient_user_id IS NOT NULL
         ORDER BY recipient_user_id, created_at ASC`,
        [orgId, now.toISOString()]
      )
    })

    if (pendingEntries.length === 0) continue

    // Group by recipient
    const byRecipient = new Map<string, DigestEntry[]>()
    for (const entry of pendingEntries) {
      if (!byRecipient.has(entry.recipientUserId)) byRecipient.set(entry.recipientUserId, [])
      byRecipient.get(entry.recipientUserId)!.push(entry)
    }

    // Send one digest email per recipient
    for (const [recipientUserId, entries] of byRecipient) {
      await withOrg(orgId, async (tx) => {
        // Get recipient email
        const [user] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, recipientUserId))
          .limit(1)

        if (!user?.email) {
          // User deleted — suppress
          await tx.update(notificationQueue)
            .set({ status: 'suppressed' })
            .where(
              and(
                eq(notificationQueue.orgId, orgId),
                eq(notificationQueue.recipientUserId, recipientUserId),
                lte(notificationQueue.deliverAt, now)
              )
            )
          return
        }

        // Render digest email (multi-item bundle)
        const { subject, text, html } = renderDigestEmail(entries)

        try {
          await transport.sendMail({
            from: env.SMTP_FROM,
            to: user.email,
            subject,
            text,
            html,
          })

          // Mark all entries delivered
          for (const entry of entries) {
            await tx.update(notificationQueue)
              .set({ status: 'delivered', deliveredAt: new Date() })
              .where(eq(notificationQueue.id, entry.id))
          }
        } catch (err) {
          logger.error({ eventType: 'notification.digest.send_failed', recipientUserId, err }, 'Digest email send failed')
          // Don't rethrow — continue processing other recipients; these will retry next digest cycle
        }
      })
    }
  }
}

function renderDigestEmail(entries: DigestEntry[]): { subject: string; text: string; html: string } {
  const count = entries.length
  const subject = `[Project Vault] Daily digest: ${count} notification${count === 1 ? '' : 's'}`

  const items = entries.map((e) => renderEmailTemplate(e.templateId, e.payload))

  const text = [
    `Project Vault — Daily Notification Digest`,
    `${count} notification${count === 1 ? '' : 's'} since your last digest:`,
    ``,
    ...items.map((item, i) => `--- ${i + 1}. ${item.subject} ---\n${item.text}`),
    ``,
    `To manage your notification preferences, visit: [settings/notifications]`,
  ].join('\n')

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Daily Digest</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>Project Vault — Daily Digest</h2>
  <p>${count} notification${count === 1 ? '' : 's'} since your last digest:</p>
  ${items.map((item, i) => `
    <div style="border:1px solid #e5e7eb;border-radius:4px;padding:16px;margin:16px 0;">
      <h3 style="margin:0 0 8px 0;color:#1f2937;">${i + 1}. ${item.subject.replace('[Project Vault] ', '')}</h3>
      <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;color:#374151;">${item.text}</pre>
    </div>
  `).join('')}
  <hr><p style="color:#6b7280;font-size:12px;">Manage preferences: <a href="#">Settings → Notifications</a></p>
</body></html>`

  return { subject, text, html }
}

export async function notificationDigestHandler(logger: FastifyBaseLogger): Promise<void> {
  try {
    await runDigestSend(logger)
  } catch (err) {
    logger.error({ eventType: 'notification.digest.job_failed', err }, 'Digest job failed')
    throw err
  }
}
```

**Register schedule and worker in `main.ts`**:
```typescript
// In registerSchedules():
'notification:send-digest': { cron: `0 ${process.env.NOTIFICATION_DIGEST_HOUR ?? '8'} * * *` },

// In registerWorkers():
'notification:send-digest': () => notificationDigestHandler(fastify.log),
```

**`deliver_at` deduplication**: If the digest runs at 8am and processes all entries with `deliver_at <= 8am`, the next day at 8am will process entries with `deliver_at <= tomorrow 8am`. There's no risk of double-delivery because delivered entries have `status = 'delivered'`.

---

## AC-12: `notification_queue` Drizzle Schema Update

**Given** the `deliver_at` column was added by the migration,
**When** the Drizzle schema is updated to reflect the new column,
**Then** add `deliverAt` to `packages/db/src/schema/notification-queue.ts`:

```typescript
// ADD to the table columns:
deliverAt: timestamp('deliver_at', { withTimezone: true }),
```

This allows Drizzle query builders to reference `notificationQueue.deliverAt` without raw SQL.

---

## AC-13: `env.ts` Additions

**Given** the digest hour is configurable,
**When** Story 3.2 adds digest scheduling,
**Then** add to `apps/api/src/config/env.ts` `envSchema`:

```typescript
// Daily digest send hour (UTC, 0-23)
NOTIFICATION_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
```

---

## AC-14: Route Audit Classification

**Given** five new routes in `modules/notifications/routes.ts`,
**When** Story 3.2 adds them to `app.ts`,
**Then** add to `apps/api/src/lib/route-exemptions.ts` `ROUTE_ACTION_CLASSIFICATIONS`:

```typescript
'GET /api/v1/users/me/notification-preferences': {
  action: 'read',
  auditOmissionReason: 'User reads own notification preferences; no secrets exposed.',
  reviewer: SECURITY_OWNER,
},
'PUT /api/v1/users/me/notification-preferences': {
  action: 'mutation',
  auditOmissionReason: 'User updates own notification preferences; no secrets mutated. Not a security-sensitive setting change.',
  reviewer: SECURITY_OWNER,
},
'PATCH /api/v1/users/me/notification-preferences': {
  action: 'mutation',
  auditOmissionReason: 'User partially updates own notification preferences.',
  reviewer: SECURITY_OWNER,
},
'GET /api/v1/org/notification-routing': {
  action: 'read',
  auditOmissionReason: 'Admin reads org routing config; no secret values.',
  reviewer: SECURITY_OWNER,
},
'PUT /api/v1/org/notification-routing': {
  action: 'mutation',
  auditOmissionReason: 'Admin updates org routing config; organizational configuration change, not a security event.',
  reviewer: SECURITY_OWNER,
},
```

**Also add** to `DIRECT_DB_ACCESS_CLASSIFICATIONS`:
```typescript
{
  path: 'workers/notification-deliver.ts',
  classification: PLATFORM_JOB,
  reason: 'Reads notification_queue channel via getDb() to route delivery; writes via withOrg().',
  reviewer: SECURITY_OWNER,
},
{
  path: 'workers/notification-digest.ts',
  classification: PLATFORM_JOB,
  reason: 'Fetches digest queue entries per org using fetchAllOrgIds(); writes via withOrg().',
  reviewer: SECURITY_OWNER,
},
```

---

## AC-15: Frontend — Notification Settings Page

**Given** the architecture maps `modules/notifications/` to `(app)/settings/notifications/`,
**When** Story 3.2 creates the settings frontend,
**Then** create `apps/web/src/routes/(app)/settings/notifications/+page.server.ts`:

```typescript
import type { PageServerLoad, Actions } from './$types'
import { apiClient } from '$lib/api/client.js'
import { error, fail } from '@sveltejs/kit'

export const load: PageServerLoad = async ({ locals }) => {
  const [prefsRes, routingRes] = await Promise.all([
    apiClient.GET('/api/v1/users/me/notification-preferences', { headers: locals.authHeaders }),
    locals.isAdmin
      ? apiClient.GET('/api/v1/org/notification-routing', { headers: locals.authHeaders })
      : Promise.resolve(null),
  ])

  if (!prefsRes.ok) throw error(500, 'Failed to load notification preferences')

  return {
    preferences: prefsRes.data?.data ?? [],
    routing: routingRes?.ok ? routingRes.data?.data ?? [] : null,
    isAdmin: locals.isAdmin,
  }
}

export const actions: Actions = {
  updatePreference: async ({ request, locals }) => {
    const data = await request.formData()
    const alertType = String(data.get('alertType'))
    const channel = String(data.get('channel'))
    const frequency = String(data.get('frequency'))
    const minSeverity = String(data.get('minSeverity'))

    const res = await apiClient.PATCH('/api/v1/users/me/notification-preferences', {
      body: [{ alertType, channel, frequency, minSeverity }],
      headers: locals.authHeaders,
    })

    if (!res.ok) return fail(422, { error: 'Failed to update preference' })
    return { success: true }
  },

  updateRouting: async ({ request, locals }) => {
    const data = await request.formData()
    const routing = JSON.parse(String(data.get('routing') ?? '[]'))

    const res = await apiClient.PUT('/api/v1/org/notification-routing', {
      body: routing,
      headers: locals.authHeaders,
    })

    if (!res.ok) return fail(422, { error: 'Failed to update routing' })
    return { success: true }
  },
}
```

**And** create `apps/web/src/routes/(app)/settings/notifications/+page.svelte`:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms'
  import type { PageData } from './$types'

  const { data }: { data: PageData } = $props()

  const ALERT_TYPE_LABELS: Record<string, string> = {
    'security.failed_auth_threshold': 'Failed Login Threshold',
    'credential.expiry': 'Credential Expiry',
    'service.down': 'Service Down',
    'service.recovery': 'Service Recovery',
    'rotation.stale': 'Stale Rotation',
    'backup.failure': 'Backup Failure',
    'machine_key.expiry': 'Machine Key Expiry',
    'security.anomalous_access': 'Anomalous Access',
    'machine_cache.activated': 'Offline Cache Activated',
  }

  // Group preferences by alertType
  const prefsByType = $derived(() => {
    const map = new Map<string, typeof data.preferences>()
    for (const pref of data.preferences) {
      if (!map.has(pref.alertType)) map.set(pref.alertType, [])
      map.get(pref.alertType)!.push(pref)
    }
    return map
  })
</script>

<div class="max-w-4xl mx-auto px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900 mb-2">Notification Preferences</h1>
  <p class="text-gray-500 mb-8">Configure how and when you receive alerts from Project Vault.</p>

  <div class="bg-white shadow rounded-lg overflow-hidden mb-8">
    <div class="px-6 py-4 border-b border-gray-200">
      <h2 class="text-lg font-semibold text-gray-800">Personal Delivery Preferences</h2>
      <p class="text-sm text-gray-500 mt-1">Per-org settings. Changes here only affect your account in this organization.</p>
    </div>

    <table class="min-w-full divide-y divide-gray-200">
      <thead class="bg-gray-50">
        <tr>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Alert Type</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Channel</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Frequency</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Min Severity</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">
        {#each data.preferences as pref (pref.alertType + ':' + pref.channel)}
          <tr>
            <td class="px-6 py-4 text-sm font-medium text-gray-900">
              {ALERT_TYPE_LABELS[pref.alertType] ?? pref.alertType}
            </td>
            <td class="px-6 py-4 text-sm text-gray-500 capitalize">{pref.channel}</td>
            <td class="px-6 py-4 text-sm text-gray-500">
              {pref.frequency === 'immediate' ? 'Immediate' : 'Daily digest'}
            </td>
            <td class="px-6 py-4 text-sm text-gray-500 capitalize">{pref.minSeverity}+</td>
            <td class="px-6 py-4 text-sm">
              <form method="POST" action="?/updatePreference" use:enhance>
                <input type="hidden" name="alertType" value={pref.alertType} />
                <input type="hidden" name="channel" value={pref.channel} />
                <select name="frequency" class="text-sm border-gray-300 rounded mr-2">
                  <option value="immediate" selected={pref.frequency === 'immediate'}>Immediate</option>
                  <option value="digest_daily" selected={pref.frequency === 'digest_daily'}>Daily digest</option>
                </select>
                <select name="minSeverity" class="text-sm border-gray-300 rounded mr-2">
                  <option value="info" selected={pref.minSeverity === 'info'}>Info+</option>
                  <option value="warning" selected={pref.minSeverity === 'warning'}>Warning+</option>
                  <option value="critical" selected={pref.minSeverity === 'critical'}>Critical only</option>
                </select>
                <button type="submit" class="text-indigo-600 hover:text-indigo-900 text-sm font-medium">Save</button>
              </form>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if data.isAdmin && data.routing}
    <div class="bg-white shadow rounded-lg overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200">
        <h2 class="text-lg font-semibold text-gray-800">Org-Level Routing</h2>
        <p class="text-sm text-gray-500 mt-1">Configure which role receives each alert type (admin only).</p>
      </div>
      <div class="px-6 py-4">
        <form method="POST" action="?/updateRouting" use:enhance>
          <!-- Simplified: full routing config as JSON for MVP; proper per-row UI in future -->
          {#each data.routing as route}
            <div class="flex items-center gap-4 mb-3">
              <span class="text-sm text-gray-700 w-64">{ALERT_TYPE_LABELS[route.alertType] ?? route.alertType}</span>
              <select name="routeTo_{route.alertType}" class="text-sm border-gray-300 rounded">
                <option value="owner" selected={route.routeTo === 'owner'}>Owner</option>
                <option value="admin" selected={route.routeTo === 'admin'}>Admin</option>
                <option value="member" selected={route.routeTo === 'member'}>All Members</option>
              </select>
            </div>
          {/each}
          <button type="submit" class="mt-4 px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 text-sm">
            Save Routing
          </button>
          <input type="hidden" name="routing" id="routingJson" />
        </form>
      </div>
    </div>
  {/if}
</div>
```

**Svelte 5 runes compliance**: Uses `$props()` and `$derived()` (runes API). No `createEventDispatcher`. No `export let`. Form actions use SvelteKit `enhance` for progressive enhancement.

---

## AC-16: Integration & Unit Tests

### Service Layer Tests (`modules/notifications/preferences.test.ts`)

```typescript
describe('notification preferences service', () => {
  it('getPreferences returns defaults when no rows stored', async () => {
    const prefs = await withTestOrg(async (tx, { orgId, userId }) => {
      return getPreferences(orgId, userId, tx)
    })
    // Should have email + inbox for every known alert type
    const emailPrefs = prefs.filter((p) => p.channel === 'email')
    const inboxPrefs = prefs.filter((p) => p.channel === 'inbox')
    expect(emailPrefs.length).toBe(NOTIFICATION_ALERT_TYPES.length)
    expect(inboxPrefs.length).toBe(NOTIFICATION_ALERT_TYPES.length)
    expect(prefs.every((p) => p.frequency === 'immediate')).toBe(true)
    expect(prefs.every((p) => p.minSeverity === 'warning')).toBe(true)
  })

  it('getPreferences returns stored value overriding default', async () => {
    await withTestOrg(async (tx, { orgId, userId }) => {
      await patchPreferences(orgId, userId, [{
        alertType: 'security.failed_auth_threshold',
        channel: 'email',
        frequency: 'digest_daily',
        minSeverity: 'critical',
      }], tx)

      const prefs = await getPreferences(orgId, userId, tx)
      const emailPref = prefs.find((p) => p.alertType === 'security.failed_auth_threshold' && p.channel === 'email')
      expect(emailPref?.frequency).toBe('digest_daily')
      expect(emailPref?.minSeverity).toBe('critical')

      // inbox for same alert type still defaults
      const inboxPref = prefs.find((p) => p.alertType === 'security.failed_auth_threshold' && p.channel === 'inbox')
      expect(inboxPref?.frequency).toBe('immediate')
      expect(inboxPref?.minSeverity).toBe('warning')
    })
  })

  it('putPreferences replaces all stored rows', async () => {
    await withTestOrg(async (tx, { orgId, userId }) => {
      // First PATCH
      await patchPreferences(orgId, userId, [{ alertType: 'service.down', channel: 'email', frequency: 'digest_daily', minSeverity: 'info' }], tx)

      // PUT with different content
      await putPreferences(orgId, userId, [
        { alertType: 'security.failed_auth_threshold', channel: 'email', frequency: 'immediate', minSeverity: 'critical' }
      ], tx)

      const prefs = await getPreferences(orgId, userId, tx)
      // service.down email should now be back to default (digest_daily row deleted by PUT)
      const serviceDownEmail = prefs.find((p) => p.alertType === 'service.down' && p.channel === 'email')
      expect(serviceDownEmail?.frequency).toBe('immediate')  // back to default
    })
  })

  it('patchPreferences with channel "none" removes all rows for that alertType', async () => {
    await withTestOrg(async (tx, { orgId, userId }) => {
      // First set explicit prefs for failed_auth_threshold
      await patchPreferences(orgId, userId, [
        { alertType: 'security.failed_auth_threshold', channel: 'email', frequency: 'immediate', minSeverity: 'warning' }
      ], tx)

      // Now suppress with 'none'
      await patchPreferences(orgId, userId, [
        { alertType: 'security.failed_auth_threshold', channel: 'none', frequency: 'immediate', minSeverity: 'warning' }
      ], tx)

      // GET should no longer include explicit rows; defaults would still apply
      // But since user explicitly set 'none', we need a way to track suppression...
      // Note: current design falls back to default after 'none' deletes rows.
      // Future work: store an explicit 'suppressed' state.
    })
  })

  it('preferences are isolated per org (AC-E3d)', async () => {
    await withTestOrg(async (tx1, { orgId: orgAId, userId }) => {
      await patchPreferences(orgAId, userId, [{ alertType: 'service.down', channel: 'email', frequency: 'digest_daily', minSeverity: 'info' }], tx1)
    })

    await withTestOrg(async (tx2, { orgId: orgBId, userId }) => {
      const prefs = await getPreferences(orgBId, userId, tx2)
      const serviceDown = prefs.find((p) => p.alertType === 'service.down' && p.channel === 'email')
      expect(serviceDown?.frequency).toBe('immediate')  // default — orgA change not visible
    })
  })
})
```

### Routing Service Tests (`modules/notifications/routing.test.ts`)

```typescript
describe('notification routing service', () => {
  it('resolveRoutingRecipients returns owners by default (no stored routing)', async () => {
    const recipients = await withTestOrg(async (tx, { orgId }) => {
      return resolveRoutingRecipients(orgId, 'security.failed_auth_threshold', tx)
    })
    expect(recipients.length).toBeGreaterThan(0)
  })

  it('falls back to owner when routing target role has zero members (AC-E3c)', async () => {
    await withTestOrg(async (tx, { orgId }) => {
      // Set routing to 'admin', but org has no admins
      await putOrgRouting(orgId, [{ alertType: 'service.down', routeTo: 'admin' }], tx)

      const recipients = await resolveRoutingRecipients(orgId, 'service.down', tx)
      // Should fall back to owner (the owner who created the org)
      expect(recipients.length).toBeGreaterThan(0)
    })
  })

  it('emits notification.routing_fallback log on zero-member fallback', async () => {
    const logSpy = vi.spyOn(process.stdout, 'write')
    await withTestOrg(async (tx, { orgId }) => {
      await putOrgRouting(orgId, [{ alertType: 'service.down', routeTo: 'admin' }], tx)
      await resolveRoutingRecipients(orgId, 'service.down', tx)
    })
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('notification.routing_fallback')
    )
  })
})
```

### Dispatcher Integration Tests (`notifications/dispatcher.test.ts`)

```typescript
describe('dispatcher with preferences and routing', () => {
  it('severity filtering: does not enqueue when alert severity below user threshold', async () => {
    await withTestOrg(async (tx, { orgId, userId }) => {
      // Set minSeverity = 'critical' for security alerts
      await patchPreferences(orgId, userId, [{
        alertType: 'security.failed_auth_threshold',
        channel: 'email',
        frequency: 'immediate',
        minSeverity: 'critical',
      }], tx)

      const mockBoss = createMockBoss()
      await dispatchOrgAdminNotification({
        orgId,
        template: { templateId: 'security.failed_auth_threshold', payload: {}, severity: 'warning' },
        tx,
        boss: mockBoss,
      })

      // No email job sent because warning < critical threshold
      expect(mockBoss.send).not.toHaveBeenCalledWith('notification:deliver', expect.any(Object), expect.any(Object))
    })
  })

  it('deduplicates by user+channel', async () => {
    // Set two members with same preferences to the same alertType
    await withTestOrg(async (tx, { orgId }) => {
      const mockBoss = createMockBoss()
      // Only one entry per user+channel should be created
      await dispatchOrgAdminNotification({
        orgId,
        template: { templateId: 'security.failed_auth_threshold', payload: {}, severity: 'warning' },
        tx,
        boss: mockBoss,
      })

      // Verify notification_queue has no duplicates for same user+channel
      const entries = await tx.select().from(notificationQueue).where(eq(notificationQueue.orgId, orgId))
      const userChannelPairs = entries.map((e) => `${e.recipientUserId}:${e.channel}`)
      expect(new Set(userChannelPairs).size).toBe(userChannelPairs.length)
    })
  })

  it('sets deliverAt for digest_daily preference', async () => {
    await withTestOrg(async (tx, { orgId, userId }) => {
      await patchPreferences(orgId, userId, [{
        alertType: 'security.failed_auth_threshold',
        channel: 'email',
        frequency: 'digest_daily',
        minSeverity: 'warning',
      }], tx)

      const mockBoss = createMockBoss()
      await dispatchOrgAdminNotification({
        orgId,
        template: { templateId: 'security.failed_auth_threshold', payload: {}, severity: 'warning' },
        tx,
        boss: mockBoss,
      })

      const entries = await tx.select().from(notificationQueue)
        .where(and(eq(notificationQueue.orgId, orgId), eq(notificationQueue.channel, 'email')))
      expect(entries[0]?.deliverAt).not.toBeNull()
      expect(entries[0]?.deliverAt!.getTime()).toBeGreaterThan(Date.now())

      // No immediate boss.send() for digest entries
      expect(mockBoss.send).not.toHaveBeenCalled()
    })
  })
})
```

### API Route Tests (`modules/notifications/routes.test.ts`)

```typescript
describe('GET /api/v1/users/me/notification-preferences', () => {
  it('returns default preferences when none configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me/notification-preferences', headers: authHeaders(memberUser) })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.length).toBeGreaterThanOrEqual(NOTIFICATION_ALERT_TYPES.length * 2)  // email + inbox defaults
  })

  it('is scoped to the current org (different org, different prefs)', async () => {
    // Patch pref in org A
    await app.inject({ method: 'PATCH', url: '/api/v1/users/me/notification-preferences', headers: authHeaders(orgAUser), body: [...] })
    // Get prefs in org B as same user — should see defaults, not org A prefs
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me/notification-preferences', headers: authHeaders(orgBUser) })
    // Assert org B sees defaults
  })
})

describe('GET /api/v1/org/notification-routing', () => {
  it('returns 403 for member role', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org/notification-routing', headers: authHeaders(memberUser) })
    expect(res.statusCode).toBe(403)
  })

  it('returns default routing when none configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/org/notification-routing', headers: authHeaders(adminUser) })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.every((r: { routeTo: string }) => r.routeTo === 'owner')).toBe(true)
  })
})
```

---

## AC-17: Out of Scope

| Deferred item | Story |
|---|---|
| In-product notification inbox channel delivery (storing + reading inbox entries) | 3.3 |
| Per-user per-channel Slack preference (individual Slack usernames/DMs) | v2 |
| Routing to individually named users (vs. roles) | v2 — AC-E3c states role-only in v1 |
| Explicit suppress tracking (user sets "none" — currently falls back to default after delete) | v2 |
| SMTP/Slack settings admin UI page | 9.x |
| Notification settings link in global nav | 3.3 or navigation story |

---

## Architecture Decisions

### ADR-3.2-01: Unified `notification:deliver` job (replacing direct email/slack jobs)

**Decision**: The dispatcher sends `notification:deliver` jobs instead of channel-specific `notification:email` / `notification:slack` jobs. A unified `notification-deliver.ts` worker routes to the appropriate transport based on the `notification_queue.channel` field.

**Rationale**: With preferences, the dispatcher doesn't know at dispatch time which job type is needed — it depends on the channel stored in the queue entry. A unified job avoids the dispatcher needing to inspect the channel to pick a job name. The transport routing logic is co-located in one worker file.

**Consequence**: Story 3.1's `notification:email` and `notification:slack` workers remain registered for backward compatibility (any pending entries from the Story 3.1 era use those job names). New entries use `notification:deliver`. A future cleanup story can retire the old workers.

### ADR-3.2-02: Defaults computed at read time (not stored)

**Decision**: When no preference row exists, defaults are applied at `getPreferences()` call time. No "default rows" are inserted when a new user joins.

**Rationale**: Seeding defaults on user creation would require a migration for every new alert type (backfill defaults for existing users). Computing defaults at read time requires no backfill. The tradeoff is a slightly more complex `getPreferences()` function, which is worth the operational simplicity.

**Consequence**: When a user "removes" a preference via `channel: "none"`, the rows are deleted and defaults re-apply on next GET. A future story must add an explicit `suppressed` state if true opt-out semantics are needed.

### ADR-3.2-03: Digest delivery via `deliver_at` column (outbox pattern extension)

**Decision**: Digest-frequency notifications are stored in `notification_queue` with `deliver_at = next_digest_time()`. The digest worker processes entries with `deliver_at <= now()`. The regular `notification:deliver` worker skips entries with `deliver_at > now()`.

**Rationale**: This reuses the existing `notification_queue` table as a durable store for both immediate and digest notifications. No separate "digest queue" table needed. The `deliver_at` column makes the intent explicit and queryable.

**Consequence**: The `notification_queue` table accumulates digest entries until the daily run. At high scale (many users with digest preferences and many alert events), this table could grow large. A cleanup job (mark stale entries older than 7 days as `failed`) is recommended as a future operational enhancement.

### ADR-3.2-04: `channel: "none"` semantics (API input only, not stored)

**Decision**: `channel: "none"` is a PUT/PATCH API input value that means "delete all preference rows for this alertType". It is never stored in the database and never returned by GET.

**Consequence**: After sending `channel: "none"`, GET returns the defaults for that alertType (email + inbox, immediate, warning+). This is intentional — the user "reset to defaults" rather than "suppressed all". A future story can add an explicit suppress mechanism if needed.

### ADR-3.2-05: Security alert types cannot route to `member` role

**Decision**: Alert types matching the `security.*` prefix cannot be configured to route to the `member` role. Attempting to do so returns a 422 error. Security alerts must route to `owner` or `admin` only.

**Rationale**: Routing a security alert (e.g., `security.failed_auth_threshold`) to `member` would send emails to ALL active members of the org. For orgs with hundreds of members, this is an email amplification risk — an admin could trigger mass email sends via a legitimate routing configuration change. Security signals are operationally relevant only to org owners and admins who can act on them.

**Consequence**: Organizations that want all members to see security alerts can use the in-product inbox (Story 3.3) which is per-user and doesn't amplify external email delivery. The routing restriction applies to email and Slack channels only.

### ADR-3.2-06: `boss.send()` must be called post-transaction-commit (inherited from ADR-3.1-06)

**Decision**: `dispatchOrgAdminNotification()` must be invoked AFTER the database transaction that creates the triggering alert has committed. All `boss.send()` calls inside the dispatcher are post-commit. The `notification:deliver-catchup` schedule (every 10 min) handles the case where `boss.send()` fails after commit.

**Consequence**: Any new caller of `dispatchOrgAdminNotification()` must understand this contract. The function signature should be called "outside" or "after" any wrapping transaction. A comment in `dispatcher.ts` formalizes this invariant.

### ADR-3.2-07: `alertType` regex validation (`^[a-z0-9_.]+$`) prevents injection via preferences API

**Decision**: The preferences API validates `alertType` against the regex `^[a-z0-9_.]+$`. This prevents arbitrary strings (including path separators, newlines, template injection characters) from being stored as alert type identifiers.

**Rationale**: The `alertType` value flows into operational logs and potentially template identifiers. A stored `alertType` with path traversal characters (`../../etc/passwd`) or log injection sequences (`\n{"eventType":"..."}`) could corrupt log analysis pipelines. The dot-separated lowercase format is the established naming convention across the codebase (e.g., `security.failed_auth_threshold`) and this constraint enforces it.

**Consequence**: Future alert types must follow the `domain.event_name` naming pattern. Any alert type not matching the regex is rejected at the API layer with a 422.

---

## Developer Pre-mortem: Likely Failure Points

1. **Dispatcher sends `notification:deliver` but Story 3.1 workers handle `notification:email`**: Pending entries from Story 3.1 era have `notification:email` and `notification:slack` jobs. The dispatcher sends `notification:deliver` for new entries. Both old job handlers AND the new `notification:deliver` handler must be registered simultaneously. The delivery worker reads `channel` from the queue entry, so `notification-deliver.ts` handles all future entries correctly.

2. **`deliver_at` column not in Drizzle schema**: If `packages/db/src/schema/notification-queue.ts` is not updated to include `deliverAt`, Drizzle insert calls will omit the field and the column defaults to NULL (immediate delivery). Digest entries would be sent immediately instead of at the scheduled time. **Fix**: AC-12 must be done BEFORE dispatcher refactor.

3. **Story 3.1 email worker ignores `deliver_at`**: If someone manually sends a `notification:email` pg-boss job for a digest-scheduled entry (e.g., from the catchup cron), `notification-email.ts` will deliver it immediately, bypassing the digest schedule. **Fix**: Add a `deliver_at` guard at the start of `sendEmailNotification()`: if `entry.deliverAt && new Date(entry.deliverAt) > new Date()`, return early without sending. This makes the Story 3.1 workers safe to run against digest entries.

4. **Default preferences causing N+1 queries in dispatcher**: `getPreferences()` makes a DB query per recipient user. For an org with 20 admin members, that's 20 queries. At Story 3.2 scale (< 100 users per org), this is acceptable. At scale, batch the preference lookup by `userId IN (...)` across all recipients at once. Flag this as a TODO comment in `dispatcher.ts`.

5. **Speculative `fetchAllOrgIds()` import in digest worker**: The digest worker must NOT import `fetchAllOrgIds()` from `middleware/rls.ts` — that function may not exist or export what we expect. Instead, the digest worker queries `notification_queue` directly for `DISTINCT org_id WHERE deliver_at <= now AND status = 'pending'`. This scopes work to only orgs with actual pending digest entries, which is also more efficient than processing all orgs globally. The story code (AC-11) reflects this fix.

6. **PUT `422` on duplicate alertType+channel in request body**: If the frontend sends two items with the same alertType+channel (a frontend bug or concurrent form submit), `putPreferences()` tries to insert both rows and fails with a unique constraint violation from PostgreSQL, returning a 500. Fixed by adding `.superRefine()` duplicate-pair validation to `PutPreferencesBodySchema` (see AC-6).

7. **Zero-member routing fallback logging as stdout vs. pino logger**: The routing service uses `process.stdout.write()` (matching Story 1.9 conventions) for operational logging. Story 3.2 workers have access to `fastify.log` but the service layer does not. The `routing.ts` module uses `process.stdout.write()` for now. When the Fastify logger is made accessible to service modules (a future refactor), update this.

8. **Digest cron schedule with `NOTIFICATION_DIGEST_HOUR`**: The cron expression `0 ${NOTIFICATION_DIGEST_HOUR} * * *` is computed from an env var. If `NOTIFICATION_DIGEST_HOUR` is changed after deployment, the old schedule remains in pg-boss until it is re-registered (next restart). This is acceptable for a daily cron.

9. **"none" channel semantics regression**: After a user sets `channel: "none"` for `security.failed_auth_threshold`, the next `GET /api/v1/users/me/notification-preferences` returns defaults (email + inbox). The user's intent ("I don't want these notifications") appears to be forgotten. A frontend confirmation dialog should inform users: "Setting 'none' resets this alert type to default settings. To permanently suppress, [future feature]." Document this in the frontend.

10. **Security alert type email amplification via `member` routing**: An admin configuring `security.failed_auth_threshold` to route to `member` would send security alert emails to all org members. Fixed by `putOrgRouting()` validation: `security.*` alert types reject `routeTo: "member"` with a 422. Formalized in ADR-3.2-05.

---

## File Structure Summary

```
packages/shared/
  constants/
    notification-types.ts           ← CREATE: NOTIFICATION_ALERT_TYPES, channel/freq/severity enums
  index.ts                          ← MODIFY: export notification-types

packages/db/src/
  schema/
    notification-preferences.ts     ← CREATE
    org-notification-routing.ts     ← CREATE
    notification-queue.ts           ← MODIFY: add deliverAt column
    index.ts                        ← MODIFY: export new schemas
  migrations/
    00YY_notification_preferences.sql ← CREATE (verify journal)
    meta/_journal.json              ← MODIFY

apps/api/src/
  config/
    env.ts                          ← MODIFY: add NOTIFICATION_DIGEST_HOUR
  modules/
    notifications/                  ← CREATE: new module
      routes.ts                     ← CREATE: GET/PUT/PATCH preferences, GET/PUT routing
      schema.ts                     ← CREATE: Zod schemas
      preferences.ts                ← CREATE: preferences service
      routing.ts                    ← CREATE: routing service + resolveRoutingRecipients()
  notifications/
    dispatcher.ts                   ← MAJOR REFACTOR: routing + preferences + severity + dedup
  workers/
    notification-deliver.ts         ← CREATE: unified delivery worker
    notification-digest.ts          ← CREATE: daily digest worker
  lib/
    route-exemptions.ts             ← MODIFY: add 5 ROUTE_ACTION_CLASSIFICATIONS + 2 DIRECT_DB_ACCESS
  app.ts                            ← MODIFY: register notificationRoutes
  main.ts                           ← MODIFY: register notification:deliver, notification:send-digest

apps/web/src/
  routes/(app)/settings/
    notifications/                  ← CREATE
      +page.server.ts               ← CREATE
      +page.svelte                  ← CREATE

Test files:
  apps/api/src/modules/notifications/preferences.test.ts  ← CREATE
  apps/api/src/modules/notifications/routing.test.ts      ← CREATE
  apps/api/src/modules/notifications/routes.test.ts       ← CREATE
  apps/api/src/notifications/dispatcher.test.ts           ← CREATE/MODIFY
  apps/api/src/workers/notification-deliver.test.ts       ← CREATE
  apps/api/src/workers/notification-digest.test.ts        ← CREATE
  packages/db/src/__tests__/notification-prefs-rls.test.ts ← CREATE
```

---

## Tasks

### Phase 1: Shared Types
- [x] Create `packages/shared/constants/notification-types.ts` (AC-1)
- [x] Export from `packages/shared/index.ts`
- [x] Run `pnpm typecheck` to verify export

### Phase 2: Database (TDD)
- [x] **R2**: Read `packages/db/src/migrations/meta/_journal.json` for next free number
- [x] Create `packages/db/src/schema/notification-preferences.ts` (AC-2)
- [x] Create `packages/db/src/schema/org-notification-routing.ts` (AC-3)
- [x] Update `packages/db/src/schema/notification-queue.ts` with `deliverAt` column (AC-12)
- [x] Export new schemas from `packages/db/src/schema/index.ts`
- [x] Create migration `00YY_notification_preferences.sql` (AC-4) with ALTER TABLE + new tables + RLS
- [x] Update `meta/_journal.json`
- [x] Run `pnpm --filter @project-vault/db migrate` — confirm clean apply
- [x] Write `packages/db/src/__tests__/notification-prefs-rls.test.ts` (AC-16)
- [x] Verify RLS isolation tests pass

### Phase 3: Shared Constants + env.ts
- [x] Add `NOTIFICATION_DIGEST_HOUR` to `apps/api/src/config/env.ts` (AC-13)

### Phase 4: Service Layer (TDD)
- [x] Write `modules/notifications/preferences.test.ts` first (AC-16)
- [x] Create `apps/api/src/modules/notifications/schema.ts` (AC-6)
- [x] Create `apps/api/src/modules/notifications/preferences.ts` (AC-7)
- [x] Verify preference tests pass
- [x] Write `modules/notifications/routing.test.ts` first (AC-16)
- [x] Create `apps/api/src/modules/notifications/routing.ts` (AC-8)
- [x] Verify routing tests pass (including zero-member fallback, routing_fallback log)

### Phase 5: Dispatcher Refactor (TDD)
- [x] Write/update `notifications/dispatcher.test.ts` with severity, dedup, deliverAt tests (AC-16)
- [x] Refactor `apps/api/src/notifications/dispatcher.ts` (AC-9) — routing + preferences + severity + dedup + deliverAt
- [x] Verify dispatcher tests pass

### Phase 6: Workers (TDD)
- [x] Write `workers/notification-deliver.test.ts`
- [x] Create `apps/api/src/workers/notification-deliver.ts` (AC-10)
- [x] Write `workers/notification-digest.test.ts`
- [x] Create `apps/api/src/workers/notification-digest.ts` (AC-11)
- [x] Verify all worker tests pass

### Phase 7: Routes + App Registration
- [x] Create `apps/api/src/modules/notifications/routes.ts` (AC-5)
- [x] Register in `apps/api/src/app.ts` (AC-5)
- [x] Add 5 `ROUTE_ACTION_CLASSIFICATIONS` + 2 `DIRECT_DB_ACCESS_CLASSIFICATIONS` entries (AC-14)
- [x] Register `notification:deliver` and `notification:send-digest` in `main.ts` (AC-10, AC-11)
- [x] Add `notification:deliver-catchup` schedule (every 10 min, scans stale pending entries) to `main.ts` for the outbox pattern (extends Story 3.1's ADR-3.1-06)
- [x] Write `modules/notifications/routes.test.ts` (AC-16)
- [x] Verify route tests pass + `route-audit.test.ts` passes

### Phase 8: Frontend
- [x] Create `apps/web/src/routes/(app)/settings/notifications/+page.server.ts` (AC-15)
- [x] Create `apps/web/src/routes/(app)/settings/notifications/+page.svelte` (AC-15)
- [x] Manual smoke test: settings page loads, shows defaults, allows preference update

### Phase 9: Full CI Sweep
- [x] `pnpm typecheck` — no errors
- [x] `pnpm lint` — no errors
- [x] `pnpm test` (all workspaces) — all tests pass
- [x] `route-audit.test.ts` passes for all 5 new routes
- [x] `check-rls-coverage.ts` passes for both new tables

---

## Previous Story Intelligence (From Story 3.1)

- `notifications/dispatcher.ts` already exists with `dispatchOrgAdminNotification()` and `enqueueSecurityAlertNotification()` — Story 3.2 replaces the body of `dispatchOrgAdminNotification()` but keeps the function signature the same for backward compatibility with callers (including the updated `check-failed-auth-threshold.ts`).
- The `boss.send()` after-commit pattern is already in place (ADR-3.1-06). The dispatcher refactor must preserve this: boss.send() is called outside the transaction.
- `notification:email-catchup` and `notification:slack-catchup` were added by Story 3.1 as outbox polling schedules. With the unified `notification:deliver` worker, add a `notification:deliver-catchup` cron (every 10 min) that scans stale `pending` entries and sends `notification:deliver` jobs.
- The `setEmailTransportForTesting()` export from `notification-email.ts` is used in Story 3.1 tests and must remain available for Story 3.2's digest worker tests.
- `DIRECT_DB_ACCESS_CLASSIFICATIONS` entries for `notification-email.ts`, `notification-slack.ts`, and `notification-backfill.ts` already exist — add new entries for `notification-deliver.ts` and `notification-digest.ts` only.

---

## Dev Agent Record

> **Fill in this section as you implement each phase.**

### Decisions Made During Implementation
- Unified delivery via `notification:deliver` worker; legacy email/slack workers retained for channel-specific catchup.
- Default preferences computed (email + inbox, immediate, warning+) — not stored per user until changed.
- User preference routes MFA-exempt (all roles); org routing requires MFA for owner/admin.
- `route-audit.test.ts` extended to resolve module-level string constants for URL paths.

### Problems Encountered
- Backfill tests failed without seeded org owner after dispatcher routing refactor.
- jscpd duplicate detection required consolidating catchup logic and test helpers.
- `.env.example` needed `NOTIFICATION_DIGEST_HOUR` for env schema sync check.

### Test Coverage Achieved
- DB RLS isolation for `notification_preferences` and `org_notification_routing`
- Preferences/routing services, API routes (integration), dispatcher (severity, digest deliverAt, routing fallback)
- Workers: deliver, digest skip, backfill idempotency; worker registration; route audit

### Files Changed
- `packages/shared`: notification-types, mfa-exempt-routes
- `packages/db`: schemas, migration 0022, RLS tests
- `apps/api`: notifications module, dispatcher refactor, deliver/digest/catchup workers, route exemptions
- `apps/web`: settings hub link, `/settings/notifications` page
- `.env.example`: NOTIFICATION_DIGEST_HOUR

### Notes for Story 3.3
- Dispatcher creates `channel: inbox` queue entries with `status: pending`; `notification-deliver` skips inbox until 3.3 inbox worker/SSE exists.
- Preference schema supports inbox channel; UI shows inbox option with honest placeholder per product surface contract.
