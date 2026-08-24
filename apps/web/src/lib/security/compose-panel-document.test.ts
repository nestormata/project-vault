import { describe, expect, it } from 'vitest'
import { EXTENSION_PANEL_CSP, composePanelDocument } from './compose-panel-document.js'
import { BASE_EXTENSION_THEME_VARS } from './extension-theme-vars.js'

const CSP_CONTENT =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

describe('composePanelDocument (Story 25.4 AC1)', () => {
  it('pins the exact CSP directive value, in the exact directive order', () => {
    expect(EXTENSION_PANEL_CSP).toBe(CSP_CONTENT)
  })

  it('composes a full document with the CSP <meta> as the first element of <head>', () => {
    const result = composePanelDocument('<p>hello</p>', BASE_EXTENSION_THEME_VARS)

    expect(result).toBe(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP_CONTENT}">` +
        `<style>:root {\n` +
        `  --pv-ext-surface: #ffffff;\n` +
        `  --pv-ext-ink: #111827;\n` +
        `  --pv-ext-muted: color-mix(in srgb, #111827 60%, #ffffff);\n` +
        `  --pv-ext-brand: #7c3aed;\n` +
        `  --pv-ext-line: #e2e8f0;\n` +
        `}</style></head><body><p>hello</p></body></html>`
    )
  })

  it('AC1 edge: an empty extension html string still composes a validly-headed document', () => {
    const result = composePanelDocument('', BASE_EXTENSION_THEME_VARS)

    expect(result).toContain('<meta http-equiv="Content-Security-Policy"')
    expect(result).toContain('<body></body>')
  })

  it('AC1 edge: a whitespace-only extension html string still composes a validly-headed document', () => {
    const result = composePanelDocument('   \n\t  ', BASE_EXTENSION_THEME_VARS)

    expect(result).toContain('<meta http-equiv="Content-Security-Policy"')
  })

  describe('Story 25.5 AC4/Task 4: conditional connect-src widening', () => {
    it('has no connect-src directive by default (actionsOrigin omitted)', () => {
      const result = composePanelDocument('<p>hello</p>', BASE_EXTENSION_THEME_VARS)

      expect(result).not.toContain('connect-src')
    })

    it('has no connect-src directive when actionsOrigin is explicitly undefined', () => {
      const result = composePanelDocument('<p>hello</p>', BASE_EXTENSION_THEME_VARS, undefined)

      expect(result).not.toContain('connect-src')
    })

    /**
     * Code-review-caught, Chrome-verification-confirmed bug fix (2026-08-24): `connect-src
     * 'self'` was the ORIGINALLY implemented value, per the story's own AC4 text. Live testing
     * in a real browser found it does NOT work — the panel iframe has `sandbox="allow-scripts"`
     * WITHOUT `allow-same-origin` (a deliberate, non-negotiable security requirement — see
     * Story 25.1 AC4), which forces the iframe's document into a unique, opaque origin. Per the
     * CSP spec, the `'self'` keyword resolves to the requesting document's OWN origin — an opaque
     * origin can never equal any concrete, serializable origin, so `connect-src 'self'` silently
     * blocks every fetch from this iframe, including the intended same-PV-origin action request.
     * The fix: pass the actual PV origin as an explicit source value instead of the `'self'`
     * keyword. This is still narrow (exactly one literal origin, never a wildcard) and still
     * only appears when the extension actually declares actions (AC4's own scoping requirement),
     * it just names the origin explicitly rather than relying on a keyword that can never
     * resolve inside this specific sandbox configuration.
     */
    it("adds exactly connect-src <the real PV origin> (not a wildcard, not the unusable 'self' keyword) when actionsOrigin is provided", () => {
      const result = composePanelDocument(
        '<p>hello</p>',
        BASE_EXTENSION_THEME_VARS,
        'http://localhost:3000'
      )

      const meta = /content="([^"]*)"/.exec(result)
      expect(meta?.[1]).toBe(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src http://localhost:3000"
      )
    })

    it("never emits the literal connect-src 'self' directive, even when actions are enabled (regression pin for the opaque-origin bug)", () => {
      const result = composePanelDocument(
        '<p>hello</p>',
        BASE_EXTENSION_THEME_VARS,
        'https://vault.example.com'
      )

      expect(result).not.toContain("connect-src 'self'")
    })
  })

  it('AC1 edge/Red Team finding: an extension-supplied conflicting CSP <meta> or <base> tag never overrides the host head-level policy', () => {
    const hostileFragment =
      '<meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://evil.example/">' +
      '<p>panel content</p>'

    const result = composePanelDocument(hostileFragment, BASE_EXTENSION_THEME_VARS)

    // PV's own head-level CSP meta appears exactly once, before <body>, and is the only one
    // that ever lands inside <head> — the extension's own conflicting meta tag is placed
    // (unmodified, per AC2's no-sanitizer resolution) inside <body>, where per the HTML/CSP
    // specs a Content-Security-Policy meta tag has no effect.
    const headSection = result.slice(result.indexOf('<head>'), result.indexOf('</head>'))
    const bodySection = result.slice(result.indexOf('<body>'))

    expect(headSection.match(/Content-Security-Policy/g)).toHaveLength(1)
    expect(headSection).not.toContain('default-src *')
    expect(bodySection).toContain('default-src *')
    expect(bodySection).toContain('<base href="https://evil.example/">')
    // PV's own base-uri 'none' directive (in the head-level CSP) neutralizes the extension's
    // <base> regardless of its position — the directive value itself is asserted above.
    expect(headSection).toContain("base-uri 'none'")
  })

  it('injects a :root {} theme block for a resolved custom theme, using the exact resolved values', () => {
    const themeVars = {
      '--pv-ext-surface': '#0f172a',
      '--pv-ext-ink': '#f1f5f9',
      '--pv-ext-muted': 'color-mix(in srgb, #f1f5f9 60%, #0f172a)',
      '--pv-ext-brand': '#38bdf8',
      '--pv-ext-line': '#334155',
    } as const

    const result = composePanelDocument('<p>hi</p>', themeVars)

    expect(result).toContain('--pv-ext-surface: #0f172a;')
    expect(result).toContain('--pv-ext-brand: #38bdf8;')
  })

  it('AC2 — RESOLVED 2026-08-24, no sanitizer: <script>/<style>/event-handler attributes pass through completely unchanged', () => {
    const fragment =
      '<div onclick="doThing()"><script>console.log("real interactivity")</script>' +
      '<style>.a { color: red }</style><dialog open><p aria-live="polite">status</p></dialog></div>'

    const result = composePanelDocument(fragment, BASE_EXTENSION_THEME_VARS)

    expect(result).toContain(fragment)
  })

  it('AC6 — the composed document never contains any actionEndpoint/CSRF wiring or apps/web asset-bundle reference', () => {
    const result = composePanelDocument('<p>hi</p>', BASE_EXTENSION_THEME_VARS)

    expect(result).not.toContain('actionEndpoint')
    expect(result).not.toContain('csrfToken')
    expect(result).not.toContain('<link')
    expect(result).not.toContain('/_app/')
  })

  it('freshness: composing the same extension html twice with different theme vars produces different output (no memoized template)', () => {
    const first = composePanelDocument('<p>hi</p>', BASE_EXTENSION_THEME_VARS)
    const second = composePanelDocument('<p>hi</p>', {
      ...BASE_EXTENSION_THEME_VARS,
      '--pv-ext-brand': '#ff0000',
    })

    expect(first).not.toBe(second)
  })
})
