import { ZxcvbnFactory } from '@zxcvbn-ts/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  describe('100-character scoring cap (DoS mitigation, Story 1.21 Decision 4)', () => {
    // The claim is structural: the scorer is never handed more than 100 characters. Asserting the
    // argument handed to zxcvbn proves that deterministically; a wall-clock ratio only measured
    // scheduler noise (DW-416, Story 66-8). Call-through spies keep the real scorer, so verdicts
    // below are genuine.
    const CAP = 100

    afterEach(() => {
      vi.restoreAllMocks()
    })

    const scoredArguments = (password: string) => {
      const check = vi.spyOn(ZxcvbnFactory.prototype, 'check')
      const checkAsync = vi.spyOn(ZxcvbnFactory.prototype, 'checkAsync')
      const verdict = passwordMeetsStrengthRequirement(password)
      // Assert the spy fired exactly once before reading arguments, so the test cannot pass
      // vacuously, and that no second (async) full-length scoring path exists.
      expect(check).toHaveBeenCalledTimes(1)
      expect(checkAsync).toHaveBeenCalledTimes(0)
      return { argument: check.mock.calls[0]?.[0], verdict }
    }

    it('spies on a real prototype method', () => {
      expect(typeof ZxcvbnFactory.prototype.check).toBe('function')
    })

    it('hands the scorer only the first 100 characters of a 256-character input', () => {
      const input = 'ab'.repeat(128)
      expect(input).toHaveLength(256)
      const { argument } = scoredArguments(input)
      expect(argument).toHaveLength(CAP)
      expect(argument).toBe(input.slice(0, CAP))
    })

    it.each([
      { length: 0, expected: 0 },
      { length: 99, expected: 99 },
      { length: 100, expected: 100 },
      { length: 101, expected: 100 },
      { length: 256, expected: 100 },
    ])('scores $expected characters for a $length-character input', ({ length, expected }) => {
      const input = 'x'.repeat(length)
      const { argument } = scoredArguments(input)
      expect(argument).toHaveLength(expected)
      expect(argument).toBe(input.slice(0, expected))
    })

    it('caps by UTF-16 code unit, so a surrogate pair straddling index 100 is split (documented behaviour)', () => {
      const input = `${'a'.repeat(99)}\u{1F600}${'b'.repeat(49)}`
      expect(input).toHaveLength(150)
      const { argument } = scoredArguments(input)
      expect(argument).toHaveLength(CAP)
      expect(argument).toBe(input.slice(0, CAP))
    })

    it('gives a weak 256-character input the same verdict as its own 100-character prefix', () => {
      const input = 'ab'.repeat(128)
      expect(scoredArguments(input).verdict).toBe(false)
      vi.restoreAllMocks()
      expect(scoredArguments(input.slice(0, CAP)).verdict).toBe(false)
    })
  })
})
