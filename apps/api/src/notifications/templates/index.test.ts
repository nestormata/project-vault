import { describe, expect, it } from 'vitest'
import { renderEmailTemplate, renderSlackTemplate } from './index.js'
import { renderSecurityFailedAuthThreshold } from './security-failed-auth-threshold.js'

const SAMPLE_PAYLOAD = {
  thresholdType: 'ip' as const,
  thresholdCount: 10,
  windowSeconds: 300,
  attemptCount: 10,
  windowStart: '2026-06-30T00:00:00.000Z',
  windowEnd: '2026-06-30T00:05:00.000Z',
  ipAddress: '203.0.113.1',
}

const UNKNOWN_TEMPLATE = 'unknown.template'
const XSS_SAMPLE = '<script>alert(1)</script>'

describe('notification templates', () => {
  it('renders failed auth threshold email with escaped HTML payload values', () => {
    const { subject, text, html } = renderSecurityFailedAuthThreshold({
      ...SAMPLE_PAYLOAD,
      ipAddress: XSS_SAMPLE,
    })

    expect(subject).toContain('Failed login threshold exceeded')
    expect(text).toContain(XSS_SAMPLE)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain(XSS_SAMPLE)
  })

  it('falls back for unknown email templates', () => {
    const rendered = renderEmailTemplate(UNKNOWN_TEMPLATE, { foo: 'bar' })
    expect(rendered.subject).toContain(UNKNOWN_TEMPLATE)
    expect(rendered.text).toContain('"foo": "bar"')
    expect(rendered.inboxTitle).toContain(UNKNOWN_TEMPLATE)
    expect(rendered.inboxBody).toContain(UNKNOWN_TEMPLATE)
  })

  it('renderTemplate exposes inbox fields for failed auth threshold', () => {
    const rendered = renderEmailTemplate('security.failed_auth_threshold', SAMPLE_PAYLOAD)
    expect(rendered.inboxTitle).toContain('Failed login threshold exceeded')
    expect(rendered.inboxBody.length).toBeLessThanOrEqual(500)
  })

  it('falls back for unknown slack templates', () => {
    const rendered = renderSlackTemplate(UNKNOWN_TEMPLATE, { foo: 'bar' })
    expect(rendered.text).toContain(UNKNOWN_TEMPLATE)
    expect(rendered.blocks).toEqual([])
  })

  // Story 10.4 branch coverage: every EMAIL_RENDERERS dispatch-table entry has its own small
  // wrapper (subject/text/html -> inboxTitle/inboxBody derivation) that the dedicated
  // renderSecurityFailedAuthThreshold test above does not exercise, since it calls the
  // underlying renderer directly rather than going through the dispatch table.
  it('dispatches project.invitation_created through the email renderer with inbox fields derived', () => {
    const rendered = renderEmailTemplate('project.invitation_created', {
      projectId: 'proj-1',
      projectName: 'Acme Vault',
      inviterEmail: 'a@b.com',
      role: 'member',
      acceptUrl: 'https://vault.example.com/accept',
    })
    expect(rendered.inboxTitle).toContain("You've been invited to Acme Vault")
    expect(rendered.inboxBody.length).toBeLessThanOrEqual(500)
  })

  it('dispatches auth.recovery_link_created and auth.recovery_link_sent through the email renderer', () => {
    const created = renderEmailTemplate('auth.recovery_link_created', {
      recoveryUrl: 'https://vault.example.com/recover',
      initiatorEmail: null,
    })
    expect(created.inboxTitle).toContain('Reset your password')

    const sent = renderEmailTemplate('auth.recovery_link_sent', {
      recoveryUrl: 'https://vault.example.com/recover',
      initiatorEmail: 'admin@example.com',
    })
    expect(sent.inboxTitle).toContain('password reset link')
  })
})
