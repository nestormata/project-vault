// AC-22/23: a single shared presentation-layer mapping from internal event-type codes (audit-log
// eventTypes like `SESSION_CREATED`, monitoring alertTypes like `credential.expiry`) to a
// consistent, human-readable label — reused by Settings → Notifications preferences and
// Settings → Audit & Compliance so the same code always renders the same label in both places,
// instead of each surface maintaining its own copy of this map (which is exactly how the audit's
// "SESSION_CREATED" / "Backup Failure" / "audit_storage.critical" inconsistency happened).
import { AuditEvent } from '@project-vault/shared'

const ACRONYM_WORDS = new Set(['mfa', 'api', 'ip', 'kms', 'sso', 'dlq'])

/**
 * AC-23: fallback for any event-type code with no explicit entry below — title-cases each
 * dot/underscore-separated segment rather than leaking the raw code verbatim (or crashing on an
 * unexpected shape). Never throws and never returns undefined for a string input.
 */
export function humanizeEventType(raw: string): string {
  return raw
    .replace(/[._]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase()
      if (ACRONYM_WORDS.has(lower)) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

// Curated overrides where automatic humanization would read awkwardly, or where an established
// label already exists elsewhere in the codebase (kept in sync with the historical
// ALERT_TYPE_LABELS maps previously duplicated across the notifications inbox/settings pages).
const OVERRIDES: Record<string, string> = {
  'security.failed_auth_threshold': 'Failed Login Threshold',
  'security.mfa_recovery_used': 'MFA Recovery Code Used',
  'security.mfa_recovery_codes_regenerated': 'MFA Recovery Codes Regenerated',
  'credential.expiry': 'Credential Expiry',
  'service.down': 'Service Down',
  'service.recovery': 'Service Recovery',
  'rotation.stale': 'Stale Rotation',
  'backup.failure': 'Backup Failure',
  'machine_key.expiry': 'Machine Key Expiry',
  'security.anomalous_access': 'Anomalous Access',
  'machine_cache.activated': 'Offline Cache Activated',
}

// Auto-derive a baseline label for every canonical AuditEvent code (the single place the full set
// of valid audit-event strings is enumerated — see packages/shared/src/constants/audit-events.ts)
// so newly added audit events get a real label by default instead of relying solely on the
// runtime fallback. OVERRIDES above still wins for anything that needs curated wording.
const GENERATED_AUDIT_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(AuditEvent).map((code) => [code, humanizeEventType(code)])
)

const EVENT_TYPE_LABELS: Record<string, string> = {
  ...GENERATED_AUDIT_LABELS,
  ...OVERRIDES,
}

/** AC-22/23: the single lookup every event-type-rendering surface should call. */
export function getEventTypeLabel(rawEventType: string): string {
  return EVENT_TYPE_LABELS[rawEventType] ?? humanizeEventType(rawEventType)
}
