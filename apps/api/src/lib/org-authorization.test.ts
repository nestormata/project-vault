import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveActiveOrgRole } = vi.hoisted(() => ({
  resolveActiveOrgRole: vi.fn(),
}))
vi.mock('../plugins/authenticate.js', () => ({ resolveActiveOrgRole }))

import {
  checkOrgAuthorization,
  __getOrgAuthorizationInFlightCountForTests,
  __resetOrgAuthorizationRateLimitForTests,
} from './org-authorization.js'
import { runWithRequestContext } from './request-context.js'

const ORG_ID = 'org-1'
const VIEWER_ID = 'user-1'
const NOT_A_MEMBER = { outcome: 'denied', reasonCode: 'not-a-member' } as const
const AUDIT_EVENT_TYPE = 'org_authorization.check_recorded'

/**
 * Story 23.11: every test in this suite runs `checkOrgAuthorization()` inside an ambient context
 * bound for `ORG_ID` — the org is now always resolved from `request-context.ts`'s ambient store,
 * never from a caller-supplied `organizationId` field (AC3). The dedicated AC4 suite below is the
 * one place that deliberately does NOT bind a context, to prove the fail-closed path.
 */
function withAmbientOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ orgId: ORG_ID, userId: VIEWER_ID }, fn)
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetOrgAuthorizationRateLimitForTests()
})

describe('checkOrgAuthorization — AC3: denied, never error, never throws', () => {
  it('non-existent organization/identity (no membership row) returns denied/not-a-member', async () => {
    resolveActiveOrgRole.mockResolvedValue(null)

    const result = await withAmbientOrg(() =>
      checkOrgAuthorization({
        viewerIdentityId: VIEWER_ID,
        minimumRole: 'viewer',
      })
    )

    expect(result).toEqual(NOT_A_MEMBER)
    expect(resolveActiveOrgRole).toHaveBeenCalledWith(VIEWER_ID, ORG_ID)
  })

  it('a membership row that exists but is not status: active resolves to null upstream and is denied here too', async () => {
    // resolveActiveOrgRole() (Task 1) already filters to status = 'active' and returns null for
    // any non-active row — checkOrgAuthorization must map that the same way as "no row at all".
    resolveActiveOrgRole.mockResolvedValue(null)

    const result = await withAmbientOrg(() =>
      checkOrgAuthorization({
        viewerIdentityId: VIEWER_ID,
        minimumRole: 'owner',
      })
    )

    expect(result).toEqual(NOT_A_MEMBER)
  })

  it('an active member whose role is below minimumRole is denied, not errored', async () => {
    resolveActiveOrgRole.mockResolvedValue('viewer')

    const result = await withAmbientOrg(() =>
      checkOrgAuthorization({
        viewerIdentityId: VIEWER_ID,
        minimumRole: 'admin',
      })
    )

    expect(result.outcome).toBe('denied')
  })
})

describe('checkOrgAuthorization — AC4: genuine internal failure returns error, never throws', () => {
  it('a DB error during resolution resolves to { outcome: "error" }, not a rejected promise', async () => {
    resolveActiveOrgRole.mockRejectedValue(new Error('connection terminated unexpectedly'))

    await expect(
      withAmbientOrg(() =>
        checkOrgAuthorization({
          viewerIdentityId: VIEWER_ID,
          minimumRole: 'viewer',
        })
      )
    ).resolves.toEqual({ outcome: 'error', reasonCode: expect.any(String) })
  })

  it('never throws synchronously either', () => {
    resolveActiveOrgRole.mockRejectedValue(new Error('boom'))

    expect(() =>
      runWithRequestContext({ orgId: ORG_ID, userId: VIEWER_ID }, () =>
        checkOrgAuthorization({
          viewerIdentityId: VIEWER_ID,
          minimumRole: 'viewer',
        })
      )
    ).not.toThrow()
  })
})

describe('checkOrgAuthorization — Story 23.11 AC4: no ambient context bound fails closed', () => {
  it('returns { outcome: "error", reasonCode: "no-request-context" } when called outside any bound request', async () => {
    const result = await checkOrgAuthorization({
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'viewer',
    })

    expect(result).toEqual({ outcome: 'error', reasonCode: 'no-request-context' })
    expect(resolveActiveOrgRole).not.toHaveBeenCalled()
  })

  it('never throws when called with no ambient context', () => {
    expect(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'viewer' })
    ).not.toThrow()
  })

  it('still records exactly one audit-log entry for the no-request-context outcome (never bypasses the audit path)', async () => {
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }

    await checkOrgAuthorization(
      { viewerIdentityId: VIEWER_ID, minimumRole: 'viewer' },
      { extensionName: 'ext-no-context', logger }
    )

    const auditCalls = info.mock.calls.filter(([fields]) => fields.eventType === AUDIT_EVENT_TYPE)
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]?.[0]).toMatchObject({
      extensionName: 'ext-no-context',
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'viewer',
      outcome: 'error',
    })
    expect(auditCalls[0]?.[0]).not.toHaveProperty('reasonCode')
  })

  it('never falls back to any caller-supplied org — the extension-facing context has no organizationId field to supply one', async () => {
    const result = await checkOrgAuthorization({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately outside the compile-time shape, proving there is no field to smuggle an org through
      ...({ organizationId: 'org-attacker-supplied' } as any),
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'viewer',
    })

    expect(result).toEqual({ outcome: 'error', reasonCode: 'no-request-context' })
    expect(resolveActiveOrgRole).not.toHaveBeenCalled()
  })
})

