import type { PlatformAuditFilters } from '$lib/api/platform.js'
import { buildDateRangePart } from '$lib/audit/date-range.js'

/** The search filters read from the URL never carry pagination (page/limit are passed separately). */
export type AuditSearchFilters = Omit<PlatformAuditFilters, 'page' | 'limit'>

export function hasActiveFilters(filters: AuditSearchFilters | undefined): boolean {
  return Boolean(filters && Object.values(filters).some((v) => Boolean(v)))
}

export function filterSummary(filters: Record<string, string | undefined>): string {
  const parts: string[] = []
  if (filters.actionType) parts.push(`action = ${filters.actionType}`)
  if (filters.operatorId) parts.push(`operator = ${filters.operatorId}`)
  if (filters.targetOrgId) parts.push(`org = ${filters.targetOrgId}`)
  if (filters.targetUserId) parts.push(`user = ${filters.targetUserId}`)
  const datePart = buildDateRangePart(filters)
  if (datePart) parts.push(datePart)
  return parts.join(', ')
}
