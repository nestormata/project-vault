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

// Must be a syntactically valid RFC 4122 UUID (version nibble 1-8) — see seed-fixtures.ts's
// ORG_A_ID/USER_1_ID comment for why: z.uuid() rejects a '0' version nibble at response-
// serialization time, which is exactly what turned demo login into a 500 before this fix.
const DEMO_LOGIN_USER_ID = '00000000-0000-4000-8000-000000000099'

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
  // registerUser() (the normal signup path) always creates a user_identity_tokens row alongside
  // the user — service.ts's createLoginSessionInTx uses it as the audit actor_token_id on every
  // login's SESSION_CREATED entry. Without one, this user's (real, login-able) sessions would
  // write actor_type='human' audit rows with a null actor_token_id, permanently failing
  // checkAuditActorTokenCoverage (packages/db/src/check-audit-actor-token-coverage.ts) — append-only,
  // so the gap would never self-heal. Guarded by a NOT EXISTS check (rather than
  // onConflictDoNothing on the auto-generated `id`) so re-running the seed doesn't grow a fresh
  // duplicate identity token every time.
  await db.execute(sql`
    INSERT INTO user_identity_tokens (user_id, display_name)
    SELECT ${DEMO_LOGIN_USER_ID}, ${email}
    WHERE NOT EXISTS (
      SELECT 1 FROM user_identity_tokens WHERE user_id = ${DEMO_LOGIN_USER_ID}
    )
  `)
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
