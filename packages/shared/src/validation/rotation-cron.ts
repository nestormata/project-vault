import { CronExpressionParser } from 'cron-parser'

const MIN_INTERVAL_MS = 60 * 60 * 1000
const SAMPLE_OCCURRENCES = 6

export type RotationCronResult =
  { ok: true } | { ok: false; reason: 'unparseable' | 'too_frequent' }

export function validateRotationCron(expr: string): RotationCronResult {
  if (expr.trim().split(/\s+/).length !== 5) return { ok: false, reason: 'unparseable' }
  try {
    const interval = CronExpressionParser.parse(expr)
    const times: number[] = []
    for (let i = 0; i < SAMPLE_OCCURRENCES; i++) {
      times.push(interval.next().toDate().getTime())
    }
    for (let i = 1; i < times.length; i++) {
      const prev = times[i - 1]
      const curr = times[i]
      if (prev === undefined || curr === undefined) continue
      if (curr - prev < MIN_INTERVAL_MS) return { ok: false, reason: 'too_frequent' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
}
