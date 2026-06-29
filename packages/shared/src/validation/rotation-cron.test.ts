import { describe, expect, it } from 'vitest'
import { validateRotationCron } from './rotation-cron.js'

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
