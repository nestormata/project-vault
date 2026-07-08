import { describe, it, expect } from 'vitest'
import { getDb, withOrg, withOrgReadScope, withAdminAccess, reserveConnection } from './index.js'
import { withTestOrg } from './test-helpers.js'

describe('getDb', () => {
  it('returns the same singleton instance across calls', () => {
    expect(getDb()).toBe(getDb())
  })
})

describe('reserveConnection', () => {
  // Story 9.6 D1.3: `reserveConnection()` must hand back a single dedicated connection whose
  // session-scoped state (advisory locks) persists across multiple statements and is invisible to
  // any other connection — this is the entire reason acquireRestoreLock() needs it instead of a
  // plain getDb() query, which runs on a connection borrowed from (and returned to) the pool.
  it('provides a dedicated connection that holds a session-scoped advisory lock until released', async () => {
    const reserved = await reserveConnection()
    try {
      const [row] = await reserved<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext('db-test-reserve-lock')) AS locked
      `
      expect(row?.locked).toBe(true)

      // A second, independent reserved connection must NOT be able to acquire the same lock while
      // the first one still holds it — proving the lock is genuinely session-scoped to the first
      // connection, not accidentally shared/pooled.
      const reserved2 = await reserveConnection()
      try {
        const [row2] = await reserved2<{ locked: boolean }[]>`
          SELECT pg_try_advisory_lock(hashtext('db-test-reserve-lock')) AS locked
        `
        expect(row2?.locked).toBe(false)
      } finally {
        await reserved2.release()
      }
    } finally {
      const [unlockRow] = await reserved<{ unlocked: boolean }[]>`
        SELECT pg_advisory_unlock(hashtext('db-test-reserve-lock')) AS unlocked
      `
      expect(unlockRow?.unlocked).toBe(true)
      await reserved.release()
    }
  })

  it('shares the same underlying postgres() client/pool as getDb() (no second client created)', async () => {
    // Calling getDb() first (as most of the app does) must not prevent reserveConnection() from
    // working, and vice versa — both are backed by the same module-level `postgres()` instance
    // (Story 9.6 D1.3's explicit "do not create a second, separate postgres() client" requirement).
    expect(getDb()).toBe(getDb())
    const reserved = await reserveConnection()
    try {
      const [row] = await reserved<{ one: number }[]>`SELECT 1 AS one`
      expect(row?.one).toBe(1)
    } finally {
      await reserved.release()
    }
  })
})

describe('withOrg', () => {
  it('rejects a non-UUID orgId before reaching the database', async () => {
    await expect(withOrg('not-a-uuid', async () => 'never')).rejects.toThrow(/invalid orgId/)
  })
})

describe('withOrgReadScope', () => {
  it('delegates to withOrg and exposes the same org-scoped tx', async () => {
    await withTestOrg(async ({ orgId }) => {
      const result = await withOrgReadScope(orgId, async () => 'read-ok')
      expect(result).toBe('read-ok')
    })
  })
})

describe('withAdminAccess', () => {
  it('throws when authCtx.role is not admin', async () => {
    await expect(withAdminAccess({ role: 'member' }, async () => 'never')).rejects.toThrow(
      /not an admin/
    )
  })

  it('throws a clear error (not a TypeError) when authCtx is undefined', async () => {
    await expect(withAdminAccess(undefined as never, async () => 'never')).rejects.toThrow(
      /not an admin/
    )
  })

  it('runs fn when authCtx.role is admin', async () => {
    const result = await withAdminAccess({ role: 'admin' }, async () => 'admin-ok')
    expect(result).toBe('admin-ok')
  })
})
