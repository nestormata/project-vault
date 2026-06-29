import { beforeEach } from 'vitest'

const DEFAULT_DATABASE_URL =
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
const DEFAULT_ADMIN_DATABASE_URL = 'postgresql://postgres:password@localhost:5432/project_vault'

process.env['DATABASE_URL'] ??= DEFAULT_DATABASE_URL
process.env['ADMIN_DATABASE_URL'] ??= DEFAULT_ADMIN_DATABASE_URL

beforeEach(() => {
  process.env['DATABASE_URL'] ??= DEFAULT_DATABASE_URL
  process.env['ADMIN_DATABASE_URL'] ??= DEFAULT_ADMIN_DATABASE_URL
})
