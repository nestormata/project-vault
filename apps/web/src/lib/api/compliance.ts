import { apiFetch } from './client.js'

// --- Erasure request creation & PII inventory (AC group K) ------------------------------------

export type PiiInventoryTable = { table: string; rowCount: number; piiFields: string[] }
export type PiiInventory = { tables: PiiInventoryTable[] }

export type CreateErasureRequestResult = {
  requestId: string
  status: 'pending'
  piiInventory: PiiInventory
}

export function createErasureRequest(
  fetchFn: typeof fetch,
  userId: string,
  body: { reason: string; requestedBy: string }
) {
  return apiFetch<CreateErasureRequestResult>(
    fetchFn,
    `/api/v1/org/users/${userId}/erasure-request`,
    { method: 'POST', body: JSON.stringify(body) }
  )
}

// --- Erasure execution (AC group L) ------------------------------------------------------------

export type ExecuteErasureResult = {
  requestId: string
  status: 'completed'
  completedAt: string
  revokedSessionCount: number
  auditEventId: string | null
}

export function executeErasure(fetchFn: typeof fetch, userId: string, requestId: string) {
  return apiFetch<ExecuteErasureResult>(
    fetchFn,
    `/api/v1/org/users/${userId}/erasure-request/${requestId}/execute`,
    // D5 — the typed-email confirmation gate is UI-only; the actual submitted body is always
    // exactly `{ confirm: true }`, matching the server's real contract.
    { method: 'POST', body: JSON.stringify({ confirm: true }) }
  )
}

// --- Erasure compliance report (AC group M) ---------------------------------------------------

export type PiiRemovedEntry = { table: string; fields: string[]; method: string }
export type PiiRetainedEntry = { table: string; reason: string }

export type ErasureReport = {
  requestId: string
  executedAt: string
  piiRemoved: PiiRemovedEntry[]
  piiRetained: PiiRetainedEntry[]
  retentionJustification: string
  auditEventId: string | null
}

// D6 — this is also used as the "current erasure request status" probe: a `409
// erasure_not_yet_completed { status }` or `404` is a normal, expected outcome, not just an
// error to swallow — callers inspect `ApiClientError.status`/`.code`/`.body` to branch.
export function getErasureReport(fetchFn: typeof fetch, userId: string, requestId: string) {
  return apiFetch<ErasureReport>(
    fetchFn,
    `/api/v1/org/users/${userId}/erasure-request/${requestId}/report`
  )
}

// --- Pseudonymize (AC group J) ------------------------------------------------------------------

export type PseudonymizeResult = {
  userId: string
  pseudonymized: true
  pseudonymizedAt: string
  alias: string
  otherAffectedOrgCount: number
}

// D4 — `confirmUserId` is always populated automatically from the already-known target `userId`,
// never typed by the caller (the UI-layer typed-email confirmation gates a *different*,
// client-side-only comparison — see `TypedConfirmInput.svelte`).
export function pseudonymizeUser(fetchFn: typeof fetch, userId: string) {
  return apiFetch<PseudonymizeResult>(fetchFn, `/api/v1/org/users/${userId}/pseudonymize`, {
    method: 'POST',
    body: JSON.stringify({ confirmUserId: userId }),
  })
}
