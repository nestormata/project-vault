import { ApiClientError } from '$lib/api/client.js'
import { listAuditEvents, type AuditEventItem } from '$lib/api/audit.js'
import { requireUser } from '$lib/server/require-user.js'
import type { PageServerLoad } from './$types.js'

// AC-B4/N1 — this page's premise is entirely owner-only (search/export/verify), so a
// non-owner sees a page-level notice instead of any role-conditional sub-content.
const AUDIT_LOG_ROLE = 'owner'

export type AuditFilters = {
  actorId?: string
  eventType?: string
  resourceId?: string
  projectId?: string
  from?: string
  to?: string
}

function readFilters(url: URL): AuditFilters {
  const filters: AuditFilters = {}
  for (const key of ['actorId', 'eventType', 'resourceId', 'projectId', 'from', 'to'] as const) {
    const value = url.searchParams.get(key)
    if (value) filters[key] = value
  }
  return filters
}

export const load: PageServerLoad = async ({ fetch, url, locals }) => {
  const user = requireUser(locals)
  const orgRole = user.orgRole
  const filters = readFilters(url)
  const page = Number(url.searchParams.get('page') ?? '1') || 1

  if (orgRole !== AUDIT_LOG_ROLE) {
    return { orgRole, allowed: false as const }
  }

  try {
    const result = await listAuditEvents(fetch, { ...filters, page, limit: 20 })
    return {
      orgRole,
      allowed: true as const,
      filters,
      events: result.data,
      total: result.total,
      limit: result.limit,
      page: result.page,
      hasNext: result.hasNext,
      errorMessage: null as string | null,
    }
  } catch (err) {
    // AC-B1/O1 — a search failure (e.g. a transient 429) must not crash the whole page; show an
    // honest error state instead of a raw 500, and let the filter/export/verify panels below
    // remain usable (per AC-O1's "do not hide the whole page because the table failed" rule).
    const errorMessage =
      err instanceof ApiClientError
        ? (err.message ?? 'Failed to load audit events')
        : 'Failed to load audit events'
    return {
      orgRole,
      allowed: true as const,
      filters,
      events: [] as AuditEventItem[],
      total: 0,
      limit: 20,
      page: 1,
      hasNext: false,
      errorMessage,
    }
  }
}
