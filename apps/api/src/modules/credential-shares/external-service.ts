import { and, eq, inArray, sql } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { credentials, credentialShares, users } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { getAdminDb } from '../../lib/db.js'
import { writeSystemAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { credentialExistsInProject } from '../credentials/db-helpers.js'
import { revealCurrentValue } from '../credentials/service.js'
import {
  claimSingleUseView,
  generateShareToken,
  hashShareToken,
  validateFieldKey,
  type CredentialShareRow,
} from './service.js'
import {
  EXTERNAL_SHARE_MAX_REVEAL_ATTEMPTS,
  EXTERNAL_SHARE_MAX_TTL_MS,
  MAX_PENDING_EXTERNAL_SHARES_PER_FIELD,
} from './schema.js'

/**
 * Story 17.2 AC-7/AC-8, Task 1.1: RLS exception — module-level documentation of the "org unknown
 * until the token resolves" problem. `credential_shares` DOES have `org_id` (unlike the
 * `sessions`/`refresh_tokens` conceptual precedent cited in architecture.md's "RLS exception
 * tables", which have no `org_id` column at all and are wholesale-excluded from RLS coverage via
 * `EXCLUDED_TABLES`), so this module must NOT add `credential_shares` there — that would remove
 * RLS protection for 17.1's session-authenticated rows too. Instead this follows the mechanically
 * correct precedent already implemented in this codebase: Story 6.3's public status page
 * (`apps/api/src/modules/monitoring/status-page-service.ts#findStatusPageByTokenHash` +
 * `public-status-page-routes.ts`). Exactly ONE query in this entire module runs on the admin
 * connection (`getAdminDb()`) — the initial point-lookup by the unique hashed-token index below,
 * in `adminLookupByTokenHash`. Every other query in this module re-scopes via `withOrg(orgId,
 * ...)` once that lookup has resolved which org the share belongs to.
 */
async function adminLookupByTokenHash(tokenHash: string): Promise<CredentialShareRow | null> {
  const [row] = await getAdminDb()
    .select()
    .from(credentialShares)
    .where(eq(credentialShares.tokenHash, tokenHash))
    .limit(1)
  return row ?? null
}

export type CreateExternalShareInput = {
  orgId: string
  projectId: string
  credentialId: string
  sharedByUserId: string
  recipientEmail: string
  fieldKey?: string
  expiresAt: Date
}

export type CreateExternalShareResult =
  | { status: 'credential_not_found' }
  | { status: 'unknown_field_key'; field: string }
  | { status: 'expires_at_invalid'; reason: 'past' | 'too_far_in_future' }
  | { status: 'cap_exceeded' }
  | { status: 'ok'; share: CredentialShareRow; token: string }

/** Story 17.2 AC-1/AC-4/AC-5/AC-16: creates a `recipient_type = 'external'` share. Eligibility
 *  (AC-2, reuses `rejectIfInsufficientProjectRoleForReveal`) and step-up re-auth (AC-3) are
 *  enforced by the route before this is called. `singleUse` is never a parameter here — always
 *  hard-coded `true` (AC-5). `recipientEmail` is stored lowercased/trimmed; this function never
 *  resolves it to an existing org member's `recipient_user_id` (AC-1's explicit non-goal). */
export async function createExternalCredentialShare(
  tx: Tx,
  input: CreateExternalShareInput
): Promise<CreateExternalShareResult> {
  const exists = await credentialExistsInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!exists) return { status: 'credential_not_found' }

  const fieldValidation = await validateFieldKey(tx, input.credentialId, input.fieldKey)
  if (!fieldValidation.ok) return { status: 'unknown_field_key', field: fieldValidation.field }

  const now = Date.now()
  if (input.expiresAt.getTime() <= now) return { status: 'expires_at_invalid', reason: 'past' }
  if (input.expiresAt.getTime() > now + EXTERNAL_SHARE_MAX_TTL_MS) {
    return { status: 'expires_at_invalid', reason: 'too_far_in_future' }
  }

  // AC-16: cap check + insert in the same transaction as the caller's own — avoids a TOCTOU gap
  // on the cap itself (two concurrent creations at the boundary can't both slip past the count).
  const fieldCondition = fieldValidation.normalized
    ? eq(credentialShares.fieldKey, fieldValidation.normalized)
    : sql`${credentialShares.fieldKey} IS NULL`
  const countRows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(credentialShares)
    .where(
      and(
        eq(credentialShares.credentialId, input.credentialId),
        eq(credentialShares.recipientType, 'external'),
        fieldCondition,
        // AC-16: "status IN ('active','pending')" — this schema's real initial-status value is
        // 'active' (there is no literal 'pending' status; see Dev Notes' status-enum note), so
        // the not-yet-resolved bucket this cap counts is exactly `status = 'active'`.
        inArray(credentialShares.status, ['active'])
      )
    )
  const pendingCount = Number(countRows[0]?.count ?? 0)
  if (pendingCount >= MAX_PENDING_EXTERNAL_SHARES_PER_FIELD) return { status: 'cap_exceeded' }

  const rawToken = generateShareToken()
  const tokenHash = hashShareToken(rawToken)

  const [share] = await tx
    .insert(credentialShares)
    .values({
      orgId: input.orgId,
      credentialId: input.credentialId,
      fieldKey: fieldValidation.normalized,
      sharedBy: input.sharedByUserId,
      recipientType: 'external',
      recipientUserId: null,
      recipientEmail: input.recipientEmail.trim().toLowerCase(),
      tokenHash,
      singleUse: true,
      expiresAt: input.expiresAt,
      status: 'active',
    })
    .returning()
  if (!share) throw new Error('createExternalCredentialShare: insert returned no row')

  return { status: 'ok', share, token: rawToken }
}

