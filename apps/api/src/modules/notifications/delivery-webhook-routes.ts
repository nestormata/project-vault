import { z } from 'zod/v4'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { parseParams } from '../../lib/route-helpers.js'
import { secureRoute } from '../../lib/secure-route.js'
import { handleDeliveryWebhook } from './delivery-webhook-service.js'

const DeliveryWebhookParamsSchema = z.object({
  providerId: z.string().min(1).max(128),
})

// AC6: every rejection reason (unknown providerId, invalid signature, replay, unknown message id
// resolved to a genuine no-op instead) collapses to this identical shape — no distinguishing
// "this providerId isn't registered" from "the signature was wrong" via response shape or status.
const DELIVERY_WEBHOOK_REJECTED = {
  code: 'delivery_webhook_rejected',
  message: 'Request rejected',
} as const

const DeliveryWebhookAcceptedResponseSchema = z.object({
  data: z.object({ accepted: z.literal(true) }),
})

/**
 * Story 20.11 AC3/AC6: the recipient-facing, UNAUTHENTICATED inbound delivery-status webhook
 * route — `requireAuth: false`, same convention as `external-access-routes.ts`'s
 * `externalCredentialShareAccessRoutes`. Kept in its own file/prefix so `route-audit.test.ts`'s
 * one-file-one-prefix scanner resolves this module's own route distinctly, and so this plugin's
 * own raw-body content-type parser (needed for exact-bytes signature verification) is
 * encapsulation-scoped to only this route, never affecting any other route's JSON body parsing.
 * All real logic lives in `delivery-webhook-service.ts`'s `handleDeliveryWebhook()` — this handler
 * stays thin (parse params, forward, shape the response).
 */
export async function deliveryWebhookRoutes(fastify: FastifyApp): Promise<void> {
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req: unknown, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => {
      done(null, body)
    }
  )
  // A provider that omits Content-Type (or sends something else) still needs its raw bytes.
  fastify.addContentTypeParser(
    '*',
    { parseAs: 'string' },
    (_req: unknown, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => {
      done(null, body)
    }
  )

  secureRoute(fastify, {
    method: 'POST',
    url: '/delivery-webhook/:providerId',
    schema: {
      response: {
        202: DeliveryWebhookAcceptedResponseSchema,
        401: ApiErrorSchema,
        404: ApiErrorSchema,
        429: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // Story 20.11 AC6: the same IP-scoped rate-limit backstop precedent as
      // external-access-routes.ts's anonymous share-reveal route — a coarser defense-in-depth
      // layer behind this route's own primary defense (per-provider signature verification).
      rateLimit: {
        max: 60,
        timeWindowMs: 60_000,
        key: 'POST /api/v1/notifications/delivery-webhook/:providerId',
      },
    },
    handler: async (_ctx, req, reply) => {
      const params = parseParams(DeliveryWebhookParamsSchema, req, reply)
      if (!params) return reply

      const rawBody = typeof req.body === 'string' ? req.body : ''
      const result = await handleDeliveryWebhook({
        providerId: params.providerId,
        rawBody,
        headers: req.headers,
      })

      if (result.outcome === 'rejected') {
        return reply.status(result.status).send(DELIVERY_WEBHOOK_REJECTED)
      }

      return reply.status(202).send({ data: { accepted: true } })
    },
  })
}
