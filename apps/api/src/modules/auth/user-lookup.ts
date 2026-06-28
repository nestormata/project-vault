import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { userIdentityTokens, users } from '@project-vault/db/schema'

export async function findUserWithIdentityByEmail(email: string) {
  return getDb()
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      mfaEnrolledAt: users.mfaEnrolledAt,
      identityTokenId: userIdentityTokens.id,
    })
    .from(users)
    .leftJoin(userIdentityTokens, eq(userIdentityTokens.userId, users.id))
    .where(eq(users.email, email))
}
