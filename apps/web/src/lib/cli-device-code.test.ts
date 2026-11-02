import { describe, expect, it } from 'vitest'
import { cliDeviceOutcomeMessageKey, prefilledUserCode } from './cli-device-code.js'

describe('CLI device approval page helpers (Story 43.30)', () => {
  it('prefills only a well-formed code', () => {
    expect(prefilledUserCode('bcdf-ghjk')).toBe('BCDF-GHJK')
    expect(prefilledUserCode('BCDFGHJK')).toBe('BCDF-GHJK')
    expect(prefilledUserCode('abcd-efgh')).toBe('')
    expect(prefilledUserCode('BCDF-GHJ')).toBe('')
    expect(prefilledUserCode(null)).toBe('')
  })

  it('maps server codes to message keys and hides anything else', () => {
    expect(cliDeviceOutcomeMessageKey('approved')).toBe('cli_device_approved')
    expect(cliDeviceOutcomeMessageKey('invalid_user_code')).toBe('cli_device_invalid_code')
    expect(cliDeviceOutcomeMessageKey('step_up_required')).toBe('cli_device_step_up_required')
    expect(cliDeviceOutcomeMessageKey('totp_enrollment_required')).toBe(
      'cli_device_enrollment_required'
    )
    expect(cliDeviceOutcomeMessageKey('<script>')).toBe('cli_device_error')
    expect(cliDeviceOutcomeMessageKey(undefined)).toBe('cli_device_error')
  })
})
