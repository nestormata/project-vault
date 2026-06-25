import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../index.js'
import { userIdentityTokens } from '../schema/index.js'

describe('user_identity_tokens pseudonymization immutability', () => {
  it('allows updating display_name before pseudonymization', async () => {
    const [row] = await getDb()
      .insert(userIdentityTokens)
      .values({ displayName: 'alice@example.com' })
      .returning()
    const id = row?.id as string

    try {
      await getDb()
        .update(userIdentityTokens)
        .set({ displayName: 'alice-renamed@example.com' })
        .where(eq(userIdentityTokens.id, id))

      const [updated] = await getDb()
        .select()
        .from(userIdentityTokens)
        .where(eq(userIdentityTokens.id, id))
      expect(updated?.displayName).toBe('alice-renamed@example.com')
    } finally {
      await getDb().delete(userIdentityTokens).where(eq(userIdentityTokens.id, id))
    }
  })

  it('throws when reversing display_name after pseudonymization', async () => {
    const [row] = await getDb()
      .insert(userIdentityTokens)
      .values({ displayName: 'pseudonym-abc123', pseudonymizedAt: new Date() })
      .returning()
    const id = row?.id as string

    try {
      await expect(
        getDb()
          .update(userIdentityTokens)
          .set({ displayName: 'bob@example.com' })
          .where(eq(userIdentityTokens.id, id))
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/GDPR erasure is permanent/) },
      })
    } finally {
      await getDb().delete(userIdentityTokens).where(eq(userIdentityTokens.id, id))
    }
  })

  it('allows updating other columns on a pseudonymized row', async () => {
    const [row] = await getDb()
      .insert(userIdentityTokens)
      .values({ displayName: 'pseudonym-def456', pseudonymizedAt: new Date() })
      .returning()
    const id = row?.id as string

    try {
      await getDb()
        .update(userIdentityTokens)
        .set({ userId: null })
        .where(eq(userIdentityTokens.id, id))

      const [updated] = await getDb()
        .select()
        .from(userIdentityTokens)
        .where(eq(userIdentityTokens.id, id))
      expect(updated?.userId).toBeNull()
      expect(updated?.displayName).toBe('pseudonym-def456')
    } finally {
      await getDb().delete(userIdentityTokens).where(eq(userIdentityTokens.id, id))
    }
  })
})
