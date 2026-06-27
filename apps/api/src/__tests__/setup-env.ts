import { beforeEach } from 'vitest'

const DEFAULT_DATABASE_URL =
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

process.env['DATABASE_URL'] ??= DEFAULT_DATABASE_URL

beforeEach(() => {
  process.env['DATABASE_URL'] ??= DEFAULT_DATABASE_URL
})
