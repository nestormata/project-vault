import { afterEach, describe, expect, it, vi } from 'vitest'
import { daysUntil, expiresWithinDays, highlightParts } from './search-ui.js'

describe('search-ui', () => {
  afterEach(() => vi.useRealTimers())

  it('highlightParts marks matching substring', () => {
    const parts = highlightParts('Stripe API Key', 'stripe')
    expect(parts.some((p) => p.match && p.text.toLowerCase() === 'stripe')).toBe(true)
  })

  it('returns plain text for blank and missing queries and preserves both sides of a match', () => {
    expect(highlightParts('Stripe API Key', '   ')).toEqual([
      { text: 'Stripe API Key', match: false },
    ])
    expect(highlightParts('Stripe API Key', 'missing')).toEqual([
      { text: 'Stripe API Key', match: false },
    ])
    expect(highlightParts('Stripe API Key', 'API')).toEqual([
      { text: 'Stripe ', match: false },
      { text: 'API', match: true },
      { text: ' Key', match: false },
    ])
    expect(highlightParts('Stripe API Key', 'Key')).toEqual([
      { text: 'Stripe API ', match: false },
      { text: 'Key', match: true },
    ])
  })

  it('expiresWithinDays returns true inside window', () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    expect(expiresWithinDays(soon)).toBe(true)
  })

  it('rejects absent, expired, and beyond-window expirations while accepting the boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'))
    expect(expiresWithinDays(null)).toBe(false)
    expect(expiresWithinDays('2026-07-09T23:59:59.000Z')).toBe(false)
    expect(expiresWithinDays('2026-08-10T00:00:00.000Z', 30)).toBe(false)
    expect(expiresWithinDays('2026-08-09T00:00:00.000Z', 30)).toBe(true)
  })

  it('daysUntil returns positive days for future expiry', () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    expect(daysUntil(soon)).toBeGreaterThan(0)
  })
})
