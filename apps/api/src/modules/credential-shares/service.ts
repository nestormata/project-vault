import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentials, credentialShares, orgMemberships, users } from '@project-vault/db/schema'
import { AuditEvent, normalizeFieldKey } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { writeSystemAuditEntryOrFailClosed } from '../../lib/audit-or-fail-closed.js'
import { credentialExistsInProject } from '../credentials/db-helpers.js'
import {
  attributeKeys as declaredAdapterAttributeKeys,
  formatBoundedRevealValue,
  serializeBounded,
  type SerializeBoundedResult,
} from '../credentials/bounded-share-adapter.js'
import { DEFAULT_SHARE_LIST_LIMIT, MAX_ATTRIBUTE_KEYS, SHARE_MAX_TTL_MS } from './schema.js'

export type CredentialShareRow = typeof credentialShares.$inferSelect

/**
 * Token generation/hashing mirrors `apps/api/src/modules/invitations/tokens.ts`'s bearer-token
 * pattern: only the HMAC digest is ever persisted, the raw token is returned to the caller once.
 * Reuses the existing `INVITATION_TOKEN_HMAC_SECRET` with a domain-separation prefix (rather than
 * introducing a brand-new dedicated secret and its full env/production-validation/docker-compose
 * surface for this story) — a deliberate scope decision, documented in the Dev Agent Record.
 */
export function generateShareToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashShareToken(rawToken: string): string {
  return createHmac('sha256', env.INVITATION_TOKEN_HMAC_SECRET)
    .update(`credential_share:${rawToken}`)
    .digest('hex')
}

/** Shared by the member-share and external-share creation paths (Story 17.2 AC-13's "reuse, don't
 *  re-derive" convention) so token generation/hashing is expressed in exactly one place. */
export function generateAndHashShareToken(): { rawToken: string; tokenHash: string } {
  const rawToken = generateShareToken()
  return { rawToken, tokenHash: hashShareToken(rawToken) }
}

/** The insert-column base every `credential_shares` row shares regardless of recipient type —
 *  factored out so each creation path only spells out its own `recipientType`/`recipientUserId`/
 *  `recipientEmail`/`singleUse` fields on top of it. Takes the caller's own creation-input object
 *  directly (both `CreateShareInput` and `CreateExternalShareInput` share this field shape) rather
 *  than a re-keyed copy of it, so the call site has nothing left to duplicate. */
export function baseShareInsertValues(
  input: { orgId: string; credentialId: string; sharedByUserId: string; expiresAt: Date },
  fieldKey: string | null,
  attributeKeys: string[] | null,
  tokenHash: string
) {
  return {
    orgId: input.orgId,
    credentialId: input.credentialId,
    fieldKey,
    // Story 20.5 AC-1: `attributeKeys` generalizes `fieldKey` without narrowing it — both are
    // persisted as validated/normalized, `fieldKey` untouched for existing Epic 17 call paths.
    attributeKeys,
    // Story 20.5 AC-1: `action` is `'read'`-only in this contract version — hard-coded here
    // (never taken from caller input) since both creation paths only ever create read shares.
    action: 'read' as const,
    sharedBy: input.sharedByUserId,
    tokenHash,
    expiresAt: input.expiresAt,
    status: 'active' as const,
  }
}

/** Story 20.5 (Scoped/Bounded Sharing Contract): resolves a persisted share row's effective
 *  `attributeKeys` for serialization — `attributeKeys` (non-empty) wins; otherwise a non-null
 *  `fieldKey` is treated as `[fieldKey]` (naming one field via the legacy column is exactly as
 *  much explicit consent as naming it via `attributeKeys`, per the contract's "generalizes
 *  `field_key` without narrowing its existing behavior"); `null` when neither is set, which is a
 *  whole-resource share subject to sensitivity-default-exclusion (AC-2) — this covers both a
 *  newly created whole-resource share and every pre-existing Epic 17 whole-credential share
 *  (`fieldKey IS NULL`), since the rule applies going forward at serialization time, never by
 *  reclassifying old rows. */
