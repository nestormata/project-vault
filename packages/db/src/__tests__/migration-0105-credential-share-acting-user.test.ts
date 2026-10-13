import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { getDb, withOrg } from '../index.js'
import { auditLogEntries, credentialShares } from '../schema/index.js'
import { createTestUser, deleteTestUser, withTestOrg } from '../test-helpers.js'
import { SUPERUSER_DATABASE_URL } from '../test-db-urls.js'
import { createCredentialTestProject, insertTestCredential } from './credential-test-helpers.js'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0105_credential_share_acting_user.sql'
)
const superSql = postgres(SUPERUSER_DATABASE_URL, { max: 1 })

afterAll(async () => {
  await superSql.end()
})

function migrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, 'utf-8')
    .split('--> statement-breakpoint')
    .filter((statement) => statement.replaceAll(/^\s*--.*$/gm, '').trim() !== '')
}

/** The backfill is the one statement that updates credential_shares (the rest are DDL). */
function backfillStatement(): string {
  const found = migrationStatements().find((statement) =>
    /UPDATE\s+"?credential_shares"?/i.test(statement)
  )
  if (!found) throw new Error('0105 has no credential_shares backfill statement')
  return found
}

// Story 65.6 D2: acting_user_id + host_created are additive; the backfill only ever flips
// host_created false -> true, and only on machine-actor audit evidence.
describe('migration 0105 (credential_shares.acting_user_id + host_created)', () => {
  it('is additive: only ALTER TABLE credential_shares plus the guarded backfill, nothing destructive', () => {
    const sqlText = migrationStatements()
      .join('\n')
      .replaceAll(/^\s*--.*$/gm, '')
    const alteredTables = [...sqlText.matchAll(/ALTER TABLE "?([a-z_]+)"?/g)].map((m) => m[1])
    expect(new Set(alteredTables)).toEqual(new Set(['credential_shares']))
    expect(sqlText).not.toMatch(/DROP |RENAME|TRUNCATE|DELETE FROM/i)
    // The only data statement may set host_created = true; never touch shared_by.
    expect(sqlText).not.toMatch(/SET[^;]*shared_by/i)
  })

  it('is idempotent: re-running every statement on a migrated database does not fail', async () => {
    for (const statement of migrationStatements()) {
      await expect(superSql.unsafe(statement)).resolves.toBeDefined()
    }
  })

  it('adds a nullable uuid acting_user_id referencing users(id) ON DELETE RESTRICT', async () => {
    const [column] = await superSql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'credential_shares' AND column_name = 'acting_user_id'`
    expect(column).toEqual({ data_type: 'uuid', is_nullable: 'YES' })
    const [fk] = await superSql<{ confdeltype: string; target: string }[]>`
      SELECT c.confdeltype, c.confrelid::regclass::text AS target
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'credential_shares'::regclass AND c.contype = 'f'
        AND a.attname = 'acting_user_id'`
    expect(fk).toEqual({ confdeltype: 'r', target: 'users' })
  })

  it('adds host_created boolean NOT NULL DEFAULT false', async () => {
    const [column] = await superSql<
      { data_type: string; is_nullable: string; column_default: string }[]
    >`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'credential_shares' AND column_name = 'host_created'`
    expect(column).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' })
  })

  it('backfills host_created under RLS from machine-actor audit evidence only', async () => {
    await withTestOrg(async ({ orgId }) => {
      const userId = await createTestUser('migration-0105')
      try {
        const projectId = await createCredentialTestProject(orgId, userId, 'proj-0105')
        const credentialId = await insertTestCredential(orgId, projectId, userId, 'cred-0105')
        const [identity] = await superSql<{ id: string }[]>`
          SELECT id FROM user_identity_tokens WHERE user_id = ${userId}`
        if (!identity) throw new Error('expected an identity token for the test user')

        const insertShare = async (label: string): Promise<string> => {
          const [row] = await withOrg(orgId, (tx) =>
            tx
              .insert(credentialShares)
              .values({
                orgId,
                credentialId,
                sharedBy: userId,
                recipientType: 'external',
                recipientEmail: `${label}@invalid`,
                tokenHash: `hash-0105-${label}-${crypto.randomUUID()}`,
                expiresAt: new Date(Date.now() + 3_600_000),
              })
              .returning({ id: credentialShares.id })
          )
          if (!row) throw new Error('expected share insert')
          return row.id
        }
        const audit = (shareId: string, actorType: 'machine_user' | 'human', eventType: string) =>
          withOrg(orgId, (tx) =>
            tx.insert(auditLogEntries).values({
              orgId,
              actorTokenId: actorType === 'human' ? identity.id : null,
              actorType,
              eventType,
              resourceId: shareId,
              resourceType: 'credential_share',
              payload: {},
              keyVersion: 1,
              hmac: 'x',
            })
          )

        const machineShare = await insertShare('machine')
        const humanShare = await insertShare('human')
        const unauditedShare = await insertShare('unaudited')
        const machineRevokedOnly = await insertShare('machine-revoked-only')
        await audit(machineShare, 'machine_user', 'credential.share_created')
        await audit(humanShare, 'human', 'credential.share_created')
        // A machine-attributed event that is not the creation event is not evidence of creation.
        await audit(machineRevokedOnly, 'machine_user', 'credential.share_revoked')

        const hostCreatedOf = async (shareId: string): Promise<boolean> => {
          const [row] = await withOrg(orgId, (tx) =>
            tx
              .select({ hostCreated: credentialShares.hostCreated })
              .from(credentialShares)
              .where(eq(credentialShares.id, shareId))
          )
          if (!row) throw new Error('expected share row')
          return row.hostCreated
        }

        // Run the real backfill statement as the app role (vault_app, RLS on) with NO org bound on
        // the connection: a statement that does not bind the org per organization matches nothing
        // here, which is exactly the silent no-op a non-bypass migration role would hit.
        await getDb().execute(sql.raw(backfillStatement()))

        expect(await hostCreatedOf(machineShare)).toBe(true)
        expect(await hostCreatedOf(humanShare)).toBe(false)
        expect(await hostCreatedOf(unauditedShare)).toBe(false)
        expect(await hostCreatedOf(machineRevokedOnly)).toBe(false)

        // acting_user_id is never guessed.
        const [acting] = await withOrg(orgId, (tx) =>
          tx
            .select({ actingUserId: credentialShares.actingUserId })
            .from(credentialShares)
            .where(eq(credentialShares.id, machineShare))
        )
        expect(acting?.actingUserId).toBeNull()

        // Idempotent re-run: only false -> true, never the reverse, no change in the result.
        await getDb().execute(sql.raw(backfillStatement()))
        expect(await hostCreatedOf(machineShare)).toBe(true)
        expect(await hostCreatedOf(humanShare)).toBe(false)
      } finally {
        await deleteTestUser(userId).catch(() => undefined)
      }
    })
  })
})
