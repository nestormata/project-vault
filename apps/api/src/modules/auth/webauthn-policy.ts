export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

export type SignCountDecision = { kind: 'accept'; next: number } | { kind: 'cloned' }

export const WEBAUTHN_NAME_MAX_LENGTH = 64
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000

export const WEBAUTHN_REQUIRES_TOTP_MESSAGE =
  'Hardware security keys become available once TOTP is enrolled.'

export const LAST_SECOND_FACTOR_REQUIRED_MESSAGE =
  'Cannot remove the last remaining second factor while Owner and Admin MFA is required.'

export function decideSignCount(stored: number, observed: number): SignCountDecision {
  if (stored === 0 && observed === 0) return { kind: 'accept', next: 0 }
  if (observed > stored) return { kind: 'accept', next: observed }
  return { kind: 'cloned' }
}

export function lastFactorRemovalBlocked(args: {
  orgRole: OrgRole
  remainingAfterDelete: number
}): { blocked: true; message: string } | { blocked: false } {
  if (args.remainingAfterDelete > 0) return { blocked: false }
  if (args.orgRole !== 'owner' && args.orgRole !== 'admin') return { blocked: false }
  return { blocked: true, message: LAST_SECOND_FACTOR_REQUIRED_MESSAGE }
}

export function parseAuthenticatorName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (name.length < 1 || name.length > WEBAUTHN_NAME_MAX_LENGTH) return null
  return name
}

export function relyingPartyFromCors(corsAllowedOrigins: string): { rpID: string; origin: string } {
  const first = corsAllowedOrigins.split(',')[0]?.trim() ?? ''
  const url = new URL(first)
  return { rpID: url.hostname, origin: url.origin }
}
