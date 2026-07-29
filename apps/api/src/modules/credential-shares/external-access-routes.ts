import type { FastifyReply } from 'fastify'
import { withOrg } from '@project-vault/db'
import { AuditEvent } from '@project-vault/shared'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseParams } from '../../lib/route-helpers.js'
import { secureRoute } from '../../lib/secure-route.js'
import { writeSystemAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import {
  createOrgAdminNotificationEntries,
  dispatchPendingJobs,
  type NotificationQueueJob,
} from '../../notifications/dispatcher.js'
import type { BossService } from '../../lib/boss.js'
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

function noReferrerHeaders(reply: FastifyReply): void {
  // AC-10: token-bearing pages never leak the URL (which carries the raw token) via Referer.
  reply.header('Referrer-Policy', 'no-referrer')
}

type BossFastify = FastifyApp & { boss?: BossService }

/** AC-11: writes CREDENTIAL_SHARE_VIEWED for the external path, in its own `withOrg`-scoped
 *  transaction (the reveal itself already committed — this route has no authenticated
 *  `SecureRouteContext`/`tx` to share, unlike 17.1's session-bound reveal route). No authenticated
 *  actor exists for this request, so this uses `writeSystemAuditEntryOrFailClosed` (`actorType:
 *  'system'`, `actorTokenId` always null) — the first real caller of that previously-unused
 *  helper in this codebase, and the correct fit: there is no human or machine actor identity to
 *  attribute an anonymous external recipient's reveal to. */
async function auditExternalView(
  orgId: string,
  input: { shareId: string; credentialId: string; fieldKey: string | null; viewCount: number }
): Promise<void> {
  await withOrg(orgId, (tx) =>
    writeSystemAuditEntryOrFailClosed(tx, {
      orgId,
      eventType: AuditEvent.CREDENTIAL_SHARE_VIEWED,
      resourceId: input.shareId,
      resourceType: 'credential_share',
      payload: {
        credentialId: input.credentialId,
        fieldKey: input.fieldKey,
        viewCount: input.viewCount,
        recipientType: 'external',
      },
    })
  )
}

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
      response: { 200: ExternalShareMetadataResponseSchema, 404: ApiErrorSchema },
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

      const { share, value, fieldKey } = result
      const viewedAt = share.firstViewedAt ?? new Date()

      try {
        await auditExternalView(share.orgId, {
          shareId: share.id,
          credentialId: share.credentialId,
          fieldKey: share.fieldKey,
          viewCount: share.viewCount,
        })
      } catch (error) {
        // AC-11 is a hard requirement (full audit trail) — unlike notification dispatch below,
        // an audit-write failure here must not silently succeed. There is no surrounding
        // SecureRoute transaction to roll back (the reveal itself already committed via its own
        // withOrg scope), so this re-throws to surface a 500 rather than returning 200 with an
        // unaudited reveal.
        req.log.error(
          { eventType: 'credential_share.audit_failed', shareId: share.id },
          'External credential share view audit write failed'
        )
        throw error
      }

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
          value,
          viewedAt: viewedAt.toISOString(),
        },
      }
    },
  })
}
