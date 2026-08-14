export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://vault_app:missing@app-db.invalid:5432/project_vault'

export const ADMIN_DATABASE_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://vault_admin:missing@admin-db.invalid:5432/project_vault'

export const SUPERUSER_DATABASE_URL =
  process.env['SUPERUSER_DATABASE_URL'] ??
  'postgresql://postgres:missing@superuser-db.invalid:5432/project_vault'
