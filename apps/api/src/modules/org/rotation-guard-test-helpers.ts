import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { expect } from 'vitest'
import { withOrg } from '@project-vault/db'
import {
  auditLogEntries,
  credentialVersions,
  orgMemberships,
  rotations,
} from '@project-vault/db/schema'
import type { createApp } from '../../app.js'
import {
  cookieHeader,
  initVaultForTest,
  type CookieJar,
} from '../../__tests__/helpers/auth-test-helpers.js'
import {
  createLogCaptureStream,
  flushCapturedLogger,
  parseCapturedLogLines,
} from '../../__tests__/helpers/capture-logs.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { createLoggerConfig } from '../../lib/logger.js'
import { tryAcquireRotationScopedLock } from '../../lib/rotation-locks.js'
import { PROJECT_ROUTE_TEST_VAULT_SECRET } from '../projects/project-route-test-bootstrap.js'
import {
  createCredentialViaApi,
  type CredentialRouteTestApp,
} from '../credentials/credential-route-test-helpers.js'

/**
 * Story 43-15 — fixtures shared by the deactivation/removal rotation-guard suites. Rotations are
 * created through the real initiation API (a `staged` row with a real new/previous version pair),
 * and only the non-creatable statuses are reached by a direct status UPDATE under `withOrg`.
 */

type RotationStatus = (typeof rotations.$inferSelect)['status']

/** Creates a fresh credential in `projectId` as the initiator, then starts a rotation on it. */
export async function startRotationViaApi(
  app: CredentialRouteTestApp,
  initiatorCookies: CookieJar,
  projectId: string
): Promise<{ credentialId: string; rotationId: string }> {
  const credential = await createCredentialViaApi(app, initiatorCookies, projectId, {
    name: `Rotation guard key ${randomUUID()}`,
    value: `initial-${randomUUID()}`,
  })
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials/${credential.id}/rotations`,
    headers: { cookie: cookieHeader(initiatorCookies) },
    payload: { newValue: `rotated-${randomUUID()}` },
  })
  expect(res.statusCode).toBe(201)
  return { credentialId: credential.id, rotationId: res.json<{ data: { id: string } }>().data.id }
}

export async function updateRotation(
  orgId: string,
  rotationId: string,
  fields: {
    status?: RotationStatus
    initiatedAt?: Date
    initiatedBy?: string | null
    ownerUserId?: string | null
  }
): Promise<void> {
  await withOrg(orgId, (tx) => tx.update(rotations).set(fields).where(eq(rotations.id, rotationId)))
}

export async function rotationStatusOf(orgId: string, rotationId: string): Promise<string> {
  const [row] = await withOrg(orgId, (tx) =>
    tx.select({ status: rotations.status }).from(rotations).where(eq(rotations.id, rotationId))
  )
  return row?.status ?? 'missing'
}

/** The AC-8 side effects `abandonRotation` owns: previous version unlocked, new one abandoned. */
export function rotationVersionState(
  orgId: string,
  rotationId: string
): Promise<{ previousLocked: boolean; newAbandoned: boolean }> {
  return withOrg(orgId, async (tx) => {
    const [rotation] = await tx
      .select({
        newVersionId: rotations.newVersionId,
        previousVersionId: rotations.previousVersionId,
      })
      .from(rotations)
      .where(eq(rotations.id, rotationId))
    if (!rotation) throw new Error(`rotation ${rotationId} not found`)
    const versionRow = async (id: string) => {
      const [row] = await tx
        .select({
          rotationLockedAt: credentialVersions.rotationLockedAt,
          abandonedAt: credentialVersions.abandonedAt,
        })
        .from(credentialVersions)
        .where(eq(credentialVersions.id, id))
      return row
    }
    const previous = await versionRow(rotation.previousVersionId)
    const next = await versionRow(rotation.newVersionId)
    return {
      previousLocked: previous?.rotationLockedAt != null,
      newAbandoned: next?.abandonedAt != null,
    }
  })
}

export async function membershipRow(
  orgId: string,
  userId: string
): Promise<{ status: string; role: string } | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ status: orgMemberships.status, role: orgMemberships.role })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  )
  return row
}

export async function auditPayloads(
  orgId: string,
  eventType: string,
  resourceId: string
): Promise<Record<string, unknown>[]> {
  const rows = await withOrg(orgId, (tx) =>
    tx
      .select({ payload: auditLogEntries.payload })
      .from(auditLogEntries)
      .where(
        and(
          eq(auditLogEntries.orgId, orgId),
          eq(auditLogEntries.eventType, eventType),
          eq(auditLogEntries.resourceId, resourceId)
        )
      )
  )
  return rows.map((row) => row.payload as Record<string, unknown>)
}

/** POST /org/users/:userId/deactivate, optionally with the AC-8 `rotationHandling` body. */
export function deactivateViaApi(
  app: CredentialRouteTestApp,
  cookies: CookieJar,
  userId: string,
  body?: Record<string, unknown>
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/org/users/${userId}/deactivate`,
    headers: { cookie: cookieHeader(cookies) },
    ...(body === undefined ? {} : { payload: body }),
  })
}

