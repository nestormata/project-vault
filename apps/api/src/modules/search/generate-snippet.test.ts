import { describe, expect, it } from 'vitest'
import { generateSnippet } from './service.js'

describe('generateSnippet', () => {
  it('returns null when text is null', () => {
    expect(generateSnippet(null, 'anything')).toBeNull()
  })

  it('returns the first 120 chars when the query is not found in the text', () => {
    const text = 'a'.repeat(200)
    expect(generateSnippet(text, 'nomatch')).toBe('a'.repeat(120))
  })

  it('returns the full short text unchanged (no ellipsis) when the query is not found', () => {
    expect(generateSnippet('short text', 'nomatch')).toBe('short text')
  })

  it('centers a snippet around the match, with a leading ellipsis when truncated at the start', () => {
    const text = `${'x'.repeat(50)}needle${'y'.repeat(50)}`
    const snippet = generateSnippet(text, 'needle')
    expect(snippet?.startsWith('…')).toBe(true)
    expect(snippet).toContain('needle')
  })

  it('has no leading ellipsis when the match is near the start of the text', () => {
    const text = `needle${'y'.repeat(100)}`
    const snippet = generateSnippet(text, 'needle')
    expect(snippet?.startsWith('…')).toBe(false)
  })

  it('has a trailing ellipsis only when the snippet window does not reach the end of the text', () => {
    const shortText = 'needle at the very end'
    const noTrailing = generateSnippet(shortText, 'needle')
    expect(noTrailing?.endsWith('…')).toBe(false)

    const longText = `${'x'.repeat(50)}needle${'y'.repeat(200)}`
    const withTrailing = generateSnippet(longText, 'needle')
    expect(withTrailing?.endsWith('…')).toBe(true)
  })

  it('matches case-insensitively', () => {
    const snippet = generateSnippet('The Quick Brown Fox', 'quick')
    expect(snippet).toContain('Quick')
  })
})
