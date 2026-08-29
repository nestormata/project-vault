import { describe, expect, it } from 'vitest'
import {
  getExtensionPanelCspHeaders,
  getLoginReasonMessage,
  getTrustedApiBase,
  safeRedirectPath,
} from './hardening.js'

describe('getExtensionPanelCspHeaders', () => {
  it('forbids image loads and cross-origin script sources, while still allowing inline styles panels rely on', () => {
    const headers = getExtensionPanelCspHeaders()

    expect(headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'")
    expect(headers['content-security-policy']).toContain("img-src 'none'")
    expect(headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'")
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(headers['x-frame-options']).toBe('DENY')
  })

  // Story 29.2 — live Chrome verification (not caught by this vitest suite, which never enforces
  // real browser CSP, nor by Story 29.2's own Playwright E2E test, which never asserted on visual
  // styling): `style-src 'unsafe-inline'` alone blocks this route's own compiled stylesheet
  // `<link rel="stylesheet">` tag (CSP's `style-src` governs both inline `<style>`/`style=` AND
  // external stylesheet links; `'unsafe-inline'` only covers the former). The whole page rendered
  // with zero CSS applied — Tailwind utility classes present in the markup, no visual effect —
  // easy to miss without an actual rendered screenshot. Widened to `'self' 'unsafe-inline'`: `'self'`
  // lets the route's own same-origin stylesheet load, `'unsafe-inline'` is kept for every real
  // panel's own inline `style="var(--pv-ext-*, ...)"` attributes. This is a regression pin: a
  // future revert back to bare `'unsafe-inline'` must fail this test immediately, not silently
  // reintroduce a live unstyled-page bug.
  it("allows this route's own same-origin stylesheet to load (style-src includes 'self')", () => {
    const headers = getExtensionPanelCspHeaders()

    expect(headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'")
  })

  // Story 29.2 — E2E hardening (Playwright, not this vitest suite, caught it — jsdom does not
  // enforce CSP): `script-src 'none'` blocked this route's OWN SvelteKit hydration bootstrap
  // inline script, not just injected panel content, so this route's client JS (including this
  // story's `handleActionClick`) never ran in a real browser. Widened to `'self' 'unsafe-inline'`
  // — see `getExtensionPanelCspHeaders`'s own doc comment for the full rationale. This is a
  // regression pin: a future revert back to `'none'` must fail this test immediately, not
  // silently reintroduce a live hydration-blocked bug.
  it("does not block this route's own script execution (script-src is not 'none')", () => {
    const headers = getExtensionPanelCspHeaders()

    expect(headers['content-security-policy']).not.toContain("script-src 'none'")
  })

  // Story 29.2 AC14 — Story 29.1's own shipped CSP set `connect-src 'none'`, which would silently
  // block this story's own same-origin action fetch (dead code at the time 29.1 shipped, since no
  // iframe existed to originate the postMessage that used to gate reaching that fetch call — see
  // this story's Dev Notes "Cross-story contradiction caught at story-creation time"). Widened to
  // `'self'` — same-origin only, matching this route's `credentials: 'same-origin'` fetch. This is
  // a regression pin: a future revert back to `'none'` must fail this test immediately, not
  // silently reintroduce a live CSP-blocked-action bug.
  it("AC14: allows same-origin network egress only (connect-src 'self'), for this story's own action fetch", () => {
    const headers = getExtensionPanelCspHeaders()

    expect(headers['content-security-policy']).toContain("connect-src 'self'")
    expect(headers['content-security-policy']).not.toContain("connect-src 'none'")
  })
})

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
    expect(getLoginReasonMessage('registered')).toBe('Account created. Sign in to continue.')
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
