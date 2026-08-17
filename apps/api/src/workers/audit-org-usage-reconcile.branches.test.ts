import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'

// This is a fully-mocked, branch-focused companion to audit-org-usage-reconcile.test.ts (which
// exercises the happy path against a real Postgres instance). None of the internal helpers
// (evaluateOrgQuotaAlert, checkPreauthVolumeAlert, isOrgUsageStale, checkStaleOrgs,
// handleAggregateFailure, writeBackAllOrgs, logRunCompleted) are exported, so every branch below
// is driven through the single exported `runAuditOrgUsageReconcile` with its collaborators
// (getAdminDb, runOrgScopedJob, fetchAllOrgIds, threshold-alerts, notification dispatch, quota
// resolution, env) mocked — targeting the error-path / edge-condition branches the DB-backed
// happy-path tests don't reach.

type FakeRow = {
  org_id: string
  logical_bytes: string | null
  preauth_logical_bytes: string | null
  entries: string
}

const envMock: Record<string, number> = {
  AUDIT_ORG_USAGE_RECONCILE_TIMEOUT_MS: 300_000,
  AUDIT_ORG_USAGE_STALE_AFTER_HOURS: 240,
  AUDIT_ORG_PREAUTH_ALERT_THRESHOLD_MB: 0,
}

vi.mock('../config/env.js', () => ({
  env: envMock,
}))

const aggregateExecute = vi.fn()
const aggregateTransaction = vi.fn(
  async (fn: (tx: { execute: typeof aggregateExecute }) => unknown) =>
    fn({ execute: aggregateExecute })
)
vi.mock('../lib/db.js', () => ({
  getAdminDb: () => ({ transaction: aggregateTransaction }),
}))

const fetchAllOrgIdsMock = vi.fn(async (): Promise<string[]> => [])
const runOrgScopedJobMock = vi.fn()
vi.mock('../middleware/rls.js', () => ({
  fetchAllOrgIds: (...args: unknown[]) => fetchAllOrgIdsMock(...(args as [])),
  runOrgScopedJob: (...args: unknown[]) =>
    (runOrgScopedJobMock as (...a: unknown[]) => unknown)(...args),
}))

const upsertThresholdAlertMock = vi.fn(async () => ({ id: 'alert-1' }) as { id: string } | null)
const clearThresholdAlertEpisodeMock = vi.fn(async () => undefined)
vi.mock('../lib/threshold-alerts.js', () => ({
  upsertThresholdAlert: (...args: unknown[]) =>
    (upsertThresholdAlertMock as (...a: unknown[]) => unknown)(...args),
  clearThresholdAlertEpisode: (...args: unknown[]) =>
    (clearThresholdAlertEpisodeMock as (...a: unknown[]) => unknown)(...args),
}))

const createOrgAdminNotificationEntriesMock = vi.fn(async () => [{ fakeJob: true }])
const sendNotificationJobsMock = vi.fn(async () => true)
vi.mock('../notifications/dispatcher.js', () => ({
  createOrgAdminNotificationEntries: (...args: unknown[]) =>
    (createOrgAdminNotificationEntriesMock as (...a: unknown[]) => unknown)(...args),
  sendNotificationJobs: (...args: unknown[]) =>
    (sendNotificationJobsMock as (...a: unknown[]) => unknown)(...args),
}))

const resolveEffectiveOrgQuotaBytesMock = vi.fn(async (): Promise<number | null> => null)
vi.mock('../modules/audit/quota-config.js', () => ({
  resolveEffectiveOrgQuotaBytes: (...args: unknown[]) =>
    (resolveEffectiveOrgQuotaBytesMock as (...a: unknown[]) => unknown)(...args),
}))

const { runAuditOrgUsageReconcile } = await import('./audit-org-usage-reconcile.js')

const PREAUTH_VOLUME_ALERT_TYPE = 'audit_preauth_volume.high'
const RECONCILE_FAILING_ALERT_TYPE = 'audit_usage_reconciliation.failing'
const ORG_CRITICAL_ID = 'org-critical'
const ORG_BROKEN_ID = 'org-broken'
const AGGREGATE_FAILURE_MESSAGE = 'statement timeout'

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    org_id: 'org-1',
    logical_bytes: '1000',
    preauth_logical_bytes: '0',
    entries: '1',
    ...overrides,
  }
}

