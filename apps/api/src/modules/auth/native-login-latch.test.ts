import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { systemSettings } from '@project-vault/db/schema'
import {
  isLatchProvenForExtension,
  markDisabledAnnouncedIfFirst,
  readReplacementLatch,
  writeReplacementLatch,
} from './native-login-latch.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

const EXTENSION_A = 'test.mock-envelope-extension'
const EXTENSION_B = 'test.mock-sso-extension'

async function resetLatchRow(): Promise<void> {
  const db = getDb()
  await db
    .update(systemSettings)
    .set({
      nativeLoginReplacementProvenAt: null,
      nativeLoginReplacementProvenByExtension: null,
      nativeLoginDisabledAnnouncedAt: null,
    })
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

  it('writeReplacementLatch() sets replacementProvenAt and provenByExtension', async () => {
    await writeReplacementLatch(EXTENSION_A)
    const latch = await readReplacementLatch()
    expect(latch?.replacementProvenAt ?? null).not.toBeNull()
    expect(latch?.provenByExtension).toBe(EXTENSION_A)
  })

  it('a second write does not move the timestamp (monotonic, no inverse)', async () => {
    await writeReplacementLatch(EXTENSION_A)
    const first = (await readReplacementLatch())?.replacementProvenAt
    await writeReplacementLatch(EXTENSION_A)
    const second = (await readReplacementLatch())?.replacementProvenAt
    expect(second).toBe(first)
  })

  // Story 23.2 fix (code review): a later write from a DIFFERENT extension than the one that
  // first proved it must never overwrite the original proof — that would let extension B
  // silently inherit extension A's proof for itself.
  it('a write from a different extension after the latch is already set does not overwrite the original extension identity', async () => {
    await writeReplacementLatch(EXTENSION_A)
    await writeReplacementLatch(EXTENSION_B)
    const latch = await readReplacementLatch()
    expect(latch?.provenByExtension).toBe(EXTENSION_A)
  })

  it('concurrent writes from simulated racing workers produce exactly one settled timestamp and extension identity', async () => {
    // Simulates N racing workers each observing their own "first success" at once — the
    // conditional UPDATE ... WHERE ... IS NULL guarantees exactly one write wins, regardless of
    // how many callers race it (AC-4a's concurrency edge case).
    await Promise.all(Array.from({ length: 8 }, () => writeReplacementLatch(EXTENSION_A)))
    const latch = await readReplacementLatch()
    expect(latch?.replacementProvenAt ?? null).not.toBeNull()
    expect(latch?.provenByExtension).toBe(EXTENSION_A)

    // Re-reading after the race settles must be stable — no writer clobbered another's value
    // with a later timestamp.
    const settled = latch?.replacementProvenAt
    await writeReplacementLatch(EXTENSION_A)
    const after = (await readReplacementLatch())?.replacementProvenAt
    expect(after).toBe(settled)
  })

  describe('isLatchProvenForExtension()', () => {
    it('is false when nothing has ever been proven', () => {
      expect(isLatchProvenForExtension(null, EXTENSION_A)).toBe(false)
      expect(
        isLatchProvenForExtension(
          { replacementProvenAt: null, provenByExtension: null },
          EXTENSION_A
        )
      ).toBe(false)
    })

    it('is true when the loaded extension matches the extension that proved it', () => {
      expect(
        isLatchProvenForExtension(
          { replacementProvenAt: new Date().toISOString(), provenByExtension: EXTENSION_A },
          EXTENSION_A
        )
      ).toBe(true)
    })

    it('is false when a DIFFERENT extension is loaded than the one that proved it (the finding this fixes)', () => {
      expect(
        isLatchProvenForExtension(
          { replacementProvenAt: new Date().toISOString(), provenByExtension: EXTENSION_A },
          EXTENSION_B
        )
      ).toBe(false)
    })

    it('is false when nothing is loaded, even if a proof exists on record', () => {
      expect(
        isLatchProvenForExtension(
          { replacementProvenAt: new Date().toISOString(), provenByExtension: EXTENSION_A },
          null
        )
      ).toBe(false)
    })

    it('is false for a legacy pre-fix row (provenAt set, provenByExtension NULL)', () => {
      expect(
        isLatchProvenForExtension(
          { replacementProvenAt: new Date().toISOString(), provenByExtension: null },
          EXTENSION_A
        )
      ).toBe(false)
    })
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
    await writeReplacementLatch(EXTENSION_A)
    const latch = await readReplacementLatch()
    expect(latch?.replacementProvenAt ?? null).not.toBeNull()
    expect(latch?.provenByExtension).toBe(EXTENSION_A)
  })
})
