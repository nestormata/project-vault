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

describe('auth schemas', () => {
  it('validates register and login request contracts', () => {
    expect(
      RegisterRequestSchema.safeParse({
        email: OWNER_EMAIL,
        password: 'correct-horse-battery-staple',
        orgName: 'Acme Corp',
      }).success
    ).toBe(true)
    expect(LoginRequestSchema.safeParse({ email: OWNER_EMAIL, password: 'x' }).success).toBe(true)
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
