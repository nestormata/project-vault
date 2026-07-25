import { CronExpressionParser } from 'cron-parser'
import { describe, expect, it } from 'vitest'
import { nextCronOccurrence, validateRotationCron } from './rotation-cron.js'

describe('validateRotationCron', () => {
  it('accepts valid hourly and monthly schedules', () => {
    expect(validateRotationCron('0 * * * *')).toEqual({ ok: true })
    expect(validateRotationCron('0 3 1 * *')).toEqual({ ok: true })
  })

  it('rejects too-frequent schedules', () => {
    expect(validateRotationCron('* * * * *')).toEqual({ ok: false, reason: 'too_frequent' })
    expect(validateRotationCron('*/30 * * * *')).toEqual({ ok: false, reason: 'too_frequent' })
  })

  it('accepts schedules whose minimum consecutive gap is exactly one hour', () => {
    expect(validateRotationCron('0 23,0 * * *')).toEqual({ ok: true })
  })

  it('rejects unparseable expressions', () => {
    expect(validateRotationCron('not a cron')).toEqual({ ok: false, reason: 'unparseable' })
    expect(validateRotationCron('0 0 30 2 *')).toEqual({ ok: false, reason: 'unparseable' })
    expect(validateRotationCron('0 0 * * * *')).toEqual({ ok: false, reason: 'unparseable' })
    expect(validateRotationCron('')).toEqual({ ok: false, reason: 'unparseable' })
  })
})

describe('nextCronOccurrence (Story 5.2 FR65)', () => {
  it('computes the next occurrence relative to a given reference date, matching cron-parser directly (pinned to UTC)', () => {
    const reference = new Date('2026-07-15T12:00:00.000Z')
    const expected = CronExpressionParser.parse('0 0 1 * *', { currentDate: reference, tz: 'UTC' })
      .next()
      .toDate()
    expect(nextCronOccurrence('0 0 1 * *', reference)).toEqual(expected)
    expect(expected.getTime()).toBeGreaterThan(reference.getTime())
  })

  it('is independent of the process local timezone (UTC pinned, not machine-local)', () => {
    const reference = new Date('2026-07-15T12:00:00.000Z')
    expect(nextCronOccurrence('0 0 1 * *', reference)).toEqual(new Date('2026-08-01T00:00:00.000Z'))
  })

  it('throws for an unparseable expression rather than silently returning a bogus date', () => {
    expect(() => nextCronOccurrence('not a cron', new Date())).toThrow()
  })
})
