import { apiFetch } from './client.js'

export type ProjectRole = 'owner' | 'admin' | 'member' | 'viewer'
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'
export type SettableProjectRole = 'admin' | 'member' | 'viewer'

export type OrgUserProject = {
  projectId: string
  projectName: string
  role: ProjectRole
}

export type OrgUserStatus = 'active' | 'deactivated'

export type OrgUser = {
  userId: string
  email: string
  displayName: string
  orgRole: OrgRole
  status: OrgUserStatus
  projects: OrgUserProject[]
}

// Story 43-15 AC-8/AC-9: how many of the user's unfinished rotations `rotationHandling: "abandon"`
// abandoned (staged/stale) and held (promoted, left for a later retire). Both 0 without it.
// Story 43-17 AC-4/AC-10: with `transfer`, how many rotations moved and to whom (absent otherwise).
export type RotationHandlingCounts = {
  abandonedRotationCount: number
  heldRotationCount: number
  transferredRotationCount?: number
  transferredToUserId?: string
}

/** Story 43-15 AC-8: absent keeps the default `409 active_rotations` block. Story 43-17 KD-3:
 *  `transfer` hands every unfinished rotation to one active admin (`transferToUserId` required). */
export type RotationHandlingOptions =
  { rotationHandling: 'abandon' } | { rotationHandling: 'transfer'; transferToUserId: string }

export type DeactivateOrgUserResult = {
  userId: string
  revokedSessionCount: number
  revokedInvitationCount: number
} & RotationHandlingCounts

export type SendRecoveryLinkResult = {
  userId: string
  linkSent: boolean
}

export type ProjectMember = {
  userId: string
  email: string
  displayName: string
  role: ProjectRole
}

function jsonBody(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
}

export function listOrgUsers(fetchFn: typeof fetch) {
  return apiFetch<OrgUser[]>(fetchFn, '/api/v1/org/users')
}

/** Story 43-15 AC-9: pass `{ rotationHandling: 'abandon' }` to resolve a `409 active_rotations`
 *  block (same body as deactivateOrgUser); absent sends no body, as before. */
export function removeOrgUser(
  fetchFn: typeof fetch,
  userId: string,
  options?: RotationHandlingOptions
) {
  return apiFetch<{ userId: string; revokedSessionCount: number } & RotationHandlingCounts>(
    fetchFn,
    `/api/v1/org/users/${userId}`,
    jsonBody('DELETE', options)
  )
}

/** Story 4.3 AC-2: immediate session/invitation revocation, org-scoped, one-way. Story 43-15
 *  AC-8: pass `{ rotationHandling: 'abandon' }` to resolve a `409 active_rotations` block. */
export function deactivateOrgUser(
  fetchFn: typeof fetch,
  userId: string,
  options?: RotationHandlingOptions
) {
  return apiFetch<DeactivateOrgUserResult>(
    fetchFn,
    `/api/v1/org/users/${userId}/deactivate`,
    jsonBody('POST', options)
  )
}

/** Story 4.3 AC-10: admin-mediated recovery link, for a teammate who can't reach /recovery themselves. */
export function sendRecoveryLink(fetchFn: typeof fetch, userId: string) {
  return apiFetch<SendRecoveryLinkResult>(
    fetchFn,
    `/api/v1/org/users/${userId}/recovery/send-link`,
    jsonBody('POST')
  )
}

export function changeProjectRole(
  fetchFn: typeof fetch,
  userId: string,
  projectId: string,
  role: SettableProjectRole
) {
  return apiFetch<{ userId: string; projectId: string; role: ProjectRole }>(
    fetchFn,
    `/api/v1/org/users/${userId}/projects/${projectId}/role`,
    jsonBody('PUT', { role })
  )
}

export function listProjectMembers(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<ProjectMember[]>(fetchFn, `/api/v1/projects/${projectId}/members`)
}

export function removeProjectMember(fetchFn: typeof fetch, projectId: string, userId: string) {
  return apiFetch<undefined>(fetchFn, `/api/v1/projects/${projectId}/members/${userId}`, {
    method: 'DELETE',
  })
}

export function transferOwnership(fetchFn: typeof fetch, projectId: string, newOwnerId: string) {
  return apiFetch<{ projectId: string; previousOwnerId: string; newOwnerId: string }>(
    fetchFn,
    `/api/v1/projects/${projectId}/transfer-ownership`,
    jsonBody('POST', { newOwnerId })
  )
}
