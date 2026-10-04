import { afterAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { getTableColumns, sql } from 'drizzle-orm'
import { getDb, withOrg } from '../index.js'
import { delegationAssertionJti } from '../schema/index.js'
import { withTwoTestOrgs } from '../test-helpers.js'
import { SUPERUSER_DATABASE_URL } from '../test-db-urls.js'

const TABLE = 'delegation_assertion_jti'
const KID = 'k1'
const SHARED_JTI = 'shared-jti'
const superSql = postgres(SUPERUSER_DATABASE_URL, { max: 1 })

afterAll(async () => {
  await superSql.end()
})

function sqlStateOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause
  return cause?.code ?? (error as { code?: string } | undefined)?.code
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the statement to be rejected')
}

function futureDate(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000)
}

async function tablePrivilege(role: string, privilege: string): Promise<boolean> {
  const rows = await superSql<{ granted: boolean }[]>`
    SELECT has_table_privilege(${role}, ${TABLE}, ${privilege}) AS granted`
  return rows[0]?.granted === true
}

async function columnPrivilege(role: string, column: string, privilege: string): Promise<boolean> {
  const rows = await superSql<{ granted: boolean }[]>`
    SELECT has_column_privilege(${role}, ${TABLE}, ${column}, ${privilege}) AS granted`
  return rows[0]?.granted === true
}

const COLUMNS = ['org_id', 'jti', 'kid', 'expires_at', 'created_at']
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES']

async function grantedTablePrivileges(role: string): Promise<string[]> {
  const checked = await Promise.all(
    TABLE_PRIVILEGES.map(async (p) => ({ name: p, granted: await tablePrivilege(role, p) }))
  )
  return checked.filter((entry) => entry.granted).map((entry) => entry.name)
}

async function grantedColumns(role: string, privilege: string): Promise<string[]> {
  const checked = await Promise.all(
    COLUMNS.map(async (c) => ({ name: c, granted: await columnPrivilege(role, c, privilege) }))
  )
  return checked.filter((entry) => entry.granted).map((entry) => entry.name)
}

