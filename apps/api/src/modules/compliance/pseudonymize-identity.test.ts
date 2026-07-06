import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, type Tx } from '@project-vault/db'
import { userIdentityTokens } from '@project-vault/db/schema'
import { createTestUser, deleteTestUser } from '@project-vault/db/test-helpers'
import {
  PseudonymAliasCollisionError,
  pseudonymizeUserIdentityToken,
} from './pseudonymize-identity.js'

const ALIAS_RE = /^user_[a-z0-9]{8}$/

async function identityRowsForUser(tx: Tx, userId: string) {
  return tx
    .select({
      id: userIdentityTokens.id,
      displayName: userIdentityTokens.displayName,
      pseudonymizedAt: userIdentityTokens.pseudonymizedAt,
    })
    .from(userIdentityTokens)
    .where(eq(userIdentityTokens.userId, userId))
}

describe('pseudonymizeUserIdentityToken (D3)', () => {
  it("pseudonymizes the user's single identity token row", async () => {
    const userId = await createTestUser('pseudo-single')
    try {
      const result = await getDb().transaction(async (tx) => {
        return pseudonymizeUserIdentityToken(tx as Tx, userId)
      })

      expect(result).toHaveLength(1)
      expect(result[0]?.alias).toMatch(ALIAS_RE)

      const rows = await identityRowsForUser(getDb() as unknown as Tx, userId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.displayName).toBe(result[0]?.alias)
      expect(rows[0]?.pseudonymizedAt).not.toBeNull()
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('pseudonymizes every row when a user has more than one identity token (no unique constraint on user_id)', async () => {
    const userId = await createTestUser('pseudo-multi')
    try {
      await getDb()
        .insert(userIdentityTokens)
        .values({ userId, displayName: 'second-row-original-name' })

      const result = await getDb().transaction(async (tx) => {
        return pseudonymizeUserIdentityToken(tx as Tx, userId)
      })

      expect(result).toHaveLength(2)
      for (const entry of result) expect(entry.alias).toMatch(ALIAS_RE)

      const rows = await identityRowsForUser(getDb() as unknown as Tx, userId)
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.pseudonymizedAt).not.toBeNull()
        expect(result.some((entry) => entry.alias === row.displayName)).toBe(true)
      }
    } finally {
      await deleteTestUser(userId)
    }
  })

  // Corrected from this story's original AC-E8d wording after discovering
  // migration 0001_rls_and_triggers.sql's `enforce_pseudonym_immutability` trigger, which already
  // rejects ANY display_name change once pseudonymized_at is set ("GDPR erasure is permanent" —
  // see this story's Dev Notes "Discovered contradiction" entry). Idempotent therefore means a
  // true no-op (same alias returned, no second write attempted), not "generates a fresh alias
  // every call" — the DB makes the latter impossible by design.
  it('is idempotent: re-running returns the SAME existing alias without a second write (DB trigger enforces this)', async () => {
    const userId = await createTestUser('pseudo-idempotent')
    try {
      const first = await getDb().transaction(async (tx) =>
        pseudonymizeUserIdentityToken(tx as Tx, userId)
      )
      const firstAlias = first[0]?.alias
      expect(firstAlias).toMatch(ALIAS_RE)
      const firstRows = await identityRowsForUser(getDb() as unknown as Tx, userId)
      const firstPseudonymizedAt = firstRows[0]?.pseudonymizedAt

      const second = await getDb().transaction(async (tx) =>
        pseudonymizeUserIdentityToken(tx as Tx, userId)
      )

      expect(second[0]?.alias).toBe(firstAlias)

      const secondRows = await identityRowsForUser(getDb() as unknown as Tx, userId)
      expect(secondRows[0]?.displayName).toBe(firstAlias)
      expect(secondRows[0]?.pseudonymizedAt?.getTime()).toBe(firstPseudonymizedAt?.getTime())
    } finally {
      await deleteTestUser(userId)
    }
  })

  it('retries alias generation on a display_name collision and lands on a distinct alias', async () => {
    // user_identity_tokens rows are never deleted (FK is onDelete: 'set null', not cascade — an
    // identity token is a permanent artifact even after its user row is gone, same "erasure is
    // permanent" discipline as the rest of this table). A fixed literal alias would therefore
    // collide with an orphaned row left behind by a *previous* run of this exact test, so both
    // candidates here are unique-per-run.
    const runId = randomUUID().replace(/-/g, '').slice(0, 8)
    const collidingAlias = `user_${runId.slice(0, 4)}aaaa`
    const finalAlias = `user_${runId.slice(0, 4)}bbbb`
    const userId = await createTestUser('pseudo-collision')
    const collidingUserId = await createTestUser('pseudo-collision-victim')
    try {
      await getDb()
        .update(userIdentityTokens)
        .set({ displayName: collidingAlias })
        .where(eq(userIdentityTokens.userId, collidingUserId))

      let calls = 0
      const generateAlias = () => {
        calls += 1
        return calls === 1 ? collidingAlias : finalAlias
      }

      const result = await getDb().transaction(async (tx) =>
        pseudonymizeUserIdentityToken(tx as Tx, userId, { generateAlias })
      )

      expect(calls).toBe(2)
      expect(result[0]?.alias).toBe(finalAlias)

      const rows = await identityRowsForUser(getDb() as unknown as Tx, userId)
      expect(rows[0]?.displayName).toBe(finalAlias)
    } finally {
      await deleteTestUser(userId)
      await deleteTestUser(collidingUserId)
    }
  })

  it('throws PseudonymAliasCollisionError and mutates nothing after 5 exhausted collision retries', async () => {
    const runId = randomUUID().replace(/-/g, '').slice(0, 8)
    const alwaysCollidingAlias = `user_${runId}`
    const userId = await createTestUser('pseudo-exhausted')
    try {
      const generateAlias = () => alwaysCollidingAlias
      // Pre-seed the colliding alias on a different user so every attempt collides.
      const victimId = await createTestUser('pseudo-exhausted-victim')
      try {
        await getDb()
          .update(userIdentityTokens)
          .set({ displayName: alwaysCollidingAlias })
          .where(eq(userIdentityTokens.userId, victimId))

        await expect(
          getDb().transaction(async (tx) =>
            pseudonymizeUserIdentityToken(tx as Tx, userId, { generateAlias })
          )
        ).rejects.toBeInstanceOf(PseudonymAliasCollisionError)

        const rows = await identityRowsForUser(getDb() as unknown as Tx, userId)
        expect(rows[0]?.pseudonymizedAt).toBeNull()
      } finally {
        await deleteTestUser(victimId)
      }
    } finally {
      await deleteTestUser(userId)
    }
  })
})
