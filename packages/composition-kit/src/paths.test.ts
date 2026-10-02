import { describe, expect, it } from 'vitest'
import { sha256Hex } from './hash.js'
import {
  compareCodeUnits,
  findCaseCollisions,
  isServerOnlyPath,
  manifestPathProblem,
  normalizePackPath,
  sortedCodeUnits,
  toPosix,
} from './paths.js'

const HEALTH_TILE = 'injections/HealthTile.svelte'

describe('sha256Hex', () => {
  it('is lowercase hex over raw bytes and never normalizes line endings', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(sha256Hex(Buffer.from('a\r\n'))).not.toBe(sha256Hex(Buffer.from('a\n')))
  })
})

describe('paths', () => {
  it('toPosix converts backslashes', () => {
    expect(toPosix('a\\b\\c')).toBe('a/b/c')
  })

  it('compares by code unit, independent of locale', () => {
    expect(compareCodeUnits('B', 'a')).toBeLessThan(0)
    expect(sortedCodeUnits(['b', 'B', 'a', 'A'])).toEqual(['A', 'B', 'a', 'b'])
    expect(compareCodeUnits('x', 'x')).toBe(0)
  })

  it('accepts ordinary paths, including spaces, groups, params and non-ASCII', () => {
    for (const path of [
      'src/routes/(app)/projects/[projectId]/+page.svelte',
      'src/routes/a b/ñandú/+page.svelte',
      'static/favicon.png',
    ]) {
      expect(manifestPathProblem(path)).toBeNull()
    }
  })

  it.each([
    ['../x', 'escape'],
    ['src/../../x', 'escape'],
    ['/abs/x', 'absolute'],
    ['src\\x', 'forward slashes'],
    ['', 'empty'],
  ])('rejects %j (%s)', (path, reason) => {
    expect(manifestPathProblem(path)).toContain(reason)
  })

  it('normalizes pack-relative references', () => {
    expect(normalizePackPath('./a/../a/x.ts')).toBe('a/x.ts')
    expect(normalizePackPath(HEALTH_TILE)).toBe(HEALTH_TILE)
    expect(normalizePackPath('../out.ts')).toBeNull()
    expect(normalizePackPath('/abs.ts')).toBeNull()
  })

  it('reports paths that differ only by case', () => {
    expect(findCaseCollisions(['a/X.ts', 'a/x.ts', 'b/y.ts'])).toEqual([['a/X.ts', 'a/x.ts']])
    expect(findCaseCollisions(['a', 'b'])).toEqual([])
  })
})

describe('isServerOnlyPath (design section 3 item 4)', () => {
  it.each([
    ['injections/health-tile.server.ts', true],
    ['server/x.ts', true],
    ['lib/server/deep/x.ts', true],
    ['a.server.ts', true],
    ['a.observer.ts', false],
    ['server.ts', false],
    ['lib/x.ts', false],
    [HEALTH_TILE, false],
    ['x.server', false],
  ])('%s -> %s', (path, expected) => {
    expect(isServerOnlyPath(path)).toBe(expected)
  })
})
