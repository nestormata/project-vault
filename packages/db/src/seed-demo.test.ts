import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from './index.js'
import { orgMemberships, userIdentityTokens, users } from './schema/index.js'
import { ORG_A_ID } from './seed-fixtures.js'
import { DEMO_LOGIN_USER_ID, seed } from './seed-demo.js'

/**
 * DEMO_LOGIN_USER_ID is a fixed constant (unlike a per-test randomUUID()), so its
 * user_identity_tokens row — intentionally created only once, guarded by a NOT EXISTS check
 * (see seed-demo.ts) so real resets don't accumulate duplicates — persists across test runs
 * against a shared DB. Delete it and the user row before/after this test so each run starts
 * from a clean slate and doesn't leave a stale display_name behind for the next run to trip
 * over (real `db:seed:demo` usage never hits this: scripts/fly-reset.sh always drops and
 * recreates the whole schema before reseeding).
 */
async function resetDemoLoginUser(): Promise<void> {
  const db = getDb()
  await db.delete(userIdentityTokens).where(eq(userIdentityTokens.userId, DEMO_LOGIN_USER_ID))
  await db.delete(users).where(eq(users.id, DEMO_LOGIN_USER_ID))
}

describe('seed-demo seed()', () => {
  it('throws when DEMO_LOGIN_EMAIL/DEMO_LOGIN_PASSWORD are unset', async () => {
    const prevEmail = process.env['DEMO_LOGIN_EMAIL']
    const prevPassword = process.env['DEMO_LOGIN_PASSWORD']
    delete process.env['DEMO_LOGIN_EMAIL']
    delete process.env['DEMO_LOGIN_PASSWORD']
    try {
      await expect(seed()).rejects.toThrow(
        'Set DEMO_LOGIN_EMAIL and DEMO_LOGIN_PASSWORD before running db:seed:demo'
      )
    } finally {
      if (prevEmail !== undefined) process.env['DEMO_LOGIN_EMAIL'] = prevEmail
      if (prevPassword !== undefined) process.env['DEMO_LOGIN_PASSWORD'] = prevPassword
    }
  })

  it(
    'seeds a real, login-able demo user with a valid RFC-4122 id, an owner membership in ' +
      "ORG_A_ID, and a user_identity_tokens row (so its login audit entries aren't a null " +
      'actor_token_id gap)',
    async () => {
      const email = `demo-seed-${randomUUID()}@example.com`
      const prevEmail = process.env['DEMO_LOGIN_EMAIL']
      const prevPassword = process.env['DEMO_LOGIN_PASSWORD']
      process.env['DEMO_LOGIN_EMAIL'] = email
      process.env['DEMO_LOGIN_PASSWORD'] = 'demo-seed-test-password-123'

      await resetDemoLoginUser()
      try {
        // Re-running seed() (as db:seed:demo does on every reset) must stay idempotent: no
        // duplicate identity-token rows, no unique-violation on the users upsert.
        await seed()
        await seed()

        const db = getDb()
        const [user] = await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(eq(users.id, DEMO_LOGIN_USER_ID))
        expect(user).toMatchObject({ id: DEMO_LOGIN_USER_ID, email })
        // RFC 4122 version nibble 1-8 — see seed-fixtures.ts's ORG_A_ID comment for why this
        // matters: apps/api's AuthSessionResponseSchema (z.uuid()) rejects anything else.
        expect(DEMO_LOGIN_USER_ID).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        )

        const identityTokens = await db
          .select({ id: userIdentityTokens.id, displayName: userIdentityTokens.displayName })
          .from(userIdentityTokens)
          .where(eq(userIdentityTokens.userId, DEMO_LOGIN_USER_ID))
        expect(identityTokens).toHaveLength(1)
        expect(identityTokens[0]).toMatchObject({ displayName: email })

        const [membership] = await withOrg(ORG_A_ID, (tx) =>
          tx
            .select({ role: orgMemberships.role, status: orgMemberships.status })
            .from(orgMemberships)
            .where(eq(orgMemberships.userId, DEMO_LOGIN_USER_ID))
        )
        expect(membership).toMatchObject({ role: 'owner', status: 'active' })
      } finally {
        await resetDemoLoginUser()
        if (prevEmail !== undefined) process.env['DEMO_LOGIN_EMAIL'] = prevEmail
        else delete process.env['DEMO_LOGIN_EMAIL']
        if (prevPassword !== undefined) process.env['DEMO_LOGIN_PASSWORD'] = prevPassword
        else delete process.env['DEMO_LOGIN_PASSWORD']
      }
    }
  )
})
