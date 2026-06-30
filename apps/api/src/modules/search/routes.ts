import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { validationError } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { SearchQuerySchema, SearchResponseSchema } from './schema.js'
import { executeSearch } from './service.js'

function invalidSearchTypeResponse() {
  return {
    code: 'invalid_search_type',
    message: 'Invalid search type. Allowed values: credentials, projects',
  }
}

export async function searchRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/search',
    schema: {
      response: {
        200: SearchResponseSchema,
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: { max: 120, timeWindowMs: 60_000, key: 'GET /api/v1/search' },
    },
    handler: async (ctx, req, reply) => {
      const parsed = SearchQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        const invalidType = parsed.error.issues.some(
          (issue) => issue.message === 'invalid_search_type'
        )
        if (invalidType) {
          return reply.status(400).send(invalidSearchTypeResponse())
        }
        return reply.status(422).send(validationError(parsed.error, 'query'))
      }

      const secureCtx = ctx as SecureRouteContext
      const { q, types, limit } = parsed.data
      const { results, total } = await executeSearch({
        tx: secureCtx.tx,
        orgId: secureCtx.auth.orgId,
        q,
        types,
        limit,
      })

      if (results.some((result) => result.type === 'credential')) {
        await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          actorUserId: secureCtx.auth.userId,
          eventType: 'credential.search',
          resourceType: 'credential_metadata',
          payload: {
            query: q,
            types,
            resultCount: total,
          },
          request: req,
        })
      }

      return {
        data: {
          results,
          total,
          query: q,
          types,
        },
      }
    },
  })
}
