import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Tx } from '@project-vault/db'
import type { ZodType } from 'zod/v4'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import {
  secureRoute,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import {
  writeHumanAuditEntryOrFailClosed,
  type SameTransactionAuditInput,
} from '../../lib/audit-or-fail-closed.js'
import { rejectIfProjectArchived } from '../projects/archive-guards.js'
import { findProjectInOrg } from '../credentials/service.js'
import {
  CertificateParamsSchema,
  CertificateRecordListResponseSchema,
  CertificateRecordResponseSchema,
  CreateCertificateBodySchema,
  CreateDomainRecordBodySchema,
  CreatePaymentRecordBodySchema,
  CreateServiceEndpointBodySchema,
  DomainRecordListResponseSchema,
  DomainRecordParamsSchema,
  DomainRecordResponseSchema,
  PaymentRecordListResponseSchema,
  PaymentRecordResponseSchema,
  ProjectScopeParamsSchema,
  ServiceParamsSchema,
  ServiceEndpointParamsSchema,
  ServiceEndpointListResponseSchema,
  ServiceEndpointResponseSchema,
  HealthHistoryQuerySchema,
  HealthHistoryResponseSchema,
  AlertParamsSchema,
  AlertListQuerySchema,
  AlertListResponseSchema,
  MonitoringAlertResponseSchema,
  SnoozeAlertBodySchema,
  UpdateCertificateBodySchema,
  UpdateDomainRecordBodySchema,
  UpdatePaymentRecordBodySchema,
  UpdateServiceEndpointBodySchema,
} from './schema.js'
import {
  createCertificateRecord,
  createDomainRecord,
  createPaymentRecord,
  createServiceEndpoint,
  deleteCertificateRecord,
  deleteDomainRecord,
  deletePaymentRecord,
  deleteServiceEndpoint,
  dismissMonitoringAlert,
  AlertAlreadyDismissedError,
  findServiceEndpointInProject,
  listCertificateRecords,
  listDomainRecords,
  listHealthHistory,
  listMonitoringAlerts,
  listPaymentRecords,
  listServiceEndpoints,
  serializeCertificateRecord,
  serializeDomainRecord,
  serializeMonitoringAlert,
  serializePaymentRecord,
  serializeServiceEndpoint,
  ServiceEndpointLimitReachedError,
  snoozeMonitoringAlert,
  suppressPendingNotificationsForAsset,
  updateCertificateRecord,
  updateDomainRecord,
  updatePaymentRecord,
  updateServiceEndpoint,
  UrlNotMonitorableError,
} from './service.js'

const PROJECT_NOT_FOUND = { code: 'project_not_found', message: 'Project not found' } as const
const SERVICE_NOT_FOUND = { code: 'service_not_found', message: 'Service not found' } as const
const CERTIFICATE_NOT_FOUND = {
  code: 'certificate_not_found',
  message: 'Certificate not found',
} as const
const DOMAIN_RECORD_NOT_FOUND = {
  code: 'domain_record_not_found',
  message: 'Domain record not found',
} as const
const SERVICE_ENDPOINT_NOT_FOUND = {
  code: 'service_endpoint_not_found',
  message: 'Service endpoint not found',
} as const
const ALERT_NOT_FOUND = { code: 'alert_not_found', message: 'Alert not found' } as const

/** AC 1/AC 3: maps the service-layer's typed validation errors to their documented 422 body. */
function sendServiceEndpointWriteError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof UrlNotMonitorableError) {
    reply.status(422).send({ code: error.code, message: error.message })
    return true
  }
  if (error instanceof ServiceEndpointLimitReachedError) {
    reply.status(422).send({ code: error.code, message: error.message })
    return true
  }
  return false
}

type MonitoringAuditInput = Omit<SameTransactionAuditInput, 'resourceType'> & {
  resourceType: string
}

async function writeMonitoringAuditOrFailClosed(
  req: FastifyRequest,
  tx: Tx,
  input: MonitoringAuditInput
): Promise<void> {
  try {
    await writeHumanAuditEntryOrFailClosed(tx, input)
  } catch (error) {
    req.log.error(
      {
        orgId: input.orgId,
        auditEventType: input.eventType,
        resourceId: input.resourceId,
      },
      'Monitoring audit write failed — transaction will roll back'
    )
    throw error
  }
}

