import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, withOrg } from './index.js'
import { organizations, orgMemberships, users } from './schema/index.js'
import { ORG_A_ID, ORG_B_ID, USER_1_ID, USER_2_ID, seedFixtures } from './seed-fixtures.js'

// Story fix/login-response-schema-mismatch: ORG_A_ID/ORG_B_ID/USER_1_ID/USER_2_ID must be
// syntactically valid RFC 4122 UUIDs (version nibble 1-8) — apps/api's AuthSessionResponseSchema
// validates userId/orgId with z.uuid() at response-serialization time, and rejects the '0'
// version nibble the old sentinel values carried. This regex mirrors zod's own uuid validator
// closely enough to catch the specific defect class (see apps/api/src/modules/auth/routes.test.ts's
// end-to-end login regression test for the full reproduction).
const RFC4122_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('seedFixtures', () => {
  it('seeds 2 orgs, 2 users, and 2 active owner memberships with RFC-4122-valid ids', async () => {
    await seedFixtures()

    for (const id of [ORG_A_ID, ORG_B_ID, USER_1_ID, USER_2_ID]) {
      expect(id).toMatch(RFC4122_UUID)
    }

    const db = getDb()
    const [orgA] = await db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, ORG_A_ID))
    expect(orgA).toMatchObject({ id: ORG_A_ID, slug: 'org-alpha' })

    const [orgB] = await db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, ORG_B_ID))
    expect(orgB).toMatchObject({ id: ORG_B_ID, slug: 'org-beta' })

    const [alice] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, USER_1_ID))
    expect(alice).toMatchObject({ id: USER_1_ID, email: 'alice@example.com' })

    const [bob] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, USER_2_ID))
    expect(bob).toMatchObject({ id: USER_2_ID, email: 'bob@example.com' })

    const [membershipA] = await withOrg(ORG_A_ID, (tx) =>
      tx
        .select({ role: orgMemberships.role, status: orgMemberships.status })
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, USER_1_ID))
    )
    expect(membershipA).toMatchObject({ role: 'owner', status: 'active' })
  })

  it('is idempotent — re-running does not error or duplicate rows', async () => {
    await seedFixtures()
    await seedFixtures()

    const memberships = await withOrg(ORG_A_ID, (tx) =>
      tx
        .select({ userId: orgMemberships.userId })
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, USER_1_ID))
    )
    expect(memberships).toHaveLength(1)
  })
})