export function effectiveAttributeKeysForShare(
  share: Pick<CredentialShareRow, 'fieldKey' | 'attributeKeys'>
): string[] | null {
  if (share.attributeKeys && share.attributeKeys.length > 0) return share.attributeKeys
  if (share.fieldKey) return [share.fieldKey]
  return null
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export type CreateShareInput = {
  orgId: string
  projectId: string
  credentialId: string
  sharedByUserId: string
  recipientUserId: string
  fieldKey?: string
  // Story 20.5 AC-1: `BoundedShareScope.attributeKeys` — `null`/omitted means "whole-resource,
  // sensitivity-default-exclusion applies" (AC-2); a non-empty array is an explicit allow-list.
  attributeKeys?: string[] | null
  expiresAt: Date
  singleUse: boolean
}

export type CreateShareResult =
  | { status: 'credential_not_found' }
  | { status: 'self_share' }
  | { status: 'recipient_not_found' }
  | { status: 'recipient_inactive' }
  | { status: 'unknown_field_key'; field: string }
  // Story 20.5 (review patch): distinct from 'unknown_field_key' — the named key(s) are valid,
  // the request just named both fieldKey and attributeKeys, which is a different failure mode.
  | { status: 'ambiguous_share_scope' }
  // Bugfix (review patch): see `ShareFieldAndExpiryValidation`'s matching variant above.
  | { status: 'too_many_attribute_keys' }
  | { status: 'expires_at_invalid'; reason: 'past' | 'too_far_in_future' }
  | { status: 'ok'; share: CredentialShareRow; token: string }

/** Shared by `validateFieldKey`/`validateAttributeKeys` below: the credential's current version's
 *  declared field keys, normalized identically (trim + NFC + lowercase). Factored out so the two
 *  validators can never compute this differently from one another.
 *
 *  Bugfix (post-implementation review): this used to re-derive the credential's declared keys
 *  independently (its own `selectCurrentVersionMeta`/`loadCredentialFieldMeta` + `fieldMetaForResponse`
 *  pair) rather than reusing the adapter's own `attributeKeys` export — the exact same "declared
 *  keys for a resource" question Story 20.5's contract already answers in exactly one place
 *  (`bounded-share-adapter.ts`). Delegating here means that adapter function has a real caller
 *  (it previously satisfied the contract's shape only nominally, never invoked) and this module no
 *  longer maintains a second, parallel implementation of the same lookup. `normalizeFieldKey` is
 *  applied here, not in the adapter, since the adapter's own contract intentionally returns
 *  declared keys as-is (unnormalized) — this validator is the one place that needs the normalized
 *  form for its own duplicate/allow-list comparisons. */
async function declaredFieldKeys(tx: Tx, credentialId: string): Promise<string[]> {
  const keys = await declaredAdapterAttributeKeys(credentialId, tx)
  return keys.map((key) => normalizeFieldKey(key))
}

// Exported (Story 17.2 AC-4) so the external-share path reuses this exact validation rather than
// re-deriving it — same auto-expire-on-field-removal-or-rename semantics for both recipient types.
export async function validateFieldKey(
  tx: Tx,
  credentialId: string,
  fieldKey: string | undefined
): Promise<{ ok: true; normalized: string | null } | { ok: false; field: string }> {
  if (!fieldKey) return { ok: true, normalized: null }
  const declaredKeys = await declaredFieldKeys(tx, credentialId)
  const normalized = normalizeFieldKey(fieldKey)
  if (!declaredKeys.includes(normalized)) return { ok: false, field: fieldKey }
  return { ok: true, normalized }
}

// Story 20.5 AC-1: the `attributeKeys` sibling of `validateFieldKey` — every named key must be a
// key actually declared on the credential's current version, normalized identically (trim + NFC +
// lowercase via `normalizeFieldKey`), or the whole request is rejected the same way an unknown
// `fieldKey` is (never a silent partial-acceptance of only the valid names).
export async function validateAttributeKeys(
  tx: Tx,
  credentialId: string,
  attributeKeys: string[] | null | undefined
): Promise<
  | { ok: true; normalized: string[] | null }
  | { ok: false; field: string; tooMany?: false }
  | { ok: false; tooMany: true }
> {
  if (!attributeKeys || attributeKeys.length === 0) return { ok: true, normalized: null }
  const declaredKeys = await declaredFieldKeys(tx, credentialId)
  // Bugfix (post-implementation review): dedupe on the NORMALIZED form — a client sending
  // `['password', 'password']` (or case/whitespace-variant duplicates that normalize to the same
  // key, e.g. `['Password', ' password ']`) must persist a single entry, not a redundant array
  // (`isIncluded`'s `.includes()` check makes duplicates harmless for filtering, but a persisted
  // duplicate is still bytes/rows worth of noise this validator can trivially prevent).
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const key of attributeKeys) {
    const norm = normalizeFieldKey(key)
    if (!declaredKeys.includes(norm)) return { ok: false, field: key }
    if (seen.has(norm)) continue
    seen.add(norm)
    normalized.push(norm)
  }
  // Bugfix (review patch): the `MAX_ATTRIBUTE_KEYS` cap is checked here, AFTER deduping, not as a
  // raw `.max()` on the Zod schema (schema.ts's `AttributeKeysSchema`) — a caller sending
  // `MAX_ATTRIBUTE_KEYS` keys where one is a case/whitespace duplicate of another must not be
  // rejected for exceeding the cap when the deduplicated set actually fits within it.
  if (normalized.length > MAX_ATTRIBUTE_KEYS) return { ok: false, tooMany: true }
  // Bugfix (dev-auto review): sorted so two requests naming the same set of keys in a different
  // order persist identically — `external-service.ts`'s AC-16 pending-share cap counts/locks a
  // bounded share's bucket by exact `attribute_keys` array equality, which is order-sensitive in
  // Postgres; an unsorted array let two functionally-identical requests (e.g. `['a','b']` vs
  // `['b','a']`) land in different buckets and partially evade the cap.
  normalized.sort((left, right) => left.localeCompare(right))
  return { ok: true, normalized }
}

