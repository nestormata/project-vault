import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { extensionScheduledTaskRuns, serviceEndpoints } from '@project-vault/db/schema'
import { insertTestProject, withTestOrg } from '@project-vault/db/test-helpers'
import type { ExtensionManifest, ScheduledTaskContext } from '@project-vault/extension-api'
import { __resetExtensionStateForTests } from '../extensions/loader.js'
import { buildMonitoringHost } from '../lib/monitoring-host.js'
import { withTwoTestOrgs } from './worker-test-helpers.js'
import { withExpiryAlertTestOrg } from './expiry-alert-test-helpers.js'
import { fakeHostServices, setExtension } from './extension-scheduled-tasks-test-helpers.js'
import {
  fetchDueTaskNames,
  invokeOneTask,
  runScheduledTasksTick,
} from './extension-scheduled-tasks.js'

const API_VERSION = '3.18.0'
const PROBE_SWEEP = 'probe-sweep'

function singleTaskManifest(name: string, intervalMinutes = 5): ExtensionManifest {
  return {
    name,
    apiVersion: API_VERSION,
    capabilities: ['scheduled-task'],
    scheduledTasks: [{ name: PROBE_SWEEP, intervalMinutes, handler: 'onScheduledTask' }],
  }
}

async function readRun(orgId: string, extensionId: string, taskName: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select()
      .from(extensionScheduledTaskRuns)
      .where(
        and(
          eq(extensionScheduledTaskRuns.extensionId, extensionId),
          eq(extensionScheduledTaskRuns.taskName, taskName)
        )
      )
  )
  return row
}

async function insertRun(
  orgId: string,
  extensionId: string,
  taskName: string,
  lastRunAt: Date | null
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(extensionScheduledTaskRuns).values({ orgId, extensionId, taskName, lastRunAt })
  )
}

describe('fetchDueTaskNames (Task 3 due-tuple query)', () => {
  afterEach(() => {
    __resetExtensionStateForTests()
  })

  it('treats a never-run (null lastRunAt) tuple as due', async () => {
    await withTestOrg(async ({ orgId }) => {
      const due = await fetchDueTaskNames(orgId, 'ext.never-run', new Map([['task-a', 5]]))
      expect(due).toEqual(['task-a'])
    })
  })

  it('treats a tuple within its interval as not due', async () => {
    await withTestOrg(async ({ orgId }) => {
      await insertRun(orgId, 'ext.recent', 'task-a', new Date())
      const due = await fetchDueTaskNames(orgId, 'ext.recent', new Map([['task-a', 60]]))
      expect(due).toEqual([])
    })
  })

  it('treats a tuple past its interval as due again', async () => {
    await withTestOrg(async ({ orgId }) => {
      const staleRunAt = new Date(Date.now() - 10 * 60_000) // 10 minutes ago
      await insertRun(orgId, 'ext.stale', 'task-a', staleRunAt)
      const due = await fetchDueTaskNames(orgId, 'ext.stale', new Map([['task-a', 5]]))
      expect(due).toEqual(['task-a'])
    })
  })

  it('only returns declared task names for the given extensionId (excludes other extensions/orgs implicitly via RLS)', async () => {
    await withTestOrg(async ({ orgId }) => {
      await insertRun(orgId, 'ext.other', 'task-a', null)
      const due = await fetchDueTaskNames(orgId, 'ext.mine', new Map([['task-a', 5]]))
      expect(due).toEqual(['task-a']) // ext.other's row never matches this join, so still due
    })
  })
})

