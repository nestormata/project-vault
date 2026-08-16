import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { systemSettings } from '@project-vault/db/schema'
import {
  markDisabledAnnouncedIfFirst,
  readReplacementLatch,
  writeReplacementLatch,
} from './native-login-latch.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

async function resetLatchRow(): Promise<void> {
  const db = getDb()
  await db
    .update(systemSettings)
    .set({ nativeLoginReplacementProvenAt: null, nativeLoginDisabledAnnouncedAt: null })
    .where(eq(systemSettings.id, 1))
}

describe('native-login-latch (Story 23.2 AC-4a/AC-9/AC-11)', () => {
  beforeEach(async () => {
    await resetLatchRow()
  })

  it('readReplacementLatch() returns null when never proven', async () => {
    const latch = await readReplacementLatch()
    expect(latch?.replacementProvenAt ?? null).toBeNull()
  })

  it('writeReplacementLatch() sets replacementProvenAt', async () => {
    await writeReplacementLatch()
    const latch = await readReplacementLatch()
    expect(latch?.replacementProvenAt ?? null).not.toBeNull()
  })

  it('a second write does not move the timestamp (monotonic, no inverse)', async () => {
    await writeReplacementLatch()
    const first = (await readReplacementLatch())?.replacementProvenAt
    await writeReplacementLatch()
    const second = (await readReplacementLatch())?.replacementProvenAt
    expect(second).toBe(first)
  })

  it('concurrent writes from simulated racing workers produce exactly one settled timestamp', async () => {
    // Simulates N racing workers each observing their own "first success" at once — the
    // conditional UPDATE ... WHERE ... IS NULL guarantees exactly one write wins, regardless of
    // how many callers race it (AC-4a's concurrency edge case).
    await Promise.all(Array.from({ length: 8 }, () => writeReplacementLatch()))
    const latch = await readReplacementLatch()
    expect(latch?.replacementProvenAt ?? null).not.toBeNull()

    // Re-reading after the race settles must be stable — no writer clobbered another's value
    // with a later timestamp.
    const settled = latch?.replacementProvenAt
    await writeReplacementLatch()
    const after = (await readReplacementLatch())?.replacementProvenAt
    expect(after).toBe(settled)
  })

  it('markDisabledAnnouncedIfFirst() returns true exactly once across racing callers', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => markDisabledAnnouncedIfFirst())
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('markDisabledAnnouncedIfFirst() returns false on every subsequent call', async () => {
    await markDisabledAnnouncedIfFirst()
    const second = await markDisabledAnnouncedIfFirst()
    expect(second).toBe(false)
  })

  it('writeReplacementLatch() works even when no system_settings row exists yet (AC-24: table starts empty)', async () => {
    await getDb().execute(sql`DELETE FROM system_settings WHERE id = 1`)
    await writeReplacementLatch()
    const latch = await readReplacementLatch()
    expect(latch?.replacementProvenAt ?? null).not.toBeNull()
  })
})
