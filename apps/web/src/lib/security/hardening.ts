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
 * `<img>` as a covert data-exfiltration channel from a real authenticated session. No real panel
 * (`fixtures/mock-ui-panel-extension`) loads any image today — deliberately fails loudly (blocked
 * request, visible in devtools) rather than silently succeeding, forcing a conscious widening
 * (and a new test) the day a real panel legitimately needs one, rather than this policy silently
 * drifting open. `style-src: 'unsafe-inline'` stays, since every real panel styles itself via
 * inline `style="var(--pv-ext-*, ...)"` attributes.
 *
 * Story 29.2 AC14 — `connect-src` widened from `'none'` to `'self'` (code-review hardening,
 * 2026-08-29): `'none'` was never actually exercised against a real fetch when Story 29.1
 * shipped it, because the old postMessage-based action relay's own `fetch(data.actionEndpoint,
 * ...)` call was only reachable from an inert `postMessage` handler (Story 29.1 AC8 — dead code
 * by construction, since no iframe exists to originate that message). Story 29.2 replaces that
 * relay with a real, host-owned click-delegation handler that issues that exact fetch directly —
 * making it reachable for the first time — so `'none'` would have silently blocked every action
 * dispatch with a browser-level CSP violation (visible only in devtools, not to the user).
 * `'self'` stays same-origin-only, matching this route's `credentials: 'same-origin'` fetch and
 * this CSP's otherwise deny-by-default posture; `img-src` is unchanged since this story's fetch
 * never loads an image.
 *
 * Story 29.2 — E2E hardening (found by this story's own Playwright coverage, not by the vitest
 * suite, which never enforces real browser CSP): `script-src 'none'` blocked more than injected
 * panel content — it blocked THIS ROUTE'S OWN SvelteKit app-shell hydration bootstrap, which
 * SvelteKit unconditionally emits as a small inline `<script>` on every page
 * (`__sveltekit_<hash> = {...}`) to seed the client runtime before it imports the real bundle.
 * With `'none'`, that inline script itself is a CSP violation — silently, only visible in
 * devtools — so this route's client JS (including this very story's `handleActionClick` click
 * delegation and every other `$effect` in `+page.svelte`) never ran in a real browser at all;
 * `apps/web`'s jsdom-based vitest suite never caught this because jsdom does not enforce CSP.
 * Widened to `'self' 'unsafe-inline'` — `'self'` still blocks a DOMPurify-bypass-injected
 * `<script src="https://attacker.example/x.js">` (cross-origin exfil/payload), and `'unsafe-inline'`
 * is required because this app has no CSP nonce wired up (`svelte.config.js` sets no `csp` option)
 * to let only SvelteKit's own inline bootstrap execute while still blocking an injected inline
 * `<script>`. This matches (not weakens beyond) the OLD iframe-era policy's own `'unsafe-inline'`
 * for `script-src` (see this function's Story 29.1 comment above) — DOMPurify's unconditional
 * `<script>`-tag stripping remains the real, primary control against inline-script injection from
 * panel content either way.
 *
 * Story 29.2 — live Chrome verification (found only by an actual rendered screenshot — neither
 * the vitest suite, which never enforces real CSP, nor this story's own Playwright E2E test, which
 * asserted on captured network requests and DOM text but never on visual styling, caught it):
 * `style-src 'unsafe-inline'` alone blocks THIS ROUTE'S OWN compiled stylesheet
 * `<link rel="stylesheet">` tag — CSP's `style-src` governs both inline styles AND external
 * stylesheet links, and `'unsafe-inline'` only covers the former. The page rendered with every
 * Tailwind utility class present in the markup but zero CSS actually applied — a real, live bug
 * this story's own AC14 CSP work introduced and never visually re-verified until now. Widened to
 * `'self' 'unsafe-inline'` — `'self'` lets this route's own same-origin stylesheet load;
 * `'unsafe-inline'` is kept for every real panel's own inline `style="var(--pv-ext-*, ...)"`
 * attribute (unchanged from Story 29.1's original rationale above).
 */
export function getExtensionPanelCspHeaders() {
  return {
    'content-security-policy':
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  }
}