/** Wires runOrgScopedJob so callers can independently control the write-back path, the
 * stale-check path and the alert-notification path per test, keyed by orgId/jobName. */
function configureRunOrgScopedJob(options: {
  currentUsageByOrg?: Record<string, { bytesUsed: number } | undefined>
  writeBackThrowsForOrg?: Set<string>
  staleCheckThrowsForOrg?: Set<string>
  staleRowsByOrg?: Record<string, { lastReconciledAt: Date | null }[]>
}): void {
  const {
    currentUsageByOrg = {},
    writeBackThrowsForOrg = new Set<string>(),
    staleCheckThrowsForOrg = new Set<string>(),
    staleRowsByOrg = {},
  } = options

  runOrgScopedJobMock.mockImplementation(
    async (
      orgId: string,
      jobName: string,
      fn: (ctx: { tx: unknown; orgId: string }) => unknown
    ) => {
      if (jobName === 'audit-org-usage-reconcile') {
        if (writeBackThrowsForOrg.has(orgId)) {
          throw new Error(`write-back failed for ${orgId}`)
        }
        const current = currentUsageByOrg[orgId]
        const tx = {
          select: () => ({
            from: () => ({
              where: async () => (current ? [current] : []),
            }),
          }),
          insert: () => ({
            values: () => ({
              onConflictDoUpdate: async () => undefined,
            }),
          }),
        }
        return fn({ tx, orgId })
      }
      if (jobName === 'audit-org-usage-reconcile/stale-check') {
        if (staleCheckThrowsForOrg.has(orgId)) {
          throw new Error(`stale check failed for ${orgId}`)
        }
        const rows = staleRowsByOrg[orgId] ?? []
        const tx = {
          select: () => ({
            from: () => ({
              where: async () => rows,
            }),
          }),
        }
        return fn({ tx, orgId })
      }
      if (jobName === 'audit-org-usage/reconcile-alert') {
        return fn({ tx: {}, orgId })
      }
      throw new Error(`unexpected jobName in test: ${jobName}`)
    }
  )
}

beforeEach(() => {
  envMock['AUDIT_ORG_USAGE_RECONCILE_TIMEOUT_MS'] = 300_000
  envMock['AUDIT_ORG_USAGE_STALE_AFTER_HOURS'] = 240
  envMock['AUDIT_ORG_PREAUTH_ALERT_THRESHOLD_MB'] = 0

  aggregateExecute.mockReset()
  aggregateTransaction.mockReset()
  aggregateTransaction.mockImplementation(
    async (fn: (tx: { execute: typeof aggregateExecute }) => unknown) =>
      fn({ execute: aggregateExecute })
  )
  aggregateExecute.mockImplementation(async () => [])

  fetchAllOrgIdsMock.mockReset()
  fetchAllOrgIdsMock.mockResolvedValue([])

  runOrgScopedJobMock.mockReset()
  configureRunOrgScopedJob({})

  upsertThresholdAlertMock.mockReset()
  upsertThresholdAlertMock.mockResolvedValue({ id: 'alert-1' })
  clearThresholdAlertEpisodeMock.mockReset()
  clearThresholdAlertEpisodeMock.mockResolvedValue(undefined)

  createOrgAdminNotificationEntriesMock.mockReset()
  createOrgAdminNotificationEntriesMock.mockResolvedValue([{ fakeJob: true }])
  sendNotificationJobsMock.mockReset()
  sendNotificationJobsMock.mockResolvedValue(true)

  resolveEffectiveOrgQuotaBytesMock.mockReset()
  resolveEffectiveOrgQuotaBytesMock.mockResolvedValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Story 22.1 AC-29: checkPreauthVolumeAlert', () => {
  it('clears the instance-wide alert episode when total pre-auth volume stays under the configured threshold', async () => {
    envMock['AUDIT_ORG_PREAUTH_ALERT_THRESHOLD_MB'] = 1 // 1 MiB threshold
    aggregateExecute.mockImplementation(async () => [
      row({ org_id: 'org-a', preauth_logical_bytes: '100' }),
    ])
    configureRunOrgScopedJob({})

    await runAuditOrgUsageReconcile(fakeLogger())

    expect(clearThresholdAlertEpisodeMock).toHaveBeenCalledWith(PREAUTH_VOLUME_ALERT_TYPE, null)
    expect(upsertThresholdAlertMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ alertType: PREAUTH_VOLUME_ALERT_TYPE })
    )
  })

  it('raises the instance-wide alert when total pre-auth volume crosses the configured threshold', async () => {
    envMock['AUDIT_ORG_PREAUTH_ALERT_THRESHOLD_MB'] = 1 // 1 MiB threshold = 1_048_576 bytes
    aggregateExecute.mockImplementation(async () => [
      row({ org_id: 'org-a', preauth_logical_bytes: '2097152' }), // 2 MiB
    ])
    configureRunOrgScopedJob({})

    await runAuditOrgUsageReconcile(fakeLogger())

    expect(upsertThresholdAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        alertType: PREAUTH_VOLUME_ALERT_TYPE,
        scopeKey: null,
        payload: expect.objectContaining({ totalBytes: 2_097_152, thresholdBytes: 1_048_576 }),
      })
    )
  })
})

