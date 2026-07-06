import type { HealthDashboard } from '@project-vault/shared'
import { apiFetch } from './client.js'

export function getHealthDashboard(fetchFn: typeof fetch) {
  return apiFetch<HealthDashboard>(fetchFn, '/api/v1/health-dashboard')
}
