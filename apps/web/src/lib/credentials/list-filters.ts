import type { CredentialStatus } from '@project-vault/shared'

export type CredentialListFilters = {
  q?: string
  status?: CredentialStatus
  tags?: string
  page: number
  // Story 28.5 AC5/AC6: mirrors the project list's own includeArchived query-param precedent.
  includeArchived?: boolean
}

export function parseCredentialListFilters(url: URL): CredentialListFilters {
  const statusParam = url.searchParams.get('status')
  const status =
    statusParam === 'active' || statusParam === 'expiring' || statusParam === 'expired'
      ? statusParam
      : undefined
  const q = url.searchParams.get('q')?.trim() || undefined
  const tags = url.searchParams.get('tags')?.trim() || undefined
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
  const includeArchived = url.searchParams.get('includeArchived') === 'true'
  return { q, status, tags, page, includeArchived }
}

export function credentialListFilterView(filters: CredentialListFilters) {
  return {
    q: filters.q ?? '',
    status: filters.status ?? '',
    tags: filters.tags ?? '',
    page: filters.page,
    includeArchived: filters.includeArchived ?? false,
  }
}
