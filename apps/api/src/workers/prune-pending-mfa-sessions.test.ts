import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { organizations, pendingMfaSessions, users } from '@project-vault/db/schema'

vi.stubEnv(
  'DATABASE_URL',
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
)

const { prunePendingMfaSessions } = await import('./prune-pending-mfa-sessions.js')

async function createUserAndOrg(label: string) {
  const [org] = await getDb()
    .insert(organizations)
    .values({ name: `Prune ${label}`, slug: `prune-${label}-${randomUUID()}` })
    .returning({ id: organizations.id })
  const [user] = await getDb()
    .insert(users)
    .values({ email: `prune-${label}-${randomUUID()}@example.com`, passwordHash: 'hash' })
    .returning({ id: users.id })
  if (!org || !user) throw new Error('failed to seed user/org')
  return { orgId: org.id, userId: user.id }
}

function tokenHash(n: number): string {
  return String(n).repeat(64).slice(0, 64)
}

describe('prunePendingMfaSessions', () => {
  beforeEach(async () => {
    await getDb().execute(sql`DELETE FROM pending_mfa_sessions`)
  })

  it('deletes expired and attempt-capped pending MFA sessions while retaining live rows', async () => {
    const expired = await createUserAndOrg('expired')
    const capped = await createUserAndOrg('capped')
    const live = await createUserAndOrg('live')
    const now = Date.now()

    await getDb()
      .insert(pendingMfaSessions)
      .values([
        {
          ...expired,
          tokenHash: tokenHash(1),
          attemptCount: 0,
          createdAt: new Date(now - 10 * 60_000),
          expiresAt: new Date(now - 60_000),
        },
        {
          ...capped,
          tokenHash: tokenHash(2),
          attemptCount: 5,
          createdAt: new Date(now),
          expiresAt: new Date(now + 5 * 60_000),
        },
        {
          ...live,
          tokenHash: tokenHash(3),
          attemptCount: 0,
          createdAt: new Date(now),
          expiresAt: new Date(now + 5 * 60_000),
        },
      ])

    const logs: unknown[] = []
    await prunePendingMfaSessions({
      info: (payload) => logs.push(payload),
      error: (payload) => logs.push(payload),
    })

    await expect(getDb().select().from(pendingMfaSessions)).resolves.toHaveLength(1)
    await expect(
      getDb().select().from(pendingMfaSessions).where(eq(pendingMfaSessions.userId, live.userId))
    ).resolves.toHaveLength(1)
    expect(logs).toContainEqual({
      eventType: 'job.completed',
      jobName: 'mfa:prune-pending-mfa-sessions',
      deletedCount: 2,
    })
  })
})
