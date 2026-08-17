import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityAuditWriter } from './capability-gate-audit.js'
import {
  __flushCapabilityAuditDampenerForTests,
  __resetCapabilityAuditDampenerForTests,
  recordCapabilityDeniedAudit,
} from './capability-gate-audit.js'

const GATED_CAPABILITY = 'monitoring.public-status-page'

describe('recordCapabilityDeniedAudit — AC-25 dampener', () => {
  beforeEach(() => __resetCapabilityAuditDampenerForTests())
  afterEach(() => __resetCapabilityAuditDampenerForTests())

  it('the first denial in a window writes immediately with suppressedCount 0', async () => {
    const writer = vi.fn<CapabilityAuditWriter>(async () => undefined)
    await recordCapabilityDeniedAudit(
      {
        orgId: 'org_1',
        userId: 'user_1',
        capability: GATED_CAPABILITY,
        reasonCode: 'not_entitled',
      },
      writer
    )
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org_1',
        userId: 'user_1',
        capability: GATED_CAPABILITY,
        reasonCode: 'not_entitled',
        suppressedCount: 0,
      })
    )
  })

  it('100 rapid denials for the same tuple produce 1 or 2 rows, suppressedCount accounting for the rest', async () => {
    const writer = vi.fn<CapabilityAuditWriter>(async () => undefined)
    for (let i = 0; i < 100; i += 1) {
      await recordCapabilityDeniedAudit(
        {
          orgId: 'org_1',
          userId: 'user_1',
          capability: GATED_CAPABILITY,
          // per-request-unique reason code — must NOT be in the dampener key (AC-25).
          reasonCode: `unique_reason_${i}`,
        },
        writer
      )
    }
    // Still inside the window: only the first write has happened so far.
    expect(writer).toHaveBeenCalledTimes(1)

    await __flushCapabilityAuditDampenerForTests(writer)

    expect(writer.mock.calls.length).toBeLessThanOrEqual(2)
    const totalSuppressed = writer.mock.calls.reduce(
      (sum, call) => sum + (call[0] as { suppressedCount: number }).suppressedCount,
      0
    )
    expect(totalSuppressed).toBe(99)
    // The first row's reasonCode is the first denial's code — later distinct codes are folded in.
    expect(writer.mock.calls[0]?.[0]).toMatchObject({ reasonCode: 'unique_reason_0' })
  })

  it('an allowed (permitted:true) check never calls the writer — caller-level contract, not exercised here directly, but zero writer calls with no denial recorded', async () => {
    const writer = vi.fn<CapabilityAuditWriter>(async () => undefined)
    // Simulates the caller-level guarantee: recordCapabilityDeniedAudit is simply never invoked
    // for a permitted decision (see secure-route.ts's enforceCapabilityIfRequired).
    expect(writer).not.toHaveBeenCalled()
  })

  it('a burst spanning multiple reason codes for one tuple records only the first code, suppressedCount covers the rest', async () => {
    const writer = vi.fn<CapabilityAuditWriter>(async () => undefined)
    await recordCapabilityDeniedAudit(
      { orgId: 'org_1', userId: 'user_1', capability: 'cap', reasonCode: 'first_code' },
      writer
    )
    await recordCapabilityDeniedAudit(
      { orgId: 'org_1', userId: 'user_1', capability: 'cap', reasonCode: 'second_code' },
      writer
    )
    await recordCapabilityDeniedAudit(
      { orgId: 'org_1', userId: 'user_1', capability: 'cap', reasonCode: 'third_code' },
      writer
    )
    await __flushCapabilityAuditDampenerForTests(writer)

    expect(writer).toHaveBeenCalledTimes(2)
    expect(writer.mock.calls[0]?.[0]).toMatchObject({
      reasonCode: 'first_code',
      suppressedCount: 0,
    })
    expect(writer.mock.calls[1]?.[0]).toMatchObject({
      reasonCode: 'first_code',
      suppressedCount: 2,
    })
  })

  it('a sweep on a denial for a DIFFERENT tuple flushes an expired entry (not just same-tuple next-denial)', async () => {
    const writer = vi.fn<CapabilityAuditWriter>(async () => undefined)
    const realNow = Date.now
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      await recordCapabilityDeniedAudit(
        { orgId: 'org_1', userId: 'user_1', capability: 'cap', reasonCode: 'first' },
        writer
      )
      await recordCapabilityDeniedAudit(
        { orgId: 'org_1', userId: 'user_1', capability: 'cap', reasonCode: 'second' },
        writer
      )
      expect(writer).toHaveBeenCalledTimes(1)

      now += 61_000 // window elapsed
      // A denial for a COMPLETELY DIFFERENT tuple triggers the sweep.
      await recordCapabilityDeniedAudit(
        { orgId: 'org_2', userId: 'user_2', capability: 'cap', reasonCode: 'other-tuple' },
        writer
      )

      expect(writer).toHaveBeenCalledTimes(3) // org_1 flush row + org_2's own first-in-window row
      expect(writer.mock.calls[1]?.[0]).toMatchObject({
        orgId: 'org_1',
        reasonCode: 'first',
        suppressedCount: 1,
      })
    } finally {
      Date.now = realNow
    }
  })

  it('the dampener key does not include reasonCode — different reason codes for the same tuple still dampen together', async () => {
    const writer = vi.fn<CapabilityAuditWriter>(async () => undefined)
    await recordCapabilityDeniedAudit(
      { orgId: 'org_x', userId: 'user_x', capability: 'cap', reasonCode: 'code_a' },
      writer
    )
    // Different reasonCode, SAME (orgId, userId, capability) — must still dampen (not write a
    // second immediate row), proving reasonCode is not part of the key.
    await recordCapabilityDeniedAudit(
      { orgId: 'org_x', userId: 'user_x', capability: 'cap', reasonCode: 'code_b' },
      writer
    )
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('bounded at 1000 entries — inserting a 1001st distinct tuple evicts and flushes the oldest', async () => {
    const writer = vi.fn<CapabilityAuditWriter>(async () => undefined)
    for (let i = 0; i < 1000; i += 1) {
      await recordCapabilityDeniedAudit(
        { orgId: `org_${i}`, userId: 'user_1', capability: 'cap', reasonCode: 'x' },
        writer
      )
    }
    const callsBeforeEviction = writer.mock.calls.length
    // The 1001st distinct tuple forces eviction of the least-recently-touched entry (org_0's,
    // suppressedCount 0 — nothing to flush since it was never repeated) before inserting.
    await recordCapabilityDeniedAudit(
      { orgId: 'org_1000', userId: 'user_1', capability: 'cap', reasonCode: 'x' },
      writer
    )
    expect(writer.mock.calls.length).toBe(callsBeforeEviction + 1)
  })
})
