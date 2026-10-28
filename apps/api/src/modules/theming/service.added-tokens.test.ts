import { beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_TOKENS } from '@project-vault/shared'
import { __resetThemeStateForTests, getCompiledThemes, reloadThemes } from './service.js'

/**
 * Story 72.2 (P1a/P1b): the added theme keys are validated like the original nine, and the contrast
 * guard honours `colorTextOnAccent` with a per-pair message.
 */
const THEMES_DIR = '/data/themes'
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }

async function load(tokens: Record<string, unknown>) {
  const content = JSON.stringify({ name: 'acme', tokens })
  return reloadThemes(THEMES_DIR, {
    readdir: async () => ['acme.json'],
    stat: async () => ({ size: Buffer.byteLength(content, 'utf-8') }),
    readFileBounded: async () => content,
    logger: silentLogger,
  })
}

const ADDED_COLOR_KEYS = [
  'colorSurface',
  'colorSurfaceMuted',
  'colorTextMuted',
  'colorTextOnAccent',
  'colorFocusRing',
  'colorBorderStrong',
  'colorSuccess',
  'colorWarning',
  'colorDanger',
  'colorInfo',
] as const

const INJECTION_PAYLOADS = [
  'red; } input[type=password] { background: url(https://evil.example/x)',
  'url(https://evil.example/x)',
  '#fff; --x: 1',
  'rgb(0,0,0)} body{display:none',
  '</style><script>alert(1)</script>',
]

beforeEach(() => {
  __resetThemeStateForTests()
})

describe('72.2 registry additions', () => {
  it('keeps the original nine keys and adds the new ones', () => {
    for (const key of [
      'colorPrimary600',
      'colorPrimary700',
      'colorBackground',
      'colorForeground',
      'colorBorder',
      'radiusMd',
      'radiusLg',
      'spacingUnit',
      'fontWeightBody',
    ]) {
      expect(Object.keys(THEME_TOKENS)).toContain(key)
    }
    for (const key of [...ADDED_COLOR_KEYS, 'focusRingWidth', 'density', 'motion', 'typeFamily']) {
      expect(Object.keys(THEME_TOKENS)).toContain(key)
    }
  })
})

describe('72.2 compile and validation of added keys', () => {
  it('compiles every added key into the [data-theme] block', async () => {
    const result = await load({
      colorSurface: '#ffffff',
      colorTextMuted: '#475569',
      focusRingWidth: '3px',
      density: 'compact',
      motion: 'reduced',
      typeFamily: 'serif',
    })
    expect(result.failed).toEqual([])
    const css = getCompiledThemes()[0]?.css ?? ''
    expect(css).toContain('--color-surface: #ffffff;')
    expect(css).toContain('--color-text-muted: #475569;')
    expect(css).toContain('--focus-ring-width: 3px;')
    expect(css).toContain('--density: compact;')
    expect(css).toContain('--motion: reduced;')
    expect(css).toContain('--type-family: serif;')
    expect(css.startsWith('[data-theme="acme"] {')).toBe(true)
  })

  it('a theme that sets none of the new keys compiles exactly as before', async () => {
    await load({ colorPrimary600: '#1e3a8a' })
    expect(getCompiledThemes()[0]?.css).toBe(
      '[data-theme="acme"] {\n  --color-primary-600: #1e3a8a;\n}'
    )
  })

  it.each(ADDED_COLOR_KEYS.flatMap((key) => INJECTION_PAYLOADS.map((p) => [key, p] as const)))(
    'rejects an injection payload in %s (%s)',
    async (key, payload) => {
      const result = await load({ [key]: payload })
      expect(result.loaded).toEqual([])
      expect(result.failed[0]?.reason).toBe(`token \`${key}\`: invalid color value`)
      expect(getCompiledThemes()).toEqual([])
    }
  )

  it.each([
    ['focusRingWidth', 'calc(1px + 2px)'],
    ['focusRingWidth', '2px; } body {'],
    ['density', 'compact; } x {'],
    ['motion', 'url(x)'],
    ['typeFamily', 'Arial, url(https://evil.example)'],
  ])('rejects an out-of-grammar %s value (%s)', async (key, value) => {
    const result = await load({ [key]: value })
    expect(result.loaded).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.reason?.startsWith(`token \`${key}\`: invalid`)).toBe(true)
  })
})

