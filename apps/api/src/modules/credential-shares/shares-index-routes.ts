import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseQuery } from '../../lib/route-helpers.js'
import { roleRank, secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { orgRoleOrDeny } from '../../lib/auth-role.js'
import {
  DEFAULT_SHARE_LIST_LIMIT,
  ListSharesIndexQuerySchema,
  ListSharesIndexResponseSchema,
  MAX_SHARE_LIST_LIMIT,
} from './schema.js'
import { serializeShare } from './routes.js'
import { countSharesIndex, listSharesIndex } from './share-index-service.js'

/**
 * Story 72-11 V13: the cross-credential shares index. Its own file (route-audit resolves one source
 * file to one `app.ts` prefix) under the same `/api/v1/shares` prefix as the recipient access
 * routes; the paths do not overlap (the bare prefix here, `/access/:token` there).
 */
export function sharesIndexRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '',
    schema: {
      response: {
        200: ListSharesIndexResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'member', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const query = parseQuery(ListSharesIndexQuerySchema, req, reply)
      if (!query) return reply
      const secureCtx = ctx as SecureRouteContext
      const params = {
        orgId: secureCtx.auth.orgId,
        viewerUserId: secureCtx.auth.userId,
        viewerIsAdmin: roleRank(orgRoleOrDeny(secureCtx.auth)) >= roleRank('admin'),
        status: query.status,
        displayStatus: query.displayStatus,
        // An over-large `limit` is clamped, never rejected (same convention as the per-credential list).
        limit: Math.min(query.limit ?? DEFAULT_SHARE_LIST_LIMIT, MAX_SHARE_LIST_LIMIT),
        offset: query.offset ?? 0,
      }
      const [rows, total] = await Promise.all([
        listSharesIndex(secureCtx.tx, params),
        countSharesIndex(secureCtx.tx, params),
      ])
      return {
        data: {
          items: rows.map((row) => ({
            ...serializeShare(row.share),
            credentialName: row.credentialName,
            projectId: row.projectId,
            projectName: row.projectName,
          })),
          total,
        },
      }
    },
  })
  return Promise.resolve()
}
