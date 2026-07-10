import type {
  CredentialDependency,
  CredentialDetail,
  CredentialSummary,
  CredentialValue,
  CredentialVersionSummary,
  ImportAction,
  ParsedImportItem,
  SystemType,
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

export type UpdateCredentialLifecycleRequest = {
  expiresAt: string | null
  rotationSchedule: string | null
  cacheable: boolean
}

export type UpdateCredentialLifecycleResponse = {
  id: string
  expiresAt: string | null
  rotationSchedule: string | null
  cacheable: boolean
  updatedAt: string
}

// AC-L1: this form always shows and submits the full current state, so all three keys are always
// present — deliberately avoiding the ambiguity of "blank means don't touch" vs. "blank means
// clear" that the PATCH endpoint's partial-field semantics would otherwise require disambiguating.
export function updateCredentialLifecycle(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  body: UpdateCredentialLifecycleRequest
) {
  return apiFetch<UpdateCredentialLifecycleResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    }
  )
}

export type AddCredentialDependencyRequest = {
  systemName: string
  systemType?: SystemType
  notes?: string | null
}

// AC-D1: the UI always sends `systemType` explicitly (the pre-selected default, not an omitted
// field), so the displayed default always matches what's actually submitted.
export function addCredentialDependency(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  body: AddCredentialDependencyRequest
) {
  return apiFetch<CredentialDependency>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  )
}

export type ArchiveCredentialDependencyResponse = {
  id: string
  credentialId: string
  archivedAt: string
}

export function archiveCredentialDependency(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  dependencyId: string
) {
  return apiFetch<ArchiveCredentialDependencyResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies/${dependencyId}`,
    { method: 'DELETE' }
  )
}

export type AddCredentialVersionRequest = { value: string }

export type AddCredentialVersionResponse = {
  credentialId: string
  versionNumber: number
  createdAt: string
}

export function addCredentialVersion(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  body: AddCredentialVersionRequest
) {
  return apiFetch<AddCredentialVersionResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
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
