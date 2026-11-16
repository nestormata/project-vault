export const SecurityAlertType = {
  FAILED_AUTH_THRESHOLD: 'security.failed_auth_threshold',
  WEBAUTHN_CLONED_AUTHENTICATOR: 'webauthn.cloned_authenticator',
} as const

export type SecurityAlertType = (typeof SecurityAlertType)[keyof typeof SecurityAlertType]
