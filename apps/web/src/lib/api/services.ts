import { apiFetch } from './client.js'

// Story 6.4: web UI wrapper for Story 6.1's payment_records-backed "services" resource. Named
// after the user-facing domain language ("Services"), not the physical table name
// (payment_records) — mirrors how service-endpoints.ts already names itself after its route
// rather than the table (TD6-1, Dev Notes).
export type PaymentRecord = {
  id: string
  orgId: string
  projectId: string
  name: string
  url: string | null
  renewalDate: string | null
  alertLeadDays: number[]
  notifiedLeadDays: number[]
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export type CreateServiceRequest = {
  name: string
  url?: string | null
  renewalDate?: string | null
  alertLeadDays?: number[]
}

// Background: UpdatePaymentRecordBodySchema has no `name` field and is `.strict()` — submitting
// `name` returns a 422. The type below intentionally omits `name` so a caller can't accidentally
// include it.
export type UpdateServiceRequest = {
  url?: string | null
  renewalDate?: string | null
  alertLeadDays?: number[]
}

function serviceUrl(projectId: string, serviceId?: string): string {
  return `/api/v1/projects/${projectId}/services${serviceId ? `/${serviceId}` : ''}`
}

export async function listServices(
  fetchFn: typeof fetch,
  projectId: string
): Promise<PaymentRecord[]> {
  const { items } = await apiFetch<{ items: PaymentRecord[] }>(fetchFn, serviceUrl(projectId))
  return items
}

export function getService(fetchFn: typeof fetch, projectId: string, serviceId: string) {
  return apiFetch<PaymentRecord>(fetchFn, serviceUrl(projectId, serviceId))
}

export function createService(
  fetchFn: typeof fetch,
  projectId: string,
  body: CreateServiceRequest
) {
  return apiFetch<PaymentRecord>(fetchFn, serviceUrl(projectId), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateService(
  fetchFn: typeof fetch,
  projectId: string,
  serviceId: string,
  body: UpdateServiceRequest
) {
  return apiFetch<PaymentRecord>(fetchFn, serviceUrl(projectId, serviceId), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteService(fetchFn: typeof fetch, projectId: string, serviceId: string) {
  return apiFetch<undefined>(fetchFn, serviceUrl(projectId, serviceId), { method: 'DELETE' })
}
