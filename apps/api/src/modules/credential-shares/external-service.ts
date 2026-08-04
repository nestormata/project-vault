import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { credentialShares } from '@project-vault/db/schema'
import { AuditEvent } from '@project-vault/shared'
import { getAdminDb } from '../../lib/db.js'
import { writeSystemAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { credentialExistsInProject } from '../credentials/db-helpers.js'
import { serializeBounded } from '../credentials/bounded-share-adapter.js'
import {
  baseShareInsertValues,
  claimSingleUseView,
  effectiveAttributeKeysForShare,
  generateAndHashShareToken,
  hashShareToken,
  lazilyExpireShareIfDue,
  shareWithCredentialAndSharerQuery,
  validateShareFieldAndExpiry,
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

/** Extracted from `createExternalCredentialShare` purely to keep its own cyclomatic complexity
 *  under this repo's eslint threshold. AC-16's pending-share cap bucket, keyed by whichever share
 *  scope was actually named (`fieldKey`, `attributeKeys`, or neither/whole-resource) — see the
 *  caller's own comment for why `attributeKeys` must participate in this bucket key.
 *
 *  Bugfix (independent dev-auto reviews): a share's *effective* attribute-key set is exactly what
 *  `effectiveAttributeKeysForShare` (service.ts) computes at reveal time — a single-key
 *  `fieldKey: 'password'` request and a single-element `attributeKeys: ['password']` request name
 *  the same field and are treated identically there. This bucketing function must mirror that same
 *  normalization: both request shapes are folded into one canonical bucket key (and one SQL
 *  `fieldCondition` that matches rows created via EITHER shape) whenever they name the same
 *  effective field(s), so a caller cannot double AC-16's cap by alternating between the legacy
 *  `fieldKey` column and the new `attributeKeys` array for the same field. */
function pendingCapBucket(validation: {
  normalizedField: string | null
  normalizedAttributeKeys: string[] | null
}): { lockSuffix: string; fieldCondition: SQL } {
  // `normalizedField` (already validated as a single declared key) and a single-element
  // `normalizedAttributeKeys` both collapse to the same one-element effective set — same
  // normalization `effectiveAttributeKeysForShare` applies at reveal time.
  const effectiveKeys = validation.normalizedField
    ? [validation.normalizedField]
    : validation.normalizedAttributeKeys

  if (effectiveKeys && effectiveKeys.length > 0) {
    const attributeKeysCondition = eq(credentialShares.attributeKeys, effectiveKeys)
    // A single-field effective set may have been persisted via either request shape — match rows
    // created via the legacy `fieldKey` column OR the `attributeKeys` array. A multi-key effective
    // set can only ever have been persisted via `attributeKeys` (the `fieldKey` column can't
    // represent more than one field), so no `fieldKey` alternative applies there.
    const [onlyKey] = effectiveKeys
    const fieldCondition =
      effectiveKeys.length === 1 && onlyKey
        ? sql`(${eq(credentialShares.fieldKey, onlyKey)} OR ${attributeKeysCondition})`
        : attributeKeysCondition
    return {
      lockSuffix: JSON.stringify(effectiveKeys),
      fieldCondition,
    }
  }
  return {
    lockSuffix: '',
    fieldCondition: sql`${credentialShares.fieldKey} IS NULL AND ${credentialShares.attributeKeys} IS NULL`,
  }
}

export type CreateExternalShareInput = {
  orgId: string
  projectId: string
  credentialId: string
  sharedByUserId: string
  recipientEmail: string
  fieldKey?: string
  // Story 20.5 AC-1: see `CreateShareInput.attributeKeys` (service.ts) — identical semantics.
  attributeKeys?: string[] | null
  expiresAt: Date
}

export type CreateExternalShareResult =
  | { status: 'credential_not_found' }
  | { status: 'unknown_field_key'; field: string }
  | { status: 'ambiguous_share_scope' }
  // Bugfix (review patch): see `ShareFieldAndExpiryValidation`'s matching variant in service.ts.
  | { status: 'too_many_attribute_keys' }
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

  const validation = await validateShareFieldAndExpiry(
    tx,
    input.credentialId,
    input.fieldKey,
    input.attributeKeys,
    input.expiresAt,
    EXTERNAL_SHARE_MAX_TTL_MS
  )
  if (validation.status !== 'ok') return validation

  // AC-16: cap check + insert in the same transaction as the caller's own — avoids a TOCTOU gap
  // on the cap itself. A same-transaction COUNT+INSERT alone is NOT sufficient under Postgres'
  // default READ COMMITTED isolation (two concurrent transactions can both read the same count
  // and both insert), so this also takes a credential+field-scoped advisory lock first — same
  // precedent as rotation-locks.ts's `tryAcquireCredentialScopedLock` — to serialize concurrent
  // creations for the same (credentialId, fieldKey) bucket.
  //
  // Bugfix (dev-auto review): this bucket key used to be derived from `normalizedField` alone, so
  // every `attributeKeys`-scoped share (and every whole-resource share) collapsed into the single
  // `fieldKey IS NULL` bucket regardless of which attributes it actually named — two shares naming
  // disjoint attribute sets competed for the same cap, while an equivalent single-field share made
  // via the legacy `fieldKey` column got its own separate bucket. `normalizedAttributeKeys` is
  // sorted by `validateAttributeKeys`, so two requests naming the same set of keys always produce
  // the same bucket key/array regardless of the order the caller supplied them in. See
  // `pendingCapBucket` above.
  const { lockSuffix: lockFieldSuffix, fieldCondition } = pendingCapBucket(validation)
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('external-share-cap:' || ${input.credentialId} || ':' || ${lockFieldSuffix}, 0))`
  )
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
        // the not-yet-resolved bucket this cap counts is exactly `status = 'active'`. Also
        // excludes rows that are already past their `expiresAt` but haven't been lazily swept to
        // `expired` yet — AC-16 explicitly says "letting one expire immediately frees a slot",
        // which only holds if a not-yet-swept-but-time-expired row doesn't still count.
        inArray(credentialShares.status, ['active']),
        sql`${credentialShares.expiresAt} > now()`
      )
    )
  const pendingCount = Number(countRows[0]?.count ?? 0)
  if (pendingCount >= MAX_PENDING_EXTERNAL_SHARES_PER_FIELD) return { status: 'cap_exceeded' }

  const { rawToken, tokenHash } = generateAndHashShareToken()

  const [share] = await tx
    .insert(credentialShares)
    .values({
      ...baseShareInsertValues(
        input,
        validation.normalizedField,
        validation.normalizedAttributeKeys,
        tokenHash
      ),
      recipientType: 'external',
      recipientUserId: null,
      recipientEmail: input.recipientEmail.trim().toLowerCase(),
      singleUse: true,
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
  if (row?.recipientType !== 'external') return { status: 'not_found' }

  return withOrg(row.orgId, async (tx) => {
    const [joined] = await shareWithCredentialAndSharerQuery(tx)
      .where(eq(credentialShares.id, row.id))
      .limit(1)
    if (!joined) return { status: 'not_found' }

    const share = await lazilyExpireShareIfDue(tx, joined.share)

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
/** Maps a share's terminal DB `status` to the terminal reveal-failure reason surfaced to the
 *  caller — shared by `precheckExternalShareClaimable` (checked up front) and
 *  `resolveLostExternalClaim` (re-checked after losing the atomic claim), so the two can never
 *  drift out of sync on which statuses collapse to which reason (this codebase doesn't surface
 *  `superseded` as distinct from `expired` to the recipient). Returns `undefined` for `active`
 *  (not yet terminal) and `viewed` is handled by callers directly since its wording differs
 *  ("already_viewed") from the fallback default used when a lost-claim race lands on `viewed`. */
export function terminalRevealStatusFor(
  status: CredentialShareRow['status']
): 'revoked' | 'expired' | undefined {
  if (status === 'revoked') return 'revoked'
  if (status === 'expired' || status === 'superseded') return 'expired'
  return undefined
}

async function precheckExternalShareClaimable(
  tx: Tx,
  share: CredentialShareRow
): Promise<{ result: RevealExternalShareResult } | { share: CredentialShareRow }> {
  const terminal = terminalRevealStatusFor(share.status)
  if (terminal) {
    await recordLosingAttempt(tx, share)
    return { result: { status: terminal } }
  }
  if (share.status === 'viewed') {
    await recordLosingAttempt(tx, share)
    return { result: { status: 'already_viewed' } }
  }
  if (share.expiresAt.getTime() <= Date.now()) {
    // Story 17.3 AC-5/AC-6: reuse `lazilyExpireShareIfDue` (writes CREDENTIAL_SHARE_EXPIRED in
    // the same transaction) rather than a second, parallel inline transition.
    const lazilyExpired = await lazilyExpireShareIfDue(tx, share)
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
  const terminal = terminalRevealStatusFor(lost.status)
  if (terminal) return { status: terminal }
  return { status: 'already_viewed' }
}

export async function revealExternalShare(rawToken: string): Promise<RevealExternalShareResult> {
  const tokenHash = hashShareToken(rawToken)
  const row = await adminLookupByTokenHash(tokenHash)
  if (row?.recipientType !== 'external') return { status: 'not_found' }

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
    // the atomic-claim step. Story 20.5 AC-2/AC-3: `serializeBounded` also applies
    // sensitivity-default-exclusion for a whole-resource share — see service.ts's `revealShare`
    // for the full rationale, identical here.
    const bounded = await serializeBounded(
      share.credentialId,
      effectiveAttributeKeysForShare(share),
      tx
    )
    if (bounded.status !== 'ok') return { status: 'expired' }

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
        // Story 20.5 (review patch): see access-routes.ts's identical addition to the member
        // reveal path's VIEWED payload.
        attributeKeys: share.attributeKeys,
        viewCount: claimed.viewCount,
        recipientType: 'external',
      },
    })

    const value = bounded.kind === 'value' ? bounded.value : JSON.stringify(bounded.fields)
    return { status: 'ok', share: claimed, value, fieldKey: share.fieldKey }
  })
}
