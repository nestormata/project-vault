export function safeRedirectPath(value: string | null | undefined, fallback = '/dashboard') {
  if (!value) return fallback
  if (!value.startsWith('/') || value.startsWith('//')) return fallback
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return fallback
  return value
}

export function getLoginReasonMessage(reason: string | null | undefined) {
  switch (reason) {
    case 'registered':
      return 'Account created. Sign in to continue.'
    case 'session-expired':
      return 'Your session ended. Sign in again to continue.'
    case 'logged-out':
      return 'You have signed out.'
    case 'recovery-complete':
      return 'Your password has been reset. Sign in with your new password.'
    default:
      return 'Sign in to continue.'
  }
}

export function getTrustedApiBase(env: { API_BASE_URL?: string }, _ignoredRequestInput?: string) {
  return env.API_BASE_URL?.trim() ?? ''
}

export function getFrameProtectionHeaders() {
  return {
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  }
}

/**
 * Story 29.1 — code-review hardening (2026-08-29). Replaces the CSP `compose-panel-document.ts`
 * used to deliver via a `<meta http-equiv>` tag inside the now-deleted `srcdoc` document (that
 * mechanism only worked because `srcdoc` content has no HTTP response of its own; inline
 * same-origin rendering does have one, so a real response header is the correct replacement, not
 * a gap). Deliberately tighter than the old iframe-era policy, not a straight port of it:
 * `script-src` drops from `'unsafe-inline'` to `'none'` because `render-panel-html.ts`'s DOMPurify
 * config already strips every `<script>` tag and inline event handler unconditionally — there is
 * no legitimate inline script left for that directive to permit, so allowing it would just be
 * redundant attack surface against a sanitizer bypass. `img-src`/`connect-src: 'none'` close the
 * exact gap code review flagged: with no iframe sandbox left, DOMPurify sanitizes markup
 * structure but not network egress, so an extension's HTML could otherwise load a third-party
 * `<img>`/`fetch` as a covert data-exfiltration channel from a real authenticated session. No
 * real panel (`fixtures/mock-ui-panel-extension`) loads any image or makes any network call today
 * — deliberately fails loudly (blocked request, visible in devtools) rather than silently
 * succeeding, forcing a conscious widening (and a new test) the day a real panel legitimately
 * needs one, rather than this policy silently drifting open. `style-src: 'unsafe-inline'` stays,
 * since every real panel styles itself via inline `style="var(--pv-ext-*, ...)"` attributes.
 */
export function getExtensionPanelCspHeaders() {
  return {
    'content-security-policy':
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  }
}
