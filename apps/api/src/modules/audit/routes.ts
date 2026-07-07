import { gunzipSync } from 'node:zlib'
import type { FastifyRequest } from 'fastify'
import type { FastifyReply } from 'fastify/types/reply.js'
import { eq } from 'drizzle-orm'
import { auditExports } from '@project-vault/db/schema'
import { defaultErrorResponses, ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams, validationError } from '../../lib/route-helpers.js'
import { resolvePaginationOffset, PAGE_OUT_OF_RANGE_ERROR } from '../../lib/pagination.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import type { BossService } from '../../lib/boss.js'
import { VaultSealedError } from '../vault/key-service.js'
import {
  AuditVerifyQuerySchema,
  AuditVerifyResponseSchema,
  AuditEventsQuerySchema,
  AuditEventsResponseSchema,
  AuditExportRequestSchema,
  AuditExportJobParamsSchema,
  AuditExportTriggerResponseSchema,
  AuditExportStatusResponseSchema,
  AuditForwardingConfigRequestSchema,
  AuditForwardingConfigResponseSchema,
  AuditRetentionConfigRequestSchema,
  AuditRetentionConfigResponseSchema,
  type AuditExportRequest,
  type AuditForwardingConfigRequest,
  type AuditRetentionConfigRequest,
} from './schema.js'
import { InvalidRangeError, RangeTooLargeError, verifyAuditRange } from './verify.js'
import { searchAuditEvents } from './search.js'
import { AUDIT_EXPORT_MAX_RANGE_DAYS } from './export.js'
import { configureForwarding } from './forwarding.js'
import { configureRetention } from './retention.js'
import {
  AccessReportRequestSchema,
  AccessReportResponseSchema,
  type AccessReportRequest,
} from './access-report-schema.js'
import {
  buildAccessReport,
  buildAccessReportCsv,
  paginateAccessReportUsers,
  InvalidAsOfError,
} from './access-report.js'
import { UnsafeForwardingUrlError } from '../../lib/safe-fetch.js'

/** AC-5 — reuses the existing resolvePaginationOffset()/PAGE_OUT_OF_RANGE_ERROR pagination-depth
 * mechanism (no new one invented for this story), with a cap sized for the audit-events volume. */
export const AUDIT_EVENTS_MAX_OFFSET = 10_000

/** AC-9 — bounds the audit:export worker's retry window against the best-effort, post-insert
 * `boss.send()` racing the enqueuing transaction's own commit (see export.ts's row-not-found
 * retry comment) — mirrors this codebase's other post-commit-notification patterns. */
const AUDIT_EXPORT_JOB_RETRY_LIMIT = 5
const AUDIT_EXPORT_JOB_RETRY_DELAY_SECONDS = 2

type BossFastify = FastifyApp & { boss?: BossService }

const MS_PER_DAY = 24 * 60 * 60 * 1000

type AuditExportRow = typeof auditExports.$inferSelect

/** Shared by the export status and download routes: resolves `:jobId` to its row, or sends the
 * appropriate error response (422 invalid params via parseParams, 404 not found — RLS makes a
 * cross-org row invisible rather than a 403, matching Story 8.1's import_not_found precedent)
 * and returns undefined. Callers must `return reply` when this returns undefined. */
