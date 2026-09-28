import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { adminAlerts, auditLogEntries, extensionScheduledTaskRuns } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import { OperationalEvent } from '@project-vault/shared'
import type { ExtensionManifest, ScheduledTaskContext } from '@project-vault/extension-api'
import { register } from 'prom-client'
import { __resetExtensionStateForTests } from '../extensions/loader.js'
import { getAdminDb } from '../lib/db.js'
import { upsertThresholdAlert } from '../lib/threshold-alerts.js'
import { withTwoTestOrgs } from './worker-test-helpers.js'
import { setExtension } from './extension-scheduled-tasks-test-helpers.js'
import { runScheduledTasksTick } from './extension-scheduled-tasks.js'
import {
  MISSED_ALERT_TYPE,
  SCHEDULED_TASK_WATCHDOG_JOB_NAME,
  __resetWatchdogArmedAtForTests,
  evaluatePair,
  readOrgLatestAttempts,
  runScheduledTaskWatchdogTick,
  type ScheduledTaskWatchdogDeps,
} from './extension-scheduled-tasks-watchdog.js'

const API_VERSION = '3.18.0'
const PROBE = 'probe-sweep'
const CERT = 'cert-sweep'
const MINUTE = 60_000
const GAUGE_NAME = 'extension_scheduled_task_missed'
const PAYLOAD_KEYS = [
  'extensionId',
  'taskName',
  'intervalMinutes',
  'windowMinutes',
  'missedTickThreshold',
  'lastAttemptAt',
]

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

type FakeLogger = ReturnType<typeof fakeLogger>

/** Every call of one fake log method whose structured payload carries `eventType`. */
function logsOf(logFn: FakeLogger['error'], eventType: string): Array<Record<string, unknown>> {
  return logFn.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((payload) => payload['eventType'] === eventType)
}

/** Unique per test — the shared dev DB keeps admin_alerts rows across runs and suites. */
function uniqueExtensionId(label: string): string {
  return `com.acme.wd-${label}-${randomUUID().slice(0, 8)}`
}

function manifestWith(name: string, tasks: Array<[string, number]>): ExtensionManifest {
  return {
    name,
    apiVersion: API_VERSION,
    capabilities: ['scheduled-task'],
    scheduledTasks: tasks.map(([taskName, intervalMinutes]) => ({
      name: taskName,
      intervalMinutes,
      handler: 'onScheduledTask',
    })),
  }
}

function loadExtension(
  name: string,
  tasks: Array<[string, number]>,
  handler: (context: ScheduledTaskContext) => Promise<void> = async () => undefined
): void {
  setExtension(manifestWith(name, tasks), { scheduledTask: { onScheduledTask: handler } })
}

async function insertAttempt(
  orgId: string,
  extensionId: string,
  taskName: string,
  times: { lastRunAt?: Date | null; lastAttemptAt?: Date | null }
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(extensionScheduledTaskRuns).values({
      orgId,
      extensionId,
      taskName,
      lastRunAt: times.lastRunAt ?? null,
      lastAttemptAt: times.lastAttemptAt ?? null,
      lastOutcome: 'success',
    })
  )
}

async function alertRows(scopeKey: string) {
  return getDb()
    .select()
    .from(adminAlerts)
    .where(
      and(eq(adminAlerts.alertType, MISSED_ALERT_TYPE), sql`payload->>'scopeKey' = ${scopeKey}`)
    )
}

async function gaugeValue(extensionId: string, taskName: string): Promise<number | undefined> {
  const metric = register.getSingleMetric(GAUGE_NAME)
  if (!metric) return undefined
  const { values } = await metric.get()
  return values.find(
    (value) =>
      value.labels['extension_id'] === extensionId && value.labels['task_name'] === taskName
  )?.value
}

type RunOptions = {
  orgIds: string[]
  logger?: FakeLogger
  deliver?: ScheduledTaskWatchdogDeps['deliverToOperator']
  deps?: Partial<ScheduledTaskWatchdogDeps>
}

async function runAt(now: Date, options: RunOptions): Promise<void> {
  await runScheduledTaskWatchdogTick(options.logger, {
    fetchOrgIds: async () => options.orgIds,
    readDbNow: async () => now,
    missedTickThreshold: 3,
    deliverToOperator: options.deliver ?? vi.fn(async () => undefined),
    ...options.deps,
  })
}

