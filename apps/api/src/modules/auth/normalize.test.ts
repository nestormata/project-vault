import { describe, expect, it } from 'vitest'
import { normalizeEmail } from './normalize.js'

describe('normalizeEmail', () => {
  it('trims, lowercases, and NFKC-normalizes emails', () => {
    expect(normalizeEmail('  Ｏwner@ACME.example  ')).toBe('owner@acme.example')
  })

  it('rejects non-ASCII homograph characters after normalization', () => {
    expect(() => normalizeEmail('аdmin@test.com')).toThrow(/ASCII/)
  })
})
