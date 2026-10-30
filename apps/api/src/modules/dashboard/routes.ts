import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { roleRank, secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { getOrgDashboardData } from '../projects/dashboard-stats.js'
import { DashboardAttentionResponseSchema, OrgDashboardResponseSchema } from './schema.js'
import { getDashboardAttention } from './attention-service.js'
import { orgRoleOrDeny } from '../../lib/auth-role.js'

export function dashboardRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '',
    schema: {
      response: { 200: OrgDashboardResponseSchema, 401: ApiErrorSchema },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      return {
        data: await getOrgDashboardData(secureCtx.tx, {
          userId: secureCtx.auth.userId,
          orgRole: orgRoleOrDeny(secureCtx.auth),
        }),
      }
    },
  })

  // Story 72-12: what needs attention, per viewer. An org viewer gets an empty list (200), never a
  // 403: a refusal here would break the dashboard page the same way story 72-20 describes.
  secureRoute(fastify, {
    method: 'GET',
    url: '/attention',
    schema: {
      response: { 200: DashboardAttentionResponseSchema, 401: ApiErrorSchema },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const rank = roleRank(orgRoleOrDeny(secureCtx.auth))
      return {
        data: await getDashboardAttention(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          userId: secureCtx.auth.userId,
          isAdmin: rank >= roleRank('admin'),
          isViewer: rank < roleRank('member'),
        }),
      }
    },
  })
  return Promise.resolve()
}
