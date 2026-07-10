import { describe, expect, it } from 'vitest'
import { renderEmailTemplate } from './index.js'

const PAYLOAD = {
  userId: `00000000-0000-4000-8000-${'000000000001'}`,
  remainingRecoveryCodes: 4,
}

describe('MFA recovery notification templates (AC-7d)', () => {
  it('renders security.mfa_recovery_used with subject, inbox fields, and no secret material', () => {
    const rendered = renderEmailTemplate('security.mfa_recovery_used', PAYLOAD)

    expect(rendered.subject).toContain('MFA recovery code used')
    expect(rendered.text).toContain('4')
    expect(rendered.inboxTitle).toContain('MFA recovery code used')
    expect(rendered.inboxBody.length).toBeGreaterThan(0)
    expect(JSON.stringify(rendered)).not.toMatch(/\$2[aby]\$/)
    expect(JSON.stringify(rendered)).not.toContain('recoveryCode')
  })

  it('renders security.mfa_recovery_codes_regenerated with subject and inbox fields', () => {
    const rendered = renderEmailTemplate('security.mfa_recovery_codes_regenerated', PAYLOAD)

    expect(rendered.subject).toContain('MFA recovery codes were regenerated')
    expect(rendered.inboxTitle).toContain('MFA recovery codes were regenerated')
    expect(rendered.inboxBody.length).toBeGreaterThan(0)
  })

  it('falls back to "unavailable" instead of rendering "undefined" for a missing remainingRecoveryCodes', () => {
    const rendered = renderEmailTemplate('security.mfa_recovery_used', {
      userId: PAYLOAD.userId,
    })

    expect(rendered.text).toContain('unavailable')
    expect(rendered.text).not.toContain('undefined')
    expect(rendered.html).not.toContain('undefined')
  })

  it('falls back to "unavailable" for a non-numeric remainingRecoveryCodes', () => {
    const rendered = renderEmailTemplate('security.mfa_recovery_codes_regenerated', {
      userId: PAYLOAD.userId,
      remainingRecoveryCodes: 'not-a-number',
    })

    expect(rendered.text).toContain('unavailable')
    expect(rendered.text).not.toContain('undefined')
  })
})
