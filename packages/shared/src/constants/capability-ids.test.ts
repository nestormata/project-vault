import { describe, expect, it } from 'vitest'
import { CapabilityId } from './capability-ids.js'

/** AC-3(b) — the golden capability-id list. Adding an id requires an explicit diff here. */
describe('CapabilityId — golden list (AC-3b, AC-22)', () => {
  it('is exactly this literal array', () => {
    expect(Object.values(CapabilityId)).toEqual(['monitoring.public-status-page'])
  })

  it('every id matches the PV-domain dotted-name pattern and excludes tier-flavored substrings', () => {
    // fixed pattern over a closed, developer-authored constant list, never external input.
    // eslint-disable-next-line security/detect-unsafe-regex
    const pattern = /^[a-z0-9]+(\.[a-z0-9-]+)+$/
    const forbidden = ['tier', 'plan', 'subscription', 'billing', 'paid']
    for (const id of Object.values(CapabilityId)) {
      expect(id).toMatch(pattern)
      for (const bad of forbidden) {
        expect(id.toLowerCase().includes(bad)).toBe(false)
      }
    }
  })

  it('stays within the reviewable smallness bound', () => {
    expect(Object.values(CapabilityId).length).toBeLessThanOrEqual(32)
  })
})
