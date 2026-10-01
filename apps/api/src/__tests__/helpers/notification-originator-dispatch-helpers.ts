import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import type { DeliveryProvider, ExtensionManifest } from '@project-vault/extension-api'
import { wireExtensionDeliveryProvider } from '../../lib/delivery-provider.js'
import type { ExtensionState } from '../../extensions/loader.js'
import { runWithRequestContext } from '../../lib/request-context.js'
import { createMockBoss } from './notification-test-helpers.js'

// Story 70.2 — shared fixtures for the originator-host dispatch integration suites.

export const DISPATCH_TEST_MANIFEST: ExtensionManifest = {
  name: 'com.acme.dispatch-fixture',
  apiVersion: '3.25.0',
  capabilities: [],
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A real `BossService` over a mocked pg-boss client, already started (so `isStarted()` is true). */
export async function startedMockBoss() {
  const mock = createMockBoss()
  await mock.boss.start()
  return mock
}

export function bindAndRun<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ orgId, userId: randomUUID() }, fn)
}

export function registerEmailProvider(send: DeliveryProvider['send']): void {
  const state: ExtensionState = {
    status: 'loaded',
    manifest: DISPATCH_TEST_MANIFEST,
    loadedAt: new Date().toISOString(),
    hooks: {
      deliveryProvider: {
        email: { send, verifyWebhookSignature: () => true, parseWebhookEvents: () => [] },
      },
    },
  }
  wireExtensionDeliveryProvider(state)
}

export async function readQueueRow(orgId: string, id: string) {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select().from(notificationQueue).where(eq(notificationQueue.id, id))
  )
  return row
}

/** Pushes `created_at` past the 5-minute catch-up grace (through `withOrg`, RLS-scoped). */
export async function backdateQueueRow(orgId: string, id: string): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.execute(sql`
      UPDATE notification_queue
         SET created_at = now() - interval '10 minutes'
       WHERE id = ${id}::uuid
    `)
  )
}

/** The `notification/deliver` job payloads a mocked `boss.send` received for one queue row. */
export function sentJobsFor(
  send: { mock: { calls: unknown[][] } },
  queueId: string
): Array<Record<string, unknown>> {
  return send.mock.calls
    .filter(([name, data]) => {
      const payload = data as { notificationQueueId?: string }
      return name === 'notification/deliver' && payload.notificationQueueId === queueId
    })
    .map(([, data]) => data as Record<string, unknown>)
}
