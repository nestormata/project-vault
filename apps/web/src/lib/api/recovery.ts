import { apiFetch } from './client.js'

export type RecoveryPeek = {
  email: string
  mfaCurrentlyEnrolled: boolean
}

export type RecoveryMfaStart = {
  otpauthUrl: string
  secret: string
  qrCodeSvg: string
}

export type RecoveryCompleteRequest = {
  newPassword: string
  totpCode?: string
}

export type RecoveryCompleteResult = {
  email: string
  sessionsRevoked: number
  mfaReEnrolled: boolean
  recoveryCodes?: string[]
}

function jsonPost(body?: unknown): RequestInit {
  return { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
}

/**
 * AC-9: always resolves with the same generic message regardless of whether the email matched an
 * account — the caller (the recovery request page) must render that message unconditionally
 * rather than branching on response shape, so a future API change can't accidentally leak
 * enumeration info through the UI layer.
 */
export function requestRecovery(fetchFn: typeof fetch, email: string) {
  return apiFetch<{ message: string }>(
    fetchFn,
    '/api/v1/auth/recovery/request',
    jsonPost({ email })
  )
}

export function peekRecovery(fetchFn: typeof fetch, token: string) {
  return apiFetch<RecoveryPeek>(fetchFn, `/api/v1/auth/recovery/${encodeURIComponent(token)}`)
}

export function startRecoveryMfa(fetchFn: typeof fetch, token: string) {
  return apiFetch<RecoveryMfaStart>(
    fetchFn,
    `/api/v1/auth/recovery/${encodeURIComponent(token)}/mfa/start`,
    jsonPost()
  )
}

export function completeRecovery(
  fetchFn: typeof fetch,
  token: string,
  body: RecoveryCompleteRequest
) {
  return apiFetch<RecoveryCompleteResult>(
    fetchFn,
    `/api/v1/auth/recovery/${encodeURIComponent(token)}/complete`,
    jsonPost(body)
  )
}
