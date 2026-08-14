/**
 * Story 14.3 Task 10 (AC-12): documented manual-QA runbook. Boots a local API instance with the
 * mock external-IdP extension loaded, seeds the three fixture identities' backing rows (a linked
 * external_identities row, an unlinked user with nothing pre-seeded, and a pending
 * project_invitations row), then prints ready-to-run curl commands for each scenario.
 *
 * Usage:
 *   pnpm --filter @project-vault/mock-sso-extension build
 *   pnpm --filter @project-vault/api sso:qa
 *
 * This script never runs in production and is excluded from any production entrypoint/manifest —
 * see fixtures/mock-sso-extension/README.md's "Production-safety" section and
 * apps/api/src/__tests__/mock-extension-not-in-production.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { getDb, withOrg } from '@project-vault/db'
import {
  externalIdentities,
  organizations,
  projectInvitations,
  projects,
  users,
} from '@project-vault/db/schema'
import { createApp } from '../app.js'
import { initVault, isSealed } from '../modules/vault/key-service.js'

export const PROVIDER_NAME = 'test.mock-sso-extension'

// This manual-QA-only cleanup must not widen the production vault_admin grant set. Supply a
// separately provisioned QA connection explicitly when running this script; there is no fallback.
const qaDatabaseUrl = process.env['QA_DATABASE_URL']
const qaDb = qaDatabaseUrl ? drizzle(postgres(qaDatabaseUrl)) : null
// Not a credential — a fixed, non-secret local-only vault passphrase for this manual-QA script
// alone; the script never runs in production (see file header + the
// mock-extension-not-in-production.test.ts guard), so there is nothing here for the rule to protect.
const QA_PASSPHRASE = 'sso-qa-local-passphrase-not-for-production' // NOSONAR(typescript:S2068)

export async function ensureUnsealed(): Promise<void> {
  if (!isSealed()) return
  try {
    await initVault({ kmsType: 'passphrase', passphrase: QA_PASSPHRASE }, {})
  } catch (error) {
    if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
    process.stdout.write(
      'Vault already initialized — if it is sealed, unseal it manually before running this script.\n'
    )
  }
}

export async function seedFixtures() {
  const orgId = randomUUID()
  const suffix = orgId.slice(0, 8)
  await getDb()
    .insert(organizations)
    .values({ id: orgId, name: `sso-qa-${suffix}`, slug: `sso-qa-${suffix}` })

  // linked-user: pre-seed an external_identities row so the callback resolves a session (AC-5).
  // The seeded email only needs to be human-readable — AC-5's lookup keys on
  // (orgId, providerName, externalSubject), never on email — so it's suffixed per run to stay
  // globally unique across repeat runs against the same persistent dev database (users.email has
  // a unique constraint; a fixed literal here would fail on the second manual-QA run).
  const [linkedUser] = await getDb()
    .insert(users)
    .values({ email: `linked-user-${suffix}@example.test`, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!linkedUser) throw new Error('sso-qa: failed to insert linked-user row')
  await withOrg(orgId, (tx) =>
    tx.insert(externalIdentities).values({
      orgId,
      userId: linkedUser.id,
      providerName: PROVIDER_NAME,
      externalSubject: 'fixture-subject-linked-user',
    })
  )

  // invited-user: pre-seed a pending project_invitations row so the callback auto-provisions
  // (AC-8). unlinked-user needs no seeding at all — its whole point is "nothing exists yet".
  const [project] = await withOrg(orgId, (tx) =>
    tx
      .insert(projects)
      .values({ orgId, name: `sso-qa-project-${suffix}`, slug: `sso-qa-project-${suffix}` })
      .returning({ id: projects.id })
  )
  const [inviter] = await getDb()
    .insert(users)
    .values({ email: `sso-qa-inviter-${suffix}@example.test`, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!project || !inviter) throw new Error('sso-qa: failed to seed invitation prerequisites')

  // Unlike the linked-user's email above, this one must stay the exact fixed literal the mock
  // extension's onAuthenticate('invited-user') always returns (AC-8 matches by email). Revoke any
  // still-pending invitation left over from a previous manual-QA run for this same email first —
  // otherwise a second run leaves two pending invitations across two orgs, and AC-8's genuine
  // multi-org-ambiguous-match guard rejects the demo instead of hitting the happy path again.
  // This is a cross-org search/update with no org context yet, so per-org RLS would otherwise hide
  // every row from a previous run's different org. It uses a separately named QA connection so the
  // production vault_admin role remains read-only on project_invitations.
  if (!qaDb) throw new Error('sso-qa: QA_DATABASE_URL is required for cross-org fixture cleanup')
  await qaDb
    .update(projectInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(projectInvitations.email, 'invited-user@example.test'),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt)
      )
    )
  await withOrg(orgId, (tx) =>
    tx.insert(projectInvitations).values({
      orgId,
      projectId: project.id,
      email: 'invited-user@example.test',
      roleToAssign: 'member',
      tokenHash: randomUUID(),
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
  )

  return { orgId }
}

export function printRunbook(baseUrl: string): void {
  const scenarios: Array<{ label: string; credential: string; expect: string }> = [
    {
      label: 'Linked user (AC-5) — expect a full session',
      credential: 'linked-user',
      expect: '200, Set-Cookie: access-token=...',
    },
    {
      label: 'Unlinked user (AC-7) — expect account_link_required',
      credential: 'unlinked-user',
      expect: '403 { "code": "account_link_required" }',
    },
    {
      label: 'Invited user (AC-8) — expect auto-provisioning + session',
      credential: 'invited-user',
      expect: '200, Set-Cookie: access-token=...',
    },
  ]

  process.stdout.write(`\nSSO manual-QA runbook — API listening at ${baseUrl}\n`)
  process.stdout.write('='.repeat(72) + '\n')
  for (const scenario of scenarios) {
    process.stdout.write(`\n${scenario.label}\n`)
    process.stdout.write('-'.repeat(scenario.label.length) + '\n')
    process.stdout.write(
      `1) curl -i -c /tmp/sso-qa-cookies.txt -X POST ${baseUrl}/api/v1/auth/sso/start/${PROVIDER_NAME}\n`
    )
    process.stdout.write(
      `2) curl -i -b /tmp/sso-qa-cookies.txt -X POST ${baseUrl}/api/v1/auth/sso/callback/${PROVIDER_NAME} \\\n` +
        `     -H 'Content-Type: application/json' -d '{"credential":"${scenario.credential}"}'\n`
    )
    process.stdout.write(`   Expected: ${scenario.expect}\n`)
  }
  process.stdout.write('\n' + '='.repeat(72) + '\n')
  process.stdout.write('Press Ctrl+C to stop the server.\n\n')
}

export async function main(): Promise<void> {
  process.env['VAULT_EXTENSIONS_PACKAGE'] ??= '@project-vault/mock-sso-extension'
  await ensureUnsealed()
  await seedFixtures()

  const app = await createApp({ logger: true })
  const port = Number(process.env['SSO_QA_PORT'] ?? 3999)
  await app.listen({ port, host: '127.0.0.1' })
  printRunbook(`http://127.0.0.1:${port}`)
}

// Guard mirrors guarded-migrate.ts's own convention: only run when executed directly (`tsx
// sso-qa.ts`), never as a side effect of another module importing this file's exports (e.g. this
// script's own test file) — without this, merely importing seedFixtures()/printRunbook() for unit
// testing would boot a real server and seed the real configured database as an import side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main()
  } catch (error: unknown) {
    process.stderr.write(`sso-qa failed: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  }
}
