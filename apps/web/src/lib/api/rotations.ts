import type {
  RotationChecklistItem,
  RotationChecklistItemStatus,
  RotationDetail,
  RotationSummary,
  RotationStatus,
  UpcomingRotation,
} from '@project-vault/shared'
import { apiFetch } from './client.js'

export type InitiateRotationRequest = {
  newValue: string
  notes?: string | null
}

export type ListRotationsQuery = {
  page?: number
  limit?: number
}

export type ListRotationsResponse = {
  items: RotationSummary[]
  page: number
  limit: number
  total: number
  hasMore: boolean
}

export type ConfirmChecklistItemRequest = {
  notes?: string | null
}

export type FailChecklistItemRequest = {
  reason: string
  retryScheduledAt?: string | null
}

export type ChecklistItemMutationResponse = {
  item: RotationChecklistItem
  rotationVersion: number
}

export type CompleteRotationRequest = {
  acknowledgedNoDependencies?: boolean
}

export type BreakGlassRotationRequest = {
  newValue: string
  reason: string
}

export type ListUpcomingRotationsQuery = {
  horizon?: '7d' | '30d' | '90d'
}

export type ListUpcomingRotationsResponse = {
  items: UpcomingRotation[]
}

// AC-5: the 409 body for a concurrent initiate carries `rotationId` so the UI can link straight
// to the rotation that won the race, matching RotationConflictResponseSchema (routes.ts).
export type RotationInProgressErrorBody = {
  code: 'rotation_in_progress'
  message: string
  rotationId: string | null
}

// AC-8: idempotent-confirm evidence for a 409 already_confirmed.
export type AlreadyConfirmedErrorBody = {
  code: 'already_confirmed'
  message: string
  confirmedBy: string | null
  confirmedAt: string | null
}

// AC-10: the retry call that pushed the item past the cap.
export type MaxRetriesExceededErrorBody = {
  code: 'max_retries_exceeded'
  message: string
  retryCount: number
  maxRetries: number
}

// AC-12: complete blocked by unconfirmed checklist items.
export type ChecklistIncompleteErrorBody = {
  code: 'checklist_incomplete'
  message: string
  pendingItems: { id: string; systemName: string; status: RotationChecklistItemStatus }[]
}

// AC-13: complete blocked because the zero-dependency acknowledgement flag was missing.
export type AcknowledgementRequiredErrorBody = {
  code: 'acknowledgement_required'
  message: string
  checklistItemCount: 0
}

// AC-15: CAS/advisory-lock backstop on confirm/fail/retry/complete/resume/abandon.
export type ConcurrentModificationErrorBody = {
  code: 'concurrent_modification'
  message: string
  currentVersion: number
}

// AC-17: resume/abandon called against a rotation that is no longer stale_recovery.
export type RotationNotStaleErrorBody = {
  code: 'rotation_not_stale'
  message: string
  status: RotationStatus
}

// AC-21: two rotation-affecting calls raced for the same credential's advisory lock.
export type RotationLockContentionErrorBody = {
  code: 'rotation_lock_contention'
  message: string
  credentialId: string
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const serialized = search.toString()
  return serialized ? `?${serialized}` : ''
}

export function initiateRotation(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  body: InitiateRotationRequest
) {
  return apiFetch<RotationDetail>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations`,
    { method: 'POST', body: JSON.stringify(body) }
  )
}

export function getRotation(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  rotationId: string
) {
  return apiFetch<RotationDetail>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}`
  )
}

export function listRotations(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  query: ListRotationsQuery = {}
) {
  return apiFetch<ListRotationsResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations${buildQuery(query)}`
  )
}

export function confirmChecklistItem(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  rotationId: string,
  itemId: string,
  body: ConfirmChecklistItemRequest = {}
) {
  return apiFetch<ChecklistItemMutationResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/checklist/${itemId}/confirm`,
    { method: 'POST', body: JSON.stringify(body) }
  )
}

export function failChecklistItem(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  rotationId: string,
  itemId: string,
  body: FailChecklistItemRequest
) {
  return apiFetch<ChecklistItemMutationResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/checklist/${itemId}/fail`,
    { method: 'POST', body: JSON.stringify(body) }
  )
}

export function retryChecklistItem(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  rotationId: string,
  itemId: string
) {
  return apiFetch<ChecklistItemMutationResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/checklist/${itemId}/retry`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export function completeRotation(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  rotationId: string,
  body: CompleteRotationRequest = {}
) {
  return apiFetch<RotationDetail>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/complete`,
    { method: 'POST', body: JSON.stringify(body) }
  )
}

export function breakGlassRotation(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  body: BreakGlassRotationRequest
) {
  return apiFetch<RotationDetail>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/break-glass`,
    { method: 'POST', body: JSON.stringify(body) }
  )
}

export function resumeRotation(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  rotationId: string
) {
  return apiFetch<RotationDetail>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/resume`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export function abandonRotation(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  rotationId: string
) {
  return apiFetch<RotationDetail>(
    fetchFn,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/abandon`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export function listUpcomingRotations(
  fetchFn: typeof fetch,
  projectId: string,
  query: ListUpcomingRotationsQuery = {}
) {
  return apiFetch<ListUpcomingRotationsResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}/rotations/upcoming${buildQuery(query)}`
  )
}