/** Arms the watchdog an hour before `base`, then runs at `base` — with no attempt within the
 * window this makes every declared pair Missed on the second run. */
async function raiseMissed(base: Date, options: RunOptions): Promise<void> {
  await runAt(new Date(base.getTime() - 60 * MINUTE), options)
  await runAt(base, options)
}

beforeEach(() => {
  __resetWatchdogArmedAtForTests()
})

afterEach(() => {
  __resetExtensionStateForTests()
  vi.restoreAllMocks()
})

describe('evaluatePair (Story 56.2 T1 — pure state function)', () => {
  const dbNow = new Date('2026-09-28T12:30:00.000Z')
  const longAgo = new Date('2026-09-28T09:00:00.000Z')
  const base = {
    intervalMinutes: 5,
    armedAt: longAgo,
    dbNow,
    orgCount: 30,
    missedTickThreshold: 3,
  }

  it('attempt-age exactly equal to the window is healthy', () => {
    const latestAttemptAt = new Date(dbNow.getTime() - 15 * MINUTE)
    expect(evaluatePair({ ...base, latestAttemptAt })).toEqual({
      state: 'healthy',
      windowMinutes: 15,
    })
  })

  it('window + 1 ms with the watchdog armed long ago is missed', () => {
    const latestAttemptAt = new Date(dbNow.getTime() - 15 * MINUTE - 1)
    expect(evaluatePair({ ...base, latestAttemptAt }).state).toBe('missed')
  })

  it('no attempt and armed-age within the window is grace (including exactly the window)', () => {
    expect(
      evaluatePair({ ...base, latestAttemptAt: null, armedAt: new Date(dbNow.getTime() - MINUTE) })
        .state
    ).toBe('grace')
    expect(
      evaluatePair({
        ...base,
        latestAttemptAt: null,
        armedAt: new Date(dbNow.getTime() - 15 * MINUTE),
      }).state
    ).toBe('grace')
  })

  it('a stale attempt with armed-age within the window is grace, not missed', () => {
    expect(
      evaluatePair({
        ...base,
        latestAttemptAt: new Date(dbNow.getTime() - 3 * 24 * 60 * MINUTE),
        armedAt: new Date(dbNow.getTime() - 5 * MINUTE),
      }).state
    ).toBe('grace')
  })

  it('no attempt and armed longer than the window is missed', () => {
    expect(evaluatePair({ ...base, latestAttemptAt: null }).state).toBe('missed')
  })

  it('a negative attempt age (attempt completed after the lock tx started) is healthy', () => {
    const latestAttemptAt = new Date(dbNow.getTime() + 2_000)
    expect(evaluatePair({ ...base, latestAttemptAt }).state).toBe('healthy')
  })

  it('floors the window at 10 minutes for a 1-minute interval', () => {
    const result = evaluatePair({ ...base, intervalMinutes: 1, latestAttemptAt: null })
    expect(result.windowMinutes).toBe(10)
    expect(
      evaluatePair({
        ...base,
        intervalMinutes: 1,
        latestAttemptAt: new Date(dbNow.getTime() - 9 * MINUTE),
      }).state
    ).toBe('healthy')
  })

  it('uses N × interval for long intervals (1440 min, N=3 ⇒ 4320)', () => {
    const result = evaluatePair({
      ...base,
      intervalMinutes: 1440,
      latestAttemptAt: new Date(dbNow.getTime() - 2 * 24 * 60 * MINUTE),
    })
    expect(result).toEqual({ state: 'healthy', windowMinutes: 4320 })
  })

  it('zero orgs is healthy (nothing is expected to fire)', () => {
    expect(evaluatePair({ ...base, orgCount: 0, latestAttemptAt: null }).state).toBe('healthy')
  })
})

