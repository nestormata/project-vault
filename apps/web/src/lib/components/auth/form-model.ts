import type {
  AuthSessionResponse,
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
