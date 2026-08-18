import { describe, expect, it } from 'vitest'
import {
  buildCombinedReport,
  checkEnvSingletonFrozenAtImport,
  checkTenantIsolation,
  computeLockHoldStats,
  computePercentiles,
  computePgStatDelta,
  computeRegressionPercent,
  discardWarmup,
  renderConsoleSummary,
  type ArmResult,
  type PercentileStats,
} from './audit-quota-isolation-bench.js'

const FIXTURE_TIMESTAMP = '2026-08-18T00:00:00.000Z'

describe('Story 22.4: computePercentiles', () => {
  it('returns all-zero stats with count 0 for an empty array', () => {
    expect(computePercentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, count: 0 })
  })

  it('returns the single sample for every percentile', () => {
    expect(computePercentiles([4.2])).toEqual({ p50: 4.2, p95: 4.2, p99: 4.2, count: 1 })
  })

  it('computes nearest-rank percentiles from an unsorted array', () => {
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    const stats = computePercentiles(latencies)
    expect(stats.count).toBe(100)
    expect(stats.p50).toBe(50)
    expect(stats.p95).toBe(95)
    expect(stats.p99).toBe(99)
  })

  it('handles exact-percentile-index tie-breaking without going out of bounds', () => {
    const latencies = [1, 2, 3, 4]
    const stats = computePercentiles(latencies)
    expect(stats.p99).toBe(4)
    expect(stats.p50).toBeGreaterThanOrEqual(1)
    expect(stats.p50).toBeLessThanOrEqual(4)
  })

  it('is insensitive to input order', () => {
    const sorted = computePercentiles([1, 2, 3, 4, 5])
    const shuffled = computePercentiles([3, 1, 5, 2, 4])
    expect(shuffled).toEqual(sorted)
  })
})

