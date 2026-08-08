import { describe, expect, it } from 'vitest'
import { describeBackupCron, describeRotationCron } from './rotation-cron-description.js'

const CUSTOM_SCHEDULE = 'Custom schedule'
const CUSTOM_SCHEDULE_ES = 'Programación personalizada'

describe('describeRotationCron', () => {
  it('describes a monthly day-of-month schedule in plain language', () => {
    expect(describeRotationCron('0 0 1 * *')).toBe('Every 1st day of the month')
    expect(describeRotationCron('15 2 21 * *')).toBe('Every 21st day of the month at 02:15 UTC')
    expect(describeRotationCron('0 0 11 * *')).toBe('Every 11th day of the month')
    expect(describeRotationCron('0 0 22 * *')).toBe('Every 22nd day of the month')
  })

  it('describes a daily schedule with its UTC time', () => {
    expect(describeRotationCron('0 3 * * *')).toBe('Every day at 03:00 UTC')
  })

  it('localizes the interpretation for Spanish users', () => {
    expect(describeRotationCron('0 3 * * *', 'es')).toBe('Cada día a las 03:00 UTC')
  })

  it('describes hourly and weekly schedules in both supported locales', () => {
    expect(describeBackupCron('0 * * * *')).toBe('Every hour at minute 0')
    expect(describeBackupCron('0 * * * *', 'es')).toBe('Cada hora en el minuto 0')
    expect(describeRotationCron('30 6 * * 1')).toBe('Every Monday at 06:30 UTC')
    expect(describeRotationCron('30 6 * * 7', 'es')).toBe('Cada domingo a las 06:30 UTC')
  })

  it('uses a friendly custom-schedule fallback for valid complex expressions', () => {
    expect(describeRotationCron('0 0 1,15 * *')).toBe(CUSTOM_SCHEDULE)
    expect(describeRotationCron('0 0 1,15 * *', 'es')).toBe(CUSTOM_SCHEDULE_ES)
  })

  it('describes syntactically valid backup schedules even when they run more often than hourly', () => {
    expect(describeBackupCron('*/30 * * * *')).toBe(CUSTOM_SCHEDULE)
  })

  it('returns a custom description for valid schedules that do not match a simple pattern', () => {
    expect(describeBackupCron('*/5 * 1 * *')).toBe(CUSTOM_SCHEDULE)
    expect(describeBackupCron('0 0 * * 1-5', 'es')).toBe(CUSTOM_SCHEDULE_ES)
  })

  it('returns null for invalid or too-frequent schedules', () => {
    expect(describeRotationCron('not a cron')).toBeNull()
    expect(describeRotationCron('* * * * *')).toBeNull()
    expect(describeBackupCron('0 0 * *')).toBeNull()
    expect(describeBackupCron('not a cron')).toBeNull()
  })
})
