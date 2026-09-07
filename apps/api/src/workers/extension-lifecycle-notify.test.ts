import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { extensionLifecycleEvents } from '@project-vault/db/schema'
import { withTestOrg } from '@project-vault/db/test-helpers'
import type {
  ExtensionHooks,
  ExtensionManifest,
  ProjectArchivedContext,
} from '@project-vault/extension-api'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from '../extensions/loader.js'
import { seedWorkerProject, withTwoTestOrgs } from './worker-test-helpers.js'
import {
  EXTENSION_LIFECYCLE_NOTIFY_MAX_ATTEMPTS,
  runExtensionLifecycleEventsPurge,
  runExtensionLifecycleNotify,
} from './extension-lifecycle-notify.js'

const ARCHIVE_NOTIFY_MANIFEST: ExtensionManifest = {
  name: 'com.acme.archive-notify',
  apiVersion: '1.5.0',
  capabilities: ['project-archive-notify'],
}

const ATTEMPT_EVENT_TYPE = 'extension.project_archive_notify_attempt'

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function setExtension(hooks: ExtensionHooks): void {
  __setExtensionStateForTests({
    status: 'loaded',
    manifest: ARCHIVE_NOTIFY_MANIFEST,
    loadedAt: new Date().toISOString(),
    hooks,
  })
}

async function insertPendingEvent(
  orgId: string,
  projectId: string,
  overrides: Partial<{ attemptCount: number; createdAt: Date }> = {}
): Promise<string> {
  const payload: ProjectArchivedContext = {
    organizationId: orgId,
    projectId,
    archivedAt: new Date().toISOString(),
    archivedByUserId: randomUUID(),
  }
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .insert(extensionLifecycleEvents)
      .values({
        orgId,
        projectId,
        eventType: 'project_archived',
        payload,
        status: 'pending',
        attemptCount: overrides.attemptCount ?? 0,
        createdAt: overrides.createdAt,
      })
      .returning({ id: extensionLifecycleEvents.id })
  )
  if (!row) throw new Error('expected extension_lifecycle_events row to be inserted')
  return row.id
}

async function readEvent(orgId: string, id: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(extensionLifecycleEvents).where(eq(extensionLifecycleEvents.id, id))
  )
  return row
}

