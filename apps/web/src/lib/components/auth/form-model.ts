import type {
  AuthSessionResponse,
  DomainLookupRequest,
  DomainLookupResponse,
  LoginRequest,
  MfaLoginChallenge,
  RegisterRequest,
  VerifyMfaLoginRequest,
} from '$lib/api/auth.js'

export function buildRegisterRequest(fields: RegisterRequest): RegisterRequest {
  return fields.invitationToken
    ? { email: fields.email, password: fields.password, invitationToken: fields.invitationToken }
    : { email: fields.email, password: fields.password, orgName: fields.orgName }
}

export function clearRegisterFields(_fields: RegisterRequest): RegisterRequest {
  return { email: '', password: '', orgName: '' }
}

export function getPostRegisterPath(invitedProject?: { projectId: string }): string {
  return invitedProject ? `/projects/${invitedProject.projectId}` : '/login?reason=registered'
}

export function buildLoginRequest(fields: LoginRequest): LoginRequest {
  return { email: fields.email, password: fields.password }
}

export function clearLoginFields(_fields: LoginRequest): LoginRequest {
  return { email: '', password: '' }
}

export function isMfaChallenge(
  response: AuthSessionResponse | MfaLoginChallenge
): response is MfaLoginChallenge {
  return 'mfaRequired' in response && response.mfaRequired === true
}

export function buildMfaLoginRequest(fields: VerifyMfaLoginRequest): VerifyMfaLoginRequest {
  return { mfaToken: fields.mfaToken, totp: fields.totp }
}

export function clearMfaLoginFields(_fields: VerifyMfaLoginRequest): VerifyMfaLoginRequest {
  return { mfaToken: '', totp: '' }
}

// Story 14.4 Task 3.2/AC-2a: the client sends the raw email exactly as typed — the server (not
// this helper) is the source of truth for domain extraction/validation (Task 2.2), so this never
// attempts to pre-validate or extract a domain client-side.
export function buildDomainLookupRequest(email: string): DomainLookupRequest {
  return { email }
}

// Story 14.4 AC-1: a single, named predicate for "the lookup says this email routes to SSO" —
// used both to decide which step to render and to guard the out-of-order-response race (AC-8).
export function isSsoRequired(
  response: DomainLookupResponse
): response is { ssoRequired: true; providerName: string } {
  return response.ssoRequired === true && typeof response.providerName === 'string'
}