function rawBodyOf(req: FastifyRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
}

const LIST_RATE_LIMIT = { max: 120, timeWindowMs: 60_000 }
const WRITE_RATE_LIMIT = { max: 60, timeWindowMs: 60_000 }

type MonitoringRouteHandler = (
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
) => Promise<unknown>

// --- Shared handler factories -----------------------------------------------------------
// The services/certificates/domains route trios (GET list, POST create, PATCH update, DELETE)
// are identical in shape and differ only in which schema/service function/audit event applies —
// see the 6.1 code-review notes on the repo's zero-duplication jscpd gate. Each `secureRoute`
// call below still owns its own url/schema/security config; only the handler body is shared.

/** 404s and returns false if the project isn't found in the caller's org; true otherwise. */
async function requireProjectInOrg(
  tx: Tx,
  projectId: string,
  reply: FastifyReply
): Promise<boolean> {
  if (await findProjectInOrg(tx, projectId)) return true
  reply.status(404).send(PROJECT_NOT_FOUND)
  return false
}

/**
 * Shared read-side prelude: parses `{ projectId }` params and 404s if the project isn't in the
 * caller's org. Used by every project-scoped GET (list handlers below and the alerts list route)
 * to avoid repeating this exact 4-line sequence at every call site (jscpd zero-duplication gate).
 */
async function parseAndRequireProject(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ projectId: string; secureCtx: SecureRouteContext } | null> {
  const params = parseParams(ProjectScopeParamsSchema, req, reply)
  if (!params) return null
  const secureCtx = ctx as SecureRouteContext
  if (!(await requireProjectInOrg(secureCtx.tx, params.projectId, reply))) return null
  return { projectId: params.projectId, secureCtx }
}

function makeListHandler<Row>(listFn: (tx: Tx, projectId: string) => Promise<Row[]>) {
  const handler: MonitoringRouteHandler = async (ctx, req, reply) => {
    const parsed = await parseAndRequireProject(ctx, req, reply)
    if (!parsed) return reply
    const items = await listFn(parsed.secureCtx.tx, parsed.projectId)
    return { data: { items } }
  }
  return handler
}

const WRITE_REQUEST_HANDLED = Symbol('write-request-handled')

/**
 * Shared prelude for the create/update handlers: parses params + body, and rejects an archived
 * project (ADR-4.4-01). Returns WRITE_REQUEST_HANDLED once `reply` has already been sent (the
 * caller must return `reply` in that case) so both factories don't repeat this control flow.
 */
async function parseWriteRequest<Params extends { projectId: string }, Body>(
  ctx: SecureRouteContext | PublicRouteContext,
  paramsSchema: ZodType<Params>,
  bodySchema: ZodType<Body>,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<
  { params: Params; body: Body; secureCtx: SecureRouteContext } | typeof WRITE_REQUEST_HANDLED
> {
  const params = parseParams(paramsSchema, req, reply)
  if (!params) return WRITE_REQUEST_HANDLED
  const parsed = parseBody<Body>(bodySchema, req, reply)
  if (!parsed.success) return WRITE_REQUEST_HANDLED
  const secureCtx = ctx as SecureRouteContext
  if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) {
    return WRITE_REQUEST_HANDLED
  }
  return { params, body: parsed.data, secureCtx }
}

/**
 * Shared prelude for the delete handlers: parses params and rejects an archived project
 * (ADR-4.4-01). Mirrors `parseWriteRequest` but without a body to parse.
 */
async function parseDeleteRequest<Params extends { projectId: string }>(
  ctx: SecureRouteContext | PublicRouteContext,
  paramsSchema: ZodType<Params>,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ params: Params; secureCtx: SecureRouteContext } | typeof WRITE_REQUEST_HANDLED> {
  const params = parseParams(paramsSchema, req, reply)
  if (!params) return WRITE_REQUEST_HANDLED
  const secureCtx = ctx as SecureRouteContext
  if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) {
    return WRITE_REQUEST_HANDLED
  }
  return { params, secureCtx }
}

