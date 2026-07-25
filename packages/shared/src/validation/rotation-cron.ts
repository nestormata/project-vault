import { CronExpressionParser } from 'cron-parser'

// cron-parser interprets expressions in the process's local timezone unless `tz` is given
// explicitly, so an unpinned parse produces a different "next occurrence" on every machine/
// environment (verified: dev machines outside UTC get several extra hours of buffer that CI,
// which runs in UTC, does not — this exact gap made a month-boundary rotation schedule pass
// locally while failing deterministically in CI). Pin UTC everywhere in this file, matching
// apps/api/src/lib/boss.ts's existing `{ tz: 'UTC' }` convention for its own cron scheduling,
// so "next due" is identical regardless of where it's computed.
const MIN_INTERVAL_MS = 60 * 60 * 1000
const MAX_SAMPLES = 100
const MAX_SAMPLE_SPAN_MS = 7 * 24 * 60 * 60 * 1000

export type RotationCronResult =
  { ok: true } | { ok: false; reason: 'unparseable' | 'too_frequent' }

/** Story 5.2 FR65: single "next occurrence" computation relative to a reference date — same
 *  cron-parser import/API validateRotationCron() above already uses, just called once instead
 *  of iterated for a multi-sample validation loop. Throws on an unparseable expression (callers
 *  should already only pass write-time-validated cron strings, but a caller iterating many
 *  credentials should catch and skip rather than let one bad string abort the whole batch). */
export function nextCronOccurrence(expr: string, referenceDate: Date): Date {
  return CronExpressionParser.parse(expr, { currentDate: referenceDate, tz: 'UTC' }).next().toDate()
}

export function validateRotationCron(expr: string): RotationCronResult {
  if (expr.trim().split(/\s+/).length !== 5) return { ok: false, reason: 'unparseable' }
  try {
    const interval = CronExpressionParser.parse(expr, { tz: 'UTC' })
    let previous = interval.next().toDate().getTime()
    const windowStart = previous
    for (let i = 0; i < MAX_SAMPLES; i++) {
      const current = interval.next().toDate().getTime()
      if (current - previous < MIN_INTERVAL_MS) return { ok: false, reason: 'too_frequent' }
      if (current - windowStart > MAX_SAMPLE_SPAN_MS) break
      previous = current
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
}
