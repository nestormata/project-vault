#!/usr/bin/env tsx
import { sql } from 'drizzle-orm'
import { getDb, withOrg } from './index.js'
import { orgMemberships } from './schema/index.js'

const ORG_A_ID = '00000000-0000-0000-0000-000000000001'
const ORG_B_ID = '00000000-0000-0000-0000-000000000002'
const USER_1_ID = '00000000-0000-0000-0000-000000000010'
const USER_2_ID = '00000000-0000-0000-0000-000000000011'

const BCRYPT_SENTINEL = '$2b$10$sentinelsentinelsentinelseO5z3K3K3K3K3K3K3K3K3K3K3K3K'

async function seed(): Promise<void> {
  const db = getDb()

  // Non-org-scoped tables: insert directly
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

  // Org-scoped tables: MUST use withOrg() or RLS silently blocks the insert
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

  process.stdout.write('db:seed:test: fixture seeded (2 orgs, 2 users, 2 memberships)\n')
}

try {
  await seed()
  process.exit(0)
} catch (error) {
  process.stderr.write(
    `db:seed:test: failed — ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
}
