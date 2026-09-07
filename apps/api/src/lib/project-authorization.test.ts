import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveActiveOrgRole } = vi.hoisted(() => ({
  resolveActiveOrgRole: vi.fn(),
}))
vi.mock('../plugins/authenticate.js', () => ({ resolveActiveOrgRole }))

const { withOrg } = vi.hoisted(() => ({
  withOrg: vi.fn(),
}))
vi.mock('@project-vault/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@project-vault/db')>()
  return { ...actual, withOrg }
})

import {
  checkProjectAuthorization,
  __getProjectAuthorizationInFlightCountForTests,
  __resetProjectAuthorizationRateLimitForTests,
} from './project-authorization.js'
import { runWithRequestContext } from './request-context.js'

const ORG_ID = 'org-1'
const VIEWER_ID = 'user-1'
const PROJECT_ID = 'project-1'
const NOT_A_PROJECT_MEMBER = { outcome: 'denied', reasonCode: 'not-a-project-member' } as const
const RESOLUTION_FAILED = { outcome: 'error', reasonCode: 'resolution-failed' } as const
const AUDIT_EVENT_TYPE = 'project_authorization.check_recorded'

function withAmbientOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ orgId: ORG_ID, userId: VIEWER_ID }, fn)
}

/** Row shape queryProjectInOrgAndMembershipRole()'s single joined query would return. */
function projectNotInOrgRows(): unknown[] {
  return []
}
function projectInOrgNoMembershipRows(): unknown[] {
  return [{ role: null }]
}
function projectInOrgWithRoleRows(role: string): unknown[] {
  return [{ role }]
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetProjectAuthorizationRateLimitForTests()
  withOrg.mockImplementation(async () => [])
})

function call(context: { viewerIdentityId?: string; projectId?: string; minimumRole?: string }) {
  return withAmbientOrg(() =>
    checkProjectAuthorization({
      viewerIdentityId: context.viewerIdentityId ?? VIEWER_ID,
      projectId: context.projectId ?? PROJECT_ID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- some tests deliberately pass an out-of-enum value
      minimumRole: (context.minimumRole ?? 'member') as any,
    })
  )
}

describe('checkProjectAuthorization — AC3: cross-tenant/no-row denial, before any bypass', () => {
  it('projectId not belonging to the ambient org (zero rows) denies with not-a-project-member and never resolves org role', async () => {
    withOrg.mockResolvedValueOnce(projectNotInOrgRows())

    const result = await call({ minimumRole: 'viewer' })

    expect(result).toEqual(NOT_A_PROJECT_MEMBER)
    expect(resolveActiveOrgRole).not.toHaveBeenCalled()
  })

  it('an org owner/admin caller with a cross-org projectId is still denied — the bypass never runs before AC3', async () => {
    withOrg.mockResolvedValueOnce(projectNotInOrgRows())
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await call({ minimumRole: 'owner' })

    expect(result).toEqual(NOT_A_PROJECT_MEMBER)
    expect(resolveActiveOrgRole).not.toHaveBeenCalled()
  })

  it('project found but no explicit membership row and no qualifying org role denies with the identical reasonCode', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue(null)

    const result = await call({ minimumRole: 'viewer' })

    expect(result).toEqual(NOT_A_PROJECT_MEMBER)
  })
})

describe('checkProjectAuthorization — AC2.2: org-owner/admin bypass, reused from effectiveProjectRole()', () => {
  it('org admin with no project_memberships row at all is authorized via the bypass', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue('admin')

    const result = await call({ minimumRole: 'member' })

    expect(result).toEqual({ outcome: 'authorized' })
  })

  it('org owner with no project_memberships row is authorized even for minimumRole: owner', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await call({ minimumRole: 'owner' })

    expect(result).toEqual({ outcome: 'authorized' })
  })

  it('exact-role-boundary: org admin (not owner) requesting minimumRole owner is denied — admin does not implicitly satisfy owner', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue('admin')

    const result = await call({ minimumRole: 'owner' })

    expect(result).toEqual(NOT_A_PROJECT_MEMBER)
  })

  it('the bypass ignores an explicit, lower project_memberships row for an org admin/owner', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgWithRoleRows('viewer'))
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await call({ minimumRole: 'owner' })

    expect(result).toEqual({ outcome: 'authorized' })
  })
})

