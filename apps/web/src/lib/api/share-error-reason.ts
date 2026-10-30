import type { ShareErrorReason } from '@project-vault/shared'
import { m } from '$lib/paraglide/messages.js'
import { ApiClientError } from './client.js'

// Story 72.11 AC3: every `reason` of a sharer-side share error maps to a localized message.
// `share-error-reason.test.ts` fails when a reason of `SHARE_ERROR_REASONS` has no message here.
// Messages resolve per call (never at module load) so a locale switch is picked up.
const REASON_MESSAGES = new Map<ShareErrorReason, () => string>([
  ['credential_archived', () => m.share_reason_credential_archived()],
  ['field_unknown', () => m.share_reason_field_unknown()],
  ['scope_ambiguous', () => m.share_reason_scope_ambiguous()],
  ['scope_too_broad', () => m.share_reason_scope_too_broad()],
  ['expiry_in_past', () => m.share_reason_expiry_in_past()],
  ['expiry_too_late', () => m.share_reason_expiry_too_late()],
  ['recipient_unknown', () => m.share_reason_recipient_unknown()],
  ['recipient_inactive', () => m.share_reason_recipient_inactive()],
  ['self_share', () => m.share_reason_self_share()],
  ['must_be_single_use', () => m.share_reason_must_be_single_use()],
  ['step_up_required', () => m.share_reason_step_up_required()],
  ['external_cap_reached', () => m.share_reason_external_cap_reached()],
  ['revoke_forbidden', () => m.share_reason_revoke_forbidden()],
  ['already_closed', () => m.share_reason_already_closed()],
])

export function shareReasonMessage(reason: ShareErrorReason): string {
  return REASON_MESSAGES.get(reason)?.() ?? m.share_reason_generic()
}

/** The localized message of a share API error: its typed `reason` when it has a known one, else
 * `null` so the caller keeps its existing wording for that failure. */
export function shareErrorReasonMessage(error: unknown): string | null {
  if (!(error instanceof ApiClientError) || !error.reason) return null
  return REASON_MESSAGES.get(error.reason as ShareErrorReason)?.() ?? null
}