/** AC-9: "sharer display name — not email", derived from the email local-part (there is no
 *  dedicated display-name column on `users`) so an unauthenticated party never learns the
 *  sharer's actual address. */
function displayNameFromEmail(email: string | null): string {
  if (!email) return 'A teammate'
  return email.split('@')[0] ?? email
}

export type ExternalShareMetadata = {
  share: CredentialShareRow
  credentialName: string
  credentialProjectId: string
  sharedByDisplayName: string
}

export type FindExternalShareResult =
  { status: 'not_found' } | { status: 'ok'; metadata: ExternalShareMetadata }

/**
 * AC-8/AC-9/AC-17: the external metadata GET's lookup — org-unknown-until-token-resolves (Task
 * 1), timing-safe (AC-17: hash + query unconditionally, no early-return on "malformed" tokens —
 * `hashShareToken` always runs before this function ever branches on its result), and applies the
 * same lazy active->expired transition PR #251 taught 17.1's own `findShareByToken` to apply, from
 * this function's first commit rather than as a follow-up fix. Never mutates `view_count`,
 * `first_viewed_at`, or the reveal-attempt counter (AC-9/AC-22) — a crawler prefetch is harmless.
 */
export async function findExternalShareByTokenHash(
  rawToken: string
): Promise<FindExternalShareResult> {
  const tokenHash = hashShareToken(rawToken)
  const row = await adminLookupByTokenHash(tokenHash)
  if (!row || row.recipientType !== 'external') return { status: 'not_found' }

  return withOrg(row.orgId, async (tx) => {
    const [joined] = await tx
      .select({
        share: credentialShares,
        credentialName: credentials.name,
        credentialProjectId: credentials.projectId,
        sharedByEmail: users.email,
      })
      .from(credentialShares)
      .innerJoin(credentials, eq(credentialShares.credentialId, credentials.id))
      .leftJoin(users, eq(credentialShares.sharedBy, users.id))
      .where(eq(credentialShares.id, row.id))
      .limit(1)
    if (!joined) return { status: 'not_found' }

    let share = joined.share
    if (share.status === 'active' && share.expiresAt.getTime() <= Date.now()) {
      const [updated] = await tx
        .update(credentialShares)
        .set({ status: 'expired' })
        .where(and(eq(credentialShares.id, share.id), eq(credentialShares.status, 'active')))
        .returning()
      share = updated ?? share
    }

    return {
      status: 'ok',
      metadata: {
        share,
        credentialName: joined.credentialName,
        credentialProjectId: joined.credentialProjectId,
        sharedByDisplayName: displayNameFromEmail(joined.sharedByEmail),
      },
    }
  })
}

