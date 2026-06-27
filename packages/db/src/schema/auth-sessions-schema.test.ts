import { describe, expect, it } from 'vitest'
import {
  failedAuthAttempts,
  mfaEnrollments,
  mfaRecoveryCodes,
  refreshTokens,
  revokedTokens,
  sessions,
  totpUsedCodes,
  users,
} from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('auth session schema', () => {
  it('exposes Story 1.6 session and refresh token columns', () => {
    expect(sessions.jti).toBeDefined()
    expect(sessions.revokedAt).toBeDefined()

    expect(refreshTokens.id).toBeDefined()
    expect(refreshTokens.sessionId).toBeDefined()
    expect(refreshTokens.tokenHash).toBeDefined()
    expect(refreshTokens.expiresAt).toBeDefined()
    expect(refreshTokens.usedAt).toBeDefined()
    expect(refreshTokens.newSessionId).toBeDefined()
    expect(refreshTokens.revokedAt).toBeDefined()
    expect(refreshTokens.createdAt).toBeDefined()
  })

  it('documents refresh_tokens as an RLS coverage exception', () => {
    expect(EXCLUDED_TABLES.has('refresh_tokens')).toBe(true)
  })

  it('exposes Story 1.7 revoked token columns and RLS exception', () => {
    expect(revokedTokens.jti).toBeDefined()
    expect(revokedTokens.userId).toBeDefined()
    expect(revokedTokens.revokedAt).toBeDefined()
    expect(revokedTokens.expiresAt).toBeDefined()

    expect(EXCLUDED_TABLES.has('revoked_tokens')).toBe(true)
  })

  it('exposes Story 1.8 MFA enrollment, recovery code, and TOTP replay columns', () => {
    expect(users.mfaEnrolledAt).toBeDefined()

    expect(mfaEnrollments.id).toBeDefined()
    expect(mfaEnrollments.userId).toBeDefined()
    expect(mfaEnrollments.secretEncrypted).toBeDefined()
    expect(mfaEnrollments.status).toBeDefined()
    expect(mfaEnrollments.label).toBeDefined()
    expect(mfaEnrollments.confirmedAt).toBeDefined()

    expect(mfaRecoveryCodes.id).toBeDefined()
    expect(mfaRecoveryCodes.userId).toBeDefined()
    expect(mfaRecoveryCodes.codeHash).toBeDefined()
    expect(mfaRecoveryCodes.usedAt).toBeDefined()

    expect(totpUsedCodes.id).toBeDefined()
    expect(totpUsedCodes.userId).toBeDefined()
    expect(totpUsedCodes.codeHash).toBeDefined()
    expect(totpUsedCodes.windowStart).toBeDefined()
    expect(totpUsedCodes.expiresAt).toBeDefined()
  })

  it('documents Story 1.8 identity-scoped MFA tables as RLS coverage exceptions', () => {
    expect(EXCLUDED_TABLES.has('mfa_enrollments')).toBe(true)
    expect(EXCLUDED_TABLES.has('mfa_recovery_codes')).toBe(true)
    expect(EXCLUDED_TABLES.has('totp_used_codes')).toBe(true)
  })

  it('exposes Story 1.9 failed auth attempt columns and RLS exception', () => {
    expect(failedAuthAttempts.id).toBeDefined()
    expect(failedAuthAttempts.userId).toBeDefined()
    expect(failedAuthAttempts.ipAddress).toBeDefined()
    expect(failedAuthAttempts.attemptedEmail).toBeDefined()
    expect(failedAuthAttempts.reason).toBeDefined()
    expect(failedAuthAttempts.attemptedAt).toBeDefined()

    expect(EXCLUDED_TABLES.has('failed_auth_attempts')).toBe(true)
  })
})
