import { PublicStatusPageResponseSchema } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseParams } from '../../lib/route-helpers.js'
import { secureRoute } from '../../lib/secure-route.js'
import { StatusPageTokenParamsSchema } from './schema.js'
import { hashStatusPageToken, statusPageTokenMatches } from './status-page-tokens.js'
import { findStatusPageByTokenHash, getPublicStatusPageServices } from './status-page-service.js'

const STATUS_PAGE_NOT_FOUND = {
  code: 'status_page_not_found',
  message: 'Status page not found',
} as const

const PUBLIC_GET_RATE_LIMIT = { max: 60, timeWindowMs: 60_000 }

/**
 * Story 6.3 (ADR-6.3-05/09, AC 12-14, 18): the public, unauthenticated, token-based status page
 * read. Standalone `/api/v1/status-pages` prefix (not nested under `/projects/`), mirroring
 * `/api/v1/invitations/:token`'s own standalone-prefix precedent. Never audited (Known Scope
 * Boundaries) — high-frequency, unauthenticated, non-actor traffic.
 */
export async function publicStatusPageRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/:token',
    schema: {
      response: { 200: PublicStatusPageResponseSchema, 404: ApiErrorSchema, 429: ApiErrorSchema },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: {
        ...PUBLIC_GET_RATE_LIMIT,
        key: 'GET /api/v1/status-pages/:token',
      },
    },
    handler: async (_ctx, req, reply) => {
      const params = parseParams(StatusPageTokenParamsSchema, req, reply)
      if (!params) return reply

      // ADR-6.3-09 step 1: single point-lookup by the unique hashed-token index via the admin
      // connection — the org is unknown until this row resolves, so a per-org RLS-scoped scan
      // isn't an option here. AC 12: unknown/malformed/wrong/disabled tokens all collapse to the
      // same 404, same latency profile — no early-return fast-path for "obviously malformed".
      const tokenHash = hashStatusPageToken(params.token)
      const statusPage = await findStatusPageByTokenHash(tokenHash)
      if (!statusPage || !statusPageTokenMatches(statusPage.tokenHash, params.token)) {
        reply.status(404).send(STATUS_PAGE_NOT_FOUND)
        return reply
      }

      // ADR-6.3-09 step 2: re-scope with withOrg once the org is known — only the initial
      // org-unknown point lookup runs on the admin connection. `null` means the status page was
      // disabled/deleted since step 1, or its project has since been archived — both collapse to
      // the same 404 as an unknown token (AC 16: no grace period; archived projects are excluded
      // from public visibility, matching the health dashboard's own archived-project exclusion).
      const services = await getPublicStatusPageServices(statusPage.orgId, statusPage.id)
      if (services === null) {
        reply.status(404).send(STATUS_PAGE_NOT_FOUND)
        return reply
      }

      // Known Scope Boundaries: no intermediate CDN/proxy may serve a stale enabled/service-list
      // state after a regenerate or disable.
      reply.header('Cache-Control', 'no-store')
      return { data: { services } }
    },
  })
}
