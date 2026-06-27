import { describe, expect, it } from 'vitest'
import {
  generateRecoveryCodes,
  isNormalizedRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeMatches,
  hashRecoveryCode,
} from './recovery-codes.js'

describe('recovery codes', () => {
  it('generates XXXXX-XXXXX codes without ambiguous characters', () => {
    const codes = generateRecoveryCodes(25)

    expect(codes).toHaveLength(25)
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-KMNP-Z2-9]{5}-[A-HJ-KMNP-Z2-9]{5}$/)
      expect(code).not.toMatch(/[01ILO]/)
    }
  })

  it('normalizes hyphenated, spaced, and lowercase recovery-code input', () => {
    expect(normalizeRecoveryCode('K7F2M-9QPLX')).toBe('K7F2M9QPLX')
    expect(normalizeRecoveryCode('k7f2m9qplx')).toBe('K7F2M9QPLX')
    expect(normalizeRecoveryCode('K7F2M 9QPLX')).toBe('K7F2M9QPLX')
  })

  it('rejects ambiguous characters excluded from generated recovery codes', () => {
    expect(isNormalizedRecoveryCode('K7F2M9QPLX')).toBe(false)
    expect(isNormalizedRecoveryCode('K7F2M9QPNX')).toBe(true)
  })

  it('hashes and verifies normalized recovery codes with bcrypt', async () => {
    const hash = await hashRecoveryCode('K7F2M-9QPLX', 10)

    await expect(recoveryCodeMatches('k7f2m9qplx', hash)).resolves.toBe(true)
    await expect(recoveryCodeMatches('R4N8W-3HJTC', hash)).resolves.toBe(false)
  })
})
