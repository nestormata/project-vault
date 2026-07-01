import { apiFetch } from './client.js'

export type InvitationRole = 'admin' | 'member' | 'viewer'

export type ProjectInvitation = {
  id: string
  email: string
  roleToAssign: InvitationRole
  invitedBy: string
  expiresAt: string
}

export type CreateInvitationRequest = {
  email: string
  role: InvitationRole
}

export type InvitationPeek = {
  email: string
  projectName: string
  role: InvitationRole
  accountExists: boolean
}

export type InvitationAcceptResult = {
  projectId: string
  projectName: string
  role: InvitationRole
}

function jsonPost(body?: unknown): RequestInit {
  return { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
}

export function createInvitation(
  fetchFn: typeof fetch,
  projectId: string,
  body: CreateInvitationRequest
) {
  return apiFetch<ProjectInvitation>(
    fetchFn,
    `/api/v1/projects/${projectId}/invitations`,
    jsonPost(body)
  )
}

export function listInvitations(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<ProjectInvitation[]>(fetchFn, `/api/v1/projects/${projectId}/invitations`)
}

export function revokeInvitation(fetchFn: typeof fetch, projectId: string, id: string) {
  return apiFetch<undefined>(fetchFn, `/api/v1/projects/${projectId}/invitations/${id}`, {
    method: 'DELETE',
  })
}

export function peekInvitation(fetchFn: typeof fetch, token: string) {
  return apiFetch<InvitationPeek>(fetchFn, `/api/v1/invitations/${encodeURIComponent(token)}`)
}

export function acceptInvitation(fetchFn: typeof fetch, token: string) {
  return apiFetch<InvitationAcceptResult>(
    fetchFn,
    `/api/v1/invitations/${encodeURIComponent(token)}/accept`,
    jsonPost()
  )
}