describe('Story 22.4: discardWarmup', () => {
  it('discards the leading 10% by default', () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    expect(discardWarmup(items)).toEqual(items.slice(10))
  })

  it('discards nothing from an array too small to have a whole-number warm-up', () => {
    expect(discardWarmup([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('handles an empty array', () => {
    expect(discardWarmup([])).toEqual([])
  })
})

describe('Story 22.4: computeRegressionPercent', () => {
  it('computes a positive regression when candidate is slower', () => {
    expect(computeRegressionPercent(4.2, 4.9)).toBeCloseTo(16.666, 2)
  })

  it('computes a negative regression (improvement) when candidate is faster', () => {
    expect(computeRegressionPercent(5.0, 4.0)).toBeCloseTo(-20, 5)
  })

  it('returns 0 when baseline and candidate are both non-positive', () => {
    expect(computeRegressionPercent(0, 0)).toBe(0)
  })

  it('returns Infinity when baseline is non-positive but candidate is positive', () => {
    expect(computeRegressionPercent(0, 5)).toBe(Infinity)
  })
})

describe('Story 22.4: checkEnvSingletonFrozenAtImport (AC-1 regression tripwire)', () => {
  it('does not throw when the singleton is correctly frozen at import (current codebase behavior)', () => {
    const frozenSingleton = { AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: false }
    expect(() => checkEnvSingletonFrozenAtImport(frozenSingleton)).not.toThrow()
  })

  it('restores process.env to its prior value after the check', () => {
    const original = process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
    checkEnvSingletonFrozenAtImport({ AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: true })
    expect(process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']).toBe(original)
  })

  it('throws if the singleton actually reflects the post-import process.env mutation (the exact mistake this check exists to catch)', () => {
    // Simulates a hypothetical "env" object whose getter re-reads process.env live — the bug
    // this tripwire is designed to catch if env.ts is ever refactored away from load-once.
    const liveSingleton = {
      get AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED(): boolean {
        return process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] === 'true'
      },
    }
    expect(() => checkEnvSingletonFrozenAtImport(liveSingleton)).toThrow(/REGRESSION/)
  })

  it('matches the real env.ts singleton behavior end to end', async () => {
    const { env } = await import('../apps/api/src/config/env.js')
    expect(() => checkEnvSingletonFrozenAtImport(env)).not.toThrow()
  })
})

describe('Story 22.4: computeLockHoldStats', () => {
  it('returns all-zero/false for an empty array', () => {
    expect(computeLockHoldStats([])).toEqual({ p50: 0, p95: 0, max: 0, growing: false })
  })

  it('flags growth when the tail of the burst is meaningfully slower than the head', () => {
    const samples = [
      ...Array.from({ length: 30 }, () => 1),
      ...Array.from({ length: 30 }, () => 1),
      ...Array.from({ length: 30 }, () => 5),
    ]
    expect(computeLockHoldStats(samples).growing).toBe(true)
  })

  it('does not flag growth for a roughly flat series', () => {
    const samples = Array.from({ length: 90 }, () => 2 + (Math.random() - 0.5) * 0.1)
    expect(computeLockHoldStats(samples).growing).toBe(false)
  })
})

describe('Story 22.4: computePgStatDelta', () => {
  it('computes deltas and the HOT-update ratio', () => {
    const before = { nDeadTup: 10, nTupUpd: 100, nTupHotUpd: 90, lastAutovacuum: null }
    const after = { nDeadTup: 852, nTupUpd: 1100, nTupHotUpd: 1032, lastAutovacuum: null }
    const delta = computePgStatDelta(before, after)
    expect(delta.deltaDeadTup).toBe(842)
    expect(delta.deltaTupUpd).toBe(1000)
    expect(delta.deltaTupHotUpd).toBe(942)
    expect(delta.hotUpdateRatio).toBeCloseTo(0.942, 5)
  })

  it('returns a 0 ratio (not NaN/Infinity) when there were no updates in the window', () => {
    const snapshot = { nDeadTup: 5, nTupUpd: 50, nTupHotUpd: 45, lastAutovacuum: null }
    expect(computePgStatDelta(snapshot, snapshot).hotUpdateRatio).toBe(0)
  })
})

describe('Story 22.4: checkTenantIsolation (AC-7)', () => {
  it('passes when each org usage row matches its own attempted writes', () => {
    const result = checkTenantIsolation({
      orgAAttempted: 1200,
      orgAUsageEntryCount: 1200,
      orgBAttempted: 80,
      orgBUsageEntryCount: 80,
    })
    expect(result.ok).toBe(true)
    expect(result.anomalies).toEqual([])
  })

  it('passes when an org under-counts due to its own legitimate self-refusals', () => {
    const result = checkTenantIsolation({
      orgAAttempted: 1200,
      orgAUsageEntryCount: 1195,
      orgBAttempted: 80,
      orgBUsageEntryCount: 80,
    })
    expect(result.ok).toBe(true)
  })

  it('flags org B contamination when its usage row exceeds its own attempted writes', () => {
    const result = checkTenantIsolation({
      orgAAttempted: 1200,
      orgAUsageEntryCount: 1200,
      orgBAttempted: 80,
      orgBUsageEntryCount: 95,
    })
    expect(result.ok).toBe(false)
    expect(result.anomalies).toHaveLength(1)
    expect(result.anomalies[0]).toMatch(/org B/)
  })

  it('flags org A contamination symmetrically', () => {
    const result = checkTenantIsolation({
      orgAAttempted: 1200,
      orgAUsageEntryCount: 1250,
      orgBAttempted: 80,
      orgBUsageEntryCount: 80,
    })
    expect(result.ok).toBe(false)
    expect(result.anomalies[0]).toMatch(/org A/)
  })
})

function fixtureArmResult(overrides: Partial<ArmResult> = {}): ArmResult {
  const stats = (p95: number): PercentileStats => ({
    p50: p95 * 0.6,
    p95,
    p99: p95 * 1.2,
    count: 72,
  })
  return {
    arm: 'disabled',
    orgB: {
      repetitions: [stats(4.0), stats(4.2), stats(4.1)],
      aggregate: stats(4.2),
      attempted: 240,
      completed: 240,
    },
    orgA: { attempted: 3600, completed: 3600 },
    poolPeakConnections: 7,
    poolConcurrencyConfigured: { orgA: 6, orgB: 1 },
    lockHoldProxyMs: { p50: 0.8, p95: 1.4, max: 2.1, growing: false },
    pgStat: {
      before: { nDeadTup: 0, nTupUpd: 0, nTupHotUpd: 0, lastAutovacuum: null },
      after: { nDeadTup: 800, nTupUpd: 3600, nTupHotUpd: 3400, lastAutovacuum: null },
      deltaDeadTup: 800,
      deltaTupUpd: 3600,
      deltaTupHotUpd: 3400,
      hotUpdateRatio: 0.944,
    },
    isolation: {
      orgAExpected: 3600,
      orgAActual: 3600,
      orgBExpected: 240,
      orgBActual: 240,
      ok: true,
      anomalies: [],
    },
    ...overrides,
  }
}

describe('Story 22.4: buildCombinedReport', () => {
  it('computes a passing regression when enabled p95 is within 25% of disabled p95', () => {
    const disabled = fixtureArmResult({ arm: 'disabled' })
    const enabled = fixtureArmResult({
      arm: 'enabled',
      orgB: {
        repetitions: [
          { p50: 2.9, p95: 4.6, p99: 5.6, count: 72 },
          { p50: 3.0, p95: 4.8, p99: 5.8, count: 72 },
          { p50: 2.95, p95: 4.7, p99: 5.7, count: 72 },
        ],
        aggregate: { p50: 3.0, p95: 4.9, p99: 5.9, count: 216 },
        attempted: 240,
        completed: 240,
      },
    })
    const report = buildCombinedReport({
      disabled,
      enabled,
      commitHash: 'abc123',
      timestamp: FIXTURE_TIMESTAMP,
    })
    expect(report.regressionPercentAggregate).toBeCloseTo(16.666, 2)
    expect(report.pass).toBe(true)
    expect(report.regressionPercentByRepetition).toHaveLength(3)
  })

  it('fails when the aggregate regression exceeds the 25% threshold', () => {
    const disabled = fixtureArmResult({ arm: 'disabled' })
    const enabled = fixtureArmResult({
      arm: 'enabled',
      orgB: {
        repetitions: disabled.orgB.repetitions,
        aggregate: { p50: 3.6, p95: 5.6, p99: 6.6, count: 216 },
        attempted: 240,
        completed: 240,
      },
    })
    const report = buildCombinedReport({
      disabled,
      enabled,
      commitHash: 'abc123',
      timestamp: FIXTURE_TIMESTAMP,
    })
    expect(report.regressionPercentAggregate).toBeCloseTo(33.333, 2)
    expect(report.pass).toBe(false)
  })

  it('never silently omits a repetition even when one repetition would fail on its own', () => {
    const disabled = fixtureArmResult({ arm: 'disabled' })
    const enabled = fixtureArmResult({
      arm: 'enabled',
      orgB: {
        repetitions: [
          { p50: 2.9, p95: 4.6, p99: 5.6, count: 72 }, // ~15% vs disabled rep 1 (4.0)... see below
          { p50: 3.0, p95: 5.6, p99: 6.6, count: 72 }, // high regression vs disabled rep 2 (4.2)
          { p50: 2.95, p95: 4.7, p99: 5.7, count: 72 },
        ],
        aggregate: { p50: 3.0, p95: 4.9, p99: 5.9, count: 216 },
        attempted: 240,
        completed: 240,
      },
    })
    const report = buildCombinedReport({
      disabled,
      enabled,
      commitHash: 'abc123',
      timestamp: FIXTURE_TIMESTAMP,
    })
    expect(report.regressionPercentByRepetition).toHaveLength(3)
    // rep 2: disabled p95=4.2, enabled p95=5.6 -> ~33.3% regression, reported even though
    // aggregate passes.
    expect(report.regressionPercentByRepetition[1]).toBeGreaterThan(report.thresholdPercent)
  })
})

describe('Story 22.4: renderConsoleSummary', () => {
  it('includes both arms, the regression verdict, and the fingerprint', () => {
    const disabled = fixtureArmResult({ arm: 'disabled' })
    const enabled = fixtureArmResult({ arm: 'enabled' })
    const report = buildCombinedReport({
      disabled,
      enabled,
      commitHash: 'deadbeef',
      timestamp: FIXTURE_TIMESTAMP,
    })
    const text = renderConsoleSummary(report)
    expect(text).toContain('deadbeef')
    expect(text).toContain('arm: disabled')
    expect(text).toContain('arm: enabled')
    expect(text).toMatch(/PASS|FAIL/)
  })

  it('surfaces a tenant-isolation anomaly in the rendered text', () => {
    const disabled = fixtureArmResult({
      arm: 'disabled',
      isolation: {
        orgAExpected: 3600,
        orgAActual: 3600,
        orgBExpected: 240,
        orgBActual: 260,
        ok: false,
        anomalies: ['org B usage entry_count (260) exceeds its own attempted writes (240)'],
      },
    })
    const enabled = fixtureArmResult({ arm: 'enabled' })
    const report = buildCombinedReport({
      disabled,
      enabled,
      commitHash: 'deadbeef',
      timestamp: FIXTURE_TIMESTAMP,
    })
    const text = renderConsoleSummary(report)
    expect(text).toContain('ANOMALY')
  })
})
