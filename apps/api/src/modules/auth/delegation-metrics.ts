import { delegationVerifyKeys } from '../../config/env.js'
import { getOrCreateCounter } from '../../lib/prom-client-registry.js'
import { DELEGATION_OUTCOMES } from './delegation-verify.js'

/**
 * Story 71.3 AC-8: `pv_delegation_assertions_total{outcome,kid}`. The `outcome` set is closed
 * (`DELEGATION_OUTCOMES`, defined next to the verifier's reason mapping) and the `kid` label is
 * only ever a CONFIGURED key id: a failure that happens before a key matched records `none`, so
 * an unauthenticated caller cannot mint label values. Alert rules and the runbook are Story 71.9
 * (`docs/runbooks/alerts/delegation-alerts.rules.yml`, `docs/runbooks/delegation-key-rotation.md`).
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

/**
 * Story 71.9 AC-1: creates every `outcome` x (`none` + each configured kid) series at 0, so
 * Prometheus `increase()` / `rate()` see the FIRST real event: a series that first appears at 1
 * has no earlier sample to subtract, so the first-ever `replayed` or `store_unavailable` would
 * read as an increase of 0 and not alert. Bounded: outcomes x (configured kids + 1).
 */
export function preinitializeDelegationSeries(configuredKids: readonly string[]): void {
  for (const outcome of DELEGATION_OUTCOMES) {
    for (const kid of [NO_KID_LABEL, ...configuredKids]) {
      delegationAssertionsTotal.labels(outcome, kid).inc(0)
    }
  }
}

// At module load, after the key set was parsed (the config module parses it once at boot).
preinitializeDelegationSeries(delegationVerifyKeys.map((key) => key.kid))
