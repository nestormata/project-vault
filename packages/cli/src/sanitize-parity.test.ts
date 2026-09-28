import { describe, expect, it } from 'vitest'
import { sanitizeServerText } from './sanitize-server-text.js'
import { sanitizeForTerminal } from './sanitize.js'

/**
 * Story 43.13 AC-3 — drift guards so the identifier sanitizer (`sanitizeForTerminal`) and the
 * free-text sanitizer (`sanitizeServerText`) cannot diverge in character strength again. The
 * character set U has one definition: `packages/agent/src/terminal-unsafe-characters.ts`.
 */

/** True when the free-text sanitizer changed `a<c>b` (removed `c`, or turned a line break into a space). */
function serverTextChanges(c: string): boolean {
  const probe = `a${c}b`
  return sanitizeServerText(probe) !== probe
}

describe('sanitizer character-set parity (AC-3.1)', () => {
  it('for every non-surrogate code point, sanitizeForTerminal removes it iff sanitizeServerText changes it', () => {
    const started = performance.now()
    const mismatches: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const c = String.fromCodePoint(cp)
      if ((sanitizeForTerminal(c) === '') !== serverTextChanges(c)) {
        mismatches.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
      }
    }
    const elapsedMs = performance.now() - started
    expect(mismatches).toEqual([])
    expect(elapsedMs).toBeLessThan(5000)
  }, 20_000)

  it.each([
    ['U+0020 space', ' ', ' ', 'a b'],
    ['U+00A0 NBSP', ' ', ' ', 'a b'],
    ['\\n', '\n', '', 'a b'],
    ['U+2028', '\u2028', '', 'a b'],
    ['U+202E', '\u202E', '', 'ab'],
    ['U+E0000', '\u{E0000}', '', 'ab'],
    ['U+E0080', '\u{E0080}', '\u{E0080}', 'a\u{E0080}b'],
    ['U+10FFFF', '\u{10FFFF}', '\u{10FFFF}', 'a\u{10FFFF}b'],
  ])('spot check %s', (_label, c, forTerminal, serverText) => {
    expect(sanitizeForTerminal(c)).toBe(forTerminal)
    expect(sanitizeServerText(`a${c}b`)).toBe(serverText)
  })
})

// ---------------------------------------------------------------------------------------------
// AC-3.2 — single-definition source guard.

const SOLE_DEFINITION = 'agent/src/terminal-unsafe-characters.ts'
const CLASS_LITERAL_MARKERS = [
  String.raw`\x00-\x1f`,
  String.raw`\u0000-\u001f`,
  String.raw`\x7f-\x9f`,
  String.raw`\u007f-\u009f`,
  String.raw`\p{Cf}`,
]

// Vite's `import.meta.glob` (applied by vitest at transform time). `vite/client` is not a direct
// dependency of this package, so only the one overload used below is declared, for tsc.
declare global {
  interface ImportMeta {
    glob(
      patterns: string[],
      options: { query: '?raw'; import: 'default'; eager: true }
    ): Record<string, string>
  }
}

// Every non-test `.ts` source under packages/cli/src and packages/agent/src, read as raw text at
// transform time by Vite (vitest's module graph), which keeps the scan free of dynamic fs paths.
// Keys are normalised to `<pkg>/src/...`.
const SOURCE_TEXT: Record<string, string> = import.meta.glob(
  ['./**/*.ts', '../../agent/src/**/*.ts', '!./**/*.test.ts', '!../../agent/src/**/*.test.ts'],
  { query: '?raw', import: 'default', eager: true }
)

function scannedSources(): Array<readonly [string, string]> {
  return Object.entries(SOURCE_TEXT).map(
    ([key, text]) =>
      [key.startsWith('./') ? `cli/src/${key.slice(2)}` : key.replace('../../', ''), text] as const
  )
}

/** Strips `// ...` line comments and `/* ... *\/` block comments so prose cannot trip the guard. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:\\])\/\/.*$/gm, '$1')
}

function containsCharacterClassLiteral(source: string): boolean {
  const code = stripComments(source).toLowerCase()
  return CLASS_LITERAL_MARKERS.some((marker) => code.includes(marker.toLowerCase()))
}

describe('unsafe character set has a single definition (AC-3.2)', () => {
  it('flags a control-character class literal in code', () => {
    expect(containsCharacterClassLiteral(String.raw`const X = /[\x00-\x1f]/g`)).toBe(true)
    expect(containsCharacterClassLiteral(String.raw`const Y = /[\p{Cf}]/gu`)).toBe(true)
  })

  it('does not flag prose in comments', () => {
    expect(containsCharacterClassLiteral(String.raw`// strips \p{Cf} too`)).toBe(false)
    expect(containsCharacterClassLiteral(String.raw`/* removes \x00-\x1f */ const a = 1`)).toBe(
      false
    )
  })

  it("scans both packages' production sources (no tests), including the sole definition", () => {
    const sources = new Map(scannedSources())
    expect(sources.has(SOLE_DEFINITION)).toBe(true)
    expect(sources.has('cli/src/sanitize.ts')).toBe(true)
    expect(sources.has('agent/src/invocation-context.ts')).toBe(true)
    expect([...sources.keys()].filter((k) => k.endsWith('.test.ts'))).toEqual([])
    expect(containsCharacterClassLiteral(sources.get(SOLE_DEFINITION) ?? '')).toBe(true)
  })

  it('no other cli/agent source declares its own control/format character class', () => {
    const offenders = scannedSources()
      .filter(([name, text]) => name !== SOLE_DEFINITION && containsCharacterClassLiteral(text))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })
})
