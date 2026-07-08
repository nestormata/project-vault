import { apiFetch, ApiClientError } from './client.js'

// --- Search (AC group B) --------------------------------------------------------------------

export type AuditEventItem = {
  id: string
  eventType: string
  actorDisplayName: string
  resourceId: string | null
  resourceType: string | null
  projectId: string | null
  ipAddress: string | null
  createdAt: string
}

export type ListAuditEventsQuery = {
  actorId?: string
  eventType?: string
  resourceId?: string
  projectId?: string
  from?: string
  to?: string
  page?: number
  limit?: number
}

export type ListAuditEventsResult = {
  data: AuditEventItem[]
  page: number
  limit: number
  total: number
  hasNext: boolean
}

// `GET /audit/events`'s response schema puts `page`/`limit`/`total`/`hasNext` as siblings of
// `data`, not nested inside it (unlike every other paginated endpoint this app's `apiFetch`
// generic envelope-unwrap assumes) — using `apiFetch` here would silently return just the bare
// events array and drop the pagination fields this page needs. Read the raw JSON body instead.
async function fetchJsonEnvelope<T>(fetchFn: typeof fetch, path: string): Promise<T> {
  const response = await fetchFn(path, { credentials: 'include' })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = (body as { message?: string } | null)?.message ?? 'Request failed'
    throw new ApiClientError(response.status, body, message)
  }
  return body as T
}

export function listAuditEvents(fetchFn: typeof fetch, query: ListAuditEventsQuery = {}) {
  const params = new URLSearchParams()
  if (query.actorId) params.set('actorId', query.actorId)
  if (query.eventType) params.set('eventType', query.eventType)
  if (query.resourceId) params.set('resourceId', query.resourceId)
  if (query.projectId) params.set('projectId', query.projectId)
  if (query.from) params.set('from', query.from)
  if (query.to) params.set('to', query.to)
  params.set('page', String(query.page ?? 1))
  params.set('limit', String(query.limit ?? 20))
  return fetchJsonEnvelope<ListAuditEventsResult>(
    fetchFn,
    `/api/v1/org/audit/events?${params.toString()}`
  )
}

// --- Integrity verification (AC group D) ----------------------------------------------------

export type AuditVerifyResult = {
  summary: string
  rowsChecked: number
  passed: number
  failed: { id: string; eventType: string; timestamp: string }[]
  failedCount: number
  failedTruncated: boolean
  verifiedAt: string
}

export function verifyAuditRange(fetchFn: typeof fetch, from: string, to: string) {
  const params = new URLSearchParams({ from, to })
  return apiFetch<AuditVerifyResult>(fetchFn, `/api/v1/org/audit/verify?${params.toString()}`)
}

// --- Export (AC group C) ---------------------------------------------------------------------

export type TriggerAuditExportResult = { jobId: string; status: 'pending' }

export function triggerAuditExport(fetchFn: typeof fetch, params: { from: string; to: string }) {
  return apiFetch<TriggerAuditExportResult>(fetchFn, '/api/v1/org/audit/export', {
    method: 'POST',
    body: JSON.stringify({
      from: params.from,
      to: params.to,
      format: 'csv',
      includeIntegrityReport: true,
    }),
  })
}

export type AuditExportStatus = {
  jobId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  errorReason?: string | null
  rowsChecked?: number | null
  integritySummary?: { passed: number; failedCount: number; failed?: unknown[] } | null
  downloadUrl: string | null
  createdAt: string
  completedAt: string | null
}

export function getAuditExportStatus(fetchFn: typeof fetch, jobId: string) {
  return apiFetch<AuditExportStatus>(fetchFn, `/api/v1/org/audit/exports/${jobId}`)
}

// D3 — the CSV export already sets `Content-Disposition` server-side; the page links to this
// path directly via a plain `<a href>`, no JS-driven fetch involved.
export function auditExportDownloadUrl(jobId: string): string {
  return `/api/v1/org/audit/exports/${jobId}/download`
}

// --- Forwarding configuration (AC group E, write-only per D2) --------------------------------

export type AuditForwardingWebhookConfig = {
  type: 'webhook'
  config: { url: string; secretHeader: string }
}
export type AuditForwardingS3Config = {
  type: 's3'
  config: {
    bucket: string
    prefix?: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    endpoint?: string
  }
}

export type AuditForwardingResult = {
  type: 'webhook' | 's3'
  enabled: boolean
  configuredAt: string
}

export function updateAuditForwarding(
  fetchFn: typeof fetch,
  request: AuditForwardingWebhookConfig | AuditForwardingS3Config
) {
  return apiFetch<AuditForwardingResult>(fetchFn, '/api/v1/org/audit/forwarding', {
    method: 'PUT',
    body: JSON.stringify(request),
  })
}

// --- Retention configuration (AC group F, write-only per D2) ---------------------------------

export type AuditRetentionResult = { retentionDays: number | null; updatedAt: string }

export function updateAuditRetention(fetchFn: typeof fetch, retentionDays: number | null) {
  return apiFetch<AuditRetentionResult>(fetchFn, '/api/v1/org/audit/retention', {
    method: 'PUT',
    body: JSON.stringify({ retentionDays }),
  })
}

// --- Point-in-time access report (AC group G) -------------------------------------------------

export type AccessReportUser = {
  userId: string
  displayName: string
  orgRole: string
  status: 'active' | 'deactivated'
  projects: { projectId: string; projectName: string; role: string; grantedAt: string }[]
}

export type AccessReportResult = {
  users: AccessReportUser[]
  generatedAt: string
  asOf: string
  page: number
  limit: number
  total: number
  hasNext: boolean
}

export type AccessReportParams = { asOf?: string; page?: number; limit?: number }

function accessReportBody(params: AccessReportParams, format: 'json' | 'csv') {
  // D2 item 1 — the fast/historical branch is determined only by whether `asOf` is present in
  // the request body at all, never by an empty-string/omitted-but-present value.
  const body: Record<string, unknown> = {
    page: params.page ?? 1,
    limit: params.limit ?? 20,
    format,
  }
  if (params.asOf) body.asOf = params.asOf
  return body
}

export function runAccessReport(fetchFn: typeof fetch, params: AccessReportParams = {}) {
  return apiFetch<AccessReportResult>(fetchFn, '/api/v1/org/audit/access-report', {
    method: 'POST',
    body: JSON.stringify(accessReportBody(params, 'json')),
  })
}

// AC-G3 — the CSV variant returns plain `text/csv` with no `Content-Disposition` header and is
// not wrapped in a `{ data }` envelope (`z.string()` response schema) — `apiFetch`'s JSON-only
// envelope parsing can't be reused; read the body as text directly (D3).
export async function runAccessReportCsv(
  fetchFn: typeof fetch,
  params: AccessReportParams = {}
): Promise<string> {
  const response = await fetchFn('/api/v1/org/audit/access-report', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(accessReportBody(params, 'csv')),
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => null)
    throw new ApiClientError(response.status, failure, failure?.message ?? 'Request failed')
  }
  return response.text()
}
