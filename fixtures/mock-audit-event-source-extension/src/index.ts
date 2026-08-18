import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import type {
  AuditEventSourceWriteInput,
  AuditEventSourceWriteResult,
  ExtensionHooks,
  ExtensionManifest,
  HostServices,
} from '@project-vault/extension-api'

/**
 * Story 23.8 AC-27: a self-contained, in-process mock audit-event-source extension. Exists so
 * this story's real boot path — `loadExtension()` -> `buildHostServices()` ->
 * `hooksFactory(host)` -> `host.auditEventSource.writeAuditEvent()` — can be exercised end-to-end,
 * in CI and by hand, proving the hook is not just typed but actually loadable and callable,
 * mirroring Story 23.3's `mock-capability-gate-extension` pattern.
 *
 * Unlike `CapabilityGate`, `HostServices` is the FIRST inverted hook: PV hands this extension a
 * real, callable `host` at load time — this fixture does not implement anything PV calls, it
 * calls something PV implements. `hooksFactory(host)` stashes the received `host` in module
 * state so this file's own real-boot integration test can trigger a write at a deterministic
 * point it controls (never on every boot — that would pollute every other test's DB state), the
 * same "module singleton, same-process import" technique `mock-capability-gate-extension`'s own
 * boot-integration test already uses for `PERMITTED_ORG_IDS`.
 */
export const MOCK_AUDIT_EVENT_SOURCE_PROVIDER_NAME = 'test.mock-audit-event-source-extension'

const manifest: ExtensionManifest = {
  name: MOCK_AUDIT_EVENT_SOURCE_PROVIDER_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['audit-event-source'],
}

let capturedHost: HostServices | undefined

function hooksFactory(host: HostServices): ExtensionHooks {
  capturedHost = host
  return {}
}

/**
 * Test-only trigger — calls the real, host-provided `writeAuditEvent()` this fixture received at
 * load time. Rejects if `hooksFactory()` has not yet run (the extension was not actually loaded)
 * — `async` so the failure is always a rejected promise, never a synchronous throw a caller might
 * not be try/catching.
 */
export async function triggerAuditWrite(
  input: AuditEventSourceWriteInput
): Promise<AuditEventSourceWriteResult> {
  if (!capturedHost) {
    throw new Error(
      'mock-audit-event-source-extension: triggerAuditWrite() called before hooksFactory() ran — the extension was not loaded'
    )
  }
  return capturedHost.auditEventSource.writeAuditEvent(input)
}

/** Test-only reset — lets a test suite re-arm the fixture between real-boot runs. */
export function __resetMockAuditEventSourceExtensionForTests(): void {
  capturedHost = undefined
}

export default { manifest, hooksFactory }
