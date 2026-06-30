import type { FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { withOrgAndUser } from '@project-vault/db'
import { notificationInbox } from '@project-vault/db/schema'
import type { FastifyApp } from '../../lib/fastify-app.js'
import type { OrgRole } from '../../plugins/require-org-role.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { validationError } from '../../lib/route-helpers.js'
import {
  PutPreferencesBodySchema,
  PatchPreferencesBodySchema,
  PutRoutingBodySchema,
  GetInboxQuerySchema,
  InboxEntryIdParamSchema,
} from './schema.js'
import { getPreferences, putPreferences, patchPreferences } from './preferences.js'
import { getOrgRouting, putOrgRouting, SecurityAlertRoutingError } from './routing.js'

const USER_NOTIFICATION_PREFERENCES_URL = '/users/me/notification-preferences'

const USER_PREFS_SECURITY = {
  allowedRoles: ['owner', 'admin', 'member', 'viewer'] satisfies OrgRole[],
  writeAuditEvent: false,
}

export async function notificationRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: USER_NOTIFICATION_PREFERENCES_URL,
    security: USER_PREFS_SECURITY,
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const prefs = await getPreferences(secureCtx.auth.orgId, secureCtx.auth.userId, secureCtx.tx)
      return { data: prefs }
    },
  })

  secureRoute(fastify, {
    method: 'PUT',
    url: USER_NOTIFICATION_PREFERENCES_URL,
    security: USER_PREFS_SECURITY,
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = PutPreferencesBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      const prefs = await putPreferences(
        secureCtx.auth.orgId,
        secureCtx.auth.userId,
        parsed.data,
        secureCtx.tx
      )
      return { data: prefs }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: USER_NOTIFICATION_PREFERENCES_URL,
    security: USER_PREFS_SECURITY,
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = PatchPreferencesBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      const prefs = await patchPreferences(
        secureCtx.auth.orgId,
        secureCtx.auth.userId,
        parsed.data,
        secureCtx.tx
      )
      return { data: prefs }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/org/notification-routing',
    security: {
      allowedRoles: ['owner', 'admin'],
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: async (ctx) => {
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
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = PutRoutingBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      try {
        const routing = await putOrgRouting(secureCtx.auth.orgId, parsed.data, secureCtx.tx)
        return { data: routing }
      } catch (err) {
        if (err instanceof SecurityAlertRoutingError) {
          return reply.status(422).send({ code: err.code, message: err.message })
        }
        throw err
      }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/notifications/inbox',
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'] satisfies OrgRole[],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = GetInboxQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))
      const { page, limit, status } = parsed.data

      const entries = await withOrgAndUser(secureCtx.auth.orgId, secureCtx.auth.userId, (tx) =>
        tx
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
              status === 'read' ? isNotNull(notificationInbox.readAt) : undefined
            )
          )
          .orderBy(desc(notificationInbox.createdAt))
          .limit(limit)
          .offset((page - 1) * limit)
      )

      const data = entries.map((entry) => {
        const payload = entry.payload as {
          title?: string
          body?: string
          projectId?: string
          resourceId?: string
          resourceType?: string
        }
        return {
          id: entry.id,
          alertType: entry.alertType,
          severity: entry.severity,
          title: payload.title ?? '',
          body: payload.body ?? '',
          projectId: payload.projectId ?? null,
          resourceId: payload.resourceId ?? null,
          resourceType: payload.resourceType ?? null,
          readAt: entry.readAt?.toISOString() ?? null,
          createdAt: entry.createdAt.toISOString(),
        }
      })

      return { data, page, limit }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/notifications/inbox/:id/read',
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'] satisfies OrgRole[],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const paramParsed = InboxEntryIdParamSchema.safeParse(req.params)
      if (!paramParsed.success) {
        return reply.status(400).send(validationError(paramParsed.error, 'params'))
      }
      const { id } = paramParsed.data

      const notFound = await withOrgAndUser(
        secureCtx.auth.orgId,
        secureCtx.auth.userId,
        async (tx) => {
          const result = await tx
            .update(notificationInbox)
            .set({ readAt: new Date() })
            .where(
              and(
                eq(notificationInbox.id, id),
                eq(notificationInbox.orgId, secureCtx.auth.orgId),
                eq(notificationInbox.userId, secureCtx.auth.userId),
                isNull(notificationInbox.readAt)
              )
            )
            .returning({ id: notificationInbox.id })

          if (result.length > 0) return false

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

          return existing.length === 0
        }
      )

      if (notFound) return reply.status(404).send({ error: 'not_found' })
      return reply.status(204).send()
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/notifications/inbox/read-all',
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'] satisfies OrgRole[],
      writeAuditEvent: false,
    },
    handler: async (ctx, _req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext

      await withOrgAndUser(secureCtx.auth.orgId, secureCtx.auth.userId, (tx) =>
        tx
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
      )

      return reply.status(204).send()
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/notifications/inbox/:id',
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'] satisfies OrgRole[],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const paramParsed = InboxEntryIdParamSchema.safeParse(req.params)
      if (!paramParsed.success) {
        return reply.status(400).send(validationError(paramParsed.error, 'params'))
      }
      const { id } = paramParsed.data

      const notFound = await withOrgAndUser(
        secureCtx.auth.orgId,
        secureCtx.auth.userId,
        async (tx) => {
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

          return result.length === 0
        }
      )

      if (notFound) return reply.status(404).send({ error: 'not_found' })
      return reply.status(204).send()
    },
  })
}
