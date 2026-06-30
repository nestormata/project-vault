import { describe, expect, it } from 'vitest'
import { daysUntil, expiresWithinDays, highlightParts } from './search-ui.js'

describe('search-ui', () => {
  it('highlightParts marks matching substring', () => {
    const parts = highlightParts('Stripe API Key', 'stripe')
    expect(parts.some((p) => p.match && p.text.toLowerCase() === 'stripe')).toBe(true)
  })

  it('expiresWithinDays returns true inside window', () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    expect(expiresWithinDays(soon)).toBe(true)
  })

  it('daysUntil returns positive days for future expiry', () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    expect(daysUntil(soon)).toBeGreaterThan(0)
  })
})
