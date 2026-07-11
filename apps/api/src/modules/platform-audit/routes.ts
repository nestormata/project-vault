import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { PlatformAuditAction } from '@project-vault/shared'
import { getDb, withPlatformOperatorContext } from '@project-vault/db'
import { platformAuditEvents } from '@project-vault/db/schema'
import { ApiErrorSchema, defaultErrorResponses } from '../../lib/api-contracts.js'
import { validationError } from '../../lib/route-helpers.js'
import {
  secureRoute,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import {
  writePlatformAuditEntryOrFailClosed,
  SameTransactionPlatformAuditWriteError,
} from '../../lib/audit-or-fail-closed.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import {
  activateMaintenanceMode,
  deactivateMaintenanceMode,
  getMaintenanceModeStatus,
  MaintenanceModeAlreadyActiveError,
  MaintenanceModeStillUnavailableError,
} from './maintenance-mode.js'
import { verifyPlatformAuditRange, verifyRouteErrorResponse } from './verify.js'
import {
  MaintenanceModeActivateResponseSchema,
  MaintenanceModeBodySchema,
  MaintenanceModeDeactivateResponseSchema,
  MaintenanceModeStatusResponseSchema,
  PlatformAuditEventsQuerySchema,
  PlatformAuditEventsResponseSchema,
  PlatformAuditVerifyQuerySchema,
  PlatformAuditVerifyResponseSchema,
  VaultSealedResponseSchema,
  type PlatformAuditEventsQuery,
} from './schema.js'

const LOG_SCOPE_HEADER = 'X-Log-Scope'
const LOG_SCOPE_VALUE = 'platform'
/** AC-27-equivalent: distinct OpenAPI tag from the existing org-scoped 'Audit' tag. */
const OPENAPI_TAGS = ['Platform Audit']

/** AC-13: matches 8.1's `/org/audit/verify` rate limit exactly on both GET endpoints. */
const READ_RATE_LIMIT = { max: 20, timeWindowMs: 60_000 }

/** Code review fix: `handleGetVerify`'s self-audit write (AC-11) can itself throw
 * `SameTransactionPlatformAuditWriteError` for a non-maintenance-mode reason — previously
 * unhandled here (unlike every other write path in this diff), surfacing as an opaque 500
 * instead of the same 503 pattern the rest of this module already follows. */
const PLATFORM_AUDIT_WRITE_FAILED_ERROR = {
  code: 'platform_audit_write_failed',
  message: 'Platform audit logging is unavailable',
} as const

function buildEventsWhere(query: PlatformAuditEventsQuery) {
  const conditions = []
  if (query.operatorId) conditions.push(eq(platformAuditEvents.operatorId, query.operatorId))
  if (query.actionType) conditions.push(eq(platformAuditEvents.actionType, query.actionType))
  if (query.targetOrgId) conditions.push(eq(platformAuditEvents.targetOrgId, query.targetOrgId))
  if (query.targetUserId) conditions.push(eq(platformAuditEvents.targetUserId, query.targetUserId))
  if (query.from) conditions.push(gte(platformAuditEvents.createdAt, new Date(query.from)))
  if (query.to) conditions.push(lt(platformAuditEvents.createdAt, new Date(query.to)))
  return conditions.length > 0 ? and(...conditions) : undefined
}

/** AC-9: search + offset pagination over `platform_audit_events`, gated on the caller having
 * already established `app.platform_operator_verified` (D4) via `withPlatformOperatorContext`. */
async function listPlatformAuditEvents(query: PlatformAuditEventsQuery) {
  const where = buildEventsWhere(query)
  const offset = (query.page - 1) * query.limit

  return withPlatformOperatorContext(async (tx) => {
    // Code review fix: previously fetched every matching row's `id` into Node just to compute
    // `.length` — on a platform-wide, unbounded-growth table (retention up to 3650 days, AC-17)
    // a broad/empty filter turned every single page request into a full-table scan and transfer.
    // A real `count(*)` matches the existing precedent (`modules/audit/search.ts`).
    const [rows, [countRow]] = await Promise.all([
      tx
        .select()
        .from(platformAuditEvents)
        .where(where)
        .orderBy(desc(platformAuditEvents.createdAt))
        .limit(query.limit)
        .offset(offset),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(platformAuditEvents)
        .where(where),
    ])
    const total = countRow?.count ?? 0

    return {
      items: rows.map((row) => ({
        id: row.id,
        operatorId: row.operatorId,
        actionType: row.actionType,
        targetOrgId: row.targetOrgId,
        targetUserId: row.targetUserId,
        payload: row.payload as Record<string, unknown>,
        ipAddress: row.ipAddress,
        timestamp: row.createdAt.toISOString(),
      })),
      page: query.page,
      limit: query.limit,
      total,
      hasNext: query.page * query.limit < total,
    }
  })
}

async function handleGetEvents(
  _ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const parsed = PlatformAuditEventsQuerySchema.safeParse(req.query)
  if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))
  return { data: await listPlatformAuditEvents(parsed.data) }
}

