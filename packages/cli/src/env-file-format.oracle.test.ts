/**
 * Story 43.5 AC-2 / Task 7 — consumer-oracle round-trip tests: the real proof, not
 * self-consistency. Each value is serialized by the real serializer to a real temp file, then read
 * back by the real target consumer — Node's own `--env-file` parser (the running Node binary, no
 * npm dependency) for `dotenv`, and GNU/POSIX `bash` for `shell` — and the bytes must be
 * identical. If a Node upgrade changes its parser, these fail loudly; that is the point.
 *
 * Children run with an EMPTY environment: Node's `--env-file` never overrides a variable that is
 * already set, and an inherited NODE_OPTIONS would muddy the line-injection assertions.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serializeEnvFile, type EnvFileFormat } from './env-file-format.js'

/** A1 — `--env-file` landed in Node 20.6.0; `engines` allows >=20. */
function nodeSupportsEnvFile(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major > 20 || (major === 20 && minor >= 6)
}
const hasEnvFile = nodeSupportsEnvFile()
// win32: no POSIX bash to act as the `shell` oracle.
const hasBash = process.platform !== 'win32' && !spawnSync('bash', ['-c', 'true']).error

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pvault-oracle-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

let fileCounter = 0
function writeEnv(value: string, format: EnvFileFormat): string {
  const result = serializeEnvFile([{ key: 'KEY', value }], format)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  fileCounter += 1
  const path = join(dir, `case-${fileCounter}.env`)
  writeFileSync(path, result.text, 'utf8')
  return path
}

type NodeView = { KEY?: string; keys: string[] }

function readViaNode(file: string): NodeView {
  const out = execFileSync(
    process.execPath,
    [
      `--env-file=${file}`,
      '-e',
      'process.stdout.write(JSON.stringify({ KEY: process.env.KEY, keys: Object.keys(process.env).sort() }))',
    ],
    { env: {}, maxBuffer: 16 * 1024 * 1024 }
  )
  return JSON.parse(out.toString('utf8')) as NodeView
}

function readViaBash(file: string): { KEY: string; CANARY: string } {
  const out = execFileSync(
    'bash',
    ['-c', 'set -a; . "$1"; printf "%s\\0%s" "$KEY" "${CANARY-__UNSET__}"', '_', file],
    { env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, maxBuffer: 16 * 1024 * 1024 }
  ).toString('utf8')
  const [KEY = '', CANARY = ''] = out.split('\0')
  return { KEY, CANARY }
}

const PEM = '-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END KEY-----\n'
const LARGE = 'A1b2=#\'"$\n'
  .repeat(26_215)
  .slice(0, 256 * 1024)
  .replaceAll("'", 'q')

const POSITIVE: Array<[string, string]> = [
  ['contains =', 'a=b=c'],
  ['double quotes', 'he said "hi"'],
  ['single quote (rule 2)', "it's"],
  ['PEM with real newlines and trailing newline', PEM],
  ['literal backslash-n', 'two\\nchars'],
  ['leading #', '#notacomment'],
  ['surrounding spaces', '  leading and trailing spaces  '],
  ['dollar', '$HOME'],
  ['empty', ''],
  ['multibyte UTF-8', 'é 中文 😀'],
  ['leading U+FEFF', '\uFEFFbom-first'],
  ['256 KiB value', LARGE],
]

const HOSTILE: Array<[string, string]> = [
  ['rule 1 line injection', 'x\nNODE_OPTIONS=--require=/tmp/evil.js\n'],
  ['rule 2 line injection', "it's\nNODE_OPTIONS='--require=/tmp/evil.js'"],
  ['rule 3 comment/canary', "a'b`c # CANARY=1"],
  ['ends with a quote', "ends with '"],
]

// The describe titles carry the skip reason, so a skipped run still says why in the report.
describe.skipIf(!hasEnvFile)(
  'dotenv → node --env-file oracle (AC-2; skipped below Node 20.6.0)',
  () => {
    it.each([...POSITIVE, ...HOSTILE])(
      '%s round-trips byte-exactly as exactly one key',
      (_l, value) => {
        const view = readViaNode(writeEnv(value, 'dotenv'))
        expect(view.KEY).toBe(value)
        // Exactly the one intended key: no NODE_OPTIONS, no CANARY, nothing smuggled in.
        expect(view.keys).toEqual(['KEY'])
      }
    )
  }
)

describe.skipIf(!hasBash)('shell → bash source oracle (AC-2; skipped on win32 / no bash)', () => {
  it.each([...POSITIVE, ...HOSTILE, ['every hazard at once', `'\`"$(echo hi)\r\n${'\t'}\\`]])(
    '%s round-trips byte-exactly',
    (_l, value) => {
      const view = readViaBash(writeEnv(value, 'shell'))
      expect(view).toEqual({ KEY: value, CANARY: '__UNSET__' })
    }
  )

  it('command substitution and quote-breaking values never execute', () => {
    const pwned = join(dir, 'pwned')
    const values = [
      `$(touch ${pwned})`,
      `\`touch ${pwned}\``,
      `'; export CANARY=1; touch ${pwned}; '`,
    ]
    for (const value of values) {
      expect(readViaBash(writeEnv(value, 'shell'))).toEqual({ KEY: value, CANARY: '__UNSET__' })
    }
    expect(existsSync(pwned)).toBe(false)
  })

  it('rule-1-only dotenv files are also literal when sourced (why they carry no warning)', () => {
    const value = `$(touch ${join(dir, 'pwned2')}) "q" \\n #`
    expect(readViaBash(writeEnv(value, 'dotenv')).KEY).toBe(value)
    expect(existsSync(join(dir, 'pwned2'))).toBe(false)
  })
})