describe('Story 22.1 AC-17/AC-18: evaluateOrgQuotaAlert critical/notification branch', () => {
  it('fires a critical alert with mayAlreadyBeRefusingWrites and dispatches admin notifications when boss is provided', async () => {
    aggregateExecute.mockImplementation(async () => [
      row({ org_id: ORG_CRITICAL_ID, logical_bytes: '950' }),
    ])
    resolveEffectiveOrgQuotaBytesMock.mockResolvedValue(1000) // 950/1000 = 95% -> critical
    configureRunOrgScopedJob({})
    const boss = { isStarted: () => true } as never

    await runAuditOrgUsageReconcile(fakeLogger(), boss)

    expect(upsertThresholdAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        alertType: 'audit_org_storage.critical',
        thresholdPct: 95,
        severity: 'critical',
        scopeKey: ORG_CRITICAL_ID,
        payload: expect.objectContaining({ mayAlreadyBeRefusingWrites: true }),
      })
    )
    expect(createOrgAdminNotificationEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_CRITICAL_ID,
        template: expect.objectContaining({
          templateId: 'audit_org_storage.critical',
          severity: 'critical',
        }),
      })
    )
    expect(sendNotificationJobsMock).toHaveBeenCalledWith(boss, [{ fakeJob: true }])
  })
})

describe('Story 22.1 AC-7: writeBackOneOrg counter drift log', () => {
  it('logs a warning when the reconciled counter moves by more than the drift tolerance', async () => {
    aggregateExecute.mockImplementation(async () => [
      row({ org_id: 'org-drift', logical_bytes: '5000000' }), // new value
    ])
    configureRunOrgScopedJob({
      currentUsageByOrg: { 'org-drift': { bytesUsed: 0 } }, // 5,000,000 byte drift > 1 MiB tolerance
    })
    const logger = fakeLogger()

    await runAuditOrgUsageReconcile(logger)

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_DRIFT }),
      expect.stringContaining('counter drift exceeded tolerance')
    )
  })

  it('does not log a drift warning when the counter moves within tolerance', async () => {
    aggregateExecute.mockImplementation(async () => [
      row({ org_id: 'org-stable', logical_bytes: '1000100' }),
    ])
    configureRunOrgScopedJob({
      currentUsageByOrg: { 'org-stable': { bytesUsed: 1000000 } }, // 100 byte drift, well under tolerance
    })
    const logger = fakeLogger()

    await runAuditOrgUsageReconcile(logger)

    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('Story 22.1 AC-7: isOrgUsageStale / checkStaleOrgs', () => {
  it('treats a per-org stale-check failure as isolated: logs and continues, does not count as stale', async () => {
    aggregateExecute.mockImplementation(async () => [])
    fetchAllOrgIdsMock.mockResolvedValue([ORG_BROKEN_ID])
    configureRunOrgScopedJob({
      staleCheckThrowsForOrg: new Set([ORG_BROKEN_ID]),
    })
    const logger = fakeLogger()

    await runAuditOrgUsageReconcile(logger)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_ORG_WRITEBACK_FAILED,
        orgId: ORG_BROKEN_ID,
      }),
      expect.stringContaining('stale-check failed')
    )
    // A failed stale-check is treated as "not stale" for this run, so no stale-count alert fires.
    expect(upsertThresholdAlertMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ alertType: RECONCILE_FAILING_ALERT_TYPE })
    )
  })

  it('raises a stale-usage alert when at least one org has never been reconciled', async () => {
    aggregateExecute.mockImplementation(async () => [])
    fetchAllOrgIdsMock.mockResolvedValue(['org-never-reconciled'])
    configureRunOrgScopedJob({
      staleRowsByOrg: { 'org-never-reconciled': [] }, // no row -> lastReconciledAt is null -> stale
    })
    const logger = fakeLogger()

    await runAuditOrgUsageReconcile(logger)

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_FAILED,
        staleCount: 1,
      }),
      expect.stringContaining('stale usage counters found')
    )
    expect(upsertThresholdAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        alertType: RECONCILE_FAILING_ALERT_TYPE,
        scopeKey: null,
        payload: expect.objectContaining({ staleCount: 1 }),
      })
    )
  })
})

