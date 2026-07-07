// Platform-operator-scoped (instance-wide). Do NOT confuse with apps/api/src/modules/admin/
// (org-scoped org-admin routes under the same /admin/ URL prefix — see Story 9.2 D2).
import type { FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { operationalLog } from '../../lib/logger.js'
import { AppError } from '../../lib/errors.js'
import {
  secureRoute,
  type PublicRouteContext,
  type SecureRouteContext,
} from '../../lib/secure-route.js'
import { createOrg, listOrgs } from './service.js'
import { CreateOrgRequestSchema, CreateOrgResponseSchema, OrgListResponseSchema } from './schema.js'
import { PLATFORM_ADMIN_ERROR_RESPONSES, beginSecureMutation } from './route-common.js'

/**
 * Extracted to a named function (rather than inlined in the secureRoute() call, jscpd dedup —
 * same precedent as credentials/routes.ts's handleCredentialTagUpdate) so this handler's body
 * doesn't sit adjacent to the (necessarily literal, see settings-routes.ts's PUT handler and
 * platform-admin-route-audit.test.ts) `security: {...}` block in a way that reads as one long
 * clone of that same block in settings-routes.ts.
 */
async function handleCreateOrg(
  ctx: SecureRouteContext | PublicRouteContext,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const begun = beginSecureMutation(ctx, req, reply, CreateOrgRequestSchema)
  if (!begun) return reply
  const { secureCtx, data } = begun

  try {
    const result = await createOrg(data, secureCtx.auth.orgId)
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
}

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
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
        409: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireOrgScope: false,
      requirePlatformOperator: true,
      requireMfa: true,
      writeAuditEvent: false,
    },
    handler: handleCreateOrg,
  })

  secureRoute(fastify, {
    method: 'GET',
    url: '/orgs',
    schema: {
      tags: ['Platform Admin'],
      response: {
        200: OrgListResponseSchema,
        ...PLATFORM_ADMIN_ERROR_RESPONSES,
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
