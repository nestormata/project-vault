export const SUPERUSER_DATABASE_URL =
  process.env['SUPERUSER_DATABASE_URL'] ??
  'postgresql://postgres:missing@superuser-db.invalid:5432/project_vault'
