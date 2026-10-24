import type { OrgAuditState } from '$lib/api/platform.js'

export const STATE_BADGE: Record<OrgAuditState, { label: string; class: string }> = {
  unlimited: { label: 'Unlimited', class: 'bg-gray-100 text-gray-700' },
  ok: { label: 'Ok', class: 'bg-green-100 text-green-800' },
  warning: { label: 'Warning', class: 'bg-amber-100 text-amber-800' },
  critical: { label: 'Critical', class: 'bg-orange-100 text-orange-800' },
  blocked: { label: 'Blocked', class: 'bg-red-100 text-red-800' },
  stale: { label: 'Stale', class: 'bg-slate-200 text-slate-700' },
}

export const WARNING_MESSAGES: Record<string, { message: string }> = {
  audit_storage_critical: {
    message:
      'Audit log storage is at critical capacity — export and prune, or increase `AUDIT_LOG_STORAGE_LIMIT_GB`.',
  },
  key_custody_risk: {
    message:
      'Master key custody risk: a single lost key file means unrecoverable data, or the key hasn’t been rotated recently.',
  },
}

export function thresholdClass(pct: number | null): string {
  if (pct === null) return 'text-gray-700'
  if (pct >= 95) return 'font-bold text-red-700'
  if (pct >= 90) return 'font-semibold text-orange-600'
  if (pct >= 80) return 'text-amber-600'
  return 'text-gray-700'
}

export function thresholdLabel(pct: number | null): string {
  if (pct === null) return ''
  if (pct >= 95) return 'Critical'
  if (pct >= 90) return 'High usage'
  if (pct >= 80) return 'Approaching limit'
  return ''
}

export function pct(current: number, limit: number | null): number | null {
  if (limit === null || limit === 0) return null
  return Math.round((current / limit) * 100)
}
