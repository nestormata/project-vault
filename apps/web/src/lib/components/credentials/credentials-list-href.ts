import type { ProjectPath } from '$lib/app-paths.js'

/** The credentials list filters as the page loads them. */
export interface CredentialListFilters {
  q: string
  status: string
  tags: string
  page: number
  includeArchived: boolean
}

export interface CredentialListOverrides {
  q?: string
  status?: string
  tags?: string
  page?: number
  includeArchived?: boolean
}

function definedOnly(overrides: CredentialListOverrides): CredentialListOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  ) as CredentialListOverrides
}

/** The list URL for the current filters with `overrides` applied (the single source of truth for the
 * query string; moved verbatim from the list component). */
export function credentialsFilterHref(
  projectId: string,
  filters: CredentialListFilters,
  overrides: CredentialListOverrides
): ProjectPath {
  const params = new URLSearchParams()
  const merged = { ...filters, ...definedOnly(overrides) }
  if (merged.q) params.set('q', merged.q)
  if (merged.status) params.set('status', merged.status)
  if (merged.tags) params.set('tags', merged.tags)
  if (merged.page > 1) params.set('page', String(merged.page))
  if (merged.includeArchived) params.set('includeArchived', 'true')
  const query = params.toString()
  return `/projects/${projectId}/credentials${query ? `?${query}` : ''}`
}