// Story 71.7 AC-1/AC-2/AC-5 — the delegation assertion burn ledger at the database layer.
describe('delegation_assertion_jti schema, RLS and grants', () => {
  it('AC-2.1: RLS enabled and forced, owned by vault_owner, exactly one FOR ALL policy', async () => {
    const rows = await superSql<{ enabled: boolean; forced: boolean; owner: string }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced,
             pg_get_userbyid(relowner) AS owner
        FROM pg_class WHERE relname = ${TABLE} AND relkind = 'r'`
    expect(rows[0]).toEqual({ enabled: true, forced: true, owner: 'vault_owner' })
    const policies = await superSql<{ policyname: string; cmd: string }[]>`
      SELECT policyname, cmd FROM pg_policies WHERE tablename = ${TABLE}`
    expect(policies).toEqual([{ policyname: 'delegation_assertion_jti_isolation', cmd: 'ALL' }])
  })

  it('AC-1: columns, (org_id, jti) primary key, cascade FK and expires_at index', async () => {
    expect(Object.keys(getTableColumns(delegationAssertionJti)).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'jti',
      'kid',
      'orgId',
    ])
    const pk = await superSql<{ column_name: string }[]>`
      SELECT a.attname AS column_name
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ${TABLE}::regclass AND i.indisprimary
       ORDER BY a.attname`
    expect(pk.map((r) => r.column_name)).toEqual(['jti', 'org_id'])
    const fk = await superSql<{ action: string; target: string }[]>`
      SELECT confdeltype AS action, confrelid::regclass::text AS target
        FROM pg_constraint WHERE conrelid = ${TABLE}::regclass AND contype = 'f'`
    expect(fk).toEqual([{ action: 'c', target: 'organizations' }])
    const idx = await superSql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE tablename = ${TABLE} AND indexdef LIKE '%(expires_at)%'`
    expect(idx.map((r) => r.indexname)).toEqual(['idx_delegation_assertion_jti_expires_at'])
  })

  it('AC-2.2: vault_app has exactly SELECT and INSERT', async () => {
    expect(await grantedTablePrivileges('vault_app')).toEqual(['SELECT', 'INSERT'])
  })

  it('AC-2.3: vault_admin has only column SELECT (org_id, jti, expires_at) and DELETE', async () => {
    expect(await grantedTablePrivileges('vault_admin')).toEqual(['DELETE'])
    expect(await grantedColumns('vault_admin', 'SELECT')).toEqual(['org_id', 'jti', 'expires_at'])
    expect(await grantedColumns('vault_admin', 'INSERT')).toEqual([])
    expect(await grantedColumns('vault_admin', 'UPDATE')).toEqual([])
  })

  it('AC-2.4: vault_extension has no privilege at all', async () => {
    expect(await grantedTablePrivileges('vault_extension')).toEqual([])
    expect(await grantedColumns('vault_extension', 'SELECT')).toEqual([])
    expect(await grantedColumns('vault_extension', 'INSERT')).toEqual([])
  })

  it('AC-1: CHECK constraints reject a 129-byte jti and an empty kid (23514)', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const longJti = await rejectionOf(
        withOrg(orgAId, (tx) =>
          tx.insert(delegationAssertionJti).values({
            orgId: orgAId,
            jti: 'j'.repeat(129),
            kid: KID,
            expiresAt: futureDate(60),
          })
        )
      )
      expect(sqlStateOf(longJti)).toBe('23514')
      const emptyKid = await rejectionOf(
        withOrg(orgAId, (tx) =>
          tx.insert(delegationAssertionJti).values({
            orgId: orgAId,
            jti: 'j-empty-kid',
            kid: '',
            expiresAt: futureDate(60),
          })
        )
      )
      expect(sqlStateOf(emptyKid)).toBe('23514')
      // The boundary itself (128 bytes of multibyte characters) is accepted.
      await withOrg(orgAId, (tx) =>
        tx.insert(delegationAssertionJti).values({
          orgId: orgAId,
          jti: 'é'.repeat(64),
          kid: 'k'.repeat(128),
          expiresAt: futureDate(60),
        })
      )
    })
  })

  it('AC-1: deleting the org cascades its burn rows', async () => {
    const orgId = crypto.randomUUID()
    const slug = `deleg-cascade-${orgId.slice(0, 8)}`
    await superSql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${slug}, ${slug})`
    await withOrg(orgId, (tx) =>
      tx.insert(delegationAssertionJti).values({
        orgId,
        jti: 'j-cascade',
        kid: KID,
        expiresAt: futureDate(60),
      })
    )
    await superSql`DELETE FROM organizations WHERE id = ${orgId}`
    const rows = await superSql`SELECT 1 FROM delegation_assertion_jti WHERE org_id = ${orgId}`
    expect(rows).toHaveLength(0)
  })

  it('AC-5.1/AC-5.3: rows are org-isolated and the same jti burns independently per org', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await withOrg(orgBId, (tx) =>
        tx.insert(delegationAssertionJti).values({
          orgId: orgBId,
          jti: SHARED_JTI,
          kid: KID,
          expiresAt: futureDate(60),
        })
      )
      const seenByA = await withOrg(orgAId, (tx) => tx.select().from(delegationAssertionJti))
      expect(seenByA).toHaveLength(0)
      const seenByB = await withOrg(orgBId, (tx) => tx.select().from(delegationAssertionJti))
      expect(seenByB.map((r) => r.jti)).toEqual([SHARED_JTI])
      // Same jti under org A: an independent key, no primary-key collision.
      await withOrg(orgAId, (tx) =>
        tx.insert(delegationAssertionJti).values({
          orgId: orgAId,
          jti: SHARED_JTI,
          kid: KID,
          expiresAt: futureDate(60),
        })
      )
    })
  })

  it('AC-5.2: under org A an INSERT carrying org B fails the WITH CHECK (42501)', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const error = await rejectionOf(
        withOrg(orgAId, (tx) =>
          tx.insert(delegationAssertionJti).values({
            orgId: orgBId,
            jti: 'cross-tenant',
            kid: KID,
            expiresAt: futureDate(60),
          })
        )
      )
      expect(sqlStateOf(error)).toBe('42501')
    })
  })

  it('AC-5.4: outside any org context SELECT sees nothing and INSERT fails', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      await withOrg(orgAId, (tx) =>
        tx.insert(delegationAssertionJti).values({
          orgId: orgAId,
          jti: 'no-context',
          kid: KID,
          expiresAt: futureDate(60),
        })
      )
      const visible = await getDb().select().from(delegationAssertionJti)
      expect(visible).toHaveLength(0)
      await expect(
        getDb()
          .insert(delegationAssertionJti)
          .values({
            orgId: orgAId,
            jti: 'no-context-2',
            kid: KID,
            expiresAt: futureDate(60),
          })
      ).rejects.toThrow()
    })
  })

  it('AC-2.2: vault_app cannot UPDATE or DELETE a burn row (append-only)', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      await withOrg(orgAId, (tx) =>
        tx.insert(delegationAssertionJti).values({
          orgId: orgAId,
          jti: 'append-only',
          kid: KID,
          expiresAt: futureDate(60),
        })
      )
      const update = await rejectionOf(
        withOrg(orgAId, (tx) => tx.execute(sql`UPDATE delegation_assertion_jti SET kid = 'x'`))
      )
      expect(sqlStateOf(update)).toBe('42501')
      const remove = await rejectionOf(
        withOrg(orgAId, (tx) => tx.execute(sql`DELETE FROM delegation_assertion_jti`))
      )
      expect(sqlStateOf(remove)).toBe('42501')
    })
  })
})
