// Shared by seed-test.ts and seed-demo.ts — kept in one place so jscpd doesn't flag them
// as clones of each other.
import { sql } from 'drizzle-orm'
import { getDb, withOrg } from './index.js'
import { orgMemberships } from './schema/index.js'

export const ORG_A_ID = '00000000-0000-0000-0000-000000000001'
export const ORG_B_ID = '00000000-0000-0000-0000-000000000002'
export const USER_1_ID = '00000000-0000-0000-0000-000000000010'
export const USER_2_ID = '00000000-0000-0000-0000-000000000011'

const BCRYPT_SENTINEL = '$2b$10$sentinelsentinelsentinelseO5z3K3K3K3K3K3K3K3K3K3K3K3K'

/** 2 orgs, 2 users with a non-login-able sentinel password hash, 2 memberships. */
export async function seedFixtures(): Promise<void> {
  const db = getDb()

  await db.execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG_A_ID}, 'Org Alpha', 'org-alpha') ON CONFLICT (id) DO NOTHING`
  )
  await db.execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG_B_ID}, 'Org Beta', 'org-beta') ON CONFLICT (id) DO NOTHING`
  )
  await db.execute(
    sql`INSERT INTO users (id, email, password_hash) VALUES (${USER_1_ID}, 'alice@example.com', ${BCRYPT_SENTINEL}) ON CONFLICT (id) DO NOTHING`
  )
  await db.execute(
    sql`INSERT INTO users (id, email, password_hash) VALUES (${USER_2_ID}, 'bob@example.com', ${BCRYPT_SENTINEL}) ON CONFLICT (id) DO NOTHING`
  )

  await withOrg(ORG_A_ID, (tx) =>
    tx
      .insert(orgMemberships)
      .values({ orgId: ORG_A_ID, userId: USER_1_ID, role: 'owner', status: 'active' })
      .onConflictDoNothing()
  )
  await withOrg(ORG_B_ID, (tx) =>
    tx
      .insert(orgMemberships)
      .values({ orgId: ORG_B_ID, userId: USER_2_ID, role: 'owner', status: 'active' })
      .onConflictDoNothing()
  )
}