describe('runScheduledTaskWatchdogTick — raise / dedup / resolve (DB integration)', () => {
  it('T4/T16: a missed pair raises exactly one alert, one error log, one operator delivery and gauge 1, with no org data', async () => {
    const extensionId = uniqueExtensionId('missed')
    const scopeKey = `${extensionId}/${PROBE}`
    loadExtension(extensionId, [[PROBE, 5]])

    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const base = new Date()
      const lastAttemptAt = new Date(base.getTime() - 17 * MINUTE)
      await insertAttempt(orgBId, extensionId, PROBE, { lastRunAt: lastAttemptAt, lastAttemptAt })
      const logger = fakeLogger()
      const deliver = vi.fn(async () => undefined)

      await raiseMissed(base, { orgIds: [orgAId, orgBId], logger, deliver })

      const rows = await alertRows(scopeKey)
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row?.status).toBe('active')
      expect(row?.severity).toBe('warning')
      const payload = row?.payload as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(
        [...PAYLOAD_KEYS, 'thresholdPct', 'scopeKey'].sort()
      )
      expect(payload).toEqual({
        extensionId,
        taskName: PROBE,
        intervalMinutes: 5,
        windowMinutes: 15,
        missedTickThreshold: 3,
        lastAttemptAt: lastAttemptAt.toISOString(),
        thresholdPct: 80,
        scopeKey,
      })

      const missedLogs = logsOf(logger.error, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED)
      expect(missedLogs).toHaveLength(1)
      expect(missedLogs[0]).toMatchObject({
        extensionId,
        taskName: PROBE,
        intervalMinutes: 5,
        windowMinutes: 15,
        lastAttemptAt: lastAttemptAt.toISOString(),
      })
      expect(logger.error.mock.calls.find((call) => call[0] === missedLogs[0])?.[1]).toBe(
        'extension scheduled task missed expected ticks'
      )

      expect(deliver).toHaveBeenCalledTimes(1)
      const delivered = (deliver.mock.calls[0] as unknown[])[0] as Record<string, unknown>
      expect(Object.keys(delivered).sort()).toEqual([...PAYLOAD_KEYS].sort())

      for (const serialized of [JSON.stringify(payload), JSON.stringify(delivered)]) {
        expect(serialized).not.toContain(orgAId)
        expect(serialized).not.toContain(orgBId)
      }

      expect(await gaugeValue(extensionId, PROBE)).toBe(1)
    })
  })

  it('T5: still missed on the next tick ⇒ no new row, no new error log, no new delivery; gauge stays 1', async () => {
    const extensionId = uniqueExtensionId('still-missed')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      const logger = fakeLogger()
      const deliver = vi.fn(async () => undefined)
      await raiseMissed(base, { orgIds: [orgId], logger, deliver })

      await runAt(new Date(base.getTime() + 5 * MINUTE), { orgIds: [orgId], logger, deliver })
      await runAt(new Date(base.getTime() + 10 * MINUTE), { orgIds: [orgId], logger, deliver })

      expect(await alertRows(`${extensionId}/${PROBE}`)).toHaveLength(1)
      expect(logsOf(logger.error, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED)).toHaveLength(1)
      expect(deliver).toHaveBeenCalledTimes(1)
      expect(await gaugeValue(extensionId, PROBE)).toBe(1)
    })
  })

  it('T6: two missed pairs are two independent episodes; resolving one leaves the other active', async () => {
    const extensionId = uniqueExtensionId('two-pairs')
    loadExtension(extensionId, [
      [PROBE, 5],
      [CERT, 5],
    ])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      const deliver = vi.fn(async () => undefined)
      await raiseMissed(base, { orgIds: [orgId], deliver })

      expect(await alertRows(`${extensionId}/${PROBE}`)).toHaveLength(1)
      expect(await alertRows(`${extensionId}/${CERT}`)).toHaveLength(1)
      expect(deliver).toHaveBeenCalledTimes(2)

      const recovered = new Date(base.getTime() + 20 * MINUTE)
      await insertAttempt(orgId, extensionId, PROBE, { lastAttemptAt: recovered })
      await runAt(new Date(base.getTime() + 25 * MINUTE), { orgIds: [orgId], deliver })

      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('acknowledged')
      expect((await alertRows(`${extensionId}/${CERT}`))[0]?.status).toBe('active')
      expect(await gaugeValue(extensionId, PROBE)).toBe(0)
      expect(await gaugeValue(extensionId, CERT)).toBe(1)
      expect(deliver).toHaveBeenCalledTimes(2)
    })
  })

  it('T7: recovery acknowledges the episode with one info log and gauge 0; healthy-with-nothing-active is a no-op', async () => {
    const extensionId = uniqueExtensionId('recovery')
    const scopeKey = `${extensionId}/${PROBE}`
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      const logger = fakeLogger()
      const deliver = vi.fn(async () => undefined)
      await raiseMissed(base, { orgIds: [orgId], logger, deliver })

      await insertAttempt(orgId, extensionId, PROBE, {
        lastAttemptAt: new Date(base.getTime() + 12 * MINUTE),
      })
      await runAt(new Date(base.getTime() + 15 * MINUTE), { orgIds: [orgId], logger, deliver })

      const [row] = await alertRows(scopeKey)
      expect(row?.status).toBe('acknowledged')
      expect(row?.acknowledgedAt).toBeInstanceOf(Date)
      const resolvedLogs = () =>
        logsOf(logger.info, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED_RESOLVED).filter(
          (payload) => payload['extensionId'] === extensionId
        )
      expect(resolvedLogs()).toHaveLength(1)
      expect(resolvedLogs()[0]).toMatchObject({ extensionId, taskName: PROBE })
      expect(await gaugeValue(extensionId, PROBE)).toBe(0)
      expect(deliver).toHaveBeenCalledTimes(1) // no notification on resolve

      await runAt(new Date(base.getTime() + 20 * MINUTE), { orgIds: [orgId], logger, deliver })
      expect(resolvedLogs()).toHaveLength(1)
      const [unchanged] = await alertRows(scopeKey)
      expect(unchanged?.acknowledgedAt?.getTime()).toBe(row?.acknowledgedAt?.getTime())
    })
  })

  it('flapping: missed → resolved → missed again raises a fresh episode with one new delivery', async () => {
    const extensionId = uniqueExtensionId('flap')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      const deliver = vi.fn(async () => undefined)
      await raiseMissed(base, { orgIds: [orgId], deliver })
      await insertAttempt(orgId, extensionId, PROBE, {
        lastAttemptAt: new Date(base.getTime() + 12 * MINUTE),
      })
      await runAt(new Date(base.getTime() + 15 * MINUTE), { orgIds: [orgId], deliver })
      await runAt(new Date(base.getTime() + 50 * MINUTE), { orgIds: [orgId], deliver })

      const rows = await alertRows(`${extensionId}/${PROBE}`)
      expect(rows.map((r) => r.status).sort()).toEqual(['acknowledged', 'active'])
      expect(deliver).toHaveBeenCalledTimes(2)
    })
  })

  it('T8: a task removed from the manifest resolves its episode and removes its gauge series', async () => {
    const extensionId = uniqueExtensionId('removed')
    loadExtension(extensionId, [
      [PROBE, 5],
      [CERT, 5],
    ])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      const logger = fakeLogger()
      await raiseMissed(base, { orgIds: [orgId], logger })
      expect(await gaugeValue(extensionId, CERT)).toBe(1)

      loadExtension(extensionId, [[PROBE, 5]])
      await runAt(new Date(base.getTime() + 5 * MINUTE), { orgIds: [orgId], logger })

      expect((await alertRows(`${extensionId}/${CERT}`))[0]?.status).toBe('acknowledged')
      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('active')
      expect(await gaugeValue(extensionId, CERT)).toBeUndefined()
      expect(
        logsOf(logger.info, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED_RESOLVED).filter(
          (payload) => payload['extensionId'] === extensionId && payload['taskName'] === CERT
        )
      ).toHaveLength(1)
    })
  })

  it('T8: an unloaded extension resolves every one of its active episodes', async () => {
    const extensionId = uniqueExtensionId('unloaded')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      await raiseMissed(base, { orgIds: [orgId] })
      __resetExtensionStateForTests()

      await runAt(new Date(base.getTime() + 5 * MINUTE), { orgIds: [orgId] })

      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('acknowledged')
      expect(await gaugeValue(extensionId, PROBE)).toBeUndefined()
    })
  })

  it('T3: a pre-existing row with last_attempt_at NULL but a recent last_run_at is healthy (COALESCE)', async () => {
    const extensionId = uniqueExtensionId('coalesce')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      await insertAttempt(orgId, extensionId, PROBE, {
        lastRunAt: new Date(base.getTime() - 2 * MINUTE),
        lastAttemptAt: null,
      })
      const deliver = vi.fn(async () => undefined)
      await raiseMissed(base, { orgIds: [orgId], deliver })

      expect(await alertRows(`${extensionId}/${PROBE}`)).toHaveLength(0)
      expect(deliver).not.toHaveBeenCalled()
      expect(await gaugeValue(extensionId, PROBE)).toBe(0)
    })
  })

  it('AC2 step 2: the default DB clock (SELECT now() on the lock tx) drives evaluation — a recent attempt resolves an active episode', async () => {
    const extensionId = uniqueExtensionId('db-clock')
    const scopeKey = `${extensionId}/${PROBE}`
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      await upsertThresholdAlert({
        alertType: MISSED_ALERT_TYPE,
        thresholdPct: 80,
        severity: 'warning',
        scopeKey,
        payload: {},
      })
      await withOrg(orgId, (tx) =>
        tx.insert(extensionScheduledTaskRuns).values({
          orgId,
          extensionId,
          taskName: PROBE,
          lastRunAt: sql`now() - interval '1 minute'`,
          lastAttemptAt: sql`now() - interval '1 minute'`,
          lastOutcome: 'success',
        })
      )
      const logger = fakeLogger()

      // No `readDbNow` override: the production default reads now() on runAdvisoryLockedTick's tx.
      await runScheduledTaskWatchdogTick(logger, {
        fetchOrgIds: async () => [orgId],
        missedTickThreshold: 3,
        deliverToOperator: vi.fn(async () => undefined),
      })

      expect((await alertRows(scopeKey))[0]?.status).toBe('acknowledged')
      expect(
        logsOf(logger.info, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED_RESOLVED)
      ).toHaveLength(1)
      expect(await gaugeValue(extensionId, PROBE)).toBe(0)
    })
  })
})