describe('extension-lifecycle-notify worker', () => {
  afterEach(() => {
    __resetExtensionStateForTests()
  })

  it('marks pending rows delivered immediately when no extension is loaded (Design Decision 4 no-op success)', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'no-extension')
      const id = await insertPendingEvent(orgId, projectId)

      await runExtensionLifecycleNotify(fakeLogger())

      const row = await readEvent(orgId, id)
      expect(row?.status).toBe('delivered')
      expect(row?.deliveredAt).not.toBeNull()
    })
  })

  it('marks pending rows delivered immediately when the loaded extension does not declare project-archive-notify', async () => {
    __setExtensionStateForTests({
      status: 'loaded',
      manifest: {
        name: 'com.acme.other',
        apiVersion: '1.0.0',
        capabilities: ['project-lifecycle'],
      },
      loadedAt: new Date().toISOString(),
      hooks: {},
    })

    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'no-capability')
      const id = await insertPendingEvent(orgId, projectId)

      await runExtensionLifecycleNotify(fakeLogger())

      const row = await readEvent(orgId, id)
      expect(row?.status).toBe('delivered')
    })
  })

  it('AC3 happy path: dispatches a pending row to onProjectArchived and marks it delivered', async () => {
    const onProjectArchived = vi.fn().mockResolvedValue(undefined)
    setExtension({ projectArchiveNotifier: { onProjectArchived } })

    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'happy-path')
      const id = await insertPendingEvent(orgId, projectId)

      await runExtensionLifecycleNotify(fakeLogger())

      expect(onProjectArchived).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: orgId, projectId })
      )
      const row = await readEvent(orgId, id)
      expect(row?.status).toBe('delivered')
      expect(row?.deliveredAt).not.toBeNull()
    })
  })

  it('AC3 per-attempt logging: logs a structured entry for a successful dispatch', async () => {
    const onProjectArchived = vi.fn().mockResolvedValue(undefined)
    setExtension({ projectArchiveNotifier: { onProjectArchived } })
    const logger = fakeLogger()

    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'log-success')
      await insertPendingEvent(orgId, projectId)

      await runExtensionLifecycleNotify(logger)

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: ATTEMPT_EVENT_TYPE,
          outcome: 'delivered',
        }),
        expect.any(String)
      )
    })
  })

  it('AC3 thrown-error edge case: increments attemptCount, records a fixed non-leaking lastError, and stays pending under the cap', async () => {
    const onProjectArchived = vi.fn().mockRejectedValue(new Error('leaked secret detail'))
    setExtension({ projectArchiveNotifier: { onProjectArchived } })
    const logger = fakeLogger()

    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'thrown')
      const id = await insertPendingEvent(orgId, projectId)

      await runExtensionLifecycleNotify(logger)

      const row = await readEvent(orgId, id)
      expect(row?.status).toBe('pending')
      expect(row?.attemptCount).toBe(1)
      expect(row?.lastError).toBe('threw')
      expect(row?.lastError).not.toMatch(/leaked secret/)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: ATTEMPT_EVENT_TYPE,
          outcome: 'threw',
        }),
        expect.any(String)
      )
    })
  })

  it('AC3 attempt-cap exhaustion: transitions to terminal failed status and logs exhaustion once the cap is hit', async () => {
    const onProjectArchived = vi.fn().mockRejectedValue(new Error('boom'))
    setExtension({ projectArchiveNotifier: { onProjectArchived } })
    const logger = fakeLogger()

    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'exhausted')
      const id = await insertPendingEvent(orgId, projectId)

      for (let attempt = 0; attempt < EXTENSION_LIFECYCLE_NOTIFY_MAX_ATTEMPTS; attempt++) {
        await runExtensionLifecycleNotify(logger)
      }

      const row = await readEvent(orgId, id)
      expect(row?.status).toBe('failed')
      expect(row?.attemptCount).toBe(EXTENSION_LIFECYCLE_NOTIFY_MAX_ATTEMPTS)
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'extension.project_archive_notify_exhausted' }),
        expect.any(String)
      )
    })
  })

  it('AC3/AC5 timeout edge case: a hanging hook is treated as a timed_out attempt, retried later, never delivered twice concurrently', async () => {
    const onProjectArchived = vi.fn(() => new Promise<void>(() => undefined))
    setExtension({ projectArchiveNotifier: { onProjectArchived } })
    const logger = fakeLogger()

    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'timeout')
      const id = await insertPendingEvent(orgId, projectId)

      await runExtensionLifecycleNotify(logger)

      const row = await readEvent(orgId, id)
      expect(row?.status).toBe('pending')
      expect(row?.attemptCount).toBe(1)
      expect(row?.lastError).toBe('timed_out')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: ATTEMPT_EVENT_TYPE,
          outcome: 'timed_out',
        }),
        expect.any(String)
      )
    })
  }, 20_000)

  it('AC4: dispatches each org pending row scoped to only its own org/project data, never cross-tenant', async () => {
    const received: ProjectArchivedContext[] = []
    const onProjectArchived = vi.fn(async (ctx: ProjectArchivedContext) => {
      received.push(ctx)
    })
    setExtension({ projectArchiveNotifier: { onProjectArchived } })

    await withTwoTestOrgs(async (orgAId, orgBId) => {
      const projectAId = await seedWorkerProject(orgAId, 'org-a')
      const projectBId = await seedWorkerProject(orgBId, 'org-b')
      await insertPendingEvent(orgAId, projectAId)
      await insertPendingEvent(orgBId, projectBId)

      await runExtensionLifecycleNotify(fakeLogger())

      const forA = received.find((ctx) => ctx.projectId === projectAId)
      const forB = received.find((ctx) => ctx.projectId === projectBId)
      expect(forA).toMatchObject({ organizationId: orgAId, projectId: projectAId })
      expect(forB).toMatchObject({ organizationId: orgBId, projectId: projectBId })
      // Neither payload leaked the other org's data.
      expect(forA?.organizationId).not.toBe(orgBId)
      expect(forB?.organizationId).not.toBe(orgAId)
    })
  })

  it('AC5 no-FIFO edge case: two pending rows for the same project, dispatched in reverse-creation order, do not corrupt state', async () => {
    const received: ProjectArchivedContext[] = []
    const onProjectArchived = vi.fn(async (ctx: ProjectArchivedContext) => {
      received.push(ctx)
    })
    setExtension({ projectArchiveNotifier: { onProjectArchived } })

    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'reorder')
      const older = new Date(Date.now() - 60_000)
      const idOlder = await insertPendingEvent(orgId, projectId, { createdAt: older })
      const idNewer = await insertPendingEvent(orgId, projectId)

      await runExtensionLifecycleNotify(fakeLogger())

      const rowOlder = await readEvent(orgId, idOlder)
      const rowNewer = await readEvent(orgId, idNewer)
      expect(rowOlder?.status).toBe('delivered')
      expect(rowNewer?.status).toBe('delivered')
      expect(received).toHaveLength(2)
    })
  })

  it('claim mechanism: a row locked FOR UPDATE by another transaction is skipped, not double-dispatched', async () => {
    const onProjectArchived = vi.fn().mockResolvedValue(undefined)
    setExtension({ projectArchiveNotifier: { onProjectArchived } })

    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'skip-locked')
      const id = await insertPendingEvent(orgId, projectId)

      let releaseLock: () => void = () => undefined
      const locked = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      const lockHeld = getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`)
        await tx.execute(
          sql`SELECT 1 FROM extension_lifecycle_events WHERE id = ${id}::uuid FOR UPDATE`
        )
        await locked
      })

      // Give the manual lock transaction a moment to actually acquire the row lock before the
      // worker's own claim attempt races it.
      await new Promise((resolve) => setTimeout(resolve, 100))

      await runExtensionLifecycleNotify(fakeLogger())
      expect(onProjectArchived).not.toHaveBeenCalled()
      const rowWhileLocked = await readEvent(orgId, id)
      expect(rowWhileLocked?.status).toBe('pending')

      releaseLock()
      await lockHeld

      await runExtensionLifecycleNotify(fakeLogger())
      expect(onProjectArchived).toHaveBeenCalledTimes(1)
      const rowAfterRelease = await readEvent(orgId, id)
      expect(rowAfterRelease?.status).toBe('delivered')
    })
  })

  it('Task 4 Operational Considerations: purges resolved rows past retention, leaves recent ones alone', async () => {
    await withTestOrg(async ({ orgId }) => {
      const projectId = await seedWorkerProject(orgId, 'purge')
      const oldId = await insertPendingEvent(orgId, projectId, {
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      })
      const recentId = await insertPendingEvent(orgId, projectId)
      await withOrg(orgId, (tx) =>
        tx
          .update(extensionLifecycleEvents)
          .set({ status: 'delivered', deliveredAt: new Date() })
          .where(eq(extensionLifecycleEvents.id, oldId))
      )
      await withOrg(orgId, (tx) =>
        tx
          .update(extensionLifecycleEvents)
          .set({ status: 'delivered', deliveredAt: new Date() })
          .where(eq(extensionLifecycleEvents.id, recentId))
      )

      await runExtensionLifecycleEventsPurge(fakeLogger())

      expect(await readEvent(orgId, oldId)).toBeUndefined()
      expect(await readEvent(orgId, recentId)).toBeDefined()
    })
  })
})
