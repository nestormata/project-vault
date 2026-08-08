import { describe, expect, it } from 'vitest'
import { describeBackupCron, describeRotationCron } from './rotation-cron-description.js'

describe('describeRotationCron', () => {
  it('describes a monthly day-of-month schedule in plain language', () => {
    expect(describeRotationCron('0 0 1 * *')).toBe('Every 1st day of the month')
  })

  it('describes a daily schedule with its UTC time', () => {
    expect(describeRotationCron('0 3 * * *')).toBe('Every day at 03:00 UTC')
  })

  it('localizes the interpretation for Spanish users', () => {
    expect(describeRotationCron('0 3 * * *', 'es')).toBe('Cada día a las 03:00 UTC')
  })

  it('uses a friendly custom-schedule fallback for valid complex expressions', () => {
    expect(describeRotationCron('0 0 1,15 * *')).toBe('Custom schedule')
    expect(describeRotationCron('0 0 1,15 * *', 'es')).toBe('Programación personalizada')
  })

  it('describes syntactically valid backup schedules even when they run more often than hourly', () => {
    expect(describeBackupCron('*/30 * * * *')).toBe('Custom schedule')
  })

  it('returns null for invalid or too-frequent schedules', () => {
    expect(describeRotationCron('not a cron')).toBeNull()
    expect(describeRotationCron('* * * * *')).toBeNull()
  })
})
