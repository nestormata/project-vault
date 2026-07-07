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
  sessionId: string
  orgRole: 'owner' | 'admin' | 'member' | 'viewer'
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
