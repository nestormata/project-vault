import { apiFetch } from './client.js'

export type CertificateRecord = {
  id: string
  orgId: string
  projectId: string
  domain: string
  expiresAt: string | null
  alertLeadDays: number[]
  notifiedLeadDays: number[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

// Background: both domain and expiresAt are required on create (unlike services).
export type CreateCertificateRequest = {
  domain: string
  expiresAt: string
  alertLeadDays?: number[]
}

// Background: unlike services, certificates' UpdateCertificateBodySchema does allow renaming
// `domain` (AC-C1).
export type UpdateCertificateRequest = {
  domain?: string
  expiresAt?: string
  alertLeadDays?: number[]
}

function certificateUrl(projectId: string, certificateId?: string): string {
  const idSuffix = certificateId ? `/${certificateId}` : ''
  return `/api/v1/projects/${projectId}/certificates${idSuffix}`
}

export async function listCertificates(
  fetchFn: typeof fetch,
  projectId: string
): Promise<CertificateRecord[]> {
  const { items } = await apiFetch<{ items: CertificateRecord[] }>(
    fetchFn,
    certificateUrl(projectId)
  )
  return items
}

export function getCertificate(fetchFn: typeof fetch, projectId: string, certificateId: string) {
  return apiFetch<CertificateRecord>(fetchFn, certificateUrl(projectId, certificateId))
}

export function createCertificate(
  fetchFn: typeof fetch,
  projectId: string,
  body: CreateCertificateRequest
) {
  return apiFetch<CertificateRecord>(fetchFn, certificateUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateCertificate(
  fetchFn: typeof fetch,
  projectId: string,
  certificateId: string,
  body: UpdateCertificateRequest
) {
  return apiFetch<CertificateRecord>(fetchFn, certificateUrl(projectId, certificateId), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteCertificate(fetchFn: typeof fetch, projectId: string, certificateId: string) {
  return apiFetch<undefined>(fetchFn, certificateUrl(projectId, certificateId), {
    method: 'DELETE',
  })
}
