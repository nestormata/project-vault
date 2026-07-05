import { withOrg } from '@project-vault/db'
import { AuditEvent } from '@project-vault/shared'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { enforceUserRateLimit, parseBody } from '../../lib/route-helpers.js'
import { secureRoute, SameTransactionAuditWriteError } from '../../lib/secure-route.js'
import { writeMachineAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { createOrgAdminNotificationEntries } from '../../notifications/dispatcher.js'
import { verifyMachineRequest } from './machine-auth.js'
import {
  CacheActivatedBodySchema,
  CacheActivatedResponseSchema,
} from './machine-credential-schema.js'

const AUDIT_WRITE_FAILED = {
  code: 'audit_write_failed',
  message: 'Audit logging is unavailable',
} as const

const ROUTE_KEY = 'POST /api/v1/machine/cache-activated'
// D13: generous per-keyId budget — a legitimate agent sends at most one beacon per
// fallback-mode transition, and this is not a sensitive-data endpoint.
const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 60_000

/**
 * Story 7.2 D13/AC-15 — dedicated, machine-JWT-authenticated cache-activation beacon endpoint.
 * Registered on the same `requireAuth: false` public path as the credential-value route (D4),
 * with `verifyMachineRequest()` as its first action. Writes a `machine_cache.activated` audit
 * row and queues the FR38 alert via `createOrgAdminNotificationEntries()`. Fire-and-forget from
 * the agent's perspective — a `503` here is still possible (fail-closed audit write), but the
 * agent (packages/agent) silently drops any beacon failure per AC-15, so this endpoint failing
 * has no functional impact on the caller beyond a missed notification.
 */
export async function cacheActivatedRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/cache-activated',
    schema: {
      body: CacheActivatedBodySchema,
      response: {
        202: CacheActivatedResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    // D13: machine-authenticated via manual verifyMachineRequest() inside the requireAuth:false
    // public path — see route-exemptions.ts for the documented compensating controls.
    security: { requireAuth: false, writeAuditEvent: false, rateLimit: false },
    handler: async (_ctx, req, reply) => {
      const verified = await verifyMachineRequest(req, reply)
      if (!verified) return reply

      const parsed = parseBody(CacheActivatedBodySchema, req, reply)
      if (!parsed.success) return reply

      const rateLimited = !enforceUserRateLimit({
        userId: `machine-key:${verified.keyId}`,
        key: ROUTE_KEY,
        max: RATE_LIMIT_MAX,
        timeWindowMs: RATE_LIMIT_WINDOW_MS,
        reply,
      })
      if (rateLimited) return reply

      try {
        await withOrg(verified.orgId, async (tx) => {
          await writeMachineAuditEntryOrFailClosed(tx, {
            orgId: verified.orgId,
            resourceType: 'machine_user',
            resourceId: verified.machineUserId,
            eventType: AuditEvent.MACHINE_CACHE_ACTIVATED,
            machineUserId: verified.machineUserId,
            keyId: verified.keyId,
            payload: { activatedAt: parsed.data.activatedAt, threshold: parsed.data.threshold },
            request: req,
          })

          await createOrgAdminNotificationEntries({
            orgId: verified.orgId,
            tx,
            template: {
              templateId: 'machine_cache.activated',
              // No explicit severity — defaults to 'warning' (dispatcher.ts), matching every
              // other alert template in this codebase (machine_key.dormant,
              // security.anomalous_access) and the org-default minSeverity preference, so a
              // recipient with untouched notification preferences still receives this alert.
              payload: {
                machineUserId: verified.machineUserId,
                keyId: verified.keyId,
                activatedAt: parsed.data.activatedAt,
                threshold: parsed.data.threshold,
              },
            },
          })
        })
      } catch (error) {
        if (error instanceof SameTransactionAuditWriteError) {
          return reply.status(503).send(AUDIT_WRITE_FAILED)
        }
        throw error
      }

      reply.status(202)
      return { data: { recorded: true as const } }
    },
  })
}
