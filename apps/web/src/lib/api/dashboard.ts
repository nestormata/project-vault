import type { DashboardAttention, OrgDashboard } from '@project-vault/shared'
import { apiFetch } from './client.js'

export function getOrgDashboard(fetchFn: typeof fetch) {
  return apiFetch<OrgDashboard>(fetchFn, '/api/v1/dashboard')
}

/** Story 72-12: what needs attention for the signed-in user (expiring shares and certificates, pending invitations). */
export function getDashboardAttention(fetchFn: typeof fetch) {
  return apiFetch<DashboardAttention>(fetchFn, '/api/v1/dashboard/attention')
}

/** What the dashboard load hands the page: the list, or `error` (rendered as nothing). */
export type DashboardAttentionState =
  ({ status: 'ready' } & DashboardAttention) | { status: 'error' }
