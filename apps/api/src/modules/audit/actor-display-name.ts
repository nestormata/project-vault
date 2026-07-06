import { inArray } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { userIdentityTokens } from '@project-vault/db/schema'

/**
 * Shared by search (AC-1) and CSV export (AC-13) — resolves a batch of `actor_token_id`s to
 * their *current* `user_identity_tokens.display_name`, read live (not cached/frozen) so a
 * pseudonymized user's historical rows correctly show their alias after the fact (AC-13's
 * documented, intentional live-join behavior).
 */
export async function batchResolveActorDisplayNames(
  tx: Tx,
  actorTokenIds: (string | null)[]
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(actorTokenIds.filter((id): id is string => id !== null))]
  if (uniqueIds.length === 0) return new Map()
  const rows = await tx
    .select({ id: userIdentityTokens.id, displayName: userIdentityTokens.displayName })
    .from(userIdentityTokens)
    .where(inArray(userIdentityTokens.id, uniqueIds))
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

/**
 * AC-13's documented fallback chain:
 * - human actor with a resolvable token -> the live display name
 * - human actor with no token (should not occur in a clean DB, defensively handled) -> 'unknown'
 * - machine_user / system actor (actor_token_id is always null for these, Story 8.1 D3) ->
 *   the literal actor_type string
 */
export function actorDisplayNameFor(
  actorType: string,
  actorTokenId: string | null,
  displayNameByTokenId: Map<string, string>
): string {
  if (actorTokenId) return displayNameByTokenId.get(actorTokenId) ?? 'unknown'
  if (actorType === 'machine_user' || actorType === 'system') return actorType
  return 'unknown'
}
