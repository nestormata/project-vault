import { apiFetch } from './client.js'

export type ReadyResponse = {
  status: 'ready' | 'unavailable'
  warnings?: string[]
}

// D2.2: BackupListItem now includes status and errorMessage
export type BackupListItem = {
  filename: string
  timestamp: string
  sizeBytes: number | null
  keyVersion: number | null
  verified: 'unverified' | 'valid' | 'invalid'
  status: 'running' | 'succeeded' | 'failed'
  errorMessage: string | null
}

export type BackupListResponse = {
  items: BackupListItem[]
}

export type BackupTriggerResponse = {
  jobId: string
  status: 'running'
}

// D2.3: BackupAssetsPresent gains dataErasureRequests
export type BackupAssetsPresent = {
  credentials: boolean
  projects: boolean
  users: boolean
  auditEvents: boolean
  dataErasureRequests: boolean
}

export type BackupValidateResponse = {
  valid: boolean
  assetsPresent: BackupAssetsPresent
  checksum: 'match' | 'mismatch'
}

export type BackupRestoreResponse = {
  restored: true
  filename: string
  sealedAfterRestore: true
}

// System settings (unwrapped — no `data` key, per story endpoint table)
export type EffectiveSmtpSettings = {
  host: string | null
  port: number | null
  user: string | null
  from: string | null
  configured: boolean
}

export type EffectiveBackupSettings = {
  schedule: string
  retentionCount: number
  storageType: 'filesystem' | 's3' | null
}

export type EffectiveNotificationSettings = {
  defaultSlackWebhook: string | null
}

export type EffectiveInstancePolicy = {
  maxOrgs: number
  maxUsersPerOrg: number
  sessionIdleTimeoutMinutes: number
}

export type SystemSettingsResponse = {
  smtp: EffectiveSmtpSettings
  backup: EffectiveBackupSettings
  notifications: EffectiveNotificationSettings
  instancePolicy: EffectiveInstancePolicy
}

export type SystemSettingsUpdate = {
  smtp?: {
    host?: string
    port?: number
    secure?: boolean
    user?: string
    from?: string
    password?: string
  }
  backup?: {
    scheduleOverride?: string
    retentionCountOverride?: number
  }
  notifications?: {
    defaultSlackWebhookUrl?: string
  }
  instancePolicy?: {
    maxOrgs?: number
    maxUsersPerOrg?: number
    sessionIdleTimeoutMinutes?: number
  }
}

// Orgs (unwrapped — no `data` key)
export type OrgListItem = {
  id: string
  name: string
  slug: string
  createdAt: string
  memberCount: number
}

export type OrgListResponse = {
  items: OrgListItem[]
}

export type CreateOrgRequest = {
  name: string
  ownerEmail: string
}

export type CreateOrgResponse = {
  id: string
  name: string
  slug: string
  ownerAccountAction: 'existing_user_added' | 'invited_new_user'
  ownerUserId: string
}

// Story 22.3 AC-1: per-org audit-storage row + resource-usage additive fields.
export type OrgAuditState = 'unlimited' | 'ok' | 'warning' | 'critical' | 'blocked' | 'stale'

export type AuditStorageOrgRow = {
  orgId: string
  orgName: string
  bytesUsed: number
  preauthBytesUsed: number
  quotaBytes: number | null
  utilizationPct: number | null
  refusedWriteCount: number
  lastRefusalAt: string | null
  lastReconciledAt: string | null
  writeRatePerMinute: number | null
  rateWindowCount: number
  rateRefusedCount: number
  state: OrgAuditState
}

// Resource usage (unwrapped — no `data` key)
export type ResourceUsageResponse = {
  orgs: { current: number; limit: number | null }
  usersPerOrg: Array<{ orgId: string; current: number; limit: number | null }>
  secretsPerProject: Array<{ projectId: string; orgId: string; current: number }>
  auditLogEntries: { current: number; limit: number | null }
  storageBytes: { current: number; limit: number | null }
  auditLogStorage: { currentBytes: number; limitBytes: number; utilizationPct: number }
  auditStorageByOrg: AuditStorageOrgRow[]
  truncated: boolean
  allocatedLogicalBytes: number
  estimatedPhysicalBytes: number
  allocationIncludesUnlimitedOrgs: boolean
  observedPhysicalToLogicalRatio: number | null
}

export type SetOrgAuditQuotaRequest = {
  quotaBytes?: number | null
  writeRatePerMinute?: number | null
  acknowledgeOvercommit?: boolean
}

