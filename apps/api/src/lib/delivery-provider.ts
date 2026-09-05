import type { FastifyBaseLogger } from 'fastify'
import { withOrg } from '@project-vault/db'
import { AuditEvent } from '@project-vault/shared'
import type { DeliveryProvider } from '@project-vault/extension-api'
import type { ExtensionState } from '../extensions/loader.js'
import { writeSystemAuditRow } from './system-audit-row.js'
import { operationalLog } from './logger.js'
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
 * Story 20.11 AC1 — the delivery-provider registry, mirroring `capability-gate.ts`'s
 * `registeredGate`/`registeredGateName` shape: set at boot from the single loaded extension's
 * `hooks.deliveryProvider` map (channel name -> provider), read-only after boot except for the
 * test-only reset below.
 */
const registeredProviders = new Map<string, DeliveryProvider>()
let registeredExtensionName: string | null = null

export function getDeliveryProviderForChannel(channel: string): DeliveryProvider | undefined {
  return registeredProviders.get(channel)
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

  for (const [channel, provider] of Object.entries(providers)) {
    if (registeredProviders.has(channel)) {
      throw new DeliveryProviderConflictError(channel)
    }
    registeredProviders.set(channel, provider)
  }
  registeredExtensionName = state.manifest.name
}

/** Un-registers the given channels, restoring the pre-registration state. Used only by
 * `auditDeliveryProviderRegistrationOrFailClosed()` to roll back a registration whose required
 * audit trail could not be established (AC5 fail-closed). */
function unregisterDeliveryProviderChannels(channels: string[]): void {
  for (const channel of channels) registeredProviders.delete(channel)
  if (registeredProviders.size === 0) registeredExtensionName = null
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetDeliveryProvidersForTests(): void {
  registeredProviders.clear()
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

  for (const orgId of orgIds) {
    for (const channel of channels) {
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
    }
  }
}
