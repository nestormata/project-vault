import { type Tx } from '@project-vault/db'
import { asc, eq } from 'drizzle-orm'
import { userIdentityTokens } from '@project-vault/db/schema'

export async function firstActorTokenIdForUser(tx: Tx, userId: string): Promise<string | null> {
  const rows = await tx
    .select({ id: userIdentityTokens.id })
    .from(userIdentityTokens)
    .where(eq(userIdentityTokens.userId, userId))
    .orderBy(asc(userIdentityTokens.createdAt), asc(userIdentityTokens.id))
    .limit(1)
  return rows[0]?.id ?? null
}
