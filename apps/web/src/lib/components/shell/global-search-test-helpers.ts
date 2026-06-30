import { vi } from 'vitest'
import type { SearchResultItem } from '$lib/api/search.js'

export const credentialResult: SearchResultItem = {
  type: 'credential',
  id: 'cred-1',
  name: 'Stripe API Key',
  description: 'Payments',
  tags: ['payments'],
  projectId: 'proj-1',
  projectName: 'Payments',
  matchedField: 'name',
  snippet: 'Stripe API Key for prod',
  expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
}

export const projectResult: SearchResultItem = {
  type: 'project',
  id: 'proj-2',
  name: 'Infra Core',
  description: null,
  tags: ['infra'],
  slug: 'infra-core',
  matchedField: 'name',
  snippet: null,
  credentialCount: 12,
}

export function searchResponse(results: SearchResultItem[], query = 'stripe') {
  return new Response(
    JSON.stringify({
      data: {
        results,
        total: results.length,
        query,
        types: ['credentials', 'projects'],
      },
    }),
    { status: 200 }
  )
}

export function installSearchFetchMock(
  handler: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response> = () =>
    searchResponse([])
) {
  vi.stubGlobal('fetch', vi.fn(handler))
}
