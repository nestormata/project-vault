import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { handoffPendingStates, handoffTokenJti } from '@project-vault/db/schema'
import { pruneHandoffPendingStates, pruneHandoffTokenJti } from './prune-handoff-token-jti.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

describe('pruneHandoffTokenJti (Story 30.2 AC5.18/AC5.19)', () => {
  afterEach(async () => {
    await getDb()
      .delete(handoffTokenJti)
      .where(sql`1=1`)
  })

  it('deletes rows past expires_at and leaves not-yet-expired rows alone', async () => {
    const expiredJti = randomUUID()
    const freshJti = randomUUID()
    await getDb()
      .insert(handoffTokenJti)
      .values([
        { jti: expiredJti, expiresAt: new Date(Date.now() - 1000) },
        { jti: freshJti, expiresAt: new Date(Date.now() + 120_000) },
      ])

    await pruneHandoffTokenJti()

    const remaining = await getDb().select().from(handoffTokenJti)
    const remainingJtis = remaining.map((r) => r.jti)
    expect(remainingJtis).not.toContain(expiredJti)
    expect(remainingJtis).toContain(freshJti)
  })
})

describe('pruneHandoffPendingStates (Story 30.2 AC5.20)', () => {
  afterEach(async () => {
    await getDb()
      .delete(handoffPendingStates)
      .where(sql`1=1`)
  })

  function pendingRow(overrides: Partial<typeof handoffPendingStates.$inferInsert> = {}) {
    return {
      id: randomUUID(),
      cookieHash: randomUUID(),
      jti: randomUUID(),
      providerName: 'centralizeme-handoff',
      externalSubject: 'sub',
      organizationId: randomUUID(),
      claimsVersion: 1,
      expiresAt: new Date(Date.now() + 120_000),
      ...overrides,
    }
  }

  it('deletes orphaned (never-confirmed) pending-handoff rows past expiry', async () => {
    const expired = pendingRow({ expiresAt: new Date(Date.now() - 1000) })
    const fresh = pendingRow()
    await getDb().insert(handoffPendingStates).values([expired, fresh])

    await pruneHandoffPendingStates()

    const [expiredRow] = await getDb()
      .select()
      .from(handoffPendingStates)
      .where(eq(handoffPendingStates.id, expired.id))
    const [freshRow] = await getDb()
      .select()
      .from(handoffPendingStates)
      .where(eq(handoffPendingStates.id, fresh.id))
    expect(expiredRow).toBeUndefined()
    expect(freshRow).toBeDefined()
  })
})
