// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/
// (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).
import { z } from 'zod/v4'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseBody } from '../../lib/route-helpers.js'
import { operationalLog } from '../../lib/logger.js'
import { AppError } from '../../lib/errors.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { createOrg, listOrgs } from './service.js'
import { CreateOrgRequestSchema, CreateOrgResponseSchema, OrgListResponseSchema } from './schema.js'

const VaultSealedResponseSchema = z.object({ status: z.string(), message: z.string() })

/**
 * Story 9.2 D2/D6/D7/AC-8 through AC-11: `POST`/`GET /admin/orgs` — platform-operator-driven
 * multi-organization provisioning. `requireOrgScope: false` + `requirePlatformOperator: true` +
 * `requireMfa: true` — never `allowedRoles`/`requireOrgRole`.
 */
export async function orgsRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/orgs',
    schema: {
      tags: ['Platform Admin'],
      body: CreateOrgRequestSchema,
      response: {
        201: CreateOrgResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
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
    },
    handler: async (ctx, req: FastifyRequest, reply: FastifyReply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = parseBody(CreateOrgRequestSchema, req, reply)
      if (!parsed.success) return reply

      try {
        const result = await createOrg(parsed.data, secureCtx.auth.orgId)
        operationalLog(
          req.log,
          'info',
          OperationalEvent.PLATFORM_ORG_CREATED,
          'platform-operator created organization',
          {
            operatorUserId: secureCtx.auth.userId,
            newOrgId: result.id,
            ownerAccountAction: result.ownerAccountAction,
          }
        )
        return reply.status(201).send(result)
      } catch (error) {
        if (error instanceof AppError) {
          return reply.status(error.statusCode).send({ code: error.code, message: error.message })
        }
        throw error
      }
    },
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/orgs',
    schema: {
      tags: ['Platform Admin'],
      response: {
        200: OrgListResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        503: z.union([ApiErrorSchema, VaultSealedResponseSchema]),
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: async () => listOrgs(),
  })
}
