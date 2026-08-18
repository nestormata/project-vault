import { z } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { SameTransactionPlatformAuditWriteError } from '../../lib/audit-or-fail-closed.js'
import { AppError } from '../../lib/errors.js'
import { parseBody, type SafeParseSchema } from '../../lib/route-helpers.js'
import type { SecureRouteContext } from '../../lib/secure-route.js'

/**
 * Story 9.2 D2: `/admin/orgs`, `/admin/settings`, and `/admin/resource-usage` all share the same
 * 401/403/503 error envelope (503's vault-sealed union body mirrors backup/schema.ts's
 * VaultSealedResponseSchema precedent, same pattern as api-contracts.ts's `defaultErrorResponses`/
 * `paginatedListMetaFields`) — centralized here once instead of repeated near-verbatim in every
 * route file (jscpd zero-duplication gate).
 *
 * Deliberately NOT centralizing the `security: {...}` block itself: each route's `secureRoute()`
 * call keeps that object literal and inline — platform-admin-route-audit.test.ts asserts against
 * its literal source text as a load-bearing guard against a future refactor silently dropping
 * `requireMfa`/`requirePlatformOperator`, so it must stay a literal, not become a named reference.
 */
export const VaultSealedResponseSchema = z.object({ status: z.string(), message: z.string() })

export const PLATFORM_ADMIN_TAGS = ['Platform Admin']

export const PLATFORM_ADMIN_ERROR_RESPONSES = {
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  503: z.union([VaultSealedResponseSchema, ApiErrorSchema]),
}

export function sendPlatformAuditWriteFailure(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof SameTransactionPlatformAuditWriteError)) return false
  reply.status(503).send({
    code: 'platform_audit_write_failed',
    message: 'Platform audit logging is unavailable',
  })
  return true
}

/**
 * Story 22.3: the AppError / platform-audit-write-failure catch tail shared by every mutation
 * handler in this module family (orgs-routes.ts, audit-quota-routes.ts, and friends) —
 * centralized here once instead of repeated near-verbatim in each handler's `catch` block
 * (jscpd zero-duplication gate). Rethrows anything neither branch recognizes.
 */
export function handlePlatformMutationError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({ code: error.code, message: error.message })
  }
  if (sendPlatformAuditWriteFailure(error, reply)) return reply
  throw error
}

/**
 * POST /admin/orgs and PUT /admin/settings both cast the secureRoute context and parse+validate
 * their request body the same way before their (otherwise unrelated) handler logic runs — shared
 * here so the two handlers don't duplicate that preamble verbatim (jscpd dedup).
 */
export function beginSecureMutation<T>(
  ctx: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  schema: SafeParseSchema<T>
): { secureCtx: SecureRouteContext; data: T } | undefined {
  const parsed = parseBody(schema, req, reply)
  if (!parsed.success) return undefined
  return { secureCtx: ctx as SecureRouteContext, data: parsed.data }
}
