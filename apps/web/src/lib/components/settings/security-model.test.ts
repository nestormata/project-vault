import { describe, expect, it } from 'vitest'
import {
  describeRemainingRecoveryCodes,
  formatEnrolledAt,
  isValidTotpInput,
  qrCodeDataUri,
} from './security-model.js'

describe('isValidTotpInput', () => {
  it('accepts exactly six digits', () => {
    expect(isValidTotpInput('123456')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isValidTotpInput('12345')).toBe(false)
    expect(isValidTotpInput('1234567')).toBe(false)
    expect(isValidTotpInput('12345a')).toBe(false)
    expect(isValidTotpInput('')).toBe(false)
  })
})

describe('formatEnrolledAt', () => {
  it('renders an em dash for null', () => {
    expect(formatEnrolledAt(null)).toBe('—')
  })

  it('renders a human-readable date for an ISO timestamp', () => {
    expect(formatEnrolledAt('2026-07-07T12:00:00.000Z')).toContain('2026')
  })
})

describe('describeRemainingRecoveryCodes', () => {
  it('is blank when the count is unknown', () => {
    expect(describeRemainingRecoveryCodes(null)).toBe('')
  })

  it('calls out zero remaining codes distinctly', () => {
    expect(describeRemainingRecoveryCodes(0)).toBe(
      'No unused recovery codes remain — regenerate a fresh batch.'
    )
  })

  it('uses singular phrasing for exactly one', () => {
    expect(describeRemainingRecoveryCodes(1)).toBe('1 unused recovery code remains.')
  })

  it('uses plural phrasing otherwise', () => {
    expect(describeRemainingRecoveryCodes(7)).toBe('7 unused recovery codes remain.')
  })
})

describe('qrCodeDataUri', () => {
  it('encodes the SVG as a base64 data URI, decodable back to the original markup', () => {
    const svg = '<svg><rect width="1" height="1"/></svg>'
    const uri = qrCodeDataUri(svg)

    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/)
    const decoded = decodeURIComponent(escape(atob(uri.split(',')[1])))
    expect(decoded).toBe(svg)
  })
})