describe('runScheduledTasksTick — no-op ticks (AC4d migration compatibility)', () => {
  afterEach(() => {
    __resetExtensionStateForTests()
  })

  it('no-ops when no extension is loaded', async () => {
    __resetExtensionStateForTests()
    await expect(runScheduledTasksTick()).resolves.toBeUndefined()
  })

  it('no-ops when the loaded extension does not declare the scheduled-task capability', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    setExtension(
      { name: 'com.acme.no-cap', apiVersion: API_VERSION, capabilities: ['ui-panel'] },
      { scheduledTask: { onScheduledTask: handler } }
    )
    await runScheduledTasksTick()
    expect(handler).not.toHaveBeenCalled()
  })

  it('no-ops for a pre-existing extension with zero declared scheduledTasks (migration compatibility)', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    setExtension(
      { name: 'com.acme.legacy', apiVersion: API_VERSION, capabilities: ['scheduled-task'] },
      { scheduledTask: { onScheduledTask: handler } }
    )
    await runScheduledTasksTick()
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('runScheduledTasksTick — AC1/AC2 invocation + isolation (DB integration)', () => {
  afterEach(() => {
    __resetExtensionStateForTests()
    vi.restoreAllMocks()
  })

  it('invokes the handler once per due (org, task) tuple with the expected context shape (AC1, AC3)', async () => {
    const calls: ScheduledTaskContext[] = []
    const handler = vi.fn(async (context: ScheduledTaskContext) => {
      calls.push(context)
    })
    const manifest = singleTaskManifest('com.acme.single-task')
    setExtension(manifest, { scheduledTask: { onScheduledTask: handler } })

    await withTestOrg(async ({ orgId }) => {
      await runScheduledTasksTick()
      const call = calls.find((c) => c.organizationId === orgId)
      expect(call).toBeDefined()
      expect(call?.taskName).toBe(PROBE_SWEEP)
      expect(Object.keys(call ?? {}).sort()).toEqual(
        ['organizationId', 'taskName', 'hostServices'].sort()
      )

      const run = await readRun(orgId, manifest.name, PROBE_SWEEP)
      expect(run?.lastOutcome).toBe('success')
      expect(run?.lastRunAt).not.toBeNull()
    })
  })

  it('isolates one org throwing from another org succeeding in the same tick (AC2)', async () => {
    const handler = vi.fn(async (context: ScheduledTaskContext) => {
      if (context.taskName !== PROBE_SWEEP) return
    })

    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const throwingHandler = vi.fn(async (context: ScheduledTaskContext) => {
        if (context.organizationId === orgAId) throw new Error('org A handler blew up')
        return handler(context)
      })
      const manifest = singleTaskManifest('com.acme.isolation-test')
      setExtension(manifest, { scheduledTask: { onScheduledTask: throwingHandler } })

      await runScheduledTasksTick()

      // Both orgs' tuples were attempted (proves org A's throw didn't abort org B's own turn).
      const invokedOrgIds = throwingHandler.mock.calls.map(
        (c) => (c[0] as ScheduledTaskContext).organizationId
      )
      expect(invokedOrgIds).toEqual(expect.arrayContaining([orgAId, orgBId]))

      const runA = await readRun(orgAId, manifest.name, PROBE_SWEEP)
      const runB = await readRun(orgBId, manifest.name, PROBE_SWEEP)
      // Org A's failing invocation must NOT record a success (stays due for retry). Story 56.2
      // AC1: it now records a failure attempt row instead — lastRunAt stays null.
      expect(runA?.lastRunAt).toBeNull()
      expect(runA?.lastOutcome).toBe('failure')
      expect(runA?.lastAttemptAt).toBeInstanceOf(Date)
      // The property the old `toBeUndefined()` assertion was really protecting: still due.
      expect(await fetchDueTaskNames(orgAId, manifest.name, new Map([[PROBE_SWEEP, 5]]))).toEqual([
        PROBE_SWEEP,
      ])
      // Org B's succeeding invocation must record success.
      expect(runB?.lastOutcome).toBe('success')
    })
  })

  it('a second concurrent tick invocation is skipped while the first still holds the advisory lock (Task 4)', async () => {
    let resolveGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve
    })
    const calls: ScheduledTaskContext[] = []

    await withTestOrg(async ({ orgId }) => {
      // Every other pre-existing org in this shared dev DB is also due for this brand-new
      // extensionId — its handler must resolve immediately so it never occupies a concurrency
      // slot, isolating the assertion to ONLY our own org's tuple, which is the one held open on
      // `gate` for the whole race.
      const handler = vi.fn(async (context: ScheduledTaskContext) => {
        calls.push(context)
        if (context.organizationId === orgId) await gate
      })
      const manifest = singleTaskManifest('com.acme.overlap-test')
      setExtension(manifest, { scheduledTask: { onScheduledTask: handler } })

      const firstTick = runScheduledTasksTick()
      // Give the first tick a moment to acquire the advisory lock and reach our org's own
      // (blocked-on-gate) invocation before starting the second.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const secondTick = runScheduledTasksTick()
      await new Promise((resolve) => setTimeout(resolve, 50))

      resolveGate?.()
      await Promise.all([firstTick, secondTick])

      // The invariant under test: our own org's tuple was never double-invoked by an overlapping
      // second tick (the advisory lock made the second tick's whole body a no-op while the first
      // was still in flight) — not a global call count across every org in the shared database.
      const callsForOrg = calls.filter((c) => c.organizationId === orgId)
      expect(callsForOrg).toHaveLength(1)
    })
  })

  it('skips (does not error) when the extension is uninstalled between due-tuple selection and invocation (AC1 uninstall-race)', async () => {
    const handler = vi.fn(async () => undefined)
    const manifest = singleTaskManifest('com.acme.uninstall-race')

    await withTestOrg(async ({ orgId }) => {
      // Simulate the real race directly: `collectDueTuples` selected this (org, task) tuple while
      // the extension was loaded (captured here as `expectedExtensionId`/the tuple itself), but by
      // the time `invokeOneTask` runs — its own fresh `getLoadedScheduledTaskExtension()` re-check
      // — the extension has been uninstalled/unloaded process-wide. Calling `invokeOneTask`
      // directly with the extension state flipped in between is the deterministic way to hit this
      // exact window; racing `runScheduledTasksTick()` end-to-end cannot reliably land inside it.
      setExtension(manifest, { scheduledTask: { onScheduledTask: handler } })
      __resetExtensionStateForTests()

      await expect(
        invokeOneTask({ orgId, taskName: PROBE_SWEEP }, manifest.name, undefined)
      ).resolves.toBeUndefined()
      expect(handler).not.toHaveBeenCalled()
      const run = await readRun(orgId, manifest.name, PROBE_SWEEP)
      expect(run).toBeUndefined()
    })
  })

  it('skips (does not error) when a different extension has since loaded in place of the expected one (AC1 uninstall-race, reload variant)', async () => {
    const staleHandler = vi.fn(async () => undefined)
    const staleManifest = singleTaskManifest('com.acme.stale-extension')

    await withTestOrg(async ({ orgId }) => {
      // A reload (not just an uninstall) between due-tuple selection and invocation must also be
      // treated as "no longer eligible" — `invokeOneTask` compares `fresh.extensionId` against the
      // `expectedExtensionId` captured at due-tuple-selection time, not just extension liveness.
      const newHandler = vi.fn(async () => undefined)
      setExtension(singleTaskManifest('com.acme.new-extension'), {
        scheduledTask: { onScheduledTask: newHandler },
      })

      await expect(
        invokeOneTask({ orgId, taskName: PROBE_SWEEP }, staleManifest.name, undefined)
      ).resolves.toBeUndefined()
      expect(staleHandler).not.toHaveBeenCalled()
      expect(newHandler).not.toHaveBeenCalled()
      const run = await readRun(orgId, staleManifest.name, PROBE_SWEEP)
      expect(run).toBeUndefined()
    })
  })
})

