import { apiFetch } from './client.js'

export type ExternalIdentity = {
  id: string
  userId: string
  email: string
  providerName: string
  externalSubject: string
  createdAt: string
}

export type LinkExternalIdentityInput = {
  userId: string
  providerName: string
  externalSubject: string
}

function jsonBody(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
}

const BASE_URL = '/api/v1/admin/external-identities'

export function listExternalIdentities(fetchFn: typeof fetch) {
  return apiFetch<ExternalIdentity[]>(fetchFn, BASE_URL)
}

export function linkExternalIdentity(fetchFn: typeof fetch, input: LinkExternalIdentityInput) {
  return apiFetch<ExternalIdentity>(fetchFn, BASE_URL, jsonBody('POST', input))
}

export function unlinkExternalIdentity(fetchFn: typeof fetch, id: string) {
  return apiFetch<{ id: string }>(fetchFn, `${BASE_URL}/${id}`, { method: 'DELETE' })
}
