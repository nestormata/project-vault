import type { FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { ApiErrorSchema, withRouteTypeProvider } from '../../lib/api-contracts.js'
import { registerIpRateLimit } from '../../lib/ip-rate-limit.js'
import { enforceUserRateLimit, validationError } from '../../lib/route-helpers.js'
import { extractBearerToken } from '../machine-users/bearer-token.js'
import { metaFromRequest, registerMethodNotAllowed, sendAppError } from './routes.js'
import {
  CLI_ORG_CREDENTIAL_TTL_SECONDS,
  CLI_ORG_EXCHANGE_LIMIT_PER_MINUTE,
} from './cli-device-codes.js'
import {
  cliOrgCredentialResponseSchema,
  cliOrgExchangeBodySchema,
  cliUserSessionRevokeResponseSchema,
} from './cli-device-schema.js'
import { exchangeOrgCredential } from './cli-device-service.js'
import { parseUserAccessClaims, revokeUserSessionById, verifyUserSession } from './user-session.js'

const USER_SESSION_REQUIRED = 'A user session is required.'
const ORG_EXCHANGE_LIMIT_KEY = 'POST /api/v1/auth/cli/org'

type AccessSigner = {
  jwt: {
    sign: (
      payload: Record<string, unknown>,
      options: { jti: string; expiresIn: number }
    ) => Promise<string> | string
    verify: (token: string) => unknown
  }
}

function userSessionRequired(): AppError {
  return new AppError('user_session_required', USER_SESSION_REQUIRED, 401)
}

async function requireUserSession(fastify: AccessSigner, request: FastifyRequest) {
  const token = extractBearerToken(request)
  if (!token) throw userSessionRequired()
  let verified: unknown
  try {
    verified = await fastify.jwt.verify(token)
  } catch {
    throw new AppError('access_token_invalid', 'Access token is invalid', 401)
  }
  const claims = parseUserAccessClaims(verified)
  if (!claims) throw userSessionRequired()
  return verifyUserSession(claims)
}

export async function cliUserSessionRoutes(fastify: FastifyApp): Promise<void> {
  const signer = fastify as unknown as AccessSigner
  await registerIpRateLimit(fastify, {
    max: CLI_ORG_EXCHANGE_LIMIT_PER_MINUTE,
    message: 'Too many authentication attempts',
    logEventType: OperationalEvent.AUTH_CLI_RATE_LIMITED,
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli/org',
    bodyLimit: 4096,
    config: { rateLimit: { max: CLI_ORG_EXCHANGE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
    attachValidation: true,
    schema: {
      body: cliOrgExchangeBodySchema,
      response: {
        200: cliOrgCredentialResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
        503: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = cliOrgExchangeBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      try {
        const user = await requireUserSession(signer, req)
        if (
          !enforceUserRateLimit({
            reply,
            userId: user.userId,
            key: ORG_EXCHANGE_LIMIT_KEY,
            max: CLI_ORG_EXCHANGE_LIMIT_PER_MINUTE,
          })
        ) {
          return
        }
        const issued = await exchangeOrgCredential(
          user,
          parsed.data.organizationId,
          metaFromRequest(req)
        )
        const accessToken = await signer.jwt.sign(
          {
            sub: issued.tokens.accessClaims.sub,
            orgId: issued.tokens.accessClaims.orgId,
            sessionVersion: issued.tokens.accessClaims.sessionVersion,
          },
          { jti: issued.tokens.accessClaims.jti, expiresIn: issued.tokens.accessMaxAgeSec }
        )
        return reply.status(200).send({
          data: {
            accessToken,
            tokenType: 'Bearer' as const,
            expiresIn: CLI_ORG_CREDENTIAL_TTL_SECONDS,
            userId: issued.userId,
            orgId: issued.orgId,
            orgRole: issued.orgRole,
            sessionId: issued.sessionId,
            scope: 'org' as const,
            isPlatformOperator: user.isPlatformOperator,
          },
        })
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli/session/revoke',
    bodyLimit: 1024,
    schema: {
      response: {
        200: cliUserSessionRevokeResponseSchema,
        401: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const user = await requireUserSession(signer, req)
        const revoked = await revokeUserSessionById(user.sessionId, user.userId)
        return reply.send({ data: { revoked } })
      } catch (error) {
        if (error instanceof AppError) {
          return reply.status(error.statusCode).send({ code: error.code, message: error.message })
        }
        throw error
      }
    },
  })

  registerMethodNotAllowed(fastify, '/cli/org')
  registerMethodNotAllowed(fastify, '/cli/session/revoke')
}
