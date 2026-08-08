import { withOrg } from '@project-vault/db'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseParams } from '../../lib/route-helpers.js'
import { secureRoute } from '../../lib/secure-route.js'
import {
  createOrgAdminNotificationEntries,
  dispatchPendingJobs,
  type NotificationQueueJob,
} from '../../notifications/dispatcher.js'
import type { BossService } from '../../lib/boss.js'
import { noReferrerHeaders, shareRevealFailureBody } from './reveal-response.js'
import {
  ExternalShareAccessParamsSchema,
  ExternalShareMetadataResponseSchema,
  ExternalShareRevealResponseSchema,
} from './schema.js'
import { findExternalShareByTokenHash, revealExternalShare } from './external-service.js'

// AC-17: every not-found/expired/revoked/malformed case collapses to this identical shape — no
// distinguishing "the hash matched a row that turned out to be expired" from "the hash matched
// nothing at all" via response shape or status code.
const SHARE_NOT_FOUND = { code: 'share_not_found', message: 'Share not found' } as const

type BossFastify = FastifyApp & { boss?: BossService }

/** AC-12: admin notification on first successful view (never again — AC-5 hard-codes singleUse). */
async function notifyAdminsOfView(
  orgId: string,
  payload: { shareId: string; credentialId: string }
): Promise<NotificationQueueJob[]> {
  return withOrg(orgId, (tx) =>
    createOrgAdminNotificationEntries({
      orgId,
      template: { templateId: 'credential.external_share_viewed', payload, severity: 'warning' },
      tx,
    })
  )
}

/**
 * Story 17.2 AC-7/AC-8: the recipient-facing, UNAUTHENTICATED access routes — `requireAuth:
 * false` (the same flag `publicStatusPageRoutes` uses). Kept in its own file/prefix (not
 * credential-shares/routes.ts, not access-routes.ts) so `route-audit.test.ts`'s
 * one-file-one-prefix scanner resolves this module's own `/api/v1/external-shares` prefix
 * distinctly from the project-scoped sharer-facing routes and 17.1's authenticated access routes.
 * `requireAuth: false` means secureRoute never opens a `tx`/`SecureRouteContext` for these
 * handlers — every DB touch happens inside `external-service.ts`'s own `withOrg`-scoped
 * functions (Task 1), and every audit/notification write below opens its own short-lived
 * `withOrg` scope rather than sharing one with the read/mutation that produced its inputs.
 */
export async function externalCredentialShareAccessRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'GET',
    url: '/access/:token',
    schema: {
      response: {
        200: ExternalShareMetadataResponseSchema,
        404: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'GET /api/v1/external-shares/access/:token',
      },
    },
    handler: async (_ctx, req, reply) => {
      const params = parseParams(ExternalShareAccessParamsSchema, req, reply)
      if (!params) return reply
      noReferrerHeaders(reply)
      reply.header('Cache-Control', 'no-store')

      // AC-9/AC-22: provably inert — no status transition (beyond lazy expiry, applied inside
      // findExternalShareByTokenHash the same way it always has been), no view_count increment,
      // no attempt-counter increment. A link-unfurling crawler fetching this repeatedly is
      // expected, harmless traffic.
      const found = await findExternalShareByTokenHash(params.token)
      if (found.status === 'not_found') return reply.status(404).send(SHARE_NOT_FOUND)

      const { share, credentialName, sharedByDisplayName } = found.metadata
      return {
        data: {
          credentialId: share.credentialId,
          credentialName,
          sharedByDisplayName,
          fieldKey: share.fieldKey,
          attributeKeys: share.attributeKeys,
          action: share.action,
          expiresAt: share.expiresAt.toISOString(),
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
        200: ExternalShareRevealResponseSchema,
        404: ApiErrorSchema,
        410: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // Story 17.2 AC-22 is the primary defense against a resolved-token guessing loop; this
      // rate limit is a coarser, IP-scoped backstop (same convention as 17.1's reveal route).
      rateLimit: {
        max: 30,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/external-shares/access/:token/reveal',
      },
    },
    handler: async (_ctx, req, reply) => {
      const params = parseParams(ExternalShareAccessParamsSchema, req, reply)
      if (!params) return reply
      noReferrerHeaders(reply)
      reply.header('Cache-Control', 'no-store')

      const result = await revealExternalShare(params.token)

      if (result.status === 'not_found') return reply.status(404).send(SHARE_NOT_FOUND)
      if (
        result.status === 'revoked' ||
        result.status === 'expired' ||
        result.status === 'already_viewed'
      ) {
        return reply.status(410).send(shareRevealFailureBody(result.status))
      }

      // AC-11: the CREDENTIAL_SHARE_VIEWED audit write already happened inside
      // `revealExternalShare`'s own transaction, atomically with the claim — see external-service.ts.
      // If it had failed, `revealExternalShare` itself would have thrown (rolling back the claim
      // too) and this line would never be reached, so there is nothing left to audit here.
      const { share, value, valueFormat, fieldKey } = result
      const viewedAt = share.firstViewedAt ?? new Date()

      // AC-12/AC-18: best-effort — a notification-dispatch failure never blocks the reveal the
      // recipient already received.
      try {
        const jobs = await notifyAdminsOfView(share.orgId, {
          shareId: share.id,
          credentialId: share.credentialId,
        })
        await dispatchPendingJobs(
          (fastify as BossFastify).boss,
          req,
          jobs,
          'external credential share'
        )
      } catch (error) {
        req.log.warn(
          { eventType: 'credential_share.notification_failed', shareId: share.id, err: error },
          'External credential share view-notification dispatch failed — reveal still succeeded'
        )
      }

      return {
        data: {
          credentialId: share.credentialId,
          fieldKey,
          attributeKeys: share.attributeKeys,
          action: share.action,
          value,
          valueFormat,
          viewedAt: viewedAt.toISOString(),
        },
      }
    },
  })
}
