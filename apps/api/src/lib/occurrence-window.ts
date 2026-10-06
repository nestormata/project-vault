/**
 * Story 71.4 — the one pure occurrence-time rule, shared by the S1 stage (`delegation-stages.ts`,
 * the signed `occ`) and the write boundary (`extension-attribution.ts`, `occurredAt`) so the two
 * cannot drift. No clock of its own: the caller injects `nowMs`.
 */

/** D3: an occurrence time may be at most this far in the future (clock skew between hosts). */
export const OCCURRED_AT_FUTURE_SKEW_SECONDS = 30

/** D3: without the issuer's signed `occ`, a past time is the extension's word, so keep it this close
 * to now (the assertion lifetime plus skew). Also the default window of a route with no policy. */
export const OCCURRED_AT_UNATTESTED_MAX_PAST_SECONDS = 90

/** D4: the hard cap (30 days) on any occurrence time and on a route's declared window. Mirrors the
 * extension-api registration check; there is no env override. */
export const OCCURRED_AT_MAX_AGE_SECONDS = 2_592_000

export type OccurrenceVerdict = 'ok' | 'future' | 'too_old'

/**
 * `maxAgeSeconds` is the window the caller allows; it is always bounded by the hard cap. Both
 * bounds are inclusive.
 */
export function classifyOccurrence(input: {
  occurredAtMs: number
  nowMs: number
  maxAgeSeconds: number
}): OccurrenceVerdict {
  const ageMs = input.nowMs - input.occurredAtMs
  if (ageMs < -OCCURRED_AT_FUTURE_SKEW_SECONDS * 1000) return 'future'
  const maxAge = Math.min(input.maxAgeSeconds, OCCURRED_AT_MAX_AGE_SECONDS)
  return ageMs > maxAge * 1000 ? 'too_old' : 'ok'
}