describe('runScheduledTaskWatchdogTick — Grace (arming) and restarts', () => {
  it('T9: a fresh process with no rows is Grace until a full window has elapsed since arming, then Missed', async () => {
    const extensionId = uniqueExtensionId('grace')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const armed = new Date()
      const deliver = vi.fn(async () => undefined)
      for (const offset of [0, 5, 10, 15]) {
        await runAt(new Date(armed.getTime() + offset * MINUTE), { orgIds: [orgId], deliver })
      }
      expect(await alertRows(`${extensionId}/${PROBE}`)).toHaveLength(0)
      expect(await gaugeValue(extensionId, PROBE)).toBe(0)

      await runAt(new Date(armed.getTime() + 20 * MINUTE), { orgIds: [orgId], deliver })
      expect(await alertRows(`${extensionId}/${PROBE}`)).toHaveLength(1)
      expect(deliver).toHaveBeenCalledTimes(1)
    })
  })

  it('T24: a restart with an active episode never resolves it during Grace, and re-Missed does not re-notify', async () => {
    const extensionId = uniqueExtensionId('restart')
    const scopeKey = `${extensionId}/${PROBE}`
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      await insertAttempt(orgId, extensionId, PROBE, {
        lastAttemptAt: new Date(base.getTime() - 3 * 24 * 60 * MINUTE),
      })
      await raiseMissed(base, { orgIds: [orgId] })
      expect((await alertRows(scopeKey))[0]?.status).toBe('active')

      __resetWatchdogArmedAtForTests() // simulated process restart
      const logger = fakeLogger()
      const deliver = vi.fn(async () => undefined)
      const restartedAt = new Date(base.getTime() + 30 * MINUTE)
      await runAt(restartedAt, { orgIds: [orgId], logger, deliver })
      await runAt(new Date(restartedAt.getTime() + 15 * MINUTE), {
        orgIds: [orgId],
        logger,
        deliver,
      })

      expect((await alertRows(scopeKey)).map((r) => r.status)).toEqual(['active'])
      expect(
        logsOf(logger.info, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED_RESOLVED)
      ).toHaveLength(0)
      expect(await gaugeValue(extensionId, PROBE)).toBe(1)
      expect(deliver).not.toHaveBeenCalled()

      await runAt(new Date(restartedAt.getTime() + 16 * MINUTE), {
        orgIds: [orgId],
        logger,
        deliver,
      })
      expect(await alertRows(scopeKey)).toHaveLength(1)
      expect(deliver).not.toHaveBeenCalled()
      expect(logsOf(logger.error, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED)).toHaveLength(0)
      expect(await gaugeValue(extensionId, PROBE)).toBe(1)
    })
  })

  it('T10: zero orgs ⇒ not missed, and an active episode is resolved', async () => {
    const extensionId = uniqueExtensionId('zero-orgs')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      await raiseMissed(base, { orgIds: [orgId] })

      await runAt(new Date(base.getTime() + 5 * MINUTE), { orgIds: [] })
      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('acknowledged')
      expect(await gaugeValue(extensionId, PROBE)).toBe(0)
    })
  })
})

