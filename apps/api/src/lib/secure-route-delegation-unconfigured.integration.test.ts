import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  bootstrapRouteIntegrationTest,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import {
  counterDeltas,
  createDelegationOrg,
  DELEGATION_TEST_INSTANCE_ID,
  delegationCounterSamples,
  totalsByOutcome,
  type DelegationOrgFixture,
} from '../__tests__/helpers/delegation-test-helpers.js'
import {
  bootDelegatedApp,
  callDelegated,
  closeDelegatedApps,
} from '../__tests__/helpers/delegation-app-helpers.js'

/**
 * Story 71.9 AC-1 / AC-8 — a boot with NO delegation keys behaves exactly as before: every
 * delegated call is the generic 401 and counts `not_configured` and nothing else, no database work
 * happens, and only the `none` series are pre-initialised. The key set is read once at module load,
 * so this needs its own file (the sibling suites configure keys).
 */

delete process.env['VAULT_DELEGATION_VERIFY_KEYS']
process.env['VAULT_HANDOFF_INSTANCE_ID'] = DELEGATION_TEST_INSTANCE_ID

const { initVault } = await bootstrapRouteIntegrationTest()

// Loaded only after the env above: these modules read env when they load.
const replayStore = await import('../modules/auth/delegation-replay-store.js')
const securityEvents = await import('../modules/auth/delegation-security-events.js')
const orgService = await import('../modules/service-provisioning/service.js')
const actorModule = await import('../modules/auth/delegation-actor.js')
const verify = await import('../modules/auth/delegation-verify.js')
const { resetVaultForTest } = await import('../__tests__/helpers/vault-test-cleanup.js')

const bootSamples = await delegationCounterSamples()

let org: DelegationOrgFixture
let app: FastifyInstance

beforeAll(async () => {
  await resetVaultForTest()
  await initVaultForTest(initVault, 'delegation-unconfigured-test-passphrase')
  org = await createDelegationOrg('unconfigured')
  app = (await bootDelegatedApp()).app
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await closeDelegatedApps()
})

describe('Story 71.9 AC-8 — no delegation keys configured', () => {
  it('pre-initialises only the none series, one per outcome, all at 0', () => {
    expect(bootSamples.every((sample) => sample.kid === 'none' && sample.value === 0)).toBe(true)
    expect(bootSamples.map((sample) => sample.outcome).sort()).toEqual(
      [...verify.DELEGATION_OUTCOMES].sort()
    )
  })

  it('answers the generic 401 and counts only not_configured, with no database work', async () => {
    const spies = [
      vi.spyOn(orgService, 'resolveOrgByCentralizemeId'),
      vi.spyOn(replayStore, 'burnDelegationAssertion'),
      vi.spyOn(actorModule, 'resolveDelegatedActor'),
      vi.spyOn(securityEvents, 'writeDelegationSecurityEvent'),
    ]
    const before = totalsByOutcome(await delegationCounterSamples())
    const res = await callDelegated(app, { org: org.cmOrgId })
    const after = totalsByOutcome(await delegationCounterSamples())
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'delegation_invalid' })
    expect(counterDeltas(before, after)).toEqual({ not_configured: 1 })
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    const labelled = (await delegationCounterSamples()).find(
      (sample) => sample.outcome === 'not_configured' && sample.value > 0
    )
    expect(labelled?.kid).toBe('none')
  })
})
