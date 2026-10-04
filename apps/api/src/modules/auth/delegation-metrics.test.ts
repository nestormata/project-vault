import { register } from 'prom-client'
import { describe, expect, it } from 'vitest'
import { hashedJtiPrefix } from './delegation-security-events.js'
import {
  DELEGATION_ASSERTIONS_METRIC_NAME,
  NO_KID_LABEL,
  recordDelegationOutcome,
} from './delegation-metrics.js'
import { DELEGATION_OUTCOMES } from './delegation-verify.js'

const TEST_KID = 'cm-deleg-metrics-test'

type Sample = { value: number; labels: Record<string, string> }

async function samples(): Promise<Sample[]> {
  const metric = register.getSingleMetric(DELEGATION_ASSERTIONS_METRIC_NAME)
  const snapshot = await metric?.get()
  return (snapshot?.values ?? []) as Sample[]
}

function valueOf(all: Sample[], outcome: string, kid: string): number {
  return all
    .filter((sample) => sample.labels['outcome'] === outcome && sample.labels['kid'] === kid)
    .reduce((sum, sample) => sum + sample.value, 0)
}

describe('recordDelegationOutcome (Story 71.3 AC-8)', () => {
  it('counts a known outcome under the configured kid, or under "none" before a key matched', async () => {
    const before = await samples()
    recordDelegationOutcome('replayed', TEST_KID)
    recordDelegationOutcome('signature_invalid')
    const after = await samples()
    expect(valueOf(after, 'replayed', TEST_KID)).toBe(valueOf(before, 'replayed', TEST_KID) + 1)
    expect(valueOf(after, 'signature_invalid', NO_KID_LABEL)).toBe(
      valueOf(before, 'signature_invalid', NO_KID_LABEL) + 1
    )
  })

  it('drops an outcome outside the closed set instead of minting a new label value', async () => {
    const before = await samples()
    recordDelegationOutcome('attacker-chosen-outcome', TEST_KID)
    const after = await samples()
    expect(after.some((sample) => sample.labels['outcome'] === 'attacker-chosen-outcome')).toBe(
      false
    )
    expect(after).toHaveLength(before.length)
  })

  it('covers every closed outcome without throwing', () => {
    for (const outcome of DELEGATION_OUTCOMES) {
      expect(() => recordDelegationOutcome(outcome)).not.toThrow()
    }
  })
})

describe('hashedJtiPrefix (Story 71.3 AC-8)', () => {
  it('is a stable 16-hex-character digest prefix that does not contain the jti', () => {
    const jti = 'jti-example-0001'
    const hashed = hashedJtiPrefix(jti)
    expect(hashed).toMatch(/^[0-9a-f]{16}$/)
    expect(hashed).toBe(hashedJtiPrefix(jti))
    expect(hashed).not.toBe(hashedJtiPrefix('jti-example-0002'))
    expect(jti.includes(hashed)).toBe(false)
  })
})
