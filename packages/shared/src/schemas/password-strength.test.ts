import { describe, expect, it } from 'vitest'
import {
  MIN_PASSWORD_STRENGTH_SCORE,
  passwordMeetsStrengthRequirement,
} from './password-strength.js'

describe('passwordMeetsStrengthRequirement', () => {
  it('has a fixed minimum score of 3 (a security baseline, not an env-configurable knob)', () => {
    expect(MIN_PASSWORD_STRENGTH_SCORE).toBe(3)
  })

  it('accepts the project-wide strong-password fixture (correct-horse-battery-staple)', () => {
    // Story 1.21 AC-1: verified empirically, not assumed — this fixture is used 59+ times
    // across this codebase's test suites and must keep passing under the new check.
    expect(passwordMeetsStrengthRequirement('correct-horse-battery-staple')).toBe(true)
  })

  it("rejects the finding's concrete example: a length-padded repeated dictionary word", () => {
    // passwordpassword is 16 characters (passes the >=12 length floor) but is a trivially
    // guessable repeated dictionary word.
    expect(passwordMeetsStrengthRequirement('passwordpassword')).toBe(false)
  })

  it.each(['qwertyqwertyqwer', 'letmeinletmeinle', 'aaaaaaaaaaaa1', '123456789012'])(
    'rejects other length-padded weak passwords: %s',
    (weakPassword) => {
      expect(passwordMeetsStrengthRequirement(weakPassword)).toBe(false)
    }
  )

  it('bounds scoring cost beyond the 100-character cap (DoS mitigation)', () => {
    // Decision 4: only the first 100 characters are scored. A long run of a repeated substring is
    // a documented zxcvbn worst case for pattern-matching cost, so this asserts that the
    // slice(0, 100) cap actually bounds the cost rather than merely being documented.
    //
    // The assertion is a RATIO, not a wall-clock budget. An absolute millisecond threshold
    // measures the machine, not the cap: the previous `toBeLessThan(200)` passed locally at ~37ms
    // and failed on GitHub runners at ~228ms, consistently. Comparing an input beyond the cap
    // against one exactly at the cap is speed-independent, and it tests the claim directly —
    // both slice to the same 100 characters, so the cost must be the same. Measured here: 1.02x
    // with the cap in place, against 2.08x for a genuine length increase below it, so a removed
    // cap would push this well past the tolerance.
    const beyondCap = 'ab'.repeat(128) // 256 characters
    const atCap = 'ab'.repeat(50) // 100 characters

    // Warm up first, so lazy initialisation inside the scorer is not charged to the first sample.
    for (let index = 0; index < 5; index += 1) passwordMeetsStrengthRequirement(atCap)

    const bestOf = (input: string): number => {
      let fastest = Infinity
      for (let index = 0; index < 15; index += 1) {
        const start = performance.now()
        passwordMeetsStrengthRequirement(input)
        fastest = Math.min(fastest, performance.now() - start)
      }
      return fastest
    }

    const atCapMs = bestOf(atCap)
    expect(bestOf(beyondCap) / atCapMs).toBeLessThan(1.5)
    // A generous absolute ceiling as well, to catch a pathological blow-up that scales both
    // inputs equally. Sized far above the slowest observed CI sample so it cannot flake.
    expect(atCapMs).toBeLessThan(1000)
  })
})
