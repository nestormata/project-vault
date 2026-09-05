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

/** Test-only reset of module-level state — never called from production code. */
export function __resetDeliveryProvidersForTests(): void {
  registeredProviders.clear()
  registeredExtensionName = null
}

type ListOrgIdsFn = () => Promise<string[]>
type LoaderLogger = Pick<FastifyBaseLogger, 'warn' | 'fatal'>

/**
 * Story 20.11 AC5 — writes `notification.delivery_provider_registered` per newly-registered
 * channel. Boot-time process-wide registration has no natural single org — same problem
 * `apps/api/src/extensions/loader.ts`'s `EXTENSION_LOADED` audit event faces — so this fans out to
 * every existing org (system actor), isolating each org's write failure (log-and-continue) so
 * neither a single bad org nor a wholesale enumeration failure can affect boot. Best-effort by
 * construction (mirrors `EXTENSION_LOADED`'s own fanout precisely) — call this AFTER
 * `wireExtensionDeliveryProvider()` has already thrown or succeeded, never in place of it.
 */
export async function auditDeliveryProviderRegistration(
  channels: string[],
  logger: LoaderLogger,
  listOrgIds: ListOrgIdsFn = fetchAllOrgIds
): Promise<void> {
  if (channels.length === 0) return
  let orgIds: string[]
  try {
    orgIds = await listOrgIds()
  } catch {
    operationalLog(
      logger,
      'fatal',
      'notification.delivery_provider_audit_fanout_failed',
      'delivery-provider registration audit fanout: failed to enumerate organizations',
      { channels }
    )
    return
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
      } catch {
        operationalLog(
          logger,
          'fatal',
          'notification.delivery_provider_audit_fanout_row_failed',
          'delivery-provider registration audit fanout: per-org audit write failed',
          { orgId, channel }
        )
      }
    }
  }
}
