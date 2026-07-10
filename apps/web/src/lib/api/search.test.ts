import { describe, expect, it, vi } from 'vitest'
import { globalSearch } from './search.js'

describe('globalSearch', () => {
  it('builds a query with only q when limit and types are omitted', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ results: [], total: 0, query: 'x', types: [] }))
    )
    await globalSearch(fetchFn as unknown as typeof fetch, { q: 'stripe' })
    const requested = fetchFn.mock.calls[0]?.[0] as string
    expect(requested).toBe('/api/v1/search?q=stripe')
  })

  it('includes limit and types in the query when provided', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ results: [], total: 0, query: 'x', types: [] }))
    )
    await globalSearch(fetchFn as unknown as typeof fetch, {
      q: 'stripe',
      limit: 5,
      types: 'credentials',
    })
    const requested = fetchFn.mock.calls[0]?.[0] as string
    expect(requested).toBe('/api/v1/search?q=stripe&limit=5&types=credentials')
  })
})
