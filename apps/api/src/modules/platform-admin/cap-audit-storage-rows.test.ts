import { describe, expect, it } from 'vitest'
import { capAuditStorageRowsIncludingCaller } from './service.js'
import type { AuditStorageOrgRow } from './schema.js'

function row(orgId: string, overrides: Partial<AuditStorageOrgRow> = {}): AuditStorageOrgRow {
  return {
    orgId,
    orgName: orgId,
    bytesUsed: 0,
    preauthBytesUsed: 0,
    quotaBytes: null,
    utilizationPct: null,
    refusedWriteCount: 0,
    lastRefusalAt: null,
    lastReconciledAt: null,
    writeRatePerMinute: null,
    rateWindowCount: 0,
    rateRefusedCount: 0,
    state: 'unlimited',
    ...overrides,
  }
}

const ORG_A = 'org-a'
const ORG_B = 'org-b'
const ORG_C = 'org-c'
const ORG_D = 'org-d'
const CALLER_ORG = 'caller-org'

describe('Story 22.3 AC-1: capAuditStorageRowsIncludingCaller', () => {
  it('returns the plain top-N slice when the caller is already within the cap', () => {
    const rows = [row(ORG_A), row(ORG_B), row(ORG_C)]
    expect(capAuditStorageRowsIncludingCaller(rows, 2, ORG_A)).toEqual([row(ORG_A), row(ORG_B)])
  })

  it("swaps the caller's own row in for the lowest-ranked included row when the cap excludes it — the exact CI-scale bug this guards against", () => {
    // 3 high-utilization orgs rank ahead of the caller's own freshly-created (zero-usage) org.
    // A cap of 2 would otherwise silently drop the caller's org from the response entirely.
    const rows = [row('big-1'), row('big-2'), row('big-3'), row(CALLER_ORG)]
    const result = capAuditStorageRowsIncludingCaller(rows, 2, CALLER_ORG)

    expect(result).toHaveLength(2)
    expect(result.map((r) => r.orgId)).toContain(CALLER_ORG)
    // The highest-ranked row is preserved; only the lowest-ranked included slot is sacrificed.
    expect(result[0]?.orgId).toBe('big-1')
    expect(result[1]?.orgId).toBe(CALLER_ORG)
  })

  it('never grows the list beyond the cap when swapping the caller in', () => {
    const rows = [row(ORG_A), row(ORG_B), row(ORG_C), row(ORG_D), row(CALLER_ORG)]
    const result = capAuditStorageRowsIncludingCaller(rows, 3, CALLER_ORG)
    expect(result).toHaveLength(3)
  })

  it('returns the plain capped slice unchanged when callerOrgId is undefined (background-worker caller, no operator context)', () => {
    const rows = [row(ORG_A), row(ORG_B), row(ORG_C)]
    expect(capAuditStorageRowsIncludingCaller(rows, 2, undefined)).toEqual([row(ORG_A), row(ORG_B)])
  })

  it("returns the plain capped slice unchanged when the caller's org somehow isn't in the row set at all", () => {
    const rows = [row(ORG_A), row(ORG_B), row(ORG_C)]
    expect(capAuditStorageRowsIncludingCaller(rows, 2, 'nonexistent-org')).toEqual([
      row(ORG_A),
      row(ORG_B),
    ])
  })

  it('handles a cap of 0 by returning an empty list even when the caller is present', () => {
    const rows = [row(ORG_A), row(CALLER_ORG)]
    expect(capAuditStorageRowsIncludingCaller(rows, 0, CALLER_ORG)).toEqual([])
  })
})
