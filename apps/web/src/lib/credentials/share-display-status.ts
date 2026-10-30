import type { ShareDisplayStatus } from '@project-vault/shared'
import { m } from '$lib/paraglide/messages.js'

// Story 72.11 AC2: label and badge colours of a share's derived status, shared by the shares index
// and the credential's share list. Each pair is light text on a light tint with at least 4.5:1
// contrast (the `-900` text on the `-100` fill); the badge keeps a visible text label, never colour
// alone. Labels resolve per call (never at module load).
const LABELS = new Map<string, () => string>([
  ['active', () => m.shares_status_active()],
  ['opened', () => m.shares_status_opened()],
  ['locked', () => m.shares_status_locked()],
  ['revoked', () => m.shares_status_revoked()],
  ['expired', () => m.shares_status_expired()],
  ['superseded', () => m.shares_status_superseded()],
] satisfies [ShareDisplayStatus, () => string][])

const NEUTRAL = 'bg-slate-100 text-slate-800'

const BADGE_CLASSES = new Map<string, string>([
  ['active', 'bg-emerald-100 text-emerald-900'],
  ['opened', 'bg-sky-100 text-sky-900'],
  ['locked', 'bg-red-100 text-red-900'],
  ['revoked', NEUTRAL],
  ['expired', 'bg-amber-100 text-amber-900'],
  ['superseded', NEUTRAL],
] satisfies [ShareDisplayStatus, string][])

const BADGE_BASE = 'inline-block rounded-full px-2 py-1 text-xs font-semibold'

export function shareDisplayStatusLabel(status: string): string {
  return LABELS.get(status)?.() ?? status
}

export function shareDisplayStatusBadgeClass(status: string): string {
  return `${BADGE_BASE} ${BADGE_CLASSES.get(status) ?? NEUTRAL}`
}
