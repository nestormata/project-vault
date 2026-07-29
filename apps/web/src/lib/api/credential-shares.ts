import { apiFetch } from './client.js'

export type CredentialShareStatus = 'active' | 'viewed' | 'revoked' | 'expired' | 'superseded'

export type CredentialShareSummary = {
  id: string
  credentialId: string
  fieldKey: string | null
  sharedBy: string
  recipientType: 'user' | 'external'
  recipientUserId: string | null
  recipientEmail: string | null
  singleUse: boolean
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  firstViewedAt: string | null
  viewCount: number
  status: CredentialShareStatus
}

export type CreatedCredentialShare = CredentialShareSummary & { token: string }

export type CreateCredentialShareRequest = {
  recipientUserId: string
  fieldKey?: string
  expiresAt: string
  singleUse?: boolean
}

export type ShareMetadata = {
  credentialId: string
  credentialName: string
  sharedBy: string
  sharedByEmail: string | null
  fieldKey: string | null
  expiresAt: string
  singleUse: boolean
  status: CredentialShareStatus
}

export type ShareRevealResult = {
  credentialId: string
  fieldKey: string | null
  value: string
  viewedAt: string
}

function shareUrl(projectId: string, credentialId: string, suffix = ''): string {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/shares${suffix}`
}

// Story 17.1 AC-11: shares the current user created for a credential.
export function listCredentialShares(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string
) {
  return apiFetch<{ items: CredentialShareSummary[] }>(fetchFn, shareUrl(projectId, credentialId))
}

// Story 17.1 AC-1/AC-4: creates a share; the returned `token` is shown to the sharer exactly once.
export function createCredentialShare(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  body: CreateCredentialShareRequest
) {
  return apiFetch<CreatedCredentialShare>(fetchFn, shareUrl(projectId, credentialId), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// Story 17.1 AC-5: idempotent — revoking an already-terminal share returns its current state.
export function revokeCredentialShare(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  shareId: string
) {
  return apiFetch<CredentialShareSummary>(
    fetchFn,
    shareUrl(projectId, credentialId, `/${shareId}/revoke`),
    { method: 'POST' }
  )
}

// Story 17.1 AC-7/AC-8: recipient-facing access routes, addressed by the opaque bearer token
// (never the share id) — deliberately not project/credential-scoped in the URL.
export function getShareMetadata(fetchFn: typeof fetch, token: string) {
  return apiFetch<ShareMetadata>(fetchFn, `/api/v1/shares/access/${token}`)
}

export function revealCredentialShare(fetchFn: typeof fetch, token: string) {
  return apiFetch<ShareRevealResult>(fetchFn, `/api/v1/shares/access/${token}/reveal`, {
    method: 'POST',
  })
}

// Story 17.2 AC-1/AC-3/AC-5: external-recipient share creation — recipientEmail replaces
// recipientUserId, singleUse is never sent (hard-coded server-side), and a step-up factor
// (password xor totpCode) is required.
export type CreateExternalCredentialShareRequest = {
  recipientEmail: string
  fieldKey?: string
  expiresAt: string
  password?: string
  totpCode?: string
}

function externalShareUrl(projectId: string, credentialId: string): string {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/external-shares`
}

export function createExternalCredentialShare(
  fetchFn: typeof fetch,
  projectId: string,
  credentialId: string,
  body: CreateExternalCredentialShareRequest
) {
  return apiFetch<CreatedCredentialShare>(fetchFn, externalShareUrl(projectId, credentialId), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// Story 17.2 AC-9: metadata for the public, unauthenticated consent page — no sharedByEmail (the
// external API never returns it), a display name instead.
export type ExternalShareMetadata = {
  credentialId: string
  credentialName: string
  sharedByDisplayName: string
  fieldKey: string | null
  expiresAt: string
  status: CredentialShareStatus
}

export function getExternalShareMetadata(fetchFn: typeof fetch, token: string) {
  return apiFetch<ExternalShareMetadata>(fetchFn, `/api/v1/external-shares/access/${token}`)
}

export function revealExternalCredentialShare(fetchFn: typeof fetch, token: string) {
  return apiFetch<ShareRevealResult>(fetchFn, `/api/v1/external-shares/access/${token}/reveal`, {
    method: 'POST',
  })
}