describe('72.2 text-on-accent contrast guard', () => {
  it('without colorTextOnAccent keeps the white-text check and message', async () => {
    const result = await load({ colorPrimary600: '#f5f3ff' })
    expect(result.failed[0]?.reason).toBe(
      'token `colorPrimary600`: insufficient contrast against white button text (needs >= 4.5:1)'
    )
  })

  it('accepts a light accent when dark colorTextOnAccent reaches 4.5:1', async () => {
    const result = await load({
      colorPrimary600: '#fde68a',
      colorPrimary700: '#fcd34d',
      colorTextOnAccent: '#111827',
    })
    expect(result).toEqual({ loaded: ['acme.json'], failed: [] })
  })

  it('rejects a dark accent with a dark colorTextOnAccent, naming the pair', async () => {
    const result = await load({
      colorPrimary600: '#fde68a',
      colorPrimary700: '#1e3a8a',
      colorTextOnAccent: '#111827',
    })
    expect(result.failed[0]?.reason).toBe(
      'token `colorPrimary700`: insufficient contrast against `colorTextOnAccent` (needs >= 4.5:1)'
    )
  })

  it('rejects white-on-white style pairs regardless of key order', async () => {
    const result = await load({ colorTextOnAccent: '#ffffff', colorPrimary600: '#ffffff' })
    expect(result.failed[0]?.reason).toContain('colorPrimary600')
  })

  it('accepts exactly 4.5:1 and rejects just below it', async () => {
    // #767676 on white is 4.54:1; #777777 on white is 4.48:1.
    expect((await load({ colorPrimary600: '#767676' })).failed).toEqual([])
    expect((await load({ colorPrimary600: '#777777' })).failed).toHaveLength(1)
  })

  it('rejects a translucent colorTextOnAccent', async () => {
    const result = await load({ colorTextOnAccent: 'rgba(255, 255, 255, 0.5)' })
    expect(result.failed[0]?.reason).toBe(
      'token `colorTextOnAccent`: must be fully opaque to validate contrast'
    )
  })
})

describe('72.2 non-text contrast (3:1)', () => {
  it.each(['colorFocusRing', 'colorBorderStrong'])(
    'rejects a %s below 3:1 against the default white background',
    async (key) => {
      const result = await load({ [key]: '#cbd5e1' })
      expect(result.failed[0]?.reason).toBe(
        `token \`${key}\`: insufficient contrast against the page background (needs >= 3:1)`
      )
    }
  )

  it('accepts #64748b (the D-10 control border) against white', async () => {
    expect((await load({ colorBorderStrong: '#64748b' })).failed).toEqual([])
  })

  it("measures against the theme's own colorBackground", async () => {
    const dark = { colorBackground: '#0f172a' }
    expect((await load({ ...dark, colorBorderStrong: '#94a3b8' })).failed).toEqual([])
    expect((await load({ ...dark, colorBorderStrong: '#1e293b' })).failed).toHaveLength(1)
  })

  it('rejects a translucent colorFocusRing', async () => {
    const result = await load({ colorFocusRing: 'rgba(0, 0, 0, 0.5)' })
    expect(result.failed[0]?.reason).toBe(
      'token `colorFocusRing`: must be fully opaque to validate contrast'
    )
  })

  it('leaves the other added colours grammar-checked only', async () => {
    const result = await load({ colorSuccess: '#ffffff', colorSurface: '#000000' })
    expect(result.failed).toEqual([])
  })
})

describe('72.2 review hardening', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'rejects the inherited object key %s as unregistered (no CSS reaches the output)',
    async (key) => {
      const result = await load({ [key]: 'red;} body{background:url(https://evil.example/x)} x{' })
      expect(result.loaded).toEqual([])
      expect(result.failed[0]?.reason).toBe(`unregistered token \`${key}\``)
    }
  )

  it('rejects a JSON __proto__ token key', async () => {
    const content = '{"name":"acme","tokens":{"__proto__":"red;}"}}'
    const result = await reloadThemes(THEMES_DIR, {
      readdir: async () => ['acme.json'],
      stat: async () => ({ size: content.length }),
      readFileBounded: async () => content,
      logger: silentLogger,
    })
    expect(result.loaded).toEqual([])
  })

  it('checks colorTextOnAccent against the default accents when no primary is set', async () => {
    const same = await load({ colorTextOnAccent: '#7c3aed' })
    expect(same.failed[0]?.reason).toBe(
      'token `colorPrimary600`: insufficient contrast against `colorTextOnAccent` (needs >= 4.5:1)'
    )
    expect((await load({ colorTextOnAccent: '#ffffff' })).failed).toEqual([])
  })

  it.each(['#12345', '#1234567'])(
    'blames an unparseable colorTextOnAccent %s, not the accent',
    async (value) => {
      const result = await load({ colorTextOnAccent: value })
      expect(result.failed[0]?.reason).toBe(
        'token `colorTextOnAccent`: insufficient contrast against `colorTextOnAccent` (needs >= 4.5:1)'
      )
    }
  )

  it('accepts all pair keys in either order', async () => {
    const a = await load({ colorPrimary600: '#1e3a8a', colorTextOnAccent: '#ffffff' })
    const b = await load({ colorTextOnAccent: '#ffffff', colorPrimary600: '#1e3a8a' })
    expect(a.failed).toEqual([])
    expect(b.failed).toEqual([])
  })

  it('requires an opaque colorBackground when a non-text token is set', async () => {
    const result = await load({ colorBackground: '#00000000', colorFocusRing: '#ffffff' })
    expect(result.failed[0]?.reason).toBe(
      'token `colorBackground`: must be fully opaque to validate contrast'
    )
  })

  it('blames an unparseable colorBackground, not the non-text token', async () => {
    const result = await load({ colorBackground: '#12345', colorBorderStrong: '#000000' })
    expect(result.failed[0]?.reason).toBe(
      'token `colorBackground`: cannot be used to validate contrast'
    )
  })

  it('still allows a translucent colorBackground when no non-text token is set', async () => {
    expect((await load({ colorBackground: 'rgba(255, 255, 255, 0.1)' })).failed).toEqual([])
  })
})
