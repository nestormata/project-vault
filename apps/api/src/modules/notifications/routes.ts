import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { withOrgAndUser } from '@project-vault/db'
import { notificationInbox } from '@project-vault/db/schema'
import type { FastifyApp } from '../../lib/fastify-app.js'
import type { OrgRole } from '../../plugins/require-org-role.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { validationError } from '../../lib/route-helpers.js'
import { buildPaginationMeta } from '../../lib/pagination.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import {
  PutPreferencesBodySchema,
  PatchPreferencesBodySchema,
  PutRoutingBodySchema,
  GetInboxQuerySchema,
  InboxEntryIdParamSchema,
  GetPreferencesResponseSchema,
  GetRoutingResponseSchema,
  GetInboxResponseSchema,
} from './schema.js'
import { getPreferences, putPreferences, patchPreferences } from './preferences.js'
import { getOrgRouting, putOrgRouting, SecurityAlertRoutingError } from './routing.js'

const USER_NOTIFICATION_PREFERENCES_URL = '/users/me/notification-preferences'

const InboxEntryNotFoundSchema = z.object({ error: z.literal('not_found') })

const USER_PREFS_SECURITY = {
  allowedRoles: ['owner', 'admin', 'member', 'viewer'] satisfies OrgRole[],
  writeAuditEvent: false,
}

const INBOX_ROUTE_SECURITY = {
  allowedRoles: ['owner', 'admin', 'member', 'viewer'] satisfies OrgRole[],
  writeAuditEvent: false,
}

function parseInboxEntryId(req: FastifyRequest, reply: FastifyReply): string | null {
  const paramParsed = InboxEntryIdParamSchema.safeParse(req.params)
  if (!paramParsed.success) {
    void reply.status(400).send(validationError(paramParsed.error, 'params'))
    return null
  }
  return paramParsed.data.id
}

function inboxEntryScope(id: string, orgId: string, userId: string) {
  return and(
    eq(notificationInbox.id, id),
    eq(notificationInbox.orgId, orgId),
    eq(notificationInbox.userId, userId)
  )
}

async function mutateInboxEntryById(
  secureCtx: SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply,
  mutate: (tx: Parameters<Parameters<typeof withOrgAndUser>[2]>[0], id: string) => Promise<boolean>
) {
  const id = parseInboxEntryId(req, reply)
  if (id === null) return

  const notFound = await withOrgAndUser(secureCtx.auth.orgId, secureCtx.auth.userId, (tx) =>
    mutate(tx, id)
  )

  if (notFound) return reply.status(404).send({ error: 'not_found' })
  return reply.status(204).send()
}

function inboxEntryRoute(
  fastify: FastifyApp,
  method: 'POST' | 'DELETE',
  url: string,
  handler: (ctx: SecureRouteContext, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
) {
  secureRoute(fastify, {
    method,
    url,
    schema: {
      response: {
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: InboxEntryNotFoundSchema,
      },
    },
    security: INBOX_ROUTE_SECURITY,
    handler: async (ctx, req, reply) => handler(ctx as SecureRouteContext, req, reply),
  })
}

export async function notificationRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: USER_NOTIFICATION_PREFERENCES_URL,
    schema: {
      response: {
        200: GetPreferencesResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
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
    schema: {
      response: {
        200: GetPreferencesResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
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
    schema: {
      response: {
        200: GetPreferencesResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
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
    schema: {
      response: {
        200: GetRoutingResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
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
    schema: {
      response: {
        200: GetRoutingResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
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
    schema: {
      response: {
        200: GetInboxResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner', 'admin', 'member', 'viewer'] satisfies OrgRole[],
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = GetInboxQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))
      const { page, limit, status } = parsed.data

      const inboxWhere = and(
        eq(notificationInbox.orgId, secureCtx.auth.orgId),
        eq(notificationInbox.userId, secureCtx.auth.userId),
        isNull(notificationInbox.dismissedAt),
        status === 'unread' ? isNull(notificationInbox.readAt) : undefined,
        status === 'read' ? isNotNull(notificationInbox.readAt) : undefined
      )

      const { entries, total } = await withOrgAndUser(
        secureCtx.auth.orgId,
        secureCtx.auth.userId,
        async (tx) => {
          const [{ total: totalCount } = { total: 0 }] = await tx
            .select({ total: sql<number>`count(*)` })
            .from(notificationInbox)
            .where(inboxWhere)
          const rows = await tx
            .select({
              id: notificationInbox.id,
              alertType: notificationInbox.alertType,
              severity: notificationInbox.severity,
              payload: notificationInbox.payload,
              readAt: notificationInbox.readAt,
              createdAt: notificationInbox.createdAt,
            })
            .from(notificationInbox)
            .where(inboxWhere)
            .orderBy(desc(notificationInbox.createdAt))
            .limit(limit)
            .offset((page - 1) * limit)
          return { entries: rows, total: Number(totalCount) }
        }
      )

      const items = entries.map((entry) => {
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

      return {
        data: { items, ...buildPaginationMeta({ page, limit }, total) },
      }
    },
  })

  inboxEntryRoute(fastify, 'POST', '/notifications/inbox/:id/read', async (secureCtx, req, reply) =>
    mutateInboxEntryById(secureCtx, req, reply, async (tx, id) => {
      const result = await tx
        .update(notificationInbox)
        .set({ readAt: new Date() })
        .where(
          and(
            inboxEntryScope(id, secureCtx.auth.orgId, secureCtx.auth.userId),
            isNull(notificationInbox.readAt)
          )
        )
        .returning({ id: notificationInbox.id })

      if (result.length > 0) return false

      const existing = await tx
        .select({ id: notificationInbox.id })
        .from(notificationInbox)
        .where(inboxEntryScope(id, secureCtx.auth.orgId, secureCtx.auth.userId))
        .limit(1)

      return existing.length === 0
    })
  )

  secureRoute(fastify, {
    method: 'POST',
    url: '/notifications/inbox/read-all',
    schema: {
      response: {
        204: z.null(),
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
    security: INBOX_ROUTE_SECURITY,
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

  inboxEntryRoute(fastify, 'DELETE', '/notifications/inbox/:id', async (secureCtx, req, reply) =>
    mutateInboxEntryById(secureCtx, req, reply, async (tx, id) => {
      const result = await tx
        .update(notificationInbox)
        .set({ dismissedAt: new Date() })
        .where(
          and(
            inboxEntryScope(id, secureCtx.auth.orgId, secureCtx.auth.userId),
            isNull(notificationInbox.dismissedAt)
          )
        )
        .returning({ id: notificationInbox.id })

      return result.length === 0
    })
  )
}
