import { apiFetch } from './client.js'

export type OrgSsoDomain = {
  id: string
  domain: string
  providerName: string
  createdAt: string
}

export type CreateOrgSsoDomainInput = { domain: string; providerName: string }
export type UpdateOrgSsoDomainInput = { domain?: string; providerName?: string }

function jsonBody(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
}

const BASE_URL = '/api/v1/org/sso-domains'

export function listOrgSsoDomains(fetchFn: typeof fetch) {
  return apiFetch<OrgSsoDomain[]>(fetchFn, BASE_URL)
}

export function createOrgSsoDomain(fetchFn: typeof fetch, input: CreateOrgSsoDomainInput) {
  return apiFetch<OrgSsoDomain>(fetchFn, BASE_URL, jsonBody('POST', input))
}

export function updateOrgSsoDomain(
  fetchFn: typeof fetch,
  id: string,
  input: UpdateOrgSsoDomainInput
) {
  return apiFetch<OrgSsoDomain>(fetchFn, `${BASE_URL}/${id}`, jsonBody('PATCH', input))
}

export function deleteOrgSsoDomain(fetchFn: typeof fetch, id: string) {
  return apiFetch<{ id: string }>(fetchFn, `${BASE_URL}/${id}`, { method: 'DELETE' })
}
