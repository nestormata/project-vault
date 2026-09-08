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

  it('completes in bounded time for a 256-character adversarial worst-case input (DoS mitigation)', () => {
    // Decision 4: only the first 100 characters are scored. A long run of a repeated
    // substring is a documented zxcvbn worst case for pattern-matching cost; this test
    // confirms the slice(0, 100) cap actually bounds the scoring cost, not just that it's
    // documented.
    const adversarial = 'ab'.repeat(128) // 256 characters
    const start = performance.now()
    passwordMeetsStrengthRequirement(adversarial)
    const elapsedMs = performance.now() - start
    expect(elapsedMs).toBeLessThan(200)
  })
})
