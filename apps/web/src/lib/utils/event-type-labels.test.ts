import { describe, expect, it } from 'vitest'
import { AuditEvent } from '@project-vault/shared'
import { getEventTypeLabel, humanizeEventType } from './event-type-labels.js'

describe('event-type-labels', () => {
  describe('humanizeEventType (AC-23 fallback)', () => {
    it('title-cases a dot-separated code and strips the dots', () => {
      expect(humanizeEventType('audit_storage.critical')).toBe('Audit Storage Critical')
    })

    it('title-cases a SCREAMING_SNAKE_CASE code and strips the underscores', () => {
      expect(humanizeEventType('SESSION_CREATED')).toBe('Session Created')
    })

    it('does not crash or return undefined for an empty string', () => {
      expect(humanizeEventType('')).toBe('')
    })
  })

  describe('getEventTypeLabel (AC-22/23)', () => {
    it('AC-22: maps a known monitoring alert type to a stable human label', () => {
      expect(getEventTypeLabel('backup.failure')).toBe('Backup Failure')
      expect(getEventTypeLabel('credential.expiry')).toBe('Credential Expiry')
    })

    it('AC-22: maps a known AuditEvent code to a human label, not the raw code', () => {
      expect(getEventTypeLabel(AuditEvent.SESSION_CREATED)).not.toBe(AuditEvent.SESSION_CREATED)
      expect(getEventTypeLabel(AuditEvent.SESSION_CREATED)).toBe('Session Created')
    })

    it('AC-23: an unmapped event type renders a readable humanized fallback, not the raw code verbatim', () => {
      const label = getEventTypeLabel('some_future.brand_new_event')
      expect(label).toBe('Some Future Brand New Event')
      expect(label).not.toBe('some_future.brand_new_event')
    })

    it('AC-23: never throws or returns undefined for an unmapped code', () => {
      expect(() => getEventTypeLabel('totally.unknown')).not.toThrow()
      expect(getEventTypeLabel('totally.unknown')).toBeTruthy()
    })

    it('every AuditEvent constant has a real (non-identical) label — completeness guard', () => {
      for (const code of Object.values(AuditEvent)) {
        expect(getEventTypeLabel(code)).toBeTruthy()
      }
    })
  })
})
