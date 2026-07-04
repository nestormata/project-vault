import { describe, expect, it } from 'vitest'
import {
  computeDaysRemaining,
  computeExpiryAlertFirings,
  severityForDaysRemaining,
} from './expiry-alert-shared.js'

describe('computeDaysRemaining', () => {
  it('ceils the number of whole days between now and the expiry date', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const expiry = new Date('2026-01-08T00:00:00.001Z')
    expect(computeDaysRemaining(expiry, now)).toBe(8)
  })

  it('returns a negative number for an already-overdue expiry date', () => {
    const now = new Date('2026-01-21T00:00:00.000Z')
    const expiry = new Date('2026-01-01T00:00:00.000Z')
    expect(computeDaysRemaining(expiry, now)).toBe(-20)
  })
})

describe('severityForDaysRemaining', () => {
  it('is critical at exactly 3 days remaining', () => {
    expect(severityForDaysRemaining(3)).toBe('critical')
  })

  it('is critical below 3 days remaining (including overdue)', () => {
    expect(severityForDaysRemaining(0)).toBe('critical')
    expect(severityForDaysRemaining(-5)).toBe('critical')
  })

  it('is warning at exactly 7 days remaining', () => {
    expect(severityForDaysRemaining(7)).toBe('warning')
  })

  it('is warning between 4 and 7 days remaining', () => {
    expect(severityForDaysRemaining(4)).toBe('warning')
    expect(severityForDaysRemaining(6)).toBe('warning')
  })

  it('is info at exactly 30 days remaining and beyond', () => {
    expect(severityForDaysRemaining(30)).toBe('info')
    expect(severityForDaysRemaining(8)).toBe('info')
    expect(severityForDaysRemaining(60)).toBe('info')
  })
})

describe('computeExpiryAlertFirings', () => {
  it('fires once for a threshold within the +/-1 day tolerance', () => {
    const result = computeExpiryAlertFirings({
      daysRemaining: 7,
      alertLeadDays: [30, 7],
      notifiedLeadDays: [],
    })
    expect(result.firings).toEqual([{ threshold: 7, severity: 'warning', overdue: false }])
    expect(result.nextNotifiedLeadDays).toEqual([7])
  })

  it('does not re-fire a threshold already present in notifiedLeadDays', () => {
    const result = computeExpiryAlertFirings({
      daysRemaining: 6,
      alertLeadDays: [30, 7],
      notifiedLeadDays: [7],
    })
    expect(result.firings).toEqual([])
    expect(result.nextNotifiedLeadDays).toEqual([7])
  })

  it('matches within +/-1 day tolerance on either side', () => {
    const below = computeExpiryAlertFirings({
      daysRemaining: 29,
      alertLeadDays: [30],
      notifiedLeadDays: [],
    })
    expect(below.firings.map((f) => f.threshold)).toEqual([30])

    const above = computeExpiryAlertFirings({
      daysRemaining: 31,
      alertLeadDays: [30],
      notifiedLeadDays: [],
    })
    expect(above.firings.map((f) => f.threshold)).toEqual([30])
  })

  it('does not match outside the +/-1 day tolerance', () => {
    const result = computeExpiryAlertFirings({
      daysRemaining: 28,
      alertLeadDays: [30],
      notifiedLeadDays: [],
    })
    expect(result.firings).toEqual([])
    expect(result.nextNotifiedLeadDays).toEqual([])
  })

  it('can fire multiple thresholds in the same run when they are close together', () => {
    const result = computeExpiryAlertFirings({
      daysRemaining: 8,
      alertLeadDays: [7, 9],
      notifiedLeadDays: [],
    })
    expect(result.firings.map((f) => f.threshold).sort()).toEqual([7, 9])
    expect(result.nextNotifiedLeadDays.sort()).toEqual([7, 9])
  })

  it('fires a critical overdue alert once when daysRemaining <= 0 and 0 is not yet notified', () => {
    const result = computeExpiryAlertFirings({
      daysRemaining: -21,
      alertLeadDays: [30, 7],
      notifiedLeadDays: [],
    })
    expect(result.firings).toEqual([{ threshold: 0, severity: 'critical', overdue: true }])
    expect(result.nextNotifiedLeadDays).toEqual([0])
  })

  it('does not re-fire the overdue alert once 0 is already in notifiedLeadDays', () => {
    const result = computeExpiryAlertFirings({
      daysRemaining: -22,
      alertLeadDays: [30, 7],
      notifiedLeadDays: [0],
    })
    expect(result.firings).toEqual([])
  })

  it('can fire both a positive threshold and the overdue marker on the same day', () => {
    // daysRemaining = 0 is within tolerance of v=1 AND triggers the overdue (v=0) rule.
    const result = computeExpiryAlertFirings({
      daysRemaining: 0,
      alertLeadDays: [1],
      notifiedLeadDays: [],
    })
    expect(result.firings).toEqual(
      expect.arrayContaining([
        { threshold: 1, severity: 'critical', overdue: false },
        { threshold: 0, severity: 'critical', overdue: true },
      ])
    )
    expect(result.nextNotifiedLeadDays.sort()).toEqual([0, 1])
  })
})
