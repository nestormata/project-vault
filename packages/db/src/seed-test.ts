#!/usr/bin/env tsx
import { seedFixtures } from './seed-fixtures.js'

try {
  await seedFixtures()
  process.stdout.write('db:seed:test: fixture seeded (2 orgs, 2 users, 2 memberships)\n')
  process.exit(0)
} catch (error) {
  process.stderr.write(
    `db:seed:test: failed — ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exit(1)
}
