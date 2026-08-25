import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { env } from '../../config/env.js'
import { validationError } from '../../lib/route-helpers.js'
import { timingSafeHeaderTokenMatches } from '../../lib/timing-safe-header-token.js'
import { provisionServiceOrganization, ServiceProvisioningForbiddenError } from './service.js'
import { ProvisionServiceOrganizationRequestSchema } from './schema.js'

/**
 * Story 26.1 AC-2/AC-7/AC-8: a static, timing-safe-compared shared secret, never a human session,
 * never secureRoute()'s org-authenticated path — same convention as
 * apps/api/src/modules/vault/key-service.ts's assertBootstrapAuthorized(), which shares this
 * check's constant-time comparison via lib/timing-safe-header-token.js. Fail-closed when
 * SERVICE_PROVISIONING_TOKEN is unset (route is unreachable for every request, same 403 as an
 * invalid token — never distinguishable from "missing vs wrong").
 */
function assertServiceProvisioningAuthorized(
  headers: Record<string, string | string[] | undefined>
): void {
  const token = env.SERVICE_PROVISIONING_TOKEN
  if (!token) throw new ServiceProvisioningForbiddenError()

  if (!timingSafeHeaderTokenMatches(headers, 'x-service-provisioning-token', token)) {
    throw new ServiceProvisioningForbiddenError()
  }
}

export async function serviceProvisioningRoutes(fastify: FastifyApp): Promise<void> {
  fastify.route({
    method: 'POST',
    url: '/api/v1/service/organizations',
    // Story 26.1 AC-2: never rate-limited via the human-facing auth rate limiter — this route has
    // its own auth mechanism entirely (static token), not subject to per-IP registration limits.
    config: { rateLimit: false },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        assertServiceProvisioningAuthorized(
          req.headers as Record<string, string | string[] | undefined>
        )
      } catch (err) {
        if (err instanceof AppError) {
          return reply.status(err.statusCode).send({ code: err.code, message: err.message })
        }
        throw err
      }

      const parsed = ProvisionServiceOrganizationRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(422).send(validationError(parsed.error, 'body'))
      }

      const result = await provisionServiceOrganization(parsed.data)
      return reply.status(201).send({
        data: {
          organizationId: result.organizationId,
          userId: result.userId,
          externalIdentityId: result.externalIdentityId,
        },
      })
    },
  })
}
