import { describe, expect, it } from 'vitest'
import { isBlank, looksLikeUuid } from './validate.js'

describe('looksLikeUuid', () => {
  it('accepts a well-formed UUID', () => {
    expect(looksLikeUuid('a1c2d3e4-0000-0000-0000-000000000000')).toBe(true)
  })

  it('accepts a well-formed UUID regardless of case', () => {
    expect(looksLikeUuid('A1C2D3E4-0000-0000-0000-000000000000')).toBe(true)
  })

  it("rejects a display name typo'd in place of a UUID", () => {
    expect(looksLikeUuid('My Cool Project')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(looksLikeUuid('')).toBe(false)
  })

  it('rejects a near-miss UUID shape (wrong segment length)', () => {
    expect(looksLikeUuid('a1c2d3e4-0000-0000-0000-00000000000')).toBe(false)
  })
})

describe('isBlank', () => {
  it('treats an empty string as blank', () => {
    expect(isBlank('')).toBe(true)
  })

  it('treats a whitespace-only string as blank', () => {
    expect(isBlank('   ')).toBe(true)
  })

  it('treats a tab/newline-only string as blank', () => {
    expect(isBlank('\t\n')).toBe(true)
  })

  it('does not treat a real name as blank', () => {
    expect(isBlank('DATABASE_URL')).toBe(false)
  })

  it('does not treat a name with surrounding whitespace as blank', () => {
    expect(isBlank('  DATABASE_URL  ')).toBe(false)
  })
})
