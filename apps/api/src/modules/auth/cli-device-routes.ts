import type { FastifyReply, FastifyRequest } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { env } from '../../config/env.js'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { AppError } from '../../lib/errors.js'
import { ApiErrorSchema, withRouteTypeProvider } from '../../lib/api-contracts.js'
import { registerIpRateLimit } from '../../lib/ip-rate-limit.js'
import { validationError } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { operationalLog } from '../../lib/logger.js'
import { metaFromRequest, registerMethodNotAllowed, sendAppError } from './routes.js'
import { signUserAccessToken, type JwtSigner } from './tokens.js'
import {
  CLI_DEVICE_CREATE_LIMIT_PER_MINUTE,
  CLI_DEVICE_DECISION_IP_LIMIT_PER_MINUTE,
  CLI_DEVICE_DECISION_USER_LIMIT_PER_MINUTE,
  CLI_DEVICE_POLL_LIMIT_PER_MINUTE,
  formatUserCode,
  isDeviceCodeShape,
  normalizeUserCode,
} from './cli-device-codes.js'
import {
  cliDeviceCreateBodySchema,
  cliDeviceCreateResponseSchema,
  cliDeviceDecisionBodySchema,
  cliDeviceDecisionResponseSchema,
  cliDeviceTokenBodySchema,
  cliDeviceTokenResponseSchema,
} from './cli-device-schema.js'
import {
  createDeviceGrant,
  decideDeviceGrant,
  pollDeviceGrant,
  type DeviceDecision,
  type DevicePollResult,
} from './cli-device-service.js'

function invalidClientName(raw: string | undefined): boolean {
  return raw !== undefined && /\p{C}/u.test(raw)
}

function publicAppBase(): string {
  const configured = env.PUBLIC_APP_BASE_URL ?? env.WEB_BASE_URL
  return configured.replace(/\/$/, '')
}

function verificationUris(userCode: string): {
  verificationUri: string
  verificationUriComplete: string
} {
  const base = publicAppBase()
  const path = DEVICE_PAGE_PATH
  const code = formatUserCode(userCode)
  return {
    verificationUri: `${base}${path}`,
    verificationUriComplete: `${base}${path}?code=${encodeURIComponent(code)}`,
  }
}

const EXPIRED_TOKEN_MESSAGE = 'The sign-in request has expired.'
const INVALID_USER_CODE_MESSAGE = 'That code is not a sign-in waiting for approval.'
const DEVICE_PAGE_PATH = '/cli/device'

function sendPoll(reply: FastifyReply, result: DevicePollResult): unknown {
  if (result.kind === 'pending') {
    return reply.status(400).send({
      code: 'authorization_pending',
      message: 'The sign-in has not been approved yet.',
    })
  }
  if (result.kind === 'slow_down') {
    return reply.status(400).send({
      code: 'slow_down',
      message: 'Polling too often. Wait longer between attempts.',
    })
  }
  if (result.kind === 'denied') {
    return reply.status(400).send({
      code: 'access_denied',
      message: 'The sign-in was denied.',
    })
  }
  return reply.status(400).send({
    code: 'expired_token',
    message: EXPIRED_TOKEN_MESSAGE,
  })
}

function sendDecision(reply: FastifyReply, result: DeviceDecision): unknown {
  if (result.kind === 'approved') {
    return { data: { status: 'approved' as const, expiresIn: result.expiresIn } }
  }
  if (result.kind === 'denied') return { data: { status: 'denied' as const } }
  if (result.kind === 'step_up_required') {
    return reply.status(401).send({
      code: 'step_up_required',
      message: 'A current authenticator code is required to approve this sign-in.',
    })
  }
  if (result.kind === 'enrollment_required') {
    return reply.status(403).send({
      code: 'totp_enrollment_required',
      message: 'Enroll an authenticator at /settings/security before approving this sign-in.',
    })
  }
  return reply.status(400).send({
    code: 'invalid_user_code',
    message: INVALID_USER_CODE_MESSAGE,
  })
}

