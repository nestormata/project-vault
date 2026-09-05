import { and, eq } from 'drizzle-orm'
import { notificationQueue } from '@project-vault/db/schema'
import { getAdminDb } from '../../lib/db.js'
import { getDeliveryProviderForChannel } from '../../lib/delivery-provider.js'
import { applyDeliveryStatusUpdate } from '../../notifications/delivery-status.js'

export type DeliveryWebhookHeaders = Record<string, string | string[] | undefined>

export type HandleDeliveryWebhookInput = {
  /** The `:providerId` route param — doubles as the channel key a `DeliveryProvider` was
   * registered under (see `apps/api/src/lib/delivery-provider.ts`). */
  providerId: string
  rawBody: string
  headers: DeliveryWebhookHeaders
}

export type HandleDeliveryWebhookResult =
  { outcome: 'accepted' } | { outcome: 'rejected'; status: 404 }

/**
 * Story 20.11 AC3 — org-unknown-until-the-provider-message-id-resolves lookup, mirroring
 * `credential-shares/external-service.ts`'s `adminLookupByTokenHash` precedent exactly: exactly
 * ONE admin-connection (RLS-bypassing) point-lookup, used only to discover which org a webhook
 * event belongs to. Every subsequent read/write happens inside `applyDeliveryStatusUpdate()`'s own
 * `withOrg(row.orgId, ...)` scope.
 */
async function adminLookupByProviderMessageId(
  providerId: string,
  providerMessageId: string
): Promise<{ id: string; orgId: string } | null> {
  const [row] = await getAdminDb()
    .select({ id: notificationQueue.id, orgId: notificationQueue.orgId })
    .from(notificationQueue)
    .where(
      and(
        eq(notificationQueue.providerId, providerId),
        eq(notificationQueue.providerMessageId, providerMessageId)
      )
    )
    .limit(1)
  return row ?? null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Story 20.11 AC3 edge case — a provider's webhook call can genuinely race the send-time
 * transaction that persists `providerMessageId` (the provider accepts the send and fires its
 * webhook before PV's own commit lands). Without a retry, that race permanently loses the event:
 * an unresolved lookup is folded into the non-enumerating 202 no-op (AC3/AC6), and the provider
 * has no reason to redeliver a webhook it believes already succeeded. A few short, bounded
 * retries close all but the most pathological races (typical send-then-webhook gaps are single-
 * digit milliseconds) while adding at most ~90ms to the rare case that's still genuinely unknown
 * (an actually-unknown identifier pays this same small cost — AC6 requires it not be
 * distinguishable from a found-but-slow-to-commit one). */
async function adminLookupByProviderMessageIdWithRetry(
  providerId: string,
  providerMessageId: string,
  { attempts = 4, delayMs = 30 }: { attempts?: number; delayMs?: number } = {}
): Promise<{ id: string; orgId: string } | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const row = await adminLookupByProviderMessageId(providerId, providerMessageId)
    if (row) return row
    if (attempt < attempts) await sleep(delayMs)
  }
  return null
}

/**
 * Story 20.11 AC3/AC6 — `POST /api/v1/notifications/delivery-webhook/:providerId`'s real logic
 * (the route handler itself stays thin, per this codebase's route-audit convention).
 *
 * - Unknown `providerId` (no `DeliveryProvider` currently registered under it) or an invalid
 *   signature: a single generic rejection (`{ outcome: 'rejected', status: 404 }`) — AC6 requires
 *   every rejection reason to be indistinguishable from the HTTP response alone, so this
 *   deliberately does NOT return a different status/body for "unknown provider" vs "bad
 *   signature".
 * - A validly-signed event whose `providerMessageId` does not resolve to any row is a
 *   non-enumerating no-op (folded into the overall `'accepted'` outcome, AC3 edge case) — it must
 *   never leak whether the identifier ever existed by responding differently.
 * - Replay/freshness-window enforcement is delegated to the provider's own
 *   `verifyWebhookSignature()` — this generic, provider-agnostic contract (AC8) has no
 *   vendor-specific knowledge of any one provider's signing/freshness scheme to enforce itself.
 */
export async function handleDeliveryWebhook(
  input: HandleDeliveryWebhookInput
): Promise<HandleDeliveryWebhookResult> {
  const provider = getDeliveryProviderForChannel(input.providerId)
  if (!provider) return { outcome: 'rejected', status: 404 }

  // AC6: every rejection reason must be indistinguishable from the HTTP response alone. A
  // third-party extension's `verifyWebhookSignature()`/`parseWebhookEvents()` throwing on a
  // malformed/adversarial body (or a downstream fail-closed audit write) must not be allowed to
  // propagate to the route handler uncaught — an uncaught exception would surface as a generic
  // framework 500, a response shape distinguishable from this route's deliberate 404 rejection
  // shape, undermining the very guarantee this route exists to provide.
  let verified: boolean
  try {
    verified = provider.verifyWebhookSignature({
      rawBody: input.rawBody,
      headers: input.headers,
    })
  } catch {
    return { outcome: 'rejected', status: 404 }
  }
  if (!verified) return { outcome: 'rejected', status: 404 }

  let events: ReturnType<typeof provider.parseWebhookEvents>
  try {
    events = provider.parseWebhookEvents(input.rawBody)
  } catch {
    return { outcome: 'rejected', status: 404 }
  }

  for (const event of events) {
    // Each event is applied independently: one bad/unresolvable event in a multi-event payload
    // must not silently drop every later event in the same delivery — the provider only knows
    // whether ITS request as a whole was accepted (202) or rejected (404/401), never per-event
    // outcomes, so a per-event failure is swallowed here and the loop continues to the next event
    // rather than aborting the whole batch.
    try {
      const row = await adminLookupByProviderMessageIdWithRetry(
        input.providerId,
        event.providerMessageId
      )
      if (!row) continue // AC3 edge: non-enumerating no-op, folded into the overall 202 accepted.

      await applyDeliveryStatusUpdate({
        notificationQueueId: row.id,
        orgId: row.orgId,
        newStatus: event.status,
        providerId: input.providerId,
      })
    } catch {
      continue
    }
  }

  return { outcome: 'accepted' }
}