export type ShareFieldAndExpiryValidation =
  | { status: 'unknown_field_key'; field: string }
  | { status: 'ambiguous_share_scope' }
  // Bugfix (review patch): distinct from 'unknown_field_key' — every named key is a real,
  // declared field; the deduplicated set is simply too large (see `validateAttributeKeys`'s
  // `tooMany` case above for why this is checked post-dedup rather than as a raw Zod `.max()`).
  | { status: 'too_many_attribute_keys' }
  | { status: 'expires_at_invalid'; reason: 'past' | 'too_far_in_future' }
  | { status: 'ok'; normalizedField: string | null; normalizedAttributeKeys: string[] | null }

/** Shared by both share-creation paths (Story 17.2 AC-4/AC-13): unknown-field-key and expiry-
 *  window validation, parameterized only by the caller's own max-TTL constant. The result's
 *  `status` variants line up 1:1 with `CreateShareResult`/`CreateExternalShareResult` so a caller
 *  can return a non-'ok' result directly without re-mapping it.
 *
 *  Story 20.5 AC-1: also validates `attributeKeys` (the request schema rejects supplying both
 *  `fieldKey` and `attributeKeys` on the same request — see `schema.ts` — so at most one of the
 *  two inputs here is ever non-empty in practice, but both are validated independently regardless
 *  so a non-HTTP caller gets the same guarantee). */
export async function validateShareFieldAndExpiry(
  tx: Tx,
  credentialId: string,
  fieldKey: string | undefined,
  attributeKeys: string[] | null | undefined,
  expiresAt: Date,
  maxTtlMs: number
): Promise<ShareFieldAndExpiryValidation> {
  const fieldValidation = await validateFieldKey(tx, credentialId, fieldKey)
  if (!fieldValidation.ok) return { status: 'unknown_field_key', field: fieldValidation.field }

  const attributeKeysValidation = await validateAttributeKeys(tx, credentialId, attributeKeys)
  if (!attributeKeysValidation.ok) {
    if (attributeKeysValidation.tooMany) return { status: 'too_many_attribute_keys' }
    return { status: 'unknown_field_key', field: attributeKeysValidation.field }
  }

  // Bugfix (post-review): the HTTP layer's `rejectBothFieldKeyAndAttributeKeys` Zod `.refine`
  // (schema.ts) is the only thing that previously blocked a request naming both `fieldKey` and
  // `attributeKeys` — a non-HTTP caller of this function bypassed that and would only fail at
  // insert time against the DB `credential_shares_field_key_attribute_keys_check` constraint (an
  // unhandled insert failure, not a graceful validation result). Re-checked here so this
  // function's own doc comment ("a non-HTTP caller gets the same guarantee") is actually true.
  if (fieldValidation.normalized && attributeKeysValidation.normalized) {
    return { status: 'ambiguous_share_scope' }
  }

  const now = Date.now()
  if (expiresAt.getTime() <= now) return { status: 'expires_at_invalid', reason: 'past' }
  if (expiresAt.getTime() > now + maxTtlMs) {
    return { status: 'expires_at_invalid', reason: 'too_far_in_future' }
  }
  return {
    status: 'ok',
    normalizedField: fieldValidation.normalized,
    normalizedAttributeKeys: attributeKeysValidation.normalized,
  }
}

