import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import {
  credentials,
  credentialShares,
  credentialVersions,
  orgMemberships,
  users,
} from '@project-vault/db/schema'
import { normalizeFieldKey } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { fieldMetaForResponse } from '../credentials/field-set.js'
import { credentialExistsInProject } from '../credentials/db-helpers.js'
import { revealCurrentValue } from '../credentials/service.js'
import { SHARE_MAX_TTL_MS } from './schema.js'

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
  expiresAt: Date
  singleUse: boolean
}

export type CreateShareResult =
  | { status: 'credential_not_found' }
  | { status: 'self_share' }
  | { status: 'recipient_not_found' }
  | { status: 'recipient_inactive' }
  | { status: 'unknown_field_key'; field: string }
  | { status: 'expires_at_invalid'; reason: 'past' | 'too_far_in_future' }
  | { status: 'ok'; share: CredentialShareRow; token: string }

async function loadCredentialFieldMeta(
  tx: Tx,
  credentialId: string
): Promise<{ schemaVersion: number; fieldMeta: unknown } | null> {
  const [row] = await tx
    .select({
      currentVersionId: credentials.currentVersionId,
    })
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .limit(1)
  if (!row?.currentVersionId) return null
  const [version] = await tx
    .select({
      schemaVersion: credentialVersions.schemaVersion,
      fieldMeta: credentialVersions.fieldMeta,
    })
    .from(credentialVersions)
    .where(eq(credentialVersions.id, row.currentVersionId))
    .limit(1)
  return version ?? null
}

async function validateFieldKey(
  tx: Tx,
  credentialId: string,
  fieldKey: string | undefined
): Promise<{ ok: true; normalized: string | null } | { ok: false; field: string }> {
  if (!fieldKey) return { ok: true, normalized: null }
  const version = await loadCredentialFieldMeta(tx, credentialId)
  const declaredKeys = version
    ? fieldMetaForResponse(version.schemaVersion, version.fieldMeta).map((f) =>
        normalizeFieldKey(f.key)
      )
    : []
  const normalized = normalizeFieldKey(fieldKey)
  if (!declaredKeys.includes(normalized)) return { ok: false, field: fieldKey }
  return { ok: true, normalized }
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

  const fieldValidation = await validateFieldKey(tx, input.credentialId, input.fieldKey)
  if (!fieldValidation.ok) return { status: 'unknown_field_key', field: fieldValidation.field }

  const now = Date.now()
  if (input.expiresAt.getTime() <= now) return { status: 'expires_at_invalid', reason: 'past' }
  if (input.expiresAt.getTime() > now + SHARE_MAX_TTL_MS) {
    return { status: 'expires_at_invalid', reason: 'too_far_in_future' }
  }

  const rawToken = generateShareToken()
  const tokenHash = hashShareToken(rawToken)

  const [share] = await tx
    .insert(credentialShares)
    .values({
      orgId: input.orgId,
      credentialId: input.credentialId,
      fieldKey: fieldValidation.normalized,
      sharedBy: input.sharedByUserId,
      recipientType: 'user',
      recipientUserId: input.recipientUserId,
      recipientEmail: null,
      tokenHash,
      singleUse: input.singleUse,
      expiresAt: input.expiresAt,
      status: 'active',
    })
    .returning()
  if (!share) throw new Error('createCredentialShare: insert returned no row')

  return { status: 'ok', share, token: rawToken }
}

/** AC-5 grants org admins/owners the right to revoke any share on a credential, not just their
 *  own — `sharedByUserId` omitted lists every share for the credential (for an admin/owner
 *  caller); a non-admin caller must always pass their own id, scoping the list to shares they
 *  created. */
export async function listSharesForCredential(
  tx: Tx,
  params: { orgId: string; credentialId: string; sharedByUserId?: string }
): Promise<CredentialShareRow[]> {
  return tx
    .select()
    .from(credentialShares)
    .where(
      and(
        eq(credentialShares.orgId, params.orgId),
        eq(credentialShares.credentialId, params.credentialId),
        params.sharedByUserId ? eq(credentialShares.sharedBy, params.sharedByUserId) : undefined
      )
    )
    .orderBy(desc(credentialShares.createdAt))
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
  const [row] = await tx
    .select({
      share: credentialShares,
      credentialName: credentials.name,
      credentialProjectId: credentials.projectId,
      sharedByEmail: users.email,
    })
    .from(credentialShares)
    .innerJoin(credentials, eq(credentialShares.credentialId, credentials.id))
    .leftJoin(users, eq(credentialShares.sharedBy, users.id))
    .where(and(eq(credentialShares.orgId, params.orgId), eq(credentialShares.tokenHash, tokenHash)))
    .limit(1)
  if (!row) return { status: 'not_found' }
  // Defense-in-depth: the WHERE clause already matches by indexed hash equality, but re-verify
  // with a constant-time compare before trusting it (same posture as invitationTokensMatch()).
  if (!constantTimeHexEqual(row.share.tokenHash, tokenHash)) return { status: 'not_found' }
  if (row.share.recipientUserId !== params.sessionUserId) return { status: 'session_mismatch' }

  // Same lazy active->expired transition `precheckShareClaimable` applies at reveal time — without
  // it, an already-expired share still reads back as 'active' here, and the consent page would
  // show a live Reveal button for a share the reveal-step would immediately reject.
  let share = row.share
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
  | { status: 'ok'; share: CredentialShareRow; value: string; fieldKey: string | null }

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
  if (!membership || membership.status !== 'active') return { status: 'recipient_ineligible' }

  if (share.status === 'revoked') return { status: 'revoked' }
  if (share.status === 'expired' || share.status === 'superseded') return { status: 'expired' }
  if (share.expiresAt.getTime() <= Date.now()) {
    await tx
      .update(credentialShares)
      .set({ status: 'expired' })
      .where(and(eq(credentialShares.id, share.id), eq(credentialShares.status, 'active')))
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
  const { share, credentialProjectId } = found.metadata

  const blocked = await precheckShareClaimable(tx, params, share)
  if (blocked) return blocked

  const revealed = await revealCurrentValue(tx, {
    credentialId: share.credentialId,
    projectId: credentialProjectId,
    field: share.fieldKey ?? undefined,
  })
  // AC-3: the field was renamed/removed since the share was created (or the credential/version
  // is otherwise gone) — treat as expired rather than a 500 or a silent null reveal. Checked
  // BEFORE the atomic claim below: a single-use share must not be burned (nor a multi-view
  // share's view_count incremented) by a reveal attempt that never actually reveals anything.
  if (revealed.status !== 'found') return { status: 'expired' }

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

  // A whole-credential share (fieldKey null) of a genuinely multi-field secret gets the full
  // field envelope (same shape the ordinary reveal endpoint returns for that case) serialized as
  // JSON; every other case (field-scoped share, or a whole-credential share of a single-value
  // secret) is a bare string.
  const value = revealed.kind === 'value' ? revealed.value : JSON.stringify(revealed.fields)

  return { status: 'ok', share: claimed, value, fieldKey: share.fieldKey }
}

/** AC-14: the atomic conditional claim for a single-use share — never a read-then-branch-then-
 *  write sequence. Two concurrent reveal requests for the same share cannot both succeed. */
async function claimSingleUseView(tx: Tx, shareId: string): Promise<CredentialShareRow | null> {
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