describe('runScheduledTasksTick — regression guard: monitoring.applyHealthCheckResult from inside onScheduledTask', () => {
  afterEach(() => {
    __resetExtensionStateForTests()
    vi.restoreAllMocks()
  })

  it('succeeds with no MonitoringNoAmbientContextError when called out-of-request from a scheduled-task invocation', async () => {
    const regressionManifest = singleTaskManifest('com.acme.monitoring-regression')

    await withExpiryAlertTestOrg('sched-regression', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'sched-regression' })
      const [endpoint] = await withOrg(orgId, (tx) =>
        tx
          .insert(serviceEndpoints)
          .values({
            orgId,
            projectId: project.id,
            name: 'Regression endpoint',
            url: 'https://api.example.com/health',
          })
          .returning()
      )
      if (!endpoint) throw new Error('expected service endpoint to be inserted')

      // Other orgs pre-existing in this shared dev DB are also due and will legitimately get a
      // MonitoringResourceNotFoundError (the fixture endpoint belongs only to OUR org) —
      // observedError is scoped per-org so an unrelated org's expected rejection can never mask
      // our own org's real result.
      const observedErrorByOrg = new Map<string, unknown>()
      const handler = vi.fn(async (context: ScheduledTaskContext) => {
        try {
          await context.hostServices.monitoring.applyHealthCheckResult({
            organizationId: context.organizationId,
            serviceEndpoint: { id: endpoint.id, orgId: context.organizationId },
            isHealthy: true,
            statusCode: 200,
            latencyMs: 42,
            failureReason: null,
          })
          observedErrorByOrg.set(context.organizationId, undefined)
        } catch (error) {
          observedErrorByOrg.set(context.organizationId, error)
        }
      })

      const realMonitoring = buildMonitoringHost(regressionManifest)
      setExtension(
        regressionManifest,
        { scheduledTask: { onScheduledTask: handler } },
        fakeHostServices({ monitoring: realMonitoring })
      )

      await runScheduledTasksTick()

      expect(handler).toHaveBeenCalled()
      expect(observedErrorByOrg.has(orgId)).toBe(true)
      expect(observedErrorByOrg.get(orgId)).toBeUndefined()

      const run = await readRun(orgId, regressionManifest.name, PROBE_SWEEP)
      expect(run?.lastOutcome).toBe('success')
    })
  })
})