async function findActiveOrgMembership(
  tx: Tx,
  orgId: string,
  userId: string
): Promise<{ status: string } | null> {
  const [row] = await tx
    .select({ status: orgMemberships.status })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1)
  return row ?? null
}

/** AC-1/AC-2/AC-3/AC-4/AC-18/AC-19: creates a `recipient_type = 'user'` share. Eligibility
 *  (AC-1) is enforced by the route via `rejectIfInsufficientProjectRoleForReveal` BEFORE this is
 *  called — this function only validates the share-specific business rules (AC-2/AC-3/AC-4). */
export async function createCredentialShare(
  tx: Tx,
  input: CreateShareInput
): Promise<CreateShareResult> {
  const exists = await credentialExistsInProject(tx, {
    credentialId: input.credentialId,
    projectId: input.projectId,
  })
  if (!exists) return { status: 'credential_not_found' }

  // AC-2: self-share is rejected — sharing with yourself has no purpose.
  if (input.recipientUserId === input.sharedByUserId) return { status: 'self_share' }

  const membership = await findActiveOrgMembership(tx, input.orgId, input.recipientUserId)
  if (!membership) return { status: 'recipient_not_found' }
  if (membership.status !== 'active') return { status: 'recipient_inactive' }

  const validation = await validateShareFieldAndExpiry(
    tx,
    input.credentialId,
    input.fieldKey,
    input.attributeKeys,
    input.expiresAt,
    SHARE_MAX_TTL_MS
  )
  if (validation.status !== 'ok') return validation

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
      recipientType: 'user',
      recipientUserId: input.recipientUserId,
      recipientEmail: null,
      singleUse: input.singleUse,
    })
    .returning()
  if (!share) throw new Error('createCredentialShare: insert returned no row')

  return { status: 'ok', share, token: rawToken }
}

export type ListSharesForCredentialParams = {
  orgId: string
  credentialId: string
  sharedByUserId?: string
  // Story 17.3 AC-1/AC-2: additive filtering/pagination on top of 17.1's existing scoping — the
  // admin-sees-everyone behavior (sharedByUserId omitted) is unchanged.
  status?: CredentialShareRow['status']
  limit?: number
  offset?: number
}

/** Shared by `listSharesForCredential`/`countSharesForCredential` (AC-2's `total` needs the exact
 *  same filters as the paginated `items` query, minus pagination itself) — a single place the
 *  WHERE clause is expressed so the two queries can never drift apart. */
function sharesForCredentialWhereClause(params: ListSharesForCredentialParams) {
  return and(
    eq(credentialShares.orgId, params.orgId),
    eq(credentialShares.credentialId, params.credentialId),
    params.sharedByUserId ? eq(credentialShares.sharedBy, params.sharedByUserId) : undefined,
    params.status ? eq(credentialShares.status, params.status) : undefined
  )
}

/** AC-5 grants org admins/owners the right to revoke any share on a credential, not just their
 *  own — `sharedByUserId` omitted lists every share for the credential (for an admin/owner
 *  caller); a non-admin caller must always pass their own id, scoping the list to shares they
 *  created. AC-1/AC-2: optional `status` filter and `limit`/`offset` pagination, both additive on
 *  top of the existing scoping. */
export async function listSharesForCredential(
  tx: Tx,
  params: ListSharesForCredentialParams
): Promise<CredentialShareRow[]> {
  return tx
    .select()
    .from(credentialShares)
    .where(sharesForCredentialWhereClause(params))
    .orderBy(desc(credentialShares.createdAt))
    .limit(params.limit ?? DEFAULT_SHARE_LIST_LIMIT)
    .offset(params.offset ?? 0)
}

