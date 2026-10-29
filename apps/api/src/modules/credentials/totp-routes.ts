// Story 72.10 (P5): server-side one-time codes for credential fields of kind `totp`.
//
// The seed is write-only: this route returns the CURRENT CODE only. It sits on the reveal boundary
// (same visibility gate, same project-role floor, same sensitive-read classification) and writes the
// same `credential.value_revealed` audit event with `purpose: "totp"` (Story 72.8 decision P6: a
// payload key, not a new event type). It has its own per-user rate-limit bucket, separate from the
// 120/min reveal bucket, so code polling cannot starve reveals and a reveal flood cannot starve codes.
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { writeHumanAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { parseBody, parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import {
  CredentialParamsSchema,
  CredentialTotpBodySchema,
  CredentialTotpResponseSchema,
  type CredentialTotpBody,
} from './schema.js'
import { rejectIfInsufficientProjectRoleForReveal, rejectIfProjectNotVisible } from './routes.js'
import { generateCredentialTotp } from './service.js'

const CREDENTIAL_NOT_FOUND = {
  code: 'credential_not_found',
  message: 'Credential not found',
} as const

export const TOTP_RATE_LIMIT_KEY = 'POST /api/v1/projects/:projectId/credentials/:credentialId/totp'

export function credentialTotpRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/:projectId/credentials/:credentialId/totp',
    schema: {
      response: {
        200: CredentialTotpResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'member',
      rateLimit: { max: 60, timeWindowMs: 60_000, key: TOTP_RATE_LIMIT_KEY },
      writeAuditEvent: false,
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(CredentialParamsSchema, req, reply)
      if (!params) return reply
      const parsed = parseBody<CredentialTotpBody>(CredentialTotpBodySchema, req, reply)
      if (!parsed.success) return reply
      const secureCtx = ctx as SecureRouteContext
      if (
        await rejectIfProjectNotVisible(
          secureCtx,
          req,
          reply,
          params.projectId,
          CREDENTIAL_NOT_FOUND
        )
      )
        return reply
      if (
        await rejectIfInsufficientProjectRoleForReveal(
          secureCtx,
          req,
          reply,
          params.projectId,
          params.credentialId,
          'reveal'
        )
      )
        return reply

      const result = await generateCredentialTotp(secureCtx.tx, {
        ...params,
        field: parsed.data.field,
      })
      if (result.status === 'not_found') return reply.status(404).send(CREDENTIAL_NOT_FOUND)
      if (result.status === 'unknown_field') {
        return reply.status(422).send({
          code: 'unknown_totp_field',
          message: 'This secret has no one-time-password field with that name',
        })
      }
      if (result.status === 'seed_unavailable') {
        return reply.status(422).send({
          code: 'totp_seed_unavailable',
          message: 'This one-time-password field has no usable seed; enter the seed again',
        })
      }

      // Same fail-closed audit as the reveal route: no code leaves unless the row is written.
      await writeHumanAuditEntryOrFailClosed(secureCtx.tx, {
        resourceType: 'credential',
        orgId: secureCtx.auth.orgId,
        actorUserId: secureCtx.auth.userId,
        eventType: 'credential.value_revealed',
        resourceId: params.credentialId,
        payload: { versionNumber: result.versionNumber, purpose: 'totp' },
        revealedFields: [result.fieldKey],
        request: req,
      })
      req.log.info(
        {
          eventType: OperationalEvent.CREDENTIAL_REVEAL_SUCCESS,
          orgId: secureCtx.auth.orgId,
          credentialId: params.credentialId,
          versionNumber: result.versionNumber,
        },
        'Credential one-time code generated'
      )

      reply.header('cache-control', 'no-store')
      return {
        data: {
          field: result.fieldKey,
          code: result.code.code,
          digits: result.code.digits,
          periodSeconds: result.code.periodSeconds,
          expiresAt: result.code.expiresAt,
          secondsRemaining: result.code.secondsRemaining,
          versionNumber: result.versionNumber,
          retrievedAt: new Date().toISOString(),
        },
      }
    },
  })
  return Promise.resolve()
}
