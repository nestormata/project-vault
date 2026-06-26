import { describe, expect, it } from 'vitest'
import { refreshTokens, sessions } from './index.js'
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
})
