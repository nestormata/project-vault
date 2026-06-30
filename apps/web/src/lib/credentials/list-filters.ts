import type { CredentialStatus } from '@project-vault/shared'

export type CredentialListFilters = {
  q?: string
  status?: CredentialStatus
  page: number
}

export function parseCredentialListFilters(url: URL): CredentialListFilters {
  const statusParam = url.searchParams.get('status')
  const status =
    statusParam === 'active' || statusParam === 'expiring' || statusParam === 'expired'
      ? statusParam
      : undefined
  const q = url.searchParams.get('q')?.trim() || undefined
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1)
  return { q, status, page }
}

export function credentialListFilterView(filters: CredentialListFilters) {
  return {
    q: filters.q ?? '',
    status: filters.status ?? '',
    page: filters.page,
  }
}