describe('checkProjectAuthorization — AC2.2/AC2.3: explicit project_memberships row for a member/viewer org role', () => {
  it('an explicit project_memberships row at or above minimumRole is authorized', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgWithRoleRows('admin'))
    resolveActiveOrgRole.mockResolvedValue('member')

    const result = await call({ minimumRole: 'admin' })

    expect(result).toEqual({ outcome: 'authorized' })
  })

  it('an explicit project_memberships row below minimumRole is denied with not-a-project-member', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgWithRoleRows('viewer'))
    resolveActiveOrgRole.mockResolvedValue('member')

    const result = await call({ minimumRole: 'member' })

    expect(result).toEqual(NOT_A_PROJECT_MEMBER)
  })

  it('falls back to the org role when no explicit project row exists and the org role qualifies', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue('member')

    const result = await call({ minimumRole: 'member' })

    expect(result).toEqual({ outcome: 'authorized' })
  })
})

describe('checkProjectAuthorization — AC3.3/genuine internal failure: error, never denied, never throws', () => {
  it('a DB error during the joined query resolves to error/resolution-failed, never denied', async () => {
    withOrg.mockRejectedValueOnce(new Error('connection terminated unexpectedly'))

    const result = await call({ minimumRole: 'viewer' })

    expect(result).toEqual(RESOLUTION_FAILED)
  })

  it('a malformed projectId causing a Postgres UUID cast error resolves to error/resolution-failed', async () => {
    withOrg.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'))

    const result = await call({ projectId: 'not-a-uuid', minimumRole: 'viewer' })

    expect(result).toEqual(RESOLUTION_FAILED)
  })

  it('a failure resolving the org role (after AC3 passes) also maps to error/resolution-failed', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockRejectedValue(new Error('boom'))

    const result = await call({ minimumRole: 'viewer' })

    expect(result).toEqual(RESOLUTION_FAILED)
  })

  it('never throws synchronously', () => {
    withOrg.mockRejectedValueOnce(new Error('boom'))

    expect(() => call({ minimumRole: 'viewer' })).not.toThrow()
  })
})

describe('checkProjectAuthorization — no ambient context bound fails closed', () => {
  it('returns error/no-request-context when called outside any bound request', async () => {
    const result = await checkProjectAuthorization({
      viewerIdentityId: VIEWER_ID,
      projectId: PROJECT_ID,
      minimumRole: 'viewer',
    })

    expect(result).toEqual({ outcome: 'error', reasonCode: 'no-request-context' })
    expect(withOrg).not.toHaveBeenCalled()
    expect(resolveActiveOrgRole).not.toHaveBeenCalled()
  })

  it('still records exactly one audit-log entry for the no-request-context outcome', async () => {
    const info = vi.fn()
    const logger = { info, warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }

    await checkProjectAuthorization(
      { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'viewer' },
      { extensionName: 'ext-no-context', logger }
    )

    const auditCalls = info.mock.calls.filter(([fields]) => fields.eventType === AUDIT_EVENT_TYPE)
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]?.[0]).toMatchObject({
      extensionName: 'ext-no-context',
      projectId: PROJECT_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'viewer',
      outcome: 'error',
    })
    expect(auditCalls[0]?.[0]).not.toHaveProperty('reasonCode')
  })
})

describe('checkProjectAuthorization — invalid minimumRole: error, never queries the DB', () => {
  it('an out-of-enum minimumRole returns error/invalid-minimum-role without querying resolution', async () => {
    const result = await call({ minimumRole: 'super-admin' })

    expect(result).toEqual({ outcome: 'error', reasonCode: 'invalid-minimum-role' })
    expect(withOrg).not.toHaveBeenCalled()
  })
})

describe('checkProjectAuthorization — dedicated rate-limit budget (AC5)', () => {
  it('a call within the configured in-flight cap is not rate-limited', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
        { extensionName: 'ext-a', maxInFlight: 1 }
      )
    )

    expect(result).toEqual({ outcome: 'authorized' })
  })

  it('the slot is released after the call completes', async () => {
    withOrg.mockResolvedValue(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue('owner')
    const hostContext = { extensionName: 'ext-b', maxInFlight: 1 }

    await withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
        hostContext
      )
    )

    expect(__getProjectAuthorizationInFlightCountForTests('ext-b')).toBe(0)
  })

  it('a call over the in-flight cap is denied with a rate-limit error, never invoking resolution', async () => {
    let releaseFirst: (() => void) | undefined
    withOrg.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(projectInOrgNoMembershipRows())
        })
    )
    resolveActiveOrgRole.mockResolvedValue('owner')
    const hostContext = { extensionName: 'ext-c', maxInFlight: 1 }

    const firstPromise = withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
        hostContext
      )
    )
    await Promise.resolve()
    await Promise.resolve()

    const second = await withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
        hostContext
      )
    )

    expect(second).toEqual({ outcome: 'error', reasonCode: 'rate-limited' })
    expect(withOrg).toHaveBeenCalledTimes(1)

    releaseFirst?.()
    await expect(firstPromise).resolves.toEqual({ outcome: 'authorized' })
  })

  it("never shares org-authorization.ts's or capability-gate.ts's own accounting map", async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue('owner')

    const result = await withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
        { extensionName: 'ext-d' }
      )
    )

    expect(result).toEqual({ outcome: 'authorized' })
    expect(__getProjectAuthorizationInFlightCountForTests('ext-d')).toBe(0)
  })
})

