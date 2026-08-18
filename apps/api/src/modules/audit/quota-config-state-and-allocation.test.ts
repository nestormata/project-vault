import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Story 22.3 AC-2/AC-4/AC-7/AC-13 — pure-function coverage for resolveOrgAuditState() and
// computeAuditQuotaAllocation(). Deliberately DB-free (unlike quota-config.test.ts's dual-write
// integration coverage) — both functions under test are pure/synchronous, so this file can run
// without a Postgres connection, matching this story's "one test per precedence row" requirement
// (AC-13) without the overhead of a real transaction per case.

const HOUR_MS = 60 * 60 * 1000

describe('Story 22.3 AC-2: resolveOrgAuditState precedence', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.resetModules()
  })

  async function loadResolver() {
    const { resolveOrgAuditState } = await import('./quota-config.js')
    return resolveOrgAuditState
  }

  it('1. stale — lastReconciledAt is null', async () => {
    const resolveOrgAuditState = await loadResolver()
    expect(resolveOrgAuditState({ quotaBytes: 1000, bytesUsed: 10, lastReconciledAt: null })).toBe(
      'stale'
    )
  })

  it('1. stale — lastReconciledAt older than AUDIT_ORG_USAGE_STALE_AFTER_HOURS (default 240h)', async () => {
    const resolveOrgAuditState = await loadResolver()
    const elevenDaysAgo = new Date(Date.now() - 11 * 24 * HOUR_MS)
    expect(
      resolveOrgAuditState({
        quotaBytes: 1_073_741_824,
        bytesUsed: 2_000_000_000, // way over — would be `blocked` if not stale
        lastReconciledAt: elevenDaysAgo,
      })
    ).toBe('stale')
  })

  it('2. unlimited — quotaBytes null and not stale', async () => {
    const resolveOrgAuditState = await loadResolver()
    expect(
      resolveOrgAuditState({
        quotaBytes: null,
        bytesUsed: 500,
        lastReconciledAt: new Date(),
      })
    ).toBe('unlimited')
  })

  it('3. blocked — bytesUsed >= quotaBytes (exactly at quota)', async () => {
    const resolveOrgAuditState = await loadResolver()
    expect(
      resolveOrgAuditState({
        quotaBytes: 1_073_741_824,
        bytesUsed: 1_073_741_824,
        lastReconciledAt: new Date(),
      })
    ).toBe('blocked')
  })

  it('4. critical — bytesUsed >= 0.95 * quotaBytes (exact boundary)', async () => {
    const resolveOrgAuditState = await loadResolver()
    const quotaBytes = 1_073_741_824
    expect(
      resolveOrgAuditState({
        quotaBytes,
        bytesUsed: Math.ceil(0.95 * quotaBytes),
        lastReconciledAt: new Date(),
      })
    ).toBe('critical')
  })

  it('5. warning — bytesUsed >= 0.80 * quotaBytes, exact integer boundary (AC-1 boundary sweep)', async () => {
    const resolveOrgAuditState = await loadResolver()
    // 800000000 / 1000000000 = exactly 80.0% via integer arithmetic — must resolve to warning,
    // not `ok` via a floating-point rounding artifact.
    expect(
      resolveOrgAuditState({
        quotaBytes: 1_000_000_000,
        bytesUsed: 800_000_000,
        lastReconciledAt: new Date(),
      })
    ).toBe('warning')
  })

  it('6. ok — below every threshold', async () => {
    const resolveOrgAuditState = await loadResolver()
    expect(
      resolveOrgAuditState({
        quotaBytes: 1_073_741_824,
        bytesUsed: 100,
        lastReconciledAt: new Date(),
      })
    ).toBe('ok')
  })

  it('stale outranks blocked — a wildly over-quota org with stale reconciliation shows stale, not blocked', async () => {
    const resolveOrgAuditState = await loadResolver()
    const elevenDaysAgo = new Date(Date.now() - 11 * 24 * HOUR_MS)
    expect(
      resolveOrgAuditState({
        quotaBytes: 1_073_741_824,
        bytesUsed: 2_000_000_000,
        lastReconciledAt: elevenDaysAgo,
      })
    ).toBe('stale')
  })

  it("stale outranks unlimited — this story's own design decision (inverts 22.1 AC-25's narrower aside)", async () => {
    const resolveOrgAuditState = await loadResolver()
    expect(resolveOrgAuditState({ quotaBytes: null, bytesUsed: 0, lastReconciledAt: null })).toBe(
      'stale'
    )
  })

  it('defensive: quotaBytes === 0 does not throw (unreachable via schema CHECK, but must not divide by zero)', async () => {
    const resolveOrgAuditState = await loadResolver()
    expect(() =>
      resolveOrgAuditState({ quotaBytes: 0, bytesUsed: 0, lastReconciledAt: new Date() })
    ).not.toThrow()
    expect(
      resolveOrgAuditState({ quotaBytes: 0, bytesUsed: 0, lastReconciledAt: new Date() })
    ).toBe('blocked')
  })

  it('respects a custom AUDIT_ORG_USAGE_STALE_AFTER_HOURS', async () => {
    const previous = process.env['AUDIT_ORG_USAGE_STALE_AFTER_HOURS']
    process.env['AUDIT_ORG_USAGE_STALE_AFTER_HOURS'] = '1'
    vi.resetModules()
    try {
      const { resolveOrgAuditState } = await import('./quota-config.js')
      const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS)
      expect(
        resolveOrgAuditState({ quotaBytes: 1000, bytesUsed: 10, lastReconciledAt: twoHoursAgo })
      ).toBe('stale')
    } finally {
      if (previous === undefined) delete process.env['AUDIT_ORG_USAGE_STALE_AFTER_HOURS']
      else process.env['AUDIT_ORG_USAGE_STALE_AFTER_HOURS'] = previous
      vi.resetModules()
    }
  })
})

