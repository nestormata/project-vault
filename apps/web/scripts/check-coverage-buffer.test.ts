import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeBranchTotals,
  meetsBranchBuffer,
  STALE_AFTER_MS,
  verifyCoverageBuffer,
  type CoverageFinal,
} from './check-coverage-buffer.js'

const COVERAGE_FINAL_FILENAME = 'coverage-final.json'

function branchEntry(hitCounts: number[][]): CoverageFinal[string] {
  const b: Record<string, number[]> = {}
  hitCounts.forEach((counts, index) => {
    b[String(index)] = counts
  })
  return { b }
}

describe('computeBranchTotals', () => {
  it('sums covered and total branch paths across every file', () => {
    const coverage: CoverageFinal = {
      '/repo/apps/web/src/a.ts': branchEntry([
        [1, 0],
        [2, 3],
      ]),
      '/repo/apps/web/src/b.ts': branchEntry([[0, 0]]),
    }

    expect(computeBranchTotals(coverage)).toEqual({ covered: 3, total: 6 })
  })

  it('treats a file with no branch map as contributing zero branches', () => {
    const coverage: CoverageFinal = { '/repo/apps/web/src/barrel.ts': {} }
    expect(computeBranchTotals(coverage)).toEqual({ covered: 0, total: 0 })
  })
})

describe('meetsBranchBuffer', () => {
  it('fails a fixture just under 85% using integer arithmetic', () => {
    // 8499/10000 = 84.99%
    expect(meetsBranchBuffer({ covered: 8499, total: 10000 })).toBe(false)
  })

  it('passes an exact-integer 85% fixture', () => {
    // 850/1000 = exactly 85.00%
    expect(meetsBranchBuffer({ covered: 850, total: 1000 })).toBe(true)
  })

  it('passes a fixture above 85%', () => {
    expect(meetsBranchBuffer({ covered: 900, total: 1000 })).toBe(true)
  })

  it('passes when there are zero eligible branches (nothing to fail)', () => {
    expect(meetsBranchBuffer({ covered: 0, total: 0 })).toBe(true)
  })
})

describe('verifyCoverageBuffer', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coverage-buffer-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails when coverage-final.json is missing', () => {
    const result = verifyCoverageBuffer(join(dir, COVERAGE_FINAL_FILENAME))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not found/i)
  })

  it('fails when coverage-final.json is malformed JSON', () => {
    const path = join(dir, COVERAGE_FINAL_FILENAME)
    writeFileSync(path, '{ not valid json')
    const result = verifyCoverageBuffer(path)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/malformed|parse/i)
  })

  it('fails when coverage-final.json is stale', () => {
    const path = join(dir, COVERAGE_FINAL_FILENAME)
    const coverage: CoverageFinal = { '/x.ts': branchEntry([[1]]) }
    writeFileSync(path, JSON.stringify(coverage))
    // File mtime is "now" (just written); evaluate as if verified well after the staleness window.
    const result = verifyCoverageBuffer(path, { now: Date.now() + STALE_AFTER_MS + 120_000 })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/stale/i)
  })

  it('fails a fresh below-85% coverage file', () => {
    const path = join(dir, COVERAGE_FINAL_FILENAME)
    const b: Record<string, number[]> = {}
    for (let i = 0; i < 10000; i++) b[String(i)] = i < 8499 ? [1] : [0]
    writeFileSync(path, JSON.stringify({ '/x.ts': { b } }))
    const result = verifyCoverageBuffer(path, { now: Date.now() })
    expect(result.ok).toBe(false)
    expect(result.totals).toEqual({ covered: 8499, total: 10000 })
  })

  it('passes a fresh exact-85% coverage file', () => {
    const path = join(dir, COVERAGE_FINAL_FILENAME)
    const b: Record<string, number[]> = {}
    for (let i = 0; i < 1000; i++) b[String(i)] = i < 850 ? [1] : [0]
    writeFileSync(path, JSON.stringify({ '/x.ts': { b } }))
    const result = verifyCoverageBuffer(path, { now: Date.now() })
    expect(result.ok).toBe(true)
    expect(result.totals).toEqual({ covered: 850, total: 1000 })
  })
})
