import type { PublicStatusPage } from '@project-vault/shared'
import { apiFetch } from './client.js'

export function getPublicStatusPage(fetchFn: typeof fetch, token: string) {
  return apiFetch<PublicStatusPage>(fetchFn, `/api/v1/status-pages/${encodeURIComponent(token)}`)
}