describe('runScheduledTaskWatchdogTick — inconclusive evaluations (AC5)', () => {
  it('T11: fetchOrgIds throws ⇒ inconclusive log, no alert/resolve/gauge change', async () => {
    const extensionId = uniqueExtensionId('org-list-fails')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      await raiseMissed(base, { orgIds: [orgId] })
      await insertAttempt(orgId, extensionId, PROBE, {
        lastAttemptAt: new Date(base.getTime() + 4 * MINUTE),
      })
      const logger = fakeLogger()
      await runScheduledTaskWatchdogTick(logger, {
        fetchOrgIds: async () => {
          throw new Error('db down')
        },
        readDbNow: async () => new Date(base.getTime() + 5 * MINUTE),
        missedTickThreshold: 3,
      })

      const inconclusive = logsOf(
        logger.warn,
        OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_INCONCLUSIVE
      )
      expect(inconclusive).toHaveLength(1)
      expect(inconclusive[0]).toMatchObject({ reason: 'org_list_failed' })
      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('active')
      expect(await gaugeValue(extensionId, PROBE)).toBe(1)
    })
  })

  it('T12: every per-org read throwing ⇒ inconclusive (no raise, no resolve, no gauge change)', async () => {
    const extensionId = uniqueExtensionId('all-reads-fail')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const base = new Date()
      await raiseMissed(base, { orgIds: [orgAId, orgBId] })
      const logger = fakeLogger()
      const deliver = vi.fn(async () => undefined)
      await runAt(new Date(base.getTime() + 5 * MINUTE), {
        orgIds: [orgAId, orgBId],
        logger,
        deliver,
        deps: {
          readOrgLatestAttempts: async () => {
            throw new Error('permission denied')
          },
        },
      })

      const inconclusive = logsOf(
        logger.warn,
        OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_INCONCLUSIVE
      )
      expect(inconclusive.filter((p) => p['reason'] === 'org_read_failed')).toHaveLength(2)
      expect(inconclusive.filter((p) => p['reason'] === 'all_org_reads_failed')).toEqual([
        expect.objectContaining({ orgCount: 2 }),
      ])
      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('active')
      expect(await gaugeValue(extensionId, PROBE)).toBe(1)
      expect(deliver).not.toHaveBeenCalled()
    })
  })

  it('T12: one failed read + a recent attempt in another org ⇒ Healthy (may resolve)', async () => {
    const extensionId = uniqueExtensionId('partial-healthy')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const base = new Date()
      await raiseMissed(base, { orgIds: [orgAId, orgBId] })
      await insertAttempt(orgBId, extensionId, PROBE, {
        lastAttemptAt: new Date(base.getTime() + 3 * MINUTE),
      })
      await runAt(new Date(base.getTime() + 5 * MINUTE), {
        orgIds: [orgAId, orgBId],
        deps: {
          readOrgLatestAttempts: async (orgId, ext) => {
            if (orgId === orgAId) throw new Error('blip')
            return readOrgLatestAttempts(orgId, ext)
          },
        },
      })

      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('acknowledged')
      expect(await gaugeValue(extensionId, PROBE)).toBe(0)
    })
  })

  it('T12: one failed read + nothing recent elsewhere ⇒ that pair is inconclusive, not Missed', async () => {
    const extensionId = uniqueExtensionId('partial-missed')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const base = new Date()
      const logger = fakeLogger()
      const deliver = vi.fn(async () => undefined)
      await runAt(new Date(base.getTime() - 60 * MINUTE), { orgIds: [orgAId, orgBId] })
      await runAt(base, {
        orgIds: [orgAId, orgBId],
        logger,
        deliver,
        deps: {
          readOrgLatestAttempts: async (orgId, ext) => {
            if (orgId === orgAId) throw new Error('blip')
            return readOrgLatestAttempts(orgId, ext)
          },
        },
      })

      expect(await alertRows(`${extensionId}/${PROBE}`)).toHaveLength(0)
      expect(deliver).not.toHaveBeenCalled()
      const inconclusive = logsOf(
        logger.warn,
        OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_INCONCLUSIVE
      )
      expect(inconclusive).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'org_read_failed', orgId: orgAId }),
          expect.objectContaining({
            reason: 'partial_org_reads_missed_unconfirmed',
            extensionId,
            taskName: PROBE,
            failedOrgCount: 1,
          }),
        ])
      )
    })
  })

  it('T26: listing active episodes throws ⇒ whole tick inconclusive, no alert/resolve/gauge change', async () => {
    const extensionId = uniqueExtensionId('active-read-fails')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      await raiseMissed(base, { orgIds: [orgId] })
      const second = uniqueExtensionId('active-read-fails-2')
      loadExtension(second, [[PROBE, 5]])
      const logger = fakeLogger()
      const deliver = vi.fn(async () => undefined)
      await runAt(new Date(base.getTime() + 60 * MINUTE), {
        orgIds: [orgId],
        logger,
        deliver,
        deps: {
          listActiveScopeKeys: async () => {
            throw new Error('admin_alerts unavailable')
          },
        },
      })

      expect(
        logsOf(logger.warn, OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_INCONCLUSIVE)
      ).toEqual([expect.objectContaining({ reason: 'active_alerts_read_failed' })])
      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('active')
      expect(await alertRows(`${second}/${PROBE}`)).toHaveLength(0)
      expect(await gaugeValue(extensionId, PROBE)).toBe(1)
      expect(deliver).not.toHaveBeenCalled()
    })
  })
})

