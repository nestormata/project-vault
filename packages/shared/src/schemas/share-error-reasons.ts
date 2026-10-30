import { z } from 'zod/v4'
import { ApiErrorSchema } from './api.js'

/**
 * Story 72-11 V12: the closed set of `reason` values on sharer-side share errors (create member
 * share, create external share, revoke, per-credential list). A reason sits next to the existing
 * `code` (codes are unchanged) and is only ever sent AFTER authorization and visibility passed.
 */
export const SHARE_ERROR_REASONS = [
  'credential_archived',
  'field_unknown',
  'scope_ambiguous',
  'scope_too_broad',
  'expiry_in_past',
  'expiry_too_late',
  'recipient_unknown',
  'recipient_inactive',
  'self_share',
  'must_be_single_use',
  'step_up_required',
  'external_cap_reached',
  'revoke_forbidden',
  'already_closed',
] as const

export type ShareErrorReason = (typeof SHARE_ERROR_REASONS)[number]

export const ShareErrorReasonSchema = z.enum(SHARE_ERROR_REASONS)

/** The sharer-side error body: `ApiError` plus the additive, closed `reason`. */
export const ShareApiErrorSchema = ApiErrorSchema.extend({
  reason: ShareErrorReasonSchema.optional(),
}).meta({ id: 'ShareApiError' })

export type ShareApiError = z.infer<typeof ShareApiErrorSchema>
