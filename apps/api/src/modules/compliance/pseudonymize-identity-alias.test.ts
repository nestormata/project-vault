import { describe, expect, it } from 'vitest'
import { generatePseudonymAlias } from './pseudonymize-identity.js'

describe('generatePseudonymAlias', () => {
  it('produces a "user_" prefix followed by 8 lowercase-alphanumeric characters', () => {
    const alias = generatePseudonymAlias()
    expect(alias).toMatch(/^user_[a-z0-9]{8}$/)
  })

  it('produces different aliases across calls (crypto-random, not constant)', () => {
    const aliases = new Set(Array.from({ length: 20 }, () => generatePseudonymAlias()))
    expect(aliases.size).toBeGreaterThan(1)
  })
})
