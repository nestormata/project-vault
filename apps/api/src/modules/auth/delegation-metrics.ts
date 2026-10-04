import { getOrCreateCounter } from '../../lib/prom-client-registry.js'
import { DELEGATION_OUTCOMES } from './delegation-verify.js'

/**
 * Story 71.3 AC-8: `pv_delegation_assertions_total{outcome,kid}`. The `outcome` set is closed
 * (`DELEGATION_OUTCOMES`, defined next to the verifier's reason mapping) and the `kid` label is
 * only ever a CONFIGURED key id: a failure that happens before a key matched records `none`, so
 * an unauthenticated caller cannot mint label values. 71-9 owns alert rules and the runbook.
 */
export const DELEGATION_ASSERTIONS_METRIC_NAME = 'pv_delegation_assertions_total'
export const NO_KID_LABEL = 'none'

export const delegationAssertionsTotal = getOrCreateCounter({
  name: DELEGATION_ASSERTIONS_METRIC_NAME,
  help: 'Service-delegated actor assertions by outcome (admitted and rejected)',
  labelNames: ['outcome', 'kid'],
})

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set(DELEGATION_OUTCOMES)

/** Never throws; an outcome outside the closed set is dropped rather than minting a new label. */
export function recordDelegationOutcome(outcome: string, kid?: string): void {
  if (!KNOWN_OUTCOMES.has(outcome)) return
  delegationAssertionsTotal.labels(outcome, kid ?? NO_KID_LABEL).inc()
}
