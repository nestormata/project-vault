import {
  CreateOrgSsoDomainRequestSchema,
  OrgSsoDomainDeletedResponseSchema,
  OrgSsoDomainListResponseSchema,
  OrgSsoDomainParamsSchema,
  OrgSsoDomainResponseSchema,
  UpdateOrgSsoDomainRequestSchema,
} from '@project-vault/shared'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import {
  createOrgSsoDomain,
  deleteOrgSsoDomain,
  listOrgSsoDomains,
  updateOrgSsoDomain,
  type OrgSsoDomainRow,
} from './org-sso-domains-service.js'

const DOMAIN_NOT_FOUND = {
  code: 'domain_not_found',
  message: 'SSO domain mapping not found',
} as const

function serializeRow(row: OrgSsoDomainRow) {
  return {
    id: row.id,
    domain: row.domain,
    providerName: row.providerName,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Story 14.6 Task 3: thin secureRoute registrations delegating to org-sso-domains-service.ts's
 * CRUD functions — mirrors organization-settings-routes.ts's and org/routes.ts's shape exactly
 * (route-audit.test.ts's thin-routes static scan, AC-12).
 */
export async function orgSsoDomainsRoutes(fastify: FastifyApp): Promise<void> {
  // AC-1: list, org-scoped via secureCtx.tx's RLS-scoped transaction — never getAdminDb().
  // AC-6/AC-9: the list route is deliberately MFA-gated too (unlike /settings/extensions'
  // read-only status page) — even seeing the org's SSO domain configuration is sensitive enough
  // to warrant the same gate as the mutations, keeping all four routes' auth requirements uniform.
  secureRoute(fastify, {
    method: 'GET',
    url: '/sso-domains',
    schema: {
      response: {
        200: OrgSsoDomainListResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      writeAuditEvent: false, // AC-7: the list route writes no audit event (read of one's own org).
      rateLimit: { max: 60, timeWindowMs: 60_000, key: 'GET /api/v1/org/sso-domains' },
    },
    handler: async (ctx) => {
      const secureCtx = ctx as SecureRouteContext
      const rows = await listOrgSsoDomains(secureCtx.tx, secureCtx.auth.orgId)
      return rows.map(serializeRow)
    },
  })

  // AC-2: create — validated, provider-checked, public-domain-blocked, globally-unique.
  secureRoute(fastify, {
    method: 'POST',
    url: '/sso-domains',
    schema: {
      body: CreateOrgSsoDomainRequestSchema,
      response: {
        201: OrgSsoDomainResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      writeAuditEvent: false, // Audit row written inline below, in the same secureCtx.tx.
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'POST /api/v1/org/sso-domains' },
    },
    handler: async (ctx, req, reply) => {
      const parsed = parseBody(CreateOrgSsoDomainRequestSchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await createOrgSsoDomain(secureCtx.tx, secureCtx.auth.orgId, parsed.data)
      if (!result.ok) {
        return reply.status(result.status).send({
          code: result.code,
          message: ssoErrorMessage(result.code),
        })
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'org_sso_domain',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'org_sso_domain.created',
        resourceId: result.row.id,
        payload: {
          id: result.row.id,
          domain: result.row.domain,
          providerName: result.row.providerName,
        },
        request: req,
      })

      return reply.status(201).send(serializeRow(result.row))
    },
  })

  // AC-3: edit — same validation rules as create, applied to an existing row.
  secureRoute(fastify, {
    method: 'PATCH',
    url: '/sso-domains/:id',
    schema: {
      params: OrgSsoDomainParamsSchema,
      body: UpdateOrgSsoDomainRequestSchema,
      response: {
        200: OrgSsoDomainResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'PATCH /api/v1/org/sso-domains/:id' },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(OrgSsoDomainParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody(UpdateOrgSsoDomainRequestSchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext

      const result = await updateOrgSsoDomain(
        secureCtx.tx,
        secureCtx.auth.orgId,
        params.id,
        parsed.data
      )
      if (!result.ok) {
        if (result.status === 404) return reply.status(404).send(DOMAIN_NOT_FOUND)
        return reply.status(result.status).send({
          code: result.code,
          message: ssoErrorMessage(result.code),
        })
      }

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'org_sso_domain',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'org_sso_domain.updated',
        resourceId: result.row.id,
        payload: {
          id: result.row.id,
          domain: result.row.domain,
          providerName: result.row.providerName,
        },
        request: req,
      })

      return reply.status(200).send(serializeRow(result.row))
    },
  })

  // AC-4: remove — hard delete, matches this table's existing no-soft-delete convention.
  secureRoute(fastify, {
    method: 'DELETE',
    url: '/sso-domains/:id',
    schema: {
      params: OrgSsoDomainParamsSchema,
      response: {
        200: OrgSsoDomainDeletedResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'admin',
      requireMfa: true,
      writeAuditEvent: false,
      rateLimit: { max: 20, timeWindowMs: 60_000, key: 'DELETE /api/v1/org/sso-domains/:id' },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(OrgSsoDomainParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext

      const row = await deleteOrgSsoDomain(secureCtx.tx, secureCtx.auth.orgId, params.id)
      if (!row) return reply.status(404).send(DOMAIN_NOT_FOUND)

      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'org_sso_domain',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'org_sso_domain.deleted',
        resourceId: row.id,
        payload: { id: row.id, domain: row.domain, providerName: row.providerName },
        request: req,
      })

      return reply.status(200).send({ id: row.id })
    },
  })
}

function ssoErrorMessage(code: string): string {
  switch (code) {
    case 'invalid_domain_format':
      return 'Domain is not a valid hostname'
    case 'public_domain_blocked':
      return "This domain is on our list of shared public email providers and can't be mapped"
    case 'provider_not_registered':
      return 'This provider is not currently registered'
    case 'provider_check_unavailable':
      return 'Unable to verify the provider right now, try again shortly'
    case 'domain_already_mapped':
      return 'This domain is already mapped to an organization'
    default:
      return 'Request failed'
  }
}
