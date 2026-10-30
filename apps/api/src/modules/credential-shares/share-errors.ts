import type { ShareErrorReason } from '@project-vault/shared'

/**
 * Story 72-11 V12: the `code` each typed `reason` rides next to. Codes are the pre-existing ones
 * (unchanged); the table is exhaustive over `ShareErrorReason`, so a reason cannot exist without a
 * code and a route cannot invent one.
 */
export const SHARE_ERROR_CODE_BY_REASON = {
  credential_archived: 'credential_archived',
  field_unknown: 'unknown_field_key',
  scope_ambiguous: 'ambiguous_share_scope',
  scope_too_broad: 'too_many_attribute_keys',
  expiry_in_past: 'expires_at_invalid',
  expiry_too_late: 'expires_at_invalid',
  recipient_unknown: 'recipient_not_found',
  recipient_inactive: 'recipient_inactive',
  self_share: 'self_share',
  must_be_single_use: 'external_share_must_be_single_use',
  step_up_required: 'step_up_required',
  external_cap_reached: 'external_share_cap_exceeded',
  revoke_forbidden: 'insufficient_role',
  already_closed: 'share_already_closed',
} as const satisfies Record<ShareErrorReason, string>

const CODE_LOOKUP: ReadonlyMap<ShareErrorReason, string> = new Map(
  Object.entries(SHARE_ERROR_CODE_BY_REASON) as [ShareErrorReason, string][]
)

export type ShareErrorBody = {
  code: string
  message: string
  reason: ShareErrorReason
  field?: string
}

/**
 * The ONE builder of sharer-side share error bodies. Call it only after the authorization and
 * visibility gates passed: a 404/401/403 for an actor without access stays a plain body with no
 * `reason`, so a reason can never confirm that a hidden credential or share exists.
 */
export function shareErrorBody(
  reason: ShareErrorReason,
  message: string,
  extra?: { field?: string }
): ShareErrorBody {
  return { code: CODE_LOOKUP.get(reason) ?? reason, message, reason, ...extra }
}
