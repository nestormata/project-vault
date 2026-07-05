import type { RotationChecklistItemStatus, RotationStatus } from '@project-vault/shared'

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
