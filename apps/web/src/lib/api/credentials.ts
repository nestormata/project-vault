import type {
  CredentialDependency,
  CredentialDetail,
  CredentialSummary,
  CredentialValue,
  CredentialVersionSummary,
  ImportAction,
  ParsedImportItem,
} from '@project-vault/shared'
import { apiFetch, parseApiEnvelope } from './client.js'

export type CreateCredentialRequest = {
  name: string
  value: string
  description?: string | null
  tags?: string[]
}

export type CreateCredentialResponse = {
  id: string
  name: string
}

export type ListCredentialsQuery = {
  q?: string
  tags?: string
  status?: 'active' | 'expiring' | 'expired'
  page?: number
  limit?: number
}

export type ListCredentialsResponse = {
  items: CredentialSummary[]
  total: number
  page: number
  limit: number
  hasNext: boolean
}

export type ImportPreview = {
  importId: string
  expiresAt: string
  itemCount: number
  parsed: ParsedImportItem[]
  warnings: { line: number; reason: string; raw: string }[]
}

export type ImportConfirmRequest = {
  importId: string
  defaultAction: ImportAction
}

export type ImportConfirmResponse = {
  imported: number
  newVersions: number
  skipped: number
  results: { name: string; action: ImportAction; credentialId: string | null }[]
}

function buildListQuery(query: ListCredentialsQuery = {}): string {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.tags) params.set('tags', query.tags)
  if (query.status) params.set('status', query.status)
  if (query.page !== undefined) params.set('page', String(query.page))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

export function listCredentials(
  fetchFn: typeof fetch,
  projectId: string,
  query: ListCredentialsQuery = {}
) {
  return apiFetch<ListCredentialsResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials${buildListQuery(query)}`
  )
}

export function getCredential(fetchFn: typeof fetch, projectId: string, credentialId: string) {
  return apiFetch<CredentialDetail>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}`
  )
}

export function revealCredentialValue(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string
) {
  return apiFetch<CredentialValue>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/value`
  )
}

export function listCredentialVersions(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string
) {
  return apiFetch<{ items: CredentialVersionSummary[] }>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`
  )
}

export type ListCredentialDependenciesResponse = {
  items: CredentialDependency[]
  hasDependencies: boolean
}

export function listCredentialDependencies(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string
) {
  return apiFetch<ListCredentialDependenciesResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies`
  )
}

export function createCredential(
  fetchFn: typeof fetch,
  projectId: string,
  body: CreateCredentialRequest
) {
  return apiFetch<CreateCredentialResponse>(fetchFn, `/api/v1/projects/${projectId}/credentials`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function previewCredentialImport(
  fetchFn: typeof fetch,
  projectId: string,
  file: File
) {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetchFn(`/api/v1/projects/${projectId}/credentials/import`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })

  return parseApiEnvelope<ImportPreview>(response)
}

export function confirmCredentialImport(
  fetchFn: typeof fetch,
  projectId: string,
  body: ImportConfirmRequest
) {
  return apiFetch<ImportConfirmResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/import/confirm`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  )
}
