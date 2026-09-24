import { sanitizeServerText } from './sanitize-server-text.js'

/**
 * Story 43.6 (decision D10) — `PVAULT_NO_VERSION_CHECK` suppresses the advisory notices only
 * (stale / below-minimum / server-older). It never skips the request, the cache, or the withdrawn
 * refusal. Any value other than the accepted on/off spellings is ignored (notices still print) and
 * reported once with `noVersionCheckWarning()`.
 */
export type NoVersionCheckSetting = { suppress: boolean; invalid: boolean }

const ON_VALUES = new Set(['1', 'true'])
const OFF_VALUES = new Set(['', '0', 'false'])
const WARNING_VALUE_MAX_CODE_POINTS = 40

export function parseNoVersionCheck(raw: string | undefined): NoVersionCheckSetting {
  if (raw === undefined) return { suppress: false, invalid: false }
  const normalized = raw.trim().toLowerCase()
  if (ON_VALUES.has(normalized)) return { suppress: true, invalid: false }
  if (OFF_VALUES.has(normalized)) return { suppress: false, invalid: false }
  return { suppress: false, invalid: true }
}

export function noVersionCheckWarning(raw: string): string {
  const shown = sanitizeServerText(raw, WARNING_VALUE_MAX_CODE_POINTS)
  return `warning: ignoring PVAULT_NO_VERSION_CHECK=${shown}; use 1 or true to silence version notices\n`
}
