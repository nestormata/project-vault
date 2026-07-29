import { and, eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentialShareNudgeDismissals, credentialShares, users } from '@project-vault/db/schema'

// Story 17.3 AC-11/FR125: the "shared — rotation recommended" nudge is computed, never stored as
// a boolean flag — derived from `credential_shares` plus the new `credential_share_nudge_
// dismissals` table, per distinct `(credentialId, fieldKey)` bucket that has ever been shared.
export type RotationRecommendedBucket = {
  fieldKey: string | null
  active: boolean
  mostRecentShareAt: string | null
  mostRecentSharedWith: string | null
}

const WHOLE_CREDENTIAL_BUCKET_KEY = ''

function bucketKey(fieldKey: string | null): string {
  return fieldKey ?? WHOLE_CREDENTIAL_BUCKET_KEY
}

type ShareRow = {
  fieldKey: string | null
  status: string
  createdAt: Date
  recipientEmail: string | null
  recipientUserEmail: string | null
  sharedBy: string
}

type DismissalRow = { fieldKey: string | null; dismissedAt: Date }

/** Extracted from `computeRotationRecommendedNudges` purely to keep its own cyclomatic
 *  complexity under this repo's eslint threshold — groups the most-recent-dismissal-per-bucket
 *  lookup into a single pass. */
function latestDismissalByBucket(dismissalRows: DismissalRow[]): Map<string, Date> {
  const byBucket = new Map<string, Date>()
  for (const row of dismissalRows) {
    const key = bucketKey(row.fieldKey)
    const existing = byBucket.get(key)
    if (!existing || row.dismissedAt > existing) byBucket.set(key, row.dismissedAt)
  }
  return byBucket
}

/** Extracted from `computeRotationRecommendedNudges` for the same complexity-ceiling reason:
 *  groups share rows by their `(credentialId, fieldKey)` bucket. */
function groupSharesByBucket(shareRows: ShareRow[]): Map<string, ShareRow[]> {
  const byBucket = new Map<string, ShareRow[]>()
  for (const row of shareRows) {
    const key = bucketKey(row.fieldKey)
    const list = byBucket.get(key)
    if (list) list.push(row)
    else byBucket.set(key, [row])
  }
  return byBucket
}

/** Extracted from `computeRotationRecommendedNudges` for the same complexity-ceiling reason:
 *  computes one bucket's `RotationRecommendedBucket` from its own rows plus its own most-recent
 *  dismissal (if any) — see AC-11's doc comment on the exported function for the exact rule. */
function buildBucket(
  key: string,
  rows: ShareRow[],
  lastDismissedAt: Date | null,
  viewer: { userId: string; isAdmin: boolean }
): RotationRecommendedBucket {
  const fieldKey = key === WHOLE_CREDENTIAL_BUCKET_KEY ? null : key
  // `groupSharesByBucket` only ever creates a bucket entry alongside its first row, so `rows` is
  // never empty here — the explicit check just satisfies noUncheckedIndexedAccess/strict typing.
  const [first, ...rest] = rows
  if (!first) throw new Error(`buildBucket called with an empty rows array for bucket "${key}"`)
  const mostRecent = rest.reduce(
    (latest, row) => (row.createdAt.getTime() > latest.createdAt.getTime() ? row : latest),
    first
  )
  const active = rows.some(
    (row) =>
      row.status !== 'superseded' &&
      (!lastDismissedAt || row.createdAt.getTime() > lastDismissedAt.getTime())
  )
  // Bugfix (post-implementation review): unlike `GET .../shares`, this route has no
  // `sharedByUserId` scoping — every project member can see every bucket's `active`/
  // `mostRecentShareAt` (the security nudge itself is a credential-wide signal everyone with
  // reveal access should see). But `mostRecentSharedWith` is recipient-identifying information
  // (an email address) that the sibling list endpoint deliberately withholds from a non-admin
  // caller who isn't the sharer — redact it here the same way, rather than handing out who a
  // teammate shared a secret with to any member who merely asks for the nudge state.
  const canSeeRecipient = viewer.isAdmin || mostRecent.sharedBy === viewer.userId
  return {
    fieldKey,
    active,
    mostRecentShareAt: mostRecent.createdAt.toISOString(),
    mostRecentSharedWith: canSeeRecipient
      ? (mostRecent.recipientEmail ?? mostRecent.recipientUserEmail ?? null)
      : null,
  }
}

