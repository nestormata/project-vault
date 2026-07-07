// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/
// (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).
import { z } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody } from '../../lib/route-helpers.js'
import { operationalLog } from '../../lib/logger.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { invalidateEmailTransport } from '../../workers/notification-email.js'
import { resolveEffectiveSettings, upsertSystemSettings } from './service.js'
import { SystemSettingsResponseSchema, SystemSettingsUpdateSchema } from './schema.js'

// AC-26: the vault-guard 503 shape ({ status, message }) is distinct from this module's own
// error responses — declared here purely so response serialization doesn't reject it (mirrors
// backup/schema.ts's VaultSealedResponseSchema precedent).
const VaultSealedResponseSchema = z.object({ status: z.string(), message: z.string() })

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
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        503: z.union([ApiErrorSchema, VaultSealedResponseSchema]),
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
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
        503: z.union([ApiErrorSchema, VaultSealedResponseSchema]),
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = parseBody(SystemSettingsUpdateSchema, req, reply)
      if (!parsed.success) return reply

      const { effective, smtpChanged } = await upsertSystemSettings(
        parsed.data,
        secureCtx.auth.userId
      )

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
          fieldsChanged: Object.keys(parsed.data),
        }
      )

      return effective
    },
  })
}