describe('runScheduledTaskWatchdogTick — per-pair failure isolation', () => {
  it('T13: upsertThresholdAlert throwing for one pair still evaluates the next pair', async () => {
    const extensionId = uniqueExtensionId('upsert-fails')
    loadExtension(extensionId, [
      [PROBE, 5],
      [CERT, 5],
    ])

    await withTestOrg(async ({ orgId }) => {
      const logger = fakeLogger()
      const deliver = vi.fn(async () => undefined)
      await raiseMissed(new Date(), {
        orgIds: [orgId],
        logger,
        deliver,
        deps: {
          upsertAlert: async (input) => {
            if (input.scopeKey === `${extensionId}/${PROBE}`) throw new Error('lock timeout')
            return upsertThresholdAlert(input)
          },
        },
      })

      const failed = logsOf(
        logger.error,
        OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_EVALUATION_FAILED
      )
      expect(failed).toEqual([expect.objectContaining({ extensionId, taskName: PROBE })])
      expect(await alertRows(`${extensionId}/${PROBE}`)).toHaveLength(0)
      expect(await alertRows(`${extensionId}/${CERT}`)).toHaveLength(1)
      expect(deliver).toHaveBeenCalledTimes(1)
    })
  })

  it('T14: operator delivery throwing logs dispatch-failed, keeps the alert row, and the tick resolves', async () => {
    const extensionId = uniqueExtensionId('deliver-fails')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const logger = fakeLogger()
      await expect(
        raiseMissed(new Date(), {
          orgIds: [orgId],
          logger,
          deliver: async () => {
            throw new Error('smtp down')
          },
        })
      ).resolves.toBeUndefined()

      expect(
        logsOf(logger.warn, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED_ALERT_DISPATCH_FAILED)
      ).toEqual([expect.objectContaining({ extensionId, taskName: PROBE })])
      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('active')
      expect(await gaugeValue(extensionId, PROBE)).toBe(1)
    })
  })

  it('skips delivery (but still raises) when neither boss nor a delivery override is available', async () => {
    const extensionId = uniqueExtensionId('no-boss')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      const logger = fakeLogger()
      const deps = {
        fetchOrgIds: async () => [orgId],
        missedTickThreshold: 3,
      }
      await runScheduledTaskWatchdogTick(logger, {
        ...deps,
        readDbNow: async () => new Date(base.getTime() - 60 * MINUTE),
      })
      await runScheduledTaskWatchdogTick(logger, { ...deps, readDbNow: async () => base })

      expect(await alertRows(`${extensionId}/${PROBE}`)).toHaveLength(1)
      expect(logsOf(logger.error, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED)).toHaveLength(1)
      expect(
        logsOf(logger.warn, OperationalEvent.EXTENSION_SCHEDULED_TASK_MISSED_ALERT_DISPATCH_FAILED)
      ).toHaveLength(0)
    })
  })
})