/** AC-2: a separate `COUNT(*)` query with the same filters, minus pagination itself — powers the
 *  `total` field so the web UI can render "showing 1-25 of 41" / a Next button without a second
 *  round-trip beyond this one. */
export async function countSharesForCredential(
  tx: Tx,
  params: ListSharesForCredentialParams
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(credentialShares)
    .where(sharesForCredentialWhereClause(params))
  return Number(row?.count ?? 0)
}

export async function findShareInScope(
  tx: Tx,
  params: { orgId: string; credentialId: string; shareId: string }
): Promise<CredentialShareRow | null> {
  const [row] = await tx
    .select()
    .from(credentialShares)
    .where(
      and(
        eq(credentialShares.orgId, params.orgId),
        eq(credentialShares.credentialId, params.credentialId),
        eq(credentialShares.id, params.shareId)
      )
    )
    .limit(1)
  return row ?? null
}

export type RevokeShareResult =
  { status: 'not_found' } | { status: 'ok'; share: CredentialShareRow; alreadyTerminal: boolean }

/** AC-5: idempotent no-op semantics — revoking an already-viewed/expired/revoked/superseded share
 *  returns the share's current state, not an error. Authorization (sharer or org admin/owner) is
 *  checked by the caller before this runs. */
export async function revokeShare(
  tx: Tx,
  params: { orgId: string; credentialId: string; shareId: string }
): Promise<RevokeShareResult> {
  const existing = await findShareInScope(tx, params)
  if (!existing) return { status: 'not_found' }
  if (existing.status !== 'active') return { status: 'ok', share: existing, alreadyTerminal: true }

  const [updated] = await tx
    .update(credentialShares)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(eq(credentialShares.id, existing.id), eq(credentialShares.status, 'active')))
    .returning()
  if (!updated) {
    // Lost the race to a concurrent revoke/reveal — re-read and treat as the no-op AC-5 requires.
    const current = await findShareInScope(tx, params)
    if (!current) return { status: 'not_found' }
    return { status: 'ok', share: current, alreadyTerminal: true }
  }
  return { status: 'ok', share: updated, alreadyTerminal: false }
}

/** Story 17.1 AC-15: revokes every `active` share created by a user being deactivated, in the
 *  same transaction as the deactivation itself. Returns the revoked rows so the caller can write
 *  one `CREDENTIAL_SHARE_REVOKED` audit entry per share with a distinguishing reason. */
export async function autoRevokeSharesForDeactivatedUser(
  tx: Tx,
  params: { orgId: string; userId: string }
): Promise<CredentialShareRow[]> {
  return tx
    .update(credentialShares)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(credentialShares.orgId, params.orgId),
        eq(credentialShares.sharedBy, params.userId),
        eq(credentialShares.status, 'active')
      )
    )
    .returning()
}

export type ShareMetadata = {
  share: CredentialShareRow
  credentialName: string
  credentialProjectId: string
  sharedByEmail: string | null
}

export type FindShareByTokenResult =
  | { status: 'not_found' }
  | { status: 'session_mismatch' }
  | { status: 'ok'; metadata: ShareMetadata }

/** The credential-share-plus-credential-plus-sharer join, factored out so both the session-bound
 *  (17.1) and unauthenticated external (17.2) lookups share the exact same column set rather than
 *  each re-declaring it. Exported so `external-service.ts` can reuse it. */
export function shareWithCredentialAndSharerQuery(tx: Tx) {
  return tx
    .select({
      share: credentialShares,
      credentialName: credentials.name,
      credentialProjectId: credentials.projectId,
      sharedByEmail: users.email,
    })
    .from(credentialShares)
    .innerJoin(credentials, eq(credentialShares.credentialId, credentials.id))
    .leftJoin(users, eq(credentialShares.sharedBy, users.id))
}

