import { describe, expect, it } from 'vitest'
import { slugify } from './service.js'

describe('slugify', () => {
  it('normalizes organization names into lowercase hyphen slugs', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp')
    expect(slugify('  Foo & Bar!!!  ')).toBe('foo-bar')
  })

  it('truncates slugs to 64 characters and falls back for punctuation-only names', () => {
    expect(slugify('A'.repeat(80))).toHaveLength(64)
    expect(slugify('!!!')).toBe('org')
  })
})