describe('Story 22.1 AC-7: handleAggregateFailure', () => {
  it('logs, raises the instance-wide reconciliation-failing alert, and rethrows when the aggregate scan fails', async () => {
    const aggregateError = new Error(AGGREGATE_FAILURE_MESSAGE)
    aggregateTransaction.mockImplementation(async () => {
      throw aggregateError
    })
    const logger = fakeLogger()

    await expect(runAuditOrgUsageReconcile(logger)).rejects.toThrow(AGGREGATE_FAILURE_MESSAGE)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_FAILED,
        err: AGGREGATE_FAILURE_MESSAGE,
      }),
      expect.stringContaining('aggregate failed or timed out')
    )
    expect(upsertThresholdAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        alertType: RECONCILE_FAILING_ALERT_TYPE,
        thresholdPct: 95,
        severity: 'critical',
        scopeKey: null,
      })
    )
    // No write-back or stale-check work happens after a failed aggregate.
    expect(runOrgScopedJobMock).not.toHaveBeenCalled()
  })
})

describe('Story 22.1 AC-7: writeBackAllOrgs per-org isolation', () => {
  it('logs one org write-back failure and still updates the remaining orgs', async () => {
    aggregateExecute.mockImplementation(async () => [
      row({ org_id: 'org-bad' }),
      row({ org_id: 'org-good' }),
    ])
    configureRunOrgScopedJob({
      writeBackThrowsForOrg: new Set(['org-bad']),
    })
    const logger = fakeLogger()

    await runAuditOrgUsageReconcile(logger)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_ORG_WRITEBACK_FAILED,
        orgId: 'org-bad',
      }),
      expect.stringContaining('one org write-back failed')
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_COMPLETED,
        rowsScanned: 2,
        orgsUpdated: 1,
      }),
      expect.stringContaining('run completed')
    )
  })
})

describe('Story 22.1 AC-7: logRunCompleted budget-overrun warning', () => {
  it('warns when the run exceeds 50% of its statement_timeout budget', async () => {
    aggregateExecute.mockImplementation(async () => [])
    envMock['AUDIT_ORG_USAGE_RECONCILE_TIMEOUT_MS'] = 1_000
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(1_005_000)
    const logger = fakeLogger()

    try {
      await runAuditOrgUsageReconcile(logger)
    } finally {
      dateNowSpy.mockRestore()
    }

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.AUDIT_ORG_USAGE_RECONCILE_COMPLETED,
        durationMs: 5_000,
        timeoutMs: 1_000,
      }),
      expect.stringContaining('exceeded 50%')
    )
  })

  it('does not warn when the run completes comfortably inside its statement_timeout budget', async () => {
    aggregateExecute.mockImplementation(async () => [])
    envMock['AUDIT_ORG_USAGE_RECONCILE_TIMEOUT_MS'] = 300_000
    const logger = fakeLogger()

    await runAuditOrgUsageReconcile(logger)

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('exceeded 50%')
    )
  })
})
