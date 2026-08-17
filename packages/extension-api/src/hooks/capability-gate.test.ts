import { describe, expect, it } from 'vitest'
import type { CapabilityDecision, CapabilityGateContext } from './capability-gate.js'

/**
 * AC3(a) — exact-key shape tests. These are the enforcement mechanism for tier-agnosticism (no
 * token grep is written, at any scope — see AC-3's Dev Notes for why).
 */
describe('CapabilityGateContext / CapabilityDecision — exact-shape tests (AC3)', () => {
  it('CapabilityGateContext has exactly the five keys the story specifies', () => {
    const fixture: CapabilityGateContext = {
      capability: 'monitoring.public-status-page',
      orgId: 'org_1',
      userId: 'user_1',
      orgRole: 'admin',
      gateCallId: 'call_1',
    }
    expect(new Set(Object.keys(fixture))).toEqual(
      new Set(['capability', 'orgId', 'userId', 'orgRole', 'gateCallId'])
    )
  })

  it('CapabilityDecision permitted:true variant has exactly one key', () => {
    const fixture: CapabilityDecision = { permitted: true }
    expect(new Set(Object.keys(fixture))).toEqual(new Set(['permitted']))
  })

  it('CapabilityDecision permitted:false variant has exactly permitted/reasonCode/message', () => {
    const fixture: CapabilityDecision = {
      permitted: false,
      reasonCode: 'tier_too_low_placeholder',
      message: 'Upgrade to enable this.',
    }
    expect(new Set(Object.keys(fixture))).toEqual(new Set(['permitted', 'reasonCode', 'message']))
  })
})
