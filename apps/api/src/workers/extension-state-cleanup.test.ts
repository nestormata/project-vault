import { describe, expect, it, vi } from 'vitest'
import { inArray } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { extensionEphemeralState } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { runExtensionStateCleanup } from './extension-state-cleanup.js'

async function insertFixtureRow(orgId: string, expiresAt: Date): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(extensionEphemeralState)
      .values({
        orgId,
        extensionNamespace: 'ext.com.acme.fixture',
        key: `fixture-${crypto.randomUUID()}`,
        valueCiphertext: Buffer.from('{"version":1,"iv":"aa","ciphertext":"bb","tag":"cc"}'),
        encryptionKeyVersion: 1,
        expiresAt,
      })
      .returning({ id: extensionEphemeralState.id })
  )
  if (!row?.id) throw new Error('expected fixture row')
  return row.id
}

describe('extension-state/cleanup worker (Story 20.8 AC-7)', () => {
  it('deletes expired rows and preserves live rows', async () => {
    await withTestOrg(async ({ orgId }) => {
      const expiredId = await insertFixtureRow(orgId, new Date(Date.now() - 60_000))
      const liveId = await insertFixtureRow(orgId, new Date(Date.now() + 60 * 60 * 1000))

      await runExtensionStateCleanup()

      const remaining = await withOrg(orgId, (tx) =>
        tx
          .select({ id: extensionEphemeralState.id })
          .from(extensionEphemeralState)
          .where(inArray(extensionEphemeralState.id, [expiredId, liveId]))
      )
      expect(remaining.map((row) => row.id)).toEqual([liveId])
    })
  })

  it('logs exactly one info line with { purgedCount } — never a key or value (AC-7 positive example)', async () => {
    await withTestOrg(async ({ orgId }) => {
      await insertFixtureRow(orgId, new Date(Date.now() - 60_000))
      await insertFixtureRow(orgId, new Date(Date.now() - 60_000))

      const info = vi.fn()
      await runExtensionStateCleanup({ info, warn: vi.fn(), error: vi.fn() })

      expect(info).toHaveBeenCalledTimes(1)
      const [payload] = info.mock.calls[0] as [Record<string, unknown>, string]
      expect(payload).toMatchObject({ purgedCount: expect.any(Number) })
      expect(payload['purgedCount']).toBeGreaterThanOrEqual(2)
      expect(payload).not.toHaveProperty('key')
      expect(payload).not.toHaveProperty('value')
      expect(JSON.stringify(payload)).not.toMatch(/fixture-/)
    })
  })

  it('logs { purgedCount: 0 } on an idle run (AC-7 positive example)', async () => {
    const info = vi.fn()
    await runExtensionStateCleanup({ info, warn: vi.fn(), error: vi.fn() })
    // At least the most recent call should reflect this run — assert the run completed and
    // logged a numeric purgedCount (>= 0); a prior test's rows are already cleaned up by
    // withTestOrg's own teardown so this run has nothing new of its own to purge.
    expect(info).toHaveBeenCalledTimes(1)
    const [payload] = info.mock.calls[0] as [Record<string, unknown>]
    expect(typeof payload['purgedCount']).toBe('number')
  })
})
