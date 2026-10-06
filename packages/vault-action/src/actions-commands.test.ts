import { EOL } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsState = vi.hoisted(() => ({
  appended: [] as Array<{ path: string; data: string; encoding: unknown }>,
  exists: true,
}))

const cryptoState = vi.hoisted(() => ({ fixedUuid: null as string | null }))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => fsState.exists),
  appendFileSync: vi.fn((path: string, data: string, encoding: unknown) => {
    fsState.appended.push({ path, data, encoding })
  }),
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomUUID: vi.fn(() => cryptoState.fixedUuid ?? actual.randomUUID()),
  }
})

import * as commands from './actions-commands.js'

const { getInput, getBooleanInput, setSecret, exportVariable, setFailed, warning, info, debug } =
  commands

/** Runner-style heredoc parser: `NAME<<DELIM`, then lines until a line equal to DELIM. */
function parseEnvFile(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/)
  const out = new Map<string, string>()
  let i = 0
  while (i < lines.length) {
    const header = lines.at(i) ?? ''
    i += 1
    if (header === '') continue
    const marker = header.indexOf('<<')
    const name = header.slice(0, marker)
    const delimiter = header.slice(marker + 2)
    const body: string[] = []
    while (i < lines.length && lines.at(i) !== delimiter) {
      body.push(lines.at(i) ?? '')
      i += 1
    }
    i += 1
    out.set(name, body.join('\n'))
  }
  return out
}

let written: string[]
const GITHUB_ENV = 'GITHUB_ENV'
const API_KEY_ENV = 'INPUT_API-KEY'
const envKeys = [
  API_KEY_ENV,
  'INPUT_VAULT-URL',
  'INPUT_MY_INPUT',
  GITHUB_ENV,
  'EXPORTED_VAR',
  'PEM',
  'TRICKY',
  'A',
  'B',
]
let savedExitCode: typeof process.exitCode