describe('invokeOneTask — Story 56.2 AC1 attempt bookkeeping (DB integration)', () => {
  afterEach(() => {
    __resetExtensionStateForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function fakeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('records lastAttemptAt alongside lastRunAt on success (happy path)', async () => {
    const manifest = singleTaskManifest('com.acme.attempt-success')
    setExtension(manifest, { scheduledTask: { onScheduledTask: vi.fn(async () => undefined) } })

    await withTestOrg(async ({ orgId }) => {
      await invokeOneTask({ orgId, taskName: PROBE_SWEEP }, manifest.name, undefined)
      const run = await readRun(orgId, manifest.name, PROBE_SWEEP)
      expect(run?.lastOutcome).toBe('success')
      expect(run?.lastRunAt).not.toBeNull()
      expect(run?.lastAttemptAt).toBeInstanceOf(Date)
      expect(run?.lastAttemptAt?.getTime()).toBe(run?.lastRunAt?.getTime())
    })
  })

  it('inserts a failure row (lastRunAt NULL) when a first-ever attempt rejects, and the tuple stays due', async () => {
    const manifest = singleTaskManifest('com.acme.attempt-first-failure')
    setExtension(manifest, {
      scheduledTask: {
        onScheduledTask: vi.fn(async () => {
          throw new Error('upstream 502')
        }),
      },
    })

    await withTestOrg(async ({ orgId }) => {
      await invokeOneTask({ orgId, taskName: PROBE_SWEEP }, manifest.name, undefined)
      const run = await readRun(orgId, manifest.name, PROBE_SWEEP)
      expect(run).toBeDefined()
      expect(run?.lastRunAt).toBeNull()
      expect(run?.lastAttemptAt).toBeInstanceOf(Date)
      expect(run?.lastOutcome).toBe('failure')
      expect(await fetchDueTaskNames(orgId, manifest.name, new Map([[PROBE_SWEEP, 5]]))).toEqual([
        PROBE_SWEEP,
      ])
    })
  })

  it('keeps a previous lastRunAt unchanged when a later attempt times out (retry semantics preserved)', async () => {
    const manifest = singleTaskManifest('com.acme.attempt-timeout')
    setExtension(manifest, {
      scheduledTask: { onScheduledTask: () => new Promise<void>(() => undefined) },
    })

    await withTestOrg(async ({ orgId }) => {
      const previousRunAt = new Date(Date.now() - 10 * 60_000)
      await insertRun(orgId, manifest.name, PROBE_SWEEP, previousRunAt)

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = invokeOneTask({ orgId, taskName: PROBE_SWEEP }, manifest.name, undefined)
      await vi.advanceTimersByTimeAsync(10_000)
      vi.useRealTimers()
      await pending

      const run = await readRun(orgId, manifest.name, PROBE_SWEEP)
      expect(run?.lastRunAt?.getTime()).toBe(previousRunAt.getTime())
      expect(run?.lastOutcome).toBe('failure')
      expect(run?.lastAttemptAt).toBeInstanceOf(Date)
      expect(run?.lastAttemptAt?.getTime()).toBeGreaterThan(previousRunAt.getTime())
      expect(await fetchDueTaskNames(orgId, manifest.name, new Map([[PROBE_SWEEP, 5]]))).toEqual([
        PROBE_SWEEP,
      ])
    })
  })

  it('logs and swallows a failure-bookkeeping write error (never escapes invokeOneTask)', async () => {
    const manifest = singleTaskManifest('com.acme.attempt-write-fails')
    setExtension(manifest, {
      scheduledTask: {
        onScheduledTask: vi.fn(async () => {
          throw new Error('upstream 502')
        }),
      },
    })
    const logger = fakeLogger()
    // A non-existent org id makes the attempt-row upsert fail (org FK / RLS) — a real DB error.
    const missingOrgId = randomUUID()

    await expect(
      invokeOneTask({ orgId: missingOrgId, taskName: PROBE_SWEEP }, manifest.name, logger)
    ).resolves.toBeUndefined()

    const messages = logger.error.mock.calls.map((call) => call[1])
    expect(messages).toContain('failed to persist scheduled-task attempt due-state')
    const persistCall = logger.error.mock.calls.find(
      (call) => call[1] === 'failed to persist scheduled-task attempt due-state'
    )
    expect(persistCall?.[0]).toMatchObject({
      eventType: 'extension_scheduled_task.invoked',
      extensionId: manifest.name,
      taskName: PROBE_SWEEP,
    })
    // The invocation-failure log line itself still happens after the swallowed write error.
    expect(messages).toContain('extension scheduled-task invocation recorded')
  })
})
