import { eq } from 'drizzle-orm'
import { z } from 'zod/v4'
import { users } from '@project-vault/db/schema'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { countUnreadInboxEntries } from '../../workers/notification-inbox.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody } from '../../lib/route-helpers.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { UserLocaleBodySchema, UserLocaleResponseSchema } from './locale-schema.js'

const usersMeResponseSchema = z.object({
  data: z.object({
    userId: z.uuid(),
    orgId: z.uuid(),
    orgRole: z.enum(['owner', 'admin', 'member', 'viewer']),
    locale: z.enum(['en', 'es']),
    notifications: z.object({ unreadCount: z.number().int().min(0) }),
  }),
})

export async function usersRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/me',
    schema: {
      response: {
        200: usersMeResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'],
      writeAuditEvent: false,
    },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const unreadCount = await countUnreadInboxEntries(secureCtx.auth.orgId, secureCtx.auth.userId)
      const [row] = await secureCtx.tx
        .select({ locale: users.locale })
        .from(users)
        .where(eq(users.id, secureCtx.auth.userId))
      return {
        data: {
          userId: secureCtx.auth.userId,
          orgId: secureCtx.auth.orgId,
          orgRole: secureCtx.auth.orgRole,
          locale: (row?.locale ?? 'en') as 'en' | 'es',
          notifications: { unreadCount },
        },
      }
    },
  })

  // Story 15.1 AC 2/6/7/8/9/10 — self-service locale change. Deliberately takes no `userId` in
  // params or body: the target row is derived exclusively from `secureCtx.auth.userId` (AC 8),
  // and the body schema is `.strict()` so an attempted `userId` field is a hard validation error,
  // not a silently-ignored one. `writeAuditEvent: false` + the inline
  // `writeHumanAuditEntryOrFailClosed(...secureCtx.tx...)` call below satisfy
  // route-audit.test.ts's assertAuditedActionOptOutsAreJustified static check (see
  // organization-settings-routes.ts for the identical pattern) — this call must stay textually
  // inline in this route registration, not be extracted into a shared helper.
  secureRoute(fastify, {
    method: 'PATCH',
    url: '/me/locale',
    schema: {
      body: UserLocaleBodySchema,
      response: {
        200: UserLocaleResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'],
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'PATCH /api/v1/users/me/locale',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsed = parseBody(UserLocaleBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const [before] = await secureCtx.tx
        .select({ locale: users.locale })
        .from(users)
        .where(eq(users.id, secureCtx.auth.userId))
      const previousLocale = before?.locale ?? 'en'
      const newLocale = parsed.data.locale

      // The authenticated session guarantees a `users` row for secureCtx.auth.userId exists (it's
      // the foreign key the session itself was resolved from), so an empty UPDATE result here
      // would indicate a deeper auth-context bug, not a normal client-reachable case.
      const [updated] = await secureCtx.tx
        .update(users)
        .set({ locale: newLocale })
        .where(eq(users.id, secureCtx.auth.userId))
        .returning({ locale: users.locale })
      if (!updated) {
        throw new Error('users.locale update affected no rows for an authenticated session')
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'user',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'user.locale_updated',
        resourceId: secureCtx.auth.userId,
        payload: { previousLocale, newLocale },
        request: req,
      })

      return { data: { locale: updated.locale as 'en' | 'es' } }
    },
  })
}