describe('runScheduledTaskWatchdogTick — tenant isolation, audit, concurrency', () => {
  it('T15: the per-org read is RLS-scoped — org A cannot see org B rows', async () => {
    const extensionId = uniqueExtensionId('rls')

    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const attemptAt = new Date(Date.now() - MINUTE)
      await insertAttempt(orgBId, extensionId, PROBE, { lastAttemptAt: attemptAt })

      const fromA = await readOrgLatestAttempts(orgAId, extensionId)
      const fromB = await readOrgLatestAttempts(orgBId, extensionId)

      expect(fromA.size).toBe(0)
      expect(fromB.get(PROBE)?.getTime()).toBe(attemptAt.getTime())
    })
  })

  it('T22: a raising and resolving watchdog writes zero audit rows', async () => {
    const extensionId = uniqueExtensionId('audit')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      const base = new Date()
      await raiseMissed(base, { orgIds: [orgId] })
      await insertAttempt(orgId, extensionId, PROBE, {
        lastAttemptAt: new Date(base.getTime() + 4 * MINUTE),
      })
      await runAt(new Date(base.getTime() + 5 * MINUTE), { orgIds: [orgId] })
      expect((await alertRows(`${extensionId}/${PROBE}`))[0]?.status).toBe('acknowledged')

      const orgAudit = await withOrg(orgId, (tx) =>
        tx
          .select()
          .from(auditLogEntries)
          .where(inArray(auditLogEntries.orgId, [orgId]))
      )
      expect(orgAudit).toHaveLength(0)
      const platformAudit = await getAdminDb().execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM platform_audit_events WHERE payload::text LIKE ${`%${extensionId}%`}`
      )
      expect(platformAudit[0]?.count).toBe(0)
    })
  })

  it('T17: a second watchdog tick while the first holds the lock is skipped with an overlap warning', async () => {
    const extensionId = uniqueExtensionId('overlap')
    loadExtension(extensionId, [[PROBE, 5]])

    await withTestOrg(async ({ orgId }) => {
      let releaseGate: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      let firstEntered: (() => void) | undefined
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve
      })
      const firstLogger = fakeLogger()
      const secondLogger = fakeLogger()
      const secondFetch = vi.fn(async () => [orgId])

      const first = runScheduledTaskWatchdogTick(firstLogger, {
        fetchOrgIds: async () => {
          firstEntered?.()
          await gate
          return [orgId]
        },
        readDbNow: async () => new Date(),
        missedTickThreshold: 3,
      })
      await entered
      await runScheduledTaskWatchdogTick(secondLogger, {
        fetchOrgIds: secondFetch,
        readDbNow: async () => new Date(),
        missedTickThreshold: 3,
      })
      releaseGate?.()
      await first

      expect(
        logsOf(
          secondLogger.warn,
          OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_TICK_SKIPPED_OVERLAP
        )
      ).toHaveLength(1)
      expect(secondFetch).not.toHaveBeenCalled()
    })
  })

  it('T18: the watchdog still evaluates while the scheduled-tasks tick holds its own lock', async () => {
    const extensionId = uniqueExtensionId('separate-lock')

    await withTestOrg(async ({ orgId }) => {
      let releaseGate: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      let handlerEntered: (() => void) | undefined
      const entered = new Promise<void>((resolve) => {
        handlerEntered = resolve
      })
      loadExtension(extensionId, [[PROBE, 5]], async (context) => {
        if (context.organizationId !== orgId) return
        handlerEntered?.()
        await gate
      })

      const tick = runScheduledTasksTick()
      await entered // the tick now holds `extension/scheduled-tasks`'s advisory lock

      const logger = fakeLogger()
      const fetchOrgIds = vi.fn(async () => [orgId])
      const base = new Date()
      await runScheduledTaskWatchdogTick(logger, {
        fetchOrgIds,
        readDbNow: async () => base,
        missedTickThreshold: 3,
      })

      releaseGate?.()
      await tick

      expect(fetchOrgIds).toHaveBeenCalledTimes(1)
      expect(
        logsOf(logger.warn, OperationalEvent.EXTENSION_SCHEDULED_TASK_WATCHDOG_TICK_SKIPPED_OVERLAP)
      ).toHaveLength(0)
      expect(await gaugeValue(extensionId, PROBE)).toBe(0) // evaluated (Grace) while tick was held
    })
  })
})

describe('watchdog job identity', () => {
  it('uses its own queue name', () => {
    expect(SCHEDULED_TASK_WATCHDOG_JOB_NAME).toBe('extension/scheduled-tasks-watchdog')
  })
})
