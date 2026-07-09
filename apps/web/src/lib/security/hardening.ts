export function safeRedirectPath(value: string | null | undefined, fallback = '/dashboard') {
  if (!value) return fallback
  if (!value.startsWith('/') || value.startsWith('//')) return fallback
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return fallback
  return value
}

export function getLoginReasonMessage(reason: string | null | undefined) {
  switch (reason) {
    case 'registered':
      return 'Account created. Sign in to continue.'
    case 'session-expired':
      return 'Your session ended. Sign in again to continue.'
    case 'logged-out':
      return 'You have signed out.'
    case 'recovery-complete':
      return 'Your password has been reset. Sign in with your new password.'
    default:
      return 'Sign in to continue.'
  }
}

export function getTrustedApiBase(env: { API_BASE_URL?: string }, _ignoredRequestInput?: string) {
  return env.API_BASE_URL?.trim() ?? ''
}

export function getFrameProtectionHeaders() {
  return {
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  }
}
