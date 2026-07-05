import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { auditLogEntries, credentials, projects } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import type { initVault as InitVaultFn } from '../modules/vault/key-service.js'

/** Shared by every worker test's cross-org-attribution check: creates two orgs and hands both
 *  ids to the callback, so per-org assertions can be scoped correctly with `withOrg`. */
export async function withTwoTestOrgs<T>(
  fn: (orgAId: string, orgBId: string) => Promise<T>
): Promise<T> {
  return withTestOrg(async ({ orgId: orgAId }) =>
    withTestOrg(async ({ orgId: orgBId }) => fn(orgAId, orgBId))
  )
}

/** Must run before any worker test file's own dynamic `await import('../modules/vault/key-service.js')`
 *  — that module reads these env vars at load time. Call synchronously at the top of the test
 *  file, before the dynamic import. */
export function ensureWorkerTestEnv(): void {
  process.env['DATABASE_URL'] ??=
    'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
  process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
}

/** Shared by every org-scoped background-job test file (prune-credential-versions, Story 5.3's
 *  rotation-break-glass-expire/rotation-recover, ...) — seeds a bare project/credential pair
 *  scoped to a `withTestOrg`-created org. Named `*test-helpers*` so jscpd's repo-wide 0%
 *  duplication gate excludes it (see .jscpd.json). */
export async function seedWorkerProject(orgId: string, namePrefix: string): Promise<string> {
  const [project] = await withOrg(orgId, (tx) =>
    tx
      .insert(projects)
      .values({
        orgId,
        name: `${namePrefix} Project`,
        slug: `${namePrefix.toLowerCase()}-${randomUUID()}`,
      })
      .returning({ id: projects.id })
  )
  if (!project) throw new Error('expected test project to be inserted')
  return project.id
}

export async function seedWorkerCredential(
  orgId: string,
  projectId: string,
  namePrefix: string,
  retentionCount = 3
): Promise<string> {
  const [credential] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentials)
      .values({ orgId, projectId, name: `${namePrefix} Credential`, retentionCount })
      .returning({ id: credentials.id })
  )
  if (!credential) throw new Error('expected test credential to be inserted')
  return credential.id
}

/** Shared by every worker test's cross-org-attribution check: fetches the orgIds recorded on
 *  audit rows of a given eventType, scoped (via `withOrg`) to the org being asserted on. */
export async function findAuditRowOrgIds(orgId: string, eventType: string): Promise<string[]> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ orgId: auditLogEntries.orgId })
      .from(auditLogEntries)
      .where(eq(auditLogEntries.eventType, eventType))
  )
  return rows.map((row) => row.orgId)
}

/** Idempotent test-vault unseal — passphrase-init, tolerating an already-initialized vault
 *  (same DB reused across a describe.sequential block's beforeAll). */
export async function unsealWorkerTestVault(
  initVault: typeof InitVaultFn,
  passphrase: string
): Promise<void> {
  try {
    await initVault({ kmsType: 'passphrase', passphrase }, {})
  } catch (error) {
    if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
  }
}
