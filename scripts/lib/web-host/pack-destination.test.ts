import { describe, expect, it } from 'vitest'
import { npmPackArgs, packDestination } from './pack-destination.js'

// Story 68.2 (Sonar tssecurity:S8705): the `--tarball` value reaches `npm pack`'s argv only as a
// validated absolute path fused to its flag.

const CWD = '/work/pv'
const NPM_CLI = '/node/npm-cli.js'
const PACKS = '/tmp/packs'

describe('packDestination', () => {
  it('resolves a relative directory against cwd and keeps an absolute one', () => {
    expect(packDestination('out', CWD)).toBe('/work/pv/out')
    expect(packDestination('./dist/../out', CWD)).toBe('/work/pv/out')
    expect(packDestination(PACKS, CWD)).toBe(PACKS)
  })

  it.each([
    ['an empty value', ''],
    ['a blank value', '   '],
    ['an npm option', '--registry=https://evil.example'],
    ['a short option', '-g'],
    ['a lone dash', '-'],
    ['a newline', 'out\n--registry=x'],
    ['a NUL byte', 'out\u0000x'],
    ['a DEL character', 'out\u007f'],
  ])('rejects %s', (_label, raw) => {
    expect(() => packDestination(raw, CWD)).toThrow(/--tarball/)
  })
})

describe('npmPackArgs', () => {
  it('passes the destination fused to its flag, never as its own argument', () => {
    expect(npmPackArgs(NPM_CLI, PACKS)).toEqual([
      NPM_CLI,
      'pack',
      '--json',
      `--pack-destination=${PACKS}`,
    ])
  })

  it('refuses an option-shaped destination before building argv', () => {
    expect(() => npmPackArgs(NPM_CLI, '--dry-run')).toThrow(/looks like an option/)
  })
})
