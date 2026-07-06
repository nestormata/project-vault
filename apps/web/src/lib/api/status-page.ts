import type { StatusPageConfig, StatusPageService, StatusPageToken } from '@project-vault/shared'
import { apiFetch } from './client.js'

export type UpdateStatusPageRequest = {
  services: { serviceId: string; displayName: string }[]
}

function statusPageUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/status-page`
}

export function getStatusPageConfig(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<StatusPageConfig>(fetchFn, statusPageUrl(projectId))
}

export function enableStatusPage(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<StatusPageToken>(fetchFn, statusPageUrl(projectId), {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function regenerateStatusPageToken(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<StatusPageToken>(fetchFn, `${statusPageUrl(projectId)}/regenerate`, {
    method: 'POST',
  })
}

export function updateStatusPageServices(
  fetchFn: typeof fetch,
  projectId: string,
  body: UpdateStatusPageRequest
) {
  return apiFetch<{ services: StatusPageService[] }>(fetchFn, statusPageUrl(projectId), {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function disableStatusPage(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<undefined>(fetchFn, statusPageUrl(projectId), { method: 'DELETE' })
}
