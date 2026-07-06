import type { FastifyRequest } from 'fastify'
import type { FastifyReply } from 'fastify/types/reply.js'
import { defaultErrorResponses, ApiErrorSchema } from '../../lib/api-contracts.js'
import { validationError } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AuditVerifyQuerySchema, AuditVerifyResponseSchema } from './schema.js'
import { InvalidRangeError, RangeTooLargeError, verifyAuditRange } from './verify.js'

const AUDIT_KEY_UNAVAILABLE_MESSAGE = 'getAuditKey: vault is sealed — audit key unavailable'

export async function auditRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/audit/verify',
    // No `querystring: AuditVerifyQuerySchema` here — Fastify's own schema-based query validator
    // runs before the SecureRoute handler (and before `attachValidation`, which secure-route.ts
    // only wires for `schema.body`), rejects a missing/invalid required field with its own
    // `400 { error: ... }` shape, and that shape doesn't match `ApiErrorSchema` (`{code, message}`)
    // declared below for 400 — the resulting serialization failure surfaces as an opaque 500
    // instead of AC-6's required `422 { code: "validation_error" }`. `AuditVerifyQuerySchema` is
    // still the single source of truth for query shape: the handler's own `safeParse` below is
    // the sole validation path, matching the `GET /org/security-alerts` precedent.
    schema: {
      response: {
        200: AuditVerifyResponseSchema,
        ...defaultErrorResponses,
        422: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner'],
      // D5 — no requireMfa: true. mfa-policy-matrix.md:62 intentionally leaves
      // security-visibility GET endpoints off requireMfa so an owner mid-MFA-grace-period isn't
      // locked out of seeing security state; route is registered in
      // MFA_ENROLLMENT_EXEMPT_ROUTES (packages/shared/src/constants/mfa-exempt-routes.ts).
      //
      // writeAuditEvent: false — the default SecureRoute audit writer's `payload` callback only
      // receives the request's params/query, not the handler's computed result, so it cannot
      // produce the rowsChecked/passed/failedCount payload D7 requires. The audit row is written
      // inline below via writeHumanAuditEntryOrFailClosed, in the same transaction, matching
      // every other route in this codebase that needs a handler-computed audit payload (e.g.
      // POST /org/users/:userId/deactivate).
      writeAuditEvent: false,
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'GET /api/v1/org/audit/verify' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = AuditVerifyQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))

      let result: Awaited<ReturnType<typeof verifyAuditRange>>
      try {
        result = await verifyAuditRange(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          from: parsed.data.from,
          to: parsed.data.to,
        })
      } catch (error) {
        if (error instanceof InvalidRangeError) {
          return reply.status(422).send({ code: 'invalid_range', message: error.message })
        }
        if (error instanceof RangeTooLargeError) {
          return reply.status(422).send({ code: 'range_too_large', message: error.message })
        }
        if (error instanceof Error && error.message === AUDIT_KEY_UNAVAILABLE_MESSAGE) {
          return reply.status(503).send({
            code: 'audit_key_unavailable',
            message: 'Audit key is unavailable while the vault is sealed',
          })
        }
        throw error
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'audit.integrity_verify_run',
        resourceType: 'audit_log_entries',
        payload: {
          from: parsed.data.from,
          to: parsed.data.to,
          rowsChecked: result.rowsChecked,
          passed: result.passed,
          failedCount: result.failedCount,
        },
        request: req,
      })

      return { data: result }
    },
  })
}
