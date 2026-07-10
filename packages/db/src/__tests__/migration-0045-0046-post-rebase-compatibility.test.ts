import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import postgres from 'postgres'

const databaseUrl =
  process.env['ADMIN_DATABASE_URL'] ?? 'postgres://postgres:password@localhost:5432/project_vault'

function readMigrationSql(tag: string): string {
  return readFileSync(resolve(__dirname, '../migrations', `${tag}.sql`), 'utf-8')
}

describe('post-rebase migration compatibility', () => {
  it('lets 0045 re-apply cleanly when rebased local databases already have the credential alert columns', async () => {
    const sql = postgres(databaseUrl, { max: 1 })
    try {
      await sql.begin(async (tx) => {
        await tx`CREATE TEMP TABLE credentials (id uuid PRIMARY KEY);`
        await tx`ALTER TABLE credentials ADD COLUMN alert_lead_days jsonb DEFAULT '[]'::jsonb NOT NULL;`
        await tx`ALTER TABLE credentials ADD COLUMN notified_lead_days jsonb DEFAULT '[]'::jsonb NOT NULL;`
        await tx`SET LOCAL search_path TO pg_temp, public;`

        const migrationSql = readMigrationSql('0045_credential_expiry_alerts')
        await tx.unsafe(migrationSql)
        await tx.unsafe(migrationSql)

        const columns = await tx<{ column_name: string }[]>`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'credentials'
            AND table_schema LIKE 'pg_temp_%'
            AND column_name IN ('alert_lead_days', 'notified_lead_days')
          ORDER BY column_name
        `
        expect(columns.map((column) => column.column_name)).toEqual([
          'alert_lead_days',
          'notified_lead_days',
        ])
      })
    } finally {
      await sql.end()
    }
  })

  it('uses 0046 to backfill project visibility that a rebased database skipped when old 0044 was already applied', async () => {
    const sql = postgres(databaseUrl, { max: 1 })
    try {
      await sql.begin(async (tx) => {
        await tx`
          CREATE TEMP TABLE projects (
            id uuid PRIMARY KEY,
            org_id uuid NOT NULL
          );
        `
        await tx`
          CREATE TEMP TABLE org_memberships (
            org_id uuid NOT NULL,
            user_id uuid NOT NULL,
            role text NOT NULL
          );
        `
        await tx`
          CREATE TEMP TABLE project_memberships (
            org_id uuid NOT NULL,
            project_id uuid NOT NULL,
            user_id uuid NOT NULL,
            role text NOT NULL,
            CONSTRAINT project_memberships_project_id_user_id_key UNIQUE (project_id, user_id)
          );
        `
        await tx`SET LOCAL search_path TO pg_temp, public;`

        const orgId = '00000000-0000-0000-0000-000000000001'
        const projectId = '00000000-0000-0000-0000-000000000002'
        const ownerUserId = '00000000-0000-0000-0000-000000000003'
        const memberUserId = '00000000-0000-0000-0000-000000000004'
        const viewerUserId = '00000000-0000-0000-0000-000000000005'

        await tx`INSERT INTO projects (id, org_id) VALUES (${projectId}, ${orgId});`
        await tx`
          INSERT INTO org_memberships (org_id, user_id, role)
          VALUES
            (${orgId}, ${ownerUserId}, 'owner'),
            (${orgId}, ${memberUserId}, 'member'),
            (${orgId}, ${viewerUserId}, 'viewer');
        `

        const bridgeSql = readMigrationSql('0046_project_membership_visibility_backfill_bridge')
        await tx.unsafe(bridgeSql)
        await tx.unsafe(bridgeSql)

        const rows = await tx<{ user_id: string; role: string }[]>`
          SELECT user_id, role
          FROM project_memberships
          ORDER BY user_id
        `
        expect(rows).toEqual([
          { user_id: memberUserId, role: 'viewer' },
          { user_id: viewerUserId, role: 'viewer' },
        ])
      })
    } finally {
      await sql.end()
    }
  })
})
