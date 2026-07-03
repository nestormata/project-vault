import { describe, expect, it } from 'vitest'
import { getLoginReasonMessage, getTrustedApiBase, safeRedirectPath } from './hardening.js'

describe('frontend hardening helpers', () => {
  it('allows only same-origin path redirects', () => {
    expect(safeRedirectPath('/dashboard')).toBe('/dashboard')
    expect(safeRedirectPath('/projects?tab=all')).toBe('/projects?tab=all')
    expect(safeRedirectPath('https://evil.example/dashboard')).toBe('/dashboard')
    expect(safeRedirectPath('//evil.example/dashboard')).toBe('/dashboard')
    expect(safeRedirectPath('javascript:alert(1)')).toBe('/dashboard')
    expect(safeRedirectPath(null)).toBe('/dashboard')
  })

  it('resolves login status copy from a fixed enum', () => {
    expect(getLoginReasonMessage('session-expired')).toBe(
      'Your session ended. Sign in again to continue.'
    )
    expect(getLoginReasonMessage('logged-out')).toBe('You have signed out.')
    expect(getLoginReasonMessage('recovery-complete')).toBe(
      'Your password has been reset. Sign in with your new password.'
    )
    expect(getLoginReasonMessage('<script>alert(1)</script>')).toBe('Sign in to continue.')
  })

  it('sources API base URL only from trusted server env config', () => {
    expect(getTrustedApiBase({ API_BASE_URL: 'https://api.example.com' })).toBe(
      'https://api.example.com'
    )
    expect(getTrustedApiBase({ API_BASE_URL: '' })).toBe('')
    expect(getTrustedApiBase({}, 'https://attacker.example')).toBe('')
  })
})
