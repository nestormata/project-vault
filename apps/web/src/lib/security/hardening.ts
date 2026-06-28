const loginReasonMessages: Record<string, string> = {
  registered: 'Account created. Sign in to continue.',
  'session-expired': 'Your session ended. Sign in again to continue.',
  'logged-out': 'You have signed out.',
}

export function safeRedirectPath(value: string | null | undefined, fallback = '/dashboard') {
  if (!value) return fallback
  if (!value.startsWith('/') || value.startsWith('//')) return fallback
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return fallback
  return value
}

export function getLoginReasonMessage(reason: string | null | undefined) {
  if (!reason) return 'Sign in to continue.'
  return loginReasonMessages[reason] ?? 'Sign in to continue.'
}

export function getTrustedApiBase(
  env: { API_BASE_URL?: string | undefined },
  _ignoredRequestInput?: string
) {
  return env.API_BASE_URL?.trim() ?? ''
}

export function getFrameProtectionHeaders() {
  return {
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  }
}
