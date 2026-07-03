import { sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from './index.js'
import { projects } from './schema/projects.js'

export async function insertTestProject(
  orgId: string,
  input: { userId: string; slug: string; name?: string; tags?: string[] }
): Promise<{ id: string; tags: string[] }> {
  const [project] = await withOrg(orgId, (tx) =>
    tx
      .insert(projects)
      .values({
        orgId,
        name: input.name ?? `Project ${input.slug}`,
        slug: `${input.slug}-${crypto.randomUUID().slice(0, 8)}`,
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        createdBy: input.userId,
      })
      .returning({ id: projects.id, tags: projects.tags })
  )
  if (!project) throw new Error('expected test project to be inserted')
  return project
}

/** Inserts a bare test user (RLS isolation specs only need a valid created_by FK target). */
export async function createTestUser(label: string): Promise<string> {
  const [user] = await getDb().execute(
    sql`INSERT INTO users (email, password_hash)
        VALUES (${`${label}-${crypto.randomUUID()}@example.com`}, 'x')
        RETURNING id`
  )
  return (user as { id: string }).id
}

export async function deleteTestUser(userId: string): Promise<void> {
  await getDb().execute(sql`DELETE FROM users WHERE id = ${userId}`)
}

// audit_log_entries is append-only — blocked by both the prevent_audit_log_mutation()
// trigger and (since 0002_audit_log_revoke.sql) a grant-layer REVOKE on vault_app,
// which fires first since PostgreSQL checks table privileges before triggers. A test
// org that wrote audit log rows can never have them purged — that is correct,
// intentional behavior (same as production), not a cleanup bug. Drizzle wraps the
// real Postgres error as `error.cause`; `.message` is just "Failed query: ...".
function isAppendOnlyViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof Error && /append-only|permission denied/.test(cause.message)
}

// When the audit_log_entries delete above was blocked, its row still FK-references
// this organization (no ON DELETE CASCADE), so the organizations delete fails with a
// standard Postgres foreign_key_violation (SQLSTATE 23503) — also expected.
function isForeignKeyViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return (
    Boolean(cause) && typeof cause === 'object' && (cause as { code?: string }).code === '23503'
  )
}

export async function withTestOrg<T>(
  fn: (ctx: { orgId: string; tx: Tx }) => Promise<T>
): Promise<T> {
  const orgId = crypto.randomUUID()
  const slugSuffix = orgId.slice(0, 8)
  await getDb().execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${'test-org-' + slugSuffix}, ${'test-' + slugSuffix})`
  )
  try {
    return await withOrg(orgId, (tx) => fn({ orgId, tx }))
  } finally {
    // Delete non-cascading children FIRST to avoid FK constraint violations.
    // audit_log_entries and security_alerts have no ON DELETE CASCADE on org_id.
    // org_memberships and sessions DO have CASCADE — they are cleaned up automatically.
    //
    // Both deletes MUST run inside withOrg() — a bare getDb().execute() has no
    // app.current_org_id set, so the RLS policy silently filters the DELETE to zero
    // rows (no error, just a no-op) instead of actually removing the row.
    //
    // Each step has its own try/catch so an expected append-only failure on
    // audit_log_entries doesn't skip the unrelated security_alerts/organizations
    // cleanup, and any *unexpected* failure (e.g. a dropped connection) still
    // propagates instead of being silently swallowed.
    try {
      await withOrg(orgId, (tx) =>
        tx.execute(sql`DELETE FROM audit_log_entries WHERE org_id = ${orgId}`)
      )
    } catch (error) {
      if (!isAppendOnlyViolation(error)) throw error
    }
    await withOrg(orgId, (tx) =>
      tx.execute(sql`DELETE FROM security_alerts WHERE org_id = ${orgId}`)
    )
    try {
      await getDb().execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error
    }
  }
}

/** Shared by RLS cross-org isolation specs that need two independent orgs in scope at once. */
export async function withTwoTestOrgs(
  run: (ctx: { orgAId: string; orgBId: string }) => Promise<void>
): Promise<void> {
  await withTestOrg(async ({ orgId: orgAId }) => {
    await withTestOrg(async ({ orgId: orgBId }) => {
      await run({ orgAId, orgBId })
    })
  })
}
