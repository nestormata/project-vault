import { apiFetch } from './client.js'

export type ProjectRole = 'owner' | 'admin' | 'member' | 'viewer'
export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'
export type SettableProjectRole = 'admin' | 'member' | 'viewer'

export type OrgUserProject = {
  projectId: string
  projectName: string
  role: ProjectRole
}

export type OrgUser = {
  userId: string
  email: string
  displayName: string
  orgRole: OrgRole
  projects: OrgUserProject[]
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

export function removeOrgUser(fetchFn: typeof fetch, userId: string) {
  return apiFetch<{ userId: string; revokedSessionCount: number }>(
    fetchFn,
    `/api/v1/org/users/${userId}`,
    { method: 'DELETE' }
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