beforeEach(() => {
  written = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  fsState.appended = []
  fsState.exists = true
  cryptoState.fixedUuid = null
  savedExitCode = process.exitCode
  for (const key of envKeys) vi.stubEnv(key, undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = savedExitCode
  vi.unstubAllEnvs()
})

describe('export surface (AC-1)', () => {
  it('exports exactly the eight needed functions', () => {
    expect(Object.keys(commands).sort()).toEqual(
      [
        'debug',
        'exportVariable',
        'getBooleanInput',
        'getInput',
        'info',
        'setFailed',
        'setSecret',
        'warning',
      ].sort()
    )
  })
})

describe('getInput (AC-2)', () => {
  it('reads INPUT_<NAME> with hyphens kept and trims the value', () => {
    vi.stubEnv('INPUT_VAULT-URL', '  https://v.example  ')
    expect(getInput('vault-url')).toBe('https://v.example')
  })

  it('upper-cases the name and replaces spaces with underscores', () => {
    vi.stubEnv('INPUT_MY_INPUT', 'x')
    expect(getInput('my input')).toBe('x')
  })

  it('returns an empty string when unset and not required', () => {
    expect(getInput('api-key')).toBe('')
  })

  it('throws when required and unset or empty', () => {
    expect(() => getInput('api-key', { required: true })).toThrow(
      new Error('Input required and not supplied: api-key')
    )
    vi.stubEnv(API_KEY_ENV, '')
    expect(() => getInput('api-key', { required: true })).toThrow(
      'Input required and not supplied: api-key'
    )
  })

  it('runs the required check on the untrimmed value (whitespace-only passes, returns empty)', () => {
    vi.stubEnv(API_KEY_ENV, '   ')
    expect(getInput('api-key', { required: true })).toBe('')
  })

  it('returns a present value when required', () => {
    vi.stubEnv(API_KEY_ENV, 'k')
    expect(getInput('api-key', { required: true })).toBe('k')
  })
})

describe('getBooleanInput (AC-2)', () => {
  it.each(['true', 'True', 'TRUE', ' true '])('accepts %j as true', (raw) => {
    vi.stubEnv(API_KEY_ENV, raw)
    expect(getBooleanInput('api-key')).toBe(true)
  })

  it.each(['false', 'False', 'FALSE', ' FALSE\n'])('accepts %j as false', (raw) => {
    vi.stubEnv(API_KEY_ENV, raw)
    expect(getBooleanInput('api-key')).toBe(false)
  })

  it.each(['yes', '1', 'tRuE', ''])('rejects %j with a TypeError', (raw) => {
    vi.stubEnv(API_KEY_ENV, raw)
    expect(() => getBooleanInput('api-key')).toThrow(TypeError)
    expect(() => getBooleanInput('api-key')).toThrow(
      /^Input does not meet YAML 1\.2 "Core Schema" specification: api-key/
    )
  })
})

describe('setSecret (AC-3)', () => {
  it('writes an add-mask command line', () => {
    setSecret('abc')
    expect(written).toEqual([`::add-mask::abc${EOL}`])
  })

  it('escapes percent signs', () => {
    setSecret('50%')
    expect(written).toEqual([`::add-mask::50%25${EOL}`])
  })

  it('escapes CR and LF so a value cannot start a second command', () => {
    setSecret('a\r\n::set-env name=X::y\n::stop-commands::')
    expect(written).toHaveLength(1)
    expect(written[0]).toBe(`::add-mask::a%0D%0A::set-env name=X::y%0A::stop-commands::${EOL}`)
  })

  it('escapes percent before CR/LF (no double-escaping of the new sequences)', () => {
    setSecret('%\n')
    expect(written).toEqual([`::add-mask::%25%0A${EOL}`])
  })

  it('writes mid-string :: verbatim and does not special-case the empty string', () => {
    setSecret('a::b')
    setSecret('')
    expect(written).toEqual([`::add-mask::a::b${EOL}`, `::add-mask::${EOL}`])
  })
})

describe('exportVariable (AC-4)', () => {
  it('sets process.env and appends a heredoc block to GITHUB_ENV', () => {
    vi.stubEnv(GITHUB_ENV, 'ENVFILE')
    exportVariable('EXPORTED_VAR', 'value')
    expect(process.env['EXPORTED_VAR']).toBe('value')
    expect(fsState.appended).toHaveLength(1)
    const call = fsState.appended.at(0)
    expect(call?.path).toBe('ENVFILE')
    expect(call?.encoding).toBe('utf8')
    const delimiter = /^EXPORTED_VAR<<(ghadelimiter_[0-9a-f-]{36})/.exec(call?.data ?? '')?.[1]
    expect(delimiter).toBeDefined()
    expect(call?.data).toBe(`EXPORTED_VAR<<${delimiter}${EOL}value${EOL}${delimiter}${EOL}`)
    expect(written).toEqual([])
  })

  it('round-trips tricky values through a runner-style parser', () => {
    vi.stubEnv(GITHUB_ENV, 'ENVFILE')
    const pem = '-----BEGIN KEY-----\nabc==\n-----END KEY-----'
    const tricky = 'EOF\n<<\na=b\nghadelimiter_\nEOF'
    exportVariable('PEM', pem)
    exportVariable('TRICKY', tricky)
    const parsed = parseEnvFile(fsState.appended.map((c) => c.data).join(''))
    expect(Object.fromEntries(parsed)).toEqual({ PEM: pem, TRICKY: tricky })
  })

  it('uses a fresh delimiter per call', () => {
    vi.stubEnv(GITHUB_ENV, 'ENVFILE')
    exportVariable('A', '1')
    exportVariable('B', '2')
    const delimiters = fsState.appended.map((c) => /<<(\S+)/.exec(c.data)?.[1])
    expect(delimiters[0]).toBeDefined()
    expect(delimiters[0]).not.toBe(delimiters[1])
  })

  it('throws on delimiter injection in the value and does not mutate process.env', () => {
    vi.stubEnv(GITHUB_ENV, 'ENVFILE')
    cryptoState.fixedUuid = '11111111-2222-3333-4444-555555555555'
    expect(() =>
      exportVariable('EXPORTED_VAR', `x\nghadelimiter_${cryptoState.fixedUuid}\nINJECTED=1`)
    ).toThrow(/delimiter/)
    expect(process.env['EXPORTED_VAR']).toBeUndefined()
    expect(fsState.appended).toEqual([])
  })

  it('throws on delimiter injection in the name', () => {
    vi.stubEnv(GITHUB_ENV, 'ENVFILE')
    cryptoState.fixedUuid = '11111111-2222-3333-4444-555555555555'
    expect(() => exportVariable(`ghadelimiter_${cryptoState.fixedUuid}`, 'v')).toThrow(/delimiter/)
    expect(fsState.appended).toEqual([])
  })

  it.each(['', 'A\nB', 'A\rB', 'A=B', 'A<<B'])('rejects unsafe name %j', (name) => {
    vi.stubEnv(GITHUB_ENV, 'ENVFILE')
    expect(() => exportVariable(name, 'v')).toThrow(/Invalid environment variable name/)
    expect(fsState.appended).toEqual([])
    expect(Object.hasOwn(process.env, name)).toBe(false)
  })

  it('throws when GITHUB_ENV is unset or empty and never writes the value to stdout', () => {
    expect(() => exportVariable('EXPORTED_VAR', 'topsecret')).toThrow(
      new Error('GITHUB_ENV is not set; cannot export EXPORTED_VAR')
    )
    vi.stubEnv(GITHUB_ENV, '')
    expect(() => exportVariable('EXPORTED_VAR', 'topsecret')).toThrow(
      'GITHUB_ENV is not set; cannot export EXPORTED_VAR'
    )
    expect(process.env['EXPORTED_VAR']).toBeUndefined()
    expect(written).toEqual([])
  })

  it('throws when the GITHUB_ENV file is missing', () => {
    vi.stubEnv(GITHUB_ENV, 'MISSING')
    fsState.exists = false
    expect(() => exportVariable('EXPORTED_VAR', 'v')).toThrow(
      new Error('Missing file at path: MISSING')
    )
    expect(fsState.appended).toEqual([])
  })
})

describe('logging commands (AC-5)', () => {
  it('setFailed sets exit code 1 and writes an escaped error command', () => {
    process.exitCode = 0
    setFailed('boom')
    expect(process.exitCode).toBe(1)
    expect(written).toEqual([`::error::boom${EOL}`])
  })

  it('setFailed can be called repeatedly and keeps a non-zero exit code', () => {
    process.exitCode = 2
    setFailed('one')
    setFailed('two')
    expect(process.exitCode).toBe(1)
    expect(written).toEqual([`::error::one${EOL}`, `::error::two${EOL}`])
  })

  it('warning escapes newlines so it cannot inject a command', () => {
    warning('a\n::error::fake')
    expect(written).toEqual([`::warning::a%0A::error::fake${EOL}`])
  })

  it('debug escapes data', () => {
    debug('d%\r\n')
    expect(written).toEqual([`::debug::d%25%0D%0A${EOL}`])
  })

  it('info writes the message unescaped with a trailing EOL', () => {
    info('plain 100%')
    expect(written).toEqual([`plain 100%${EOL}`])
  })
})
