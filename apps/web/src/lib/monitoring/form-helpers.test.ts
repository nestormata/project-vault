import { describe, expect, it } from 'vitest'
import {
  formatAlertLeadDays,
  formatDate,
  parseAlertLeadDaysInput,
  toDateInputValue,
  toIsoDate,
  validateCertificateFields,
  validateDomainFields,
} from './form-helpers.js'

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

describe('toDateInputValue', () => {
  it('slices an ISO datetime down to the YYYY-MM-DD an <input type="date"> expects', () => {
    expect(toDateInputValue('2026-09-01T00:00:00.000Z')).toBe('2026-09-01')
  })

  it('returns an empty string for null', () => {
    expect(toDateInputValue(null)).toBe('')
  })
})

describe('formatDate', () => {
  it('formats an ISO datetime as a short human-readable date', () => {
    expect(formatDate('2026-09-01T00:00:00.000Z')).toBe(
      new Date('2026-09-01T00:00:00.000Z').toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    )
  })

  it('returns an em dash for null', () => {
    expect(formatDate(null)).toBe('—')
  })
})

describe('formatAlertLeadDays', () => {
  it('joins multiple lead days into a readable sentence', () => {
    expect(formatAlertLeadDays([30, 7])).toBe('Alerts at 30, 7 days before')
  })

  it('returns an em dash for an empty list', () => {
    expect(formatAlertLeadDays([])).toBe('—')
  })
})

describe('validateCertificateFields', () => {
  it('requires domain and expiresAt', () => {
    expect(validateCertificateFields('', '')).toEqual({
      domain: 'Domain is required',
      expiresAt: 'Expiry date is required',
    })
  })

  it('passes with both fields present and no maxDomainLength configured (edit form)', () => {
    expect(validateCertificateFields('a'.repeat(300), '2026-09-01')).toEqual({})
  })

  it('enforces maxDomainLength only when configured (create form)', () => {
    expect(
      validateCertificateFields('a'.repeat(300), '2026-09-01', { maxDomainLength: 253 })
    ).toEqual({ domain: 'Domain must be 253 characters or fewer' })
  })
})

describe('validateDomainFields', () => {
  it('requires domainName and renewalDate', () => {
    expect(validateDomainFields('', '')).toEqual({
      domainName: 'Domain name is required',
      renewalDate: 'Renewal date is required',
    })
  })

  it('passes with both fields present', () => {
    expect(validateDomainFields('example.com', '2026-09-01')).toEqual({})
  })
})
