import { apiFetch } from './client.js'

export type DomainRecord = {
  id: string
  orgId: string
  projectId: string
  domainName: string
  renewalDate: string | null
  alertLeadDays: number[]
  notifiedLeadDays: number[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

// Background: both domainName and renewalDate are required on create (unlike services). Story
// 6.1 AC 3 explicitly permits duplicate domainName values within a project — no client-side
// uniqueness check is added here.
export type CreateDomainRequest = {
  domainName: string
  renewalDate: string
  alertLeadDays?: number[]
}

export type UpdateDomainRequest = {
  domainName?: string
  renewalDate?: string
  alertLeadDays?: number[]
}

function domainUrl(projectId: string, domainId?: string): string {
  const idSuffix = domainId ? `/${domainId}` : ''
  return `/api/v1/projects/${projectId}/domains${idSuffix}`
}

export async function listDomains(
  fetchFn: typeof fetch,
  projectId: string
): Promise<DomainRecord[]> {
  const { items } = await apiFetch<{ items: DomainRecord[] }>(fetchFn, domainUrl(projectId))
  return items
}

export function getDomain(fetchFn: typeof fetch, projectId: string, domainId: string) {
  return apiFetch<DomainRecord>(fetchFn, domainUrl(projectId, domainId))
}

export function createDomain(fetchFn: typeof fetch, projectId: string, body: CreateDomainRequest) {
  return apiFetch<DomainRecord>(fetchFn, domainUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateDomain(
  fetchFn: typeof fetch,
  projectId: string,
  domainId: string,
  body: UpdateDomainRequest
) {
  return apiFetch<DomainRecord>(fetchFn, domainUrl(projectId, domainId), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteDomain(fetchFn: typeof fetch, projectId: string, domainId: string) {
  return apiFetch<undefined>(fetchFn, domainUrl(projectId, domainId), { method: 'DELETE' })
}
