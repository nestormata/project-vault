import type { OrgDashboard } from '@project-vault/shared'
import { apiFetch } from './client.js'

export function getOrgDashboard(fetchFn: typeof fetch) {
  return apiFetch<OrgDashboard>(fetchFn, '/api/v1/dashboard')
}
