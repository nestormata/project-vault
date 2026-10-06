import { describe, expect, it } from 'vitest'
import {
  absDeltaBounds,
  bootstrapMedianDeltaCI,
  classifyDelta,
  evaluateTiming,
  formatTimingTable,
  mergeResample,
  median,
  mulberry32,
  percentile,
  seededShuffle,
  toleranceFromAA,
} from './timing-stats.js'

describe('median / percentile', () => {
  it('median of odd and even samples', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
  it('percentile uses nearest-rank on sorted data and does not mutate input', () => {
    const xs = [5, 1, 4, 2, 3]
    expect(percentile(xs, 0.99)).toBe(5)
    expect(percentile(xs, 0)).toBe(1)
    expect(xs).toEqual([5, 1, 4, 2, 3])
  })
  it('rejects an empty sample', () => {
    expect(() => median([])).toThrow(/empty/)
  })
})

describe('mulberry32 / seededShuffle', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(42))
    const b = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(42))
    const c = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(7))
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect([...a].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('bootstrapMedianDeltaCI', () => {
  it('brackets the true median difference for clearly separated samples', () => {
    const base = Array.from({ length: 30 }, (_, i) => 5 + (i % 5) * 0.1)
    const shifted = base.map((x) => x + 10)
    const ci = bootstrapMedianDeltaCI(shifted, base, {
      resamples: 2000,
      confidence: 0.995,
      rng: mulberry32(1),
    })
    expect(ci.delta).toBeCloseTo(10, 5)
    expect(ci.lo).toBeGreaterThan(9)
    expect(ci.hi).toBeLessThan(11)
  })
  it('straddles zero for identical distributions', () => {
    const xs = Array.from({ length: 30 }, (_, i) => 5 + (i % 7) * 0.3)
    const ci = bootstrapMedianDeltaCI([...xs].reverse(), xs, {
      resamples: 2000,
      confidence: 0.995,
      rng: mulberry32(2),
    })
    expect(ci.lo).toBeLessThanOrEqual(0)
    expect(ci.hi).toBeGreaterThanOrEqual(0)
  })
})

describe('absDeltaBounds / classifyDelta / toleranceFromAA', () => {
  it('a CI straddling zero has a lower bound of 0', () => {
    expect(absDeltaBounds({ delta: 0.1, lo: -1, hi: 2 })).toEqual({ lower: 0, upper: 2 })
  })
  it('a negative CI (faster class) is measured by magnitude', () => {
    expect(absDeltaBounds({ delta: -5, lo: -6, hi: -4 })).toEqual({ lower: 4, upper: 6 })
  })
  it('classifies fail / pass / inconclusive against T', () => {
    expect(classifyDelta({ delta: -5, lo: -6, hi: -4 }, 2)).toBe('fail')
    expect(classifyDelta({ delta: 0.2, lo: -1, hi: 1.5 }, 2)).toBe('pass')
    expect(classifyDelta({ delta: 1.8, lo: 1, hi: 3 }, 2)).toBe('inconclusive')
  })
  it('T is max(T_floor, k x A/A half-width)', () => {
    expect(toleranceFromAA({ delta: 0, lo: -0.1, hi: 0.1 }, { floorMs: 2, k: 3 })).toBe(2)
    expect(toleranceFromAA({ delta: 0, lo: -2, hi: 2 }, { floorMs: 2, k: 3 })).toBe(6)
  })
})

describe('evaluateTiming', () => {
  const method = { floorMs: 2, k: 3, resamples: 1000, confidence: 0.995, maxInconclusive: 2 }
  const flat = (center: number) => Array.from({ length: 30 }, (_, i) => center + (i % 5) * 0.05)
  const noisy = (center: number) =>
    Array.from({ length: 30 }, (_, i) => center + ((i * 7919) % 13) - 6)

  it('valid PASS when every miss class matches U, A/A passes and H is detected', () => {
    const result = evaluateTiming(
      { U: flat(5), "U'": flat(5), M: flat(5), R: flat(5), H: flat(20) },
      { ...method, seed: 3, missClasses: ['M', 'R'] }
    )
    expect(result.validity).toBe('valid')
    expect(result.rows.find((r) => r.cls === 'M')?.verdict).toBe('pass')
    expect(result.leaks).toEqual([])
    expect(formatTimingTable(result)).toContain('validity=valid')
  })

  it('reports a leak for a slower miss class', () => {
    const result = evaluateTiming(
      { U: flat(5), "U'": flat(5), M: flat(5), R: flat(15), H: flat(20) },
      { ...method, seed: 3, missClasses: ['M', 'R'] }
    )
    expect(result.validity).toBe('valid')
    expect(result.leaks).toEqual(['R'])
  })

  it('is INVALID (never pass) when the positive control H is not detected', () => {
    const result = evaluateTiming(
      { U: flat(5), "U'": flat(5), M: flat(5), H: flat(5) },
      { ...method, seed: 3, missClasses: ['M'] }
    )
    expect(result.validity).toBe('invalid: positive control not detected')
  })

  it('is INVALID when the A/A comparison fails', () => {
    const result = evaluateTiming(
      { U: flat(5), "U'": flat(50), M: flat(5), H: flat(500) },
      { ...method, seed: 3, missClasses: ['M'] }
    )
    expect(result.validity).toBe('invalid: A/A failed')
  })

  it('is INVALID (underpowered) when more than maxInconclusive classes stay inconclusive', () => {
    const result = evaluateTiming(
      { U: flat(5), "U'": flat(5), A: noisy(7), B: noisy(7), C: noisy(7), H: flat(100) },
      { ...method, seed: 3, missClasses: ['A', 'B', 'C'] }
    )
    expect(result.rows.filter((r) => r.verdict === 'inconclusive').length).toBeGreaterThan(2)
    expect(result.validity).toBe('invalid: underpowered')
  })

  it('throws on missing samples', () => {
    expect(() =>
      evaluateTiming({ "U'": flat(5), H: flat(5) }, { ...method, seed: 1, missClasses: [] })
    ).toThrow(/baseline/)
    expect(() =>
      evaluateTiming({ U: flat(5), H: flat(5) }, { ...method, seed: 1, missClasses: [] })
    ).toThrow(/missing class/)
  })
})

describe('mergeResample', () => {
  const method = {
    floorMs: 2,
    k: 3,
    resamples: 1000,
    confidence: 0.995,
    maxInconclusive: 2,
    seed: 5,
  }
  const flat = (center: number) => Array.from({ length: 30 }, (_, i) => center + (i % 5) * 0.05)
  const noisy = (center: number) =>
    Array.from({ length: 30 }, (_, i) => center + ((i * 7919) % 13) - 6)

  it('replaces only the re-sampled rows and recomputes leaks/inconclusive/validity', () => {
    const first = evaluateTiming(
      { U: flat(5), "U'": flat(5), A: noisy(7), B: flat(5), H: flat(50) },
      { ...method, missClasses: ['A', 'B'] }
    )
    expect(first.inconclusive).toEqual(['A'])
    const second = evaluateTiming(
      { U: flat(5), "U'": flat(5), A: flat(5), H: flat(50) },
      { ...method, missClasses: ['A'] }
    )
    const merged = mergeResample(first, second, 2)
    expect(merged.rows.map((r) => [r.cls, r.verdict])).toEqual([
      ['A', 'pass'],
      ['B', 'pass'],
    ])
    expect(merged.inconclusive).toEqual([])
    expect(merged.validity).toBe('valid')
  })

  it('an A/A failure in the re-sample pass invalidates the merged result', () => {
    const first = evaluateTiming(
      { U: flat(5), "U'": flat(5), A: noisy(7), H: flat(50) },
      { ...method, missClasses: ['A'] }
    )
    const second = evaluateTiming(
      { U: flat(5), "U'": flat(40), A: flat(5), H: flat(500) },
      { ...method, missClasses: ['A'] }
    )
    expect(mergeResample(first, second, 2).validity).toBe('invalid: A/A failed')
  })
})
