import { describe, expect, it } from 'vitest'
import {
  ENV_FILE_HEADER,
  parseEnvFile,
  refusalMessage,
  serializeEnvFile,
  type EnvFileEntry,
  type EnvFileFormat,
} from './env-file-format.js'

function serializeOk(entries: EnvFileEntry[], format: EnvFileFormat) {
  const result = serializeEnvFile(entries, format)
  if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`)
  return result
}

function lineFor(value: string, format: EnvFileFormat = 'dotenv'): string {
  const text = serializeOk([{ key: 'KEY', value }], format).text
  return text.slice(ENV_FILE_HEADER.length)
}

describe('serializeEnvFile — dotenv quoting ladder (AC-2)', () => {
  it('starts every file with the fixed, timestamp-free header comment (AC-6)', () => {
    const { text } = serializeOk([{ key: 'A', value: 'x' }], 'dotenv')
    expect(ENV_FILE_HEADER).toBe(
      '# Written by pvault write-env. Contains secrets: do not commit, do not share.\n'
    )
    expect(text.startsWith(ENV_FILE_HEADER)).toBe(true)
  })

  it('rule 1: a value with no single quote is single-quoted', () => {
    expect(lineFor('a=b=c')).toBe("KEY='a=b=c'\n")
    expect(lineFor('he said "hi"')).toBe(`KEY='he said "hi"'\n`)
    expect(lineFor('')).toBe("KEY=''\n")
  })

  it('rule 2: a value with a single quote but no backtick is backtick-quoted', () => {
    expect(lineFor("it's")).toBe("KEY=`it's`\n")
    expect(lineFor("ends with '")).toBe("KEY=`ends with '`\n")
  })

  it('rule 3: a value with both single quote and backtick, but no double quote/newline/escape, is double-quoted', () => {
    expect(lineFor("a'b`c # CANARY=1")).toBe(`KEY="a'b\`c # CANARY=1"\n`)
  })

  it.each([
    ['all three quote chars', `a'b\`c"d`],
    ['single+backtick+real newline', "a'b`c\nd"],
    ['single+backtick+two-char \\n', "a'b`c\\nd"],
    ['single+backtick+two-char \\r', "a'b`c\\rd"],
  ])('rule 4: refuses (%s)', (_label, value) => {
    const result = serializeEnvFile([{ key: 'KEY', value }], 'dotenv')
    expect(result).toEqual({ ok: false, key: 'KEY', reason: 'unrepresentable' })
  })

  it('refuses a carriage return in dotenv format regardless of the ladder', () => {
    expect(serializeEnvFile([{ key: 'K', value: 'a\rb' }], 'dotenv')).toEqual({
      ok: false,
      key: 'K',
      reason: 'carriage_return',
    })
  })

  it('refuses a NUL byte in both formats', () => {
    for (const format of ['dotenv', 'shell'] as const) {
      expect(serializeEnvFile([{ key: 'K', value: 'a\0b' }], format)).toEqual({
        ok: false,
        key: 'K',
        reason: 'nul',
      })
    }
  })

  it('reports only the keys that needed dotenv-only quoting (rules 2/3), in entry order', () => {
    const result = serializeOk(
      [
        { key: 'A', value: 'plain' },
        { key: 'B', value: "it's" },
        { key: 'C', value: "a'b`c" },
      ],
      'dotenv'
    )
    expect(result.dotenvOnlyQuotedKeys).toEqual(['B', 'C'])
  })

  it('preserves entry order, LF endings, a single trailing newline, and no BOM', () => {
    const { text } = serializeOk(
      [
        { key: 'Z', value: '1' },
        { key: 'A', value: '2' },
      ],
      'dotenv'
    )
    expect(text).toBe(`${ENV_FILE_HEADER}Z='1'\nA='2'\n`)
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('throws a programmer error rather than writing a malformed key', () => {
    expect(() => serializeEnvFile([{ key: 'BAD KEY', value: 'x' }], 'dotenv')).toThrow(
      /invalid environment variable name/
    )
  })
})

describe('serializeEnvFile — shell format (AC-2)', () => {
  it("emits export KEY='value' with every ' encoded as '\\''", () => {
    expect(lineFor("it's", 'shell')).toBe("export KEY='it'\\''s'\n")
    expect(lineFor('', 'shell')).toBe("export KEY=''\n")
  })

  it('represents CR, quotes, and backticks losslessly (no refusal) and never flags dotenv-only keys', () => {
    const result = serializeOk([{ key: 'K', value: `a'b\`c"d\r\n$(x)` }], 'shell')
    expect(result.dotenvOnlyQuotedKeys).toEqual([])
  })
})

