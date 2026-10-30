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
import type { FastifyReply, FastifyRequest } from 'fastify'
import { noReferrerHeaders, shareRevealFailureBody } from './reveal-response.js'
import {
  ExternalShareAccessParamsSchema,
  ExternalShareMetadataResponseSchema,
  ExternalShareRevealBodySchema,
  ExternalShareRevealResponseSchema,
  ExternalShareVerificationConfirmBodySchema,
  ExternalShareVerificationConfirmResponseSchema,
  ExternalShareVerificationRequestResponseSchema,
} from './schema.js'
import {
  findExternalShareWithMissFloor,
  revealExternalShareWithMissFloor,
  type ExternalShareMetadata,
} from './external-service.js'
import {
  confirmExternalShareVerificationWithFloor,
  requestExternalShareVerificationWithFloor,
} from './external-verification-service.js'
import { maskRecipientEmail } from './verification.js'

// AC-17: every not-found/expired/revoked/malformed case collapses to this identical shape — no
// distinguishing "the hash matched a row that turned out to be expired" from "the hash matched
// nothing at all" via response shape or status code.
const SHARE_NOT_FOUND = { code: 'share_not_found', message: 'Share not found' } as const

// Story 72-11 V7: every non-success of the confirm route is this one body (wrong, expired, no code
// requested, unknown token, dead share, locked, over the attempt cap, malformed body).
const VERIFICATION_FAILED = {
  code: 'verification_failed',
  message: 'The code could not be verified. Request a new code and try again.',
} as const

type BossFastify = FastifyApp & { boss?: BossService }

/** The token-bearing guest routes never leak the URL via Referer and are never cached. */
function guestResponseHeaders(reply: FastifyReply): void {
  noReferrerHeaders(reply)
  reply.header('Cache-Control', 'no-store')
}

/** Reads one optional string field from a body that may be absent or malformed. A body that does
 *  not parse is treated as one without the field, so it answers like a missing value. */
function optionalBodyField<T>(
  req: FastifyRequest,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }
): T | undefined {
  const parsed = schema.safeParse(req.body ?? {})
  return parsed.success ? parsed.data : undefined
}

/** Story 72-11 AC7: the metadata answer. A gated share shows only what the guest needs before the
 *  code step; a link-only share keeps its pre-72-11 shape. */
function externalShareMetadataBody(metadata: ExternalShareMetadata) {
  const { share, credentialName, sharedByDisplayName } = metadata
  const common = {
    credentialName,
    sharedByDisplayName,
    expiresAt: share.expiresAt.toISOString(),
    status: share.status as 'active' | 'viewed' | 'revoked' | 'expired' | 'superseded',
  }
  if (share.verificationRequired) {
    return {
      ...common,
      verificationRequired: true,
      maskedRecipient: maskRecipientEmail(share.recipientEmail ?? ''),
    }
  }
  return {
    ...common,
    credentialId: share.credentialId,
    fieldKey: share.fieldKey,
    attributeKeys: share.attributeKeys,
    action: share.action,
    verificationRequired: false,
  }
}

/** AC-12: admin notification on first successful view (never again — AC-5 hard-codes singleUse). */
function notifyAdminsOfView(
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
export function externalCredentialShareAccessRoutes(fastify: FastifyApp): Promise<void> {
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
      guestResponseHeaders(reply)

      // AC-9/AC-22: provably inert — no status transition (beyond lazy expiry, applied inside
      // findExternalShareByTokenHash the same way it always has been), no view_count increment,
      // no attempt-counter increment. A link-unfurling crawler fetching this repeatedly is
      // expected, harmless traffic.
      const found = await findExternalShareWithMissFloor(params.token)
      if (found.status === 'not_found') return reply.status(404).send(SHARE_NOT_FOUND)

      return { data: externalShareMetadataBody(found.metadata) }
    },
  })

  // Story 72-11 V5: request a verification code. Always the same 200 body; the work (code, hash,
  // queued email) happens after the response for a live, unthrottled gated share only.
  secureRoute(fastify, {
    method: 'POST',
    url: '/access/:token/verification',
    schema: {
      response: {
        200: ExternalShareVerificationRequestResponseSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // A class-independent, IP-scoped backstop (not held to the floor, like 65-4's route limits);
      // the per-share send cap and cooldown are the real mail-bomb bound.
      rateLimit: {
        max: 10,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/external-shares/access/:token/verification',
      },
    },
    handler: async (_ctx, req, reply) => {
      const params = parseParams(ExternalShareAccessParamsSchema, req, reply)
      if (!params) return reply
      guestResponseHeaders(reply)
      const boss = (fastify as BossFastify).boss
      const result = await requestExternalShareVerificationWithFloor(params.token, {
        logger: req.log,
        dispatch: (jobs) => dispatchPendingJobs(boss, req, jobs, 'external share verification'),
      })
      return { data: result }
    },
  })

  // Story 72-11 V4/V7/V8: confirm a verification code for a one-time proof.
  secureRoute(fastify, {
    method: 'POST',
    url: '/access/:token/verification/confirm',
    schema: {
      response: {
        200: ExternalShareVerificationConfirmResponseSchema,
        422: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // The per-share budget (5 failures, reserved before every compare) is the real defense;
      // this IP-scoped limit is a class-independent backstop.
      rateLimit: {
        max: 20,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/external-shares/access/:token/verification/confirm',
      },
    },
    handler: async (_ctx, req, reply) => {
      const params = parseParams(ExternalShareAccessParamsSchema, req, reply)
      if (!params) return reply
      guestResponseHeaders(reply)
      const code = optionalBodyField(req, ExternalShareVerificationConfirmBodySchema)?.code ?? ''
      const result = await confirmExternalShareVerificationWithFloor(params.token, code)
      if (result.status !== 'ok') return reply.status(422).send(VERIFICATION_FAILED)
      return { data: { proof: result.proof } }
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
      guestResponseHeaders(reply)

      // Story 72-11 V8: a gated share requires the proof of a successful verification confirm; a
      // missing, malformed or wrong proof answers the plain 404 below (same as an unknown token).
      const proof = optionalBodyField(req, ExternalShareRevealBodySchema)?.proof
      const result = await revealExternalShareWithMissFloor(params.token, req.log, { proof })

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
  return Promise.resolve()
}