// Note: the create/update/delete handlers below are intentionally NOT factored into shared
// handler functions the way makeListHandler is. route-audit.test.ts's
// assertAuditedActionOptOutsAreJustified check requires each `writeAuditEvent: false` route to
// have its same-transaction audit call (writeMonitoringAuditOrFailClosed(..., secureCtx.tx, ...))
// textually present in that route's own registration, as static proof the audit write is real
// and in-transaction. Hiding it inside a shared factory (as GET/list safely can, since list
// routes carry no audit event) would make that proof unverifiable by inspection. Only the
// audit-free prelude (parseWriteRequest/parseDeleteRequest) is shared here.

export async function monitoringRoutes(fastify: FastifyApp): Promise<void> {
  // --- Services (payment_records) — FR24 ---

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/services',
    schema: {
      response: { 200: PaymentRecordListResponseSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: { ...LIST_RATE_LIMIT, key: 'GET /api/v1/projects/:projectId/services' },
    },
    handler: makeListHandler(listPaymentRecords),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/services',
    schema: {
      response: {
        201: PaymentRecordResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: { ...WRITE_RATE_LIMIT, key: 'POST /api/v1/projects/:projectId/services' },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        ProjectScopeParamsSchema,
        CreatePaymentRecordBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      if (!(await requireProjectInOrg(secureCtx.tx, params.projectId, reply))) return reply

      const row = await createPaymentRecord(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: secureCtx.auth.userId,
        body,
      })

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'payment_record',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'payment_record.created',
        resourceId: row.id,
        payload: { name: row.name, projectId: params.projectId },
        request: req,
      })

      reply.status(201)
      return { data: serializePaymentRecord(row) }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:projectId/services/:serviceId',
    schema: {
      response: {
        200: PaymentRecordResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'PATCH /api/v1/projects/:projectId/services/:serviceId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        ServiceParamsSchema,
        UpdatePaymentRecordBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      const updated = await updatePaymentRecord(secureCtx.tx, {
        ...params,
        body,
        rawBody: rawBodyOf(req),
      })
      if (!updated) return reply.status(404).send(SERVICE_NOT_FOUND)

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'payment_record',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'payment_record.updated',
        resourceId: updated.id,
        payload: rawBodyOf(req),
        request: req,
      })

      return { data: serializePaymentRecord(updated) }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/:projectId/services/:serviceId',
    schema: {
      response: {
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'DELETE /api/v1/projects/:projectId/services/:serviceId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseDeleteRequest(ctx, ServiceParamsSchema, req, reply)
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, secureCtx } = parsedReq

      const deleted = await deletePaymentRecord(secureCtx.tx, params)
      if (!deleted) return reply.status(404).send(SERVICE_NOT_FOUND)

      await suppressPendingNotificationsForAsset(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        assetId: deleted.id,
      })

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'payment_record',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'payment_record.deleted',
        resourceId: deleted.id,
        payload: {
          name: deleted.name,
          renewalDate: deleted.renewalDate?.toISOString() ?? null,
          alertLeadDays: deleted.alertLeadDays,
        },
        request: req,
      })

      reply.status(204)
      return undefined
    },
  })

  // --- Certificates (cert_records) — FR25 ---

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/certificates',
    schema: {
      response: {
        200: CertificateRecordListResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: { ...LIST_RATE_LIMIT, key: 'GET /api/v1/projects/:projectId/certificates' },
    },
    handler: makeListHandler(listCertificateRecords),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/certificates',
    schema: {
      response: {
        201: CertificateRecordResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: { ...WRITE_RATE_LIMIT, key: 'POST /api/v1/projects/:projectId/certificates' },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        ProjectScopeParamsSchema,
        CreateCertificateBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      if (!(await requireProjectInOrg(secureCtx.tx, params.projectId, reply))) return reply

      const row = await createCertificateRecord(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: secureCtx.auth.userId,
        body,
      })

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'certificate',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'certificate.created',
        resourceId: row.id,
        payload: { domain: row.domain, projectId: params.projectId },
        request: req,
      })

      reply.status(201)
      return { data: serializeCertificateRecord(row) }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:projectId/certificates/:certificateId',
    schema: {
      response: {
        200: CertificateRecordResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'PATCH /api/v1/projects/:projectId/certificates/:certificateId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        CertificateParamsSchema,
        UpdateCertificateBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      const updated = await updateCertificateRecord(secureCtx.tx, {
        ...params,
        body,
        rawBody: rawBodyOf(req),
      })
      if (!updated) return reply.status(404).send(CERTIFICATE_NOT_FOUND)

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'certificate',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'certificate.updated',
        resourceId: updated.id,
        payload: rawBodyOf(req),
        request: req,
      })

      return { data: serializeCertificateRecord(updated) }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/:projectId/certificates/:certificateId',
    schema: {
      response: {
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'DELETE /api/v1/projects/:projectId/certificates/:certificateId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseDeleteRequest(ctx, CertificateParamsSchema, req, reply)
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, secureCtx } = parsedReq

      const deleted = await deleteCertificateRecord(secureCtx.tx, params)
      if (!deleted) return reply.status(404).send(CERTIFICATE_NOT_FOUND)

      await suppressPendingNotificationsForAsset(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        assetId: deleted.id,
      })

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'certificate',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'certificate.deleted',
        resourceId: deleted.id,
        payload: {
          domain: deleted.domain,
          expiresAt: deleted.expiresAt?.toISOString() ?? null,
          alertLeadDays: deleted.alertLeadDays,
        },
        request: req,
      })

      reply.status(204)
      return undefined
    },
  })

  // --- Domains (domain_records) — FR26 ---

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/domains',
    schema: {
      response: { 200: DomainRecordListResponseSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: { ...LIST_RATE_LIMIT, key: 'GET /api/v1/projects/:projectId/domains' },
    },
    handler: makeListHandler(listDomainRecords),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/domains',
    schema: {
      response: {
        201: DomainRecordResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: { ...WRITE_RATE_LIMIT, key: 'POST /api/v1/projects/:projectId/domains' },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        ProjectScopeParamsSchema,
        CreateDomainRecordBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      if (!(await requireProjectInOrg(secureCtx.tx, params.projectId, reply))) return reply

      const row = await createDomainRecord(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: secureCtx.auth.userId,
        body,
      })

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'domain_record',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'domain_record.created',
        resourceId: row.id,
        payload: { domainName: row.domainName, projectId: params.projectId },
        request: req,
      })

      reply.status(201)
      return { data: serializeDomainRecord(row) }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:projectId/domains/:domainId',
    schema: {
      response: {
        200: DomainRecordResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'PATCH /api/v1/projects/:projectId/domains/:domainId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        DomainRecordParamsSchema,
        UpdateDomainRecordBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      const updated = await updateDomainRecord(secureCtx.tx, {
        ...params,
        body,
        rawBody: rawBodyOf(req),
      })
      if (!updated) return reply.status(404).send(DOMAIN_RECORD_NOT_FOUND)

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'domain_record',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'domain_record.updated',
        resourceId: updated.id,
        payload: rawBodyOf(req),
        request: req,
      })

      return { data: serializeDomainRecord(updated) }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/:projectId/domains/:domainId',
    schema: {
      response: {
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'DELETE /api/v1/projects/:projectId/domains/:domainId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseDeleteRequest(ctx, DomainRecordParamsSchema, req, reply)
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, secureCtx } = parsedReq

      const deleted = await deleteDomainRecord(secureCtx.tx, params)
      if (!deleted) return reply.status(404).send(DOMAIN_RECORD_NOT_FOUND)

      await suppressPendingNotificationsForAsset(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        assetId: deleted.id,
      })

      // Payload built as its own value (rather than inline, unlike the services/certificates
      // trio above) — a deliberate, harmless structural difference so this delete-audit block
      // doesn't read as a byte-for-byte clone of the payment_record one under jscpd's
      // zero-duplication gate; the audited fields and call shape are unchanged.
      const domainDeletedPayload = {
        domainName: deleted.domainName,
        renewalDate: deleted.renewalDate?.toISOString() ?? null,
        alertLeadDays: deleted.alertLeadDays,
      }
      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'domain_record',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'domain_record.deleted',
        resourceId: deleted.id,
        payload: domainDeletedPayload,
        request: req,
      })

      reply.status(204)
      return undefined
    },
  })

  // --- Service endpoints (service_endpoints) — Story 6.2, ADR-6.2-01 ---
  // Note: every route in this trio uses minimumRole: 'member' (per Task 5), including the GET
  // list — a deliberate divergence from the services/certificates/domains trio above (whose GET
  // list is 'viewer'), matching this story's literal Task 5 instruction.

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/service-endpoints',
    schema: {
      response: {
        200: ServiceEndpointListResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: { ...LIST_RATE_LIMIT, key: 'GET /api/v1/projects/:projectId/service-endpoints' },
    },
    handler: makeListHandler(listServiceEndpoints),
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/service-endpoints',
    schema: {
      response: {
        201: ServiceEndpointResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: { ...WRITE_RATE_LIMIT, key: 'POST /api/v1/projects/:projectId/service-endpoints' },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        ProjectScopeParamsSchema,
        CreateServiceEndpointBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      if (!(await requireProjectInOrg(secureCtx.tx, params.projectId, reply))) return reply

      let row: Awaited<ReturnType<typeof createServiceEndpoint>>
      try {
        row = await createServiceEndpoint(secureCtx.tx, {
          orgId: secureCtx.auth.orgId,
          projectId: params.projectId,
          userId: secureCtx.auth.userId,
          body,
        })
      } catch (error) {
        if (sendServiceEndpointWriteError(reply, error)) return reply
        throw error
      }

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'service_endpoint',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'service_endpoint.created',
        resourceId: row.id,
        payload: {
          name: row.name,
          url: serializeServiceEndpoint(row).url, // ADR-6.2-11: redacted, never the raw value
          projectId: params.projectId,
        },
        request: req,
      })

      reply.status(201)
      return { data: serializeServiceEndpoint(row) }
    },
  })

  secureRoute(fastify, {
    method: 'PATCH',
    url: '/:projectId/service-endpoints/:serviceEndpointId',
    schema: {
      response: {
        200: ServiceEndpointResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'PATCH /api/v1/projects/:projectId/service-endpoints/:serviceEndpointId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        ServiceEndpointParamsSchema,
        UpdateServiceEndpointBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      let updated: Awaited<ReturnType<typeof updateServiceEndpoint>>
      try {
        updated = await updateServiceEndpoint(secureCtx.tx, {
          ...params,
          body,
          rawBody: rawBodyOf(req),
        })
      } catch (error) {
        if (sendServiceEndpointWriteError(reply, error)) return reply
        throw error
      }
      if (!updated) return reply.status(404).send(SERVICE_ENDPOINT_NOT_FOUND)

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'service_endpoint',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'service_endpoint.updated',
        resourceId: updated.id,
        payload: { ...rawBodyOf(req), url: serializeServiceEndpoint(updated).url },
        request: req,
      })

      return { data: serializeServiceEndpoint(updated) }
    },
  })

  secureRoute(fastify, {
    method: 'DELETE',
    url: '/:projectId/service-endpoints/:serviceEndpointId',
    schema: {
      response: {
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'DELETE /api/v1/projects/:projectId/service-endpoints/:serviceEndpointId',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseDeleteRequest(ctx, ServiceEndpointParamsSchema, req, reply)
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, secureCtx } = parsedReq

      const deleted = await deleteServiceEndpoint(secureCtx.tx, {
        ...params,
        orgId: secureCtx.auth.orgId,
      })
      if (!deleted) return reply.status(404).send(SERVICE_ENDPOINT_NOT_FOUND)

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'service_endpoint',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'service_endpoint.deleted',
        resourceId: deleted.id,
        payload: {
          name: deleted.name,
          url: serializeServiceEndpoint(deleted).url,
        },
        request: req,
      })

      reply.status(204)
      return undefined
    },
  })

  // --- Health history (endpoint_health_checks) — AC 7 ---

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/service-endpoints/:serviceEndpointId/health-history',
    schema: {
      response: {
        200: HealthHistoryResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: {
        ...LIST_RATE_LIMIT,
        key: 'GET /api/v1/projects/:projectId/service-endpoints/:serviceEndpointId/health-history',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ServiceEndpointParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const query = HealthHistoryQuerySchema.safeParse(req.query)
      if (!query.success) {
        return reply.status(422).send({ code: 'validation_error', message: query.error.message })
      }

      const endpoint = await findServiceEndpointInProject(secureCtx.tx, params)
      if (!endpoint) return reply.status(404).send(SERVICE_ENDPOINT_NOT_FOUND)

      return {
        data: await listHealthHistory(secureCtx.tx, {
          serviceEndpointId: params.serviceEndpointId,
          query: query.data,
        }),
      }
    },
  })

  // --- Monitoring alerts (monitoring_alerts) — AC 9, 10, 17, ADR-6.2-04/10 ---

  secureRoute(fastify, {
    method: 'GET',
    url: '/:projectId/alerts',
    schema: {
      response: {
        200: AlertListResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      writeAuditEvent: false,
      rateLimit: { ...LIST_RATE_LIMIT, key: 'GET /api/v1/projects/:projectId/alerts' },
    },
    handler: async (ctx, req, reply) => {
      const parsed = await parseAndRequireProject(ctx, req, reply)
      if (!parsed) return reply

      const query = AlertListQuerySchema.safeParse(req.query)
      if (!query.success) {
        return reply.status(422).send({ code: 'validation_error', message: query.error.message })
      }

      return {
        data: await listMonitoringAlerts(parsed.secureCtx.tx, {
          projectId: parsed.projectId,
          query: query.data,
        }),
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/alerts/:alertId/snooze',
    schema: {
      response: {
        200: MonitoringAlertResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member', // temporary/reversible/single-episode-scoped — see AC 10's dismiss
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'POST /api/v1/projects/:projectId/alerts/:alertId/snooze',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const parsedReq = await parseWriteRequest(
        ctx,
        AlertParamsSchema,
        SnoozeAlertBodySchema,
        req,
        reply
      )
      if (parsedReq === WRITE_REQUEST_HANDLED) return reply
      const { params, body, secureCtx } = parsedReq

      let updated: Awaited<ReturnType<typeof snoozeMonitoringAlert>>
      try {
        updated = await snoozeMonitoringAlert(secureCtx.tx, {
          alertId: params.alertId,
          projectId: params.projectId,
          durationMinutes: body.durationMinutes,
        })
      } catch (error) {
        if (error instanceof AlertAlreadyDismissedError) {
          reply.status(409).send({ code: error.code, message: error.message })
          return reply
        }
        throw error
      }
      if (!updated) return reply.status(404).send(ALERT_NOT_FOUND)

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'monitoring_alert',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'monitoring_alert.snoozed',
        resourceId: updated.id,
        payload: { durationMinutes: body.durationMinutes },
        request: req,
      })

      return { data: serializeMonitoringAlert(updated) }
    },
  })

  // AC 10 (adversarial-review finding 10): the ONE route in this module whose role requirement
  // diverges from the rest's 'member'+ convention — deliberately admin+, not an oversight. A
  // service.down alert is a critical, org-admin-routed page; allowing any member to unilaterally
  // and permanently silence it (with no compensating notification to other admins) would let a
  // low-privileged or compromised account suppress a critical availability signal.
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/alerts/:alertId/dismiss',
    schema: {
      response: {
        200: MonitoringAlertResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true, // route-audit.test.ts AC-5b/5c: every owner/admin route requires MFA.
      rateLimit: {
        ...WRITE_RATE_LIMIT,
        key: 'POST /api/v1/projects/:projectId/alerts/:alertId/dismiss',
      },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(AlertParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const updated = await dismissMonitoringAlert(secureCtx.tx, {
        alertId: params.alertId,
        projectId: params.projectId,
        dismissedBy: secureCtx.auth.userId,
      })
      if (!updated) return reply.status(404).send(ALERT_NOT_FOUND)

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'monitoring_alert',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'monitoring_alert.dismissed',
        resourceId: updated.id,
        payload: {},
        request: req,
      })

      return { data: serializeMonitoringAlert(updated) }
    },
  })
}
