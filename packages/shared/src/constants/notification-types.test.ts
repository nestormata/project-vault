import { describe, expect, it } from 'vitest'
import { NOTIFICATION_ALERT_TYPES } from './notification-types.js'

describe('MFA alert types in shared registry (AC-6)', () => {
  it('registers the canonical MFA recovery alert type IDs', () => {
    expect(NOTIFICATION_ALERT_TYPES).toContain('security.mfa_recovery_used')
    expect(NOTIFICATION_ALERT_TYPES).toContain('security.mfa_recovery_codes_regenerated')
  })
})
