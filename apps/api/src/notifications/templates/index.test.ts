import { describe, expect, it, vi } from 'vitest'
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
const FAILED_AUTH_TEMPLATE_ID = 'security.failed_auth_threshold'
const FAILED_LOGIN_SUBJECT_FRAGMENT = 'Failed login threshold exceeded'

describe('notification templates', () => {
  it('renders failed auth threshold email with escaped HTML payload values', () => {
    const { subject, text, html } = renderSecurityFailedAuthThreshold({
      ...SAMPLE_PAYLOAD,
      ipAddress: XSS_SAMPLE,
    })

    expect(subject).toContain(FAILED_LOGIN_SUBJECT_FRAGMENT)
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
    const rendered = renderEmailTemplate(FAILED_AUTH_TEMPLATE_ID, SAMPLE_PAYLOAD)
    expect(rendered.inboxTitle).toContain(FAILED_LOGIN_SUBJECT_FRAGMENT)
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

  it('dispatches credential.share_created through the email renderer with inbox fields derived', () => {
    const rendered = renderEmailTemplate('credential.share_created', {
      shareId: 'share-1',
      credentialId: 'cred-1',
      sharedByUserId: 'user-1',
      fieldKey: 'api_key',
    })
    expect(rendered.inboxTitle).toContain('A credential was shared with you')
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

  // Story 28.6 AC3 — a registered renderer that throws for any reason must degrade to the same
  // generic passthrough shape used for an unregistered templateId, rather than propagating and
  // poisoning the delivery pipeline. Forces a real registered renderer to throw via a payload
  // whose getter throws on its FIRST access only (the renderer's own read) and returns a normal
  // value thereafter (the fallback's JSON.stringify(payload) and this test's own deep-equality
  // assertion), so this simulates "a future bug in this file or another" without the fallback's
  // own payload-logging re-triggering the same throw.
  function makeThrowOnceOnAccessPayload(): Record<string, unknown> {
    let accessed = false
    return {
      get thresholdType(): string {
        if (!accessed) {
          accessed = true
          throw new Error('boom')
        }
        return 'ip'
      },
    }
  }

  it('renderEmailTemplate degrades to the generic fallback and logs when a registered renderer throws', () => {
    const logger = { error: vi.fn() }
    const throwingPayload = makeThrowOnceOnAccessPayload()

    const rendered = renderEmailTemplate(FAILED_AUTH_TEMPLATE_ID, throwingPayload, logger)

    expect(rendered.subject).toContain(FAILED_AUTH_TEMPLATE_ID)
    expect(rendered.text).toContain(FAILED_AUTH_TEMPLATE_ID)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'notification.template_render_failed',
        templateId: FAILED_AUTH_TEMPLATE_ID,
        payload: throwingPayload,
      }),
      expect.any(String)
    )
  })

  it('renderSlackTemplate degrades to the generic fallback and logs when a registered renderer throws', () => {
    const logger = { error: vi.fn() }
    const throwingPayload = makeThrowOnceOnAccessPayload()

    const rendered = renderSlackTemplate(FAILED_AUTH_TEMPLATE_ID, throwingPayload, logger)

    expect(rendered.text).toContain(FAILED_AUTH_TEMPLATE_ID)
    expect(rendered.blocks).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'notification.template_render_failed',
        templateId: FAILED_AUTH_TEMPLATE_ID,
        payload: throwingPayload,
      }),
      expect.any(String)
    )
  })

  it('renderEmailTemplate/renderSlackTemplate do not throw when no logger is provided', () => {
    expect(() =>
      renderEmailTemplate(FAILED_AUTH_TEMPLATE_ID, makeThrowOnceOnAccessPayload())
    ).not.toThrow()
    expect(() =>
      renderSlackTemplate(FAILED_AUTH_TEMPLATE_ID, makeThrowOnceOnAccessPayload())
    ).not.toThrow()
  })

  it('a working renderer is unaffected by the try/catch (happy path unchanged)', () => {
    const rendered = renderEmailTemplate(FAILED_AUTH_TEMPLATE_ID, SAMPLE_PAYLOAD, {
      error: vi.fn(),
    })
    expect(rendered.subject).toContain(FAILED_LOGIN_SUBJECT_FRAGMENT)
  })

  // Code-review fix (post-28.6): a renderer throwing for a template whose payload carries a
  // live secret (e.g. account-recovery's recoveryUrl reset token) must not leak that secret into
  // the outbound email/inbox content via the AC3 fallback path — the raw payload belongs only in
  // the internal error log, never in what actually gets delivered.
  it('renderEmailTemplate fallback for a thrown renderer never embeds the raw payload in outbound content', () => {
    const secretPayload = {
      get recoveryUrl(): string {
        throw new Error('boom')
      },
    }
    const rendered = renderEmailTemplate('auth.recovery_link_created', secretPayload, {
      error: vi.fn(),
    })
    expect(rendered.text).not.toContain('boom')
    expect(rendered.html).not.toContain('recoveryUrl')
    expect(JSON.stringify(rendered)).not.toContain('recoveryUrl')
  })
})
