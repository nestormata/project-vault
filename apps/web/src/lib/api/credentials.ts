import { apiFetch } from './client.js'

export type CreateCredentialRequest = {
  name: string
  value: string
  description?: string | null
  tags?: string[]
}

export type CredentialSummary = {
  id: string
  name: string
}

export function createCredential(
  fetchFn: typeof fetch,
  projectId: string,
  body: CreateCredentialRequest
) {
  return apiFetch<CredentialSummary>(fetchFn, `/api/v1/projects/${projectId}/credentials`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
