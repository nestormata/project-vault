import { describe, expect, it } from 'vitest'
import {
  renderAccountRecoveryLinkCreated,
  renderAccountRecoveryLinkSent,
} from './account-recovery.js'

const RECOVERY_URL_XYZ = 'https://vault.example.com/recover?token=xyz'
const RECOVERY_URL_ABC = 'https://vault.example.com/recover?token=abc'
const ADMIN_EMAIL = 'admin@example.com'

describe('renderAccountRecoveryLinkCreated (AC-9, self-requested)', () => {
  it('renders subject/text/html including the recovery URL', () => {
    const result = renderAccountRecoveryLinkCreated({
      recoveryUrl: RECOVERY_URL_ABC,
      initiatorEmail: null,
    })

    expect(result.subject).toBe('[Project Vault] Reset your password')
    expect(result.text).toContain(RECOVERY_URL_ABC)
    expect(result.text).toContain('You requested a password reset')
    expect(result.html).toContain(RECOVERY_URL_ABC)
  })

  it('HTML-escapes a recovery URL containing special characters', () => {
    const result = renderAccountRecoveryLinkCreated({
      recoveryUrl: 'https://vault.example.com/recover?a=1&b=<script>',
      initiatorEmail: null,
    })

    expect(result.html).toContain('&amp;b=&lt;script&gt;')
    expect(result.html).not.toContain('<script>')
  })

  // Story 28.6 AC2 — recoveryUrl is a required string in the payload type, but
  // notification_queue.payload is untyped jsonb; a missing recoveryUrl must not crash render.
  it('does not throw when recoveryUrl is missing', () => {
    expect(() =>
      renderAccountRecoveryLinkCreated({ initiatorEmail: null } as Record<string, unknown>)
    ).not.toThrow()
  })
})

describe('renderAccountRecoveryLinkSent (AC-10, admin-initiated)', () => {
  it('names the initiating admin when initiatorEmail is present', () => {
    const result = renderAccountRecoveryLinkSent({
      recoveryUrl: RECOVERY_URL_XYZ,
      initiatorEmail: ADMIN_EMAIL,
    })

    expect(result.subject).toBe('[Project Vault] Your admin sent you a password reset link')
    expect(result.text).toContain(`${ADMIN_EMAIL} sent you a link`)
    expect(result.html).toContain(ADMIN_EMAIL)
  })

  it('falls back to a generic phrase when initiatorEmail is null', () => {
    const result = renderAccountRecoveryLinkSent({
      recoveryUrl: RECOVERY_URL_XYZ,
      initiatorEmail: null,
    })

    expect(result.text).toContain('An organization admin sent you a link')
    expect(result.html).toContain('An organization admin')
  })

  it('HTML-escapes an initiator email containing special characters', () => {
    const result = renderAccountRecoveryLinkSent({
      recoveryUrl: RECOVERY_URL_XYZ,
      initiatorEmail: '<b>admin</b>@example.com',
    })

    expect(result.html).toContain('&lt;b&gt;admin&lt;/b&gt;@example.com')
    expect(result.html).not.toContain('<b>admin</b>@example.com')
  })

  it('does not throw when recoveryUrl is missing', () => {
    expect(() =>
      renderAccountRecoveryLinkSent({ initiatorEmail: ADMIN_EMAIL } as Record<string, unknown>)
    ).not.toThrow()
  })
})
