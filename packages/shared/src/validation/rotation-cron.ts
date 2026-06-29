import { CronExpressionParser } from 'cron-parser'

const MIN_INTERVAL_MS = 60 * 60 * 1000
const MAX_SAMPLES = 100
const MAX_SAMPLE_SPAN_MS = 7 * 24 * 60 * 60 * 1000

export type RotationCronResult =
  { ok: true } | { ok: false; reason: 'unparseable' | 'too_frequent' }

export function validateRotationCron(expr: string): RotationCronResult {
  if (expr.trim().split(/\s+/).length !== 5) return { ok: false, reason: 'unparseable' }
  try {
    const interval = CronExpressionParser.parse(expr)
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
