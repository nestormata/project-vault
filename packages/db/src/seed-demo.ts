#!/usr/bin/env tsx
// Fly.io demo seed (scripts/fly-reset.sh): everything db:seed:test seeds, plus one user
// with a real, login-able password — sourced entirely from env at seed time so the
// password itself never appears in source control or Fly secrets, only as a transient
// GitHub Actions secret piped through to this process (see fly-reset.yml).
import { sql } from 'drizzle-orm'
import { hashUserPassword, ARGON2_PARAMS } from '@project-vault/crypto'
import { getDb, withOrg } from './index.js'
import { orgMemberships } from './schema/index.js'
import { seedFixtures, ORG_A_ID } from './seed-fixtures.js'

const DEMO_LOGIN_USER_ID = '00000000-0000-0000-0000-000000000099'

async function seed(): Promise<void> {
  const email = process.env['DEMO_LOGIN_EMAIL']
  const password = process.env['DEMO_LOGIN_PASSWORD']
  if (!email || !password) {
    throw new Error('Set DEMO_LOGIN_EMAIL and DEMO_LOGIN_PASSWORD before running db:seed:demo')
  }

  await seedFixtures()

  const db = getDb()
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
