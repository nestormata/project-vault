// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/
// (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).
import type { FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { operationalLog } from '../../lib/logger.js'
import {
  secureRoute,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import { invalidateEmailTransport } from '../../workers/notification-email.js'
import { resolveEffectiveSettings, upsertSystemSettings } from './service.js'
import { SystemSettingsResponseSchema, SystemSettingsUpdateSchema } from './schema.js'
import { PLATFORM_ADMIN_ERROR_RESPONSES, beginSecureMutation } from './route-common.js'

/**
 * Extracted to a named function (rather than inlined in the secureRoute() call, jscpd dedup —
 * same precedent as credentials/routes.ts's handleCredentialTagUpdate) so this handler's body
 * doesn't sit adjacent to the (necessarily literal, see orgs-routes.ts's POST handler and
 * platform-admin-route-audit.test.ts) `security: {...}` block in a way that reads as one long
 * clone of that same block in orgs-routes.ts.
 */
async function handleUpdateSettings(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const begun = beginSecureMutation(ctx, req, reply, SystemSettingsUpdateSchema)
  if (!begun) return reply
  const { secureCtx, data } = begun

  const { effective, smtpChanged } = await upsertSystemSettings(data, secureCtx.auth.userId)

  // D4/AC-6: invalidate the cached SMTP transport only when an SMTP field actually changed
  // — avoids unnecessarily dropping a healthy connection pool for unrelated updates.
  if (smtpChanged) invalidateEmailTransport()

  operationalLog(
    req.log,
    'info',
    OperationalEvent.PLATFORM_SETTINGS_UPDATED,
    'platform settings updated',
    {
      operatorUserId: secureCtx.auth.userId,
      fieldsChanged: Object.keys(data),
    }
  )

  return effective
}

/**
 * Story 9.2 D2/AC-1: `GET`/`PUT /admin/settings` — instance-wide system settings (SMTP, backup
 * defaults, notification defaults, instance policy). `requireOrgScope: false` +
 * `requirePlatformOperator: true` + `requireMfa: true` — never `allowedRoles`/`requireOrgRole`.
 */
export async function settingsRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/settings',
    schema: {
      // AC-27: distinct from the existing org-scoped 'Admin' tag on modules/admin/routes.ts.
      tags: ['Platform Admin'],
      response: {
        200: SystemSettingsResponseSchema,
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: async () => {
      return resolveEffectiveSettings()
    },
  })

  secureRoute(fastify, {
    method: 'PUT',
    url: '/settings',
    schema: {
      tags: ['Platform Admin'],
      body: SystemSettingsUpdateSchema,
      response: {
        200: SystemSettingsResponseSchema,
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: handleUpdateSettings,
  })
}
