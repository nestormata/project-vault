import { apiFetch } from './client.js'

export type RegisterRequest = {
  email: string
  password: string
  orgName?: string
  invitationToken?: string
}

export type RegisterResponse = {
  userId: string
  orgId: string
  email: string
  orgName: string
  role: 'owner' | 'member'
  invitedProject?: { projectId: string; projectName: string; role: 'admin' | 'member' | 'viewer' }
}

export type LoginRequest = {
  email: string
  password: string
}

// Story 14.4 AC-1/AC-2/AC-9: request/response shapes for the pre-auth email-domain-to-SSO
// lookup. Deliberately never carries an org id/name (AC-9a) — only whether the domain maps to a
// currently-registered SSO strategy, and (if so) which provider.
export type DomainLookupRequest = {
  email: string
}

export type DomainLookupResponse = {
  ssoRequired: boolean
  providerName?: string
}

// Story 14.4 Task 3.5: reuses Story 14.3's existing start/callback contract — no hosted
// external-IdP-redirect mechanism exists yet (see LoginForm.svelte's Dev Notes), so the SSO step
// collects a credential in-page and exchanges it via these two calls.
export type SsoStartResponse = {
  state: string
}

export type SsoCallbackRequest = {
  credential: string
}

export type AuthSessionResponse = {
  userId: string
  orgId: string
  expiresAt: string
}

export type MfaLoginChallenge = {
  mfaRequired: true
  mfaToken: string
}

export type VerifyMfaLoginRequest = {
  mfaToken: string
  totp: string
}

export type AuthUser = {
  userId: string
  orgId: string
  orgName: string
  sessionId: string
  orgRole: 'owner' | 'admin' | 'member' | 'viewer'
  isPlatformOperator: boolean
  mfaEnrolled: boolean
  mfaEnrolledAt: string | null
  remainingRecoveryCodesCount: number | null
  mfaStatus: {
    enrollmentRequired: boolean
    gracePeriodActive: boolean
    gracePeriodExpiresAt: string | null
    gracePeriodDaysRemaining: number | null
    bannerMessage: string | null
  }
}

export type MfaEnrollResponse = {
  enrollmentId: string
  otpauthUrl: string
  secret: string
  qrCodeSvg: string
}

export type MfaTotpRequest = {
  totp: string
}

export type MfaVerifyEnrollmentResponse = {
  mfaEnrolledAt: string
  recoveryCodes: string[]
}

export type MfaRegenerateRecoveryCodesResponse = {
  recoveryCodes: string[]
  generatedAt: string
}

function jsonPost(body?: unknown): RequestInit {
  return {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

export function register(fetchFn: typeof fetch, request: RegisterRequest) {
  return apiFetch<RegisterResponse>(fetchFn, '/api/v1/auth/register', jsonPost(request))
}

export function login(fetchFn: typeof fetch, request: LoginRequest) {
  return apiFetch<AuthSessionResponse | MfaLoginChallenge>(
    fetchFn,
    '/api/v1/auth/login',
    jsonPost(request)
  )
}

export function verifyMfaLogin(fetchFn: typeof fetch, request: VerifyMfaLoginRequest) {
  return apiFetch<AuthSessionResponse>(fetchFn, '/api/v1/auth/mfa/verify-login', jsonPost(request))
}

// Story 14.4 AC-1/AC-2/AC-3/AC-3a: the caller (LoginForm.svelte) is responsible for treating any
// thrown error from this call (non-2xx, parse failure, or a network-level failure) as "no
// mapping" and falling open to the password field — this function itself does not swallow
// errors, so a caller that forgets the catch would fail loudly rather than silently.
export function lookupSsoDomain(fetchFn: typeof fetch, email: string) {
  return apiFetch<DomainLookupResponse>(
    fetchFn,
    '/api/v1/auth/sso/domain-lookup',
    jsonPost({ email } satisfies DomainLookupRequest)
  )
}

export function ssoStart(fetchFn: typeof fetch, providerName: string) {
  return apiFetch<SsoStartResponse>(
    fetchFn,
    `/api/v1/auth/sso/start/${encodeURIComponent(providerName)}`,
    jsonPost()
  )
}

export function ssoCallback(
  fetchFn: typeof fetch,
  providerName: string,
  request: SsoCallbackRequest
) {
  return apiFetch<AuthSessionResponse | MfaLoginChallenge>(
    fetchFn,
    `/api/v1/auth/sso/callback/${encodeURIComponent(providerName)}`,
    jsonPost(request)
  )
}

export function enrollMfa(fetchFn: typeof fetch) {
  return apiFetch<MfaEnrollResponse>(fetchFn, '/api/v1/auth/mfa/enroll', jsonPost())
}

export function verifyMfaEnrollment(fetchFn: typeof fetch, request: MfaTotpRequest) {
  return apiFetch<MfaVerifyEnrollmentResponse>(
    fetchFn,
    '/api/v1/auth/mfa/verify-enrollment',
    jsonPost(request)
  )
}

export function regenerateMfaRecoveryCodes(fetchFn: typeof fetch, request: MfaTotpRequest) {
  return apiFetch<MfaRegenerateRecoveryCodesResponse>(
    fetchFn,
    '/api/v1/auth/mfa/regenerate-recovery-codes',
    jsonPost(request)
  )
}

export function getCurrentUser(fetchFn: typeof fetch) {
  return apiFetch<AuthUser>(fetchFn, '/api/v1/auth/me')
}

export function refreshSession(fetchFn: typeof fetch) {
  return apiFetch<{ expiresAt: string }>(fetchFn, '/api/v1/auth/refresh', jsonPost())
}

export function logout(fetchFn: typeof fetch) {
  return apiFetch<undefined>(fetchFn, '/api/v1/auth/logout', jsonPost()).then(() => undefined)
}
