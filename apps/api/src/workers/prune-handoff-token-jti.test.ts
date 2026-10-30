import { randomUUID } from 'node:crypto'
import { inArray, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { handoffNonces, handoffPendingStates, handoffTokenJti } from '@project-vault/db/schema'
import {
  pruneHandoffNonces,
  pruneHandoffTokenJti,
  RETIRED_HANDOFF_PRUNE_SCHEDULES,
} from './prune-handoff-token-jti.js'

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

describe('pruneHandoffNonces (Story 73.1)', () => {
  it('deletes nonce rows past expiry, consumed or not, and leaves live rows alone', async () => {
    const expired = `prune-test-${randomUUID()}`
    const expiredConsumed = `prune-test-${randomUUID()}`
    const fresh = `prune-test-${randomUUID()}`
    await getDb()
      .insert(handoffNonces)
      .values([
        { nonceHash: expired, expiresAt: new Date(Date.now() - 1000) },
        {
          nonceHash: expiredConsumed,
          expiresAt: new Date(Date.now() - 1000),
          consumedAt: new Date(),
        },
        { nonceHash: fresh, expiresAt: new Date(Date.now() + 120_000) },
      ])

    await pruneHandoffNonces()

    const remaining = await getDb()
      .select({ nonceHash: handoffNonces.nonceHash })
      .from(handoffNonces)
      .where(inArray(handoffNonces.nonceHash, [expired, expiredConsumed, fresh]))
    expect(remaining.map((r) => r.nonceHash)).toEqual([fresh])
  })

  it('also sweeps expired rows left in the retired handoff_pending_states table', async () => {
    const expiredId = `prune-test-${randomUUID()}`
    const freshId = `prune-test-${randomUUID()}`
    const row = (id: string, expiresAt: Date) => ({
      id,
      cookieHash: `cookie-${id}`,
      jti: `jti-${id}`,
      providerName: 'centralizeme-handoff',
      externalSubject: 'user_prune_test',
      organizationId: 'org_prune_test',
      claimsVersion: 1,
      expiresAt,
    })
    await getDb()
      .insert(handoffPendingStates)
      .values([
        row(expiredId, new Date(Date.now() - 1000)),
        row(freshId, new Date(Date.now() + 120_000)),
      ])

    await pruneHandoffNonces()

    const remaining = await getDb()
      .select({ id: handoffPendingStates.id })
      .from(handoffPendingStates)
      .where(inArray(handoffPendingStates.id, [expiredId, freshId]))
    expect(remaining.map((r) => r.id)).toEqual([freshId])
    await getDb()
      .delete(handoffPendingStates)
      .where(inArray(handoffPendingStates.id, [freshId]))
  })

  it('unschedules the retired pending-state prune job by its exact name', () => {
    expect(RETIRED_HANDOFF_PRUNE_SCHEDULES).toEqual(['prune-handoff-pending-states'])
  })
})
