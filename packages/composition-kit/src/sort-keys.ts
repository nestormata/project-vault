import { compareCodeUnits } from './paths.js'

/** Recursively sorted object keys (code-unit order, locale independent), so JSON is byte-stable. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, entry]) => [key, sortKeys(entry)])
    )
  }
  return value
}