/** Same lazy active->expired transition both the session-bound and external metadata lookups
 *  apply — without it, an already-expired share still reads back as 'active', and the consent
 *  page would show a live Reveal button for a share the reveal-step would immediately reject.
 *  Exported so `external-service.ts` reuses this exact transition rather than re-deriving it.
 *
 *  Story 17.3 AC-5/AC-6: writes `CREDENTIAL_SHARE_EXPIRED` in the same transaction as the status
 *  UPDATE, so both call sites (this function's two existing callers) inherit the audit trail for
 *  free — a share nobody re-opens is no longer a silent gap in Share History. Always written via
 *  `writeSystemAuditEntryOrFailClosed`: the transition is discovered by whichever request happens
 *  to touch the share (an authenticated org member, an anonymous external recipient, or — AC-7 —
 *  the sweep worker with no request at all), but it is never actually caused by that caller's own
 *  action, so it is attributed to no human actor either way (matches AC-5's own example wording:
 *  "the transition was system-driven (no actor)"). Only the row that actually wins the CAS
 *  transition writes the audit entry — a losing concurrent attempt (`updated` is undefined) is
 *  treated as a no-op, never double-audited. */
export async function lazilyExpireShareIfDue(
  tx: Tx,
  share: CredentialShareRow
): Promise<CredentialShareRow> {
  if (share.status !== 'active' || share.expiresAt.getTime() > Date.now()) return share
  const [updated] = await tx
    .update(credentialShares)
    .set({ status: 'expired' })
    .where(and(eq(credentialShares.id, share.id), eq(credentialShares.status, 'active')))
    .returning()
  if (!updated) return share

  await writeSystemAuditEntryOrFailClosed(tx, {
    orgId: updated.orgId,
    eventType: AuditEvent.CREDENTIAL_SHARE_EXPIRED,
    resourceId: updated.id,
    resourceType: 'credential_share',
    payload: {
      credentialId: updated.credentialId,
      fieldKey: updated.fieldKey,
      recipientType: updated.recipientType,
      attributeKeys: updated.attributeKeys,
    },
  })

  return updated
}

/** AC-7: token+session-identity check. A token that doesn't hash-match any row is a 404 (the
 *  share's existence is hidden the same as any not-found resource); a token that matches a row
 *  but whose `recipient_user_id` differs from the caller's session is a 403 (AC-7's deliberate
 *  divergence from 17.2's external threat model — the share's existence is NOT hidden from a
 *  logged-in org member the way it would be from an anonymous party). */
export async function findShareByToken(
  tx: Tx,
  params: { orgId: string; rawToken: string; sessionUserId: string }
): Promise<FindShareByTokenResult> {
  const tokenHash = hashShareToken(params.rawToken)
  const [row] = await shareWithCredentialAndSharerQuery(tx)
    .where(and(eq(credentialShares.orgId, params.orgId), eq(credentialShares.tokenHash, tokenHash)))
    .limit(1)
  if (!row) return { status: 'not_found' }
  // Defense-in-depth: the WHERE clause already matches by indexed hash equality, but re-verify
  // with a constant-time compare before trusting it (same posture as invitationTokensMatch()).
  if (!constantTimeHexEqual(row.share.tokenHash, tokenHash)) return { status: 'not_found' }
  if (row.share.recipientUserId !== params.sessionUserId) return { status: 'session_mismatch' }

  const share = await lazilyExpireShareIfDue(tx, row.share)

  return {
    status: 'ok',
    metadata: {
      share,
      credentialName: row.credentialName,
      credentialProjectId: row.credentialProjectId,
      sharedByEmail: row.sharedByEmail,
    },
  }
}

export type RevealShareResult =
  | { status: 'not_found' }
  | { status: 'session_mismatch' }
  | { status: 'recipient_ineligible' } // AC-16: recipient removed/deactivated since creation
  | { status: 'expired' } // includes AC-3's field-removed-since-creation case
  | { status: 'already_viewed' }
  | { status: 'revoked' }
  | {
      status: 'ok'
      share: CredentialShareRow
      value: string
      valueFormat: 'scalar' | 'fields'
      fieldKey: string | null
    }

export function buildShareRevealResult(
  share: CredentialShareRow,
  bounded: Extract<SerializeBoundedResult, { status: 'ok' }>,
  fieldKey: string | null
): Extract<RevealShareResult, { status: 'ok' }> {
  return {
    status: 'ok',
    share,
    ...formatBoundedRevealValue(bounded),
    fieldKey,
  }
}