// Maintenance mode status (wrapped in `data`)
export type MaintenanceModeStatus = {
  active: boolean
  reason: string | null
  activatedAt: string | null
  deactivatedAt: string | null
  pendingEntriesCount: number
}

// Platform audit events (wrapped in `data`)
export type PlatformAuditEventItem = {
  id: string
  operatorId: string
  actionType: string
  targetOrgId: string | null
  targetUserId: string | null
  payload: Record<string, unknown>
  ipAddress: string | null
  timestamp: string
}

export type PlatformAuditEventsResponse = {
  items: PlatformAuditEventItem[]
  page: number
  limit: number
  total: number
  hasNext: boolean
}

export type PlatformAuditVerifyResult = {
  summary: string
  rowsChecked: number
  passed: number
  failed: Array<{ id: string; actionType: string; timestamp: string }>
  failedCount: number
  failedTruncated: boolean
  verifiedAt: string
}

export type HealthResponse = {
  status: 'ok' | 'error'
  version: string
  // Story 9.10 AC-1/AC-3: distinguishes a real injected release (`RELEASE_VERSION`) from the
  // documented `dev` fallback — optional because older/mocked API responses in tests may omit
  // it; Version & Upgrade must treat a missing value as unknown, never assume "release".
  versionSource?: 'release' | 'development'
  // Story 14.5 Task 1: passthrough field — the backend has returned this since Story 14.2's
  // health.ts, this type was simply never updated to declare it.
  extensions_status?: 'not_configured' | 'loaded' | 'load_failed'
}

export type PlatformAuditFilters = {
  operatorId?: string
  actionType?: string
  targetOrgId?: string
  targetUserId?: string
  from?: string
  to?: string
  page?: number
  limit?: number
}

// ---- Fetch functions -------------------------------------------------------

export async function fetchReady(fetchFn: typeof fetch): Promise<ReadyResponse> {
  try {
    const response = await fetchFn('/ready', { credentials: 'include' })
    const body = (await response.json().catch(() => null)) as ReadyResponse | null
    return body ?? { status: 'ready' }
  } catch {
    return { status: 'ready' }
  }
}

export async function fetchHealth(fetchFn: typeof fetch): Promise<HealthResponse | null> {
  try {
    // The API's liveness endpoint is `/health`, but that literal path is already this app's own
    // (app)/health page route (monitored-services dashboard) — a relative fetch to `/health`
    // resolves against this app's own routes, not the API. Proxied at `/api/health`
    // (apps/web/src/routes/api/health/+server.ts) instead, which has no such collision.
    const response = await fetchFn('/api/health', { credentials: 'include' })
    if (!response.ok) return null
    const body = (await response.json().catch(() => null)) as HealthResponse | null
    return body
  } catch {
    return null
  }
}

// Backup endpoints (all wrapped in `data`)
export function listBackups(fetchFn: typeof fetch) {
  return apiFetch<BackupListResponse>(fetchFn, '/api/v1/admin/backups')
}

export function triggerBackup(fetchFn: typeof fetch) {
  return apiFetch<BackupTriggerResponse>(fetchFn, '/api/v1/admin/backup/trigger', {
    method: 'POST',
  })
}

export function validateBackup(fetchFn: typeof fetch, filename: string) {
  return apiFetch<BackupValidateResponse>(
    fetchFn,
    `/api/v1/admin/backups/${encodeURIComponent(filename)}/validate`,
    { method: 'POST' }
  )
}

export function restoreBackup(
  fetchFn: typeof fetch,
  filename: string,
  body: { confirmRestore: true; reason: string }
) {
  return apiFetch<BackupRestoreResponse>(
    fetchFn,
    `/api/v1/admin/backups/${encodeURIComponent(filename)}/restore`,
    { method: 'POST', body: JSON.stringify(body) }
  )
}

// Settings endpoints (unwrapped)
export function getSettings(fetchFn: typeof fetch) {
  return apiFetch<SystemSettingsResponse>(fetchFn, '/api/v1/admin/settings')
}

export function updateSettings(fetchFn: typeof fetch, update: SystemSettingsUpdate) {
  return apiFetch<SystemSettingsResponse>(fetchFn, '/api/v1/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(update),
  })
}

// Orgs endpoints (unwrapped)
export function listOrgs(fetchFn: typeof fetch) {
  return apiFetch<OrgListResponse>(fetchFn, '/api/v1/admin/orgs')
}

