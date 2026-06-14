import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env['DATABASE_URL'] ?? 'postgresql://postgres:password@localhost:5432/project_vault',
  },
})