/**
 * AC-11: `active = true` iff there exists a `credential_shares` row for the `(credentialId,
 * fieldKey)` bucket with `status != 'superseded'` AND `createdAt` is after the most recent
 * dismissal for that same bucket (or no dismissal exists at all). A `revoked`/`expired` (but not
 * `superseded`) share still counts toward `active` — the nudge's premise is "this secret's value
 * was exposed to someone at some point since the last rotation/dismissal," which revocation or
 * expiry of the *link* does not undo. `mostRecentShareAt`/`mostRecentSharedWith` always reflect
 * the bucket's single most recent share overall (regardless of status or dismissal timing) — a
 * later share re-triggers the nudge and becomes the new "most recent" for display purposes, even
 * though the earlier (now-irrelevant-for-activeness) share is what's ignored by the `active`
 * computation.
 */
export async function computeRotationRecommendedNudges(
  tx: Tx,
  params: { orgId: string; credentialId: string; viewerUserId: string; viewerIsAdmin: boolean }
): Promise<RotationRecommendedBucket[]> {
  const shareRows = await tx
    .select({
      fieldKey: credentialShares.fieldKey,
      status: credentialShares.status,
      createdAt: credentialShares.createdAt,
      recipientEmail: credentialShares.recipientEmail,
      recipientUserEmail: users.email,
      sharedBy: credentialShares.sharedBy,
    })
    .from(credentialShares)
    .leftJoin(users, eq(credentialShares.recipientUserId, users.id))
    .where(
      and(
        eq(credentialShares.orgId, params.orgId),
        eq(credentialShares.credentialId, params.credentialId)
      )
    )

  if (shareRows.length === 0) return []

  const dismissalRows = await tx
    .select({
      fieldKey: credentialShareNudgeDismissals.fieldKey,
      dismissedAt: credentialShareNudgeDismissals.dismissedAt,
    })
    .from(credentialShareNudgeDismissals)
    .where(
      and(
        eq(credentialShareNudgeDismissals.orgId, params.orgId),
        eq(credentialShareNudgeDismissals.credentialId, params.credentialId)
      )
    )

  const lastDismissalByBucket = latestDismissalByBucket(dismissalRows)
  const sharesByBucket = groupSharesByBucket(shareRows)

  const viewer = { userId: params.viewerUserId, isAdmin: params.viewerIsAdmin }
  const buckets: RotationRecommendedBucket[] = []
  for (const [key, rows] of sharesByBucket) {
    buckets.push(buildBucket(key, rows, lastDismissalByBucket.get(key) ?? null, viewer))
  }
  return buckets
}

// Story 17.3 AC-10/AC-15: non-empty (after trimming) reason enforced here, at the service layer —
// the API layer's zod schema already trims-and-requires-min-length-1 on the way in, but this
// function's own callers (a future non-HTTP caller, a test) get the same guarantee without
// depending on the HTTP schema layer.
export type DismissNudgeResult = { status: 'ok'; dismissedAt: Date } | { status: 'empty_reason' }

export async function dismissRotationRecommendedNudge(
  tx: Tx,
  params: {
    orgId: string
    credentialId: string
    fieldKey: string | null
    dismissedBy: string
    reason: string
  }
): Promise<DismissNudgeResult> {
  const trimmedReason = params.reason.trim()
  if (trimmedReason.length === 0) return { status: 'empty_reason' }

  const [row] = await tx
    .insert(credentialShareNudgeDismissals)
    .values({
      orgId: params.orgId,
      credentialId: params.credentialId,
      fieldKey: params.fieldKey,
      dismissedBy: params.dismissedBy,
      reason: trimmedReason,
    })
    .returning({ dismissedAt: credentialShareNudgeDismissals.dismissedAt })
  if (!row) throw new Error('dismissRotationRecommendedNudge: insert returned no row')
  return { status: 'ok', dismissedAt: row.dismissedAt }
}
