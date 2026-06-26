import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AuthSessionResponseSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
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
})
