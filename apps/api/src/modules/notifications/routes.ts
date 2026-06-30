import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../../lib/fastify-app.js'
import type { OrgRole } from '../../plugins/require-org-role.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { validationError } from '../../lib/route-helpers.js'
import {
  PutPreferencesBodySchema,
  PatchPreferencesBodySchema,
  PutRoutingBodySchema,
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
}