describe('refusalMessage', () => {
  it('names the reason class without the value', () => {
    expect(refusalMessage('unrepresentable')).toBe(
      'contains characters no dotenv quoting style can represent losslessly; use --format shell'
    )
    expect(refusalMessage('carriage_return')).toBe(
      "contains a carriage return, which Node's --env-file parser silently drops"
    )
    expect(refusalMessage('nul')).toMatch(/NUL/)
  })
})

describe('parseEnvFile — reference inverse of the serializer (A3)', () => {
  const samples = [
    'a=b=c',
    'he said "hi"',
    "it's",
    '-----BEGIN KEY-----\nMIIE\n-----END KEY-----\n',
    'literal \\n stays',
    '#notacomment',
    '  leading and trailing spaces  ',
    '$HOME',
    '',
    "a'b`c # CANARY=1",
    'x\nNODE_OPTIONS=--require=/tmp/evil.js\n',
  ]

  it.each(['dotenv', 'shell'] as const)('round-trips every sample in %s format', (format) => {
    const entries = samples.map((value, i) => ({ key: `K${i}`, value }))
    expect(parseEnvFile(serializeOk(entries, format).text, format)).toEqual(entries)
  })

  it('throws on a line shape the serializer never produces', () => {
    expect(() => parseEnvFile('FOO=bar\n', 'dotenv')).toThrow()
    expect(() => parseEnvFile("KEY='unterminated\n", 'dotenv')).toThrow()
    expect(() => parseEnvFile("KEY='x' junk\n", 'dotenv')).toThrow()
    expect(() => parseEnvFile("KEY='x'\n", 'shell')).toThrow()
    expect(() => parseEnvFile("export KEY='x'junk\n", 'shell')).toThrow()
    expect(() => parseEnvFile("export KEY='unterminated\n", 'shell')).toThrow()
  })

  it('ignores the header comment and blank lines', () => {
    expect(parseEnvFile(`${ENV_FILE_HEADER}\nA='1'\n\n`, 'dotenv')).toEqual([
      { key: 'A', value: '1' },
    ])
  })
})

/** Deterministic PRNG (mulberry32) so the property test is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SPECIALS = ['\n', "'", '`', '"', '\\', '$', '=', '#', 'n', 'r']
function randomValue(rand: () => number): string {
  const length = Math.floor(rand() * 12)
  let out = ''
  for (let i = 0; i < length; i++) {
    out +=
      rand() < 0.5
        ? SPECIALS[Math.floor(rand() * SPECIALS.length)]
        : String.fromCharCode(32 + Math.floor(rand() * 95))
  }
  return out
}

/** The documented dotenv refusal set, restated independently of the implementation. */
function dotenvShouldRefuse(value: string): boolean {
  if (value.includes('\0') || value.includes('\r')) return true
  if (!value.includes("'") || !value.includes('`')) return false
  return (
    value.includes('"') || value.includes('\n') || value.includes('\\n') || value.includes('\\r')
  )
}

describe('property test (AC-2): lossless round-trip or documented refusal', () => {
  it('dotenv: parse(serialize(x)) === x whenever not refused, and refusals are exactly the documented set', () => {
    const rand = mulberry32(43_5)
    for (let i = 0; i < 3000; i++) {
      const entries = [
        { key: 'A', value: randomValue(rand) },
        { key: 'B', value: randomValue(rand) },
      ]
      const result = serializeEnvFile(entries, 'dotenv')
      const expectedRefusal = entries.find((e) => dotenvShouldRefuse(e.value))
      if (expectedRefusal) {
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.key).toBe(expectedRefusal.key)
      } else {
        expect(result.ok).toBe(true)
        if (result.ok) expect(parseEnvFile(result.text, 'dotenv')).toEqual(entries)
      }
    }
  })

  it('shell: every NUL-free value round-trips', () => {
    const rand = mulberry32(99)
    for (let i = 0; i < 3000; i++) {
      const entries = [{ key: 'A', value: randomValue(rand) + (rand() < 0.2 ? '\r' : '') }]
      const result = serializeOk(entries, 'shell')
      expect(parseEnvFile(result.text, 'shell')).toEqual(entries)
    }
  })
})
