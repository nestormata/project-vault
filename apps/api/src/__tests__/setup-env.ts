import { beforeEach } from 'vitest'

const DEFAULT_DATABASE_URL =
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
// Tests that exercise a real admin query must provide ADMIN_DATABASE_URL explicitly.
// The default is intentionally non-connectable so the harness cannot launder a local
// superuser into a passing test.
const DEFAULT_ADMIN_DATABASE_URL = 'postgresql://vault_admin@admin-db.invalid:5432/project_vault'

process.env['DATABASE_URL'] ??= DEFAULT_DATABASE_URL
process.env['ADMIN_DATABASE_URL'] ??= DEFAULT_ADMIN_DATABASE_URL

beforeEach(() => {
  process.env['DATABASE_URL'] ??= DEFAULT_DATABASE_URL
  process.env['ADMIN_DATABASE_URL'] ??= DEFAULT_ADMIN_DATABASE_URL
})
