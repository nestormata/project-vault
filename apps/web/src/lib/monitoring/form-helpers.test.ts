import { describe, expect, it } from 'vitest'
import { parseAlertLeadDaysInput, toIsoDate } from './form-helpers.js'

describe('toIsoDate (AC-B3: HTML date input -> ISO datetime the API expects)', () => {
  it('converts a YYYY-MM-DD value to a UTC midnight ISO datetime', () => {
    expect(toIsoDate('2026-09-01')).toBe('2026-09-01T00:00:00.000Z')
  })
})

describe('parseAlertLeadDaysInput (AC-B3 edge: comma-separated custom alert lead days)', () => {
  it('parses a comma-separated list into a number array', () => {
    expect(parseAlertLeadDaysInput('30, 14, 3')).toEqual([30, 14, 3])
  })

  it('returns undefined for blank input (left at server default)', () => {
    expect(parseAlertLeadDaysInput('')).toBeUndefined()
    expect(parseAlertLeadDaysInput('   ')).toBeUndefined()
  })

  it('ignores empty segments from stray commas', () => {
    expect(parseAlertLeadDaysInput('30,,14,')).toEqual([30, 14])
  })
})
