// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/
// (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).
import { z } from 'zod/v4'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { secureRoute } from '../../lib/secure-route.js'
import { resolveResourceUsage } from './service.js'
import { ResourceUsageResponseSchema } from './schema.js'

const VaultSealedResponseSchema = z.object({ status: z.string(), message: z.string() })

/**
 * Story 9.2 D2/AC-12 through AC-14: `GET /admin/resource-usage` — cross-org resource-usage
 * visibility against operator-configured instance limits. `requireOrgScope: false` +
 * `requirePlatformOperator: true` + `requireMfa: true` — never `allowedRoles`/`requireOrgRole`.
 */
export async function resourceUsageRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/resource-usage',
    schema: {
      tags: ['Platform Admin'],
      response: {
        200: ResourceUsageResponseSchema,
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
    handler: async () => resolveResourceUsage(),
  })
}
