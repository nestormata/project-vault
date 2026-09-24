/* eslint-disable sonarjs/no-duplicate-string -- table-driven cases: each row spells its versions/URLs
   literally so the expected precedence or mapping is readable at a glance. */
import { describe, expect, it } from 'vitest'
import { compareSemver, parseStrictSemver } from './semver-precedence.js'

function cmp(a: string, b: string): number {
  const pa = parseStrictSemver(a)
  const pb = parseStrictSemver(b)
  if (!pa || !pb) throw new Error(`unparseable fixture ${a} / ${b}`)
  return Math.sign(compareSemver(pa, pb))
}

describe('parseStrictSemver', () => {
  it('parses a plain release', () => {
    expect(parseStrictSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('parses numeric and alphanumeric prerelease identifiers', () => {
    expect(parseStrictSemver('1.3.0-rc.10')).toEqual({
      major: 1,
      minor: 3,
      patch: 0,
      prerelease: ['rc', 10],
    })
  })

  it.each(['0.0.0', '999999.0.0', '1.0.0-alpha', '1.0.0-0.3.7', '1.0.0-x-y-z.--'])(
    'accepts %s',
    (value) => {
      expect(parseStrictSemver(value)).not.toBeNull()
    }
  )

  it.each([
    'v1.2.3',
    '1.2',
    '1.2.3.4',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-',
    '1.2.3-01',
    '1.2.3-a..b',
    '1.2.3+sha',
    '1.2.3-rc.1+sha',
    'latest',
    '',
    ' 1.2.3',
    '1.2.3 ',
    `1.2.3-${'a'.repeat(250)}`,
    '9999999999999999999.0.0',
  ])('rejects %j', (value) => {
    expect(parseStrictSemver(value)).toBeNull()
  })

  it('rejects non-strings', () => {
    expect(parseStrictSemver(5 as unknown as string)).toBeNull()
  })
})

describe('compareSemver — SemVer 2.0.0 §11 precedence', () => {
  it.each<[string, string, number]>([
    ['1.10.0', '1.9.0', 1],
    ['1.9.0', '1.10.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.2.4', '1.2.3', 1],
    ['1.3.0', '1.3.0', 0],
    ['1.3.0-rc.1', '1.3.0', -1],
    ['1.3.0', '1.3.0-rc.1', 1],
    ['1.3.0-rc.2', '1.3.0-rc.10', -1],
    ['1.3.0-alpha', '1.3.0-alpha.1', -1],
    ['1.3.0-alpha.1', '1.3.0-beta', -1],
    ['1.3.0-alpha.1', '1.3.0-alpha.beta', -1],
    ['1.3.0-beta.2', '1.3.0-beta.11', -1],
    ['1.3.0-beta.11', '1.3.0-rc.1', -1],
    ['1.3.0-alpha.beta', '1.3.0-alpha.1', 1],
    ['1.3.0-rc.1', '1.3.0-rc.1', 0],
    ['1.4.0-rc.1', '1.3.0', 1],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(cmp(a, b)).toBe(expected)
  })
})