export type RevealExternalShareResult =
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'already_viewed' }
  | { status: 'revoked' }
  | { status: 'ok'; share: CredentialShareRow; value: string; fieldKey: string | null }

/** AC-22: increments the resolved share's reveal-attempt counter and auto-revokes on exceeding
 *  the cap. Called only once the token has already resolved to a real row (never on a
 *  hash-mismatch — that would let an attacker exhaust a *different*, unrelated share's budget by
 *  guessing garbage tokens). Never surfaced in the response — the caller only ever sees the same
 *  generic terminal status a genuinely-expired/revoked/already-viewed share would produce. */
async function recordLosingAttempt(tx: Tx, share: CredentialShareRow): Promise<CredentialShareRow> {
  const [updated] = await tx
    .update(credentialShares)
    .set({ revealAttemptCount: sql`${credentialShares.revealAttemptCount} + 1` })
    .where(eq(credentialShares.id, share.id))
    .returning()
  const current = updated ?? share
  // AC-22: exceeding the cap auto-revokes regardless of the share's current terminal status
  // (viewed/expired/active) — an attacker hammering an already-consumed token is exactly the
  // pattern this cap defends against, not only a still-active one. Idempotent no-op if already
  // revoked (matches AC-6's revoke semantics).
  if (
    current.status !== 'revoked' &&
    current.revealAttemptCount >= EXTERNAL_SHARE_MAX_REVEAL_ATTEMPTS
  ) {
    const [revoked] = await tx
      .update(credentialShares)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(credentialShares.id, current.id), sql`${credentialShares.status} <> 'revoked'`))
      .returning()
    return revoked ?? current
  }
  return current
}

/**
 * AC-8/AC-13/AC-17/AC-22: the external reveal-step. Timing-safe lookup (AC-17), field-existence
 * check BEFORE the atomic claim (PR #251's fixed ordering — do not reintroduce the single-use-
 * burn-on-missing-field bug in this new code path), atomic `claimSingleUseView` reuse (AC-13,
 * verified generic over `recipient_type`). A "losing" claim-attempt (resolved to a real row, but
 * the share was already terminal or lost the atomic-claim race) increments AC-22's per-token
 * attempt counter; a field-removed-since-creation case does NOT count against that cap (it never
 * reaches the atomic-claim step at all, consistent with PR #251's ordering fix — the recipient
 * isn't at fault for a field renamed out from under them).
 */
/** Extracted from `revealExternalShare` to keep its own cyclomatic complexity under this repo's
 *  eslint threshold. Returns a terminal RevealExternalShareResult (recording the AC-22 losing
 *  attempt as it does) when the share isn't claimable, or `undefined`/the possibly-lazily-expired
 *  share when the caller should proceed to the field check + atomic claim. */
async function precheckExternalShareClaimable(
  tx: Tx,
  share: CredentialShareRow
): Promise<{ result: RevealExternalShareResult } | { share: CredentialShareRow }> {
  if (share.status === 'revoked') {
    await recordLosingAttempt(tx, share)
    return { result: { status: 'revoked' } }
  }
  if (share.status === 'viewed') {
    await recordLosingAttempt(tx, share)
    return { result: { status: 'already_viewed' } }
  }
  if (share.status === 'expired' || share.status === 'superseded') {
    await recordLosingAttempt(tx, share)
    return { result: { status: 'expired' } }
  }
  if (share.expiresAt.getTime() <= Date.now()) {
    const [expired] = await tx
      .update(credentialShares)
      .set({ status: 'expired' })
      .where(and(eq(credentialShares.id, share.id), eq(credentialShares.status, 'active')))
      .returning()
    const lazilyExpired = expired ?? share
    await recordLosingAttempt(tx, lazilyExpired)
    return { result: { status: 'expired' } }
  }
  return { share }
}

