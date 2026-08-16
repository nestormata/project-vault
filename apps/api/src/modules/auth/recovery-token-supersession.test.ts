import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { accountRecoveryTokens, users } from '@project-vault/db/schema'
import { supersedeAllPriorRecoveryTokensForExclusion } from './recovery-lookup.js'

/**
 * Story 23.2 AC-6 ("pre-staging is closed retroactively, not just prospectively"). Real-DB
 * integration test for the sweep itself, independent of native-login-policy.ts's wiring (covered
 * separately in native-login-policy.test.ts with a mocked collaborator).
 */
async function seedUser(): Promise<string> {
  const [user] = await getDb()
    .insert(users)
    .values({ email: `presweep-${randomUUID()}@example.com`, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!user) throw new Error('expected user row')
  return user.id
}

async function seedToken(
  userId: string,
  overrides: Partial<{ usedAt: Date | null; supersededAt: Date | null; expiresAt: Date }> = {}
): Promise<string> {
  const [token] = await getDb()
    .insert(accountRecoveryTokens)
    .values({
      userId,
      tokenHash: randomUUID(),
      initiatedBy: 'self',
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      usedAt: overrides.usedAt ?? null,
      supersededAt: overrides.supersededAt ?? null,
    })
    .returning({ id: accountRecoveryTokens.id })
  if (!token) throw new Error('expected token row')
  return token.id
}

async function loadToken(id: string) {
  const [row] = await getDb()
    .select()
    .from(accountRecoveryTokens)
    .where(eq(accountRecoveryTokens.id, id))
  if (!row) throw new Error('expected token row on reload')
  return row
}

describe('supersedeAllPriorRecoveryTokensForExclusion (AC-6 pre-staging retroactive close)', () => {
  it('supersedes an un-redeemed, unexpired token minted before the exclusion took effect', async () => {
    const userId = await seedUser()
    const tokenId = await seedToken(userId)

    await supersedeAllPriorRecoveryTokensForExclusion()

    const reloaded = await loadToken(tokenId)
    expect(reloaded.supersededAt).not.toBeNull()
  })

  it('leaves an already-used token untouched (its usedAt is authoritative, not supersededAt)', async () => {
    const userId = await seedUser()
    const tokenId = await seedToken(userId, { usedAt: new Date() })

    await supersedeAllPriorRecoveryTokensForExclusion()

    const reloaded = await loadToken(tokenId)
    expect(reloaded.supersededAt).toBeNull()
  })

  it('leaves an already-expired token untouched (nothing to supersede — it already refuses)', async () => {
    const userId = await seedUser()
    const tokenId = await seedToken(userId, { expiresAt: new Date(Date.now() - 60 * 60 * 1000) })

    await supersedeAllPriorRecoveryTokensForExclusion()

    const reloaded = await loadToken(tokenId)
    expect(reloaded.supersededAt).toBeNull()
  })

  it('is idempotent: a second sweep over an already-superseded row is a no-op, no error', async () => {
    const userId = await seedUser()
    const tokenId = await seedToken(userId)

    await supersedeAllPriorRecoveryTokensForExclusion()
    const first = await loadToken(tokenId)

    await supersedeAllPriorRecoveryTokensForExclusion()
    const second = await loadToken(tokenId)

    expect(second.supersededAt?.getTime()).toBe(first.supersededAt?.getTime())
  })

  it('spans every user, not just one org or one user (the whole point of the retroactive close)', async () => {
    const userA = await seedUser()
    const userB = await seedUser()
    const tokenA = await seedToken(userA)
    const tokenB = await seedToken(userB)

    await supersedeAllPriorRecoveryTokensForExclusion()

    const [reloadedA, reloadedB] = await Promise.all([loadToken(tokenA), loadToken(tokenB)])
    expect(reloadedA.supersededAt).not.toBeNull()
    expect(reloadedB.supersededAt).not.toBeNull()
  })
})