/** Extracted from `revealShare` purely to keep its own cyclomatic complexity under this repo's
 *  eslint threshold. AC-16: re-checks recipient org-membership/active-status, share status, and
 *  live/lazy expiry — all before any claim attempt. Returns a terminal RevealShareResult when the
 *  share isn't claimable, or `undefined` when the caller should proceed to the atomic claim. */
async function precheckShareClaimable(
  tx: Tx,
  params: { orgId: string; sessionUserId: string },
  share: CredentialShareRow
): Promise<RevealShareResult | undefined> {
  // AC-16: re-check recipient org-membership/active-status at reveal time, not just at creation.
  const membership = await findActiveOrgMembership(tx, params.orgId, params.sessionUserId)
  if (membership?.status !== 'active') return { status: 'recipient_ineligible' }

  if (share.status === 'revoked') return { status: 'revoked' }
  if (share.status === 'expired' || share.status === 'superseded') return { status: 'expired' }
  if (share.expiresAt.getTime() <= Date.now()) {
    // Story 17.3 AC-5: reuse `lazilyExpireShareIfDue` rather than a second, parallel inline
    // transition — every active->expired transition, whichever code path discovers it, must
    // write the same audit trail.
    await lazilyExpireShareIfDue(tx, share)
    return { status: 'expired' }
  }
  return undefined
}

/** Extracted from `revealShare` for the same complexity-ceiling reason as `precheckShareClaimable`
 *  above: resolves a lost claim (AC-14's atomic conditional UPDATE returned no row) to the
 *  correct terminal outcome by re-reading the share's current status. */
async function resolveLostClaim(
  tx: Tx,
  params: { orgId: string; credentialId: string; shareId: string }
): Promise<RevealShareResult> {
  // Either a concurrent request already won the single-use claim (AC-14), or (for a multi-view
  // share) the row's status changed underneath us (revoked/expired by another request).
  const current = await findShareInScope(tx, params)
  if (current?.status === 'revoked') return { status: 'revoked' }
  if (current?.status === 'expired') return { status: 'expired' }
  return { status: 'already_viewed' }
}

/**
 * AC-8/AC-14/AC-16: the reveal-step. Re-validates recipient org-membership/active-status (AC-16)
 * and expiry/field-existence (AC-3) before ever attempting the atomic claim. The single-use
 * consumption itself is a single conditional `UPDATE ... WHERE status = 'active' RETURNING` — see
 * `claimSingleUseView` — never a read-then-branch-then-write sequence (AC-14).
 */
export async function revealShare(
  tx: Tx,
  params: { orgId: string; rawToken: string; sessionUserId: string }
): Promise<RevealShareResult> {
  const found = await findShareByToken(tx, {
    orgId: params.orgId,
    rawToken: params.rawToken,
    sessionUserId: params.sessionUserId,
  })
  if (found.status === 'not_found') return { status: 'not_found' }
  if (found.status === 'session_mismatch') return { status: 'session_mismatch' }
  const { share } = found.metadata

  const blocked = await precheckShareClaimable(tx, params, share)
  if (blocked) return blocked

  // Story 20.5 AC-2/AC-3: `serializeBounded` is the credential adapter's bounded, sensitivity-
  // filtered serialization — `effectiveAttributeKeysForShare` generalizes `fieldKey` into the
  // contract's `attributeKeys` shape without changing a single-`fieldKey`-scoped share's behavior
  // (see that function's doc comment). Checked BEFORE the atomic claim below, same as the
  // pre-existing "field renamed/removed since creation" check this replaces: a single-use share
  // must not be burned (nor a multi-view share's view_count incremented) by a reveal attempt that
  // never actually reveals anything.
  const bounded = await serializeBounded(
    share.credentialId,
    effectiveAttributeKeysForShare(share),
    tx
  )
  if (bounded.status !== 'ok') return { status: 'expired' }

  // AC-4: singleUse: false remains viewable (re-incrementing view_count) until expiry — only a
  // singleUse: true share ever transitions to the terminal 'viewed' status.
  const claimed = share.singleUse
    ? await claimSingleUseView(tx, share.id)
    : await recordMultiView(tx, share.id)
  if (!claimed) {
    return resolveLostClaim(tx, {
      orgId: params.orgId,
      credentialId: share.credentialId,
      shareId: share.id,
    })
  }

  // A whole-credential share (fieldKey null) of a genuinely multi-field secret (minus any
  // sensitive fields excluded by AC-2's default) gets its field set serialized as JSON (same
  // shape the ordinary reveal endpoint returns for that case); every other case (field-scoped
  // share, or a whole-credential share that collapses to a single value) is a bare string.
  return buildShareRevealResult(claimed, bounded, share.fieldKey)
}