/** Extracted from `revealExternalShare` for the same complexity-ceiling reason as
 *  `precheckExternalShareClaimable` above: resolves a lost atomic claim (AC-22 losing attempt) to
 *  the correct terminal outcome by re-reading the share's current status. */
async function resolveLostExternalClaim(
  tx: Tx,
  share: CredentialShareRow
): Promise<RevealExternalShareResult> {
  const [reread] = await tx
    .select()
    .from(credentialShares)
    .where(eq(credentialShares.id, share.id))
    .limit(1)
  const lost = reread ?? share
  await recordLosingAttempt(tx, lost)
  if (lost.status === 'revoked') return { status: 'revoked' }
  if (lost.status === 'expired') return { status: 'expired' }
  return { status: 'already_viewed' }
}

export async function revealExternalShare(rawToken: string): Promise<RevealExternalShareResult> {
  const tokenHash = hashShareToken(rawToken)
  const row = await adminLookupByTokenHash(tokenHash)
  if (!row || row.recipientType !== 'external') return { status: 'not_found' }

  return withOrg(row.orgId, async (tx) => {
    const [current] = await tx
      .select()
      .from(credentialShares)
      .where(eq(credentialShares.id, row.id))
      .limit(1)
    if (!current) return { status: 'not_found' }

    const precheck = await precheckExternalShareClaimable(tx, current)
    if ('result' in precheck) return precheck.result
    const { share } = precheck

    // Field-existence check BEFORE the atomic claim — the PR #251 ordering fix, applied here from
    // this function's first commit. NOT counted as an AC-22 losing attempt: this never reaches
    // the atomic-claim step.
    const [credentialRow] = await tx
      .select({ projectId: credentials.projectId })
      .from(credentials)
      .where(eq(credentials.id, share.credentialId))
      .limit(1)
    const revealed = credentialRow
      ? await revealCurrentValue(tx, {
          credentialId: share.credentialId,
          projectId: credentialRow.projectId,
          field: share.fieldKey ?? undefined,
        })
      : { status: 'not_found' as const }
    if (revealed.status !== 'found') return { status: 'expired' }

    const claimed = await claimSingleUseView(tx, share.id)
    if (!claimed) return resolveLostExternalClaim(tx, share)

    // AC-11: the CREDENTIAL_SHARE_VIEWED audit write happens INSIDE this same `withOrg`
    // transaction as the atomic claim above — not in a separate transaction opened later by the
    // route handler. Unlike 17.1's session-bound reveal (which shares `secureCtx.tx` across the
    // claim and its audit write), this route has `requireAuth: false` and therefore no
    // `SecureRouteContext`/`tx` of its own to hand the route a transaction to audit into; if the
    // audit write happened in a *separate*, later transaction (as a first pass of this code did),
    // an audit-write failure could no longer roll back the already-committed single-use claim —
    // burning the recipient's one-time access with no value ever returned and no way to retry.
    // Writing the audit entry here, before this transaction commits, preserves true fail-closed
    // semantics: an audit failure rolls back the claim atomically, so the share remains `active`
    // and the recipient can retry once the underlying audit-write problem is resolved.
    await writeSystemAuditEntryOrFailClosed(tx, {
      orgId: row.orgId,
      eventType: AuditEvent.CREDENTIAL_SHARE_VIEWED,
      resourceId: claimed.id,
      resourceType: 'credential_share',
      payload: {
        credentialId: claimed.credentialId,
        fieldKey: share.fieldKey,
        viewCount: claimed.viewCount,
        recipientType: 'external',
      },
    })

    const value = revealed.kind === 'value' ? revealed.value : JSON.stringify(revealed.fields)
    return { status: 'ok', share: claimed, value, fieldKey: share.fieldKey }
  })
}