describe('checkOrgAuthorization — AC5: request-scoped, never cached across calls', () => {
  it('reflects a role downgrade between two consecutive calls for the same identity/org', async () => {
    resolveActiveOrgRole.mockResolvedValueOnce('admin')
    const first = await withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'admin' })
    )
    expect(first).toEqual({ outcome: 'authorized' })

    resolveActiveOrgRole.mockResolvedValueOnce('viewer')
    const second = await withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'admin' })
    )
    expect(second.outcome).toBe('denied')
    expect(resolveActiveOrgRole).toHaveBeenCalledTimes(2)
  })

  it('reflects membership removal between two consecutive calls', async () => {
    resolveActiveOrgRole.mockResolvedValueOnce('owner')
    const first = await withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'owner' })
    )
    expect(first).toEqual({ outcome: 'authorized' })

    resolveActiveOrgRole.mockResolvedValueOnce(null)
    const second = await withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'owner' })
    )
    expect(second).toEqual(NOT_A_MEMBER)
  })
})

describe('checkOrgAuthorization — AC7: unrecognized minimumRole returns error, never a silent pass/deny or throw', () => {
  it('an out-of-enum minimumRole value returns error/invalid-minimum-role without querying resolution', async () => {
    const result = await withAmbientOrg(() =>
      checkOrgAuthorization({
        viewerIdentityId: VIEWER_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately outside the compile-time union (AC7)
        minimumRole: 'super-admin' as any,
      })
    )

    expect(result).toEqual({ outcome: 'error', reasonCode: 'invalid-minimum-role' })
    expect(resolveActiveOrgRole).not.toHaveBeenCalled()
  })

  it('does not throw for the out-of-enum value', async () => {
    await expect(
      withAmbientOrg(() =>
        checkOrgAuthorization({
          viewerIdentityId: VIEWER_ID,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately outside the compile-time union (AC7)
          minimumRole: '' as any,
        })
      )
    ).resolves.toEqual({ outcome: 'error', reasonCode: 'invalid-minimum-role' })
  })
})

describe('checkOrgAuthorization — AC8: per-extension rate-limiting (Task 5)', () => {
  it('a call within the configured in-flight cap is not rate-limited', async () => {
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await withAmbientOrg(() =>
      checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'owner' },
        { extensionName: 'ext-a', maxInFlight: 1 }
      )
    )

    expect(result).toEqual({ outcome: 'authorized' })
  })

  it('the slot is released after the call completes, so a second sequential call for the same extension is never blocked', async () => {
    resolveActiveOrgRole.mockResolvedValue('owner')
    const hostContext = { extensionName: 'ext-b', maxInFlight: 1 }

    const { first, second } = await withAmbientOrg(async () => {
      const first = await checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'owner' },
        hostContext
      )
      const second = await checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'owner' },
        hostContext
      )
      return { first, second }
    })

    expect(first).toEqual({ outcome: 'authorized' })
    expect(second).toEqual({ outcome: 'authorized' })
    expect(__getOrgAuthorizationInFlightCountForTests('ext-b')).toBe(0)
  })

  it('a call over the in-flight cap (concurrent calls for the same extension) is denied with a rate-limit error, never invoking resolution', async () => {
    // Never resolves during the test — keeps the slot held so the second, concurrent call finds
    // the accounting key already at its cap of 1.
    let releaseFirst: (() => void) | undefined
    resolveActiveOrgRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve('owner')
        })
    )
    const hostContext = { extensionName: 'ext-c', maxInFlight: 1 }

    const firstPromise = withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'owner' }, hostContext)
    )
    // Let the first call actually acquire its slot before firing the second.
    await Promise.resolve()
    await Promise.resolve()

    const second = await withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'owner' }, hostContext)
    )

    expect(second).toEqual({ outcome: 'error', reasonCode: 'rate-limited' })
    expect(resolveActiveOrgRole).toHaveBeenCalledTimes(1)

    releaseFirst?.()
    await expect(firstPromise).resolves.toEqual({ outcome: 'authorized' })
  })

  it('rate-limit accounting is per-extension — a saturated extension does not block a different extension', async () => {
    let releaseFirst: (() => void) | undefined
    resolveActiveOrgRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve('owner')
        })
    )

    const firstPromise = withAmbientOrg(() =>
      checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'owner' },
        { extensionName: 'ext-d', maxInFlight: 1 }
      )
    )
    await Promise.resolve()
    await Promise.resolve()

    resolveActiveOrgRole.mockResolvedValueOnce('owner')
    const otherExtensionResult = await withAmbientOrg(() =>
      checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'owner' },
        { extensionName: 'ext-e', maxInFlight: 1 }
      )
    )

    expect(otherExtensionResult).toEqual({ outcome: 'authorized' })

    releaseFirst?.()
    await firstPromise
  })

  it("never sharing capability-gate.ts's own accounting map: a call resolves independently of any capability-gate in-flight state", async () => {
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await withAmbientOrg(() =>
      checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'owner' },
        { extensionName: 'ext-f' }
      )
    )

    expect(result).toEqual({ outcome: 'authorized' })
  })
})

