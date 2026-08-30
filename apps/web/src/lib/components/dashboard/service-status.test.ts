import { describe, expect, it } from 'vitest'
import {
  PENDING_CHECK_LABEL,
  formatCheckedAt,
  statusBadgeClass,
  statusBadgeLabel,
  statusClass,
} from './service-status.js'

describe('service-status.ts (Story 28.7 AC5/AC6/AC7/AC8)', () => {
  describe('statusBadgeLabel', () => {
    it('AC5: renders a neutral pending label, not the raw status, when lastCheckedAt is null', () => {
      expect(statusBadgeLabel('healthy', null)).toBe(PENDING_CHECK_LABEL)
      expect(statusBadgeLabel('degraded', null)).toBe(PENDING_CHECK_LABEL)
      expect(statusBadgeLabel('down', null)).toBe(PENDING_CHECK_LABEL)
    })

    it('AC8: renders the real status once lastCheckedAt is set (post-check behavior unchanged)', () => {
      expect(statusBadgeLabel('healthy', '2026-08-28T00:00:00.000Z')).toBe('healthy')
      expect(statusBadgeLabel('degraded', '2026-08-28T00:00:00.000Z')).toBe('degraded')
      expect(statusBadgeLabel('down', '2026-08-28T00:00:00.000Z')).toBe('down')
    })
  })

  describe('statusBadgeClass', () => {
    it('AC5/AC6: falls back to the neutral off-contract badge styling when lastCheckedAt is null, regardless of status', () => {
      expect(statusBadgeClass('healthy', null)).toBe(statusClass('unknown' as never))
      expect(statusBadgeClass('down', null)).toBe(statusClass('unknown' as never))
    })

    it('AC8: uses the real per-status styling once lastCheckedAt is set (post-check behavior unchanged)', () => {
      expect(statusBadgeClass('healthy', '2026-08-28T00:00:00.000Z')).toBe(statusClass('healthy'))
      expect(statusBadgeClass('down', '2026-08-28T00:00:00.000Z')).toBe(statusClass('down'))
    })
  })

  // Pre-existing behavior, unchanged by this story — kept here as a regression guard since these
  // pure functions are exactly what Story 28.7 touches.
  describe('formatCheckedAt (pre-existing, regression guard)', () => {
    it('renders "Not checked yet" for a null value', () => {
      expect(formatCheckedAt(null)).toBe('Not checked yet')
    })

    it('renders a formatted date for a real value', () => {
      expect(formatCheckedAt('2026-08-28T00:00:00.000Z')).not.toBe('Not checked yet')
    })
  })
})