export function createOrg(fetchFn: typeof fetch, request: CreateOrgRequest) {
  return apiFetch<CreateOrgResponse>(fetchFn, '/api/v1/admin/orgs', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

// Resource usage (unwrapped)
export function getResourceUsage(fetchFn: typeof fetch) {
  return apiFetch<ResourceUsageResponse>(fetchFn, '/api/v1/admin/resource-usage')
}

// Story 22.3 AC-3: PUT /admin/orgs/:orgId/audit-quota (unwrapped — returns the fresh row).
export function setOrgAuditQuota(
  fetchFn: typeof fetch,
  orgId: string,
  body: SetOrgAuditQuotaRequest
) {
  return apiFetch<AuditStorageOrgRow>(
    fetchFn,
    `/api/v1/admin/orgs/${encodeURIComponent(orgId)}/audit-quota`,
    { method: 'PUT', body: JSON.stringify(body) }
  )
}

// Story 1.19 AC-5/AC-6: GET /status bearer-token settings (unwrapped, mirrors settings/orgs
// endpoints above).
export type StatusTokenMetadataResponse = {
  configured: boolean
  createdAt?: string
  lastUsedAt?: string
}

export type StatusTokenSecretResponse = {
  token: string
  createdAt: string
}

export type StatusCheckResult = { status: string; reason?: string }

export type StatusTokenTestResponse = {
  status: 'healthy' | 'degraded' | 'unavailable'
  checks: {
    database: StatusCheckResult
    vault: StatusCheckResult
    disk: StatusCheckResult
  }
}

export function getStatusTokenMetadata(fetchFn: typeof fetch) {
  return apiFetch<StatusTokenMetadataResponse>(fetchFn, '/api/v1/admin/settings/status-token')
}

export function generateStatusToken(fetchFn: typeof fetch) {
  return apiFetch<StatusTokenSecretResponse>(
    fetchFn,
    '/api/v1/admin/settings/status-token/generate',
    { method: 'POST' }
  )
}

export function rotateStatusToken(fetchFn: typeof fetch) {
  return apiFetch<StatusTokenSecretResponse>(
    fetchFn,
    '/api/v1/admin/settings/status-token/rotate',
    { method: 'POST' }
  )
}

export function revokeStatusToken(fetchFn: typeof fetch) {
  return apiFetch<undefined>(fetchFn, '/api/v1/admin/settings/status-token/revoke', {
    method: 'POST',
  })
}

export function testStatusToken(fetchFn: typeof fetch) {
  return apiFetch<StatusTokenTestResponse>(fetchFn, '/api/v1/admin/settings/status-token/test', {
    method: 'POST',
  })
}

function buildAuditFilterParams(filters: PlatformAuditFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.operatorId) params.set('operatorId', filters.operatorId)
  if (filters.actionType) params.set('actionType', filters.actionType)
  if (filters.targetOrgId) params.set('targetOrgId', filters.targetOrgId)
  if (filters.targetUserId) params.set('targetUserId', filters.targetUserId)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.page) params.set('page', String(filters.page))
  if (filters.limit) params.set('limit', String(filters.limit))
  return params
}

// Platform audit (wrapped in `data`)
export function listPlatformAuditEvents(fetchFn: typeof fetch, filters: PlatformAuditFilters = {}) {
  const qs = buildAuditFilterParams(filters).toString()
  const querySuffix = qs ? `?${qs}` : ''
  return apiFetch<PlatformAuditEventsResponse>(
    fetchFn,
    `/api/v1/platform/audit/events${querySuffix}`
  )
}

export function verifyPlatformAuditIntegrity(
  fetchFn: typeof fetch,
  range: { from: string; to: string }
) {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  return apiFetch<PlatformAuditVerifyResult>(
    fetchFn,
    `/api/v1/platform/audit/verify?${params.toString()}`
  )
}

// Maintenance mode (wrapped in `data`)
export function getMaintenanceModeStatus(fetchFn: typeof fetch) {
  return apiFetch<MaintenanceModeStatus>(fetchFn, '/api/v1/platform/maintenance-mode')
}

export function postMaintenanceMode(
  fetchFn: typeof fetch,
  body: { action?: 'activate' | 'deactivate'; reason?: string }
) {
  return apiFetch<{
    active: boolean
    activatedAt?: string
    deactivatedAt?: string
    reason?: string
  }>(fetchFn, '/api/v1/platform/maintenance-mode', { method: 'POST', body: JSON.stringify(body) })
}

// Probe whether API docs are enabled (D5) — returns true if /api/v1/openapi.json responds 200
export async function probeApiDocsEnabled(fetchFn: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchFn('/api/v1/openapi.json', { credentials: 'include' })
    return response.ok
  } catch {
    return false
  }
}
