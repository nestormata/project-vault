export const SecurityAlertType = {
  FAILED_AUTH_THRESHOLD: 'security.failed_auth_threshold',
} as const

export type SecurityAlertType = (typeof SecurityAlertType)[keyof typeof SecurityAlertType]
