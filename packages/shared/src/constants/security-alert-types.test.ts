import { describe, expect, it } from 'vitest'
import { SecurityAlertType } from './security-alert-types.js'

describe('SecurityAlertType', () => {
  it('exposes Story 1.9 failed-auth threshold alert type', () => {
    expect(SecurityAlertType.FAILED_AUTH_THRESHOLD).toBe('security.failed_auth_threshold')
  })
})
