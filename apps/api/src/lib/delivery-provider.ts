import type { FastifyBaseLogger } from 'fastify'
import { withOrg } from '@project-vault/db'
import { AuditEvent } from '@project-vault/shared'
import type { DeliveryProvider } from '@project-vault/extension-api'
import type { ExtensionState } from '../extensions/loader.js'
import { writeSystemAuditRow } from './system-audit-row.js'
import { operationalLog } from './logger.js'
import { forEachSequential } from './for-each-sequential.js'
import { fetchAllOrgIds } from '../middleware/rls.js'

/**
 * Story 20.11 AC1 (Failure case) — a registration for a channel that already has a registered
 * provider is a loud, named conflict, never a silent last-registered-wins overwrite.
 */
export class DeliveryProviderConflictError extends Error {
  constructor(public readonly channel: string) {
    super(`A DeliveryProvider is already registered for channel "${channel}"`)
    this.name = 'DeliveryProviderConflictError'
  }
}

/**
 * Story 70.3 AC5 — thrown by `wireExtensionDeliveryProvider()` when a provider's
 * `webhookRateLimit` is outside the bounds PV enforces. Loud on purpose: a bad declaration is never
 * silently clamped, and the registry is left exactly as it was before the call.
 */
export class DeliveryProviderWebhookRateLimitError extends Error {
  constructor(
    public readonly channel: string,
    detail: string
  ) {
    super(
      `DeliveryProvider for channel "${channel}" declares an invalid webhookRateLimit: ${detail}`
    )
    this.name = 'DeliveryProviderWebhookRateLimitError'
  }
}

export type DeliveryWebhookRateLimit = { max: number; timeWindowMs: number }

/** Story 70.3 AC5 — the limit every provider without a declaration gets (unchanged since 20.11). */
export const DEFAULT_DELIVERY_WEBHOOK_RATE_LIMIT: DeliveryWebhookRateLimit = {
  max: 60,
  timeWindowMs: 60_000,
}

const WEBHOOK_RATE_LIMIT_MAX_BOUND = 10_000
const WEBHOOK_RATE_LIMIT_WINDOW_SECONDS_BOUND = 3600

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** Validates a declared `webhookRateLimit` and resolves it to ms; `undefined` = use the default. */
function resolveWebhookRateLimit(
  channel: string,
  declared: DeliveryProvider['webhookRateLimit']
): DeliveryWebhookRateLimit | undefined {
  if (declared === undefined) return undefined
  if (typeof declared !== 'object' || declared === null) {
    throw new DeliveryProviderWebhookRateLimitError(channel, 'must be an object')
  }
  if (!isIntegerInRange(declared.max, 1, WEBHOOK_RATE_LIMIT_MAX_BOUND)) {
    throw new DeliveryProviderWebhookRateLimitError(
      channel,
      `max must be an integer from 1 to ${WEBHOOK_RATE_LIMIT_MAX_BOUND}`
    )
  }
  const windowSeconds =
    declared.windowSeconds ?? DEFAULT_DELIVERY_WEBHOOK_RATE_LIMIT.timeWindowMs / 1000
  if (!isIntegerInRange(windowSeconds, 1, WEBHOOK_RATE_LIMIT_WINDOW_SECONDS_BOUND)) {
    throw new DeliveryProviderWebhookRateLimitError(
      channel,
      `windowSeconds must be an integer from 1 to ${WEBHOOK_RATE_LIMIT_WINDOW_SECONDS_BOUND}`
    )
  }
  return { max: declared.max, timeWindowMs: windowSeconds * 1000 }
}

/**
 * Story 20.11 AC1 — the delivery-provider registry, mirroring `capability-gate.ts`'s
 * `registeredGate`/`registeredGateName` shape: set at boot from the single loaded extension's
 * `hooks.deliveryProvider` map (channel name -> provider), read-only after boot except for the
 * test-only reset below.
 */
const registeredProviders = new Map<string, DeliveryProvider>()
const registeredWebhookLimits = new Map<string, DeliveryWebhookRateLimit>()
let registeredExtensionName: string | null = null

export function getDeliveryProviderForChannel(channel: string): DeliveryProvider | undefined {
  return registeredProviders.get(channel)
}

/**
 * Story 70.3 AC5 — the inbound-webhook rate limit for a channel's provider: its declared
 * `webhookRateLimit`, else the default. An unregistered channel also gets the default.
 */
export function getDeliveryWebhookRateLimit(channel: string): DeliveryWebhookRateLimit {
  return registeredWebhookLimits.get(channel) ?? DEFAULT_DELIVERY_WEBHOOK_RATE_LIMIT
}

export function getRegisteredDeliveryProviderChannels(): string[] {
  return [...registeredProviders.keys()]
}

export function getDeliveryProviderExtensionName(): string | null {
  return registeredExtensionName
}