describe('checkOrgAuthorization — AC8: structured audit-log entry per call (Task 5)', () => {
  function makeLoggerSpy() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
  }

  it('an authorized outcome produces exactly one audit-log entry with no leaked reasonCode', async () => {
    resolveActiveOrgRole.mockResolvedValue('owner')
    const logger = makeLoggerSpy()

    await withAmbientOrg(() =>
      checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'owner' },
        { extensionName: 'ext-audit-1', logger }
      )
    )

    const auditCalls = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCalls).toHaveLength(1)
    const fields = auditCalls[0]?.[0]
    expect(fields).toMatchObject({
      extensionName: 'ext-audit-1',
      organizationId: ORG_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'owner',
      outcome: 'authorized',
    })
    expect(fields).not.toHaveProperty('reasonCode')
  })

  it('a denied outcome (not-a-member) produces exactly one audit-log entry with no leaked reasonCode', async () => {
    resolveActiveOrgRole.mockResolvedValue(null)
    const logger = makeLoggerSpy()

    await withAmbientOrg(() =>
      checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'owner' },
        { extensionName: 'ext-audit-2', logger }
      )
    )

    const auditCalls = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCalls).toHaveLength(1)
    const fields = auditCalls[0]?.[0]
    expect(fields.outcome).toBe('denied')
    expect(fields).not.toHaveProperty('reasonCode')
  })

  it('an errored outcome (invalid minimumRole) produces exactly one audit-log entry with no leaked reasonCode', async () => {
    const logger = makeLoggerSpy()

    await withAmbientOrg(() =>
      checkOrgAuthorization(
        {
          viewerIdentityId: VIEWER_ID,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately outside the compile-time union (AC7)
          minimumRole: 'super-admin' as any,
        },
        { extensionName: 'ext-audit-3', logger }
      )
    )

    const auditCalls = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCalls).toHaveLength(1)
    const fields = auditCalls[0]?.[0]
    expect(fields.outcome).toBe('error')
    expect(fields).not.toHaveProperty('reasonCode')
  })

  it('a rate-limited call still produces exactly one audit-log entry, with outcome error and no leaked reasonCode', async () => {
    let releaseFirst: (() => void) | undefined
    resolveActiveOrgRole.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve('owner')
        })
    )
    const logger = makeLoggerSpy()
    const hostContext = { extensionName: 'ext-audit-4', logger, maxInFlight: 1 }

    const firstPromise = withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'owner' }, hostContext)
    )
    await Promise.resolve()
    await Promise.resolve()

    await withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'owner' }, hostContext)
    )

    // The first call's own audit entry has not been recorded yet — it is still pending inside
    // resolveOrgAuthorizationOutcome() until releaseFirst() unblocks it below. Only the
    // rate-limited second call's audit entry exists at this point.
    const auditCallsBeforeRelease = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCallsBeforeRelease).toHaveLength(1)
    const rateLimitedFields = auditCallsBeforeRelease[0]?.[0]
    expect(rateLimitedFields.outcome).toBe('error')
    expect(rateLimitedFields).not.toHaveProperty('reasonCode')

    releaseFirst?.()
    await firstPromise

    // Now the first call's own audit entry has also landed — exactly one entry per call, ever.
    const auditCallsAfterRelease = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCallsAfterRelease).toHaveLength(2)
  })

  it('never logs the reasonCode field even when present internally on the resolved outcome', async () => {
    resolveActiveOrgRole.mockResolvedValue('viewer')
    const logger = makeLoggerSpy()

    await withAmbientOrg(() =>
      checkOrgAuthorization(
        { viewerIdentityId: VIEWER_ID, minimumRole: 'admin' },
        { extensionName: 'ext-audit-5', logger }
      )
    )

    const fields = logger.info.mock.calls[0]?.[0]
    expect(fields.outcome).toBe('denied')
    expect(Object.keys(fields).sort()).toEqual(
      [
        'eventType',
        'extensionName',
        'minimumRole',
        'organizationId',
        'outcome',
        'traceId',
        'viewerIdentityId',
      ].sort()
    )
  })
})

describe('checkOrgAuthorization — authorized path', () => {
  it('returns authorized when the resolved role meets minimumRole', async () => {
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'member' })
    )

    expect(result).toEqual({ outcome: 'authorized' })
  })

  it('returns authorized when the resolved role exactly equals minimumRole', async () => {
    resolveActiveOrgRole.mockResolvedValue('member')

    const result = await withAmbientOrg(() =>
      checkOrgAuthorization({ viewerIdentityId: VIEWER_ID, minimumRole: 'member' })
    )

    expect(result).toEqual({ outcome: 'authorized' })
  })
})
