import type { FastifyReply } from 'fastify'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseParams } from '../../lib/route-helpers.js'
import { secureRoute, type SecureRouteContext } from '../../lib/secure-route.js'
import { writeShareAuditEntry } from './audit.js'
import {
  ShareAccessParamsSchema,
  ShareMetadataResponseSchema,
  ShareRevealResponseSchema,
} from './schema.js'
import { findShareByToken, revealShare } from './service.js'

const SHARE_TOKEN_NOT_FOUND = { code: 'share_not_found', message: 'Share not found' } as const

function noReferrerHeaders(reply: FastifyReply): void {
  // AC-17: token-bearing pages never leak the URL (which carries the raw token) via Referer.
  reply.header('Referrer-Policy', 'no-referrer')
}

/**
 * AC-7/AC-8: the recipient-facing access routes, registered under their own prefix (not project-
 * scoped — the token itself, plus the caller's session identity, is the only addressing this
 * story needs). Always requires an authenticated session (AC-7's deliberate divergence from
 * 17.2's anonymous external-link threat model). Kept in its own file (not credential-shares/
 * routes.ts) because this project's route-audit scanner resolves one source file to exactly one
 * `app.ts` registration prefix — this module needs two distinct prefixes
 * (/api/v1/projects/... for the sharer-facing routes, /api/v1/shares/... for these).
 */
export async function credentialShareAccessRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/access/:token',
    schema: {
      response: {
        200: ShareMetadataResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
      },
    },
    security: { minimumRole: 'viewer', writeAuditEvent: false },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ShareAccessParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      noReferrerHeaders(reply)

      const found = await findShareByToken(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        rawToken: params.token,
        sessionUserId: secureCtx.auth.userId,
      })
      if (found.status === 'not_found') return reply.status(404).send(SHARE_TOKEN_NOT_FOUND)
      if (found.status === 'session_mismatch') {
        // AC-7: existence is not hidden from a logged-in org member the way it would be from an
        // anonymous party — deliberately a 403, not a 404 (do not "fix" to match 17.2).
        return reply.status(403).send({
          code: 'share_recipient_mismatch',
          message: 'This share was not addressed to your account.',
        })
      }
      const { share, credentialName, sharedByEmail } = found.metadata
      return {
        data: {
          credentialId: share.credentialId,
          credentialName,
          sharedBy: share.sharedBy,
          sharedByEmail,
          fieldKey: share.fieldKey,
          expiresAt: share.expiresAt.toISOString(),
          singleUse: share.singleUse,
          status: share.status,
        },
      }
    },
  })

  secureRoute(fastify, {
    method: 'POST',
    url: '/access/:token/reveal',
    schema: {
      response: {
        200: ShareRevealResponseSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
      },
    },
    security: {
      minimumRole: 'viewer',
      writeAuditEvent: false,
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/shares/access/:token/reveal',
      },
    },
    handler: async (ctx, req, reply) => {
      const params = parseParams(ShareAccessParamsSchema, req, reply)
      if (!params) return reply
      const secureCtx = ctx as SecureRouteContext
      noReferrerHeaders(reply)
      // AC-8: the reveal-step response never gets cached.
      reply.header('Cache-Control', 'no-store')

      const result = await revealShare(secureCtx.tx, {
        orgId: secureCtx.auth.orgId,
        rawToken: params.token,
        sessionUserId: secureCtx.auth.userId,
      })

      if (result.status === 'not_found') return reply.status(404).send(SHARE_TOKEN_NOT_FOUND)
      if (result.status === 'session_mismatch') {
        return reply.status(403).send({
          code: 'share_recipient_mismatch',
          message: 'This share was not addressed to your account.',
        })
      }
      if (result.status === 'recipient_ineligible') {
        return reply.status(403).send({
          code: 'recipient_inactive',
          message: 'You are no longer eligible to view this share.',
        })
      }
      if (result.status === 'revoked') {
        return reply.status(410).send({ code: 'share_revoked', message: 'This share was revoked.' })
      }
      if (result.status === 'expired') {
        return reply.status(410).send({ code: 'share_expired', message: 'This share has expired.' })
      }
      if (result.status === 'already_viewed') {
        return reply.status(410).send({
          code: 'share_already_viewed',
          message: 'This share has already been viewed.',
        })
      }

      const viewedAt = result.share.firstViewedAt ?? new Date()
      try {
        await writeShareAuditEntry(secureCtx.tx, secureCtx.auth, req, {
          eventType: AuditEvent.CREDENTIAL_SHARE_VIEWED,
          resourceId: result.share.id,
          payload: {
            credentialId: result.share.credentialId,
            fieldKey: result.share.fieldKey,
            viewCount: result.share.viewCount,
          },
        })
      } catch (error) {
        req.log.error(
          { eventType: 'credential_share.audit_failed', shareId: result.share.id },
          'Credential share view audit write failed — transaction will roll back'
        )
        throw error
      }

      return {
        data: {
          credentialId: result.share.credentialId,
          fieldKey: result.fieldKey,
          value: result.value,
          viewedAt: viewedAt.toISOString(),
        },
      }
    },
  })
}