async function handleGetVerify(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const auth = (ctx as SecureRouteContext).auth
  const parsed = PlatformAuditVerifyQuerySchema.safeParse(req.query)
  if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))

  try {
    const result = await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.platform_operator_verified', 'true', true)`)
      const verifyResult = await verifyPlatformAuditRange(tx, {
        from: parsed.data.from,
        to: parsed.data.to,
      })

      // AC-11: audit-of-the-auditor — this endpoint's own successful call self-audits.
      await writePlatformAuditEntryOrFailClosed(tx, {
        operatorId: auth.userId,
        actionType: PlatformAuditAction.INTEGRITY_VERIFY_RUN,
        payload: {
          from: parsed.data.from,
          to: parsed.data.to,
          rowsChecked: verifyResult.rowsChecked,
          passed: verifyResult.passed,
          failedCount: verifyResult.failedCount,
        },
        request: req,
      })

      return verifyResult
    })
    return { data: result }
  } catch (error) {
    if (error instanceof SameTransactionPlatformAuditWriteError) {
      return reply.status(503).send(PLATFORM_AUDIT_WRITE_FAILED_ERROR)
    }
    const mapped = verifyRouteErrorResponse(error, {
      code: 'platform_audit_key_unavailable',
      message: 'Platform audit key is unavailable while the vault is sealed',
    })
    if (mapped) return reply.status(mapped.status).send(mapped.body)
    throw error
  }
}

async function handleGetMaintenanceModeStatus(
  _ctx: SecureRouteContext | PublicRouteContext,
  _req: FastifyRequest,
  _reply: FastifyReply
) {
  const status = await getDb().transaction((tx) => getMaintenanceModeStatus(tx))
  return {
    data: {
      active: status.active,
      reason: status.reason,
      activatedAt: status.activatedAt?.toISOString() ?? null,
      deactivatedAt: status.deactivatedAt?.toISOString() ?? null,
      pendingEntriesCount: status.pendingEntriesCount,
    },
  }
}

async function handlePostMaintenanceMode(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const auth = (ctx as SecureRouteContext).auth
  const parsed = MaintenanceModeBodySchema.safeParse(req.body)
  if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))

  if (parsed.data.action === 'deactivate') {
    try {
      const result = await deactivateMaintenanceMode(getDb(), auth.userId)
      return { active: result.active, deactivatedAt: result.deactivatedAt.toISOString() }
    } catch (error) {
      if (error instanceof MaintenanceModeStillUnavailableError) {
        return reply
          .status(503)
          .send({ code: 'platform_audit_write_failed', message: error.message })
      }
      throw error
    }
  }

  try {
    const activated = await getDb().transaction(async (tx) => {
      const result = await activateMaintenanceMode(tx, {
        reason: parsed.data.reason as string,
        userId: auth.userId,
      })
      await writePlatformAuditEntryOrFailClosed(tx, {
        operatorId: auth.userId,
        actionType: PlatformAuditAction.MAINTENANCE_MODE_ACTIVATED,
        payload: { reason: result.reason },
        request: req,
      })
      return result
    })
    return {
      active: activated.active,
      activatedAt: activated.activatedAt.toISOString(),
      reason: activated.reason,
    }
  } catch (error) {
    if (error instanceof MaintenanceModeAlreadyActiveError) {
      return reply
        .status(409)
        .send({ code: 'maintenance_mode_already_active', message: error.message })
    }
    throw error
  }
}

/**
 * Story 9.4 AC-9 through AC-16: `modules/platform-audit/` — a new sibling module to
 * `modules/platform-admin/` (distinct concept: audit-log read/verify vs. instance
 * administration). Every route: `requireOrgScope: false` + `requirePlatformOperator: true` +
 * `requireMfa: true` — never `allowedRoles`/`requireOrgRole` (AC-10). The `onSend` hook below
 * stamps `X-Log-Scope: platform` on every response from this plugin instance (success or error,
 * AC-12) — Fastify's per-register encapsulation scopes it to only these three routes.
 */
export async function platformAuditRoutes(fastify: FastifyApp): Promise<void> {
  fastify.addHook(
    'onSend',
    (
      _request: FastifyRequest,
      reply: FastifyReply,
      payload: unknown,
      done: (err: Error | null, payload?: unknown) => void
    ) => {
      reply.header(LOG_SCOPE_HEADER, LOG_SCOPE_VALUE)
      done(null, payload)
    }
  )

  secureRoute(fastify, {
    method: 'GET',
    url: '/audit/events',
    schema: {
      tags: OPENAPI_TAGS,
      response: {
        200: PlatformAuditEventsResponseSchema,
        ...defaultErrorResponses,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { ...READ_RATE_LIMIT, key: 'GET /api/v1/platform/audit/events' },
    },
    handler: handleGetEvents,
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/audit/verify',
    schema: {
      tags: OPENAPI_TAGS,
      response: {
        200: PlatformAuditVerifyResponseSchema,
        ...defaultErrorResponses,
        422: ApiErrorSchema,
        // AC-20: VaultSealedResponseSchema included — vaultGuard's own onRequest hook sends its
        // `{status, message}` body through this route's compiled 503 serializer.
        503: z.union([ApiErrorSchema, VaultSealedResponseSchema]),
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { ...READ_RATE_LIMIT, key: 'GET /api/v1/platform/audit/verify' },
    },
    handler: handleGetVerify,
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/maintenance-mode',
    schema: {
      tags: OPENAPI_TAGS,
      body: MaintenanceModeBodySchema,
      response: {
        200: z.union([
          MaintenanceModeActivateResponseSchema,
          MaintenanceModeDeactivateResponseSchema,
        ]),
        ...defaultErrorResponses,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        503: z.union([ApiErrorSchema, VaultSealedResponseSchema]),
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { max: 10, timeWindowMs: 60_000, key: 'POST /api/v1/platform/maintenance-mode' },
    },
    handler: handlePostMaintenanceMode,
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/maintenance-mode',
    schema: {
      tags: OPENAPI_TAGS,
      response: {
        200: MaintenanceModeStatusResponseSchema,
        ...defaultErrorResponses,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: false,
      writeAuditEvent: false,
      rateLimit: { ...READ_RATE_LIMIT, key: 'GET /api/v1/platform/maintenance-mode' },
    },
    handler: handleGetMaintenanceModeStatus,
  })
}
