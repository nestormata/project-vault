import { CapabilitiesResponseSchema, CapabilityId } from '@project-vault/shared'
import type { CapabilityIdValue } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { assertCapability } from '../../lib/capability-gate.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { LIST_RATE_LIMIT } from '../monitoring/routes.js'

/**
 * Story 23.7 — `GET /api/v1/capabilities`: the previously-undesigned read endpoint Story 23.3
 * deleted from its own scope (Revision 3 removal note) specifically so this story could design it
 * against a real consumer. Returns a boolean map only — `.permitted` per `CapabilityId`, never
 * `reasonCode`/`message` (AC-1's deliberate exclusion — see the schema's own doc comment).
 *
 * `requireOrgScope: false` is mandatory (AC-2): `runProtectedHandler()` opens `db.transaction()`
 * only when `requireOrgScope` is true, and that would put every `assertCapability()` call in the
 * fan-out loop below inside an open transaction, violating Story 23.3 AC-19's pool-checkout
 * invariant. No `security.capability` is set — this route is not gated on one capability, it
 * reads the whole map imperatively. `writeAuditEvent: false` — reading your own org's entitlement
 * map is not an audit-worthy event; any denial surfaced by the fan-out is still audited by the
 * existing `capability.denied` predicate inside `assertCapability()`'s call chain (Story 23.3
 * AC-25), unmodified and un-duplicated by this route.
 */
export async function capabilitiesRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/capabilities',
    schema: {
      response: { 200: CapabilitiesResponseSchema, 401: ApiErrorSchema },
    },
    security: {
      requireOrgScope: false,
      writeAuditEvent: false,
      rateLimit: { ...LIST_RATE_LIMIT, key: 'GET /api/v1/capabilities' },
    },
    handler: async (ctx) => {
      // AC-4: orgId/userId/orgRole resolved ONLY from request.auth (the closure passed in by
      // secure-route.ts) — never from a query string, path param, or header. No `orgId` input of
      // any kind is read anywhere in this handler.
      const { orgId, userId, orgRole } = (ctx as SecureRouteContext).auth

      const ids = Object.values(CapabilityId) as CapabilityIdValue[]
      const entries = await Promise.all(
        ids.map(async (capability) => {
          const decision = await assertCapability({
            capability,
            orgId,
            userId,
            orgRole,
            surface: 'org',
          })
          return [capability, decision.permitted] as const
        })
      )

      const capabilities = Object.fromEntries(entries) as Record<CapabilityIdValue, boolean>
      return { data: { capabilities } }
    },
  })
}