describe('Story 22.3 AC-4/AC-7: computeAuditQuotaAllocation', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.resetModules()
  })

  async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const previous: Record<string, string | undefined> = {}
    for (const key of Object.keys(overrides)) {
      previous[key] = process.env[key]
      process.env[key] = overrides[key]
    }
    vi.resetModules()
    try {
      return await fn()
    } finally {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = previous[key]
      }
      vi.resetModules()
    }
  }

  it('under threshold: no acknowledgement needed', async () => {
    await withEnv(
      { AUDIT_LOG_STORAGE_LIMIT_GB: '50', AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE: '3.0' },
      async () => {
        const { computeAuditQuotaAllocation } = await import('./quota-config.js')
        const GiB = 1024 ** 3
        // 3 orgs at 1 GiB each, raising one to 2 GiB -> new sum = 4 GiB logical.
        const result = computeAuditQuotaAllocation({
          currentSumOfFiniteQuotaBytes: 3 * GiB,
          targetOrgCurrentContributionBytes: 1 * GiB,
          requestedBytes: 2 * GiB,
          hasUnlimitedOrgs: false,
        })
        expect(result.allocatedLogicalBytes).toBe(4 * GiB)
        expect(result.estimatedPhysicalBytes).toBe(12 * GiB)
        expect(result.instanceLimitBytes).toBe(50 * GiB)
        expect(result.overThreshold).toBe(false)
        expect(result.allocationIncludesUnlimitedOrgs).toBe(false)
      }
    )
  })

  it('over threshold: overThreshold true, acknowledgement required by the caller', async () => {
    await withEnv(
      { AUDIT_LOG_STORAGE_LIMIT_GB: '50', AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE: '3.0' },
      async () => {
        const { computeAuditQuotaAllocation } = await import('./quota-config.js')
        const GiB = 1024 ** 3
        // Sum already at 35 GiB, raising another org by 1 GiB -> 36 GiB logical -> 108 GiB
        // physical vs 40 GiB threshold (80% of 50 GiB).
        const result = computeAuditQuotaAllocation({
          currentSumOfFiniteQuotaBytes: 35 * GiB,
          targetOrgCurrentContributionBytes: 0,
          requestedBytes: 1 * GiB,
          hasUnlimitedOrgs: false,
        })
        expect(result.allocatedLogicalBytes).toBe(36 * GiB)
        expect(result.overThreshold).toBe(true)
      }
    )
  })

  it('lowering never triggers overThreshold from the calculation itself (caller decides whether to call it at all, but the math is symmetric)', async () => {
    await withEnv(
      { AUDIT_LOG_STORAGE_LIMIT_GB: '1', AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE: '1' },
      async () => {
        const { computeAuditQuotaAllocation } = await import('./quota-config.js')
        const GiB = 1024 ** 3
        const result = computeAuditQuotaAllocation({
          currentSumOfFiniteQuotaBytes: 2 * GiB,
          targetOrgCurrentContributionBytes: 2 * GiB,
          requestedBytes: 1 * GiB,
          hasUnlimitedOrgs: false,
        })
        expect(result.allocatedLogicalBytes).toBe(1 * GiB)
      }
    )
  })

  it('unlimited-org lower-bound flag passes through from the caller-supplied hasUnlimitedOrgs', async () => {
    await withEnv({ AUDIT_LOG_STORAGE_LIMIT_GB: '50' }, async () => {
      const { computeAuditQuotaAllocation } = await import('./quota-config.js')
      const result = computeAuditQuotaAllocation({
        currentSumOfFiniteQuotaBytes: 1024,
        targetOrgCurrentContributionBytes: 0,
        requestedBytes: null,
        hasUnlimitedOrgs: true,
      })
      expect(result.allocationIncludesUnlimitedOrgs).toBe(true)
    })
  })

  it('pure-display call (no requestedBytes) reuses the exact same formula as the enforcement path', async () => {
    await withEnv(
      { AUDIT_LOG_STORAGE_LIMIT_GB: '50', AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE: '3.0' },
      async () => {
        const { computeAuditQuotaAllocation } = await import('./quota-config.js')
        const GiB = 1024 ** 3
        const result = computeAuditQuotaAllocation({
          currentSumOfFiniteQuotaBytes: 4 * GiB,
          targetOrgCurrentContributionBytes: 0,
          requestedBytes: undefined,
          hasUnlimitedOrgs: false,
        })
        expect(result.allocatedLogicalBytes).toBe(4 * GiB)
        expect(result.estimatedPhysicalBytes).toBe(12 * GiB)
      }
    )
  })

  it('a target org already contributing a non-zero amount is not double-counted (check computed WITH the proposed value substituted in, not sum+delta separately)', async () => {
    await withEnv(
      { AUDIT_LOG_STORAGE_LIMIT_GB: '50', AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE: '1' },
      async () => {
        const { computeAuditQuotaAllocation } = await import('./quota-config.js')
        const GiB = 1024 ** 3
        // Target org already contributes 2 GiB to a 10 GiB sum; raising it to 5 GiB should
        // produce a new sum of 13 GiB (10 - 2 + 5), not 15 GiB (10 + 5, double-counting).
        const result = computeAuditQuotaAllocation({
          currentSumOfFiniteQuotaBytes: 10 * GiB,
          targetOrgCurrentContributionBytes: 2 * GiB,
          requestedBytes: 5 * GiB,
          hasUnlimitedOrgs: false,
        })
        expect(result.allocatedLogicalBytes).toBe(13 * GiB)
      }
    )
  })
})
