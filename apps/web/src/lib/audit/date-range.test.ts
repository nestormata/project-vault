import { describe, expect, it } from 'vitest'
import { toIsoRangeStart, toIsoRangeEnd, validateDateRange } from './date-range.js'

describe('date-range helpers (AC-B2/C1/D1/G1)', () => {
  it('toIsoRangeStart converts an <input type="date"> value to start-of-day UTC ISO', () => {
    expect(toIsoRangeStart('2026-06-01')).toBe('2026-06-01T00:00:00.000Z')
  })

  it('toIsoRangeEnd converts an <input type="date"> value to end-of-day UTC ISO', () => {
    expect(toIsoRangeEnd('2026-06-30')).toBe('2026-06-30T23:59:59.999Z')
  })

  it('validateDateRange returns null (no error) when to is after from', () => {
    expect(validateDateRange('2026-06-01', '2026-06-30')).toBeNull()
  })

  it('validateDateRange returns null when both are blank (nothing to validate yet)', () => {
    expect(validateDateRange('', '')).toBeNull()
  })

  it('validateDateRange returns an error message when to is before from', () => {
    expect(validateDateRange('2026-06-30', '2026-06-01')).toBe('End date must be after start date')
  })

  it('validateDateRange returns null when to equals from (a single-day range is valid)', () => {
    expect(validateDateRange('2026-06-01', '2026-06-01')).toBeNull()
  })
})
