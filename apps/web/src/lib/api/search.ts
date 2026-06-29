import { apiFetch } from './client.js'

export type SearchResultItem =
  | {
      type: 'credential'
      id: string
      name: string
      description: string | null
      tags: string[]
      projectId: string
      projectName: string
      matchedField: 'name' | 'description' | 'tags'
      snippet: string | null
      expiresAt: string | null
    }
  | {
      type: 'project'
      id: string
      name: string
      description: string | null
      tags: string[]
      slug: string
      matchedField: 'name' | 'tags'
      snippet: string | null
      credentialCount: number
    }

export type SearchResponse = {
  results: SearchResultItem[]
  total: number
  query: string
  types: Array<'credentials' | 'projects'>
}

export function globalSearch(
  fetchFn: typeof fetch,
  params: { q: string; limit?: number; types?: string }
) {
  const search = new URLSearchParams({ q: params.q })
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.types) search.set('types', params.types)
  return apiFetch<SearchResponse>(fetchFn, `/api/v1/search?${search.toString()}`)
}
