import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../index.js'
import { mfaEnrollments, users, webauthnCredentials } from '../schema/index.js'
import { USER_1_ID, seedFixtures } from '../seed-fixtures.js'

describe('migration 0114 against seeded rows', () => {
  it('leaves existing users with zero authenticators and unchanged MFA columns', async () => {
    await seedFixtures()
    const db = getDb()
    const [alice] = await db
      .select({
        id: users.id,
        mfaEnrolledAt: users.mfaEnrolledAt,
        email: users.email,
      })
      .from(users)
      .where(eq(users.id, USER_1_ID))
    expect(alice?.email).toBe('alice@example.com')
    const enrolledAt = alice?.mfaEnrolledAt ?? null

    const keys = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, USER_1_ID))
    expect(keys).toEqual([])

    const totp = await db
      .select({ id: mfaEnrollments.id })
      .from(mfaEnrollments)
      .where(eq(mfaEnrollments.userId, USER_1_ID))
    expect(totp).toEqual([])

    const [aliceAgain] = await db
      .select({ mfaEnrolledAt: users.mfaEnrolledAt })
      .from(users)
      .where(eq(users.id, USER_1_ID))
    expect(aliceAgain?.mfaEnrolledAt ?? null).toEqual(enrolledAt)
  })
})
