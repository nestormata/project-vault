import { randomInt } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { userIdentityTokens } from '@project-vault/db/schema'

// eslint-disable-next-line no-secrets/no-secrets -- Public alias alphabet, not a secret.
const ALIAS_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ALIAS_RANDOM_CHARS = 8
const MAX_COLLISION_ATTEMPTS = 5

/**
 * Story 8.4 D3: crypto-random (never Math.random()) 8-char lowercase-alphanumeric alias,
 * `user_<8 chars>`. Uses node:crypto's `randomInt` (unbiased, CSPRNG-backed) rather than the
 * codebase's base64url token helpers (opaque-token.ts/tokens.ts), since those produce a
 * mixed-case + punctuation alphabet unsuited to a human-readable display-name alias.
 */
export function generatePseudonymAlias(): string {
  let suffix = ''
  for (let i = 0; i < ALIAS_RANDOM_CHARS; i += 1) {
    suffix += ALIAS_ALPHABET[randomInt(ALIAS_ALPHABET.length)]
  }
  return `user_${suffix}`
}

export class PseudonymAliasCollisionError extends Error {
  constructor(userId: string) {
    super(
      `pseudonymizeUserIdentityToken: exhausted ${MAX_COLLISION_ATTEMPTS} alias-collision retries for user ${userId}`
    )
    this.name = 'PseudonymAliasCollisionError'
  }
}

/**
 * D3 collision guard: checks the candidate alias against every *other* row's display_name inside
 * the same transaction before it is committed, retrying up to MAX_COLLISION_ATTEMPTS times. A
 * collision would otherwise let two different pseudonymized users share one audit-search display
 * alias (Story 8.2), silently and undetectably.
 */
async function generateUniqueAlias(
  tx: Tx,
  userId: string,
  excludeTokenId: string,
  generateAlias: () => string
): Promise<string> {
  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = generateAlias()
    const [collision] = await tx
      .select({ id: userIdentityTokens.id })
      .from(userIdentityTokens)
      .where(
        and(
          eq(userIdentityTokens.displayName, candidate),
          ne(userIdentityTokens.id, excludeTokenId)
        )
      )
      .limit(1)
    if (!collision) return candidate
  }
  throw new PseudonymAliasCollisionError(userId)
}

/**
 * Story 8.4 D3: standalone, reusable pseudonymization primitive — built here so Story 8.3's
 * future `POST /pseudonymize` endpoint can call this exact function instead of duplicating it.
 *
 * Finds ALL `user_identity_tokens` rows for `userId` (no unique constraint on user_id exists in
 * the current schema — do not assume uniqueness) and, for each, replaces `display_name` with a
 * fresh crypto-random alias and sets `pseudonymized_at = now()`.
 *
 * Idempotent-as-a-true-no-op (corrected from this story's original AC-E8d wording — see Dev
 * Notes "Discovered contradiction" entry): migration 0001_rls_and_triggers.sql's
 * `enforce_pseudonym_immutability` trigger already rejects ANY `display_name` change once
 * `pseudonymized_at` is set ("GDPR erasure is permanent" — a genuine, deliberate, already-shipped
 * DB-level guarantee, not a bug to route around). Re-running this function against a row that is
 * already pseudonymized therefore returns that row's existing alias unchanged rather than
 * attempting a second write, which the trigger would unconditionally reject. Only never-before-
 * pseudonymized rows generate and commit a fresh alias.
 *
 * Never touches `audit_log_entries` — the FK (`actor_token_id`) is stable; only the referenced
 * row's `display_name` changes, which `computeAuditHmac` never includes in its field list, so no
 * HMAC is invalidated (confirmed by reading write-entry.ts's canonical-JSON input, D3/Task 2.2).
 */
export async function pseudonymizeUserIdentityToken(
  tx: Tx,
  userId: string,
  opts: { generateAlias?: () => string } = {}
): Promise<{ tokenId: string; alias: string }[]> {
  const generateAlias = opts.generateAlias ?? generatePseudonymAlias
  const rows = await tx
    .select({
      id: userIdentityTokens.id,
      displayName: userIdentityTokens.displayName,
      pseudonymizedAt: userIdentityTokens.pseudonymizedAt,
    })
    .from(userIdentityTokens)
    .where(eq(userIdentityTokens.userId, userId))

  const results: { tokenId: string; alias: string }[] = []
  for (const row of rows) {
    if (row.pseudonymizedAt) {
      // Already pseudonymized: the DB trigger blocks changing display_name again — return the
      // existing alias unchanged rather than attempting a write guaranteed to be rejected.
      results.push({ tokenId: row.id, alias: row.displayName })
      continue
    }
    const alias = await generateUniqueAlias(tx, userId, row.id, generateAlias)
    const pseudonymizedAt = new Date()
    await tx
      .update(userIdentityTokens)
      .set({ displayName: alias, pseudonymizedAt, updatedAt: pseudonymizedAt })
      .where(eq(userIdentityTokens.id, row.id))
    results.push({ tokenId: row.id, alias })
  }
  return results
}