/** AC-14: the atomic conditional claim for a single-use share — never a read-then-branch-then-
 *  write sequence. Two concurrent reveal requests for the same share cannot both succeed.
 *  Exported (Story 17.2 AC-13) so the external reveal path reuses this exact function rather than
 *  writing a parallel "external claim" — it is already fully generic over `recipient_type`. */
export async function claimSingleUseView(
  tx: Tx,
  shareId: string
): Promise<CredentialShareRow | null> {
  const [updated] = await tx
    .update(credentialShares)
    .set({
      status: 'viewed',
      viewCount: 1,
      firstViewedAt: new Date(),
    })
    .where(and(eq(credentialShares.id, shareId), eq(credentialShares.status, 'active')))
    .returning()
  return updated ?? null
}

/** AC-4: a multi-view (singleUse: false) share's every view is recorded (view_count increments
 *  atomically via `view_count + 1`, no read-then-write), but only the first view sets
 *  `firstViewedAt` (via `COALESCE`), and status never leaves 'active' until expiry/revoke. Scoped
 *  to `status = 'active'` so a share revoked/expired by a concurrent request is not silently
 *  "viewed" anyway. */
async function recordMultiView(tx: Tx, shareId: string): Promise<CredentialShareRow | null> {
  const [updated] = await tx
    .update(credentialShares)
    .set({
      viewCount: sql`${credentialShares.viewCount} + 1`,
      firstViewedAt: sql`COALESCE(${credentialShares.firstViewedAt}, now())`,
    })
    .where(and(eq(credentialShares.id, shareId), eq(credentialShares.status, 'active')))
    .returning()
  return updated ?? null
}

/**
 * Story 17.3 AC-12: promoting a rotation (`apps/api/src/modules/rotation/service.ts`'s
 * `promoteRotation()`, called from the promote route handler in the SAME transaction) marks
 * every matching outstanding share `superseded`. New one-directional dependency: `rotation` calls
 * into `credential-shares` — confirmed safe (this module has zero existing imports from
 * `rotation`, so this cannot create a cycle).
 *
 * Scoping rule (AC-12):
 * - `targetFields === null` (whole-secret rotation): every outstanding share for the credential
 *   is superseded, regardless of its own `fieldKey` — a whole-secret rotation invalidates every
 *   previously-shared value, field-scoped or not, since the whole record changed.
 * - `targetFields` is a non-null array (field-scoped rotation): only shares where
 *   `fieldKey IS NULL` (whole-credential shares, which exposed the now-stale field too) OR
 *   `fieldKey = ANY(targetFields)` are superseded — a share of an unrelated, unrotated field is
 *   left untouched.
 * - "Outstanding" means `status IN ('active', 'viewed')` — a `revoked`/`expired`/already-
 *   `superseded` share has no live value to supersede and is left in its existing terminal state,
 *   not double-transitioned.
 *
 * Returns the superseded rows so the caller (rotation/routes.ts) can write one
 * CREDENTIAL_SHARE_SUPERSEDED audit entry per share (AC-13), each carrying the same `rotationId`.
 */
export async function supersedeOutstandingSharesForRotation(
  tx: Tx,
  params: {
    orgId: string
    credentialId: string
    targetFields: string[] | null
    rotationId: string
  }
): Promise<CredentialShareRow[]> {
  const fieldScope = params.targetFields
    ? or(isNull(credentialShares.fieldKey), inArray(credentialShares.fieldKey, params.targetFields))
    : undefined

  return tx
    .update(credentialShares)
    .set({ status: 'superseded', supersededAt: new Date() })
    .where(
      and(
        eq(credentialShares.orgId, params.orgId),
        eq(credentialShares.credentialId, params.credentialId),
        inArray(credentialShares.status, ['active', 'viewed']),
        fieldScope
      )
    )
    .returning()
}
