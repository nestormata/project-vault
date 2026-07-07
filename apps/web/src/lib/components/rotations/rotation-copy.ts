import { ApiClientError } from '$lib/api/client.js'
import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
import { formatDateTime } from '$lib/datetime.js'
import type { RotationChecklistItemStatus, RotationStatus } from '@project-vault/shared'

export { formatDateTime }

// AC-1/AC-18: a single source of truth for the "no rotations exist yet" empty state, shared by
// the credential detail page's Rotation section (both the CTA area and the history section).
export const rotationCopy = {
  noRotationsYet: 'No rotations yet.',
  startRotationRequiresAdmin: 'Starting a rotation requires Admin access or higher.',
  checklistActionsRequireMember:
    'You have read access to this rotation. Confirming, completing, or resolving rotations requires Member access or higher.',
} as const

export function checklistItemStatusLabel(status: RotationChecklistItemStatus): string {
  if (status === 'max_retries_exceeded') return 'max retries exceeded'
  return status
}

export function checklistItemStatusBadgeClass(status: RotationChecklistItemStatus): string {
  switch (status) {
    case 'confirmed':
      return 'rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800'
    case 'failed':
    case 'max_retries_exceeded':
      return 'rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800'
    case 'unconfirmed':
    default:
      return 'rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700'
  }
}

export function rotationStatusLabel(status: RotationStatus): string {
  return status
}

export function rotationStatusBadgeClass(status: RotationStatus): string {
  switch (status) {
    case 'completed':
      return 'rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800'
    case 'in_progress':
      return 'rounded-full bg-sky-100 px-2 py-1 text-xs font-semibold text-sky-800'
    case 'stale_recovery':
      return 'rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900'
    case 'break_glass_complete':
      return 'rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800'
    case 'abandoned':
    default:
      return 'rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700'
  }
}

export interface MapRotationMutationErrorOptions {
  // Rendered as "Enable MFA to {actionLabel}." (D4) — matches the members-page precedent's
  // `errorMessage.includes('MFA')` link-out convention (AC-21) verbatim. Omitted for call sites
  // where the server can never send `mfa_required` (Group B non-goal — confirm/fail/retry).
  actionLabel?: string
  // AC-12: break-glass gets a distinct, reassuring 429 framing since a fumbled CONFIRM retry
  // mid-incident could plausibly trip its much tighter 10/min cap. Every other mutation uses the
  // plain, generic countdown message.
  rateLimitFraming?: 'default' | 'break-glass'
}

// AC-11/AC-12: extracted so mapRotationMutationError itself stays under the project's complexity
// lint threshold. retryAfter absent/non-numeric never crashes — falls back to a generic message
// rather than rendering "undefined seconds" (AC-11's edge case).
function mapRateLimitError(
  error: ApiClientError,
  rateLimitFraming: 'default' | 'break-glass' | undefined
): string {
  const retryAfter = error.body?.retryAfter
  if (typeof retryAfter !== 'number') {
    return 'Try again shortly.'
  }
  if (rateLimitFraming === 'break-glass') {
    return `Too many break-glass attempts. Try again in ${retryAfter} seconds — this limit exists to prevent runaway automated calls, not to block a real incident response.`
  }
  return `Too many attempts. Try again in ${retryAfter} seconds.`
}

// D3/AC-20: single shared error-mapping function for the 503/mfa_required/429 branches every
// rotation mutation call site (initiate, break-glass, confirm/fail/retry, complete,
// resume/abandon) needs, instead of independently re-deriving the same three branches five times.
// Callers are still responsible for handling their own endpoint-specific codes (e.g. 409
// rotation_in_progress/concurrent_modification, 422 checklist_incomplete) *before* falling
// through to this helper — this only covers the generic cross-cutting cases plus a final
// error.message/fallback branch.
export function mapRotationMutationError(
  error: unknown,
  options: MapRotationMutationErrorOptions,
  fallback: string
): string {
  if (!(error instanceof ApiClientError)) {
    return error instanceof Error ? error.message : fallback
  }

  if (error.status === 503) {
    return onboardingCopy.vaultSealedMessage
  }

  if (error.status === 403 && error.code === 'mfa_required' && options.actionLabel) {
    return `Enable MFA to ${options.actionLabel}.`
  }

  if (error.status === 429 && error.code === 'rate_limit_exceeded') {
    return mapRateLimitError(error, options.rateLimitFraming)
  }

  return error.message
}
