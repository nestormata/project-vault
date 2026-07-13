#!/usr/bin/env tsx
// Fly.io demo seed (scripts/fly-reset.sh): everything db:seed:test seeds, plus one user
// with a real, login-able password — sourced entirely from env at seed time so the
// password itself never appears in source control or Fly secrets, only as a transient
// GitHub Actions secret piped through to this process (see fly-reset.yml).
import { sql } from 'drizzle-orm'
import { hashUserPassword, ARGON2_PARAMS } from '@project-vault/crypto'
import { getDb, withOrg } from './index.js'
import { orgMemberships } from './schema/index.js'

const ORG_A_ID = '00000000-0000-0000-0000-000000000001'
const ORG_B_ID = '00000000-0000-0000-0000-000000000002'
const USER_1_ID = '00000000-0000-0000-0000-000000000010'
const USER_2_ID = '00000000-0000-0000-0000-000000000011'
const DEMO_LOGIN_USER_ID = '00000000-0000-0000-0000-000000000099'

const BCRYPT_SENTINEL = '$2b$10$sentinelsentinelsentinelseO5z3K3K3K3K3K3K3K3K3K3K3K3K'

async function seed(): Promise<void> {
  const email = process.env['DEMO_LOGIN_EMAIL']
  const password = process.env['DEMO_LOGIN_PASSWORD']
  if (!email || !password) {
    throw new Error('Set DEMO_LOGIN_EMAIL and DEMO_LOGIN_PASSWORD before running db:seed:demo')
  }

  const db = getDb()

  // Same fixture data as db:seed:test (API-browsable, no working login).
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

  // Real login user: argon2id hash matches apps/api/src/modules/auth/password.ts exactly
  // (same hashUserPassword() call, same ARGON2_PARAMS), so the ordinary login form works.
  const passwordHash = await hashUserPassword(password, ARGON2_PARAMS)
  await db.execute(
    sql`INSERT INTO users (id, email, password_hash) VALUES (${DEMO_LOGIN_USER_ID}, ${email}, ${passwordHash})
        ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash`
  )
  await withOrg(ORG_A_ID, (tx) =>
    tx
      .insert(orgMemberships)
      .values({ orgId: ORG_A_ID, userId: DEMO_LOGIN_USER_ID, role: 'owner', status: 'active' })
      .onConflictDoNothing()
  )

  process.stdout.write(
    'db:seed:demo: fixture seeded (2 orgs, 2 fixture users, 1 login-able demo user)\n'
  )
}

try {
  await seed()
  process.exit(0)
} catch (error) {
  process.stderr.write(
    `db:seed:demo: failed — ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
}
