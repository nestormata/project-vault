import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { namedCharacterTablesFromWhatwg, run } from './generate-html-named-entities.js'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  temps.length = 0
})

describe('namedCharacterTablesFromWhatwg', () => {
  it('splits semicolon-terminated and optional-semicolon names and sorts each', () => {
    expect(
      namedCharacterTablesFromWhatwg({
        '&nbsp': { characters: '\u00a0' },
        '&ohm;': { characters: '\u03A9' },
        '&ThinSpace;': { characters: '\u2009' },
        '&nbsp;': { characters: '\u00a0' },
        '&not': { characters: '\u00AC' },
      })
    ).toEqual({
      semicolonTerminated: { ThinSpace: '\u2009', nbsp: '\u00a0', ohm: '\u03A9' },
      optionalSemicolon: { nbsp: '\u00a0', not: '\u00AC' },
    })
  })

  it('rejects a non-object table', () => {
    expect(() => namedCharacterTablesFromWhatwg([])).toThrow(/must be an object/)
  })
})

describe('generate-html-named-entities CLI', () => {
  it('writes the compact table next to a local WHATWG snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'html5-entities-'))
    temps.push(dir)
    const from = join(dir, 'entities.json')
    const out = join(dir, 'out.json')
    writeFileSync(
      from,
      JSON.stringify({ '&ohm;': { characters: '\u03A9' }, '&ohm': { characters: '\u03A9' } })
    )
    expect(run(['--from', from, '--out', out])).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ ohm: '\u03A9' })
    expect(JSON.parse(readFileSync(join(dir, 'out-optional.json'), 'utf8'))).toEqual({
      ohm: '\u03A9',
    })
  })

  it('fails without --from', () => {
    expect(run([])).toBe(1)
  })
})
