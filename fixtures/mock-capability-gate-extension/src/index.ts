import type {
  CapabilityDecision,
  CapabilityGate,
  CapabilityGateContext,
  ExtensionHooks,
  ExtensionManifest,
} from '@project-vault/extension-api'

/**
 * Story 23.3 AC-27/28/29: a self-contained, in-process mock capability-gate extension. Exists so
 * this story's real boot path — `loadExtension()` -> `wireExtensionCapabilityGate()` -> the two
 * annotated routes (`POST /api/v1/projects/:projectId/status-page`,
 * `GET /api/v1/status-pages/:token`) — can be exercised end-to-end, in CI and by hand, without a
 * real third-party entitlement/billing system. It gates exactly one capability
 * (`monitoring.public-status-page`), drives its decision from a small, deterministic, in-memory
 * lookup table keyed by `orgId` — **no network call, no real entitlement data, no timers** — and
 * does NOT implement an auth strategy, proving a manifest may declare `capability-gate` alone.
 *
 * See this package's README for the manual-QA runbook, the production-safety warning, and the
 * AC-13 recovery runbook (including its "wider outage" caveat).
 */
export const MOCK_CAPABILITY_GATE_PROVIDER_NAME = 'test.mock-capability-gate-extension'

export const GATED_CAPABILITY = 'monitoring.public-status-page'

/** Orgs entitled to `monitoring.public-status-page`. Every other org id is denied. */
export const PERMITTED_ORG_IDS = new Set(['fixture-org-permitted', 'fixture-org-upgraded'])

/**
 * E2E-only escape hatch (Story 23.3 J20's "simulated upgrade" step): a real, DB-generated org id
 * to additionally treat as permitted, read once at module load from an env var. Real orgs get a
 * server-generated UUID that this fixture's own deterministic literal-id table cannot predict, so
 * a Playwright journey that registers a real org and then wants to prove "an entitlement upgrade
 * takes effect on the very next check, no PV-side cache" (AC-16) needs a way to tell THIS process
 * which real org id just got upgraded. Restarting the process (the E2E journey's own step,
 * mirroring Story 23.2 J19's restart-to-apply-policy precedent) picks up a freshly-set value here
 * — this is not a runtime/HTTP toggle and does not weaken AC-16's "PV caches nothing" claim, since
 * it only ever widens what this ONE fixture process treats as permitted, read once at import time.
 */
const extraPermittedOrgId = process.env['MOCK_CAPABILITY_GATE_EXTRA_PERMITTED_ORG_ID']
if (extraPermittedOrgId) PERMITTED_ORG_IDS.add(extraPermittedOrgId)

/** Reserved org ids that deterministically exercise AC-11/AC-12's failure paths. */
export const THROW_TRIGGER_ORG_ID = 'fixture-org-throw'
export const HANG_TRIGGER_ORG_ID = 'fixture-org-hang'
export const GARBAGE_TRIGGER_ORG_ID = 'fixture-org-garbage'

const manifest: ExtensionManifest = {
  name: MOCK_CAPABILITY_GATE_PROVIDER_NAME,
  apiVersion: '1.3.0',
  capabilities: ['capability-gate'],
}

const capabilityGate: CapabilityGate = {
  async onCheckCapability(context: CapabilityGateContext): Promise<CapabilityDecision> {
    if (context.orgId === THROW_TRIGGER_ORG_ID) {
      throw new Error('mock-capability-gate-extension: deterministic throw trigger')
    }
    if (context.orgId === HANG_TRIGGER_ORG_ID) {
      // Never resolves — exercises the host's timeout (AC-11).
      return new Promise<CapabilityDecision>(() => undefined)
    }
    if (context.orgId === GARBAGE_TRIGGER_ORG_ID) {
      // Deliberately malformed — exercises the host's zod boundary validation (AC-12).
      return { permitted: 'yes' } as unknown as CapabilityDecision
    }
    if (context.orgId !== null && PERMITTED_ORG_IDS.has(context.orgId)) {
      return { permitted: true }
    }
    return {
      permitted: false,
      reasonCode: 'fixture_not_entitled',
      message: 'This fixture org is not entitled to publish a public status page.',
    }
  },
}

function hooksFactory(): ExtensionHooks {
  return { capabilityGate }
}

export default { manifest, hooksFactory }