/**
 * Story 20.11 AC1 — the `createApp()` wiring step, called once after `loadExtension()` resolves,
 * mirroring `wireExtensionCapabilityGate()`'s sibling-wiring convention exactly. No-ops for every
 * state except `loaded` with a `deliveryProvider` hook declared. Unlike
 * `wireExtensionCapabilityGate()`'s intentional double-wire no-op, a channel that is already
 * registered THROWS `DeliveryProviderConflictError` — AC1's failure case requires a loud,
 * named-error refusal, not a silently-ignored second registration. Every channel key already
 * registered before the throw is left untouched (registration is per-channel, not all-or-nothing
 * across the whole call).
 */
export function wireExtensionDeliveryProvider(state: ExtensionState): void {
  if (state.status !== 'loaded') return
  const providers = state.hooks.deliveryProvider
  if (!providers) return

  // Story 70.3 AC5: validate every declared limit BEFORE registering anything, so a bad
  // declaration leaves the registry exactly as it was.
  const limits = new Map<string, DeliveryWebhookRateLimit | undefined>(
    Object.entries(providers).map(([channel, provider]) => [
      channel,
      resolveWebhookRateLimit(channel, provider.webhookRateLimit),
    ])
  )

  for (const [channel, provider] of Object.entries(providers)) {
    if (registeredProviders.has(channel)) {
      throw new DeliveryProviderConflictError(channel)
    }
    registeredProviders.set(channel, provider)
    const limit = limits.get(channel)
    if (limit) registeredWebhookLimits.set(channel, limit)
  }
  registeredExtensionName = state.manifest.name
}

/** Un-registers the given channels, restoring the pre-registration state. Used only by
 * `auditDeliveryProviderRegistrationOrFailClosed()` to roll back a registration whose required
 * audit trail could not be established (AC5 fail-closed). */
function unregisterDeliveryProviderChannels(channels: string[]): void {
  for (const channel of channels) {
    registeredProviders.delete(channel)
    registeredWebhookLimits.delete(channel)
  }
  if (registeredProviders.size === 0) registeredExtensionName = null
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetDeliveryProvidersForTests(): void {
  registeredProviders.clear()
  registeredWebhookLimits.clear()
  registeredExtensionName = null
}

type ListOrgIdsFn = () => Promise<string[]>
type LoaderLogger = Pick<FastifyBaseLogger, 'warn' | 'fatal'>

/** Story 20.11 AC5 — thrown by `auditDeliveryProviderRegistrationOrFailClosed()` when the
 * required audit trail for a provider registration could not be established for every org. The
 * registration is rolled back (the channel is un-registered) before this is thrown, so the
 * registry never holds a channel PV cannot prove was audited. */
export class DeliveryProviderRegistrationAuditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryProviderRegistrationAuditError'
  }
}

/**
 * Story 20.11 AC5 — writes `notification.delivery_provider_registered` per newly-registered
 * channel, fail-closed: unlike `apps/api/src/extensions/loader.ts`'s best-effort `EXTENSION_LOADED`
 * fanout (an informational event with no compliance requirement attached), AC5 explicitly requires
 * "no code path applies ... provider registration without its audit write succeeding" — so a
 * failure to enumerate orgs, or any single org's audit write failing, rolls back the registration
 * (un-registers the channels) and throws, failing `createApp()`/boot loud rather than leaving a
 * live, unaudited provider registered. Call this AFTER `wireExtensionDeliveryProvider()` has
 * already thrown or succeeded, never in place of it.
 */
export async function auditDeliveryProviderRegistrationOrFailClosed(
  channels: string[],
  logger: LoaderLogger,
  listOrgIds: ListOrgIdsFn = fetchAllOrgIds
): Promise<void> {
  if (channels.length === 0) return
  let orgIds: string[]
  try {
    orgIds = await listOrgIds()
  } catch (error) {
    unregisterDeliveryProviderChannels(channels)
    operationalLog(
      logger,
      'fatal',
      'notification.delivery_provider_audit_fanout_failed',
      'delivery-provider registration audit fanout: failed to enumerate organizations',
      { channels }
    )
    throw new DeliveryProviderRegistrationAuditError(
      `Failed to enumerate organizations for delivery-provider registration audit: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  await forEachSequential(orgIds, (orgId) =>
    forEachSequential(channels, async (channel) => {
      try {
        await withOrg(orgId, (tx) =>
          writeSystemAuditRow(tx, {
            orgId,
            eventType: AuditEvent.NOTIFICATION_DELIVERY_PROVIDER_REGISTERED,
            payload: { channel, extensionName: registeredExtensionName },
          })
        )
      } catch (error) {
        unregisterDeliveryProviderChannels(channels)
        operationalLog(
          logger,
          'fatal',
          'notification.delivery_provider_audit_fanout_row_failed',
          'delivery-provider registration audit fanout: per-org audit write failed',
          { orgId, channel }
        )
        throw new DeliveryProviderRegistrationAuditError(
          `Failed to write delivery-provider registration audit for org ${orgId}, channel ${channel}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    })
  )
}
