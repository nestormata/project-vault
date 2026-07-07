import type {
  ApiKeyIssued,
  ApiKeyMetadata,
  MachineUserDetail,
  MachineUserRole,
  MachineUserSummary,
} from '@project-vault/shared'
import { apiFetch } from './client.js'

export type CreateMachineUserRequest = {
  name: string
  role: MachineUserRole
  description?: string | null
}

export type ListMachineUsersResponse = {
  items: MachineUserSummary[]
  total: number
}

export type IssueApiKeyRequest = {
  name: string
  expiresAt?: string
}

export type ListApiKeysResponse = {
  items: ApiKeyMetadata[]
  total: number
}

export type RevokeApiKeyResponse = {
  id: string
  revokedAt: string
}

export type RotateApiKeyResponse = {
  newKeyId: string
  key: string
  oldKeyId: string
  overlapExpiresAt: string
}

export type EmergencyRevokeApiKeyResponse = {
  revokedKeyId: string
  newKey: string
  newKeyId: string
}

export type DeactivateMachineUserResponse = {
  id: string
  deactivatedAt: string
}

export function listMachineUsers(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<ListMachineUsersResponse>(fetchFn, `/api/v1/projects/${projectId}/machine-users`)
}

export function createMachineUser(
  fetchFn: typeof fetch,
  projectId: string,
  body: CreateMachineUserRequest
) {
  return apiFetch<MachineUserDetail>(fetchFn, `/api/v1/projects/${projectId}/machine-users`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function getMachineUser(fetchFn: typeof fetch, machineUserId: string) {
  return apiFetch<MachineUserDetail>(fetchFn, `/api/v1/machine-users/${machineUserId}`)
}

export function issueApiKey(
  fetchFn: typeof fetch,
  machineUserId: string,
  body: IssueApiKeyRequest
) {
  return apiFetch<ApiKeyIssued>(fetchFn, `/api/v1/machine-users/${machineUserId}/api-keys`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listApiKeys(fetchFn: typeof fetch, machineUserId: string) {
  return apiFetch<ListApiKeysResponse>(fetchFn, `/api/v1/machine-users/${machineUserId}/api-keys`)
}

export function revokeApiKey(fetchFn: typeof fetch, machineUserId: string, keyId: string) {
  return apiFetch<RevokeApiKeyResponse>(
    fetchFn,
    `/api/v1/machine-users/${machineUserId}/api-keys/${keyId}`,
    { method: 'DELETE' }
  )
}

export function rotateApiKey(
  fetchFn: typeof fetch,
  machineUserId: string,
  keyId: string,
  overlapMinutes: number
) {
  return apiFetch<RotateApiKeyResponse>(
    fetchFn,
    `/api/v1/machine-users/${machineUserId}/api-keys/${keyId}/rotate`,
    { method: 'POST', body: JSON.stringify({ overlapMinutes }) }
  )
}

export function emergencyRevokeApiKey(fetchFn: typeof fetch, machineUserId: string, keyId: string) {
  return apiFetch<EmergencyRevokeApiKeyResponse>(
    fetchFn,
    `/api/v1/machine-users/${machineUserId}/api-keys/${keyId}/emergency-revoke`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export function deactivateMachineUser(fetchFn: typeof fetch, machineUserId: string) {
  return apiFetch<DeactivateMachineUserResponse>(
    fetchFn,
    `/api/v1/machine-users/${machineUserId}/deactivate`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export function extendKeyDormancy(
  fetchFn: typeof fetch,
  machineUserId: string,
  keyId: string,
  days: number
) {
  return apiFetch<{ keyId: string; dormancySnoozedUntil: string }>(
    fetchFn,
    `/api/v1/machine-users/${machineUserId}/api-keys/${keyId}/extend-dormancy`,
    { method: 'POST', body: JSON.stringify({ days }) }
  )
}
