import { describe, expect, it } from 'vitest'
import { buildVerifySummary } from './verify.js'

describe('buildVerifySummary', () => {
  it('reports the empty-range case when there are zero rows (AC-8)', () => {
    expect(buildVerifySummary(0, 0, 0)).toBe('No records found in this range')
  })

  it('reports the all-pass case (AC-8)', () => {
    expect(buildVerifySummary(3, 3, 0)).toBe('All 3 records verified — no tampering detected')
    expect(buildVerifySummary(1247, 1247, 0)).toBe(
      'All 1247 records verified — no tampering detected'
    )
  })

  it('reports the some-fail case with singular phrasing for exactly one failure (AC-8)', () => {
    expect(buildVerifySummary(3, 2, 1)).toBe(
      '2 of 3 records verified — 1 record failed integrity check'
    )
  })

  it('reports the some-fail case with plural phrasing for more than one failure (AC-8)', () => {
    expect(buildVerifySummary(10, 7, 3)).toBe(
      '7 of 10 records verified — 3 records failed integrity check'
    )
  })

  it('uses failedCount (the true total), not failed.length, in the summary (AC-2 truncation note)', () => {
    // A bulk-tamper scenario where failedCount exceeds what would be in a truncated array.
    expect(buildVerifySummary(1000, 400, 600)).toBe(
      '400 of 1000 records verified — 600 records failed integrity check'
    )
  })

  it('never mentions cryptography jargon in the summary string (AC-8 scope note)', () => {
    const summaries = [
      buildVerifySummary(0, 0, 0),
      buildVerifySummary(3, 3, 0),
      buildVerifySummary(3, 2, 1),
    ]
    for (const summary of summaries) {
      expect(summary.toLowerCase()).not.toMatch(/hmac|hash|cryptographic/)
    }
  })
})