export async function cliDeviceRoutes(fastify: FastifyApp): Promise<void> {
  await registerIpRateLimit(fastify, {
    max: CLI_DEVICE_DECISION_IP_LIMIT_PER_MINUTE,
    message: 'Too many authentication attempts',
    logEventType: OperationalEvent.AUTH_CLI_RATE_LIMITED,
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli/device',
    bodyLimit: 4096,
    config: { rateLimit: { max: CLI_DEVICE_CREATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
    attachValidation: true,
    schema: {
      body: cliDeviceCreateBodySchema,
      response: {
        201: cliDeviceCreateResponseSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = cliDeviceCreateBodySchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      if (invalidClientName(parsed.data.clientName)) {
        return reply.status(422).send({
          code: 'validation_error',
          message: 'clientName must be plain text, at most 64 characters.',
        })
      }
      const created = await createDeviceGrant(parsed.data.clientName ?? null)
      operationalLog(
        req.log,
        'info',
        OperationalEvent.AUTH_CLI_DEVICE_CREATED,
        'CLI device sign-in created',
        {
          expiresIn: created.expiresIn,
        }
      )
      const uris = verificationUris(created.userCode)
      return reply.status(201).send({
        data: {
          deviceCode: created.deviceCode,
          userCode: formatUserCode(created.userCode),
          ...uris,
          expiresIn: created.expiresIn,
          interval: created.interval,
        },
      })
    },
  })

  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli/device/token',
    bodyLimit: 4096,
    config: { rateLimit: { max: CLI_DEVICE_POLL_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
    attachValidation: true,
    schema: {
      body: cliDeviceTokenBodySchema,
      response: {
        200: cliDeviceTokenResponseSchema,
        400: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = cliDeviceTokenBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      if (!isDeviceCodeShape(parsed.data.deviceCode)) {
        return reply.status(400).send({
          code: 'expired_token',
          message: EXPIRED_TOKEN_MESSAGE,
        })
      }
      const result = await pollDeviceGrant(parsed.data.deviceCode, metaFromRequest(req))
      if (result.kind !== 'session') return sendPoll(reply, result)
      const session = result.session
      const accessToken = await signUserAccessToken(fastify as unknown as JwtSigner, session)
      return reply.status(200).send({
        data: {
          accessToken,
          refreshToken: session.refreshOpaque,
          tokenType: 'Bearer' as const,
          expiresIn: session.accessMaxAgeSec,
          userId: session.userId,
          sessionId: session.sessionId,
          scope: 'user' as const,
          isPlatformOperator: session.isPlatformOperator,
        },
      })
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/cli/device/decision',
    schema: {
      body: cliDeviceDecisionBodySchema,
      response: {
        200: cliDeviceDecisionResponseSchema,
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      rateLimit: { max: CLI_DEVICE_DECISION_USER_LIMIT_PER_MINUTE, timeWindowMs: 60_000 },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const secureCtx = ctx as SecureRouteContext
      const parsed = cliDeviceDecisionBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))
      const normalized = normalizeUserCode(parsed.data.userCode)
      if (!normalized) {
        return reply.status(400).send({
          code: 'invalid_user_code',
          message: INVALID_USER_CODE_MESSAGE,
        })
      }
      try {
        const result = await decideDeviceGrant(
          {
            userId: secureCtx.auth.userId,
            orgId: secureCtx.auth.orgId,
            sessionId: secureCtx.auth.sessionId,
          },
          normalized,
          parsed.data.decision,
          parsed.data.totpCode,
          metaFromRequest(req),
          secureCtx.tx
        )
        return sendDecision(reply, result)
      } catch (error) {
        if (error instanceof AppError) return sendAppError(reply, error)
        throw error
      }
    },
  })

  registerMethodNotAllowed(fastify, DEVICE_PAGE_PATH)
  registerMethodNotAllowed(fastify, '/cli/device/token')
  registerMethodNotAllowed(fastify, '/cli/device/decision')
}
