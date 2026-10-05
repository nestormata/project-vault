import type { FastifyReply, FastifyRequest } from 'fastify'
import { getDeliveryProviderForChannel, getDeliveryWebhookRateLimit } from './delivery-provider.js'
import { enforceUserRateLimit } from './route-helpers.js'

const DELIVERY_WEBHOOK_RATE_LIMIT_KEY_PREFIX = 'POST /api/v1/notifications/delivery-webhook/'
/** One shared bucket for every `:providerId` that is not a registered provider. */
const UNKNOWN_PROVIDER_BUCKET = 'unknown'

/**
 * Story 70.3 AC5 — the per-provider, per-IP rate limit of the unauthenticated delivery-status
 * webhook route. `secureRoute`'s static `rateLimit` cannot see the `:providerId` param, so the
 * route sets `rateLimit: false` and calls this first thing in its handler (the route-audit's
 * `MANUAL_IP_RATE_LIMITERS` names it).
 *
 * A registered provider is keyed by its own id and uses its declared limit (or the 60 per 60 s
 * default). A `providerId` that is not registered NEVER mints a bucket of its own: every such id
 * shares the single `unknown` bucket with the default limit, so a caller choosing path segments
 * cannot grow the bucket map or tell registered ids apart from the 429 behaviour.
 *
 * Returns `false` once a 429 reply was sent. A no-op when `isRateLimitEnforced()` is false
 * (NODE_ENV=test + RATE_LIMIT_TEST_BYPASS=true), inherited from `enforceUserRateLimit`.
 */
export function enforceDeliveryWebhookRateLimit(
  req: FastifyRequest,
  reply: FastifyReply,
  providerId: string
): boolean {
  const registered = getDeliveryProviderForChannel(providerId) !== undefined
  const limit = getDeliveryWebhookRateLimit(registered ? providerId : UNKNOWN_PROVIDER_BUCKET)
  return enforceUserRateLimit({
    userId: `ip:${req.ip}`,
    key: `${DELIVERY_WEBHOOK_RATE_LIMIT_KEY_PREFIX}${registered ? providerId : UNKNOWN_PROVIDER_BUCKET}`,
    max: limit.max,
    timeWindowMs: limit.timeWindowMs,
    reply,
  })
}
