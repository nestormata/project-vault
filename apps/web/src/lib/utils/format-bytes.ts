export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'In progress\u2026'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export type ByteInputUnit = 'MB' | 'GB'

/**
 * Story 22.3 AC-5 (Assumption Audit finding, elicitation round 5) \u2014 the natural counterpart to
 * `formatBytes()`: converts a human-friendly value + unit selector into an exact byte integer,
 * so an operator editing a quota never has to type a raw byte count. `MB`/`GB` only (matching the
 * unit selector's own scope \u2014 quotas are never usefully expressed in KB/TB on this page).
 */
export function parseByteInput(value: number, unit: ByteInputUnit): number {
  const multiplier = unit === 'GB' ? 1024 ** 3 : 1024 ** 2
  return Math.round(value * multiplier)
}

/**
 * The inverse convenience helper: picks whichever unit `formatBytes()` would have chosen for a
 * given quota (GB above 1024 MB, MB otherwise), defaulting to GB for an unlimited (`null`) quota
 * per AC-5's own default rule.
 */
export function defaultByteInputUnit(quotaBytes: number | null): ByteInputUnit {
  if (quotaBytes === null) return 'GB'
  return quotaBytes >= 1024 ** 3 ? 'GB' : 'MB'
}
