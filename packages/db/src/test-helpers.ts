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

/**
 * Inserts a test user and a matching user_identity_tokens row — mirroring what the production
 * registration flow (auth/service.ts's registerUser) does in the same transaction. Many callers
 * only need a valid created_by FK target (RLS isolation specs), but plenty of others (e.g.
 * org-role-test-helpers.ts's loginExistingUserInOrg) pair this with a real login, which writes a
 * genuine actor_type='human' audit_log_entries row. Without an identity token, that row's
 * actor_token_id is permanently NULL — audit_log_entries is append-only, so there is no cleanup
 * path — which check-audit-actor-token-coverage (Story 8.1, D3) treats as an unrepairable gap.
 */
export async function createTestUser(label: string): Promise<string> {
  const email = `${label}-${crypto.randomUUID()}@example.com`
  const [user] = await getDb().execute(
    sql`INSERT INTO users (email, password_hash)
        VALUES (${email}, 'x')
        RETURNING id`
  )
  const userId = (user as { id: string }).id
  await getDb().execute(
    sql`INSERT INTO user_identity_tokens (user_id, display_name)
        VALUES (${userId}, ${email})`
  )
  return userId
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
async function cleanupTestOrg(orgId: string): Promise<void> {
  try {
    await withOrg(orgId, (tx) =>
      tx.execute(sql`DELETE FROM audit_log_entries WHERE org_id = ${orgId}`)
    )
  } catch (error) {
    if (!isAppendOnlyViolation(error)) throw error
  }
  await withOrg(orgId, (tx) => tx.execute(sql`DELETE FROM security_alerts WHERE org_id = ${orgId}`))
  try {
    await getDb().execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error
  }
}

export async function withTestOrg<T>(
  fn: (ctx: { orgId: string; tx: Tx }) => Promise<T>
): Promise<T> {
  const orgId = crypto.randomUUID()
  const slugSuffix = orgId.slice(0, 8)
  await getDb().execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${'test-org-' + slugSuffix}, ${'test-' + slugSuffix})`
  )

  // Not a try/finally: throwing from a finally block silently discards whichever of
  // fn()'s or cleanup's exception didn't get thrown last (Sonar S1143). Run cleanup
  // explicitly on both the success and failure path instead, so the test's own failure
  // (the more actionable error) always wins over a secondary cleanup failure.
  let result: T
  try {
    result = await withOrg(orgId, (tx) => fn({ orgId, tx }))
  } catch (testError) {
    try {
      await cleanupTestOrg(orgId)
    } catch (cleanupError) {
      // eslint-disable-next-line no-console -- test-helper diagnostic, not app logging
      console.error('withTestOrg: cleanup failed after test failure', cleanupError)
    }
    throw testError
  }
  await cleanupTestOrg(orgId)
  return result
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