/** DELETE /org/users/:userId, optionally with the AC-9 `rotationHandling` body. */
export function removeViaApi(
  app: CredentialRouteTestApp,
  cookies: CookieJar,
  userId: string,
  body?: Record<string, unknown>
) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/org/users/${userId}`,
    headers: { cookie: cookieHeader(cookies) },
    ...(body === undefined ? {} : { payload: body }),
  })
}

/** The (owner_user_id, initiated_by, status) triple Story 43-17's transfer changes or preserves. */
export async function rotationOwnership(
  orgId: string,
  rotationId: string
): Promise<{ ownerUserId: string | null; initiatedBy: string | null; status: string }> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({
        ownerUserId: rotations.ownerUserId,
        initiatedBy: rotations.initiatedBy,
        status: rotations.status,
      })
      .from(rotations)
      .where(eq(rotations.id, rotationId))
  )
  if (!row) throw new Error(`rotation ${rotationId} not found`)
  return row
}

/**
 * Story 43-19: holds `rotationId`'s rotation-scoped advisory lock in another transaction (so the
 * deactivate/remove guard sees it busy) until `release()` resolves.
 */
export async function holdRotationLock(
  orgId: string,
  rotationId: string
): Promise<{ release: () => Promise<void> }> {
  let releaseHeld!: () => void
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  let lockTaken!: () => void
  const locked = new Promise<void>((resolve) => {
    lockTaken = resolve
  })
  const holder = withOrg(orgId, async (tx) => {
    expect(await tryAcquireRotationScopedLock(tx, orgId, rotationId)).toBe(true)
    lockTaken()
    await held
  })
  await locked
  return {
    release: async () => {
      releaseHeld()
      await holder
    },
  }
}

/** Like `bootProjectRouteTestApp`, but the app logs to a capture stream (Story 43-19 log asserts). */
export async function bootLogCaptureRouteTestApp(
  createAppFn: typeof createApp,
  initVault: Parameters<typeof initVaultForTest>[0]
) {
  await resetVaultForTest()
  await initVaultForTest(initVault, PROJECT_ROUTE_TEST_VAULT_SECRET)
  const { stream, lines } = createLogCaptureStream()
  const app = await createAppFn({
    logger: {
      ...createLoggerConfig({ NODE_ENV: 'development', LOG_LEVEL: 'info', SERVICE_NAME: 'api' }),
      stream,
    },
    vaultGuardEnabled: true,
  })
  return { app, lines }
}

/** The warn lines of `eventType` for `targetUserId` captured so far (flushes the logger first). */
export async function deniedLogLines(
  app: { log: unknown },
  lines: string[],
  eventType: string,
  targetUserId: string
): Promise<Array<Record<string, unknown>>> {
  await flushCapturedLogger(app.log)
  return parseCapturedLogLines(lines).filter(
    (line) => line['eventType'] === eventType && line['targetUserId'] === targetUserId
  )
}
