import { describe, expect, it } from 'vitest'
import { SHARE_DISPLAY_STATUSES, deriveShareDisplayStatus } from './share-display-status.js'

const base = { status: 'active', singleUse: true, viewCount: 0, lockedAt: null } as const

describe('deriveShareDisplayStatus (Story 72-11 AC2, V10)', () => {
  it('lists the six display statuses in one closed array', () => {
    expect(SHARE_DISPLAY_STATUSES).toEqual([
      'active',
      'opened',
      'locked',
      'revoked',
      'expired',
      'superseded',
    ])
  })

  it('maps an untouched active share to active', () => {
    expect(deriveShareDisplayStatus(base)).toBe('active')
  })

  it('maps a viewed single-use share to opened', () => {
    expect(deriveShareDisplayStatus({ ...base, status: 'viewed', viewCount: 1 })).toBe('opened')
  })

  it('maps an active multi-view share that was revealed to opened', () => {
    expect(deriveShareDisplayStatus({ ...base, singleUse: false, viewCount: 2 })).toBe('opened')
  })

  it('keeps an active multi-view share with no reveal active', () => {
    expect(deriveShareDisplayStatus({ ...base, singleUse: false })).toBe('active')
  })

  it.each(['revoked', 'expired', 'superseded'] as const)('passes %s through', (status) => {
    expect(deriveShareDisplayStatus({ ...base, status })).toBe(status)
  })

  it('locked wins over revoked and over opened', () => {
    const lockedAt = new Date()
    expect(deriveShareDisplayStatus({ ...base, status: 'revoked', lockedAt })).toBe('locked')
    expect(
      deriveShareDisplayStatus({ ...base, status: 'revoked', viewCount: 1, lockedAt: 'x' })
    ).toBe('locked')
  })

  it('a multi-view share that was revealed and then expired reads expired (AC2 literal)', () => {
    expect(
      deriveShareDisplayStatus({ ...base, singleUse: false, status: 'expired', viewCount: 1 })
    ).toBe('expired')
  })

  it('treats an unknown persisted status as revoked (fail closed, never active)', () => {
    expect(deriveShareDisplayStatus({ ...base, status: 'bogus' })).toBe('revoked')
  })
})
