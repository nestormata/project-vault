import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AdminRevokeSessionsResponseSchema,
  AuthSessionResponseSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  RevokeSessionsResponseSchema,
  SessionListResponseSchema,
} from './auth.js'

const OWNER_EMAIL = 'owner@example.com'
const PASSWORD = 'correct-horse-battery-staple'

describe('auth schemas', () => {
  it('validates register and login request contracts', () => {
    expect(
      RegisterRequestSchema.safeParse({
        email: OWNER_EMAIL,
        password: PASSWORD,
        orgName: 'Acme Corp',
      }).success
    ).toBe(true)
    expect(LoginRequestSchema.safeParse({ email: OWNER_EMAIL, password: 'x' }).success).toBe(true)
  })

  it('validates register request contracts for invitation-based joins (Story 4.1 D4)', () => {
    expect(
      RegisterRequestSchema.safeParse({
        email: OWNER_EMAIL,
        password: PASSWORD,
        invitationToken: 'opaque-token',
      }).success
    ).toBe(true)
    expect(
      RegisterRequestSchema.safeParse({
        email: OWNER_EMAIL,
        password: PASSWORD,
      }).success
    ).toBe(false)
  })

  it('rejects a length-padded-but-trivially-guessable password on PasswordSchema/RegisterRequestSchema (Story 1.21 AC-1)', () => {
    // passwordpassword passes the >=12 length floor but is the finding's concrete example of a
    // weak password the length-only check previously accepted.
    const weakResult = RegisterRequestSchema.safeParse({
      email: OWNER_EMAIL,
      password: 'passwordpassword',
      orgName: 'Acme Corp',
    })
    expect(weakResult.success).toBe(false)
    if (!weakResult.success) {
      expect(weakResult.error.issues.some((issue) => issue.message === 'password_too_weak')).toBe(
        true
      )
    }
  })

  it('does not apply the strength check to LoginRequestSchema.password (verifies an existing credential, not a new one)', () => {
    // LoginRequestSchema must stay a bare length bound — a user with an already-set weak
    // password must still be able to log in (Story 1.21 Background/Dev Notes).
    expect(
      LoginRequestSchema.safeParse({ email: OWNER_EMAIL, password: 'passwordpassword' }).success
    ).toBe(true)
  })

  it('validates auth response contracts', () => {
    const ids = {
      userId: randomUUID(),
      orgId: randomUUID(),
    }

    expect(
      AuthSessionResponseSchema.safeParse({ ...ids, expiresAt: '2026-06-24T12:05:00.000Z' }).success
    ).toBe(true)
    expect(
      RegisterResponseSchema.safeParse({
        ...ids,
        email: OWNER_EMAIL,
        orgName: 'Acme Corp',
        role: 'owner',
      }).success
    ).toBe(true)
    expect(
      RegisterResponseSchema.safeParse({
        ...ids,
        email: OWNER_EMAIL,
        orgName: 'Acme Corp',
        role: 'member',
        invitedProject: { projectId: randomUUID(), projectName: 'Payments API', role: 'admin' },
      }).success
    ).toBe(true)
  })

  it('validates session management response contracts', () => {
    const sessionId = randomUUID()
    const userId = randomUUID()

    expect(
      SessionListResponseSchema.safeParse([
        {
          sessionId,
          createdAt: '2026-06-24T12:00:00.000Z',
          lastActiveAt: '2026-06-24T12:05:00.000Z',
          ipAddress: '203.0.113.10',
          userAgent: 'vitest',
          isCurrent: true,
        },
      ]).success
    ).toBe(true)
    expect(RevokeSessionsResponseSchema.safeParse({ revokedCount: 0 }).success).toBe(true)
    expect(AdminRevokeSessionsResponseSchema.safeParse({ revokedCount: 2, userId }).success).toBe(
      true
    )
  })
})
