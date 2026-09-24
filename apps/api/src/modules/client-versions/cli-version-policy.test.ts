import { describe, expect, it } from 'vitest'
import { BAKED_CLI_VERSION_POLICY } from './cli-version-policy.js'
import { isStrictSemver, STRICT_RELEASE_VERSION } from './policy.js'

/** Story 43.6 AC-7 — the upstream (baked) CLI policy is operator-text-free and well-formed. */
describe('BAKED_CLI_VERSION_POLICY', () => {
  it('minimum is null or a strict X.Y.Z release', () => {
    const { minimumSupported } = BAKED_CLI_VERSION_POLICY
    if (minimumSupported !== null) expect(minimumSupported).toMatch(STRICT_RELEASE_VERSION)
  })

  it('every withdrawn entry has a strict version and a printable-ASCII reason of 1-200 chars', () => {
    const seen = new Set<string>()
    for (const entry of BAKED_CLI_VERSION_POLICY.withdrawn) {
      expect(isStrictSemver(entry.version)).toBe(true)
      expect(entry.reason).toMatch(/^[\x20-\x7e]{1,200}$/)
      expect(seen.has(entry.version)).toBe(false)
      seen.add(entry.version)
    }
  })

  it('ships with no withdrawn versions and no minimum today', () => {
    expect(BAKED_CLI_VERSION_POLICY).toEqual({ minimumSupported: null, withdrawn: [] })
  })
})
