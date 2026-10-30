/**
 * Story 72-11 AC2: the status a share is SHOWN with, derived from its persisted row. The persisted
 * `status` column and every extension-facing status stay as they are; this is a read-side view
 * shared by the API (share summaries, the `/shares` index filter) and the web (badges).
 */
export const SHARE_DISPLAY_STATUSES = [
  'active',
  'opened',
  'locked',
  'revoked',
  'expired',
  'superseded',
] as const

export type ShareDisplayStatus = (typeof SHARE_DISPLAY_STATUSES)[number]

/** The row fields the derivation reads. `lockedAt` accepts a Date (API row) or an ISO string
 *  (serialized summary); only its presence matters. */
export type ShareDisplayStatusInput = {
  status: string
  singleUse: boolean
  viewCount: number
  lockedAt: Date | string | null
}

/**
 * Precedence (V10): `locked` (an attempt cap closed the share, `locked_at` set) wins over
 * everything, then `opened` (the secret was revealed: status `viewed`, or an active multi-view
 * share with `viewCount > 0`), then the persisted status. An unknown persisted status reads as
 * `revoked`: a display must never call a share it does not understand live.
 */
export function deriveShareDisplayStatus(share: ShareDisplayStatusInput): ShareDisplayStatus {
  if (share.lockedAt !== null) return 'locked'
  if (share.status === 'viewed') return 'opened'
  if (share.status === 'active') {
    return !share.singleUse && share.viewCount > 0 ? 'opened' : 'active'
  }
  if (share.status === 'expired' || share.status === 'superseded') return share.status
  return 'revoked'
}
