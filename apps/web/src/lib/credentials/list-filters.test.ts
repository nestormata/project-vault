import { describe, expect, it } from 'vitest'
import { credentialListFilterView, parseCredentialListFilters } from './list-filters.js'

function makeUrl(query: string): URL {
  return new URL(`https://example.com/projects/p1/credentials${query}`)
}

describe('parseCredentialListFilters', () => {
  it('parses q/status/page as before (regression)', () => {
    const filters = parseCredentialListFilters(makeUrl('?q=stripe&status=active&page=2'))
    expect(filters).toEqual({ q: 'stripe', status: 'active', tags: undefined, page: 2 })
  })

  it('AC-F1: parses a tags query param, trimmed', () => {
    const filters = parseCredentialListFilters(makeUrl('?tags=%20db%2C%20prod%20'))
    expect(filters.tags).toBe('db, prod')
  })

  it('AC-F1: tags is undefined when the param is blank/absent', () => {
    expect(parseCredentialListFilters(makeUrl('')).tags).toBeUndefined()
    expect(parseCredentialListFilters(makeUrl('?tags=')).tags).toBeUndefined()
    expect(parseCredentialListFilters(makeUrl('?tags=%20%20')).tags).toBeUndefined()
  })
})

describe('credentialListFilterView', () => {
  it('echoes tags back as an empty string when absent (regression-safe default)', () => {
    const view = credentialListFilterView({ q: undefined, status: undefined, page: 1 })
    expect(view.tags).toBe('')
  })

  it('AC-F1: echoes a set tags value back verbatim', () => {
    const view = credentialListFilterView({ tags: 'db, prod', page: 1 })
    expect(view.tags).toBe('db, prod')
  })
})
