import type { FastifyRequest } from 'fastify'
import type { Tx } from '@project-vault/db'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
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
  DomainRecordListResponseSchema,
  DomainRecordParamsSchema,
  DomainRecordResponseSchema,
  PaymentRecordListResponseSchema,
  PaymentRecordResponseSchema,
  ProjectScopeParamsSchema,
  ServiceParamsSchema,
  UpdateCertificateBodySchema,
  UpdateDomainRecordBodySchema,
  UpdatePaymentRecordBodySchema,
  type CreateCertificateBody,
  type CreateDomainRecordBody,
  type CreatePaymentRecordBody,
  type UpdateCertificateBody,
  type UpdateDomainRecordBody,
  type UpdatePaymentRecordBody,
} from './schema.js'
import {
  createCertificateRecord,
  createDomainRecord,
  createPaymentRecord,
  deleteCertificateRecord,
  deleteDomainRecord,
  deletePaymentRecord,
  listCertificateRecords,
  listDomainRecords,
  listPaymentRecords,
  serializeCertificateRecord,
  serializeDomainRecord,
  serializePaymentRecord,
  suppressPendingNotificationsForAsset,
  updateCertificateRecord,
  updateDomainRecord,
  updatePaymentRecord,
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
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      if (!(await findProjectInOrg(secureCtx.tx, params.projectId))) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }
      const items = await listPaymentRecords(secureCtx.tx, params.projectId)
      return { data: { items } }
    },
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
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<CreatePaymentRecordBody>(CreatePaymentRecordBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply
      if (!(await findProjectInOrg(secureCtx.tx, params.projectId))) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }

      const row = await createPaymentRecord(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: secureCtx.auth.userId,
        body: parsed.data,
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
      const params = parseParams(ServiceParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<UpdatePaymentRecordBody>(UpdatePaymentRecordBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      const updated = await updatePaymentRecord(secureCtx.tx, {
        serviceId: params.serviceId,
        projectId: params.projectId,
        body: parsed.data,
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
      const params = parseParams(ServiceParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

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
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      if (!(await findProjectInOrg(secureCtx.tx, params.projectId))) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }
      const items = await listCertificateRecords(secureCtx.tx, params.projectId)
      return { data: { items } }
    },
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
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<CreateCertificateBody>(CreateCertificateBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply
      if (!(await findProjectInOrg(secureCtx.tx, params.projectId))) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }

      const row = await createCertificateRecord(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: secureCtx.auth.userId,
        body: parsed.data,
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
      const params = parseParams(CertificateParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<UpdateCertificateBody>(UpdateCertificateBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      const updated = await updateCertificateRecord(secureCtx.tx, {
        certificateId: params.certificateId,
        projectId: params.projectId,
        body: parsed.data,
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
      const params = parseParams(CertificateParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

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
    handler: async (ctx, req, reply) => {
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      if (!(await findProjectInOrg(secureCtx.tx, params.projectId))) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }
      const items = await listDomainRecords(secureCtx.tx, params.projectId)
      return { data: { items } }
    },
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
      const params = parseParams(ProjectScopeParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<CreateDomainRecordBody>(CreateDomainRecordBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply
      if (!(await findProjectInOrg(secureCtx.tx, params.projectId))) {
        return reply.status(404).send(PROJECT_NOT_FOUND)
      }

      const row = await createDomainRecord(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        projectId: params.projectId,
        userId: secureCtx.auth.userId,
        body: parsed.data,
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
      const params = parseParams(DomainRecordParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<UpdateDomainRecordBody>(UpdateDomainRecordBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      const updated = await updateDomainRecord(secureCtx.tx, {
        domainId: params.domainId,
        projectId: params.projectId,
        body: parsed.data,
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
      const params = parseParams(DomainRecordParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      if (await rejectIfProjectArchived(secureCtx.tx, params.projectId, reply)) return reply

      const deleted = await deleteDomainRecord(secureCtx.tx, params)
      if (!deleted) return reply.status(404).send(DOMAIN_RECORD_NOT_FOUND)

      await suppressPendingNotificationsForAsset(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        assetId: deleted.id,
      })

      await writeMonitoringAuditOrFailClosed(req, secureCtx.tx, {
        resourceType: 'domain_record',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'domain_record.deleted',
        resourceId: deleted.id,
        payload: {
          domainName: deleted.domainName,
          renewalDate: deleted.renewalDate?.toISOString() ?? null,
          alertLeadDays: deleted.alertLeadDays,
        },
        request: req,
      })

      reply.status(204)
      return undefined
    },
  })
}
