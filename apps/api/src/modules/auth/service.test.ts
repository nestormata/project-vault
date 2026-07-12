import { describe, expect, it } from 'vitest'
import { isUniqueViolation, slugify } from './service.js'

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

describe('isUniqueViolation', () => {
  it('returns false for a non-Postgres-unique-violation error, regardless of constraint filter', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
    expect(isUniqueViolation({ cause: { code: '23503' } })).toBe(false)
    expect(isUniqueViolation({ cause: { code: '23503' } }, 'users_email_unique')).toBe(false)
  })

  it('returns true for a 23505 unique violation with no constraint filter requested', () => {
    expect(isUniqueViolation({ cause: { code: '23505', constraint_name: 'anything' } })).toBe(true)
  })

  it('matches a 23505 violation against a specific constraint name, both ways', () => {
    const matching = {
      cause: { code: '23505', constraint_name: 'users_email_unique' },
    }
    const nonMatching = {
      cause: { code: '23505', constraint_name: 'organizations_slug_unique' },
    }
    expect(isUniqueViolation(matching, 'users_email_unique')).toBe(true)
    expect(isUniqueViolation(nonMatching, 'users_email_unique')).toBe(false)
  })
})
