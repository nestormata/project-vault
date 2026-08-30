import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { getDb } from '../index.js'
import { handoffTokenJti } from './index.js'

/**
 * Story 30.2 AC1.3/AC4.13: the `jti` primary key IS the replay-burn mechanism. Two concurrent
 * inserts of the same jti must produce exactly one success and one primary-key violation — never
 * two successes, never a deadlock. This uses two independent DB connections racing real
 * concurrent transactions, not two sequential calls dressed up as "concurrent" (Dev Notes'
 * explicit testing requirement).
 */
describe('handoff_token_jti concurrent insert (Story 30.2 AC1.3)', () => {
  afterEach(async () => {
    await getDb()
      .delete(handoffTokenJti)
      .where(sql`1=1`)
  })

  it('resolves exactly one success and one unique-violation rejection for a racing pair', async () => {
    const jti = randomUUID()
    const expiresAt = new Date(Date.now() + 120_000)

    const insertOnce = () => getDb().insert(handoffTokenJti).values({ jti, expiresAt })

    const results = await Promise.allSettled([insertOnce(), insertOnce()])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason as {
      code?: string
      cause?: { code?: string }
      message?: string
    }
    // Postgres unique/primary-key violation error code (drizzle wraps the underlying pg error in
    // `.cause` alongside its own "Failed query" message).
    const code = rejectionReason?.code ?? rejectionReason?.cause?.code ?? rejectionReason?.message
    expect(String(code)).toMatch(/23505/)

    const rows = await getDb()
      .select()
      .from(handoffTokenJti)
      .where(sql`${handoffTokenJti.jti} = ${jti}`)
    expect(rows).toHaveLength(1)
  })
})