async function loadExportJobOrNotFound(
  secureCtx: SecureRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<AuditExportRow | undefined> {
  const params = parseParams(AuditExportJobParamsSchema, req, reply)
  if (!params) return undefined

  const [row] = await secureCtx.tx
    .select()
    .from(auditExports)
    .where(eq(auditExports.id, params.jobId))
    .limit(1)
  if (!row) {
    reply.status(404).send({ code: 'export_not_found', message: 'Export not found' })
    return undefined
  }
  return row
}

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
        if (error instanceof VaultSealedError) {
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

  secureRoute(fastify, {
    method: 'GET',
    url: '/audit/events',
    // No `querystring:` schema here — same rationale as GET /audit/verify above: Fastify's own
    // query validator runs before SecureRoute and doesn't produce the ApiErrorSchema shape AC-4
    // requires. AuditEventsQuerySchema remains the single source of truth via the handler's own
    // safeParse below.
    schema: {
      response: {
        200: AuditEventsResponseSchema,
        ...defaultErrorResponses,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner'],
      // Matches GET /audit/verify's D5 rationale: a security-visibility read endpoint stays off
      // requireMfa so an owner mid-MFA-grace-period isn't locked out of seeing security state.
      // Registered in MFA_ENROLLMENT_EXEMPT_ROUTES accordingly.
      //
      // writeAuditEvent: false — the default SecureRoute audit writer's payload callback can't
      // see the handler's computed resultCount, so the audit row is written inline below,
      // matching GET /audit/verify's own precedent for a handler-computed payload.
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/org/audit/events' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = AuditEventsQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'query'))
      const { actorId, eventType, resourceId, projectId, from, to, page, limit } = parsed.data

      if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
        return reply
          .status(422)
          .send({ code: 'invalid_range', message: 'from must not be after to' })
      }

      const resolved = resolvePaginationOffset(page, limit, AUDIT_EVENTS_MAX_OFFSET)
      if (!resolved) return reply.status(422).send(PAGE_OUT_OF_RANGE_ERROR)

      const result = await searchAuditEvents(secureCtx.tx, {
        actorId,
        eventType,
        resourceId,
        projectId,
        from,
        to,
        offset: resolved.offset,
        limit: resolved.pagination.limit,
      })

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'audit.search_run',
        resourceType: 'audit_log_entries',
        payload: {
          actorId,
          eventType,
          resourceId,
          projectId,
          from,
          to,
          resultCount: result.data.length,
        },
        request: req,
      })

      return {
        data: result.data,
        page: resolved.pagination.page,
        limit: resolved.pagination.limit,
        total: result.total,
        hasNext: resolved.pagination.page * resolved.pagination.limit < result.total,
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/audit/export',
    schema: {
      response: {
        202: AuditExportTriggerResponseSchema,
        ...defaultErrorResponses,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner'],
      requireMfa: true,
      // writeAuditEvent: false — matches every other body-validated mutation route in this
      // codebase (e.g. POST /projects/:projectId/credentials): the SecureRoute audit-send-guard
      // makes any *audited* handler's early-exit `reply.status(422).send(...)` calls throw (it
      // requires audited handlers to `return` data, not call reply.send() directly), so
      // body/range validation must run under writeAuditEvent: false, with the audit row written
      // manually via writeHumanAuditEntryOrFailClosed on the success path only (AC-24).
      writeAuditEvent: false,
      rateLimit: { max: 10, timeWindowMs: 60_000, key: 'POST /api/v1/org/audit/export' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = parseBody<AuditExportRequest>(AuditExportRequestSchema, req, reply)
      if (!parsed.success) return reply

      const { from, to, format, includeIntegrityReport } = parsed.data
      if (new Date(to).getTime() < new Date(from).getTime()) {
        return reply
          .status(422)
          .send({ code: 'invalid_range', message: 'to must not be before from' })
      }
      const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / MS_PER_DAY
      if (spanDays > AUDIT_EXPORT_MAX_RANGE_DAYS) {
        return reply.status(422).send({
          code: 'range_too_large',
          message: `Range exceeds ${AUDIT_EXPORT_MAX_RANGE_DAYS} days; narrow the from/to window`,
        })
      }

      const [inserted] = await secureCtx.tx
        .insert(auditExports)
        .values({
          orgId: secureCtx.auth.orgId,
          requestedBy: secureCtx.auth.userId,
          fromDate: new Date(from),
          toDate: new Date(to),
          format,
          includeIntegrityReport,
          status: 'pending',
        })
        .returning({ id: auditExports.id })
      if (!inserted) throw new Error('expected audit export row to be inserted')

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'audit.export_requested',
        resourceType: 'audit_log_entries',
        resourceId: inserted.id,
        payload: { from, to, format, includeIntegrityReport },
        request: req,
      })

      // Best-effort, post-insert enqueue (matches this codebase's established notification-
      // dispatch pattern, e.g. rotation/routes.ts's sendPendingRotationNotifications) — the
      // export row is already durable; export.ts's worker retries via AUDIT_EXPORT_JOB_RETRY_*
      // if it runs before this transaction commits. `fastify.boss` is read here (per request),
      // not captured at route-registration time, since main.ts decorates it onto the fastify
      // instance AFTER createApp() has already registered every module's routes.
      const boss = (fastify as BossFastify).boss
      if (boss) {
        await boss.send(
          'audit:export',
          { exportId: inserted.id, orgId: secureCtx.auth.orgId },
          {
            retryLimit: AUDIT_EXPORT_JOB_RETRY_LIMIT,
            retryDelay: AUDIT_EXPORT_JOB_RETRY_DELAY_SECONDS,
            singletonKey: `audit:export:${inserted.id}`,
          }
        )
      }

      reply.status(202)
      return { data: { jobId: inserted.id, status: 'pending' as const } }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/audit/exports/:jobId',
    schema: {
      response: {
        200: AuditExportStatusResponseSchema,
        ...defaultErrorResponses,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner'],
      writeAuditEvent: false,
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/org/audit/exports/:jobId' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const row = await loadExportJobOrNotFound(secureCtx, req, reply)
      if (!row) return reply

      return {
        data: {
          jobId: row.id,
          status: row.status as 'pending' | 'processing' | 'completed' | 'failed',
          errorReason: row.errorReason,
          rowsChecked: row.rowsChecked,
          integritySummary: row.integritySummary as {
            passed: number
            failedCount: number
            failed?: unknown[]
          } | null,
          downloadUrl:
            row.status === 'completed' ? `/api/v1/org/audit/exports/${row.id}/download` : null,
          createdAt: row.createdAt.toISOString(),
          completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/audit/exports/:jobId/download',
    security: {
      allowedRoles: ['owner'],
      writeAuditEvent: false,
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'GET /api/v1/org/audit/exports/:jobId/download',
      },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const row = await loadExportJobOrNotFound(secureCtx, req, reply)
      if (!row) return reply
      if (row.status !== 'completed' || !row.fileContent) {
        return reply.status(404).send({
          code: 'export_not_ready',
          message: 'Export is not complete or has no downloadable content',
        })
      }

      const csv = gunzipSync(row.fileContent)
      reply.header('Content-Type', 'text/csv')
      reply.header('Content-Disposition', `attachment; filename="audit-export-${row.id}.csv"`)
      return reply.send(csv)
    },
  })

  // Story 8.3 AC-1 through AC-8 — point-in-time access report. `writeAuditEvent: false` +
  // a manual writeHumanAuditEntryOrFailClosed call below (not the default SecureRoute audit
  // writer): the default writer's payload callback only receives `{ params, query }`, but this
  // route's `asOf`/`format` are POST-body fields and `userCount` is only known after the report
  // is built — the same reason GET /audit/verify and GET /audit/events (immediately above) both
  // use this exact manual-write pattern rather than `writeAuditEvent: true`.
  secureRoute(fastify, {
    method: 'POST',
    url: '/audit/access-report',
    schema: {
      body: AccessReportRequestSchema,
      response: {
        200: AccessReportResponseSchema,
        ...defaultErrorResponses,
        422: ApiErrorSchema,
      },
    },
    security: {
      allowedRoles: ['owner'],
      // Matches GET /audit/verify's and GET /audit/events' D5 rationale immediately above: a
      // compliance-visibility read endpoint stays off requireMfa so an owner mid-MFA-grace-period
      // isn't locked out of seeing access-governance state. Registered in
      // MFA_ENROLLMENT_EXEMPT_ROUTES (packages/shared/src/constants/mfa-exempt-routes.ts).
      writeAuditEvent: false,
      rateLimit: { max: 30, timeWindowMs: 60_000, key: 'POST /api/v1/org/audit/access-report' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = parseBody<AccessReportRequest>(AccessReportRequestSchema, req, reply)
      if (!parsed.success) return reply

      let result: Awaited<ReturnType<typeof buildAccessReport>>
      try {
        result = await buildAccessReport(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          asOf: parsed.data.asOf,
        })
      } catch (error) {
        if (error instanceof InvalidAsOfError) {
          return reply.status(422).send({ code: error.code, message: error.message })
        }
        throw error
      }

      const { format, page, limit } = parsed.data

      // AC-7 — this endpoint's own call is audited exactly once per request, regardless of
      // which format branch below actually returns (same-transaction invariant, NFR-REL5).
      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'audit.access_report_generated',
        resourceType: 'audit_log_entries',
        payload: { asOf: result.asOf, userCount: result.users.length, format },
        request: req,
      })

      if (format === 'csv') {
        const csv = buildAccessReportCsv(result.users)
        reply.header('Content-Type', 'text/csv')
        return reply.send(csv)
      }

      const { pageUsers, total, hasNext } = paginateAccessReportUsers(result.users, page, limit)

      return {
        data: {
          users: pageUsers,
          generatedAt: new Date().toISOString(),
          asOf: result.asOf,
          page,
          limit,
          total,
          hasNext,
        },
      }
    },
  })

  // D3 — OpenAPI-description-equivalent note (this codebase's generate-spec.ts does not yet
  // document any /audit/* route, including Story 8.1's /audit/verify, so this comment plus the
  // story's Dev Notes are the documented record of this trade-off): webhook delivery runs on an
  // every-minute watermark-cursor catchup cron, so the delivery SLA is "within ~60-120 seconds
  // of insertion, best-effort" — not a literal sub-60-second guarantee. S3 forwarding is a daily
  // batch (`audit:s3-forward-daily`), not a webhook and not delivered per-row at all.
  // AC-19 — "write-once" enforcement for S3 forwarding is explicitly the operator's own
  // responsibility via S3 Object Lock configured on their bucket; the vault does not and cannot
  // configure bucket-level Object Lock itself.
  secureRoute(fastify, {
    method: 'PUT',
    url: '/audit/forwarding',
    schema: {
      response: {
        200: AuditForwardingConfigResponseSchema,
        ...defaultErrorResponses,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      // writeAuditEvent: false — same body-validation-vs-audit-guard rationale as
      // POST /audit/export above; the audit row is written manually, success path only.
      writeAuditEvent: false,
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'PUT /api/v1/org/audit/forwarding' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = parseBody<AuditForwardingConfigRequest>(
        AuditForwardingConfigRequestSchema,
        req,
        reply
      )
      if (!parsed.success) return reply

      let result: Awaited<ReturnType<typeof configureForwarding>>
      try {
        result = await configureForwarding(secureCtx.tx, secureCtx.auth.orgId, parsed.data)
      } catch (error) {
        if (error instanceof UnsafeForwardingUrlError) {
          return reply.status(422).send({ code: 'unsafe_forwarding_url', message: error.message })
        }
        throw error
      }

      // AC-20 — never echoes back secretHeader/secretAccessKey in the response or audit payload.
      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'audit.forwarding_configured',
        resourceType: 'audit_forwarding_config',
        payload: { type: result.type, enabled: result.enabled },
        request: req,
      })

      return { data: result }
    },
  })

  secureRoute(fastify, {
    method: 'PUT',
    url: '/audit/retention',
    schema: {
      response: {
        200: AuditRetentionConfigResponseSchema,
        ...defaultErrorResponses,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'PUT /api/v1/org/audit/retention' },
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = parseBody<AuditRetentionConfigRequest>(
        AuditRetentionConfigRequestSchema,
        req,
        reply
      )
      if (!parsed.success) return reply

      const result = await configureRetention(
        secureCtx.tx,
        secureCtx.auth.orgId,
        parsed.data.retentionDays
      )

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'audit.retention_configured',
        resourceType: 'audit_retention_config',
        payload: { retentionDays: result.retentionDays },
        request: req,
      })

      return { data: result }
    },
  })
}
