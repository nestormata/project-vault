import { describe, expect, it } from 'vitest'
import { BASE_EXTENSION_THEME_VARS, resolveExtensionThemeVars } from './extension-theme-vars.js'

describe('resolveExtensionThemeVars (Story 25.4 AC4)', () => {
  it('resolves PV base/default chrome colors when no theme is applied (theme.name: null)', () => {
    const result = resolveExtensionThemeVars(null, [])

    expect(result).toEqual(BASE_EXTENSION_THEME_VARS)
    // Never a partial/empty block — every property has a real value.
    for (const value of Object.values(result)) {
      expect(value).toBeTruthy()
    }
  })

  it('resolves the applied custom theme’s compiled color values when theme.name matches a real theme', () => {
    const themes = [
      {
        name: 'midnight',
        css: `[data-theme="midnight"] {\n  --color-background: #0f172a;\n  --color-foreground: #f1f5f9;\n  --color-border: #334155;\n  --color-primary-600: #38bdf8;\n}`,
      },
    ]

    const result = resolveExtensionThemeVars('midnight', themes)

    expect(result['--pv-ext-surface']).toBe('#0f172a')
    expect(result['--pv-ext-ink']).toBe('#f1f5f9')
    expect(result['--pv-ext-line']).toBe('#334155')
    expect(result['--pv-ext-brand']).toBe('#38bdf8')
  })

  it('derives --pv-ext-muted from the resolved surface/ink pair via color-mix (no analogous PV "muted" token exists)', () => {
    const themes = [
      {
        name: 'midnight',
        css: `[data-theme="midnight"] {\n  --color-background: #0f172a;\n  --color-foreground: #f1f5f9;\n}`,
      },
    ]

    const result = resolveExtensionThemeVars('midnight', themes)

    expect(result['--pv-ext-muted']).toBe('color-mix(in srgb, #f1f5f9 60%, #0f172a)')
  })

  it('falls back to base values for any token the matched theme does not declare', () => {
    const themes = [
      { name: 'partial', css: `[data-theme="partial"] {\n  --color-background: #123456;\n}` },
    ]

    const result = resolveExtensionThemeVars('partial', themes)

    expect(result['--pv-ext-surface']).toBe('#123456')
    expect(result['--pv-ext-ink']).toBe(BASE_EXTENSION_THEME_VARS['--pv-ext-ink'])
    expect(result['--pv-ext-brand']).toBe(BASE_EXTENSION_THEME_VARS['--pv-ext-brand'])
    expect(result['--pv-ext-line']).toBe(BASE_EXTENSION_THEME_VARS['--pv-ext-line'])
  })

  it('AC4 edge: an unresolvable/orphaned theme name falls back to the same base-theme values, never a broken block', () => {
    const result = resolveExtensionThemeVars('does-not-exist', [
      { name: 'midnight', css: '[data-theme="midnight"] {\n  --color-background: #0f172a;\n}' },
    ])

    expect(result).toEqual(BASE_EXTENSION_THEME_VARS)
  })

  it('a matched theme with a null css (compile failure) falls back to base values entirely', () => {
    const result = resolveExtensionThemeVars('broken', [{ name: 'broken', css: null }])

    expect(result).toEqual(BASE_EXTENSION_THEME_VARS)
  })

  it('resolves rgb()/rgba()/hsl()/hsla() color values, not just hex', () => {
    const themes = [
      {
        name: 'functional',
        css: `[data-theme="functional"] {\n  --color-background: rgb(15, 23, 42);\n  --color-foreground: rgba(241, 245, 249, 0.9);\n  --color-border: hsl(215, 25%, 27%);\n  --color-primary-600: hsla(199, 89%, 60%, 1);\n}`,
      },
    ]

    const result = resolveExtensionThemeVars('functional', themes)

    expect(result['--pv-ext-surface']).toBe('rgb(15, 23, 42)')
    expect(result['--pv-ext-ink']).toBe('rgba(241, 245, 249, 0.9)')
    expect(result['--pv-ext-line']).toBe('hsl(215, 25%, 27%)')
    expect(result['--pv-ext-brand']).toBe('hsla(199, 89%, 60%, 1)')
  })

  it('resolves a color value that is the last declaration in its rule (no trailing semicolon before the closing brace)', () => {
    const themes = [
      {
        name: 'no-trailing-semi',
        css: `[data-theme="no-trailing-semi"] {\n  --color-background: #abcdef\n}`,
      },
    ]

    const result = resolveExtensionThemeVars('no-trailing-semi', themes)

    expect(result['--pv-ext-surface']).toBe('#abcdef')
  })

  it('code-review hardening: a theme CSS value that is not a well-formed color is rejected and falls back to the base value, never interpolated verbatim', () => {
    const themes = [
      {
        name: 'malicious',
        // No `;`/`}` before the injected markup — this is exactly the shape a naive
        // `[^;]+;`-only extraction regex could run past its intended boundary on. The grammar
        // check must reject this regardless of where the extraction regex happens to stop.
        css: `[data-theme="malicious"] {\n  --color-background: red</style><script>alert(1)</script>\n}`,
      },
    ]

    const result = resolveExtensionThemeVars('malicious', themes)

    expect(result['--pv-ext-surface']).toBe(BASE_EXTENSION_THEME_VARS['--pv-ext-surface'])
    expect(result['--pv-ext-surface']).not.toContain('<')
    expect(result['--pv-ext-surface']).not.toContain('script')
  })

  it('code-review hardening: a theme CSS value using an unrecognized CSS function is rejected and falls back to the base value', () => {
    const themes = [
      {
        name: 'url-value',
        css: `[data-theme="url-value"] {\n  --color-background: url("https://evil.example/x");\n}`,
      },
    ]

    const result = resolveExtensionThemeVars('url-value', themes)

    expect(result['--pv-ext-surface']).toBe(BASE_EXTENSION_THEME_VARS['--pv-ext-surface'])
  })
})