describe('checkProjectAuthorization — audit log on every branch, never leaking reasonCode (AC6)', () => {
  function makeLoggerSpy() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
  }

  it('an authorized outcome produces exactly one audit-log entry with no leaked reasonCode', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    resolveActiveOrgRole.mockResolvedValue('owner')
    const logger = makeLoggerSpy()

    await withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
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
      projectId: PROJECT_ID,
      viewerIdentityId: VIEWER_ID,
      minimumRole: 'owner',
      outcome: 'authorized',
    })
    expect(fields).not.toHaveProperty('reasonCode')
  })

  it('a denied outcome (cross-org projectId) produces exactly one audit-log entry with no leaked reasonCode', async () => {
    withOrg.mockResolvedValueOnce(projectNotInOrgRows())
    const logger = makeLoggerSpy()

    await withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
        { extensionName: 'ext-audit-2', logger }
      )
    )

    const auditCalls = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]?.[0].outcome).toBe('denied')
    expect(auditCalls[0]?.[0]).not.toHaveProperty('reasonCode')
  })

  it('an errored outcome (invalid minimumRole) produces exactly one audit-log entry with no leaked reasonCode', async () => {
    const logger = makeLoggerSpy()

    await withAmbientOrg(() =>
      checkProjectAuthorization(
        {
          viewerIdentityId: VIEWER_ID,
          projectId: PROJECT_ID,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately outside the compile-time union
          minimumRole: 'super-admin' as any,
        },
        { extensionName: 'ext-audit-3', logger }
      )
    )

    const auditCalls = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0]?.[0].outcome).toBe('error')
    expect(auditCalls[0]?.[0]).not.toHaveProperty('reasonCode')
  })

  it('a rate-limited call still produces exactly one audit-log entry with no leaked reasonCode', async () => {
    let releaseFirst: (() => void) | undefined
    withOrg.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(projectInOrgNoMembershipRows())
        })
    )
    resolveActiveOrgRole.mockResolvedValue('owner')
    const logger = makeLoggerSpy()
    const hostContext = { extensionName: 'ext-audit-4', logger, maxInFlight: 1 }

    const firstPromise = withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
        hostContext
      )
    )
    await Promise.resolve()
    await Promise.resolve()

    await withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'owner' },
        hostContext
      )
    )

    const auditCallsBeforeRelease = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCallsBeforeRelease).toHaveLength(1)
    expect(auditCallsBeforeRelease[0]?.[0].outcome).toBe('error')
    expect(auditCallsBeforeRelease[0]?.[0]).not.toHaveProperty('reasonCode')

    releaseFirst?.()
    await firstPromise

    const auditCallsAfterRelease = logger.info.mock.calls.filter(
      ([fields]) => fields.eventType === AUDIT_EVENT_TYPE
    )
    expect(auditCallsAfterRelease).toHaveLength(2)
  })

  it('logs exactly the allowlisted fields — never reasonCode even when present internally', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgWithRoleRows('viewer'))
    resolveActiveOrgRole.mockResolvedValue('member')
    const logger = makeLoggerSpy()

    await withAmbientOrg(() =>
      checkProjectAuthorization(
        { viewerIdentityId: VIEWER_ID, projectId: PROJECT_ID, minimumRole: 'admin' },
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
        'projectId',
        'traceId',
        'viewerIdentityId',
      ].sort()
    )
  })
})

describe('checkProjectAuthorization — never caches across calls', () => {
  it('reflects a project_memberships row removal between two consecutive calls', async () => {
    withOrg.mockResolvedValueOnce(projectInOrgWithRoleRows('admin'))
    resolveActiveOrgRole.mockResolvedValue('member')
    const first = await call({ minimumRole: 'admin' })
    expect(first).toEqual({ outcome: 'authorized' })

    withOrg.mockResolvedValueOnce(projectInOrgNoMembershipRows())
    const second = await call({ minimumRole: 'admin' })
    expect(second).toEqual(NOT_A_PROJECT_MEMBER)
  })
})
